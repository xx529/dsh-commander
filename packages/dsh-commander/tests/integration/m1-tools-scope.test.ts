// M1+ tools 归属集成：apply() 在**插件上下文**全局注册 9 个工具（插件面板按包识别来源），
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

test('apply 在插件上下文全局注册 10 个工具（来源=插件，不再注册到 agent scope）', async () => {
  const { toolsService } = await setup()
  assert.deepEqual(toolsService.registered.map((item) => (item.definition as { name: string }).name).sort(), ['commander_session_list', 'commander_task_accept', 'commander_task_create', 'commander_task_dispatch', 'commander_task_get', 'commander_task_list', 'commander_task_report', 'commander_task_update', 'commander_workspace_list', 'commander_workspace_update'])
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

// 回归：归属信号来自 cordis 的 `internal/get`，只有**属性访问**服务才会发（reader=访问方）。
// 若用 ctx.get('tools') 的裸实例注册，插件面板只能回退到「最近读 tools 的 fiber」，
// 而 agent 作用域 fiber 名是 `scope`（@deepseek-ai/dsh-scope createScope），工具被标成 scope。
test('注册经 inject 的 scoped tools 访问器（保住插件归属，不落裸实例）', async () => {
  const raw = createFakeTools()
  const traced = createFakeTools()
  const injectCalls: string[][] = []
  const ctx = createFakeCtx({
    services: {
      storageDomain: createFakeStorageDomain(),
      webServer: createFakeWebServer(),
      sessionController: createFakeSessionController(),
      workspaceRegistry: createFakeWorkspaceRegistry([{ id: 'ws-a', name: 'A', path: '/tmp/a', sessionIds: [] }]),
      agents: { list: () => [] },
      tools: raw,
    },
    inject(names, callback) {
      injectCalls.push([...names])
      // 真宿主里 `scoped.tools` 的属性访问才触发 internal/get；fake 用独立实例代表 traced 视图。
      if (names.includes('tools')) callback(Object.assign(createFakeCtx({ services: { tools: traced } }), { tools: traced }))
      return () => undefined
    },
  })
  await apply(ctx)
  assert.ok(injectCalls.some((names) => names.includes('tools')), '应先等 tools 就绪，再经 inject 回调注册')
  assert.equal(traced.registered.length, 10, '10 个工具都必须注册在带身份的 scoped 访问器上')
  assert.equal(raw.registered.length, 0, 'ctx.get 的裸实例不得注册（否则插件面板认不出来源）')
})

test('tools 服务缺失时不阻塞插件装配（降级为无工具）', async () => {
  const { webServer } = await setup({ withTools: false })
  const health = await webServer.invoke('GET', '/commander/health')
  assert.equal(health.status, 200)
})
