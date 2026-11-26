// 工作区摘要双写集成：设置页（PUT /commander/workspaces）与指挥官工具写同一个 WorkspaceRecord.summary。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import {
  createFakeCtx,
  createFakeSessionController,
  createFakeStorageDomain,
  createFakeTools,
  createFakeWebServer,
  createFakeWorkspaceRegistry,
  disposeAll,
} from '../fakes/fakes.ts'

const WORKSPACES = [
  { id: 'ws-a', name: 'Alpha', path: '/tmp/a' },
  { id: 'ws-b', name: 'Beta', path: '/tmp/b' },
]

type WorkspaceRecordLike = { summary?: string; summarySource?: string; allowed?: boolean; capabilityPolicy?: { mode?: string } }

const recordsOf = (storage: ReturnType<typeof createFakeStorageDomain>): Map<string, WorkspaceRecordLike> => {
  const medium = storage.mediums.get('commander')
  if (medium === undefined) throw new Error('domain not opened')
  const map = medium.get('workspaces')
  if (map === undefined) throw new Error('table workspaces missing')
  return map as Map<string, WorkspaceRecordLike>
}

async function setup() {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const toolsService = createFakeTools()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      tools: toolsService,
      workspaceRegistry: createFakeWorkspaceRegistry(WORKSPACES),
    },
  })
  await apply(ctx)
  const invoke = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => webServer.invoke(method, path, body, headers)
  const bound = await invoke('POST', '/commander/binding', { mode: 'new', workspaceId: 'ws-a', requestId: 'req_ws_summary_bind' })
  assert.equal(bound.status, 200)
  const commanderSessionId = controller.nextSessionId
  const definition = toolsService.registered
    .map((item) => item.definition as { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> })
    .find((item) => item.name === 'commander_workspace_update')
  assert.notEqual(definition, undefined)
  const exec = { agent: { id: commanderSessionId, session: { id: commanderSessionId } }, signal: { throwIfAborted: () => undefined } }
  return { ctx, storage, invoke, definition: definition as NonNullable<typeof definition>, exec }
}

const summaryOf = async (invoke: (method: string, path: string) => Promise<{ body: unknown }>, workspaceId: string): Promise<string | undefined> => {
  const state = await invoke('GET', '/commander/state')
  const workspaces = (state.body as { workspaces: Array<{ id: string; summary: string }> }).workspaces
  return workspaces.find((item) => item.id === workspaceId)?.summary
}

test('指挥官工具与设置页写同一个工作区摘要字段，最后一次写入生效', async () => {
  const { ctx, storage, invoke, definition, exec } = await setup()
  // 人类先保存一次：allowed=true + 初始摘要（源=manual）。
  const human = await invoke('PUT', '/commander/workspaces', {
    workspaces: [{ id: 'ws-a', allowed: true, summary: '人工初始摘要', policy: 'auto' }],
    requestId: 'req_ws_summary_human_1',
  })
  assert.equal(human.status, 200)
  assert.equal(await summaryOf(invoke, 'ws-a'), '人工初始摘要')
  assert.equal(recordsOf(storage).get('ws-a')?.summarySource, 'manual')

  // 指挥官工具改同一字段：内容一致、源=model、白名单/策略保留。
  const first = await definition.execute({ workspaceId: 'ws-a', summary: '指挥官维护：订单与结算' }, exec) as { summary: string; summarySource: string }
  assert.equal(first.summary, '指挥官维护：订单与结算')
  assert.equal(first.summarySource, 'model')
  assert.equal(await summaryOf(invoke, 'ws-a'), '指挥官维护：订单与结算')
  const afterTool = recordsOf(storage).get('ws-a')
  assert.equal(afterTool?.summarySource, 'model')
  assert.equal(afterTool?.allowed, true)
  assert.equal(afterTool?.capabilityPolicy?.mode, 'auto')

  // 人类再改：同一字段覆盖，源回到 manual。
  const humanAgain = await invoke('PUT', '/commander/workspaces', {
    workspaces: [{ id: 'ws-a', allowed: true, summary: '人工再改：电商后台', policy: 'auto' }],
    requestId: 'req_ws_summary_human_2',
  })
  assert.equal(humanAgain.status, 200)
  assert.equal(await summaryOf(invoke, 'ws-a'), '人工再改：电商后台')
  assert.equal(recordsOf(storage).get('ws-a')?.summarySource, 'manual')

  // 指挥官再改回：仍然可用。
  const second = await definition.execute({ workspaceId: 'Alpha', summary: '指挥官再改：订单系统' }, exec) as { summary: string }
  assert.equal(second.summary, '指挥官再改：订单系统')
  assert.equal(await summaryOf(invoke, 'ws-a'), '指挥官再改：订单系统')
  assert.equal(recordsOf(storage).get('ws-a')?.summarySource, 'model')
  disposeAll(ctx)
})

test('指挥官工具写摘要后向已连接的设置页广播整帧 snapshot', async () => {
  const { ctx, invoke, definition, exec } = await setup()
  const sse = await invoke('GET', '/commander/state', undefined, { accept: 'text/event-stream' })
  assert.match(sse.events[0] ?? '', /event: snapshot/)
  assert.doesNotMatch(sse.events[0] ?? '', /指挥官广播摘要/)
  await definition.execute({ workspaceId: 'ws-a', summary: '指挥官广播摘要' }, exec)
  const frames = sse.events.join('')
  assert.match(frames, /event: snapshot/)
  assert.match(frames, /"summary":"指挥官广播摘要"/)
  disposeAll(ctx)
})
