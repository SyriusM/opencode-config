import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// NO-CALL-GUARD PLUGIN — detects a turn in which the model showed a command TOGETHER with "output",
// but did not call any tool (a made-up result; 9B does this in 01-verbatim / 06 / 15).
// By default it ONLY logs. With NO_CALL_GUARD=act (training runner) it adds a
// session.synthetic note to the session, which resumes the model. The note does NOT say to run blindly — if
// the user asked "how", the model only has to admit it ran nothing (risk of `rm` from advice).
// Second rule: an empty turn right after a tool result → a "continue" note (works in every mode, once per prompt).

const HOME = homedir()
const STATE_DIR = join(HOME, ".mempalace", "hook_state")
const DEBUG_LOG = join(STATE_DIR, "no_call_guard.log")
const MODE = process.env.NO_CALL_GUARD === "act" ? "act" : "log"

const NOTE =
  "[no-call-guard] You called no tool in this turn, but you showed a command (sometimes with \"output\") — " +
  "the command was NOT run, and any output shown is made up. If the user asked you to RUN it: run the command with a tool CALL (tool call: bash, in Code Mode `execute`) — " +
  "text in a ``` block or a string like shell(command=…) is NOT a call — and give the real result. " +
  "If they only asked how to do it: do not run anything, just say plainly that the command was not run, " +
  "and the output shown is an example."

// the user explicitly asked for an action -> no "it was just advice" loophole (Gemma 4 none, 10-21: it admitted it
// and asked "should I run it?" instead of calling the tool)
const NOTE_DO =
  "[no-call-guard] You called no tool in this turn — the command was NOT run, and any output shown is made up. " +
  "The user explicitly asked you to DO it. Call the tool NOW (tool call: shell/read/edit; in Code Mode `execute`) — " +
  "text in a ``` block, `tools.shell(...)` or `<shell .../>` in the reply is NOT a call. Do not ask for permission, do not describe — do it and give the real result. " +
  "If the given file/path does not exist — report it and do NOT substitute ANYTHING (do not touch another file with the same name)."

// empty turn right after a tool result (Qwen 35B, 10-21: first token = EOS, no text, the task just stops).
// Acts in every mode: the note only says "continue", it can't make the model run anything new on its own.
const NOTE_EMPTY =
  "[no-call-guard] Your last reply was empty — right after a tool result you wrote nothing and the task stalled. " +
  "Continue: if the task is not finished, do the next step; if it is finished, summarize the result for the user."

// pure function — tested without opencode
export function isEmptyTurn(stepText: string, calls: number, finish: unknown): boolean {
  return calls > 0 && finish !== "tool-calls" && finish !== "length" && finish !== "error" && stepText.trim() === ""
}

// 11-20: a step that only ANNOUNCES the next action and ends the turn (Gemma 4 Q5, astrology test:
// "Teraz odczytam zawartość pliku…", "Wyślę komendę tail…" + finish=stop, no call — the user had to type "ok"
// after every step). Acts in every mode, at most ANNOUNCE_MAX times per user prompt.
const NOTE_ANNOUNCE =
  "[no-call-guard] Your last reply only announced the next step but called no tool, so the task stalled. " +
  "Do that step NOW with a real tool call (shell/read/edit), in this reply. " +
  "If the task is already finished, give the final result instead (paste the required outputs literally)."
export const ANNOUNCE_MAX = 6
const ANNOUNCE_RE =
  /\b(teraz|następnie|najpierw|potem|wyślę|uruchomię|odczytam|przeczytam|sprawdzę|wykonam|dopiszę|zapiszę|przejdę|zrobię|użyję|wprowadzę|poprawię|utworzę|skopiuję|now i will|next,? i('ll| will)|let me|i will now)\b/i
// pure function — tested without opencode
export function isAnnouncedStep(stepText: string, calls: number, finish: unknown): boolean {
  if (calls === 0 || finish === "tool-calls" || finish === "length" || finish === "error") return false
  const t = stepText.trim()
  if (!t) return false
  const tail = t.split(/\n\s*\n/).pop()!.slice(-300) // last paragraph
  if (/\?\s*$/.test(tail)) return false // a question to the user — let them answer
  if (/exit=\d|```\s*$/.test(tail)) return false // ends with results
  return ANNOUNCE_RE.test(tail)
}

// 10-28: the command from a call written as text, quoted back so the model only has to re-send it as a real
// call (the plugin can't run tools itself, and running them here would skip danger-guard and permissions)
const CMD_PATTERNS = [
  /\bcommand\s*[:=]\s*(`|"|')((?:\\.|(?!\1)[^\\])+?)\1/,
  /(?<![\w.])(?:tools\.)?(?:shell|bash)\s*\(\s*(`|"|')((?:\\.|(?!\1)[^\\])+?)\1/,
  /<\s*(?:shell|bash)\b[^>\n]*>\s*\n?([^<]+?)\s*<\/\s*(?:shell|bash)\s*>/,
]
export function extractCommand(text: string): string {
  for (const re of CMD_PATTERNS) {
    const m = text.match(re)
    const cmd = (m?.[2] ?? m?.[1] ?? "").replace(/\\(["'`])/g, "$1").trim()
    if (cmd && !cmd.includes("\n") && cmd.length <= 500) return cmd
  }
  return ""
}

// 10-28 Gemma (23/28/29): zero calls, whole site "written" as python open(...).write / cat > blocks in text,
// then "Plik został utworzony". The note names the files that really don't exist on disk.
const WRITE_PATTERNS = [
  /\bopen\s*\(\s*(?:r|f)?(['"])([^'"\n]+)\1\s*,\s*(['"])[wax]b?\+?\3/g,
  /\bPath\s*\(\s*(['"])([^'"\n]+)\1\s*\)\s*\.write_(?:text|bytes)/g,
  /\bwriteFileSync\s*\(\s*(['"`])([^'"`\n]+)\1/g,
  /\b(?:cat|echo|printf)\b[^\n|;&]*?>>?\s*(['"]?)([^\s'"<>|;&]+)\1/g,
  /\btee\s+(?:-a\s+)?(['"]?)([^\s'"<>|;&]+)\1/g,
]
export function extractWrittenFiles(text: string): string[] {
  const out: string[] = []
  for (const re of WRITE_PATTERNS)
    for (const m of text.matchAll(re)) if (!out.includes(m[2]) && m[2] !== "/dev/null") out.push(m[2])
  return out
}

// relative names resolve against the first absolute directory in the user's prompt
export function missingFiles(userText: string, assistantText: string, exists: (p: string) => boolean): string[] {
  const base = userText.match(/(?:^|[\s"'`(])((?:~|\/home)\/[^\s"'`),;]+)/)?.[1]?.replace(/^~/, HOME).replace(/[.:]$/, "")
  return extractWrittenFiles(assistantText).filter((f) => {
    const p = f.startsWith("~/") ? join(HOME, f.slice(2)) : f.startsWith("/") ? f : base ? join(base, f) : ""
    return p !== "" && !exists(p)
  }).slice(0, 6)
}

export function noteFor(userText: string, assistantText = "", exists: (p: string) => boolean = existsSync): string {
  const base = ACTION.test(userText) && !HOWTO.test(userText) ? NOTE_DO : NOTE
  const cmd = extractCommand(assistantText)
  const missing = missingFiles(userText, assistantText, exists)
  let note = cmd
    ? base + ` The command you wrote as text: \`${cmd}\` — if it has to be run, send it EXACTLY as a shell tool call (in Code Mode \`execute\`).`
    : base
  if (missing.length)
    note += ` You wrote these files only as text and they do NOT exist on disk: ${missing.map((f) => `\`${f}\``).join(", ")} — ` +
      "create each of them with the write tool (in Code Mode `execute`), then check with `ls` that they exist."
  return note
}

const HANDOFF = /uruchom\s+r(ę|e)cznie|run\s+manually/iu
const SHELL_BLOCK = /```(?:bash|sh|shell|console|fish|zsh)\s*\n[\s\S]*?```/i
const ANY_BLOCK = /```[^\n]*\n[\s\S]*?```/g
// an order to act in the prompt (not a "how …" question); Polish and English verbs
// word boundaries via \p{L}, because \b in JS does not see non-ASCII letters ("sprawdź" at the end of a word)
const ACTION = /(?<!\p{L})(wykonaj|uruchom|odpal|sprawdź|sprawdz|przeczytaj|wyświetl|wyswietl|pokaż wynik|wklej|usuń|usun|zmień|zmien|popraw|edytuj|utwórz|utworz|stwórz|stworz|zapisz|skopiuj|przenieś|przenies|dodaj|zainstaluj|napraw|run|execute|check|show the output|paste|delete|remove|rename|change|fix|edit|create|save|copy|move|install)(?!\p{L})/iu
// tool call written as TEXT instead of a real call (Gemma 4, 10-21): `tools.shell({...})` from the Code Mode API,
// `<shell command="..."/>`, `shell(command=...)`. Unambiguous -> fires without an action verb in the prompt.
// 10-29 Gemma (29-blog-post-sitelint): 3 real calls, then 6 `<tool_call>{json}</tool_call>` blocks with made-up
// responses ("has been written") in the final text — no file was created.
const FAKE_CALL = /(?<![\w.])tools\.\w+\s*\(|<\s*(?:shell|bash|read|edit|write|execute|grep|glob|tool_call)\b[^>\n]*\/?>|(?<![\w.])(?:shell|bash|execute)\s*\(\s*(?:command\s*=|\{)/i
// 10-28 Gemma (16-minimal-diff): after real calls the last step writes the next calls as a lone backticked line
// (`edit stats.py oldString: …`, `python3 test_stats.py`) or announces a fix with only a ``` block — nothing ran
const INLINE_CALL = /^[ \t]*`(?:read|edit|write|shell|bash|grep|glob|python3?|node|cat|ls|sed|pytest)\s[^`\n]{1,400}`[ \t]*$/m
const ANNOUNCED_BLOCK = /(?<!\p{L})(?:uruchamiam|poprawiam|zmieniam|edytuj[eę]|zapisuj[eę]|tworz[eę]|wprowadzam|running|fixing|changing|editing|writing|creating|applying)(?!\p{L})[^\n]*\n+\s*```/iu
const PROMPT_CMD = /:[ \t]*\n\s*(?:cat|ls|head|tail|wc|grep|find|stat|du|df|file|sort|diff|python3?|bash|sh|git)\s+\S/
const DONE_CLAIM = /(?<!\bnie\s)(?<!\p{L})(usunąłem|usunęłam|zmieniłem|zmieniłam|utworzyłem|utworzyłam|stworzyłem|skopiowałem|przeniosłem|zapisałem|zmodyfikowałem|poprawiłem|wykonałem|uruchomiłem|zainstalowałem|zaktualizowałem|edytowałem|dodałem|I (?:have )?(?:deleted|removed|changed|created|copied|moved|saved|modified|fixed|ran|installed|updated|edited|added))(?!\p{L})[^\n]{0,40}?(plik|katalog|file|directory|folder|`|\/)/iu
const HANDOFF_SCRIPT = /(?:r(?:ę|e)cznie|manually)[\s\S]{0,200}?sudo\s+(?:(?:bash|sh)\s+)?[`'"]?\S*?([\w.-]+\.sh)\b/iu
const HOWTO = /^\s*(jak|how|w jaki sposób|czy da się|czy można|can i|is it possible)(?!\p{L})/iu

// pure function — tested without opencode
export function shouldFire(userText: string, assistantText: string, calls: number, lastStepText = ""): boolean {
  if (HOWTO.test(userText)) return false
  // 10-23 Gemma (08-long-file-lookup): two real reads, then the last step ends with `print(shell(command="grep …"))`
  // as text — the earlier calls must not hide a fake call in the step that ends the turn
  if (FAKE_CALL.test(lastStepText)) return true
  if (INLINE_CALL.test(lastStepText) || (ACTION.test(userText) && ANNOUNCED_BLOCK.test(lastStepText))) return true
  if (calls > 0) return false
  if (FAKE_CALL.test(assistantText)) return true
  // a correct hand-off of a root command to the user (tasks 09/19) — no call is the right thing here
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
  // signature of a fabrication: a command block + at least one OTHER block (the supposed output)
  if (SHELL_BLOCK.test(assistantText) && blocks.length >= 2) return true
  // or a block (with or without a language) retypes the command from the prompt instead of calling it
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
    // don't break the session
  }
}

type State = { calls: number; text: string; stepText: string; user: string; fired: boolean; emptyFired: boolean; announced?: number }

export default {
  id: "no-call-guard",
  async setup(ctx: {
    event: { subscribe: (o: { signal: AbortSignal }) => AsyncIterable<{ type: string; [k: string]: unknown }> }
    session: { synthetic: (o: Record<string, unknown>) => Promise<unknown> }
  }) {
    const controller = new AbortController()
    async function fire(sessionID: string, s: State, delivery: "steer" | "queue", lastStepText = "") {
      if (s.fired || !shouldFire(s.user, s.text, s.calls, lastStepText)) return
      s.fired = true // at most once per user prompt — no loops
      log(`HIT ${sessionID} mode=${MODE} via=${delivery} user=${JSON.stringify(s.user.slice(0, 120))} text=${JSON.stringify(s.text.slice(0, 200))}`)
      if (MODE !== "act") return
      try {
        await ctx.session.synthetic({ sessionID, text: noteFor(s.user, lastStepText || s.text), description: "no-call-guard", delivery })
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
    async function fireAnnounce(sessionID: string, s: State, stepText: string) {
      s.announced = (s.announced ?? 0) + 1
      if (s.announced > ANNOUNCE_MAX) return // no endless loop
      log(`ANNOUNCE ${sessionID} n=${s.announced} text=${JSON.stringify(stepText.slice(-160))}`)
      try {
        await ctx.session.synthetic({ sessionID, text: NOTE_ANNOUNCE, description: "no-call-guard", delivery: "steer" })
        log(`synthetic sent ${sessionID} delivery=steer kind=announce`)
      } catch (e) {
        log(`synthetic error ${sessionID}: ${String(e)}`)
      }
    }
    log(`plugin-load no-call-guard mode=${MODE}`)
    const g = globalThis as any
    // the plugin has an instance per location, and the stream is shared — each event once
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
              // our own note is not a user prompt
              if (item.type === "user") {
                s.user = String(item.payload?.text ?? item.text ?? item.data?.text ?? "")
                if (!s.user) log(`inbox without text, shape: ${JSON.stringify(item).slice(0, 300)}`)
                s.fired = false
                s.emptyFired = false
                s.announced = 0
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
            // end of a step without calls = the model is about to end the turn. The note goes NOW as a "steer",
            // because after execution.succeeded `opencode run` exits and interrupts the resumed step ("Step interrupted").
            case "session.step.ended": {
              const stepText = s.stepText
              s.stepText = ""
              if (d.finish === "tool-calls") break
              if (isEmptyTurn(stepText, s.calls, d.finish)) await fireEmpty(sessionID, s)
              else if (isAnnouncedStep(stepText, s.calls, d.finish)) await fireAnnounce(sessionID, s, stepText)
              else await fire(sessionID, s, "steer", stepText)
              break
            }
            case "session.execution.succeeded":
              await fire(sessionID, s, "queue") // fallback when step.ended did not arrive
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
