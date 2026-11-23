/**
 * `GET /commander/sessions` query tests (task-68): both pickers share
 * `fetchSessions`, so pinning the URL here covers the settings binding picker
 * and the M1R attach picker at once (limit=20 for big-workspace latency).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BINDING_SESSION_LIMIT, fetchSessions, normalizeSessionList } from '../../src/client/state.ts'

async function withFetch(
  responder: () => { ok: boolean; status: number; payload: unknown },
  run: (urls: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const result = responder()
    return { ok: result.ok, status: result.status, json: async () => result.payload } as unknown as Response
  }) as typeof fetch
  try {
    await run(urls)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('session pickers request limit=20 explicitly', () => {
  assert.equal(BINDING_SESSION_LIMIT, 20)
})

test('fetchSessions sends workspaceId and limit=20 and keeps truncated', async () => {
  await withFetch(
    () => ({
      ok: true,
      status: 200,
      payload: {
        ok: true,
        sessions: [{ sessionId: 'session-1', title: '导出会话', createdAt: 1, lastActiveAt: 2, contextUsage: 0.42 }],
        truncated: true,
        rev: 7,
      },
    }),
    async urls => {
      const result = await fetchSessions('', 'ws 1/x')
      assert.equal(result.ok, true)
      assert.equal(urls.length, 1)
      assert.equal(urls[0], '/commander/sessions?workspaceId=ws%201%2Fx&limit=20')
      const data = result.ok === true ? result.data : undefined
      assert.equal(data?.sessions.length, 1)
      assert.equal(data?.sessions[0]?.title, '导出会话')
      assert.equal(data?.sessions[0]?.createdAt, 1)
      assert.equal(data?.sessions[0]?.contextPct, 42)
      assert.equal(data?.truncated, true)
    },
  )
})

test('fetchSessions leaves truncated undefined when the Host did not cap', async () => {
  await withFetch(
    () => ({ ok: true, status: 200, payload: { ok: true, sessions: [{ sessionId: 's1', title: 't' }], truncated: false } }),
    async () => {
      const result = await fetchSessions('', 'ws_1')
      assert.equal(result.ok === true ? result.data.truncated : 'err', undefined)
    },
  )
})

test('fetchSessions surfaces the contract failure envelope', async () => {
  await withFetch(
    () => ({ ok: false, status: 404, payload: { ok: false, code: 'not_found', message: 'workspace missing' } }),
    async () => {
      const result = await fetchSessions('', 'ws_missing')
      assert.equal(result.ok, false)
      assert.equal(result.ok === false ? result.failure.code : '', 'not_found')
    },
  )
})

test('normalizeSessionList keeps the payload-level truncated flag', () => {
  assert.equal(normalizeSessionList({ sessions: [], truncated: true }).truncated, true)
  assert.equal(normalizeSessionList({ sessions: [] }).truncated, undefined)
})
