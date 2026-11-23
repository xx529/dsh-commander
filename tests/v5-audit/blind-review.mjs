#!/usr/bin/env node
/**
 * V5 根因分析第二人盲评（tester / task-23）。
 *
 * 用途：对 scout 的 gate 26 条错案人工判定做**独立盲评**（三人称复核），
 *       并独立复算其 gate 结构数字。评审人只看「Jev 同款输入」（任务文本 + 工作区/会话快照），
 *       不看 scout 的判定。
 *
 * 用法：
 *   node tests/v5-audit/blind-review.mjs                 # 1) 复算 gate 指标；2) 固定 seed 分层抽 10 条；
 *                                                        #    3) 写 tests/v5-audit/blind-packet.json（仅输入，无期望/无 scout 判定）
 *                                                        #    4) 写 tests/v5-audit/blind-key.json（sealed：id→scout 判定，评审后再看）
 *   node tests/v5-audit/blind-review.mjs --compare       # 读 blind-judgments.json + sealed key → 一致率，写 blind-review.json
 *
 * 盲评名单固定 seed：seed = 'tester-blind-2026-11-17'，层内按 sha1(seed:id) 排序；
 * 分层配额：能 4 / 需澄清 3 / 不能 3（覆盖 scout 三类判定）。
 * 只读 docs/eval/frozen/cases.real.v2.jsonl、docs/eval/summary-v2-layered.json、docs/research/v5-failure-analysis.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const SEED = 'tester-blind-2026-11-17'
const PACKET_FILE = path.join(HERE, 'blind-packet.json')
const KEY_FILE = path.join(HERE, 'blind-key.json')
const JUDGMENTS_FILE = path.join(HERE, 'blind-judgments.json')
const OUT_FILE = path.join(HERE, 'blind-review.json')
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const trim = (text, limit) => {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim())
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('')
}

const cases = fs.readFileSync(path.join(ROOT, 'docs/eval/frozen/cases.real.v2.jsonl'), 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
const summary = readJson(path.join(ROOT, 'docs/eval/summary-v2-layered.json'))
const caseById = new Map(cases.map((item) => [item.id, item]))
const wsName = new Map()
for (const item of cases) for (const ws of item.workspaces ?? []) wsName.set(ws.id, ws.name)

// ---------------------------------------------------------------- 1. 独立复算 gate 指标（与 scout 声明对比）
const gateRows = summary.caseResults.filter((row) => !['obvious', 'capability', 'should-ask'].includes(row.layer))
const wrongRows = gateRows.filter((row) => !row.targetCorrect)
const correctRows = gateRows.filter((row) => row.targetCorrect)
const attachRows = gateRows.filter((row) => row.expectedMode === 'attach')
const metric = {
  gateN: gateRows.length,
  wrongN: wrongRows.length,
  correctN: correctRows.length,
  correctIds: correctRows.map((row) => row.id),
  workspaceTop1: gateRows.filter((row) => row.workspaceCorrect).length,
  modeCorrect: gateRows.filter((row) => row.modeCorrect).length,
  attachN: attachRows.length,
  attachTop1: attachRows.filter((row) => row.sessionCorrect).length,
  dshChosenInWrong: wrongRows.filter((row) => wsName.get(row.chosenWorkspaceId) === '.dsh').length,
  pW08Wrong: wrongRows.filter((row) => row.pWorkspace >= 0.8).length,
}
const claim = { gateN: 28, wrongN: 26, correctN: 2, workspaceTop1: 4, modeCorrect: 14, attachN: 18, attachTop1: 1, dshChosenInWrong: 16, pW08Wrong: 6 }
const claimCheck = Object.fromEntries(Object.keys(claim).map((key) => [key, { claim: claim[key], actual: metric[key], match: claim[key] === metric[key] }]))

// ---------------------------------------------------------------- 2. 解析 scout 逐案判定（仅用于分层抽样；不进入 packet）
const doc = fs.readFileSync(path.join(ROOT, 'docs/research/v5-failure-analysis.md'), 'utf8')
const scoutVerdict = {}
for (const line of doc.split('\n')) {
  if (!/^\| \d+ \| v5-/.test(line)) continue
  const cells = line.split('|').map((cell) => cell.trim())
  const id = cells[2]
  const verdict = cells[7].replace(/\*/g, '')
  if (/^(能|需澄清|不能)$/.test(verdict)) scoutVerdict[id] = verdict
}
const shortId = (id) => String(id).split('-').slice(0, 2).join('-') // v5-18-old-session → v5-18（scout 表用短 id）
for (const id of ['v5-27', 'v5-44']) scoutVerdict[id] = '能' // scout §3 汇总：能=14（错12+对2）

// ---------------------------------------------------------------- 3. 固定 seed 分层抽样（能4/需澄清3/不能3）
const quota = { 能: 4, 需澄清: 3, 不能: 3 }
const sample = []
for (const [verdict, count] of Object.entries(quota)) {
  const list = wrongRows.filter((row) => scoutVerdict[shortId(row.id)] === verdict)
  const ordered = [...list].sort((a, b) => sha1(`${SEED}:${a.id}`).localeCompare(sha1(`${SEED}:${b.id}`)))
  for (const row of ordered.slice(0, count)) sample.push({ id: row.id, layer: row.layer, verdict })
}
if (sample.length !== 10) {
  console.error(`sample size ${sample.length} != 10（scout 判定解析或分层不足）`)
  process.exit(1)
}

// ---------------------------------------------------------------- 4. packet（仅 Jev 同款输入，无 expected / 无 scout 判定）
const compactSessions = (caseItem) => {
  const ws = new Map((caseItem.workspaces ?? []).map((item) => [item.id, item.name]))
  return (caseItem.sessions ?? [])
    .slice()
    .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)))
    .map((session) => `${String(session.id).slice(-8)}|${ws.get(session.workspaceId) ?? '?'}|${trim(session.title, 48)}|${session.lastActiveAt}`)
}
const packet = {
  generatedAt: new Date().toISOString(),
  seed: SEED,
  instructions: [
    '你是独立盲评人。只依据本 packet 的输入（任务文本 + 工作区/会话快照），判断「一个合理的人类调度者能否仅凭该输入推断期望目标（工作区+new/attach+会话）」。',
    '不得查看 expected/答案、不得查看 docs/research/v5-failure-analysis.md 或任何 scout 判定。',
    '三档：能 = 高置信可推出唯一合理目标；需澄清 = 存在 ≥2 个同样合理的候选，理想行为是询问用户；不能 = 输入缺少必需上下文（指代/图片/历史），任何判定器都无法定位。',
    '输出 10 条 JSON：{id, verdict(能|需澄清|不能), reason(≤120 字，说明依据哪条输入信号或缺失什么)}。',
  ],
  cases: sample.map(({ id }) => {
    const caseItem = caseById.get(id)
    return {
      id,
      layer: caseItem.tags?.[0],
      task: { title: caseItem.task?.title, goal: caseItem.task?.goal, command: caseItem.command?.text },
      workspaces: (caseItem.workspaces ?? []).map((ws) => ({ name: ws.name, path: ws.path, summary: ws.summary, recentTasks: ws.recentTasks })),
      sessions: compactSessions(caseItem),
      sessionCount: (caseItem.sessions ?? []).length,
    }
  }),
}
fs.mkdirSync(HERE, { recursive: true })
fs.writeFileSync(PACKET_FILE, `${JSON.stringify(packet, undefined, 2)}\n`)
fs.writeFileSync(KEY_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), seed: SEED, key: Object.fromEntries(sample.map((item) => [item.id, item.verdict])) }, undefined, 2)}\n`)

const compare = process.argv.includes('--compare')
if (!compare) {
  console.log(`packet 已生成：${path.relative(ROOT, PACKET_FILE)}（10 条，输入-only）+ sealed key: ${path.relative(ROOT, KEY_FILE)}`)
  console.log(`独立复算：${JSON.stringify({ gateN: metric.gateN, wrongN: metric.wrongN, correctN: metric.correctN, workspaceTop1: metric.workspaceTop1, modeCorrect: metric.modeCorrect, attachTop1: `${metric.attachTop1}/${metric.attachN}`, dshChosenInWrong: metric.dshChosenInWrong, pW08Wrong: metric.pW08Wrong })}`)
  console.log(`与 scout 声明一致：${Object.values(claimCheck).every((item) => item.match) ? 'YES' : 'NO ' + JSON.stringify(claimCheck)}`)
  console.log(`抽样：${sample.map((item) => item.id).join(', ')}`)
  process.exit(0)
}

// ---------------------------------------------------------------- 5. compare（评审完成 → 一致率）
if (!fs.existsSync(JUDGMENTS_FILE)) {
  console.error(`missing ${path.relative(ROOT, JUDGMENTS_FILE)}（盲评结果，格式 {judgments:[{id,verdict,reason}]}）`)
  process.exit(2)
}
const judgments = readJson(JUDGMENTS_FILE).judgments ?? readJson(JUDGMENTS_FILE)
const key = readJson(KEY_FILE).key
const rows = sample.map(({ id, verdict: scoutLabel }) => {
  const judgment = judgments.find((item) => item.id === id)
  const verdict = judgment?.verdict ?? null
  return { id, scout: scoutLabel, reviewer: verdict, agree: verdict === scoutLabel, reason: trim(judgment?.reason ?? '', 160) }
})
const agreeN = rows.filter((row) => row.agree).length
const result = {
  generatedAt: new Date().toISOString(),
  role: 'tester（独立盲评协调人；评审输入为 input-only packet）',
  seed: SEED,
  metricsRecompute: { actual: metric, scoutClaim: claim, claimCheck, allMatch: Object.values(claimCheck).every((item) => item.match) },
  scoutVerdictCounts: { 能: Object.values(scoutVerdict).filter((v) => v === '能').length, 需澄清: Object.values(scoutVerdict).filter((v) => v === '需澄清').length, 不能: Object.values(scoutVerdict).filter((v) => v === '不能').length },
  sample: rows,
  agreement: { agree: agreeN, total: rows.length, rate: agreeN / rows.length },
  disagreements: rows.filter((row) => !row.agree),
  threshold: 'task-23：一致率 <80% 则 scout 的 F 类/天花板结论降级（本文件结论需在 audit-V5-rootcause.md 中体现）',
  conclusion: {
    metricReproduce: Object.values(claimCheck).every((item) => item.match) ? 'PASS（7/7 gate 结构数字复算一致）' : 'FAIL',
    agreementRate: agreeN / rows.length,
    threshold: 0.8,
    scoutQuantitativeConclusions: agreeN / rows.length >= 0.8 ? 'SUPPORTED' : 'DOWNGRADED',
    statement:
      agreeN / rows.length >= 0.8
        ? '盲评一致率 ≥80%：scout 的 F 类/天花板（≈50%、可救 12 条）结论可作为重开 V5 的定量依据'
        : '盲评一致率 <80%：scout 的 F 类/天花板（≈50%、可救 12 条）结论需降级——不可作为重开 V5 的定量决策依据，只能作为方向性输入；重开前需预注册判定 rubric + 多人独立标注与分歧裁定',
  },
}
fs.writeFileSync(OUT_FILE, `${JSON.stringify(result, undefined, 2)}\n`)
console.log(JSON.stringify({ agreement: result.agreement, disagreements: result.disagreements, metricsAllMatch: result.metricsRecompute.allMatch }, null, 2))
