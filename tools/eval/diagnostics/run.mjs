#!/usr/bin/env node
/**
 * V5 FAIL 诊断实验（非门禁）：
 *   D1 候选规模敏感性（28 → 8 → 4 路 workspace choice）
 *   D2 逐候选打分排序（noul 近似；前 8 个 gate 案例，每案例 8 候选；预算限制下 10→8）
 *   D3 会话能力隔离（oracle 工作区下只问会话 + new，18 条 attach 案例）
 *   D4 置信度/abstention 可用性（离线复用 v2 live summary）
 *
 * 用法（key 在进程内 source，不打印）：
 *   set -a; . /tmp/dsh-commander-probe/jev.env; set +a; export JEV_API_KEY="$TYPESAFE_API_KEY"
 *   node tools/eval/diagnostics/run.mjs --cases docs/eval/frozen/cases.real.v2.jsonl \
 *     --summary docs/eval/summary-v2-layered.json --out-dir tools/eval/diagnostics/artifacts
 *
 * 本脚本**不修改 frozen cases、不覆盖 v2 报告、不产出任何门禁结论**。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  loadCases,
  gateCases,
  pickCandidates,
  buildWorkspaceChoice,
  buildSessionChoice,
  buildCandidateScore,
  extractWorkspaceAnswer,
  extractSessionAnswer,
  callJev,
  requestsUsed,
  percentile,
  sha256,
  ENDPOINT,
  MODEL,
} from './lib.mjs'

const argv = process.argv.slice(2)
const flagOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const CASES_FILE = flagOf('--cases', 'docs/eval/frozen/cases.real.v2.jsonl')
const SUMMARY_FILE = flagOf('--summary', 'docs/eval/summary-v2-layered.json')
const OUT_DIR = flagOf('--out-dir', 'tools/eval/diagnostics/artifacts')
const SEED = flagOf('--seed', 'diag-v3')
const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || ''
if (apiKey.length === 0) {
  console.error('JEV_API_KEY (or TYPESAFE_API_KEY) required; source /tmp/dsh-commander-probe/jev.env in-process')
  process.exit(2)
}
fs.mkdirSync(OUT_DIR, { recursive: true })
const caseSha = sha256(fs.readFileSync(CASES_FILE))
const cases = loadCases(CASES_FILE)
const gate = gateCases(cases)
const attachCases = gate.filter((c) => c.expected?.mode === 'attach')
const priorSummary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'))
const priorById = new Map((priorSummary.caseResults ?? []).map((row) => [row.id, row]))
const artifacts = { d1: [], d2: [], d3: [] }
const startedAt = Date.now()

const log = (message) => process.stderr.write(`${message}\n`)

// ---------------------------------------------------------------- D1 候选规模
log(`D1: gate n=${gate.length}（28-way 基线复用 v2 live summary）`)
const d1Stats = { full28: { correct: 0, n: 0 }, eight: { correct: 0, n: 0 }, four: { correct: 0, n: 0 } }
for (const [index, c] of gate.entries()) {
  const prior = priorById.get(c.id)
  if (prior !== undefined) {
    d1Stats.full28.n += 1
    if (prior.workspaceCorrect) d1Stats.full28.correct += 1
  }
  for (const size of [8, 4]) {
    const candidates = pickCandidates(c, size, SEED)
    const built = buildWorkspaceChoice(c, candidates)
    const result = await callJev(apiKey, built.body)
    const answer = extractWorkspaceAnswer(result.json)
    const chosenWorkspaceId = [...built.wIndex.entries()].find(([, key]) => key === answer.choice)?.[0] ?? null
    const correct = chosenWorkspaceId === c.expected.workspaceId
    const bucket = size === 8 ? d1Stats.eight : d1Stats.four
    bucket.n += 1
    if (correct) bucket.correct += 1
    artifacts.d1.push({
      experiment: `D1-${size}way`,
      caseId: c.id,
      caseIndex: index,
      candidateIds: candidates.map((ws) => ws.id),
      expectedWorkspaceId: c.expected.workspaceId,
      chosenWorkspaceId,
      correct,
      pChosen: answer.p,
      confidence: answer.confidence,
      latencyMs: Math.round(result.latencyMs),
      usage: result.usage,
    })
  }
  if ((index + 1) % 7 === 0) log(`  D1 ${index + 1}/${gate.length}, requests=${requestsUsed()}`)
}

// ---------------------------------------------------------------- D2 逐候选打分（noul 近似）
const d2Cases = gate.slice(0, 8) // 预算：D1 56 + D2 64 + D3 18 = 138 ≤ 150（任务原计划 10 案例，预算下调）
log(`D2: 逐候选打分 cases=${d2Cases.length} × 8 候选 = ${d2Cases.length * 8} 请求`)
const d2Stats = { scoredTop1: 0, choiceTop1: 0, n: 0, margins: [] }
for (const c of d2Cases) {
  const candidates = pickCandidates(c, 8, SEED)
  const scores = []
  for (const candidate of candidates) {
    const built = buildCandidateScore(c, candidate)
    const result = await callJev(apiKey, built.body)
    const answer = extractWorkspaceAnswer(result.json)
    const pThis = answer.probabilities?.this ?? 0
    scores.push({ workspaceId: candidate.id, name: candidate.name, pThis: Number(pThis), pNone: Number(answer.probabilities?.none ?? 0), latencyMs: Math.round(result.latencyMs), usage: result.usage })
    artifacts.d2.push({ experiment: 'D2-score', caseId: c.id, candidateId: candidate.id, candidateName: candidate.name, pThis: Number(pThis), pNone: Number(answer.probabilities?.none ?? 0), latencyMs: Math.round(result.latencyMs) })
  }
  scores.sort((a, b) => b.pThis - a.pThis)
  const scoredTop = scores[0]?.workspaceId ?? null
  const d1Row = artifacts.d1.find((row) => row.caseId === c.id && row.experiment === 'D1-8way')
  const choiceTop = d1Row?.chosenWorkspaceId ?? null
  const scoredCorrect = scoredTop === c.expected.workspaceId
  const choiceCorrect = choiceTop === c.expected.workspaceId
  d2Stats.n += 1
  if (scoredCorrect) d2Stats.scoredTop1 += 1
  if (choiceCorrect) d2Stats.choiceTop1 += 1
  d2Stats.margins.push(Number((scores[0].pThis - (scores[1]?.pThis ?? 0)).toFixed(3)))
  artifacts.d2.push({ experiment: 'D2-compare', caseId: c.id, expectedWorkspaceId: c.expected.workspaceId, scoredTop, scoredCorrect, choiceTop, choiceCorrect, topMargin: d2Stats.margins.at(-1), scores })
}
log(`  D2 done, requests=${requestsUsed()}`)

// ---------------------------------------------------------------- D3 attach 会话隔离（oracle 工作区）
log(`D3: attach n=${attachCases.length}，oracle 工作区下只问会话 + new`)
const d3Stats = { sessionTop1: 0, modeCorrect: 0, n: 0, perCase: [] }
for (const c of attachCases) {
  const built = buildSessionChoice(c, c.expected.workspaceId)
  const result = await callJev(apiKey, built.body)
  const answer = extractSessionAnswer(result.json)
  const chosenSessionId = [...built.sIndex.entries()].find(([, key]) => key === answer.choice)?.[0] ?? null
  const chosenMode = answer.choice === 'new' ? 'new' : 'attach'
  const sessionCorrect = chosenSessionId === c.expected.sessionId
  const modeCorrect = chosenMode === 'attach'
  d3Stats.n += 1
  if (sessionCorrect) d3Stats.sessionTop1 += 1
  if (modeCorrect) d3Stats.modeCorrect += 1
  const row = {
    experiment: 'D3-oracle-workspace-session',
    caseId: c.id,
    expectedSessionId: c.expected.sessionId,
    chosenSessionId,
    chosenMode,
    sessionCorrect,
    modeCorrect,
    candidateSessions: built.sessions.length,
    pChosen: answer.p,
    confidence: answer.confidence,
    latencyMs: Math.round(result.latencyMs),
    usage: result.usage,
  }
  d3Stats.perCase.push(row)
  artifacts.d3.push(row)
}
log(`  D3 done, requests=${requestsUsed()}`)

// ---------------------------------------------------------------- D4 置信度/abstention（离线）
const gatePrior = gate
  .map((c) => priorById.get(c.id))
  .filter((row) => row !== undefined)
  .map((row) => ({
    id: row.id,
    pMax: Math.max(row.pWorkspace ?? 0, row.pSession ?? 0),
    pWorkspace: row.pWorkspace ?? 0,
    correct: Boolean(row.targetCorrect),
  }))
  .sort((a, b) => b.pMax - a.pMax)
const d4Stats = {
  n: gatePrior.length,
  meanPMaxCorrect: 0,
  meanPMaxWrong: 0,
  abstention: [],
}
const correctRows = gatePrior.filter((row) => row.correct)
const wrongRows = gatePrior.filter((row) => !row.correct)
d4Stats.meanPMaxCorrect = correctRows.length === 0 ? null : correctRows.reduce((sum, row) => sum + row.pMax, 0) / correctRows.length
d4Stats.meanPMaxWrong = wrongRows.length === 0 ? null : wrongRows.reduce((sum, row) => sum + row.pMax, 0) / wrongRows.length
for (const coverage of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8]) {
  const k = Math.max(1, Math.round(gatePrior.length * coverage))
  const selected = gatePrior.slice(0, k)
  const precision = selected.filter((row) => row.correct).length / selected.length
  d4Stats.abstention.push({ coverage, k, precision: Number(precision.toFixed(3)), thresholdPMax: Number(selected.at(-1)?.pMax ?? 0) })
}
// pMax 与正确性的分桶
const buckets = [
  { label: '<0.6', min: 0, max: 0.6 },
  { label: '0.6–0.7', min: 0.6, max: 0.7 },
  { label: '0.7–0.8', min: 0.7, max: 0.8 },
  { label: '0.8–0.9', min: 0.8, max: 0.9 },
  { label: '0.9–1.0', min: 0.9, max: 1.01 },
]
d4Stats.buckets = buckets.map((bucket) => {
  const rows = gatePrior.filter((row) => row.pMax >= bucket.min && row.pMax < bucket.max)
  return { bucket: bucket.label, n: rows.length, accuracy: rows.length === 0 ? null : Number((rows.filter((row) => row.correct).length / rows.length).toFixed(3)) }
})
d4Stats.maxPrecisionAt40 = d4Stats.abstention.find((row) => Math.abs(row.coverage - 0.4) < 1e-9)?.precision ?? null

// ---------------------------------------------------------------- 落盘
const elapsedMs = Date.now() - startedAt
const output = {
  experiment: 'V5-fail-diagnostics-v3（非门禁）',
  generatedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  model: MODEL,
  casesFile: CASES_FILE,
  caseSha256: caseSha,
  seed: SEED,
  requests: requestsUsed(),
  elapsedMs,
  d1: {
    note: '28-way 基线复用 v2 live summary 的 workspaceCorrect；8/4-way 为本次实跑',
    full28: { ...d1Stats.full28, accuracy: d1Stats.full28.n === 0 ? null : Number((d1Stats.full28.correct / d1Stats.full28.n).toFixed(3)) },
    eight: { ...d1Stats.eight, accuracy: d1Stats.eight.n === 0 ? null : Number((d1Stats.eight.correct / d1Stats.eight.n).toFixed(3)) },
    four: { ...d1Stats.four, accuracy: d1Stats.four.n === 0 ? null : Number((d1Stats.four.correct / d1Stats.four.n).toFixed(3)) },
  },
  d2: { ...d2Stats, scoredAccuracy: d2Stats.n === 0 ? null : Number((d2Stats.scoredTop1 / d2Stats.n).toFixed(3)), choiceAccuracy: d2Stats.n === 0 ? null : Number((d2Stats.choiceTop1 / d2Stats.n).toFixed(3)) },
  d3: { n: d3Stats.n, sessionTop1: d3Stats.n === 0 ? null : Number((d3Stats.sessionTop1 / d3Stats.n).toFixed(3)), modeCorrect: d3Stats.n === 0 ? null : Number((d3Stats.modeCorrect / d3Stats.n).toFixed(3)), perCase: d3Stats.perCase },
  d4: {
    ...d4Stats,
    latency: {
      p50: Math.round(percentile([...artifacts.d1, ...artifacts.d2, ...artifacts.d3].map((row) => row.latencyMs).filter(Number.isFinite), 0.5)),
      p95: Math.round(percentile([...artifacts.d1, ...artifacts.d2, ...artifacts.d3].map((row) => row.latencyMs).filter(Number.isFinite), 0.95)),
    },
  },
}
for (const [name, rows] of Object.entries(artifacts)) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}-raw.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}
fs.writeFileSync(path.join(OUT_DIR, 'run-summary.json'), JSON.stringify(output, undefined, 2) + '\n')
console.log(JSON.stringify(output, undefined, 2))
