import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"

// MEMPALACE ERROR PLUGIN (OpenCode V2) — tool error telemetry
// Odpowiednik mempal_error_hook.sh z Claude Code, ten sam pipeline audytowy.
//
// NOTE: deliberately WITHOUT importing "@opencode/plugin". The docs (V1+V2): "V2 reads
// the default export's id and setup()". Plugin.define is only a formality
// at runtime, and registering the directory via `plugins` in opencode.json gives no
// package resolution (ResolveMessage: Cannot find package '@opencode/plugin')
// — we fought with this, so we stick to a plain object export.
//
// Dokumentacja: OpenCode → Plugins → Hooks → Tools
//   ctx.tool.hook("execute.after", cb)
//   cb dostaje:
//     { tool, sessionID, agent, messageID, id, input } &
//     ( { status: "completed", result } | { status: "error", error: Tool.Error } )
//   Tool.Error (schema): { message: string, error?: Defect, metadata?: Record }
//
// === OUTPUT (consistent with Claude Code) ===
//   ~/mempalace/audit/errors_YYYYMMDD.jsonl — JSONL, material for a digest into the palace
//   ~/.mempalace/hook_state/hook.log        — 1 linia human-readable na zdarzenie
//   ~/.mempalace/hook_state/opencode_plugins_loaded — plugin load marker
//
// === ZASADY ===
//   * Zero tokens — the hook injects nothing into the context, it stays silent.
//   * We never throw from the hook (try/catch) — a hook error must not break the tool.
//   * Only status === "error"; successes are skipped (this is an ERROR hook).
//   * Tool input is cut to 4 KB, the error message to 500 characters.

const HOME = homedir()
const AUDIT_DIR = join(HOME, "mempalace", "audit")
const STATE_DIR = join(HOME, ".mempalace", "hook_state")

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…[TRUNC]" : s)

function appendLine(file: string, line: string) {
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    appendFileSync(file, line + "\n")
  } catch {
    // plugin diagnostic logging goes to the server's stdout; we don't abort
    console.error(`[mempalace-error-hook] could not write to ${file}`)
  }
}

export default {
  id: "mempalace-error-hook",
  async setup(ctx: {
    tool: {
      hook: (
        name: "execute.after",
        cb: (event: {
          tool: string
          sessionID: string
          agent: string
          messageID: string
          id: string
          input: unknown
        } & (
          | { status: "completed"; result: unknown }
          | { status: "error"; error: { message: string; metadata?: Record<string, unknown> } }
        )) => void,
      ) => Promise<unknown>
    }
  }) {
    // plugin start marker — proof that the load worked
    appendLine(
      join(STATE_DIR, "opencode_plugins_loaded"),
      `[${new Date().toISOString()}] plugin mempalace-error-hook loaded`,
    )

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "error") return

      try {
        const ts = new Date().toISOString()
        const message = cap(String(event.error?.message ?? "(brak komunikatu)"), 500)

        // Twardo: zawsze zapis do SQLite (mempalace_core) poprzez subprocess
        // Don't break the tool: an error writing to SQLite is ignored.
        try {
          const agentName = cap(String(event.agent ?? "unknown"), 80)
          const detailsRaw = (() => {
            try {
              return JSON.stringify(event.error ?? {}, null, 0)
            } catch {
              return String(event.error ?? "")
            }
          })()
          const details = cap(detailsRaw, 8000)

          const py = process.env.MEMPalACE_PYTHON ?? "/home/user/mempalace/.venv/bin/python3"
          const coreScript = "-c"
          const code = [
            "import sys",
            "sys.path.insert(0, '/home/user/mempalace')",
            "from mempalace_core import MempalaceCore",
            "core=MempalaceCore()",
            "agent=sys.argv[1]",
            "action=sys.argv[2]",
            "status=sys.argv[3]",
            "details=sys.argv[4]",
            "core.log_action(agent, action, status, details)",
            "core.close()",
          ].join("; ")

          // action/status zgodnie z tym co logujemy do JSONL
          const action = "tool.execute.after"
          const statusVal = "error"
          const argv = [code, agentName, action, statusVal, details]
          execFile(py, [coreScript, ...argv], { timeout: 8000 }, () => {})
        } catch {
          // ignoruj
        }

        // input: full JSON first, on a cycle/size → caps
        let input: unknown = event.input
        let record = {
          ts,
          event: "tool.execute.after",
          status: "error",
          tool: event.tool,
          call_id: event.id,
          session: event.sessionID,
          agent: event.agent,
          message_id: event.messageID,
          error: message,
          error_metadata: event.error?.metadata ?? null,
          input,
        }
        let line: string
        try {
          line = JSON.stringify(record)
          if (line.length > 8192) throw new Error("too large")
        } catch {
          try {
            input = cap(JSON.stringify(event.input ?? null) ?? "null", 4096)
          } catch {
            input = "[not-serializable]"
          }
          record = { ...record, input }
          line = JSON.stringify(record)
        }

        const day = ts.slice(0, 10).replace(/-/g, "")
        appendLine(join(AUDIT_DIR, `errors_${day}.jsonl`), line)

        const now = new Date().toTimeString().slice(0, 8)
        appendLine(
          join(STATE_DIR, "hook.log"),
          `[${now}] ERROR tool.execute.after session=${event.sessionID} tool=${event.tool} :: ${cap(message.split("\n")[0] ?? "", 200)}`,
        )
      } catch (e) {
        console.error("[mempalace-error-hook] hook failed:", e)
      }
    })
  },
}
