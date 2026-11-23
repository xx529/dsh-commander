# M0-0 包骨架 + 双半 bundle 构建 spike + 隔离 profile 冒烟

- **结论：PASS**（双半构建链路、官方 `lib/client.js` factory 包裹、隔离 profile 安装与 Host 加载、页面/客户端 bundle 服务全部实测通过；**未回退手写 client.js**，但采用「tsdown bundle + 确定性后置包裹」实现 §12.2 包裹）
- 执行人 / 执行时间：devops / 2026-11-17 20:13–20:42（Asia/Shanghai）
- 环境：仓库 `/Users/lzx/Documents/GitHub/dsh-commander`；隔离 `DSH_HOME=/tmp/dsh-commander-m0{,-real}`；**未安装到 live desktop profile、未重启/写 live Desktop**
- 依据：`docs/architecture/implementation-plan.md` §1/§2/§12/§13；`docs/architecture/validation-protocol.md` §2（隔离探针配方）
- 证据：`docs/validation/m0-artifacts/`（spike 占位实现）、`docs/validation/m0-artifacts-real/`（backend/frontend 真实实现，联调用）

---

## 1. 环境与版本（`m0-artifacts/env-versions.txt`）

| 项 | 值 |
|---|---|
| dsh CLI | `0.2.2-rc.2` |
| Desktop（仅版本核对，未运行被改） | `0.2.2-rc.3` |
| node（PATH，构建用） | `v22.22.2` |
| pnpm | `11.22.0`（workspace） |
| typescript | `5.9.3` |
| tsdown | `0.23.7`（rolldown 1.3.2 内核） |
| npm registry | `https://mirrors.cloud.tencent.com/npm/`（`npm_config_registry` 传入安装命令，未写入 `.npmrc`） |
| 构建期 pnpm store | 仓库内 `.pnpm-store/`（gitignored） |

---

## 2. 交付文件（写作用域内）

| 文件 | 说明 |
|---|---|
| `package.json`（根） | 仅 scripts 转发（build/build:host/build:client/typecheck/test/spike:build/spike:smoke），不装依赖 |
| `pnpm-workspace.yaml` | `packages/*` |
| `tsconfig.base.json` | 公共 TS 配置；含 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（Node22 直接跑 `.ts` 测试 / tsc NodeNext emit 并存） |
| `packages/dsh-commander/package.json` | name `dsh-commander`；`engines.dsh >=0.2.0-rc.2 <0.3.0`；exports `.`→`lib/host/index.js`、`./client`→`lib/client.js`；`dsh.bundle.patch`、`dsh.client`（platform web、immediately true、inject 3 项）；`build:client = tsdown && wrap-client`、`test` 含 unit+integration+client 三个 glob |
| `packages/dsh-commander/cordis.patch.yml` | 插入 `id: commander, name: dsh-commander`（不写 config） |
| `packages/dsh-commander/tsconfig.host.json` | `tsc` → `lib/host/`（NodeNext，src/host） |
| `packages/dsh-commander/tsconfig.client.json` | 类型检查：`jsx: react-jsx`、`moduleResolution: bundler`、`noEmit`、`types: []` |
| `packages/dsh-commander/tsdown.config.ts` | Client bundle：`format: cjs`、`deps.neverBundle: [react, react-dom, react/jsx-runtime]`、`inputOptions.platform: browser` |
| `packages/dsh-commander/locale/{en,zh}.json` | `meta.title` / `meta.description` |
| `packages/dsh-commander/icon.svg` | 原创几何图（64×64，<1KB，可再分发） |
| `packages/dsh-commander/docs/DETAIL.md` | 功能 / 用法 / 限制三段 |
| `tools/dev/spike/host/index.ts` | **临时占位** Host（不写 `src/host/**`，归 backend） |
| `tools/dev/spike/client/index.tsx` | **临时占位** Client（不写 `src/client/**`，归 frontend） |
| `tools/dev/spike/tsconfig.host.json` / `tsdown.spike.config.ts` | 占位实现构建配置 |
| `tools/dev/wrap-client.mjs` | 确定性包裹：`window.__ModuleLoader__.load({id,factory})`（§12.2） |
| `tools/dev/verify-bundle.mjs` | 产物契约校验（头/尾/module init/external/apply/inject） |
| `tools/dev/spike-build.sh` | 占位双半构建 + 自检 |
| `tools/dev/smoke-m0.sh` | 隔离 profile 安装 + boot + HTTP/boot-graph/bundle 断言（`BUILD_MODE=spike|real`、`PROBE_ROOT`、`OUTDIR` 可覆盖） |
| `.gitignore` | 追加 `/packages/dsh-commander/lib/`、`/.pnpm-store/`、`/.probe-m0/`、`/node_modules/` |

> `packages/dsh-commander/src/host/**` 归 backend、`src/client/**` 归 frontend；devops 未写这两处业务实现（`src/` 现有内容均为他们产出）。`lib/**` 是构建产物（gitignored）。

---

## 3. 命令与退出码

| # | 命令 | 退出码 | 证据 |
|---|---|---|---|
| 1 | `npm_config_registry=https://mirrors.cloud.tencent.com/npm/ pnpm install --store-dir .pnpm-store` | **0**（32 packages，6.3s） | — |
| 2 | `bash tools/dev/spike-build.sh`（占位双半构建 + 自检） | **0** | `m0-artifacts/01-build.log` |
| 3 | `pnpm --filter dsh-commander build`（**真实** Host tsc + Client tsdown+wrap） | **0** | `m0-artifacts-real/01-build.log` |
| 4 | `pnpm --filter dsh-commander typecheck`（host+client） | **0** | 本地实测 |
| 5 | `pnpm --filter dsh-commander test`（unit+integration+client） | **0**（**58/58 pass**） | 本地实测 |
| 6 | `PROBE_ROOT=/tmp/dsh-commander-m0 bash tools/dev/smoke-m0.sh`（spike 包） | **0**（16 断言 PASS） | `m0-artifacts/commands.log` |
| 7 | `BUILD_MODE=real PROBE_ROOT=/tmp/dsh-commander-m0-real OUTDIR=docs/validation/m0-artifacts-real bash tools/dev/smoke-m0.sh` | **0**（16 断言 PASS） | `m0-artifacts-real/commands.log` |
| 8 | `dsh plugin --profile m0 add file:<repo>/packages/dsh-commander` | **0**（pnpm 569ms） | `m0-artifacts/03-plugin-add.log` |
| 9 | `dsh --profile m0 --dump-config` | **0**，含 `- id: commander / name: dsh-commander` | `m0-artifacts/06-dump-config-commander.txt` |

---

## 4. 产物契约（§12.2）与「回退与否」

**未回退**（tsdown 0.23.7 可稳定产出 bundle）；但 §12.2 的「tsdown banner/footer 包裹」改为**两段式**：

1. `tsdown` 产出 CJS bundle `lib/client.cjs`（format cjs + externals + browser platform）；
2. `tools/dev/wrap-client.mjs` 确定性包成官方形态并删除中间文件。

理由：banner/footer 依赖打包器输出模板细节（`module/exports` 初始化方式、`"use strict"` 位置），跨 tsdown 版本易碎；后置包裹只依赖 CJS 契约，且产物与官方已安装包（如 `dsh-client-ui-account-notifications/lib/client.js`）**头尾逐字同形**，可用 `verify-bundle.mjs` 机器校验。这属实现细节，不改设计契约；若 lead 要求严格 banner/footer，可切换（同一产物格式，风险为跨版本脆弱）。

产物头（`lib/client.js`，86669 bytes；spike 版 2350 bytes）：

```js
window.__ModuleLoader__.load({id:"dsh-commander",factory:require=>{var module={exports:{}};var exports=module.exports;Object.defineProperty(exports,Symbol.toStringTag,{value:`Module`});…
```

产物尾：

```js
exports.apply = apply;
exports.inject = inject;;return module.exports}});
```

`tools/dev/verify-bundle.mjs` 检查项（真实包）：`startsWithLoader/hasModuleInit/hasToStringTag/endsWithReturn/requiresReact/requiresJsxRuntime/noBundledReact/exportsApply/exportsInject` → **全 true**（`m0-artifacts-real/13-verify-local-bundle.json`）。Host 产物可独立 import：`node --input-type=module -e "import('./packages/dsh-commander/lib/host/index.js')"` → `name=commander, inject=[storageDomain,webServer], apply=function`（backend 复核一致）。

---

## 5. 隔离 profile 冒烟证据（`m0-artifacts/commands.log`，16/16 断言 PASS）

| 断言 | 实测 |
|---|---|
| `dsh plugin add file:<pkg>` 自动把包追加进 profile bundles | profile `package.json` 的 `dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-commander"]`（`04-profile-package.json`） |
| `--dump-config` 含 commander 行 | `- id: commander` / `name: dsh-commander`（`06-dump-config-commander.txt`） |
| host 行加载（经行插入的 apply） | `GET /commander/health` → **200** `{ok:true,version:"0.1.0",panel:"absent",binding:"unbound"}`（`08-commander-health.json`；**panel absent 是隔离 profile 未装能力面板的预期结果**，desktop profile 会 present） |
| boot 无失败条目 | `07-boot.err` **0 字节**（web 模板的 ui-chat 入口已用 CLI 的 `dsh-client-ui-chat` 只读符号链接补齐；否则会有一条无害告警） |
| token 围栏 | `GET /` 无 token → **401**；带 token（`-L` 跟 303 落 cookie）→ **200**（41422 bytes） |
| boot graph 含 client 行 | entry `{id:"dsh-commander", rev:"…", inject:[3 项与 §2.1 一致], immediately:true, url:"plugins/??dsh-commander/client.js&rev=…"}`；位于 `application` 批次（`10-boot-entry-commander.json`，从页面 `globalThis["__DSH_BOOT__"]` 解析） |
| Host 提供 client bundle | 组合 URL → **200**，2420 bytes（spike）/ 87239 bytes（real），头为官方 ModuleLoader 包裹（`11-client-bundle.js`、`12-verify-served-bundle.json`） |
| 本地产物契约 | `13-verify-local-bundle.json` 全 PASS |
| live 隔离 | `live-pre.txt` vs `live-post.txt` 仅时间戳头不同（`live-state-diff.txt` 0 字节） |

真实实现（`m0-artifacts-real/`，backend+frontend 源码）额外实测：`/commander/state` → 200，keys=`ok,rev,serverTime,binding,commanderStatus,panel,counts,tasks,workspaces,pendingDispatch,metrics,commanderBusy,messages`（`14-commander-state.json`），与 backend 期望一致；`counts` 全 0、`metrics` 全 0、`binding` 空 → 隔离 Home 干净初值。

> **浏览器端「无 slot entry crashed」未在本轮验证**：headless 探针没有浏览器；本轮已证明「client bundle 由 Host 正确服务 + boot graph 正确登记 + 包裹/依赖符合契约」。真机页面无 console 报错留 M0-1/M0 验收在 Desktop 刷新页面时确认（客户端半当前为占位/真实极简装配，尚无 slot 注册，崩溃风险低）。

---

## 6. 给 backend / frontend 的交接

**归属**：`packages/dsh-commander/src/host/**` 归 backend；`src/client/**` 归 frontend；根/包配置文件、`tools/dev/**`、`lib/client.js`（构建产物，gitignored）归 devops。`tsdown.config.ts` 的 `deps.neverBundle` 口径与 `build:client` 的 wrap 步骤由 devops 维护，frontend 只写 `src/client/index.tsx` + 具名 `apply/inject`。

**常用命令**（仓库根）：

```bash
pnpm install                                   # 已装；新增依赖再跑
pnpm --filter dsh-commander build              # Host tsc → lib/host；Client tsdown+wrap → lib/client.js
pnpm --filter dsh-commander build:host         # 只 Host
pnpm --filter dsh-commander build:client       # 只 Client（含官方包裹）
pnpm --filter dsh-commander typecheck          # host+client 类型检查
pnpm --filter dsh-commander test               # 58 tests
bash tools/dev/spike-build.sh                  # 只用 tools/dev/spike 占位实现构建（不碰 src/**）
PROBE_ROOT=/tmp/dsh-commander-m0 bash tools/dev/smoke-m0.sh            # 隔离安装+启动+断言（占位包）
BUILD_MODE=real PROBE_ROOT=/tmp/dsh-commander-m0-real OUTDIR=/tmp/m0-real bash tools/dev/smoke-m0.sh  # 真实包
```

**注意事项**：
1. `lib/` 是构建产物且 gitignored；勿手改 `lib/client.js`（会被 build 覆盖）。
2. 隔离 profile 是 `web` 模板 + 本包；**能力面板未装** → Host 的 `/commander/health` 返回 `panel:"absent"` 属预期（desktop profile 会 present）。
3. 隔离冒烟会自动为 web 模板补 `dsh-client-ui-chat` 只读符号链接（CLI 未直接依赖该包），否则 boot 会有一条 ui-chat 告警（Host 功能不受影响）。
4. 安装到 live desktop profile 需 lead 安排（M0 验收阶段），本任务**未**执行；`dsh plugin add` 不可写 live profile。
5. backend 的 `[commander] host ready (...)` 日志行在 web 组合下**未出现在 stdout/stderr**（logger.info 级别不落启动输出）；如需 boot 时可见，建议用 `logger.warn` 或验收改用 `/commander/health` 作为 hard 证据。
6. `POST /commander/message`（M0-2）本轮未联调；隔离 Host 已就绪，boot 后可按 backend 给的形状直接发请求验证。

---

## 7. live Desktop 隔离基线

两套冒烟（spike/real）的 `live-pre.txt` / `live-post.txt` 除时间戳头外逐行一致：desktop profile 树 hash、顶层 mtime hash、`~/.dsh/.env` stat、node_modules 条目数均未变；`live-state-diff.txt` 0 字节。未重启/关闭 Desktop、未写 `~/.dsh`、未安装到 live profile。

---

## 8. 后续（M0 验收建议）

1. Desktop 真机验收：安装到 desktop profile → 刷新页面，确认插件管理页名称/图标/详情（locale+icon+DETAIL）、控制台无 `slot entry crashed`。
2. `POST /commander/message` 与 SSE 的 desktop 联调（M0-2/M1）。
3. 若 CI 化：`pnpm install && pnpm --filter dsh-commander build && pnpm --filter dsh-commander test` 三步即可复现本报告。
