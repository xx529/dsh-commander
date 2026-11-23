// 窗口页与 Tauri 壳的桥（无 DSH 依赖）。在普通浏览器打开 /commander/window 时自动降级为纯页面。
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
  /** 热键/宿主触发的两态变化。 */
  onModeChange(listener: (panel: boolean) => void): () => void
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
    __COMMANDER_SHELL__?: { token?: string; locale?: 'zh' | 'en'; theme?: string; panel?: boolean; session?: string }
  }
}

/** 读取注入的窗口引导信息。 */
export function shellBoot(): { token: string; locale: 'zh' | 'en'; theme: string; panel: boolean; session: string } {
  const boot = window.__COMMANDER_SHELL__
  return {
    token: typeof boot?.token === 'string' ? boot.token : '',
    locale: boot?.locale === 'en' ? 'en' : 'zh',
    theme: typeof boot?.theme === 'string' ? boot.theme : 'follow',
    panel: boot?.panel === true,
    session: typeof boot?.session === 'string' ? boot.session : '',
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
  }
}
