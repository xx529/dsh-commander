// M3 turn/end 最后回复注入（m2m3-contract-patch §3.1）。
// 触发：work 会话 + 有任务绑定 + reason 允许集 + 无未配对 approval/asked + userQuestions.active 为空。
// 去重 `<sessionId>:<turnId>:<lastSeq>`（写 SessionLinkRecord.lastInjected，先投递成功再写）；
// 头 6KB + 尾 2KB 截断（含元数据行整条 ≤ INJECTION_TEXT_MAX）；忙时同 session 合并为一条；不写任务记录、不轮询、不注入审批内容。
import { INJECTION_HEAD_MAX, INJECTION_REASONS, INJECTION_RETRY_MAX, INJECTION_TEXT_MAX } from '../config.ts'
import type { SessionLinkRecord } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'

export interface InjectionEventLike {
  seq?: number
  type?: string
  time?: number
  data?: Record<string, unknown>
}

export interface InjectionMetrics {
  injections: number
  deduped: number
  pendingSkipped: number
  injectFailures: number
  /** M3 观测：sessionProjections 不可用导致 userQuestions 无法判定（fail-open，仍注入；只计数）。 */
  projectionUnavailable: number
}

export interface InjectionDelivery {
  accepted?: boolean
  queued?: boolean
}

/** 本次注入的来源（工作会话）：投递侧据此生成上下文卡片的 sender。 */
export interface InjectionContext {
  sessionId: string
  taskId: string
}

export interface TurnReplyInjectorDeps {
  stores: StoreSet
  deliver: (text: string, requestId: string, context: InjectionContext) => Promise<InjectionDelivery>
  getSessionEvents?: (sessionId: string) => Promise<unknown[]> | unknown[]
  getProjection?: (session: unknown) => unknown
  commanderSessionId: () => string
  isBusy?: () => boolean
  now?: () => number
  logger?: { warn?: (message: string) => void }
  /** 合并窗口（忙时同 session 连续停止合并；测试可缩短/置 0）。 */
  mergeWindowMs?: number
}

export type InjectionOutcome =
  | { status: 'injected'; sessionId: string; taskId: string; turnId: string; seq: number; truncated: boolean }
  | { status: 'deduped'; sessionId: string }
  | { status: 'skipped'; sessionId: string; reason: 'not_work_session' | 'reason_not_allowed' | 'pending_interaction' | 'no_turn' | 'commander_session' | 'no_text' | 'task_inactive' }

export const EMPTY_REPLY_TEXT = '[session-reply] 本轮无文本回复'

/** 截断标记最长约 28 字符（`\n…[truncated N chars]…\n`），预留 32 保证整段不超预算。 */
const TRUNCATION_MARKER_RESERVE = 32

/**
 * 头尾截断到 `max` 字符（含截断标记），默认 INJECTION_TEXT_MAX。
 * 整段注入必须 ≤ 投递上限（PROMPT_TEXT_MAX，同为 8192）：正文 + 元数据行一起算，否则长回复永远投递失败。
 */
export function truncateInjectionText(text: string, max = INJECTION_TEXT_MAX): { text: string; truncated: boolean } {
  const chars = Array.from(text)
  if (chars.length <= max) return { text, truncated: false }
  const headLen = Math.min(INJECTION_HEAD_MAX, Math.max(0, max - 1))
  const tailLen = Math.max(0, max - headLen - TRUNCATION_MARKER_RESERVE)
  const head = chars.slice(0, headLen).join('')
  const tail = tailLen === 0 ? '' : chars.slice(chars.length - tailLen).join('')
  const marker = `\n…[truncated ${chars.length - headLen - tailLen} chars]…`
  return { text: tail === '' ? `${head}${marker}` : `${head}${marker}\n${tail}`, truncated: true }
}

export function buildInjectionText(input: { text: string; taskId: string; sessionId: string; turnId: string; seq: number }): { text: string; truncated: boolean } {
  const stripped = String(input.text ?? '').trim()
  const body = stripped === '' ? EMPTY_REPLY_TEXT : `[session-reply] ${stripped}`
  const trailer = (truncated: boolean): string =>
    `\n---\ntaskId=${input.taskId} sessionId=${input.sessionId} turnId=${input.turnId} seq=${input.seq} truncated=${truncated}`
  // 元数据行占掉的字符要从正文预算里扣，保证整条注入 ≤ INJECTION_TEXT_MAX（投递校验同样卡 8192）。
  const bodyMax = Math.max(1, INJECTION_TEXT_MAX - Array.from(trailer(true)).length)
  const truncated = truncateInjectionText(body, bodyMax)
  return { text: `${truncated.text}${trailer(truncated.truncated)}`, truncated: truncated.truncated }
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

function eventTypeOf(event: InjectionEventLike): string {
  return asString(event.type) ?? ''
}

export function reasonKindOf(event: InjectionEventLike): string | undefined {
  const data = event.data ?? {}
  const reason = data.reason
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && reason !== null) {
    const record = reason as Record<string, unknown>
    return asString(record.kind) ?? asString(record.type)
  }
  return asString(data.stopReason) ?? asString(data.reasonKind)
}

function textOfAssistantEvent(event: InjectionEventLike): string {
  const data = event.data ?? {}
  const message = (data.message ?? {}) as { content?: unknown }
  const content = Array.isArray(message.content) ? message.content : Array.isArray(data.content) ? (data.content as unknown[]) : []
  const parts: string[] = []
  for (const block of content) {
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

function isPendingApproval(events: InjectionEventLike[]): boolean {
  const approvalEvents = events.filter((event) => {
    const type = eventTypeOf(event)
    return /^(approval|approval\/asked|approval\/request|approval\/decided|approval\/response)/.test(type)
  })
  let lastAsked: number | undefined
  let lastDecided: number | undefined
  for (const event of approvalEvents) {
    const type = eventTypeOf(event)
    const seq = event.seq ?? 0
    if (type.startsWith('approval/asked') || type === 'approval/request') lastAsked = Math.max(lastAsked ?? -1, seq)
    if (type.startsWith('approval/decided') || type === 'approval/response') lastDecided = Math.max(lastDecided ?? -1, seq)
  }
  return lastAsked !== undefined && (lastDecided === undefined || lastAsked > lastDecided)
}

export function createTurnReplyInjector(deps: TurnReplyInjectorDeps) {
  const now = deps.now ?? (() => Date.now())
  const mergeWindowMs = deps.mergeWindowMs ?? 0
  const metrics: InjectionMetrics = { injections: 0, deduped: 0, pendingSkipped: 0, injectFailures: 0, projectionUnavailable: 0 }
  const inflight = new Set<string>()
  const pending = new Map<string, { session: unknown; event: InjectionEventLike }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  const workLinkOf = (sessionId: string): SessionLinkRecord | undefined =>
    deps.stores.sessions.list().find((link) => {
      if (link.sessionId !== sessionId || link.role !== 'work' || link.taskId === '') return false
      const task = deps.stores.tasks.get(link.taskId)
      if (task === undefined) return false
      // M5：旧轮次会话的 turn/end 不再注入当前任务。
      return (link.round ?? 1) >= (task.round ?? 1)
    })

  const sessionEvents = async (sessionId: string): Promise<InjectionEventLike[]> => {
    if (deps.getSessionEvents === undefined) return []
    try {
      const value = await deps.getSessionEvents(sessionId)
      return Array.isArray(value) ? (value as InjectionEventLike[]) : []
    } catch {
      return []
    }
  }

  const userQuestionsActive = (session: unknown): boolean => {
    // fail-open（Lead 裁决 2026-11-18）：投影不可用时不静默丢最后回复，仍注入；只计数便于观测。
    if (deps.getProjection === undefined) {
      metrics.projectionUnavailable += 1
      return false
    }
    try {
      const snapshot = deps.getProjection(session) as { userQuestions?: { active?: unknown } } | undefined
      if (snapshot === undefined || snapshot === null) {
        metrics.projectionUnavailable += 1
        return false
      }
      return Array.isArray(snapshot?.userQuestions?.active) && (snapshot?.userQuestions?.active as unknown[]).length > 0
    } catch {
      metrics.projectionUnavailable += 1
      return false
    }
  }

  const attemptDelivery = async (text: string, requestId: string, context: InjectionContext): Promise<boolean> => {
    for (let attempt = 0; attempt <= INJECTION_RETRY_MAX; attempt += 1) {
      try {
        const result = await deps.deliver(text, requestId, context)
        if (result?.accepted !== false) return true
      } catch (error) {
        deps.logger?.warn?.(`[commander] injection delivery failed (attempt ${attempt + 1}): ${String((error as Error)?.message ?? error)}`)
      }
    }
    return false
  }

  const deliverNow = async (session: unknown, event: InjectionEventLike): Promise<InjectionOutcome> => {
    const sessionId = asString((session as { id?: unknown } | undefined)?.id) ?? ''
    if (sessionId === '' || sessionId === deps.commanderSessionId()) return { status: 'skipped', sessionId, reason: 'commander_session' }
    if (disposed) return { status: 'skipped', sessionId, reason: 'no_turn' }
    const link = workLinkOf(sessionId)
    if (link === undefined) return { status: 'skipped', sessionId, reason: 'not_work_session' }
    // 只监控「进行中 / 待验收」的任务：验收完成、归档、取消，或尚未派发（draft/proposed/queued/blocked）的
    // 工作会话都不再打扰指挥官（用户 2026-11-18 口径）。
    const task = deps.stores.tasks.get(link.taskId)
    if (task === undefined || (task.status !== 'running' && task.status !== 'review')) {
      return { status: 'skipped', sessionId, reason: 'task_inactive' }
    }
    const events = await sessionEvents(sessionId)
    if (isPendingApproval(events)) {
      metrics.pendingSkipped += 1
      return { status: 'skipped', sessionId, reason: 'pending_interaction' }
    }
    if (userQuestionsActive(session)) {
      metrics.pendingSkipped += 1
      return { status: 'skipped', sessionId, reason: 'pending_interaction' }
    }
    const turnId = String(event.data?.turn ?? event.seq ?? now())
    const assistantEvents = events
      .filter((item) => eventTypeOf(item) === 'assistant/message')
      .filter((item) => String(item.data?.turn ?? '') === turnId || event.data?.turn === undefined)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    const lastAssistant = assistantEvents.length > 0 ? assistantEvents[assistantEvents.length - 1] : undefined
    const lastSeq = lastAssistant?.seq ?? event.seq ?? 0
    if (link.lastInjected !== undefined && link.lastInjected.turnId === turnId && (link.lastInjected.seq ?? -1) >= lastSeq) {
      metrics.deduped += 1
      return { status: 'deduped', sessionId }
    }
    const text = lastAssistant !== undefined ? textOfAssistantEvent(lastAssistant) : ''
    const built = buildInjectionText({ text, taskId: link.taskId, sessionId, turnId, seq: lastSeq })
    const requestId = `inject-${link.taskId}-${turnId}-${lastSeq}`
    const delivered = await attemptDelivery(built.text, requestId, { sessionId, taskId: link.taskId })
    const at = now()
    // 只原子改 lastInjected：turn/end 的状态跟踪会并发把 status 写回 idle，整条 upsert 会用旧 running 覆盖它。
    const markInjected = (): Promise<unknown> => deps.stores.sessions.patch(link.workspaceId, link.sessionId, (current) => ({
      ...current,
      lastInjected: { turnId, seq: lastSeq, at },
    }))
    if (delivered) {
      metrics.injections += 1
      await markInjected()
      return { status: 'injected', sessionId, taskId: link.taskId, turnId, seq: lastSeq, truncated: built.truncated }
    }
    metrics.injectFailures += 1
    // 补一次后无论成败写 lastInjected，避免风暴。
    await markInjected()
    return { status: 'skipped', sessionId, reason: 'no_turn' }
  }

  const flushPending = async (): Promise<void> => {
    for (const [sessionId, item] of [...pending]) {
      pending.delete(sessionId)
      if (inflight.has(sessionId)) {
        pending.set(sessionId, item)
        continue
      }
      inflight.add(sessionId)
      try {
        await deliverNow(item.session, item.event)
      } finally {
        inflight.delete(sessionId)
        if (mergeWindowMs === 0) {
          const queued = pending.get(sessionId)
          if (queued !== undefined) {
            pending.delete(sessionId)
            void flushPending()
          }
        }
      }
    }
  }

  const scheduleFlush = (): void => {
    if (mergeWindowMs <= 0) {
      void flushPending()
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      void flushPending()
    }, mergeWindowMs)
    timer.unref?.()
    timers.add(timer)
  }

  return {
    metrics,
    async handle(session: unknown, event: InjectionEventLike): Promise<InjectionOutcome> {
      if (eventTypeOf(event) !== 'turn/end') return { status: 'skipped', sessionId: '', reason: 'no_turn' }
      const sessionId = asString((session as { id?: unknown } | undefined)?.id) ?? ''
      const reason = reasonKindOf(event)
      if (reason !== undefined && !(INJECTION_REASONS as readonly string[]).includes(reason)) {
        return { status: 'skipped', sessionId, reason: 'reason_not_allowed' }
      }
      if (inflight.has(sessionId) || (deps.isBusy?.() === true)) {
        pending.set(sessionId, { session, event }) // 忙/在途：同 session 合并为最新一条
        scheduleFlush()
        return { status: 'skipped', sessionId, reason: 'no_turn' }
      }
      inflight.add(sessionId)
      try {
        const outcome = await deliverNow(session, event)
        const queued = pending.get(sessionId)
        if (queued !== undefined) scheduleFlush()
        return outcome
      } finally {
        inflight.delete(sessionId)
      }
    },
    /** 测试/关闭用：把 pending 全部投递。 */
    async flush(): Promise<void> {
      await flushPending()
    },
    dispose(): void {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
  }
}

export type TurnReplyInjector = ReturnType<typeof createTurnReplyInjector>
