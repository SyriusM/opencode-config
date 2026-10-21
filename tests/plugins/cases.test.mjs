// tool-input-fix against JSON case files. "@HOME@" in a case is replaced by the current home directory.
// "requires_file": rule exists only on systems with that file (e.g. pacman); elsewhere the case expects null.
// Usage: node --experimental-strip-types --no-warnings cases.test.mjs PLUGIN.ts CASES.json [CASES.json…]
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
const mod = await import(process.argv[2])
const { fixCode, fixNames, fixMcp } = mod
// opencode loads the plugin through its default export: an object with id and setup
if (!mod.default || typeof mod.default.id !== "string" || typeof mod.default.setup !== "function") {
  console.log("FAILED: missing valid `export default { id, setup }`")
  process.exit(1)
}
for (const [n, f] of Object.entries({ fixCode, fixNames, fixMcp })) if (typeof f !== "function") { console.log("FAILED: missing function " + n); process.exit(1) }
const home = homedir()
let failed = 0, total = 0
for (const file of process.argv.slice(3)) {
  const cases = JSON.parse(readFileSync(file, "utf8").replaceAll("@HOME@", home))
  for (const c of cases) {
    total++
    let result
    if (c.type === "hint") {
      // expect: hint name, or null (the call goes through unblocked)
      const h = mod.hint ? mod.hint(c.tool, c.input, c.mode === "repair") : undefined
      result = h ? h.name : null
    }
    else if (c.type === "lesson") {
      // input: error message; expect: lesson file name prefix, or null
      const l = mod.matchLesson ? mod.matchLesson(c.input) : undefined
      result = l ? (c.expect && l.file.startsWith(c.expect) ? c.expect : l.file) : null
    }
    else if (c.type === "enables-repair") { result = mod.enablesRepairMode ? mod.enablesRepairMode(c.tool, c.input) : null }
    else if (c.type === "code-string") { const r = fixCode(c.input); result = fixNames(r.code).code }
    else if (c.type === "code") { result = structuredClone(c.input); const r = fixCode(result.code); result.code = fixNames(r.code).code }
    else if (c.type === "mcp") { result = structuredClone(c.input); fixMcp(c.tool, result) }
    else { failed++; console.log(`FAIL  unknown case type ${JSON.stringify(c.type)}`); continue }
    const expect = c.requires_file && !existsSync(c.requires_file) ? null : c.expect
    const ok = c.expect_contains !== undefined ? String(result).includes(c.expect_contains) : JSON.stringify(result) === JSON.stringify(expect)
    if (!ok) { failed++; console.log(`FAIL  ${c.desc ?? c.type}\n     input:    ${JSON.stringify(c.input)}\n     result:   ${JSON.stringify(result)}\n     expected: ${JSON.stringify(c.expect_contains ?? expect)}`) }
  }
}
console.log(failed ? `FAILED: ${failed} of ${total}` : `OK: all ${total} cases passed`)
process.exit(failed ? 1 : 0)
