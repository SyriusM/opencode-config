// Content of the guessed-path hints (not just their names), built on fixture files under the current home directory.
// Usage: node --experimental-strip-types --no-warnings hint-text.test.mjs PLUGIN.ts
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
const m = await import(process.argv[2])
const H = homedir()
const noSlash = H.slice(1)
const caseFlip = (s) => s.replace(/[^/]+$/, (last) => last.toUpperCase() === last ? last.toLowerCase() : last.toUpperCase())
const root = join(H, "Projekty", "app-hint-text")
mkdirSync(root, { recursive: true })
writeFileSync(join(root, "README.md"), "x\n")
writeFileSync(join(root, "index.ts"), "x\n")
const readme = join(root, "README.md")
const guess = (p) => "Czy chodziło o " + p + "?"
const cases = [
  ["read", { filePath: `${noSlash}/Projekty/app-hint-text/README.md` }, guess(readme)],
  ["read", { filePath: `${noSlash}/Projekt/app-hint-text/README.md` }, guess(readme)],
  ["edit", { filePath: `${noSlash}/Projekty/app-hint-text/README.md`, oldString: "a", newString: "b" }, guess(readme)],
  ["read", { filePath: `${noSlash}/xyz-missing/a.md` }, "Model zgaduje"],
  ["read", { filePath: join(root, "index.ts") + "." }, guess(join(root, "index.ts"))],
  ["read", { filePath: readme }, null],
  ["read", { filePath: "src/main.py" }, null],
  ["edit", { filePath: `${noSlash}/Projekty/app-hint-text/NEW.md`, oldString: "", newString: "x" }, null],
  ["read", { filePath: `${caseFlip(H)}/Projekty/app-hint-text/README.md` }, guess(readme)],
  ["read", { filePath: `${caseFlip(H)}/Projekt/app-hint-text/README.md` }, guess(readme)],
  ["read", { filePath: `${caseFlip(H).slice(1)}/Projekty/app-hint-text/README.md` }, guess(readme)],
  ["read", { filePath: `${caseFlip(H)}/xyz-missing/a.md` }, "Model zgaduje"],
  ["read", { filePath: "/home/some-other-user/a.md" }, null],
]
let bad = 0
try {
  for (const [t, i, exp] of cases) {
    const h = m.hint(t, i); const txt = h ? h.text : null
    const ok = exp === null ? h == null : (txt ?? "").startsWith(exp)
    if (!ok) bad++
    console.log(ok ? "OK  " : "FAIL", JSON.stringify(i.filePath), "->", txt)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(bad ? `FAILED ${bad}` : "ALL OK")
process.exit(bad ? 1 : 0)
