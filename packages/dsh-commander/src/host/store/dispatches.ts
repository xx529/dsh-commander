// dispatches 表仓储（key=decisionId；终态记录即幂等回放源）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import type { DispatchRecord } from '../schema.ts'
import { sanitizeKey } from './base.ts'

export interface DispatchStore {
  get(decisionId: string): DispatchRecord | undefined
  put(record: DispatchRecord): Promise<void>
  list(): DispatchRecord[]
}

export function createDispatchStore(domain: DomainHandle): DispatchStore {
  const table = domain.table<DispatchRecord>('dispatches') as DomainTable<DispatchRecord>
  return {
    get(decisionId) {
      return table.get(sanitizeKey(decisionId))
    },
    async put(record) {
      await table.put(sanitizeKey(record.id), record)
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
  }
}
