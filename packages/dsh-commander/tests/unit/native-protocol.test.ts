import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeHostFrame, parseShellFrame, SHELL_PROTOCOL } from '../../src/host/native/protocol.ts'

test('parseShellFrame accepts the four shell frame types', () => {
  const hello = parseShellFrame(JSON.stringify({ type: 'hello', protocol: SHELL_PROTOCOL, platform: 'darwin', arch: 'arm64', pid: 7, capabilities: ['ball'], hotkey: 'Alt+Space' }))
  assert.deepEqual(hello, { type: 'hello', protocol: 1, platform: 'darwin', arch: 'arm64', pid: 7, capabilities: ['ball'], hotkey: 'Alt+Space' })

  assert.deepEqual(parseShellFrame('{"type":"pong","at":12}'), { type: 'pong', at: 12 })
  assert.deepEqual(parseShellFrame('{"type":"window/visibility","visible":true,"panelOpen":true,"focused":false}'), {
    type: 'window/visibility', visible: true, panelOpen: true, focused: false,
  })
  assert.deepEqual(parseShellFrame('{"type":"window/bounds","x":1,"y":2,"width":3,"height":4,"scale":2}'), {
    type: 'window/bounds', x: 1, y: 2, width: 3, height: 4, scale: 2,
  })
  assert.deepEqual(parseShellFrame('{"type":"log","level":"warn","message":"hi"}'), { type: 'log', level: 'warn', message: 'hi' })
})

test('parseShellFrame rejects malformed, unknown, and oversized frames', () => {
  assert.equal(parseShellFrame(''), null)
  assert.equal(parseShellFrame('not json'), null)
  assert.equal(parseShellFrame('null'), null)
  assert.equal(parseShellFrame('{"type":"nope"}'), null)
  assert.equal(parseShellFrame(JSON.stringify({ type: 'hello', protocol: 1 })), null)
  const huge = JSON.stringify({ type: 'log', level: 'info', message: 'x'.repeat(1_048_577) })
  assert.equal(parseShellFrame(huge), null)
})

test('encodeHostFrame emits one JSON line', () => {
  const line = encodeHostFrame({ type: 'ping', at: 5 })
  assert.equal(line, '{"type":"ping","at":5}\n')
  assert.equal(line.split('\n').filter(Boolean).length, 1)
})
