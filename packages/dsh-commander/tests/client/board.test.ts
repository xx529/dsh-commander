/**
 * Pure unit tests for the M2 board helpers (column mapping, legal drag
 * transitions, PATCH payloads) per
 * docs/architecture/m2m3-contract-patch.md §2.2–§2.5.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOARD_COLUMNS, BOARD_PRIORITIES, TASK_STAGES, acceptanceSummary, boardColumnOf, buildBoardPatch, buildTaskFeed, buildTaskRounds,
  canArchiveTask, canCancelTask, canRestoreTask, formatBoardTime, formatClockTime, formatDayLabel, groupBoardTasks,
  hasPendingDispatch, newBoardRequestId, newEditId, priorityLabelKey, sameLocalDay, shouldCollapseSummary,
  sortColumnTasks, statusLabelKey, taskStage, taskStageBlocked, taskTerminal, trashTasks, waitingFor,
  DEFAULT_BOARD_COLUMN_FR, archiveCount, archiveMonthBounds, archiveMonthKey, dependencyClosure, dependencyEdgePath, dependencyHighlightChain,
  downstreamCounts, groupArchiveByMonthDay, normalizeBoardColumnFr, resizeBoardColumnFr,
} from '../../src/client/board.ts'
import type { TaskDetailView, TaskSessionLinkView, TaskView } from '../../src/client/types.ts'

function task(overrides: Partial<TaskView> & { id: string }): TaskView {
  return { status: 'draft', updatedAt: 1_000, ...overrides }
}

test('six columns map the frozen statuses and trash is separate', () => {
  assert.deepEqual(BOARD_COLUMNS.map(column => column.id), ['proposed', 'queued', 'running', 'blocked', 'review', 'done'])
  assert.equal(boardColumnOf('draft'), 'proposed')
  assert.equal(boardColumnOf('proposed'), 'proposed')
  assert.equal(boardColumnOf('queued'), 'queued')
  assert.equal(boardColumnOf('running'), 'running')
  assert.equal(boardColumnOf('blocked'), 'blocked')
  assert.equal(boardColumnOf('review'), 'review')
  assert.equal(boardColumnOf('done'), 'done')
  assert.equal(boardColumnOf('archived'), 'trash')
  assert.equal(boardColumnOf('cancelled'), 'trash')
  assert.equal(boardColumnOf('weird'), 'unknown')
  assert.equal(boardColumnOf(undefined), 'unknown')
})

test('cancel is available for non-terminal tasks only; dependency badges derive from Host fields', () => {
  for (const status of ['draft', 'proposed', 'queued', 'running', 'blocked', 'review']) {
    assert.equal(canCancelTask(task({ id: 't', status })), true)
  }
  for (const status of ['done', 'cancelled', 'archived']) {
    assert.equal(canCancelTask(task({ id: 't', status })), false)
  }
  assert.deepEqual(waitingFor(task({ id: 't', waitingFor: ['a', 'b'] })), ['a', 'b'])
  assert.equal(hasPendingDispatch(task({ id: 't', pendingDispatch: true })), true)
  assert.equal(hasPendingDispatch(task({ id: 't' }), ['t']), true)
  assert.equal(hasPendingDispatch(task({ id: 't' }), ['other']), false)
})

test('groupBoardTasks sorts each column by the frozen rule', () => {
  const grouped = groupBoardTasks([
    task({ id: 'p1', status: 'proposed', updatedAt: 5 }),
    task({ id: 'p2', status: 'proposed', updatedAt: 9 }),
    task({ id: 'p3', status: 'draft', updatedAt: 1 }),
    task({ id: 'q1', status: 'queued', lastActivityAt: 20 }),
    task({ id: 'r1', status: 'running', lastActivityAt: 30 }),
    task({ id: 'r2', status: 'running', lastActivityAt: 10 }),
    task({ id: 'b1', status: 'blocked', block: { since: 4 } }),
    task({ id: 'b2', status: 'blocked', block: { since: 8 } }),
    task({ id: 'v1', status: 'review', updatedAt: 3 }),
    task({ id: 'd1', status: 'done', updatedAt: 2 }),
    task({ id: 'tr1', status: 'archived' }),
  ], ['p1'])
  // A proposed task with a pending dispatch is pinned to the top.
  assert.deepEqual(grouped.proposed.map(row => row.id), ['p1', 'p2', 'p3'])
  assert.deepEqual(grouped.queued.map(row => row.id), ['q1'])
  assert.deepEqual(grouped.running.map(row => row.id), ['r1', 'r2'])
  assert.deepEqual(grouped.blocked.map(row => row.id), ['b2', 'b1'])
  assert.deepEqual(grouped.review.map(row => row.id), ['v1'])
  assert.deepEqual(grouped.done.map(row => row.id), ['d1'])
})

test('trash listing keeps archived/cancelled sorted by updatedAt', () => {
  const rows = trashTasks([
    task({ id: 'a', status: 'archived', updatedAt: 1 }),
    task({ id: 'c', status: 'cancelled', updatedAt: 3 }),
    task({ id: 'x', status: 'running', updatedAt: 9 }),
  ])
  assert.deepEqual(rows.map(row => row.id), ['c', 'a'])
  assert.equal(canArchiveTask(task({ id: 't', status: 'review' })), true)
  assert.equal(canArchiveTask(task({ id: 't', status: 'done' })), true)
  assert.equal(canArchiveTask(task({ id: 't', status: 'running' })), false)
  assert.equal(canRestoreTask(task({ id: 't', status: 'archived' })), true)
  assert.equal(canRestoreTask(task({ id: 't', status: 'cancelled' })), false)
})

test('buildBoardPatch only emits metadata fields (never status)', () => {
  const patch = buildBoardPatch('priority', 'high', { editId: 'edit_abc', requestId: 'req_abc' })
  assert.deepEqual(patch, { field: 'priority', value: 'high', editId: 'edit_abc', requestId: 'req_abc' })
  const minted = buildBoardPatch('priority', 'high')
  assert.match(minted.editId, /^edit_[0-9a-f]{32}$/u)
  assert.match(minted.requestId, /^req_board_[0-9a-f]{16}$/u)
  assert.match(newEditId(), /^edit_[0-9a-f]{32}$/u)
  assert.match(newBoardRequestId(), /^[A-Za-z0-9_-]{8,64}$/u)
})

test('label helpers and priorities cover the contract enums', () => {
  assert.deepEqual([...BOARD_PRIORITIES], ['low', 'normal', 'high', 'urgent'])
  assert.equal(priorityLabelKey('urgent'), 'board.priority.urgent')
  assert.equal(priorityLabelKey('bogus'), 'board.priority.normal')
  assert.equal(statusLabelKey('running'), 'task.status.running')
  assert.equal(statusLabelKey(undefined), 'task.status.other')
  assert.equal(formatBoardTime(0), '')
  assert.ok(formatBoardTime(1_700_000_000_000).length > 0)
})

test('sortColumnTasks is stable for review/done by updatedAt desc', () => {
  const sorted = sortColumnTasks('review', [
    task({ id: 'r1', status: 'review', updatedAt: 2 }),
    task({ id: 'r2', status: 'review', updatedAt: 8 }),
  ])
  assert.deepEqual(sorted.map(row => row.id), ['r2', 'r1'])
})

// ---------------------------------------------------------------------------
// Detail drawer feed (scheme D) — chronology, payload attachment, fallbacks
// ---------------------------------------------------------------------------

function detail(overrides: Partial<TaskDetailView> = {}): TaskDetailView {
  return { task: task({ id: 't1', title: '任务', status: 'review', updatedAt: 90_000 }), ...overrides }
}

function session(overrides: Partial<TaskSessionLinkView> & { sessionId: string }): TaskSessionLinkView {
  return { status: 'idle', role: 'work', workspaceName: 'Research', sessionTitle: '调研', ...overrides }
}

test('taskStage maps the frozen status machine onto the five drawer steps', () => {
  assert.deepEqual([...TASK_STAGES], ['proposed', 'queued', 'running', 'review', 'done'])
  for (const status of ['draft', 'proposed', 'weird', undefined]) assert.equal(taskStage(status), 'proposed')
  assert.equal(taskStage('queued'), 'queued')
  assert.equal(taskStage('running'), 'running')
  assert.equal(taskStage('blocked'), 'running')
  assert.equal(taskStageBlocked('blocked'), true)
  assert.equal(taskStageBlocked('running'), false)
  assert.equal(taskStage('review'), 'review')
  for (const status of ['done', 'cancelled', 'archived']) assert.equal(taskStage(status), 'done')
  assert.equal(taskTerminal('cancelled'), true)
  assert.equal(taskTerminal('archived'), true)
  assert.equal(taskTerminal('done'), false)
})

test('acceptanceSummary counts evidence_present rows only', () => {
  assert.deepEqual(acceptanceSummary(undefined), { total: 0, evidence: 0, insufficient: 0 })
  const summary = acceptanceSummary([
    { text: 'a', state: 'evidence_present' },
    { text: 'b', state: 'evidence_present' },
    { text: 'c', state: 'insufficient' },
  ])
  assert.deepEqual(summary, { total: 3, evidence: 2, insufficient: 1 })
})

test('shouldCollapseSummary only folds long conclusions (140-char fallback)', () => {
  assert.equal(shouldCollapseSummary(undefined), false)
  assert.equal(shouldCollapseSummary(''), false)
  assert.equal(shouldCollapseSummary('短结论'), false)
  assert.equal(shouldCollapseSummary('x'.repeat(140)), false)
  assert.equal(shouldCollapseSummary('x'.repeat(141)), true)
  assert.equal(shouldCollapseSummary(`  ${'x'.repeat(141)}  `), true)
})

test('feed keeps the timeline ascending and attaches dispatch, report, sessions by their rows', () => {
  const feed = buildTaskFeed(task({ id: 't1', status: 'review', primarySessionId: 's_1' }), detail({
    timeline: [
      { at: 10, type: 'created', text: '创建' },
      { at: 20, type: 'dispatch', text: '派发', sessionId: 's_1' },
      { at: 30, type: 'report', text: '整理报告' },
      { at: 40, type: 'status', text: '待验收' },
    ],
    dispatch: { id: 'dec_1', outcome: 'confirmed', createdAt: 15, finalTarget: { workspaceId: 'w1', mode: 'new' } },
    acceptance: [{ text: '验收', state: 'evidence_present' }],
    sessions: [session({ sessionId: 's_1', status: 'running' })],
  }))
  assert.deepEqual(feed.map(event => event.kind), ['created', 'dispatch', 'report', 'status'])
  assert.equal(feed[1]?.dispatch?.id, 'dec_1')
  assert.equal(feed[1]?.sessions?.[0]?.sessionId, 's_1')
  assert.equal(feed[2]?.acceptance?.[0]?.text, '验收')
  assert.equal(feed[3]?.acceptance, undefined)
  assert.ok(feed.every(event => event.at !== undefined))
})

test('feed attaches the commander_task_report summary to the same row as acceptance', () => {
  const feed = buildTaskFeed(task({ id: 't1', status: 'review' }), detail({
    timeline: [
      { at: 10, type: 'created', text: '创建' },
      { at: 30, type: 'report', text: '整理报告' },
    ],
    acceptance: [{ text: '验收', state: 'evidence_present' }],
    reportSummary: { text: '本轮完成导出修复，测试通过。', at: 30 },
  }))
  assert.equal(feed[1]?.kind, 'report')
  assert.equal(feed[1]?.summary, '本轮完成导出修复，测试通过。')
  assert.equal(feed[1]?.acceptance?.[0]?.text, '验收')
  assert.equal(feed[0]?.summary, undefined)
})

test('feed keeps a summary-only report (blocked/no_progress) as its own report row and ignores empty text', () => {
  const withSummary = buildTaskFeed(task({ id: 't1', status: 'blocked' }), detail({
    timeline: [{ at: 10, type: 'created', text: '创建' }],
    reportSummary: { text: '等待外部依赖解除', at: 20 },
  }))
  assert.deepEqual(withSummary.map(event => event.kind), ['created', 'report'])
  assert.equal(withSummary[1]?.summary, '等待外部依赖解除')
  const empty = buildTaskFeed(task({ id: 't1', status: 'blocked' }), detail({
    timeline: [{ at: 10, type: 'created', text: '创建' }],
    reportSummary: { text: '' },
  }))
  assert.deepEqual(empty.map(event => event.kind), ['created'])
})

test('feed attaches the latest dispatch record to the last dispatch row', () => {
  const feed = buildTaskFeed(task({ id: 't1' }), detail({
    timeline: [
      { at: 10, type: 'dispatch', text: '派发尝试' },
      { at: 20, type: 'dispatch', text: '派发', sessionId: 's_1' },
    ],
    dispatch: { id: 'dec_2', outcome: 'auto' },
    sessions: [session({ sessionId: 's_1' })],
  }))
  assert.equal(feed[0]?.dispatch, undefined)
  assert.equal(feed[1]?.dispatch?.id, 'dec_2')
  assert.equal(feed[1]?.sessions?.length, 1)
})

test('feed falls back to the end for acceptance and for an orphan dispatch record', () => {
  const feed = buildTaskFeed(task({ id: 't1', primarySessionId: 's_9' }), detail({
    timeline: [{ at: 10, type: 'created', text: '创建' }],
    dispatch: { id: 'dec_legacy', outcome: 'overridden', createdAt: 25 },
    acceptance: [{ text: '旧数据验收', state: 'insufficient' }],
    sessions: [session({ sessionId: 's_9' })],
  }))
  assert.deepEqual(feed.map(event => event.kind), ['created', 'dispatch', 'acceptance'])
  assert.equal(feed[1]?.at, 25)
  assert.equal(feed[1]?.dispatch?.id, 'dec_legacy')
  assert.equal(feed[1]?.sessions?.[0]?.sessionId, 's_9')
  assert.equal(feed[2]?.acceptance?.[0]?.text, '旧数据验收')
})

test('feed keeps unused sessions as one trailing block and leaves timed rows sorted', () => {
  const feed = buildTaskFeed(task({ id: 't1' }), detail({
    timeline: [
      { at: 20, type: 'status', text: '状态' },
      { at: 10, type: 'created', text: '创建' },
    ],
    sessions: [session({ sessionId: 's_2', sessionTitle: '另一个会话' })],
  }))
  assert.deepEqual(feed.map(event => event.kind), ['created', 'status', 'sessions'])
  assert.equal(feed[2]?.at, undefined)
  assert.equal(feed[2]?.sessions?.[0]?.sessionId, 's_2')
})

test('board edits merge into the matching user_edit row or become their own event', () => {
  const feed = buildTaskFeed(task({ id: 't1' }), detail({
    timeline: [
      { at: 10, type: 'user_edit', text: '用户改板：status review → blocked' },
      { at: 30, type: 'created', text: '创建' },
    ],
    boardEdits: [
      { editId: 'edit_a', field: 'status', before: 'review', after: 'blocked', at: 10 },
      { editId: 'edit_b', field: 'priority', before: 'normal', after: 'high', at: 20 },
    ],
  }))
  const merged = feed.find(event => event.kind === 'user_edit' && event.at === 10)
  assert.equal(merged?.edit?.editId, 'edit_a')
  const synthetic = feed.find(event => event.kind === 'user_edit' && event.at === 20)
  assert.equal(synthetic?.edit?.editId, 'edit_b')
  assert.equal(feed[0]?.at, 10)
  assert.equal(feed[1]?.at, 20)
})

test('feed does not invent timestamps and keeps untimed blocks after timed rows', () => {
  const feed = buildTaskFeed(task({ id: 't1' }), detail({
    timeline: [{ at: 5, type: 'created', text: '创建' }],
    acceptance: [{ text: '验收', state: 'evidence_present' }],
  }))
  assert.equal(feed.at(-1)?.kind, 'acceptance')
  assert.equal(feed.at(-1)?.at, undefined)
  assert.equal(feed[0]?.at, 5)
})

test('clock/day helpers produce stable display strings', () => {
  const at = new Date(2026, 10, 18, 18, 31, 0, 0).getTime()
  assert.equal(formatClockTime(at), '18:31')
  assert.equal(formatClockTime(undefined), '')
  assert.equal(formatClockTime(0), '')
  assert.equal(sameLocalDay(at, at + 60_000), true)
  assert.equal(sameLocalDay(at, at + 24 * 60 * 60 * 1_000), false)
  assert.ok(formatDayLabel(at).length > 0)
})

test('feed drops internal needs_confirmation dispatch rows', () => {
  const feed = buildTaskFeed(task({ id: 't1' }), detail({
    timeline: [
      { at: 10, type: 'created', text: '创建' },
      { at: 20, type: 'dispatch', text: 'needs_confirmation dec_1（候选 2，reason=user_confirm_required）' },
      { at: 30, type: 'dispatch', text: '派发到 ws_1（new）· confirmed', sessionId: 's_1' },
    ],
    dispatch: { id: 'dec_1', outcome: 'confirmed' },
  }))
  assert.deepEqual(feed.map(event => event.kind), ['created', 'dispatch'])
  assert.equal(feed[1]?.at, 30)
  assert.equal(feed[1]?.dispatch?.id, 'dec_1')
})

test('buildTaskRounds folds dispatches/history/sessions into per-round sections', () => {
  const view = task({ id: 'task_rounds', status: 'review', round: 2, workspaceId: 'ws_2', workspaceIds: ['ws_1', 'ws_2'], primarySessionId: 's2' })
  const detail: TaskDetailView = {
    task: view,
    acceptance: [{ id: 'acc2', text: '第二轮验收', state: 'evidence_present' }],
    acceptanceHistory: [{
      round: 1, at: 15, items: [{ id: 'acc1', text: '第一轮验收', state: 'evidence_present' }], reportSummary: { text: '第一轮结论', at: 14, round: 1 },
      materials: [{ id: 'mat1', kind: 'link', title: '第一轮来源', url: 'https://example.com/round-1', source: 'commander', state: 'unverified' }],
    }],
    reportSummary: { text: '第二轮结论', at: 30, round: 2 },
    reportMaterials: [{ id: 'mat2', kind: 'image', title: '第二轮截图', path: '/tmp/shot.png', imageUrl: 'http://127.0.0.1:1/commander/tasks/x/materials/mat2?sig=s', source: 'presented', state: 'ok' }],
    dispatches: [
      { id: 'dec_1', round: 1, createdAt: 10, kind: 'initial', finalTarget: { workspaceId: 'ws_1', mode: 'new', sessionId: 's1' }, brief: '第一轮 brief', userRequest: { text: '第一轮原话', at: 9, source: 'chat' } },
      { id: 'dec_2', round: 2, createdAt: 20, kind: 'continue', finalTarget: { workspaceId: 'ws_2', mode: 'new', sessionId: 's2' }, brief: '第二轮 brief', userRequest: { text: '第二轮原话', at: 19, source: 'board' } },
    ],
    sessions: [
      { sessionId: 's1', round: 1, status: 'idle' },
      { sessionId: 's2', round: 2, status: 'idle' },
    ],
    timeline: [
      { at: 10, type: 'dispatch', round: 1, text: '派发 1' },
      { at: 20, type: 'dispatch', round: 2, text: '派发 2' },
      { at: 30, type: 'report', round: 2, text: '报告 2' },
    ],
  }
  const rounds = buildTaskRounds(view, detail)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0]?.round, 1)
  assert.equal(rounds[0]?.userRequest?.text, '第一轮原话')
  assert.equal(rounds[0]?.dispatch?.brief, '第一轮 brief')
  assert.equal(rounds[0]?.acceptance[0]?.text, '第一轮验收')
  assert.equal(rounds[0]?.reportSummary, '第一轮结论')
  assert.equal(rounds[0]?.materials[0]?.title, '第一轮来源')
  assert.equal(rounds[0]?.sessions[0]?.sessionId, 's1')
  assert.equal(rounds[1]?.isCurrent, true)
  assert.equal(rounds[1]?.userRequest?.source, 'board')
  assert.equal(rounds[1]?.dispatch?.brief, '第二轮 brief')
  assert.equal(rounds[1]?.acceptance[0]?.text, '第二轮验收')
  assert.equal(rounds[1]?.reportSummary, '第二轮结论')
  assert.equal(rounds[1]?.materials[0]?.imageUrl?.startsWith('http://127.0.0.1:1/'), true)
  assert.equal(rounds[1]?.sessions[0]?.sessionId, 's2')
})

test('buildTaskRounds keeps legacy single-dispatch payload as round 1', () => {
  const view = task({ id: 'task_legacy', status: 'review', workspaceId: 'ws_1', primarySessionId: 's1' })
  const detail: TaskDetailView = {
    task: view,
    acceptance: [{ id: 'acc1', text: '旧验收', state: 'evidence_present' }],
    dispatches: [{ id: 'dec_old', createdAt: 10, finalTarget: { workspaceId: 'ws_1', mode: 'attach', sessionId: 's1' } }],
    sessions: [{ sessionId: 's1' }],
    timeline: [{ at: 10, type: 'dispatch', text: '派发' }],
  }
  const rounds = buildTaskRounds(view, detail)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0]?.round, 1)
  assert.equal(rounds[0]?.dispatch?.id, 'dec_old')
  assert.equal(rounds[0]?.acceptance[0]?.text, '旧验收')
})


test('dependencyClosure walks both directions for hover highlighting', () => {
  const a = task({ id: 'a' })
  const b = task({ id: 'b', dependsOn: ['a'] })
  const c = task({ id: 'c', dependsOn: ['b'], status: 'running' })
  const lonely = task({ id: 'lonely' })
  const rows = [a, b, c, lonely]
  assert.deepEqual([...dependencyClosure(rows, 'b')].sort(), ['a', 'b', 'c'])
  assert.deepEqual([...dependencyClosure(rows, 'a')].sort(), ['a', 'b', 'c'])
  assert.deepEqual([...dependencyClosure(rows, 'lonely')], ['lonely'])
  assert.deepEqual([...dependencyClosure(rows, 'missing')], ['missing'])
  assert.deepEqual([...downstreamCounts(rows).entries()].sort(), [['a', 1], ['b', 1]])
})

test('dependencyClosure returns the whole graph, including sibling prerequisites', () => {
  // 用户反馈：C 依赖 A 和 B 时，悬停 C 高亮 A+B，悬停 A 只高亮 C——同一张图按节点忽大忽小。
  const a = task({ id: 'a', status: 'review' })
  const b = task({ id: 'b', status: 'review' })
  const c = task({ id: 'c', dependsOn: ['a', 'b'], status: 'proposed' })
  const lonely = task({ id: 'lonely' })
  const rows = [a, b, c, lonely]
  for (const id of ['a', 'b', 'c']) {
    assert.deepEqual([...dependencyClosure(rows, id)].sort(), ['a', 'b', 'c'], `hover ${id}`)
    assert.deepEqual([...dependencyHighlightChain(rows, id) ?? []].sort(), ['a', 'b', 'c'], `highlight ${id}`)
  }
  assert.deepEqual([...dependencyClosure(rows, 'lonely')], ['lonely'])
  assert.equal(dependencyHighlightChain(rows, 'lonely'), null)
})

test('archive helpers group by local month/day and build month bounds', () => {
  const day1 = new Date(2026, 10, 24, 10, 0, 0).getTime()
  const day1Later = new Date(2026, 10, 24, 12, 0, 0).getTime()
  const previous = new Date(2026, 9, 2, 9, 0, 0).getTime()
  const rows = [
    task({ id: 'a1', status: 'archived', updatedAt: day1 }),
    task({ id: 'a2', status: 'cancelled', updatedAt: day1Later }),
    task({ id: 'a3', status: 'archived', updatedAt: previous }),
  ]
  assert.equal(archiveMonthKey(day1), '2026-11')
  assert.deepEqual(archiveMonthBounds('2026-11'), {
    from: new Date(2026, 10, 1).getTime(),
    to: new Date(2026, 11, 1).getTime(),
  })
  const groups = groupArchiveByMonthDay(rows)
  assert.deepEqual(groups.map((row) => row.key), ['2026-11', '2026-10'])
  assert.equal(groups[0]?.days.length, 1)
  assert.deepEqual(groups[0]?.days[0]?.tasks.map((row) => row.id), ['a2', 'a1'])
  assert.equal(groups[1]?.days[0]?.tasks[0]?.id, 'a3')
})


test('archiveCount does not double-count cancelled tasks present in both counts and tasks', () => {
  const tasks = [
    task({ id: 'c1', status: 'cancelled' }),
    task({ id: 'a1', status: 'archived' }),
    task({ id: 'r1', status: 'review' }),
  ]
  // counts 是全域计数（含 archived，快照 tasks 不含 archived）；cancelled 两边都有。
  assert.equal(archiveCount({ counts: { archived: 5, cancelled: 2 }, tasks }), 7)
  // 旧快照没有 counts 时按 tasks 兜底。
  assert.equal(archiveCount({ counts: {}, tasks }), 2)
  // counts 与 tasks 都缺时返回 0。
  assert.equal(archiveCount({ counts: {}, tasks: [] }), 0)
})


test('dependencyHighlightChain only activates for visible dependency relations', () => {
  const a = task({ id: 'a' })
  const b = task({ id: 'b', dependsOn: ['a'] })
  const lonely = task({ id: 'lonely' })
  const rows = [a, b, lonely]
  assert.deepEqual([...dependencyHighlightChain(rows, 'b') ?? []].sort(), ['a', 'b'])
  assert.deepEqual([...dependencyHighlightChain(rows, 'a') ?? []].sort(), ['a', 'b'])
  assert.equal(dependencyHighlightChain(rows, 'lonely'), null)
  // 依赖已归档/不在快照：只剩一个不可见 id，不能触发整板淡出。
  const archivedDep = task({ id: 'c', dependsOn: ['gone'] })
  assert.equal(dependencyHighlightChain([...rows, archivedDep], 'c'), null)
  assert.equal(dependencyHighlightChain(rows, 'missing'), null)
})


test('dependencyEdgePath connects the nearest pair of edges instead of the left-mid edge', () => {
  // 截图（2026-11-26）实测几何：待派发列两张卡上下相邻，运行中卡在第三列偏上。
  const pendingTop = { left: 40, right: 257, top: 38, bottom: 239 }
  const pendingBottom = { left: 40, right: 257, top: 248, bottom: 449 }
  const running = { left: 572, right: 815, top: 38, bottom: 159 }
  // 同一列纵排：从下卡顶边中点垂直连到上卡底边中点，不再绕到左/右侧边的正中。
  assert.equal(
    dependencyEdgePath(pendingBottom, pendingTop),
    'M 148.5 248 C 148.5 238, 148.5 249, 148.5 239',
  )
  assert.equal(
    dependencyEdgePath(pendingTop, pendingBottom),
    'M 148.5 239 C 148.5 249, 148.5 238, 148.5 248',
  )
  // 跨列：从运行中卡左边的**中点**连到左侧目标卡右边的**中点**。
  assert.equal(
    dependencyEdgePath(running, pendingBottom),
    'M 572 98.5 C 439.7 98.5, 389.3 348.5, 257 348.5',
  )
  // 跨列、目标在上：两端仍然是各自边的中点，不是投影到对端中心。
  assert.equal(
    dependencyEdgePath(pendingTop, running),
    'M 257 138.5 C 389.3 138.5, 439.7 98.5, 572 98.5',
  )
})


test('dependencyEdgePath anchors every edge on its own side midpoint (fan-in converges)', () => {
  // 2026-11-27 反馈几何：运行中三张卡都依赖待派发的同一张卡。
  const target = { left: 40, right: 257, top: 137, bottom: 286 }
  const sources = [
    { left: 572, right: 815, top: 137, bottom: 212 },
    { left: 572, right: 815, top: 221, bottom: 318 },
    { left: 572, right: 815, top: 347, bottom: 455 },
  ]
  const ends = sources.map((from) => dependencyEdgePath(from, target).split(' ').slice(-2).join(' '))
  // 同一个目标卡：三条线落在同一个点（右边中点 211.5），不再有 274/274/... 的错位箭头。
  assert.deepEqual(ends, ['257 211.5', '257 211.5', '257 211.5'])
  // 每条线都从自己卡片的左边中点出发（不再被 12px 内缩推到接近角落）。
  const starts = sources.map((from) => {
    const [x, y] = dependencyEdgePath(from, target).replace('M ', '').split(' C ')[0]?.split(' ') ?? []
    return `${x ?? ''} ${y ?? ''}`
  })
  assert.deepEqual(starts, ['572 174.5', '572 269.5', '572 401'])
})


test('dependencyEdgePath never anchors on a card corner and never emits NaN', () => {
  // 极窄/极矮的卡：端点退化为边中点，仍然落在边上。
  const flat = { left: 0, right: 100, top: 0, bottom: 10 }
  const tall = { left: 200, right: 300, top: 300, bottom: 420 }
  const d = dependencyEdgePath(flat, tall)
  assert.doesNotMatch(d, /NaN|Infinity/)
  assert.equal(d, 'M 100 5 C 142 5, 158 360, 200 360')
  // 反向依赖（目标在左侧）：从右边卡片的左边中点出发，进入左边卡片的右边中点。
  const left = { left: 40, right: 257, top: 38, bottom: 239 }
  const right = { left: 572, right: 815, top: 38, bottom: 159 }
  assert.equal(
    dependencyEdgePath(right, left),
    'M 572 98.5 C 439.7 98.5, 389.3 138.5, 257 138.5',
  )
})


test('board columns default to six equal tracks and resize keeps the sum', () => {
  const base = [...DEFAULT_BOARD_COLUMN_FR]
  assert.equal(base.length, 6)
  const next = resizeBoardColumnFr(base, 0, 120, 1200)
  assert.equal(next.length, 6)
  assert.ok(Math.abs(next.reduce((sum, value) => sum + value, 0) - 6) < 1e-9)
  assert.ok((next[0] ?? 0) > 1 && (next[1] ?? 0) < 1)
  // 拖到最左：两列都不低于 180px 换算的 fr，总和不变。
  const clamped = resizeBoardColumnFr(base, 0, -10_000, 1200)
  const minFr = (180 * 6) / 1200
  assert.ok((clamped[0] ?? 0) >= minFr - 1e-9)
  assert.ok((clamped[1] ?? 0) >= minFr - 1e-9)
  assert.ok(Math.abs(clamped.reduce((sum, value) => sum + value, 0) - 6) < 1e-9)
  // 最后一个列没有右分隔条；无宽度时不计算。
  assert.deepEqual(resizeBoardColumnFr(base, 5, 100, 1200), base)
  assert.deepEqual(resizeBoardColumnFr(base, 0, 100, 0), base)
})

test('normalizeBoardColumnFr accepts only six positive numbers', () => {
  assert.deepEqual(normalizeBoardColumnFr([1, 1, 1, 1, 1, 1]), [1, 1, 1, 1, 1, 1])
  assert.equal(normalizeBoardColumnFr([1, 1, 1, 1, 1]), null)
  assert.equal(normalizeBoardColumnFr([1, 1, 1, 1, 1, 0]), null)
  assert.equal(normalizeBoardColumnFr('nope'), null)
  assert.equal(normalizeBoardColumnFr([1, 1, 1, 1, 1, Number.NaN]), null)
})
