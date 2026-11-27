/**
 * Local client-side type declarations for the DSH Commander Client bundle.
 *
 * The bundle is zero-runtime-dependency: it never imports an `@deepseek-ai/*`
 * package as a value (the browser module table supplies only `react` /
 * `react-dom` / `react/jsx-runtime`). The handful of Cordis/slot/locale shapes
 * the Client half touches are therefore declared here, following the installed
 * DSH contracts (`@deepseek-ai/dsh-client-ui-layout` shell.overlay,
 * `@deepseek-ai/dsh-client-ui-settings` settings.section).
 */
import type { ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Minimal Cordis client context (the subset this bundle uses)
// ---------------------------------------------------------------------------

/** Observable face the slot renderer accepts as an injected hook source. */
export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** Disposer returned by every registration. */
export type Disposer = () => void

/** Options accepted by `ctx.slots.register` for the slots this bundle uses. */
export interface SlotRegistrationOptions {
  /** Slot name, e.g. `shell.overlay` or `settings.section`. */
  name: string
  /** Stable entry id inside the slot. */
  id?: string
  /** Key for `keyed` slots (unused here). */
  key?: string
  /** Ordering inside a list slot. */
  order?: number
  /** Registrant-localized navigation label (`settings.section`). */
  label?: () => string
  /** Locale namespace handed to the component as `t`. */
  locale?: string
  /** Injected face merged into the component props. */
  inject?: () => Record<string, unknown>
  /** Child slot declarations owned by this entry. */
  children?: Record<string, { kind: 'single' | 'list' | 'keyed'; scope: 'root'; inline?: boolean }>
}

/** Component rendered into a slot. Props are the owner share plus the inject face. */
export type SlotComponent = (props: Record<string, unknown>) => ReactNode

/** Slot service surface used by the Client bundle. */
export interface SlotsService {
  /**
   * Declare a dependency on a slot and register entries while it exists.
   * The callback's registrations are disposed when the slot collapses.
   */
  inject(name: string, register: () => Disposer | readonly Disposer[] | void): Disposer
  /** Register one component into a slot. */
  register(options: SlotRegistrationOptions, component: SlotComponent): Disposer
}

/** Locale service surface used by the Client bundle. */
export interface ClientLocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
  bind(namespace: string): (key: string, vars?: Record<string, string | number>) => string
}

/** Layout service surface: switches the main panel (`conversation` is reserved). */
export interface LayoutService {
  selectPanel(panelId: string | null): void
}

/** Workspace navigation surface: opens an existing session in the main panel. */
export interface UiWorkspaceService {
  openSession(sessionId: string): void
}

/** The Cordis client root context this bundle is applied to. */
export interface ClientContext {
  slots: SlotsService
  /** Register a resource owned by this plugin's context; the callback returns its cleanup. */
  effect(callback: () => Disposer | void, label?: string): void
  /** Optional service lookup (`strict=false` returns undefined instead of throwing). */
  get?<T = unknown>(name: string, strict?: boolean): T | undefined
  /** Cordis 动态依赖：列出的服务可用后执行回调（返回 disposer）。 */
  inject?(deps: readonly string[], callback: (ctx: unknown) => void | (() => void)): unknown
  locale?: ClientLocaleService
  /** Layout service (hard dependency: the board page switches main panels). */
  layout?: LayoutService
  /** Workspace navigation service (soft: only the board's "open session" uses it). */
  uiWorkspace?: UiWorkspaceService
  /** Session UI service (soft: the approval card reads its `sessionStatus`). */
  uiSession?: { sessionStatus?: unknown }
}

// ---------------------------------------------------------------------------
// /commander/* wire contract (docs/architecture/m0-contract-patch.md)
// ---------------------------------------------------------------------------

/** Message role as carried by the Host message ring. */
export type CommanderMessageRole = 'user' | 'assistant'

/** Message role the panel renders; `system` rows are local-only notices. */
export type ChatRole = 'user' | 'assistant' | 'system'

/** One rendered chat row: a Host message or a local system notice. */
export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: number
  order: number
  truncated?: boolean
  turnId?: number
  seq?: number
  /** True for an optimistic user echo not yet confirmed by the Host. */
  pending?: boolean
}

/** One message in the Host's bounded in-memory ring (snapshot `messages`). */
export interface CommanderMessage {
  messageId: string
  role: CommanderMessageRole
  text: string
  at: number
  order: number
  turnId?: number
  seq?: number
  truncated?: boolean
  fullChars?: number
}

/** Model triple of the commander session. */
export interface CommanderModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** Commander session binding (`snapshot.binding`). */
export interface CommanderBinding {
  workspaceId?: string
  workspacePath?: string
  sessionId?: string
  model?: CommanderModel
  agentPreset?: string
}

/** Workspace row as exposed by `GET /commander/state`. */
export interface WorkspaceView {
  id: string
  name?: string
  path?: string
  allowed?: boolean
  summary?: string
  policy?: 'inherit' | 'auto'
  lastSelection?: unknown
}

/** Task row as exposed by `GET /commander/state` (M0: empty). */
/** Capability summary derived by the Host for `tasks[]` (m1-contract-patch §3.2). */
export interface TaskCapabilitySummary {
  status?: string
  enabledCount?: number
  disabledCount?: number
  durationMs?: number
}

export interface TaskView {
  id: string
  title?: string
  goal?: string
  /** Task creation time (detail payload carries it; snapshot rows may omit it). */
  createdAt?: number
  /** Optimistic-concurrency version (detail payload). */
  version?: number
  status?: string
  workspaceId?: string
  /** M5: workspaces this task has dispatched to (current workspace first / deduped). */
  workspaceIds?: string[]
  priority?: string
  /** M5: current round (1-based); board card shows it instead of acceptance N/N. */
  round?: number
  /** M5: a board continue request is waiting for the commander. */
  pendingContinue?: boolean
  primarySessionId?: string
  sessionCount?: number
  updatedAt?: number
  lastActivityAt?: number
  /** M2 read-only derived counts for the board card. */
  acceptanceCount?: number
  evidenceInsufficientCount?: number
  archivedAt?: number
  block?: { reason?: string; code?: string; since?: number } | null
  capability?: TaskCapabilitySummary | null
  /** 依赖与派生 ready（task-state-machine-final §6）。 */
  dependsOn?: string[]
  waitingFor?: string[]
  ready?: boolean
  /** 是否仍有未终结的后继任务（验收时是否要求交接说明 / 指挥官能否验收）。 */
  hasPendingDependents?: boolean
  /** 最近一次验收来源：人/指挥官；旧记录缺省视为人。 */
  acceptedBy?: 'user' | 'commander'
  /** 最近一次验收的交接说明（detail 载荷）。 */
  acceptNote?: { text?: string; at?: number; round?: number }
  /** 该任务是否有未决派发确认。 */
  pendingDispatch?: boolean
  [key: string]: unknown
}

/** One human board edit row returned by `GET /commander/tasks/:id` (M2). */
export interface BoardEditView {
  editId?: string
  field?: string
  before?: unknown
  after?: unknown
  at?: number
  injectedAt?: number | null
}

/** Task states an archive action accepts (m2m3 patch §2.5). */
export type ArchivableStatus = 'review' | 'done' | 'cancelled'

/** One dispatch candidate as carried by `pendingDispatch.candidates` (≤8). */
export interface DispatchCandidateView {
  workspaceId?: string
  workspaceName?: string
  sessionId?: string
  sessionTitle?: string
  mode?: 'new' | 'attach'
  /** Jev probability for the workspace / session questions. */
  pWorkspace?: number
  pSession?: number
  /** Legacy/generic score fields tolerated for forward compatibility. */
  score?: number
  confidence?: number
  /** Short label prepared by the Host, when present. */
  label?: string
  [key: string]: unknown
}

/** Suggested dispatch target inside a pending decision. */
export interface DispatchTargetView {
  workspaceId?: string
  workspaceName?: string
  mode?: 'new' | 'attach'
  sessionId?: string
  sessionTitle?: string
}

/** Pending dispatch decision rendered by the confirmation card (M1). */
export interface PendingDispatchView {
  decisionId?: string
  taskId?: string
  /** Host-prepared task title (preferred over looking it up in `tasks`). */
  taskTitle?: string
  recommendation?: DispatchTargetView
  candidates?: DispatchCandidateView[]
  scores?: Record<string, unknown>
  pMax?: number
  threshold?: number
  reason?: string
  /** M5: initial dispatch vs continue dispatch. */
  kind?: 'initial' | 'continue'
  /** M5: round after confirmation. */
  round?: number
  createdAt?: number
  /** `createdAt + 30min`; drives the card countdown and grey-out. */
  expiresAt?: number
  [key: string]: unknown
}

/** One work session linked to a task (M3 approval-card source, snapshot `workSessions`). */
export interface WorkSessionView {
  sessionId: string
  taskId: string
  title?: string
}

/** One current-turn action shown in the native bubble (additive field). */
export interface CommanderActivity {
  text: string
  at: number
}

/** `GET /commander/state` snapshot (implementation-plan §8.3 + contract patch §1.6). */
export interface CommanderSnapshot {
  rev: number
  serverTime?: number
  binding?: CommanderBinding | null
  commanderStatus?: string
  panel?: 'present' | 'absent'
  counts?: Record<string, number>
  tasks?: TaskView[]
  workspaces?: WorkspaceView[]
  pendingDispatch?: PendingDispatchView | null
  /** M2: global trash counters (read-only derived). */
  archiveSummary?: { archivedCount?: number; cancelledCount?: number }
  /** M3: task-linked work sessions, source for the approval floating card (≤200). */
  workSessions?: WorkSessionView[]
  metrics?: Record<string, number>
  messages?: CommanderMessage[]
  commanderBusy?: boolean
  /** Additive: current tool description / assistant text for the native bubble. */
  commanderActivity?: CommanderActivity | null
  /** M4: native shell phase (running means the DSH in-page ball is hidden). */
  nativeShell?: 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'
  /** R1: rotation status (read-only; present even when disabled). */
  rotation?: RotationView
  /** R1: retired commanders (≤10, newest retired first). */
  formerCommanders?: FormerCommander[]
}

/** R1: command-session rotation status (`state.rotation`). */
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

/** R1: scheduled-task follow result (`scheduleMigration` on rotation/binding responses and SSE). */
export interface ScheduleMigrationView {
  status: 'ok' | 'partial' | 'failed' | 'skipped' | 'unavailable' | 'timeout'
  fromSessionId: string
  toSessionId: string
  scanned: number
  matched: number
  migrated: number
  skipped: {
    ended: number
    gone: number
    changed: number
    notCommander: number
    staleBinding: number
    guardError: number
    malformed: number
  }
  failed: Array<{ id: string; code: string }>
  durationMs: number
}

/** R1: `POST /commander/rotation` response. */
export interface RotationResult {
  rotated: boolean
  reason?: 'not_due' | 'no_activity'
  generation?: number
  sessionId?: string
  previousSessionId?: string
  startedAt?: number
  brief?: { chars: number; tasks: number; unfinished: number; userLines: number; truncated?: boolean }
  scheduleMigration?: ScheduleMigrationView
  rotation?: RotationView
}

/** R1: one retired commander (`state.formerCommanders[]`). */
export interface FormerCommander {
  sessionId: string
  generation: number
  startedAt: number
  retiredAt: number
}

/** One selectable existing session for an attach target (`GET /commander/sessions`). */
export interface SessionOptionView {
  sessionId: string
  /** Host title; empty when the session has no title yet (render "unnamed"). */
  title: string
  workspaceId?: string
  /** Session creation time, when the Host exposes it. */
  createdAt?: number
  /** 0..100 context-window usage, when the Host exposes it. */
  contextPct?: number
  /** Model name of the session, when the Host exposes it. */
  model?: string
  lastActiveAt?: number
  /** Host capped the list (m2m3 patch: `truncated`). */
  truncated?: boolean
}

/** `GET /commander/sessions?workspaceId=` payload (M1R attach picker). */
export interface SessionListResult {
  sessions: SessionOptionView[]
  /** The Host capped the list (`limit`, default 50). */
  truncated?: boolean
}

/** Acceptance row inside `GET /commander/tasks/:id` (M2 detail drawer prework). */
export interface TaskAcceptanceView {
  id?: string
  text?: string
  verify?: string
  evidence?: string
  source?: string
  state?: string
}

/** 方案 A：报告级材料（链接/本地文档/图片）。 */
export type ReportMaterialKind = 'link' | 'file' | 'image'

export interface ReportMaterialView {
  id?: string
  kind?: ReportMaterialKind
  title?: string
  url?: string
  path?: string
  description?: string
  source?: 'commander' | 'presented' | 'session'
  acceptanceIds?: string[]
  derivedFrom?: { sessionId?: string; seq?: number }
  state?: 'ok' | 'missing' | 'too_large' | 'unsupported' | 'unverified'
  meta?: { mime?: string; bytes?: number }
  /** 本地图片的 Host 签名 URL；远程图片仍用 url。 */
  imageUrl?: string
}

/** M5: one archived acceptance round inside `GET /commander/tasks/:id`. */
export interface TaskAcceptanceRoundView {
  round?: number
  at?: number
  items?: TaskAcceptanceView[]
  reportSummary?: { text?: string; at?: number; round?: number }
  /** 方案 A：该轮报告的材料。 */
  materials?: ReportMaterialView[]
}

/** M5: pending board continue-request note. */
export interface TaskPendingInstructionView {
  text?: string
  at?: number
  source?: string
}

/** Capability detail inside `GET /commander/tasks/:id`. */
export interface TaskCapabilityDetailView {
  policy?: string
  executor?: string
  status?: string
  enabled?: string[]
  disabled?: string[]
  durationMs?: number
  at?: number
}

/** Dispatch detail inside `GET /commander/tasks/:id`. */
export interface TaskDispatchDetailView {
  id?: string
  /** When the confirmation decision was created (dispatch record). */
  createdAt?: number
  candidates?: DispatchCandidateView[]
  modelSuggestion?: string
  jev?: {
    provider?: string
    model?: string
    requestId?: string
    latencyMs?: number
    ok?: boolean
    pMax?: number
    concentration?: number
  }
  outcome?: string
  finalTarget?: { workspaceId?: string; mode?: 'new' | 'attach'; sessionId?: string }
  confirmedBy?: string
  /** M5: round / kind / actual prompt sent to the working session / user's original words. */
  round?: number
  kind?: 'initial' | 'continue'
  /** 工作会话收到的消息原文（= commander_task_dispatch.prompt，Host 原样投递）。 */
  brief?: string
  userRequest?: { text?: string; at?: number; source?: 'chat' | 'board' }
}

/** Timeline row inside `GET /commander/tasks/:id`. */
export interface TaskTimelineView {
  at?: number
  type?: string
  text?: string
  sessionId?: string
  seq?: number
  round?: number
}

/** Session link row inside `GET /commander/tasks/:id`. */
export interface TaskSessionLinkView {
  sessionId?: string
  workspaceId?: string
  /** 工作区显示名（Host 从配置副本补全；抽屉展示「工作区 · 会话标题」）。 */
  workspaceName?: string
  /** 会话标题快照（空 = 未命名会话）。 */
  sessionTitle?: string
  role?: string
  mode?: string
  status?: string
  round?: number
}

/** `GET /commander/tasks/:id` payload — stored for the M2 detail drawer/page. */
export interface TaskDetailView {
  task?: TaskView
  acceptance?: TaskAcceptanceView[]
  /** M5: previous rounds' acceptance. */
  acceptanceHistory?: TaskAcceptanceRoundView[]
  /** M5: pending board continue-request. */
  pendingInstruction?: TaskPendingInstructionView
  /** Latest commander_task_report summary (text + at); absent on legacy records. */
  reportSummary?: { text?: string; at?: number; round?: number }
  /** 方案 A：当前轮报告的材料（本地图片带 imageUrl）。 */
  reportMaterials?: ReportMaterialView[]
  capabilities?: TaskCapabilityDetailView | null
  dispatch?: TaskDispatchDetailView | null
  /** M5: every dispatch record of this task (one per round). */
  dispatches?: TaskDispatchDetailView[]
  timeline?: TaskTimelineView[]
  sessions?: TaskSessionLinkView[]
  /** M2: recent human board edits (≤20), newest first. */
  boardEdits?: BoardEditView[]
  archivedAt?: number
  /** 依赖派生视图（detail 复用快照行的同名字段）。 */
  dependsOn?: string[]
  waitingFor?: string[]
  ready?: boolean
  pendingDispatch?: boolean
  rev?: number
}

/** Body of `PATCH /commander/board/tasks/:id` (m2m3 patch §2.4). */
export interface BoardPatchRequest {
  /** 看板 PATCH 只允许元数据；状态走 accept/archive/restore/cancel 路由或 commander 工具。 */
  field: 'priority' | 'title'
  value: string
  editId: string
  requestId: string
}

/** Response of `PATCH /commander/board/tasks/:id`. */
export interface BoardPatchResult {
  task?: TaskView
  boardEdit?: { editId?: string; injectedAt?: number | null }
  rev?: number
}

/** Query of `GET /commander/archive` (m2m3-contract-patch §2.5.1). */
export interface ArchiveQuery {
  limit?: number
  cursor?: string | number
  q?: string
  status?: 'archived' | 'cancelled'
  workspaceId?: string
  /** updatedAt 毫秒，含。 */
  from?: number
  /** updatedAt 毫秒，不含。 */
  to?: number
}

/** 回收站统计（基于当前全部筛选条件）。 */
export interface ArchiveSummary {
  archivedCount: number
  cancelledCount: number
  last30dCount: number
}

/** 回收站月份导航（Host 返回；应用 q/status/workspaceId，忽略 from/to）。 */
export interface ArchiveMonthCount {
  key: string
  count: number
}

/** Response of `GET /commander/archive?limit=&cursor=&q=&status=&workspaceId=&from=&to=` (M2 trash). */
export interface ArchiveListResult {
  tasks: TaskView[]
  nextCursor?: string | number | null
  total?: number
  summary?: ArchiveSummary
  months?: ArchiveMonthCount[]
}

/** Result of `POST /commander/jev/test` (M1 connectivity probe, never carries the key). */
export interface JevTestResult {
  ok?: boolean
  latencyMs?: number
  model?: string
  provider?: string
  message?: string
  error?: { code?: string; message?: string }
}

/** Commander session health as rendered by the header pill. */
export type CommanderStatus = 'unbound' | 'bound' | 'broken' | 'unknown'

/** Transport phase of the snapshot/SSE subscription. */
export type ConnectionPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline'

// ---------------------------------------------------------------------------
// Settings write contract (contract patch §2)
// ---------------------------------------------------------------------------

/** `jev` segment of `PUT /commander/config`. */
export interface JevConfig {
  endpoint?: string
  model?: string
  apiKeyEnv?: string
  /** 工作区段概率阈值。 */
  workspaceThreshold?: number
  /** 会话段概率阈值。 */
  sessionThreshold?: number
  /** 旧版单一阈值（只读兼容）。 */
  threshold?: number
  timeoutMs?: number
  /** 超过阈值自动派发；缺省视为关闭。 */
  autoDispatch?: boolean
}

/** 浮窗中心点（视口归一化 0..1）。 */
export interface EntryPosition {
  x: number
  y: number
}

/** `ui` segment of `PUT /commander/config`. */
export interface UiConfig {
  theme?: 'follow' | 'light' | 'dark'
  /** 旧版角落入口；无 entryPos 时作为默认角落。 */
  entryPosition?: 'br' | 'bl'
  /** 浮窗是否显示（缺省 = 开启）。 */
  entryEnabled?: boolean
  /** 自由拖动位置；null/缺省 = 默认角落。 */
  entryPos?: EntryPosition | null
  /** 是否启用 macOS 原生壳（缺省 = 开启；改动需重启 DSH）。 */
  nativeShell?: boolean
}

/** Partial `PUT /commander/config` request body. */
export interface ConfigPatch {
  requestId?: string
  commander?: { model?: CommanderModel; agentPreset?: string; allowCommanderAccept?: boolean; rotation?: RotationPatch }
  jev?: JevConfig
  ui?: UiConfig
}

/** `PUT /commander/config` response body (display view, no secrets). */
export interface ConfigView {
  commander?: {
    model?: CommanderModel
    agentPreset?: string
    sessionId?: string
    workspaceId?: string
    workspacePath?: string
    /** 是否允许指挥官验收有下游的任务；缺省开。 */
    allowCommanderAccept?: boolean
    rotation?: RotationConfigView
  }
  jev?: JevConfig
  ui?: UiConfig
  updatedAt?: number
}

/** R1: writable rotation fields (`PUT /commander/config`). */
export interface RotationPatch {
  enabled?: boolean
  periodDays?: number
  includeUserTail?: boolean
  /** 换代后给新会话预置 dsh-trace-inspect 工具审计（默认 true）。 */
  toolAudit?: boolean
}

/** R1: read-only rotation config view. */
export interface RotationConfigView {
  enabled?: boolean
  periodDays?: number
  includeUserTail?: boolean
  toolAudit?: boolean
  generation?: number
  generationStartedAt?: number
}

/** One row of `PUT /commander/workspaces`. */
export interface WorkspacePatch {
  id: string
  allowed: boolean
  summary?: string
  policy?: 'inherit' | 'auto'
}

/** `POST /commander/binding` request body (one of the two modes). */
export type BindingRequest =
  | { mode: 'new'; workspaceId?: string; cwd?: string; agentPreset?: string; requestId?: string }
  | { mode: 'select'; workspaceId?: string; sessionId: string; requestId?: string }

/** Error envelope shared by every `/commander/*` write route. */
export interface ApiFailure {
  ok: false
  code: string
  message: string
  field?: string
  retryable?: boolean
}

/** Parsed HTTP result: either a success payload or a contract failure envelope. */
export type HttpResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; failure: ApiFailure }

/** Outcome of sending one panel message. */
export type SendResult =
  | { ok: true; messageId: string; sessionId?: string; queued?: boolean; busy?: boolean }
  | { ok: false; failure: ApiFailure }

/** Outcome of one settings write. */
export type WriteResult<T> = { ok: true; data: T } | { ok: false; failure: ApiFailure }
