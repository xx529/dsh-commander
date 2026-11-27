// 本地最小平台类型（不 import 任何 @deepseek-ai/* 包；零运行时依赖原则）。
// 形状来源：implementation-plan.md §3.2 + V4/V3 现场探针证据（storage-domain 0.1.0-rc.x）。

/** Cordis 上下文的最小面。 */
export interface CordisContext {
  get(name: string, strict?: boolean): unknown
  on(event: string, listener: (...args: unknown[]) => void, options?: { prepend?: boolean }): DisposableLike
  effect(fn: () => void | (() => void)): DisposableLike
  /** Cordis 注入：等服务就绪再执行（可选；旧宿主可能没有）。 */
  inject?(names: string[], callback: (scoped: CordisContext) => void): DisposableLike | void
  logger?: {
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
    debug?: (...args: unknown[]) => void
  }
}

export interface DisposableLike {
  (): void
}

/** 可 dispose 的注册结果（webServer.register / ctx.effect 返回）。 */
export type Disposer = () => void

/** storageDomain 表句柄（读同步、写串行；形状照 V4 证据）。 */
export interface DomainTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: V): Promise<void>
  update(key: string, fn: (current: V) => V): Promise<V>
  delete(key: string): Promise<boolean>
}

export interface DomainHandle {
  readonly name: string
  table<V>(name: string): DomainTable<V>
  close(): Promise<void> | void
}

export interface StorageDomainService {
  open(spec: unknown): Promise<DomainHandle>
}

/** http 请求/响应最小面（webServer prefix handler 形态照 implementation-plan §8.1）。 */
export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data' | 'end' | 'close' | 'error', listener: (...args: unknown[]) => void): void
  destroy?(): void
}

export interface HttpResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  write(chunk: string): boolean | void
  end(chunk?: string | Uint8Array): void
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): void
  flushHeaders?(): void
}

export interface WebServerService {
  /** 监听端口（port=0 时由 OS 分配；dsh-host-webserver 在监听后提供）。 */
  port?: number
  /** 本机客户端访问的根 URL（dsh-host-webserver 提供）。 */
  getOrigin?(): string
  register(registration: { kind: 'prefix'; path: string; handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void> }): Disposer
}

/** sessionController 最小面（形状照 V3 证据：create/selectModel/prompt/cancel）。 */
/** agents 服务（dsh-agent AgentRegistry）的最小只读面：按会话 id 取 live Agent。 */
export interface AgentLike {
  id?: string
  /** 会话身份（部分宿主只挂在 session 上）。 */
  session?: { id?: string; header?: { id?: string } } | unknown
  /** 追加一条会开启新一轮的用户角色消息（可带自定义 source，从而渲染成上下文卡）。 */
  followup?(message: unknown): void
  /** R1：加面向模型的上下文但不唤醒驱动器（落在下一个被接纳的 step）。 */
  inject?(message: unknown): void
  /** R1：等待 agent 完全停稳（换任前门控）。 */
  whenIdle?(): Promise<void>
}

export interface AgentsService {
  get?(sessionId: string): AgentLike | undefined
  list?(): AgentLike[]
}

export interface SessionControllerService {
  create?(request: Record<string, unknown>): Promise<{ sessionId?: string; id?: string }>
  /** 显式用户标题（源='user'，钉住标题、不覆盖）；换任后用于给新会话落日期标题。 */
  rename?(request: { sessionId: string; title: string }): Promise<{ title?: string; seq?: number }>
  selectModel?(request: Record<string, unknown>): Promise<unknown>
  prompt?(request: Record<string, unknown>, signal?: unknown): Promise<{ accepted?: boolean; queued?: boolean; error?: { code?: string; message?: string } }>
  cancel?(request: Record<string, unknown>): Promise<unknown>
}

export interface SessionEventLike {
  seq?: number
  type?: string
  time?: number
  data?: Record<string, unknown>
}

export interface SessionLike {
  id: string
  workspaceId?: string
  cwd?: string
  events?: SessionEventLike[]
  eventAt?(seq: number): SessionEventLike | undefined
  /** 真实 @deepseek-ai/dsh-session 的 live Session：唯一的事件读法（无 `events` 字段）。 */
  snapshotEvents?(): SessionEventLike[] | readonly SessionEventLike[]
}

/** sessions / sessionQuery 的只读查询面（软依赖；select 绑定时用）。 */
export interface SessionsQueryService {
  get?(sessionId: string): Promise<SessionLike | undefined> | SessionLike | undefined
  list?(): Promise<Array<{ id: string; cwd?: string; workspaceId?: string }>> | Array<{ id: string; cwd?: string; workspaceId?: string }>
  /** 真实 @deepseek-ai/dsh-session-query：完整事件日志（live 优先，冷会话读持久化，返回克隆）。 */
  readSession?(sessionId: string): Promise<{ events?: SessionEventLike[] }> | { events?: SessionEventLike[] }
  /** 真实 @deepseek-ai/dsh-session-query：SessionRecord[]（header 包裹；M1R 起按 header 解析）。 */
  listSessions?(signal?: AbortSignal): Promise<unknown[]>
  /** 真实 dsh-session-query：每会话最新 folded title 快照（冷会话也有效）。 */
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<unknown[]>
}

/** workspaceRegistry 的只读面（软依赖；绑定/白名单校验用）。 */
export interface WorkspaceRegistryService {
  list?(): Promise<Array<{ id: string; name?: string; title?: string; path: string; sessionIds?: string[] }>> | Array<{ id: string; name?: string; title?: string; path: string; sessionIds?: string[] }>
  get?(workspaceId: string): Promise<{ id: string; name?: string; title?: string; path: string } | undefined> | { id: string; name?: string; title?: string; path: string } | undefined
  /** registry-**全局**归档会话集合（`WorkspaceRegistry.archivedSessionIds`；不是每个 workspace 上的字段）。 */
  archivedSessionIds?: readonly string[]
}

/** capabilityPanel 软依赖（M0 只读 present/absent；M1 用 jev.rank/apply）。 */
export interface CapabilityPanelService {
  jev?: {
    getConfig?: () => Promise<Record<string, unknown>> | Record<string, unknown>
    rank?: (...args: unknown[]) => Promise<unknown> | unknown
    apply?: (...args: unknown[]) => Promise<unknown> | unknown
  }
}

export interface SessionProjectionsService {
  snapshot?: (session: unknown) => unknown
}

// ---------------------------------------------------------------- schedule（软依赖）
// 形状来源：@deepseek-ai/dsh-schedule 0.2.2-rc.2/rc.3 的 Host 服务面（catalog/view/edit）。
// 不 import 该包：Host 零运行时依赖；只用结构化最小面 + 运行时形状校验。

/** Host schedule 任务的最小只读面（只声明迁移需要的字段）。 */
export interface ScheduleEntryLike {
  id: string
  status?: string
  updatedAt?: string
  /** `{kind:'session'|'new_once'|'new', sessionId?, create?}`；运行时按 unknown 校验。 */
  target?: unknown
}

/** `edit()` 的 update 请求（只用到改 target + CAS）。 */
export interface ScheduleEditRequestLike {
  id: string
  action: 'update'
  patch: { target: { kind: 'session'; sessionId: string } }
  expectedUpdatedAt?: string | null
}

/** Host schedule 服务的最小面；`view` 可选（缺省时 CAS 冲突不重试）。 */
export interface ScheduleServiceLike {
  catalog(): Promise<readonly ScheduleEntryLike[]>
  view?(request: { id: string }): Promise<unknown>
  edit(request: ScheduleEditRequestLike, actorSessionId?: string): Promise<unknown>
}
