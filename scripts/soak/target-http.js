'use strict'

// Serves one file over HTTP on 127.0.0.1 for soak tests.
// usage: node target-http.js <file> [port]

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const file = process.argv[2]
const port = Number(process.argv[3] || 18081)

if (!file || !fs.existsSync(file)) {
  console.error('target-http: file not found:', file)
  process.exit(1)
}

const stat = fs.statSync(file) // NOSONAR: dev-only CLI path

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/big.bin')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store'
    })
    fs.createReadStream(file).pipe(res) // NOSONAR: dev-only CLI path
    return
  }

  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('p2pgate soak target\n')
})

server.listen(port, '127.0.0.1', () => {
  console.log(
    `target-http: ${path.basename(file)} (${stat.size} bytes) on 127.0.0.1:${port}`
  )
})
