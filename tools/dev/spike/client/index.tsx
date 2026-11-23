/**
 * M0-0 构建 spike：Client 半占位实现（**不是**生产实现，生产 `src/client/**` 归 frontend）。
 *
 * 目的：验证 TSX → tsdown → `window.__ModuleLoader__.load({id, factory})` 包裹链路，
 * 并确认 `react` / `react/jsx-runtime` 作为 external 由浏览器模块表提供（不打包进来）。
 *
 * 真实实现由 frontend 写入 `packages/dsh-commander/src/client/**`。
 */
import * as React from 'react'

interface SpikeClientContext {
  logger?: { info?: (message: string) => void }
}

/** 占位组件：仅用于确保 JSX → require("react/jsx-runtime") 的路径被真实使用。 */
export function SpikeBadge(): React.ReactElement {
  return React.createElement('span', { 'data-commander-spike': 'm0-0' }, 'commander')
}

export const inject: string[] = []

export function apply(ctx: SpikeClientContext): void {
  const target = globalThis as unknown as {
    __dshCommanderM0Spike?: { clientLoaded: boolean; at: number; badge: typeof SpikeBadge }
  }
  target.__dshCommanderM0Spike = { clientLoaded: true, at: Date.now(), badge: SpikeBadge }
  ctx?.logger?.info?.('[commander-m0-spike] client half loaded (placeholder apply)')
}
