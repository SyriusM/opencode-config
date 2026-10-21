import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

// LESSON-DRAFT PLUGIN — wykrywa wzorce powtarzalnych błędów w sesji
// (rate-limit, powtórzony fail tego samego tool-a, timeouty) i zapisuje
// DRAFT do pliku do RĘCZNEGO przeglądu. NIE dotyka AGENTS.md automatycznie
// — to świadoma decyzja (AGENTS.md mówi: zmiany tam = na prośbę + diff).
//
// Wzorowany na plugins/notify/index.ts (defensive try/catch, zero throw,
// zero wpływu na kontekst/tokeny sesji).

const HOME = homedir()
const STATE_DIR = join(HOME, ".mempalace", "hook_state")
const DEBUG_LOG = join(STATE_DIR, "lesson_draft.log")
const DRAFT_FILE = join(HOME, "tmp-opencode", "lessons-draft.md")

const ERROR_PATTERNS = [
  /rate limit/i,
  /\b429\b/i,
  /too many requests/i,
  /captcha/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /permission denied/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /connection refused/i,
  /\b503\b/,
  /\b404\b/,
  /not found/i,
  /no such file/i,
  /invalid arguments/i, // zły klucz/typ argumentu (np. filePath zamiast path) — częste u lokalnych modeli
]

function log(line: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // nie psuć sesji
  }
}

function notify(body: string) {
  try {
    const p = spawn(
      "notify-send",
      ["--app-name=opencode", "-u", "low", "opencode: draft lekcji", body.slice(0, 200)],
      { stdio: "ignore", detached: true },
    )
    p.on("error", () => {})
    p.unref()
  } catch {
    // ignore
  }
}

// Heurystyka: licz ile razy każdy wzorzec błędu wystąpił w outputach tool-i,
// i ile razy ten sam tool+pattern powtórzył się (= prawdopodobny death-loop
// albo fałszywy sygnał traktowany jako fakt).
function analyze(messages: Array<{ info: any; parts: any[] }>): {
  hits: Array<{ tool: string; pattern: string; count: number; sample: string }>
} {
  const counts = new Map<string, { count: number; sample: string }>()

  for (const m of messages) {
    for (const part of m.parts ?? []) {
      if (part?.type !== "tool") continue
      const tool = String(part.tool ?? "unknown")
      const state = part.state ?? {}
      const blob = JSON.stringify(state).slice(0, 4000)
      for (const re of ERROR_PATTERNS) {
        if (re.test(blob)) {
          const key = `${tool}::${re.source}`
          const prev = counts.get(key)
          if (prev) {
            prev.count += 1
          } else {
            const m2 = blob.match(re)
            counts.set(key, { count: 1, sample: m2 ? m2[0] : re.source })
          }
        }
      }
    }
  }

  const hits: Array<{ tool: string; pattern: string; count: number; sample: string }> = []
  for (const [key, v] of counts) {
    if (v.count >= 2) {
      const [tool, pattern] = key.split("::")
      hits.push({ tool, pattern, count: v.count, sample: v.sample })
    }
  }
  return { hits }
}

function writeDraft(sessionID: string, hits: Array<{ tool: string; pattern: string; count: number; sample: string }>) {
  try {
    mkdirSync(join(HOME, "tmp-opencode"), { recursive: true })
    const ts = new Date().toISOString()
    let block = `\n## ${ts} — sesja ${sessionID}\n`
    for (const h of hits) {
      block += `- tool \`${h.tool}\`: wzorzec błędu \`${h.pattern}\` wystąpił ${h.count}× (próbka: "${h.sample}")\n`
    }
    block += `- ⏳DO PRZEGLĄDU: czy to realny wzorzec do zapisania w AGENTS.md/CLAUDE.md, czy szum. Ręcznie wrzuć jeśli tak, potem usuń ten blok.\n`
    appendFileSync(DRAFT_FILE, block)
    log(`draft written for session ${sessionID}, hits=${hits.length}`)
    notify(`sesja ${sessionID.slice(-8)}: ${hits.length} wzorzec(ów) błędów — zob. ~/tmp-opencode/lessons-draft.md`)
  } catch (e) {
    log(`writeDraft error: ${String(e)}`)
  }
}

export default {
  id: "lesson-draft",
  async setup(ctx: {
    client: { session: { messages: (o: { path: { id: string } } ) => Promise<{ data?: any }> } }
    event: { subscribe: (o: { signal: AbortSignal }) => AsyncIterable<{ type: string; properties?: any; [k: string]: unknown }> }
  }) {
    const controller = new AbortController()
    log("plugin-load lesson-draft")

    // V2 (2.0.24): brak ctx.client — błędy zbieramy wprost ze strumienia zdarzeń session.tool.*,
    // a analizujemy na końcu tury (session.execution.succeeded/failed; session.idle nie istnieje).
    let shownShape = false
    let shownCalled = false
    let shownInput = false
    const g = globalThis as any
    // wspólne dla wszystkich instancji (jedna na lokalizację) — zdarzenie obsługuje ta, która zobaczy je pierwsza
    const seen: Set<string> = (g.__lessonDraftSeen ??= new Set<string>())
    const buffer: Map<string, Array<{ type: string; parts: any[] }>> = (g.__lessonDraftBuffer ??= new Map())
    const toolNames: Map<string, string> = (g.__lessonDraftToolNames ??= new Map()) // id wywołania → nazwa narzędzia
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const ev = event as any
          const sessionID = ev?.data?.sessionID ?? ev?.properties?.sessionID ?? ev?.sessionID
          if (!sessionID) continue
          // wtyczka ma instancję na każdą lokalizację, a strumień jest wspólny — każde zdarzenie raz
          if (ev.id) {
            if (seen.has(ev.id)) continue
            if (seen.size > 20000) seen.clear()
            seen.add(ev.id)
          }
          if (event.type === "session.tool.input.started" || event.type === "session.tool.input.ended") {
            const d = ev.data ?? {}
            if (!shownInput) { shownInput = true; log(`shape ${event.type}: ${JSON.stringify(d).slice(0, 300)}`) }
            const callToolName = d.tool ?? d.name ?? d.toolID ?? d.toolName
            if (d.id && callToolName) { if (toolNames.size > 5000) toolNames.clear(); toolNames.set(String(d.id), String(callToolName)) }
            continue
          }
          if (/^session\.tool\./.test(event.type) && !/input\.(started|ended)|progress/.test(event.type)) {
            if (!/success|called/.test(event.type) && !shownShape) {
              shownShape = true
              log(`shape ${event.type}: ${JSON.stringify(ev.data).slice(0, 400)}`)
            }
            const d = ev.data ?? {}
            if (event.type === "session.tool.called") {
              if (!shownCalled) { shownCalled = true; log(`shape called: ${JSON.stringify(d).slice(0, 300)}`) }
              const callToolName = d.tool ?? d.name ?? d.toolID ?? d.input?.tool
              if (d.id && callToolName) { if (toolNames.size > 5000) toolNames.clear(); toolNames.set(String(d.id), String(callToolName)) }
              continue
            }
            if (/success/.test(event.type)) continue
            const tool = String(d.tool ?? d.name ?? toolNames.get(String(d.id)) ?? "unknown")
            if (buffer.size > 50) buffer.clear()
            const list = buffer.get(sessionID) ?? []
            list.push({ type: "tool", parts: [{ type: "tool", tool, state: d }] })
            buffer.set(sessionID, list)
            continue
          }
          if (event.type !== "session.idle" && !/^session\.execution\.(succeeded|failed)$/.test(event.type)) continue
          const list = buffer.get(sessionID) ?? []
          const { hits } = analyze(list.map((x) => ({ info: {}, parts: x.parts })))
          log(`turn end ${sessionID}: tool errors=${list.length} hits=${hits.length}`)
          if (hits.length > 0) {
            writeDraft(sessionID, hits)
            buffer.delete(sessionID) // ten sam wzorzec nie wraca w każdej kolejnej turze
          }
        }
      } catch (e) {
        log(`event stream aborted: ${String(e)}`)
      }
    })()

    return () => controller.abort()
  },
}
