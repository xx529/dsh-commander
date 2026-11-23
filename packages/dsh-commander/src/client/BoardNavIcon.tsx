/**
 * Icon for the sidebar's "任务看板" row (`sidebar.panellist` entry).
 *
 * The sidebar wraps this component in its own glyph cell and supplies
 * `size` — 16px expanded, 18px on the collapsed rail — plus `active`; the row
 * owns the button, the visible label, the tooltip and the selected state, so
 * this component must render the glyph only (no wrapper, no text, no
 * handlers). Colour comes from the row's `currentColor`.
 *
 * The geometry is the same framed three-column board the floating panel's
 * 「看板」 button uses (`Overlay.tsx` `ICON_BOARD`), so the two entry points read
 * as one feature.
 */
import type { ReactNode } from 'react'

/** Props the sidebar hands to a `sidebar.panellist` entry. */
export interface BoardNavIconProps {
  /** Glyph edge length chosen by the sidebar. */
  size?: number
  /** Whether the board panel is the selected one (the row paints that itself). */
  active?: boolean
}

/** Board frame plus two column dividers, in a 24-unit viewBox. */
const PATHS: readonly string[] = ['M4 5h16', 'M4 5v14h16V5', 'M9 5v14', 'M15 5v14']

/**
 * Render the board glyph at the sidebar-requested size.
 * @param props - the sidebar's icon share.
 * @returns the decorative SVG glyph.
 */
export function BoardNavIcon({ size }: BoardNavIconProps): ReactNode {
  const edge = typeof size === 'number' && Number.isFinite(size) ? Math.min(20, Math.max(16, size)) : 16
  return (
    <svg viewBox="0 0 24 24" width={edge} height={edge} fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {PATHS.map(path => <path key={path} d={path} />)}
    </svg>
  )
}
