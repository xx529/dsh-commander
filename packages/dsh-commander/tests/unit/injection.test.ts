// M3 turn/end 注入单测：触发条件/去重/截断/pending/合并/补一次/lastInjected。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createTurnReplyInjector, EMPTY_REPLY_TEXT, buildInjectionText } from '../../src/host/trigger/injection.ts'
import { createFakeStorageDomain } from '../fakes/fakes.ts'
import { INJECTION_TEXT_MAX, PROMPT_TEXT_MAX } from '../../src/host/config.ts'

const SESSION = { id: 'session-work-1' }

async function setup(options: { events?: unknown[]; projection?: unknown; deliver?: (text: string) => Promise<{ accepted?: boolean }>; isBusy?: () => boolean } = {}) {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.sessions.upsert({ v: 1, sessionId: SESSION.id, workspaceId: 'ws-a', taskId: 'task_1', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  // 只有 running/review 任务会被监控：默认给一个进行中的任务（与真实派发一致）。
  await stores.tasks.put({
    v: 1, id: 'task_1', title: 'T', goal: '', status: 'running', workspaceId: 'ws-a', priority: 'normal', commandId: '',
    assignments: [SESSION.id], acceptance: [], timeline: [], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  })
  const delivered: string[] = []
  const attempts: string[] = []
  const injector = createTurnReplyInjector({
    stores,
    deliver: async (text) => {
      attempts.push(text)
      if (options.deliver !== undefined) return options.deliver(text)
      delivered.push(text)
      return { accepted: true }
    },
    getSessionEvents: () => options.events ?? [],
    getProjection: () => options.projection,
    commanderSessionId: () => 'session-commander',
    ...(options.isBusy !== undefined ? { isBusy: options.isBusy } : {}),
    now: () => 1000,
  })
  return { stores, injector, delivered, attempts }
}

const TURN_ID = 7
const turnEnd = (reason = 'completed') => ({ seq: 12, type: 'turn/end', data: { turn: TURN_ID, reason: { kind: reason } } })
const assistant = (seq: number, text: string) => ({ seq, type: 'assistant/message', data: { turn: TURN_ID, message: { content: [{ type: 'text', text }] } } })

test('turn/end injects last assistant text with contract format and writes lastInjected', async () => {
  const { injector, delivered, stores } = await setup({
    events: [
      { seq: 5, type: 'turn/start', data: { turn: TURN_ID } },
      assistant(8, '做了导出修复，测试通过。'),
      assistant(10, '最终回复：修复完成，证据见 commit。'),
      turnEnd('completed'),
    ],
  })
  const outcome = await injector.handle(SESSION, turnEnd('completed'))
  assert.deepEqual(outcome, { status: 'injected', sessionId: SESSION.id, taskId: 'task_1', turnId: String(TURN_ID), seq: 10, truncated: false })
  assert.equal(delivered.length, 1)
  const text = delivered[0] as string
  assert.match(text, /^\[session-reply\] 最终回复：修复完成，证据见 commit。/)
  assert.match(text, /---\ntaskId=task_1 sessionId=session-work-1 turnId=7 seq=10 truncated=false/)
  const link = stores.sessions.list().find((item) => item.sessionId === SESSION.id)
  assert.deepEqual(link?.lastInjected, { turnId: String(TURN_ID), seq: 10, at: 1000 })
  assert.equal(injector.metrics.injections, 1)
  const deduped = await injector.handle(SESSION, turnEnd('completed'))
  assert.equal(deduped.status, 'deduped')
  assert.equal(delivered.length, 1)
  assert.equal(injector.metrics.deduped, 1)
})

test('只监控 running/review 任务：其它状态与缺失任务都不注入', async () => {
  const putTask = async (stores: Awaited<ReturnType<typeof setup>>['stores'], status: 'draft' | 'proposed' | 'queued' | 'blocked' | 'done' | 'archived' | 'cancelled' | 'review' | 'running'): Promise<void> => {
    await stores.tasks.put({
      v: 1, id: 'task_1', title: 'T', goal: '', status, workspaceId: 'ws-a', priority: 'normal', commandId: '',
      assignments: [SESSION.id], acceptance: [], timeline: [], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    })
  }
  for (const status of ['draft', 'proposed', 'queued', 'blocked', 'done', 'archived', 'cancelled'] as const) {
    const inactive = await setup({ events: [assistant(8, '完成'), turnEnd('completed')] })
    await putTask(inactive.stores, status)
    const outcome = await inactive.injector.handle(SESSION, turnEnd('completed'))
    assert.equal(outcome.status, 'skipped', status)
    if (outcome.status === 'skipped') assert.equal(outcome.reason, 'task_inactive', status)
    assert.equal(inactive.delivered.length, 0, status)
  }
  for (const status of ['running', 'review'] as const) {
    const active = await setup({ events: [assistant(8, '完成'), turnEnd('completed')] })
    await putTask(active.stores, status)
    assert.equal((await active.injector.handle(SESSION, turnEnd('completed'))).status, 'injected', status)
  }
})

test('non-allowed reason / no work link / commander session are skipped', async () => {
  const { injector } = await setup({ events: [assistant(8, 'x'), turnEnd('aborted')] })
  assert.equal((await injector.handle(SESSION, turnEnd('aborted'))).status, 'skipped')
  assert.equal((await injector.handle(SESSION, turnEnd('interrupted'))).status, 'skipped')
  const noLink = await setup({ events: [assistant(8, 'x'), turnEnd('completed')] })
  await noLink.stores.sessions.upsert({ v: 1, sessionId: 'session-other', workspaceId: 'ws-a', taskId: 'task_x', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const other = await noLink.injector.handle({ id: 'session-none' }, turnEnd('completed'))
  assert.equal(other.status, 'skipped')
})

test('pending approval / active user questions skip injection and count pendingSkipped', async () => {
  const approval = await setup({
    events: [
      { seq: 5, type: 'approval/asked', data: {} },
      assistant(8, '需要审批'),
      turnEnd('completed'),
    ],
  })
  const first = await approval.injector.handle(SESSION, turnEnd('completed'))
  assert.equal(first.status, 'skipped')
  if (first.status === 'skipped') assert.equal(first.reason, 'pending_interaction')
  assert.equal(approval.injector.metrics.pendingSkipped, 1)
  // 投影不可用 → fail-open（仍注入）+ 只计数 projectionUnavailable
  const unavailable = await setup({ events: [assistant(8, '无投影'), turnEnd('completed')] })
  assert.equal((await unavailable.injector.handle(SESSION, turnEnd('completed'))).status, 'injected')
  assert.equal(unavailable.injector.metrics.projectionUnavailable, 1)
  const questions = await setup({
    events: [assistant(8, '提问'), turnEnd('completed')],
    projection: { userQuestions: { active: [{ id: 'q1' }] } },
  })
  const second = await questions.injector.handle(SESSION, turnEnd('completed'))
  assert.equal(second.status, 'skipped')
  assert.equal(questions.injector.metrics.pendingSkipped, 1)
  // 已配对（asked 后有 decided）则允许注入
  const resolved = await setup({ events: [{ seq: 5, type: 'approval/asked', data: {} }, { seq: 6, type: 'approval/decided', data: {} }, assistant(8, 'ok'), turnEnd('completed')] })
  assert.equal((await resolved.injector.handle(SESSION, turnEnd('completed'))).status, 'injected')
})

test('empty reply injects constant; long reply truncated to 8KB head6/tail2', async () => {
  const empty = await setup({ events: [{ seq: 1, type: 'turn/start', data: { turn: TURN_ID } }, turnEnd('completed')] })
  await empty.injector.handle(SESSION, turnEnd('completed'))
  assert.ok((empty.delivered[0] as string).includes(EMPTY_REPLY_TEXT))
  const long = `${'头'.repeat(7000)}${'尾'.repeat(4000)}`
  const truncated = await setup({ events: [assistant(8, long), turnEnd('completed')] })
  const outcome = await truncated.injector.handle(SESSION, turnEnd('completed'))
  assert.equal(outcome.status, 'injected')
  if (outcome.status === 'injected') assert.equal(outcome.truncated, true)
  const text = truncated.delivered[0] as string
  assert.match(text, /\[truncated \d+ chars\]/)
  assert.match(text, /truncated=true/)
  // 整条（正文 + 元数据行）必须能过投递长度校验，否则长回复永远注入失败。
  assert.ok(Array.from(text).length <= PROMPT_TEXT_MAX)
  assert.ok(Array.from(text.split('\n---\n')[0] ?? '').length <= INJECTION_TEXT_MAX)
  assert.ok(text.startsWith('[session-reply] 头'))
  assert.ok(text.includes('尾\n---\ntaskId='))
})

test('delivery retries once; second failure records injectFailures and still writes lastInjected', async () => {
  let calls = 0
  const flaky = await setup({
    events: [assistant(8, 'x'), turnEnd('completed')],
    deliver: async () => {
      calls += 1
      if (calls === 1) throw new Error('network down')
      return { accepted: true }
    },
  })
  assert.equal((await flaky.injector.handle(SESSION, turnEnd('completed'))).status, 'injected')
  assert.equal(calls, 2)
  const failing = await setup({ events: [assistant(8, 'y'), turnEnd('completed')], deliver: async () => { throw new Error('always down') } })
  const outcome = await failing.injector.handle(SESSION, turnEnd('completed'))
  assert.equal(outcome.status, 'skipped')
  assert.equal(failing.injector.metrics.injectFailures, 1)
  assert.equal(failing.stores.sessions.list().find((item) => item.sessionId === SESSION.id)?.lastInjected?.seq, 8)
})

test('busy commander merges same-session stops: pending context flushes once', async () => {
  let busy = true
  const merged = await setup({ events: [assistant(8, '第一版'), turnEnd('completed')], isBusy: () => busy })
  const first = await merged.injector.handle(SESSION, turnEnd('completed'))
  assert.equal(first.status, 'skipped')
  busy = false
  await merged.injector.flush()
  assert.equal(merged.delivered.length, 1)
})

test('buildInjectionText keeps short text verbatim and marks truncated flag', () => {
  const short = buildInjectionText({ text: 'hello', taskId: 't', sessionId: 's', turnId: '1', seq: 2 })
  assert.equal(short.truncated, false)
  assert.match(short.text, /taskId=t sessionId=s turnId=1 seq=2 truncated=false/)
  const longText = 'x'.repeat(INJECTION_TEXT_MAX + 100)
  const long = buildInjectionText({ text: longText, taskId: 't', sessionId: 's', turnId: '1', seq: 2 })
  assert.equal(long.truncated, true)
  assert.match(long.text, /truncated=true/)
})
