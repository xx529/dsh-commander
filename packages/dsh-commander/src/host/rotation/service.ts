// R1：轮换服务（判定 / 门控 / 简报 / 注入 / 提交 / 退避）。
// 口径：docs/architecture/rotation-contract-patch.md §3/§5/§8。
import { basename } from 'node:path'
import {
  BRIEF_USER_LINES_MAX,
  FORMER_COMMANDERS_MAX,
  ROTATION_AGENT_RETRY_COUNT,
  ROTATION_AGENT_RETRY_DELAY_MS,
  ROTATION_FAILURE_BACKOFF_MS,
  ROTATION_TIMEOUT_MS,
} from '../config.ts'
import { buildContextMessage } from '../session/deliver.ts'
import { readSessionEvents } from '../session/session-records.ts'
import type { BindingService } from '../session/binding.ts'
import type { ConfigStore } from '../store/config.ts'
import type { SessionStore } from '../store/sessions.ts'
import type { WorkspaceStore } from '../store/workspaces.ts'
import type {
  AgentsService,
  AgentLike,
  CordisContext,
  SessionControllerService,
  SessionEventLike,
} from '../dsh-types.ts'
import type { ConfigRecord, TaskRecord } from '../schema.ts'
import { migrateCommanderSchedules, scheduleMigrationFailure, type ScheduleMigrationInput, type ScheduleMigrationResult } from '../schedule/migration.ts'
import { buildHandoffBrief, type BriefUserLine, type HandoffBrief, type HandoffBriefStats } from './brief.ts'
import { briefWindowStart, resolveRotation, rotationDue, rotationDueAt, type ResolvedRotation } from './config.ts'
import type { ToolAuditResult } from './tool-audit.ts'
import { applyRotationTitleDefault, applyToolAuditDefault } from './generation-defaults.ts'

export type RotationPhase = 'idle' | 'due' | 'rotating' | 'failed'

export interface RotationView {
  enabled: boolean
  periodDays: number
  includeUserTail: boolean
  generation: number
  startedAt: number
  dueAt: number
  due: boolean
  rotating: boolean
  lastError?: { code: string; message: string; at: number }
}

export interface FormerCommander {
  sessionId: string
  generation: number
  startedAt: number
  retiredAt: number
}

export interface RotationResult {
  rotated: boolean
  reason?: 'not_due' | 'no_activity'
  generation: number
  sessionId: string
  previousSessionId?: string
  startedAt?: number
  brief?: HandoffBriefStats
  /** 换代后的定时任务跟随迁移结果（失败不阻断换代；无迁移时为 skipped/unavailable）。 */
  scheduleMigration?: ScheduleMigrationResult
  rotation: RotationView
}

export type RotationErrorCode = 'rotation_disabled' | 'rotation_busy' | 'rotation_failed'

export class RotationError extends Error {
  readonly code: RotationErrorCode
  constructor(code: RotationErrorCode, message: string) {
    super(message)
    this.name = 'RotationError'
    this.code = code
  }
}

export interface RotationLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

type Resolver<T> = T | (() => T | undefined)

export interface RotationServiceDeps {
  ctx: CordisContext
  config: ConfigStore
  sessions: SessionStore
  workspaces: WorkspaceStore
  binding: BindingService
  /** 任务记录只读访问（简报 + 活动判定）。 */
  tasks: () => readonly TaskRecord[]
  getStatus: () => { busy: boolean }
  getPendingDispatch?: () => unknown
  /** M2：看板注入合并窗口内是否还有待发条目。 */
  hasPendingBoardInjection?: () => boolean
  /** 旧会话事件读取（缺省用 readSessionEvents）。 */
  getSessionEvents?: (sessionId: string) => Promise<SessionEventLike[]>
  /** 换代后给新会话预置 dsh-trace-inspect 工具审计（缺省 = 不做；插件缺失时返回 unavailable）。 */
  setToolAudit?: (sessionId: string, enabled: boolean) => Promise<ToolAuditResult>
  /** 换代提交后把旧 commander 名下的 schedule 迁到新会话（缺省 = 真实迁移；测试可注入）。 */
  migrateSchedules?: (input: ScheduleMigrationInput) => Promise<ScheduleMigrationResult>
  emit?: (event: string, payload: Record<string, unknown>) => void
  logger?: RotationLogger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 测试注入；缺省从 ctx 软解析。 */
  sessionController?: Resolver<SessionControllerService>
  agents?: Resolver<AgentsService>
}

export interface RotationRunOptions {
  force?: boolean
  reason: 'manual' | 'turn_end' | 'before_deliver'
}

const EVENT_MESSAGE_TEXT = (event: SessionEventLike): string => {
  const data = (event.data ?? {}) as Record<string, unknown>
  const message = (data.message ?? data) as Record<string, unknown>
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
    .trim()
}

export function createRotationService(deps: RotationServiceDeps) {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let rotating = false
  let lastError: { code: string; message: string; at: number } | undefined
  let lastFailureAt = 0

  const controller = (): SessionControllerService | undefined => {
    if (typeof deps.sessionController === 'function') return (deps.sessionController as () => SessionControllerService | undefined)()
    if (deps.sessionController !== undefined) return deps.sessionController
    try {
      return deps.ctx.get('sessionController') as SessionControllerService | undefined
    } catch {
      return undefined
    }
  }
  const agents = (): AgentsService | undefined => {
    if (typeof deps.agents === 'function') return (deps.agents as () => AgentsService | undefined)()
    if (deps.agents !== undefined) return deps.agents
    try {
      return deps.ctx.get('agents') as AgentsService | undefined
    } catch {
      return undefined
    }
  }
  const emit = (payload: Record<string, unknown>): void => deps.emit?.('rotation.updated', payload)
  const readEvents = deps.getSessionEvents ?? ((sessionId: string) => readSessionEvents(deps.ctx, sessionId))
  const resolved = (): ResolvedRotation => resolveRotation(deps.config.get())

  const view = (): RotationView => {
    const current = resolved()
    const at = now()
    return {
      enabled: current.enabled,
      periodDays: current.periodDays,
      includeUserTail: current.includeUserTail,
      generation: current.generation,
      startedAt: current.generationStartedAt,
      dueAt: rotationDueAt(current),
      due: rotationDue(current, at),
      rotating,
      ...(lastError !== undefined ? { lastError } : {}),
    }
  }

  const formerCommanders = (): FormerCommander[] =>
    deps.sessions
      .list()
      .filter((link) => link.role === 'commander' && link.status === 'retired')
      .sort((a, b) => (b.retiredAt ?? 0) - (a.retiredAt ?? 0))
      .slice(0, FORMER_COMMANDERS_MAX)
      .map((link) => ({
        sessionId: link.sessionId,
        generation: link.generation ?? 1,
        startedAt: typeof link.createdAt === 'number' ? link.createdAt : 0,
        retiredAt: link.retiredAt ?? 0,
      }))

  const workspaceOf = (config: ConfigRecord): { id: string; name: string } => {
    const record = deps.workspaces.get(config.commander.workspaceId)
    const name = record?.name !== undefined && record.name !== ''
      ? record.name
      : basename(config.commander.workspacePath !== '' ? config.commander.workspacePath : '') || ''
    return { id: config.commander.workspaceId, name }
  }

  const collectUserLines = async (sessionId: string, windowStart: number): Promise<BriefUserLine[]> => {
    if (sessionId === '') return []
    let events: SessionEventLike[] = []
    try {
      events = await readEvents(sessionId)
    } catch {
      return []
    }
    const lines: BriefUserLine[] = []
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const data = (event.data ?? {}) as Record<string, unknown>
      const source = data.source as { kind?: unknown } | undefined
      if (typeof source?.kind === 'string' && source.kind !== 'user') continue
      const text = EVENT_MESSAGE_TEXT(event)
      if (text === '') continue
      const at = typeof event.time === 'number' ? event.time : now()
      if (at < windowStart) continue
      lines.push({ text, at })
    }
    return lines.slice(-BRIEF_USER_LINES_MAX * 2)
  }

  const buildBrief = async (config: ConfigRecord, current: ResolvedRotation): Promise<HandoffBrief> => {
    const at = now()
    // 至少覆盖一个周期：首次启用/刚换任后立刻再换，也不会给出空窗简报。
    const windowStart = briefWindowStart(current, at)
    const userLines = current.includeUserTail
      ? await collectUserLines(config.commander.sessionId, windowStart)
      : []
    return buildHandoffBrief({
      now: at,
      windowStart,
      periodDays: current.periodDays,
      generation: current.generation,
      workspace: workspaceOf(config),
      model: config.commander.model,
      tasks: deps.tasks(),
      userLines,
      includeUserTail: current.includeUserTail,
      ...(deps.getPendingDispatch !== undefined && deps.getPendingDispatch() !== undefined && deps.getPendingDispatch() !== null
        ? { pendingDispatch: deps.getPendingDispatch() }
        : {}),
    })
  }

  /** 本周期是否有活动（旧会话消息或任务更新）。没有活动就不换，避免空转建会话。 */
  const hasActivity = async (config: ConfigRecord, current: ResolvedRotation): Promise<boolean> => {
    if (deps.tasks().some((task) => task.updatedAt >= current.generationStartedAt)) return true
    if (config.commander.sessionId === '') return false
    try {
      const events = await readEvents(config.commander.sessionId)
      return events.some((event) =>
        (event.type === 'user/message' || event.type === 'assistant/message') &&
        typeof event.time === 'number' &&
        event.time >= current.generationStartedAt,
      )
    } catch {
      return false
    }
  }

  const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RotationError('rotation_failed', `${label} timed out after ${ms}ms`)), ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })

  const waitForAgent = async (sessionId: string): Promise<AgentLike | undefined> => {
    for (let attempt = 0; attempt < ROTATION_AGENT_RETRY_COUNT; attempt += 1) {
      const agent = agents()?.get?.(sessionId)
      if (agent !== undefined) return agent
      if (attempt < ROTATION_AGENT_RETRY_COUNT - 1) await sleep(ROTATION_AGENT_RETRY_DELAY_MS)
    }
    return undefined
  }

  /** 门控；通过返回 undefined，不通过返回原因。 */
  const gateReason = async (force: boolean): Promise<string | undefined> => {
    if (deps.getStatus().busy) return 'commander is busy'
    const pending = deps.getPendingDispatch?.()
    if (pending !== undefined && pending !== null) return 'a dispatch confirmation is pending'
    if (deps.hasPendingBoardInjection?.() === true) return 'board injection is still pending'
    if (!force && lastFailureAt > 0 && now() - lastFailureAt < ROTATION_FAILURE_BACKOFF_MS) return 'previous rotation failed recently'
    const agent = agents()?.get?.(deps.config.get().commander.sessionId)
    if (agent?.whenIdle !== undefined) {
      try {
        await withTimeout(Promise.resolve(agent.whenIdle()), 2_000, 'whenIdle')
      } catch {
        return 'commander is not idle'
      }
    }
    return undefined
  }

  const run = async (config: ConfigRecord, current: ResolvedRotation): Promise<{ sessionId: string; brief: HandoffBrief }> => {
    const sessionController = controller()
    if (sessionController?.create === undefined) throw new RotationError('rotation_failed', 'sessionController.create is unavailable')
    const brief = await buildBrief(config, current)
    const locator = config.commander.workspaceId !== ''
      ? { workspaceId: config.commander.workspaceId }
      : { cwd: config.commander.workspacePath }
    if (config.commander.workspaceId === '' && config.commander.workspacePath === '') {
      throw new RotationError('rotation_failed', 'commander workspace is not set')
    }
    const created = await withTimeout(
      sessionController.create({ ...locator, ...(config.commander.agentPreset !== undefined ? { agentPreset: config.commander.agentPreset } : {}) }),
      ROTATION_TIMEOUT_MS,
      'session create',
    )
    const newSessionId = typeof created?.sessionId === 'string' && created.sessionId !== '' ? created.sessionId : typeof created?.id === 'string' ? created.id : ''
    if (newSessionId === '') throw new RotationError('rotation_failed', 'sessionController.create returned no sessionId')
    if (newSessionId === config.commander.sessionId) throw new RotationError('rotation_failed', 'create returned the current commander session')
    const model = config.commander.model
    if (sessionController.selectModel !== undefined && model.provider !== '' && model.model !== '') {
      try {
        await sessionController.selectModel({ sessionId: newSessionId, ...model })
      } catch (error) {
        deps.logger?.warn?.(`[commander] rotation model selection failed: ${String((error as Error)?.message ?? error)}`)
      }
    }
    const agent = await waitForAgent(newSessionId)
    if (agent === undefined || typeof agent.inject !== 'function') {
      throw new RotationError('rotation_failed', 'new commander session has no live agent to inject the handoff brief')
    }
    // 工具审计（dsh-trace-inspect）必须在首轮 turn/start 之前预置；插件缺失时静默跳过。
    await applyToolAuditDefault(
      { setToolAudit: deps.setToolAudit, logger: deps.logger },
      { sessionId: newSessionId, enabled: current.toolAudit },
    )
    agent.inject(buildContextMessage(brief.text, {
      kind: 'commander-handoff',
      summary: `第 ${current.generation} 任交接简报（${brief.stats.chars} 字）`,
      generation: current.generation,
    }))
    // 标题是展示层产物：简报落定后再命名；失败只记 warn，不阻断交接（不参与提交条件）。
    await applyRotationTitleDefault(
      { sessionController, logger: deps.logger },
      { sessionId: newSessionId, generation: current.generation + 1, at: now(), timeoutMs: ROTATION_TIMEOUT_MS },
    )
    return { sessionId: newSessionId, brief }
  }

  const rotate = async (options: RotationRunOptions): Promise<RotationResult> => {
    const force = options.force === true
    const config = deps.config.get()
    const current = resolveRotation(config)
    if (!current.enabled) throw new RotationError('rotation_disabled', 'rotation is disabled')
    if (rotating) throw new RotationError('rotation_busy', 'rotation is already in progress')
    if (!force && !rotationDue(current, now())) {
      return { rotated: false, reason: 'not_due', generation: current.generation, sessionId: config.commander.sessionId, rotation: view() }
    }
    // 同步占位：门控里有 await（whenIdle/事件读取），不先占位会让两个并发的
    // check/beforeDeliver 同时通过门控、换两次任。
    rotating = true
    const startedAt = now()
    let scheduleMigration: ScheduleMigrationResult | undefined
    try {
      const blocked = await gateReason(force)
      if (blocked !== undefined) throw new RotationError('rotation_busy', blocked)
      if (!force && !(await hasActivity(config, current))) {
        return { rotated: false, reason: 'no_activity', generation: current.generation, sessionId: config.commander.sessionId, rotation: view() }
      }
      emit({ rotation: view(), formerCommanders: formerCommanders() })
      const { sessionId, brief } = await run(config, current)
      const generation = current.generation + 1
      await deps.binding.commitRotation({
        sessionId,
        workspaceId: config.commander.workspaceId,
        workspacePath: config.commander.workspacePath,
        model: config.commander.model,
        ...(config.commander.agentPreset !== undefined ? { agentPreset: config.commander.agentPreset } : {}),
        generation,
        previousSessionId: config.commander.sessionId,
      })
      // 提交点已过：定时任务跟随是 post-commit 补偿，失败只告警，绝不回滚已完成的换代。
      try {
        const migrate = deps.migrateSchedules ?? migrateCommanderSchedules
        scheduleMigration = await migrate({
          ctx: deps.ctx,
          fromSessionId: config.commander.sessionId,
          toSessionId: sessionId,
          isCommanderSession: (candidate) => deps.sessions.list().some((link) => link.sessionId === candidate && link.role === 'commander'),
          isCurrentCommander: (candidate) => deps.config.get().commander.sessionId === candidate,
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        })
      } catch (error: unknown) {
        scheduleMigration = scheduleMigrationFailure(config.commander.sessionId, sessionId, 'migration_threw')
        deps.logger?.warn?.(`[commander] rotation schedule migration threw: ${String((error as Error)?.message ?? error)}`)
      }
      lastError = undefined
      lastFailureAt = 0
      deps.logger?.info?.(
        `[commander] rotation committed { from: ${config.commander.sessionId || 'none'}, to: ${sessionId}, generation: ${generation}, briefChars: ${brief.stats.chars}, durationMs: ${now() - startedAt}, reason: ${options.reason}, scheduleMigration: ${scheduleMigration?.status ?? 'none'} }`,
      )
      return {
        rotated: true,
        generation,
        sessionId,
        ...(config.commander.sessionId !== '' ? { previousSessionId: config.commander.sessionId } : {}),
        startedAt: now(),
        brief: brief.stats,
        ...(scheduleMigration !== undefined ? { scheduleMigration } : {}),
        rotation: view(),
      }
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      const code = error instanceof RotationError ? error.code : 'rotation_failed'
      lastError = { code, message: message.slice(0, 200), at: now() }
      lastFailureAt = now()
      deps.logger?.warn?.(`[commander] rotation failed { step: ${options.reason}, code: ${code}, message: ${message} }`)
      throw error instanceof RotationError ? error : new RotationError('rotation_failed', message.slice(0, 200))
    } finally {
      rotating = false
      emit({
        rotation: view(),
        formerCommanders: formerCommanders(),
        ...(scheduleMigration !== undefined ? { scheduleMigration } : {}),
      })
    }
  }

  /** 一级触发：指挥官会话 `turn/end`（异步、不阻塞事件循环）。 */
  const attach = (): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const dispose = deps.ctx.on('session/event', (...args: unknown[]) => {
      if (disposed) return
      const [sessionArg, eventArg] = args as [{ id?: unknown } | undefined, { type?: unknown } | undefined]
      if (eventArg?.type !== 'turn/end') return
      const sessionId = typeof sessionArg?.id === 'string' ? sessionArg.id : undefined
      if (sessionId === undefined || sessionId === '' || sessionId !== deps.config.get().commander.sessionId) return
      if (timer !== undefined) clearTimeout(timer)
      // 让 commander.status.busy 先落为 false（订阅顺序无关）。
      timer = setTimeout(() => {
        timer = undefined
        void check().catch((error: unknown) => {
          deps.logger?.warn?.(`[commander] rotation check failed: ${String((error as Error)?.message ?? error)}`)
        })
      }, 0)
    })
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      dispose()
    }
  }

  /** 自动检查（turn/end / 定时边界调用）：只做 silent 失败，不抛给调用方。 */
  const check = async (): Promise<RotationResult | undefined> => {
    const config = deps.config.get()
    const current = resolveRotation(config)
    if (!current.enabled || !rotationDue(current, now())) return undefined
    if (rotating) return undefined
    if (lastFailureAt > 0 && now() - lastFailureAt < ROTATION_FAILURE_BACKOFF_MS) return undefined
    const blocked = await gateReason(false)
    if (blocked !== undefined) return undefined
    if (!(await hasActivity(config, current))) return undefined
    try {
      return await rotate({ force: false, reason: 'turn_end' })
    } catch {
      return undefined
    }
  }

  /** 二级兜底：面板消息投递前（失败静默，绝不阻塞投递）。 */
  const beforeDeliver = async (): Promise<void> => {
    const config = deps.config.get()
    const current = resolveRotation(config)
    if (!current.enabled || !rotationDue(current, now())) return
    if (rotating) return
    if (lastFailureAt > 0 && now() - lastFailureAt < ROTATION_FAILURE_BACKOFF_MS) return
    const blocked = await gateReason(false)
    if (blocked !== undefined) return
    if (!(await hasActivity(config, current))) return
    try {
      await rotate({ force: false, reason: 'before_deliver' })
    } catch {
      /* 轮换失败不影响用户消息投递 */
    }
  }

  return { view, formerCommanders, rotate, check, beforeDeliver, attach }
}

export type RotationService = ReturnType<typeof createRotationService>
