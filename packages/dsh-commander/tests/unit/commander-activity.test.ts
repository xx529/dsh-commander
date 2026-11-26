import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVITY_TEXT_MAX,
  extractToolDescription,
  normalizeActivityText,
} from '../../src/host/session/commander-events.ts'

test('tool/call description is read from the JSON arguments string', () => {
  const event = {
    type: 'tool/call',
    data: { callId: 'c1', name: 'bash', arguments: '{"description":"  查看   当前目录 ","command":"ls"}' },
  }
  assert.equal(extractToolDescription(event), '查看 当前目录')
})

test('tool/call without a usable description is skipped', () => {
  assert.equal(extractToolDescription({ type: 'tool/call', data: { arguments: '{"command":"ls"}' } }), '')
  assert.equal(extractToolDescription({ type: 'tool/call', data: { arguments: '{"description":"   "}' } }), '')
  assert.equal(extractToolDescription({ type: 'tool/call', data: { arguments: '{"description":42}' } }), '')
  assert.equal(extractToolDescription({ type: 'tool/call', data: { arguments: 'not-json' } }), '')
  assert.equal(extractToolDescription({ type: 'tool/call', data: {} }), '')
})

test('activity text collapses whitespace and truncates with three dots', () => {
  assert.equal(normalizeActivityText('line1\n\nline2\tend'), 'line1 line2 end')
  const long = normalizeActivityText('a'.repeat(ACTIVITY_TEXT_MAX + 1))
  assert.equal(long, `${'a'.repeat(ACTIVITY_TEXT_MAX)}...`)
  assert.equal(normalizeActivityText(''), '')
  assert.equal(normalizeActivityText(undefined), '')
})
