/**
 * 软依赖客户端服务（uiWorkspace / uiSession）的**惰性解析**。
 *
 * 背景：本插件的 client 只 `inject: ['slots','locale','layout']`，其余是软依赖；它们的
 * provider 插件可能晚于本插件激活（实测 live：apply 时 `ctx.get('uiWorkspace')` 还是
 * undefined）。若在 apply 时把服务实例捕获成 `openSession`/`sessionStatus`，整块功能会永久
 * 缺失（看板卡片没有「打开会话」按钮、审批悬浮卡不出现）。这里改成用到时再解析。
 */
import type { SessionStatusMap, SessionStatusSource } from './approval'
import type { ClientContext, UiWorkspaceService } from './types'

/** 惰性 `sessionStatus` 观察源：服务可用后自动挂上，并唤醒已订阅的 React。 */
export interface LazySessionStatusSource extends SessionStatusSource {
  /** 重新尝试解析底层服务（服务晚到时由 `ctx.inject` 回调触发）。 */
  refresh(): void
}

/** `uiWorkspace` 的惰性入口：点击时才解析；服务缺失时只告警一次，不抛断 UI。 */
export function createOpenSession(ctx: ClientContext): (sessionId: string) => void {
  let warned = false
  return (sessionId: string): void => {
    if (sessionId === '') return
    let service: UiWorkspaceService | undefined
    try {
      service = ctx.get?.<UiWorkspaceService>('uiWorkspace', false)
    } catch {
      service = undefined
    }
    try {
      service ??= ctx.uiWorkspace
    } catch {
      service = undefined
    }
    if (service?.openSession === undefined) {
      if (!warned) {
        warned = true
        console.warn('[dsh-commander] uiWorkspace is unavailable; cannot open the session from the board')
      }
      return
    }
    service.openSession(sessionId)
  }
}

/** 惰性 `uiSession.sessionStatus`：构造时允许服务缺失，首次读取/订阅时解析。 */
export function createLazySessionStatus(ctx: ClientContext): LazySessionStatusSource {
  const EMPTY: SessionStatusMap = new Map()
  const listeners = new Set<() => void>()
  let inner: SessionStatusSource | undefined
  let innerDispose: (() => void) | undefined

  const resolve = (): SessionStatusSource | undefined => {
    if (inner !== undefined) return inner
    let session: { sessionStatus?: unknown } | undefined
    try {
      session = ctx.get?.<{ sessionStatus?: unknown }>('uiSession', false)
    } catch {
      session = undefined
    }
    try {
      session ??= ctx.uiSession as { sessionStatus?: unknown } | undefined
    } catch {
      session = undefined
    }
    const source = session?.sessionStatus
    if (source === null || typeof source !== 'object') return undefined
    const candidate = source as Partial<SessionStatusSource>
    if (typeof candidate.getSnapshot !== 'function' || typeof candidate.subscribe !== 'function') return undefined
    inner = candidate as SessionStatusSource
    innerDispose = inner.subscribe(() => {
      for (const listener of [...listeners]) listener()
    })
    return inner
  }

  const notifyAll = (): void => {
    for (const listener of [...listeners]) listener()
  }

  return {
    refresh(): void {
      resolve()
      notifyAll()
    },
    getSnapshot(): SessionStatusMap {
      return resolve()?.getSnapshot() ?? EMPTY
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      resolve()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        innerDispose?.()
        innerDispose = undefined
        inner = undefined
      }
    },
  }
}
