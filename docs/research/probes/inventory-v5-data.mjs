#!/usr/bin/env node
/**
 * scout 探针脚本：只读盘点 $DSH_HOME 下可用于 V5「50 条真实派发案例」的数据源。
 *
 * 只输出**结构统计**：路径、数量、会话 cwd、事件类型计数、消息条数、是否归档。
 * 不输出会话标题、用户消息正文、工具输出等隐私内容。
 *
 * 用法：
 *   node inventory-v5-data.mjs [--home /Users/lzx/.dsh] [--out <file.json>]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeFrames } from './read-session-log.mjs'

const argOf = (flag, fallback) => {
  const index = process.argv.indexOf(flag)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const home = argOf('--home', process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'))
const out = argOf('--out', undefined)

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** workspace.json：工作区清单 + 归档会话集合（DSH 的 workspace 存储）。 */
function readWorkspaces() {
  const store = readJson(join(home, 'storages', 'workspace.json'))
  const tables = store?.tables?.workspaces ?? {}
  const workspaces = Object.values(tables).map(row => ({
    id: row?.id ?? undefined,
    path: row?.path,
    titlePresent: typeof row?.title === 'string' && row.title.length > 0,
    sessionCount: row?.sessionIds === undefined ? 0 : Object.keys(row.sessionIds).length,
    createdAt: row?.createdAt,
    updatedAt: row?.updatedAt,
  }))
  const archived = store?.global?.archivedSessionIds ?? []
  const pinned = store?.global?.pinnedSessionIds ?? []
  return { workspaces, archived, pinned, storeVersion: store?.unit?.version }
}

/** session_projcache.json：会话投影缓存（title/contextPressure/tokenUsage/lastPromptAt）。 */
function readProjectionCache() {
  const store = readJson(join(home, 'storages', 'session_projcache.json'))
  const sessions = store?.tables?.sessions ?? {}
  const rows = Object.entries(sessions).map(([sessionId, entry]) => {
    const value = (name) => entry?.rows?.[name]?.val
    const pressure = value('contextPressure')
    return {
      sessionId,
      cwd: entry?.identity?.cwd,
      createdAt: entry?.identity?.createdAt,
      hasTitle: typeof value('title') === 'string',
      turns: value('sessionStats')?.turns ?? null,
      lastPromptAt: value('sessionListMetadata')?.lastPromptAt ?? null,
      blank: value('sessionListMetadata')?.blank ?? null,
      contextPressure: pressure === undefined ? null : {
        pressureTokens: pressure.pressureTokens ?? null,
        contextWindow: pressure.contextWindow ?? null,
      },
      inputTokens: value('tokenUsage')?.totals?.uncachedInputTokens ?? null,
      outputTokens: value('tokenUsage')?.totals?.outputTokens ?? null,
      rowNames: Object.keys(entry?.rows ?? {}),
    }
  })
  return { cacheVersion: store?.unit?.version, rows }
}

/** sessions/ 目录：按 cwd 编码的父目录 + 会话 id 子目录 + 世代日志文件。 */
function readSessionDirs() {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return { parentDirs: [], sessions: [] }
  const parentDirs = []
  const sessions = []
  for (const parent of readdirSync(root)) {
    const parentPath = join(root, parent)
    if (!statSync(parentPath).isDirectory()) continue
    const childNames = readdirSync(parentPath).filter(name => statSync(join(parentPath, name)).isDirectory())
    parentDirs.push({ parent, sessionDirs: childNames.length })
    for (const child of childNames) {
      const dir = join(parentPath, child)
      const files = readdirSync(dir)
      const logs = files.filter(name => /^session\..*\.jsonl(?:\.zstd)?$/.test(name))
      const newest = logs.sort().at(-1)
      const row = { parent, sessionDir: child, files, newest }
      if (newest !== undefined) {
        const path = join(dir, newest)
        row.bytes = statSync(path).size
        try {
          const events = Buffer.concat(decodeFrames(readFileSync(path))).toString('utf8')
            .split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
          const header = events.find(event => event.type === 'session')
          const types = {}
          for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1
          row.parsed = true
          row.events = events.length
          row.header = header === undefined ? null : {
            version: header.version,
            id: header.id,
            createdAt: header.createdAt,
            cwd: header.cwd,
            origin: header.origin,
            agentPreset: header.agentPreset,
            hasParentSession: typeof header.parentSession === 'string',
          }
          row.userMessages = types['user/message'] ?? 0
          row.assistantMessages = types['assistant/message'] ?? 0
          row.turns = types['turn/start'] ?? 0
          row.hasTitleEvent = (types['session/title'] ?? 0) > 0
          row.eventTypes = types
        } catch (error) {
          row.parsed = false
          row.error = String(error?.message ?? error)
        }
      }
      sessions.push(row)
    }
  }
  return { parentDirs, sessions }
}

const report = {
  generatedAt: new Date().toISOString(),
  home,
  layout: {
    sessionsRoot: join(home, 'sessions'),
    storagesRoot: join(home, 'storages'),
  },
  workspaceStore: readWorkspaces(),
  projectionCache: (() => {
    const cache = readProjectionCache()
    return {
      cacheVersion: cache.cacheVersion,
      rowCount: cache.rows.length,
      distinctCwds: new Set(cache.rows.map(row => row.cwd)).size,
      withContextPressure: cache.rows.filter(row => row.contextPressure !== null).length,
      withTitle: cache.rows.filter(row => row.hasTitle).length,
      withLastPromptAt: cache.rows.filter(row => row.lastPromptAt !== null).length,
      sample: cache.rows.slice(0, 3),
    }
  })(),
  sessionDirs: (() => {
    const dirs = readSessionDirs()
    return {
      parentDirs: dirs.parentDirs,
      sessionCount: dirs.sessions.length,
      parsed: dirs.sessions.filter(row => row.parsed).length,
      failed: dirs.sessions.filter(row => row.parsed === false).length,
      generations: [...new Set(dirs.sessions.map(row => row.newest))].sort(),
      withUserMessages: dirs.sessions.filter(row => (row.userMessages ?? 0) > 0).length,
      withParentSession: dirs.sessions.filter(row => row.header?.hasParentSession === true).length,
      origins: dirs.sessions.reduce((acc, row) => {
        const key = row.header?.origin ?? 'unknown'
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      cwdCounts: dirs.sessions.reduce((acc, row) => {
        const key = row.header?.cwd ?? 'unknown'
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {}),
      sample: dirs.sessions.filter(row => row.parsed).slice(0, 2),
    }
  })(),
}

const text = JSON.stringify(report, undefined, 2) + '\n'
if (out === undefined) process.stdout.write(text)
else {
  writeFileSync(out, text)
  process.stdout.write(`wrote ${out} (${text.length} bytes)\n`)
}
