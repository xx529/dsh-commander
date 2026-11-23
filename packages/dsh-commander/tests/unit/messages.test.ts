import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageRing, truncateMessageText } from '../../src/host/session/messages.ts'

test('truncateMessageText leaves short text untouched', () => {
  const result = truncateMessageText('hello')
  assert.deepEqual(result, { text: 'hello', truncated: false, fullChars: 5 })
})

test('truncateMessageText keeps head 6144 + tail 2048 with marker', () => {
  const long = 'x'.repeat(9000)
  const result = truncateMessageText(long)
  assert.equal(result.truncated, true)
  assert.equal(result.fullChars, 9000)
  assert.ok(result.text.startsWith('x'.repeat(6144)))
  assert.ok(result.text.endsWith('x'.repeat(2048)))
  assert.match(result.text, /\[truncated 808 chars\]/)
})

test('message ring dedupes messageId and evicts beyond ring max', () => {
  let order = 0
  const ring = createMessageRing({ ringMax: 3, snapshotMax: 2, now: () => 1 })
  ring.push({ messageId: 'a', role: 'user', text: 'a' })
  ring.push({ messageId: 'a', role: 'user', text: 'a' })
  ring.push({ messageId: 'b', role: 'assistant', text: 'b', turnId: 1, seq: 2 })
  ring.push({ messageId: 'c', role: 'user', text: 'c' })
  ring.push({ messageId: 'd', role: 'user', text: 'd' })
  const snapshot = ring.snapshot()
  assert.deepEqual(snapshot.map((message) => message.messageId), ['c', 'd'])
  assert.deepEqual(snapshot.map((message) => message.order), [3, 4])
  order = ring.currentOrder()
  assert.equal(order, 4)
})

test('message ring reserve assigns order then remove rolls back (M5 ordering)', () => {
  const ring = createMessageRing({ ringMax: 10, snapshotMax: 10, now: () => 1 })
  const reserved = ring.reserve({ messageId: 'req_1', role: 'user', text: 'hi' })
  assert.equal(reserved?.order, 1)
  ring.push({ messageId: 'asst_1_2', role: 'assistant', text: 'reply' })
  assert.deepEqual(ring.snapshot().map((message) => [message.messageId, message.order]), [['req_1', 1], ['asst_1_2', 2]])
  assert.equal(ring.remove('req_1'), true)
  assert.deepEqual(ring.snapshot().map((message) => message.messageId), ['asst_1_2'])
  assert.equal(ring.remove('req_1'), false)
})

test('message ring snapshot capped at 200 by default', () => {
  const ring = createMessageRing()
  for (let index = 0; index < 250; index += 1) ring.push({ messageId: `m${index}`, role: 'user', text: String(index) })
  assert.equal(ring.snapshot().length, 200)
  assert.equal(ring.size(), 250)
})
