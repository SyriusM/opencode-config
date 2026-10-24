import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

// DANGER-GUARD — blokuje groźne i wychodzące na zewnątrz komendy powłoki ZANIM się wykonają.
// Wzorce przeniesione z Goose (block/goose, crates/goose/src/security/patterns.rs + egress_inspector.rs, 10-23),
// przycięte do tych, które nie dają fałszywych alarmów na naszej historii (~/oc-audyt/danger-guard/test.mjs).
// Pominięte z Goose: systemctl enable (używamy co dzień), eval/$(…) (skrypty), nc -l, nmap, touch -t,
// chroot/unshare (regex Goose łapał każde „--net”), adversary (drugi model = czas karty, fail-open).
// Dodane od nas: rm -rf na własnym $HOME, nvme w dd, wipefs/blkdiscard, git push / gh … create,
// publikacja paczek, wysyłka danych curl/wget/scp/rsync na host inny niż lokalny.
// opencode.json już blokuje `sudo *` i `rm -rf *` — to druga warstwa, także dla kodu w Code Mode (`execute`).
// Ochrona przed PRZYPADKOWYMI wpadkami modelu, nie przed celowym obejściem: zapis pliku (write/edit) nie jest sprawdzany,
// skrypty Pythona/node ani skrypty wołane ze skryptów też nie. Od tego są bwrap w testach i zakaz sudo.
// Hook V2: ctx.tool.hook("execute.before"), blokada przez podmianę wejścia (jak tool-input-fix). Nigdy nie rzuca.
// Wyłączenie na jedną sesję: DANGER_GUARD=off. Log: ~/.mempalace/hook_state/danger_guard.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "danger_guard.log")
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

type Rule = { name: string; re: RegExp; why: string }

const RM_FLAGS = String.raw`rm\s+((--[a-zA-Z][a-zA-Z-]*|--|-[a-zA-Z]+)\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s+(--[a-zA-Z][a-zA-Z-]*|--|-[a-zA-Z]+))*\s+`
const HOME_TARGET = String.raw`(~|\$HOME|\$\{HOME\}|/home|/root|${escRe(HOME)})`
const END = String.raw`/?(\*)?['"]?(\s|[;&|)},]|$)`
const SHELLS = String.raw`(bash|sh|zsh|fish|dash)`

export const RULES: Rule[] = [
  // --- Goose: destrukcja ---
  { name: "rm_rf_root", re: new RegExp(String.raw`\b${RM_FLAGS}['"]?/(\./)*(\*)?['"]?(\s|[;&|)},]|$)`), why: "kasuje cały system plików" },
  { name: "rm_rf_home", re: new RegExp(String.raw`\b${RM_FLAGS}['"]?${HOME_TARGET}${END}`), why: "kasuje cały katalog domowy" },
  { name: "dd_disk", re: /\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d)/, why: "nadpisuje dysk" },
  { name: "format_disk", re: /\b(mkfs(\.[a-z0-9]+)?|wipefs|blkdiscard)\s+.*\/dev\//, why: "formatuje/czyści dysk" },
  // --- Goose: obcy kod ---
  { name: "curl_pipe_shell", re: new RegExp(String.raw`\b(curl|wget)\s+.*\|\s*['"]?([\w.-]*/)*${SHELLS}(['"]|\s|[;&|<>]|$)`), why: "uruchamia skrypt prosto z sieci" },
  { name: "shell_procsub_curl", re: new RegExp(String.raw`\b${SHELLS}\s*<\s*\(\s*(curl|wget)\b`), why: "uruchamia skrypt prosto z sieci" },
  { name: "decode_pipe_shell", re: new RegExp(String.raw`\b(base64\s+(-d|--decode)|xxd\s+-r)\b.*\|\s*${SHELLS}\b`), why: "uruchamia zakodowaną komendę" },
  // --- Goose: sekrety i uprawnienia ---
  { name: "ssh_key_network", re: /\b(curl|wget|nc|ncat|scp|rsync)\b.*\.ssh\/id_[a-z0-9]+(?!\.pub)\b/, why: "wysyła prywatny klucz SSH" },
  { name: "history_upload", re: /\b(curl|wget|nc|scp|rsync)\b.*(\.(bash_|zsh_)?history\b|fish_history)/, why: "wysyła historię powłoki" },
  { name: "shadow_file", re: /\/etc\/(shadow|gshadow)\b/, why: "czyta hasła systemu" },
  { name: "sudoers_write", re: /(>>?|\btee\b(\s+-a)?)\s*\/etc\/sudoers/, why: "zmienia sudoers" },
  { name: "reverse_shell", re: new RegExp(String.raw`\b(nc|ncat|netcat)\b.*\s-[ce]\s*\S*${SHELLS}\b|\b${SHELLS}\s+-i\b.*/dev/(tcp|udp)/|/dev/(tcp|udp)/\S+.*0>&1`), why: "otwiera zdalną powłokę" },
  { name: "suid_bit", re: /\bchmod\s+(-[a-zA-Z]+\s+)*([ugo]*\+[a-z]*s|[2467][0-7]{3})\b/, why: "ustawia bit SUID/SGID" },
  { name: "kernel_module", re: /\b(insmod|rmmod)\b/, why: "ładuje/usuwa moduł jądra" },
  { name: "docker_privileged", re: /\b(docker|podman)\s+(run|exec)\b.*--privileged/, why: "kontener z pełnym dostępem do hosta" },
  // --- od nas: nieodwracalne w gicie ---
  { name: "git_reset_hard", re: /\bgit\s+(-C\s+\S+\s+)?reset\s+(.*\s)?--hard\b/, why: "kasuje niezapisane zmiany w repo" },
  { name: "git_clean_force", re: /\bgit\s+(-C\s+\S+\s+)?clean\s+(-[a-zA-Z]*f|.*--force)/, why: "kasuje nieśledzone pliki w repo" },
  // --- od nas + Goose egress: wyjście na zewnątrz (publikacja zostaje w sieci) ---
  { name: "git_push", re: /\bgit\s+((-C|-c)\s+\S+\s+)*push\b/, why: "wysyła commity na zdalne repo" },
  { name: "gh_write", re: /\bgh\s+(pr\s+(create|merge|close|comment|edit|review)|issue\s+(create|close|comment|edit)|release\s+(create|delete|upload|edit)|repo\s+(create|delete|edit|rename|archive)|gist\s+create|api\s+.*(-X\s*|--method\s+)(POST|PUT|PATCH|DELETE))\b/, why: "publikuje na GitHubie" },
  { name: "package_publish", re: /(^|[;&|]\s*|\s)(npm|pnpm|yarn|cargo|bun)\s+publish\b|\btwine\s+upload\b/, why: "publikuje paczkę" },
]

// Hosty lokalne — wysyłka do nich to nasze serwery (llama, opencode serve), nie wyciek.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)(:\d+)?$/i
// Zapytanie POST z danymi wpisanymi w komendę (np. API spansh przy ed-trade-overlay) jest OK; blokujemy wysyłkę
// PLIKU (@plik, -T, --upload-file, --post-file) albo wyniku podkomendy ($(…), `…`) — tak wygląda wyciek.
const CURL_FILE_UPLOAD = /(\s(-d|--data(-raw|-binary|-urlencode)?|--json)[\s=]*['"]?@|\s(-F|--form)[\s=]*['"]?[\w.[\]-]*=['"]?[@<]|\s(-T|--upload-file)[\s=])/
const CURL_DATA_SUBST = /\s(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form)[\s=]*['"]?[^\s'"]*(\$\(|`)/
const WGET_UPLOAD = /\s--(post|body)-file[\s=]/
const URL_HOST = /\b(?:https?|ftp):\/\/(?:[^@\/\s'"]+@)?(\[[^\]]+\]|[^\/\s'":?#]+)/gi
// host: zaraz po dwukropku coś albo koniec słowa (`rsync PID: $!` w echo to nie host)
const REMOTE_COPY = /\b(scp|rsync|sftp)\b.*?\s['"]?(?:[\w.-]+@)?([a-zA-Z0-9][\w.-]*):(?!\/\/)(?=[^\s]|$)/
// kawałki, w których komenda tylko wypisuje albo szuka tekstu: ich argumenty to dane, nie polecenia
const TEXT_CMDS = /^(grep|egrep|fgrep|rg|ag|echo|printf|jq)$/

type Seg = { text: string; sep: string }

// Dzieli komendę na kawałki po ; & && || | i nowych liniach POZA cudzysłowami, pomija komentarze (# na początku słowa).
// Heredoc i podwójne podstawienia nie są parsowane w pełni — to filtr na typowe komendy modelu, nie parser basha.
function split(cmd: string): Seg[] {
  const out: Seg[] = []
  let cur = "", q = "", i = 0
  const push = (sep: string) => { out.push({ text: cur, sep }); cur = "" }
  while (i < cmd.length) {
    const ch = cmd[i]
    if (q) {
      if (ch === "\\" && q === '"' && i + 1 < cmd.length) { cur += ch + cmd[i + 1]; i += 2; continue }
      if (ch === q) q = ""
      cur += ch; i++; continue
    }
    if (ch === "\\" && i + 1 < cmd.length) { cur += ch + cmd[i + 1]; i += 2; continue }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; i++; continue }
    if (ch === "#" && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== "\n") i++; continue }
    const two = cmd.slice(i, i + 2)
    if (two === "&&" || two === "||") { push(two); i += 2; continue }
    if (ch === "|" && cmd[i - 1] !== ">") { push("|"); i++; continue }
    if (ch === "&" && cmd[i - 1] !== ">" && cmd[i + 1] !== ">") { push("&"); i++; continue }
    if (ch === ";" || ch === "\n") { push(ch); i++; continue }
    cur += ch; i++
  }
  push("")
  return out
}

// Treść heredoców (<<EOF … EOF) to dane pliku — chyba że trafia prosto do powłoki (bash <<EOF).
function stripHeredocs(cmd: string): string {
  return cmd.replace(/^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm, (m, pre, _q, tag, rest) =>
    new RegExp(String.raw`(^|[\s;&|(])(sudo\s+)?${SHELLS}(\s+-\S+)*\s*$`).test(pre) ? m : `${pre}<<${tag}${rest}`,
  )
}

function firstWord(seg: string): string {
  // pomija przypisania zmiennych, nawiasy i prefiksy typu timeout 5 / env / nice
  const words = seg.trim().replace(/^[({]+\s*/, "").split(/\s+/)
  let k = 0
  while (k < words.length && (/^\w+=/.test(words[k]) || /^(env|nice|nohup|command|time)$/.test(words[k]))) k++
  if (words[k] === "timeout") { k++; while (k < words.length && /^(-|\d)/.test(words[k])) k++ }
  return (words[k] ?? "").replace(/^.*\//, "")
}

function normalize(cmd: string): { full: string; segs: string[] } {
  const parts = split(stripHeredocs(cmd.replace(/\\\r?\n/g, " ")))
  // przekierowanie zostaje: `echo … >> /etc/sudoers` dalej ma trafić w regułę
  const kept = parts.map((p) =>
    TEXT_CMDS.test(firstWord(p.text)) ? { ...p, text: " true " + (p.text.match(/(\d?>>?|&>)\s*[^\s'"]+/g) ?? []).join(" ") + " " } : p,
  )
  return { full: kept.map((p) => p.text + p.sep).join(""), segs: kept.map((p) => p.text.trim()).filter(Boolean) }
}

function egress(segs: string[]): { name: string; why: string } | null {
  for (const seg of segs) {
    const s = " " + seg
    const upload = (/\bcurl\b/.test(seg) && (CURL_FILE_UPLOAD.test(s) || CURL_DATA_SUBST.test(s))) || (/\bwget\b/.test(seg) && WGET_UPLOAD.test(s))
    if (upload) {
      const hosts = [...seg.matchAll(URL_HOST)].map((m) => m[1])
      // bez schematu (curl -T x example.com) -> słowo wyglądające na host
      if (!hosts.length) {
        const bare = seg.match(/\s['"]?((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|localhost|127\.\d+\.\d+\.\d+)(:\d+)?(\/\S*)?['"]?(\s|$)/)
        if (bare) hosts.push(bare[1])
      }
      const remote = hosts.filter((h) => !LOCAL_HOST.test(h))
      if (remote.length || !hosts.length) return { name: "http_upload", why: `wysyła plik/dane na ${remote[0] ?? "nieznany host"}` }
    }
    const rc = seg.match(REMOTE_COPY)
    if (rc && !LOCAL_HOST.test(rc[2])) return { name: "remote_copy", why: `kopiuje pliki na ${rc[2]}` }
  }
  return null
}

// Skrypty uruchamiane z komendy (bash x.sh, sh -e x.sh, source x.sh, . x.sh, ./x.sh, ~/bin/x.sh): model mógł je
// przed chwilą zapisać, więc sprawdzamy też ich treść (jeden poziom, bez rekurencji). Python/node itp. nie są czytane.
// Liczy się tylko pozycja komendy w segmencie: `cat x.sh`, `chmod +x x.sh` i `bash -n x.sh` (sama składnia) to nie uruchomienie.
const SHELL_NAMES = /^(bash|sh|zsh|fish|dash)$/
const SCRIPT_PATH = /^(\.{1,2}|~|\/)\S*\.(sh|bash|zsh|fish)$/
const MAX_SCRIPT_BYTES = 256 * 1024

function scriptOf(seg: string): string | null {
  const w = seg.trim().replace(/^[({]+\s*/, "").split(/\s+/).map((x) => x.replace(/^['"]|['"]$/g, ""))
  let k = 0
  for (;;) {
    if (/^\w+=/.test(w[k] ?? "") || /^(env|nice|nohup|command|time|exec)$/.test(w[k] ?? "")) k++
    else if (w[k] === "timeout") { k++; while (/^(-|\d)/.test(w[k] ?? "")) k++ }
    else if (w[k] === "sudo") { k++; while ((w[k] ?? "").startsWith("-")) k++ }
    else break
  }
  const cmd = (w[k] ?? "").replace(/^.*\/(?=(bash|sh|zsh|fish|dash)$)/, "")
  if (SHELL_NAMES.test(cmd)) {
    k++
    while ((w[k] ?? "").startsWith("-")) {
      if (/^-[a-zA-Z]*[nc]/.test(w[k])) return null  // -n = tylko składnia, -c = kod w argumencie (już sprawdzony)
      k++
    }
    return w[k] && !w[k].startsWith("<") ? w[k] : null
  }
  if (cmd === "source" || cmd === ".") return w[k + 1] ?? null
  return SCRIPT_PATH.test(cmd) ? cmd : null
}

export function scriptsIn(cmd: string, cwd?: string): string[] {
  const out: string[] = []
  for (const seg of normalize(cmd).segs) {
    const p = scriptOf(seg)
    if (p) out.push(resolvePath(p, cwd))
  }
  return out
}

// Skrypt zapisany heredociem w tej samej komendzie (cat > x.sh <<EOF … EOF; bash x.sh) jeszcze nie istnieje na dysku,
// więc jego treść bierzemy z komendy. 10-20: 35B tak obchodził zakaz sudo (sudo pacman w skrypcie z heredoca).
const HEREDOC_FILE = /(?:>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";&|<>]+)\1[^\n]*?<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n[ \t]*\4[ \t]*(?=\n|$)/g
function heredocFiles(cmd: string, cwd?: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of cmd.matchAll(HEREDOC_FILE)) out.set(resolvePath(m[2], cwd), m[5])
  return out
}

function resolvePath(p: string, cwd?: string): string {
  if (p.startsWith("~/")) p = join(HOME, p.slice(2))
  return isAbsolute(p) ? p : join(cwd ?? process.cwd(), p)
}

// sudo w samej komendzie odrzuca permission opencode ("sudo *": deny), ale w treści skryptu go nie widzi.
// Bez terminala sudo i tak nie dostanie hasła, a nieudane próby blokują konto (faillock).
const SCRIPT_SUDO = /(?:^|[\s;&|(`])(sudo|pkexec|doas|su)\s+\S/m

export function checkWithScripts(cmd: string, cwd?: string): { name: string; why: string } | null {
  const hit = check(cmd)
  if (hit) return hit
  const written = heredocFiles(cmd, cwd)
  for (const p of scriptsIn(cmd, cwd)) {
    let body = written.get(p)
    if (body === undefined) {
      try {
        if (statSync(p).size > MAX_SCRIPT_BYTES) continue
        body = readFileSync(p, "utf8")
      } catch { continue }
    }
    const h = check(body)
    if (h) return { name: h.name, why: `${h.why} (w skrypcie ${p})` }
    const s = normalize(body).full.match(SCRIPT_SUDO)
    if (s) return { name: "sudo_in_script", why: `wymaga uprawnień roota (${s[1]} w skrypcie ${p}) — model nie poda hasła, nieudane próby blokują konto` }
  }
  return null
}

export function check(cmd: string): { name: string; why: string } | null {
  if (typeof cmd !== "string" || !cmd) return null
  const { full, segs } = normalize(cmd)
  for (const r of RULES) if (r.re.test(full)) return { name: r.name, why: r.why }
  return egress(segs)
}

export function message(hit: { name: string; why: string }, cmd: string): string {
  const shown = cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd
  return (
    `[danger-guard] ZABLOKOWANE (${hit.name}): ta komenda ${hit.why}. NIE została uruchomiona. ` +
    `Nie próbuj jej obejść inną komendą ani innym narzędziem. Ty jej NIE uruchomisz także po prośbie lub zgodzie ` +
    `użytkownika — blokada działa zawsze. Jeśli użytkownik naprawdę tego chce, musi ją wkleić SAM we własnym terminalu: ` +
    `napisz mu „Uruchom RĘCZNIE w swoim terminalu:” i podaj dokładną komendę: ${shown}`
  )
}

export default {
  id: "danger-guard",
  async setup(ctx: any) {
    if (process.env.DANGER_GUARD === "off") {
      log("danger-guard disabled (DANGER_GUARD=off)")
      return
    }
    await ctx.tool.hook("execute.before", (ev: any) => {
      try {
        const tool = String(ev.tool ?? "")
        const input = ev.input
        if (!input || typeof input !== "object") return
        let cmd: string | undefined
        if (/^(shell|bash|fish)$/.test(tool) && typeof input.command === "string") cmd = input.command
        else if (tool === "execute" && typeof input.code === "string") cmd = input.code
        if (!cmd) return
        const hit = checkWithScripts(cmd, input.workdir ?? input.cwd ?? ev.directory ?? ev.cwd)
        if (!hit) return
        const text = message(hit, cmd)
        if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(text)})` }
        else ev.input = { ...input, command: `printf '%s\\n' ${JSON.stringify(text).replace(/[`$]/g, "")} >&2; exit 1` }
        log(`BLOCK ${hit.name} ses=${ev.sessionID ?? "?"} ${tool}: ${cmd.slice(0, 300).replace(/\n/g, "⏎")}`)
      } catch (e) {
        log(`danger-guard hook failed: ${e}`)
      }
    })
    log("danger-guard loaded")
  },
}
