import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// FAKE-CALL-SCRUB — removes tool calls written as TEXT (`<shell>cmd</shell>`, `<bash …/>`) from earlier
// assistant messages before the request goes to the model.
// Why (10-28, Gemma 4 task 10): the first turn wrote ~60 `<shell>grep …</shell>` blocks and zero real calls;
// no-call-guard's note came after it, but the history still showed the text pattern and Gemma copied it
// in the next turn too. Each block becomes a short marker, so the model sees the call was NOT run.
// 10-28 second part: for agents in FORCE_TOOL_AGENTS (default gemma_coder) the first step of a turn (last
// message = user prompt or a guard note) gets tool_choice "required" — llama.cpp then forces a real call
// by grammar. Scrubbing alone did not help (task 10: 3/5), Gemma picks text mode at the start of a turn.
// 10-28 third part, the real cause (Gemma docs + chat template from the GGUF = Google's canonical 2026-07-09):
// an assistant message with tool_calls AND text ("Sprawdzam…") renders as call, response, text, then `<turn|>`,
// and the generation prompt after a tool response is only `<|channel>thought` — no `<|turn>model`. The model
// then writes outside any turn and falls back to calls as text. With empty content the template keeps the
// turn open (`…<tool_response|><|channel>thought`), as the docs show. So for Gemma the text next to
// tool_calls is dropped (it is only narration before the call).
// Never throws — a plugin error must not break the request. Off: FAKE_CALL_SCRUB=off.

const STATE_DIR = join(homedir(), ".mempalace", "hook_state")
const LOG = join(STATE_DIR, "fake_call_scrub.log")
// 10-29: also `<tool_call>{json}</tool_call>` (Gemma, task 29)
const TAGS = "shell|bash|read|edit|write|execute|grep|glob|tool_call"
// 10-28 r2 also: a bare tool name on its own line, then a ``` block ("shell\n```bash …```", "edit\n```json {…}```")
const BLOCK = new RegExp(
  `<\\s*(${TAGS})\\b[^>\\n]*>[\\s\\S]*?<\\/\\s*\\1\\s*>|<\\s*(?:${TAGS})\\b[^>\\n]*\\/>|` +
    `(?:^|\\n)[ \\t]*(?:${TAGS})[ \\t]*\\n[ \\t]*\x60\x60\x60[^\\n]*\\n[\\s\\S]*?\x60\x60\x60`,
  "gi",
)
const FORCE_AGENTS = (process.env.FORCE_TOOL_AGENTS ?? "gemma_coder").split(",").map((a) => a.trim()).filter(Boolean)
const MARK = "[komenda napisana tekstem — NIE została wykonana]"

function log(line: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

// pure: scrub one text, consecutive markers collapse into one
export function scrubText(s: string): { text: string; n: number } {
  let n = 0
  const text = s
    .replace(BLOCK, () => (n++, MARK))
    .replace(new RegExp(`(${MARK.replace(/[[\]]/g, "\\$&")}\\s*){2,}`, "g"), MARK + "\n")
  return { text, n }
}

// pure: scrub assistant messages in an OpenAI chat body, returns the number of removed blocks
export function scrubMessages(messages: any[]): number {
  let total = 0
  for (const m of messages) {
    if (m?.role !== "assistant") continue
    if (typeof m.content === "string") {
      const r = scrubText(m.content)
      m.content = r.text
      total += r.n
    } else if (Array.isArray(m.content)) {
      for (const p of m.content)
        if (typeof p?.text === "string") {
          const r = scrubText(p.text)
          p.text = r.text
          total += r.n
        }
    }
  }
  return total
}

// pure: drop text from assistant messages that carry tool_calls, returns how many were changed
export function dropCallNarration(messages: any[]): number {
  let n = 0
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue
    const has = typeof m.content === "string" ? m.content.trim() !== "" : Array.isArray(m.content) && m.content.length > 0
    if (!has) continue
    m.content = ""
    n++
  }
  return n
}

// pure: true when this request starts a turn of a forced agent and nothing chose tool_choice yet
export function shouldForce(agent: unknown, body: any): boolean {
  if (!FORCE_AGENTS.includes(String(agent))) return false
  if (!Array.isArray(body?.tools) || body.tools.length === 0 || body.tool_choice) return false
  const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined
  return last?.role === "user"
}

export default {
  id: "fake-call-scrub",
  async setup(ctx: any) {
    if (process.env.FAKE_CALL_SCRUB === "off") return () => {}
    await ctx.session.hook("http.request", async (ev: any) => {
      try {
        const req: Request = ev.request
        if (!req || req.method !== "POST" || !req.url.includes("/chat/completions")) return
        const raw = await req.clone().text()
        const fake = /<\s*\/?\s*(?:shell|bash|read|edit|write|execute|grep|glob|tool_call)\b|(?:shell|bash|read|edit|write|execute|grep|glob)[ \t]*\\n[ \t]*```/i.test(raw)
        const gemma = /"model"\s*:\s*"[^"]*gemma/i.test(raw) && raw.includes('"tool_calls"')
        if (!fake && !gemma && !FORCE_AGENTS.includes(String(ev.agent))) return
        const body = JSON.parse(raw)
        if (!Array.isArray(body.messages)) return
        const n = fake ? scrubMessages(body.messages) : 0
        const dropped = /gemma/i.test(String(body.model)) ? dropCallNarration(body.messages) : 0
        const force = shouldForce(ev.agent, body)
        if (force) body.tool_choice = "required"
        if (!n && !force && !dropped) return
        log(`session=${ev.sessionID} agent=${ev.agent} model=${body.model} scrubbed=${n} narration=${dropped} force=${force}`)
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
