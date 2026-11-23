#!/usr/bin/env node
/**
 * M0-5 tester 独立隔离 e2e（task-32）：M0-4 面板缺失降级 / M0-3 绑定持久化 / M0-2 消息通道+SSE。
 *
 * 只写 tests/artifacts/m0/e2e/**；不碰 live DSH、不改实现/配置。
 * 复用：tools/validation/probes/stub-llm.mjs（确定性 stub provider，不联网）＋
 *       packages/dsh-commander/tests/e2e/probes/m0-e2e-probe.mjs（本任务新增：隔离工作区注册 + stub 注册）。
 * 依赖：packages/dsh-commander/lib/**（backend 构建产物；本脚本只读，构建缺失则 FAIL 并提示由 backend 构建）。
 *
 * 用法：node packages/dsh-commander/tests/e2e/m0-e2e.mjs
 * 退出码：0=全部自动化项 PASS；1=有 FAIL；2=环境/依赖缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/m0/e2e')
const PROBE_ROOT = path.join(OUT, 'probe-root')
const DSH_HOME = path.join(PROBE_ROOT, 'home')
const DSH_AGENTS_HOME = path.join(PROBE_ROOT, 'agents')
const PROFILE = 'm0e2e'
const WS_PATH = path.join(PROBE_ROOT, 'ws-m0e2e')
const PATCH = path.join(OUT, 'm0-e2e.patch.yml')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const checks = []
const add = (id, ok, evidence) => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? '') })
const cmdLog = []
const record = (line) => cmdLog.push(line)
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(WS_PATH, { recursive: true })
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
    record(`  -> exit=${error?.status ?? '?'} stderr=${String(error?.stderr ?? '').slice(0, 300)}`)
    return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
  const child = spawn('dsh', ['--profile', PROFILE, '--patch', PATCH, '--port', '0', '--no-open'], { cwd: REPO, env: { ...childEnv(), COMMANDER_BOOT_LOG: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] })
  record(`$ dsh --profile ${PROFILE} --patch ${PATCH} --port 0 --no-open   # boot ${name}`)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk; fs.appendFileSync(out, chunk) })
  child.stderr.on('data', (chunk) => { stderr += chunk; fs.appendFileSync(err, chunk) })
  let base = ''
  for (let i = 0; i < 200; i += 1) {
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
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) break
    await sleep(100)
  }
  if (child.exitCode === null) child.kill('SIGKILL')
}

try {
  // ---- 0) 依赖检查（lib 由 backend 构建；本脚本不构建/不改实现）
  const libHost = path.join(REPO, 'packages/dsh-commander/lib/host/index.js')
  const libClient = path.join(REPO, 'packages/dsh-commander/lib/client.js')
  if (!fs.existsSync(libHost) || !fs.existsSync(libClient)) {
    console.error('missing build artifacts packages/dsh-commander/lib/**（由 backend 构建；本测试只读）')
    process.exit(2)
  }
  record(`## lib/host/index.js sha256=${sha256(fs.readFileSync(libHost))}`)
  record(`## lib/client.js sha256=${sha256(fs.readFileSync(libClient))}`)
  {
    const pkg = readJson(path.join(REPO, 'packages/dsh-commander/package.json'))
    record(`## env dsh=${execFileSync('dsh', ['--version'], { encoding: 'utf8' }).trim()} node=${process.version} probeRoot=${PROBE_ROOT}`)
    record(`## package version=${pkg.version} exports=${JSON.stringify(pkg.exports)}`)
  }

  // ---- 1) 隔离 profile（web 模板，无 capabilityPanel → M0-4 absent 场景）
  fs.rmSync(path.join(PROBE_ROOT, 'home'), { recursive: true, force: true })
  fs.rmSync(path.join(PROBE_ROOT, 'agents'), { recursive: true, force: true })
  fs.mkdirSync(DSH_HOME, { recursive: true })
  fs.mkdirSync(DSH_AGENTS_HOME, { recursive: true })
  const init = run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-default-config'])
  add('M0-4/env init isolated web profile', init.ok, `exit=${init.ok ? 0 : 'non-zero'}`)
  // link CLI dsh-client-ui-chat（同 devops smoke 配方）
  try {
    const which = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()
    let cliDir = ''
    if (which) {
      const text = fs.readFileSync(which, 'utf8')
      const match = text.match(/["']([^"']*lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js)["']/)
      if (match) {
        const binjs = match[1].replaceAll('$HOME', process.env.HOME)
        if (fs.existsSync(binjs)) cliDir = path.dirname(path.dirname(binjs))
      }
    }
    const chat = path.join(cliDir, 'node_modules/@deepseek-ai/dsh-client-ui-chat')
    if (cliDir && fs.existsSync(chat)) {
      const target = path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules/@deepseek-ai')
      fs.mkdirSync(target, { recursive: true })
      fs.symlinkSync(chat, path.join(target, 'dsh-client-ui-chat'))
      record(`## linked CLI ui-chat: ${chat}`)
    }
  } catch (error) {
    record(`## WARN link ui-chat failed: ${String(error?.message ?? error)}`)
  }
  const addPlugin = run('dsh', ['plugin', '--profile', PROFILE, 'add', `file:${REPO}/packages/dsh-commander`], { timeout: 180000 })
  add('env install local package into isolated profile', addPlugin.ok, addPlugin.ok ? 'dsh plugin add exit=0' : 'dsh plugin add failed')

  // ---- 2) 探针覆盖层：注册隔离 workspace + probe-stub LLM
  const probeFile = path.join(HERE, 'probes/m0-e2e-probe.mjs')
  fs.writeFileSync(PATCH, `- insert:\n    - id: m0-e2e-probe\n      name: 'file://${probeFile}'\n      config:\n        repoRoot: '${REPO}'\n        workspacePath: '${WS_PATH}'\n`)
  add('env probe patch written (workspace fixture + stub provider)', fs.existsSync(PATCH), `patch=${path.relative(REPO, PATCH)}`)

  // ---- 3) boot1：M0-4 面板缺失降级
  let boot1 = await boot('one')
  if (!boot1.base) {
    add('M0-4 boot with capabilityPanel absent', false, `host boot 失败；stderr=${boot1.stderr.slice(0, 200)}`)
    throw new Error('boot1 failed')
  }
  const health1 = await getJson(boot1.base, '/commander/health')
  record(`## health boot1 http=${health1.status} panel=${health1.body?.panel} binding=${health1.body?.binding}`)
  fs.writeFileSync(path.join(OUT, 'health-boot1.json'), JSON.stringify(health1, null, 2))
  add('M0-4 health 200 + panel:absent + 不崩溃', boot1.ready === true && health1.status === 200 && health1.body?.ok === true && health1.body?.panel === 'absent', `ready=${boot1.ready} http=${health1.status} panel=${health1.body?.panel} binding=${health1.body?.binding}`)
  const fatalErr = /(FATAL|did not activate|Cannot find module|uncaught)/i.test(boot1.stderr)
  add('M0-4 host stderr 无致命错误（无 did not activate/FATAL）', !fatalErr && boot1.child.exitCode === null, `stderr_bytes=${boot1.stderr.length} fatal=${fatalErr}`)
  // 等 fixture workspace 创建（以 state.workspaces 轮询为准；探针 stdout 落盘时序不保证）
  let fixtureRegistered = false
  for (let i = 0; i < 100; i += 1) {
    const snapshot = await getJson(boot1.base, '/commander/state').catch(() => null)
    if ((snapshot?.body?.workspaces ?? []).length >= 1) { fixtureRegistered = true; break }
    await sleep(200)
  }
  add('env fixture workspace 已注册（state.workspaces 轮询）', fixtureRegistered, `state.workspaces=${fixtureRegistered ? '>=1' : 0}；probe_stdout=${(boot1.stdout.match(/\[m0-e2e-probe\][^\n]*/) ?? [''])[0]}`)

  // ---- 4) M0-3：binding 持久化（boot1 写 → boot2 读）
  const setModel0 = await putJson(boot1.base, '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, requestId: 'req_e2e_config_0' })
  fs.writeFileSync(path.join(OUT, 'config-put-before-binding.json'), JSON.stringify(setModel0, null, 2))
  add('env PUT /commander/config（binding 前设置 stub 模型）', setModel0.status === 200 && setModel0.body?.ok === true, `http=${setModel0.status}`)
  // 隔离 e2e 用 workspaceId（cwd 分支实测存在实现缺陷：bindNew 同时传 workspaceId+cwd 被 DSH session.create 拒绝 → 记录为审计发现）
  const stateBeforeBind = await getJson(boot1.base, '/commander/state')
  const ws = (stateBeforeBind.body?.workspaces ?? []).find((item) => item.path === WS_PATH) ?? (stateBeforeBind.body?.workspaces ?? [])[0]
  fs.writeFileSync(path.join(OUT, 'state-before-binding.json'), JSON.stringify(stateBeforeBind, null, 2))
  add('env state.workspaces 含 fixture 工作区', ws !== undefined, `workspaces=${(stateBeforeBind.body?.workspaces ?? []).length} wsId=${ws?.id}`)
  const cwdBind = await postJson(boot1.base, '/commander/binding', { mode: 'new', cwd: WS_PATH })
  fs.writeFileSync(path.join(OUT, 'binding-cwd-branch.json'), JSON.stringify(cwdBind, null, 2))
  add('M0-3（附加）binding cwd 分支可用性', cwdBind.status === 200, `http=${cwdBind.status} message=${cwdBind.body?.message ?? ''}（若失败：bindNew 同时传 workspaceId+cwd，属实现缺陷）`)
  const bind = await postJson(boot1.base, '/commander/binding', { mode: 'new', workspaceId: ws?.id })
  fs.writeFileSync(path.join(OUT, 'binding-boot1.json'), JSON.stringify(bind, null, 2))
  const binding1 = bind.body?.binding ?? {}
  add('M0-3 POST /commander/binding mode:new → bound + sessionId', bind.status === 200 && bind.body?.ok === true && typeof binding1.sessionId === 'string' && binding1.sessionId.length > 0, `http=${bind.status} workspaceId=${binding1.workspaceId} sessionId=${binding1.sessionId}`)
  // 设置 commander 模型为 stub（M0-2 assistant 回复需要）
  const setModel = await putJson(boot1.base, '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, requestId: 'req_e2e_config_1' })
  fs.writeFileSync(path.join(OUT, 'config-put.json'), JSON.stringify(setModel, null, 2))
  add('env PUT /commander/config 设置 stub 模型', setModel.status === 200 && setModel.body?.ok === true, `http=${setModel.status} model=${JSON.stringify(setModel.body?.config?.commander?.model)}`)

  // ---- 5) M0-2：SSE + POST /commander/message（user + assistant + status）
  const sseController = new AbortController()
  let sseBuffer = ''
  const sseDone = (async () => {
    try {
      const res = await fetch(`${boot1.base}/commander/state`, { headers: { accept: 'text/event-stream' }, signal: sseController.signal })
      record(`$ curl -sN -H 'accept: text/event-stream' '${boot1.base}/commander/state'   # http=${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        sseBuffer += decoder.decode(value, { stream: true })
      }
    } catch (error) {
      if (String(error?.name) !== 'AbortError') record(`## SSE error: ${String(error?.message ?? error)}`)
    }
  })()
  await sleep(500)
  const msg1 = await postJson(boot1.base, '/commander/message', { text: 'PROBE_V2_PLAIN m0-e2e', requestId: 'req_e2e_msg_1' })
  fs.writeFileSync(path.join(OUT, 'message-1.json'), JSON.stringify(msg1, null, 2))
  add('M0-2 POST /commander/message 200 + accepted', msg1.status === 200 && msg1.body?.ok === true && msg1.body?.accepted === true, `http=${msg1.status} accepted=${msg1.body?.accepted} queued=${msg1.body?.queued}`)
  let assistantSeen = false
  let statusSeen = false
  for (let i = 0; i < 160; i += 1) {
    assistantSeen = /event: commander\.message/.test(sseBuffer) && /probe-v2-plain-ok/.test(sseBuffer)
    statusSeen = /event: commander\.status/.test(sseBuffer)
    if (assistantSeen && statusSeen) break
    await sleep(150)
  }
  sseController.abort()
  await sseDone
  fs.writeFileSync(path.join(OUT, 'sse-capture.txt'), sseBuffer)
  add('M0-2 SSE commander.message（user）', /event: commander\.message/.test(sseBuffer) && /PROBE_V2_PLAIN/.test(sseBuffer), `sse_bytes=${sseBuffer.length}`)
  add('M0-2 SSE commander.message（assistant=stub 回复）', assistantSeen, assistantSeen ? 'stub assistant 文本已在 SSE 中' : '未收到 assistant（stub 未生效/回合失败）')
  add('M0-2 SSE commander.status（busy 状态迁移）', statusSeen, statusSeen ? '收到 commander.status 事件' : '未收到 commander.status')
  const stateAfterMsg = await getJson(boot1.base, '/commander/state')
  fs.writeFileSync(path.join(OUT, 'state-after-message.json'), JSON.stringify(stateAfterMsg, null, 2))
  const ringMessages = stateAfterMsg.body?.messages ?? []
  add('M0-2 消息环包含 user+assistant 消息', ringMessages.some((m) => m.role === 'user') && ringMessages.some((m) => m.role === 'assistant'), `messages=${ringMessages.map((m) => m.role).join(',')}`)
  const userMsg = ringMessages.find((m) => m.role === 'user')
  const assistantMsg = ringMessages.find((m) => m.role === 'assistant')
  add('M5 消息 order 顺序（user 在 assistant 之前，order 单调）', userMsg?.order === 1 && assistantMsg?.order === 2, `orders=${ringMessages.map((m) => `${m.role}:${m.order}`).join(',')}`)
  // M6 SSE 首帧 id = 快照 rev；后续事件 id 从 rev+1 递增
  const firstFrame = sseBuffer.match(/event: snapshot\nid: (\d+)\ndata: ([^\n]+)/)
  let sseIdOk = false
  let sseIdDetail = 'snapshot frame 未解析'
  if (firstFrame) {
    try {
      const snapshotRev = JSON.parse(firstFrame[2]).rev
      const firstId = Number(firstFrame[1])
      const laterIds = [...sseBuffer.matchAll(/\nevent: commander\.[^\n]+\nid: (\d+)/g)].map((m) => Number(m[1]))
      sseIdOk = firstId === snapshotRev && laterIds.length > 0 && laterIds.every((id, index) => id > snapshotRev && (index === 0 || id > laterIds[index - 1]))
      sseIdDetail = `snapshot_id=${firstId} snapshot_rev=${snapshotRev} later_ids=${laterIds.join(',')}`
    } catch (error) {
      sseIdDetail = `snapshot data 解析失败: ${String(error?.message ?? error)}`
    }
  }
  add('M6 SSE 首帧 id = 快照 rev，后续事件 id 递增', sseIdOk, sseIdDetail)

  // ---- 6) 重启（boot2）：M0-3 binding 持久化
  await stop(boot1.child)
  boot1 = null
  const boot2 = await boot('two')
  if (!boot2.base) {
    add('M0-3 重启后 boot', false, `boot2 失败；stderr=${boot2.stderr.slice(0, 200)}`)
    throw new Error('boot2 failed')
  }
  const health2 = await getJson(boot2.base, '/commander/health')
  const state2 = await getJson(boot2.base, '/commander/state')
  fs.writeFileSync(path.join(OUT, 'health-boot2.json'), JSON.stringify(health2, null, 2))
  fs.writeFileSync(path.join(OUT, 'state-boot2.json'), JSON.stringify(state2, null, 2))
  add('M0-3 重启后 health: bound + panel:absent', health2.body?.binding === 'bound' && health2.body?.panel === 'absent', `binding=${health2.body?.binding} panel=${health2.body?.panel}`)
  add('M0-3 重启后 binding 与 boot1 一致（workspaceId/sessionId/路径）', state2.body?.binding?.sessionId === binding1.sessionId && state2.body?.binding?.workspaceId === binding1.workspaceId, `boot1=${binding1.workspaceId}/${binding1.sessionId} boot2=${state2.body?.binding?.workspaceId}/${state2.body?.binding?.sessionId}`)
  await stop(boot2.child)
} catch (error) {
  record(`## FATAL ${String(error?.stack ?? error)}`)
} finally {
  fs.writeFileSync(path.join(OUT, 'commands.log'), `${cmdLog.join('\n')}\n`)
}

const failed = checks.filter((check) => !check.ok)
const summary = { generatedAt: new Date().toISOString(), role: 'tester（task-32 M0-5 独立 e2e）', checks, summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length } }
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
console.log(`M0 独立 e2e（证据：${path.relative(REPO, OUT)}）`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
console.log(`\n汇总：${checks.length - failed.length}/${checks.length} PASS，${failed.length} FAIL`)
process.exit(failed.length === 0 ? 0 : 1)
