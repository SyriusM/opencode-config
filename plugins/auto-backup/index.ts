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
const BACKUP_DIR = join(HOME, "oc-audyt", "auto-kopie")
const PROTECTED = [
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

function fullPath(v: unknown): string | undefined {
  if (typeof v !== "string" || !v) return undefined
  let s = v.trim()
  if (s === "~" || s.startsWith("~/")) s = HOME + s.slice(1)
  if (!s.startsWith("/")) s = join(HOME, s)
  return join(s) // normalizacja ../
}

function isProtected(abs: string): boolean {
  if (!abs.startsWith(HOME + "/")) return false
  const rel = abs.slice(HOME.length + 1)
  if (/\.bak[-.]|\/auto-kopie\//.test(rel)) return false
  return PROTECTED.some((re) => re.test(rel))
}

function backupFile(abs: string): string | undefined {
  try {
    if (!isProtected(abs) || !existsSync(abs)) return undefined
    const st = statSync(abs)
    if (!st.isFile() || st.size > 2_000_000) return undefined
    mkdirSync(BACKUP_DIR, { recursive: true })
    const base = "H__" + abs.slice(HOME.length + 1).replace(/\//g, "__")
    const existing = readdirSync(BACKUP_DIR).filter((f) => f.startsWith(base + ".")).sort()
    const latest = existing[existing.length - 1]
    // bez duplikatów: ta sama treść co ostatnia kopia = nic nie rób
    if (latest && readFileSync(join(BACKUP_DIR, latest)).equals(readFileSync(abs))) return undefined
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, "0")
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
    const target = join(BACKUP_DIR, `${base}.${stamp}`)
    copyFileSync(abs, target)
    // najwyżej 30 kopii na plik
    for (const old of existing.slice(0, Math.max(0, existing.length - 29))) unlinkSync(join(BACKUP_DIR, old))
    return target
  } catch {
    return undefined
  }
}

// Zwraca listę wykonanych kopii. Narzędzia plikowe: po kluczu path. Shell: każde słowo polecenia sprawdzamy
// jako ścieżkę względem katalogu domowego, katalogu roboczego sesji i wszystkich katalogów z `cd …` w poleceniu
// (modele piszą `cd ~/.config/opencode && sed -i … AGENTS.md`). kopiaPliku() sama odrzuca pliki niechronione.
function autoBackup(tool: string, input: any, cwd?: string): string[] {
  const done: string[] = []
  const seen = new Set<string>()
  const addAbs = (abs: string | undefined) => {
    if (!abs || seen.has(abs)) return
    seen.add(abs)
    const k = backupFile(abs)
    if (k) done.push(k)
  }
  try {
    if (!input || typeof input !== "object") return done
    const base = typeof cwd === "string" && cwd.startsWith("/") ? cwd : HOME
    const relativeTo = (dir: string, v: string) => {
      let t = v.replace(/^\$HOME|^\$\{HOME\}/, HOME)
      if (t === "~" || t.startsWith("~/")) t = HOME + t.slice(1)
      return t.startsWith("/") ? join(t) : join(dir, t)
    }
    if (/^(edit|write|patch|multiedit)$/.test(tool) || /^filesystem_(write_file|edit_file|move_file)$/.test(tool)) {
      for (const k of ["path", "filePath", "file_path", "source", "destination"]) {
        const v = input[k]
        if (typeof v !== "string" || !v) continue
        addAbs(relativeTo(base, v))
        if (base !== HOME) addAbs(relativeTo(HOME, v))
      }
    } else if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") {
      const cmd: string = input.command
      // jedno polecenie tylko do odczytu → bez kopii
      if (/^\s*(cat|grep|rg|ls|head|tail|wc|diff|stat|file|less|find|du)\b[^|;&>]*$/.test(cmd)) return done
      const words = cmd.split(/[\s"'`;|&<>()=]+/).filter((w) => w && !w.startsWith("-") && w.length < 300)
      // katalogi robocze: start + kolejne `cd X` (każdy liczony względem poprzedniego)
      const dirs = [base]
      if (base !== HOME) dirs.push(HOME)
      let current = base
      for (let n = 0; n < words.length - 1; n++) {
        if (words[n] === "cd" || words[n] === "pushd") {
          current = relativeTo(current, words[n + 1])
          dirs.push(current)
        }
      }
      for (const w of words) {
        if (!/[./~$]/.test(w)) continue // interesują nas tylko słowa wyglądające na ścieżkę albo plik z rozszerzeniem
        for (const d of dirs) addAbs(relativeTo(d, w))
      }
    }
  } catch {}
  return done
}

export default {
  id: "auto-backup",
  async setup(ctx: any) {
    await ctx.tool.hook("execute.before", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        const input = ev.input
        for (const k of autoBackup(tool, input, ev.directory ?? ev.cwd ?? input?.cwd ?? input?.workdir)) log(`BACKUP ${tool} → ${k}`)
      } catch (e) {
        log(`auto-backup hook failed: ${e}`)
      }
    })
    log("auto-backup loaded")
  },
}
