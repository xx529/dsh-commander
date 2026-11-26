// R1：换任标题（本地时区日期、代际编号、补零）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { rotationTitle } from '../../src/host/rotation/title.ts'

const local = (month: number, day: number, hour = 0, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime()

test('rotationTitle: `第 N 任 · YYYY-MM-DD`，月/日补零', () => {
  assert.equal(rotationTitle(3, local(11, 26, 9, 5)), '第 3 任 · 2026-11-26')
  assert.equal(rotationTitle(12, local(1, 5, 23, 59)), '第 12 任 · 2026-01-05')
})

test('rotationTitle: 同一天任意时刻标题相同（只取本地日期）', () => {
  assert.equal(rotationTitle(2, local(11, 26, 0, 0)), rotationTitle(2, local(11, 26, 23, 59)))
})

test('rotationTitle: 跨本地自然日才变化', () => {
  assert.notEqual(rotationTitle(2, local(11, 26, 23, 59)), rotationTitle(2, local(11, 27, 0, 0)))
})
