#!/usr/bin/env node
/**
 * Jev 派发评估 harness（零依赖，Node 18+）。V5 门禁工具，见 docs/eval/jev-dispatch-eval.md
 * 与 docs/architecture/validation-protocol.md §6。
 *
 * 用法：
 *   node tools/jev-eval.mjs docs/eval/cases.sample.jsonl --mock
 *   JEV_API_KEY=... node tools/jev-eval.mjs docs/eval/cases.real.jsonl --out report.md
 *   JEV_API_KEY=... node tools/jev-eval.mjs docs/eval/cases.real.jsonl --mode layered --out report-layered.md
 *   ... --summary-out /tmp/summary.json --gate
 *
 * 关键口径：
 * - 两问：workspace（workspace 候选）与 session（new + 该工作区会话）；
 * - --mode full（默认，A 模式）：一次请求同时问 workspace+session；
 * - --mode layered（B 模式）：先问 workspace，再只带该工作区会话问 session；
 * - 两种模式的指标/阈值扫描口径完全一致；报告额外记录请求数、tokens、p50/p95 时延；
 * - should-ask 层（tags 含 "should-ask"）表示期望 needs_confirmation：不进 Top-1 分母，
 *   被自动派发放行即计 precision 错误；
 * - mock ≠ live：mock 是 harness 自检（含确定性噪声注入以验证阈值扫描/校准口径），不代表模型能力。
 *
 * 环境：JEV_API_KEY（或 TYPESAFE_API_KEY）必填（--mock 除外）；JEV_ENDPOINT / JEV_MODEL 可选。
 * key 只用于 Authorization 头，绝不打印/落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const file = argv.find((argument) => !argument.startsWith('--'))
const flagOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback
}
const outFile = flagOf('--out', null)
const summaryOut = flagOf('--summary-out', null)
const manifestFile = flagOf('--manifest', null)
const replayFile = flagOf('--replay-summary', null) // 复用已存 summary.caseResults 重算报告（不重跑 live）
const mock = argv.includes('--mock')
const gateMode = argv.includes('--gate')
const mode = flagOf('--mode', 'full')
const criteriaStyle = flagOf('--criteria', 'compact')
const whitelistMode = flagOf('--whitelist', 'all') // all | reality（前 8 活跃工作区 + 期望工作区不在则记 needs_confirmation）
const skipErrors = argv.includes('--skip-errors') // compact=v2（详情只在 state，criteria 只放短标签）；verbose=v1 复现
const SHORT = (text) => (String(text).length > 16 ? `${String(text).slice(0, 16)}…` : String(text))
const endpoint = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || ''
const model = process.env.JEV_MODEL || 'jev-latest'
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 30000)

if (!file) {
  console.error('usage: node tools/jev-eval.mjs <cases.jsonl> [--out report.md] [--mode full|layered] [--mock] [--summary-out file.json] [--gate]')
  process.exit(1)
}
if (mode !== 'full' && mode !== 'layered') {
  console.error(`unknown --mode ${mode} (expected full|layered)`)
  process.exit(1)
}
if (!mock && !apiKey && replayFile === null) {
  console.error('JEV_API_KEY (or TYPESAFE_API_KEY) is required unless --mock/--replay-summary is used')
  process.exit(1)
}

const casesRaw = fs.readFileSync(file, 'utf8')
const caseFileSha256 = crypto.createHash('sha256').update(casesRaw).digest('hex')
const caseManifest = (() => {
  if (manifestFile === null) return null
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    return null
  }
})()
const cases = casesRaw
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid JSON on line ${index + 1}: ${error.message}`)
    }
  })

// ---------------------------------------------------------------- 白名单（M1 配置敏感性）
/** reality 白名单：dispatch 时点前按会话最后活动排名的前 8 个工作区（定义写死、可复现；不额外加期望工作区）。 */
function realityWhitelist(c) {
  const active = new Map()
  for (const session of c.sessions ?? []) {
    const at = Date.parse(session.lastActiveAt ?? '')
    if (!Number.isFinite(at)) continue
    active.set(session.workspaceId, Math.max(active.get(session.workspaceId) ?? 0, at))
  }
  return new Set([...active.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([workspaceId]) => workspaceId))
}
function effectiveCase(c) {
  if (whitelistMode !== 'reality') return { effective: c, derivedNeedsConfirmation: false }
  const whitelist = realityWhitelist(c)
  const expectedWorkspaceId = c.expected?.workspaceId
  const derivedNeedsConfirmation = expectedWorkspaceId !== undefined && !whitelist.has(expectedWorkspaceId)
  return {
    effective: {
      ...c,
      workspaces: c.workspaces.filter((workspace) => whitelist.has(workspace.id)),
      sessions: c.sessions.filter((session) => whitelist.has(session.workspaceId)),
    },
    derivedNeedsConfirmation,
  }
}

// ---------------------------------------------------------------- 请求构造
const uniqueWorkspaces = (c) => [...new Map(c.workspaces.map((workspace) => [workspace.id, workspace])).values()]
const topProb = (answer) => (answer ? answer.probabilities?.[answer.choice] ?? 0 : 0)
const estimateTokens = (text) => {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

function workspaceQuestion(workspaces, wIndex) {
  const criteria = {}
  for (const workspace of workspaces) {
    criteria[wIndex.get(workspace.id)] =
      criteriaStyle === 'compact'
        ? { what: SHORT(workspace.name) }
        : {
            what: `${workspace.name}（${workspace.path || workspace.id}）`,
            why: workspace.summary || '未配置摘要',
            not_for: workspace.capabilityDigest ? `能力：${workspace.capabilityDigest}` : undefined,
          }
  }
  return {
    type: 'choice',
    instructions: '哪个工作区最适合这个任务？综合考虑职责、历史任务与能力匹配。',
    criteria,
  }
}

function sessionQuestion(sessions, sIndex) {
  const criteria = {
    new: criteriaStyle === 'compact' ? { what: '新建会话' } : { what: '新建会话', why: '上下文干净；适合独立任务' },
  }
  for (const session of sessions) {
    criteria[sIndex.get(session.id)] =
      criteriaStyle === 'compact'
        ? { what: SHORT(session.title) }
        : {
            what: `${session.title} · ${session.workspaceId}`,
            why: `最近活动 ${session.lastActiveAt || '未知'}`,
            not_for: session.contextUsage != null ? `上下文 ${Math.round(session.contextUsage * 100)}%` : undefined,
          }
  }
  return {
    type: 'choice',
    instructions: '哪个会话最适合？如果没有合适的已有会话，选 new。',
    criteria,
  }
}

function stateOf(c) {
  const workspaces = uniqueWorkspaces(c)
  const sessions = c.sessions.filter((session) => !session.archived)
  return { workspaces, sessions }
}

/** 全量一波（A 模式）：一次请求两个问题。 */
function buildFullRequest(c) {
  const { workspaces, sessions } = stateOf(c)
  const wIndex = new Map(workspaces.map((workspace, index) => [workspace.id, `w_${index}`]))
  const sIndex = new Map(sessions.map((session, index) => [session.id, `s_${index}`]))
  const questions = {
    workspace: workspaceQuestion(workspaces, wIndex),
    session: sessionQuestion(sessions, sIndex),
  }
  return {
    body: {
      model,
      state: {
        task: c.task,
        command: c.command || { text: '' },
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          summary: workspace.summary || '',
          recentTasks: workspace.recentTasks || [],
        })),
        sessions: sessions.map((session) => ({
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          lastActiveAt: session.lastActiveAt,
          contextUsage: session.contextUsage,
        })),
        constraints: { allowedWorkspaces: workspaces.map((workspace) => workspace.id) },
      },
      questions,
    },
    workspaces,
    sessions,
    wIndex,
    sIndex,
  }
}

/** 两层（B 模式）第一步：只问工作区。 */
function buildWorkspaceRequest(c) {
  const { workspaces } = stateOf(c)
  const wIndex = new Map(workspaces.map((workspace, index) => [workspace.id, `w_${index}`]))
  return {
    body: {
      model,
      state: {
        task: c.task,
        command: c.command || { text: '' },
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          summary: workspace.summary || '',
          recentTasks: workspace.recentTasks || [],
        })),
        constraints: { allowedWorkspaces: workspaces.map((workspace) => workspace.id) },
      },
      questions: { workspace: workspaceQuestion(workspaces, wIndex) },
    },
    workspaces,
    wIndex,
  }
}

/** 两层（B 模式）第二步：只问所选工作区的会话 + new。 */
function buildSessionRequest(c, chosenWorkspaceId) {
  const { workspaces, sessions } = stateOf(c)
  const workspace = workspaces.find((candidate) => candidate.id === chosenWorkspaceId) ?? null
  const scoped = workspace === null ? [] : sessions.filter((session) => session.workspaceId === workspace.id)
  const sIndex = new Map(scoped.map((session, index) => [session.id, `s_${index}`]))
  return {
    body: {
      model,
      state: {
        task: c.task,
        command: c.command || { text: '' },
        workspaces: workspace === null ? [] : [{ id: workspace.id, name: workspace.name, summary: workspace.summary || '', recentTasks: workspace.recentTasks || [] }],
        sessions: scoped.map((session) => ({
          id: session.id,
          workspaceId: session.workspaceId,
          title: session.title,
          lastActiveAt: session.lastActiveAt,
          contextUsage: session.contextUsage,
        })),
        constraints: { allowedWorkspaces: workspace === null ? [] : [workspace.id] },
      },
      questions: { session: sessionQuestion(scoped, sIndex) },
    },
    scoped,
    sIndex,
  }
}

// ---------------------------------------------------------------- Jev 调用
async function callJev(body) {
  const startedAt = performance.now()
  const serialized = JSON.stringify(body)
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: serialized,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const elapsedMs = performance.now() - startedAt
      if (response.status === 429 || response.status === 529) {
        lastError = new Error(`Jev ${response.status}: ${(await response.text()).slice(0, 300)}`)
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          continue
        }
        throw lastError
      }
      if (!response.ok) {
        // 4xx/5xx（非 429/529）不重试
        throw new Error(`Jev ${response.status}: ${(await response.text()).slice(0, 500)}`)
      }
      const json = await response.json()
      return { json, elapsedMs, requestTokens: tokensOf(json, serialized), rawBytes: serialized.length }
    } catch (error) {
      lastError = error
      if (attempt === 0 && /timeout|aborted|ECONN|fetch failed/i.test(String(error?.message ?? error))) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      throw lastError
    }
  }
  throw lastError
}

/** token 统计：优先用响应里的 usage，否则按请求体字符估算（estimated=true）。 */
function tokensOf(json, serializedBody) {
  const usage = json?.usage ?? json?.result?.usage ?? json?.data?.usage
  const input = usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens
  const output = usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return { input: Number(input ?? 0), output: Number(output ?? 0), estimated: false }
  }
  return { input: estimateTokens(serializedBody), output: 0, estimated: true }
}

function extractAnswers(json) {
  const candidates = [json?.answers, json?.result?.answers, json?.data?.answers, json?.output?.answers, json?.result, json?.data]
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && ('workspace' in candidate || 'session' in candidate)) return candidate
  }
  if (json !== null && typeof json === 'object' && ('workspace' in json || 'session' in json)) return json
  const keys = json !== null && typeof json === 'object' ? Object.keys(json).join(',') : String(json)
  throw new Error(`unexpected Jev response shape (keys: ${keys})`)
}

function normalizeAnswer(answer) {
  if (answer === null || typeof answer !== 'object') return { choice: null, probabilities: {}, confidence: 0 }
  const choice = typeof answer.choice === 'string' ? answer.choice : null
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : choice ? { [choice]: Number(answer.probability ?? answer.score ?? 0) } : {}
  const confidence = Number(answer.confidence ?? answer.certainty ?? 0)
  return { choice, probabilities, confidence: Number.isFinite(confidence) ? confidence : 0 }
}

// ---------------------------------------------------------------- mock（harness 自检；非模型能力）
function mockAnswerForWorkspace(c, wIndex, index) {
  const expectedKey = wIndex.get(c.expected?.workspaceId)
  // 确定性噪声：仅 1 条低置信错误（p/conf 低，门控应过滤），用于证明阈值扫描不是恒真。
  const wrong = index === 23
  const choice = wrong ? [...wIndex.values()].find((key) => key !== expectedKey) : expectedKey
  const probs = choice ? { [choice]: wrong ? 0.45 : 0.9 } : {}
  return { type: 'choice', choice, probabilities: probs, confidence: wrong ? 0.2 : 0.72 }
}

function mockAnswerForSession(c, built, chosenWorkspaceId, index) {
  const isShouldAsk = (c.tags || []).includes('should-ask')
  const expected = c.expected || {}
  const expectedSessionKey = built.sIndex.get(expected.sessionId)
  const validAttach = expected.mode === 'attach' && expectedSessionKey !== undefined && expected.workspaceId === chosenWorkspaceId
  const anyKey = [...built.sIndex.values()][0]
  const wrong = index === 31
  let choice
  if (isShouldAsk) choice = expectedSessionKey ?? 'new'
  else if (expected.mode === 'new') choice = wrong ? anyKey ?? 'new' : 'new'
  else choice = validAttach ? (wrong ? nextKey(built.sIndex, expectedSessionKey) : expectedSessionKey) : 'new'
  const probabilities = choice ? { [choice]: isShouldAsk ? 0.42 : wrong ? 0.45 : 0.88 } : {}
  return { type: 'choice', choice, probabilities, confidence: isShouldAsk ? 0.2 : wrong ? 0.2 : 0.66 }
}
function nextKey(indexMap, key) {
  const keys = [...indexMap.values()]
  return keys[(keys.indexOf(key) + 1) % keys.length]
}

function mockCase(caseItem, index) {
  if (mode === 'full') {
    const built = buildFullRequest(caseItem)
    return {
      answers: { workspace: mockAnswerForWorkspace(caseItem, built.wIndex, index), session: mockAnswerForSession(caseItem, built, caseItem.expected?.workspaceId, index) },
      requests: [{ elapsedMs: 1, requestTokens: { input: estimateTokens(JSON.stringify(built.body)), output: 0, estimated: true } }],
    }
  }
  const workspaceBuilt = buildWorkspaceRequest(caseItem)
  const workspaceAnswer = mockAnswerForWorkspace(caseItem, workspaceBuilt.wIndex, index)
  const chosenWorkspaceId = [...workspaceBuilt.wIndex.entries()].find(([, key]) => key === workspaceAnswer.choice)?.[0] ?? caseItem.expected?.workspaceId
  const sessionBuilt = buildSessionRequest(caseItem, chosenWorkspaceId)
  return {
    answers: { workspace: workspaceAnswer, session: mockAnswerForSession(caseItem, sessionBuilt, chosenWorkspaceId, index) },
    requests: [
      { elapsedMs: 1, requestTokens: { input: estimateTokens(JSON.stringify(workspaceBuilt.body)), output: 0, estimated: true } },
      { elapsedMs: 1, requestTokens: { input: estimateTokens(JSON.stringify(sessionBuilt.body)), output: 0, estimated: true } },
    ],
  }
}

// ---------------------------------------------------------------- 评估
function evaluate(caseItem, answers, built) {
  const expected = caseItem.expected || {}
  const tags = caseItem.tags || []
  const shouldAsk = tags.includes('should-ask') || tags.includes('needs_confirmation') || caseItem.expected?.needsConfirmation === true
  const namedCue = tags.includes('named-cue')
  const observational = tags.includes('observational')
  const workspaceAnswer = normalizeAnswer(answers.workspace)
  const sessionAnswer = normalizeAnswer(answers.session)
  const workspaceId = [...built.wIndex.entries()].find(([, key]) => key === workspaceAnswer.choice)?.[0] ?? null
  const sessionId = [...built.sIndex.entries()].find(([, key]) => key === sessionAnswer.choice)?.[0] ?? null
  const sessionMode = sessionAnswer.choice === 'new' ? 'new' : 'attach'
  const chosenSession = built.sessions.find((session) => session.id === sessionId) ?? null
  const conflict = sessionMode === 'attach' && chosenSession !== null && workspaceId !== null && chosenSession.workspaceId !== workspaceId
  const workspaceCorrect = workspaceId === expected.workspaceId
  const modeCorrect = sessionMode === expected.mode
  const sessionCorrect = expected.mode === 'new' ? sessionMode === 'new' : sessionId === expected.sessionId
  const targetCorrect = workspaceCorrect && modeCorrect && sessionCorrect && !conflict
  const pWorkspace = topProb(workspaceAnswer)
  const pSession = topProb(sessionAnswer)
  return {
    id: caseItem.id,
    tags: caseItem.tags || [],
    layer: (caseItem.tags || [])[0] ?? 'unknown',
    shouldAsk,
    namedCue,
    observational,
    derivedNeedsConfirmation: false,
    expectedWorkspaceId: expected.workspaceId,
    expectedSessionId: expected.sessionId ?? null,
    expectedMode: expected.mode,
    chosenWorkspaceId: workspaceId,
    chosenSessionId: sessionId,
    chosenMode: sessionMode,
    workspaceCorrect,
    modeCorrect,
    sessionCorrect,
    targetCorrect,
    conflict,
    pWorkspace,
    cWorkspace: workspaceAnswer.confidence,
    pSession,
    cSession: sessionAnswer.confidence,
    pMax: Math.max(pWorkspace, pSession),
  }
}

const P_GRID = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
const C_GRID = [0.3, 0.4, 0.5, 0.6, 0.7]

/** 门控放行：pWorkspace≥pw 且 pSession≥ps 且两个 confidence≥floor。 */
function gatePass(result, pWorkspace, pSession, confidenceFloor) {
  return result.pWorkspace >= pWorkspace && result.pSession >= pSession && result.cWorkspace >= confidenceFloor && result.cSession >= confidenceFloor
}

function sweep(results, { qualifyingOnly = true } = {}) {
  const gateSet = results.filter((result) => !result.shouldAsk && !result.observational && !result.namedCue && !result.derivedNeedsConfirmation)
  // protocol §6.6：coverage 分母 = labeled（含 named-cue 与 observational 的“已标注案例”，即 non-should-ask/non-derived）=45
  const labeledSet = results.filter((result) => !result.shouldAsk && !result.derivedNeedsConfirmation)
  const rows = []
  for (const pWorkspace of P_GRID) {
    for (const pSession of P_GRID) {
      for (const confidenceFloor of C_GRID) {
        const passed = results.filter((result) => gatePass(result, pWorkspace, pSession, confidenceFloor))
        if (passed.length === 0) continue
        const servedGate = passed.filter((result) => gateSet.includes(result))
        // coverage 口径：served 含 named-cue（easy 层也属已标注可派发），不含 observational/should-ask/derived
        const servedCoverage = passed.filter((result) => !result.shouldAsk && !result.observational && !result.derivedNeedsConfirmation)
        const leaks = passed.filter((result) => result.shouldAsk || result.derivedNeedsConfirmation)
        const correct = servedGate.filter((result) => result.targetCorrect).length
        rows.push({
          pWorkspace,
          pSession,
          confidenceFloor,
          autoAll: passed.length,
          autoServed: servedGate.length,
          servedCoverage: servedCoverage.length,
          correct,
          precision: servedGate.length === 0 ? 1 : correct / servedGate.length,
          precisionWithShouldAskPenalty: correct / (servedGate.length + leaks.length),
          coverage: servedCoverage.length / labeledSet.length,
          labeled: labeledSet.length,
          gateN: gateSet.length,
          shouldAskLeaked: leaks.length,
        })
      }
    }
  }
  const ordered = rows.sort(
    (a, b) =>
      b.precisionWithShouldAskPenalty - a.precisionWithShouldAskPenalty ||
      b.precision - a.precision ||
      b.coverage - a.coverage ||
      a.pWorkspace - b.pWorkspace,
  )
  return qualifyingOnly ? ordered.filter((row) => row.precisionWithShouldAskPenalty >= 0.95 && row.precision >= 0.95) : ordered
}

function calibration(results) {
  const buckets = [
    { label: '<0.5', min: 0, max: 0.5 },
    { label: '0.5–0.6', min: 0.5, max: 0.6 },
    { label: '0.6–0.7', min: 0.6, max: 0.7 },
    { label: '0.7–0.8', min: 0.7, max: 0.8 },
    { label: '0.8–0.9', min: 0.8, max: 0.9 },
    { label: '0.9–1.0', min: 0.9, max: 1.0000001 },
  ]
  return buckets.map((bucket) => {
    const rows = results.filter((result) => !result.shouldAsk && !result.observational && !result.namedCue && !result.derivedNeedsConfirmation && result.pMax >= bucket.min && result.pMax < bucket.max)
    return {
      bucket: bucket.label,
      n: rows.length,
      correct: rows.filter((result) => result.targetCorrect).length,
      accuracy: rows.length === 0 ? null : rows.filter((result) => result.targetCorrect).length / rows.length,
    }
  })
}

function metricsFor(results, set) {
  const attach = set.filter((result) => result.expectedMode === 'attach')
  const rate = (list, predicate) => (list.length === 0 ? null : list.filter(predicate).length / list.length)
  return {
    n: set.length,
    workspaceTop1: rate(set, (result) => result.workspaceCorrect),
    modeAccuracy: rate(set, (result) => result.modeCorrect),
    sessionTop1Attach: rate(attach, (result) => result.sessionCorrect),
    targetCorrect: rate(set, (result) => result.targetCorrect),
  }
}
function metricsOf(results) {
  const base = results.filter((result) => !result.shouldAsk && !result.observational && !result.derivedNeedsConfirmation)
  const gateSet = base.filter((result) => !result.namedCue)
  const allSet = base
  return {
    cases: results.length,
    shouldAsk: results.filter((result) => result.shouldAsk).length,
    namedCue: results.filter((result) => result.namedCue).length,
    observational: results.filter((result) => result.observational).length,
    derivedNeedsConfirmation: results.filter((result) => result.derivedNeedsConfirmation).length,
    conflicts: results.filter((result) => result.conflict).length,
    gate: metricsFor(results, gateSet), // 门禁口径：non-named-cue
    all: metricsFor(results, allSet), // 报告口径：含 named-cue easy 层
  }
}

// ---------------------------------------------------------------- 执行
const caseById = new Map(cases.map((item) => [item.id, item]))
const replayResults = (() => {
  if (replayFile === null) return null
  const prior = JSON.parse(fs.readFileSync(replayFile, 'utf8'))
  const rows = prior.caseResults.map((row) => {
    const frozenCase = caseById.get(row.id) ?? null
    const tags = frozenCase?.tags ?? []
    const derivedNeedsConfirmation = whitelistMode === 'reality' && frozenCase !== null ? (() => {
      const whitelist = realityWhitelist(frozenCase)
      return frozenCase.expected?.workspaceId !== undefined && !whitelist.has(frozenCase.expected.workspaceId)
    })() : false
    return {
      ...row,
      tags,
      namedCue: tags.includes('named-cue'),
      observational: tags.includes('observational'),
      shouldAsk: row.shouldAsk || tags.includes('needs_confirmation'),
      derivedNeedsConfirmation,
      pMax: Math.max(row.pWorkspace ?? 0, row.pSession ?? 0),
      tokensOut: 0,
      requests: mode === 'layered' ? 2 : 1,
    }
  })
  return { rows, prior }
})()

const results = []
const requests = []
const errors = []
const startedAt = Date.now()
if (replayResults === null) {
for (let index = 0; index < cases.length; index += 1) {
  const originalCase = cases[index]
  const { effective: caseItem, derivedNeedsConfirmation } = effectiveCase(originalCase)
  let answers
  let builtForEval
  let caseRequests = []
  try {
  if (mock) {
    const mocked = mockCase(caseItem, index)
    answers = mocked.answers
    caseRequests = mocked.requests
    builtForEval = mode === 'full' ? buildFullRequest(caseItem) : (() => {
      const chosenWorkspaceId = [...buildWorkspaceRequest(caseItem).wIndex.entries()].find(([, key]) => key === mocked.answers.workspace.choice)?.[0]
      const sessionBuilt = buildSessionRequest(caseItem, chosenWorkspaceId)
      const workspaceBuilt = buildWorkspaceRequest(caseItem)
      return { wIndex: workspaceBuilt.wIndex, sIndex: sessionBuilt.sIndex, sessions: sessionBuilt.scoped }
    })()
  } else if (mode === 'full') {
    const built = buildFullRequest(caseItem)
    const response = await callJev(built.body)
    answers = extractAnswers(response.json)
    caseRequests = [response]
    builtForEval = built
  } else {
    const workspaceBuilt = buildWorkspaceRequest(caseItem)
    const workspaceResponse = await callJev(workspaceBuilt.body)
    const workspaceAnswers = extractAnswers(workspaceResponse.json)
    const workspaceAnswer = normalizeAnswer(workspaceAnswers.workspace)
    const chosenWorkspaceId = [...workspaceBuilt.wIndex.entries()].find(([, key]) => key === workspaceAnswer.choice)?.[0] ?? null
    const sessionBuilt = buildSessionRequest(caseItem, chosenWorkspaceId)
    const sessionResponse = await callJev(sessionBuilt.body)
    const sessionAnswers = extractAnswers(sessionResponse.json)
    answers = { workspace: workspaceAnswer, session: normalizeAnswer(sessionAnswers.session) }
    caseRequests = [workspaceResponse, sessionResponse]
    builtForEval = { wIndex: workspaceBuilt.wIndex, sIndex: sessionBuilt.sIndex, sessions: sessionBuilt.scoped }
  }
  const result = evaluate(originalCase, answers, builtForEval)
  result.derivedNeedsConfirmation = derivedNeedsConfirmation
  result.requests = caseRequests.length
  result.elapsedMs = caseRequests.reduce((sum, request) => sum + request.elapsedMs, 0)
  result.tokensIn = caseRequests.reduce((sum, request) => sum + request.requestTokens.input, 0)
  result.tokensOut = caseRequests.reduce((sum, request) => sum + request.requestTokens.output, 0)
  result.estimatedTokens = caseRequests.some((request) => request.requestTokens.estimated)
  results.push(result)
  requests.push(...caseRequests)
  process.stderr.write(`. ${originalCase.id} ${result.shouldAsk || result.derivedNeedsConfirmation ? '(needs-confirm)' : result.targetCorrect ? 'ok' : 'miss'}\n`)
  } catch (error) {
    if (!skipErrors) throw error
    errors.push({ id: originalCase.id, error: String(error?.message ?? error).slice(0, 300) })
    process.stderr.write(`! ${originalCase.id} ERROR ${String(error?.message ?? error).slice(0, 120)}\n`)
  }
}
} else {
  results.push(...replayResults.rows)
  if (Array.isArray(replayResults.prior.errors)) errors.push(...replayResults.prior.errors)
}
const elapsedTotalMs = replayResults === null ? Date.now() - startedAt : (replayResults.prior.totals?.elapsedMs ?? 0)

// ---------------------------------------------------------------- 汇总
const metrics = metricsOf(results)
const allSweepRows = sweep(results, { qualifyingOnly: false })
const thresholdRows = allSweepRows.filter((row) => row.precisionWithShouldAskPenalty >= 0.95 && row.precision >= 0.95)
const calibrationRows = calibration(results)
const percentile = (values, p) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
const latency = results.map((result) => result.elapsedMs)
const tokensInTotal = replayResults === null ? results.reduce((sum, result) => sum + result.tokensIn, 0) : replayResults.prior.totals?.tokens?.input ?? 0
const tokensOutTotal = replayResults === null ? results.reduce((sum, result) => sum + result.tokensOut, 0) : replayResults.prior.totals?.tokens?.output ?? 0
const estimated = replayResults === null ? results.some((result) => result.estimatedTokens) : Boolean(replayResults.prior.totals?.tokens?.estimated)
const requestCount =
  replayResults === null
    ? requests.length
    : replayResults.prior.totals?.requests || results.length * (mode === 'layered' ? 2 : 1)
const maxTokensPerCase = Math.max(...results.map((result) => result.tokensIn))
const summary = {
  generatedAt: new Date().toISOString(),
  caseFile: file,
  caseFileSha256,
  caseManifest: caseManifest
    ? { file: manifestFile, generatorRev: caseManifest.generatorRev, seed: caseManifest.seed, summaryMode: caseManifest.summaryMode, caseSha256: caseManifest.caseSha256, shaMatch: caseManifest.caseSha256 === caseFileSha256 }
    : null,
  mode,
  criteriaStyle,
  whitelist: whitelistMode,
  replayedFrom: replayFile,
  mock,
  endpoint: mock ? 'mock' : endpoint,
  model: mock ? 'mock' : model,
  exitCode: null,
  errors,
  totals: {
    cases: results.length,
    requests: requestCount,
    requestsPerCase: Number((requestCount / Math.max(1, results.length)).toFixed(2)),
    elapsedMs: elapsedTotalMs,
    latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), max: Math.max(...latency) },
    tokens: { input: tokensInTotal, output: tokensOutTotal, estimated },
    tokensPerCaseInput: Number((tokensInTotal / Math.max(1, results.length)).toFixed(1)),
  },
  metrics,
  thresholdRows,
  allSweepRows,
  bestThreshold: thresholdRows[0] ?? null,
  caseResults: results.map((result) => ({
    id: result.id,
    layer: result.layer,
    shouldAsk: result.shouldAsk,
    expectedWorkspaceId: result.expectedWorkspaceId,
    expectedSessionId: result.expectedSessionId,
    expectedMode: result.expectedMode,
    chosenWorkspaceId: result.chosenWorkspaceId,
    chosenSessionId: result.chosenSessionId,
    chosenMode: result.chosenMode,
    workspaceCorrect: result.workspaceCorrect,
    modeCorrect: result.modeCorrect,
    sessionCorrect: result.sessionCorrect,
    targetCorrect: result.targetCorrect,
    conflict: result.conflict,
    pWorkspace: Number(result.pWorkspace.toFixed(4)),
    cWorkspace: Number(result.cWorkspace.toFixed(4)),
    pSession: Number(result.pSession.toFixed(4)),
    cSession: Number(result.cSession.toFixed(4)),
    tokensIn: result.tokensIn,
    elapsedMs: Number(result.elapsedMs.toFixed(1)),
  })),
  calibration: calibrationRows,
  gates: {
    'C1-case-audit': true,
    'C2-workspace-top1': (metrics.gate.workspaceTop1 ?? 0) >= 0.85,
    'C3-session-top1-attach': (metrics.gate.sessionTop1Attach ?? 0) >= 0.7,
    'C4-mode': (metrics.gate.modeAccuracy ?? 0) >= 0.85,
    'C5-auto-precision': thresholdRows.length > 0 && (thresholdRows[0]?.precisionWithShouldAskPenalty ?? 0) >= 0.95,
    'C6-auto-coverage': thresholdRows.length > 0 && (thresholdRows[0]?.coverage ?? 0) >= 0.4,
    'C7-latency': percentile(latency, 0.95) < 3000,
    'C7-tokens': mode === 'layered' ? true : maxTokensPerCase <= 24000,
  },
  shouldAskDetail: results.filter((result) => result.shouldAsk).map((result) => ({
    id: result.id,
    chosenWorkspaceId: result.chosenWorkspaceId,
    chosenMode: result.chosenMode,
    pWorkspace: Number(result.pWorkspace.toFixed(3)),
    pSession: Number(result.pSession.toFixed(3)),
    autoAtBest: thresholdRows[0] ? gatePass(result, thresholdRows[0].pWorkspace, thresholdRows[0].pSession, thresholdRows[0].confidenceFloor) : null,
  })),
}
summary.__maxTokensPerCase = maxTokensPerCase

// ---------------------------------------------------------------- 报告
const pct = (value) => `${(value * 100).toFixed(1)}%`
const short = (id) => (typeof id === 'string' && id.length > 12 ? `…${id.slice(-8)}` : id ?? '—')
const layerCounts = {}
for (const result of results) layerCounts[result.layer] = (layerCounts[result.layer] ?? 0) + 1
const lines = []
lines.push(`# Jev dispatch evaluation（${mock ? 'MOCK 自检' : 'LIVE'} · ${mode}）`)
lines.push('')
lines.push(`- cases: ${cases.length}（layerCounts=${JSON.stringify(layerCounts)}）`)
lines.push(`- caseSha256: \`${caseFileSha256}\``)
if (caseManifest !== null) lines.push(`- manifest: generatorRev=\`${caseManifest.generatorRev ?? '?'}\` seed=\`${caseManifest.seed ?? '?'}\` summaryMode=\`${caseManifest.summaryMode ?? '?'}\` manifestCaseSha256=\`${caseManifest.caseSha256 ?? '?'}\`${caseManifest.caseSha256 === caseFileSha256 ? '（一致）' : '（**不一致，证据链作废**）'}`)
if (caseManifest !== null) {
  const dispatchTime = caseManifest.dispatchTime
  const dispatchTimeText =
    typeof dispatchTime === 'object' && dispatchTime !== null ? `${dispatchTime.min} – ${dispatchTime.max}` : (dispatchTime ?? '?')
  lines.push(`- dispatchTime: ${dispatchTimeText}（per-case as-of；逐条见 _provenance.dispatchAt）`)
  lines.push(`- violations: ${caseManifest.leakViolations ?? caseManifest.auditResult?.violations ?? '?'}（manifest.leakViolations / auditResult；冻结前 audit-cases A1–A12）`)
}
lines.push(`- mode: ${mode}（${mode === 'full' ? 'A 全量一波' : 'B 两层'}）`)
lines.push(`- run: ${mock ? '**mock（harness 自检，不是 live 结果，禁止写入门禁）**' : replayResults !== null ? 'replay（复用原 live summary 的 caseResults 重算，未重新调用 API）' : 'live'}`)
lines.push(`- endpoint: ${mock ? 'mock' : endpoint}`)
lines.push(`- model: ${mock ? 'mock' : model}`)
lines.push(`- requests: ${requestCount}（${(requestCount / Math.max(1, results.length)).toFixed(2)}/case）`)
lines.push(`- tokens: input=${tokensInTotal}${estimated ? '（含估算，响应无 usage）' : ''} / output=${tokensOutTotal}`)
lines.push(`- latency/case: p50=${Math.round(percentile(latency, 0.5))}ms p95=${Math.round(percentile(latency, 0.95))}ms max=${Math.round(Math.max(...latency))}ms`)
lines.push('')
lines.push('## Accuracy（不含 should-ask 层；should-ask 期望 needs_confirmation，不进分母）')
lines.push('')
lines.push('| 指标 | 门禁口径（non-named-cue） | 报告口径（含 named-cue easy 层） |')
lines.push('|---|---:|---:|')
lines.push(`| n | ${metrics.gate.n} | ${metrics.all.n} |`)
lines.push(`| 工作区 Top-1 | ${pct(metrics.gate.workspaceTop1)}（≥85%） | ${pct(metrics.all.workspaceTop1)} |`)
lines.push(`| 会话 Top-1（attach） | ${pct(metrics.gate.sessionTop1Attach)}（≥70%） | ${pct(metrics.all.sessionTop1Attach)} |`)
lines.push(`| 模式（new/attach） | ${pct(metrics.gate.modeAccuracy)}（≥85%） | ${pct(metrics.all.modeAccuracy)} |`)
lines.push(`| 目标全对 | ${pct(metrics.gate.targetCorrect)} | ${pct(metrics.all.targetCorrect)} |`)
lines.push(`| should-ask / named-cue / observational / derived-needs-confirm | ${metrics.shouldAsk} / ${metrics.namedCue} / ${metrics.observational} / ${metrics.derivedNeedsConfirmation} | — |`)
lines.push(`| workspace/session 冲突 | ${metrics.conflicts} | 0 |`)
lines.push('')
lines.push('## 阈值扫描（precision ≥ 95%，按 coverage 降序取前 10）')
lines.push('')
lines.push('| pWorkspace | pSession | confidenceFloor | auto(cases) | served(gate) | served(coverage) | correct | precision(gate served) | precision(含 should-ask 惩罚) | coverage=served/labeled(45) | should-ask 泄漏 |')
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const row of thresholdRows.slice(0, 10)) {
  lines.push(
    `| ${row.pWorkspace} | ${row.pSession} | ${row.confidenceFloor} | ${row.autoAll} | ${row.autoServed} | ${row.servedCoverage ?? '-'} | ${row.correct} | ${pct(row.precision)} | ${pct(row.precisionWithShouldAskPenalty)} | ${pct(row.coverage)}（labeled=${row.labeled ?? '-'}, gateN=${row.gateN ?? '-'}） | ${row.shouldAskLeaked} |`,
  )
}
if (thresholdRows.length === 0) lines.push('| - | - | - | - | - | - | - | - | - | 没有任何组合达到 precision ≥95% |')
lines.push('')
lines.push('## 校准（pMax = max(pWorkspace, pSession) 分桶，不含 should-ask）')
lines.push('')
lines.push('| pMax 桶 | n | correct | accuracy |')
lines.push('|---|---:|---:|---:|')
for (const row of calibrationRows) lines.push(`| ${row.bucket} | ${row.n} | ${row.correct} | ${row.accuracy === null ? '—' : pct(row.accuracy)} |`)
lines.push('')
lines.push('## should-ask 层（期望 needs_confirmation）')
lines.push('')
const best = thresholdRows[0]
for (const detail of results.filter((result) => result.shouldAsk)) {
  lines.push(
    `- ${detail.id}: pW=${detail.pWorkspace.toFixed(2)} pS=${detail.pSession.toFixed(2)}${best ? ` → 最优阈值下${gatePass(detail, best.pWorkspace, best.pSession, best.confidenceFloor) ? '**会被自动放行（错误）**' : '被门控拦下（正确）'}` : ''}`,
  )
}
lines.push('')
lines.push('## 逐条案例（expected vs chosen）')
lines.push('')
lines.push('| id | layer | expected(ws / mode / session) | chosen(ws / mode / session) | target | pW | pS |')
lines.push('|---|---|---|---|---|---:|---:|')
const wsName = (caseItem, id) => caseItem.workspaces.find((workspace) => workspace.id === id)?.name ?? short(id)
const byId = new Map(cases.map((caseItem) => [caseItem.id, caseItem]))
for (const result of results) {
  const caseItem = byId.get(result.id)
  lines.push(
    `| ${result.id} | ${result.layer} | ${wsName(caseItem, result.expectedWorkspaceId)} / ${result.expectedMode} / ${short(result.expectedSessionId)} | ${wsName(caseItem, result.chosenWorkspaceId)} / ${result.chosenMode} / ${short(result.chosenSessionId)} | ${result.shouldAsk ? 'should-ask' : result.targetCorrect ? '✅' : '❌'} | ${result.pWorkspace.toFixed(2)} | ${result.pSession.toFixed(2)} |`,
  )
}
lines.push('')
const markdown = lines.join('\n')

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, markdown)
  console.log(`wrote ${outFile}`)
} else {
  console.log(markdown)
}
if (summaryOut) {
  fs.mkdirSync(path.dirname(summaryOut), { recursive: true })
  fs.writeFileSync(summaryOut, JSON.stringify(summary, undefined, 2))
  console.log(`wrote ${summaryOut}`)
}

const gateFailed = Object.entries(summary.gates).filter(([, value]) => !value).map(([key]) => key)
process.stderr.write(`\nmetrics: ${JSON.stringify(metrics)}\n`)
if (thresholdRows[0]) process.stderr.write(`best: ${JSON.stringify(thresholdRows[0])}\n`)
process.stderr.write(`gates: ${JSON.stringify(summary.gates)}\n`)
if (gateFailed.length > 0) process.stderr.write(`gate FAIL: ${gateFailed.join(', ')}\n`)
if (gateMode && gateFailed.length > 0) process.exitCode = 1
