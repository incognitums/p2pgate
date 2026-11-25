'use strict'

// Builds a realistic MCP / JSON-RPC corpus: a training set (one message per file) and a
// held-out test set with different ids, paths, queries and payloads.

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, 'corpus')
const TRAIN = path.join(ROOT, 'train')
const TEST = path.join(ROOT, 'test')
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(TRAIN, { recursive: true })
fs.mkdirSync(TEST, { recursive: true })

const tools = [
  ['read_file', 'Read a text file from the workspace', { path: 'string', encoding: 'string', max_bytes: 'integer' }],
  ['write_file', 'Write text to a file in the workspace', { path: 'string', content: 'string', create_dirs: 'boolean' }],
  ['list_dir', 'List directory entries', { path: 'string', recursive: 'boolean' }],
  ['search_code', 'Search the workspace with a regular expression', { pattern: 'string', glob: 'string', max_results: 'integer' }],
  ['run_command', 'Run a shell command in the workspace', { command: 'string', cwd: 'string', timeout_ms: 'integer' }],
  ['git_status', 'Show working tree status', { path: 'string', short: 'boolean' }],
  ['git_diff', 'Show a diff for a path or commit', { path: 'string', staged: 'boolean', context_lines: 'integer' }],
  ['http_get', 'Fetch a URL and return the body', { url: 'string', headers: 'object', timeout_ms: 'integer' }],
  ['sql_query', 'Run a read-only SQL query', { connection: 'string', query: 'string', limit: 'integer' }],
  ['browser_open', 'Open a URL in the session browser', { url: 'string', wait_for: 'string' }],
  ['browser_snapshot', 'Snapshot the current page', { tab: 'integer', include_hidden: 'boolean' }],
  ['screenshot', 'Capture the current page', { tab: 'integer', full_page: 'boolean' }],
  ['send_email', 'Send an email through the configured account', { to: 'string', subject: 'string', body: 'string' }],
  ['calendar_list', 'List calendar events in a range', { from: 'string', to: 'string', limit: 'integer' }],
  ['deploy', 'Deploy a service to an environment', { service: 'string', environment: 'string', tag: 'string' }],
  ['logs_tail', 'Tail logs for a service', { service: 'string', lines: 'integer', since: 'string' }],
  ['metrics_query', 'Query metrics for a service', { service: 'string', metric: 'string', window: 'string' }],
  ['issue_create', 'Create an issue', { repo: 'string', title: 'string', body: 'string', labels: 'array' }],
  ['issue_list', 'List issues', { repo: 'string', state: 'string', limit: 'integer' }],
  ['translate', 'Translate text', { text: 'string', from: 'string', to: 'string' }]
]

const dirs = ['/workspace/src', '/workspace/docs', '/workspace/tests', '/home/user/app', '/srv/api/src', '/tmp/build'] // NOSONAR: sample strings, not filesystem use
const files = ['index.ts', 'server.py', 'mux.js', 'README.md', 'package.json', 'config.yaml', 'client.go']
const services = ['api-gateway', 'auth-service', 'billing', 'search', 'notifier']
const envs = ['staging', 'production', 'preview']

function rid (i, salt) {
  return salt ? `${i}-${salt}` : i
}

function schemaFor (fields) {
  const properties = {}
  const required = []
  for (const [name, type] of Object.entries(fields)) {
    properties[name] = { type, description: `The ${name.replace(/_/g, ' ')}` }
    if (type !== 'boolean') required.push(name)
  }
  return { type: 'object', properties, required }
}

function toolsList (id, salt) {
  return {
    jsonrpc: '2.0',
    id: rid(id, salt),
    result: {
      tools: tools.map(([name, description, fields]) => ({
        name,
        description: `${description}${salt ? ` (${salt})` : ''}`,
        inputSchema: schemaFor(fields)
      }))
    }
  }
}

function body (i, salt) {
  // deterministic pseudo-text so train and test differ only by salt and index
  let seed = i * 2654435761 + (salt ? salt.length * 97 : 0)
  const lines = []
  for (let k = 0; k < 8; k += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    lines.push(`line ${k + 1}: value=${seed % 100000} status=${['ok', 'retry', 'failed'][seed % 3]} latency_ms=${seed % 900}`)
  }
  return lines.join('\n')
}

function callRequest (id, j, salt) {
  const [name, , fields] = tools[j % tools.length]
  const args = {}
  for (const [key, type] of Object.entries(fields)) {
    if (type === 'string') {
      if (key === 'path' || key === 'cwd') args[key] = `${dirs[(j + id) % dirs.length]}/${files[(j * 3 + id) % files.length]}`
      else if (key === 'url') args[key] = `https://example.com/api/v${(j % 3) + 1}/items?page=${id % 20}`
      else if (key === 'query') args[key] = `SELECT id, name, created_at FROM items WHERE tenant = 'tenant_${id % 50}' LIMIT ${(id % 100) + 1}`
      else if (key === 'command') args[key] = `npm test -- --runInBand --testPathPattern=suite_${id % 40}`
      else if (key === 'service') args[key] = services[(id + j) % services.length]
      else if (key === 'environment') args[key] = envs[id % envs.length]
      else args[key] = `sample-${key}-${id}${salt ? `-${salt}` : ''}`
    } else if (type === 'integer') {
      args[key] = 10 + ((id * 7 + j) % 500)
    } else if (type === 'boolean') {
      args[key] = (id + j) % 2 === 0
    } else if (type === 'object') {
      args[key] = { accept: 'application/json', 'user-agent': 'mcp-client/1.0' }
    } else if (type === 'array') {
      args[key] = ['bug', 'triage']
    }
  }
  return { jsonrpc: '2.0', id: rid(id, salt), method: 'tools/call', params: { name, arguments: args } }
}

function callResult (id, j, salt) {
  return {
    jsonrpc: '2.0',
    id: rid(id, salt),
    result: {
      content: [{ type: 'text', text: body(id + j, salt) }],
      isError: false
    }
  }
}

function initialize (id, salt) {
  return {
    jsonrpc: '2.0',
    id: rid(id, salt),
    result: {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        logging: {}
      },
      serverInfo: { name: 'workspace-mcp', version: '0.9.3', title: 'Workspace tools' }
    }
  }
}

function makeSet (count, salt, dir) {
  let total = 0
  for (let i = 0; i < count; i += 1) {
    const kind = i % 10
    let msg
    if (kind === 0) msg = initialize(i, salt)
    else if (kind === 1) msg = toolsList(i, salt)
    else if (kind % 2 === 0) msg = callRequest(i, i, salt)
    else msg = callResult(i, i, salt)

    const line = kind === 2 || kind === 6 ? `event: message\ndata: ${JSON.stringify(msg)}\n\n` : JSON.stringify(msg)
    total += Buffer.byteLength(line)
    fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.json`), line)
  }
  return total
}

const trainBytes = makeSet(600, '', TRAIN)
const testBytes = makeSet(200, 'holdout', TEST)
console.log(JSON.stringify({ trainMessages: 600, trainBytes, testMessages: 200, testBytes }))
