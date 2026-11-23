/**
 * M0-5 tester 隔离 e2e 专用探针（只存在于 tests/e2e；不进入包产物）。
 * 在 apply 时：
 *   1) 在 workspaceRegistry 注册一个临时工作区（隔离 DSH_HOME 初始为空，binding 合同要求已注册）；
 *   2) 注册 probe-stub/stub-1 确定性 LLM provider（复用 tools/validation/probes/stub-llm.mjs），
 *      用于验证 M0-2 的 assistant 回复 + SSE commander.message / commander.status（不联网、非真实模型）。
 * 仅用于隔离 profile，不触碰 live Desktop。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const name = 'm0-e2e-probe'
export const inject = ['workspaceRegistry', 'llm']

export async function apply(ctx, config = {}) {
  const stubUrl = pathToFileURL(resolve(config.repoRoot, 'tools/validation/probes/stub-llm.mjs')).href
  const { installStubLlm, STUB_PROVIDER, STUB_MODEL } = await import(stubUrl)
  await installStubLlm(ctx)
  process.stdout.write(`[m0-e2e-probe] stub provider registered: ${STUB_PROVIDER}/${STUB_MODEL}\n`)

  const path = config.workspacePath
  setTimeout(() => {
    void (async () => {
      try {
        const registry = ctx.get('workspaceRegistry')
        const existing = registry.list().find((workspace) => workspace.path === path)
        if (existing !== undefined) {
          process.stdout.write(`[m0-e2e-probe] workspace exists id=${existing.id} path=${path}\n`)
          return
        }
        const created = await registry.create(path, 'm0-e2e-ws')
        process.stdout.write(`[m0-e2e-probe] workspace created id=${created.id} path=${created.path}\n`)
      } catch (error) {
        process.stderr.write(`[m0-e2e-probe] workspace create failed: ${String(error?.message ?? error)}\n`)
      }
    })()
  }, 1200)
}
