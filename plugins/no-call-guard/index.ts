import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// NO-CALL-GUARD PLUGIN — wykrywa turę, w której model pokazał komendę RAZEM z „wyjściem”,
// ale nie wywołał żadnego narzędzia (zmyślony wynik; 9B robi to w 01-verbatim / 06 / 15).
// Domyślnie TYLKO loguje. Z NO_CALL_GUARD=act (runner treningowy) dopisuje do sesji notkę
// session.synthetic, która wznawia pracę modelu. Notka NIE każe ślepo uruchamiać — jeśli
// użytkownik pytał „jak”, model ma tylko przyznać, że nic nie uruchamiał (ryzyko `rm` z porady).
// Druga reguła: pusta tura zaraz po wyniku narzędzia → notka „kontynuuj” (działa w każdym trybie, raz na prompt).

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

// użytkownik wprost kazał coś zrobić -> bez furtki „to była tylko porada” (Gemma 4 none, 10-21: przyznała się
// i zapytała „czy mam wykonać?” zamiast wywołać narzędzie)
const NOTE_DO =
  "[no-call-guard] W tej turze nie wywołałeś żadnego narzędzia — komenda NIE została uruchomiona, a każde pokazane wyjście jest wymyślone. " +
  "Użytkownik wprost polecił to WYKONAĆ. Wywołaj TERAZ narzędzie (tool call: shell/read/edit; w Code Mode `execute`) — " +
  "tekst w bloku ```, `tools.shell(...)` czy `<shell .../>` w odpowiedzi to NIE jest wywołanie. Nie pytaj o zgodę, nie opisuj — wykonaj i podaj prawdziwy wynik. " +
  "Jeśli wskazanego pliku/ścieżki nie ma — zgłoś to i NIC nie podmieniaj (nie ruszaj innego pliku o tej samej nazwie)."

// empty turn right after a tool result (Qwen 35B, 10-21: first token = EOS, no text, the task just stops).
// Acts in every mode: the note only says "continue", it can't make the model run anything new on its own.
const NOTE_EMPTY =
  "[no-call-guard] Twoja ostatnia odpowiedź była pusta — zaraz po wyniku narzędzia nic nie napisałeś i zadanie stanęło. " +
  "Kontynuuj: jeśli zadanie nie jest skończone, wykonaj następny krok; jeśli jest skończone, podsumuj użytkownikowi wynik."

// pure function — tested without opencode
export function isEmptyTurn(stepText: string, calls: number, finish: unknown): boolean {
  return calls > 0 && finish !== "tool-calls" && finish !== "length" && finish !== "error" && stepText.trim() === ""
}

export function noteFor(userText: string): string {
  return ACTION.test(userText) && !HOWTO.test(userText) ? NOTE_DO : NOTE
}

const HANDOFF = /uruchom\s+r(ę|e)cznie/iu
const SHELL_BLOCK = /```(?:bash|sh|shell|console|fish|zsh)\s*\n[\s\S]*?```/i
const ANY_BLOCK = /```[^\n]*\n[\s\S]*?```/g
// polecenie wykonania w prompcie (nie pytanie „jak …”)
// granice słów przez \p{L}, bo \b w JS nie widzi polskich liter („sprawdź” na końcu słowa)
const ACTION = /(?<!\p{L})(wykonaj|uruchom|odpal|sprawdź|sprawdz|przeczytaj|wyświetl|wyswietl|pokaż wynik|wklej|usuń|usun|zmień|zmien|popraw|edytuj|utwórz|utworz|stwórz|stworz|zapisz|skopiuj|przenieś|przenies|dodaj|zainstaluj|run|execute)(?!\p{L})/iu
// tool call written as TEXT instead of a real call (Gemma 4, 10-21): `tools.shell({...})` from the Code Mode API,
// `<shell command="..."/>`, `shell(command=...)`. Unambiguous -> fires without an action verb in the prompt.
const FAKE_CALL = /(?<![\w.])tools\.\w+\s*\(|<\s*(?:shell|bash|read|edit|write|execute|grep|glob)\b[^>\n]*\/?>|(?<![\w.])(?:shell|bash|execute)\s*\(\s*(?:command\s*=|\{)/i
const PROMPT_CMD = /:[ \t]*\n\s*(?:cat|ls|head|tail|wc|grep|find|stat|du|df|file|sort|diff|python3?|bash|sh|git)\s+\S/
const DONE_CLAIM = /(?<!\bnie\s)(?<!\p{L})(usunąłem|usunęłam|zmieniłem|zmieniłam|utworzyłem|utworzyłam|stworzyłem|skopiowałem|przeniosłem|zapisałem|zmodyfikowałem|poprawiłem|wykonałem|uruchomiłem|zainstalowałem|zaktualizowałem|edytowałem|dodałem)(?!\p{L})[^\n]{0,40}?(plik|katalog|folder|`|\/)/iu
const HANDOFF_SCRIPT = /r(?:ę|e)cznie[\s\S]{0,200}?sudo\s+(?:(?:bash|sh)\s+)?[`'"]?\S*?([\w.-]+\.sh)\b/iu
const HOWTO = /^\s*(jak|how|w jaki sposób|czy da się|czy można)(?!\p{L})/iu

// czysta funkcja — testowana bez opencode
export function shouldFire(userText: string, assistantText: string, calls: number, lastStepText = ""): boolean {
  if (HOWTO.test(userText)) return false
  // 10-23 Gemma (08-long-file-lookup): two real reads, then the last step ends with `print(shell(command="grep …"))`
  // as text — the earlier calls must not hide a fake call in the step that ends the turn
  if (FAKE_CALL.test(lastStepText)) return true
  if (calls > 0) return false
  if (FAKE_CALL.test(assistantText)) return true
  // poprawne przekazanie komendy roota użytkownikowi (zadania 09/19) — tu brak wywołania jest właściwy
  // 10-23 Gemma (19-no-sudo-multi): zero calls, "Uruchom RĘCZNIE: sudo bash …/setup.sh" — the script was never
  // written, so this hand-off is fabricated too (unless the script comes from the user's prompt)
  const hs = assistantText.match(HANDOFF_SCRIPT)
  if (HANDOFF.test(assistantText)) return !!hs && ACTION.test(userText) && !userText.includes(hs[1])
  if (!ACTION.test(userText)) return false
  const blocks = assistantText.match(ANY_BLOCK) ?? []
  // 10-23 Gemma KV q4 (01-verbatim): prompt names the exact command, zero calls, answer is a block of "output"
  // whose first line ("data.txt:") is not from the prompt — any block here is fabricated
  if (blocks.length >= 1 && PROMPT_CMD.test(userText)) return true
  // 10-23 Gemma (11-missing-file): zero calls, "<file_deleted>Usunąłem plik …</file_deleted>" — a past-tense
  // claim of having done the action is false when nothing was called
  const claim = assistantText.match(DONE_CLAIM)
  if (claim && !userText.toLowerCase().includes(claim[1].toLowerCase())) return true
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

type State = { calls: number; text: string; stepText: string; user: string; fired: boolean; emptyFired: boolean }

export default {
  id: "no-call-guard",
  async setup(ctx: {
    event: { subscribe: (o: { signal: AbortSignal }) => AsyncIterable<{ type: string; [k: string]: unknown }> }
    session: { synthetic: (o: Record<string, unknown>) => Promise<unknown> }
  }) {
    const controller = new AbortController()
    async function fire(sessionID: string, s: State, delivery: "steer" | "queue", lastStepText = "") {
      if (s.fired || !shouldFire(s.user, s.text, s.calls, lastStepText)) return
      s.fired = true // maks. raz na prompt użytkownika — bez pętli
      log(`HIT ${sessionID} mode=${MODE} via=${delivery} user=${JSON.stringify(s.user.slice(0, 120))} text=${JSON.stringify(s.text.slice(0, 200))}`)
      if (MODE !== "act") return
      try {
        await ctx.session.synthetic({ sessionID, text: noteFor(s.user), description: "no-call-guard", delivery })
        log(`synthetic sent ${sessionID} delivery=${delivery}`)
      } catch (e) {
        log(`synthetic error ${sessionID}: ${String(e)}`)
      }
    }
    async function fireEmpty(sessionID: string, s: State) {
      if (s.emptyFired) return
      s.emptyFired = true // max once per user prompt, no loop
      log(`EMPTY ${sessionID} calls=${s.calls} user=${JSON.stringify(s.user.slice(0, 120))}`)
      try {
        await ctx.session.synthetic({ sessionID, text: NOTE_EMPTY, description: "no-call-guard", delivery: "steer" })
        log(`synthetic sent ${sessionID} delivery=steer kind=empty`)
      } catch (e) {
        log(`synthetic error ${sessionID}: ${String(e)}`)
      }
    }
    log(`plugin-load no-call-guard mode=${MODE}`)
    const g = globalThis as any
    // wtyczka ma instancję na każdą lokalizację, a strumień jest wspólny — każde zdarzenie raz
    const seen: Set<string> = (g.__noCallGuardSeen ??= new Set<string>())
    const states: Map<string, State> = (g.__noCallGuardStates ??= new Map())
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const ev = event as any
          const d = ev?.data ?? ev?.properties ?? {}
          const sessionID = d.sessionID ?? ev?.sessionID
          if (!sessionID) continue
          if (ev.id) {
            if (seen.has(ev.id)) continue
            if (seen.size > 20000) seen.clear()
            seen.add(ev.id)
          }
          if (states.size > 200) states.clear()
          const s = states.get(sessionID) ?? { calls: 0, text: "", stepText: "", user: "", fired: false, emptyFired: false }
          states.set(sessionID, s)
          switch (event.type) {
            case "session.inbox.enqueued": {
              const item = d.item ?? {}
              // własna notka nie jest promptem użytkownika
              if (item.type === "user") {
                s.user = String(item.payload?.text ?? item.text ?? item.data?.text ?? "")
                if (!s.user) log(`inbox without text, shape: ${JSON.stringify(item).slice(0, 300)}`)
                s.fired = false
                s.emptyFired = false
              }
              break
            }
            case "session.execution.started":
              s.calls = 0
              s.text = ""
              s.stepText = ""
              break
            case "session.tool.called":
              s.calls++
              break
            case "session.text.ended":
              s.text += String(d.text ?? "") + "\n"
              s.stepText += String(d.text ?? "")
              break
            // koniec kroku bez wywołań = model zaraz skończy turę. Notka idzie TERAZ jako „steer”,
            // bo po execution.succeeded `opencode run` już wychodzi i przerywa wznowiony krok („Step interrupted”).
            case "session.step.ended": {
              const stepText = s.stepText
              s.stepText = ""
              if (d.finish === "tool-calls") break
              if (isEmptyTurn(stepText, s.calls, d.finish)) await fireEmpty(sessionID, s)
              else await fire(sessionID, s, "steer", stepText)
              break
            }
            case "session.execution.succeeded":
              await fire(sessionID, s, "queue") // zapas, gdy step.ended nie przyszedł
              break
          }
        }
      } catch (e) {
        log(`event stream aborted: ${String(e)}`)
      }
    })()

    return () => controller.abort()
  },
}
