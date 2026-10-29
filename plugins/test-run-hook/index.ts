import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { execFileSync } from "node:child_process"

// TEST-RUN-HOOK — po każdym udanym write/edit pliku .py uruchamia skrypty testowe z tego samego katalogu
// (test_*.py / *_test.py z blokiem __main__, bez pytesta) i dokleja wynik do wyniku narzędzia.
// Powód (10-28, trening zadania 10/16/27): Gemma kończyła pracę bez uruchomienia testu, a test nie przechodził.
// Milczy przy: braku testów, >3 plikach testowych, pyproject/setup.py/pytest.ini w katalogu lub ≤3 poziomy wyżej
// (prawdziwy projekt — tam testy uruchamia model). Ten sam błąd po raz drugi = krótka notka.
// Wyłączenie: TEST_RUN_HOOK=off. Log: ~/.mempalace/hook_state/test_run_hook.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "test_run_hook.log")
const MAX_TESTS = 3
const TAIL_LINES = 12

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function append(ev: any, text: string): string[] {
  const targets: string[] = []
  const res = ev.result
  if (res && Array.isArray(res.content)) {
    const last = [...res.content].reverse().find((x: any) => x && typeof x.text === "string")
    if (last) { last.text += text; targets.push("result.content") }
    else { res.content.push({ type: "text", text: text.trim() }); targets.push("result.content+") }
  }
  if (res && typeof res.output === "string") { res.output += text; targets.push("result.output") }
  if (typeof ev.output === "string") { ev.output += text; targets.push("output") }
  return targets
}

function isProject(dir: string): boolean {
  for (let d = dir, i = 0; i < 4; i++, d = dirname(d)) {
    for (const f of ["pyproject.toml", "setup.py", "pytest.ini", "tox.ini", "package.json"])
      if (existsSync(join(d, f))) return true
    if (d === dirname(d) || d === HOME) break
  }
  return false
}

const last = new Map<string, string>() // session+dir → last failure text

export default {
  id: "test-run-hook",
  async setup(ctx: any) {
    if (process.env.TEST_RUN_HOOK === "off") {
      log("test-run-hook disabled (TEST_RUN_HOOK=off)")
      return
    }
    log("plugin-load test-run-hook")
    await ctx.tool.hook("execute.after", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        if (!/^(write|edit|multiedit)$/.test(tool)) return
        if (ev.status === "error" || ev.result?.metadata?.error === true) return
        let fp = String(ev.input?.filePath ?? ev.input?.path ?? "")
        if (!/\.py$/i.test(fp)) return
        if (!isAbsolute(fp)) fp = join(String(ev.directory ?? ev.cwd ?? process.cwd()), fp)
        const dir = dirname(fp)
        const tests = readdirSync(dir).filter((f) => /^test_.*\.py$|_test\.py$/.test(f))
        if (!tests.length || tests.length > MAX_TESTS) return
        if (isProject(dir)) { log(`SKIP project ${dir}`); return }
        const key = `${ev.sessionID}\u0000${dir}`
        const fails: string[] = []
        const oks: string[] = []
        for (const t of tests) {
          let src = ""
          try { src = readFileSync(join(dir, t), "utf8") } catch { continue }
          if (!/__name__\s*==\s*["']__main__["']/.test(src) && /^\s*(import|from)\s+pytest/m.test(src)) continue
          try {
            const out = execFileSync("python3", [t], { cwd: dir, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })
            oks.push(`${t}: ${out.trim().split("\n").pop() ?? "OK"}`)
          } catch (e: any) {
            const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim().split("\n")
            const why = e?.killed ? "przekroczony czas 20 s" : `kod wyjścia ${e?.status}`
            fails.push(`${t} (${why}):\n${out.slice(-TAIL_LINES).join("\n")}`)
          }
        }
        let text = ""
        if (fails.length) {
          const body = fails.join("\n\n")
          text = last.get(key) === body
            ? `\n\ntest-run (automatycznie): test nadal nie przechodzi, ten sam błąd. Przeczytaj go i popraw kod, zanim napiszesz, że gotowe.`
            : `\n\ntest-run (automatycznie po zmianie pliku .py): TEST NIE PRZECHODZI. Nie pisz, że gotowe, dopóki nie przejdzie:\n${body}`
          if (last.size > 200) last.clear()
          last.set(key, body)
        } else if (oks.length && last.has(key)) {
          text = `\n\ntest-run (automatycznie): testy teraz przechodzą — ${oks.join("; ")}. To uruchomiła wtyczka, nie Ty: w raporcie napisz „test uruchomiony automatycznie”, albo uruchom go sam narzędziem shell.`
          last.delete(key)
        }
        if (!text) return
        const targets = append(ev, text)
        log(`RUN fail=${fails.length} ok=${oks.length} ${dir} ses=${ev.sessionID ?? "?"} → ${targets.join(",") || "NO TARGET"}`)
      } catch (e) {
        log(`test-run-hook failed: ${e}`)
      }
    })
  },
}
