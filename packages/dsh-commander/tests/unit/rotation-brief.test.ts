// R1：交接简报纯函数（窗口/排序/上限/裁剪/确定性），契约 §4。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoffBrief, clipLine, formatRelativeTime, type HandoffBriefInput } from '../../src/host/rotation/brief.ts'
import { briefWindowStart } from '../../src/host/rotation/config.ts'
import type { TaskRecord } from '../../src/host/schema.ts'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0) // 2026-11-19 20:00 (Asia/Shanghai)
const DAY = 86_400_000

function task(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    v: 1,
    title: `任务 ${overrides.id}`,
    goal: '',
    status: 'done',
    workspaceId: 'ws-a',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [],
    version: 1,
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - DAY,
    lastActivityAt: NOW - DAY,
    ...overrides,
  }
}

function input(overrides: Partial<HandoffBriefInput> = {}): HandoffBriefInput {
  return {
    now: NOW,
    windowStart: NOW - DAY,
    periodDays: 1,
    generation: 3,
    workspace: { id: 'ws-a', name: 'Demo' },
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    tasks: [],
    userLines: [],
    includeUserTail: true,
    ...overrides,
  }
}

test('brief: 窗口过滤 + updatedAt 倒序 + 状态标签', () => {
  const brief = buildHandoffBrief(input({
    tasks: [
      task({ id: 't-old', title: '太早', status: 'done', updatedAt: NOW - 3 * DAY }),
      task({ id: 't-a', title: 'A', status: 'done', updatedAt: NOW - 3_600_000 }),
      task({ id: 't-b', title: 'B', status: 'review', updatedAt: NOW - 60_000 }),
      task({ id: 't-arch', title: '归档', status: 'archived', updatedAt: NOW - 60_000 }),
    ],
  }))
  assert.match(brief.text, /^\[commander-handoff\] 第 3 任交接简报/)
  const taskSection = brief.text.split('本周期任务')[1]?.split('当前未完成')[0] ?? ''
  assert.ok(taskSection.indexOf('#t-b') < taskSection.indexOf('#t-a'))
  assert.doesNotMatch(brief.text, /t-old|t-arch/)
  assert.equal(brief.stats.tasks, 2)
})

test('brief: 未完成按优先级 + 最近活动排序，blocked 带原因，永不裁剪', () => {
  const brief = buildHandoffBrief(input({
    tasks: [
      task({ id: 't-low', title: '低', status: 'queued', priority: 'low', lastActivityAt: NOW - 60_000 }),
      task({ id: 't-urgent', title: '急', status: 'blocked', priority: 'urgent', block: { reason: '证书缺失', since: NOW - 10_000 }, lastActivityAt: NOW - 10 * 60_000 }),
      task({ id: 't-running', title: '跑', status: 'running', priority: 'normal', lastActivityAt: NOW - 2 * 3_600_000 }),
      task({ id: 't-review', title: '审', status: 'review', priority: 'normal', lastActivityAt: NOW - 5 * 60_000 }),
      task({ id: 't-done', title: '完成', status: 'done', updatedAt: NOW - 1_000 }),
    ],
  }))
  const section = brief.text.split('当前未完成（4 条）：')[1]?.split('说明：')[0] ?? ''
  const urgentAt = section.indexOf('#t-urgent')
  const runningAt = section.indexOf('#t-running')
  const reviewAt = section.indexOf('#t-review')
  const lowAt = section.indexOf('#t-low')
  // priority 高→低；同优先级按 lastActivityAt 倒序（review 5m 前 > running 2h 前）
  assert.ok(urgentAt >= 0 && reviewAt > urgentAt && runningAt > reviewAt && lowAt > runningAt)
  assert.match(section, /阻塞：证书缺失/)
  assert.match(section, /最近活动 2h/)
  assert.match(section, /等验收/)
  assert.equal(brief.stats.unfinished, 4)
})

test('brief: 用户原话默认带、按窗口取最后 10 条、单条 ≤120 字、总量 ≤800 字', () => {
  const lines = Array.from({ length: 15 }, (_, index) => ({
    text: `第${index}条 ${'长'.repeat(200)}`,
    at: NOW - DAY + index * 1000,
  }))
  const brief = buildHandoffBrief(input({ userLines: lines }))
  const header = brief.text.match(/用户最近原话（(\d+) 条）：/)
  assert.ok(header !== null)
  const section = brief.text.split(header[0])[1]?.split('说明：')[0] ?? ''
  // 只保留最新若干条（总量 ≤800 字），旧的原话被丢弃
  assert.doesNotMatch(section, /第0条|第4条|第5条/)
  assert.match(section, /第14条/)
  assert.match(section, /第13条/)
  for (const line of section.split('\n').filter((item) => item.startsWith('- "'))) {
    assert.ok(Array.from(line).length <= 124)
  }
  const sectionChars = Array.from(section.replace(/\n/g, '')).length
  assert.ok(sectionChars <= 800 + 20)
  // 窗口外的不进简报
  const outside = buildHandoffBrief(input({ userLines: [{ text: '窗口外', at: NOW - 2 * DAY }] }))
  assert.doesNotMatch(outside.text, /用户最近原话/)
})

test('brief: includeUserTail=false 不输出该段', () => {
  const brief = buildHandoffBrief(input({ includeUserTail: false, userLines: [{ text: 'hello', at: NOW - 1000 }] }))
  assert.doesNotMatch(brief.text, /用户最近原话/)
  assert.equal(brief.stats.userLines, 0)
})

test('brief: 确定性（同输入逐字相同）且不读系统时钟', () => {
  const fixture: HandoffBriefInput = input({
    tasks: [task({ id: 't-1', title: 'A', status: 'review', updatedAt: NOW - 1000 })],
    userLines: [{ text: '先做 A', at: NOW - 2000 }],
  })
  assert.equal(buildHandoffBrief(fixture).text, buildHandoffBrief(fixture).text)
  assert.match(buildHandoffBrief(fixture).text, /窗口：\d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2}（1 天）/)
})

test('brief: 超长时先丢最旧用户原话、再丢最旧本周期任务，未完成段保留', () => {
  const tasks = [
    ...Array.from({ length: 20 }, (_, index) => task({
      id: `task-long-${index}`,
      title: `很长的任务标题 ${'甲'.repeat(80)} ${index}`,
      status: 'done',
      reportSummary: { text: `结论 ${'丙'.repeat(120)}`, at: NOW - 1000 },
      updatedAt: NOW - (20 - index) * 1000,
    })),
    task({ id: 'task-blocked', title: '阻塞任务', status: 'blocked', priority: 'urgent', block: { reason: '等证书', since: NOW - 1000 }, lastActivityAt: NOW - 1000 }),
  ]
  const lines = Array.from({ length: 10 }, (_, index) => ({ text: `用户原话 ${'乙'.repeat(100)} ${index}`, at: NOW - 10_000 + index }))
  const brief = buildHandoffBrief(input({ tasks, userLines: lines }))
  assert.ok(brief.stats.chars <= 4_096)
  assert.equal(brief.stats.truncated, true)
  assert.match(brief.text, /简报已截断/)
  assert.match(brief.text, /#task-blocked/)
  assert.ok(brief.stats.userLines < 10)
})

test('brief: 空段省略标题；待确认派发有专门一行', () => {
  const empty = buildHandoffBrief(input())
  assert.doesNotMatch(empty.text, /本周期任务|当前未完成|用户最近原话/)
  assert.match(empty.text, /说明：本简报只是交接摘要/)
  const pending = buildHandoffBrief(input({ pendingDispatch: { taskId: 'task-x', decisionId: 'dec-1' } }))
  assert.match(pending.text, /待确认派发：\n- 任务 #task-x 的派发确认仍待处理/)
})

test('briefWindowStart：至少覆盖一个周期（首次启用后立刻换任不空窗），但不早于上次换任', () => {
  const now = 10 * 864_000_000
  // 本任刚开始 1 小时（周期 1 天）→ 窗口回退到 1 天前，能带上当天任务
  assert.equal(briefWindowStart({ generationStartedAt: now - 3_600_000, periodDays: 1 }, now), now - 86_400_000)
  // 本任已跑 3 天（周期 1 天）→ 窗口从 3 天前起（不丢跨日任务）
  assert.equal(briefWindowStart({ generationStartedAt: now - 3 * 86_400_000, periodDays: 1 }, now), now - 3 * 86_400_000)
  // 周期 3 天、本任 1 小时 → 窗口 3 天前
  assert.equal(briefWindowStart({ generationStartedAt: now - 3_600_000, periodDays: 3 }, now), now - 3 * 86_400_000)
  // 缺失起始时间（旧配置）→ 周期起点
  assert.equal(briefWindowStart({ generationStartedAt: 0, periodDays: 1 }, now), now - 86_400_000)
})

test('brief 工具函数：clipLine 折叠空白并按码点截断；相对时间粒度', () => {
  assert.equal(clipLine('  a\n\tb   c  ', 100), 'a b c')
  assert.equal(Array.from(clipLine('😀😀😀😀', 3)).length, 3)
  assert.equal(formatRelativeTime(NOW - 30_000, NOW), '<1m')
  assert.equal(formatRelativeTime(NOW - 90_000, NOW), '1m')
  assert.equal(formatRelativeTime(NOW - 2 * 3_600_000, NOW), '2h')
  assert.equal(formatRelativeTime(NOW - 3 * DAY, NOW), '3d')
})
