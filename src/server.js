'use strict'

const net = require('node:net')
const crypto = require('node:crypto')
const HyperDHT = require('hyperdht')
const {
  getSlot,
  deriveSlotKeyPair,
  deriveServerPublicKeyHex,
  publicKeyToHex,
  normalizeClientPublicKeyHex,
  generateSessionPin,
  formatSessionPin,
  deriveScramVerifier,
  parseScramVerifier,
  buildAuthMessage,
  verifyScramProof,
  computeServerSignature,
  isHex64
} = require('./crypto-utils')
const {
  AUTH_VERSION,
  AUTH_TIMEOUT_MS,
  MAX_CONTROL_BYTES,
  AUTH_STATUS,
  encodeControl,
  decodeControl,
  readControlLine,
  peekControlLine
} = require('./auth')
const { AuthGuard } = require('./auth-guard')
const {
  DeviceRegistry,
  evaluateDevicePolicy,
  normalizeVerificationMode
} = require('./device-registry')
const { parseAllowEntry, resolveAllowedHost } = require('./allowlist')
const dgram = require('node:dgram')
const { encodeFrame, createDecoder, MAX_DATAGRAM } = require('./udp')
const {
  MUX_VERSION,
  DEFAULT_MAX_CHANNELS,
  MAX_CARRIERS,
  MAX_TOTAL_CHANNELS,
  TYPE: MUX_TYPE,
  FLAG: MUX_FLAG,
  CHANNEL_WINDOW,
  MAX_QUEUED,
  MAX_CHANNEL_QUEUE,
  MUX_IDLE_MS,
  MAX_FRAME,
  encodeFrame: encodeMuxFrame,
  FrameParser,
  encodeJson,
  decodeJson,
  encodeUInt32,
  decodeUInt32,
  muxError
} = require('./mux')
const {
  COMPRESS_VERSION,
  normalizeCompressConfig,
  pickAlgorithm,
  createCompressor,
  createDecompressor,
  createCompressedStream,
  writeAndFlush,
  guardDecompressor
} = require('./compress')
const {
  defaultControlSocketPath,
  defaultControlTokenPath,
  createControlToken,
  removeControlToken,
  startControlServer
} = require('./control')
const { createAuditLog } = require('./audit-log')

const ROTATION_CHECK_MS = 60_000
const ALERT_MIN_INTERVAL_MS = 60_000
const LOCAL_CONNECT_TIMEOUT_MS = 10_000
const TELEGRAM_TIMEOUT_MS = 5_000
const MAX_ALERT_TRACKED_KEYS = 1000
const PRE_AUTH_TIMEOUT_MS = 120_000
const DEFAULT_MUX_PEEK_MS = 200
const MAX_MUX_UPGRADE_BYTES = 512

/**
 * Parses the single control line a fast-path client may send inside the peek
 * window: either a mux upgrade or a target request. Returns null for anything
 * else (which is then forwarded to the target as payload).
 */
function parseFastpathRequest(line) {
  if (typeof line !== 'string' || line.trim() === '') return null

  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.v !== AUTH_VERSION) return null

  const mux = parsed.mux
  if (mux && typeof mux === 'object' && !Array.isArray(mux)) {
    if (Number(mux.version) === MUX_VERSION) return { kind: 'mux' }
    return null
  }

  let compress = null
  if (parsed.compress && typeof parsed.compress === 'object' && !Array.isArray(parsed.compress)) {
    if (Number(parsed.compress.version) === COMPRESS_VERSION &&
      Array.isArray(parsed.compress.algorithms)) {
      compress = { algorithms: parsed.compress.algorithms }
    }
  }

  if (typeof parsed.target === 'string' && parsed.target.trim() !== '') {
    const name = parsed.target.trim()
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return null
    return { kind: 'target', target: name, compress }
  }

  if (compress) return { kind: 'compress', compress }

  return null
}

function noop() {}

function nowIso() {
  return new Date().toISOString()
}

class AlertRateLimiter {
  constructor(windowMs = ALERT_MIN_INTERVAL_MS, maxEntries = MAX_ALERT_TRACKED_KEYS) {
    this.windowMs = windowMs
    this.maxEntries = maxEntries
    this.lastSent = new Map()
  }

  shouldSend(key) {
    const now = Date.now()
    const previous = this.lastSent.get(key)

    if (previous !== undefined && now - previous < this.windowMs) {
      return false
    }

    this.lastSent.set(key, now)
    this._prune(now)
    return true
  }

  _prune(now) {
    if (this.lastSent.size <= this.maxEntries) return

    for (const [key, timestamp] of this.lastSent) {
      if (now - timestamp > this.windowMs * 5) this.lastSent.delete(key)
    }

    if (this.lastSent.size <= this.maxEntries) return

    const target = Math.floor(this.maxEntries / 2)
    for (const key of this.lastSent.keys()) {
      if (this.lastSent.size <= target) break
      this.lastSent.delete(key)
    }
  }
}

function validateTelegramConfig(value) {
  if (!value || value.enabled !== true) return null

  const botToken = String(value.botToken || '').trim()
  const chatId = String(value.chatId || '').trim()

  if (!botToken || !chatId) {
    const err = new Error('telegramAlert.enabled requires botToken and chatId')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  return { botToken, chatId }
}

async function sendTelegramMessage(telegram, text) {
  if (!telegram) return false

  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
    })

    return response.ok
  } catch {
    return false
  }
}

function normalizeAllowedKeys(value) {
  if (!Array.isArray(value)) {
    const err = new Error('allowedClientKeys must be an array of 64-character hex public keys')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const set = new Set()

  for (let i = 0; i < value.length; i++) {
    try {
      set.add(normalizeClientPublicKeyHex(value[i]))
    } catch (err) {
      const wrapped = new Error(`allowedClientKeys[${i}] is invalid: ${err.message}`)
      wrapped.code = 'CONFIG_INVALID'
      throw wrapped
    }
  }

  return set
}

function validateTargetPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    const err = new Error('targetPort must be an integer between 1 and 65535')
    err.code = 'CONFIG_INVALID'
    throw err
  }
  return value
}

function writeAuthMessage(stream, message) {
  try {
    stream.write(encodeControl(message))
    return true
  } catch {
    return false
  }
}

function endAuthStream(stream, graceMs = 3000) {
  try {
    stream.end()
  } catch {
    // Ignore.
  }

  const timer = setTimeout(() => {
    if (!stream.destroyed) stream.destroy()
  }, graceMs)

  if (typeof timer.unref === 'function') timer.unref()
}

/**
 * Starts the hardened P2P gateway server.
 */
async function startServer(config, options = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('server configuration is required')
  }

  if (typeof config.masterSecret !== 'string') {
    const err = new Error('masterSecret is required')
    err.code = 'MASTER_SECRET_INVALID'
    throw err
  }

  const allowedSet = normalizeAllowedKeys(config.allowedClientKeys)
  const verificationMode = normalizeVerificationMode(config.verificationMode)
  const authMode = config.authMode === 'password' ? 'password' : 'registry'
  const sessionAuthEnabled = verificationMode !== 'key-only'

  const targetHost = config.targetHost === undefined ? '127.0.0.1' : String(config.targetHost)
  if (targetHost !== '127.0.0.1') {
    const err = new Error('targetHost must be 127.0.0.1')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const targetPort = validateTargetPort(config.targetPort === undefined ? 8022 : config.targetPort)
  const telegram = validateTelegramConfig(config.telegramAlert)

  const targetDefs = new Map()

  if (config.targets && typeof config.targets === 'object' && !Array.isArray(config.targets)) {
    for (const name of Object.keys(config.targets)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
        const err = new Error(`invalid target name "${name}"`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      const entry = config.targets[name]

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        const err = new Error(`targets.${name} must be an object`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      const host = entry.host === undefined ? '127.0.0.1' : String(entry.host)

      if (host !== '127.0.0.1') {
        const err = new Error(`targets.${name}.host must be 127.0.0.1`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      const port = validateTargetPort(entry.port)
      const allow = Array.isArray(entry.allow)
        ? entry.allow.map((value) => String(value))
        : null

      targetDefs.set(name, { name, host, port, allow })
    }
  }

  if (targetDefs.size === 0) {
    targetDefs.set('default', {
      name: 'default',
      host: '127.0.0.1',
      port: targetPort,
      allow: null
    })
  }

  const defaultTargetName = (() => {
    const requested = typeof config.defaultTarget === 'string' ? config.defaultTarget.trim() : ''
    if (requested !== '' && targetDefs.has(requested)) return requested
    if (targetDefs.has('default')) return 'default'
    return targetDefs.keys().next().value
  })()

  const effectiveTargetPort = targetDefs.get(defaultTargetName).port

  const socksConfig = config.socks && typeof config.socks === 'object' ? config.socks : {}
  const socksEnabled = socksConfig.enabled === true
  const socksEntries = (Array.isArray(socksConfig.allow) ? socksConfig.allow : []).map((entry) => {
    try {
      return parseAllowEntry(entry)
    } catch (err) {
      const wrapped = new Error(err.message)
      wrapped.code = 'CONFIG_INVALID'
      throw wrapped
    }
  })

  const socksPerClient = new Map()

  if (socksEnabled && socksConfig.perClient && typeof socksConfig.perClient === 'object') {
    for (const [key, entries] of Object.entries(socksConfig.perClient)) {
      if (!Array.isArray(entries)) continue
      socksPerClient.set(
        String(key).toLowerCase(),
        entries.map((entry) => parseAllowEntry(entry))
      )
    }
  }

  if (socksEnabled && socksEntries.length === 0) {
    const err = new Error('socks.enabled requires at least one socks.allow entry')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const udpTargetDefs = new Map()

  if (config.udpTargets && typeof config.udpTargets === 'object' && !Array.isArray(config.udpTargets)) {
    for (const [name, entry] of Object.entries(config.udpTargets)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
        const err = new Error(`invalid udp target name "${name}"`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        const err = new Error(`udpTargets.${name} must be an object`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      const host = entry.host === undefined ? '127.0.0.1' : String(entry.host)

      if (host !== '127.0.0.1') {
        const err = new Error(`udpTargets.${name}.host must be 127.0.0.1`)
        err.code = 'CONFIG_INVALID'
        throw err
      }

      udpTargetDefs.set(name, {
        name,
        host,
        port: validateTargetPort(entry.port),
        type: 'udp'
      })
    }
  }

  function resolveUdpTarget(request) {
    const name = request && typeof request === 'object' && typeof request.target === 'string'
      ? request.target.trim()
      : ''

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || !udpTargetDefs.has(name)) {
      const err = new Error(`unknown udp target "${name}"`)
      err.code = 'UDP_TARGET_UNKNOWN'
      throw err
    }

    return udpTargetDefs.get(name)
  }

  /**
   * Resolves a SOCKS5 CONNECT request (host:port) against the server-side
   * IP/CIDR allowlist. Hostnames are resolved on the server and every resolved
   * address must match the allowlist, so a hostile DNS answer cannot reach an
   * unlisted destination.
   */
  async function resolveSocksTarget(request, remoteHex) {
    if (!socksEnabled) {
      const err = new Error('SOCKS is disabled on this server')
      err.code = 'SOCKS_DISABLED'
      throw err
    }

    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      const err = new Error('invalid SOCKS request')
      err.code = 'SOCKS_DENIED'
      throw err
    }

    const host = typeof request.host === 'string' ? request.host.trim() : ''
    const port = Number(request.port)

    if (host === '' || host.length > 253 ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
      const err = new Error('invalid SOCKS destination')
      err.code = 'SOCKS_DENIED'
      throw err
    }

    const allowedIp = await resolveAllowedHost(
      host,
      port,
      socksPerClient.get(remoteHex.toLowerCase()) || socksEntries
    )

    if (!allowedIp) {
      writeLog(`SOCKS DENIED client=${remoteHex} destination=${host}:${port}`)
      const err = new Error(`destination not allowed: ${host}:${port}`)
      err.code = 'SOCKS_DENIED'
      throw err
    }

    writeLog(`SOCKS ALLOW client=${remoteHex} ${host}:${port} -> ${allowedIp}`)
    return { name: 'socks', host: allowedIp, port }
  }

  /**
   * Resolves a client-supplied target name against the server-side allowlist.
   * Clients never send host:port; only a name from the config is accepted.
   */
  function resolveTarget(requestedName, remoteHex) {
    const name = typeof requestedName === 'string' && requestedName.trim() !== ''
      ? requestedName.trim()
      : defaultTargetName

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || !targetDefs.has(name)) {
      const err = new Error(`unknown target "${name}"`)
      err.code = 'TARGET_UNKNOWN'
      throw err
    }

    const target = targetDefs.get(name)

    if (Array.isArray(target.allow)) {
      const wanted = String(remoteHex).toLowerCase()
      const allowed = target.allow.some((entry) => {
        return entry === '*' || entry.toLowerCase() === wanted
      })

      if (!allowed) {
        const err = new Error(`target "${name}" is not allowed for this client`)
        err.code = 'TARGET_FORBIDDEN'
        throw err
      }
    }

    return target
  }


  if (config.authPin && config.authPin.unattendedPasswordHash !== undefined) {
    const err = new Error(
      'v1.1 authPin format detected; run p2pgate setup to migrate the credential'
    )
    err.code = 'AUTH_CONFIG_UPGRADE_REQUIRED'
    throw err
  }

  const authPin = config.authPin || { enabled: true, unattended: null }
  const unattendedVerifier = authPin.unattended
    ? parseScramVerifier(authPin.unattended)
    : null
  const hasFallback = unattendedVerifier !== null
  if (authMode === 'password' && !unattendedVerifier) {
    const err = new Error(
      'authMode is password but authPin.unattended is not configured; run p2pgate setup or p2pgate password reset'
    )
    err.code = 'PASSWORD_NOT_CONFIGURED'
    throw err
  }
  if (authMode === 'password' && verificationMode === 'key-only') {
    const err = new Error(
      'authMode=password cannot be combined with verificationMode=key-only'
    )
    err.code = 'CONFIG_INVALID'
    throw err
  }
  const interactive = options.interactive !== undefined
    ? options.interactive === true
    : Boolean(process.stdout.isTTY)

  const authTimeoutMs = Number.isInteger(options.authTimeoutMs)
    ? options.authTimeoutMs
    : AUTH_TIMEOUT_MS
  const preAuthTimeoutMs = Number.isInteger(options.preAuthTimeoutMs)
    ? options.preAuthTimeoutMs
    : PRE_AUTH_TIMEOUT_MS
  const udpIdleTimeoutMs = Number.isInteger(options.udpIdleTimeoutMs)
    ? options.udpIdleTimeoutMs
    : 60_000
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : null
  const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : null
  const onceMode = options.once === true

  const startedAt = Date.now()
  const log = typeof options.log === 'function'
    ? options.log
    : (line) => console.log(line)

  const rotationCheckMs = Number.isInteger(options.rotationCheckMs)
    ? options.rotationCheckMs
    : ROTATION_CHECK_MS
  const localConnectTimeoutMs = Number.isInteger(options.localConnectTimeoutMs)
    ? options.localConnectTimeoutMs
    : LOCAL_CONNECT_TIMEOUT_MS
  const muxPeekMs = Number.isInteger(options.muxPeekMs)
    ? options.muxPeekMs
    : (Number.isInteger(config.muxPeekMs) ? config.muxPeekMs : DEFAULT_MUX_PEEK_MS)
  const muxAllowed = options.mux === undefined
    ? config.mux !== false
    : options.mux !== false
  const compressConfig = normalizeCompressConfig(config.compress)
  const compressEnabled = options.compress === undefined
    ? compressConfig.enabled === true
    : options.compress === true
  const compressAlgorithms = compressConfig.algorithms
  const nowMs = typeof options.now === 'function' ? options.now : Date.now

  const dhtOptions = {}
  if (Array.isArray(config.customBootstrap) && config.customBootstrap.length > 0) {
    dhtOptions.bootstrap = [...config.customBootstrap]
  }
  if (options.dhtOptions && typeof options.dhtOptions === 'object') {
    Object.assign(dhtOptions, options.dhtOptions)
  }

  function writeLog(message) {
    log(`[${nowIso()}] ${message}`)
  }

  const authGuard = new AuthGuard({
    statePath: options.lockoutStatePath,
    now: options.lockoutNow,
    failDelayMs: options.failDelayMs,
    maxConcurrent: options.authMaxConcurrent,
    log: writeLog
  })
  await authGuard.init()

  const auditConfig = config.auditLog && typeof config.auditLog === 'object'
    ? config.auditLog
    : {}
  const audit = createAuditLog({
    enabled: options.auditLog === false
      ? false
      : auditConfig.enabled !== false,
    path: options.auditLogPath || auditConfig.path,
    maxBytes: auditConfig.maxBytes,
    log: writeLog
  })
  await audit.init()

  const registry = new DeviceRegistry({
    configKeys: [...allowedSet],
    filePath: config.trustedDevicesFile,
    verificationMode,
    now: typeof options.registryNow === 'function' ? options.registryNow : Date.now,
    log: writeLog,
    posixCheck: options.posixCheck
  })
  await registry.init()

  if (registry.isEmpty() && authMode !== 'password') {
    const err = new Error(
      'No client devices are registered in allowedClientKeys or trusted_devices'
    )
    err.code = 'ALLOWED_KEYS_EMPTY'
    throw err
  }

  let activePin = null

  function displaySessionPin(generation, reason) {
    if (!activePin || options.showSessionPin === false) return

    if (!process.stdout.isTTY) {
      writeLog(
        `SESSION PIN generation=${generation} is available only on an interactive terminal; use an unattended password for headless access`
      )
      return
    }

    const formatted = formatSessionPin(activePin.pin)
    const width = 36
    const content = `  SESSION PIN: ${formatted}`
    const top = `+${'-'.repeat(width)}+`
    const middle = `|${content.padEnd(width)}|`
    const bottom = `+${'-'.repeat(width)}+`

    process.stdout.write(`\n${top}\n${middle}\n${bottom}\n`)
    if (reason === 'startup') {
      process.stdout.write('PIN นี้ใช้สำหรับการเชื่อมต่อรอบนี้ และเก็บไว้ในหน่วยความจำเท่านั้น\n')
    } else {
      process.stdout.write(`Session PIN ถูกเปลี่ยนใหม่ (รอบที่ ${generation})\n`)
    }
    process.stdout.write('ห้ามแชร์ PIN นี้ ระบบจะไม่เขียน PIN ลง config หรือ log\n\n')
  }

  async function createSessionPin(generation, reason) {
    const pin = generateSessionPin()
    const salt = crypto.randomBytes(16)
    const verifier = await deriveScramVerifier(pin, salt)

    activePin = {
      pin,
      generation,
      saltHex: verifier.saltHex,
      storedKey: verifier.storedKey,
      serverKey: verifier.serverKey
    }

    displaySessionPin(generation, reason)
    void audit.record('session.pin.rotate', {
      source: 'server',
      generation,
      reason
    })
    return activePin
  }

  async function refreshSessionPin(reason, expectedGeneration) {
    try {
      const result = await authGuard.refreshPin(async (generation) => {
        await createSessionPin(generation, reason)
      }, expectedGeneration)

      if (!result.refreshed) {
        writeLog(`PIN refresh skipped (already refreshed at generation ${result.generation})`)
      }

      return result.refreshed
    } catch (err) {
      writeLog(`failed to refresh session PIN: ${err.message}`)
      return false
    }
  }

  if (sessionAuthEnabled) {
    await createSessionPin(0, 'startup')
  }

  const dht = new HyperDHT(dhtOptions)
  dht.on('error', (err) => {
    writeLog(`DHT error: ${err.message}`)
  })

  const listeners = new Map()
  const activeConnections = new Set()
  const alertLimiter = new AlertRateLimiter()

  // In-memory traffic counters (no per-byte logging).
  const traffic = { totalIn: 0, totalOut: 0, streams: new Map() }
  const muxSessions = new Set()
  let nextStreamId = 1

  function countMuxChannels() {
    let total = 0
    for (const session of muxSessions) total += session.channels.size
    return total
  }

  function openTrafficRecord(peer, targetName, kind) {
    const record = {
      id: nextStreamId++,
      peer,
      target: targetName,
      kind,
      startedAt: Date.now(),
      in: 0,
      out: 0
    }

    traffic.streams.set(record.id, record)
    return record
  }

  function closeTrafficRecord(record) {
    if (record) traffic.streams.delete(record.id)
  }

  function addInbound(record, bytes) {
    traffic.totalIn += bytes
    if (record) record.in += bytes
  }

  function addOutbound(record, bytes) {
    traffic.totalOut += bytes
    if (record) record.out += bytes
  }

  let currentSlot = getSlot(nowMs())
  let blockedCount = 0
  let closed = false
  let rotationTimer = null
  let lifecycleTimer = null
  let shutdownStarted = false
  let hadConnection = false
  let idleSince = Date.now()
  let control = null
  let controlTokenPath = null

  function sendIntrusionAlert(remotePublicKeyHex) {
    if (!telegram) return
    if (!alertLimiter.shouldSend(remotePublicKeyHex)) return

    const text = [
      '⛔ p2pgate: พบการพยายามเชื่อมต่อที่ไม่ได้รับอนุญาต',
      `เวลา: ${nowIso()}`,
      `คีย์ไคลเอนต์: ${remotePublicKeyHex}`,
      'ระบบได้ตัดการเชื่อมต่อก่อนเปิดพอร์ตภายในแล้ว'
    ].join('\n')

    sendTelegramMessage(telegram, text).catch(noop)
  }

  function notifyAuthGuardEvent(remoteHex, failure) {
    if (!telegram || !failure || !failure.notification) return

    let status
    if (failure.notification === 'permanent') {
      status = 'ระงับถาวรจนกว่าจะปลดล็อกด้วย p2pgate unlock'
    } else {
      status = `ระงับชั่วคราว ${failure.notification}`
    }

    const text = [
      '🚫 p2pgate: พบการยืนยันตัวตนล้มเหลวหลายครั้ง',
      `คีย์ไคลเอนต์: ${remoteHex}`,
      `จำนวนครั้งใน 24 ชั่วโมง: ${failure.failures}`,
      `สถานะ: ${status}`,
      failure.refreshPin ? 'Session PIN ถูกเปลี่ยนใหม่แล้ว (ดูบนหน้าจอ Server)' : null,
      `เวลา: ${nowIso()}`
    ].filter(Boolean).join('\n')

    sendTelegramMessage(telegram, text).catch(noop)
  }

  function firewall(remotePublicKey) {
    try {
      publicKeyToHex(remotePublicKey)
      // Registry/policy decisions happen after transport so the server can
      // return an explicit STATUS_DECLINED frame instead of a silent drop.
      return false
    } catch {
      blockedCount++
      writeLog('BLOCKED connection with malformed remote public key')
      return true
    }
  }

  function sendDeclined(stream, reason, extra = {}) {
    const response = {
      v: AUTH_VERSION,
      status: AUTH_STATUS.DECLINED,
      reason
    }

    if (extra.retryAfterMs !== undefined && extra.retryAfterMs !== null) {
      response.retryAfterMs = extra.retryAfterMs
    }
    if (extra.permanent === true) response.permanent = true

    writeAuthMessage(stream, response)
    endAuthStream(stream, 150)
    return { ok: false }
  }

  async function decideDevice(remoteHex) {
    const device = await registry.evaluate(remoteHex)

    try {
      await authGuard.refreshStateIfChanged()
    } catch (err) {
      writeLog(`failed to refresh lockout state: ${err.message}`)
    }

    if (authGuard.isSuspended(remoteHex)) {
      const status = authGuard.getStatus(remoteHex)
      return {
        action: 'decline',
        reason: 'locked',
        retryAfterMs: status.remainingMs,
        permanent: status.permanent
      }
    }

    if (authMode === 'password') {
      if (!unattendedVerifier) {
        return { action: 'decline', reason: 'password_unavailable' }
      }
      if (device.fastpathAllowed) return { action: 'fastpath' }
      return { action: 'challenge' }
    }

    return evaluateDevicePolicy(device, {
      verificationMode,
      interactive,
      hasFallback
    })
  }

  function handleIncomingStream(stream, slot) {
    let remoteHex = 'unknown'
    try {
      remoteHex = publicKeyToHex(stream.remotePublicKey)
    } catch {
      // The firewall already validated the handshake.
    }

    // Safety net: a stream error must never become an unhandled 'error' event,
    // especially while auth is in progress and no pipe is attached.
    stream.on('error', noop)

    const entry = { stream, socket: null, remoteKey: remoteHex }
    activeConnections.add(entry)

    authenticateStream(stream, remoteHex)
      .then((result) => {
        if (!result.ok) {
          activeConnections.delete(entry)
          return
        }

        if (closed) {
          activeConnections.delete(entry)
          if (!stream.destroyed) stream.destroy()
          return
        }

        if (result.mux) {
          startMuxSession(stream, entry, remoteHex, result.leftover)
          return
        }

        if (result.target && result.target.type === 'udp') {
          startUdpSession(stream, entry, remoteHex, result.target, result.leftover)
          return
        }

        let tunnel = stream
        let leftover = result.leftover

        if (result.compress) {
          tunnel = createCompressedStream(stream, result.compress, compressConfig, leftover)
          leftover = Buffer.alloc(0)
          entry.stream = tunnel
          writeLog(`COMPRESS ${result.compress} client=${remoteHex}`)
        }

        forwardToTarget(tunnel, entry, remoteHex, slot, leftover, result.target)
      })
      .catch((err) => {
        writeLog(`AUTH ERROR client=${remoteHex}: ${err.message}`)
        activeConnections.delete(entry)
        if (!stream.destroyed) stream.destroy()
      })
  }

  async function handleAuthFailure(stream, remoteHex, mode, pinGenerationAtStart) {
    if (closed) return { ok: false }

    let failure = null

    try {
      failure = await authGuard.recordFailure(remoteHex)
    } catch (err) {
      writeLog(`could not persist auth failure for client=${remoteHex}: ${err.message}`)
    }

    if (failure && failure.refreshPin) {
      await refreshSessionPin(`failures-${failure.failures}`, pinGenerationAtStart)
    }

    if (failure && failure.newlySuspended) {
      notifyAuthGuardEvent(remoteHex, failure)
    }

    await authGuard.delayFailure()

    let error = 'AUTH_FAILED'
    if (failure && failure.locked) {
      error = 'LOCKED_OUT'
    } else if (mode === 'pin') {
      error = 'PIN_ROTATED_OR_INVALID'
    }

    const response = { v: AUTH_VERSION, ok: false, error }
    if (failure && failure.locked && failure.retryAfterMs !== null) {
      response.retryAfterMs = failure.retryAfterMs
    }

    writeAuthMessage(stream, response)
    endAuthStream(stream)

    writeLog(
      `AUTH FAILED client=${remoteHex} mode=${mode} attempts=${failure ? failure.failures : 0}` +
      `${failure && failure.locked ? ` status=${failure.permanent ? 'permanent' : failure.notification}` : ''}`
    )
    void audit.record('auth.failure', {
      source: 'server',
      key: remoteHex,
      mode,
      attempts: failure ? failure.failures : 0,
      locked: Boolean(failure && failure.locked),
      permanent: Boolean(failure && failure.permanent)
    })

    return { ok: false }
  }

  async function authenticateStream(stream, remoteHex) {
    const decision = await decideDevice(remoteHex)

    if (decision.action === 'decline') {
      blockedCount++
      void audit.record('auth.declined', {
        source: 'server',
        key: remoteHex,
        reason: decision.reason
      })

      if (decision.reason === 'unlisted') {
        writeLog(`DECLINED unlisted client=${remoteHex}`)
        sendIntrusionAlert(remoteHex)
      } else {
        writeLog(`DECLINED client=${remoteHex} reason=${decision.reason}`)
      }

      return sendDeclined(stream, decision.reason, decision)
    }

    if (decision.action === 'fastpath') {
      const peekEnabled = muxPeekMs > 0
      const advertiseMux = muxAllowed && peekEnabled
      const advertiseTarget = peekEnabled
      const compressCapability = compressEnabled
        ? { version: COMPRESS_VERSION, algorithms: compressAlgorithms }
        : null
      const advertiseCompress = peekEnabled && compressCapability !== null
      const capability = {
        version: MUX_VERSION,
        maxChannels: DEFAULT_MAX_CHANNELS
      }

      writeAuthMessage(stream, {
        v: AUTH_VERSION,
        status: AUTH_STATUS.FASTPATH_READY,
        ...(advertiseMux ? { mux: capability } : {}),
        ...(advertiseTarget ? { target: true } : {}),
        ...(advertiseCompress ? { compress: compressCapability } : {})
      })
      writeLog(`FASTPATH client=${remoteHex}`)

      if (!advertiseMux && !advertiseTarget && !advertiseCompress) {
        void audit.record('auth.fastpath', {
          source: 'server',
          key: remoteHex
        })
        return { ok: true, leftover: Buffer.alloc(0) }
      }

      // Bounded peek: an upgrading client asks for mux or a target immediately;
      // anything else (including old clients that start sending payload at once)
      // is forwarded untouched.
      const peek = await peekControlLine(stream, {
        timeoutMs: muxPeekMs,
        maxBytes: MAX_MUX_UPGRADE_BYTES
      })
      const request = parseFastpathRequest(peek.line)
      const upgraded = Boolean(request && request.kind === 'mux' && advertiseMux)
      const requestedCompress = advertiseCompress &&
        request &&
        request.compress &&
        !upgraded
        ? pickAlgorithm(request.compress.algorithms, compressAlgorithms)
        : null

      void audit.record('auth.fastpath', {
        source: 'server',
        key: remoteHex,
        mux: upgraded,
        ...(request && request.kind === 'target' ? { target: request.target } : {})
      })

      if (request && request.kind === 'target' && advertiseTarget) {
        // Fast path used to ignore --target and fall back to defaultTarget.
        // The client now states the name during the peek; the server still owns
        // the mapping, so this adds no authority.
        let target
        try {
          target = resolveTarget(request.target, remoteHex)
        } catch (err) {
          writeAuthMessage(stream, {
            v: AUTH_VERSION,
            error: err.code || 'TARGET_UNKNOWN',
            message: err.message
          })
          writeLog(
            `FASTPATH target rejected client=${remoteHex} target=${request.target} ` +
            `code=${err.code || 'TARGET_UNKNOWN'}`
          )
          if (!stream.destroyed) stream.destroy()
          return { ok: false }
        }

        writeAuthMessage(stream, {
          v: AUTH_VERSION,
          target: { name: target.name, host: target.host, port: target.port },
          ...(requestedCompress
            ? { compress: { version: COMPRESS_VERSION, algorithm: requestedCompress } }
            : {})
        })
        writeLog(
          `FASTPATH target=${target.name} client=${remoteHex} -> ${target.host}:${target.port}` +
            `${requestedCompress ? ` compress=${requestedCompress}` : ''}`
        )

        return { ok: true, target, leftover: peek.leftover, compress: requestedCompress }
      }

      if (request && request.kind === 'compress') {
        writeAuthMessage(stream, {
          v: AUTH_VERSION,
          ...(requestedCompress
            ? { compress: { version: COMPRESS_VERSION, algorithm: requestedCompress } }
            : {})
        })
        writeLog(`FASTPATH compress=${requestedCompress || 'none'} client=${remoteHex}`)
        return { ok: true, leftover: peek.leftover, compress: requestedCompress }
      }

      if (!upgraded) {
        writeLog(`FASTPATH mux=0 client=${remoteHex}`)
        // Forward everything we read, including the line and its newline: a
        // non-mux client's first bytes (e.g. an SSH banner) are payload.
        return { ok: true, leftover: peek.raw }
      }

      writeAuthMessage(stream, {
        v: AUTH_VERSION,
        mux: capability
      })
      writeLog(`FASTPATH mux=1 client=${remoteHex}`)

      return { ok: true, mux: true, leftover: peek.leftover }
    }

    writeAuthMessage(stream, {
      v: AUTH_VERSION,
      status: AUTH_STATUS.CHALLENGE_REQUIRED
    })

    return authenticateChallenge(stream, remoteHex)
  }

  async function authenticateChallenge(stream, remoteHex) {
    let readyRead

    try {
      readyRead = await readControlLine(stream, {
        timeoutMs: preAuthTimeoutMs,
        maxBytes: MAX_CONTROL_BYTES
      })
    } catch {
      if (!closed) writeLog(`AUTH TIMEOUT client=${remoteHex} stage=ready`)
      return { ok: false }
    }

    let ready = null
    try {
      ready = decodeControl(readyRead.line)
    } catch {
      ready = null
    }

    if (
      !ready ||
      ready.v !== AUTH_VERSION ||
      ready.status !== AUTH_STATUS.READY
    ) {
      writeLog(`AUTH REJECTED client=${remoteHex} reason=bad-ready`)
      void audit.record('auth.declined', {
        source: 'server',
        key: remoteHex,
        reason: 'bad_ready'
      })
      return sendDeclined(stream, 'bad_ready')
    }

    if (closed) return { ok: false }

    const decision = await decideDevice(remoteHex)

    if (decision.action === 'decline') {
      blockedCount++
      void audit.record('auth.declined', {
        source: 'server',
        key: remoteHex,
        reason: decision.reason
      })

      if (decision.reason === 'unlisted') {
        writeLog(`DECLINED unlisted client=${remoteHex} (post-ready)`)
        sendIntrusionAlert(remoteHex)
      } else {
        writeLog(`DECLINED client=${remoteHex} reason=${decision.reason} (post-ready)`)
      }

      return sendDeclined(stream, decision.reason, decision)
    }

    const gate = await authGuard.acquire(remoteHex)

    if (!gate.ok) {
      if (gate.busy) {
        writeLog(`AUTH REJECTED client=${remoteHex} reason=busy`)
        void audit.record('auth.declined', {
          source: 'server',
          key: remoteHex,
          reason: 'busy'
        })
        return sendDeclined(stream, 'busy')
      }

      writeLog(`AUTH REJECTED client=${remoteHex} reason=locked`)
      void audit.record('auth.declined', {
        source: 'server',
        key: remoteHex,
        reason: 'locked'
      })
      return sendDeclined(stream, 'locked', {
        retryAfterMs: gate.retryAfterMs,
        permanent: gate.permanent
      })
    }

    try {
      const pinSnapshot = activePin

      if (!pinSnapshot) {
        writeLog(`internal error: session PIN is not initialized (client=${remoteHex})`)
        writeAuthMessage(stream, { v: AUTH_VERSION, ok: false, error: 'AUTH_FAILED' })
        endAuthStream(stream)
        return { ok: false }
      }

      const pinGenerationAtStart = authGuard.pinGeneration
      const serverNonce = crypto.randomBytes(32)
      const serverNonceHex = serverNonce.toString('hex')

      if (!writeAuthMessage(stream, {
        v: AUTH_VERSION,
        nonce: serverNonceHex,
        pinSalt: pinSnapshot.saltHex,
        pwdSalt: unattendedVerifier ? unattendedVerifier.saltHex : null
      })) {
        return { ok: false }
      }

      let read
      try {
        read = await readControlLine(stream, {
          // The challenge is sent before this read, so a human typing the
          // password is inside this window. Allow the pre-auth budget rather
          // than the strict auth timeout; the strict timeout still guards the
          // READY step above.
          timeoutMs: Math.max(authTimeoutMs, preAuthTimeoutMs),
          maxBytes: MAX_CONTROL_BYTES
        })
      } catch {
        if (closed) return { ok: false }
        writeLog(`AUTH TIMEOUT client=${remoteHex} stage=proof`)
        endAuthStream(stream)
        return { ok: false }
      }

      let response = null
      try {
        response = decodeControl(read.line)
      } catch {
        response = null
      }

      let mode = response && (response.mode === 'pin' || response.mode === 'pwd')
        ? response.mode
        : 'unknown'

      const clientNonceHex = response && typeof response.clientNonce === 'string'
        ? response.clientNonce.toLowerCase()
        : ''
      const proofHex = response && typeof response.proof === 'string'
        ? response.proof.toLowerCase()
        : ''

      if (
        !response ||
        response.v !== AUTH_VERSION ||
        !/^[0-9a-f]{64}$/.test(clientNonceHex) ||
        !/^[0-9a-f]{64}$/.test(proofHex)
      ) {
        return handleAuthFailure(stream, remoteHex, mode, pinGenerationAtStart)
      }

      let verifier = null

      if (mode === 'pin') {
        verifier = {
          storedKey: pinSnapshot.storedKey,
          serverKey: pinSnapshot.serverKey
        }
      } else if (mode === 'pwd' && unattendedVerifier) {
        verifier = {
          storedKey: unattendedVerifier.storedKey,
          serverKey: unattendedVerifier.serverKey
        }
      }

      if (!verifier) {
        return handleAuthFailure(stream, remoteHex, mode, pinGenerationAtStart)
      }

      const authMessage = buildAuthMessage(serverNonceHex, clientNonceHex, remoteHex)

      if (!verifyScramProof(Buffer.from(proofHex, 'hex'), verifier.storedKey, authMessage)) {
        return handleAuthFailure(stream, remoteHex, mode, pinGenerationAtStart)
      }

      let selectedTarget
      const muxRequested = Boolean(
        response &&
        response.mux &&
        Number(response.mux.version) === MUX_VERSION
      )

      try {
        if (muxRequested) {
          selectedTarget = null
        } else if (response && response.udp !== undefined) {
          selectedTarget = resolveUdpTarget(response.udp)
        } else if (response && response.socks !== undefined) {
          selectedTarget = await resolveSocksTarget(response.socks, remoteHex)
        } else {
          selectedTarget = resolveTarget(response && response.target, remoteHex)
        }
      } catch (err) {
        writeLog(`AUTH REJECTED client=${remoteHex} reason=${err.code}`)
        void audit.record('auth.declined', {
          source: 'server',
          key: remoteHex,
          reason: err.code
        })
        writeAuthMessage(stream, {
          v: AUTH_VERSION,
          ok: false,
          error: err.code
        })
        endAuthStream(stream)
        return { ok: false }
      }

      const compressAlgorithm = !muxRequested &&
        compressEnabled &&
        response &&
        response.compress &&
        Number(response.compress.version) === COMPRESS_VERSION
        ? pickAlgorithm(response.compress.algorithms, compressAlgorithms)
        : null

      try {
        await authGuard.recordSuccess(remoteHex)
      } catch (err) {
        writeLog(`could not clear auth failures for client=${remoteHex}: ${err.message}`)
      }

      const serverSig = computeServerSignature(verifier.serverKey, authMessage).toString('hex')

      const successMessage = {
        v: AUTH_VERSION,
        ok: true,
        serverSig
      }

      if (muxRequested) {
        successMessage.mux = {
          version: MUX_VERSION,
          maxChannels: DEFAULT_MAX_CHANNELS
        }
      } else if (selectedTarget) {
        successMessage.target = {
          name: selectedTarget.name,
          host: selectedTarget.host,
          port: selectedTarget.port
        }
      }

      if (compressAlgorithm) {
        successMessage.compress = {
          version: COMPRESS_VERSION,
          algorithm: compressAlgorithm
        }
      }

      writeAuthMessage(stream, successMessage)
      writeLog(
        `AUTH OK client=${remoteHex} method=${mode} target=${muxRequested ? 'mux' : selectedTarget.name}`
      )
      void audit.record('auth.success', {
        source: 'server',
        key: remoteHex,
        mode,
        target: muxRequested ? 'mux' : selectedTarget.name
      })

      return {
        ok: true,
        leftover: Buffer.concat([readyRead.leftover, read.leftover]),
        target: selectedTarget,
        mux: muxRequested,
        compress: compressAlgorithm
      }
    } finally {
      gate.release()
    }
  }

  function startMuxSession(stream, entry, remoteHex, leftover) {
    if (muxSessions.size >= MAX_CARRIERS) {
      writeLog(
        `MUX REJECT client=${remoteHex} carriers=${muxSessions.size} limit=${MAX_CARRIERS}`
      )
      activeConnections.delete(entry)
      if (!stream.destroyed) stream.destroy()
      return
    }

    const channels = new Map()
    const record = openTrafficRecord(remoteHex, 'mux', 'mux')
    record.channels = 0
    const session = { channels, record }
    muxSessions.add(session)
    let finished = false
    let idleTimer = null

    const parser = new FrameParser((frame) => {
      onFrame(frame).catch((err) => {
        writeLog(`MUX frame error client=${remoteHex}: ${err.message}`)
        finish()
      })
    }, (err) => {
      writeLog(`MUX framing error client=${remoteHex}: ${err.message}`)
      finish()
    })

    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (channels.size === 0) finish()
        else touchIdle()
      }, MUX_IDLE_MS)
      idleTimer.unref()
    }

    const finish = () => {
      if (finished) return
      finished = true

      if (idleTimer) clearTimeout(idleTimer)
      closeTrafficRecord(record)

      for (const channel of channels.values()) {
        if (channel.abortTimer) clearTimeout(channel.abortTimer)
        try {
          channel.socket.destroy()
        } catch {
          // Ignore.
        }
      }

      const closedChannels = channels.size
      channels.clear()
      record.channels = 0
      muxSessions.delete(session)
      activeConnections.delete(entry)

      if (!stream.destroyed) stream.destroy()
      writeLog(
        `MUX SESSION closed client=${remoteHex} channels=${closedChannels} ` +
        `in=${record.in} out=${record.out}`
      )
    }

    const send = (type, flags, channelId, payload) => {
      if (finished) return

      try {
        stream.write(encodeMuxFrame(type, flags, channelId, payload || Buffer.alloc(0)))
      } catch {
        finish()
      }
    }

    function maybeFinishChannel(channel) {
      if (!channel.targetEnded || channel.finished) return
      if (channel.sentFin) return
      if (channel.queue.length > 0) return

      channel.sentFin = true
      send(MUX_TYPE.CLOSE, 0, channel.id)

      if (channel.remoteEnded) cleanup(channel.id)
    }

    function queueOut(channel, chunk) {
      channel.queue.push(chunk)
      channel.queuedBytes += chunk.length
      flushOut(channel)

      if (channel.queuedBytes > MAX_CHANNEL_QUEUE) {
        send(MUX_TYPE.RESET, MUX_FLAG.RESET, channel.id)
        cleanup(channel.id)
        return
      }

      if (channel.queuedBytes >= MAX_QUEUED && !channel.paused) {
        channel.paused = true
        try {
          channel.socket.pause()
        } catch {
          // Ignore.
        }
      }
    }

    function flushOut(channel) {
      while (channel.creditOut > 0 && channel.queue.length > 0) {
        const buffer = channel.queue[0]
        const size = Math.min(channel.creditOut, buffer.length, MAX_FRAME)

        send(MUX_TYPE.DATA, 0, channel.id, buffer.subarray(0, size))
        channel.creditOut -= size
        channel.queuedBytes -= size

        if (size === buffer.length) channel.queue.shift()
        else channel.queue[0] = buffer.subarray(size)
      }

      if (channel.queue.length === 0 && channel.paused) {
        channel.paused = false
        try {
          if (!channel.socket.destroyed) channel.socket.resume()
        } catch {
          // Ignore.
        }
      }

      maybeFinishChannel(channel)
    }

    function cleanup(channelId) {
      const channel = channels.get(channelId)
      if (!channel) return

      channel.finished = true
      if (channel.abortTimer) {
        clearTimeout(channel.abortTimer)
        channel.abortTimer = null
      }
      channels.delete(channelId)
      record.channels = channels.size

      try { if (channel.compressor) channel.compressor.destroy() } catch { /* Ignore. */ }
      try { if (channel.decompressor) channel.decompressor.destroy() } catch { /* Ignore. */ }

      try {
        channel.socket.destroy()
      } catch {
        // Ignore.
      }
      touchIdle()
    }

    async function openChannel(channelId, request) {
      if (channels.size >= DEFAULT_MAX_CHANNELS) {
        send(MUX_TYPE.OPEN_ERR, 0, channelId, encodeJson({
          error: 'MUX_BUSY',
          message: 'too many channels'
        }))
        return
      }

      if (countMuxChannels() >= MAX_TOTAL_CHANNELS) {
        send(MUX_TYPE.OPEN_ERR, 0, channelId, encodeJson({
          error: 'MUX_BUSY',
          message: 'server channel limit reached'
        }))
        return
      }

      let target

      try {
        if (request && request.socks) {
          target = await resolveSocksTarget(request.socks, remoteHex)
        } else {
          target = resolveTarget(request && request.target, remoteHex)
        }
      } catch (err) {
        send(MUX_TYPE.OPEN_ERR, 0, channelId, encodeJson({
          error: err.code || 'OPEN_FAILED',
          message: err.message
        }))
        return
      }

      const algorithm = compressEnabled && request && request.compress
        ? pickAlgorithm(request.compress.algorithms, compressAlgorithms)
        : null

      const socket = net.createConnection({ host: target.host, port: target.port })
      const channel = {
        id: channelId,
        socket,
        target,
        algorithm,
        compressor: null,
        decompressor: null,
        creditOut: CHANNEL_WINDOW,
        queue: [],
        queuedBytes: 0,
        paused: false,
        sentFin: false,
        targetEnded: false,
        remoteEnded: false,
        receivedBytes: 0,
        abortTimer: null
      }

      if (algorithm) {
        channel.compressor = createCompressor(algorithm)
        channel.decompressor = createDecompressor(algorithm)
        channel.decompressorGuard = guardDecompressor(
          channel.decompressor,
          compressConfig,
          (code) => {
            writeLog(`MUX compression guard client=${remoteHex} channel=${channelId} ${code}`)
            send(MUX_TYPE.RESET, MUX_FLAG.RESET, channelId)
            cleanup(channelId)
          }
        )

        channel.compressor.on('data', (chunk) => {
          if (channel.finished) return
          addOutbound(record, chunk.length)
          queueOut(channel, chunk)
        })

        channel.compressor.on('drain', () => {
          if (channel.finished || socket.destroyed) return
          socket.resume()
        })

        channel.compressor.on('error', () => {
          send(MUX_TYPE.RESET, MUX_FLAG.RESET, channelId)
          cleanup(channelId)
        })

        channel.compressor.on('end', () => {
          if (channel.finished) return
          channel.targetEnded = true
          maybeFinishChannel(channel)
        })

        channel.decompressor.on('data', (chunk) => {
          if (channel.finished || channel.socket.destroyed) return
          channel.socket.write(chunk)
        })

        channel.decompressor.on('error', () => {
          if (channel.finished) return

          if (channel.remoteEnded) {
            try { channel.socket.end() } catch { /* Ignore. */ }
            return
          }

          send(MUX_TYPE.RESET, MUX_FLAG.RESET, channelId)
          cleanup(channelId)
        })

        channel.decompressor.on('end', () => {
          if (channel.finished) return
          try { channel.socket.end() } catch { /* Ignore. */ }
        })
      }

      channels.set(channelId, channel)
      record.channels = channels.size
      socket.setKeepAlive(true, 30_000)
      socket.setNoDelay(true)

      socket.once('connect', () => {
        const meta = {
          target: target.name,
          host: target.host,
          port: target.port
        }
        if (algorithm) meta.compress = { algorithm }
        send(MUX_TYPE.OPEN_OK, 0, channelId, encodeJson(meta))
      })

      socket.on('data', (chunk) => {
        if (channel.compressor) {
          if (!writeAndFlush(channel.compressor, chunk)) socket.pause()
          return
        }

        addOutbound(record, chunk.length)
        queueOut(channel, chunk)
      })

      socket.on('error', () => {
        send(MUX_TYPE.RESET, MUX_FLAG.RESET, channelId)
        cleanup(channelId)
      })

      socket.on('close', () => {
        if (channel.compressor) {
          if (!channel.compressor.writableEnded) channel.compressor.end()
          return
        }

        channel.targetEnded = true
        maybeFinishChannel(channel)
      })

      writeLog(
        `MUX OPEN client=${remoteHex} channel=${channelId} target=${target.name} -> ${target.host}:${target.port}`
      )
      touchIdle()
    }

    async function onFrame(frame) {
      if (finished) return

      switch (frame.type) {
        case MUX_TYPE.OPEN: {
          const request = decodeJson(frame.payload)

          if (!request || typeof request !== 'object' || Array.isArray(request)) {
            send(MUX_TYPE.OPEN_ERR, 0, frame.channelId, encodeJson({
              error: 'MUX_BAD_REQUEST',
              message: 'open payload must be JSON'
            }))
            return
          }

          await openChannel(frame.channelId, request)
          return
        }

        case MUX_TYPE.DATA: {
          const channel = channels.get(frame.channelId)
          if (!channel) return

          addInbound(record, frame.payload.length)
          send(MUX_TYPE.WINDOW, 0, channel.id, encodeUInt32(frame.payload.length))

          try {
            if (channel.decompressor) {
              channel.receivedBytes += frame.payload.length
              if (channel.decompressorGuard) channel.decompressorGuard.countInput(frame.payload.length)
              channel.decompressor.write(frame.payload)
            } else {
              channel.socket.write(frame.payload)
            }
          } catch {
            send(MUX_TYPE.RESET, MUX_FLAG.RESET, channel.id)
            cleanup(channel.id)
          }
          return
        }

        case MUX_TYPE.WINDOW: {
          const channel = channels.get(frame.channelId)
          if (!channel) return

          channel.creditOut = Math.min(
            channel.creditOut + decodeUInt32(frame.payload),
            CHANNEL_WINDOW
          )
          flushOut(channel)
          return
        }

        case MUX_TYPE.CLOSE: {
          const channel = channels.get(frame.channelId)
          if (!channel) return


          // Half-close: the peer finished sending, but the target may still be
          // writing its reply, so keep the channel alive until it drains.
          channel.remoteEnded = true
          try {
            if (channel.decompressor) {
              if (channel.receivedBytes > 0) channel.decompressor.end()
              else channel.socket.end()
            } else {
              channel.socket.end()
            }
          } catch {
            cleanup(frame.channelId)
            return
          }
          channel.abortTimer = setTimeout(() => {
            channel.abortTimer = null
            if (!channel.finished) cleanup(channel.id)
          }, 60_000)
          if (typeof channel.abortTimer.unref === 'function') {
            channel.abortTimer.unref()
          }
          maybeFinishChannel(channel)
          return
        }

        case MUX_TYPE.RESET:
          cleanup(frame.channelId)
          return

        case MUX_TYPE.PING:
          send(MUX_TYPE.PONG, 0, 0, frame.payload)
          return

        default:
          return
      }
    }

    stream.on('data', (chunk) => parser.push(chunk))
    stream.on('error', finish)
    stream.on('close', finish)

    if (leftover && leftover.length > 0) parser.push(leftover)

    touchIdle()
    writeLog(`MUX SESSION client=${remoteHex} maxChannels=${DEFAULT_MAX_CHANNELS}`)
  }

  function startUdpSession(stream, entry, remoteHex, target, leftover) {
    const socket = dgram.createSocket('udp4')
    const record = openTrafficRecord(remoteHex, target.name, 'udp')
    let finished = false
    let idleTimer = null
    let datagrams = 0

    const finish = () => {
      if (finished) return
      finished = true

      closeTrafficRecord(record)
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }

      try {
        socket.close()
      } catch {
        // Ignore.
      }

      activeConnections.delete(entry)
      if (!stream.destroyed) stream.destroy()
      writeLog(
        `UDP SESSION closed client=${remoteHex} target=${target.name} datagrams=${datagrams}`
      )
    }

    const touch = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, udpIdleTimeoutMs)
    }

    socket.on('error', (err) => {
      writeLog(`UDP target error client=${remoteHex} target=${target.name}: ${err.message}`)
      finish()
    })

    socket.on('message', (message) => {
      if (finished) return
      if (message.length > MAX_DATAGRAM) {
        writeLog(`UDP reply too large client=${remoteHex} bytes=${message.length}`)
        return
      }

      try {
        stream.write(encodeFrame(message))
        addOutbound(record, message.length)
      } catch {
        finish()
      }
    })

    const decoder = createDecoder((payload) => {
      if (finished) return
      datagrams += 1
      addInbound(record, payload.length)
      touch()

      try {
        socket.send(payload, target.port, target.host)
      } catch {
        finish()
      }
    }, (err) => {
      writeLog(`UDP framing error client=${remoteHex}: ${err.message}`)
      finish()
    })

    stream.on('data', (chunk) => decoder(chunk))
    stream.on('error', finish)
    stream.on('close', finish)

    if (leftover && leftover.length > 0) decoder(leftover)

    touch()
    writeLog(
      `UDP SESSION client=${remoteHex} target=${target.name} -> ${target.host}:${target.port}`
    )
  }

  function forwardToTarget(stream, entry, remoteHex, slot, leftover, target) {
    const forwardTarget = target || targetDefs.get(defaultTargetName)
    const socket = net.createConnection({
      host: forwardTarget.host,
      port: forwardTarget.port
    })
    entry.socket = socket
    socket.setKeepAlive(true, 30_000)
    socket.setNoDelay(true)

    const record = openTrafficRecord(remoteHex, forwardTarget.name, 'tcp')
    stream.on('data', (chunk) => addInbound(record, chunk.length))
    socket.on('data', (chunk) => addOutbound(record, chunk.length))

    let finished = false
    let streamClosed = false
    let socketClosed = false
    let connectTimer = null

    const release = () => {
      closeTrafficRecord(record)
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }

      activeConnections.delete(entry)
    }

    const maybeRelease = () => {
      if (finished) return
      if (!streamClosed || !socketClosed) return
      finished = true
      release()
    }

    const abort = () => {
      if (finished) return
      finished = true
      release()

      if (!stream.destroyed) stream.destroy()
      if (!socket.destroyed) socket.destroy()
    }

    connectTimer = setTimeout(() => {
      writeLog(`local target connect timed out for client=${remoteHex} (slot=${slot})`)
      abort()
    }, localConnectTimeoutMs)

    socket.once('connect', () => {
      if (finished) return

      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }

      socket.setKeepAlive(true, 30_000)
      writeLog(
        `FORWARD client=${remoteHex} slot=${slot} target=${forwardTarget.name} -> 127.0.0.1:${forwardTarget.port}`
      )

      if (leftover && leftover.length > 0) {
        try {
          socket.write(leftover)
        } catch {
          abort()
          return
        }
      }

      stream.pipe(socket)
      socket.pipe(stream)
    })

    stream.on('error', (err) => {
      if (!finished) writeLog(`p2p stream error for client=${remoteHex}: ${err.message}`)
      abort()
    })

    socket.on('error', (err) => {
      if (!finished) writeLog(`local socket error for client=${remoteHex}: ${err.message}`)
      abort()
    })

    stream.on('end', () => {
      if (!socket.destroyed) socket.end()
    })

    socket.on('end', () => {
      if (!stream.destroyed) stream.end()
    })

    stream.on('close', () => {
      streamClosed = true
      if (!socket.destroyed) socket.end()
      maybeRelease()
    })

    socket.on('close', () => {
      socketClosed = true
      if (!stream.destroyed) stream.end()
      maybeRelease()
    })
  }

  async function startSlotListener(slot) {
    if (closed) throw new Error('server is shutting down')
    if (listeners.has(slot)) return listeners.get(slot)

    const keyPair = deriveSlotKeyPair(config.masterSecret, slot)
    const publicKeyHex = Buffer.from(keyPair.publicKey).toString('hex')

    const hyperServer = dht.createServer(
      { firewall },
      (stream) => handleIncomingStream(stream, slot)
    )

    hyperServer.on('error', (err) => {
      writeLog(`listener error slot=${slot}: ${err.message}`)
    })

    await hyperServer.listen(keyPair)

    if (closed) {
      try {
        await hyperServer.close()
      } catch {
        // Ignore shutdown races.
      }
      throw new Error('server is shutting down')
    }

    const entry = { slot, server: hyperServer, publicKeyHex }
    listeners.set(slot, entry)
    writeLog(`LISTENING slot=${slot} serverPublicKey=${publicKeyHex}`)

    return entry
  }

  async function stopSlotListener(slot, entry) {
    try {
      await entry.server.close()
      writeLog(`STOPPED accepting new connections for expired slot=${slot} (active sessions kept)`)
    } catch (err) {
      writeLog(`failed to close listener slot=${slot}: ${err.message}`)
    }
  }

  async function rotateSlots() {
    if (closed) return

    const slot = getSlot(nowMs())
    if (slot === currentSlot) return

    writeLog(`hour slot changed ${currentSlot} -> ${slot}`)
    currentSlot = slot

    for (const candidate of [slot, slot - 1]) {
      if (closed) break
      try {
        await startSlotListener(candidate)
      } catch (err) {
        writeLog(`failed to start listener for slot=${candidate}: ${err.message}`)
      }
    }

    for (const [listenerSlot, entry] of [...listeners.entries()]) {
      if (listenerSlot < currentSlot - 1) {
        listeners.delete(listenerSlot)
        stopSlotListener(listenerSlot, entry).catch(noop)
      }
    }
  }

  async function gracefulShutdown(reason, graceMs = 60_000) {
    if (shutdownStarted || closed) return
    shutdownStarted = true
    writeLog(`SHUTDOWN reason=${reason} active=${activeConnections.size}`)

    const deadline = Date.now() + graceMs

    while (activeConnections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    await close().catch(noop)
  }

  function scheduleLifecycle() {
    if (ttlMs !== null) {
      setTimeout(() => {
        gracefulShutdown('ttl').catch(noop)
      }, ttlMs).unref()
    }

    if (idleMs !== null || onceMode) {
      lifecycleTimer = setInterval(() => {
        if (closed || shutdownStarted) return

        if (activeConnections.size > 0) {
          hadConnection = true
          idleSince = Date.now()
          return
        }

        if (onceMode && hadConnection) {
          gracefulShutdown('once').catch(noop)
          return
        }

        if (idleMs !== null && Date.now() - idleSince >= idleMs) {
          gracefulShutdown('idle').catch(noop)
        }
      }, 500)

      lifecycleTimer.unref()
    }
  }

  async function close() {
    if (closed) return
    closed = true

    if (rotationTimer !== null) {
      clearInterval(rotationTimer)
      rotationTimer = null
    }

    if (lifecycleTimer !== null) {
      clearInterval(lifecycleTimer)
      lifecycleTimer = null
    }

    for (const entry of listeners.values()) {
      try {
        await entry.server.close()
      } catch {
        // Best effort during shutdown.
      }
    }
    listeners.clear()

    if (control !== null) {
      const activeControl = control
      control = null
      try {
        await activeControl.close()
      } catch {
        // Best effort during shutdown.
      }
    }

    if (controlTokenPath !== null) {
      await removeControlToken(controlTokenPath)
      controlTokenPath = null
    }

    for (const entry of activeConnections) {
      try {
        if (entry.stream) entry.stream.destroy()
      } catch {
        // Ignore.
      }
      try {
        if (entry.socket) entry.socket.destroy()
      } catch {
        // Ignore.
      }
    }
    activeConnections.clear()

    try {
      await dht.destroy()
    } catch {
      // Ignore.
    }

    try {
      await authGuard.close()
    } catch {
      // Ignore.
    }

    void audit.record('server.stop', { source: 'server' })
    await audit.close()

    writeLog('server stopped')
  }

  try {
    await startSlotListener(currentSlot)
  } catch (err) {
    await close()
    throw err
  }

  try {
    await startSlotListener(currentSlot - 1)
  } catch (err) {
    writeLog(`warning: could not listen on previous slot ${currentSlot - 1}: ${err.message}`)
  }

  rotationTimer = setInterval(() => {
    rotateSlots().catch((err) => {
      writeLog(`rotation error: ${err.message}`)
    })
  }, rotationCheckMs)

  const controlSocketPath = options.controlSocketPath || defaultControlSocketPath()

  async function controlHandler(request) {
    if (!request || typeof request !== 'object') {
      return { ok: false, error: 'INVALID_REQUEST', message: 'invalid control request' }
    }

    if (request.cmd === 'status') {
      const activeKeys = new Set()
      for (const entry of activeConnections) {
        if (entry.remoteKey) activeKeys.add(entry.remoteKey)
      }

      return {
        ok: true,
        mode: 'server',
        verificationMode,
        authMode,
        targetPort: effectiveTargetPort,
        targets: [...targetDefs.keys()].sort((a, b) => a.localeCompare(b)),
        defaultTarget: defaultTargetName,
        currentSlot,
        listeningSlots: [...listeners.keys()].sort((a, b) => a - b),
        sessionGeneration: authGuard.pinGeneration,
        sessionPinAvailable: Boolean(activePin),
        interactive,
        registrySize: registry.size,
        blockedCount,
        activeConnections: activeConnections.size,
        activeKeys: [...activeKeys],
        uptimeMs: Date.now() - startedAt,
        traffic: {
          totalIn: traffic.totalIn,
          totalOut: traffic.totalOut,
          mux: {
            carriers: muxSessions.size,
            channels: countMuxChannels()
          },
          active: [...traffic.streams.values()].map((record) => ({
            id: record.id,
            peer: record.peer,
            target: record.target,
            kind: record.kind,
            startedAt: new Date(record.startedAt).toISOString(),
            in: record.in,
            out: record.out,
            ...(record.kind === 'mux' ? { channels: record.channels || 0 } : {})
          }))
        },
        trustedDevicesFile: registry.filePath,
        controlSocketPath
      }
    }

    if (request.cmd === 'pin') {
      if (!sessionAuthEnabled || !activePin) {
        return {
          ok: false,
          error: 'NO_SESSION_PIN',
          message: 'key-only mode does not use a Session PIN'
        }
      }

      return {
        ok: true,
        pin: activePin.pin,
        formatted: formatSessionPin(activePin.pin),
        generation: activePin.generation
      }
    }

    if (request.cmd === 'revoke') {
      if (!isHex64(request.key)) {
        return {
          ok: false,
          error: 'INVALID_KEY',
          message: 'key must be 64 hexadecimal characters'
        }
      }

      const key = request.key.toLowerCase()
      const status = await authGuard.revoke(key, 'manual')
      let closed = 0

      for (const entry of [...activeConnections]) {
        if (entry.remoteKey !== key) continue
        closed += 1
        try {
          if (entry.stream) entry.stream.destroy()
        } catch {
          // Ignore.
        }
        try {
          if (entry.socket) entry.socket.destroy()
        } catch {
          // Ignore.
        }
      }

      writeLog(`CONTROL revoke client=${key} closed=${closed}`)
      void audit.record('control.revoke', {
        source: 'server',
        key,
        closed
      })
      return { ok: true, key, closed, status }
    }

    return {
      ok: false,
      error: 'UNKNOWN_COMMAND',
      message: 'unknown control command'
    }
  }

  if (options.controlSocket !== false) {
    try {
      const tokenInfo = await createControlToken(
        options.controlTokenPath || defaultControlTokenPath()
      )
      controlTokenPath = tokenInfo.path
      control = await startControlServer({
        socketPath: controlSocketPath,
        token: tokenInfo.token,
        handler: controlHandler,
        log: writeLog
      })
    } catch (err) {
      await removeControlToken(controlTokenPath)
      controlTokenPath = null
      await close()
      throw err
    }
  }

  if (telegram && options.sendStartupAlert !== false) {
    const text = [
      '✅ p2pgate server เริ่มทำงานแล้ว',
      `เวลา: ${nowIso()}`,
      `พอร์ตปลายทาง: 127.0.0.1:${effectiveTargetPort}`,
      `โหมดยืนยันตัวตน: ${verificationMode}`,
      `อุปกรณ์ที่ลงทะเบียน: ${registry.size}`
    ].join('\n')

    sendTelegramMessage(telegram, text).catch(noop)
  }

  void audit.record('server.start', {
    source: 'server',
    mode: verificationMode,
    authMode,
    registrySize: registry.size,
    targetPort,
    slots: [...listeners.keys()].sort((a, b) => a - b)
  })

  scheduleLifecycle()

  return {
    dht,
    get currentSlot() {
      return currentSlot
    },
    get blockedCount() {
      return blockedCount
    },
    get activeConnections() {
      return activeConnections.size
    },
    get listeningSlots() {
      return [...listeners.keys()].sort((a, b) => a - b)
    },
    get sessionPin() {
      return activePin ? activePin.pin : null
    },
    get pinGeneration() {
      return authGuard.pinGeneration
    },
    get verificationMode() {
      return verificationMode
    },
    get authMode() {
      return authMode
    },
    get authEnabled() {
      return sessionAuthEnabled
    },
    get registrySize() {
      return registry.size
    },
    get controlSocketPath() {
      return control ? control.socketPath : null
    },
    get controlEnabled() {
      return control !== null
    },
    get controlTokenPath() {
      return controlTokenPath
    },
    listDevices() {
      return registry.listDevices()
    },
    isAuthSuspended(keyHex) {
      return authGuard.isSuspended(keyHex)
    },
    getAuthState(keyHex) {
      return authGuard.getStatus(keyHex)
    },
    currentPublicKeyHex() {
      return deriveServerPublicKeyHex(config.masterSecret, currentSlot)
    },
    publicKeyHexForSlot(slot) {
      return deriveServerPublicKeyHex(config.masterSecret, slot)
    },
    close
  }
}

module.exports = {
  startServer,
  AlertRateLimiter
}
