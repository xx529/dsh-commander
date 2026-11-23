// 任务查询（task-query-design §3/§5/§6）：过滤语义、计数、分页、参数校验。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskRow, parseTaskQueryArgs, queryTasks } from '../../src/host/query/tasks.ts'

const localMs = (y: number, m: number, d: number, h = 0, mi = 0): number => new Date(y, m - 1, d, h, mi).getTime()

function makeTask(overrides: Record<string, unknown> = {}): Record<string, any> {
  const id = (overrides.id as string | undefined) ?? 'task_1'
  return {
    v: 1,
    id,
    title: '默认标题',
    goal: '默认目标',
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

const lookupFor = (tasks: Array<Record<string, any>>) => (id: string) => tasks.find((task) => task.id === id)

function parse(args: Record<string, unknown>) {
  const parsed = parseTaskQueryArgs(args)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message)
  return parsed.ok ? parsed.filter : (undefined as never)
}

function parseError(args: Record<string, unknown>): string {
  const parsed = parseTaskQueryArgs(args)
  assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(args)}`)
  return parsed.ok ? '' : parsed.message
}

test('default scope hides recycle bin and counts keys follow scope', () => {
  const tasks = [
    makeTask({ id: 'draft', createdAt: 3_000 }),
    makeTask({ id: 'archived', status: 'archived', createdAt: 5_000 }),
    makeTask({ id: 'cancelled', status: 'cancelled', createdAt: 4_000 }),
    makeTask({ id: 'review', status: 'review', createdAt: 2_000 }),
  ]
  const result = queryTasks({ tasks, filter: parse({}), lookup: lookupFor(tasks) })
  assert.equal(result.total, 2)
  assert.deepEqual(result.tasks.map((task) => task.id), ['draft', 'review'])
  assert.deepEqual(Object.keys(result.counts).sort(), ['blocked', 'done', 'draft', 'proposed', 'queued', 'review', 'running'])
  assert.equal(result.counts.draft, 1)
  assert.equal(result.counts.review, 1)
  assert.equal(result.counts.archived ?? 0, 0)
  assert.deepEqual(Object.keys(result.columns).sort(), ['blocked', 'done', 'proposed', 'queued', 'review', 'running'])
  assert.equal(result.columns.proposed, 1)
  assert.equal(result.columns.review, 1)
})

test('includeArchived widens scope to all nine statuses', () => {
  const tasks = [
    makeTask({ id: 'draft' }),
    makeTask({ id: 'archived', status: 'archived' }),
    makeTask({ id: 'cancelled', status: 'cancelled' }),
  ]
  const result = queryTasks({ tasks, filter: parse({ includeArchived: true }), lookup: lookupFor(tasks) })
  assert.equal(result.total, 3)
  assert.equal(result.counts.archived, 1)
  assert.equal(result.counts.cancelled, 1)
  assert.equal(result.columns.trash, 2)
  assert.deepEqual(Object.keys(result.counts).sort(), ['archived', 'blocked', 'cancelled', 'done', 'draft', 'proposed', 'queued', 'review', 'running'])
})

test('explicit statuses override includeArchived', () => {
  const tasks = [makeTask({ id: 'draft' }), makeTask({ id: 'archived', status: 'archived' })]
  const result = queryTasks({ tasks, filter: parse({ statuses: ['archived'] }), lookup: lookupFor(tasks) })
  assert.equal(result.total, 1)
  assert.equal(result.tasks[0]?.id, 'archived')
  assert.deepEqual(Object.keys(result.counts), ['archived'])
  assert.deepEqual(Object.keys(result.columns), ['trash'])
})

test('empty statuses array is treated as omitted', () => {
  const tasks = [makeTask({ id: 'draft' }), makeTask({ id: 'archived', status: 'archived' })]
  const result = queryTasks({ tasks, filter: parse({ statuses: [] }), lookup: lookupFor(tasks) })
  assert.equal(result.total, 1)
})

test('time window is half-open on the selected field', () => {
  const start = localMs(2026, 10, 12)
  const end = localMs(2026, 10, 13)
  const tasks = [
    makeTask({ id: 'before', createdAt: start - 1 }),
    makeTask({ id: 'at-start', createdAt: start }),
    makeTask({ id: 'last-ms', createdAt: end - 1 }),
    makeTask({ id: 'at-end', createdAt: end }),
  ]
  const result = queryTasks({ tasks, filter: parse({ since: '2026-10-12', until: '2026-10-12' }), lookup: lookupFor(tasks) })
  assert.deepEqual(result.tasks.map((task) => task.id), ['last-ms', 'at-start'])
})

test('timeField selects created/updated/activity', () => {
  const tasks = [
    makeTask({ id: 'old-created', createdAt: 1_000, updatedAt: localMs(2026, 10, 12, 10) }),
    makeTask({ id: 'new-created', createdAt: localMs(2026, 10, 12, 11), updatedAt: 1_000 }),
  ]
  const byUpdated = queryTasks({ tasks, filter: parse({ since: '2026-10-12', timeField: 'updated' }), lookup: lookupFor(tasks) })
  assert.deepEqual(byUpdated.tasks.map((task) => task.id), ['old-created'])
  const byCreated = queryTasks({ tasks, filter: parse({ since: '2026-10-12', timeField: 'created' }), lookup: lookupFor(tasks) })
  assert.deepEqual(byCreated.tasks.map((task) => task.id), ['new-created'])
})

test('q searches title by default; searchIn opens goal/reportSummary; tokens are AND', () => {
  const tasks = [
    makeTask({ id: 'title', title: '修复 登录 超时' }),
    makeTask({ id: 'goal', title: '别的', goal: '登录 会话 丢失' }),
    makeTask({ id: 'report', title: '第三个', reportSummary: { text: '登录已修复', at: 1 } }),
    makeTask({ id: 'case', title: 'Login redirect loop' }),
  ]
  const titleOnly = queryTasks({ tasks, filter: parse({ q: '登录' }), lookup: lookupFor(tasks) })
  assert.deepEqual(titleOnly.tasks.map((task) => task.id), ['title'])
  const withGoal = queryTasks({ tasks, filter: parse({ q: '登录', searchIn: ['title', 'goal'] }), lookup: lookupFor(tasks) })
  assert.deepEqual(withGoal.tasks.map((task) => task.id).sort(), ['goal', 'title'])
  const withReport = queryTasks({ tasks, filter: parse({ q: '登录', searchIn: ['reportSummary'] }), lookup: lookupFor(tasks) })
  assert.deepEqual(withReport.tasks.map((task) => task.id), ['report'])
  const andTokens = queryTasks({ tasks, filter: parse({ q: '登录 超时' }), lookup: lookupFor(tasks) })
  assert.deepEqual(andTokens.tasks.map((task) => task.id), ['title'])
  const caseFold = queryTasks({ tasks, filter: parse({ q: 'LOGIN' }), lookup: lookupFor(tasks) })
  assert.deepEqual(caseFold.tasks.map((task) => task.id), ['case'])
})

test('sort is createdAt desc with id tie-break; pagination exposes total/hasMore/nextOffset', () => {
  const tasks = [
    makeTask({ id: 'b', createdAt: 2_000 }),
    makeTask({ id: 'a', createdAt: 2_000 }),
    makeTask({ id: 'c', createdAt: 3_000 }),
    makeTask({ id: 'd', createdAt: 1_000 }),
  ]
  const first = queryTasks({ tasks, filter: parse({ limit: 2, offset: 0 }), lookup: lookupFor(tasks) })
  assert.deepEqual(first.tasks.map((task) => task.id), ['c', 'a'])
  assert.equal(first.total, 4)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextOffset, 2)
  const second = queryTasks({ tasks, filter: parse({ limit: 2, offset: 2 }), lookup: lookupFor(tasks) })
  assert.deepEqual(second.tasks.map((task) => task.id), ['b', 'd'])
  assert.equal(second.hasMore, false)
  assert.equal(second.nextOffset, undefined)
})

test('dispatchable mirrors the dispatch guard (draft/proposed/review + dependencies met)', () => {
  const tasks = [
    makeTask({ id: 'dep', status: 'done' }),
    makeTask({ id: 'ready-review', status: 'review', dependsOn: ['dep'] }),
    makeTask({ id: 'blocked', status: 'blocked' }),
    makeTask({ id: 'waiting', status: 'draft', dependsOn: ['dep', 'missing'], createdAt: 9_000 }),
  ]
  const lookup = lookupFor(tasks)
  const rows = queryTasks({ tasks, filter: parse({}), lookup }).tasks
  const byId = new Map(rows.map((task) => [task.id, buildTaskRow({ task, now: 10_000, lookup, workspaceNameById: new Map() })]))
  assert.equal(byId.get('ready-review')?.dispatchable, true)
  assert.equal(byId.get('blocked')?.dispatchable, false)
  assert.equal(byId.get('waiting')?.dispatchable, false)
})

test('rejects unknown fields, invalid enums and out-of-range pagination', () => {
  assert.match(parseError({ sort: 'updated_desc' }), /sort|未知/)
  assert.match(parseError({ statuses: ['nope'] }), /status/)
  assert.match(parseError({ statuses: 'draft' }), /status/)
  assert.match(parseError({ searchIn: ['nope'] }), /searchIn/)
  assert.match(parseError({ timeField: 'nope' }), /timeField/)
  assert.match(parseError({ limit: 0 }), /limit/)
  assert.match(parseError({ limit: 101 }), /limit/)
  assert.match(parseError({ offset: -1 }), /offset/)
  assert.match(parseError({ offset: 10_001 }), /offset/)
  assert.match(parseError({ q: 'a b c d e f g h i' }), /token/)
  assert.match(parseError({ since: '2026-10-12', until: '2026-10-01' }), /since|until|早于|晚于/)
})

test('defaults are limit=20 offset=0', () => {
  assert.equal(parse({}).limit, 20)
  assert.equal(parse({}).offset, 0)
  assert.deepEqual(parse({}).searchIn, ['title'])
  assert.equal(parse({}).timeField, 'created')
})
