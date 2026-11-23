#!/usr/bin/env node
/**
 * scout task-21：V5 gate 层失败的结构化统计（可复跑）。
 *
 * 输入（只读）：
 *   - docs/eval/frozen/cases.real.v2.jsonl
 *   - docs/eval/summary-v2-layered.json
 *   - /tmp/scout-v5/gate-cases.json（由 extract-v5-gate-cases.mjs 生成，含逐案上下文）
 * 输出：stdout 统计 + JSON（默认 /tmp/scout-v5/metrics.json，含逐案指标）。
 *
 * 统计口径与说明见 docs/research/v5-failure-analysis.md。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ROOT = '/Users/lzx/Documents/GitHub/dsh-commander'
const casesPath = `${ROOT}/docs/eval/frozen/cases.real.v2.jsonl`
const summaryPath = `${ROOT}/docs/eval/summary-v2-layered.json`
const extractedPath = '/tmp/scout-v5/gate-cases.json'
const outPath = '/tmp/scout-v5/metrics.json'

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const cases = readFileSync(casesPath, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
const extracted = JSON.parse(readFileSync(extractedPath, 'utf8'))
const caseById = new Map(cases.map(item => [item.id, item]))
const resultById = new Map(summary.caseResults.map(row => [row.id, row]))

/** gate = 除 obvious(named-cue easy) / capability(观测) / should-ask 之外的层。 */
const gateResults = summary.caseResults.filter(row => !['obvious', 'capability', 'should-ask'].includes(row.layer))
const gateIds = new Set(gateResults.map(row => row.id))
const wsName = new Map()
for (const item of cases) for (const ws of item.workspaces ?? []) wsName.set(ws.id, ws.name)

const isCorrect = row => row.targetCorrect === true

/** 字符 bigram：CJK 混排够用；用于量化「期望会话标题 vs 选中会话标题，谁与任务文本更接近」。 */
const bigrams = (text) => {
  const chars = Array.from(String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, ''))
  const set = new Set()
  for (let i = 0; i + 1 < chars.length; i += 1) set.add(chars[i] + chars[i + 1])
  return set
}
const overlap = (needleText, haystackText) => {
  const needle = bigrams(needleText)
  if (needle.size === 0) return 0
  const haystack = bigrams(haystackText)
  let hit = 0
  for (const gram of needle) if (haystack.has(gram)) hit += 1
  return hit / needle.size
}

const rows = gateResults.map((row) => {
  const item = caseById.get(row.id)
  const extractedRow = extracted.rows.find(candidate => candidate.id === row.id)
  const expectedSession = (item.sessions ?? []).find(session => session.id === item.expected?.sessionId)
  const chosenSession = (item.sessions ?? []).find(session => session.id === row.chosenSessionId)
  const goalText = `${item.task?.goal ?? ''} ${item.task?.title ?? ''}`
  return {
    id: row.id,
    layer: row.layer,
    targetCorrect: row.targetCorrect,
    workspaceCorrect: row.workspaceCorrect,
    modeCorrect: row.modeCorrect,
    sessionCorrect: row.sessionCorrect,
    expectedWorkspace: wsName.get(row.expectedWorkspaceId) ?? null,
    chosenWorkspace: wsName.get(row.chosenWorkspaceId) ?? null,
    expectedMode: row.expectedMode,
    chosenMode: row.chosenMode,
    pWorkspace: row.pWorkspace,
    pSession: row.pSession,
    expectedSessionTitle: expectedSession?.title ?? null,
    chosenSessionTitle: chosenSession?.title ?? null,
    // 「期望会话标题」在任务文本里的复现度；chosen 同理（两者都算，便于比较 D/E）
    goalVsExpectedTitle: expectedSession?.title ? overlap(expectedSession.title, goalText) : null,
    goalVsChosenTitle: chosenSession?.title ? overlap(chosenSession.title, goalText) : null,
    expectedWsSummary: extractedRow?.expectedWorkspace?.summary ?? null,
  }
})

const wrong = rows.filter(row => !isCorrect(row))
const by = (predicate) => rows.filter(predicate).length
const pairCounts = {}
for (const row of wrong) {
  const key = `${row.expectedWorkspace} -> ${row.chosenWorkspace}`
  pairCounts[key] = (pairCounts[key] ?? 0) + 1
}
const chosenCounts = {}
for (const row of wrong) chosenCounts[row.chosenWorkspace] = (chosenCounts[row.chosenWorkspace] ?? 0) + 1

// 期望是 attach 的错案：比较「任务文本 ↔ 期望会话标题」与「任务文本 ↔ 选中会话标题」的 bigram 复现度
const attachWrong = wrong.filter(row => row.expectedSessionTitle !== null)
const signalPresent = attachWrong.filter(row => row.expectedSessionTitle !== null && row.goalVsExpectedTitle !== null
  && (row.goalVsChosenTitle === null || row.goalVsExpectedTitle > row.goalVsChosenTitle))

const metrics = {
  generatedAt: new Date().toISOString(),
  caseSha256: summary.caseFileSha256,
  gate: {
    n: rows.length,
    targetCorrect: by(isCorrect),
    workspaceCorrect: by(row => row.workspaceCorrect),
    modeCorrect: by(row => row.modeCorrect),
    sessionCorrect: by(row => row.sessionCorrect),
    workspaceCorrectButModeWrong: by(row => row.workspaceCorrect && !row.modeCorrect),
    workspaceWrongButModeCorrect: by(row => !row.workspaceCorrect && row.modeCorrect),
    workspaceWentToDotDsh: by(row => row.expectedWorkspace !== '.dsh' && row.chosenWorkspace === '.dsh'),
    confidentButWrong: by(row => !isCorrect(row) && row.pWorkspace >= 0.8),
  },
  confusionExpectedToChosen: Object.entries(pairCounts).sort((a, b) => b[1] - a[1]),
  chosenWorkspaceFrequencyOnWrong: Object.entries(chosenCounts).sort((a, b) => b[1] - a[1]),
  attachSignal: {
    attachWrong: attachWrong.length,
    signalPresentInGoalText: signalPresent.length,
    rows: attachWrong.map(row => ({
      id: row.id,
      expectedTitle: row.expectedSessionTitle,
      chosenTitle: row.chosenSessionTitle,
      goalVsExpectedTitle: Number(row.goalVsExpectedTitle.toFixed(3)),
      goalVsChosenTitle: row.goalVsChosenTitle === null ? null : Number(row.goalVsChosenTitle.toFixed(3)),
    })),
  },
  rows,
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(metrics, undefined, 2) + '\n')
process.stdout.write(JSON.stringify({ gate: metrics.gate, confusion: metrics.confusionExpectedToChosen, chosenFreq: metrics.chosenWorkspaceFrequencyOnWrong, attachSignal: { attachWrong: metrics.attachSignal.attachWrong, signalPresent: metrics.attachSignal.signalPresentInGoalText } }, undefined, 2) + '\n')
process.stdout.write(`\nattach signal rows:\n`)
for (const row of metrics.attachSignal.rows) {
  process.stdout.write(`- ${row.id}: expected«${row.expectedTitle}» vs chosen«${row.chosenTitle}» goalOverlap ${row.goalVsExpectedTitle} / ${row.goalVsChosenTitle}\n`)
}
process.stdout.write(`\nwrote ${outPath}\n`)
