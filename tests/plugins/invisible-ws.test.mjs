// tool-input-fix: after "Could not find oldString" the exact-fragment HINT must name characters a model cannot see
// (TAB after spaces in indentation, trailing whitespace, NBSP) — and stay silent for plain fragments.
// Usage: node --experimental-strip-types --no-warnings invisible-ws.test.mjs SRC
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0, n = 0
const check = (cond, msg) => { n++; if (!cond) { fails++; console.log("FAIL " + msg) } }

// unit: the note itself
const w = mod.invisibleWsNote
check(typeof w === "function", "invisibleWsNote exported")
check(w("\t\t<h2>A</h2>\n\t\t<p>x</p>", 1) === undefined, "plain tabs: no note")
check(w("    def f():\n        return 1", 1) === undefined, "plain spaces: no note")
let s = w("\t\t<h2>Gamma</h2> \n    \t<p>Wersja dla domu. </p>\n\t\t<a>x</a>\t", 17) ?? ""
check(s.includes("line 17: ends with 1 space"), "trailing space named, got " + s)
check(s.includes("line 18: indentation = 4 spaces + 1 TAB"), "mixed indent named, got " + s)
check(s.includes('NBSP (U+00A0) after "<p>Wersja dla domu."'), "NBSP named, got " + s)
check(s.includes("line 19: ends with 1 TAB"), "trailing TAB named, got " + s)
check(!/line 1[0-6]|line 2/.test(s), "only fragment lines, got " + s)
check(w("a\n   \nb", 1) === undefined, "whitespace-only line: not reported as trailing")

// end-to-end through the after hook (the real failed-edit path)
const dir = mkdtempSync(join(tmpdir(), "iw-"))
const file = join(dir, "cards.html")
writeFileSync(file, "<article>\n\t\t<h2>Gamma</h2> \n    \t<p>Wersja dla domu. </p>\n</article>\n")
const ok = (sid, tool, input) => hooks["execute.after"]({ tool, sessionID: sid, input, status: "completed", result: { output: "x", metadata: {} } })
const bad = (sid, oldString) => {
  const ev = { tool: "edit", sessionID: sid, input: { filePath: file, oldString, newString: "y" },
    status: "error", error: { message: "Could not find oldString in the file. It must match exactly." } }
  hooks["execute.after"](ev)
  return ev.error.message
}
ok("s1", "read", { filePath: file })
let m = bad("s1", "\t\t<h2>Gamma</h2>\n     \t<p>Wersja dla domu.</p>")
check(/looks exactly like this/.test(m), "exact-fragment hint present, got " + m.slice(0, 200))
check(/INVISIBLE CHARACTERS/.test(m) && m.includes("line 2: ends with 1 space") && m.includes("line 3: indentation = 4 spaces + 1 TAB"),
  "invisible note in hook output, got " + m)
writeFileSync(file, "<article>\n\t\t<h2>Gamma</h2>\n\t\t<p>Wersja</p>\n</article>\n")
ok("s2", "read", { filePath: file })
m = bad("s2", "\t<h2>Gamma</h2>\n\t<p>Wersja</p>")
check(/looks exactly like this/.test(m) && !/INVISIBLE/.test(m), "plain fragment: no invisible note, got " + m)

console.log(fails ? `FAILED: ${fails} of ${n}` : `ALL OK: ${n} checks`)
process.exit(fails ? 1 : 0)
