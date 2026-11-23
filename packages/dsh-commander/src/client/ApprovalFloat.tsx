/**
 * M3 approval floating card + badge hint strip for the commander panel
 * (docs/architecture/m2m3-contract-patch.md §3.3/§3.5).
 *
 * The card is a second *view* of the official pending approval, never a second
 * answerer: it renders the same `PendingApproval` instance and calls its
 * `answer()` after the `answerable` guard.
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import type { CommanderBadge, BadgeHint, PendingApprovalItem, ApprovalAnswerOutcome } from './approval'
import { approvalSummary, badgeLabelKey } from './approval'

/** Locale translate function. */
export type Translate = (key: string) => string

/** One queued approval card. */
export interface ApprovalFloatCardProps {
  item: PendingApprovalItem
  /** 0-based position inside the queue. */
  index: number
  total: number
  t: Translate
  /** Task title from the snapshot tasks (fallback: task id). */
  taskTitle: string
  /** Session title from workSessions (fallback: session id). */
  sessionTitle: string
  answering: boolean
  error: string | null
  onAnswer: (outcome: ApprovalAnswerOutcome) => void
  onOpenSession: () => void
  onPrev: () => void
  onNext: () => void
  /** Hide the queue counter when all cards are stacked (the C sheet). */
  showQueue?: boolean
}

/** Render the minimal approval card shown above the panel transcript. */
export function ApprovalFloatCard({
  item, index, total, t, taskTitle, sessionTitle, answering, error, onAnswer, onOpenSession, onPrev, onNext, showQueue,
}: ApprovalFloatCardProps): ReactNode {
  const summary = approvalSummary(item.approval)
  return (
    <section className="dshc-approval-card" role="alertdialog" aria-label={t('approval.title')}>
      <header className="dshc-approval-head">
        <span className="dshc-approval-title">{t('approval.title')}</span>
        <span className="dshc-tag">{t('approval.onlyUi')}</span>
        {total > 1 && showQueue !== false ? (
          <span className="dshc-approval-counter">
            <button type="button" className="dshc-msg-toggle" disabled={index <= 0} onClick={onPrev}>‹</button>
            <span>{`${String(index + 1)}/${String(total)}`}</span>
            <button type="button" className="dshc-msg-toggle" disabled={index >= total - 1} onClick={onNext}>›</button>
          </span>
        ) : null}
      </header>
      <div className="dshc-approval-task">{taskTitle}</div>
      {summary === '' ? null : <div className="dshc-approval-cmd"><code>{summary}</code></div>}
      <div className="dshc-approval-meta">
        <span>{`${t('approval.session')}：${sessionTitle}`}</span>
        {item.approval.toolName === undefined ? null : <span>{`${t('approval.tool')}：${item.approval.toolName}`}</span>}
      </div>
      {error === null ? null : <div className="dshc-approval-error">{error}</div>}
      <div className="dshc-approval-actions">
        <button type="button" className="dshc-button" data-variant="ghost" onClick={onOpenSession}>
          {t('approval.openSession')}
        </button>
        <span className="dshc-approval-spacer" />
        <button
          type="button"
          className="dshc-button"
          data-variant="secondary"
          disabled={answering || item.approval.answerable !== true}
          onClick={() => { onAnswer('rejected') }}
        >
          {t('approval.reject')}
        </button>
        <button
          type="button"
          className="dshc-button"
          data-variant="primary"
          disabled={answering || item.approval.answerable !== true}
          onClick={() => { onAnswer('allowed-once') }}
        >
          {answering ? t('approval.answering') : t('approval.allow')}
        </button>
      </div>
    </section>
  )
}

/** Derive the panel-top hint strip from the ball badge source. */
export interface BadgeHintStripProps {
  hints: readonly BadgeHint[]
  badge: CommanderBadge | null
  t: Translate
  /** Session id of the first pending approval (opened on approval-hint click). */
  approvalSessionId?: string
  onOpenBoard: () => void
  onOpenSession: (sessionId: string) => void
}

/** Render the compact badge hint strip shown below the panel header. */
export function BadgeHintStrip({
  hints, badge, t, approvalSessionId, onOpenBoard, onOpenSession,
}: BadgeHintStripProps): ReactNode {
  if (hints.length === 0) return null
  return (
    <div className="dshc-badge-hints" role="status">
      {badge === null ? null : (
        <span className="dshc-badge-summary" data-kind={badge.kind}>{`${t(badgeLabelKey(badge.kind))} ${String(badge.count)}`}</span>
      )}
      {hints.map(hint => (
        <button
          key={hint.kind}
          type="button"
          className="dshc-badge-chip"
          data-kind={hint.kind}
          onClick={() => {
            if (hint.action === 'approval' && approvalSessionId !== undefined) onOpenSession(approvalSessionId)
            else onOpenBoard()
          }}
        >
          {`${t(badgeLabelKey(hint.kind))} ${String(hint.count)}`}
        </button>
      ))}
    </div>
  )
}
