// work-mode: which line goes to the system prompt. Usage: node --experimental-strip-types work-mode.test.mjs PLUGIN.ts
const { detectMode, modeLine, default: plugin } = await import(process.argv[2])
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
console.log(bad ? `${bad} FAIL` : "work-mode: 11 checks OK")
