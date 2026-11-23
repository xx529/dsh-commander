import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommanderTools, hostModuleAnchors } from '../../src/host/tools/index.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createStores } from '../../src/host/store/index.ts'
import { createFakeAgent, createFakeCtx, createFakeStorageDomain, createFakeTools, createFakeWorkspaceRegistry } from '../fakes/fakes.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'

async function setup() {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander', workspaceId: 'ws' } }), 1)
  const dispatchService = { dispatchTask: async () => ({ status: 'needs_confirmation' as const, taskId: 't', decisionId: 'd', candidates: [], recommendation: { workspaceId: 'ws', mode: 'new' as const }, scores: { pWorkspace: 0, pSession: 0, pMax: 0, concentration: 0 }, reason: 'user_confirm_required' as const, expiresAt: 1 }), currentPending: () => null, prune: () => 0, decisions: {} as never }
  const toolsService = createFakeTools()
  const ctx = { get: (name: string) => (name === 'tools' ? toolsService : undefined) }
  const tools = createCommanderTools({ ctx: ctx as never, stores, dispatchService, commanderSessionId: () => 'session-commander', now: () => 1000 })
  await tools.prepare()
  return { stores, tools, toolsService }
}

type WhenFn = (context: { agent?: unknown }) => boolean

test('install registers eight global tools; when() admits only the commander session', async () => {
  const { tools, toolsService } = await setup()
  assert.equal(tools.install(), true)
  assert.deepEqual(toolsService.registered.map((item) => (item.definition as { name: string }).name).sort(), ['commander_session_list', 'commander_task_create', 'commander_task_dispatch', 'commander_task_get', 'commander_task_list', 'commander_task_report', 'commander_task_update', 'commander_workspace_list'])
  const when = toolsService.registered[0]?.options?.when as WhenFn | undefined
  assert.equal(typeof when, 'function')
  // 全局注册（归属=插件），但只有当前指挥官会话的 step 能看到/调用
  assert.equal(when?.({ agent: { id: 'session-commander' } }), true) // root agent 只有 id
  assert.equal(when?.({ agent: { session: { id: 'session-commander' } } }), true)
  assert.equal(when?.({ agent: { id: 'session-worker' } }), false)
  assert.equal(when?.({ agent: undefined }), false)
  tools.dispose()
  assert.equal(toolsService.registered.length, 0, 'dispose 应注销全部注册')
})

test('tools execute enforces commander scope and creates task drafts', async () => {
  const { stores, tools } = await setup()
  const specs = tools.specs()
  const commanderExec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const created = (await (specs.commander_task_create as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ title: 'T', goal: 'G', workspaceId: 'ws-a' }, commanderExec)) as { taskId: string; status: string }
  assert.equal(created.status, 'draft')
  assert.equal(stores.tasks.get(created.taskId)?.title, 'T')
  assert.equal(stores.tasks.get(created.taskId)?.workspaceId, 'ws-a')
  const workerExec = { agent: createFakeAgent({ sessionId: 'session-worker' }), signal: { throwIfAborted: () => undefined } }
  const denied = (await (specs.commander_task_create as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ title: 'T', goal: 'G' }, workerExec)) as { ok: boolean; code: string }
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'forbidden_scope')
  const missing = (await (specs.commander_task_update as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ taskId: 'nope', expectedRevision: 1, action: 'edit' }, commanderExec)) as { ok: boolean; code: string }
  assert.equal(missing.code, 'unknown_task')
  tools.dispose()
})


/** 真实宿主 defineTool 契约测试：解析 CLI 安装里的 @deepseek-ai/dsh-tools（解析不到则 skip，不掩盖本地开发）。 */
interface RealToolsModule {
  defineTool: (spec: unknown) => unknown
  validateJsonSchemaValue: (schema: unknown, value: unknown, path?: string) => unknown
}

async function tryLoadRealTools(): Promise<RealToolsModule | null> {
  const anchors: string[] = hostModuleAnchors()
  try {
    const which = execSync('which dsh', { encoding: 'utf8' }).trim()
    if (which !== '') anchors.push(realpathSync(which))
  } catch {
    /* no dsh on PATH */
  }
  for (const anchor of anchors) {
    try {
      const requireFunction = createRequire(anchor)
      const entry = requireFunction.resolve('@deepseek-ai/dsh-tools')
      const mod = (await import(pathToFileURL(entry).href)) as { defineTool?: unknown; validateJsonSchemaValue?: unknown }
      if (typeof mod.defineTool === 'function' && typeof mod.validateJsonSchemaValue === 'function') {
        return { defineTool: mod.defineTool as RealToolsModule['defineTool'], validateJsonSchemaValue: mod.validateJsonSchemaValue as RealToolsModule['validateJsonSchemaValue'] }
      }
    } catch {
      continue
    }
  }
  return null
}

test('commander_task_update rejects raw status and requires action + expectedRevision', async () => {
  const { stores, tools } = await setup()
  const specs = tools.specs()
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const base = {
    v: 1 as const, id: 'task_review_gate', title: 'T', goal: 'G', status: 'running' as const, workspaceId: 'ws-a', priority: 'normal' as const,
    commandId: '', assignments: [], acceptance: [], timeline: [{ at: 1, type: 'created' as const, text: 'created' }], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  }
  await stores.tasks.put(base)
  const rawStatus = (await (specs.commander_task_update as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ taskId: base.id, expectedRevision: 1, action: 'edit', status: 'review' }, exec)) as { code: string; message: string }
  assert.equal(rawStatus.code, 'invalid_request')
  assert.match(rawStatus.message, /status/)
  const stale = (await (specs.commander_task_update as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ taskId: base.id, expectedRevision: 99, action: 'edit', title: 'x' }, exec)) as { code: string }
  assert.equal(stale.code, 'task_stale_revision')
  assert.equal(stores.tasks.get(base.id)?.title, 'T')
  assert.equal(stores.tasks.get(base.id)?.status, 'running')
  tools.dispose()
})

test('commander_task_update recover is blocked-only (review/running are domain actions)', async () => {
  const { stores, tools } = await setup()
  const specs = tools.specs()
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const base = {
    v: 1 as const, id: 'task_review_to_running', title: 'T', goal: 'G', status: 'review' as const, workspaceId: 'ws-a', priority: 'normal' as const,
    commandId: '', assignments: [], acceptance: [{ id: 'acc_1', text: 'A', source: 'commander' as const, state: 'evidence_present' as const }],
    timeline: [{ at: 1, type: 'created' as const, text: 'created' }], version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
  }
  await stores.tasks.put(base)
  const rejected = (await (specs.commander_task_update as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute({ taskId: base.id, expectedRevision: 1, action: 'recover', recoverTo: 'running' }, exec)) as { code: string }
  assert.equal(rejected.code, 'invalid_status')
  assert.equal(stores.tasks.get(base.id)?.status, 'review')
  tools.dispose()
})

test('real @deepseek-ai/dsh-tools defineTool accepts all six specs (output.render contract)', async (t) => {
  const realTools = await tryLoadRealTools()
  if (realTools === null) {
    t.skip('real @deepseek-ai/dsh-tools not resolvable in this environment; integration Host test covers registration')
    return
  }
  const { stores } = await setup()
  const toolsService = createFakeTools()
  const tools = createCommanderTools({
    ctx: { get: (name: string) => (name === 'tools' ? toolsService : undefined) } as never,
    stores,
    dispatchService: { dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }), currentPending: () => null, prune: () => 0, decisions: {} as never },
    commanderSessionId: () => 'session-commander',
    now: () => 1000,
    defineToolLoader: async () => realTools.defineTool,
  })
  await tools.prepare()
  const specs = tools.specs()
  assert.notEqual(specs, null)
  for (const name of ['commander_task_create', 'commander_task_update', 'commander_task_dispatch', 'commander_task_list', 'commander_task_report'] as const) {
    const spec = specs?.[name] as { name: string; output?: { schema?: unknown; render?: unknown } }
    assert.equal(spec.name, name)
    assert.equal(typeof spec.output?.render, 'function', `${name} must expose output.render for real defineTool`)
    assert.equal(typeof spec.output?.schema, 'object')
  }
  // 真实 defineTool 对五个 spec 都不抛（这一步就是本机真实契约验证）
  assert.equal(tools.install(), true)
  tools.dispose()
})


test('root-style agent (only agent.id, no agent.session) is recognized as commander (tester M1 e2e root cause)', async () => {
  const { tools, toolsService } = await setup()
  assert.equal(tools.install(), true)
  const when = toolsService.registered[0]?.options?.when as WhenFn | undefined
  assert.equal(when?.({ agent: { id: 'session-commander' } }), true)
  tools.dispose()
})

test('all tool registrations failing returns false and emits diagnostic (no silent success)', async () => {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  const diagnostics: string[] = []
  const brokenTools = {
    register: () => {
      throw new Error('tools service not ready')
    },
  }
  const tools = createCommanderTools({
    ctx: { get: (name: string) => (name === 'tools' ? brokenTools : undefined) } as never,
    stores,
    dispatchService: { dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }), currentPending: () => null, prune: () => 0, decisions: {} as never },
    commanderSessionId: () => 'session-commander',
    now: () => 1000,
    onDiagnostic: (message) => diagnostics.push(message),
  })
  await tools.prepare()
  assert.equal(tools.install(), false)
  assert.ok(diagnostics.some((message) => message.includes('registration failed')))
  assert.ok(diagnostics.some((message) => message.includes('no commander tool could be registered')))
  tools.dispose()
})

test('install without a tools service degrades with a diagnostic (plugin still loads)', async () => {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  const diagnostics: string[] = []
  const tools = createCommanderTools({
    ctx: { get: () => undefined } as never,
    stores,
    dispatchService: { dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }), currentPending: () => null, prune: () => 0, decisions: {} as never },
    commanderSessionId: () => 'session-commander',
    now: () => 1000,
    onDiagnostic: (message) => diagnostics.push(message),
  })
  await tools.prepare()
  assert.equal(tools.install(), false)
  assert.ok(diagnostics.some((message) => message.includes('tools service is unavailable')))
  tools.dispose()
})


test('commander_task_dispatch output schema accepts every DispatchTaskResult variant (real DSH validator)', async (t) => {
  const realTools = await tryLoadRealTools()
  if (realTools === null) {
    t.skip('real @deepseek-ai/dsh-tools not resolvable; e2e Host round is the contract test')
    return
  }
  const { stores } = await setup()
  let nextResult: unknown = { status: 'needs_confirmation' }
  const dispatchService = {
    dispatchTask: async () => nextResult,
    currentPending: () => null,
    prune: () => 0,
    decisions: {} as never,
  }
  const tools = createCommanderTools({
    ctx: { get: () => undefined } as never,
    stores,
    dispatchService: dispatchService as never,
    commanderSessionId: () => 'session-commander',
    now: () => 1000,
    defineToolLoader: async () => realTools.defineTool,
  })
  await tools.prepare()
  const specs = tools.specs()
  assert.notEqual(specs, null)
  const dispatchSpec = specs?.commander_task_dispatch as { output: { schema: unknown }; execute: (args: unknown, exec: unknown) => Promise<unknown> }
  const commanderExec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const candidate = { workspaceId: 'ws-a', workspaceName: 'A', workspacePath: '/tmp/a', mode: 'new', pWorkspace: 0.9, pSession: 0.8, score: 0.72 }
  const variants: unknown[] = [
    { status: 'rejected', code: 'decision_expired', message: 'expired' },
    {
      status: 'needs_confirmation',
      taskId: 'task_1',
      decisionId: 'dec_1',
      candidates: [candidate],
      recommendation: { workspaceId: 'ws-a', mode: 'new' },
      scores: { pWorkspace: 0.9, pSession: 0.8, pMax: 0.8, concentration: 0.7 },
      reason: 'user_confirm_required',
      expiresAt: 2000,
    },
    {
      status: 'dispatched',
      taskId: 'task_1',
      decisionId: 'dec_1',
      sessionId: 'session-work-1',
      sessionCreated: true,
      target: { workspaceId: 'ws-a', mode: 'new', sessionId: 'session-work-1' },
      scores: { pWorkspace: 0.9, pSession: 0.8, pMax: 0.8, concentration: 0.7 },
      capabilities: { status: 'fallback', enabled: [], disabled: [] },
    },
    { ok: false, code: 'forbidden_scope', message: 'only the commander session may use this tool' },
  ]
  for (const variant of variants) {
    // 工具 execute 原样返回 service 结果 → 用真实 validator 校验（等价 DSH 运行时工具输出校验）
    nextResult = variant
    const returned = await dispatchSpec.execute({ taskId: 'task_1', requestId: 'req_schema_1' }, commanderExec)
    realTools.validateJsonSchemaValue(dispatchSpec.output.schema, returned, 'value')
  }
  // 说明：DSH validator 对 property-level required 的缺失字段校验较宽松；此处契约重点是「三种真实返回都不被拒」。
  tools.dispose()
})
