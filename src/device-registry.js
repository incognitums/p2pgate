'use strict'

const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const VERIFICATION_MODES = Object.freeze(['hybrid', 'key-only', 'two-step'])
const DEVICE_PROFILES = Object.freeze(['trusted', 'scram'])
const DEFAULT_TRUSTED_DEVICES_PATH = path.join(os.homedir(), '.p2pgate', 'trusted_devices')
const HEX_64 = /^[0-9a-f]{64}$/i
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function isHex64(value) {
  return typeof value === 'string' && HEX_64.test(value)
}

function normalizeVerificationMode(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'hybrid'
  }

  const mode = String(value).trim().toLowerCase()
  if (!VERIFICATION_MODES.includes(mode)) {
    const err = new Error('verificationMode must be hybrid, key-only, or two-step')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  return mode
}

function parseExpires(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value.trim())) {
    const err = new Error('expires must be an ISO-8601 timestamp with a timezone (e.g. 2026-12-31T23:59:59Z)')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const text = value.trim()
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) {
    const err = new Error('expires is not a valid timestamp')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  return { text, ms }
}

function parseDeviceLine(line) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return { entry: null }

  const parts = trimmed.split(/\s+/)
  let optionsToken = null
  let key = null
  let label = ''

  if (isHex64(parts[0])) {
    key = parts[0].toLowerCase()
    label = parts.slice(1).join(' ')
  } else {
    optionsToken = parts[0]
    key = parts[1]

    if (!isHex64(key)) {
      return { error: 'invalid or missing 64-char public key' }
    }

    key = key.toLowerCase()
    label = parts.slice(2).join(' ')
  }

  let profile = 'scram'
  let expires = null

  if (optionsToken) {
    let profileSeen = false

    for (const rawToken of optionsToken.split(',')) {
      const token = rawToken.trim()
      if (token === '') continue

      if (token === 'trusted' || token === 'scram') {
        if (profileSeen) return { error: 'duplicate profile option' }
        profile = token
        profileSeen = true
        continue
      }

      if (token.startsWith('expires=')) {
        if (expires) return { error: 'duplicate expires option' }
        try {
          expires = parseExpires(token.slice('expires='.length))
        } catch (err) {
          return { error: err.message }
        }
        continue
      }

      return { error: `unknown option: ${token}` }
    }
  }

  return {
    entry: {
      key,
      profile,
      label,
      expiresText: expires ? expires.text : '',
      expiresAt: expires ? expires.ms : null
    }
  }
}

function validateDeviceAddOptions({ profile = 'scram', expires = null, permanent = false } = {}) {
  if (expires && permanent) {
    return {
      ok: false,
      error: 'ใช้ --expires หรือ --permanent อย่างใดอย่างหนึ่งเท่านั้น'
    }
  }

  if (permanent && profile !== 'trusted') {
    return {
      ok: false,
      error: '--permanent ใช้ได้เฉพาะกับ --mode trusted'
    }
  }

  if (profile === 'trusted' && !expires && !permanent) {
    return {
      ok: false,
      error: 'trusted device ข้ามการถาม PIN จึงต้องระบุ --expires หรือ --permanent'
    }
  }

  return { ok: true }
}

function formatDeviceLine({ key, profile, expires, label }) {
  if (!isHex64(key)) {
    const err = new Error('public key must be 64 hexadecimal characters')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  if (!DEVICE_PROFILES.includes(profile)) {
    const err = new Error('mode must be trusted or scram')
    err.code = 'CONFIG_INVALID'
    throw err
  }

  const cleanLabel = String(label || '').trim().replace(/[\r\n]+/g, ' ')
  let optionsToken = profile

  if (expires) {
    const parsed = parseExpires(expires)
    optionsToken += `,expires=${parsed.text}`
  }

  return `${optionsToken} ${key.toLowerCase()}${cleanLabel ? ` ${cleanLabel}` : ''}`
}

function normalizePosixResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'permission-check-failed' }
  }

  return {
    ok: result.ok === true,
    reason: result.reason || (result.ok === true ? null : 'permission-check-failed')
  }
}

async function defaultPosixCheck({ path: filePath, stat }) {
  if (process.platform === 'win32') return { ok: true }

  const fileStat = stat || await fsp.lstat(filePath)

  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    return { ok: false, reason: 'not-a-regular-file' }
  }

  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
    return { ok: false, reason: 'wrong-owner' }
  }

  if ((fileStat.mode & 0o077) !== 0) {
    return { ok: false, reason: 'group-or-other-permissions' }
  }

  if ((fileStat.mode & 0o400) === 0) {
    return { ok: false, reason: 'not-readable-by-owner' }
  }

  return { ok: true }
}

/**
 * Evaluates the active verification policy for one merged registry entry.
 * This function is exported so the self-test can exercise every mode without
 * having to start three separate DHT servers.
 */
function evaluateDevicePolicy(entry, options = {}) {
  const verificationMode = normalizeVerificationMode(options.verificationMode)
  const interactive = options.interactive === true
  const hasFallback = options.hasFallback === true

  if (!entry || entry.listed !== true) {
    return { action: 'decline', reason: 'unlisted' }
  }

  if (entry.active !== true) {
    return { action: 'decline', reason: 'expired' }
  }

  if (verificationMode === 'key-only') {
    if (entry.source === 'trusted_devices' && entry.permissionsOk !== true) {
      return { action: 'decline', reason: 'insecure_registry' }
    }
    return { action: 'fastpath' }
  }

  if (verificationMode === 'two-step') {
    if (!interactive && !hasFallback) {
      return { action: 'decline', reason: 'interactive_unavailable' }
    }
    return { action: 'challenge' }
  }

  if (entry.fastpathAllowed === true) {
    return { action: 'fastpath' }
  }

  if (!interactive && !hasFallback) {
    return { action: 'decline', reason: 'interactive_unavailable' }
  }

  return { action: 'challenge' }
}

class DeviceRegistry {
  constructor(options = {}) {
    this.filePath = options.filePath
      ? path.resolve(options.filePath)
      : DEFAULT_TRUSTED_DEVICES_PATH
    this.verificationMode = normalizeVerificationMode(options.verificationMode)
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.posixCheck = typeof options.posixCheck === 'function'
      ? options.posixCheck
      : defaultPosixCheck
    this.configEntries = new Map()

    for (const key of options.configKeys || []) {
      if (!isHex64(key)) continue
      const normalized = key.toLowerCase()
      this.configEntries.set(normalized, {
        key: normalized,
        source: 'config',
        profile: 'scram',
        label: '',
        expiresText: '',
        expiresAt: null,
        permissionsOk: true,
        alsoInConfig: true
      })
    }

    this.fileEntries = new Map()
    this.merged = new Map()
    this.fileExists = false
    this.permissionsOk = true
    this.permissionsError = null
    this.loadedMtimeMs = -1
    this.loadedMode = -1
    this.loadedUid = -1
    this._merge()
  }

  async init() {
    await this.refreshIfChanged(true)
  }

  async close() {
    // No persistent resources.
  }

  get size() {
    return this.merged.size
  }

  isEmpty() {
    return this.merged.size === 0
  }

  _merge() {
    const merged = new Map()

    for (const [key, entry] of this.configEntries) {
      merged.set(key, { ...entry })
    }

    for (const [key, entry] of this.fileEntries) {
      merged.set(key, {
        ...entry,
        source: 'trusted_devices',
        permissionsOk: this.permissionsOk,
        alsoInConfig: this.configEntries.has(key)
      })
    }

    this.merged = merged
  }

  _decorate(entry) {
    if (!entry) {
      return {
        listed: false,
        active: false,
        key: null,
        source: null,
        profile: null,
        label: '',
        expiresText: '',
        expiresAt: null,
        permissionsOk: true,
        alsoInConfig: false,
        fastpathAllowed: false
      }
    }

    const active = entry.expiresAt === null || entry.expiresAt > this.now()
    const permissionsOk = entry.source === 'config' ? true : entry.permissionsOk
    const fastpathAllowed = active &&
      entry.profile === 'trusted' &&
      permissionsOk

    return {
      ...entry,
      listed: true,
      active,
      expiresAtIso: entry.expiresAt === null ? '' : new Date(entry.expiresAt).toISOString(),
      permissionsOk,
      fastpathAllowed
    }
  }

  async refreshIfChanged(force = false) {
    let stat = null

    try {
      stat = await fsp.lstat(this.filePath)
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        this.log(`cannot stat trusted devices file: ${err.message}`)
      }
    }

    if (!stat) {
      if (
        !force &&
        !this.fileExists &&
        this.loadedMtimeMs === -1
      ) {
        return false
      }

      this.fileEntries = new Map()
      this.fileExists = false
      this.permissionsOk = true
      this.permissionsError = null
      this.loadedMtimeMs = -1
      this.loadedMode = -1
      this.loadedUid = -1
      this._merge()
      return true
    }

    if (
      !force &&
      stat.mtimeMs === this.loadedMtimeMs &&
      stat.mode === this.loadedMode &&
      stat.uid === this.loadedUid
    ) {
      return false
    }

    let permissions
    try {
      permissions = normalizePosixResult(
        await this.posixCheck({ path: this.filePath, stat })
      )
    } catch (err) {
      permissions = { ok: false, reason: `check-failed: ${err.message}` }
    }

    let raw = ''
    try {
      raw = await fsp.readFile(this.filePath, 'utf8')
    } catch (err) {
      this.fileEntries = new Map()
      this.fileExists = false
      this.permissionsOk = false
      this.permissionsError = `read-failed: ${err.message}`
      this.loadedMtimeMs = stat.mtimeMs
      this.loadedMode = stat.mode
      this.loadedUid = stat.uid
      this._merge()
      this.log(`cannot read trusted devices file: ${err.message}`)
      return true
    }

    const entries = new Map()
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
      const parsed = parseDeviceLine(lines[i])
      if (parsed.error) {
        this.log(`trusted devices line ${i + 1} ignored: ${parsed.error}`)
        continue
      }
      if (parsed.entry) entries.set(parsed.entry.key, parsed.entry)
    }

    this.fileEntries = entries
    this.fileExists = true
    this.permissionsOk = permissions.ok
    this.permissionsError = permissions.reason
    this.loadedMtimeMs = stat.mtimeMs
    this.loadedMode = stat.mode
    this.loadedUid = stat.uid
    this._merge()

    if (!permissions.ok) {
      this.log(
        `trusted devices file is not secure (${permissions.reason}); fast-path entries are disabled`
      )
    }

    return true
  }

  async evaluate(keyHex) {
    await this.refreshIfChanged()
    return this._decorate(this.merged.get(String(keyHex).toLowerCase()))
  }

  async listDevices() {
    await this.refreshIfChanged()

    return [...this.merged.values()]
      .map((entry) => this._decorate(entry))
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  async _readRawLines() {
    let raw

    try {
      raw = await fsp.readFile(this.filePath, 'utf8')
    } catch (err) {
      if (err && err.code === 'ENOENT') return []
      throw err
    }

    const text = raw.replace(/^\uFEFF/, '')
    if (text === '') return []
    return text.split(/\r?\n/)
  }

  async _writeLines(lines) {
    const dir = path.dirname(this.filePath)
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      await fsp.chmod(dir, 0o700)
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }

    let joined = lines.join('\n')
    while (joined.endsWith('\n')) joined = joined.slice(0, -1)
    const content = joined.length > 0 ? `${joined}\n` : ''
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`

    try {
      await fsp.writeFile(tempPath, content, { mode: 0o600 })
      try {
        await fsp.chmod(tempPath, 0o600)
      } catch {
        // See above.
      }
      await fsp.rename(tempPath, this.filePath)
      try {
        await fsp.chmod(this.filePath, 0o600)
      } catch {
        // See above.
      }
    } finally {
      try {
        await fsp.rm(tempPath, { force: true })
      } catch {
        // Ignore.
      }
    }

    await this.refreshIfChanged(true)
  }

  async addDevice({ key, profile = 'scram', expires = null, label = '' }) {
    if (!isHex64(key)) {
      const err = new Error('public key must be 64 hexadecimal characters')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    if (!DEVICE_PROFILES.includes(profile)) {
      const err = new Error('mode must be trusted or scram')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    if (expires) parseExpires(expires)

    const normalizedKey = key.toLowerCase()
    const lines = await this._readRawLines()
    const filtered = []
    let replaced = false

    for (const line of lines) {
      const parsed = parseDeviceLine(line)
      if (parsed.entry && parsed.entry.key === normalizedKey) {
        replaced = true
        continue
      }
      filtered.push(line)
    }

    filtered.push(formatDeviceLine({ key: normalizedKey, profile, expires, label }))
    await this._writeLines(filtered)

    return {
      key: normalizedKey,
      replaced,
      alsoInConfig: this.configEntries.has(normalizedKey),
      filePath: this.filePath
    }
  }

  async removeDevice(key) {
    if (!isHex64(key)) {
      const err = new Error('public key must be 64 hexadecimal characters')
      err.code = 'CONFIG_INVALID'
      throw err
    }

    const normalizedKey = key.toLowerCase()
    const lines = await this._readRawLines()
    const filtered = []
    let removed = false

    for (const line of lines) {
      const parsed = parseDeviceLine(line)
      if (parsed.entry && parsed.entry.key === normalizedKey) {
        removed = true
        continue
      }
      filtered.push(line)
    }

    if (removed) await this._writeLines(filtered)

    return {
      key: normalizedKey,
      removed,
      alsoInConfig: this.configEntries.has(normalizedKey),
      filePath: this.filePath
    }
  }
}

module.exports = {
  VERIFICATION_MODES,
  DEVICE_PROFILES,
  DEFAULT_TRUSTED_DEVICES_PATH,
  DeviceRegistry,
  evaluateDevicePolicy,
  parseDeviceLine,
  formatDeviceLine,
  validateDeviceAddOptions,
  normalizeVerificationMode,
  defaultPosixCheck
}
