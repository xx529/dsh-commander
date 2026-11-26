// commander_workspace_update：指挥官维护工作区摘要（与设置页同一个 WorkspaceRecord.summary 字段）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createCommanderTools, hostModuleAnchors } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord, type WorkspaceRecord } from '../../src/host/schema.ts'
import {
  createFakeAgent,
  createFakeCtx,
  createFakeStorageDomain,
  createFakeTools,
  createFakeWorkspaceRegistry,
} from '../fakes/fakes.ts'

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

interface WorkspaceSeed {
  id: string
  name: string
  path: string
  allowed?: boolean
  summary?: string
  policy?: 'inherit' | 'auto'
  lastSelection?: NonNullable<WorkspaceRecord['capabilityPolicy']['lastSelection']>
  stored?: boolean
}

async function setup(options: { workspaces?: WorkspaceSeed[] } = {}) {
  const realTools = await tryLoadRealTools()
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander', workspaceId: 'ws-a' } }), 1)
  const seeds = options.workspaces ?? [
    { id: 'ws-a', name: 'Alpha', path: '/tmp/a', allowed: true, summary: '旧摘要' },
    { id: 'ws-b', name: 'Beta', path: '/tmp/b', allowed: false, summary: 'B 工作区' },
    { id: 'ws-c', name: 'Gamma', path: '/tmp/c', allowed: false, summary: '', stored: false },
  ]
  for (const seed of seeds) {
    if (seed.stored === false) continue
    await stores.workspaces.put({
      ...defaultWorkspaceRecord({ id: seed.id, name: seed.name, path: seed.path }),
      allowed: seed.allowed ?? false,
      summary: seed.summary ?? '',
      ...(seed.summary !== undefined && seed.summary !== '' ? { summarySource: 'manual' as const, summaryUpdatedAt: 900 } : {}),
      capabilityPolicy: {
        mode: seed.policy ?? 'inherit',
        ...(seed.lastSelection !== undefined ? { lastSelection: seed.lastSelection } : {}),
      },
    })
  }
  const toolsService = createFakeTools()
  const ctx = createFakeCtx({
    services: {
      tools: toolsService,
      workspaceRegistry: createFakeWorkspaceRegistry(seeds.map(({ id, name, path }) => ({ id, name, path }))),
    },
  })
  const changed: WorkspaceRecord[] = []
  const dispatchService = {
    dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }),
    currentPending: () => null,
    prune: () => 0,
    decisions: {} as never,
  }
  const tools = createCommanderTools({
    ctx: ctx as never,
    stores,
    dispatchService,
    commanderSessionId: () => 'session-commander',
    now: () => 1_000,
    onWorkspaceChanged: (record) => { changed.push(record) },
    ...(realTools !== null ? { defineToolLoader: async () => realTools.defineTool } : {}),
  })
  await tools.prepare()
  const specs = tools.specs()
  assert.notEqual(specs, null)
  const commanderExec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const workerExec = { agent: createFakeAgent({ sessionId: 'session-worker' }), signal: { throwIfAborted: () => undefined } }
  return { stores, tools, changed, specs: specs as Record<string, any>, commanderExec, workerExec, realTools }
}

const renderText = (spec: any, value: unknown): string =>
  (spec.output.render?.({}, value) ?? []).map((block: { text: string }) => block.text).join('\n')

const validate = (realTools: RealToolsModule | null, spec: any, value: unknown) => {
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, value, 'value')
}

test('commander_workspace_update 写入与设置页相同的 summary 字段并保留白名单/策略', async () => {
  const lastSelection = { status: 'applied' as const, enabled: ['a'], disabled: ['b'], at: 1 }
  const { stores, specs, commanderExec, changed, realTools } = await setup({
    workspaces: [{ id: 'ws-a', name: 'Alpha', path: '/tmp/a', allowed: true, summary: '旧摘要', policy: 'auto', lastSelection }],
  })
  const spec = specs.commander_workspace_update
  const result = await spec.execute({ workspaceId: 'alpha', summary: '  电商后台：订单、结算  ' }, commanderExec)
  assert.deepEqual(result, {
    workspaceId: 'ws-a',
    name: 'Alpha',
    summary: '电商后台：订单、结算',
    summarySource: 'model',
    summaryUpdatedAt: 1_000,
  })
  const record = stores.workspaces.get('ws-a')
  assert.equal(record?.summary, '电商后台：订单、结算')
  assert.equal(record?.summarySource, 'model')
  assert.equal(record?.summaryUpdatedAt, 1_000)
  assert.equal(record?.allowed, true, '白名单不能被摘要工具改掉')
  assert.equal(record?.capabilityPolicy.mode, 'auto', '能力策略不能被摘要工具改掉')
  assert.deepEqual(record?.capabilityPolicy.lastSelection, lastSelection)
  assert.equal(changed.length, 1)
  assert.equal(changed[0]?.summary, '电商后台：订单、结算')
  validate(realTools, spec, result)
  const text = renderText(spec, result)
  assert.match(text, /Workspace summary saved: ws-a \(Alpha\)/)
  assert.match(text, /summary\(10\/500\)/)
  assert.match(text, /source=model/)
})

test('commander_workspace_update 空串清空摘要并移除 updatedAt', async () => {
  const { stores, specs, commanderExec, realTools } = await setup({
    workspaces: [{ id: 'ws-a', name: 'Alpha', path: '/tmp/a', allowed: true, summary: '旧摘要' }],
  })
  const spec = specs.commander_workspace_update
  assert.equal(stores.workspaces.get('ws-a')?.summaryUpdatedAt, 900)
  const result = await spec.execute({ workspaceId: 'ws-a', summary: '   ' }, commanderExec)
  assert.equal(result.summary, '')
  assert.equal(result.summaryUpdatedAt, undefined)
  const record = stores.workspaces.get('ws-a')
  assert.equal(record?.summary, '')
  assert.equal(record?.summarySource, 'model')
  assert.equal('summaryUpdatedAt' in (record ?? {}), false)
  validate(realTools, spec, result)
})

test('commander_workspace_update 为 registry-only 工作区创建默认记录', async () => {
  const { stores, specs, commanderExec, realTools } = await setup({
    workspaces: [{ id: 'ws-c', name: 'Gamma', path: '/tmp/c', allowed: false, stored: false }],
  })
  assert.equal(stores.workspaces.get('ws-c'), undefined)
  const spec = specs.commander_workspace_update
  const result = await spec.execute({ workspaceId: '/tmp/c', summary: '新的工作区说明' }, commanderExec)
  assert.equal(result.workspaceId, 'ws-c')
  const record = stores.workspaces.get('ws-c')
  assert.equal(record?.summary, '新的工作区说明')
  assert.equal(record?.allowed, false)
  assert.equal(record?.capabilityPolicy.mode, 'inherit')
  validate(realTools, spec, result)
})

test('commander_workspace_update 拒绝未知/歧义工作区、超长摘要与未知参数', async () => {
  const { specs, commanderExec, workerExec, realTools } = await setup({
    workspaces: [
      { id: 'ws-a', name: 'Alpha', path: '/tmp/a', allowed: true, summary: 'A' },
      { id: 'ws-dup-1', name: 'Dup', path: '/tmp/dup1', allowed: true },
      { id: 'ws-dup-2', name: 'Dup', path: '/tmp/dup2', allowed: false },
    ],
  })
  const spec = specs.commander_workspace_update
  const unknown = await spec.execute({ workspaceId: 'nope', summary: 'x' }, commanderExec)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'unknown_workspace')
  assert.match(unknown.message, /ws-a/)
  validate(realTools, spec, unknown)

  const ambiguous = await spec.execute({ workspaceId: 'Dup', summary: 'x' }, commanderExec)
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'invalid_request')
  assert.match(ambiguous.message, /ws-dup-1, ws-dup-2/)

  const tooLong = await spec.execute({ workspaceId: 'ws-a', summary: 'x'.repeat(501) }, commanderExec)
  assert.equal(tooLong.code, 'invalid_request')
  assert.match(tooLong.message, /500/)

  const missingSummary = await spec.execute({ workspaceId: 'ws-a' }, commanderExec).catch((error: { code?: string }) => ({ ok: false, code: error.code ?? 'thrown', message: '' }))
  assert.equal(missingSummary.ok, false, '必填 summary 由工具参数 schema 或 execute 拒绝')

  const blankRef = await spec.execute({ workspaceId: '   ', summary: 'x' }, commanderExec)
  assert.equal(blankRef.code, 'invalid_request')

  const unknownParam = await spec.execute({ workspaceId: 'ws-a', summary: 'x', allowed: true }, commanderExec)
  assert.equal(unknownParam.code, 'invalid_request')
  assert.match(unknownParam.message, /allowed/)

  const scoped = await spec.execute({ workspaceId: 'ws-a', summary: 'x' }, workerExec)
  assert.equal(scoped.ok, false)
  assert.equal(scoped.code, 'forbidden_scope')

  const rendered = renderText(spec, unknown)
  assert.match(rendered, /^Rejected: unknown_workspace/)
})
