import test from 'node:test'
import assert from 'node:assert/strict'
import { createSseHub } from '../../src/host/api/sse.ts'
import type { HttpResponseLike } from '../../src/host/dsh-types.ts'

function fakeRes() {
  const chunks: string[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const res: HttpResponseLike & { headers: Record<string, string>; statusCode: number } = {
    statusCode: 0,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value
    },
    write(chunk: string) {
      chunks.push(String(chunk))
      return true
    },
    end() {
      for (const listener of listeners.get('close') ?? []) listener()
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
  } as never
  return { res, chunks }
}

test('sse hub sends snapshot first with id == snapshot rev, broadcasts from rev+1, disposes with bye', () => {
  const hub = createSseHub({ setIntervalFn: () => 0, clearIntervalFn: () => {} })
  const { res, chunks } = fakeRes()
  const snapshot = { rev: 0, hello: true }
  hub.attach(res, snapshot)
  assert.match(chunks[0] ?? '', /event: snapshot/)
  // M6：首帧 id 必须等于快照 rev（不能先 +1）
  assert.match(chunks[0] ?? '', /^event: snapshot\nid: 0\n/m)
  assert.equal(hub.rev, 0)
  hub.broadcast('commander.message', { messageId: 'm1' })
  assert.equal(hub.rev, 1)
  const last = chunks.at(-1) ?? ''
  assert.match(last, /event: commander\.message/)
  assert.match(last, new RegExp(`id: 1`))
  hub.dispose()
  assert.match(chunks.at(-1) ?? '', /event: bye/)
  assert.equal(hub.clientCount(), 0)
})

test('sse heartbeat uses injected interval and broadcasts heartbeat', () => {
  let tick: (() => void) | undefined
  const hub = createSseHub({ setIntervalFn: (fn) => { tick = fn; return 1 }, clearIntervalFn: () => {} })
  const { res, chunks } = fakeRes()
  hub.attach(res, { rev: 0 })
  tick?.()
  assert.match(chunks.at(-1) ?? '', /event: heartbeat/)
  hub.dispose()
})
