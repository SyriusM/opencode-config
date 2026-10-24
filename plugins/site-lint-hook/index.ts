import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { execFileSync } from "node:child_process"

// SITE-LINT-HOOK — po każdym udanym write/edit pliku strony (.html/.htm/.css/.js) uruchamia ~/bin/site-lint
// na katalogu tego pliku i dokleja ERROR-y do wyniku narzędzia, żeby model je zobaczył bez proszenia.
// Powód (10-23, trening zadanie 20): Gemma 5/5 razy zostawiła 4–13 klas bez reguły w CSS i niczego nie sprawdziła,
// także wtedy, gdy AGENTS.md kazał uruchomić site-lint. Qwen sprawdzał sam i przechodził.
// W trakcie budowy milczy: brak stron HTML w katalogu albo podlinkowany lokalny arkusz CSS jeszcze nie istnieje.
// Hook V2: ctx.tool.hook("execute.after"), doklejanie jak appendToError w tool-input-fix. Nigdy nie rzuca.
// Wyłączenie: SITE_LINT_HOOK=off. Log: ~/.mempalace/hook_state/site_lint_hook.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "site_lint_hook.log")
const LINT = join(HOME, "bin", "site-lint")
const MAX_LINES = 15

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

// strona w trakcie budowy: któraś strona linkuje lokalny CSS, którego jeszcze nie ma
function cssMissing(dir: string, pages: string[]): boolean {
  for (const p of pages) {
    let html = ""
    try { html = readFileSync(join(dir, p), "utf8") } catch { continue }
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0]
      if (!/rel=["']?stylesheet/i.test(tag)) continue
      const href = (tag.match(/href=["']?([^"'\s>]+)/i) || [])[1]
      if (!href || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue
      if (!existsSync(join(dir, href.replace(/[?#].*/, "")))) return true
    }
  }
  return false
}

const last = new Map<string, string>() // session+dir → last error text (repeat = short note)

export default {
  id: "site-lint-hook",
  async setup(ctx: any) {
    if (process.env.SITE_LINT_HOOK === "off") {
      log("site-lint-hook disabled (SITE_LINT_HOOK=off)")
      return
    }
    log("plugin-load site-lint-hook")
    await ctx.tool.hook("execute.after", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        if (!/^(write|edit|multiedit)$/.test(tool)) return
        if (ev.status === "error" || ev.result?.metadata?.error === true) return
        let fp = String(ev.input?.filePath ?? ev.input?.path ?? "")
        if (!/\.(html?|css|js)$/i.test(fp)) return
        if (!isAbsolute(fp)) fp = join(String(ev.directory ?? ev.cwd ?? process.cwd()), fp)
        const dir = dirname(fp)
        const pages = readdirSync(dir).filter((f) => /\.html?$/i.test(f))
        if (!pages.length) return
        // projekt z narzędziem budowania (npm/vite/framework): HTML to szablon, site-lint dałby fałszywe błędy
        for (let d = dir, i = 0; i < 4; i++, d = dirname(d)) {
          if (existsSync(join(d, "package.json"))) { log(`SKIP build-project ${dir}`); return }
          if (d === dirname(d) || d === HOME) break
        }
        if (cssMissing(dir, pages)) { log(`SKIP css-missing ${dir}`); return }
        let out = ""
        try {
          execFileSync(LINT, [dir], { encoding: "utf8", timeout: 10000 })
          last.delete(`${ev.sessionID}\u0000${dir}`)
          return // exit 0 = clean
        } catch (e: any) {
          if (e?.status !== 1) { log(`lint failed ${dir}: ${String(e?.message ?? e).slice(0, 200)}`); return }
          out = String(e.stdout ?? "")
        }
        const errs = out.split("\n").filter((l) => l.startsWith("ERROR "))
        if (!errs.length) return
        const key = `${ev.sessionID}\u0000${dir}`
        const body = errs.slice(0, MAX_LINES).join("\n") + (errs.length > MAX_LINES ? `\n… i ${errs.length - MAX_LINES} więcej` : "")
        const text = last.get(key) === body
          ? `\n\nsite-lint (automatycznie): te same ${errs.length} błędów nadal są — popraw je, zanim napiszesz, że gotowe.`
          : `\n\nsite-lint ${dir} (automatycznie po zmianie pliku strony): ${errs.length} błędów. Popraw każdy, zanim napiszesz, że gotowe:\n${body}`
        if (last.size > 200) last.clear()
        last.set(key, body)
        const targets = append(ev, text)
        log(`LINT ${errs.length} ${dir} ses=${ev.sessionID ?? "?"} → ${targets.join(",") || "NO TARGET"}`)
      } catch (e) {
        log(`site-lint-hook failed: ${e}`)
      }
    })
  },
}
