'use strict'

// Would compressing the stream before the tunnel make transfers faster?
// Real end-to-end measurement (server + client in one process, loopback DHT).
//
// Usage: node spike/compression-spike.js [gzip|zstd|brotli] [level]
// No dependencies: Node 24 ships gzip, brotli and zstd in node:zlib.

const crypto = require('node:crypto')
const net = require('node:net')
const zlib = require('node:zlib')
const path = require('node:path')
const os = require('node:os')
const fsp = require('node:fs/promises')
const { startServer } = require('D:/tunnel/p2pgate/src/server')
const { startClient } = require('D:/tunnel/p2pgate/src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('D:/tunnel/p2pgate/src/crypto-utils')
const { generateClientKey } = require('D:/tunnel/p2pgate/src/keygen')

const MB = 1024 * 1024
const SIZE = Number(process.env.P2P_SIZE_MB || 16) * MB
const CHUNK = 64 * 1024

const ZSTD_LEVEL = zlib.constants.ZSTD_c_compressionLevel
const BROTLI_QUALITY = zlib.constants.BROTLI_PARAM_QUALITY

function codecFrom (name, level) {
  if (name === 'zstd') {
    return {
      name: `zstd-${level}`,
      compress: (b) => zlib.zstdCompressSync(b, { params: { [ZSTD_LEVEL]: level } }),
      decompress: zlib.zstdDecompressSync
    }
  }
  if (name === 'brotli') {
    return {
      name: `brotli-${level}`,
      compress: (b) => zlib.brotliCompressSync(b, { params: { [BROTLI_QUALITY]: level } }),
      decompress: zlib.brotliDecompressSync
    }
  }
  return {
    name: `gzip-${level}`,
    compress: (b) => zlib.gzipSync(b, { level }),
    decompress: zlib.gunzipSync
  }
}

function makeText () {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const words = []
  for (let i = 0; i < 800; i++) {
    let w = ''
    for (let j = 0; j < 4 + (i % 5); j++) w += alphabet[(i * 7 + j * 13) % 26]
    words.push(w)
  }
  const parts = []
  let n = 0
  while (n < SIZE) {
    // deterministic tokens so both the raw and compressed runs use identical bytes
    const token = crypto.createHash('sha256').update(String(n)).digest('base64').slice(0, 4)
    const line = `${n}\t${words[n % words.length]}\t${words[(n * 31) % words.length]}\t` +
      `${token}\tvalue=${(n * 2654435761) % 100000}\n`
    parts.push(line)
    n += Buffer.byteLength(line)
  }
  return Buffer.from(parts.join('')).subarray(0, SIZE)
}

async function tunnel (payload) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p2p-compress-'))

  let received = 0
  const sink = net.createServer((s) => {
    s.on('error', () => {})
    s.on('data', (c) => { received += c.length })
  })
  await new Promise((r) => sink.listen(0, '127.0.0.1', r))
  const sinkPort = sink.address().port

  const secret = crypto.randomBytes(32).toString('hex')
  const password = 'TESTPASSWORD000000000001'
  const verifier = serializeScramVerifier(await deriveScramVerifier(password))
  const keyPath = path.join(dir, 'client-key.json')
  await generateClientKey(keyPath)

  const base = {
    mode: 'server',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: sinkPort,
    localPort: 18197,
    clientKeyPath: path.join(dir, 'server-key.json'),
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: verifier },
    telegramAlert: { enabled: false, botToken: '', chatId: '' }
  }

  const server = await startServer(base, {
    log: () => {}, showSessionPin: false, sendStartupAlert: false, interactive: false
  })
  const client = await startClient(
    { ...base, mode: 'client', localPort: 0, clientKeyPath: keyPath, authPin: { enabled: true, unattended: null } },
    { log: () => {}, credential: password, mux: true }
  )

  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((r) => socket.once('connect', r))

  const start = process.hrtime.bigint()
  let offset = 0
  while (offset < payload.length) {
    const slice = payload.subarray(offset, offset + CHUNK)
    offset += slice.length
    if (!socket.write(slice)) await new Promise((r) => socket.once('drain', r))
  }
  socket.end()

  const deadline = Date.now() + 120_000
  while (received < payload.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const seconds = Number(process.hrtime.bigint() - start) / 1e9

  socket.destroy()
  await client.close()
  await server.close()
  sink.close()
  await fsp.rm(dir, { recursive: true, force: true })

  return { seconds, received }
}

async function main () {
  const codecName = (process.argv[2] || 'zstd').toLowerCase()
  const level = Number(process.argv[3] || 1)
  const codec = codecFrom(codecName, level)

  const cases = [
    { name: 'text', data: makeText() },
    { name: 'random', data: crypto.randomBytes(SIZE) }
  ]

  const out = []
  for (const item of cases) {
    const raw = await tunnel(item.data)
    const rawMBps = (SIZE / MB) / raw.seconds

    const t0 = process.hrtime.bigint()
    const compressed = codec.compress(item.data)
    const compressSeconds = Number(process.hrtime.bigint() - t0) / 1e9

    const viaCompressed = await tunnel(compressed)

    const t1 = process.hrtime.bigint()
    const inflated = codec.decompress(compressed)
    const decompressSeconds = Number(process.hrtime.bigint() - t1) / 1e9

    const ok = inflated.length === item.data.length &&
      crypto.createHash('sha256').update(inflated).digest('hex') ===
      crypto.createHash('sha256').update(item.data).digest('hex')

    const total = compressSeconds + viaCompressed.seconds + decompressSeconds
    out.push({
      case: item.name,
      codec: codec.name,
      originalMB: SIZE / MB,
      compressedMB: +(compressed.length / MB).toFixed(2),
      ratio: +(item.data.length / compressed.length).toFixed(2),
      rawTunnelSeconds: +raw.seconds.toFixed(2),
      rawMBps: +rawMBps.toFixed(1),
      compressedTunnelSeconds: +viaCompressed.seconds.toFixed(2),
      compressSeconds: +compressSeconds.toFixed(2),
      decompressSeconds: +decompressSeconds.toFixed(2),
      effectiveMBps: +((SIZE / MB) / total).toFixed(1),
      speedup: +(((SIZE / MB) / total) / rawMBps).toFixed(2),
      integrity: ok
    })
  }

  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
