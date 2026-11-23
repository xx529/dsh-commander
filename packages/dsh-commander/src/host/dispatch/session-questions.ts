// 会话段证据：读取候选会话的用户提问（过滤注入消息、按条/会话/总量限额截断）。
// 契约：ARCHITECTURE §5.2（会话选项带用户提问）。
import {
  JEV_SESSION_QUESTION_CHARS_PER_SESSION,
  JEV_SESSION_QUESTION_MAX_CHARS,
  JEV_SESSION_QUESTIONS_SESSIONS_MAX,
  JEV_SESSION_QUESTIONS_TOTAL_CHARS,
} from '../config.ts'
import type { CordisContext, SessionEventLike } from '../dsh-types.ts'
import { readSessionEvents } from '../session/session-records.ts'
import type { DispatchSessionInput } from '../jev/request.ts'

/** 注入类“假用户消息”的前缀（DSH 会把提醒/运行时快照放进 user/message）。 */
const INJECTED_PREFIXES = [
  '<system-reminder>',
  '<available_skills>',
  'Current runtime context',
  'The approval policy changed',
  'Time sampled',
  'Browser time zone',
]

/** 单会话读取的提问条数上限（防止超长会话无限读取）。 */
const MAX_QUESTIONS_PER_SESSION = 20

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 从一条 user/message 事件取真实用户文本；注入消息/非文本返回 null。 */
function userTextOf(event: SessionEventLike): string | null {
  if (event.type !== 'user/message') return null
  const data = event.data
  if (!isRecord(data)) return null
  // 只有 source.kind === 'user'（或旧数据无 source）才是用户本人输入
  if (isRecord(data.source)) {
    const kind = typeof data.source.kind === 'string' ? data.source.kind : ''
    if (kind !== '' && kind !== 'user') return null
  }
  const content = data.content
  if (!Array.isArray(content)) return null
  const text = content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim()
  if (text === '') return null
  if (INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix))) return null
  return text.slice(0, JEV_SESSION_QUESTION_MAX_CHARS)
}

/**
 * 某个会话的用户提问（按时间序；无事件/读取失败返回空数组）。
 * 上限 20 条：超过时**首条与末条必留**，中间按提问长度降序取 18 条（信息量大的优先），输出仍按时间序。
 */
export async function readSessionUserQuestions(ctx: CordisContext, sessionId: string): Promise<string[]> {
  const events = await readSessionEvents(ctx, sessionId)
  const all: string[] = []
  for (const event of events) {
    const text = userTextOf(event)
    if (text !== null) all.push(text)
  }
  if (all.length <= MAX_QUESTIONS_PER_SESSION) return all
  const middle = all.slice(1, -1)
  const middleLimit = MAX_QUESTIONS_PER_SESSION - 2
  const picked = middle
    .map((text, index) => ({ text, index }))
    .sort((a, b) => b.text.length - a.text.length || a.index - b.index)
    .slice(0, middleLimit)
  const pickedIndexes = new Set(picked.map((item) => item.index))
  return [all[0] as string, ...middle.filter((_text, index) => pickedIndexes.has(index)), all[all.length - 1] as string]
}

/**
 * 给会话段候选附用户提问：按 lastActiveAt 倒序的候选最多处理 60 个，总量不超过 45k 字符；
 * 超出预算/上限的候选只保留标题，仍然是合法选项。
 */
export async function attachSessionQuestions(
  ctx: CordisContext,
  sessions: DispatchSessionInput[],
): Promise<DispatchSessionInput[]> {
  if (sessions.length === 0) return sessions
  const head = sessions.slice(0, JEV_SESSION_QUESTIONS_SESSIONS_MAX)
  const questionLists = await Promise.all(head.map((session) => readSessionUserQuestions(ctx, session.id)))
  let remaining = JEV_SESSION_QUESTIONS_TOTAL_CHARS
  const enriched = head.map((session, index) => {
    const questions = questionLists[index] ?? []
    if (questions.length === 0 || remaining <= 0) return session
    const first = questions[0] as string
    const last = questions.length > 1 ? (questions[questions.length - 1] as string) : undefined
    const limit = Math.min(JEV_SESSION_QUESTION_CHARS_PER_SESSION, remaining)
    const take = (text: string, room: number): string => (text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text)
    let used = 0
    // 首条与末条必留，剩余预算按时间序给中间条目
    const firstText = take(first, Math.min(first.length, limit))
    used += firstText.length
    let lastText: string | undefined
    if (last !== undefined) {
      const room = Math.min(last.length, limit - used)
      lastText = room > 0 ? take(last, room) : undefined
      used += lastText?.length ?? 0
    }
    const middle: string[] = []
    for (const question of questions.slice(1, lastText !== undefined ? -1 : undefined)) {
      const room = limit - used
      if (room <= 0) break
      const text = take(question, room)
      middle.push(text)
      used += text.length
    }
    const kept = [firstText, ...middle, ...(lastText !== undefined ? [lastText] : [])].filter((text) => text !== '')
    remaining -= used
    return { ...session, userQuestions: kept }
  })
  return [...enriched, ...sessions.slice(JEV_SESSION_QUESTIONS_SESSIONS_MAX)]
}
