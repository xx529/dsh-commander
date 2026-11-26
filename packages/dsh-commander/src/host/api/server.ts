// /commander/* 前缀路由：method+path 分发、JSON 解析/限长、错误 envelope、写操作 requestId 幂等 LRU、SSE 升级。
// 口径：implementation-plan §8.1/§8.5 + m0-contract-patch §1.7/§2.1。
import {
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
} from '../config.ts'
import type { CordisContext, HttpRequestLike, HttpResponseLike, WebServerService } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'
import type { MaterialAssets } from './material-assets.ts'
import type { BindingService } from '../session/binding.ts'
import type { Deliverer } from '../session/deliver.ts'
import type { MessageRing } from '../session/messages.ts'
import type { CommanderStatusState } from '../session/commander-events.ts'
import type { SseHub } from './sse.ts'
import { ApiError, API_ERROR_HTTP, errorBody, toApiError } from './errors.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  handleBindingPost,
  handleConfigGet,
  handleConfigPut,
  handleHealth,
  handleJevTest,
  handleArchiveList,
  handleBoardPatch,
  handleTaskAccept,
  handleTaskCancel,
  handleTaskContinue,
  handleMessagePost,
  handleRotation,
  handleSessionTranscript,
  handleSessionsGet,
  handleTaskAction,
  handleStateJson,
  handleTaskGet,
  handleWorkspacesPut,
  snapshotOf,
} from './routes/handlers.ts'

export const API_PREFIX = '/commander'

import type { BoardService } from '../board/service.ts'
import type { TaskActions } from '../tasks/actions.ts'
import type { FormerCommander, RotationService, RotationView } from '../rotation/service.ts'

export interface ApiDeps {
  ctx: CordisContext
  stores: StoreSet
  binding: BindingService
  deliverer: Deliverer
  messages: MessageRing
  sse: SseHub
  getStatus: () => CommanderStatusState
  panelPresence: () => 'present' | 'absent'
  version: string
  now?: () => number
  logger?: { warn?: (...args: unknown[]) => void }
  /** M1：当前 pendingDispatch（快照/dispatch.updated 共用；无则 null）。 */
  getPendingDispatch?: () => unknown
  /** M2：看板人工改动/归档/回收站服务。 */
  boardService?: BoardService
  /** M3：人专用 accept/rework 动作。 */
  taskActions?: TaskActions
  /** M5：任务结算（accept/archive）后清理未决派发确认。 */
  onTaskSettled?: (taskId: string) => void
  /** M3：注入 metrics（快照）。 */
  getMetrics?: () => { injections: number; deduped: number; pendingSkipped: number; injectFailures: number; projectionUnavailable: number }
  /** M4：原生壳窗口页（token 校验后返回内联 HTML）。 */
  windowPage?: { token: string; html(requestUrl: string): string | null }
  /** M4：原生壳进程状态（health 加法字段）。 */
  nativeShellStatus?: () => 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'
  /** M4：原生壳 pid（health 加法字段；无进程时为 null）。 */
  nativeShellPid?: () => number | null
  /** M4：壳条件接管的审批（列表 + 回答）。 */
  nativeApprovals?: {
    list(): unknown[]
    resolve(id: string, outcome: 'allowed-once' | 'rejected'): boolean
  }
  /** M4：壳条件接管的问答（列表 + 回答）。 */
  nativeQuestions?: {
    list(): unknown[]
    resolve(id: string, answers: unknown): unknown | null
  }
  /** 方案 A：报告材料本地图片签名 URL / 只读读取。 */
  materialAssets?: MaterialAssets
  /** R1：轮换服务（手动/强制换任）+ 快照只读视图。 */
  rotation?: RotationService
  getRotation?: () => RotationView
  getFormerCommanders?: () => FormerCommander[]
}

export interface IdempotencyEntry {
  at: number
  status: number
  body: unknown
}

export function createIdempotencyCache(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS
  const maxEntries = options.maxEntries ?? IDEMPOTENCY_MAX_ENTRIES
  const now = options.now ?? (() => Date.now())
  const store = new Map<string, IdempotencyEntry>()
  const prune = (timestamp: number): void => {
    for (const [key, entry] of store) {
      if (timestamp - entry.at > ttlMs) store.delete(key)
    }
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value as string | undefined
      if (oldest === undefined) break
      store.delete(oldest)
    }
  }
  return {
    get(key: string): IdempotencyEntry | undefined {
      prune(now())
      return store.get(key)
    },
    set(key: string, status: number, body: unknown): void {
      const timestamp = now()
      store.set(key, { at: timestamp, status, body })
      prune(timestamp)
    },
    size(): number {
      return store.size
    },
    clear(): void {
      store.clear()
    },
  }
}

const MAX_BODY_BYTES = 1_048_576

async function readOptionalJson(req: HttpRequestLike): Promise<unknown> {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ApiError('invalid_request', 'body must be valid JSON')
  }
}

function readBody(req: HttpRequestLike): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError('invalid_request', 'request body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
  })
}

function sendJson(res: HttpResponseLike, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

function methodOf(req: HttpRequestLike): string {
  return String(req.method ?? 'GET').toUpperCase()
}

function pathOf(req: HttpRequestLike): string {
  const url = String(req.url ?? '/')
  const query = url.indexOf('?')
  return query >= 0 ? url.slice(0, query) : url
}

function requestIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const candidate = (body as Record<string, unknown>).requestId
  return typeof candidate === 'string' && candidate.length >= 8 && candidate.length <= 64 ? candidate : null
}

/**
 * 创建 /commander/* 处理器。返回 { handler, dispose }；handler 交给 webServer.register 的 prefix 路由。
 * SSE：`GET /commander/state` 且 Accept 含 text/event-stream 时升级（首帧 snapshot）。
 */
export function createCommanderApi(deps: ApiDeps) {
  const idempotency = createIdempotencyCache(deps.now !== undefined ? { now: deps.now } : {})
  let disposed = false
  const routes = new Map<string, (body: unknown) => Promise<{ status: number; body: unknown } | 'sse'>>()
  routes.set('GET /commander/health', async () => handleHealth(deps))
  routes.set('GET /commander/state', async () => handleStateJson(deps))
  routes.set('GET /commander/config', async () => handleConfigGet(deps))
  routes.set('PUT /commander/config', async (body) => handleConfigPut(deps, body))
  routes.set('POST /commander/jev/test', async (body) => handleJevTest(deps, body))
  routes.set('PUT /commander/workspaces', async (body) => handleWorkspacesPut(deps, body))
  routes.set('POST /commander/binding', async (body) => handleBindingPost(deps, body))
  routes.set('POST /commander/message', async (body) => handleMessagePost(deps, body))
  routes.set('POST /commander/rotation', async (body) => handleRotation(deps, body))

  const handleSse = async (res: HttpResponseLike): Promise<void> => {
    const snapshot = await snapshotOf(deps)
    deps.sse.attach(res, snapshot)
  }

  const handler = async (req: HttpRequestLike, res: HttpResponseLike): Promise<void> => {
    if (disposed) {
      sendJson(res, 503, errorBody(new ApiError('internal', 'api disposed')))
      return
    }
    const method = methodOf(req)
    const path = pathOf(req)
    const key = `${method} ${path}`
    // M4 原生壳会话窗口：只读会话 transcript。
    if (method === 'GET' && path === '/commander/session-transcript') {
      try {
        const raw = String(req.url ?? '')
        const index = raw.indexOf('?')
        const query = index >= 0 ? new URLSearchParams(raw.slice(index + 1)) : new URLSearchParams()
        const result = await handleSessionTranscript(deps, query.get('sessionId') ?? '', query.get('limit'))
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M4 诊断：窗口页 JS 错误上报（写 ~/.dsh/commander/native/window-errors.log）。
    if (method === 'GET' && path === '/commander/window-error') {
      const raw = String(req.url ?? '')
      const index = raw.indexOf('?')
      const query = index >= 0 ? new URLSearchParams(raw.slice(index + 1)) : new URLSearchParams()
      const message = (query.get('message') ?? '').slice(0, 2000)
      deps.logger?.warn?.(`[commander] window page error: ${message}`)
      try {
        const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'commander', 'native')
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'window-errors.log'), `${new Date().toISOString()} ${message}\n`)
      } catch {
        // best-effort
      }
      res.statusCode = 204
      res.end()
      return
    }
    // M4 原生壳问答：窗口页读取待答批次 / 回答。
    if (method === 'GET' && path === '/commander/native/questions') {
      sendJson(res, 200, { ok: true, questions: deps.nativeQuestions?.list() ?? [] })
      return
    }
    const nativeQuestionMatch = method === 'POST' ? /^\/commander\/native\/question\/([^/]+)$/.exec(path) : null
    if (nativeQuestionMatch !== null) {
      try {
        const body = await readOptionalJson(req)
        const id = decodeURIComponent(nativeQuestionMatch[1] as string)
        const answer = deps.nativeQuestions?.resolve(id, body)
        if (answer === null || answer === undefined) {
          sendJson(res, 404, errorBody(new ApiError('not_found', 'question batch is not pending or the answers are invalid')))
          return
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M4 原生壳审批：窗口页读取待决列表 / 回答。
    if (method === 'GET' && path === '/commander/native/approvals') {
      sendJson(res, 200, { ok: true, approvals: deps.nativeApprovals?.list() ?? [] })
      return
    }
    const nativeApprovalMatch = method === 'POST' ? /^\/commander\/native\/approval\/([^/]+)$/.exec(path) : null
    if (nativeApprovalMatch !== null) {
      try {
        const body = await readOptionalJson(req)
        const outcome = (body as { outcome?: unknown }).outcome
        if (outcome !== 'allowed-once' && outcome !== 'rejected') {
          throw new ApiError('invalid_request', 'outcome must be allowed-once or rejected', { field: 'outcome' })
        }
        const id = decodeURIComponent(nativeApprovalMatch[1] as string)
        const resolved = deps.nativeApprovals?.resolve(id, outcome) ?? false
        if (!resolved) {
          sendJson(res, 404, errorBody(new ApiError('not_found', 'approval is not pending')))
          return
        }
        sendJson(res, 200, { ok: true })
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M4 原生壳窗口页：一次性 token 校验后返回内联窗口 bundle。
    if (method === 'GET' && path === '/commander/window') {
      const html = deps.windowPage?.html(String(req.url ?? '')) ?? null
      if (html === null) {
        sendJson(res, 404, errorBody(new ApiError('not_found', 'window page token is invalid or missing')))
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Set-Cookie', `commander_window=${deps.windowPage?.token ?? ''}; Path=/commander; HttpOnly; SameSite=Strict`)
      res.end(html)
      return
    }
    // 方案 A：报告材料本地图片（签名 URL；只读、只服务 image 材料）。
    const materialMatch = method === 'GET' ? /^\/commander\/tasks\/([^/]+)\/materials\/([^/]+)$/.exec(path) : null
    if (materialMatch !== null && deps.materialAssets !== undefined) {
      try {
        const raw = String(req.url ?? '')
        const queryIndex = raw.indexOf('?')
        const query = queryIndex >= 0 ? new URLSearchParams(raw.slice(queryIndex + 1)) : new URLSearchParams()
        const taskId = decodeURIComponent(materialMatch[1] as string)
        const materialId = decodeURIComponent(materialMatch[2] as string)
        const asset = await deps.materialAssets.read(taskId, materialId, query.get('sig') ?? '')
        if (asset === undefined) {
          sendJson(res, 404, errorBody(new ApiError('not_found', 'material is missing or the signature is invalid')))
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', asset.mime)
        res.setHeader('Content-Length', String(asset.bytes.byteLength))
        res.setHeader('Cache-Control', 'private, max-age=3600')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
        res.setHeader('Content-Disposition', `inline; filename="${asset.filename.replace(/[^\x20-\x7e]/g, '_')}"`)
        res.end(asset.bytes)
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    if (path === '/commander/state' && method === 'GET') {
      const accept = String(req.headers.accept ?? '')
      if (accept.includes('text/event-stream')) {
        try {
          await handleSse(res)
        } catch (error) {
          const apiError = toApiError(error)
          sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
        }
        return
      }
    }
    // M1R 动态路由：GET /commander/sessions?workspaceId=…（只读会话列表）
    if (method === 'GET' && path === '/commander/sessions') {
      try {
        const query = (() => {
          const raw = String(req.url ?? '')
          const index = raw.indexOf('?')
          return index >= 0 ? new URLSearchParams(raw.slice(index + 1)) : new URLSearchParams()
        })()
        const result = await handleSessionsGet(deps, query.get('workspaceId') ?? '', query.get('limit') ?? undefined)
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M2 动态路由：PATCH /commander/board/tasks/:id（人工改板）
    const boardMatch = method === 'PATCH' ? /^\/commander\/board\/tasks\/([^/]+)$/.exec(path) : null
    if (boardMatch !== null) {
      try {
        const body = await readOptionalJson(req)
        const taskId = decodeURIComponent(boardMatch[1] as string)
        const requestId = requestIdOf(body)
        const cacheKey = `PATCH ${path}`
        if (requestId !== null) {
          const cached = idempotency.get(`${cacheKey} ${requestId}`)
          if (cached !== undefined) {
            sendJson(res, cached.status, cached.body)
            return
          }
        }
        const result = await handleBoardPatch(deps, taskId, body)
        if (requestId !== null && result.status === 200) idempotency.set(`${cacheKey} ${requestId}`, result.status, result.body)
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        deps.logger?.warn?.(`[commander] board patch error ${apiError.code}: ${apiError.message}`)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M2 动态路由：GET /commander/archive（回收站列表）
    if (method === 'GET' && path === '/commander/archive') {
      try {
        const raw = String(req.url ?? '')
        const index = raw.indexOf('?')
        const query = index >= 0 ? new URLSearchParams(raw.slice(index + 1)) : new URLSearchParams()
        const result = await handleArchiveList(
          deps,
          query.get('limit') ?? undefined,
          query.get('cursor') ?? undefined,
          query.get('q') ?? undefined,
          query.get('status') ?? undefined,
          query.get('workspaceId') ?? undefined,
          query.get('from') ?? undefined,
          query.get('to') ?? undefined,
        )
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M2/M3/M5 动态路由：POST /commander/tasks/:id/(archive|restore|accept|continue|rework)
    const actionMatch = method === 'POST' ? /^\/commander\/tasks\/([^/]+)\/(archive|restore|accept|cancel|continue|rework)$/.exec(path) : null
    if (actionMatch !== null) {
      try {
        const body = await readOptionalJson(req) // body 可选（{} 或无 body）
        const taskId = decodeURIComponent(actionMatch[1] as string)
        const action = actionMatch[2] as 'archive' | 'restore' | 'accept' | 'cancel' | 'continue' | 'rework'
        const result = action === 'archive' || action === 'restore'
          ? await handleTaskAction(deps, taskId, action)
          : action === 'accept'
            ? await handleTaskAccept(deps, taskId, body)
            : action === 'cancel'
              ? await handleTaskCancel(deps, taskId)
              : await handleTaskContinue(deps, taskId, body)
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        deps.logger?.warn?.(`[commander] task action error ${apiError.code}: ${apiError.message}`)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    // M1 动态路由：GET /commander/tasks/:id（只读任务详情）
    const taskMatch = method === 'GET' ? /^\/commander\/tasks\/([^/]+)$/.exec(path) : null
    if (taskMatch !== null) {
      try {
        const result = await handleTaskGet(deps, decodeURIComponent(taskMatch[1] as string))
        sendJson(res, result.status, result.body)
      } catch (error) {
        const apiError = toApiError(error)
        sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
      }
      return
    }
    const route = routes.get(key)
    if (route === undefined) {
      const knownPath = [...routes.keys()].some((routeKey) => routeKey.endsWith(` ${path}`))
      sendJson(res, knownPath ? 405 : 404, errorBody(new ApiError('not_found', knownPath ? `method ${method} not allowed` : `unknown route '${path}'`)))
      return
    }
    const isWrite = method === 'POST' || method === 'PUT'
    let body: unknown = null
    try {
      if (isWrite) {
        const raw = await readBody(req)
        if (raw.length === 0) throw new ApiError('invalid_request', 'request body is required')
        try {
          body = JSON.parse(raw.toString('utf8'))
        } catch {
          throw new ApiError('invalid_request', 'body must be valid JSON')
        }
        const requestId = requestIdOf(body)
        if (requestId !== null) {
          const cached = idempotency.get(`${key} ${requestId}`)
          if (cached !== undefined) {
            sendJson(res, cached.status, cached.body)
            return
          }
        }
      }
      const result = await route(typeof body === 'object' && body !== null ? body : null)
      if (result === 'sse') return
      if (isWrite) {
        const requestId = requestIdOf(body)
        if (requestId !== null && result.status === 200) idempotency.set(`${key} ${requestId}`, result.status, result.body)
      }
      sendJson(res, result.status, result.body)
    } catch (error) {
      const apiError = error instanceof ApiError ? error : error instanceof TypeError ? new ApiError('invalid_request', String(error.message)) : toApiError(error)
      deps.logger?.warn?.(`[commander] api error ${apiError.code}: ${apiError.message}`)
      sendJson(res, API_ERROR_HTTP[apiError.code] ?? 500, errorBody(apiError))
    }
  }

  return {
    handler,
    /** 只读整帧快照（工具写工作区摘要后广播用，与 HTTP `GET /commander/state` 同源）。 */
    snapshot: () => snapshotOf(deps),
    dispose() {
      disposed = true
      idempotency.clear()
    },
    idempotency,
  }
}

export interface CommanderApi {
  handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<void>
  /** 只读整帧快照（不推 SSE；调用方决定是否 broadcast）。 */
  snapshot: () => Promise<import('./state.ts').CommanderSnapshot>
  dispose: () => void
  idempotency: ReturnType<typeof createIdempotencyCache>
}

/** 注册前缀路由（调用方负责 ctx.effect 收尾）。 */
export function registerCommanderApi(webServer: WebServerService, api: CommanderApi): () => void {
  const disposeRegistration = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => api.handler(req, res),
  })
  return () => {
    api.dispose()
    disposeRegistration?.()
  }
}
