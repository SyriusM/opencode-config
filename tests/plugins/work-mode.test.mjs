// work-mode: which line goes to the system prompt. Usage: node --experimental-strip-types work-mode.test.mjs PLUGIN.ts
const { detectMode, modeLine, isStuck, default: plugin } = await import(process.argv[2])
let bad = 0
const eq = (desc, got, want) => { if (got !== want) { bad++; console.log(`FAIL ${desc}: ${got} != ${want}`) } }
eq("TUI", detectMode([], {}), "step")
eq("serve --service", detectMode(["serve", "--service"], {}), "step")
eq("run", detectMode(["run", "--standalone", "zadanie"], {}), "auto")
eq("--auto TUI", detectMode(["--auto"], {}), "auto")
eq("forced step", detectMode(["run"], { FREECODE_MODE: "step" }), "step")
eq("forced auto", detectMode([], { FREECODE_MODE: "AUTO" }), "auto")
eq("bad env ignored", detectMode([], { FREECODE_MODE: "x" }), "step")
eq("auto line", modeLine("auto").startsWith("WORK MODE: auto"), true)
let cb
await plugin.setup({ session: { hook: async (_n, f) => { cb = f } } })
const p = { system: [] }
await cb(p)
eq("hook pushes one line", p.system.length, 1)
eq("hook line", p.system[0].text.startsWith("WORK MODE: "), true)
await plugin.setup({}) // no hook API: must not throw
// anti-stuck rule
const opts = "Mogę to zrobić na dwa sposoby:\n\na) poprawić skrypt (Recommended)\nb) przepisać od zera\n\nKtórą opcję wybierasz?"
eq("options + question", isStuck(opts, 0), true)
eq("english options", isStuck("1. Patch it\n2. Rewrite\nWhich one do you want?", 0), true)
eq("bold Opcja + czekam", isStuck("- **Opcja A** szybka\n- **Opcja B** pewna\nCzekam na decyzję.", 0), true)
eq("tool calls in step", isStuck(opts, 1), false)
eq("one option only", isStuck("a) zrobione\nCzy coś jeszcze?", 0), false)
eq("summary list, no question", isStuck("Zrobione:\n1. plik A\n2. plik B\nTest przechodzi.", 0), false)
eq("empty", isStuck("", 0), false)

// event stream: fake opencode
async function session(env, steps, argv = ["run"]) {
  const saved = { ...process.env }, savedArgv = process.argv
  Object.assign(process.env, env); process.argv = ["node", "oc", ...argv]
  const g = globalThis; delete g.__workModeSeen; delete g.__workModeStates
  const sent = []
  let push; const q = []
  const stream = { async *[Symbol.asyncIterator]() { while (true) { if (q.length) yield q.shift(); else await new Promise(r => (push = r)) } } }
  const emit = (type, data) => { q.push({ type, data: { sessionID: "s1", ...data } }); push?.(); push = null }
  await plugin.setup({ session: { hook: async () => {}, synthetic: async o => sent.push(o) }, event: { subscribe: () => stream } })
  emit("session.inbox.enqueued", { item: { type: "user" } })
  for (const st of steps) {
    emit("session.execution.started", {})
    for (let i = 0; i < st.calls; i++) emit("session.tool.called", {})
    emit("session.text.ended", { text: st.text })
    emit("session.step.ended", { finish: st.calls ? "tool-calls" : "stop" })
  }
  await new Promise(r => setTimeout(r, 30))
  process.env = saved; process.argv = savedArgv
  return sent
}
const stuck = { calls: 0, text: opts }
eq("auto: nudge sent", (await session({}, [stuck])).length, 1)
eq("nudge is steer", (await session({}, [stuck]))[0]?.delivery, "steer")
eq("limit 2 per prompt", (await session({}, [stuck, stuck, stuck])).length, 2)
eq("tool step: no nudge", (await session({}, [{ calls: 2, text: opts }])).length, 0)
eq("step mode: no nudge", (await session({}, [stuck], [])).length, 0)
eq("ANTI_STUCK=off", (await session({ ANTI_STUCK: "off" }, [stuck])).length, 0)
eq("WORK_MODE=off", (await session({ WORK_MODE: "off" }, [stuck])).length, 0)
let pushed = false
process.env.WORK_MODE = "off"
await plugin.setup({ session: { hook: async () => { pushed = true } } })
delete process.env.WORK_MODE
eq("WORK_MODE=off: no prompt line", pushed, false)
console.log(bad ? `${bad} FAIL` : "work-mode: 26 checks OK")
