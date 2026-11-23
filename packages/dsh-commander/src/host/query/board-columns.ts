// Host 版六列映射（task-state-machine-final §8.1）：与 `src/client/board.ts` 平行实现。
// 原因：tsconfig.host.json 的 rootDir=src/host，Host 不能 import client；两份由
// `tests/unit/board-columns-drift.test.ts` 断言逐项一致（同 i18n 双字典做法）。
export type BoardColumnId = 'proposed' | 'queued' | 'running' | 'blocked' | 'review' | 'done'
export type BoardBucket = BoardColumnId | 'trash' | 'unknown'

export interface HostBoardColumn {
  id: BoardColumnId
  statuses: readonly string[]
}

/** 六列，产品顺序。 */
export const HOST_BOARD_COLUMNS: readonly HostBoardColumn[] = [
  { id: 'proposed', statuses: ['draft', 'proposed'] },
  { id: 'queued', statuses: ['queued'] },
  { id: 'running', statuses: ['running'] },
  { id: 'blocked', statuses: ['blocked'] },
  { id: 'review', statuses: ['review'] },
  { id: 'done', statuses: ['done'] },
]

/** 回收站（不是列，是 tab/抽屉）。顺序与 client `TRASH_STATUSES` 一致。 */
export const HOST_TRASH_STATUSES = ['archived', 'cancelled'] as const

export function hostBoardColumnOf(status: string | undefined): BoardBucket {
  if (status === undefined) return 'unknown'
  for (const column of HOST_BOARD_COLUMNS) {
    if (column.statuses.includes(status)) return column.id
  }
  if ((HOST_TRASH_STATUSES as readonly string[]).includes(status)) return 'trash'
  return 'unknown'
}

/** 六列 + trash 的稳定输出顺序（工具 `columns` 计数用）。 */
export const HOST_COLUMN_IDS: readonly (BoardColumnId | 'trash')[] = [
  'proposed',
  'queued',
  'running',
  'blocked',
  'review',
  'done',
  'trash',
]
