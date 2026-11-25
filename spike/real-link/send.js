'use strict'

// Runs on Windows. Pushes one file through the real DHT tunnel to the Termux sink.
//
// Env: MASTER_SECRET, PASSWORD, MUX (1/0, default 1)
// Args: <file> <label>

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
  const label = process.argv[3] || path.basename(file)
  const secret = process.env.MASTER_SECRET
  const password = process.env.PASSWORD
  const useMux = process.env.MUX !== '0'
  const useCompress = process.env.COMPRESS === '1'
  if (!file || !secret || !password) throw new Error('usage: file + MASTER_SECRET + PASSWORD')

  const buf = fs.readFileSync(file) // NOSONAR: dev-only CLI path
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-link-'))
  const clientKeyPath = process.env.CLIENT_KEY || path.join(dir, 'client-key.json')
  fs.mkdirSync(path.dirname(clientKeyPath), { recursive: true })
  if (!fs.existsSync(clientKeyPath)) await generateClientKey(clientKeyPath)

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
    log: () => {}, credential: password, mux: useMux, compress: useCompress,
    target: process.env.TARGET || undefined
  })

  const socket = net.createConnection({ host: '127.0.0.1', port: client.address().port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.on('error', () => {})

  const start = process.hrtime.bigint()
  let offset = 0
  while (offset < buf.length) {
    const slice = buf.subarray(offset, Math.min(offset + CHUNK, buf.length))
    offset += slice.length
    if (!socket.write(slice)) await new Promise((resolve) => socket.once('drain', resolve))
  }
  socket.end()
  const writeSeconds = Number(process.hrtime.bigint() - start) / 1e9

  await new Promise((resolve) => socket.once('close', resolve))
  const seconds = Number(process.hrtime.bigint() - start) / 1e9

  await client.close()

  console.log(JSON.stringify({
    label,
    bytes: buf.length,
    MB: +(buf.length / MB).toFixed(2),
    seconds: +seconds.toFixed(2),
    MBps: +((buf.length / MB) / seconds).toFixed(2),
    writeSeconds: +writeSeconds.toFixed(2),
    sha256
  }))

  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
