// 任务依赖（`task-state-machine-final.md` §6）：纯函数 + DAG 校验，不做自动派发。
// ready 只对 draft/proposed 有意义；done 或 done→archived 视为依赖已满足。
import type { TaskRecord } from '../schema.ts'

export const DEPENDS_ON_MAX = 5

export type TaskLookup = (taskId: string) => TaskRecord | undefined

/** 单条依赖是否已满足：done，或归档前是 done。 */
export function dependencyMet(dependency: TaskRecord | undefined): boolean {
  if (dependency === undefined) return false
  return dependency.status === 'done' || (dependency.status === 'archived' && dependency.archivedFrom === 'done')
}

/** 任务的全部依赖是否已满足（缺记录视为未满足）。 */
export function dependenciesMet(task: Pick<TaskRecord, 'dependsOn'>, lookup: TaskLookup): boolean {
  return (task.dependsOn ?? []).every((id) => dependencyMet(lookup(id)))
}

/** 尚未满足的依赖 id（保持原顺序）。 */
export function waitingFor(task: Pick<TaskRecord, 'dependsOn'>, lookup: TaskLookup): string[] {
  return (task.dependsOn ?? []).filter((id) => !dependencyMet(lookup(id)))
}

/** ready 只对 draft/proposed 有意义：可派发且依赖已满足。 */
export function isReady(task: Pick<TaskRecord, 'status' | 'dependsOn'>, lookup: TaskLookup): boolean {
  return (task.status === 'draft' || task.status === 'proposed') && dependenciesMet(task, lookup)
}

/** 依赖该任务的后继任务（全表扫描；任务量小）。 */
export function dependentsOf(tasks: readonly TaskRecord[], taskId: string): TaskRecord[] {
  return tasks.filter((task) => task.id !== taskId && (task.dependsOn ?? []).includes(taskId))
}

/** 可提醒/可派发的后继：依赖它的任务里 ready 且仍在 draft/proposed 的。 */
export function readyDependentsOf(tasks: readonly TaskRecord[], taskId: string, lookup: TaskLookup): TaskRecord[] {
  return dependentsOf(tasks, taskId)
    .filter((task) => (task.status === 'draft' || task.status === 'proposed') && isReady(task, lookup))
    .sort((left, right) => left.updatedAt - right.updatedAt)
}

/** 启动补提醒用：所有 ready 且尚未提醒过的 draft/proposed 任务。 */
export function unnotifiedReadyTasks(tasks: readonly TaskRecord[], lookup: TaskLookup): TaskRecord[] {
  return tasks
    .filter((task) => (task.status === 'draft' || task.status === 'proposed') && (task.dependsOn?.length ?? 0) > 0 && task.dependencyNotifiedAt === undefined && isReady(task, lookup))
    .sort((left, right) => left.updatedAt - right.updatedAt)
}

export type DependsOnValidation =
  | { ok: true; dependsOn: string[] }
  | { ok: false; code: 'invalid_request' | 'unknown_task' | 'dependency_cycle'; message: string }

/** 图里加入 override 的依赖后是否仍有环（从 override 任务出发 DFS）。 */
function createsCycle(taskId: string, tasks: readonly TaskRecord[], override: readonly string[], lookup: TaskLookup): boolean {
  const edges = new Map<string, readonly string[]>()
  for (const task of tasks) edges.set(task.id, task.dependsOn ?? [])
  edges.set(taskId, override)
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (done.has(id)) return false
    visiting.add(id)
    const next = edges.get(id) ?? lookup(id)?.dependsOn ?? []
    for (const dependency of next) if (visit(dependency)) return true
    visiting.delete(id)
    done.add(id)
    return false
  }
  for (const id of [...edges.keys(), ...override]) if (visit(id)) return true
  return false
}

/**
 * 校验 dependsOn（`commander_task_create` / `commander_task_update(set_dependencies)` 共用）：
 * ≤5、非空、无重复、无自依赖、目标存在、无环；不得指向 cancelled 或「非 done 归档」。
 * 不要求依赖当前已完成（允许排期）。`tasks` 用于环检测（缺省只检查新依赖链）。
 */
export function validateDependsOn(
  taskId: string,
  raw: unknown,
  lookup: TaskLookup,
  tasks: readonly TaskRecord[] = [],
): DependsOnValidation {
  if (raw === undefined) return { ok: true, dependsOn: [] }
  if (!Array.isArray(raw)) return { ok: false, code: 'invalid_request', message: 'dependsOn must be an array of task ids' }
  if (raw.length > DEPENDS_ON_MAX) return { ok: false, code: 'invalid_request', message: `dependsOn supports at most ${DEPENDS_ON_MAX} tasks` }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, code: 'invalid_request', message: 'dependsOn must contain non-empty task ids' }
    if (item === taskId) return { ok: false, code: 'invalid_request', message: 'a task cannot depend on itself' }
    if (seen.has(item)) return { ok: false, code: 'invalid_request', message: `duplicate dependency '${item}'` }
    seen.add(item)
    ids.push(item)
  }
  for (const id of ids) {
    const dependency = lookup(id)
    if (dependency === undefined) return { ok: false, code: 'unknown_task', message: `dependency task '${id}' not found` }
    if (dependency.status === 'cancelled') return { ok: false, code: 'invalid_request', message: `dependency task '${id}' is cancelled and can never satisfy the dependency` }
    if (dependency.status === 'archived' && dependency.archivedFrom !== 'done') {
      return { ok: false, code: 'invalid_request', message: `dependency task '${id}' is archived without being done` }
    }
  }
  if (createsCycle(taskId, tasks, ids, lookup)) {
    return { ok: false, code: 'dependency_cycle', message: `dependsOn would create a cycle through '${taskId}'` }
  }
  return { ok: true, dependsOn: ids }
}
