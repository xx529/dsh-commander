/**
 * Commander client state: snapshot application, SSE frame parsing, revision
 * ordering, message merging, and the small HTTP transport helpers.
 *
 * Everything in this file is pure or environment-injected so it can be unit
 * tested with `node --test` without a DOM (`tests/client/state.test.ts`).
 * Contract: docs/architecture/m0-contract-patch.md §1.6/§1.7 and
 * docs/architecture/implementation-plan.md §8.3/§8.4.
 */
import type {
  ApiFailure, ChatMessage, CommanderBinding, CommanderMessage, CommanderSnapshot, CommanderStatus,
  CommanderActivity,
  ArchiveListResult, ArchiveQuery, BoardEditView, BoardPatchRequest, BoardPatchResult, ConfigPatch, ConfigView, ConnectionPhase,
  HttpResult, JevConfig, JevTestResult, PendingDispatchView, SessionListResult, SessionOptionView, TaskDetailView,
  TaskView, EntryPosition, UiConfig, WorkSessionView, WorkspacePatch, WorkspaceView, WriteResult,
  RotationView, FormerCommander, RotationResult,
} from './types'

/** Maximum number of Host messages the panel keeps in memory (snapshot cap). */
export const MESSAGE_LIMIT = 200

/** Maximum message length accepted by `POST /commander/message` (contract §1.3). */
export const MESSAGE_MAX_CHARS = 8192

/** Polling cadence used when SSE is unavailable (task: 3s degradation). */
export const POLL_INTERVAL_MS = 3_000

/** The full client-side state the overlay/settings render from. */
export interface CommanderState {
  /** Highest `rev` applied so far; used to drop out-of-order events. */
  rev: number
  connection: ConnectionPhase
  binding: CommanderBinding | null
  commanderStatus: CommanderStatus
  /** Panel presence reported by the Host (`/commander/health` via snapshot). */
  panel: 'present' | 'absent' | 'unknown'
  counts: Record<string, number>
  workspaces: WorkspaceView[]
  tasks: TaskView[]
  pendingDispatch: PendingDispatchView | null
  /** M3 task-linked work sessions (approval floating card source). */
  workSessions: WorkSessionView[]
  /** M2 trash counters carried by the snapshot (fallback: derive from counts). */
  archiveSummary?: { archivedCount?: number; cancelledCount?: number }
  messages: ChatMessage[]
  busy: boolean
  lastTurnId: number | null
  /** Current tool description / assistant text from the Host (`commander.status.activity`). */
  activity: CommanderActivity | null
  lastEventAt: number
  /** UI preference mirrored from `PUT /commander/config` (not part of the snapshot). */
  ui: UiConfig
  /** M4: native shell phase; `running` hides the in-page ball in favour of the desktop one. */
  nativeShell?: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'
  /** R1: command-session rotation status (null until the first snapshot). */
  rotation: RotationView | null
  /** R1: retired commanders (newest retired first, ≤10). */
  formerCommanders: FormerCommander[]
}

/** Create the empty state the store starts from. */
export function createInitialState(): CommanderState {
  return {
    rev: 0,
    connection: 'idle',
    binding: null,
    commanderStatus: 'unknown',
    panel: 'unknown',
    counts: {},
    workspaces: [],
    tasks: [],
    pendingDispatch: null,
    workSessions: [],
    messages: [],
    busy: false,
    lastTurnId: null,
    activity: null,
    lastEventAt: 0,
    ui: { theme: 'follow', entryPosition: 'br', entryEnabled: true, entryPos: null },
    rotation: null,
    formerCommanders: [],
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Convert one Host message row into the chat row the panel renders. */
export function toChatMessage(message: CommanderMessage): ChatMessage {
  return {
    id: message.messageId,
    role: message.role,
    text: message.text,
    at: typeof message.at === 'number' ? message.at : 0,
    order: typeof message.order === 'number' ? message.order : 0,
    ...(message.truncated === true ? { truncated: true } : {}),
    ...(typeof message.turnId === 'number' ? { turnId: message.turnId } : {}),
    ...(typeof message.seq === 'number' ? { seq: message.seq } : {}),
  }
}

/**
 * Merge incoming rows into the current chat list, keyed by message id.
 * Incoming rows win (a snapshot or SSE re-delivery replaces the optimistic row
 * carrying the same deterministic `messageId`), then the list is ordered by
 * `order` and trimmed to the newest `limit`.
 */
export function mergeMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
  limit: number = MESSAGE_LIMIT,
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const message of current) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)
  const merged = [...byId.values()].sort(compareMessages)
  return merged.length > limit ? merged.slice(merged.length - limit) : merged
}

/** Stable ordering: Host `order` first, arrival time as the tie-breaker. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.order !== b.order) return a.order - b.order
  if (a.at !== b.at) return a.at - b.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ---------------------------------------------------------------------------
// Snapshot / event application
// ---------------------------------------------------------------------------

/** Apply a full snapshot; snapshots are authoritative for every field but `rev` never regresses. */
export function applySnapshot(state: CommanderState, snapshot: CommanderSnapshot): CommanderState {
  const rev = Math.max(state.rev, numberOr(snapshot.rev, 0))
  const incoming = (snapshot.messages ?? []).map(toChatMessage)
  const binding = snapshot.binding ?? null
  return {
    ...state,
    rev,
    binding,
    commanderStatus: normalizeStatus(snapshot.commanderStatus, binding),
    panel: snapshot.panel === 'present' || snapshot.panel === 'absent' ? snapshot.panel : state.panel,
    counts: { ...(snapshot.counts ?? {}) },
    workspaces: normalizeWorkspaces(snapshot.workspaces),
    tasks: normalizeTasks(snapshot.tasks),
    pendingDispatch: snapshot.pendingDispatch ?? null,
    workSessions: normalizeWorkSessions(snapshot.workSessions),
    ...(snapshot.archiveSummary === undefined ? {} : { archiveSummary: { ...snapshot.archiveSummary } }),
    messages: mergeMessages([], incoming),
    busy: snapshot.commanderBusy === true,
    activity: normalizeActivity(snapshot.commanderActivity),
    lastEventAt: Date.now(),
    rotation: normalizeRotation(snapshot.rotation),
    formerCommanders: normalizeFormerCommanders(snapshot.formerCommanders),
    ...(snapshot.nativeShell === undefined ? {} : { nativeShell: snapshot.nativeShell }),
  }
}

/** One parsed SSE frame. */
export interface SSEFrame {
  event: string
  data: string
  /** `id:` field (the global `rev` for `/commander/state`). */
  id?: string
}

/** Apply one named SSE event; out-of-order revisions are dropped (contract §1.7). */
export function applyEvent(state: CommanderState, frame: SSEFrame): CommanderState {
  const data = parseFrameData(frame.data)
  if (data === undefined) return state
  const rev = frameRev(frame)
  if (frame.event === 'snapshot') {
    return applySnapshot(state, data as unknown as CommanderSnapshot)
  }
  // Drop stale frames: the panel discards `rev <` the highest applied rev.
  if (rev !== undefined && rev < state.rev) return state
  const nextRev = rev !== undefined ? Math.max(state.rev, rev) : state.rev
  const now = Date.now()

  switch (frame.event) {
    case 'commander.message': {
      const message = data as unknown as CommanderMessage
      if (typeof message?.messageId !== 'string' || typeof message.text !== 'string') return state
      if (message.role !== 'user' && message.role !== 'assistant') return state
      return {
        ...state,
        rev: nextRev,
        messages: mergeMessages(state.messages, [toChatMessage(message)]),
        lastEventAt: now,
      }
    }
    case 'commander.status': {
      const payload = data as { busy?: unknown; lastTurnId?: unknown; activity?: unknown }
      return {
        ...state,
        rev: nextRev,
        busy: payload.busy === true,
        lastTurnId: typeof payload.lastTurnId === 'number' ? payload.lastTurnId : state.lastTurnId,
        // Old Hosts omit `activity`; preserve the last value instead of clearing it.
        ...(payload.activity === undefined ? {} : { activity: normalizeActivity(payload.activity) }),
        lastEventAt: now,
      }
    }
    case 'binding.updated': {
      const payload = data as { binding?: CommanderBinding | null; commanderStatus?: string }
      const binding = payload.binding ?? null
      return {
        ...state,
        rev: nextRev,
        binding,
        commanderStatus: normalizeStatus(payload.commanderStatus, binding),
        lastEventAt: now,
      }
    }
    case 'tasks.changed': {
      const payload = data as { counts?: Record<string, number> }
      return { ...state, rev: nextRev, counts: { ...(payload.counts ?? {}) }, lastEventAt: now }
    }
    case 'task.updated': {
      // Contract §8.4 sends `{task, rev}`; the M2 Host also broadcasts the lighter
      // `{taskId, status, rev}` shape (m2m3 patch §2.4), so merge either form.
      const payload = data as { task?: TaskView; taskId?: string; status?: string }
      const incoming: TaskView | undefined = payload.task !== undefined && typeof payload.task.id === 'string'
        ? payload.task
        : typeof payload.taskId === 'string'
          ? { id: payload.taskId, ...(typeof payload.status === 'string' ? { status: payload.status } : {}) }
          : undefined
      if (incoming === undefined) return state
      if (incoming.status === 'archived') {
        return { ...state, rev: nextRev, tasks: state.tasks.filter(task => task.id !== incoming.id), lastEventAt: now }
      }
      const existing = state.tasks.find(task => task.id === incoming.id)
      const merged: TaskView = existing === undefined
        ? incoming
        : {
            ...existing,
            ...incoming,
            ...(incoming.updatedAt === undefined ? { updatedAt: Date.now() } : {}),
          }
      return { ...state, rev: nextRev, tasks: upsertTask(state.tasks, merged), lastEventAt: now }
    }
    case 'rotation.updated': {
      const payload = data as { rotation?: unknown; formerCommanders?: unknown }
      return {
        ...state,
        rev: nextRev,
        rotation: normalizeRotation(payload.rotation),
        formerCommanders: normalizeFormerCommanders(payload.formerCommanders),
        lastEventAt: now,
      }
    }
    case 'dispatch.updated': {
      const payload = data as { pendingDispatch?: PendingDispatchView | null }
      return { ...state, rev: nextRev, pendingDispatch: payload.pendingDispatch ?? null, lastEventAt: now }
    }
    case 'heartbeat': {
      return { ...state, rev: nextRev, lastEventAt: now }
    }
    case 'capability.applied': {
      return { ...state, rev: nextRev, lastEventAt: now }
    }
    case 'bye': {
      return { ...state, connection: 'reconnecting' }
    }
    default: {
      // Unknown event names are ignored without advancing `rev`, so a later
      // known event is never dropped because of a private event we cannot read.
      return state
    }
  }
}

/** Pull the revision out of a frame: explicit `rev` in data, else the `id:` field. */
function frameRev(frame: SSEFrame): number | undefined {
  const data = parseFrameData(frame.data)
  if (data !== undefined && typeof (data as { rev?: unknown }).rev === 'number') {
    return (data as { rev: number }).rev
  }
  if (frame.id === undefined || frame.id === '') return undefined
  const parsed = Number(frame.id)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Parse a frame payload; malformed JSON is ignored rather than thrown. */
export function parseFrameData(data: string): Record<string, unknown> | undefined {
  if (data === '') return undefined
  try {
    const parsed: unknown = JSON.parse(data)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// SSE parser (used by tests and by transports that stream text chunks)
// ---------------------------------------------------------------------------

/** Feed text chunks and receive complete SSE frames (handles CRLF/CR and multi-line data). */
export function createSSEParser(onFrame: (frame: SSEFrame) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    for (;;) {
      const boundary = findBoundary(buffer)
      if (boundary === undefined) return
      const block = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary.length)
      const frame = parseSSEBlock(block)
      if (frame !== undefined) onFrame(frame)
    }
  }
}

function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const candidates = ['\r\n\r\n', '\n\n', '\r\r']
  let best: { index: number; length: number } | undefined
  for (const separator of candidates) {
    const index = buffer.indexOf(separator)
    if (index === -1) continue
    if (best === undefined || index < best.index) best = { index, length: separator.length }
  }
  return best
}

/** Parse one raw SSE block into a frame; comment-only / data-less blocks yield undefined. */
export function parseSSEBlock(block: string): SSEFrame | undefined {
  const lines = block.split(/\r\n|\n|\r/)
  let event = 'message'
  let id: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'id') id = value
    else if (field === 'data') dataLines.push(value)
  }
  if (dataLines.length === 0) return undefined
  const data = dataLines.join('\n')
  if (data === '') return undefined
  return { event, data, ...(id === undefined ? {} : { id }) }
}

// ---------------------------------------------------------------------------
// HTTP transport helpers (browser fetch; no dependency on a client library)
// ---------------------------------------------------------------------------

/** Join a base URL and an absolute `/commander/*` path. */
export function apiUrl(baseUrl: string, path: string): string {
  if (baseUrl === '' || baseUrl === '/') return path
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

/** `fetch` JSON with the contract error envelope; network errors become `internal`. */
export async function requestJson<T>(
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<HttpResult<T>> {
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
  } catch (error) {
    return { ok: false, status: 0, failure: networkFailure(error) }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    return { ok: false, status: response.status, failure: normalizeFailure(payload, response.status) }
  }
  const record = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  if (record.ok === false) {
    return { ok: false, status: response.status, failure: normalizeFailure(payload, response.status) }
  }
  return { ok: true, status: response.status, data: unwrapData<T>(record) }
}

function unwrapData<T>(record: Record<string, unknown>): T {
  // Success envelopes carry `{ok:true, …, rev}`; plain snapshot responses carry
  // `{rev, …}` with no `ok` field. Strip only the envelope flag so `rev` stays.
  const rest: Record<string, unknown> = { ...record }
  delete rest.ok
  return rest as T
}

/** Turn any unknown thrown/failed payload into the contract failure envelope. */
export function normalizeFailure(payload: unknown, status: number): ApiFailure {
  const record = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const code = typeof record.code === 'string' && record.code !== '' ? record.code : httpFallbackCode(status)
  const message = typeof record.message === 'string' && record.message !== '' ? record.message : defaultFailureMessage(code)
  return {
    ok: false,
    code,
    message,
    ...(typeof record.field === 'string' ? { field: record.field } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
  }
}

function networkFailure(error: unknown): ApiFailure {
  const detail = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'network_error', message: `无法连接指挥官服务（${detail}）` }
}

function httpFallbackCode(status: number): string {
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 400) return 'invalid_request'
  if (status === 0) return 'network_error'
  return 'internal'
}

function defaultFailureMessage(code: string): string {
  switch (code) {
    case 'binding_required':
      return '尚未绑定指挥官，请到「设置 → 指挥官」完成绑定'
    case 'binding_broken':
      return '绑定会话已失效，请重新绑定'
    case 'prompt_failed':
      return '消息投递失败，请重试'
    case 'network_error':
      return '无法连接指挥官服务'
    default:
      return `请求失败（${code}）`
  }
}

/** `GET /commander/state` as a plain JSON snapshot. */
export async function fetchSnapshot(baseUrl: string, signal?: AbortSignal): Promise<HttpResult<CommanderSnapshot>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, '/commander/state'),
    signal === undefined ? {} : { signal },
  )
  if (!result.ok) return result
  const data = result.data
  const snapshot = (data.snapshot ?? data) as unknown as CommanderSnapshot
  if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.rev !== 'number') {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '指挥官快照格式不合法' } }
  }
  return { ok: true, status: result.status, data: snapshot }
}

/** `POST /commander/message` (contract §1.3). */
export async function postMessage(
  baseUrl: string,
  text: string,
  requestId: string,
): Promise<HttpResult<{ messageId?: string; sessionId?: string; accepted?: boolean; queued?: boolean; busy?: boolean; rev?: number }>> {
  return requestJson(apiUrl(baseUrl, '/commander/message'), {
    method: 'POST',
    body: { text, requestId, clientTs: Date.now() },
  })
}

/** `POST /commander/rotation` (R1): manual/forced command-session rotation. */
export async function postRotation(
  baseUrl: string,
  force: boolean,
): Promise<HttpResult<RotationResult>> {
  return requestJson(apiUrl(baseUrl, '/commander/rotation'), {
    method: 'POST',
    body: { force, requestId: newRequestId('rot') },
  })
}

/** `PUT /commander/config` (contract §2.2). */
export async function putConfig(baseUrl: string, patch: ConfigPatch): Promise<WriteResult<ConfigView>> {
  const result = await requestJson<Record<string, unknown>>(apiUrl(baseUrl, '/commander/config'), {
    method: 'PUT',
    body: { ...patch, requestId: patch.requestId ?? newRequestId('cfg') },
  })
  if (!result.ok) return result
  return { ok: true, data: (result.data.config ?? result.data) as unknown as ConfigView }
}

/** `PUT /commander/workspaces` (contract §2.3). */
export async function putWorkspaces(baseUrl: string, workspaces: readonly WorkspacePatch[]): Promise<WriteResult<WorkspaceView[]>> {
  const result = await requestJson<Record<string, unknown>>(apiUrl(baseUrl, '/commander/workspaces'), {
    method: 'PUT',
    body: { workspaces, requestId: newRequestId('ws') },
  })
  if (!result.ok) return result
  const rows = Array.isArray(result.data.workspaces) ? (result.data.workspaces as unknown as WorkspaceView[]) : []
  return { ok: true, data: rows }
}

/** `POST /commander/binding` (contract §2.4). */
export async function postBinding(
  baseUrl: string,
  request: { mode: 'new'; workspaceId?: string; cwd?: string; agentPreset?: string } | { mode: 'select'; workspaceId?: string; sessionId: string },
): Promise<WriteResult<{ binding?: CommanderBinding; commanderStatus?: string; rev?: number }>> {
  const result = await requestJson<Record<string, unknown>>(apiUrl(baseUrl, '/commander/binding'), {
    method: 'POST',
    body: { ...request, requestId: newRequestId('bind') },
  })
  if (!result.ok) return result
  return { ok: true, data: result.data as { binding?: CommanderBinding; commanderStatus?: string; rev?: number } }
}

/** Optional probe overrides for `POST /commander/jev/test` (never carries a plaintext key). */
export interface JevTestOptions {
  endpoint?: string
  model?: string
  apiKeyEnv?: string
  timeoutMs?: number
}

/** `POST /commander/jev/test` (M1 connectivity probe; the Host never returns the key). */
export async function postJevTest(baseUrl: string, options: JevTestOptions = {}): Promise<WriteResult<JevTestResult>> {
  const body: Record<string, unknown> = {}
  if (options.endpoint !== undefined && options.endpoint !== '') body.endpoint = options.endpoint
  if (options.model !== undefined && options.model !== '') body.model = options.model
  if (options.apiKeyEnv !== undefined && options.apiKeyEnv !== '') body.apiKeyEnv = options.apiKeyEnv
  if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs
  const result = await requestJson<JevTestResult>(apiUrl(baseUrl, '/commander/jev/test'), { method: 'POST', body })
  if (!result.ok) return result
  return { ok: true, data: result.data }
}

/** Session-list page size for the binding/attach pickers (big workspaces are slow per row). */
export const BINDING_SESSION_LIMIT = 20

/** `GET /commander/sessions?workspaceId=…&limit=20` — sessions for a binding/attach target. */
export async function fetchSessions(baseUrl: string, workspaceId: string): Promise<HttpResult<SessionListResult>> {
  const url = apiUrl(
    baseUrl,
    `/commander/sessions?workspaceId=${encodeURIComponent(workspaceId)}&limit=${String(BINDING_SESSION_LIMIT)}`,
  )
  const result = await requestJson<Record<string, unknown>>(url)
  if (!result.ok) return result
  return { ok: true, status: result.status, data: normalizeSessionList(result.data) }
}

/** Split the sessions payload into rows + the payload-level `truncated` flag. */
export function normalizeSessionList(payload: unknown): SessionListResult {
  const record = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  return {
    sessions: normalizeSessions(record),
    ...(record.truncated === true ? { truncated: true } : {}),
  }
}

/**
 * Normalize the session list tolerantly: the contract names `sessionId/title/
 * lastActiveAt`, but an older/newer Host may use id/name/updatedAt, and the
 * context-water level has no single spelling yet. Unknown rows are dropped,
 * archived rows are hidden, newest activity first.
 */
export function normalizeSessions(payload: unknown): SessionOptionView[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { sessions?: unknown } | undefined)?.sessions)
      ? (payload as { sessions: unknown[] }).sessions
      : []
  const sessions: SessionOptionView[] = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const sessionId = firstString(record.sessionId, record.id, record.session_id)
    if (sessionId === undefined || sessionId === '') continue
    if (record.archived === true) continue
    const title = firstString(record.title, record.name, record.sessionTitle) ?? ''
    const workspaceId = firstString(record.workspaceId)
    const model = firstString(record.model, record.modelName)
    const lastActiveAt = firstNumber(record.lastActiveAt, record.lastActivityAt, record.updatedAt, record.at)
    const createdAt = firstNumber(record.createdAt, record.created_at, record.created)
    const contextPct = contextPctOf(record)
    sessions.push({
      sessionId,
      title,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(model === undefined ? {} : { model }),
      ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(contextPct === undefined ? {} : { contextPct }),
      ...(record.truncated === true ? { truncated: true } : {}),
    })
  }
  sessions.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
  return sessions
}

/** `GET /commander/tasks/:id` — M1 route, stored for the M2 detail drawer. */
export async function fetchTaskDetail(baseUrl: string, taskId: string): Promise<HttpResult<TaskDetailView>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}`),
  )
  if (!result.ok) return result
  return { ok: true, status: result.status, data: normalizeTaskDetail(result.data) }
}

/** Normalize the task-detail payload (arrays default to empty, optional sections stay nullable). */
export function normalizeTaskDetail(payload: unknown): TaskDetailView {
  const record = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const task = record.task
  return {
    ...(task !== null && typeof task === 'object' && typeof (task as TaskView).id === 'string'
      ? { task: task as TaskView }
      : {}),
    acceptance: arrayOfRecords(record.acceptance),
    acceptanceHistory: arrayOfRecords(record.acceptanceHistory) as unknown as NonNullable<TaskDetailView['acceptanceHistory']>,
    reportMaterials: arrayOfRecords(record.reportMaterials) as unknown as NonNullable<TaskDetailView['reportMaterials']>,
    ...(record.pendingInstruction !== null && typeof record.pendingInstruction === 'object'
      ? { pendingInstruction: record.pendingInstruction as NonNullable<TaskDetailView['pendingInstruction']> }
      : {}),
    ...(record.reportSummary !== null && typeof record.reportSummary === 'object'
      ? { reportSummary: record.reportSummary as NonNullable<TaskDetailView['reportSummary']> }
      : {}),
    capabilities: record.capabilities !== null && typeof record.capabilities === 'object'
      ? (record.capabilities as NonNullable<TaskDetailView['capabilities']>)
      : null,
    dispatch: record.dispatch !== null && typeof record.dispatch === 'object'
      ? (record.dispatch as NonNullable<TaskDetailView['dispatch']>)
      : null,
    dispatches: arrayOfRecords(record.dispatches) as unknown as NonNullable<TaskDetailView['dispatches']>,
    timeline: arrayOfRecords(record.timeline),
    sessions: arrayOfRecords(record.sessions),
    boardEdits: arrayOfRecords(record.boardEdits) as BoardEditView[],
    ...(typeof record.archivedAt === 'number' ? { archivedAt: record.archivedAt } : {}),
    ...(typeof record.rev === 'number' ? { rev: record.rev } : {}),
  }
}

/** `PATCH /commander/board/tasks/:id` (human board edit, m2m3 patch §2.4). */
export async function patchBoardTask(
  baseUrl: string,
  taskId: string,
  patch: BoardPatchRequest,
): Promise<HttpResult<BoardPatchResult>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/board/tasks/${encodeURIComponent(taskId)}`),
    { method: 'PATCH', body: patch },
  )
  if (!result.ok) return result
  const record = result.data
  const task = record.task
  return {
    ok: true,
    status: result.status,
    data: {
      ...(task !== null && typeof task === 'object' && typeof (task as TaskView).id === 'string'
        ? { task: task as TaskView }
        : {}),
      ...(record.boardEdit !== null && typeof record.boardEdit === 'object'
        ? { boardEdit: record.boardEdit as NonNullable<BoardPatchResult['boardEdit']> }
        : {}),
      ...(typeof record.rev === 'number' ? { rev: record.rev } : {}),
    },
  }
}

/** `POST /commander/tasks/:id/archive` (m2m3 patch §2.5). */
export async function archiveTask(baseUrl: string, taskId: string): Promise<HttpResult<TaskView>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}/archive`),
    { method: 'POST', body: {} },
  )
  if (!result.ok) return result
  const task = unwrapTask(result.data)
  if (task === undefined) {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '归档响应缺少任务数据' } }
  }
  return { ok: true, status: result.status, data: task }
}

/** `POST /commander/tasks/:id/restore` — archived → draft only (m2m3 patch §2.5). */
export async function restoreTask(baseUrl: string, taskId: string): Promise<HttpResult<TaskView>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}/restore`),
    { method: 'POST', body: {} },
  )
  if (!result.ok) return result
  const task = unwrapTask(result.data)
  if (task === undefined) {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '恢复响应缺少任务数据' } }
  }
  return { ok: true, status: result.status, data: task }
}

/** `POST /commander/tasks/:id/accept` — review→done, human-only; optional handoff note. */
export async function acceptTask(baseUrl: string, taskId: string, note?: string): Promise<HttpResult<TaskView>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}/accept`),
    { method: 'POST', body: note !== undefined && note !== '' ? { note } : {} },
  )
  if (!result.ok) return result
  const task = unwrapTask(result.data)
  if (task === undefined) {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '验收响应缺少任务数据' } }
  }
  return { ok: true, status: result.status, data: task }
}

/** `POST /commander/tasks/:id/cancel` — human-only non-terminal → cancelled; Host stops sessions first. */
export async function cancelTask(baseUrl: string, taskId: string): Promise<HttpResult<TaskView>> {
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}/cancel`),
    { method: 'POST', body: {} },
  )
  if (!result.ok) return result
  const task = unwrapTask(result.data)
  if (task === undefined) {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '取消响应缺少任务数据' } }
  }
  return { ok: true, status: result.status, data: task }
}

/** `POST /commander/tasks/:id/continue` — write the board note + notify the commander (M5). */
export async function reworkTask(baseUrl: string, taskId: string, comment?: string): Promise<HttpResult<TaskView>> {
  const body: Record<string, unknown> = {}
  if (comment !== undefined && comment.trim() !== '') body.comment = comment.trim().slice(0, 1000)
  const result = await requestJson<Record<string, unknown>>(
    apiUrl(baseUrl, `/commander/tasks/${encodeURIComponent(taskId)}/continue`),
    { method: 'POST', body },
  )
  if (!result.ok) return result
  const task = unwrapTask(result.data)
  if (task === undefined) {
    return { ok: false, status: result.status, failure: { ok: false, code: 'internal', message: '返工响应缺少任务数据' } }
  }
  return { ok: true, status: result.status, data: task }
}

/** `GET /commander/archive` — 回收站列表（m2m3 patch §2.5.1；只读）。 */
export async function fetchArchive(baseUrl: string, options: ArchiveQuery = {}): Promise<HttpResult<ArchiveListResult>> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit ?? 50))
  if (options.cursor !== undefined && options.cursor !== null) params.set('cursor', String(options.cursor))
  if (options.q !== undefined && options.q.trim() !== '') params.set('q', options.q.trim())
  if (options.status !== undefined) params.set('status', options.status)
  if (options.workspaceId !== undefined && options.workspaceId !== '') params.set('workspaceId', options.workspaceId)
  if (options.from !== undefined) params.set('from', String(options.from))
  if (options.to !== undefined) params.set('to', String(options.to))
  const result = await requestJson<Record<string, unknown>>(apiUrl(baseUrl, `/commander/archive?${params.toString()}`))
  if (!result.ok) return result
  const rows = Array.isArray(result.data.tasks) ? (result.data.tasks as unknown[]) : []
  const summaryRaw = result.data.summary
  const summary = summaryRaw !== null && typeof summaryRaw === 'object'
    ? {
        archivedCount: numberOrZero((summaryRaw as Record<string, unknown>).archivedCount),
        cancelledCount: numberOrZero((summaryRaw as Record<string, unknown>).cancelledCount),
        last30dCount: numberOrZero((summaryRaw as Record<string, unknown>).last30dCount),
      }
    : undefined
  const months = Array.isArray(result.data.months)
    ? (result.data.months as unknown[])
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>).key === 'string')
        .map((row) => ({ key: row.key as string, count: numberOrZero(row.count) }))
    : undefined
  return {
    ok: true,
    status: result.status,
    data: {
      tasks: rows.filter((row): row is TaskView => row !== null && typeof row === 'object' && typeof (row as TaskView).id === 'string'),
      ...(typeof result.data.nextCursor === 'number' || typeof result.data.nextCursor === 'string' || result.data.nextCursor === null
        ? { nextCursor: result.data.nextCursor as number | string | null }
        : {}),
      ...(typeof result.data.total === 'number' ? { total: result.data.total } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(months !== undefined ? { months } : {}),
    },
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function unwrapTask(record: Record<string, unknown>): TaskView | undefined {
  const candidate = record.task ?? record
  if (candidate !== null && typeof candidate === 'object' && typeof (candidate as TaskView).id === 'string') {
    return candidate as TaskView
  }
  return undefined
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
    : []
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/** Read the context level from the contract field (`contextUsage`) or legacy spellings. */
export function contextPctOf(record: Record<string, unknown>): number | undefined {
  const direct = normalizeContextPct(firstNumber(
    record.contextUsagePct, record.contextLevelPct, record.contextPct, record.contextPercent,
  ))
  if (direct !== undefined) return direct
  const usage = record.contextUsage
  if (typeof usage === 'number') return normalizeContextPct(usage)
  if (usage !== null && typeof usage === 'object') {
    const nested = usage as Record<string, unknown>
    const fromNested = normalizeContextPct(firstNumber(
      nested.pct, nested.percent, nested.contextPct, nested.contextUsagePct,
    ) ?? tokenRatio(nested))
    if (fromNested !== undefined) return fromNested
  }
  return normalizeContextPct(tokenRatio(record))
}

/** Session-list context level: accept 0..1 ratios or 0..100 percentages. */
export function normalizeContextPct(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  const pct = value <= 1 ? value * 100 : value
  return Math.min(Math.round(pct), 100)
}

function tokenRatio(record: Record<string, unknown>): number | undefined {
  const used = firstNumber(record.usedTokens, record.contextTokens)
  const total = firstNumber(record.contextWindowTokens, record.maxTokens)
  if (used === undefined || total === undefined || total <= 0) return undefined
  return used / total
}

/** Mint a request id matching `[A-Za-z0-9_-]{8,64}`. */
export function newRequestId(prefix: string): string {
  const random = randomToken(12)
  const time = Date.now().toString(36)
  return `req_${prefix}_${time}_${random}`.slice(0, 64)
}

function randomToken(length: number): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const cryptoObject = typeof globalThis.crypto === 'object' && globalThis.crypto !== null ? globalThis.crypto : undefined
  const bytes = new Uint8Array(length)
  if (cryptoObject !== undefined && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  let token = ''
  for (const byte of bytes) token += alphabet[byte % alphabet.length]
  return token
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Normalize `commanderActivity`; unusable payloads show nothing rather than stale/empty text. */
function normalizeActivity(value: unknown): CommanderActivity | null {
  if (typeof value !== 'object' || value === null) return null
  const text = (value as { text?: unknown }).text
  if (typeof text !== 'string' || text.trim() === '') return null
  const at = (value as { at?: unknown }).at
  return { text: text.trim(), at: typeof at === 'number' && Number.isFinite(at) ? at : 0 }
}

/** Map the Host status string onto the three states the header pill renders. */
export function normalizeStatus(status: unknown, binding: CommanderBinding | null): CommanderStatus {
  if (status === 'bound' || status === 'unbound' || status === 'broken') return status
  if (status === 'rebound') return 'bound'
  // A status the client does not know is surfaced as unknown instead of being
  // guessed from the binding.
  if (typeof status === 'string' && status !== '') return 'unknown'
  if (binding?.sessionId !== undefined && binding.sessionId !== '') return 'bound'
  return binding === null ? 'unbound' : 'unknown'
}

function normalizeWorkspaces(workspaces: WorkspaceView[] | undefined): WorkspaceView[] {
  if (!Array.isArray(workspaces)) return []
  return workspaces
    .filter((row): row is WorkspaceView => row !== null && typeof row === 'object' && typeof row.id === 'string')
    .map((row): WorkspaceView => ({ ...row, allowed: row.allowed === true, policy: row.policy === 'auto' ? 'auto' : 'inherit' }))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
}

function normalizeWorkSessions(rows: WorkSessionView[] | undefined): WorkSessionView[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is WorkSessionView =>
    row !== null && typeof row === 'object' && typeof row.sessionId === 'string' && typeof row.taskId === 'string')
}

function normalizeTasks(tasks: TaskView[] | undefined): TaskView[] {
  if (!Array.isArray(tasks)) return []
  return tasks.filter((row): row is TaskView => row !== null && typeof row === 'object' && typeof row.id === 'string')
}

/** Upsert one task row and keep the snapshot's `updatedAt` descending order. */
export function upsertTask(tasks: readonly TaskView[], task: TaskView): TaskView[] {
  const next = tasks.filter(row => row.id !== task.id)
  next.push(task)
  next.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return next
}

/** Clamp a normalized entry point to 0..1, or undefined when unusable. */
export function normalizeEntryPos(value: unknown): EntryPosition | null | undefined {
  if (value === null) return null
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { x?: unknown; y?: unknown }
  if (typeof record.x !== 'number' || !Number.isFinite(record.x)) return undefined
  if (typeof record.y !== 'number' || !Number.isFinite(record.y)) return undefined
  return { x: Math.min(Math.max(record.x, 0), 1), y: Math.min(Math.max(record.y, 0), 1) }
}

/** Merge a config response into the UI preferences the store mirrors. */
export function mergeUiConfig(current: UiConfig, next: ConfigView | undefined): UiConfig {
  const theme = next?.ui?.theme
  const entryPosition = next?.ui?.entryPosition
  const entryEnabled = next?.ui?.entryEnabled
  const entryPos = normalizeEntryPos(next?.ui?.entryPos)
  return {
    theme: theme === 'light' || theme === 'dark' || theme === 'follow' ? theme : current.theme ?? 'follow',
    entryPosition: entryPosition === 'bl' || entryPosition === 'br' ? entryPosition : current.entryPosition ?? 'br',
    entryEnabled: typeof entryEnabled === 'boolean' ? entryEnabled : current.entryEnabled !== false,
    entryPos: entryPos !== undefined ? entryPos : current.entryPos ?? null,
  }
}

/** Default view of the Jev segment used to seed the settings form. */
export function defaultJevConfig(): { endpoint: string; model: string; apiKeyEnv: string; workspaceThreshold: number; sessionThreshold: number; timeoutMs: number; autoDispatch: boolean } {
  return {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    workspaceThreshold: 0.8,
    sessionThreshold: 0.8,
    timeoutMs: 1500,
    autoDispatch: false,
  }
}

// ---------------------------------------------------------------------------
// R1 rotation normalisation (defensive: unknown Host payloads are ignored)
// ---------------------------------------------------------------------------

/** Normalise `state.rotation`; returns null when the payload is unusable. */
export function normalizeRotation(value: unknown): RotationView | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.enabled !== 'boolean') return null
  const lastError = raw.lastError
  return {
    enabled: raw.enabled,
    periodDays: numberOr(raw.periodDays, 1),
    includeUserTail: raw.includeUserTail !== false,
    generation: numberOr(raw.generation, 1),
    startedAt: numberOr(raw.startedAt, 0),
    dueAt: numberOr(raw.dueAt, 0),
    due: raw.due === true,
    rotating: raw.rotating === true,
    ...(typeof lastError === 'object' && lastError !== null && typeof (lastError as { code?: unknown }).code === 'string'
      ? {
          lastError: {
            code: (lastError as { code: string }).code,
            message: typeof (lastError as { message?: unknown }).message === 'string' ? (lastError as { message: string }).message : '',
            at: numberOr((lastError as { at?: unknown }).at, 0),
          },
        }
      : {}),
  }
}

/** Normalise `state.formerCommanders` (drops malformed rows, caps at 10). */
export function normalizeFormerCommanders(value: unknown): FormerCommander[] {
  if (!Array.isArray(value)) return []
  const rows: FormerCommander[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.sessionId !== 'string' || raw.sessionId === '') continue
    rows.push({
      sessionId: raw.sessionId,
      generation: numberOr(raw.generation, 1),
      startedAt: numberOr(raw.startedAt, 0),
      retiredAt: numberOr(raw.retiredAt, 0),
    })
  }
  return rows.slice(0, 10)
}
