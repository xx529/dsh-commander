import test from 'node:test'
import assert from 'node:assert/strict'
import { callJev, resolveJevKey } from '../../src/host/jev/client.ts'

const previousKey = process.env.JEV_TEST_KEY
const config = { endpoint: 'https://example.test/v1/systemone', model: 'jev-latest', envVar: 'JEV_TEST_KEY', timeoutMs: 1500 }
const okResponse = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response

test('resolveJevKey reads configured env then TYPESAFE_API_KEY fallback', () => {
  assert.deepEqual(resolveJevKey('JEV_TEST_KEY', { JEV_TEST_KEY: 'k1' }), { key: 'k1', envVar: 'JEV_TEST_KEY' })
  assert.deepEqual(resolveJevKey('JEV_TEST_KEY', { TYPESAFE_API_KEY: 'k2' }), { key: 'k2', envVar: 'TYPESAFE_API_KEY' })
  assert.deepEqual(resolveJevKey('JEV_TEST_KEY', {}), { key: null, envVar: 'JEV_TEST_KEY' })
})

test('callJev returns no_key without issuing a request', async () => {
  const original = process.env.JEV_MISSING_KEY
  delete process.env.JEV_MISSING_KEY
  const result = await callJev({ ...config, envVar: 'JEV_MISSING_KEY' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'no_key')
  if (original !== undefined) process.env.JEV_MISSING_KEY = original
})

test('callJev parses a successful response', async () => {
  process.env.JEV_TEST_KEY = 'secret'
  const result = await callJev(config, { any: true }, {
    fetchImpl: (async () =>
      okResponse({ answers: { workspace: { choice: 'w_0', probabilities: { w_0: 0.9 }, confidence: 0.8 } } })) as unknown as typeof fetch,
  })
  assert.equal(result.ok, true)
  assert.equal(result.response?.answers.workspace?.choice, 'w_0')
  if (previousKey === undefined) delete process.env.JEV_TEST_KEY
})

test('callJev retries 429 once and then succeeds; 429 twice surfaces rate_limit', async () => {
  process.env.JEV_TEST_KEY = 'secret'
  let calls = 0
  const success = await callJev(config, {}, {
    sleep: async () => undefined,
    fetchImpl: (async () => {
      calls += 1
      return calls === 1 ? okResponse({ error: 'rate' }, 429) : okResponse({ answers: { workspace: { choice: 'a', probabilities: { a: 1 }, confidence: 0.5 } } })
    }) as unknown as typeof fetch,
  })
  assert.equal(success.ok, true)
  assert.equal(calls, 2)
  let retried = 0
  const rateLimited = await callJev(config, {}, {
    sleep: async () => undefined,
    fetchImpl: (async () => {
      retried += 1
      return okResponse({ error: 'rate' }, 429)
    }) as unknown as typeof fetch,
  })
  assert.equal(rateLimited.ok, false)
  assert.equal(rateLimited.error?.code, 'rate_limit')
  assert.equal(retried, 2)
  if (previousKey === undefined) delete process.env.JEV_TEST_KEY
})

test('callJev does not retry 4xx and classifies auth', async () => {
  process.env.JEV_TEST_KEY = 'secret'
  let calls = 0
  const result = await callJev(config, {}, {
    fetchImpl: (async () => {
      calls += 1
      return okResponse({ error: 'invalid key' }, 401)
    }) as unknown as typeof fetch,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'auth')
  assert.equal(calls, 1)
  if (previousKey === undefined) delete process.env.JEV_TEST_KEY
})

test('callJev classifies timeout and malformed responses', async () => {
  process.env.JEV_TEST_KEY = 'secret'
  const timeout = await callJev(config, {}, {
    fetchImpl: (async () => {
      throw new Error('The operation was aborted due to timeout')
    }) as unknown as typeof fetch,
  })
  assert.equal(timeout.error?.code, 'timeout')
  const bad = await callJev(config, {}, {
    fetchImpl: (async () => okResponse({ result: 'nope' })) as unknown as typeof fetch,
  })
  assert.equal(bad.error?.code, 'bad_response')
  if (previousKey === undefined) delete process.env.JEV_TEST_KEY
})
