/**
 * Commander client store: one observable view over the Host snapshot + SSE
 * stream, plus the write actions the overlay and the settings page share.
 *
 * Transport contract: docs/architecture/m0-contract-patch.md §1
 * (POST /commander/message + SSE commander.message/commander.status, snapshot
 * first frame, 3s polling degradation) and §2 (settings write routes).
 */
import type { HostObservable } from './types'
import type {
  ApiFailure, ArchiveListResult, BindingRequest, BoardPatchRequest, BoardPatchResult, ChatMessage, ConfigPatch, ConfigView,
  ConnectionPhase, EntryPosition, JevTestResult, RotationResult, SendResult, SessionListResult, TaskDetailView, TaskView, UiConfig, WorkspacePatch,
  WorkspaceView, WriteResult,
} from './types'
import {
  MESSAGE_MAX_CHARS, POLL_INTERVAL_MS, apiUrl, applyEvent, applySnapshot, createInitialState, fetchSnapshot,
  acceptTask as requestAcceptTask, archiveTask as requestArchiveTask, cancelTask as requestCancelTask, fetchArchive, fetchSessions, fetchTaskDetail,
  mergeMessages, mergeUiConfig,
  newRequestId, normalizeFailure, patchBoardTask as requestBoardPatch, postBinding, postJevTest, postMessage, postRotation, putConfig,
  putWorkspaces, requestJson, restoreTask as requestRestoreTask, reworkTask as requestReworkTask, upsertTask,
} from './state'
import type { CommanderState, JevTestOptions, SSEFrame } from './state'

/** How long an EventSource may stay silent before we degrade to polling. */
const SSE_OPEN_TIMEOUT_MS = 8_000

/**
 * 半开连接的看门狗：Host 每 15s 发一次 heartbeat，连续 45s 收不到任何帧就判定流已死，
 * 主动降级为轮询并从 Host 重新对齐状态（否则卡片/消息会永远停在旧状态，2026-11-18 用户反馈）。
 */
const SSE_IDLE_TIMEOUT_MS = 45_000
const SSE_IDLE_CHECK_MS = 5_000

/** Consecutive polling failures tolerated before the header reads `offline`. */
const POLL_FAILURES_BEFORE_OFFLINE = 3

/** Minimum time between two SSE re-attempts from the polling loop. */
const SSE_RETRY_INTERVAL_MS = 30_000

/** Local notice the overlay/settings render (errors and save confirmations). */
export interface CommanderNotice {
  kind: 'ok' | 'error'
  text: string
  code?: string
  /** Set when the notice is a settings-write failure worth surfacing inline. */
  field?: string
}

/** The single React-visible snapshot of the commander store. */
export interface CommanderView extends CommanderState {
  /** A `POST /commander/message` request is in flight (send button disabled). */
  sending: boolean
  /** Last result worth showing to the user. */
  notice: CommanderNotice | null
  /** Last config view read back from the Host (best effort; M0 may be absent). */
  config: ConfigView | null
  configLoaded: boolean
}

/** Store construction options: the transport is injected so tests can fake it. */
export interface CommanderStoreOptions {
  /** Same-origin prefix; empty means the document origin. */
  baseUrl?: string
}

/** Public face the Client bundle injects into both slot entries. */
export interface CommanderStore extends HostObservable<CommanderView> {
  start(): void
  dispose(): void
  refresh(): Promise<void>
  send(text: string): Promise<SendResult>
  saveConfig(patch: ConfigPatch): Promise<WriteResult<ConfigView>>
  saveWorkspaces(rows: readonly WorkspacePatch[]): Promise<WriteResult<WorkspaceView[]>>
  bind(request: BindingRequest): Promise<WriteResult<{ binding?: unknown; commanderStatus?: string }>>
  loadConfig(): Promise<void>
  /** `POST /commander/jev/test` — server-side probe; never carries the key. */
  testJev(options?: JevTestOptions): Promise<WriteResult<JevTestResult>>
  /** Existing sessions of one workspace for the custom attach picker. */
  listSessions(workspaceId: string): Promise<WriteResult<SessionListResult>>
  /** `GET /commander/tasks/:id` — M2 board card detail drawer. */
  getTaskDetail(taskId: string): Promise<WriteResult<TaskDetailView>>
  /** `PATCH /commander/board/tasks/:id` — optimistic, rolls back on failure. */
  patchBoardTask(taskId: string, patch: BoardPatchRequest): Promise<WriteResult<BoardPatchResult>>
  /** `POST /commander/tasks/:id/archive`. */
  archiveTask(taskId: string): Promise<WriteResult<TaskView>>
  /** `POST /commander/tasks/:id/restore` (archived → draft). */
  restoreTask(taskId: string): Promise<WriteResult<TaskView>>
  /** `POST /commander/tasks/:id/accept` — human-only review→done. */
  acceptTask(taskId: string): Promise<WriteResult<TaskView>>
  /** `POST /commander/tasks/:id/cancel` — human-only non-terminal → cancelled. */
  cancelTask(taskId: string): Promise<WriteResult<TaskView>>
  /** `POST /commander/tasks/:id/rework` — human-only review→running with a comment. */
  reworkTask(taskId: string, comment?: string): Promise<WriteResult<TaskView>>
  /** `GET /commander/archive?limit=` — trash list. */
  loadArchive(): Promise<WriteResult<ArchiveListResult>>
  /** R1：`POST /commander/rotation` — 手动/立即换任（force=true 跳过周期与活动判定）。 */
  rotateCommander(force?: boolean): Promise<WriteResult<RotationResult>>
  clearNotice(): void
  /** 浮窗拖动结束后保存归一化位置（null = 回到默认角落）；本地先动，Host 失败只提示不阻塞。 */
  saveEntryPos(position: EntryPosition | null): Promise<void>
}

/** The mutable parts of the view that do not come from a snapshot. */
type Extra = Pick<CommanderView, 'sending' | 'notice' | 'config' | 'configLoaded'>

/** Create the commander store; call `start()` inside the plugin effect. */
export function createCommanderStore(options: CommanderStoreOptions = {}): CommanderStore {
  const baseUrl = options.baseUrl ?? ''
  const listeners = new Set<() => void>()
  let state = createInitialState()
  let extra: Extra = { sending: false, notice: null, config: null, configLoaded: false }
  let view: CommanderView = { ...state, ...extra }
  let disposed = false
  let started = false
  let eventSource: EventSource | null = null
  let openTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let pollBusy = false
  let pollFailures = 0
  let refreshController: AbortController | undefined
  let lastStreamAttemptAt = 0
  let idleTimer: ReturnType<typeof setInterval> | undefined

  function notify(): void {
    view = { ...state, ...extra }
    for (const listener of listeners) listener()
  }

  function publish(nextState: CommanderState, nextExtra?: Partial<Extra>): void {
    state = nextState
    if (nextExtra !== undefined) extra = { ...extra, ...nextExtra }
    notify()
  }

  function patchState(patch: Partial<CommanderState>): void {
    publish({ ...state, ...patch })
  }

  function notice(kind: CommanderNotice['kind'], text: string, failure?: ApiFailure): void {
    extra = {
      ...extra,
      notice: {
        kind,
        text,
        ...(failure?.code === undefined ? {} : { code: failure.code }),
        ...(failure?.field === undefined ? {} : { field: failure.field }),
      },
    }
    notify()
  }

  /**
   * Apply a snapshot but keep optimistic rows still waiting for their Host echo.
   * A snapshot can race a `POST /commander/message`; dropping the pending row
   * would make the just-sent text flicker out of the transcript.
   */
  function applySnapshotKeepingPending(next: CommanderState, snapshot: Parameters<typeof applySnapshot>[1]): CommanderState {
    const base = applySnapshot(next, snapshot)
    const echoed = new Set((snapshot.messages ?? []).map(message => message.messageId))
    const pending = next.messages.filter(message => message.pending === true && !echoed.has(message.id))
    if (pending.length === 0) return base
    return { ...base, messages: mergeMessages(base.messages, pending) }
  }

  // -- snapshot refresh -----------------------------------------------------

  async function refresh(): Promise<void> {
    if (disposed) return
    refreshController?.abort()
    const controller = new AbortController()
    refreshController = controller
    const result = await fetchSnapshot(baseUrl, controller.signal)
    if (disposed || result.ok === false) return
    publish(applySnapshotKeepingPending(state, result.data))
  }

  // -- SSE ------------------------------------------------------------------

  function hasSSE(): boolean {
    return typeof EventSource !== 'undefined'
  }

  function startStream(): void {
    if (disposed) return
    if (!hasSSE()) {
      startPolling()
      return
    }
    stopStream()
    lastStreamAttemptAt = Date.now()
    patchState({ connection: 'connecting' })
    let source: EventSource
    try {
      source = new EventSource(apiUrl(baseUrl, '/commander/state'))
    } catch {
      startPolling()
      return
    }
    eventSource = source
    let sawFrame = false
    const names = [
      'snapshot', 'commander.message', 'commander.status', 'heartbeat', 'binding.updated',
      'task.updated', 'tasks.changed', 'dispatch.updated', 'capability.applied', 'rotation.updated', 'bye',
    ]
    const onFrame = (name: string) => (event: Event): void => {
      if (disposed || eventSource !== source) return
      sawFrame = true
      clearOpenTimer()
      pollFailures = 0
      stopPolling()
      const messageEvent = event as MessageEvent<string>
      const frame: SSEFrame = {
        event: name,
        data: typeof messageEvent.data === 'string' ? messageEvent.data : '',
        ...(typeof messageEvent.lastEventId === 'string' && messageEvent.lastEventId !== ''
          ? { id: messageEvent.lastEventId }
          : {}),
      }
      const previousGeneration = state.rotation?.generation
      const next = applyEvent(state, frame)
      // R1：交接完成时给面板一条系统提示（不重复渲染简报）。
      if (
        name === 'rotation.updated' &&
        next.rotation !== null &&
        next.rotation.rotating === false &&
        typeof previousGeneration === 'number' &&
        next.rotation.generation > previousGeneration
      ) {
        notice('ok', `已换任到第 ${next.rotation.generation} 任`)
      }
      if (name === 'bye') {
        stopStream()
        publish({ ...next, connection: 'reconnecting' })
        startPolling()
        return
      }
      publish({ ...next, connection: 'live' })
    }
    for (const name of names) source.addEventListener(name, onFrame(name))
    source.addEventListener('error', () => {
      if (disposed || eventSource !== source) return
      const readyState: number = source.readyState
      if (readyState === 2 /* EventSource.CLOSED */) {
        stopStream()
        startPolling()
        return
      }
      // The browser retries by itself; refresh the snapshot now so a reconnect
      // does not depend on Last-Event-ID replay (implementation-plan §8.4).
      patchState({ connection: 'reconnecting' })
      void refresh()
    })
    openTimer = setTimeout(() => {
      if (disposed || sawFrame || eventSource !== source) return
      stopStream()
      startPolling()
    }, SSE_OPEN_TIMEOUT_MS)
  }

  function checkStreamIdle(): void {
    if (disposed || eventSource === null) return
    if (Date.now() - state.lastEventAt <= SSE_IDLE_TIMEOUT_MS) return
    // 浏览器对半开连接不报错也不重连：关掉流、切轮询（轮询的 snapshot 会带回最新 pending/messages）。
    stopStream()
    startPolling()
  }

  function stopStream(): void {
    clearOpenTimer()
    if (eventSource !== null) {
      try {
        eventSource.close()
      } catch {
        // Closing an already-failed EventSource is harmless.
      }
      eventSource = null
    }
  }

  function clearOpenTimer(): void {
    if (openTimer !== undefined) {
      clearTimeout(openTimer)
      openTimer = undefined
    }
  }

  // -- polling degradation --------------------------------------------------

  function startPolling(): void {
    if (disposed || pollTimer !== undefined) return
    patchState({ connection: 'polling' })
    pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)
    void pollOnce()
  }

  function stopPolling(): void {
    if (pollTimer === undefined) return
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  async function pollOnce(): Promise<void> {
    if (disposed || pollBusy) return
    pollBusy = true
    try {
      const result = await fetchSnapshot(baseUrl)
      if (disposed) return
      if (result.ok === false) {
        pollFailures += 1
        if (pollFailures >= POLL_FAILURES_BEFORE_OFFLINE) patchState({ connection: 'offline' })
        return
      }
      pollFailures = 0
      publish({ ...applySnapshotKeepingPending(state, result.data), connection: 'polling' })
      // A healthy HTTP read is a good moment to retry the stream.
      if (hasSSE() && eventSource === null && Date.now() - lastStreamAttemptAt >= SSE_RETRY_INTERVAL_MS) startStream()
    } finally {
      pollBusy = false
    }
  }

  // -- actions --------------------------------------------------------------

  async function send(text: string): Promise<SendResult> {
    const trimmed = text.trim()
    if (trimmed === '') {
      return { ok: false, failure: { ok: false, code: 'invalid_request', message: '消息不能为空', field: 'text' } }
    }
    if (trimmed.length > MESSAGE_MAX_CHARS) {
      return {
        ok: false,
        failure: { ok: false, code: 'invalid_request', message: `消息超过 ${MESSAGE_MAX_CHARS} 字符上限`, field: 'text' },
      }
    }
    const requestId = newRequestId('msg')
    const optimistic: ChatMessage = {
      id: requestId,
      role: 'user',
      text: trimmed,
      at: Date.now(),
      order: nextLocalOrder(),
      pending: true,
    }
    publish(
      { ...state, messages: mergeMessages(state.messages, [optimistic]) },
      { sending: true, notice: null },
    )

    const result = await postMessage(baseUrl, trimmed, requestId)
    if (disposed) return { ok: false, failure: { ok: false, code: 'internal', message: '面板已关闭' } }
    if (result.ok) {
      // The Host echoed it (SSE) or already holds it (snapshot); the optimistic
      // row keeps its id (= requestId) and simply stops reading as pending.
      publish({
        ...state,
        messages: state.messages.map(message => (message.id === requestId ? { ...message, pending: false } : message)),
      }, { sending: false })
      return {
        ok: true,
        messageId: typeof result.data.messageId === 'string' ? result.data.messageId : requestId,
        ...(typeof result.data.sessionId === 'string' ? { sessionId: result.data.sessionId } : {}),
        ...(result.data.queued === true ? { queued: true } : {}),
        ...(result.data.busy === true ? { busy: true } : {}),
      }
    }

    // The Host route is the only send channel (M0 contract patch §1.3). A 404/405
    // means the installed Host half predates the route: there is no Client-side
    // direct-prompt fallback (Lead ruling H3) — surface an upgrade error instead.
    if (result.status === 404 || result.status === 405) {
      const mismatch: ApiFailure = {
        ok: false,
        code: 'route_missing',
        message: 'Host/插件版本不匹配，请升级 dsh-commander 后重启 DSH',
      }
      removeMessage(requestId)
      publish(state, { sending: false })
      notice('error', mismatch.message, mismatch)
      return { ok: false, failure: mismatch }
    }

    removeMessage(requestId)
    publish(state, { sending: false })
    notice('error', result.failure.message, result.failure)
    return { ok: false, failure: result.failure }
  }

  function nextLocalOrder(): number {
    const orders = state.messages.map(message => message.order)
    return orders.length === 0 ? 1 : Math.max(...orders) + 1
  }

  function removeMessage(id: string): void {
    const remaining = state.messages.filter(message => message.id !== id)
    if (remaining.length !== state.messages.length) publish({ ...state, messages: remaining })
  }

  async function saveConfig(patch: ConfigPatch): Promise<WriteResult<ConfigView>> {
    const result = await putConfig(baseUrl, patch)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    extra = { ...extra, config: { ...(extra.config ?? {}), ...result.data } }
    publish({ ...state, ui: mergeUiConfig(state.ui, result.data) })
    notice('ok', '设置已保存')
    return result
  }

  async function saveWorkspaces(rows: readonly WorkspacePatch[]): Promise<WriteResult<WorkspaceView[]>> {
    const result = await putWorkspaces(baseUrl, rows)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    if (result.data.length > 0) publish({ ...state, workspaces: result.data })
    notice('ok', '工作区配置已保存')
    return result
  }

  async function bind(request: BindingRequest): Promise<WriteResult<{ binding?: unknown; commanderStatus?: string }>> {
    const result = await postBinding(baseUrl, request)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    await refresh()
    notice('ok', '指挥官会话已绑定')
    return result
  }

  async function loadConfig(): Promise<void> {
    const result = await requestJson<Record<string, unknown>>(apiUrl(baseUrl, '/commander/config'))
    if (disposed) return
    if (result.ok === false) {
      // M0 contract patch has no GET route yet; treat it as "unknown, keep the
      // form defaults" instead of an error the user must see.
      extra = { ...extra, configLoaded: true }
      notify()
      return
    }
    const payload = result.data
    const config = (payload.config ?? payload) as ConfigView
    extra = { ...extra, config, configLoaded: true }
    publish({ ...state, ui: mergeUiConfig(state.ui, config) })
  }

  async function testJev(options: JevTestOptions = {}): Promise<WriteResult<JevTestResult>> {
    const result = await postJevTest(baseUrl, options)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    notice('ok', 'Jev 连接测试完成')
    return result
  }

  async function listSessions(workspaceId: string): Promise<WriteResult<SessionListResult>> {
    return fetchSessions(baseUrl, workspaceId)
  }

  async function getTaskDetail(taskId: string): Promise<WriteResult<TaskDetailView>> {
    return fetchTaskDetail(baseUrl, taskId)
  }

  /** Apply the optimistic board field locally; returns the previous snapshot row. */
  function applyBoardFieldLocally(taskId: string, patch: BoardPatchRequest): TaskView | undefined {
    const before = state.tasks.find(task => task.id === taskId)
    if (before === undefined) return undefined
    const updated: TaskView = {
      ...before,
      ...(patch.field === 'priority' ? { priority: patch.value } : {}),
      ...(patch.field === 'title' ? { title: patch.value } : {}),
      updatedAt: Date.now(),
    }
    publish({ ...state, tasks: upsertTask(state.tasks, updated) })
    return before
  }

  function rollbackBoardField(before: TaskView | undefined): void {
    if (before === undefined) return
    publish({ ...state, tasks: upsertTask(state.tasks, before) })
  }

  async function patchBoardTask(taskId: string, patch: BoardPatchRequest): Promise<WriteResult<BoardPatchResult>> {
    // Optimistic update first; the Host is the authority and may still reject it.
    const before = applyBoardFieldLocally(taskId, patch)
    const result = await requestBoardPatch(baseUrl, taskId, patch)
    if (result.ok === false) {
      rollbackBoardField(before)
      const failure = result.status === 404 || result.status === 405
        ? { ok: false as const, code: 'route_missing', message: '看板接口不可用（请升级 dsh-commander Host 后重试）' }
        : result.failure
      notice('error', failure.message, failure)
      return { ok: false, failure }
    }
    if (result.data.task !== undefined) {
      publish({ ...state, tasks: upsertTask(state.tasks, result.data.task) })
    }
    return { ok: true, data: result.data }
  }

  async function archiveTask(taskId: string): Promise<WriteResult<TaskView>> {
    const result = await requestArchiveTask(baseUrl, taskId)
    if (result.ok === false) {
      const failure = result.status === 404 || result.status === 405
        ? { ok: false as const, code: 'route_missing', message: '归档接口不可用（请升级 dsh-commander Host 后重试）' }
        : result.failure
      notice('error', failure.message, failure)
      return { ok: false, failure }
    }
    publish({ ...state, tasks: state.tasks.filter(task => task.id !== taskId) })
    notice('ok', '任务已归档')
    return { ok: true, data: result.data }
  }

  async function restoreTask(taskId: string): Promise<WriteResult<TaskView>> {
    const result = await requestRestoreTask(baseUrl, taskId)
    if (result.ok === false) {
      const failure = result.status === 404 || result.status === 405
        ? { ok: false as const, code: 'route_missing', message: '恢复接口不可用（请升级 dsh-commander Host 后重试）' }
        : result.failure
      notice('error', failure.message, failure)
      return { ok: false, failure }
    }
    publish({ ...state, tasks: upsertTask(state.tasks, result.data) })
    notice('ok', '任务已从回收站恢复为 draft')
    return { ok: true, data: result.data }
  }

  async function loadArchive(): Promise<WriteResult<ArchiveListResult>> {
    return fetchArchive(baseUrl)
  }

  async function acceptTask(taskId: string): Promise<WriteResult<TaskView>> {
    const result = await requestAcceptTask(baseUrl, taskId)
    if (result.ok === false) {
      const failure = result.status === 404 || result.status === 405
        ? { ok: false as const, code: 'route_missing', message: '验收接口不可用（请升级 dsh-commander Host 后重试）' }
        : result.failure
      notice('error', failure.message, failure)
      return { ok: false, failure }
    }
    publish({ ...state, tasks: upsertTask(state.tasks, result.data) })
    notice('ok', '验收通过，任务已置为 done')
    return { ok: true, data: result.data }
  }

  async function cancelTask(taskId: string): Promise<WriteResult<TaskView>> {
    const result = await requestCancelTask(baseUrl, taskId)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    publish({ ...state, tasks: upsertTask(state.tasks, result.data) })
    notice('ok', '任务已取消')
    return { ok: true, data: result.data }
  }

  async function rotateCommander(force = false): Promise<WriteResult<RotationResult>> {
    const result = await postRotation(baseUrl, force)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    await refresh()
    if (result.data.rotated) notice('ok', `已换任到第 ${result.data.generation ?? ''} 任`)
    else if (result.data.reason === 'no_activity') notice('ok', '本任没有活动，未换任')
    else notice('ok', '还没到轮换时间')
    return { ok: true, data: result.data as RotationResult }
  }

  async function reworkTask(taskId: string, comment?: string): Promise<WriteResult<TaskView>> {
    const result = await requestReworkTask(baseUrl, taskId, comment)
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return result
    }
    publish({ ...state, tasks: upsertTask(state.tasks, result.data) })
    notice('ok', '已通知指挥官继续派发')
    return { ok: true, data: result.data }
  }

  function clearNotice(): void {
    if (extra.notice === null) return
    extra = { ...extra, notice: null }
    notify()
  }

  async function saveEntryPos(position: EntryPosition | null): Promise<void> {
    // 乐观：先让浮窗停在松手的位置，再写 Host；失败时保留本地位置并提示一次。
    publish({ ...state, ui: { ...state.ui, entryPos: position } })
    const result = await putConfig(baseUrl, { ui: { entryPos: position } })
    if (disposed) return
    if (result.ok === false) {
      notice('error', result.failure.message, result.failure)
      return
    }
    extra = { ...extra, config: { ...(extra.config ?? {}), ...result.data } }
    publish({ ...state, ui: mergeUiConfig(state.ui, result.data) })
  }

  // -- lifecycle ------------------------------------------------------------

  function start(): void {
    if (started || disposed) return
    started = true
    patchState({ connection: 'connecting' })
    void refresh()
    startStream()
    idleTimer = setInterval(checkStreamIdle, SSE_IDLE_CHECK_MS)
    // 首屏就要知道浮窗是否启用/上次拖到哪（配置 GET 是只读加法路由，失败按默认值继续）。
    void loadConfig()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    stopStream()
    stopPolling()
    if (idleTimer !== undefined) clearInterval(idleTimer)
    idleTimer = undefined
    refreshController?.abort()
    refreshController = undefined
    listeners.clear()
  }

  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start,
    dispose,
    refresh,
    send,
    saveConfig,
    saveWorkspaces,
    bind,
    loadConfig,
    testJev,
    listSessions,
    getTaskDetail,
    patchBoardTask,
    archiveTask,
    restoreTask,
    loadArchive,
    acceptTask,
    cancelTask,
    reworkTask,
    rotateCommander,
    clearNotice,
    saveEntryPos,
  }
}

/** Human-readable connection label for the panel footer. */
export function connectionLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'live':
      return '实时同步'
    case 'polling':
      return '轮询同步'
    case 'reconnecting':
      return '重连中'
    case 'offline':
      return '离线'
    case 'connecting':
      return '连接中'
    default:
      return '未连接'
  }
}

/** Map a failed write's error code onto the guidance copy the panel shows. */
export function failureGuidance(code: string | undefined): string {
  switch (code) {
    case 'binding_required':
      return '尚未绑定指挥官，请到「设置 → 指挥官」完成绑定'
    case 'binding_broken':
      return '绑定会话已失效，请重新绑定'
    case 'prompt_failed':
      return '指挥官暂时无法接收消息，请重试'
    case 'route_missing':
      return 'Host/插件版本不匹配，请升级 dsh-commander 后重启 DSH'
    case 'network_error':
      return '无法连接指挥官服务，请检查 DSH 是否在运行'
    default:
      return ''
  }
}

export { normalizeFailure }
