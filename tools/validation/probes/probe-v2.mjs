/**
 * V2 · 会话停止、最后回复、pendingInteraction 与去重探针（P-A Host 探针插件）
 *
 * 目标（协议 §3）：
 *   1. turn/end 与"最后一条 assistant 回复"的对应关系（turn 区间、最后 assistant seq、文本拼接）；
 *   2. 工具回合：tool/call、tool/result、流式片段不会成为"最后回复"，且回合内求值不注入；
 *   3. 审批等待：turn 未结束、存在未配对 `approval/asked` 时判定 `pending_interaction` 不注入；
 *      放行后回合结束，判定 true、注入一次、同键二次注入为 `duplicate`；
 *   4. 去重键 `<sessionId>:<turnId>:<lastSeq>`；跨 turn 不误杀；
 *   5. 决策函数与实现蓝图 §7 对齐（纯函数，可被 /probe/v2/decide 直接求值，不真正 prompt）。
 *
 * 模型链路用 `stub-llm.mjs` 注册的 `probe-stub` provider（**验证用 stub，非真实模型**；
 * 不联网、不产生计费）。审批用 `ctx.approval` 的 waterfall answerer 模拟"等待/放行"，
 * 与真实 Desktop 审批 UI 的差异见文档 §6。
 *
 * 路由（webServer，loopback）：
 *   GET /probe/v2/health
 *   GET /probe/v2/scenario?mode=plain|tool      普通完成回合 / 工具回合
 *   GET /probe/v2/approval                      审批等待场景（返回时仍在等待）
 *   GET /probe/v2/release?action=allow|reject   放行/拒绝，等回合结束并做注入/去重
 *   GET /probe/v2/decide?sessionId&turn&endSeq  纯决策（不注入）
 *   GET /probe/v2/inject?sessionId&turn&endSeq  决策 + 标记注入（模拟投递成功）
 *   GET /probe/v2/session?sessionId             事件明细
 *   GET /probe/v2/quit                          写 summary 后退出
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installStubLlm, STUB_MODEL, STUB_PROVIDER } from './stub-llm.mjs'

export const name = 'probe-v2'
export const inject = ['llm']

const TRUNC_LIMIT = 8192
const HEAD = 6144
const TAIL = 2048
const ENTRY_KIND = 'text'

const errText = (error) => String(error?.message ?? error)
const safe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: errText(error) } } }

/** 按蓝图 §7.2-5 的 8KB 截断（头 6KB + 尾 2KB + 中间标记）。 */
function truncateReply(text) {
  const length = Buffer.byteLength(text, 'utf8')
  if (length <= TRUNC_LIMIT) return { text, truncated: false, originalLength: length, textLength: length }
  const head = text.slice(0, HEAD)
  const tail = text.slice(Math.max(0, text.length - TAIL))
  const omitted = length - Buffer.byteLength(head + tail, 'utf8')
  const out = `${head}\n…[truncated ${omitted} bytes]…\n${tail}`
  return { text: out, truncated: true, originalLength: length, textLength: Buffer.byteLength(out, 'utf8') }
}

const TEXT_BLOCKS = (content) => (Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : [])

export async function apply(ctx, config = {}) {
  const outDir = config.outDir ?? '/tmp/dsh-commander-probe/evidence/v2'
  const cwd = config.cwd ?? '/tmp/dsh-commander-probe/ws-v2'
  const summaryFile = join(outDir, 'v2-probe-summary.json')
  const startedAt = new Date().toISOString()
  const logs = []
  const pushLog = (entry) => { logs.push({ at: new Date().toISOString(), ...entry }); if (logs.length > 2000) logs.shift() }
  try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }

  const stub = await installStubLlm(ctx)

  // ---- 会话事件缓冲（只保留判据需要的字段，正文只留长度/首尾） ----
  const sessions = new Map() // sessionId -> { events: [], sessionRef }
  const eventsOf = (sessionId) => {
    let record = sessions.get(sessionId)
    if (record === undefined) { record = { events: [], sessionRef: undefined }; sessions.set(sessionId, record) }
    return record
  }
  const isWorkSession = (sessionId) => true // 探针内所有新会话都按"工作会话"处理；角色过滤由实现层负责

  // ---- 审批等待闸门（answerer 模拟等待/放行） ----
  const approvalWaits = []
  ctx.on('approval/request', async (req) => {
    const sessionId = req?.agent?.session?.id ?? null
    const entry = {
      sessionId,
      toolName: req?.toolName ?? null,
      callId: req?.callId ?? null,
      reason: req?.reason ?? null,
      at: Date.now(),
      released: false,
      outcome: null,
    }
    approvalWaits.push(entry)
    pushLog({ kind: 'approval/request', sessionId, toolName: entry.toolName, callId: entry.callId })
    await new Promise((resolve) => { entry._resolve = resolve })
    entry.released = true
    pushLog({ kind: 'approval/released', sessionId, outcome: entry.outcome })
    return entry.outcome ?? 'allowed-once'
  }, true) // prepend：排在客户端 answerer 之前，headless 下也由探针接管

  // ---- agent/status 订阅（若该事件存在则记录，用于说明"不用轮询"） ----
  const agentStatus = []
  try {
    ctx.on('agent/status', (payload) => {
      agentStatus.push({ at: Date.now(), status: payload?.status ?? null, sessionId: payload?.agent?.id ?? payload?.agentId ?? null })
    })
  } catch (error) { pushLog({ kind: 'agent/status/subscribe-failed', error: errText(error) }) }

  // ---- 会话事件订阅 ----
  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id ?? null
    if (sessionId === null) return
    const record = eventsOf(sessionId)
    record.sessionRef = session
    const data = event?.data !== null && typeof event?.data === 'object' ? event.data : undefined
    const message = data?.message
    const text = message === undefined ? '' : TEXT_BLOCKS(message.content).join('')
    const entry = {
      seq: event?.seq ?? null,
      type: event?.type ?? null,
      turn: data?.turn ?? null,
      reasonKind: data?.reason?.kind ?? null,
      role: message?.role ?? data?.role ?? null,
      textLength: message === undefined ? null : Buffer.byteLength(text, 'utf8'),
      textHead: message === undefined ? null : text.slice(0, 40),
      textTail: message === undefined ? null : text.slice(-40),
      text: event?.type === 'assistant/message' ? text : null, // 只对 assistant/message 留全文（其余事件不留正文）
      blockTypes: Array.isArray(message?.content) ? message.content.map((block) => block?.type) : null,
      approvalId: data?.id ?? null,
      toolName: data?.toolName ?? null,
      callId: data?.callId ?? null,
      outcome: data?.outcome ?? null,
      toolCallId: data?.toolCallId ?? data?.callId ?? null,
      errorCode: data?.error?.code ?? null,
    }
    record.events.push(entry)
    pushLog({ kind: 'session/event', sessionId, seq: entry.seq, type: entry.type, turn: entry.turn })
  })

  // ---- 决策纯函数（与实现蓝图 §7 同口径；不读 UI 状态、不轮询） ----
  const decision = (sessionId, turnId, endSeq, options = {}) => {
    const record = sessions.get(sessionId)
    if (record === undefined) return { shouldInject: false, reason: 'unknown_session' }
    const events = record.events
    const endEvent = events.find((entry) => entry.seq === endSeq && entry.type === 'turn/end')
    if (endEvent === undefined && options.allowOpenTurn !== true) {
      return { shouldInject: false, reason: 'no_turn_end', dedupeKey: null }
    }
    const effectiveTurn = endEvent?.turn ?? turnId
    // 1) pending 判定（§7.3）：最近一条 approval/asked 未按 approvalId 配对
    const asked = events.filter((entry) => entry.type === 'approval/asked')
    const decided = new Map(events.filter((entry) => entry.type === 'approval/decided').map((entry) => [entry.approvalId, entry]))
    const unpaired = asked.filter((entry) => !decided.has(entry.approvalId))
    // 2) userQuestions 投影（headless 下可能不可用，如实记录）
    let userQuestionsActive = null
    if (options.checkUserQuestions !== false && record.sessionRef !== undefined) {
      const snapshot = safe(() => ctx.get('sessionProjections')?.snapshot?.(record.sessionRef))
      if (snapshot.ok && snapshot.value !== undefined) {
        const view = snapshot.value?.values?.userQuestions ?? snapshot.value?.userQuestions
        userQuestionsActive = Array.isArray(view?.active) ? view.active.length : null
      }
    }
    const pending = { approvals: unpaired.map((entry) => ({ approvalId: entry.approvalId, seq: entry.seq, toolName: entry.toolName })), userQuestionsActive }

    // 3) 取最后回复（§7.2）：同 turn 的最近 turn/start 到 endSeq 之间最后一个 assistant/message
    const boundary = endEvent?.seq ?? endSeq
    const startEvent = [...events].reverse().find((entry) => entry.type === 'turn/start' && (entry.seq ?? -1) < boundary && (effectiveTurn === null || entry.turn === effectiveTurn))
    const interval = events.filter((entry) => (startEvent === undefined || (entry.seq ?? -1) > startEvent.seq) && (entry.seq ?? -1) < boundary)
    const assistants = interval.filter((entry) => entry.type === 'assistant/message')
    const last = assistants.at(-1) ?? null
    const lastText = last?.text ?? ''
    const truncatedReply = truncateReply(lastText)
    const lastSeq = last?.seq ?? null
    const dedupeKey = `${sessionId}:${effectiveTurn}:${lastSeq}`
    const already = lastInjected.get(sessionId)
    const duplicate = already !== undefined && already.turnId === effectiveTurn && already.seq === lastSeq

    if (pending.approvals.length > 0 || (userQuestionsActive ?? 0) > 0) {
      return { shouldInject: false, reason: 'pending_interaction', dedupeKey, turnId: effectiveTurn, lastSeq, pending, interval: [startEvent?.seq ?? null, boundary], textLength: truncatedReply.textLength, truncated: truncatedReply.truncated }
    }
    if (endEvent === undefined) return { shouldInject: false, reason: 'turn_open', dedupeKey, turnId: effectiveTurn, lastSeq, pending }
    if (effectiveTurn !== turnId) return { shouldInject: false, reason: 'turn_mismatch', dedupeKey, turnId: effectiveTurn, lastSeq, pending }
    if (last === null) return { shouldInject: false, reason: 'no_assistant_message', dedupeKey, turnId: effectiveTurn, lastSeq: null, pending }
    if (duplicate) return { shouldInject: false, reason: 'duplicate', dedupeKey, turnId: effectiveTurn, lastSeq, pending, textLength: truncatedReply.textLength }
    const reasonKind = endEvent.reasonKind
    if (reasonKind !== null && !['completed', 'error', 'blocked', 'max-tokens'].includes(reasonKind)) {
      return { shouldInject: false, reason: `reason:${reasonKind}`, dedupeKey, turnId: effectiveTurn, lastSeq, pending }
    }
    return {
      shouldInject: true, reason: 'idle', dedupeKey, turnId: effectiveTurn, lastSeq,
      turnStartSeq: startEvent?.seq ?? null, text: truncatedReply.text, textLength: truncatedReply.textLength,
      truncated: truncatedReply.truncated, originalLength: truncatedReply.originalLength,
      lastAssistantBlockTypes: last.blockTypes, pending,
    }
  }

  // 去重状态（模拟 SessionLinkRecord.lastInjected；探针内为内存，V4 已验证落盘能力）
  const lastInjected = new Map()
  const injectLog = []
  const doInject = (sessionId, turnId, endSeq) => {
    const decisionResult = decision(sessionId, turnId, endSeq)
    if (decisionResult.shouldInject === true) {
      lastInjected.set(sessionId, { turnId: decisionResult.turnId, seq: decisionResult.lastSeq, at: Date.now() })
      injectLog.push({ at: Date.now(), sessionId, dedupeKey: decisionResult.dedupeKey, textLength: decisionResult.textLength })
      return { ...decisionResult, injected: true }
    }
    return { ...decisionResult, injected: false }
  }

  // ---- HTTP 路由 ----
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }
  const query = (req) => { const url = new URL(req.url ?? '/', 'http://localhost'); return { get: (name) => url.searchParams.get(name) ?? undefined } }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = predicate()
      if (value !== undefined && value !== false) return value
      await sleep(stepMs)
    }
    return undefined
  }
  const newSession = async (controller) => {
    const created = await controller.create({ cwd })
    const sessionId = created.sessionId
    const selected = await controller.selectModel({ sessionId, provider: STUB_PROVIDER, model: STUB_MODEL })
    return { sessionId, agentPreset: created.agentPreset ?? null, selected: selected.selected }
  }
  const promptText = async (controller, sessionId, text) => controller.prompt({
    requestId: `probe-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sessionId, mode: 'queue', content: [{ type: 'text', text }],
  }, new AbortController().signal)
  const waitTurnEnd = async (sessionId, timeoutMs = 60000) => waitFor(() => sessions.get(sessionId)?.events.find((entry) => entry.type === 'turn/end'), timeoutMs)

  const registerRoutes = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return pushLog({ kind: 'routes/unavailable' })

    const route = (path, handler) => ws.register({
      kind: 'exact', path,
      handler: async (req, res) => {
        try { await handler(req, res) } catch (error) {
          pushLog({ kind: 'route/error', path, error: errText(error) })
          json(res, 500, { ok: false, path, error: errText(error) })
        }
      },
    })

    route('/probe/v2/health', async (req, res) => json(res, 200, {
      ok: true, node: process.version, startedAt,
      dshHome: process.env.DSH_HOME ?? null,
      stubProvider: { provider: STUB_PROVIDER, model: STUB_MODEL, registered: hostCtx.get('llm')?.listProviders?.().some((p) => p.id === STUB_PROVIDER) ?? false },
      services: { approval: typeof safe(() => hostCtx.get('approval')).value, llm: typeof safe(() => hostCtx.get('llm')).value, sessionController: typeof safe(() => hostCtx.get('sessionController')).value, sessionProjections: typeof safe(() => hostCtx.get('sessionProjections')).value, agents: typeof safe(() => hostCtx.get('agents')).value },
      stubCalls: stub.calls.length,
    }))

    // 场景 1/2：普通完成回合 / 工具回合
    route('/probe/v2/scenario', async (req, res) => {
      const { get } = query(req)
      const mode = get('mode') === 'tool' ? 'tool' : 'plain'
      const controller = hostCtx.get('sessionController')
      const created = await newSession(controller)
      const { sessionId } = created
      const marker = mode === 'tool' ? 'PROBE_V2_TOOL 请运行 echo 并汇报' : 'PROBE_V2_PLAIN 只回一句'
      // 记录 tool/call、tool/result、assistant/message 发生时刻的"回合未结束"事实
      const midTurn = []
      const timer = setInterval(() => {
        const events = sessions.get(sessionId)?.events ?? []
        for (const event of events) {
          if (!['tool/call', 'tool/result', 'assistant/message', 'tool/result-start'].includes(event.type ?? '')) continue
          if (midTurn.some((entry) => entry.seq === event.seq)) continue
          const turnEnded = events.some((entry) => entry.type === 'turn/end')
          midTurn.push({ seq: event.seq, type: event.type, turnEndedBeforeEvaluation: turnEnded, injectableByEventType: false })
        }
      }, 50)
      const accepted = await promptText(controller, sessionId, marker)
      const turnEnd = await waitTurnEnd(sessionId, 60000)
      clearInterval(timer)
      const events = sessions.get(sessionId)?.events ?? []
      const turnStart = events.find((entry) => entry.type === 'turn/start' && entry.turn === turnEnd?.turn)
      const assistants = events.filter((entry) => entry.type === 'assistant/message' && (turnStart === undefined || (entry.seq ?? -1) > turnStart.seq) && (entry.seq ?? -1) < (turnEnd?.seq ?? 0))
      const decisionAtEnd = decision(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      const inject1 = doInject(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      const inject2 = doInject(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      const lastAssistantFull = assistants.at(-1)?.text ?? ''
      json(res, 200, {
        ok: turnEnd !== undefined, mode, created, accepted,
        turnStartSeq: turnStart?.seq ?? null, turnEndSeq: turnEnd?.seq ?? null,
        lastAssistantFullText: lastAssistantFull,
        decisionTextEqualsLastAssistant: decisionAtEnd.text === lastAssistantFull,
        turnStarts: events.filter((entry) => entry.type === 'turn/start').map((entry) => ({ seq: entry.seq, turn: entry.turn })),
        turnEnds: events.filter((entry) => entry.type === 'turn/end').map((entry) => ({ seq: entry.seq, turn: entry.turn, reasonKind: entry.reasonKind })),
        turnEnd: turnEnd === undefined ? null : { seq: turnEnd.seq, turn: turnEnd.turn, reasonKind: turnEnd.reasonKind },
        eventTypes: [...new Set(events.map((entry) => entry.type))],
        assistantMessages: assistants.map((entry) => ({ seq: entry.seq, blockTypes: entry.blockTypes, textLength: entry.textLength, textHead: entry.textHead })),
        toolEvents: events.filter((entry) => (entry.type ?? '').startsWith('tool/')).map((entry) => ({ seq: entry.seq, type: entry.type, turn: entry.turn })),
        midTurnEvaluations: midTurn,
        decisionAtEnd, inject1, inject2,
        lastInjected: lastInjected.get(sessionId) ?? null,
        eventCount: events.length, sessionId,
      })
    })

    // 场景 3：审批等待
    route('/probe/v2/approval', async (req, res) => {
      const controller = hostCtx.get('sessionController')
      const created = await newSession(controller)
      const { sessionId } = created
      const accepted = await promptText(controller, sessionId, 'PROBE_V2_TOOL_APPROVAL 请运行命令并汇报')
      const wait = await waitFor(() => approvalWaits.find((entry) => entry.sessionId === sessionId), 30000, 100)
      const events = sessions.get(sessionId)?.events ?? []
      const asked = events.find((entry) => entry.type === 'approval/asked')
      const decided = events.find((entry) => entry.type === 'approval/decided')
      const turnEnded = events.some((entry) => entry.type === 'turn/end')
      // 用"当前最后事件 seq"作为边界求值（回合尚未结束，允许以 openTurn 模式探测）
      const lastSeq = events.at(-1)?.seq ?? null
      const decisionDuringWait = decision(sessionId, null, lastSeq, { allowOpenTurn: true })
      json(res, 200, {
        ok: wait !== undefined, sessionId, created, accepted,
        approvalWait: wait === undefined ? null : { toolName: wait.toolName, callId: wait.callId, at: wait.at, released: wait.released },
        approvalAsked: asked ?? null,
        approvalDecided: decided ?? null,
        turnEndedWhileWaiting: turnEnded,
        currentTurnStartSeq: events.find((entry) => entry.type === 'turn/start')?.seq ?? null,
        pendingInteractionSnapshot: {
          unpairedApprovals: decisionDuringWait.pending?.approvals ?? [],
          userQuestionsActive: decisionDuringWait.pending?.userQuestionsActive ?? null,
          source: 'host: session 事件缓冲里未配对 approval/asked（等价于 Client useSessionStatus().pendingInteraction 非空）',
        },
        decisionDuringWait,
        eventCount: events.length,
      })
    })

    // 放行/拒绝：等回合结束，再做注入 + 去重
    route('/probe/v2/release', async (req, res) => {
      const { get } = query(req)
      const action = get('action') === 'reject' ? 'reject' : 'allow'
      const target = approvalWaits.findLast?.((entry) => !entry.released) ?? [...approvalWaits].reverse().find((entry) => !entry.released)
      if (target === undefined) return json(res, 200, { ok: false, reason: 'no_pending_approval' })
      target.outcome = action === 'allow' ? 'allowed-once' : 'rejected'
      target._resolve?.()
      const sessionId = target.sessionId
      const turnEnd = await waitTurnEnd(sessionId, 60000)
      const events = sessions.get(sessionId)?.events ?? []
      const asked = events.filter((entry) => entry.type === 'approval/asked')
      const decided = events.filter((entry) => entry.type === 'approval/decided')
      const pairs = asked.map((entry) => ({
        approvalId: entry.approvalId, askedSeq: entry.seq,
        decidedSeq: decided.find((d) => d.approvalId === entry.approvalId)?.seq ?? null,
        outcome: decided.find((d) => d.approvalId === entry.approvalId)?.outcome ?? null,
      }))
      const decisionAfterEnd = decision(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      const inject1 = doInject(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      const inject2 = doInject(sessionId, turnEnd?.turn ?? null, turnEnd?.seq ?? null)
      json(res, 200, {
        ok: turnEnd !== undefined, action, sessionId,
        approvalPairs: pairs,
        turnEnd: turnEnd === undefined ? null : { seq: turnEnd.seq, turn: turnEnd.turn, reasonKind: turnEnd.reasonKind },
        decisionAfterEnd, inject1, inject2,
        toolEvents: events.filter((entry) => (entry.type ?? '').startsWith('tool/')).map((entry) => ({ seq: entry.seq, type: entry.type })),
        eventCount: events.length,
        lastInjected: lastInjected.get(sessionId) ?? null,
      })
    })

    // 跨 turn 去重：同会话再跑一个回合，验证不同 turn/seq 的新键仍应注入
    route('/probe/v2/next-turn', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const controller = hostCtx.get('sessionController')
      const previous = lastInjected.get(sessionId) ?? null
      const beforeEnds = (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'turn/end').length
      const accepted = await promptText(controller, sessionId, 'PROBE_V2_PLAIN 第二回合')
      // 等"新的" turn/end（数量增加），不能复用第一回合的结束事件
      await waitFor(() => (sessions.get(sessionId)?.events ?? []).filter((entry) => entry.type === 'turn/end').length > beforeEnds, 60000, 100)
      const events = sessions.get(sessionId)?.events ?? []
      const turnEnds = events.filter((entry) => entry.type === 'turn/end')
      const end = turnEnds.at(-1) ?? null
      const decisionAfter = decision(sessionId, end?.turn ?? null, end?.seq ?? null)
      const inject = doInject(sessionId, end?.turn ?? null, end?.seq ?? null)
      json(res, 200, {
        ok: end !== null && turnEnds.length > beforeEnds, sessionId, accepted, turnEndsBefore: beforeEnds,
        turnEnds: turnEnds.map((entry) => ({ seq: entry.seq, turn: entry.turn, reasonKind: entry.reasonKind })),
        previousLastInjected: previous,
        decisionAfter, inject,
        lastInjected: lastInjected.get(sessionId) ?? null,
        eventCount: events.length,
      })
    })

    route('/probe/v2/decide', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const turnId = Number(get('turn') ?? 'NaN')
      const endSeq = Number(get('endSeq') ?? 'NaN')
      json(res, 200, { ok: true, ...decision(sessionId, Number.isFinite(turnId) ? turnId : null, Number.isFinite(endSeq) ? endSeq : null) })
    })

    route('/probe/v2/inject', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const turnId = Number(get('turn') ?? 'NaN')
      const endSeq = Number(get('endSeq') ?? 'NaN')
      json(res, 200, { ok: true, ...doInject(sessionId, Number.isFinite(turnId) ? turnId : null, Number.isFinite(endSeq) ? endSeq : null) })
    })

    route('/probe/v2/session', async (req, res) => {
      const { get } = query(req)
      const sessionId = get('sessionId') ?? ''
      const record = sessions.get(sessionId)
      json(res, 200, {
        ok: true, sessionId,
        live: (hostCtx.get('agents')?.list?.() ?? []).some((agent) => agent?.id === sessionId),
        eventCount: record?.events.length ?? 0,
        events: record?.events ?? [],
        injectLog: injectLog.filter((entry) => entry.sessionId === sessionId),
        lastInjected: lastInjected.get(sessionId) ?? null,
      })
    })

    route('/probe/v2/quit', async (req, res) => {
      try {
        writeFileSync(summaryFile, JSON.stringify({
          phase: 'quit', at: new Date().toISOString(), startedAt, node: process.version,
          stubProvider: STUB_PROVIDER, stubModel: STUB_MODEL, stubCalls: stub.calls,
          sessions: [...sessions.entries()].map(([sessionId, record]) => ({ sessionId, eventCount: record.events.length })),
          injectLog, logs,
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
