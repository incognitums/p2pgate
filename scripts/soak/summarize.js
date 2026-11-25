'use strict'

// Summarizes a soak CSV (mux-windows.ps1 output) or a server RSS CSV.
// usage: node summarize.js <file.csv>

const fs = require('node:fs')

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error('usage: node summarize.js <file.csv>')
  process.exit(1)
}

const rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) // NOSONAR: dev-only CLI path
const header = rawLines[0].split(',')
const lines = rawLines.slice(1)

if (header[0] === 'time' && header.includes('ok')) {
  const rows = lines.map((line) => {
    const cells = line.split(',')
    const row = {}
    header.forEach((key, index) => { row[key] = cells[index] })
    return row
  })

  const ok = rows.filter((row) => row.ok === 'true')
  const failed = rows.filter((row) => row.ok !== 'true')
  const mbps = ok.map((row) => Number(row.mbps)).filter((value) => Number.isFinite(value) && value > 0)
  const rss = rows.map((row) => Number(row.clientRssMB)).filter((value) => Number.isFinite(value) && value > 0)
  const carriers = rows.map((row) => Number(row.carriers)).filter((value) => Number.isFinite(value))

  const min = (list) => (list.length ? Math.min(...list) : 0)
  const max = (list) => (list.length ? Math.max(...list) : 0)
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0)

  // Failure clusters: consecutive failures usually mean one network outage.
  const clusters = []
  let streak = 0

  rows.forEach((row, index) => {
    if (row.ok !== 'true') {
      streak += 1
      if (streak === 1) clusters.push({ start: index, count: 0 })
      clusters[clusters.length - 1].count += 1
      return
    }

    streak = 0
  })

  const carrierSteps = []
  let lastCarriers = 0
  rows.forEach((row) => {
    const value = Number(row.carriers)
    if (!Number.isFinite(value)) return
    if (value > lastCarriers) {
      carrierSteps.push({ time: row.time, from: lastCarriers, to: value })
      lastCarriers = value
    }
  })

  console.log(`file:        ${file}`)
  console.log(`iterations:  ${rows.length}`)
  console.log(`ok:          ${ok.length}`)
  console.log(`failed:      ${failed.length}`)
  console.log(`window:      ${rows[0] ? rows[0].time : '-'} -> ${rows[rows.length - 1] ? rows[rows.length - 1].time : '-'}`)
  console.log(`throughput:  min ${min(mbps)} / avg ${avg(mbps).toFixed(2)} / max ${max(mbps)} MB/s`)
  console.log(`client RSS:  min ${min(rss)} / max ${max(rss)} MB`)
  console.log(`carriers:    ${max(carriers)} established (reconnects: ${Math.max(0, max(carriers) - 1)})`)

  if (clusters.length) {
    let recoveredClusters = 0
    for (const cluster of clusters) {
      const next = rows[cluster.start + cluster.count]
      cluster.recovered = Boolean(next && next.ok === 'true')
      if (cluster.recovered) recoveredClusters += 1
    }

    console.log(`outages:     ${clusters.length} cluster(s), longest ${max(clusters.map((c) => c.count))} iteration(s)`)
    console.log(`recovered:   ${recoveredClusters}/${clusters.length} cluster(s) recovered afterwards`)

    for (const cluster of clusters) {
      const first = rows[cluster.start]
      const last = rows[cluster.start + cluster.count - 1]
      console.log(
        `  ${first.time}  ${cluster.count} failure(s)  ${first.error || '?'}` +
        `${last !== first ? ` -> ${last.error || '?'}` : ''}  -> ${cluster.recovered ? 'recovered' : 'NOT recovered yet'}`
      )
    }

    if (max(clusters.map((c) => c.count)) > 3) {
      console.log('note:        a long cluster means the network path stayed broken; check router/Wi-Fi/virtual adapters')
    } else {
      console.log('note:        failures clustered around a network drop are expected')
    }
  }

  if (failed.length) {
    console.log('failures:')
    for (const row of failed.slice(0, 20)) {
      console.log(`  ${row.time} bytes=${row.bytes} error=${row.error || '?'}`)
    }
  }

  process.exit(failed.length === 0 || clusters.every((c) => c.recovered) ? 0 : 1)
}

if (header[0] !== 'time' || header.includes('rss_kb')) {
  const rows = rawLines.map((line) => line.split(',')).filter((cells) => cells.length >= 3)
  const values = rows
    .map((cells) => Number(cells[2]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((kb) => kb / 1024)

  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 0
  console.log(`file:        ${file}`)
  console.log(`samples:     ${values.length}`)
  console.log(`server RSS:  min ${min.toFixed(1)} / max ${max.toFixed(1)} MB`)
  process.exit(0)
}

console.log('unrecognized csv format:', header.join(','))
process.exit(1)

