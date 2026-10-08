import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"

// MEMPALACE ERROR PLUGIN (OpenCode V2) — telemetria błędów tooli
// Odpowiednik mempal_error_hook.sh z Claude Code, ten sam pipeline audytowy.
//
// UWAGA: celowo BEZ importu "@opencode/plugin". Dokumentacja (V1+V2): „V2 reads
// the default export's id and setup()". Plugin.define to w runtime tylko
// formalność, a rejestracja katalogu przez `plugins` w opencode.json nie daje
// rozwiązywania pakietów (ResolveMessage: Cannot find package '@opencode/plugin')
// — spędziliśmy z tym walkę, więc zostajemy przy czystym eksporcie obiektu.
//
// Dokumentacja: OpenCode → Plugins → Hooks → Tools
//   ctx.tool.hook("execute.after", cb)
//   cb dostaje:
//     { tool, sessionID, agent, messageID, id, input } &
//     ( { status: "completed", result } | { status: "error", error: Tool.Error } )
//   Tool.Error (schema): { message: string, error?: Defect, metadata?: Record }
//
// === OUTPUT (spójny z Claude Code) ===
//   ~/mempalace/audit/errors_YYYYMMDD.jsonl — JSONL, materiał na digest do palace
//   ~/.mempalace/hook_state/hook.log        — 1 linia human-readable na zdarzenie
//   ~/.mempalace/hook_state/opencode_plugins_loaded — marker załadowania pluginu
//
// === ZASADY ===
//   * Zero tokenów — hook niczego nie wstrzykuje do kontekstu, milczy.
//   * Nigdy nie rzucamy z hooka (try/catch) — błąd hooka nie może psuć toola.
//   * Tylko status === "error"; sukcesy pomijamy (to jest ERROR hook).
//   * Wejście toola ucinamy do 4 KB, komunikat błędu do 500 znaków.

const HOME = homedir()
const AUDIT_DIR = join(HOME, "mempalace", "audit")
const STATE_DIR = join(HOME, ".mempalace", "hook_state")

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…[TRUNC]" : s)

function appendLine(file: string, line: string) {
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    appendFileSync(file, line + "\n")
  } catch {
    // logowanie diagnostyczne pluginów trafia do stdout serwera; nie przerywamy
    console.error(`[mempalace-error-hook] nie mogłem zapisać do ${file}`)
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
    // marker startu pluginu — dowód że load się udał
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
        // Nie psujemy toola: błąd wpisu do SQLite ignorujemy.
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

        // input: najpierw pełne JSON, przy cyklu/wielkości → caps
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
          if (line.length > 8192) throw new Error("za duże")
        } catch {
          try {
            input = cap(JSON.stringify(event.input ?? null) ?? "null", 4096)
          } catch {
            input = "[nie-serializowalne]"
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
