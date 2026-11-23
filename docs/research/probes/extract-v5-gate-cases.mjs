#!/usr/bin/env node
/**
 * scout task-21：从 frozen v2 案例 + layered summary 抽出「gate 判错案例」的全部判定上下文，
 * 供人工/LLM 逐案判断「合理人类调度者能否仅凭该输入推断期望目标」。
 *
 * 只读：docs/eval/frozen/cases.real.v2.jsonl、docs/eval/summary-v2-layered.json。
 * 输入含用户真实正文，**输出只写 /tmp（建议）**，不要落进仓库。
 *
 * 用法：
 *   node extract-v5-gate-cases.mjs [--cases ...] [--summary ...] [--out /tmp/scout-v5/gate-cases.json] [--jsonl]
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argOf = (flag, fallback) => {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const ROOT = '/Users/lzx/Documents/GitHub/dsh-commander'
const casesPath = argOf('--cases', `${ROOT}/docs/eval/frozen/cases.real.v2.jsonl`)
const summaryPath = argOf('--summary', `${ROOT}/docs/eval/summary-v2-layered.json`)
const outPath = argOf('--out', '/tmp/scout-v5/gate-cases.json')
const asJsonl = process.argv.includes('--jsonl')

const trim = (text, limit) => {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  const chars = Array.from(value)
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : value
}
const shortSession = (id) => (typeof id === 'string' ? id.slice(-8) : null)

/** gate = non-named-cue：排除 named-cue easy（obvious）、观测层（capability）、should-ask。 */
const GATE_EXCLUDED_LAYERS = new Set(['obvious', 'capability', 'should-ask'])

const cases = readFileSync(casesPath, 'utf8').split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line))
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const resultById = new Map(summary.caseResults.map(row => [row.id, row]))

const rows = []
for (const item of cases) {
  const result = resultById.get(item.id)
  if (result === undefined) continue
  if (GATE_EXCLUDED_LAYERS.has(result.layer)) continue
  const workspaces = item.workspaces ?? []
  const sessions = item.sessions ?? []
  const wsById = new Map(workspaces.map(ws => [ws.id, ws]))
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const expectedWs = wsById.get(item.expected?.workspaceId)
  const chosenWs = wsById.get(result.chosenWorkspaceId)
  const expectedSession = sessionById.get(item.expected?.sessionId)
  const chosenSession = sessionById.get(result.chosenSessionId)
  const sessionsOf = (workspaceId) => sessions
    .filter(session => session.workspaceId === workspaceId)
    .sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))
    .slice(0, 6)
    .map(session => trim(session.title, 44))
  rows.push({
    id: item.id,
    layer: result.layer,
    tags: item.tags ?? [],
    targetCorrect: result.targetCorrect,
    workspaceCorrect: result.workspaceCorrect,
    modeCorrect: result.modeCorrect,
    sessionCorrect: result.sessionCorrect,
    expectedMode: result.expectedMode ?? item.expected?.mode ?? null,
    chosenMode: result.chosenMode,
    pWorkspace: result.pWorkspace,
    pSession: result.pSession,
    expectedWorkspace: expectedWs === undefined ? null : { name: expectedWs.name, path: expectedWs.path, summary: trim(expectedWs.summary, 160) },
    chosenWorkspace: chosenWs === undefined ? null : { name: chosenWs.name, path: chosenWs.path, summary: trim(chosenWs.summary, 100) },
    expectedSession: item.expected?.sessionId === undefined ? null : {
      idTail: shortSession(item.expected.sessionId),
      title: trim(expectedSession?.title, 60),
      lastActiveAt: expectedSession?.lastActiveAt ?? null,
    },
    chosenSession: result.chosenSessionId === undefined || result.chosenSessionId === null ? null : {
      idTail: shortSession(result.chosenSessionId),
      title: trim(chosenSession?.title, 60),
      lastActiveAt: chosenSession?.lastActiveAt ?? null,
    },
    taskTitle: trim(item.task?.title, 120),
    taskGoal: trim(item.task?.goal, 240),
    commandText: trim(item.command?.text, 160),
    dispatchAt: item._provenance?.dispatchAt ?? null,
    sourceSessionIdTail: shortSession(item._provenance?.sourceSessionId),
    sourceWorkspaceName: wsById.get(item._provenance?.sourceWorkspaceId)?.name ?? null,
    expectedWsSessionTitles: expectedWs === undefined ? [] : sessionsOf(expectedWs.id),
    chosenWsSessionTitles: chosenWs === undefined ? [] : sessionsOf(chosenWs.id),
  })
}

const output = {
  generatedAt: new Date().toISOString(),
  casesPath,
  summaryPath,
  caseSha256: summary.caseFileSha256,
  gateDefinition: 'exclude layers: obvious(named-cue easy) / capability(observational) / should-ask',
  gateCount: rows.length,
  wrongCount: rows.filter(row => row.targetCorrect !== true).length,
  rows,
}
mkdirSync(dirname(outPath), { recursive: true })
if (asJsonl) {
  writeFileSync(outPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
} else {
  writeFileSync(outPath, JSON.stringify(output, undefined, 2) + '\n')
}
const wrong = rows.filter(row => row.targetCorrect !== true)
process.stdout.write(`gate=${rows.length} wrong=${wrong.length} correct=${rows.length - wrong.length} -> ${outPath}\n`)
process.stdout.write(`wrong ids: ${wrong.map(row => row.id).join(', ')}\n`)
