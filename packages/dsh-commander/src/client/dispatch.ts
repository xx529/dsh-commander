/**
 * Dispatch confirmation card helpers (M1).
 *
 * Frozen decision: the panel never talks to a dispatch route — the three card
 * actions send one ordinary user message to the commander session through
 * `POST /commander/message`, and the Host/commander updates state afterwards.
 * The exact text templates come from docs/architecture/m1-contract-patch.md §2.1:
 *
 *   [dispatch-confirm] 采用建议
 *   decisionId=dec_… taskId=task_…
 *   target=workspaceId:<ws>;mode:new|attach[;sessionId:<sid>]
 *
 * These builders are pure so `tests/client/dispatch.test.ts` can pin the text.
 */
import type { CommanderState } from './state.ts'
import type { DispatchCandidateView, PendingDispatchView, TaskView, WorkspaceView } from './types.ts'

/** Which confirmation-card action the user chose. */
export type DispatchActionKind = 'adopt' | 'custom' | 'cancel'

/** Target the custom picker (or the recommendation) resolves to. */
export interface DispatchTarget {
  workspaceId: string
  mode: 'new' | 'attach'
  sessionId?: string
}

/** Decision id of a pending dispatch, or '' when the Host did not send one. */
export function decisionIdOf(pending: PendingDispatchView): string {
  return typeof pending.decisionId === 'string' ? pending.decisionId : ''
}

/** Task id of a pending dispatch, or '' when absent. */
export function taskIdOf(pending: PendingDispatchView): string {
  return typeof pending.taskId === 'string' ? pending.taskId : ''
}

/** Normalize a probability-like number (0..1 or 0..100) to 0..1. */
export function normalizeProbability(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0) return undefined
  return value > 1.001 ? Math.min(value / 100, 1) : value
}

/** Best-effort percentage for one candidate row (workspace/session/generic score). */
export function candidateProbability(candidate: DispatchCandidateView): number | undefined {
  return normalizeProbability(
    firstNumber(candidate.pWorkspace, candidate.pSession, candidate.score, candidate.confidence),
  )
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Format 0..1 as `62%`; `—` when unknown. */
export function formatPercent(value: number | undefined): string {
  if (value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

/** `pendingDispatch.scores.pMax`, falling back to `pMax` or the recommended candidate. */
export function pendingPMax(pending: PendingDispatchView): number | undefined {
  const explicit = normalizeProbability(
    firstNumber(
      typeof pending.scores === 'object' && pending.scores !== null ? numberField(pending.scores, 'pMax') : undefined,
      pending.pMax,
    ),
  )
  if (explicit !== undefined) return explicit
  const recommended = recommendationCandidate(pending)
  return recommended === undefined ? undefined : candidateProbability(recommended)
}

/** Workspace probability of the recommendation (for the card meter). */
export function pendingPWorkspace(pending: PendingDispatchView): number | undefined {
  const scores = pending.scores
  if (typeof scores === 'object' && scores !== null) {
    const value = normalizeProbability(numberField(scores, 'pWorkspace'))
    if (value !== undefined) return value
  }
  const recommended = recommendationCandidate(pending)
  return recommended === undefined ? undefined : normalizeProbability(recommended.pWorkspace)
}

/** `pendingDispatch.threshold` (display-only hint per M1 product decision). */
export function pendingThreshold(pending: PendingDispatchView): number | undefined {
  return normalizeProbability(pending.threshold)
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Locate the candidate matching the recommendation, if candidates were sent. */
export function recommendationCandidate(pending: PendingDispatchView): DispatchCandidateView | undefined {
  const recommendation = pending.recommendation
  const candidates = pending.candidates ?? []
  if (recommendation === undefined) return candidates[0]
  return candidates.find(candidate =>
    (recommendation.sessionId !== undefined && candidate.sessionId === recommendation.sessionId)
    || (recommendation.workspaceId !== undefined && candidate.workspaceId === recommendation.workspaceId
      && (recommendation.mode === undefined || candidate.mode === undefined || candidate.mode === recommendation.mode)))
    ?? candidates[0]
}

/** Up to three candidate rows for the card (PRODUCT-DESIGN §13.3). */
export function visibleCandidates(pending: PendingDispatchView): DispatchCandidateView[] {
  return (pending.candidates ?? []).slice(0, 3)
}

/** Total candidate count reported by the Host (cards show "还有 N 个候选"). */
export function candidateTotal(pending: PendingDispatchView): number {
  return (pending.candidates ?? []).length
}

/** Locale key for the dispatch reason line (m1-contract-patch §1.4). */
export function reasonLabelKey(reason: string | undefined): string {
  switch (reason) {
    case 'user_confirm_required':
      return 'dispatch.reason.userConfirm'
    case 'low_confidence':
      return 'dispatch.reason.lowConfidence'
    case 'jev_unavailable':
      return 'dispatch.reason.jevUnavailable'
    case 'decision_required':
      return 'dispatch.reason.decisionRequired'
    case 'decision_expired':
      return 'dispatch.reason.expired'
    case 'conflict':
      return 'dispatch.reason.conflict'
    default:
      return 'dispatch.reason.other'
  }
}

/** Locale key for a task status pill. */
export function taskStatusLabelKey(status: string | undefined): string {
  switch (status) {
    case 'draft':
    case 'proposed':
    case 'queued':
    case 'running':
    case 'blocked':
    case 'review':
    case 'done':
    case 'cancelled':
      return `task.status.${status}`
    default:
      return 'task.status.other'
  }
}

/** Human workspace name for the card: `name`, then id. */
export function workspaceLabel(row: WorkspaceView): string {
  return row.name ?? row.id
}

/** Workspaces offered by the custom picker: allowed first, then the rest. */
export function workspaceOptions(state: CommanderState): WorkspaceView[] {
  const allowed = state.workspaces.filter(row => row.allowed === true)
  return allowed.length > 0 ? allowed : state.workspaces
}

/** Candidate/recommendation → dispatch target, when a workspace is known. */
export function candidateTarget(
  candidate: Pick<DispatchCandidateView, 'workspaceId' | 'mode' | 'sessionId'> | undefined,
): DispatchTarget | undefined {
  if (candidate === undefined) return undefined
  const workspaceId = candidate.workspaceId
  if (workspaceId === undefined || workspaceId === '') return undefined
  return {
    workspaceId,
    mode: candidate.mode === 'attach' && candidate.sessionId !== undefined ? 'attach' : 'new',
    ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
  }
}

/** Recommendation target as a dispatch target. */
export function recommendationTarget(pending: PendingDispatchView): DispatchTarget | undefined {
  const recommendation = pending.recommendation
  if (recommendation !== undefined && recommendation.workspaceId !== undefined
    && recommendation.workspaceId !== '') {
    return candidateTarget(recommendation)
  }
  return candidateTarget(recommendationCandidate(pending))
}

/** Title of the pending task: Host `taskTitle` first, then the snapshot `tasks` row. */
export function pendingTaskTitle(state: CommanderState, pending: PendingDispatchView): string | undefined {
  const direct = pending.taskTitle
  if (typeof direct === 'string' && direct !== '') return direct
  return taskTitleFor(state, taskIdOf(pending))
}

/** Title of the task a pending decision belongs to (Host snapshot `tasks`). */
export function taskTitleFor(state: CommanderState, taskId: string | undefined): string | undefined {
  if (taskId === undefined || taskId === '') return undefined
  const task: TaskView | undefined = state.tasks.find(row => row.id === taskId)
  const title = task?.title
  return title === undefined || title === '' ? undefined : title
}

/** `target=workspaceId:<ws>;mode:new|attach[;sessionId:<sid>]` (m1 patch §2.1). */
export function targetToken(target: DispatchTarget | undefined): string {
  if (target === undefined) return 'target=workspaceId:'
  // `attach` without a session id cannot be dispatched; the contract's new-session
  // form is the only valid fallback.
  const attach = target.mode === 'attach' && target.sessionId !== undefined
  const mode = attach ? 'attach' : 'new'
  const session = attach ? `;sessionId:${target.sessionId}` : ''
  return `target=workspaceId:${target.workspaceId};mode:${mode}${session}`
}

function idLine(pending: PendingDispatchView): string {
  const parts: string[] = []
  const decisionId = decisionIdOf(pending)
  const taskId = taskIdOf(pending)
  if (decisionId !== '') parts.push(`decisionId=${decisionId}`)
  if (taskId !== '') parts.push(`taskId=${taskId}`)
  return parts.join(' ')
}

/** `采用建议` → ordinary user message sent to the commander session. */
export function buildAdoptMessage(pending: PendingDispatchView): string {
  return `[dispatch-confirm] 采用建议\n${idLine(pending)}\n${targetToken(recommendationTarget(pending))}`
}

/** `自定义选择` + confirmed picker → ordinary user message. */
export function buildCustomMessage(pending: PendingDispatchView, target: DispatchTarget): string {
  return `[dispatch-confirm] 自定义\n${idLine(pending)}\n${targetToken(target)}`
}

/** `取消` → ordinary user message (no target). */
export function buildCancelMessage(pending: PendingDispatchView): string {
  return `[dispatch-confirm] 取消\n${idLine(pending)}`
}

/** Build the message for one card action (custom requires a target). */
export function buildDispatchActionMessage(
  kind: DispatchActionKind,
  pending: PendingDispatchView,
  target?: DispatchTarget,
): string {
  switch (kind) {
    case 'adopt':
      return buildAdoptMessage(pending)
    case 'custom':
      return target === undefined ? buildAdoptMessage(pending) : buildCustomMessage(pending, target)
    case 'cancel':
      return buildCancelMessage(pending)
  }
}

/** Remaining milliseconds before `expiresAt`; `undefined` when the Host sent none. */
export function remainingMs(pending: PendingDispatchView, now: number): number | undefined {
  const expiresAt = pending.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined
  return Math.max(expiresAt - now, 0)
}

/** Whether a pending decision has passed its `expiresAt` (card greys out). */
export function isExpired(pending: PendingDispatchView, now: number): boolean {
  const remaining = remainingMs(pending, now)
  return remaining !== undefined && remaining <= 0
}

/** `29:59` style countdown label; '' when the Host sent no expiry. */
export function formatRemaining(pending: PendingDispatchView, now: number): string {
  const remaining = remainingMs(pending, now)
  if (remaining === undefined) return ''
  const totalSeconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Capability summary line key: `启用 N 项 / 未启用 M 项 · 耗时 Xms` (patch §4.4). */
/** 已启用 + 未启用总数：0 表示没有可展示的能力数量（inherit/空 fallback），看板不显示「能力 0/0」。 */
export function capabilityTotal(summary: { enabledCount: number; disabledCount: number } | undefined): number {
  if (summary === undefined) return 0
  return summary.enabledCount + summary.disabledCount
}

export function capabilitySummary(task: TaskView): { status: string; enabledCount: number; disabledCount: number; durationMs?: number } | undefined {
  const capability = task.capability
  if (capability === null || typeof capability !== 'object') return undefined
  return {
    status: typeof capability.status === 'string' ? capability.status : 'none',
    enabledCount: typeof capability.enabledCount === 'number' ? capability.enabledCount : 0,
    disabledCount: typeof capability.disabledCount === 'number' ? capability.disabledCount : 0,
    ...(typeof capability.durationMs === 'number' ? { durationMs: capability.durationMs } : {}),
  }
}
