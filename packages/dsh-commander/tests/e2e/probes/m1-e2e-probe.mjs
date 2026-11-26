/**
 * M1 e2e 专用探针（tester；只存在 tests/e2e，不进入包产物）。
 *
 * 作用：
 *  1) 在隔离 DSH_HOME 注册一个临时工作区（workspaceRegistry 初始为空；派发候选/绑定需要）；
 *  2) 注册 probe-stub/stub-1 确定性 LLM provider：按用户消息里的 M1E2E_* 标记**真实发起工具调用**
 *     （commander_task_create / commander_task_dispatch），用于驱动真实 Host 的 M1 工具链（不联网、非真实模型）；
 *  3) 提供 fake capabilityPanel（thunk 形态），用于验证能力 auto 的 rank/apply 与 fallback。
 *
 * 仅用于隔离 profile，不触碰 live Desktop。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

export const name = 'm1-e2e-probe'
export const inject = ['llm', 'workspaceRegistry', 'agents']

const PROVIDER = 'probe-stub'
/** 探针模拟「指挥官自己写的工作会话原文」；工作会话侧靠这个标记识别自己是工作会话。 */
const WORKER_MARKER = 'M1E2E_WORKER'
const WORKER_PROMPT = `${WORKER_MARKER} 任务标题/目标/验收提示由指挥官自己写；结束时说明产出与证据。`
const MODEL = 'stub-1'

const blockText = (message) => {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}
const lastUserText = (messages) => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue
    const text = blockText(messages[i])
    if (text.length > 0) return text
  }
  return ''
}
/** DSH 会在用户消息后追加运行时上下文 user 消息；标记可能不在最后一条，故按“最近包含标记的 user 消息”定位。 */
const markerUserIndex = (messages) => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue
    const text = blockText(messages[i])
    if (text.includes('M1E2E_')) return i
  }
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return i
  return -1
}
const markerText = (messages) => {
  const index = markerUserIndex(messages)
  return index >= 0 ? blockText(messages[index]) : ''
}
const toolCallsSinceLastUser = (messages) => {
  const index = markerUserIndex(messages)
  let count = 0
  for (let i = index + 1; i < (messages?.length ?? 0); i += 1) if (messages[i]?.role === 'tool') count += 1
  return count
}
const toolCallId = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

async function* textStream(text, index = 0) {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: text.length, totalTokens: 12 + text.length } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* toolCallStream(call) {
  const id = toolCallId('call')
  const args = JSON.stringify(call.args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 40, totalTokens: 60 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** 根据用户标记决定本轮动作（纯函数，便于日志）。 */
export function plannedAction(messages) {
  const text = markerText(messages)
  const toolCount = toolCallsSinceLastUser(messages)
  const line = (marker) => text.split('\n').find((item) => item.includes(marker)) ?? ''
  if (text.includes('M1E2E_CREATE')) {
    if (toolCount === 0) return { kind: 'tool-call', name: 'commander_task_create', args: { title: 'M1 e2e 任务', goal: '验证全确认派发链路（tester e2e）', priority: 'normal' } }
    return { kind: 'text', text: 'm1-e2e-task-created' }
  }
  const idRe = /[A-Za-z0-9_-]{6,}/
  const idAfter = (marker) => {
    const match = text.match(new RegExp(`${marker}\\s*[:：]\\s*(${idRe.source})`))
    return match?.[1] ?? ''
  }
  if (text.includes('M1E2E_DISPATCH_IDEMP')) {
    const taskId = idAfter('M1E2E_DISPATCH_IDEMP')
    if (toolCount === 0 && taskId !== '') return { kind: 'tool-call', name: 'commander_task_dispatch', args: { taskId, requestId: 'req_m1_idem_1', prompt: WORKER_PROMPT, capabilityNeeds: ['e2e'] } }
    return { kind: 'text', text: 'm1-e2e-dispatch-idempotent' }
  }
  if (text.includes('M1E2E_DISPATCH')) {
    const taskId = idAfter('M1E2E_DISPATCH')
    if (toolCount === 0 && taskId !== '') return { kind: 'tool-call', name: 'commander_task_dispatch', args: { taskId, requestId: `req_m1_first_${Date.now()}`, prompt: WORKER_PROMPT, capabilityNeeds: ['e2e'] } }
    return { kind: 'text', text: 'm1-e2e-needs-confirmation' }
  }
  if (text.includes('M1E2E_CONFIRM')) {
    const match = text.match(/M1E2E_CONFIRM\s*[:：]\s*([A-Za-z0-9_-]{6,})\s*[:：]\s*(dec_[0-9a-f]{24})?\s*[:：]\s*([A-Za-z0-9_-]{2,})\s*[:：]\s*(new|attach)(?:\s*[:：]\s*([A-Za-z0-9_-]{6,}))?/)
    if (toolCount === 0 && match !== null) {
      const [, taskId, decisionId, workspaceId, mode, sessionId] = match
      const confirmTarget = { workspaceId, mode, ...(mode === 'attach' && sessionId ? { sessionId } : {}) }
      return { kind: 'tool-call', name: 'commander_task_dispatch', args: { taskId, ...(decisionId ? { decisionId } : {}), confirmTarget, requestId: `req_m1_confirm_${Date.now()}` } }
    }
    return { kind: 'text', text: 'm1-e2e-confirmed' }
  }
  if (text.includes('M1E2E_ORGANIZE')) {
    const match = text.match(/M1E2E_ORGANIZE\s*[:：]\s*([A-Za-z0-9_-]{6,})\s*[:：]\s*([A-Za-z0-9_-]{6,})/)
    if (toolCount === 0 && match !== null) {
      return {
        kind: 'tool-call',
        name: 'commander_task_report',
        args: {
          taskId: match[1],
          sessionId: match[2],
          seqFrom: 0,
          seqTo: 4,
          outcome: 'delivered',
          acceptance: [{ text: 'e2e 验收点', verify: 'pnpm test', evidence: 'tests/artifacts/m2/e2e', derivedFromSeq: 0 }],
          summary: 'M2/M3 e2e 整理',
        },
      }
    }
    return { kind: 'text', text: 'm1-e2e-organized' }
  }
  // 工作会话收到的原文（turn/end 注入验收：长回复触发 8KB 截断）。
  // DSH 会在用户消息后追加运行时上下文 user 消息 → 在全部 user 消息中查找探针自己写的 prompt 标记。
  const allUserText = (messages ?? []).filter((message) => message?.role === 'user').map((message) => blockText(message)).join('\n')
  if (allUserText.includes(WORKER_MARKER)) {
    return { kind: 'text', text: `HEAD-${'x'.repeat(9000)}-TAIL` }
  }
  if (allUserText.includes('上一轮验收未通过') && !text.includes('M1E2E_')) {
    return { kind: 'text', text: 'm1-e2e-rework-ack' }
  }
  return { kind: 'text', text: `m1-e2e-echo: ${text.slice(0, 80)}` }
}

export async function apply(ctx, config = {}) {
  const panelCounts = { rank: 0, apply: 0 }
  const sessionCreateCount = { count: 0 }
  const eventsBySession = new Map()
  // 诊断路由：观测 agents 服务的 list/get 差异（tools 注册失败的宿主契约证据）
  try {
    const hostCtx = ctx
    const registerDiag = (scope) => {
      const ws = scope.get('webServer')
      if (ws === undefined) return
      ws.register({
        kind: 'exact',
        path: '/m1r/create-session',
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = url.searchParams.get('cwd') ?? ''
          const done = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body) + '\n') }
          void (async () => {
            try {
              const controller = scope.get('sessionController') ?? ctx.get('sessionController')
              const created = await controller.create(cwd !== '' ? { cwd } : {})
              sessionCreateCount.count += 1
              const sessionId = created?.sessionId ?? created?.id ?? ''
              const out = { ok: true, sessionId }
              // 登记到匹配工作区（/commander/sessions 的 fallback 依赖 registry.sessionIds；同 devops driver 配方）
              try {
                const registry = scope.get('workspaceRegistry') ?? ctx.get('workspaceRegistry')
                const { realpathSync } = await import('node:fs')
                const canonical = (() => { try { return realpathSync(cwd) } catch { return cwd } })()
                const workspace = (registry?.list?.() ?? []).find((item) => item.path === canonical || item.path === cwd)
                if (workspace?.attachSession !== undefined && sessionId !== '') { await workspace.attachSession(sessionId); out.attachedWorkspaceId = workspace.id }
              } catch (error) { out.attachError = String(error?.message ?? error) }
              done(200, out)
            } catch (error) { done(500, { ok: false, message: String(error?.message ?? error) }) }
          })()
        },
      })
      ws.register({
        kind: 'exact',
        path: '/m1r/events',
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const events = sessionId === '' ? [...eventsBySession.entries()].map(([id, list]) => ({ sessionId: id, events: list })) : (eventsBySession.get(sessionId) ?? [])
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, sessionId, events }, null, 2) + '\n')
        },
      })
      ws.register({
        kind: 'exact',
        path: '/m1e2e/diag',
        handler: (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const out = { ok: true, sessionId, agentsType: typeof scope.get('agents'), errors: [], panelCalls: { ...panelCounts }, sessionsCreated: sessionCreateCount.count, workspaces: [] }
          try {
            const registry = scope.get('workspaceRegistry')
            out.workspaces = (registry?.list?.() ?? []).map((item) => ({ id: item.id, path: item.path, name: item.name }))
          } catch (error) { out.errors.push(`workspaces:${String(error?.message ?? error).slice(0, 120)}`) }
          try {
            const agents = scope.get('agents')
            out.hasGet = typeof agents?.get === 'function'
            out.hasList = typeof agents?.list === 'function'
            out.listLength = typeof agents?.list === 'function' ? (agents.list() ?? []).length : null
            try { out.getFound = agents?.get?.(sessionId) !== undefined } catch (error) { out.errors.push(`get:${String(error?.message ?? error).slice(0, 120)}`) }
            try {
              const list = agents?.list?.() ?? []
              out.listSessionIds = list.map((agent) => agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id).slice(0, 10)
            } catch (error) { out.errors.push(`list:${String(error?.message ?? error).slice(0, 120)}`) }
          } catch (error) { out.errors.push(String(error?.message ?? error)) }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(out, null, 2) + '\n')
        },
      })
    }
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (scope) => registerDiag(scope))
    else setTimeout(() => registerDiag(ctx), 1000)
  } catch (error) { process.stderr.write(`[m1-e2e-probe] diag route failed ${String(error?.message ?? error)}\n`) }
  // work 会话模型：dispatch 创建的会话未 selectModel → 统一在 agent/created 后选择 stub 模型，
  // 使工作会话 prompt 能进入 turn/start（隔离环境无真实 provider）。
  try {
    ctx.on('agent/created', (...args) => {
      const agent = (args[0] ?? {}).agent
      const sessionId = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      for (const delay of [20, 200, 1000]) {
        setTimeout(() => {
          void (async () => {
            try {
              const controller = ctx.get('sessionController')
              await controller?.selectModel?.({ sessionId, provider: PROVIDER, model: MODEL })
            } catch (error) { process.stderr.write(`[m1-e2e-probe] selectModel(${sessionId.slice(-8)}) failed: ${String(error?.message ?? error)}\n`) }
          })()
        }, delay).unref?.()
      }
    })
    ctx.on('session/event', (...args) => {
      const session = args[0] ?? {}
      const event = args[1] ?? {}
      if (session.id !== undefined) {
        const list = eventsBySession.get(session.id) ?? []
        let text = ''
        try { text = JSON.stringify(event).slice(0, 12000) } catch { text = '' }
        list.push({ type: event.type, seq: event.seq, at: Date.now(), text })
        if (list.length > 80) list.shift()
        eventsBySession.set(session.id, list)
      }
      if (['turn/start', 'turn/end', 'error', 'assistant/message'].includes(event.type)) {
        process.stdout.write(`[m1-e2e-probe] session-event sid=${String(session.id).slice(-8)} type=${event.type} seq=${event.seq}\n`)
      }
    })
  } catch (error) { process.stderr.write(`[m1-e2e-probe] model select/session log setup failed ${String(error?.message ?? error)}\n`) }
  // DEBUG: 观察 agent/created 载荷与 agent tools 服务
  try {
    ctx.on('agent/created', (...args) => {
      const payload = args[0] ?? {}
      const agent = payload.agent
      const sid = agent?.session?.id ?? agent?.session?.header?.id
      let toolsType = 'n/a'
      let toolKeys = []
      try {
        const tools = agent?.ctx?.get?.('tools')
        toolsType = typeof tools
        toolKeys = tools ? Object.keys(tools) : []
      } catch (error) { toolsType = `err:${String(error?.message ?? error).slice(0, 80)}` }
      process.stdout.write(`[m1-e2e-probe] agent/created agentId=${agent?.id} sid=${sid} toolsType=${toolsType} toolKeys=[${toolKeys.join(',')}]\n`)
    })
  } catch (error) { process.stderr.write(`[m1-e2e-probe] debug listener failed ${String(error?.message ?? error)}\n`) }
  // 1) 工作区（隔离 home 初始为空；支持多工作区用于 M1R 跨工作区/空会话列表）
  const workspacePaths = Array.isArray(config.workspacePaths) && config.workspacePaths.length > 0
    ? config.workspacePaths
    : (typeof config.workspacePath === 'string' && config.workspacePath !== '' ? [config.workspacePath] : [])
  setTimeout(() => {
    void (async () => {
      try {
        const registry = ctx.get('workspaceRegistry')
        for (const [index, workspacePath] of workspacePaths.entries()) {
          const existing = registry.list().find((workspace) => workspace.path === workspacePath)
          if (existing !== undefined) {
            process.stdout.write(`[m1-e2e-probe] workspace exists id=${existing.id} path=${workspacePath}\n`)
            continue
          }
          const created = await registry.create(workspacePath, `m1-e2e-ws-${index}`)
          process.stdout.write(`[m1-e2e-probe] workspace created id=${created.id} path=${created.path}\n`)
        }
      } catch (error) {
        process.stderr.write(`[m1-e2e-probe] workspace create failed: ${String(error?.message ?? error)}\n`)
      }
    })()
  }, 900)

  // 2) stub LLM provider（真实工具调用）
  const require_ = createRequire(process.argv[1] ?? import.meta.url)
  const llmEntry = require_.resolve('@deepseek-ai/dsh-llm')
  const { LlmAdapter } = await import(pathToFileURL(llmEntry).href)
  const logged = []
  class StubAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'M1 E2E Stub（验证用，非真实模型）' } }
    async listModels(provider) { return [{ provider, id: MODEL, name: 'M1 E2E Stub', description: 'tester e2e stub' }] }
    async resolveModel(provider, model) { return { provider, id: model, name: 'M1 E2E Stub', context: { contextWindow: 128000 } } }
    async *stream(options) {
      const messages = options?.messages ?? []
      const action = plannedAction(messages)
      logged.push({ at: Date.now(), kind: action.kind, name: action.name, marker: markerText(messages).slice(0, 80) })
      const toolNames = (options?.tools ?? []).map((tool) => tool?.name ?? tool?.id).filter(Boolean)
      const lastTool = [...messages].reverse().find((message) => message?.role === 'tool')
      process.stdout.write(`[m1-e2e-probe] stream action=${action.kind}${action.name ? `:${action.name}` : ''} tools=[${toolNames.join(',')}] toolResult=${JSON.stringify(blockText(lastTool).slice(0, 300))}\n`)
      if (action.kind === 'tool-call') { yield* toolCallStream(action); return }
      yield* textStream(action.text)
    }
  }
  ctx.llm.registerAdapter([PROVIDER], new StubAdapter())
  process.stdout.write(`[m1-e2e-probe] stub provider registered: ${PROVIDER}/${MODEL}\n`)

  // 3) fake capabilityPanel（thunk 形态；panelMode=none 时不提供 → 验证 fallback）
  if (config.panelMode !== 'none' && typeof ctx.provide === 'function') {
    const fakePanel = {
      jev: {
        getConfig: () => ({ threshold: 0.5, model: 'fake-jev', hasApiKey: true }),
        rank: async () => { panelCounts.rank += 1; return { ok: true, items: [{ id: 'cap_m1_e2e', name: 'probe-skill-m1', kind: 'skill', score: 0.92, applicable: true, enabledInSession: false }] } },
        apply: async ({ plan }) => { panelCounts.apply += 1; return { ok: true, applied: plan?.length ?? 0, enabled: plan?.length ?? 0, disabled: 0, elapsedMs: 7, pending: false } },
      },
    }
    ctx.provide('capabilityPanel', () => fakePanel)
    process.stdout.write('[m1-e2e-probe] fake capabilityPanel provided (thunk)\n')
  } else {
    process.stdout.write('[m1-e2e-probe] capabilityPanel absent (panelMode=none)\n')
  }
}
