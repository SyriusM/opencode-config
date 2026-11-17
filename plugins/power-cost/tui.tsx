import { exec } from "node:child_process"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { FALLBACK_TARIFF, resolveTariff, type Tariff } from "./tariff.ts"

// POWER-COST STATUSLINE (OpenCode V2, CLI plugin)
// Running cost of the electricity used by the GPU (NVIDIA) since the TUI started (in the tariff currency), plus the card state.
//   - sidebar (sidebar.content): the full "Power & GPU" section
//   - bottom (prompt.footer.status): a short version — visible also when the sidebar is hidden
//
// Tariff (the first available one wins):
//   1. POWER_COST_PER_KWH (or the old POWER_COST_PLN_PER_KWH) — by hand, gross from the bill,
//      currency from POWER_COST_CURRENCY (default by country),
//   2. Eurostat nrg_pc_204: average household price (2500–4999 kWh/year,
//      all taxes included), latest half-year; country from POWER_COST_COUNTRY or LANG,
//      cached in ~/.cache/power-cost.json for 30 days (a stale cache = fallback when offline),
//   3. 1.26 zł/kWh.
// Pomiar: nvidia-smi co 5 s, prosta integracja Wh. Model: aktywny unit llama-* (co 15 s).
//
// Plugin layout (required by discovery): index.ts + tui.tsx.

const SAMPLE_MS = 5_000
const MODEL_EVERY_N_TICKS = 3

// llama-* unit → name in the UI (GPU models only; proxies and embeddings are skipped)
const MODEL_UNITS: Record<string, string> = {
  "llama-qwen36.service": "Qwen 35B",
  "llama-qwen36v.service": "Qwen 35B vision",
  "llama-qwen35.service": "Qwen 9B",
  "llama-gemma4.service": "Gemma 26B",
  "llama-small.service": "Qwen 4B",
  "llama-qwen38.service": "Qwen 27B",
  "llama-bonsai.service": "Bonsai 27B",
}

// Live speed: /slots on BACKEND ports (never proxy sockets — would wake a model).
const SPEED_MS = 1_000
const BACKEND_PORTS = [8116, 8086, 8120, 8094, 8096, 8098]
type Speed = { phase: "GEN" | "PROMPT"; tps: number; done: number; total?: number }
const [speed, setSpeed] = createSignal<Speed | null>(null)
const [lastSpeed, setLastSpeed] = createSignal<Speed | null>(null)
const prevSlot = new Map<number, { t: number; task: number; prompt: number; decoded: number }>()

async function pollSpeed() {
  let current: Speed | null = null
  await Promise.all(
    BACKEND_PORTS.map(async (port) => {
      let slot: any
      try {
        const res = await fetch(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(400) })
        slot = (await res.json())[0]
      } catch {
        prevSlot.delete(port)
        return
      }
      const t = Date.now()
      const cur = {
        t,
        task: slot.id_task,
        prompt: slot.n_prompt_tokens_processed ?? 0,
        decoded: slot.next_token?.[0]?.n_decoded ?? 0,
      }
      const prev = prevSlot.get(port)
      prevSlot.set(port, cur)
      if (!slot.is_processing || !prev || prev.task !== cur.task) return
      const dt = (cur.t - prev.t) / 1000
      if (dt <= 0) return
      if (cur.decoded > prev.decoded) {
        current = { phase: "GEN", tps: (cur.decoded - prev.decoded) / dt, done: cur.decoded }
      } else if (cur.prompt > prev.prompt) {
        current = { phase: "PROMPT", tps: (cur.prompt - prev.prompt) / dt, done: cur.prompt, total: slot.n_prompt_tokens }
      }
    }),
  )
  setSpeed(current)
  if (current) setLastSpeed(current)
}

type GpuSample = {
  watts: number
  tempC: number
  vramUsedMiB: number
  vramTotalMiB: number
  utilPct: number
  fanPct: number | null
}

// Global state (survives slot re-renders; one sample per TUI process).
const [gpu, setGpu] = createSignal<GpuSample | null>(null)
const [energyWh, setEnergyWh] = createSignal(0)
const [peakWatts, setPeakWatts] = createSignal(0)
const [model, setModel] = createSignal<string | null>(null)
const startedAt = Date.now()
// Clock as a signal — Date.now() alone in JSX does not refresh the view.
const [now, setNow] = createSignal(startedAt)
const [tariff, setTariff] = createSignal<Tariff>(FALLBACK_TARIFF)

// cost = energy [Wh] * rate [currency/kWh] / 1000
const cost = () => (energyWh() * tariff().perKwh) / 1000
// cost of an hour at the current draw
const costPerHour = () => ((gpu()?.watts ?? 0) * tariff().perKwh) / 1000

let lastSampleAt = Date.now()

function run(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(command, { timeout: 4_000 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

async function sampleGpu(): Promise<GpuSample | null> {
  const out = await run(
    "nvidia-smi --query-gpu=power.draw,temperature.gpu,memory.used,memory.total,utilization.gpu,fan.speed --format=csv,noheader,nounits",
  )
  if (out == null) return null
  const [watts, tempC, used, total, util, fan] = (out.trim().split("\n")[0] ?? "")
    .split(",")
    .map((field) => Number.parseFloat(field.trim()))
  if (!Number.isFinite(watts)) return null
  return {
    watts,
    tempC,
    vramUsedMiB: used,
    vramTotalMiB: total,
    utilPct: util,
    fanPct: Number.isFinite(fan) ? fan : null,
  }
}

async function sampleModel(): Promise<string | null> {
  const out = await run("systemctl --user list-units --state=active --no-legend --plain 'llama-*.service'")
  if (out == null) return null
  const names = out
    .split("\n")
    .map((line) => MODEL_UNITS[line.split(/\s+/)[0] ?? ""])
    .filter(Boolean)
  return names.length > 0 ? names.join(", ") : null
}

function startMetering() {
  let ticks = 0
  const tick = async () => {
    const now = Date.now()
    const prev = lastSampleAt
    lastSampleAt = now
    setNow(now)

    if (ticks++ % MODEL_EVERY_N_TICKS === 0) setModel(await sampleModel())

    const sample = await sampleGpu()
    setGpu(sample)
    if (sample == null) return

    // integracja: W * h = Wh
    setEnergyWh((v) => v + (sample.watts * (now - prev)) / 3_600_000)
    setPeakWatts((v) => Math.max(v, sample.watts))
  }

  void tick()
  const timer = setInterval(() => void tick(), SAMPLE_MS)
  const speedTimer = setInterval(() => void pollSpeed(), SPEED_MS)
  return () => {
    clearInterval(timer)
    clearInterval(speedTimer)
  }
}

// number in the system locale (61,0 in Polish, 61.0 in English)
const pl = (value: number, digits: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })
const gb = (mib: number) => pl(mib / 1024, 1)

function uptime() {
  const minutes = Math.floor((now() - startedAt) / 60_000)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// Temperature colour: normal up to 70°C, warning up to 80°C, then error.
function tempColor(theme: any, tempC: number) {
  if (tempC >= 80) return theme.text.feedback.error.base
  if (tempC >= 70) return theme.text.feedback.warning.base
  return theme.text.muted
}

// Signals read only in JSX — a read in the component body would not refresh.
function FooterStatus() {
  const context = usePlugin()
  const gpuText = () => {
    const sample = gpu()
    if (sample == null) return "GPU —"
    return `${pl(sample.watts, 0)} W · ${pl(sample.tempC, 0)}°C`
  }
  return (
    <text fg={context.theme.text.muted}>
      ⚡ {pl(cost(), 4)} {tariff().currency} · {gpuText()}
    </text>
  )
}

function speedText() {
  const s = speed()
  if (s) {
    return s.phase === "GEN"
      ? `generating ${pl(s.tps, 1)} tok/s (${s.done} tok)`
      : `reading prompt ${pl(s.tps, 0)} tok/s (${s.done}/${s.total ?? "?"})`
  }
  const l = lastSpeed()
  if (!l) return "tok/s: idle"
  return `idle · last ${l.phase === "GEN" ? "gen." : "prompt"} ${pl(l.tps, l.phase === "GEN" ? 1 : 0)} tok/s`
}

function SidebarSection() {
  const context = usePlugin()
  const theme = context.theme
  return (
    <box>
      <text fg={theme.text.base}>
        <b>Power &amp; GPU</b>
      </text>
      <Show when={model()}>{(name) => <text fg={theme.text.muted}>model: {name()}</text>}</Show>
      <text fg={speed() ? theme.text.base : theme.text.muted}>{speedText()}</text>
      <Show when={gpu()} fallback={<text fg={theme.text.muted}>GPU: brak odczytu</text>}>
        {(sample) => (
          <>
            <text fg={theme.text.muted}>
              {pl(sample().watts, 1)} W (peak {pl(peakWatts(), 0)} W) · load {pl(sample().utilPct, 0)}%
            </text>
            <text fg={tempColor(theme, sample().tempC)}>
              {pl(sample().tempC, 0)}°C
              {sample().fanPct != null ? ` · fan ${pl(sample().fanPct!, 0)}%` : ""}
            </text>
            <text fg={theme.text.muted}>
              VRAM {gb(sample().vramUsedMiB)} / {gb(sample().vramTotalMiB)} GB
            </text>
          </>
        )}
      </Show>
      <text fg={theme.text.muted}>
        {pl(cost(), 4)} {tariff().currency} · {pl(energyWh(), 1)} Wh
      </text>
      <text fg={theme.text.muted}>
        {pl(costPerHour(), 3)} {tariff().currency}/h now · since {uptime()}
      </text>
      <text fg={theme.text.muted}>
        rate {pl(tariff().perKwh, 4)} {tariff().currency}/kWh ({tariff().source})
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "power-cost",
  setup(context) {
    void resolveTariff().then(setTariff)
    const stopMetering = startMetering()
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <FooterStatus />,
    })
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => <SidebarSection />,
    })
    return () => {
      stopMetering()
      unregisterFooter()
      unregisterSidebar()
    }
  },
})
