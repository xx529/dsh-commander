#!/usr/bin/env node
/**
 * V5 v1 案例标签独立审计（tester；只读 ~/.dsh 与冻结输入，不改 docs/eval）。
 *
 * 背景（证据链缺陷，必读）：backend 于 2026-11-17T16:52 在审计进行中**就地覆盖**了
 * docs/eval/cases.real.jsonl / labels.cases.md / tools/eval/build-cases.mjs（v1→v2）。
 * v1 案例快照已不可从磁盘获得；本脚本改为对冻结输入
 * `tests/v5-audit/fixtures/v1-frozen.json`（16:51 冻结：v1 标签表 + 任务文本前 90 字符
 * 指纹）＋ `~/.dsh` 原始会话日志复核 v1 标签。逐字快照复核标记为「不可得」，见文档 §限制。
 *
 * 抽样（与 task-9 一致）：全部 should-ask(5) + 全部 obvious(12) + 其余 4 层各前 N 条(默认 2)
 *   = 25 条；另对全部 50 条做 A1 指纹 + A2 cwd + A3 推导复核（报告 50/50）。
 *
 * 维度：
 *   A1 任务文本 = 源会话第 messageIndex 条真实用户消息（前 20 字符指纹；全文不可得）
 *   A2 expected 工作区 = 消息时 header.cwd 精确匹配的 workspace.json 工作区
 *   A3 expected.mode/sessionId = 回放规则（首条用户消息→new；否则 attach 本会话）
 *   A4 快照包含 expected（按 v1 生成器代码可证；具体快照文本因覆盖不可复核 → CODE）
 *   E1 任务文本强泄漏 expected 工作区全名/标题/sessionId/summary
 *   E1hint 任务文本含 v1 选样 token（说明“靠语义提示可猜”）
 *   E2 会话标题由被测文本派生（post-hoc 泄漏机制；v1 快照具体文本不可得 → 机制实证）
 *
 * 用法：
 *   node tests/v5-audit/audit.mjs                 # v1 冻结输入审计
 *   node tests/v5-audit/audit.mjs --per-other-layer 3
 *   node tests/v5-audit/audit.mjs --json-only     # 只写 audit-result.json
 * 输出：终端表格 + tests/v5-audit/audit-result.json
 * 退出码：0=执行成功（裁定写入 JSON）；1=输入缺失/解析失败。
 * 隐私：只打印短证据片段（≤40 字），不含完整任务正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readSessionLog, userMessageText } from '../../tools/eval/lib/session-log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const HOME = argOf('--home', process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const FROZEN = argOf('--frozen', path.join(HERE, 'fixtures/v1-frozen.json'))
const V1_CASES = argOf('--v1-cases', path.join(ROOT, 'docs/eval/frozen/cases.real.v1.jsonl'))
const PER_OTHER = Number(argOf('--per-other-layer', '2'))
const JSON_ONLY = argv.includes('--json-only')
const RESULT_FILE = argOf('--result', path.join(HERE, 'audit-result.json'))
const DAY = 24 * 60 * 60 * 1000
const normSessionId = (id) => (String(id).startsWith('session-') ? String(id) : `session-${id}`)
const snippet = (text, max = 40) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

if (!fs.existsSync(FROZEN)) {
  console.error(`missing frozen input: ${FROZEN}`)
  process.exit(1)
}
const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8'))
const labels = frozen.labels ?? []
const snippets = frozen.taskSnippets ?? {}
/** v1 案例原样备份（backend 于 2026-11-17T17:09 补交，sha256 3c588014…；审计随后升级为逐字实证）。 */
const v1Cases = fs.existsSync(V1_CASES)
  ? fs.readFileSync(V1_CASES, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  : []
const v1CasesById = new Map(v1Cases.map((caseItem) => [caseItem.id, caseItem]))

// ---------------------------------------------------------------- 数据源（只读）
const workspaceStore = JSON.parse(fs.readFileSync(path.join(HOME, 'storages', 'workspace.json'), 'utf8'))
const workspaces = Object.entries(workspaceStore?.tables?.workspaces ?? {}).map(([id, row]) => ({
  id,
  path: String(row?.path ?? ''),
  title: String(row?.title ?? ''),
}))
const wsByPath = new Map(workspaces.map((ws) => [ws.path.replace(/\/+$/, ''), ws]))
const wsByName = new Map(workspaces.map((ws) => [ws.title || ws.path.split('/').filter(Boolean).pop(), ws]))
const archived = new Set((workspaceStore?.global?.archivedSessionIds ?? []).map(normSessionId))

/** 会话目录索引（basename 的两种形态 → 目录）。 */
function indexSessionDirs(root) {
  const dirs = new Map()
  const isDir = (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  if (!fs.existsSync(root)) return dirs
  for (const parent of fs.readdirSync(root).filter((n) => isDir(path.join(root, n)))) {
    for (const name of fs.readdirSync(path.join(root, parent)).filter((n) => isDir(path.join(root, parent, n)))) {
      const full = path.join(root, parent, name)
      dirs.set(name, full)
      dirs.set(normSessionId(name.startsWith('session-') ? name.slice(8) : name), full)
    }
  }
  return dirs
}
const sessionDirs = indexSessionDirs(path.join(HOME, 'sessions'))

function loadSession(sessionId) {
  const dir = sessionDirs.get(normSessionId(sessionId))
  if (dir === undefined) return undefined
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^session\..*\.jsonl(\.zstd)?$/.test(name))
    .sort()
  if (files.length === 0) return undefined
  const events = readSessionLog(path.join(dir, files.at(-1)))
  const header = events.find((event) => event.type === 'session')
  const userMessages = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    if (event?.data?.source?.kind !== 'user') continue
    const text = userMessageText(event)
    if (text.length > 0) userMessages.push({ time: Number(event.time), text })
  }
  const times = events.map((event) => Number(event.time)).filter(Number.isFinite)
  const titleEvent = events.find((event) => event.type === 'session/title')
  return {
    dir,
    header,
    userMessages,
    lastActivity: times.length > 0 ? Math.max(...times) : 0,
    titleEventText: typeof titleEvent?.data?.title === 'string' ? titleEvent.data.title : null,
  }
}

// ---------------------------------------------------------------- 选样（按 v1 层顺序）
const LAYER_ORDER = ['should-ask', 'obvious', 'old-session', 'new-session', 'capability', 'ambiguous']
const byLayer = new Map()
for (const row of labels) byLayer.set(row.layer, [...(byLayer.get(row.layer) ?? []), row])
const sample = []
for (const layer of LAYER_ORDER) {
  const list = byLayer.get(layer) ?? []
  sample.push(...(layer === 'should-ask' || layer === 'obvious' ? list : list.slice(0, PER_OTHER)))
}
const sampleIds = new Set(sample.map((row) => row.id))

// ---------------------------------------------------------------- v1 选样 token（复刻 v1 build-cases.mjs 的 wsKeys）
const GENERIC_TOKENS = new Set(['test', 'workspace', 'project', 'agent', 'github', 'documents', 'app', 'dev', 'probe'])
const wsKeys = new Map()
for (const ws of workspaces) {
  const base = ws.path.split('/').filter(Boolean).pop() ?? ''
  const keys = new Set()
  for (const raw of [base, ws.title]) {
    const key = String(raw).toLowerCase().trim()
    if (key.length >= 4 && !GENERIC_TOKENS.has(key)) keys.add(key)
    for (const part of key.split(/[-_.\s]+/)) if (part.length >= 5 && !GENERIC_TOKENS.has(part)) keys.add(part)
  }
  wsKeys.set(ws.title || ws.path.split('/').filter(Boolean).pop(), [...keys])
}

const dispatchTime = Date.parse('2026-11-17T08:46:50.014Z') // v1 labels.cases.md 记录值
const escapeNewlines = (text) => String(text).replace(/\n/g, '\\n')
const flatten = (text) => String(text).replace(/\s+/g, ' ').trim()
const titleDerivedFromMessage = (title, message) => {
  if (title === null || title.length < 6) return false
  const t = flatten(title)
  const m = flatten(message)
  return m.includes(t) || t.startsWith(m.slice(0, 12))
}

// ---------------------------------------------------------------- 逐条复核（全部 50 条）
const allResults = []
for (const row of labels) {
  const raw = loadSession(row.sourceSessionId)
  const snippetText = snippets[row.id] ?? ''
  const checks = {}
  const evidence = []

  // A1 归属：消息序存在 + 前 20 字符指纹一致（v1 案例全文不可得）
  if (raw === undefined) {
    checks.A1 = 'FAIL'
    evidence.push('A1 源会话日志不可解析')
  } else {
    const message = raw.userMessages[row.messageIndex]
    const caseItem = v1CasesById.get(row.id)
    if (caseItem !== undefined) {
      const caseText = String(caseItem.command?.text ?? '')
      const exact = message !== undefined && message.text === caseText
      const truncated = message !== undefined && caseText.endsWith('…') && message.text.startsWith(caseText.slice(0, -1))
      checks.A1 = exact || truncated ? 'PASS' : 'FAIL'
      evidence.push(`A1 逐字：原始日志第 ${row.messageIndex} 条用户消息（共 ${raw.userMessages.length} 条）与 v1 cases 文本${exact ? '完全一致' : truncated ? '截断前缀一致' : '不一致'}`)
    } else {
      const normalized = escapeNewlines(String(message?.text ?? ''))
      const fingerprintMatch = message !== undefined && normalized.slice(0, 20) === snippetText.slice(0, 20)
      checks.A1 = fingerprintMatch ? 'PASS' : 'FAIL'
      evidence.push(`A1 原始日志第 ${row.messageIndex} 条用户消息（共 ${raw.userMessages.length} 条）前 20 字符指纹${fingerprintMatch ? '一致' : '不一致'}`)
    }
  }

  // A2 工作区：cwd 精确映射后名称匹配 v1 labels
  if (raw !== undefined) {
    const cwd = String(raw.header?.cwd ?? '')
    const byCwd = wsByPath.get(cwd.replace(/\/+$/, ''))
    const name = byCwd?.title || byCwd?.path.split('/').filter(Boolean).pop()
    checks.A2 = name === row.workspaceName ? 'PASS' : 'FAIL'
    evidence.push(`A2 header.cwd=${cwd} → 工作区「${name ?? '未匹配'}」，v1 标签「${row.workspaceName}」`)
  } else {
    checks.A2 = 'FAIL'
  }

  // A3 模式/会话推导
  const derivedMode = row.messageIndex === 0 ? 'new' : 'attach'
  const derivedSession = derivedMode === 'attach' ? normSessionId(row.sourceSessionId) : null
  const sessionListed = derivedSession === null ? row.expectedSessionId == null : normSessionId(row.expectedSessionId ?? '') === derivedSession
  checks.A3 = row.mode === derivedMode && sessionListed ? 'PASS' : 'FAIL'
  evidence.push(`A3 messageIndex=${row.messageIndex} ⇒ ${derivedMode}；v1 mode=${row.mode}，expectedSessionId=${row.expectedSessionId ? `…${String(row.expectedSessionId).slice(-8)}` : '—'}`)
  const normalizedExpectedSession = row.expectedSessionId ? normSessionId(row.expectedSessionId) : null

  // A4 快照包含 expected：v1 备份可读时做实证；否则退回代码可证（CODE）
  const caseItem = v1CasesById.get(row.id)
  if (raw !== undefined && caseItem !== undefined) {
    const expectedWsId = caseItem.expected?.workspaceId
    const wsPresent = (caseItem.workspaces ?? []).some((w) => w.id === expectedWsId)
    const sessions = caseItem.sessions ?? []
    const attachPresent = caseItem.expected?.mode === 'attach' && sessions.some((s) => s.id === normalizedExpectedSession)
    const sourceExcluded = !sessions.some((s) => s.id === normSessionId(row.sourceSessionId))
    const sessionWsCoherent = sessions.every((s) => (caseItem.workspaces ?? []).some((w) => w.id === s.workspaceId))
    checks.A4 = wsPresent && sessionWsCoherent && (caseItem.expected?.mode === 'attach' ? attachPresent : sourceExcluded) ? 'PASS' : 'FAIL'
    evidence.push(`A4 实证：expected 工作区在快照=${wsPresent}，sessions 工作区自洽=${sessionWsCoherent}，${caseItem.expected?.mode === 'attach' ? `期望会话在快照=${attachPresent}` : `源会话已排除=${sourceExcluded}`}`)
  } else if (raw !== undefined) {
    const sourceIsTopLevel = typeof raw.header?.parentSession !== 'string'
    const sourceArchived = archived.has(normSessionId(row.sourceSessionId))
    const wsExists = wsByName.has(row.workspaceName)
    checks.A4 = sourceIsTopLevel && !sourceArchived && wsExists ? 'CODE' : 'FAIL'
    evidence.push(`A4 代码可证：源会话顶层=${sourceIsTopLevel}、归档=${sourceArchived}、工作区在 28 个 allowed 内=${wsExists}`)
  } else {
    checks.A4 = 'FAIL'
  }

  // E1 强泄漏 / E1hint：有 v1 cases 时按全文，否则按前 90 字符指纹（保守）
  const taskFullText = caseItem !== undefined ? String(caseItem.command?.text ?? '') : snippetText
  const ws = wsByName.get(row.workspaceName)
  const wsBase = ws?.path.split('/').filter(Boolean).pop() ?? ''
  const strongHits = []
  for (const name of [...new Set([wsBase, ws?.title, row.workspaceName].filter((name) => typeof name === 'string' && name.length >= 4))]) {
    if (taskFullText.toLowerCase().includes(name.toLowerCase())) strongHits.push(`工作区名「${name}」`)
  }
  if (row.expectedSessionId && taskFullText.includes(row.expectedSessionId)) strongHits.push('expected.sessionId')
  const hintHits = (wsKeys.get(row.workspaceName) ?? []).filter((token) => taskFullText.toLowerCase().includes(token))
  checks.E1 = strongHits.length === 0 ? 'PASS' : 'FAIL'
  checks.E1hint = hintHits.length === 0 ? 'PASS' : 'WARN'
  if (strongHits.length > 0) evidence.push(`E1 强泄漏：任务文本含 ${strongHits.join('、')}`)
  if (hintHits.length > 0) evidence.push(`E1hint 任务文本含 v1 选样 token：${hintHits.join('、')}`)

  // E2 post-hoc 标题泄漏（有 v1 备份时按真实快照实证，否则按日志标题机制推断）
  let oracleLeak = false
  const testedText = caseItem !== undefined ? taskFullText : raw?.userMessages[row.messageIndex]?.text ?? ''
  const expectedWsSnapshot = caseItem?.workspaces?.find((workspace) => workspace.id === caseItem.expected?.workspaceId)
  const expectedWsExposedTitle = (expectedWsSnapshot?.recentTasks ?? []).find((title) => titleDerivedFromMessage(title, testedText))
  const sessionExposed = (caseItem?.sessions ?? []).find((session) => titleDerivedFromMessage(session.title, testedText))
  if (expectedWsExposedTitle !== undefined || sessionExposed !== undefined) {
    oracleLeak = true
    const where =
      sessionExposed !== undefined
        ? sessionExposed.id === normalizedExpectedSession
          ? 'oracle：期望会话标题=被测文本截断'
          : 'sessions 其他会话标题=被测文本截断'
        : '期望工作区 recentTasks=被测文本截断'
    evidence.push(`E2 实证：v1 快照暴露被测文本派生标题「${snippet(sessionExposed?.title ?? expectedWsExposedTitle, 24)}」（${where}）`)
  }
  if (raw !== undefined) {
    const first = raw.userMessages[0]?.text ?? ''
    const titleDerived = titleDerivedFromMessage(raw.titleEventText, first)
    if (row.messageIndex === 0 && titleDerived && !oracleLeak) {
      oracleLeak = true
      evidence.push(`E2 机制：被测任务=首条消息 ⇒ 终态标题「${snippet(raw.titleEventText, 24)}」即被测文本截断`)
    } else if (titleDerived && !oracleLeak) {
      evidence.push('E2 机制：标题来自首条用户消息（早于被测消息，非 oracle 泄漏）')
    }
  }
  // S9：new 案例源会话已排除出 sessions，但其标题仍在期望工作区 recentTasks（快照自相矛盾）
  let snapshotSelfContradiction = false
  if (caseItem !== undefined && caseItem.expected?.mode === 'new' && expectedWsSnapshot !== undefined && raw?.titleEventText) {
    const sourceTitle = flatten(raw.titleEventText)
    const recentHasSourceTitle = (expectedWsSnapshot.recentTasks ?? []).some((title) => flatten(title) === sourceTitle)
    if (recentHasSourceTitle) {
      snapshotSelfContradiction = true
      evidence.push(`S9 快照自相矛盾：源会话已排除出 sessions，但期望工作区 recentTasks 仍含其标题「${snippet(raw.titleEventText, 24)}」`)
    }
  }
  checks.E2 = oracleLeak ? 'WARN' : 'PASS'
  checks.S9 = snapshotSelfContradiction ? 'WARN' : 'PASS'

  // 附加统计：gapDays 与当前日志 lastActivity 的一致性（可能因会话后续追加而漂移 → WARN）
  let gapRecomputed = null
  if (raw !== undefined && raw.lastActivity > 0 && Number.isFinite(dispatchTime)) {
    gapRecomputed = (dispatchTime - raw.lastActivity) / DAY
  }
  allResults.push({
    id: row.id,
    layer: row.layer,
    sampled: sampleIds.has(row.id),
    checks,
    evidence,
    strongLeak: strongHits.length > 0,
    hint: hintHits.length > 0,
    titleDerived: oracleLeak,
    snapshotSelfContradiction,
    gapDays: row.gapDays,
    gapRecomputed: gapRecomputed === null ? null : Number(gapRecomputed.toFixed(2)),
    taskSnippet: snippet(snippetText, 28),
  })
}

// ---------------------------------------------------------------- 分层偏差与噪声率（抽样 25）
const sampleResults = allResults.filter((r) => r.sampled)
const hardFail = sampleResults.filter((r) => ['A1', 'A2', 'A3', 'A4'].some((k) => r.checks[k] === 'FAIL'))
const strongLeaks = sampleResults.filter((r) => r.strongLeak)
const hintOnly = sampleResults.filter((r) => r.hint && !r.strongLeak)
const titleDerived = sampleResults.filter((r) => r.titleDerived)
const layerStats = {}
for (const layer of LAYER_ORDER) {
  const list = sampleResults.filter((r) => r.layer === layer)
  layerStats[layer] = {
    sampled: list.length,
    hardFail: list.filter((r) => ['A1', 'A2', 'A3', 'A4'].some((k) => r.checks[k] === 'FAIL')).length,
    strongLeak: list.filter((r) => r.strongLeak).length,
    hintOnly: list.filter((r) => r.hint && !r.strongLeak).length,
    titleDerived: list.filter((r) => r.titleDerived).length,
  }
}

// ---------------------------------------------------------------- v1 标签表内部一致性（自行闭合）
const consistency = []
const add = (id, ok, detail, verdict) => consistency.push({ id, ok, detail, verdict: verdict ?? 'PASS' })
const countBy = (key) => labels.reduce((acc, row) => ({ ...acc, [row[key]]: (acc[row[key]] ?? 0) + 1 }), {})
const layerCounts = countBy('layer')
const modeCounts = countBy('mode')
const confCounts = countBy('confidence')
add('C1 案例数=50', labels.length === 50, `labels=${labels.length}`)
add('C2 分层 12/12/10/6/5/5', ['obvious', 'ambiguous', 'old-session', 'new-session', 'capability', 'should-ask'].every((l) => layerCounts[l] === ({ obvious: 12, ambiguous: 12, 'old-session': 10, 'new-session': 6, capability: 5, 'should-ask': 5 })[l]), JSON.stringify(layerCounts))
add('C3 new=25/attach=25', modeCounts.new === 25 && modeCounts.attach === 25, JSON.stringify(modeCounts))
add('C4 覆盖 15 个工作区', new Set(labels.map((r) => r.workspaceName)).size === 15, `distinct=${new Set(labels.map((r) => r.workspaceName)).size}`)
add('C5 置信度 high=12/medium=22/low=16', confCounts.high === 12 && confCounts.medium === 22 && confCounts.low === 16, JSON.stringify(confCounts))
add('C6 needsReview=38', labels.filter((r) => r.needsReview).length === 38, `needsReview=${labels.filter((r) => r.needsReview).length}`)
add('C7 层内高置信仅 obvious', labels.filter((r) => r.confidence === 'high').every((r) => r.layer === 'obvious'), `非 obvious 高置信=${labels.filter((r) => r.confidence === 'high' && r.layer !== 'obvious').length}`)
// C13：v1 labels 表 vs v1 cases 备份逐条一致（工作区名/mode/期望会话）
const labelCaseMismatches = []
const wsNameOf = (caseItem, workspaceId) => caseItem?.workspaces?.find((workspace) => workspace.id === workspaceId)?.name
for (const row of labels) {
  const caseItem = v1CasesById.get(row.id)
  if (caseItem === undefined) {
    labelCaseMismatches.push(`${row.id}: v1 cases 缺失`)
    continue
  }
  const expected = caseItem.expected ?? {}
  const expectedWsName = wsNameOf(caseItem, expected.workspaceId)
  if (expectedWsName !== row.workspaceName) labelCaseMismatches.push(`${row.id}: 工作区名 labels=${row.workspaceName} cases=${expectedWsName}`)
  if (expected.mode !== row.mode) labelCaseMismatches.push(`${row.id}: mode labels=${row.mode} cases=${expected.mode}`)
  const expectedSessionId = expected.sessionId ?? null
  if (expectedSessionId !== row.expectedSessionId) labelCaseMismatches.push(`${row.id}: expectedSessionId labels=${row.expectedSessionId} cases=${expectedSessionId}`)
}
add('C13 v1 labels 表与 v1 cases 备份逐条一致', v1Cases.length === 0 || labelCaseMismatches.length === 0, v1Cases.length === 0 ? 'v1 cases 备份不可得（仅标签表审计）' : labelCaseMismatches.slice(0, 3).join('；') || `${v1Cases.length}/${labels.length} 条一致`)

// C14：v1 快照工作区 summary 为占位模板（实证）
const placeholderSummaryCount = v1Cases.filter((caseItem) => (caseItem.workspaces ?? []).some((workspace) => workspace.summary.includes('capabilityDigest 不可得'))).length
add('C14 v1 快照工作区 summary 非占位', v1Cases.length === 0 || placeholderSummaryCount === 0, v1Cases.length === 0 ? 'v1 cases 备份不可得' : `${placeholderSummaryCount}/${v1Cases.length} 条案例仍含占位 summary`, v1Cases.length > 0 && placeholderSummaryCount > 0 ? 'DEFECT' : 'PASS')

add(
  'C8 should-ask 表示自相矛盾（R1）',
  false,
  `${labels.filter((r) => r.layer === 'should-ask' && r.mode && r.workspaceName).length}/5 条 should-ask 仍带 expected 工作区+new/attach；规则文本期望 needs_confirmation，schema 无该表示`,
  'DEFECT',
)
add(
  'C9 全部 50 条 A1 指纹匹配',
  allResults.every((r) => r.checks.A1 === 'PASS'),
  `${allResults.filter((r) => r.checks.A1 === 'PASS').length}/50`,
)
add(
  'C10 全部 50 条 A2 cwd 映射匹配',
  allResults.every((r) => r.checks.A2 === 'PASS'),
  `${allResults.filter((r) => r.checks.A2 === 'PASS').length}/50`,
)
add(
  'C11 全部 50 条 A3 模式推导匹配',
  allResults.every((r) => r.checks.A3 === 'PASS'),
  `${allResults.filter((r) => r.checks.A3 === 'PASS').length}/50`,
)
const gapMismatch = allResults.filter((r) => r.gapRecomputed !== null && Math.abs(r.gapRecomputed - r.gapDays) > 0.05)
add('C12 gapDays 可复算（±0.05 天；会话后续追加可致漂移）', gapMismatch.length <= 5, `偏差>0.05 天=${gapMismatch.length} 条${gapMismatch.length > 0 ? `（${gapMismatch.slice(0, 3).map((r) => r.id).join('/')}）` : ''}`, gapMismatch.length > 5 ? 'DEFECT' : 'PASS')

// ---------------------------------------------------------------- v1 生成器规则 vs labels.md 文本（代码审查证据，冻结于读取记录）
const sourceChecks = [
  { id: 'S1 选样按 sha1(seed+sessionId) 排序（无随机数）', ok: true, detail: 'v1 build-cases.mjs: orderEntries 用 sha1(`${SEED}:${sessionId}`) 排序；同 seed+同候选池确定' },
  { id: 'S2 工作区标签来自 cwd 精确映射（不用词面匹配造标签）', ok: true, detail: 'v1 expected.workspaceId = wsByPath.get(header.cwd)；workspaceMentions 仅用于分层选样' },
  { id: 'S3 模式标签来自消息序（首条→new；非首条→attach）', ok: true, detail: 'v1 labelFor: message.index===0 ? new : attach；attach 时 expected.sessionId=源会话' },
  { id: 'S4 「最近会话」先验未进入 expected', ok: true, detail: 'recencyTrap 仅用于 old-session 层的候选筛选（要求存在更新的其它工作区会话），不参与 expected 生成' },
  { id: 'S5 labels.md §3「明显工作区：文本点名本工作区名称」与实现一致', ok: false, detail: '实现是「文本含工作区 path basename/title 的分词 token（≥5 字符，排除通用词）」，非全名；v5-40/41/42/50 文本为 order-center 却期望 htdot-order-demand-skill 即例证 → 文档措辞夸大，行为未偏离', verdict: 'DEFECT' },
  { id: 'S6 dispatchTime=生成时刻 → 快照随时间漂移', ok: false, detail: 'v1/v2 均以 Date.now() 为 dispatchTime；重跑会有池漂移。案例集不可仅凭 seed 复现，必须冻结文件（Lead 已采纳冻结规则）', verdict: 'DEFECT' },
  { id: 'S7 should-ask 的 expected 表示缺陷已文档化', ok: true, detail: 'labels.md §5.4 承认 schema 只有 new|attach，用 tag 表达 needs_confirmation；但 expected.workspaceId/mode 仍被写入 cases（harness 需靠 tag 兜底）' },
  { id: 'S8 v1 工作区 summary 为固定占位模板（非真实职责摘要）', ok: false, detail: 'v1 workspaceSnapshot().summary = `路径 …；此刻非归档历史会话 N 条；capabilityDigest 不可得`（硬编码模板，非数据源字段）→ 派发输入信息量与真实 Commander 差距大，live 指标不可外推', verdict: 'DEFECT' },
  { id: 'S9 new 案例快照自相矛盾：源会话排除出 sessions 但标题保留在 recentTasks', ok: false, detail: 'v1 sessionSnapshot({excludeSource: mode===new && index===0}) 排除源会话；workspaceSnapshot().recentTasks 仍取全部 pool 会话标题（含源会话）→ 快照一边说“无此会话”，一边在期望工作区 recentTasks 暴露被测任务标题', verdict: 'DEFECT' },
]
const sourceDefects = sourceChecks.filter((s) => s.ok === false).length

// ---------------------------------------------------------------- 裁定
// 标签硬事实（A1–A3）0 噪声；A4 代码可证。FAIL 的依据是公平性/表示/证据链，不是标签事实。
const labelNoiseRate = sampleResults.length > 0 ? hardFail.length / sampleResults.length : 0
const leakRate = sampleResults.length > 0 ? (strongLeaks.length + titleDerived.length) / sampleResults.length : 0
const verdict = 'FAIL'
const verdictReasons = [
  `标签硬事实层 A1–A3：${sampleResults.filter((r) => ['A1', 'A2', 'A3'].every((k) => r.checks[k] === 'PASS')).length}/${sampleResults.length} 成立（噪声率 ${(labelNoiseRate * 100).toFixed(1)}%）→ v1 标签本身不是“随机错标”`,
  `公平性：明显工作区层 ${layerStats.obvious.strongLeak}/12 任务文本含期望工作区全名、${layerStats.obvious.hintOnly}/12 含选样 token → 该层自证，不测派发`,
  `E2：${titleDerived.length}/${sampleResults.length} 抽样案例（被测消息=首条消息）的会话终态标题=被测文本截断，且 v1 recentTasks 直接引用该标题 → post-hoc 泄漏`,
  'should-ask：5/5 条带 expected.workspaceId+mode，与「期望 needs_confirmation」自相矛盾（R1）',
  '证据链：v1 cases.real.jsonl 在审计期间被 v2 就地覆盖 → 逐字快照复核不可得（A4/E2 具体快照无法实证）',
  'v1 快照工作区 summary 为占位文本（不含职责信息），输入信息量与真实 Commander 差距大，live 指标不可外推',
]

const report = {
  generatedAt: new Date().toISOString(),
  role: 'tester（独立复核）',
  input: {
    frozen: path.relative(ROOT, FROZEN),
    frozenProvenance: frozen.provenance,
    home: HOME,
    v1DispatchTime: '2026-11-17T08:46:50.014Z',
    v1CasesBackup: fs.existsSync(V1_CASES) ? path.relative(ROOT, V1_CASES) : null,
    v1CasesSha256: fs.existsSync(V1_CASES) ? crypto.createHash('sha256').update(fs.readFileSync(V1_CASES)).digest('hex') : null,
    v1CasesCount: v1Cases.length,
  },
  sample: { total: sampleResults.length, rule: '全部 should-ask+obvious；其余层各前 N 条', perOtherLayer: PER_OTHER, ids: sampleResults.map((r) => r.id) },
  allCases: {
    total: labels.length,
    a1Pass: allResults.filter((r) => r.checks.A1 === 'PASS').length,
    a2Pass: allResults.filter((r) => r.checks.A2 === 'PASS').length,
    a3Pass: allResults.filter((r) => r.checks.A3 === 'PASS').length,
    a4Pass: allResults.filter((r) => r.checks.A4 === 'PASS').length,
    a4Code: allResults.filter((r) => r.checks.A4 === 'CODE').length,
    s9Count: allResults.filter((r) => r.snapshotSelfContradiction).length,
  },
  dimensionPass: {
    A1: sampleResults.filter((r) => r.checks.A1 === 'PASS').length,
    A2: sampleResults.filter((r) => r.checks.A2 === 'PASS').length,
    A3: sampleResults.filter((r) => r.checks.A3 === 'PASS').length,
    A4: sampleResults.filter((r) => ['PASS', 'CODE'].includes(r.checks.A4)).length,
    E1: sampleResults.filter((r) => r.checks.E1 === 'PASS').length,
  },
  rates: { labelNoiseRate, strongLeakCases: strongLeaks.length, hintOnlyCases: hintOnly.length, titleDerivedCases: titleDerived.length, sampleCount: sampleResults.length },
  layerStats,
  consistency,
  sourceChecks,
  verdict,
  verdictReasons,
  results: allResults,
}
fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true })
fs.writeFileSync(RESULT_FILE, `${JSON.stringify(report, undefined, 2)}\n`)

if (!JSON_ONLY) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`
  console.log('==== V5 v1 案例标签独立审计（tester；冻结输入 v1-frozen.json + 原始会话日志）====')
  console.log(`冻结输入：${report.input.frozen}（冻结于 ${frozen.provenance.frozenAt}；v1 dispatchTime=${report.input.v1DispatchTime}）`)
  console.log(`数据源：${HOME}（只读）`)
  console.log(`v1 备份：${report.input.v1CasesBackup ?? '不可得'}（${report.input.v1CasesCount} 条，sha256 ${String(report.input.v1CasesSha256 ?? '').slice(0, 16)}…）`)
  console.log(`全部案例复核：A1=${report.allCases.a1Pass}/50 A2=${report.allCases.a2Pass}/50 A3=${report.allCases.a3Pass}/50 A4(实证)=${report.allCases.a4Pass}/50 A4(CODE)=${report.allCases.a4Code}/50 S9=${report.allCases.s9Count}/50`)
  console.log(`抽样：${sampleResults.length} 条（${Object.entries(layerStats).map(([k, v]) => `${k}=${v.sampled}`).join(' / ')}）`)
  console.log('')
  console.log('抽样维度：')
  console.log(`  A1 文本归属 ${report.dimensionPass.A1}/${sampleResults.length}；A2 工作区 ${report.dimensionPass.A2}/${sampleResults.length}；A3 模式 ${report.dimensionPass.A3}/${sampleResults.length}；A4 快照含 expected（CODE 可证）${report.dimensionPass.A4}/${sampleResults.length}；E1 无强泄漏 ${report.dimensionPass.E1}/${sampleResults.length}`)
  console.log('')
  console.log(`标签硬噪声率（A1–A4 不成立 / 抽样）：${pct(labelNoiseRate)}（${hardFail.length}/${sampleResults.length}）`)
  console.log(`公平性缺陷：强泄漏 ${strongLeaks.length}/${sampleResults.length}；仅选样提示 ${hintOnly.length}/${sampleResults.length}；派生标题 ${titleDerived.length}/${sampleResults.length}`)
  console.log('')
  console.log('| id | 层 | A1 | A2 | A3 | A4 | E1 | E2 | 证据（节选） |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const r of sampleResults) {
    console.log(`| ${r.id} | ${r.layer} | ${r.checks.A1} | ${r.checks.A2} | ${r.checks.A3} | ${r.checks.A4} | ${r.checks.E1} | ${r.checks.E2} | ${r.strongLeak ? 'E1 强泄漏' : r.hint ? 'E1hint' : ''}${r.titleDerived ? ' E2 派生标题' : ''} |`)
  }
  console.log('')
  console.log('分层偏差（抽样）：')
  for (const [layer, stat] of Object.entries(layerStats)) {
    console.log(`  ${layer}: sampled=${stat.sampled} hardFail=${stat.hardFail} strongLeak=${stat.strongLeak} hintOnly=${stat.hintOnly} titleDerived=${stat.titleDerived}`)
  }
  console.log('')
  console.log('一致性/规则核对：')
  for (const c of [...consistency, ...sourceChecks]) console.log(`  ${c.ok ? 'PASS' : 'DEFECT'} ${c.id} —— ${c.detail}`)
  console.log('')
  console.log('问题案例（强泄漏/派生标题）：')
  for (const r of sampleResults.filter((x) => x.strongLeak || x.titleDerived)) {
    console.log(`  ${r.id} [${r.layer}] ${r.evidence.filter((e) => /E1 强泄漏|E2/.test(e)).join('；')}`)
  }
  console.log('')
  console.log(`裁定：${verdict}（v1 标签不可作为门禁依据）`)
  console.log('理由：')
  for (const reason of verdictReasons) console.log(`  - ${reason}`)
  console.log('')
  console.log(`结果 JSON：${path.relative(ROOT, RESULT_FILE)}`)
}
process.exit(0)
