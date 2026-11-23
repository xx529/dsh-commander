// 六列映射双实现漂移测试：Host 版（工具输出）必须与 Client 版（看板 UI）逐项一致。
// 背景：tsconfig.host.json 的 rootDir=src/host，Host 不能 import client，因此两份实现 + 这条测试（同 i18n 双字典做法）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { BOARD_COLUMNS, TRASH_STATUSES, boardColumnOf } from '../../src/client/board.ts'
import { HOST_BOARD_COLUMNS, HOST_TRASH_STATUSES, hostBoardColumnOf } from '../../src/host/query/board-columns.ts'
import { TASK_STATUSES } from '../../src/host/schema.ts'

test('host board columns match the client board columns (id + statuses + order)', () => {
  const host = HOST_BOARD_COLUMNS.map((column) => ({ id: column.id, statuses: [...column.statuses] }))
  const client = BOARD_COLUMNS.map((column) => ({ id: column.id, statuses: [...column.statuses] }))
  assert.deepEqual(host, client)
})

test('trash statuses match in content', () => {
  assert.deepEqual([...HOST_TRASH_STATUSES].sort(), [...TRASH_STATUSES].sort())
})

test('hostBoardColumnOf agrees with client boardColumnOf for every task status', () => {
  for (const status of TASK_STATUSES) {
    assert.equal(hostBoardColumnOf(status), boardColumnOf(status), `status=${status}`)
  }
  assert.equal(hostBoardColumnOf('unknown-status'), 'unknown')
})
