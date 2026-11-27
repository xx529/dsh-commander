// 换代/绑定后定时任务跟随迁移：把 target 精确指向旧 commander 会话的 schedule 改写到新会话。
// 口径：docs/architecture/rotation-schedule-migration.md。零 DSH import；只走 ctx.get('schedule') 的结构化最小面。
import { SCHEDULE_MIGRATION_TIMEOUT_MS } from '../config.ts'
import type { CordisContext, ScheduleEditRequestLike, ScheduleEntryLike, ScheduleServiceLike } from '../dsh-types.ts'

export type ScheduleMigrationStatus = 'ok' | 'partial' | 'failed' | 'skipped' | 'unavailable' | 'timeout'

/** 各类跳过计数（用于日志/UI 解释「为什么没迁」）。 */
export interface ScheduleMigrationSkipped {
  /** ended 任务；includeEnded=false 时跳过。 */
  ended: number
  /** 并发删除/归档；edit 返回 schedule_not_found。 */
  gone: number
  /** 用户已把 target 改走；CAS 重读后不再匹配。 */
  changed: number
  /** 旧 sessionId 不在本插件 commander link 里（scope 守卫）。 */
  notCommander: number
  /** 迁移前发现当前绑定已不是新会话（并发 bind/rotate）。 */
  staleBinding: number
  /** scope 守卫回调抛错。 */
  guardError: number
  /** catalog 里形状不合法的条目。 */
  malformed: number
}

export interface ScheduleMigrationFailure {
  /** 任务 id；整体失败（catalog/timeout）时为空串。 */
  id: string
  code: string
}

export interface ScheduleMigrationResult {
  status: ScheduleMigrationStatus
  fromSessionId: string
  toSessionId: string
  scanned: number
  matched: number
  migrated: number
  skipped: ScheduleMigrationSkipped
  failed: ScheduleMigrationFailure[]
  durationMs: number
}

export interface ScheduleMigrationLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface ScheduleMigrationInput {
  ctx: CordisContext
  /** 被替换掉的旧 commander sessionId。 */
  fromSessionId: string
  /** 新 commander sessionId。 */
  toSessionId: string
  /** scope 守卫：旧 id 必须仍是本插件登记的 commander link。 */
  isCommanderSession?: (sessionId: string) => boolean
  /** 并发守卫：迁移时当前绑定必须已经是 to。 */
  isCurrentCommander?: (sessionId: string) => boolean
  /** 是否迁移 ended 任务（默认 true；只改 target，不会复活）。 */
  includeEnded?: boolean
  /** 传给 schedule.edit 的 actor；缺省 = toSessionId（让变更通知落旧会话，避免污染新指挥官上下文）。 */
  actorSessionId?: string
  /** 总超时；缺省 SCHEDULE_MIGRATION_TIMEOUT_MS。 */
  timeoutMs?: number
  now?: () => number
  logger?: ScheduleMigrationLogger
}

const emptySkipped = (): ScheduleMigrationSkipped => ({
  ended: 0,
  gone: 0,
  changed: 0,
  notCommander: 0,
  staleBinding: 0,
  guardError: 0,
  malformed: 0,
})

/** 供接线层在迁移函数意外抛错时构造一个不会阻断绑定的结果。 */
export function scheduleMigrationFailure(fromSessionId: string, toSessionId: string, code: string): ScheduleMigrationResult {
  return {
    status: 'failed',
    fromSessionId,
    toSessionId,
    scanned: 0,
    matched: 0,
    migrated: 0,
    skipped: emptySkipped(),
    failed: [{ id: '', code }],
    durationMs: 0,
  }
}

class ScheduleMigrationTimeoutError extends Error {
  readonly code = 'timeout'
  constructor(label: string) {
    super(`${label} timed out`)
    this.name = 'ScheduleMigrationTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new ScheduleMigrationTimeoutError(label))
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScheduleMigrationTimeoutError(label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function readScheduleService(ctx: CordisContext): ScheduleServiceLike | undefined {
  let raw: unknown
  try {
    raw = ctx.get('schedule')
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const candidate = raw as { catalog?: unknown; edit?: unknown; view?: unknown }
  if (typeof candidate.catalog !== 'function' || typeof candidate.edit !== 'function') return undefined
  return raw as unknown as ScheduleServiceLike
}

function isEntry(value: unknown): value is ScheduleEntryLike {
  if (value === null || typeof value !== 'object') return false
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id !== ''
}

/** 只认 target.kind==='session' 且 sessionId 精确匹配；new_once/new 及别的会话一律不碰。 */
function isFromTarget(entry: ScheduleEntryLike, fromSessionId: string): boolean {
  const target = entry.target
  if (target === null || typeof target !== 'object') return false
  const kind = (target as { kind?: unknown }).kind
  const sessionId = (target as { sessionId?: unknown }).sessionId
  return kind === 'session' && sessionId === fromSessionId
}

function targetDebug(entry: ScheduleEntryLike): string {
  const target = entry.target
  if (target === null || typeof target !== 'object') return 'unknown'
  const kind = (target as { kind?: unknown }).kind
  const sessionId = (target as { sessionId?: unknown }).sessionId
  return `${typeof kind === 'string' ? kind : 'unknown'}:${typeof sessionId === 'string' ? sessionId : '-'}`
}

function codeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return 'unknown_error'
}

/**
 * 把旧 commander 会话名下的 schedule 逐个改到新会话。
 *
 * 幂等：只匹配当前 target === from；成功项不会再被匹配。并发安全：带 expectedUpdatedAt，
 * 冲突时重读一次；删除/归档导致的 not_found 视为跳过。永不抛错（scope/服务/超时都落成结果），
 * 由接线层决定是否告警，不阻断换代或绑定。
 */
export async function migrateCommanderSchedules(input: ScheduleMigrationInput): Promise<ScheduleMigrationResult> {
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const timeoutMs = input.timeoutMs ?? SCHEDULE_MIGRATION_TIMEOUT_MS
  const deadline = startedAt + timeoutMs
  const logger = input.logger ?? input.ctx.logger
  const result: ScheduleMigrationResult = {
    status: 'ok',
    fromSessionId: input.fromSessionId,
    toSessionId: input.toSessionId,
    scanned: 0,
    matched: 0,
    migrated: 0,
    skipped: emptySkipped(),
    failed: [],
    durationMs: 0,
  }
  let timedOut = false

  const finish = (status: ScheduleMigrationStatus): ScheduleMigrationResult => {
    result.status = status
    result.durationMs = now() - startedAt
    const summary = {
      from: result.fromSessionId,
      to: result.toSessionId,
      status,
      scanned: result.scanned,
      matched: result.matched,
      migrated: result.migrated,
      skipped: result.skipped,
      failed: result.failed.length,
      durationMs: result.durationMs,
    }
    if (result.failed.length > 0 || status === 'failed' || status === 'timeout' || status === 'partial') {
      logger?.warn?.(`[commander] schedule migration ${JSON.stringify(summary)}`)
    } else {
      logger?.info?.(`[commander] schedule migration ${JSON.stringify(summary)}`)
    }
    return result
  }

  const run = async (): Promise<ScheduleMigrationResult> => {
    const from = input.fromSessionId
    const to = input.toSessionId
    if (from === '' || to === '' || from === to) {
      logger?.debug?.(`[commander] schedule migration skipped { reason: 'empty_or_same', from: ${from || '-'}, to: ${to || '-'} }`)
      return finish('skipped')
    }

    try {
      if (input.isCommanderSession !== undefined && !input.isCommanderSession(from)) {
        result.skipped.notCommander += 1
        logger?.debug?.(`[commander] schedule migration skipped { reason: 'from_not_commander', from: ${from} }`)
        return finish('skipped')
      }
      if (input.isCurrentCommander !== undefined && !input.isCurrentCommander(to)) {
        result.skipped.staleBinding += 1
        logger?.debug?.(`[commander] schedule migration skipped { reason: 'binding_moved', from: ${from}, to: ${to} }`)
        return finish('skipped')
      }
    } catch (error: unknown) {
      result.skipped.guardError += 1
      logger?.warn?.(`[commander] schedule migration skipped { reason: 'guard_failed', code: ${errorCode(error)} }`)
      return finish('skipped')
    }

    const service = readScheduleService(input.ctx)
    if (service === undefined) {
      logger?.warn?.('[commander] schedule migration skipped { reason: \'schedule_unavailable\' }')
      return finish('unavailable')
    }

    let rawEntries: unknown
    try {
      rawEntries = await withTimeout(service.catalog(), timeoutMs, 'schedule catalog')
    } catch (error: unknown) {
      result.failed.push({ id: '', code: errorCode(error) })
      if (error instanceof ScheduleMigrationTimeoutError) timedOut = true
      logger?.warn?.(`[commander] schedule migration catalog failed { code: ${errorCode(error)} }`)
      return finish(timedOut ? 'timeout' : 'failed')
    }
    if (!Array.isArray(rawEntries)) {
      result.failed.push({ id: '', code: 'invalid_catalog' })
      return finish('failed')
    }

    const entries = rawEntries as unknown[]
    result.scanned = entries.length
    const matched: ScheduleEntryLike[] = []
    for (const rawEntry of entries) {
      if (!isEntry(rawEntry)) {
        result.skipped.malformed += 1
        logger?.debug?.('[commander] schedule migration skip { reason: \'malformed_entry\' }')
        continue
      }
      if (!isFromTarget(rawEntry, from)) {
        logger?.debug?.(`[commander] schedule migration skip { reason: 'not_target', id: ${rawEntry.id}, target: ${targetDebug(rawEntry)} }`)
        continue
      }
      matched.push(rawEntry)
    }
    result.matched = matched.length
    if (matched.length === 0) {
      logger?.debug?.(`[commander] schedule migration no matched tasks { from: ${from} }`)
      return finish('ok')
    }

    const actorSessionId = input.actorSessionId ?? to
    const includeEnded = input.includeEnded !== false

    const attempt = async (entry: ScheduleEntryLike, allowRetry: boolean): Promise<void> => {
      if (now() >= deadline) {
        timedOut = true
        result.failed.push({ id: entry.id, code: 'timeout' })
        logger?.warn?.(`[commander] schedule migration failed { id: ${entry.id}, code: 'timeout' }`)
        return
      }
      const request: ScheduleEditRequestLike = {
        id: entry.id,
        action: 'update',
        patch: { target: { kind: 'session', sessionId: to } },
        expectedUpdatedAt: entry.updatedAt ?? null,
      }
      let edited: unknown
      try {
        edited = await withTimeout(service.edit(request, actorSessionId), Math.max(1, deadline - now()), `schedule edit ${entry.id}`)
      } catch (error: unknown) {
        if (error instanceof ScheduleMigrationTimeoutError) timedOut = true
        result.failed.push({ id: entry.id, code: errorCode(error) })
        logger?.warn?.(`[commander] schedule migration failed { id: ${entry.id}, code: ${errorCode(error)} }`)
        return
      }

      const code = codeOf(edited)
      if (code === undefined) {
        result.migrated += 1
        logger?.debug?.(`[commander] schedule migration moved { id: ${entry.id}, from: ${from}, to: ${to} }`)
        return
      }
      if (code === 'schedule_not_found') {
        result.skipped.gone += 1
        logger?.debug?.(`[commander] schedule migration skip { reason: 'gone', id: ${entry.id} }`)
        return
      }
      if (code === 'schedule_conflict' && allowRetry && typeof service.view === 'function') {
        let latest: unknown
        try {
          latest = await withTimeout(service.view({ id: entry.id }), Math.max(1, deadline - now()), `schedule view ${entry.id}`)
        } catch (error: unknown) {
          if (error instanceof ScheduleMigrationTimeoutError) timedOut = true
          result.failed.push({ id: entry.id, code: errorCode(error) })
          logger?.warn?.(`[commander] schedule migration failed { id: ${entry.id}, code: ${errorCode(error)} }`)
          return
        }
        const latestCode = codeOf(latest)
        if (latestCode !== undefined) {
          if (latestCode === 'schedule_not_found') {
            result.skipped.gone += 1
            logger?.debug?.(`[commander] schedule migration skip { reason: 'gone', id: ${entry.id} }`)
          } else {
            result.failed.push({ id: entry.id, code: latestCode })
            logger?.warn?.(`[commander] schedule migration failed { id: ${entry.id}, code: ${latestCode} }`)
          }
          return
        }
        if (!isEntry(latest) || !isFromTarget(latest, from)) {
          result.skipped.changed += 1
          logger?.debug?.(`[commander] schedule migration skip { reason: 'changed_by_user', id: ${entry.id} }`)
          return
        }
        await attempt(latest, false)
        return
      }
      result.failed.push({ id: entry.id, code })
      logger?.warn?.(`[commander] schedule migration failed { id: ${entry.id}, code: ${code} }`)
    }

    for (const entry of matched) {
      if (entry.status === 'ended' && !includeEnded) {
        result.skipped.ended += 1
        logger?.debug?.(`[commander] schedule migration skip { reason: 'ended', id: ${entry.id} }`)
        continue
      }
      await attempt(entry, true)
      if (timedOut) break
    }

    if (timedOut) return finish(result.migrated > 0 ? 'partial' : 'timeout')
    if (result.failed.length > 0) return finish(result.migrated > 0 ? 'partial' : 'failed')
    return finish('ok')
  }

  try {
    return await run()
  } catch (error: unknown) {
    result.failed.push({ id: '', code: errorCode(error) })
    logger?.warn?.(`[commander] schedule migration crashed { code: ${errorCode(error)} }`)
    return finish('failed')
  }
}
