import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// AUTO-KOPIE — siatka bezpieczeństwa: przed każdą zmianą pliku konfiguracji opencode, skilla, usługi albo skryptu
// zapisuje jego poprzednią wersję. Osobna wtyczka CELOWO: nie zależy od tool-input-fix (którą /autodiag edytuje),
// więc działa także wtedy, gdy tamta jest zepsuta. TEJ WTYCZKI NIE EDYTUJE SIĘ podczas /autodiag — strażnik
// (~/oc-audyt/straznik-wtyczki.sh) pilnuje jej sumy kontrolnej i przywraca oryginał.
// Hook V2: ctx.tool.hook("execute.before"). Nigdy nie blokuje narzędzia i nigdy nie rzuca.
// Log: ~/.mempalace/hook_state/tool_input_fix.log (wpisy KOPIA). Cofanie: ~/bin/oc-kopie.

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "tool_input_fix.log")

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

// ── AUTOMATYCZNE KOPIE ────────────────────────────────────────────────────────────────────────────
// Przed każdą zmianą pliku konfiguracji opencode / skilla / usługi zapisujemy jego poprzednią wersję do
// ~/oc-audyt/auto-kopie/ŚCIEŻKA__Z__PODKREŚLENIAMI.RRRRMMDD-GGMMSS — niezależnie od tego, czy model o tym pamięta.
// Przywracanie: ~/bin/oc-kopie. Nigdy nie blokujemy narzędzia i nigdy nie rzucamy.
const KOPIE = join(HOME, "oc-audyt", "auto-kopie")
const CHRONIONE = [
  /^\.config\/opencode\/(AGENTS\.md|opencode\.json|cli\.json)$/,
  /^\.config\/opencode\/(prompts|command)\/[^/]+$/,
  /^\.config\/opencode\/plugins\/(?!.*node_modules).+\.(ts|tsx|js|json)$/,
  /^\.claude\/skills\/.+/,
  /^\.config\/systemd\/user\/.+\.(service|socket|timer|conf)$/,
  /^bin\/[^/]+$/,
  /^CLAUDE\.md$/,
  // test i strażnik wtyczki — żeby zmianę w nich też dało się cofnąć
  /^oc-audyt\/(przypadki-[\w-]+\.json|test-wtyczki\.(sh|mjs)|straznik-wtyczki\.sh|powtorka-historii\.sh|licznik-bledow\.py)$/,
]

function pelnaSciezka(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined
  let s = v.trim()
  if (s === "~" || s.startsWith("~/")) s = HOME + s.slice(1)
  if (!s.startsWith("/")) s = join(HOME, s)
  return join(s) // normalizacja ../
}

function chroniona(abs: string): boolean {
  if (!abs.startsWith(HOME + "/")) return false
  const rel = abs.slice(HOME.length + 1)
  if (/\.bak[-.]|\/auto-kopie\//.test(rel)) return false
  return CHRONIONE.some((re) => re.test(rel))
}

function kopiaPliku(abs: string): string | undefined {
  try {
    if (!chroniona(abs) || !existsSync(abs)) return undefined
    const st = statSync(abs)
    if (!st.isFile() || st.size > 2_000_000) return undefined
    mkdirSync(KOPIE, { recursive: true })
    const baza = "H__" + abs.slice(HOME.length + 1).replace(/\//g, "__")
    const istniejace = readdirSync(KOPIE).filter((f) => f.startsWith(baza + ".")).sort()
    const ostatnia = istniejace[istniejace.length - 1]
    // bez duplikatów: ta sama treść co ostatnia kopia = nic nie rób
    if (ostatnia && readFileSync(join(KOPIE, ostatnia)).equals(readFileSync(abs))) return undefined
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, "0")
    const znacznik = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    const cel = join(KOPIE, `${baza}.${znacznik}`)
    copyFileSync(abs, cel)
    // najwyżej 30 kopii na plik
    for (const stara of istniejace.slice(0, Math.max(0, istniejace.length - 29))) unlinkSync(join(KOPIE, stara))
    return cel
  } catch {
    return undefined
  }
}

// Zwraca listę wykonanych kopii. Narzędzia plikowe: po kluczu path. Shell: każde słowo polecenia sprawdzamy
// jako ścieżkę względem katalogu domowego, katalogu roboczego sesji i wszystkich katalogów z `cd …` w poleceniu
// (modele piszą `cd ~/.config/opencode && sed -i … AGENTS.md`). kopiaPliku() sama odrzuca pliki niechronione.
function autoKopia(tool: string, input: any, cwd?: string): string[] {
  const zrobione: string[] = []
  const widziane = new Set<string>()
  const dodajAbs = (abs: string | undefined) => {
    if (!abs || widziane.has(abs)) return
    widziane.add(abs)
    const k = kopiaPliku(abs)
    if (k) zrobione.push(k)
  }
  try {
    if (!input || typeof input !== "object") return zrobione
    const baza = typeof cwd === "string" && cwd.startsWith("/") ? cwd : HOME
    const wzgledem = (dir: string, v: string) => {
      let t = v.replace(/^\$HOME|^\$\{HOME\}/, HOME)
      if (t === "~" || t.startsWith("~/")) t = HOME + t.slice(1)
      return t.startsWith("/") ? join(t) : join(dir, t)
    }
    if (/^(edit|write|patch|multiedit)$/.test(tool) || /^filesystem_(write_file|edit_file|move_file)$/.test(tool)) {
      for (const k of ["path", "filePath", "file_path", "source", "destination"]) {
        const v = input[k]
        if (typeof v !== "string" || !v) continue
        dodajAbs(wzgledem(baza, v))
        if (baza !== HOME) dodajAbs(wzgledem(HOME, v))
      }
    } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
      const cmd: string = input.command
      // jedno polecenie tylko do odczytu → bez kopii
      if (/^\s*(cat|grep|rg|ls|head|tail|wc|diff|stat|file|less|find|du)\b[^|;&>]*$/.test(cmd)) return zrobione
      const slowa = cmd.split(/[\s"'`;|&<>()=]+/).filter((w) => w && !w.startsWith("-") && w.length < 300)
      // katalogi robocze: start + kolejne `cd X` (każdy liczony względem poprzedniego)
      const katalogi = [baza]
      if (baza !== HOME) katalogi.push(HOME)
      let biezacy = baza
      for (let n = 0; n < slowa.length - 1; n++) {
        if (slowa[n] === "cd" || slowa[n] === "pushd") {
          biezacy = wzgledem(biezacy, slowa[n + 1])
          katalogi.push(biezacy)
        }
      }
      for (const w of slowa) {
        if (!/[./~$]/.test(w)) continue // interesują nas tylko słowa wyglądające na ścieżkę albo plik z rozszerzeniem
        for (const d of katalogi) dodajAbs(wzgledem(d, w))
      }
    }
  } catch {}
  return zrobione
}

export default {
  id: "auto-backup",
  async setup(ctx: any) {
    await ctx.tool.hook("execute.before", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        const input = ev.input
        for (const k of autoKopia(tool, input, ev.directory ?? ev.cwd ?? input?.cwd ?? input?.workdir)) log(`KOPIA ${tool} → ${k}`)
      } catch (e) {
        log(`auto-kopie hook failed: ${e}`)
      }
    })
    log("auto-kopie loaded")
  },
}
