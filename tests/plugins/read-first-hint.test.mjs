// Sequence test for tool-input-fix "read first" hint: a failed edit ("Could not find oldString") on a file the model
// did not read in this session must say so; after a read it must not. Usage: node --experimental-strip-types read-first-hint.test.mjs SRC
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }

const dir = mkdtempSync(join(tmpdir(), "rf-"))
const file = join(dir, "app.py")
writeFileSync(file, "def main():\n    return compute(1, 2)\n")
const ok = (sid, tool, input) => hooks["execute.after"]({ tool, sessionID: sid, input, status: "completed", result: { output: "x", metadata: {} } })
const badEdit = (sid, path = file) => {
  const ev = { tool: "edit", sessionID: sid, input: { filePath: path, oldString: "    return compute(1, 3)", newString: "y" },
    status: "error", error: { message: "Could not find oldString in the file. It must match exactly." } }
  hooks["execute.after"](ev)
  return ev.error.message
}

// 1. session saw other activity, never read the file
ok("s1", "shell", { command: "ls" })
let m = badEdit("s1")
check(/nie wczytałeś pliku/.test(m) && m.includes(file), "never-read: hint expected, got " + m.slice(0, 160))
check(/PODPOWIED/.test(m), "never-read: similar-lines hint still appended")

// 2. after a full read: no read-first hint
ok("s2", "shell", { command: "ls" })
ok("s2", "read", { filePath: file })
m = badEdit("s2")
check(!/UWAGA/.test(m), "after read: no read-first hint, got " + m.slice(0, 160))

// 3. partial read (offset/limit) → "fragmentami"
ok("s3", "read", { filePath: file, offset: 1, limit: 1 })
m = badEdit("s3")
check(/fragmentami/.test(m), "partial read: fragment hint expected, got " + m.slice(0, 160))
// ...and a later full read clears it
ok("s3", "read", { filePath: file })
check(!/UWAGA/.test(badEdit("s3")), "partial then full read: no hint")

// 4. first event of a session (plugin reloaded mid-session) → silent
m = badEdit("s4")
check(!/UWAGA/.test(m), "first event in session: no hint (unknown history)")

// 5. cat in shell counts as seen
ok("s5", "shell", { command: `cat ${file}` })
check(!/UWAGA/.test(badEdit("s5")), "cat in shell counts as read")

// 6. ~ path normalized; write counts; sessions independent
ok("s6", "write", { filePath: file, content: "x" })
check(!/UWAGA/.test(badEdit("s6")), "write counts as seen")
check(/nie wczytałeś/.test(badEdit("s1")), "other session's reads do not leak into s1")
// 7. real opencode session id created after plugin load: first event is an edit → hint (10-20 live miss)
const sidAt = (ms) => "ses_" + ((~(BigInt(ms) * 4096n)) & ((1n << 48n) - 1n)).toString(16).padStart(12, "0") + "TestTestTestTe"
m = badEdit(sidAt(Date.now()))
check(/nie wczytałeś pliku/.test(m), "new session, edit first: hint expected, got " + m.slice(0, 160))
// ...but a session created long before plugin load stays silent (history unknown)
check(!/UWAGA/.test(badEdit(sidAt(Date.now() - 3600e3))), "old session, edit first: no hint")
console.log(fails ? `FAILED: ${fails}` : "ALL OK")
process.exit(fails ? 1 : 0)
