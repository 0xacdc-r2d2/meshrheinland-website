<script setup>
import { ref, computed } from 'vue'

// ── Hardware constants (from datasheets + community measurements) ──────────
// SX1262 (all modern Meshtastic devices use this):
//   RX: ~4.8 mA  |  TX @ 17 dBm: ~92 mA  |  Sleep: ~600 nA
//
// nRF52840 (RAK4631, T114, XIAO):  MCU sleep ~2 µA, active ~8 mA
//   Meshtastic idle: MCU sleeps, SX1262 in RX → ~5 mA total
//   TX burst: MCU active ~8 mA + SX1262 ~92 mA → ~100 mA total
//
// ESP32-S3 (Heltec V3, light sleep mode, no display, no BT):
//   Light sleep: ~5 mA, SX1262 RX → ~10 mA total
//   TX burst: ESP32 active ~20 mA + SX1262 ~92 mA → ~112 mA total
//   (Source: measured battery life 154–453h / 1100 mAh on RAK; 61–156h on Heltec V3 light sleep)

const NRF_RX_MA = 5     // nRF52 + SX1262 RX, MCU mostly sleeping
const NRF_TX_MA = 100   // nRF52 active + SX1262 TX @ 17 dBm
const ESP_RX_MA = 10    // ESP32 light sleep + SX1262 RX
const ESP_TX_MA = 112   // ESP32-S3 active + SX1262 TX @ 17 dBm

// ── Slider state ───────────────────────────────────────────────────────────
const txPercent      = ref(1)     // 0–10 %
const batteryMah     = ref(3000)  // 500–20 000 mAh
const sunHours       = ref(4)     // 0–8 h/day
const panelW         = ref(3)     // 0–10 W
const chargeMaxMa    = ref(1000)  // 100–2000 mA (Laderegler-Limit)

const SIM_MAX_DAYS = 90   // simulation horizon

// ── Derived power values ───────────────────────────────────────────────────
const txRatio = computed(() => txPercent.value / 100)

const nrfAvgMa = computed(() =>
  txRatio.value * NRF_TX_MA + (1 - txRatio.value) * NRF_RX_MA
)
const espAvgMa = computed(() =>
  txRatio.value * ESP_TX_MA + (1 - txRatio.value) * ESP_RX_MA
)

const nrfDailyMah = computed(() => nrfAvgMa.value * 24)
const espDailyMah = computed(() => espAvgMa.value * 24)

// Solar yield per day, capped by charge controller limit
const solarMaPerHour = computed(() =>
  Math.min(panelW.value * 0.85 * 1000 / 3.7, chargeMaxMa.value)
)
const solarMah = computed(() => solarMaPerHour.value * sunHours.value)

const nrfBalance = computed(() => solarMah.value - nrfDailyMah.value)
const espBalance = computed(() => solarMah.value - espDailyMah.value)

// ── Hourly simulation ──────────────────────────────────────────────────────
// Solar is available only between sunrise and sunset (centered at noon).
// Each sun hour delivers panelW × η / 3.7V mAh to the battery.
function simulateHours(deviceMa, days) {
  const cap       = batteryMah.value
  const sh        = sunHours.value
  const solarMaH  = solarMaPerHour.value  // already capped by charge controller
  const sunrise   = 12 - sh / 2
  const sunset    = 12 + sh / 2
  const out = [cap]
  for (let h = 0; h < days * 24; h++) {
    const hour  = h % 24
    const solar = (sh > 0 && hour >= sunrise && hour < sunset) ? solarMaH : 0
    const next  = Math.min(cap, Math.max(0, out[h] + solar - deviceMa))
    out.push(next)
  }
  return out
}

// Simulate full horizon for both devices
const nrfAllLevels = computed(() => simulateHours(nrfAvgMa.value, SIM_MAX_DAYS))
const espAllLevels = computed(() => simulateHours(espAvgMa.value, SIM_MAX_DAYS))

function deathHour(levels) {
  const idx = levels.findIndex((v, i) => i > 0 && v === 0)
  return idx === -1 ? SIM_MAX_DAYS * 24 : idx
}

// Chart window: until the longer-lived device hits 0 (or SIM_MAX_DAYS)
const vizDays = computed(() =>
  Math.ceil(Math.max(deathHour(nrfAllLevels.value), deathHour(espAllLevels.value)) / 24)
)

// Viz levels are just slices of the full simulation
const nrfVizLevels = computed(() => nrfAllLevels.value.slice(0, vizDays.value * 24 + 1))
const espVizLevels = computed(() => espAllLevels.value.slice(0, vizDays.value * 24 + 1))

function runtimeStr(levels) {
  const idx = levels.findIndex((v, i) => i > 0 && v === 0)
  if (idx === -1) return `>${SIM_MAX_DAYS} Tage`
  const days = idx / 24
  return days < 2 ? `${(days * 24).toFixed(0)} h` : `${days.toFixed(1)} Tage`
}
const nrfRuntime = computed(() => runtimeStr(nrfAllLevels.value))
const espRuntime = computed(() => runtimeStr(espAllLevels.value))

// ── SVG chart geometry ─────────────────────────────────────────────────────
const W = 560
const H = 290
const PAD = { t: 16, r: 48, b: 44, l: 72 }
const plotW = W - PAD.l - PAD.r
const plotH = H - PAD.t - PAD.b

function toXday(day) {
  return PAD.l + (day / vizDays.value) * plotW
}
function toY(mah) {
  return PAD.t + plotH * (1 - mah / batteryMah.value)
}

const pctTicks = [0, 25, 50, 75, 100]
function toYpct(pct) {
  return PAD.t + plotH * (1 - pct / 100)
}

function buildPoints(levels) {
  const cap = batteryMah.value
  return levels
    .map((v, h) => `${toXday(h / 24)},${PAD.t + plotH * (1 - v / cap)}`)
    .join(' ')
}

const nrfPoints = computed(() => buildPoints(nrfVizLevels.value))
const espPoints = computed(() => buildPoints(espVizLevels.value))

// Y grid: ~5 lines
const yGridLines = computed(() => {
  const cap = batteryMah.value
  const step = cap <= 2000 ? 500 : cap <= 5000 ? 1000 : cap <= 10000 ? 2000 : 5000
  const lines = []
  for (let v = 0; v <= cap; v += step) lines.push(v)
  return lines
})

const xTicks = computed(() => {
  const d = vizDays.value
  const step = d <= 4 ? 1 : d <= 10 ? 2 : d <= 20 ? 4 : d <= 40 ? 7 : d <= 60 ? 10 : 15
  const ticks = []
  for (let t = 0; t < d; t += step) ticks.push(t)
  ticks.push(d)
  return ticks
})

function fmtMah(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}Ah` : `${v}`
}
</script>

<template>
  <div class="calc">

    <!-- ── Sliders ─────────────────────────────────────────────────────── -->
    <div class="controls">
      <div class="row">
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
      <div class="row">
        <label>Laderegler max. <span class="hint">(CN3791, TP4056…)</span></label>
        <div class="slider-wrap">
          <input type="range" min="100" max="2000" step="100" v-model.number="chargeMaxMa" />
          <span class="val">{{ (chargeMaxMa / 1000).toFixed(1) }} A</span>
        </div>
      </div>
    </div>

    <!-- ── Chart ──────────────────────────────────────────────────────── -->
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" aria-label="Akkustandverlauf">

      <!-- Y grid lines -->
      <line
        v-for="y in yGridLines" :key="`yg${y}`"
        :x1="PAD.l" :y1="toY(y)" :x2="W - PAD.r" :y2="toY(y)"
        class="grid"
      />
      <!-- X grid lines -->
      <line
        v-for="x in xTicks" :key="`xg${x}`"
        :x1="toXday(x)" :y1="PAD.t" :x2="toXday(x)" :y2="H - PAD.b"
        class="grid"
      />

      <!-- Axes -->
      <line :x1="PAD.l"      :y1="PAD.t"     :x2="PAD.l"      :y2="H - PAD.b" class="axis" />
      <line :x1="PAD.l"      :y1="H - PAD.b" :x2="W - PAD.r"  :y2="H - PAD.b" class="axis" />
      <line :x1="W - PAD.r"  :y1="PAD.t"     :x2="W - PAD.r"  :y2="H - PAD.b" class="axis" />

      <!-- Y labels -->
      <text
        v-for="y in yGridLines" :key="`yl${y}`"
        :x="PAD.l - 7" :y="toY(y) + 4"
        class="lbl lbl-y"
      >{{ fmtMah(y) }}</text>

      <!-- X labels -->
      <text
        v-for="x in xTicks" :key="`xl${x}`"
        :x="toXday(x)" :y="H - PAD.b + 14"
        class="lbl lbl-x"
      >{{ x }}d</text>

      <!-- Right axis: SoC % labels -->
      <text
        v-for="p in pctTicks" :key="`pr${p}`"
        :x="W - PAD.r + 6" :y="toYpct(p) + 4"
        class="lbl lbl-pct"
      >{{ p }}%</text>
      <!-- Right axis tick marks -->
      <line
        v-for="p in pctTicks" :key="`pt${p}`"
        :x1="W - PAD.r" :y1="toYpct(p)" :x2="W - PAD.r + 4" :y2="toYpct(p)"
        class="axis"
      />
      <!-- Right axis title -->
      <text
        :x="W - 8" :y="PAD.t + plotH / 2"
        class="lbl axis-title"
        :transform="`rotate(90, ${W - 8}, ${PAD.t + plotH / 2})`"
      >SoC</text>

      <!-- Axis titles -->
      <text
        :x="11" :y="PAD.t + plotH / 2"
        class="lbl axis-title"
        :transform="`rotate(-90, 11, ${PAD.t + plotH / 2})`"
      >Akkustand (mAh)</text>
      <text :x="PAD.l + plotW / 2" :y="H - 4" class="lbl lbl-x">Tage</text>

      <!-- Data lines -->
      <polyline :points="nrfPoints" class="line nrf" />
      <polyline :points="espPoints" class="line esp" />

      <!-- Legend -->
      <rect :x="W - PAD.r - 136" :y="PAD.t + 8" width="126" height="52" rx="5" class="legend-bg" />
      <line :x1="W-PAD.r-128" :y1="PAD.t+26" :x2="W-PAD.r-108" :y2="PAD.t+26" class="line nrf" />
      <text :x="W-PAD.r-103" :y="PAD.t+30" class="lbl legend-lbl">nRF52840</text>
      <line :x1="W-PAD.r-128" :y1="PAD.t+46" :x2="W-PAD.r-108" :y2="PAD.t+46" class="line esp" />
      <text :x="W-PAD.r-103" :y="PAD.t+50" class="lbl legend-lbl">ESP32 (Light Sleep)</text>
    </svg>

    <!-- ── Stats table ────────────────────────────────────────────────── -->
    <table class="stats">
      <thead>
        <tr>
          <th></th>
          <th class="nrf-col">nRF52840</th>
          <th class="esp-col">ESP32</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Ø Strom</td>
          <td>{{ nrfAvgMa.toFixed(1) }} mA</td>
          <td>{{ espAvgMa.toFixed(1) }} mA</td>
        </tr>
        <tr>
          <td>Verbrauch / Tag</td>
          <td>{{ nrfDailyMah.toFixed(0) }} mAh</td>
          <td>{{ espDailyMah.toFixed(0) }} mAh</td>
        </tr>
        <tr>
          <td>Solar-Ertrag / Tag</td>
          <td colspan="2" class="center">{{ solarMah.toFixed(0) }} mAh</td>
        </tr>
        <tr>
          <td>Bilanz / Tag</td>
          <td :class="nrfBalance >= 0 ? 'pos' : 'neg'">
            {{ nrfBalance >= 0 ? '+' : '' }}{{ nrfBalance.toFixed(0) }} mAh
          </td>
          <td :class="espBalance >= 0 ? 'pos' : 'neg'">
            {{ espBalance >= 0 ? '+' : '' }}{{ espBalance.toFixed(0) }} mAh
          </td>
        </tr>
        <tr class="runtime-row">
          <td>Laufzeit</td>
          <td>{{ nrfRuntime }}</td>
          <td>{{ espRuntime }}</td>
        </tr>
      </tbody>
    </table>

    <p class="footnote">
      Modell: nRF52840 = 5 mA (RX) / 100 mA (TX) &bull;
      ESP32-S3 Light Sleep = 10 mA (RX) / 112 mA (TX) &bull;
      Solar-Wirkungsgrad 85 % &bull; 3,7 V Akku
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
}
.hint { color: #999; font-size: 11px; }

.slider-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
}
.slider-wrap input[type=range] { flex: 1; accent-color: #2563eb; }
.val {
  width: 60px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
  color: #1a1a1a;
}

/* ── Chart ── */
.chart {
  width: 100%;
  display: block;
  margin: 0 0 10px;
}

.grid { stroke: #e8e8e8; stroke-width: 1; }
.axis { stroke: #999; stroke-width: 1.5; }

.line { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
.nrf  { stroke: #2563eb; }
.esp  { stroke: #ea580c; }

.lbl { font-size: 11px; fill: #666; }
.lbl-y   { text-anchor: end; }
.lbl-x   { text-anchor: middle; }
.lbl-pct { text-anchor: start; fill: #999; }
.axis-title { font-size: 10px; fill: #888; text-anchor: middle; }
.legend-lbl { font-size: 11px; fill: #333; dominant-baseline: middle; }
.legend-bg  { fill: white; stroke: #ddd; stroke-width: 1; }

/* ── Stats table ── */
.stats {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.stats th, .stats td {
  padding: 5px 10px;
  text-align: left;
  border-bottom: 1px solid #f0f0f0;
}
.stats th { color: #555; font-weight: 600; font-size: 12px; }
.nrf-col { color: #2563eb; }
.esp-col { color: #ea580c; }
.pos { color: #16a34a; font-weight: 600; }
.neg { color: #dc2626; font-weight: 600; }
.center { text-align: center; }
.runtime-row td { font-weight: 700; font-size: 14px; }

/* ── Footnote ── */
.footnote {
  margin-top: 10px;
  font-size: 10px;
  color: #aaa;
  line-height: 1.4;
}

/* ── Dark mode ── */
@media (prefers-color-scheme: dark) {
  body { background: #1e1e2e; color: #cdd6f4; }
  .row { border-color: #313244; }
  .row label { color: #a6adc8; }
  .val { color: #cdd6f4; }
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
