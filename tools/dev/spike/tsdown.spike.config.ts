/**
 * M0-0 build spike 的 Client 构建配置（临时占位，正式配置在
 * `packages/dsh-commander/tsdown.config.ts`，入口为 `src/client/index.tsx`）。
 *
 * 只做 bundle（format cjs + externals），产物 `client.cjs` 由
 * `tools/dev/wrap-client.mjs` 包成官方 `lib/client.js` 形态。
 *
 * 注意：本文件位于 `tools/dev/spike/`，该目录不在任何包的 node_modules 作用域内，
 * 无法 `import 'tsdown'`；因此导出**普通配置对象**（tsdown 接受对象形式），
 * 不依赖 `defineConfig`。
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default {
  entry: { client: resolve(here, 'client/index.tsx') },
  outDir: resolve(here, '../../../packages/dsh-commander/lib'),
  format: 'cjs',
  target: 'es2022',
  deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime'] },
  inputOptions: { platform: 'browser' },
  dts: false,
  sourcemap: false,
  clean: false,
  minify: false,
}
