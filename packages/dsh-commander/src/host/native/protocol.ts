// 原生壳 ↔ Host 的 NDJSON 控制帧（契约：docs/architecture/native-shell-contract.md §3.2）。
// 仅 node:* 与相对模块；解析器保持无状态，supervisor 自己维护缓冲。

export const SHELL_PROTOCOL = 1

export interface HelloFrame {
  type: 'hello'
  protocol: number
  platform: string
  arch: string
  pid: number
  capabilities: string[]
  hotkey?: string | null
}

export interface PongFrame {
  type: 'pong'
  at: number
}

export interface VisibilityFrame {
  type: 'window/visibility'
  visible: boolean
  panelOpen: boolean
  focused: boolean
}

export interface BoundsFrame {
  type: 'window/bounds'
  x: number
  y: number
  width: number
  height: number
  scale: number
}

export interface LogFrame {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

export type ShellFrame = HelloFrame | PongFrame | VisibilityFrame | BoundsFrame | LogFrame

export interface ReadyFrame {
  type: 'ready'
  origin: string
  theme: 'light' | 'dark' | 'follow'
  locale: 'zh' | 'en'
  ball: { size: number }
  panel: { width: number; height: number }
  entryPos: { x: number; y: number } | null
  hotkey: string
}

export interface PingFrame {
  type: 'ping'
  at: number
}

export interface ShutdownFrame {
  type: 'shutdown'
}

export type HostFrame = ReadyFrame | PingFrame | ShutdownFrame

const MAX_FRAME_BYTES = 1_048_576

/**
 * 把一行 JSON 解析为壳帧；非法/未知类型返回 null（supervisor 记日志、不中断）。
 * @param line - 已去掉换行的一行文本。
 */
export function parseShellFrame(line: string): ShellFrame | null {
  if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'hello':
      return typeof record.protocol === 'number' && typeof record.pid === 'number'
        ? {
            type: 'hello',
            protocol: record.protocol,
            platform: String(record.platform ?? ''),
            arch: String(record.arch ?? ''),
            pid: record.pid,
            capabilities: Array.isArray(record.capabilities) ? record.capabilities.map(String) : [],
            hotkey: typeof record.hotkey === 'string' ? record.hotkey : null,
          }
        : null
    case 'pong':
      return { type: 'pong', at: typeof record.at === 'number' ? record.at : 0 }
    case 'window/visibility':
      return {
        type: 'window/visibility',
        visible: record.visible === true,
        panelOpen: record.panelOpen === true,
        focused: record.focused === true,
      }
    case 'window/bounds':
      return typeof record.x === 'number' && typeof record.y === 'number' && typeof record.width === 'number' && typeof record.height === 'number'
        ? {
            type: 'window/bounds',
            x: record.x,
            y: record.y,
            width: record.width,
            height: record.height,
            scale: typeof record.scale === 'number' ? record.scale : 1,
          }
        : null
    case 'log':
      return {
        type: 'log',
        level: record.level === 'error' ? 'error' : record.level === 'warn' ? 'warn' : 'info',
        message: String(record.message ?? ''),
      }
    default:
      return null
  }
}

/** 编码一帧为一行 JSON（末尾带换行）。 */
export function encodeHostFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`
}
