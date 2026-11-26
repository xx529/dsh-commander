import test from 'node:test'
import assert from 'node:assert/strict'
import { createWindowPage } from '../../src/host/native/window-page.ts'

const BUNDLE = 'window.__x = 1'

test('window page requires the exact token', () => {
  const page = createWindowPage({ token: 'abc123', readBundle: () => BUNDLE })
  assert.equal(page.html('/commander/window'), null)
  assert.equal(page.html('/commander/window?token=nope'), null)
  const html = page.html('/commander/window?token=abc123')
  assert.ok(html !== null)
  assert.match(html, /window\.__x = 1/)
  assert.match(html, /__COMMANDER_SHELL__/)
})

test('window page escapes closing script tags in the bundle', () => {
  const page = createWindowPage({ token: 't', readBundle: () => 'var a = "</script>"' })
  const html = page.html('/commander/window?token=t') ?? ''
  assert.ok(html.includes('<\\/script>'))
  assert.equal((html.match(/<\/script>/g) ?? []).length, 3) // diagnostics + boot + bundle
})

test('window page caches the rendered html and defaults locale to zh', () => {
  let reads = 0
  const page = createWindowPage({ token: 't', readBundle: () => { reads += 1; return BUNDLE } })
  const first = page.html('/commander/window?token=t')
  const second = page.html('/commander/window?token=t')
  assert.equal(first, second)
  assert.equal(reads, 1)
  assert.match(first ?? '', /lang="zh"/)
})

test('window page passes a valid role through to the boot payload', () => {
  const page = createWindowPage({ token: 't', readBundle: () => BUNDLE })
  const ball = page.html('/commander/window?token=t&role=ball') ?? ''
  assert.match(ball, /"role":"ball"/)
  const panel = page.html('/commander/window?token=t&panel=1&role=panel') ?? ''
  assert.match(panel, /"role":"panel"/)
  assert.match(panel, /"panel":true/)
  const bubble = page.html('/commander/window?token=t&role=bubble') ?? ''
  assert.match(bubble, /"role":"bubble"/)
  // 气泡窗加载失败时不能出现 fallback 球（否则气泡窗里会有一颗假球）。
  assert.equal(bubble.includes('__fallback_ball'), false)
})

test('window page ignores an unknown role and falls back to the single-window mode', () => {
  const page = createWindowPage({ token: 't', readBundle: () => BUNDLE })
  const html = page.html('/commander/window?token=t&role=session') ?? ''
  assert.match(html, /"role":""/)
})

test('window page caches per role so the ball and panel windows get distinct pages', () => {
  let reads = 0
  const page = createWindowPage({ token: 't', readBundle: () => { reads += 1; return BUNDLE } })
  const ball = page.html('/commander/window?token=t&role=ball')
  const panel = page.html('/commander/window?token=t&panel=1&role=panel')
  assert.notEqual(ball, panel)
  assert.equal(reads, 1)
  assert.equal(page.html('/commander/window?token=t&role=ball'), ball)
})
