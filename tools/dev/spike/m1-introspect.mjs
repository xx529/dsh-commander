/**
 * M1 boot 验证 fixture：只读 introspect 宿主服务，验证 Host 的两个高风险集成：
 *   1) 指挥官 agent 作用域里的 tools 注册（commander_task_create/commander_task_update/commander_task_dispatch/commander_task_list）；
 *   2) 指挥官 systemPrompt 段是否已注册（`systemPrompt` 服务存在 + 能取到 commander 段）。
 *
 * 路由：GET /m1/agent-tools?sessionId=<sid>
 * 只读，不写盘、不改会话。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'm1-introspect'
export const inject = []

export function apply(ctx, config = {}) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }
  const register = (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined) return
    ws.register({
      kind: 'exact',
      path: '/m1/agent-tools',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const out = { ok: true, sessionId, agentFound: false, toolNames: [], commanderTools: [], systemPrompt: null, errors: [], env: {
          argv1: process.argv[1] ?? null,
          dshCliEntry: process.env.DSH_CLI_ENTRY ?? null,
          execPath: process.execPath,
        }, toolsService: null, resolution: [] }
        try {
          const agents = hostCtx.get('agents')
          const agent = agents?.get?.(sessionId)
          out.agentFound = agent !== undefined
          if (agent !== undefined) {
            try {
              const scopedTools = agent.ctx?.get?.('tools')
              const schemas = scopedTools?.schemas?.() ?? []
              out.toolNames = Array.isArray(schemas) ? schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string') : []
              out.commanderTools = out.toolNames.filter((name) => ['commander_task_create', 'commander_task_update', 'commander_task_dispatch', 'commander_task_list'].includes(name))
              if (scopedTools !== undefined && scopedTools !== null) {
                out.toolsService = { keys: Object.keys(scopedTools).slice(0, 40), register: typeof scopedTools.register, restrict: typeof scopedTools.restrict, schemas: typeof scopedTools.schemas }
              }
            } catch (error) { out.errors.push(`tools: ${String(error?.message ?? error)}`) }
            try {
              const systemPrompt = agent.ctx?.get?.('systemPrompt')
              out.systemPrompt = systemPrompt === undefined ? 'absent' : typeof systemPrompt
            } catch (error) { out.errors.push(`systemPrompt: ${String(error?.message ?? error)}`) }
          }
        } catch (error) { out.errors.push(String(error?.message ?? error)) }
        // @deepseek-ai/dsh-tools 解析锚点诊断（与 backend loadDefineTool 的锚点对齐）
        try {
          const { createRequire } = await import('node:module')
          const anchors = [process.argv[1], process.env.DSH_CLI_ENTRY].filter((a) => typeof a === 'string' && a.length > 0)
          for (const anchor of anchors) {
            for (const spec of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tools/package.json']) {
              try { const req = createRequire(anchor); out.resolution.push({ anchor, spec, ok: true, path: req.resolve(spec) }) }
              catch (error) { out.resolution.push({ anchor, spec, ok: false, error: String(error?.message ?? error).slice(0, 160) }) }
            }
          }
          // selftest：用同一锚点解析 defineTool + 向指挥官 agent 的 tools 服务注册一个 trivial 工具，
          // 以区分「defineTool 解析失败」「tool spec 不合法」「tools.register 失败」三种情况。
          out.selftest = { defineToolLoaded: false, defineOk: false, registerOk: false, schemasAfter: null, error: null }
          try {
            const anchor = process.argv[1]
            const requireFunction = createRequire(anchor)
            const entry = requireFunction.resolve('@deepseek-ai/dsh-tools')
            const mod = await import(pathToFileURL(entry).href)
            out.selftest.defineToolLoaded = typeof mod.defineTool === 'function'
            const definition = mod.defineTool({
              name: 'probe_m1_selftest',
              description: 'probe selftest tool',
              parameters: {},
              output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: () => 'ok' },
              execute: () => ({ ok: true }),
            })
            out.selftest.defineOk = definition !== undefined
            const agents2 = hostCtx.get('agents')
            const agent2 = agents2?.get?.(sessionId)
            const tools2 = agent2?.ctx?.get?.('tools')
            if (tools2?.register === undefined) out.selftest.error = 'agent tools.register unavailable'
            else {
              const dispose = tools2.register(definition)
              out.selftest.registerOk = true
              out.selftest.schemasAfter = (tools2.schemas?.() ?? []).map((item) => item?.name)
              if (typeof dispose === 'function') dispose()
            }
          } catch (error) { out.selftest.error = String(error?.message ?? error).slice(0, 500) }
          const execDir = process.execPath
          try { const req = createRequire(execDir); out.resolution.push({ anchor: execDir, spec: '@deepseek-ai/dsh-tools', ok: true, path: req.resolve('@deepseek-ai/dsh-tools') }) }
          catch (error) { out.resolution.push({ anchor: execDir, spec: '@deepseek-ai/dsh-tools', ok: false, error: String(error?.message ?? error).slice(0, 160) }) }
        } catch (error) { out.errors.push(`resolution: ${String(error?.message ?? error)}`) }
        json(res, 200, out)
      },
    })
    // /m1/specs-test：直接用 repo 构建产物 createCommanderTools，捕获 defineTool 诊断（只读）
    ws.register({
      kind: 'exact',
      path: '/m1/specs-test',
      handler: async (req, res) => {
        const out = { ok: true, diagnostics: [], specsNull: null, names: null, error: null }
        try {
          const { pathToFileURL } = await import('node:url')
          const repoRoot = new URL('../../../', import.meta.url)
          const moduleUrl = new URL('packages/dsh-commander/lib/host/tools/index.js', repoRoot)
          const mod = await import(pathToFileURL(moduleUrl.pathname).href)
          const fakes = {
            config: { get: () => ({ commander: { sessionId: '' } }) },
            sessions: { list: () => [], get: () => undefined, markMissing: () => {} },
            tasks: { list: () => [], get: () => undefined, put: async () => {}, update: async (key, fn) => fn(undefined) },
            workspaces: { list: () => [] },
            dispatches: { put: async () => {}, get: () => undefined },
            commands: { put: async () => {} },
          }
          const tools = mod.createCommanderTools({
            ctx,
            stores: fakes,
            dispatchService: {},
            commanderSessionId: () => '',
            now: () => Date.now(),
            onDiagnostic: (message) => out.diagnostics.push(message),
          })
          await tools.prepare(process.argv[1])
          const specs = tools.specs()
          out.specsNull = specs === null
          out.names = specs === null ? null : Object.keys(specs)
        } catch (error) { out.error = String(error?.message ?? error).slice(0, 800) }
        json(res, 200, out)
      },
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (hostCtx) => register(hostCtx))
  else setTimeout(() => register(ctx), 1000)
}
