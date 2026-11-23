// 派发 brief 文本（plan §9.5 / m1-contract-patch §1.6 / m5-continue-dispatch §6）：
// 写入工作会话的第一条 prompt。只给工作会话它需要的信息（任务/目标/本轮要求/上一轮结论/验收提示/约束）；
// taskId/decisionId/sessionId 等关联关系只存在本插件持久化（tasks/dispatches/sessions 表），不再塞进 prompt。
import { DISPATCH_BRIEF_MAX_CHARS } from '../config.ts'
import type { AcceptanceItem } from '../schema.ts'

export interface BriefInput {
  title: string
  goal: string
  acceptance: AcceptanceItem[]
  /** 续派时的目标轮次（>1 时输出「本轮要求/上一轮结论」段）。 */
  round?: number
  /** 指挥官/看板批注合并后的本轮要求。 */
  instruction?: string
  /** 上一轮 commander_task_report 的结论原文。 */
  previousSummary?: string
  /** 上一轮验收项（用于告诉工作会话上一轮验收过什么）。 */
  previousAcceptance?: AcceptanceItem[]
  /** 续派目标就是上一轮同一会话：只发增量，避免重复整段目标/验收。 */
  sameSession?: boolean
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** 生成工作会话 brief（≤5 条验收提示；总长 ≤8KB；无 marker/元数据行）。 */
export function buildDispatchBrief(input: BriefInput): string {
  const instruction = (input.instruction ?? '').trim()
  const isContinue = (input.round ?? 1) > 1 || instruction !== ''
  const lines: string[] = [`任务：${clip(input.title, 200)}`]
  // 同一会话续派只发增量：目标/上一轮验收已经在上下文里，重复整段会制造“派发内容重复”。
  if (!isContinue || input.sameSession !== true) lines.push(`目标：${clip(input.goal, 2000)}`)
  if (isContinue) {
    lines.push(`本轮要求：${instruction !== '' ? clip(instruction, 2000) : '按上一轮结论继续补做/深入；先说明你本轮要做什么。'}`)
    const previousSummary = (input.previousSummary ?? '').trim()
    if (previousSummary !== '') lines.push(`上一轮结论：${clip(previousSummary, 800)}`)
    if (input.sameSession !== true) {
      const previousHints = (input.previousAcceptance ?? []).slice(0, 5).map(item => clip(item.text, 200)).filter(text => text !== '')
      if (previousHints.length > 0) lines.push(`上一轮验收项：${previousHints.map(text => `（上一轮）${text}`).join('；')}`)
    }
  } else {
    const hints = input.acceptance.slice(0, 5).map(item => item.text).filter(text => text !== '')
    if (hints.length > 0) lines.push(`验收提示：${hints.map(text => clip(text, 200)).join('；')}`)
  }
  lines.push('约束：你是工作会话，自己拆分与执行；结束时在会话里说明产出与证据（文件路径/命令/结果），不要维护看板。交付文件请调用 present（若可用），并在最后回复里给出关键链接/文档路径。')
  return clip(lines.join('\n'), DISPATCH_BRIEF_MAX_CHARS)
}
