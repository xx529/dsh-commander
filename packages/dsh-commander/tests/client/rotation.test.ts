// R1：客户端 rotation 状态（快照 / SSE / 归一化），契约 §7.2/§7.3。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, applySnapshot, createInitialState, normalizeFormerCommanders, normalizeRotation } from '../../src/client/state.ts'
import type { CommanderSnapshot } from '../../src/client/types.ts'

const rotation = {
  enabled: true,
  periodDays: 1,
  includeUserTail: true,
  generation: 3,
  startedAt: 1_700_000_000_000,
  dueAt: 1_700_086_400_000,
  due: false,
  rotating: false,
}

test('normalizeRotation: 非法输入返回 null，字段防御性回退', () => {
  assert.equal(normalizeRotation(undefined), null)
  assert.equal(normalizeRotation({}), null)
  const parsed = normalizeRotation({ enabled: true, periodDays: 3, includeUserTail: false, generation: 2, startedAt: 10, dueAt: 20, due: true, rotating: true, lastError: { code: 'rotation_failed', message: 'boom', at: 5 } })
  assert.deepEqual(parsed, {
    enabled: true,
    periodDays: 3,
    includeUserTail: false,
    generation: 2,
    startedAt: 10,
    dueAt: 20,
    due: true,
    rotating: true,
    lastError: { code: 'rotation_failed', message: 'boom', at: 5 },
  })
  // includeUserTail 缺省视为 true
  assert.equal(normalizeRotation({ enabled: false })?.includeUserTail, true)
})

test('normalizeFormerCommanders: 丢弃畸形行、上限 10', () => {
  const rows = normalizeFormerCommanders([
    { sessionId: 's1', generation: 1, startedAt: 1, retiredAt: 2 },
    { sessionId: '', generation: 2 },
    'nope',
    null,
    ...Array.from({ length: 12 }, (_, index) => ({ sessionId: `x${index}`, generation: index + 1, startedAt: 0, retiredAt: 0 })),
  ])
  assert.equal(rows.length, 10)
  assert.equal(rows[0]?.sessionId, 's1')
})

test('applySnapshot 带上 rotation / formerCommanders；缺省时为空', () => {
  const snapshot: CommanderSnapshot = {
    rev: 4,
    rotation,
    formerCommanders: [{ sessionId: 'old', generation: 2, startedAt: 1, retiredAt: 2 }],
  }
  const next = applySnapshot(createInitialState(), snapshot)
  assert.equal(next.rotation?.generation, 3)
  assert.equal(next.formerCommanders.length, 1)
  const empty = applySnapshot(createInitialState(), { rev: 1 })
  assert.equal(empty.rotation, null)
  assert.deepEqual(empty.formerCommanders, [])
})

test('rotation.updated 事件更新状态；陈旧 rev 被丢弃', () => {
  const state = { ...createInitialState(), rev: 10 }
  const frame = {
    event: 'rotation.updated',
    data: JSON.stringify({
      rotation: { ...rotation, generation: 4 },
      formerCommanders: [{ sessionId: 'old', generation: 3, startedAt: 1, retiredAt: 2 }],
      rev: 11,
    }),
    id: '11',
  }
  const next = applyEvent(state, frame)
  assert.equal(next.rev, 11)
  assert.equal(next.rotation?.generation, 4)
  assert.equal(next.formerCommanders[0]?.generation, 3)
  const stale = applyEvent(next, { ...frame, id: '9', data: JSON.stringify({ rotation: { ...rotation, generation: 9 }, rev: 9 }) })
  assert.equal(stale.rotation?.generation, 4)
})

test('rotation.updated: rotating 相位不改变 due/generation 语义', () => {
  const state = { ...createInitialState(), rev: 1 }
  const next = applyEvent(state, {
    event: 'rotation.updated',
    data: JSON.stringify({ rotation: { ...rotation, rotating: true, due: true } }),
    id: '2',
  })
  assert.equal(next.rotation?.rotating, true)
  assert.equal(next.rotation?.due, true)
})
