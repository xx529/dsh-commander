// 气泡阶段推导 + 活动文案格式化：阶段只看 busy/connection；活动文案由 Host 的 status.activity 提供。
import type { ConnectionPhase } from './types'

export type BubblePhase = 'hidden' | 'working' | 'success'

/** 气泡单行文案上限；超出补 `...`（CSS ellipsis 再兜住实际像素宽度）。 */
export const BUBBLE_ACTIVITY_MAX_CHARS = 40

/**
 * 把 Host 的 activity 文本压成气泡可展示的单行文案：
 * 折叠换行/连续空白，过长截断并补 `...`；空文本返回 ''（调用方回退「正在思考」）。
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
