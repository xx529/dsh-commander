/**
 * M0-0 构建 spike：Host 半占位实现（**不是**生产实现，生产 `src/host/**` 归 backend）。
 *
 * 目的：仅验证「包骨架 + cordis.patch.yml + 隔离 profile 安装」链路：
 *   1. 作为 bundle 行 `id: commander, name: dsh-commander` 被 Host 加载；
 *   2. 通过 inject 的 webServer 注册 `/commander/health`，给冒烟测试一个可观测的 HTTP 证据。
 *
 * 真实实现由 backend 写入 `packages/dsh-commander/src/host/**`。
 */

/** 最小本地类型（本包零运行时依赖，不 import 任何 @deepseek-ai/* 包）。 */
interface SpikeHostContext {
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
  get?: (name: string) => unknown
  inject?: (deps: string[], callback: (ctx: SpikeHostContext) => void) => void
}

export const name = 'commander'
export const inject: string[] = []

export function apply(ctx: SpikeHostContext): void {
  ctx.logger?.info?.('[commander-m0-spike] host half loaded (placeholder apply)')
  const register = (hostCtx: SpikeHostContext): void => {
    const webServer = hostCtx.get?.('webServer') as
      | { register?: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void }) => unknown }
      | undefined
    if (webServer?.register === undefined) {
      ctx.logger?.warn?.('[commander-m0-spike] webServer unavailable; /commander/health not registered')
      return
    }
    webServer.register({
      kind: 'exact',
      path: '/commander/health',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ ok: true, spike: 'm0-0', at: new Date().toISOString() }) + '\n')
      },
    })
    ctx.logger?.info?.('[commander-m0-spike] /commander/health registered')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], register)
  else register(ctx)
}
