# 03 测试清单：`production_daily_export` 开关

> 目标仓库：`/Users/lzx/Documents/sunteng/Htdot-OrderCenter`。
> **本机环境限制（如实记录）**：`mvn` 不在 PATH，`order-center-web/node_modules` 不存在，因此本次只执行了 `git apply --check`（结果见 `patch.diff` 与最终回复），**未执行编译、JUnit 或前端构建**。下列命令/断言是待执行清单，不是通过证据。

## 1. 四态矩阵

| 态 | 配置/调用 | 期望（后端） | 期望（前端/接口） | 覆盖测试 |
|---|---|---|---|---|
| 默认开 | 不配置 `ordercenter.report.export.enabled` | `ReportExportSwitch.enabled()==true`；工具走原逻辑返回 `Export` | 能力条目无 `enabled` 字段；按钮显示；xlsx/Base64/sha256 与 `order:read` 不变 | `propertySwitchDefaultsOnAndHonorsExplicitFalse`、`enabledToolDelegatesToTheExistingExporter` |
| 显式关 | `ordercenter.report.export.enabled=false` | `call()` 抛 `IllegalStateException("REPORT_EXPORT_DISABLED")`；**不触达服务** | 能力条目 `enabled:false`；按钮不显示 + 原因文案；HTTP 422 `code=REPORT_EXPORT_DISABLED`；MCP 文案含该码 | `propertySwitchDefaultsOnAndHonorsExplicitFalse`、`disabledToolRejectsWithStableCodeAndNeverCallsTheExporter`、`browserCapabilityCarriesDisabledFlagWhileMcpStillAdvertisesTheTool`、`disabledExportsAreActionable` |
| 权限缺失 | 调用者没有 `order:read`，即使开关关闭 | `SecurityException("ORDER_READ_FORBIDDEN")`（scope 先于开关） | 工具不进入能力清单（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java:90`），浏览器白名单 403 | `scopeIsCheckedBeforeTheSwitch` |
| 非法参数 | 开关开启；缺 id / 未知字段 / format 非字符串 | `INVALID_REPORT_EXPORT` / `INVALID_REPORT_FORMAT`（原样） | 前端按码显示参数错误 | `invalidArgumentsKeepTheirExistingCodesWhileEnabled` |

补充固定顺序：**关闭 + 非法参数** 时返回 `REPORT_EXPORT_DISABLED`（开关判断在参数校验之前）。这是有意的优先级，若产品要求先报参数错误需调整实现顺序。

## 2. 新增/修改的测试

### 2.1 新增 `order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/DailyExportSwitchTest.java`

`@Tag("TEST")`（`AGENTS.md:17`）。断言：

1. `propertySwitchDefaultsOnAndHonorsExplicitFalse`
   - `ApplicationContextRunner` + `ReportExportSwitch`：无属性 → `true`；`ordercenter.report.export.enabled=false` → `false`。
   - 覆盖代码内默认值 `:true`，不是只测 `new ReportExportSwitch(true)`。
2. `enabledToolDelegatesToTheExistingExporter`
   - mock `DailyReportExportService.export(caller,"O","R","xlsx")` 返回 `Export("daily-O-R.xlsx",...,"sha",3,"QQ==")`；
   - `DailyExportTool.call` 返回 JSON 中 `filename` 一致；`verify(exports).export(...)`。
   - 证明开启时调用链与现状一致。
3. `disabledToolRejectsWithStableCodeAndNeverCallsTheExporter`
   - `assertThrows(IllegalStateException.class)`，`getMessage()=="REPORT_EXPORT_DISABLED"`；
   - `verifyNoInteractions(exports)`（不得空结果/伪成功、不得生成文件）；
   - `McpBusinessResult.stateMessage(failure)` 精确等于「日报导出功能已关闭（REPORT_EXPORT_DISABLED），请联系管理员开启」。
4. `scopeIsCheckedBeforeTheSwitch`
   - 无 `order:read` + 开关关闭 → `SecurityException("ORDER_READ_FORBIDDEN")`；证明不会向未授权方泄露开关状态。
5. `invalidArgumentsKeepTheirExistingCodesWhileEnabled`
   - 缺 `revisionId` → `INVALID_REPORT_EXPORT`；
   - 多传 `tenant` → `INVALID_REPORT_EXPORT`；
   - `format:1` → `INVALID_REPORT_FORMAT`。
6. `browserCapabilityCarriesDisabledFlagWhileMcpStillAdvertisesTheTool`
   - 用 10 个 mock 工具依赖构造 `WorkflowToolRegistry`，`configureDailyExport(...)`；
   - `listApi(caller)` 中导出能力 `enabled==false`；
   - `list(caller)`（MCP 清单）中仍能找到 `production_daily_export`（有意保留，见 02 §1.3）；
   - 开启时 `listApi` 的导出能力没有 `enabled` 节点（旧客户端兼容）。

### 2.2 修改 `order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponseTest.java`

新增 `disabledExportsAreActionable()`：

- `status()==422`；
- `code().equals("REPORT_EXPORT_DISABLED")`；
- `message().equals("日报导出功能已关闭，请联系管理员开启")`。

该测试与 `REPORT_EXPORT_TOO_LARGE` 的既有风格一致（`order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponseTest.java:8-11`）。

## 3. 既有回归（不必改，但必须跑）

- `DailyReportExportTest`：服务层证据/xlsx/摘要校验（`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/DailyReportExportTest.java:9-57`），本补丁未改服务，应全绿。
- `UploadMcpHttpTest`：真实 `/mcp` 导出与 xlsx 读取（`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/UploadMcpHttpTest.java:369-375`），默认配置应为开启，必须全绿。
- `ApiContractExportTest`：新 schema 描述非空（`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/ApiContractExportTest.java:11-24`）；本补丁不加 schema 字段，应全绿。
- `AllExposedToolsProjectionGateTest`：26 工具清单（`order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/AllExposedToolsProjectionGateTest.java:14`）；因不从 `list()` 移除工具，清单不变。
- 前端契约脚本：`check-business.mjs` 会读取 `order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java` 的 `name()` 并编译 `order-center-web/src/api.ts`/`business.ts`；本补丁保留 `name()` 且 `order-center-web/src/api.ts` 仍是合法三元表达式，必须全绿。

## 4. 可运行命令（模块路径真实存在）

在目标仓库根目录：

```sh
# 新增工具/开关单测（-am 会构建依赖模块；避免无关模块因找不到匹配测试而失败）
mvn -pl order-center-tests/workflow -am test -Dtest=DailyExportSwitchTest -Dsurefire.failIfNoSpecifiedTests=false

# HTTP 错误码映射单测
mvn -pl order-center-boot -am test -Dtest=BusinessErrorResponseTest -Dsurefire.failIfNoSpecifiedTests=false

# 既有导出回归
mvn -pl order-center-tests/workflow -am test -Dtest='DailyReportExportTest,UploadMcpHttpTest' -Dsurefire.failIfNoSpecifiedTests=false
```

全量（README 要求提供 Python 3.12 绝对路径，`README.md:24-27`）：

```sh
mvn clean verify -Dordercenter.python=/absolute/path/to/python
```

前端（`README.md:47-50`；`package.json:8,10`）：

```sh
cd order-center-web
npm ci
npm test        # check-business / check-auth / check-enum-labels
npm run build   # tsc --noEmit && vite build
```

MCP 契约静态检查（PowerShell）：

```sh
pwsh -File scripts/verify-mcp-contract.ps1
```

> 说明：`scripts/verify-mcp-contract.ps1` 存在，但当前环境未验证 `pwsh` 可用；未执行。

## 5. 建议但**未**纳入 patch 的测试

1. **Spring MVC 端到端（关闭态）**：`@SpringBootTest(properties="ordercenter.report.export.enabled=false")` + MockMvc，断言
   - `GET /api/web/capabilities` 中 `production_daily_export.enabled==false`；
   - `POST /api/web/operations/production_daily_export` 返回 422 且 `code=REPORT_EXPORT_DISABLED`。
   需要认证/CSRF/DB 上下文，成本高，本次未写。可复用 `BrowserBusinessControllerTest` 或 `UploadMcpHttpTest` 的启动方式。
2. **MCP JSON-RPC 端到端（关闭态）**：在真实 `/mcp` 上 `tools/call`，断言 `structuredContent.success==false` 且 message 含 `REPORT_EXPORT_DISABLED`。需独立 Spring 上下文（属性 false），避免污染默认开上下文。
3. **前端点击走查（手工）**：
   - 开：日报详情出现「导出 Excel」，下载 xlsx 可打开。
   - 关：按钮消失，出现「日报导出功能已关闭，请联系管理员开启。」；
   - 关：用旧页面/直接 `fetch('/api/web/operations/production_daily_export',...)` 触发，页面显示同一原因而不是「请检查填写的业务参数」。
4. **MCP 契约审查记录**：按 `AGENTS.md:7-15` 与 `docs/api/mcp-tool-contract-standard.md:54-60`，在 `docs/verification/` 为 `production_daily_export` 填一份 `mcp-tool-review-template.md`。本补丁未包含该记录，不能声称契约审查完成。
