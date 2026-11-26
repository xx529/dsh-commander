// /commander/* 请求体校验（手写，零依赖；严格拒绝未知字段；错误 → ApiError invalid_request + field）。
import {
  JEVA_THRESHOLD_MAX,
  JEVA_THRESHOLD_MIN,
  JEV_TIMEOUT_MAX,
  JEV_TIMEOUT_MIN,
  REQUEST_ID_MAX,
  REQUEST_ID_MIN,
  ROTATION_PERIOD_MAX_DAYS,
  ROTATION_PERIOD_MIN_DAYS,
  UI_ENTRY_POSITIONS,
  UI_THEMES,
  WORKSPACES_MAX,
  WORKSPACE_SUMMARY_MAX,
  WORKSPACES_ALLOWED_POLICIES,
} from '../config.ts'
import { ApiError } from './errors.ts'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is string => typeof value === 'string' && value.length >= min && value.length <= max
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)

const invalid = (message: string, field?: string): ApiError => new ApiError('invalid_request', message, field !== undefined ? { field } : {})

export function requireObject(body: unknown): Record<string, unknown> {
  if (!isObject(body)) throw invalid('body must be a JSON object')
  return body
}

export function parseRequestId(value: unknown): string | null {
  if (value === undefined) return null
  if (!isString(value, REQUEST_ID_MIN, REQUEST_ID_MAX) || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalid(`requestId must be ${REQUEST_ID_MIN}..${REQUEST_ID_MAX} chars of [A-Za-z0-9_-]`, 'requestId')
  }
  return value
}

export function requireRequestId(value: unknown): string {
  const parsed = parseRequestId(value)
  if (parsed === null) throw invalid('requestId is required', 'requestId')
  return parsed
}

const rejectUnknown = (value: Record<string, unknown>, allowed: readonly string[], field: string): void => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`unknown field '${key}'`, `${field}.${key}`)
}

// ---------------------------------------------------------------- POST /commander/message
export interface MessageBody { text: string; requestId: string; clientTs?: number }
export function validateMessageBody(body: unknown): MessageBody {
  const record = requireObject(body)
  rejectUnknown(record, ['text', 'requestId', 'clientTs'], 'body')
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (text.length === 0) throw invalid('text is required', 'text')
  if (Array.from(text).length > 8192) throw invalid('text exceeds 8192 characters', 'text')
  const requestId = requireRequestId(record.requestId)
  if (record.clientTs !== undefined && !isNumber(record.clientTs)) throw invalid('clientTs must be a number', 'clientTs')
  return { text, requestId, ...(record.clientTs !== undefined ? { clientTs: record.clientTs as number } : {}) }
}

// ---------------------------------------------------------------- PUT /commander/config
export interface ConfigPatch {
  commander?: {
    model?: { provider?: string; model?: string; reasoningEffort?: string }
    agentPreset?: string
    /** 是否允许指挥官验收有下游的任务；缺省开。 */
    allowCommanderAccept?: boolean
    rotation?: { enabled?: boolean; periodDays?: number; includeUserTail?: boolean; toolAudit?: boolean }
  }
  jev?: { endpoint?: string; model?: string; apiKeyEnv?: string; threshold?: number; workspaceThreshold?: number; sessionThreshold?: number; timeoutMs?: number; autoDispatch?: boolean }
  ui?: {
    theme?: 'follow' | 'light' | 'dark'
    entryPosition?: 'br' | 'bl'
    entryEnabled?: boolean
    /** null = 清除自由位置，回到 entryPosition 的默认角落。 */
    entryPos?: { x: number; y: number } | null
    /** 是否启用 macOS 原生壳。 */
    nativeShell?: boolean
  }
  requestId?: string
}
export function validateConfigPatch(body: unknown): ConfigPatch {
  const record = requireObject(body)
  rejectUnknown(record, ['requestId', 'commander', 'jev', 'ui'], 'body')
  const patch: ConfigPatch = {}
  const requestId = parseRequestId(record.requestId)
  if (requestId !== null) patch.requestId = requestId
  if (record.commander !== undefined) {
    const commander = requireObject(record.commander)
    rejectUnknown(commander, ['model', 'agentPreset', 'allowCommanderAccept', 'rotation'], 'commander')
    if (commander.sessionId !== undefined || commander.workspaceId !== undefined) throw invalid('binding fields are managed by POST /commander/binding', 'commander.sessionId')
    const out: NonNullable<ConfigPatch['commander']> = {}
    if (commander.model !== undefined) {
      const model = requireObject(commander.model)
      rejectUnknown(model, ['provider', 'model', 'reasoningEffort'], 'commander.model')
      const modelOut: NonNullable<NonNullable<ConfigPatch['commander']>['model']> = {}
      if (model.provider !== undefined) {
        if (!isString(model.provider, 1, 64)) throw invalid('provider must be 1..64 chars', 'commander.model.provider')
        modelOut.provider = model.provider
      }
      if (model.model !== undefined) {
        if (!isString(model.model, 1, 128)) throw invalid('model must be 1..128 chars', 'commander.model.model')
        modelOut.model = model.model
      }
      if (model.reasoningEffort !== undefined) {
        if (!isString(model.reasoningEffort, 0, 32)) throw invalid('reasoningEffort must be ≤32 chars', 'commander.model.reasoningEffort')
        modelOut.reasoningEffort = model.reasoningEffort
      }
      out.model = modelOut
    }
    if (commander.agentPreset !== undefined) {
      if (!isString(commander.agentPreset, 0, 64)) throw invalid('agentPreset must be ≤64 chars', 'commander.agentPreset')
      out.agentPreset = commander.agentPreset
    }
    if (commander.allowCommanderAccept !== undefined) {
      if (typeof commander.allowCommanderAccept !== 'boolean') throw invalid('allowCommanderAccept must be a boolean', 'commander.allowCommanderAccept')
      out.allowCommanderAccept = commander.allowCommanderAccept
    }
    if (commander.rotation !== undefined) {
      const rotation = requireObject(commander.rotation)
      // generation/generationStartedAt 由 Host 管理，出现在 patch 里按未知字段拒绝。
      rejectUnknown(rotation, ['enabled', 'periodDays', 'includeUserTail', 'toolAudit'], 'commander.rotation')
      const rotationOut: NonNullable<NonNullable<ConfigPatch['commander']>['rotation']> = {}
      if (rotation.enabled !== undefined) {
        if (typeof rotation.enabled !== 'boolean') throw invalid('enabled must be a boolean', 'commander.rotation.enabled')
        rotationOut.enabled = rotation.enabled
      }
      if (rotation.periodDays !== undefined) {
        if (!isInt(rotation.periodDays) || rotation.periodDays < ROTATION_PERIOD_MIN_DAYS || rotation.periodDays > ROTATION_PERIOD_MAX_DAYS) {
          throw invalid(`periodDays must be an integer in ${ROTATION_PERIOD_MIN_DAYS}..${ROTATION_PERIOD_MAX_DAYS}`, 'commander.rotation.periodDays')
        }
        rotationOut.periodDays = rotation.periodDays
      }
      if (rotation.includeUserTail !== undefined) {
        if (typeof rotation.includeUserTail !== 'boolean') throw invalid('includeUserTail must be a boolean', 'commander.rotation.includeUserTail')
        rotationOut.includeUserTail = rotation.includeUserTail
      }
      if (rotation.toolAudit !== undefined) {
        if (typeof rotation.toolAudit !== 'boolean') throw invalid('toolAudit must be a boolean', 'commander.rotation.toolAudit')
        rotationOut.toolAudit = rotation.toolAudit
      }
      if (Object.keys(rotationOut).length > 0) out.rotation = rotationOut
    }
    patch.commander = out
  }
  if (record.jev !== undefined) {
    const jev = requireObject(record.jev)
    rejectUnknown(jev, ['endpoint', 'model', 'apiKeyEnv', 'threshold', 'workspaceThreshold', 'sessionThreshold', 'timeoutMs', 'autoDispatch'], 'jev')
    const out: NonNullable<ConfigPatch['jev']> = {}
    if (jev.endpoint !== undefined) {
      if (!isString(jev.endpoint, 1, 512) || !/^https?:\/\//.test(jev.endpoint)) throw invalid('endpoint must be an http(s) URL ≤512 chars', 'jev.endpoint')
      out.endpoint = jev.endpoint
    }
    if (jev.model !== undefined) {
      if (!isString(jev.model, 1, 64)) throw invalid('jev.model must be 1..64 chars', 'jev.model')
      out.model = jev.model
    }
    if (jev.apiKeyEnv !== undefined) {
      if (!isString(jev.apiKeyEnv) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(jev.apiKeyEnv)) throw invalid('apiKeyEnv must match ^[A-Z][A-Z0-9_]{1,63}$', 'jev.apiKeyEnv')
      out.apiKeyEnv = jev.apiKeyEnv
    }
    if (jev.threshold !== undefined) {
      if (!isNumber(jev.threshold) || jev.threshold < JEVA_THRESHOLD_MIN || jev.threshold > JEVA_THRESHOLD_MAX) throw invalid(`threshold must be ${JEVA_THRESHOLD_MIN}..${JEVA_THRESHOLD_MAX}`, 'jev.threshold')
      // 旧字段：同时写入两段阈值（兼容旧客户端）
      out.workspaceThreshold = jev.threshold
      out.sessionThreshold = jev.threshold
    }
    for (const [key, field] of [['workspaceThreshold', 'jev.workspaceThreshold'], ['sessionThreshold', 'jev.sessionThreshold']] as const) {
      const value = jev[key]
      if (value === undefined) continue
      if (!isNumber(value) || value < JEVA_THRESHOLD_MIN || value > JEVA_THRESHOLD_MAX) throw invalid(`${key} must be ${JEVA_THRESHOLD_MIN}..${JEVA_THRESHOLD_MAX}`, field)
      out[key] = value
    }
    if (jev.timeoutMs !== undefined) {
      if (!isInt(jev.timeoutMs) || jev.timeoutMs < JEV_TIMEOUT_MIN || jev.timeoutMs > JEV_TIMEOUT_MAX) throw invalid(`timeoutMs must be ${JEV_TIMEOUT_MIN}..${JEV_TIMEOUT_MAX}`, 'jev.timeoutMs')
      out.timeoutMs = jev.timeoutMs
    }
    if (jev.autoDispatch !== undefined) {
      if (typeof jev.autoDispatch !== 'boolean') throw invalid('autoDispatch must be a boolean', 'jev.autoDispatch')
      out.autoDispatch = jev.autoDispatch
    }
    patch.jev = out
  }
  if (record.ui !== undefined) {
    const ui = requireObject(record.ui)
    rejectUnknown(ui, ['theme', 'entryPosition', 'entryEnabled', 'entryPos', 'nativeShell'], 'ui')
    const out: NonNullable<ConfigPatch['ui']> = {}
    if (ui.theme !== undefined) {
      if (!UI_THEMES.includes(ui.theme as (typeof UI_THEMES)[number])) throw invalid(`theme must be one of ${UI_THEMES.join('|')}`, 'ui.theme')
      out.theme = ui.theme as (typeof UI_THEMES)[number]
    }
    if (ui.entryPosition !== undefined) {
      if (!UI_ENTRY_POSITIONS.includes(ui.entryPosition as (typeof UI_ENTRY_POSITIONS)[number])) throw invalid(`entryPosition must be one of ${UI_ENTRY_POSITIONS.join('|')}`, 'ui.entryPosition')
      out.entryPosition = ui.entryPosition as (typeof UI_ENTRY_POSITIONS)[number]
    }
    if (ui.nativeShell !== undefined) {
      if (typeof ui.nativeShell !== 'boolean') throw invalid('nativeShell must be a boolean', 'ui.nativeShell')
      out.nativeShell = ui.nativeShell
    }
    if (ui.entryEnabled !== undefined) {
      if (typeof ui.entryEnabled !== 'boolean') throw invalid('entryEnabled must be a boolean', 'ui.entryEnabled')
      out.entryEnabled = ui.entryEnabled
    }
    if (ui.entryPos !== undefined) {
      if (ui.entryPos === null) {
        out.entryPos = null
      } else {
        const pos = requireObject(ui.entryPos)
        rejectUnknown(pos, ['x', 'y'], 'ui.entryPos')
        if (!isNumber(pos.x) || pos.x < 0 || pos.x > 1) throw invalid('entryPos.x must be a number in 0..1', 'ui.entryPos.x')
        if (!isNumber(pos.y) || pos.y < 0 || pos.y > 1) throw invalid('entryPos.y must be a number in 0..1', 'ui.entryPos.y')
        out.entryPos = { x: pos.x, y: pos.y }
      }
    }
    patch.ui = out
  }
  if (patch.commander === undefined && patch.jev === undefined && patch.ui === undefined) throw invalid('empty config patch')
  return patch
}

// ---------------------------------------------------------------- PUT /commander/workspaces
export interface WorkspacePatchItem { id: string; allowed: boolean; summary: string; policy: 'inherit' | 'auto' }
export interface WorkspacesBody { workspaces: WorkspacePatchItem[]; requestId?: string }
export function validateWorkspacesBody(body: unknown): WorkspacesBody {
  const record = requireObject(body)
  rejectUnknown(record, ['requestId', 'workspaces'], 'body')
  const requestId = parseRequestId(record.requestId)
  if (!Array.isArray(record.workspaces)) throw invalid('workspaces must be an array', 'workspaces')
  if (record.workspaces.length > WORKSPACES_MAX) throw invalid(`workspaces length must be ≤${WORKSPACES_MAX}`, 'workspaces')
  const seen = new Set<string>()
  const items: WorkspacePatchItem[] = record.workspaces.map((raw, index) => {
    const item = requireObject(raw)
    rejectUnknown(item, ['id', 'allowed', 'summary', 'policy'], `workspaces[${index}]`)
    if (!isString(item.id, 1, 128)) throw invalid('id must be 1..128 chars', `workspaces[${index}].id`)
    if (seen.has(item.id)) throw invalid(`duplicate workspace id '${item.id}'`, `workspaces[${index}].id`)
    seen.add(item.id)
    if (typeof item.allowed !== 'boolean') throw invalid('allowed must be boolean', `workspaces[${index}].allowed`)
    const summary = item.summary === undefined ? '' : item.summary
    if (!isString(summary, 0, WORKSPACE_SUMMARY_MAX)) throw invalid(`summary must be ≤${WORKSPACE_SUMMARY_MAX} chars`, `workspaces[${index}].summary`)
    const policy = item.policy === undefined ? 'inherit' : item.policy
    if (!WORKSPACES_ALLOWED_POLICIES.includes(policy as (typeof WORKSPACES_ALLOWED_POLICIES)[number])) throw invalid('policy must be inherit|auto', `workspaces[${index}].policy`)
    return { id: item.id, allowed: item.allowed, summary, policy: policy as 'inherit' | 'auto' }
  })
  return { workspaces: items, ...(requestId !== null ? { requestId } : {}) }
}

// ---------------------------------------------------------------- POST /commander/binding
export type BindingBody =
  | { mode: 'new'; workspaceId?: string; cwd?: string; agentPreset?: string; requestId?: string }
  | { mode: 'select'; workspaceId?: string; sessionId: string; requestId?: string }
export function validateBindingBody(body: unknown): BindingBody {
  const record = requireObject(body)
  rejectUnknown(record, ['mode', 'workspaceId', 'cwd', 'sessionId', 'agentPreset', 'requestId'], 'body')
  const requestId = parseRequestId(record.requestId)
  if (record.mode === 'new') {
    if (record.workspaceId !== undefined && record.cwd !== undefined) throw invalid('workspaceId and cwd are mutually exclusive', 'workspaceId')
    if (record.workspaceId === undefined && record.cwd === undefined) throw invalid('workspaceId or cwd is required', 'workspaceId')
    if (record.workspaceId !== undefined && !isString(record.workspaceId, 1, 128)) throw invalid('workspaceId must be 1..128 chars', 'workspaceId')
    if (record.cwd !== undefined && (!isString(record.cwd, 1, 1024) || !record.cwd.startsWith('/'))) throw invalid('cwd must be an absolute path ≤1024 chars', 'cwd')
    if (record.sessionId !== undefined) throw invalid('sessionId is not allowed for mode=new', 'sessionId')
    if (record.agentPreset !== undefined && !isString(record.agentPreset, 0, 64)) throw invalid('agentPreset must be ≤64 chars', 'agentPreset')
    return {
      mode: 'new',
      ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId as string } : {}),
      ...(record.cwd !== undefined ? { cwd: record.cwd as string } : {}),
      ...(record.agentPreset !== undefined ? { agentPreset: record.agentPreset as string } : {}),
      ...(requestId !== null ? { requestId } : {}),
    }
  }
  if (record.mode === 'select') {
    if (!isString(record.sessionId, 1, 128)) throw invalid('sessionId is required for mode=select', 'sessionId')
    if (record.cwd !== undefined) throw invalid('cwd is not allowed for mode=select', 'cwd')
    if (record.workspaceId !== undefined && !isString(record.workspaceId, 1, 128)) throw invalid('workspaceId must be 1..128 chars', 'workspaceId')
    return {
      mode: 'select',
      sessionId: record.sessionId as string,
      ...(record.workspaceId !== undefined ? { workspaceId: record.workspaceId as string } : {}),
      ...(requestId !== null ? { requestId } : {}),
    }
  }
  throw invalid('mode must be new|select', 'mode')
}

// ---------------------------------------------------------------- POST /commander/rotation
export interface RotationBody {
  requestId?: string
  force: boolean
}
/** `{ requestId?, force? }`：force 缺省 false；其余字段严格拒绝。 */
export function validateRotationBody(body: unknown): RotationBody {
  const record = body === undefined || body === null ? {} : requireObject(body)
  rejectUnknown(record, ['requestId', 'force'], 'body')
  const requestId = parseRequestId(record.requestId)
  if (record.force !== undefined && typeof record.force !== 'boolean') throw invalid('force must be a boolean', 'force')
  return { ...(requestId !== null ? { requestId } : {}), force: record.force === true }
}
