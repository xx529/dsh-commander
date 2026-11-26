// M1 dispatch service 集成测试（fake 服务，真实 store/domain）：全确认 → confirm → dispatched 幂等；
// jev 不可用/候选为空/decision 过期/兼容路径/capability fallback/turn-start running。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createDispatchService, type DispatchService, type DispatchTaskArgs, type DispatchTaskResult } from '../../src/host/dispatch/service.ts'
import { createWorkStatusTracker, handleWorkSessionEvent } from '../../src/host/trigger/status.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import {
  createFakeCtx,
  createFakeSessionController,
  createFakeSessionQuery,
  createFakeStorageDomain,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'
import type { JevCallResult } from '../../src/host/jev/client.ts'

/** 派发消息由指挥官写：默认原文只用于跑通链路；需要验证「原样透传」的用例单独传 prompt。 */
const WORKER_PROMPT = '工作会话首条消息（测试）：按任务完成并给出证据。'
const dispatchWith = (service: Pick<DispatchService, 'dispatchTask'>, args: DispatchTaskArgs): Promise<DispatchTaskResult> =>
  // 首派（无 decisionId）默认补一份原文；确认调用不补，验证「省略 prompt 复用确认卡」的语义。
  service.dispatchTask(args.decisionId === undefined ? { prompt: WORKER_PROMPT, ...args } : args)


interface SetupOptions {
  allowed?: Array<{ id: string; policy?: 'inherit' | 'auto' }>
  jevOk?: boolean
  panel?: unknown
  jevCall?: (config: { endpoint: string; model: string; envVar: string; timeoutMs: number }, body: unknown) => Promise<JevCallResult>
  autoDispatch?: boolean
  taskStatus?: TaskRecord['status']
  registryWorkspaces?: Array<{ id: string; name: string; path: string }>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const okJev = (): JevCallResult => ({
  ok: true,
  latencyMs: 7,
  response: {
    answers: {
      workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.9, w_1: 0.1 }, confidence: 0.8 },
      session: { type: 'choice', choice: 'new', probabilities: { new: 0.9, s_0: 0.1 }, confidence: 0.6 },
    },
  },
})

async function setup(options: SetupOptions = {}) {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander' } }), 1)
  const allowed = options.allowed ?? [{ id: 'ws-a' }, { id: 'ws-b' }]
  const registry = createFakeWorkspaceRegistry(
    options.registryWorkspaces ?? [
      { id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: ['s-1'] },
      { id: 'ws-b', name: 'B', path: '/tmp/b', sessionIds: [] },
    ],
  )
  const controller = createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      workspaceRegistry: registry,
      sessions: createFakeSessionQuery([{ id: 's-1', workspaceId: 'ws-a', title: 'session one', updatedAt: 5 }]),
      sessionQuery: createFakeSessionQuery([{ id: 's-1', workspaceId: 'ws-a', title: 'session one', updatedAt: 5 }]),
      sessionController: controller,
      ...(options.panel !== undefined ? { capabilityPanel: options.panel } : {}),
    },
  })
  const records = allowed.map((item) => {
    const record = defaultWorkspaceRecord({ id: item.id, name: item.id, path: `/tmp/${item.id}` })
    return { ...record, allowed: true, capabilityPolicy: { mode: item.policy ?? 'inherit' } }
  })
  await stores.workspaces.replaceAll(records)
  if (options.autoDispatch === true) {
    const config = stores.config.get()
    await stores.config.update((current) => ({ ...current, jev: { ...current.jev, autoDispatch: true } }), config.version)
  }
  const task: TaskRecord = {
    v: 1,
    id: 'task_1',
    title: '任务标题',
    goal: '任务目标',
    status: options.taskStatus ?? 'draft',
    workspaceId: '',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [{ id: 'acc_1', text: '验收一', source: 'commander', state: 'insufficient' }],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  await stores.tasks.put(task)
  const pendingEvents: Array<unknown> = []
  const dispatch = createDispatchService({
    ctx,
    stores,
    jevCall: options.jevCall ?? (async () => (options.jevOk === false ? { ok: false, latencyMs: 3, error: { code: 'no_key', message: 'Jev API key is not configured' } } : okJev())),
    controllerOverride: controller,
    ...(options.panel !== undefined ? { panelOverride: options.panel } : {}),
    onPendingDispatch: (pending) => pendingEvents.push(pending),
  })
  return { storage, domain, stores, ctx, controller, dispatch, pendingEvents, taskId: 'task_1' }
}

test('first commander_task_dispatch call always returns needs_confirmation (全确认)', async () => {
  const { dispatch, stores, pendingEvents } = await setup()
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_first_1' })
  assert.equal(result.status, 'needs_confirmation')
  if (result.status !== 'needs_confirmation') return
  assert.match(result.decisionId, /^dec_[0-9a-f]{24}$/)
  assert.ok(['user_confirm_required', 'low_confidence'].includes(result.reason))
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 8)
  assert.equal(result.candidates[0]?.workspaceId, result.recommendation.workspaceId)
  assert.deepEqual(Object.keys(result.scores).sort(), ['concentration', 'pMax', 'pSession', 'pWorkspace'])
  assert.ok(result.expiresAt > Date.now())
  assert.equal(stores.tasks.get('task_1')?.status, 'proposed')
  assert.equal(stores.dispatches.get(result.decisionId), undefined) // pending 不写 DispatchRecord
  assert.equal(pendingEvents.length, 1)
  assert.equal((pendingEvents[0] as { decisionId: string }).decisionId, result.decisionId)
})

test('same requestId replays the same needs_confirmation decision', async () => {
  const { dispatch } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_replay_1' })
  const second = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_replay_1' })
  assert.equal(first.status, 'needs_confirmation')
  assert.equal(second.status, 'needs_confirmation')
  if (first.status !== 'needs_confirmation' || second.status !== 'needs_confirmation') return
  assert.equal(first.decisionId, second.decisionId)
})

test('confirm path dispatches: task queued, dispatch record confirmed, session link + prompt verbatim', async () => {
  const { dispatch, stores, controller } = await setup()
  // 指挥官自写的原文：前后空白、多行都不得被 Host 改写（不 trim / 不加模板 / 不截断）。
  const VERBATIM = '\n  自己写的首条消息\n第二行：目标与验收提示\n\n'
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_confirm_1', prompt: VERBATIM })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const target = first.recommendation
  const result = await dispatchWith(dispatch, {
    taskId: 'task_1',
    decisionId: first.decisionId,
    confirmTarget: target,
    requestId: 'req_confirm_2',
  })
  assert.equal(result.status, 'dispatched')
  if (result.status !== 'dispatched') return
  // H5：target 只能含契约字段（多余展示字段会被 DSH 工具输出校验拒绝）
  assert.deepEqual(Object.keys(result.target).sort(), ['mode', 'workspaceId'])
  assert.equal(controller.created.length, 1)
  assert.equal(controller.created[0]?.workspaceId, 'ws-a')
  assert.equal(controller.created[0]?.cwd, undefined) // create 入参二选一
  assert.equal(controller.prompts.length, 1)
  const promptText = String((controller.prompts[0]?.content as Array<{ text: string }>)[0]?.text)
  assert.equal(promptText, VERBATIM)
  assert.doesNotMatch(promptText, /\[commander-dispatch\]|taskId=|decisionId=|sessionId=|你是工作会话|验收提示：/)
  const task = stores.tasks.get('task_1')
  assert.equal(task?.status, 'queued')
  assert.equal(task?.primarySessionId, result.sessionId)
  const record = stores.dispatches.get(first.decisionId)
  assert.equal(record?.outcome, 'confirmed')
  assert.equal(record?.confirmedBy, 'user')
  assert.equal(record?.brief, VERBATIM)
  assert.equal((record as unknown as { instruction?: unknown })?.instruction, undefined)
  assert.deepEqual(record?.finalTarget, { workspaceId: target.workspaceId, mode: target.mode, sessionId: result.sessionId })
  const workLink = stores.sessions.list().find((link) => link.taskId === 'task_1')
  assert.equal(workLink?.role, 'work')
  assert.equal(workLink?.status, 'queued')
})

test('first call without prompt is rejected (invalid_prompt) and creates no card', async () => {
  const { dispatch, stores, controller, pendingEvents } = await setup()
  const result = await dispatch.dispatchTask({ taskId: 'task_1', requestId: 'req_no_prompt_1' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'invalid_prompt')
  assert.match(result.message, /prompt is required/)
  assert.equal(pendingEvents.length, 0)
  assert.equal(controller.prompts.length, 0)
  assert.equal(stores.tasks.get('task_1')?.status, 'draft')
})

test('prompt is passed verbatim with no clipping (>8KB kept intact)', async () => {
  const { dispatch, stores, controller } = await setup()
  const big = `  ${'长'.repeat(9000)}\nTAIL  `
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_big_1', prompt: big })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  // 确认调用省略 prompt：复用确认卡里那一份，仍然逐字相同。
  const dispatched = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_big_2' })
  assert.equal(dispatched.status, 'dispatched')
  const sent = String((controller.prompts[0]?.content as Array<{ text: string }>)[0]?.text)
  assert.equal(sent.length, big.length)
  assert.equal(sent, big)
  assert.equal(stores.dispatches.get(first.decisionId)?.brief, big)
})

test('confirm call may replace the prompt stored on the card', async () => {
  const { dispatch, controller } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_replace_1', prompt: '原始文本' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatched = await dispatchWith(dispatch, {
    taskId: 'task_1',
    decisionId: first.decisionId,
    confirmTarget: first.recommendation,
    requestId: 'req_replace_2',
    prompt: '用户确认时补充后的文本',
  })
  assert.equal(dispatched.status, 'dispatched')
  assert.equal(String((controller.prompts[0]?.content as Array<{ text: string }>)[0]?.text), '用户确认时补充后的文本')
})

test('same decision second confirm replays dispatched without creating a second session', async () => {
  const { dispatch, controller } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_replay_confirm_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const target = first.recommendation
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: target, requestId: 'req_replay_confirm_2' })
  const replay = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: target, requestId: 'req_replay_confirm_3' })
  assert.equal(confirmed.status, 'dispatched')
  assert.equal(replay.status, 'dispatched')
  if (confirmed.status !== 'dispatched' || replay.status !== 'dispatched') return
  assert.equal(replay.sessionId, confirmed.sessionId)
  assert.equal(controller.created.length, 1)
})

test('expired/unknown decision returns decision_expired', async () => {
  const { dispatch } = await setup()
  const result = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: 'dec_unknown_0000000000000000', confirmTarget: { workspaceId: 'ws-a', mode: 'new' }, requestId: 'req_expired_1' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'decision_expired')
})

test('jev unavailable still returns needs_confirmation with reason jev_unavailable', async () => {
  const { dispatch } = await setup({ jevOk: false })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_jev_down_1' })
  assert.equal(result.status, 'needs_confirmation')
  if (result.status !== 'needs_confirmation') return
  assert.equal(result.reason, 'jev_unavailable')
  assert.ok(result.candidates.length > 0)
})

test('no allowed workspace → rejected no_workspace', async () => {
  const { dispatch } = await setup({ allowed: [] })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_no_ws_1' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'no_workspace')
})

test('capability auto applies panel result; failure falls back and still dispatches', async () => {
  const applied = await setup({
    allowed: [{ id: 'ws-a', policy: 'auto' }],
    panel: { jev: { getConfig: () => ({ threshold: 0.5 }), rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'browser', score: 0.9 }] }), apply: () => ({ ok: true, elapsedMs: 9 }) } },
  })
  const first = await dispatchWith(applied.dispatch, { taskId: 'task_1', requestId: 'req_cap_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatched = await dispatchWith(applied.dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_cap_2' })
  assert.equal(dispatched.status, 'dispatched')
  if (dispatched.status !== 'dispatched') return
  assert.equal((dispatched.capabilities as { status: string; enabled: string[] }).status, 'applied')
  assert.deepEqual((dispatched.capabilities as { enabled: string[] }).enabled, ['browser'])

  const fallback = await setup({ allowed: [{ id: 'ws-a', policy: 'auto' }], panel: { jev: { rank: () => ({ ok: false }), apply: () => ({ ok: true }) } } })
  const firstFallback = await dispatchWith(fallback.dispatch, { taskId: 'task_1', requestId: 'req_cap_fb_1' })
  if (firstFallback.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatchedFallback = await dispatchWith(fallback.dispatch, { taskId: 'task_1', decisionId: firstFallback.decisionId, confirmTarget: firstFallback.recommendation, requestId: 'req_cap_fb_2' })
  assert.equal(dispatchedFallback.status, 'dispatched')
  if (dispatchedFallback.status !== 'dispatched') return
  assert.equal((dispatchedFallback.capabilities as { status: string }).status, 'fallback')
  assert.equal(fallback.controller.prompts.length, 1) // 能力失败不阻塞派发
})

test('compat path: candidate without decisionId is a first-call hint; with unique pending it confirms', async () => {
  const { dispatch } = await setup()
  // 无 pending 时：candidate 作为首次派发提示 → needs_confirmation（不是 decision_required）
  const hint = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'ws-a', mode: 'new' }, requestId: 'req_compat_0' })
  assert.equal(hint.status, 'needs_confirmation')
  if (hint.status !== 'needs_confirmation') return
  assert.equal(hint.recommendation.workspaceId, 'ws-a')
  // 唯一 pending 时：candidate 视为确认目标 → dispatched
  const compat = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: hint.recommendation.workspaceId, mode: hint.recommendation.mode }, requestId: 'req_compat_2' })
  assert.equal(compat.status, 'dispatched')
})

test('attach target dispatches to existing session without creating one', async () => {
  const { dispatch, controller } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_attach_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const result = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: { workspaceId: 'ws-a', mode: 'attach', sessionId: 's-1' }, requestId: 'req_attach_2' })
  assert.equal(result.status, 'dispatched')
  if (result.status !== 'dispatched') return
  assert.equal(result.sessionCreated, false)
  assert.equal(controller.created.length, 0)
  assert.equal(controller.prompts[0]?.sessionId, 's-1')
})

test('task not in draft/proposed state is rejected with task_state', async () => {
  const { dispatch } = await setup({ taskStatus: 'queued' })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_state_1' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'task_state')
})

test('turn/start mechanically moves queued task to running (M1, no injection)', async () => {
  const { dispatch, stores, ctx } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_running_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  const dispatched = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_running_2' })
  if (dispatched.status !== 'dispatched') return assert.fail('expected dispatched')
  const result = await handleWorkSessionEvent({ ctx, stores, now: () => 100 }, dispatched.sessionId, { seq: 5, type: 'turn/start', time: 100, data: { turn: 1 } })
  assert.equal(result?.status, 'running')
  assert.equal(stores.tasks.get('task_1')?.status, 'running')
  assert.equal(stores.sessions.list().find((link) => link.sessionId === dispatched.sessionId)?.status, 'running')
})


test('H3: confirm success clears pendingDispatch immediately (used decision is not exposed)', async () => {
  const { dispatch, pendingEvents } = await setup()
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_h3_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  assert.equal(dispatch.currentPending()?.decisionId, first.decisionId)
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_h3_2' })
  assert.equal(confirmed.status, 'dispatched')
  assert.equal(dispatch.currentPending(), null)
  assert.equal(pendingEvents.at(-1), null)
  // 同一 decision 再确认：幂等回放 dispatched，但不得重新出现 pending
  const replay = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_h3_3' })
  assert.equal(replay.status, 'dispatched')
  assert.equal(dispatch.currentPending(), null)
})

test('H4: orphan turn/start arriving before task/link write is reconciled to running after spawn', async () => {
  const { ctx, stores, controller } = await setup()
  const tracker = createWorkStatusTracker({ ctx, stores, now: () => 1000 })
  const dispatch = createDispatchService({
    ctx,
    stores,
    jevCall: async () => ({
      ok: true,
      latencyMs: 1,
      response: {
        answers: {
          workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 1 }, confidence: 0.9 },
          session: { type: 'choice', choice: 'new', probabilities: { new: 1 }, confidence: 0.9 },
        },
      },
    }),
    controllerOverride: controller,
    reconcileSessionStatus: async (taskId, sessionId) => {
      await tracker.reconcile(taskId, sessionId)
    },
  })
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_h4_1' })
  if (first.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  // 模拟竞态：prompt 先启动回合 → turn/start 到达时 sessions link 尚未写入
  assert.equal(tracker.orphanCount(), 0)
  await tracker.handleEvent('session-fake-1', { seq: 5, type: 'turn/start', time: 1000, data: { turn: 1 } })
  assert.equal(tracker.orphanCount(), 1)
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_h4_2' })
  assert.equal(confirmed.status, 'dispatched')
  // reconcile 是异步补偿（事件处理链），轮询到 running 再断言，避免 fire-and-forget 时序抖动
  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true
      await sleep(10)
    }
    return predicate()
  }
  assert.equal(await waitFor(() => stores.tasks.get('task_1')?.status === 'running'), true, 'task should reach running after reconcile')
  assert.equal(
    await waitFor(() => stores.sessions.list().find((link) => link.taskId === 'task_1')?.status === 'running'),
    true,
    'work session link should reach running after reconcile',
  )
})

test('re-attach 到旧任务的会话：turn/start 落在旧 link 上时新任务仍补 running（不污染旧任务）', async () => {
  const { ctx, stores } = await setup()
  const tracker = createWorkStatusTracker({ ctx, stores, now: () => 2000 })
  const base = {
    v: 1 as const,
    workspaceId: 'ws-a',
    priority: 'normal' as const,
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  await stores.tasks.put({ ...base, id: 'task_old', title: '旧任务', goal: '旧', status: 'archived' })
  await stores.tasks.put({ ...base, id: 'task_new', title: '新任务', goal: '新', status: 'queued' })
  // 会话曾被旧任务 attach（link 仍指向已归档的旧任务），新任务刚确认派发、link 尚未覆盖
  await stores.sessions.upsert({ v: 1, sessionId: 'session-rebind', workspaceId: 'ws-a', taskId: 'task_old', role: 'work', mode: 'attach', createdAt: 1, status: 'idle' })
  const started = await tracker.handleEvent('session-rebind', { seq: 1, type: 'turn/start', time: 2000, data: { turn: 1 } })
  assert.equal(started, null, '旧任务的 link 不该接收新回合')
  assert.equal(tracker.orphanCount(), 1)
  assert.equal(stores.tasks.get('task_old')?.updatedAt, 1, '归档任务不被回合事件污染')
  // link 覆盖到新任务后，reconcile 用最近的 turn/start 补 running
  await stores.sessions.upsert({ v: 1, sessionId: 'session-rebind', workspaceId: 'ws-a', taskId: 'task_new', role: 'work', mode: 'attach', createdAt: 2, status: 'queued' })
  const reconciled = await tracker.reconcile('task_new', 'session-rebind')
  assert.equal(reconciled?.status, 'running')
  assert.equal(stores.tasks.get('task_new')?.status, 'running')
  assert.equal(stores.sessions.list().find((link) => link.taskId === 'task_new')?.status, 'running')
})

test('reconcile 在没有近期 turn/start 时保持 queued（attach 到忙碌会话不误报 running）', async () => {
  const { ctx, stores } = await setup()
  const tracker = createWorkStatusTracker({ ctx, stores, now: () => 10_000 })
  await stores.tasks.put({
    v: 1, id: 'task_busy', title: '忙碌会话任务', goal: '目标', status: 'queued', workspaceId: 'ws-a',
    priority: 'normal', commandId: '', assignments: [], acceptance: [], timeline: [], version: 1,
    createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-busy', workspaceId: 'ws-a', taskId: 'task_busy', role: 'work', mode: 'attach', createdAt: 1, status: 'queued' })
  assert.equal(await tracker.reconcile('task_busy', 'session-busy'), null)
  assert.equal(stores.tasks.get('task_busy')?.status, 'queued')
})

test('启动回填：queued 任务且会话回合仍在进行 → 补 running；回合已结束则保持 queued', async () => {
  const { stores } = await setup()
  const base = {
    v: 1 as const, workspaceId: 'ws-a', priority: 'normal' as const, commandId: '', assignments: [],
    acceptance: [], timeline: [], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  }
  await stores.tasks.put({ ...base, id: 'task_bf_a', title: '回填A', goal: '目标', status: 'queued' })
  await stores.tasks.put({ ...base, id: 'task_bf_b', title: '回填B', goal: '目标', status: 'queued' })
  await stores.tasks.put({ ...base, id: 'task_bf_c', title: '回填C', goal: '目标', status: 'queued' })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-bf-a', workspaceId: 'ws-a', taskId: 'task_bf_a', role: 'work', mode: 'attach', createdAt: 1, status: 'queued' })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-bf-b', workspaceId: 'ws-a', taskId: 'task_bf_b', role: 'work', mode: 'attach', createdAt: 1, status: 'queued' })
  await stores.sessions.upsert({ v: 1, sessionId: 'session-bf-c', workspaceId: 'ws-a', taskId: 'task_bf_c', role: 'work', mode: 'attach', createdAt: 20_000, status: 'queued' })
  const eventsBySession: Record<string, unknown[]> = {
    'session-bf-a': [{ seq: 1, type: 'turn/start', time: 100, data: { turn: 1 } }],
    'session-bf-b': [
      { seq: 1, type: 'turn/start', time: 100, data: { turn: 1 } },
      { seq: 2, type: 'turn/end', time: 200, data: { turn: 1 } },
    ],
    // 回合在 attach 之前就开始了（brief 还在会话队列后面排队）→ 不算本任务的 running
    'session-bf-c': [{ seq: 1, type: 'turn/start', time: 100, data: { turn: 1 } }],
  }
  const ctx = createFakeCtx({
    services: {
      sessions: {
        async get(sessionId: string) {
          const events = eventsBySession[sessionId]
          return events === undefined ? undefined : { snapshotEvents: () => events }
        },
      },
    },
  })
  const tracker = createWorkStatusTracker({ ctx, stores, now: () => 300 })
  assert.equal(await tracker.backfill(), 1)
  assert.equal(stores.tasks.get('task_bf_a')?.status, 'running')
  assert.equal(stores.sessions.list().find((link) => link.taskId === 'task_bf_a')?.status, 'running')
  assert.equal(stores.tasks.get('task_bf_b')?.status, 'queued')
  assert.equal(stores.tasks.get('task_bf_c')?.status, 'queued')
})

// H5 全路径输出契约：用真实 @deepseek-ai/dsh-tools 的 validateJsonSchemaValue 校验 commander_task_dispatch
// tool.execute 在 needs_confirmation/confirm/replay/expired/rejected/blocked/compat 各路径的真实返回。
async function loadRealValidator(): Promise<{ validate: (schema: unknown, value: unknown, path?: string) => unknown } | null> {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const { hostModuleAnchors } = await import('../../src/host/tools/index.ts')
    for (const anchor of hostModuleAnchors()) {
      try {
        const requireFunction = createRequire(anchor)
        const entry = requireFunction.resolve('@deepseek-ai/dsh-tools')
        const mod = (await import(pathToFileURL(entry).href)) as { validateJsonSchemaValue?: unknown }
        if (typeof mod.validateJsonSchemaValue === 'function') {
          return { validate: mod.validateJsonSchemaValue as (schema: unknown, value: unknown, path?: string) => unknown }
        }
      } catch {
        continue
      }
    }
  } catch {
    /* 解析失败：skip */
  }
  return null
}

test('H5: every commander_task_dispatch tool path result passes the real DSH output schema (8 paths)', async (t) => {
  const { hostModuleAnchors: _anchors } = await import('../../src/host/tools/index.ts')
  void _anchors
  const real = await loadRealValidator()
  if (real === null) {
    t.skip('real @deepseek-ai/dsh-tools not resolvable; tester e2e Host round covers this')
    return
  }
  const { createCommanderTools, hostModuleAnchors } = await import('../../src/host/tools/index.ts')
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  let defineTool: ((spec: unknown) => unknown) | null = null
  for (const anchor of hostModuleAnchors()) {
    try {
      const mod = (await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-tools')).href)) as { defineTool?: unknown }
      if (typeof mod.defineTool === 'function') { defineTool = mod.defineTool as (spec: unknown) => unknown; break }
    } catch { continue }
  }
  assert.notEqual(defineTool, null)
  const execValid = (result: unknown, label: string): void => {
    try {
      real.validate(spec.output.schema, result, 'value')
    } catch (error) {
      assert.fail(`${label} returned invalid output: ${String((error as Error)?.message ?? error)} value=${JSON.stringify(result)}`)
    }
  }
  const buildTools = (dispatch: ReturnType<typeof createDispatchService>) => {
    const tools = createCommanderTools({
      ctx: { get: () => undefined } as never,
      stores: (dispatch as unknown as { stores?: never }) as never,
      dispatchService: dispatch,
      commanderSessionId: () => 'session-commander',
      defineToolLoader: async () => defineTool as (spec: unknown) => unknown,
    })
    return tools
  }
  // 路径 1：needs_confirmation（正常） / 2：confirm dispatched（capability fallback） / 3：replay / 4：expired
  const s1 = await setup({ allowed: [{ id: 'ws-a', policy: 'auto' }], panel: { jev: { rank: () => ({ ok: false }), apply: () => ({ ok: true }) } } })
  const tools1 = buildTools(s1.dispatch)
  await tools1.prepare()
  const spec = tools1.specs()?.commander_task_dispatch as { output: { schema: unknown }; execute: (args: unknown, exec: unknown) => Promise<unknown> }
  const exec = { agent: { id: 'session-commander' }, signal: { throwIfAborted: () => undefined } }
  const first = await spec.execute({ taskId: 'task_1', requestId: 'req_h5_1', prompt: 'H5 首派原文' }, exec)
  execValid(first, 'needs_confirmation')
  const decisionId = (first as { decisionId: string }).decisionId
  const target = (first as { recommendation: { workspaceId: string; mode: 'new' } }).recommendation
  const confirmed = await spec.execute({ taskId: 'task_1', decisionId, confirmTarget: target, requestId: 'req_h5_2' }, exec)
  execValid(confirmed, 'confirm-dispatched')
  const replay = await spec.execute({ taskId: 'task_1', decisionId, confirmTarget: target, requestId: 'req_h5_3' }, exec)
  execValid(replay, 'decision-replay-dispatched')
  const expired = await spec.execute({ taskId: 'task_1', decisionId: 'dec_unknown_0000000000000000', confirmTarget: target, requestId: 'req_h5_4' }, exec)
  execValid(expired, 'decision-expired-rejected')
  // 路径 5：no_workspace rejected；6：unknown_task rejected；7：task_state rejected；8：scope error
  const s2 = await setup({ allowed: [] })
  const tools2 = buildTools(s2.dispatch)
  await tools2.prepare()
  const spec2 = tools2.specs()?.commander_task_dispatch as typeof spec
  execValid(await spec2.execute({ taskId: 'task_1', requestId: 'req_h5_5', prompt: 'H5 首派原文' }, exec), 'no_workspace-rejected')
  execValid(await spec2.execute({ taskId: 'task_missing', requestId: 'req_h5_6' }, exec), 'unknown_task-rejected')
  const s3 = await setup({ taskStatus: 'queued' })
  const tools3 = buildTools(s3.dispatch)
  await tools3.prepare()
  const spec3 = tools3.specs()?.commander_task_dispatch as typeof spec
  execValid(await spec3.execute({ taskId: 'task_1', requestId: 'req_h5_7' }, exec), 'task_state-rejected')
  const workerExec = { agent: { id: 'session-worker' }, signal: { throwIfAborted: () => undefined } }
  execValid(await spec.execute({ taskId: 'task_1', requestId: 'req_h5_8' }, workerExec), 'forbidden_scope-error')
  tools1.dispose()
  tools2.dispose()
  tools3.dispose()
})


test('candidate.workspaceId resolves by id / name / path (live M1 fix)', async () => {
  for (const reference of ['ws-a', 'A', '/tmp/a', ' a ']) {
    const { dispatch } = await setup()
    const result = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: reference, mode: 'new' }, requestId: `req_ref_${encodeURIComponent(reference)}` })
    assert.equal(result.status, 'needs_confirmation', `reference ${reference}: ${JSON.stringify(result)}`)
    if (result.status !== 'needs_confirmation') continue
    assert.equal(result.recommendation.workspaceId, 'ws-a')
    assert.equal(result.candidates[0]?.workspaceId, 'ws-a')
  }
})

test('ambiguous workspace name returns needs_confirmation(reason=ambiguous_workspace) instead of no_workspace', async () => {
  const { dispatch } = await setup({
    allowed: [{ id: 'ws-a' }, { id: 'ws-b' }],
    registryWorkspaces: [
      { id: 'ws-a', name: 'Shared Name', path: '/tmp/shared-a' },
      { id: 'ws-b', name: 'Shared Name', path: '/tmp/shared-b' },
    ],
  })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'shared name', mode: 'new' }, requestId: 'req_ambiguous_1' })
  assert.equal(result.status, 'needs_confirmation')
  if (result.status !== 'needs_confirmation') return
  assert.equal(result.reason, 'ambiguous_workspace')
  assert.deepEqual(result.candidates.map((item) => item.workspaceId).sort(), ['ws-a', 'ws-b'])
})

test('unknown workspace reference returns no_workspace with commander_workspace_list hint', async () => {
  const { dispatch } = await setup()
  const result = await dispatchWith(dispatch, { taskId: 'task_1', candidate: { workspaceId: 'no-such-workspace', mode: 'new' }, requestId: 'req_unknown_ws_1' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'no_workspace')
  assert.match(result.message, /commander_workspace_list/)
  assert.match(result.message, /ws-a/)
})


test('task.workspaceId (设置过) 作为首次派发提示，确认后回写规范化 workspaceId', async () => {
  const { dispatch, stores } = await setup()
  // 模拟指挥官先 commander_task_create({workspaceId:"A"})（名称而非 id）
  const task = stores.tasks.get('task_1') as TaskRecord
  await stores.tasks.put({ ...task, workspaceId: 'A', version: task.version + 1 })
  const first = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_task_ws_1' })
  assert.equal(first.status, 'needs_confirmation')
  if (first.status !== 'needs_confirmation') return
  assert.equal(first.recommendation.workspaceId, 'ws-a')
  const confirmed = await dispatchWith(dispatch, { taskId: 'task_1', decisionId: first.decisionId, confirmTarget: first.recommendation, requestId: 'req_task_ws_2' })
  assert.equal(confirmed.status, 'dispatched')
  assert.equal(stores.tasks.get('task_1')?.workspaceId, 'ws-a')
})

test('no allowed workspace 时 no_workspace message 提示 commander_task_create/commander_workspace_list', async () => {
  const { dispatch } = await setup({ allowed: [] })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_no_ws_hint' })
  assert.equal(result.status, 'rejected')
  if (result.status !== 'rejected') return
  assert.equal(result.code, 'no_workspace')
  assert.match(result.message, /commander_workspace_list/)
  assert.match(result.message, /commander_task_create/)
})

// ---------------------------------------------------------------- 两段式 Jev（v2.5）
type TwoStageBody = {
  state: Record<string, unknown>
  questions: Record<string, { type: string; criteria: Record<string, Record<string, unknown>> }>
}
const twoStageJev = (calls: TwoStageBody[], workspaceChoice: string) => async (_config: unknown, body: unknown): Promise<JevCallResult> => {
  calls.push(body as TwoStageBody)
  return {
    ok: true,
    latencyMs: 1,
    response: {
      answers: {
        workspace: { type: 'choice', choice: workspaceChoice, probabilities: { [workspaceChoice]: 1 }, confidence: 1 },
        session: { type: 'choice', choice: 'new', probabilities: { new: 1 }, confidence: 1 },
      },
    },
  }
}

test('two-stage: workspace request keeps state to the request and puts workspace info in criteria', async () => {
  const calls: TwoStageBody[] = []
  const { dispatch } = await setup({ jevCall: twoStageJev(calls, 'w_0') })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_two_1' })
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(calls.length, 2, 'dispatch must issue exactly two Jev calls')

  const workspaceBody = calls[0] as TwoStageBody
  assert.equal(workspaceBody.questions.workspace?.type, 'choice')
  assert.equal(workspaceBody.questions.session, undefined)
  assert.equal(workspaceBody.state.workspaces, undefined)
  const workspaceCriteria = workspaceBody.questions.workspace?.criteria ?? {}
  assert.equal(workspaceCriteria.w_0?.name, 'A')
  assert.equal(workspaceCriteria.w_0?.path, '/tmp/a')
  assert.deepEqual(workspaceCriteria.w_0?.recentSessionTitles, ['session one'])

  const sessionBody = calls[1] as TwoStageBody
  assert.equal(sessionBody.questions.workspace, undefined)
  assert.equal(sessionBody.questions.session?.type, 'choice')
  assert.deepEqual(Object.keys(sessionBody.questions.session?.criteria ?? {}), ['new', 's_0'])
  assert.deepEqual(sessionBody.state, workspaceBody.state, 'both stages share the same state')
})

test('two-stage: session options are scoped to the chosen workspace', async () => {
  const calls: TwoStageBody[] = []
  const { dispatch } = await setup({ jevCall: twoStageJev(calls, 'w_1') })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_two_2' })
  if (result.status !== 'needs_confirmation') return assert.fail('expected needs_confirmation')
  assert.equal(result.recommendation.workspaceId, 'ws-b')
  assert.deepEqual(Object.keys(calls[1]?.questions.session?.criteria ?? {}), ['new'], 'workspace B has no sessions')
})


// ---------------------------------------------------------------- 自动派发（autoDispatch）
test('autoDispatch on: gate pass dispatches without confirmation and records outcome=auto', async () => {
  const { dispatch, stores } = await setup({ autoDispatch: true })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_auto_1' })
  if (result.status !== 'dispatched') return assert.fail(`expected dispatched, got ${result.status}`)
  assert.equal(dispatch.currentPending(), null)
  const record = stores.dispatches.get(result.decisionId)
  assert.equal(record?.outcome, 'auto')
  assert.equal(record?.finalTarget?.workspaceId, 'ws-a')
  assert.equal(stores.tasks.get('task_1')?.status, 'queued')
})

test('autoDispatch on: low confidence still returns needs_confirmation', async () => {
  const low = async (): Promise<JevCallResult> => ({
    ok: true,
    latencyMs: 2,
    response: {
      answers: {
        workspace: { type: 'choice', choice: 'w_0', probabilities: { w_0: 0.4, w_1: 0.3 }, confidence: 0.2 },
        session: { type: 'choice', choice: 'new', probabilities: { new: 0.35, s_0: 0.3 }, confidence: 0.2 },
      },
    },
  })
  const { dispatch } = await setup({ autoDispatch: true, jevCall: low })
  const result = await dispatchWith(dispatch, { taskId: 'task_1', requestId: 'req_auto_2' })
  assert.equal(result.status, 'needs_confirmation')
  if (result.status !== 'needs_confirmation') return
  assert.equal(result.reason, 'low_confidence')
})
