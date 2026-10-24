// Behaviour test for power-cost tariff resolution: fake fetch (no network), cache in a temp dir.
// Usage: HOME=$(mktemp -d) node --experimental-strip-types --no-warnings power-cost-tariff.test.mjs SRC
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { resolveTariff, FALLBACK_TARIFF } = await import(process.argv[2])
let fails = 0
const ok = (cond, name) => { if (!cond) { fails++; console.log("FAIL", name) } }

const ENV_KEYS = ["POWER_COST_PER_KWH", "POWER_COST_PLN_PER_KWH", "POWER_COST_CURRENCY", "POWER_COST_COUNTRY", "LANG", "LC_ALL"]
let requests = []
function setup(env, fetchImpl) {
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "power-cost-"))
  requests = []
  globalThis.fetch = async (url) => { requests.push(String(url)); return fetchImpl(String(url)) }
}
const cacheFile = () => join(process.env.XDG_CACHE_HOME, "power-cost.json")

// Eurostat JSON-stat shape for one country; null = semester without a value yet
function eurostat(periods) {
  const value = {}
  periods.forEach(([, v], i) => { if (v != null) value[String(i)] = v })
  const index = Object.fromEntries(periods.map(([p], i) => [p, i]))
  return { ok: true, json: async () => ({ value, dimension: { time: { category: { index } } } }) }
}
const offline = async () => { throw new Error("offline") }

setup({ POWER_COST_PER_KWH: "0.5", POWER_COST_COUNTRY: "DE" }, offline)
let t = await resolveTariff()
ok(t.perKwh === 0.5 && t.currency === "€" && t.source === "ręczna", "manual rate, euro country")
ok(requests.length === 0, "manual rate -> no request")

setup({ POWER_COST_PLN_PER_KWH: "1.1", LANG: "de_DE.UTF-8" }, offline)
t = await resolveTariff()
ok(t.perKwh === 1.1 && t.currency === "zł", "legacy PLN variable keeps zł")

setup({ LANG: "pl_PL.UTF-8" }, async () => eurostat([["2025-S1", 1.2], ["2025-S2", 1.1505], ["2026-S1", 1.2724], ["2026-S2", null]]))
t = await resolveTariff()
ok(t.perKwh === 1.2724 && t.currency === "zł" && t.source === "Eurostat 2026-S1", `latest semester with value (${JSON.stringify(t)})`)
ok(/geo=PL/.test(requests[0]) && /currency=NAC/.test(requests[0]) && /tax=I_TAX/.test(requests[0]), "request: PL, national currency, all taxes")
const cached = JSON.parse(readFileSync(cacheFile(), "utf8"))
ok(cached.country === "PL" && cached.perKwh === 1.2724, "cache written")

globalThis.fetch = offline
requests = []
t = await resolveTariff()
ok(t.perKwh === 1.2724 && requests.length === 0, "fresh cache -> no request")

writeFileSync(cacheFile(), JSON.stringify({ ...cached, fetchedAt: 0 }))
t = await resolveTariff()
ok(t.perKwh === 1.2724 && t.source === "Eurostat 2026-S1", "stale cache used when offline")

setup({ POWER_COST_COUNTRY: "gr" }, async () => eurostat([["2026-S1", 0.25]]))
t = await resolveTariff()
ok(/geo=EL/.test(requests[0]) && /currency=EUR/.test(requests[0]) && t.currency === "€", "GR -> Eurostat EL in EUR")

setup({ LANG: "C.UTF-8" }, offline)
t = await resolveTariff()
ok(t === FALLBACK_TARIFF && requests.length === 0, "unknown country -> fallback, no request")

setup({ LANG: "pl_PL.UTF-8" }, async () => ({ ok: false, json: async () => ({}) }))
t = await resolveTariff()
ok(t === FALLBACK_TARIFF, "HTTP error, no cache -> fallback")

console.log(fails ? `${fails} FAIL` : "power-cost tariff: 11 checks OK")
process.exit(fails ? 1 : 0)
