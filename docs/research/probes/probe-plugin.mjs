/**
 * scout 取证探针插件（Host 半，只读观察，不写 live profile）。
 *
 * 用途：在完全隔离的 $DSH_HOME 探针 Host 里回答：
 *   A4  $DSH_HOME/.env 是否被 launcher 加载进插件 process.env（只报布尔）
 *   B   ctx.get("capabilityPanel") 是否存在、service 键、jev.rank/apply 可调用性与返回形状
 *   附  base profile 实际暴露的服务面（skills/agents/sessionController/loader/appExit ...）
 *
 * 证据写到 config.out（默认 /tmp/dsh-commander-probe/evidence/plugin-boot.json），
 * 然后通过 launcher 提供的 ctx.get('appExit')(0) 有序退出（不 process.exit 硬杀）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'scout-probe'

// 不 declare inject：即使 capabilityPanel 没挂上也要跑，才能记录"没挂上"这个事实。
export const inject = []

const SESSION_ID = 'probe-cold-session-0001'

function safe(fn, fallback = undefined) {
  try { return fn() } catch (error) { return { __error: String(error?.message ?? error) } ?? fallback }
}

async function capture() {
  const raw = safe(() => ctxRef.get('capabilityPanel'))
  // dsh-capability-settings 1.19.3 用 `ctx.provide("capabilityPanel", () => service)`
  // 注册的是**工厂 thunk**：ctx.get 拿到函数，必须调用一次才得到 service 对象。
  const panelFactory = typeof raw === 'function' ? raw : null
  const panel = panelFactory === null ? raw : safe(() => panelFactory())
  const evidence = {
    at: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    dshHome: process.env.DSH_HOME ?? null,          // 只报路径，不报内容
    cwd: process.cwd(),
    envBools: {                                      // A4：只报布尔，绝不打印值
      TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY),
      JEV_API_KEY: Boolean(process.env.JEV_API_KEY),
    },
    // launcher 层（dsh-app-boot loadLayeredEnv）证明 _ 前缀内部变量
    envKeysSample: Object.keys(process.env).filter(k => k.startsWith('DSH_')).sort(),
    services: {
      capabilityPanelRaw: raw === undefined ? 'undefined' : typeof raw,
      capabilityPanelIsFactory: panelFactory !== null,
      capabilityPanel: panel === undefined ? 'undefined' : typeof panel,
      skills: typeof safe(() => ctxRef.get('skills')),
      agents: typeof safe(() => ctxRef.get('agents')),
      sessionController: typeof safe(() => ctxRef.get('sessionController')),
      storageDomain: typeof safe(() => ctxRef.get('storageDomain')),
      workspaceRegistry: typeof safe(() => ctxRef.get('workspaceRegistry')),
      webServer: typeof safe(() => ctxRef.get('webServer')),
      loader: typeof safe(() => ctxRef.get('loader')),
      cmdlineArgs: typeof safe(() => ctxRef.get('cmdlineArgs')),
      appExit: typeof safe(() => ctxRef.get('appExit')),
      profileContext: typeof safe(() => ctxRef.get('profileContext')),
    },
  }
  if (panel === undefined || panel === null) {
    evidence.panel = { present: false }
    return evidence
  }
  evidence.panel = {
    present: true,
    keys: Object.keys(panel).sort(),
    types: Object.fromEntries(Object.entries(panel).map(([k, v]) => [k, typeof v])),
    jevKeys: panel.jev === undefined ? null : Object.keys(panel.jev).sort(),
    jevFn: panel.jev === undefined ? null : Object.fromEntries(
      ['rank', 'apply', 'test', 'getConfig', 'setConfig'].map(k => [k, typeof panel.jev?.[k]])),
  }
  // 只读配置视图（de-baseURL/model/apiKeyEnv/掩码 key），不含明文
  evidence.panel.jevGetConfig = await safeAsync(() => panel.jev.getConfig())
  // rank：冷会话 + 无 key 时应返回 {ok:false, code:'no-config'}；有 key 时会真的调一次网络
  evidence.panel.rank = await safeAsync(() => panel.jev.rank({
    sessionId: SESSION_ID,
    draft: '需要单元测试和浏览器自动化',
    cwd: process.cwd(),
  }))
  // apply：冷会话合法 plan 应返回 {ok:true, pending:true, applied:0}
  evidence.panel.apply = await safeAsync(() => panel.jev.apply({ sessionId: SESSION_ID, plan: [], cwd: process.cwd() }))
  // 枚举面：冷会话能评分的候选来自哪些域（skills 磁盘行 / tools 单元 / mcp 配置）
  evidence.panel.enumSurface = {
    skillsListView: await safeAsync(async () => {
      const view = await panel.skills.listView(process.cwd())
      return { skills: Array.isArray(view?.skills) ? view.skills.length : null, hiddenCount: view?.hiddenCount ?? null }
    }),
    skillsList: await safeAsync(async () => {
      const rows = await panel.skills.list(process.cwd())
      return { count: Array.isArray(rows) ? rows.length : null, sample: Array.isArray(rows) ? rows.slice(0, 3).map(r => r?.name) : null }
    }),
    toolsList: await safeAsync(async () => {
      const view = await panel.tools.list()
      return { units: Array.isArray(view?.units) ? view.units.length : null, sample: Array.isArray(view?.units) ? view.units.slice(0, 3).map(u => u?.unit) : null }
    }),
    mcpRuntime: await safeAsync(async () => {
      const view = await panel.mcp.runtime({ cwd: process.cwd() })
      return { servers: Array.isArray(view?.servers) ? view.servers.length : null }
    }),
  }
  // 空/非法入参的契约自检（不触发网络）
  evidence.panel.rankBadInput = await safeAsync(() => panel.jev.rank({ sessionId: '', draft: '' }))
  evidence.panel.applyBadInput = await safeAsync(() => panel.jev.apply({ sessionId: SESSION_ID, plan: 'nope' }))
  return evidence
}

let ctxRef
const safeAsync = async (fn) => {
  try { return await fn() } catch (error) { return { __error: String(error?.message ?? error) } }
}

export function apply(ctx, config = {}) {
  ctxRef = ctx
  const out = config.out ?? '/tmp/dsh-commander-probe/evidence/plugin-boot.json'
  const deadlineMs = Number(config.deadlineMs ?? 8000)
  const startedAt = Date.now()
  let done = false
  const finish = () => {
    if (done) return
    done = true
    const exit = safe(() => ctx.get('appExit'))
    if (typeof exit === 'function') exit(0)
    else process.exit(0)
  }
  const tick = async () => {
    if (done) return
    const panel = safe(() => ctx.get('capabilityPanel'))
    if (panel === undefined && Date.now() - startedAt < deadlineMs) {
      return setTimeout(() => void tick(), 100)
    }
    const evidence = await capture()
    evidence.panelWaitMs = Date.now() - startedAt
    try {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(evidence, undefined, 2) + '\n')
    } catch (error) {
      process.stderr.write(`[scout-probe] write evidence failed: ${String(error)}\n`)
    }
    process.stdout.write(`[scout-probe] capabilityPanel=${evidence.panel?.present ? 'present' : 'absent'} keys=${JSON.stringify(evidence.panel?.keys ?? null)}\n`)
    // 给子进程/日志一点 flush 时间，再有序退出
    setTimeout(finish, 150)
  }
  setTimeout(() => void tick(), 300)
}
