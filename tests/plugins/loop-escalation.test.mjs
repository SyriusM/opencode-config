// Sequence test for tool-input-fix loop brake: the same failing shell call repeated many times
// must get STOP, then an escalated "KONIEC PRÓB" message. Usage: node --experimental-strip-types loop-escalation.test.mjs SRC
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }

const sid = "ses_test_loop"
const cmd = "cp conf.txt /ro/conf.txt"
const err = "cp: nie można utworzyć zwykłego pliku '/ro/conf.txt': System plików wyłącznie do odczytu"
const seen = []
for (let i = 0; i < 6; i++) {
  const ev = { tool: "shell", sessionID: sid, input: { command: cmd } }
  hooks["execute.before"](ev)
  seen.push(ev.input.command)
  // simulate the actual result of what was executed
  hooks["execute.after"]({ tool: "shell", sessionID: sid, input: ev.input, status: "completed", result: { output: err, metadata: { exit: 1 } } })
}
check(seen[0] === cmd && seen[1] === cmd, "first two calls must run unchanged")
check(/STOP: identyczne/.test(seen[2]) && !/KONIEC/.test(seen[2]), "3rd call: plain STOP, got " + seen[2].slice(0, 80))
check(/STOP: identyczne/.test(seen[3]), "4th call: plain STOP")
check(/KONIEC PRÓB/.test(seen[4]) && seen[4].includes("System plików"), "5th call: escalated with quoted error, got " + seen[4].slice(0, 120))
check(/KONIEC PRÓB \(STOP nr 4/.test(seen[5]), "6th call: escalation counter grows")
check(!/[`$]/.test(seen[5].replace(/>&2; exit 1$/, "")), "no backtick/$ in echoed text")

// successful-repeat path (LOOP-STOP-OK) escalates too, in a separate session
const sid2 = "ses_test_ok"
const seen2 = []
for (let i = 0; i < 6; i++) {
  const ev = { tool: "shell", sessionID: sid2, input: { command: "ls" } }
  hooks["execute.before"](ev)
  seen2.push(ev.input.command)
  hooks["execute.after"]({ tool: "shell", sessionID: sid2, input: ev.input, status: "completed", result: { output: "a", metadata: { exit: 0 } } })
}
check(seen2[1] === "ls" && /STOP: to samo/.test(seen2[2]) && /STOP: to samo/.test(seen2[3]), "OK-path: 2 runs, then STOP stays (not reset by its own block)")
check(seen2.some((c) => /KONIEC PRÓB/.test(c)), "OK-path: escalation reached, got " + JSON.stringify(seen2.map((c) => c.slice(0, 20))))

// a different session is not affected
const ev3 = { tool: "shell", sessionID: "ses_other", input: { command: cmd } }
hooks["execute.before"](ev3)
check(ev3.input.command === cmd, "other session untouched")
console.log(fails ? `FAILED: ${fails}` : "ALL OK")
process.exit(fails ? 1 : 0)
