// R1：轮换到点判定（自然日 00:00 对齐）与窗口起点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLocalDays, briefWindowStart, clampPeriodDays, resolveRotation, rotationDue, rotationDueAt, startOfLocalDay } from '../../src/host/rotation/config.ts'
import { defaultConfigRecord, type ConfigRecord } from '../../src/host/schema.ts'

const local = (month: number, day: number, hour = 0, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()

function resolved(overrides: Partial<ReturnType<typeof resolveRotation>> = {}) {
  return {
    enabled: true,
    periodDays: 1,
    includeUserTail: true,
    generation: 1,
    generationStartedAt: local(11, 23, 10, 45),
    configured: true,
    ...overrides,
  }
}

test('rotationDueAt: 本任开始日 + N 天的本地 00:00（不是 24h 后的同一时刻）', () => {
  const started = local(11, 23, 10, 45)
  assert.equal(rotationDueAt({ generationStartedAt: started, periodDays: 1 }), local(11, 24))
  assert.equal(rotationDueAt({ generationStartedAt: started, periodDays: 3 }), local(11, 26))
  assert.equal(rotationDueAt({ generationStartedAt: started, periodDays: 7 }), local(11, 30))
  // 恰好在 00:00 开始：N 天后 00:00
  assert.equal(rotationDueAt({ generationStartedAt: local(11, 23), periodDays: 1 }), local(11, 24))
  // 23:59 开始：次日 00:00（1 分钟后）到点，而不是 24h 后
  assert.equal(rotationDueAt({ generationStartedAt: local(11, 23, 23, 59), periodDays: 1 }), local(11, 24))
})

test('rotationDue: 过 00:00 前 false、过 00:00 后 true', () => {
  const late = local(11, 23, 23, 59)
  assert.equal(rotationDue(resolved({ generationStartedAt: late }), local(11, 23, 23, 59, 30)), false)
  assert.equal(rotationDue(resolved({ generationStartedAt: late }), local(11, 24, 0, 0, 1)), true)
  // 关闭态恒 false
  assert.equal(rotationDue(resolved({ generationStartedAt: late, enabled: false }), local(11, 24, 10)), false)
})

test('startOfLocalDay / addLocalDays：按日历日推进（不是固定毫秒）', () => {
  assert.equal(startOfLocalDay(local(11, 23, 10, 45)), local(11, 23))
  assert.equal(addLocalDays(local(11, 30), 1), local(12, 1))
  assert.equal(addLocalDays(local(12, 31), 1), new Date(2027, 0, 1).getTime())
})

test('briefWindowStart: 至少覆盖一个周期，本任更久则从本任起点', () => {
  const now = local(11, 23, 10, 45)
  assert.equal(briefWindowStart({ generationStartedAt: now - 30_000, periodDays: 1 }, now), now - 86_400_000)
  assert.equal(briefWindowStart({ generationStartedAt: now - 3 * 86_400_000, periodDays: 1 }, now), now - 3 * 86_400_000)
})

test('clampPeriodDays / resolveRotation: 1..7 夹紧，旧配置读取归一化', () => {
  assert.equal(clampPeriodDays(undefined), 1)
  assert.equal(clampPeriodDays(0), 1)
  assert.equal(clampPeriodDays(8), 7)
  assert.equal(clampPeriodDays(3.9), 3)
  const base: ConfigRecord = { ...defaultConfigRecord(2_000), updatedAt: 2_000 }
  const { rotation: _rotation, ...commander } = base.commander
  const parsed = resolveRotation({ ...base, commander })
  assert.equal(parsed.configured, false)
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.periodDays, 1)
  assert.equal(parsed.generationStartedAt, 2_000)
  // 旧配置没有 toolAudit 字段：默认开启（插件缺失时换代自动跳过）
  assert.equal(parsed.toolAudit, true)
})

test('resolveRotation: toolAudit 显式 false 生效；默认 true', () => {
  const base = defaultConfigRecord(2_000)
  const withFalse: ConfigRecord = {
    ...base,
    commander: {
      ...base.commander,
      rotation: { enabled: true, periodDays: 1, includeUserTail: true, toolAudit: false, generation: 1, generationStartedAt: 2_000 },
    },
  }
  assert.equal(resolveRotation(withFalse).toolAudit, false)
  assert.equal(resolveRotation(base).toolAudit, true)
})
