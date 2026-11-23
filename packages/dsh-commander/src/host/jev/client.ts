// 派发 Jev HTTP 客户端：env-only key、timeout、429/529 退避 1 次、4xx 不重试、错误码。
// 与能力面板的 Jev 配置/Key 分离（不复用 panel.jev.* 配置）。
import { JEV_DEFAULT_KEY_ENV, JEV_DEFAULT_MODEL, JEV_KEY_ENV_FALLBACKS, JEV_RETRY_DELAY_MS, JEV_RETRY_MAX } from '../config.ts'
import { parseJevResponse, type JevParsedResponse } from './parse.ts'

export type JevErrorCode = 'no_key' | 'timeout' | 'network' | 'auth' | 'rate_limit' | 'overloaded' | 'http' | 'bad_response'

export interface JevClientConfig {
  endpoint: string
  model: string
  envVar: string
  timeoutMs: number
}

export interface JevCallResult {
  ok: boolean
  latencyMs: number
  model?: string
  response?: JevParsedResponse
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { code: JevErrorCode; message: string; status?: number }
}

export interface CallJevOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/** 从 env 解析 key（不读文件/不落盘；config.envVar 优先，随后 TYPESAFE_API_KEY 回退）。 */
export function resolveJevKey(envVar: string | undefined, env: Record<string, string | undefined> = process.env): { key: string | null; envVar: string } {
  const primary = (envVar !== undefined && envVar !== '' ? envVar : JEV_DEFAULT_KEY_ENV)
  const names = [primary, ...JEV_KEY_ENV_FALLBACKS.filter((name) => name !== primary)]
  for (const name of names) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return { key: value, envVar: name }
  }
  return { key: null, envVar: primary }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function classifyStatus(status: number): JevErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 529) return 'overloaded'
  return 'http'
}

/** 调用 Jev：POST endpoint，body 原样；返回解析后的 answers 或错误码（不泄露 key/正文）。 */
export async function callJev(config: JevClientConfig, body: unknown, options: CallJevOptions = {}): Promise<JevCallResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const { key } = resolveJevKey(config.envVar)
  if (key === null) return { ok: false, latencyMs: 0, error: { code: 'no_key', message: `Jev API key is not configured (env '${config.envVar}')` } }
  const startedAt = performance.now()
  const serialized = JSON.stringify(body)
  let lastError: { code: JevErrorCode; message: string; status?: number } | undefined
  for (let attempt = 0; attempt <= JEV_RETRY_MAX; attempt += 1) {
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: serialized,
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      const latencyMs = Math.round(performance.now() - startedAt)
      if (response.status === 429 || response.status === 529) {
        lastError = { code: classifyStatus(response.status), message: `Jev ${response.status}`, status: response.status }
        if (attempt < JEV_RETRY_MAX) {
          await sleep(JEV_RETRY_DELAY_MS * (attempt + 1))
          continue
        }
        return { ok: false, latencyMs, error: lastError }
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200)
        return { ok: false, latencyMs, error: { code: classifyStatus(response.status), message: `Jev ${response.status}: ${text}`, status: response.status } }
      }
      const json = await response.json().catch(() => null)
      if (json === null) return { ok: false, latencyMs, error: { code: 'bad_response', message: 'Jev returned non-JSON body' } }
      const parsed = parseJevResponse(json)
      if (!parsed.ok) return { ok: false, latencyMs, error: { code: 'bad_response', message: parsed.message } }
      return { ok: true, latencyMs, ...(parsed.response.model !== undefined ? { model: parsed.response.model } : {}), response: parsed.response, ...(parsed.response.usage !== undefined ? { usage: parsed.response.usage } : {}) }
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt)
      const message = String((error as Error)?.message ?? error)
      const code: JevErrorCode = /timeout|aborted|TimeoutError/i.test(message) ? 'timeout' : 'network'
      return { ok: false, latencyMs, error: { code, message: message.slice(0, 200) } }
    }
  }
  return { ok: false, latencyMs: Math.round(performance.now() - startedAt), error: lastError ?? { code: 'network', message: 'unreachable' } }
}

export const jevDefaults = { model: JEV_DEFAULT_MODEL, envVar: JEV_DEFAULT_KEY_ENV }
