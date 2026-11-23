// board_edits 表仓储（key=editId；人工改动 + 注入状态）。表名是 board_edits，模块名沿用 boardEdits。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import type { BoardEditRecord } from '../schema.ts'
import { sanitizeKey } from './base.ts'

export interface BoardEditStore {
  get(editId: string): BoardEditRecord | undefined
  put(record: BoardEditRecord): Promise<void>
  list(): BoardEditRecord[]
}

export function createBoardEditStore(domain: DomainHandle): BoardEditStore {
  const table = domain.table<BoardEditRecord>('board_edits') as DomainTable<BoardEditRecord>
  return {
    get(editId) {
      return table.get(sanitizeKey(editId))
    },
    async put(record) {
      await table.put(sanitizeKey(record.id), record)
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
  }
}
