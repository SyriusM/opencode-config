import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// TOOL-INPUT-FIX — poprawia typowe błędy wejścia lokalnych modeli ZANIM narzędzie ruszy
// i przerywa pętle identycznych, błędnych wywołań. Źródło: audyt własnych błędów narzędzi
// (najczęstsze: składnia execute i pętle tego samego wywołania).
//
//   execute.code: poprawka TYLKO gdy oryginał się nie parsuje i poprawka się parsuje:
//     - ogon `</code>`, `</parameter>`, `</function>`, `</tool_call>` (wyciek szablonu Qwen3.5)
//     - prefiks `code:` / płot ```js … ```
//     - `\"` poza stringami (podwójnie escapowane cudzysłowy)
//   playwright_browser_click/hover/…: target `button[ref=f4e13]` → `f4e13`
//   playwright_browser_wait_for: time w ms (≥100) → sekundy
//   pętla: to samo wywołanie (narzędzie + wejście) padło już 2× → zamiast wykonania błąd STOP
//
// Hook V2: ctx.tool.hook("execute.before"), zmiana przez `event.input = …` (tak robi wbudowany
// plugin opencode 2.0.24). Nigdy nie rzucamy z hooka. Log: ~/.mempalace/hook_state/tool_input_fix.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "tool_input_fix.log")
const MAX_REPEAT = 2

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function parses(code: string): boolean {
  try {
    // tylko parsowanie, bez wykonania; ciało funkcji async = top-level await i return OK
    new Function(`return (async () => {\n${code}\n})`)
    return true
  } catch {
    return false
  }
}

const TAIL = /\s*(<\/(code|parameter|function|tool_call|invoke|arg_value)>\s*)+$/i

const FENCE = /^\s*```[a-z]*\s*\n([\s\S]*?)\n?```\s*$/i

function fixCode(code: string): { code: string; fixes: string[] } {
  if (typeof code !== "string") return { code, fixes: [] }
  // ```js … ``` parsuje się jako tagged template, więc płot zdejmujemy zawsze
  const fm = code.match(FENCE)
  if (fm && parses(fm[1])) return { code: fm[1], fixes: ["plot-md"] }
  if (parses(code)) return { code, fixes: [] }
  let c = code
  const fixes: string[] = []
  const step = (name: string, f: (s: string) => string) => {
    const n = f(c)
    if (n !== c) {
      c = n
      fixes.push(name)
    }
  }
  step("xml-tail", (s) => s.replace(TAIL, ""))
  step("code-prefix", (s) => s.replace(/^\s*code\s*:\s*/, ""))
  // `;\\n` między instrukcjami przy poprawnych napisach (35B) — zamieniamy tylko po ; { } )
  if (!parses(c)) step("newline-between-statements", (s) => {
    const n = s.replace(/([;{})])\\n/g, "$1\n")
    return parses(n) ? n : s
  })
  // cały kod escapowany o jeden poziom za dużo (`\"`, `\\n`, `\\\\[` w regexach) → zdejmij jeden poziom
  // unescape-poziom: JSON.parse na całym bloku (działa gdy brak regexów z `\`)
  // escape-cudzyslowow: proste \`\"→"\` (fallback gdy unescape-poziom nie dał rezultatu lub zepsuł regexy)
  if (!parses(c)) {
    let u: string | undefined
    try {
      const j = JSON.parse('"' + c.replace(/\n/g, "\\n").replace(/(^|[^\\])"/g, '$1\\"') + '"')
      if (typeof j === "string" && j !== c) u = j
    } catch {}
    if (u !== undefined && !parses(u)) {
      // unescape zwrócił coś innego niż oryginał, ale nie parsuje — spróbuj escape-cudzyslowow jako fallback
      const e = u.replace(/\\"/g, '"')
      if (e !== u && parses(e)) { c = e; fixes.push("unescape-level→escape-quotes") }
    } else if (u !== undefined) { c = u; fixes.push("unescape-level") }
  }
  if (!parses(c)) step("escape-quotes", (s) => s.replace(/\\"/g, '"'))
  if (!parses(c)) return { code, fixes: [] } // nie umiemy — oddajemy oryginał
  return { code: c, fixes }
}

// poprawki nazw w kodzie, niezależnie od parsowania (wynik „Unknown tool”)
// Uwaga: wywołania MCP z wnętrza `execute` są dekodowane schematem PRZED hookiem — nieznane klucze
// (`ref`, `elements`, `selector`) giną, a złe typy (`target:{ref}`) padają. Te poprawki muszą iść
// w tekście kodu. Brakujące klucze (`action`, `oldText`) poprawia fixMcp w hooku.
function fixNames(code: string): { code: string; fixes: string[] } {
  let c = code
  const fixes: string[] = []
  const step = (name: string, re: RegExp, to: string | ((...a: string[]) => string)) => {
    const n = c.replace(re, to as any)
    if (n !== c) {
      c = n
      fixes.push(name)
    }
  }
  // wbudowany webfetch nie istnieje w `execute`; MCP fetch ma te same argumenty (url, max_length, start_index, raw)
  step("webfetch→fetch", /\btools\.webfetch\.webfetch\s*\(/g, "tools.fetch.fetch(")
  step("double-namespace", /\btools\.(filesystem|mempalace|playwright|fetch)\.\1\./g, "tools.$1.")
  // {target|element: {ref: X}} → target: X
  step("target-object", /\b(target|element)\s*:\s*\{\s*ref\s*:\s*([^{}]+?)\s*\}/g, "target: $2")
  // browser_click({ref: X}) / ({selector: X}) → target
  step(
    "ref→target",
    /(\bbrowser_(?:click|type|hover|select_option|drag)\s*\(\s*\{\s*)(ref|selector)(\s*:)/g,
    "$1target$3",
  )
  // `element` to w Playwrighcie opis słowny, nie identyfikator — zamieniamy tylko, gdy wartość wygląda jak ref (e13, f5e43)
  step(
    "element-ref→target",
    /(\bbrowser_(?:click|type|hover|select_option|drag)\s*\(\s*\{\s*)element(\s*:\s*["'](?:f\d+)?e\d+["'])/g,
    "$1target$2",
  )
  step("elements→fields", /(\bbrowser_fill_form\s*\(\s*\{\s*)elements(\s*:)/g, "$1fields$2")
  // w polach fill_form: ref → target, type "input"/"text" → "textbox"
  step("fill_form-fields", /\bbrowser_fill_form\s*\(\s*\{[\s\S]*?\]\s*\}\s*\)/g, (m: string) =>
    m
      .replace(/([{,]\s*)ref(\s*:)/g, "$1target$2")
      .replace(/\btype\s*:\s*(['"])(input|text|textarea|search|email)\1/g, 'type: "textbox"'),
  )
  return { code: c, fixes }
}

const REF = /\[ref=([a-z0-9]+)\]|^ref=([a-z0-9]+)$/i

// ref ze snapshotu w dowolnym przebraniu → goły string `f4e13`
function asRef(v: unknown): string | undefined {
  if (v && typeof v === "object" && typeof (v as any).ref === "string") v = (v as any).ref
  if (typeof v !== "string") return undefined
  const m = v.match(REF)
  return m ? m[1] ?? m[2] : v
}

// narzędzia przeglądarki: nasz playwright_browser_* i wbudowany browser_browser_* (ten sam schemat)
const BROWSER = /^(playwright|browser)_browser_/
const TARGET_TOOLS = /_(click|type|hover|select_option|press_key|drag)$/
const FIELD_TYPES = ["textbox", "checkbox", "radio", "combobox", "slider"]

function fixMcp(tool: string, input: any): string[] {
  const fixes: string[] = []
  if (!input || typeof input !== "object") return fixes
  if (BROWSER.test(tool)) {
    // zablokuj browser_navigate z protokołami, których Playwright nie obsługuje → ERR_ABORTED
    if (/_navigate$/.test(tool) && typeof input.url === "string") {
      if (/^(steam|file|data|chrome|about):\/\//i.test(input.url)) {
        input._block = true
        fixes.push("navigate-protocol-block")
      }
    }
    // browser_type bez targetu/ref/element/selector — model podaje tylko tekst, nie da się naprawić
    if (/_type$/.test(tool) && input.target === undefined && typeof input.text === "string" && !input.ref && !input.element && !input.selector) {
      input._block = true
      fixes.push("type-without-target")
    }
    if (TARGET_TOOLS.test(tool)) {
      if (input.target === undefined) {
        const alt = input.ref ?? input.element ?? input.selector
        if (alt !== undefined && asRef(alt)) {
          input.target = asRef(alt)
          if (input.ref !== undefined) delete input.ref
          if (input.selector !== undefined) delete input.selector
          if (typeof input.element !== "string") delete input.element
          fixes.push("target-from-ref/element")
        }
      } else {
        // "ref=f19e2" → "f19e2" (model podaje ref= jako prefiks wartości target)
        const refMatch = input.target.match(/^ref=([a-z0-9]+)$/i)
        if (refMatch && refMatch[1] !== input.target) {
          input.target = refMatch[1]
          fixes.push("target-ref-prefix")
        } else {
          // "button[ref=f4e13]" → "f4e13" (model dodaje typ elementu przed [ref=...])
          const cssRef = input.target.match(/\[ref=([a-z0-9]+)\]/i)
          if (cssRef && cssRef[1] !== input.target) {
            input.target = cssRef[1]
            fixes.push("target-css-ref")
          } else {
            const r = asRef(input.target)
            if (r && r !== input.target) {
              input.target = r
              fixes.push("target-ref")
            }
          }
        }
      }
    }
    if (/_fill_form$/.test(tool)) {
      if (!input.fields && Array.isArray(input.elements)) {
        input.fields = input.elements
        delete input.elements
        fixes.push("elements→fields")
      }
      if (Array.isArray(input.fields)) {
        input.fields = input.fields.map((f: any) => {
          if (!f || typeof f !== "object") return f
          const g = { ...f }
          const t = asRef(g.target ?? g.ref ?? g.element)
          if (t && g.target !== t) {
            g.target = t
            delete g.ref
            if (typeof g.element !== "string") delete g.element
            fixes.push("field-target")
          }
          if (!FIELD_TYPES.includes(g.type)) {
            g.type = typeof g.value === "boolean" ? "checkbox" : "textbox"
            fixes.push("field-type")
          }
          if (typeof g.name !== "string" || !g.name) {
            g.name = String(g.element ?? g.label ?? g.target ?? "pole")
            fixes.push("field-name")
          }
          return g
        })
      }
    }
    if (/_tabs$/.test(tool) && input.action === undefined) {
      input.action = "list"
      fixes.push("tabs-action-list")
    }
    if (/_evaluate$/.test(tool) && input.function === undefined) {
      const src = input.expression ?? input.script ?? input.code ?? input.fn
      if (typeof src === "string") {
        input.function = /^\s*(\(|async\b|function\b)/.test(src) ? src : `() => (${src})`
        delete input.expression, delete input.script, delete input.code, delete input.fn
        fixes.push("evaluate-function")
      }
    }
    if (/_wait_for$/.test(tool) && typeof input.time === "number" && input.time >= 100) {
      input.time = Math.round(input.time / 1000)
      fixes.push("time-ms→s")
    }
  }
  // MCP filesystem nie rozwija `~` → „ENOENT … /home/user/<cwd>/~/…”
  if (tool.startsWith("filesystem_")) {
    const home = (v: unknown) => (typeof v === "string" && /^~(\/|$)/.test(v) ? HOME + v.slice(1) : v)
    for (const k of ["path", "source", "destination"]) {
      const n = home(input[k])
      if (n !== input[k]) {
        input[k] = n
        fixes.push(`~→HOME(${k})`)
      }
    }
    if (Array.isArray(input.paths)) {
      const n = input.paths.map(home)
      if (n.some((v: unknown, i: number) => v !== input.paths[i])) {
        input.paths = n
        fixes.push("~→HOME(paths)")
      }
    }
  }
  if (tool === "filesystem_edit_file" && Array.isArray(input.edits)) {
    input.edits = input.edits.map((e: any) => {
      if (!e || typeof e !== "object") return e
      const g = { ...e }
      for (const [from, to] of [
        ["old_string", "oldText"], ["oldString", "oldText"], ["old", "oldText"], ["search", "oldText"],
        ["new_string", "newText"], ["newString", "newText"], ["new", "newText"], ["replace", "newText"],
      ]) {
        if (g[to] === undefined && g[from] !== undefined) {
          g[to] = g[from]
          delete g[from]
          fixes.push(`${from}→${to}`)
        }
      }
      return g
    })
  }
  return fixes
}

// ── WSKAZÓWKI W CHWILI BŁĘDU ──────────────────────────────────────────────────────────────────────
// Błędy semantyczne: składnia poprawna, ale model używa czegoś, czego w tym środowisku nie ma (Node w `execute`,
// sudo, apt, zapis do /etc…). Zamiast pozwolić na niejasny błąd, nie wykonujemy wywołania i zwracamy JEDNO zdanie
// z gotowym poprawnym przykładem (małe modele powtarzają to, co widzą — dlatego przykład, nie sam zakaz).
// Każda wskazówka najwyżej 2× na sesję; potem wywołanie idzie normalnie. Wzorce z bazy błędów opencode (10-2026).
type Wskazowka = { nazwa: string; re: RegExp; tekst: string }

// usuwa napisy i komentarze, żeby np. `document.title` wewnątrz browser_evaluate nie było fałszywym trafieniem
function bezNapisow(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""')
}

const WSK_EXECUTE: Wskazowka[] = [
  { nazwa: "python-w-execute", re: /^\s*(def \w+\(|import \w+\s*$|from \w+ import |print\s*\()/m,
    tekst: 'execute rozumie tylko JavaScript. Wypisywanie: console.log("tekst"). Python uruchom narzędziem shell: python3 -c "print(1)".' },
  { nazwa: "require-import", re: /\brequire\s*\(|\bawait\s+import\s*\(|^\s*import\s+[\w{*]/m,
    tekst: 'W execute nie ma Node (brak require/import). Plik: const r = await tools.filesystem.read_file({path: "/home/user/plik.txt"}); console.log(r.content). Polecenia systemowe: narzędzie shell.' },
  { nazwa: "timer", re: /\b(setTimeout|setInterval|setImmediate)\s*\(/,
    tekst: 'W execute nie ma timerów. Czekanie: await tools.playwright.browser_wait_for({time: 2}) (sekundy), a poza przeglądarką narzędzie shell: sleep 2.' },
  { nazwa: "page-playwright", re: /(^|[^.\w])(page|browser|context)\.(title|goto|click|fill|type|evaluate|locator|url|content|waitFor\w*|newPage|close|screenshot)\s*\(/,
    tekst: 'Nie ma obiektu page/browser. Użyj: await tools.playwright.browser_navigate({url: "https://example.com"}); const s = await tools.playwright.browser_snapshot(); console.log(s) — tytuł i adres są w zrzucie („Page Title”, „Page URL”).' },
  { nazwa: "fs-process", re: /(^|[^.\w])(fs|process|child_process|os)\.\w+\s*\(/,
    tekst: 'W execute nie ma fs/process. Pliki: await tools.filesystem.read_file({path: "/home/user/plik"}) albo narzędzie read; polecenia: narzędzie shell.' },
  { nazwa: "websearch-w-execute", re: /\btools\.websearch\./,
    tekst: 'websearch jest wyłączony. Szukaj w przeglądarce: await tools.playwright.browser_navigate({url: "https://duckduckgo.com/?q=SLOWA+PLUSAMI"}); const r = await tools.playwright.browser_evaluate({function: "() => [...document.querySelectorAll(\'a[data-testid=result-title-a]\')].map(a => a.href + \' | \' + a.innerText).slice(0, 10).join(\'\\\\n\')"}); console.log(r)' },
]

const WSK_SHELL: Wskazowka[] = [
  { nazwa: "js-w-shell", re: /^\s*(await\s+)?tools\.\w+\.\w+/,
    tekst: 'To JavaScript, a shell to powłoka. Wywołania tools.* wykonuj narzędziem execute, np. code: const r = await tools.playwright.browser_navigate({url: "https://example.com"}); console.log(r)' },
  { nazwa: "sudo", re: /(^|[;&|]\s*)sudo\b/,
    tekst: 'sudo w narzędziach jest zablokowane. Przygotuj plik w katalogu domowym i podaj użytkownikowi JEDNĄ komendę do wykonania, np.: sudo cp ~/tmp-opencode/plik /etc/plik' },
  { nazwa: "zabijanie-uslug", re: /\b(pkill|killall)\b[^|;&>]*[\s'"](opencode|llama|brave|playwright)/,
    tekst: 'Nie zabijaj opencode, modeli ani przeglądarki — to przerywa tę sesję albo pracę użytkownika. Sprawdź stan: pgrep -x llama-server; systemctl --user list-units "llama*". Zatrzymanie albo restart zaproponuj użytkownikowi.' },
  ...(existsSync("/usr/bin/pacman") ? [  { nazwa: "apt", re: /\b(apt|apt-get)\s+(install|update|upgrade|remove)\b/,
    tekst: 'To Arch (CachyOS), nie ma apt. Sprawdź pakiet: pacman -Ss NAZWA albo pacman -Qi NAZWA. Instalację (sudo pacman -S NAZWA) podaj użytkownikowi do wykonania.' }] : []),
  { nazwa: "zapis-do-systemu", re: />>?\s*\/(etc|usr|boot)\/|\btee\s+(-a\s+)?\/(etc|usr|boot)\/|\bsed\s+-i[^|;&]*\s\/(etc|usr|boot)\/|\b(cp|mv|install)\s[^|;&]*\s\/(etc|usr|boot)\/\S*\s*($|[;&|])/,
    tekst: 'Do /etc, /usr i /boot nie da się pisać bez roota. Zapisz plik w ~/tmp-opencode/, pokaż go i podaj użytkownikowi JEDNĄ komendę: sudo cp ~/tmp-opencode/plik /etc/plik' },
  { nazwa: "kbuildsycoca", re: /\bkbuildsyscaches?6?\b/,
    tekst: 'Polecenie nazywa się kbuildsycoca6: kbuildsycoca6 --noincremental' },
]

// TRYB NAPRAWCZY (sesja, w której model wczytał skill `autodiag` albo używa oc-wniosek / oc-regula / testu wtyczki):
// osobista pamięć użytkownika (serwer MCP `mempalace` = ~/.mempalace) jest wtedy TYLKO DO ODCZYTU. Wnioski z napraw idą
// do osobnego pałacu przez ~/bin/oc-wniosek. Poza trybem naprawczym model ma pełny dostęp jak dotąd.
// Te wskazówki nie mają limitu powtórzeń — to blokada, nie podpowiedź.
const WSK_NAPRAWA_EXECUTE: Wskazowka[] = [
  { nazwa: "naprawa-zapis-do-pamieci", re: /\btools\.mempalace\.mempalace_(add_drawer|delete_drawer|kg_add|kg_invalidate|diary_write)\b/,
    tekst: 'Trwa tryb naprawczy: pamięć użytkownika jest teraz tylko do odczytu (wolno mempalace_search). Wniosek z naprawy zapisz narzędziem shell: ~/bin/oc-wniosek dodaj "OBJAW: komunikat błędu" "PRZYCZYNA" "NAPRAWA" "PRZYKŁAD poprawnego wywołania"' },
]
const WSK_NAPRAWA_SHELL: Wskazowka[] = [
  { nazwa: "naprawa-mempalace-cli", re: /(^|[;&|]\s*)mempalace\s+(mine|init|split|compress|repair)\b/,
    tekst: 'Trwa tryb naprawczy: nie zmieniaj pałacu użytkownika poleceniem mempalace. Znane rozwiązania: ~/bin/oc-wniosek szukaj "komunikat"; nowy wniosek: ~/bin/oc-wniosek dodaj "OBJAW" "PRZYCZYNA" "NAPRAWA"' },
]

// czy to wywołanie włącza tryb naprawczy dla sesji
function wlaczaNaprawe(tool: string, input: any): boolean {
  try {
    if (!input || typeof input !== "object") return false
    if (tool === "skill") return /^autodiag$/i.test(String(input.id ?? input.name ?? input.skill ?? ""))
    if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string")
      return /\b(oc-wniosek|oc-regula|test-wtyczki\.sh|powtorka-historii\.sh)\b/.test(input.command)
  } catch {}
  return false
}

function wskazowka(tool: string, input: any, naprawa = false): { nazwa: string; tekst: string; zawsze?: boolean } | undefined {
  try {
    if (!input || typeof input !== "object") return undefined
    if (naprawa) {
      if (tool === "execute" && typeof input.code === "string") {
        for (const w of WSK_NAPRAWA_EXECUTE) if (w.re.test(input.code)) return { nazwa: w.nazwa, tekst: w.tekst, zawsze: true }
      } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
        for (const w of WSK_NAPRAWA_SHELL) if (w.re.test(bezNapisow(input.command))) return { nazwa: w.nazwa, tekst: w.tekst, zawsze: true }
      }
    }
    if (tool === "execute" && typeof input.code === "string") {
      const goly = bezNapisow(input.code)
      for (const w of WSK_EXECUTE) if (w.re.test(goly)) return { nazwa: w.nazwa, tekst: w.tekst }
    } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
      const goly = bezNapisow(input.command)
      // nazwa zabijanego procesu bywa w cudzysłowie (pkill -f 'opencode serve'), więc tę regułę sprawdzamy na pełnym poleceniu
      for (const w of WSK_SHELL) if (w.re.test(w.nazwa === "zabijanie-uslug" ? input.command : goly)) return { nazwa: w.nazwa, tekst: w.tekst }
    }
  } catch {}
  return undefined
}

// ── ZNANE ROZWIĄZANIA PRZY BŁĘDZIE (auto-recall z kopalni) ───────────────────────────────────────
// Gdy narzędzie zwróci błąd, szukamy w ~/oc-audyt/kopalnia/*.md wniosku, którego OBJAW pasuje do komunikatu,
// i doklejamy jego NAPRAWĘ i PRZYKŁAD do wyniku błędu. Model dostaje rozwiązanie bez wołania oc-wniosek.
// Dopasowanie leksykalne (bez embeddingów, szybkie, deterministyczne). Ten sam wniosek najwyżej raz na sesję.
type Wniosek = { plik: string; objaw: string; przyczyna: string; naprawa: string; przyklad: string; slowa: string[] }
const KOPALNIA = join(HOME, "oc-audyt", "kopalnia")
const POSPOLITE = new Set("nie jest jak przy albo oraz dla tego ten that the and model modelu narzedzie narzedzia blad bledu error przez jako tylko gdy kiedy sie nad pod bez ale czy jego jej ich to na do od po za ze co with from for into this tool tools call".split(" "))
// słowa obecne w prawie każdym komunikacie błędu — same nie świadczą o tym, że to ten sam problem
const OGOLNE = new Set("invalid arguments argument missing unexpected token error errors failed fail provided update again line file files directory exited code status call calltool browserbackend found such found cannot read properties undefined null type string expected object https http traceback recent last most module message result execute".split(" "))
let wnioskiCache: { czas: number; lista: Wniosek[] } = { czas: 0, lista: [] }

function norm(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l")
}
function slowaZ(t: string): string[] {
  return [...new Set(norm(t).replace(/\d+/g, " ").split(/[^a-z_]+/).filter((w) => w.length >= 4 && !POSPOLITE.has(w)))]
}

function wnioski(): Wniosek[] {
  const teraz = Date.now()
  if (teraz - wnioskiCache.czas < 60_000) return wnioskiCache.lista
  const lista: Wniosek[] = []
  try {
    for (const f of readdirSync(KOPALNIA)) {
      if (!f.endsWith(".md")) continue
      const t = readFileSync(join(KOPALNIA, f), "utf8")
      const pole = (n: string) => (t.match(new RegExp("^" + n + ": (.*)$", "m")) ?? [])[1] ?? ""
      const objaw = pole("OBJAW")
      if (!objaw) continue
      lista.push({ plik: f, objaw, przyczyna: pole("PRZYCZYNA"), naprawa: pole("NAPRAWA"), przyklad: pole("PRZYKŁAD"), slowa: slowaZ(objaw) })
    }
  } catch {}
  wnioskiCache = { czas: teraz, lista }
  return lista
}

// najlepszy wniosek dla komunikatu błędu: ≥3 wspólne słowa i (≥25% OBJAWU albo ≥50% komunikatu); 2 słowa tylko przy krótkim, zgodnym komunikacie
function dopasujWniosek(komunikat: string, lista: Wniosek[] = wnioski()): Wniosek | undefined {
  const m = new Set(slowaZ(komunikat))
  let best: Wniosek | undefined, bestWynik = 0
  for (const w of lista) {
    if (!w.slowa.length) continue
    const traf = w.slowa.filter((x) => m.has(x)).length
    const charakterystyczne = w.slowa.filter((x) => m.has(x) && !OGOLNE.has(x)).length
    if (charakterystyczne < 2) continue
    const udzial = traf / w.slowa.length // ile OBJAWU pokrywa komunikat
    const pokrycie = m.size ? traf / m.size : 0 // ile komunikatu pokrywa OBJAW
    const ok = traf >= 3 ? udzial >= 0.3 || pokrycie >= 0.5 : traf === 2 && pokrycie >= 0.4 && udzial >= 0.3
    if (ok && traf + udzial > bestWynik) { best = w; bestWynik = traf + udzial }
  }
  return best
}

// co model ma zobaczyć: przyczynę i gotowe poprawne wywołanie (NAPRAWA opisuje zwykle wnętrze wtyczki — tylko gdy brak przykładu)
function tekstWniosku(wn: Wniosek): string {
  const co = wn.przyklad ? `zrób tak: ${wn.przyklad}` : wn.naprawa
  return `\n\nZNANE ROZWIĄZANIE: ${wn.przyczyna ? wn.przyczyna + " — " : ""}${co}`
}

// dokleja tekst do wyniku błędu — próbuje wszystkich miejsc, w których opencode trzyma komunikat; zwraca, co zmieniono
function doklejDoBledu(ev: any, tekst: string): string[] {
  const gdzie: string[] = []
  try {
    if (ev.error && typeof ev.error.message === "string") { ev.error.message += tekst; gdzie.push("error.message") }
    const res = ev.result
    if (res && Array.isArray(res.content)) {
      const ost = [...res.content].reverse().find((x: any) => x && typeof x.text === "string")
      if (ost) { ost.text += tekst; gdzie.push("result.content") }
      else { res.content.push({ type: "text", text: tekst.trim() }); gdzie.push("result.content+") }
    }
    if (res && typeof res.output === "string") { res.output += tekst; gdzie.push("result.output") }
    if (typeof ev.output === "string") { ev.output += tekst; gdzie.push("output") }
  } catch {}
  return gdzie
}

const keyOf = (tool: string, input: unknown) => {
  try {
    return tool + "\u0000" + JSON.stringify(input)
  } catch {
    return ""
  }
}

// ── angielskie nazwy eksportowane (test i backward compat) ──────────────────────────────────────
export { fixCode, fixNames, fixMcp }

// mapa: polskie nazwy wniosków → angielskie (dla testów i deweloperów)
const HINT_MAP: Record<string, string> = {
  "python-w-execute": "python-in-execute",
  "websearch-w-execute": "websearch-in-execute",
  "js-w-shell": "js-in-shell",
  "zabijanie-uslug": "killing-services",
  "zapis-do-systemu": "write-to-system",
  "naprawa-zapis-do-pamieci": "repair-memory-write",
  "naprawa-mempalace-cli": "repair-mempalace-cli",
}

export function hint(tool: string, input: any, repair = false) {
  const w = wskazowka(tool, input, repair)
  if (!w) return undefined
  return { name: HINT_MAP[w.nazwa] ?? w.nazwa, text: w.tekst, always: w.zawsze }
}

export function matchLesson(message: string) {
  const w = dopasujWniosek(message)
  if (!w) return undefined
  return { file: w.plik, symptom: w.objaw, cause: w.przyczyna, fix: w.naprawa, example: w.przyklad }
}

export const enablesRepairMode = wlaczaNaprawe

export default {
  id: "tool-input-fix",
  async setup(ctx: any) {
    // sessionID → (klucz wywołania → {licznik błędów, ostatni błąd})
    const fails = new Map<string, Map<string, { n: number; msg: string }>>()
    const bucket = (sid: string) => {
      let b = fails.get(sid)
      if (!b) {
        if (fails.size > 50) fails.clear()
        b = new Map()
        fails.set(sid, b)
      }
      return b
    }

    // ile razy dana wskazówka pojawiła się w sesji
    const pokazane = new Map<string, number>()
    // sesje w trybie naprawczym (pamięć użytkownika tylko do odczytu)
    const naprawa = new Set<string>()
    // wnioski już doklejone w danej sesji
    const przypomniane = new Set<string>()

    await ctx.tool.hook("execute.before", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        let input = ev.input
        let fixes: string[] = []
        // tools.filesystem.read_file("/ścieżka") → {path}
        if (typeof input === "string" && tool.startsWith("filesystem_")) {
          input = { path: input }
          fixes.push("string→{path}")
        }
        if (!input || typeof input !== "object") return
        if (tool === "execute" && typeof input.code === "string") {
          const r = fixCode(input.code)
          const n = fixNames(r.code)
          if (r.fixes.length || n.fixes.length) {
            input = { ...input, code: n.code }
            fixes = [...r.fixes, ...n.fixes]
          }
        } else {
          const copy = { ...input }
          const f = fixMcp(tool, copy)
          if (f.length) {
            input = copy
            fixes.push(...f)
          }
        }
        if (fixes.length) {
          ev.input = input
          log(`FIX ${tool} [${fixes.join(",")}] session=${ev.sessionID}`)
        }

        // blokada: browser_navigate z protokołem niestandardowym lub browser_type bez targetu
        if (input && typeof input === "object" && input._block === true) {
          let stopMsg: string
          if (/_navigate$/.test(tool)) {
            stopMsg = `browser_navigate nie obsługuje protokołu ${JSON.stringify(input.url?.slice(0, 40))}. Playwright akceptuje tylko http/https. Użyj shell: xdg-open "${input.url}" lub narzędzie read do plików lokalnych.`
          } else if (/_type$/.test(tool)) {
            stopMsg = "browser_type wymaga targetu (element do wpisania). Najpierw zrób browser_snapshot(), weź ref z [ref=xxx] i podaj: target: \"xxx\". Albo użyj browser_fill_form do wypełniania formularzy."
          } else {
            stopMsg = "Wywołanie zablokowane — niezgodne ze schematem."
          }
          if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(stopMsg)})` }
          log(`BLOCK ${tool} session=${ev.sessionID}`)
        }

        // tryb naprawczy sesji
        const sidN = String(ev.sessionID)
        if (!naprawa.has(sidN) && wlaczaNaprawe(tool, input)) {
          if (naprawa.size > 500) naprawa.clear()
          naprawa.add(sidN)
          log(`TRYB-NAPRAWCZY wlaczony (${tool}) session=${sidN}`)
        }
        // wskazówka zamiast wykonania (najwyżej 2× ta sama na sesję; blokady trybu naprawczego bez limitu)
        const w = wskazowka(tool, input, naprawa.has(sidN))
        if (w) {
          const klucz = String(ev.sessionID) + "\u0000" + w.nazwa
          const ile = (pokazane.get(klucz) ?? 0) + 1
          if (pokazane.size > 2000) pokazane.clear()
          pokazane.set(klucz, ile)
          if (ile <= 2 || w.zawsze) {
            const tekst = "WSKAZÓWKA (wywołanie nie zostało wykonane): " + w.tekst
            if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(tekst)})` }
            else ev.input = { ...input, command: `printf '%s\\n' ${JSON.stringify(tekst).replace(/[`$]/g, "")} >&2; exit 1` }
            log(`HINT ${tool} [${w.nazwa}] session=${ev.sessionID}`)
            return
          }
        }

        const prev = bucket(String(ev.sessionID)).get(keyOf(tool, input))
        if (prev && prev.n >= MAX_REPEAT) {
          const stop =
            `STOP: identyczne wywołanie ${tool} padło już ${prev.n}× z błędem: ${prev.msg.slice(0, 200)}. ` +
            `Ponowienie da ten sam wynik. Zmień kod/argumenty albo podejście (np. webfetch), a jeśli nie wiesz jak — powiedz użytkownikowi.`
          if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(stop)})` }
          else if (tool === "shell" && typeof input.command === "string")
            ev.input = { ...input, command: `echo ${JSON.stringify(stop).replace(/[`$]/g, "")} >&2; exit 1` }
          log(`LOOP-STOP ${tool} n=${prev.n} fixes=[${fixes.join(",")}] error="${prev.msg.slice(0, 150)}" session=${ev.sessionID}`)
        }
      } catch (e) {
        log(`hook before failed: ${e}`)
      }
    })

    await ctx.tool.hook("execute.after", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        const res = ev.result as any
        const failed =
          ev.status === "error" ||
          res?.metadata?.error === true ||
          (typeof res?.metadata?.exit === "number" && res.metadata.exit !== 0)
        const key = keyOf(tool, ev.input)
        const b = bucket(String(ev.sessionID))
        if (!failed) {
          b.delete(key)
          return
        }
        const msg = String(
          ev.error?.message ??
            (Array.isArray(res?.content) ? res.content.map((x: any) => x?.text ?? "").join(" ") : "") ??
            res?.output ??
            "",
        )
        const prev = b.get(key)
        b.set(key, { n: (prev?.n ?? 0) + 1, msg: msg || prev?.msg || "?" })
        // znane rozwiązanie z kopalni — doklejone do błędu, raz na sesję dla danego wniosku
        const wn = dopasujWniosek(msg)
        if (wn) {
          const k = String(ev.sessionID) + "\u0000" + wn.plik
          if (!przypomniane.has(k)) {
            if (przypomniane.size > 2000) przypomniane.clear()
            przypomniane.add(k)
            const tekst = tekstWniosku(wn)
            const gdzie = doklejDoBledu(ev, tekst)
            log(`RECALL ${tool} [${wn.plik}] → ${gdzie.join(",") || "BRAK MIEJSCA"} session=${ev.sessionID}`)
          }
        }
      } catch (e) {
        log(`hook after failed: ${e}`)
      }
    })

    log("loaded")
  },
}


