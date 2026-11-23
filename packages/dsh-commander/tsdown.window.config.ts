/**
 * 原生壳窗口页 bundle：与 DSH client 半（lib/client.js）完全独立。
 *
 * 窗口页由 Host 的 /commander/window 内联返回，运行在 Tauri WKWebView 里，
 * 没有 DSH 的浏览器模块表，因此 react / react-dom 必须打进本 bundle。
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { window: 'src/client/window.tsx' },
  outDir: 'lib',
  format: 'iife',
  target: 'es2022',
  inputOptions: { platform: 'browser' },
  dts: false,
  sourcemap: false,
  clean: false,
  minify: true,
})
