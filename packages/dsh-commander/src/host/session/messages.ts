// 指挥官消息内存环（M0：≤500 条，快照 200；不落 domain/文件/日志；会话日志是真源）。
// 口径：m0-contract-patch §1.6。
import {
  MESSAGE_MAX_CHARS,
  MESSAGE_RING_MAX,
  MESSAGE_SNAPSHOT_MAX,
  MESSAGE_TRUNCATE_HEAD,
  MESSAGE_TRUNCATE_TAIL,
} from '../config.ts'

export type MessageRole = 'user' | 'assistant'

export interface CommanderMessage {
  messageId: string
  role: MessageRole
  text: string
  at: number
  order: number
  turnId?: number
  seq?: number
  truncated?: boolean
  fullChars?: number
}

export interface TruncateResult {
  text: string
  truncated: boolean
  fullChars: number
}

/** 超过 8192 字符：头 6144 + 尾 2048 + 中间标记；返回 truncated/fullChars。 */
export function truncateMessageText(text: string, max = MESSAGE_MAX_CHARS, head = MESSAGE_TRUNCATE_HEAD, tail = MESSAGE_TRUNCATE_TAIL): TruncateResult {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= max) return { text: chars.join(''), truncated: false, fullChars: chars.length }
  const omitted = chars.length - head - tail
  const textOut = `${chars.slice(0, head).join('')}\n…[truncated ${omitted} chars]…\n${chars.slice(-tail).join('')}`
  return { text: textOut, truncated: true, fullChars: chars.length }
}

export interface MessageRingOptions {
  ringMax?: number
  snapshotMax?: number
  now?: () => number
}

/**
 * 有界内存环：order 单调递增；messageId 去重；快照取尾部 ≤200 条（order 升序）。
 * 不触发 SSE（由调用方在 append 成功后广播）。
 */
export function createMessageRing(options: MessageRingOptions = {}) {
  const ringMax = options.ringMax ?? MESSAGE_RING_MAX
  const snapshotMax = options.snapshotMax ?? MESSAGE_SNAPSHOT_MAX
  const now = options.now ?? (() => Date.now())
  const items: CommanderMessage[] = []
  const seen = new Set<string>()
  let order = 0

  const push = (input: {
    messageId: string
    role: MessageRole
    text: string
    at?: number
    turnId?: number
    seq?: number
  }): CommanderMessage | null => {
    if (seen.has(input.messageId)) return null
    order += 1
    const truncatedResult = truncateMessageText(input.text)
    const message: CommanderMessage = {
      messageId: input.messageId,
      role: input.role,
      text: truncatedResult.text,
      at: input.at ?? now(),
      order,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.seq !== undefined ? { seq: input.seq } : {}),
      ...(truncatedResult.truncated ? { truncated: true, fullChars: truncatedResult.fullChars } : {}),
    }
    items.push(message)
    seen.add(message.messageId)
    while (items.length > ringMax) {
      const removed = items.shift()
      if (removed !== undefined) seen.delete(removed.messageId)
    }
    return message
  }

  return {
    push,
    /**
     * 预留顺序：先分配 order 并插入（用于 user echo），prompt 失败时 remove 回滚；
     * 防止 assistant 先回导致 order 倒置（architect M5）。
     */
    reserve: push,
    remove(messageId: string): boolean {
      const index = items.findIndex((item) => item.messageId === messageId)
      if (index < 0) return false
      items.splice(index, 1)
      seen.delete(messageId)
      return true
    },
    /** 快照：尾部 ≤200 条，按 order 升序（数组本身保序）。 */
    snapshot(): CommanderMessage[] {
      return items.slice(-snapshotMax)
    },
    size(): number {
      return items.length
    },
    currentOrder(): number {
      return order
    },
    clear(): void {
      items.length = 0
      seen.clear()
    },
  }
}

export type MessageRing = ReturnType<typeof createMessageRing>
