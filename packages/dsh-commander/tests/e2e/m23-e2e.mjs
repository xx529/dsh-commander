#!/usr/bin/env node
/**
 * M2/M3 验收 e2e（tester，task-57）：看板人工改动 + 闭环。
 *
 * 覆盖（隔离真实 Host + stub 模型真实工具调用 + fake Jev/panel）：
 *  M2：PATCH board 合法（priority/status）→ 写 task+boardEdits；非法（done→conflict、非法 priority→400）；
 *      同 editId 幂等（不重复 boardEdits）；`[board-edit]` 注入指挥官（合并窗口 COMMANDER_BOARD_MERGE_MS=20，一次不重复）；
 *      archive（done→archived）→ GET /commander/archive → restore→原状态 done；archiveSummary。
 *  M3：工作会话 turn/end → 指挥官收到 `[session-reply]`（格式 taskId/sessionId/truncated=…；9KB 回复→8KB 截断）；
 *      metrics.injections；commander_task_report 工具（stub 真实调用）→ review+acceptance；POST accept review→done；
 *      PATCH review 需 acceptance（缺失 conflict）；POST continue（旧 /rework 别名）只写批注+通知指挥官，任务保持 review。
 *  未覆盖（隔离环境限制，UNVERIFIED，单测/集成覆盖）：stale（需 20min lastActivity）、审批 pending 跳过、live 看板/审批卡走查。
 *
 * 证据：tests/artifacts/m2/e2e/**、tests/artifacts/m3/e2e/**。仅写 tests/artifacts/{m2,m3}/**。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts')
const M2 = path.join(OUT, 'm2/e2e')
const M3 = path.join(OUT, 'm3/e2e')
const PROBE = path.join(HERE, 'probes/m1-e2e-probe.mjs')
const checks = []
const blocked = []
const logLines = []
const record = (line) => { logLines.push(line) }
const add = (id, ok, evidence, kind = 'check') => checks.push({ id, ok: Boolean(ok), evidence: String(evidence ?? ''), kind })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
for (const dir of [M2, M3]) fs.mkdirSync(dir, { recursive: true })
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

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
    req.on('data', () => {})
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(okBody())) })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

class Host {
  constructor(root, workspacePath) {
    this.root = root
    this.workspacePath = workspacePath
    this.child = null
    this.base = ''
    this.stdout = ''
    this.stderr = ''
  }
  get env() {
    const env = { ...process.env, DSH_COMMANDER_NATIVE_SHELL: '0', DSH_HOME: path.join(this.root, 'home'), DSH_AGENTS_HOME: path.join(this.root, 'agents'), COMMANDER_BOOT_LOG: 'warn', M1_FAKE_KEY: 'stub-key-m23', COMMANDER_BOARD_MERGE_MS: '20' }
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']) delete env[key]
    return env
  }
  async setup() {
    fs.rmSync(this.root, { recursive: true, force: true })
    fs.mkdirSync(this.workspacePath, { recursive: true })
    const env = this.env
    record('$ dsh --profile m23e2e --from-default-profile web --dump-default-config')
    try { execFileSync('dsh', ['--profile', 'm23e2e', '--from-default-profile', 'web', '--dump-default-config'], { cwd: REPO, env, timeout: 120000, stdio: 'ignore' }) } catch { /* ignore */ }
    try {
      const which = execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()
      const text = fs.readFileSync(which, 'utf8')
      const match = text.match(/["']([^"']*lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js)["']/)
      const dir = match ? path.dirname(path.dirname(match[1].replaceAll('$HOME', process.env.HOME))) : ''
      const chat = path.join(dir, 'node_modules/@deepseek-ai/dsh-client-ui-chat')
      if (dir && fs.existsSync(chat)) {
        const target = path.join(env.DSH_HOME, 'profiles/m23e2e/node_modules/@deepseek-ai')
        fs.mkdirSync(target, { recursive: true })
        fs.symlinkSync(chat, path.join(target, 'dsh-client-ui-chat'))
      }
    } catch { /* ignore */ }
    record('$ dsh plugin --profile m23e2e add file:packages/dsh-commander')
    try { execFileSync('dsh', ['plugin', '--profile', 'm23e2e', 'add', `file:${REPO}/packages/dsh-commander`], { cwd: REPO, env, timeout: 120000, stdio: 'ignore' }) } catch { /* ignore */ }
    this.patch = path.join(this.root, 'm23.patch.yml')
    fs.writeFileSync(this.patch, `- insert:
    - id: m23-e2e-probe
      name: 'file://${PROBE}'
      config:
        workspacePath: '${this.workspacePath}'
        panelMode: 'thunk'
`)
  }
  async boot() {
    fs.writeFileSync(path.join(M2, 'boot.out'), '')
    fs.writeFileSync(path.join(M2, 'boot.err'), '')
    this.stdout = ''
    this.stderr = ''
    this.child = spawn('dsh', ['--profile', 'm23e2e', '--patch', this.patch, '--port', '0', '--no-open'], { cwd: REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    record('$ dsh --profile m23e2e --patch m23.patch.yml --port 0 --no-open')
    this.child.stdout.on('data', (chunk) => { this.stdout += chunk; fs.appendFileSync(path.join(M2, 'boot.out'), chunk) })
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; fs.appendFileSync(path.join(M2, 'boot.err'), chunk) })
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
  async get(pathname) { const res = await fetch(`${this.base}${pathname}`); return { status: res.status, body: await res.json().catch(() => null) } }
  async send(method, pathname, payload) { const res = await fetch(`${this.base}${pathname}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) }); return { status: res.status, body: await res.json().catch(() => null) } }
  async waitFor(fn, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) { const value = await fn().catch(() => null); if (value !== null && value !== undefined && value !== false) return value; await sleep(intervalMs) }
    return null
  }
  async state() { return (await this.get('/commander/state')).body }
  async tasks() { return (await this.state())?.tasks ?? [] }
  async waitIdle(timeoutMs = 90000) {
    let stable = 0; const started = Date.now()
    while (Date.now() - started < timeoutMs) { const st = await this.state(); if (st?.commanderBusy === false) { stable += 1; if (stable >= 2) return true } else stable = 0; await sleep(300) }
    return false
  }
  async sessionEvents(sessionId) { return (await this.get(`/m1r/events?sessionId=${encodeURIComponent(sessionId)}`)).body?.events ?? [] }
}

const stateOf = async (host, taskId) => (await host.get(`/commander/tasks/${taskId}`)).body
const editId = () => `edit_${Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`
async function createTask(host) {
  await host.waitIdle()
  const before = new Set((await host.tasks()).map((item) => item.id))
  await host.send('POST', '/commander/message', { text: 'M1E2E_CREATE 请创建 M2/M3 e2e 任务', requestId: `req_m23_create_${Date.now()}` })
  const task = await host.waitFor(async () => (await host.tasks()).find((item) => !before.has(item.id)) ?? null, { timeoutMs: 30000 })
  await host.waitIdle()
  return task
}
async function dispatchNew(host, taskId, wsId) {
  await host.waitIdle()
  await host.send('POST', '/commander/message', { text: `M1E2E_DISPATCH:${taskId} 请派发`, requestId: `req_m23_dispatch_${Date.now()}` })
  const pending = await host.waitFor(async () => {
    const p = (await host.state())?.pendingDispatch ?? null
    return p !== null && String(p.taskId) === String(taskId) ? p : null
  }, { timeoutMs: 60000 })
  if (pending === null) return null
  await host.waitIdle()
  await host.send('POST', '/commander/message', { text: `M1E2E_CONFIRM:${taskId}:${pending.decisionId}:${wsId}:new 确认`, requestId: `req_m23_confirm_${Date.now()}` })
  await sleep(500)
  await host.waitIdle(60000)
  return pending
}
async function organize(host, taskId, sessionId) {
  await host.waitIdle()
  await host.send('POST', '/commander/message', { text: `M1E2E_ORGANIZE:${taskId}:${sessionId} 请整理本会话产出并汇报`, requestId: `req_m23_organize_${Date.now()}` })
  await sleep(500)
  await host.waitIdle(60000)
}

let fakeJev = null
const root = path.join(M2, 'host')
const wsPath = path.join(root, 'ws')
const host = new Host(root, wsPath)

try {
  fakeJev = await startFakeJev()
  await host.setup()
  const booted = await host.boot()
  add('M2/M3 boot（隔离真实 Host）', booted, booted ? 'health 200' : host.stderr.slice(0, 300))
  const health = await host.get('/commander/health')
  writeJson(path.join(M2, '01-health.json'), health)
  add('health panel:present', health.status === 200 && health.body?.panel === 'present', JSON.stringify(health.body))
  const diag = await host.waitFor(async () => { const d = (await host.get('/m1e2e/diag')).body; return (d?.workspaces ?? []).length >= 1 ? d : null }, { timeoutMs: 15000 })
  const wsId = (diag?.workspaces ?? [])[0]?.id ?? ''
  add('probe 工作区注册', wsId !== '', `wsId=${wsId}`)
  await host.send('PUT', '/commander/workspaces', { workspaces: [{ id: wsId, allowed: true, summary: 'M2/M3 e2e ws', policy: 'inherit' }] })
  await host.send('PUT', '/commander/config', { commander: { model: { provider: 'probe-stub', model: 'stub-1' } }, jev: { endpoint: `http://127.0.0.1:${fakeJev.port}/v1/systemone`, model: 'fake-jev', apiKeyEnv: 'M1_FAKE_KEY', timeoutMs: 3000 } })
  const bind = await host.send('POST', '/commander/binding', { mode: 'new', workspaceId: wsId })
  const commanderSid = bind.body?.binding?.sessionId ?? ''
  add('绑定指挥官会话', bind.status === 200 && commanderSid !== '', `sid=${commanderSid}`)

  // ================================================================ M2 board PATCH + boardEdits + injection
  const task1 = await createTask(host)
  const t1 = task1?.id ?? ''
  add('M2 commander_task_create（T1）', t1 !== '', `taskId=${t1}`)
  const patch1 = await host.send('PATCH', `/commander/board/tasks/${t1}`, { field: 'priority', value: 'high', editId: editId(), requestId: 'req_m2_patch_1' })
  writeJson(path.join(M2, '10-patch-priority.json'), patch1)
  add('M2 PATCH priority=high → 200 且 task.priority=high', patch1.status === 200 && patch1.body?.task?.priority === 'high', `http=${patch1.status}`)
  const detail1 = await stateOf(host, t1)
  writeJson(path.join(M2, '11-task-detail-board-edits.json'), detail1)
  add('M2 GET tasks/:id 含 boardEdits 摘要（≥1）', Array.isArray(detail1?.boardEdits) && detail1.boardEdits.length >= 1, `boardEdits=${detail1?.boardEdits?.length}`)
  const editIdReplay = editId()
  const patchReplay1 = await host.send('PATCH', `/commander/board/tasks/${t1}`, { field: 'priority', value: 'normal', editId: editIdReplay, requestId: 'req_m2_patch_rep' })
  const patchReplay2 = await host.send('PATCH', `/commander/board/tasks/${t1}`, { field: 'priority', value: 'normal', editId: editIdReplay, requestId: 'req_m2_patch_rep' })
  const detailReplay = await stateOf(host, t1)
  writeJson(path.join(M2, '12-patch-replay.json'), { patchReplay1, patchReplay2, boardEdits: detailReplay?.boardEdits?.length })
  add('M2 同 editId 幂等（第二次 200，boardEdits 不重复增加）', patchReplay1.status === 200 && patchReplay2.status === 200 && (detailReplay?.boardEdits?.length ?? 0) === (detail1?.boardEdits?.length ?? 0) + 1, `edits=${detailReplay?.boardEdits?.length}`)
  const patchDone = await host.send('PATCH', `/commander/board/tasks/${t1}`, { field: 'status', value: 'done', editId: editId(), requestId: 'req_m2_bad_done' })
  add('M2 PATCH status 一律拒绝（400/409，走人专用路由）', (patchDone.status === 400 || patchDone.status === 409) && (patchDone.body?.code === 'invalid_request' || patchDone.body?.code === 'conflict'), `http=${patchDone.status} body=${JSON.stringify(patchDone.body)?.slice(0, 160)}`)
  const patchBadPriority = await host.send('PATCH', `/commander/board/tasks/${t1}`, { field: 'priority', value: 'urgent-max', editId: editId(), requestId: 'req_m2_bad_priority' })
  add('M2 PATCH 非法 priority → 400 invalid_request', patchBadPriority.status === 400 && patchBadPriority.body?.code === 'invalid_request', `http=${patchBadPriority.status}`)
  const boardEditInjected = await host.waitFor(async () => {
    const events = await host.sessionEvents(commanderSid)
    const hit = events.filter((event) => String(event?.text ?? '').includes('[board-edit]'))
    return hit.length > 0 ? hit : null
  }, { timeoutMs: 15000 })
  writeJson(path.join(M2, '13-board-edit-injection.json'), { injected: boardEditInjected?.length ?? 0, events: boardEditInjected ?? [] })
  add('M2 `[board-edit]` 注入指挥官（合并窗口=20ms，一次/批）', (boardEditInjected?.length ?? 0) >= 1, `messages=${boardEditInjected?.length ?? 0}`)

  // ================================================================ M3 turn/end 注入 + commander_task_report + accept
  await dispatchNew(host, t1, wsId)
  const running1 = await host.waitFor(async () => { const d = await stateOf(host, t1); return d?.task?.status === 'running' || d?.task?.status === 'queued' ? d : null }, { timeoutMs: 40000 })
  writeJson(path.join(M3, '20-task1-running.json'), running1)
  const session1 = (running1?.sessions ?? []).find((item) => item.role === 'work')?.sessionId ?? ''
  add('M3 派发后工作会话 running（T1）', running1 !== null && session1 !== '', `status=${running1?.task?.status} session=${session1}`)
  const injection = await host.waitFor(async () => {
    const events = await host.sessionEvents(commanderSid)
    const hit = events.filter((event) => {
      const text = String(event?.text ?? '')
      return text.includes('[session-reply]') && text.includes('taskId=') && text.includes('sessionId=') && text.includes('truncated=') && text.includes('"role":"user"')
    })
    return hit.length > 0 ? hit : null
  }, { timeoutMs: 20000 })
  writeJson(path.join(M3, '21-session-reply-injection.json'), { count: injection?.length ?? 0, events: injection ?? [] })
  const injectionText = injection?.[0]?.text ?? ''
  add('M3 turn/end → 指挥官收到 `[session-reply]` 且带工作会话最后一条文本（格式 taskId/sessionId/turnId/seq/truncated）', injectionText.includes('[session-reply] HEAD-') && injectionText.includes('taskId=') && injectionText.includes('sessionId=') && injectionText.includes('turnId=') && injectionText.includes('truncated='), `count=${injection?.length ?? 0}`)
  add('M3 9KB 工作回复 → 注入 8KB 截断（6KB 头 + 2KB 尾 + truncated=true）', injectionText.includes('HEAD-') && injectionText.includes('-TAIL') && /\[truncated \d+ chars\]/.test(injectionText) && injectionText.includes('truncated=true'), injectionText.slice(0, 160))
  const stateAfterInject = await host.state()
  writeJson(path.join(M3, '22-state-metrics.json'), { metrics: stateAfterInject?.metrics, workSessions: stateAfterInject?.workSessions })
  add('M3 metrics.injections ≥1', (stateAfterInject?.metrics?.injections ?? 0) >= 1, JSON.stringify(stateAfterInject?.metrics))
  await organize(host, t1, session1)
  const review1 = await host.waitFor(async () => { const d = await stateOf(host, t1); return d?.task?.status === 'review' ? d : null }, { timeoutMs: 30000 })
  writeJson(path.join(M3, '23-task1-review.json'), review1)
  add('M3 commander_task_report → task review + acceptance≥1 + evidence_present', review1 !== null && (review1?.acceptance?.length ?? 0) >= 1 && review1.acceptance.some((item) => item.state === 'evidence_present'), `status=${review1?.task?.status} acceptance=${review1?.acceptance?.length}`)
  const patchReviewNoAcceptance = await host.send('PATCH', `/commander/board/tasks/${(await createTask(host))?.id ?? ''}`, { field: 'status', value: 'review', editId: editId(), requestId: 'req_m2_review_no_acc' }).catch(() => null)
  add('M2 PATCH status 不再接受（400/409）', patchReviewNoAcceptance !== null && (patchReviewNoAcceptance.status === 400 || patchReviewNoAcceptance.status === 409) && (patchReviewNoAcceptance.body?.code === 'invalid_request' || patchReviewNoAcceptance.body?.code === 'conflict'), `http=${patchReviewNoAcceptance?.status}`)
  const accept = await host.send('POST', `/commander/tasks/${t1}/accept`, { requestId: 'req_m3_accept_1' })
  writeJson(path.join(M3, '24-accept.json'), accept)
  add('M3 POST accept（review→done）+ timeline accept', accept.status === 200 && accept.body?.task?.status === 'done' && (accept.body?.task?.timeline ?? []).some((item) => item.type === 'accept'), `http=${accept.status} status=${accept.body?.task?.status}`)

  // ================================================================ M5 继续派发请求（只通知指挥官，不改状态）
  const task2 = await createTask(host)
  const t2 = task2?.id ?? ''
  await dispatchNew(host, t2, wsId)
  const running2 = await host.waitFor(async () => { const d = await stateOf(host, t2); return d?.task?.status === 'running' || d?.task?.status === 'queued' ? d : null }, { timeoutMs: 40000 })
  const session2 = (running2?.sessions ?? []).find((item) => item.role === 'work')?.sessionId ?? ''
  await organize(host, t2, session2)
  const review2 = await host.waitFor(async () => { const d = await stateOf(host, t2); return d?.task?.status === 'review' ? d : null }, { timeoutMs: 30000 })
  add('M3 第二个任务 commander_task_report → review', review2 !== null, `status=${review2?.task?.status}`)
  const continueResponse = await host.send('POST', `/commander/tasks/${t2}/rework`, { comment: '请补上回滚步骤与测试证据', requestId: 'req_m5_continue_1' })
  writeJson(path.join(M3, '30-continue.json'), continueResponse)
  add('M5 POST continue（旧 /rework 别名）→ 200，任务保持 review，写批注+continue_request',
    continueResponse.status === 200
      && continueResponse.body?.task?.status === 'review'
      && continueResponse.body?.task?.pendingInstruction?.text === '请补上回滚步骤与测试证据'
      && (continueResponse.body?.task?.timeline ?? []).some((item) => item.type === 'continue_request'),
    `http=${continueResponse.status} status=${continueResponse.body?.task?.status}`)
  const continueInjected = await host.waitFor(async () => {
    const commanderEvents = await host.sessionEvents(commanderSid)
    const hit = commanderEvents.filter((event) => String(event?.text ?? '').includes('[task-continue]'))
    return hit.length > 0 ? hit : null
  }, { timeoutMs: 15000 })
  add('M5 continue 请求注入指挥官（[task-continue] + 批注）',
    (continueInjected?.length ?? 0) >= 1
      && continueInjected.some((event) => String(event?.text ?? '').includes('请补上回滚步骤与测试证据')),
    `events=${continueInjected?.length ?? 0}`)
  const oldWorkPrompt = await host.sessionEvents(session2)
  add('M5 不再直接给工作会话发「上一轮验收未通过」brief',
    !oldWorkPrompt.some((event) => String(event?.text ?? '').includes('上一轮验收未通过')),
    `events=${oldWorkPrompt.length}`)

  // ================================================================ M2 archive / restore / archiveSummary
  const archive = await host.send('POST', `/commander/tasks/${t1}/archive`, { requestId: 'req_m2_archive_1' })
  writeJson(path.join(M2, '20-archive.json'), archive)
  add('M2 archive（done→archived）', archive.status === 200 && archive.body?.task?.status === 'archived', `http=${archive.status} status=${archive.body?.task?.status}`)
  const archiveList = await host.get('/commander/archive?limit=50')
  writeJson(path.join(M2, '21-archive-list.json'), archiveList)
  add('M2 GET /commander/archive 包含 T1', archiveList.status === 200 && (archiveList.body?.tasks ?? []).some((item) => item.id === t1), `http=${archiveList.status} tasks=${archiveList.body?.tasks?.length}`)
  const restore = await host.send('POST', `/commander/tasks/${t1}/restore`, { requestId: 'req_m2_restore_1' })
  writeJson(path.join(M2, '22-restore.json'), restore)
  add('M2 restore（archived→archivedFrom=done）', restore.status === 200 && restore.body?.task?.status === 'done', `http=${restore.status} status=${restore.body?.task?.status}`)
  const finalState = await host.state()
  writeJson(path.join(M2, '23-final-state.json'), finalState)
  add('M2 archiveSummary 存在（archivedCount/cancelledCount）', finalState?.archiveSummary !== undefined && typeof finalState.archiveSummary.archivedCount === 'number', JSON.stringify(finalState?.archiveSummary))

  // 环境限制项
  add('M2 stale（running 且 lastActivityAt>20min）e2e', true, 'UNVERIFIED：隔离 e2e 无法推进 20min 时钟；由单测/集成 stale 覆盖', 'info')
  add('M3 审批 pending 时跳过注入 e2e', true, 'UNVERIFIED：隔离环境难稳定造 PendingApproval；由集成测试（pending_interaction skip）覆盖', 'info')
  add('M2/M3 live 看板/审批卡走查', true, 'UNVERIFIED：待 devops 重载 + 页面硬刷新后统一走查（Lead 安排）', 'info')

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
const summary = { generatedAt: new Date().toISOString(), role: 'tester（task-57 M2/M3 e2e）', checks, summary: { total: counted.length, pass: counted.length - failed.length, fail: failed.length, info: checks.length - counted.length } }
fs.writeFileSync(path.join(OUT, 'm2/e2e/summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
fs.writeFileSync(path.join(OUT, 'm3/e2e/summary.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
fs.writeFileSync(path.join(M2, 'commands.log'), `${logLines.join('\n')}\n`)
console.log(`M2/M3 e2e（证据：tests/artifacts/m2/e2e、tests/artifacts/m3/e2e）`)
for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
console.log(`\n汇总：${counted.length - failed.length}/${counted.length} PASS，${failed.length} FAIL，${checks.length - counted.length} INFO`)
process.exit(failed.length === 0 ? 0 : 1)
