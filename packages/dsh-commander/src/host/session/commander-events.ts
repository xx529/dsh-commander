// 订阅指挥官会话 session/event：assistant/message 文本 → 消息环 + SSE；turn/start|end → busy + commander.status。
// 口径：m0-contract-patch §1.4/§1.5（消息通道只发 assistant 文本一条；空文本不产生消息）。
// v1.1 加法：status 附带 activity（tool/call 的 arguments.description 或 assistant 文本），供原生壳气泡展示。
import type { CordisContext, SessionEventLike } from '../dsh-types.ts'
import type { MessageRing } from './messages.ts'
import type { BindingService } from './binding.ts'

/** 气泡活动文案的传输上限（展示长度由 Client 再截断）。 */
export const ACTIVITY_TEXT_MAX = 200

export interface CommanderActivity {
  text: string
  at: number
}

export interface CommanderStatusState {
  busy: boolean
  lastTurnId: number | null
  /** 当前回合最近一条可展示动作；turn/start、turn/end 时清空。 */
  activity: CommanderActivity | null
}

export interface CommanderEventsDeps {
  ctx: CordisContext
  binding: BindingService
  messages: MessageRing
  getStatus: () => CommanderStatusState
  emitMessage: (message: { messageId: string; role: 'user' | 'assistant'; text: string; at: number; order: number; turnId?: number; seq?: number; truncated?: boolean; fullChars?: number }) => void
  emitStatus: (status: { busy: boolean; lastTurnId: number | null; activity: CommanderActivity | null; at: number }) => void
  now?: () => number
}

/** 单行化 + 去首尾空白 + 传输上限；空串返回 ''。 */
export function normalizeActivityText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/gu, ' ').trim()
  if (text === '') return ''
  return text.length > ACTIVITY_TEXT_MAX ? `${text.slice(0, ACTIVITY_TEXT_MAX).trimEnd()}...` : text
}

/** 从 tool/call 的 arguments（JSON 字符串）取 description；没有/不合法返回 ''。 */
export function extractToolDescription(event: SessionEventLike): string {
  const raw = event?.data?.arguments
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return ''
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  return normalizeActivityText((args as Record<string, unknown>).description)
}

interface AssistantContentBlock {
  type?: string
  text?: string
}

/** 从 assistant/message 事件取文本（兼容 data.message.content 与 data.content 两种形状）。 */
export function extractAssistantText(event: SessionEventLike): string {
  const data = event?.data ?? {}
  const message = (data.message ?? data) as Record<string, unknown>
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is AssistantContentBlock => typeof block === 'object' && block !== null && (block as AssistantContentBlock).type === 'text' && typeof (block as AssistantContentBlock).text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim()
}

const turnOf = (event: SessionEventLike): number | null => {
  const turn = (event?.data as Record<string, unknown> | undefined)?.turn
  return typeof turn === 'number' && Number.isInteger(turn) ? turn : null
}

/** 去重键：`asst_<turn>_<seq>`；turn 缺失时用事件自身 turn 字段兜底。 */
export function assistantMessageId(event: SessionEventLike): string {
  const turn = turnOf(event) ?? 'x'
  const seq = typeof event?.seq === 'number' ? event.seq : 'x'
  return `asst_${turn}_${seq}`
}

/**
 * 注册 session/event 监听（返回 disposer）。只处理当前绑定会话；绑定后重绑自动跟随 config。
 * 事件形状按 V2 证据：ctx.on('session/event', (session, event) => …)。
 */
export function subscribeCommanderEvents(deps: CommanderEventsDeps): () => void {
  const now = deps.now ?? (() => Date.now())
  const handler = (...args: unknown[]): void => {
    const [sessionArg, eventArg] = args as [Record<string, unknown> | undefined, SessionEventLike | undefined]
    const sessionId = typeof sessionArg?.id === 'string' ? sessionArg.id : undefined
    const event = eventArg
    if (sessionId === undefined || event === undefined) return
    const binding = deps.binding.view()
    if (binding.binding.sessionId === '' || binding.binding.sessionId !== sessionId) return
    const type = event.type
    const at = typeof event.time === 'number' ? event.time : now()
    /** busy 与 activity 一起广播，气泡窗只消费 commander.status。 */
    const emitStatus = (): void => {
      deps.emitStatus({
        busy: deps.getStatus().busy,
        lastTurnId: deps.getStatus().lastTurnId,
        activity: deps.getStatus().activity,
        at: now(),
      })
    }
    if (type === 'turn/start') {
      const turn = turnOf(event) ?? null
      deps.getStatus().busy = true
      if (turn !== null) deps.getStatus().lastTurnId = turn
      deps.getStatus().activity = null
      emitStatus()
      return
    }
    if (type === 'turn/end') {
      deps.getStatus().busy = false
      deps.getStatus().activity = null
      emitStatus()
      return
    }
    // 工具动作：只认参数里的 description；没有就跳过，保留上一条活动。
    if (type === 'tool/call') {
      const description = extractToolDescription(event)
      if (description === '') return
      deps.getStatus().activity = { text: description, at }
      emitStatus()
      return
    }
    if (type !== 'assistant/message') return
    const text = extractAssistantText(event)
    if (text.length === 0) return
    deps.getStatus().activity = { text: normalizeActivityText(text), at }
    const turnId = turnOf(event) ?? undefined
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const message = deps.messages.push({
      messageId: assistantMessageId(event),
      role: 'assistant',
      text,
      at,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(seq !== undefined ? { seq } : {}),
    })
    if (message !== null) deps.emitMessage(message)
    emitStatus()
  }
  const disposable = deps.ctx.on('session/event', handler)
  return () => {
    try {
      disposable?.()
    } catch {
      /* disposer 幂等 */
    }
  }
}

// ---------------------------------------------------------------- 重启后 best-effort 回填
/**
 * Host 重启后从已 live 的指挥官会话事件尽力回填最近 ≤200 条（m0-contract-patch §1.1）；
 * 只读 session events，失败即空，不报错、不影响 M0 验收。
 */
export function backfillCommanderMessages(input: {
  events: SessionEventLike[] | undefined
  messages: MessageRing
  now?: () => number
  limit?: number
}): number {
  const now = input.now ?? (() => Date.now())
  const limit = input.limit ?? 200
  const events = input.events
  if (!Array.isArray(events) || events.length === 0) return 0
  const picked: Array<{ event: SessionEventLike; role: 'user' | 'assistant'; text: string }> = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const message = (data.message ?? data) as Record<string, unknown>
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
      .trim()
    if (text.length === 0) continue
    // 用户消息只取真实用户来源（排除注入/系统上下文）
    if (event.type === 'user/message') {
      const source = (data as { source?: { kind?: string } }).source
      if (source?.kind !== undefined && source.kind !== 'user') continue
      picked.push({ event, role: 'user', text })
    } else {
      picked.push({ event, role: 'assistant', text })
    }
  }
  const tail = picked.slice(-limit)
  let added = 0
  for (const item of tail) {
    const seq = typeof item.event.seq === 'number' ? item.event.seq : undefined
    const turn = turnOf(item.event) ?? undefined
    const messageId = item.role === 'assistant' ? assistantMessageId(item.event) : `user_${seq ?? 'x'}`
    const message = input.messages.push({
      messageId,
      role: item.role,
      text: item.text,
      at: typeof item.event.time === 'number' ? item.event.time : now(),
      ...(turn !== undefined ? { turnId: turn } : {}),
      ...(seq !== undefined ? { seq } : {}),
    })
    if (message !== null) added += 1
  }
  return added
}
