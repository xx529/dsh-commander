/**
 * Pure unit tests for the commander client state machine (SSE parsing, revision
 * ordering, message merging). Run with `node --test tests/client/*.test.ts`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MESSAGE_LIMIT, applyEvent, applySnapshot, compareMessages, createInitialState, createSSEParser,
  defaultJevConfig, mergeMessages, mergeUiConfig, newRequestId, normalizeContextPct, normalizeEntryPos, normalizeFailure,
  normalizeSessionList, normalizeSessions, normalizeStatus, normalizeTaskDetail, parseSSEBlock,
} from '../../src/client/state.ts'
import type { ChatMessage, CommanderMessage, CommanderSnapshot } from '../../src/client/types.ts'

function hostMessage(overrides: Partial<CommanderMessage> & { messageId: string }): CommanderMessage {
  return { role: 'assistant', text: '', at: 1_000, order: 1, ...overrides }
}

function chatRow(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'assistant', text: '', at: 1_000, order: 1, ...overrides }
}

function snapshot(overrides: Partial<CommanderSnapshot> = {}): CommanderSnapshot {
  return { rev: 1, ...overrides }
}

test('parseSSEBlock parses named events, ids and multi-line data', () => {
  const frame = parseSSEBlock('id: 42\nevent: commander.status\ndata: {"busy":\ndata: true}')
  assert.ok(frame)
  assert.equal(frame.event, 'commander.status')
  assert.equal(frame.id, '42')
  assert.equal(frame.data, '{"busy":\ntrue}')
})

test('parseSSEBlock ignores comments and data-less blocks', () => {
  assert.equal(parseSSEBlock(': keep-alive\nevent: heartbeat'), undefined)
  assert.equal(parseSSEBlock('event: heartbeat\ndata:'), undefined)
})

test('createSSEParser reassembles frames split across chunks', () => {
  const frames: string[] = []
  const push = createSSEParser(frame => frames.push(`${frame.event}:${frame.data}`))
  push('event: snapshot\ndata: {"rev":')
  push('3}\n\n')
  push('event: heartbeat\r\ndata: {"rev":4}\r\n\r\n')
  push('event: commander.message\ndata: {"messageId":"m1"}\n')
  push('\n')
  assert.deepEqual(frames, [
    'snapshot:{"rev":3}',
    'heartbeat:{"rev":4}',
    'commander.message:{"messageId":"m1"}',
  ])
})

test('applySnapshot is authoritative and normalizes rows', () => {
  const next = applySnapshot(createInitialState(), snapshot({
    rev: 7,
    commanderStatus: 'bound',
    binding: { sessionId: 'sess_1', workspaceId: 'ws_1' },
    panel: 'present',
    counts: { draft: 0, running: 2 },
    commanderBusy: true,
    commanderActivity: { text: '查看目录', at: 5 },
    messages: [
      hostMessage({ messageId: 'b', order: 2, text: 'second' }),
      hostMessage({ messageId: 'a', order: 1, text: 'first', role: 'user' }),
    ],
    workspaces: [
      { id: 'ws_b', name: 'Beta', allowed: true },
      { id: 'ws_a', name: 'Alpha', allowed: false, policy: 'auto' },
    ],
  }))
  assert.equal(next.rev, 7)
  assert.equal(next.commanderStatus, 'bound')
  assert.equal(next.panel, 'present')
  assert.equal(next.busy, true)
  assert.deepEqual(next.activity, { text: '查看目录', at: 5 })
  assert.deepEqual(next.messages.map(message => message.id), ['a', 'b'])
  assert.deepEqual(next.workspaces.map(row => row.id), ['ws_a', 'ws_b'])
  assert.equal(next.workspaces[0]?.allowed, false)
  assert.equal(next.workspaces[0]?.policy, 'auto')
})

test('applySnapshot never regresses rev and replaces messages', () => {
  const first = applySnapshot(createInitialState(), snapshot({
    rev: 9,
    messages: [hostMessage({ messageId: 'old', order: 1 })],
  }))
  const second = applySnapshot(first, snapshot({
    rev: 4,
    messages: [hostMessage({ messageId: 'new', order: 5 })],
  }))
  assert.equal(second.rev, 9)
  assert.deepEqual(second.messages.map(message => message.id), ['new'])
})

test('applyEvent drops frames older than the highest applied rev', () => {
  const state = applySnapshot(createInitialState(), snapshot({ rev: 10 }))
  const stale = applyEvent(state, {
    event: 'commander.message',
    data: JSON.stringify({ messageId: 'm_stale', role: 'assistant', text: 'old', at: 1, order: 2, rev: 3 }),
    id: '3',
  })
  assert.equal(stale, state)
  assert.deepEqual(stale.messages, [])
})

test('applyEvent appends and dedupes commander.message by messageId', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  state = applyEvent(state, {
    event: 'commander.message',
    data: JSON.stringify({ messageId: 'asst_1_2', role: 'assistant', text: 'v1', at: 2_000, order: 3, rev: 2 }),
    id: '2',
  })
  state = applyEvent(state, {
    event: 'commander.message',
    data: JSON.stringify({ messageId: 'req_1', role: 'user', text: 'hi', at: 1_000, order: 2, rev: 3 }),
    id: '3',
  })
  // A duplicate delivery of the same assistant event must not create a row.
  state = applyEvent(state, {
    event: 'commander.message',
    data: JSON.stringify({ messageId: 'asst_1_2', role: 'assistant', text: 'v1-final', at: 2_000, order: 3, rev: 4 }),
    id: '4',
  })
  assert.equal(state.messages.length, 2)
  assert.deepEqual(state.messages.map(message => message.id), ['req_1', 'asst_1_2'])
  assert.equal(state.messages[1]?.text, 'v1-final')
  assert.equal(state.rev, 4)
})

test('applyEvent applies commander.status and heartbeat without inventing rows', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  state = applyEvent(state, {
    event: 'commander.status',
    data: JSON.stringify({ busy: true, lastTurnId: 4, activity: { text: '查看目录', at: 1 }, rev: 2, at: 1 }),
    id: '2',
  })
  assert.equal(state.busy, true)
  assert.equal(state.lastTurnId, 4)
  assert.deepEqual(state.activity, { text: '查看目录', at: 1 })
  state = applyEvent(state, { event: 'heartbeat', data: JSON.stringify({ t: 1, rev: 5 }), id: '5' })
  assert.equal(state.rev, 5)
  assert.equal(state.messages.length, 0)
  state = applyEvent(state, {
    event: 'commander.status',
    data: JSON.stringify({ busy: false, lastTurnId: 4, activity: null, rev: 6, at: 2 }),
    id: '6',
  })
  assert.equal(state.busy, false)
  assert.equal(state.activity, null)
})

test('commander.status without activity preserves the last value (older Host)', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  state = applyEvent(state, {
    event: 'commander.status',
    data: JSON.stringify({ busy: true, lastTurnId: 4, activity: { text: '查看目录', at: 1 }, rev: 2 }),
    id: '2',
  })
  state = applyEvent(state, {
    event: 'commander.status',
    data: JSON.stringify({ busy: true, lastTurnId: 4, rev: 3 }),
    id: '3',
  })
  assert.deepEqual(state.activity, { text: '查看目录', at: 1 })
})

test('applyEvent updates binding and workspace counts', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  state = applyEvent(state, {
    event: 'binding.updated',
    data: JSON.stringify({ binding: { sessionId: 'sess_9', model: { model: 'deepseek-flash' } }, commanderStatus: 'bound', rev: 2 }),
    id: '2',
  })
  assert.equal(state.commanderStatus, 'bound')
  assert.equal(state.binding?.sessionId, 'sess_9')
  state = applyEvent(state, {
    event: 'tasks.changed',
    data: JSON.stringify({ counts: { running: 2, review: 1 }, rev: 3 }),
    id: '3',
  })
  assert.deepEqual(state.counts, { running: 2, review: 1 })
})

test('applyEvent ignores unknown events without advancing rev', () => {
  const state = applySnapshot(createInitialState(), snapshot({ rev: 8 }))
  const next = applyEvent(state, { event: 'private.event', data: JSON.stringify({ rev: 99, x: 1 }), id: '99' })
  assert.equal(next, state)
  assert.equal(next.rev, 8)
})

test('mergeMessages replaces by id, sorts by order, and caps the ring', () => {
  const rows: ChatMessage[] = []
  for (let index = 0; index < MESSAGE_LIMIT + 5; index += 1) {
    rows.push(chatRow({ id: `m${String(index)}`, order: index, text: String(index) }))
  }
  const merged = mergeMessages([], rows)
  assert.equal(merged.length, MESSAGE_LIMIT)
  assert.equal(merged[0]?.order, 5)
  assert.equal(merged[merged.length - 1]?.order, MESSAGE_LIMIT + 4)

  const replaced = mergeMessages([chatRow({ id: 'same', order: 2, text: 'old' })], [chatRow({ id: 'same', order: 2, text: 'new' })])
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0]?.text, 'new')
})

test('compareMessages orders by order then timestamp then id', () => {
  assert.ok(compareMessages(chatRow({ id: 'a', order: 1 }), chatRow({ id: 'b', order: 2 })) < 0)
  assert.ok(compareMessages(chatRow({ id: 'b', order: 1, at: 2_000 }), chatRow({ id: 'a', order: 1, at: 1_000 })) > 0)
  assert.ok(compareMessages(chatRow({ id: 'a', order: 1 }), chatRow({ id: 'b', order: 1 })) < 0)
})

test('newRequestId matches the contract charset and length', () => {
  const id = newRequestId('msg')
  assert.match(id, /^[A-Za-z0-9_-]{8,64}$/u)
  assert.ok(id.startsWith('req_msg_'))
  assert.notEqual(id, newRequestId('msg'))
})

test('normalizeStatus maps host strings onto the pill states', () => {
  assert.equal(normalizeStatus('bound', null), 'bound')
  assert.equal(normalizeStatus('unbound', null), 'unbound')
  assert.equal(normalizeStatus('broken', null), 'broken')
  assert.equal(normalizeStatus('rebound', null), 'bound')
  assert.equal(normalizeStatus(undefined, { sessionId: 'sess' }), 'bound')
  assert.equal(normalizeStatus(undefined, null), 'unbound')
  assert.equal(normalizeStatus('weird', null), 'unknown')
})

test('normalizeFailure keeps contract codes and fills messages', () => {
  const binding = normalizeFailure({ ok: false, code: 'binding_required' }, 409)
  assert.equal(binding.code, 'binding_required')
  assert.ok(binding.message.length > 0)
  const notFound = normalizeFailure(undefined, 404)
  assert.equal(notFound.code, 'not_found')
  const network = normalizeFailure({}, 0)
  assert.equal(network.code, 'network_error')
  const invalid = normalizeFailure({ code: 'invalid_request', field: 'text', retryable: false }, 400)
  assert.equal(invalid.field, 'text')
  assert.equal(invalid.retryable, false)
})

test('mergeUiConfig only accepts known enum values', () => {
  const merged = mergeUiConfig({ theme: 'follow', entryPosition: 'br' }, {
    commander: { model: { provider: 'p', model: 'm' } },
    jev: {},
    ui: { theme: 'dark', entryPosition: 'bl', entryEnabled: false, entryPos: { x: 0.2, y: 0.7 } },
  })
  assert.deepEqual(merged, {
    theme: 'dark', entryPosition: 'bl', entryEnabled: false, entryPos: { x: 0.2, y: 0.7 },
  })
  // 缺失字段回退当前值（entryEnabled 缺省视为开启）
  const guarded = mergeUiConfig({ theme: 'follow', entryPosition: 'br' }, { ui: { theme: 'bogus' as never } })
  assert.deepEqual(guarded, { theme: 'follow', entryPosition: 'br', entryEnabled: true, entryPos: null })
  // 非法 entryPos（越界/非数字）不覆盖当前值；null 表示回到默认角落
  const outOfRange = mergeUiConfig({ theme: 'follow', entryPos: { x: 0.1, y: 0.2 } }, { ui: { entryPos: { x: 9, y: -3 } } })
  assert.deepEqual(outOfRange.entryPos, { x: 1, y: 0 })
  assert.deepEqual(normalizeEntryPos({ x: 1.4, y: -0.2 }), { x: 1, y: 0 })
  assert.equal(normalizeEntryPos(null), null)
  assert.equal(normalizeEntryPos({ x: 'a' }), undefined)
})

test('dispatch.updated carries the full pending decision (M1)', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  const pendingDispatch = {
    decisionId: 'dec_1',
    taskId: 'task_1',
    taskTitle: '给订单导出加开关',
    candidates: [{ workspaceId: 'htdot', mode: 'new', pWorkspace: 0.62 }],
    recommendation: { workspaceId: 'htdot', mode: 'new' },
    scores: { pWorkspace: 0.62, pSession: 0.71, pMax: 0.62, concentration: 0.43 },
    reason: 'user_confirm_required',
    createdAt: 1_000,
    expiresAt: 1_000 + 1_800_000,
  }
  state = applyEvent(state, {
    event: 'dispatch.updated',
    data: JSON.stringify({ pendingDispatch, rev: 2, at: 1_000 }),
    id: '2',
  })
  assert.equal(state.pendingDispatch?.decisionId, 'dec_1')
  assert.equal(state.pendingDispatch?.taskTitle, '给订单导出加开关')
  assert.equal(state.pendingDispatch?.candidates?.length, 1)
  // Clearing the card arrives as pendingDispatch:null (m1 patch §3.1).
  state = applyEvent(state, {
    event: 'dispatch.updated',
    data: JSON.stringify({ pendingDispatch: null, rev: 3 }),
    id: '3',
  })
  assert.equal(state.pendingDispatch, null)
})

test('task.updated upserts and tasks.changed refreshes counts', () => {
  let state = applySnapshot(createInitialState(), snapshot({ rev: 1 }))
  state = applyEvent(state, {
    event: 'task.updated',
    data: JSON.stringify({ task: { id: 'task_1', title: '导出开关', status: 'queued', updatedAt: 10 }, rev: 2 }),
    id: '2',
  })
  state = applyEvent(state, {
    event: 'task.updated',
    data: JSON.stringify({ task: { id: 'task_2', title: '结算页', status: 'running', updatedAt: 20 }, rev: 3 }),
    id: '3',
  })
  assert.deepEqual(state.tasks.map(task => task.id), ['task_2', 'task_1'])
  assert.equal(state.tasks[1]?.status, 'queued')
  state = applyEvent(state, {
    event: 'task.updated',
    data: JSON.stringify({
      task: { id: 'task_1', title: '导出开关', status: 'running', updatedAt: 30, capability: { status: 'applied', enabledCount: 2, disabledCount: 5, durationMs: 120 } },
      rev: 4,
    }),
    id: '4',
  })
  assert.equal(state.tasks[0]?.id, 'task_1')
  assert.equal(state.tasks[0]?.capability?.status, 'applied')
  state = applyEvent(state, {
    event: 'tasks.changed',
    data: JSON.stringify({ counts: { running: 2, queued: 0 }, rev: 5 }),
    id: '5',
  })
  assert.deepEqual(state.counts, { running: 2, queued: 0 })
})

test('normalizeSessions tolerates contract/legacy field spellings', () => {
  const sessions = normalizeSessions({
    ok: true,
    sessions: [
      { sessionId: 'sess_a', title: '订单导出', lastActiveAt: 2_000, contextUsagePct: 62 },
      { id: 'sess_b', name: '结算页', updatedAt: 1_000, contextPct: 0.35 },
      { sessionId: 'sess_archived', title: '旧会话', archived: true },
      { title: 'no id row' },
      { sessionId: 'sess_tokens', title: 'token 水位', usedTokens: 50, contextWindowTokens: 200 },
    ],
  })
  assert.deepEqual(sessions.map(row => row.sessionId), ['sess_a', 'sess_b', 'sess_tokens'])
  assert.equal(sessions[0]?.title, '订单导出')
  assert.equal(sessions[0]?.contextPct, 62)
  assert.equal(sessions[1]?.contextPct, 35)
  assert.equal(sessions[2]?.contextPct, 25)
})

test('normalizeSessions reads the frozen contract fields (contextUsage/model/truncated)', () => {
  const sessions = normalizeSessions({
    sessions: [
      { id: 's1', title: '合同字段会话', lastActiveAt: 3_000, contextUsage: 42, model: 'deepseek-flash', truncated: true },
      { id: 's2', title: '嵌套水位', contextUsage: { usedTokens: 30, contextWindowTokens: 120 } },
    ],
    truncated: true,
    rev: 9,
  })
  assert.deepEqual(sessions.map(row => row.sessionId), ['s1', 's2'])
  assert.equal(sessions[0]?.contextPct, 42)
  assert.equal(sessions[0]?.model, 'deepseek-flash')
  assert.equal(sessions[0]?.truncated, true)
  assert.equal(sessions[1]?.contextPct, 25)
})

test('normalizeSessionList keeps the payload-level truncated flag', () => {
  const result = normalizeSessionList({
    ok: true,
    workspaceId: 'ws_1',
    sessions: [{ sessionId: 's1', title: 't', lastActiveAt: 2, contextUsage: 0.78 }],
    truncated: true,
    rev: 58,
  })
  assert.equal(result.sessions.length, 1)
  assert.equal(result.sessions[0]?.contextPct, 78)
  assert.equal(result.truncated, true)
  assert.equal(normalizeSessionList({ sessions: [] }).truncated, undefined)
})

test('normalizeSessions accepts a bare array and rejects garbage', () => {
  assert.equal(normalizeSessions([{ sessionId: 's1', title: 't' }]).length, 1)
  assert.deepEqual(normalizeSessions(null), [])
  assert.deepEqual(normalizeSessions({ sessions: 'nope' }), [])
  assert.equal(normalizeContextPct(undefined), undefined)
  assert.equal(normalizeContextPct(-1), undefined)
  assert.equal(normalizeContextPct(0.5), 50)
  assert.equal(normalizeContextPct(150), 100)
})

test('normalizeTaskDetail defaults optional sections safely', () => {
  const detail = normalizeTaskDetail({
    ok: true,
    rev: 52,
    task: { id: 'task_1', title: '导出开关', status: 'running' },
    acceptance: [{ id: 'acc_1', text: '一键导出', verify: '手动' }],
    capabilities: { status: 'applied', enabled: ['a'], disabled: [] },
    dispatch: { id: 'dec_1', outcome: 'confirmed', finalTarget: { workspaceId: 'htdot', mode: 'new' } },
    timeline: [{ at: 1, type: 'dispatch', text: '派发' }],
    sessions: [{ sessionId: 'sess_1', role: 'work', status: 'queued' }],
    reportSummary: { text: '本轮完成导出修复', at: 3 },
    reportMaterials: [{ id: 'mat_1', kind: 'file', title: 'report.md', path: '/tmp/report.md', source: 'presented', state: 'ok' }],
  })
  assert.equal(detail.task?.id, 'task_1')
  assert.equal(detail.acceptance?.length, 1)
  assert.deepEqual(detail.reportSummary, { text: '本轮完成导出修复', at: 3 })
  assert.equal(detail.reportMaterials?.length, 1)
  assert.equal(detail.reportMaterials?.[0]?.title, 'report.md')
  assert.equal(detail.capabilities?.status, 'applied')
  assert.equal(detail.dispatch?.finalTarget?.mode, 'new')
  assert.equal(detail.timeline?.length, 1)
  assert.equal(detail.sessions?.length, 1)
  assert.equal(detail.rev, 52)
  const empty = normalizeTaskDetail(undefined)
  assert.deepEqual(empty.acceptance, [])
  assert.deepEqual(empty.reportMaterials, [])
  assert.equal(empty.capabilities, null)
  assert.equal(empty.dispatch, null)
  assert.equal(empty.task, undefined)
})

test('defaultJevConfig matches the M0/M1 contract defaults', () => {
  assert.deepEqual(defaultJevConfig(), {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    workspaceThreshold: 0.8,
    sessionThreshold: 0.8,
    timeoutMs: 1500,
    autoDispatch: false,
  })
})

test('normalizeSessions tolerates a missing title/createdAt (task-66)', () => {
  const sessions = normalizeSessions({
    sessions: [
      { id: 'session-unnamed-4ac7fcd', lastActiveAt: 0, createdAt: 1_700_000_000_000 },
      { id: 'session-named', title: '有标题', created_at: 1_700_000_100_000, contextUsage: 0.42 },
    ],
  })
  assert.equal(sessions[0]?.title, '')
  assert.equal(sessions[0]?.lastActiveAt, 0)
  assert.equal(sessions[0]?.createdAt, 1_700_000_000_000)
  assert.equal(sessions[1]?.title, '有标题')
  assert.equal(sessions[1]?.createdAt, 1_700_000_100_000)
  assert.equal(sessions[1]?.contextPct, 42)
})
