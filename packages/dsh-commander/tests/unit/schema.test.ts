import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfigRecord, isConfigRecord, isReportMaterial, isTaskRecord, isWorkspaceRecord, createValueSchema } from '../../src/host/schema.ts'

test('default config record validates', () => {
  assert.equal(isConfigRecord(defaultConfigRecord(1)), true)
})

test('invalid config records are rejected', () => {
  const config = defaultConfigRecord(1) as unknown as Record<string, unknown>
  const wrong = { ...config, v: 2 }
  assert.equal(isConfigRecord(wrong), false)
  const badJev = { ...config, jev: { ...(config.jev as object), threshold: 0.1 } }
  assert.equal(isConfigRecord(badJev), false)
})

test('workspace record validator bounds summary and policy', () => {
  const record = { v: 1, id: 'ws', name: 'WS', path: '/tmp/ws', allowed: true, summary: 'x', summarySource: 'manual', capabilityPolicy: { mode: 'inherit' } }
  assert.equal(isWorkspaceRecord(record), true)
  assert.equal(isWorkspaceRecord({ ...record, summary: 'x'.repeat(501) }), false)
  assert.equal(isWorkspaceRecord({ ...record, capabilityPolicy: { mode: 'bogus' } }), false)
})

test('task record validator checks status enum and timeline', () => {
  const task = {
    v: 1,
    id: 'task_1',
    title: 't',
    goal: 'g',
    status: 'draft',
    workspaceId: 'ws',
    priority: 'normal',
    commandId: 'cmd_1',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
  assert.equal(isTaskRecord(task), true)
  assert.equal(isTaskRecord({ ...task, status: 'nope' }), false)
  assert.equal(isTaskRecord({ ...task, timeline: [{ at: 1, type: 'bogus', text: 'x' }] }), false)
  // reportSummary（commander_task_report 的 summary 原件）：可选；形状/长度受校验。
  assert.equal(isTaskRecord({ ...task, reportSummary: { text: '摘要', at: 2 } }), true)
  assert.equal(isTaskRecord({ ...task, reportSummary: { text: 'x'.repeat(801), at: 2 } }), false)
  assert.equal(isTaskRecord({ ...task, reportSummary: { text: '摘要' } }), false)
  // 报告材料字段：可选；形状受 kind/url/path/state 约束。
  const material = { id: 'mat_1', kind: 'link', title: '来源', url: 'https://example.com/a', source: 'commander', state: 'unverified' }
  assert.equal(isTaskRecord({ ...task, reportMaterials: [material] }), true)
  assert.equal(isTaskRecord({ ...task, reportMaterials: [{ ...material, url: 'javascript:alert(1)' }] }), false)
  assert.equal(isTaskRecord({ ...task, reportMaterials: [{ ...material, path: '/tmp/a' }] }), false)
  assert.equal(isTaskRecord({ ...task, reportMaterials: [{ ...material, kind: 'file' }] }), false)
})

test('report material validator enforces kind/url/path/state', () => {
  const link = { id: 'm1', kind: 'link', title: '来源', url: 'https://example.com/a', source: 'commander', state: 'unverified' }
  assert.equal(isReportMaterial(link), true)
  assert.equal(isReportMaterial({ ...link, url: 'ftp://example.com/a' }), false)
  assert.equal(isReportMaterial({ ...link, url: 'https://example.com/a', path: '/tmp/a' }), false)
  assert.equal(isReportMaterial({ ...link, title: 'x'.repeat(201) }), false)
  assert.equal(isReportMaterial({ ...link, state: 'bogus' }), false)
  const file = { id: 'm2', kind: 'file', title: '文档', path: '/tmp/a.pdf', source: 'presented', state: 'ok' }
  assert.equal(isReportMaterial(file), true)
  assert.equal(isReportMaterial({ ...file, kind: 'image' }), true)
  assert.equal(isReportMaterial({ id: 'm3', kind: 'image', title: '图', url: 'https://example.com/a.png', source: 'presented', state: 'unverified' }), true)
})

test('value schema parse throws invalid-record on bad data', () => {
  const schema = createValueSchema(isWorkspaceRecord, 'workspaces')
  assert.throws(() => schema.parse({ v: 1 }), /invalid-record/)
  assert.equal(schema.safeParse({ v: 1 }).success, false)
})
