#!/usr/bin/env node
/**
 * V5 案例集校验器（零依赖）：校验 cases.real.jsonl 是否符合 cases.schema.json，
 * 并核对六层分层计数（12/12/10/6/5/5，见 docs/architecture/validation-protocol.md §6.2 P1/P2）。
 *
 * 用法：
 *   node tools/eval/validate-cases.mjs [cases.jsonl] [--schema docs/eval/cases.schema.json]
 * 退出码：0=全部通过；1=有校验错误；2=输入缺失。
 *
 * 只读：不写文件、不打印任务正文。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flagOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const file = argv.find((argument) => !argument.startsWith('--')) ?? 'docs/eval/cases.real.jsonl'
const schemaFile = flagOf('--schema', 'docs/eval/cases.schema.json')
if (!fs.existsSync(file) || !fs.existsSync(schemaFile)) {
  console.error(`missing input: ${file} or ${schemaFile}`)
  process.exit(2)
}
const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'))
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
const cases = lines.map((line, index) => {
  try {
    return JSON.parse(line)
  } catch (error) {
    console.error(`line ${index + 1}: invalid JSON: ${error.message}`)
    process.exit(1)
  }
})

/** draft-07 子集校验（本项目 schema 只用到的关键字）。 */
const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)
function validate(value, spec, at, errors) {
  if (spec.type !== undefined) {
    const actual = typeOf(value)
    const expected = spec.type
    if (expected === 'number' ? actual !== 'number' || Number.isNaN(value) : actual !== expected) {
      errors.push(`${at}: expected ${expected}, got ${actual}`)
      return
    }
  }
  if (spec.enum !== undefined && !spec.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum ${JSON.stringify(spec.enum)}`)
  if (spec.type === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) errors.push(`${at}: ${value} < minimum ${spec.minimum}`)
    if (spec.maximum !== undefined && value > spec.maximum) errors.push(`${at}: ${value} > maximum ${spec.maximum}`)
  }
  if (spec.type === 'array') {
    if (spec.minItems !== undefined && value.length < spec.minItems) errors.push(`${at}: array length ${value.length} < minItems ${spec.minItems}`)
    if (spec.items !== undefined) value.forEach((item, index) => validate(item, spec.items, `${at}[${index}]`, errors))
  }
  if (spec.type === 'object' || spec.properties !== undefined) {
    for (const key of spec.required ?? []) {
      if (!(key in value)) errors.push(`${at}: missing required property "${key}"`)
    }
    const properties = spec.properties ?? {}
    for (const [key, propertyValue] of Object.entries(value)) {
      if (properties[key] !== undefined) validate(propertyValue, properties[key], `${at}.${key}`, errors)
      else if (spec.additionalProperties === false) errors.push(`${at}: unexpected property "${key}"`)
    }
  }
}

let failures = 0
cases.forEach((caseItem, index) => {
  const errors = []
  validate(caseItem, schema, `case#${index + 1}(${caseItem?.id ?? 'no-id'})`, errors)
  // V5 附加检查（schema 之外）
  const shouldAsk = (caseItem.tags ?? []).includes('should-ask') || (caseItem.tags ?? []).includes('needs_confirmation') || caseItem.expected?.needsConfirmation === true
  if (shouldAsk) {
    if (caseItem.expected?.needsConfirmation !== true) errors.push(`${caseItem.id}: should-ask 案例必须 expected.needsConfirmation=true`)
    if (caseItem.expected?.workspaceId !== undefined || caseItem.expected?.mode !== undefined) errors.push(`${caseItem.id}: should-ask 案例不得暴露 expected.workspaceId/mode`)
  } else {
    if (typeof caseItem.expected?.workspaceId !== 'string' || typeof caseItem.expected?.mode !== 'string') errors.push(`${caseItem.id}: 缺 expected.workspaceId/mode`)
  }
  if (caseItem.expected?.mode === 'attach' && typeof caseItem.expected?.sessionId !== 'string') errors.push(`${caseItem.id}: attach 案例缺 expected.sessionId`)
  if (caseItem.expected?.mode === 'attach' && !caseItem.sessions?.some((session) => session.id === caseItem.expected.sessionId)) {
    errors.push(`${caseItem.id}: expected.sessionId 不在 sessions 快照中`)
  }
  if (caseItem.expected?.mode === 'new' && caseItem.expected?.workspaceId !== undefined && !caseItem.workspaces?.some((workspace) => workspace.id === caseItem.expected.workspaceId)) {
    errors.push(`${caseItem.id}: expected.workspaceId 不在 workspaces 快照中`)
  }
  const byId = new Map((caseItem.workspaces ?? []).map((workspace) => [workspace.id, workspace]))
  for (const session of caseItem.sessions ?? []) {
    if (!byId.has(session.workspaceId)) errors.push(`${caseItem.id}: session ${session.id} 的 workspaceId 不在 workspaces 快照中`)
  }
  if (errors.length > 0) {
    failures += 1
    console.error(`\n❌ ${caseItem?.id ?? `case#${index + 1}`}`)
    for (const error of errors.slice(0, 10)) console.error(`   - ${error}`)
  }
})

const layerCounts = {}
for (const caseItem of cases) {
  const layer = (caseItem.tags ?? [])[0] ?? 'unknown'
  layerCounts[layer] = (layerCounts[layer] ?? 0) + 1
}
const EXPECTED_LAYERS = { obvious: 12, ambiguous: 12, 'old-session': 10, 'new-session': 6, capability: 5, 'should-ask': 5 }
const layerMismatches = Object.entries(EXPECTED_LAYERS).filter(([layer, expected]) => (layerCounts[layer] ?? 0) !== expected)
const modes = cases.reduce((acc, caseItem) => {
  acc[caseItem.expected?.mode ?? '?'] = (acc[caseItem.expected?.mode ?? '?'] ?? 0) + 1
  return acc
}, {})
const tags = cases.reduce((acc, caseItem) => {
  for (const tag of caseItem.tags ?? []) acc[tag] = (acc[tag] ?? 0) + 1
  return acc
}, {})
const summary = {
  file,
  cases: cases.length,
  schemaValid: failures === 0,
  layerCounts,
  layerExpected: EXPECTED_LAYERS,
  layerMismatches,
  modes,
  shouldAskCases: tags['should-ask'] ?? 0,
  needsReviewCases: tags['needs-review'] ?? 0,
  workspacesPerCase: { min: Math.min(...cases.map((caseItem) => caseItem.workspaces?.length ?? 0)), max: Math.max(...cases.map((caseItem) => caseItem.workspaces?.length ?? 0)) },
  sessionsPerCase: { min: Math.min(...cases.map((caseItem) => caseItem.sessions?.length ?? 0)), max: Math.max(...cases.map((caseItem) => caseItem.sessions?.length ?? 0)) },
}
console.log(JSON.stringify(summary, undefined, 2))
if (cases.length !== 50) console.error(`WARN: 案例数 ${cases.length} ≠ 50（V5-C1 要求 50）`)
if (layerMismatches.length > 0) console.error(`WARN: 分层计数不符：${JSON.stringify(layerMismatches)}`)
process.exitCode = failures === 0 && cases.length === 50 && layerMismatches.length === 0 ? 0 : 1
