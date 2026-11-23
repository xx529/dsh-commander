// store 公共工具：key 归一化、id 派生、版本重试、timeline 折叠（纯函数，可单测，不依赖 ctx）。
import { createHash, randomBytes } from 'node:crypto'
import { TIMELINE_FOLD_COUNT, TIMELINE_MAX, UPDATE_RETRY_ATTEMPTS } from '../config.ts'
import type { TaskTimelineItem } from '../schema.ts'
import type { DomainTable } from '../dsh-types.ts'

/** key 归一化：保留 [a-zA-Z0-9_-]，其余替换为 '-'；发生替换时追加 `--`+sha1(raw) 前 8 位。 */
export function sanitizeKey(raw: string): string {
  const text = String(raw ?? '')
  const replaced = text.replace(/[^a-zA-Z0-9_-]/g, '-')
  if (replaced === text) return replaced
  const digest = createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8)
  return `${replaced}--${digest}`
}

/** sessions 表复合 key：`<workspaceId>__<sessionId>`（两段都归一化；`__` 保留为分隔符）。 */
export function sessionLinkKey(workspaceId: string, sessionId: string): string {
  return `${sanitizeKey(workspaceId)}__${sanitizeKey(sessionId)}`
}

const idRandom = (bytes = 6): string => randomBytes(bytes).toString('hex').slice(0, 6)

/** id 生成规则：`task_`/`cmd_`/`edit_`/`req_`/`mat_` + 时间戳 36 进制 + 6 位随机。 */
export function createId(prefix: 'task' | 'cmd' | 'edit' | 'req' | 'mat', now = Date.now()): string {
  return `${prefix}_${now.toString(36)}${idRandom()}`
}

/** decisionId 确定性派生：`dec_` + sha256(taskId + '\0' + requestId).slice(0,24)。 */
export function deriveDecisionId(taskId: string, requestId: string): string {
  const digest = createHash('sha256').update(`${taskId}\u0000${requestId}`, 'utf8').digest('hex')
  return `dec_${digest.slice(0, 24)}`
}

/** 不可重试错误（调用方不得重试）。 */
export class NonRetryableError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NonRetryableError'
    this.code = code
  }
}

/** 版本冲突（可重试：应用层 version 乐观并发）。 */
export class VersionConflictError extends Error {
  readonly code = 'version_conflict'
  constructor(message = 'record version conflict') {
    super(message)
    this.name = 'VersionConflictError'
  }
}

/** 缺失 key（先 put 再 update 的契约违例）。 */
export class MissingKeyError extends Error {
  readonly code = 'missing-key'
  constructor(key: string) {
    super(`missing key '${key}' (put before update)`)
    this.name = 'MissingKeyError'
  }
}

/**
 * 应用层 version 乐观并发重试：读 → 期望版本匹配 → mutate(+1) → update；冲突重试最多 3 次。
 * table.update 本身在域的写链上串行；这里防的是跨读者并发（例如两个请求同时读旧版）。
 */
export async function updateWithVersion<T extends { version: number }>(
  table: DomainTable<T>,
  key: string,
  expectedVersion: number | null,
  mutate: (current: T) => T,
  attempts = UPDATE_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = table.get(key)
    if (current === undefined) throw new MissingKeyError(key)
    if (expectedVersion !== null && current.version !== expectedVersion) {
      lastError = new VersionConflictError(`expected version ${expectedVersion}, got ${current.version}`)
      continue
    }
    return table.update(key, (value) => {
      if (value.version !== current.version) throw new VersionConflictError('version changed during update')
      return mutate(value)
    })
  }
  throw lastError ?? new VersionConflictError()
}

/** timeline 追加 + 有界折叠：≤100；超过时把最旧 20 条压成一条 status 摘要，保留首条（created）。 */
export function appendTimeline(timeline: TaskTimelineItem[], item: TaskTimelineItem, max = TIMELINE_MAX, fold = TIMELINE_FOLD_COUNT): TaskTimelineItem[] {
  const next = [...timeline, item]
  if (next.length <= max) return next
  const first = next[0] as TaskTimelineItem
  const rest = next.slice(1)
  const foldCount = Math.min(fold, Math.max(0, rest.length - 1))
  if (foldCount === 0) return [first, next.at(-1) as TaskTimelineItem]
  const folded = rest.slice(0, foldCount)
  const kept = rest.slice(foldCount)
  const summary: TaskTimelineItem = {
    at: folded[folded.length - 1]?.at ?? item.at,
    type: 'status',
    text: `…（已折叠 ${folded.length} 条）`,
  }
  return [first, summary, ...kept]
}
