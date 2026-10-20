import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// NO-CALL-GUARD PLUGIN — wykrywa turę, w której model pokazał komendę RAZEM z „wyjściem”,
// ale nie wywołał żadnego narzędzia (zmyślony wynik; 9B robi to w 01-verbatim / 06 / 15).
// Domyślnie TYLKO loguje. Z NO_CALL_GUARD=act (runner treningowy) dopisuje do sesji notkę
// session.synthetic, która wznawia pracę modelu. Notka NIE każe ślepo uruchamiać — jeśli
// użytkownik pytał „jak”, model ma tylko przyznać, że nic nie uruchamiał (ryzyko `rm` z porady).

const HOME = homedir()
const STATE_DIR = join(HOME, ".mempalace", "hook_state")
const DEBUG_LOG = join(STATE_DIR, "no_call_guard.log")
const MODE = process.env.NO_CALL_GUARD === "act" ? "act" : "log"

const NOTE =
  "[no-call-guard] W tej turze nie wywołałeś żadnego narzędzia, a pokazałeś komendę (czasem z „wyjściem”) — " +
  "komenda NIE została uruchomiona, a każde pokazane wyjście jest wymyślone. Jeśli użytkownik prosił o WYKONANIE: uruchom komendę WYWOŁANIEM narzędzia (tool call: bash, a w Code Mode `execute`) — " +
  "tekst w bloku ``` albo napis typu shell(command=…) to NIE jest wywołanie — i podaj prawdziwy wynik. " +
  "Jeśli prosił tylko o pokazanie, jak to zrobić: nie uruchamiaj niczego, tylko napisz wprost, że komenda nie była uruchamiana, " +
  "a pokazane wyjście jest przykładowe."

const SHELL_BLOCK = /```(?:bash|sh|shell|console|fish|zsh)\s*\n[\s\S]*?```/i
const ANY_BLOCK = /```[^\n]*\n[\s\S]*?```/g
// polecenie wykonania w prompcie (nie pytanie „jak …”)
// granice słów przez \p{L}, bo \b w JS nie widzi polskich liter („sprawdź” na końcu słowa)
const ACTION = /(?<!\p{L})(wykonaj|uruchom|odpal|sprawdź|sprawdz|przeczytaj|wyświetl|wyswietl|pokaż wynik|wklej (jej |jego )?wyjście|run|execute)(?!\p{L})/iu
const HOWTO = /^\s*(jak|how|w jaki sposób|czy da się|czy można)(?!\p{L})/iu

// czysta funkcja — testowana bez opencode
export function shouldFire(userText: string, assistantText: string, calls: number): boolean {
  if (calls > 0) return false
  if (!ACTION.test(userText) || HOWTO.test(userText)) return false
  const blocks = assistantText.match(ANY_BLOCK) ?? []
  // sygnatura zmyślenia: blok komendy + co najmniej jeden INNY blok (rzekome wyjście)
  if (SHELL_BLOCK.test(assistantText) && blocks.length >= 2) return true
  // albo blok (z językiem lub bez) przepisuje komendę z promptu zamiast ją wywołać
  return blocks.some((b) => {
    const first = b.replace(/^```[^\n]*\n/, "").split("\n")[0].trim()
    return first.length >= 6 && userText.includes(first)
  })
}

function log(line: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // nie psuć sesji
  }
}

type Stan = { calls: number; text: string; user: string; fired: boolean }

export default {
  id: "no-call-guard",
  async setup(ctx: {
    event: { subscribe: (o: { signal: AbortSignal }) => AsyncIterable<{ type: string; [k: string]: unknown }> }
    session: { synthetic: (o: Record<string, unknown>) => Promise<unknown> }
  }) {
    const controller = new AbortController()
    async function fire(sessionID: string, s: Stan, delivery: "steer" | "queue") {
      if (s.fired || !shouldFire(s.user, s.text, s.calls)) return
      s.fired = true // maks. raz na prompt użytkownika — bez pętli
      log(`HIT ${sessionID} mode=${MODE} via=${delivery} user=${JSON.stringify(s.user.slice(0, 120))} text=${JSON.stringify(s.text.slice(0, 200))}`)
      if (MODE !== "act") return
      try {
        await ctx.session.synthetic({ sessionID, text: NOTE, description: "no-call-guard", delivery })
        log(`synthetic wysłany ${sessionID} delivery=${delivery}`)
      } catch (e) {
        log(`synthetic błąd ${sessionID}: ${String(e)}`)
      }
    }
    log(`plugin-load no-call-guard mode=${MODE}`)
    const g = globalThis as any
    // wtyczka ma instancję na każdą lokalizację, a strumień jest wspólny — każde zdarzenie raz
    const widziane: Set<string> = (g.__noCallGuardWidziane ??= new Set<string>())
    const stany: Map<string, Stan> = (g.__noCallGuardStany ??= new Map())
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const ev = event as any
          const d = ev?.data ?? ev?.properties ?? {}
          const sessionID = d.sessionID ?? ev?.sessionID
          if (!sessionID) continue
          if (ev.id) {
            if (widziane.has(ev.id)) continue
            if (widziane.size > 20000) widziane.clear()
            widziane.add(ev.id)
          }
          if (stany.size > 200) stany.clear()
          const s = stany.get(sessionID) ?? { calls: 0, text: "", user: "", fired: false }
          stany.set(sessionID, s)
          switch (event.type) {
            case "session.inbox.enqueued": {
              const item = d.item ?? {}
              // własna notka nie jest promptem użytkownika
              if (item.type === "user") {
                s.user = String(item.payload?.text ?? item.text ?? item.data?.text ?? "")
                if (!s.user) log(`inbox bez tekstu, kształt: ${JSON.stringify(item).slice(0, 300)}`)
                s.fired = false
              }
              break
            }
            case "session.execution.started":
              s.calls = 0
              s.text = ""
              break
            case "session.tool.called":
              s.calls++
              break
            case "session.text.ended":
              s.text += String(d.text ?? "") + "\n"
              break
            // koniec kroku bez wywołań = model zaraz skończy turę. Notka idzie TERAZ jako „steer”,
            // bo po execution.succeeded `opencode run` już wychodzi i przerywa wznowiony krok („Step interrupted”).
            case "session.step.ended":
              if (d.finish === "tool-calls") break
              await fire(sessionID, s, "steer")
              break
            case "session.execution.succeeded":
              await fire(sessionID, s, "queue") // zapas, gdy step.ended nie przyszedł
              break
          }
        }
      } catch (e) {
        log(`strumień zdarzeń przerwany: ${String(e)}`)
      }
    })()

    return () => controller.abort()
  },
}
