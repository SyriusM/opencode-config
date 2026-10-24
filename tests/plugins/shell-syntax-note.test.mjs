// tool-input-fix: a bash syntax error (unclosed quote) gets the "write a script" note once per session.
// Usage: node --experimental-strip-types shell-syntax-note.test.mjs SRC
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }
const fail = (sid, tool, message) => {
  const ev = { tool, sessionID: sid, input: { command: "echo \"a" }, status: "error", error: { message } }
  hooks["execute.after"](ev)
  return ev.error.message
}
const pl = "/usr/bin/bash: -c: linia 1: nieoczekiwany EOF podczas poszukiwania pasującego `\"' |  Exited with code 2"
check(/NIE została wykonana/.test(fail("s1", "shell", pl)), "pl unclosed quote: note expected")
check(!/NIE została wykonana/.test(fail("s1", "shell", pl)), "second time in session: no repeat")
check(/NIE została wykonana/.test(fail("s2", "bash", "bash: -c: line 1: unexpected EOF while looking for matching `''")), "en message: note expected")
check(/NIE została wykonana/.test(fail("s3", "shell", "linia 16: błąd składni: niespodziewany koniec pliku z polecenia `for'")), "for without done: note expected")
check(!/NIE została wykonana/.test(fail("s4", "shell", "ls: nie ma dostępu do 'x': Nie ma takiego pliku")), "other error: no note")
check(!mod.isShellSyntaxError("edit", pl), "only shell tools")
console.log(fails ? `${fails} FAIL` : "shell-syntax-note: 6 checks OK")
