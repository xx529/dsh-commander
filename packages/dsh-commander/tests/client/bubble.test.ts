import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUBBLE_ACTIVITY_MAX_CHARS,
  BUBBLE_LINE_HEIGHT,
  bubbleActivityText,
  bubbleContentWidth,
  bubblePhaseFor,
  bubblePillHeight,
  bubblePillWidth,
  bubbleRowsFromHeight,
  bubbleTextMotion,
  lastAssistantReply,
} from '../../src/client/bubble.ts'

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

test('bubble activity text: folds whitespace, caps at 120 chars for the 5-row pill', () => {
  assert.equal(bubbleActivityText('  查看\n当前目录  '), '查看 当前目录')
  assert.equal(bubbleActivityText(''), '')
  assert.equal(bubbleActivityText(null), '')
  assert.equal(BUBBLE_ACTIVITY_MAX_CHARS, 120)
  assert.equal(bubbleActivityText('a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS)), 'a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS))
  assert.equal(
    bubbleActivityText('a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS + 1)),
    `${'a'.repeat(BUBBLE_ACTIVITY_MAX_CHARS)}...`,
  )
})

test('last assistant reply: newest assistant text, ignores user/system and blanks', () => {
  assert.equal(lastAssistantReply(null), '')
  assert.equal(lastAssistantReply([]), '')
  assert.equal(lastAssistantReply([{ role: 'user', text: '查一下' }]), '')
  const messages = [
    { role: 'user', text: '查一下' },
    { role: 'assistant', text: '  第一轮回复  ' },
    { role: 'system', text: '系统消息' },
    { role: 'assistant', text: '最后一轮回复' },
    { role: 'assistant', text: '   ' },
  ]
  assert.equal(lastAssistantReply(messages), '最后一轮回复')
})

test('bubble pill width: shrinks to content, caps at 312, reserves the icon block', () => {
  assert.equal(bubblePillWidth(0, false), 25)
  assert.equal(bubblePillWidth(100, false), 125)
  assert.equal(bubblePillWidth(100, true), 158)
  assert.equal(bubblePillWidth(400, false), 312)
  assert.equal(bubblePillWidth(400, true), 312)
  // 内容宽 = pill 宽 − 左右内边距 23 − 边框 2 −（图标 24 + 间距 9）
  assert.equal(bubbleContentWidth(312, false), 287)
  assert.equal(bubbleContentWidth(312, true), 254)
})

test('bubble rows and height: 16.2 per row, 5 rows cap, 44 minimum', () => {
  assert.equal(BUBBLE_LINE_HEIGHT, 16.2)
  assert.equal(bubbleRowsFromHeight(16.2), 1)
  assert.equal(bubbleRowsFromHeight(16.2 * 3), 3)
  assert.equal(bubbleRowsFromHeight(16.2 * 5), 5)
  assert.equal(bubbleRowsFromHeight(16.2 * 9), 5)
  assert.equal(bubbleRowsFromHeight(0), 1)
  assert.equal(bubblePillHeight(1), 44)
  assert.equal(bubblePillHeight(2), 51)
  assert.equal(bubblePillHeight(5), 99)
})

test('bubble text motion: single-line crossfades, multi-row goes sequential', () => {
  assert.equal(bubbleTextMotion(null, 1), 'none')
  assert.equal(bubbleTextMotion(1, 1), 'crossfade')
  assert.equal(bubbleTextMotion(1, 3), 'sequential')
  assert.equal(bubbleTextMotion(4, 1), 'sequential')
  assert.equal(bubbleTextMotion(5, 5), 'sequential')
})
