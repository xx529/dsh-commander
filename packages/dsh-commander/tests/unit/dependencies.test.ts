// 任务依赖纯函数与 DAG 校验（task-state-machine-final §6.1）。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRecord } from '../../src/host/schema.ts'
import {
  dependenciesMet, dependencyMet, dependentsOf, hasPendingDependents, isReady, readyDependentsOf, unnotifiedReadyTasks, validateDependsOn, waitingFor,
} from '../../src/host/tasks/dependencies.ts'

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    id,
    title: id,
    goal: id,
    status: 'draft',
    workspaceId: 'ws',
    priority: 'normal',
    commandId: '',
    assignments: [],
    acceptance: [],
    timeline: [{ at: 1, type: 'created', text: 'created' }],
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }
}

const byId = (tasks: TaskRecord[]) => (id: string): TaskRecord | undefined => tasks.find((row) => row.id === id)

test('dependencyMet accepts done and done→archived only', () => {
  assert.equal(dependencyMet(task('a', { status: 'done' })), true)
  assert.equal(dependencyMet(task('a', { status: 'archived', archivedFrom: 'done' })), true)
  assert.equal(dependencyMet(task('a', { status: 'archived', archivedFrom: 'review' })), false)
  assert.equal(dependencyMet(task('a', { status: 'archived' })), false)
  assert.equal(dependencyMet(task('a', { status: 'review' })), false)
  assert.equal(dependencyMet(undefined), false)
})

test('ready/waitingFor derive only for draft/proposed', () => {
  const done = task('a', { status: 'done' })
  const pending = task('b', { status: 'review' })
  const lookup = byId([done, pending])
  assert.equal(dependenciesMet({ dependsOn: ['a'] }, lookup), true)
  assert.equal(dependenciesMet({ dependsOn: ['a', 'b'] }, lookup), false)
  assert.deepEqual(waitingFor({ dependsOn: ['a', 'b', 'missing'] }, lookup), ['b', 'missing'])
  assert.equal(isReady({ status: 'draft', dependsOn: ['a'] }, lookup), true)
  assert.equal(isReady({ status: 'proposed', dependsOn: ['a'] }, lookup), true)
  assert.equal(isReady({ status: 'draft', dependsOn: ['b'] }, lookup), false)
  assert.equal(isReady({ status: 'review', dependsOn: ['a'] }, lookup), false)
  assert.equal(isReady({ status: 'draft', dependsOn: [] }, lookup), true)
})

test('dependents and ready queue helpers', () => {
  const rows = [
    task('a', { status: 'done', updatedAt: 1 }),
    task('b', { dependsOn: ['a'], updatedAt: 20 }),
    task('c', { dependsOn: ['a'], status: 'proposed', updatedAt: 10 }),
    task('d', { dependsOn: ['b', 'c'] }),
    task('e'),
  ]
  const lookup = byId(rows)
  assert.deepEqual(dependentsOf(rows, 'a').map((row) => row.id), ['b', 'c'])
  assert.deepEqual(readyDependentsOf(rows, 'a', lookup).map((row) => row.id), ['c', 'b'])
  assert.deepEqual(unnotifiedReadyTasks(rows, lookup).map((row) => row.id).sort(), ['b', 'c'])
  const notified = rows.map((row) => row.id === 'b' ? { ...row, dependencyNotifiedAt: 5 } : row)
  assert.deepEqual(unnotifiedReadyTasks(notified, byId(notified)).map((row) => row.id), ['c'])
})

test('validateDependsOn enforces max/self/duplicate/missing/terminal/cycle', () => {
  const rows = [
    task('a'),
    task('b', { dependsOn: ['a'] }),
    task('c', { status: 'cancelled' }),
    task('d', { status: 'archived', archivedFrom: 'review' }),
  ]
  const lookup = byId(rows)
  assert.deepEqual(validateDependsOn('x', ['a', 'b'], lookup, rows), { ok: true, dependsOn: ['a', 'b'] })
  assert.equal(validateDependsOn('x', ['x'], lookup, rows).ok, false)
  assert.equal(validateDependsOn('x', ['a', 'a'], lookup, rows).ok, false)
  assert.equal(validateDependsOn('x', ['a', 'b', 'c', 'd', 'e', 'f'], lookup, rows).ok, false)
  assert.equal(validateDependsOn('x', ['missing'], lookup, rows).ok, false)
  assert.equal(validateDependsOn('x', ['c'], lookup, rows).ok, false)
  assert.equal(validateDependsOn('x', ['d'], lookup, rows).ok, false)
  // a→b 已有；给 a 加 b 会成环
  assert.equal(validateDependsOn('a', ['b'], lookup, rows).ok, false)
  // 允许依赖尚未 done 的任务（排期）
  assert.deepEqual(validateDependsOn('x', ['a'], lookup, rows), { ok: true, dependsOn: ['a'] })
  // ≤5 合法
  const many = ['a', 'b', 'c', 'd', 'e'].map((id) => task(id))
  assert.equal(validateDependsOn('x', ['a', 'b', 'c', 'd', 'e'], byId(many), many).ok, true)
})

test('hasPendingDependents: any unfinished dependent counts; done/cancelled/archived do not', () => {
  const base = task('a', { status: 'review' })
  const draft = task('b', { status: 'draft', dependsOn: ['a'] })
  const running = task('c', { status: 'running', dependsOn: ['a'] })
  const done = task('d', { status: 'done', dependsOn: ['a'] })
  const cancelled = task('e', { status: 'cancelled', dependsOn: ['a'] })
  const archived = task('f', { status: 'archived', archivedFrom: 'done', dependsOn: ['a'] })
  assert.equal(hasPendingDependents([base, draft], 'a'), true)
  assert.equal(hasPendingDependents([base, running], 'a'), true)
  assert.equal(hasPendingDependents([base, done], 'a'), false)
  assert.equal(hasPendingDependents([base, cancelled], 'a'), false)
  assert.equal(hasPendingDependents([base, archived], 'a'), false)
  assert.equal(hasPendingDependents([base], 'a'), false)
})
