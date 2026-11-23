/**
 * Pure unit tests for the M3 approval-card/badge helpers
 * (docs/architecture/m2m3-contract-patch.md §3.3/§3.5).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  answerPendingApproval, approvalSummary, badgeLabelKey, deriveBadgeHints, deriveCommanderBadge, isAlreadySettled,
  isApprovalLike, selectPendingApprovals,
} from '../../src/client/approval.ts'
import type { ApprovalPendingLike, SessionStatusMap } from '../../src/client/approval.ts'
import type { WorkSessionView } from '../../src/client/types.ts'

function approval(overrides: Partial<ApprovalPendingLike> = {}): ApprovalPendingLike {
  return {
    kind: 'approval',
    key: 'approval:1',
    sessionId: 'sess_1',
    toolName: 'bash',
    reason: 'rm -rf build 需要确认',
    answerable: true,
    answer: async () => {},
    ...overrides,
  }
}

function workSession(sessionId: string, taskId: string, title?: string): WorkSessionView {
  return { sessionId, taskId, ...(title === undefined ? {} : { title }) }
}

test('isApprovalLike only accepts approval-kind values with answer()', () => {
  assert.equal(isApprovalLike(approval()), true)
  assert.equal(isApprovalLike({ kind: 'question', answer: async () => {} }), false)
  assert.equal(isApprovalLike({ kind: 'approval' }), false)
  assert.equal(isApprovalLike(null), false)
})

test('selectPendingApprovals reads task-linked work sessions and dedupes by key', () => {
  const shared = approval({ key: 'approval:7' })
  const statuses: SessionStatusMap = new Map([
    ['sess_1', { pendingInteraction: shared }],
    ['sess_2', { pendingInteraction: shared }],
    ['sess_3', { pendingInteraction: { kind: 'question' } }],
    ['sess_4', { pendingInteraction: approval({ key: 'approval:8', sessionId: 'sess_4' }) }],
  ])
  const items = selectPendingApprovals(statuses, [
    workSession('sess_1', 'task_1', '导出会话'),
    workSession('sess_2', 'task_2'),
    workSession('sess_3', 'task_3'),
    workSession('sess_4', 'task_4'),
    workSession('sess_missing', 'task_5'),
  ])
  assert.deepEqual(items.map(item => item.approvalKey), ['approval:7', 'approval:8'])
  assert.equal(items[0]?.taskId, 'task_1')
  assert.equal(items[0]?.title, '导出会话')
  assert.equal(items[0]?.approval, shared)
})

test('answerPendingApproval guards answerable and swallows already-settled', async () => {
  const answers: string[] = []
  const okResult = await answerPendingApproval(approval({ answer: async (outcome) => { answers.push(outcome) } }), 'allowed-once')
  assert.deepEqual(okResult, { ok: true })
  assert.deepEqual(answers, ['allowed-once'])

  const notAnswerable = await answerPendingApproval(approval({ answerable: false }), 'rejected')
  assert.equal(notAnswerable.ok, false)
  assert.equal(notAnswerable.ok === false ? notAnswerable.reason : '', 'not-answerable')

  const settled = await answerPendingApproval(approval({
    answer: async () => { throw new Error('pending approval approval:1 is already settled') },
  }), 'rejected')
  assert.equal(settled.ok === false ? settled.reason : '', 'already-settled')

  const failed = await answerPendingApproval(approval({
    answer: async () => { throw new Error('transport closed') },
  }), 'allowed-once')
  assert.equal(failed.ok === false ? failed.reason : '', 'failed')
  assert.equal(failed.ok === false ? failed.message : '', 'transport closed')
  assert.equal(isAlreadySettled(new Error('already settled')), true)
  assert.equal(isAlreadySettled('nope'), false)
})

test('approvalSummary prefers reason, then display copy', () => {
  assert.equal(approvalSummary(approval()), 'rm -rf build 需要确认')
  assert.equal(approvalSummary(approval({ reason: undefined, displayReason: 'Allow the command?' })), 'Allow the command?')
  assert.equal(approvalSummary(approval({ reason: undefined, displayReason: { text: '需要确认' } })), '需要确认')
  assert.equal(approvalSummary(approval({ reason: undefined })), '')
})

test('deriveCommanderBadge follows the frozen priority order', () => {
  const counts = { review: 2, blocked: 3 }
  assert.deepEqual(deriveCommanderBadge({ hasPendingDispatch: true, approvalCount: 5, counts }), { kind: 'dispatch', count: 1 })
  assert.deepEqual(deriveCommanderBadge({ hasPendingDispatch: false, approvalCount: 2, counts }), { kind: 'approval', count: 2 })
  assert.deepEqual(deriveCommanderBadge({ hasPendingDispatch: false, approvalCount: 0, counts }), { kind: 'review', count: 2 })
  assert.deepEqual(
    deriveCommanderBadge({ hasPendingDispatch: false, approvalCount: 0, counts: { blocked: 1 } }),
    { kind: 'blocked', count: 1 },
  )
  assert.equal(deriveCommanderBadge({ hasPendingDispatch: false, approvalCount: 0, counts: {} }), null)
  // Snapshot missing counts → derive from tasks.
  assert.deepEqual(
    deriveCommanderBadge({ hasPendingDispatch: false, approvalCount: 0, counts: {}, tasks: [{ id: 't', status: 'blocked' }] }),
    { kind: 'blocked', count: 1 },
  )
})

test('deriveBadgeHints lists every non-zero source with its click target', () => {
  const hints = deriveBadgeHints({ hasPendingDispatch: true, approvalCount: 1, counts: { review: 2, blocked: 0 } })
  assert.deepEqual(hints, [
    { kind: 'dispatch', count: 1, action: 'board' },
    { kind: 'approval', count: 1, action: 'approval' },
    { kind: 'review', count: 2, action: 'board' },
  ])
  assert.equal(badgeLabelKey('approval'), 'badge.approval')
})
