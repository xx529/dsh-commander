/**
 * M1 dispatch surfaces for the panel: the confirmation card and the compact
 * task summary strip. Both are pure render components over the store state.
 *
 * The card follows docs/architecture/m1-contract-patch.md §2.3: it renders a
 * pending decision, and its three actions only call back with the choice — the
 * overlay turns that into one ordinary user message via `POST /commander/message`.
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { CommanderState } from './state'
import type {
  DispatchCandidateView, PendingDispatchView, SessionListResult, SessionOptionView, TaskView, WorkspaceView, WriteResult,
} from './types'
import {
  candidateProbability, candidateTotal, capabilitySummary, capabilityTotal, formatPercent, formatRemaining, isExpired, pendingPMax,
  pendingPWorkspace, pendingTaskTitle, pendingThreshold, reasonLabelKey, recommendationCandidate, recommendationTarget,
  taskStatusLabelKey, visibleCandidates, workspaceLabel, workspaceOptions,
} from './dispatch'
import type { DispatchActionKind, DispatchTarget } from './dispatch'
import { isUnnamedSession, sessionDisplayTitle, shortSessionId } from './session-display'

/** Locale translate function handed in through the slot inject face. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Props of the confirmation card. */
export interface DispatchConfirmCardProps {
  pending: PendingDispatchView
  state: CommanderState
  t: Translate
  /** Millisecond clock used by the countdown / expired state. */
  now: number
  /** One card action is currently being sent. */
  sending: boolean
  /** This decision's action was already accepted; the card waits for the state change. */
  actionSent: boolean
  /** Local error from the last send attempt. */
  error: string | null
  onAction: (kind: DispatchActionKind, target?: DispatchTarget) => void
  /** Load existing sessions of a workspace for the attach picker (`GET /commander/sessions`). */
  listSessions: (workspaceId: string) => Promise<WriteResult<SessionListResult>>
  /** Bottom-sheet layout: fold the candidate rows behind a disclosure. */
  compact?: boolean
}

/** Render the pending-dispatch confirmation card. */
export function DispatchConfirmCard({
  pending, state, t, now, sending, actionSent, error, onAction, listSessions, compact,
}: DispatchConfirmCardProps): ReactNode {
  const [customOpen, setCustomOpen] = React.useState(false)
  const [customWorkspace, setCustomWorkspace] = React.useState('')
  const [customMode, setCustomMode] = React.useState<'new' | 'attach'>('new')
  const [selectedSessionId, setSelectedSessionId] = React.useState('')
  const [sessions, setSessions] = React.useState<SessionOptionView[]>([])
  const [sessionsTruncated, setSessionsTruncated] = React.useState(false)
  const [sessionPhase, setSessionPhase] = React.useState<'idle' | 'loading' | 'ready' | 'error' | 'missing'>('idle')
  const [sessionError, setSessionError] = React.useState('')

  const expired = isExpired(pending, now)
  const disabled = sending || actionSent || expired
  const recommendation = recommendationTarget(pending)
  const recommendedWorkspace = workspaceName(state.workspaces, recommendation?.workspaceId)
  const recommendedMode = targetModeLabel(recommendation, t)
  const pMax = pendingPMax(pending)
  const pWorkspace = pendingPWorkspace(pending)
  const threshold = pendingThreshold(pending)
  const reason = t(reasonLabelKey(pending.reason))
  const candidates = visibleCandidates(pending)
  const recommendedCandidate = recommendationCandidate(pending)
  const options = workspaceOptions(state)
  const selectedWorkspace = customWorkspace === ''
    ? (recommendation?.workspaceId ?? options[0]?.id ?? '')
    : customWorkspace
  const remaining = formatRemaining(pending, now)
  const attachNeeded = customOpen && customMode === 'attach' && selectedWorkspace !== ''
  const decisionId = typeof pending.decisionId === 'string' ? pending.decisionId : ''

  // A new decision is a fresh card: drop the previous picker/mode/selection.
  React.useEffect(() => {
    setCustomOpen(false)
    setCustomMode('new')
    setCustomWorkspace('')
    setSelectedSessionId('')
  }, [decisionId])

  // Load the workspace's sessions whenever the attach picker becomes relevant.
  // Failures degrade to "new session only" instead of blocking the card:
  // `not_found`/`route_missing` means the installed Host predates the route.
  React.useEffect(() => {
    if (!attachNeeded) {
      setSessionPhase('idle')
      setSessions([])
      setSelectedSessionId('')
      return
    }
    let cancelled = false
    setSessionPhase('loading')
    setSessions([])
    setSelectedSessionId('')
    setSessionError('')
    void listSessions(selectedWorkspace).then(result => {
      if (cancelled) return
      if (result.ok) {
        setSessions(result.data.sessions)
        setSessionsTruncated(result.data.truncated === true)
        setSessionPhase('ready')
        return
      }
      if (result.failure.code === 'not_found' || result.failure.code === 'route_missing') {
        setSessionPhase('missing')
        return
      }
      setSessionPhase('error')
      setSessionError(result.failure.message)
    })
    return () => { cancelled = true }
  }, [attachNeeded, selectedWorkspace, listSessions])

  const retrySessions = (): void => {
    setSessionPhase('loading')
    setSessionError('')
    void listSessions(selectedWorkspace).then(result => {
      if (result.ok) {
        setSessions(result.data.sessions)
        setSessionsTruncated(result.data.truncated === true)
        setSessionPhase('ready')
        return
      }
      if (result.failure.code === 'not_found' || result.failure.code === 'route_missing') {
        setSessionPhase('missing')
        return
      }
      setSessionPhase('error')
      setSessionError(result.failure.message)
    })
  }

  const canConfirmCustom = selectedWorkspace !== ''
    && (customMode === 'new' || (selectedSessionId !== '' && sessionPhase === 'ready'))

  const submitCustom = (): void => {
    if (!canConfirmCustom) return
    onAction('custom', {
      workspaceId: selectedWorkspace,
      mode: customMode,
      ...(customMode === 'attach' ? { sessionId: selectedSessionId } : {}),
    })
  }

  return (
    <section className="dshc-card-dispatch" data-expired={expired ? 'true' : 'false'} data-compact={compact ? 'true' : undefined} aria-label={t('dispatch.title')}>
      <div className="dshc-dispatch-head">
        <span className="dshc-dispatch-title">
          <span className="dshc-dispatch-title-text">{t('dispatch.title')}</span>
        </span>
        <span className="dshc-tag">{t('dispatch.onlyConfirm')}</span>
        {pending.kind === 'continue' ? <span className="dshc-tag">{t('board.drawer.continueRound', { round: pending.round ?? 1 })}</span> : null}
        {remaining === '' ? null : <span className="dshc-dispatch-countdown">{`${t('dispatch.expires')} ${remaining}`}</span>}
      </div>
      {pendingTaskTitle(state, pending) === undefined ? null : (
        <div className="dshc-dispatch-tasktitle">{String(pendingTaskTitle(state, pending))}</div>
      )}

      <div className="dshc-dispatch-target">
        <span>{`${t('dispatch.recommend')}：`}</span>
        <span>{recommendedWorkspace}</span>
        <span className="dshc-dispatch-meta">{`/ ${recommendedMode}`}</span>
      </div>

      <div className="dshc-dispatch-meta">
        {`${t('dispatch.pMax')} ${formatPercent(pMax)}`}
        {threshold === undefined ? '' : ` · ${t('dispatch.threshold')} ${formatPercent(threshold)}`}
      </div>
      <div className="dshc-meter" aria-hidden>
        <div className="dshc-meter-fill" style={{ width: `${Math.round((pWorkspace ?? pMax ?? 0) * 100)}%` }} />
        {threshold === undefined ? null : (
          <div className="dshc-meter-threshold" style={{ left: `${Math.round(threshold * 100)}%` }} />
        )}
      </div>

      {candidates.length === 0 ? null : compact ? (
        <details className="dshc-candidates-details">
          <summary>{`${t('dispatch.candidates')}（${String(candidates.length)}）`}</summary>
          <div className="dshc-candidates">
            {candidates.map((candidate, index) => (
              <CandidateRow
                key={candidateKey(candidate, index)}
                candidate={candidate}
                recommended={index === 0 || candidate === recommendedCandidate}
                state={state}
                t={t}
              />
            ))}
            {candidateTotal(pending) > candidates.length ? (
              <span className="dshc-dispatch-meta">
                {`${t('dispatch.moreCandidates')}（${String(candidateTotal(pending) - candidates.length)}）`}
              </span>
            ) : null}
          </div>
        </details>
      ) : (
        <div className="dshc-candidates">
          {candidates.map((candidate, index) => (
            <CandidateRow
              key={candidateKey(candidate, index)}
              candidate={candidate}
              recommended={index === 0 || candidate === recommendedCandidate}
              state={state}
              t={t}
            />
          ))}
          {candidateTotal(pending) > candidates.length ? (
            <span className="dshc-dispatch-meta">
              {`${t('dispatch.moreCandidates')}（${String(candidateTotal(pending) - candidates.length)}）`}
            </span>
          ) : null}
        </div>
      )}

      <div className="dshc-dispatch-reason">{`${t('dispatch.reason')}：${reason}`}</div>

      {error === null ? null : <div className="dshc-dispatch-waiting">{error}</div>}

      {expired ? (
        <div className="dshc-dispatch-waiting">{t('dispatch.expired')}</div>
      ) : actionSent ? (
        <div className="dshc-dispatch-waiting">{t('dispatch.waiting')}</div>
      ) : (
        <React.Fragment>
          <div className="dshc-dispatch-actions">
            <button
              type="button"
              className="dshc-button"
              data-variant="secondary"
              disabled={disabled}
              onClick={() => { setCustomOpen(value => !value) }}
            >
              {customOpen ? t('dispatch.custom.back') : t('dispatch.custom')}
            </button>
            <button
              type="button"
              className="dshc-button"
              data-variant="primary"
              disabled={disabled}
              onClick={() => { onAction('adopt') }}
            >
              {sending ? t('dispatch.sending') : t('dispatch.adopt')}
            </button>
            <button
              type="button"
              className="dshc-button"
              data-variant="ghost"
              disabled={disabled}
              onClick={() => { onAction('cancel') }}
            >
              {t('dispatch.cancel')}
            </button>
          </div>
          {customOpen ? (
            <div className="dshc-dispatch-custom">
              <label className="dshc-field">
                <span>{t('dispatch.custom.workspace')}</span>
                <select
                  className="dshc-field-select"
                  value={selectedWorkspace}
                  disabled={disabled}
                  onChange={event => { setCustomWorkspace(event.target.value) }}
                >
                  {options.map(row => <option key={row.id} value={row.id}>{workspaceLabel(row)}</option>)}
                </select>
              </label>
              <label className="dshc-field">
                <span>{t('dispatch.custom.mode')}</span>
                <select
                  className="dshc-field-select"
                  value={customMode}
                  disabled={disabled}
                  onChange={event => {
                    setCustomMode(event.target.value === 'attach' ? 'attach' : 'new')
                    setSelectedSessionId('')
                  }}
                >
                  <option value="new">{t('dispatch.custom.mode.new')}</option>
                  <option value="attach">{t('dispatch.custom.mode.attach')}</option>
                </select>
              </label>
              {customMode === 'attach' ? (
                <div className="dshc-session-picker">
                  {sessionPhase === 'loading' ? <span className="dshc-session-state">{t('dispatch.custom.session.loading')}</span> : null}
                  {sessionPhase === 'missing' ? <span className="dshc-session-state" data-tone="warn">{t('dispatch.custom.session.unavailable')}</span> : null}
                  {sessionPhase === 'error' ? (
                    <span className="dshc-session-state" data-tone="error">
                      {`${t('dispatch.custom.session.error')}：${sessionError}`}
                      <button type="button" className="dshc-msg-toggle" onClick={retrySessions}>{t('dispatch.custom.session.retry')}</button>
                    </span>
                  ) : null}
                  {sessionPhase === 'ready' && sessions.length === 0 ? (
                    <span className="dshc-session-state">{t('dispatch.custom.session.empty')}</span>
                  ) : null}
                  {sessionPhase === 'ready' && sessions.length > 0 ? (
                    <div className="dshc-session-list" role="listbox" aria-label={t('dispatch.custom.session.select')}>
                      {sessions.map(session => (
                        <button
                          key={session.sessionId}
                          type="button"
                          className="dshc-session-row"
                          role="option"
                          aria-selected={selectedSessionId === session.sessionId}
                          data-selected={selectedSessionId === session.sessionId ? 'true' : 'false'}
                          disabled={disabled}
                          onClick={() => { setSelectedSessionId(session.sessionId) }}
                        >
                          <span className="dshc-session-title" data-unnamed={isUnnamedSession(session.title) ? 'true' : 'false'} title={isUnnamedSession(session.title) ? session.sessionId : session.title}>
                            <span className="dshc-session-name">{sessionDisplayTitle(session.title, t)}</span>
                            <span className="dshc-session-shortid">{shortSessionId(session.sessionId)}</span>
                          </span>
                          <span className="dshc-session-meta">
                            {formatActivity(session.lastActiveAt) === ''
                              ? ''
                              : `${t('dispatch.custom.session.lastActive')} ${formatActivity(session.lastActiveAt)}`}
                            {session.contextPct === undefined
                              ? ''
                              : ` · ${t('dispatch.custom.session.context')} ${String(session.contextPct)}%`}
                            {session.model === undefined ? '' : ` · ${session.model}`}
                          </span>
                        </button>
                      ))}
                      {sessionsTruncated ? (
                        <span className="dshc-session-state" data-tone="muted">{t('sessions.truncatedLimit20')}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="dshc-dispatch-actions">
                <button
                  type="button"
                  className="dshc-button"
                  data-variant="primary"
                  disabled={disabled || !canConfirmCustom}
                  onClick={submitCustom}
                >
                  {sending ? t('dispatch.sending') : t('dispatch.custom.confirm')}
                </button>
              </div>
            </div>
          ) : null}
        </React.Fragment>
      )}
    </section>
  )
}

/** Short locale time for the attach picker activity line. */
function formatActivity(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  try {
    return new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function CandidateRow({
  candidate, recommended, state, t,
}: {
  candidate: DispatchCandidateView
  recommended: boolean
  state: CommanderState
  t: Translate
}): ReactNode {
  const workspace = candidate.workspaceName ?? workspaceName(state.workspaces, candidate.workspaceId)
  const mode = candidate.mode === 'attach'
    ? (candidate.sessionTitle ?? candidate.sessionId ?? t('dispatch.mode.attach'))
    : t('dispatch.mode.new')
  return (
    <div className="dshc-candidate" data-recommended={recommended ? 'true' : 'false'}>
      <span className="dshc-candidate-name">{workspace}</span>
      <span className="dshc-candidate-mode">{mode}</span>
      <span className="dshc-candidate-pct">{formatPercent(candidateProbability(candidate))}</span>
    </div>
  )
}

/** Statuses shown by the task strip, in product order. */
const TASK_STATUS_ORDER = ['draft', 'proposed', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'] as const

/** Compact task summary strip above the transcript (M1 minimal, no board page). */
export function TaskSummaryBar({
  tasks, counts, state, t,
}: {
  tasks: readonly TaskView[]
  counts: Record<string, number>
  state: CommanderState
  t: Translate
}): ReactNode {
  const [expanded, setExpanded] = React.useState(false)
  const chips = statusChips(tasks, counts)
  if (tasks.length === 0 && chips.length === 0) return null
  return (
    <div className="dshc-taskbar">
      <div className="dshc-taskbar-head">
        <span>{t('task.summary')}</span>
        <span className="dshc-taskbar-counts">
          {chips.map(chip => (
            <span key={chip.status} className="dshc-chip" data-status={chip.status}>
              {`${t(taskStatusLabelKey(chip.status))} ${chip.count}`}
            </span>
          ))}
        </span>
        {tasks.length === 0 ? null : (
          <button
            type="button"
            className="dshc-msg-toggle"
            onClick={() => { setExpanded(value => !value) }}
          >
            {expanded ? t('task.collapse') : t('task.expand')}
          </button>
        )}
      </div>
      {expanded ? (
        <div className="dshc-tasklist">
          {tasks.slice(0, 6).map(task => {
            const capability = capabilitySummary(task)
            return (
              <div className="dshc-task-row" key={task.id}>
                <span className="dshc-task-name">{task.title ?? task.id}</span>
                <span className="dshc-task-ws">{workspaceName(state.workspaces, task.workspaceId)}</span>
                {capability === undefined || capability.status === 'none' || capabilityTotal(capability) === 0 ? null : (
                  <span className="dshc-task-cap" title={t('task.capabilityHint')}>
                    {`${t('task.capability')} (${capability.disabledCount > 0 ? `${capability.enabledCount}/${capabilityTotal(capability)}` : String(capability.enabledCount)})`}
                  </span>
                )}
                <span className="dshc-task-status" data-status={task.status ?? ''}>
                  {t(taskStatusLabelKey(task.status))}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function statusChips(tasks: readonly TaskView[], counts: Record<string, number>): Array<{ status: string; count: number }> {
  const chips: Array<{ status: string; count: number }> = []
  for (const status of TASK_STATUS_ORDER) {
    const count = typeof counts[status] === 'number'
      ? counts[status]
      : tasks.filter(task => task.status === status).length
    if (count > 0) chips.push({ status, count })
  }
  return chips
}

function workspaceName(workspaces: readonly WorkspaceView[], workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId === '') return '未分配'
  const row = workspaces.find(workspace => workspace.id === workspaceId)
  return row === undefined ? workspaceId : workspaceLabel(row)
}

function targetModeLabel(target: { mode?: 'new' | 'attach'; sessionId?: string } | undefined, t: Translate): string {
  if (target?.mode === 'attach') {
    return target.sessionId === undefined ? t('dispatch.mode.attach') : `已有会话 ${target.sessionId}`
  }
  return t('dispatch.mode.new')
}

function candidateKey(candidate: DispatchCandidateView, index: number): string {
  return `${candidate.workspaceId ?? 'ws'}:${candidate.sessionId ?? 'new'}:${String(index)}`
}
