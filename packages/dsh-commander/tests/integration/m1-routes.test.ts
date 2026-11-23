// M1 路由集成：GET /commander/tasks/:id（含 404）、POST /commander/jev/test（无 key 时 ok:false 且不回传 key）。
import test from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord, type TaskRecord } from '../../src/host/schema.ts'
import { createFakeCtx, createFakeSessionController, createFakeStorageDomain, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

async function createAppliedHost() {
  const storage = createFakeStorageDomain()
  const domain = await storage.open(commanderDomainSpec)
  const stores = createStores(domain)
  const task: TaskRecord = {
    v: 1,
    id: 'task_route_1',
    title: '路由任务',
    goal: '目标',
    status: 'proposed',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    reportSummary: { text: '本轮完成导出修复，测试通过；边界用例待补。', at: 2 },
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  await stores.tasks.put(task)
  await stores.workspaces.replaceAll([{ ...defaultWorkspaceRecord({ id: 'ws-a', name: 'A', path: '/tmp/a' }), allowed: true }])
  const webServer = createFakeWebServer()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: [] }]),
    },
  })
  await apply(ctx)
  return { ctx, webServer, stores }
}

test('GET /commander/tasks/:id returns task detail and 404 for unknown', async () => {
  const host = await createAppliedHost()
  const found = await host.webServer.invoke('GET', '/commander/tasks/task_route_1')
  assert.equal(found.status, 200)
  const body = found.body as { ok: boolean; task: { id: string; title: string }; timeline: unknown[]; sessions: unknown[]; reportSummary?: { text: string; at: number } }
  assert.equal(body.ok, true)
  assert.equal(body.task.id, 'task_route_1')
  assert.equal(body.task.title, '路由任务')
  assert.equal(body.timeline.length, 1)
  assert.deepEqual(body.sessions, [])
  // commander_task_report 的 summary 经详情接口透出（看板抽屉展示）。
  assert.deepEqual(body.reportSummary, { text: '本轮完成导出修复，测试通过；边界用例待补。', at: 2 })
  const missing = await host.webServer.invoke('GET', '/commander/tasks/task_missing')
  assert.equal(missing.status, 404)
  assert.equal((missing.body as { code: string }).code, 'not_found')
})

test('GET /commander/tasks/:id projects report materials and signs local image URLs', async () => {
  const host = await createAppliedHost()
  const task = host.stores.tasks.get('task_route_1')
  assert.ok(task !== undefined)
  await host.stores.tasks.put({
    ...task,
    reportMaterials: [
      { id: 'mat_link', kind: 'link', title: '官方发布记录', url: 'https://docs.z.ai/release-notes', source: 'commander', state: 'unverified' },
      { id: 'mat_img', kind: 'image', title: '配置截图', path: '/tmp/shot.png', source: 'presented', state: 'ok' },
    ],
    version: task.version + 1,
    updatedAt: task.updatedAt + 1,
  })
  const response = await host.webServer.invoke('GET', '/commander/tasks/task_route_1')
  assert.equal(response.status, 200)
  const body = response.body as { reportMaterials?: Array<{ id: string; kind: string; title: string; imageUrl?: string }> }
  assert.equal(body.reportMaterials?.length, 2)
  assert.equal(body.reportMaterials?.[0]?.imageUrl, undefined)
  assert.match(body.reportMaterials?.[1]?.imageUrl ?? '', /\/commander\/tasks\/task_route_1\/materials\/mat_img\?sig=/)
})

test('GET material asset route serves a signed local image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-commander-route-mat-'))
  try {
    const png = join(dir, 'shot.png')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    const realPng = await realpath(png)
    const host = await createAppliedHost()
    const task = host.stores.tasks.get('task_route_1')
    assert.ok(task !== undefined)
    await host.stores.tasks.put({
      ...task,
      reportMaterials: [{ id: 'mat_route_img', kind: 'image', title: '截图', path: realPng, source: 'presented', state: 'ok' }],
      version: task.version + 1,
      updatedAt: task.updatedAt + 1,
    })
    const detail = await host.webServer.invoke('GET', '/commander/tasks/task_route_1')
    const imageUrl = (detail.body as { reportMaterials?: Array<{ imageUrl?: string }> }).reportMaterials?.[0]?.imageUrl
    assert.ok(imageUrl !== undefined)
    const url = new URL(imageUrl as string)
    const asset = await host.webServer.invoke('GET', `${url.pathname}${url.search}`)
    assert.equal(asset.status, 200)
    const headers = (asset as { headers?: Record<string, string> }).headers ?? {}
    assert.equal(headers['content-type'], 'image/png')
    assert.equal(headers['x-content-type-options'], 'nosniff')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /commander/jev/test without configured key returns ok:false and never echoes a key', async () => {
  const host = await createAppliedHost()
  const previous = process.env.JEV_TEST_MISSING_ENV
  delete process.env.JEV_TEST_MISSING_ENV
  const response = await host.webServer.invoke('POST', '/commander/jev/test', { apiKeyEnv: 'JEV_TEST_MISSING_ENV' })
  assert.equal(response.status, 200)
  const body = response.body as { ok: boolean; code?: string; hasApiKey?: boolean; apiKeyEnv?: string }
  assert.equal(body.ok, false)
  assert.equal(body.code, 'jev_unavailable')
  assert.equal(body.hasApiKey, false)
  assert.equal(body.apiKeyEnv, 'JEV_TEST_MISSING_ENV')
  assert.equal(JSON.stringify(body).toLowerCase().includes('bearer'), false)
  if (previous !== undefined) process.env.JEV_TEST_MISSING_ENV = previous
})

test('snapshot exposes pendingDispatch:null before any dispatch (M1 field present)', async () => {
  const host = await createAppliedHost()
  const state = await host.webServer.invoke('GET', '/commander/state')
  assert.equal(state.status, 200)
  const body = state.body as { pendingDispatch: unknown; tasks: Array<{ capability?: { status: string } }> }
  assert.equal(body.pendingDispatch, null)
  assert.equal(body.tasks[0]?.capability?.status, 'none')
})
