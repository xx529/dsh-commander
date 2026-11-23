// sessions 表仓储（key=<workspaceId>__<sessionId>，两段归一化）。
import type { DomainHandle, DomainTable } from '../dsh-types.ts'
import type { SessionLinkRecord } from '../schema.ts'
import { sessionLinkKey } from './base.ts'

export interface SessionStore {
  get(workspaceId: string, sessionId: string): SessionLinkRecord | undefined
  list(): SessionLinkRecord[]
  upsert(record: SessionLinkRecord): Promise<void>
  /**
   * 原子读-改-写：turn 状态（status）与注入去重（lastInjected）会并发写同一条 link，
   * 各自用整条 upsert 会互相覆盖（2026-11-18：turn/end 先写 idle，注入后写回旧 running）。
   */
  patch(workspaceId: string, sessionId: string, mutate: (current: SessionLinkRecord) => SessionLinkRecord): Promise<SessionLinkRecord | undefined>
  markMissing(workspaceId: string, sessionId: string, now?: number): Promise<SessionLinkRecord | undefined>
}

export function createSessionStore(domain: DomainHandle): SessionStore {
  const table = domain.table<SessionLinkRecord>('sessions') as DomainTable<SessionLinkRecord>
  const keyOf = (workspaceId: string, sessionId: string) => sessionLinkKey(workspaceId, sessionId)
  return {
    get(workspaceId, sessionId) {
      return table.get(keyOf(workspaceId, sessionId))
    },
    list() {
      return [...table.entries()].map(([, value]) => value)
    },
    async upsert(record) {
      await table.put(keyOf(record.workspaceId, record.sessionId), record)
    },
    async patch(workspaceId, sessionId, mutate) {
      const key = keyOf(workspaceId, sessionId)
      if (table.get(key) === undefined) return undefined
      return table.update(key, mutate)
    },
    async markMissing(workspaceId, sessionId) {
      const key = keyOf(workspaceId, sessionId)
      const current = table.get(key)
      if (current === undefined) return undefined
      if (current.status === 'missing') return current
      return table.update(key, (value) => ({ ...value, status: 'missing' }))
    },
  }
}
