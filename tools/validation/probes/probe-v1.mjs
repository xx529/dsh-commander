/**
 * V1 · 能力面板服务探针（P-A Host 探针插件）
 *
 * 形态：`--patch` 覆盖层插入的 Host 插件，`inject: []`（**不**注入 capabilityPanel，
 * 这样面板缺失时探针仍启动，能看到"缺失"这个事实）。
 *
 * 提供 /probe/v1/* HTTP 观测口（经宿主 webServer 注册，仅 loopback），由
 * `tools/validation/scripts/run-v1.sh` 用 curl 逐步驱动并落盘原始返回。
 *
 * 证据口径：
 *   - 只读观察 + 显式写：写面板自身会话开关（apply）与探针自己的证据文件；
 *   - 不注册工具、不改会话日志类型、不写 live profile；
 *   - 结束时经 /probe/v1/quit 走 ctx.get('appExit')(0) 有序退出。
 *
 * 路由：
 *   GET /probe/v1/health     服务形状（panelRawType / panelKeys / jevKeys / fallback 判定）
 *   GET /probe/v1/config     panel.jev.getConfig()（无明文 key 的视图）
 *   GET /probe/v1/units      可应用性枚举代理：panel.tools.list + 派生 capability id
 *   GET /probe/v1/rank       panel.jev.rank({sessionId,draft,cwd}) 原始返回
 *   GET /probe/v1/apply      panel.jev.apply({sessionId,plan,cwd}) 原始返回
 *   GET /probe/v1/create     sessionController.create({sessionId?,cwd}) 返回
 *   GET /probe/v1/prompt     sessionController.prompt(...) + 等待 turn/end 摘要
 *   GET /probe/v1/session    事件缓冲中该会话的事件摘要 + agents.list
 *   GET /probe/v1/state      该会话的 session-capabilities.json 记录 + 面板会话视图
 *   GET /probe/v1/events     全量事件缓冲（agent/created、session/event 压平）
 *   GET /probe/v1/quit       写 summary 证据后有序退出
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'probe-v1'
export const inject = []

/** capabilityId 复刻：`cap_` + sha256(namespaceKey) 前 36 位 hex（面板 lib/jev/rank.js:116-119）。 */
function capabilityId(namespaceKey) {
  return `cap_${createHash('sha256').update(namespaceKey, 'utf8').digest('hex').slice(0, 36)}`
}

const errText = (error) => String(error?.message ?? error)

export function apply(ctx, config = {}) {
  const outDir = config.outDir ?? '/tmp/dsh-commander-probe/evidence'
  const defaultCwd = config.cwd ?? '/tmp/dsh-commander-probe/ws1'
  const startedAt = new Date().toISOString()

  const events = []
  const log = []
  const t0 = Date.now()
  const pushLog = (entry) => {
    log.push({ at: new Date().toISOString(), elapsedMs: Date.now() - t0, ...entry })
  }
  const pushEvent = (entry) => {
    events.push({ at: new Date().toISOString(), elapsedMs: Date.now() - t0, ...entry })
    if (events.length > 5000) events.shift()
  }

  // ---- 事件订阅：不依赖任何服务，面板/会话缺失时也能观察 ----
  try {
    ctx.on('agent/created', (payload) => pushEvent({ kind: 'agent/created', agentId: payload?.agent?.id ?? null }))
    ctx.on('agent/disposed', (payload) => pushEvent({ kind: 'agent/disposed', agentId: payload?.agent?.id ?? null }))
    ctx.on('session/event', (session, event) => {
      const data = event?.data !== null && typeof event?.data === 'object' ? event.data : undefined
      const messageContent = data?.message?.content
      const textBlocks = Array.isArray(messageContent)
        ? messageContent.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
        : []
      pushEvent({
        kind: 'session/event',
        sessionId: session?.id ?? null,
        type: event?.type ?? null,
        seq: event?.seq ?? null,
        turn: data?.turn ?? event?.turn ?? null,
        step: data?.step ?? null,
        role: data?.message?.role ?? data?.role ?? null,
        reason: data?.reason ?? null,
        textLength: textBlocks.length === 0 ? null : textBlocks.join('').length,
        errorText: data?.error?.message !== undefined ? String(data.error.message) : (typeof data?.error === 'string' ? data.error : null),
        dataKeys: data === undefined ? null : Object.keys(data),
      })
    })
  } catch (error) {
    pushEvent({ kind: 'subscribe/error', error: errText(error) })
  }

  // ---- 服务解析（双形状：thunk 或对象）----
  const rawPanel = () => {
    try { return ctx.get('capabilityPanel') } catch { return undefined }
  }
  const resolvePanel = () => {
    const raw = rawPanel()
    if (raw === undefined || raw === null) return undefined
    if (typeof raw === 'function') {
      try { return raw() } catch (error) { pushLog({ kind: 'panel/thunk-threw', error: errText(error) }); return undefined }
    }
    return raw
  }
  /** 失败回退判定：面板不可用 → inherit（V1-C5）。 */
  const dispatchMode = () => {
    const raw = rawPanel()
    if (raw === undefined || raw === null) return { mode: 'inherit', reason: 'panel_unavailable' }
    const panel = resolvePanel()
    if (panel === undefined || typeof panel.jev?.rank !== 'function' || typeof panel.jev?.apply !== 'function') {
      return { mode: 'inherit', reason: 'panel_unavailable' }
    }
    return { mode: 'auto', reason: 'panel_available' }
  }

  const json = (res, status, body) => {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text + '\n')
  }
  const query = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return { url, get: (name) => url.searchParams.get(name) ?? undefined }
  }
  const panelHealth = async () => {
    const raw = rawPanel()
    const panel = resolvePanel()
    let panelVersion = null
    let panelEngines = null
    let panelPackageJson = null
    try {
      const { readFileSync } = await import('node:fs')
      const file = config.panelPackageJson
      if (typeof file === 'string' && file.length > 0) {
        const pkg = JSON.parse(readFileSync(file, 'utf8'))
        panelVersion = pkg.version ?? null
        panelEngines = pkg.engines ?? null
        panelPackageJson = file
      }
    } catch { /* 探针只做尽力而为的版本读取 */ }
    return {
      at: new Date().toISOString(),
      startedAt,
      node: process.version,
      dsh: {
        home: process.env.DSH_HOME ?? null,
        agentsHome: process.env.DSH_AGENTS_HOME ?? null,
        profile: process.env.DSH_PROFILE ?? null,
        profileDir: process.env.DSH_PROFILE_DIR ?? null,
      },
      envBools: {
        TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY),
        DEEPSEEK_API_KEY: Boolean(process.env.DEEPSEEK_API_KEY),
      },
      panelRawType: typeof raw,
      panelIsFactory: typeof raw === 'function',
      panelResolved: panel !== undefined,
      panelKeys: panel === undefined ? null : Object.keys(panel).sort(),
      panelJevKeys: panel?.jev === undefined ? null : Object.keys(panel.jev).sort(),
      panelVersion,
      panelEngines,
      panelPackageJson,
      fallback: dispatchMode(),
      services: ['sessionController', 'agents', 'workspaceRegistry', 'storageDomain', 'webServer', 'skills', 'tools']
        .reduce((acc, key) => { try { acc[key] = typeof ctx.get(key) } catch { acc[key] = 'throw' } return acc }, {}),
    }
  }

  const registerRoutes = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') {
      pushLog({ kind: 'routes/unavailable', reason: 'webServer.register missing' })
      return
    }
    const route = (path, handler) => {
      ws.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            pushLog({ kind: 'route/error', path, error: errText(error) })
            json(res, 500, { ok: false, path, error: errText(error) })
          }
        },
      })
    }

    route('/probe/v1/health', async (req, res) => json(res, 200, { ok: true, ...(await panelHealth()) }))

    route('/probe/v1/config', async (req, res) => {
      const panel = resolvePanel()
      if (panel === undefined) return json(res, 200, { ok: false, reason: 'panel_unavailable', fallback: dispatchMode() })
      let config
      try { config = await panel.jev.getConfig() } catch (error) { config = { error: errText(error) } }
      pushLog({ kind: 'jev/getConfig', config })
      return json(res, 200, { ok: true, config, fallback: dispatchMode() })
    })

    route('/probe/v1/units', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const cwd = get('cwd') ?? defaultCwd
      const panel = resolvePanel()
      if (panel === undefined || typeof panel.tools?.list !== 'function') {
        return json(res, 200, { ok: false, reason: 'panel_unavailable', fallback: dispatchMode() })
      }
      const view = await panel.tools.list({ sessionId })
      const units = (view?.units ?? []).map((unit) => ({
        unit: unit.unit,
        name: unit.name,
        kind: unit.kind,
        enabled: unit.enabled,
        enabledInSession: unit.enabledInSession,
        explicit: unit.explicit,
        hostInjected: unit.hostInjected,
        lockedReason: unit.lockedReason,
        toolCount: unit.toolCount,
        capabilityId: capabilityId(`tool:plugin:${unit.unit}`),
      }))
      const candidates = units.filter((unit) => unit.kind !== 'unattributed' && unit.hostInjected !== true && unit.lockedReason === undefined && (unit.enabled === true || unit.enabledInSession === true))
      const skillCandidates = []
      let skillsView = null
      try {
        if (typeof panel.skills?.sessionListView === 'function') {
          const view2 = await panel.skills.sessionListView(cwd, sessionId)
          const rows = view2?.skills ?? []
          skillsView = {
            count: rows.length,
            hiddenCount: view2?.hiddenCount ?? null,
            rows: rows.slice(0, 60).map((row) => ({
              name: row.name, enabledInSession: row.enabledInSession, hostInjected: row.hostInjected,
              capabilityId: capabilityId(`skill:${row.name}`),
            })),
          }
          for (const row of rows) {
            if (row.hostInjected === true) continue
            skillCandidates.push({
              kind: 'skill',
              unit: `skill:${row.name}`,
              name: row.name,
              enabledInSession: row.enabledInSession,
              capabilityId: capabilityId(`skill:${row.name}`),
            })
          }
        }
      } catch (error) { skillsView = { error: errText(error) } }
      const allCandidates = [...skillCandidates, ...candidates]
      pushLog({ kind: 'panel/tools.list', sessionId, units: units.length, toolCandidates: candidates.length, skillCandidates: skillCandidates.length })
      return json(res, 200, { ok: true, sessionId, cwd, unitCount: units.length, candidateCount: allCandidates.length, candidates: allCandidates, toolCandidates: candidates, skillCandidates, units, skillsView })
    })

    route('/probe/v1/rank', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const draft = get('draft') ?? '需要单测和浏览器自动化'
      const cwd = get('cwd') ?? defaultCwd
      const panel = resolvePanel()
      if (panel === undefined || typeof panel.jev?.rank !== 'function') {
        return json(res, 200, { ok: false, reason: 'panel_unavailable', fallback: dispatchMode() })
      }
      const t = Date.now()
      const result = await panel.jev.rank({ sessionId, draft, cwd })
      const elapsedMs = Date.now() - t
      const items = Array.isArray(result?.items) ? result.items : []
      const applicableItems = items.filter((item) => item.applicable === true)
      pushLog({ kind: 'jev/rank', sessionId, draft, cwd, elapsedMs, resultSummary: { ok: result?.ok, code: result?.code ?? null, items: items.length, applicable: applicableItems.length, capabilitiesTotal: result?.capabilitiesTotal ?? null, pendingOutcome: result?.pendingOutcome ?? null } })
      return json(res, 200, {
        ok: true, sessionId, draft, cwd, elapsedMs,
        result,
        applicableItems: applicableItems.map((item) => ({ id: item.id, kind: item.kind, name: item.name, score: item.score, enabledInSession: item.enabledInSession })),
      })
    })

    route('/probe/v1/apply', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const cwd = get('cwd') ?? defaultCwd
      const planIds = (get('planIds') ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0)
      const plan = planIds.map((id) => ({ id, enabled: true }))
      const panel = resolvePanel()
      if (panel === undefined || typeof panel.jev?.apply !== 'function') {
        return json(res, 200, { ok: false, reason: 'panel_unavailable', fallback: dispatchMode() })
      }
      const live = (() => { try { return (ctx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === sessionId) } catch { return null } })()
      const t = Date.now()
      const result = await panel.jev.apply({ sessionId, plan, cwd })
      const elapsedMs = Date.now() - t
      pushLog({ kind: 'jev/apply', sessionId, cwd, planIds, liveBefore: live, elapsedMs, result })
      return json(res, 200, { ok: true, sessionId, cwd, planIds, liveBefore: live, elapsedMs, result })
    })

    route('/probe/v1/create', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? undefined
      const cwd = get('cwd') ?? defaultCwd
      const controller = ctx.get('sessionController')
      if (controller === undefined) return json(res, 200, { ok: false, reason: 'sessionController_unavailable' })
      const t = Date.now()
      let result, error
      try { result = await controller.create({ ...(sessionId !== undefined ? { sessionId } : {}), cwd }) } catch (e) { error = errText(e) }
      const elapsedMs = Date.now() - t
      pushLog({ kind: 'sessionController/create', sessionId, cwd, elapsedMs, result, error })
      return json(res, 200, { ok: error === undefined, requestedSessionId: sessionId ?? null, cwd, elapsedMs, result: result ?? null, error: error ?? null })
    })

    route('/probe/v1/prompt', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const text = get('text') ?? '准备中，确认可用能力。'
      const controller = ctx.get('sessionController')
      if (controller === undefined) return json(res, 200, { ok: false, reason: 'sessionController_unavailable' })
      const sinceIndex = events.length
      const signal = new AbortController().signal
      const t = Date.now()
      let accepted = null, error = null
      try {
        accepted = await controller.prompt({ requestId: `probe-v1-${Date.now()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, signal)
      } catch (e) { error = errText(e) }
      const admissionMs = Date.now() - t
      // 等待该会话 turn/end（最多 20s），只做观察不改状态
      const deadline = Date.now() + 20000
      let turnEnd = null
      while (Date.now() < deadline) {
        const hit = events.slice(sinceIndex).find((entry) => entry.kind === 'session/event' && entry.sessionId === sessionId && entry.type === 'turn/end')
        if (hit !== undefined) { turnEnd = hit; break }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      const sessionEvents = events.slice(sinceIndex).filter((entry) => entry.kind === 'session/event' && entry.sessionId === sessionId)
      pushLog({ kind: 'sessionController/prompt', sessionId, text, admissionMs, accepted, error, turnEnd })
      return json(res, 200, { ok: error === null, sessionId, text, admissionMs, accepted, error, turnEnd, eventCount: sessionEvents.length, events: sessionEvents.slice(-40) })
    })

    route('/probe/v1/session', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      let agentsList = null
      try { agentsList = (ctx.get('agents')?.list?.() ?? []).map((agent) => agent?.id) } catch (error) { agentsList = { error: errText(error) } }
      const sessionEvents = events.filter((entry) => entry.kind === 'session/event' && entry.sessionId === sessionId)
      const agentEvents = events.filter((entry) => entry.agentId === sessionId)
      return json(res, 200, {
        ok: true,
        sessionId,
        live: Array.isArray(agentsList) ? agentsList.includes(sessionId) : null,
        agentsList,
        agentEvents,
        sessionEventCount: sessionEvents.length,
        sessionEvents: sessionEvents.slice(-80),
      })
    })

    route('/probe/v1/state', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const cwd = get('cwd') ?? defaultCwd
      const panel = resolvePanel()
      const body = { ok: true, sessionId, cwd, sessionCapabilities: null, toolsView: null, skillsView: null }
      // 面板落盘的会话开关（只回读该 sessionId 的记录，不打印其它会话）
      try {
        const { readFileSync } = await import('node:fs')
        const file = join(process.env.DSH_HOME ?? '', 'dsh-capability-settings', 'session-capabilities.json')
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        body.sessionCapabilitiesFile = file
        body.sessionCapabilities = parsed?.sessions?.[sessionId] ?? null
      } catch (error) { body.sessionCapabilitiesError = errText(error) }
      if (panel !== undefined && typeof panel.tools?.list === 'function') {
        try {
          const view = await panel.tools.list({ sessionId })
          body.toolsView = (view?.units ?? []).map((unit) => ({ unit: unit.unit, enabled: unit.enabled, enabledInSession: unit.enabledInSession, explicit: unit.explicit }))
        } catch (error) { body.toolsView = { error: errText(error) } }
      }
      if (panel !== undefined && typeof panel.skills?.sessionListView === 'function') {
        try {
          const view = await panel.skills.sessionListView(cwd, sessionId)
          body.skillsView = (view?.skills ?? []).map((row) => ({ name: row.name, enabledInSession: row.enabledInSession, hostInjected: row.hostInjected, capabilityId: capabilityId(`skill:${row.name}`) }))
        } catch (error) { body.skillsView = { error: errText(error) } }
      }
      pushLog({ kind: 'state', sessionId })
      return json(res, 200, body)
    })

    route('/probe/v1/events', async (req, res) => json(res, 200, { ok: true, count: events.length, events }))

    route('/probe/v1/quit', async (req, res) => {
      const summary = {
        at: new Date().toISOString(),
        startedAt,
        node: process.version,
        health: await panelHealth(),
        log,
        events,
      }
      try {
        mkdirSync(dirname(join(outDir, 'v1-probe-summary.json')), { recursive: true })
        writeFileSync(join(outDir, 'v1-probe-summary.json'), JSON.stringify(summary, null, 2) + '\n')
        pushLog({ kind: 'quit/evidence-written', file: join(outDir, 'v1-probe-summary.json') })
      } catch (error) {
        process.stderr.write(`[probe-v1] summary write failed: ${errText(error)}\n`)
      }
      json(res, 200, { ok: true, summaryFile: join(outDir, 'v1-probe-summary.json'), logs: log.length, events: events.length })
      setTimeout(() => {
        const exit = (() => { try { return ctx.get('appExit') } catch { return undefined } })()
        if (typeof exit === 'function') exit(0)
        else process.exit(0)
      }, 150)
    })

    pushLog({ kind: 'routes/registered', origin: (() => { try { return ws.getOrigin() } catch { return null } })() })
  }

  // webServer 就绪后注册路由；面板是否在都注册（V1-C5 需要在面板缺失时也能看到 health）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => { registerRoutes(hostCtx) })
  } else {
    setTimeout(() => registerRoutes(ctx), 1000)
  }
}
