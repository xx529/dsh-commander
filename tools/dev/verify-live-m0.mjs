#!/usr/bin/env node
/**
 * M0-1 live 安装后健康检查（半自动，不依赖浏览器交互）。
 *
 * 通过 live Host 的 origin + 页面 token 检查：
 *   1. 页面可达（token fence：无 token 401，带 token 200）；
 *   2. `/commander/health` 200 且 `{ok:true, version:'0.1.0', panel:'present'}`（desktop 应 present；
 *      隔离 home 会是 absent，脚本会区分提示）；
 *   3. `/commander/state` 200 且含 rev/binding/commanderBusy/messages/workspaces；
 *   4. `/commander/config` 200（只读路由）；
 *   5. 页面 boot graph 含 `dsh-commander` client 行，inject 为 H3a 后的两项
 *      （`@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-locale` 三项），immediately true；
 *   6. Host 服务的 client bundle 是官方 `window.__ModuleLoader__.load({id:'dsh-commander',factory:…})` 包裹，
 *      且不 require `@deepseek-ai/dsh-api-remotes`（H3a：唯一消息通道只走 Host）。
 *
 * 用法（三种等价写法）：
 *   node tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:PORT/?token=…'   # 浏览器地址栏整段
 *   node tools/dev/verify-live-m0.mjs --origin http://127.0.0.1:PORT --token '…'
 *   DSH_WEB_URL=http://127.0.0.1:PORT DSH_WEB_TOKEN=… node tools/dev/verify-live-m0.mjs
 *
 * 退出码：0 = 硬断言全 PASS；1 = 有失败（或 Host 未加载 commander）；2 = 参数错误。
 * 不写 live profile、不重启 DSH（重启提示只在输出里打印）。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''))
  process.exit(0)
}

// HANDOVER §3.4 修正：client 模块 inject 需要 locale（装配顺序声明），三项为其最终口径
const EXPECTED_INJECT = ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']
const results = []
let failed = 0
let skipped = 0
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failed += 1
}
const skip = (name, detail) => {
  results.push({ name, ok: true, skipped: true, detail })
  console.log(`SKIP ${name} — ${detail}`)
  skipped += 1
}
const warn = (text) => console.log(`WARN ${text}`)

// ---- 参数：url / origin+token / env ----
let origin = argOf('--origin')
let token = argOf('--token')
const fullUrl = argOf('--url')
if (fullUrl !== undefined) {
  const url = new URL(fullUrl)
  origin = url.origin
  token = url.searchParams.get('token') ?? token
}
if (origin === undefined) origin = process.env.DSH_WEB_URL
if (token === undefined) token = process.env.DSH_WEB_TOKEN
if (origin === undefined) {
  console.error('usage: node tools/dev/verify-live-m0.mjs --url "<带 token 的浏览器 URL>" | --origin <origin> --token <token>')
  process.exit(2)
}
const originUrl = new URL(origin).origin
if (token === undefined) warn('未提供 token：/ 预计 401；请从浏览器地址栏复制完整 URL（含 ?token=…）或传 --token')

// ---- cookie jar（token 兑换后被 303 到 /，需要带 cookie 才能拿页面）----
let cookie = ''
const fetchWithCookie = (path, init = {}) => fetch(new URL(path, originUrl), {
  redirect: 'manual',
  ...init,
  headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
})
const absorbCookies = (res) => {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') === null ? [] : [res.headers.get('set-cookie')])
  const jar = new Map(cookie.split('; ').filter((part) => part !== '').map((part) => {
    const eq = part.indexOf('=')
    return [part.slice(0, eq), part.slice(eq + 1)]
  }))
  for (const header of setCookies) {
    const pair = header.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const main = async () => {
  // 1) token 兑换 + 页面
  let noTokenStatus = null
  try { noTokenStatus = (await fetchWithCookie('/')).status } catch { /* 忽略，后面统一判 */ }
  const tokenResponse = await fetchWithCookie(token === undefined ? '/' : `/?token=${encodeURIComponent(token)}`)
  absorbCookies(tokenResponse)
  const pageResponse = tokenResponse.status >= 300 && tokenResponse.status < 400
    ? await (async () => { const res = await fetchWithCookie('/'); absorbCookies(res); return res })()
    : tokenResponse
  const pageHtml = await pageResponse.text()
  if (pageResponse.status === 200) {
    record('page reachable (with token/cookie)', true, `http=200 bytes=${pageHtml.length}`)
  } else if (token === undefined) {
    skip('page reachable / boot graph', '无 token：页面 401 属 token fence（N/A）；需浏览器地址栏完整 URL（含 ?token=…）复验')
  } else {
    record('page reachable (with token/cookie)', false, `http=${pageResponse.status} bytes=${pageHtml.length}`)
  }
  if (noTokenStatus !== null) record('page without token is fenced (401)', noTokenStatus === 401, `http=${noTokenStatus}`)

  // 2) /commander/health
  const healthRes = await fetchWithCookie('/commander/health')
  const healthText = await healthRes.text()
  let health = null
  try { health = JSON.parse(healthText) } catch { /* noop */ }
  record('/commander/health 200', healthRes.status === 200, `http=${healthRes.status} body=${healthText.slice(0, 200)}`)
  if (health !== null) {
    record('health.ok true', health.ok === true)
    record('health.version 0.1.0', health.version === '0.1.0', `version=${health.version}`)
    record('health.panel present (desktop)', health.panel === 'present', `panel=${health.panel}`)
    if (health.panel === 'absent') warn('panel=absent：这是隔离 profile 的预期值；live desktop 应 present（若 live 也是 absent 说明 capability-panel 未启用）')
    record('health.binding present', typeof health.binding === 'string', `binding=${health.binding}`)
  }

  // 3) /commander/state
  const stateRes = await fetchWithCookie('/commander/state')
  const stateText = await stateRes.text()
  let state = null
  try { state = JSON.parse(stateText) } catch { /* noop */ }
  record('/commander/state 200', stateRes.status === 200, `http=${stateRes.status}`)
  if (state !== null) {
    for (const key of ['rev', 'binding', 'commanderBusy', 'messages', 'workspaces']) {
      record(`state has ${key}`, Object.hasOwn(state, key))
    }
    record('state.binding shape', state.binding !== null && typeof state.binding === 'object' && typeof state.binding.sessionId === 'string')
    record('state.messages array', Array.isArray(state.messages))
  }

  // 4) /commander/config（只读探测路由）
  const configRes = await fetchWithCookie('/commander/config')
  const configText = await configRes.text()
  record('/commander/config 200', configRes.status === 200, `http=${configRes.status} body=${configText.slice(0, 120)}`)

  // 5) boot graph 里 commander client 行（页面不可达/无 token 时 N/A）
  const bootMatch = pageResponse.status === 200
    ? pageHtml.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\});?<\/script>/s)
    : undefined
  if (pageResponse.status !== 200) {
    // 已在上面 skip，这里不再重复断言
  } else if (bootMatch === null) {
    record('page boot graph present', false)
  } else {
    record('page boot graph present', true)
    const boot = JSON.parse(bootMatch[1])
    const entry = (boot.entries ?? []).find((item) => item.id === 'dsh-commander')
    record('boot graph has dsh-commander client row', entry !== undefined, entry === undefined ? 'missing' : `rev=${entry.rev}`)
    if (entry !== undefined) {
      const inject = entry.inject ?? []
      record('client inject = 三项（ui-layout/ui-settings/locale）', JSON.stringify(inject) === JSON.stringify(EXPECTED_INJECT), `inject=${JSON.stringify(inject)}`)
      record('client entry exists + immediately:true', entry.immediately === true, `id=${entry.id} immediately=${String(entry.immediately)}`)
      const bundleRes = await fetchWithCookie(`/${entry.url}`)
      const bundleText = await bundleRes.text()
      record('served client bundle 200', bundleRes.status === 200, `http=${bundleRes.status} bytes=${bundleText.length}`)
      record('bundle is official ModuleLoader factory wrapper', bundleText.startsWith(`window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>{`))
      record('bundle requires react external', bundleText.includes('require("react")'))
      record('bundle does NOT require dsh-api-remotes (H3a)', !bundleText.includes('dsh-api-remotes'))
      record('bundle does NOT require any @deepseek-ai runtime', !/require\("@deepseek-ai\//.test(bundleText))
    }
  }

  // 6) 用户手测清单
  console.log('\n================ M0-1 用户手测清单（浏览器）================')
  console.log('1. 打开/刷新 DSH 页面（安装后若 HMR 未生效：退出并重开 DeepSeek Harness —— 会中断当前会话/agent 进程）。')
  console.log('2. 页面右下/左下出现 Commander 悬浮球（shell.overlay 槽位）。')
  console.log('3. 点击悬浮球打开面板（M0 空面板即可）；面板无「加载失败/崩溃」提示。')
  console.log('4. 打开设置页，确认出现 Commander 设置分组（M0 四组骨架）。')
  console.log('5. 在面板里发一条消息（POST /commander/message 通道），确认 user echo 出现在面板。')
  console.log('6. 若指挥官会话已绑定且模型可用：等待 assistant 回复出现在面板与对应会话（真实回合，本脚本不覆盖）。')
  console.log('7. 截图存档：悬浮球、面板、设置分组、消息往返（截图放 docs/validation/m0-live-artifacts/ 或验收记录）。')
  console.log('================ 结束 ================\n')

  const summary = { ok: failed === 0, origin: originUrl, passed: results.filter((item) => item.ok && !item.skipped).length, skipped, failed, results }
  console.log(JSON.stringify(summary, null, 2))
  if (failed > 0) {
    const healthMissing = results.some((item) => item.name === '/commander/health 200' && item.ok === false)
    if (healthMissing) {
      console.log('\n提示：/commander/health 不可达通常是 ① 未重启 DSH（Host 半需重启加载）；② 安装未成功（回查 install 日志/dump-config）；③ profile 里 commander 行未启用。')
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`verify-live-m0 failed: ${String(error?.message ?? error)}`)
  process.exit(1)
})
