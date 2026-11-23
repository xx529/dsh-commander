import test from 'node:test'
import assert from 'node:assert/strict'
import { createId, deriveDecisionId, sanitizeKey, sessionLinkKey } from '../../src/host/store/base.ts'

test('sanitizeKey keeps legal keys unchanged', () => {
  assert.equal(sanitizeKey('htdot-project_1'), 'htdot-project_1')
  assert.equal(sanitizeKey('task_abc123'), 'task_abc123')
})

test('sanitizeKey replaces illegal chars and appends sha1 suffix', () => {
  const key = sanitizeKey('workspace/with:slash')
  assert.match(key, /^[a-zA-Z0-9_-]+$/)
  assert.match(key, /--[0-9a-f]{8}$/)
  assert.equal(key, sanitizeKey('workspace/with:slash'))
  assert.notEqual(sanitizeKey('a/b'), sanitizeKey('a/c'))
})

test('sessionLinkKey is <ws>__<session> with both segments sanitized', () => {
  assert.equal(sessionLinkKey('ws1', 'session-abc'), 'ws1__session-abc')
  const key = sessionLinkKey('a/b', 'c:d')
  assert.match(key, /^[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+$/)
})

test('deriveDecisionId is deterministic and stable', () => {
  const a = deriveDecisionId('task_1', 'req_1')
  const b = deriveDecisionId('task_1', 'req_1')
  assert.equal(a, b)
  assert.match(a, /^dec_[0-9a-f]{24}$/)
  assert.notEqual(a, deriveDecisionId('task_1', 'req_2'))
})

test('createId carries prefix and timestamp base36', () => {
  assert.match(createId('task', 1700000000000), /^task_[0-9a-z]+[0-9a-f]{6}$/)
  assert.match(createId('edit'), /^edit_/)
})
