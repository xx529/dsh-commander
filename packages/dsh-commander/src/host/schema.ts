// commander 域 7 张表的记录类型 + 手写校验（零运行时依赖；不引入 zod）。
// 字段逐字照 docs/ARCHITECTURE.md §3.3；任何字段增删必须先改 ARCHITECTURE 并由 lead 批准。
import {
  DEFAULT_JEV,
  DEFAULT_UI,
  JEVA_THRESHOLD_MAX,
  JEVA_THRESHOLD_MIN,
  JEV_TIMEOUT_MAX,
  JEV_TIMEOUT_MIN,
  REPORT_MATERIAL_DESCRIPTION_MAX,
  REPORT_MATERIAL_PATH_MAX,
  REPORT_MATERIAL_TITLE_MAX,
  REPORT_MATERIAL_URL_MAX,
  REPORT_SUMMARY_MAX,
  REWORK_COMMENT_MAX,
  ROTATION_PERIOD_MAX_DAYS,
  ROTATION_PERIOD_MIN_DAYS,
} from './config.ts'

export type TaskStatus = 'draft' | 'proposed' | 'queued' | 'running' | 'blocked' | 'review' | 'done' | 'cancelled' | 'archived'
export const TASK_STATUSES: readonly TaskStatus[] = [
  'draft',
  'proposed',
  'queued',
  'running',
  'blocked',
  'review',
  'done',
  'cancelled',
  'archived',
]
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export const PRIORITIES_LIST: readonly Priority[] = ['low', 'normal', 'high', 'urgent']

/**
 * 任务状态机允许迁移（`docs/architecture/task-state-machine-final.md` §3）。
 * 这是「边的全集」，actor 权限/守卫/副作用在 `host/tasks/state-machine.ts`；未列出的边一律禁止。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ['proposed', 'queued', 'blocked', 'cancelled'],
  proposed: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'blocked', 'review', 'cancelled'],
  running: ['running', 'blocked', 'review', 'cancelled'],
  blocked: ['running', 'review', 'proposed', 'cancelled'],
  review: ['queued', 'blocked', 'done', 'cancelled', 'archived'],
  done: ['archived'],
  cancelled: ['archived'],
  archived: ['draft', 'review', 'done'],
}
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}
export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent']

export interface ModelRef {
  provider: string
  model: string
  reasoningEffort?: string
}

/** R1：指挥官会话轮换配置（加法式；缺省 = 关闭，行为同历史版本）。 */
export interface RotationConfig {
  /** 默认 false；关闭时唯一路径是手动「绑定到新会话」，且不生成交接简报。 */
  enabled: boolean
  /** 1..7，默认 1（纯时间差，无定时器）。 */
  periodDays: number
  /** 简报是否包含用户最近原话，默认 true。 */
  includeUserTail: boolean
  /** 当前第几任，默认 1；绑定/轮换时由 Host 管理。 */
  generation?: number
  /** 本任开始时间（ms）；绑定成功时写入，换任时重置。 */
  generationStartedAt?: number
}

export interface CommanderConfig {
  workspaceId: string
  workspacePath: string
  sessionId: string
  model: ModelRef
  agentPreset?: string
  rotation?: RotationConfig
}

export interface JevConfig {
  provider: 'typesafe' | 'custom'
  endpoint: string
  model: string
  keySource: 'env' | 'credential'
  envVar: string
  /** 工作区段概率阈值（旧配置缺省时回退到 `threshold`）。 */
  workspaceThreshold?: number
  /** 会话段概率阈值（旧配置缺省时回退到 `threshold`）。 */
  sessionThreshold?: number
  /** 旧版单一阈值（只读兼容；新写入使用上面两个字段）。 */
  threshold?: number
  timeoutMs: number
  onTimeout: 'pause_and_ask' | 'use_model'
  /** 超过阈值自动派发；缺省视为关闭（旧配置没有该字段）。 */
  autoDispatch?: boolean
}

export interface ConfigRecord {
  v: 1
  commander: CommanderConfig
  jev: JevConfig
  board: { archiveAfterDays: number; syncUserEdits: boolean }
  ui: {
    theme: 'follow' | 'light' | 'dark'
    /** 旧版角落入口位置（自由拖动出现前）；无 entryPos 时作为默认角落。 */
    entryPosition: 'br' | 'bl'
    /** 浮窗是否显示；缺省视为开启（旧配置没有该字段）。 */
    entryEnabled?: boolean
    /** 浮窗中心点（视口归一化 0..1）；缺省/null = 按 entryPosition 落在默认角落。 */
    entryPos?: { x: number; y: number } | null
    /** 是否启用 macOS 原生壳（缺省视为开启；旧配置没有该字段）。 */
    nativeShell?: boolean
    hotkey: string
  }
  updatedAt: number
}

export interface WorkspaceRecord {
  v: 1
  id: string
  name: string
  path: string
  allowed: boolean
  summary: string
  summarySource: 'manual' | 'model'
  summaryUpdatedAt?: number
  capabilityPolicy: {
    mode: 'inherit' | 'auto'
    lastSelection?: {
      status: 'applied' | 'fallback' | 'failed'
      enabled: string[]
      disabled: string[]
      durationMs?: number
      reason?: string
      at: number
    }
  }
}

export interface CommandRecord {
  v: 1
  id: string
  text: string
  sessionId: string
  seq: number
  createdAt: number
  taskIds: string[]
  truncated?: boolean
}

export interface AcceptanceItem {
  id: string
  text: string
  verify?: string
  evidence?: string
  source: 'commander'
  derivedFrom?: { sessionId: string; seq: number }
  state: 'evidence_present' | 'insufficient'
}

export type ReportMaterialKind = 'link' | 'file' | 'image'
export type ReportMaterialSource = 'commander' | 'presented' | 'session'
export type ReportMaterialState = 'ok' | 'missing' | 'too_large' | 'unsupported' | 'unverified'

/** 报告级「依据与材料」：只存元数据/路径/URL，不存文件内容。 */
export interface ReportMaterial {
  id: string
  kind: ReportMaterialKind
  title: string
  /** link / 远程图片：http(s)。 */
  url?: string
  /** file / 本地图片：Host 校验后的绝对路径。 */
  path?: string
  description?: string
  source: ReportMaterialSource
  /** 可选：关联的验收项 id（方案 A 只用于 chips/筛选，不做逐项材料表）。 */
  acceptanceIds?: string[]
  derivedFrom?: { sessionId: string; seq: number }
  state: ReportMaterialState
  meta?: { mime?: string; bytes?: number }
}

export interface AcceptanceRound {
  round: number
  at: number
  items: AcceptanceItem[]
  reportSummary?: ReportSummary
  /** 本轮报告的材料；续派归档时随报告一起进历史。 */
  materials?: ReportMaterial[]
}

export interface PendingInstruction {
  text: string
  at: number
  source: 'rework'
}

export interface CapabilityPlan {
  policy: 'inherit' | 'auto'
  executor: 'capability-panel'
  status: 'inherited' | 'applied' | 'fallback' | 'failed'
  enabled: string[]
  disabled: string[]
  durationMs?: number
  reason?: string
  at: number
}

export interface TaskTimelineItem {
  at: number
  type: 'created' | 'dispatch' | 'session_stop' | 'report' | 'status' | 'user_edit' | 'accept' | 'rework' | 'continue' | 'continue_request'
  text: string
  sessionId?: string
  seq?: number
  /** 所属轮次；旧记录缺省按 1 或由客户端按上下文推断。 */
  round?: number
}

/** commander_task_report 的 summary 原件（ARCHITECTURE §4.2）：原文 + 本次整理时间。 */
export interface ReportSummary {
  text: string
  at: number
  round?: number
}

export interface TaskRecord {
  v: 1
  id: string
  title: string
  goal: string
  status: TaskStatus
  workspaceId: string
  priority: Priority
  commandId: string
  dispatchId?: string
  assignments: string[]
  primarySessionId?: string
  acceptance: AcceptanceItem[]
  /** 当前轮次；缺省 1。只是序号，不承载任务状态。 */
  round?: number
  /** 历史轮次的验收（最近 5 轮）；当前轮验收始终在 `acceptance`。 */
  acceptanceHistory?: AcceptanceRound[]
  /** 看板「继续派发」批注；下一次 commander_task_dispatch 成功后删除。 */
  pendingInstruction?: PendingInstruction
  /** 本任务派发过的全部工作区（去重，按首次出现顺序）。 */
  workspaceIds?: string[]
  /** 最近一次 commander_task_report 的 summary 原文（来自工作会话最后回复；看板抽屉展示）。 */
  reportSummary?: ReportSummary
  /** 当前轮最近一次 commander_task_report 的材料（方案 A：报告级统一材料区）。 */
  reportMaterials?: ReportMaterial[]
  capabilities?: CapabilityPlan
  progress?: { label: string; pct?: number; at: number }
  block?: { reason: string; code?: string; since: number }
  /** 依赖的任务 id；全部 done（或 done→archived）才允许派发。≤5，禁止自依赖/重复/环。 */
  dependsOn?: string[]
  /** 最近一次成功投递 [task-unblocked] 的时间；仅提醒去重，不是就绪真相。 */
  dependencyNotifiedAt?: number
  /** archive 时的原状态；restore 按它回退（缺省回 draft）。 */
  archivedFrom?: TaskStatus
  timeline: TaskTimelineItem[]
  version: number
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  archivedAt?: number
}

export interface DispatchCandidate {
  workspaceId?: string
  sessionId?: string
  mode?: 'new' | 'attach'
  score?: number
  [key: string]: unknown
}

export interface DispatchRecord {
  v: 1
  id: string
  taskId: string
  createdAt: number
  prefilter: { workspaceIds: string[]; sessionIds: string[]; scores: Record<string, number>; truncated: boolean }
  candidates: DispatchCandidate[]
  modelSuggestion: string
  jev: {
    provider: string
    endpoint: string
    model: string
    requestId: string
    latencyMs: number
    ok: boolean
    error?: { code: string; message: string }
    answers?: {
      workspace?: { choice: string; probabilities: Record<string, number>; confidence: number }
      session?: { choice: string; probabilities: Record<string, number>; confidence: number }
    }
    pMax?: number
    concentration?: number
    usage?: { input_tokens: number; output_tokens: number }
  }
  outcome: 'auto' | 'confirmed' | 'overridden' | 'cancelled' | 'jev_unavailable' | 'rejected'
  finalTarget?: { workspaceId: string; mode: 'new' | 'attach'; sessionId?: string }
  confirmedBy?: 'user'
  reason?: string
  /** 本任务第几轮；旧记录缺省 1。 */
  round?: number
  kind?: 'initial' | 'continue'
  /** 指挥官在 commander_task_dispatch 里传的本轮要求。 */
  instruction?: string
  /** 实际发给工作会话的 brief 原文。 */
  brief?: string
  /** 触发本轮派发的用户原话。 */
  userRequest?: { text: string; at: number; source: 'chat' | 'board' }
}

export type SessionLinkStatus = 'queued' | 'running' | 'idle' | 'missing' | 'retired'

export interface SessionLinkRecord {
  v: 1
  sessionId: string
  workspaceId: string
  taskId: string
  role: 'work' | 'commander'
  mode: 'new' | 'attach'
  createdAt: number
  lastInjected?: { turnId: string; seq: number; at: number }
  /** 本 link 对应的任务轮次；缺省 1。旧轮 link 不再参与状态跟踪/注入。 */
  round?: number
  /** R1：retired = 被轮换退役（会话保留、可绑回）；missing = 会话不可恢复。 */
  status: SessionLinkStatus
  /** R1：仅 role='commander'；第几任。 */
  generation?: number
  /** R1：仅 retired 记录。 */
  retiredAt?: number
}

export interface BoardEditRecord {
  v: 1
  id: string
  taskId: string
  field: string
  before: unknown
  after: unknown
  actor: 'user'
  at: number
  injectedAt?: number
  injectionKey?: string
}

// ---------------------------------------------------------------- 校验工具
export type Validator<T> = (value: unknown) => boolean

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
const isBool = (value: unknown): value is boolean => typeof value === 'boolean'
const isEnum = <T extends string>(values: readonly T[]) => (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const isArrayOf = <T>(validator: Validator<T>) => (value: unknown): value is T[] => Array.isArray(value) && value.every((item) => validator(item))
const isOptional = <T>(validator: Validator<T>) => (value: unknown): boolean => value === undefined || validator(value)

/** 手写校验器 → storageDomain 需要的 valueSchema 形状（只用 parse；见 storage-domain DomainTableSpec）。 */
export interface ValueSchemaLike<T> {
  parse(value: unknown): T
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } }
}

export function createValueSchema<T>(validator: Validator<T>, tableName: string): ValueSchemaLike<T> {
  const parse = (value: unknown): T => {
    if (!validator(value)) throw new Error(`invalid-record: table '${tableName}' record failed validation`)
    return value as T
  }
  return {
    parse,
    safeParse(value: unknown) {
      try {
        return { success: true as const, data: parse(value) }
      } catch (error) {
        return { success: false as const, error: { message: String((error as Error)?.message ?? error) } }
      }
    },
  }
}

// ---------------------------------------------------------------- 记录校验
export const isModelRef: Validator<ModelRef> = (value) =>
  // 未绑定/首次启动时 model 允许空串（config.singleton 默认记录）；非空上限仍校验。
  isObject(value) && isString(value.provider, 0, 64) && isString(value.model, 0, 128) && isOptional(isString)(value.reasoningEffort)

export const isRotationConfig: Validator<RotationConfig> = (value) =>
  isObject(value) &&
  isBool(value.enabled) &&
  isInt(value.periodDays) && value.periodDays >= ROTATION_PERIOD_MIN_DAYS && value.periodDays <= ROTATION_PERIOD_MAX_DAYS &&
  isBool(value.includeUserTail) &&
  (value.generation === undefined || (isInt(value.generation) && value.generation >= 1)) &&
  (value.generationStartedAt === undefined || (isNumber(value.generationStartedAt) && value.generationStartedAt >= 0))

export const isCommanderConfig: Validator<CommanderConfig> = (value) =>
  isObject(value) &&
  isString(value.workspaceId) &&
  isString(value.workspacePath) &&
  isString(value.sessionId) &&
  isModelRef(value.model) &&
  isOptional(isString)(value.agentPreset) &&
  (value.rotation === undefined || isRotationConfig(value.rotation))

export const isJevConfig: Validator<JevConfig> = (value) =>
  isObject(value) &&
  isEnum(['typesafe', 'custom'] as const)(value.provider) &&
  isString(value.endpoint, 1, 512) &&
  isString(value.model, 1, 64) &&
  isEnum(['env', 'credential'] as const)(value.keySource) &&
  isString(value.envVar) &&
  (value.workspaceThreshold === undefined || (isNumber(value.workspaceThreshold) && value.workspaceThreshold >= JEVA_THRESHOLD_MIN && value.workspaceThreshold <= JEVA_THRESHOLD_MAX)) &&
  (value.sessionThreshold === undefined || (isNumber(value.sessionThreshold) && value.sessionThreshold >= JEVA_THRESHOLD_MIN && value.sessionThreshold <= JEVA_THRESHOLD_MAX)) &&
  (value.threshold === undefined || (isNumber(value.threshold) && value.threshold >= JEVA_THRESHOLD_MIN && value.threshold <= JEVA_THRESHOLD_MAX)) &&
  isInt(value.timeoutMs) &&
  value.timeoutMs >= JEV_TIMEOUT_MIN &&
  value.timeoutMs <= JEV_TIMEOUT_MAX &&
  isEnum(['pause_and_ask', 'use_model'] as const)(value.onTimeout) &&
  (value.autoDispatch === undefined || isBool(value.autoDispatch))

export const isConfigRecord: Validator<ConfigRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isCommanderConfig(value.commander) &&
  isJevConfig(value.jev) &&
  isObject(value.board) &&
  isInt(value.board.archiveAfterDays) &&
  isBool(value.board.syncUserEdits) &&
  isObject(value.ui) &&
  isEnum(['follow', 'light', 'dark'] as const)(value.ui.theme) &&
  isEnum(['br', 'bl'] as const)(value.ui.entryPosition) &&
  (value.ui.entryEnabled === undefined || isBool(value.ui.entryEnabled)) &&
  (value.ui.nativeShell === undefined || isBool(value.ui.nativeShell)) &&
  (value.ui.entryPos === undefined || value.ui.entryPos === null || (
    isObject(value.ui.entryPos) &&
    isNumber(value.ui.entryPos.x) && value.ui.entryPos.x >= 0 && value.ui.entryPos.x <= 1 &&
    isNumber(value.ui.entryPos.y) && value.ui.entryPos.y >= 0 && value.ui.entryPos.y <= 1
  )) &&
  isString(value.ui.hotkey) &&
  isNumber(value.updatedAt)

export const isWorkspaceRecord: Validator<WorkspaceRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.id, 1, 128) &&
  isString(value.name) &&
  isString(value.path) &&
  isBool(value.allowed) &&
  isString(value.summary, 0, 500) &&
  isEnum(['manual', 'model'] as const)(value.summarySource) &&
  isOptional(isNumber)(value.summaryUpdatedAt) &&
  isObject(value.capabilityPolicy) &&
  isEnum(['inherit', 'auto'] as const)(value.capabilityPolicy.mode) &&
  isOptional(isObject)(value.capabilityPolicy.lastSelection)

export const isCommandRecord: Validator<CommandRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.id) &&
  isString(value.text, 0, 8192) &&
  isString(value.sessionId) &&
  isInt(value.seq) &&
  isNumber(value.createdAt) &&
  isArrayOf(isString)(value.taskIds) &&
  isOptional(isBool)(value.truncated)

export const isAcceptanceItem: Validator<AcceptanceItem> = (value) =>
  isObject(value) &&
  isString(value.id) &&
  isString(value.text) &&
  isOptional(isString)(value.verify) &&
  isOptional(isString)(value.evidence) &&
  value.source === 'commander' &&
  isOptional(isObject)(value.derivedFrom) &&
  isEnum(['evidence_present', 'insufficient'] as const)(value.state)

export const isTimelineItem: Validator<TaskTimelineItem> = (value) =>
  isObject(value) &&
  isNumber(value.at) &&
  isEnum(['created', 'dispatch', 'session_stop', 'report', 'status', 'user_edit', 'accept', 'rework', 'continue', 'continue_request'] as const)(value.type) &&
  isString(value.text) &&
  isOptional(isString)(value.sessionId) &&
  isOptional(isNumber)(value.seq) &&
  (value.round === undefined || (isInt(value.round) && value.round >= 1))

export const isCapabilityPlan: Validator<CapabilityPlan> = (value) =>
  isObject(value) &&
  isEnum(['inherit', 'auto'] as const)(value.policy) &&
  value.executor === 'capability-panel' &&
  isEnum(['inherited', 'applied', 'fallback', 'failed'] as const)(value.status) &&
  isArrayOf(isString)(value.enabled) &&
  isArrayOf(isString)(value.disabled) &&
  isOptional(isNumber)(value.durationMs) &&
  isOptional(isString)(value.reason) &&
  isNumber(value.at)

export const isReportSummary: Validator<ReportSummary> = (value) =>
  isObject(value) &&
  isString(value.text, 0, REPORT_SUMMARY_MAX) &&
  isNumber(value.at) &&
  (value.round === undefined || (isInt(value.round) && value.round >= 1))

const isHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value) && !/[\u0000-\u001f]/.test(value)

const isMaterialMeta = (value: unknown): boolean =>
  isObject(value) &&
  isOptional((mime: unknown) => typeof mime === 'string' && mime.length <= 128)(value.mime) &&
  isOptional(isNumber)(value.bytes)

export const isReportMaterial: Validator<ReportMaterial> = (value) => {
  if (!isObject(value)) return false
  const kind = value.kind
  if (kind !== 'link' && kind !== 'file' && kind !== 'image') return false
  const hasUrl = value.url !== undefined
  const hasPath = value.path !== undefined
  const kindShape = kind === 'link'
    ? hasUrl && !hasPath && isHttpUrl(value.url)
    : kind === 'file'
      ? hasPath && !hasUrl
      : (hasUrl && !hasPath && isHttpUrl(value.url)) || (!hasUrl && hasPath)
  return kindShape &&
    isString(value.id) &&
    isString(value.title, 1, REPORT_MATERIAL_TITLE_MAX) &&
    isOptional((url: unknown) => isString(url, 1, REPORT_MATERIAL_URL_MAX) && isHttpUrl(url))(value.url) &&
    isOptional((path: unknown) => isString(path, 1, REPORT_MATERIAL_PATH_MAX))(value.path) &&
    isOptional((description: unknown) => isString(description, 0, REPORT_MATERIAL_DESCRIPTION_MAX))(value.description) &&
    isEnum(['commander', 'presented', 'session'] as const)(value.source) &&
    isOptional(isArrayOf(isString))(value.acceptanceIds) &&
    isOptional(isObject)(value.derivedFrom) &&
    isEnum(['ok', 'missing', 'too_large', 'unsupported', 'unverified'] as const)(value.state) &&
    isOptional(isMaterialMeta)(value.meta)
}

export const isAcceptanceRound: Validator<AcceptanceRound> = (value) =>
  isObject(value) &&
  isInt(value.round) &&
  value.round >= 1 &&
  isNumber(value.at) &&
  isArrayOf(isAcceptanceItem)(value.items) &&
  isOptional(isReportSummary)(value.reportSummary) &&
  isOptional(isArrayOf(isReportMaterial))(value.materials)

export const isPendingInstruction: Validator<PendingInstruction> = (value) =>
  isObject(value) &&
  isString(value.text, 0, REWORK_COMMENT_MAX) &&
  isNumber(value.at) &&
  value.source === 'rework'

/** dependsOn：≤5 个非空 id、无重复、无自依赖（环由 Host 的依赖校验器检测）。 */
export function isDependsOn(value: unknown, selfId?: string): value is string[] {
  if (!Array.isArray(value) || value.length > 5) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return false
    if (seen.has(item)) return false
    if (item === selfId) return false
    seen.add(item)
  }
  return true
}

export const isTaskRecord: Validator<TaskRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.id) &&
  isString(value.title) &&
  isString(value.goal) &&
  isEnum(TASK_STATUSES)(value.status) &&
  isString(value.workspaceId) &&
  isEnum(PRIORITIES)(value.priority) &&
  isString(value.commandId) &&
  isOptional(isString)(value.dispatchId) &&
  isArrayOf(isString)(value.assignments) &&
  isOptional(isString)(value.primarySessionId) &&
  isArrayOf(isAcceptanceItem)(value.acceptance) &&
  (value.round === undefined || (isInt(value.round) && value.round >= 1)) &&
  isOptional(isArrayOf(isAcceptanceRound))(value.acceptanceHistory) &&
  isOptional(isPendingInstruction)(value.pendingInstruction) &&
  isOptional(isArrayOf(isString))(value.workspaceIds) &&
  isOptional(isReportSummary)(value.reportSummary) &&
  isOptional(isArrayOf(isReportMaterial))(value.reportMaterials) &&
  isOptional(isCapabilityPlan)(value.capabilities) &&
  isOptional(isObject)(value.progress) &&
  isOptional(isObject)(value.block) &&
  (value.dependsOn === undefined || isDependsOn(value.dependsOn, value.id as string)) &&
  (value.dependencyNotifiedAt === undefined || isNumber(value.dependencyNotifiedAt)) &&
  (value.archivedFrom === undefined || isEnum(TASK_STATUSES)(value.archivedFrom)) &&
  isArrayOf(isTimelineItem)(value.timeline) &&
  isInt(value.version) &&
  isNumber(value.createdAt) &&
  isNumber(value.updatedAt) &&
  isNumber(value.lastActivityAt) &&
  isOptional(isNumber)(value.archivedAt)

export const isDispatchCandidate: Validator<DispatchCandidate> = (value) => isObject(value)

export const isDispatchRecord: Validator<DispatchRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.id) &&
  isString(value.taskId) &&
  isNumber(value.createdAt) &&
  isObject(value.prefilter) &&
  isObject(value.jev) &&
  isEnum(['auto', 'confirmed', 'overridden', 'cancelled', 'jev_unavailable', 'rejected'] as const)(value.outcome) &&
  (value.round === undefined || (isInt(value.round) && value.round >= 1)) &&
  (value.kind === undefined || isEnum(['initial', 'continue'] as const)(value.kind)) &&
  isOptional(isString)(value.instruction) &&
  isOptional(isString)(value.brief) &&
  isOptional(isObject)(value.userRequest)

export const isSessionLinkRecord: Validator<SessionLinkRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.sessionId) &&
  isString(value.workspaceId) &&
  isString(value.taskId) &&
  isEnum(['work', 'commander'] as const)(value.role) &&
  isEnum(['new', 'attach'] as const)(value.mode) &&
  isNumber(value.createdAt) &&
  isOptional(isObject)(value.lastInjected) &&
  (value.round === undefined || (isInt(value.round) && value.round >= 1)) &&
  isEnum(['queued', 'running', 'idle', 'missing', 'retired'] as const)(value.status) &&
  (value.generation === undefined || (isInt(value.generation) && value.generation >= 1)) &&
  (value.retiredAt === undefined || isNumber(value.retiredAt))

export const isBoardEditRecord: Validator<BoardEditRecord> = (value) =>
  isObject(value) &&
  value.v === 1 &&
  isString(value.id) &&
  isString(value.taskId) &&
  isString(value.field) &&
  value.actor === 'user' &&
  isNumber(value.at) &&
  isOptional(isNumber)(value.injectedAt) &&
  isOptional(isString)(value.injectionKey)

// ---------------------------------------------------------------- 默认记录
export function defaultConfigRecord(now = Date.now()): ConfigRecord {
  return {
    v: 1,
    commander: {
      workspaceId: '',
      workspacePath: '',
      sessionId: '',
      model: { provider: '', model: '' },
      rotation: { enabled: false, periodDays: 1, includeUserTail: true, generation: 1, generationStartedAt: now },
    },
    jev: { ...DEFAULT_JEV, keySource: 'env', envVar: DEFAULT_JEV.apiKeyEnv },
    board: { archiveAfterDays: 30, syncUserEdits: true },
    ui: { ...DEFAULT_UI, hotkey: '' },
    updatedAt: now,
  }
}

export function defaultWorkspaceRecord(input: { id: string; name: string; path: string }): WorkspaceRecord {
  return {
    v: 1,
    id: input.id,
    name: input.name,
    path: input.path,
    allowed: false,
    summary: '',
    summarySource: 'manual',
    capabilityPolicy: { mode: 'inherit' },
  }
}
