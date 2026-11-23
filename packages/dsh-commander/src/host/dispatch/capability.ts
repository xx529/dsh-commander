// capabilityPanel auto（软依赖、失败回退 inherit 继续派发）。
// 契约：implementation-plan §6、m1-contract-patch §4。
import { resolvePanel } from '../api/panel.ts'
import type { CordisContext } from '../dsh-types.ts'
import type { CapabilityPlan, TaskRecord } from '../schema.ts'
import type { StoreSet } from '../store/index.ts'

export type CapabilityFallbackReason = 'panel_unavailable' | 'panel_shape_mismatch' | 'panel_threw' | 'rank_failed' | 'apply_failed' | 'empty_plan' | 'threshold_defaulted'

export interface RankItemLike {
  id?: unknown
  name?: unknown
  kind?: unknown
  score?: unknown
  applicable?: unknown
  enabledInSession?: unknown
}

export interface CapabilityRunInput {
  ctx: CordisContext
  sessionId: string
  draft: string
  cwd?: string
  policy: 'inherit' | 'auto'
  now?: () => number
  /** 测试注入：覆盖 panel 解析。 */
  panelOverride?: unknown
}

export interface CapabilityRunResult {
  plan: CapabilityPlan
  /** 提交给 apply 的 plan（name 列表，便于测试/审计）。 */
  submitted: string[]
}

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** 解析面板 → rank → apply → CapabilityPlan（任何失败 fallback，不阻塞）。 */
export async function runAutoCapability(input: CapabilityRunInput): Promise<CapabilityRunResult> {
  const at = (input.now ?? (() => Date.now()))()
  const resolution = input.panelOverride !== undefined
    ? (() => {
        const raw = input.panelOverride
        const panel = typeof raw === 'function' ? (raw as () => unknown)() : raw
        if (panel === undefined || panel === null) return { present: false as const, reason: 'panel_unavailable' as const }
        const jev = (panel as { jev?: { rank?: unknown; apply?: unknown } }).jev
        if (jev === undefined || typeof jev.rank !== 'function' || typeof jev.apply !== 'function') return { present: false as const, reason: 'panel_shape_mismatch' as const }
        return { present: true as const, panel: panel as { jev: { rank: (...args: unknown[]) => unknown; apply: (...args: unknown[]) => unknown; getConfig?: () => unknown } } }
      })()
    : (() => {
        const base = resolvePanel(input.ctx)
        return base.present ? { present: true as const, panel: base.panel as { jev: { rank: (...args: unknown[]) => unknown; apply: (...args: unknown[]) => unknown; getConfig?: () => unknown } } } : { present: false as const, reason: base.reason }
      })()
  if (!resolution.present) {
    return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: resolution.reason, at }, submitted: [] }
  }
  const { panel } = resolution
  let threshold = 0.5
  let thresholdDefaulted = false
  try {
    const config = await Promise.resolve(panel.jev.getConfig?.())
    const candidate = (config as { threshold?: unknown; decisionThreshold?: unknown } | undefined)
    const resolved = asNumber(candidate?.threshold) ?? asNumber(candidate?.decisionThreshold)
    if (resolved !== undefined) threshold = resolved
    else thresholdDefaulted = true
  } catch {
    thresholdDefaulted = true
  }
  let items: RankItemLike[] = []
  try {
    const rankResult = await Promise.resolve(panel.jev.rank({ sessionId: input.sessionId, draft: input.draft, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }))
    const record = (rankResult ?? {}) as { ok?: unknown; items?: unknown }
    if (record.ok === false) return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'rank_failed', at }, submitted: [] }
    items = Array.isArray(record.items) ? (record.items as RankItemLike[]) : []
  } catch {
    return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'rank_failed', at }, submitted: [] }
  }
  const selected = items.filter((item) => {
    const score = asNumber(item.score) ?? 0
    if (item.applicable === false) return false
    return score >= threshold && typeof item.id === 'string' && item.id !== '' && typeof item.name === 'string' && item.name !== ''
  })
  if (selected.length === 0) {
    return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'empty_plan', at }, submitted: [] }
  }
  const submitted = [...new Set(selected.map((item) => String(item.name)))]
  const apiPlan = selected.map((item) => ({ id: String(item.id), name: String(item.name), enabled: true as const }))
  try {
    const applied = await Promise.resolve(panel.jev.apply({ sessionId: input.sessionId, plan: apiPlan, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }))
    const record = (applied ?? {}) as { ok?: unknown; pending?: unknown; elapsedMs?: unknown; failed?: unknown; enabled?: unknown; disabled?: unknown }
    if (record.ok === false) {
      return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'apply_failed', at }, submitted: [] }
    }
    if (Array.isArray(record.failed) && record.failed.length > 0) {
      return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'apply_failed', at }, submitted: [] }
    }
    const pending = record.pending === true
    const durationMs = asNumber(record.elapsedMs)
    return {
      plan: {
        policy: 'auto',
        executor: 'capability-panel',
        status: 'applied',
        enabled: submitted,
        disabled: [],
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(pending ? { reason: 'pending_replay_on_agent_created' } : thresholdDefaulted ? { reason: 'threshold_defaulted' } : {}),
        at,
      },
      submitted,
    }
  } catch {
    return { plan: { policy: 'auto', executor: 'capability-panel', status: 'fallback', enabled: [], disabled: [], reason: 'apply_failed', at }, submitted: [] }
  }
}

/** 派生任务摘要里的 capability（m1-contract-patch §3.2）：none/inherit/applied/fallback/pending。 */
export function capabilitySummary(task: Pick<TaskRecord, 'capabilities'>): { status: string; enabledCount: number; disabledCount: number; durationMs?: number } {
  const plan = task.capabilities
  if (plan === undefined) return { status: 'none', enabledCount: 0, disabledCount: 0 }
  const status = plan.reason === 'pending_replay_on_agent_created' ? 'pending' : plan.status === 'inherited' ? 'inherit' : plan.status
  return {
    status,
    enabledCount: plan.enabled.length,
    disabledCount: plan.disabled.length,
    ...(plan.durationMs !== undefined ? { durationMs: plan.durationMs } : {}),
  }
}
