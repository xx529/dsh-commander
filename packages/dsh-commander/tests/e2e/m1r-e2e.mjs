#!/usr/bin/env node
/**
 * M1R 验收 e2e（tester，task-56）：自定义确认 target=attach + 只读会话列表。
 *
 * 覆盖（隔离真实 Host + stub 模型真实工具调用 + probe 工作区 + fake Jev/panel）：
 *  1) GET /commander/sessions?workspaceId：形状/排序字段、空工作区、缺参/非法 limit/未知工作区错误、truncated。
 *  2) attach 派发：commander_task_create → commander_task_dispatch 首次 needs_confirmation → confirmTarget{mode:'attach',sessionId}
 *     → dispatched、task queued/running、sessions link role=work/mode=attach、assignments/primarySessionId 正确、未新建会话。
 *  3) attach 不调用能力面板（fake panel rank/apply 计数 delta=0）。
 *  4) 同会话多任务 attach 允许（契约 §1.2.4，不因占用拒绝）。
 *  5) 拒绝：不存在会话 / 跨工作区 / 指挥官自身会话 → invalid_target；拒绝后 decision 仍可用，valid attach 成功。
 *  6) archived 会话拒绝：e2e 无归档 fixture（DSH 隔离 host 无公开归档 API）→ 记录 UNVERIFIED，由集成测试 m1r-attach.test.ts 覆盖。
 *
 * 证据：tests/artifacts/m1r/e2e/**。仅写 tests/artifacts/m1r/**；不碰 live/实现。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/m1r/e2e')
const PROBE = path.join(HERE, 'probes/m1-e2e-probe.mjs')
const checks = []
const blocked = []
const logLines = []
const record = (line) => { logLines.push(line) }
const add = (id, ok, evidence, kind = 'check') => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? ''), kind })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
fs.mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------- fake Jev server
function startFakeJev() {
  const okBody = () => ({
    model: 'fake-jev-1',
    answers: {
      workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.91, w_1: 0.09 }, confidence: 0.86 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.82, s_0: 0.18 }, confidence: 0.71 },
    },
    usage: { input_tokens: 120, output_tokens: 24 },
  })
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(okBody()))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

// ---------------------------------------------------------------- host harness
const run = (bin, args, env) => {
  record(`$ ${bin} ${args.join(' ')}`)
  try {
    return { ok: true, stdout: execFileSync(bin, args, { cwd: REPO, env, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    record(`  -> exit=${error?.status ?? '?'}`)
    return { ok: false, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
  }
}

class Host {
  constructor(name, root, workspacePaths) {
    this.name = name
    this.root = root
    this.workspacePaths = workspacePaths
    this.child = null
    this.base = ''
    this.stdout = ''
    this.stderr = ''
  }
  get env() {
    const env = {
      ...process.env,
      DSH_COMMANDER_NATIVE_SHELL: '0',
      DSH_HOME: path.join(this.root, 'home'),
      DSH_AGENTS_HOME: path.join(this.root, 'agents'),
      COMMANDER_BOOT_LOG: 'warn',
      M1_FAKE_KEY: 'stub-key-for-m1r-e2e',
    }
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']) delete env[key]
    return env
  }
  async setup() {
    fs.rmSync(this.root, { recursive: true, force: true })
    for (const workspacePath of this.workspacePaths) fs.mkdirSync(workspacePath, { recursive: true })
    const env = this.env
    add(`${this.name}/env init profile`, run('dsh', ['--profile', 'm1re2e', '--from-default-profile', 'web', '--dump-default-config'], env).ok, 'exit=0')
    try {
      const which = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()
      const text = fs.readFileSync(which, 'utf8')
      const match = text.match(/["']([^"']*lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js)["']/)
      const dir = match ? path.dirname(path.dirname(match[1].replaceAll('$HOME', process.env.HOME))) : ''
      const chat = path.join(dir, 'node_modules/@deepseek-ai/dsh-client-ui-chat')
      if (dir && fs.existsSync(chat)) {
        const target = path.join(env.DSH_HOME, 'profiles/m1re2e/node_modules/@deepseek-ai')
        fs.mkdirSync(target, { recursive: true })
        fs.symlinkSync(chat, path.join(target, 'dsh-client-ui-chat'))
      }
    } catch { /* optional */ }
    add(`${this.name}/env plugin add`, run('dsh', ['plugin', '--profile', 'm1re2e', 'add', `file:${REPO}/packages/dsh-commander`], env).ok, 'exit=0')
    this.patch = path.join(this.root, 'm1r.patch.yml')
    fs.writeFileSync(this.patch, `- insert:
    - id: m1r-e2e-probe
      name: 'file://${PROBE}'
      config:
        workspacePaths: [${this.workspacePaths.map((item) => `'${item}'`).join(', ')}]
        panelMode: 'thunk'
`)
  }
  async boot() {
    fs.writeFileSync(path.join(OUT, `${this.name}-boot.out`), '')
    fs.writeFileSync(path.join(OUT, `${this.name}-boot.err`), '')
    this.stdout = ''
    this.stderr = ''
    this.child = spawn('dsh', ['--profile', 'm1re2e', '--patch', this.patch, '--port', '0', '--no-open'], { cwd: REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    record(`$ dsh --profile m1re2e --patch ${path.basename(this.patch)} --port 0 --no-open`)
    this.child.stdout.on('data', (chunk) => { this.stdout += chunk; fs.appendFileSync(path.join(OUT, `${this.name}-boot.out`), chunk) })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; fs.appendFileSync(path.join(OUT, `${this.name}-boot.err`), chunk) })
    for (let i = 0; i < 300; i += 1) {
      const match = this.stdout.match(/^dsh web: (http:\/\/[^\s?]+)/m)
      if (match) { this.base = match[1].replace(/\/$/, ''); break }
      await sleep(150)
    }
    for (let i = 0; i < 300 && this.base !== ''; i += 1) {
      try { if ((await fetch(`${this.base}/commander/health`)).status === 200) return true } catch { /* retry */ }
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
  async tasks() { return (await this.state())?.tasks ?? [] }
  async diag() { return (await this.get('/m1e2e/diag')).body }
  async waitIdle(timeoutMs = 90000) {
    let stable = 0
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const st = await this.state()
      if (st?.commanderBusy === false) { stable += 1; if (stable >= 2) return true } else stable = 0
      await sleep(300)
    }
    return false
  }
  async createSession(cwd) {
    return (await this.get(`/m1r/create-session?cwd=${encodeURIComponent(cwd)}`)).body
  }
  async waitPendingFor(taskId, timeoutMs = 25000) {
    return this.waitFor(async () => {
      const pending = (await this.state())?.pendingDispatch ?? null
      return pending !== null && String(pending.taskId) === String(taskId) ? pending : null
    }, { timeoutMs })
  }
}

const writeJson = (name, value) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(value, null, 2)}\n`)
const stateOf = async (host, taskId) => (await host.get(`/commander/tasks/${taskId}`)).body
const sessionOf = (detail) => (detail?.sessions ?? []).find((item) => item.role === 'work')?.sessionId ?? ''
async function createTask(host, marker = 'M1E2E_CREATE 请创建 M1R 任务') {
  await host.waitIdle()
  const before = new Set((await host.tasks()).map((item) => item.id))
  await host.send('POST', '/commander/message', { text: marker, requestId: `req_m1r_create_${Date.now()}` })
  const task = await host.waitFor(async () => (await host.tasks()).find((item) => !before.has(item.id)) ?? null, { timeoutMs: 30000 })
  await host.waitIdle()
  return task
}
async function firstDispatch(host, taskId) {
  await host.waitIdle()
  await host.send('POST', '/commander/message', { text: `M1E2E_DISPATCH:${taskId} 请派发`, requestId: `req_m1r_dispatch_${Date.now()}` })
  return host.waitPendingFor(taskId, 60000)
}
async function confirm(host, taskId, decisionId, workspaceId, mode, sessionId) {
  await host.waitIdle()
  const target = `${taskId}:${decisionId}:${workspaceId}:${mode}${sessionId !== undefined ? `:${sessionId}` : ''}`
  await host.send('POST', '/commander/message', { text: `M1E2E_CONFIRM:${target} 确认`, requestId: `req_m1r_confirm_${Date.now()}` })
  await sleep(500)
  await host.waitIdle(60000)
}

let fakeJev = null
const root = path.join(OUT, 'probe-root')
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const wsC = path.join(root, 'ws-c-empty')
const host = new Host('m1r', path.join(OUT, 'host'), [wsA, wsB, wsC])

try {
  fakeJev = await startFakeJev()
  const jevUrl = `http://127.0.0.1:${fakeJev.port}/v1/systemone`
  await host.setup()
  const booted = await host.boot()
  add('M1R boot（隔离真实 Host）', booted, booted ? 'health 200' : host.stderr.slice(0, 300))
  const health = await host.get('/commander/health')
  writeJson('01-health.json', health)
  add('health panel:present', health.status === 200 && health.body?.panel === 'present', JSON.stringify(health.body))

  // 发现 probe 工作区 id（按 path）
  const diag = await host.waitFor(async () => {
    const value = await host.diag()
    return (value?.workspaces ?? []).length >= 3 ? value : null
  }, { timeoutMs: 15000 })
  writeJson('02-diag.json', diag)
  const idByPath = Object.fromEntries((diag?.workspaces ?? []).map((item) => [item.path, item.id]))
  const wsAId = idByPath[wsA] ?? ''
  const wsBId = idByPath[wsB] ?? ''
  const wsCId = idByPath[wsC] ?? ''
  add('三个 probe 工作区已注册（A/B/空 C）', wsAId !== '' && wsBId !== '' && wsCId !== '', `A=${wsAId} B=${wsBId} C=${wsCId}`)

  const putWs = await host.send('PUT', '/commander/workspaces', {
    workspaces: [
      { id: wsAId, allowed: true, summary: 'M1R ws-a（attach 主）', policy: 'auto' },
      { id: wsBId, allowed: true, summary: 'M1R ws-b（跨工作区/次目标）', policy: 'inherit' },
      { id: wsCId, allowed: false, summary: 'M1R 空工作区（会话列表空分支）', policy: 'inherit' },
    ],
  })
  writeJson('03-workspaces-put.json', putWs)
  add('配置 3 个工作区（A/B allowed，C 空）', putWs.status === 200 && putWs.body?.ok === true, `http=${putWs.status}`)
  const putCfg = await host.send('PUT', '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, jev: { endpoint: jevUrl, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
  writeJson('04-config-put.json', putCfg)
  add('配置 stub 模型 + fake Jev', putCfg.status === 200 && putCfg.body?.ok === true, `http=${putCfg.status}`)
  const bind = await host.send('POST', '/commander/binding', { mode: 'new', workspaceId: wsAId })
  writeJson('05-binding.json', bind)
  const commanderSid = bind.body?.binding?.sessionId ?? ''
  add('绑定指挥官会话（wsA）', bind.status === 200 && commanderSid !== '', `sid=${commanderSid}`)

  // ================================================================ 1) GET /commander/sessions
  const sessionsA0 = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}`)
  writeJson('10-sessions-a-initial.json', sessionsA0)
  const sessionsA0Body = sessionsA0.body
  const shapeOk = sessionsA0.status === 200 && sessionsA0Body?.ok === true
    && sessionsA0Body?.workspaceId === wsAId
    && Array.isArray(sessionsA0Body?.sessions)
    && typeof sessionsA0Body?.truncated === 'boolean'
    && typeof sessionsA0Body?.rev === 'number'
    && sessionsA0Body.sessions.every((item) => typeof item.sessionId === 'string' && typeof item.title === 'string' && typeof item.lastActiveAt === 'number' && item.archived === false)
  add('GET sessions 200 + 形状（workspaceId/sessions[]/truncated/rev；元素字段/archived=false）', shapeOk, JSON.stringify({ http: sessionsA0.status, sessions: sessionsA0Body?.sessions?.length, truncated: sessionsA0Body?.truncated }))
  const missingParam = await host.get('/commander/sessions')
  add('GET sessions 缺 workspaceId → 400 invalid_request', missingParam.status === 400 && missingParam.body?.code === 'invalid_request', `http=${missingParam.status}`)
  const badLimit = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}&limit=0`)
  add('GET sessions 非法 limit=0 → 400 invalid_request', badLimit.status === 400 && badLimit.body?.code === 'invalid_request', `http=${badLimit.status}`)
  const unknownWs = await host.get('/commander/sessions?workspaceId=no-such-workspace')
  add('GET sessions 未知 workspace → 404 not_found', unknownWs.status === 404 && unknownWs.body?.code === 'not_found', `http=${unknownWs.status}`)
  const sessionsC = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsCId)}`)
  add('GET sessions 空工作区 → 200 sessions=[] truncated=false', sessionsC.status === 200 && Array.isArray(sessionsC.body?.sessions) && sessionsC.body.sessions.length === 0 && sessionsC.body.truncated === false, JSON.stringify({ http: sessionsC.status, sessions: sessionsC.body?.sessions?.length }))

  // ================================================================ 2) 能力面板路径（new 派发）+ fixture 会话
  const panelCalls0 = (await host.diag())?.panelCalls ?? { rank: 0, apply: 0 }
  const task0 = await createTask(host)
  const task0Id = task0?.id ?? ''
  const pending0 = await firstDispatch(host, task0Id)
  add('task0 首次 dispatch → needs_confirmation', pending0 !== null, `decisionId=${pending0?.decisionId}`)
  await confirm(host, task0Id, pending0?.decisionId ?? '', wsAId, 'new')
  const detail0 = await host.waitFor(async () => {
    const d = await stateOf(host, task0Id)
    return d?.task?.status === 'running' || d?.task?.status === 'queued' ? d : null
  }, { timeoutMs: 40000 })
  writeJson('20-task0-new-detail.json', detail0)
  const session0 = sessionOf(detail0)
  add('new 派发 → 工作会话 running', detail0 !== null && session0 !== '', `status=${detail0?.task?.status} session=${session0}`)
  const panelCalls1 = (await host.diag())?.panelCalls ?? { rank: 0, apply: 0 }
  add('new 派发（policy=auto）调用能力面板（panel 计数增加）', panelCalls1.rank > panelCalls0.rank && panelCalls1.apply > panelCalls0.apply, `before=${JSON.stringify(panelCalls0)} after=${JSON.stringify(panelCalls1)}`)

  // fixture 会话：直接经 sessionController.create({cwd}) 创建（devops 同配方），供 GET sessions/attach
  const createdA1 = await host.createSession(wsA)
  const createdA2 = await host.createSession(wsA)
  const sessionA1 = createdA1?.sessionId ?? ''
  const sessionA2 = createdA2?.sessionId ?? ''
  writeJson('21-fixture-sessions.json', { createdA1, createdA2 })
  add('创建两个 wsA fixture 会话', sessionA1 !== '' && sessionA2 !== '' && sessionA1 !== sessionA2, `${sessionA1} / ${sessionA2}`)
  const sessionsA1 = await host.waitFor(async () => {
    const res = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}`)
    const ids = new Set((res.body?.sessions ?? []).map((item) => item.sessionId))
    return ids.has(sessionA1) && ids.has(sessionA2) ? res.body : null
  }, { timeoutMs: 15000 })
  writeJson('22-sessions-a-after-fixtures.json', sessionsA1)
  const listedIds = new Set((sessionsA1?.sessions ?? []).map((item) => item.sessionId))
  add('GET sessions 包含两个 fixture 会话', listedIds.has(sessionA1) && listedIds.has(sessionA2), `listed=${(sessionsA1?.sessions ?? []).length}`)
  const limited = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}&limit=1`)
  add('GET sessions limit=1 → 返回 1 条且 truncated=true', limited.status === 200 && limited.body?.sessions?.length === 1 && limited.body?.truncated === true, JSON.stringify({ http: limited.status, sessions: limited.body?.sessions?.length, truncated: limited.body?.truncated }))

  // ================================================================ 3) attach 派发（task2 → sessionA1）
  const panelBefore = (await host.diag())?.panelCalls ?? { rank: 0, apply: 0 }
  const sessionsCreatedBefore = (await host.diag())?.sessionsCreated ?? -1
  const sessionsCountBeforeAttach = (await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}`)).body?.sessions?.length ?? -1
  const task2 = await createTask(host)
  const task2Id = task2?.id ?? ''
  const pending2 = await firstDispatch(host, task2Id)
  add('task2 首次 dispatch → needs_confirmation（待自定义 attach）', pending2 !== null, `decisionId=${pending2?.decisionId}`)
  await confirm(host, task2Id, pending2?.decisionId ?? '', wsAId, 'attach', sessionA1)
  const detail2 = await host.waitFor(async () => {
    const d = await stateOf(host, task2Id)
    return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null
  }, { timeoutMs: 30000 })
  writeJson('30-task2-attach-detail.json', detail2)
  const link2 = (detail2?.sessions ?? []).find((item) => item.sessionId === sessionA1)
  add('attach 确认后 dispatched：task2 queued/running', detail2 !== null, `status=${detail2?.task?.status}`)
  add('attach sessions link role=work + mode=attach', link2?.role === 'work' && link2?.mode === 'attach', JSON.stringify(link2))
  add('attach primarySessionId/assignments 指向 fixture 会话', detail2?.task?.primarySessionId === sessionA1 && (detail2?.task?.assignments ?? []).includes(sessionA1), `primary=${detail2?.task?.primarySessionId} assignments=${JSON.stringify(detail2?.task?.assignments)}`)
  // 自定义 attach 目标 ≠ recommendation → 契约 §1.5 期望 outcome='overridden'（若恰好等于推荐则为 confirmed），confirmedBy 恒 'user'
  add('attach dispatch outcome=overridden/confirmed + confirmedBy=user', ['overridden', 'confirmed'].includes(detail2?.dispatch?.outcome) && detail2?.dispatch?.confirmedBy === 'user', `outcome=${detail2?.dispatch?.outcome} confirmedBy=${detail2?.dispatch?.confirmedBy}`)
  const panelAfter = (await host.diag())?.panelCalls ?? { rank: 0, apply: 0 }
  add('attach 不调用能力面板（rank/apply 计数 delta=0）', panelAfter.rank === panelBefore.rank && panelAfter.apply === panelBefore.apply, `before=${JSON.stringify(panelBefore)} after=${JSON.stringify(panelAfter)}`)
  const sessionsCreatedAfter = (await host.diag())?.sessionsCreated ?? -1
  const sessionsCountAfterAttach = (await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(wsAId)}`)).body?.sessions?.length ?? -1
  add('attach 未新建会话（controller.create 计数与列表数均不变）', sessionsCreatedAfter === sessionsCreatedBefore && sessionsCountAfterAttach === sessionsCountBeforeAttach, `created before=${sessionsCreatedBefore} after=${sessionsCreatedAfter}; list before=${sessionsCountBeforeAttach} after=${sessionsCountAfterAttach}`)

  // ================================================================ 4) 同会话多任务 attach（契约 §1.2.4）
  const task3 = await createTask(host)
  const task3Id = task3?.id ?? ''
  const pending3 = await firstDispatch(host, task3Id)
  await confirm(host, task3Id, pending3?.decisionId ?? '', wsAId, 'attach', sessionA1)
  const detail3 = await host.waitFor(async () => {
    const d = await stateOf(host, task3Id)
    return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null
  }, { timeoutMs: 30000 })
  writeJson('31-task3-second-attach.json', detail3)
  add('同会话第二个任务 attach 允许（不因占用拒绝）', detail3 !== null && (detail3?.task?.assignments ?? []).includes(sessionA1), `status=${detail3?.task?.status} assignments=${JSON.stringify(detail3?.task?.assignments)}`)

  // ================================================================ 5) 拒绝分支 + decision 可用
  const task4 = await createTask(host)
  const task4Id = task4?.id ?? ''
  const pending4 = await firstDispatch(host, task4Id)
  add('task4 首次 dispatch → needs_confirmation（拒绝分支用）', pending4 !== null, `decisionId=${pending4?.decisionId}`)
  const missesBefore = (host.stdout.match(/Rejected: invalid_target/g) ?? []).length
  await confirm(host, task4Id, pending4?.decisionId ?? '', wsAId, 'attach', 'session-does-not-exist-000000')
  const missingDetail = await stateOf(host, task4Id)
  writeJson('40-reject-missing-session.json', missingDetail)
  add('不存在 session attach → invalid_target（task 仍 proposed、无 sessions link）', (host.stdout.match(/Rejected: invalid_target/g) ?? []).length > missesBefore && missingDetail?.task?.status === 'proposed' && (missingDetail?.sessions ?? []).length === 0, `status=${missingDetail?.task?.status} sessions=${(missingDetail?.sessions ?? []).length}`)
  const crossBefore = (host.stdout.match(/Rejected: invalid_target/g) ?? []).length
  await confirm(host, task4Id, pending4?.decisionId ?? '', wsBId, 'attach', sessionA1)
  const crossDetail = await stateOf(host, task4Id)
  writeJson('41-reject-cross-workspace.json', crossDetail)
  add('跨工作区 attach（wsB + sessionA1）→ invalid_target', (host.stdout.match(/Rejected: invalid_target/g) ?? []).length > crossBefore && crossDetail?.task?.status === 'proposed' && (crossDetail?.sessions ?? []).length === 0, `status=${crossDetail?.task?.status}`)
  const selfBefore = (host.stdout.match(/Rejected: invalid_target/g) ?? []).length
  await confirm(host, task4Id, pending4?.decisionId ?? '', wsAId, 'attach', commanderSid)
  const selfDetail = await stateOf(host, task4Id)
  writeJson('42-reject-commander-session.json', selfDetail)
  add('attach 指挥官自身会话 → invalid_target', (host.stdout.match(/Rejected: invalid_target/g) ?? []).length > selfBefore && selfDetail?.task?.status === 'proposed', `status=${selfDetail?.task?.status}`)
  await confirm(host, task4Id, pending4?.decisionId ?? '', wsAId, 'attach', sessionA2)
  const detail4 = await host.waitFor(async () => {
    const d = await stateOf(host, task4Id)
    return d?.task?.status === 'queued' || d?.task?.status === 'running' ? d : null
  }, { timeoutMs: 30000 })
  writeJson('43-task4-valid-after-rejects.json', detail4)
  add('拒绝后同一 decision 仍可成功 attach（task4 → sessionA2）', detail4 !== null && (detail4?.task?.assignments ?? []).includes(sessionA2), `status=${detail4?.task?.status}`)

  // 6) archived 会话：隔离 Host 无公开归档 API → UNVERIFIED（集成测试覆盖）
  add('archived 会话 attach 拒绝（e2e fixture 缺失）', true, 'UNVERIFIED：隔离 Host 无归档 fixture；由 tests/integration/m1r-attach.test.ts（archived → invalid_target）覆盖', 'info')

  const finalState = await host.state()
  writeJson('90-final-state.json', finalState)
  add('最终 pendingDispatch=null', finalState?.pendingDispatch === null || finalState?.pendingDispatch === undefined, JSON.stringify(finalState?.pendingDispatch)?.slice(0, 120))
  await host.stop()
} catch (error) {
  record(`## FATAL ${String(error?.stack ?? error)}`)
  add('e2e 执行异常', false, String(error?.message ?? error).slice(0, 300))
} finally {
  try { fakeJev?.server?.close?.() } catch { /* ignore */ }
  try { await host.stop() } catch { /* ignore */ }
}

const counted = checks.filter((check) => check.kind !== 'info')
const failed = counted.filter((check) => !check.ok)
const summary = {
  generatedAt: new Date().toISOString(),
  role: 'tester（task-56 M1R attach e2e）',
  checks,
  blocked,
  summary: { total: counted.length, pass: counted.length - failed.length, fail: failed.length, blocked: blocked.length, info: checks.length - counted.length },
}
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
fs.writeFileSync(path.join(OUT, 'commands.log'), `${logLines.join('\n')}\n`)
console.log(`M1R e2e（证据：${path.relative(REPO, OUT)}）`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
console.log(`\n汇总：${counted.length - failed.length}/${counted.length} PASS，${failed.length} FAIL，${checks.length - counted.length} INFO`)
process.exit(failed.length === 0 ? 0 : 1)
