// task-65 live 修复回归：真实 sessionQuery 形状（SessionRecord.header）→ sessions 路由标题/创建时间/子会话过滤；
// bindSelect 冷会话（sessions.get undefined）可绑定；未知 id / workspace 不匹配错误；标题批量失败降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createFakeCtx, createFakeSessionController, createFakeSessionQuery, createFakeStorageDomain, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

const RECORDS = [
  { header: { id: 'session-cold-a', cwd: '/tmp/ws-a', createdAt: 111, version: 4, isSeeded: false, agentPreset: 'standard' }, live: false, persisted: true },
  { header: { id: 'session-cold-b', cwd: '/tmp/ws-b', createdAt: 222, version: 4, isSeeded: false }, live: false, persisted: true },
  { header: { id: 'session-child', cwd: '/tmp/ws-a', createdAt: 333, version: 4, isSeeded: false, origin: 'subagent', delegationDepth: 1 }, live: false, persisted: true },
]
const TITLES = { 'session-cold-a': '订单导出 · 流式改造', 'session-cold-b': 'B 工作区会话' }

async function setup(options: { titleError?: Error } = {}) {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const sessionQuery = createFakeSessionQuery(RECORDS, {
    titles: TITLES,
    ...(options.titleError !== undefined ? { titleError: options.titleError } : {}),
  })
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([
        { id: 'ws-a', name: 'A', path: '/tmp/ws-a', sessionIds: ['session-cold-a'] },
        { id: 'ws-b', name: 'B', path: '/tmp/ws-b', sessionIds: ['session-cold-b'] },
      ]),
      sessionQuery,
      // 真实 Host 的 sessions.get 对冷会话返回 undefined
      sessions: { get: async () => undefined, list: async () => [] },
    },
  })
  await apply(ctx)
  void storage
  return { webServer, controller }
}

test('sessions 路由：header 记录 + readTitleSnapshots 标题/createdAt/lastActiveAt、子会话过滤', async () => {
  const host = await setup()
  const response = await host.webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a')
  assert.equal(response.status, 200)
  const body = response.body as {
    sessions: Array<{ sessionId: string; title: string; createdAt: number; lastActiveAt: number; agentPreset?: string }>
    truncated: boolean
  }
  assert.deepEqual(body.sessions.map((session) => session.sessionId), ['session-cold-a'])
  const first = body.sessions[0]
  assert.equal(first?.title, '订单导出 · 流式改造') // 来自 readTitleSnapshots（冷会话有效）
  assert.equal(first?.createdAt, 111)
  assert.ok((first?.lastActiveAt ?? 0) >= 111)
  assert.equal(first?.agentPreset, 'standard')
  assert.equal(body.truncated, false)
})

test('bindSelect 冷会话可绑定（sessions.get undefined），workspace 从 cwd 推断', async () => {
  const host = await setup()
  const response = await host.webServer.invoke('POST', '/commander/binding', { mode: 'select', sessionId: 'session-cold-a', requestId: 'req_cold_bind_1' })
  assert.equal(response.status, 200)
  const body = response.body as { ok: boolean; binding: { sessionId: string; workspaceId: string; workspacePath: string } }
  assert.equal(body.ok, true)
  assert.equal(body.binding.sessionId, 'session-cold-a')
  assert.equal(body.binding.workspaceId, 'ws-a')
  assert.equal(body.binding.workspacePath, '/tmp/ws-a')
})

test('bindSelect 未知 id → not_found（消息含可用会话数）；workspace 不匹配 → conflict', async () => {
  const host = await setup()
  const unknown = await host.webServer.invoke('POST', '/commander/binding', { mode: 'select', sessionId: 'session-nope', requestId: 'req_cold_bind_2' })
  assert.equal(unknown.status, 404)
  const unknownBody = unknown.body as { code: string; message: string }
  assert.equal(unknownBody.code, 'not_found')
  assert.match(unknownBody.message, /可用会话 \d+ 个/)
  const mismatch = await host.webServer.invoke('POST', '/commander/binding', { mode: 'select', sessionId: 'session-cold-b', workspaceId: 'ws-a', requestId: 'req_cold_bind_3' })
  assert.equal(mismatch.status, 409)
  assert.equal((mismatch.body as { code: string }).code, 'workspace_conflict')
})

test('readTitleSnapshots 整批失败 → 标题降级为空，不阻塞列表与绑定', async () => {
  const host = await setup({ titleError: new Error('title fold failed') })
  const response = await host.webServer.invoke('GET', '/commander/sessions?workspaceId=ws-a')
  assert.equal(response.status, 200)
  const sessions = (response.body as { sessions: Array<{ sessionId: string; title: string }> }).sessions
  assert.deepEqual(sessions.map((session) => session.sessionId), ['session-cold-a'])
  assert.equal(sessions[0]?.title, '') // 降级
  const bound = await host.webServer.invoke('POST', '/commander/binding', { mode: 'select', sessionId: 'session-cold-a', requestId: 'req_cold_bind_4' })
  assert.equal(bound.status, 200)
})
