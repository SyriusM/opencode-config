// adversary-guard: a BLOCK verdict must really stop edit/write (opencode 2.x input field `path`) and the model
// must get the reason instead of a "file not found" error; ALLOW leaves the call alone.
// Usage: ADVERSARY_GUARD=on node --experimental-strip-types --no-warnings adversary-guard.test.mjs SRC
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const cfg = mkdtempSync(join(tmpdir(), "ag-"))
mkdirSync(join(cfg, "opencode"))
writeFileSync(join(cfg, "opencode", "opencode.json"), JSON.stringify({ provider: { loc: { options: { baseURL: "http://127.0.0.1:9/v1" } } } }))
process.env.XDG_CONFIG_HOME = cfg
process.env.ADVERSARY_GUARD = "on"
let verdict = "ALLOW"
globalThis.fetch = async () => ({ json: async () => ({ choices: [{ message: { content: verdict } }] }) })

const mod = await import(process.argv[2])
const hooks = {}
const ctx = {
  tool: { hook: async (name, fn) => { hooks["tool." + name] = fn } },
  session: { hook: async (name, fn) => { hooks["session." + name] = fn } },
  event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
}
await mod.default.setup(ctx)
let fails = 0, n = 0
const check = (cond, msg) => { n++; if (!cond) { fails++; console.log("FAIL " + msg) } }
hooks["session.context"]({ sessionID: "s1", model: { providerID: "loc", modelID: "m" } })

const before = async (tool, input) => { const ev = { tool, sessionID: "s1", input }; await hooks["tool.execute.before"](ev); return ev }
const failAfter = (ev) => {
  const a = { tool: ev.tool, sessionID: "s1", input: ev.input, status: "error", error: { message: "File not found: " + (ev.input.path ?? ev.input.filePath) } }
  hooks["tool.execute.after"](a)
  return a.error.message
}

check(typeof hooks["tool.execute.after"] === "function", "after hook registered")
check(typeof mod.blockedPathKey === "function" && mod.blockedPathKey({ path: "a" }) === "path" && mod.blockedPathKey({ filePath: "a" }) === "filePath" && mod.blockedPathKey({ url: "x" }) === undefined, "blockedPathKey")

// 1. ALLOW: input untouched
let ev = await before("edit", { path: "src/a.py", oldString: "x", newString: "y" })
check(ev.input.path === "src/a.py", "allow: path kept, got " + ev.input.path)

// 2. BLOCK edit (opencode 2.x `path`): the call is pointed at the blocked path and the reason replaces the error
verdict = "BLOCK: edits a file outside the task"
ev = await before("edit", { path: "/etc/hosts", oldString: "x", newString: "y" })
check(ev.input.path === mod.BLOCKED_PATH, "block edit: path replaced, got " + ev.input.path)
check(!("filePath" in ev.input), "block edit: no extra filePath key")
let msg = failAfter(ev)
check(/adversary-guard BLOCKED this call: edits a file outside the task/.test(msg) && !/File not found|nonexistent/.test(msg),
  "block edit: reason delivered instead of file error, got " + msg)

// 3. the reason is delivered once — the next (normal) failure keeps its own message
verdict = "ALLOW"
ev = await before("edit", { path: "src/b.py", oldString: "x", newString: "y" })
check(failAfter(ev) === "File not found: src/b.py", "after delivery: next error untouched")

// 4. BLOCK write with the legacy `filePath`
verdict = "BLOCK: overwrites the test"
ev = await before("write", { filePath: "tests/test_a.py", content: "pass" })
check(ev.input.filePath === mod.BLOCKED_PATH && /overwrites the test/.test(failAfter(ev)), "block write (filePath)")

// 5. BLOCK shell: command replaced (unchanged behaviour)
ev = await before("shell", { command: "rm -rf build" })
check(/^printf .*adversary-guard BLOCKED/.test(ev.input.command) && /exit 1$/.test(ev.input.command), "block shell, got " + ev.input.command)

// 6. a tool with no path/command cannot be blocked: let through, input untouched
ev = await before("browser_click", { target: "e1" })
check(JSON.stringify(ev.input) === JSON.stringify({ target: "e1" }), "no path: let through")

console.log(fails ? `FAILED: ${fails} of ${n}` : `ALL OK: ${n} checks`)
process.exit(fails ? 1 : 0)
