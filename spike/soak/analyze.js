'use strict'

// Summarises a soak jsonl: per-kind counts/latency, failures and RSS trend.

const fs = require('node:fs')
const path = require('node:path')

const file = process.argv[2] || path.join(__dirname, 'soak.jsonl')
const lines = fs.readFileSync(file, 'utf8').trim().split('\n') // NOSONAR: dev-only CLI path
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const cases = lines.filter((r) => r.kind !== 'summary' && r.kind !== 'fatal')
const summary = lines.find((r) => r.kind === 'summary')

function quantile (values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1] !== undefined ? sorted[base + 1] : sorted[base]
  return +(sorted[base] + rest * (next - sorted[base])).toFixed(1)
}

const byKind = new Map()
for (const r of cases) {
  if (!byKind.has(r.kind)) byKind.set(r.kind, [])
  byKind.get(r.kind).push(r)
}

const kinds = {}
for (const [kind, rows] of byKind) {
  const ok = rows.filter((r) => r.ok)
  const ms = ok.map((r) => r.ms)
  const lat = ok.filter((r) => typeof r.maxLatencyMs === 'number').map((r) => r.maxLatencyMs)
  kinds[kind] = {
    runs: rows.length,
    failed: rows.length - ok.length,
    p50Ms: quantile(ms, 0.5),
    p95Ms: quantile(ms, 0.95),
    maxMs: ms.length ? Math.max(...ms) : null,
    ...(lat.length ? { p50LatencyMs: quantile(lat, 0.5), maxLatencyMs: Math.max(...lat) } : {})
  }
}

const rss = cases.filter((r) => r.rss).map((r) => r.rss)
const first = cases[0]
const last = cases[cases.length - 1]

const errors = {}
for (const r of cases) {
  if (r.ok) continue
  errors[r.error] = (errors[r.error] || 0) + 1
}

console.log(JSON.stringify({
  file: path.basename(file),
  summary,
  cases: cases.length,
  kinds,
  rssMB: {
    first: +(first.rss / 1048576).toFixed(1),
    last: +(last.rss / 1048576).toFixed(1),
    min: +(Math.min(...rss) / 1048576).toFixed(1),
    max: +(Math.max(...rss) / 1048576).toFixed(1)
  },
  errors
}, null, 1))
