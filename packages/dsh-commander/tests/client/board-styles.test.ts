/**
 * 看板依赖连线的可见性约束（2026-11-26 用户反馈「完成的虚线太不明显」后固化）。
 *
 * `ready` = 前置已验收的连线。旧值是 `1 4` 的 1.2px 点线 + `opacity: .4`：
 * 深色列底上实测描边像素只有 (87,101,105)，底色 (66,76,94)，几乎看不见。
 * 这里锁住“仍然弱于等待中的琥珀虚线、但必须看得见”的下限，避免以后又被调回点线。
 *
 * 背景：`waiting` = 前置未完成，琥珀虚线 + 6px 底色描边 + 箭头；
 * `ready` 不画箭头（方向已由“前置完成”表达），只保留一条看得清的绿色虚线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { STYLES } from '../../src/client/styles.ts'

/** 取一个选择器的声明块（选择器按 `选择器 {` 精确匹配）。 */
function block(css: string, selector: string): string {
  const head = `${selector} {`
  const start = css.indexOf(head)
  assert.ok(start >= 0, `missing block ${head}`)
  const open = start + head.length - 1
  const close = css.indexOf('}', open + 1)
  assert.ok(close > open, `unterminated block ${head}`)
  return css.slice(open + 1, close)
}

test('ready dependency edges stay visible on the board background', () => {
  const ready = block(STYLES, ".dshc-dep-edge[data-state='ready']")
  assert.match(ready, /stroke:\s*var\(--dsw-alias-state-success-primary\);/u)
  const opacity = /opacity:\s*([\d.]+);/u.exec(ready)?.[1]
  assert.ok(opacity !== undefined, 'opacity missing')
  assert.ok(Number(opacity) >= 0.7, `opacity ${opacity} is too low to see`)
  const width = /stroke-width:\s*([\d.]+)(?:px)?;/u.exec(ready)?.[1]
  assert.ok(width !== undefined, 'stroke-width missing')
  assert.ok(Number(width) >= 1.5, `stroke-width ${width} is too thin`)
  // 旧的点线（1 4）在深色列底上等于不可见，不要再回退。
  assert.doesNotMatch(ready, /stroke-dasharray:\s*1 4;/u)
  assert.match(ready, /stroke-dasharray:\s*\d+(\.\d+)? \d+(\.\d+)?;/u)
})

test('waiting dependency edges keep the amber dashed + casing treatment', () => {
  const waiting = block(STYLES, ".dshc-dep-edge[data-state='waiting']")
  assert.match(waiting, /stroke:\s*var\(--dsw-alias-state-warn-primary\);/u)
  assert.match(waiting, /stroke-dasharray:\s*4 3;/u)
  const casing = block(STYLES, '.dshc-dep-edge-casing')
  assert.match(casing, /stroke-width:\s*6;/u)
})
