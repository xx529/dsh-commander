// R1：换代工具审计联动（dsh-trace-inspect 本机路由）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setSessionToolAudit, TOOL_AUDIT_PATH, type ToolAuditHttpResult } from '../../src/host/rotation/tool-audit.ts'

interface Call {
  url: URL
  body: string
  timeoutMs: number
}

function fakeRequest(handler: (url: URL, body: string) => ToolAuditHttpResult | Error): { request: (url: URL, body: string, timeoutMs: number) => Promise<ToolAuditHttpResult>; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    request: async (url, body, timeoutMs) => {
      calls.push({ url, body, timeoutMs })
      const result = handler(url, body)
      if (result instanceof Error) throw result
      return result
    },
  }
}

test('setSessionToolAudit: POST 到本机路由，带 sessionId 与 enabled', async () => {
  const { request, calls } = fakeRequest(() => ({ status: 200, body: '{"enabled":true,"sealed":false}' }))
  const result = await setSessionToolAudit({ origin: 'http://127.0.0.1:51234/?token=abc', sessionId: 'session-x', enabled: true, request })
  assert.deepEqual(result, { status: 'ok', enabled: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.origin, 'http://127.0.0.1:51234')
  assert.equal(calls[0]!.url.pathname, TOOL_AUDIT_PATH)
  assert.equal(calls[0]!.url.searchParams.get('sessionId'), 'session-x')
  assert.deepEqual(JSON.parse(calls[0]!.body), { enabled: true })
  assert.equal(calls[0]!.timeoutMs, 3_000)
})

test('setSessionToolAudit: 404 = 插件未安装/未启用（静默不可用）；409 = 已封存', async () => {
  const missing = fakeRequest(() => ({ status: 404, body: '{"error":"session not found"}' }))
  assert.deepEqual(await setSessionToolAudit({ origin: 'http://127.0.0.1:1', sessionId: 's', enabled: true, request: missing.request }), { status: 'unavailable' })
  const sealed = fakeRequest(() => ({ status: 409, body: '{"error":"sealed"}' }))
  assert.deepEqual(await setSessionToolAudit({ origin: 'http://127.0.0.1:1', sessionId: 's', enabled: true, request: sealed.request }), { status: 'sealed' })
})

test('setSessionToolAudit: 其它非 2xx / 网络错误 = failed（不抛错）', async () => {
  const serverError = fakeRequest(() => ({ status: 500, body: '' }))
  assert.deepEqual(await setSessionToolAudit({ origin: 'http://127.0.0.1:1', sessionId: 's', enabled: true, request: serverError.request }), {
    status: 'failed',
    message: 'HTTP 500',
  })
  const network = fakeRequest(() => new Error('ECONNREFUSED'))
  const failed = await setSessionToolAudit({ origin: 'http://127.0.0.1:1', sessionId: 's', enabled: true, request: network.request })
  assert.equal(failed.status, 'failed')
  assert.match(failed.status === 'failed' ? failed.message : '', /ECONNREFUSED/)
})

test('setSessionToolAudit: 响应缺少 enabled 时回显请求值', async () => {
  const { request } = fakeRequest(() => ({ status: 200, body: '{}' }))
  assert.deepEqual(await setSessionToolAudit({ origin: 'http://127.0.0.1:1', sessionId: 's', enabled: false, request }), { status: 'ok', enabled: false })
})

test('setSessionToolAudit: 默认传输直连本机回环（node:http）', async () => {
  const seen: Array<{ method?: string; url?: string; body: string }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end('{"enabled":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    const port = (server.address() as AddressInfo).port
    const result = await setSessionToolAudit({ origin: `http://127.0.0.1:${port}`, sessionId: 'session-live', enabled: true })
    assert.deepEqual(result, { status: 'ok', enabled: true })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.method, 'POST')
    assert.equal(seen[0]!.url, `${TOOL_AUDIT_PATH}?sessionId=session-live`)
    assert.deepEqual(JSON.parse(seen[0]!.body), { enabled: true })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
