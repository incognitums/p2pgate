'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')

const {
  loadConfig,
  resolveConfigPath,
  saveConfig
} = require('./config-loader')

const HEX_64 = /^[0-9a-f]{64}$/

function generateMasterSecret() {
  return crypto.randomBytes(32).toString('hex')
}

function fingerprint(secret) {
  if (typeof secret !== 'string' || secret === '') return ''
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)
}

function backupPathFor(configPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${configPath}.bak-${stamp}`
}

/**
 * Rotates the masterSecret of a config file.
 *
 * - writes a timestamped backup next to the config (0600)
 * - writes the new secret through saveConfig so the file stays normalised
 * - never prints the secret to logs; callers decide what to show
 */
async function rotateMasterSecret(configPath, options = {}) {
  const resolved = resolveConfigPath(configPath)
  const config = await loadConfig(resolved)

  const nextSecret = options.secret === undefined
    ? generateMasterSecret()
    : String(options.secret).trim()

  if (!HEX_64.test(nextSecret)) {
    const err = new Error('masterSecret must be 64 hexadecimal characters')
    err.code = 'MASTER_SECRET_INVALID'
    throw err
  }

  if (nextSecret === config.masterSecret) {
    const err = new Error('the new masterSecret must differ from the current one')
    err.code = 'MASTER_SECRET_UNCHANGED'
    throw err
  }

  const dryRun = options.dryRun === true
  const backup = options.backup !== false
  let backupPath = null

  if (!dryRun) {
    if (backup) {
      backupPath = backupPathFor(resolved)

      await fsp.copyFile(resolved, backupPath) // NOSONAR: operator-supplied config path
      try {
        await fsp.chmod(backupPath, 0o600) // NOSONAR: operator-supplied config path
      } catch {
        // Windows and some filesystems do not enforce POSIX modes.
      }
    }

    await saveConfig(resolved, { ...config, masterSecret: nextSecret })
  }

  return {
    configPath: resolved,
    backupPath,
    backupSkipped: !dryRun && !backup,
    dryRun,
    mode: config.mode,
    previousFingerprint: fingerprint(config.masterSecret),
    fingerprint: fingerprint(nextSecret),
    masterSecret: nextSecret
  }
}

module.exports = {
  generateMasterSecret,
  fingerprint,
  rotateMasterSecret
}
