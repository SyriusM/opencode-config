import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

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
// od którego STOP-u w sesji komunikat każe skończyć turę bez narzędzi
const STOP_ESCALATE = 3
// katalog domowy jako regex (bez wpisanej nazwy użytkownika): „home/user/…” i „/home/USER/…”
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const HOME_NOSLASH_RE = new RegExp("^" + escRe(HOME.slice(1)) + "/", "i")
const HOME_ABS_RE = new RegExp("^" + escRe(HOME) + "/", "i")

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

// pełne wejście przy wskazówce — baza opencode zapisuje już podmienioną komendę, więc oryginał
// (materiał na pary błąd→poprawka) zostaje tylko tutaj; jeden obiekt JSON na linię
const HINT_LOG = join(HOME, ".mempalace", "hook_state", "tool_input_fix-hints.jsonl")
const HINT_LOG_MAX = 20000

function logHint(session: string, tool: string, name: string, input: unknown, text: string) {
  try {
    let rec = JSON.stringify({ ts: new Date().toISOString(), session, tool, hint: name, input, text })
    if (rec.length > HINT_LOG_MAX)
      rec = JSON.stringify({ ts: new Date().toISOString(), session, tool, hint: name, input_truncated: JSON.stringify(input).slice(0, HINT_LOG_MAX), text })
    mkdirSync(join(HINT_LOG, ".."), { recursive: true })
    appendFileSync(HINT_LOG, rec + "\n")
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

// ── Cyrylickie homoglify w ścieżkach ──────────────────────────────────────────────────────────────
// Model wpisał „ed-trade-ovelay" (U+0435 zamiast U+0065 e) → ENOENT.
// Normalizujemy TYLKO fragmenty command, które wyglądają na ścieżki (zawierają /).
const CYR_HOGLYPHS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
  "\u0454": "e", "\u0457": "i", "\u0451": "e",
  "\u0442": "t", "\u044c": "b",
}
const HOMOGLYPH_RE = new RegExp(Object.keys(CYR_HOGLYPHS).map(escapeRegex).join("|"), "g")
function escapeRegex(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

function normalizeCyrHomoGlyphs(command: string): string {
  if (!command.includes("/")) return command
  return command.replace(HOMOGLYPH_RE, (m) => CYR_HOGLYPHS[m] ?? m)
}

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
  // homoglify cyrylickie w ścieżkach (np. „ed-trade-ovelay" z U+0435)
  if (tool === "shell" && typeof input.command === "string") {
    const cleaned = normalizeCyrHomoGlyphs(input.command)
    if (cleaned !== input.command) {
      input.command = cleaned
      fixes.push("cyr-homoglyph→latin(command)")
    }
  }
  // filePath: read/write/edit — poprawiamy TYLKO gdy oryginał nie istnieje, a znormalizowana wersja istnieje
  const filePath = input.filePath ?? input.path
  if (typeof filePath === "string" && filePath.includes("/")) {
    const cleaned = normalizeCyrHomoGlyphs(filePath)
    if (cleaned !== filePath && !pathExists(filePath) && pathExists(cleaned)) {
      if (input.filePath !== undefined) input.filePath = cleaned
      else if (input.path !== undefined) input.path = cleaned
      fixes.push("cyr-homoglyph→latin(filePath)")
    }
  }
  return fixes
}

// ── WSKAZÓWKI W CHWILI BŁĘDU ──────────────────────────────────────────────────────────────────────
// Błędy semantyczne: składnia poprawna, ale model używa czegoś, czego w tym środowisku nie ma (Node w `execute`,
// sudo, apt, zapis do /etc…). Zamiast pozwolić na niejasny błąd, nie wykonujemy wywołania i zwracamy JEDNO zdanie
// z gotowym poprawnym przykładem (małe modele powtarzają to, co widzą — dlatego przykład, nie sam zakaz).
// Każda wskazówka najwyżej 2× na sesję; potem wywołanie idzie normalnie. Wzorce z bazy błędów opencode (10-2026).
type Hint = { name: string; re: RegExp; text: string }

// usuwa napisy i komentarze, żeby np. `document.title` wewnątrz browser_evaluate nie było fałszywym trafieniem
function stripLiterals(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""')
}

const HINTS_EXECUTE: Hint[] = [
  { name: "python-in-execute", re: /^\s*(def \w+\(|import (\w+(\s+as\s+\w+)?)(\s*,\s*(\w+(\s+as\s+(\w))?))*\s*$|from [\w.]+ import |print\s*\()/m,
    text: 'execute rozumie tylko JavaScript. Wypisywanie: console.log("tekst"). Python uruchom narzędziem shell: python3 -c "print(1)".' },
  { name: "python-import", re: /^\s*import\s+(?:\w+[\s\S]*?\s+from\s+|[{*])/m,
    text: 'To JavaScript (ES modules), nie Python. W execute: const fs = await import("fs"); albo await tools.filesystem.read_file({path: "/home/user/plik"}).' },
  { name: "require-import", re: /\brequire\s*\(|\bawait\s+import\s*\(/,
    text: 'W execute nie ma Node (brak require/import). Plik: const r = await tools.filesystem.read_file({path: "/home/user/plik.txt"}); console.log(r.content). Polecenia systemowe: narzędzie shell.' },
  { name: "timer", re: /\b(setTimeout|setInterval|setImmediate)\s*\(/,
    text: 'W execute nie ma timerów. Czekanie: await tools.playwright.browser_wait_for({time: 2}) (sekundy), a poza przeglądarką narzędzie shell: sleep 2.' },
  { name: "page-playwright", re: /(^|[^.\w])(page|browser|context)\.(title|goto|click|fill|type|evaluate|locator|url|content|waitFor\w*|newPage|close|screenshot)\s*\(/,
    text: 'Nie ma obiektu page/browser. Użyj: await tools.playwright.browser_navigate({url: "https://example.com"}); const s = await tools.playwright.browser_snapshot(); console.log(s) — tytuł i adres są w zrzucie („Page Title”, „Page URL”).' },
  { name: "fs-process", re: /(^|[^.\w])(fs|process|child_process|os)\.\w+\s*\(/,
    text: 'W execute nie ma fs/process. Pliki: await tools.filesystem.read_file({path: "/home/user/plik"}) albo narzędzie read; polecenia: narzędzie shell.' },
  { name: "websearch-in-execute", re: /\btools\.websearch\./,
    text: 'websearch jest wyłączony. Szukaj w przeglądarce: await tools.playwright.browser_navigate({url: "https://duckduckgo.com/?q=SLOWA+PLUSAMI"}); const r = await tools.playwright.browser_evaluate({function: "() => [...document.querySelectorAll(\'a[data-testid=result-title-a]\')].map(a => a.href + \' | \' + a.innerText).slice(0, 10).join(\'\\\\n\')"}); console.log(r)' },
]

// Po „Could not find oldString”: pokaż, jak naprawdę wygląda w pliku pierwsza niepusta linia oldString
// (porównanie bez białych znaków na brzegach, bo zwykle psuje się wcięcie). Tani: jedno przejście po pliku.
const similarLines = (path: unknown, oldString: unknown): string | undefined => {
  if (typeof path !== "string" || typeof oldString !== "string") return
  const needle = oldString.split("\n").map((l) => l.trim()).find((l) => l.length >= 4)
  if (!needle) return
  let src: string
  try {
    src = readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8")
  } catch {
    return
  }
  if (src.length > 500_000) return
  const lines = src.split("\n")
  const i = lines.findIndex((l) => l.trim() === needle)
  if (i < 0) return `PODPOWIEDŹ: linii "${needle.slice(0, 120)}" nie ma w pliku nawet po zignorowaniu wcięć — wczytaj plik narzędziem read i skopiuj fragment dokładnie.`
  const n = oldString.split("\n").length
  const fragment = lines.slice(i, i + Math.min(n, 8)).join("\n")
  return `PODPOWIEDŹ: w pliku (linia ${i + 1}) ten fragment wygląda dokładnie tak — skopiuj go z tymi wcięciami jako oldString:\n${fragment.slice(0, 1500)}`
}

// Po „Could not find oldString” w pliku, którego model w tej sesji nie wczytał (15% błędów 30 dni: never-read)
// albo wczytał tylko kawałkiem offset/limit (9%): powiedz to wprost, zanim spróbuje znowu z pamięci.
const normPath = (p: unknown) => (typeof p === "string" && p ? resolve(p.replace(/^~(?=\/)/, homedir())) : "")
const unreadFileHint = (path: string, readState: "never" | "partial") =>
  readState === "never"
    ? `UWAGA: w tej sesji nie wczytałeś pliku ${path} — oldString pochodzi z pamięci albo zgadywania. ` +
      `NAJPIERW wywołaj read na tym pliku, potem skopiuj oldString dosłownie z wyniku (bez numerów linii "N: ").`
    : `UWAGA: plik ${path} wczytałeś tylko fragmentami (offset/limit) — zmieniane miejsce mogło być poza nimi. ` +
      `Wczytaj read okolicę, którą zmieniasz, i skopiuj oldString dosłownie z wyniku (bez numerów linii "N: ").`

// glob (*?[) traktujemy jak istniejącą ścieżkę — model właśnie sprawdza, nie zgaduje
const pathExists = (p: string) => {
  if (/[*?[]/.test(p)) return true
  try {
    return existsSync(p.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "") || "/")
  } catch {
    return false
  }
}

// znajdź najbliższą istniejącą ścieżkę (dla hinta "czy chodziło o…")
// 1) idź wyżej, aż znajdziesz istniejący katalog
// 2) w nim wyszukaj najbliższą nazwę (homo-glyph + podobieństwo)
const nearestPath = (path: string): string | null => {
  try {
    const abs = path.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "")
    const parts = abs.split("/").filter(Boolean)
    let foundParent = false
    // znajdź pierwszy brakujący segment (idź od dołu, zatrzymaj się na pierwszym istniejącym rodzicu)
    for (let i = parts.length - 1; i >= 0; i--) {
      const parent = "/" + parts.slice(0, i).join("/")
      const child = parts[i]
      if (!pathExists(parent)) continue
      foundParent = true
      // rodzic istnieje — szukaj najbliższego dziecka
      const kids = readdirSync(parent)
      const childNorm = normalizeCyrHomoGlyphs(child)
      const maxDist = Math.max(2, Math.floor(childNorm.length / 4))
      // 1) exact match po normalizacji
      for (const k of kids) {
        if (normalizeCyrHomoGlyphs(k).toLowerCase() === childNorm.toLowerCase()) {
          const result = join(parent, k, ...parts.slice(i + 1))
          if (pathExists(result)) return result
          break
        }
      }
      // 2) najbliższe po edit distance z progiem
      let best: string | null = null
      let bestDist = Infinity
      for (const k of kids) {
        const kNorm = normalizeCyrHomoGlyphs(k)
        const dist = (() => {
          const d: number[][] = Array.from({ length: childNorm.length + 1 }, (_, a) => Array.from({ length: kNorm.length + 1 }, (_, b) => Math.max(a, b)))
          for (let a = 1; a <= childNorm.length; a++) for (let b = 1; b <= kNorm.length; b++)
            d[a][b] = childNorm[a - 1] === kNorm[b - 1] ? d[a - 1][b - 1] : Math.min(d[a - 1][b], d[a][b - 1], d[a - 1][b - 1]) + 1
          return d[childNorm.length][kNorm.length]
        })()
        if (dist <= maxDist && dist < bestDist) { bestDist = dist; best = k }
      }
      if (best) {
        const result = join(parent, best, ...parts.slice(i + 1))
        if (pathExists(result)) return result
      }
      // po przetworzeniu pierwszego istniejącego rodzica — koniec (bez dalszego wspinania)
      break
    }
    return null
  } catch {
    return null
  }
}

const HINTS_SHELL: Hint[] = [
  { name: "js-in-shell", re: /^\s*(await\s+)?tools\.\w+\.\w+/,
    text: 'To JavaScript, a shell to powłoka. Wywołania tools.* wykonuj narzędziem execute, np. code: const r = await tools.playwright.browser_navigate({url: "https://example.com"}); console.log(r)' },
  { name: "guessed-path", re: /\bls\b(\s+-[a-zA-Z]*)?\s+["']?(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' },
  { name: "guessed-path", re: /\b(cat|head|tail|less|more)\b(\s+-\S+)*\s+(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' },
  { name: "ls-no-access", re: /\bls:\s*nie ma dostępu|File not found|Nie ma takiego pliku/i,
    text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' },
  { name: "guessed-path", re: /\bfind\b(\s+-\S+)*\s+(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' },
  { name: "sudo", re: /(^|[;&|]\s*)sudo\b/,
    text: 'sudo w narzędziach jest zablokowane. Przygotuj plik w katalogu domowym i podaj użytkownikowi JEDNĄ komendę do wykonania, np.: sudo cp ~/tmp-opencode/plik /etc/plik' },
  { name: "killing-services", re: /\b(pkill|killall)\b[^|;&>]*[\s'"](opencode|llama|brave|playwright)/,
    text: 'Nie zabijaj opencode, modeli ani przeglądarki — to przerywa tę sesję albo pracę użytkownika. Sprawdź stan: pgrep -x llama-server; systemctl --user list-units "llama*". Zatrzymanie albo restart zaproponuj użytkownikowi.' },
  ...(existsSync("/usr/bin/pacman") ? [  { name: "apt", re: /\b(apt|apt-get)\s+(install|update|upgrade|remove)\b/,
    text: 'To Arch (CachyOS), nie ma apt. Sprawdź pakiet: pacman -Ss NAZWA albo pacman -Qi NAZWA. Instalację (sudo pacman -S NAZWA) podaj użytkownikowi do wykonania.' }] : []),
  { name: "write-to-system", re: />>?\s*\/(etc|usr|boot)\/|\btee\s+(-a\s+)?\/(etc|usr|boot)\/|\bsed\s+-i[^|;&]*\s\/(etc|usr|boot)\/|\b(cp|mv|install)\s[^|;&]*\s\/(etc|usr|boot)\/\S*\s*($|[;&|])/,
    text: 'Do /etc, /usr i /boot nie da się pisać bez roota. Zapisz plik w ~/tmp-opencode/, pokaż go i podaj użytkownikowi JEDNĄ komendę: sudo cp ~/tmp-opencode/plik /etc/plik' },
  { name: "kbuildsycoca", re: /\bkbuildsyscaches?6?\b/,
    text: 'Polecenie nazywa się kbuildsycoca6: kbuildsycoca6 --noincremental' },
  { name: "guessed-path", re: /\b(cp|mv|install)\b[^|;&]*\s(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)\s[^|;&]*/,
    text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' },
]

// TRYB NAPRAWCZY (sesja, w której model wczytał skill `autodiag` albo używa lesson-note / agent-rule / testu wtyczki):
// osobista pamięć użytkownika (serwer MCP `mempalace` = ~/.mempalace) jest wtedy TYLKO DO ODCZYTU. Wnioski z napraw idą
// do osobnego pałacu przez ~/bin/lesson-note. Poza trybem naprawczym model ma pełny dostęp jak dotąd.
// Te wskazówki nie mają limitu powtórzeń — to blokada, nie podpowiedź.
const HINTS_REPAIR_EXECUTE: Hint[] = [
  { name: "repair-memory-write", re: /\btools\.mempalace\.mempalace_(add_drawer|delete_drawer|kg_add|kg_invalidate|diary_write)\b/,
    text: 'Trwa tryb naprawczy: pamięć użytkownika jest teraz tylko do odczytu (wolno mempalace_search). Wniosek z naprawy zapisz narzędziem shell: ~/bin/lesson-note dodaj "OBJAW: komunikat błędu" "PRZYCZYNA" "NAPRAWA" "PRZYKŁAD poprawnego wywołania"' },
]
const HINTS_REPAIR_SHELL: Hint[] = [
  { name: "repair-mempalace-cli", re: /(^|[;&|]\s*)mempalace\s+(mine|init|split|compress|repair)\b/,
    text: 'Trwa tryb naprawczy: nie zmieniaj pałacu użytkownika poleceniem mempalace. Znane rozwiązania: ~/bin/lesson-note szukaj "komunikat"; nowy wniosek: ~/bin/lesson-note dodaj "OBJAW" "PRZYCZYNA" "NAPRAWA"' },
]

// czy to wywołanie włącza tryb naprawczy dla sesji
function enablesRepair(tool: string, input: any): boolean {
  try {
    if (!input || typeof input !== "object") return false
    if (tool === "skill") return /^autodiag$/i.test(String(input.id ?? input.name ?? input.skill ?? ""))
    if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string")
      return /\b(oc-wniosek|lesson-note|oc-regula|agent-rule|test-wtyczki\.sh|test-plugin\.sh|powtorka-historii\.sh|history-replay\.sh)\b/.test(input.command)
  } catch {}
  return false
}

function findHint(tool: string, input: any, repairMode = false): { name: string; text: string; always?: boolean } | undefined {
  try {
    if (!input || typeof input !== "object") return undefined
    // read/edit z filePath — sprawdz istnienie + najblizsza sciezka (TYLKO absolutne)
    // edit z pustym oldString: opencode sam odpowie „Use write to create…” — nie zasłaniamy tego
    const emptyEdit = tool === "edit" && (input.oldString === "" || input.old_string === "")
    let fp = (tool === "read" || (tool === "edit" && !emptyEdit)) ? (input.filePath ?? input.path) : null
    // „home/USER/…” bez wiodącego „/” — model zgubił ukośnik; traktuj jak ścieżkę absolutną
    if (typeof fp === "string" && HOME_NOSLASH_RE.test(fp) && !pathExists(fp)) fp = "/" + fp
    // wielkość liter w nazwie katalogu domowego (/home/USER z inną wielkością liter) — popraw od razu, żeby nearestPath mogła poprawić jeszcze jeden segment
    if (typeof fp === "string" && HOME_ABS_RE.test(fp) && !fp.startsWith(HOME + "/")) fp = HOME + "/" + fp.slice(HOME.length + 1)
    if (typeof fp === "string" && (HOME_ABS_RE.test(fp) || fp.startsWith("~/"))) {
      if (!pathExists(fp) || fp !== (input.filePath ?? input.path)) {
        const suggested = pathExists(fp) ? fp : nearestPath(fp)
        if (suggested) {
          return { name: "guessed-path", text: `Czy chodziło o ${suggested}?` }
        }
        return { name: "guessed-path", text: 'Model zgaduje ścieżki (Projekt/Projekti/Pobrane/Pulpit) zamiast sprawdzić ls. Sprawdź najpierw: ls ~/Projekt* lub ls ~/Pobran* i użyj poprawnej ścieżki.' }
      }
    }
    if (repairMode) {
      if (tool === "execute" && typeof input.code === "string") {
        for (const w of HINTS_REPAIR_EXECUTE) if (w.re.test(input.code)) return { name: w.name, text: w.text, always: true }
      } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
        for (const w of HINTS_REPAIR_SHELL) if (w.re.test(stripLiterals(input.command))) return { name: w.name, text: w.text, always: true }
      }
    }
    if (tool === "execute" && typeof input.code === "string") {
      const goly = stripLiterals(input.code)
      for (const w of HINTS_EXECUTE) if (w.re.test(goly)) return { name: w.name, text: w.text }
    } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
      const goly = stripLiterals(input.command)
      // nazwa zabijanego procesu bywa w cudzysłowie (pkill -f 'opencode serve'), więc tę regułę sprawdzamy na pełnym poleceniu
      for (const w of HINTS_SHELL) {
        const m = w.re.exec(w.name === "killing-services" || w.name.startsWith("guessed-path") ? input.command : goly)
        if (!m) continue
        // ls/cat/etc na istniejącą ścieżkę to nie zgadywanie (fałszywy alarm z 10-17)
        if (w.name === "guessed-path") {
          // ścieżka = ostatnia grupa zaczynająca się od / albo ~ (m[2] bywa flagą, np. " -n" w cat -n)
          const sc = [m[3], m[2]].find(g => typeof g === "string" && /^["']?[\/~]/.test(g))
          if (!sc || pathExists(sc)) continue
          const suggested = nearestPath(sc)
          return { name: w.name, text: suggested ? `Czy chodziło o ${suggested}?` : w.text }
        }
        return { name: w.name, text: w.text }
      }
    }
  } catch (e) { if (process.env.TIF_STRICT === "1") throw e }
  return undefined
}

// ── ZNANE ROZWIĄZANIA PRZY BŁĘDZIE (auto-recall z kopalni) ───────────────────────────────────────
// Gdy narzędzie zwróci błąd, szukamy w ~/oc-audyt/kopalnia/*.md wniosku, którego OBJAW pasuje do komunikatu,
// i doklejamy jego NAPRAWĘ i PRZYKŁAD do wyniku błędu. Model dostaje rozwiązanie bez wołania lesson-note.
// Dopasowanie leksykalne (bez embeddingów, szybkie, deterministyczne). Ten sam wniosek najwyżej raz na sesję.
type Lesson = { file: string; symptom: string; cause: string; fix: string; example: string; words: string[] }
const LESSONS_DIR = join(HOME, "oc-audyt", "kopalnia")
const COMMON_WORDS = new Set("nie jest jak przy albo oraz dla tego ten that the and model modelu narzedzie narzedzia blad bledu error przez jako tylko gdy kiedy sie nad pod bez ale czy jego jej ich to na do od po za ze co with from for into this tool tools call".split(" "))
// słowa obecne w prawie każdym komunikacie błędu — same nie świadczą o tym, że to ten sam problem
const GENERIC_WORDS = new Set("invalid arguments argument missing unexpected token error errors failed fail provided update again line file files directory exited code status call calltool browserbackend found such found cannot read properties undefined null type string expected object https http traceback recent last most module message result execute".split(" "))
let lessonsCache: { time: number; list: Lesson[] } = { time: 0, list: [] }

function norm(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l")
}
function wordsOf(t: string): string[] {
  return [...new Set(norm(t).replace(/\d+/g, " ").split(/[^a-z_]+/).filter((w) => w.length >= 4 && !COMMON_WORDS.has(w)))]
}

function lessons(): Lesson[] {
  const nowMs = Date.now()
  if (nowMs - lessonsCache.time < 60_000) return lessonsCache.list
  const lessonList: Lesson[] = []
  try {
    for (const f of readdirSync(LESSONS_DIR)) {
      if (!f.endsWith(".md")) continue
      const t = readFileSync(join(LESSONS_DIR, f), "utf8")
      const field = (n: string) => (t.match(new RegExp("^" + n + ": (.*)$", "m")) ?? [])[1] ?? ""
      const symptomText = field("OBJAW")
      if (!symptomText) continue
      lessonList.push({ file: f, symptom: symptomText, cause: field("PRZYCZYNA"), fix: field("NAPRAWA"), example: field("PRZYKŁAD"), words: wordsOf(symptomText) })
    }
  } catch {}
  lessonsCache = { time: nowMs, list: lessonList }
  return lessonList
}

// najlepszy wniosek dla komunikatu błędu: ≥3 wspólne słowa i (≥25% OBJAWU albo ≥50% komunikatu); 2 słowa tylko przy krótkim, zgodnym komunikacie
function findLesson(errMessage: string, lessonList: Lesson[] = lessons()): Lesson | undefined {
  const m = new Set(wordsOf(errMessage))
  let best: Lesson | undefined, bestScore = 0
  for (const w of lessonList) {
    if (!w.words.length) continue
    const hits = w.words.filter((x) => m.has(x)).length
    const distinctive = w.words.filter((x) => m.has(x) && !GENERIC_WORDS.has(x)).length
    if (distinctive < 2) continue
    const share = hits / w.words.length // ile OBJAWU pokrywa komunikat
    const coverage = m.size ? hits / m.size : 0 // ile komunikatu pokrywa OBJAW
    const ok = hits >= 3 ? share >= 0.3 || coverage >= 0.5 : hits === 2 && coverage >= 0.4 && share >= 0.3
    if (ok && hits + share > bestScore) { best = w; bestScore = hits + share }
  }
  return best
}

// co model ma zobaczyć: przyczynę i gotowe poprawne wywołanie (NAPRAWA opisuje zwykle wnętrze wtyczki — tylko gdy brak przykładu)
function lessonText(wn: Lesson): string {
  const co = wn.example ? `zrób tak: ${wn.example}` : wn.fix
  return `\n\nZNANE ROZWIĄZANIE: ${wn.cause ? wn.cause + " — " : ""}${co}`
}

// dokleja tekst do wyniku błędu — próbuje wszystkich miejsc, w których opencode trzyma komunikat; zwraca, co zmieniono
function appendToError(ev: any, hintText: string): string[] {
  const targets: string[] = []
  try {
    if (ev.error && typeof ev.error.message === "string") { ev.error.message += hintText; targets.push("error.message") }
    const res = ev.result
    if (res && Array.isArray(res.content)) {
      const lastText = [...res.content].reverse().find((x: any) => x && typeof x.text === "string")
      if (lastText) { lastText.text += hintText; targets.push("result.content") }
      else { res.content.push({ type: "text", text: hintText.trim() }); targets.push("result.content+") }
    }
    if (res && typeof res.output === "string") { res.output += hintText; targets.push("result.output") }
    if (typeof ev.output === "string") { ev.output += hintText; targets.push("output") }
  } catch {}
  return targets
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

export function hint(tool: string, input: any, repair = false) {
  const w = findHint(tool, input, repair)
  if (!w) return undefined
  return { name: w.name, text: w.text, always: w.always }
}

export function matchLesson(message: string) {
  const w = findLesson(message)
  if (!w) return undefined
  return { file: w.file, symptom: w.symptom, cause: w.cause, fix: w.fix, example: w.example }
}

export const enablesRepairMode = enablesRepair

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

    // sessionID → ostatnie UDANE wywołanie i ile razy z rzędu się powtórzyło (pętla bez błędów)
    const lastOk = new Map<string, { key: string; n: number }>()
    // sessionID → liczba powtórzeń tego samego błędu edit (dla "No changes to apply")
    const editErrors = new Map<string, number>()
    // sessionID → ile razy w sesji zadziałał STOP; mały model potrafi go ignorować dziesiątki razy (noc 10-20: 48× ten sam cp),
    // więc od STOP_ESCALATE komunikat się zmienia i każe skończyć turę bez narzędzi
    const stopCounts = new Map<string, number>()
    const escalate = (sid: string, base: string, err: string) => {
      const n = (stopCounts.get(sid) ?? 0) + 1
      if (stopCounts.size > 500) stopCounts.clear()
      stopCounts.set(sid, n)
      if (n < STOP_ESCALATE) return { n, text: base }
      return {
        n,
        text:
          `KONIEC PRÓB (STOP nr ${n} w tej sesji — poprzednie zignorowałeś). Narzędzia tego nie naprawią. ` +
          `NIE WYWOŁUJ już żadnego narzędzia. Napisz teraz odpowiedź użytkownikowi: co próbowałeś, ` +
          (err ? `jaki błąd dostałeś (dosłownie: ${err.slice(0, 160)}), ` : "") +
          `i czego potrzebujesz, żeby ruszyć dalej.`,
      }
    }

    // Hook before umie zablokować tylko execute (podmiana code) i shell (podmiana command). Dla read/edit/write itd.
    // wywołanie i tak się wykona, więc tekst (wskazówka, STOP) czeka tu i hook after dokleja go do wyniku
    // (10-20: 88 wskazówek „Czy chodziło o…” dla read nigdy nie dotarło do modelu).
    const pending = new Map<string, string>()
    const pendingKey = (sid: string, tool: string, input: unknown) => sid + "\u0001" + keyOf(tool, input)
    const deliver = (ev: any, tool: string, input: any, text: string, kind: "hint" | "stop") => {
      if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(text)})` }
      else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
        const quoted = JSON.stringify(text).replace(/[`$]/g, "")
        ev.input = { ...input, command: kind === "hint" ? `printf '%s\\n' ${quoted} >&2; exit 1` : `echo ${quoted} >&2; exit 1` }
      } else {
        if (pending.size > 500) pending.clear()
        pending.set(pendingKey(String(ev.sessionID), tool, input), text)
      }
    }

    // sessionID → (plik → "full" | "partial"): co model widział w tej sesji (read, write, udany edit, cat/sed w shellu)
    const seen = new Map<string, Map<string, "full" | "partial">>()
    // sesja utworzona po załadowaniu wtyczki = znamy całą jej historię, więc pierwsze zdarzenie też się liczy
    // (10-20: edit jako pierwsze wywołanie sesji nie dostawał hinta). ID opencode "ses_" + 12 hex = ~(ms*4096+licznik) mod 2^48
    const loadedAt = BigInt(Date.now() - 5000) * 4096n
    const sessionAfterStart = (sid: string) => {
      const h = /^ses_([0-9a-f]{12})/.exec(sid)
      if (!h) return false
      const mask = (1n << 48n) - 1n
      return ((~BigInt("0x" + h[1]) & mask) - loadedAt & mask) < 1n << 47n
    }
    const seenFor = (sid: string) => {
      let m = seen.get(sid)
      if (!m) {
        if (seen.size > 200) seen.clear()
        m = new Map()
        seen.set(sid, m)
      }
      return m
    }

    // ile razy dana wskazówka pojawiła się w sesji
    const shown = new Map<string, number>()
    // sesje w trybie naprawczym (pamięć użytkownika tylko do odczytu)
    const repairMode = new Set<string>()
    // wnioski już doklejone w danej sesji
    const reminded = new Set<string>()

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
        if (!repairMode.has(sidN) && enablesRepair(tool, input)) {
          if (repairMode.size > 500) repairMode.clear()
          repairMode.add(sidN)
          log(`REPAIR-MODE on (${tool}) session=${sidN}`)
        }
        // wskazówka zamiast wykonania (najwyżej 2× ta sama na sesję; blokady trybu naprawczego bez limitu)
        const w = findHint(tool, input, repairMode.has(sidN))
        if (w) {
          const callKey = String(ev.sessionID) + "\u0000" + w.name
          const shownCount = (shown.get(callKey) ?? 0) + 1
          if (shown.size > 2000) shown.clear()
          shown.set(callKey, shownCount)
          if (shownCount <= 2 || w.always) {
            // read/edit itd. wykonują się mimo wskazówki (deliver dokleja ją do wyniku), więc tylko tam bez „nie wykonane”
            const blockable = tool === "execute" || (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string")
            const hintText = (blockable ? "WSKAZÓWKA (wywołanie nie zostało wykonane): " : "WSKAZÓWKA: ") + w.text
            logHint(String(ev.sessionID), tool, w.name, input, w.text)
            deliver(ev, tool, input, hintText, "hint")
            log(`HINT ${tool} [${w.name}] session=${ev.sessionID}`)
            return
          }
        }

        const prev = bucket(String(ev.sessionID)).get(keyOf(tool, input))
        if (prev && prev.n >= MAX_REPEAT) {
          const e = escalate(
            String(ev.sessionID),
            `STOP: identyczne wywołanie ${tool} padło już ${prev.n}× z błędem: ${prev.msg.slice(0, 200)}. ` +
              `Ponowienie da ten sam wynik. Zmień kod/argumenty albo podejście (np. webfetch), a jeśli nie wiesz jak — powiedz użytkownikowi.`,
            prev.msg,
          )
          deliver(ev, tool, input, e.text, "stop")
          log(`LOOP-STOP ${tool} n=${prev.n} stop=${e.n} fixes=[${fixes.join(",")}] error="${prev.msg.slice(0, 150)}" session=${ev.sessionID}`)
        }

        const lastText = lastOk.get(String(ev.sessionID))
        if (lastText && lastText.key === keyOf(tool, input) && lastText.n >= MAX_REPEAT) {
          const e = escalate(
            String(ev.sessionID),
            `STOP: to samo wywołanie ${tool} wykonałeś już ${lastText.n}× z rzędu i wynik jest wyżej w rozmowie. ` +
              `Ponowienie nic nie zmieni. Wykorzystaj ten wynik i zrób następny krok albo napisz użytkownikowi, czego brakuje.`,
            "",
          )
          deliver(ev, tool, input, e.text, "stop")
          log(`LOOP-STOP-OK ${tool} n=${lastText.n} stop=${e.n} session=${ev.sessionID}`)
        }
      } catch (e) {
        log(`hook before failed: ${e}`)
      }
    })

    await ctx.tool.hook("execute.after", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        // wynik naszego własnego STOP-u nie zmienia liczników — inaczej resetowałby pętlę, którą właśnie hamujemy
        const blocked = String(ev.input?.command ?? ev.input?.code ?? "")
        if (/^(echo|throw new Error\()\s*"(STOP:|KONIEC PRÓB)/.test(blocked)) return
        // tekst z hooka before dla narzędzia, którego nie dało się zablokować — doklejamy do wyniku (błędu albo sukcesu)
        const pk = pendingKey(String(ev.sessionID), tool, ev.input ?? {})
        const queued = pending.get(pk)
        if (queued !== undefined) {
          pending.delete(pk)
          const targets = appendToError(ev, "\n\n" + queued)
          log(`DELIVERED ${tool} → ${targets.join(",") || "NO TARGET"} session=${ev.sessionID}`)
        }
        const res = ev.result as any
        // zapis „co model widział” — przed early return dla udanych wywołań; pierwsze zdarzenie sesji
        // tylko zakłada mapę (po przeładowaniu wtyczki w trakcie sesji nie wiemy, co było wcześniej)
        const inSession = seen.has(String(ev.sessionID)) || sessionAfterStart(String(ev.sessionID))
        const m = seenFor(String(ev.sessionID))
        const okRes = ev.status !== "error" && res?.metadata?.error !== true
        if (/^(read|write|edit)$/.test(tool)) {
          const fp = normPath(ev.input?.filePath ?? ev.input?.path)
          if (fp && okRes) {
            const partial = tool === "read" && (ev.input?.offset || ev.input?.limit)
            if (!partial) m.set(fp, "full")
            else if (!m.has(fp)) m.set(fp, "partial")
          }
        } else if (typeof ev.input?.command === "string" && /\b(cat|sed|head|tail|less|bat|nl|awk|grep|rg)\b/.test(ev.input.command)) {
          // cat/sed w shellu też pokazuje treść — zapamiętujemy nazwy plików z komendy (cwd nieznany → basename)
          for (const t of ev.input.command.match(/[\w.~\/-]*[\w-]\.[\w]+/g) ?? []) m.set("shell:" + basename(t), "full")
        }
        const failed =
          ev.status === "error" ||
          res?.metadata?.error === true ||
          (typeof res?.metadata?.exit === "number" && res.metadata.exit !== 0)
        const key = keyOf(tool, ev.input)
        const b = bucket(String(ev.sessionID))
        if (!failed) {
          b.delete(key)
          const sid = String(ev.sessionID)
          if (tool === "edit") editErrors.delete(sid)
          const lastText = lastOk.get(sid)
          if (lastOk.size > 200) lastOk.clear()
          lastOk.set(sid, { key, n: lastText?.key === key ? lastText.n + 1 : 1 })
          return
        }
        lastOk.delete(String(ev.sessionID))
        const msg = String(
          ev.error?.message ||
            (Array.isArray(res?.content) ? res.content.map((x: any) => x?.text ?? "").join(" ") : "") ||
            res?.output ||
            "",
        )
        const input = ev.input ?? {}
        // grep/rg/diff/test z exit 1 i bez wyjścia = „nic nie znaleziono”, nie błąd — nie liczymy do pętli
        const cmd = typeof input.command === "string" ? input.command.trim() : ""
        if (res?.metadata?.exit === 1 && !msg.trim() && /^(grep|rg|diff|test|\[)\s/.test(cmd)) return
        const prev = b.get(key)
        b.set(key, { n: (prev?.n ?? 0) + 1, msg: msg || prev?.msg || "?" })
        if (tool === "edit" && msg.includes("Could not find oldString")) {
          const fp = normPath(input.filePath ?? input.path)
          const readState = !fp || !inSession || m.has("shell:" + basename(fp)) ? "full" : m.get(fp)
          if (readState !== "full") {
            appendToError(ev, "\n" + unreadFileHint(fp, readState ? "partial" : "never"))
            log(`HINT-read-first ${readState ? "partial" : "never"} session=${ev.sessionID}`)
          }
        }
        if (tool === "edit" && msg.includes("oldString")) {
          const hint = similarLines(input.path ?? input.filePath, input.oldString)
          if (hint) {
            appendToError(ev, hint)
            log(`HINT-oldString ${tool} session=${ev.sessionID}`)
          }
        }
        // Grupa B: "No changes to apply" (oldString == newString) ma za każdym razem inne oldString, więc LOOP-STOP
        // (porównuje pełne wejście) go nie łapie — liczymy wg komunikatu. Hook before nie umie zablokować edit
        // (podmienia tylko code/command), a taki edit i tak nic nie zmienia, więc STOP doklejamy do błędu tutaj.
        if (tool === "edit" && msg.includes("No changes to apply")) {
          const sid = String(ev.sessionID)
          const n = (editErrors.get(sid) ?? 0) + 1
          if (editErrors.size > 500) editErrors.clear()
          editErrors.set(sid, n)
          if (n >= MAX_REPEAT) {
            const e = escalate(
              sid,
              `STOP: "No changes to apply" już ${n}× w tej sesji — oldString i newString są identyczne, więc edit nic nie zmieni. ` +
                `Zrób read pliku i w newString wpisz tekst PO zmianie. Jeśli plik już ma właściwą treść, zmiana jest zrobiona — nie edytuj dalej.`,
              msg,
            )
            appendToError(ev, "\n\n" + e.text)
            log(`LOOP-STOP-NOCHANGES edit n=${n} stop=${e.n} session=${sid}`)
          } else log(`NOCHANGES edit n=${n} session=${sid}`)
        }
        // znane rozwiązanie z kopalni — doklejone do błędu, raz na sesję dla danego wniosku
        const wn = findLesson(msg)
        if (wn) {
          const k = String(ev.sessionID) + "\u0000" + wn.file
          if (!reminded.has(k)) {
            if (reminded.size > 2000) reminded.clear()
            reminded.add(k)
            const hintText = lessonText(wn)
            const targets = appendToError(ev, hintText)
            log(`RECALL ${tool} [${wn.file}] → ${targets.join(",") || "NO TARGET"} session=${ev.sessionID}`)
          }
        }
      } catch (e) {
        log(`hook after failed: ${e}`)
      }
    })

    log("loaded")
  },
}


