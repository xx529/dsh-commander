// config 表仓储（key=singleton，唯一写者 Host）。写默认配置不建会话（implementation-plan §3.1-3）。
import { CONFIG_KEY, DEFAULT_UI } from '../config.ts'
import { defaultConfigRecord, type ConfigRecord } from '../schema.ts'
import type { DomainHandle } from '../dsh-types.ts'
import type { DomainTable } from '../dsh-types.ts'

export interface ConfigStore {
  get(): ConfigRecord
  /** 若不存在则写默认配置；返回当前记录与是否初始化。 */
  ensureInitialized(now?: number): Promise<{ config: ConfigRecord; initialized: boolean }>
  /** 原子读改写（updatedAt 自动刷新）。 */
  update(mutate: (current: ConfigRecord) => ConfigRecord, now?: number): Promise<ConfigRecord>
}

export function createConfigStore(domain: DomainHandle): ConfigStore {
  const table = domain.table<ConfigRecord>('config') as DomainTable<ConfigRecord>
  return {
    get() {
      const record = table.get(CONFIG_KEY)
      if (record === undefined) return defaultConfigRecord()
      // 旧配置没有新增的 ui 字段（entryEnabled/entryPos）：读取时补默认值，避免调用方拿到 undefined。
      return { ...record, ui: { ...DEFAULT_UI, ...(record.ui ?? {}) } }
    },
    async ensureInitialized(now = Date.now()) {
      const existing = table.get(CONFIG_KEY)
      if (existing !== undefined) return { config: existing, initialized: false }
      const config = defaultConfigRecord(now)
      await table.put(CONFIG_KEY, config)
      return { config, initialized: true }
    },
    async update(mutate, now = Date.now()) {
      const current = table.get(CONFIG_KEY)
      if (current === undefined) {
        const seeded = await table.put(CONFIG_KEY, defaultConfigRecord(now)).then(() => table.get(CONFIG_KEY) as ConfigRecord)
        return table.update(CONFIG_KEY, (value) => ({ ...mutate(value ?? seeded), updatedAt: now }))
      }
      return table.update(CONFIG_KEY, (value) => ({ ...mutate(value), updatedAt: now }))
    },
  }
}
