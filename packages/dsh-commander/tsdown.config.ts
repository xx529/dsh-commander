/**
 * Client 半构建：tsdown 打包 + `tools/dev/wrap-client.mjs` 确定性包裹。
 *
 * 产物契约（与官方已安装包 `lib/client.js` 头尾逐字一致，也是实现蓝图 §12.2）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-commander",
 *     factory: require => {
 *       var module = { exports: {} }
 *       var exports = module.exports
 *       Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
 *       …bundled code…
 *       return module.exports
 *     }
 *   })
 *
 * 包裹不依赖 tsdown 的 banner/footer 文本拼接细节：先把 bundle 产出为 `lib/client.cjs`，
 * 再包成 `lib/client.js` 并删除中间文件（确定性、可 diff、与框架版本解耦）。
 *
 * tsdown 0.23 的选项口径：external → `deps.neverBundle`；`format: 'cjs'` 固定 Node 语义，
 * 浏览器目标用 `inputOptions.platform: 'browser'` 显式覆盖。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  target: 'es2022',
  // Web 壳静态模块表提供的 seed 模块，必须保持 external（与官方 client 包一致，不能打进 bundle）
  deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] },
  inputOptions: { platform: 'browser' },
  dts: false,
  sourcemap: false,
  clean: false,
  minify: false,
})
