// capabilityPanel 软依赖解析（唯一入口；每次重新解析，不缓存；缺失/形状不符不阻塞启动）。
import type { CapabilityPanelService, CordisContext } from '../dsh-types.ts'

export type PanelResolution =
  | { present: true; panel: CapabilityPanelService }
  | { present: false; reason: 'panel_unavailable' | 'panel_shape_mismatch' | 'panel_threw' }

export function resolvePanel(ctx: CordisContext): PanelResolution {
  try {
    const raw = ctx.get('capabilityPanel')
    if (raw === undefined || raw === null) return { present: false, reason: 'panel_unavailable' }
    const panel = typeof raw === 'function' ? (raw as () => unknown)() : raw
    if (panel === undefined || panel === null || typeof panel !== 'object') return { present: false, reason: 'panel_shape_mismatch' }
    const candidate = panel as CapabilityPanelService
    // 唯一入口口径（implementation-plan §6.1）：jev.rank/apply 必须都是 function，否则形状不符 → 回退 inherit。
    const jev = candidate.jev
    if (jev === undefined || typeof jev !== 'object') return { present: false, reason: 'panel_shape_mismatch' }
    if (typeof jev.rank !== 'function' || typeof jev.apply !== 'function') return { present: false, reason: 'panel_shape_mismatch' }
    return { present: true, panel: candidate }
  } catch {
    return { present: false, reason: 'panel_threw' }
  }
}

export const panelPresence = (ctx: CordisContext): 'present' | 'absent' => (resolvePanel(ctx).present ? 'present' : 'absent')
