import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovalBridge } from '../../src/host/native/approval-bridge.ts'

type Outcome = 'allowed-once' | 'rejected' | 'cancelled'

function setup(options: { timeoutMs?: number } = {}) {
  let listener: ((request: unknown, next: () => unknown) => unknown) | null = null
  let disposed = false
  const events: Array<{ event: string; payload: unknown }> = []
  const timers = new Map<number, { fn: () => void; at: number }>()
  let seq = 0
  let now = 0
  const bridge = createApprovalBridge({
    onRequest: (next) => {
      listener = next as unknown as (request: unknown, next: () => unknown) => unknown
      return () => { disposed = true }
    },
    emit: (event, payload) => events.push({ event, payload }),
    isShellFocused: () => true,
    now: () => now,
    timeoutMs: options.timeoutMs ?? 10_000,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (id) => { timers.delete(id as number) },
  })
  function tick(ms: number): void {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.fn()
      }
    }
  }
  return {
    bridge, events, tick,
    request: (request: Record<string, unknown>, next: () => unknown) => (listener as (r: unknown, n: () => unknown) => unknown)(request, next),
    isDisposed: () => disposed,
  }
}

function dshDeferred() {
  let resolve!: (value: Outcome) => void
  const promise = new Promise<Outcome>((res) => { resolve = res })
  return { promise, resolve }
}

test('approval bridge shows the request in the float and lets either side answer (float first)', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request({ toolName: 'bash', reason: 'rm -rf /' }, () => dsh.promise)
  const view = harness.events.find((entry) => entry.event === 'native.approval')?.payload as { id: string; canAnswer?: boolean; reason: string }
  assert.equal(view.canAnswer, true)
  assert.equal(view.reason, 'rm -rf /')
  assert.equal(harness.bridge.resolve(view.id, 'allowed-once'), true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(harness.bridge.list().length, 0)
  // DSH 侧仍挂起（由 signal/结算清理），不影响浮窗答案。
  dsh.resolve('rejected')
})

test('approval bridge lets the DSH side win the race and hides the float card', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  let delegated = 0
  const pending = harness.request({ toolName: 'bash' }, () => { delegated += 1; return dsh.promise })
  assert.equal(delegated, 1, 'DSH answerer must still be invoked')
  dsh.resolve('rejected')
  assert.equal(await pending, 'rejected')
  assert.equal(harness.bridge.list().length, 0)
  assert.ok(harness.events.some((entry) => entry.event === 'native.approval.resolved'))
})

test('approval bridge hides the float when the shell stops but keeps waiting for DSH', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request({ toolName: 'bash' }, () => dsh.promise)
  harness.bridge.onShellStatus({ phase: 'failed' })
  assert.equal(harness.bridge.list().length, 0)
  dsh.resolve('rejected')
  assert.equal(await pending, 'rejected')
})

test('approval bridge hides the float on timeout and keeps waiting for DSH', async () => {
  const harness = setup({ timeoutMs: 1_000 })
  const dsh = dshDeferred()
  const pending = harness.request({ toolName: 'bash' }, () => dsh.promise)
  harness.tick(1_001)
  assert.equal(harness.bridge.list().length, 0)
  dsh.resolve('rejected')
  assert.equal(await pending, 'rejected')
})

test('approval bridge rejects unknown outcomes and disposes cleanly', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request({ toolName: 'bash' }, () => dsh.promise)
  assert.equal(harness.bridge.resolve('missing', 'rejected'), false)
  harness.bridge.dispose()
  assert.equal(harness.isDisposed(), true)
  dsh.resolve('rejected')
  assert.equal(await pending, 'rejected')
})
