// R1：换代时给新会话预置 dsh-trace-inspect 的「工具审计」。
// 外部契约（dsh-trace-inspect README「工具审计」）：POST /trace-inspect/api/tool-audit?sessionId=… {enabled}
// 由 dsh-trace-inspect/desc-inject 的 Host 子插件注册；路由不存在（未安装/未启用）时返回 404。
// 该接口只允许首个 turn/start 之前修改，因此必须在交接简报注入后、用户首轮之前调用。
//
// 传输固定用 node:http（而不是全局 fetch）：Host 可能设置 NODE_USE_ENV_PROXY，
// 走 fetch 会把 127.0.0.1 的调用交给代理；这里显式直连本机回环。
import { request as httpRequest } from 'node:http'

export const TOOL_AUDIT_PATH = '/trace-inspect/api/tool-audit'

export type ToolAuditResult =
  | { status: 'ok'; enabled: boolean }
  | { status: 'unavailable' }
  | { status: 'sealed' }
  | { status: 'failed'; message: string }

/** 一次本机 POST 的结果（状态码 + 响应文本）；测试可注入。 */
export interface ToolAuditHttpResult {
  status: number
  body: string
}

export interface SetSessionToolAuditOptions {
  /** Host 本机 origin（http://127.0.0.1:<port>），用于访问同进程的 trace-inspect 路由。 */
  origin: string
  sessionId: string
  enabled: boolean
  /** 默认 3000ms；超时按 failed 记账，不阻断换任。 */
  timeoutMs?: number
  /** 测试注入；缺省用 node:http 直连。 */
  request?: (url: URL, body: string, timeoutMs: number) => Promise<ToolAuditHttpResult>
}

function postJson(url: URL, body: string, timeoutMs: number): Promise<ToolAuditHttpResult> {
  return new Promise<ToolAuditHttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * 设置一个会话的工具审计开关（仅首轮前有效）。
 * 返回不可用/已封存/失败都不抛错，由调用方决定是否告警。
 */
export async function setSessionToolAudit(options: SetSessionToolAuditOptions): Promise<ToolAuditResult> {
  const send = options.request ?? postJson
  const url = new URL(TOOL_AUDIT_PATH, options.origin)
  url.searchParams.set('sessionId', options.sessionId)
  try {
    const response = await send(url, JSON.stringify({ enabled: options.enabled }), options.timeoutMs ?? 3_000)
    if (response.status === 404) return { status: 'unavailable' }
    if (response.status === 409) return { status: 'sealed' }
    if (response.status < 200 || response.status >= 300) return { status: 'failed', message: `HTTP ${response.status}` }
    let body: { enabled?: unknown } | null = null
    try {
      body = JSON.parse(response.body) as { enabled?: unknown } | null
    } catch {
      body = null
    }
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : options.enabled
    return { status: 'ok', enabled }
  } catch (error) {
    return { status: 'failed', message: String((error as Error)?.message ?? error).slice(0, 200) }
  }
}
