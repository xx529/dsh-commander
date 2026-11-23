// 原生壳问答桥（`user-questions/request` waterfall，P1 条件接管）。
// 与审批桥同规则：壳 running+visible+focused 时 prepend 接管，否则 next() 回落 DSH Web 回答者；
// 壳退出/超时 → 返回"全部跳过"的合法答案，让工具继续而不是卡死。
import { randomUUID } from 'node:crypto'
import type { ShellStatus } from './supervisor.ts'

export interface QuestionOptionView {
  label: string
  description?: string
}

export interface QuestionItemView {
  id: string
  question: string
  header?: string
  detail?: string
  options: QuestionOptionView[]
  multiSelect: boolean
}

export interface QuestionBatchView {
  id: string
  questions: QuestionItemView[]
  at: number
  /** false = 已交给 DSH 页内回答者，浮窗只读展示。 */
  canAnswer: boolean
}

export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
}

export interface QuestionRequestLike {
  questions?: unknown
  signal?: AbortSignal
}

export type QuestionNextAnswerer = () => Promise<QuestionAnswer> | QuestionAnswer

export interface QuestionBridge {
  onShellStatus(status: Pick<ShellStatus, 'phase'>): void
  list(): QuestionBatchView[]
  /** 窗口页回答；非法批次/答案返回 null。 */
  resolve(id: string, answers: unknown): QuestionAnswer | null
  dispose(): void
}

export interface QuestionBridgeOptions {
  onRequest: (listener: (request: QuestionRequestLike, next: QuestionNextAnswerer) => unknown) => () => void
  emit: (event: string, payload: unknown) => void
  isShellFocused: () => boolean
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function normalizeQuestions(value: unknown): QuestionItemView[] {
  if (!Array.isArray(value)) return []
  const items: QuestionItemView[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.question !== 'string') continue
    const options: QuestionOptionView[] = []
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (typeof option !== 'object' || option === null) continue
        const entry = option as Record<string, unknown>
        if (typeof entry.label !== 'string') continue
        options.push({
          label: entry.label,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        })
      }
    }
    items.push({
      id: record.id,
      question: record.question,
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
      options,
      multiSelect: record.multiSelect === true,
    })
  }
  return items
}

function skipAnswer(view: QuestionBatchView): QuestionAnswer {
  return { answers: view.questions.map((question) => ({ id: question.id, selected: [] })) }
}

function validateAnswers(view: QuestionBatchView, raw: unknown): QuestionAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const list = (raw as { answers?: unknown }).answers
  if (!Array.isArray(list) || list.length !== view.questions.length) return null
  const byId = new Map(view.questions.map((question) => [question.id, question]))
  const answers: QuestionAnswerItem[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || seen.has(record.id)) return null
    const question = byId.get(record.id)
    if (question === undefined) return null
    if (!Array.isArray(record.selected) || !record.selected.every((label) => typeof label === 'string')) return null
    const selected = record.selected as string[]
    const allowed = new Set(question.options.map((option) => option.label))
    if (!selected.every((label) => allowed.has(label))) return null
    if (!question.multiSelect && selected.length > 1) return null
    if (record.custom !== undefined && typeof record.custom !== 'string') return null
    seen.add(record.id)
    answers.push({
      id: record.id,
      selected,
      ...(typeof record.custom === 'string' && record.custom.length > 0 ? { custom: record.custom } : {}),
    })
  }
  return answers.length === view.questions.length ? { answers } : null
}

/**
 * 创建问答桥。
 * @param options - waterfall 注册器、广播出口、接管判定与可注入时钟（测试）。
 */
export function createQuestionBridge(options: QuestionBridgeOptions): QuestionBridge {
  const now = options.now ?? Date.now
  const setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log ?? (() => {})
  const pending = new Map<string, { view: QuestionBatchView; resolve: (answer: QuestionAnswer) => void; timer: unknown }>()
  let disposed = false

  function settle(id: string, answer: QuestionAnswer): boolean {
    const entry = pending.get(id)
    if (entry === undefined) return false
    pending.delete(id)
    clearTimeoutFn(entry.timer)
    entry.resolve(answer)
    options.emit('native.question.resolved', { id })
    return true
  }

  const listener = (request: QuestionRequestLike, next: QuestionNextAnswerer): unknown => {
    if (disposed) return next()
    const questions = normalizeQuestions(request.questions)
    if (questions.length === 0) return next()
    const id = randomUUID()
    const view: QuestionBatchView = { id, questions, at: now(), canAnswer: true }
    // 双处操作：浮窗与 DSH 页内同时展示，先回答的结果生效。
    const floatAnswer = new Promise<QuestionAnswer>((resolve) => {
      const timer = setTimeoutFn(() => {
        log('warn', `question batch ${id} float window timed out; DSH may still answer`)
        if (pending.delete(id)) options.emit('native.question.resolved', { id })
      }, timeoutMs)
      pending.set(id, { view, resolve, timer })
      options.emit('native.question', view)
    })
    let dshAnswer: Promise<QuestionAnswer>
    try {
      dshAnswer = Promise.resolve(next())
    } catch (error) {
      log('warn', `DSH question answerer failed: ${String(error)}`)
      dshAnswer = Promise.resolve({ answers: view.questions.map((question) => ({ id: question.id, selected: [] })) } as QuestionAnswer)
    }
    const dshSettled = dshAnswer.catch((error: unknown) => {
      log('warn', `DSH question answerer failed: ${String(error)}`)
      return { answers: view.questions.map((question) => ({ id: question.id, selected: [] })) } as QuestionAnswer
    })
    request.signal?.addEventListener('abort', () => {
      if (pending.delete(id)) options.emit('native.question.resolved', { id })
    }, { once: true })
    return Promise.race([dshSettled, floatAnswer]).finally(() => {
      if (pending.delete(id)) options.emit('native.question.resolved', { id })
    })
  }

  const disposeListener = options.onRequest(listener)

  return {
    onShellStatus(status): void {
      if (status.phase === 'running') return
      // 壳退出只撤掉浮窗视图；请求仍由 DSH 页内回答者继续等待。
      for (const [id, entry] of [...pending]) {
        log('warn', `shell left running; hiding question batch ${id} (DSH may still answer)`)
        pending.delete(id)
        clearTimeoutFn(entry.timer)
        options.emit('native.question.resolved', { id })
      }
    },
    list(): QuestionBatchView[] {
      return [...pending.values()].map((entry) => entry.view)
    },
    resolve(id: string, answers: unknown): QuestionAnswer | null {
      const entry = pending.get(id)
      if (entry === undefined) return null
      const answer = validateAnswers(entry.view, answers)
      if (answer === null) return null
      settle(id, answer)
      return answer
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const [id, entry] of [...pending]) {
        pending.delete(id)
        clearTimeoutFn(entry.timer)
        options.emit('native.question.resolved', { id })
      }
      disposeListener()
    },
  }
}
