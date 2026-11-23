#!/usr/bin/env node
/**
 * 冻结案例集校验工具：确认审计/复跑用的输入未被篡改（证据链可复查）。
 *
 * 用法：
 *   node tests/v5-audit/verify.mjs [--dir tests/v5-audit/frozen] [--name v2]
 * 校验：meta.json 存在；cases/labels 的 sha256 与字节数与 meta 一致；只读位；
 *       案例数/分层计数与 meta 一致；dispatchTime 与 cases 的 _provenance 一致（若有）。
 * 兼容 backend 的 manifest 格式：`--manifest docs/eval/frozen/manifest.v2.json`
 *       （校验 casesFile 的 sha256 与 manifest.caseSha256 一致，并回显 generatorRev/seed/dispatchTime/violations）。
 * 退出码：0=通过；1=不一致/缺失。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const DIR = argOf('--dir', path.join(HERE, 'frozen'))
const NAME = argOf('--name', 'v2')
const MANIFEST = argOf('--manifest')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const repoRoot = path.resolve(HERE, '../..')
if (MANIFEST !== null) {
  const manifestFile = path.isAbsolute(MANIFEST) ? MANIFEST : path.join(repoRoot, MANIFEST)
  if (!fs.existsSync(manifestFile)) {
    console.error(`missing ${manifestFile}`)
    process.exit(1)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const casesFile = path.isAbsolute(manifest.casesFile) ? manifest.casesFile : path.join(repoRoot, manifest.casesFile)
  const problems = []
  if (!fs.existsSync(casesFile)) problems.push(`missing casesFile ${manifest.casesFile}`)
  else {
    const sha = sha256(fs.readFileSync(casesFile))
    if (sha !== manifest.caseSha256) problems.push(`cases sha256=${sha} ≠ manifest.caseSha256=${manifest.caseSha256}`)
  }
  if (manifest.leakViolations !== 0) problems.push(`manifest.leakViolations=${manifest.leakViolations}（应为 0）`)
  if (!manifest.dispatchTime?.min || !manifest.dispatchTime?.max) problems.push('manifest 缺 dispatchTime min/max（指标无法绑定 as-of 时刻）')
  if (problems.length > 0) {
    console.error(`FAIL manifest ${MANIFEST}:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`PASS manifest ${MANIFEST}: cases sha256 与 manifest 一致（${String(manifest.caseSha256).slice(0, 16)}…），generatorRev=${manifest.generatorRev}，seed=${manifest.seed}，summaryMode=${manifest.summaryMode}，dispatchTime=${manifest.dispatchTime.min}…${manifest.dispatchTime.max}，leakViolations=0`)
  console.log('注意：本命令只校验「冻结产物完整性」，不等于对 v2 案例内容/标签的独立审计（后者由 Lead 另开任务）。')
  process.exit(0)
}
const outDir = path.join(DIR, NAME)
const metaFile = path.join(outDir, 'meta.json')
if (!fs.existsSync(metaFile)) {
  console.error(`missing ${metaFile}`)
  process.exit(1)
}
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const problems = []
for (const [key, file] of [
  ['cases', 'cases.jsonl'],
  ['labels', 'labels.md'],
]) {
  const full = path.join(outDir, file)
  if (!fs.existsSync(full)) {
    problems.push(`missing ${file}`)
    continue
  }
  const buffer = fs.readFileSync(full)
  if (sha256(buffer) !== meta.sha256?.[key]) problems.push(`${file} sha256 与 meta 不一致（文件被改）`)
  if (buffer.length !== meta.bytes?.[key]) problems.push(`${file} 字节数与 meta 不一致`)
  const mode = fs.statSync(full).mode & 0o777
  if (mode !== 0o444) problems.push(`${file} 非只读（mode=${mode.toString(8)}）`)
}
const casesFile = path.join(outDir, 'cases.jsonl')
if (fs.existsSync(casesFile)) {
  const cases = fs.readFileSync(casesFile, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  if (cases.length !== meta.caseCount) problems.push(`caseCount=${cases.length} ≠ meta ${meta.caseCount}`)
  const layerCounts = {}
  for (const c of cases) {
    const layer = String(c.id).split('-').slice(2).join('-')
    layerCounts[layer] = (layerCounts[layer] ?? 0) + 1
  }
  if (JSON.stringify(layerCounts) !== JSON.stringify(meta.layerCounts)) problems.push(`layerCounts 与 meta 不一致：${JSON.stringify(layerCounts)}`)
  const provenanceTimes = new Set(cases.map((c) => c?._provenance?.dispatchTime).filter(Boolean))
  if (provenanceTimes.size > 0 && meta.dispatchTime !== null && !provenanceTimes.has(meta.dispatchTime)) {
    problems.push(`dispatchTime 不一致：meta=${meta.dispatchTime} cases=${[...provenanceTimes].join(',')}`)
  }
  if (meta.dispatchTime === null) problems.push('meta.dispatchTime 为空（无法把指标绑定到 as-of 时刻）')
}
if (problems.length > 0) {
  console.error(`FAIL ${NAME}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`PASS ${NAME}: ${meta.caseCount} cases, dispatchTime=${meta.dispatchTime}, cases sha256=${meta.sha256.cases.slice(0, 16)}…, 只读副本完整`)
