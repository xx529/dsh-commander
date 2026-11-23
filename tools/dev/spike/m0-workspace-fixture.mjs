/**
 * M0-2 形状验证用 fixture：在**隔离探针 Home** 里注册一个工作区
 * （隔离 home 默认 `workspaceRegistry.list()===[]`，commander 的 binding 合同要求
 * workspaceId 必须已注册；本 fixture 只用于隔离环境构造测试数据，不写 live）。
 *
 * 通过 `--patch` 覆盖层挂在 m0 profile 上，随 `tools/dev/check-m0-api.sh` 使用。
 * 行：`id: m0-workspace-fixture`，config: `{ path: '<绝对目录>' }`。
 */
export const name = 'm0-workspace-fixture'
export const inject = ['workspaceRegistry']

export function apply(ctx, config = {}) {
  const path = config.path
  setTimeout(() => {
    void (async () => {
      try {
        const registry = ctx.get('workspaceRegistry')
        const existing = registry.list().find((workspace) => workspace.path === path)
        if (existing !== undefined) {
          process.stdout.write(`[m0-workspace-fixture] workspace exists id=${existing.id} path=${path} COMMANDER_BOOT_LOG=${process.env.COMMANDER_BOOT_LOG ?? '<unset>'}\n`)
          return
        }
        const created = await registry.create(path, 'm0-probe-ws')
        process.stdout.write(`[m0-workspace-fixture] workspace created id=${created.id} path=${created.path} COMMANDER_BOOT_LOG=${process.env.COMMANDER_BOOT_LOG ?? '<unset>'}\n`)
      } catch (error) {
        process.stderr.write(`[m0-workspace-fixture] failed: ${String(error?.message ?? error)}\n`)
      }
    })()
  }, 1500)
}
