#!/usr/bin/env node
/**
 * 案例集冻结工具（门禁证据链要求，Lead 2026-11-17 决议）。
 *
 * 背景：v1 案例在审计进行中被 v2 就地覆盖 → 审计/复跑无法复查同一份输入。
 * 规则：任何用于门禁的案例产物必须先 freeze 成只读副本 + sha256 + dispatchTime 记录；
 *       审计/复跑只读冻结副本；新版本另存路径（cases.real.v2.jsonl 等）。
 *
 * 用法：
 *   node tests/v5-audit/freeze.mjs \
 *     --cases docs/eval/cases.real.v2.jsonl \
 *     --labels docs/eval/labels.cases.v2.md \
 *     --name v2 [--dir tests/v5-audit/frozen] [--force]
 * 产物：<dir>/<name>/{cases.jsonl, labels.md, meta.json}（cases/labels 置为 0444 只读）
 * 退出码：0=冻结成功；1=输入缺失/已存在（无 --force）。
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
const CASES = argOf('--cases')
const LABELS = argOf('--labels')
const NAME = argOf('--name', 'v2')
const DIR = argOf('--dir', path.join(HERE, 'frozen'))
const FORCE = argv.includes('--force')
if (!CASES || !LABELS || !fs.existsSync(CASES) || !fs.existsSync(LABELS)) {
  console.error('usage: node tests/v5-audit/freeze.mjs --cases <cases.jsonl> --labels <labels.md> --name v2 [--dir ...] [--force]')
  process.exit(1)
}
const outDir = path.join(DIR, NAME)
if (fs.existsSync(outDir) && !FORCE) {
  console.error(`already frozen: ${outDir}（加 --force 覆盖；覆盖会破坏证据链，慎用）`)
  process.exit(1)
}
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const casesBuffer = fs.readFileSync(CASES)
const labelsBuffer = fs.readFileSync(LABELS)
const cases = casesBuffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
const labelsText = labelsBuffer.toString('utf8')
const dispatchTime =
  labelsText.match(/dispatchTime=([0-9T:.Z-]+)/)?.[1] ??
  cases.find((c) => c?._provenance?.dispatchTime)?._provenance.dispatchTime ??
  null
const layerOf = (id) => String(id).split('-').slice(2).join('-')
const layerCounts = {}
for (const c of cases) layerCounts[layerOf(c.id)] = (layerCounts[layerOf(c.id)] ?? 0) + 1

fs.mkdirSync(outDir, { recursive: true })
const casesCopy = path.join(outDir, 'cases.jsonl')
const labelsCopy = path.join(outDir, 'labels.md')
fs.writeFileSync(casesCopy, casesBuffer)
fs.writeFileSync(labelsCopy, labelsBuffer)
fs.chmodSync(casesCopy, 0o444)
fs.chmodSync(labelsCopy, 0o444)
const meta = {
  name: NAME,
  frozenAt: new Date().toISOString(),
  frozenBy: 'tester / tests/v5-audit/freeze.mjs',
  source: { cases: path.relative(process.cwd(), path.resolve(CASES)), labels: path.relative(process.cwd(), path.resolve(LABELS)) },
  bytes: { cases: casesBuffer.length, labels: labelsBuffer.length },
  sha256: { cases: sha256(casesBuffer), labels: sha256(labelsBuffer) },
  caseCount: cases.length,
  layerCounts,
  dispatchTime,
  rule: '审计与 live 复跑只读本目录冻结副本；新版本另存路径，不得就地覆盖。',
}
fs.writeFileSync(path.join(outDir, 'meta.json'), `${JSON.stringify(meta, undefined, 2)}\n`)
console.log(`frozen ${NAME}: ${cases.length} cases → ${path.relative(process.cwd(), outDir)}`)
console.log(`  cases  sha256=${meta.sha256.cases}`)
console.log(`  labels sha256=${meta.sha256.labels}`)
console.log(`  dispatchTime=${dispatchTime}`)
