/**
 * Readable session-row helpers for the settings binding picker (task-66).
 *
 * `GET /commander/sessions` may omit `title`/`createdAt` and its
 * `lastActiveAt` may be zero; the picker must still render a recognizable row
 * (unnamed session + short id + relative time + context level) and map binding
 * failures to readable copy while keeping the Host error code.
 *
 * Pure so `tests/client/session-display.test.ts` can pin the formatting.
 */
import type { ApiFailure } from './types'

/** Locale translate function supplied by the settings section. */
export type Translate = (key: string) => string

/** Last `length` characters of a session id, prefixed with an ellipsis. */
export function shortSessionId(sessionId: string, length = 7): string {
  if (sessionId === '') return ''
  const tail = sessionId.length <= length ? sessionId : sessionId.slice(-length)
  return `…${tail}`
}

/**
 * Relative activity time: `刚刚` / `N 分钟前` / `N 小时前` / `N 天前` /
 * `N 个月前` / `N 年前`; '' when the Host sent no usable timestamp.
 */
export function formatRelativeActivity(at: number | undefined, now: number, t: Translate): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  const delta = Math.max(now - at, 0)
  const minute = 60 * 1_000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return t('time.justNow')
  if (delta < hour) return `${String(Math.floor(delta / minute))} ${t('time.minutesAgo')}`
  if (delta < day) return `${String(Math.floor(delta / hour))} ${t('time.hoursAgo')}`
  if (delta < 30 * day) return `${String(Math.floor(delta / day))} ${t('time.daysAgo')}`
  if (delta < 365 * day) return `${String(Math.floor(delta / (30 * day)))} ${t('time.monthsAgo')}`
  return `${String(Math.floor(delta / (365 * day)))} ${t('time.yearsAgo')}`
}

/** `创建于` stamp for a session row: `11/17 23:38`; '' when absent/invalid. */
export function formatSessionCreatedAt(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Locale key for one binding failure code (m2m3 §2.4 errors + transport codes). */
export function bindingErrorLabelKey(code: string | undefined): string {
  switch (code) {
    case 'not_found':
      return 'settings.binding.error.notFound'
    case 'workspace_conflict':
      return 'settings.binding.error.workspaceConflict'
    case 'preset_unknown':
      return 'settings.binding.error.presetUnknown'
    case 'create_failed':
      return 'settings.binding.error.createFailed'
    case 'storage_error':
      return 'settings.binding.error.storage'
    case 'route_missing':
      return 'settings.binding.error.routeMissing'
    default:
      return 'settings.binding.error.generic'
  }
}

/**
 * Readable failure line that keeps the Host code: `会话不存在…（not_found）`.
 * `invalid_request` has no fixed copy, so the Host message is shown verbatim
 * (the backend includes details such as "可用会话 N 个" for select failures).
 */
export function describeBindingFailure(failure: ApiFailure, t: Translate): string {
  const base = failure.code === 'invalid_request' && failure.message !== ''
    ? failure.message
    : t(bindingErrorLabelKey(failure.code))
  return `${base}（${failure.code}）`
}

/** Main-line title: named sessions keep their title; unnamed ones are labelled. */
export function sessionDisplayTitle(title: string | undefined, t: Translate): string {
  const trimmed = title === undefined ? '' : title.trim()
  return trimmed === '' ? t('settings.binding.unnamedSession') : trimmed
}

/** Whether a session row should be rendered in the muted "unnamed" style. */
export function isUnnamedSession(title: string | undefined): boolean {
  return title === undefined || title.trim() === ''
}
