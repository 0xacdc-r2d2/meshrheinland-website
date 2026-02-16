<script setup>
import { ref, computed, watch } from 'vue'

// ── Device catalogue ───────────────────────────────────────────────────────
// Add new devices here. chargeMaxMa: null → no built-in solar charger,
// the external-charger slider keeps its current value unchanged.
const DEVICES = [
  {
    id: 'heltec-t114',
    name: 'Heltec T114',
    chip: 'nRF52840 + SX1262',
    rxMa: 5,    // SX1262 RX 4.8 mA + nRF52 sleep ~0.2 mA
    txMa: 100,  // SX1262 TX @17 dBm 92 mA + nRF52 active 8 mA
    chargeMaxMa: 1000,  // built-in charger, max 1 A (no MPPT)
  },
  {
    id: 'heltec-v3',
    name: 'Heltec V3',
    chip: 'ESP32-S3 + SX1262',
    rxMa: 10,   // SX1262 RX 4.8 mA + ESP32-S3 light sleep ~5 mA
    txMa: 112,  // SX1262 TX @17 dBm 92 mA + ESP32-S3 active 20 mA
    chargeMaxMa: null,  // no built-in solar charger
  },
  {
    id: 'rak4631',
    name: 'RAK4631 (WisBlock)',
    chip: 'nRF52840 + SX1262',
    rxMa: 5,
    txMa: 100,
    chargeMaxMa: 500,  // built-in RAK baseboard charger, ~500 mA (no MPPT)
  },
]

// ── State ──────────────────────────────────────────────────────────────────
const device1Id  = ref('heltec-t114')
const device2Id  = ref('heltec-v3')
const txPercent  = ref(1)     // 0–10 %
const batteryMah = ref(3000)  // 500–20 000 mAh
const sunHours   = ref(4)     // 0–8 h/day
const panelW     = ref(3)     // 0–10 W
const chargeMax1 = ref(1000)  // mA, per-device charge controller limit
const chargeMax2 = ref(1000)

const SIM_MAX_DAYS = 90

// ── Device lookups ─────────────────────────────────────────────────────────
const device1 = computed(() => DEVICES.find(d => d.id === device1Id.value))
const device2 = computed(() => DEVICES.find(d => d.id === device2Id.value))

// Pre-fill chargeMax from device definition (skip if no built-in charger)
watch(device1, d => { if (d.chargeMaxMa !== null) chargeMax1.value = d.chargeMaxMa }, { immediate: true })
watch(device2, d => { if (d.chargeMaxMa !== null) chargeMax2.value = d.chargeMaxMa }, { immediate: true })

// ── Power model ────────────────────────────────────────────────────────────
const txRatio = computed(() => txPercent.value / 100)

const avgMa1 = computed(() =>
  txRatio.value * device1.value.txMa + (1 - txRatio.value) * device1.value.rxMa
)
const avgMa2 = computed(() =>
  txRatio.value * device2.value.txMa + (1 - txRatio.value) * device2.value.rxMa
)

const dailyMah1 = computed(() => avgMa1.value * 24)
const dailyMah2 = computed(() => avgMa2.value * 24)

// Raw solar current from panel (before charge controller cap)
const rawSolarMaH = computed(() => panelW.value * 0.85 * 1000 / 3.7)

// Effective charge current per device (capped by each device's charger)
const solarMaH1 = computed(() => Math.min(rawSolarMaH.value, chargeMax1.value))
const solarMaH2 = computed(() => Math.min(rawSolarMaH.value, chargeMax2.value))

const solarDayMah1 = computed(() => solarMaH1.value * sunHours.value)
const solarDayMah2 = computed(() => solarMaH2.value * sunHours.value)

const balance1 = computed(() => solarDayMah1.value - dailyMah1.value)
const balance2 = computed(() => solarDayMah2.value - dailyMah2.value)

// ── Hourly simulation ──────────────────────────────────────────────────────
// Solar active only between sunrise and sunset (centered at noon).
function simulateHours(deviceMa, solarMaH, days) {
  const cap     = batteryMah.value
  const sh      = sunHours.value
  const sunrise = 12 - sh / 2
  const sunset  = 12 + sh / 2
  const out = [cap]
  for (let h = 0; h < days * 24; h++) {
    const hour  = h % 24
    const solar = sh > 0 && hour >= sunrise && hour < sunset ? solarMaH : 0
    out.push(Math.min(cap, Math.max(0, out[h] + solar - deviceMa)))
  }
  return out
}

const levels1 = computed(() => simulateHours(avgMa1.value, solarMaH1.value, SIM_MAX_DAYS))
const levels2 = computed(() => simulateHours(avgMa2.value, solarMaH2.value, SIM_MAX_DAYS))

function deathHour(levels) {
  const idx = levels.findIndex((v, i) => i > 0 && v === 0)
  return idx === -1 ? SIM_MAX_DAYS * 24 : idx
}

// Chart window: until the longer-lived device hits 0
const vizDays = computed(() =>
  Math.ceil(Math.max(deathHour(levels1.value), deathHour(levels2.value)) / 24)
)

const viz1 = computed(() => levels1.value.slice(0, vizDays.value * 24 + 1))
const viz2 = computed(() => levels2.value.slice(0, vizDays.value * 24 + 1))

function runtimeStr(levels) {
  const idx = levels.findIndex((v, i) => i > 0 && v === 0)
  if (idx === -1) return `>${SIM_MAX_DAYS} Tage`
  const days = idx / 24
  return days < 2 ? `${(days * 24).toFixed(0)} h` : `${days.toFixed(1)} Tage`
}
const runtime1 = computed(() => runtimeStr(levels1.value))
const runtime2 = computed(() => runtimeStr(levels2.value))

// ── SVG chart ──────────────────────────────────────────────────────────────
const W = 560
const H = 290
const PAD = { t: 16, r: 48, b: 44, l: 72 }
const plotW = W - PAD.l - PAD.r
const plotH = H - PAD.t - PAD.b

function toXday(day)  { return PAD.l + (day / vizDays.value) * plotW }
function toY(mah)     { return PAD.t + plotH * (1 - mah / batteryMah.value) }
function toYpct(pct)  { return PAD.t + plotH * (1 - pct / 100) }

function buildPoints(levels) {
  const cap = batteryMah.value
  return levels
    .map((v, h) => `${toXday(h / 24)},${PAD.t + plotH * (1 - v / cap)}`)
    .join(' ')
}

const points1 = computed(() => buildPoints(viz1.value))
const points2 = computed(() => buildPoints(viz2.value))

const yGridLines = computed(() => {
  const cap  = batteryMah.value
  const step = cap <= 2000 ? 500 : cap <= 5000 ? 1000 : cap <= 10000 ? 2000 : 5000
  const lines = []
  for (let v = 0; v <= cap; v += step) lines.push(v)
  return lines
})

const xTicks = computed(() => {
  const d    = vizDays.value
  const step = d <= 4 ? 1 : d <= 10 ? 2 : d <= 20 ? 4 : d <= 40 ? 7 : d <= 60 ? 10 : 15
  const ticks = []
  for (let t = 0; t < d; t += step) ticks.push(t)
  ticks.push(d)
  return ticks
})

const pctTicks = [0, 25, 50, 75, 100]

function fmtMah(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}Ah` : `${v}`
}
function fmtA(ma) { return (ma / 1000).toFixed(1) + ' A' }
</script>

<template>
  <div class="calc">

    <!-- ── Device selection ───────────────────────────────────────────── -->
    <div class="controls">
      <div class="row device-row">
        <label><span class="dot d1"></span> Gerät 1</label>
        <select v-model="device1Id" class="dev-select">
          <option v-for="d in DEVICES" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <span class="chip-badge">{{ device1.chip }}</span>
      </div>
      <div class="row indent">
        <label>Laderegler max.</label>
        <div class="slider-wrap">
          <input type="range" min="100" max="2000" step="100" v-model.number="chargeMax1" class="s1" />
          <span class="val">{{ fmtA(chargeMax1) }}</span>
        </div>
      </div>

      <div class="row device-row">
        <label><span class="dot d2"></span> Gerät 2</label>
        <select v-model="device2Id" class="dev-select">
          <option v-for="d in DEVICES" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <span class="chip-badge">{{ device2.chip }}</span>
      </div>
      <div class="row indent">
        <label>Laderegler max.</label>
        <div class="slider-wrap">
          <input type="range" min="100" max="2000" step="100" v-model.number="chargeMax2" class="s2" />
          <span class="val">{{ fmtA(chargeMax2) }}</span>
        </div>
      </div>

      <!-- ── Shared parameters ─────────────────────────────────────────── -->
      <div class="row sep">
        <label>TX-Anteil <span class="hint">(max. 10 % in DE)</span></label>
        <div class="slider-wrap">
          <input type="range" min="0" max="10" step="0.5" v-model.number="txPercent" />
          <span class="val">{{ txPercent.toFixed(1) }} %</span>
        </div>
      </div>
      <div class="row">
        <label>Akkukapazität</label>
        <div class="slider-wrap">
          <input type="range" min="500" max="20000" step="100" v-model.number="batteryMah" />
          <span class="val">{{ batteryMah >= 1000 ? (batteryMah/1000).toFixed(1)+'Ah' : batteryMah+'mAh' }}</span>
        </div>
      </div>
      <div class="row">
        <label>Sonnenstunden / Tag</label>
        <div class="slider-wrap">
          <input type="range" min="0" max="8" step="0.5" v-model.number="sunHours" />
          <span class="val">{{ sunHours }} h</span>
        </div>
      </div>
      <div class="row">
        <label>Solarpanel</label>
        <div class="slider-wrap">
          <input type="range" min="0" max="10" step="1" v-model.number="panelW" />
          <span class="val">{{ panelW === 0 ? 'keins' : panelW + ' W' }}</span>
        </div>
      </div>
    </div>

    <!-- ── Chart ──────────────────────────────────────────────────────── -->
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" aria-label="Akkustandverlauf">
      <line v-for="y in yGridLines" :key="`yg${y}`" :x1="PAD.l" :y1="toY(y)" :x2="W-PAD.r" :y2="toY(y)" class="grid" />
      <line v-for="x in xTicks"    :key="`xg${x}`" :x1="toXday(x)" :y1="PAD.t" :x2="toXday(x)" :y2="H-PAD.b" class="grid" />

      <line :x1="PAD.l"     :y1="PAD.t"     :x2="PAD.l"     :y2="H-PAD.b" class="axis" />
      <line :x1="PAD.l"     :y1="H-PAD.b"   :x2="W-PAD.r"   :y2="H-PAD.b" class="axis" />
      <line :x1="W-PAD.r"   :y1="PAD.t"     :x2="W-PAD.r"   :y2="H-PAD.b" class="axis" />

      <text v-for="y in yGridLines" :key="`yl${y}`" :x="PAD.l-7" :y="toY(y)+4"  class="lbl lbl-y">{{ fmtMah(y) }}</text>
      <text v-for="x in xTicks"     :key="`xl${x}`" :x="toXday(x)" :y="H-PAD.b+14" class="lbl lbl-x">{{ x }}d</text>

      <text v-for="p in pctTicks" :key="`pr${p}`" :x="W-PAD.r+6" :y="toYpct(p)+4" class="lbl lbl-pct">{{ p }}%</text>
      <line v-for="p in pctTicks" :key="`pt${p}`" :x1="W-PAD.r" :y1="toYpct(p)" :x2="W-PAD.r+4" :y2="toYpct(p)" class="axis" />

      <text :x="11" :y="PAD.t+plotH/2" class="lbl axis-title" :transform="`rotate(-90,11,${PAD.t+plotH/2})`">Akkustand (mAh)</text>
      <text :x="W-8" :y="PAD.t+plotH/2" class="lbl axis-title" :transform="`rotate(90,${W-8},${PAD.t+plotH/2})`">SoC</text>
      <text :x="PAD.l+plotW/2" :y="H-4" class="lbl lbl-x">Tage</text>

      <polyline :points="points1" class="line l1" />
      <polyline :points="points2" class="line l2" />

      <!-- Legend with dynamic device names -->
      <rect :x="W-PAD.r-146" :y="PAD.t+8" width="136" height="52" rx="5" class="legend-bg" />
      <line :x1="W-PAD.r-138" :y1="PAD.t+26" :x2="W-PAD.r-118" :y2="PAD.t+26" class="line l1" />
      <text :x="W-PAD.r-113" :y="PAD.t+30" class="lbl legend-lbl">{{ device1.name }}</text>
      <line :x1="W-PAD.r-138" :y1="PAD.t+46" :x2="W-PAD.r-118" :y2="PAD.t+46" class="line l2" />
      <text :x="W-PAD.r-113" :y="PAD.t+50" class="lbl legend-lbl">{{ device2.name }}</text>
    </svg>

    <!-- ── Stats ──────────────────────────────────────────────────────── -->
    <table class="stats">
      <thead>
        <tr>
          <th></th>
          <th class="col1">{{ device1.name }}</th>
          <th class="col2">{{ device2.name }}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Ø Strom</td>
          <td>{{ avgMa1.toFixed(1) }} mA</td>
          <td>{{ avgMa2.toFixed(1) }} mA</td>
        </tr>
        <tr>
          <td>Verbrauch / Tag</td>
          <td>{{ dailyMah1.toFixed(0) }} mAh</td>
          <td>{{ dailyMah2.toFixed(0) }} mAh</td>
        </tr>
        <tr>
          <td>Solar-Ertrag / Tag</td>
          <td>{{ solarDayMah1.toFixed(0) }} mAh</td>
          <td>{{ solarDayMah2.toFixed(0) }} mAh</td>
        </tr>
        <tr>
          <td>Bilanz / Tag</td>
          <td :class="balance1 >= 0 ? 'pos' : 'neg'">{{ balance1 >= 0 ? '+' : '' }}{{ balance1.toFixed(0) }} mAh</td>
          <td :class="balance2 >= 0 ? 'pos' : 'neg'">{{ balance2 >= 0 ? '+' : '' }}{{ balance2.toFixed(0) }} mAh</td>
        </tr>
        <tr class="runtime-row">
          <td>Laufzeit</td>
          <td>{{ runtime1 }}</td>
          <td>{{ runtime2 }}</td>
        </tr>
      </tbody>
    </table>

    <p class="footnote">
      Solar-Wirkungsgrad 85 % &bull; 3,7 V Akku &bull;
      Gerät 1: {{ device1.rxMa }} mA (RX) / {{ device1.txMa }} mA (TX) &bull;
      Gerät 2: {{ device2.rxMa }} mA (RX) / {{ device2.txMa }} mA (TX)
    </p>
  </div>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  background: #fff;
  color: #1a1a1a;
}

.calc {
  max-width: 620px;
  margin: 0 auto;
  padding: 16px 20px 20px;
}

/* ── Controls ── */
.controls { margin-bottom: 12px; }

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid #f0f0f0;
}
.row label {
  width: 180px;
  flex-shrink: 0;
  font-size: 13px;
  color: #444;
  display: flex;
  align-items: center;
  gap: 6px;
}
.hint { color: #999; font-size: 11px; }

/* Device rows */
.device-row label { font-weight: 600; }
.indent label { padding-left: 18px; color: #888; font-weight: 400; }
.sep { margin-top: 6px; border-top: 2px solid #e8e8e8; }

.dot {
  display: inline-block;
  width: 10px; height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.d1 { background: #2563eb; }
.d2 { background: #ea580c; }

.dev-select {
  flex: 1;
  padding: 3px 6px;
  font-size: 13px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: white;
  color: #1a1a1a;
}
.chip-badge {
  font-size: 11px;
  color: #888;
  white-space: nowrap;
}

/* Sliders */
.slider-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}
.slider-wrap input[type=range] { flex: 1; accent-color: #2563eb; }
.s1 { accent-color: #2563eb; }
.s2 { accent-color: #ea580c; }
.val {
  width: 60px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
}

/* ── Chart ── */
.chart { width: 100%; display: block; margin: 0 0 10px; }

.grid { stroke: #e8e8e8; stroke-width: 1; }
.axis { stroke: #999; stroke-width: 1.5; }

.line { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.l1 { stroke: #2563eb; }
.l2 { stroke: #ea580c; }

.lbl       { font-size: 11px; fill: #666; }
.lbl-y     { text-anchor: end; }
.lbl-x     { text-anchor: middle; }
.lbl-pct   { text-anchor: start; fill: #999; }
.axis-title { font-size: 10px; fill: #888; text-anchor: middle; }
.legend-lbl { font-size: 11px; fill: #333; dominant-baseline: middle; }
.legend-bg  { fill: white; stroke: #ddd; stroke-width: 1; }

/* ── Stats ── */
.stats { width: 100%; border-collapse: collapse; font-size: 13px; }
.stats th, .stats td { padding: 5px 10px; text-align: left; border-bottom: 1px solid #f0f0f0; }
.stats th { font-weight: 600; font-size: 12px; color: #555; }
.col1 { color: #2563eb; }
.col2 { color: #ea580c; }
.pos  { color: #16a34a; font-weight: 600; }
.neg  { color: #dc2626; font-weight: 600; }
.runtime-row td { font-weight: 700; font-size: 14px; }

/* ── Footnote ── */
.footnote { margin-top: 10px; font-size: 10px; color: #aaa; line-height: 1.4; }

/* ── Dark mode ── */
@media (prefers-color-scheme: dark) {
  body { background: #1e1e2e; color: #cdd6f4; }
  .row { border-color: #313244; }
  .row label { color: #a6adc8; }
  .val, .chip-badge { color: #cdd6f4; }
  .chip-badge { color: #6c7086; }
  .dev-select { background: #313244; border-color: #45475a; color: #cdd6f4; }
  .sep { border-top-color: #45475a; }
  .grid { stroke: #313244; }
  .axis { stroke: #585b70; }
  .lbl { fill: #a6adc8; }
  .legend-lbl { fill: #cdd6f4; }
  .legend-bg { fill: #1e1e2e; stroke: #45475a; }
  .stats th { color: #a6adc8; }
  .stats th, .stats td { border-color: #313244; }
  .footnote { color: #585b70; }
}
</style>
