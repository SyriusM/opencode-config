import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

// TOOL-INPUT-FIX — fixes typical input mistakes of local models BEFORE the tool runs
// and breaks loops of identical failing calls. Source: an audit of our own tool errors
// (most common: execute syntax and loops of the same call).
//
//   execute.code: fix ONLY when the original does not parse and the fix does:
//     - ogon `</code>`, `</parameter>`, `</function>`, `</tool_call>` (wyciek szablonu Qwen3.5)
//     - a `code:` prefix / a ```js … ``` fence
//     - `\"` outside strings (double-escaped quotes)
//   playwright_browser_click/hover/…: target `button[ref=f4e13]` → `f4e13`
//   playwright_browser_wait_for: time w ms (≥100) → sekundy
//   loop: the same call (tool + input) already failed 2× → a STOP error instead of running it
//
// Hook V2: ctx.tool.hook("execute.before"), change via `event.input = …` (as the built-in
// opencode 2.0.24 plugin does). We never throw from the hook. Log: ~/.mempalace/hook_state/tool_input_fix.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "tool_input_fix.log")
const MAX_REPEAT = 2
// from which STOP in a session the message says to end the turn without tools
const STOP_ESCALATE = 3
// home directory as a regex (no user name typed in): "home/user/…" and "/home/USER/…"
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const HOME_NOSLASH_RE = new RegExp("^" + escRe(HOME.slice(1)) + "/", "i")
const HOME_ABS_RE = new RegExp("^" + escRe(HOME) + "/", "i")

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

// full input next to the hint — the opencode DB already stores the replaced command, so the original
// (material for error→fix pairs) only survives here; one JSON object per line
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
    // parse only, no execution; an async function body = top-level await and return are OK
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
  // ```js … ``` parses as a tagged template, so we always strip the fence
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
  // `;\\n` between statements with correct strings (35B) — replace only after ; { } )
  if (!parses(c)) step("newline-between-statements", (s) => {
    const n = s.replace(/([;{})])\\n/g, "$1\n")
    return parses(n) ? n : s
  })
  // the whole code escaped one level too much (`\"`, `\\n`, `\\\\[` in regexes) → remove one level
  // unescape-level: JSON.parse on the whole block (works when there are no regexes with `\`)
  // escape-quotes: plain \`\"→"\` (fallback when unescape-level gave nothing or broke regexes)
  if (!parses(c)) {
    let u: string | undefined
    try {
      const j = JSON.parse('"' + c.replace(/\n/g, "\\n").replace(/(^|[^\\])"/g, '$1\\"') + '"')
      if (typeof j === "string" && j !== c) u = j
    } catch {}
    if (u !== undefined && !parses(u)) {
      // unescape returned something different from the original but it does not parse — try escape-quotes as fallback
      const e = u.replace(/\\"/g, '"')
      if (e !== u && parses(e)) { c = e; fixes.push("unescape-level→escape-quotes") }
    } else if (u !== undefined) { c = u; fixes.push("unescape-level") }
  }
  if (!parses(c)) step("escape-quotes", (s) => s.replace(/\\"/g, '"'))
  if (!parses(c)) return { code, fixes: [] } // we can't fix it — return the original
  return { code: c, fixes }
}

// name fixes in the code, regardless of parsing (result "Unknown tool")
// Note: MCP calls from inside `execute` are decoded by the schema BEFORE the hook — unknown keys
// (`ref`, `elements`, `selector`) are lost, and wrong types (`target:{ref}`) fail. These fixes must happen
// in the code text. Missing keys (`action`, `oldText`) are fixed by fixMcp in the hook.
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
  // the built-in webfetch does not exist in `execute`; MCP fetch has the same arguments (url, max_length, start_index, raw)
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
  // in Playwright `element` is a verbal description, not an identifier — replace only when the value looks like a ref (e13, f5e43)
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

// ── Cyrillic homoglyphs in paths ──────────────────────────────────────────────────────────────
// The model typed "ed-trade-ovelay" (U+0435 instead of U+0065 e) → ENOENT.
// We normalize ONLY the parts of command that look like paths (contain /).
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

// a snapshot ref in any disguise → a bare string `f4e13`
function asRef(v: unknown): string | undefined {
  if (v && typeof v === "object" && typeof (v as any).ref === "string") v = (v as any).ref
  if (typeof v !== "string") return undefined
  const m = v.match(REF)
  return m ? m[1] ?? m[2] : v
}

// browser tools: our playwright_browser_* and the built-in browser_browser_* (same schema)
const BROWSER = /^(playwright|browser)_browser_/
const TARGET_TOOLS = /_(click|type|hover|select_option|press_key|drag)$/
const FIELD_TYPES = ["textbox", "checkbox", "radio", "combobox", "slider"]

function fixMcp(tool: string, input: any): string[] {
  const fixes: string[] = []
  if (!input || typeof input !== "object") return fixes
  if (tool === "execute" && typeof input.code === "string") {
    const oldCode = input.code
    input.code = input.code.replace(/time:\s*(\d+)/g, (m, p1) => {
      const ms = parseInt(p1, 10)
      return ms >= 100 ? `time: ${Math.round(ms / 1000)}` : m
    })
    if (input.code !== oldCode) fixes.push("time-ms→s")
  }
  if (BROWSER.test(tool)) {
    // block browser_navigate with protocols Playwright does not support → ERR_ABORTED
    if (/_navigate$/.test(tool) && typeof input.url === "string") {
      if (/^(steam|file|data|chrome|about):\/\//i.test(input.url)) {
        input._block = true
        fixes.push("navigate-protocol-block")
      }
    }
    // browser_type without target/ref/element/selector — the model gives only text, cannot be fixed
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
        // "ref=f19e2" → "f19e2" (the model gives ref= as a prefix of the target value)
        const refMatch = input.target.match(/^ref=([a-z0-9]+)$/i)
        if (refMatch && refMatch[1] !== input.target) {
          input.target = refMatch[1]
          fixes.push("target-ref-prefix")
        } else {
          // "button[ref=f4e13]" → "f4e13" (the model adds the element type before [ref=...])
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
  // MCP filesystem does not expand `~` → "ENOENT … /home/user/<cwd>/~/…"
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
  // Cyrillic homoglyphs in paths (e.g. "ed-trade-ovelay" with U+0435)
  if (tool === "shell" && typeof input.command === "string") {
    const cleaned = normalizeCyrHomoGlyphs(input.command)
    if (cleaned !== input.command) {
      input.command = cleaned
      fixes.push("cyr-homoglyph→latin(command)")
    }
  }
  // filePath: read/write/edit — fix ONLY when the original does not exist and the normalized version does
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

// ── HINTS AT THE MOMENT OF THE ERROR ──────────────────────────────────────────────────────────────
// Semantic errors: the syntax is right, but the model uses something this environment does not have (Node in `execute`,
// sudo, apt, writing to /etc…). Instead of letting an unclear error happen, we skip the call and return ONE sentence
// with a ready correct example (small models repeat what they see — hence an example, not just a ban).
// Each hint at most 2× per session; after that the call runs normally. Patterns from the opencode error DB (10-2026).
type Hint = { name: string; re: RegExp; text: string; always?: boolean }

// strips strings and comments so that e.g. `document.title` inside browser_evaluate is not a false hit
function stripLiterals(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""')
}

const HINTS_EXECUTE: Hint[] = [
  // built-in tools are separate calls, not `tools.*` in execute — Gemma 4 (10-22) called tools.shell/tools.read
  // over and over (search cannot find them, so the model kept guessing); blocked without a limit, since such a call fails anyway
  { name: "native-tool-in-execute", always: true,
    re: /(?<![\w.])tools\.(shell|bash|read|edit|write|grep|glob|list|skill|question|subagent|task|todowrite|webfetch)\s*(?:\.\s*\w+\s*)?\(/,
    text: 'shell, read, edit, write, grep and skill are NOT available in execute (tools.shell / tools.read do not exist and search will not find them). They are separate tools: instead of execute, call the shell tool directly with the argument command: "ls /home/user/dir", and read a file with the read tool and filePath. Only tools.playwright.*, tools.fetch.*, tools.mempalace.* and others from search stay in execute.' },
  { name: "python-in-execute", re: /^\s*(def \w+\(|import (\w+(\s+as\s+\w+)?)(\s*,\s*(\w+(\s+as\s+(\w))?))*\s*$|from [\w.]+ import |print\s*\()/m,
    text: 'execute understands only JavaScript. Printing: console.log("text"). Run Python with the shell tool: python3 -c "print(1)".' },
  { name: "python-import", re: /^\s*import\s+(?:\w+[\s\S]*?\s+from\s+|[{*])/m,
    text: 'This is JavaScript (ES modules), not Python. In execute: const fs = await import("fs"); or read the file with the separate read tool (filePath), not from execute.' },
  { name: "require-import", re: /\brequire\s*\(|\bawait\s+import\s*\(/,
    text: 'There is no Node in execute (no require/import). A file: the separate read tool (filePath). System commands: the separate shell tool.' },
  { name: "timer", re: /\b(setTimeout|setInterval|setImmediate)\s*\(/,
    text: 'There are no timers in execute. Waiting: await tools.playwright.browser_wait_for({time: 2}) (seconds), outside the browser the shell tool: sleep 2.' },
  { name: "page-playwright", re: /(^|[^.\w])(page|browser|context)\.(title|goto|click|fill|type|evaluate|locator|url|content|waitFor\w*|newPage|close|screenshot)\s*\(/,
    text: 'There is no page/browser object. Use: await tools.playwright.browser_navigate({url: "https://example.com"}); const s = await tools.playwright.browser_snapshot(); console.log(s) — the title and address are in the snapshot ("Page Title", "Page URL").' },
  { name: "fs-process", re: /(^|[^.\w])(fs|process|child_process|os)\.\w+\s*\(/,
    text: 'There is no fs/process in execute. Files: the separate read tool (filePath); commands: the shell tool.' },
  { name: "websearch-in-execute", re: /\btools\.websearch\./,
    text: 'websearch is disabled. Search in the browser: await tools.playwright.browser_navigate({url: "https://duckduckgo.com/?q=WORDS+WITH+PLUSES"}); const r = await tools.playwright.browser_evaluate({function: "() => [...document.querySelectorAll(\'a[data-testid=result-title-a]\')].map(a => a.href + \' | \' + a.innerText).slice(0, 10).join(\'\\\\n\')"}); console.log(r)' },
]

// After "Could not find oldString": show what the first non-empty line of oldString really looks like in the file
// (compared without surrounding whitespace, because indentation is what usually breaks). Cheap: one pass over the file.
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
  if (i < 0) return `HINT: the line "${needle.slice(0, 120)}" is not in the file even ignoring indentation — read the file with the read tool and copy the fragment exactly.`
  const n = oldString.split("\n").length
  const fragment = lines.slice(i, i + Math.min(n, 8)).join("\n")
  return `HINT: in the file (line ${i + 1}) this fragment looks exactly like this — copy it with this indentation as oldString:\n${fragment.slice(0, 1500)}` +
    (invisibleWsNote(fragment.slice(0, 1500), i + 1) ?? "")
}

// 11-21 (db 10-20..11-21): after the exact-fragment HINT models still failed when the fragment had characters
// they cannot see — TAB after spaces in indentation, trailing spaces/TABs, NBSP (task 30, Qwen/Laguna/Bonsai:
// "4 spaces + TAB" retyped as "5 spaces + TAB", NBSP dropped). Name them line by line.
const SPECIAL_SPACES: Record<string, string> = {
  " ": "NBSP (U+00A0)", " ": "narrow NBSP (U+202F)", " ": "thin space (U+2009)",
  "​": "zero-width space (U+200B)", "　": "ideographic space (U+3000)", "﻿": "BOM (U+FEFF)",
}
const wsRuns = (s: string): string => {
  const parts: string[] = []
  for (const m of s.matchAll(/( +|\t+)/g)) {
    const k = m[0].length, tab = m[0][0] === "\t"
    parts.push(`${k} ${tab ? (k > 1 ? "TABs" : "TAB") : k > 1 ? "spaces" : "space"}`)
  }
  return parts.join(" + ")
}
export const invisibleWsNote = (fragment: string, firstLine: number): string | undefined => {
  const notes: string[] = []
  fragment.split("\n").forEach((l, k) => {
    const what: string[] = []
    const indent = l.match(/^[ \t]*/)![0]
    if (indent.includes(" ") && indent.includes("\t")) what.push(`indentation = ${wsRuns(indent)}`)
    const trail = l.trim() ? l.match(/[ \t]+$/)?.[0] : undefined
    if (trail) what.push(`ends with ${wsRuns(trail)}`)
    for (const [ch, name] of Object.entries(SPECIAL_SPACES)) {
      const at = l.indexOf(ch)
      if (at >= 0) what.push(`${name} after "${l.slice(0, at).trimStart().split(/[ \t]+/).slice(-3).join(" ")}"`)
    }
    if (what.length) notes.push(`- line ${firstLine + k}: ${what.join("; ")}`)
  })
  if (!notes.length) return
  return `\nINVISIBLE CHARACTERS in this fragment (copy them exactly — or make oldString shorter so it does not ` +
    `start or end on these spots):\n${notes.slice(0, 8).join("\n")}`
}

// After "Found N matches": showing just the line (similarLines) made the model copy the same non-unique fragment
// (10-28 Gemma, task 27: the same error 3× → STOP). For each spot give the nearest line above that is
// only once in the file (e.g. `def check_delta(resp):`) — from it down to the changed line oldString is unique.
export const multiMatchHint = (path: unknown, oldString: unknown): string | undefined => {
  if (typeof path !== "string" || typeof oldString !== "string" || !oldString.trim()) return
  let src: string
  try {
    src = readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8")
  } catch {
    return
  }
  if (src.length > 500_000) return
  const lines = src.split("\n")
  const count = new Map<string, number>()
  for (const l of lines) count.set(l, (count.get(l) ?? 0) + 1)
  const n = oldString.split("\n").length
  const spots: string[] = []
  for (let at = src.indexOf(oldString); at >= 0 && spots.length < 6; at = src.indexOf(oldString, at + 1)) {
    const i = src.slice(0, at).split("\n").length - 1
    let j = i - 1
    while (j >= 0 && j >= i - 12 && (count.get(lines[j]) !== 1 || !lines[j].trim())) j--
    if (j < 0 || j < i - 12) continue
    spots.push(`- linia ${i + 1}:\n${lines.slice(j, i + n).join("\n").slice(0, 600)}`)
  }
  if (!spots.length) return
  return `HINT: this oldString occurs in the file several times. Add the lines above to oldString, up to one ` +
    `that occurs in the file only once — pick the spot you need to change and copy its whole fragment:\n${spots.join("\n")}\n` +
    `Do NOT use replaceAll if the change concerns only some of these spots — change each with a separate edit.`
}

// After "Could not find oldString" in a file the model has not read in this session (15% of errors in 30 days: never-read)
// or read only partly with offset/limit (9%): say so plainly before it tries again from memory.
const normPath = (p: unknown) => (typeof p === "string" && p ? resolve(p.replace(/^~(?=\/)/, homedir())) : "")
const unreadFileHint = (path: string, readState: "never" | "partial") =>
  readState === "never"
    ? `NOTE: you have not read the file ${path} in this session — oldString comes from memory or a guess. ` +
      `FIRST call read on this file, then copy oldString verbatim from the result (without the "N: " line numbers).`
    : `NOTE: you read the file ${path} only in parts (offset/limit) — the place you are changing may be outside them. ` +
      `read the area you are changing and copy oldString verbatim from the result (without the "N: " line numbers).`

// Group C (11-04 self-repair: the oldString HINT arrived, the model still repeated oldString from memory):
// from the 2nd "Could not find oldString" in THE SAME file without a read in between — a hard note "next call = read".
// The counter is reset by a successful read/write/edit of that file. Edit cannot be blocked in before (see deliver), hence a note.
export const oldStringRepeatNote = (n: number, path: string): string | undefined =>
  n < 2
    ? undefined
    : `\nSTOP: this is failed edit no. ${n} of the file ${path} ("Could not find oldString") without reading it in between. ` +
      `Your memory of this file's content is OUTDATED. The next call MUST be read on ${path} (the whole file or the area of the change). ` +
      `Only then edit with oldString copied verbatim from the read result (without the "N: " line numbers). ` +
      `If the change is large — write the whole file after read.`

// a glob (*?[) is treated as an existing path — the model is checking, not guessing
const pathExists = (p: string) => {
  if (/[*?[]/.test(p)) return true
  try {
    return existsSync(p.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "") || "/")
  } catch {
    return false
  }
}

// find the nearest existing path (for the "did you mean…" hint)
// 1) go up until an existing directory is found
// 2) in it look for the nearest name (homoglyph + similarity)
const nearestPath = (path: string): string | null => {
  try {
    const abs = path.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "")
    const parts = abs.split("/").filter(Boolean)
    let foundParent = false
    // find the first missing segment (go from the bottom, stop at the first existing parent)
    for (let i = parts.length - 1; i >= 0; i--) {
      const parent = "/" + parts.slice(0, i).join("/")
      const child = parts[i]
      if (!pathExists(parent)) continue
      foundParent = true
      // the parent exists — look for the nearest child
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
      // 2) nearest by edit distance with a threshold
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
      // after processing the first existing parent — done (no further climbing)
      break
    }
    return null
  } catch {
    return null
  }
}

// a command that changes files + "no such file" = the model should report it missing, not look for a substitute
const MUTATING_CMD = /(^|[;&|(]\s*)(sudo\s+)?((rm|rmdir|unlink|shred|truncate|mv|cp|ln|chmod|chown|touch)\s|sed\s+(-\w*\s+)*-i)/m
const MISSING_FILE = /No such file or directory|Nie ma takiego pliku/i
export function isMissingTarget(cmd: string, msg: string): boolean {
  return MUTATING_CMD.test(cmd) && MISSING_FILE.test(msg)
}
// && chain + empty output + exit code ≠ 0/1/124 = a silent failure (e.g. missing file or 2>/dev/null);
// exception exit 3 + systemctl = a normal "inactive" (not a silent failure)
export function isSilentChainFailure(cmd: string, exit: unknown, msg: string): boolean {
  const bare = msg.replace(/\(no output\)/g, "").replace(/Exited with code -?\d+/g, "").trim()
  return !bare
    && typeof exit === "number"
    && exit !== 0 && exit !== 1 && exit !== 124
    && / && /.test(cmd)
    && !(exit === 3 && /systemctl/.test(cmd))
}
// Bash syntax error (unclosed quote, loop without done) = the command did not run at all.
// 10-24 Bonsai 5× on long one-liners with nested quotes and heredocs.
// Polish and English locale variants of the bash messages (the tool output follows the system locale)
const SHELL_SYNTAX = /nieoczekiwany EOF podczas poszukiwania pasującego|niespodziewany koniec pliku|unexpected EOF while looking for matching|syntax error: unexpected end of file/i
export function isShellSyntaxError(tool: string, msg: string): boolean {
  return (tool === "shell" || tool === "bash") && SHELL_SYNTAX.test(msg)
}
const SHELL_SYNTAX_NOTE =
  "HINT: shell syntax error (unclosed quote or loop) — the command was NOT run, nothing changed. " +
  "Do not fix the quotes in the same long line. Write the commands with the write tool to ~/tmp-opencode/NAME.sh " +
  "(one command per line, Python code in a separate .py file) and run: bash ~/tmp-opencode/NAME.sh"

const MISSING_TARGET_NOTE =
  "HINT: the file or directory in this command does NOT exist. When deleting, moving or changing files do NOT look for a substitute " +
  "(the same file in another directory, a similar name) and do not perform this operation on any file other than the one the user named. " +
  "Tell the user plainly that the path does not exist (give it), and optionally list similar files you see — without touching them."

const HINTS_SHELL: Hint[] = [
  { name: "js-in-shell", re: /^\s*(await\s+)?tools\.\w+\.\w+/,
    text: 'This is JavaScript, and shell is a shell. Run tools.* calls with the execute tool, e.g. code: const r = await tools.playwright.browser_navigate({url: "https://example.com"}); console.log(r)' },
  { name: "guessed-path", re: /\bls\b(\s+-[a-zA-Z]*)?\s+["']?(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' },
  { name: "guessed-path", re: /\b(cat|head|tail|less|more)\b(\s+-\S+)*\s+(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' },
  { name: "ls-no-access", re: /\bls:\s*nie ma dostępu|File not found|Nie ma takiego pliku/i,
    text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' },
  { name: "guessed-path", re: /\bfind\b(\s+-\S+)*\s+(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)/,
    text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' },
  { name: "sudo", re: /(^|[;&|]\s*)sudo\b/,
    text: 'sudo is blocked in the tools. Prepare the file in the home directory and give the user ONE command to run, e.g.: sudo cp ~/tmp-opencode/file /etc/file' },
  { name: "killing-services", re: /\b(pkill|killall)\b[^|;&>]*[\s'"](opencode|llama|brave|playwright)/,
    text: 'Do not kill opencode, the models or the browser — that interrupts this session or the user\'s work. Check the state: pgrep -x llama-server; systemctl --user list-units "llama*". Suggest a stop or restart to the user.' },
  ...(existsSync("/usr/bin/pacman") ? [  { name: "apt", re: /\b(apt|apt-get)\s+(install|update|upgrade|remove)\b/,
    text: 'This is Arch (CachyOS), there is no apt. Check a package: pacman -Ss NAME or pacman -Qi NAME. Give the install (sudo pacman -S NAME) to the user to run.' }] : []),
  { name: "write-to-system", re: />>?\s*\/(etc|usr|boot)\/|\btee\s+(-a\s+)?\/(etc|usr|boot)\/|\bsed\s+-i[^|;&]*\s\/(etc|usr|boot)\/|\b(cp|mv|install)\s[^|;&]*\s\/(etc|usr|boot)\/\S*\s*($|[;&|])/,
    text: '/etc, /usr and /boot cannot be written without root. Save the file in ~/tmp-opencode/, show it and give the user ONE command: sudo cp ~/tmp-opencode/file /etc/file' },
  { name: "kbuildsycoca", re: /\bkbuildsyscaches?6?\b/,
    text: 'The command is called kbuildsycoca6: kbuildsycoca6 --noincremental' },
  { name: "guessed-path", re: /\b(cp|mv|install)\b[^|;&]*\s(\/home\/\w+(?:\/[^"'\s]*)?|~\/[^"'\s]*)\s[^|;&]*/,
    text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' },
]

// SUSPECT_HOME: a first-level segment (e.g. ~/Projekt, /home/user/Pobran) that the model
// confuses with an existing one. We block only when the segment itself does not exist (an existing directory
// = checking existence, not guessing — e.g. ~/Pobrane/missing.txt with an existing ~/Pobrane).
// (?:e|a)? + boundary (?![A-Za-z]): Projekt/Pobran/Pobrane/Pobrania, but not ProjektX.
const SUSPECT_HOME = /^(~|\/home\/[A-Za-z0-9_-]+)\/(Projekt|Projekti|Pojekty|Pulpit|Downloads|Desktop|Pobran)(?:e|a)?(?![A-Za-z])/i

// REPAIR MODE (a session where the model loaded the `self-repair` skill (formerly `autodiag`) or uses lesson-note / agent-rule / a plugin test):
// the user's personal memory (MCP server `mempalace` = ~/.mempalace) is then READ-ONLY. Lessons from repairs go
// to a separate palace via ~/bin/lesson-note. Outside repair mode the model has full access as before.
// These hints have no repeat limit — this is a block, not a hint.
const HINTS_REPAIR_EXECUTE: Hint[] = [
  { name: "repair-memory-write", re: /\btools\.mempalace\.mempalace_(add_drawer|delete_drawer|kg_add|kg_invalidate|diary_write)\b/,
    text: 'Repair mode is on: the user\'s memory is read-only now (mempalace_search is allowed). Save the lesson from the repair with the shell tool: ~/bin/lesson-note add "SYMPTOM: error message" "CAUSE" "FIX" "EXAMPLE of a correct call"' },
]
const HINTS_REPAIR_SHELL: Hint[] = [
  { name: "repair-mempalace-cli", re: /(^|[;&|]\s*)mempalace\s+(mine|init|split|compress|repair)\b/,
    text: 'Repair mode is on: do not change the user\'s palace with the mempalace command. Known fixes: ~/bin/lesson-note search "message"; a new lesson: ~/bin/lesson-note add "SYMPTOM" "CAUSE" "FIX"' },
]

// does this call turn on repair mode for the session
function enablesRepair(tool: string, input: any): boolean {
  try {
    if (!input || typeof input !== "object") return false
    if (tool === "skill") return /^(self-repair|autodiag)$/i.test(String(input.id ?? input.name ?? input.skill ?? ""))
    if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string")
      return /\b(oc-wniosek|lesson-note|oc-regula|agent-rule|test-wtyczki\.sh|test-plugin\.sh|powtorka-historii\.sh|history-replay\.sh)\b/.test(input.command)
  } catch {}
  return false
}

// ── PODOBNE NAZWY (od 2026-11-12) ────────────────────────────────────────────────────────────────
// The model garbles identifiers when retyping them (TtsEngine→TssEngine, Bonsai 27B / Qwen 35B, KV q4_0).
// write/edit: a CamelCase name from the new content that is not in the project, while a name 1 char away is → "did you mean".
// shell sed s/X/…/: X does not occur in the project but a similar name does → do not replace (the model "fixes" correct places).
const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b/g
const CODE_EXT = /\.(kt|kts|java|ts|tsx|js|mjs|py|rs|go|c|h|cpp|hpp|cs|swift|xml|gradle|json|toml|ya?ml|sh|lua)$/i
const identCache = new Map<string, { time: number; counts: Map<string, number> }>()
export function projectRoot(fp: string): string | undefined {
  let d = resolve(fp.replace(/^~(?=\/)/, HOME))
  for (let i = 0; i < 12 && d.length > HOME.length; i++) {
    const up = resolve(d, "..")
    if (existsSync(join(d, ".git")) || existsSync(join(d, "settings.gradle.kts")) || existsSync(join(d, "package.json"))) return d
    if (up === d) break
    d = up
  }
  // no repo: just the file's directory (e.g. ~/oc-audyt, ~/bin), but not the home directory and not /tmp
  const dir = resolve(fp.replace(/^~(?=\/)/, HOME), existsSync(fp) && !/\.[A-Za-z0-9]+$/.test(fp) ? "." : "..")
  return dir.startsWith(HOME + "/") ? dir : undefined
}
export function projectIdents(root: string): Map<string, number> {
  const c = identCache.get(root)
  if (c && Date.now() - c.time < 30_000) return c.counts
  const counts = new Map<string, number>()
  let files = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || files > 3000) return
    let ents: any[] = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.name.startsWith(".") || /^(node_modules|build|dist|target|out|venv|\.gradle|jniLibs|assets)$/.test(e.name)) continue
      const f = join(dir, e.name)
      if (e.isDirectory()) walk(f, depth + 1)
      else if (CODE_EXT.test(e.name) && files++ < 3000) {
        for (const id of [basename(e.name).replace(/\.[^.]+$/, "")]) counts.set(id, (counts.get(id) ?? 0) + 1)
        try {
          const t = readFileSync(f, "utf8")
          if (t.length > 400_000) continue
          for (const id of t.match(IDENT_RE) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
        } catch {}
      }
    }
  }
  walk(root, 0)
  if (identCache.size > 20) identCache.clear()
  identCache.set(root, { time: Date.now(), counts })
  return counts
}
// edit distance ≤ 1 (substitution, insertion, deletion or swap of adjacent characters)
export function within1(a: string, b: string): boolean {
  if (a === b) return false
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i++
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}
export function nearMisses(text: string, counts: Map<string, number>, max = 3): { bad: string; good: string; n: number }[] {
  const out: { bad: string; good: string; n: number }[] = []
  const seenIds = new Set<string>()
  for (const id of text.match(IDENT_RE) ?? []) {
    // UPPER_CASE_CONSTANTS (PASSED/PAUSED) are usually words, not garbled names
    if (id.length < 6 || seenIds.has(id) || counts.has(id) || !/[a-z]/.test(id)) continue
    seenIds.add(id)
    let best: { good: string; n: number } | undefined
    for (const [k, n] of counts) {
      if (n < 2 || k.length < 6 || !within1(id, k)) continue
      // a plural / a character added at the end is usually a new name, not a typo
      if (k + "s" === id || id + "s" === k) continue
      if (!best || n > best.n) best = { good: k, n }
    }
    if (best) out.push({ bad: id, ...best })
    if (out.length >= max) break
  }
  return out
}
export function similarNameHint(tool: string, input: any): { name: string; text: string } | undefined {
  if (!input || typeof input !== "object") return undefined
  if (tool === "write" || tool === "edit") {
    const fp = input.filePath ?? input.path
    const text = tool === "write" ? input.content : (input.newString ?? input.new_string)
    if (typeof fp !== "string" || typeof text !== "string" || !CODE_EXT.test(fp)) return undefined
    const root = projectRoot(fp)
    if (!root) return undefined
    const old = tool === "edit" ? String(input.oldString ?? input.old_string ?? "") : ""
    const miss = nearMisses(text, projectIdents(root)).filter(m => !old.includes(m.bad))
    if (!miss.length) return undefined
    return { name: "similar-name", text: "the new content has names that do NOT exist in the project, while a very similar one does: " +
      miss.map(m => `${m.bad} → did you mean ${m.good} (${m.n}× in the project)?`).join("; ") +
      ". Do not retype the name from memory: copy it from grep -rn output and fix the file." }
  }
  if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
    const cmd: string = input.command
    const m = /\bsed\b[^|;&]*?['"]s(.)([A-Za-z_][A-Za-z0-9_]{5,})\1/.exec(cmd)
    if (!m) return undefined
    const dirM = /(?:^|[;&]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd)
    const base = typeof input.workdir === "string" ? input.workdir : dirM ? dirM[1].replace(/^["']|["']$/g, "") : ""
    const root = base && (HOME_ABS_RE.test(base) || base.startsWith("~/")) ? projectRoot(base) : undefined
    if (!root) return undefined
    const counts = projectIdents(root)
    if (counts.has(m[2])) return undefined
    const miss = nearMisses(m[2], counts, 1)
    if (!miss.length) return undefined
    return { name: "similar-name", text: `sed is to replace ${m[2]}, but that name does NOT exist in the project files. There is ${miss[0].good} (${miss[0].n}×) — probably correct, and only you see a difference. Check: grep -rn "${miss[0].good}" . | head. Do not replace anything until grep shows the wrong name really exists.` }
  }
  return undefined
}

function findHint(tool: string, input: any, repairMode = false): { name: string; text: string; always?: boolean } | undefined {
  try {
    if (!input || typeof input !== "object") return undefined
    // read/edit with filePath — check existence + nearest path (absolute ONLY)
    // edit with an empty oldString: opencode itself answers "Use write to create…" — we don't hide that
    const emptyEdit = tool === "edit" && (input.oldString === "" || input.old_string === "")
    let fp = (tool === "read" || (tool === "edit" && !emptyEdit)) ? (input.filePath ?? input.path) : null
    // "home/USER/…" without the leading "/" — the model lost the slash; treat it as an absolute path
    if (typeof fp === "string" && HOME_NOSLASH_RE.test(fp) && !pathExists(fp)) fp = "/" + fp
    // letter case in the home directory name (/home/USER with different case) — fix it right away so nearestPath can fix one more segment
    if (typeof fp === "string" && HOME_ABS_RE.test(fp) && !fp.startsWith(HOME + "/")) fp = HOME + "/" + fp.slice(HOME.length + 1)
    if (typeof fp === "string" && (HOME_ABS_RE.test(fp) || fp.startsWith("~/"))) {
      if (!pathExists(fp) || fp !== (input.filePath ?? input.path)) {
        const suggested = pathExists(fp) ? fp : nearestPath(fp)
        if (suggested) {
          return { name: "guessed-path", text: `Did you mean ${suggested}?` }
        }
        return { name: "guessed-path", text: 'You are guessing paths (Projekt/Projekti/Pobrane/Pulpit) instead of checking with ls. Check first: ls ~/Projekt* or ls ~/Pobran* and use the correct path.' }
      }
    }
    const sim = similarNameHint(tool, input)
    if (sim) return sim
    if (repairMode) {
      if (tool === "execute" && typeof input.code === "string") {
        for (const w of HINTS_REPAIR_EXECUTE) if (w.re.test(input.code)) return { name: w.name, text: w.text, always: true }
      } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
        for (const w of HINTS_REPAIR_SHELL) if (w.re.test(stripLiterals(input.command))) return { name: w.name, text: w.text, always: true }
      }
    }
    if (tool === "execute" && typeof input.code === "string") {
      const goly = stripLiterals(input.code)
      for (const w of HINTS_EXECUTE) if (w.re.test(goly)) return { name: w.name, text: w.text, always: w.always }
    } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
      const goly = stripLiterals(input.command)
      // the name of the killed process is sometimes quoted (pkill -f 'opencode serve'), so this rule is checked on the full command
      for (const w of HINTS_SHELL) {
        const m = w.re.exec(w.name === "killing-services" || w.name.startsWith("guessed-path") ? input.command : goly)
        if (!m) continue
        // ls/cat/etc on an existing path is not guessing (false alarm from 10-17)
        if (w.name === "guessed-path") {
          // path = the last group starting with / or ~ (m[2] is sometimes a flag, e.g. " -n" in cat -n)
          const sc = [m[3], m[2]].find(g => typeof g === "string" && /^["']?[\/~]/.test(g))
          if (!sc || pathExists(sc)) continue
          // block only when a SUSPECT segment is missing; an existing directory = checking, not guessing
          const sm = SUSPECT_HOME.exec(sc)
          if (!sm || pathExists(sm[0])) continue
          const suggested = nearestPath(sc)
          return { name: w.name, text: suggested ? `Did you mean ${suggested}?` : w.text }
        }
        return { name: w.name, text: w.text }
      }
    }
  } catch (e) { if (process.env.TIF_STRICT === "1") throw e }
  return undefined
}

// ── KNOWN FIXES ON ERROR (auto-recall from the lesson mine) ───────────────────────────────────────
// When a tool returns an error, we look in ~/oc-audyt/kopalnia/*.md for a lesson whose SYMPTOM matches the message,
// and append its FIX and EXAMPLE to the error result. The model gets the solution without calling lesson-note.
// Lexical matching (no embeddings, fast, deterministic). The same lesson at most once per session.
type Lesson = { file: string; symptom: string; cause: string; fix: string; example: string; words: string[] }
const LESSONS_DIR = join(HOME, "oc-audyt", "kopalnia")
const COMMON_WORDS = new Set("nie jest jak przy albo oraz dla tego ten that the and model modelu narzedzie narzedzia blad bledu error przez jako tylko gdy kiedy sie nad pod bez ale czy jego jej ich to na do od po za ze co with from for into this tool tools call".split(" "))
// words present in almost every error message — on their own they don't show it is the same problem
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
      // English field names; the Polish ones are still read from older lesson files
      const field = (n: string) => (t.match(new RegExp("^(?:" + n + "): (.*)$", "m")) ?? [])[1] ?? ""
      const symptomText = field("SYMPTOM|OBJAW")
      if (!symptomText) continue
      lessonList.push({ file: f, symptom: symptomText, cause: field("CAUSE|PRZYCZYNA"), fix: field("FIX|NAPRAWA"), example: field("EXAMPLE|PRZYKŁAD"), words: wordsOf(symptomText) })
    }
  } catch {}
  lessonsCache = { time: nowMs, list: lessonList }
  return lessonList
}

// best lesson for an error message: ≥3 shared words and (≥25% of the SYMPTOM or ≥50% of the message); 2 words only for a short, matching message
function findLesson(errMessage: string, lessonList: Lesson[] = lessons()): Lesson | undefined {
  const m = new Set(wordsOf(errMessage))
  let best: Lesson | undefined, bestScore = 0
  for (const w of lessonList) {
    if (!w.words.length) continue
    const hits = w.words.filter((x) => m.has(x)).length
    const distinctive = w.words.filter((x) => m.has(x) && !GENERIC_WORDS.has(x)).length
    if (distinctive < 2) continue
    const share = hits / w.words.length // how much of the SYMPTOM the message covers
    const coverage = m.size ? hits / m.size : 0 // how much of the message the SYMPTOM covers
    const ok = hits >= 3 ? share >= 0.3 || coverage >= 0.5 : hits === 2 && coverage >= 0.4 && share >= 0.3
    if (ok && hits + share > bestScore) { best = w; bestScore = hits + share }
  }
  return best
}

// what the model should see: the cause and a ready correct call (FIX usually describes plugin internals — only when there is no example)
function lessonText(wn: Lesson): string {
  const co = wn.example ? `do this: ${wn.example}` : wn.fix
  return `\n\nKNOWN FIX: ${wn.cause ? wn.cause + " — " : ""}${co}`
}

// appends text to an error result — tries every place where opencode keeps the message; returns what was changed
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

// map: lesson field names (Polish legacy → English) for tests and developers

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
    // sessionID → (call key → {error count, last error})
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

    // sessionID → the last SUCCESSFUL call and how many times in a row it repeated (a loop without errors)
    const lastOk = new Map<string, { key: string; n: number }>()
    // sessionID → number of repeats of the same edit error (for "No changes to apply")
    const editErrors = new Map<string, number>()
    // sessionID → how many times STOP fired in the session; a small model can ignore it dozens of times (night 10-20: 48× the same cp),
    // so from STOP_ESCALATE on the message changes and tells it to end the turn without tools
    const stopCounts = new Map<string, number>()
    const escalate = (sid: string, base: string, err: string) => {
      const n = (stopCounts.get(sid) ?? 0) + 1
      if (stopCounts.size > 500) stopCounts.clear()
      stopCounts.set(sid, n)
      if (n < STOP_ESCALATE) return { n, text: base }
      return {
        n,
        text:
          `NO MORE ATTEMPTS (STOP no. ${n} in this session — you ignored the previous ones). Tools will not fix this. ` +
          `Do NOT call any more tools. Write your reply to the user now: what you tried, ` +
          (err ? `what error you got (verbatim: ${err.slice(0, 160)}), ` : "") +
          `and what you need to move on.`,
      }
    }

    // The before hook can block only execute (replacing code) and shell (replacing command). For read/edit/write etc.
    // the call runs anyway, so the text (hint, STOP) waits here and the after hook appends it to the result
    // (10-20: 88 "Did you mean…" hints for read never reached the model).
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

    // sessionID → (file → "full" | "partial"): what the model has seen in this session (read, write, successful edit, cat/sed in shell)
    const seen = new Map<string, Map<string, "full" | "partial">>()
    // sessionID → (plik → liczba „Could not find oldString” od ostatniego udanego read/write/edit tego pliku)
    const oldStringFails = new Map<string, Map<string, number>>()
    // a session created after the plugin loaded = we know its whole history, so the first event counts too
    // (10-20: edit as the first call of a session got no hint). opencode ID "ses_" + 12 hex = ~(ms*4096+counter) mod 2^48
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

    // how many times a given hint appeared in the session
    const shown = new Map<string, number>()
    // sessions in repair mode (user memory read-only)
    const repairMode = new Set<string>()
    // lessons already appended in a given session
    const reminded = new Set<string>()

    await ctx.tool.hook("execute.before", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        let input = ev.input
        let fixes: string[] = []
        // tools.filesystem.read_file("/path") → {path}
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
        }
        // Always run fixMcp to catch nested issues (e.g., playwright in execute)
        const copy = { ...input }
        const f = fixMcp(tool, copy)
        if (f.length) {
          input = copy
          fixes.push(...f)
        }
        if (fixes.length) {
          ev.input = input
          log(`FIX ${tool} [${fixes.join(",")}] session=${ev.sessionID}`)
        }

        // block: browser_navigate with a non-standard protocol or browser_type without a target
        if (input && typeof input === "object" && input._block === true) {
          let stopMsg: string
          if (/_navigate$/.test(tool)) {
            stopMsg = `browser_navigate does not support the protocol ${JSON.stringify(input.url?.slice(0, 40))}. Playwright accepts only http/https. Use shell: xdg-open "${input.url}" or the read tool for local files.`
          } else if (/_type$/.test(tool)) {
            stopMsg = "browser_type needs a target (the element to type into). First do browser_snapshot(), take the ref from [ref=xxx] and pass: target: \"xxx\". Or use browser_fill_form to fill forms."
          } else {
            stopMsg = "Call blocked — does not match the schema."
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
        // hint instead of running (at most 2× the same per session; repair-mode blocks without a limit)
        const w = findHint(tool, input, repairMode.has(sidN))
        if (w) {
          const callKey = String(ev.sessionID) + "\u0000" + w.name
          const shownCount = (shown.get(callKey) ?? 0) + 1
          if (shown.size > 2000) shown.clear()
          shown.set(callKey, shownCount)
          if (shownCount <= 2 || w.always) {
            // read/edit etc. run despite the hint (deliver appends it to the result), so only there without "not run"
            const blockable = tool === "execute" || (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string")
            const hintText = (blockable ? "HINT (the call was not run): " : "HINT: ") + w.text
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
            `STOP: the identical ${tool} call has already failed ${prev.n}× with the error: ${prev.msg.slice(0, 200)}. ` +
              `Retrying gives the same result. Change the code/arguments or the approach (e.g. webfetch), and if you don't know how — tell the user.`,
            prev.msg,
          )
          deliver(ev, tool, input, e.text, "stop")
          log(`LOOP-STOP ${tool} n=${prev.n} stop=${e.n} fixes=[${fixes.join(",")}] error="${prev.msg.slice(0, 150)}" session=${ev.sessionID}`)
        }

        const lastText = lastOk.get(String(ev.sessionID))
        if (lastText && lastText.key === keyOf(tool, input) && lastText.n >= MAX_REPEAT) {
          const e = escalate(
            String(ev.sessionID),
            `STOP: you have already run the same ${tool} call ${lastText.n}× in a row and the result is above in the conversation. ` +
              `Retrying changes nothing. Use that result and take the next step, or tell the user what is missing.`,
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
        // the result of our own STOP does not change the counters — otherwise it would reset the loop we are braking
        const blocked = String(ev.input?.command ?? ev.input?.code ?? "")
        if (/^(echo|throw new Error\()\s*"(STOP:|NO MORE ATTEMPTS)/.test(blocked)) return
        // text from the before hook for a tool that could not be blocked — append it to the result (error or success)
        const pk = pendingKey(String(ev.sessionID), tool, ev.input ?? {})
        const queued = pending.get(pk)
        if (queued !== undefined) {
          pending.delete(pk)
          const targets = appendToError(ev, "\n\n" + queued)
          log(`DELIVERED ${tool} → ${targets.join(",") || "NO TARGET"} session=${ev.sessionID}`)
        }
        const res = ev.result as any
        // record "what the model has seen" — before the early return for successful calls; the first event of a session
        // only creates the map (after a plugin reload mid-session we don't know what happened earlier)
        const inSession = seen.has(String(ev.sessionID)) || sessionAfterStart(String(ev.sessionID))
        const m = seenFor(String(ev.sessionID))
        const okRes = ev.status !== "error" && res?.metadata?.error !== true
        if (/^(read|write|edit)$/.test(tool)) {
          const fp = normPath(ev.input?.filePath ?? ev.input?.path)
          if (fp && okRes) oldStringFails.get(String(ev.sessionID))?.delete(fp)
          if (fp && okRes) {
            const partial = tool === "read" && (ev.input?.offset || ev.input?.limit)
            if (!partial) m.set(fp, "full")
            else if (!m.has(fp)) m.set(fp, "partial")
          }
        } else if (typeof ev.input?.command === "string" && /\b(cat|sed|head|tail|less|bat|nl|awk|grep|rg)\b/.test(ev.input.command)) {
          // cat/sed in shell also shows the content — remember the file names from the command (cwd unknown → basename)
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
        // grep/rg/diff/test with exit 1 and no output = "nothing found", not an error — not counted for loops
        const cmd = typeof input.command === "string" ? input.command.trim() : ""
        if (res?.metadata?.exit === 1 && !msg.trim() && /^(grep|rg|diff|test|\[)\s/.test(cmd)) return
        // empty output + exit≠0,1,124 + && chain = a silent failure; add a hint
        // exceptions: exit 124 (timeout, not a silent failure) and exit 3 + systemctl
        if (isSilentChainFailure(cmd, res?.metadata?.exit, msg)) {
          appendToError(ev, "\nHINT: empty output, exit code " + res.metadata.exit + " — the && chain failed silently (e.g. a missing file, or 2>/dev/null hid it). Check each step separately without 2>/dev/null.")
          log(`HINT-no-output-chain shell exit=${res.metadata.exit} session=${ev.sessionID}`)
        }
        const prev = b.get(key)
        b.set(key, { n: (prev?.n ?? 0) + 1, msg: msg || prev?.msg || "?" })
        if (tool === "edit" && msg.includes("Could not find oldString")) {
          const fp = normPath(input.filePath ?? input.path)
          const readState = !fp || !inSession || m.has("shell:" + basename(fp)) ? "full" : m.get(fp)
          if (readState !== "full") {
            appendToError(ev, "\n" + unreadFileHint(fp, readState ? "partial" : "never"))
            log(`HINT-read-first ${readState ? "partial" : "never"} session=${ev.sessionID}`)
          }
          if (fp) {
            const sid = String(ev.sessionID)
            let fm = oldStringFails.get(sid)
            if (!fm) {
              if (oldStringFails.size > 200) oldStringFails.clear()
              fm = new Map()
              oldStringFails.set(sid, fm)
            }
            const n = (fm.get(fp) ?? 0) + 1
            fm.set(fp, n)
            const note = oldStringRepeatNote(n, fp)
            if (note) {
              appendToError(ev, note)
              log(`HINT-oldString-repeat n=${n} session=${sid}`)
            }
          }
        }
        if (tool === "edit" && msg.includes("oldString")) {
          const hint = /Found \d+ matches/.test(msg)
            ? multiMatchHint(input.path ?? input.filePath, input.oldString)
            : similarLines(input.path ?? input.filePath, input.oldString)
          if (hint) {
            appendToError(ev, hint)
            log(`HINT-oldString ${tool} session=${ev.sessionID}`)
          }
        }
        // Group B: "No changes to apply" (oldString == newString) has a different oldString each time, so LOOP-STOP
        // (which compares the full input) does not catch it — we count by message. The before hook cannot block edit
        // (it only replaces code/command), and such an edit changes nothing anyway, so the STOP is appended to the error here.
        if (tool === "edit" && msg.includes("No changes to apply")) {
          const sid = String(ev.sessionID)
          const n = (editErrors.get(sid) ?? 0) + 1
          if (editErrors.size > 500) editErrors.clear()
          editErrors.set(sid, n)
          if (n >= MAX_REPEAT) {
            const e = escalate(
              sid,
              `STOP: "No changes to apply" already ${n}× in this session — oldString and newString are identical, so edit changes nothing. ` +
                `read the file and put the text AFTER the change in newString. If the file already has the right content, the change is done — stop editing.`,
              msg,
            )
            appendToError(ev, "\n\n" + e.text)
            log(`LOOP-STOP-NOCHANGES edit n=${n} stop=${e.n} session=${sid}`)
          } else log(`NOCHANGES edit n=${n} session=${sid}`)
        }
        // Denial from permission rules (Permission.BlockedError → "Permission denied: <action>", the command did NOT run).
        // The model repeats the same denial or tries to get around it (bash -c, a script, pkexec). Only this exact
        // message — "Permission denied" in the output of the command itself (chmod, a root file) is a different case.
        const denied = /^Permission denied: ([\w-]+)/.exec(msg)
        if (denied) {
          const sid = String(ev.sessionID)
          const pdKey = sid + "\u0000" + "permission-denied"
          const pdCount = (shown.get(pdKey) ?? 0) + 1
          if (shown.size > 2000) shown.clear()
          shown.set(pdKey, pdCount)
          appendToError(
            ev,
            pdCount === 1
              ? `\n\nHINT: this is a denial from permission rules set by the user (${denied[1]}), not a system error — nothing was run. ` +
                  `The same or a reworked command (other quotes, bash -c, a script, pkexec) is forbidden too — do not retry and do not get around the rule. ` +
                  `If you cannot finish the task without it: tell the user what you want to do and why, and give a ready command to paste ` +
                  `(e.g. \`sudo cp FILE TARGET\` or \`sudo bash ~/tmp-opencode/SCRIPT.sh\` — write the script with the write tool first). Then end the turn.`
              : `\n\nSTOP: permission denied already ${pdCount}× in this session. Stop trying — tell the user what you need and end the turn.`,
          )
          log(`HINT-permission-denied ${tool} action=${denied[1]} n=${pdCount} session=${sid}`)
        }
        // Missing file for a command that deletes/moves/changes something: we do NOT recall lessons "check ls and use the path
        // from the output" — 10-23 Gemma (task 11) after such a lesson deleted ANOTHER file with the same name (new/ instead of old/).
        const missingTarget = isMissingTarget(cmd, msg)
        if (missingTarget) {
          const k = String(ev.sessionID) + "\u0000" + "missing-target"
          if (!reminded.has(k)) {
            reminded.add(k)
            appendToError(ev, "\n\n" + MISSING_TARGET_NOTE)
            log(`HINT-missing-target ${tool} session=${ev.sessionID}`)
          }
        }
        if (isShellSyntaxError(tool, msg)) {
          const k = String(ev.sessionID) + "\u0000" + "shell-syntax"
          if (!reminded.has(k)) {
            reminded.add(k)
            appendToError(ev, "\n\n" + SHELL_SYNTAX_NOTE)
            log(`HINT-shell-syntax session=${ev.sessionID}`)
          }
        }
        // known fix from the lesson mine — appended to the error, once per session per lesson
        const wn = missingTarget ? null : findLesson(msg)
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


