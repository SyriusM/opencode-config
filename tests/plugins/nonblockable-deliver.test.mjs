// Sequence test for tool-input-fix: hints and LOOP-STOPs for tools whose input cannot be swapped (read/edit/write).
// The before hook can only block execute (code) and shell (command); for other tools the message must reach the model
// by being appended to the call's result in the after hook (10-20: 88 read hints "Czy chodziło o…" never reached it).
// Usage: node --experimental-strip-types --no-warnings nonblockable-deliver.test.mjs SRC
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
const mod = await import(process.argv[2])
const hooks = {}
const ctx = { tool: { hook: async (name, fn) => { hooks[name] = fn } }, session: { hook: async () => {} } }
await mod.default.setup(ctx)
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }

// real files under HOME (nearestPath only works on HOME-absolute paths)
const root = join(homedir(), "tmp-opencode", `tif-deliver-test-${process.pid}`)
mkdirSync(join(root, "Projekty", "app"), { recursive: true })
const real = join(root, "Projekty", "app", "config.ini")
writeFileSync(real, "port=7311\n")
const guessed = join(root, "Projekt", "app", "config.ini")

// one tool call: before (may swap input / queue a message) → after with the given outcome; returns what the model sees
const call = (sid, tool, input, outcome) => {
  const ev = { tool, sessionID: sid, input: structuredClone(input) }
  hooks["execute.before"](ev)
  const a = { tool, sessionID: sid, input: ev.input }
  if (outcome.error) Object.assign(a, { status: "error", error: { message: outcome.error } })
  else Object.assign(a, { status: "completed", result: { output: outcome.output, metadata: {} } })
  hooks["execute.after"](a)
  return { seen: a.error?.message ?? a.result?.output ?? "", input: ev.input }
}

try {
  // 1. read with a guessed path: the hint (with the real path) must be in what the model sees
  let r = call("d1", "read", { filePath: guessed }, { error: `File not found: ${guessed}` })
  check(/WSKAZÓWKA/.test(r.seen) && r.seen.includes(real), "read hint delivered, got: " + r.seen.slice(0, 200))
  // ...and it does not leak into the next, unrelated call
  r = call("d1", "read", { filePath: real }, { output: "port=7311" })
  check(!/WSKAZÓWKA|STOP:/.test(r.seen), "hint leaked into next call: " + r.seen.slice(0, 200))

  // 2. identical failing read ×3 → the 3rd shows LOOP-STOP
  const miss = join(root, "nothing-here.txt")
  for (let i = 1; i <= 3; i++) r = call("d2", "read", { filePath: miss, offset: 5 }, { error: "File not found: " + miss })
  check(/STOP: identyczne/.test(r.seen), "read LOOP-STOP delivered on 3rd failure, got: " + r.seen.slice(0, 200))

  // 3. identical successful read ×3 → the 3rd shows LOOP-STOP-OK
  for (let i = 1; i <= 3; i++) r = call("d3", "read", { filePath: real }, { output: "port=7311" })
  check(/STOP: to samo wywołanie/.test(r.seen), "read LOOP-STOP-OK delivered on 3rd repeat, got: " + r.seen.slice(0, 200))
  check(r.seen.startsWith("port=7311"), "original output kept")

  // 4. identical failing edit ×3 → STOP on the 3rd
  const ed = { filePath: real, oldString: "port=1", newString: "port=2" }
  for (let i = 1; i <= 3; i++) r = call("d4", "edit", ed, { error: "Could not find oldString in the file." })
  check(/STOP: identyczne/.test(r.seen), "edit LOOP-STOP delivered, got: " + r.seen.slice(0, 200))

  // 5. execute is still blocked by swapping code (unchanged behaviour)
  const ex = { code: "console.log(x.y)" }
  for (let i = 1; i <= 2; i++) call("d5", "execute", ex, { error: "ReferenceError: x is not defined" })
  r = call("d5", "execute", ex, { error: "whatever" })
  check(/throw new Error\("STOP: identyczne/.test(r.input.code ?? ""), "execute 3rd call blocked via code")
  // 6. shell is still blocked by swapping command
  const sh = { command: "frobnicate --x" }
  for (let i = 1; i <= 2; i++) call("d6", "shell", sh, { error: "frobnicate: command not found" })
  r = call("d6", "shell", sh, { error: "x" })
  check(/^echo "STOP: identyczne/.test(r.input.command ?? ""), "shell 3rd call blocked via command")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(fails ? `FAILED: ${fails}` : "ALL OK")
process.exit(fails ? 1 : 0)
