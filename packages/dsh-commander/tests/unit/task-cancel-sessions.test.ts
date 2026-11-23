// 取消任务必须同时停止关联 running/queued 工作会话（2026-11-20 live 反馈）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommanderTools } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeAgent, createFakeCtx, createFakeSessionController, createFakeStorageDomain, createFakeTools } from '../fakes/fakes.ts'
import type { TaskRecord } from '../../src/host/schema.ts'

async function setup(cancel: (sessionId: string) => Promise<unknown>) {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander', workspaceId: 'ws' } }), 1)
  const controller = createFakeSessionController()
  controller.cancel = async (request) => {
    assert.equal((request as { sessionId?: string }).sessionId, 's1')
    return cancel('s1')
  }
  const toolsService = createFakeTools()
  const ctx = {
    get: (name: string) => name === 'tools'
      ? toolsService
      : name === 'sessionController'
        ? controller
        : undefined,
  }
  const dispatchService = {
    dispatchTask: async () => ({ status: 'rejected' as const, code: 'x', message: 'x' }),
    currentPending: () => null,
    prune: () => 0,
    decisions: {} as never,
  }
  const tools = createCommanderTools({ ctx: ctx as never, stores, dispatchService, commanderSessionId: () => 'session-commander', now: () => 1000 })
  await tools.prepare()
  const task: TaskRecord = {
    v: 1, id: 'task_cancel', title: '跑着的任务', goal: 'G', status: 'running', workspaceId: 'ws', priority: 'normal',
    commandId: '', primarySessionId: 's1', assignments: ['s1'], acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  }
  await stores.tasks.put(task)
  await stores.sessions.upsert({ v: 1, sessionId: 's1', workspaceId: 'ws', taskId: task.id, role: 'work', mode: 'new', createdAt: 1, status: 'running' })
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const spec = tools.specs()?.commander_task_update as { execute: (args: unknown, exec: unknown) => Promise<unknown> }
  return { stores, tools, spec, exec }
}

test('commander_task_update action=cancel：先取消 running 会话，再写 cancelled', async () => {
  const cancelled: string[] = []
  const { stores, tools, spec, exec } = await setup(async (sessionId) => {
    cancelled.push(sessionId)
    return { accepted: true }
  })
  const result = (await spec.execute({ taskId: 'task_cancel', expectedRevision: 1, action: 'cancel' }, exec)) as { status: string; sessionsStopped?: number }
  assert.deepEqual(cancelled, ['s1'])
  assert.equal(result.status, 'cancelled')
  assert.equal(result.sessionsStopped, undefined)
  const task = stores.tasks.get('task_cancel')
  assert.equal(task?.status, 'cancelled')
  assert.match(task?.timeline.at(-1)?.text ?? '', /已停止 1 个关联会话/)
  tools.dispose()
})

test('commander_task_update action=cancel：会话取消失败则不取消任务，返回 delivery_failed', async () => {
  const { stores, tools, spec, exec } = await setup(async () => {
    throw new Error('permission denied')
  })
  const result = (await spec.execute({ taskId: 'task_cancel', expectedRevision: 1, action: 'cancel' }, exec)) as { ok: boolean; code: string; message: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'delivery_failed')
  assert.match(result.message, /s1/)
  assert.equal(stores.tasks.get('task_cancel')?.status, 'running')
  tools.dispose()
})
