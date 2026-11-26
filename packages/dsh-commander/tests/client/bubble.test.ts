import test from 'node:test'
import assert from 'node:assert/strict'
import { BUBBLE_ACTIVITY_MAX_CHARS, bubbleActivityText, bubblePhaseFor } from '../../src/client/bubble.ts'

test('lite bubble: busy shows working, idle before first turn stays hidden', () => {
  assert.equal(bubblePhaseFor({ busy: true, connection: 'live', wasBusy: false }), 'working')
  assert.equal(bubblePhaseFor({ busy: false, connection: 'live', wasBusy: false }), 'hidden')
})

test('lite bubble: busy → idle shows success exactly once', () => {
  assert.equal(bubblePhaseFor({ busy: false, connection: 'live', wasBusy: true }), 'success')
  // 调用方在 success 后把 wasBusy 置回 false，下个 tick 不再重复 success。
  assert.equal(bubblePhaseFor({ busy: false, connection: 'live', wasBusy: false }), 'hidden')
})

test('lite bubble: offline/reconnecting hides a stale working bubble', () => {
  assert.equal(bubblePhaseFor({ busy: true, connection: 'offline', wasBusy: true }), 'hidden')
  assert.equal(bubblePhaseFor({ busy: true, connection: 'reconnecting', wasBusy: true }), 'hidden')
  assert.equal(bubblePhaseFor({ busy: false, connection: 'offline', wasBusy: false }), 'hidden')
})

test('lite bubble: polling keeps the existing busy/success semantics', () => {
  assert.equal(bubblePhaseFor({ busy: true, connection: 'polling', wasBusy: false }), 'working')
  assert.equal(bubblePhaseFor({ busy: false, connection: 'polling', wasBusy: true }), 'success')
})

test('bubble activity text: single line, short text unchanged, long text ends with ...', () => {
  assert.equal(bubbleActivityText('  查看\n当前目录  '), '查看 当前目录')
  assert.equal(bubbleActivityText(''), '')
  assert.equal(bubbleActivityText(null), '')
  assert.equal(bubbleActivityText('a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS)), 'a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS))
  assert.equal(
    bubbleActivityText('a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS + 1)),
    `${'a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS)}...`,
  )
})
