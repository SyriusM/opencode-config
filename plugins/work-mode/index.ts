import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// WORK-MODE — dokleja do promptu systemowego jedną linię: czy po drugiej stronie jest człowiek.
//   auto: `opencode run` albo `--auto` (trening AFK, skrypty) — nikt nie odpowie na pytanie o wybór,
//         więc model bierze rekomendowaną opcję, mówi którą i robi dalej;
//   step: TUI / usługa — model podaje opcje i czeka (AGENTS.md, Start Briefing krok 4).
// Wymuszenie: FREECODE_MODE=auto|step. Linia jest stała w obrębie procesu → nie psuje cache promptu.
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

export function modeLine(mode: "auto" | "step"): string {
  return mode === "auto"
    ? "WORK MODE: auto — nobody is watching and nobody will answer questions. When there are options, take your recommended one, say which and why, and finish the task. Don't stop to wait for a choice."
    : "WORK MODE: step — a person is chatting with you. When there are different paths forward, give the options and wait for the choice."
}

export default {
  id: "work-mode",
  async setup(ctx: any) {
    const mode = detectMode(process.argv.slice(2), process.env)
    const line = modeLine(mode)
    log(`plugin-load mode=${mode} argv=${process.argv.slice(2).join(" ").slice(0, 200)}`)
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
