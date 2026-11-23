/**
 * `POST /commander/binding` wire tests (task-64): the settings picker must send
 * `{mode:'select', workspaceId, sessionId}` (plus a minted requestId) and surface
 * the contract failure envelope. The DOM flow is covered by the jsdom harness;
 * this pins the HTTP body without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { postBinding } from '../../src/client/state.ts'

interface Captured {
  url: string
  method: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

async function withFetch(
  responder: (url: string, init: RequestInit) => { ok: boolean; status: number; payload: unknown },
  run: (captured: Captured[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  const captured: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = (init?.headers ?? {}) as Record<string, string>
    captured.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
      headers,
    })
    const result = responder(url, init ?? {})
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.payload,
    } as unknown as Response
  }) as typeof fetch
  try {
    await run(captured)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('binding select posts workspaceId+sessionId with a requestId', async () => {
  await withFetch(
    () => ({ ok: true, status: 200, payload: { ok: true, binding: { sessionId: 'sess_10' }, commanderStatus: 'bound', rev: 9 } }),
    async captured => {
      const result = await postBinding('', { mode: 'select', workspaceId: 'ws_1', sessionId: 'sess_10' })
      assert.equal(result.ok, true)
      assert.equal(captured.length, 1)
      const call = captured[0]!
      assert.equal(call.url, '/commander/binding')
      assert.equal(call.method, 'POST')
      assert.equal(call.body.mode, 'select')
      assert.equal(call.body.workspaceId, 'ws_1')
      assert.equal(call.body.sessionId, 'sess_10')
      assert.match(String(call.body.requestId), /^[A-Za-z0-9_-]{8,64}$/u)
    },
  )
})

test('binding new keeps the agentPreset field when provided', async () => {
  await withFetch(
    () => ({ ok: true, status: 200, payload: { ok: true, binding: { sessionId: 'sess_new' }, rev: 10 } }),
    async captured => {
      await postBinding('', { mode: 'new', workspaceId: 'ws_1', agentPreset: 'standard' })
      const call = captured[0]!
      assert.equal(call.body.mode, 'new')
      assert.equal(call.body.workspaceId, 'ws_1')
      assert.equal(call.body.agentPreset, 'standard')
      assert.equal('sessionId' in call.body, false)
    },
  )
})

test('binding select surfaces the contract failure envelope', async () => {
  await withFetch(
    () => ({ ok: false, status: 409, payload: { ok: false, code: 'workspace_conflict', message: '会话不属于该工作区' } }),
    async () => {
      const result = await postBinding('', { mode: 'select', workspaceId: 'ws_1', sessionId: 'sess_other' })
      assert.equal(result.ok, false)
      assert.equal(result.ok === false ? result.failure.code : '', 'workspace_conflict')
      assert.equal(result.ok === false ? result.failure.message : '', '会话不属于该工作区')
    },
  )
})
