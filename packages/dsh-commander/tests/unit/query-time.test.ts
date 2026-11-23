// 时间参数解析（task-query-design §4）：人类可读格式 → epoch ms；纯函数、时区安全。
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatLocalDateTime, parseTimeBound } from '../../src/host/query/time-input.ts'

const localMs = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number => new Date(y, m - 1, d, h, mi, s, ms).getTime()

const valueOf = (raw: unknown, bound: 'from' | 'to'): number => {
  const parsed = parseTimeBound(raw, bound)
  assert.ok(parsed !== undefined, `expected a parse result for ${String(raw)}`)
  assert.equal(parsed.ok, true, `expected ok for ${String(raw)}: ${parsed.ok ? '' : parsed.message}`)
  return parsed.ok ? parsed.value : Number.NaN
}

const messageOf = (raw: unknown, bound: 'from' | 'to' = 'from'): string => {
  const parsed = parseTimeBound(raw, bound)
  assert.ok(parsed !== undefined)
  assert.equal(parsed.ok, false, `expected a parse error for ${String(raw)}`)
  return parsed.ok ? '' : parsed.message
}

test('absent bounds return undefined (no filter)', () => {
  assert.equal(parseTimeBound(undefined, 'from'), undefined)
  assert.equal(parseTimeBound(null, 'to'), undefined)
  assert.equal(parseTimeBound('', 'from'), undefined)
})

test('date-only since = local midnight; date-only until = next local midnight', () => {
  assert.equal(valueOf('2026-10-12', 'from'), localMs(2026, 10, 12))
  assert.equal(valueOf('2026-10-12', 'to'), localMs(2026, 10, 13))
  // 同一天的 since/until 合法且覆盖整整一天
  assert.ok(valueOf('2026-10-12', 'from') < valueOf('2026-10-12', 'to'))
})

test('minute / second / millisecond precision in local time', () => {
  assert.equal(valueOf('2026-10-12 14:40', 'from'), localMs(2026, 10, 12, 14, 40))
  assert.equal(valueOf('2026-10-12 14:40:30', 'from'), localMs(2026, 10, 12, 14, 40, 30))
  assert.equal(valueOf('2026-10-12 14:40:30.250', 'from'), localMs(2026, 10, 12, 14, 40, 30, 250))
})

test('T separator is accepted', () => {
  assert.equal(valueOf('2026-10-12T14:40', 'from'), localMs(2026, 10, 12, 14, 40))
  assert.equal(valueOf('2026-10-12T14:40:30', 'from'), localMs(2026, 10, 12, 14, 40, 30))
})

test('explicit timezone suffix wins over local timezone', () => {
  assert.equal(valueOf('2026-10-12T14:40:00Z', 'from'), Date.UTC(2026, 9, 12, 14, 40))
  assert.equal(valueOf('2026-10-12 14:40+08:00', 'from'), Date.UTC(2026, 9, 12, 14, 40) - 8 * 3_600_000)
  assert.equal(valueOf('2026-10-12 14:40-05:30', 'from'), Date.UTC(2026, 9, 12, 14, 40) + 5.5 * 3_600_000)
})

test('rejects impossible calendar dates and out-of-range components', () => {
  assert.match(messageOf('2026-02-30'), /有效|日期/)
  assert.match(messageOf('2026-13-01'), /有效|日期|月/)
  assert.match(messageOf('2026-10-12 25:00'), /有效|小时|时间/)
  assert.match(messageOf('2026-10-12 14:60'), /有效|分钟|时间/)
  assert.match(messageOf('1969-12-31'), /年/)
  assert.match(messageOf('2101-01-01'), /年/)
})

test('rejects time-only, epoch numbers and free text with actionable message', () => {
  assert.match(messageOf('14:40'), /2026-10-12 14:40/)
  assert.match(messageOf(1764000000000), /2026-10-12 14:40/)
  assert.match(messageOf('昨天'), /2026-10-12 14:40/)
})

test('formatLocalDateTime renders YYYY-MM-DD HH:mm', () => {
  assert.equal(formatLocalDateTime(localMs(2026, 10, 12, 14, 40)), '2026-10-12 14:40')
  assert.equal(formatLocalDateTime(localMs(2026, 1, 2, 3, 4)), '2026-01-02 03:04')
})
