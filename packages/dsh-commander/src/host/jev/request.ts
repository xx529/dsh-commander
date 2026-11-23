// Jev 请求构造（纯函数）：固定两段——工作区段与会话段。
// state 只放被判断的对象（task/command）；候选与其描述全部进 criteria（TypeSafe 语义）。
// 契约：ARCHITECTURE §5.1–§5.5（v2.5 两段式）。
import type { JevAnswers } from './parse.ts'

export interface DispatchWorkspaceInput {
  id: string
  name: string
  path: string
  summary: string
  /** 该工作区最近有活动的会话标题（≤10，已排除指挥官自身/子会话/归档）。 */
  recentSessionTitles: string[]
}

export interface DispatchSessionInput {
  id: string
  workspaceId: string
  title: string
  lastActiveAt: number
  contextUsage?: number
  /** 该会话的用户提问（按时间序；已截断/限额，见 config.JEV_SESSION_*）。 */
  userQuestions?: string[]
}

export interface DispatchTaskInput {
  title: string
  goal: string
  acceptanceHints?: string[]
  priority?: string
}

export interface DispatchCommandInput {
  text: string
  workspaceHint?: string
}

export interface JevRequestBody {
  model: string
  state: Record<string, unknown>
  questions: Record<string, unknown>
}

export interface BuiltJevRequest {
  mode: 'workspace' | 'session'
  body: JevRequestBody
  tokenEstimate: number
  wIndex: Map<string, string>
  sIndex: Map<string, string>
}

/** token 预算估算：JSON 字符数 / 3（ARCHITECTURE §5.2 的近似口径）。 */
export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 3)
}

/** 被判断对象：用户请求与转写需求；两段共用，不含任何候选。 */
function stateOf(input: { task: DispatchTaskInput; command?: DispatchCommandInput | undefined }): Record<string, unknown> {
  return {
    task: {
      title: input.task.title,
      goal: input.task.goal,
      ...(input.task.acceptanceHints !== undefined ? { acceptanceHints: input.task.acceptanceHints } : {}),
      ...(input.task.priority !== undefined ? { priority: input.task.priority } : {}),
    },
    command: input.command ?? { text: '' },
  }
}

/** 第 1 段：工作区。选项描述 = name/path/what/最近会话标题。 */
export function buildWorkspaceRequest(input: {
  model: string
  task: DispatchTaskInput
  command?: DispatchCommandInput
  workspaces: DispatchWorkspaceInput[]
}): BuiltJevRequest {
  const wIndex = new Map(input.workspaces.map((workspace, index) => [workspace.id, `w_${index}`]))
  const criteria: Record<string, unknown> = {}
  for (const workspace of input.workspaces) {
    criteria[wIndex.get(workspace.id) as string] = {
      name: workspace.name,
      path: workspace.path,
      what: workspace.summary !== '' ? workspace.summary : '未配置摘要',
      recentSessionTitles: workspace.recentSessionTitles.slice(0, 10),
    }
  }
  const body: JevRequestBody = {
    model: input.model,
    state: stateOf(input),
    questions: {
      workspace: {
        type: 'choice',
        instructions: '哪个工作区最适合承接这个任务？依据每个选项的 name/path/what 与最近会话标题判断。',
        criteria,
      },
    },
  }
  return { mode: 'workspace', body, tokenEstimate: estimateTokens(body), wIndex, sIndex: new Map() }
}

/** 第 2 段：所选工作区内的会话。选项描述 = 标题（+ 最近活动/上下文占用）。 */
export function buildSessionRequest(input: {
  model: string
  task: DispatchTaskInput
  command?: DispatchCommandInput
  workspace: DispatchWorkspaceInput
  sessions: DispatchSessionInput[]
}): BuiltJevRequest {
  const sIndex = new Map(input.sessions.map((session, index) => [session.id, `s_${index}`]))
  const criteria: Record<string, unknown> = { new: { what: '新建会话' } }
  for (const session of input.sessions) {
    criteria[sIndex.get(session.id) as string] = {
      what: session.title !== '' ? session.title : session.id,
      lastActiveAt: new Date(session.lastActiveAt).toISOString(),
      ...(session.contextUsage !== undefined ? { contextUsage: session.contextUsage } : {}),
      ...(session.userQuestions !== undefined && session.userQuestions.length > 0 ? { userQuestions: session.userQuestions } : {}),
    }
  }
  const body: JevRequestBody = {
    model: input.model,
    state: stateOf(input),
    questions: {
      session: {
        type: 'choice',
        instructions: '该工作区里哪个会话最合适？没有合适的已有会话就选 new。',
        criteria,
      },
    },
  }
  return { mode: 'session', body, tokenEstimate: estimateTokens(body), wIndex: new Map(), sIndex }
}

/** 把 Jev answer 的 synthetic choice 映射回真实 id；`new` 原样返回。 */
export function mapChoice(index: Map<string, string>, choice: string | null | undefined): string | null {
  if (choice === null || choice === undefined) return null
  if (choice === 'new') return 'new'
  for (const [realId, synthetic] of index) if (synthetic === choice) return realId
  return null
}

export interface MappedAnswers {
  workspaceId: string | null
  sessionId: string | null
  mode: 'new' | 'attach' | null
}

export function mapJevAnswers(answers: JevAnswers, wIndex: Map<string, string>, sIndex: Map<string, string>): MappedAnswers {
  const workspaceId = mapChoice(wIndex, answers.workspace?.choice)
  const sessionChoice = answers.session?.choice ?? null
  const sessionId = sessionChoice === null || sessionChoice === 'new' ? null : mapChoice(sIndex, sessionChoice)
  const mode = sessionChoice === 'new' ? 'new' : sessionId !== null ? 'attach' : null
  return { workspaceId, sessionId, mode }
}
