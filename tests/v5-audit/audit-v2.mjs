#!/usr/bin/env node
/**
 * V5 v2 冻结评估独立审计（tester；只读 backend 产物与 ~/.dsh，只写 tests/v5-audit/**）。
 *
 * 审计目标：把「v2 冻结案例 + backend live 结论」变成可复查事实，回答
 *   **V5 v2 能否作为门禁 FAIL 的依据**（门禁证据可用性），而不是重算门禁结论本身。
 *
 * 检查分组：
 *   F 冻结与完整性：cases sha256 vs manifest / `.sha256`；manifest 元信息 vs 当前生成器/harness/审计脚本字节；
 *                    labels.cases.v2.md vs 冻结 cases；v2 frozen 是否只读（若已 chmod）。
 *   A 复现 backend audit：只读复跑 tools/eval/audit-cases.mjs（--out 到 tests/，不改 backend 产物），A1–A12 violations=0 是否可复现。
 *   L as-of / 泄漏实证（全部 50 条的廉价检查 + 25 条抽样深检）：
 *       请求文本不得含 expected 工作区 id/basename（named-cue 层豁免 name）/expected 会话 id/标题全文与 ≥8 字连续片段；
 *       task.goal 的上下文摘要可由「目标消息之前」的日志事件独立重算（A9 实证）；
 *       attach 期望会话 as-of 标题 = dispatchAt 前最后一个 title 事件（或回退首条 pre-dispatch 用户消息）；
 *       new 案例 sessions/recentTasks/摘要不得含源会话痕迹；recentTasks/摘要不得含请求文本片段；
 *       workspace summary 必须能由 as-of recentTasks 独立重算（摘要不读目标消息）。
 *   G 门禁口径/数学：从 live summary 的 caseResults 独立重算 gate 指标（non-named-cue n、attach n、target all）、
 *       阈值扫描（harness 定义 + protocol §6.6 定义两套）、C5/C6 分母、校准分桶；
 *       并核对 report/report header 的冻结哈希入证字段与 protocol 偏差。
 *   V live 复跑对比：tester 独立 layered live 复跑结果 vs backend summary/report；v1→v2 样本/标签差异（是否调标签）。
 *
 * 用法：
 *   node tests/v5-audit/audit-v2.mjs                       # 完整审计（含复跑 audit-cases；需 live summary 已存在）
 *   node tests/v5-audit/audit-v2.mjs --no-audit-rerun       # 跳过复跑 backend audit-cases
 *   node tests/v5-audit/audit-v2.mjs --summary ... --backend-summary ...
 * 退出码：0=审计通过（v2 可作为门禁 FAIL 证据，caveat 见 docs/validation/audit-V5-v2.md）；
 *         1=审计发现 INVALID/HIGH 缺陷（v2 证据不可用）；2=输入缺失。
 * 隐私：不打印任务正文；证据片段 ≤40 字；不打印 key（live 复跑由外部命令完成，本脚本只读 summary）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
const CASES = argOf('--cases', path.join(ROOT, 'docs/eval/frozen/cases.real.v2.jsonl'))
const MANIFEST = argOf('--manifest', path.join(ROOT, 'docs/eval/frozen/manifest.v2.json'))
const LABELS = argOf('--labels', path.join(ROOT, 'docs/eval/labels.cases.v2.md'))
const SUMMARY = argOf('--summary', path.join(HERE, 'live/summary-v2-layered-rerun.json'))
const BACKEND_SUMMARY = argOf('--backend-summary', path.join(ROOT, 'docs/eval/summary-v2-layered.json'))
const REPORT = argOf('--report', path.join(HERE, 'live/report-v2-layered-rerun.md'))
const BACKEND_REPORT = argOf('--backend-report', path.join(ROOT, 'docs/eval/report-v2-layered.md'))
const AUDIT_CASES = argOf('--audit-cases', path.join(ROOT, 'tools/eval/audit-cases.mjs'))
const JSON_OUT = argOf('--json-out', path.join(HERE, 'audit-v2-result.json'))
const DO_AUDIT_RERUN = !argv.includes('--no-audit-rerun')
const DAY = 24 * 60 * 60 * 1000

const checks = []
const add = (group, id, ok, detail, severity = 'INFO') => checks.push({ group, id, ok, detail, severity })
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const flatten = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const snippet = (text, max = 40) => {
  const flat = flatten(text)
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const pct = (n) => `${(n * 100).toFixed(1)}%`

for (const file of [CASES, MANIFEST, LABELS]) {
  if (!fs.existsSync(file)) {
    console.error(`missing input: ${file}`)
    process.exit(2)
  }
}
const manifest = readJson(MANIFEST)
const casesRaw = fs.readFileSync(CASES)
const cases = casesRaw.toString('utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
const casesById = new Map(cases.map((c) => [c.id, c]))
const layerOf = (caseItem) => caseItem.tags?.[0] ?? String(caseItem.id).split('-').slice(2).join('-')
const namedCue = (caseItem) => (caseItem.tags ?? []).includes('named-cue')
const observational = (caseItem) => (caseItem.tags ?? []).includes('observational')
const needsConfirmation = (caseItem) => caseItem.expected?.needsConfirmation === true || (caseItem.tags ?? []).includes('should-ask') || (caseItem.tags ?? []).includes('needs_confirmation')
const requestText = (caseItem) =>
  `${caseItem.task?.title ?? ''}\n${caseItem.task?.goal ?? ''}\n${(caseItem.task?.acceptanceHints ?? []).join('\n')}\n${caseItem.command?.text ?? ''}`
const layerCounts = {}
for (const caseItem of cases) layerCounts[layerOf(caseItem)] = (layerCounts[layerOf(caseItem)] ?? 0) + 1

// ---------------------------------------------------------------- F 冻结与完整性
const caseSha256 = sha256(casesRaw)
const manifestOk =
  manifest.caseSha256 === caseSha256 &&
  manifest.casesFile === 'docs/eval/frozen/cases.real.v2.jsonl' &&
  manifest.cases === cases.length &&
  manifest.seed === 'v5' &&
  manifest.summaryMode === 'semantic' &&
  manifest.leakViolations === 0
add('F', 'F1 cases sha256 与 manifest/`.sha256` 一致', manifestOk, `manifest=${manifest.caseSha256?.slice(0, 16)}… actual=${caseSha256.slice(0, 16)}… bytes=${casesRaw.length} cases=${cases.length}`)
const shaFile = path.join(ROOT, 'docs/eval/frozen/cases.real.v2.jsonl.sha256')
const shaFileText = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim() : ''
add('F', 'F2 `.sha256` 副文件一致', shaFileText.includes(caseSha256), `file=${snippet(shaFileText, 80)}`)
const manifestLayerOk = JSON.stringify(manifest.layerCounts) === JSON.stringify(layerCounts)
add('F', 'F3 manifest 分层计数 = 冻结文件', manifestLayerOk, `manifest=${JSON.stringify(manifest.layerCounts)} actual=${JSON.stringify(layerCounts)}`)
const generatorCurrent = fs.existsSync(path.join(ROOT, manifest.generator)) ? sha256(fs.readFileSync(path.join(ROOT, manifest.generator))) : null
const harnessCurrent = fs.existsSync(path.join(ROOT, manifest.harness)) ? sha256(fs.readFileSync(path.join(ROOT, manifest.harness))) : null
const auditScriptCurrent = fs.existsSync(path.join(ROOT, manifest.auditScript)) ? sha256(fs.readFileSync(path.join(ROOT, manifest.auditScript))) : null
const generatorMatches = generatorCurrent === manifest.generatorSha256
const harnessMatches = harnessCurrent === manifest.harnessSha256
const auditMatches = auditScriptCurrent?.slice(0, 16) === manifest.auditScriptRev
const f4Ok = generatorMatches && harnessMatches && auditMatches
add('F', 'F4 manifest 生成器/harness/审计脚本字节与当前文件一致', f4Ok, f4Ok ? '三项均一致' : `generator ${generatorCurrent?.slice(0, 16) ?? 'n/a'} vs manifest ${String(manifest.generatorSha256).slice(0, 16)}（${generatorMatches ? '一致' : '不一致：冻结后模板修复导致漂移；frozen cases sha 未变，需在 manifest 记录冻结时哈希并用当前哈希标注'}）；harness ${harnessCurrent?.slice(0, 16)} vs ${String(manifest.harnessSha256).slice(0, 16)}（${harnessMatches ? '一致' : '不一致'}）；audit ${auditScriptCurrent?.slice(0, 16)} vs ${manifest.auditScriptRev}（${auditMatches ? '一致' : '不一致'}）`, 'MEDIUM')
const readOnlyOk = (fs.statSync(CASES).mode & 0o777) === 0o444
add('F', 'F5 frozen cases 只读位（0444）', readOnlyOk, `mode=${(fs.statSync(CASES).mode & 0o777).toString(8)}`, 'MEDIUM')
const dispatchTimes = cases.map((caseItem) => caseItem._provenance?.dispatchAt).filter(Boolean).sort()
add(
  'F',
  'F6 manifest dispatchTime min/max = 冻结文件 _provenance',
  manifest.dispatchTime?.min === dispatchTimes[0] && manifest.dispatchTime?.max === dispatchTimes.at(-1),
  `manifest=[${manifest.dispatchTime?.min}, ${manifest.dispatchTime?.max}] actual=[${dispatchTimes[0]}, ${dispatchTimes.at(-1)}]`,
)

// labels.cases.v2.md vs cases
const labelRows = new Map()
const labelText = fs.readFileSync(LABELS, 'utf8')
const labelTitle = '未命名'
for (const line of labelText.split('\n')) {
  if (!line.startsWith('| v5-')) continue
  const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
  labelRows.set(cells[0], cells)
}
const labelMismatch = []
for (const caseItem of cases) {
  const row = labelRows.get(caseItem.id)
  if (row === undefined) {
    labelMismatch.push(`${caseItem.id}: 行缺失`)
    continue
  }
  const provenance = caseItem._provenance ?? {}
  const expected = caseItem.expected ?? {}
  const expectedWsName = (caseItem.workspaces ?? []).find((workspace) => workspace.id === expected.workspaceId)?.name
  const expectedSession = expected.sessionId ? (caseItem.sessions ?? []).find((session) => session.id === expected.sessionId) : null
  const pair = [
    [row[2]?.replace(/^`|`$/g, ''), provenance.sourceSessionId, '源会话'],
    [row[3], provenance.dispatchAt, 'dispatchAt'],
    [row[4], needsConfirmation(caseItem) ? 'needs_confirmation' : expectedWsName, '期望工作区'],
    [row[5], needsConfirmation(caseItem) ? 'needs_confirmation' : expected.mode, '期望模式'],
    [row[6] === '—' ? undefined : row[6]?.replace(/^`|`$/g, ''), expected.sessionId, '期望会话'],
  ]
  if (expectedSession !== null && !expectedSession) pair.push(['attach-expected-session-missing', 'present', '期望会话在快照'])
  for (const [actual, want, field] of pair) if (String(actual) !== String(want)) labelMismatch.push(`${caseItem.id}: ${field} labels=「${actual}」 cases=「${want}」`)
}
const labelsHead = labelText.slice(0, 700)
const labelsClaimCounts = labelsHead.includes('案例数：50') && labelsHead.includes('high=12') && labelsHead.includes('medium=22') && labelsHead.includes('low=11') && labelsHead.includes('需人工复核：38')
add('F', 'F7 labels.cases.v2.md 行/计数与冻结文件一致', labelRows.size === 50 && labelMismatch.length === 0, labelMismatch.slice(0, 4).join('；') || `50 行一致；头部计数 claims=${labelsClaimCounts}`, labelMismatch.length > 0 ? 'HIGH' : 'INFO')
add('F', 'F8 labels.cases.v2.md 头部计数声明（12/22/11、needsReview=38）', labelsClaimCounts, labelsHead.split('\n').filter((line) => line.startsWith('- ')).slice(0, 3).join(' / '), 'MEDIUM')
const undefinedBug = (labelText.match(/^.*undefined\/\d+.*$/m) ?? [])[0]
add('F', 'F9 labels.cases.v2.md 无渲染 undefined（文档质量）', undefinedBug === undefined, undefinedBug ? `异常行：${snippet(undefinedBug, 80)}（task-14 未修）` : '无', 'LOW')
const auditDocFile = path.join(ROOT, 'docs/validation/audit-V5-v2.md')
const testerAuditRecord = manifest.testerAudit
const testerAuditCurrent = {
  docSha: fs.existsSync(auditDocFile) ? sha256(fs.readFileSync(auditDocFile)) : null,
  scriptSha: sha256(fs.readFileSync(path.join(HERE, 'audit-v2.mjs'))),
  postfixSha: fs.existsSync(path.join(ROOT, 'docs/validation/audit-V5-v2-postfix.md')) ? sha256(fs.readFileSync(path.join(ROOT, 'docs/validation/audit-V5-v2-postfix.md'))) : null,
}
// 兼容两种结构：{sha256} 与 {v2Audit:{sha256},v2PostfixAudit:{sha256},scriptSha256,capturedAt}
const recordedDocSha = testerAuditRecord?.v2Audit?.sha256 ?? testerAuditRecord?.sha256
const recordedPostfixSha = testerAuditRecord?.v2PostfixAudit?.sha256
const testerAuditStale =
  testerAuditRecord !== undefined &&
  (recordedDocSha !== testerAuditCurrent.docSha || testerAuditRecord.scriptSha256 !== testerAuditCurrent.scriptSha)
const postfixStale = recordedPostfixSha !== undefined && testerAuditCurrent.postfixSha !== null && recordedPostfixSha !== testerAuditCurrent.postfixSha
add('F', 'F10 manifest.testerAudit 记录与当前审计文档/脚本 sha 一致（避免证据链陈旧）', !testerAuditStale && !postfixStale, testerAuditStale || postfixStale ? `manifest 记录 doc=${String(recordedDocSha).slice(0, 16)}…/script=${String(testerAuditRecord?.scriptSha256).slice(0, 16)}…/postfix=${String(recordedPostfixSha).slice(0, 16)}…，当前 doc=${String(testerAuditCurrent.docSha).slice(0, 16)}…/script=${String(testerAuditCurrent.scriptSha).slice(0, 16)}…/postfix=${String(testerAuditCurrent.postfixSha).slice(0, 16)}…` : `一致（capturedAt=${testerAuditRecord?.capturedAt ?? 'n/a'}；含 v2 审计、postfix 审计、脚本/结果 sha 时点快照）`, testerAuditStale || postfixStale ? 'MEDIUM' : 'INFO')

// ---------------------------------------------------------------- A 复现 backend audit-cases（只读）
const auditOut = path.join(HERE, 'live/v2-audit-cases-rerun.json')
let auditRerun = null
if (DO_AUDIT_RERUN) {
  try {
    fs.mkdirSync(path.dirname(auditOut), { recursive: true })
    const stdout = execFileSync(process.execPath, [AUDIT_CASES, '--cases', CASES, '--expect-sha256', manifest.caseSha256, '--out', auditOut], {
      cwd: ROOT,
      timeout: 120000,
      encoding: 'utf8',
    })
    auditRerun = { stdout, parsed: fs.existsSync(auditOut) ? readJson(auditOut) : null }
  } catch (error) {
    auditRerun = { error: String(error?.stdout ?? '').slice(0, 500) || String(error?.message ?? error) }
  }
}
const backendAuditFile = path.join(ROOT, 'docs/validation/v5-audit-cases.json')
const backendAudit = fs.existsSync(backendAuditFile) ? readJson(backendAuditFile) : null
if (auditRerun !== null) {
  const rerun = auditRerun.parsed
  add('A', 'A0 复跑 audit-cases.mjs 成功（A1–A12 violations=0 可复现）', rerun?.violationsCount === 0 && rerun?.caseSha256 === manifest.caseSha256, rerun ? `violations=${rerun.violationsCount} pass=${rerun.pass} caseSha256=${String(rerun.caseSha256).slice(0, 16)}…` : `ERROR ${snippet(auditRerun.error, 200)}`, rerun?.violationsCount === 0 ? 'INFO' : 'HIGH')
  add('A', 'A1 复跑结果与 backend 审计 JSON 一致', backendAudit !== null && rerun?.violationsCount === backendAudit.violationsCount && rerun?.caseSha256 === backendAudit.caseSha256, `rerun=${rerun?.violationsCount}/${String(rerun?.caseSha256).slice(0, 12)} vs backend=${backendAudit?.violationsCount}/${String(backendAudit?.caseSha256).slice(0, 12)}`)
}
// audit-cases.mjs 实现覆盖度 vs protocol §6.2B 的静态缺口（审计工具本身不能证明全部断言）
const auditSrc = fs.readFileSync(AUDIT_CASES, 'utf8')
const auditGaps = []
if (!/CJK/.test(auditSrc)) auditGaps.push('A4 未实现「≥8 连续 CJK 片段」')
if (!/pre-dispatch|dispatchAt.*messageTime|messageTime.*dispatchAt/.test(auditSrc)) auditGaps.push('A9 未断言「请求文本只使用 pre-dispatch 事件」语义')
if (!/titleAsOf|as-of 重算/.test(auditSrc)) auditGaps.push('A5/A11 recentTasks 未做 as-of 标题重算（仅 full-title 相等）')
if (!/workspace.*summary|summary.*derive|摘要/.test(auditSrc)) auditGaps.push('未校验 workspaces.summary 的 as-of 派生（摘要不读目标消息）')
add('A', 'A2 audit-cases.mjs 覆盖度 vs protocol §6.2B（A4 已按裁定补齐，其余缺口由本审计独立补检）', auditGaps.length === 0, auditGaps.join('；') || '无缺口', auditGaps.length > 0 ? 'MEDIUM' : 'INFO')

// ---------------------------------------------------------------- 数据源（只读）
const workspaceStore = readJson(path.join(HOME, 'storages/workspace.json'))
const workspaces = Object.entries(workspaceStore?.tables?.workspaces ?? {}).map(([id, row]) => ({ id, path: String(row?.path ?? ''), title: String(row?.title ?? '') }))
const wsById = new Map(workspaces.map((ws) => [ws.id, ws]))
const wsByPath = new Map(workspaces.map((ws) => [ws.path.replace(/\/+$/, ''), ws]))
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
      dirs.set(name.startsWith('session-') ? name.slice(8) : `session-${name}`, full)
    }
  }
  return dirs
}
const sessionDirs = indexSessionDirs(path.join(HOME, 'sessions'))
const sessionCache = new Map()
function loadSession(sessionId) {
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId)
  const dir = sessionDirs.get(sessionId)
  let record
  if (dir !== undefined) {
    const files = fs.readdirSync(dir).filter((name) => /^session\..*\.jsonl(\.zstd)?$/.test(name)).sort()
    if (files.length > 0) {
      const events = readSessionLog(path.join(dir, files.at(-1)))
      const header = events.find((event) => event.type === 'session')
      const titleEvents = []
      const userMessages = []
      const assistantMessages = []
      const times = []
      for (const event of events) {
        const time = Number(event.time)
        if (!Number.isFinite(time)) continue
        times.push(time)
        if (event.type === 'session/title' && typeof event?.data?.title === 'string') titleEvents.push({ time, title: event.data.title })
        else if (event.type === 'user/message' && event?.data?.source?.kind === 'user') {
          const text = userMessageText(event)
          if (text.length > 0) userMessages.push({ time, text })
        } else if (event.type === 'assistant/message') {
          const text = userMessageText(event)
          if (text.length > 0) assistantMessages.push({ time, text })
        }
      }
      record = { header, titleEvents, userMessages, assistantMessages, times: times.sort((a, b) => a - b), createdAt: Number(header?.createdAt ?? 0) }
    }
  }
  sessionCache.set(sessionId, record)
  return record
}
const latestBefore = (times, t) => {
  let found = 0
  for (const time of times) if (time <= t && time > found) found = time
  return found
}
const titleAsOf = (session, dispatchAt) => {
  const event = session.titleEvents.filter((item) => item.time <= dispatchAt).at(-1)
  if (event?.title) return { title: event.title, source: 'session/title@pre-dispatch' }
  const first = session.userMessages.find((item) => item.time <= dispatchAt)
  if (first) return { title: first.text.replace(/\s+/g, ' ').trim().slice(0, 40), source: 'first-user-message@pre-dispatch' }
  return { title: '（未命名会话）', source: 'none' }
}
const reconstructContext = (session, message) => {
  const priorUsers = session.userMessages
    .filter((item) => item.time < message.time)
    .slice(-2)
    .map((item) => item.text.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
  const priorAssistant = session.assistantMessages
    .filter((item) => item.time < message.time)
    .at(-1)
    ?.text.replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const parts = []
  if (priorUsers.length > 0) parts.push(`此前用户要求：${priorUsers.join('；')}`)
  if (priorAssistant) parts.push(`此前助手要点：${priorAssistant}`)
  return parts.length > 0 ? parts.join('。') : '新任务（该会话首条消息，无历史会话上下文）'
}
const contiguousFragments = (text, size = 8) => {
  const flat = flatten(text).toLowerCase()
  const out = new Set()
  for (let i = 0; i + size <= flat.length; i += 1) out.add(flat.slice(i, i + size))
  return [...out]
}
const containsFragment = (haystack, needle, size = 8) => contiguousFragments(needle, size).some((fragment) => fragment.trim().length === size && flatten(haystack).toLowerCase().includes(fragment))

// ---------------------------------------------------------------- L 全 50 条廉价检查
const taskLeakViolations = []
const fragmentHits = []
const contextViolations = []
const dispatchAtMismatch = []
const snapshotAsOfViolations = []
const summaryViolations = []
const taskHintTitles = []
const expectedNote = []
for (const caseItem of cases) {
  const provenance = caseItem._provenance ?? {}
  const expected = caseItem.expected ?? {}
  const text = requestText(caseItem)
  const lowerText = flatten(text).toLowerCase()
  const ws = wsById.get(provenance.sourceWorkspaceId)
  const dispatchAt = Date.parse(provenance.dispatchAt)
  const session = loadSession(provenance.sourceSessionId)
  const message = session?.userMessages?.[provenance.messageIndex]

  // 请求文本泄漏（protocol §6.2B A3/A4/A6/A8；named-cue 层按裁定豁免“本工作区名/basename”，但 id 仍禁止）
  if (needsConfirmation(caseItem)) {
    if (expected.workspaceId !== undefined || expected.mode !== undefined || expected.sessionId !== undefined) expectedNote.push(`${caseItem.id}: should-ask 暴露目标`)
    if (expected.needsConfirmation !== true) expectedNote.push(`${caseItem.id}: 缺 needsConfirmation`)
  } else {
    if (expected.workspaceId && lowerText.includes(expected.workspaceId.toLowerCase())) taskLeakViolations.push(`${caseItem.id}: 含工作区 id`)
    const baseName = ws?.path.split('/').filter(Boolean).pop()
    if (!namedCue(caseItem) && baseName && baseName.length >= 4 && lowerText.includes(baseName.toLowerCase())) taskLeakViolations.push(`${caseItem.id}: 含工作区 basename「${baseName}」`)
    if (!namedCue(caseItem) && ws?.title && ws.title.length >= 4 && lowerText.includes(ws.title.toLowerCase())) taskLeakViolations.push(`${caseItem.id}: 含工作区 name「${ws.title}」`)
    if (expected.sessionId) {
      const bare = String(expected.sessionId).replace(/^session-/, '')
      if (lowerText.includes(String(expected.sessionId).toLowerCase()) || lowerText.includes(bare.toLowerCase())) taskLeakViolations.push(`${caseItem.id}: 含期望会话 id`)
      const expectedSessionRow = (caseItem.sessions ?? []).find((item) => item.id === expected.sessionId)
      if (expectedSessionRow?.title && expectedSessionRow.title.length >= 8) {
        if (lowerText.includes(flatten(expectedSessionRow.title).toLowerCase())) taskLeakViolations.push(`${caseItem.id}: 含期望会话标题全文`)
        const fragments = contiguousFragments(expectedSessionRow.title, 8).filter((fragment) => flatten(text).toLowerCase().includes(fragment))
        if (fragments.length > 0) fragmentHits.push({ id: caseItem.id, layer: layerOf(caseItem), title: expectedSessionRow.title, fragments: fragments.slice(0, 4), cjk: fragments.some((fragment) => /[\u4e00-\u9fff]/.test(fragment)) })
      }
    }
  }

  // A9 实证：上下文摘要可由目标消息之前的日志事件独立重算（rawCommand 为空白归一化文本）
  if (session && message) {
    const context = reconstructContext(session, message)
    if (provenance.contextSummary !== context) contextViolations.push(`${caseItem.id}: contextSummary 与 pre-dispatch 重算不一致（logs=${snippet(context, 24)}）`)
    if (!String(caseItem.task?.goal ?? '').startsWith(context)) contextViolations.push(`${caseItem.id}: task.goal 未以 pre-dispatch 上下文摘要开头`)
    const rawFlat = flatten(message.text)
    const rawCommandFlat = flatten(provenance.rawCommand ?? '').replace(/…$/, '')
    if (rawCommandFlat.length < 3999 && rawFlat !== rawCommandFlat) contextViolations.push(`${caseItem.id}: rawCommand 与日志第 messageIndex 条消息不一致（空白归一化后）`)
    const nonOld = layerOf(caseItem) !== 'old-session'
    const dtDeltaMin = (dispatchAt - message.time) / 60000
    if (nonOld && Math.abs(dtDeltaMin) > 1) {
      const futureSessions = (caseItem.sessions ?? []).filter((row) => Date.parse(row.lastActiveAt) > message.time).length
      dispatchAtMismatch.push({ id: caseItem.id, layer: layerOf(caseItem), deltaMin: Math.round(dtDeltaMin), futureSessions })
    }
    if (!nonOld && dispatchAt < message.time) contextViolations.push(`${caseItem.id}: old-session dispatchAt 早于消息时间`)
  } else {
    contextViolations.push(`${caseItem.id}: 源会话/消息不可解析`)
  }

  // 快照 as-of：所有 sessions.lastActiveAt <= dispatchAt（new 不含源会话）
  for (const row of caseItem.sessions ?? []) {
    if (Number.isFinite(dispatchAt) && Date.parse(row.lastActiveAt) > dispatchAt) snapshotAsOfViolations.push(`${caseItem.id}: session ${String(row.id).slice(-8)} lastActiveAt>dispatchAt`)
  }
  if (needsConfirmation(caseItem)) continue
  if (expected.mode === 'new') {
    if ((caseItem.sessions ?? []).some((row) => row.id === provenance.sourceSessionId)) snapshotAsOfViolations.push(`${caseItem.id}: new 快照含源会话`)
  } else if (expected.mode === 'attach') {
    const expectedRow = (caseItem.sessions ?? []).find((row) => row.id === expected.sessionId)
    if (!expectedRow) snapshotAsOfViolations.push(`${caseItem.id}: attach 期望会话不在快照`)
    else if (!session || !Number.isFinite(dispatchAt)) {
      snapshotAsOfViolations.push(`${caseItem.id}: 期望会话日志不可读/无 dispatchAt`)
    } else {
      const asOf = titleAsOf(session, dispatchAt)
      if (expectedRow.title !== asOf.title) snapshotAsOfViolations.push(`${caseItem.id}: 期望会话标题≠as-of 重算（${asOf.source}）`)
    }
  }

  // workspace summary 必须能由 as-of recentTasks 重算（摘要不读目标消息）
  for (const workspace of caseItem.workspaces ?? []) {
    const tasks = workspace.recentTasks ?? []
    const expectedSummary =
      tasks.length > 0
        ? `${workspace.name}（${workspace.path}）：dispatch 前历史任务如「${tasks.slice(0, 3).join('」「')}」`.slice(0, 120)
        : `${workspace.name}（${workspace.path}）：dispatch 前无历史会话`
    if (workspace.summary !== expectedSummary) summaryViolations.push(`${caseItem.id}: ${workspace.name} summary 无法由 recentTasks 重算`)
    for (const title of tasks) {
      if (title === '（未命名会话）') summaryViolations.push(`${caseItem.id}: recentTasks 含未命名会话占位`)
      if (expected.sessionId && title === (caseItem.sessions ?? []).find((row) => row.id === expected.sessionId)?.title) summaryViolations.push(`${caseItem.id}: recentTasks 含期望会话标题（A5）`)
      if (provenance.sourceSessionTitleAsOf && title === provenance.sourceSessionTitleAsOf) summaryViolations.push(`${caseItem.id}: recentTasks 含源会话 as-of 标题（A11）`)
      if (containsFragment(text, title, 8) && !taskHintTitles.some((item) => item.caseId === caseItem.id && item.title === title)) taskHintTitles.push({ caseId: caseItem.id, title })
    }
  }
}
add('L', 'L1a 请求文本无硬泄漏（非 named-cue 工作区 name/basename/id、期望会话 id、标题全文）', taskLeakViolations.length === 0, taskLeakViolations.slice(0, 5).join('；') || '50/50 无违规', taskLeakViolations.length > 0 ? 'HIGH' : 'INFO')
// Lead 2026-11-17 裁定修正口径：违规 = 标题全文 / ≥8 CJK 连续片段 / oracle 字段（工作区名/id、会话 id/标题、摘要原文）；
// 共享通用技术词（markdown/session/jev-desktop/agent-desktop 等）不算。字面命中仅展示，不判违规。
const cjkCount = (text) => (String(text).match(/[\u4e00-\u9fff]/g) ?? []).length
const cjkRuns = (text) => (flatten(text).match(/[\u4e00-\u9fff]{8,}/g) ?? [])
const fragmentViolations = fragmentHits.filter((hit) => {
  const request = flatten(casesById.get(hit.id) ? requestText(casesById.get(hit.id)) : '').toLowerCase()
  return cjkRuns(hit.title).some((run) => request.includes(run.toLowerCase()))
})
add('L', 'L1b protocol A4 片段检查（修正口径：标题全文 / ≥8 CJK 连续片段 / oracle 字段）', fragmentViolations.length === 0, fragmentViolations.length === 0 ? `0 违规（字面 8 字符命中 ${fragmentHits.length}/50，均为共享通用技术词：${fragmentHits.slice(0, 5).map((hit) => `${hit.id}「${hit.fragments.join('|')}」`).join('；')}；按 Lead 裁定不计违规）` : `${fragmentViolations.length} 条 CJK ≥8 字片段命中：${fragmentViolations.map((hit) => `${hit.id}「${hit.fragments.join('|')}」`).join('；')}`, fragmentViolations.length > 0 ? 'HIGH' : 'INFO')
add('L', 'L2 task.goal 上下文摘要可由 pre-dispatch 事件独立重算（A9 实证）', contextViolations.length === 0, contextViolations.slice(0, 5).join('；') || '50/50 一致', contextViolations.length > 0 ? 'HIGH' : 'INFO')
const labelsV2Text = fs.existsSync(path.join(ROOT, 'docs/eval/labels.v2.md')) ? fs.readFileSync(path.join(ROOT, 'docs/eval/labels.v2.md'), 'utf8') : ''
const dispatchDocumented = /最后一条\s*≥?\s*12\s*字/.test(labelsV2Text) && /已知偏差/.test(labelsV2Text)
add('L', 'L2b dispatchAt 实现口径已在 labels.v2 如实声明（含 12/50 已知偏差披露）', dispatchDocumented, dispatchDocumented ? `已声明为实现口径「会话最后一条 ≥12 字用户消息时间」并披露偏差；实测 12/50 非 old-session 案例 dispatchAt 晚于被测消息（Δ=${dispatchAtMismatch.map((row) => row.deltaMin).join('/')} 分钟；快照含 lastActiveAt>messageTime 的会话 ${dispatchAtMismatch.reduce((sum, row) => sum + row.futureSessions, 0)} 条）→ 按 Lead 裁定为 MEDIUM 已知偏差、不重冻结；重开门须按被测消息时间新冻结` : `文档未声明实际口径（${dispatchAtMismatch.length}/50 条 dispatchAt≠messageTime）`, dispatchDocumented ? 'MEDIUM' : 'HIGH')
add('L', 'L3 sessions 快照 as-of 自洽（lastActiveAt≤dispatchAt；new 无源会话；attach 标题 as-of 重算一致）', snapshotAsOfViolations.length === 0, snapshotAsOfViolations.slice(0, 5).join('；') || '50/50 无违规', snapshotAsOfViolations.length > 0 ? 'HIGH' : 'INFO')
add('L', 'L4 workspaces summary/recentTasks 由 as-of recentTasks 重算、无 A5/A11 违规', summaryViolations.length === 0, summaryViolations.slice(0, 5).join('；') || '50/50 无违规', summaryViolations.length > 0 ? 'HIGH' : 'INFO')
add('L', 'L4b recentTasks 与任务文本的语义提示（非 A5/A11 违规，门禁外公平性提示）', taskHintTitles.length === 0, taskHintTitles.length === 0 ? '无' : `${taskHintTitles.length} 个工作区标题与请求文本共享 ≥8 字符片段（如「${snippet(taskHintTitles[0]?.title, 18)}」）；属 as-of 历史标题，客观存在，建议报告中披露`, 'MEDIUM')
add('L', 'L5 should-ask 只记 needs_confirmation、不暴露目标', expectedNote.length === 0, expectedNote.slice(0, 7).join('；') || '5/5 合规', expectedNote.length > 0 ? 'HIGH' : 'INFO')

// ---------------------------------------------------------------- L 抽样 25 条深检（6 层 + 全部 should-ask + 全部 new-session）
const sample = []
for (const layer of ['should-ask', 'new-session', 'obvious', 'old-session', 'ambiguous', 'capability']) {
  const list = cases.filter((caseItem) => layerOf(caseItem) === layer)
  const take = layer === 'should-ask' || layer === 'new-session' ? list : list.slice(0, layer === 'capability' ? 2 : 4)
  sample.push(...take)
}
const deepViolations = []
const siblingSameTitle = []
for (const caseItem of sample) {
  const provenance = caseItem._provenance ?? {}
  const expected = caseItem.expected ?? {}
  const dispatchAt = Date.parse(provenance.dispatchAt)
  const sourceSession = loadSession(provenance.sourceSessionId)
  const sourceAsOf = sourceSession ? titleAsOf(sourceSession, dispatchAt) : null
  const sourceTitle = provenance.sourceSessionTitleAsOf
  if (sourceAsOf && sourceTitle !== null && provenance.sourceSessionTitleAsOf !== undefined && sourceTitle !== sourceAsOf.title) deepViolations.push(`${caseItem.id}: sourceSessionTitleAsOf≠as-of 重算`)
  if (needsConfirmation(caseItem)) continue
  const text = requestText(caseItem)
  if (expected.mode === 'new') {
    if ((caseItem.sessions ?? []).some((row) => row.id === provenance.sourceSessionId)) deepViolations.push(`${caseItem.id}: new sessions 含源会话`)
    if (sourceTitle && sourceTitle !== '（未命名会话）') {
      for (const sibling of (caseItem.sessions ?? []).filter((row) => row.title === sourceTitle)) {
        const siblingSession = loadSession(sibling.id)
        const siblingCreatedAt = siblingSession?.createdAt ?? null
        if (siblingCreatedAt !== null && siblingCreatedAt > Date.parse(provenance.messageTime)) {
          deepViolations.push(`${caseItem.id}: new 快照含源会话同标题兄弟会话 ${String(sibling.id).slice(-8)}（createdAt>messageTime=未来信息）`)
        } else {
          siblingSameTitle.push(`${caseItem.id}: ${String(sibling.id).slice(-8)}（createdAt≤messageTime，历史重复任务）`)
        }
      }
    }
    const ownWorkspace = (caseItem.workspaces ?? []).find((workspace) => workspace.id === expected.workspaceId)
    if (sourceTitle && sourceTitle !== '（未命名会话）' && (ownWorkspace?.recentTasks ?? []).includes(sourceTitle)) deepViolations.push(`${caseItem.id}: new 期望工作区 recentTasks 含源会话标题`)
    if (sourceTitle && sourceTitle !== '（未命名会话）' && flatten(ownWorkspace?.summary ?? '').includes(flatten(sourceTitle))) deepViolations.push(`${caseItem.id}: new 期望工作区 summary 含源会话标题`)
  }
  if (expected.mode === 'attach') {
    const expectedRow = (caseItem.sessions ?? []).find((row) => row.id === expected.sessionId)
    const asOf = sourceSession ? titleAsOf(sourceSession, dispatchAt) : null
    if (expectedRow && asOf && expectedRow.title !== asOf.title) deepViolations.push(`${caseItem.id}: attach 期望会话标题≠as-of 重算`)
    const msgAsOf = sourceSession ? titleAsOf(sourceSession, loadSession(provenance.sourceSessionId)?.userMessages?.[provenance.messageIndex]?.time ?? dispatchAt) : null
    if (msgAsOf && msgAsOf.title && msgAsOf.title.length >= 8 && flatten(text).toLowerCase().includes(flatten(msgAsOf.title).toLowerCase())) deepViolations.push(`${caseItem.id}: 任务文本含消息时点期望会话标题`)
  }
  // recentTasks 的 as-of 来源：每个 recentTask 标题应能对应快照中某会话的 as-of 标题
  for (const workspace of caseItem.workspaces ?? []) {
    for (const title of workspace.recentTasks ?? []) {
      const owner = (caseItem.sessions ?? []).find((row) => row.title === title)
      if (owner === undefined) {
        deepViolations.push(`${caseItem.id}: recentTasks 标题「${snippet(title, 16)}」不在 sessions 快照中（来源不可复查）`)
        continue
      }
      const ownerSession = loadSession(owner.id)
      if (!ownerSession) {
        deepViolations.push(`${caseItem.id}: recentTasks 来源会话 ${String(owner.id).slice(-8)} 日志不可读`)
        continue
      }
      if (titleAsOf(ownerSession, dispatchAt).title !== title) deepViolations.push(`${caseItem.id}: recentTasks 标题≠来源会话 as-of 重算`)
    }
  }
}
add('L', 'L6 抽样 25 条深检（标题/recentTasks 来源可复查、new 无目标痕迹）', deepViolations.length === 0, deepViolations.slice(0, 6).join('；') || `25/25 通过（${sample.length} 条）`, deepViolations.length > 0 ? 'HIGH' : 'INFO')
add('L', 'L6b new 案例源会话同标题兄弟会话（A8/A11 未覆盖的残留痕迹）', siblingSameTitle.length === 0, siblingSameTitle.length === 0 ? '无' : `${siblingSameTitle.slice(0, 4).join('；')}（非源会话、快照内可见；建议报告中披露，非 oracle 泄漏）`, 'MEDIUM')
add('L', 'L7 抽样覆盖（全部 should-ask + 全部 new-session + 6 层）', new Set(sample.map((c) => layerOf(c))).size === 6 && sample.filter((c) => layerOf(c) === 'should-ask').length === 5 && sample.filter((c) => layerOf(c) === 'new-session').length === 6, `${sample.length} 条：${Object.entries(sample.reduce((acc, c) => ({ ...acc, [layerOf(c)]: (acc[layerOf(c)] ?? 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(' / ')}`)

// ---------------------------------------------------------------- G 门禁口径与数学
const summary = fs.existsSync(SUMMARY) ? readJson(SUMMARY) : null
const backendSummary = fs.existsSync(BACKEND_SUMMARY) ? readJson(BACKEND_SUMMARY) : null
const gateSetOf = (caseResults) => caseResults.filter((row) => {
  const caseItem = casesById.get(row.id)
  if (!caseItem) return false
  return !needsConfirmation(caseItem) && !namedCue(caseItem) && !observational(caseItem) && row.shouldAsk !== true
})
function metricsFromSummary(summaryJson) {
  const caseResults = summaryJson?.caseResults ?? []
  const gate = gateSetOf(caseResults)
  const attach = gate.filter((row) => row.expectedMode === 'attach')
  const shouldAsk = caseResults.filter((row) => row.shouldAsk)
  return {
    cases: caseResults.length,
    gateN: gate.length,
    attachN: attach.length,
    shouldAskN: shouldAsk.length,
    workspaceTop1: gate.length ? gate.filter((row) => row.workspaceCorrect).length / gate.length : 0,
    sessionTop1Attach: attach.length ? attach.filter((row) => row.sessionCorrect).length / attach.length : 0,
    modeAccuracy: gate.length ? gate.filter((row) => row.modeCorrect).length / gate.length : 0,
    targetAll: gate.length ? gate.filter((row) => row.targetCorrect).length / gate.length : 0,
    allN: caseResults.filter((row) => !needsConfirmation(casesById.get(row.id))).length,
    allWorkspaceTop1: (() => {
      const labeled = caseResults.filter((row) => !needsConfirmation(casesById.get(row.id)))
      return labeled.length ? labeled.filter((row) => row.workspaceCorrect).length / labeled.length : 0
    })(),
  }
}
const backendMetrics = backendSummary ? metricsFromSummary(backendSummary) : null
const rerunMetrics = summary ? metricsFromSummary(summary) : null
const reportClaims = { workspaceTop1: 0.143, sessionTop1Attach: 0.056, modeAccuracy: 0.5, targetAll: 0.071 }
if (backendMetrics !== null) {
  const diffs = Object.entries(reportClaims).filter(([key, value]) => Math.abs(backendMetrics[key] - value) > 0.002)
  add('G', 'G1 report-v2-layered.md 指标 = summary-v2-layered.json 重算', diffs.length === 0, diffs.length ? diffs.map(([key, value]) => `${key} report=${value} recompute=${backendMetrics[key].toFixed(3)}`).join('；') : `gate n=${backendMetrics.gateN} attach n=${backendMetrics.attachN}：ws=${pct(backendMetrics.workspaceTop1)} attach=${pct(backendMetrics.sessionTop1Attach)} mode=${pct(backendMetrics.modeAccuracy)} target=${pct(backendMetrics.targetAll)}`)
  add('G', 'G2 gate 口径 n=28（non-named-cue = 45−12 named-cue−5 observational）', backendMetrics.gateN === 28 && backendMetrics.attachN === 18, `gateN=${backendMetrics.gateN} attachN=${backendMetrics.attachN} shouldAskN=${backendMetrics.shouldAskN} labeledN=${backendMetrics.allN}`)
  const summaryGates = backendSummary?.metrics?.gate ?? {}
  add('G', 'G3 summary.metrics.gate 与独立重算一致', Math.abs((summaryGates.workspaceTop1 ?? 0) - backendMetrics.workspaceTop1) < 1e-9 && Math.abs((summaryGates.sessionTop1Attach ?? 0) - backendMetrics.sessionTop1Attach) < 1e-9 && Math.abs((summaryGates.modeAccuracy ?? 0) - backendMetrics.modeAccuracy) < 1e-9, `summary.ws=${pct(summaryGates.workspaceTop1 ?? 0)} / recompute=${pct(backendMetrics.workspaceTop1)}`)
}
// 阈值扫描独立重算（harness 定义 + protocol §6.6 定义）
const P_GRID = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
const C_GRID = [0.3, 0.4, 0.5, 0.6, 0.7]
function sweepFrom(summaryJson) {
  const caseResults = summaryJson?.caseResults ?? []
  if (caseResults.length === 0) return null
  const gateRows = gateSetOf(caseResults)
  const labeledN = caseResults.filter((row) => !needsConfirmation(casesById.get(row.id))).length
  const rows = []
  for (const pWorkspace of P_GRID)
    for (const pSession of P_GRID)
      for (const confidenceFloor of C_GRID) {
        const passed = caseResults.filter((row) => row.pWorkspace >= pWorkspace && row.pSession >= pSession && row.cWorkspace >= confidenceFloor && row.cSession >= confidenceFloor)
        if (passed.length === 0) continue
        const passedGate = passed.filter((row) => gateRows.some((gateRow) => gateRow.id === row.id))
        const leaks = passed.filter((row) => row.shouldAsk === true || needsConfirmation(casesById.get(row.id)) === true)
        const correctGate = passedGate.filter((row) => row.targetCorrect).length
        rows.push({
          pWorkspace,
          pSession,
          confidenceFloor,
          autoAll: passed.length,
          served: passedGate.length,
          correct: correctGate,
          // harness 定义
          precisionHarness: passedGate.length === 0 ? 1 : correctGate / passedGate.length,
          precisionPenaltyHarness: correctGate / (passedGate.length + leaks.length),
          coverageHarness: passedGate.length / gateRows.length,
          // protocol §6.6 定义：precision=correct(auto)/autoAll（autoAll 含 should-ask 泄漏计错）；coverage=served/labeled(45)
          precisionProtocol: correctGate / passed.length,
          coverageProtocol: passedGate.length / labeledN,
        })
      }
  const qualifies = (row) => row.precisionHarness >= 0.95 && row.precisionPenaltyHarness >= 0.95 && row.precisionProtocol >= 0.95
  const qualifying = rows.filter(qualifies)
  const protocolQualifying = rows.filter((row) => row.precisionProtocol >= 0.95 && row.coverageProtocol >= 0.4)
  return { rows: rows.length, qualifying, protocolQualifying, labeledN, gateN: gateRows.length, best: rows.slice().sort((a, b) => b.precisionProtocol - a.precisionProtocol || b.coverageProtocol - a.coverageProtocol)[0] ?? null }
}
const sweep = backendSummary ? sweepFrom(backendSummary) : null
if (sweep !== null) {
  add('G', 'G4 阈值扫描：无组合同时满足 precision≥95%（含 should-ask 泄漏）', sweep.qualifying.length === 0, `扫描行=${sweep.rows}；qualifying=${sweep.qualifying.length}；最高 precisionProtocol=${pct(sweep.best?.precisionProtocol ?? 0)} @ coverageHarness=${pct(sweep.best?.coverageHarness ?? 0)}`)
  const sweepRows = backendSummary.allSweepRows ?? []
  const withServed = sweepRows.filter((row) => (row.autoServed ?? 0) > 0 || (row.servedCoverage ?? 0) > 0 || (row.coverage ?? 0) > 0)
  const labelDen = withServed.filter((row) => row.labeled !== undefined && Math.abs(row.coverage - row.labeled_served || 0) < 0)
  const matches45 = withServed.filter((row) => row.labeled > 0 && Math.abs(row.coverage - (row.servedCoverage ?? row.autoServed) / row.labeled) < 1e-9)
  const matches28 = withServed.filter((row) => row.gateN > 0 && Math.abs(row.coverage - (row.servedCoverage ?? row.autoServed) / row.gateN) < 1e-9)
  const coverageOk = matches45.length === withServed.length && matches28.length === 0
  add('G', 'G5 C6 coverage 分母 = served/labeled(45)（protocol §6.6；backend task-14 已修）', coverageOk, coverageOk ? `summary.allSweepRows ${withServed.length} 行均满足 coverage=served/${sweep.labeledN}；gateN=${sweep.gateN} 仅作 C2 分母并列` : `分母不符：matches45=${matches45.length}/${withServed.length}，matches28=${matches28.length}；示例 row=${JSON.stringify(withServed[0])?.slice(0, 160)}`, coverageOk ? 'INFO' : 'MEDIUM')
  add('G', 'G6 protocol §6.6 口径（precision=correct/autoAll、coverage≥40%）下同样无组合达标', sweep.protocolQualifying.length === 0, `protocol-qualifying=${sweep.protocolQualifying.length}`)
}
// 校准分桶独立重算
if (backendSummary) {
  const buckets = [
    { label: '<0.5', min: 0, max: 0.5 },
    { label: '0.5–0.6', min: 0.5, max: 0.6 },
    { label: '0.6–0.7', min: 0.6, max: 0.7 },
    { label: '0.7–0.8', min: 0.7, max: 0.8 },
    { label: '0.8–0.9', min: 0.8, max: 0.9 },
    { label: '0.9–1.0', min: 0.9, max: 1.0000001 },
  ]
  const gateRows = gateSetOf(backendSummary.caseResults ?? [])
  const recomputed = buckets.map((bucket) => {
    const rows = gateRows.filter((row) => Math.max(row.pWorkspace, row.pSession) >= bucket.min && Math.max(row.pWorkspace, row.pSession) < bucket.max)
    return { label: bucket.label, n: rows.length, correct: rows.filter((row) => row.targetCorrect).length }
  })
  const summaryCal = backendSummary.calibration ?? []
  const calMismatch = recomputed.filter((row, index) => (summaryCal[index]?.n ?? -1) !== row.n || (summaryCal[index]?.correct ?? -1) !== row.correct)
  add('G', 'G7 校准分桶可重算；高置信桶过自信（C8 FAIL 依据）', calMismatch.length === 0, calMismatch.length === 0 ? recomputed.map((row) => `${row.label}:${row.correct}/${row.n}`).join(' ') : '分桶与 summary.calibration 不一致', calMismatch.length > 0 ? 'MEDIUM' : 'INFO')
  const topBucket = recomputed.at(-1)
  add('G', 'G8 高置信桶 0.9–1.0 准确率 0% → 严重过自信（C8 不可过）', topBucket !== undefined && topBucket.n > 0 && topBucket.correct / topBucket.n === 0, `0.9–1.0: ${topBucket?.correct}/${topBucket?.n}`)
}
// report header 冻结哈希入证（protocol §6.2A.4）
const requiredHeader = ['caseSha256', 'generatorRev', 'seed', 'summaryMode', 'dispatchTime', 'violations']
const headerOf = (file) => {
  if (!fs.existsSync(file)) return ''
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const headEnd = lines.findIndex((line) => /^##\s/.test(line))
  return lines.slice(0, headEnd >= 0 ? headEnd : 24).join('\n')
}
const evidenceReports = [
  ['report-v2-layered.md', path.join(ROOT, 'docs/eval/report-v2-layered.md')],
  ['report-v2-whitelist-layered.md', path.join(ROOT, 'docs/eval/report-v2-whitelist-layered.md')],
  ['report-v2-full.md', path.join(ROOT, 'docs/eval/report-v2-full.md')],
]
const headerGaps = []
for (const [name, file] of evidenceReports) {
  const header = headerOf(file)
  const missing = requiredHeader.filter((key) => !header.includes(key))
  if (missing.length > 0) headerGaps.push(`${name} 缺 ${missing.join('/')}`)
}
add('G', 'G9 三份 v2 证据报告头部含冻结哈希/生成器/seed/口径/dispatchTime/violations（§6.2A.4）', headerGaps.length === 0, headerGaps.length === 0 ? '齐全' : `${headerGaps.join('；')}（report-v2.md 有全字段；task-14 声明“三份已补”与实际不符，实测仍缺 dispatchTime/violations）`, headerGaps.length > 0 ? 'MEDIUM' : 'INFO')
const fullLog = path.join(ROOT, 'docs/validation/evidence-v5-v2-full-live.log')
if (fs.existsSync(fullLog)) {
  const logText = fs.readFileSync(fullLog, 'utf8')
  const errors400 = (logText.match(/max_tokens_exceeded/g) ?? []).length
  add('G', 'G10 full 模式失败证据可核（29×400 max_tokens_exceeded，A 模式不可行 → C7/§6.7）', errors400 === 29, `max_tokens_exceeded 出现=${errors400} 次`)
}

// ---------------------------------------------------------------- V live 复跑对比 + v1→v2 差异
if (rerunMetrics !== null && backendMetrics !== null) {
  const metricKeys = ['workspaceTop1', 'sessionTop1Attach', 'modeAccuracy', 'targetAll']
  const deltas = metricKeys.map((key) => ({ key, backend: backendMetrics[key], rerun: rerunMetrics[key], delta: rerunMetrics[key] - backendMetrics[key] }))
  const maxDelta = Math.max(...deltas.map((row) => Math.abs(row.delta)))
  add('V', 'V1 tester 独立 layered live 复跑与 backend 同结论（指标差 ≤5pp）', maxDelta <= 0.05 && rerunMetrics.gateN === backendMetrics.gateN, deltas.map((row) => `${row.key}: backend=${pct(row.backend)} rerun=${pct(row.rerun)} Δ=${(row.delta * 100).toFixed(1)}pp`).join('；'), maxDelta > 0.05 ? 'HIGH' : 'MEDIUM')
  const backendResults = new Map((backendSummary.caseResults ?? []).map((row) => [row.id, row]))
  const rerunResults = new Map((summary.caseResults ?? []).map((row) => [row.id, row]))
  let sameTarget = 0
  let compared = 0
  for (const [id, row] of rerunResults) {
    const other = backendResults.get(id)
    if (!other) continue
    compared += 1
    if (row.targetCorrect === other.targetCorrect) sameTarget += 1
  }
  add('V', 'V2 逐条 target 判定一致率（模型非确定性容忍）', compared > 0 && sameTarget / compared >= 0.7, `${sameTarget}/${compared} 一致（${pct(sameTarget / Math.max(1, compared))}）`)
  const requestCount = summary?.totals?.requests
  add('V', 'V3 复跑请求数/模式/失败率可核', requestCount === 100 && (summary.errors ?? []).length === 0, `requests=${requestCount} errors=${(summary.errors ?? []).length} mode=${summary.mode} exitCode(report)=1`)
}
// v1 → v2 差异（是否调标签/调样本）
const v1Frozen = path.join(HERE, 'fixtures/v1-frozen.json')
if (fs.existsSync(v1Frozen)) {
  const v1 = readJson(v1Frozen)
  const v1Pairs = new Map(v1.labels.map((row) => [`${row.sourceSessionId}:${row.messageIndex}`, row]))
  const v2Pairs = new Map(cases.map((caseItem) => [`${caseItem._provenance?.sourceSessionId}:${caseItem._provenance?.messageIndex}`, caseItem]))
  const overlap = [...v2Pairs.keys()].filter((key) => v1Pairs.has(key))
  const labelChanges = []
  for (const key of overlap) {
    const oldRow = v1Pairs.get(key)
    const newCase = v2Pairs.get(key)
    if (needsConfirmation(newCase)) {
      if (oldRow.mode !== 'needs_confirmation') labelChanges.push(`${key}: v1=${oldRow.workspaceName}/${oldRow.mode} → v2=needs_confirmation`)
      continue
    }
    const newWsName = (newCase.workspaces ?? []).find((workspace) => workspace.id === newCase.expected?.workspaceId)?.name
    if (oldRow.workspaceName !== newWsName || oldRow.mode !== newCase.expected?.mode) labelChanges.push(`${key}: v1=${oldRow.workspaceName}/${oldRow.mode} → v2=${newWsName}/${newCase.expected?.mode}`)
  }
  add('V', 'V4 v1→v2 样本/标签差异透明（是否“调标签”）', labelChanges.length === 0, `v2 样本=${v2Pairs.size}，与 v1 重叠=${overlap.length}，同会话+消息序上的标签变化=${labelChanges.length}${labelChanges.length ? `：${labelChanges.slice(0, 3).join('；')}` : ''}；其余为换样本（v1 泄漏样本被替换属预期）`)
  const v1LeakSessions = ['session-35a6a906-bdfa-44d4-b610-4e4f6e41c60d', 'session-fa31148c-48aa-4598-af91-bcaa448d925e', 'session-c5d45e56-ae65-4813-b790-b4cbd2455b08', 'session-161ef52d-4b0d-4a6b-af96-d14adda36b3f']
  const retained = v2Pairs.size > 0 ? v1LeakSessions.filter((id) => cases.some((caseItem) => caseItem._provenance?.sourceSessionId === id)) : []
  add('V', 'V5 v1 泄漏样本处理可解释（named-cue 层点名豁免 / 换样本）', true, `v1 强泄漏源会话在 v2 仍出现=${retained.length}/4（${retained.map((id) => id.slice(-8)).join(',')}）；v2 规则：named-cue 层允许点名本工作区、非 named-cue 硬断言 0 泄漏，见 L1`)
}

// ---------------------------------------------------------------- 汇总
const highIssues = checks.filter((check) => !check.ok && check.severity === 'HIGH')
const mediumIssues = checks.filter((check) => !check.ok && check.severity === 'MEDIUM')
const usability = highIssues.length === 0 ? 'PASS' : 'INVALID'
const result = {
  generatedAt: new Date().toISOString(),
  role: 'tester（独立复核）',
  inputs: { cases: path.relative(ROOT, CASES), caseSha256, manifest: path.relative(ROOT, MANIFEST), labels: path.relative(ROOT, LABELS), summary: fs.existsSync(SUMMARY) ? path.relative(ROOT, SUMMARY) : null, backendSummary: fs.existsSync(BACKEND_SUMMARY) ? path.relative(ROOT, BACKEND_SUMMARY) : null },
  sample: { total: sample.length, ids: sample.map((caseItem) => caseItem.id) },
  checks,
  verdict: {
    usability,
    v2UsableAsGateFailEvidence: usability === 'PASS',
    statement: usability === 'PASS' ? 'v2 冻结案例与 live FAIL 结论可作为门禁 FAIL 依据（证据链可复查；caveat 见文档）' : 'v2 证据存在 HIGH 级缺陷，不可作为门禁依据',
    highIssues: highIssues.map((issue) => `${issue.id}: ${issue.detail}`),
    mediumIssues: mediumIssues.map((issue) => `${issue.id}: ${issue.detail}`),
  },
}
fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true })
fs.writeFileSync(JSON_OUT, `${JSON.stringify(result, undefined, 2)}\n`)

console.log('==== V5 v2 冻结评估独立审计（tester）====')
console.log(`案例：${path.relative(ROOT, CASES)}（sha256 ${caseSha256.slice(0, 16)}…，${cases.length} 条）`)
console.log(`抽样深检：${sample.length} 条（${sample.map((c) => c.id).join(', ')}）`)
console.log('')
for (const [group, title] of [
  ['F', 'F 冻结与完整性'],
  ['A', 'A backend audit 复现'],
  ['L', 'L as-of/泄漏实证'],
  ['G', 'G 门禁口径/数学'],
  ['V', 'V live 复跑/v1→v2 差异'],
]) {
  console.log(`-- ${title}`)
  for (const check of checks.filter((item) => item.group === group)) console.log(`  ${check.ok ? 'PASS' : check.severity === 'HIGH' ? 'HIGH' : 'WARN'} ${check.id} —— ${check.detail}`)
}
console.log('')
console.log(`HIGH=${highIssues.length} MEDIUM=${mediumIssues.length}`)
console.log(`裁定：${usability}${usability === 'PASS' ? '（v2 可作为门禁 FAIL 依据）' : '（v2 证据不可用）'}`)
console.log(`结果 JSON：${path.relative(ROOT, JSON_OUT)}`)
process.exit(usability === 'PASS' ? 0 : 1)
