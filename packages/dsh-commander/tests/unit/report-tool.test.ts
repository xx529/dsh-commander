// M3 commander_task_report 工具：schema/seq 校验/只整理不评估/状态迁移与 evidence 状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommanderTools } from '../../src/host/tools/index.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeAgent, createFakeCtx, createFakeStorageDomain } from '../fakes/fakes.ts'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRecord } from '../../src/host/schema.ts'


async function setup(taskOverrides: Partial<TaskRecord> = {}, events: Array<{ seq: number }> = [{ seq: 1 }, { seq: 5 }, { seq: 10 }]) {
  const domain = await createFakeStorageDomain().open(commanderDomainSpec)
  const stores = createStores(domain)
  const task: TaskRecord = {
    v: 1, id: 'task_report_1', title: '报告任务', goal: '整理报告', status: 'running', workspaceId: 'ws-a', priority: 'normal',
    commandId: '', primarySessionId: 'session-work-1', assignments: ['session-work-1'], acceptance: [], timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1, createdAt: 1, updatedAt: 1, lastActivityAt: 1, ...taskOverrides,
  }
  await stores.tasks.put(task)
  const ctx = createFakeCtx({
    services: {
      sessions: { get: async (sessionId: string) => ({ id: sessionId, events }) },
      sessionQuery: { listSessions: async () => [] },
      workspaceRegistry: { list: async () => [], get: async () => undefined },
    },
  }) as never
  const tools = createCommanderTools({
    ctx,
    stores,
    dispatchService: { dispatchTask: async () => ({ status: 'rejected', code: 'x', message: 'x' }), currentPending: () => null, prune: () => 0, decisions: {} as never },
    commanderSessionId: () => 'session-commander',
    now: () => 5000,
  })
  await tools.prepare()
  const spec = tools.specs()?.commander_task_report as { parameters?: unknown; output: { schema: unknown }; execute: (args: unknown, exec: unknown) => Promise<unknown> }
  const exec = { agent: createFakeAgent({ sessionId: 'session-commander' }), signal: { throwIfAborted: () => undefined } }
  return { stores, tools, spec, exec }
}

test('commander_task_report writes acceptance/timeline and sets review for delivered outcome', async () => {
  const { stores, tools, spec, exec } = await setup()
  const result = (await spec.execute({
    taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'delivered',
    acceptance: [
      { text: '导出功能可用', evidence: 'commit abc123', derivedFromSeq: 5 },
      { text: '未覆盖边界', verify: '需要补充用例', derivedFromSeq: 8 },
    ],
    summary: '本轮完成导出修复，测试通过；边界用例待补。',
  }, exec)) as { taskId: string; status: string; evidenceState: string; insufficient?: string[] }
  assert.equal(result.status, 'review')
  assert.equal(result.evidenceState, 'insufficient')
  assert.deepEqual(result.insufficient, ['未覆盖边界'])
  const task = stores.tasks.get('task_report_1')
  assert.equal(task?.status, 'review')
  assert.equal(task?.acceptance.length, 2)
  assert.equal(task?.acceptance[0]?.state, 'evidence_present')
  assert.equal(task?.acceptance[1]?.state, 'insufficient')
  assert.deepEqual(task?.acceptance[0]?.derivedFrom, { sessionId: 'session-work-1', seq: 5 })
  // summary 原文必须落库（看板抽屉「整理报告」行展示），时间取本次整理的 now。
  assert.deepEqual(task?.reportSummary, { text: '本轮完成导出修复，测试通过；边界用例待补。', at: 5000, round: 1 })
  assert.equal(task?.timeline.at(-1)?.type, 'report')
  assert.equal(task?.timeline.at(-1)?.round, 1)
  tools.dispose()
})

test('commander_task_report summary：空串不落库（保留旧摘要）；blocked 报告也写 summary', async () => {
  const kept = await setup()
  await kept.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'blocked', acceptance: [], summary: '等外部依赖' }, kept.exec)
  assert.deepEqual(kept.stores.tasks.get('task_report_1')?.reportSummary, { text: '等外部依赖', at: 5000, round: 1 })
  await kept.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'no_progress', acceptance: [], summary: '' }, kept.exec)
  // 空 summary 不清空上一次摘要
  assert.deepEqual(kept.stores.tasks.get('task_report_1')?.reportSummary, { text: '等外部依赖', at: 5000, round: 1 })
  kept.tools.dispose()
})

test('commander_task_report blocked/no_progress outcome 状态迁移', async () => {
  const blocked = await setup()
  const blockedResult = (await blocked.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'blocked', acceptance: [{ text: 'A', evidence: 'e', derivedFromSeq: 2 }], summary: 'blocked' }, blocked.exec)) as { status: string }
  assert.equal(blockedResult.status, 'blocked')
  const noProgress = await setup()
  const runningResult = (await noProgress.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'no_progress', acceptance: [], summary: 'none' }, noProgress.exec)) as { status: string }
  assert.equal(runningResult.status, 'running')
  blocked.tools.dispose()
  noProgress.tools.dispose()
})

test('commander_task_report rejects seq 越界/未绑定会话/缺 derivedFromSeq/非法 outcome', async () => {
  const { tools, spec, exec } = await setup()
  const outOfRange = (await spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 2, seqTo: 99, outcome: 'delivered', acceptance: [], summary: 's' }, exec)) as { ok: boolean; code: string }
  assert.equal(outOfRange.code, 'invalid_request')
  const unbound = (await spec.execute({ taskId: 'task_report_1', sessionId: 'session-other', seqFrom: 1, seqTo: 10, outcome: 'delivered', acceptance: [], summary: 's' }, exec)) as { ok: boolean; code: string }
  assert.equal(unbound.code, 'conflict')
  const missingSeq = (await spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'delivered', acceptance: [{ text: 'A' }], summary: 's' }, exec)) as { ok: boolean; code: string }
  assert.equal(missingSeq.code, 'invalid_request')
  const badOutcome = (await spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'nope', acceptance: [], summary: 's' }, exec)) as { ok: boolean; code: string }
  assert.equal(badOutcome.code, 'invalid_request')
  tools.dispose()
})


test('commander_task_report: review 必须有 acceptance（delivered/partial 空 → invalid_request 不改任务）；blocked 允许空', async () => {
  const rejected = await setup()
  const result = (await rejected.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'delivered', acceptance: [], summary: 's' }, rejected.exec)) as { ok: boolean; code: string; message: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_request')
  assert.match(result.message, /at least 1 acceptance/)
  // 任务保持原状态（running），未被写成 review
  assert.equal(rejected.stores.tasks.get('task_report_1')?.status, 'running')
  const partial = (await rejected.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'partial', acceptance: [], summary: 's' }, rejected.exec)) as { ok: boolean; code: string }
  assert.equal(partial.code, 'invalid_request')
  const blocked = (await rejected.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'blocked', acceptance: [], summary: 's' }, rejected.exec)) as { status?: string; ok?: boolean }
  assert.equal(blocked.status, 'blocked') // blocked 允许空 acceptance
  assert.equal(rejected.stores.tasks.get('task_report_1')?.status, 'blocked')
  // no_progress + 空 acceptance 也允许（→ running，不触发 review 不变量）
  const noProgress = await setup()
  const noProgressResult = (await noProgress.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'no_progress', acceptance: [], summary: 's' }, noProgress.exec)) as { status?: string; ok?: boolean }
  assert.equal(noProgressResult.status, 'running')
  assert.equal(noProgress.stores.tasks.get('task_report_1')?.status, 'running')
  noProgress.tools.dispose()
  rejected.tools.dispose()
})

test('commander_task_report round>1：只接受当前轮主会话，报告 summary 带 round', async () => {
  const ok = await setup({ round: 2, primarySessionId: 'session-work-1', assignments: ['session-work-1', 'session-old'] })
  const result = (await ok.spec.execute({ taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'delivered', acceptance: [{ text: 'A', evidence: 'e', derivedFromSeq: 2 }], summary: '第二轮' }, ok.exec)) as { status: string }
  assert.equal(result.status, 'review')
  const task = ok.stores.tasks.get('task_report_1')
  assert.equal(task?.reportSummary?.round, 2)
  assert.equal(task?.timeline.at(-1)?.round, 2)
  ok.tools.dispose()

  const stale = await setup({ round: 2, primarySessionId: 'session-work-1', assignments: ['session-work-1', 'session-old'] })
  const rejected = (await stale.spec.execute({ taskId: 'task_report_1', sessionId: 'session-old', seqFrom: 1, seqTo: 10, outcome: 'delivered', acceptance: [{ text: 'A', evidence: 'e', derivedFromSeq: 2 }], summary: '旧会话' }, stale.exec)) as { ok: boolean; code: string }
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'conflict')
  stale.tools.dispose()
})


test('commander_task_report 写入显式材料并自动归并 present 文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-commander-report-mat-'))
  try {
    const png = join(dir, 'shot.png')
    const pdf = join(dir, 'report.pdf')
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'))
    await writeFile(pdf, Buffer.from('%PDF-1.4\n% test\n', 'utf8'))
    const realPng = await realpath(png)
    const events = [
      { seq: 1 },
      { seq: 5, type: 'deliverables/presented', data: { files: [{ path: png, description: '配置截图' }, { path: pdf, description: '评估报告' }] } },
      { seq: 10 },
    ] as never
    const { stores, tools, spec, exec } = await setup({}, events)
    const result = (await spec.execute({
      taskId: 'task_report_1', sessionId: 'session-work-1', seqFrom: 1, seqTo: 10, outcome: 'delivered',
      acceptance: [{ text: 'A', evidence: 'e', derivedFromSeq: 5 }],
      summary: '带材料',
      materials: [
        { kind: 'link', title: '官方发布记录', url: 'https://docs.z.ai/release-notes', acceptanceIndex: 0 },
        { kind: 'image', title: '配置截图', path: png, acceptanceIndex: 0 },
      ],
    }, exec)) as { materials: number; materialWarnings?: string[] }
    assert.equal(result.materials, 3)
    assert.equal(result.materialWarnings, undefined)
    const task = stores.tasks.get('task_report_1')
    assert.equal(task?.reportMaterials?.length, 3)
    const link = task?.reportMaterials?.find((material) => material.kind === 'link')
    assert.deepEqual(link?.acceptanceIds, [task?.acceptance[0]?.id])
    const image = task?.reportMaterials?.find((material) => material.kind === 'image')
    assert.equal(image?.path, realPng)
    assert.equal(image?.source, 'commander')
    assert.equal(task?.reportMaterials?.find((material) => material.kind === 'file')?.source, 'presented')
    assert.equal(task?.timeline.at(-1)?.type, 'report')
    assert.match(task?.timeline.at(-1)?.text ?? '', /材料 3 项/)
    tools.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
