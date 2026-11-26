// R1：新一任会话的默认副作用（工具审计 + 标题），换代与手动「绑定到新会话」共用。
// 口径：docs/architecture/rotation-contract-patch.md §5.4/§5.5（2026-11-26 修订：手动绑定同样应用）。
// 两个函数都只告警、不抛错：任何失败都不能阻断换代/绑定主流程。
import type { SessionControllerService } from '../dsh-types.ts'
import type { ToolAuditResult } from './tool-audit.ts'
import { rotationTitle } from './title.ts'

export interface GenerationDefaultsLogger {
  warn?: (...args: unknown[]) => void
}

export interface ToolAuditDefaultsDeps {
  setToolAudit?: ((sessionId: string, enabled: boolean) => Promise<ToolAuditResult>) | undefined
  logger?: GenerationDefaultsLogger | undefined
}

export interface RotationTitleDefaultsDeps {
  sessionController?: SessionControllerService | undefined
  logger?: GenerationDefaultsLogger | undefined
}

const errorMessage = (error: unknown): string => String((error as Error)?.message ?? error)

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/**
 * 给新会话预置 dsh-trace-inspect 的工具审计。
 * 404（插件未安装/未启用）静默跳过；409/非 2xx/网络错误只 warn；`enabled=false` 时不发请求。
 */
export async function applyToolAuditDefault(
  deps: ToolAuditDefaultsDeps,
  input: { sessionId: string; enabled: boolean },
): Promise<void> {
  if (!input.enabled || deps.setToolAudit === undefined) return
  try {
    const audit = await deps.setToolAudit(input.sessionId, input.enabled)
    if (audit.status === 'failed') {
      deps.logger?.warn?.(`[commander] rotation tool audit failed: ${audit.message}`)
    } else if (audit.status === 'sealed') {
      deps.logger?.warn?.('[commander] rotation tool audit is already sealed on the new session')
    }
  } catch (error) {
    deps.logger?.warn?.(`[commander] rotation tool audit failed: ${errorMessage(error)}`)
  }
}

/**
 * 给新会话钉住 `第 N 任 · YYYY-MM-DD` 标题。
 * rename 不可用/失败/超时只 warn，不抛；`timeoutMs` 由调用方决定（换代 10s，手动绑定 3s）。
 */
export async function applyRotationTitleDefault(
  deps: RotationTitleDefaultsDeps,
  input: { sessionId: string; generation: number; at: number; timeoutMs: number },
): Promise<void> {
  const controller = deps.sessionController
  const rename = controller?.rename
  if (controller === undefined || rename === undefined) return
  try {
    await withTimeout(
      rename.call(controller, { sessionId: input.sessionId, title: rotationTitle(input.generation, input.at) }),
      input.timeoutMs,
      'session rename',
    )
  } catch (error) {
    deps.logger?.warn?.(`[commander] rotation title rename failed: ${errorMessage(error)}`)
  }
}
