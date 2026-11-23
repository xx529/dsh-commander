/**
 * Commander panel question cards (ask_user_question) — a second *view* of the
 * official pending question, never a second answerer.
 *
 * The official Web client publishes each pending question into
 * `uiSession.sessionStatus` as a `PendingQuestion` (kind `question` /
 * `plan-review`) carrying `questions` + `answer()`. The floating panel reuses
 * that same instance, so answering here settles the very request the main
 * composer is showing.
 */
import type { SessionStatusLike, SessionStatusMap } from './approval'
import type { WorkSessionView } from './types'

/** Options of one question as the Host sent them. */
export interface QuestionOptionLike {
  label?: unknown
  description?: unknown
}

/** One question item (subset of `AskUserQuestionItem`). */
export interface QuestionItemLike {
  id?: unknown
  question?: unknown
  header?: unknown
  detail?: unknown
  options?: unknown
  multiSelect?: unknown
}

/** One answer item of the wire payload. */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** Answer batch accepted by `PendingQuestion.answer()`. */
export interface QuestionAnswerPayload {
  answers: QuestionAnswerItem[]
}

/** Subset of the official `PendingQuestion` this panel touches. */
export interface PendingQuestionLike {
  kind?: unknown
  key?: string
  sessionId?: string
  callId?: string
  questions?: readonly QuestionItemLike[]
  /** Countdown/channel state (used for the timed hint only). */
  snapshot?: () => { countdown?: { remainingMs?: number; running?: boolean } } | undefined
  answer?: (answer: QuestionAnswerPayload) => Promise<unknown>
}

/** One pending question queued for the floating card. */
export interface PendingQuestionItem {
  sessionId: string
  taskId?: string
  title?: string
  /** True for the bound commander session (not a task work session). */
  commander: boolean
  question: PendingQuestionLike
  questionKey: string
}

/** Normalized question for rendering. */
export interface QuestionView {
  id: string
  question: string
  header?: string
  detail?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/** Draft of one question in the card. */
export interface QuestionDraft {
  selected: string[]
  custom: string
  skipped: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** Whether a pending-interaction value is a question this card can answer. */
export function isQuestionLike(value: unknown): value is PendingQuestionLike {
  if (!isRecord(value)) return false
  if (value.kind !== 'question' && value.kind !== 'plan-review') return false
  if (!Array.isArray(value.questions) || value.questions.length === 0) return false
  return typeof value.answer === 'function'
}

/** Stable key of a pending question (official key, else session + call id). */
function questionKeyOf(sessionId: string, pending: PendingQuestionLike): string {
  if (typeof pending.key === 'string' && pending.key !== '') return pending.key
  return `${sessionId}:${typeof pending.callId === 'string' ? pending.callId : 'question'}`
}

/**
 * Collect pending questions: the bound commander session first, then
 * task-linked work sessions (same source the approval card uses).
 */
export function selectPendingQuestions(
  statuses: SessionStatusMap,
  workSessions: readonly WorkSessionView[],
  commanderSessionId: string | undefined,
): PendingQuestionItem[] {
  const items: PendingQuestionItem[] = []
  const seen = new Set<string>()
  const push = (sessionId: string, status: SessionStatusLike | undefined, extra: { taskId?: string; title?: string; commander: boolean }): void => {
    const pending = status?.pendingInteraction
    if (!isQuestionLike(pending)) return
    const key = questionKeyOf(sessionId, pending)
    if (seen.has(key)) return
    seen.add(key)
    items.push({
      sessionId,
      ...(extra.taskId === undefined ? {} : { taskId: extra.taskId }),
      ...(extra.title === undefined ? {} : { title: extra.title }),
      commander: extra.commander,
      question: pending,
      questionKey: key,
    })
  }
  if (commanderSessionId !== undefined && commanderSessionId !== '') {
    push(commanderSessionId, statuses.get(commanderSessionId), { commander: true })
  }
  for (const session of workSessions) {
    push(session.sessionId, statuses.get(session.sessionId), {
      taskId: session.taskId,
      ...(session.title === undefined ? {} : { title: session.title }),
      commander: false,
    })
  }
  return items
}

/** Normalize the wire questions for rendering (drops malformed items). */
export function questionViews(pending: PendingQuestionLike): QuestionView[] {
  const views: QuestionView[] = []
  for (const raw of pending.questions ?? []) {
    if (!isRecord(raw)) continue
    const id = asString(raw.id)
    const question = asString(raw.question)
    if (id === undefined || question === undefined) continue
    const options: Array<{ label: string; description?: string }> = []
    for (const option of Array.isArray(raw.options) ? raw.options : []) {
      if (!isRecord(option)) continue
      const label = asString(option.label)
      if (label === undefined) continue
      const description = asString(option.description)
      options.push({ label, ...(description === undefined ? {} : { description }) })
    }
    views.push({
      id,
      question,
      ...(asString(raw.header) === undefined ? {} : { header: asString(raw.header) as string }),
      ...(asString(raw.detail) === undefined ? {} : { detail: asString(raw.detail) as string }),
      options,
      multiSelect: raw.multiSelect === true,
    })
  }
  return views
}

/** Empty draft for one question. */
export function emptyDraft(): QuestionDraft {
  return { selected: [], custom: '', skipped: false }
}

/** Whether one draft can be submitted (answered or explicitly skipped). */
export function draftComplete(draft: QuestionDraft | undefined): boolean {
  if (draft === undefined) return false
  return draft.skipped || draft.selected.length > 0 || draft.custom.trim() !== ''
}

/** Whether every question of the batch can be submitted. */
export function questionsComplete(views: readonly QuestionView[], drafts: Readonly<Record<string, QuestionDraft>>): boolean {
  return views.length > 0 && views.every(view => draftComplete(drafts[view.id]))
}

/**
 * Build the wire answer batch: skip → `{id, selected: []}`; single-select +
 * custom text → `custom` only; multi-select → selected labels plus custom.
 */
export function buildAnswerPayload(
  views: readonly QuestionView[],
  drafts: Readonly<Record<string, QuestionDraft>>,
): QuestionAnswerPayload {
  return {
    answers: views.map(view => {
      const draft = drafts[view.id] ?? emptyDraft()
      if (draft.skipped) return { id: view.id, selected: [] }
      const custom = draft.custom.trim()
      return {
        id: view.id,
        selected: custom === '' || view.multiSelect ? draft.selected : [],
        ...(custom === '' ? {} : { custom }),
      }
    }),
  }
}

/** Toggle one option inside a draft (single-select clears the previous pick). */
export function toggleOption(view: QuestionView, draft: QuestionDraft, label: string): QuestionDraft {
  if (view.multiSelect) {
    const selected = draft.selected.includes(label)
      ? draft.selected.filter(item => item !== label)
      : [...draft.selected, label]
    return { ...draft, selected, skipped: false }
  }
  return { ...draft, selected: draft.selected.includes(label) && draft.custom.trim() === '' ? [] : [label], skipped: false }
}
