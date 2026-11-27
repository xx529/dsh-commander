// 气泡阶段推导 + 活动文案格式化 + 多行布局/动效决策。
//
// 文案由 Host 的 status.activity 提供（已折叠空白、截到 200 字符）；
// 这里再做一层 120 字符收口，并交给 CSS `line-clamp: 5` 兜住行数。
import type { ConnectionPhase } from './types'

export type BubblePhase = 'hidden' | 'working' | 'success'

/** 文案切换的动效：单行对单行走交叉淡化；涉及多行走「先出后进」，避免两段多行叠字。 */
export type BubbleTextMotion = 'none' | 'crossfade' | 'sequential'

/** 行高：12px × 1.35。与 `window-styles.ts` 的 `.dshcn-bubble-text` 保持一致。 */
export const BUBBLE_LINE_HEIGHT = 16.2
/** 最多 5 行，超出由 `line-clamp` 收口。 */
export const BUBBLE_MAX_ROWS = 5
/** pill 最大宽度：窗口 336 − 左右各 12 内边距。 */
export const BUBBLE_PILL_MAX_WIDTH = 312
/** 单行时的最小高度，保持既有视觉体量。 */
export const BUBBLE_PILL_MIN_HEIGHT = 44
/** 文案上限：约 5 行 × 24 字（Host 侧已截到 200 字符）。 */
export const BUBBLE_ACTIVITY_MAX_CHARS = 120

const PAD_X = 10 + 13
const PAD_Y = 8 + 8
const BORDER = 2
/** 勾选图标 24 + 与文本的 9px 间距。 */
const ICON_BLOCK = 24 + 9

/**
 * pill 目标宽度：内容宽 + 内边距 + 边框（有勾选图标时再加图标块），上限 312。
 * 文本不换行宽度够短时收窄，超过上限时固定满宽、由文本换行。
 */
export function bubblePillWidth(textWidth: number, hasIcon: boolean): number {
  const width = PAD_X + BORDER + (hasIcon ? ICON_BLOCK : 0) + Math.max(0, textWidth)
  return Math.min(BUBBLE_PILL_MAX_WIDTH, Math.ceil(width))
}

/** pill 内可用于文本的宽度。 */
export function bubbleContentWidth(pillWidth: number, hasIcon: boolean): number {
  return Math.max(0, pillWidth - PAD_X - BORDER - (hasIcon ? ICON_BLOCK : 0))
}

/** 由实测文本高度换算行数：1–5 行。 */
export function bubbleRowsFromHeight(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1
  const rows = Math.round(height / BUBBLE_LINE_HEIGHT)
  return Math.min(BUBBLE_MAX_ROWS, Math.max(1, rows))
}

/** 由行数换算 pill 高度（含上下内边距与边框），单行时兜到 44。 */
export function bubblePillHeight(rows: number): number {
  const safeRows = Math.min(BUBBLE_MAX_ROWS, Math.max(1, Math.round(rows)))
  return Math.max(BUBBLE_PILL_MIN_HEIGHT, Math.ceil(safeRows * BUBBLE_LINE_HEIGHT + PAD_Y + BORDER))
}

/**
 * 文案切换动效：
 * - 初次显示（没有上一行数）不需要内部切换；
 * - 单行 ↔ 单行：等时长线性交叉（两端透明度相加恒为 1，不闪空）；
 * - 只要涉及多行：先出后进（旧 90ms 淡出 → 新 160ms 淡入），避免两段多行叠在一起。
 */
export function bubbleTextMotion(prevRows: number | null, nextRows: number): BubbleTextMotion {
  if (prevRows === null) return 'none'
  return prevRows <= 1 && nextRows <= 1 ? 'crossfade' : 'sequential'
}

/**
 * 取最后一轮的 assistant 回复文本（气泡 success 态显示它，外框保留绿色打勾表示“这是回复”）。
 * 没有 assistant 消息时返回 ''，调用方回退「已完成 · 点击球查看」。
 */
export function lastAssistantReply(
  messages: ReadonlyArray<{ role?: string; text?: string }> | null | undefined,
): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    if (typeof message.text !== 'string') continue
    const text = message.text.trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * 把 Host 的 activity 文本压成气泡可展示的文案：
 * 折叠换行/连续空白，超过 120 字符截断并补 `...`；空文本返回 ''（调用方回退「正在思考」）。
 */
export function bubbleActivityText(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return ''
  if (normalized.length <= BUBBLE_ACTIVITY_MAX_CHARS) return normalized
  return `${normalized.slice(0, BUBBLE_ACTIVITY_MAX_CHARS).trimEnd()}...`
}

/**
 * 根据当前 busy / 连接态 / 上一轮是否忙，决定气泡阶段。
 * - offline/reconnecting：立即隐藏，避免留下过期的“正在思考”；
 * - busy：working；
 * - busy 刚结束：success（由 UI 展示 5s，随后浮球卫星环行未读，点击浮球/打开面板后确认清除）；
 * - 其它：保持 hidden。
 */
export function bubblePhaseFor(input: {
  busy: boolean
  connection: ConnectionPhase
  wasBusy: boolean
}): BubblePhase {
  if (input.connection === 'offline' || input.connection === 'reconnecting') return 'hidden'
  if (input.busy) return 'working'
  return input.wasBusy ? 'success' : 'hidden'
}
