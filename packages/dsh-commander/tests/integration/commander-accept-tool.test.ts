// commander_task_accept：有条件验收（有下游才放行）+ 交接说明 + 设置开关（accept-handoff-contract §3）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommanderTools } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeAgent, createFakeStorageDomain } from '../fakes/fakes.ts'
import type { TaskRecord } from '../../src/host/schema.ts'

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    id,
    title: id,
    goal: id,
    status: 'draft',
    workspaceId: 'ws',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }
}

const reviewAcceptance = [{ id: 'acc_1', text: 'A', source: 'commander' as const, state: 'evidence_present' as const }]

async function setup(tasks: TaskRecord[]) {
  const stores = createStores(await createFakeStorageDomain().open(commanderDomainSpec))
  for (const row of tasks) await stores.tasks.put(row)
  const calls: string[] = []
  const tools = createCommanderTools({
    ctx: { get: () => undefined } as never,
    stores,
    dispatchService: {
      dispatchTask: async () => ({ status: 'rejected' as const, code: 'x', message: 'x' }),
      currentPending: () => null,
      prune: () => 0,
      decisions: {} as never,
    },
    commanderSessionId: () => 'session-commander',
    now: () => 500,
    dependencyNotifier: { afterAccepted: async (taskId: string) => { calls.push(`accepted:${taskId}`) } },
    onTaskSettled: (taskId) => { calls.push(`settled:${taskId}`) },
  })
  await tools.prepare()
  const specs = tools.specs() as Record<string, { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }>
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const otherExec = { agent: createFakeAgent({ sessionId: 'session-other' }), signal: { throwIfAborted: () => undefined } }
  return { stores, specs, exec, otherExec, calls }
}

test('accepts a review task that has an unfinished dependent and writes the handoff note', async () => {
  const host = await setup([
    task('task_a', { status: 'review', acceptance: reviewAcceptance }),
    task('task_b', { status: 'draft', dependsOn: ['task_a'] }),
  ])
  const result = await host.specs.commander_task_accept?.execute({ taskId: 'task_a', note: '交接：沿用 v2 接口' }, host.exec)
  assert.equal(result?.status, 'done')
  assert.equal(result?.acceptedBy, 'commander')
  assert.deepEqual(result?.dependents, ['task_b'])
  assert.equal(result?.duplicate, false)
  const stored = host.stores.tasks.get('task_a')
  assert.equal(stored?.acceptNote?.text, '交接：沿用 v2 接口')
  assert.equal(stored?.acceptedBy, 'commander')
  assert.deepEqual(host.calls, ['settled:task_a', 'accepted:task_a'])
})

test('rejects when the task has no unfinished dependents (chain tail stays human-only)', async () => {
  const host = await setup([task('task_a', { status: 'review', acceptance: reviewAcceptance })])
  const result = await host.specs.commander_task_accept?.execute({ taskId: 'task_a' }, host.exec)
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'no_dependents')
  assert.equal(host.stores.tasks.get('task_a')?.status, 'review')
  assert.deepEqual(host.calls, [])
})

test('cancelled/archived dependents do not count as downstream', async () => {
  const host = await setup([
    task('task_a', { status: 'review', acceptance: reviewAcceptance }),
    task('task_b', { status: 'cancelled', dependsOn: ['task_a'] }),
  ])
  const result = await host.specs.commander_task_accept?.execute({ taskId: 'task_a' }, host.exec)
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'no_dependents')
})

test('respects commander.allowCommanderAccept=false', async () => {
  const host = await setup([
    task('task_a', { status: 'review', acceptance: reviewAcceptance }),
    task('task_b', { status: 'draft', dependsOn: ['task_a'] }),
  ])
  await host.stores.config.update((current) => ({ ...current, commander: { ...current.commander, allowCommanderAccept: false } }))
  const result = await host.specs.commander_task_accept?.execute({ taskId: 'task_a' }, host.exec)
  assert.equal(result?.ok, false)
  assert.equal(result?.code, 'accept_disabled')
  assert.equal(host.stores.tasks.get('task_a')?.status, 'review')
})

test('is idempotent on done tasks and does not overwrite the note', async () => {
  const host = await setup([
    task('task_a', { status: 'review', acceptance: reviewAcceptance }),
    task('task_b', { status: 'draft', dependsOn: ['task_a'] }),
  ])
  await host.specs.commander_task_accept?.execute({ taskId: 'task_a', note: '第一次结论' }, host.exec)
  const again = await host.specs.commander_task_accept?.execute({ taskId: 'task_a', note: '不应覆盖' }, host.exec)
  assert.equal(again?.status, 'done')
  assert.equal(again?.duplicate, true)
  assert.equal(host.stores.tasks.get('task_a')?.acceptNote?.text, '第一次结论')
})

test('rejects non-review tasks and non-commander callers', async () => {
  const host = await setup([
    task('task_a', { status: 'running' }),
    task('task_b', { status: 'draft', dependsOn: ['task_a'] }),
  ])
  const notReview = await host.specs.commander_task_accept?.execute({ taskId: 'task_a' }, host.exec)
  assert.equal(notReview?.code, 'invalid_status')
  const stranger = await host.specs.commander_task_accept?.execute({ taskId: 'task_b' }, host.otherExec)
  assert.equal(stranger?.code, 'forbidden_scope')
})
