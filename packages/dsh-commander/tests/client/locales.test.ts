/**
 * Production i18n completeness test (task-63 regression).
 *
 * The live bug: new M2/M3 components called t() with board/approval/system keys
 * but the production dictionaries never defined those keys, so the fallback
 * translator rendered the key itself. The harness used an identity t stub, so
 * it could not catch this. This test scans the real Client source (t() literals,
 * known i18n key literals, helper-generated key families) and compares it with
 * the production zh/en dictionaries.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DICTIONARIES, fallbackTranslate } from '../../src/client/locales.ts'
import { BOARD_COLUMNS, BOARD_PRIORITIES, priorityLabelKey, statusLabelKey } from '../../src/client/board.ts'
import { badgeLabelKey } from '../../src/client/approval.ts'
import { reasonLabelKey, taskStatusLabelKey } from '../../src/client/dispatch.ts'

const CLIENT_DIR = fileURLToPath(new URL('../../src/client/', import.meta.url))
const KEY_PREFIXES = ['board.', 'approval.', 'system.', 'badge.', 'dispatch.', 'task.', 'conn.', 'status.', 'panel.', 'settings.', 'jev.', 'message.', 'ball.']
/** Slot names / event names / transport identifiers that only look like i18n keys. */
const NON_I18N = new Set([
  'settings.section', 'task.updated', 'dispatch.updated', 'tasks.changed', 'binding.updated',
  'capability.applied', 'commander.message', 'commander.status', 'shell.overlay',
])

function scanSourceKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of readdirSync(CLIENT_DIR).filter(name => /\.(ts|tsx)$/u.test(name))) {
    if (file === 'locales.ts') continue
    const text = readFileSync(join(CLIENT_DIR, file), 'utf8')
    for (const match of text.matchAll(/(?<![\w$.])t\(\s*'([^']+)'/gu)) keys.add(match[1])
    for (const match of text.matchAll(/(?<![\w$.])t\(\s*`([^`$]+)`/gu)) keys.add(match[1])
    for (const match of text.matchAll(/'([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)'/giu)) {
      const candidate = match[1]
      if (!KEY_PREFIXES.some(prefix => candidate.startsWith(prefix))) continue
      if (candidate.length > 60 || candidate.includes('/')) continue
      keys.add(candidate)
    }
  }
  return keys
}

/** Keys produced by template literals / label helpers rather than literal t() calls. */
function derivedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const phase of ['idle', 'connecting', 'live', 'reconnecting', 'polling', 'offline']) keys.add(`conn.${phase}`)
  for (const status of ['bound', 'unbound', 'broken', 'unknown']) keys.add(`status.${status}`)
  for (const column of BOARD_COLUMNS) keys.add(column.labelKey)
  for (const priority of BOARD_PRIORITIES) keys.add(priorityLabelKey(priority))
  for (const status of ['draft', 'proposed', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled', 'archived', undefined]) {
    keys.add(statusLabelKey(status))
    keys.add(taskStatusLabelKey(status))
  }
  for (const kind of ['dispatch', 'approval', 'review', 'blocked']) keys.add(badgeLabelKey(kind))
  for (const reason of ['user_confirm_required', 'low_confidence', 'jev_unavailable', 'decision_required', 'decision_expired', 'conflict', 'weird']) {
    keys.add(reasonLabelKey(reason))
  }
  return keys
}

function referencedKeys(): string[] {
  const all = new Set<string>([...scanSourceKeys(), ...derivedKeys()])
  for (const name of NON_I18N) all.delete(name)
  return [...all].sort()
}

test('every referenced i18n key exists in both production dictionaries', () => {
  const missingZh: string[] = []
  const missingEn: string[] = []
  for (const key of referencedKeys()) {
    if (DICTIONARIES.zh[key] === undefined) missingZh.push(key)
    if (DICTIONARIES.en[key] === undefined) missingEn.push(key)
  }
  assert.deepEqual(missingZh, [], `missing zh keys: ${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `missing en keys: ${missingEn.join(', ')}`)
})

test('zh and en define exactly the same key set', () => {
  const zhKeys = Object.keys(DICTIONARIES.zh).sort()
  const enKeys = Object.keys(DICTIONARIES.en).sort()
  assert.deepEqual(zhKeys.filter(key => !enKeys.includes(key)), [], 'keys only in zh')
  assert.deepEqual(enKeys.filter(key => !zhKeys.includes(key)), [], 'keys only in en')
})

test('no dictionary entry is a placeholder that equals its own key', () => {
  const identical: string[] = []
  for (const [locale, dict] of Object.entries(DICTIONARIES)) {
    for (const [key, value] of Object.entries(dict)) {
      if (value === key) identical.push(`${locale}:${key}`)
    }
  }
  assert.deepEqual(identical, [])
})

test('production fallback never returns a key for referenced copy', () => {
  for (const key of referencedKeys()) {
    assert.notEqual(fallbackTranslate(key), key, `fallbackTranslate leaked ${key}`)
  }
})

test('board/approval/system copy is actually localized (spot checks)', () => {
  assert.equal(DICTIONARIES.zh['board.title'], '看板')
  assert.equal(DICTIONARIES.en['board.title'], 'Board')
  assert.equal(DICTIONARIES.zh['board.column.proposed'], '待派发')
  assert.equal(DICTIONARIES.zh['board.column.queued'], '待运行')
  assert.equal(DICTIONARIES.zh['board.column.running'], '运行中')
  assert.equal(DICTIONARIES.en['board.column.queued'], 'Waiting to run')
  assert.equal(DICTIONARIES.zh['board.priority.normal'], '普通')
  assert.equal(DICTIONARIES.zh['board.drawer.title'], '任务详情')
  assert.equal(DICTIONARIES.zh['approval.title'], '工作会话审批')
  assert.equal(DICTIONARIES.zh['system.sessionReply'], '工作会话汇报')
  assert.equal(DICTIONARIES.zh['badge.approval'], '待审批')
})
