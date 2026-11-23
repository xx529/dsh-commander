// M1+ tools 归属集成：apply() 在**插件上下文**全局注册 8 个工具（插件面板按包识别来源），
// 并用 `when` 条件把可见性/可调用性限定到当前指挥官会话（替代旧的按 agent 安装 + restrict + 重试时序）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../../src/host/index.ts'
import { createFakeCtx, createFakeSessionController, createFakeStorageDomain, createFakeTools, createFakeWebServer, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'

type WhenFn = (context: { agent?: unknown }) => boolean

async function setup(options: { withTools?: boolean } = {}) {
  const storage = createFakeStorageDomain()
  const webServer = createFakeWebServer()
  const controller = createFakeSessionController()
  const toolsService = createFakeTools()
  const ctx = createFakeCtx({
    services: {
      storageDomain: storage,
      webServer,
      sessionController: controller,
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: [] }]),
      agents: { list: () => [] },
      ...(options.withTools === false ? {} : { tools: toolsService }),
    },
  })
  await apply(ctx)
  return { ctx, webServer, controller, toolsService }
}

test('apply 在插件上下文全局注册 8 个工具（来源=插件，不再注册到 agent scope）', async () => {
  const { toolsService } = await setup()
  assert.deepEqual(toolsService.registered.map((item) => (item.definition as { name: string }).name).sort(), ['commander_session_list', 'commander_task_create', 'commander_task_dispatch', 'commander_task_get', 'commander_task_list', 'commander_task_report', 'commander_task_update', 'commander_workspace_list'])
  // 每个都带 when 条件：全局可见但按 step 的 agent 放行
  for (const item of toolsService.registered) assert.equal(typeof item.options?.when, 'function')
})

test('when 只放行当前指挥官会话（绑定后动态生效）', async () => {
  const { webServer, controller, toolsService } = await setup()
  const when = toolsService.registered[0]?.options?.when as WhenFn
  assert.equal(when({ agent: { id: controller.nextSessionId } }), false, '未绑定时任何人都不放行')
  const bound = await webServer.invoke('POST', '/commander/binding', { mode: 'new', cwd: '/tmp/scope-workspace', requestId: 'req_scope_bind_1' })
  assert.equal(bound.status, 200)
  assert.equal(when({ agent: { id: controller.nextSessionId } }), true)
  assert.equal(when({ agent: { session: { id: controller.nextSessionId } } }), true)
  assert.equal(when({ agent: { id: 'session-worker' } }), false)
})

test('tools 服务缺失时不阻塞插件装配（降级为无工具）', async () => {
  const { webServer } = await setup({ withTools: false })
  const health = await webServer.invoke('GET', '/commander/health')
  assert.equal(health.status, 200)
})
