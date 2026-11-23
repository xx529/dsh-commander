import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuestionBridge } from '../../src/host/native/question-bridge.ts'

function setup(options: { timeoutMs?: number } = {}) {
  let listener: ((request: unknown, next: () => unknown) => unknown) | null = null
  let disposed = false
  const events: Array<{ event: string; payload: unknown }> = []
  const timers = new Map<number, { fn: () => void; at: number }>()
  let seq = 0
  let now = 0
  const bridge = createQuestionBridge({
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

const batch = {
  questions: [
    { id: 'q1', question: '你主要拿这个指挥官做什么？', header: '使用场景', options: [{ label: '技术调研', description: '库/框架' }, { label: '信息收集' }], multiSelect: true },
    { id: 'q2', question: '需要我在每次交付后主动提下一步吗？', options: [{ label: '需要' }, { label: '不需要' }] },
  ],
}

function dshDeferred() {
  let resolve!: (value: { answers: Array<{ id: string; selected: string[] }> }) => void
  const promise = new Promise<{ answers: Array<{ id: string; selected: string[] }> }>((res) => { resolve = res })
  return { promise, resolve }
}

test('question bridge shows the batch in the float and lets the float answer first', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request(batch, () => dsh.promise)
  const view = harness.events.find((entry) => entry.event === 'native.question')?.payload as { id: string; canAnswer?: boolean; questions: unknown[] }
  assert.equal(view.canAnswer, true)
  assert.equal(view.questions.length, 2)
  const answer = {
    answers: [
      { id: 'q1', selected: ['技术调研'], custom: '补充' },
      { id: 'q2', selected: ['需要'] },
    ],
  }
  assert.deepEqual(harness.bridge.resolve(view.id, answer), answer)
  assert.deepEqual(await pending, answer)
  assert.equal(harness.bridge.list().length, 0)
  dsh.resolve({ answers: [] })
})

test('question bridge lets the DSH side win and hides the float card', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request(batch, () => dsh.promise)
  const dshAnswer = { answers: [{ id: 'q1', selected: ['信息收集'] }, { id: 'q2', selected: [] }] }
  dsh.resolve(dshAnswer)
  assert.deepEqual(await pending, dshAnswer)
  assert.equal(harness.bridge.list().length, 0)
})

test('question bridge rejects malformed answers but keeps the batch pending', async () => {
  const harness = setup()
  const dsh = dshDeferred()
  const pending = harness.request(batch, () => dsh.promise)
  const view = harness.events[0]?.payload as { id: string }
  assert.equal(harness.bridge.resolve(view.id, { answers: [] }), null)
  assert.equal(harness.bridge.resolve(view.id, { answers: [{ id: 'q1', selected: ['不存在'] }, { id: 'q2', selected: [] }] }), null)
  assert.equal(harness.bridge.list().length, 1)
  dsh.resolve({ answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })
})

test('question bridge hides the float on timeout / dispose but keeps waiting for DSH', async () => {
  const harness = setup({ timeoutMs: 1_000 })
  const dsh = dshDeferred()
  const pending = harness.request(batch, () => dsh.promise)
  harness.tick(1_001)
  assert.equal(harness.bridge.list().length, 0)
  dsh.resolve({ answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: [] }, { id: 'q2', selected: [] }] })

  const second = setup()
  const dsh2 = dshDeferred()
  const pending2 = second.request(batch, () => dsh2.promise)
  second.bridge.dispose()
  assert.equal(second.isDisposed(), true)
  assert.equal(second.bridge.list().length, 0)
  dsh2.resolve({ answers: [] })
  assert.deepEqual(await pending2, { answers: [] })
})
