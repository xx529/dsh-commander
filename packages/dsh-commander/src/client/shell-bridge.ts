// 窗口页与 Tauri 壳的桥（无 DSH 依赖）。在普通浏览器打开 /commander/window 时自动降级为纯页面。
import { resolveWindowRole } from './window-role'
import type { WindowRole } from './window-role'

export interface NativeShellBridge {
  available: boolean
  locale: 'zh' | 'en'
  /** 切换窗口两态（Rust 端调整窗口尺寸/位置）。 */
  setMode(mode: 'ball' | 'panel' | 'board'): Promise<void>
  /** 原生窗口拖动（Tauri startDragging）。 */
  startDragging(): Promise<void>
  /** 用系统浏览器打开 loopback DSH 页面。 */
  openExternal(url: string): Promise<void>
  /** 在壳内打开一个只读会话窗口。 */
  openSessionWindow(sessionId: string): Promise<void>
  /** 显示/隐藏独立的气泡窗（Rust 端负责定位与 click-through）。 */
  setBubble(visible: boolean): Promise<void>
  /** 收起 hover 唤起的快捷输入。 */
  setQuickInput(open: boolean): Promise<void>
  /** 设置浮球的「有信息待查看」呼吸灯（完成气泡收起后常驻，点击浮球清除）。 */
  setBallUnread(unread: boolean): Promise<void>
  /** 热键/宿主触发的两态变化。 */
  onModeChange(listener: (panel: boolean) => void): () => void
  /** 气泡窗在球左侧/右侧的翻转通知。 */
  onBubbleSide(listener: (side: 'left' | 'right') => void): () => void
  /** 原生轮询到的球悬停状态（不依赖窗口焦点）。 */
  onBallHover(listener: (hovered: boolean) => void): () => void
  /** 原生 1.5s 停留后唤起/收起快捷输入。 */
  onQuickInput(listener: (open: boolean) => void): () => void
  /** 完成提示收起后的「点击查看」呼吸灯状态。 */
  onBallUnread(listener: (unread: boolean) => void): () => void
}

interface TauriWindow {
  startDragging(): Promise<void>
}

interface TauriGlobal {
  core?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> }
  window?: { getCurrentWindow(): TauriWindow }
  event?: {
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>
  }
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal
    __COMMANDER_SHELL__?: { token?: string; locale?: 'zh' | 'en'; theme?: string; panel?: boolean; session?: string; role?: string }
  }
}

/** 读取注入的窗口引导信息。 */
export function shellBoot(): { token: string; locale: 'zh' | 'en'; theme: string; panel: boolean; session: string; role: WindowRole } {
  const boot = window.__COMMANDER_SHELL__
  return {
    token: typeof boot?.token === 'string' ? boot.token : '',
    locale: boot?.locale === 'en' ? 'en' : 'zh',
    theme: typeof boot?.theme === 'string' ? boot.theme : 'follow',
    panel: boot?.panel === true,
    session: typeof boot?.session === 'string' ? boot.session : '',
    role: resolveWindowRole(boot?.role),
  }
}

/** 当前窗口页的桥；浏览器直接打开时 available=false。 */
export function getShellBridge(): NativeShellBridge {
  const tauri = window.__TAURI__
  const boot = shellBoot()
  const available = tauri?.core?.invoke !== undefined && tauri.window !== undefined
  return {
    available,
    locale: boot.locale,
    async setMode(mode) {
      if (!available) return
      await tauri?.core?.invoke('set_mode', { mode })
    },
    async startDragging() {
      if (!available) return
      await tauri?.window?.getCurrentWindow().startDragging()
    },
    async openExternal(url) {
      if (!available) {
        window.open(url, '_blank', 'noopener')
        return
      }
      await tauri?.core?.invoke('open_external', { url })
    },
    async openSessionWindow(sessionId) {
      if (!available) return
      await tauri?.core?.invoke('open_session_window', { sessionId })
    },
    async setBubble(visible) {
      if (!available) return
      await tauri?.core?.invoke('set_bubble', { visible })
    },
    async setQuickInput(open) {
      if (!available) return
      await tauri?.core?.invoke('set_quick_input', { open })
    },
    async setBallUnread(unread) {
      if (!available) return
      await tauri?.core?.invoke('set_ball_unread', { unread })
    },
    onModeChange(listener) {
      if (!available || tauri?.event === undefined) return () => {}
      let unlisten: (() => void) | undefined
      let disposed = false
      void tauri.event
        .listen<boolean>('commander:mode', (event) => {
          listener(event.payload === true)
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    onBubbleSide(listener) {
      if (!available || tauri?.event === undefined) return () => {}
      let unlisten: (() => void) | undefined
      let disposed = false
      void tauri.event
        .listen<string>('commander:bubble-side', (event) => {
          listener(event.payload === 'right' ? 'right' : 'left')
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    onBallHover(listener) {
      if (!available || tauri?.event === undefined) return () => {}
      let unlisten: (() => void) | undefined
      let disposed = false
      void tauri.event
        .listen<boolean>('commander:ball-hover', (event) => {
          listener(event.payload === true)
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    onQuickInput(listener) {
      if (!available || tauri?.event === undefined) return () => {}
      let unlisten: (() => void) | undefined
      let disposed = false
      void tauri.event
        .listen<boolean>('commander:quick-input', (event) => {
          listener(event.payload === true)
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    onBallUnread(listener) {
      if (!available || tauri?.event === undefined) return () => {}
      let unlisten: (() => void) | undefined
      let disposed = false
      void tauri.event
        .listen<boolean>('commander:ball-unread', (event) => {
          listener(event.payload === true)
        })
        .then((fn) => {
          if (disposed) fn()
          else unlisten = fn
        })
        .catch(() => {})
      return () => {
        disposed = true
        unlisten?.()
      }
    },
  }
}
