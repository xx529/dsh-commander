#!/usr/bin/env node
/**
 * 把 tsdown 产出的 CJS bundle 包成 DSH Client 半的官方形态（实现蓝图 §12.2）：
 *
 *   window.__ModuleLoader__.load({id:"<pkg>",factory:require=>{
 *     var module={exports:{}};var exports=module.exports;
 *     Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});
 *     …bundle 代码（引用 require("react") 等 external）…
 *     return module.exports
 *   }});
 *
 * 之所以用后置包裹而不是 tsdown banner/footer：banner/footer 依赖打包器输出模板细节
 * （`module`/`exports` 的初始化方式、`"use strict"` 位置），跨 tsdown 版本易碎；
 * 后置包裹只依赖「bundle 引用了 `module`/`exports`/`require`」这一 CJS 契约，确定性可验。
 *
 * 用法：node tools/dev/wrap-client.mjs <package-name> <bundle.cjs> <out-client.js>
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'

const [, , packageName, bodyPath, outPath] = process.argv
if (packageName === undefined || bodyPath === undefined || outPath === undefined) {
  console.error('usage: node tools/dev/wrap-client.mjs <package-name> <bundle.cjs> <out-client.js>')
  process.exit(2)
}

const body = readFileSync(bodyPath, 'utf8')
const header = `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:\`Module\`});`
const footer = `;return module.exports}});\n`
writeFileSync(outPath, `${header}${body}${footer}`)
if (existsSync(bodyPath)) rmSync(bodyPath)

console.log(`[wrap-client] wrote ${outPath} (${Buffer.byteLength(`${header}${body}${footer}`, 'utf8')} bytes)`)
