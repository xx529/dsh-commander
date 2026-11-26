/**
 * 窗口角色 → 渲染决策（2026-11-26 用户反馈：应用外球点开后球消失，期望球常驻）。
 *
 * 壳改成双窗口后：球窗口 `role=ball` 恒渲染球，面板窗口 `role=panel` 恒渲染面板；
 * 不带 role（浏览器调试/旧同窗两态）仍由 expanded 决定。旧实现只有 expanded 一态，
 * 面板打开时球必然消失——下面第 2 条断言在旧代码上无法通过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveWindowRole, showsPanel } from '../../src/client/window-role.ts'

test('resolveWindowRole only accepts ball/panel/bubble and falls back to the single-window mode', () => {
  assert.equal(resolveWindowRole('ball'), 'ball')
  assert.equal(resolveWindowRole('panel'), 'panel')
  assert.equal(resolveWindowRole('bubble'), 'bubble')
  assert.equal(resolveWindowRole(''), '')
  assert.equal(resolveWindowRole(undefined), '')
  assert.equal(resolveWindowRole('session'), '')
  assert.equal(resolveWindowRole(1), '')
})

test('the panel window always renders the panel; the ball window never does', () => {
  assert.equal(showsPanel('panel', false), true)
  assert.equal(showsPanel('panel', true), true)
  assert.equal(showsPanel('ball', false), false)
  // 关键回归：面板已打开（expanded=true）时球窗口仍必须渲染球。
  assert.equal(showsPanel('ball', true), false)
  assert.equal(showsPanel('bubble', false), false)
  assert.equal(showsPanel('bubble', true), false)
})

test('without a role the legacy single-window behaviour is unchanged', () => {
  assert.equal(showsPanel('', false), false)
  assert.equal(showsPanel('', true), true)
})
