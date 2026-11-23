// store 组合：7 个仓储（唯一写者 Host）。
import type { DomainHandle } from '../dsh-types.ts'
import { createConfigStore, type ConfigStore } from './config.ts'
import { createWorkspaceStore, type WorkspaceStore } from './workspaces.ts'
import { createCommandStore, type CommandStore } from './commands.ts'
import { createTaskStore, type TaskStore } from './tasks.ts'
import { createDispatchStore, type DispatchStore } from './dispatches.ts'
import { createBoardEditStore, type BoardEditStore } from './boardEdits.ts'
import { createSessionStore, type SessionStore } from './sessions.ts'

export interface StoreSet {
  config: ConfigStore
  workspaces: WorkspaceStore
  commands: CommandStore
  tasks: TaskStore
  dispatches: DispatchStore
  boardEdits: BoardEditStore
  sessions: SessionStore
}

export function createStores(domain: DomainHandle): StoreSet {
  return {
    config: createConfigStore(domain),
    workspaces: createWorkspaceStore(domain),
    commands: createCommandStore(domain),
    tasks: createTaskStore(domain),
    dispatches: createDispatchStore(domain),
    boardEdits: createBoardEditStore(domain),
    sessions: createSessionStore(domain),
  }
}
