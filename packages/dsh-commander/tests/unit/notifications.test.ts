// 依赖提醒：backfill 只提醒有 dependsOn 的 ready 任务；投递成功写 dependencyNotifiedAt。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRecord } from '../../src/host/schema.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeStorageDomain } from '../fakes/fakes.ts'
import { createDependencyNotifier } from '../../src/host/tasks/notifications.ts'

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1, id, title: id, goal: id, status: 'draft', workspaceId: 'ws', priority: 'normal', commandId: '',
    assignments: [], acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1, ...overrides,
  }
}

test('backfill does not notify plain tasks without dependencies; ready dependent gets one notice and a timestamp', async () => {
  const stores = createStores(await createFakeStorageDomain().open(commanderDomainSpec))
  await stores.tasks.put(task('task_a', { status: 'done' }))
  await stores.tasks.put(task('task_b', { dependsOn: ['task_a'], updatedAt: 2 }))
  await stores.tasks.put(task('task_plain'))
  const delivered: string[] = []
  const notifier = createDependencyNotifier({
    stores,
    deliverer: { deliverContextMessage: async (text: string) => { delivered.push(text); return { accepted: true, queued: false, busy: false, sessionId: 's' } } } as never,
    now: () => 500,
  })
  await notifier.backfill()
  assert.equal(delivered.length, 1)
  assert.match(delivered[0] ?? '', /\[task-unblocked\] taskId=task_b/)
  assert.equal(stores.tasks.get('task_b')?.dependencyNotifiedAt, 500)
  assert.equal(stores.tasks.get('task_plain')?.dependencyNotifiedAt, undefined)
  // 已提醒过：再次 backfill 不重复
  await notifier.backfill()
  assert.equal(delivered.length, 1)
  notifier.dispose()
})
