#!/bin/bash
# M0-0 构建 spike：用 tools/dev/spike/** 的临时占位实现验证双半构建链路
#   Host：tsc → packages/dsh-commander/lib/host/index.js（可独立 ESM import）
#   Client：tsdown → lib/client.cjs → wrap-client.mjs → lib/client.js（官方 factory 包裹）
#
# 用法：bash tools/dev/spike-build.sh
# 退出码：0 = 构建+自检通过；非 0 = 失败（脚本内 set -e）
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="$REPO/packages/dsh-commander"
echo "[spike-build] repo=$REPO"

rm -rf "$PKG/lib"
mkdir -p "$PKG/lib"

# 1) Host 半：tsc（spike 源 → lib/host）
echo "[spike-build] host: tsc -p tools/dev/spike/tsconfig.host.json"
pnpm --dir "$REPO" --filter dsh-commander exec tsc -p "$REPO/tools/dev/spike/tsconfig.host.json"
echo "[spike-build] host exit=$?"

# 2) Client 半：tsdown bundle（spike 源 → lib/client.cjs）
echo "[spike-build] client: tsdown --config tools/dev/spike/tsdown.spike.config.ts"
pnpm --dir "$REPO" --filter dsh-commander exec tsdown --config "$REPO/tools/dev/spike/tsdown.spike.config.ts"

# 3) 包裹成官方 client.js 形态并删除中间文件
node "$REPO/tools/dev/wrap-client.mjs" dsh-commander "$PKG/lib/client.cjs" "$PKG/lib/client.js"

# 4) 自检：host 可独立 import；client 头尾包裹正确、external 未被打包
echo "[spike-build] verify host import"
node --input-type=module -e "import('$PKG/lib/host/index.js').then(m=>{if(typeof m.apply!=='function'||typeof m.name!=='string'){console.error('bad host exports',Object.keys(m));process.exit(1)};console.log('[spike-build] host exports ok:',m.name,typeof m.apply)})"

echo "[spike-build] verify client wrapper"
node - "$PKG/lib/client.js" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const text = fs.readFileSync(file, 'utf8')
const checks = {
  startsWithLoader: text.startsWith('window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>{'),
  hasModuleInit: text.includes('var module={exports:{}};var exports=module.exports;'),
  hasToStringTag: text.includes('Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`})'),
  endsWithReturn: /return module\.exports\}\}\);\s*$/.test(text),
  requiresReact: /require\("react"\)/.test(text),
  noBundledReact: !/react\.production|__SECRET_INTERNALS/.test(text),
  sizeBytes: Buffer.byteLength(text, 'utf8'),
}
console.log('[spike-build] client checks:', JSON.stringify(checks))
const failed = Object.entries(checks).filter(([k, v]) => typeof v === 'boolean' && !v).map(([k]) => k)
if (failed.length > 0) { console.error('[spike-build] FAILED checks:', failed.join(',')); process.exit(1) }
NODE

echo "[spike-build] OK"
ls -la "$PKG/lib" "$PKG/lib/host"
