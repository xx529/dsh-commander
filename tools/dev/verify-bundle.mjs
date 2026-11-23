#!/usr/bin/env node
/**
 * 校验 DSH Client 半产物（`lib/client.js`）是否为官方形态：
 *   1. 头：`window.__ModuleLoader__.load({id:"<pkg>",factory:require=>{var module={exports:{}};…`
 *   2. 尾：`;return module.exports}});`
 *   3. external 未被打包：出现 `require("react")`，且不含 React 生产包内部标记。
 *   4. 导出 `apply` / `inject`（供 Cordis 装配）。
 *
 * 用法：node tools/dev/verify-bundle.mjs <client.js> <package-name>
 * 输出：JSON 到 stdout + 退出码（0=PASS，1=FAIL）。
 */
import { readFileSync } from 'node:fs'

const [, , file, packageName = 'dsh-commander'] = process.argv
if (file === undefined) {
  console.error('usage: node tools/dev/verify-bundle.mjs <client.js> [package-name]')
  process.exit(2)
}
const text = readFileSync(file, 'utf8')
const header = `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:\`Module\`});`
const checks = {
  startsWithLoader: text.startsWith(header),
  hasModuleInit: text.includes('var module={exports:{}};var exports=module.exports;'),
  hasToStringTag: text.includes('Object.defineProperty(exports,Symbol.toStringTag'),
  // combo 路由会在末尾追加 `;\n//# sourceMappingURL=…`，属 Host 组装行为，不算产物问题
  endsWithReturn: /return module\.exports\}\}\);\s*;?\s*(?:\/\/#\s*sourceMappingURL=[^\n]*\s*)?$/.test(text),
  requiresReact: text.includes('require("react")'),
  requiresJsxRuntime: text.includes('require("react/jsx-runtime")'),
  noBundledReact: !/react\.production\.min|__SECRET_INTERNALS_DO_NOT_USE/.test(text),
  exportsApply: /\bexports\.apply\s*=/.test(text),
  exportsInject: /\bexports\.inject\s*=/.test(text),
  sizeBytes: Buffer.byteLength(text, 'utf8'),
}
const failed = Object.entries(checks).filter(([, value]) => typeof value === 'boolean' && !value).map(([key]) => key)
console.log(JSON.stringify({ packageName, file, ok: failed.length === 0, failed, checks }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
