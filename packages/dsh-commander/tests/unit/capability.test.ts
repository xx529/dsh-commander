import test from 'node:test'
import assert from 'node:assert/strict'
import { capabilitySummary, runAutoCapability } from '../../src/host/dispatch/capability.ts'
import { createFakeCtx } from '../fakes/fakes.ts'

const ctx = createFakeCtx()
const base = { ctx, sessionId: 'session-1', draft: 'draft', policy: 'auto' as const, now: () => 1000 }

test('runAutoCapability applies high-score items and records names', async () => {
  const result = await runAutoCapability({
    ...base,
    panelOverride: {
      jev: {
        getConfig: () => ({ threshold: 0.5 }),
        rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'browser', score: 0.9 }, { id: 'cap_2', name: 'shell', score: 0.2 }] }),
        apply: () => ({ ok: true, applied: 1, elapsedMs: 5, pending: false }),
      },
    },
  })
  assert.equal(result.plan.status, 'applied')
  assert.deepEqual(result.plan.enabled, ['browser'])
  assert.deepEqual(result.submitted, ['browser'])
  assert.equal(result.plan.durationMs, 5)
})

test('runAutoCapability falls back on missing/throwing panel, failed rank/apply, empty plan', async () => {
  assert.equal((await runAutoCapability({ ...base, panelOverride: undefined, ctx: createFakeCtx() })).plan.reason, 'panel_unavailable')
  assert.equal((await runAutoCapability({ ...base, panelOverride: { jev: {} } })).plan.reason, 'panel_shape_mismatch')
  const rankFail = await runAutoCapability({ ...base, panelOverride: { jev: { rank: () => ({ ok: false }), apply: () => ({ ok: true }) } } })
  assert.equal(rankFail.plan.reason, 'rank_failed')
  const rankThrow = await runAutoCapability({ ...base, panelOverride: { jev: { rank: () => { throw new Error('x') }, apply: () => ({ ok: true }) } } })
  assert.equal(rankThrow.plan.reason, 'rank_failed')
  const applyFail = await runAutoCapability({
    ...base,
    panelOverride: { jev: { rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'a', score: 1 }] }), apply: () => ({ ok: false }) } },
  })
  assert.equal(applyFail.plan.reason, 'apply_failed')
  const failedItems = await runAutoCapability({
    ...base,
    panelOverride: { jev: { rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'a', score: 1 }] }), apply: () => ({ ok: true, failed: [{ id: 'cap_1' }] }) } },
  })
  assert.equal(failedItems.plan.reason, 'apply_failed')
  const empty = await runAutoCapability({ ...base, panelOverride: { jev: { rank: () => ({ ok: true, items: [] }), apply: () => ({ ok: true }) } } })
  assert.equal(empty.plan.reason, 'empty_plan')
})

test('runAutoCapability marks pending replay and threshold default', async () => {
  const pending = await runAutoCapability({
    ...base,
    panelOverride: { jev: { rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'a', score: 1 }] }), apply: () => ({ ok: true, pending: true }) } },
  })
  assert.equal(pending.plan.status, 'applied')
  assert.equal(pending.plan.reason, 'pending_replay_on_agent_created')
  const defaulted = await runAutoCapability({
    ...base,
    panelOverride: { jev: { rank: () => ({ ok: true, items: [{ id: 'cap_1', name: 'a', score: 0.6 }] }), apply: () => ({ ok: true }) } },
  })
  assert.equal(defaulted.plan.reason, 'threshold_defaulted')
})

test('capabilitySummary maps plan to task summary status', () => {
  assert.deepEqual(capabilitySummary({ capabilities: undefined }), { status: 'none', enabledCount: 0, disabledCount: 0 })
  assert.equal(capabilitySummary({ capabilities: { policy: 'inherit', executor: 'capability-panel', status: 'inherited', enabled: [], disabled: [], at: 1 } }).status, 'inherit')
  assert.equal(capabilitySummary({ capabilities: { policy: 'auto', executor: 'capability-panel', status: 'applied', enabled: ['a', 'b'], disabled: [], durationMs: 3, at: 1 } }).enabledCount, 2)
  assert.equal(capabilitySummary({ capabilities: { policy: 'auto', executor: 'capability-panel', status: 'applied', enabled: ['a'], disabled: [], reason: 'pending_replay_on_agent_created', at: 1 } }).status, 'pending')
})
