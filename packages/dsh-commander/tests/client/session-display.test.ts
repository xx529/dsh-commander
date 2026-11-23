/**
 * Session-row readability helpers (task-66): short id, relative activity,
 * created-at stamp, unnamed title fallback and binding error mapping.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bindingErrorLabelKey, describeBindingFailure, formatRelativeActivity, formatSessionCreatedAt, isUnnamedSession,
  sessionDisplayTitle, shortSessionId,
} from '../../src/client/session-display.ts'

const t = (key: string): string => key
const NOW = Date.UTC(2026, 10, 18, 3, 0, 0)

test('shortSessionId keeps the tail with an ellipsis', () => {
  assert.equal(shortSessionId('session-59d99d5b-4ac7fcd'), '…4ac7fcd')
  assert.equal(shortSessionId('session-1', 7), '…ssion-1')
  assert.equal(shortSessionId('short'), '…short')
  assert.equal(shortSessionId(''), '')
})

test('relative activity buckets seconds/minutes/hours/days/months/years', () => {
  assert.equal(formatRelativeActivity(undefined, NOW, t), '')
  assert.equal(formatRelativeActivity(0, NOW, t), '')
  assert.equal(formatRelativeActivity(NOW - 30_000, NOW, t), 'time.justNow')
  assert.equal(formatRelativeActivity(NOW - 2 * 60_000, NOW, t), '2 time.minutesAgo')
  assert.equal(formatRelativeActivity(NOW - 3 * 3_600_000, NOW, t), '3 time.hoursAgo')
  assert.equal(formatRelativeActivity(NOW - 2 * 86_400_000, NOW, t), '2 time.daysAgo')
  assert.equal(formatRelativeActivity(NOW - 40 * 86_400_000, NOW, t), '1 time.monthsAgo')
  assert.equal(formatRelativeActivity(NOW - 400 * 86_400_000, NOW, t), '1 time.yearsAgo')
  // Clock skew must not render a negative delta.
  assert.equal(formatRelativeActivity(NOW + 60_000, NOW, t), 'time.justNow')
})

test('formatSessionCreatedAt renders MM/DD HH:mm and skips invalid values', () => {
  const stamp = formatSessionCreatedAt(Date.UTC(2026, 10, 17, 15, 38))
  assert.match(stamp, /\d{2}\/\d{2}/u)
  assert.equal(formatSessionCreatedAt(0), '')
  assert.equal(formatSessionCreatedAt(undefined), '')
})

test('unnamed sessions fall back to the labelled title', () => {
  assert.equal(sessionDisplayTitle('订单导出', t), '订单导出')
  assert.equal(sessionDisplayTitle('', t), 'settings.binding.unnamedSession')
  assert.equal(sessionDisplayTitle('   ', t), 'settings.binding.unnamedSession')
  assert.equal(sessionDisplayTitle(undefined, t), 'settings.binding.unnamedSession')
  assert.equal(isUnnamedSession(''), true)
  assert.equal(isUnnamedSession(undefined), true)
  assert.equal(isUnnamedSession('会话'), false)
})

test('binding failure codes map to readable copy and keep the code', () => {
  assert.equal(bindingErrorLabelKey('not_found'), 'settings.binding.error.notFound')
  assert.equal(bindingErrorLabelKey('workspace_conflict'), 'settings.binding.error.workspaceConflict')
  assert.equal(bindingErrorLabelKey('invalid_request'), 'settings.binding.error.generic')
  assert.equal(bindingErrorLabelKey(undefined), 'settings.binding.error.generic')
  const text = describeBindingFailure({ ok: false, code: 'not_found', message: 'gone' }, t)
  assert.equal(text, 'settings.binding.error.notFound（not_found）')
  const conflict = describeBindingFailure({ ok: false, code: 'workspace_conflict', message: 'x' }, t)
  assert.equal(conflict, 'settings.binding.error.workspaceConflict（workspace_conflict）')
  // invalid_request keeps the Host message verbatim (includes actionable detail).
  assert.equal(
    describeBindingFailure({ ok: false, code: 'invalid_request', message: '可用会话 0 个' }, t),
    '可用会话 0 个（invalid_request）',
  )
})
