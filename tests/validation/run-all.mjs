#!/usr/bin/env node
/**
 * V1–V4 独立复核一键脚本（tester；只读 devops 证据，独立复跑输出到 tests/validation/runs/**）。
 *
 * 用法：
 *   node tests/validation/run-all.mjs                 # 断言 devops 证据（docs/validation/vN-artifacts）
 *   node tests/validation/run-all.mjs --base rerun    # 断言 tester 独立复跑输出（tests/validation/runs/vN）
 *   node tests/validation/run-all.mjs --base rerun --runs-dir tests/validation/runs-upstream  # 断言上游脚本从零复跑输出
 *   node tests/validation/run-all.mjs --emit          # 输出断言用的结构化结果（JSON，供审计文档引用）
 *   node tests/validation/run-all.mjs --run           # 先执行独立复跑（setup + run-v1..v4），再断言
 *
 * 独立复跑（--run）的实现：tests/validation/repro/run-all.tester.sh
 *   - 新隔离 DSH_HOME：tests/validation/.probe-tester（不触碰 ~/.dsh、不碰 live Desktop）
 *   - 输出：tests/validation/runs/v{1,2,3,4}/（不覆盖 docs/validation/v*-artifacts）
 * 退出码：0=全部关键断言 PASS；1=有 FAIL；2=输入缺失；3=复跑失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const BASE = argOf('--base', 'devops')
const EMIT = has('--emit')
const DO_RUN = has('--run')
const RUNS_DIR = argOf('--runs-dir', path.join(HERE, 'runs'))
const artRoot = BASE === 'rerun' ? (path.isAbsolute(RUNS_DIR) ? RUNS_DIR : path.join(ROOT, RUNS_DIR)) : path.join(ROOT, 'docs/validation')

if (DO_RUN) {
  try {
    execFileSync('bash', [path.join(HERE, 'repro/run-all.tester.sh')], { cwd: ROOT, stdio: 'inherit', timeout: 900000 })
  } catch (error) {
    console.error(`independent rerun failed: ${error?.message ?? error}`)
    process.exit(3)
  }
}

const checks = []
const add = (version, id, ok, evidence) => checks.push({ version, id, ok: Boolean(ok), evidence: String(evidence ?? '') })
const readJson = (rel) => {
  const [dir, ...rest] = rel.split('/')
  // devops: docs/validation/vN-artifacts/<file>；rerun: tests/validation/runs/vN/<file>
  const file = BASE === 'rerun' ? path.join(artRoot, dir.replace(/^v(\d)-artifacts$/, 'v$1'), ...rest) : path.join(artRoot, rel)
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
const pickItem = (rankJson, name) => (rankJson?.result?.items ?? []).find((item) => item.name === name)
const V1 = (f) => readJson(`v1-artifacts/${f}`)
const V2 = (f) => readJson(`v2-artifacts/${f}`)
const V3 = (f) => readJson(`v3-artifacts/${f}`)
const V4 = (f) => readJson(`v4-artifacts/${f}`)

try {
  // ---------------------------------------------------------------- V1
  const a1 = V1('A1-c5-health.json')
  add('V1', 'C5 面板禁用回退 inherit/panel_unavailable', a1.fallback?.mode === 'inherit' && a1.fallback?.reason === 'panel_unavailable' && a1.panelResolved === false, `fallback=${JSON.stringify(a1.fallback)} panelResolved=${a1.panelResolved}`)
  const b0 = V1('B0-health.json')
  add('V1', 'C1 工厂 thunk 解析（panelResolved=true, function）', b0.panelResolved === true && b0.panelRawType === 'function' && b0.panelVersion === '1.19.3', `panelResolved=${b0.panelResolved} rawType=${b0.panelRawType} version=${b0.panelVersion}`)
  const b2 = V1('B2-rank-cold.json')
  add('V1', 'C2 冷会话 rank 正向返回（ok, items>0, 真 key）', b2.result?.ok === true && (b2.result?.items?.length ?? 0) > 0, `ok=${b2.result?.ok} items=${b2.result?.items?.length} model=${b2.model ?? b2.result?.model ?? 'n/a'}`)
  const b3 = V1('B3-apply-cold.json')
  add('V1', 'C3 冷会话 apply 入队 pending:true, applied:0', b3.result?.pending === true && b3.result?.applied === 0, `result=${JSON.stringify({ pending: b3.result?.pending, applied: b3.result?.applied })}`)
  const b5 = V1('B5-create-cold.json')
  add('V1', 'C3 create({sessionId}) 建出同一 id', b5.result?.sessionId === b5.requestedSessionId && b5.error === null, `sessionId=${b5.result?.sessionId} requested=${b5.requestedSessionId}`)
  const b7 = V1('B7-apply-replay.json')
  add('V1', 'C3 排队计划重放 applied:1', b7.result?.pendingOutcome?.applied === 1 && b7.result?.pending === false, `pendingOutcome=${JSON.stringify(b7.result?.pendingOutcome)}`)
  const b8 = V1('B8-rank-after-replay.json')
  const probe8 = pickItem(b8, 'probe-e2e-testing')
  add('V1', 'C3 二次 rank 计划内能力 enabledInSession=true', probe8?.applicable === true && probe8?.enabledInSession === true, `probe-e2e-testing enabledInSession=${probe8?.enabledInSession} score=${probe8?.score}`)
  const b11 = V1('B11-apply-disable-all.json')
  const b12 = pickItem(V1('B12-rank-after-disable.json'), 'probe-e2e-testing')
  const b14 = V1('B14-apply-enable.json')
  const b15 = pickItem(V1('B15-rank-after-enable.json'), 'probe-e2e-testing')
  add('V1', 'C4 会话级 enable/disable 往返（disabled:1→false；enabled:1→true）', b11.result?.disabled === 1 && b12?.enabledInSession === false && b14.result?.enabled === 1 && b15?.enabledInSession === true, `disable=${b11.result?.disabled}/${b12?.enabledInSession} enable=${b14.result?.enabled}/${b15?.enabledInSession}`)

  // ---------------------------------------------------------------- V2
  const plain = V2('v2-scenario-plain.json')
  add('V2', 'C1 plain turn/end + 最后 assistant seq + 注入一次', plain.decisionAtEnd?.shouldInject === true && plain.inject1?.injected === true && plain.decisionAtEnd?.lastSeq === plain.lastInjected?.seq, `decision=${plain.decisionAtEnd?.shouldInject} lastSeq=${plain.decisionAtEnd?.lastSeq} injected=${plain.inject1?.injected}`)
  add('V2', 'C2 去重：二次 shouldInject=false reason=duplicate', plain.inject2?.shouldInject === false && plain.inject2?.reason === 'duplicate', `inject2=${JSON.stringify({ shouldInject: plain.inject2?.shouldInject, reason: plain.inject2?.reason })}`)
  const wait = V2('v2-approval-wait.json')
  const pendingApprovals = wait.pendingInteractionSnapshot?.approvals?.length ?? wait.decisionDuringWait?.pending?.approvals?.length ?? 0
  add('V2', 'C3 未配对 approval/asked → 不注入（pendingInteraction）', wait.approvalWait?.released === false && wait.decisionDuringWait?.shouldInject === false && pendingApprovals > 0, `released=${wait.approvalWait?.released} duringWait.shouldInject=${wait.decisionDuringWait?.shouldInject} pendingApprovals=${pendingApprovals}`)
  const release = V2('v2-approval-release.json')
  add('V2', 'C3 放行后一次注入 + duplicate（allowed-once 配对）', release.approvalPairs?.[0]?.outcome === 'allowed-once' && release.inject1?.injected === true && release.inject2?.shouldInject === false && release.inject2?.reason === 'duplicate', `outcome=${release.approvalPairs?.[0]?.outcome} inject1=${release.inject1?.injected} inject2=${release.inject2?.reason}`)
  const cross = V2('v2-cross-turn.json')
  add('V2', 'C4 跨 turn 新键 → 可再次注入（dedupeKey turn2）', cross.decisionAfter?.shouldInject === true && cross.decisionAfter?.turnId === 2 && cross.previousLastInjected?.turnId === 1, `decisionAfter=${JSON.stringify({ shouldInject: cross.decisionAfter?.shouldInject, turnId: cross.decisionAfter?.turnId, dedupeKey: cross.decisionAfter?.dedupeKey })}`)

  // ---------------------------------------------------------------- V3
  const createCwd = V3('v3-create-cwd.json')
  add('V3', 'C1 create({cwd}) headerCwd 落点正确', createCwd.cwdMatches === true && typeof createCwd.headerCwd === 'string', `headerCwd=${createCwd.headerCwd} cwdMatches=${createCwd.cwdMatches}`)
  const createBoth = V3('v3-create-both.json')
  add('V3', 'C2 参数互斥被拒（workspaceId+cwd）', createBoth.rejected === true, `rejected=${createBoth.rejected} error=${createBoth.error}`)
  const badPreset = V3('v3-create-bad-preset.json')
  add('V3', 'C3 bad preset 失败路径明确', badPreset.rejected === true && /Unknown agent preset/.test(String(badPreset.error)), `rejected=${badPreset.rejected} error=${badPreset.error}`)
  const selectModel = V3('v3-select-model.json')
  add('V3', 'C4 selectModel 生效（probe-stub/stub-1）', /probe-stub/.test(JSON.stringify(selectModel)) && /stub-1/.test(JSON.stringify(selectModel)), `selected=${JSON.stringify(selectModel.selected ?? selectModel).slice(0, 120)}`)
  const prompt = V3('v3-prompt.json')
  add('V3', 'C4 stub prompt 唤醒 turn/end completed', prompt.accepted?.accepted === true && prompt.turnEnd?.reasonKind === 'completed' && (prompt.assistantMessages?.length ?? 0) > 0, `turnEnd=${JSON.stringify(prompt.turnEnd)} assistant=${prompt.assistantMessages?.length}`)
  let before
  try {
    before = V3('v3-before-restart.json')
  } catch {
    // devops 归档了派生文件 v3-before-restart.json；复跑脚本只产 probe 原始文件
    before = V3('v3-before-restart-probe.json')
  }
  add('V3', 'C5 重启前持久快照（cursor/turnEnds）', before.lastSeq === 20 && (before.turnEnds?.length ?? 0) === 1, `lastSeq=${before.lastSeq} turnEnds=${JSON.stringify(before.turnEnds)}`)
  const resume = V3('v3-resume.json')
  add('V3', 'C5/C6 重启后 resume 同 id、无新会话、turn2 completed', resume.sessionIdUnchanged === true && resume.turnEnd?.turn === 2 && resume.turnEnd?.reasonKind === 'completed' && (resume.agentsAfter ?? []).includes(resume.sessionId ?? before.sessionId), `sessionIdUnchanged=${resume.sessionIdUnchanged} turnEnd=${JSON.stringify(resume.turnEnd)} agentsAfter=${JSON.stringify(resume.agentsAfter)}`)

  // ---------------------------------------------------------------- V4
  const renamed = V4('v4-run-renamed.json')
  const cases = renamed.cases ?? {}
  const caseIds = Object.keys(cases)
  add('V4', 'C1–C7 裁定后（board_edits）全部 ok', renamed.ok === true && caseIds.length >= 7 && caseIds.every((id) => cases[id]?.ok === true) && (renamed.tables ?? []).includes('board_edits'), `cases=${caseIds.join(',')} all_ok=${caseIds.every((id) => cases[id]?.ok === true)}`)
  const restart = V4('v4-restart-check.json')
  add('V4', 'C6 重启持久（version/task/session/config）', restart.ok === true && (restart.tables ?? []).includes('board_edits') && restart.task?.version >= 2 && restart.configSingleton?.commanderSessionId !== undefined, `version=${restart.task?.version} configSingleton=${JSON.stringify(restart.configSingleton)}`)
  add('V4', 'C3 非法 key 拒绝且 sanitize 可写、域不脏', cases.C3_keys?.ok === true && cases.C3_keys?.afterRejectOk === true && cases.C3_keys?.sanitize?.matchesRe === true, `C3=${JSON.stringify(cases.C3_keys).slice(0, 200)}`)
  const blueprint = V4('v4-run-blueprint.json')
  add('V4', '缺陷证据保留：蓝图原名 boardEdits 实测 C1 FAIL', blueprint.ok === false && /invalid table name 'boardEdits'/.test(JSON.stringify(blueprint)), `blueprint.ok=${blueprint.ok}`)
  // ---------------------------------------------------------------- V5（抽样复核：冻结案例/审计/离线 mock；live 用 task-12 独立 evidence 交叉）
  const run = (file, args) => {
    try {
      execFileSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: 'pipe', timeout: 180000, encoding: 'utf8' })
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: String(error?.stderr ?? error?.message ?? error).slice(0, 300) }
    }
  }
  const v5Cases = path.join(ROOT, 'docs/eval/frozen/cases.real.v2.jsonl')
  const v5Manifest = path.join(ROOT, 'docs/eval/frozen/manifest.v2.json')
  const tmp = path.join(HERE, 'runs/_v5')
  fs.mkdirSync(tmp, { recursive: true })
  const v5Validate = run('tools/eval/validate-cases.mjs', [v5Cases])
  add('V5', 'C1 冻结案例 50 条过 schema', v5Validate.ok, v5Validate.ok ? 'validate-cases exit 0' : v5Validate.detail)
  const v5Audit = run('tools/eval/audit-cases.mjs', [v5Cases, '--expect-sha256', JSON.parse(fs.readFileSync(v5Manifest, 'utf8')).caseSha256, '--out', path.join(tmp, 'v5-audit-cases.json')])
  add('V5', 'C1 A1–A12 输入完整性 violations=0（复跑）', v5Audit.ok, v5Audit.ok ? 'audit-cases exit 0（未改 backend 产物）' : v5Audit.detail)
  const v5Verify = run('tests/v5-audit/verify.mjs', ['--manifest', v5Manifest])
  add('V5', 'C1 冻结副本完整性（verify --manifest）', v5Verify.ok, v5Verify.ok ? 'manifest/cases sha 一致' : v5Verify.detail)
  const v5Mock = run('tools/jev-eval.mjs', [v5Cases, '--mock', '--out', path.join(tmp, 'v5-mock-report.md'), '--summary-out', path.join(tmp, 'v5-mock-summary.json')])
  add('V5', 'harness --mock 报告口径可跑通（非门禁）', v5Mock.ok && fs.existsSync(path.join(tmp, 'v5-mock-summary.json')), v5Mock.ok ? 'mock summary 已生成' : v5Mock.detail)
  const liveSummary = path.join(HERE, '..', 'v5-audit/live/summary-v2-layered-rerun.json')
  const backendSummary = path.join(ROOT, 'docs/eval/summary-v2-layered.json')
  if (fs.existsSync(liveSummary) && fs.existsSync(backendSummary)) {
    const live = JSON.parse(fs.readFileSync(liveSummary, 'utf8'))
    const backend = JSON.parse(fs.readFileSync(backendSummary, 'utf8'))
    const keys = ['workspaceTop1', 'sessionTop1Attach', 'modeAccuracy', 'targetCorrect']
    const maxDelta = Math.max(...keys.map((key) => Math.abs((live.metrics?.gate?.[key] ?? NaN) - (backend.metrics?.gate?.[key] ?? NaN))))
    add('V5', 'C2–C4 live 门禁指标独立复跑可复现（task-12 证据，Δ≤5pp）', Number.isFinite(maxDelta) && maxDelta <= 0.05, `tester rerun vs backend gate 最大 Δ=${(maxDelta * 100).toFixed(1)}pp（n=28；工作区 14.3%、attach 5.6%、全对 7.1%）`)
  } else {
    add('V5', 'C2–C4 live 指标复核', false, 'UNVERIFIED：无 task-12 独立复跑 summary（见 docs/validation/audit-V5-v2.md）')
  }
  add('V5', 'V5 结论 FAIL（gate 工作区 14.3% ≪ 85%，阈值无组合达标）', (backendSummary && fs.existsSync(backendSummary)) ? (JSON.parse(fs.readFileSync(backendSummary, 'utf8')).gates?.['C2-workspace-top1'] === false) : false, 'backend gates.C2=false；详见 audit-V5-v2.md')
} catch (error) {
  console.error(`evidence read failed (base=${BASE}): ${error?.message ?? error}`)
  process.exit(2)
}

const failed = checks.filter((check) => !check.ok)
if (EMIT) {
  console.log(JSON.stringify({ base: BASE, artifactRoot: artRoot, checks, summary: { total: checks.length, pass: checks.length - failed.length, fail: failed.length } }, undefined, 2))
} else {
  console.log(`V1–V4 关键断言（证据源：${artRoot}，base=${BASE}）`)
  for (const version of ['V1', 'V2', 'V3', 'V4', 'V5']) {
    console.log(`\n## ${version}`)
    for (const check of checks.filter((item) => item.version === version)) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id} —— ${check.evidence}`)
    }
  }
  console.log(`\n汇总：${checks.length - failed.length}/${checks.length} PASS，${failed.length} FAIL`)
  if (failed.length > 0) {
    console.log('FAIL 明细：')
    for (const check of failed) console.log(`  - ${check.version} ${check.id}：${check.evidence}`)
  }
}
process.exit(failed.length === 0 ? 0 : 1)
