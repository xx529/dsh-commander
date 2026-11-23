// 取消任务前停止关联的在跑工作会话（m5 追加：任务 cancelled 必须同时停 session）。
// 只调用 sessionController.cancel({sessionId})；不写任务状态（由调用方在全部成功后写）。
import type { CordisContext, SessionControllerService } from '../dsh-types.ts'
import type { StoreSet } from '../store/index.ts'

export interface StopTaskSessionsResult {
  attempted: number
  stopped: string[]
  /** 会话已不存在/已停止，视为无需再取消。 */
  skipped: string[]
  failed: Array<{ sessionId: string; message: string }>
}

const ALREADY_GONE = /not found|not exist|missing|no active|not live|already|closed|stopp|idle|no such session/i

function controllerOf(ctx: CordisContext): SessionControllerService | undefined {
  try {
    return ctx.get('sessionController') as SessionControllerService | undefined
  } catch {
    return undefined
  }
}

/**
 * 取消任务前停掉它当前 running/queued 的工作会话。
 * - 旧轮次 idle 会话不碰；
 * - cancel 缺失/抛错 → failed（调用方不应把任务置 cancelled，避免“任务已取消但会话还在跑”）；
 * - 会话已不存在/已停止 → skipped。
 */
export async function stopTaskSessions(
  ctx: CordisContext,
  stores: StoreSet,
  taskId: string,
  onWarn?: (message: string) => void,
): Promise<StopTaskSessionsResult> {
  const task = stores.tasks.get(taskId)
  const links = stores.sessions.list().filter((link) => link.taskId === taskId && link.role === 'work')
  const active = new Map<string, string>()
  for (const link of links) {
    if (link.status === 'running' || link.status === 'queued') active.set(link.sessionId, link.workspaceId)
  }
  // 任务在跑但 link 缺失/状态滞后：至少尝试 primary session。
  if (task !== undefined && (task.status === 'running' || task.status === 'queued')) {
    const primary = task.primarySessionId
    if (primary !== undefined && primary !== '' && !active.has(primary)) {
      const link = links.find((item) => item.sessionId === primary)
      active.set(primary, link?.workspaceId ?? task.workspaceId)
    }
  }
  const ids = [...active.keys()]
  if (ids.length === 0) return { attempted: 0, stopped: [], skipped: [], failed: [] }

  const controller = controllerOf(ctx)
  const result: StopTaskSessionsResult = { attempted: ids.length, stopped: [], skipped: [], failed: [] }
  if (controller?.cancel === undefined) {
    for (const sessionId of ids) result.failed.push({ sessionId, message: 'sessionController.cancel is unavailable' })
    return result
  }
  for (const sessionId of ids) {
    try {
      const receipt = await controller.cancel({ sessionId }) as { accepted?: boolean } | undefined
      if (receipt !== undefined && receipt.accepted === false) {
        result.failed.push({ sessionId, message: 'session cancel was not accepted' })
        continue
      }
      result.stopped.push(sessionId)
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300)
      if (ALREADY_GONE.test(message)) {
        result.skipped.push(sessionId)
      } else {
        result.failed.push({ sessionId, message })
        onWarn?.(`[commander] session cancel failed for ${sessionId}: ${message}`)
      }
    }
  }
  return result
}
