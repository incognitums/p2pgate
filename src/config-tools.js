'use strict'

const { fingerprint } = require('./master')

/**
 * Returns a copy of the normalised config with secret material replaced by
 * markers. Used by `p2pgate config show` and by anything that needs to print a
 * config without leaking credentials.
 */
function redactConfig(config) {
  const redacted = JSON.parse(JSON.stringify(config))

  if (redacted.masterSecret) {
    redacted.masterSecret = `<redacted sha256:${fingerprint(config.masterSecret)}>`
  }

  if (redacted.authPin) {
    redacted.authPin = {
      ...redacted.authPin,
      unattended: redacted.authPin.unattended ? '<scram-verifier:set>' : null
    }
  }

  if (redacted.telegramAlert) {
    redacted.telegramAlert = {
      ...redacted.telegramAlert,
      botToken: redacted.telegramAlert.botToken ? '<set>' : ''
    }
  }

  return redacted
}

function summarizeConfig(config) {
  const targets = config.targets && typeof config.targets === 'object'
    ? Object.keys(config.targets).sort((a, b) => a.localeCompare(b))
    : []
  const socks = config.socks && typeof config.socks === 'object'
    ? {
        enabled: config.socks.enabled === true,
        allowEntries: Array.isArray(config.socks.allow) ? config.socks.allow.length : 0,
        perClientKeys: config.socks.perClient && typeof config.socks.perClient === 'object'
          ? Object.keys(config.socks.perClient).length
          : 0
      }
    : { enabled: false, allowEntries: 0, perClientKeys: 0 }

  return {
    mode: config.mode,
    authMode: config.authMode,
    verificationMode: config.verificationMode,
    targetPort: config.targetPort,
    defaultTarget: config.defaultTarget || null,
    targets,
    socks,
    masterSecretFingerprint: fingerprint(config.masterSecret)
  }
}

module.exports = {
  redactConfig,
  summarizeConfig
}
