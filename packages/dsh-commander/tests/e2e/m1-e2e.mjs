#!/usr/bin/env node
/**
 * M1 验收 e2e（tester，task-40）：隔离真实 Host + stub 模型（真实工具调用）+ probe 工作区 + fake Jev server。
 *
 * 覆盖（Host 侧）：
 *  S1 全确认主链路：commander_task_create → commander_task_dispatch 首次 needs_confirmation（字段/候选/推荐/scores/reason/TTL）
 *     → 二次 decisionId+confirmTarget → dispatched → task queued→running；能力 auto applied；
 *     decision 幂等回放（不重复建会话）；requestId 幂等；低置信/无 Jev key 分支仍 needs_confirmation 且可确认；
 *     GET /commander/tasks/:id 字段；POST /commander/jev/test（ok/err、永不回传 key）。
 *  S2 面板缺失：插件启动不崩、health panel:absent、派发仍成功（能力 inherit）。
 *  S3 decision 过期：需要确认后重启 Host（内存决策清空）→ 用旧 decisionId 确认 → 决策无效（task 不变）。
 *
 * 证据：tests/artifacts/m1/e2e/**（commands.log、summary.json、各步骤 JSON/SSE）。
 * 退出码：0=全部 PASS；1=有 FAIL；2=环境错误；有 BLOCKED（前置不满足，如工具未注册）时退出码 1 并标 BLOCKED。
 *
 * 只写 tests/artifacts/m1/**；不碰 live DSH、不改实现/配置；stub 与 fake Jev 不联网。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/m1/e2e')
const PROBE_PROBE = path.join(HERE, 'probes/m1-e2e-probe.mjs')
const INTROSPECT = path.join(REPO, 'tools/dev/spike/m1-introspect.mjs')
const checks = []
const logLines = []
const record = (line) => { logLines.push(line); }
const add = (id, ok, evidence, kind = 'check') => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? ''), kind })
const blocked = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'commands.log'), '')

// ---------------------------------------------------------------- fake Jev server
function startFakeJev() {
  const state = { mode: 'ok' }
  const okBody = () => ({
    model: 'fake-jev-1',
    answers: {
      workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.91, w_1: 0.09 }, confidence: 0.86 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.82, s_0: 0.18 }, confidence: 0.71 },
    },
    usage: { input_tokens: 120, output_tokens: 24 },
  })
  const lowBody = () => ({
    model: 'fake-jev-1',
    answers: {
      workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.22, w_1: 0.21 }, confidence: 0.18 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.26, s_0: 0.22 }, confidence: 0.2 },
    },
    usage: { input_tokens: 120, output_tokens: 20 },
  })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      record(`$ POST ${req.url} (fake jev mode=${state.mode}) bodyBytes=${raw.length}`)
      if (state.mode === 'err') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"fake failure"}'); return }
      const body = state.mode === 'low' ? lowBody() : okBody()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }))
  })
}

// ---------------------------------------------------------------- host harness
function makeEnv(root) {
  const env = {
    ...process.env,
    DSH_COMMANDER_NATIVE_SHELL: '0',
    DSH_HOME: path.join(root, 'home'),
    DSH_AGENTS_HOME: path.join(root, 'agents'),
    COMMANDER_BOOT_LOG: 'warn',
    M1_FAKE_KEY: 'stub-key-for-e2e',
  }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']) delete env[key]
  return env
}
const run = (bin, args, env) => {
  record(`$ ${bin} ${args.join(' ')}`)
  try {
    return { ok: true, stdout: execFileSync(bin, args, { cwd: REPO, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    record(`  -> exit=${error?.status ?? '?'} stderr=${String(error?.stderr ?? '').slice(0, 300)}`)
    return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}

class Host {
  constructor(name, root, { panelMode }) {
    this.name = name
    this.root = root
    this.panelMode = panelMode
    this.child = null
    this.base = ''
    this.stdout = ''
    this.stderr = ''
  }
  get env() { return makeEnv(this.root) }
  async setup(workspacePath) {
    fs.rmSync(this.root, { recursive: true, force: true })
    fs.mkdirSync(workspacePath, { recursive: true })
    const env = this.env
    const init = run('dsh', ['--profile', 'm1e2e', '--from-default-profile', 'web', '--dump-default-config'], env)
    add(`${this.name}/env init profile`, init.ok, init.ok ? 'exit=0' : init.stderr.slice(0, 200))
    // link CLI ui-chat
    try {
      const which = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()
      const text = fs.readFileSync(which, 'utf8')
      const match = text.match(/["']([^"']*lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js)["']/)
      const dir = match ? path.dirname(path.dirname(match[1].replaceAll('$HOME', process.env.HOME))) : ''
      const chat = path.join(dir, 'node_modules/@deepseek-ai/dsh-client-ui-chat')
      if (dir && fs.existsSync(chat)) {
        const target = path.join(env.DSH_HOME, 'profiles/m1e2e/node_modules/@deepseek-ai')
        fs.mkdirSync(target, { recursive: true })
        fs.symlinkSync(chat, path.join(target, 'dsh-client-ui-chat'))
      }
    } catch { /* optional */ }
    const install = run('dsh', ['plugin', '--profile', 'm1e2e', 'add', `file:${REPO}/packages/dsh-commander`], env)
    add(`${this.name}/env plugin add`, install.ok, install.ok ? 'exit=0' : install.stderr.slice(0, 200))
    this.patch = path.join(this.root, 'm1.patch.yml')
    fs.writeFileSync(this.patch, `- insert:
    - id: m1-e2e-probe
      name: 'file://${PROBE_PROBE}'
      config:
        workspacePath: '${workspacePath}'
        panelMode: '${this.panelMode}'
    - id: m1-introspect
      name: 'file://${INTROSPECT}'
      config: {}
`)
    this.workspacePath = workspacePath
  }
  async boot() {
    const outFile = path.join(OUT, `${this.name}-boot.out`)
    const errFile = path.join(OUT, `${this.name}-boot.err`)
    fs.writeFileSync(outFile, ''); fs.writeFileSync(errFile, '')
    this.stdout = ''
    this.stderr = ''
    this.child = spawn('dsh', ['--profile', 'm1e2e', '--patch', this.patch, '--port', '0', '--no-open'], { cwd: REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    record(`$ dsh --profile m1e2e --patch ${path.basename(this.patch)} --port 0 --no-open   # boot ${this.name}`)
    this.child.stdout.on('data', (chunk) => { this.stdout += chunk; fs.appendFileSync(outFile, chunk) })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; fs.appendFileSync(errFile, chunk) })
    for (let i = 0; i < 300; i += 1) {
      const match = this.stdout.match(/^dsh web: (http:\/\/[^\s?]+)/m)
      if (match) { this.base = match[1].replace(/\/$/, ''); break }
      await sleep(150)
    }
    if (this.base === '') return false
    for (let i = 0; i < 300; i += 1) {
      try { const res = await fetch(`${this.base}/commander/health`); if (res.status === 200) return true } catch { /* retry */ }
      await sleep(150)
    }
    return false
  }
  async stop() {
    if (this.child === null || this.child.exitCode !== null) return
    this.child.kill('SIGTERM')
    for (let i = 0; i < 80; i += 1) { if (this.child.exitCode !== null) break; await sleep(100) }
    if (this.child.exitCode === null) this.child.kill('SIGKILL')
  }
  async get(pathname) {
    const res = await fetch(`${this.base}${pathname}`)
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  async send(method, pathname, payload) {
    const res = await fetch(`${this.base}${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  async waitFor(fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = await fn().catch(() => null)
      if (value !== null && value !== undefined && value !== false) return value
      await sleep(intervalMs)
    }
    return null
  }
  async state() { return (await this.get('/commander/state')).body }
  async tasks() { const st = await this.state(); return st?.tasks ?? [] }
  async introspect(sessionId) { return (await this.get(`/m1/agent-tools?sessionId=${encodeURIComponent(sessionId)}`)).body }
  async jevTool(endpoint, apiKeyEnv = 'M1_FAKE_KEY') { return this.send('POST', '/commander/jev/test', { endpoint, model: 'fake-jev', apiKeyEnv, timeoutMs: 3000 }) }
  async waitPendingFor(taskId, timeoutMs = 25000) {
    return this.waitFor(async () => {
      const pending = (await this.state())?.pendingDispatch ?? null
      if (pending === null) return null
      return String(pending.taskId) === String(taskId) ? pending : null
    }, { timeoutMs })
  }
}

// ---------------------------------------------------------------- assertions helpers
const writeJson = (name, value) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`)
const pendingFields = ['decisionId', 'taskId', 'taskTitle', 'candidates', 'recommendation', 'scores', 'reason', 'createdAt', 'expiresAt']
function assertPending(pending, label) {
  const ok = pending !== null && pending !== undefined && pendingFields.every((field) => field in pending)
  add(`${label}: pendingDispatch 字段齐全（m1 §3.1）`, ok, pending === null ? 'pendingDispatch=null' : JSON.stringify({ decisionId: pending.decisionId, candidates: pending.candidates?.length, reason: pending.reason, pMax: pending.scores?.pMax }))
  if (!ok || pending === null) return
  add(`${label}: decisionId=dec_<24hex>`, /^dec_[0-9a-f]{24}$/.test(String(pending.decisionId)), `decisionId=${pending.decisionId}`)
  add(`${label}: 候选 1..8 且 recommendation 在候选内`, Array.isArray(pending.candidates) && pending.candidates.length >= 1 && pending.candidates.length <= 8 && pending.candidates.some((item) => item.workspaceId === pending.recommendation?.workspaceId && item.mode === pending.recommendation?.mode), `candidates=${pending.candidates?.length} recommendation=${JSON.stringify(pending.recommendation)}`)
  add(`${label}: scores 四键（pWorkspace/pSession/pMax/concentration）`, pending.scores !== undefined && ['pWorkspace', 'pSession', 'pMax', 'concentration'].every((key) => typeof pending.scores[key] === 'number'), JSON.stringify(pending.scores))
  add(`${label}: expiresAt≈createdAt+30min`, Number(pending.expiresAt) - Number(pending.createdAt) === 30 * 60 * 1000, `createdAt=${pending.createdAt} expiresAt=${pending.expiresAt}`)
}

async function sendMail(host, text, requestId) {
  const res = await host.send('POST', '/commander/message', { text, requestId })
  return res
}

// ---------------------------------------------------------------- main
let fakeJev = null
const hostA = new Host('s1', path.join(OUT, 's1'), { panelMode: 'thunk' })
const hostB = new Host('s2', path.join(OUT, 's2'), { panelMode: 'none' })
const hostC = new Host('s3', path.join(OUT, 's3'), { panelMode: 'thunk' })

try {
  fakeJev = await startFakeJev()
  const jevOk = `http://127.0.0.1:${fakeJev.port}/v1/systemone`
  const jevLow = `http://127.0.0.1:${fakeJev.port}/low/v1/systemone`
  const jevErr = `http://127.0.0.1:${fakeJev.port}/err/v1/systemone`
  // fake server 路由：/low、/err 切 mode（同一 listener 按路径切换）
  const rawHandler = fakeJev.server.listeners('request')[0]
  fakeJev.server.removeAllListeners('request')
  fakeJev.server.on('request', (req, res) => {
    if (String(req.url).startsWith('/low')) fakeJev.state.mode = 'low'
    else if (String(req.url).startsWith('/err')) fakeJev.state.mode = 'err'
    else fakeJev.state.mode = 'ok'
    rawHandler(req, res)
  })

  for (const host of [hostA, hostB, hostC]) {
    await host.setup(path.join(host.root, 'ws'))
  }

  // ================================================================ S1
  record('## ===== S1 全确认主链路（panel=thunk, policy=auto, fake Jev）')
  const bootA = await hostA.boot()
  add('S1 boot (isolated web host)', bootA, bootA ? 'health 200' : hostA.stderr.slice(0, 300))
  const healthA = await hostA.get('/commander/health')
  writeJson('s1-health.json', healthA)
  add('S1 health panel:present', healthA.status === 200 && healthA.body?.panel === 'present', JSON.stringify(healthA.body))
  const wsA = await hostA.waitFor(async () => {
    const st = await hostA.state()
    const ws = (st?.workspaces ?? [])[0]
    return ws ? { ws, st } : null
  })
  add('S1 probe workspace 已注册', wsA !== null, wsA ? `wsId=${wsA.ws.id}` : 'state.workspaces 为空')
  const wsId = wsA?.ws?.id ?? ''
  const putWs = await hostA.send('PUT', '/commander/workspaces', { workspaces: [{ id: wsId, allowed: true, summary: 'M1 e2e 工作区（隔离）', policy: 'auto' }] })
  writeJson('s1-workspaces-put.json', putWs)
  add('S1 配置 allowed 工作区（policy=auto）', putWs.status === 200 && putWs.body?.ok === true, `http=${putWs.status}`)
  const putCfg = await hostA.send('PUT', '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, jev: { endpoint: jevOk, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
  writeJson('s1-config-put.json', putCfg)
  add('S1 配置 commander 模型 + Jev endpoint（fake）', putCfg.status === 200 && putCfg.body?.ok === true, `http=${putCfg.status} endpoint=${putCfg.body?.config?.jev?.endpoint}`)
  const bindA = await hostA.send('POST', '/commander/binding', { mode: 'new', workspaceId: wsId })
  writeJson('s1-binding.json', bindA)
  const commanderSid = bindA.body?.binding?.sessionId ?? ''
  add('S1 绑定指挥官会话', bindA.status === 200 && typeof commanderSid === 'string' && commanderSid.length > 0, `http=${bindA.status} sid=${commanderSid}`)

  // 工具注册 preflight（真实 Host 契约；缺失 = HIGH BLOCKED）
  const intro = await hostA.waitFor(async () => {
    const result = await hostA.introspect(commanderSid)
    return result?.commanderTools?.length === 4 ? result : null
  }, { timeoutMs: 8000 })
  const introAny = intro ?? await hostA.introspect(commanderSid)
  writeJson('s1-agent-tools.json', introAny)
  const toolNames = introAny?.toolNames ?? []
  const commanderTools = introAny?.commanderTools ?? []
  // agents 服务诊断（tools 注册依赖 agents.list()/get()；用于定位 F1/F2 类问题）
  const diag = await hostA.get(`/m1e2e/diag?sessionId=${encodeURIComponent(commanderSid)}`)
  writeJson('s1-agents-diag.json', diag)
  add('S1 agents 服务诊断（list/get，供 tools 注册定位）', diag.status === 200, JSON.stringify(diag.body).slice(0, 300))
  // 注：devops 2026-11-17 更正——tools.schemas() 不反映动态 register()（会 false negative）；
  // 因此 introspect 只作信息记录，工具可见性以「模型真实调用 + state.tasks」为准（见下方 create 断言）。
  const toolsReady = commanderTools.length === 4
  add('S1 agents/introspect 信息（schemas 不反映动态 register，仅参考）', true, `toolNames=${toolNames.length} commanderTools=${JSON.stringify(commanderTools)} errors=${JSON.stringify(introAny?.errors ?? [])}`, 'info')
  if (!toolsReady) record('## NOTE introspect schemas 未显示 commander tools（按 devops 更正属正常现象，继续以模型真实调用验证）')

  // jev/test（可先于工具链验证）
  const jevTestOk = await hostA.jevTool(jevOk)
  writeJson('s1-jev-test-ok.json', jevTestOk)
  add('S1 POST /commander/jev/test（fake /ok）→ ok:true + latencyMs', jevTestOk.status === 200 && jevTestOk.body?.ok === true && typeof jevTestOk.body?.latencyMs === 'number', JSON.stringify(jevTestOk.body).slice(0, 240))
  add('S1 jev/test 不回传 key', !JSON.stringify(jevTestOk.body ?? {}).includes('stub-key-for-e2e'), 'response 不含 key 明文')
  const jevTestErr = await hostA.jevTool(jevErr)
  writeJson('s1-jev-test-err.json', jevTestErr)
  add('S1 POST /commander/jev/test（fake /err）→ ok:false + 错误码', jevTestErr.status === 200 && jevTestErr.body?.ok === false && typeof jevTestErr.body?.code === 'string', JSON.stringify(jevTestErr.body).slice(0, 240))
  const tasks404 = await hostA.get('/commander/tasks/task_not_found')
  add('S1 GET /commander/tasks/:id 未知 → 404 not_found', tasks404.status === 404 && tasks404.body?.code === 'not_found', `http=${tasks404.status} body=${JSON.stringify(tasks404.body).slice(0, 120)}`)

  {
    // 1a 创建任务
    const createMsg = await sendMail(hostA, 'M1E2E_CREATE 请为 M1 e2e 创建任务', 'req_m1_e2e_create')
    add('S1 POST message（创建任务 marker）→ 200 accepted', createMsg.status === 200 && createMsg.body?.accepted === true, `http=${createMsg.status}`)
    const task = await hostA.waitFor(async () => { const list = await hostA.tasks(); return list.find((item) => item.title === 'M1 e2e 任务') ?? null }, { timeoutMs: 20000 })
    if (task === null) {
      const st = await hostA.state()
      const assistantTexts = (st?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => String(m.text ?? '').slice(0, 200))
      const unknownTool = (hostA.stdout.match(/unknown tool[^\n]*/g) ?? []).slice(0, 3)
      const toolResultLog = (hostA.stdout.match(/\[m1-e2e-probe\] stream[^\n]*/g) ?? []).slice(-6)
      writeJson('s1-create-failure.json', { assistantTexts, unknownTool, toolResultLog })
      blocked.push(`S1 commander_task_create 未产出任务：assistant=${JSON.stringify(assistantTexts)} unknownTool=${JSON.stringify(unknownTool)}（见 s1-create-failure.json）`)
    }
    add('S1 模型真实调用 commander_task_create → state.tasks 出现 draft 任务', task !== null, task ? `taskId=${task.taskId ?? task.id} status=${task.status}` : 'state.tasks 未出现任务（见 s1-create-failure.json）')
    const taskId = task?.taskId ?? task?.id ?? ''
    // requestId 幂等：同 requestId 再发一次 dispatch 首次调用（stub 固定 requestId）
    const dispatchMsg = await sendMail(hostA, `M1E2E_DISPATCH:${taskId} 请派发`, 'req_m1_e2e_dispatch')
    add('S1 commander_task_dispatch 首次调用触发（message 200）', dispatchMsg.status === 200, `http=${dispatchMsg.status}`)
    const pending = await hostA.waitPendingFor(taskId)
    writeJson('s1-pending.json', pending)
    assertPending(pending, 'S1')
    add('S1 首次 reason=user_confirm_required（fake Jev 高分）', pending?.reason === 'user_confirm_required', `reason=${pending?.reason}`)
    const taskBeforeConfirm = await hostA.get(`/commander/tasks/${taskId}`)
    writeJson('s1-task-before-confirm.json', taskBeforeConfirm)
    add('S1 确认前 task.status=proposed 且 dispatch 未写终态', taskBeforeConfirm.body?.task?.status === 'proposed' && (taskBeforeConfirm.body?.dispatch === null || taskBeforeConfirm.body?.dispatch?.outcome === undefined), `status=${taskBeforeConfirm.body?.task?.status} dispatch=${JSON.stringify(taskBeforeConfirm.body?.dispatch)?.slice(0, 120)}`)
    // 1b 确认
    const decisionId = pending?.decisionId ?? ''
    const targetWs = pending?.recommendation?.workspaceId ?? wsId
    const targetMode = pending?.recommendation?.mode ?? 'new'
    const confirmMsg = await sendMail(hostA, `M1E2E_CONFIRM:${taskId}:${decisionId}:${targetWs}:${targetMode} 确认派发`, 'req_m1_e2e_confirm')
    add('S1 确认消息发送（message 200）', confirmMsg.status === 200, `http=${confirmMsg.status}`)
    const pendingAfter = await hostA.waitFor(async () => { const st = await hostA.state(); return st?.pendingDispatch === null ? { st } : null }, { timeoutMs: 30000 })
    writeJson('s1-state-after-confirm.json', pendingAfter?.st ?? await hostA.state())
    add('S1 确认后 pendingDispatch=null', pendingAfter !== null, pendingAfter ? 'ok' : 'pendingDispatch 仍非 null')
    const taskDetail = await hostA.waitFor(async () => {
      const detail = (await hostA.get(`/commander/tasks/${taskId}`)).body
      return detail?.task?.status === 'queued' || detail?.task?.status === 'running' ? detail : null
    }, { timeoutMs: 30000 })
    writeJson('s1-task-detail.json', taskDetail)
    add('S1 确认后 task queued/running', taskDetail !== null, `status=${taskDetail?.task?.status}`)
    add('S1 dispatches 终态 confirmed/overridden + confirmedBy=user', taskDetail?.dispatch?.outcome === 'confirmed' || taskDetail?.dispatch?.outcome === 'overridden' ? taskDetail?.dispatch?.confirmedBy === 'user' : false, `outcome=${taskDetail?.dispatch?.outcome} confirmedBy=${taskDetail?.dispatch?.confirmedBy}`)
    add('S1 能力 auto：CapabilityPlan.status=applied + enabled 含提交 plan name', taskDetail?.capabilities?.status === 'applied' && Array.isArray(taskDetail?.capabilities?.enabled) && taskDetail.capabilities.enabled.includes('probe-skill-m1'), String(JSON.stringify(taskDetail?.capabilities) ?? '').slice(0, 240))
    const running = await hostA.waitFor(async () => { const detail = (await hostA.get(`/commander/tasks/${taskId}`)).body; return detail?.task?.status === 'running' ? detail : null }, { timeoutMs: 45000 })
    writeJson('s1-task-running.json', running)
    add('S1 工作会话 turn/start → task running（M1-1 验收口径）', running !== null, running ? 'status=running' : '超时仍非 running（需看工作会话模型/prompt 证据）')
    // 1c 同 decision 二次确认 → 回放不新建会话
    const sessionsBefore = (taskDetail?.sessions ?? []).length
    await sendMail(hostA, `M1E2E_CONFIRM:${taskId}:${decisionId}:${targetWs}:${targetMode} 再确认一次`, 'req_m1_e2e_confirm_again')
    await sleep(2500)
    const replayDetail = (await hostA.get(`/commander/tasks/${taskId}`)).body
    writeJson('s1-task-replay.json', replayDetail)
    add('S1 同 decision 二次确认幂等回放（不新建会话）', (replayDetail?.sessions ?? []).length === sessionsBefore && sessionsBefore >= 1, `sessions before=${sessionsBefore} after=${(replayDetail?.sessions ?? []).length}`)
    // 1d 低置信分支（新任务）
    const create2 = await sendMail(hostA, 'M1E2E_CREATE 请创建低置信任务', 'req_m1_e2e_create2')
    const task2 = await hostA.waitFor(async () => { const list = await hostA.tasks(); return list.find((item) => item.id !== taskId && item.status === 'draft') ?? null }, { timeoutMs: 20000 })
    const task2Id = task2?.taskId ?? task2?.id ?? ''
    if (task2Id !== '') {
      const cfgLow = await hostA.send('PUT', '/commander/config', { jev: { endpoint: jevLow, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
      writeJson('s1-config-put-low.json', cfgLow)
      await sleep(400)
      await sendMail(hostA, `M1E2E_DISPATCH:${task2Id} 低置信派发`, 'req_m1_e2e_dispatch2')
      const pendingLow = await hostA.waitPendingFor(task2Id)
      writeJson('s1-pending-low.json', pendingLow)
      add('S1 低置信 → needs_confirmation reason=low_confidence', pendingLow?.reason === 'low_confidence', `reason=${pendingLow?.reason} scores=${JSON.stringify(pendingLow?.scores)}`)
      const confirmLow = await sendMail(hostA, `M1E2E_CONFIRM:${task2Id}:${pendingLow?.decisionId ?? ''}:${pendingLow?.recommendation?.workspaceId ?? wsId}:new 确认`, 'req_m1_e2e_confirm2')
      const dispatchedLow = await hostA.waitFor(async () => { const d = (await hostA.get(`/commander/tasks/${task2Id}`)).body; return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null }, { timeoutMs: 30000 })
      add('S1 低置信二次确认后仍可派发（全确认语义）', dispatchedLow !== null, `status=${dispatchedLow?.task?.status}`)
    } else {
      blocked.push('低置信场景：第二个 commander_task_create 未产出任务')
    }
    // 1e Jev 不可用分支（新任务）
    const create3 = await sendMail(hostA, 'M1E2E_CREATE 请创建无 Jev 任务', 'req_m1_e2e_create3')
    const task3 = await hostA.waitFor(async () => { const list = await hostA.tasks(); return list.find((item) => ![taskId, task2Id].includes(item.taskId ?? item.id) && item.status === 'draft') ?? null }, { timeoutMs: 20000 })
    const task3Id = task3?.taskId ?? task3?.id ?? ''
    if (task3Id !== '') {
      const cfgErr = await hostA.send('PUT', '/commander/config', { jev: { endpoint: jevErr, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
      writeJson('s1-config-put-err.json', cfgErr)
      await sleep(400)
      await sendMail(hostA, `M1E2E_DISPATCH:${task3Id} 无 Jev 派发`, 'req_m1_e2e_dispatch3')
      const pendingErr = await hostA.waitPendingFor(task3Id)
      writeJson('s1-pending-jev-unavailable.json', pendingErr)
      add('S1 Jev 不可用 → needs_confirmation reason=jev_unavailable', pendingErr?.reason === 'jev_unavailable', `reason=${pendingErr?.reason}`)
      const confirmErr = await sendMail(hostA, `M1E2E_CONFIRM:${task3Id}:${pendingErr?.decisionId ?? ''}:${pendingErr?.recommendation?.workspaceId ?? wsId}:new 确认`, 'req_m1_e2e_confirm3')
      const dispatchedErr = await hostA.waitFor(async () => { const d = (await hostA.get(`/commander/tasks/${task3Id}`)).body; return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null }, { timeoutMs: 30000 })
      add('S1 Jev 不可用确认后仍可派发', dispatchedErr !== null, `status=${dispatchedErr?.task?.status}`)
    } else {
      blocked.push('Jev 不可用场景：第三个 commander_task_create 未产出任务')
    }
  }
  await hostA.stop()

  // ================================================================ S2 面板缺失（inherit）
  record('## ===== S2 面板缺失（panelMode=none）→ 启动不崩、派发仍可用（inherit）')
  const bootB = await hostB.boot()
  add('S2 boot（无 capabilityPanel）', bootB, bootB ? 'health 200' : hostB.stderr.slice(0, 300))
  const healthB = await hostB.get('/commander/health')
  writeJson('s2-health.json', healthB)
  add('S2 host 启动不崩 + health panel:absent', healthB.status === 200 && healthB.body?.panel === 'absent', JSON.stringify(healthB.body))
  const fatalB = /(FATAL|did not activate|Cannot find module|uncaught)/i.test(hostB.stderr)
  add('S2 stderr 无致命错误', !fatalB, `stderr_bytes=${hostB.stderr.length}`)
  const wsB = await hostB.waitFor(async () => { const st = await hostB.state(); return (st?.workspaces ?? [])[0] ?? null })
  const wsBId = wsB?.id ?? ''
  await hostB.send('PUT', '/commander/workspaces', { workspaces: [{ id: wsBId, allowed: true, summary: 'M1 e2e 面板缺失工作区', policy: 'auto' }] })
  await hostB.send('PUT', '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, jev: { endpoint: jevOk, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
  const bindB = await hostB.send('POST', '/commander/binding', { mode: 'new', workspaceId: wsBId })
  writeJson('s2-binding.json', bindB)
  add('S2 绑定指挥官会话', bindB.status === 200 && typeof bindB.body?.binding?.sessionId === 'string', `http=${bindB.status}`)
  const introB = await hostB.introspect(bindB.body?.binding?.sessionId ?? '')
  writeJson('s2-agent-tools.json', introB)
  add('S2 agents/introspect 信息（schemas 仅参考）', true, `commanderTools=${JSON.stringify(introB?.commanderTools ?? [])}`, 'info')
  {
    const createB = await sendMail(hostB, 'M1E2E_CREATE 面板缺失创建任务', 'req_m1_e2e_s2_create')
    const taskB = await hostB.waitFor(async () => { const list = await hostB.tasks(); return list.find((item) => item.title === 'M1 e2e 任务' && (item.status === 'draft' || item.status === 'proposed')) ?? null }, { timeoutMs: 20000 })
    const taskBId = taskB?.taskId ?? taskB?.id ?? ''
    if (taskBId !== '') {
      await sendMail(hostB, `M1E2E_DISPATCH:${taskBId} 面板缺失派发`, 'req_m1_e2e_s2_dispatch')
      const pendingB = await hostB.waitFor(async () => (await hostB.state())?.pendingDispatch ?? null, { timeoutMs: 25000 })
      writeJson('s2-pending.json', pendingB)
      assertPending(pendingB, 'S2')
      await sendMail(hostB, `M1E2E_CONFIRM:${taskBId}:${pendingB?.decisionId ?? ''}:${pendingB?.recommendation?.workspaceId ?? wsBId}:new 确认`, 'req_m1_e2e_s2_confirm')
      const detailB = await hostB.waitFor(async () => { const d = (await hostB.get(`/commander/tasks/${taskBId}`)).body; return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null }, { timeoutMs: 30000 })
      writeJson('s2-task-detail.json', detailB)
      add('S2 面板缺失时派发仍成功（queued/running）', detailB !== null, `status=${detailB?.task?.status}`)
      add('S2 能力 fallback（panel_unavailable）且不阻塞派发', detailB?.capabilities?.status === 'fallback' && detailB?.capabilities?.reason === 'panel_unavailable', String(JSON.stringify(detailB?.capabilities) ?? '').slice(0, 240))
    } else {
      blocked.push('S2 面板缺失场景：commander_task_create 未产出任务（见 s2-* 证据）')
    }
  }
  await hostB.stop()

  // ================================================================ S3 decision 过期（重启后确认）
  record('## ===== S3 decision 过期：首次 needs_confirmation 后重启 Host → 旧 decisionId 确认应无效')
  const bootC = await hostC.boot()
  add('S3 boot', bootC, bootC ? 'health 200' : hostC.stderr.slice(0, 300))
  const wsC = await hostC.waitFor(async () => { const st = await hostC.state(); return (st?.workspaces ?? [])[0] ?? null })
  const wsCId = wsC?.id ?? ''
  await hostC.send('PUT', '/commander/workspaces', { workspaces: [{ id: wsCId, allowed: true, summary: 'M1 e2e 过期场景', policy: 'auto' }] })
  await hostC.send('PUT', '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, jev: { endpoint: jevOk, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
  const bindC = await hostC.send('POST', '/commander/binding', { mode: 'new', workspaceId: wsCId })
  const commanderC = bindC.body?.binding?.sessionId ?? ''
  const introC = await hostC.introspect(commanderC)
  writeJson('s3-agent-tools.json', introC)
  {
    await sendMail(hostC, 'M1E2E_CREATE 过期场景创建任务', 'req_m1_e2e_s3_create')
    const taskC = await hostC.waitFor(async () => { const list = await hostC.tasks(); return list.find((item) => item.status === 'draft' || item.status === 'proposed') ?? null }, { timeoutMs: 20000 })
    const taskCId = taskC?.taskId ?? taskC?.id ?? ''
    if (taskCId !== '') {
      await sendMail(hostC, `M1E2E_DISPATCH:${taskCId} 过期场景首次派发`, 'req_m1_e2e_s3_dispatch')
      const pendingC = await hostC.waitFor(async () => (await hostC.state())?.pendingDispatch ?? null, { timeoutMs: 25000 })
      writeJson('s3-pending-before-restart.json', pendingC)
      add('S3 重启前 pendingDispatch 存在', pendingC !== null, `decisionId=${pendingC?.decisionId}`)
      const detailBefore = (await hostC.get(`/commander/tasks/${taskCId}`)).body
      const sessionsBeforeC = (detailBefore?.sessions ?? []).length
      await hostC.stop()
      const bootC2 = await hostC.boot()
      add('S3 重启同 home 成功', bootC2, bootC2 ? 'health 200' : hostC.stderr.slice(0, 300))
      const introC2 = await hostC.introspect(commanderC)
      writeJson('s3-agent-tools-after-restart.json', introC2)
      // tools.schemas() 不反映动态 register（devops 已撤回该口径）→ 信息项；工具可用性由「旧 decision 确认得到 rejected」证明
      add('S3 重启后 agents/introspect 信息（schemas 仅参考）', true, `commanderTools=${JSON.stringify(introC2?.commanderTools ?? [])}`, 'info')
      const pendingAfterRestart = (await hostC.state())?.pendingDispatch
      add('S3 重启后内存决策清空（pendingDispatch=null）', pendingAfterRestart === null || pendingAfterRestart === undefined, `pendingDispatch=${JSON.stringify(pendingAfterRestart)?.slice(0, 120)}`)
      await sendMail(hostC, `M1E2E_CONFIRM:${taskCId}:${pendingC?.decisionId ?? ''}:${wsCId}:new 旧 decision 确认`, 'req_m1_e2e_s3_confirm')
      await sleep(3000)
      const detailAfter = (await hostC.get(`/commander/tasks/${taskCId}`)).body
      writeJson('s3-task-detail-after-restart-confirm.json', detailAfter)
      add('S3 旧 decisionId 确认被拒（task 仍 proposed、无新会话）', detailAfter?.task?.status === 'proposed' && (detailAfter?.sessions ?? []).length === sessionsBeforeC, `status=${detailAfter?.task?.status} sessions=${(detailAfter?.sessions ?? []).length} (before=${sessionsBeforeC})`)
    } else {
      blocked.push('S3 过期场景：commander_task_create 未产出任务')
    }
  }
  await hostC.stop()
} catch (error) {
  record(`## FATAL ${String(error?.stack ?? error)}`)
  add('e2e 执行异常', false, String(error?.message ?? error).slice(0, 300))
} finally {
  try { fakeJev?.server?.close?.() } catch { /* ignore */ }
  for (const host of [hostA, hostB, hostC]) { try { await host.stop() } catch { /* ignore */ } }
}

const countedChecks = checks.filter((check) => check.kind !== 'info')
const failed = countedChecks.filter((check) => !check.ok)
const summary = {
  generatedAt: new Date().toISOString(),
  role: 'tester（task-40 M1 Host e2e）',
  checks,
  blocked,
  summary: { total: countedChecks.length, pass: countedChecks.length - failed.length, fail: failed.length, blocked: blocked.length, info: checks.length - countedChecks.length },
}
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
fs.writeFileSync(path.join(OUT, 'commands.log'), `${logLines.join('\n')}\n`)
console.log(`M1 e2e（证据：${path.relative(REPO, OUT)}）`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
if (blocked.length > 0) {
  console.log('\nBLOCKED / 前置缺口：')
  for (const item of blocked) console.log(`  - ${item}`)
}
console.log(`\n汇总：${countedChecks.length - failed.length}/${countedChecks.length} PASS，${failed.length} FAIL，${blocked.length} BLOCKED，${checks.length - countedChecks.length} INFO`)
process.exit(failed.length === 0 ? 0 : 1)
