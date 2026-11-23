/**
 * 侦察探针（临时）：确认 web profile 里 webServer 路由注册、无 token 可访问性、
 * sessionController / workspaceRegistry / panel / storageDomain 服务面。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'probe-recon'
export const inject = []

const safe = (fn) => {
  try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
}

export function apply(ctx, config = {}) {
  const out = config.out ?? '/tmp/probe-recon.json'
  setTimeout(() => {
    void (async () => {
      const ev = { at: new Date().toISOString(), node: process.version, env: { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME, TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY), DEEPSEEK_API_KEY: Boolean(process.env.DEEPSEEK_API_KEY) } }
      for (const key of ['capabilityPanel', 'sessionController', 'agents', 'webServer', 'storageDomain', 'workspaceRegistry', 'appExit', 'connection']) {
        ev[key] = typeof safe(() => ctx.get(key)).value
      }
      const ws = safe(() => ctx.get('webServer')).value
      if (ws !== undefined && ws !== null) {
        ev.webServerOrigin = safe(() => ws.getOrigin()).value ?? safe(() => ws.getOrigin()).error
        ev.webServerPort = safe(() => ws.port).value
        try {
          const dispose = ws.register({
            kind: 'exact',
            path: '/probe/recon/ping',
            handler: (req, res) => {
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: true, at: new Date().toISOString(), url: req.url }))
            },
          })
          ev.routeRegistered = typeof dispose
        } catch (error) {
          ev.routeRegistered = `error: ${String(error)}`
        }
      }
      const sc = safe(() => ctx.get('sessionController')).value
      if (sc !== undefined) {
        ev.sessionControllerKeys = Object.keys(sc).sort()
        ev.modelCatalog = await (async () => {
          try {
            const catalog = await sc.modelCatalog()
            return { keys: Object.keys(catalog ?? {}), groups: Array.isArray(catalog?.groups) ? catalog.groups.length : null, providers: Array.isArray(catalog?.providers) ? catalog.providers.length : null }
          } catch (e) { return { error: String(e) } }
        })()
      }
      const raw = safe(() => ctx.get('capabilityPanel')).value
      ev.panelRawType = typeof raw
      if (typeof raw === 'function') {
        const panel = safe(() => raw()).value
        ev.panelKeys = panel === undefined ? null : Object.keys(panel).sort()
      }
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(ev, undefined, 2) + '\n')
      process.stdout.write(`[probe-recon] webServerOrigin=${ev.webServerOrigin} route=${ev.routeRegistered} panel=${ev.panelRawType} sc=${ev.sessionController}\n`)
      // 常驻，等外部 curl；由 /probe/recon/quit 退出
      const quit = ws?.register?.({
        kind: 'exact', path: '/probe/recon/quit', handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' }); res.end('bye')
          const exit = safe(() => ctx.get('appExit')).value
          setTimeout(() => { if (typeof exit === 'function') exit(0); else process.exit(0) }, 100)
        },
      })
      ev.quitRoute = typeof quit
    })()
  }, 3000)
}
