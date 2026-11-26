// M1 模型工具定义与作用域安装：只在指挥官会话可见（register on agent ctx; 其它 agent restrict deny）。
// 工具 schema 照 ARCHITECTURE §4.1/§4.4；execute 返回结构化对象，失败返回 {ok:false,code,message}。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { REPORT_SUMMARY_MAX, REWORK_COMMENT_MAX, WORKSPACE_SUMMARY_MAX } from '../config.ts'
import type { CordisContext } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'
import { appendTimeline, createId } from '../store/base.ts'
import { defaultWorkspaceRecord, type AcceptanceItem, type Priority, type ReportSummary, type TaskRecord, type TaskStatus, type WorkspaceRecord } from '../schema.ts'
import type { DispatchService } from '../dispatch/service.ts'
import { collectWorkspaceDirectory, resolveWorkspaceReference } from '../dispatch/candidates.ts'
import { buildTaskRow, parseTaskQueryArgs, queryTasks, TASK_BLOCK_REASON_CHARS, TASK_TITLE_CHARS } from '../query/tasks.ts'
import { parseSessionQueryArgs, querySessions } from '../query/sessions.ts'
import { listEnabledWorkspaces } from '../query/workspaces.ts'
import { formatLocalDateTime } from '../query/time-input.ts'
import { clipLine } from '../rotation/brief.ts'
import { readSessionEvents } from '../session/session-records.ts'
import { buildReportMaterials } from '../report-materials.ts'
import { stopTaskSessions } from '../tasks/stop-sessions.ts'
import { transitionTask, isTerminalStatus } from '../tasks/state-machine.ts'
import type { DependencyNotifier } from '../tasks/notifications.ts'
import { hasPendingDependents, isReady, validateDependsOn, waitingFor, dependentsOf } from '../tasks/dependencies.ts'
import { performAccept } from '../tasks/actions.ts'

export const COMMANDER_TOOL_NAMES = ['commander_task_create', 'commander_task_get', 'commander_task_update', 'commander_task_accept', 'commander_task_dispatch', 'commander_task_list', 'commander_task_report', 'commander_workspace_list', 'commander_workspace_update', 'commander_session_list'] as const
export type CommanderToolName = (typeof COMMANDER_TOOL_NAMES)[number]

/**
 * 宿主模块解析锚点候选：真实 Host 进程 argv[1] 通常是 dsh lib/bin.js；测试/嵌入场景可能是 shim，
 * 因此额外用 process.execPath 反推同版本 node 的 lib/node_modules，并扫描 nvm 已装版本。
 */
export function hostModuleAnchors(execPath = process.execPath, argv1 = process.argv[1]): string[] {
  const anchors: string[] = []
  if (argv1 !== undefined && argv1 !== '') anchors.push(argv1)
  const envEntry = process.env.DSH_CLI_ENTRY
  if (envEntry !== undefined && envEntry !== '') anchors.push(envEntry)
  const candidates: string[] = []
  try {
    const nodeRoot = dirname(dirname(execPath)) // …/versions/node/vX
    candidates.push(join(nodeRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    const versionsRoot = dirname(nodeRoot)
    const home = process.env.HOME ?? ''
    candidates.push(join(home, '.nvm', 'versions', 'node'))
    for (const version of fs.readdirSync(join(home, '.nvm', 'versions', 'node'))) {
      candidates.push(join(home, '.nvm', 'versions', 'node', version, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
    try {
      for (const version of fs.readdirSync(candidates[1] as string)) {
        candidates.push(join(candidates[1] as string, version, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      }
    } catch {
      /* 无 nvm */
    }
    void versionsRoot
  } catch {
    /* 解析候选失败：仅用 argv/env */
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) anchors.push(candidate)
    } catch {
      /* ignore */
    }
  }
  return [...new Set(anchors)]
}

/** 延迟解析宿主 defineTool（零静态 @deepseek-ai 依赖）；解析不到时用恒等包装（但 spec 始终带 output.render）。 */
export async function loadDefineTool(anchor?: string): Promise<(spec: unknown) => unknown> {
  const anchors = anchor !== undefined ? [anchor, ...hostModuleAnchors()] : hostModuleAnchors()
  for (const candidate of anchors) {
    try {
      const requireFunction = createRequire(candidate)
      const entry = requireFunction.resolve('@deepseek-ai/dsh-tools')
      const mod = (await import(pathToFileURL(entry).href)) as { defineTool?: (spec: unknown) => unknown }
      if (typeof mod.defineTool === 'function') return mod.defineTool
    } catch {
      continue
    }
  }
  return (spec) => spec
}

export interface ToolAgentLike {
  id?: string
  session?: { id?: string; header?: { id?: string } }
  ctx?: { get?: (name: string) => unknown }
}

export interface ToolExecLike {
  signal?: { throwIfAborted?: () => void }
  agent?: ToolAgentLike
  session?: { id?: string }
  sessionId?: string
}

export interface CommanderToolsDeps {
  ctx: CordisContext
  stores: StoreSet
  dispatchService: DispatchService
  commanderSessionId: () => string
  now?: () => number
  /** 测试注入：覆盖 defineTool 解析（默认运行时解析宿主 @deepseek-ai/dsh-tools）。 */
  defineToolLoader?: () => Promise<(spec: unknown) => unknown>
  /** 诊断回调（不静默失败）。 */
  onDiagnostic?: (message: string) => void
  /** 任务写入后通知 UI（否则指挥官改完看板，看板要等重启/重新打开才更新）。 */
  onTaskChanged?: (task: TaskRecord) => void
  /** 该任务是否已有未决派发确认（task_update 的 pending 冲突 / task_get 派生字段）。 */
  hasPendingDispatch?: (taskId: string) => boolean
  /** 依赖提醒服务（set_dependencies/recover 成功后 pump；dispatch 结算后 pump）。 */
  dependencyNotifier?: Partial<Pick<DependencyNotifier, 'afterDependencyInvalidated' | 'afterDispatchSettled' | 'afterTasksChanged' | 'afterAccepted'>>
  /** cancel 成功后清掉该任务的未决确认。 */
  onTaskSettled?: (taskId: string) => void
  /** 工作区摘要写入后通知 UI（广播整帧 snapshot；人类改同一字段时也走同一显示路径）。 */
  onWorkspaceChanged?: (record: WorkspaceRecord) => void | Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** agent/session 身份：真实 root agent 对象上 session 可能为空，只有 agent.id（tester M1 e2e 实测）。 */
export function agentSessionIdOf(agent: { id?: string; session?: { id?: string; header?: { id?: string } } } | undefined): string | undefined {
  return agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
}

const executorSessionId = (exec: ToolExecLike): string | undefined =>
  agentSessionIdOf(exec.agent) ?? exec.session?.id ?? exec.sessionId

const failure = (code: string, message: string) => ({ ok: false as const, code, message })

/** commander_task_get 的验收项投影：只保留指挥官写 prompt 需要的字段（schema 严格）。 */
const acceptanceView = (items: readonly AcceptanceItem[]) => items.map((item) => ({
  id: item.id,
  text: item.text,
  ...(item.verify !== undefined ? { verify: item.verify } : {}),
  ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
  state: item.state,
}))

const summaryView = (summary: ReportSummary) => ({
  text: summary.text,
  at: summary.at,
  ...(summary.round !== undefined ? { round: summary.round } : {}),
})

export function createCommanderTools(deps: CommanderToolsDeps) {
  const now = deps.now ?? (() => Date.now())
  const disposers: Array<() => void> = []
  let defineTool: (spec: unknown) => unknown = (spec) => spec
  let toolsSpecs: Record<CommanderToolName, unknown> | null = null

  /** defineTool 的 output.render 返回值：纯文本投影（参考 dsh-better-sidebar 的 textRender）。 */
  const textRender = (fn: (value: unknown) => string) => (_args: unknown, value: unknown) => [{ type: 'text', text: fn(value) }]

  /** 工具执行失败返回 {ok:false,code,message}；output schema 必须覆盖它（DSH 运行时会校验返回值）。 */
  const toolErrorSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', enum: [false], required: true },
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
  }
  const scoreSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      pWorkspace: { type: 'number', required: true },
      pSession: { type: 'number', required: true },
      pMax: { type: 'number', required: true },
      concentration: { type: 'number', required: true },
    },
  }
  const candidateSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', required: true },
      workspaceName: { type: 'string', required: true },
      workspacePath: { type: 'string', required: true },
      mode: { type: 'string', enum: ['new', 'attach'], required: true },
      sessionId: { type: 'string' },
      sessionTitle: { type: 'string' },
      pWorkspace: { type: 'number', required: true },
      pSession: { type: 'number', required: true },
      score: { type: 'number', required: true },
      reason: { type: 'string' },
    },
  }
  const targetSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', required: true },
      mode: { type: 'string', enum: ['new', 'attach'], required: true },
      sessionId: { type: 'string' },
    },
  }
  /** commander_task_dispatch 三 variant（与 dispatch/service.ts 的 DispatchTaskResult 完全一致）。 */
  const taskListRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      title: { type: 'string', required: true },
      status: { type: 'string', required: true },
      column: { type: 'string', required: true },
      priority: { type: 'string', required: true },
      workspaceId: { type: 'string', required: true },
      workspaceName: { type: 'string', required: true },
      version: { type: 'number', required: true },
      round: { type: 'number', required: true },
      dispatchable: { type: 'boolean', required: true },
      waitingFor: { type: 'array', items: { type: 'string' } },
      blockReason: { type: 'string' },
      acceptanceCount: { type: 'number', required: true },
      createdAt: { type: 'number', required: true },
      updatedAt: { type: 'number', required: true },
      ageMinutes: { type: 'number', required: true },
      primarySessionId: { type: 'string' },
      pendingInstruction: { type: 'boolean', required: true },
    },
  }
  const countsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      draft: { type: 'number' },
      proposed: { type: 'number' },
      queued: { type: 'number' },
      running: { type: 'number' },
      blocked: { type: 'number' },
      review: { type: 'number' },
      done: { type: 'number' },
      cancelled: { type: 'number' },
      archived: { type: 'number' },
    },
  }
  const columnsSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      proposed: { type: 'number' },
      queued: { type: 'number' },
      running: { type: 'number' },
      blocked: { type: 'number' },
      review: { type: 'number' },
      done: { type: 'number' },
      trash: { type: 'number' },
    },
  }
  const pendingDispatchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: { type: 'string', required: true },
      expiresAt: { type: 'number', required: true },
    },
  }
  const workspaceRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      path: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      policy: { type: 'string', enum: ['inherit', 'auto'], required: true },
      sessionCount: { type: 'number', required: true },
    },
  }
  const sessionRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', required: true },
      title: { type: 'string', required: true },
      createdAt: { type: 'number', required: true },
      lastActiveAt: { type: 'number', required: true },
      ageMinutes: { type: 'number', required: true },
      archived: { type: 'boolean', required: true },
      model: { type: 'string' },
      agentPreset: { type: 'string' },
      contextUsage: { type: 'number' },
    },
  }
  /** render 用的相对时间标签（ageMinutes → 42m / 3h / 2d）。 */
  const ageLabel = (minutes: number): string => (minutes < 60 ? `${minutes}m` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1_440)}d`)

  const dispatchTaskOutputSchema = {
    oneOf: [
      toolErrorSchema,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['rejected'], required: true },
          code: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['needs_confirmation'], required: true },
          taskId: { type: 'string', required: true },
          decisionId: { type: 'string', required: true },
          candidates: { type: 'array', items: candidateSchema, required: true },
          recommendation: { ...targetSchema, required: true },
          scores: { ...scoreSchema, required: true },
          reason: { type: 'string', required: true },
          kind: { type: 'string', enum: ['initial', 'continue'], required: true },
          round: { type: 'number', required: true },
          expiresAt: { type: 'number', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['dispatched'], required: true },
          taskId: { type: 'string', required: true },
          decisionId: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          sessionCreated: { type: 'boolean', required: true },
          target: { ...targetSchema, required: true },
          scores: { ...scoreSchema, required: true },
          capabilities: { type: 'object', additionalProperties: true },
          round: { type: 'number', required: true },
        },
      },
    ],
  }
  const buildSpecs = (): Record<CommanderToolName, unknown> | null => {
    // 真实 @deepseek-ai/dsh-tools 的 defineTool 必须拿到 output.render（否则 TypeError ...reading 'render'）；
    // 单测/隔离环境虽然会回退 identity 包装，但生产 spec 必须始终带 output。
    const wrap = (spec: Record<string, unknown>) => defineTool(spec)
    const ensureCommanderScope = (exec: ToolExecLike) => {
      const callerSessionId = executorSessionId(exec)
      if (callerSessionId === undefined) return failure('forbidden_scope', 'tool caller session is unknown')
      if (callerSessionId !== deps.commanderSessionId()) return failure('forbidden_scope', 'only the commander session may use this tool')
      return null
    }
    const commander_task_create = wrap({
      name: 'commander_task_create',
      description: 'Create a task draft for the commander board. Optional dependsOn declares up to 5 prerequisite task ids (all must be accepted before dispatch). Returns {taskId, status:"draft", version, dependsOn, waitingFor, ready}.',
      parameters: {
        title: { type: 'string', required: true, description: 'Task title' },
        goal: { type: 'string', required: true, description: 'Task goal (what the user wants)' },
        workspaceId: { type: 'string', description: 'Suggested workspace (optional)' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority (default normal)' },
        commandId: { type: 'string', description: 'Related command record id (optional)' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'Prerequisite task ids (≤5; no self/duplicates/cycles)' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                version: { type: 'number', required: true },
                dependsOn: { type: 'array', items: { type: 'string' }, required: true },
                waitingFor: { type: 'array', items: { type: 'string' }, required: true },
                ready: { type: 'boolean', required: true },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { taskId?: string; status?: string; version?: number; dependsOn?: string[]; waitingFor?: string[]; ready?: boolean }
          void record
          return `Task created: ${record.taskId ?? '?'} (${record.status ?? '?'}, version=${String(record.version ?? '?')}, dependsOn=${JSON.stringify(record.dependsOn ?? [])}, waitingFor=${JSON.stringify(record.waitingFor ?? [])}, ready=${String(record.ready)})`
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const title = asString(args.title)
        const goal = asString(args.goal)
        if (title === undefined || goal === undefined) return failure('invalid_request', 'title and goal are required')
        const priorityRaw = asString(args.priority)
        const priority: Priority = priorityRaw === 'low' || priorityRaw === 'high' || priorityRaw === 'urgent' ? priorityRaw : 'normal'
        const timestamp = now()
        const taskId = createId('task', timestamp)
        const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
        const depends = validateDependsOn(taskId, args.dependsOn, lookup, deps.stores.tasks.list())
        if (!depends.ok) return failure(depends.code, depends.message)
        const task: TaskRecord = {
          v: 1,
          id: taskId,
          title,
          goal,
          status: 'draft',
          workspaceId: asString(args.workspaceId) ?? '',
          priority,
          commandId: asString(args.commandId) ?? '',
          assignments: [],
          acceptance: [],
          ...(depends.dependsOn.length > 0 ? { dependsOn: depends.dependsOn } : {}),
          timeline: [{ at: timestamp, type: 'created' as const, text: '任务已创建（draft）' }],
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastActivityAt: timestamp,
        }
        await deps.stores.tasks.put(task)
        deps.onTaskChanged?.(task)
        return {
          taskId: task.id,
          status: 'draft',
          version: task.version,
          dependsOn: task.dependsOn ?? [],
          waitingFor: waitingFor(task, lookup),
          ready: isReady(task, lookup),
        }
      },
    })
    const commander_task_get = wrap({
      name: 'commander_task_get',
      description: 'Read one task (goal/acceptance/reportSummary/acceptanceHistory/pendingInstruction + latest version/status/round/dependsOn/waitingFor/ready/block/pendingDispatch/acceptanceCount). Read-only; call before composing a dispatch prompt, and before commander_task_update to get expectedRevision.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                version: { type: 'number', required: true },
                title: { type: 'string', required: true },
                goal: { type: 'string', required: true },
                status: { type: 'string', required: true },
                round: { type: 'number', required: true },
                workspaceId: { type: 'string', required: true },
                priority: { type: 'string', required: true },
                dependsOn: { type: 'array', items: { type: 'string' }, required: true },
                waitingFor: { type: 'array', items: { type: 'string' }, required: true },
                ready: { type: 'boolean', required: true },
                primarySessionId: { type: 'string' },
                acceptance: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      text: { type: 'string', required: true },
                      verify: { type: 'string' },
                      evidence: { type: 'string' },
                      state: { type: 'string', required: true },
                    },
                  },
                },
                acceptanceHistory: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      round: { type: 'number', required: true },
                      at: { type: 'number', required: true },
                      items: {
                        type: 'array',
                        required: true,
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          properties: {
                            id: { type: 'string', required: true },
                            text: { type: 'string', required: true },
                            verify: { type: 'string' },
                            evidence: { type: 'string' },
                            state: { type: 'string', required: true },
                          },
                        },
                      },
                      reportSummary: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          text: { type: 'string', required: true },
                          at: { type: 'number', required: true },
                          round: { type: 'number' },
                        },
                      },
                    },
                  },
                },
                reportSummary: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    text: { type: 'string', required: true },
                    at: { type: 'number', required: true },
                    round: { type: 'number' },
                  },
                },
                pendingInstruction: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    text: { type: 'string', required: true },
                    at: { type: 'number', required: true },
                  },
                },
                block: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    reason: { type: 'string', required: true },
                    code: { type: 'string' },
                    since: { type: 'number', required: true },
                  },
                },
                pendingDispatch: { type: 'boolean', required: true },
                acceptanceCount: { type: 'number', required: true },
                evidenceInsufficientCount: { type: 'number', required: true },
                updatedAt: { type: 'number', required: true },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as Record<string, unknown>
          if (record.ok === false) return `Rejected: ${String(record.code ?? '?')} — ${String(record.message ?? '')}`
          const view = {
            id: record.id,
            version: record.version,
            title: record.title,
            goal: record.goal,
            status: record.status,
            round: record.round,
            workspaceId: record.workspaceId,
            priority: record.priority,
            dependsOn: record.dependsOn ?? [],
            waitingFor: record.waitingFor ?? [],
            ready: record.ready,
            ...(record.primarySessionId !== undefined ? { primarySessionId: record.primarySessionId } : {}),
            acceptance: record.acceptance ?? [],
            ...(record.acceptanceHistory !== undefined ? { acceptanceHistory: record.acceptanceHistory } : {}),
            ...(record.reportSummary !== undefined ? { reportSummary: record.reportSummary } : {}),
            ...(record.pendingInstruction !== undefined ? { pendingInstruction: record.pendingInstruction } : {}),
            ...(record.block !== undefined ? { block: record.block } : {}),
            pendingDispatch: record.pendingDispatch,
            acceptanceCount: record.acceptanceCount,
            evidenceInsufficientCount: record.evidenceInsufficientCount,
            updatedAt: record.updatedAt,
          }
          return JSON.stringify(view)
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const taskId = asString(args.taskId)
        if (taskId === undefined) return failure('invalid_request', 'taskId is required')
        const task = deps.stores.tasks.get(taskId)
        if (task === undefined) return failure('unknown_task', `task '${taskId}' not found`)
        const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
        return {
          id: task.id,
          version: task.version,
          title: task.title,
          goal: task.goal,
          status: task.status,
          round: task.round ?? 1,
          workspaceId: task.workspaceId,
          priority: task.priority,
          dependsOn: task.dependsOn ?? [],
          waitingFor: waitingFor(task, lookup),
          ready: isReady(task, lookup),
          ...(task.primarySessionId !== undefined ? { primarySessionId: task.primarySessionId } : {}),
          acceptance: acceptanceView(task.acceptance),
          ...(task.acceptanceHistory !== undefined && task.acceptanceHistory.length > 0
            ? {
                acceptanceHistory: task.acceptanceHistory.map((entry) => ({
                  round: entry.round,
                  at: entry.at,
                  items: acceptanceView(entry.items),
                  ...(entry.reportSummary !== undefined ? { reportSummary: summaryView(entry.reportSummary) } : {}),
                })),
              }
            : {}),
          ...(task.reportSummary !== undefined ? { reportSummary: summaryView(task.reportSummary) } : {}),
          ...(task.pendingInstruction !== undefined
            ? { pendingInstruction: { text: task.pendingInstruction.text, at: task.pendingInstruction.at } }
            : {}),
          ...(task.block !== undefined ? {
            block: {
              reason: task.block.reason,
              ...(task.block.code !== undefined ? { code: task.block.code } : {}),
              since: task.block.since,
            },
          } : {}),
          pendingDispatch: deps.hasPendingDispatch?.(taskId) === true,
          acceptanceCount: task.acceptance.length,
          evidenceInsufficientCount: task.acceptance.filter((item) => item.state === 'insufficient').length,
          updatedAt: task.updatedAt,
        }
      },
    })
    const commander_task_update = wrap({
      name: 'commander_task_update',
      description: 'Update task metadata/dependencies/blocked/cancel/recover via an action enum. Requires expectedRevision (from commander_task_get); stale revision is rejected without writing. Never accepts a raw status; done/archived are human routes.',
      parameters: {
        taskId: { type: 'string', required: true },
        expectedRevision: { type: 'number', required: true, description: 'Latest task version from commander_task_get' },
        action: { type: 'string', required: true, enum: ['edit', 'set_dependencies', 'block', 'cancel', 'recover'] },
        title: { type: 'string', description: 'edit only' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'edit only' },
        progress: { type: 'object', additionalProperties: true, description: 'edit only: {label, pct?}' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'set_dependencies only: ≤5 task ids, no cycles' },
        reason: { type: 'string', description: 'block only: non-empty reason' },
        recoverTo: { type: 'string', enum: ['proposed', 'review', 'running'], description: 'recover only' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                version: { type: 'number', required: true },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { taskId?: string; status?: string; version?: number; ok?: boolean; code?: string; message?: string }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          return `Task ${record.taskId ?? '?'} updated: status=${record.status ?? '?'} version=${record.version ?? '?'}`
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const taskId = asString(args.taskId)
        if (taskId === undefined) return failure('invalid_request', 'taskId is required')
        const expectedRevision = args.expectedRevision
        if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
          return failure('invalid_request', 'expectedRevision is required (get it from commander_task_get)')
        }
        const action = asString(args.action)
        if (action === undefined || !['edit', 'set_dependencies', 'block', 'cancel', 'recover'].includes(action)) {
          return failure('invalid_request', 'action must be edit|set_dependencies|block|cancel|recover')
        }
        const allowedFields: Record<string, readonly string[]> = {
          edit: ['title', 'priority', 'progress'],
          set_dependencies: ['dependsOn'],
          block: ['reason'],
          cancel: [],
          recover: ['recoverTo'],
        }
        for (const key of Object.keys(args)) {
          if (key === 'taskId' || key === 'expectedRevision' || key === 'action') continue
          if (args[key] === undefined) continue
          if (!(allowedFields[action] ?? []).includes(key)) {
            return failure('invalid_request', `field '${key}' is not allowed for action '${action}'`)
          }
        }
        const task = deps.stores.tasks.get(taskId)
        if (task === undefined) return failure('unknown_task', `task '${taskId}' not found`)
        if (task.version !== expectedRevision) {
          return failure('task_stale_revision', `expected revision ${expectedRevision}, current ${task.version}; call commander_task_get again`)
        }
        const pending = deps.hasPendingDispatch?.(taskId) === true
        if (pending && action !== 'cancel') {
          return failure('conflict', 'pending_dispatch: 该任务有待确认派发，请先处理确认卡或取消')
        }
        const timestamp = now()
        const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
        if (action === 'edit') {
          if (isTerminalStatus(task.status)) return failure('invalid_status', `cannot edit task in status ${task.status}`)
          if (args.title !== undefined && typeof args.title !== 'string') return failure('invalid_request', 'title must be a string')
          if (args.priority !== undefined && typeof args.priority !== 'string') return failure('invalid_request', 'priority must be a string')
          if (args.progress !== undefined && !isRecord(args.progress)) return failure('invalid_request', 'progress must be an object')
          const title = asString(args.title)
          const priorityRaw = asString(args.priority)
          if (priorityRaw !== undefined && !['low', 'normal', 'high', 'urgent'].includes(priorityRaw)) {
            return failure('invalid_request', 'priority must be low|normal|high|urgent')
          }
          const progress = isRecord(args.progress) ? args.progress : undefined
          if (progress !== undefined && (typeof progress.label !== 'string' || (progress.pct !== undefined && (typeof progress.pct !== 'number' || progress.pct < 0 || progress.pct > 1)))) {
            return failure('invalid_request', 'progress must be {label: string, pct?: 0..1}')
          }
          try {
            const updated = await deps.stores.tasks.update(taskId, (current) => ({
              ...current,
              ...(title !== undefined ? { title } : {}),
              ...(priorityRaw !== undefined ? { priority: priorityRaw as Priority } : {}),
              ...(progress !== undefined ? { progress: { label: progress.label as string, ...(typeof progress.pct === 'number' ? { pct: progress.pct } : {}), at: timestamp } } : {}),
              updatedAt: timestamp,
              lastActivityAt: timestamp,
              timeline: appendTimeline(current.timeline, { at: timestamp, type: 'user_edit', text: `指挥官编辑任务元数据（action=edit）` }),
            }), expectedRevision)
            deps.onTaskChanged?.(updated)
            return { taskId: updated.id, status: updated.status, version: updated.version }
          } catch {
            return failure('task_stale_revision', 'task version changed; call commander_task_get again')
          }
        }
        if (action === 'set_dependencies') {
          if (!Array.isArray(args.dependsOn)) return failure('invalid_request', 'dependsOn array is required for action=set_dependencies')
          if (!(task.status === 'draft' || task.status === 'proposed' || (task.status === 'blocked' && (task.round ?? 1) === 1))) {
            return failure('invalid_status', `set_dependencies is only allowed in draft/proposed/blocked(round 1), current ${task.status}`)
          }
          const depends = validateDependsOn(taskId, args.dependsOn, lookup, deps.stores.tasks.list())
          if (!depends.ok) return failure(depends.code, depends.message)
          try {
            const updated = await deps.stores.tasks.update(taskId, (current) => {
              const {
                dependsOn: _oldDependsOn,
                dependencyNotifiedAt: _oldNotifiedAt,
                ...rest
              } = current
              void _oldDependsOn
              void _oldNotifiedAt
              return {
                ...rest,
                ...(depends.dependsOn.length > 0 ? { dependsOn: depends.dependsOn } : {}),
                updatedAt: timestamp,
                timeline: appendTimeline(current.timeline, { at: timestamp, type: 'user_edit', text: `依赖更新为 ${depends.dependsOn.join(',') || '无'}` }),
              }
            }, expectedRevision)
            deps.onTaskChanged?.(updated)
            await deps.dependencyNotifier?.afterTasksChanged?.(taskId)
            return { taskId: updated.id, status: updated.status, version: updated.version }
          } catch {
            return failure('task_stale_revision', 'task version changed; call commander_task_get again')
          }
        }
        if (action === 'block') {
          const reason = asString(args.reason)
          if (reason === undefined) return failure('invalid_request', 'reason is required for action=block')
          if (!(task.status === 'draft' || task.status === 'proposed' || task.status === 'queued' || task.status === 'running')) {
            return failure('invalid_status', `block is only allowed from draft/proposed/queued/running, current ${task.status}`)
          }
          const transition = await transitionTask({ stores: deps.stores, now, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) }, {
            taskId,
            to: 'blocked',
            actor: 'commander_tool',
            context: { blockReason: reason },
            expectedVersion: expectedRevision,
            timelineText: `指挥官标记受阻：${reason}`,
            mutate: (_current, at) => ({ block: { reason, since: at } }),
          })
          if (!transition.ok) return failure(transition.code, transition.message)
          return { taskId, status: transition.task.status, version: transition.task.version }
        }
        if (action === 'cancel') {
          if (isTerminalStatus(task.status)) return failure('invalid_status', `cannot cancel task in status ${task.status}`)
          // 取消必须先停掉关联的在跑会话；失败不落状态。
          const stop = await stopTaskSessions(deps.ctx, deps.stores, taskId, deps.onDiagnostic)
          if (stop.failed.length > 0) {
            const detail = stop.failed.map((item) => `${item.sessionId}: ${item.message}`).join('; ').slice(0, 600)
            return failure('delivery_failed', `取消任务前停止工作会话失败：${detail}`)
          }
          const transition = await transitionTask({ stores: deps.stores, now, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) }, {
            taskId,
            to: 'cancelled',
            actor: 'commander_tool',
            expectedVersion: expectedRevision,
            timelineText: `指挥官取消任务${stop.stopped.length > 0 ? `；已停止 ${stop.stopped.length} 个关联会话` : ''}`,
          })
          if (!transition.ok) {
            if (transition.code === 'version_conflict') return failure('task_stale_revision', 'task version changed; call commander_task_get again')
            return failure(transition.code, transition.message)
          }
          deps.onTaskSettled?.(taskId)
          await deps.dependencyNotifier?.afterDependencyInvalidated?.(taskId)
          return { taskId, status: transition.task.status, version: transition.task.version }
        }
        // recover
        const recoverTo = asString(args.recoverTo) as TaskStatus | undefined
        if (recoverTo !== 'proposed' && recoverTo !== 'review' && recoverTo !== 'running') {
          return failure('invalid_request', 'recoverTo must be proposed|review|running')
        }
        if (task.status !== 'blocked') return failure('invalid_status', `recover is only allowed from blocked, current ${task.status}`)
        const transition = await transitionTask({ stores: deps.stores, now, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) }, {
          taskId,
          to: recoverTo,
          actor: 'commander_tool',
          expectedVersion: expectedRevision,
          timelineText: `从受阻恢复为 ${recoverTo}`,
        })
        if (!transition.ok) return failure(transition.code, transition.message)
        await deps.dependencyNotifier?.afterTasksChanged?.(taskId)
        return { taskId, status: transition.task.status, version: transition.task.version }
      },
    })
    const commander_task_dispatch = wrap({
      name: 'commander_task_dispatch',
      description: 'Dispatch a task. First call always returns needs_confirmation with decisionId; confirm by calling again with decisionId + confirmTarget. `prompt` is the working session message you write yourself: the Host sends it verbatim (no template, no prefix, no clipping) — include task title/goal/acceptance hints/constraints/previous-round summary yourself. Required on the first call; on confirm you may omit it to reuse the one stored with the confirmation card.',
      parameters: {
        taskId: { type: 'string', required: true },
        candidate: { type: 'object', additionalProperties: true, description: '{workspaceId, mode:"new"|"attach", sessionId?}' },
        decisionId: { type: 'string', description: 'decision id returned by needs_confirmation' },
        confirmTarget: { type: 'object', additionalProperties: true, description: '{workspaceId, mode:"new"|"attach", sessionId?}' },
        prompt: { type: 'string', description: '工作会话收到的第一条消息全文（你自己写；Host 原样投递，不加模板、不截断）。首次调用必填，确认调用可省略' },
        capabilityNeeds: { type: 'array', items: { type: 'string' }, description: 'natural language capability hints (≤40 chars/项)' },
        userRequest: { type: 'string', description: '用户原话（只用于展示/审计，不写进 prompt，≤2000 chars）' },
        requestId: { type: 'string', required: true },
      },
      output: {
        schema: dispatchTaskOutputSchema,
        render: textRender((value) => {
          const record = (value ?? {}) as {
            status?: string
            taskId?: string
            decisionId?: string
            sessionId?: string
            reason?: string
            kind?: string
            round?: number
            code?: string
            message?: string
            candidates?: Array<{ workspaceId?: string; workspaceName?: string; mode?: string; sessionId?: string }>
            recommendation?: { workspaceId?: string; mode?: string; sessionId?: string }
            scores?: { pWorkspace?: number; pSession?: number; pMax?: number; concentration?: number }
            target?: { workspaceId?: string; mode?: string; sessionId?: string }
          }
          if (record.status === 'needs_confirmation') {
            const lines = [
              `Needs confirmation (decisionId=${record.decisionId ?? '?'}, reason=${record.reason ?? '?'}, kind=${record.kind ?? '?'}, round=${record.round ?? '?'})`,
              `scores: pWorkspace=${record.scores?.pWorkspace ?? '?'} pSession=${record.scores?.pSession ?? '?'} pMax=${record.scores?.pMax ?? '?'} concentration=${record.scores?.concentration ?? '?'}`,
              `recommendation: workspaceId=${record.recommendation?.workspaceId ?? '?'} mode=${record.recommendation?.mode ?? '?'}${record.recommendation?.sessionId !== undefined ? ` sessionId=${record.recommendation.sessionId}` : ''}`,
              'candidates:',
            ]
            for (const candidate of record.candidates ?? []) {
              lines.push(`- workspaceId=${candidate.workspaceId ?? '?'} name=${candidate.workspaceName ?? '?'} mode=${candidate.mode ?? '?'}${candidate.sessionId !== undefined ? ` sessionId=${candidate.sessionId}` : ''}`)
            }
            lines.push('等待用户答复；用户确认后带 decisionId+confirmTarget 再次调用。')
            return lines.join('\n')
          }
          if (record.status === 'dispatched') {
            return `Dispatched task ${record.taskId ?? '?'} (round ${record.round ?? '?'}) to workspaceId=${record.target?.workspaceId ?? '?'} mode=${record.target?.mode ?? '?'} sessionId=${record.target?.sessionId ?? record.sessionId ?? '?'}`
          }
          return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const result = await deps.dispatchService.dispatchTask({
          taskId: args.taskId,
          candidate: args.candidate,
          decisionId: args.decisionId,
          confirmTarget: args.confirmTarget,
          prompt: args.prompt,
          capabilityNeeds: args.capabilityNeeds,
          userRequest: args.userRequest,
          requestId: args.requestId,
        })
        // 派完一个再提醒下一个：成功/拒绝后都 pump 一次（有待确认卡时 notifier 自行等待）。
        await deps.dependencyNotifier?.afterDispatchSettled?.()
        return result
      },
    })
    const commander_task_list = wrap({
      name: 'commander_task_list',
      description: 'Query tasks: filter by statuses, time range and title text, then paginate. Returns matched total, per-column counts, the global pending dispatch, and one row per task (version/round/dispatchable/waitingFor/blockReason). Use commander_task_get for details. Read-only.',
      parameters: {
        statuses: { type: 'array', items: { type: 'string' }, description: 'Exact statuses: draft|proposed|queued|running|blocked|review|done|cancelled|archived. Omit = active 7 (cancelled/archived excluded).' },
        includeArchived: { type: 'boolean', description: 'Include cancelled/archived (only when statuses is omitted).' },
        q: { type: 'string', description: 'Case-insensitive substring search; whitespace splits tokens and all must match (<=200 chars, <=8 tokens).' },
        searchIn: { type: 'array', items: { type: 'string' }, description: 'Fields to search: title|goal|reportSummary (default title).' },
        timeField: { type: 'string', description: 'created|updated|activity (default created).' },
        since: { type: 'string', description: 'Lower bound (inclusive). Format "2026-10-12" or "2026-10-12 14:40" (local time; optional Z/+08:00). Not epoch.' },
        until: { type: 'string', description: 'Upper bound (exclusive). Date-only means end of that day. Same format as since.' },
        limit: { type: 'number', description: 'Page size 1..100 (default 20).' },
        offset: { type: 'number', description: 'Page offset 0..10000 (default 0).' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'number', required: true },
                offset: { type: 'number', required: true },
                limit: { type: 'number', required: true },
                returned: { type: 'number', required: true },
                hasMore: { type: 'boolean', required: true },
                nextOffset: { type: 'number' },
                now: { type: 'string', required: true },
                counts: { ...countsSchema, required: true },
                columns: { ...columnsSchema, required: true },
                pendingDispatch: pendingDispatchSchema,
                tasks: { type: 'array', required: true, items: taskListRowSchema },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as {
            ok?: boolean
            code?: string
            message?: string
            total?: number
            offset?: number
            limit?: number
            returned?: number
            hasMore?: boolean
            nextOffset?: number
            now?: string
            columns?: Record<string, number>
            pendingDispatch?: { taskId?: string; expiresAt?: number }
            tasks?: Array<Record<string, unknown>>
          }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const offset = record.offset ?? 0
          const returned = record.returned ?? 0
          const start = returned === 0 ? 0 : offset + 1
          const lines = [
            `Board: total=${record.total ?? 0}, page=${start}..${offset + returned} (offset=${offset} limit=${record.limit ?? 0} hasMore=${record.hasMore === true} nextOffset=${record.nextOffset === undefined ? 'null' : String(record.nextOffset)}), now=${record.now ?? '?'}`,
            `columns: ${JSON.stringify(record.columns ?? {})}`,
            record.pendingDispatch !== undefined && record.pendingDispatch !== null
              ? `pending: ${JSON.stringify({ taskId: record.pendingDispatch.taskId, expiresAt: record.pendingDispatch.expiresAt })}`
              : 'pending: none',
          ]
          const rows = (record.tasks ?? []).map((task) => ({
            id: task.id,
            title: clipLine(String(task.title ?? ''), TASK_TITLE_CHARS),
            status: task.status,
            column: task.column,
            priority: task.priority,
            workspaceId: task.workspaceId,
            workspaceName: task.workspaceName,
            version: task.version,
            round: task.round,
            dispatchable: task.dispatchable,
            ...(task.waitingFor !== undefined ? { waitingFor: task.waitingFor } : {}),
            ...(task.blockReason !== undefined ? { blockReason: clipLine(String(task.blockReason), TASK_BLOCK_REASON_CHARS) } : {}),
            ...(task.acceptanceCount !== 0 ? { acceptanceCount: task.acceptanceCount } : {}),
            age: ageLabel(Number(task.ageMinutes ?? 0)),
            ...(task.pendingInstruction === true ? { pendingInstruction: true } : {}),
          }))
          lines.push(`tasks: ${JSON.stringify(rows)}`)
          if (rows.length === 0) lines.push('（没有命中任务：可放宽条件，或传 includeArchived: true 查回收站）')
          return lines.join('\n')
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const parsed = parseTaskQueryArgs(args)
        if (!parsed.ok) return failure(parsed.code, parsed.message)
        const all = deps.stores.tasks.list()
        const lookup = (id: string): TaskRecord | undefined => deps.stores.tasks.get(id)
        const result = queryTasks({ tasks: all, filter: parsed.filter, lookup })
        const directory = await collectWorkspaceDirectory({ ctx: deps.ctx, stores: deps.stores })
        const workspaceNameById = new Map(directory.map((entry) => [entry.id, entry.name]))
        const timestamp = now()
        const rows = result.tasks.map((task) => buildTaskRow({ task, now: timestamp, lookup, workspaceNameById }))
        const pending = deps.dispatchService.currentPending()
        return {
          total: result.total,
          offset: parsed.filter.offset,
          limit: parsed.filter.limit,
          returned: rows.length,
          hasMore: result.hasMore,
          ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
          now: formatLocalDateTime(timestamp),
          counts: result.counts,
          columns: result.columns,
          ...(pending !== null ? { pendingDispatch: { taskId: pending.taskId, expiresAt: pending.expiresAt } } : {}),
          tasks: rows,
        }
      },
    })
    const commander_workspace_list = wrap({
      name: 'commander_workspace_list',
      description: 'List workspaces that are ENABLED in settings (id/name/path/summary). These are the only valid candidate.workspaceId values for commander_task_dispatch. Read-only.',
      parameters: {},
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'number', required: true },
                workspaces: { type: 'array', required: true, items: workspaceRowSchema },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { ok?: boolean; code?: string; message?: string; total?: number; workspaces?: Array<Record<string, unknown>> }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const rows = (record.workspaces ?? []).map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            path: workspace.path,
            policy: workspace.policy,
            summary: clipLine(String(workspace.summary ?? ''), 60),
            sessions: workspace.sessionCount,
          }))
          const lines = [`Workspaces: total=${record.total ?? 0}`, `workspaces: ${JSON.stringify(rows)}`]
          if (rows.length === 0) lines.push('（当前没有启用任何工作区，需先在设置页启用后再派发）')
          return lines.join('\n')
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        for (const key of Object.keys(args)) {
          if (args[key] !== undefined) return failure('invalid_request', `unknown parameter '${key}'；commander_workspace_list 不接受参数`)
        }
        const directory = await collectWorkspaceDirectory({ ctx: deps.ctx, stores: deps.stores })
        const workspaces = listEnabledWorkspaces(directory)
        return { total: workspaces.length, workspaces }
      },
    })
    const commander_workspace_update = wrap({
      name: 'commander_workspace_update',
      description: `Update one workspace's summary — the same note humans edit in Settings > Workspaces > Summary (≤${WORKSPACE_SUMMARY_MAX} chars; empty string clears it). Only the summary is writable: allowlist and capability policy stay human-only. Works for any registered workspace (enabled or not); use commander_workspace_list to read current summaries. Keep it a stable description of what the workspace is for, not per-task instructions.`,
      parameters: {
        workspaceId: { type: 'string', required: true, description: 'Workspace id, name, or path (case-insensitive; ambiguous names are rejected).' },
        summary: { type: 'string', required: true, description: `New summary (0..${WORKSPACE_SUMMARY_MAX} chars). Empty string clears it.` },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                workspaceId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                summarySource: { type: 'string', enum: ['model'], required: true },
                summaryUpdatedAt: { type: 'number' },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { ok?: boolean; code?: string; message?: string; workspaceId?: string; name?: string; summary?: string; summarySource?: string; summaryUpdatedAt?: number }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const summary = String(record.summary ?? '')
          const updated = typeof record.summaryUpdatedAt === 'number' ? `, updatedAt=${record.summaryUpdatedAt}` : ''
          return [
            `Workspace summary saved: ${record.workspaceId ?? '?'} (${record.name ?? '?'})`,
            `summary(${String(summary.length)}/${WORKSPACE_SUMMARY_MAX}): ${JSON.stringify(summary)}`,
            `source=${record.summarySource ?? '?'}${updated}`,
          ].join('\n')
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        for (const key of Object.keys(args)) {
          if (args[key] !== undefined && key !== 'workspaceId' && key !== 'summary') {
            return failure('invalid_request', `unknown parameter '${key}'；commander_workspace_update 只接受 workspaceId/summary`)
          }
        }
        const reference = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
        if (reference === '') return failure('invalid_request', 'workspaceId is required（工作区 id/名称/路径）')
        if (typeof args.summary !== 'string') return failure('invalid_request', 'summary is required（0..500 字；空串表示清空）')
        if (args.summary.length > WORKSPACE_SUMMARY_MAX) return failure('invalid_request', `summary exceeds ${WORKSPACE_SUMMARY_MAX} characters`)
        const summary = args.summary.trim()
        const directory = await collectWorkspaceDirectory({ ctx: deps.ctx, stores: deps.stores })
        const resolution = resolveWorkspaceReference(directory, reference)
        if (resolution.status === 'ambiguous') {
          return failure('invalid_request', `workspace "${reference}" 匹配到多个工作区：${resolution.candidates.map((entry) => entry.id).join(', ')}；请用 id 精确指定`)
        }
        if (resolution.status === 'not_found') {
          const known = directory.map((entry) => entry.id).slice(0, 20).join(', ')
          return failure('unknown_workspace', `workspace "${reference}" not found${known !== '' ? `；known: ${known}` : ''}`)
        }
        const entry = resolution.workspace
        const timestamp = now()
        const apply = (current: WorkspaceRecord): WorkspaceRecord => {
          const next: WorkspaceRecord = { ...current, summary, summarySource: 'model' }
          if (summary !== '') next.summaryUpdatedAt = timestamp
          else delete next.summaryUpdatedAt
          return next
        }
        const existing = deps.stores.workspaces.get(entry.id)
        const createRecord = (): WorkspaceRecord => apply(defaultWorkspaceRecord({ id: entry.id, name: entry.name !== '' ? entry.name : entry.id, path: entry.path }))
        let record: WorkspaceRecord
        if (existing === undefined) {
          record = createRecord()
          await deps.stores.workspaces.put(record)
        } else {
          // 原子读改写：人类可能同时改 allowed/policy，不能拿旧快照整条覆盖。
          const patched = await deps.stores.workspaces.patch(entry.id, apply)
          if (patched === undefined) {
            // 读后被人类整表替换删掉：按默认记录重建，确保摘要真的落盘。
            record = createRecord()
            await deps.stores.workspaces.put(record)
          } else {
            record = patched
          }
        }
        await deps.onWorkspaceChanged?.(record)
        return {
          workspaceId: record.id,
          name: record.name,
          summary: record.summary,
          summarySource: record.summarySource,
          ...(record.summaryUpdatedAt !== undefined ? { summaryUpdatedAt: record.summaryUpdatedAt } : {}),
        }
      },
    })
    const commander_session_list = wrap({
      name: 'commander_session_list',
      description: 'List root sessions of one workspace (attach targets for commander_task_dispatch). workspaceId is required and accepts workspace id, name, path or a cwd inside it. Excludes subagent/teammate/commander sessions; archived excluded unless includeArchived. Read-only.',
      parameters: {
        workspaceId: { type: 'string', required: true, description: 'Workspace id, name, path, or a cwd path inside the workspace.' },
        q: { type: 'string', description: 'Case-insensitive title substring (<=200 chars).' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions (default false).' },
        since: { type: 'string', description: 'Filter by lastActiveAt, inclusive. "2026-10-12" or "2026-10-12 14:40".' },
        until: { type: 'string', description: 'Filter by lastActiveAt, exclusive. Date-only means end of that day.' },
        limit: { type: 'number', description: 'Page size 1..100 (default 20).' },
        offset: { type: 'number', description: 'Page offset 0..10000 (default 0).' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'number', required: true },
                offset: { type: 'number', required: true },
                limit: { type: 'number', required: true },
                returned: { type: 'number', required: true },
                hasMore: { type: 'boolean', required: true },
                nextOffset: { type: 'number' },
                now: { type: 'string', required: true },
                workspace: { type: 'object', additionalProperties: false, required: true, properties: { id: { type: 'string', required: true }, name: { type: 'string', required: true } } },
                sessions: { type: 'array', required: true, items: sessionRowSchema },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as {
            ok?: boolean
            code?: string
            message?: string
            total?: number
            offset?: number
            limit?: number
            returned?: number
            hasMore?: boolean
            nextOffset?: number
            now?: string
            workspace?: { id?: string; name?: string }
            sessions?: Array<Record<string, unknown>>
          }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const offset = record.offset ?? 0
          const returned = record.returned ?? 0
          const start = returned === 0 ? 0 : offset + 1
          const workspace = record.workspace ?? {}
          const rows = (record.sessions ?? []).map((session) => ({
            sessionId: session.sessionId,
            title: clipLine(String(session.title ?? ''), TASK_TITLE_CHARS),
            age: ageLabel(Number(session.ageMinutes ?? 0)),
            archived: session.archived,
          }))
          return [
            `Sessions: total=${record.total ?? 0}, page=${start}..${offset + returned} (hasMore=${record.hasMore === true} nextOffset=${record.nextOffset === undefined ? 'null' : String(record.nextOffset)}), workspace=${workspace.id ?? '?'}(${workspace.name ?? '?'})`,
            `sessions: ${JSON.stringify(rows)}`,
          ].join('\n')
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const parsed = parseSessionQueryArgs(args)
        if (!parsed.ok) return failure(parsed.code, parsed.message)
        const timestamp = now()
        const result = await querySessions({ ctx: deps.ctx, stores: deps.stores, workspaceRef: parsed.workspaceId, filter: parsed.filter, now: timestamp })
        if (!result.ok) return failure(result.code, result.message)
        return {
          total: result.total,
          offset: result.offset,
          limit: result.limit,
          returned: result.returned,
          hasMore: result.hasMore,
          ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
          now: formatLocalDateTime(timestamp),
          workspace: result.workspace,
          sessions: result.sessions,
        }
      },
    })
    const commander_task_report = wrap({
      name: 'commander_task_report',
      description: 'Organize a work-session report into task acceptance/timeline/status and report-level materials. Only organizes; does not judge acceptance.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id' },
        sessionId: { type: 'string', required: true, description: 'Work session id bound to the task' },
        seqFrom: { type: 'number', required: true, description: 'Start seq of the report window (session event log)' },
        seqTo: { type: 'number', required: true, description: 'End seq of the report window' },
        outcome: { type: 'string', required: true, description: 'delivered|partial|blocked|no_progress' },
        acceptance: {
          type: 'array',
          required: true,
          items: { type: 'object', additionalProperties: true },
          description: 'Acceptance items: {text, verify?, evidence?, derivedFromSeq}',
        },
        materials: {
          type: 'array',
          description: 'Report-level supporting materials: links, local documents, screenshots. Work-session present files are merged automatically.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, enum: ['link', 'file', 'image'] },
              title: { type: 'string', required: true, description: 'Short user-facing title (≤200 chars)' },
              url: { type: 'string', description: 'http(s) URL for link or remote image' },
              path: { type: 'string', description: 'Local file path (workspace-relative or absolute under workspace/presented files)' },
              description: { type: 'string', description: 'Optional one-line description (≤500 chars)' },
              acceptanceIndex: { type: 'number', description: '0-based index into acceptance[] to associate this material with an item' },
              derivedFromSeq: { type: 'number', description: 'Session event seq this material came from; defaults to seqTo' },
            },
          },
        },
        summary: { type: 'string', required: true, description: 'Commander digest of the work session last reply (≤800 chars; Host stores it verbatim and does not verify the source text)' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                evidenceState: { type: 'string', enum: ['complete', 'insufficient'], required: true },
                insufficient: { type: 'array', items: { type: 'string' } },
                materials: { type: 'number', required: true },
                materialWarnings: { type: 'array', items: { type: 'string' } },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { taskId?: string; status?: string; evidenceState?: string; insufficient?: string[]; materials?: number; materialWarnings?: string[]; ok?: boolean; code?: string; message?: string }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const warning = (record.materialWarnings ?? []).length > 0 ? ` materialWarnings=${String((record.materialWarnings ?? []).length)}` : ''
          return `Report organized: taskId=${record.taskId ?? '?'} status=${record.status ?? '?'} evidenceState=${record.evidenceState ?? '?'} materials=${String(record.materials ?? 0)}${(record.insufficient ?? []).length > 0 ? ` insufficient=${(record.insufficient ?? []).length}` : ''}${warning}`
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const taskId = asString(args.taskId)
        const sessionId = asString(args.sessionId)
        const seqFrom = typeof args.seqFrom === 'number' ? args.seqFrom : undefined
        const seqTo = typeof args.seqTo === 'number' ? args.seqTo : undefined
        const outcome = asString(args.outcome)
        const summary = asString(args.summary) ?? ''
        if (taskId === undefined || sessionId === undefined) return { ok: false, code: 'invalid_request', message: 'taskId and sessionId are required' }
        if (seqFrom === undefined || seqTo === undefined || !Number.isInteger(seqFrom) || !Number.isInteger(seqTo) || seqFrom > seqTo) {
          return { ok: false, code: 'invalid_request', message: 'seqFrom/seqTo must be integers with seqFrom <= seqTo' }
        }
        if (outcome === undefined || !['delivered', 'partial', 'blocked', 'no_progress'].includes(outcome)) {
          return { ok: false, code: 'invalid_request', message: 'outcome must be delivered|partial|blocked|no_progress' }
        }
        if (summary.length > REPORT_SUMMARY_MAX) return { ok: false, code: 'invalid_request', message: `summary exceeds ${REPORT_SUMMARY_MAX} characters` }
        const task = deps.stores.tasks.get(taskId)
        if (task === undefined) return { ok: false, code: 'unknown_task', message: `task '${taskId}' not found` }
        const currentRound = task.round ?? 1
        if (currentRound > 1 && task.primarySessionId !== undefined && task.primarySessionId !== '' && sessionId !== task.primarySessionId) {
          return { ok: false, code: 'conflict', message: `session '${sessionId}' is not the primary session of round ${currentRound}` }
        }
        const bound = task.primarySessionId === sessionId || task.assignments.includes(sessionId)
        if (!bound) return { ok: false, code: 'conflict', message: `session '${sessionId}' is not bound to task '${taskId}'` }
        const rawAcceptance = Array.isArray(args.acceptance) ? (args.acceptance as unknown[]) : []
        const parsedAcceptance: Array<{ text: string; verify?: string; evidence?: string; derivedFromSeq: number }> = []
        for (const item of rawAcceptance.slice(0, 40)) {
          const record = (item ?? {}) as Record<string, unknown>
          const text = asString(record.text)
          if (text === undefined) return { ok: false, code: 'invalid_request', message: 'each acceptance item requires text' }
          const derivedFromSeq = typeof record.derivedFromSeq === 'number' ? record.derivedFromSeq : undefined
          if (derivedFromSeq === undefined || !Number.isInteger(derivedFromSeq)) {
            return { ok: false, code: 'invalid_request', message: 'each acceptance item requires integer derivedFromSeq' }
          }
          parsedAcceptance.push({
            text,
            ...(asString(record.verify) !== undefined ? { verify: asString(record.verify) as string } : {}),
            ...(asString(record.evidence) !== undefined ? { evidence: asString(record.evidence) as string } : {}),
            derivedFromSeq,
          })
        }
        // seq 区间校验（只读取 session 事件日志；不订阅/不改事件）。
        const events = await readSessionEvents(deps.ctx, sessionId)
        const seqs = events.map((event) => (typeof event.seq === 'number' ? event.seq : -1)).filter((seq) => seq >= 0)
        if (seqs.length > 0) {
          const minSeq = Math.min(...seqs)
          const maxSeq = Math.max(...seqs)
          if (seqFrom < minSeq || seqTo > maxSeq) {
            return { ok: false, code: 'invalid_request', message: `seq window ${seqFrom}..${seqTo} is outside session event range ${minSeq}..${maxSeq}` }
          }
          for (const item of parsedAcceptance) {
            if (item.derivedFromSeq < seqFrom || item.derivedFromSeq > seqTo) {
              return { ok: false, code: 'invalid_request', message: `acceptance derivedFromSeq ${item.derivedFromSeq} is outside report window ${seqFrom}..${seqTo}` }
            }
          }
        }
        if (!(task.status === 'queued' || task.status === 'running' || task.status === 'blocked')) {
          return { ok: false, code: 'invalid_status', message: `commander_task_report 只接受 queued/running/blocked 来源，当前 ${task.status}` }
        }
        const at = (deps.now ?? Date.now)()
        const nextStatus: TaskStatus = outcome === 'delivered' || outcome === 'partial' ? 'review' : outcome === 'blocked' ? 'blocked' : 'running'
        // ARCHITECTURE §6 不变量 2：review 至少 1 条 acceptance（blocked/no_progress 允许空；契约复核 HIGH）。
        if (nextStatus === 'review' && parsedAcceptance.length === 0) {
          return { ok: false, code: 'invalid_request', message: 'review requires at least 1 acceptance item；如需报告无验收项请用 outcome=blocked 或 no_progress' }
        }
        if (nextStatus === 'blocked' && summary === '') {
          return { ok: false, code: 'invalid_request', message: 'outcome=blocked requires a non-empty summary as the block reason' }
        }
        const acceptance = parsedAcceptance.map((item) => ({
          id: createId('task').replace(/^task_/, 'acc_'),
          text: item.text,
          ...(item.verify !== undefined ? { verify: item.verify } : {}),
          ...(item.evidence !== undefined ? { evidence: item.evidence } : {}),
          source: 'commander' as const,
          derivedFrom: { sessionId, seq: item.derivedFromSeq },
          state: item.evidence !== undefined && item.evidence !== '' ? ('evidence_present' as const) : ('insufficient' as const),
        }))
        const insufficient = acceptance.filter((item) => item.state === 'insufficient').map((item) => item.text)
        const workspaceRoot = deps.stores.workspaces.get(task.workspaceId)?.path
          ?? (deps.stores.config.get().commander.workspacePath !== '' ? deps.stores.config.get().commander.workspacePath : undefined)
        const materialResult = await buildReportMaterials({
          events,
          seqFrom,
          seqTo,
          sessionId,
          ...(workspaceRoot !== undefined && workspaceRoot !== '' ? { workspaceRoot } : {}),
          rawMaterials: Array.isArray(args.materials) ? args.materials : [],
          acceptance,
        })
        const reportFields = (current: TaskRecord) => ({
          acceptance,
          // summary 原文落库（看板抽屉「整理报告」行展示）；空串不写，保留上一次的摘要。
          ...(summary !== '' ? { reportSummary: { text: summary, at, round: currentRound } } : {}),
          // 材料每次重建（含 present 自动归并）；没有材料也写空数组，避免上一轮/上一次残留。
          reportMaterials: materialResult.materials,
        })
        if (nextStatus === task.status) {
          // running → running（no_progress）：没有状态迁移，只更新报告数据。
          const updated = await deps.stores.tasks.update(taskId, (current) => ({
            ...current,
            ...reportFields(current),
            ...(nextStatus === 'blocked' ? { block: { reason: summary, code: 'report_blocked', since: at } } : {}),
            lastActivityAt: at,
            updatedAt: at,
            timeline: appendTimeline(current.timeline, { at, type: 'report', round: currentRound, text: `整理报告：outcome=${outcome}，验收 ${acceptance.length} 条（证据不足 ${insufficient.length}），材料 ${materialResult.materials.length} 项` }),
          }), task.version)
          deps.onTaskChanged?.(updated)
          return {
            taskId,
            status: updated.status,
            evidenceState: insufficient.length === 0 ? 'complete' : 'insufficient',
            ...(insufficient.length > 0 ? { insufficient } : {}),
            materials: materialResult.materials.length,
            ...(materialResult.warnings.length > 0 ? { materialWarnings: materialResult.warnings } : {}),
          }
        }
        const transition = await transitionTask(
          { stores: deps.stores, now: () => at, ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}) },
          {
            taskId,
            to: nextStatus,
            actor: 'commander_tool',
            round: currentRound,
            timelineType: 'report',
            timelineText: `整理报告：outcome=${outcome}，验收 ${acceptance.length} 条（证据不足 ${insufficient.length}），材料 ${materialResult.materials.length} 项`,
            ...(nextStatus === 'blocked' ? { context: { blockReason: summary } } : { context: { acceptanceCount: acceptance.length } }),
            mutate: (current, reportAt) => ({
              ...reportFields(current),
              ...(nextStatus === 'blocked' ? { block: { reason: summary, code: 'report_blocked', since: reportAt } } : {}),
            }),
          },
        )
        if (!transition.ok) return { ok: false, code: transition.code, message: transition.message }
        const updated = transition.task
        return {
          taskId,
          status: updated.status,
          evidenceState: insufficient.length === 0 ? 'complete' : 'insufficient',
          ...(insufficient.length > 0 ? { insufficient } : {}),
          materials: materialResult.materials.length,
          ...(materialResult.warnings.length > 0 ? { materialWarnings: materialResult.warnings } : {}),
        }
      },
    })
    const commander_task_accept = wrap({
      name: 'commander_task_accept',
      description: 'Accept one task (review→done) on the user behalf ONLY when it has unfinished dependent tasks; otherwise rejected(code=no_dependents) and the human must accept on the board. Optional note is the handoff message carried into the [task-unblocked] reminder so it can be written into downstream dispatch prompts. Disabled when commander.allowCommanderAccept=false.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id in review' },
        note: { type: 'string', description: `Optional handoff note (≤${REWORK_COMMENT_MAX} chars); strongly recommended as acceptance evidence` },
        expectedRevision: { type: 'number', description: 'Optional task version from commander_task_get; stale revision is rejected' },
      },
      output: {
        schema: {
          oneOf: [
            toolErrorSchema,
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                taskId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                version: { type: 'number', required: true },
                acceptedBy: { type: 'string', enum: ['user', 'commander'], required: true },
                dependents: { type: 'array', items: { type: 'string' }, required: true },
                duplicate: { type: 'boolean', required: true },
              },
            },
          ],
        },
        render: textRender((value) => {
          const record = (value ?? {}) as { taskId?: string; status?: string; version?: number; dependents?: string[]; duplicate?: boolean; ok?: boolean; code?: string; message?: string }
          if (record.ok === false) return `Rejected: ${record.code ?? '?'}${record.message !== undefined ? ` — ${record.message}` : ''}`
          const dependents = record.dependents ?? []
          return `Task ${record.taskId ?? '?'} accepted: status=${record.status ?? '?'} version=${record.version ?? '?'}${record.duplicate === true ? ' (duplicate)' : ''}${dependents.length > 0 ? ` dependents=${dependents.join(',')}` : ''}`
        }),
      },
      execute: async (args: Record<string, unknown>, exec: ToolExecLike) => {
        exec.signal?.throwIfAborted?.()
        const scoped = ensureCommanderScope(exec)
        if (scoped !== null) return scoped
        const taskId = asString(args.taskId)
        if (taskId === undefined) return failure('invalid_request', 'taskId is required')
        const note = typeof args.note === 'string' ? args.note : undefined
        if (note !== undefined && note.trim().length > REWORK_COMMENT_MAX) {
          return failure('invalid_request', `note exceeds ${REWORK_COMMENT_MAX} characters`)
        }
        const task = deps.stores.tasks.get(taskId)
        if (task === undefined) return failure('unknown_task', `task '${taskId}' not found`)
        const dependents = dependentsOf(deps.stores.tasks.list(), taskId).map((item) => item.id)
        if (task.status === 'done') {
          return { taskId, status: task.status, version: task.version, acceptedBy: task.acceptedBy ?? 'user', dependents, duplicate: true }
        }
        if (task.status !== 'review') return failure('invalid_status', `commander_task_accept 只接受 review 任务，当前 ${task.status}`)
        if (deps.stores.config.get().commander.allowCommanderAccept === false) {
          return failure('accept_disabled', '指挥官验收已关闭（commander.allowCommanderAccept=false），请由人在看板验收')
        }
        if (!hasPendingDependents(deps.stores.tasks.list(), taskId)) {
          return failure('no_dependents', '该任务没有后续任务，请由人在看板验收')
        }
        if (args.expectedRevision !== undefined) {
          if (typeof args.expectedRevision !== 'number' || !Number.isInteger(args.expectedRevision)) {
            return failure('invalid_request', 'expectedRevision must be an integer')
          }
          if (task.version !== args.expectedRevision) {
            return failure('task_stale_revision', `expected revision ${String(args.expectedRevision)}, current ${task.version}; call commander_task_get again`)
          }
        }
        const result = await performAccept({
          stores: deps.stores,
          now,
          ...(deps.onTaskChanged !== undefined ? { onTaskChanged: deps.onTaskChanged } : {}),
          ...(deps.onTaskSettled !== undefined ? { onTaskSettled: deps.onTaskSettled } : {}),
          ...(deps.dependencyNotifier !== undefined ? { dependencyNotifier: deps.dependencyNotifier } : {}),
        }, taskId, { ...(note !== undefined ? { note } : {}), actor: 'commander' })
        if (!result.ok) return failure(result.kind === 'not_found' ? 'unknown_task' : result.kind, result.message)
        return {
          taskId: result.task.id,
          status: result.task.status,
          version: result.task.version,
          acceptedBy: result.task.acceptedBy ?? 'commander',
          dependents,
          duplicate: result.duplicate,
        }
      },
    })
    return { commander_task_create, commander_task_get, commander_task_update, commander_task_accept, commander_task_dispatch, commander_task_list, commander_task_report, commander_workspace_list, commander_workspace_update, commander_session_list }
  }
  const safeBuildSpecs = (): Record<CommanderToolName, unknown> | null => {
    try {
      return buildSpecs()
    } catch (error) {
      deps.onDiagnostic?.(`[commander] defineTool failed: ${String((error as Error)?.message ?? error)}`)
      return null
    }
  }

  /** 指挥官会话判定：root agent 只有 `id`，其它形态看 session；每次 step 求值（绑定可后置）。 */
  const commanderOnly = (context: { agent?: ToolAgentLike }): boolean => {
    const sessionId = agentSessionIdOf(context?.agent)
    return sessionId !== undefined && sessionId === deps.commanderSessionId()
  }

  return {
    /** 延迟加载 defineTool（install 之前调用）。 */
    async prepare(anchor?: string): Promise<void> {
      defineTool = await (deps.defineToolLoader ?? (() => loadDefineTool(anchor)))()
    },
    /**
     * 在插件 apply 里注册一次：5 个工具进**全局** tools 表（归属=本插件，插件面板才能正确识别来源），
     * 再用 `when` 把可见性/可调用性限定到当前指挥官会话（其它 agent 的 system prompt 看不到）。
     * 返回 false 表示 tools 服务缺失或全部注册失败（调用方按诊断日志降级）。
     */
    install(): boolean {
      let service: { register?: (definition: unknown, options?: { when?: (context: { agent?: ToolAgentLike }) => boolean }) => (() => void) | undefined } | undefined
      try {
        service = deps.ctx.get('tools') as typeof service
      } catch {
        service = undefined
      }
      if (service?.register === undefined) {
        deps.onDiagnostic?.('[commander] tools service is unavailable; commander tools are not registered')
        return false
      }
      const specs = (toolsSpecs ??= safeBuildSpecs())
      if (specs === null) return false
      let registeredCount = 0
      for (const name of COMMANDER_TOOL_NAMES) {
        try {
          const dispose = service.register(specs[name], { when: commanderOnly })
          if (typeof dispose === 'function') disposers.push(dispose)
          registeredCount += 1
        } catch (error) {
          deps.onDiagnostic?.(`[commander] tool '${name}' registration failed: ${String((error as Error)?.message ?? error)}`)
        }
      }
      if (registeredCount === 0) {
        deps.onDiagnostic?.('[commander] no commander tool could be registered')
        return false
      }
      return true
    },
    specs(): Record<CommanderToolName, unknown> | null {
      toolsSpecs ??= safeBuildSpecs()
      return toolsSpecs
    },
    dispose(): void {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose()
        } catch {
          /* 幂等 */
        }
      }
      disposers.length = 0
    },
  }
}

export type CommanderTools = ReturnType<typeof createCommanderTools>
