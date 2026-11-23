/**
 * V3 · 会话创建、模型选择、prompt 与 resume 探针（P-A Host 探针插件）
 *
 * 覆盖协议 §4：create({workspaceId|cwd, agentPreset}) 落点、参数互斥、preset 不存在、
 * selectModel 生效、prompt({mode:'queue'}) 唤醒一轮、对非空会话再 create 的行为、
 * 以及**重启 Host 后按 sessionId 继续**（懒 resume）。
 *
 * 模型链路用 `stub-llm.mjs` 注册的 `probe-stub` provider（**验证用 stub，非真实模型**）；
 * 真实 provider 端到端留 M0 验收。
 *
 * 路由：
 *   GET /probe/v3/health
 *   GET /probe/v3/catalog
 *   GET /probe/v3/workspaces
 *   GET /probe/v3/create-cwd?cwd=...&preset=...
 *   GET /probe/v3/create-workspace?workspaceId=...&preset=...
 *   GET /probe/v3/create-both?workspaceId=...&cwd=...
 *   GET /probe/v3/create-bad-preset?cwd=...&preset=...
 *   GET /probe/v3/select-model?sessionId=...&provider=...&model=...
 *   GET /probe/v3/prompt?sessionId=...&marker=PROBE_V3_OK
 *   GET /probe/v3/rebind?sessionId=...&cwd=...
 *   GET /probe/v3/persist-info?sessionId=...      写"重启前"状态（lastSeq/turnEnds/header）
 *   GET /probe/v3/resume?sessionId=...&expectedPrevSeq=...   重启后懒 resume + 继续回合
 *   GET /probe/v3/session?sessionId=...
 *   GET /probe/v3/quit
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installStubLlm, STUB_MODEL, STUB_PROVIDER } from './stub-llm.mjs'

export const name = 'probe-v3'
export const inject = ['llm']

const errText = (error) => String(error?.message ?? error)
const safe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: errText(error) } } }

export async function apply(ctx, config = {}) {
  const outDir = config.outDir ?? '/tmp/dsh-commander-probe/evidence/v3'
  const cwd = config.cwd ?? '/tmp/dsh-commander-probe/ws-v3'
  const summaryFile = join(outDir, 'v3-probe-summary.json')
  const startedAt = new Date().toISOString()
  const logs = []
  const pushLog = (entry) => { logs.push({ at: new Date().toISOString(), ...entry }); if (logs.length > 3000) logs.shift() }
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }

  const stub = await installStubLlm(ctx)

  const sessions = new Map() // sessionId -> { sessionRef, events: [] }
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id ?? null
    if (sessionId === null) return
    let record = sessions.get(sessionId)
    if (record === undefined) { record = { sessionRef: session, events: [] }; sessions.set(sessionId, record) }
    record.sessionRef = session
    const data = event?.data !== null && typeof event?.data === 'object' ? event.data : undefined
    const message = data?.message
    const text = Array.isArray(message?.content) ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('') : ''
    record.events.push({
      seq: event?.seq ?? null, type: event?.type ?? null,
      turn: data?.turn ?? null, reasonKind: data?.reason?.kind ?? null,
      role: message?.role ?? null,
      text: event?.type === 'assistant/message' ? text : null,
      provider: data?.provider ?? null, model: data?.model ?? null,
      cwd: session?.header?.cwd ?? null,
    })
    pushLog({ kind: 'session/event', sessionId, seq: event?.seq, type: event?.type })
  })

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }
  const query = (req) => { const url = new URL(req.url ?? '/', 'http://localhost'); return { get: (name) => url.searchParams.get(name) ?? undefined } }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) { const value = predicate(); if (value !== undefined && value !== false) return value; await sleep(stepMs) }
    return undefined
  }
  const waitTurnEnd = (sessionId, timeoutMs = 60000) => waitFor(() => sessions.get(sessionId)?.events.find((entry) => entry.type === 'turn/end'), timeoutMs)
  const promptText = (controller, sessionId, text) => controller.prompt({
    requestId: `probe-v3-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId, mode: 'queue', content: [{ type: 'text', text }],
  }, new AbortController().signal)
  const headerCwd = (sessionId) => sessions.get(sessionId)?.sessionRef?.header?.cwd ?? null
  const eventSummary = (sessionId) => (sessions.get(sessionId)?.events ?? []).map((entry) => ({ seq: entry.seq, type: entry.type, turn: entry.turn, reasonKind: entry.reasonKind }))

  const registerRoutes = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return pushLog({ kind: 'routes/unavailable' })
    const route = (path, handler) => ws.register({
      kind: 'exact', path,
      handler: async (req, res) => {
        try { await handler(req, res) } catch (error) { pushLog({ kind: 'route/error', path, error: errText(error) }); json(res, 500, { ok: false, path, error: errText(error) }) }
      },
    })

    route('/probe/v3/health', async (req, res) => {
      const controller = hostCtx.get('sessionController')
      json(res, 200, {
        ok: true, node: process.version, startedAt,
        dshHome: process.env.DSH_HOME ?? null,
        stubProvider: { provider: STUB_PROVIDER, model: STUB_MODEL, registered: hostCtx.get('llm')?.listProviders?.().some((p) => p.id === STUB_PROVIDER) ?? false },
        services: { sessionController: typeof controller, workspaceRegistry: typeof safe(() => hostCtx.get('workspaceRegistry')).value, llm: typeof safe(() => hostCtx.get('llm')).value, agents: typeof safe(() => hostCtx.get('agents')).value, sessionQuery: typeof safe(() => hostCtx.get('sessionQuery')).value },
        sessionControllerKeys: controller === undefined ? null : Object.keys(controller).sort(),
      })
    })

    route('/probe/v3/catalog', async (req, res) => {
      const controller = hostCtx.get('sessionController')
      const catalog = await controller.modelCatalog()
      json(res, 200, { ok: true, catalog })
    })

    route('/probe/v3/workspaces', async (req, res) => {
      const registry = hostCtx.get('workspaceRegistry')
      if (registry === undefined) return json(res, 200, { ok: false, reason: 'workspaceRegistry_unavailable' })
      const list = registry.list()
      json(res, 200, {
        ok: true, count: list.length,
        workspaces: list.map((workspace) => ({ id: workspace.id, path: workspace.path, title: workspace.title, sessionIds: [...workspace.sessionIds] })),
      })
    })

    route('/probe/v3/create-cwd', async (req, res) => {
      const { get } = query(req)
      const targetCwd = get('cwd') ?? cwd
      const preset = get('preset')
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, requestedCwd: targetCwd, requestedPreset: preset ?? null }
      try {
        const created = await controller.create({ cwd: targetCwd, ...(preset !== undefined ? { agentPreset: preset } : {}) })
        await sleep(300)
        out.result = created
        out.headerCwd = headerCwd(created.sessionId)
        out.cwdMatches = out.headerCwd === targetCwd
        out.agents = (hostCtx.get('agents')?.list?.() ?? []).map((agent) => agent?.id)
        out.eventTypes = [...new Set((sessions.get(created.sessionId)?.events ?? []).map((entry) => entry.type))]
        out.sessionId = created.sessionId
      } catch (error) { out.ok = false; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    route('/probe/v3/create-workspace', async (req, res) => {
      const { get } = query(req)
      const registry = hostCtx.get('workspaceRegistry')
      const controller = hostCtx.get('sessionController')
      const workspaceId = get('workspaceId') ?? registry?.list?.()[0]?.id
      const preset = get('preset')
      const out = { ok: true, requestedWorkspaceId: workspaceId ?? null, requestedPreset: preset ?? null }
      if (workspaceId === undefined || workspaceId === null) return json(res, 200, { ok: false, reason: 'no_workspace' })
      const workspace = registry.get(workspaceId)
      out.workspacePath = workspace?.path ?? null
      try {
        const created = await controller.create({ workspaceId, ...(preset !== undefined ? { agentPreset: preset } : {}) })
        await sleep(300)
        out.result = created
        out.headerCwd = headerCwd(created.sessionId)
        out.cwdEqualsWorkspacePath = out.headerCwd === workspace?.path
        out.workspaceSessionIds = [...(workspace?.sessionIds ?? [])]
        out.sessionAttached = out.workspaceSessionIds.includes(created.sessionId)
        out.sessionId = created.sessionId
      } catch (error) { out.ok = false; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    route('/probe/v3/create-both', async (req, res) => {
      const { get } = query(req)
      const registry = hostCtx.get('workspaceRegistry')
      const controller = hostCtx.get('sessionController')
      const workspaceId = get('workspaceId') ?? registry?.list?.()[0]?.id
      const targetCwd = get('cwd') ?? cwd
      const out = { ok: true, requestedWorkspaceId: workspaceId ?? null, requestedCwd: targetCwd }
      try {
        out.result = await controller.create({ workspaceId, cwd: targetCwd })
        out.rejected = false
      } catch (error) { out.rejected = true; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    route('/probe/v3/create-bad-preset', async (req, res) => {
      const { get } = query(req)
      const targetCwd = get('cwd') ?? cwd
      const preset = get('preset') ?? 'probe-nonexistent-preset'
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, requestedCwd: targetCwd, requestedPreset: preset }
      try {
        out.result = await controller.create({ cwd: targetCwd, agentPreset: preset })
        out.rejected = false
      } catch (error) { out.rejected = true; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    route('/probe/v3/select-model', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const provider = get('provider') ?? STUB_PROVIDER
      const model = get('model') ?? STUB_MODEL
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, sessionId, requested: { provider, model } }
      try {
        out.selected = await controller.selectModel({ sessionId, provider, model })
        await sleep(200)
        out.selectionEvents = (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'model/selection')
        out.requestContext = (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'request/context').map((entry) => ({ seq: entry.seq, provider: entry.provider, model: entry.model }))
        out.matchesRequest = out.selected?.selected?.provider === provider && out.selected?.selected?.model === model
      } catch (error) { out.ok = false; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    route('/probe/v3/prompt', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const marker = get('marker') ?? 'PROBE_V3_OK'
      const controller = hostCtx.get('sessionController')
      const beforeEnds = (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'turn/end').length
      const out = { ok: true, sessionId, marker, turnEndsBefore: beforeEnds }
      try { out.accepted = await promptText(controller, sessionId, `${marker} 请只回一句`) } catch (error) { out.ok = false; out.error = errText(error) }
      await waitFor(() => (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'turn/end').length > beforeEnds, 60000, 100)
      const events = sessions.get(sessionId)?.events ?? []
      const turnEnds = events.filter((entry) => entry.type === 'turn/end')
      const end = turnEnds.at(-1) ?? null
      out.turnEnd = end === null ? null : { seq: end.seq, turn: end.turn, reasonKind: end.reasonKind }
      out.turnStart = [...events].reverse().find((entry) => entry.type === 'turn/start') ?? null
      out.assistantMessages = events.filter((entry) => entry.type === 'assistant/message').map((entry) => ({ seq: entry.seq, text: entry.text })).slice(-3)
      out.eventSummary = eventSummary(sessionId)
      out.headerCwd = headerCwd(sessionId)
      out.sessionId = sessionId
      json(res, 200, out)
    })

    route('/probe/v3/rebind', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const targetCwd = get('cwd') ?? cwd
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, requestedSessionId: sessionId, requestedCwd: targetCwd }
      try {
        const created = await controller.create({ sessionId, cwd: targetCwd })
        await sleep(300)
        out.result = created
        out.returnedDifferentId = created.sessionId !== sessionId
        out.originalStillLive = (hostCtx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === sessionId)
        out.returnedLive = (hostCtx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === created.sessionId)
      } catch (error) { out.ok = false; out.error = errText(error); out.errorName = error?.name ?? null; out.errorCode = error?.code ?? null }
      json(res, 200, out)
    })

    // 重启前状态快照（供第二次启动的 resume 连续性比对）
    route('/probe/v3/persist-info', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const events = sessions.get(sessionId)?.events ?? []
      const turnEnds = events.filter((entry) => entry.type === 'turn/end')
      const out = {
        ok: true, sessionId,
        headerCwd: headerCwd(sessionId),
        eventCount: events.length,
        lastSeq: events.at(-1)?.seq ?? null,
        lastTurnEnd: turnEnds.at(-1) ?? null,
        turnEnds: turnEnds.map((entry) => ({ seq: entry.seq, turn: entry.turn, reasonKind: entry.reasonKind })),
        assistantMessages: events.filter((entry) => entry.type === 'assistant/message').map((entry) => ({ seq: entry.seq, text: entry.text })),
        agents: (hostCtx.get('agents')?.list?.() ?? []).map((agent) => agent?.id),
      }
      try { writeFileSync(join(outDir, 'v3-before-restart.json'), JSON.stringify({ ...out, at: new Date().toISOString(), stubCalls: stub.calls }, null, 2) + '\n') } catch { /* noop */ }
      json(res, 200, out)
    })

    // 重启后：先读冷状态（懒恢复前提），再 prompt 同一 sessionId
    route('/probe/v3/resume', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const expectedPrevSeq = Number(get('expectedPrevSeq') ?? 'NaN')
      const controller = hostCtx.get('sessionController')
      const out = { ok: true, sessionId, expectedPrevSeq: Number.isFinite(expectedPrevSeq) ? expectedPrevSeq : null }
      // 1) 未 prompt 前：只读冷状态（不主动 resume）
      try {
        out.coldState = await controller.state({ sessionId }, new AbortController().signal)
      } catch (error) { out.coldState = { error: errText(error), name: error?.name ?? null, code: error?.code ?? null } }
      out.agentsBeforePrompt = (hostCtx.get('agents')?.list?.() ?? []).map((agent) => agent?.id)
      out.liveBeforePrompt = out.agentsBeforePrompt.includes(sessionId)
      // 2) 直接 prompt 同一 sessionId（期望懒 resume）
      try { out.accepted = await promptText(controller, sessionId, 'PROBE_V3_RESUME 重启后继续') } catch (error) { out.ok = false; out.error = errText(error) }
      await waitFor(() => (sessions.get(sessionId)?.events ?? []).some((entry) => entry.type === 'turn/end'), 60000, 100)
      const events = sessions.get(sessionId)?.events ?? []
      const firstSeq = events[0]?.seq ?? null
      const turnEnds = events.filter((entry) => entry.type === 'turn/end')
      const end = turnEnds.at(-1) ?? null
      out.seqStart = firstSeq
      out.lastSeq = events.at(-1)?.seq ?? null
      out.turnEnd = end === null ? null : { seq: end.seq, turn: end.turn, reasonKind: end.reasonKind }
      out.assistantMessages = events.filter((entry) => entry.type === 'assistant/message').map((entry) => ({ seq: entry.seq, text: entry.text }))
      out.newSessionCreated = false // 由调用方用 sessionId/agents 复核（见 agentsAfter）
      out.agentsAfter = (hostCtx.get('agents')?.list?.() ?? []).map((agent) => agent?.id)
      out.sessionIdUnchanged = out.agentsAfter.includes(sessionId)
      out.seqContinuous = Number.isFinite(expectedPrevSeq) ? firstSeq === expectedPrevSeq + 1 : null
      out.headerCwd = headerCwd(sessionId)
      out.eventTypes = [...new Set(events.map((entry) => entry.type))]
      json(res, 200, out)
    })

    route('/probe/v3/session', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      json(res, 200, { ok: true, sessionId, live: (hostCtx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === sessionId), headerCwd: headerCwd(sessionId), eventCount: (sessions.get(sessionId)?.events ?? []).length, events: sessions.get(sessionId)?.events ?? [] })
    })

    route('/probe/v3/quit', async (req, res) => {
      try {
        writeFileSync(summaryFile, JSON.stringify({
          phase: 'quit', at: new Date().toISOString(), startedAt, node: process.version,
          stubProvider: STUB_PROVIDER, stubModel: STUB_MODEL, stubCalls: stub.calls,
          sessions: [...sessions.entries()].map(([sessionId, record]) => ({ sessionId, eventCount: record.events.length, headerCwd: record.sessionRef?.header?.cwd ?? null })),
          logs,
        }, null, 2) + '\n')
      } catch { /* noop */ }
      json(res, 200, { ok: true, summaryFile, logs: logs.length })
      setTimeout(() => { const exit = (() => { try { return ctx.get('appExit') } catch { return undefined } })(); if (typeof exit === 'function') exit(0); else process.exit(0) }, 150)
    })

    pushLog({ kind: 'routes/registered', origin: (() => { try { return ws.getOrigin() } catch { return null } })() })
  }

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (hostCtx) => { registerRoutes(hostCtx) })
  else setTimeout(() => registerRoutes(ctx), 1000)
}
