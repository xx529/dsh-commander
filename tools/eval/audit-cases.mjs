#!/usr/bin/env node
/**
 * V5 v2 案例输入完整性自动审计（A1–A12）。live 前置门禁：violations 必须为 0。
 *
 * 用法：
 *   node tools/eval/audit-cases.mjs [--cases docs/eval/frozen/cases.real.v2.jsonl]
 *       [--expect-sha256 <sha>] [--out docs/validation/v5-audit-cases.json]
 * 退出码：0=全部通过；1=有 violation；2=输入/校验自身错误。
 *
 * 注意：本脚本**只读**案例文件；冻结由 freeze 步骤完成（见 docs/eval/frozen/manifest.v2.json）。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const flagOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const casesFile = flagOf('--cases', 'docs/eval/frozen/cases.real.v2.jsonl')
const outFile = flagOf('--out', 'docs/validation/v5-audit-cases.json')
const expectSha = flagOf('--expect-sha256', null)
if (!fs.existsSync(casesFile)) {
  console.error(`missing cases file: ${casesFile}`)
  process.exit(2)
}
const raw = fs.readFileSync(casesFile, 'utf8')
const caseSha256 = crypto.createHash('sha256').update(raw).digest('hex')
if (expectSha !== null && expectSha !== caseSha256) {
  console.error(`sha256 mismatch: expected ${expectSha}, actual ${caseSha256}`)
  process.exit(1)
}
const cases = raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
const violations = []
const warnings = []
const push = (check, caseId, detail) => violations.push({ check, caseId, detail })
const warn = (check, caseId, detail) => warnings.push({ check, caseId, detail })

const SHA = crypto.createHash('sha256')
const generatorRev = (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync('tools/eval/build-cases.mjs')).digest('hex').slice(0, 16)
  } catch {
    return null
  }
})()
const dispatchTimes = cases.map((item) => item._provenance?.dispatchAt).filter(Boolean).sort()
const summaryMode = cases[0]?._provenance?.summaryMode ?? null
const seed = null // seed 不在 case 行内，由 manifest 记录

// A1 结构完整性
const requiredTop = ['id', 'task', 'workspaces', 'sessions', 'expected']
for (const [index, caseItem] of cases.entries()) {
  for (const key of requiredTop) if (!(key in caseItem)) push('A1-required', caseItem.id ?? `#${index}`, `missing ${key}`)
  if (!caseItem.id || !/^v5-\d{2}-/.test(caseItem.id)) push('A1-id', caseItem.id ?? `#${index}`, 'id 格式不符 v5-NN-layer')
  if (typeof caseItem.task?.title !== 'string' || caseItem.task.title.length === 0) push('A1-task-title', caseItem.id, '缺 task.title')
  if (typeof caseItem.task?.goal !== 'string' || caseItem.task.goal.length < 10) push('A1-task-goal', caseItem.id, 'task.goal 过短')
  if (!Array.isArray(caseItem.task?.acceptanceHints)) push('A1-acceptanceHints', caseItem.id, 'acceptanceHints 非数组')
  if (!Array.isArray(caseItem.workspaces) || caseItem.workspaces.length < 1) push('A1-workspaces', caseItem.id, 'workspaces 为空')
  if (!Array.isArray(caseItem.sessions)) push('A1-sessions', caseItem.id, 'sessions 非数组')
  if (!caseItem._provenance?.dispatchAt) push('A1-dispatchAt', caseItem.id, '缺 _provenance.dispatchAt')
  if (!caseItem._provenance?.snapshotSpec) push('A1-snapshotSpec', caseItem.id, '缺 _provenance.snapshotSpec')
}

// A2 分层计数
const EXPECTED_LAYERS = { obvious: 12, ambiguous: 12, 'old-session': 10, 'new-session': 6, capability: 5, 'should-ask': 5 }
const layerCounts = {}
for (const caseItem of cases) layerCounts[caseItem.tags?.[0] ?? 'unknown'] = (layerCounts[caseItem.tags?.[0] ?? 'unknown'] ?? 0) + 1
if (cases.length !== 50) push('A2-count', null, `案例数 ${cases.length} ≠ 50`)
for (const [layer, expected] of Object.entries(EXPECTED_LAYERS)) {
  if ((layerCounts[layer] ?? 0) !== expected) push('A2-layer', layer, `${layerCounts[layer] ?? 0} ≠ ${expected}`)
}

const workspaceById = (caseItem) => new Map((caseItem.workspaces ?? []).map((workspace) => [workspace.id, workspace]))
const namedCue = (caseItem) => (caseItem.tags ?? []).includes('named-cue')
const observational = (caseItem) => (caseItem.tags ?? []).includes('observational')
const needsConfirmation = (caseItem) => caseItem.expected?.needsConfirmation === true || (caseItem.tags ?? []).includes('should-ask') || (caseItem.tags ?? []).includes('needs_confirmation')
const requestText = (caseItem) => `${caseItem.task?.title ?? ''}\n${caseItem.task?.goal ?? ''}\n${(caseItem.task?.acceptanceHints ?? []).join('\n')}\n${caseItem.command?.text ?? ''}`

for (const caseItem of cases) {
  const expected = caseItem.expected ?? {}
  const wsMap = workspaceById(caseItem)
  const sessionMap = new Map((caseItem.sessions ?? []).map((session) => [session.id, session]))

  // A3 期望工作区必须在快照内（should-ask 除外）
  if (!needsConfirmation(caseItem)) {
    if (typeof expected.workspaceId !== 'string' || !wsMap.has(expected.workspaceId)) push('A3-expected-workspace', caseItem.id, 'expected.workspaceId 不在 workspaces 快照')
  }

  // A4 任务文本不得含期望会话标题全文
  const expectedSession = expected.sessionId ? sessionMap.get(expected.sessionId) : null
  if (expectedSession && expectedSession.title && expectedSession.title.length >= 8) {
    if (requestText(caseItem).toLowerCase().includes(expectedSession.title.toLowerCase())) push('A4-session-title-leak', caseItem.id, '任务文本含期望会话标题全文')
  }

  // A4 口径（lead/architect 裁定）：违规 = 期望会话标题全文 / 标题 **≥8 个连续 CJK 字符片段** / oracle 字段；
  // 通用技术词（latin 片段）不算违规，仅作 warning 披露。
  if (expectedSession?.title) {
    const normalizedTitle = String(expectedSession.title).replace(/\s+/g, '')
    const requestNorm = requestText(caseItem).replace(/\s+/g, '')
    for (const run of normalizedTitle.match(/[\u3400-\u9fff]+/g) ?? []) {
      for (let start = 0; start + 8 <= run.length; start += 1) {
        const window = run.slice(start, start + 8)
        if (requestNorm.includes(window)) {
          push('A4b-title-cjk-fragment', caseItem.id, `期望会话标题 ≥8 连续 CJK 片段命中：${window}`)
          break
        }
      }
    }
    const latinWindows = []
    for (let start = 0; start + 8 <= normalizedTitle.length; start += 1) {
      const window = normalizedTitle.slice(start, start + 8)
      if (/[A-Za-z]/.test(window) && requestNorm.includes(window)) latinWindows.push(window)
    }
    if (latinWindows.length > 0) warn('A4b-shared-tech-word', caseItem.id, `通用技术词/拉丁片段命中（按裁定不计违规）：${latinWindows[0].slice(0, 20)}`)
  }

  // A5 workspaces.recentTasks 不得列期望会话标题
  if (expectedSession?.title) {
    for (const workspace of caseItem.workspaces ?? []) {
      if ((workspace.recentTasks ?? []).some((title) => title === expectedSession.title)) push('A5-recentTasks-leak', caseItem.id, 'recentTasks 含期望会话标题')
    }
  }

  // A6 任务文本不得含期望工作区名/id/path basename（named-cue 层按裁定豁免“本工作区名”，但仍不得含 id/basename）
  if (!needsConfirmation(caseItem)) {
    const workspace = wsMap.get(expected.workspaceId)
    if (workspace) {
      const base = String(workspace.path ?? '').split('/').filter(Boolean).pop() ?? ''
      const needles = [expected.workspaceId, namedCue(caseItem) ? null : base].filter(Boolean)
      for (const needle of needles) {
        if (needle.length >= 4 && requestText(caseItem).toLowerCase().includes(needle.toLowerCase())) push('A6-workspace-leak', caseItem.id, `任务文本含期望工作区标识：${needle}`)
      }
      if (!namedCue(caseItem) && workspace.name && String(workspace.name).length >= 4 && requestText(caseItem).toLowerCase().includes(String(workspace.name).toLowerCase())) {
        push('A6-workspace-name-leak', caseItem.id, '任务文本含期望工作区名（非 named-cue 层）')
      }
    }
  }

  // A7 obvious=named-cue easy 层定义；capability=观测层
  const layer = caseItem.tags?.[0]
  if (layer === 'obvious') {
    if (!namedCue(caseItem)) push('A7-named-cue-tag', caseItem.id, 'obvious 层缺 named-cue 标签（应列为 easy 层，不计门禁）')
    const own = wsMap.get(expected.workspaceId)
    if (own) {
      const base = String(own.path ?? '').split('/').filter(Boolean).pop() ?? ''
      const text = requestText(caseItem).toLowerCase()
      const keys = new Set([own.name, base, ...String(base).split(/[-_.\s]+/), ...String(own.name).split(/[-_.\s]+/)].map((key) => String(key).toLowerCase()).filter((key) => key.length >= 4))
      if (![...keys].some((key) => text.includes(key))) push('A7-named-cue-definition', caseItem.id, 'obvious 层任务文本未点名本工作区（不符合 named-cue 定义）')
    }
  }
  if (layer === 'capability' && !observational(caseItem)) push('A7-observational-tag', caseItem.id, 'capability 层应标 observational（不参与门禁）')

  // A8 new 案例：sessions 快照不得含源会话；A9 attach 期望会话必须在快照内
  const baseMode = needsConfirmation(caseItem) ? null : expected.mode
  if (baseMode === 'new') {
    const sourceId = caseItem._provenance?.sourceSessionId
    if (sourceId && sessionMap.has(sourceId)) push('A8-new-source-in-snapshot', caseItem.id, 'new 案例快照含源会话（目标消息之后的会话不应出现）')
  }
  if (baseMode === 'attach') {
    if (!expected.sessionId || !sessionMap.has(expected.sessionId)) push('A9-attach-expected-missing', caseItem.id, 'attach 期望会话不在 sessions 快照')
    const expectedSessionRow = expected.sessionId ? sessionMap.get(expected.sessionId) : null
    const dispatchAt = caseItem._provenance?.dispatchAt
    if (expectedSessionRow && dispatchAt && expectedSessionRow.lastActiveAt > dispatchAt) push('A9-attach-future-activity', caseItem.id, '期望会话 lastActiveAt 晚于 dispatchAt（as-of 违规）')
  }

  // A10 should-ask 只记 needs_confirmation，不暴露目标
  if (needsConfirmation(caseItem)) {
    if (expected.workspaceId !== undefined || expected.mode !== undefined || expected.sessionId !== undefined) push('A10-should-ask-target', caseItem.id, 'should-ask 案例暴露了 workspaceId/mode/sessionId')
    if (expected.needsConfirmation !== true) push('A10-should-ask-flag', caseItem.id, '缺 expected.needsConfirmation=true')
  }

  // A11 as-of 快照自洽：所有 session.lastActiveAt <= dispatchAt；workspaces.recentTasks 不得引用源会话标题
  const dispatchAt = caseItem._provenance?.dispatchAt
  if (dispatchAt) {
    for (const session of caseItem.sessions ?? []) {
      if (session.lastActiveAt && session.lastActiveAt > dispatchAt) push('A11-session-future', caseItem.id, `session ${session.id} lastActiveAt > dispatchAt`)
    }
    const sourceId = caseItem._provenance?.sourceSessionId
    const sourceTitle = caseItem._provenance?.sourceSessionTitleAsOf
    if (sourceId) {
      for (const workspace of caseItem.workspaces ?? []) {
        if ((workspace.recentTasks ?? []).some((title) => sourceTitle && title === sourceTitle)) push('A11-source-title-in-recentTasks', caseItem.id, 'recentTasks 引用源会话（目标消息所在会话）标题')
      }
    }
  }

  // A12 白名单定义可复现：快照需包含 lastActiveAt（算 top-8 活跃工作区）
  const activeWorkspaces = new Set((caseItem.sessions ?? []).filter((session) => session.lastActiveAt).map((session) => session.workspaceId))
  if (activeWorkspaces.size === 0) push('A12-whitelist-input', caseItem.id, '快照无 lastActiveAt，无法复现现实白名单')
}

const audit = {
  generatedAt: new Date().toISOString(),
  casesFile,
  caseSha256,
  expectSha256: expectSha,
  generatorRev,
  summaryMode,
  dispatchTime: { min: dispatchTimes[0] ?? null, max: dispatchTimes.at(-1) ?? null },
  checks: ['A1 结构完整性', 'A2 分层计数', 'A3 期望工作区在快照内', 'A4 任务文本不含期望会话标题全文 / ≥8 连续 CJK 片段（通用技术词豁免）', 'A5 recentTasks 不含期望会话标题', 'A6 任务文本不含期望工作区标识', 'A7 obvious=named-cue easy / capability=观测层', 'A8 new 快照不含源会话', 'A9 attach 期望会话在快照且 as-of 自洽', 'A10 should-ask 不暴露目标', 'A11 as-of 快照自洽（session/recentTasks 不早于 dispatchAt 的数据泄漏）', 'A12 白名单定义输入完备'],
  cases: cases.length,
  layerCounts,
  violations,
  violationsCount: violations.length,
  warnings,
  warningsCount: warnings.length,
  warningsNote: 'A4 口径（lead/architect 裁定）：违规=标题全文/标题 ≥8 连续 CJK 片段/oracle 字段（工作区 id、路径 basename、会话 id）；通用技术词（latin 片段）不计违规，仅 warning 披露',
  pass: violations.length === 0,
}
fs.mkdirSync('docs/validation', { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(audit, undefined, 2))
console.log(JSON.stringify({ casesFile, caseSha256, cases: cases.length, layerCounts, violationsCount: violations.length, pass: audit.pass, outFile }, undefined, 2))
if (violations.length > 0) {
  console.error(`AUDIT FAIL: ${violations.length} violation(s); 详见 ${outFile}`)
  process.exit(1)
}
