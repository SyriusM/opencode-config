import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// AUTO-THINKING (OpenCode V2) — dynamiczny limit myślenia dla wariantu „auto”.
// Wariant w opencode.json wysyła `auto_thinking: [low, medium, high]` (tokeny).
// Hook http.request czyta historię z treści zapytania i podmienia to pole na
// `thinking_budget_tokens`:
//   nowe polecenie użytkownika (brak wyników narzędzi po nim) -> medium
//   ostatnie narzędzie OK                                     -> low
//   błąd w ostatnim narzędziu                                 -> medium
//   >=2 błędy w ostatnich 3 narzędziach albo LOOP-STOP        -> high
// Gdy wtyczka nie zadziała, llama.cpp ignoruje nieznane pole i stosuje limit
// serwera (--reasoning-budget) — bezpieczny fallback.
// Nigdy nie rzucamy — błąd wtyczki nie może psuć zapytania.

const HOME = homedir()
const STATE_DIR = join(HOME, ".mempalace", "hook_state")
const LOG = join(STATE_DIR, "auto_thinking.log")

const ERROR_RE =
  /^\s*(error|failed)|\berror:|could not find|not found|no such file|permission denied|exit code [1-9]|traceback|LOOP-STOP|STOP:/i

function log(line: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("\n")
  return ""
}

export function chooseLevel(messages: any[]): { level: 0 | 1 | 2; reason: string } {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") {
      lastUser = i
      break
    }
  const tools = messages.slice(lastUser + 1).filter((m) => m?.role === "tool")
  if (tools.length === 0) return { level: 1, reason: "new-user-turn" }
  const recent = tools.slice(-3).map((m) => text(m.content).slice(0, 600))
  const errors = recent.filter((t) => ERROR_RE.test(t)).length
  if (recent.some((t) => /LOOP-STOP|STOP:/.test(t)) || errors >= 2) return { level: 2, reason: `errors=${errors}/3` }
  if (ERROR_RE.test(recent[recent.length - 1])) return { level: 1, reason: "last-tool-error" }
  return { level: 0, reason: "tools-ok" }
}

export default {
  id: "auto-thinking",
  async setup(ctx: any) {
    await ctx.session.hook("http.request", async (ev: any) => {
      try {
        const req: Request = ev.request
        if (!req || req.method !== "POST" || !req.url.includes("/chat/completions")) return
        const raw = await req.clone().text()
        if (!raw.includes("auto_thinking")) return
        const body = JSON.parse(raw)
        const levels = body.auto_thinking
        delete body.auto_thinking
        if (Array.isArray(levels) && levels.length === 3 && Array.isArray(body.messages)) {
          const { level, reason } = chooseLevel(body.messages)
          body.thinking_budget_tokens = levels[level]
          log(`session=${ev.sessionID} agent=${ev.agent} model=${body.model} budget=${levels[level]} reason=${reason}`)
        }
        const headers = new Headers(req.headers)
        headers.delete("content-length")
        ev.request = new Request(req.url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch (e) {
        log(`ERROR ${String(e)}`)
      }
    })
    return () => {}
  },
}
