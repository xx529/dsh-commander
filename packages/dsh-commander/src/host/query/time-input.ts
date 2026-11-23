// 查询时间参数解析（task-query-design §4）：人类可读格式 → epoch ms。
// 零依赖纯函数；禁用 `new Date(string)` 的宽松解析（各引擎对 - / T / 时区处理不一致）。
const EXAMPLE = '2026-10-12 14:40'
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/

export type TimeBound = 'from' | 'to'
export type TimeParseResult = { ok: true; value: number } | { ok: false; message: string }

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

const formatError = (raw: string): TimeParseResult => ({
  ok: false,
  message: `无法解析时间 "${raw}"；请用 ${EXAMPLE} 或 2026-10-12 格式（本地时区，可带 Z/+08:00），不要传时间戳`,
})

const invalidDate = (raw: string): TimeParseResult => ({ ok: false, message: `"${raw}" 不是有效日期` })

const yearError = (): TimeParseResult => ({ ok: false, message: '年份需在 1970..2100 之间' })

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 本地时间构造 + 回读校验（不存在的本地时刻/非法日期直接拒绝）。 */
function localEpoch(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number): number | undefined {
  const at = new Date(year, month - 1, day, hour, minute, second, ms)
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return undefined
  if (at.getHours() !== hour || at.getMinutes() !== minute || at.getSeconds() !== second) return undefined
  return at.getTime()
}

/** 显式时区：先把字面量当 UTC 求 epoch，再按偏移换算，并校验日历合法性。 */
function offsetEpoch(
  year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number, zone: string,
): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour > 23 || minute > 59 || second > 59) return undefined
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const hours = Number(digits.slice(0, 2))
    const minutes = Number(digits.slice(2, 4))
    if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return undefined
    offsetMinutes = sign * (hours * 60 + minutes)
  }
  const at = utc - offsetMinutes * 60_000
  // 回读 UTC 分量：确认字面量是真实存在的时刻（如 2026-02-30 会被 Date.UTC 滚动）
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined
  return at
}

/**
 * 解析时间边界。
 * - 缺省（undefined/null/空白）返回 undefined；
 * - `from` 只写日期 = 当天 00:00；`to` 只写日期 = 次日 00:00（调用方用开区间即「含当天全天」）；
 * - 无时区后缀按 Host 本机时区解释。
 */
export function parseTimeBound(raw: unknown, bound: TimeBound): TimeParseResult | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') return formatError(String(raw))
  const text = raw.trim()
  if (text === '') return undefined

  const dateOnly = DATE_RE.exec(text)
  if (dateOnly !== null) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (year < 1970 || year > 2100) return yearError()
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return invalidDate(text)
    const targetDay = bound === 'to' ? day + 1 : day
    const value = localEpoch(year, month, targetDay, 0, 0, 0, 0)
    return value === undefined ? invalidDate(text) : { ok: true, value }
  }

  const parts = DATE_TIME_RE.exec(text)
  if (parts === null) return formatError(text)
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = parts[6] !== undefined ? Number(parts[6]) : 0
  const ms = parts[7] !== undefined ? Number(parts[7].padEnd(3, '0')) : 0
  const zone = parts[8]
  if (year < 1970 || year > 2100) return yearError()
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return invalidDate(text)
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, message: `"${text}" 不是有效时间（小时/分钟/秒超出范围）` }
  const value = zone !== undefined
    ? offsetEpoch(year, month, day, hour, minute, second, ms, zone)
    : localEpoch(year, month, day, hour, minute, second, ms)
  return value === undefined ? invalidDate(text) : { ok: true, value }
}

/** Host 本地时间 `YYYY-MM-DD HH:mm`（工具响应的 `now` 锚点）。 */
export function formatLocalDateTime(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
