// 契约型 fake（implementation-plan §13.3）：形状与现场一致，不 mock 语义。
// 来源：V4 证据（storageDomain.open/table CRUD、update 原子、写入 schema 校验）、V3 证据（sessionController.create/prompt 形状）。
import type {
  CordisContext,
  DisposableLike,
  DomainHandle,
  DomainTable,
  HttpRequestLike,
  HttpResponseLike,
  ScheduleEditRequestLike,
  ScheduleEntryLike,
  ScheduleServiceLike,
  SessionControllerService,
  WebServerService,
  WorkspaceRegistryService,
} from '../../src/host/dsh-types.ts'

// ---------------------------------------------------------------- FakeCtx
export interface FakeCtxOptions {
  services?: Record<string, unknown>
  /**
   * 可选：模拟 cordis `inject`（等服务就绪再执行）。回调参数是“已注入服务的 scoped ctx”：
   * 真实宿主里它的属性访问（`scoped.tools`）才会触发 cordis 的 `internal/get` 归属信号。
   */
  inject?: (names: string[], callback: (scoped: FakeCtx) => void) => DisposableLike | void
  logger?: {
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
    debug?: (...args: unknown[]) => void
  }
}

export interface FakeCtx extends CordisContext {
  services: Map<string, unknown>
  listeners: Map<string, Array<(...args: unknown[]) => void>>
  disposers: Array<() => void>
  emit(event: string, ...args: unknown[]): void
  setService(name: string, value: unknown): void
}

export function createFakeCtx(options: FakeCtxOptions = {}): FakeCtx {
  const services = new Map<string, unknown>(Object.entries(options.services ?? {}))
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const disposers: Array<() => void> = []
  return {
    services,
    listeners,
    disposers,
    get(name: string) {
      return services.get(name)
    },
    on(event: string, listener: (...args: unknown[]) => void): DisposableLike {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((item) => item !== listener))
      }
    },
    effect(fn: () => void | (() => void)): DisposableLike {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    ...(options.inject !== undefined ? { inject: options.inject } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    setService(name: string, value: unknown) {
      services.set(name, value)
    },
  }
}

export function disposeAll(ctx: FakeCtx): void {
  for (const dispose of [...ctx.disposers].reverse()) dispose()
  ctx.disposers.length = 0
}

// ---------------------------------------------------------------- FakeStorageDomain
export interface FakeTable<V> extends DomainTable<V> {
  readonly map: Map<string, V>
}

export function createFakeStorageDomain() {
  const opened: Array<{ spec: unknown; domain: DomainHandle }> = []
  // 可跨实例共享的“介质”（模拟重启后仍在）：domainName → tableName → map
  const mediums = new Map<string, Map<string, Map<string, unknown>>>()
  const service = {
    async open(spec: unknown): Promise<DomainHandle> {
      const self = this as unknown as typeof service
      void self
      const domainSpec = spec as { name: string; version: number; tables: Record<string, { valueSchema: { parse: (value: unknown) => unknown } }> }
      if (!/^[a-z][a-z0-9_]*$/.test(domainSpec.name)) throw new Error(`domain '${domainSpec.name}' name invalid`)
      if (domainSpec.version !== 1) throw new Error(`domain '${domainSpec.name}' version must be 1`)
      const tables = new Map<string, FakeTable<unknown>>()
      const medium = mediums.get(domainSpec.name) ?? new Map<string, Map<string, unknown>>()
      mediums.set(domainSpec.name, medium)
      for (const [tableName, tableSpec] of Object.entries(domainSpec.tables)) {
        const map = medium.get(tableName) ?? new Map<string, unknown>()
        medium.set(tableName, map)
        const schema = tableSpec.valueSchema
        const table: FakeTable<unknown> = {
          map,
          get: (key) => map.get(key),
          entries: () => map.entries(),
          keys: () => map.keys(),
          get size() {
            return map.size
          },
          async put(key, value) {
            schema.parse(value) // 与现场一致：durable 边界用 valueSchema 校验
            map.set(key, structuredClone(value))
          },
          async update(key, fn) {
            if (!map.has(key)) throw new Error(`missing-key '${key}'`)
            const next = fn(structuredClone(map.get(key)) as unknown)
            schema.parse(next)
            map.set(key, structuredClone(next))
            return structuredClone(next) as never
          },
          async delete(key) {
            return map.delete(key)
          },
        }
        tables.set(tableName, table)
      }
      const domain: DomainHandle = {
        name: domainSpec.name,
        table<V>(tableName: string): DomainTable<V> {
          const table = tables.get(tableName)
          if (table === undefined) throw new Error(`unknown table '${tableName}'`)
          return table as unknown as DomainTable<V>
        },
        close() {
          return undefined
        },
      }
      opened.push({ spec, domain })
      return domain
    },
    opened,
    mediums,
  }
  return service
}

// ---------------------------------------------------------------- FakeSessionController
export interface FakeSessionController extends SessionControllerService {
  created: Array<Record<string, unknown>>
  prompts: Array<Record<string, unknown>>
  modelSelections: Array<Record<string, unknown>>
  renames: Array<{ sessionId: string; title: string }>
  nextSessionId: string
  failCreate?: Error
  failRename?: Error
  promptAccepted: boolean
  promptError?: Error
}

export function createFakeSessionController(): FakeSessionController {
  /** 真实 sessionController 方法读 this.ctx；fake 用同一约定把“解构丢 this”变成测试失败而不是静默通过。 */
  const assertReceiver = (receiver: unknown, method: string): void => {
    if (receiver !== controller) throw new Error(`sessionController.${method} called without controller receiver (lost this)`)
  }
  const controller: FakeSessionController = {
    created: [],
    prompts: [],
    modelSelections: [],
    renames: [],
    nextSessionId: 'session-fake-1',
    promptAccepted: true,
    async create(request) {
      assertReceiver(this, 'create')
      // 真实合同（V3 §2 异常表 / tester M0-3 e2e）：workspaceId 与 cwd 二选一，同时传必拒绝。
      if (request.workspaceId !== undefined && request.cwd !== undefined) {
        throw new Error('session.create accepts workspaceId or cwd, not both')
      }
      if (controller.failCreate !== undefined) throw controller.failCreate
      controller.created.push(request)
      return { sessionId: controller.nextSessionId }
    },
    async selectModel(request) {
      assertReceiver(this, 'selectModel')
      controller.modelSelections.push(request)
      return request
    },
    async rename(request) {
      assertReceiver(this, 'rename')
      if (controller.failRename !== undefined) throw controller.failRename
      controller.renames.push(request)
      return { title: request.title, seq: 1 }
    },
    async prompt(request, signal) {
      assertReceiver(this, 'prompt')
      controller.prompts.push({ ...request, ...(signal !== undefined ? { signal } : {}) })
      if (controller.promptError !== undefined) throw controller.promptError
      return { accepted: controller.promptAccepted, queued: false }
    },
    async cancel(request) {
      assertReceiver(this, 'cancel')
      return request
    },
  }
  return controller
}

// ---------------------------------------------------------------- FakeWebServer
export interface FakeWebServer extends WebServerService {
  registrations: Array<{ kind: 'prefix'; path: string; handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void> }>
  invoke(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown; text: string; events: string[] }>
}

export function createFakeWebServer(): FakeWebServer {
  const registrations: FakeWebServer['registrations'] = []
  return {
    registrations,
    register(registration) {
      registrations.push(registration)
      return () => {
        const index = registrations.indexOf(registration)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
    async invoke(method, path, body, headers = {}) {
      const registration = registrations.find((item) => path.startsWith(item.path))
      if (registration === undefined) return { status: 404, body: null, text: '', events: [] }
      const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
      const chunks: string[] = []
      const events: string[] = []
      const responseHeaders: Record<string, string> = {}
      const res = {
        statusCode: 200,
        setHeader(name: string, value: string) {
          responseHeaders[name.toLowerCase()] = value
        },
        write(chunk: string) {
          events.push(String(chunk))
          return true
        },
        end(chunk?: string) {
          if (chunk !== undefined) chunks.push(String(chunk))
          setTimeout(() => {
            for (const listener of listeners.get('close') ?? []) listener()
          }, 0)
        },
        on(event: 'close' | 'error', listener: (...args: unknown[]) => void) {
          const list = listeners.get(event) ?? []
          list.push(listener)
          listeners.set(event, list)
        },
      } as unknown as HttpResponseLike
      const req: HttpRequestLike = {
        method,
        url: path,
        headers: { 'content-type': 'application/json', ...headers },
        on(event, listener) {
          const list = listeners.get(event) ?? []
          list.push(listener)
          listeners.set(event, list)
        },
      }
      const handler = registration.handler
      const promise = Promise.resolve(handler(req, res))
      const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      await Promise.resolve()
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(payload))
      for (const listener of listeners.get('end') ?? []) listener()
      await promise
      const text = chunks.join('')
      let parsed: unknown = null
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      return { status: res.statusCode, body: parsed, text, events, headers: responseHeaders }
    },
  }
}

// ---------------------------------------------------------------- Fake 注册表/查询
export function createFakeWorkspaceRegistry(
  workspaces: Array<{ id: string; name: string; path: string; sessionIds?: string[]; archivedSessionIds?: string[] }>,
  options: { archivedSessionIds?: string[] } = {},
): WorkspaceRegistryService {
  const archivedSessionIds = options.archivedSessionIds ?? workspaces.flatMap((item) => item.archivedSessionIds ?? [])
  return {
    async list() {
      return workspaces
    },
    async get(workspaceId: string) {
      return workspaces.find((item) => item.id === workspaceId)
    },
    // 真实 WorkspaceRegistry 把归档集合挂在服务级 getter 上（registry-global）。
    archivedSessionIds,
  }
}

/**
 * sessionQuery 只读 fake（M1 候选 / M1R 会话列表 / 绑定）：
 * - 支持扁平旧形状或真实 SessionRecord（{header:{id,cwd,createdAt,origin,delegationDepth,agentPreset},live,persisted}）；
 * - readTitleSnapshots(ids) 按 options.titles 或扁平 title 合成 folded title 快照；options.titleError 模拟整批失败。
 */
export function createFakeSessionQuery(
  sessions: Array<Record<string, unknown>>,
  options: { titles?: Record<string, string>; titleError?: Error; titleRejectIds?: string[]; titleUpdatedAt?: number } = {},
) {
  const idOf = (session: Record<string, unknown>): string | undefined => {
    const header = session.header as { id?: unknown } | undefined
    if (typeof header?.id === 'string') return header.id
    if (typeof session.id === 'string') return session.id
    if (typeof session.sessionId === 'string') return session.sessionId
    return undefined
  }
  return {
    async listSessions() {
      return sessions.map((session) => ({ ...session }))
    },
    async readTitleSnapshots(ids: readonly string[]) {
      if (options.titleError !== undefined) throw options.titleError
      return ids.map((sessionId) => {
        if ((options.titleRejectIds ?? []).includes(sessionId)) {
          return { sessionId, status: 'rejected', reason: new Error('title fold failed') }
        }
        const explicit = options.titles?.[sessionId]
        const flat = sessions.find((session) => idOf(session) === sessionId)
        const title = explicit ?? (typeof flat?.title === 'string' && flat.title !== '' ? flat.title : undefined)
        const header = flat?.header as Record<string, unknown> | undefined
        const sessionHeader = header !== undefined
          ? { ...header }
          : {
              id: sessionId,
              ...(typeof flat?.cwd === 'string' ? { cwd: flat.cwd } : {}),
              ...(typeof flat?.createdAt === 'number' ? { createdAt: flat.createdAt } : {}),
              ...(typeof flat?.updatedAt === 'number' ? { createdAt: flat.updatedAt } : {}),
            }
        return {
          sessionId,
          status: 'fulfilled',
          value: {
            session: sessionHeader,
            ...(title !== undefined
              ? { title: { title, source: 'user', eventSeq: 1, updatedAt: options.titleUpdatedAt ?? 1000 } }
              : {}),
          },
        }
      })
    },
    async get(sessionId: string) {
      const found = sessions.find((session) => idOf(session) === sessionId)
      if (found === undefined) return undefined
      const header = found.header as { id?: string; cwd?: string } | undefined
      return { id: sessionId, ...(header?.cwd !== undefined ? { cwd: header.cwd } : {}), ...(typeof found.workspaceId === 'string' ? { workspaceId: found.workspaceId } : {}) }
    },
  }
}

export function createFakeSessions(sessions: Array<{ id: string; cwd?: string; workspaceId?: string }>) {
  return {
    async get(sessionId: string) {
      const found = sessions.find((item) => item.id === sessionId)
      return found === undefined ? undefined : { ...found }
    },
    async list() {
      return sessions
    },
  }
}

export function createFakeCapabilityPanel(options: {
  threshold?: number
  items?: Array<{ id: string; name: string; score: number; applicable?: boolean }>
  applyResult?: Record<string, unknown>
  rankError?: Error
  applyError?: Error
} = {}) {
  const calls: string[] = []
  return {
    calls,
    jev: {
      async getConfig() {
        calls.push('getConfig')
        return { hasApiKey: true, ...(options.threshold !== undefined ? { threshold: options.threshold } : {}) }
      },
      async rank() {
        calls.push('rank')
        if (options.rankError !== undefined) throw options.rankError
        return { ok: true, items: (options.items ?? []).map((item) => ({ applicable: true, ...item })) }
      },
      async apply() {
        calls.push('apply')
        if (options.applyError !== undefined) throw options.applyError
        return { ok: true, applied: 1, elapsedMs: 12, pending: false, ...(options.applyResult ?? {}) }
      },
    },
  }
}

/** Fake agent（工具作用域测试）：agent.ctx.get('tools') 提供 register/restrict 记录。 */
/** 全局 tools 服务 fake：记录每次 register（定义 + when 选项）与注销。 */
export function createFakeTools() {
  const registered: Array<{ definition: unknown; options?: { when?: (context: { agent?: unknown }) => boolean } }> = []
  return {
    registered,
    register(definition: unknown, options?: { when?: (context: { agent?: unknown }) => boolean }) {
      const entry = { definition, ...(options === undefined ? {} : { options }) }
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
}

export function createFakeAgent(options: { sessionId: string; isCommander?: boolean } = { sessionId: '' }) {
  const registered: Array<{ name?: string }> = []
  const restricted: string[][] = []
  const tools = {
    register(definition: unknown) {
      registered.push(definition as { name?: string })
      return () => {
        const index = registered.indexOf(definition as { name?: string })
        if (index >= 0) registered.splice(index, 1)
      }
    },
    restrict(input: { deny: string[] }) {
      restricted.push(input.deny)
      return () => undefined
    },
  }
  const agent = {
    id: options.sessionId,
    session: { id: options.sessionId, header: { id: options.sessionId } },
    ctx: { get: (name: string) => (name === 'tools' ? tools : undefined) },
    tools,
    registered,
    restricted,
  }
  return agent
}


// ---------------------------------------------------------------- R1 FakeAgents
export interface FakeAgentRecord {
  id: string
  session: { id: string; header: { id: string } }
  injected: Array<Record<string, unknown>>
  followups: Array<Record<string, unknown>>
  whenIdleCalls: number
  inject(message: unknown): void
  followup(message: unknown): void
  whenIdle(): Promise<void>
}

export interface FakeAgents {
  agents: Map<string, FakeAgentRecord>
  add(sessionId: string): FakeAgentRecord
  get(sessionId: string): FakeAgentRecord | undefined
  list(): FakeAgentRecord[]
}

/** agents 服务 fake：`get(sessionId)` 返回 live agent，记录 inject/followup。 */
export function createFakeAgents(): FakeAgents {
  const agents = new Map<string, FakeAgentRecord>()
  const registry: FakeAgents = {
    agents,
    add(sessionId: string) {
      const agent: FakeAgentRecord = {
        id: sessionId,
        session: { id: sessionId, header: { id: sessionId } },
        injected: [],
        followups: [],
        whenIdleCalls: 0,
        inject(message) {
          agent.injected.push(message as Record<string, unknown>)
        },
        followup(message) {
          agent.followups.push(message as Record<string, unknown>)
        },
        async whenIdle() {
          agent.whenIdleCalls += 1
        },
      }
      agents.set(sessionId, agent)
      return agent
    },
    get(sessionId: string) {
      return agents.get(sessionId)
    },
    list() {
      return [...agents.values()]
    },
  }
  return registry
}

// ---------------------------------------------------------------- FakeSchedule
export interface FakeScheduleEntry {
  id: string
  status: 'active' | 'paused' | 'ended'
  updatedAt?: string
  target:
    | { kind: 'session'; sessionId: string }
    | { kind: 'new_once'; sessionId: string }
    | { kind: 'new' }
}

export interface FakeScheduleService {
  entries: Map<string, FakeScheduleEntry>
  catalogCalls: number
  viewCalls: number
  edits: Array<{ request: ScheduleEditRequestLike; actor?: string }>
  service: ScheduleServiceLike
}

/** 契约型 schedule fake：catalog 全量、edit CAS、只改 target、状态保持、updatedAt 递增。 */
export function createFakeSchedule(seed: readonly FakeScheduleEntry[]): FakeScheduleService {
  const entries = new Map(seed.map((item) => [item.id, structuredClone(item)]))
  const fake: FakeScheduleService = {
    entries,
    catalogCalls: 0,
    viewCalls: 0,
    edits: [],
    service: {
      async catalog(): Promise<readonly ScheduleEntryLike[]> {
        fake.catalogCalls += 1
        return [...entries.values()].map((item) => structuredClone(item))
      },
      async view(request: { id: string }): Promise<unknown> {
        fake.viewCalls += 1
        const current = entries.get(request.id)
        return current === undefined ? { id: request.id, code: 'schedule_not_found' } : structuredClone(current)
      },
      async edit(request: ScheduleEditRequestLike, actor?: string): Promise<unknown> {
        fake.edits.push({ request: structuredClone(request), ...(actor !== undefined ? { actor } : {}) })
        const current = entries.get(request.id)
        if (current === undefined) return { id: request.id, code: 'schedule_not_found' }
        if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
          return { id: request.id, code: 'schedule_conflict' }
        }
        current.target = structuredClone(request.patch.target)
        current.updatedAt = `edited-${fake.edits.length}`
        return structuredClone(current)
      },
    },
  }
  return fake
}
