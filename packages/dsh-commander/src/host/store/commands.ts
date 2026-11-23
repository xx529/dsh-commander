// commands 表仓储（key=commandId；用户原话 ≤8KB）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import type { CommandRecord } from '../schema.ts'
import { createId, sanitizeKey } from './base.ts'

export interface CommandStore {
  get(commandId: string): CommandRecord | undefined
  put(record: CommandRecord): Promise<void>
  create(input: Omit<CommandRecord, 'v' | 'id' | 'createdAt' | 'taskIds'> & { taskIds?: string[] }, now?: number): Promise<CommandRecord>
}

export function createCommandStore(domain: DomainHandle): CommandStore {
  const table = domain.table<CommandRecord>('commands') as DomainTable<CommandRecord>
  return {
    get(commandId) {
      return table.get(sanitizeKey(commandId))
    },
    async put(record) {
      await table.put(sanitizeKey(record.id), record)
    },
    async create(input, now = Date.now()) {
      const record: CommandRecord = {
        v: 1,
        id: createId('cmd', now),
        text: String(input.text ?? '').slice(0, 8192),
        sessionId: input.sessionId,
        seq: input.seq,
        createdAt: now,
        taskIds: input.taskIds ?? [],
        ...(String(input.text ?? '').length > 8192 ? { truncated: true } : {}),
      }
      await table.put(sanitizeKey(record.id), record)
      return record
    },
  }
}
