import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

// DANGER-GUARD — blocks dangerous and outbound shell commands BEFORE they run.
// Wzorce przeniesione z Goose (block/goose, crates/goose/src/security/patterns.rs + egress_inspector.rs, 10-23),
// trimmed to those that give no false alarms on our history (~/oc-audyt/danger-guard/test.mjs).
// Skipped from Goose: systemctl enable (used daily), eval/$(…) (scripts), nc -l, nmap, touch -t,
// chroot/unshare (the Goose regex caught every "--net"), adversary (second model = GPU time, fail-open).
// Added by us: rm -rf on our own $HOME, nvme in dd, wipefs/blkdiscard, git push / gh … create,
// package publishing, sending data with curl/wget/scp/rsync to a non-local host.
// opencode.json already blocks `sudo *` and `rm -rf *` — this is a second layer, also for Code Mode code (`execute`).
// Protection against ACCIDENTAL model mistakes, not deliberate bypass: file writes (write/edit) are not checked,
// nor are Python/node scripts or scripts called from scripts. That is what bwrap in tests and the sudo ban are for.
// Hook V2: ctx.tool.hook("execute.before"), blocks by replacing the input (like tool-input-fix). Never throws.
// Disable for one session: DANGER_GUARD=off. Log: ~/.mempalace/hook_state/danger_guard.log

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
  { name: "rm_rf_root", re: new RegExp(String.raw`\b${RM_FLAGS}['"]?/(\./)*(\*)?['"]?(\s|[;&|)},]|$)`), why: "deletes the whole file system" },
  { name: "rm_rf_home", re: new RegExp(String.raw`\b${RM_FLAGS}['"]?${HOME_TARGET}${END}`), why: "deletes the whole home directory" },
  { name: "dd_disk", re: /\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|mmcblk\d)/, why: "nadpisuje dysk" },
  { name: "format_disk", re: /\b(mkfs(\.[a-z0-9]+)?|wipefs|blkdiscard)\s+.*\/dev\//, why: "formats/wipes a disk" },
  // --- Goose: obcy kod ---
  { name: "curl_pipe_shell", re: new RegExp(String.raw`\b(curl|wget)\s+.*\|\s*['"]?([\w.-]*/)*${SHELLS}(['"]|\s|[;&|<>]|$)`), why: "uruchamia skrypt prosto z sieci" },
  { name: "shell_procsub_curl", re: new RegExp(String.raw`\b${SHELLS}\s*<\s*\(\s*(curl|wget)\b`), why: "uruchamia skrypt prosto z sieci" },
  { name: "decode_pipe_shell", re: new RegExp(String.raw`\b(base64\s+(-d|--decode)|xxd\s+-r)\b.*\|\s*${SHELLS}\b`), why: "runs an encoded command" },
  // --- Goose: sekrety i uprawnienia ---
  { name: "ssh_key_network", re: /\b(curl|wget|nc|ncat|scp|rsync)\b.*\.ssh\/id_[a-z0-9]+(?!\.pub)\b/, why: "sends a private SSH key" },
  { name: "history_upload", re: /\b(curl|wget|nc|scp|rsync)\b.*(\.(bash_|zsh_)?history\b|fish_history)/, why: "sends the shell history" },
  { name: "shadow_file", re: /\/etc\/(shadow|gshadow)\b/, why: "reads the system passwords" },
  { name: "sudoers_write", re: /(>>?|\btee\b(\s+-a)?)\s*\/etc\/sudoers/, why: "zmienia sudoers" },
  { name: "reverse_shell", re: new RegExp(String.raw`\b(nc|ncat|netcat)\b.*\s-[ce]\s*\S*${SHELLS}\b|\b${SHELLS}\s+-i\b.*/dev/(tcp|udp)/|/dev/(tcp|udp)/\S+.*0>&1`), why: "opens a remote shell" },
  { name: "suid_bit", re: /\bchmod\s+(-[a-zA-Z]+\s+)*([ugo]*\+[a-z]*s|[2467][0-7]{3})\b/, why: "ustawia bit SUID/SGID" },
  { name: "kernel_module", re: /\b(insmod|rmmod)\b/, why: "loads/removes a kernel module" },
  { name: "docker_privileged", re: /\b(docker|podman)\s+(run|exec)\b.*--privileged/, why: "container with full host access" },
  // --- od nas: nieodwracalne w gicie ---
  { name: "git_reset_hard", re: /\bgit\s+(-C\s+\S+\s+)?reset\s+(.*\s)?--hard\b/, why: "kasuje niezapisane zmiany w repo" },
  { name: "git_clean_force", re: /\bgit\s+(-C\s+\S+\s+)?clean\s+(-[a-zA-Z]*f|.*--force)/, why: "deletes untracked files in the repo" },
  // --- ours + Goose egress: outbound actions (a publication stays on the internet) ---
  { name: "git_push", re: /\bgit\s+((-C|-c)\s+\S+\s+)*push\b/, why: "sends commits to a remote repo" },
  { name: "gh_write", re: /\bgh\s+(pr\s+(create|merge|close|comment|edit|review)|issue\s+(create|close|comment|edit)|release\s+(create|delete|upload|edit)|repo\s+(create|delete|edit|rename|archive)|gist\s+create|api\s+.*(-X\s*|--method\s+)(POST|PUT|PATCH|DELETE))\b/, why: "publikuje na GitHubie" },
  { name: "package_publish", re: /(^|[;&|]\s*|\s)(npm|pnpm|yarn|cargo|bun)\s+publish\b|\btwine\s+upload\b/, why: "publishes a package" },
]

// Local hosts — sending to them reaches our own servers (llama, opencode serve), not a leak.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)(:\d+)?$/i
// A POST with data typed into the command (e.g. the spansh API in ed-trade-overlay) is OK; we block sending
// a FILE (@file, -T, --upload-file, --post-file) or a subcommand's output ($(…), `…`) — that is what a leak looks like.
const CURL_FILE_UPLOAD = /(\s(-d|--data(-raw|-binary|-urlencode)?|--json)[\s=]*['"]?@|\s(-F|--form)[\s=]*['"]?[\w.[\]-]*=['"]?[@<]|\s(-T|--upload-file)[\s=])/
const CURL_DATA_SUBST = /\s(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form)[\s=]*['"]?[^\s'"]*(\$\(|`)/
const WGET_UPLOAD = /\s--(post|body)-file[\s=]/
const URL_HOST = /\b(?:https?|ftp):\/\/(?:[^@\/\s'"]+@)?(\[[^\]]+\]|[^\/\s'":?#]+)/gi
// host: something right after the colon or the end of the word (`rsync PID: $!` in echo is not a host)
const REMOTE_COPY = /\b(scp|rsync|sftp)\b.*?\s['"]?(?:[\w.-]+@)?([a-zA-Z0-9][\w.-]*):(?!\/\/)(?=[^\s]|$)/
// segments where the command only prints or searches text: their arguments are data, not commands
const TEXT_CMDS = /^(grep|egrep|fgrep|rg|ag|echo|printf|jq)$/

type Seg = { text: string; sep: string }

// Splits the command into segments on ; & && || | and newlines OUTSIDE quotes, skips comments (# at word start).
// Heredocs and nested substitutions are not fully parsed — this is a filter for typical model commands, not a bash parser.
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

// Heredoc bodies (<<EOF … EOF) are file data — unless they go straight into a shell (bash <<EOF).
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
  // the redirect stays: `echo … >> /etc/sudoers` must still hit the rule
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
      // no scheme (curl -T x example.com) -> a word that looks like a host
      if (!hosts.length) {
        const bare = seg.match(/\s['"]?((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|localhost|127\.\d+\.\d+\.\d+)(:\d+)?(\/\S*)?['"]?(\s|$)/)
        if (bare) hosts.push(bare[1])
      }
      const remote = hosts.filter((h) => !LOCAL_HOST.test(h))
      if (remote.length || !hosts.length) return { name: "http_upload", why: `sends a file/data to ${remote[0] ?? "an unknown host"}` }
    }
    const rc = seg.match(REMOTE_COPY)
    if (rc && !LOCAL_HOST.test(rc[2])) return { name: "remote_copy", why: `kopiuje pliki na ${rc[2]}` }
  }
  return null
}

// Scripts run from the command (bash x.sh, sh -e x.sh, source x.sh, . x.sh, ./x.sh, ~/bin/x.sh): the model may have
// just written them, so we check their content too (one level, no recursion). Python/node etc. are not read.
// Only the command position in a segment counts: `cat x.sh`, `chmod +x x.sh` and `bash -n x.sh` (syntax only) are not a run.
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
      if (/^-[a-zA-Z]*[nc]/.test(w[k])) return null  // -n = syntax only, -c = code in the argument (already checked)
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

// A script written by a heredoc in the same command (cat > x.sh <<EOF … EOF; bash x.sh) does not exist on disk yet,
// so we take its content from the command. 10-20: 35B bypassed the sudo ban this way (sudo pacman in a heredoc script).
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

// sudo in the command itself is rejected by the opencode permission ("sudo *": deny), but it cannot see it inside a script.
// Without a terminal sudo cannot get the password anyway, and failed attempts lock the account (faillock).
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
    if (s) return { name: "sudo_in_script", why: `needs root (${s[1]} in script ${p}) — the model cannot enter the password, failed attempts lock the account` }
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
    `[danger-guard] BLOCKED (${hit.name}): this command ${hit.why}. It was NOT run. ` +
    `Do not try to get around it with another command or tool. You will NOT run it even if the user asks or agrees ` +
    `— the block always applies. If the user really wants it, they must paste it THEMSELVES in their own terminal: ` +
    `write "Run MANUALLY in your terminal:" and give the exact command: ${shown}`
  )
}

// 11-05 Bonsai (task 09): the glob "*sudo *": deny in opencode.json rejects EVERY command with the word sudo and a space
// (also `command -v sudo`, `which sudo`), and the model only gets "Permission denied: shell" and tries 5 variants.
// We replace such a command with a message containing a hint. An opencode glob ending in " *" = optional space,
// so it matches EVERY occurrence of the string "sudo" (even "pseudo") — the message must not contain it at all.
const SUDO_GLOB = /sudo/
export function sudoHint(cmd: string): string | null {
  if (typeof cmd !== "string" || !SUDO_GLOB.test(cmd)) return null
  return (
    `[danger-guard] NOT run: opencode blocks every command that contains the name of the ` +
    `root-privilege program (s-u-d-o), even just checking it (which/command -v). Do not check whether that program exists, ` +
    `and do not try other variants. ` +
    `If the task needs root: do everything possible without root, and write to the user "Run MANUALLY ` +
    `in your terminal:" and give the exact command. Run the other checks with commands that do not contain that word.`
  )
}

// the string "sudo" in printf (e.g. a command in message()) -> the glob "*sudo *": deny would reject the message itself too.
// 11-09: instead of an invisible ZWSP (the model copied it into "Run MANUALLY" -> command not found) we split
// the word with quotes: the command contains su""do (the glob does not match), and the shell prints a real "sudo".
export const printfCommand = (text: string): string =>
  `printf '%s\\n' ${JSON.stringify(text).replace(/[`$]/g, "").replace(/sudo/g, 'su""do')} >&2; exit 1`

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
        const hint = hit || tool === "execute" ? null : sudoHint(cmd)
        if (!hit && !hint) return
        const text = hit ? message(hit, cmd) : hint!
        if (tool === "execute") ev.input = { ...input, code: `throw new Error(${JSON.stringify(text)})` }
        else ev.input = { ...input, command: printfCommand(text) }
        log(`BLOCK ${hit ? hit.name : "sudo_hint"} ses=${ev.sessionID ?? "?"} ${tool}: ${cmd.slice(0, 300).replace(/\n/g, "⏎")}`)
      } catch (e) {
        log(`danger-guard hook failed: ${e}`)
      }
    })
    log("danger-guard loaded")
  },
}
