// 原生壳审批桥（契约：docs/architecture/native-shell-contract.md；P1 条件接管）。
//
// 规则：
// - 只在壳 running 且窗口可见并聚焦时，用 `{prepend:true}` 抢先应答 `approval/request`；
//   否则 `next()` 交回 DSH 主窗（不改变现有行为）。
// - 壳退出/心跳失败 → 所有未决请求以 `cancelled` 结算（fail closed）。
// - 壳回答走窗口页 HTTP：POST /commander/native/approval/:id。
import { randomUUID } from 'node:crypto'
import type { ShellStatus } from './supervisor.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

export interface ApprovalRequestLike {
  toolName?: unknown
  reason?: unknown
  displayReason?: unknown
  signal?: AbortSignal
}

export interface ApprovalView {
  id: string
  toolName: string
  reason: string
  at: number
  /** false = 已交给 DSH 页内应答者，浮窗只读展示。 */
  canAnswer: boolean
}

export type NextAnswerer = () => Promise<ApprovalOutcome> | ApprovalOutcome

export interface ApprovalBridge {
  /** supervisor 状态变化时调用；离开 running 会取消所有未决请求。 */
  onShellStatus(status: Pick<ShellStatus, 'phase'>): void
  list(): ApprovalView[]
  /** 窗口页回答；非法 id/outcome 返回 false。 */
  resolve(id: string, outcome: 'allowed-once' | 'rejected'): boolean
  dispose(): void
}

export interface ApprovalBridgeOptions {
  /** 注册 `approval/request` waterfall 监听器，返回注销函数。 */
  onRequest: (listener: (request: ApprovalRequestLike, next: NextAnswerer) => unknown) => () => void
  /** SSE/广播出口（`native.approval` / `native.approval.resolved`）。 */
  emit: (event: string, payload: unknown) => void
  /** 壳此刻是否该接管（running + visible + focused）。 */
  isShellFocused: () => boolean
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  now?: () => number
  timeoutMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 创建审批桥。
 * @param options - waterfall 注册器、广播出口、接管判定与可注入时钟（测试）。
 */
export function createApprovalBridge(options: ApprovalBridgeOptions): ApprovalBridge {
  const now = options.now ?? Date.now
  const setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log ?? (() => {})
  const pending = new Map<string, { view: ApprovalView; resolve: (outcome: ApprovalOutcome) => void; timer: unknown }>()
  let disposed = false

  function settle(id: string, outcome: ApprovalOutcome): boolean {
    const entry = pending.get(id)
    if (entry === undefined) return false
    pending.delete(id)
    clearTimeoutFn(entry.timer)
    entry.resolve(outcome)
    options.emit('native.approval.resolved', { id })
    return true
  }

  const listener = (request: ApprovalRequestLike, next: NextAnswerer): unknown => {
    if (disposed) return next()
    const id = randomUUID()
    const view: ApprovalView = {
      id,
      toolName: text(request.toolName),
      reason: text(request.displayReason) || text(request.reason),
      at: now(),
      canAnswer: true,
    }
    // 双处操作：同时把请求推给浮窗、并让 DSH 页内应答者继续等待；谁先回答用谁。
    const floatAnswer = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeoutFn(() => {
        log('warn', `approval ${id} float window timed out; DSH may still answer`)
        if (pending.delete(id)) options.emit('native.approval.resolved', { id })
      }, timeoutMs)
      pending.set(id, { view, resolve, timer })
      options.emit('native.approval', view)
    })
    let dshAnswer: Promise<ApprovalOutcome>
    try {
      dshAnswer = Promise.resolve(next())
    } catch (error) {
      log('warn', `DSH approval answerer failed: ${String(error)}`)
      dshAnswer = Promise.resolve('unavailable' as ApprovalOutcome)
    }
    const dshSettled = dshAnswer.catch((error: unknown) => {
      log('warn', `DSH approval answerer failed: ${String(error)}`)
      return 'unavailable' as ApprovalOutcome
    })
    request.signal?.addEventListener('abort', () => {
      if (pending.delete(id)) options.emit('native.approval.resolved', { id })
    }, { once: true })
    return Promise.race([dshSettled, floatAnswer]).finally(() => {
      if (pending.delete(id)) options.emit('native.approval.resolved', { id })
    })
  }

  const disposeListener = options.onRequest(listener)

  return {
    onShellStatus(status): void {
      if (status.phase === 'running') return
      // 壳退出只撤掉浮窗视图；请求仍由 DSH 页内应答者继续等待。
      for (const [id, entry] of [...pending]) {
        log('warn', `shell left running; hiding approval ${id} (DSH may still answer)`)
        pending.delete(id)
        clearTimeoutFn(entry.timer)
        options.emit('native.approval.resolved', { id })
      }
    },
    list(): ApprovalView[] {
      return [...pending.values()].map((entry) => entry.view)
    },
    resolve(id: string, outcome: 'allowed-once' | 'rejected'): boolean {
      if (outcome !== 'allowed-once' && outcome !== 'rejected') return false
      return settle(id, outcome)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const [id, entry] of [...pending]) {
        pending.delete(id)
        clearTimeoutFn(entry.timer)
        options.emit('native.approval.resolved', { id })
      }
      disposeListener()
    },
  }
}
