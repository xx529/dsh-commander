/**
 * scout 探针插件 v3：验证「隔离 web Host 里 sessionController.create / prompt 链路」与
 * 「真实 sessionId 上的 capabilityPanel.jev.rank/apply」。
 *
 * 只做无模型调用的部分：create 会话、selectModel 查询目录、list、panel.rank（无 key → no-config）、
 * panel.apply（冷/热会话两种）。**不 prompt**，避免真实计费。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'scout-probe-v3'
export const inject = []

let ctxRef
const safe = (fn) => {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
}
const safeAsync = async (fn) => {
  try { return { ok: true, value: await fn() } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
}

export function apply(ctx, config = {}) {
  ctxRef = ctx
  const out = config.out ?? '/tmp/dsh-commander-probe/evidence/v3.json'
  const cwd = config.cwd ?? '/tmp/dsh-commander-probe/ws1'
  const finish = () => {
    const exit = safe(() => ctx.get('appExit')).value
    if (typeof exit === 'function') exit(0)
    else process.exit(0)
  }
  setTimeout(() => {
    void (async () => {
      mkdirSync(cwd, { recursive: true })
      const evidence = { at: new Date().toISOString(), cwd, envBools: { TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY) } }
      const services = {}
      for (const key of ['sessionController', 'workspaceRegistry', 'agents', 'webServer', 'capabilityPanel', 'storageDomain']) {
        services[key] = typeof safe(() => ctx.get(key)).value
      }
      evidence.services = services
      const controller = safe(() => ctx.get('sessionController')).value
      evidence.controllerKeys = controller === undefined ? null : Object.keys(controller).sort()
      if (controller !== undefined) {
        evidence.modelCatalog = await safeAsync(async () => {
          const catalog = await controller.modelCatalog()
          const providers = catalog?.providers ?? catalog?.groups ?? []
          return { shape: Array.isArray(providers) ? providers.length : typeof catalog, keys: Object.keys(catalog ?? {}) }
        })
        evidence.create = await safeAsync(async () => {
          const result = await controller.create({ cwd })
          return { keys: Object.keys(result ?? {}), sessionId: result?.sessionId }
        })
        const sessionId = evidence.create?.value?.sessionId
        evidence.list = await safeAsync(async () => {
          const rows = await controller.list()
          const list = Array.isArray(rows) ? rows : rows?.sessions ?? []
          return { count: Array.isArray(list) ? list.length : typeof rows, sampleKeys: Array.isArray(list) ? Object.keys(list[0] ?? {}) : null }
        })
        const panelFactory = safe(() => ctx.get('capabilityPanel')).value
        const panel = typeof panelFactory === 'function' ? panelFactory() : panelFactory
        if (panel !== undefined && sessionId !== undefined) {
          evidence.panelOnRealSession = {
            rank: await safeAsync(() => panel.jev.rank({ sessionId, draft: '给这个仓库补单元测试', cwd })),
            applyCold: await safeAsync(() => panel.jev.apply({ sessionId, plan: [], cwd })),
            skillsSessionListView: await safeAsync(async () => {
              const view = await panel.skills.sessionListView(cwd, sessionId)
              return { skills: view?.skills?.length ?? null, hiddenCount: view?.hiddenCount ?? null }
            }),
          }
        }
        // 二次 apply：如果 create 已让 agent/created 触发排队重放，这里读回 pendingOutcome
        if (panel !== undefined && sessionId !== undefined) {
          evidence.panelOnRealSession.applyAgain = await safeAsync(() => panel.jev.apply({ sessionId, plan: [], cwd }))
        }
      }
      // agents.list 观察 agent 是否已由 create 建出
      evidence.agentsList = await safeAsync(async () => {
        const agents = ctx.get('agents')
        const list = agents?.list?.() ?? []
        return { count: Array.isArray(list) ? list.length : null, ids: Array.isArray(list) ? list.slice(0, 3).map(agent => agent?.id) : null }
      })
      try {
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, JSON.stringify(evidence, undefined, 2) + '\n')
      } catch (error) { process.stderr.write(`[scout-probe-v3] write failed: ${String(error)}\n`) }
      process.stdout.write(`[scout-probe-v3] sessionController=${services.sessionController} session=${evidence.create?.value?.sessionId ?? 'none'}\n`)
      setTimeout(finish, 200)
    })()
  }, 5000)
}
