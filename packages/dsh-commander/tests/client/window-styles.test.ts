/**
 * 原生壳窗口页的「窗口裁剪」约束（2026-11-26 用户反馈后固化）。
 *
 * 壳的球态窗口固定 76×76（native/tauri/src/main.rs `BALL_SIZE`），球 inset 8px，
 * 球外有 8px 余量，给高光/rim/hover 留空间。任何向外扩散的阴影/光晕都会被 WebView 的窗口矩形硬裁：
 *  - 旧 `.dshcn-ball` 的 `0 6px 18px` 外投影 → 球周围出现矩形色块；
 *  - 旧 busy 关键帧的 `0 0 0 8px` 外扩光晕 → 圆环被切成矩形边。
 *
 * 2026-11-26 改为 B 方案「脉冲核心」：黑曜石球面 + 42px 冷核 + 两层声呐，
 * busy 用声呐扩散，不再用外扩光环；同时去掉球上的旗标与连接点。下面把这两条决定锁住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { WINDOW_STYLES } from '../../src/client/window-styles.ts'

/** 取一个选择器的声明块（选择器按 `选择器 {` 精确匹配，避免命中 `:hover`）。 */
function block(css: string, selector: string): string {
  const head = `${selector} {`
  const start = css.indexOf(head)
  assert.ok(start >= 0, `missing block ${head}`)
  const open = start + head.length - 1
  const close = css.indexOf('}', open + 1)
  assert.ok(close > open, `unterminated block ${head}`)
  return css.slice(open + 1, close)
}

/** 按顶层逗号切分 box-shadow 值（rgba(...) 内部的逗号不切）。 */
function shadowLayers(value: string): string[] {
  const layers: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      layers.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') layers.push(current.trim())
  return layers
}

/** 收集 CSS 里所有 `box-shadow:` 声明值。 */
function boxShadowValues(css: string): string[] {
  return [...css.matchAll(/box-shadow:\s*([^;]+);/giu)].map(match => match[1].trim())
}

/** 壳的球态窗口边长（必须与 Rust 常量一致）。 */
function ballWindowSize(): number {
  const source = readFileSync(new URL('../../native/tauri/src/main.rs', import.meta.url), 'utf8')
  const match = /const BALL_SIZE: f64 = ([\d.]+);/u.exec(source)
  assert.ok(match !== null, 'BALL_SIZE missing from main.rs')
  return Number(match[1])
}

function bubbleWindowSize(): { width: number; height: number } {
  const source = readFileSync(new URL('../../native/tauri/src/main.rs', import.meta.url), 'utf8')
  const width = /const BUBBLE_WIDTH: f64 = ([\d.]+);/u.exec(source)
  const height = /const BUBBLE_HEIGHT: f64 = ([\d.]+);/u.exec(source)
  assert.ok(width !== null && height !== null, 'bubble size missing from main.rs')
  return { width: Number(width[1]), height: Number(height[1]) }
}

/** 球在窗口内的边长（inset 两侧）。 */
function ballEdge(inset: number): number {
  return ballWindowSize() - inset * 2
}

test('ball window leaves 8px around the ball for highlight and hover', () => {
  const ball = block(WINDOW_STYLES, '.dshcn-ball')
  const match = /inset:\s*(\d+)px;/u.exec(ball)
  assert.ok(match !== null, 'ball inset missing')
  const inset = Number(match[1])
  assert.equal(ballWindowSize(), 76)
  assert.equal(inset, 8)
  assert.equal(ballEdge(inset), 60)
})

test('ball paints no outward shadow; the pulse surface keeps its inset volume', () => {
  const ball = block(WINDOW_STYLES, '.dshcn-ball')
  for (const value of boxShadowValues(ball)) {
    for (const layer of shadowLayers(value)) {
      assert.match(layer, /\binset\b/u, `outward shadow layer is clipped by the 56px window: ${layer}`)
    }
  }
  // B 的立体感全部由球面自己的 inset 阴影表达；核心/声呐都裁在圆内。
  const surface = block(WINDOW_STYLES, '.dshcn-orb-surface')
  const values = boxShadowValues(surface)
  assert.ok(values.length > 0, 'pulse surface has no volume shadow')
  for (const value of values) {
    for (const layer of shadowLayers(value)) {
      assert.match(layer, /\binset\b/u, `surface shadow must stay inside the ball: ${layer}`)
    }
  }
  assert.match(surface, /overflow:\s*hidden;/u)
  // hover 只放大，不追加外投影。
  const hover = block(WINDOW_STYLES, '.dshcn-ball:hover,\n.dshcn-ball.is-hover')
  assert.equal(boxShadowValues(hover).length, 0, 'hover must not add an outward shadow')
})

test('pulse surface feathers its edge instead of painting a hard ring', () => {
  const surface = block(WINDOW_STYLES, '.dshcn-orb-surface')
  assert.equal(/inset\s+0\s+0\s+0\s+1px/u.test(surface), false, 'the bright 1px ring must be gone')
  assert.match(surface, /mask:\s*radial-gradient/u, 'the edge should be feathered by a mask')
  assert.match(surface, /transparent 100%\)/u, 'the outer edge should be transparent')
})

test('working uses the orbiting satellite; unread uses the pulse core + sonar', () => {
  const css = WINDOW_STYLES
  assert.equal(css.includes('@keyframes dshcn-ball-pulse'), false, 'old busy halo keyframes must be gone')
  assert.equal(css.includes('@keyframes dshcn-ball-ring'), false, 'old busy ring keyframes must be gone')
  // working：卫星轨道可见；unread：轨道隐藏。
  assert.match(block(css, '.dshcn-orbit'), /dshcn-orbit-spin/u)
  assert.match(block(css, '.dshcn-orbit'), /opacity:\s*0;/u)
  assert.match(block(css, '.dshcn-ball[data-busy="true"] .dshcn-orbit'), /opacity:\s*1;/u)
  assert.match(block(css, '.dshcn-ball[data-busy="true"] .dshcn-orbit'), /animation-play-state:\s*running;/u)
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-orbit'), /opacity:\s*0;/u)
  // unread：绿色核心脉冲 + 双层声呐；busy 不再跑核心/声呐。
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-core'), /animation:\s*dshcn-core-pulse 1\.4s/u)
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-sonar'), /animation:\s*dshcn-sonar-out 1\.8s/u)
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-sonar-2'), /animation-delay:\s*0\.6s;/u)
  assert.equal(css.includes('.dshcn-ball[data-busy="true"] .dshcn-core'), false, 'busy core pulse must be gone')
  assert.equal(css.includes('.dshcn-ball[data-busy="true"] .dshcn-sonar'), false, 'busy sonar must be gone')
  // 声呐在 60px 球的内环内，最大 scale 1.02 仍 < 60px 球。
  assert.match(block(css, '.dshcn-sonar'), /inset:\s*4px;/u)
  const frames = css.slice(css.indexOf('@keyframes dshcn-sonar-out'), css.indexOf('@keyframes dshcn-sonar-out') + 200)
  const maxScale = Math.max(...[...frames.matchAll(/scale\(([\d.]+)\)/gu)].map(match => Number(match[1])))
  assert.ok((ballEdge(8) - 6) * maxScale < ballEdge(8))
  assert.match(block(css, '.dshcn-ball:hover,\n.dshcn-ball.is-hover'), /scale\(1\.055\)/u)
  assert.ok(ballEdge(8) * 1.055 < ballWindowSize())
})

test('panel shadow fits the 6px window margin', () => {
  const panel = block(WINDOW_STYLES, '.dshcn-panel')
  const values = boxShadowValues(panel)
  assert.ok(values.length > 0)
  for (const value of values) {
    for (const layer of shadowLayers(value)) {
      if (/\binset\b/u.test(layer)) continue
      const lengths = [...layer.matchAll(/(-?[\d.]+)px/gu)].map(match => Number(match[1]))
      // 顺序：x y blur spread
      const [x = 0, y = 0, blur = 0, spread = 0] = lengths
      const reach = Math.max(Math.abs(x), Math.abs(y)) + blur + spread
      assert.ok(reach <= 6, `panel shadow reaches ${reach}px > 6px window margin: ${layer}`)
    }
  }
})

test('ball drops the flag and the status dot; B uses core + sonar', () => {
  const source = readFileSync(new URL('../../src/client/WindowApp.tsx', import.meta.url), 'utf8')
  assert.equal(source.includes('dshcn-flag'), false, 'flag must be gone')
  assert.equal((source.match(/dshcn-dot/gu) ?? []).length, 1, 'only the panel header keeps the connection dot')
  assert.match(source, /dshcn-orb-surface/u)
  assert.match(source, /dshcn-core/u)
  assert.match(source, /dshcn-rim/u)
  assert.match(source, /dshcn-sonar-1/u)
  assert.match(source, /dshcn-sonar-2/u)
  assert.equal(source.includes('dshcn-o1'), false, 'C orbit must be gone')
})

test('unread ball pulses green and the working satellite stays cyan', () => {
  const css = WINDOW_STYLES
  const core = block(css, '.dshcn-ball.is-unread .dshcn-core')
  assert.match(core, /dshcn-core-pulse/u)
  assert.match(core, /rgba\(52, 211, 153/u)
  const sonar = block(css, '.dshcn-ball.is-unread .dshcn-sonar')
  assert.match(sonar, /dshcn-sonar-out/u)
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-sonar-2'), /animation-delay:\s*0\.6s;/u)
  assert.match(block(css, '.dshcn-ball.is-unread .dshcn-orbit'), /opacity:\s*0;/u)
  const satellite = block(css, '.dshcn-satellite')
  assert.match(satellite, /background:\s*#d6ecff;/u)
  assert.match(block(css, '.dshcn-orbit::before'), /rgba\(190, 225, 255/u)
})

test('ball uses a liquid metal shell with specular and directional rim', () => {
  const css = WINDOW_STYLES
  const surface = block(css, '.dshcn-orb-surface')
  assert.match(surface, /#b9d2e8/u, 'chrome conic missing')
  assert.match(surface, /backdrop-filter:\s*none/u, 'metal must be opaque')
  assert.match(surface, /inset 0 -12px 22px/u, 'bottom occlusion missing')
  assert.match(block(css, '.dshcn-orb-surface::before'), /rgba\(255, 255, 255, 0\.96\)/u, 'white specular missing')
  assert.match(block(css, '.dshcn-orb-surface::after'), /rgba\(255, 255, 255, 0\.45\)/u, 'soft steel rim missing')
  assert.match(block(css, '.dshcn-rim'), /inset -4px -6px/u, 'soft directional rim missing')
})

test('quick input reuses the bubble window and receives pointer events', () => {
  const css = WINDOW_STYLES
  const match = /\.dshcn-quick \{[^}]*pointer-events:\s*auto;[^}]*\}/su.exec(css)
  assert.ok(match !== null, 'missing interactive quick input root')
  const quick = match[0]
  assert.match(quick, /padding:\s*12px;/u)
  const bar = block(css, '.dshcn-quick-bar')
  assert.match(bar, /width:\s*312px;/u)
  assert.match(bar, /height:\s*52px;/u)
  assert.match(block(css, '.dshcn-quick-input'), /outline:\s*none;/u)
})

test('bubble window fits 336×124 (5 rows) with a 12px shadow/tail margin', () => {
  const css = WINDOW_STYLES
  const bubble = block(css, '.dshcn-bubble,\n.dshcn-quick')
  assert.match(bubble, /position:\s*absolute;/u)
  assert.match(bubble, /inset:\s*0;/u)
  assert.match(bubble, /padding:\s*12px;/u)
  assert.match(bubble, /pointer-events:\s*none;/u)
  const pill = block(css, '.dshcn-bubble-pill')
  assert.match(pill, /max-width:\s*312px;/u)
  assert.match(pill, /min-height:\s*44px;/u)
  const size = bubbleWindowSize()
  assert.equal(size.width, 336)
  assert.equal(size.height, 124)
  assert.equal(312 + 12 * 2, size.width)
  // 阴影 0 3px 9px 的最远 reach = 12px，正好落在 padding 内。
  const shadow = /--dshcn-bubble-shadow:\s*0 ([-\d.]+)px ([-\d.]+)px/gu.exec(css)
  assert.ok(shadow !== null, 'bubble shadow variable missing')
  const reach = Number(shadow[1]) + Number(shadow[2])
  assert.ok(reach <= 12, `bubble shadow reach ${reach}px exceeds 12px padding`)
})

test('bubble text wraps into at most 5 rows inside the 312px pill', () => {
  const text = block(WINDOW_STYLES, '.dshcn-bubble-text')
  assert.match(text, /white-space:\s*normal;/u)
  assert.match(text, /line-height:\s*16\.2px;/u)
  assert.match(text, /-webkit-line-clamp:\s*5;/u)
  assert.match(text, /text-align:\s*left;/u)
  assert.match(text, /overflow:\s*hidden;/u)
  const copy = block(WINDOW_STYLES, '.dshcn-bubble-copy')
  assert.match(copy, /position:\s*relative;/u)
  assert.match(copy, /overflow:\s*hidden;/u)
  assert.match(copy, /height:\s*16\.2px;/u)
})

test('bubble tail stays on the ball axis instead of following the height', () => {
  const tail = block(WINDOW_STYLES, '.dshcn-bubble-tail')
  assert.match(tail, /top:\s*16\.5px;/u)
  assert.doesNotMatch(tail, /translateY\(-50%\)/u)
  const bottomAnchor = block(WINDOW_STYLES, '.dshcn-bubble[data-anchor="bottom"] .dshcn-bubble-tail')
  assert.match(bottomAnchor, /bottom:\s*16\.5px;/u)
})

test('bubble window anchors to the top by default and flips to the bottom near the screen edge', () => {
  const bubble = block(WINDOW_STYLES, '.dshcn-bubble,\n.dshcn-quick')
  assert.match(bubble, /align-items:\s*flex-start;/u)
  const flipped = block(WINDOW_STYLES, '.dshcn-bubble[data-anchor="bottom"],\n.dshcn-quick[data-anchor="bottom"]')
  assert.match(flipped, /align-items:\s*flex-end;/u)
  const quick = block(WINDOW_STYLES, '.dshcn-quick')
  assert.match(quick, /padding-top:\s*8px;/u)
})
