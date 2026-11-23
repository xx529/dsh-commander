/**
 * 探针用 stub LLM provider（V2/V3 的模型链路替身）
 *
 * 背景：隔离探针 Home 无 provider 凭据（`MISSING_CREDENTIAL`），V2 的回合/tool/审批链路与
 * V3 的 `prompt` 正向用例需要一个**不联网、确定性**的 provider。本模块注册一个
 * `LlmAdapter` 子类到 provider 路由 `probe-stub`（模型 id `stub-1`），按用户文本里的标记
 * 决定回复内容：
 *
 *   - 文本含 `PROBE_V2_TOOL_APPROVAL` → 发一次需要审批的 bash 工具调用（带 sandbox_permissions）
 *   - 文本含 `PROBE_V2_TOOL`           → 发一次普通 bash 工具调用（`echo probe-v2-tool-ok`）
 *   - 文本含 `PROBE_V3_OK`             → 文本回复 `probe-v3-ok`
 *   - 文本含 `PROBE_V3_RESUME`         → 文本回复 `probe-v3-resume-ok`
 *   - 文本含 `PROBE_V2_PLAIN`          → 文本回复 `probe-v2-plain-ok`
 *   - 其它                            → `stub-echo: <文本前 120 字>`
 *
 * 已产生工具结果（messages 里出现 role==='tool'）后不再发工具调用，改回文本，避免无限循环。
 *
 * **这是验证用 stub，不是真实模型**：V2/V3 文档必须标注"模型为探针 stub，真实 provider
 * 端到端留 M0 验收"。它不产生真实计费、不联网。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const STUB_PROVIDER = 'probe-stub'
export const STUB_MODEL = 'stub-1'

const blockText = (message) => {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

const lastUserText = (options) => {
  const messages = options?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue
    const text = blockText(messages[i])
    if (text.length > 0) return text
  }
  return ''
}

/** 在**全部** user 消息里找探针标记（运行时会在用户输入后追加上下文 user 消息，不能只看最后一条）。 */
const markerText = (options) => {
  const messages = options?.messages ?? []
  const texts = messages.filter((message) => message?.role === 'user').map(blockText)
  for (const marker of ['PROBE_V2_TOOL_APPROVAL', 'PROBE_V2_TOOL', 'PROBE_V3_RESUME', 'PROBE_V3_OK', 'PROBE_V2_PLAIN']) {
    if (texts.some((text) => text.includes(marker))) return marker
  }
  return ''
}

const hasToolResult = (options) => (options?.messages ?? []).some((message) => message?.role === 'tool')

/** 依据标记决定回复动作（纯函数，便于证据里记录）。 */
export function plannedAction(text) {
  if (text.includes('PROBE_V2_TOOL_APPROVAL')) return { kind: 'tool-call', approval: true }
  if (text.includes('PROBE_V2_TOOL')) return { kind: 'tool-call', approval: false }
  if (text.includes('PROBE_V3_OK')) return { kind: 'text', text: 'probe-v3-ok' }
  if (text.includes('PROBE_V3_RESUME')) return { kind: 'text', text: 'probe-v3-resume-ok' }
  if (text.includes('PROBE_V2_PLAIN')) return { kind: 'text', text: 'probe-v2-plain-ok' }
  return { kind: 'text', text: `stub-echo: ${text.slice(0, 120)}` }
}

/** 文本回复的 chunk 序列。 */
async function* textStream(text, callIndex = 0) {
  yield { type: 'block-start', index: callIndex, blockType: 'text' }
  yield { type: 'text-delta', index: callIndex, text }
  yield { type: 'block-end', index: callIndex, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: text.length, totalTokens: 12 + text.length } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 工具调用回复的 chunk 序列。 */
async function* toolCallStream(call) {
  const id = `call_probe_${Date.now()}`
  const args = JSON.stringify(call.approval
    ? {
      description: 'probe v2 approval wait',
      command: 'echo probe-v2-tool-ok',
      sandbox_permissions: 'danger-full-access',
      justification: 'V2 探针：验证审批等待期不注入（隔离探针 Host）',
    }
    : { description: 'probe v2 plain tool', command: 'echo probe-v2-tool-ok' })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 30, totalTokens: 45 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/**
 * 注册 stub provider（探针插件 apply 内调用；随插件 fiber 卸载）。
 * @param ctx - 探针插件上下文（需含 llm 服务）。
 * @returns 注册信息（供健康检查/证据）。
 */
export async function installStubLlm(ctx) {
  const require_ = createRequire(process.argv[1])
  const llmEntry = require_.resolve('@deepseek-ai/dsh-llm')
  const { LlmAdapter } = await import(pathToFileURL(llmEntry).href)
  const calls = []

  class StubAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Probe Stub（验证用，非真实模型）' } }
    async listModels(provider) {
      return [{ provider, id: STUB_MODEL, name: 'Probe Stub Model', description: 'V2/V3 探针确定性 stub，不联网' }]
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: 'Probe Stub Model', context: { contextWindow: 128000 } }
    }
    async *stream(options) {
      const text = lastUserText(options)
      const marker = markerText(options)
      const chosen = plannedAction(marker.length > 0 ? marker : text)
      const action = hasToolResult(options) && chosen.kind === 'tool-call'
        ? { kind: 'text', text: 'probe-v2-tool-done' }
        : chosen
      calls.push({ at: Date.now(), action: action.kind, marker: text.slice(0, 80), hadToolResult: hasToolResult(options) })
      if (action.kind === 'tool-call') { yield* toolCallStream(action); return }
      yield* textStream(action.text)
    }
  }

  // 不额外包 ctx.effect：registerAdapter 自身已把注册挂在调用方 fiber 上，随插件卸载释放。
  ctx.llm.registerAdapter([STUB_PROVIDER], new StubAdapter())
  return { provider: STUB_PROVIDER, model: STUB_MODEL, calls }
}
