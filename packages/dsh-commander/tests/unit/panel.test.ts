import test from 'node:test'
import assert from 'node:assert/strict'
import { resolvePanel } from '../../src/host/api/panel.ts'
import { createFakeCtx } from '../fakes/fakes.ts'

const panel = (jev: unknown) => ({ jev })

test('resolvePanel accepts object panel with jev.rank/apply functions', () => {
  const ctx = createFakeCtx({ services: { capabilityPanel: panel({ rank: () => 1, apply: () => 1 }) } })
  const resolution = resolvePanel(ctx)
  assert.equal(resolution.present, true)
})

test('resolvePanel accepts thunk form', () => {
  const ctx = createFakeCtx({ services: { capabilityPanel: () => panel({ rank: () => 1, apply: () => 1 }) } })
  assert.equal(resolvePanel(ctx).present, true)
})

test('resolvePanel rejects missing panel / wrong shape / missing rank-apply / throwing thunk', () => {
  assert.deepEqual(resolvePanel(createFakeCtx()), { present: false, reason: 'panel_unavailable' })
  assert.deepEqual(resolvePanel(createFakeCtx({ services: { capabilityPanel: panel({}) } })), { present: false, reason: 'panel_shape_mismatch' })
  assert.deepEqual(resolvePanel(createFakeCtx({ services: { capabilityPanel: panel({ rank: 1, apply: 1 }) } })), { present: false, reason: 'panel_shape_mismatch' })
  assert.deepEqual(resolvePanel(createFakeCtx({ services: { capabilityPanel: panel({ rank: () => 1 }) } })), { present: false, reason: 'panel_shape_mismatch' })
  const throwing = createFakeCtx({
    services: {
      capabilityPanel: () => {
        throw new Error('boom')
      },
    },
  })
  assert.deepEqual(resolvePanel(throwing), { present: false, reason: 'panel_threw' })
})
