// tool-input-fix: similar-name hints - within1, nearMisses, isSilentChainFailure, similarNameHint.
// Usage: node --experimental-strip-types similar-name.test.mjs SRC
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const mod = await import(process.argv[2])
const { within1, nearMisses, isSilentChainFailure, similarNameHint, projectRoot } = mod
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log("FAIL " + msg) } }

// CORRECT and MISSP differ by exactly one middle character.
const CORRECT = "TtsEngine"
const MISSP = "TssEngine"

// ---- within1: edit distance <= 1 ----
check(within1(CORRECT, MISSP), "within1: sub (t<->s) -> true")
check(within1(MISSP, CORRECT), "within1: reversed pair -> true")
check(!within1("abc", "abc"), "within1: identical -> false")
check(within1(CORRECT, CORRECT.slice(0, 4) + CORRECT.slice(5)), "within1: delete one middle char -> true")
check(within1("ab", "ba"), "within1: swap two chars -> true")
check(!within1(CORRECT, "TssEngin"), "within1: 2 differences -> false")

// ---- nearMisses ----
const counts = new Map([[CORRECT, 5]])
const r0 = nearMisses("val e = " + MISSP + "()", counts)
check(r0.length === 1 && r0[0].bad === MISSP && r0[0].good === CORRECT && r0[0].n === 5,
  "nearMisses: misspelling in text -> exactly one match")
check(nearMisses(CORRECT + "s", counts).length === 0,
  "nearMisses: plural -> 0 (plural, not a typo)")
check(nearMisses(CORRECT + "()", counts).length === 0,
  "nearMisses: existing name in text -> 0")
check(nearMisses(MISSP, new Map([[CORRECT, 1]])).length === 0,
  "nearMisses: count < 2 too rare -> 0")

// ---- isSilentChainFailure ----
check(isSilentChainFailure("cd x && ls", 2, ""), "silent chain: exit 2 empty msg -> true")
check(!isSilentChainFailure("cd x && ls", 1, ""), "silent chain: exit 1 -> false")
check(!isSilentChainFailure("cd x && ls", 0, ""), "silent chain: exit 0 -> false")
check(!isSilentChainFailure("cd x && ls", 124, ""), "silent chain: exit 124 -> false")
check(!isSilentChainFailure("cd x && ls", 2, "error text"), "silent chain: msg present -> false")
check(!isSilentChainFailure("ls x", 2, ""), "silent chain: no && -> false")
check(!isSilentChainFailure("systemctl --user is-active a && echo", 3, ""),
  "silent chain: exit 3 + systemctl -> false (normal inactive)")

// ---- similarNameHint (write tool) ----
const dir = mkdtempSync(join(homedir(), ".sn-test-"))
mkdirSync(join(dir, ".git"))
writeFileSync(join(dir, "A.kt"), "class " + CORRECT + " {}\nval x = " + CORRECT + "()\n")
check(projectRoot(dir + "/B.kt") === dir, "similarNameHint: projectRoot finds the fake repo dir")

const h1 = similarNameHint("write", { filePath: dir + "/B.kt", content: MISSP + "()" })
check(h1 !== undefined && h1.name === "similar-name" && h1.text.includes(CORRECT),
  "similarNameHint: misspelling in new content -> similar-name hint with correct name")

check(similarNameHint("write", { filePath: dir + "/B.kt", content: CORRECT + "()" }) === undefined,
  "similarNameHint: correct existing name -> undefined")

check(similarNameHint("write", { filePath: dir + "/B.txt", content: MISSP + "()" }) === undefined,
  "similarNameHint: .txt (not code) -> undefined")

rmSync(dir, { recursive: true })
check(projectRoot(dir) === undefined, "similarNameHint: fake dir removed -> no root left")

const N = 22
console.log(fails ? `${fails} FAIL` : "similar-name: " + N + " checks OK")
process.exit(fails ? 1 : 0)
