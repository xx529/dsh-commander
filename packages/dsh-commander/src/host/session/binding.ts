// 指挥官会话绑定：unbound/bound/broken(recovered)/rebound 状态；启动不 resume；失败不自动新建。
// 口径：implementation-plan §5.1–§5.4 + m0-contract-patch §2.4。
import { createId } from '../store/base.ts'
import { defaultConfigRecord, type ConfigRecord, type ModelRef, type SessionLinkRecord } from '../schema.ts'
import { clampPeriodDays, resolveRotation } from '../rotation/config.ts'
import { applyRotationTitleDefault, applyToolAuditDefault, type GenerationDefaultsLogger } from '../rotation/generation-defaults.ts'
import type { ToolAuditResult } from '../rotation/tool-audit.ts'
import type { CordisContext, SessionControllerService, SessionsQueryService, WorkspaceRegistryService } from '../dsh-types.ts'
import { cwdBelongsToWorkspace, listNormalizedSessions, matchSessionWorkspaces, normalizeSessionRecord } from './session-records.ts'
import type { ConfigStore } from '../store/config.ts'
import type { SessionStore } from '../store/sessions.ts'
import type { WorkspaceStore } from '../store/workspaces.ts'

const asPromise = async (value: unknown): Promise<unknown> => (value instanceof Promise ? await value : value)

/** 手动「绑定到新会话」时标题 rename 的超时；比换任的 10s 短，避免设置页长时间等待。 */
const MANUAL_BIND_TITLE_TIMEOUT_MS = 3_000

export type CommanderStatus = 'unbound' | 'bound' | 'broken'

export interface CommanderBinding {
  workspaceId: string
  workspacePath: string
  sessionId: string
  model: ModelRef
  agentPreset?: string
}

export interface BindingView {
  status: CommanderStatus
  binding: CommanderBinding
  brokenReason?: string
}

export interface BindNewInput {
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}

export interface BindSelectInput {
  workspaceId?: string
  sessionId: string
}

export class BindingError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BindingError'
    this.code = code
  }
}

const bindingFromConfig = (config: ConfigRecord): CommanderBinding => ({
  workspaceId: config.commander.workspaceId,
  workspacePath: config.commander.workspacePath,
  sessionId: config.commander.sessionId,
  model: config.commander.model,
  ...(config.commander.agentPreset !== undefined ? { agentPreset: config.commander.agentPreset } : {}),
})

export interface CommitRotationInput {
  sessionId: string
  workspaceId: string
  workspacePath: string
  model: ModelRef
  agentPreset?: string
  /** 新任一序号；必须等于旧任 + 1（调用方负责）。 */
  generation: number
  /** 被交接的旧会话；非空时在 sessions 表标 retired（不是 missing）。 */
  previousSessionId: string
}

export interface BindingServiceDeps {
  ctx: CordisContext
  config: ConfigStore
  sessions: SessionStore
  workspaces: WorkspaceStore
  now?: () => number
  /** 绑定写入完成后触发（M1：用于给指挥官 agent 安装模型工具；此时 config.commander.sessionId 已可见）。 */
  onBound?: (binding: CommanderBinding, mode: 'new' | 'attach') => void
  /** 新会话预置 dsh-trace-inspect 工具审计（与 rotation 共用同一个本机路由闭包）。 */
  setToolAudit?: (sessionId: string, enabled: boolean) => Promise<ToolAuditResult>
  logger?: GenerationDefaultsLogger
}

export function createBindingService(deps: BindingServiceDeps) {
  const now = deps.now ?? (() => Date.now())
  let brokenReason: string | undefined

  const getStatus = (config = deps.config.get()): CommanderStatus => {
    if (config.commander.sessionId === '') return 'unbound'
    if (brokenReason !== undefined) return 'broken'
    const link = deps.sessions.get(config.commander.workspaceId, config.commander.sessionId)
    if (link?.status === 'missing') return 'broken'
    return 'bound'
  }

  const view = (): BindingView => {
    const config = deps.config.get()
    const status = getStatus(config)
    return {
      status,
      binding: bindingFromConfig(config),
      ...(status === 'broken' ? { brokenReason: brokenReason ?? 'session missing' } : {}),
    }
  }

  const resolveWorkspace = async (workspaceId?: string, cwd?: string): Promise<{ id: string; name: string; path: string }> => {
    const registry = deps.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
    if (workspaceId !== undefined && workspaceId !== '') {
      const fromStore = deps.workspaces.get(workspaceId)
      let registered: { id: string; name?: string; title?: string; path: string } | undefined
      if (registry?.get !== undefined) registered = await registry.get(workspaceId)
      if (registered === undefined && registry?.list !== undefined) {
        const list = await registry.list()
        registered = list.find((item) => item.id === workspaceId)
      }
      if (registered === undefined && fromStore === undefined) {
        // 隔离/单测环境没有 registry：允许按 workspaceId 绑定（记录 name=id、path=''），真实 Host 有 registry 时严格校验。
        if (registry === undefined) return { id: workspaceId, name: workspaceId, path: '' }
        throw new BindingError('not_found', `workspace '${workspaceId}' not found`)
      }
      const path = registered?.path ?? fromStore?.path ?? ''
      const name = registered?.name ?? registered?.title ?? fromStore?.name ?? workspaceId
      return { id: workspaceId, name, path }
    }
    if (cwd !== undefined && cwd !== '') {
      if (!cwd.startsWith('/')) throw new BindingError('invalid_request', 'cwd must be an absolute path')
      let matched: { id: string; name?: string; title?: string; path: string } | undefined
      if (registry?.list !== undefined) {
        const list = await registry.list()
        matched = list.find((item) => item.path === cwd)
      }
      if (matched === undefined) {
        // 合同 m0-contract-patch §2.4：mode=new 允许只给 cwd（sessionController.create({cwd}) 自带建工作区语义）；
        // 工作区尚未注册时不拒绝，先绑定 cwd，create 后再尽力从 registry/session 反查 workspaceId（可能为空）。
        return { id: '', name: cwd.split('/').filter(Boolean).pop() ?? cwd, path: cwd }
      }
      return { id: matched.id, name: matched.name ?? matched.title ?? matched.id, path: matched.path }
    }
    throw new BindingError('invalid_request', 'workspaceId or cwd is required')
  }

  const previousLink = (config: ConfigRecord): SessionLinkRecord | undefined =>
    config.commander.sessionId === '' ? undefined : deps.sessions.get(config.commander.workspaceId, config.commander.sessionId)

  /** R1：下一任序号 = 既有 commander link 的最大 generation 与当前配置序号取大者 + 1（首次绑定 = 1）。 */
  const nextGeneration = (config: ConfigRecord): number => {
    let max = 0
    for (const link of deps.sessions.list()) {
      if (link.role !== 'commander') continue
      max = Math.max(max, typeof link.generation === 'number' ? link.generation : 1)
    }
    const current = config.commander.sessionId !== '' ? (config.commander.rotation?.generation ?? 1) : 0
    return Math.max(max, current) + 1
  }

  /** R1：绑定写入时保留轮换开关/周期，只推进代际与起始时间。 */
  const rotationForBinding = (current: ConfigRecord, generation: number, at: number) => ({
    enabled: current.commander.rotation?.enabled === true,
    periodDays: clampPeriodDays(current.commander.rotation?.periodDays),
    includeUserTail: current.commander.rotation?.includeUserTail !== false,
    toolAudit: current.commander.rotation?.toolAudit !== false,
    generation,
    generationStartedAt: at,
  })

  const writeBinding = async (next: CommanderBinding, mode: 'new' | 'attach', timestamp: number, generation: number): Promise<CommanderBinding> => {
    const config = await deps.config.update((current) => ({
      ...current,
      commander: {
        workspaceId: next.workspaceId,
        workspacePath: next.workspacePath,
        sessionId: next.sessionId,
        model: next.model,
        ...(next.agentPreset !== undefined ? { agentPreset: next.agentPreset } : {}),
        rotation: rotationForBinding(current, generation, timestamp),
      },
    }), timestamp)
    const old = previousLink(config)
    if (old !== undefined && old.sessionId !== next.sessionId) await deps.sessions.markMissing(old.workspaceId, old.sessionId)
    await deps.sessions.upsert({
      v: 1,
      sessionId: next.sessionId,
      workspaceId: next.workspaceId,
      taskId: '',
      role: 'commander',
      mode,
      createdAt: timestamp,
      generation,
      status: 'idle',
    })
    deps.workspaces.get(next.workspaceId) // 保持白名单记录不被误删（读取只为副作用无关；真实写入在 M1）
    brokenReason = undefined
    const bound = bindingFromConfig(deps.config.get())
    try {
      deps.onBound?.(bound, mode)
    } catch {
      /* 绑定回调失败不影响绑定结果 */
    }
    return bound
  }

  const sessionController = (): SessionControllerService | undefined =>
    deps.ctx.get('sessionController') as SessionControllerService | undefined

  return {
    view,
    getStatus,
    /** 绑定到新会话：sessionController.create → 可选 selectModel → 写 config + sessions link。 */
    async bindNew(input: BindNewInput): Promise<BindingView> {
      if (input.workspaceId !== undefined && input.cwd !== undefined) throw new BindingError('invalid_request', 'workspaceId and cwd are mutually exclusive')
      const workspace = await resolveWorkspace(input.workspaceId, input.cwd)
      const controller = sessionController()
      if (controller?.create === undefined) throw new BindingError('create_failed', 'sessionController.create is unavailable')
      // DSH session.create 合同：workspaceId 与 cwd **二选一**（同时传 →
      // `session.create accepts workspaceId or cwd, not both`，V3 证据 §2 异常表 + tester M0-3 e2e）。
      // 有注册工作区（workspaceId 非空）时只传 workspaceId，让 Host 按注册表解析 path；
      // 没有注册工作区（cwd-only / 隔离 home 首次启动）时只传 cwd。
      const locator = workspace.id !== '' ? { workspaceId: workspace.id } : { cwd: workspace.path }
      const created = await controller.create({
        ...locator,
        ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
      })
      const sessionId = created?.sessionId ?? created?.id
      if (typeof sessionId !== 'string' || sessionId === '') throw new BindingError('create_failed', 'sessionController.create returned no sessionId')
      const model = deps.config.get().commander.model
      if (controller.selectModel !== undefined && model.provider !== '' && model.model !== '') {
        await controller.selectModel({ sessionId, ...model })
      }
      // cwd 绑定后反查工作区（DSH 可能已自动登记 workspace；查不到则 workspaceId 存空串，仍可投递消息）
      let workspaceId = workspace.id
      let workspacePath = workspace.path
      if (workspaceId === '') {
        try {
          const sessionsQuery = deps.ctx.get('sessions') as SessionsQueryService | undefined
          const createdSession = sessionsQuery?.get !== undefined ? await sessionsQuery.get(sessionId) : undefined
          if (typeof createdSession?.workspaceId === 'string' && createdSession.workspaceId !== '') workspaceId = createdSession.workspaceId
          if (typeof createdSession?.cwd === 'string' && createdSession.cwd !== '') workspacePath = createdSession.cwd
          if (workspaceId === '') {
            const wsRegistry = deps.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
            if (wsRegistry?.list !== undefined) {
              const list = await wsRegistry.list()
              const matched = list.find((item) => item.path === workspacePath)
              if (matched !== undefined) workspaceId = matched.id
            }
          }
        } catch {
          // 反查失败不阻塞绑定（workspaceId 空串合法：绑定存在但工作区未登记）
        }
      }
      const current = deps.config.get()
      const generation = nextGeneration(current)
      const rotation = resolveRotation(current)
      const timestamp = now()
      // B2：轮换开启时，「绑定到新会话」与「立即换任」共用同一套新一任默认副作用。
      // 先应用默认副作用再 writeBinding，避免绑定切换后并发消息抢在审计前触发首轮 turn/start。
      if (rotation.enabled) {
        await Promise.allSettled([
          applyToolAuditDefault(
            { setToolAudit: deps.setToolAudit, logger: deps.logger },
            { sessionId, enabled: rotation.toolAudit },
          ),
          applyRotationTitleDefault(
            { sessionController: controller, logger: deps.logger },
            { sessionId, generation, at: timestamp, timeoutMs: MANUAL_BIND_TITLE_TIMEOUT_MS },
          ),
        ])
      }
      const binding = await writeBinding({ workspaceId, workspacePath, sessionId, model }, 'new', timestamp, generation)
      return { status: 'bound', binding }
    },
    /** 绑定到已有会话：只读校验（软依赖），不 create、不 selectModel、不删旧会话。 */
    async bindSelect(input: BindSelectInput): Promise<BindingView> {
      if (input.sessionId === '') throw new BindingError('invalid_request', 'sessionId is required')
      // 真实 Host：sessions.get 只对 live/已加载会话可读；冷会话必须用 sessionQuery.listSessions
      // （SessionRecord.header 含 id/cwd/createdAt/agentPreset/子会话分类）。M1R live 修复。
      const listed = await listNormalizedSessions(deps.ctx)
      let target = listed.sessions.find((session) => session.id === input.sessionId)
      if (target === undefined && !listed.fromQuery) {
        // 旧宿主/单测没有 sessionQuery：回退 sessions 服务的只读 list/get（仅 live 会话可读）。
        try {
          const sessionsService = deps.ctx.get('sessions') as SessionsQueryService | undefined
          const fallback = (await asPromise(sessionsService?.list?.())) as unknown[] | undefined
          const rows = Array.isArray(fallback) ? fallback : sessionsService?.get !== undefined ? [await sessionsService.get(input.sessionId)] : []
          for (const row of rows) {
            const normalized = normalizeSessionRecord(row)
            if (normalized !== undefined && normalized.id === input.sessionId) {
              target = normalized
              break
            }
          }
        } catch {
          /* 回退失败按 not_found 处理 */
        }
      }
      if (target === undefined) {
        throw new BindingError('not_found', `session '${input.sessionId}' not found（可用会话 ${listed.sessions.length} 个）`)
      }
      const registry = deps.ctx.get('workspaceRegistry') as WorkspaceRegistryService | undefined
      const registryList = registry?.list !== undefined ? await registry.list() : []
      const candidates = (registryList.length > 0
        ? registryList.map((item) => {
            const record = item as { id: string; name?: string; title?: string; path: string; sessionIds?: unknown }
            return {
              id: record.id,
              name: record.name ?? record.title ?? record.id,
              path: record.path,
              sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((id): id is string => typeof id === 'string') : [],
            }
          })
        : deps.workspaces.list().map((record) => ({ id: record.id, name: record.name || record.id, path: record.path, sessionIds: [] as string[] })))
      let chosen: { id: string; name: string; path: string } | undefined
      if (input.workspaceId !== undefined && input.workspaceId !== '') {
        const workspace = candidates.find((item) => item.id === input.workspaceId)
        const belongs = workspace !== undefined &&
          ((workspace.sessionIds ?? []).includes(target.id) || cwdBelongsToWorkspace(target.cwd, workspace.path))
        if (!belongs) {
          throw new BindingError(
            'workspace_conflict',
            `session '${input.sessionId}' 不属于 workspace '${input.workspaceId}'` +
              (workspace === undefined ? '（workworkspace 未注册）' : `（会话 cwd=${target.cwd ?? '无'}）`),
          )
        }
        chosen = { id: workspace.id, name: workspace.name, path: workspace.path }
      } else {
        const matches = matchSessionWorkspaces(target, candidates)
        if (matches.length === 0) {
          throw new BindingError('invalid_request', `无法从会话 cwd=${target.cwd ?? '无'} 推断工作区，请指定 workspaceId`)
        }
        if (matches.length > 1) {
          throw new BindingError('workspace_conflict', `会话 '${input.sessionId}' 匹配多个工作区：${matches.map((item) => item.id).join(', ')}，请指定 workspaceId`)
        }
        const matched = candidates.find((item) => item.id === (matches[0] as { id: string }).id) as { id: string; name: string; path: string } | undefined
        if (matched !== undefined) chosen = { id: matched.id, name: matched.name, path: matched.path }
      }
      const workspace = chosen ?? await resolveWorkspace(input.workspaceId, target.cwd)
      const model = deps.config.get().commander.model
      // 绑回旧任（含 retired）时沿用其序号；否则按下一任编号。
      const targetLink = deps.sessions.list().find((link) => link.sessionId === input.sessionId && link.role === 'commander')
      const generation = targetLink?.generation ?? nextGeneration(deps.config.get())
      const binding = await writeBinding({ workspaceId: workspace.id, workspacePath: workspace.path, sessionId: input.sessionId, model }, 'attach', now(), generation)
      return { status: 'bound', binding }
    },
    /**
     * R1：轮换提交点。原子写 config（新会话 + 代际 + 起始时间），旧 link 标 `retired`、
     * 新 link 写 `idle`；**不调用 markMissing**（退役 ≠ 丢失）。
     */
    async commitRotation(input: CommitRotationInput): Promise<CommanderBinding> {
      const timestamp = now()
      const config = await deps.config.update((current) => ({
        ...current,
        commander: {
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath,
          sessionId: input.sessionId,
          model: input.model,
          ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
          rotation: rotationForBinding(current, input.generation, timestamp),
        },
      }), timestamp)
      if (input.previousSessionId !== '') {
        const previous = deps.sessions.list().find((link) => link.sessionId === input.previousSessionId && link.role === 'commander')
        if (previous !== undefined) {
          await deps.sessions.patch(previous.workspaceId, previous.sessionId, (record) => ({
            ...record,
            status: 'retired',
            retiredAt: timestamp,
          }))
        }
      }
      await deps.sessions.upsert({
        v: 1,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        taskId: '',
        role: 'commander',
        mode: 'new',
        createdAt: timestamp,
        generation: input.generation,
        status: 'idle',
      })
      brokenReason = undefined
      return bindingFromConfig(config)
    },
    /** 懒 resume/投递失败：标 broken，不自动新建会话（避免静默丢记忆）。 */
    markBroken(reason: string): void {
      brokenReason = reason
      const config = deps.config.get()
      if (config.commander.sessionId !== '') void deps.sessions.markMissing(config.commander.workspaceId, config.commander.sessionId)
    },
    getConfig: (): ConfigRecord => deps.config.get(),
    defaultConfig: (): ConfigRecord => defaultConfigRecord(now()),
    newRequestId: (): string => createId('req', now()),
  }
}

export type BindingService = ReturnType<typeof createBindingService>
