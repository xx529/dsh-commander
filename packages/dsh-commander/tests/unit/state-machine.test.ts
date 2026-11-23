// 统一任务状态机（task-state-machine-final §3/§7）：迁移矩阵、actor 权限、守卫与副作用。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRecord } from '../../src/host/schema.ts'
import { checkTransition, effectsSummary, restoreTargetOf, transitionTask } from '../../src/host/tasks/state-machine.ts'
import { createStores } from '../../src/host/store/index.ts'
import { commanderDomainSpec } from '../../src/host/domain.ts'
import { createFakeStorageDomain } from '../fakes/fakes.ts'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    v: 1,
    id: 'task_sm',
    title: 'T',
    goal: 'G',
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

const acceptance = [{ id: 'acc_1', text: 'A', source: 'commander' as const, state: 'evidence_present' as const }]

test('allowed edges are actor-scoped; unlisted edges are rejected', () => {
  assert.equal(checkTransition(task({ status: 'draft' }), 'proposed', { actor: 'host_dispatch' }).ok, true)
  assert.equal(checkTransition(task({ status: 'draft' }), 'proposed', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'review', acceptance }), 'queued', { actor: 'host_dispatch', hasPrimarySession: true }).ok, true)
  assert.equal(checkTransition(task({ status: 'review', acceptance }), 'queued', { actor: 'commander_tool', hasPrimarySession: true }).ok, false)
  assert.equal(checkTransition(task({ status: 'running' }), 'done', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'running' }), 'archived', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'blocked', block: { reason: 'x', since: 1 } }), 'proposed', { actor: 'commander_tool', round: 1 }).ok, true)
  assert.equal(checkTransition(task({ status: 'archived', archivedFrom: 'done' }), 'done', { actor: 'user_restore' }).ok, true)
  assert.equal(checkTransition(task({ status: 'archived', archivedFrom: 'done' }), 'draft', { actor: 'host_turn' }).ok, false)
})

test('guards: review acceptance, queued session, blocked reason, blocked→proposed round 1', () => {
  assert.equal(checkTransition(task({ status: 'running' }), 'review', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'running' }), 'review', { actor: 'commander_tool', acceptanceCount: 1 }).ok, true)
  assert.equal(checkTransition(task({ status: 'proposed' }), 'queued', { actor: 'host_dispatch' }).ok, false)
  assert.equal(checkTransition(task({ status: 'proposed' }), 'queued', { actor: 'host_dispatch', hasPrimarySession: true }).ok, true)
  assert.equal(checkTransition(task({ status: 'draft' }), 'blocked', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'draft' }), 'blocked', { actor: 'commander_tool', blockReason: 'waiting' }).ok, true)
  const round2 = task({ status: 'blocked', block: { reason: 'x', since: 1 }, round: 2 })
  assert.equal(checkTransition(round2, 'proposed', { actor: 'commander_tool' }).ok, false)
  const withHistory = task({ status: 'blocked', block: { reason: 'x', since: 1 }, round: 1, acceptanceHistory: [{ round: 1, at: 1, items: acceptance }] })
  assert.equal(checkTransition(withHistory, 'proposed', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'blocked', block: { reason: 'x', since: 1 } }), 'running', { actor: 'commander_tool' }).ok, false)
  assert.equal(checkTransition(task({ status: 'blocked', block: { reason: 'x', since: 1 }, primarySessionId: 's' }), 'running', { actor: 'commander_tool' }).ok, true)
  // 人恢复 archived→review 不要求当前 acceptance 条数（历史记录可能已清空）
  assert.equal(checkTransition(task({ status: 'archived', archivedFrom: 'review' }), 'review', { actor: 'user_restore' }).ok, true)
})

test('effects: clear block/pending, stamp archivedFrom, restore target, summary', () => {
  const leavingBlocked = checkTransition(task({ status: 'blocked', block: { reason: 'x', since: 1 } }), 'running', { actor: 'host_turn', hasPrimarySession: true })
  assert.equal(leavingBlocked.ok, true)
  if (leavingBlocked.ok) {
    assert.equal(leavingBlocked.effects.clearBlock, true)
    assert.equal(leavingBlocked.effects.timelineType, 'status')
  }
  const archive = checkTransition(task({ status: 'review', acceptance }), 'archived', { actor: 'user_archive' })
  assert.equal(archive.ok, true)
  if (archive.ok) {
    assert.equal(archive.effects.stampArchivedFrom, true)
    assert.equal(archive.effects.clearPendingInstruction, true)
    assert.match(effectsSummary(archive.effects), /archive-from/)
  }
  assert.equal(restoreTargetOf({ archivedFrom: 'review' }), 'review')
  assert.equal(restoreTargetOf({ archivedFrom: 'done' }), 'done')
  assert.equal(restoreTargetOf({ archivedFrom: 'cancelled' }), 'draft')
  assert.equal(restoreTargetOf({}), 'draft')
})

test('transitionTask applies effects/domain mutate and rejects stale expectedRevision without writing', async () => {
  const stores = createStores(await createFakeStorageDomain().open(commanderDomainSpec))
  await stores.tasks.put(task({ status: 'blocked', block: { reason: 'waiting', since: 1 }, primarySessionId: 's1', pendingInstruction: { text: 'again', at: 1, source: 'rework' } }))
  const stale = await transitionTask({ stores, now: () => 100 }, { taskId: 'task_sm', to: 'running', actor: 'commander_tool', expectedVersion: 99 })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.code, 'version_conflict')
  assert.equal(stores.tasks.get('task_sm')?.status, 'blocked')
  const ok = await transitionTask({ stores, now: () => 100 }, { taskId: 'task_sm', to: 'running', actor: 'commander_tool', expectedVersion: 1, timelineText: '恢复' })
  assert.equal(ok.ok, true)
  if (!ok.ok) return
  assert.equal(ok.changed, true)
  assert.equal(ok.task.status, 'running')
  assert.equal(ok.task.block, undefined)
  assert.equal(ok.task.timeline.at(-1)?.text, '恢复')
})
