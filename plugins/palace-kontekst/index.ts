import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { execFile } from "node:child_process"

// PALACE-KONTEKST — dokleja do promptu systemowego krótkie tło z mempalace dla katalogu sesji
// (najwyżej 3 notatki, ~1 KB) albo ostrzeżenie, że palace/embeddingi leżą. Tekst daje
// ~/bin/palace-kontekst (zmierzone ~0,7 s; wynik w pamięci podręcznej na katalog, 10 min).
//
// Hook V2: ctx.session.hook("context", cb) — tak robią wbudowane wtyczki opencode 2.0.24
// (`i.system.push({type:"text", text})`). Tekst stały w obrębie katalogu → nie psuje cache promptu.
// Nigdy nie rzucamy z hooka. Log: ~/.mempalace/hook_state/palace_kontekst.log

const HOME = process.env.HOME ?? "/home/user"
const LOG = join(HOME, ".mempalace", "hook_state", "palace_kontekst.log")
const SKRYPT = join(HOME, "bin", "palace-kontekst")
const WAZNOSC_MS = 10 * 60_000

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

const cache = new Map<string, { czas: number; tekst: string }>()
const wToku = new Map<string, Promise<string>>()

function pobierz(katalog: string): Promise<string> {
  const c = cache.get(katalog)
  if (c && Date.now() - c.czas < WAZNOSC_MS) return Promise.resolve(c.tekst)
  const trwa = wToku.get(katalog)
  if (trwa) return trwa
  const p = new Promise<string>((resolve) => {
    execFile(SKRYPT, [katalog], { timeout: 15_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const tekst = err ? "" : String(stdout).trim()
      if (err) log(`skrypt padł dla ${katalog}: ${String(err).slice(0, 200)}`)
      if (cache.size > 100) cache.clear()
      cache.set(katalog, { czas: Date.now(), tekst })
      wToku.delete(katalog)
      log(`pobrano ${katalog}: ${tekst.length} znaków`)
      resolve(tekst)
    })
  })
  wToku.set(katalog, p)
  return p
}

export default {
  id: "palace-kontekst",
  async setup(ctx: any) {
    // V2: katalog sesji w ctx.location.directory (instancja wtyczki na lokalizację); cwd procesu to zwykle ~
    const domyslny = String(ctx?.location?.directory ?? process.cwd())
    log(`plugin-load ctx=[${Object.keys(ctx ?? {}).join(",")}] katalog=${domyslny}`)
    void pobierz(domyslny) // rozgrzanie, zanim padnie pierwsze pytanie

    if (typeof ctx?.session?.hook !== "function") {
      log("BRAK ctx.session.hook — wtyczka nic nie robi")
      return
    }
    let pokazano = false
    const zalogowane = new Set<string>()
    await ctx.session.hook("context", async (p: any) => {
      try {
        if (!pokazano) {
          pokazano = true
          log(`kształt context: [${Object.keys(p ?? {}).join(",")}] system=${Array.isArray(p?.system) ? p.system.length : typeof p?.system}`)
        }
        if (!Array.isArray(p?.system)) return
        const katalog = domyslny
        // czekamy najwyżej 3 s; jak nie zdąży, kontekst dojdzie przy następnym wywołaniu
        const tekst = await Promise.race([pobierz(katalog), new Promise<string>((r) => setTimeout(() => r(""), 3000))])
        if (tekst) {
          p.system.push({ type: "text", text: tekst })
          const sid = String(p?.sessionID)
          if (!zalogowane.has(sid)) {
            if (zalogowane.size > 1000) zalogowane.clear()
            zalogowane.add(sid)
            log(`doklejono ${tekst.length} zn. session=${sid}`)
          }
        }
      } catch (e) {
        log(`hook context padł: ${String(e).slice(0, 200)}`)
      }
    })
    log("hook context zarejestrowany")
  },
}
