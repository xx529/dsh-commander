// 原生壳窗口页：球 ↔ 面板两态，面板内含「对话 / 看板」两个视图与条件接管的审批卡。
// 看板直接复用 DSH 页内的 BoardPage（五列泳道/拖拽/抽屉），对话复用 commander store。
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createCommanderStore, connectionLabel } from './store'
import { deriveCommanderBadge } from './approval'
import { getShellBridge, shellBoot } from './shell-bridge'
import { BoardPage } from './BoardPage'
import { CommanderSettingsSection } from './SettingsSection'
import { DICTIONARIES, fallbackTranslate } from './locales'
import { WindowMarkdown } from './window-markdown'
import { DispatchConfirmCard } from './DispatchCard'
import { ApprovalFloatCard } from './ApprovalFloat'
import { QuestionCard } from './QuestionCard'
import { interpretCommanderMessage, parseMetadata } from './system-message'
import type { ApprovalPendingLike, PendingApprovalItem } from './approval'
import type { PendingQuestionItem, PendingQuestionLike, QuestionAnswerPayload } from './questions'
import { buildDispatchActionMessage, decisionIdOf } from './dispatch'
import type { DispatchActionKind, DispatchTarget } from './dispatch'

const COPY = {
  zh: {
    title: '指挥官',
    bound: '已绑定',
    unbound: '未绑定指挥官会话',
    unboundHint: '先在 DSH 设置里绑定指挥官会话；绑定后这里就能直接下命令。',
    placeholder: '给指挥官下命令…',
    send: '发送',
    sending: '发送中…',
    empty: '还没有消息。说一句话，指挥官会判断派发到哪个工作区。',
    collapse: '收起',
    busy: '回合进行中',
    idle: '空闲',
    pending: '待处理',
    chat: '对话',
    board: '看板',
    back: '返回',
    allowOnce: '允许一次',
    reject: '拒绝',
    approval: '需要审批',
    thinking: '指挥官正在思考…',
    readonlyHint: '请在 DSH 中处理（两边同时可见，操作以 DSH 为准）',
  },
  en: {
    title: 'Commander',
    bound: 'Bound',
    unbound: 'No commander session',
    unboundHint: 'Bind a commander session in DSH settings first; then you can command it from here.',
    placeholder: 'Command the commander…',
    send: 'Send',
    sending: 'Sending…',
    empty: 'No messages yet. Say something and the commander will pick a workspace.',
    collapse: 'Collapse',
    busy: 'Turn running',
    idle: 'Idle',
    pending: 'pending',
    chat: 'Chat',
    board: 'Board',
    back: 'Back',
    allowOnce: 'Allow once',
    reject: 'Reject',
    approval: 'Approval needed',
    thinking: 'Commander is thinking…',
    readonlyHint: 'Handle this in DSH (visible in both places; answer in DSH)',
  },
} as const

type Copy = (typeof COPY)['zh'] | (typeof COPY)['en']

/** 窗口入口：带 `session` 参数时是只读会话窗口，否则是悬浮球/面板。 */
export function WindowApp() {
  const boot = useMemo(() => shellBoot(), [])
  if (boot.session !== '') return <SessionTranscriptApp sessionId={boot.session} />
  return <FloatingApp />
}

interface ApprovalView {
  id: string
  toolName: string
  reason: string
  at: number
  canAnswer?: boolean
}

interface QuestionOptionView {
  label: string
  description?: string
}

interface QuestionItemView {
  id: string
  question: string
  header?: string
  detail?: string
  options: QuestionOptionView[]
  multiSelect: boolean
}

interface QuestionBatchView {
  id: string
  questions: QuestionItemView[]
  at: number
  canAnswer?: boolean
}

/** 原生壳窗口根组件。 */
function FloatingApp() {
  const bridge = useMemo(() => getShellBridge(), [])
  const copy: Copy = COPY[bridge.locale]
  const t = useMemo(() => {
    const dictionary = (DICTIONARIES[bridge.locale] ?? DICTIONARIES.zh ?? {}) as Record<string, string>
    return (key: string): string => dictionary[key] ?? fallbackTranslate(key)
  }, [bridge.locale])
  const [store] = useState(() => createCommanderStore({ baseUrl: '' }))
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [expanded, setExpanded] = useState(() => shellBoot().panel === true)
  const [mode, setMode] = useState<'chat' | 'board'>('chat')
  const [text, setText] = useState('')
  const [approvals, setApprovals] = useState<ApprovalView[]>([])
  const [questions, setQuestions] = useState<QuestionBatchView[]>([])
  const [sheetOpen, setSheetOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dispatchSending, setDispatchSending] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)
  const [dispatchSent, setDispatchSent] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const pending = view.pendingDispatch
  const pendingKey = pending === null ? '' : decisionIdOf(pending)
  const todoCount = (pending !== null && !dispatchSent ? 1 : 0) + approvals.length + questions.length
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; moved: boolean; toggle: boolean } | null>(null)
  const messagesEnd = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])

  useEffect(() => bridge.onModeChange(setExpanded), [bridge])

  // ESC 全局收起：先关设置/抽屉，再收起面板（不依赖焦点在输入框）。
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (settingsOpen) {
        event.preventDefault()
        setSettingsOpen(false)
        return
      }
      if (sheetOpen) {
        event.preventDefault()
        setSheetOpen(false)
        return
      }
      if (expanded) {
        event.preventDefault()
        collapse()
      }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [expanded, settingsOpen, sheetOpen, bridge])

  // 失焦（点其他应用）时丢弃未完成的拖动，避免残留监听在下一次点击时误触发收起。
  useEffect(() => {
    const cancelDrag = (): void => {
      drag.current = null
      setDragging(false)
      window.removeEventListener('pointermove', onDragMove)
    }
    window.addEventListener('blur', cancelDrag)
    return () => window.removeEventListener('blur', cancelDrag)
  }, [])

  // 审批：初始补拉 + 独立 SSE（窗口页不依赖 DSH 的 uiSession）。
  useEffect(() => {
    let closed = false
    void fetch('/commander/native/approvals')
      .then((response) => response.json())
      .then((data: unknown) => {
        if (closed) return
        const list = (data as { approvals?: ApprovalView[] } | null)?.approvals
        if (Array.isArray(list)) setApprovals(list)
      })
      .catch(() => {})
    void fetch('/commander/native/questions')
      .then((response) => response.json())
      .then((data: unknown) => {
        if (closed) return
        const list = (data as { questions?: QuestionBatchView[] } | null)?.questions
        if (Array.isArray(list)) setQuestions(list)
      })
      .catch(() => {})
    const source = new EventSource('/commander/state')
    const onAsked = (event: MessageEvent): void => {
      try {
        const next = JSON.parse(event.data) as ApprovalView
        if (typeof next?.id !== 'string') return
        setApprovals((previous) => [...previous.filter((item) => item.id !== next.id), next])
      } catch {
        // ignore malformed frames
      }
    }
    const onResolved = (event: MessageEvent): void => {
      try {
        const payload = JSON.parse(event.data) as { id?: string }
        if (typeof payload?.id === 'string') setApprovals((previous) => previous.filter((item) => item.id !== payload.id))
      } catch {
        // ignore malformed frames
      }
    }
    const onQuestion = (event: MessageEvent): void => {
      try {
        const next = JSON.parse(event.data) as QuestionBatchView
        if (typeof next?.id !== 'string' || !Array.isArray(next.questions)) return
        setQuestions((previous) => [...previous.filter((item) => item.id !== next.id), next])
      } catch {
        // ignore malformed frames
      }
    }
    const onQuestionResolved = (event: MessageEvent): void => {
      try {
        const payload = JSON.parse(event.data) as { id?: string }
        if (typeof payload?.id === 'string') setQuestions((previous) => previous.filter((item) => item.id !== payload.id))
      } catch {
        // ignore malformed frames
      }
    }
    source.addEventListener('native.approval', onAsked)
    source.addEventListener('native.approval.resolved', onResolved)
    source.addEventListener('native.question', onQuestion)
    source.addEventListener('native.question.resolved', onQuestionResolved)
    return () => {
      closed = true
      source.close()
    }
  }, [])

  useEffect(() => {
    if (expanded && mode === 'chat') messagesEnd.current?.scrollIntoView({ block: 'end' })
  }, [expanded, mode, view.messages.length, view.busy])

  useEffect(() => {
    if (pendingKey === '') return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [pendingKey])

  useEffect(() => {
    setDispatchSent(false)
    setDispatchError(null)
  }, [pendingKey])

  useEffect(() => {
    if (todoCount > 0) setSheetOpen(true)
    else setSheetOpen(false)
  }, [todoCount])

  const badge = deriveCommanderBadge({
    hasPendingDispatch: view.pendingDispatch !== null,
    approvalCount: approvals.length,
    counts: view.counts,
    tasks: view.tasks,
  })
  const badgeCount = (badge?.count ?? 0) + questions.length
  const bound = view.binding !== null
  const sessionId = view.binding?.sessionId ?? ''
  const shortSession = sessionId.length > 14 ? `${sessionId.slice(0, 10)}…${sessionId.slice(-4)}` : sessionId

  const expand = (): void => {
    if (expanded) return
    setExpanded(true)
    void bridge.setMode('panel')
    // 展开后把键盘焦点交给输入框，ESC/输入无需先点一下。
    setTimeout(() => inputRef.current?.focus(), 220)
  }
  const collapse = (): void => {
    if (!expanded) return
    setExpanded(false)
    setMode('chat')
    void bridge.setMode('ball')
  }

  const beginDrag = (event: ReactPointerEvent, toggleOnClick: boolean): void => {
    if (!bridge.available || event.button !== 0) return
    // 标了 data-no-drag 的头部按钮不参与拖动；球自身没有标记，所以球仍然可以拖。
    const target = event.target as Element | null
    if (target?.closest('[data-no-drag]') !== null && target?.closest('[data-no-drag]') !== undefined) return
    drag.current = { x: event.clientX, y: event.clientY, moved: false, toggle: toggleOnClick }
    setDragging(true)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', endDrag, { once: true })
  }
  const onDragMove = (event: PointerEvent): void => {
    const current = drag.current
    if (current === null || current.moved) return
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 4) {
      current.moved = true
      void bridge.startDragging()
    }
  }
  const endDrag = (): void => {
    window.removeEventListener('pointermove', onDragMove)
    setDragging(false)
    const current = drag.current
    drag.current = null
    // 只有球点击才切换面板；面板头部点击/拖动只移动窗口，不收起。
    if (current !== null && !current.moved && current.toggle) {
      if (expanded) collapse()
      else expand()
    }
  }

  const submit = (): void => {
    const value = text.trim()
    if (value.length === 0 || view.sending) return
    setText('')
    void store.send(value)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const runDispatchAction = (kind: DispatchActionKind, target?: DispatchTarget): void => {
    if (pending === null || dispatchSending) return
    const text = buildDispatchActionMessage(kind, pending, target)
    setDispatchSending(true)
    setDispatchError(null)
    void store.send(text).then((result) => {
      setDispatchSending(false)
      if (!result.ok) {
        setDispatchError(result.failure.message)
        return
      }
      setDispatchSent(true)
    })
  }

  const submitQuestion = (id: string, payload: QuestionAnswerPayload): void => {
    setQuestions((previous) => previous.filter((item) => item.id !== id))
    void fetch(`/commander/native/question/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  }

  const answer = (id: string, outcome: 'allowed-once' | 'rejected'): void => {
    setApprovals((previous) => previous.filter((item) => item.id !== id))
    void fetch(`/commander/native/approval/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome }),
    }).catch(() => {})
  }

  if (!expanded) {
    return (
      <button
        type="button"
        className={`dshcn-ball${dragging ? ' is-dragging' : ''}`}
        data-bound={bound}
        data-busy={view.busy}
        title={badgeCount > 0 ? `${badgeCount} ${copy.pending}` : copy.title}
        onPointerDown={(event) => beginDrag(event, true)}
      >
        {badgeCount > 0 ? <span className="dshcn-badge">{badgeCount > 99 ? '99+' : badgeCount}</span> : <span className="dshcn-flag" aria-hidden="true" />}
        <span className="dshcn-dot" data-phase={view.connection} />
      </button>
    )
  }

  return (
    <section className="dshcn-panel" aria-label={copy.title}>
      <header className="dshcn-head" onPointerDown={(event) => beginDrag(event, false)}>
        <span className="dshcn-dot" data-phase={view.connection} />
        <div className="dshcn-title">
          {copy.title}
          <span className="dshcn-sub">
            {bound ? `${copy.bound} · ${shortSession}` : copy.unbound}
            {bridge.available ? '' : ' · IPC off'}
          </span>
        </div>
        <button
          type="button"
          className="dshcn-icon dshcn-mode"
          data-no-drag="true"
          onClick={() => setSettingsOpen(true)}
          title="设置"
        >
          设置
        </button>
        <button
          type="button"
          className="dshcn-icon dshcn-mode"
          data-no-drag="true"
          onClick={() => {
            const next = mode === 'chat' ? 'board' : 'chat'
            setMode(next)
            void bridge.setMode(next === 'board' ? 'board' : 'panel')
          }}
          title={mode === 'chat' ? copy.board : copy.chat}
        >
          {mode === 'chat' ? copy.board : copy.back}
        </button>
        <button type="button" className="dshcn-icon" data-no-drag="true" onClick={collapse} title={copy.collapse}>
          –
        </button>
      </header>

      {!bound ? <div className="dshcn-hint">{copy.unboundHint}</div> : null}

      {mode === 'board' ? (
        <div className="dshcn-board-wrap">
          <BoardPage
            store={store}
            t={t}
            closeBoard={() => { setMode('chat'); void bridge.setMode('panel') }}
            openSession={(sessionId) => { void bridge.openSessionWindow(sessionId) }}
          />
        </div>
      ) : (
        <>
          <div className="dshcn-messages">
            {view.messages.length === 0 ? <div className="dshcn-empty">{copy.empty}</div> : null}
            {view.messages.slice(-80).map((message) => {
              const interpreted = interpretCommanderMessage(message.role, message.text)
              if (interpreted.kind !== 'plain') {
                const meta = parseMetadata(interpreted.meta)
                return (
                  <article key={message.id} className="dshc-system-card" data-kind={interpreted.kind}>
                    <div className="dshc-system-card-head">
                      <span className="dshc-system-card-title">
                        {interpreted.kind === 'session-reply' ? t('system.sessionReply') : t('system.boardEdit')}
                      </span>
                      {meta.taskId === undefined ? null : <span className="dshc-system-card-meta">{`${t('system.task')} ${meta.taskId}`}</span>}
                      {meta.sessionId === undefined ? null : <span className="dshc-system-card-meta">{`${t('system.session')} ${meta.sessionId}`}</span>}
                    </div>
                    <div className="dshc-system-card-body">
                      {interpreted.kind === 'session-reply'
                        ? <WindowMarkdown text={interpreted.body} />
                        : interpreted.body}
                    </div>
                  </article>
                )
              }
              return (
                <article key={message.id} className={`dshcn-msg dshcn-msg-${message.role}`} data-pending={message.pending === true}>
                  {message.role === 'assistant'
                    ? <WindowMarkdown text={message.text} />
                    : <div className="dshcn-msg-text">{message.text}</div>}
                </article>
              )
            })}
            {view.busy ? (
              <div className="dshcn-typing" role="status" aria-label={copy.thinking}>
                <span className="dshcn-typing-dot" />
                <span className="dshcn-typing-dot" />
                <span className="dshcn-typing-dot" />
                <span>{copy.thinking}</span>
              </div>
            ) : null}
            <div ref={messagesEnd} />
          </div>

          {view.notice !== null ? <div className="dshcn-notice" data-kind={view.notice.kind}>{view.notice.text}</div> : null}

          <footer className="dshcn-compose">
            <textarea
              ref={inputRef}
              className="dshcn-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={copy.placeholder}
              rows={2}
              maxLength={8192}
            />
            <button type="button" className="dshcn-send" disabled={view.sending || text.trim().length === 0} onClick={submit}>
              {view.sending ? copy.sending : copy.send}
            </button>
          </footer>
          <div className="dshcn-foot">
            <span>{connectionLabel(view.connection)}</span>
            <span data-busy={view.busy}>{view.busy ? copy.busy : copy.idle}</span>
          </div>
        </>
      )}

      {todoCount > 0 && sheetOpen ? (
        <div className="dshc-sheet-layer">
          <div className="dshc-sheet-scrim" onClick={() => setSheetOpen(false)} />
          <section className="dshc-sheet" role="dialog" aria-modal="true" aria-label="待处理">
            <div className="dshc-sheet-grab" />
            <div className="dshc-sheet-head">
              <span className="dshc-sheet-title">
                待处理
                <span className="dshc-sheet-count">{todoCount}</span>
              </span>
              <span className="dshc-sheet-sub">派发确认 / 审批 / 提问</span>
            </div>
            <div className="dshc-sheet-body">
              {pending !== null && !dispatchSent ? (
                <DispatchConfirmCard
                  pending={pending}
                  state={view}
                  t={t}
                  now={now}
                  sending={dispatchSending}
                  actionSent={false}
                  error={dispatchError}
                  listSessions={store.listSessions}
                  compact
                  onAction={(kind, target) => runDispatchAction(kind, target)}
                />
              ) : null}
              {dispatchSent ? <div className="dshcn-notice">已发送确认，等待指挥官处理…</div> : null}
              {approvals.map((approval, index) => {
                const item: PendingApprovalItem = {
                  sessionId: '',
                  taskId: '',
                  approvalKey: approval.id,
                  approval: {
                    kind: 'approval',
                    toolName: approval.toolName,
                    reason: approval.reason,
                    answerable: approval.canAnswer !== false,
                    answer: async () => {},
                  } satisfies ApprovalPendingLike,
                }
                return (
                  <ApprovalFloatCard
                    key={approval.id}
                    item={item}
                    index={index}
                    total={approvals.length}
                    t={t}
                    taskTitle={approval.toolName}
                    sessionTitle=""
                    answering={false}
                    error={null}
                    onAnswer={(outcome) => answer(approval.id, outcome)}
                    onOpenSession={() => {}}
                    onPrev={() => {}}
                    onNext={() => {}}
                    showQueue={false}
                  />
                )
              })}
              {questions.map((batch, index) => {
                const item: PendingQuestionItem = {
                  sessionId: '',
                  commander: false,
                  questionKey: batch.id,
                  question: { questions: batch.questions } as unknown as PendingQuestionLike,
                }
                return (
                  <QuestionCard
                    key={batch.id}
                    item={item}
                    index={index}
                    total={questions.length}
                    t={t}
                    busy={false}
                    error={null}
                    onAnswer={(payload) => submitQuestion(batch.id, payload)}
                    onDismiss={() => {}}
                    onOpenSession={() => {}}
                    onPrev={() => {}}
                    onNext={() => {}}
                    showQueue={false}
                  />
                )
              })}
            </div>
          </section>
        </div>
      ) : null}
      {todoCount > 0 && !sheetOpen ? (
        <button type="button" className="dshcn-todo-fab" onClick={() => setSheetOpen(true)}>
          待处理 {todoCount}
        </button>
      ) : null}

      {settingsOpen ? (
        <div className="dshcn-settings-layer">
          <div className="dshcn-settings-head">
            <button type="button" className="dshcn-icon dshcn-settings-back" onClick={() => setSettingsOpen(false)}>
              返回
            </button>
            <span>设置</span>
          </div>
          <div className="dshcn-settings-body">
            <CommanderSettingsSection store={store} t={t} />
          </div>
        </div>
      ) : null}
    </section>
  )
}



interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  at?: number
}

/** 壳内只读会话窗口：显示该 session 的真实 user/assistant 文本。 */
function SessionTranscriptApp({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [messages, setMessages] = useState<TranscriptMessage[]>([])

  useEffect(() => {
    let closed = false
    void fetch(`/commander/session-transcript?sessionId=${encodeURIComponent(sessionId)}&limit=200`)
      .then((response) => response.json())
      .then((data: unknown) => {
        if (closed) return
        const list = (data as { messages?: TranscriptMessage[] } | null)?.messages
        setMessages(Array.isArray(list) ? list : [])
        setPhase('ready')
      })
      .catch(() => { if (!closed) setPhase('error') })
    return () => { closed = true }
  }, [sessionId])

  return (
    <div className="dshcn-transcript">
      <header className="dshcn-transcript-head">
        <span>会话</span>
        <span className="dshcn-transcript-id">{sessionId}</span>
      </header>
      <div className="dshcn-transcript-body">
        {phase === 'loading' ? <div className="dshcn-empty">加载中…</div> : null}
        {phase === 'error' ? <div className="dshcn-empty">读取会话失败</div> : null}
        {phase === 'ready' && messages.length === 0 ? <div className="dshcn-empty">这个会话还没有消息。</div> : null}
        {messages.map((message, index) => (
          <article key={index} className={`dshcn-msg dshcn-msg-${message.role}`}>
            {message.role === 'assistant'
              ? <WindowMarkdown text={message.text} />
              : <div className="dshcn-msg-text">{message.text}</div>}
          </article>
        ))}
      </div>
    </div>
  )
}
