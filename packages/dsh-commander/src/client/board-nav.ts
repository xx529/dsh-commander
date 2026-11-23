/**
 * Sidebar navigation entry for the board page (M4 user decision, 2026-11-19:
 * "任务看板" gets a permanent seat in the left sidebar).
 *
 * The DSH sidebar owns the row: `sidebar.panellist` is a root-scoped list whose
 * entries are only the *icon* component, while the button, its `aria-label`,
 * the selected background, and the collapsed-rail tooltip are rendered by
 * `@deepseek-ai/dsh-client-ui-sidebar` from the entry's `label` and `order`.
 * Clicking the row selects the `main` keyed panel whose key equals this
 * entry's `id`, so the id must stay identical to the board page registration
 * (`BOARD_PANEL_ID`); selecting an unregistered main key throws.
 *
 * Kept free of JSX so `tests/client/nav.test.ts` can exercise the registration
 * contract under Node's type stripper (importing `index.tsx` would pull TSX in).
 */
import type { Disposer, SlotsService, SlotComponent } from './types'
// Explicit `.ts` extension: this module is also imported directly by
// `tests/client/nav.test.ts` under Node's ESM resolver.
import { NS } from './locales.ts'

/**
 * `main` keyed page id. Also the `sidebar.panellist` entry id: the sidebar
 * resolves a clicked row's panel by this exact string.
 */
export const BOARD_PANEL_ID = 'commander-board'

/**
 * Row order inside the sidebar's panel list. Shipped rows use 0 (Plugins),
 * 10 (Automation tasks), 20 (Context insight) and 30 (Capability panel); the
 * board sits last, directly above the shell's More button.
 */
export const BOARD_NAV_ORDER = 40

/** Faces the registration needs: the slot service, the translator, the icon. */
export interface BoardNavDeps {
  slots: SlotsService
  /** Namespace-bound translate function (`t('board.nav')`). */
  t: (key: string) => string
  /** Icon component rendered inside the sidebar row's glyph cell. */
  component: SlotComponent
}

/**
 * Register the sidebar row for the board page.
 *
 * `slots.inject` is declaration-aware: the entry is (re)installed whenever the
 * sidebar declares `sidebar.panellist`, so activation order with the sidebar
 * does not matter, and it is disposed with the slot.
 * @param deps - slot service, translator and icon component.
 * @returns the disposer owned by the slot registration.
 */
export function registerBoardNav({ slots, t, component }: BoardNavDeps): Disposer {
  return slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: BOARD_PANEL_ID,
    order: BOARD_NAV_ORDER,
    locale: NS,
    label: () => t('board.nav'),
  }, component))
}
