/**
 * dsh-commander Host 组合根（M0）。
 *
 * 职责边界（implementation-plan.md §3）：只装配 domain/store/binding/api/sse/订阅，不含业务逻辑；
 * 启动期**不建会话、不 resume、不 prompt**（绑定与首条消息由用户动作触发）；
 * capabilityPanel 是软依赖（ctx.get，缺失不阻塞启动）。
 *
 * 装配顺序（implementation-plan §3.1 固定）：
 *   storageDomain.open → store → config 默认 → binding → api/SSE → session/event 订阅
 */
import { resolveCommanderDomainSpec } from './domain.ts'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStores } from './store/index.ts'
import { createBindingService } from './session/binding.ts'
import { createDeliverer } from './session/deliver.ts'
import { createBoardService } from './board/service.ts'
import { createTurnReplyInjector } from './trigger/injection.ts'
import { createTaskActions } from './tasks/actions.ts'
import { createDependencyNotifier } from './tasks/notifications.ts'
import { createMessageRing } from './session/messages.ts'
import { backfillCommanderMessages, subscribeCommanderEvents, type CommanderStatusState } from './session/commander-events.ts'
import { readSessionEvents } from './session/session-records.ts'
import { createSseHub } from './api/sse.ts'
import { buildTaskView, countTaskStatuses } from './api/state.ts'
import { resolvePanel } from './api/panel.ts'
import { createCommanderApi, registerCommanderApi } from './api/server.ts'
import { createMaterialAssets } from './api/material-assets.ts'
import { createDispatchService } from './dispatch/service.ts'
import { agentSessionIdOf, createCommanderTools } from './tools/index.ts'
import { createWorkStatusTracker } from './trigger/status.ts'
import { createRotationService } from './rotation/service.ts'
import { setSessionToolAudit } from './rotation/tool-audit.ts'
import { registerCommanderPromptSection } from './session/prompt.ts'
import { createShellSupervisor, resolveShellBinary } from './native/supervisor.ts'
import { createApprovalBridge, type ApprovalBridge } from './native/approval-bridge.ts'
import { createQuestionBridge, type QuestionBridge } from './native/question-bridge.ts'
import { createWindowPage } from './native/window-page.ts'
import type { CordisContext, StorageDomainService, WebServerService } from './dsh-types.ts'
import type { TaskRecord } from './schema.ts'

export const name = 'commander'

/** M0 真正必需的服务：storageDomain（域 open）+ webServer（/commander/* 路由）。
 *  sessionController / sessions / workspaceRegistry / capabilityPanel 全部惰性软解析（缺失时对应功能降级，不阻塞启动）。 */
export const inject = ['storageDomain', 'webServer']

export const VERSION = '0.1.0'

export type CommanderPluginConfig = Record<string, never>

const loggerOf = (ctx: CordisContext) => ctx.logger ?? {}

/**
 * 插件入口。失败即抛清晰错误（不静默降级到内存）：
 * - 缺 storageDomain → 明确提示 profile 未配置 storageDomain 路由；
 * - domain open 失败 → 原样抛出（含 domain 名）。
 */
export async function apply(ctx: CordisContext, _config: CommanderPluginConfig = {}): Promise<void> {
  const logger = loggerOf(ctx)
  const storageDomain = ctx.get('storageDomain') as StorageDomainService | undefined
  if (storageDomain === undefined || typeof storageDomain.open !== 'function') {
    throw new Error('[commander] storageDomain service is unavailable: profile must route storageDomain (e.g. json backend). Refusing to fall back to in-memory storage.')
  }
  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (webServer === undefined || typeof webServer.register !== 'function') {
    throw new Error('[commander] webServer service is unavailable: /commander/* routes cannot be registered.')
  }
  // 本机 origin：原生壳窗口 token 与跨插件本机路由（dsh-trace-inspect 工具审计）共用。
  const webOrigin = (process.env.DSH_WEB_URL
    ?? (webServer.getOrigin?.() ?? `http://127.0.0.1:${String(webServer.port ?? 3080)}`)).replace(/\/+$/, '')

  // 1) domain open（含声明层校验；本地/宿主 defineDomain 两种路径都不改变 spec 语义）
  const { spec, via } = await resolveCommanderDomainSpec()
  const domain = await storageDomain.open(spec)
  ctx.effect(() => () => {
    void domain.close()
  })

  // 2) store + config 默认（不建会话）
  const stores = createStores(domain)
  const { initialized } = await stores.config.ensureInitialized()

  // 3) M1：dispatch 服务（全确认/内存决策）——先于 binding 创建，供 tools/onBound 使用
  /** 任务变化统一推送：整行 `task.updated` + 当前 `tasks.changed` 计数（面板头部 chip 不跟盘会过期）。 */
  const broadcastTaskChange = (task: TaskRecord): void => {
    sse.broadcast('task.updated', {
      task: buildTaskView(task, { lookup: (id) => stores.tasks.get(id), tasks: stores.tasks.list(), ...(dispatchService.currentPending()?.taskId !== undefined ? { pendingDispatchTaskId: dispatchService.currentPending()?.taskId as string } : {}) }),
      rev: sse.rev,
    })
    sse.broadcast('tasks.changed', { counts: countTaskStatuses(stores.tasks.list()), rev: sse.rev })
  }
  const workStatusTracker = createWorkStatusTracker({
    ctx,
    stores,
    now: () => Date.now(),
    onTaskChanged: (task) => broadcastTaskChange(task),
  })
  /** 只推 {taskId,status} 时看板/详情页要等重启才更新（用户 2026-11-18 反馈）：统一推整行。 */
  const broadcastTaskRow = (taskId: string): void => {
    const task = stores.tasks.get(taskId)
    if (task !== undefined) broadcastTaskChange(task)
  }
  const dispatchService = createDispatchService({
    ctx,
    stores,
    onPendingDispatch: (pending) => sse.broadcast('dispatch.updated', { pendingDispatch: pending, rev: sse.rev, at: Date.now() }),
    onTaskUpdated: (taskId) => broadcastTaskRow(taskId),
    // H4：spawn 写 task/link 后补偿先到的 turn/start（queued→running）
    reconcileSessionStatus: async (taskId, sessionId) => {
      await workStatusTracker.reconcile(taskId, sessionId)
    },
  })
  // 4) binding（启动不 resume；未绑定 → unbound）
  // 工具审计闭包由 binding（手动绑定到新会话）与 rotation（换代）共用，保证两条路径同一传输口径。
  const setToolAuditFor = (sessionId: string, enabled: boolean) =>
    setSessionToolAudit({ origin: webOrigin, sessionId, enabled })
  const binding = createBindingService({
    ctx,
    config: stores.config,
    sessions: stores.sessions,
    workspaces: stores.workspaces,
    setToolAudit: setToolAuditFor,
    logger,
  })

  // 4) 消息环 / busy 状态 / SSE hub（重启后从已 live 的指挥官会话事件 best-effort 回填 ≤200 条）
  const messages = createMessageRing()
  try {
    const bound = stores.config.get().commander
    if (bound.sessionId !== '') {
      backfillCommanderMessages({ events: (await readSessionEvents(ctx, bound.sessionId)) as never, messages })
    }
  } catch {
    // best-effort：回填失败不阻塞启动（M0 契约允许）
  }
  const status: CommanderStatusState = { busy: false, lastTurnId: null, activity: null }
  const sse = createSseHub()

  // 5) 投递器（懒 resume 由 sessionController.prompt 完成；失败 markBroken）
  const deliverer = createDeliverer({ ctx, binding, isBusy: () => status.busy, logger })
  // 5a) 依赖提醒服务（只提醒 commander，不自动派发）：accept/restore/改依赖后入队，dispatch 结算后 pump 下一条。
  const dependencyNotifier = createDependencyNotifier({
    stores,
    deliverer,
    logger,
    hasPendingDispatch: () => dispatchService.currentPending() !== null,
  })
  ctx.effect(() => () => dependencyNotifier.dispose())
  // 启动补提醒：ready 且 dependencyNotifiedAt 缺省的任务投一次（失败留待下次 accept/启动）。
  void dependencyNotifier.backfill()
  // 5a2) 模型工具：指挥官会话内可见（需在 deliverer/notifier 之后创建，以便 cancel/依赖提醒）。
  /** 工作区摘要写入后整帧快照广播（api 在步骤 9 创建，先留晚绑定位）。 */
  let broadcastWorkspaceSnapshot: (() => Promise<void>) | undefined
  const commanderTools = createCommanderTools({
    ctx,
    stores,
    dispatchService,
    commanderSessionId: () => stores.config.get().commander.sessionId,
    now: () => Date.now(),
    onDiagnostic: (message) => logger.warn?.(message),
    onTaskChanged: (task) => broadcastTaskChange(task),
    hasPendingDispatch: (taskId) => dispatchService.currentPending()?.taskId === taskId,
    dependencyNotifier,
    onTaskSettled: (taskId) => dispatchService.invalidateTask(taskId),
    onWorkspaceChanged: async () => { await broadcastWorkspaceSnapshot?.() },
  })
  await commanderTools.prepare()
  ctx.effect(() => () => commanderTools.dispose())
  // 全局注册 + when 限定指挥官会话：工具归属=本插件（插件面板可按包识别），
  // 其它 agent 的 system prompt 看不到，也不再需要按 agent 安装/restrict 的重试时序。
  if (!commanderTools.install()) {
    logger.warn?.('[commander] commander tools were not registered (tools service unavailable?)')
  }

  // 5b) M2 看板服务：PATCH/boardEdits + 30s 合并注入 + archive/restore。
  // 合并窗口可用 COMMANDER_BOARD_MERGE_MS 覆盖（仅用于隔离测试缩短等待；生产默认 30s）。
  const boardMergeOverride = Number(process.env.COMMANDER_BOARD_MERGE_MS)
  const boardService = createBoardService({
    ctx,
    stores,
    deliverer,
    ...(Number.isFinite(boardMergeOverride) && boardMergeOverride > 0 ? { mergeWindowMs: boardMergeOverride } : {}),
    notifyChanged: (taskId) => broadcastTaskRow(taskId),
    dependencyNotifier,
    logger,
  })
  ctx.effect(() => () => boardService.dispose())
  // 启动补注入一次（board_edits 中 injectedAt 为空的历史改动；失败不风暴，等下次编辑/下次启动）
  void boardService.backfill()

  // 5b-R1) 会话轮换（默认关；turn/end 一级触发 + 投递前兜底）
  const rotation = createRotationService({
    ctx,
    config: stores.config,
    sessions: stores.sessions,
    workspaces: stores.workspaces,
    binding,
    tasks: () => stores.tasks.list(),
    getStatus: () => status,
    getPendingDispatch: () => dispatchService.currentPending(),
    hasPendingBoardInjection: () => boardService.pendingMerges() > 0,
    setToolAudit: setToolAuditFor,
    emit: (event, payload) => sse.broadcast(event, { ...payload, rev: sse.rev }),
    logger,
  })
  ctx.effect(() => rotation.attach())

  // 5c) M3 turn/end 最后回复注入 + 人专用 accept/rework 动作。
  const injector = createTurnReplyInjector({
    stores,
    deliver: async (text, requestId, context) => {
      const result = await deliverer.deliverContextMessage(text, requestId, {
        kind: 'commander-session-reply',
        senderSessionId: context.sessionId,
      })
      return { accepted: result.accepted, queued: result.queued }
    },
    getSessionEvents: async (sessionId) => readSessionEvents(ctx, sessionId),
    getProjection: (session) => {
      try {
        const projections = ctx.get('sessionProjections') as { snapshot?: (session: unknown) => unknown } | undefined
        return projections?.snapshot?.(session)
      } catch {
        return undefined
      }
    },
    commanderSessionId: () => stores.config.get().commander.sessionId,
    isBusy: () => status.busy,
    logger,
  })
  ctx.effect(() => {
    const disposable = ctx.on('session/event', (...args: unknown[]) => {
      const [sessionArg, eventArg] = args as [unknown, { type?: unknown } | undefined]
      if (eventArg?.type !== 'turn/end') return
      void injector.handle(sessionArg, eventArg as never).catch((error: unknown) => logger.warn?.(`[commander] injection error: ${String((error as Error)?.message ?? error)}`))
    })
    return () => {
      injector.dispose()
      disposable?.()
    }
  })
  const invalidatePendingForTask = (taskId: string): void => {
    dispatchService.invalidateTask(taskId)
  }
  const taskActions = createTaskActions({
    ctx,
    stores,
    logger,
    onTaskChanged: (task) => broadcastTaskChange(task),
    deliverer,
    hasPendingDispatch: (taskId) => dispatchService.currentPending()?.taskId === taskId,
    onTaskSettled: invalidatePendingForTask,
    dependencyNotifier,
  })

  // 6) 会话事件订阅（assistant 文本 → 消息环 + SSE；turn/start|end → busy + commander.status）
  ctx.effect(() =>
    subscribeCommanderEvents({
      ctx,
      binding,
      messages,
      getStatus: () => status,
      emitMessage: (message) => sse.broadcast('commander.message', message),
      emitStatus: (next) => sse.broadcast('commander.status', { ...next, rev: sse.rev }),
    }),
  )

  // 7) M1：trigger 机械状态 + system prompt（tools 已在 apply 时全局注册）
  ctx.effect(() => workStatusTracker.subscribe())
  ctx.effect(() => () => workStatusTracker.dispose())
  // 启动回填：重启/竞态会丢 turn/start，queued 任务按会话最后回合事件补 running（否则工作会话在跑、看板一直排队）。
  void workStatusTracker.backfill().catch((error) => logger.warn?.('[commander] queued status backfill failed', error))
  const registerPrompt = (scoped: CordisContext): void => {
    try {
      registerCommanderPromptSection({
        ctx: scoped as never,
        isCommanderSession: (sessionId) => sessionId !== undefined && sessionId !== '' && sessionId === stores.config.get().commander.sessionId,
      })
    } catch {
      /* systemPrompt 缺失时降级（工具仍可用） */
    }
  }
  if (typeof ctx.inject === 'function') {
    // systemPrompt 可能在 apply 时尚未就绪：用 cordis inject 等它出现（避免 "without inject" 报错）
    ctx.inject(['systemPrompt'], (scoped) => registerPrompt(scoped))
  } else {
    registerPrompt(ctx)
  }

  // 8) M4 原生壳：窗口页 token + 进程 supervisor（非 darwin/产物缺失/显式关闭时自动降级为页内浮窗）
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
  const materialAssets = createMaterialAssets({ stores, origin: () => webOrigin })
  const nativeLocale: 'zh' | 'en' = (process.env.DSH_LOCALE ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh'
  const windowPage = createWindowPage({ locale: nativeLocale })
  const nativeConfig = stores.config.get()
  const nativeStateDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'commander', 'native')
  // 测试进程（node --test）默认不起 GUI；隔离 e2e 用 DSH_COMMANDER_NATIVE_SHELL=1/0 显式控制。
  const nativeShellDisabled = process.env.DSH_COMMANDER_NATIVE_SHELL === '0'
    || nativeConfig.ui.nativeShell === false
    || process.env.NODE_TEST_CONTEXT !== undefined
  let approvalBridge: ApprovalBridge | undefined
  let questionBridge: QuestionBridge | undefined
  const shellSupervisor = createShellSupervisor({
    binaryPath: nativeShellDisabled ? null : resolveShellBinary(packageRoot),
    origin: webOrigin,
    windowToken: windowPage.token,
    stateDir: nativeStateDir,
    theme: nativeConfig.ui.theme,
    locale: nativeLocale,
    entryPos: nativeConfig.ui.entryPos ?? null,
    hotkey: nativeConfig.ui.hotkey === '' ? 'Alt+Space' : nativeConfig.ui.hotkey,
    parentPid: process.pid,
    log: (level, message) => {
      if (level === 'error') logger.error?.(message)
      else if (level === 'warn') logger.warn?.(message)
      else logger.info?.(message)
    },
    onStatusChange: (status) => {
      sse.broadcast('native-shell.status', { ...status, rev: sse.rev, at: Date.now() })
      approvalBridge?.onShellStatus(status)
      questionBridge?.onShellStatus(status)
    },
  })
  approvalBridge = createApprovalBridge({
    onRequest: (listener) => ctx.on('approval/request', listener as never, { prepend: true }) as unknown as () => void,
    emit: (event, payload) => sse.broadcast(event, payload),
    isShellFocused: () => {
      const status = shellSupervisor.status()
      return status.phase === 'running' && status.visible && status.focused
    },
    log: (level, message) => {
      if (level === 'error') logger.error?.(message)
      else if (level === 'warn') logger.warn?.(message)
      else logger.info?.(message)
    },
  })
  ctx.effect(() => () => approvalBridge?.dispose())

  questionBridge = createQuestionBridge({
    onRequest: (listener) => ctx.on('user-questions/request', listener as never, { prepend: true }) as unknown as () => void,
    emit: (event, payload) => sse.broadcast(event, payload),
    isShellFocused: () => {
      const status = shellSupervisor.status()
      return status.phase === 'running' && status.visible && status.focused
    },
    log: (level, message) => {
      if (level === 'error') logger.error?.(message)
      else if (level === 'warn') logger.warn?.(message)
      else logger.info?.(message)
    },
  })
  ctx.effect(() => () => questionBridge?.dispose())
  // 9) /commander/* 路由 + SSE
  const api = createCommanderApi({
    ctx,
    stores,
    binding,
    deliverer,
    messages,
    sse,
    getStatus: () => status,
    panelPresence: () => (resolvePanel(ctx).present ? 'present' : 'absent'),
    version: VERSION,
    logger,
    getPendingDispatch: () => dispatchService.currentPending(),
    boardService,
    taskActions,
    materialAssets,
    onTaskSettled: invalidatePendingForTask,
    rotation,
    getRotation: () => rotation.view(),
    getFormerCommanders: () => rotation.formerCommanders(),
    getMetrics: () => injector.metrics,
    windowPage,
    nativeShellStatus: () => shellSupervisor.status().phase,
    nativeShellPid: () => shellSupervisor.status().pid,
    ...(approvalBridge === undefined ? {} : { nativeApprovals: approvalBridge }),
    ...(questionBridge === undefined ? {} : { nativeQuestions: questionBridge }),
  })
  broadcastWorkspaceSnapshot = async () => {
    try {
      sse.broadcast('snapshot', await api.snapshot())
    } catch (error) {
      logger.warn?.(`[commander] workspace snapshot broadcast failed: ${String((error as Error)?.message ?? error)}`)
    }
  }
  ctx.effect(() => {
    const disposeRegistration = registerCommanderApi(webServer, api)
    // 路由先就位再拉起壳，避免首个 /commander/window 请求 404。
    shellSupervisor.start()
    return () => {
      disposeRegistration()
      shellSupervisor.stop()
      sse.dispose()
    }
  })

  // boot 关键证据以 /commander/health 为准（implementation-plan §8.2）；web 组合下 logger.info 可能不落 stdout，
  // 需要肉眼可见时设 COMMANDER_BOOT_LOG=warn（devops smoke 用），默认 info 不产生噪音。
  const bootLine = `[commander] host ready (version=${VERSION}, domainVia=${via}, configInitialized=${initialized}, panel=${resolvePanel(ctx).present ? 'present' : 'absent'})`
  if (process.env.COMMANDER_BOOT_LOG === 'warn') {
    // web 组合下 logger.warn 可能随 boot 层日志被吸走；env 显式开启时同时写 console.error 保证 boot 证据可见。
    logger.warn?.(bootLine)
    console.error(bootLine)
  } else logger.info?.(bootLine)
}

// 与已装插件（dsh-capability-settings 等）一致：只导出 name/inject/apply，不额外导出 default（避免 loader 解析歧义）。
