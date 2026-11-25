'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  assertMasterSecret,
  normalizeClientPublicKeyHex,
  parseScramVerifier
} = require('./crypto-utils')
const {
  DEFAULT_TRUSTED_DEVICES_PATH,
  normalizeVerificationMode
} = require('./device-registry')
const {
  DEFAULT_AUDIT_LOG_PATH,
  DEFAULT_AUDIT_MAX_BYTES
} = require('./audit-log')
const { parseAllowEntry } = require('./allowlist')
const { normalizeCompressConfig } = require('./compress')

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.p2pgate')
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, 'config.json')
const DEFAULT_CLIENT_KEY_PATH = path.join(DEFAULT_CONFIG_DIR, 'client-key.json')

const TARGET_HOST = '127.0.0.1'
const TARGET_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const RESERVED_TARGET_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const VALID_MODES = new Set(['server', 'client'])
const AUTH_MODES = Object.freeze(['password', 'registry'])

function isValidTargetName(name) {
  return typeof name === 'string' &&
    TARGET_NAME_RE.test(name) &&
    !RESERVED_TARGET_NAMES.has(name.toLowerCase())
}

/**
 * Normalizes the optional multi-target map. A config without `targets` keeps
 * the v1.6 single-target behaviour via a synthetic "default" entry.
 */
function normalizeTargets(raw, fallbackPort) {
  const rawTargets = raw.targets

  if (rawTargets === undefined || rawTargets === null) {
    const targets = Object.create(null)
    targets.default = { host: TARGET_HOST, port: fallbackPort, allow: null }
    return { targets, defaultTarget: 'default' }
  }

  if (typeof rawTargets !== 'object' || Array.isArray(rawTargets)) {
    throw new ConfigError('targets must be an object of name -> { port }', 'CONFIG_INVALID')
  }

  const names = Object.keys(rawTargets)
  const targets = Object.create(null)

  for (const name of names) {
    if (!isValidTargetName(name)) {
      throw new ConfigError(
        `targets.${name} is not a valid name (1-32 chars: A-Z a-z 0-9 _ -)`,
        'CONFIG_INVALID'
      )
    }

    const entry = rawTargets[name]

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError(`targets.${name} must be an object`, 'CONFIG_INVALID')
    }

    const host = entry.host === undefined ? TARGET_HOST : String(entry.host).trim()

    if (host !== TARGET_HOST) {
      throw new ConfigError(
        `targets.${name}.host must be ${TARGET_HOST} (p2pgate never forwards to a remote host)`,
        'CONFIG_INVALID'
      )
    }

    const port = parsePort(entry.port, `targets.${name}.port`)

    let allow = null
    if (entry.allow !== undefined && entry.allow !== null) {
      if (!Array.isArray(entry.allow) || entry.allow.length === 0) {
        throw new ConfigError(
          `targets.${name}.allow must be a non-empty array of client keys or "*"`,
          'CONFIG_INVALID'
        )
      }

      allow = entry.allow.map((value, index) => {
        if (value === '*') return '*'
        try {
          return normalizeClientPublicKeyHex(value)
        } catch (err) {
          throw new ConfigError(
            `targets.${name}.allow[${index}]: ${err.message}`,
            'CONFIG_INVALID'
          )
        }
      })
    }

    targets[name] = { host, port, allow }
  }

  if (Object.keys(targets).length === 0) {
    targets.default = { host: TARGET_HOST, port: fallbackPort, allow: null }
  }

  let defaultTarget = raw.defaultTarget === undefined || raw.defaultTarget === null
    ? null
    : String(raw.defaultTarget).trim()

  if (defaultTarget === null || defaultTarget === '') {
    defaultTarget = Object.prototype.hasOwnProperty.call(targets, 'default')
      ? 'default'
      : Object.keys(targets)[0]
  }

  if (!Object.prototype.hasOwnProperty.call(targets, defaultTarget)) {
    throw new ConfigError(
      `defaultTarget "${defaultTarget}" is not defined in targets`,
      'CONFIG_INVALID'
    )
  }

  return { targets, defaultTarget }
}

class ConfigError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

function expandHome(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ConfigError('path must be a non-empty string', 'CONFIG_INVALID')
  }

  const value = input.trim()
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }

  return value
}

function defaultConfig() {
  return {
    mode: 'server',
    masterSecret: '',
    authMode: 'password',
    targetHost: TARGET_HOST,
    targetPort: 8022,
    localPort: 8022,
    clientKeyPath: DEFAULT_CLIENT_KEY_PATH,
    allowedClientKeys: [],
    verificationMode: 'hybrid',
    trustedDevicesFile: DEFAULT_TRUSTED_DEVICES_PATH,
    auditLog: {
      enabled: true,
      path: DEFAULT_AUDIT_LOG_PATH,
      maxBytes: DEFAULT_AUDIT_MAX_BYTES
    },
    customBootstrap: [],
    socks: {
      enabled: false,
      allow: []
    },
    socks5Port: null,
    authPin: {
      enabled: true,
      unattended: null
    },
    telegramAlert: {
      enabled: false,
      botToken: '',
      chatId: ''
    }
  }
}

function parsePort(value, field, { allowZero = false } = {}) {
  const numeric = typeof value === 'string' ? Number(value.trim()) : value
  const minimum = allowZero ? 0 : 1

  if (!Number.isInteger(numeric) || numeric < minimum || numeric > 65535) {
    throw new ConfigError(
      `${field} must be an integer between ${minimum} and 65535`,
      'CONFIG_INVALID'
    )
  }

  return numeric
}

function parseMuxPeekMs(value) {
  if (value === undefined || value === null) return undefined

  const numeric = typeof value === 'string' ? Number(value.trim()) : value

  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 5000) {
    throw new ConfigError('muxPeekMs must be an integer between 0 and 5000', 'CONFIG_INVALID')
  }

  return numeric
}

function parseBoolean(value, field, fallback = false) {  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${field} must be true or false`, 'CONFIG_INVALID')
  }
  return value
}

function normalizeBootstrap(value) {
  if (value === undefined) return []

  if (!Array.isArray(value)) {
    throw new ConfigError('customBootstrap must be an array of "host:port" strings', 'CONFIG_INVALID')
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(
        `customBootstrap[${index}] must be a non-empty "host:port" string`,
        'CONFIG_INVALID'
      )
    }

    const trimmed = entry.trim()

    // Support the optional "[suggested-ip@]host:port" syntax used by hyperdht.
    const atIndex = trimmed.lastIndexOf('@')
    const hostPort = atIndex === -1 ? trimmed : trimmed.slice(atIndex + 1)
    const colonIndex = hostPort.lastIndexOf(':')

    if (colonIndex <= 0 || colonIndex === hostPort.length - 1) {
      throw new ConfigError(
        `customBootstrap[${index}] must look like "host:port"`,
        'CONFIG_INVALID'
      )
    }

    const host = hostPort.slice(0, colonIndex)
    const port = Number(hostPort.slice(colonIndex + 1))

    if (host.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(
        `customBootstrap[${index}] must look like "host:port" with a valid port`,
        'CONFIG_INVALID'
      )
    }

    return trimmed
  })
}

function normalizeAllowedKeys(value) {
  if (value === undefined) return []

  if (!Array.isArray(value)) {
    throw new ConfigError('allowedClientKeys must be an array of public keys', 'CONFIG_INVALID')
  }

  const seen = new Set()
  const keys = []

  for (let i = 0; i < value.length; i++) {
    let normalized
    try {
      normalized = normalizeClientPublicKeyHex(value[i])
    } catch (err) {
      throw new ConfigError(
        `allowedClientKeys[${i}] is invalid: ${err.message}`,
        'CONFIG_INVALID'
      )
    }

    if (!seen.has(normalized)) {
      seen.add(normalized)
      keys.push(normalized)
    }
  }

  return keys
}

function normalizeAuthPin(value, verificationMode) {
  if (value === undefined) {
    return { enabled: verificationMode !== 'key-only', unattended: null }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('authPin must be an object', 'CONFIG_INVALID')
  }

  if (value.unattendedPasswordHash !== undefined) {
    throw new ConfigError(
      'v1.1 authPin format detected; run p2pgate setup to migrate the credential',
      'AUTH_CONFIG_UPGRADE_REQUIRED'
    )
  }

  // verificationMode is authoritative. authPin.enabled is retained as a legacy
  // compatibility field and kept consistent with the selected mode.
  const enabled = verificationMode !== 'key-only'
  let unattended = null

  if (value.unattended !== undefined && value.unattended !== null) {
    try {
      const parsed = parseScramVerifier(value.unattended)
      unattended = {
        saltHex: parsed.saltHex,
        storedKeyHex: parsed.storedKeyHex,
        serverKeyHex: parsed.serverKeyHex
      }
    } catch (err) {
      throw new ConfigError(`authPin.unattended is invalid: ${err.message}`, 'CONFIG_INVALID')
    }
  }

  return { enabled, unattended }
}

function normalizeTelegram(value) {
  if (value === undefined) {
    return { enabled: false, botToken: '', chatId: '' }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('telegramAlert must be an object', 'CONFIG_INVALID')
  }

  const enabled = parseBoolean(value.enabled, 'telegramAlert.enabled', false)
  const botToken = value.botToken === undefined || value.botToken === null
    ? ''
    : String(value.botToken).trim()
  const chatId = value.chatId === undefined || value.chatId === null
    ? ''
    : String(value.chatId).trim()

  if (enabled && (!botToken || !chatId)) {
    throw new ConfigError(
      'telegramAlert.enabled requires both botToken and chatId',
      'CONFIG_INVALID'
    )
  }

  return { enabled, botToken, chatId }
}

function normalizeAuditLog(value, base) {
  if (value === undefined) return { ...base }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('auditLog must be an object', 'CONFIG_INVALID')
  }

  const enabled = parseBoolean(value.enabled, 'auditLog.enabled', base.enabled)
  const filePath = value.path === undefined ||
    value.path === null ||
    String(value.path).trim() === ''
    ? base.path
    : path.resolve(expandHome(String(value.path)))
  const maxBytes = value.maxBytes === undefined
    ? base.maxBytes
    : Number(value.maxBytes)

  if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
    throw new ConfigError(
      'auditLog.maxBytes must be an integer of at least 1024',
      'CONFIG_INVALID'
    )
  }

  return { enabled, path: filePath, maxBytes }
}

function normalizeAuthMode(value, raw) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return Array.isArray(raw.allowedClientKeys) && raw.allowedClientKeys.length > 0
      ? 'registry'
      : 'password'
  }

  const mode = String(value).trim().toLowerCase()
  if (!AUTH_MODES.includes(mode)) {
    throw new ConfigError('authMode must be password or registry', 'CONFIG_INVALID')
  }

  return mode
}

/**
 * Merges a raw configuration object with defaults and validates every field.
 */
function normalizeUdpTargets(value) {
  if (value === undefined || value === null) return null

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('udpTargets must be an object of name -> { port }', 'CONFIG_INVALID')
  }

  const targets = Object.create(null)
  const names = Object.keys(value)

  for (const name of names) {
    if (!isValidTargetName(name)) {
      throw new ConfigError(
        `udpTargets.${name} is not a valid name (1-32 chars: A-Z a-z 0-9 _ -)`,
        'CONFIG_INVALID'
      )
    }

    const entry = value[name]

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigError(`udpTargets.${name} must be an object`, 'CONFIG_INVALID')
    }

    const host = entry.host === undefined ? TARGET_HOST : String(entry.host).trim()

    if (host !== TARGET_HOST) {
      throw new ConfigError(
        `udpTargets.${name}.host must be ${TARGET_HOST}`,
        'CONFIG_INVALID'
      )
    }

    targets[name] = {
      host,
      port: parsePort(entry.port, `udpTargets.${name}.port`)
    }
  }

  return Object.keys(targets).length > 0 ? targets : null
}

function normalizeSocks(value) {
  if (value === undefined || value === null) {
    return { enabled: false, allow: [], perClient: null }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('socks must be an object', 'CONFIG_INVALID')
  }

  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new ConfigError('socks.enabled must be true or false', 'CONFIG_INVALID')
  }

  const enabled = value.enabled === true
  let allow = []

  if (value.allow !== undefined && value.allow !== null) {
    if (!Array.isArray(value.allow)) {
      throw new ConfigError(
        'socks.allow must be an array of "ip:port" or "cidr:port" entries',
        'CONFIG_INVALID'
      )
    }

    try {
      allow = value.allow.map((entry) => parseAllowEntry(entry).text)
    } catch (err) {
      throw new ConfigError(err.message, 'CONFIG_INVALID')
    }
  }

  if (enabled && allow.length === 0) {
    throw new ConfigError('socks.enabled requires socks.allow entries', 'CONFIG_INVALID')
  }

  let perClient = null

  if (value.perClient !== undefined && value.perClient !== null) {
    if (typeof value.perClient !== 'object' || Array.isArray(value.perClient)) {
      throw new ConfigError(
        'socks.perClient must be an object of clientKey -> allow entries',
        'CONFIG_INVALID'
      )
    }

    perClient = {}

    for (const [key, entries] of Object.entries(value.perClient)) {
      let normalizedKey
      try {
        normalizedKey = normalizeClientPublicKeyHex(key)
      } catch (err) {
        throw new ConfigError(`socks.perClient: ${err.message}`, 'CONFIG_INVALID')
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        throw new ConfigError(
          'socks.perClient entries must be non-empty arrays',
          'CONFIG_INVALID'
        )
      }

      try {
        perClient[normalizedKey] = entries.map((entry) => parseAllowEntry(entry).text)
      } catch (err) {
        throw new ConfigError(err.message, 'CONFIG_INVALID')
      }
    }

    if (!enabled) {
      throw new ConfigError(
        'socks.perClient requires socks.enabled: true',
        'CONFIG_INVALID'
      )
    }
  }

  return { enabled, allow, perClient }
}

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('configuration must be a JSON object', 'CONFIG_INVALID')
  }

  const base = defaultConfig()
  const mode = raw.mode === undefined ? base.mode : String(raw.mode).trim().toLowerCase()

  if (!VALID_MODES.has(mode)) {
    throw new ConfigError('mode must be "server" or "client"', 'CONFIG_INVALID')
  }

  let masterSecret
  try {
    masterSecret = assertMasterSecret(raw.masterSecret)
  } catch (err) {
    throw new ConfigError(err.message, err.code || 'CONFIG_INVALID')
  }

  const targetHost = raw.targetHost === undefined
    ? base.targetHost
    : String(raw.targetHost).trim()

  if (targetHost !== TARGET_HOST) {
    throw new ConfigError(
      'targetHost must be 127.0.0.1 (p2pgate never forwards to a remote host)',
      'CONFIG_INVALID'
    )
  }

  const clientKeyPath = raw.clientKeyPath === undefined || String(raw.clientKeyPath).trim() === ''
    ? base.clientKeyPath
    : path.resolve(expandHome(String(raw.clientKeyPath)))

  let verificationMode
  try {
    if (raw.verificationMode !== undefined) {
      verificationMode = normalizeVerificationMode(raw.verificationMode)
    } else if (raw.authPin && raw.authPin.enabled === false) {
      // v1.2 compatibility: authPin.enabled=false meant no interactive PIN.
      verificationMode = 'key-only'
    } else {
      verificationMode = 'hybrid'
    }
  } catch (err) {
    throw new ConfigError(err.message, 'CONFIG_INVALID')
  }

  const trustedDevicesFile = raw.trustedDevicesFile === undefined ||
    String(raw.trustedDevicesFile).trim() === ''
    ? base.trustedDevicesFile
    : path.resolve(expandHome(String(raw.trustedDevicesFile)))

  const authMode = normalizeAuthMode(raw.authMode, raw)

  const declaredTargetPort = parsePort(
    raw.targetPort === undefined ? base.targetPort : raw.targetPort,
    'targetPort'
  )

  let targets
  let defaultTarget
  let targetPort = declaredTargetPort

  if (mode === 'server') {
    const normalizedTargets = normalizeTargets(raw, declaredTargetPort)
    targets = normalizedTargets.targets
    defaultTarget = normalizedTargets.defaultTarget
    targetPort = raw.targets === undefined || raw.targets === null
      ? declaredTargetPort
      : targets[defaultTarget].port
  }

  let target = null
  if (raw.target !== undefined && raw.target !== null && String(raw.target).trim() !== '') {
    target = String(raw.target).trim()
    if (!isValidTargetName(target)) {
      throw new ConfigError('target must be 1-32 chars: A-Z a-z 0-9 _ -', 'CONFIG_INVALID')
    }
  }

  const socks5Port = raw.socks5Port === undefined || raw.socks5Port === null
    ? null
    : parsePort(raw.socks5Port, 'socks5Port')

  const udpTarget = raw.udpTarget === undefined || raw.udpTarget === null ||
    String(raw.udpTarget).trim() === ''
    ? null
    : String(raw.udpTarget).trim()

  if (udpTarget !== null && !isValidTargetName(udpTarget)) {
    throw new ConfigError('udpTarget must be 1-32 chars: A-Z a-z 0-9 _ -', 'CONFIG_INVALID')
  }

  const udpListen = raw.udpListen === undefined || raw.udpListen === null
    ? null
    : parsePort(raw.udpListen, 'udpListen')

  return {
    mode,
    masterSecret,
    authMode,
    targetHost,
    targetPort,
    targets: mode === 'server' ? targets : undefined,
    defaultTarget: mode === 'server' ? defaultTarget : undefined,
    target,
    socks: mode === 'server' ? normalizeSocks(raw.socks) : undefined,
    socks5Port,
    udpTargets: mode === 'server' ? normalizeUdpTargets(raw.udpTargets) : undefined,
    udpTarget,
    udpListen,
    mux: parseBoolean(raw.mux, 'mux', true),
    muxPeekMs: mode === 'server' ? parseMuxPeekMs(raw.muxPeekMs) : undefined,
    compress: normalizeCompressConfig(raw.compress),
    localPort: parsePort(
      raw.localPort === undefined ? base.localPort : raw.localPort,
      'localPort',
      { allowZero: true }
    ),
    clientKeyPath,
    allowedClientKeys: normalizeAllowedKeys(raw.allowedClientKeys),
    verificationMode,
    trustedDevicesFile,
    auditLog: normalizeAuditLog(raw.auditLog, base.auditLog),
    customBootstrap: normalizeBootstrap(raw.customBootstrap),
    authPin: normalizeAuthPin(raw.authPin, verificationMode),
    telegramAlert: normalizeTelegram(raw.telegramAlert)
  }
}

function resolveConfigPath(explicitPath) {
  if (explicitPath !== undefined && explicitPath !== null && String(explicitPath).trim() !== '') {
    return path.resolve(expandHome(String(explicitPath)))
  }

  const local = path.resolve(process.cwd(), 'config.json')
  if (fs.existsSync(local)) return local

  return DEFAULT_CONFIG_PATH
}

async function readConfigRaw(configPath) {
  const absolutePath = path.resolve(configPath)

  let raw
  try {
    raw = await fsp.readFile(absolutePath, 'utf8') // NOSONAR: operator-supplied config path
    // The file contains masterSecret, so keep tightening it if a user or
    // editor created it with looser permissions.
    try {
      await fsp.chmod(absolutePath, 0o600) // NOSONAR: operator-supplied config path
    } catch {
      // Windows and some filesystems do not enforce POSIX modes.
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(
        `configuration file not found: ${absolutePath}`,
        'CONFIG_NOT_FOUND'
      )
    }
    throw err
  }

  try {
    // Strip a UTF-8 BOM, which some Windows editors add automatically.
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new ConfigError(
      `configuration file is not valid JSON: ${absolutePath}`,
      'CONFIG_INVALID_JSON'
    )
  }
}

async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath)
  const raw = await readConfigRaw(absolutePath)

  try {
    return normalizeConfig(raw)
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ConfigError(`${err.message} (file: ${absolutePath})`, err.code)
    }
    throw err
  }
}

async function saveConfig(configPath, config) {
  const absolutePath = path.resolve(expandHome(configPath))
  const normalized = normalizeConfig(config)
  const dir = path.dirname(absolutePath)

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 }) // NOSONAR: operator-supplied config path
  try {
    await fsp.chmod(dir, 0o700) // NOSONAR: operator-supplied config path
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }

  const payload = `${JSON.stringify(normalized, null, 2)}\n`
  await fsp.writeFile(absolutePath, payload, { mode: 0o600 }) // NOSONAR: operator-supplied config path
  try {
    await fsp.chmod(absolutePath, 0o600) // NOSONAR: operator-supplied config path
  } catch {
    // See above.
  }

  return normalized
}

module.exports = {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CLIENT_KEY_PATH,
  ConfigError,
  defaultConfig,
  expandHome,
  normalizeConfig,
  resolveConfigPath,
  readConfigRaw,
  loadConfig,
  saveConfig
}
