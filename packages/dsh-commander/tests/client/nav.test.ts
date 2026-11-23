/**
 * Sidebar navigation contract (M4 user decision, 2026-11-19).
 *
 * The board page is reachable from the floating panel today; the user asked for
 * a permanent "任务看板" row in the DSH sidebar. The row must behave like every
 * shipped panel row: one `sidebar.panellist` entry whose id equals the `main`
 * keyed panel key (otherwise clicking it throws `selectPanel` on a missing
 * panel), icon-only component, label from the locale dictionaries, and an order
 * after the shipped rows (Plugins 0 / Automation 10 / Context 20 / Capability 30).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_NAV_ORDER, BOARD_PANEL_ID, registerBoardNav } from '../../src/client/board-nav.ts'
import { DICTIONARIES } from '../../src/client/locales.ts'

/** Fake `SlotsService` that records the inject name, options and component. */
function recordingSlots(): {
  slots: { inject: (name: string, register: () => unknown) => unknown; register: (options: Record<string, unknown>, component: unknown) => () => void }
  injected: string[]
  registrations: { options: Record<string, unknown>; component: unknown }[]
  dispose: () => void
} {
  const injected: string[] = []
  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const dispose = (): void => {}
  return {
    slots: {
      inject: (name, register) => { injected.push(name); return register() },
      register: (options, component) => { registrations.push({ options, component }); return dispose },
    },
    injected,
    registrations,
    dispose,
  }
}

test('board sidebar row registers one sidebar.panellist entry for the main board key', () => {
  const fake = recordingSlots()
  const icon = (): null => null
  const t = (key: string): string => (key === 'board.nav' ? '任务看板' : key)

  const disposer = registerBoardNav({ slots: fake.slots, t, component: icon })

  assert.deepEqual(fake.injected, ['sidebar.panellist'], '只有在侧栏声明该槽后才注册（declaration-aware inject）')
  assert.equal(fake.registrations.length, 1)
  const { options, component } = fake.registrations[0]
  assert.equal(options.name, 'sidebar.panellist')
  assert.equal(options.id, BOARD_PANEL_ID, 'id 必须与 main keyed 面板 key 相同，否则点击找不到面板')
  assert.equal(options.id, 'commander-board')
  assert.equal(options.order, BOARD_NAV_ORDER)
  assert.equal(options.order, 40, '排在已发布行 0/10/20/30 之后、More 之前')
  assert.equal(options.locale, 'dsh-commander')
  assert.equal(typeof options.label, 'function')
  assert.equal((options.label as () => string)(), '任务看板')
  assert.equal(component, icon, '侧栏只渲染图标本体，label/按钮/选中态由侧栏负责')
  assert.equal(disposer, fake.dispose, '注册的 disposer 必须原样返回给 ctx.slots.inject')
})

test('board sidebar label exists in both shipped dictionaries', () => {
  for (const [locale, dict] of Object.entries(DICTIONARIES)) {
    const label = dict['board.nav']
    assert.equal(typeof label, 'string', `${locale} 缺少 board.nav`)
    assert.ok((label as string).trim() !== '', `${locale} 的 board.nav 不能为空`)
  }
  assert.equal(DICTIONARIES.zh['board.nav'], '任务看板')
  assert.equal(DICTIONARIES.en['board.nav'], 'Task board')
})
