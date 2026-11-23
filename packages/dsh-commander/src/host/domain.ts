// commander 域声明：7 张 per-record 表（v1）。表名/版本/字段照 ARCHITECTURE §3.2/§3.3。
// 零运行时依赖：不静态 import @deepseek-ai/dsh-storage-domain；运行时若能解析到宿主包则用其 defineDomain 做声明层校验，
// 否则回退到等价的本地 spec（storageDomain.open 只依赖 spec.tables[].valueSchema.parse，见 V4 证据）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DOMAIN_NAME, DOMAIN_VERSION, TABLE_NAMES, type TableName } from './config.ts'
import {
  createValueSchema,
  isBoardEditRecord,
  isCommandRecord,
  isConfigRecord,
  isDispatchRecord,
  isSessionLinkRecord,
  isTaskRecord,
  isWorkspaceRecord,
  type BoardEditRecord,
  type CommandRecord,
  type ConfigRecord,
  type DispatchRecord,
  type SessionLinkRecord,
  type TaskRecord,
  type ValueSchemaLike,
  type WorkspaceRecord,
} from './schema.ts'

export interface TableValueMap {
  config: ConfigRecord
  workspaces: WorkspaceRecord
  commands: CommandRecord
  tasks: TaskRecord
  dispatches: DispatchRecord
  board_edits: BoardEditRecord
  sessions: SessionLinkRecord
}

export interface CommanderDomainSpec {
  readonly name: string
  readonly version: number
  /** 平台契约：per-record 布局（ARCHITECTURE §3.1/§4.1、V4 验证口径）。缺省会被 storageDomain 按 single 打开。 */
  readonly layout: 'per-record'
  readonly tables: Record<string, { readonly valueSchema: ValueSchemaLike<unknown> }>
}

export const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 本地 spec（不依赖宿主 defineDomain；storageDomain.open 直接可用）。 */
export const commanderDomainSpec: CommanderDomainSpec = {
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  layout: 'per-record',
  tables: {
    config: { valueSchema: createValueSchema(isConfigRecord, 'config') },
    workspaces: { valueSchema: createValueSchema(isWorkspaceRecord, 'workspaces') },
    commands: { valueSchema: createValueSchema(isCommandRecord, 'commands') },
    tasks: { valueSchema: createValueSchema(isTaskRecord, 'tasks') },
    dispatches: { valueSchema: createValueSchema(isDispatchRecord, 'dispatches') },
    board_edits: { valueSchema: createValueSchema(isBoardEditRecord, 'board_edits') },
    sessions: { valueSchema: createValueSchema(isSessionLinkRecord, 'sessions') },
  },
}

export const TABLE_NAMES_SET: ReadonlySet<string> = new Set(TABLE_NAMES)

/** 声明层自检：域名/版本/表名/表集合必须符合契约（失败即插件初始化失败，不静默降级）。 */
export function assertDomainSpec(spec: CommanderDomainSpec = commanderDomainSpec): CommanderDomainSpec {
  if (!TABLE_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${TABLE_NAME_RE}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer`)
  if (spec.layout !== 'per-record') throw new Error(`domain '${spec.name}' layout must be 'per-record', got ${String(spec.layout)}`)
  const tables = Object.keys(spec.tables)
  if (tables.length !== TABLE_NAMES.length) throw new Error(`domain '${spec.name}' must declare ${TABLE_NAMES.length} tables, got ${tables.length}`)
  for (const table of tables) {
    if (!TABLE_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${TABLE_NAME_RE}`)
    if (!TABLE_NAMES_SET.has(table)) throw new Error(`domain '${spec.name}' unexpected table '${table}'`)
    const schema = spec.tables[table]?.valueSchema
    if (typeof schema?.parse !== 'function') throw new Error(`domain '${spec.name}' table '${table}' valueSchema must expose parse()`)
  }
  return spec
}

/**
 * 尝试用宿主包的 defineDomain 做声明层校验（与平台约束保持一致）；不可解析时回退本地自检。
 * 返回实际交给 storageDomain.open 的 spec。
 */
export async function resolveCommanderDomainSpec(anchor = process.argv[1] ?? import.meta.url): Promise<{ spec: CommanderDomainSpec; via: 'defineDomain' | 'local' }> {
  assertDomainSpec(commanderDomainSpec)
  try {
    const requireFunction = createRequire(anchor)
    const entry = requireFunction.resolve('@deepseek-ai/dsh-storage-domain')
    const mod = (await import(pathToFileURL(entry).href)) as { defineDomain?: (spec: unknown) => unknown }
    if (typeof mod.defineDomain === 'function') {
      const spec = mod.defineDomain(commanderDomainSpec) as CommanderDomainSpec
      return { spec, via: 'defineDomain' }
    }
  } catch {
    // 宿主包不可解析（单测/隔离仓库）：使用本地 spec（V4 已证 storageDomain 只需 valueSchema.parse）。
  }
  return { spec: commanderDomainSpec, via: 'local' }
}

/** 所有表名（供 store 层使用）。 */
export function tableValueValidator(table: TableName): ValueSchemaLike<unknown> {
  const schema = commanderDomainSpec.tables[table]?.valueSchema
  if (schema === undefined) throw new Error(`unknown table '${table}'`)
  return schema
}
