/**
 * Pure unit tests for the M1 dispatch card protocol helpers
 * (docs/architecture/m1-contract-patch.md §2.1 / §3.1).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAdoptMessage, buildCancelMessage, buildCustomMessage, buildDispatchActionMessage, candidateProbability, candidateTotal,
  capabilitySummary,
  capabilityTotal,
  formatPercent, formatRemaining, isExpired, pendingPMax, pendingPWorkspace, pendingTaskTitle, pendingThreshold,
  reasonLabelKey, remainingMs, targetToken, taskStatusLabelKey, visibleCandidates, workspaceOptions,
} from '../../src/client/dispatch.ts'
import type { PendingDispatchView } from '../../src/client/types.ts'
import type { CommanderState } from '../../src/client/state.ts'
import { createInitialState } from '../../src/client/state.ts'

function pending(overrides: Partial<PendingDispatchView> = {}): PendingDispatchView {
  return {
    decisionId: 'dec_0123456789abcdef01234567',
    taskId: 'task_1',
    taskTitle: '给订单导出加开关',
    recommendation: { workspaceId: 'htdot', mode: 'new' },
    candidates: [
      { workspaceId: 'htdot', workspaceName: 'HtDot', mode: 'new', pWorkspace: 0.62, pSession: 0.71, score: 0.44 },
      { workspaceId: 'mira', workspaceName: 'Mira', mode: 'attach', sessionId: 'sess_9', pWorkspace: 0.31 },
    ],
    scores: { pWorkspace: 0.62, pSession: 0.71, pMax: 0.62, concentration: 0.43 },
    reason: 'user_confirm_required',
    createdAt: 1_000,
    expiresAt: 1_000 + 30 * 60 * 1_000,
    ...overrides,
  }
}

test('adopt template matches the M1 contract text', () => {
  assert.equal(
    buildAdoptMessage(pending()),
    '[dispatch-confirm] 采用建议\ndecisionId=dec_0123456789abcdef01234567 taskId=task_1\ntarget=workspaceId:htdot;mode:new',
  )
})

test('custom template carries the picked attach target', () => {
  assert.equal(
    buildCustomMessage(pending(), { workspaceId: 'mira', mode: 'attach', sessionId: 'sess_9' }),
    '[dispatch-confirm] 自定义\ndecisionId=dec_0123456789abcdef01234567 taskId=task_1\ntarget=workspaceId:mira;mode:attach;sessionId:sess_9',
  )
})

test('custom attach card action matches the M1R contract text', () => {
  assert.equal(
    buildDispatchActionMessage('custom', pending(), { workspaceId: 'htdot', mode: 'attach', sessionId: 'sess_9' }),
    '[dispatch-confirm] 自定义\ndecisionId=dec_0123456789abcdef01234567 taskId=task_1\ntarget=workspaceId:htdot;mode:attach;sessionId:sess_9',
  )
  assert.equal(
    buildDispatchActionMessage('custom', pending(), { workspaceId: 'htdot', mode: 'new' }),
    '[dispatch-confirm] 自定义\ndecisionId=dec_0123456789abcdef01234567 taskId=task_1\ntarget=workspaceId:htdot;mode:new',
  )
})

test('cancel template has no target line', () => {
  const text = buildCancelMessage(pending())
  assert.equal(text, '[dispatch-confirm] 取消\ndecisionId=dec_0123456789abcdef01234567 taskId=task_1')
  assert.equal(text.includes('target='), false)
})

test('templates omit missing ids without inventing values', () => {
  const sparse = pending({ decisionId: undefined, taskId: undefined })
  const text = buildAdoptMessage(sparse)
  assert.equal(text.startsWith('[dispatch-confirm] 采用建议\n'), true)
  assert.equal(text.includes('decisionId='), false)
  assert.equal(text.includes('taskId='), false)
})

test('target token renders workspace + mode and optional session', () => {
  assert.equal(targetToken({ workspaceId: 'htdot', mode: 'new' }), 'target=workspaceId:htdot;mode:new')
  assert.equal(
    targetToken({ workspaceId: 'mira', mode: 'attach', sessionId: 'sess_9' }),
    'target=workspaceId:mira;mode:attach;sessionId:sess_9',
  )
  // An attach target without a session id degrades to the plain workspace form.
  assert.equal(targetToken({ workspaceId: 'mira', mode: 'attach' }), 'target=workspaceId:mira;mode:new')
})

test('probabilities/percentages normalize 0..1 and 0..100', () => {
  assert.equal(candidateProbability({ workspaceId: 'a', pWorkspace: 0.62 }), 0.62)
  assert.equal(candidateProbability({ workspaceId: 'b', score: 62 }), 0.62)
  assert.equal(formatPercent(0.62), '62%')
  assert.equal(formatPercent(undefined), '—')
  assert.equal(pendingPMax(pending()), 0.62)
  assert.equal(pendingPWorkspace(pending()), 0.62)
  assert.equal(pendingThreshold(pending({ threshold: 0.8 })), 0.8)
  assert.equal(pendingThreshold(pending()), undefined)
})

test('candidate list and counts respect the card limits', () => {
  const many = pending({ candidates: Array.from({ length: 6 }, (_value, index) => ({ workspaceId: `w${String(index)}` })) })
  assert.equal(visibleCandidates(many).length, 3)
  assert.equal(candidateTotal(many), 6)
})

test('reason and task status map to locale keys', () => {
  assert.equal(reasonLabelKey('user_confirm_required'), 'dispatch.reason.userConfirm')
  assert.equal(reasonLabelKey('low_confidence'), 'dispatch.reason.lowConfidence')
  assert.equal(reasonLabelKey('jev_unavailable'), 'dispatch.reason.jevUnavailable')
  assert.equal(reasonLabelKey('decision_required'), 'dispatch.reason.decisionRequired')
  assert.equal(reasonLabelKey('weird'), 'dispatch.reason.other')
  assert.equal(taskStatusLabelKey('running'), 'task.status.running')
  assert.equal(taskStatusLabelKey(undefined), 'task.status.other')
})

test('countdown / expiry derive from expiresAt', () => {
  const at = pending({ createdAt: 0, expiresAt: 60_000 })
  assert.equal(remainingMs(at, 0), 60_000)
  assert.equal(remainingMs(at, 90_000), 0)
  assert.equal(formatRemaining(at, 0), '01:00')
  assert.equal(formatRemaining(at, 30_500), '00:30')
  assert.equal(isExpired(at, 0), false)
  assert.equal(isExpired(at, 60_001), true)
  assert.equal(remainingMs({ decisionId: 'd' }, 0), undefined)
  assert.equal(formatRemaining({ decisionId: 'd' }, 0), '')
})

test('pending task title prefers the Host field, then the snapshot tasks', () => {
  const state: CommanderState = {
    ...createInitialState(),
    tasks: [{ id: 'task_1', title: '快照标题', status: 'proposed' }],
  }
  assert.equal(pendingTaskTitle(state, pending()), '给订单导出加开关')
  assert.equal(pendingTaskTitle(state, pending({ taskTitle: undefined })), '快照标题')
  assert.equal(pendingTaskTitle(state, pending({ taskTitle: undefined, taskId: 'missing' })), undefined)
})

test('custom picker shows allowed workspaces first', () => {
  const state: CommanderState = {
    ...createInitialState(),
    workspaces: [
      { id: 'a', name: 'A', allowed: false },
      { id: 'b', name: 'B', allowed: true },
    ],
  }
  assert.deepEqual(workspaceOptions(state).map(row => row.id), ['b'])
  const none = { ...createInitialState(), workspaces: [{ id: 'a', allowed: false }, { id: 'b', allowed: false }] }
  assert.equal(workspaceOptions(none).length, 2)
})

test('capability summary degrades safely', () => {
  assert.deepEqual(capabilitySummary({ id: 't', capability: { status: 'applied', enabledCount: 3, disabledCount: 12, durationMs: 240 } }), {
    status: 'applied', enabledCount: 3, disabledCount: 12, durationMs: 240,
  })
  assert.equal(capabilitySummary({ id: 't' }), undefined)
  assert.equal(capabilitySummary({ id: 't', capability: null }), undefined)
  assert.equal(capabilityTotal({ enabledCount: 3, disabledCount: 2 }), 5)
  assert.equal(capabilityTotal({ enabledCount: 0, disabledCount: 0 }), 0)
  assert.equal(capabilityTotal(undefined), 0)
})
