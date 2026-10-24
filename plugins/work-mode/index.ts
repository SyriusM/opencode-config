import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// WORK-MODE — dokleja do promptu systemowego jedną linię: czy po drugiej stronie jest człowiek.
//   auto: `opencode run` albo `--auto` (trening AFK, skrypty) — nikt nie odpowie na pytanie o wybór,
//         więc model bierze rekomendowaną opcję, mówi którą i robi dalej;
//   step: TUI / usługa — model podaje opcje i czeka (AGENTS.md, Start Briefing krok 4).
// Wymuszenie: FREECODE_MODE=auto|step. Linia jest stała w obrębie procesu → nie psuje cache promptu.
// ANTI-STUCK (tylko auto): krok bez wywołań narzędzi, który kończy się opcjami i pytaniem o wybór
// („a czy b?”, „którą wybierasz?”), = w `run` zadanie by się tu skończyło. Wtedy notka „steer”:
// weź rekomendowaną i rób dalej. Maks. MAX_NUDGES na prompt użytkownika — bez pętli. Bez modelu, sama reguła.
// Wyłączniki (A/B treningu): WORK_MODE=off = cała wtyczka nic nie robi; ANTI_STUCK=off = tylko linia, bez notek.
// Nigdy nie rzucamy z hooka. Log: ~/.mempalace/hook_state/work_mode.log

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
  "[work-mode] Tryb auto: nikt nie odpowie na pytanie o wybór, a zadanie skończy się na tej turze. " +
  "Weź opcję, którą rekomendujesz (a jeśli żadnej nie oznaczyłeś — najbezpieczniejszą, która kończy zadanie), " +
  "napisz jednym zdaniem którą i dlaczego, i od razu wykonaj ją narzędziami do końca."

export function modeLine(mode: "auto" | "step"): string {
  return mode === "auto"
    ? "WORK MODE: auto — nobody is watching and nobody will answer questions. When there are options, take your recommended one, say which and why, and finish the task. Don't stop to wait for a choice. A big task (many fixes, several files) still goes one part per session: finish that part, verify, report and list the rest as follow-ups — that counts as finished, not as waiting."
    : "WORK MODE: step — a person is chatting with you. When there are different paths forward, give the options and wait for the choice."
}

function watch(ctx: any) {
  const g = globalThis as any
  // instancja na lokalizację, strumień wspólny — każde zdarzenie raz
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
