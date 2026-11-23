/**
 * M1 tools 可见性 e2e 驱动（探针插件）：用确定性 stub LLM 让**指挥官会话的模型**发出
 * `commander_task_create` 工具调用，从而在**真实 agent 回合**里验证指挥官 tools 是否注册/可执行。
 *
 * 背景：boot 面无法直接观测动态注册的工具（`tools.schemas()` 不反映 `register()` 结果），
 * 所以用模型回合作为判据：stub 收到用户文本含 `PROBE_M1_TASK` 时返回 `commander_task_create` 工具调用，
 * 工具执行成功 → `/commander/state.tasks` 出现记录，即证明 tools 注册生效。
 *
 * 只读驱动 + 隔离环境；不写 live。路由：
 *   GET /m1e2e/health          stub provider 状态 / stub 调用次数
 *   GET /m1e2e/prepare?sessionId=   给指挥官会话 selectModel(probe-stub/stub-1)
 *   GET /m1e2e/drive?sessionId=&text=PROBE_M1_TASK   controller.prompt + 等 turn/end，返回事件摘要
 *   GET /m1e2e/events?sessionId=     会话事件摘要
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'm1-tools-driver'
export const inject = ['llm']

const STUB_PROVIDER = 'probe-stub'
const STUB_MODEL = 'stub-1'

const safe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: String(error?.message ?? error) } } }
const lastUserText = (options) => {
  const messages = options?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue
    const text = (Array.isArray(messages[i].content) ? messages[i].content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (text.length > 0) return text
  }
  return ''
}
const allUserText = (options) => (options?.messages ?? []).filter((m) => m?.role === 'user')
  .map((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')).join('\n')
const toolMessagesAfterLastUser = (options) => {
  const messages = options?.messages ?? []
  const lastUserIndex = messages.reduce((acc, message, index) => (message?.role === 'user' ? index : acc), -1)
  return messages.slice(lastUserIndex + 1).filter((message) => message?.role === 'tool')
}
const toolResultsAfterLastUser = (options) => toolMessagesAfterLastUser(options).map((message) => (Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''))
const hasToolResult = (options) => toolResultsAfterLastUser(options).length > 0

export async function apply(ctx, config = {}) {
  const calls = []
  let lastToolResult = null
  let lastToolResultBlocks = null
  const events = new Map() // sessionId -> [{seq,type,turn}]
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const list = events.get(sessionId) ?? []
    const message = event?.data?.message
    const blocks = Array.isArray(message?.content) ? message.content : Array.isArray(event?.data?.content) ? event.data.content : []
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') || (typeof event?.data?.text === 'string' ? event.data.text : '')
    list.push({ seq: event?.seq ?? null, type: event?.type ?? null, turn: event?.data?.turn ?? null, role: message?.role ?? event?.data?.role ?? null, text })
    if (list.length > 2000) list.shift()
    events.set(sessionId, list)
  })

  // ---- stub adapter：按 PROBE_M1_TASK 标记返回 commander_task_create 工具调用 ----
  const require_ = createRequire(process.argv[1])
  const llmEntry = require_.resolve('@deepseek-ai/dsh-llm')
  const { LlmAdapter } = await import(pathToFileURL(llmEntry).href)
  class StubAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Probe Stub（M1 tools 验证用，非真实模型）' } }
    async listModels(provider) { return [{ provider, id: STUB_MODEL, name: 'Probe Stub Model' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'Probe Stub Model', context: { contextWindow: 128000 } } }
    async *stream(options) {
      const marker = allUserText(options)
      calls.push({ at: Date.now(), marker: marker.slice(0, 120), hadToolResult: hasToolResult(options) })
      const toolResults = toolResultsAfterLastUser(options)
      const wantsTask = marker.includes('PROBE_M1_TASK')
      const wantsBoard = marker.includes('PROBE_M1_BOARD')
      const wantsAttach = marker.includes('PROBE_M1R_ATTACH')
      const wantsConfirm = marker.includes('PROBE_M1R_CONFIRM')
      const wantsOrganize = marker.includes('PROBE_M3_ORGANIZE')
      const wantsOrganizeEmpty = marker.includes('PROBE_M3_EMPTY')
      const kv = (key) => {
        const match = marker.match(new RegExp(`${key}=([^\\s]+)`))
        return match === null ? '' : match[1]
      }
      if ((wantsOrganize || wantsOrganizeEmpty) && toolResults.length === 0) {
        const emptyAcceptance = wantsOrganizeEmpty && !wantsOrganize
        const args = JSON.stringify({
          taskId: kv('task'),
          sessionId: kv('sid'),
          seqFrom: Number(kv('seqFrom') || 0),
          seqTo: Number(kv('seqTo') || 999999),
          outcome: 'delivered',
          acceptance: emptyAcceptance ? [] : [{ text: 'probe acceptance item', derivedFromSeq: Number(kv('seqFrom') || 0) }],
          summary: emptyAcceptance ? 'probe empty acceptance' : 'probe summary：stub 工作回合完成',
        })
        const id = `call_probe_m3_organize_${Date.now()}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'commander_task_report', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'commander_task_report', arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if ((wantsAttach || wantsConfirm) && toolResults.length === 0) {
        const spec = wantsConfirm
          ? { name: 'commander_task_dispatch', args: { taskId: kv('task'), decisionId: kv('decision'), confirmTarget: { workspaceId: kv('ws'), mode: 'attach', sessionId: kv('sid') }, requestId: `req_m1r_confirm_${Date.now()}` } }
          : { name: 'commander_task_dispatch', args: { taskId: kv('task'), candidate: { workspaceId: kv('ws'), mode: 'attach', sessionId: kv('sid') }, requestId: `req_m1r_attach_${Date.now()}` } }
        const args = JSON.stringify(spec.args)
        const id = `call_probe_m1r_${Date.now()}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: spec.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: spec.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if ((wantsTask || wantsBoard) && toolResults.length === 0) {
        const spec = wantsBoard
          ? { name: 'commander_task_list', args: {} }
          : { name: 'commander_task_create', args: { title: 'probe-m1-tool-task', goal: 'verify commander tools visible in real agent turn' } }
        const args = JSON.stringify(spec.args)
        const id = `call_probe_m1_${Date.now()}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: spec.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: spec.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (toolResults.length > 0 && (wantsTask || wantsBoard || wantsAttach || wantsConfirm || wantsOrganize || wantsOrganizeEmpty)) {
        lastToolResult = toolResults[toolResults.length - 1]
        const toolMessage = toolMessagesAfterLastUser(options).at(-1)
        lastToolResultBlocks = Array.isArray(toolMessage?.content) ? toolMessage.content : null
      }
      const reply = marker.includes('PROBE_M1_TASK')
        ? 'probe-m1-tool-done'
        : marker.startsWith('Generate the session title')
          ? '订单导出 · 流式改造'
          : `stub-echo: ${lastUserText(options).slice(0, 80)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: reply.length, totalTokens: 8 + reply.length } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter([STUB_PROVIDER], new StubAdapter())

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) { const value = predicate(); if (value !== undefined && value !== false) return value; await sleep(stepMs) }
    return undefined
  }
  const register = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined) return
    const route = (path, handler) => ws.register({ kind: 'exact', path, handler })
    route('/m1e2e/health', (req, res) => json(res, 200, { ok: true, providerRegistered: safe(() => hostCtx.get('llm')?.listProviders?.().some((p) => p.id === STUB_PROVIDER)).value ?? false, stubCalls: calls.length }))
    route('/m1e2e/prepare', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, sessionId }
      try { out.selected = await controller.selectModel({ sessionId, provider: STUB_PROVIDER, model: STUB_MODEL }) } catch (error) { out.ok = false; out.error = String(error?.message ?? error) }
      json(res, 200, out)
    })
    route('/m1e2e/drive', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const text = url.searchParams.get('text') ?? 'PROBE_M1_TASK'
      const controller = hostCtx.get('sessionController')
      const before = (events.get(sessionId) ?? []).length
      const out = { ok: true, sessionId, text }
      try { out.accepted = await controller.prompt({ requestId: `req_m1e2e_${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal) } catch (error) { out.ok = false; out.error = String(error?.message ?? error) }
      const turnEnd = await waitFor(() => (events.get(sessionId) ?? []).slice(before).find((entry) => entry.type === 'turn/end'), 30000, 100)
      out.turnEnd = turnEnd ?? null
      out.events = (events.get(sessionId) ?? []).slice(before)
      out.stubCalls = calls.slice(-5)
      json(res, 200, out)
    })
    route('/m1e2e/create-session', async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const cwd = url.searchParams.get('cwd') ?? '/tmp'
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, cwd }
      try {
        out.created = await controller.create({ cwd })
        // 尽力把新会话登记到匹配工作区（M1R /commander/sessions 的 fallback 依赖 registry.sessionIds）
        try {
          const registry = hostCtx.get('workspaceRegistry')
          const sessionId = out.created?.sessionId
          if (registry?.list !== undefined && typeof sessionId === 'string') {
            const { realpathSync } = await import('node:fs')
            const canonical = (() => { try { return realpathSync(cwd) } catch { return cwd } })()
            const workspace = registry.list().find((item) => item.path === canonical || item.path === cwd)
            if (workspace?.attachSession !== undefined) { await workspace.attachSession(sessionId); out.attached = workspace.id }
          }
        } catch (error) { out.attachError = String(error?.message ?? error) }
      } catch (error) { out.ok = false; out.error = String(error?.message ?? error) }
      json(res, 200, out)
    })
    route('/m1e2e/agents', (req, res) => {
      const agents = hostCtx.get('agents')
      json(res, 200, { ok: true, ids: (agents?.list?.() ?? []).map((agent) => agent?.id) })
    })
    route('/m1e2e/events', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? ''
      json(res, 200, { ok: true, sessionId, events: events.get(sessionId) ?? [], stubCalls: calls, lastToolResult, lastToolResultBlocks })
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (hostCtx) => register(hostCtx))
  else setTimeout(() => register(ctx), 1000)
}
