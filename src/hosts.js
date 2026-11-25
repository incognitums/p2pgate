'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')

const { DEFAULT_CONFIG_DIR } = require('./config-loader')

const HOSTS_PATH = path.join(DEFAULT_CONFIG_DIR, 'hosts.json')
const ALIAS_RE = /^[A-Za-z0-9_-]{1,32}$/

class HostsError extends Error {
  constructor(message, code = 'HOSTS_INVALID') {
    super(message)
    this.name = 'HostsError'
    this.code = code
  }
}

function assertAlias(alias) {
  const value = typeof alias === 'string' ? alias.trim().replace(/^@/, '') : ''

  if (!ALIAS_RE.test(value)) {
    throw new HostsError('alias must be 1-32 chars: A-Z a-z 0-9 _ -', 'ALIAS_INVALID')
  }

  return value
}

async function readHostsFile(filePath = HOSTS_PATH) {
  let raw

  try {
    raw = await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { version: 1, hosts: {} }
    }
    throw err
  }

  let parsed

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HostsError(`invalid JSON in ${filePath}`, 'HOSTS_INVALID')
  }

  const hosts = parsed && typeof parsed.hosts === 'object' && parsed.hosts !== null
    ? parsed.hosts
    : {}

  return { version: 1, hosts }
}

async function writeHostsFile(data, filePath = HOSTS_PATH) {
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })

  const tempPath = `${filePath}.${process.pid}.tmp`
  const payload = `${JSON.stringify({ version: 1, hosts: data.hosts }, null, 2)}\n`

  await fsp.writeFile(tempPath, payload, { mode: 0o600 })
  try {
    await fsp.chmod(tempPath, 0o600)
  } catch {
    // Windows and some filesystems do not enforce POSIX modes.
  }
  await fsp.rename(tempPath, filePath)
  try {
    await fsp.chmod(filePath, 0o600)
  } catch {
    // See above.
  }
}

async function listHosts(filePath = HOSTS_PATH) {
  const data = await readHostsFile(filePath)
  return Object.keys(data.hosts).sort((a, b) => a.localeCompare(b)).map((alias) => ({
    alias,
    ...data.hosts[alias]
  }))
}

async function getHost(alias, filePath = HOSTS_PATH) {
  const key = assertAlias(alias)
  const data = await readHostsFile(filePath)
  const host = data.hosts[key]

  if (!host) {
    throw new HostsError(`unknown host alias "${key}"`, 'ALIAS_NOT_FOUND')
  }

  return { alias: key, ...host }
}

async function setHost(alias, record, filePath = HOSTS_PATH) {
  const key = assertAlias(alias)
  const data = await readHostsFile(filePath)

  data.hosts[key] = {
    masterSecret: record.masterSecret,
    target: record.target || null,
    localPort: Number.isInteger(record.localPort) ? record.localPort : 8022,
    socks5Port: Number.isInteger(record.socks5Port) ? record.socks5Port : null,
    targetPort: Number.isInteger(record.targetPort) ? record.targetPort : 8022,
    savedAt: new Date().toISOString()
  }

  await writeHostsFile(data, filePath)
  return { alias: key, ...data.hosts[key] }
}

async function deleteHost(alias, filePath = HOSTS_PATH) {
  const key = assertAlias(alias)
  const data = await readHostsFile(filePath)

  if (!data.hosts[key]) {
    throw new HostsError(`unknown host alias "${key}"`, 'ALIAS_NOT_FOUND')
  }

  delete data.hosts[key]
  await writeHostsFile(data, filePath)
}

module.exports = {
  HOSTS_PATH,
  HostsError,
  assertAlias,
  listHosts,
  getHost,
  setHost,
  deleteHost
}
