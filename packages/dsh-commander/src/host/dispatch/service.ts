// commander_task_dispatch 服务（全确认模式）：候选 → Jev（计算不放行）→ needs_confirmation（内存决策 TTL30m）
// → 二次确认 → spawn → dispatched。幂等：requestId 5min LRU；同一 decision 只提交一次（终态回放）。
// 契约：m1-contract-patch §1（全确认）、ARCHITECTURE §4.1/§5、implementation-plan §9。
import { AUTO_DISPATCH, DECISION_TTL_MS, DISPATCH_CANDIDATES_MAX, IDEMPOTENCY_MAX_ENTRIES, JEV_DEFAULT_KEY_ENV, JEV_SESSION_CANDIDATES_MAX, resolveJevThresholds } from '../config.ts'
import type { CordisContext } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'
import type { AcceptanceItem, DispatchCandidate, DispatchRecord, TaskRecord, TaskStatus } from '../schema.ts'
import type { JevCallResult, JevClientConfig } from '../jev/client.ts'
import { callJev } from '../jev/client.ts'
import type { JevAnswers } from '../jev/parse.ts'
import { computeJevScores } from '../jev/parse.ts'
import type { DispatchSessionInput, MappedAnswers } from '../jev/request.ts'
import { buildSessionRequest, buildWorkspaceRequest, mapChoice, mapJevAnswers } from '../jev/request.ts'
import { buildDispatchCandidates, collectDispatchContext, collectWorkspaceDirectory, collectWorkspaceSessions, findTargetConflict, resolveWorkspaceReference, type ConfirmationCandidate, type DispatchContext } from './candidates.ts'
import { evaluateGate, needsConfirmationReason } from './gate.ts'
import { createDecisionStore, type DecisionStore, type PendingDecision } from './decisions.ts'
import { spawnDispatch } from './spawn.ts'
import { attachSessionQuestions } from './session-questions.ts'
import { deriveDecisionId } from '../store/base.ts'
import { dependenciesMet, waitingFor } from '../tasks/dependencies.ts'
import { transitionTask } from '../tasks/state-machine.ts'

export interface DispatchTarget {
  workspaceId: string
  mode: 'new' | 'attach'
  sessionId?: string
}

export interface DispatchTaskArgs {
  taskId?: unknown
  candidate?: unknown
  decisionId?: unknown
  confirmTarget?: unknown
  capabilityNeeds?: unknown
  requestId?: unknown
  /** 指挥官传的本轮要求（续派时写进 brief）。 */
  instruction?: unknown
  /** 指挥官传的用户原话（只用于展示/审计，不写进 brief）。 */
  userRequest?: unknown
}

export interface ConfirmationCandidateView {
  workspaceId: string
  workspaceName: string
  workspacePath: string
  mode: 'new' | 'attach'
  sessionId?: string
  sessionTitle?: string
  pWorkspace: number
  pSession: number
  score: number
  reason?: string
}

export interface PendingDispatchView {
  decisionId: string
  taskId: string
  taskTitle: string
  candidates: ConfirmationCandidateView[]
  recommendation: { workspaceId: string; mode: 'new' | 'attach'; sessionId?: string }
  scores: { pWorkspace: number; pSession: number; pMax: number; concentration: number }
  reason: string
  kind: 'initial' | 'continue'
  round: number
  createdAt: number
  expiresAt: number
}

export type DispatchTaskResult =
  | {
      status: 'dispatched'
      taskId: string
      decisionId: string
      sessionId: string
      sessionCreated: boolean
      target: DispatchTarget
      scores: { pWorkspace: number; pSession: number; pMax: number; concentration: number }
      capabilities?: unknown
      round: number
    }
  | {
      status: 'needs_confirmation'
      taskId: string
      decisionId: string
      candidates: ConfirmationCandidateView[]
      recommendation: { workspaceId: string; mode: 'new' | 'attach'; sessionId?: string }
      scores: { pWorkspace: number; pSession: number; pMax: number; concentration: number }
      reason: 'user_confirm_required' | 'jev_unavailable' | 'low_confidence' | 'decision_required' | 'ambiguous_workspace'
      kind: 'initial' | 'continue'
      round: number
      expiresAt: number
    }
  | { status: 'rejected'; code: string; message: string }

export interface DispatchServiceDeps {
  ctx: CordisContext
  stores: StoreSet
  now?: () => number
  jevCall?: (config: JevClientConfig, body: unknown) => Promise<JevCallResult>
  controllerOverride?: unknown
  panelOverride?: unknown
  onPendingDispatch?: (pending: PendingDispatchView | null) => void
  onTaskUpdated?: (taskId: string, status: TaskStatus) => void
  /** H4：spawn 写 task queued + sessions link 之后调用，用于补偿先到的 turn/start。 */
  reconcileSessionStatus?: (taskId: string, sessionId: string) => void | Promise<void>
}

export interface DispatchService {
  dispatchTask(args: DispatchTaskArgs): Promise<DispatchTaskResult>
  currentPending(): PendingDispatchView | null
  prune(): number
  /** accept/cancel/archive 时清掉某任务的未决确认，并广播 pending=null。 */
  invalidateTask(taskId: string): number
  decisions: DecisionStore
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOrUndefined = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const HISTORY_MAX = 5

/** 已有至少一轮：review 或 round>1（恢复回收站/人工改板仍保留 round；不拿 acceptance 推断轮次）。 */
function hasPriorRound(task: Pick<TaskRecord, 'status' | 'round'>): boolean {
  return task.status === 'review' || (task.round ?? 1) > 1
}

function mergeInstruction(task: TaskRecord, decisionInstruction: string | undefined, argInstruction: string | undefined): string {
  const parts = [task.pendingInstruction?.text, decisionInstruction, argInstruction]
    .map(value => (value ?? '').trim())
    .filter((value, index, all) => value !== '' && all.indexOf(value) === index)
  return parts.join('\n').slice(0, 2000)
}

function pickUserRequest(
  task: TaskRecord,
  decisionUserRequest: string | undefined,
  argUserRequest: string | undefined,
  at: number,
): DispatchRecord['userRequest'] | undefined {
  if (task.pendingInstruction !== undefined) {
    return { text: task.pendingInstruction.text, at: task.pendingInstruction.at, source: 'board' }
  }
  const text = (argUserRequest ?? decisionUserRequest ?? '').trim()
  return text === '' ? undefined : { text: text.slice(0, 2000), at, source: 'chat' }
}

function parseTarget(value: unknown): DispatchTarget | null {
  if (!isRecord(value)) return null
  const workspaceId = stringOrUndefined(value.workspaceId)
  const mode = value.mode === 'attach' ? 'attach' : value.mode === 'new' ? 'new' : null
  const sessionId = stringOrUndefined(value.sessionId)
  if (workspaceId === undefined || mode === null) return null
  if (mode === 'attach' && sessionId === undefined) return null
  return { workspaceId, mode, ...(sessionId !== undefined ? { sessionId } : {}) }
}

function toCandidateView(candidate: ConfirmationCandidate): ConfirmationCandidateView {
  return {
    workspaceId: candidate.workspaceId,
    workspaceName: candidate.workspaceName,
    workspacePath: candidate.workspacePath,
    mode: candidate.mode,
    ...(candidate.sessionId !== undefined ? { sessionId: candidate.sessionId } : {}),
    ...(candidate.sessionTitle !== undefined ? { sessionTitle: candidate.sessionTitle } : {}),
    pWorkspace: candidate.pWorkspace,
    pSession: candidate.pSession,
    score: candidate.score,
    ...(candidate.reason !== undefined ? { reason: candidate.reason } : {}),
  }
}

function toPendingView(decision: PendingDecision): PendingDispatchView {
  return {
    decisionId: decision.decisionId,
    taskId: decision.taskId,
    taskTitle: decision.taskTitle,
    candidates: decision.candidates.map(toCandidateView),
    recommendation: {
      workspaceId: decision.recommendation.workspaceId,
      mode: decision.recommendation.mode,
      ...(decision.recommendation.sessionId !== undefined ? { sessionId: decision.recommendation.sessionId } : {}),
    },
    scores: decision.scores,
    reason: decision.reason,
    kind: decision.kind,
    round: decision.round,
    createdAt: decision.createdAt,
    expiresAt: decision.expiresAt,
  }
}

/** 请求级幂等缓存（5min；与 HTTP 路由层 LRU 独立）。 */
function createResultCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000
  const maxEntries = options.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES
  const now = options.now ?? (() => Date.now())
  const store = new Map<string, { at: number; result: DispatchTaskResult }>()
  const prune = (at: number): void => {
    for (const [key, entry] of store) if (at - entry.at > ttlMs) store.delete(key)
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value as string | undefined
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }
  return {
    get(key: string): DispatchTaskResult | undefined {
      prune(now())
      return store.get(key)?.result
    },
    set(key: string, result: DispatchTaskResult): void {
      const at = now()
      store.set(key, { at, result })
      prune(at)
    },
    clear(): void {
      store.clear()
    },
  }
}

const scoreOf = (answers: JevAnswers | undefined, mapped: MappedAnswers) => {
  const scores = computeJevScores(answers ?? {})
  return {
    ...scores,
    pSession: mapped.mode === 'new' ? Math.max(scores.pSession, 1) : scores.pSession,
  }
}

export function createDispatchService(deps: DispatchServiceDeps): DispatchService {
  const now = deps.now ?? (() => Date.now())
  const decisions = createDecisionStore({ ttlMs: DECISION_TTL_MS, now })
  const cache = createResultCache({ now })
  const config = (): ReturnType<StoreSet['config']['get']> => deps.stores.config.get()

  const notifyPending = (): void => {
    deps.onPendingDispatch?.(currentPending())
  }
  const currentPending = (): PendingDispatchView | null => {
    decisions.prune()
    const decision = decisions.current()
    // H3：确认成功后（used=true）pendingDispatch 必须立即为 null，否则前端确认卡无法收起（m1-contract-patch §3.1）。
    if (decision === undefined || decision.used) return null
    return toPendingView(decision)
  }

  const rejected = (code: string, message: string): DispatchTaskResult => ({ status: 'rejected', code, message })

  const finishDispatch = async (input: {
    task: TaskRecord
    decision: PendingDecision
    target: ConfirmationCandidate
    requestId: string
    capabilityNeeds?: string[]
    auto?: boolean
    instruction?: string
    userRequest?: DispatchRecord['userRequest']
  }): Promise<DispatchTaskResult> => {
    // decision 是这一轮的事实来源：review 续派期间人工改状态也不改变「第 N+1 轮」的语义。
    const prior = input.decision.kind === 'continue'
    const nextRound = input.decision.round
    const previousRound = Math.max(1, nextRound - 1)
    const instruction = (input.instruction ?? '').trim()
    const userRequest = input.userRequest ?? pickUserRequest(input.task, input.decision.userRequest, undefined, input.decision.createdAt)
    const spawn = await spawnDispatch({
      ctx: deps.ctx,
      stores: deps.stores,
      task: input.task,
      decisionId: input.decision.decisionId,
      target: input.target,
      requestId: input.requestId,
      ...(input.capabilityNeeds !== undefined ? { capabilityNeeds: input.capabilityNeeds } : {}),
      round: nextRound,
      ...(instruction !== '' ? { instruction } : {}),
      ...(input.task.reportSummary?.text !== undefined ? { previousSummary: input.task.reportSummary.text } : {}),
      ...(input.task.acceptance.length > 0 ? { previousAcceptance: input.task.acceptance } : {}),
      now,
      ...(deps.controllerOverride !== undefined ? { controllerOverride: deps.controllerOverride as never } : {}),
      ...(deps.panelOverride !== undefined ? { panelOverride: deps.panelOverride } : {}),
    })
    if (!spawn.ok) {
      await transitionTask(
        { stores: deps.stores, now, ...(deps.onTaskUpdated !== undefined ? { onTaskChanged: (task: TaskRecord) => deps.onTaskUpdated?.(task.id, task.status) } : {}) },
        {
          taskId: input.task.id,
          to: 'blocked',
          actor: 'host_dispatch',
          context: { blockReason: spawn.message },
          timelineText: `派发失败：${spawn.message}`,
          mutate: (_current, at) => ({ block: { reason: spawn.message, code: spawn.code, since: at } }),
        },
      )
      return rejected(spawn.code, spawn.message)
    }
    const timestamp = now()
    const outcome = input.auto === true
      ? 'auto'
      : input.target.mode === input.decision.recommendation.mode &&
          input.target.workspaceId === input.decision.recommendation.workspaceId &&
          (input.target.mode !== 'attach' || input.target.sessionId === input.decision.recommendation.sessionId)
        ? 'confirmed'
        : 'overridden'
    const dispatchRecord: DispatchRecord = {
      v: 1,
      id: input.decision.decisionId,
      taskId: input.task.id,
      createdAt: input.decision.createdAt,
      prefilter: input.decision.prefilter,
      candidates: input.decision.candidates.map((candidate) => ({
        workspaceId: candidate.workspaceId,
        mode: candidate.mode,
        ...(candidate.sessionId !== undefined ? { sessionId: candidate.sessionId } : {}),
        score: candidate.score,
      })) as DispatchCandidate[],
      modelSuggestion: `${input.decision.recommendation.workspaceId}/${input.decision.recommendation.mode}`,
      jev: {
        provider: input.decision.jev.provider,
        endpoint: input.decision.jev.endpoint,
        model: input.decision.jev.model,
        requestId: input.decision.jev.requestId,
        latencyMs: input.decision.jev.latencyMs,
        ok: input.decision.jev.ok,
        ...(input.decision.jev.error !== undefined ? { error: input.decision.jev.error } : {}),
        pMax: input.decision.scores.pMax,
        concentration: input.decision.scores.concentration,
        ...(input.decision.jev.usage !== undefined
          ? { usage: { input_tokens: input.decision.jev.usage.input_tokens ?? 0, output_tokens: input.decision.jev.usage.output_tokens ?? 0 } }
          : {}),
      },
      outcome,
      finalTarget: { workspaceId: input.target.workspaceId, mode: input.target.mode, sessionId: spawn.sessionId },
      confirmedBy: 'user',
      round: nextRound,
      kind: prior ? 'continue' : 'initial',
      ...(instruction !== '' ? { instruction } : {}),
      brief: spawn.brief,
      ...(userRequest !== undefined ? { userRequest } : {}),
    }
    await deps.stores.dispatches.put(dispatchRecord)
    const applyDispatch = (current: TaskRecord, at: number): Partial<TaskRecord> => {
      const {
        block: _previousBlock,
        pendingInstruction: _previousInstruction,
        reportSummary: _previousSummary,
        reportMaterials: _previousMaterials,
        ...rest
      } = current
      void _previousBlock
      void _previousInstruction
      void _previousSummary
      void _previousMaterials
      const historyEntry = prior && (current.acceptance.length > 0 || current.reportSummary !== undefined || (current.reportMaterials?.length ?? 0) > 0)
        ? [{
            round: previousRound,
            at: current.reportSummary?.at ?? at,
            items: current.acceptance,
            ...(current.reportSummary !== undefined ? { reportSummary: current.reportSummary } : {}),
            ...(current.reportMaterials !== undefined && current.reportMaterials.length > 0 ? { materials: current.reportMaterials } : {}),
          }]
        : []
      const acceptanceHistory = prior
        ? [...(current.acceptanceHistory ?? []), ...historyEntry].slice(-HISTORY_MAX)
        : current.acceptanceHistory
      const workspaceIds = [...new Set([
        ...(current.workspaceIds ?? (current.workspaceId !== '' ? [current.workspaceId] : [])),
        input.target.workspaceId,
      ])]
      return {
      ...rest,
      status: 'queued',
      round: nextRound,
      acceptance: prior ? [] : current.acceptance,
      ...(acceptanceHistory !== undefined ? { acceptanceHistory } : {}),
      reportSummary: prior ? undefined : current.reportSummary,
      reportMaterials: prior ? undefined : current.reportMaterials,
      workspaceId: input.target.workspaceId, // 当前轮目标工作区（commander_task_create 可能未挂工作区）
      workspaceIds,
      dispatchId: dispatchRecord.id,
      primarySessionId: spawn.sessionId,
      assignments: [...new Set([...current.assignments, spawn.sessionId])],
      ...(spawn.capabilities !== undefined ? { capabilities: spawn.capabilities } : {}),
      timeline: [...current.timeline, {
        at,
        type: prior ? 'continue' as const : 'dispatch' as const,
        round: nextRound,
        text: prior
          ? `第 ${nextRound} 轮继续派发到 ${input.target.workspaceId}（${input.target.mode}）· ${outcome}`
          : `派发到 ${input.target.workspaceId}（${input.target.mode}）· ${outcome}`,
        sessionId: spawn.sessionId,
      }].slice(-100),
      updatedAt: at,
      lastActivityAt: at,
      } as Partial<TaskRecord>
    }
    // H4：prompt 先于 task/link 写入，工作会话的 turn/start 可能在这段时间把 task version 顶掉
    //（19s 长派发实测：第一次工具调用因版本冲突失败但 brief 已发出，指挥官重试会重复派发）。
    // 这里按最新 version 重试应用同一次派发；轮次已被别的派发推进时才拒绝覆盖。
    let updated: TaskRecord | undefined
    try {
      const transition = await transitionTask(
        { stores: deps.stores, now, ...(deps.onTaskUpdated !== undefined ? { onTaskChanged: (task: TaskRecord) => deps.onTaskUpdated?.(task.id, task.status) } : {}) },
        {
          taskId: input.task.id,
          to: 'queued',
          actor: 'host_dispatch',
          context: { hasPrimarySession: true },
          round: nextRound,
          mutate: (current, at) => {
            if ((current.round ?? 1) !== previousRound) {
              const error = new Error('task round changed during dispatch')
              error.name = 'RoundChangedError'
              throw error
            }
            return applyDispatch(current, at)
          },
        },
      )
      if (!transition.ok) {
        if (transition.code === 'version_conflict') throw new Error('task version changed during dispatch')
        return rejected(transition.code === 'not_found' ? 'unknown_task' : 'task_state', transition.message)
      }
      updated = transition.task
    } catch (error) {
      if ((error as { name?: string }).name === 'RoundChangedError') {
        return rejected('decision_expired', 'task round changed during dispatch; call commander_task_dispatch again')
      }
      throw error
    }
    await deps.stores.sessions.upsert({
      v: 1,
      sessionId: spawn.sessionId,
      workspaceId: input.target.workspaceId,
      taskId: input.task.id,
      role: 'work',
      mode: input.target.mode,
      createdAt: timestamp,
      status: 'queued',
      round: nextRound,
    })
    decisions.markUsed(input.decision.decisionId)
    notifyPending()
    try {
      await deps.reconcileSessionStatus?.(updated.id, spawn.sessionId)
    } catch {
      /* 补偿失败不影响派发结果 */
    }
    // H5：dispatched 的 target 必须只含契约字段（内部 ConfirmationCandidate 还带 workspaceName/pWorkspace 等展示字段，
    // 直接复用会被 DSH 工具输出校验（additionalProperties:false）拒绝）。
    const dispatchedTarget: DispatchTarget = {
      workspaceId: input.target.workspaceId,
      mode: input.target.mode,
      ...(input.target.mode === 'attach' && input.target.sessionId !== undefined ? { sessionId: spawn.sessionId } : {}),
    }
    return {
      status: 'dispatched',
      taskId: input.task.id,
      decisionId: input.decision.decisionId,
      sessionId: spawn.sessionId,
      sessionCreated: spawn.sessionCreated,
      target: dispatchedTarget,
      scores: input.decision.scores,
      round: nextRound,
      ...(spawn.capabilities !== undefined ? { capabilities: spawn.capabilities } : {}),
    }
  }

  const replayDispatch = (decisionId: string): DispatchTaskResult | null => {
    const record = deps.stores.dispatches.get(decisionId)
    if (record === undefined) return null
    const finalTarget = record.finalTarget
    if (finalTarget === undefined) return null
    return {
      status: 'dispatched',
      taskId: record.taskId,
      decisionId: record.id,
      sessionId: finalTarget.sessionId ?? '',
      sessionCreated: finalTarget.mode === 'new',
      target: { workspaceId: finalTarget.workspaceId, mode: finalTarget.mode, ...(finalTarget.sessionId !== undefined ? { sessionId: finalTarget.sessionId } : {}) },
      scores: { pWorkspace: 0, pSession: 0, pMax: record.jev.pMax ?? 0, concentration: record.jev.concentration ?? 0 },
      round: record.round ?? 1,
    }
  }

  interface JevCallOutcome {
    ok: boolean
    answers?: JevAnswers
    mode: 'two_stage'
    wIndex: Map<string, string>
    sIndex: Map<string, string>
    tokenEstimate: number
    call: JevCallResult
    sessionCapped: boolean
  }

  /** 固定两段：先问工作区，再问该工作区内会话（ARCHITECTURE §5.1–§5.5）。 */
  const requestJev = async (context: DispatchContext, task: TaskRecord): Promise<JevCallOutcome> => {
    const jevConfig = config().jev
    const clientConfig: JevClientConfig = {
      endpoint: jevConfig.endpoint || 'https://api.typesafe.ai/v1/systemone',
      model: jevConfig.model || 'jev-latest',
      envVar: jevConfig.envVar || JEV_DEFAULT_KEY_ENV,
      timeoutMs: jevConfig.timeoutMs,
    }
    const taskInput = { title: task.title, goal: task.goal, priority: task.priority }
    const call = deps.jevCall ?? callJev

    const workspaceRequest = buildWorkspaceRequest({ model: clientConfig.model, task: taskInput, workspaces: context.workspaces })
    const workspaceCall = await call(clientConfig, workspaceRequest.body)
    if (!workspaceCall.ok || workspaceCall.response === undefined) {
      return { ok: false, mode: 'two_stage', wIndex: workspaceRequest.wIndex, sIndex: new Map(), tokenEstimate: workspaceRequest.tokenEstimate, call: workspaceCall, sessionCapped: false }
    }
    const workspaceAnswers = workspaceCall.response.answers
    const chosenWorkspaceId = mapChoice(workspaceRequest.wIndex, workspaceAnswers.workspace?.choice)
    const workspace = context.workspaces.find((item) => item.id === chosenWorkspaceId)
    if (workspace === undefined) {
      return {
        ok: false,
        mode: 'two_stage',
        wIndex: workspaceRequest.wIndex,
        sIndex: new Map(),
        tokenEstimate: workspaceRequest.tokenEstimate,
        call: { ...workspaceCall, ok: false, error: { code: 'bad_response', message: 'Jev workspace answer did not map to an allowed workspace' } },
        sessionCapped: false,
      }
    }

    const candidates = context.sessions.filter((session: DispatchSessionInput) => session.workspaceId === workspace.id)
    const scoped = candidates.slice(0, JEV_SESSION_CANDIDATES_MAX)
    const enriched = await attachSessionQuestions(deps.ctx, scoped)
    const sessionRequest = buildSessionRequest({ model: clientConfig.model, task: taskInput, workspace, sessions: enriched })
    const sessionCall = await call(clientConfig, sessionRequest.body)
    const sessionCapped = candidates.length > scoped.length
    if (!sessionCall.ok || sessionCall.response === undefined) {
      return { ok: false, mode: 'two_stage', wIndex: workspaceRequest.wIndex, sIndex: sessionRequest.sIndex, tokenEstimate: workspaceRequest.tokenEstimate + sessionRequest.tokenEstimate, call: sessionCall, sessionCapped }
    }

    const answers: JevAnswers = {
      ...(workspaceAnswers.workspace !== undefined ? { workspace: workspaceAnswers.workspace } : {}),
      ...(sessionCall.response.answers.session !== undefined ? { session: sessionCall.response.answers.session } : {}),
    }
    const inputTokens = (workspaceCall.usage?.input_tokens ?? 0) + (sessionCall.usage?.input_tokens ?? 0)
    const outputTokens = (workspaceCall.usage?.output_tokens ?? 0) + (sessionCall.usage?.output_tokens ?? 0)
    const mergedCall: JevCallResult = {
      ...sessionCall,
      ...(inputTokens > 0 || outputTokens > 0 ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens } } : {}),
    }
    return {
      ok: true,
      answers,
      mode: 'two_stage',
      wIndex: workspaceRequest.wIndex,
      sIndex: sessionRequest.sIndex,
      tokenEstimate: workspaceRequest.tokenEstimate + sessionRequest.tokenEstimate,
      call: mergedCall,
      sessionCapped,
    }
  }

  const firstCall = async (args: DispatchTaskArgs): Promise<DispatchTaskResult> => {
    const taskId = stringOrUndefined(args.taskId)
    const requestId = stringOrUndefined(args.requestId)
    if (taskId === undefined) return rejected('unknown_task', 'taskId is required')
    if (requestId === undefined) return rejected('invalid_request', 'requestId is required')
    const task = deps.stores.tasks.get(taskId)
    if (task === undefined) return rejected('unknown_task', `task '${taskId}' not found`)
    if (task.status !== 'draft' && task.status !== 'proposed' && task.status !== 'review') {
      return rejected('task_state', `task status '${task.status}' is not dispatchable`)
    }
    const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
    if (!dependenciesMet(task, lookup)) {
      const missing = waitingFor(task, lookup)
      return rejected('dependency_unmet', `dependencies not met: ${missing.join(', ')}（验收依赖任务后再派发；本次未生成确认卡）`)
    }
    const existingPending = decisions.current()
    if (existingPending !== undefined && !existingPending.used && existingPending.taskId !== task.id) {
      return rejected('pending_dispatch_exists', `task '${existingPending.taskId}' already has a pending dispatch confirmation; resolve it before dispatching another task`)
    }
    const prior = hasPriorRound(task)
    const targetRound = prior ? (task.round ?? 1) + 1 : (task.round ?? 1)
    decisions.prune()
    const commanderSessionId = config().commander.sessionId
    const context = await collectDispatchContext({ ctx: deps.ctx, stores: deps.stores, commanderSessionId })
    if (context.workspaces.length === 0) {
      return rejected('no_workspace', '当前没有已启用工作区：请先调 commander_workspace_list；若返回为空，需在设置页启用工作区后再派发，或用 commander_task_create({workspaceId}) 指定已启用的工作区')
    }
    let requestedCandidate = parseTarget(args.candidate)
    // 续派默认回原会话（M5）：仅在会话存在、未归档、工作区 allowed 时作为首选。
    if (requestedCandidate === null && prior && task.primarySessionId !== undefined) {
      const primarySession = context.sessions.find((session) => session.id === task.primarySessionId)
      if (primarySession !== undefined && context.allowedWorkspaceIds.includes(primarySession.workspaceId)) {
        requestedCandidate = { workspaceId: primarySession.workspaceId, mode: 'attach', sessionId: primarySession.id }
      }
    }
    // 首次派发：commander_task_create 已挂 workspaceId 时作为首选提示（M1 live：模型先在 commander_task_create 带 workspaceId，再派发）
    if (requestedCandidate === null && !prior && task.workspaceId !== '') {
      requestedCandidate = { workspaceId: task.workspaceId, mode: 'new' }
    }
    // 兼容 pane/模型传 name/path（M1 live：模型拿不到 id 只能猜名字/路径）：
    // 用全部工作区目录把 candidate.workspaceId 归一成真实 id；歧义 → 走 needs_confirmation（候选列表），不报 no_workspace。
    if (requestedCandidate !== null) {
      const directory = await collectWorkspaceDirectory({ ctx: deps.ctx, stores: deps.stores })
      const resolution = resolveWorkspaceReference(directory, requestedCandidate.workspaceId)
      if (resolution.status === 'ambiguous') {
        const matched = resolution.candidates.filter((entry) => entry.allowed)
        if (matched.length === 0) {
          return rejected('no_workspace', `工作区 "${requestedCandidate.workspaceId}" 匹配到多个但都未启用；请先调 commander_workspace_list 获取已启用工作区 id（${directory.filter((entry) => entry.allowed).map((entry) => entry.id).join(', ') || '无'}）`)
        }
        if (matched.length === 1) {
          requestedCandidate = { ...requestedCandidate, workspaceId: (matched[0] as { id: string }).id }
        } else {
          const timestamp = now()
          const ambiguousCandidates: ConfirmationCandidate[] = matched.map((entry, index) => ({
            workspaceId: entry.id,
            workspaceName: entry.name,
            workspacePath: entry.path,
            mode: 'new' as const,
            pWorkspace: 0,
            pSession: 0,
            score: index === 0 ? 1 : 0,
            reason: 'ambiguous_workspace',
          }))
          const decisionId = deriveDecisionId(task.id, requestId as string)
          const decision = decisions.create({
            decisionId,
            taskId: task.id,
            taskTitle: task.title,
            candidates: ambiguousCandidates,
            recommendation: ambiguousCandidates[0] as ConfirmationCandidate,
            scores: { pWorkspace: 0, pSession: 0, pMax: 0, concentration: 0 },
            reason: 'ambiguous_workspace',
            jev: { provider: config().jev.provider, endpoint: config().jev.endpoint, model: config().jev.model, requestId: requestId as string, latencyMs: 0, ok: false, mode: 'two_stage', tokenEstimate: 0, error: { code: 'ambiguous_workspace', message: `"${requestedCandidate.workspaceId}" 匹配到多个工作区` } },
            prefilter: { workspaceIds: matched.map((entry) => entry.id), sessionIds: [], scores: {}, truncated: false },
            createdAtRequestId: requestId as string,
            kind: prior ? 'continue' : 'initial',
            round: targetRound,
            ...(stringOrUndefined(args.instruction) !== undefined ? { instruction: stringOrUndefined(args.instruction) as string } : {}),
            ...(stringOrUndefined(args.userRequest) !== undefined ? { userRequest: stringOrUndefined(args.userRequest) as string } : {}),
          })
          if (prior) {
            const updated = await deps.stores.tasks.update(task.id, (current) => ({
              ...current,
              timeline: [...current.timeline, { at: timestamp, type: 'dispatch' as const, round: targetRound, text: `needs_confirmation ${decision.decisionId}（工作区名称/路径歧义，候选 ${ambiguousCandidates.length}）` }].slice(-100),
              updatedAt: timestamp,
              lastActivityAt: timestamp,
            }), task.version)
            deps.onTaskUpdated?.(updated.id, updated.status)
          } else {
            const transition = await transitionTask(
              { stores: deps.stores, now: () => timestamp, ...(deps.onTaskUpdated !== undefined ? { onTaskChanged: (row: TaskRecord) => deps.onTaskUpdated?.(row.id, row.status) } : {}) },
              {
                taskId: task.id,
                to: 'proposed',
                actor: 'host_dispatch',
                round: targetRound,
                timelineText: `needs_confirmation ${decision.decisionId}（工作区名称/路径歧义，候选 ${ambiguousCandidates.length}）`,
              },
            )
            if (!transition.ok) {
              decisions.invalidateTask(task.id)
              notifyPending()
              return rejected(transition.code === 'not_found' ? 'unknown_task' : 'task_state', transition.message)
            }
          }
          notifyPending()
          const view = toPendingView(decision)
          return { status: 'needs_confirmation', taskId: task.id, decisionId: decision.decisionId, candidates: view.candidates, recommendation: view.recommendation, scores: view.scores, reason: 'ambiguous_workspace', kind: view.kind, round: view.round, expiresAt: decision.expiresAt }
        }
      } else if (resolution.status === 'not_found') {
        return rejected('no_workspace', `工作区 "${requestedCandidate.workspaceId}" 不存在；请先调 commander_workspace_list 获取已启用工作区 id（当前已启用：${resolution.allowedHint}）`)
      } else {
        requestedCandidate = { ...requestedCandidate, workspaceId: resolution.workspace.id }
      }
    }
    if (requestedCandidate !== null && !context.allowedWorkspaceIds.includes(requestedCandidate.workspaceId)) {
      return rejected('invalid_target', `workspace '${requestedCandidate.workspaceId}' is not allowed（请先调 commander_workspace_list 获取已启用工作区 id）`)
    }
    const jev = await requestJev(context, task)
    const mapped: MappedAnswers = jev.ok && jev.answers !== undefined
      ? mapJevAnswers(jev.answers, jev.wIndex, jev.sIndex)
      : requestedCandidate !== null
        ? { workspaceId: requestedCandidate.workspaceId, sessionId: requestedCandidate.mode === 'attach' ? requestedCandidate.sessionId ?? null : null, mode: requestedCandidate.mode }
        : { workspaceId: context.workspaces[0]?.id ?? null, sessionId: null, mode: 'new' as const }
    // 用户/模型显式给了 candidate：确认卡推荐以它为准（Jev 结果仅用于 scores/备选展示）
    if (requestedCandidate !== null) {
      mapped.workspaceId = requestedCandidate.workspaceId
      mapped.mode = requestedCandidate.mode
      mapped.sessionId = requestedCandidate.mode === 'attach' ? requestedCandidate.sessionId ?? null : null
    }
    const conflict = findTargetConflict(context, mapped)
    if (conflict !== null) {
      mapped.mode = 'new'
      mapped.sessionId = null
    }
    const computed = buildDispatchCandidates({
      context,
      answers: jev.ok ? jev.answers : undefined,
      mapped,
      max: DISPATCH_CANDIDATES_MAX,
    })
    const scores = computeJevScores(jev.ok ? jev.answers ?? {} : {})
    const thresholds = resolveJevThresholds(config().jev)
    const reason = needsConfirmationReason({ jevOk: jev.ok, scores, pWorkspaceThreshold: thresholds.workspace, pSessionThreshold: thresholds.session })
    // 自动派发（用户 2026-11-19 开放）：开关打开且门控通过就跳过确认；续派同样复用该门控（100% 不再强制确认）。
    if (config().jev.autoDispatch === true) {
      const gate = evaluateGate({
        scores,
        conflict: conflict !== null,
        jevOk: jev.ok,
        pWorkspaceThreshold: thresholds.workspace,
        pSessionThreshold: thresholds.session,
      })
      if (gate.pass) {
        const timestamp = now()
        const autoDecision: PendingDecision = {
          decisionId: deriveDecisionId(task.id, requestId),
          taskId: task.id,
          taskTitle: task.title,
          candidates: computed.candidates,
          recommendation: computed.recommendation,
          scores,
          reason,
          jev: {
            provider: config().jev.provider,
            endpoint: config().jev.endpoint,
            model: config().jev.model,
            requestId,
            latencyMs: jev.call.latencyMs,
            ok: jev.ok,
            mode: jev.mode,
            tokenEstimate: jev.tokenEstimate,
            ...(jev.call.error !== undefined ? { error: { code: jev.call.error.code, message: jev.call.error.message } } : {}),
            ...(jev.call.usage !== undefined ? { usage: jev.call.usage } : {}),
          },
          prefilter: {
            workspaceIds: context.workspaces.map((workspace) => workspace.id),
            sessionIds: context.sessions.map((session) => session.id),
            scores: Object.fromEntries(computed.candidates.map((candidate) => [`${candidate.workspaceId}:${candidate.mode}`, candidate.score])),
            truncated: jev.sessionCapped,
          },
          createdAt: timestamp,
          expiresAt: timestamp + DECISION_TTL_MS,
          used: false,
          createdAtRequestId: requestId,
          kind: prior ? 'continue' : 'initial',
          round: targetRound,
          ...(stringOrUndefined(args.instruction) !== undefined ? { instruction: stringOrUndefined(args.instruction) as string } : {}),
          ...(stringOrUndefined(args.userRequest) !== undefined ? { userRequest: stringOrUndefined(args.userRequest) as string } : {}),
        }
        const autoUserRequest = pickUserRequest(task, undefined, stringOrUndefined(args.userRequest), timestamp)
        const autoInstruction = mergeInstruction(task, undefined, stringOrUndefined(args.instruction))
        return finishDispatch({
          task,
          decision: autoDecision,
          target: computed.recommendation,
          requestId,
          auto: true,
          ...(autoInstruction !== '' ? { instruction: autoInstruction } : {}),
          ...(autoUserRequest !== undefined ? { userRequest: autoUserRequest } : {}),
        })
      }
    }
    const decisionId = deriveDecisionId(task.id, requestId)
    const decision = decisions.create({
      decisionId,
      taskId: task.id,
      taskTitle: task.title,
      candidates: computed.candidates,
      recommendation: computed.recommendation,
      scores,
      reason,
      jev: {
        provider: config().jev.provider,
        endpoint: config().jev.endpoint,
        model: config().jev.model,
        requestId,
        latencyMs: jev.call.latencyMs,
        ok: jev.ok,
        mode: jev.mode,
        tokenEstimate: jev.tokenEstimate,
        ...(jev.call.error !== undefined ? { error: { code: jev.call.error.code, message: jev.call.error.message } } : {}),
        ...(jev.call.usage !== undefined ? { usage: jev.call.usage } : {}),
      },
      prefilter: {
        workspaceIds: context.workspaces.map((workspace) => workspace.id),
        sessionIds: context.sessions.map((session) => session.id),
        scores: Object.fromEntries(computed.candidates.map((candidate) => [`${candidate.workspaceId}:${candidate.mode}`, candidate.score])),
        truncated: jev.sessionCapped,
      },
      createdAtRequestId: requestId,
      kind: prior ? 'continue' : 'initial',
      round: targetRound,
      ...(stringOrUndefined(args.instruction) !== undefined ? { instruction: stringOrUndefined(args.instruction) as string } : {}),
      ...(stringOrUndefined(args.userRequest) !== undefined ? { userRequest: stringOrUndefined(args.userRequest) as string } : {}),
    })
    const timestamp = now()
    if (prior) {
      const updated = await deps.stores.tasks.update(task.id, (current) => ({
        ...current,
        timeline: [...current.timeline, { at: timestamp, type: 'dispatch' as const, round: targetRound, text: `needs_confirmation ${decision.decisionId}（候选 ${computed.candidates.length}，reason=${reason}）` }].slice(-100),
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      }), task.version)
      deps.onTaskUpdated?.(updated.id, updated.status)
    } else {
      const transition = await transitionTask(
        { stores: deps.stores, now: () => timestamp, ...(deps.onTaskUpdated !== undefined ? { onTaskChanged: (row: TaskRecord) => deps.onTaskUpdated?.(row.id, row.status) } : {}) },
        {
          taskId: task.id,
          to: 'proposed',
          actor: 'host_dispatch',
          round: targetRound,
          timelineText: `needs_confirmation ${decision.decisionId}（候选 ${computed.candidates.length}，reason=${reason}）`,
        },
      )
      if (!transition.ok) {
        decisions.invalidateTask(task.id)
        notifyPending()
        return rejected(transition.code === 'not_found' ? 'unknown_task' : 'task_state', transition.message)
      }
    }
    notifyPending()
    const view = toPendingView(decision)
    const result: DispatchTaskResult = {
      status: 'needs_confirmation',
      taskId: task.id,
      decisionId: decision.decisionId,
      candidates: view.candidates,
      recommendation: view.recommendation,
      scores: { ...view.scores, pWorkspace: scores.pWorkspace, pSession: scores.pSession, pMax: scores.pMax, concentration: scores.concentration },
      reason,
      kind: view.kind,
      round: view.round,
      expiresAt: decision.expiresAt,
    }
    return result
  }


  return {
    async dispatchTask(args) {
      const requestId = stringOrUndefined(args.requestId)
      const taskId = stringOrUndefined(args.taskId)
      if (requestId !== undefined) {
        const cached = cache.get(requestId)
        if (cached !== undefined) return cached
      }
      // 确认路径：decisionId（或唯一 pending 下的原 candidate）
      let decision: PendingDecision | undefined
      let decisionId = stringOrUndefined(args.decisionId)
      if (decisionId !== undefined) {
        const usable = decisions.getUsable(decisionId, taskId ?? '')
        if ('error' in usable) return rejected('decision_expired', '确认已过期，请重新调用 commander_task_dispatch')
        decision = usable.decision
        if (decision.used) {
          const replay = replayDispatch(decisionId)
          if (replay !== null) {
            if (requestId !== undefined) cache.set(requestId, replay)
            return replay
          }
          return rejected('decision_expired', '确认已过期，请重新调用 commander_task_dispatch')
        }
      } else if (args.candidate !== undefined && taskId !== undefined) {
        const pending = decisions.pendingForTask(taskId)
        if (pending.length > 1) return rejected('decision_required', '存在多个待确认决策，请带 decisionId')
        if (pending.length === 1) {
          // 唯一 pending：把 candidate 视为确认目标（m1-contract-patch §1.5 兼容路径）
          decision = pending[0]
          decisionId = decision?.decisionId
        }
        // pending=0：candidate 作为首次派发的“工作区提示”继续走 firstCall，而不是 decision_required
      }
      if (decision !== undefined && decisionId !== undefined) {
        const task = deps.stores.tasks.get(decision.taskId)
        if (task === undefined) return rejected('unknown_task', `task '${decision.taskId}' not found`)
        if (task.status !== 'draft' && task.status !== 'proposed' && task.status !== 'review') {
          return rejected('task_state', `task status '${task.status}' is not dispatchable`)
        }
        const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
        if (!dependenciesMet(task, lookup)) {
          const missing = waitingFor(task, lookup)
          return rejected('dependency_unmet', `dependencies not met: ${missing.join(', ')}（验收依赖任务后再派发；本次未生成确认卡）`)
        }
        const expectedRound = decision.kind === 'continue' ? (task.round ?? 1) + 1 : (task.round ?? 1)
        if (expectedRound !== decision.round) return rejected('decision_expired', '任务轮次已变化，请重新调用 commander_task_dispatch')
        const explicit = parseTarget(args.confirmTarget) ?? parseTarget(args.candidate)
        const target: ConfirmationCandidate = explicit !== null
          ? {
              workspaceId: explicit.workspaceId,
              workspaceName: decision.candidates.find((item) => item.workspaceId === explicit.workspaceId)?.workspaceName ?? explicit.workspaceId,
              workspacePath: decision.candidates.find((item) => item.workspaceId === explicit.workspaceId)?.workspacePath ?? '',
              mode: explicit.mode,
              ...(explicit.sessionId !== undefined ? { sessionId: explicit.sessionId } : {}),
              pWorkspace: decision.scores.pWorkspace,
              pSession: decision.scores.pSession,
              score: decision.scores.pMax,
            }
          : decision.recommendation
        // 白名单/归属校验
        const context = await collectDispatchContext({ ctx: deps.ctx, stores: deps.stores, commanderSessionId: config().commander.sessionId })
        if (!context.allowedWorkspaceIds.includes(target.workspaceId)) return rejected('invalid_target', `workspace '${target.workspaceId}' is not allowed（请先调 commander_workspace_list 获取已启用工作区 id）`)
        if (target.mode === 'attach') {
          // M1R：attach 必须校验「会话存在 + 归属目标工作区 + 未归档」；同会话已有活跃任务时拒绝（避免两个任务并行写入同一会话）。
          const sessionId = target.sessionId ?? ''
          if (sessionId === '') return rejected('invalid_target', 'attach target requires sessionId')
          const workspaceSessions = await collectWorkspaceSessions({ ctx: deps.ctx, stores: deps.stores, workspaceId: target.workspaceId, includeArchived: true })
          if (workspaceSessions.status === 'not_found') return rejected('invalid_target', `workspace '${target.workspaceId}' 不存在`)
          const session = workspaceSessions.sessions.find((item) => item.id === sessionId)
          if (session === undefined) return rejected('invalid_target', `session '${sessionId}' 不存在、已归档、是子代理/teammate 会话或不属于 workspace '${target.workspaceId}'；请用 commander_session_list({workspaceId}) 查看可用根会话`)
          if (session.archived) return rejected('invalid_target', `session '${sessionId}' 已归档，不能 attach`)
          if (sessionId === deps.stores.config.get().commander.sessionId) return rejected('invalid_target', '不能 attach 到指挥官自身会话')
          // 契约 §1.2.4：不检查“已被其它任务占用”，同工作区多任务可 attach 同一会话（记录 assignment，靠 prompt queue 排队）。
          const conflict = findTargetConflict(context, { workspaceId: target.workspaceId, sessionId, mode: 'attach' })
          if (conflict !== null) return rejected('invalid_target', conflict.message)
        }
        const capabilityNeeds = Array.isArray(args.capabilityNeeds) ? args.capabilityNeeds.filter((item): item is string => typeof item === 'string').slice(0, 10) : undefined
        const instruction = mergeInstruction(task, decision.instruction, stringOrUndefined(args.instruction))
        const userRequest = pickUserRequest(task, decision.userRequest, stringOrUndefined(args.userRequest), decision.createdAt)
        const result = await finishDispatch({
          task,
          decision,
          target,
          requestId: requestId ?? `confirm_${decisionId}`,
          ...(capabilityNeeds !== undefined ? { capabilityNeeds } : {}),
          ...(instruction !== '' ? { instruction } : {}),
          ...(userRequest !== undefined ? { userRequest } : {}),
        })
        if (requestId !== undefined) cache.set(requestId, result)
        return result
      }
      const result = await firstCall(args)
      if (requestId !== undefined && result.status !== 'rejected') cache.set(requestId, result)
      return result
    },
    currentPending,
    prune: () => decisions.prune(),
    invalidateTask(taskId) {
      const removed = decisions.invalidateTask(taskId)
      if (removed > 0) notifyPending()
      return removed
    },
    decisions,
  }
}

export { AUTO_DISPATCH }
