// Run with: node --test tests/bridge.test.mjs
// The daemon over a fake `codex app-server` that echoes the notifications a `test/emit` request carries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE = fileURLToPath(new URL('../bin/bridge.mjs', import.meta.url))
const HOLD_MS = 300
const FAKE_CODEX = `#!/usr/bin/env node
import readline from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'test/emit') message.params.messages.forEach(send)
  if (message.id !== undefined) send({ id: message.id, result: {} })
}).on('close', () => process.exit(0))
`

const call = (address, method, urlPath, body) => new Promise((resolve, reject) => {
  // http.request(url, options) takes a URL first; a Unix socket goes in the options alone.
  const req = http.request(...(address.startsWith('http') ? [new URL(address + urlPath), { method }] : [{ socketPath: address, path: urlPath, method }]), res => {
    let data = ''
    res.on('data', chunk => (data += chunk))
    res.on('end', () => resolve(JSON.parse(data)))
  })
  req.on('error', reject)
  req.end(body === undefined ? undefined : JSON.stringify(body))
})

const note = (method, params) => ({ method, params })
const turn = (threadId, id, status, extra = {}) => note('turn/completed', { threadId, turn: { id, status, items: [], ...extra } })

test('a failed turn end is held back and dropped when the thread works on; a real failure ends after the hold', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-1')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], {
    stdio: 'ignore', windowsHide: true, env: { ...process.env, CODEX_BRIDGE_FAILED_HOLD_MS: String(HOLD_MS) },
  })
  try {
    const file = path.join(dir, 's')
    let address = ''
    for (let i = 0; i < 100 && !address; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
        if ((await call(candidate, 'GET', '/health')).ok) address = candidate
      } catch {}
    }
    assert.ok(address, 'the daemon did not start')
    const emit = messages => call(address, 'POST', '/rpc', { method: 'test/emit', params: { messages } })
    const wait = (threadId, timeoutMs) => call(address, 'POST', '/wait', { threadId, timeoutMs })
    const capacity = { message: 'Selected model is at capacity. Please try a different model.' }

    // Codex reports the turn failed, then works on in it: the failure never reaches a waiter.
    await emit([
      note('turn/started', { threadId: 'th-1', turn: { id: 't1' } }),
      note('error', { threadId: 'th-1', turnId: 't1', willRetry: false, error: capacity }),
      turn('th-1', 't1', 'failed', { error: capacity }),
      note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'commandExecution', command: 'blender -b' } }),
    ])
    assert.equal((await wait('th-1', HOLD_MS * 3)).status, 'timeout')
    await emit([turn('th-1', 't1', 'completed')])
    assert.equal((await wait('th-1', 1000)).turn.status, 'completed')

    // Work after an ended turn: the thread is followed as running again.
    await emit([note('item/started', { threadId: 'th-1', turnId: 't1', item: { type: 'reasoning' } })])
    assert.deepEqual((await call(address, 'GET', '/health')).active, { 'th-1': 't1' })

    // A failure with no work after it ends the turn once the hold passes.
    const startedAt = Date.now()
    await emit([note('turn/started', { threadId: 'th-2', turn: { id: 't2' } }), turn('th-2', 't2', 'failed', { error: capacity })])
    const failed = await wait('th-2', 5000)
    assert.deepEqual([failed.status, failed.turn.status, failed.turn.error], ['completed', 'failed', capacity])
    assert.ok(Date.now() - startedAt >= HOLD_MS - 50)
  } finally {
    daemon.kill()
    await new Promise(resolve => setTimeout(resolve, 300))
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a relay whose Codex CLI does not run says so and what to do in its first line, then exits 1', async () => {
  const relay = spawn(process.execPath, [BRIDGE, path.join(os.tmpdir(), 'no-such-codex-cli'), 'relaytest'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let stdout = ''
  relay.stdout.on('data', chunk => (stdout += chunk))
  const code = await new Promise(resolve => relay.on('exit', resolve))
  const first = JSON.parse(stdout.split('\n')[0])
  assert.equal(code, 1)
  assert.equal(first.type, 'fatal')
  assert.match(first.message, /cannot run the Codex CLI .*no-such-codex-cli/)
  assert.match(first.message, /npm i -g @openai\/codex@latest/)
})

test('/handoff/init excludes .handoff/ once per worktree, for linked worktrees too; /handoff/spill writes the full text', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-2')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], { stdio: 'ignore', windowsHide: true })
  try {
    const file = path.join(dir, 's')
    let address = ''
    for (let i = 0; i < 100 && !address; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
        if ((await call(candidate, 'GET', '/health')).ok) address = candidate
      } catch {}
    }
    assert.ok(address, 'the daemon did not start')
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(base, 'repo-')))
    git(repo, 'init', '-q')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'x')
    const linked = path.join(base, 'linked')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    for (const cwd of [repo, repo, linked, linked]) await call(address, 'POST', '/handoff/init', { cwd })
    assert.equal(fs.readFileSync(exclude, 'utf8').split('\n').filter(line => line === '.handoff/').length, 1)
    assert.ok(fs.existsSync(path.join(linked, '.handoff')))
    assert.equal(git(linked, 'status', '--porcelain'), '')
    assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false)
    // Not a git repo: the dir is made, nothing else.
    const plain = fs.mkdtempSync(path.join(base, 'plain-'))
    assert.ok((await call(address, 'POST', '/handoff/init', { cwd: plain })).ok)
    assert.ok(fs.existsSync(path.join(plain, '.handoff')))
    // Spill writes the whole text.
    const text = 'z'.repeat(30_000)
    const spilled = await call(address, 'POST', '/handoff/spill', { cwd: repo, job: 'a1', text })
    assert.equal(spilled.path, path.join(repo, '.handoff', 'a1.spill.md'))
    assert.equal(fs.readFileSync(spilled.path, 'utf8'), text)
    assert.ok((await call(address, 'POST', '/handoff/spill', { cwd: repo, job: '../x', text })).error)
  } finally {
    daemon.kill()
  }
})

test('/git/head reports HEAD and linked-worktree state; /git/commits lists commits since a sha', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-3')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], { stdio: 'ignore', windowsHide: true })
  try {
    const file = path.join(dir, 's')
    let address = ''
    for (let i = 0; i < 100 && !address; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
        if ((await call(candidate, 'GET', '/health')).ok) address = candidate
      } catch {}
    }
    assert.ok(address, 'the daemon did not start')
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(base, 'repo-')))
    git(repo, 'init', '-q')
    git(repo, 'commit', '--allow-empty', '-qm', 'first')
    const linked = path.join(base, 'linked')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')
    const main = await call(address, 'POST', '/git/head', { cwd: repo })
    assert.deepEqual([main.head, main.linked], [git(repo, 'rev-parse', 'HEAD'), false])
    assert.equal((await call(address, 'POST', '/git/head', { cwd: linked })).linked, true)
    // A subdirectory of the main checkout is still the main checkout.
    fs.mkdirSync(path.join(repo, 'sub'))
    assert.equal((await call(address, 'POST', '/git/head', { cwd: path.join(repo, 'sub') })).linked, false)
    const plain = fs.mkdtempSync(path.join(base, 'plain-'))
    assert.deepEqual(await call(address, 'POST', '/git/head', { cwd: plain }), { head: null, linked: false })
    // Commits since the recorded HEAD, with their full messages.
    git(repo, 'commit', '--allow-empty', '-qm', 'second\n\nco-authored-by: Someone <s@x.y>')
    git(repo, 'commit', '--allow-empty', '-qm', 'third')
    const listed = (await call(address, 'POST', '/git/commits', { cwd: repo, since: main.head })).commits
    assert.deepEqual(listed.map(c => c.message.split('\n')[0]), ['second', 'third'])
    assert.match(listed[0].message, /co-authored-by/i)
    assert.deepEqual((await call(address, 'POST', '/git/commits', { cwd: plain, since: main.head })).commits, [])
    assert.ok((await call(address, 'POST', '/git/commits', { cwd: repo, since: 'nope' })).error)
  } finally {
    daemon.kill()
  }
})

test('/fs/resolve expands ~ and relative paths, follows symlinks, and reports the git common dir', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
  const dir = path.join(base, 'd-4')
  fs.mkdirSync(dir)
  const fake = path.join(base, 'fake-codex.mjs')
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 })
  const daemon = spawn(process.execPath, [BRIDGE, '--daemon', fake, dir], { stdio: 'ignore', windowsHide: true })
  try {
    const file = path.join(dir, 's')
    let address = ''
    for (let i = 0; i < 100 && !address; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try {
        const candidate = process.platform === 'win32' ? fs.readFileSync(file, 'utf8') : file
        if ((await call(candidate, 'GET', '/health')).ok) address = candidate
      } catch {}
    }
    assert.ok(address, 'the daemon did not start')
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(base, 'repo-')))
    git(repo, 'init', '-q')
    git(repo, 'commit', '--allow-empty', '-qm', 'first')
    const linked = path.join(base, 'linked')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'other')
    const resolve = (p, b = base) => call(address, 'POST', '/fs/resolve', { path: p, base: b })
    const main = await resolve(repo)
    assert.deepEqual([main.real, main.dir, main.common], [repo, true, path.join(repo, '.git')])
    // A linked worktree shares the main checkout's common dir.
    assert.equal((await resolve(linked)).common, main.common)
    // Relative to base, and through a symlink.
    assert.equal((await resolve(path.basename(repo))).real, repo)
    fs.symlinkSync(repo, path.join(base, 'link'))
    assert.equal((await resolve('link')).real, repo)
    // ~ is the home directory.
    assert.equal((await resolve('~')).real, fs.realpathSync(os.homedir()))
    // Not a directory, missing, not git.
    fs.writeFileSync(path.join(base, 'f.txt'), 'x')
    assert.deepEqual(await resolve('f.txt'), { real: fs.realpathSync(path.join(base, 'f.txt')), dir: false, common: null })
    assert.deepEqual(await resolve('nope'), { real: null, dir: false, common: null })
    const plain = fs.mkdtempSync(path.join(base, 'plain-'))
    assert.equal((await resolve(plain)).common, null)
    assert.ok((await resolve('x', 'relative')).error)
  } finally {
    daemon.kill()
  }
})
