import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGate, needsConfirmationReason } from '../../src/host/dispatch/gate.ts'
import { createDecisionStore } from '../../src/host/dispatch/decisions.ts'
import { buildDispatchCandidates, findTargetConflict, resolveWorkspaceReference, type WorkspaceDirectoryEntry } from '../../src/host/dispatch/candidates.ts'
import { buildDispatchBrief } from '../../src/host/dispatch/brief.ts'
import { canTransition } from '../../src/host/schema.ts'

const scores = { pWorkspace: 0.9, pSession: 0.9, pMax: 0.9, concentration: 0.8 }

const thresholds = { pWorkspaceThreshold: 0.8, pSessionThreshold: 0.8 }

test('evaluateGate covers pass/low/conflict/unavailable branches', () => {
  assert.deepEqual(evaluateGate({ scores, conflict: false, jevOk: true, ...thresholds }), { pass: true, reason: 'pass' })
  assert.equal(evaluateGate({ scores, conflict: false, jevOk: true, ...thresholds, pWorkspaceThreshold: 0.95 }).reason, 'low_pworkspace')
  assert.equal(evaluateGate({ scores: { ...scores, pSession: 0.2 }, conflict: false, jevOk: true, ...thresholds }).reason, 'low_psession')
  assert.equal(evaluateGate({ scores: { ...scores, pSession: 0.2 }, conflict: false, jevOk: true, ...thresholds, pSessionThreshold: 0.15 }).reason, 'pass')
  assert.equal(evaluateGate({ scores, conflict: true, jevOk: true, ...thresholds }).reason, 'conflict')
  assert.equal(evaluateGate({ scores, conflict: false, jevOk: false, ...thresholds }).reason, 'jev_unavailable')
})

test('needsConfirmationReason always confirms and surfaces most specific reason', () => {
  assert.equal(needsConfirmationReason({ jevOk: true, scores, ...thresholds }), 'user_confirm_required')
  assert.equal(needsConfirmationReason({ jevOk: true, scores: { ...scores, pMax: 0.1, pWorkspace: 0.1 }, ...thresholds }), 'low_confidence')
  assert.equal(needsConfirmationReason({ jevOk: false, scores, ...thresholds }), 'jev_unavailable')
})

test('decision store: create/get/expire/used/supersede', () => {
  let nowValue = 1000
  const store = createDecisionStore({ ttlMs: 1000, now: () => nowValue })
  const candidate = { workspaceId: 'ws', workspaceName: 'WS', workspacePath: '/tmp/ws', mode: 'new' as const, pWorkspace: 0.5, pSession: 0.5, score: 0.25 }
  const decision = store.create({
    decisionId: 'dec_1', taskId: 'task_1', taskTitle: 't', candidates: [candidate], recommendation: candidate, scores,
    reason: 'user_confirm_required',
    jev: { provider: 'typesafe', endpoint: 'e', model: 'm', requestId: 'r', latencyMs: 1, ok: true, mode: 'two_stage', tokenEstimate: 10 },
    prefilter: { workspaceIds: ['ws'], sessionIds: [], scores: {}, truncated: false },
    createdAtRequestId: 'r',
  })
  assert.equal(decision.expiresAt, 2000)
  assert.equal(store.get('dec_1')?.decisionId, 'dec_1')
  nowValue = 2001
  assert.equal(store.get('dec_1'), undefined)
  assert.deepEqual(store.getUsable('dec_1', 'task_1'), { error: 'decision_expired' })
  nowValue = 1000
  const second = store.create({
    decisionId: 'dec_2', taskId: 'task_1', taskTitle: 't', candidates: [candidate], recommendation: candidate, scores,
    reason: 'user_confirm_required',
    jev: { provider: 'typesafe', endpoint: 'e', model: 'm', requestId: 'r2', latencyMs: 1, ok: true, mode: 'two_stage', tokenEstimate: 10 },
    prefilter: { workspaceIds: ['ws'], sessionIds: [], scores: {}, truncated: false },
    createdAtRequestId: 'r2',
  })
  assert.equal(store.size(), 1) // 新决策覆盖旧决策
  assert.equal(store.pendingForTask('task_1').length, 1)
  store.markUsed(second.decisionId)
  assert.equal(store.getUsable(second.decisionId, 'task_1').decision?.used, true)
})

const context: DispatchContext = {
  workspaces: [
    { id: 'ws-a', name: 'A', path: '/tmp/a', summary: '', recentSessionTitles: [] },
    { id: 'ws-b', name: 'B', path: '/tmp/b', summary: '', recentSessionTitles: [] },
  ],
  sessions: [{ id: 's-1', workspaceId: 'ws-a', title: 'one', lastActiveAt: 1 }],
  allowedWorkspaceIds: ['ws-a', 'ws-b'],
  workspaceById: new Map(),
  policyById: new Map(),
}
context.workspaceById = new Map(context.workspaces.map((workspace) => [workspace.id, workspace]))

test('buildDispatchCandidates puts recommendation first and caps candidates', () => {
  const answers = { workspace: { type: 'choice' as const, choice: 'w_1', probabilities: { w_0: 0.2, w_1: 0.8 }, confidence: 0.7 } }
  const built = buildDispatchCandidates({ context, answers, mapped: { workspaceId: 'ws-b', sessionId: null, mode: 'new' }, max: 2 })
  assert.equal(built.candidates.length, 2)
  assert.equal(built.candidates[0]?.workspaceId, 'ws-b')
  assert.equal(built.candidates[0]?.reason, 'recommendation')
  assert.equal(built.candidates[1]?.workspaceId, 'ws-a')
  assert.equal(built.candidates[1]?.pWorkspace, 0.2)
})

test('findTargetConflict validates attach session ownership/existence', () => {
  assert.equal(findTargetConflict(context, { workspaceId: 'ws-a', sessionId: 's-1', mode: 'attach' }), null)
  assert.match(findTargetConflict(context, { workspaceId: 'ws-b', sessionId: 's-1', mode: 'attach' })?.message ?? '', /belongs to 'ws-a'/)
  assert.match(findTargetConflict(context, { workspaceId: 'ws-a', sessionId: 'missing', mode: 'attach' })?.message ?? '', /not an attachable/)
})

test('buildDispatchBrief contains task/target/acceptance and no internal ids', () => {
  const brief = buildDispatchBrief({
    title: 'T', goal: 'G',
    acceptance: [
      { id: 'a1', text: 'A1', source: 'commander', state: 'insufficient' },
      { id: 'a2', text: 'A2', source: 'commander', state: 'insufficient' },
      { id: 'a3', text: 'A3', source: 'commander', state: 'insufficient' },
      { id: 'a4', text: 'A4', source: 'commander', state: 'insufficient' },
      { id: 'a5', text: 'A5', source: 'commander', state: 'insufficient' },
      { id: 'a6', text: 'A6-not-included', source: 'commander', state: 'insufficient' },
    ],
  })
  assert.match(brief, /^任务：T\n目标：G/)
  assert.match(brief, /验收提示：A1；A2；A3；A4；A5/)
  assert.equal(brief.includes('A6-not-included'), false)
  // 工作会话不暴露插件内部的关联 id / marker（关系在 tasks/dispatches/sessions 持久化里）
  assert.doesNotMatch(brief, /\[commander-dispatch\]/)
  assert.doesNotMatch(brief, /taskId=|decisionId=|sessionId=/)
})

test('task state machine allows only declared transitions (done human-only path)', () => {
  assert.equal(canTransition('queued', 'running'), true)
  assert.equal(canTransition('draft', 'running'), false)
  assert.equal(canTransition('review', 'done'), true)
  assert.equal(canTransition('done', 'running'), false)
})


const directory: WorkspaceDirectoryEntry[] = [
  { id: 'ws-a', name: 'HtDot-OrderCenter', path: '/Users/me/work/order-center', allowed: true, summary: 'A', policy: 'inherit' },
  { id: 'ws-b', name: 'HtDot-OrderCenter', path: '/Users/me/work/order-center-2', allowed: true, summary: 'B', policy: 'auto' },
  { id: 'ws-c', name: 'Hidden', path: '/Users/me/work/hidden', allowed: false, summary: 'C', policy: 'inherit' },
]

test('resolveWorkspaceReference: id/name/path/basename 归一解析', () => {
  assert.deepEqual(resolveWorkspaceReference(directory, 'ws-a'), { status: 'resolved', workspace: directory[0] })
  assert.deepEqual(resolveWorkspaceReference(directory, '  htdot-ordercenter  '), { status: 'ambiguous', candidates: [directory[0], directory[1]] })
  assert.deepEqual(resolveWorkspaceReference(directory, '/Users/me/work/HIDDEN'), { status: 'resolved', workspace: directory[2] })
  assert.deepEqual(resolveWorkspaceReference(directory, 'hidden'), { status: 'resolved', workspace: directory[2] })
  assert.equal(resolveWorkspaceReference(directory, '/Users/me/work/order-center-2').status, 'resolved')
})

test('resolveWorkspaceReference: not_found 给 allowed 提示，空引用 not_found', () => {
  const notFound = resolveWorkspaceReference(directory, 'nope')
  assert.equal(notFound.status, 'not_found')
  if (notFound.status === 'not_found') {
    assert.match(notFound.allowedHint, /ws-a/)
    assert.match(notFound.allowedHint, /ws-b/)
    assert.equal(notFound.allowedHint.includes('ws-c'), false)
  }
  assert.equal(resolveWorkspaceReference(directory, '   ').status, 'not_found')
})
