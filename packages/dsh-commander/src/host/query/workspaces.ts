// 工作区查询（task-query-design §9）：只暴露配置中已启用（allowed）的工作区。
import type { WorkspaceDirectoryEntry } from '../dispatch/candidates.ts'

export interface WorkspaceQueryRow {
  id: string
  name: string
  path: string
  summary: string
  policy: 'inherit' | 'auto'
  /** registry sessionIds 计数（近似：未剔除归档；仅供概览）。 */
  sessionCount: number
}

/** 已启用工作区目录（按名称升序）；未启用的一律不出现。 */
export function listEnabledWorkspaces(directory: readonly WorkspaceDirectoryEntry[]): WorkspaceQueryRow[] {
  return directory
    .filter((entry) => entry.allowed === true)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      summary: entry.summary,
      policy: entry.policy,
      sessionCount: entry.sessionIds?.length ?? 0,
    }))
}
