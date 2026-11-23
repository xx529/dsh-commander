import test from 'node:test'
import assert from 'node:assert/strict'
import { appendTimeline } from '../../src/host/store/base.ts'
import type { TaskTimelineItem } from '../../src/host/schema.ts'

const item = (index: number, type: TaskTimelineItem['type'] = 'status'): TaskTimelineItem => ({ at: index, type, text: `t${index}` })

test('appendTimeline appends under limit', () => {
  const timeline = [item(0, 'created'), item(1)]
  const next = appendTimeline(timeline, item(2))
  assert.equal(next.length, 3)
  assert.equal(next.at(-1)?.text, 't2')
})

test('appendTimeline folds oldest 20 when exceeding max and keeps first', () => {
  const timeline = [item(0, 'created')]
  for (let index = 1; index <= 100; index += 1) timeline.push(item(index)) // length 101
  const next = appendTimeline(timeline, item(101))
  assert.ok(next.length <= 100)
  assert.equal(next[0]?.type, 'created')
  assert.equal(next[1]?.type, 'status')
  assert.match(next[1]?.text ?? '', /已折叠 20 条/)
  assert.equal(next.at(-1)?.text, 't101')
})
