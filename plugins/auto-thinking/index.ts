import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// AUTO-THINKING (OpenCode V2) — a dynamic thinking limit for the "auto" variant.
// The variant in opencode.json sends `auto_thinking: [low, medium, high]` (tokens).
// The http.request hook reads the history from the request body and replaces that field with
// `thinking_budget_tokens`:
//   a new user command (no tool results after it) -> medium
//   last tool OK                                    -> low
//   error in the last tool                          -> medium
//   >=2 errors in the last 3 tools or LOOP-STOP     -> high
// When the plugin does not work, llama.cpp ignores the unknown field and applies the limit
// of the server (--reasoning-budget) — a safe fallback.
// Compaction (summary of a long session) runs WITHOUT thinking, whatever the variant:
// opencode 2.1.1 drops `agent.compaction.variant` when the agent has no own `model`, so
// the summary used the session variant (auto/high) — measured 11-14…21 on Bonsai: ~4500
// output tokens per compaction vs ~1900 with "none", for a ~1300-token summary.
// COMPACTION_THINKING=on keeps the old behaviour.
// We never throw — a plugin error must not break the request.

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

// opencode's fixed compaction instructions (SessionCompaction template, opencode 2.1.1)
const COMPACTION_MARK = "Do not include the <template> tags in your response"

// pure: true when the request asks for the session summary (marker in a system/user message)
export function isCompactionRequest(body: any): boolean {
  if (!Array.isArray(body?.messages)) return false
  return body.messages.some(
    (m: any) => (m?.role === "system" || m?.role === "user") && text(m.content).includes(COMPACTION_MARK),
  )
}

// pure: switch thinking off in the request body (same fields as the "none" variant)
export function disableThinking(body: any): void {
  delete body.auto_thinking
  delete body.thinking_budget_tokens
  body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: false }
}

export default {
  id: "auto-thinking",
  async setup(ctx: any) {
    await ctx.session.hook("http.request", async (ev: any) => {
      try {
        const req: Request = ev.request
        if (!req || req.method !== "POST" || !req.url.includes("/chat/completions")) return
        const raw = await req.clone().text()
        const compaction = process.env.COMPACTION_THINKING !== "on" && raw.includes(COMPACTION_MARK)
        if (!compaction && !raw.includes("auto_thinking")) return
        const body = JSON.parse(raw)
        if (compaction && isCompactionRequest(body)) {
          disableThinking(body)
          log(`session=${ev.sessionID} agent=${ev.agent} model=${body.model} budget=0 reason=compaction`)
        }
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
