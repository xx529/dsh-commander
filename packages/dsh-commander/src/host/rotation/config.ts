// R1：轮换配置归一化与到点判定（纯函数；读取时不写盘）。
import {
  ROTATION_DAY_MS,
  ROTATION_DEFAULT_PERIOD_DAYS,
  ROTATION_PERIOD_MAX_DAYS,
  ROTATION_PERIOD_MIN_DAYS,
} from '../config.ts'
import type { ConfigRecord, RotationConfig } from '../schema.ts'

export interface ResolvedRotation {
  enabled: boolean
  periodDays: number
  includeUserTail: boolean
  generation: number
  generationStartedAt: number
  /** 旧配置没有 rotation 字段（读取归一化，不写盘）。 */
  configured: boolean
}

/** 把任意输入夹到 1–7 的整数天；非法值回退默认 1。 */
export function clampPeriodDays(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : ROTATION_DEFAULT_PERIOD_DAYS
  return Math.min(ROTATION_PERIOD_MAX_DAYS, Math.max(ROTATION_PERIOD_MIN_DAYS, numeric))
}

/** 读取归一化：缺省 = 关闭、1 天、含用户原话、第 1 任、起始时间取 config.updatedAt。 */
export function resolveRotation(config: ConfigRecord): ResolvedRotation {
  const raw = config.commander.rotation
  return {
    enabled: raw?.enabled === true,
    periodDays: clampPeriodDays(raw?.periodDays),
    includeUserTail: raw?.includeUserTail !== false,
    generation: typeof raw?.generation === 'number' && raw.generation >= 1 ? Math.floor(raw.generation) : 1,
    generationStartedAt:
      typeof raw?.generationStartedAt === 'number' && raw.generationStartedAt > 0
        ? raw.generationStartedAt
        : (config.updatedAt > 0 ? config.updatedAt : 0),
    configured: raw !== undefined,
  }
}

/** 本地时区的当天 00:00（自然日对齐用；按日历计算，跨时区/夏令时也正确）。 */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 本地日历加天数（按日历日推进，不是固定毫秒）。 */
export function addLocalDays(at: number, days: number): number {
  const date = new Date(at)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * 下一次到点时间（ms）：**本任开始日 + periodDays 的本地 00:00**。
 * 例：11-23 10:45 开始、周期 1 天 → 11-24 00:00；周期 3 天 → 11-26 00:00。
 * 只决定“从什么时候起可以换任”；实际仍在 turn/end 或投递前的懒检查里触发。
 */
export function rotationDueAt(resolved: Pick<ResolvedRotation, 'generationStartedAt' | 'periodDays'>): number {
  return addLocalDays(startOfLocalDay(resolved.generationStartedAt), resolved.periodDays)
}

/**
 * 简报窗口起点：自上次换任起，但**至少覆盖一个周期**。
 * 首次启用后立刻换任（generationStartedAt ≈ now）时不会出现「空窗」，从而能带上当天任务。
 */
export function briefWindowStart(
  resolved: Pick<ResolvedRotation, 'generationStartedAt' | 'periodDays'>,
  now: number,
): number {
  const periodStart = now - resolved.periodDays * ROTATION_DAY_MS
  const started = resolved.generationStartedAt > 0 ? resolved.generationStartedAt : periodStart
  return Math.max(0, Math.min(started, periodStart))
}

/** 是否到点（仅周期；门控在 service 里另行判定）。 */
export function rotationDue(resolved: ResolvedRotation, now: number): boolean {
  return resolved.enabled && now >= rotationDueAt(resolved)
}

/** 在现有 rotation 上打补丁（保留未触碰字段）。 */
export function patchRotation(current: RotationConfig | undefined, patch: Partial<RotationConfig>, now: number): RotationConfig {
  const base: RotationConfig = {
    enabled: current?.enabled === true,
    periodDays: clampPeriodDays(current?.periodDays),
    includeUserTail: current?.includeUserTail !== false,
    generation: current?.generation ?? 1,
    generationStartedAt: current?.generationStartedAt ?? now,
  }
  return {
    ...base,
    ...patch,
    ...(patch.periodDays !== undefined ? { periodDays: clampPeriodDays(patch.periodDays) } : {}),
  }
}
