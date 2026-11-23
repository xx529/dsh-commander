# 01 现状侦察：HtDot 订单中心「订单导出」

> 目标仓库：`/Users/lzx/Documents/sunteng/Htdot-OrderCenter`（只读）。
> 快照：分支 `main`，HEAD `4042f04591acde51e887a2eb95f20bd26ee0acce`。
> 以下证据路径均相对该仓库根目录；`path:line` 为本次实际读取到的行号。本机未安装 Maven、前端依赖未安装，未执行编译（见 03/04）。

## 1. 前端导出调用链

- 组件签名与入口：`order-center-web/src/DailyExport.tsx:5` — `DailyExport({session,instanceId,revisionId})`。
- 点击后先取日报：`order-center-web/src/DailyExport.tsx:11` — `production_daily_get`，参数 `{instanceId,revisionId}`。
- 结果门槛：`order-center-web/src/DailyExport.tsx:12` — 必须 `report.status==='SUCCEEDED'` 且 `report.outcome?.success===true`；否则在 `:13-14` 抛出中文原因。
- 再调导出：`order-center-web/src/DailyExport.tsx:16` — `production_daily_export`，固定 `format:'xlsx'`，然后用 `downloadAttachment(...)` 消费 Base64 响应。
- 按钮：`order-center-web/src/DailyExport.tsx:19` — 文案「导出 Excel」/「正在导出…」，`disabled={busy||!revisionId}`，错误放 `role="alert"`。
- 谁渲染它：`order-center-web/src/RecordWorkbench.tsx:18` — 条件 `daily && capabilities.some(c=>c.name==='production_daily_export')` 才渲染 `<DailyExport>`。**这是现成的 GUI 隐藏点。**
- 能力列表从哪来：`order-center-web/src/main.tsx:40` 调 `/capabilities`；`:67` 把按板块过滤后的 `capabilities` 传给 `BusinessTabs`；`order-center-web/src/BusinessTabs.tsx:19` 再传给 `RecordWorkbench`。
- 板块归属：`order-center-web/src/business.ts:11` — `production_daily_export:[4]`；`:21-23` `belongsToSection`。`order-center-web/src/BusinessTabs.tsx:13` 把该工具列入「日报查询」组名清单（组是否可见还取决于同组其它工具）。

## 2. MCP 工具层

- 注册与构造：`DailyExportTool` 为 `@Service`，单构造器注入 `DailyReportExportService`（`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:6-9`）。
- 工具名：`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:10` — `production_daily_export`。
- 输入 schema：`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:11-19` — `additionalProperties=false`；`instanceId/revisionId` 必填且 pattern `^[A-Za-z0-9_-]{1,36}$`；`format` 枚举 `json|xlsx`；无 outputSchema。
- 调用顺序：`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:21-26`
  - `:22` 先校验 `caller.scopes().contains("order:read")`，否则 `SecurityException("ORDER_READ_FORBIDDEN")`；
  - `:23` 参数对象与两个 id 的文本性；
  - `:24` 字段白名单 `instanceId/revisionId/format`，否则 `IllegalArgumentException("INVALID_REPORT_EXPORT")`；
  - `:25` `format` 必须是文本，否则 `INVALID_REPORT_FORMAT`；
  - `:26` 调 `exports.export(caller, instanceId, revisionId, format)`。

## 3. 应用服务层

`order-center-modules/reporting/application/src/main/java/com/hgihtorque/ordercenter/reporting/application/DailyReportExportService.java`

- 构造：`:14` 注入 `CurrentDailyReportService` 与 `DailyWorkbookWriter`。
- 两个入口：`:16-18`（默认 json）与 `:19`（指定 format）。
- `:20` 只接受 `json|xlsx`，否则 `IllegalArgumentException("INVALID_REPORT_FORMAT")`。
- `:21` 服务层再次校验 `order:read`，否则 `SecurityException("ORDER_READ_FORBIDDEN")`。
- `:22` 用 `[A-Za-z0-9_-]{1,36}` 复检 id。
- `:23` `findRevision(tenant, actor, instance, revision)`；`:24` 非 `SUCCEEDED` 抛 `DAILY_REPORT_NOT_READY`；`:26-29` 证据一致性校验，失败抛 `DAILY_REPORT_EXPORT_EVIDENCE_INVALID`。
- `:30-32` 组装 `daily-report-export-v1` 信封并序列化；`:35-56` 校验 totals/业务日期/mode/coverage/数量精度/重复行。
- `:58-61` 仅当 `format=xlsx` 时用 `workbooks.write(...)` 生成工作簿。
- `:62` 超过 512 KiB 抛 `REPORT_EXPORT_TOO_LARGE`。
- `:63` 返回 `Export(filename,mediaType,sha256,size,contentBase64)`；`sha256` 对最终字节做 SHA-256，内容 Base64。`Export` 记录定义在 `:15`。
- 全仓检索 `DailyReportExportService` 的调用方只有 `order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:3/8/26`（另有测试直接构造服务），因此**工具层是唯一生产入口**。

## 4. 工具注册与 HTTP 边界

`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java`

- 注入：`:52-53` 通过 setter 注入 `DailyExportTool`。
- `list(caller)`（MCP 与浏览器共用）：`:87`；`:90` 判断 `dailyExport!=null && caller.scopes().contains("order:read")` 后加入 `production_daily_export`，描述为「下载固定修订日报的Excel表格或JSON证据文件及校验摘要」。
- `listApi(caller)`（仅浏览器）：`:82-86`，先 `list(caller).deepCopy()`，再为 `order_submit`/`production_daily_begin` 补 `initiatorMobile` schema（`:84`）。**目前没有任何按配置过滤/标注能力的逻辑。**
- `call(caller,name,args)`：`:119` 起；`:130` 精确分派到 `dailyExport.call(...)`（该行对应 `if(dailyExport!=null&&dailyExport.name().equals(name))return dailyExport.call(...)`）。

`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java`

- `/api/web/auth-method`：`:50-53`，返回 `method` 与 `dingtalkEnabled`，`Cache-Control: no-store`；这是登录方式探测，**不是**业务能力开关端点。
- `/api/web/session`：`:54-61`，返回 `actor/tenant/scopes/csrfToken/displayName`；`displayName` 是「服务端下发 UI 数据」的既有先例（`:59`）。
- `/api/web/capabilities`：`:62-65`，返回 `tools.listApi(caller(request))`。
- `/api/web/operations/{operation}`：`:66-92`；CSRF 校验 `:69`；**操作白名单** `:73-75` 只允许 `tools.list(caller)` 中出现的名字；异常统一转 `BusinessErrorResponse` 并把 `code` 放进响应体 `:86-89`；响应头 `X-Request-Id` `:91`。

## 5. 权限与 scope 校验点

1. 浏览器身份：`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:36-49`（container/phone/dingtalk 三种来源）；scopes 至少包含 `order:read`（`:23`、`:45-47`）。
2. HTTP 操作白名单：`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:73-75`。
3. 工具层：`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:22`。
4. 服务层：`order-center-modules/reporting/application/src/main/java/com/hgihtorque/ordercenter/reporting/application/DailyReportExportService.java:21`。
5. 工具发布层：`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java:90` 只在有 `order:read` 时发布该工具。

## 6. 错误码风格

- 业务异常即稳定大写码：`ORDER_READ_FORBIDDEN`（安全）、`INVALID_REPORT_FORMAT`/`INVALID_REPORT_EXPORT`（参数）、`DAILY_REPORT_NOT_READY`/`DAILY_REPORT_EXPORT_EVIDENCE_INVALID`/`REPORT_EXPORT_TOO_LARGE`（状态）。
- HTTP 映射集中在 `order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponse.java:17-32`：
  - `REPORT_EXPORT_TOO_LARGE` → 422 + `EXPORT_TOO_LARGE`（`:20-21`）；
  - `SecurityException` → 403 `FORBIDDEN`（`:25`）；
  - `DAILY_REPORT_NOT_READY` 等 → 409 `RESULT_NOT_READY`（`:26-27`）；
  - `IllegalArgumentException` → 422 `INVALID_INPUT`（`:30`）；
  - 其余 `IllegalStateException` → 500（`:31`）。**新增业务码必须在此登记，否则会退化成 500。**
- 浏览器读码：`order-center-web/src/api.ts:24-25` 解析响应体 `code`；码到中文的集中映射在 `:28-32`（`:32` 的 `detail` 三元是码级文案落点）。
- MCP JSON-RPC 路径：`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowMcpRequestHandler.java:42-47`；`IllegalStateException` 在 `:46` 经 `McpBusinessResult.stateMessage(...)` 转成业务失败，映射表没有的码会退化为 `isError:true` 的 `Tool execution failed`。`McpBusinessResult` 的失败结构只有 `success/message/data`（`order-center-modules/integration/application/src/main/java/com/hgihtorque/ordercenter/integration/application/McpBusinessResult.java:13-17`），**没有独立的机器可读 code 字段**。

## 7. 配置读取方式（实际用法）

- 主流是 `@Value` 标量注入：
  - `order-center-modules/order/infrastructure/src/main/java/com/hgihtorque/ordercenter/order/infrastructure/configuration/PreviewSkillConfiguration.java:24-27`；
  - `order-center-modules/reporting/infrastructure/src/main/java/com/hgihtorque/ordercenter/reporting/infrastructure/configuration/DailyReportConfiguration.java:22-25`；
  - 带默认值的 `@Value`：`order-center-modules/order/infrastructure/src/main/java/com/hgihtorque/ordercenter/order/infrastructure/storage/ArtifactConfiguration.java:6-7`（`${ordercenter.artifacts.root:.runtime/artifacts}`、`${ordercenter.files.inspection:deny}`）。
- `@ConfigurationProperties` 只用于成组配置，共 3 处：`order-center-modules/integration/infrastructure/src/main/java/com/hgihtorque/ordercenter/integration/infrastructure/mcp/IntegrationMcpProperties.java:4`、`order-center-modules/integration/interfaces/src/main/java/com/hgihtorque/ordercenter/integration/interfaces/security/InternalAuthProperties.java:5`、`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/security/WorkflowAuthProperties.java:4`。
- `@ConditionalOnProperty` 用于 **Bean 是否存在**，不是方法级开关：
  - `order-center-modules/order/infrastructure/src/main/java/com/hgihtorque/ordercenter/order/infrastructure/configuration/PreviewSkillConfiguration.java:20-21`（`ordercenter.preview.enabled=true`）；
  - `order-center-modules/workflow/infrastructure/src/main/java/com/hgihtorque/ordercenter/workflow/infrastructure/scheduling/EventRecoveryJob.java:12`（`ordercenter.recovery.enabled`，`matchIfMissing=true`）；
  - `order-center-modules/integration/infrastructure/src/main/java/com/hgihtorque/ordercenter/integration/infrastructure/browser/BrowserInventoryConfiguration.java:8`、`order-center-modules/integration/infrastructure/src/main/java/com/hgihtorque/ordercenter/integration/infrastructure/browser/BrowserBomConfiguration.java:10` 等（`ordercenter.kingdee.browser.enabled=true`）。
- 环境变量式部署开关的实际位置：`deploy/compose.local.yaml:27`（`ORDERCENTER_KINGDEE_BROWSER_ENABLED`）、`:37`（`ORDERCENTER_RECOVERY_ENABLED`）；生产 properties：`deploy/production/application-prod.properties:10`、`:17`；QA ConfigMap：`deploy/tx/qa/manifests/business-secret.yaml:129`。

> 与任务简述的差异（已复核）：`deploy/application-container.yml:17` 实际是 `management.endpoint.health.probes.enabled`，该文件没有 `ORDERCENTER_*` 业务开关；环境变量式开关在 `deploy/compose.local.yaml:27/37`。`PreviewSkillConfiguration` 的 `@ConditionalOnProperty` 确认在 `:21`。

## 8. 前端 flag 获取方式

- 登录期：`order-center-web/src/main.tsx:38-39` 从 `/auth-method` 读 `dingtalkEnabled` 并选择登录方式。
- 会话期：`order-center-web/src/main.tsx:40` 读 `/session`（类型见 `order-center-web/src/api.ts:1`，当前无任何配置 flag）与 `/capabilities`。
- 能力清单类型：`order-center-web/src/BusinessForm.tsx:10` — `{name,description,inputSchema}`，当前无 `enabled` 字段。
- 结论：**`/capabilities` 是现成的、按身份下发、且已被用来控制导出按钮可见性的服务端 UI 通道**（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:62-65` → `order-center-web/src/RecordWorkbench.tsx:18`）。

## 9. 测试组织方式

- 跨模块回归在 `order-center-tests/workflow`、`order-center-tests/integration`（`README.md:18` 附近；模块 `order-center-tests/pom.xml` 只含 `workflow`、`integration`）。
- 新测试必须 `@Tag("TEST")`（`AGENTS.md:17`、`README.md:53`）。
- 已有导出测试：
  - 服务纯单元测试：`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/DailyReportExportTest.java:9-57`（`@Tag("TEST")`，直接 `new DailyReportExportService(...)`，覆盖证据/摘要/非法数量）。
  - 契约清单：`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/ApiContractExportTest.java:11-24`（`@SpringBootTest @ActiveProfiles("test")`，遍历 `registry.list(...)` 断言描述非空）。
  - MCP HTTP 端到端：`order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/UploadMcpHttpTest.java:369-375`（真实 `/mcp` 调用导出，xlsx 用 POI 打开校验）。
  - 工具清单钉子：`order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/AllExposedToolsProjectionGateTest.java:14`（26 个工具名，含 `production_daily_export`）。
- 错误映射单测：`order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponseTest.java:7-39`。
- 前端没有单测/E2E 框架：`order-center-web/package.json:10` 的 `test` 只是 3 个 node 契约脚本；`devDependencies`（`:18-23`）无 vitest/testing-library。

## 10. 其他相关事实

- MCP 工具清单由 `list()` 生成，`tools/list` 在 `order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowMcpRequestHandler.java:38` 输出；禁用时若直接从 `list()` 移除工具，调用方会得到「工具不存在/无权」这类不透明结果，且浏览器白名单（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:73-75`）会在工具层之前返回 403。
- 浏览器 `execute` 的审计：`:83` 记录请求，`:90` 记录结果；工具抛出的拒绝同样会被审计。
- 生产配置导入：`deploy/production/application-prod.properties:2` 通过 `spring.config.import` 引入 `file:/etc/order-center-business/application-extra.properties`。
- 文档要求：修改 MCP 工具必须阅读 `docs/api/mcp-tool-contract-standard.md`，逐工具填写 `docs/api/mcp-tool-review-template.md`，并运行 `scripts/verify-mcp-contract.ps1`（`AGENTS.md:7-15`；`docs/api/mcp-tool-contract-standard.md:54-60`、`:64`）。
