// 未决确认决策：仅内存、TTL 30m、惰性清理；最多一条 pendingDispatch（新确认覆盖旧确认并作废旧决策）。
// 契约：m1-contract-patch §1.2/§1.5。
import { DECISION_TTL_MS } from '../config.ts'
import type { ConfirmationCandidate } from './candidates.ts'
import type { JevScores } from '../jev/parse.ts'

export type DecisionReason = 'user_confirm_required' | 'jev_unavailable' | 'low_confidence' | 'decision_required' | 'ambiguous_workspace'

export interface DecisionJevSummary {
  provider: string
  endpoint: string
  model: string
  requestId: string
  latencyMs: number
  ok: boolean
  mode: 'two_stage'
  tokenEstimate: number
  error?: { code: string; message: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface PendingDecision {
  decisionId: string
  taskId: string
  taskTitle: string
  candidates: ConfirmationCandidate[]
  recommendation: ConfirmationCandidate
  scores: JevScores
  reason: DecisionReason
  jev: DecisionJevSummary
  prefilter: { workspaceIds: string[]; sessionIds: string[]; scores: Record<string, number>; truncated: boolean }
  createdAt: number
  expiresAt: number
  used: boolean
  createdAtRequestId: string
  /** initial = 首次派发；continue = 已有轮次后的追加派发。 */
  kind: 'initial' | 'continue'
  /** 本轮确认成功后的任务轮次。 */
  round: number
  /** 本轮确认成功后要原样投递给工作会话的消息全文（指挥官自写；确认调用可省略以复用）。 */
  prompt?: string
  /** 指挥官传的用户原话（仅展示/审计）。 */
  userRequest?: string
}

export interface DecisionStore {
  create(input: Omit<PendingDecision, 'createdAt' | 'expiresAt' | 'used'> & { createdAt?: number }): PendingDecision
  get(decisionId: string): PendingDecision | undefined
  getUsable(decisionId: string, taskId: string, now?: number): { decision: PendingDecision } | { error: 'decision_expired' }
  pendingForTask(taskId: string, now?: number): PendingDecision[]
  current(): PendingDecision | undefined
  markUsed(decisionId: string): void
  /** 删除某任务的所有未决决策，返回删除数（accept/cancel/archive 时清理）。 */
  invalidateTask(taskId: string): number
  invalidateAll(reason?: string): void
  prune(now?: number): number
  size(): number
}

export function createDecisionStore(options: { ttlMs?: number; now?: () => number } = {}): DecisionStore {
  const ttlMs = options.ttlMs ?? DECISION_TTL_MS
  const now = options.now ?? (() => Date.now())
  const map = new Map<string, PendingDecision>()
  let currentId: string | null = null

  const prune = (at = now()): number => {
    let removed = 0
    for (const [id, decision] of map) {
      if (at >= decision.expiresAt) {
        map.delete(id)
        if (currentId === id) currentId = null
        removed += 1
      }
    }
    return removed
  }

  return {
    create(input) {
      const at = input.createdAt ?? now()
      prune(at)
      // 新确认覆盖旧确认：旧决策作废（用户旧卡操作会得到 decision_expired）
      map.clear()
      currentId = null
      const decision: PendingDecision = { ...input, createdAt: at, expiresAt: at + ttlMs, used: false }
      map.set(decision.decisionId, decision)
      currentId = decision.decisionId
      return decision
    },
    get(decisionId) {
      prune()
      return map.get(decisionId)
    },
    getUsable(decisionId, taskId, at = now()) {
      prune(at)
      const decision = map.get(decisionId)
      if (decision === undefined || decision.taskId !== taskId) return { error: 'decision_expired' }
      if (at >= decision.expiresAt) return { error: 'decision_expired' }
      return { decision }
    },
    pendingForTask(taskId, at = now()) {
      prune(at)
      return [...map.values()].filter((decision) => decision.taskId === taskId && !decision.used)
    },
    current() {
      prune()
      return currentId === null ? undefined : map.get(currentId)
    },
    markUsed(decisionId) {
      const decision = map.get(decisionId)
      if (decision !== undefined) decision.used = true
    },
    invalidateTask(taskId) {
      let removed = 0
      for (const [id, decision] of map) {
        if (decision.taskId !== taskId) continue
        map.delete(id)
        if (currentId === id) currentId = null
        removed += 1
      }
      return removed
    },
    invalidateAll() {
      map.clear()
      currentId = null
    },
    prune,
    size() {
      return map.size
    },
  }
}
