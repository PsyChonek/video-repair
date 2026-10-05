#!/usr/bin/env node
// Local release: verify, gate, bump, commit, tag, push, follow the deploy.
//
//   npm run deploy:patch [--skip-checks] [--dry-run] [--no-watch] [--yes]
//
// Test it by calling the script directly (node scripts/release.mjs patch
// --dry-run), never through npm run: npm eats --dry-run before the script
// sees it.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BUMPS = ['patch', 'minor', 'major']
const RELEASE_BRANCH = 'main'
const WORKFLOW = 'deploy.yml'
const PROD_URL = 'https://psychonek.github.io/video-repair/'
// Fast tiers only: types and unit tests. `node --run` avoids spawning npm.cmd on Windows.
const CHECKS = [['node', ['--run', 'check']]]
const WATCH_POLLS = 720 // 720 * 5s = 1h, then give up rather than hang

const bump = process.argv[2]
const skipChecks = process.argv.includes('--skip-checks')
const dryRun = process.argv.includes('--dry-run')
const noWatch = process.argv.includes('--no-watch')
const assumeYes = process.argv.includes('--yes')

if (!BUMPS.includes(bump)) {
  fail(`Usage: node scripts/release.mjs <${BUMPS.join('|')}> [--skip-checks] [--dry-run] [--no-watch] [--yes]`)
}

function fail(message) {
  console.error(`\n${red('release:')} ${message}\n`)
  process.exit(1)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== RELEASE_BRANCH) fail(`releases are cut from ${RELEASE_BRANCH}, not ${branch}`)

// The release commit is `git add -A`, so anything dirty ships inside it and
// nobody reads that diff. Commit or stash first.
const dirty = git('status', '--porcelain')
if (dirty && !dryRun) fail(`working tree is not clean - commit or stash first:\n\n${dirty}`)

console.log('Fetching origin...')
execFileSync('git', ['fetch', '--quiet', 'origin', RELEASE_BRANCH, '--tags'], { stdio: 'inherit' })

const behind = Number(git('rev-list', '--count', `HEAD..origin/${RELEASE_BRANCH}`))
if (behind > 0) fail(`local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin - pull first`)

const latest = git('tag', '--list', 'v*', '--sort=-version:refname').split('\n')[0] || 'v0.0.0'
const [major, minor, patch] = latest.replace(/^v/, '').split('.').map(Number)
if ([major, minor, patch].some((part) => !Number.isInteger(part))) {
  fail(`cannot parse the latest tag: ${latest}`)
}

const next =
  bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
const tag = `v${next}`

if (git('tag', '--list', tag)) fail(`${tag} already exists`)

console.log(`Releasing ${latest} -> ${tag} (${bump})`)

// Typing the command is the confirmation. A pipe, a CI job or a wrapper that
// ate the flags is not.
if (!dryRun && !assumeYes && !process.stdin.isTTY) {
  fail(`refusing to release ${tag} without a terminal. Pass --yes if this is deliberate.`)
}

const manifestPath = new URL('../package.json', import.meta.url)
const manifest = readFileSync(manifestPath, 'utf8')
const versionField = /("version":\s*)"[^"]+"/
if (!versionField.test(manifest)) fail('could not find the version field in package.json')

// Before the gate: --dry-run answers "which version would this cut", and that
// answer must cost a second, not a full check run.
if (dryRun) {
  console.log(`\ndry run: would set version ${next}, commit, tag ${tag} and push to origin/${RELEASE_BRANCH}`)
  console.log(`dry run: checks not run - ${CHECKS.map(([c, a]) => [c, ...a].join(' ')).join(', ')}\n`)
  process.exit(0)
}

if (skipChecks) {
  console.log('Skipping checks (--skip-checks)')
} else {
  console.log('Running checks...')
  for (const [command, args] of CHECKS) run(command, args)
}

writeFileSync(manifestPath, manifest.replace(versionField, `$1"${next}"`))

run('git', ['add', '-A'])
run('git', ['commit', '-m', `chore(release): ${tag}`])
run('git', ['tag', '-a', tag, '-m', tag])

const sha = git('rev-parse', '--short', 'HEAD')
console.log(`\nReleased ${latest} -> ${tag}  (commit ${sha}, tag ${tag})`)

// Two pushes, not --follow-tags: a combined push has landed the tag without
// GitHub raising a tag event, and the deploy workflow never started.
console.log(`\nPushing ${RELEASE_BRANCH}...`)
run('git', ['push', 'origin', RELEASE_BRANCH])
console.log(`Pushing ${tag}...`)
run('git', ['push', 'origin', tag])

if (noWatch) {
  console.log(`\n${tag} pushed. Follow it with: gh run list --branch ${tag}\n`)
  process.exit(0)
}

console.log('\nWaiting for the deploy workflow to start...')

let runId = ''
let ghMissing = false
for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
  const found = spawnSync(
    'gh',
    ['run', 'list', '--workflow', WORKFLOW, '--branch', tag, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // empty'],
    { encoding: 'utf8' },
  )
  if (found.error) {
    ghMissing = true
    break
  }
  runId = (found.stdout || '').trim()
  if (!runId) sleep(2000)
}

if (!runId) {
  console.log(
    ghMissing
      ? `\n${tag} pushed. gh is not installed here, so nothing to watch - follow it in the Actions tab.\n`
      : `\n${tag} pushed, but no deploy run appeared. Check: gh run list --branch ${tag}\n`,
  )
  process.exit(0)
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'url', '--jq', '.url'], { encoding: 'utf8' })
const runUrl = repo.status === 0 ? `  ${repo.stdout.trim()}/actions/runs/${runId}` : ''
console.log(`Watching run ${runId}${runUrl}`)

const outcome = watchRun(runId, tag)
if (outcome !== 'success') {
  console.error(`\nrelease: Deploy ${outcome === 'timeout' ? 'did not finish within the watch window' : `failed (${outcome})`}. Logs:\n`)
  console.error(`  gh run view ${runId} --log-failed\n`)
  console.error('GitHub Pages keeps serving the previous deployment until a new one succeeds.')
  console.error('Fix and cut the next patch to roll forward.\n')
  process.exit(1)
}

console.log(`\nDeployed ${tag}. ${PROD_URL}\n`)

// Colour and glyphs only when a human is watching: a redirected log or NO_COLOR
// gets the same text plain, and the glyphs fall back to ASCII outside UTF-8.
// Function declarations, not const arrows: this block sits below its call sites.
function paint(code, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text
  return `\u001b[${code}m${text}\u001b[0m`
}

function bold(text) {
  return paint('1', text)
}

function dim(text) {
  return paint('2', text)
}

function green(text) {
  return paint('32', text)
}

function red(text) {
  return paint('31', text)
}

function yellow(text) {
  return paint('33', text)
}

function cyan(text) {
  return paint('36', text)
}

function glyph(name) {
  const utf8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '')
  if (name === 'ok') return utf8 ? '✓' : 'ok'
  if (name === 'fail') return utf8 ? '✗' : 'X'
  if (name === 'dot') return utf8 ? '·' : '-'
  if (name === 'skipped') return '-'
  return '*'
}

// `var`, not `let`: this sits below its first use, and a `let` would still be
// in its temporal dead zone when the first log() runs.
var statusLine = ''

function status(text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR || text === statusLine) return
  process.stderr.write(`\r\u001b[2K${dim(text)}`)
  statusLine = text
}

function clearStatus() {
  if (!statusLine) return
  process.stderr.write('\r\u001b[2K')
  statusLine = ''
}

function log(text = '') {
  clearStatus()
  console.log(text)
}

function symbol(conclusion) {
  if (conclusion === 'success') return green(glyph('ok'))
  if (conclusion === 'skipped') return dim(glyph('skipped'))
  if (conclusion === null || conclusion === undefined) return yellow(glyph('running'))
  return red(glyph('fail'))
}

function outcomeWord(conclusion) {
  if (conclusion === 'success') return green('ok')
  if (conclusion === 'skipped') return dim('skipped')
  if (conclusion === null || conclusion === undefined) return yellow('done')
  return red(conclusion)
}

function elapsed(startedAt, completedAt) {
  if (!startedAt || !completedAt) return ''
  const seconds = Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const text = seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`
  return ` ${dim(`(${text})`)}`
}

/** Follows a workflow run by polling; append-only output, capped at WATCH_POLLS. */
function watchRun(id, label) {
  const seen = new Set()
  let announcedQueue = false
  let printedHeader = false

  for (let poll = 0; poll < WATCH_POLLS; poll += 1) {
    const out = spawnSync('gh', ['run', 'view', String(id), '--json', 'status,conclusion,jobs,displayTitle,workflowName,event,url'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })

    if (out.status === 0) {
      let data
      try {
        data = JSON.parse(out.stdout || '{}')
      } catch {
        data = {}
      }

      if (!printedHeader && data.workflowName) {
        printedHeader = true
        log(`\n${yellow(glyph('running'))} ${bold(data.displayTitle || label)} ${data.workflowName} ${dim(glyph('dot'))} ${cyan(String(id))}`)
        log(dim(`Triggered via ${data.event || 'push'}`))
        if (data.url) log(dim(data.url))
        log(`\n${bold('JOBS')}`)
      }

      const jobs = data.jobs ?? []
      if (!jobs.length && !announcedQueue) {
        announcedQueue = true
        log(dim('  queued...'))
      }

      let running = ''
      for (const job of jobs) {
        const startKey = `start:${job.name}`
        if (job.status !== 'queued' && !seen.has(startKey)) {
          seen.add(startKey)
          log(`\n${yellow(glyph('running'))} ${bold(job.name)}` + (job.databaseId ? ` ${dim('(ID')} ${cyan(String(job.databaseId))}${dim(')')}` : ''))
        }
        for (const step of job.steps ?? []) {
          const key = `${job.name}#${step.number}`
          if (step.status === 'completed' && !seen.has(key)) {
            seen.add(key)
            log(`  ${symbol(step.conclusion)} ${step.name}` + elapsed(step.startedAt, step.completedAt))
          } else if (step.status === 'in_progress' && !running) {
            running = `  ${glyph('running')} ${job.name}: ${step.name}`
          }
        }
        const doneKey = `done:${job.name}`
        if (job.status === 'completed' && !seen.has(doneKey)) {
          seen.add(doneKey)
          log(`  ${symbol(job.conclusion)} ${bold(job.name)}: ${outcomeWord(job.conclusion)}` + elapsed(job.startedAt, job.completedAt))
        }
      }

      if (data.status === 'completed') {
        clearStatus()
        log(`\n${symbol(data.conclusion)} Run ${cyan(String(id))}: ${outcomeWord(data.conclusion)}`)
        return data.conclusion
      }

      status(running || '  waiting for a runner')
    }

    sleep(5000)
  }

  clearStatus()
  return 'timeout'
}
