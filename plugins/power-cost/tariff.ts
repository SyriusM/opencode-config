import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Stawka za kWh dla power-cost (bez UI, żeby dało się testować w node).

export type Tariff = { perKwh: number; currency: string; source: string }

export const FALLBACK_TARIFF: Tariff = { perKwh: 1.26, currency: "zł", source: "domyślna" }
const cacheFile = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "power-cost.json")
const CACHE_MAX_AGE_MS = 30 * 24 * 3_600_000
const EUROSTAT_URL = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_pc_204"

// Kraje spoza strefy euro: Eurostat podaje cenę w walucie kraju (NAC). Reszta w EUR.
const NATIONAL_CURRENCY: Record<string, string> = {
  PL: "zł", CZ: "Kč", HU: "Ft", RO: "lei", SE: "kr", DK: "kr", NO: "kr", IS: "kr", CH: "CHF",
}
// Kody ISO, które Eurostat zapisuje inaczej.
const EUROSTAT_GEO: Record<string, string> = { GR: "EL", GB: "UK" }

export function detectCountry(): string | null {
  const explicit = process.env.POWER_COST_COUNTRY?.trim().toUpperCase()
  if (explicit) return explicit
  // pl_PL.UTF-8 → PL
  const match = /^[a-z]{2,3}_([A-Z]{2})/.exec(process.env.LC_ALL || process.env.LANG || "")
  return match ? match[1] : null
}

function manualTariff(country: string | null): Tariff | null {
  const perKwh = Number.parseFloat(process.env.POWER_COST_PER_KWH ?? process.env.POWER_COST_PLN_PER_KWH ?? "")
  if (!Number.isFinite(perKwh) || perKwh <= 0) return null
  const currency =
    process.env.POWER_COST_CURRENCY ||
    (process.env.POWER_COST_PER_KWH ? NATIONAL_CURRENCY[country ?? ""] ?? "€" : "zł")
  return { perKwh, currency, source: "ręczna" }
}

type CachedTariff = Tariff & { country: string; fetchedAt: number }

async function readCache(country: string): Promise<CachedTariff | null> {
  try {
    const cached = JSON.parse(await readFile(cacheFile(), "utf8")) as CachedTariff
    return cached.country === country && cached.perKwh > 0 ? cached : null
  } catch {
    return null
  }
}

async function fetchEurostat(country: string): Promise<Tariff | null> {
  const currency = NATIONAL_CURRENCY[country]
  const params = new URLSearchParams({
    format: "JSON",
    geo: EUROSTAT_GEO[country] ?? country,
    nrg_cons: "KWH2500-4999",
    tax: "I_TAX",
    currency: currency ? "NAC" : "EUR",
    unit: "KWH",
    lastTimePeriod: "4",
  })
  try {
    const response = await fetch(`${EUROSTAT_URL}?${params}`, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const data = (await response.json()) as {
      value: Record<string, number>
      dimension: { time: { category: { index: Record<string, number> } } }
    }
    // Jeden kraj → klucz wartości = indeks półrocza; bierzemy najnowsze z wartością.
    const periods = Object.entries(data.dimension.time.category.index).sort((a, b) => b[1] - a[1])
    for (const [period, index] of periods) {
      const perKwh = data.value[String(index)]
      if (perKwh > 0) return { perKwh, currency: currency ?? "€", source: `Eurostat ${period}` }
    }
    return null
  } catch {
    return null
  }
}

export async function resolveTariff(): Promise<Tariff> {
  const country = detectCountry()
  const manual = manualTariff(country)
  if (manual) return manual
  if (country == null) return FALLBACK_TARIFF

  const cached = await readCache(country)
  if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) return cached

  const fetched = await fetchEurostat(country)
  if (fetched) {
    const entry: CachedTariff = { ...fetched, country, fetchedAt: Date.now() }
    await mkdir(dirname(cacheFile()), { recursive: true }).catch(() => {})
    await writeFile(cacheFile(), JSON.stringify(entry, null, 2)).catch(() => {})
    return fetched
  }
  return cached ?? FALLBACK_TARIFF
}
