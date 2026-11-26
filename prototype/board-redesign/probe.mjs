#!/usr/bin/env node
/**
 * 原型交互自检：CDP 打开页面，执行点击/输入，断言 DOM 结果并截图。
 * 用法：node probe.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const PORT = 9455
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://127.0.0.1:4312/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(new URL('./shots', import.meta.url).pathname, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/dsh-board-probe',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000', '--remote-allow-origins=*', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
chrome.stderr.on('data', (c) => { stderr += String(c) })

let version
for (let i = 0; i < 80; i += 1) {
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break } catch { await sleep(250) }
}
if (!version) { console.error(stderr.slice(-1500)); process.exit(1) }
const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const pending = new Map()
ws.onmessage = (m) => {
  const data = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data))
  if (data.id !== undefined && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails))
  return res.result?.result?.value
}
const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(new URL(`./shots/${name}`, import.meta.url).pathname, Buffer.from(res.result.data, 'base64'))
}
const goto = async (url) => {
  await send('Page.navigate', { url: BASE + url })
  await sleep(600)
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

// 1. A 回收站分页
await goto('?variant=A&tab=trash')
check('A 只渲染当前页 50 行', await evaluate("document.querySelectorAll('.a-row').length") === 50, `DOM ${await evaluate("document.querySelectorAll('.a-row').length")} 行 / 共 1,284 条`)
check('A 分页总页数 26', await evaluate("[...document.querySelectorAll('.pager-btn')].some(b=>b.textContent==='26')") === true)
await evaluate("[...document.querySelectorAll('.pager-btn')].find(b=>b.textContent==='3').click()")
await sleep(250)
check('A 跳到第 3 页', (await evaluate("document.querySelector('.pager-info').textContent"))?.includes('101–150'), await evaluate("document.querySelector('.pager-info').textContent"))
check('A 第 3 页仍 50 行 DOM', await evaluate("document.querySelectorAll('.a-row').length") === 50)
await shot('probe-a-trash-p3.png')

// 2. 数据 ×10
await evaluate("[...document.querySelectorAll('.dock-btn')].find(b=>b.textContent.startsWith('数据')).click()")
await sleep(700)
check('A 数据 ×10 总数 12,840', (await evaluate("document.querySelector('.tab[aria-selected=\"true\"] .tab-count').textContent"))?.replace(/\s/g,'') === '12,840')
check('A ×10 仍只渲染 50 行', await evaluate("document.querySelectorAll('.a-row').length") === 50)
await shot('probe-a-trash-x10.png')

// 3. 筛选 + 搜索
const totalBefore = await evaluate("document.querySelector('.pager-info').textContent")
await evaluate("(()=>{const i=document.querySelector('[data-input=\"trash-query\"]'); i.value='Gemini'; i.dispatchEvent(new Event('input',{bubbles:true}))})()")
await sleep(300)
const totalAfter = await evaluate("document.querySelector('.pager-info').textContent")
check('A 搜索后总数下降', totalBefore !== totalAfter && totalAfter.includes('Gemini') === false, `${totalBefore} → ${totalAfter}`)
check('A 搜索结果含关键词', (await evaluate("document.querySelector('.a-tbody .a-row-title').textContent")).includes('Gemini'))

// 4. A 看板点卡片聚焦依赖链
await goto('?variant=A&tab=board')
await evaluate("document.querySelector('[data-id=\"t205\"]').click()")
await sleep(300)
check('A 卡片点击后变暗数量 > 0', await evaluate("document.querySelectorAll('.a-card[data-dim=\"true\"]').length") > 0, `${await evaluate("document.querySelectorAll('.a-card[data-dim=\"true\"]').length")} 张`)
check('A 聚焦开关已打开', await evaluate("document.querySelector('[data-input=\"focus-chain\"]').checked") === true)
await shot('probe-a-board-focus.png')

// 5. A 依赖闸门展开
await evaluate("document.querySelector('[data-action=\"toggle-gate\"][data-id=\"t204\"]').click()")
await sleep(250)
check('A 展开依赖后显示状态列', await evaluate("document.querySelectorAll('.a-gate .a-gate-list[data-expanded=\"true\"] em').length") > 0, `${await evaluate("document.querySelectorAll('.a-gate .a-gate-list[data-expanded=\"true\"] em').length")} 个状态`)

// 6. B 主从切换
await goto('?variant=B&tab=board')
const before = await evaluate("document.querySelector('.b-title-row h1').textContent")
await evaluate("[...document.querySelectorAll('.b-row')].find(r=>r.dataset.id==='t213').click()")
await sleep(250)
const after = await evaluate("document.querySelector('.b-title-row h1').textContent")
check('B 点击列表切换详情', before !== after, `${before.slice(0, 12)}… → ${after.slice(0, 12)}…`)
check('B 详情显示依赖图', await evaluate("document.querySelectorAll('.b-graph .b-node').length") > 0)
await shot('probe-b-board-detail.png')

// 7. C 点节点高亮链
await goto('?variant=C&tab=board')
const edgesBefore = await evaluate("document.querySelectorAll('.c-edge[data-related=\"true\"]').length")
await evaluate("document.querySelector('.c-node[data-id=\"t203\"]').click()")
await sleep(400)
const edgesAfter = await evaluate("document.querySelectorAll('.c-edge[data-related=\"true\"]').length")
check('C 点节点后高亮依赖链', edgesBefore === 0 && edgesAfter > 0, `${edgesBefore} → ${edgesAfter} 条相关连线`)
check('C 非链节点变暗', await evaluate("document.querySelectorAll('.c-node[data-dim=\"true\"]').length") > 0)
await shot('probe-c-board-focus.png')

// 8. C 显示全部已完成前置
await evaluate("document.querySelector('[data-input=\"show-all-edges\"]').click()")
await sleep(400)
check('C 显示全部连线后边数增加', await evaluate("document.querySelectorAll('.c-edge').length") > edgesAfter, `${await evaluate("document.querySelectorAll('.c-edge').length")} 条`)
await shot('probe-c-board-all-edges.png')

// 9. C 回收站加载更多
await goto('?variant=C&tab=trash')
const t0 = await evaluate("document.querySelectorAll('.c-tcard').length")
await evaluate("document.querySelector('[data-action=\"trash-more\"]').click()")
await sleep(400)
check('C 加载更多后卡片增加', await evaluate("document.querySelectorAll('.c-tcard').length") > t0, `${t0} → ${await evaluate("document.querySelectorAll('.c-tcard').length")}`)

// 10. 主题
await evaluate("[...document.querySelectorAll('.dock-btn')].find(b=>b.textContent==='浅色').click()")
await sleep(300)
check('主题切换生效', await evaluate("document.documentElement.dataset.theme") === 'light')

// 11. 键盘切换方案
await goto('?variant=A&tab=board')
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
await sleep(300)
check('→ 键切到方案 B', await evaluate("document.querySelector('#app').dataset.variant") === 'B')

// 12. 组合方案：六列内悬停依赖
await goto('?variant=combo&tab=board')
check('组合不再有视图切换', await evaluate("document.querySelector('.view-switch')") === null)
check('组合默认六列', await evaluate("document.querySelectorAll('.a-columns .a-card').length") > 0)
check('组合工具栏含筛选', await evaluate("document.querySelectorAll('.chips .chip').length") >= 5)
check('初始无连线/无淡化', await evaluate("document.querySelectorAll('.a-edge-line').length === 0 && document.querySelectorAll('.a-card.is-dim').length === 0"))
await evaluate("document.querySelector('.a-card[data-id=\"t205\"]').dispatchEvent(new PointerEvent('pointerover',{bubbles:true}))")
await sleep(400)
check('悬停出现关联高亮与淡化', await evaluate("document.querySelectorAll('.a-card.is-dim').length") > 0
  && await evaluate("document.querySelectorAll('.a-card.is-hover').length") === 1,
  `${await evaluate("document.querySelectorAll('.a-card.is-dim').length")} 张淡化 / ${await evaluate("document.querySelectorAll('.a-card.is-chain').length")} 张链上`)
check('悬停出现依赖连线与箭头', await evaluate("document.querySelectorAll('.a-edge-line').length") > 0
  && await evaluate("document.querySelectorAll('.a-edge-line[marker-end]').length") > 0,
  `${await evaluate("document.querySelectorAll('.a-edge-line').length")} 条连线`)
await shot('combo-board-hover.png')
await evaluate("document.querySelector('.a-card[data-id=\"t205\"]').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.querySelector('.a-col-body')}))")
await sleep(300)
check('移出后恢复', await evaluate("document.querySelectorAll('.a-edge-line').length === 0 && document.querySelectorAll('.a-card.is-dim').length === 0"))
await evaluate("document.querySelector('.a-card[data-id=\"t203\"]').click()")
await sleep(400)
check('点击固定依赖链', await evaluate("document.querySelectorAll('.a-edge-line').length") > 0
  && await evaluate("document.querySelector('[data-board-hint]').textContent.includes('已固定')"))
await shot('combo-board-pinned.png')
await evaluate("document.querySelector('.a-col-body').click()")
await sleep(300)
check('点空白取消固定', await evaluate("document.querySelectorAll('.a-edge-line').length === 0"))

// 13. 组合回收站：C 时间流 + 搜索/筛选
await evaluate("[...document.querySelectorAll('.dock-btn')].find(b=>b.textContent==='回收站').click()")
await sleep(400)
check('回收站有时间流与筛选条', await evaluate("!!document.querySelector('.c-trash-toolbar') && document.querySelectorAll('.c-tcard').length > 0"))
await evaluate("(()=>{const i=document.querySelector('[data-input=\"trash-query\"]'); i.value='Gemini'; i.dispatchEvent(new Event('input',{bubbles:true}))})()")
await sleep(350)
check('C 搜索后统计变筛选结果', (await evaluate("document.querySelector('.c-stat span').textContent")) === '筛选结果', await evaluate("document.querySelector('.c-stat').textContent"))
check('C 搜索结果均为 Gemini', await evaluate("[...document.querySelectorAll('.c-tcard h4')].every(h=>h.textContent.includes('Gemini'))"))
check('C 搜索后月份下拉仍列全部月份', await evaluate("document.querySelectorAll('select[data-input=\"trash-month\"] option').length") > 2, `${await evaluate("document.querySelectorAll('select[data-input=\"trash-month\"] option').length")} 个月份`)
await shot('combo-trash-filtered.png')

// 14. 月份导航（全部月份可回到无月份筛选）
await evaluate("[...document.querySelectorAll('.c-month')].find(b=>b.dataset.month!=='all').click()")
await sleep(400)
const monthOn = await evaluate("document.querySelector('.c-month[data-on=\"true\"]')?.textContent ?? ''")
check('点月份后高亮且只显示该月', monthOn.includes('2026') && await evaluate("document.querySelectorAll('.c-month-group').length") === 1, monthOn.trim())
await evaluate("document.querySelector('.c-month[data-month=\"all\"]').click()")
await sleep(400)
check('全部月份恢复', (await evaluate("document.querySelector('.c-month[data-month=\"all\"]').getAttribute('data-on')")) === 'true'
  && await evaluate("document.querySelectorAll('.c-month-group').length") > 1)

// 15. 清除筛选
await evaluate("(()=>{const i=document.querySelector('[data-input=\"trash-query\"]'); i.value='SSE'; i.dispatchEvent(new Event('input',{bubbles:true}))})()")
await sleep(300)
await evaluate("document.querySelector('[data-action=\"trash-clear\"]').click()")
await sleep(350)
check('清除筛选恢复全部', (await evaluate("document.querySelector('.c-stat span').textContent")) === '全部归档'
  && await evaluate("document.querySelector('[data-input=\"trash-query\"]').value") === '')
await shot('probe-combo-trash.png')

// 16. 组合回收站 ×10 仍只渲染已加载批次
await goto('?variant=combo&tab=trash')
await evaluate("[...document.querySelectorAll('.dock-btn')].find(b=>b.textContent.startsWith('数据')).click()")
await sleep(900)
check('组合 ×10 总数 12,840', (await evaluate("document.querySelector('.tab[aria-selected=\"true\"] .tab-count').textContent"))?.replace(/\s/g, '') === '12,840')
check('组合 ×10 仍只渲染 100 条', await evaluate("document.querySelectorAll('.c-tcard').length") === 100, `DOM ${await evaluate("document.querySelectorAll('.c-tcard').length")} 条`)
await shot('combo-trash-x10.png')

console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }))
ws.close()
chrome.kill('SIGKILL')
process.exit(results.some((r) => !r.ok) ? 1 : 0)
