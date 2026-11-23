// 回归：sessions 服务返回 live Session（无 events 字段），必须经 snapshotEvents()/sessionQuery 读事件，
// 否则 turn/end 注入永远拿到空事件 →「[session-reply] 本轮无文本回复」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isRootSession, normalizeSessionHeader, readSessionEvents } from '../../src/host/session/session-records.ts'
import { createFakeCtx } from '../fakes/fakes.ts'

const EVENTS = [
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '工作完成' }] } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

test('live Session（只有 snapshotEvents，没有 events）也能读到事件', async () => {
  const ctx = createFakeCtx({ services: { sessions: { get: async () => ({ id: 's1', snapshotEvents: () => EVENTS }) } } })
  assert.deepEqual(await readSessionEvents(ctx, 's1'), EVENTS)
})

test('优先走 sessionQuery.readSession（冷会话也能读），失败回退 live', async () => {
  const queried: string[] = []
  const ctx = createFakeCtx({
    services: {
      sessionQuery: { readSession: async (id: string) => { queried.push(id); return { events: EVENTS } } },
      sessions: { get: async () => ({ id: 's1', snapshotEvents: () => [] }) },
    },
  })
  assert.deepEqual(await readSessionEvents(ctx, 's1'), EVENTS)
  assert.deepEqual(queried, ['s1'])

  const fallback = createFakeCtx({
    services: {
      sessionQuery: { readSession: async () => { throw new Error('SESSION_QUERY_CORRUPT_SESSION') } },
      sessions: { get: async () => ({ id: 's1', snapshotEvents: () => EVENTS }) },
    },
  })
  assert.deepEqual(await readSessionEvents(fallback, 's1'), EVENTS)
})

test('旧宿主/测试 fake 的 events 数组仍兼容；缺服务返回空数组', async () => {
  const legacy = createFakeCtx({ services: { sessions: { get: async () => ({ id: 's1', events: EVENTS }) } } })
  assert.deepEqual(await readSessionEvents(legacy, 's1'), EVENTS)
  assert.deepEqual(await readSessionEvents(createFakeCtx({}), 's1'), [])
  assert.deepEqual(await readSessionEvents(legacy, ''), [])
})

test('isRootSession：排除子代理、teammate（parentSession）与指挥官会话', () => {
  const root = normalizeSessionHeader({ id: 's-root', cwd: '/tmp/a', createdAt: 1 })
  const child = normalizeSessionHeader({ id: 's-child', cwd: '/tmp/a', createdAt: 1, origin: 'subagent' })
  const teammate = normalizeSessionHeader({ id: 's-teammate', cwd: '/tmp/a', createdAt: 1, parentSession: { id: 's-root' } })
  const teammateFlat = normalizeSessionHeader({ id: 's-teammate-2', cwd: '/tmp/a', createdAt: 1, parentSession: 's-root' })
  assert.ok(root !== undefined && child !== undefined && teammate !== undefined && teammateFlat !== undefined)
  assert.equal(isRootSession(root), true)
  assert.equal(isRootSession(child), false)
  assert.equal(isRootSession(teammate), false)
  assert.equal(isRootSession(teammateFlat), false)
  assert.equal(isRootSession(root, 's-root'), false, '指挥官会话本身不算可 attach 的根会话')
  assert.equal(root.parentSessionId, undefined)
  assert.equal(teammate.parentSessionId, 's-root')
  assert.equal(teammateFlat.parentSessionId, 's-root')
})
