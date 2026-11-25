'use strict'

// One p2pgate client, several simultaneous sockets, one file split between them.
// Answers: does striping across channels/flows raise aggregate throughput, or is the
// link a hard cap?
//
// Env: MASTER_SECRET, PASSWORD, MUX (1 = one mux carrier, 0 = one connection per socket)
// Args: <file> <parts> <label>

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { startClient } = require('D:/tunnel/p2pgate/src/client')
const { generateClientKey } = require('D:/tunnel/p2pgate/src/keygen')

const MB = 1024 * 1024
const CHUNK = 64 * 1024

async function main () {
  const file = process.argv[2]
  const parts = Math.max(1, Number(process.argv[3] || 2))
  const label = process.argv[4] || path.basename(file)
  const secret = process.env.MASTER_SECRET
  const password = process.env.PASSWORD
  const useMux = process.env.MUX !== '0'
  if (!file || !secret || !password) throw new Error('usage: file parts label + MASTER_SECRET + PASSWORD')

  const buf = fs.readFileSync(file) // NOSONAR: dev-only CLI path
  const per = Math.ceil(buf.length / parts)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-link-'))
  const clientKeyPath = path.join(dir, 'client-key.json')
  await generateClientKey(clientKeyPath)

  const config = {
    mode: 'client',
    masterSecret: secret,
    authMode: 'password',
    targetHost: '127.0.0.1',
    targetPort: 1,
    localPort: 0,
    clientKeyPath,
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: path.join(dir, 'trusted_devices'),
    auditLog: { enabled: false },
    customBootstrap: [],
    authPin: { enabled: true, unattended: null },
    telegramAlert: { enabled: false, botToken: '', chatId: '' }
  }

  const client = await startClient(config, {
    log: () => {}, credential: password, mux: useMux
  })

  const port = client.address().port
  const start = process.hrtime.bigint()

  const results = await Promise.all(Array.from({ length: parts }, async (_, i) => {
    const slice = buf.subarray(i * per, Math.min((i + 1) * per, buf.length))
    const socket = net.createConnection({ host: '127.0.0.1', port })
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.on('error', () => {})

    const localStart = process.hrtime.bigint()
    let offset = 0
    while (offset < slice.length) {
      const piece = slice.subarray(offset, Math.min(offset + CHUNK, slice.length))
      offset += piece.length
      if (!socket.write(piece)) await new Promise((resolve) => socket.once('drain', resolve))
    }
    socket.end()
    await new Promise((resolve) => socket.once('close', resolve))
    return Number(process.hrtime.bigint() - localStart) / 1e9
  }))

  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  await client.close()

  console.log(JSON.stringify({
    label,
    mux: useMux,
    parts,
    bytes: buf.length,
    MB: +(buf.length / MB).toFixed(2),
    seconds: +seconds.toFixed(2),
    MBps: +((buf.length / MB) / seconds).toFixed(2),
    perSocketSeconds: results.map((v) => +v.toFixed(2)),
    sha256: crypto.createHash('sha256').update(buf).digest('hex')
  }))

  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
