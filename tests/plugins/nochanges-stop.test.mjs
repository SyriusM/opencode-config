// Sequence test for tool-input-fix group B: repeated edit "No changes to apply" (oldString == newString).
// The before hook cannot block an edit (only execute/shell inputs can be swapped), so the STOP text must be appended
// to the error the model sees on the MAX_REPEAT-th failure. A successful edit resets the count.
// Usage: node --experimental-strip-types --no-warnings nochanges-stop.test.mjs SRC
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }

const ERR = "No changes to apply: oldString and newString are identical."
const noChange = (sid, s = "a") => {
  const ev = { tool: "edit", sessionID: sid, input: { filePath: "/tmp/x.py", oldString: s, newString: s }, status: "error", error: { message: ERR } }
  hooks["execute.before"]?.({ tool: "edit", sessionID: sid, input: { ...ev.input } })
  hooks["execute.after"](ev)
  return ev.error.message
}
const okEdit = (sid) => hooks["execute.after"]({ tool: "edit", sessionID: sid, input: { filePath: "/tmp/x.py", oldString: "a", newString: "b" }, status: "completed", result: { output: "ok", metadata: {} } })

// 1. first failure: plain error
check(!/STOP:|KONIEC PRÓB/.test(noChange("b1", "a")), "1st no-change: no STOP expected")
// 2. second failure (different oldString — LOOP-STOP would not catch it): STOP appended
let m = noChange("b1", "b")
check(/STOP:/.test(m) && /read/.test(m), "2nd no-change: STOP with read advice expected, got " + m.slice(0, 200))
// 3. sessions are independent
check(!/STOP:|KONIEC PRÓB/.test(noChange("b2")), "other session: no STOP")
// 4. successful edit resets the count
okEdit("b3"); noChange("b3"); okEdit("b3")
check(!/STOP:|KONIEC PRÓB/.test(noChange("b3")), "after successful edit: count reset")
// 5. repeated STOPs escalate to "KONIEC PRÓB"
let last = ""
for (let i = 0; i < 6; i++) last = noChange("b4", "s" + i)
check(/KONIEC PRÓB/.test(last), "escalation expected after many STOPs, got " + last.slice(0, 200))
console.log(fails ? `FAILED: ${fails}` : "ALL OK")
process.exit(fails ? 1 : 0)
