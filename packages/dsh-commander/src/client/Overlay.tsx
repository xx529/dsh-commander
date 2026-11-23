/**
 * `shell.overlay` entry: the 56px floating commander ball and the 420×660
 * command panel.
 *
 * 2026-11-19 交互收敛（C 方案）：
 *  - 对话区只放消息；派发确认卡和审批卡不再混进 transcript；
 *  - 面板顶部是「绑定 + 任务 + 连接」状态条，点开是指挥状态浮层；
 *  - 待处理动作收进底部抽屉（sheet），输入框上方的「N 项待处理」浮钮是入口；
 *  - 悬浮球重做为单一计数信号：实心旗标、琥珀计数、无绿点/无外描边，
 *    hover/focus 才展开「指挥官 · N 项待处理」标签。
 *
 * 产品边界不变：派发先确认、审批只在界面层处理（不进入指挥官上下文）。
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ChatMessage, TaskView } from './types'
import type { CommanderStore } from './store'
import { MESSAGE_MAX_CHARS, POLL_INTERVAL_MS } from './state'
import { STYLES } from './styles'
import { DispatchConfirmCard } from './DispatchCard'
import { buildDispatchActionMessage, decisionIdOf, taskIdOf, taskStatusLabelKey, workspaceLabel } from './dispatch'
import type { DispatchActionKind, DispatchTarget } from './dispatch'
import { ApprovalFloatCard } from './ApprovalFloat'
import { answerPendingApproval, badgeLabelKey, deriveCommanderBadge, isAlreadySettled, selectPendingApprovals } from './approval'
import { QuestionCard } from './QuestionCard'
import { selectPendingQuestions, type PendingQuestionItem, type QuestionAnswerPayload } from './questions'
import type { PendingApprovalItem, SessionStatusSource } from './approval'
import { interpretCommanderMessage, parseMetadata } from './system-message'
import { MarkdownText, markdownLabels } from './markdown'
import { shortSessionId } from './session-display'

/** Face the plugin injects into the overlay entry. */
export interface OverlayInjected {
  store: CommanderStore
  t: (key: string) => string
  /** Switch the main panel to the commander board (absent without ctx.layout). */
  openBoard?: () => void
  /** `uiSession.sessionStatus` observable (absent when the session UI is unavailable). */
  sessionStatus?: SessionStatusSource
  /** Open a DSH session from the approval card / status popover. */
  openSession?: (sessionId: string) => void
}

/** Stable empty observable used when the session-status service is unavailable. */
const EMPTY_SESSION_STATUS: SessionStatusSource = {
  getSnapshot: () => new Map(),
  subscribe: () => () => {},
}

/** Props received by the slot entry: only the inject face. */
export type CommanderOverlayProps = OverlayInjected

/** Stroke-based icon used across the ball and panel chrome. */
function Icon({ paths, size = 16 }: { paths: readonly string[]; size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths.map(path => <path key={path} d={path} />)}
    </svg>
  )
}

const ICON_CLOSE = ['M6 6l12 12', 'M18 6L6 18']
const ICON_BOARD = ['M4 5h16', 'M4 5v14h16V5', 'M9 5v14', 'M15 5v14']
const ICON_REFRESH = ['M20 11a8 8 0 10-2.3 5.7', 'M20 5v6h-6']
const ICON_CHEVRON_DOWN = ['M6 9l6 6 6-6']
const ICON_CHEVRON_UP = ['M6 15l6-6 6 6']
const ICON_INBOX = ['M4 5h16v9l-4 4H8l-4-4z', 'M4 13h4l1.4 2h5.2L16 13h4']
const ICON_EXTERNAL = ['M7 17L17 7', 'M9 7h8v8']

/** Background poll cadence, surfaced so users can read the degradation. */
const POLL_HINT_SECONDS = Math.round(POLL_INTERVAL_MS / 1_000)

/** Floating-entry geometry (kept in one place so drag + panel anchoring agree). */
const BALL_SIZE = 56
const BALL_MARGIN = 8
const PANEL_WIDTH = 420
const PANEL_MAX_HEIGHT = 660
/** Distance between the ball and the panel when it opens. */
const PANEL_GAP = 12
/** Pointer travel (px) before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 4

/** Task statuses surfaced as compact chips in the panel status bar. */
const TASK_CHIP_ORDER = ['running', 'proposed', 'queued', 'blocked', 'review'] as const

/** One task-status count, sourced from `counts` and falling back to `tasks`. */
interface TaskChip {
  status: string
  count: number
}

function taskChips(tasks: readonly TaskView[], counts: Record<string, number>): TaskChip[] {
  const rows: TaskChip[] = []
  for (const status of TASK_CHIP_ORDER) {
    const listed = counts[status]
    const count = typeof listed === 'number' ? listed : tasks.filter(task => task.status === status).length
    if (count > 0) rows.push({ status, count })
  }
  return rows.slice(0, 3)
}

function viewportSize(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1280, h: 800 }
  return { w: window.innerWidth || 1280, h: window.innerHeight || 800 }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Normalized center of the default corner entry (`br`/`bl`). */
function cornerCenter(position: 'br' | 'bl', viewport: { w: number; h: number }): { x: number; y: number } {
  const left = position === 'bl' ? 24 : viewport.w - 24 - BALL_SIZE
  return { x: (left + BALL_SIZE / 2) / viewport.w, y: (viewport.h - 24 - BALL_SIZE / 2) / viewport.h }
}

/** Normalized center → clamped top-left px inside the viewport. */
function ballPixels(center: { x: number; y: number }, viewport: { w: number; h: number }): { left: number; top: number } {
  return {
    left: Math.round(clamp(center.x * viewport.w - BALL_SIZE / 2, BALL_MARGIN, Math.max(BALL_MARGIN, viewport.w - BALL_SIZE - BALL_MARGIN))),
    top: Math.round(clamp(center.y * viewport.h - BALL_SIZE / 2, BALL_MARGIN, Math.max(BALL_MARGIN, viewport.h - BALL_SIZE - BALL_MARGIN))),
  }
}

/** Local record of the confirmation-card action already sent for one decision. */
interface DispatchSent {
  decisionId: string
  taskId: string
  kind: DispatchActionKind
}

function formatTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Longest system line shown before it collapses (task-38: system messages fold). */
const SYSTEM_FOLD_CHARS = 120

/** Parsed `[dispatch-confirm]` protocol message (kept out of the chat bubble). */
interface DispatchDecisionView {
  action: string
  mode: string
  sessionId?: string
  raw: string
}

/** Parse the dispatch-confirm user message into its structured record, if it is one. */
function parseDispatchDecision(text: string): DispatchDecisionView | null {
  if (!text.startsWith('[dispatch-confirm]')) return null
  const lines = text.split(/\r?\n/)
  const first = lines[0] ?? ''
  const action = first.slice('[dispatch-confirm]'.length).trim()
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  const target = fields.target ?? ''
  const mode = /(?:^|;)mode:([^;]+)/.exec(target)?.[1] ?? ''
  const sessionId = /(?:^|;)sessionId:([^;]+)/.exec(target)?.[1]
  return {
    action,
    mode,
    ...(sessionId === undefined ? {} : { sessionId }),
    raw: text,
  }
}

/** Human label for a `[dispatch-confirm]` action. */
function decisionActionLabel(action: string, t: (key: string) => string): string {
  if (action.includes('采用') || /adopt/iu.test(action)) return t('decision.action.adopt')
  if (action.includes('自定义') || /custom/iu.test(action)) return t('decision.action.custom')
  if (action.includes('取消') || /cancel/iu.test(action)) return t('decision.action.cancel')
  return action
}

/** Target line for a decision record: mode + short session, never the raw target string. */
function decisionTargetLabel(record: DispatchDecisionView, t: (key: string) => string): string {
  if (record.mode === 'attach') {
    return record.sessionId === undefined
      ? t('dispatch.mode.attach')
      : `${t('dispatch.mode.attach')} ${shortSessionId(record.sessionId)}`
  }
  if (record.mode === 'new') return t('dispatch.mode.new')
  return ''
}

/** One collapsed dispatch decision record in the transcript. */
function DecisionRecordRow({ record, at, t }: {
  record: DispatchDecisionView
  at: number
  t: (key: string) => string
}): ReactNode {
  const target = decisionTargetLabel(record, t)
  return (
    <details className="dshc-decision" title={t('decision.rawHint')}>
      <summary className="dshc-decision-head">
        <span className="dshc-decision-icon" aria-hidden>✓</span>
        <span className="dshc-decision-title">{t('decision.title')}</span>
        <span className="dshc-decision-action">{decisionActionLabel(record.action, t)}</span>
        {target === '' ? null : <span className="dshc-decision-target">{target}</span>}
        <span className="dshc-decision-time">{formatTime(at)}</span>
      </summary>
      <div className="dshc-decision-raw">
        <div className="dshc-decision-raw-caption">{t('decision.rawTitle')}</div>
        <pre>{record.raw}</pre>
      </div>
    </details>
  )
}

/** One transcript row (user / assistant / local system notice). */
function MessageRow({ message, t }: { message: ChatMessage; t: (key: string) => string }): ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  // 与普通会话一致：assistant 回复走 Markdown（命令来自 Web 壳内置 primitives）。
  const labels = React.useMemo(() => markdownLabels(t), [t])
  if (message.role === 'system') {
    const foldable = message.text.length > SYSTEM_FOLD_CHARS
    const text = foldable && !expanded ? `${message.text.slice(0, SYSTEM_FOLD_CHARS)}…` : message.text
    return (
      <div className="dshc-msg" data-role="system">
        <span className="dshc-bubble">{text}</span>
        {foldable ? (
          <button
            type="button"
            className="dshc-msg-toggle"
            onClick={() => { setExpanded(value => !value) }}
          >
            {expanded ? t('message.collapse') : t('message.expand')}
          </button>
        ) : null}
      </div>
    )
  }
  if (message.role === 'user') {
    const record = parseDispatchDecision(message.text)
    if (record !== null) return <DecisionRecordRow record={record} at={message.at} t={t} />
  }
  const interpreted = interpretCommanderMessage(message.role, message.text)
  if (interpreted.kind !== 'plain') {
    const meta = parseMetadata(interpreted.meta)
    const foldable = interpreted.body.length > SYSTEM_FOLD_CHARS
    const body = foldable && !expanded ? `${interpreted.body.slice(0, SYSTEM_FOLD_CHARS)}…` : interpreted.body
    return (
      <div className="dshc-system-card" data-kind={interpreted.kind}>
        <div className="dshc-system-card-head">
          <span className="dshc-system-card-title">
            {interpreted.kind === 'session-reply' ? t('system.sessionReply') : t('system.boardEdit')}
          </span>
          {meta.taskId === undefined ? null : <span className="dshc-system-card-meta">{`${t('system.task')} ${meta.taskId}`}</span>}
          {meta.sessionId === undefined ? null : <span className="dshc-system-card-meta">{`${t('system.session')} ${meta.sessionId}`}</span>}
        </div>
        {foldable && !expanded
          ? <div className="dshc-system-card-body">{body}</div>
          : interpreted.kind === 'session-reply'
            // 注入的最后一轮回复本身就是 Markdown：展开后与普通会话同款渲染（折叠态仍按纯文本截断）。
            ? <div className="dshc-system-card-body dshc-system-card-body--markdown"><MarkdownText text={interpreted.body} labels={labels} /></div>
            : <div className="dshc-system-card-body">{body}</div>}
        {foldable ? (
          <button type="button" className="dshc-msg-toggle" onClick={() => { setExpanded(value => !value) }}>
            {expanded ? t('message.collapse') : t('message.expand')}
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="dshc-msg" data-role={message.role} data-pending={message.pending === true ? 'true' : undefined}>
      {message.role === 'assistant' ? <span className="dshc-msg-author">{t('panel.assistant')}</span> : null}
      {message.role === 'assistant'
        ? <div className="dshc-bubble dshc-bubble--markdown"><MarkdownText text={message.text} labels={labels} /></div>
        : <div className="dshc-bubble">{message.text}</div>}
      <span className="dshc-msg-time">
        {message.pending === true ? t('panel.pending') : formatTime(message.at)}
        {message.truncated === true ? ` · ${t('panel.truncated')}` : ''}
      </span>
    </div>
  )
}

/** Render the ball and, when open, the command panel. */
export function CommanderOverlay({ store, t, openBoard, sessionStatus, openSession }: CommanderOverlayProps): ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sendError, setSendError] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => Date.now())
  const [dispatchSending, setDispatchSending] = React.useState(false)
  const [dispatchSent, setDispatchSent] = React.useState<DispatchSent | null>(null)
  const [cardError, setCardError] = React.useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [statusOpen, setStatusOpen] = React.useState(false)
  const [approvalBusyKey, setApprovalBusyKey] = React.useState<string | null>(null)
  const [approvalError, setApprovalError] = React.useState<{ key: string; message: string } | null>(null)
  const [dismissedApprovals, setDismissedApprovals] = React.useState<string[]>([])
  const [questionBusyKey, setQuestionBusyKey] = React.useState<string | null>(null)
  const [questionError, setQuestionError] = React.useState<{ key: string; message: string } | null>(null)
  const [dismissedQuestions, setDismissedQuestions] = React.useState<string[]>([])
  const lastQuestionRef = React.useRef('')
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const lastDecisionRef = React.useRef('')
  const [viewport, setViewport] = React.useState(viewportSize)
  const [dragBox, setDragBox] = React.useState<{ left: number; top: number } | null>(null)
  const dragRef = React.useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null>(null)
  const suppressClickRef = React.useRef(false)

  // Keep the free position inside the viewport when the window resizes.
  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => { setViewport(viewportSize()) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  const status = state.commanderStatus
  const bound = status === 'bound' || status === 'unknown'
  const position = state.ui.entryPosition === 'bl' ? 'bl' : 'br'
  const entryEnabled = state.ui.entryEnabled !== false
  const entryCenter = state.ui.entryPos ?? cornerCenter(position, viewport)
  const ballBox = dragBox ?? ballPixels(entryCenter, viewport)
  const panelWidth = Math.min(PANEL_WIDTH, viewport.w - BALL_MARGIN * 2)
  const panelHeight = Math.min(PANEL_MAX_HEIGHT, viewport.h - 120)
  const notice = sendError === null ? state.notice : { kind: 'error' as const, text: sendError }
  const pending = state.pendingDispatch
  const pendingDecisionId = pending === null ? '' : decisionIdOf(pending)
  // A sent action only counts while its decision is still the pending one.
  const actionSent = pendingDecisionId !== '' && dispatchSent !== null && dispatchSent.decisionId === pendingDecisionId

  // M3: approvals come from the official uiSession status (same PendingApproval
  // instance the conversation renders); badges are derived from state only.
  const statusSource = sessionStatus ?? EMPTY_SESSION_STATUS
  const sessionStatuses = React.useSyncExternalStore(
    statusSource.subscribe, statusSource.getSnapshot, statusSource.getSnapshot,
  )
  const approvals = selectPendingApprovals(sessionStatuses, state.workSessions ?? [])
    .filter(item => !dismissedApprovals.includes(item.approvalKey))
  // ask_user_question：同一份 uiSession 投影里 kind=question/plan-review 的 pending interaction。
  const questions = selectPendingQuestions(sessionStatuses, state.workSessions ?? [], state.binding?.sessionId)
    .filter(item => !dismissedQuestions.includes(item.questionKey))
  const actionableCount = (pending !== null && !actionSent ? 1 : 0) + approvals.length + questions.length
  const badgeInput = {
    hasPendingDispatch: pending !== null && !actionSent,
    approvalCount: approvals.length,
    counts: state.counts,
    tasks: state.tasks,
  }
  const badge = deriveCommanderBadge(badgeInput)
  // The ball badge counts every actionable item, not just the highest-priority
  // kind; the sheet/FAB use the same number.
  const ballBadge = badge === null ? null : { kind: badge.kind, count: actionableCount > 0 ? actionableCount : badge.count }
  const binding = state.binding
  const bindingSessionId = binding?.sessionId ?? ''
  const bindingSessionLabel = bindingSessionId === '' ? '' : shortSessionId(bindingSessionId)
  const bindingWorkspace = binding?.workspaceId === undefined
    ? undefined
    : state.workspaces.find(workspace => workspace.id === binding.workspaceId)
  const bindingWorkspaceLabel = bindingWorkspace === undefined
    ? (binding?.workspaceId ?? '')
    : workspaceLabel(bindingWorkspace)
  const bindingModel = binding?.model?.model ?? ''
  const statusLabel = t(`status.${status}`)
  const statusHeadline = bound && bindingSessionLabel !== '' ? `${statusLabel} · ${bindingSessionLabel}` : statusLabel
  const connectionLabel = t(`conn.${state.connection}`)
  const connShortKey = state.connection === 'live'
    ? 'panel.conn.live'
    : state.connection === 'polling'
      ? 'panel.conn.polling'
      : state.connection === 'offline'
        ? 'panel.conn.offline'
        : state.connection === 'connecting' || state.connection === 'reconnecting'
          ? 'panel.conn.connecting'
          : 'panel.conn.idle'
  const chips = taskChips(state.tasks, state.counts)
  const ballSub = actionableCount > 0
    ? `${String(actionableCount)} ${t('panel.pendingSuffix')}`
    : !bound
      ? statusLabel
      : actionSent && pending !== null
        ? t('panel.dispatchWaiting')
      : ballBadge !== null
        ? `${String(ballBadge.count)} ${t('panel.pendingSuffix')}`
        : state.busy
          ? t('panel.processing')
          : state.connection !== 'live'
            ? connectionLabel
            : t('panel.waitingForCommand')
  const ballAria = `${t('ball.aria')}${actionableCount > 0 ? ` · ${String(actionableCount)} ${t('panel.pendingSuffix')}` : ''}`
  const ballLabelSide = ballBox.left < 220 ? 'right' : 'left'

  // Escape closes the front-most layer first (status popover → sheet → panel).
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (statusOpen) {
        setStatusOpen(false)
        return
      }
      if (sheetOpen) {
        setSheetOpen(false)
        return
      }
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [open, statusOpen, sheetOpen])

  // Focus the composer only when the sheet is not covering it.
  React.useEffect(() => {
    if (open && !sheetOpen) inputRef.current?.focus()
  }, [open, sheetOpen])

  // Countdown for the confirmation card (expiresAt → grey out, per m1 patch §2.3).
  const expiresAt = pending?.expiresAt
  React.useEffect(() => {
    if (expiresAt === undefined || typeof expiresAt !== 'number') return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [expiresAt])

  // A new pending decision opens the panel and its sheet; confirmation is the
  // one action that must not wait behind a FAB.
  React.useEffect(() => {
    if (pendingDecisionId === '') {
      lastDecisionRef.current = ''
      return
    }
    if (pendingDecisionId === lastDecisionRef.current) return
    lastDecisionRef.current = pendingDecisionId
    setOpen(true)
    setSheetOpen(true)
    setStatusOpen(false)
    setNow(Date.now())
    setCardError(null)
    setDispatchSent(null)
  }, [pendingDecisionId])

  // A new commander question blocks the next turn: surface the sheet so it is
  // answerable from the floating panel (the main composer card still works too).
  const commanderQuestionKey = questions.find(item => item.commander)?.questionKey
  React.useEffect(() => {
    if (commanderQuestionKey === undefined) return
    if (lastQuestionRef.current === commanderQuestionKey) return
    lastQuestionRef.current = commanderQuestionKey
    setOpen(true)
    setSheetOpen(true)
    setStatusOpen(false)
  }, [commanderQuestionKey])

  // Close the sheet once the Host has cleared every pending action; keep it
  // open while a dispatched decision is still awaiting its receipt.
  React.useEffect(() => {
    if (!sheetOpen) return
    if (pending !== null || approvals.length > 0 || questions.length > 0) return
    const timer = setTimeout(() => { setSheetOpen(false) }, 900)
    return () => { clearTimeout(timer) }
  }, [sheetOpen, pending, approvals.length, questions.length])

  // Keep the transcript pinned to the newest message while open.
  React.useEffect(() => {
    if (!open) return
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [open, state.messages.length, state.busy, pendingDecisionId])

  const runDispatchAction = (kind: DispatchActionKind, target?: DispatchTarget): void => {
    if (pending === null || dispatchSending || actionSent) return
    const text = buildDispatchActionMessage(kind, pending, target)
    setDispatchSending(true)
    setCardError(null)
    void store.send(text).then(result => {
      setDispatchSending(false)
      if (!result.ok) {
        setCardError(result.failure.message)
        return
      }
      setDispatchSent({ decisionId: pendingDecisionId, taskId: taskIdOf(pending), kind })
    })
  }

  const answerQuestion = (item: PendingQuestionItem, answer: QuestionAnswerPayload): void => {
    if (questionBusyKey !== null) return
    setQuestionBusyKey(item.questionKey)
    setQuestionError(null)
    const pending = item.question
    if (typeof pending.answer !== 'function') {
      setQuestionBusyKey(null)
      return
    }
    void pending.answer(answer).then(() => {
      setQuestionBusyKey(null)
      // 请求已结算；投影可能一拍后才清 pendingInteraction，先在本地收起避免重复提交。
      setDismissedQuestions(current => (current.includes(item.questionKey) ? current : [...current, item.questionKey]))
    }).catch((error: unknown) => {
      setQuestionBusyKey(null)
      if (isAlreadySettled(error)) return
      setQuestionError({
        key: item.questionKey,
        message: error instanceof Error ? error.message : t('question.failed'),
      })
    })
  }

  const answerApproval = (item: PendingApprovalItem, outcome: 'allowed-once' | 'rejected'): void => {
    if (approvalBusyKey !== null) return
    setApprovalBusyKey(item.approvalKey)
    setApprovalError(null)
    void answerPendingApproval(item.approval, outcome).then(result => {
      setApprovalBusyKey(null)
      if (result.ok || result.reason === 'already-settled' || result.reason === 'not-answerable') {
        // Answered here, answered elsewhere, or withdrawn: drop our view; the
        // session-status observable removes the entry for every other view too.
        setDismissedApprovals(current => (current.includes(item.approvalKey) ? current : [...current, item.approvalKey]))
        return
      }
      setApprovalError({ key: item.approvalKey, message: result.message ?? t('approval.failed') })
    })
  }

  const submit = (): void => {
    if (state.sending || !bound) return
    const text = draft
    if (text.trim() === '') return
    if (text.trim().length > MESSAGE_MAX_CHARS) {
      setSendError(t('panel.tooLong'))
      return
    }
    setSendError(null)
    setDraft('')
    if (inputRef.current !== null) inputRef.current.style.height = 'auto'
    void store.send(text).then(result => {
      if (result.ok) return
      setDraft(text)
      setSendError(result.failure.message)
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  const dismissNotice = (): void => {
    setSendError(null)
    store.clearNotice()
  }

  const retryNotice = (): void => {
    setSendError(null)
    store.clearNotice()
    void store.refresh()
  }

  const togglePanel = (): void => {
    if (open) {
      setOpen(false)
      setSheetOpen(false)
      setStatusOpen(false)
      return
    }
    setOpen(true)
    if (actionableCount > 0) setSheetOpen(true)
  }

  const openStatus = (): void => {
    setStatusOpen(value => !value)
    setSheetOpen(false)
  }

  const openSessionFrom = (sessionId: string): void => {
    openSession?.(sessionId)
    setOpen(false)
    setSheetOpen(false)
    setStatusOpen(false)
  }

  const connectionText = t(`conn.${state.connection}`)
  const hintTone = state.connection === 'offline' ? 'error' : state.connection === 'polling' ? 'warn' : ''
  // 用户已点确认：确认卡立即收起，只留一行「已发送确认，等待指挥官处理」状态。
  const sentInfo = dispatchSent
  const sentTask = sentInfo === null ? undefined : state.tasks.find(task => task.id === sentInfo.taskId)
  const sentStillPending = actionSent
  const sentText = sentInfo === null
    ? ''
    : sentInfo.kind === 'cancel'
      ? t('dispatch.cancelSent')
      : sentStillPending || sentTask?.status === undefined || sentTask.status === 'proposed' || sentTask.status === 'draft'
        ? t('dispatch.waiting')
        : `${t('dispatch.updated')}：${t(taskStatusLabelKey(sentTask.status))}`

  const panelLeft = clamp(
    ballBox.left + BALL_SIZE + PANEL_GAP + panelWidth <= viewport.w - BALL_MARGIN
      ? ballBox.left + BALL_SIZE + PANEL_GAP
      : ballBox.left - panelWidth - PANEL_GAP,
    BALL_MARGIN,
    viewport.w - panelWidth - BALL_MARGIN,
  )
  const aboveBall = ballBox.top - panelHeight - PANEL_GAP
  const belowBall = ballBox.top + BALL_SIZE + PANEL_GAP
  const panelTop = clamp(
    aboveBall >= BALL_MARGIN ? aboveBall : belowBall,
    BALL_MARGIN,
    viewport.h - panelHeight - BALL_MARGIN,
  )

  /** 按下：记录起点；移动超过阈值才升级为拖动（否则仍是一次点击开/关面板）。 */
  const onBallPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    suppressClickRef.current = false
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: ballBox.left,
      top: ballBox.top,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onBallPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
    drag.moved = true
    setDragBox({
      left: clamp(drag.left + dx, BALL_MARGIN, Math.max(BALL_MARGIN, viewport.w - BALL_SIZE - BALL_MARGIN)),
      top: clamp(drag.top + dy, BALL_MARGIN, Math.max(BALL_MARGIN, viewport.h - BALL_SIZE - BALL_MARGIN)),
    })
  }

  const endBallDrag = (event: React.PointerEvent<HTMLButtonElement>, commit: boolean): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!drag.moved) {
      setDragBox(null)
      return
    }
    suppressClickRef.current = true
    const left = clamp(drag.left + (event.clientX - drag.startX), BALL_MARGIN, Math.max(BALL_MARGIN, viewport.w - BALL_SIZE - BALL_MARGIN))
    const top = clamp(drag.top + (event.clientY - drag.startY), BALL_MARGIN, Math.max(BALL_MARGIN, viewport.h - BALL_SIZE - BALL_MARGIN))
    setDragBox(null)
    if (commit) {
      // 归一化保存（窗口大小变化后仍停在相对位置）；Host 失败会提示但本地位置保留。
      void store.saveEntryPos({
        x: (left + BALL_SIZE / 2) / viewport.w,
        y: (top + BALL_SIZE / 2) / viewport.h,
      })
    }
  }

  const hint = state.connection === 'polling'
    ? `${t('conn.polling')}（${POLL_HINT_SECONDS}s）`
    : state.connection === 'offline'
      ? `${connectionText} · ${t('panel.retry')}`
      : t('panel.hint')

  // 关闭浮窗 → 整个 overlay（含面板）不渲染；设置页可再次开启（默认开启）。
  if (!entryEnabled) return null

  // M4：桌面原生壳 running 时隐藏页内球（入口交给桌面球）；审批卡/面板保留。
  const hideBall = state.nativeShell === 'running'

  return (
    <React.Fragment>
      <style>{STYLES}</style>

      <button
        type="button"
        className="dshc-ball dshc-root"
        data-status={status}
        data-open={open ? 'true' : 'false'}
        data-busy={state.busy ? 'true' : 'false'}
        data-conn={state.connection}
        data-label-side={ballLabelSide}
        data-dragging={dragBox === null ? 'false' : 'true'}
        style={{ left: ballBox.left, top: ballBox.top, right: 'auto', bottom: 'auto', ...(hideBall ? { display: 'none' } : {}) }}
        aria-label={ballAria}
        aria-expanded={open}
        onPointerDown={onBallPointerDown}
        onPointerMove={onBallPointerMove}
        onPointerUp={event => { endBallDrag(event, true) }}
        onPointerCancel={event => { endBallDrag(event, false) }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          togglePanel()
        }}
      >
        <svg className="dshc-ball-mark" viewBox="0 0 24 24" aria-hidden="true">
          <path className="dshc-ball-mark-pole" d="M7.7 4.5v15" />
          <path className="dshc-ball-mark-flag" d="M9.4 5.4h8.3l-2.5 3.4 2.5 3.2H9.4z" />
        </svg>
        {ballBadge === null ? null : (
          <span
            className="dshc-ball-badge"
            data-kind={ballBadge.kind}
            title={actionableCount > 0 ? t('ball.badge.pending') : t(badgeLabelKey(ballBadge.kind))}
          >{ballBadge.count}</span>
        )}
        {state.connection === 'live' ? null : (
          <span className="dshc-ball-state" data-tone={state.connection} title={connectionLabel} />
        )}
      </button>

      <span
        className="dshc-ball-label"
        aria-hidden="true"
        data-open={open ? 'true' : 'false'}
        style={{
          left: ballLabelSide === 'left' ? ballBox.left - 10 : ballBox.left + BALL_SIZE + 10,
          top: ballBox.top + BALL_SIZE / 2,
          transform: ballLabelSide === 'left' ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
          ...(hideBall ? { display: 'none' } : {}),
        }}
      >
        <span className="dshc-ball-label-title">{t('panel.title')}</span>
        <span className="dshc-ball-label-sub">{ballSub}</span>
      </span>

      {open ? (
        <section
          className="dshc-panel dshc-root"
          style={{ left: panelLeft, top: panelTop, right: 'auto', bottom: 'auto', width: panelWidth, maxHeight: panelHeight }}
          role="dialog"
          aria-label={t('panel.title')}
        >
          <header className="dshc-panel-header">
            <span className="dshc-panel-title">{t('panel.title')}</span>
            <span className="dshc-panel-head-fill" />
            <button
              type="button"
              className="dshc-icon-button"
              title={openBoard === undefined ? t('panel.boardSoon') : t('panel.board')}
              aria-label={t('panel.board')}
              disabled={openBoard === undefined}
              onClick={openBoard === undefined ? undefined : () => { openBoard() }}
            >
              <Icon paths={ICON_BOARD} />
            </button>
            <button
              type="button"
              className="dshc-icon-button"
              title={t('panel.close')}
              aria-label={t('panel.close')}
              onClick={() => { setOpen(false); setSheetOpen(false); setStatusOpen(false) }}
            >
              <Icon paths={ICON_CLOSE} />
            </button>
          </header>

          <button
            type="button"
            className="dshc-statusbar"
            onClick={openStatus}
            aria-expanded={statusOpen}
            aria-label={t('panel.status.sub')}
            title={bindingSessionId === '' ? statusLabel : bindingSessionId}
          >
            <span className="dshc-status-dot" data-status={status} />
            <span className="dshc-status-session">{statusHeadline}</span>
            {chips.length === 0 ? null : (
              <span className="dshc-status-chips">
                {chips.map(chip => (
                  <span key={chip.status} className="dshc-chip" data-status={chip.status}>
                    {`${t(taskStatusLabelKey(chip.status))} ${String(chip.count)}`}
                  </span>
                ))}
              </span>
            )}
            <span className="dshc-status-conn" data-conn={state.connection}>{t(connShortKey)}</span>
            <span className="dshc-status-chevron"><Icon paths={ICON_CHEVRON_DOWN} size={12} /></span>
          </button>

          {notice !== null ? (
            <div className="dshc-banner" data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
              <span className="dshc-banner-text">{notice.text}</span>
              <span className="dshc-banner-actions">
                {notice.kind === 'error' ? (
                  <button type="button" className="dshc-button" data-variant="ghost" data-size="sm" onClick={retryNotice}>
                    <Icon paths={ICON_REFRESH} size={13} />{t('panel.retry')}
                  </button>
                ) : null}
                <button type="button" className="dshc-button" data-variant="ghost" data-size="sm" onClick={dismissNotice}>
                  {t('panel.dismiss')}
                </button>
              </span>
            </div>
          ) : null}

          {!bound ? (
            <div className="dshc-banner" data-kind="ok" role="status">
              <span className="dshc-banner-text">{t('panel.bindingHint')}</span>
            </div>
          ) : null}

          {sentInfo === null || !actionSent || sheetOpen ? null : (
            <div className="dshc-dispatch-sent dshc-dispatch-sent--strip" role="status">{sentText}</div>
          )}

          <div className="dshc-panel-body" data-fab={actionableCount > 0 && !sheetOpen ? 'true' : undefined} ref={listRef}>
            {state.messages.length === 0 ? <div className="dshc-empty">{t('panel.empty')}</div> : null}
            {state.messages.map(message => <MessageRow key={message.id} message={message} t={t} />)}
            {state.busy ? (
              <div className="dshc-msg" data-role="system">
                <span className="dshc-bubble">{t('panel.busy')}</span>
              </div>
            ) : null}
          </div>

          <footer className="dshc-composer">
            {actionableCount > 0 && !sheetOpen ? (
              <button
                type="button"
                className="dshc-pending-fab"
                onClick={() => { setSheetOpen(true); setStatusOpen(false) }}
              >
                <Icon paths={ICON_INBOX} size={13} />
                <span>{`${String(actionableCount)} ${t('panel.pendingSuffix')}`}</span>
                <Icon paths={ICON_CHEVRON_UP} size={12} />
              </button>
            ) : null}
            <textarea
              ref={inputRef}
              className="dshc-input"
              value={draft}
              rows={1}
              placeholder={t('panel.placeholder')}
              aria-label={t('panel.placeholder')}
              onChange={event => {
                setDraft(event.target.value)
                if (sendError !== null) setSendError(null)
                const node = event.target
                node.style.height = 'auto'
                node.style.height = `${Math.min(node.scrollHeight, 112)}px`
              }}
              onKeyDown={onKeyDown}
            />
            <div className="dshc-composer-row">
              <span className="dshc-composer-hint" data-tone={hintTone}>{hint}</span>
              {draft.length > 7_000 ? (
                <span className="dshc-composer-hint" data-tone={draft.length > MESSAGE_MAX_CHARS ? 'error' : 'warn'}>
                  {`${draft.length}/${MESSAGE_MAX_CHARS}`}
                </span>
              ) : null}
              <button
                type="button"
                className="dshc-button"
                data-variant="primary"
                disabled={state.sending || !bound || draft.trim() === ''}
                onClick={submit}
              >
                {state.sending ? t('panel.sending') : t('panel.send')}
              </button>
            </div>
          </footer>

          {statusOpen ? (
            <div className="dshc-status-layer">
              <div className="dshc-status-scrim" onClick={() => { setStatusOpen(false) }} />
              <section className="dshc-status-pop" role="dialog" aria-label={t('panel.status.title')}>
                <div className="dshc-status-pop-head">
                  <span className="dshc-status-pop-title">{t('panel.status.title')}</span>
                  <span className="dshc-status-pop-sub">{t('panel.status.sub')}</span>
                  <button
                    type="button"
                    className="dshc-icon-button"
                    title={t('panel.close')}
                    aria-label={t('panel.close')}
                    onClick={() => { setStatusOpen(false) }}
                  >
                    <Icon paths={ICON_CLOSE} size={14} />
                  </button>
                </div>

                <div className="dshc-status-block">
                  <div className="dshc-status-label">{t('panel.status.binding')}</div>
                  <dl className="dshc-status-kv">
                    <dt>{t('panel.binding.session')}</dt>
                    <dd>{bindingSessionId === '' ? statusLabel : bindingSessionId}</dd>
                    <dt>{t('panel.binding.workspace')}</dt>
                    <dd>{bindingWorkspaceLabel === '' ? '—' : bindingWorkspaceLabel}</dd>
                    <dt>{t('panel.binding.model')}</dt>
                    <dd>{bindingModel === '' ? '—' : bindingModel}</dd>
                    <dt>{t('panel.binding.connection')}</dt>
                    <dd>{connectionLabel}</dd>
                  </dl>
                  <div className="dshc-status-actions">
                    {bindingSessionId === '' || openSession === undefined ? null : (
                      <button
                        type="button"
                        className="dshc-button"
                        data-variant="secondary"
                        data-size="sm"
                        onClick={() => { openSessionFrom(bindingSessionId) }}
                      >
                        <Icon paths={ICON_EXTERNAL} size={12} />{t('panel.binding.open')}
                      </button>
                    )}
                    <span className="dshc-status-hint">{t('panel.binding.rebindHint')}</span>
                  </div>
                </div>

                <div className="dshc-status-block">
                  <div className="dshc-status-label">{t('panel.status.tasks')}</div>
                  {state.tasks.length === 0 ? <div className="dshc-status-hint">{t('panel.status.noTasks')}</div> : (
                    <div className="dshc-status-tasks">
                      {state.tasks.slice(0, 6).map(task => (
                        <div className="dshc-status-task" key={task.id}>
                          <span className="dshc-status-task-name" title={task.title ?? task.id}>{task.title ?? task.id}</span>
                          <span className="dshc-chip" data-status={task.status ?? ''}>{t(taskStatusLabelKey(task.status))}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="dshc-status-block">
                  <div className="dshc-status-label">{t('panel.status.connection')}</div>
                  <div className="dshc-status-conn-line" data-conn={state.connection}>{connectionLabel}</div>
                </div>
              </section>
            </div>
          ) : null}

          {sheetOpen ? (
            <div className="dshc-sheet-layer">
              <div className="dshc-sheet-scrim" onClick={() => { setSheetOpen(false) }} />
              <section className="dshc-sheet" role="dialog" aria-modal="true" aria-label={t('panel.sheet.title')}>
                <div className="dshc-sheet-grab" />
                <div className="dshc-sheet-head">
                  <span className="dshc-sheet-title">
                    {t('panel.sheet.title')}
                    {actionableCount === 0 ? null : <span className="dshc-sheet-count">{actionableCount}</span>}
                  </span>
                  <span className="dshc-sheet-sub">{t('panel.sheet.sub')}</span>
                  <button
                    type="button"
                    className="dshc-icon-button"
                    title={t('panel.sheet.close')}
                    aria-label={t('panel.sheet.close')}
                    onClick={() => { setSheetOpen(false) }}
                  >
                    <Icon paths={ICON_CHEVRON_DOWN} size={16} />
                  </button>
                </div>

                <div className="dshc-sheet-body">
                  {sentInfo === null || !actionSent ? null : (
                    <div className="dshc-dispatch-sent" role="status">{sentText}</div>
                  )}
                  {pending !== null && !actionSent ? (
                    <DispatchConfirmCard
                      pending={pending}
                      state={state}
                      t={t}
                      now={now}
                      sending={dispatchSending}
                      actionSent={actionSent}
                      error={cardError}
                      listSessions={store.listSessions}
                      compact
                      onAction={(kind, target) => { runDispatchAction(kind, target) }}
                    />
                  ) : null}
                  {approvals.map((item, index) => {
                    const taskTitle = state.tasks.find(task => task.id === item.taskId)?.title ?? item.taskId
                    const sessionTitle = item.title ?? item.sessionId
                    return (
                      <ApprovalFloatCard
                        key={item.approvalKey}
                        item={item}
                        index={index}
                        total={approvals.length}
                        showQueue={false}
                        t={t}
                        taskTitle={taskTitle}
                        sessionTitle={sessionTitle}
                        answering={approvalBusyKey === item.approvalKey}
                        error={approvalError !== null && approvalError.key === item.approvalKey ? approvalError.message : null}
                        onAnswer={outcome => { answerApproval(item, outcome) }}
                        onOpenSession={() => { openSessionFrom(item.sessionId) }}
                        onPrev={() => {}}
                        onNext={() => {}}
                      />
                    )
                  })}
                  {questions.map((item, index) => {
                    return (
                      <QuestionCard
                        key={item.questionKey}
                        item={item}
                        index={index}
                        total={questions.length}
                        showQueue={false}
                        t={t}
                        busy={questionBusyKey === item.questionKey}
                        error={questionError !== null && questionError.key === item.questionKey ? questionError.message : null}
                        onAnswer={answer => { answerQuestion(item, answer) }}
                        onDismiss={() => {
                          setDismissedQuestions(current => (current.includes(item.questionKey) ? current : [...current, item.questionKey]))
                        }}
                        onOpenSession={() => { openSessionFrom(item.sessionId) }}
                        onPrev={() => {}}
                        onNext={() => {}}
                      />
                    )
                  })}
                  {actionableCount === 0 && sentInfo === null ? (
                    <div className="dshc-sheet-empty">{t('panel.sheet.empty')}</div>
                  ) : null}
                </div>

                <div className="dshc-sheet-foot">
                  <span>{t('panel.sheet.footer')}</span>
                  <span className="dshc-sheet-foot-fill" />
                  <button
                    type="button"
                    className="dshc-button"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => { setSheetOpen(false) }}
                  >
                    {t('panel.sheet.close')}
                  </button>
                </div>
              </section>
            </div>
          ) : null}
        </section>
      ) : null}
    </React.Fragment>
  )
}
