// 换代/绑定后定时任务跟随：scope 守卫、target 精确匹配、CAS、幂等、反例。
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateCommanderSchedules } from '../../src/host/schedule/migration.ts'
import type { ScheduleEditRequestLike, ScheduleEntryLike } from '../../src/host/dsh-types.ts'
import { createFakeCtx } from '../fakes/fakes.ts'

type FakeTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId: string }
  | { kind: 'new' }

interface FakeEntry {
  id: string
  status: 'active' | 'paused' | 'ended'
  updatedAt?: string
  target: FakeTarget
}

const clone = <T>(value: T): T => structuredClone(value)

function entry(
  id: string,
  status: FakeEntry['status'],
  target: FakeTarget,
  updatedAt = `u-${id}`,
): FakeEntry {
  return { id, status, target, updatedAt }
}

function createScheduleFake(seed: readonly FakeEntry[]) {
  const tasks = new Map(seed.map((item) => [item.id, clone(item)]))
  const calls = {
    catalog: 0,
    view: 0,
    edits: [] as Array<{ request: ScheduleEditRequestLike; actor: string | undefined }>,
  }
  const service = {
    async catalog(): Promise<readonly ScheduleEntryLike[]> {
      calls.catalog += 1
      return [...tasks.values()].map(clone)
    },
    async view(request: { id: string }): Promise<unknown> {
      calls.view += 1
      const current = tasks.get(request.id)
      return current === undefined ? { id: request.id, code: 'schedule_not_found' } : clone(current)
    },
    async edit(request: ScheduleEditRequestLike, actor?: string): Promise<unknown> {
      calls.edits.push({ request: clone(request), actor })
      const current = tasks.get(request.id)
      if (current === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
        return { id: request.id, code: 'schedule_conflict' }
      }
      current.target = clone(request.patch.target)
      current.updatedAt = `edited-${calls.edits.length}`
      return clone(current)
    },
  }
  return { service, tasks, calls }
}

function ctxWith(service: unknown, logs?: string[]) {
  return createFakeCtx({
    services: service === undefined ? {} : { schedule: service },
    ...(logs === undefined
      ? {}
      : {
          logger: {
            debug: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
            info: () => undefined,
            warn: () => undefined,
          },
        }),
  })
}

test('scope 守卫：旧 id 不是 commander link → 不枚举、不改写', async () => {
  const fake = createScheduleFake([entry('a', 'active', { kind: 'session', sessionId: 'old' })])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => false,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.skipped.notCommander, 1)
  assert.equal(fake.calls.catalog, 0)
  assert.equal(fake.calls.edits.length, 0)
})

test('反例：指向其他会话的 active 任务完全不变（target/status/updatedAt）', async () => {
  const other = entry('other', 'active', { kind: 'session', sessionId: 'session-other' })
  const old = entry('old-task', 'active', { kind: 'session', sessionId: 'old' })
  const beforeOther = clone(other)
  const fake = createScheduleFake([old, other])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.migrated, 1)
  assert.deepEqual(fake.tasks.get('other'), beforeOther)
  assert.deepEqual(fake.tasks.get('old-task')?.target, { kind: 'session', sessionId: 'new' })
  assert.equal(fake.calls.edits.length, 1)
  assert.equal(fake.calls.edits[0]?.request.id, 'old-task')
})

test('正例：旧 commander 下 active+paused+ended 三类都迁移，状态保持', async () => {
  const fake = createScheduleFake([
    entry('active', 'active', { kind: 'session', sessionId: 'old' }),
    entry('paused', 'paused', { kind: 'session', sessionId: 'old' }),
    entry('ended', 'ended', { kind: 'session', sessionId: 'old' }),
    entry('new', 'active', { kind: 'new' }),
    entry('new-once', 'active', { kind: 'new_once', sessionId: 'session-reserved' }),
    entry('other', 'active', { kind: 'session', sessionId: 'session-other' }),
  ])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.matched, 3)
  assert.equal(result.migrated, 3)
  for (const id of ['active', 'paused', 'ended']) {
    assert.deepEqual(fake.tasks.get(id)?.target, { kind: 'session', sessionId: 'new' })
  }
  assert.equal(fake.tasks.get('active')?.status, 'active')
  assert.equal(fake.tasks.get('paused')?.status, 'paused')
  assert.equal(fake.tasks.get('ended')?.status, 'ended')
  assert.deepEqual(fake.tasks.get('new')?.target, { kind: 'new' })
  assert.deepEqual(fake.tasks.get('new-once')?.target, { kind: 'new_once', sessionId: 'session-reserved' })
  assert.deepEqual(fake.tasks.get('other')?.target, { kind: 'session', sessionId: 'session-other' })
})

test('includeEnded=false：ended 只跳过、不改写；active/paused 照迁', async () => {
  const fake = createScheduleFake([
    entry('active', 'active', { kind: 'session', sessionId: 'old' }),
    entry('paused', 'paused', { kind: 'session', sessionId: 'old' }),
    entry('ended', 'ended', { kind: 'session', sessionId: 'old' }),
  ])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    includeEnded: false,
    isCommanderSession: () => true,
  })
  assert.equal(result.migrated, 2)
  assert.equal(result.skipped.ended, 1)
  assert.deepEqual(fake.tasks.get('ended')?.target, { kind: 'session', sessionId: 'old' })
})

test('幂等：第二次触发不再改写，edits 不增加', async () => {
  const fake = createScheduleFake([entry('a', 'active', { kind: 'session', sessionId: 'old' })])
  const input = {
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  }
  const first = await migrateCommanderSchedules(input)
  assert.equal(first.migrated, 1)
  const editsAfterFirst = fake.calls.edits.length
  const second = await migrateCommanderSchedules(input)
  assert.equal(second.migrated, 0)
  assert.equal(second.matched, 0)
  assert.equal(fake.calls.edits.length, editsAfterFirst)
})

test('CAS 冲突：重读最新 revision 后重试一次成功', async () => {
  let stored: FakeEntry = entry('a', 'active', { kind: 'session', sessionId: 'old' }, 'u1')
  let edits = 0
  const service = {
    async catalog() { return [clone(stored)] },
    async view() {
      stored = { ...stored, updatedAt: 'u2' }
      return clone(stored)
    },
    async edit(request: ScheduleEditRequestLike) {
      edits += 1
      if (edits === 1) return { id: request.id, code: 'schedule_conflict' }
      assert.equal(request.expectedUpdatedAt, 'u2')
      stored = { ...stored, target: clone(request.patch.target), updatedAt: 'u3' }
      return clone(stored)
    },
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.migrated, 1)
  assert.equal(edits, 2)
  assert.deepEqual(stored.target, { kind: 'session', sessionId: 'new' })
})

test('CAS 冲突但用户已改走 target：skip changed，不再重试', async () => {
  let edits = 0
  const changed: FakeEntry = entry('a', 'active', { kind: 'session', sessionId: 'user-target' }, 'u2')
  const service = {
    async catalog() { return [entry('a', 'active', { kind: 'session', sessionId: 'old' }, 'u1')] },
    async view() { return clone(changed) },
    async edit() { edits += 1; return { id: 'a', code: 'schedule_conflict' } },
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.skipped.changed, 1)
  assert.equal(result.migrated, 0)
  assert.equal(edits, 1)
})

test('并发的 schedule_not_found：按 gone 跳过，不报错', async () => {
  const service = {
    async catalog() { return [entry('a', 'active', { kind: 'session', sessionId: 'old' })] },
    async view() { return { id: 'a', code: 'schedule_not_found' } },
    async edit() { return { id: 'a', code: 'schedule_not_found' } },
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.skipped.gone, 1)
  assert.equal(result.failed.length, 0)
})

test('单条 edit 抛错：记 failed，后续任务继续迁移（partial）', async () => {
  const fake = createScheduleFake([
    entry('bad', 'active', { kind: 'session', sessionId: 'old' }),
    entry('good', 'active', { kind: 'session', sessionId: 'old' }),
  ])
  const originalEdit = fake.service.edit
  fake.service.edit = async (request, actor) => {
    if (request.id === 'bad') throw Object.assign(new Error('boom'), { code: 'edit_broke' })
    return originalEdit(request, actor)
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.migrated, 1)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failed.map((item) => item.code), ['edit_broke'])
  assert.deepEqual(fake.tasks.get('good')?.target, { kind: 'session', sessionId: 'new' })
})

test('catalog 抛错：整次 failed，不阻断调用方', async () => {
  const service = {
    async catalog() { throw Object.assign(new Error('store down'), { code: 'catalog_broke' }) },
    async edit() { return {} },
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.failed.map((item) => item.code), ['catalog_broke'])
})

test('schedule 服务缺失：unavailable，不抛错', async () => {
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(undefined),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.failed.length, 0)
})

test('from 为空/相同：skipped，不访问 schedule 服务', async () => {
  const fake = createScheduleFake([])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'old',
    isCommanderSession: () => true,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(fake.calls.catalog, 0)
})

test('并发绑定守卫：迁移时当前绑定已不是 to → skipped.staleBinding', async () => {
  const fake = createScheduleFake([entry('a', 'active', { kind: 'session', sessionId: 'old' })])
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(fake.service),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
    isCurrentCommander: () => false,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.skipped.staleBinding, 1)
  assert.equal(fake.calls.catalog, 0)
})

test('debug 日志：未匹配任务与 scope 跳过都可排查', async () => {
  const logs: string[] = []
  const fake = createScheduleFake([
    entry('old-task', 'active', { kind: 'session', sessionId: 'old' }),
    entry('other', 'active', { kind: 'session', sessionId: 'other' }),
  ])
  await migrateCommanderSchedules({
    ctx: ctxWith(fake.service, logs),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => true,
  })
  assert.ok(logs.some((line) => line.includes('reason: \'not_target\'') && line.includes('other')))
  const skippedLogs: string[] = []
  await migrateCommanderSchedules({
    ctx: ctxWith(fake.service, skippedLogs),
    fromSessionId: 'old',
    toSessionId: 'new',
    isCommanderSession: () => false,
  })
  assert.ok(skippedLogs.some((line) => line.includes('from_not_commander')))
})

test('总超时：catalog 不返回 → timeout，不挂起调用方', async () => {
  const service = {
    catalog: () => new Promise<never>(() => undefined),
    async edit() { return {} },
  }
  const result = await migrateCommanderSchedules({
    ctx: ctxWith(service),
    fromSessionId: 'old',
    toSessionId: 'new',
    timeoutMs: 10,
    isCommanderSession: () => true,
  })
  assert.equal(result.status, 'timeout')
  assert.deepEqual(result.failed.map((item) => item.code), ['timeout'])
})
