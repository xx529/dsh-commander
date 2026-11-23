// workspaces 表仓储（key=workspaceId 归一化；数组整体替换语义见 m0-contract-patch §2.3）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import { sanitizeKey } from './base.ts'
import type { WorkspaceRecord } from '../schema.ts'

export interface WorkspaceStore {
  get(workspaceId: string): WorkspaceRecord | undefined
  list(): WorkspaceRecord[]
  replaceAll(records: WorkspaceRecord[]): Promise<WorkspaceRecord[]>
}

export function createWorkspaceStore(domain: DomainHandle): WorkspaceStore {
  const table = domain.table<WorkspaceRecord>('workspaces') as DomainTable<WorkspaceRecord>
  return {
    get(workspaceId) {
      return table.get(sanitizeKey(workspaceId))
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
    async replaceAll(records) {
      const nextKeys = new Set(records.map((record) => sanitizeKey(record.id)))
      const existingKeys = [...table.keys()]
      for (const key of existingKeys) if (!nextKeys.has(key)) await table.delete(key)
      for (const record of records) await table.put(sanitizeKey(record.id), record)
      return records
    },
  }
}
