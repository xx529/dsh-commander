import test from 'node:test'
import assert from 'node:assert/strict'
import { validateBindingBody, validateConfigPatch, validateMessageBody, validateWorkspacesBody } from '../../src/host/api/validation.ts'
import { createIdempotencyCache } from '../../src/host/api/server.ts'
import { ApiError } from '../../src/host/api/errors.ts'

const code = (fn: () => unknown): string => {
  try {
    fn()
    return 'no-error'
  } catch (error) {
    return error instanceof ApiError ? error.code : 'not-api-error'
  }
}

test('validateMessageBody enforces text/requestId constraints', () => {
  assert.equal(validateMessageBody({ text: ' hi ', requestId: 'req_12345678' }).text, 'hi')
  assert.equal(code(() => validateMessageBody({ text: '', requestId: 'req_12345678' })), 'invalid_request')
  assert.equal(code(() => validateMessageBody({ text: 'x', requestId: 'short' })), 'invalid_request')
  assert.equal(code(() => validateMessageBody({ text: 'x', requestId: 'req_12345678', extra: 1 })), 'invalid_request')
})

test('validateConfigPatch rejects binding fields and out-of-range numbers', () => {
  assert.equal(code(() => validateConfigPatch({ commander: { sessionId: 's' } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ jev: { threshold: 0.2 } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ jev: { timeoutMs: 100 } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ jev: { endpoint: 'ftp://x' } })), 'invalid_request')
  const patch = validateConfigPatch({ jev: { apiKeyEnv: 'MY_KEY' }, ui: { theme: 'dark' } })
  assert.equal(patch.jev?.apiKeyEnv, 'MY_KEY')
  assert.equal(patch.ui?.theme, 'dark')
})

test('validateConfigPatch accepts floating-entry settings', () => {
  const patch = validateConfigPatch({ ui: { entryEnabled: false, entryPos: { x: 0.25, y: 0.75 }, nativeShell: false } })
  assert.deepEqual(patch.ui, { entryEnabled: false, entryPos: { x: 0.25, y: 0.75 }, nativeShell: false })
  assert.deepEqual(validateConfigPatch({ ui: { entryPos: null } }).ui, { entryPos: null })
  assert.equal(code(() => validateConfigPatch({ ui: { entryEnabled: 'yes' } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ ui: { nativeShell: 'yes' } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ ui: { entryPos: { x: 1.5, y: 0 } } })), 'invalid_request')
  assert.equal(code(() => validateConfigPatch({ ui: { entryPos: { x: 0.1, y: 0.2, z: 1 } } })), 'invalid_request')
})

test('validateWorkspacesBody rejects duplicates/unknown policy', () => {
  assert.equal(code(() => validateWorkspacesBody({ workspaces: [{ id: 'a', allowed: true }, { id: 'a', allowed: false }] })), 'invalid_request')
  assert.equal(code(() => validateWorkspacesBody({ workspaces: [{ id: 'a', allowed: true, policy: 'auto2' }] })), 'invalid_request')
})

test('validateBindingBody enforces oneOf arms', () => {
  assert.equal(validateBindingBody({ mode: 'new', workspaceId: 'w' }).mode, 'new')
  assert.equal(validateBindingBody({ mode: 'select', sessionId: 's' }).mode, 'select')
  assert.equal(code(() => validateBindingBody({ mode: 'new' })), 'invalid_request')
  assert.equal(code(() => validateBindingBody({ mode: 'new', workspaceId: 'w', cwd: '/tmp' })), 'invalid_request')
  assert.equal(code(() => validateBindingBody({ mode: 'select' })), 'invalid_request')
})

test('idempotency cache returns first entry within ttl and evicts', () => {
  let now = 0
  const cache = createIdempotencyCache({ ttlMs: 1000, maxEntries: 2, now: () => now })
  cache.set('a', 200, { ok: true })
  assert.equal(cache.get('a')?.status, 200)
  now = 1001
  assert.equal(cache.get('a'), undefined)
  cache.set('b', 200, {})
  cache.set('c', 200, {})
  cache.set('d', 200, {})
  assert.equal(cache.size(), 2)
})
