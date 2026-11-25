'use strict'

// Measures steady-state throughput after the tunnel is up (loopback DHT),
// with and without mux, plus CPU time spent. Answers: is the JS side the cap?

const crypto = require('node:crypto')
const net = require('node:net')
const path = require('node:path')
const os = require('node:os')
const fsp = require('node:fs/promises')
const { startServer } = require('D:/tunnel/p2pgate/src/server')
const { startClient } = require('D:/tunnel/p2pgate/src/client')
const { deriveScramVerifier, serializeScramVerifier } = require('D:/tunnel/p2pgate/src/crypto-utils')
const { generateClientKey } = require('D:/tunnel/p2pgate/src/keygen')

const MB = 1024 * 1024
const TOTAL = 64 * MB
const CHUNK = 64 * 1024

async function run (useMux) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p2p-throughput-'))

  // sink target: read and discard, never write back
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
    localPort: 18199,
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
    { log: () => {}, credential: password, mux: useMux }
  )

  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((r) => socket.once('connect', r))

  const payload = crypto.randomBytes(CHUNK)
  const cpuStart = process.cpuUsage()
  const start = process.hrtime.bigint()

  let sent = 0
  while (sent < TOTAL) {
    if (!socket.write(payload)) {
      await new Promise((r) => socket.once('drain', r))
    }
    sent += payload.length
  }
  socket.end()

  // wait until the sink has everything (or close)
  const deadline = Date.now() + 120_000
  while (received < TOTAL && Date.now() < deadline) { // NOSONAR: received is updated by the socket data handler
    await new Promise((r) => setTimeout(r, 50))
  }

  const elapsedNs = Number(process.hrtime.bigint() - start)
  const cpu = process.cpuUsage(cpuStart)
  const cpuNs = (cpu.user + cpu.system) * 1000

  socket.destroy()
  await client.close()
  await server.close()
  sink.close()
  await fsp.rm(dir, { recursive: true, force: true })

  return {
    mux: useMux,
    sentMB: +(sent / MB).toFixed(1),
    receivedMB: +(received / MB).toFixed(1),
    seconds: +(elapsedNs / 1e9).toFixed(2),
    MBps: +((received / MB) / (elapsedNs / 1e9)).toFixed(1),
    cpuSeconds: +(cpuNs / 1e9).toFixed(2),
    cpuPercentOfOneCore: +((cpuNs / elapsedNs) * 100).toFixed(1)
  }
}

async function main () {
  const results = []
  for (const useMux of [true, false]) {
    results.push(await run(useMux))
  }
  console.log(JSON.stringify(results, null, 1))
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
