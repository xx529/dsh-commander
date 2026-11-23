// SSE 事件中心：rev 单调、多连接广播、首帧 snapshot、15s heartbeat、unload bye。
// 口径：implementation-plan §8.4 + m0-contract-patch §1.7。
import { SSE_HEARTBEAT_MS } from '../config.ts'
import type { HttpResponseLike } from '../dsh-types.ts'

export interface SseClient {
  res: HttpResponseLike
  closed: boolean
}

export interface SseHub {
  readonly rev: number
  nextRev(): number
  attach(res: HttpResponseLike, snapshot: unknown): SseClient
  broadcast(event: string, data: unknown): void
  clientCount(): number
  dispose(): void
}

export interface SseHubOptions {
  heartbeatMs?: number
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
}

export function createSseHub(options: SseHubOptions = {}): SseHub {
  const clients = new Set<SseClient>()
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS
  let rev = 0
  let disposed = false

  const writeEvent = (client: SseClient, event: string, data: unknown, id = rev): void => {
    if (client.closed) return
    try {
      client.res.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      client.closed = true
      clients.delete(client)
    }
  }

  const heartbeat = (): void => {
    if (disposed) return
    for (const client of clients) writeEvent(client, 'heartbeat', { t: Date.now(), rev })
  }

  const timer = (options.setIntervalFn ?? setInterval)(heartbeat, heartbeatMs) as unknown
  const clearTimer = (options.clearIntervalFn ?? clearInterval) as (handle: unknown) => void
  const unrefTimer = (): void => {
    const holder = timer as { unref?: () => void }
    holder?.unref?.()
  }
  unrefTimer()

  return {
    get rev() {
      return rev
    },
    nextRev() {
      rev += 1
      return rev
    },
    attach(res, snapshot) {
      // 契约：首帧 id 应等于快照 rev（快照由调用方在 attach 前构建）；后续事件从 rev+1 开始。
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      const client: SseClient = { res, closed: false }
      clients.add(client)
      writeEvent(client, 'snapshot', snapshot, rev)
      res.on('close', () => {
        client.closed = true
        clients.delete(client)
      })
      res.on('error', () => {
        client.closed = true
        clients.delete(client)
      })
      return client
    },
    broadcast(event, data) {
      rev += 1
      for (const client of clients) writeEvent(client, event, data, rev)
    },
    clientCount() {
      return clients.size
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer(timer)
      for (const client of clients) {
        writeEvent(client, 'bye', { rev })
        client.closed = true
        try {
          client.res.end()
        } catch {
          /* 已断开 */
        }
      }
      clients.clear()
    },
  }
}
