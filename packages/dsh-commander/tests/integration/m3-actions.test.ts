// M3 人专用路由：accept（review→done）/ rework（先 prompt 成功才 review→running；失败 502 不改状态）；
// 快照 workSessions + metrics 字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
import { commanderDomainSpec } from '../../src/host/domain.ts'
import type { TaskRecord } from '../../src/host/schema.ts'
import { createFakeCtx, createFakeSessionController, createFakeStorageDomain, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

async function setup() {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: ['session-work-1'] }]),
      sessions: { get: async (sessionId: string) => ({ id: sessionId, events: [
        { seq: 1 },
        { seq: 5, type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '工作完成，证据见 commit。' }] } } },
        { seq: 10 },
      ] }) },
    },
  })
  await apply(ctx)
  const stores = createStores(await storage.open(commanderDomainSpec))
  return { webServer, controller, stores, ctx }
}

function seedReview(stores: ReturnType<typeof createStores>, overrides: Partial<TaskRecord> = {}): void {
  void stores.tasks.put({
    v: 1, id: 'task_m3_1', title: 'M3 任务', goal: '闭环验证', status: 'review', workspaceId: 'ws-a', priority: 'normal',
    commandId: '', primarySessionId: 'session-work-1', assignments: ['session-work-1'], acceptance: [{ id: 'acc_1', text: 'A', source: 'commander', state: 'evidence_present' }],
    timeline: [{ at: 1, type: 'created', text: 'created' }], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1, ...overrides,
  })
}

test('POST accept: review→done（timeline accept），重复幂等；非 review 409', async () => {
  const host = await setup()
  seedReview(host.stores)
  const accepted = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/accept', {})
  assert.equal(accepted.status, 200)
  const body = accepted.body as { ok: boolean; task: { status: string; timeline: Array<{ type: string }> }; duplicate: boolean }
  assert.equal(body.task.status, 'done')
  assert.ok(body.task.timeline.some((item) => item.type === 'accept'))
  const again = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/accept', {})
  assert.equal(again.status, 200)
  assert.equal((again.body as { duplicate: boolean }).duplicate, true)
  await host.stores.tasks.put({ ...(host.stores.tasks.get('task_m3_1') as TaskRecord), status: 'running', version: (host.stores.tasks.get('task_m3_1') as TaskRecord).version + 1 })
  const conflict = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/accept', {})
  assert.equal(conflict.status, 409)
  assert.equal((conflict.body as { code: string }).code, 'conflict')
})

test('POST accept: review 无 acceptance（历史脏数据）→ 仍可验收，timeline 注明无验收项', async () => {
  const host = await setup()
  seedReview(host.stores, { acceptance: [] })
  const response = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/accept', {})
  assert.equal(response.status, 200)
  const body = response.body as { task: { status: string; timeline: Array<{ type: string; text: string }> } }
  assert.equal(body.task.status, 'done')
  assert.ok(body.task.timeline.some((item) => item.type === 'accept' && item.text.includes('无验收项')))
})

test('POST continue: 写批注+timeline，状态保持 review，通知指挥官（不直接 prompt 工作会话）', async () => {
  const host = await setup()
  // 绑定指挥官后 requestContinue 才能投递上下文消息
  const bound = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', cwd: '/tmp/commander-ws', requestId: 'req_m3_bind_continue' })
  assert.equal(bound.status, 200)
  seedReview(host.stores)
  const response = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/continue', { comment: '边界用例没覆盖', requestId: 'req_m3_continue_1' })
  assert.equal(response.status, 200)
  const body = response.body as { task: { status: string; pendingInstruction?: { text: string }; timeline: Array<{ type: string }> }; notified: boolean; duplicate: boolean }
  assert.equal(body.task.status, 'review')
  assert.equal(body.task.pendingInstruction?.text, '边界用例没覆盖')
  assert.ok(body.task.timeline.some((item) => item.type === 'continue_request'))
  assert.equal(body.notified, true)
  assert.equal(body.duplicate, false)
  // 只给指挥官发上下文消息，不再直接 prompt 原工作会话
  const commanderPrompt = host.controller.prompts.find((item) => String((item.content as Array<{ text: string }>)[0]?.text ?? '').includes('[task-continue]'))
  assert.notEqual(commanderPrompt, undefined)
  const text = String((commanderPrompt?.content as Array<{ text: string }>)[0]?.text)
  assert.match(text, /边界用例没覆盖/)
  assert.match(text, /task_m3_1/)
  assert.equal(host.controller.prompts.some((item) => String((item.content as Array<{ text: string }>)[0]?.text ?? '').includes('上一轮验收未通过')), false)
})

test('POST continue: 指挥官不可投递 → 502 delivery_failed，状态保持 review 且批注保留', async () => {
  const host = await setup()
  seedReview(host.stores)
  const response = await host.webServer.invoke('POST', '/commander/tasks/task_m3_1/rework', { comment: 'x' })
  assert.equal(response.status, 502)
  assert.equal((response.body as { code: string }).code, 'delivery_failed')
  const task = host.stores.tasks.get('task_m3_1')
  assert.equal(task?.status, 'review')
  assert.equal(task?.pendingInstruction?.text, 'x')
})

test('state: workSessions + metrics 字段存在（M3 快照增补）', async () => {
  const host = await setup()
  seedReview(host.stores)
  await host.stores.sessions.upsert({ v: 1, sessionId: 'session-work-1', workspaceId: 'ws-a', taskId: 'task_m3_1', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const state = await host.webServer.invoke('GET', '/commander/state')
  assert.equal(state.status, 200)
  const body = state.body as { workSessions: Array<{ sessionId: string; taskId: string }>; metrics: Record<string, number> }
  assert.deepEqual(body.workSessions, [{ sessionId: 'session-work-1', taskId: 'task_m3_1' }])
  assert.deepEqual(body.metrics, { injections: 0, deduped: 0, pendingSkipped: 0, injectFailures: 0, projectionUnavailable: 0 })
})


test('session/event turn/end 经 apply 装配的 injector 注入 [session-reply] 给指挥官（去重一次）', async () => {
  const host = await setup()
  // 绑定指挥官（fake create → session-fake-1）
  const bound = await host.webServer.invoke('POST', '/commander/binding', { mode: 'new', cwd: '/tmp/commander-ws', requestId: 'req_m3_bind' })
  assert.equal(bound.status, 200)
  seedReview(host.stores, { status: 'running' })
  await host.stores.sessions.upsert({ v: 1, sessionId: 'session-work-1', workspaceId: 'ws-a', taskId: 'task_m3_1', role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const turnEnd = { seq: 12, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
  host.ctx.emit('session/event', { id: 'session-work-1' }, turnEnd)
  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<boolean> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return true
      await sleep(10)
    }
    return predicate()
  }
  const injected = await waitFor(() => host.controller.prompts.some((prompt) => String((prompt.content as Array<{ text: string }>)[0]?.text ?? '').includes('[session-reply]')))
  assert.equal(injected, true)
  const prompt = host.controller.prompts.find((item) => String((item.content as Array<{ text: string }>)[0]?.text ?? '').includes('[session-reply]'))
  const text = String((prompt?.content as Array<{ text: string }>)[0]?.text)
  assert.match(text, /\[session-reply\] 工作完成，证据见 commit。/)
  assert.match(text, /taskId=task_m3_1 sessionId=session-work-1 turnId=3 seq=5/)
  // 同 turn/seq 再次事件 → 去重，不再投递
  host.ctx.emit('session/event', { id: 'session-work-1' }, turnEnd)
  await sleep(80)
  assert.equal(host.controller.prompts.filter((item) => String((item.content as Array<{ text: string }>)[0]?.text ?? '').includes('[session-reply]')).length, 1)
})
