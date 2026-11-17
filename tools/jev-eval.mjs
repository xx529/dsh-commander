// Jev dispatch evaluation harness (no dependencies, Node 18+).
//
// Usage:
//   JEV_API_KEY=... node tools/jev-eval.mjs docs/eval/cases.real.jsonl
//   JEV_API_KEY=... node tools/jev-eval.mjs docs/eval/cases.real.jsonl --out docs/eval/report.md
//   node tools/jev-eval.mjs docs/eval/cases.sample.jsonl --mock
//
// Case schema: docs/eval/cases.schema.json
// Design: docs/eval/jev-dispatch-eval.md

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
const outIdx = argv.indexOf('--out')
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null
const mock = argv.includes('--mock')
const endpoint = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone'
const apiKey = process.env.JEV_API_KEY || ''
const model = process.env.JEV_MODEL || 'jev-latest'

if (!file) {
  console.error('usage: node tools/jev-eval.mjs <cases.jsonl> [--out report.md] [--mock]')
  process.exit(1)
}
if (!mock && !apiKey) {
  console.error('JEV_API_KEY is required unless --mock is used')
  process.exit(1)
}

const cases = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l, i) => {
    try {
      return JSON.parse(l)
    } catch (e) {
      throw new Error(`invalid JSON on line ${i + 1}: ${e.message}`)
    }
  })

function uniqueWorkspaces(c) {
  return [...new Set(c.workspaces.map((w) => w.id))]
    .map((id) => c.workspaces.find((w) => w.id === id))
    .filter(Boolean)
}

function buildRequest(c) {
  const workspaces = uniqueWorkspaces(c)
  const sessions = c.sessions.filter((s) => !s.archived)
  const wIndex = new Map(workspaces.map((w, i) => [w.id, `w_${i}`]))
  const sIndex = new Map(sessions.map((s, i) => [s.id, `s_${i}`]))

  const workspaceCriteria = {}
  for (const w of workspaces) {
    workspaceCriteria[wIndex.get(w.id)] = {
      what: `${w.name}（${w.path || w.id}）`,
      why: w.summary || '未配置摘要',
      not_for: w.capabilityDigest ? `能力：${w.capabilityDigest}` : undefined,
    }
  }

  const sessionCriteria = {
    new: { what: '新建会话', why: '上下文干净；适合独立任务' },
  }
  for (const s of sessions) {
    sessionCriteria[sIndex.get(s.id)] = {
      what: `${s.title} · ${s.workspaceId}`,
      why: `最近活动 ${s.lastActiveAt || '未知'}`,
      not_for: s.contextUsage != null ? `上下文 ${Math.round(s.contextUsage * 100)}%` : undefined,
    }
  }

  const questions = {
    workspace: {
      type: 'choice',
      instructions: '哪个工作区最适合这个任务？综合考虑职责、历史任务与能力匹配。',
      criteria: workspaceCriteria,
    },
    session: {
      type: 'choice',
      instructions: '哪个会话最适合？如果没有合适的已有会话，选 new。',
      criteria: sessionCriteria,
    },
  }

  const state = {
    task: c.task,
    command: c.command || { text: '' },
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      summary: w.summary || '',
      recentTasks: w.recentTasks || [],
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
      contextUsage: s.contextUsage,
    })),
    constraints: { allowedWorkspaces: workspaces.map((w) => w.id) },
  }

  return { body: { model, state, questions }, wIndex, sIndex, workspaces, sessions }
}

function mockAnswers(c, built) {
  const answers = {}
  const expected = c.expected || {}
  const wKey = built.wIndex.get(expected.workspaceId)
  const sKey = expected.mode === 'attach' ? built.sIndex.get(expected.sessionId) : 'new'
  answers.workspace = { type: 'choice', choice: wKey, probabilities: { [wKey]: 0.86 }, confidence: 0.72 }
  answers.session = { type: 'choice', choice: sKey, probabilities: { [sKey]: 0.83 }, confidence: 0.66 }
  return answers
}

async function callJev(body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Jev ${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

function topProb(answer) {
  if (!answer || answer.type !== 'choice') return 0
  return answer.probabilities?.[answer.choice] ?? 0
}

function evaluate(c, built, resp) {
  const expected = c.expected || {}
  const answers = resp.answers || {}
  const wAnswer = answers.workspace
  const sAnswer = answers.session
  const chosenW = wAnswer?.choice
  const chosenS = sAnswer?.choice

  const workspaceId = built.wIndex.has(expected.workspaceId)
    ? [...built.wIndex.entries()].find(([, k]) => k === chosenW)?.[0]
    : undefined
  const sessionId = [...built.sIndex.entries()].find(([, k]) => k === chosenS)?.[0]
  const mode = chosenS === 'new' ? 'new' : 'attach'
  const chosenSession = built.sessions.find((s) => s.id === sessionId)
  const conflict = mode === 'attach' && chosenSession && workspaceId && chosenSession.workspaceId !== workspaceId

  const workspaceCorrect = workspaceId === expected.workspaceId
  const modeCorrect = mode === expected.mode
  const sessionCorrect = expected.mode === 'new' ? mode === 'new' : sessionId === expected.sessionId
  const targetCorrect = workspaceCorrect && modeCorrect && sessionCorrect && !conflict

  return {
    id: c.id,
    tags: c.tags || [],
    chosenWorkspace: workspaceId || null,
    chosenSession: sessionId || null,
    mode,
    workspaceCorrect,
    modeCorrect,
    sessionCorrect,
    targetCorrect,
    conflict,
    pWorkspace: topProb(wAnswer),
    cWorkspace: wAnswer?.confidence ?? 0,
    pSession: topProb(sAnswer),
    cSession: sAnswer?.confidence ?? 0,
  }
}

function sweep(results) {
  const pGrid = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
  const cGrid = [0.3, 0.4, 0.5, 0.6, 0.7]
  const rows = []
  for (const pw of pGrid) {
    for (const ps of pGrid) {
      for (const cc of cGrid) {
        const passed = results.filter(
          (r) => r.pWorkspace >= pw && r.pSession >= ps && r.cWorkspace >= cc && r.cSession >= cc,
        )
        if (passed.length === 0) continue
        const correct = passed.filter((r) => r.targetCorrect).length
        rows.push({
          pWorkspace: pw,
          pSession: ps,
          confidence: cc,
          coverage: passed.length / results.length,
          precision: correct / passed.length,
          auto: passed.length,
          correct,
        })
      }
    }
  }
  return rows
    .filter((r) => r.precision >= 0.95)
    .sort((a, b) => b.coverage - a.coverage || b.precision - a.precision)
    .slice(0, 10)
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`
}

function report(results, thresholds, meta) {
  const n = results.length
  const acc = (f) => results.filter(f).length / n
  const lines = []
  lines.push('# Jev dispatch evaluation')
  lines.push('')
  lines.push(`- cases: ${n}`)
  lines.push(`- endpoint: ${meta.endpoint}`)
  lines.push(`- model: ${meta.model}`)
  lines.push(`- mode: ${meta.mock ? 'mock' : 'live'}`)
  lines.push('')
  lines.push('## Accuracy')
  lines.push('')
  lines.push(`- workspace top-1: ${pct(acc((r) => r.workspaceCorrect))}`)
  lines.push(`- mode: ${pct(acc((r) => r.modeCorrect))}`)
  lines.push(`- session top-1 (attach cases): ${pct(acc((r) => (r.mode === 'attach' || r.modeCorrect) && r.sessionCorrect))}`)
  lines.push(`- target correct: ${pct(acc((r) => r.targetCorrect))}`)
  lines.push(`- workspace/session conflict: ${results.filter((r) => r.conflict).length}`)

  lines.push('')
  lines.push('## Threshold sweep (precision ≥ 95%)')
  lines.push('')
  lines.push('| pWorkspace | pSession | confidence | coverage | precision |')
  lines.push('|---:|---:|---:|---:|---:|')
  for (const r of thresholds) {
    lines.push(`| ${r.pWorkspace} | ${r.pSession} | ${r.confidence} | ${pct(r.coverage)} | ${pct(r.precision)} |`)
  }
  if (thresholds.length === 0) lines.push('| - | - | - | - | no combination reached 95% |')
  lines.push('')
  lines.push('## Cases')
  lines.push('')
  lines.push('| id | tags | expected | chosen | target | pW | pS |')
  lines.push('|---|---|---|---|---|---:|---:|')
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${(r.tags || []).join(', ')} | ${r.chosenWorkspace ?? '-'} / ${r.mode} | ${r.chosenSession ?? 'new'} | ${r.targetCorrect ? '✅' : '❌'} | ${r.pWorkspace.toFixed(2)} | ${r.pSession.toFixed(2)} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

const results = []
for (const c of cases) {
  const built = buildRequest(c)
  const resp = mock ? { answers: mockAnswers(c, built) } : await callJev(built.body)
  results.push(evaluate(c, built, resp))
  process.stderr.write(`. ${c.id} ${results.at(-1).targetCorrect ? 'ok' : 'miss'}\n`)
}

const thresholds = sweep(results)
const md = report(results, thresholds, { endpoint, model, mock })
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, md)
  console.log(`wrote ${outFile}`)
} else {
  console.log(md)
}
