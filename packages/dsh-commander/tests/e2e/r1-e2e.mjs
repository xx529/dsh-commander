#!/usr/bin/env node
/**
 * R1 会话轮换 e2e（隔离 profile；不碰 live）。
 *
 * 证明：启用轮换后 `POST /commander/rotation force` 全链路（create → inject → config → retired）、
 * 快照/只读接口回显、关闭态拒绝、重启后代际持久化。
 * 只写 tests/artifacts/r1/e2e/**。
 *
 * 用法：node packages/dsh-commander/tests/e2e/r1-e2e.mjs
 * 退出码：0=全 PASS；1=有 FAIL；2=环境/产物缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/r1/e2e')
const PROBE_ROOT = path.join(OUT, 'probe-root')
const DSH_HOME = path.join(PROBE_ROOT, 'home')
const DSH_AGENTS_HOME = path.join(PROBE_ROOT, 'agents')
const PROFILE = 'r1e2e'
const WS_PATH = path.join(PROBE_ROOT, 'ws-r1e2e')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const checks = []
const add = (id, ok, evidence) => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? '') })
const cmdLog = []
const record = (line) => cmdLog.push(line)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const SAFE_UNSET = ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']
const childEnv = () => {
  const env = { ...process.env, DSH_COMMANDER_NATIVE_SHELL: '0', DSH_HOME, DSH_AGENTS_HOME }
  for (const key of SAFE_UNSET) delete env[key]
  return env
}
const run = (bin, args, opts = {}) => {
  record(`$ ${bin} ${args.join(' ')}`)
  try {
    const stdout = execFileSync(bin, args, { cwd: REPO, env: childEnv(), encoding: 'utf8', timeout: opts.timeout ?? 180000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout }
  } catch (error) {
    record(`  -> exit=${error?.status ?? '?'} stderr=${String(error?.stderr ?? '').slice(0, 400)}`)
    return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}
const getJson = async (base, pathname) => {
  const res = await fetch(`${base}${pathname}`)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
const postJson = async (base, pathname, payload) => {
  const res = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
const putJson = async (base, pathname, payload) => {
  const res = await fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
const boot = async (name) => {
  const out = path.join(OUT, `boot-${name}.out`)
  const err = path.join(OUT, `boot-${name}.err`)
  const child = spawn('dsh', ['--profile', PROFILE, '--port', '0', '--no-open'], { cwd: REPO, env: { ...childEnv(), COMMANDER_BOOT_LOG: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] })
  record(`$ dsh --profile ${PROFILE} --port 0 --no-open   # boot ${name}`)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk; fs.appendFileSync(out, chunk) })
  child.stderr.on('data', (chunk) => { stderr += chunk; fs.appendFileSync(err, chunk) })
  let base = ''
  for (let i = 0; i < 240; i += 1) {
    const match = stdout.match(/^dsh web: (http:\/\/[^\s?]+)/m)
    if (match) { base = match[1].replace(/\/$/, ''); break }
    await sleep(150)
  }
  if (!base) return { child, base: '', stdout, stderr }
  let ready = false
  for (let i = 0; i < 300; i += 1) {
    const probe = await getJson(base, '/commander/health').catch(() => null)
    if (probe?.status === 200) { ready = true; break }
    await sleep(150)
  }
  record(`## boot ${name} ready=${ready} base=${base}`)
  return { child, base, stdout, stderr, ready }
}
const stop = async (child) => {
  if (child === null || child.exitCode !== null) return
  child.kill('SIGTERM')
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break
    await sleep(100)
  }
  if (child.exitCode === null) child.kill('SIGKILL')
}

let boot1 = null
try {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(WS_PATH, { recursive: true })
  const libHost = path.join(REPO, 'packages/dsh-commander/lib/host/index.js')
  const libClient = path.join(REPO, 'packages/dsh-commander/lib/client.js')
  if (!fs.existsSync(libHost) || !fs.existsSync(libClient)) {
    console.error('missing build artifacts packages/dsh-commander/lib/**（先 pnpm --filter dsh-commander build）')
    process.exit(2)
  }
  record(`## lib/host/index.js sha256=${sha256(fs.readFileSync(libHost))}`)
  record(`## lib/client.js sha256=${sha256(fs.readFileSync(libClient))}`)
  record(`## env dsh=${execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim()} node=${process.version} probeRoot=${PROBE_ROOT}`)

  fs.rmSync(DSH_HOME, { recursive: true, force: true })
  fs.rmSync(DSH_AGENTS_HOME, { recursive: true, force: true })
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.mkdirSync(DSH_AGENTS_HOME, { recursive: true })
  const init = run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-default-config'])
  add('env init isolated web profile', init.ok, `exit=${init.ok ? 0 : 'non-zero'}`)
  const addPlugin = run('dsh', ['plugin', '--profile', PROFILE, 'add', `file:${REPO}/packages/dsh-commander`], { timeout: 180000 })
  add('env install local package into isolated profile', addPlugin.ok, addPlugin.ok ? 'dsh plugin add exit=0' : 'dsh plugin add failed')

  boot1 = await boot('one')
  if (!boot1.base || boot1.ready !== true) {
    add('R1 boot with rotation bundled', false, `host boot 失败；stderr=${boot1.stderr.slice(0, 300)}`)
    throw new Error('boot failed')
  }
  add('R1 health 200', true, `base=${boot1.base}`)

  // 1) 绑定一个指挥官会话（cwd 分支）
  const bind = await postJson(boot1.base, '/commander/binding', { mode: 'new', cwd: WS_PATH, requestId: 'req_r1_bind' })
  fs.writeFileSync(path.join(OUT, 'binding.json'), JSON.stringify(bind, null, 2))
  const oldSessionId = bind.body?.binding?.sessionId ?? ''
  add('R1 绑定新会话成功', bind.status === 200 && oldSessionId !== '', `http=${bind.status} session=${oldSessionId}`)

  // 2) 打开轮换
  const enable = await putJson(boot1.base, '/commander/config', { requestId: 'req_r1_enable', commander: { rotation: { enabled: true, periodDays: 1, includeUserTail: true } } })
  fs.writeFileSync(path.join(OUT, 'config-enable.json'), JSON.stringify(enable, null, 2))
  add('R1 启用轮换（PUT config）', enable.status === 200 && enable.body?.config?.commander?.rotation?.enabled === true, `http=${enable.status} rotation=${JSON.stringify(enable.body?.config?.commander?.rotation)}`)
  const stateBefore = await getJson(boot1.base, '/commander/state')
  fs.writeFileSync(path.join(OUT, 'state-before.json'), JSON.stringify(stateBefore, null, 2))
  add('R1 快照 rotation 初始代际=1 且未 due', stateBefore.body?.rotation?.enabled === true && stateBefore.body?.rotation?.generation === 1 && stateBefore.body?.rotation?.due === false, `rotation=${JSON.stringify(stateBefore.body?.rotation)}`)

  // 3) 手动强制换任
  const rotate = await postJson(boot1.base, '/commander/rotation', { requestId: 'req_r1_rotate', force: true })
  fs.writeFileSync(path.join(OUT, 'rotation.json'), JSON.stringify(rotate, null, 2))
  const newSessionId = rotate.body?.sessionId ?? ''
  add('R1 force 换任成功（create→inject→config→retired）', rotate.status === 200 && rotate.body?.rotated === true && newSessionId !== '' && newSessionId !== oldSessionId, `http=${rotate.status} rotated=${rotate.body?.rotated} from=${oldSessionId} to=${newSessionId}`)
  add('R1 简报已生成（brief.chars>0）', typeof rotate.body?.brief?.chars === 'number' && rotate.body.brief.chars > 0, `brief=${JSON.stringify(rotate.body?.brief)}`)

  // 4) 提交后的快照/配置/退役记录
  const stateAfter = await getJson(boot1.base, '/commander/state')
  fs.writeFileSync(path.join(OUT, 'state-after.json'), JSON.stringify(stateAfter, null, 2))
  add('R1 快照：绑定已切到新会话、代际=2', stateAfter.body?.binding?.sessionId === newSessionId && stateAfter.body?.rotation?.generation === 2, `binding=${stateAfter.body?.binding?.sessionId} generation=${stateAfter.body?.rotation?.generation}`)
  add('R1 快照：formerCommanders 含旧会话', Array.isArray(stateAfter.body?.formerCommanders) && stateAfter.body.formerCommanders.some((item) => item.sessionId === oldSessionId), `former=${JSON.stringify(stateAfter.body?.formerCommanders)}`)
  const cfgAfter = await getJson(boot1.base, '/commander/config')
  add('R1 配置视图回显代际=2', cfgAfter.body?.config?.commander?.rotation?.generation === 2, `rotation=${JSON.stringify(cfgAfter.body?.config?.commander?.rotation)}`)
  const transcript = await getJson(boot1.base, `/commander/session-transcript?sessionId=${encodeURIComponent(oldSessionId)}&limit=5`)
  fs.writeFileSync(path.join(OUT, 'transcript-old.json'), JSON.stringify(transcript, null, 2))
  add('R1 前任会话仍可只读查看（session-transcript 200）', transcript.status === 200 && transcript.body?.ok === true, `http=${transcript.status}`)

  // 5) 关闭态拒绝
  const disable = await putJson(boot1.base, '/commander/config', { requestId: 'req_r1_disable', commander: { rotation: { enabled: false } } })
  add('R1 关闭轮换（PUT config）', disable.status === 200 && disable.body?.config?.commander?.rotation?.enabled === false, `http=${disable.status}`)
  const blocked = await postJson(boot1.base, '/commander/rotation', { requestId: 'req_r1_blocked', force: true })
  fs.writeFileSync(path.join(OUT, 'rotation-disabled.json'), JSON.stringify(blocked, null, 2))
  add('R1 关闭态 POST rotation → 409 rotation_disabled', blocked.status === 409 && blocked.body?.code === 'rotation_disabled', `http=${blocked.status} code=${blocked.body?.code}`)
  const fatal1 = /(FATAL|did not activate|Cannot find module|uncaught)/i.test(boot1.stderr)
  add('R1 host stderr 无致命错误', !fatal1 && boot1.child.exitCode === null, `stderr_bytes=${boot1.stderr.length} fatal=${fatal1}`)

  // 6) 重启：代际与绑定持久化
  await stop(boot1.child)
  boot1 = null
  const boot2 = await boot('two')
  if (!boot2.base || boot2.ready !== true) {
    add('R1 重启后 boot', false, `boot2 失败；stderr=${boot2.stderr.slice(0, 300)}`)
    throw new Error('boot2 failed')
  }
  const state2 = await getJson(boot2.base, '/commander/state')
  fs.writeFileSync(path.join(OUT, 'state-boot2.json'), JSON.stringify(state2, null, 2))
  add('R1 重启后：绑定仍指向新会话', state2.body?.binding?.sessionId === newSessionId, `boot2=${state2.body?.binding?.sessionId}`)
  add('R1 重启后：代际=2 持久化', state2.body?.rotation?.generation === 2 && state2.body?.rotation?.enabled === false, `generation=${state2.body?.rotation?.generation} enabled=${state2.body?.rotation?.enabled}`)
  add('R1 重启后：前任会话仍是 retired', Array.isArray(state2.body?.formerCommanders) && state2.body.formerCommanders.some((item) => item.sessionId === oldSessionId), `former=${JSON.stringify(state2.body?.formerCommanders)}`)
  await stop(boot2.child)
} catch (error) {
  record(`## FATAL ${String(error?.stack ?? error)}`)
} finally {
  if (boot1 !== null) await stop(boot1.child)
  fs.writeFileSync(path.join(OUT, 'commands.log'), `${cmdLog.join('\n')}\n`)
}

const failed = checks.filter((check) => !check.ok)
const summary = { generatedAt: new Date().toISOString(), role: 'R1 e2e', checks, summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length } }
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
console.log(`R1 轮换 e2e（证据：${path.relative(REPO, OUT)}）`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
console.log(`\n汇总：${checks.length - failed.length}/${checks.length} PASS，${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
