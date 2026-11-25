'use strict'

// Pre-release consistency checks. Catches the mistakes that have slipped through before:
// a README badge left on the old version, release notes missing, a user-facing flag that
// shipped without documentation, and docs links that do not exist in the npm package.

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file) => fs.existsSync(path.join(root, file))
const pkg = require('../package.json')
const version = pkg.version

const problems = []
const warnings = []

// 1. README must already point at this version.
for (const file of ['README.md', 'README.th.md']) {
  const text = read(file)

  if (!text.includes(`?v=${version}`)) {
    problems.push(`${file}: Socket badge is not ?v=${version}`)
  }

  if (!text.includes(`v${version}.md`)) {
    problems.push(`${file}: --version example is not v${version}.md`)
  }
}

// 2. Release notes must exist and be linked.
const releaseFile = `docs/releases/v${version}.md`
if (!exists(releaseFile)) {
  problems.push(`missing ${releaseFile}`)
} else if (!read('docs/README.md').includes(`releases/v${version}.md`)) {
  problems.push(`docs/README.md does not link to ${releaseFile}`)
}

// 3. Changelog entry.
if (!read('CHANGELOG.md').includes(`## [${version}]`)) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section`)
}

// 4. Every user-facing CLI flag must appear in the README. The allow list holds short
//    aliases and advanced flags that are deliberately documented elsewhere.
const ALLOW_MISSING = new Set([
  'help',
  'force',
  'quick',
  'target-port',
  'secret',
  'password',
  'secret-stdin',
  'password-stdin'
])

const cli = read('src/cli.js')
const flagPattern = /^[ \t]*'?([a-z0-9-]+)'?:[ \t]*\{[ \t]*type:[ \t]*'(boolean|string)'/gm
const readme = read('README.md') + read('README.th.md')
const flags = new Set()
let match
while ((match = flagPattern.exec(cli))) flags.add(match[1])

for (const flag of flags) {
  if (ALLOW_MISSING.has(flag)) continue
  if (!readme.includes(`--${flag}`)) {
    problems.push(`README does not document --${flag}`)
  }
}

// 5. Warn about relative docs links that will not resolve on npm (docs/ is not published).
const published = Array.isArray(pkg.files) ? pkg.files : []
if (!published.some((entry) => entry.startsWith('docs'))) {
  const links = [...readme.matchAll(/\]\((docs\/[^)#\s]+)/g)].map((entry) => entry[1])
  const unique = [...new Set(links)]
  if (unique.length > 0) {
    warnings.push(
      `README links to ${unique.length} file(s) under docs/ that are not in "files"; ` +
      'those links break on npm. Use absolute GitHub URLs.'
    )
  }
}

if (warnings.length > 0) {
  process.stdout.write('\nWarnings:\n')
  for (const warning of warnings) process.stdout.write(`  - ${warning}\n`)
}

if (problems.length > 0) {
  process.stdout.write(`\nRelease check failed for v${version}:\n`)
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
  process.stdout.write('\n')
  process.exit(1)
}

process.stdout.write(`\nRelease check passed for v${version} (${flags.size} CLI flags checked)\n`)
