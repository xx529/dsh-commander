/**
 * Stub LLM provider 可行性实验（临时）：注册 provider 路由 `probe-stub`，
 * 让 sessionController.prompt 能在隔离探针 Home（无 provider 凭据）里跑通一轮。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'probe-stub'
export const inject = ['llm']

const lastUserText = (options) => {
  const messages = options?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
    if (text.length > 0) return text
  }
  return ''
}

export async function apply(ctx, config = {}) {
  const require_ = createRequire(process.argv[1])
  const llmEntry = require_.resolve('@deepseek-ai/dsh-llm')
  const { LlmAdapter } = await import(pathToFileURL(llmEntry).href)

  class StubAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Probe Stub（验证用，非真实模型）' } }
    async listModels(provider) { return [{ provider, id: 'stub-1', name: 'Probe Stub Model', description: 'probe stub' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'Probe Stub Model' } }
    async *stream(options) {
      const text = lastUserText(options)
      const reply = `stub-echo: ${text.slice(0, 200)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: reply.length, totalTokens: 10 + reply.length } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const fs = await import('node:fs')
  let regInfo = {}
  try {
    const registration = ctx.llm.registerAdapter(['probe-stub'], new StubAdapter())
    regInfo = { registered: true, handleType: typeof registration, providersNow: ctx.llm.listProviders().map(p => p.id) }
    setTimeout(() => { regInfo.providersLater = ctx.llm.listProviders().map(p => p.id); fs.writeFileSync('/tmp/probe-stub-reg.json', JSON.stringify(regInfo, null, 2)) }, 1000)
  } catch (e) { regInfo = { registered: false, error: String(e) }; fs.writeFileSync('/tmp/probe-stub-reg.json', JSON.stringify(regInfo, null, 2)) }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }

  const registerRoutes = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined) return
    ws.register({ kind: 'exact', path: '/t/ping', handler: async (req, res) => {
      const llm = hostCtx.get('llm')
      let providers = null, models = null, err = null
      try { providers = llm.listProviders() } catch (e) { err = String(e) }
      try { models = await llm.listModels('probe-stub') } catch (e) { err = (err ?? '') + ' | models: ' + String(e) }
      json(res, 200, { ok: true, providers, models, err, hasRegisterAdapter: typeof llm.registerAdapter })
    } })
    ws.register({ kind: 'exact', path: '/t/run', handler: async (req, res) => {
      const out = { steps: {} }
      try {
        const controller = hostCtx.get('sessionController')
        out.steps.modelCatalogBefore = await controller.modelCatalog()
        const created = await controller.create({ cwd: config.cwd })
        out.steps.create = created
        const sessionId = created.sessionId
        out.steps.selectModel = await controller.selectModel({ sessionId, provider: 'probe-stub', model: 'stub-1' })
        const events = []
        hostCtx.on('session/event', (session, event) => {
          if (session?.id !== sessionId) return
          events.push({ type: event.type, seq: event.seq, data: event.data })
        })
        out.steps.prompt = await controller.prompt({ requestId: `probe-stub-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text: '只回一句：收到' }] }, new AbortController().signal)
        const deadline = Date.now() + 30000
        while (Date.now() < deadline && !events.some((e) => e.type === 'turn/end')) await new Promise((r) => setTimeout(r, 200))
        out.steps.events = events.map((e) => e.type)
        out.steps.turnEnd = events.find((e) => e.type === 'turn/end')?.data ?? null
        out.steps.assistantMessages = events.filter((e) => e.type === 'assistant/message').map((e) => ({ seq: e.seq, role: e.data?.message?.role, blocks: (e.data?.message?.content ?? []).map((b) => b.type), text: (e.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 80) }))
        out.steps.errors = events.filter((e) => e.type.includes('error') || e.data?.error).map((e) => ({ type: e.type, error: e.data?.error }))
        out.ok = events.some((e) => e.type === 'turn/end')
      } catch (error) { out.ok = false; out.error = String(error?.message ?? error) }
      json(res, 200, out)
    } })
    ws.register({ kind: 'exact', path: '/t/quit', handler: (req, res) => { json(res, 200, { ok: true }); setTimeout(() => { const exit = ctx.get('appExit'); if (typeof exit === 'function') exit(0); else process.exit(0) }, 100) } })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (hostCtx) => registerRoutes(hostCtx))
  else setTimeout(() => registerRoutes(ctx), 1000)
}
