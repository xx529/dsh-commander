// 指挥官投递：
// - 用户消息（面板输入）→ sessionController.prompt(mode:'queue')，懒 resume 由 prompt 自身完成；
// - 上下文注入（工作会话回复 / 看板改动）→ live Agent 的 followup + 自定义 source（DSH 上下文卡 + <system-reminder> 提示词框架），
//   冷会话回退 prompt（保证仍能触发一轮）。
// 失败标 broken，不自动新建（implementation-plan §5.3/§5.5 + m0-contract-patch §1.3）。
import { randomUUID } from 'node:crypto'
import { PROMPT_TEXT_MAX } from '../config.ts'
import type { AgentsService, CordisContext, SessionControllerService } from '../dsh-types.ts'
import type { BindingService } from './binding.ts'

export type DeliverErrorCode = 'binding_required' | 'binding_broken' | 'prompt_failed' | 'invalid_request'

export class DeliverError extends Error {
  readonly code: DeliverErrorCode
  constructor(code: DeliverErrorCode, message: string) {
    super(message)
    this.name = 'DeliverError'
    this.code = code
  }
}

export interface DeliverResult {
  accepted: boolean
  queued: boolean
  busy: boolean
  sessionId: string
}

/** 注入上下文卡片的来源声明（写进 durable `user/message`.source）。 */
export interface ContextDeliveryOptions {
  /** 来源 kind：DSH 聊天按它显示「上下文」行的生产者标签。 */
  kind: string
  /** 发送方会话（工作会话）；给了就按 relay 卡片渲染「来自会话 X 的消息」。 */
  senderSessionId?: string
  /** 折叠态一行摘要（无 sender 时的 notice 卡片用）。 */
  summary?: string
  /** R1：交接简报来源的旧任序号（只在 `kind='commander-handoff'` 时使用）。 */
  generation?: number
}

export interface ContextMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: Record<string, unknown>
}

/**
 * 构造一条 DSH 上下文注入消息：user 角色 + **非 user** 的 source（聊天渲染成上下文卡而不是用户气泡），
 * 内容用 `<system-reminder>` 包住，模型侧看到的是上下文提醒而不是用户指令。
 * @param text - 注入正文（例如 `[session-reply] …\n---\ntaskId=…`）。
 * @param options - 来源 kind / 发送方会话 / 折叠摘要。
 * @returns 可直接交给 `agent.followup()` 的消息。
 */
export function buildContextMessage(text: string, options: ContextDeliveryOptions): ContextMessageLike {
  const inner = String(text ?? '').trim().replace(/<\/system-reminder\s*>/gi, tag => `<\\${tag.slice(1)}`)
  const source: Record<string, unknown> = { kind: options.kind }
  if (options.senderSessionId !== undefined && options.senderSessionId !== '') {
    source['form'] = 'relay'
    source['senderSessionId'] = options.senderSessionId
  } else {
    source['form'] = 'notice'
    if (options.summary !== undefined && options.summary !== '') source['summary'] = options.summary
  }
  if (options.generation !== undefined) source['generation'] = options.generation
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${inner}\n</system-reminder>` }],
    source,
  }
}

/**
 * 只有“会话不可恢复”类错误才 markBroken（implementation-plan §5.3：writer-held / 会话不存在）。
 * 参数错误、provider 凭据缺失、模型不可用等 prompt_failed 保留 bound（可重试/改配置，不应把绑定打死）。
 */
export function isSessionBrokenError(message: string): boolean {
  return /writer-held|writer held|session[^a-z]{0,20}not[^a-z]{0,20}(found|exist)|no such session|session[^a-z]{0,20}missing|resume[^a-z]{0,20}failed|session\/deleted|disposed/i.test(
    String(message ?? ''),
  )
}

export interface DeliverDeps {
  ctx: CordisContext
  binding: BindingService
  isBusy: () => boolean
  logger?: { warn?: (message: string) => void }
}

export function createDeliverer(deps: DeliverDeps) {
  const controller = (): SessionControllerService | undefined => deps.ctx.get('sessionController') as SessionControllerService | undefined
  const agents = (): AgentsService | undefined => {
    try {
      return deps.ctx.get('agents') as AgentsService | undefined
    } catch {
      return undefined
    }
  }

  /** 绑定/长度校验（两条投递路径共用）。 */
  const admit = (text: string): { trimmed: string; sessionId: string } => {
    const trimmed = String(text ?? '').trim()
    if (trimmed.length === 0) throw new DeliverError('invalid_request', 'text must not be empty')
    if (Array.from(trimmed).length > PROMPT_TEXT_MAX) throw new DeliverError('invalid_request', `text exceeds ${PROMPT_TEXT_MAX} characters`)
    const view = deps.binding.view()
    if (view.status === 'unbound' || view.binding.sessionId === '') throw new DeliverError('binding_required', 'commander is not bound')
    if (view.status === 'broken') throw new DeliverError('binding_broken', view.brokenReason ?? 'commander session is missing')
    if (deps.binding.getStatus() === 'broken') throw new DeliverError('binding_broken', 'commander session is missing')
    return { trimmed, sessionId: view.binding.sessionId }
  }

  /**
   * 投递一条用户消息。校验顺序（m0-contract-patch §1.3 固定）：
   * 绑定存在 → 未 broken → prompt(accepted===true) → 成功返回；失败 markBroken。
   */
  async function deliverUserMessage(text: string, requestId: string): Promise<DeliverResult> {
    const { trimmed, sessionId } = admit(text)
    // 保留 receiver：真实 sessionController.prompt 内部使用 this.ctx，解构后调用会丢 this
    // （tester M0-2 e2e：`Cannot read properties of undefined (reading 'ctx')`）。
    const controllerRef = controller()
    if (controllerRef?.prompt === undefined) throw new DeliverError('prompt_failed', 'sessionController.prompt is unavailable')
    const busyBefore = deps.isBusy()
    try {
      // 真实签名：sessionController.prompt(request, signal)；signal 是必填第二参
      // （dsh-api-session-controller 第一行 signal.throwIfAborted()，M0 不做取消，只提供未中止 signal）。
      const result = await controllerRef.prompt(
        {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: trimmed }],
        },
        new AbortController().signal,
      )
      if (result?.accepted !== true) {
        const reason = result?.error?.message ?? result?.error?.code ?? 'prompt was not accepted'
        if (isSessionBrokenError(reason)) deps.binding.markBroken(`prompt_failed: ${reason}`)
        throw new DeliverError('prompt_failed', reason)
      }
    } catch (error) {
      if (error instanceof DeliverError) throw error
      const message = String((error as Error)?.message ?? error)
      if (isSessionBrokenError(message)) deps.binding.markBroken(`prompt_failed: ${message}`)
      throw new DeliverError('prompt_failed', message.slice(0, 200))
    }
    return { accepted: true, queued: busyBefore, busy: deps.isBusy(), sessionId }
  }

  /**
   * 投递一条上下文注入：live Agent 走 `followup(上下文消息)`（DSH 上下文卡 + `<system-reminder>`）；
   * 指挥官会话尚未 live（宿主重启后未打开）时回退 `prompt`，保证注入仍能触发一轮。
   */
  async function deliverContextMessage(text: string, requestId: string, options: ContextDeliveryOptions): Promise<DeliverResult> {
    const { trimmed, sessionId } = admit(text)
    const busyBefore = deps.isBusy()
    const agent = agents()?.get?.(sessionId)
    if (agent?.followup !== undefined) {
      try {
        agent.followup(buildContextMessage(trimmed, options))
        return { accepted: true, queued: busyBefore, busy: deps.isBusy(), sessionId }
      } catch (error) {
        deps.logger?.warn?.(`[commander] context injection via agent.followup failed, falling back to prompt: ${String((error as Error)?.message ?? error)}`)
      }
    }
    return deliverUserMessage(text, requestId)
  }

  return { deliverUserMessage, deliverContextMessage }
}

export type Deliverer = ReturnType<typeof createDeliverer>
