// 提交（确认后执行）：create/attach 会话 → capability auto（仅 new+policy=auto）→ prompt brief。
// 契约：m1-contract-patch §1.6；session.create 二选一（M0-H1 合同）；prompt 保留 receiver + AbortSignal（M0 教训）。
import type { CordisContext, SessionControllerService } from '../dsh-types.ts'
import type { CapabilityPlan, TaskRecord } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'
import type { ConfirmationCandidate } from './candidates.ts'
import { runAutoCapability } from './capability.ts'
import { buildDispatchBrief } from './brief.ts'

export type SpawnErrorCode = 'session_create_failed' | 'delivery_failed' | 'invalid_target' | 'unknown_task'

export interface SpawnInput {
  ctx: CordisContext
  stores: StoreSet
  task: TaskRecord
  decisionId: string
  target: ConfirmationCandidate
  requestId: string
  capabilityNeeds?: string[]
  round?: number
  instruction?: string
  previousSummary?: string
  previousAcceptance?: import('../schema.ts').AcceptanceItem[]
  now?: () => number
  /** 测试注入：会话创建/prompt。 */
  controllerOverride?: SessionControllerService
  panelOverride?: unknown
}

export interface SpawnResult {
  ok: true
  sessionId: string
  sessionCreated: boolean
  capabilities?: CapabilityPlan
  brief: string
}

export interface SpawnFailure {
  ok: false
  code: SpawnErrorCode
  message: string
  sessionId?: string
}

const controllerOf = (ctx: CordisContext, override?: SessionControllerService): SessionControllerService | undefined =>
  override ?? (ctx.get('sessionController') as SessionControllerService | undefined)

/** 构造 brief 用 draft（能力面板 rank 的 draft = 任务目标 + 能力需求建议）。 */
export function capabilityDraft(task: Pick<TaskRecord, 'title' | 'goal'>, capabilityNeeds: string[] | undefined): string {
  const needs = (capabilityNeeds ?? []).slice(0, 10).join('；')
  return needs === '' ? `${task.title}\n${task.goal}` : `${task.title}\n${task.goal}\n能力需求：${needs}`
}

/** 提交一次派发（由 service 在确认后调用，不写 dispatches/task 状态——service 负责落盘）。 */
export async function spawnDispatch(input: SpawnInput): Promise<SpawnResult | SpawnFailure> {
  const controller = controllerOf(input.ctx, input.controllerOverride)
  if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    return { ok: false, code: 'session_create_failed', message: 'sessionController is unavailable' }
  }
  const now = input.now ?? (() => Date.now())
  const workspaceRecord = input.stores.workspaces.get(input.target.workspaceId)
  const policy = workspaceRecord?.capabilityPolicy.mode ?? 'inherit'
  let sessionId = input.target.sessionId ?? ''
  let sessionCreated = false
  let capabilities: CapabilityPlan | undefined
  if (input.target.mode === 'new') {
    try {
      const created = await controller.create({
        ...(input.target.workspaceId !== '' ? { workspaceId: input.target.workspaceId } : {}),
      })
      const createdId = created?.sessionId ?? created?.id
      if (typeof createdId !== 'string' || createdId === '') return { ok: false, code: 'session_create_failed', message: 'sessionController.create returned no sessionId' }
      sessionId = createdId
      sessionCreated = true
    } catch (error) {
      return { ok: false, code: 'session_create_failed', message: String((error as Error)?.message ?? error).slice(0, 300) }
    }
    if (policy === 'auto') {
      const capability = await runAutoCapability({
        ctx: input.ctx,
        sessionId,
        draft: capabilityDraft(input.task, input.capabilityNeeds),
        ...(input.target.workspacePath !== '' ? { cwd: input.target.workspacePath } : {}),
        policy,
        now,
        ...(input.panelOverride !== undefined ? { panelOverride: input.panelOverride } : {}),
      })
      capabilities = capability.plan
    } else {
      capabilities = { policy: 'inherit', executor: 'capability-panel', status: 'inherited', enabled: [], disabled: [], at: now() }
    }
  } else if (sessionId === '') {
    return { ok: false, code: 'invalid_target', message: 'attach target requires sessionId' }
  }
  const sameSession = input.target.mode === 'attach'
    && input.target.sessionId !== undefined
    && input.task.primarySessionId !== undefined
    && input.target.sessionId === input.task.primarySessionId
  const brief = buildDispatchBrief({
    title: input.task.title,
    goal: input.task.goal,
    acceptance: input.task.acceptance,
    ...(input.round !== undefined ? { round: input.round } : {}),
    ...(sameSession ? { sameSession: true } : {}),
    ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
    ...(input.previousAcceptance !== undefined ? { previousAcceptance: input.previousAcceptance } : {}),
  })
  try {
    const result = await controller.prompt(
      { requestId: input.requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: brief }] },
      new AbortController().signal,
    )
    if (result?.accepted !== true) {
      return { ok: false, code: 'delivery_failed', message: String(result?.error?.message ?? 'prompt was not accepted').slice(0, 300), sessionId }
    }
  } catch (error) {
    return { ok: false, code: 'delivery_failed', message: String((error as Error)?.message ?? error).slice(0, 300), sessionId }
  }
  return { ok: true, sessionId, sessionCreated, ...(capabilities !== undefined ? { capabilities } : {}), brief }
}
