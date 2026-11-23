/**
 * Client bundle entry for DSH Commander (M0).
 *
 * The bundle is a zero-runtime-dependency Client module: it imports only
 * `react` (supplied by the browser module table) and registers four slot
 * entries through Cordis:
 *   - `shell.overlay`     id `commander.floating` — the floating ball + panel
 *   - `settings.section`  id `commander`          — the settings skeleton
 *   - `main`              key `commander-board`   — the full board page
 *   - `sidebar.panellist` id `commander-board`    — the sidebar "任务看板" row
 *
 * No top-level side effects: the transport starts inside `apply` and every
 * registration is owned by the plugin context via `ctx.effect`.
 */
import { CommanderOverlay } from './Overlay'
import { CommanderSettingsSection } from './SettingsSection'
import { BoardPage } from './BoardPage'
import { BoardNavIcon } from './BoardNavIcon'
import { BOARD_NAV_ORDER, BOARD_PANEL_ID as BOARD_KEY, registerBoardNav } from './board-nav'
import { createCommanderStore } from './store'
import { DICTIONARIES, NS, fallbackTranslate } from './locales'
import type {
  ClientContext, ClientLocaleService, LayoutService, SlotComponent,
} from './types'
import { createLazySessionStatus, createOpenSession } from './lazy-services'

/**
 * Required services. `locale` is a hard requirement, not an optional one:
 * Cordis throws on reading an uninjected service (`cannot get property "locale"
 * without inject`), which would abort `apply` before any slot is registered.
 * Every shipped UI plugin that localizes its copy declares `locale` here.
 */
export const inject: string[] = ['slots', 'locale', 'layout']

/** Slot ids this bundle owns; `shell.overlay` stays additive, never a replacement. */
export const OVERLAY_ID = 'commander.floating'
export const SETTINGS_ID = 'commander'
/**
 * `main` keyed page id (layout reserves `conversation` for the chat). The same
 * string is the `sidebar.panellist` entry id, so a click on the sidebar row
 * selects this exact panel; both live in `./board-nav` for the unit test.
 */
export const BOARD_PANEL_ID = BOARD_KEY
export { BOARD_NAV_ORDER }

/**
 * Apply the Client half: start the state transport and register every slot.
 *
 * Wrapped in try/catch so a failure is visible in the browser console instead
 * of silently leaving the page without a ball (`slot entry crashed` class of
 * bugs). The diagnostic lines are intentionally tiny and only run once.
 * @param ctx - the Cordis client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    applyClient(ctx)
  } catch (error) {
    console.error('[dsh-commander] client apply failed', error)
  }
}

/** Actual registration; split out so `apply` can guard it with try/catch. */
function applyClient(ctx: ClientContext): void {
  console.info('[dsh-commander] client apply begin')

  const store = createCommanderStore({ baseUrl: '' })
  const locale = readLocale(ctx)
  const t = bindTranslate(locale)
  const layout = readLayout(ctx)
  const openBoard = layout === undefined ? undefined : (): void => { layout.selectPanel(BOARD_PANEL_ID) }
  const closeBoard = layout === undefined ? (): void => {} : (): void => { layout.selectPanel('conversation') }
  // 软依赖服务可能晚于本插件激活：入口在点击时解析，sessionStatus 在首次读取时解析。
  const openSession = createOpenSession(ctx)
  const sessionStatus = createLazySessionStatus(ctx)
  try {
    // uiSession 晚到时主动挂上观察源并唤醒已订阅的界面（审批悬浮卡）。
    ctx.inject?.(['uiSession'], () => { sessionStatus.refresh() })
  } catch {
    // 宿主/测试 fake 没有动态 inject：首次渲染时仍会惰性解析。
  }

  // Slots first: they are the product surface. Locale dictionaries and the
  // transport are best-effort extras and must never prevent the ball/settings
  // from registering.
  let overlayRegistered = false
  let settingsRegistered = false
  try {
    // `slots.inject` owns the registrations on this context: they are disposed
    // when the owner slot collapses and reinstalled when it returns, so there is
    // no extra `ctx.effect` wrapper (matching shipped client plugins).
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: OVERLAY_ID,
      order: 100,
      inject: () => ({
        store,
        t,
        ...(openBoard === undefined ? {} : { openBoard }),
        sessionStatus,
        openSession,
      }),
    }, CommanderOverlay as unknown as SlotComponent))
    overlayRegistered = true
  } catch (error) {
    console.error('[dsh-commander] shell.overlay registration failed', error)
  }

  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: SETTINGS_ID,
      order: 30,
      label: () => t('settings.nav'),
      inject: () => ({ store, t, openSession }),
    }, CommanderSettingsSection as unknown as SlotComponent))
    settingsRegistered = true
  } catch (error) {
    console.error('[dsh-commander] settings.section registration failed', error)
  }

  let boardRegistered = false
  try {
    // `main` is a keyed slot: a new key becomes one more global panel next to
    // `conversation`; root/sidebar single slots are never replaced.
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: BOARD_PANEL_ID,
      order: 40,
      locale: NS,
      inject: () => ({
        store,
        t,
        closeBoard,
        openSession,
      }),
    }, BoardPage as unknown as SlotComponent))
    boardRegistered = true
  } catch (error) {
    console.error('[dsh-commander] main board registration failed', error)
  }

  let navRegistered = false
  try {
    // The sidebar row is icon-only: the sidebar paints the button, tooltip and
    // selected state from this entry's `label`/`order`, and resolves the
    // clicked panel through the id above.
    registerBoardNav({ slots: ctx.slots, t, component: BoardNavIcon as unknown as SlotComponent })
    navRegistered = true
  } catch (error) {
    console.error('[dsh-commander] sidebar.panellist registration failed', error)
  }

  console.info('[dsh-commander] slots registered', {
    overlay: overlayRegistered, settings: settingsRegistered, board: boardRegistered, nav: navRegistered,
  })

  // Dictionaries are cosmetic: a failure only degrades copy to the zh fallback.
  try {
    if (locale !== undefined) {
      ctx.effect(() => locale.register(NS, DICTIONARIES), 'commander: locale dictionaries')
    }
  } catch (error) {
    console.error('[dsh-commander] locale registration failed', error)
  }

  // Transport last: it owns timers/EventSource, so a failure here must not
  // affect the already-registered slots.
  try {
    ctx.effect(() => {
      store.start()
      return () => { store.dispose() }
    }, 'commander: state transport')
  } catch (error) {
    console.error('[dsh-commander] state transport start failed', error)
  }

  console.info('[dsh-commander] client apply ok', {
    overlay: overlayRegistered ? OVERLAY_ID : null,
    settings: settingsRegistered ? SETTINGS_ID : null,
    board: boardRegistered ? BOARD_PANEL_ID : null,
    nav: navRegistered ? BOARD_PANEL_ID : null,
    locale: locale !== undefined,
    layout: layout !== undefined,
    openSession: openSession !== undefined,
    approvalSource: sessionStatus !== undefined,
  })
}

/**
 * Resolve the translate function. With `locale` declared in `inject` the
 * service is present in the Web GUI; the optional `ctx.get` probe and the
 * fallback keep an older/headless client from turning this into a fatal error.
 * @param locale - resolved locale service, if any.
 * @returns a translate function (zh fallback when the service is absent).
 */
function bindTranslate(locale: ClientLocaleService | undefined): (key: string) => string {
  if (locale === undefined) return fallbackTranslate
  try {
    return locale.bind(NS)
  } catch {
    return fallbackTranslate
  }
}

/**
 * Read the layout service (injected `layout`, or the reflection lookup).
 * @param ctx - client context.
 * @returns the layout service, or undefined when unavailable.
 */
function readLayout(ctx: ClientContext): LayoutService | undefined {
  try {
    const viaGet = ctx.get?.<LayoutService>('layout', false)
    if (viaGet !== undefined) return viaGet
  } catch {
    // fall through to the injected property
  }
  try {
    return ctx.layout
  } catch {
    return undefined
  }
}

/**
 * Read the locale service defensively: prefer the reflection lookup, else the
 * injected context property. Cordis throws when reading an uninjected service,
 * so both reads stay inside try/catch.
 * @param ctx - client context.
 * @returns the locale service, or undefined when unavailable.
 */
function readLocale(ctx: ClientContext): ClientLocaleService | undefined {
  try {
    const viaGet = ctx.get?.<ClientLocaleService>('locale')
    if (viaGet !== undefined) return viaGet
  } catch {
    // ctx.get(name) is strict: a missing service throws; fall through.
  }
  try {
    return ctx.locale
  } catch {
    return undefined
  }
}
