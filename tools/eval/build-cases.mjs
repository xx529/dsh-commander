#!/usr/bin/env node
/**
 * V5 案例生成器（v2 · as-of-dispatch）。
 *
 * 设计依据：docs/eval/jev-dispatch-eval.md、docs/eval/cases.schema.json、docs/eval/labels.md。
 * v2 变更（响应 lead/tester 审计，见 labels.md §9）：
 *  1) **as-of-dispatch**：dispatchAt = 该用户消息时间；快照只含 dispatchAt 之前已存在的会话/标题/最近任务；
 *     会话标题优先取 dispatchAt 前的 session/title 事件，否则回退到 dispatchAt 前的首条用户消息；目标消息本身不得进入快照。
 *  2) 工作区语义摘要（v2a）由 dispatchAt 之前该工作区会话标题归纳（≤120 字，脚本启发式，不读目标消息）；
 *     v2b 对照 = 占位摘要（仅路径/计数）。
 *  3) 任务文本重建：`task.goal = 会话上下文摘要（dispatchAt 前 ≤2 条用户要求 + 最近助手要点）+ 原始命令`，
 *     原文进 `_provenance.rawCommand`；重建不注入“应派给当前工作区”提示。
 *  4) **标签泄漏硬断言**：task.title/goal/acceptanceHints（及 command.text）不得包含 expected 工作区名/路径 basename、
 *     expected 会话标题/id；obvious 层不得点名任何工作区名（否则该层自证、不计判别力）。命中即换样本；最终再硬校验。
 *  5) 输出到 v2 独立路径，不覆盖 v1；同时打印 sha256 供冻结审计。
 *
 * 用法：
 *   node tools/eval/build-cases.mjs [--home ~/.dsh] [--out docs/eval/cases.real.v2.jsonl]
 *        [--labels-out docs/eval/labels.cases.v2.md] [--summary-mode semantic|placeholder] [--diagnose] [--stats]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readSessionLog, userMessageText } from './lib/session-log.mjs'

const DAY = 24 * 60 * 60 * 1000
const SNAPSHOT_SPEC = 'v2-asof-dispatch (sessions/title/workspaces filtered by dispatchAt=message.time; title from pre-dispatch session/title event or first pre-dispatch user message)'
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const HOME = argOf('--home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const OUT = argOf('--out', 'docs/eval/cases.real.v2.jsonl')
const LABELS_OUT = argOf('--labels-out', 'docs/eval/labels.cases.v2.md')
const SUMMARY_MODE = argOf('--summary-mode', 'semantic') // semantic(v2a) | placeholder(v2b 对照)
const SEED = argOf('--seed', 'v5')
const STATS_ONLY = argv.includes('--stats')
const DIAGNOSE = argv.includes('--diagnose')

const LAYERS = [
  { slug: 'obvious', title: '明显工作区', quota: 12 },
  { slug: 'ambiguous', title: '跨工作区歧义', quota: 12 },
  { slug: 'old-session', title: '旧会话相关（7–30 天）', quota: 10 },
  { slug: 'new-session', title: '应新建', quota: 6 },
  { slug: 'capability', title: '能力驱动（无能力签名近似层）', quota: 5 },
  { slug: 'should-ask', title: '应询问用户', quota: 5 },
]
const PICK_ORDER = ['obvious', 'should-ask', 'old-session', 'new-session', 'capability', 'ambiguous']

const CAPABILITY_RE = /(playwright|puppeteer|figma|浏览器|截图|browser|agent-desktop|desktop|mcp\b|skill|技能|插件|ollama|tts|语音|whisper|embedding|向量|rerank|重排|zstd|终端|截屏|自动化|远程|ssh)/i
const GENERIC_RE = /^(继续|接着|好|好的|可以|行|开始|执行|跑一下|看一下|看看|修一下|修|做一下|试试|来吧|嗯|ok|continue|go on|再试|再来|完成|下一步|确认|同意)/i

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex')
const iso = (ms) => new Date(ms).toISOString()
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const estimateTokens = (text) => {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
const normSessionId = (id) => (typeof id === 'string' && id.startsWith('session-') ? id : `session-${id}`)

// ---------------------------------------------------------------- 数据
const workspaceStore = readJson(path.join(HOME, 'storages', 'workspace.json'))
if (workspaceStore === undefined) {
  console.error(`cannot read ${path.join(HOME, 'storages', 'workspace.json')}`)
  process.exit(2)
}
const archived = new Set(workspaceStore?.global?.archivedSessionIds ?? [])
const workspaces = Object.entries(workspaceStore?.tables?.workspaces ?? {}).map(([id, row]) => ({
  id,
  path: String(row?.path ?? ''),
  title: String(row?.title ?? ''),
}))
const wsByPath = new Map(workspaces.map((ws) => [ws.path.replace(/\/+$/, ''), ws]))
const wsById = new Map(workspaces.map((ws) => [ws.id, ws]))

function scanSessions(home) {
  const root = path.join(home, 'sessions')
  const records = new Map()
  if (!fs.existsSync(root)) return records
  for (const parent of fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory())) {
    const parentDir = path.join(root, parent)
    for (const dirName of fs.readdirSync(parentDir).filter((name) => fs.statSync(path.join(parentDir, name)).isDirectory())) {
      const dir = path.join(parentDir, dirName)
      const newest = fs.readdirSync(dir).filter((name) => /^session\..*\.jsonl(\.zstd)?$/.test(name)).sort().at(-1)
      if (newest === undefined) continue
      let events
      try {
        events = readSessionLog(path.join(dir, newest))
      } catch {
        continue
      }
      const header = events.find((event) => event.type === 'session')
      if (header === undefined || typeof header.id !== 'string') continue
      const id = normSessionId(header.id)
      const titleEvents = []
      const userMessages = []
      const assistantMessages = []
      for (const event of events) {
        const time = Number(event.time)
        if (!Number.isFinite(time)) continue
        if (event.type === 'session/title' && typeof event?.data?.title === 'string') titleEvents.push({ time, title: event.data.title })
        else if (event.type === 'user/message' && event?.data?.source?.kind === 'user') {
          const text = userMessageText(event)
          if (text.length > 0) userMessages.push({ time, text })
        } else if (event.type === 'assistant/message') {
          const text = userMessageText(event)
          if (text.length > 0) assistantMessages.push({ time, text })
        }
      }
      const times = events.map((event) => Number(event.time)).filter(Number.isFinite)
      records.set(id, {
        id,
        createdAt: Number(header.createdAt ?? 0),
        cwd: String(header.cwd ?? ''),
        isTopLevel: typeof header.parentSession !== 'string',
        archived: archived.has(id),
        workspaceId: wsByPath.get(String(header.cwd ?? '').replace(/\/+$/, ''))?.id ?? null,
        titleEvents,
        userMessages,
        assistantMessages,
        times: times.sort((a, b) => a - b),
      })
    }
  }
  return records
}

const now = Date.now()
const ACTIVE_WINDOW_MS = 10 * 60 * 1000
const all = scanSessions(HOME)
const pool = [...all.values()].filter(
  (session) =>
    session.isTopLevel &&
    session.workspaceId !== null &&
    !session.archived &&
    session.userMessages.length > 0 &&
    session.times.length > 0 &&
    now - session.times.at(-1) > ACTIVE_WINDOW_MS,
)

/** 事件时间 <= t 的最后一个。 */
function latestBefore(times, t) {
  let lo = 0
  let hi = times.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found >= 0 ? times[found] : 0
}

/** as-of 标题：dispatchAt 前最后一个 session/title 事件；否则回退 dispatchAt 前的首条用户消息。 */
function titleAsOf(session, dispatchAt) {
  const event = session.titleEvents.filter((item) => item.time <= dispatchAt).at(-1)
  if (event?.title) return { title: event.title, source: 'session/title@pre-dispatch' }
  const first = session.userMessages.find((item) => item.time <= dispatchAt)
  if (first) return { title: first.text.replace(/\s+/g, ' ').trim().slice(0, 40), source: 'first-user-message@pre-dispatch' }
  return { title: '（未命名会话）', source: 'none' }
}
const lastActiveAsOf = (session, dispatchAt) => latestBefore(session.times, dispatchAt)

// ---------------------------------------------------------------- 工作区名匹配（仅选样，不用于标签）
const GENERIC_TOKENS = new Set(['test', 'workspace', 'project', 'agent', 'github', 'documents', 'app', 'dev', 'probe'])
const wsKeys = new Map()
for (const ws of workspaces) {
  const base = ws.path.split('/').filter(Boolean).pop() ?? ''
  const keys = new Set()
  for (const raw of [base, ws.title]) {
    const key = String(raw).toLowerCase().trim()
    if (key.length >= 4 && !GENERIC_TOKENS.has(key)) keys.add(key)
    for (const part of key.split(/[-_.\s]+/)) if (part.length >= 3 && !GENERIC_TOKENS.has(part)) keys.add(part)
  }
  wsKeys.set(ws.id, [...keys])
}
const reEsc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const workspaceMentions = (text) => {
  const lower = text.toLowerCase()
  const hits = new Set()
  for (const ws of workspaces) for (const key of wsKeys.get(ws.id) ?? []) if (lower.includes(key)) hits.add(ws.id)
  return hits
}
const titleTokens = (title) => {
  const tokens = new Set()
  for (const run of String(title).match(/[\u3400-\u9fff]+|[A-Za-z0-9]+/g) ?? []) {
    if (/^[\u3400-\u9fff]+$/.test(run)) {
      if (run.length >= 2) tokens.add(run)
    } else if (run.length >= 4) tokens.add(run.toLowerCase())
  }
  return [...tokens]
}
const overlapTokens = (text, title) => titleTokens(title).filter((token) => text.toLowerCase().includes(token))

// ---------------------------------------------------------------- 每会话候选消息
const sessionEntries = pool
  .map((session) => {
    const messages = session.userMessages
      .map((message, index) => ({ ...message, index }))
      .filter((message) => message.text.length >= 12 && !message.text.startsWith('/'))
    if (messages.length === 0) return null
    const dispatchAt = messages.at(-1).time
    return {
      session,
      ownWs: wsById.get(session.workspaceId),
      messages,
      first: messages.find((message) => message.index === 0) ?? null,
      last: messages.at(-1),
      dispatchAt,
      // dispatchAt 前的候选会话/标题（as-of 快照与选样共用，不含目标消息）
      preSessions: pool.filter((other) => other.createdAt > 0 && other.createdAt <= dispatchAt),
    }
  })
  .filter(Boolean)

const ageDaysAtDispatch = (entry) => (entry.dispatchAt - lastActiveAsOf(entry.session, entry.dispatchAt)) / DAY
const sameWorkspaceSimilar = (entry, text, dispatchAt) =>
  pool.some(
    (other) =>
      other.id !== entry.session.id &&
      other.workspaceId === entry.session.workspaceId &&
      other.createdAt <= dispatchAt &&
      (() => {
        const { title } = titleAsOf(other, dispatchAt)
        return title !== '（未命名会话）' && overlapTokens(text, title).length > 0
      })(),
  )
const recencyTrapAt = (entry) =>
  pool.some(
    (other) =>
      other.id !== entry.session.id &&
      other.workspaceId !== entry.session.workspaceId &&
      lastActiveAsOf(other, entry.dispatchAt) > lastActiveAsOf(entry.session, entry.dispatchAt) &&
      other.createdAt <= entry.dispatchAt,
  )
const plausibleWorkspacesAt = (text, dispatchAt, minOverlap = 2) => {
  const hits = new Set(workspaceMentions(text))
  const byWs = new Map()
  for (const session of pool) {
    if (session.createdAt > dispatchAt) continue
    const { title } = titleAsOf(session, dispatchAt)
    if (title === '（未命名会话）') continue
    const list = byWs.get(session.workspaceId) ?? []
    list.push(title)
    byWs.set(session.workspaceId, list)
  }
  for (const [workspaceId, titles] of byWs) if (titles.filter((title) => overlapTokens(text, title).length > 0).length >= minOverlap) hits.add(workspaceId)
  return hits
}

function layerEntries(slug) {
  switch (slug) {
    case 'obvious': {
      // named-cue easy/回归层：首条消息自包含且点名本工作区（≥4 字符名称/路径片段；不具判派判别力，门禁不计）
      const namedCueHit = (entry) => {
        const own = entry.ownWs
        if (!own) return false
        const base = own.path.split('/').filter(Boolean).pop() ?? ''
        const keys = new Set(
          [own.title, base, ...base.split(/[-_.\s]+/), ...own.title.split(/[-_.\s]+/)]
            .map((key) => String(key).toLowerCase().trim())
            .filter((key) => key.length >= 4 && !GENERIC_TOKENS.has(key)),
        )
        const lower = entry.first.text.toLowerCase()
        return [...keys].some((key) => lower.includes(key))
      }
      return sessionEntries.filter((entry) => entry.first !== null && entry.first.text.length >= 12 && namedCueHit(entry))
    }
    case 'ambiguous':
      return sessionEntries.filter((entry) => plausibleWorkspacesAt(entry.last.text, entry.dispatchAt, 2).size >= 2)
    case 'old-session':
      // 该层 dispatchAt = 生成时刻（此刻派发历史任务）；相关会话在 7–30 天前，且存在更新的其它工作区会话
      return sessionEntries
        .filter((entry) => entry.last.index > 0)
        .filter((entry) => {
          const age = (now - lastActiveAsOf(entry.session, now)) / DAY
          const trap = pool.some(
            (other) =>
              other.id !== entry.session.id &&
              other.workspaceId !== entry.session.workspaceId &&
              other.createdAt <= now &&
              lastActiveAsOf(other, now) > lastActiveAsOf(entry.session, now),
          )
          return age >= 7 && age <= 30 && trap
        })
        .map((entry) => ({ ...entry, dispatchAt: now }))
    case 'new-session':
      return sessionEntries.filter(
        (entry) =>
          entry.first !== null &&
          entry.first.index === 0 &&
          sameWorkspaceSimilar(entry, entry.first.text, entry.dispatchAt),
      )
    case 'capability':
      return sessionEntries.filter((entry) => CAPABILITY_RE.test(entry.last.text))
    case 'should-ask':
      return sessionEntries.filter((entry) => {
        const text = entry.last.text.trim()
        return text.length <= 30 && GENERIC_RE.test(text) && workspaceMentions(text).size === 0
      })
    default:
      throw new Error(`unknown layer ${slug}`)
  }
}

// ---------------------------------------------------------------- 任务重建 + 泄漏断言
function reconstructTask(entry, message, layer) {
  const priorUsers = entry.session.userMessages
    .filter((item) => item.time < message.time)
    .slice(-2)
    .map((item) => item.text.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
  const priorAssistant = entry.session.assistantMessages
    .filter((item) => item.time < message.time)
    .at(-1)
    ?.text.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const parts = []
  if (priorUsers.length > 0) parts.push(`此前用户要求：${priorUsers.join('；')}`)
  if (priorAssistant) parts.push(`此前助手要点：${priorAssistant}`)
  const context = parts.length > 0 ? parts.join('。') : '新任务（该会话首条消息，无历史会话上下文）'
  const rawLimit = layer.slug === 'obvious' ? 600 : 160
  const raw = message.text.replace(/\s+/g, ' ').trim()
  const rawShown = raw.length > rawLimit ? `${raw.slice(0, rawLimit)}…` : raw
  const goalLimit = layer.slug === 'obvious' ? 720 : 240
  const goal = `${context}。本次指令：${rawShown}`.slice(0, goalLimit)
  const titleLine = raw.split(/[\n。；]/).find((line) => line.trim().length > 0) ?? ''
  const title = titleLine.trim().replace(/^#+\s*/, '').slice(0, 40) || '任务'
  return { context, raw, rawShown, goal, title, rawTruncated: rawShown !== raw, goalTruncated: goal.length !== `${context}。本次指令：${rawShown}`.length }
}

const MODE_RULE = 'mode=该消息是否为该会话首条真实用户消息（首条→new；非首条→attach 到该会话；回放语义）'

function expectedFor(entry, layer) {
  const message = layer.slug === 'obvious' || layer.slug === 'new-session' ? entry.first : entry.last
  const baseMode = message.index === 0 ? 'new' : 'attach'
  if (layer.slug === 'should-ask') {
    return {
      message,
      baseMode,
      expected: { needsConfirmation: true, note: '应询问层：低信息量真实用户消息 → 期望询问用户（不进 Top-1 分母；被自动派发放行即按 precision 计错）' },
      tags: [layer.slug, 'needs-review', 'needs_confirmation', 'reconstructed-task'],
    }
  }
  const expected = { workspaceId: entry.session.workspaceId, mode: baseMode }
  if (baseMode === 'attach') expected.sessionId = entry.session.id
  const tags = [layer.slug, baseMode, 'reconstructed-task']
  if (layer.slug === 'obvious') tags.push('self-contained', 'named-cue')
  if (layer.slug === 'capability') tags.push('observational')
  let rule = MODE_RULE
  let confidence = 'high'
  let needsReview = false
  if (layer.slug === 'old-session') {
    rule += `；旧会话层：相关会话 dispatchAt 前最后活动在 ${ageDaysAtDispatch(entry).toFixed(1)} 天前（7–30 天窗口）且存在更新的其它工作区会话（最近先验陷阱）；期望仍 attach 到该旧会话`
    confidence = 'medium'
    needsReview = true
  } else if (layer.slug === 'new-session') {
    rule += '；应新建层：首条用户消息 + 同工作区存在 dispatchAt 前标题词相似的已有会话（“没有合适已有会话”的近似）→ 期望 new（结构启发式）'
    confidence = 'low'
    needsReview = true
  } else if (layer.slug === 'ambiguous') {
    rule += '；跨工作区歧义层：任务文本按 dispatchAt 前历史标题可匹配 ≥2 个工作区；期望工作区仍取 cwd 精确匹配（Fact）'
    confidence = 'medium'
    needsReview = true
  } else if (layer.slug === 'capability') {
    rule += '；能力提及层（观测项，不参与门禁）：文本点名能力/工具关键词；capabilityDigest 不可得，不做能力签名结论'
    confidence = 'low'
    needsReview = true
    tags.push('capability-approx')
  } else if (layer.slug === 'obvious') {
    rule += '；named-cue easy/回归层：首条消息自包含且点名本工作区名（判派判别力≈0，门禁指标不计；报告两套并列）'
  }
  if (needsReview) tags.push('needs-review')
  expected.note = `${rule}；workspace-by=cwd-exact-match；annotator=build-cases.mjs(rule)；confidence=${confidence}；needsReview=${needsReview}`
  return { message, baseMode, expected, tags }
}

/** 禁止进入请求文本的泄漏串：expected 工作区名/路径 basename/id、expected 会话标题/id；obvious 还禁止任何工作区名。 */
function leakViolations(text, entry, layer, expected) {
  const lower = String(text).toLowerCase()
  const violations = []
  const own = entry.ownWs
  const namedCue = layer.slug === 'obvious'
  const ownNames = [own?.title, own?.path?.split('/').filter(Boolean).pop(), expected.workspaceId].filter((name) => typeof name === 'string' && name.length >= 4)
  if (!namedCue) for (const name of ownNames) if (lower.includes(String(name).toLowerCase())) violations.push(`own-workspace:${name}`)
  if (expected.sessionId && lower.includes(String(expected.sessionId).toLowerCase())) violations.push(`expected-session-id:${expected.sessionId}`)
  const sessionTitle = titleAsOf(entry.session, entry.dispatchAt).title
  if (expected.sessionId && sessionTitle && sessionTitle !== '（未命名会话）' && sessionTitle.length >= 8 && lower.includes(sessionTitle.toLowerCase())) {
    violations.push(`expected-session-title:${sessionTitle.slice(0, 20)}`)
  }
  // named-cue easy 层：只要求点名本工作区；同时点名其它工作区不影响层定义（不计判别力）
  return [...new Set(violations)]
}

const orderEntries = (list) => [...list].sort((a, b) => sha1(`${SEED}:${a.session.id}:${a.dispatchAt}`).localeCompare(sha1(`${SEED}:${b.session.id}:${b.dispatchAt}`)))

const usedSessions = new Set()
const selection = []
const shortfall = []
const skipped = []
// should-ask 候选池只有 5 条，先行保留，避免被 obvious 层抢占（否则整体凑不齐 50）
const reservedForShouldAsk = new Set((() => {
  const entries = orderEntries(layerEntries('should-ask'))
  return entries.slice(0, 5).map((entry) => entry.session.id)
})())
for (const slug of PICK_ORDER) {
  const layer = LAYERS.find((item) => item.slug === slug)
  const picked = []
  for (const entry of orderEntries(layerEntries(slug))) {
    if (picked.length >= layer.quota) break
    const reusable = slug === 'obvious'
    if (!reusable && usedSessions.has(entry.session.id)) continue
    if (slug !== 'should-ask' && slug !== 'obvious' && reservedForShouldAsk.has(entry.session.id)) continue
    if (slug === 'obvious' && usedSessions.has(entry.session.id)) {
      // named-cue easy 层允许与别的层复用同一会话（层定义优先；报告中说明）
    }
    const spec = expectedFor(entry, layer)
    const reconstructed = reconstructTask(entry, spec.message, layer)
    const textForCheck = `${reconstructed.title}\n${reconstructed.goal}\n${reconstructed.rawShown}`
    const violations = leakViolations(textForCheck, entry, layer, spec.expected)
    // attach 案例额外检查：期望会话在“消息时间”口径下的标题也不得整体进入任务文本（避免标题≈首条消息造成自证）
    if (spec.expected.sessionId) {
      const titleAtMessage = titleAsOf(entry.session, spec.message.time).title
      if (titleAtMessage && titleAtMessage !== '（未命名会话）' && titleAtMessage.length >= 8 && textForCheck.toLowerCase().includes(titleAtMessage.toLowerCase())) {
        violations.push(`expected-session-title@msgtime:${titleAtMessage.slice(0, 20)}`)
      }
    }
    if (violations.length > 0) {
      skipped.push({ layer: slug, sessionId: entry.session.id, violations })
      continue
    }
    spec.reconstructed = reconstructed
    picked.push({ layer, entry, spec })
    usedSessions.add(entry.session.id)
  }
  for (const item of picked) selection.push(item)
  if (picked.length < layer.quota) shortfall.push({ layer: slug, want: layer.quota, got: picked.length })
}

// ---------------------------------------------------------------- 快照（as-of dispatchAt）
/** 会话快照：dispatchAt 前已存在、顶层、非归档、可判定工作区；new 案例排除目标会话。 */
function sessionSnapshot(entry, { message, baseMode }) {
  const dispatchAt = entry.dispatchAt
  const rows = pool
    .filter(
      (session) =>
        session.createdAt > 0 &&
        session.createdAt <= dispatchAt &&
        !(baseMode === 'new' && message.index === 0 && session.id === entry.session.id),
    )
    .sort((a, b) => lastActiveAsOf(b, dispatchAt) - lastActiveAsOf(a, dispatchAt))
  return rows.map((session) => {
    const title = titleAsOf(session, dispatchAt)
    const row = {
      id: session.id,
      workspaceId: session.workspaceId,
      title: title.title,
      lastActiveAt: iso(lastActiveAsOf(session, dispatchAt) || session.createdAt),
    }
    return row
  })
}

/** 工作区快照（as-of dispatchAt）：语义摘要（v2a）由 dispatchAt 前该工作区会话标题归纳；v2b=占位摘要。 */
function workspaceSnapshot(entry) {
  const dispatchAt = entry.dispatchAt
  return workspaces.map((ws) => {
    const sourceTitle = titleAsOf(entry.session, dispatchAt).title
    const sessions = pool
      .filter(
        (session) =>
          session.workspaceId === ws.id &&
          session.createdAt <= dispatchAt &&
          // 排除源会话本身、以及标题与源会话标题相同的会话（防 post-hoc 标题泄漏）
          session.id !== entry.session.id &&
          titleAsOf(session, dispatchAt).title !== sourceTitle,
      )
      .sort((a, b) => lastActiveAsOf(b, dispatchAt) - lastActiveAsOf(a, dispatchAt))
    const recentTasks = []
    for (const session of sessions) {
      const { title } = titleAsOf(session, dispatchAt)
      if (title !== '（未命名会话）' && !recentTasks.includes(title)) recentTasks.push(title)
      if (recentTasks.length >= 5) break
    }
    const baseName = ws.title || ws.path.split('/').filter(Boolean).pop() || ws.id
    const summary =
      SUMMARY_MODE === 'semantic'
        ? recentTasks.length > 0
          ? `${baseName}（${ws.path}）：dispatch 前历史任务如「${recentTasks.slice(0, 3).join('」「')}」`.slice(0, 120)
          : `${baseName}（${ws.path}）：dispatch 前无历史会话`
        : `路径 ${ws.path}；此刻非归档历史会话 ${sessions.length} 条；capabilityDigest 不可得（数据源无该字段）`
    return { id: ws.id, name: baseName, path: ws.path, summary, recentTasks }
  })
}

function makeCase(item, ordinal) {
  const { layer, entry, spec } = item
  const { message, expected, tags, baseMode } = spec
  const reconstructed = spec.reconstructed
  const provenance = {
    rawCommand: reconstructed.raw.length > 4000 ? `${reconstructed.raw.slice(0, 4000)}…` : reconstructed.raw,
    contextSummary: reconstructed.context,
    dispatchAt: iso(entry.dispatchAt),
    snapshotSpec: SNAPSHOT_SPEC,
    summaryMode: SUMMARY_MODE,
    sourceSessionId: entry.session.id,
    sourceWorkspaceId: entry.session.workspaceId,
    sourceSessionTitleAsOf: titleAsOf(entry.session, entry.dispatchAt).title,
    messageIndex: message.index,
    messageTime: iso(message.time),
    reconstructedBy: 'build-cases.mjs reconstructTask (raw command + pre-dispatch user/assistant context)',
    rawTruncated: reconstructed.rawTruncated,
    goalTruncated: reconstructed.goalTruncated,
  }
  const id = `v5-${String(ordinal).padStart(2, '0')}-${layer.slug}`
  const caseItem = {
    id,
    task: {
      title: reconstructed.title,
      goal: reconstructed.goal,
      acceptanceHints: [],
      priority: 'normal',
    },
    command: { text: reconstructed.rawShown },
    _provenance: provenance,
    workspaces: workspaceSnapshot(entry),
    sessions: sessionSnapshot(entry, { message, baseMode }),
    expected,
    tags,
  }
  return { caseItem, provenance, reconstructed }
}

const built = selection.map((item, index) => makeCase(item, index + 1))
const cases = built.map((item) => item.caseItem)

// 最终硬断言：任何一条泄漏都直接失败，不放过
const finalViolations = []
for (const { caseItem, provenance, reconstructed } of built) {
  const layer = LAYERS.find((item) => item.slug === caseItem.tags[0])
  const entry = sessionEntries.find((item) => item.session.id === provenance.sourceSessionId)
  if (entry === undefined) continue
  const expected = caseItem.expected
  const text = `${caseItem.task.title}\n${caseItem.task.goal}\n${(caseItem.task.acceptanceHints ?? []).join('\n')}\n${caseItem.command.text}`
  const violations = leakViolations(text, entry, layer, expected)
  if (violations.length > 0) finalViolations.push({ id: caseItem.id, violations })
}
if (finalViolations.length > 0) {
  console.error('FATAL: 标签泄漏断言失败（应换样本，不得放过）：', JSON.stringify(finalViolations, undefined, 2))
  process.exit(1)
}

const layerCounts = Object.fromEntries(LAYERS.map((layer) => [layer.slug, cases.filter((c) => c.tags[0] === layer.slug).length]))
const stats = {
  generatedAt: iso(now),
  home: HOME,
  seed: SEED,
  snapshotSpec: SNAPSHOT_SPEC,
  summaryMode: SUMMARY_MODE,
  totals: { sessionsScanned: all.size, poolSessions: pool.length, sessionEntries: sessionEntries.length, cases: cases.length },
  layerCounts,
  shortfall,
  skippedForLeak: skipped.length,
  skippedDetail: skipped.slice(0, 20),
  finalLeakAssertion: { violations: finalViolations.length, ok: finalViolations.length === 0 },
  labelQuality: {
    high: built.filter((item) => (item.caseItem.expected.note ?? '').includes('confidence=high')).length,
    medium: built.filter((item) => (item.caseItem.expected.note ?? '').includes('confidence=medium')).length,
    low: built.filter((item) => (item.caseItem.expected.note ?? '').includes('confidence=low')).length,
    needsReview: built.filter((item) => (item.caseItem.tags ?? []).includes('needs-review')).length,
  },
  selfContainment: {
    obviousCases: built.filter((item) => item.caseItem.tags[0] === 'obvious').length,
    obviousUntruncated: built.filter((item) => item.caseItem.tags[0] === 'obvious' && item.provenance.rawTruncated === false).length,
    obviousNamedCue: built.filter((item) => (item.caseItem.tags ?? []).includes('named-cue')).length,
    observationalCases: built.filter((item) => (item.caseItem.tags ?? []).includes('observational')).length,
  },
  snapshot: {
    sessionsPerCase: {
      min: Math.min(...cases.map((item) => item.sessions.length)),
      max: Math.max(...cases.map((item) => item.sessions.length)),
      mean: Math.round(cases.reduce((sum, item) => sum + item.sessions.length, 0) / cases.length),
    },
    estimatedFullRequestTokens: (() => {
      const values = cases
        .map((item) => estimateTokens(JSON.stringify({ task: item.task, command: item.command, workspaces: item.workspaces, sessions: item.sessions })))
        .sort((a, b) => a - b)
      return { mean: Math.round(values.reduce((sum, n) => sum + n, 0) / values.length), p50: values[Math.floor(values.length * 0.5)], p95: values[Math.floor(values.length * 0.95)] ?? values.at(-1), over24k: values.filter((n) => n > 24000).length }
    })(),
  },
  notes: [
    'v2：as-of-dispatch；目标消息不得进入快照；标题 only dispatchAt 前；workspaces.recentTasks only dispatchAt 前。',
    '语义摘要（v2a）为脚本 as-of 启发式（非 LLM）；v2b=占位摘要对照，用于隔离摘要质量影响。',
    'mock ≠ live；v1 方法学不成立，仅作基线。',
  ],
}

if (shortfall.length > 0) console.error('WARN: 分层配额未满足：', JSON.stringify(shortfall))
if (DIAGNOSE) {
  console.log(JSON.stringify({ totals: stats.totals, layerCounts, layerCandidatePool: Object.fromEntries(LAYERS.map((l) => [l.slug, layerEntries(l.slug).length])), shortfall, skippedForLeak: skipped.length, labelQuality: stats.labelQuality, selfContainment: stats.selfContainment, snapshot: stats.snapshot }, undefined, 2))
  process.exit(0)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
const jsonl = `${cases.map((item) => JSON.stringify(item)).join('\n')}\n`
fs.writeFileSync(OUT, jsonl)
const digest = sha256(jsonl)

const labelLines = [
  '# V5 案例逐条标注清单（v2 · as-of-dispatch，自动生成）',
  '',
  `> 生成器 \`tools/eval/build-cases.mjs\`（seed=\`${SEED}\`，summaryMode=\`${SUMMARY_MODE}\`，dispatchAt=每条消息时间；快照口径 \`${SNAPSHOT_SPEC}\`）。`,
  '> ⚠️ 本地生成、含真实用户数据；本清单不含任务正文。完整规则见 `docs/eval/labels.md`。',
  '',
  `- 案例数：${cases.length}；分层：${JSON.stringify(layerCounts)}；泄漏断言：${finalViolations.length === 0 ? 'PASS（0 命中）' : 'FAIL'}；因泄漏换样本：${skipped.length}`,
  `- 置信度：high=${stats.labelQuality.high} / medium=${stats.labelQuality.medium} / low=${stats.labelQuality.low}；需人工复核：${stats.labelQuality.needsReview}`,
  `- obvious(named-cue easy) 层：${stats.selfContainment.obviousNamedCue}/${stats.selfContainment.obviousCases} 条点名本工作区（不具判派判别力，门禁不计）；未截断 ${stats.selfContainment.obviousUntruncated}/${stats.selfContainment.obviousCases}`,
  '',
  '| id | 层 | 源会话 | dispatchAt | 期望工作区 | 期望模式 | 期望会话 | 规则 | 置信度 | 需复核 |',
  '|---|---|---|---|---|---|---|---|---|---|',
]
for (const { caseItem, provenance } of built) {
  const meta = caseItem.expected
  const wsName = meta.workspaceId ? caseItem.workspaces.find((ws) => ws.id === meta.workspaceId)?.name ?? meta.workspaceId : 'needs_confirmation'
  const mode = meta.needsConfirmation ? 'needs_confirmation' : meta.mode
  const session = meta.sessionId ? `\`${meta.sessionId}\`` : '—'
  const confidence = /confidence=(high|medium|low)/.exec(meta.note ?? '')?.[1] ?? '—'
  const needsReview = (caseItem.tags ?? []).includes('needs-review') ? '是' : '否'
  labelLines.push(
    `| ${caseItem.id} | ${caseItem.tags[0]} | \`${provenance.sourceSessionId}\` | ${provenance.dispatchAt} | ${wsName} | ${mode} | ${session} | ${(meta.note ?? '').slice(0, 160).replace(/\|/g, '/')} | ${confidence} | ${needsReview} |`,
  )
}
labelLines.push('')
fs.mkdirSync(path.dirname(LABELS_OUT), { recursive: true })
fs.writeFileSync(LABELS_OUT, labelLines.join('\n'))
const shaFile = `${OUT}.sha256`
fs.writeFileSync(shaFile, `${digest}  ${path.basename(OUT)}\n`)

console.error(`wrote ${OUT} (${cases.length} cases)`)
console.error(`wrote ${LABELS_OUT}`)
console.error(`sha256 ${digest}`)
console.log(JSON.stringify({ ...stats, sha256: digest }, undefined, 2))
