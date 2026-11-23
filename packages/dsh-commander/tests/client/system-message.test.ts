/**
 * Pure unit tests for M3 injected message interpretation
 * (docs/architecture/m2m3-contract-patch.md §2.6/§3.1).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretCommanderMessage, parseMetadata } from '../../src/client/system-message.ts'

test('plain messages stay plain', () => {
  assert.equal(interpretCommanderMessage('assistant', '[session-reply] never parsed from assistant').kind, 'plain')
  assert.deepEqual(interpretCommanderMessage('user', '帮我建个任务'), { kind: 'plain', body: '帮我建个任务', meta: [] })
})

test('session-reply body and metadata are split on the --- trailer', () => {
  const text = '[session-reply] 订单导出开关已完成，附截图。\n---\ntaskId=task_1 sessionId=sess_1 turnId=4 seq=37 truncated=false'
  const parsed = interpretCommanderMessage('user', text)
  assert.equal(parsed.kind, 'session-reply')
  assert.equal(parsed.body, '订单导出开关已完成，附截图。')
  assert.equal(parsed.meta.length, 1)
  assert.deepEqual(parseMetadata(parsed.meta), {
    taskId: 'task_1 sessionId=sess_1 turnId=4 seq=37 truncated=false',
  })
})

test('session-reply without trailer keeps the whole body', () => {
  const parsed = interpretCommanderMessage('user', '[session-reply] 本轮无文本回复')
  assert.equal(parsed.kind, 'session-reply')
  assert.equal(parsed.body, '本轮无文本回复')
  assert.deepEqual(parsed.meta, [])
})

test('board-edit messages are recognized and trimmed', () => {
  const parsed = interpretCommanderMessage('user', '[board-edit] taskId=task_1 by=user\nstatus: review → blocked\n---\neditIds=edit_1 injectionKey=k1')
  assert.equal(parsed.kind, 'board-edit')
  assert.equal(parsed.body, 'taskId=task_1 by=user\nstatus: review → blocked')
  assert.deepEqual(parsed.meta, ['editIds=edit_1 injectionKey=k1'])
})

test('parseMetadata keeps the first value and skips malformed lines', () => {
  assert.deepEqual(parseMetadata(['taskId=t1 sessionId=s1 turnId=4 seq=2 truncated=false', 'nope', '=x', 'taskId=t2']), {
    taskId: 't1 sessionId=s1 turnId=4 seq=2 truncated=false',
  })
  assert.deepEqual(parseMetadata(['a=1', 'b=2', 'a=3']), { a: '1', b: '2' })
})
