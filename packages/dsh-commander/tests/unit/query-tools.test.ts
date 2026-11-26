// 三个只读查询工具（task-query-design §6–§10）：execute 结果、render、schema、作用域。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createCommanderTools, hostModuleAnchors } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { defaultWorkspaceRecord } from '../../src/host/schema.ts'
import {
  createFakeAgent,
  createFakeCtx,
  createFakeSessionQuery,
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

interface SetupOptions {
  workspaces?: Array<{ id: string; name: string; path: string; allowed?: boolean; summary?: string; sessionIds?: string[] }>
  sessions?: Array<Record<string, unknown>>
  titles?: Record<string, string>
  archivedSessionIds?: string[]
  pending?: Record<string, unknown> | null
  tasks?: Array<Record<string, unknown>>
}

async function setup(options: SetupOptions = {}) {
  const realTools = await tryLoadRealTools()
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  await stores.config.update((current) => ({ ...current, commander: { ...current.commander, sessionId: 'session-commander', workspaceId: 'ws-a' } }), 1)
  const workspaces = options.workspaces ?? [
    { id: 'ws-a', name: 'Alpha', path: '/tmp/a', allowed: true, summary: 'A 工作区', sessionIds: ['s-root', 's-child', 's-teammate', 's-archived'] },
    { id: 'ws-b', name: 'Beta', path: '/tmp/b', allowed: false, summary: 'B 工作区' },
  ]
  await stores.workspaces.replaceAll(workspaces.map((workspace) => ({
    ...defaultWorkspaceRecord({ id: workspace.id, name: workspace.name, path: workspace.path }),
    allowed: workspace.allowed ?? true,
    summary: workspace.summary ?? '',
  })))
  for (const task of options.tasks ?? []) await stores.tasks.put(task as never)
  const toolsService = createFakeTools()
  const ctx = createFakeCtx({
    services: {
      tools: toolsService,
      workspaceRegistry: createFakeWorkspaceRegistry(workspaces.map(({ sessionIds, ...workspace }) => ({ ...workspace, ...(sessionIds !== undefined ? { sessionIds } : {}) })), { archivedSessionIds: options.archivedSessionIds ?? [] }),
      sessionQuery: createFakeSessionQuery(options.sessions ?? [], options.titles !== undefined ? { titles: options.titles } : {}),
    },
  })
  const dispatchService = {
    dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }),
    currentPending: () => options.pending ?? null,
    prune: () => 0,
    decisions: {} as never,
  }
  const tools = createCommanderTools({
    ctx: ctx as never,
    stores,
    dispatchService,
    commanderSessionId: () => 'session-commander',
    now: () => new Date(2026, 10, 23, 21, 34).getTime(),
    ...(realTools !== null ? { defineToolLoader: async () => realTools.defineTool } : {}),
  })
  await tools.prepare()
  const specs = tools.specs()
  assert.notEqual(specs, null)
  const commanderExec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  const workerExec = { agent: createFakeAgent({ sessionId: 'session-worker' }), signal: { throwIfAborted: () => undefined } }
  return { stores, tools, specs: specs as Record<string, any>, commanderExec, workerExec, realTools }
}

const renderText = (spec: any, value: unknown): string =>
  (spec.output.render?.({}, value) ?? []).map((block: { text: string }) => block.text).join('\n')

function makeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: 'task_1',
    title: '任务一',
    goal: '目标',
    status: 'draft',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastActivityAt: 1_000,
    ...overrides,
  }
}

test('commander_workspace_list exposes only enabled workspaces', async (t) => {
  const { specs, commanderExec, realTools } = await setup()
  const spec = specs.commander_workspace_list
  const result = await spec.execute({}, commanderExec)
  assert.equal(result.total, 1)
  assert.deepEqual(result.workspaces.map((item: { id: string }) => item.id), ['ws-a'])
  assert.equal(result.workspaces[0].allowed, undefined)
  assert.equal(result.workspaces[0].summary, 'A 工作区')
  assert.equal(result.workspaces[0].sessionCount, 4)
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, result, 'value')
  else t.diagnostic('real dsh-tools unavailable; schema shape asserted by compile-time type only')
  const text = renderText(spec, result)
  assert.match(text, /Workspaces: total=1/)
  assert.match(text, /"id":"ws-a"/)
  assert.doesNotMatch(text, /ws-b/)
  assert.doesNotMatch(text, /"allowed"/)
})

test('commander_workspace_list reports an empty enabled set without failing', async (t) => {
  const { specs, commanderExec, realTools } = await setup({ workspaces: [{ id: 'ws-b', name: 'Beta', path: '/tmp/b', allowed: false }] })
  const spec = specs.commander_workspace_list
  const result = await spec.execute({}, commanderExec)
  assert.equal(result.total, 0)
  assert.deepEqual(result.workspaces, [])
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, result, 'value')
  const text = renderText(spec, result)
  assert.match(text, /设置页/)
})

test('commander_task_list hides recycle bin by default and exposes pagination + counts', async (t) => {
  const tasks = [
    makeTask({ id: 'draft-1', createdAt: 1_000 }),
    // 长静默 running（lastActivityAt 远早于 now）：2026-11-24 前会被派生为 stale=true。
    makeTask({ id: 'running-1', status: 'running', createdAt: 2_000, lastActivityAt: 1_000 }),
    makeTask({ id: 'review-1', status: 'review', createdAt: 3_000 }),
    makeTask({ id: 'archived-1', status: 'archived', createdAt: 9_000 }),
  ]
  const { specs, commanderExec, realTools } = await setup({ tasks })
  const spec = specs.commander_task_list
  const result = await spec.execute({}, commanderExec)
  assert.equal(result.total, 3)
  assert.equal(result.counts.archived ?? 0, 0)
  assert.equal(result.columns.proposed, 1)
  assert.equal(result.columns.running, 1)
  assert.equal(result.columns.review, 1)
  assert.equal(result.returned, 3)
  assert.equal(result.hasMore, false)
  assert.ok(!('nextOffset' in result))
  assert.equal(result.now, '2026-11-23 21:34')
  assert.deepEqual(result.tasks.map((task: { id: string }) => task.id), ['review-1', 'running-1', 'draft-1'])
  assert.equal(result.tasks[0].workspaceName, 'Alpha')
  assert.equal(result.tasks[0].column, 'review')
  // 任务行不再含 stale 字段（长静默 running 也不显示标记）。
  assert.ok(result.tasks.every((row: Record<string, unknown>) => !('stale' in row)))
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, result, 'value')
  else t.diagnostic('real dsh-tools unavailable; schema shape asserted by compile-time type only')
  const text = renderText(spec, result)
  assert.match(text, /Board: total=3/)
  assert.match(text, /nextOffset=null/)
  assert.match(text, /tasks: \[/)
  assert.match(text, /"id":"review-1"/)
  assert.doesNotMatch(text, /"stale"/)
})

test('commander_task_list includeArchived adds trash to scope, counts and columns', async (t) => {
  const tasks = [
    makeTask({ id: 'draft-1' }),
    makeTask({ id: 'archived-1', status: 'archived', createdAt: 9_000 }),
  ]
  const { specs, commanderExec, realTools } = await setup({ tasks })
  const spec = specs.commander_task_list
  const result = await spec.execute({ includeArchived: true }, commanderExec)
  assert.equal(result.total, 2)
  assert.equal(result.counts.archived, 1)
  assert.equal(result.columns.trash, 1)
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, result, 'value')
})

test('commander_task_list filters by time, title text and reports pending dispatch', async (t) => {
  const tasks = [
    makeTask({ id: 'old', title: '登录修复', createdAt: new Date(2026, 9, 1).getTime() }),
    makeTask({ id: 'new', title: '登录超时', createdAt: new Date(2026, 9, 12, 14, 40).getTime() }),
    makeTask({ id: 'goal-hit', title: '别的', goal: '登录 相关', createdAt: new Date(2026, 9, 12, 15, 0).getTime() }),
  ]
  const { specs, commanderExec, realTools } = await setup({ tasks, pending: { taskId: 'old', expiresAt: 123 } })
  const spec = specs.commander_task_list
  const result = await spec.execute({ since: '2026-10-12', until: '2026-10-12', q: '登录' }, commanderExec)
  assert.equal(result.total, 1)
  assert.deepEqual(result.tasks.map((task: { id: string }) => task.id), ['new'])
  assert.deepEqual(result.pendingDispatch, { taskId: 'old', expiresAt: 123 })
  const widened = await spec.execute({ since: '2026-10-12', until: '2026-10-12', q: '登录', searchIn: ['title', 'goal'] }, commanderExec)
  assert.deepEqual(widened.tasks.map((task: { id: string }) => task.id), ['goal-hit', 'new'])
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, result, 'value')
  const text = renderText(spec, result)
  assert.match(text, /pending: \{"taskId":"old"/)
})

test('commander_task_list rejects legacy workspace shape and invalid filters', async () => {
  const { specs, commanderExec } = await setup()
  const spec = specs.commander_task_list
  const unknown = await spec.execute({ sort: 'updated_desc' }, commanderExec)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'invalid_request')
  const badTime = await spec.execute({ since: '14:40' }, commanderExec)
  assert.equal(badTime.code, 'invalid_request')
  assert.match(badTime.message, /2026-10-12 14:40/)
})

test('commander_session_list requires a workspace and only returns root sessions', async (t) => {
  const sessions = [
    { header: { id: 's-root', cwd: '/tmp/a', createdAt: 1_000 }, live: false, persisted: true },
    { header: { id: 's-child', cwd: '/tmp/a/sub', createdAt: 2_000, origin: 'subagent', delegationDepth: 1 }, live: true, persisted: true },
    { header: { id: 's-teammate', cwd: '/tmp/a', createdAt: 3_000, parentSession: { id: 's-root' } }, live: false, persisted: true },
    { header: { id: 's-archived', cwd: '/tmp/a', createdAt: 4_000 }, live: false, persisted: true },
    { header: { id: 'session-commander', cwd: '/tmp/a', createdAt: 5_000 }, live: true, persisted: true },
  ]
  const { specs, commanderExec, realTools } = await setup({
    sessions,
    titles: { 's-root': '根会话', 's-child': '子会话', 's-teammate': '队友会话', 's-archived': '归档会话', 'session-commander': '指挥官' },
    archivedSessionIds: ['s-archived'],
  })
  const spec = specs.commander_session_list
  // workspaceId 在 schema 层 required：真实 defineTool 直接抛 ToolArgsError；无真实宿主时由 execute 返回 invalid_request。
  let missing: { ok: boolean; code?: string; message?: string }
  try {
    missing = (await spec.execute({}, commanderExec)) as { ok: boolean; code?: string; message?: string }
  } catch (error) {
    missing = { ok: false, code: 'invalid_request', message: String((error as Error)?.message ?? error) }
  }
  assert.equal(missing.ok, false)
  assert.match(String(missing.message), /workspaceId/)
  const unknown = await spec.execute({ workspaceId: 'ws-b' }, commanderExec)
  assert.equal(unknown.code, 'unknown_workspace')
  const byCwd = await spec.execute({ workspaceId: '/tmp/a/sub/deeper' }, commanderExec)
  assert.equal(byCwd.total, 1)
  assert.deepEqual(byCwd.sessions.map((session: { sessionId: string }) => session.sessionId), ['s-root'])
  assert.equal(byCwd.sessions[0].title, '根会话')
  assert.equal(byCwd.workspace.id, 'ws-a')
  if (realTools !== null) realTools.validateJsonSchemaValue(spec.output.schema, byCwd, 'value')
  const withArchived = await spec.execute({ workspaceId: 'Alpha', includeArchived: true }, commanderExec)
  assert.deepEqual(withArchived.sessions.map((session: { sessionId: string }) => session.sessionId).sort(), ['s-archived', 's-root'])
  const text = renderText(spec, byCwd)
  assert.match(text, /workspace=ws-a\(Alpha\)/)
  assert.match(text, /"sessionId":"s-root"/)
  assert.doesNotMatch(text, /s-teammate|s-child|session-commander/)
})

test('read tools enforce commander scope', async () => {
  const { specs, workerExec } = await setup()
  for (const name of ['commander_task_list', 'commander_workspace_list', 'commander_session_list']) {
    const result = await specs[name].execute({ workspaceId: 'ws-a' }, workerExec)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'forbidden_scope')
  }
})
