import { exec } from "node:child_process"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { FALLBACK_TARIFF, resolveTariff, type Tariff } from "./tariff.ts"

// POWER-COST STATUSLINE (OpenCode V2, CLI plugin)
// Narastający koszt prądu zużytego przez GPU (NVIDIA) od startu TUI (w walucie stawki), plus stan karty.
//   - pasek boczny (sidebar.content): pełna sekcja „Prąd i GPU”
//   - dół (prompt.footer.status): skrót — widoczny też, gdy pasek boczny jest schowany
//
// Stawka (pierwsza dostępna wygrywa):
//   1. POWER_COST_PER_KWH (albo stara POWER_COST_PLN_PER_KWH) — ręcznie, brutto z faktury,
//      waluta z POWER_COST_CURRENCY (domyślnie wg kraju),
//   2. Eurostat nrg_pc_204: średnia cena dla gospodarstw domowych (2500–4999 kWh/rok,
//      ze wszystkimi podatkami), ostatnie półrocze; kraj z POWER_COST_COUNTRY albo LANG,
//      cache w ~/.cache/power-cost.json na 30 dni (nieaktualny cache = zapas, gdy brak sieci),
//   3. 1,26 zł/kWh.
// Pomiar: nvidia-smi co 5 s, prosta integracja Wh. Model: aktywny unit llama-* (co 15 s).
//
// Layout pluginu (wymagany przez discovery): index.ts + tui.tsx.

const SAMPLE_MS = 5_000
const MODEL_EVERY_N_TICKS = 3

// llama-* unit → nazwa w UI (tylko modele na GPU; proxy i embeddingi pomijamy)
const MODEL_UNITS: Record<string, string> = {
  "llama-qwen36.service": "Qwen 35B",
  "llama-qwen36v.service": "Qwen 35B vision",
  "llama-qwen35.service": "Qwen 9B",
  "llama-gemma4.service": "Gemma 26B",
  "llama-small.service": "Qwen 4B",
  "llama-qwen38.service": "Qwen 27B",
}

type GpuSample = {
  watts: number
  tempC: number
  vramUsedMiB: number
  vramTotalMiB: number
  utilPct: number
  fanPct: number | null
}

// Stan globalny (przeżywa re-render slotu; jedna próbka na proces TUI).
const [gpu, setGpu] = createSignal<GpuSample | null>(null)
const [energyWh, setEnergyWh] = createSignal(0)
const [peakWatts, setPeakWatts] = createSignal(0)
const [model, setModel] = createSignal<string | null>(null)
const startedAt = Date.now()
// Zegar jako sygnał — sam Date.now() w JSX nie odświeża widoku.
const [now, setNow] = createSignal(startedAt)
const [tariff, setTariff] = createSignal<Tariff>(FALLBACK_TARIFF)

// koszt = energia [Wh] * stawka [waluta/kWh] / 1000
const cost = () => (energyWh() * tariff().perKwh) / 1000
// koszt godziny przy bieżącym poborze
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
  return () => clearInterval(timer)
}

const pl = (value: number, digits: number) => value.toFixed(digits).replace(".", ",")
const gb = (mib: number) => pl(mib / 1024, 1)

function uptime() {
  const minutes = Math.floor((now() - startedAt) / 60_000)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// Kolor temperatury: zwykły do 70°C, ostrzeżenie do 80°C, potem błąd.
function tempColor(theme: any, tempC: number) {
  if (tempC >= 80) return theme.text.feedback.error.base
  if (tempC >= 70) return theme.text.feedback.warning.base
  return theme.text.muted
}

// Sygnały czytane tylko w JSX — odczyt w ciele komponentu nie odświeżałby się.
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

function SidebarSection() {
  const context = usePlugin()
  const theme = context.theme
  return (
    <box>
      <text fg={theme.text.base}>
        <b>Prąd i GPU</b>
      </text>
      <Show when={model()}>{(name) => <text fg={theme.text.muted}>model: {name()}</text>}</Show>
      <Show when={gpu()} fallback={<text fg={theme.text.muted}>GPU: brak odczytu</text>}>
        {(sample) => (
          <>
            <text fg={theme.text.muted}>
              {pl(sample().watts, 1)} W (szczyt {pl(peakWatts(), 0)} W) · obciąż. {pl(sample().utilPct, 0)}%
            </text>
            <text fg={tempColor(theme, sample().tempC)}>
              {pl(sample().tempC, 0)}°C
              {sample().fanPct != null ? ` · went. ${pl(sample().fanPct!, 0)}%` : ""}
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
        {pl(costPerHour(), 3)} {tariff().currency}/h teraz · od {uptime()}
      </text>
      <text fg={theme.text.muted}>
        stawka {pl(tariff().perKwh, 4)} {tariff().currency}/kWh ({tariff().source})
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
