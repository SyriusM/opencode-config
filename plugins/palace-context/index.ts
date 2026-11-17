import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"

// PALACE-CONTEXT — appends to the system prompt a short background from mempalace for the session directory
// (at most 3 notes, ~1 KB) or a warning that the palace/embeddings are down. The text comes from
// ~/bin/palace-context (measured ~0.7 s; result cached per directory, 10 min).
//
// Hook V2: ctx.session.hook("context", cb) — as the built-in opencode 2.0.24 plugins do
// (`i.system.push({type:"text", text})`). The text is constant per directory → it does not break the prompt cache.
// We never throw from the hook. Log: ~/.mempalace/hook_state/palace_kontekst.log

const HOME = homedir()
const LOG = join(HOME, ".mempalace", "hook_state", "palace_context.log")
const SCRIPT = join(HOME, "bin", "palace-context")
const TTL_MS = 10 * 60_000

function log(line: string) {
  try {
    mkdirSync(join(LOG, ".."), { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

const cache = new Map<string, { time: number; text: string }>()
const inFlight = new Map<string, Promise<string>>()

function fetchContext(dir: string): Promise<string> {
  const c = cache.get(dir)
  if (c && Date.now() - c.time < TTL_MS) return Promise.resolve(c.text)
  const pending = inFlight.get(dir)
  if (pending) return pending
  const p = new Promise<string>((resolve) => {
    execFile(SCRIPT, [dir], { timeout: 15_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const ctxText = err ? "" : String(stdout).trim()
      if (err) log(`script failed for ${dir}: ${String(err).slice(0, 200)}`)
      if (cache.size > 100) cache.clear()
      cache.set(dir, { time: Date.now(), text: ctxText })
      inFlight.delete(dir)
      log(`fetched ${dir}: ${ctxText.length} chars`)
      resolve(ctxText)
    })
  })
  inFlight.set(dir, p)
  return p
}

export default {
  id: "palace-context",
  async setup(ctx: any) {
    // V2: the session directory is in ctx.location.directory (a plugin instance per location); the process cwd is usually ~
    const defaultDir = String(ctx?.location?.directory ?? process.cwd())
    log(`plugin-load ctx=[${Object.keys(ctx ?? {}).join(",")}] dir=${defaultDir}`)
    void fetchContext(defaultDir) // rozgrzanie, zanim padnie pierwsze pytanie

    if (typeof ctx?.session?.hook !== "function") {
      log("NO ctx.session.hook — plugin does nothing")
      return
    }
    let shown = false
    const logged = new Set<string>()
    await ctx.session.hook("context", async (p: any) => {
      try {
        if (!shown) {
          shown = true
          log(`context shape: [${Object.keys(p ?? {}).join(",")}] system=${Array.isArray(p?.system) ? p.system.length : typeof p?.system}`)
        }
        if (!Array.isArray(p?.system)) return
        const dir = defaultDir
        // we wait at most 3 s; if it is not ready, the context arrives with the next call
        const ctxText = await Promise.race([fetchContext(dir), new Promise<string>((r) => setTimeout(() => r(""), 3000))])
        if (ctxText) {
          p.system.push({ type: "text", text: ctxText })
          const sid = String(p?.sessionID)
          if (!logged.has(sid)) {
            if (logged.size > 1000) logged.clear()
            logged.add(sid)
            log(`appended ${ctxText.length} chars session=${sid}`)
          }
        }
      } catch (e) {
        log(`context hook failed: ${String(e).slice(0, 200)}`)
      }
    })
    log("context hook registered")
  },
}
