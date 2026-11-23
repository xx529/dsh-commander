// R1：交接简报（纯函数；零 IO、零模型调用、确定性输出）。
// 口径：docs/architecture/rotation-contract-patch.md §4。
import {
  BRIEF_BLOCK_REASON_CHARS,
  BRIEF_CONCLUSION_CHARS,
  BRIEF_MAX_CHARS,
  BRIEF_TASKS_MAX,
  BRIEF_TITLE_CHARS,
  BRIEF_UNFINISHED_MAX,
  BRIEF_USER_LINE_CHARS,
  BRIEF_USER_LINES_MAX,
  BRIEF_USER_TAIL_CHARS,
} from '../config.ts'
import type { Priority, TaskRecord, TaskStatus, TaskTimelineItem } from '../schema.ts'

export interface BriefUserLine {
  text: string
  at: number
}

export interface HandoffBriefInput {
  /** 注入时钟（纯函数：不读 Date.now）。 */
  now: number
  /** 本任起始时间（窗口左闭）。 */
  windowStart: number
  periodDays: number
  /** 被交接的旧任序号。 */
  generation: number
  workspace: { id: string; name: string }
  model: { provider: string; model: string }
  tasks: readonly TaskRecord[]
  userLines?: readonly BriefUserLine[]
  includeUserTail?: boolean
  pendingDispatch?: unknown
}

export interface HandoffBriefStats {
  chars: number
  tasks: number
  unfinished: number
  userLines: number
  truncated: boolean
}

export interface HandoffBrief {
  text: string
  stats: HandoffBriefStats
}

const UNFINISHED: readonly TaskStatus[] = ['proposed', 'queued', 'running', 'blocked', 'review']
const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

const pad = (value: number): string => String(value).padStart(2, '0')

/** 本地时区 `YYYY-MM-DD HH:mm`（展示用；判定不依赖它）。 */
export function formatLocalTime(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对时间（分钟精度；未来时间按 0 处理）。 */
export function formatRelativeTime(at: number, now: number): string {
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return '<1m'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}

/** 折叠空白、按码点截断（不切代理对）。 */
export function clipLine(text: string, max: number): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized)
  if (chars.length <= max) return normalized
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 结论：reportSummary 首句/首行优先，否则最近一条 timeline 文本。 */
export function taskConclusion(task: TaskRecord): string {
  const fromReport = task.reportSummary?.text
  if (typeof fromReport === 'string' && fromReport.trim() !== '') {
    const first = fromReport.split(/\r?\n|。|\.\s/)[0] ?? fromReport
    return clipLine(first, BRIEF_CONCLUSION_CHARS)
  }
  const timeline: TaskTimelineItem | undefined = task.timeline.length > 0 ? task.timeline[task.timeline.length - 1] : undefined
  if (timeline !== undefined && typeof timeline.text === 'string' && timeline.text.trim() !== '') {
    return clipLine(timeline.text, BRIEF_CONCLUSION_CHARS)
  }
  return ''
}

function unfinishedNote(task: TaskRecord, now: number): string {
  if (task.status === 'blocked') {
    const reason = task.block?.reason
    return reason !== undefined && reason.trim() !== '' ? `阻塞：${clipLine(reason, BRIEF_BLOCK_REASON_CHARS)}` : '阻塞'
  }
  if (task.status === 'review') return '等验收'
  if (task.status === 'proposed') return '待派发'
  return `最近活动 ${formatRelativeTime(task.lastActivityAt, now)}`
}

function renderTaskLine(task: TaskRecord): string {
  const title = clipLine(task.title, BRIEF_TITLE_CHARS)
  const conclusion = taskConclusion(task)
  return `- [${task.status}] ${title} (#${task.id})${conclusion === '' ? '' : ` — ${conclusion}`}`
}

function renderUnfinishedLine(task: TaskRecord, now: number): string {
  const title = clipLine(task.title, BRIEF_TITLE_CHARS)
  return `- [${task.status}] ${title} (#${task.id}) — ${unfinishedNote(task, now)}`
}

function renderUserLine(line: BriefUserLine): string {
  return `- "${clipLine(line.text, BRIEF_USER_LINE_CHARS)}"`
}

/**
 * 生成交接简报。规则见契约 §4.3：
 * - 任务窗口 `[windowStart, now]`、`status !== 'archived'`、按 `updatedAt` 倒序、≤20；
 * - 未完成按优先级 + 最近活动排序、≤10、永不裁剪；
 * - 用户原话取窗口内最后 ≤10 条、单条 ≤120 字、总 ≤800 字；
 * - 总量 ≤4096 字，超出先丢最旧的用户原话、再丢最旧的本周期任务，并加截断标记。
 */
export function buildHandoffBrief(input: HandoffBriefInput): HandoffBrief {
  const now = input.now
  const taskLines: string[] = input.tasks
    .filter((task) => task.status !== 'archived' && task.updatedAt >= input.windowStart && task.updatedAt <= now)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, BRIEF_TASKS_MAX)
    .map(renderTaskLine)

  const unfinished = input.tasks
    .filter((task) => UNFINISHED.includes(task.status))
    .sort((a, b) => (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, BRIEF_UNFINISHED_MAX)
  const unfinishedLines = unfinished.map((task) => renderUnfinishedLine(task, now))

  let userLines: string[] = []
  if (input.includeUserTail !== false) {
    userLines = (input.userLines ?? [])
      .filter((line) => line.at >= input.windowStart && line.at <= now)
      .sort((a, b) => a.at - b.at)
      .slice(-BRIEF_USER_LINES_MAX)
      .map(renderUserLine)
    let total = userLines.reduce((sum, line) => sum + Array.from(line).length, 0)
    while (userLines.length > 1 && total > BRIEF_USER_TAIL_CHARS) {
      const removed = userLines.shift() as string
      total -= Array.from(removed).length
    }
  }

  const pendingLine = describePendingDispatch(input.pendingDispatch)
  const workspaceId = input.workspace.id !== '' ? input.workspace.id : '未登记工作区'
  const modelText = input.model.provider !== '' || input.model.model !== ''
    ? `${input.model.provider !== '' ? input.model.provider : '未设置'}/${input.model.model !== '' ? input.model.model : '未设置'}`
    : '未设置'
  const header = [
    `[commander-handoff] 第 ${input.generation} 任交接简报`,
    `窗口：${formatLocalTime(input.windowStart)} → ${formatLocalTime(now)}（${input.periodDays} 天）`,
    `工作区：${input.workspace.name !== '' ? input.workspace.name : workspaceId}（${workspaceId}）· 模型：${modelText}`,
  ]
  const footer = '说明：本简报只是交接摘要；实时看板用 commander_task_list 查。'

  let truncated = false
  let dropped = 0
  const render = (): string => {
    const lines = [...header]
    if (taskLines.length > 0) lines.push(`本周期任务（${taskLines.length} 条）：`, ...taskLines)
    if (unfinishedLines.length > 0) lines.push(`当前未完成（${unfinishedLines.length} 条）：`, ...unfinishedLines)
    if (pendingLine !== '') lines.push('待确认派发：', pendingLine)
    if (userLines.length > 0) lines.push(`用户最近原话（${userLines.length} 条）：`, ...userLines)
    if (dropped > 0) lines.push(`…[简报已截断，另有 ${dropped} 条见看板]`)
    lines.push(footer)
    return lines.join('\n')
  }

  let text = render()
  while (Array.from(text).length > BRIEF_MAX_CHARS && userLines.length > 0) {
    userLines = userLines.slice(1)
    dropped += 1
    truncated = true
    text = render()
  }
  while (Array.from(text).length > BRIEF_MAX_CHARS && taskLines.length > 0) {
    taskLines.pop() // 本周期任务按 updatedAt 倒序，pop = 丢最旧
    dropped += 1
    truncated = true
    text = render()
  }
  if (Array.from(text).length > BRIEF_MAX_CHARS) {
    // 理论不可达（未完成段有界且永不裁剪）；兜底按码点硬截断并标记，避免投递超限。
    const chars = Array.from(text)
    text = `${chars.slice(0, Math.max(1, BRIEF_MAX_CHARS - 1)).join('')}…`
    truncated = true
  }

  return {
    text,
    stats: {
      chars: Array.from(text).length,
      tasks: taskLines.length,
      unfinished: unfinishedLines.length,
      userLines: userLines.length,
      truncated,
    },
  }
}

function describePendingDispatch(pending: unknown): string {
  if (pending === undefined || pending === null) return ''
  if (typeof pending !== 'object') return '- 存在未完成的派发确认'
  const record = pending as Record<string, unknown>
  const taskId = typeof record.taskId === 'string' ? record.taskId : ''
  return taskId !== '' ? `- 任务 #${taskId} 的派发确认仍待处理` : '- 存在未完成的派发确认'
}
