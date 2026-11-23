// task-67 性能护栏：sessions 路由/dispatch 候选不再全量 listSessions；大 corpus 下只按 registry ids 读取标题。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord } from '../../src/host/schema.ts'
import { collectDispatchContext } from '../../src/host/dispatch/candidates.ts'
import { createFakeCtx, createFakeSessionController, createFakeSessionQuery, createFakeStorageDomain, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

const CORPUS_SIZE = 5_000
const TARGET_IDS = Array.from({ length: 20 }, (_, index) => `session-target-${index}`)

function buildCorpus(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    rows.push({ id: `session-other-${index}`, workspaceId: 'ws-other', title: `无关会话 ${index}`, updatedAt: index })
  }
  for (const id of TARGET_IDS) rows.push({ id, workspaceId: 'ws-target', title: `目标会话 ${id}`, updatedAt: 1_000 })
  return rows
}

function spyQuery(rows: Array<Record<string, unknown>>, titles?: Record<string, string>, perIdDelayMs = 0) {
  const base = createFakeSessionQuery(rows, { ...(titles !== undefined ? { titles } : {}), titleUpdatedAt: 1234 })
  const stats = { listCalls: 0, titleCalls: [] as string[][] }
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const spy = {
    ...base,
    async listSessions(...args: unknown[]) {
      stats.listCalls += 1
      return (base.listSessions as (...inner: unknown[]) => Promise<unknown[]>)(...args)
    },
    async readTitleSnapshots(ids: readonly string[], ...args: unknown[]) {
      stats.titleCalls.push([...ids])
      if (perIdDelayMs > 0) await sleep(ids.length * perIdDelayMs) // 模拟每次标题折叠读日志成本
      return (base.readTitleSnapshots as (inner: readonly string[], ...rest: unknown[]) => Promise<unknown[]>)(ids, ...args)
    },
  }
  return { spy, stats }
}

const targets = Object.fromEntries(TARGET_IDS.map((id) => [id, `目标会话 ${id}`]))

test('sessions 路由：大 corpus（5000 无关）不调用 listSessions，只按 registry ids 读标题且 <2s', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const { spy, stats } = spyQuery(buildCorpus(), targets)
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-target', name: 'Target', path: '/tmp/target', sessionIds: TARGET_IDS }]),
      sessionQuery: spy,
    },
  })
  await apply(ctx)
  const startedAt = Date.now()
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-target&limit=5')
  const elapsed = Date.now() - startedAt
  assert.equal(response.status, 200)
  const sessions = (response.body as { sessions: Array<{ sessionId: string; title: string }> }).sessions
  assert.equal(sessions.length, 5)
  assert.equal(stats.listCalls, 0, 'must not fall back to full listSessions')
  assert.equal(stats.titleCalls.length, 1)
  assert.equal(stats.titleCalls[0]?.length, 5, 'title snapshots only for the limited page (no full workspace fold)')
  assert.ok((sessions[0]?.title ?? '').length > 0)
  assert.ok(elapsed < 2_000, `sessions route took ${elapsed}ms`)
})

test('dispatch 候选：大 corpus 不调用 listSessions，只读 allowed workspace 的会话 ids', async () => {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.workspaces.replaceAll([{ ...defaultWorkspaceRecord({ id: 'ws-target', name: 'Target', path: '/tmp/target' }), allowed: true }])
  const { spy, stats } = spyQuery(buildCorpus(), targets)
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-target', name: 'Target', path: '/tmp/target', sessionIds: TARGET_IDS }]),
      sessionQuery: spy,
    },
  })
  const startedAt = Date.now()
  const context = await collectDispatchContext({ ctx, stores, commanderSessionId: '' })
  const elapsed = Date.now() - startedAt
  assert.equal(stats.listCalls, 0)
  assert.equal(stats.titleCalls.reduce((sum, ids) => sum + ids.length, 0), TARGET_IDS.length)
  assert.equal(context.sessions.length, TARGET_IDS.length)
  assert.ok(context.sessions.every((session) => session.title.startsWith('目标会话')))
  assert.ok(elapsed < 2_000, `collectDispatchContext took ${elapsed}ms`)
})

test('无 registry ids 的回退：metadata listSessions 一次，标题只读 cwd 匹配 ids（不读全 corpus）', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const rows = buildCorpus()
  rows.push({ id: 'session-cwd-match', workspaceId: '', cwd: '/tmp/target', title: 'cwd 匹配会话', updatedAt: 2_000 })
  const { spy, stats } = spyQuery(rows, { 'session-cwd-match': 'cwd 匹配会话' })
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-target', name: 'Target', path: '/tmp/target', sessionIds: [] }]),
      sessionQuery: spy,
    },
  })
  await apply(ctx)
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-target')
  assert.equal(response.status, 200)
  const sessions = (response.body as { sessions: Array<{ sessionId: string; title: string }> }).sessions
  assert.deepEqual(sessions.map((session) => session.sessionId), ['session-cwd-match'])
  assert.equal(sessions[0]?.title, 'cwd 匹配会话')
  assert.equal(stats.listCalls, 1, 'fallback lists metadata once')
  assert.deepEqual(stats.titleCalls[0], ['session-cwd-match'], 'titles only for cwd-matched ids')
})


test('标题成本按 ids 线性：大 corpus 下只付匹配会话成本（模型化 before/after）', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const perIdDelayMs = 3
  const { spy, stats } = spyQuery(buildCorpus(), targets, perIdDelayMs)
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      controller: undefined,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-target', name: 'Target', path: '/tmp/target', sessionIds: TARGET_IDS }]),
      sessionQuery: spy,
    },
  })
  await apply(ctx)
  const startedAt = Date.now()
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-target&limit=5')
  const elapsed = Date.now() - startedAt
  assert.equal(response.status, 200)
  assert.equal(stats.titleCalls[0]?.length, 5)
  // 新路径：5 ids × 3ms ≈ 60ms；旧路径若全量 5000+ ids 则 ≈ (CORPUS_SIZE+20)*3ms > 15s（模型化对比）
  assert.ok(CORPUS_SIZE * perIdDelayMs > 10_000)
  assert.ok(elapsed < 2_000, `fast path ${elapsed}ms should be far below 2s`)
})


test('大列表标题读取分块并行：20 ids 会拆成多次 readTitleSnapshots（无重复）', async () => {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const { spy, stats } = spyQuery(buildCorpus(), targets)
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-target', name: 'Target', path: '/tmp/target', sessionIds: TARGET_IDS }]),
      sessionQuery: spy,
    },
  })
  await apply(ctx)
  const response = await webServer.invoke('GET', '/commander/sessions?workspaceId=ws-target&limit=20')
  assert.equal(response.status, 200)
  assert.ok(stats.titleCalls.length >= 2, 'large id list must be split into parallel chunks')
  const flattened = stats.titleCalls.flat()
  assert.equal(flattened.length, 20)
  assert.equal(new Set(flattened).size, 20, 'no duplicate ids across chunks')
})
