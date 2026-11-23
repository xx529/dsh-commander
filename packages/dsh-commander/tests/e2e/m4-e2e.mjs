#!/usr/bin/env node
/**
 * M4 P1 原生壳隔离 e2e：隔离 DSH web profile + 本插件，验证
 *  - Host 真的拉起 Tauri 壳、health.nativeShell=running、pid 可读；
 *  - 壳被杀后 supervisor 退避重启；
 *  - Host 停止后壳随之退出；
 *  - `ui.nativeShell=false` 保存后重启 Host → nativeShell=disabled（不拉起壳）。
 *
 * 只写 tests/artifacts/m4/e2e/**；不碰 live DSH（DSH_HOME 一次性目录）。
 * 前提：`pnpm --filter dsh-commander build && pnpm --filter dsh-commander build:native`。
 *
 * 用法：node packages/dsh-commander/tests/e2e/m4-e2e.mjs
 * 退出码：0=PASS；1=FAIL；2=环境/产物缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/m4/e2e')
const HOME = path.join(OUT, 'home')
const AGENTS = path.join(OUT, 'agents')
const PROFILE = 'm4e2e'
const checks = []
const add = (id, ok, evidence) => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? '') })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SAFE_UNSET = ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']
const env = () => {
  const next = { ...process.env, DSH_HOME: HOME, DSH_AGENTS_HOME: AGENTS, COMMANDER_BOOT_LOG: 'warn' }
  for (const key of SAFE_UNSET) delete next[key]
  delete next.DSH_COMMANDER_NATIVE_SHELL
  return next
}
const shellBinary = path.join(REPO, 'packages/dsh-commander/native/dist', `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`, 'dsh-commander-shell')

fs.mkdirSync(OUT, { recursive: true })

async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

async function health(base) {
  try {
    const response = await fetch(`${base}/commander/health`)
    if (response.status !== 200) return null
    return await response.json()
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const stop = async (child) => {
  if (child === null || child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitFor(() => child.exitCode !== null, 5_000, 100)
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function bootHost(label) {
  const log = path.join(OUT, `boot-${label}.out`)
  const errLog = path.join(OUT, `boot-${label}.err`)
  const child = spawn('dsh', ['--profile', PROFILE, '--port', '0', '--no-open'], { cwd: REPO, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk; fs.appendFileSync(log, chunk) })
  child.stderr.on('data', (chunk) => { stderr += chunk; fs.appendFileSync(errLog, chunk) })
  const match = await waitFor(() => stdout.match(/^dsh web: (http:\/\/[^\s?]+)/m), 30_000, 100)
  const base = match ? match[1].replace(/\/$/, '') : ''
  if (base !== '') await waitFor(async () => (await health(base)) !== null, 30_000, 200)
  return { child, base, stdout: () => stdout, stderr: () => stderr }
}

async function putJson(base, pathname, payload) {
  const response = await fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json().catch(() => null) }
}

try {
  if (!fs.existsSync(shellBinary)) {
    console.error(`missing shell binary: ${shellBinary}`)
    console.error('run: pnpm --filter dsh-commander build:native')
    process.exit(2)
  }
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(AGENTS, { recursive: true })

  const init = spawnSyncOk('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-default-config'])
  add('env init isolated web profile', init.ok, init.evidence)
  const install = spawnSyncOk('dsh', ['plugin', '--profile', PROFILE, 'add', `file:${REPO}/packages/dsh-commander`])
  add('env install local package', install.ok, install.evidence)

  const first = await bootHost('first')
  add('boot web host', first.base !== '', first.base || 'no dsh web url')

  const running = first.base === '' ? null : await waitFor(async () => {
    const body = await health(first.base)
    return body?.nativeShell === 'running' ? body : null
  }, 45_000, 250)
  add('health.nativeShell=running', running !== null, running === null ? 'timeout' : JSON.stringify(running))

  const beforePid = typeof running?.nativeShellPid === 'number' ? running.nativeShellPid : 0
  add('shell pid reported', beforePid > 0, `pid=${beforePid}`)
  add('shell process alive', beforePid > 0 && alive(beforePid), `pid=${beforePid}`)

  if (beforePid > 0) {
    process.kill(beforePid, 'SIGKILL')
    const restarted = await waitFor(async () => {
      const body = await health(first.base)
      const pid = typeof body?.nativeShellPid === 'number' ? body.nativeShellPid : 0
      return body?.nativeShell === 'running' && pid > 0 && pid !== beforePid ? body : null
    }, 25_000, 250)
    add('shell restarts after crash', restarted !== null, restarted === null ? 'timeout' : `pid=${restarted.nativeShellPid}`)
  } else {
    add('shell restarts after crash', false, 'no shell pid')
  }

  const toggle = first.base === '' ? { status: 0 } : await putJson(first.base, '/commander/config', { ui: { nativeShell: false }, requestId: 'm4-e2e-native-off' })
  add('PUT ui.nativeShell=false', toggle.status === 200, `http=${toggle.status}`)

  await stop(first.child)
  const exited = await waitFor(() => (beforePid > 0 && !alive(beforePid) ? true : null), 8_000, 300)
  add('shell exits after host stops', exited === true, `pid=${beforePid} alive=${beforePid > 0 ? alive(beforePid) : 'n/a'}`)

  const second = await bootHost('second')
  const disabled = second.base === '' ? null : await waitFor(async () => {
    const body = await health(second.base)
    return body?.nativeShell === 'disabled' ? body : null
  }, 20_000, 250)
  add('ui.nativeShell=false -> disabled after restart', disabled !== null, disabled === null ? 'timeout' : JSON.stringify(disabled))

  await stop(second.child)

  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2))
  const failed = checks.filter((check) => !check.ok)
  for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
  console.log(`\n汇总：${checks.length - failed.length}/${checks.length} PASS，${failed.length} FAIL`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`[m4-e2e] crashed: ${String(error?.stack ?? error)}`)
  process.exit(1)
}

function spawnSyncOk(bin, args) {
  try {
    const stdout = execFileSync(bin, args, { cwd: REPO, env: env(), encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, evidence: `exit=0 ${String(stdout).trim().slice(0, 120)}` }
  } catch (error) {
    return { ok: false, evidence: `exit=${error?.status ?? '?'} ${String(error?.stderr ?? '').trim().slice(0, 200)}` }
  }
}
