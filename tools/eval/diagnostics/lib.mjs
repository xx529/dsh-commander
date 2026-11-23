// V5 FAIL 诊断实验（非门禁）共享库：只读 frozen 案例、构造 Jev choice 请求、调用与落盘。
// 不修改 frozen cases、不覆盖 v2 报告；仅用于 docs/eval/diagnostics-v3.md。
import fs from 'node:fs'
import crypto from 'node:crypto'

export const ENDPOINT = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
export const MODEL = process.env.JEV_MODEL || 'jev-latest'
export const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 30000)
export const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex')
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

export function loadCases(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const tagsOf = (c) => c.tags || []
export const isShouldAsk = (c) => tagsOf(c).includes('should-ask') || c.expected?.needsConfirmation === true
export const isNamedCue = (c) => tagsOf(c).includes('named-cue')
export const isObservational = (c) => tagsOf(c).includes('observational')
/** 门禁口径案例：non-named-cue、非观测、非 should-ask（与 report-v2 的 gate set 一致）。 */
export const gateCases = (cases) => cases.filter((c) => !isShouldAsk(c) && !isNamedCue(c) && !isObservational(c))

/** 逐案例确定性抽样：expected 之外的候选按 sha1(seed:caseId:wsId) 排序取前 n 个。 */
export function pickCandidates(c, n, seed = 'diag-v3') {
  const expected = c.expected?.workspaceId
  const others = c.workspaces
    .filter((ws) => ws.id !== expected)
    .map((ws) => ({ ws, rank: sha1(`${seed}:${c.id}:${ws.id}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, Math.max(0, n - 1))
    .map((item) => item.ws)
  const expectedWs = c.workspaces.find((ws) => ws.id === expected)
  return expectedWs === undefined ? others : [expectedWs, ...others]
}

const workspaceCriteriaCompact = (workspaces) => {
  const criteria = {}
  workspaces.forEach((ws, index) => {
    criteria[`w_${index}`] = { what: ws.name }
  })
  return criteria
}

const stateOf = (c, workspaces, sessions) => ({
  task: c.task,
  command: c.command || { text: '' },
  workspaces: workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    summary: ws.summary || '',
    recentTasks: ws.recentTasks || [],
  })),
  sessions: (sessions ?? []).map((session) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    lastActiveAt: session.lastActiveAt,
    contextUsage: session.contextUsage,
  })),
  constraints: { allowedWorkspaces: workspaces.map((ws) => ws.id) },
})

/** 工作区 choice（候选 = 给定集合，compact criteria 与 v2 harness 一致）。 */
export function buildWorkspaceChoice(c, candidates) {
  const wIndex = new Map(candidates.map((ws, index) => [ws.id, `w_${index}`]))
  return {
    body: {
      model: MODEL,
      state: stateOf(c, candidates),
      questions: {
        workspace: {
          type: 'choice',
          instructions: '哪个工作区最适合这个任务？综合考虑职责、历史任务与能力匹配。',
          criteria: workspaceCriteriaCompact(candidates),
        },
      },
    },
    wIndex,
    candidates,
  }
}

/** 会话 choice（oracle 工作区隔离：只给该工作区的会话 + new）。 */
export function buildSessionChoice(c, oracleWorkspaceId) {
  const workspace = c.workspaces.find((ws) => ws.id === oracleWorkspaceId) ?? null
  const sessions = (c.sessions ?? []).filter((session) => session.workspaceId === oracleWorkspaceId)
  const sIndex = new Map(sessions.map((session, index) => [session.id, `s_${index}`]))
  const criteria = { new: { what: '新建会话' } }
  for (const session of sessions) criteria[sIndex.get(session.id)] = { what: String(session.title).slice(0, 16) }
  return {
    body: {
      model: MODEL,
      state: stateOf(c, workspace === null ? [] : [workspace], sessions),
      questions: {
        session: {
          type: 'choice',
          instructions: '哪个会话最适合？如果没有合适的已有会话，选 new。',
          criteria,
        },
      },
    },
    sIndex,
    sessions,
  }
}

/** 逐候选打分（noul 近似）：每个候选单独问「是不是这个」，取该候选概率作为分数。 */
export function buildCandidateScore(c, candidate) {
  const others = c.workspaces.filter((ws) => ws.id !== candidate.id)
  return {
    body: {
      model: MODEL,
      state: stateOf(c, [candidate, ...others.slice(0, 7)]),
      questions: {
        workspace: {
          type: 'choice',
          instructions: '如果只能从这个工作区与「以上都不合适」中选择，这个任务应派给哪个？',
          criteria: {
            this: { what: candidate.name },
            none: { what: '以上都不合适' },
          },
        },
      },
    },
  }
}

export function extractWorkspaceAnswer(json) {
  const answers = json?.answers ?? json?.result?.answers ?? json?.data?.answers
  const answer = answers?.workspace
  if (!answer || typeof answer !== 'object') return { choice: null, p: 0, confidence: 0 }
  const choice = typeof answer.choice === 'string' ? answer.choice : null
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  return { choice, p: Number(probabilities[choice] ?? 0), confidence: Number(answer.confidence ?? 0), probabilities }
}

export function extractSessionAnswer(json) {
  const answers = json?.answers ?? json?.result?.answers ?? json?.data?.answers
  const answer = answers?.session
  if (!answer || typeof answer !== 'object') return { choice: null, p: 0, confidence: 0 }
  const choice = typeof answer.choice === 'string' ? answer.choice : null
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  return { choice, p: Number(probabilities[choice] ?? 0), confidence: Number(answer.confidence ?? 0) }
}

let requestCount = 0
export const requestsUsed = () => requestCount

/** 调用 Jev：429/529 退避重试一次；4xx 不重试；返回原始 json + 时延 + usage。 */
export async function callJev(apiKey, body) {
  const startedAt = performance.now()
  const serialized = JSON.stringify(body)
  requestCount += 1
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: serialized,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const latencyMs = performance.now() - startedAt
    if (response.status === 429 || response.status === 529) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      throw new Error(`Jev ${response.status}`)
    }
    if (!response.ok) throw new Error(`Jev ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const json = await response.json()
    return { json, latencyMs, usage: json?.usage ?? null, requestBytes: serialized.length }
  }
  throw new Error('unreachable')
}

export function appendJsonl(file, rows) {
  fs.mkdirSync(file.split('/').slice(0, -1).join('/'), { recursive: true })
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''))
}

export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}
