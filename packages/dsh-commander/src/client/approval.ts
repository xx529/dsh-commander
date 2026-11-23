/**
 * M3 approval floating-card helpers (docs/architecture/m2m3-contract-patch.md §3.3).
 *
 * The card never owns an answerer: it reads the official `uiSession.sessionStatus`
 * observable (duck-typed, no runtime import of the shipped approval package) and
 * calls the very same `PendingApproval` instance the main window renders.
 */
import type { TaskView, WorkSessionView } from './types'

/** The subset of the official `PendingApproval` this UI touches. */
export interface ApprovalPendingLike {
  kind?: string
  key?: string
  sessionId?: string
  toolName?: string
  callId?: string
  reason?: string
  displayReason?: unknown
  answerable?: boolean
  answer?: (outcome: 'allowed-once' | 'rejected') => Promise<void>
}

/** One Session's M3 UI status (subset of the official `SessionStatus`). */
export interface SessionStatusLike {
  running?: boolean
  pendingInteraction?: unknown
}

/** `uiSession.sessionStatus` snapshot: sessionId → status. */
export type SessionStatusMap = ReadonlyMap<string, SessionStatusLike>

/** Observable face of `uiSession.sessionStatus` (HostObservable-compatible). */
export interface SessionStatusSource {
  getSnapshot(): SessionStatusMap
  subscribe(listener: () => void): () => void
}

/** One pending approval queued for the floating card. */
export interface PendingApprovalItem {
  sessionId: string
  taskId: string
  title?: string
  approval: ApprovalPendingLike
  approvalKey: string
}

/** Decision outcomes the official `PendingApproval.answer` accepts. */
export type ApprovalAnswerOutcome = 'allowed-once' | 'rejected'

/** Result of one answer attempt. */
export type ApprovalAnswerResult =
  | { ok: true }
  | { ok: false; reason: 'not-answerable' | 'already-settled' | 'failed'; message?: string }

/** Whether a pending-interaction value is an approval this card can render. */
export function isApprovalLike(value: unknown): value is ApprovalPendingLike {
  if (value === null || typeof value !== 'object') return false
  const record = value as ApprovalPendingLike
  return record.kind === 'approval' && typeof record.answer === 'function'
}

/**
 * Collect pending approvals for task-linked work sessions (primarySessionId ∪
 * assignments, delivered by the snapshot as `workSessions`). Deduped by the
 * approval key so the same request is never queued twice.
 */
export function selectPendingApprovals(
  statuses: SessionStatusMap,
  workSessions: readonly WorkSessionView[],
): PendingApprovalItem[] {
  const items: PendingApprovalItem[] = []
  const seen = new Set<string>()
  for (const session of workSessions) {
    const status = statuses.get(session.sessionId)
    const pending = status?.pendingInteraction
    if (!isApprovalLike(pending)) continue
    const key = typeof pending.key === 'string' && pending.key !== '' ? pending.key : session.sessionId
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      sessionId: session.sessionId,
      taskId: session.taskId,
      ...(session.title === undefined ? {} : { title: session.title }),
      approval: pending,
      approvalKey: key,
    })
  }
  return items
}

/** `already settled` is expected when the main window answered first. */
export function isAlreadySettled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /already settled/iu.test(message)
}

/**
 * Answer one pending approval exactly once: guard `answerable` first, then
 * swallow the `already settled` race the other UI may win.
 */
export async function answerPendingApproval(
  approval: ApprovalPendingLike,
  outcome: ApprovalAnswerOutcome,
): Promise<ApprovalAnswerResult> {
  if (approval.answerable !== true) return { ok: false, reason: 'not-answerable' }
  if (typeof approval.answer !== 'function') return { ok: false, reason: 'failed', message: 'pending approval has no answer()' }
  try {
    await approval.answer(outcome)
    return { ok: true }
  } catch (error) {
    if (isAlreadySettled(error)) return { ok: false, reason: 'already-settled' }
    return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** Human summary of an approval request. */
export function approvalSummary(approval: ApprovalPendingLike): string {
  if (typeof approval.reason === 'string' && approval.reason !== '') return approval.reason
  const display = approval.displayReason
  if (typeof display === 'string') return display
  if (display !== null && typeof display === 'object') {
    const record = display as Record<string, unknown>
    const text = record.text ?? record.en ?? record.zh
    if (typeof text === 'string') return text
  }
  return ''
}

/** Badge kinds derived from commander state (m2m3 patch §3.5). */
export type BadgeKind = 'dispatch' | 'approval' | 'review' | 'blocked'

/** The single badge the ball shows; count is the number behind it. */
export interface CommanderBadge {
  kind: BadgeKind
  count: number
}

/** Inputs for the derived badge (snapshot counts + pending approvals). */
export interface BadgeInput {
  hasPendingDispatch: boolean
  approvalCount: number
  counts: Record<string, number>
  tasks?: readonly TaskView[]
}

/** Derive the highest-priority badge: dispatch > approval > review > blocked. */
export function deriveCommanderBadge(input: BadgeInput): CommanderBadge | null {
  if (input.hasPendingDispatch) return { kind: 'dispatch', count: 1 }
  if (input.approvalCount > 0) return { kind: 'approval', count: input.approvalCount }
  const review = countOf(input.counts, 'review', input.tasks, 'review')
  if (review > 0) return { kind: 'review', count: review }
  const blocked = countOf(input.counts, 'blocked', input.tasks, 'blocked')
  if (blocked > 0) return { kind: 'blocked', count: blocked }
  return null
}

function countOf(
  counts: Record<string, number>,
  countKey: string,
  tasks: readonly TaskView[] | undefined,
  status: string,
): number {
  const listed = counts[countKey]
  if (typeof listed === 'number') return listed
  return (tasks ?? []).filter(task => task.status === status).length
}

/** Locale key for a badge kind. */
export function badgeLabelKey(kind: BadgeKind): string {
  return `badge.${kind}`
}

/** Panel hint rows shared with the ball badge. */
export interface BadgeHint {
  kind: BadgeKind
  count: number
  /** Where a click should go: the board, or the first pending interaction. */
  action: 'board' | 'approval'
}

/** Build the panel-top hint list (same source as the badge). */
export function deriveBadgeHints(input: BadgeInput): BadgeHint[] {
  const hints: BadgeHint[] = []
  if (input.hasPendingDispatch) hints.push({ kind: 'dispatch', count: 1, action: 'board' })
  if (input.approvalCount > 0) hints.push({ kind: 'approval', count: input.approvalCount, action: 'approval' })
  const review = countOf(input.counts, 'review', input.tasks, 'review')
  if (review > 0) hints.push({ kind: 'review', count: review, action: 'board' })
  const blocked = countOf(input.counts, 'blocked', input.tasks, 'blocked')
  if (blocked > 0) hints.push({ kind: 'blocked', count: blocked, action: 'board' })
  return hints
}
