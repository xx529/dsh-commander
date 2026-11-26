import test from 'node:test'
import assert from 'node:assert/strict'
import { createFakeStorageDomain } from '../fakes/fakes.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createStores } from '../../src/host/store/index.ts'
import { VersionConflictError } from '../../src/host/store/base.ts'
import { defaultConfigRecord } from '../../src/host/schema.ts'

async function setup() {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  return { storage, domain, stores: createStores(domain) }
}

test('config store seeds default once and persists across reopen', async () => {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  const first = await stores.config.ensureInitialized(1000)
  assert.equal(first.initialized, true)
  assert.equal(first.config.updatedAt, 1000)
  const second = await stores.config.ensureInitialized(2000)
  assert.equal(second.initialized, false)
  assert.equal(second.config.updatedAt, 1000)
  const updated = await stores.config.update((current) => ({ ...current, jev: { ...current.jev, threshold: 0.85 } }), 3000)
  assert.equal(updated.jev.threshold, 0.85)
  assert.equal(updated.updatedAt, 3000)
  // 模拟 Host 重启：同一介质重新 open
  const reopenedDomain = await storage.open(commanderDomainSpec)
  const reopened = createStores(reopenedDomain)
  assert.equal(reopened.config.get().jev.threshold, 0.85)
  assert.equal(reopened.config.get().commander.sessionId, '')
})

test('config store fills ui defaults for legacy records (entryEnabled/entryPos)', async () => {
  const { stores } = await setup()
  await stores.config.update((current) => ({
    ...current,
    // 旧版本落盘的 ui：没有 entryEnabled / entryPos
    ui: { theme: 'dark', entryPosition: 'bl', hotkey: '' },
  }), 500)
  const config = stores.config.get()
  assert.equal(config.ui.theme, 'dark')
  assert.equal(config.ui.entryPosition, 'bl')
  assert.equal(config.ui.entryEnabled, true, '缺省视为开启浮窗')
  assert.equal(config.ui.nativeShell, true, '缺省视为开启原生壳')
  assert.equal(config.ui.entryPos, undefined, '没有自由位置时回落到默认角落')
})

test('workspace store replaceAll deletes stale records', async () => {
  const { stores } = await setup()
  const record = (id: string) => ({
    v: 1 as const,
    id,
    name: id,
    path: `/tmp/${id}`,
    allowed: true,
    summary: '',
    summarySource: 'manual' as const,
    capabilityPolicy: { mode: 'inherit' as const },
  })
  await stores.workspaces.replaceAll([record('a'), record('b')])
  assert.deepEqual(stores.workspaces.list().map((item) => item.id).sort(), ['a', 'b'])
  await stores.workspaces.replaceAll([record('b')])
  assert.deepEqual(stores.workspaces.list().map((item) => item.id), ['b'])
})

test('workspace store patch updates summary without clobbering allowlist/policy', async () => {
  const { stores } = await setup()
  const record = {
    v: 1 as const,
    id: 'a',
    name: 'A',
    path: '/tmp/a',
    allowed: true,
    summary: 'old',
    summarySource: 'manual' as const,
    capabilityPolicy: { mode: 'auto' as const, lastSelection: { status: 'applied' as const, enabled: ['x'], disabled: [], at: 1 } },
  }
  await stores.workspaces.put(record)
  const updated = await stores.workspaces.patch('a', (current) => ({ ...current, summary: 'new', summarySource: 'model' as const }))
  assert.equal(updated?.summary, 'new')
  assert.equal(updated?.summarySource, 'model')
  const stored = stores.workspaces.get('a')
  assert.equal(stored?.allowed, true)
  assert.equal(stored?.capabilityPolicy.mode, 'auto')
  assert.deepEqual(stored?.capabilityPolicy.lastSelection?.enabled, ['x'])
  assert.equal(await stores.workspaces.patch('missing', (current) => current), undefined)
})

test('task store appendTimeline increments version and enforces optimistic version', async () => {
  const { stores } = await setup()
  const base = {
    v: 1 as const,
    id: 'task_1',
    title: 't',
    goal: 'g',
    status: 'draft' as const,
    workspaceId: 'ws',
    priority: 'normal' as const,
    commandId: 'cmd_1',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created' as const, text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  await stores.tasks.put(base)
  const next = await stores.tasks.appendTimeline('task_1', { at: 2, type: 'status', text: 'next' })
  assert.equal(next.version, 2)
  assert.equal(next.timeline.length, 2)
  await assert.rejects(
    () => stores.tasks.appendTimeline('task_1', { at: 3, type: 'status', text: 'stale' }, 1),
    (error: unknown) => error instanceof VersionConflictError,
  )
})

test('config default record schema is stable', async () => {
  const { stores } = await setup()
  await stores.config.ensureInitialized(1)
  assert.equal(stores.config.get().jev.threshold, defaultConfigRecord(1).jev.threshold)
})
