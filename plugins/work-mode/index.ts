import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// WORK-MODE — appends one line to the system prompt: whether there is a human on the other side.
//   auto: `opencode run` or `--auto` (AFK training, scripts) — nobody will answer a question about a choice,
//         so the model takes the recommended option, says which one and goes on;
//   step: TUI / service — the model gives options and waits (AGENTS.md, Start Briefing step 4).
// Override: FREECODE_MODE=auto|step. The line is constant within a process → it does not break the prompt cache.
// ANTI-STUCK (auto only): a step without tool calls that ends with options and a question about the choice
// ("a or b?", "which one do you pick?") = in `run` the task would end here. Then a "steer" note:
// take the recommended one and go on. At most MAX_NUDGES per user prompt — no loops. No model, just a rule.
// Switches (training A/B): WORK_MODE=off = the whole plugin does nothing; ANTI_STUCK=off = only the line, no notes.
// We never throw from the hook. Log: ~/.mempalace/hook_state/work_mode.log

const LOG = join(homedir(), ".mempalace", "hook_state", "work_mode.log")

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

export function detectMode(argv: string[], env: Record<string, string | undefined>): "auto" | "step" {
  const forced = (env.FREECODE_MODE ?? "").toLowerCase()
  if (forced === "auto" || forced === "step") return forced
  return argv.includes("run") || argv.includes("--auto") ? "auto" : "step"
}

const MAX_NUDGES = 2

// >=2 lines that start like options: "a)", "1.", "- **Opcja", "Option B", "**b)**"
const OPTION_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:(?:opcj[ae]|option|wariant|droga)\s*\w{1,2}\b|[a-e1-5][).:])/gimu
// asks for a choice / waits for one
const ASKS_CHOICE = /(?<!\p{L})(któr[aąeyo]\w*|wybierz\w*|wybór|wybor|daj znać|daj znac|czekam|zdecyduj\w*|preferujesz|wolisz|which|choose|pick|let me know|would you like|do you want|shall i)(?!\p{L})/iu

export function isStuck(stepText: string, calls: number): boolean {
  if (calls > 0) return false
  const t = stepText.trim()
  if (!t) return false
  const options = (t.match(OPTION_LINE) ?? []).length
  const tail = t.slice(-400)
  return options >= 2 && (tail.includes("?") || ASKS_CHOICE.test(tail))
}

export const NUDGE =
  "[work-mode] Auto mode: nobody will answer a question about a choice, and the task ends with this turn. " +
  "Take the option you recommend (and if you marked none — the safest one that finishes the task), " +
  "say in one sentence which one and why, and carry it out with tools to the end right away."

export function modeLine(mode: "auto" | "step"): string {
  return mode === "auto"
    ? "WORK MODE: auto — nobody is watching and nobody will answer questions. When there are options, take your recommended one, say which and why, and finish the task. Don't stop to wait for a choice. A big task (many fixes, several files) still goes one part per session: finish that part, verify, report and list the rest as follow-ups — that counts as finished, not as waiting."
    : "WORK MODE: step — a person is chatting with you. When there are different paths forward, give the options and wait for the choice."
}

function watch(ctx: any) {
  const g = globalThis as any
  // one instance per location, a shared stream — each event once
  const seen: Set<string> = (g.__workModeSeen ??= new Set<string>())
  const states: Map<string, { calls: number; text: string; nudges: number }> = (g.__workModeStates ??= new Map())
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: new AbortController().signal })) {
        const d = (ev as any)?.data ?? (ev as any)?.properties ?? {}
        const sessionID = d.sessionID ?? (ev as any)?.sessionID
        if (!sessionID) continue
        if ((ev as any).id) {
          if (seen.has((ev as any).id)) continue
          if (seen.size > 20000) seen.clear()
          seen.add((ev as any).id)
        }
        if (states.size > 200) states.clear()
        const s = states.get(sessionID) ?? { calls: 0, text: "", nudges: 0 }
        states.set(sessionID, s)
        switch (ev.type) {
          case "session.inbox.enqueued":
            if (d.item?.type === "user") s.nudges = 0
            break
          case "session.step.started":
          case "session.execution.started":
            s.calls = 0
            s.text = ""
            break
          case "session.tool.called":
            s.calls++
            break
          case "session.text.ended":
            s.text += String(d.text ?? "")
            break
          case "session.step.ended": {
            const stuck = d.finish !== "tool-calls" && isStuck(s.text, s.calls)
            const text = s.text
            s.text = ""
            s.calls = 0
            if (!stuck) break
            if (s.nudges >= MAX_NUDGES) {
              log(`STUCK ${sessionID} limit reached, no nudge`)
              break
            }
            s.nudges++
            log(`STUCK ${sessionID} nudge=${s.nudges} text=${JSON.stringify(text.slice(-200))}`)
            try {
              await ctx.session.synthetic({ sessionID, text: NUDGE, description: "work-mode", delivery: "steer" })
            } catch (e) {
              log(`synthetic error ${sessionID}: ${String(e).slice(0, 200)}`)
            }
            break
          }
        }
      }
    } catch (e) {
      log(`event stream aborted: ${String(e).slice(0, 200)}`)
    }
  })()
}

export default {
  id: "work-mode",
  async setup(ctx: any) {
    if ((process.env.WORK_MODE ?? "").toLowerCase() === "off") {
      log("plugin-load WORK_MODE=off — plugin does nothing")
      return
    }
    const mode = detectMode(process.argv.slice(2), process.env)
    const line = modeLine(mode)
    const antiStuck = mode === "auto" && (process.env.ANTI_STUCK ?? "").toLowerCase() !== "off"
    log(`plugin-load mode=${mode} anti-stuck=${antiStuck} argv=${process.argv.slice(2).join(" ").slice(0, 200)}`)
    if (antiStuck && typeof ctx?.event?.subscribe === "function") watch(ctx)
    if (typeof ctx?.session?.hook !== "function") {
      log("NO ctx.session.hook — plugin does nothing")
      return
    }
    await ctx.session.hook("context", async (p: any) => {
      try {
        if (Array.isArray(p?.system)) p.system.push({ type: "text", text: line })
      } catch (e) {
        log(`context hook failed: ${String(e).slice(0, 200)}`)
      }
    })
  },
}
