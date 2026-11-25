'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const dgram = require('node:dgram')
const fs = require('node:fs/promises')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const HyperDHT = require('hyperdht')

const {
  getSlot,
  deriveSlotSeed,
  deriveSlotKeyPair,
  deriveServerPublicKey,
  deriveServerPublicKeyHex,
  formatSessionPin,
  deriveScramVerifier,
  serializeScramVerifier
} = require('./crypto-utils')
const {
  generateClientKey,
  loadClientKey,
  inspectClientKey,
  protectClientKey,
  unprotectClientKey
} = require('./keygen')
const { startServer, AlertRateLimiter } = require('./server')
const { startClient, resolveMuxEnabled } = require('./client')
const { AuthGuard } = require('./auth-guard')
const {
  DeviceRegistry,
  evaluateDevicePolicy,
  validateDeviceAddOptions
} = require('./device-registry')
const {
  CONTROL_VERSION,
  sendControlCommand,
  readControlToken
} = require('./control')
const { AuditLog } = require('./audit-log')
const { runDoctor } = require('./doctor')
const { readControlLine, decodeControl, peekControlLine, AUTH_STATUS } = require('./auth')
const { PassThrough } = require('node:stream')
const { normalizeConfig } = require('./config-loader')
const { rotateMasterSecret, fingerprint } = require('./master')
const { redactConfig } = require('./config-tools')
const { setHost, getHost, listHosts, deleteHost } = require('./hosts')
const { readAuditEvents } = require('./audit-view')
const {
  encodeFrame: encodeMuxFrame,
  FrameParser: MuxFrameParser,
  TYPE: MUX_TYPE,
  MuxCarrier,
  encodeJson: encodeMuxJson,
  encodeUInt32: encodeMuxUInt32,
  CHANNEL_WINDOW,
  MAX_FRAME,
  MAX_CARRIERS,
  MAX_TOTAL_CHANNELS
} = require('./mux')
const {
  normalizeCompressConfig,
  pickAlgorithm,
  sampleCompressible,
  guardDecompressor
} = require('./compress')

const noop = () => {}
const quiet = () => {}

function getFreeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')

    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}

async function waitFor(predicate, timeoutMs, description) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(`timed out waiting for ${description || 'condition'}`)
}

async function connectLocal(port, timeoutMs = 10_000) {
  const socket = net.createConnection({ host: '127.0.0.1', port })
  socket.on('error', noop)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('local connect timed out')), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  return socket
}

async function sendAndExpectNoEcho(port, payload, timeoutMs = 8_000) {
  const socket = await connectLocal(port, timeoutMs)

  let received = 0
  socket.on('data', (chunk) => {
    received += chunk.length
  })

  socket.write(payload)

  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })

  socket.destroy()
  return { closed, received }
}

const leftoverBySocket = new WeakMap()

function readExactly(socket, length, timeoutMs) {
  return new Promise((resolve, reject) => {
    const buffered = leftoverBySocket.get(socket)
    if (buffered && buffered.length >= length) {
      leftoverBySocket.set(socket, buffered.subarray(length))
      resolve(buffered.subarray(0, length))
      return
    }

    const chunks = buffered && buffered.length > 0 ? [buffered] : []
    let total = buffered ? buffered.length : 0
    leftoverBySocket.delete(socket)

    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    const onData = (chunk) => {
      chunks.push(chunk)
      total += chunk.length

      if (total >= length) {
        const all = Buffer.concat(chunks)
        leftoverBySocket.set(socket, all.subarray(length))
        cleanup()
        resolve(all.subarray(0, length))
      }
    }

    const onError = (err) => {
      cleanup()
      reject(err)
    }

    const onClose = () => {
      cleanup()
      reject(new Error(`local socket closed after ${total}/${length} bytes`))
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out reading ${length} bytes (got ${total})`))
    }, timeoutMs)

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

function wrongPin(currentPin) {
  return currentPin === '2222222222' ? '3333333333' : '2222222222'
}

async function main() {
  const checks = []
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'p2pgate-self-test-'))

  let bootstrapper = null
  let echoServer = null
  let gateway = null
  let probeDht = null
  let targetConnections = 0
  const clients = []
  const extraServers = []
  let originalSocket = null
  let originalClient = null

  try {
    // ---------------------------------------------------------------------
    // 1. Deterministic HKDF slot derivation
    // ---------------------------------------------------------------------
    const masterSecret = crypto.randomBytes(32).toString('hex')
    let serverNow = Date.now()
    let lockoutNow = Date.now()
    const slot = getSlot(serverNow)

    const seedA = deriveSlotSeed(masterSecret, slot)
    const seedB = deriveSlotSeed(masterSecret, slot)

    assert.ok(Buffer.isBuffer(seedA), 'derived seed must be a Buffer')
    assert.equal(seedA.length, 32, 'derived seed must be 32 bytes')
    assert.deepEqual(seedA, seedB, 'same secret + slot must derive the same seed')
    assert.notDeepEqual(
      deriveSlotSeed(masterSecret, slot + 1),
      seedA,
      'different slots must derive different seeds'
    )

    const derivedKeyPair = deriveSlotKeyPair(masterSecret, slot)
    assert.equal(
      Buffer.from(derivedKeyPair.publicKey).toString('hex'),
      deriveServerPublicKeyHex(masterSecret, slot),
      'keypair public key must match derived public key'
    )
    assert.equal(
      deriveServerPublicKey(masterSecret, slot).toString('hex'),
      deriveServerPublicKeyHex(masterSecret, slot)
    )

    checks.push('HKDF slot derivation is deterministic and slot-specific')

    // ---------------------------------------------------------------------
    // 2. Unauthorized-key alert rate limiting
    // ---------------------------------------------------------------------
    const limiter = new AlertRateLimiter(1000)
    assert.equal(limiter.shouldSend('key-a'), true)
    assert.equal(limiter.shouldSend('key-a'), false)
    assert.equal(limiter.shouldSend('key-b'), true)
    checks.push('intrusion alert rate limiting works')

    // ---------------------------------------------------------------------
    // 3. AuthGuard concurrency limits
    // ---------------------------------------------------------------------
    const unitGuard = new AuthGuard({
      statePath: path.join(tempDir, 'guard-unit.json'),
      now: () => 1000,
      failDelayMs: [1, 2]
    })
    await unitGuard.init()

    const key1 = '1'.repeat(64)
    const key2 = '2'.repeat(64)
    const key3 = '3'.repeat(64)
    const key4 = '4'.repeat(64)

    const acquire1 = await unitGuard.acquire(key1)
    assert.equal(acquire1.ok, true)
    const acquire1Again = await unitGuard.acquire(key1)
    assert.equal(acquire1Again.ok, false, 'only one verification per key')
    const acquire2 = await unitGuard.acquire(key2)
    const acquire3 = await unitGuard.acquire(key3)
    assert.equal(acquire2.ok, true)
    assert.equal(acquire3.ok, true)
    const acquire4 = await unitGuard.acquire(key4)
    assert.equal(acquire4.ok, false, 'only three verifications total')
    acquire1.release()
    acquire2.release()
    acquire3.release()
    await unitGuard.close()
    checks.push('AuthGuard limits one verification per key and three total')

    // ---------------------------------------------------------------------
    // 4. Device registry, dual-source precedence, expiration, and policies
    // ---------------------------------------------------------------------
    const registryNow = Date.parse('2026-06-01T00:00:00Z')
    const keyTrusted = 'a'.repeat(64)
    const keyScram = 'b'.repeat(64)
    const keyLegacy = 'c'.repeat(64)
    const keyBoth = 'd'.repeat(64)
    const keyExpired = 'e'.repeat(64)
    const keyConfig = 'f'.repeat(64)
    const keyUnlisted = '1'.repeat(64)

    const registryFile = path.join(tempDir, 'registry-unit-devices')
    await fs.writeFile(
      registryFile,
      [
        '# managed by the p2pgate self-test',
        `trusted ${keyTrusted} trusted-device`,
        `scram ${keyScram} scram-device`,
        `${keyLegacy} legacy-device`,
        `trusted,expires=2028-01-01T00:00:00Z ${keyBoth} both-device`,
        `trusted,expires=2020-01-01T00:00:00Z ${keyExpired} expired-device`,
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    try {
      await fs.chmod(registryFile, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    const registry = new DeviceRegistry({
      configKeys: [keyConfig, keyBoth, keyExpired],
      filePath: registryFile,
      verificationMode: 'hybrid',
      now: () => registryNow,
      posixCheck: async () => ({ ok: true })
    })
    await registry.init()

    const trusted = await registry.evaluate(keyTrusted)
    assert.equal(trusted.listed, true)
    assert.equal(trusted.source, 'trusted_devices')
    assert.equal(trusted.profile, 'trusted')
    assert.equal(trusted.fastpathAllowed, true)
    assert.equal(trusted.label, 'trusted-device')

    const scramDevice = await registry.evaluate(keyScram)
    assert.equal(scramDevice.profile, 'scram')
    assert.equal(scramDevice.fastpathAllowed, false)

    const legacy = await registry.evaluate(keyLegacy)
    assert.equal(legacy.profile, 'scram')

    const configOnly = await registry.evaluate(keyConfig)
    assert.equal(configOnly.source, 'config')
    assert.equal(configOnly.profile, 'scram')

    const both = await registry.evaluate(keyBoth)
    assert.equal(both.source, 'trusted_devices', 'file must override config')
    assert.equal(both.profile, 'trusted')
    assert.equal(both.active, true)

    const expired = await registry.evaluate(keyExpired)
    assert.equal(expired.source, 'trusted_devices')
    assert.equal(expired.active, false, 'expired file entry must override config')
    assert.equal((await registry.evaluate(keyUnlisted)).listed, false)

    assert.deepEqual(
      evaluateDevicePolicy(trusted, {
        verificationMode: 'hybrid',
        interactive: true,
        hasFallback: false
      }),
      { action: 'fastpath' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(scramDevice, {
        verificationMode: 'hybrid',
        interactive: true,
        hasFallback: false
      }),
      { action: 'challenge' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(scramDevice, {
        verificationMode: 'hybrid',
        interactive: false,
        hasFallback: false
      }),
      { action: 'decline', reason: 'interactive_unavailable' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(trusted, {
        verificationMode: 'hybrid',
        interactive: false,
        hasFallback: false
      }),
      { action: 'fastpath' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(trusted, {
        verificationMode: 'key-only',
        interactive: false,
        hasFallback: false
      }),
      { action: 'fastpath' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(scramDevice, {
        verificationMode: 'key-only',
        interactive: false,
        hasFallback: false
      }),
      { action: 'fastpath' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(trusted, {
        verificationMode: 'two-step',
        interactive: true,
        hasFallback: false
      }),
      { action: 'challenge' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(expired, {
        verificationMode: 'hybrid',
        interactive: true,
        hasFallback: false
      }),
      { action: 'decline', reason: 'expired' }
    )
    checks.push('device registry merges config/trusted_devices with correct precedence')
    checks.push('hybrid/key-only/two-step policies and expiration are enforced')

    const insecureRegistry = new DeviceRegistry({
      configKeys: [keyConfig],
      filePath: registryFile,
      verificationMode: 'hybrid',
      now: () => registryNow,
      posixCheck: async () => ({ ok: false, reason: 'permissions' })
    })
    await insecureRegistry.init()
    const insecureTrusted = await insecureRegistry.evaluate(keyTrusted)
    assert.equal(insecureTrusted.permissionsOk, false)
    assert.equal(insecureTrusted.fastpathAllowed, false)
    assert.deepEqual(
      evaluateDevicePolicy(insecureTrusted, {
        verificationMode: 'key-only',
        interactive: true,
        hasFallback: false
      }),
      { action: 'decline', reason: 'insecure_registry' }
    )
    assert.deepEqual(
      evaluateDevicePolicy(insecureTrusted, {
        verificationMode: 'hybrid',
        interactive: true,
        hasFallback: false
      }),
      { action: 'challenge' }
    )
    checks.push('POSIX permission failures disable fast-path entries')

    const reloadFile = path.join(tempDir, 'registry-reload-devices')
    await fs.writeFile(reloadFile, `trusted ${keyTrusted} reload\n`, { mode: 0o600 })
    const reloadRegistry = new DeviceRegistry({
      filePath: reloadFile,
      verificationMode: 'hybrid',
      now: () => registryNow,
      posixCheck: async () => ({ ok: true })
    })
    await reloadRegistry.init()
    assert.equal((await reloadRegistry.evaluate(keyTrusted)).fastpathAllowed, true)

    await new Promise((resolve) => setTimeout(resolve, 20))
    await fs.writeFile(reloadFile, `scram ${keyTrusted} reload\n`, { mode: 0o600 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const reloaded = await reloadRegistry.evaluate(keyTrusted)
    assert.equal(reloaded.profile, 'scram')
    assert.equal(reloaded.fastpathAllowed, false)
    checks.push('trusted_devices reloads on mtime change without restart')

    // ---------------------------------------------------------------------
    // 4b. Audit log format, sanitization, and rotation
    // ---------------------------------------------------------------------
    const auditUnitPath = path.join(tempDir, 'audit-unit.log')
    const auditUnit = new AuditLog({
      enabled: true,
      filePath: auditUnitPath,
      maxBytes: 1024
    })
    await auditUnit.init()
    await auditUnit.record('test.event', {
      source: 'test',
      key: 'a'.repeat(64),
      pin: 'DO-NOT-LOG',
      password: 'DO-NOT-LOG',
      passphrase: 'DO-NOT-LOG',
      token: 'DO-NOT-LOG',
      detail: 'safe'
    })
    await auditUnit.close()

    const auditLines = (await fs.readFile(auditUnitPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(auditLines[0].event, 'test.event')
    assert.equal(auditLines[0].source, 'test')
    assert.equal(auditLines[0].detail, 'safe')
    assert.equal(auditLines[0].pin, undefined)
    assert.equal(auditLines[0].password, undefined)
    assert.equal(auditLines[0].passphrase, undefined)
    assert.equal(auditLines[0].token, undefined)

    const auditRotate = new AuditLog({
      enabled: true,
      filePath: auditUnitPath,
      maxBytes: 1024
    })
    await auditRotate.init()
    for (let i = 0; i < 6; i++) {
      await auditRotate.record('test.large', {
        source: 'test',
        detail: 'x'.repeat(300)
      })
    }
    await auditRotate.close()
    assert.equal(await fs.stat(`${auditUnitPath}.1`).then(() => true), true)
    checks.push('audit log writes JSONL, drops secret fields, and rotates')

    // ---------------------------------------------------------------------
    // 4c. Encrypted client key round-trip and plaintext compatibility
    // ---------------------------------------------------------------------
    const keyPassphrase = 'CorrectHorseBatteryStaple-42' // NOSONAR: test fixture, not a real credential
    const encryptedKeyPath = path.join(tempDir, 'encrypted-key.json')
    const encryptedKey = await generateClientKey(encryptedKeyPath, {
      passphrase: keyPassphrase
    })

    const encryptedMeta = await inspectClientKey(encryptedKeyPath)
    assert.equal(encryptedMeta.encrypted, true)
    assert.equal(encryptedMeta.publicKey, encryptedKey.publicKey)

    const encryptedLoaded = await loadClientKey(encryptedKeyPath, {
      passphrase: keyPassphrase
    })
    assert.equal(encryptedLoaded.publicKey, encryptedKey.publicKey)
    assert.equal(encryptedLoaded.encrypted, true)

    await assert.rejects(
      loadClientKey(encryptedKeyPath, { passphrase: 'wrong-passphrase-000' }),
      (err) => err && err.code === 'KEY_PASSPHRASE_INVALID'
    )
    await assert.rejects(
      loadClientKey(encryptedKeyPath),
      (err) => err && err.code === 'KEY_PASSPHRASE_REQUIRED'
    )

    const plainKeyPath = path.join(tempDir, 'plain-key.json')
    const plainKey = await generateClientKey(plainKeyPath)
    const plainLoaded = await loadClientKey(plainKeyPath)
    assert.equal(plainLoaded.encrypted, false)
    assert.equal(plainLoaded.publicKey, plainKey.publicKey)

    const protectedKey = await protectClientKey(plainKeyPath, {
      passphrase: keyPassphrase
    })
    assert.equal(protectedKey.encrypted, true)
    assert.equal((await inspectClientKey(plainKeyPath)).encrypted, true)

    const unprotectedKey = await unprotectClientKey(plainKeyPath, {
      currentPassphrase: keyPassphrase
    })
    assert.equal(unprotectedKey.encrypted, false)
    assert.equal((await loadClientKey(plainKeyPath)).publicKey, plainKey.publicKey)
    checks.push('encrypted client keys work and plaintext keys remain compatible')

    // ---------------------------------------------------------------------
    // 5. Session PIN format and initial server state
    // ---------------------------------------------------------------------
    const authorizedKeyPath = path.join(tempDir, 'authorized-key.json')
    const secondKeyPath = path.join(tempDir, 'second-key.json')
    const lockoutKeyPath = path.join(tempDir, 'lockout-key.json')
    const invalidKeyPath = path.join(tempDir, 'invalid-key.json')
    const unauthorizedKeyPath = path.join(tempDir, 'unauthorized-key.json')
    const fastKeyPath = path.join(tempDir, 'fast-key.json')
    const expiredKeyPath = path.join(tempDir, 'expired-key.json')
    const revokeKeyPath = path.join(tempDir, 'revoke-key.json')

    const authorized = await generateClientKey(authorizedKeyPath)
    const second = await generateClientKey(secondKeyPath)
    const lockoutKey = await generateClientKey(lockoutKeyPath)
    const invalidKey = await generateClientKey(invalidKeyPath)
    const unauthorized = await generateClientKey(unauthorizedKeyPath)
    const fastKey = await generateClientKey(fastKeyPath)
    const expiredKey = await generateClientKey(expiredKeyPath)
    const revokeKey = await generateClientKey(revokeKeyPath)

    let controlSocketSeq = 0
    const controlPathFor = (name) => process.platform === 'win32'
      ? `\\\\.\\pipe\\p2pgate-test-${process.pid}-${name}-${controlSocketSeq++}`
      : path.join(tempDir, `control-${name}.sock`)
    const mainControlPath = controlPathFor('main')
    const auditPath = path.join(tempDir, 'audit-main.log')

    const trustedDevicesPath = path.join(tempDir, 'trusted_devices')
    await fs.writeFile(
      trustedDevicesPath,
      [
        `trusted ${fastKey.publicKey} fast-workstation`,
        `trusted,expires=2020-01-01T00:00:00Z ${expiredKey.publicKey} expired-laptop`,
        ''
      ].join('\n'),
      { mode: 0o600 }
    )
    try {
      await fs.chmod(trustedDevicesPath, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    const unattendedPassword = 'CorrectHorseBatteryStaple-42' // NOSONAR: test fixture, not a real credential
    const unattendedVerifier = serializeScramVerifier(
      await deriveScramVerifier(unattendedPassword)
    )

    const echoBanner = Buffer.from('P2PGATE-ECHO-BANNER\n')

    echoServer = net.createServer((socket) => {
      targetConnections += 1
      socket.on('error', noop)
      socket.write(echoBanner)
      socket.pipe(socket)
    })

    await new Promise((resolve, reject) => {
      echoServer.once('error', reject)
      echoServer.listen(0, '127.0.0.1', resolve)
    })

    const echoPort = echoServer.address().port
    const bootstrapPort = await getFreeUdpPort()

    // A config written by saveConfig() must be loadable again. Regression guard
    // for `targets.*.allow: null` and an empty `socks.allow` list.
    const roundTripServer = normalizeConfig({
      mode: 'server',
      masterSecret,
      targets: { web: { port: echoPort } },
      socks: { enabled: true, allow: ['127.0.0.1:8080'] }
    })
    const roundTripServerAgain = normalizeConfig(
      JSON.parse(JSON.stringify(roundTripServer))
    )
    assert.equal(roundTripServerAgain.defaultTarget, 'web')
    assert.equal(roundTripServerAgain.targets.web.port, echoPort)
    assert.deepEqual(roundTripServerAgain.socks.allow, ['127.0.0.1:8080'])

    const roundTripClient = normalizeConfig({
      mode: 'client',
      masterSecret,
      target: 'web',
      targets: { default: { port: 8022, allow: null } }
    })
    const roundTripClientAgain = normalizeConfig(
      JSON.parse(JSON.stringify(roundTripClient))
    )
    assert.equal(roundTripClientAgain.target, 'web')
    assert.equal(roundTripClientAgain.targets, undefined)
    checks.push('config survives a save/load round-trip (targets, socks)')

    // masterSecret rotation must back up the old config and keep other fields.
    const rotateConfigPath = path.join(tempDir, 'rotate-config.json')
    const rotateSource = normalizeConfig({
      mode: 'server',
      masterSecret,
      targets: { web: { port: echoPort } }
    })
    await fs.writeFile(
      rotateConfigPath,
      `${JSON.stringify(rotateSource, null, 2)}\n`,
      { mode: 0o600 }
    )

    const rotated = await rotateMasterSecret(rotateConfigPath)
    assert.notEqual(rotated.masterSecret, masterSecret)
    assert.equal(rotated.previousFingerprint, fingerprint(masterSecret))

    const rotatedReloaded = normalizeConfig(
      JSON.parse(await fs.readFile(rotateConfigPath, 'utf8'))
    )
    assert.equal(rotatedReloaded.masterSecret, rotated.masterSecret)
    assert.equal(rotatedReloaded.targets.web.port, echoPort)

    const backupStat = await fs.stat(rotated.backupPath)
    assert.equal(backupStat.isFile(), true)
    checks.push('masterSecret rotation writes a backup and keeps other fields')

    // --no-backup must not leave the old secret on disk.
    const noBackupPath = path.join(tempDir, 'rotate-nobackup.json')
    await fs.writeFile(
      noBackupPath,
      `${JSON.stringify(normalizeConfig({
        mode: 'server',
        masterSecret
      }), null, 2)}\n`,
      { mode: 0o600 }
    )
    const rotatedNoBackup = await rotateMasterSecret(noBackupPath, { backup: false })
    assert.equal(rotatedNoBackup.backupPath, null)
    assert.equal(rotatedNoBackup.backupSkipped, true)
    const noBackupFiles = await fs.readdir(tempDir)
    assert.equal(
      noBackupFiles.some((name) => name.startsWith('rotate-nobackup.json.bak-')),
      false
    )
    checks.push('masterSecret rotation can skip the backup on request')

    const redactedConfig = redactConfig(normalizeConfig({
      mode: 'server',
      masterSecret,
      targets: { web: { port: echoPort } },
      socks: { enabled: true, allow: ['127.0.0.1:8080'] }
    }))
    assert.equal(JSON.stringify(redactedConfig).includes(masterSecret), false)
    assert.ok(String(redactedConfig.masterSecret).startsWith('<redacted'))
    checks.push('config redaction hides secret material')

    // hosts.json round-trip
    const hostsPath = path.join(tempDir, 'hosts.json')
    await setHost('lab', {
      masterSecret,
      target: 'web',
      localPort: 18022,
      socks5Port: null,
      targetPort: 8022
    }, hostsPath)
    const labHost = await getHost('lab', hostsPath)
    assert.equal(labHost.target, 'web')
    assert.equal(labHost.localPort, 18022)
    assert.equal((await listHosts(hostsPath)).length, 1)
    await deleteHost('lab', hostsPath)
    assert.equal((await listHosts(hostsPath)).length, 0)
    checks.push('hosts.json stores and removes aliases')

    // audit viewer filters failures and honours --tail
    const auditViewPath = path.join(tempDir, 'audit-view.jsonl')
    await fs.writeFile(auditViewPath, [
      JSON.stringify({ ts: new Date(Date.now() - 5_000).toISOString(), event: 'auth.success', key: 'a'.repeat(64) }),
      JSON.stringify({ ts: new Date(Date.now() - 4_000).toISOString(), event: 'auth.failure', key: 'b'.repeat(64), attempts: 2 }),
      JSON.stringify({ ts: new Date(Date.now() - 3_000).toISOString(), event: 'auth.success', key: 'c'.repeat(64) })
    ].join('\n') + '\n')

    const failures = await readAuditEvents(auditViewPath, { limit: 10, failuresOnly: true })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].event, 'auth.failure')

    const recent = await readAuditEvents(auditViewPath, { limit: 2 })
    assert.equal(recent.length, 2)
    checks.push('audit viewer filters by failure and tail limit')

    bootstrapper = HyperDHT.bootstrapper(bootstrapPort, '127.0.0.1')
    await bootstrapper.fullyBootstrapped()

    const bootstrap = [`127.0.0.1:${bootstrapPort}`]
    const lockoutStatePath = path.join(tempDir, 'lockout-state.json')

    const serverConfig = {
      mode: 'server',
      masterSecret,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: authorizedKeyPath,
      allowedClientKeys: [
        authorized.publicKey,
        second.publicKey,
        lockoutKey.publicKey,
        invalidKey.publicKey,
        expiredKey.publicKey,
        revokeKey.publicKey,
        encryptedKey.publicKey
      ],
      verificationMode: 'hybrid',
      trustedDevicesFile: trustedDevicesPath,
      auditLog: {
        enabled: true,
        path: auditPath,
        maxBytes: 5 * 1024 * 1024
      },
      customBootstrap: bootstrap,
      authPin: {
        enabled: true,
        unattended: unattendedVerifier
      },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }

    gateway = await startServer(serverConfig, {
      log: quiet,
      rotationCheckMs: 150,
      sendStartupAlert: false,
      showSessionPin: false,
      interactive: false,
      authTimeoutMs: 4_000,
      failDelayMs: [10, 20],
      lockoutStatePath,
      lockoutNow: () => lockoutNow,
      now: () => serverNow,
      controlSocketPath: mainControlPath,
      controlTokenPath: path.join(tempDir, 'control-main.token')
    })

    assert.deepEqual(
      gateway.listeningSlots,
      [slot - 1, slot],
      'server must listen on the current and previous slot'
    )
    assert.equal(gateway.authEnabled, true)
    assert.equal(typeof gateway.sessionPin, 'string')
    assert.equal(gateway.sessionPin.length, 10, 'session PIN must be 10 characters')
    assert.match(gateway.sessionPin, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/)
    assert.match(formatSessionPin(gateway.sessionPin), /^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    assert.equal(gateway.pinGeneration, 0)
    checks.push('10-character Session PIN uses the unambiguous Base32 alphabet')

    // ---------------------------------------------------------------------
    // 5. Unauthorized client is rejected by the firewall
    // ---------------------------------------------------------------------
    probeDht = new HyperDHT({ bootstrap })
    const unauthorizedKey = await loadClientKey(unauthorizedKeyPath)
    const currentServerPublicKey = deriveServerPublicKey(masterSecret, slot)

    let unauthorizedOpened = false
    const probeStream = probeDht.connect(currentServerPublicKey, {
      keyPair: unauthorizedKey.keyPair
    })

    probeStream.on('open', () => {
      unauthorizedOpened = true
    })
    probeStream.on('error', noop)

    const targetBeforeProbe = targetConnections
    const probeStatusRead = await readControlLine(probeStream, {
      timeoutMs: 15_000,
      maxBytes: 4096
    })
    const probeStatus = decodeControl(probeStatusRead.line)

    assert.equal(unauthorizedOpened, true)
    assert.equal(probeStatus.status, AUTH_STATUS.DECLINED)
    assert.equal(probeStatus.reason, 'unlisted')
    assert.equal(targetConnections, targetBeforeProbe)
    assert.ok(gateway.blockedCount >= 1)

    probeStream.destroy()
    await probeDht.destroy()
    probeDht = null
    checks.push('unlisted client key receives STATUS_DECLINED without reaching the target')

    // ---------------------------------------------------------------------
    // Shared client setup helpers
    // ---------------------------------------------------------------------
    const clientBase = {
      mode: 'client',
      masterSecret,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 0,
      allowedClientKeys: [],
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }

    const startTestClient = async (keyPath, credential, options = {}) => {
      const base = options.base || clientBase
      const client = await startClient(
        { ...base, clientKeyPath: keyPath },
        {
          log: options.log || quiet,
          connectTimeoutMs: 7_000,
          authTimeoutMs: 4_000,
          now: options.now || (() => serverNow),
          input: options.input,
          output: options.output,
          keyPassphrase: options.keyPassphrase,
          credential,
          target: options.target,
          socksPort: options.socksPort,
          mux: options.mux,
          compress: options.compress
        }
      )
      clients.push(client)
      return client
    }

    const echoThrough = async (client, payload) => {
      const socket = await connectLocal(client.address().port)
      const banner = await readExactly(socket, echoBanner.length, 15_000)
      assert.deepEqual(banner, echoBanner)
      socket.write(payload)
      const echoed = await readExactly(socket, payload.length, 15_000)
      socket.destroy()
      return echoed
    }

    const initialPin = gateway.sessionPin

    // ---------------------------------------------------------------------
    // 6. Valid Session PIN: lowercase/no hyphen and uppercase/with hyphen
    // ---------------------------------------------------------------------
    originalClient = await startTestClient(
      authorizedKeyPath,
      initialPin.toLowerCase(),
      { now: () => serverNow - 3_600_000 }
    )

    originalSocket = await connectLocal(originalClient.address().port)
    const originalBanner = await readExactly(originalSocket, echoBanner.length, 15_000)
    assert.deepEqual(originalBanner, echoBanner)

    const originalPayload = crypto.randomBytes(256)
    originalSocket.write(originalPayload)
    assert.deepEqual(
      await readExactly(originalSocket, originalPayload.length, 15_000),
      originalPayload
    )
    checks.push('lowercase 10-character Session PIN works')

    const hyphenClient = await startTestClient(
      authorizedKeyPath,
      formatSessionPin(initialPin)
    )
    const hyphenPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(hyphenClient, hyphenPayload), hyphenPayload)
    checks.push('uppercase hyphenated Session PIN works')
    await hyphenClient.close()

    // ---------------------------------------------------------------------
    // 7. Unattended password (case-sensitive, >= 12 chars)
    // ---------------------------------------------------------------------
    const passwordClient = await startTestClient(secondKeyPath, unattendedPassword)
    const passwordPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(passwordClient, passwordPayload), passwordPayload)
    checks.push('case-sensitive unattended password authenticates')
    await passwordClient.close()

    const encryptedKeyClient = await startTestClient(
      encryptedKeyPath,
      unattendedPassword,
      { keyPassphrase }
    )
    const encryptedKeyPayload = crypto.randomBytes(128)
    assert.deepEqual(
      await echoThrough(encryptedKeyClient, encryptedKeyPayload),
      encryptedKeyPayload
    )
    checks.push('client connects with a passphrase-protected key')
    await encryptedKeyClient.close()

    // ---------------------------------------------------------------------
    // 7a. Local control plane: status, pin, revoke, unlock, shutdown
    // ---------------------------------------------------------------------
    const mainControlToken = await readControlToken(gateway.controlTokenPath)
    const mainControl = (request) => sendControlCommand(
      mainControlPath,
      { v: CONTROL_VERSION, ...request },
      { token: mainControlToken }
    )

    if (process.platform !== 'win32') {
      const socketStat = await fs.lstat(mainControlPath)
      assert.equal(socketStat.mode & 0o777, 0o600)
      const tokenStat = await fs.stat(gateway.controlTokenPath)
      assert.equal(tokenStat.mode & 0o777, 0o600)
    }

    const unauthorizedControl = await sendControlCommand(
      mainControlPath,
      { v: CONTROL_VERSION, cmd: 'status', token: '0'.repeat(64) }
    )
    assert.equal(unauthorizedControl.ok, false)
    assert.equal(unauthorizedControl.error, 'UNAUTHORIZED')

    const statusResponse = await mainControl({ cmd: 'status' })
    assert.equal(statusResponse.ok, true)
    assert.equal(statusResponse.verificationMode, 'hybrid')
    assert.equal(statusResponse.registrySize, gateway.registrySize)
    assert.deepEqual(statusResponse.listeningSlots, gateway.listeningSlots)
    assert.equal(statusResponse.sessionPinAvailable, true)
    assert.equal(statusResponse.interactive, false)
    assert.ok(statusResponse.blockedCount >= 1)

    const pinResponse = await mainControl({ cmd: 'pin' })
    assert.equal(pinResponse.ok, true)
    assert.equal(pinResponse.pin, gateway.sessionPin)
    assert.equal(pinResponse.formatted, formatSessionPin(gateway.sessionPin))
    checks.push('control status and pin require the per-server token')

    const statusWithTraffic = await mainControl({ cmd: 'status' })
    assert.equal(statusWithTraffic.ok, true)
    assert.ok(statusWithTraffic.traffic, 'status must include traffic counters')
    assert.ok(statusWithTraffic.traffic.totalOut > 0, 'echo traffic must be counted')
    assert.ok(Array.isArray(statusWithTraffic.traffic.active))
    checks.push('status reports in-memory traffic counters')

    const dedicatedBulk = crypto.randomBytes(1024 * 1024)
    assert.deepEqual(await echoThrough(originalClient, dedicatedBulk), dedicatedBulk)
    checks.push('dedicated stream carries a 1 MiB transfer intact')

    const pingSession = await startClient(
      { ...clientBase, clientKeyPath: authorizedKeyPath, masterSecret },
      {
        log: quiet,
        credential: unattendedPassword,
        ping: { count: 2 },
        connectTimeoutMs: 7_000,
        authTimeoutMs: 4_000,
        now: () => serverNow
      }
    )
    const pingOk = (pingSession.results || []).find((entry) => entry.ok)
    assert.ok(pingOk, 'ping must reach the server')
    assert.equal(pingOk.attempts, 2)
    assert.equal(pingOk.authMs.length, 2)
    await pingSession.close()
    checks.push('ping measures the authenticated handshake per attempt')

    const revokeClient = await startTestClient(revokeKeyPath, unattendedPassword)
    const revokeSocket = await connectLocal(revokeClient.address().port)
    const revokeBanner = await readExactly(revokeSocket, echoBanner.length, 15_000)
    assert.deepEqual(revokeBanner, echoBanner)

    let revokeSocketClosed = false
    revokeSocket.once('close', () => {
      revokeSocketClosed = true
    })
    revokeSocket.on('error', noop)

    const revokeResponse = await mainControl({
      cmd: 'revoke',
      key: revokeKey.publicKey
    })
    assert.equal(revokeResponse.ok, true)
    assert.equal(revokeResponse.key, revokeKey.publicKey)
    assert.ok(revokeResponse.closed >= 1)

    await waitFor(
      () => revokeSocketClosed,
      10_000,
      'the revoked tunnel socket to close'
    )

    const revokedState = gateway.getAuthState(revokeKey.publicKey)
    assert.equal(revokedState.revoked, true)
    assert.equal(revokedState.reason, 'manual')
    assert.equal(revokedState.permanent, true)

    const targetBeforeRevokedReconnect = targetConnections
    const revokedReconnect = await sendAndExpectNoEcho(
      revokeClient.address().port,
      Buffer.from('revoked-device')
    )
    assert.equal(revokedReconnect.closed, true)
    assert.equal(revokedReconnect.received, 0)
    assert.equal(targetConnections, targetBeforeRevokedReconnect)

    await new Promise((resolve) => setTimeout(resolve, 25))
    const unlockGuard = new AuthGuard({ statePath: lockoutStatePath })
    await unlockGuard.init()
    await unlockGuard.unlock(revokeKey.publicKey)
    await unlockGuard.close()

    const restoredClient = await startTestClient(revokeKeyPath, unattendedPassword)
    const restoredPayload = crypto.randomBytes(64)
    assert.deepEqual(
      await echoThrough(restoredClient, restoredPayload),
      restoredPayload
    )
    checks.push('control revoke closes active tunnels, blocks reconnects, and unlock restores access')
    await restoredClient.close()
    await revokeClient.close()

    // ---------------------------------------------------------------------
    // 7b. Fast-path, expiration, and live trusted_devices reload
    // ---------------------------------------------------------------------
    const fastClient = await startTestClient(fastKeyPath, undefined)
    const fastPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(fastClient, fastPayload), fastPayload)
    checks.push('hybrid trusted device uses fast-path without a credential prompt')
    await fastClient.close()

    const expiredClient = await startTestClient(expiredKeyPath, undefined)
    const targetBeforeExpired = targetConnections
    const expiredResult = await sendAndExpectNoEcho(
      expiredClient.address().port,
      Buffer.from('expired-device')
    )
    assert.equal(expiredResult.closed, true)
    assert.equal(expiredResult.received, 0)
    assert.equal(targetConnections, targetBeforeExpired)
    checks.push('expired trusted_devices entry overrides config and is declined')
    await expiredClient.close()

    // Make the fast-path key expired and prove the running server reloads it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await fs.writeFile(
      trustedDevicesPath,
      `trusted,expires=2020-01-01T00:00:00Z ${fastKey.publicKey} expired-fast\n`,
      { mode: 0o600 }
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    const reloadedFastClient = await startTestClient(fastKeyPath, undefined)
    const targetBeforeReload = targetConnections
    const reloadedFastResult = await sendAndExpectNoEcho(
      reloadedFastClient.address().port,
      Buffer.from('reloaded-device')
    )
    assert.equal(reloadedFastResult.closed, true)
    assert.equal(reloadedFastResult.received, 0)
    assert.equal(targetConnections, targetBeforeReload)
    checks.push('trusted_devices live reload changes fast-path eligibility')
    await reloadedFastClient.close()

    // ---------------------------------------------------------------------
    // 8. Invalid PIN delay and no local target connection
    // ---------------------------------------------------------------------
    const invalidClient = await startTestClient(
      invalidKeyPath,
      wrongPin(gateway.sessionPin)
    )

    const targetBeforeInvalid = targetConnections
    const invalidStartedAt = Date.now()
    const invalidResult = await sendAndExpectNoEcho(
      invalidClient.address().port,
      Buffer.from('invalid-pin')
    )
    const invalidElapsed = Date.now() - invalidStartedAt

    assert.equal(invalidResult.closed, true)
    assert.equal(invalidResult.received, 0)
    assert.ok(invalidElapsed >= 10, `expected a failure delay, got ${invalidElapsed}ms`)
    assert.equal(targetConnections, targetBeforeInvalid, 'invalid PIN must not open targetPort')
    assert.equal(gateway.getAuthState(invalidKey.publicKey).failures, 1)
    checks.push('invalid PIN is delayed and never opens the local target')
    await invalidClient.close()

    // ---------------------------------------------------------------------
    // 9. Three failures -> 15-minute suspension + Session PIN refresh
    // ---------------------------------------------------------------------
    const oldPin = gateway.sessionPin
    const badClient = await startTestClient(authorizedKeyPath, wrongPin(oldPin))

    for (let attempt = 1; attempt <= 3; attempt++) {
      const targetBefore = targetConnections
      const result = await sendAndExpectNoEcho(
        badClient.address().port,
        Buffer.from(`bad-pin-${attempt}`)
      )
      assert.equal(result.closed, true)
      assert.equal(result.received, 0)
      assert.equal(targetConnections, targetBefore)
    }

    assert.equal(gateway.isAuthSuspended(authorized.publicKey), true)
    assert.equal(gateway.getAuthState(authorized.publicKey).failures, 3)
    assert.equal(gateway.getAuthState(authorized.publicKey).level, 3)
    assert.ok(
      gateway.getAuthState(authorized.publicKey).remainingMs > 14 * 60 * 1000,
      '3 failures must suspend for roughly 15 minutes'
    )
    assert.notEqual(gateway.sessionPin, oldPin)
    assert.equal(gateway.pinGeneration, 1)
    const newPin = gateway.sessionPin
    checks.push('3 failures suspend the key and refresh the Session PIN')
    await badClient.close()

    // Old PIN is invalid; the new PIN works for another authorized client.
    const oldPinClient = await startTestClient(secondKeyPath, formatSessionPin(oldPin))
    const targetBeforeOldPin = targetConnections
    const oldPinResult = await sendAndExpectNoEcho(
      oldPinClient.address().port,
      Buffer.from('old-pin')
    )
    assert.equal(oldPinResult.closed, true)
    assert.equal(oldPinResult.received, 0)
    assert.equal(targetConnections, targetBeforeOldPin)
    assert.equal(gateway.getAuthState(second.publicKey).failures, 1)
    await oldPinClient.close()

    const newPinClient = await startTestClient(
      secondKeyPath,
      formatSessionPin(newPin).toLowerCase()
    )
    const newPinPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(newPinClient, newPinPayload), newPinPayload)
    assert.equal(gateway.getAuthState(second.publicKey).failures, 0)
    checks.push('old PIN is rejected after refresh and the new PIN works')
    await newPinClient.close()

    // ---------------------------------------------------------------------
    // 10. Ten failures -> persistent suspension, reload, live unlock
    // ---------------------------------------------------------------------
    const badLockoutClient = await startTestClient(
      lockoutKeyPath,
      wrongPin(gateway.sessionPin)
    )

    for (let attempt = 1; attempt <= 10; attempt++) {
      const targetBefore = targetConnections
      const result = await sendAndExpectNoEcho(
        badLockoutClient.address().port,
        Buffer.from(`bad-lockout-${attempt}`)
      )
      assert.equal(result.closed, true)
      assert.equal(result.received, 0)
      assert.equal(targetConnections, targetBefore)

      if (attempt === 3) {
        assert.equal(gateway.isAuthSuspended(lockoutKey.publicKey), true)
        assert.equal(gateway.getAuthState(lockoutKey.publicKey).level, 3)
        assert.ok(
          gateway.getAuthState(lockoutKey.publicKey).remainingMs > 14 * 60 * 1000,
          'third failure must use the 15-minute suspension'
        )
        lockoutNow += 15 * 60 * 1000 + 1000
      } else if (attempt === 6) {
        assert.equal(gateway.getAuthState(lockoutKey.publicKey).level, 6)
        assert.ok(
          gateway.getAuthState(lockoutKey.publicKey).remainingMs > 5 * 60 * 60 * 1000,
          'sixth failure must use the 6-hour suspension'
        )
        lockoutNow += 6 * 60 * 60 * 1000 + 1000
      }
    }

    assert.equal(gateway.getAuthState(lockoutKey.publicKey).failures, 10)
    assert.equal(gateway.getAuthState(lockoutKey.publicKey).permanent, true)
    assert.equal(gateway.isAuthSuspended(lockoutKey.publicKey), true)
    assert.equal(gateway.pinGeneration, 3)
    checks.push('10 failures create a persistent suspension')
    await badLockoutClient.close()

    const reloadedGuard = new AuthGuard({
      statePath: lockoutStatePath,
      now: () => lockoutNow
    })
    await reloadedGuard.init()

    const persisted = reloadedGuard.getStatus(lockoutKey.publicKey)
    assert.equal(persisted.permanent, true)
    assert.equal(persisted.failures, 10)
    checks.push('suspension persists across AuthGuard reloads')

    // Simulate `p2pgate unlock` from another Termux session.
    await reloadedGuard.unlock(lockoutKey.publicKey)
    await reloadedGuard.close()

    // Let the state file's mtime change so the running server reloads it.
    await new Promise((resolve) => setTimeout(resolve, 20))

    const recoveredLockoutClient = await startTestClient(
      lockoutKeyPath,
      formatSessionPin(gateway.sessionPin)
    )
    const recoveredPayload = crypto.randomBytes(128)
    assert.deepEqual(
      await echoThrough(recoveredLockoutClient, recoveredPayload),
      recoveredPayload,
      'live unlock must restore access without restarting the server'
    )
    checks.push('live unlock restores access without restarting the server')
    await recoveredLockoutClient.close()

    // ---------------------------------------------------------------------
    // 10b. key-only mode: no session PIN, no prompt, fast-path by public key
    // ---------------------------------------------------------------------
    const keyOnlySecret = crypto.randomBytes(32).toString('hex')
    const keyOnlyKeyPath = path.join(tempDir, 'keyonly-key.json')
    const keyOnlyKey = await generateClientKey(keyOnlyKeyPath)
    const keyOnlyControlPath = controlPathFor('keyonly')

    const keyOnlyServer = await startServer({
      mode: 'server',
      masterSecret: keyOnlySecret,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: keyOnlyKeyPath,
      allowedClientKeys: [keyOnlyKey.publicKey],
      verificationMode: 'key-only',
      trustedDevicesFile: path.join(tempDir, 'keyonly-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: false, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'keyonly-lockout.json'),
      authTimeoutMs: 4_000,
      controlSocketPath: keyOnlyControlPath,
      controlTokenPath: path.join(tempDir, 'control-keyonly.token')
    })
    extraServers.push(keyOnlyServer)

    assert.equal(keyOnlyServer.verificationMode, 'key-only')
    assert.equal(keyOnlyServer.sessionPin, null)

    const keyOnlyClientBase = { ...clientBase, masterSecret: keyOnlySecret }
    const keyOnlyClient = await startTestClient(keyOnlyKeyPath, undefined, {
      base: keyOnlyClientBase,
      now: () => Date.now()
    })
    const keyOnlyPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(keyOnlyClient, keyOnlyPayload), keyOnlyPayload)
    checks.push('key-only mode uses fast-path with no session PIN or prompt')

    const keyOnlyToken = await readControlToken(keyOnlyServer.controlTokenPath)
    const keyOnlyControlTokenPath = keyOnlyServer.controlTokenPath
    const keyOnlyControl = (request) => sendControlCommand(
      keyOnlyControlPath,
      { v: CONTROL_VERSION, ...request },
      { token: keyOnlyToken }
    )

    const keyOnlyStatus = await keyOnlyControl({ cmd: 'status' })
    assert.equal(keyOnlyStatus.ok, true)
    assert.equal(keyOnlyStatus.verificationMode, 'key-only')
    assert.equal(keyOnlyStatus.sessionPinAvailable, false)

    const keyOnlyPin = await keyOnlyControl({ cmd: 'pin' })
    assert.equal(keyOnlyPin.ok, false)
    assert.equal(keyOnlyPin.error, 'NO_SESSION_PIN')

    await keyOnlyClient.close()
    await keyOnlyServer.close()

    await assert.rejects(
      fs.stat(keyOnlyControlTokenPath),
      (err) => err && err.code === 'ENOENT'
    )
    await assert.rejects(
      sendControlCommand(keyOnlyControlPath, { v: CONTROL_VERSION, cmd: 'status' }),
      (err) => err && err.code === 'CONTROL_UNAVAILABLE'
    )
    checks.push('control pin returns NO_SESSION_PIN in key-only mode and the socket is removed on close')

    // ---------------------------------------------------------------------
    // 10c. two-step mode: trusted devices still require SCRAM
    // ---------------------------------------------------------------------
    const twoStepSecret = crypto.randomBytes(32).toString('hex')
    const twoStepKeyPath = path.join(tempDir, 'twostep-key.json')
    const twoStepKey = await generateClientKey(twoStepKeyPath)
    const twoStepDevicesPath = path.join(tempDir, 'twostep_devices')
    const twoStepControlPath = controlPathFor('twostep')

    await fs.writeFile(
      twoStepDevicesPath,
      `trusted ${twoStepKey.publicKey} two-step-trusted\n`,
      { mode: 0o600 }
    )
    try {
      await fs.chmod(twoStepDevicesPath, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    const twoStepServer = await startServer({
      mode: 'server',
      masterSecret: twoStepSecret,
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: twoStepKeyPath,
      allowedClientKeys: [],
      verificationMode: 'two-step',
      trustedDevicesFile: twoStepDevicesPath,
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'twostep-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: true,
      controlSocketPath: twoStepControlPath,
      controlTokenPath: path.join(tempDir, 'control-twostep.token')
    })
    extraServers.push(twoStepServer)

    assert.equal(twoStepServer.verificationMode, 'two-step')
    assert.equal(twoStepServer.sessionPin.length, 10)

    const twoStepClientBase = { ...clientBase, masterSecret: twoStepSecret }
    const noCredentialClient = await startTestClient(twoStepKeyPath, undefined, {
      base: twoStepClientBase,
      now: () => Date.now(),
      input: { isTTY: false }
    })
    const targetBeforeNoCredential = targetConnections
    const noCredentialResult = await sendAndExpectNoEcho(
      noCredentialClient.address().port,
      Buffer.from('no-credential')
    )
    assert.equal(noCredentialResult.closed, true)
    assert.equal(noCredentialResult.received, 0)
    assert.equal(targetConnections, targetBeforeNoCredential)
    await noCredentialClient.close()

    const twoStepClient = await startTestClient(
      twoStepKeyPath,
      formatSessionPin(twoStepServer.sessionPin),
      { base: twoStepClientBase, now: () => Date.now() }
    )
    const twoStepPayload = crypto.randomBytes(128)
    assert.deepEqual(await echoThrough(twoStepClient, twoStepPayload), twoStepPayload)
    checks.push('two-step mode challenges trusted devices and ignores fast-path')
    await twoStepClient.close()
    await twoStepServer.close()

    // ---------------------------------------------------------------------
    // 10d. password auth mode accepts a new client key
    // ---------------------------------------------------------------------
    const passwordSecret = crypto.randomBytes(32).toString('hex')
    const passwordControlPath = controlPathFor('password')
    const passwordServer = await startServer({
      mode: 'server',
      masterSecret: passwordSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'password-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'password-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'password-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: passwordControlPath,
      controlTokenPath: path.join(tempDir, 'control-password.token')
    })
    extraServers.push(passwordServer)

    assert.equal(passwordServer.authMode, 'password')
    assert.equal(passwordServer.registrySize, 0)

    const passwordClientBase = { ...clientBase, masterSecret: passwordSecret }
    const passwordModeClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: passwordClientBase }
    )
    const passwordModePayload = crypto.randomBytes(128)
    assert.deepEqual(
      await echoThrough(passwordModeClient, passwordModePayload),
      passwordModePayload
    )

    const wrongPasswordClient = await startTestClient(
      unauthorizedKeyPath,
      'wrong-password-000000',
      { base: passwordClientBase }
    )
    const targetBeforeWrongPassword = targetConnections
    const wrongPasswordResult = await sendAndExpectNoEcho(
      wrongPasswordClient.address().port,
      Buffer.from('wrong-password')
    )
    assert.equal(wrongPasswordResult.closed, true)
    assert.equal(wrongPasswordResult.received, 0)
    assert.equal(targetConnections, targetBeforeWrongPassword)
    checks.push('password auth mode accepts an unregistered key and rejects a wrong password')

    await passwordModeClient.close()
    await wrongPasswordClient.close()
    await passwordServer.close()

    // ---------------------------------------------------------------------
    // 10d-2. a slow credential answer must not break authentication
    // ---------------------------------------------------------------------
    const slowSecret = crypto.randomBytes(32).toString('hex')
    const slowControlPath = controlPathFor('slow')
    const slowServer = await startServer({
      mode: 'server',
      masterSecret: slowSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'slow-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'slow-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'slow-lockout.json'),
      // The READY step must be fast, so keep its window tight. The human then
      // has the wider proof window to type the password.
      authTimeoutMs: 3_000,
      preAuthTimeoutMs: 500,
      interactive: false,
      controlSocketPath: slowControlPath,
      controlTokenPath: path.join(tempDir, 'control-slow.token')
    })
    extraServers.push(slowServer)

    const slowClientBase = { ...clientBase, masterSecret: slowSecret }
    const slowClient = await startTestClient(
      unauthorizedKeyPath,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 900))
        return unattendedPassword
      },
      { base: slowClientBase }
    )
    const slowPayload = crypto.randomBytes(64)
    assert.deepEqual(
      await echoThrough(slowClient, slowPayload),
      slowPayload,
      'a slow password entry must still authenticate'
    )
    checks.push('slow credential entry does not break authentication')
    await slowClient.close()
    await slowServer.close()

    // ---------------------------------------------------------------------
    // 10d-3. the client retries once when the auth stream dies mid-handshake
    // ---------------------------------------------------------------------
    const retrySecret = crypto.randomBytes(32).toString('hex')
    const retryControlPath = controlPathFor('retry')
    const retryConfig = {
      mode: 'server',
      masterSecret: retrySecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'retry-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'retry-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }
    const retryOptions = {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'retry-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: retryControlPath,
      controlTokenPath: path.join(tempDir, 'control-retry.token')
    }

    let retryServer = await startServer(retryConfig, retryOptions)
    extraServers.push(retryServer)
    let restartedOnce = false

    const retryClient = await startTestClient(
      unauthorizedKeyPath,
      async () => {
        if (!restartedOnce) {
          restartedOnce = true
          await retryServer.close()
          retryServer = await startServer(retryConfig, retryOptions)
          extraServers.push(retryServer)
        }
        return unattendedPassword
      },
      { base: { ...clientBase, masterSecret: retrySecret } }
    )

    const retryPayload = crypto.randomBytes(64)
    assert.deepEqual(
      await echoThrough(retryClient, retryPayload),
      retryPayload,
      'the client must retry once after the auth stream closes'
    )
    checks.push('client retries once when the auth stream closes mid-handshake')
    await retryClient.close()
    await retryServer.close()

    // ---------------------------------------------------------------------
    // 10d-4. multi-target routing and per-target allowlists
    // ---------------------------------------------------------------------
    const webBanner = Buffer.from('P2PGATE-WEB-BANNER\n')
    let webConnections = 0

    const webEchoServer = net.createServer((socket) => {
      webConnections += 1
      socket.on('error', noop)
      socket.write(webBanner)
      socket.pipe(socket)
    })

    await new Promise((resolve, reject) => {
      webEchoServer.once('error', reject)
      webEchoServer.listen(0, '127.0.0.1', resolve)
    })

    const webPort = webEchoServer.address().port
    const targetSecret = crypto.randomBytes(32).toString('hex')

    const targetServer = await startServer({
      mode: 'server',
      masterSecret: targetSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      targets: {
        default: { host: '127.0.0.1', port: echoPort },
        web: { host: '127.0.0.1', port: webPort },
        locked: { host: '127.0.0.1', port: webPort, allow: [second.publicKey] }
      },
      defaultTarget: 'default',
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'target-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'target-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'target-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('target'),
      controlTokenPath: path.join(tempDir, 'control-target.token')
    })
    extraServers.push(targetServer)

    const targetClientBase = { ...clientBase, masterSecret: targetSecret }

    const webTargetClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: targetClientBase, target: 'web' }
    )
    const webSocket = await connectLocal(webTargetClient.address().port)
    const webBannerRead = await readExactly(webSocket, webBanner.length, 15_000)
    assert.deepEqual(webBannerRead, webBanner)
    webSocket.destroy()
    checks.push('multi-target routing reaches the selected service')
    await webTargetClient.close()

    const unknownTargetClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: targetClientBase, target: 'nope' }
    )
    const targetBeforeUnknown = targetConnections
    const unknownTargetResult = await sendAndExpectNoEcho(
      unknownTargetClient.address().port,
      Buffer.from('unknown-target')
    )
    assert.equal(unknownTargetResult.closed, true)
    assert.equal(unknownTargetResult.received, 0)
    assert.equal(targetConnections, targetBeforeUnknown)
    checks.push('unknown target is rejected without touching the default target')
    await unknownTargetClient.close()

    const forbiddenTargetClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: targetClientBase, target: 'locked' }
    )
    const webBeforeForbidden = webConnections
    const forbiddenTargetResult = await sendAndExpectNoEcho(
      forbiddenTargetClient.address().port,
      Buffer.from('forbidden-target')
    )
    assert.equal(forbiddenTargetResult.closed, true)
    assert.equal(forbiddenTargetResult.received, 0)
    assert.equal(webConnections, webBeforeForbidden)
    checks.push('per-target allowlist rejects a client key')

    const defaultTargetClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: targetClientBase }
    )
    const defaultTargetPayload = crypto.randomBytes(64)
    assert.deepEqual(
      await echoThrough(defaultTargetClient, defaultTargetPayload),
      defaultTargetPayload
    )
    checks.push('a client without a target still uses the default target')

    await forbiddenTargetClient.close()
    await defaultTargetClient.close()
    await targetServer.close()
    await new Promise((resolve) => webEchoServer.close(resolve))

    // ---------------------------------------------------------------------
    // 10d-5. SOCKS5 gateway with an IP/CIDR allowlist
    // ---------------------------------------------------------------------
    const socksHandshake = async (socksPort, host, destPort) => {
      const socket = await connectLocal(socksPort)
      socket.write(Buffer.from([5, 1, 0]))
      const greeting = await readExactly(socket, 2, 5_000)
      assert.deepEqual([...greeting], [5, 0])

      const hostBuf = Buffer.from(host)
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(destPort)
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, hostBuf.length]),
        hostBuf,
        portBuf
      ]))

      const reply = await readExactly(socket, 10, 5_000)
      return { socket, code: reply[1] }
    }

    const socksSecret = crypto.randomBytes(32).toString('hex')
    const socksServer = await startServer({
      mode: 'server',
      masterSecret: socksSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      socks: {
        enabled: true,
        allow: [`127.0.0.1:${echoPort}`, `127.0.0.1:${webPort}`]
      },
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'socks-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'socks-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'socks-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('socks'),
      controlTokenPath: path.join(tempDir, 'control-socks.token')
    })
    extraServers.push(socksServer)

    const socksBase = { ...clientBase, masterSecret: socksSecret }
    const socksClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: socksBase, socksPort: 0 }
    )
    assert.equal(socksClient.mode, 'socks')

    const socksOk = await socksHandshake(socksClient.address().port, '127.0.0.1', echoPort)
    assert.equal(socksOk.code, 0)
    assert.deepEqual(
      await readExactly(socksOk.socket, echoBanner.length, 15_000),
      echoBanner
    )
    const socksPayload = crypto.randomBytes(48)
    socksOk.socket.write(socksPayload)
    assert.deepEqual(
      await readExactly(socksOk.socket, socksPayload.length, 15_000),
      socksPayload
    )
    socksOk.socket.destroy()
    checks.push('SOCKS5 CONNECT reaches an allowlisted destination')

    const socksDomain = await socksHandshake(
      socksClient.address().port,
      'localhost',
      echoPort
    )
    assert.equal(socksDomain.code, 0)
    assert.deepEqual(
      await readExactly(socksDomain.socket, echoBanner.length, 15_000),
      echoBanner
    )
    socksDomain.socket.destroy()
    checks.push('SOCKS5 resolves a hostname and checks the resolved IP')

    const socksDenied = await socksHandshake(socksClient.address().port, '127.0.0.1', 1)
    assert.equal(socksDenied.code, 2)
    socksDenied.socket.destroy()
    checks.push('SOCKS5 denies a destination outside the allowlist')
    await socksClient.close()
    await socksServer.close()

    // A per-client list replaces the global allowlist for that key.
    const perClientSecret = crypto.randomBytes(32).toString('hex')
    const perClientServer = await startServer({
      mode: 'server',
      masterSecret: perClientSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      socks: {
        enabled: true,
        allow: [`127.0.0.1:${echoPort}`],
        perClient: {
          [unauthorizedKey.publicKey]: ['127.0.0.1:1']
        }
      },
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'sockspc-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'sockspc-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'sockspc-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('sockspc'),
      controlTokenPath: path.join(tempDir, 'control-sockspc.token')
    })
    extraServers.push(perClientServer)

    const perClientBase = { ...clientBase, masterSecret: perClientSecret }
    const restrictedClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: perClientBase, socksPort: 0 }
    )
    const restrictedResult = await socksHandshake(
      restrictedClient.address().port,
      '127.0.0.1',
      echoPort
    )
    assert.equal(restrictedResult.code, 2)
    restrictedResult.socket.destroy()
    await restrictedClient.close()

    const unrestrictedClient = await startTestClient(
      secondKeyPath,
      unattendedPassword,
      { base: perClientBase, socksPort: 0 }
    )
    const unrestrictedResult = await socksHandshake(
      unrestrictedClient.address().port,
      '127.0.0.1',
      echoPort
    )
    assert.equal(unrestrictedResult.code, 0)
    assert.deepEqual(
      await readExactly(unrestrictedResult.socket, echoBanner.length, 15_000),
      echoBanner
    )
    unrestrictedResult.socket.destroy()
    await unrestrictedClient.close()
    await perClientServer.close()
    checks.push('SOCKS per-client allowlist overrides the global list')

    const noSocksSecret = crypto.randomBytes(32).toString('hex')
    const noSocksServer = await startServer({
      mode: 'server',
      masterSecret: noSocksSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'nosocks-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'nosocks-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'nosocks-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('nosocks'),
      controlTokenPath: path.join(tempDir, 'control-nosocks.token')
    })
    extraServers.push(noSocksServer)

    const noSocksClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: { ...clientBase, masterSecret: noSocksSecret }, socksPort: 0 }
    )
    const noSocksResult = await socksHandshake(
      noSocksClient.address().port,
      '127.0.0.1',
      echoPort
    )
    assert.equal(noSocksResult.code, 2)
    noSocksResult.socket.destroy()
    checks.push('SOCKS5 is refused when the server has it disabled')
    await noSocksClient.close()
    await noSocksServer.close()

    // ---------------------------------------------------------------------
    // 10d-6. UDP forwarding over the tunnel
    // ---------------------------------------------------------------------
    const udpEcho = dgram.createSocket('udp4')
    udpEcho.on('message', (message, rinfo) => {
      udpEcho.send(message, rinfo.port, rinfo.address)
    })
    await new Promise((resolve, reject) => {
      udpEcho.once('error', reject)
      udpEcho.bind({ address: '127.0.0.1', port: 0 }, resolve)
    })
    const udpEchoPort = udpEcho.address().port

    const udpSecret = crypto.randomBytes(32).toString('hex')
    const udpServer = await startServer({
      mode: 'server',
      masterSecret: udpSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      udpTargets: { echo: { host: '127.0.0.1', port: udpEchoPort } },
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'udp-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'udp-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'udp-lockout.json'),
      authTimeoutMs: 4_000,
      udpIdleTimeoutMs: 500,
      interactive: false,
      controlSocketPath: controlPathFor('udp'),
      controlTokenPath: path.join(tempDir, 'control-udp.token')
    })
    extraServers.push(udpServer)

    const udpClient = await startClient(
      { ...clientBase, masterSecret: udpSecret, clientKeyPath: unauthorizedKeyPath },
      {
        log: quiet,
        credential: unattendedPassword,
        udpTarget: 'echo',
        udpListen: 0,
        udpIdleTimeoutMs: 500,
        connectTimeoutMs: 7_000,
        authTimeoutMs: 4_000,
        now: () => serverNow,
        dhtOptions: { bootstrap }
      }
    )
    clients.push(udpClient)
    assert.equal(udpClient.mode, 'udp')

    const udpApp = dgram.createSocket('udp4')

    const sendUdp = (payload, timeoutMs = 8_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('udp timeout')), timeoutMs)

      const onMessage = (message) => {
        clearTimeout(timer)
        udpApp.removeListener('message', onMessage)
        resolve(message)
      }

      udpApp.once('message', onMessage)
      udpApp.send(payload, udpClient.address().port, '127.0.0.1')
    })

    const udpPayload = crypto.randomBytes(64)
    assert.deepEqual(await sendUdp(udpPayload), udpPayload)
    checks.push('UDP datagrams are forwarded through the tunnel')

    const oversized = crypto.randomBytes(1400)
    let oversizedReply = null
    try {
      oversizedReply = await sendUdp(oversized, 1_200)
    } catch {
      oversizedReply = null
    }
    assert.equal(oversizedReply, null)
    checks.push('UDP datagrams above the limit are dropped')

    udpApp.close()
    await udpClient.close()
    await udpServer.close()
    udpEcho.close()

    // ---------------------------------------------------------------------
    // 10e. Doctor and trusted-device expiry enforcement
    // ---------------------------------------------------------------------
    const doctorConfigPath = path.join(tempDir, 'doctor-server.json')
    await fs.writeFile(
      doctorConfigPath,
      JSON.stringify(serverConfig, null, 2),
      { mode: 0o600 }
    )
    try {
      await fs.chmod(doctorConfigPath, 0o600)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    let doctorText = ''
    const doctorResult = await runDoctor({
      configPath: doctorConfigPath,
      output: {
        write(chunk) {
          doctorText += String(chunk)
          return true
        }
      }
    })

    assert.ok(Array.isArray(doctorResult.lines))
    assert.equal(typeof doctorResult.exitCode, 'number')
    assert.ok(doctorResult.lines.length > 0)
    assert.ok(doctorText.includes('p2pgate doctor'))
    assert.ok(doctorResult.lines.some((line) => line.startsWith('✅')))
    assert.ok(!doctorText.includes(masterSecret), 'doctor must never print the master secret')
    checks.push('doctor produces structured checks without crashing or printing secrets')

    let doctorJsonText = ''
    const doctorJsonResult = await runDoctor({
      configPath: doctorConfigPath,
      json: true,
      output: {
        write(chunk) {
          doctorJsonText += String(chunk)
          return true
        }
      }
    })
    const doctorJson = JSON.parse(doctorJsonText)
    assert.equal(doctorJson.exitCode, doctorJsonResult.exitCode)
    assert.equal(typeof doctorJson.ok, 'boolean')
    assert.ok(Array.isArray(doctorJson.checks))
    assert.ok(doctorJson.checks.some((check) => check.level === 'ok'))
    assert.equal(doctorJsonText.includes(masterSecret), false)
    checks.push('doctor --json returns machine-readable checks')

    assert.equal(validateDeviceAddOptions({ profile: 'trusted' }).ok, false)
    assert.equal(
      validateDeviceAddOptions({
        profile: 'trusted',
        expires: '2027-01-01T00:00:00Z'
      }).ok,
      true
    )
    assert.equal(validateDeviceAddOptions({ profile: 'trusted', permanent: true }).ok, true)
    assert.equal(validateDeviceAddOptions({ profile: 'scram', permanent: true }).ok, false)
    assert.equal(
      validateDeviceAddOptions({
        profile: 'trusted',
        expires: '2027-01-01T00:00:00Z',
        permanent: true
      }).ok,
      false
    )
    checks.push('trusted device add requires --expires or --permanent')

    // ---------------------------------------------------------------------
    // 11. Zero-drop hourly rotation
    // ---------------------------------------------------------------------
    serverNow += 3_600_000

    await waitFor(
      () => {
        const slots = gateway.listeningSlots
        return slots.length === 2 && slots[0] === slot && slots[1] === slot + 1
      },
      15_000,
      'the server to rotate to the new hourly slot'
    )

    assert.equal(gateway.listeningSlots.includes(slot - 1), false)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const rotationPayload = crypto.randomBytes(512)
    originalSocket.write(rotationPayload)
    assert.deepEqual(
      await readExactly(originalSocket, rotationPayload.length, 15_000),
      rotationPayload,
      'existing session must survive listener rotation'
    )
    checks.push('hourly rotation closes the expired listener without dropping the live session')

    // ---------------------------------------------------------------------
    // 12. Audit log integration
    // ---------------------------------------------------------------------
    let auditEvents = new Set()
    await waitFor(async () => {
      try {
        const raw = await fs.readFile(auditPath, 'utf8')
        auditEvents = new Set(
          raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).event)
        )
        return auditEvents.has('control.revoke') && auditEvents.has('auth.failure')
      } catch {
        return false
      }
    }, 5_000, 'the audit log to contain auth and control events')

    const auditRaw = await fs.readFile(auditPath, 'utf8')
    for (const event of [
      'server.start',
      'auth.success',
      'auth.fastpath',
      'auth.failure',
      'auth.declined',
      'control.revoke',
      'session.pin.rotate'
    ]) {
      assert.ok(auditEvents.has(event), `audit log must contain ${event}`)
    }
    assert.equal(auditRaw.includes(masterSecret), false)
    assert.equal(auditRaw.includes(unattendedPassword), false)
    assert.equal(auditRaw.includes(gateway.sessionPin), false)
    checks.push('audit log records auth/control events without secrets')

    // --ttl closes the server on its own
    const ttlSecret = crypto.randomBytes(32).toString('hex')
    const ttlControlPath = controlPathFor('ttl')
    await startServer({
      mode: 'server',
      masterSecret: ttlSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'ttl-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'ttl-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'ttl-lockout.json'),
      interactive: false,
      ttlMs: 400,
      controlSocketPath: ttlControlPath,
      controlTokenPath: path.join(tempDir, 'control-ttl.token')
    })

    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const ttlSocketExists = await fs.stat(ttlControlPath).then(() => true).catch(() => false)
    assert.equal(ttlSocketExists, false)
    checks.push('server --ttl closes itself and removes the control socket')

    // mux framing round-trip
    const muxFrames = []
    const muxParser = new MuxFrameParser((frame) => muxFrames.push(frame))
    muxParser.push(encodeMuxFrame(MUX_TYPE.DATA, 0, 7, Buffer.from('abc')))
    assert.equal(muxFrames.length, 1)
    assert.equal(muxFrames[0].type, MUX_TYPE.DATA)
    assert.equal(muxFrames[0].channelId, 7)
    assert.equal(muxFrames[0].payload.toString(), 'abc')
    checks.push('mux framing round-trips a frame')

    // fast-path peek: line + trailing bytes, payload without newline, oversized input
    const peekStream = new PassThrough()
    const peekResult = peekControlLine(peekStream, { timeoutMs: 50, maxBytes: 512 })
    peekStream.write('{"v":3,"mux":{"version":1}}\nrest')
    const peeked = await peekResult
    assert.equal(peeked.line, '{"v":3,"mux":{"version":1}}')
    assert.equal(peeked.leftover.toString(), 'rest')
    checks.push('peekControlLine returns the line and trailing bytes')

    const payloadStream = new PassThrough()
    const payloadResult = peekControlLine(payloadStream, { timeoutMs: 30, maxBytes: 512 })
    payloadStream.write(Buffer.from('{"a":1}'))
    const payloadPeek = await payloadResult
    assert.equal(payloadPeek.line, null)
    assert.equal(payloadPeek.leftover.toString(), '{"a":1}')
    checks.push('peekControlLine keeps newline-less payload as leftover')

    const bigStream = new PassThrough()
    const bigResult = peekControlLine(bigStream, { timeoutMs: 30, maxBytes: 512 })
    bigStream.write(Buffer.alloc(600, 0x41))
    const bigPeek = await bigResult
    assert.equal(bigPeek.line, null)
    assert.equal(bigPeek.leftover.length, 600)
    checks.push('peekControlLine stops at the byte limit and keeps the payload')

    assert.equal(resolveMuxEnabled({}, { mux: true }, true), true)
    assert.equal(resolveMuxEnabled({}, { mux: true }, false), false)
    assert.equal(resolveMuxEnabled({ mux: false }, { mux: true }, true), false)
    assert.equal(resolveMuxEnabled({}, { mux: false }, true), false)
    assert.equal(resolveMuxEnabled({ mux: true }, { mux: false }, false), true)
    checks.push('mux defaults on for socks5, off for plain tunnels, --no-mux wins')

    // mux backpressure: a full window must stop accepting and later drain
    const unitFrames = []
    const unitStream = new EventEmitter()
    unitStream.destroyed = false
    unitStream.write = (buffer) => {
      unitFrames.push(buffer)
      return true
    }
    unitStream.destroy = () => {
      unitStream.destroyed = true
    }

    const unitCarrier = new MuxCarrier(unitStream)
    const pendingUnitChannel = unitCarrier.openChannel({})
    unitCarrier._onFrame({
      type: MUX_TYPE.OPEN_OK,
      flags: 0,
      channelId: 1,
      payload: encodeMuxJson({})
    })
    const unitChannel = await pendingUnitChannel

    const oversizedWindow = Buffer.alloc(CHANNEL_WINDOW + 8 * 1024)
    assert.equal(unitChannel.write(oversizedWindow), false)
    assert.equal(unitChannel.queuedBytes, 8 * 1024)

    const dataFrames = unitFrames.filter((frame) => frame.readUInt8(0) === MUX_TYPE.DATA)
    assert.equal(dataFrames.length, CHANNEL_WINDOW / MAX_FRAME)

    await new Promise((resolve) => {
      unitChannel.once('drain', resolve)
      unitCarrier._onFrame({
        type: MUX_TYPE.WINDOW,
        flags: 0,
        channelId: 1,
        payload: encodeMuxUInt32(8 * 1024)
      })
    })
    assert.equal(unitChannel.queuedBytes, 0)
    checks.push('mux channel applies backpressure and drains')

    // half-close must not drop queued bytes
    const countClose = () => unitFrames.filter(
      (frame) => frame.readUInt8(0) === MUX_TYPE.CLOSE
    ).length

    unitChannel.write(Buffer.alloc(32 * 1024))
    unitChannel.end()
    assert.equal(countClose(), 0)

    unitCarrier._onFrame({
      type: MUX_TYPE.WINDOW,
      flags: 0,
      channelId: 1,
      payload: encodeMuxUInt32(32 * 1024)
    })
    assert.equal(countClose(), 1)
    checks.push('mux half-close waits for queued data')
    unitChannel.on('error', () => {})
    unitCarrier.close()

    assert.ok(MAX_CARRIERS > 0 && MAX_TOTAL_CHANNELS > 0)

    // mux over a challenged session
    const muxSecret = crypto.randomBytes(32).toString('hex')
    const muxControlPath = controlPathFor('mux')
    const muxServer = await startServer({
      mode: 'server',
      masterSecret: muxSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'mux-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'mux-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'mux-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: muxControlPath,
      controlTokenPath: path.join(tempDir, 'control-mux.token')
    })
    extraServers.push(muxServer)

    const muxClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: { ...clientBase, masterSecret: muxSecret }, mux: true }
    )
    const muxPayload = crypto.randomBytes(64)
    assert.deepEqual(await echoThrough(muxClient, muxPayload), muxPayload)
    assert.equal(muxClient.muxActive, true)
    checks.push('mux carrier serves a challenged session')

    const muxBulk = crypto.randomBytes(1024 * 1024)
    assert.deepEqual(await echoThrough(muxClient, muxBulk), muxBulk)
    checks.push('mux carries a 1 MiB transfer intact')

    const muxCompressAttempt = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: { ...clientBase, masterSecret: muxSecret }, mux: true, compress: true }
    )
    const muxPlainBody = crypto.randomBytes(8 * 1024)
    assert.deepEqual(await echoThrough(muxCompressAttempt, muxPlainBody), muxPlainBody)
    checks.push('compression request falls back when the server disables it')
    await muxCompressAttempt.close()

    const muxParallel = await Promise.all(
      [0, 1, 2, 3].map(() => echoThrough(muxClient, crypto.randomBytes(96 * 1024)))
    )
    for (const body of muxParallel) assert.equal(body.length, 96 * 1024)
    checks.push('mux serves parallel channels over one carrier')

    const muxToken = await readControlToken(muxServer.controlTokenPath)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const muxStatus = await sendControlCommand(
      muxControlPath,
      { v: CONTROL_VERSION, cmd: 'status' },
      { token: muxToken }
    )
    assert.equal(muxStatus.ok, true)
    assert.equal(muxStatus.traffic.mux.carriers, 1)
    assert.equal(muxStatus.traffic.mux.channels, 0)
    checks.push('status reports mux carriers and channels')

    await muxClient.close()
    await muxServer.close()

    // compression: negotiated per mux channel, must be enabled on both ends
    assert.equal(pickAlgorithm(['zstd', 'gzip'], ['gzip']), 'gzip')
    assert.equal(pickAlgorithm(['zstd'], ['gzip']), null)
    assert.equal(normalizeCompressConfig(false).enabled, false)
    assert.equal(normalizeCompressConfig(true).enabled, true)
    assert.equal(normalizeCompressConfig('auto').mode, 'auto')
    assert.equal(sampleCompressible(Buffer.from('compress me\n'.repeat(4000))), true)
    assert.equal(sampleCompressible(crypto.randomBytes(8192)), false)

    {
      const fake = new PassThrough()
      const trips = []
      const guard = guardDecompressor(
        fake,
        { maxOutputBytes: 100, maxRatio: 1e9, minRatioBytes: 0 },
        (code) => trips.push(code)
      )
      guard.countInput(1000)
      fake.write(Buffer.alloc(200))
      assert.deepEqual(trips, ['COMPRESS_OUTPUT_LIMIT'])

      const fake2 = new PassThrough()
      const trips2 = []
      const guard2 = guardDecompressor(
        fake2,
        { maxOutputBytes: 1e9, maxRatio: 10, minRatioBytes: 100 },
        (code) => trips2.push(code)
      )
      guard2.countInput(100)
      fake2.write(Buffer.alloc(2000))
      assert.deepEqual(trips2, ['COMPRESS_RATIO_LIMIT'])
    }
    checks.push('compress negotiation picks a shared algorithm')

    const compressSecret = crypto.randomBytes(32).toString('hex')
    const compressControlPath = controlPathFor('compress')
    const compressServer = await startServer({
      mode: 'server',
      masterSecret: compressSecret,
      authMode: 'password',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'compress-server-key.json'),
      allowedClientKeys: [],
      verificationMode: 'hybrid',
      trustedDevicesFile: path.join(tempDir, 'compress-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: true, unattended: unattendedVerifier },
      telegramAlert: { enabled: false, botToken: '', chatId: '' },
      compress: { enabled: true, algorithms: ['zstd', 'gzip'] }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'compress-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: compressControlPath,
      controlTokenPath: path.join(tempDir, 'control-compress.token')
    })
    extraServers.push(compressServer)

    const compressClient = await startTestClient(
      unauthorizedKeyPath,
      unattendedPassword,
      { base: { ...clientBase, masterSecret: compressSecret }, mux: true, compress: true }
    )

    const compressible = Buffer.from('p2pgate compression check line\n'.repeat(4096))
    let compressWire = 0
    const originalMuxSend = MuxCarrier.prototype._send
    MuxCarrier.prototype._send = function (type, flags, channelId, payload) {
      if (type === MUX_TYPE.DATA) compressWire += payload.length
      return originalMuxSend.call(this, type, flags, channelId, payload)
    }

    let compressEchoed = null
    try {
      compressEchoed = await echoThrough(compressClient, compressible)
    } finally {
      MuxCarrier.prototype._send = originalMuxSend
    }

    assert.deepEqual(compressEchoed, compressible)
    assert.ok(compressWire > 0)
    assert.ok(
      compressWire < compressible.length / 2,
      `compressed wire ${compressWire} should be under half of ${compressible.length}`
    )
    checks.push('compressed mux channel round-trips and saves bytes')

    const randomBody = crypto.randomBytes(256 * 1024)
    assert.deepEqual(await echoThrough(compressClient, randomBody), randomBody)
    checks.push('compressed mux channel keeps incompressible data intact')

    const echoWriteFirst = async (client, payload) => {
      const socket = await connectLocal(client.address().port)
      socket.write(payload)
      const banner = await readExactly(socket, echoBanner.length, 15_000)
      assert.deepEqual(banner, echoBanner)
      const echoed = await readExactly(socket, payload.length, 15_000)
      socket.destroy()
      return echoed
    }

    const autoOffLogs = []
    const autoOff = await startTestClient(unauthorizedKeyPath, unattendedPassword, {
      base: { ...clientBase, masterSecret: compressSecret },
      mux: true,
      compress: 'auto',
      log: (line) => autoOffLogs.push(String(line))
    })
    const autoBinary = crypto.randomBytes(256 * 1024)
    assert.deepEqual(await echoWriteFirst(autoOff, autoBinary), autoBinary)
    assert.ok(autoOffLogs.some((line) => line.includes('compress auto=off')))
    checks.push('compress auto disables itself for incompressible data')
    await autoOff.close()

    const autoOnLogs = []
    const autoOn = await startTestClient(unauthorizedKeyPath, unattendedPassword, {
      base: { ...clientBase, masterSecret: compressSecret },
      mux: true,
      compress: 'auto',
      log: (line) => autoOnLogs.push(String(line))
    })
    const autoText = Buffer.from('compressible mux channel line\n'.repeat(8192))
    assert.deepEqual(await echoWriteFirst(autoOn, autoText), autoText)
    assert.ok(autoOnLogs.some((line) => line.includes('compress auto=on')))
    checks.push('compress auto enables itself for compressible data')
    await autoOn.close()

    // non-mux: compression is negotiated in the auth proof / fast-path control line
    const nonMuxLogs = []
    const nonMuxClient = await startTestClient(unauthorizedKeyPath, unattendedPassword, {
      base: { ...clientBase, masterSecret: compressSecret },
      mux: false,
      compress: true,
      log: (line) => nonMuxLogs.push(String(line))
    })
    const nonMuxBody = Buffer.from('non-mux compressed line\n'.repeat(8192))
    assert.deepEqual(await echoThrough(nonMuxClient, nonMuxBody), nonMuxBody)
    assert.ok(nonMuxLogs.some((line) => line.includes('COMPRESS ')))
    checks.push('non-mux tunnel negotiates compression in the auth proof')
    await nonMuxClient.close()

    await compressClient.close()
    await compressServer.close()

    // fast-path cannot negotiate mux: must fall back, not break
    const fastMuxSecret = crypto.randomBytes(32).toString('hex')
    const fastMuxControlPath = controlPathFor('muxfast')
    const fastMuxKey = await loadClientKey(unauthorizedKeyPath)

    // second target with a distinct banner, to prove --target routing on fast path
    const altServer = net.createServer((socket) => {
      socket.on('error', noop)
      socket.write('ALT-TARGET\n')
      socket.pipe(socket)
    })
    await new Promise((resolve) => altServer.listen(0, '127.0.0.1', resolve))
    const altPort = altServer.address().port

    const fastMuxServer = await startServer({
      mode: 'server',
      masterSecret: fastMuxSecret,
      authMode: 'registry',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      targets: {
        default: { host: '127.0.0.1', port: echoPort },
        alt: { host: '127.0.0.1', port: altPort }
      },
      defaultTarget: 'default',
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'muxfast-server-key.json'),
      allowedClientKeys: [fastMuxKey.publicKey],
      verificationMode: 'key-only',
      trustedDevicesFile: path.join(tempDir, 'muxfast-devices'),
      socks: { enabled: true, allow: [`127.0.0.1:${echoPort}`] },
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: false, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'muxfast-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: fastMuxControlPath,
      controlTokenPath: path.join(tempDir, 'control-muxfast.token')
    })
    extraServers.push(fastMuxServer)

    const fastMuxClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: fastMuxSecret },
        mux: true
      }
    )
    const fastMuxPayload = crypto.randomBytes(32)
    assert.deepEqual(await echoThrough(fastMuxClient, fastMuxPayload), fastMuxPayload)
    assert.equal(fastMuxClient.muxActive, true)
    checks.push('mux works on a fast-path session')
    await fastMuxClient.close()

    // A non-mux client on the same server must have its payload forwarded verbatim,
    // including a first byte of "{" that must not be mistaken for an upgrade.
    const fastPlainClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      { base: { ...clientBase, masterSecret: fastMuxSecret }, mux: false }
    )
    const jsonPayload = Buffer.from('{"a":1}\n')
    assert.deepEqual(await echoThrough(fastPlainClient, jsonPayload), jsonPayload)
    assert.equal(fastPlainClient.muxActive, false)
    checks.push('fast-path peek forwards payload that starts with {')

    // Regression guard: an SSH client writes its banner immediately, i.e. inside
    // the peek window. The peek must forward the whole line, not just the tail.
    const immediateSocket = await connectLocal(fastPlainClient.address().port)
    immediateSocket.write('SSH-2.0-TEST\r\n')
    assert.deepEqual(
      await readExactly(immediateSocket, echoBanner.length, 15_000),
      echoBanner
    )
    const immediateEcho = await readExactly(
      immediateSocket,
      Buffer.byteLength('SSH-2.0-TEST\r\n'),
      15_000
    )
    assert.equal(immediateEcho.toString(), 'SSH-2.0-TEST\r\n')
    immediateSocket.destroy()
    checks.push('fast-path peek forwards an immediate line payload (SSH banner)')

    // A payload line with more bytes after the newline inside the peek window used to
    // lose everything after the first newline (65 KB of a 64 MiB transfer).
    const multiLine = Buffer.from('line-one\nline-two\n'.repeat(2048))
    const multiSocket = await connectLocal(fastPlainClient.address().port)
    multiSocket.write(multiLine)
    assert.deepEqual(
      await readExactly(multiSocket, echoBanner.length, 15_000),
      echoBanner
    )
    assert.deepEqual(
      await readExactly(multiSocket, multiLine.length, 15_000),
      multiLine
    )
    multiSocket.destroy()
    checks.push('fast-path peek keeps payload bytes after the first newline')
    await fastPlainClient.close()

    // --target must be honored on the fast path. It used to fall back to
    // defaultTarget because the target only travelled inside the SCRAM proof.
    const altClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: fastMuxSecret },
        mux: false,
        target: 'alt'
      }
    )
    const altSocket = await connectLocal(altClient.address().port)
    assert.equal(
      (await readExactly(altSocket, Buffer.byteLength('ALT-TARGET\n'), 15_000)).toString(),
      'ALT-TARGET\n'
    )
    altSocket.destroy()
    checks.push('fast-path --target reaches the requested target')
    await altClient.close()

    const badTargetClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: fastMuxSecret },
        mux: false,
        target: 'nope'
      }
    )
    const badSocket = await connectLocal(badTargetClient.address().port)
    const badClosed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000)
      badSocket.on('close', () => { clearTimeout(timer); resolve(true) })
      badSocket.on('error', () => {})
    })
    assert.equal(badClosed, true)
    checks.push('fast-path rejects an unknown target instead of using the default')
    await badTargetClient.close()

    // A server with the peek disabled cannot accept target requests; the client
    // must fail loudly instead of using defaultTarget.
    const noPeekSecret = crypto.randomBytes(32).toString('hex')
    const noPeekServer = await startServer({
      mode: 'server',
      masterSecret: noPeekSecret,
      authMode: 'registry',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      targets: {
        default: { host: '127.0.0.1', port: echoPort },
        alt: { host: '127.0.0.1', port: altPort }
      },
      defaultTarget: 'default',
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'nopeek-server-key.json'),
      allowedClientKeys: [fastMuxKey.publicKey],
      verificationMode: 'key-only',
      trustedDevicesFile: path.join(tempDir, 'nopeek-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: false, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' },
      muxPeekMs: 0
    }, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'nopeek-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('nopeek'),
      controlTokenPath: path.join(tempDir, 'control-nopeek.token')
    })
    extraServers.push(noPeekServer)

    const noPeekClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: noPeekSecret },
        mux: false,
        target: 'alt'
      }
    )
    const noPeekSocket = await connectLocal(noPeekClient.address().port)
    const noPeekClosed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8_000)
      noPeekSocket.on('close', () => { clearTimeout(timer); resolve(true) })
      noPeekSocket.on('error', () => {})
    })
    assert.equal(noPeekClosed, true)
    checks.push('fast-path --target fails when the server has no peek')
    await noPeekClient.close()
    await noPeekServer.close()

    // ---------------------------------------------------------------------
    // fast-path matrix: every user-selectable combination on the path that
    // real deployments use most (trusted device). Both fast-path regressions
    // fixed in 1.13.2/1.13.3 hid here, so each combo is asserted explicitly.
    // ---------------------------------------------------------------------

    // mux + target + a large transfer
    const muxTargetClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: fastMuxSecret },
        mux: true,
        target: 'alt'
      }
    )
    assert.equal(muxTargetClient.muxActive, false) // carrier opens on first connection
    const muxTargetSocket = await connectLocal(muxTargetClient.address().port)
    assert.equal(
      (await readExactly(muxTargetSocket, Buffer.byteLength('ALT-TARGET\n'), 15_000)).toString(),
      'ALT-TARGET\n'
    )
    const muxTargetBody = crypto.randomBytes(1024 * 1024)
    muxTargetSocket.write(muxTargetBody)
    assert.deepEqual(
      await readExactly(muxTargetSocket, muxTargetBody.length, 20_000),
      muxTargetBody
    )
    muxTargetSocket.destroy()
    assert.equal(muxTargetClient.muxActive, true)
    checks.push('fast-path matrix: mux + target + 1 MiB')
    await muxTargetClient.close()

    // no-mux + target + payload written before the target banner (SSH style)
    const eagerTargetClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: fastMuxSecret },
        mux: false,
        target: 'alt'
      }
    )
    const eagerSocket = await connectLocal(eagerTargetClient.address().port)
    eagerSocket.write('SSH-2.0-MATRIX\r\n')
    assert.equal(
      (await readExactly(eagerSocket, Buffer.byteLength('ALT-TARGET\n'), 15_000)).toString(),
      'ALT-TARGET\n'
    )
    assert.equal(
      (await readExactly(eagerSocket, Buffer.byteLength('SSH-2.0-MATRIX\r\n'), 15_000)).toString(),
      'SSH-2.0-MATRIX\r\n'
    )
    eagerSocket.destroy()
    checks.push('fast-path matrix: no-mux + target + eager line payload')
    await eagerTargetClient.close()

    // no-mux + binary payload that arrives inside the peek window
    const binaryClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      { base: { ...clientBase, masterSecret: fastMuxSecret }, mux: false }
    )
    const binarySocket = await connectLocal(binaryClient.address().port)
    const binaryPayload = Buffer.from([0x00, 0xff, 0x01, 0x02])
    binarySocket.write(binaryPayload)
    assert.deepEqual(
      await readExactly(binarySocket, echoBanner.length, 15_000),
      echoBanner
    )
    assert.deepEqual(
      await readExactly(binarySocket, binaryPayload.length, 15_000),
      binaryPayload
    )
    binarySocket.destroy()
    checks.push('fast-path matrix: no-mux + binary payload inside the peek')
    await binaryClient.close()

    // mux + two parallel connections on one carrier
    const parallelFastClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      { base: { ...clientBase, masterSecret: fastMuxSecret }, mux: true }
    )
    const parallelBodies = await Promise.all([0, 1].map(async () => {
      const s = await connectLocal(parallelFastClient.address().port)
      await readExactly(s, echoBanner.length, 15_000)
      const body = crypto.randomBytes(64 * 1024)
      s.write(body)
      const echo = await readExactly(s, body.length, 20_000)
      s.destroy()
      return echo.equals(body)
    }))
    assert.deepEqual(parallelBodies, [true, true])
    assert.equal(parallelFastClient.muxActive, true)
    checks.push('fast-path matrix: mux + parallel channels')
    await parallelFastClient.close()

    // socks + mux default (the exact combination that used to break) and --no-mux
    for (const variant of [
      { name: 'mux default', options: { socksPort: 0 } },
      { name: 'no-mux', options: { socksPort: 0, mux: false } }
    ]) {
      const socksFast = await startTestClient(
        unauthorizedKeyPath,
        undefined,
        { base: { ...clientBase, masterSecret: fastMuxSecret }, ...variant.options }
      )
      const handshake = await socksHandshake(socksFast.address().port, '127.0.0.1', echoPort)
      assert.equal(handshake.code, 0)
      assert.deepEqual(await readExactly(handshake.socket, echoBanner.length, 15_000), echoBanner)
      const body = crypto.randomBytes(32 * 1024)
      handshake.socket.write(body)
      assert.deepEqual(await readExactly(handshake.socket, body.length, 15_000), body)
      handshake.socket.destroy()
      checks.push(`fast-path matrix: socks + ${variant.name}`)
      await socksFast.close()
    }

    await fastMuxServer.close()

    // Server with mux disabled must not advertise it; the client falls back once.
    const noMuxSecret = crypto.randomBytes(32).toString('hex')
    const noMuxConfig = {
      mode: 'server',
      masterSecret: noMuxSecret,
      authMode: 'registry',
      targetHost: '127.0.0.1',
      targetPort: echoPort,
      targets: {
        default: { host: '127.0.0.1', port: echoPort },
        alt: { host: '127.0.0.1', port: altPort }
      },
      defaultTarget: 'default',
      localPort: 8022,
      clientKeyPath: path.join(tempDir, 'nomux-server-key.json'),
      allowedClientKeys: [fastMuxKey.publicKey],
      verificationMode: 'key-only',
      mux: false,
      trustedDevicesFile: path.join(tempDir, 'nomux-devices'),
      auditLog: { enabled: false },
      customBootstrap: bootstrap,
      authPin: { enabled: false, unattended: null },
      telegramAlert: { enabled: false, botToken: '', chatId: '' }
    }
    const noMuxServer = await startServer(noMuxConfig, {
      log: quiet,
      showSessionPin: false,
      sendStartupAlert: false,
      failDelayMs: [10, 20],
      lockoutStatePath: path.join(tempDir, 'nomux-lockout.json'),
      authTimeoutMs: 4_000,
      interactive: false,
      controlSocketPath: controlPathFor('nomux'),
      controlTokenPath: path.join(tempDir, 'control-nomux.token')
    })
    extraServers.push(noMuxServer)

    const noMuxClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      { base: { ...clientBase, masterSecret: noMuxSecret }, mux: true }
    )
    const noMuxPayload = crypto.randomBytes(32)
    assert.deepEqual(await echoThrough(noMuxClient, noMuxPayload), noMuxPayload)
    assert.equal(noMuxClient.muxActive, false)
    checks.push('mux is not advertised when the server disables it')
    await noMuxClient.close()

    // Target requests must work even when mux is disabled server-side.
    const noMuxTargetClient = await startTestClient(
      unauthorizedKeyPath,
      undefined,
      {
        base: { ...clientBase, masterSecret: noMuxSecret },
        mux: false,
        target: 'alt'
      }
    )
    const noMuxTargetSocket = await connectLocal(noMuxTargetClient.address().port)
    assert.equal(
      (await readExactly(noMuxTargetSocket, Buffer.byteLength('ALT-TARGET\n'), 15_000)).toString(),
      'ALT-TARGET\n'
    )
    noMuxTargetSocket.destroy()
    checks.push('fast-path matrix: mux disabled server still routes --target')
    await noMuxTargetClient.close()

    altServer.close()
    await noMuxServer.close()
  } finally {
    if (originalSocket) {
      try {
        originalSocket.destroy()
      } catch {
        // Ignore.
      }
    }

    for (const activeClient of clients) {
      try {
        await activeClient.close()
      } catch {
        // Ignore cleanup errors.
      }
    }

    for (const extraServer of extraServers) {
      try {
        await extraServer.close()
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (probeDht) {
      try {
        await probeDht.destroy()
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (gateway) {
      try {
        await gateway.close()
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (bootstrapper) {
      try {
        await bootstrapper.destroy()
      } catch {
        // Ignore cleanup errors.
      }
    }

    if (echoServer) {
      await new Promise((resolve) => echoServer.close(resolve))
    }

    await fs.rm(tempDir, { recursive: true, force: true })
  }

  process.stdout.write('\nSelf-test results:\n')
  for (const check of checks) process.stdout.write(`  ✅ ${check}\n`)
  process.stdout.write('\nSELF-TEST PASSED\n', () => process.exit(0))
}

main().catch((err) => {
  process.stderr.write(
    `\nSELF-TEST FAILED\n${err && err.stack ? err.stack : err}\n`,
    () => process.exit(1)
  )
})
