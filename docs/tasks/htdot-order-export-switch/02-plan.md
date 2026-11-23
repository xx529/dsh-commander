# 02 改动方案：`production_daily_export` 服务端开关

> 路径约定：目标仓库相对路径基于 `/Users/lzx/Documents/sunteng/Htdot-OrderCenter`；补丁文件为同目录 `patch.diff`。

## 0. 主假设（按任务给定实现）

「给订单导出加个开关」= **新增一个服务端全局配置开关，默认开启；关闭后 MCP 工具明确拒绝、Web 端隐藏按钮并给出可读原因；开启时行为与当前逐字节一致。**

- 键名：`ordercenter.report.export.enabled`
- 默认值：`true`（代码内 `${ordercenter.report.export.enabled:true}`；生产 properties 显式写 `true`）
- 作用域：整个部署实例的日报固定修订导出（`production_daily_export` / xlsx+json 两种格式一起关）
- 备选解读（按租户/按角色/仅 xlsx/仅 UI 隐藏）列入「开放问题」，不在本补丁实现。

## 1. 选型结论

### 1.1 为什么不是 `@ConditionalOnProperty` 移除 Bean

`@ConditionalOnProperty` 在仓库里用于「Bean 是否创建」（`order-center-modules/order/infrastructure/src/main/java/com/hgihtorque/ordercenter/order/infrastructure/configuration/PreviewSkillConfiguration.java:20-21`、`order-center-modules/workflow/infrastructure/src/main/java/com/hgihtorque/ordercenter/workflow/infrastructure/scheduling/EventRecoveryJob.java:12`）。若用它移除 `DailyExportTool`：

- `WorkflowToolRegistry.list()` 会少发工具（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java:90`），浏览器操作白名单（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:73-75`）在到达工具前就返回 403，**拿不到 `REPORT_EXPORT_DISABLED` 这个可区分码**；
- MCP 直接按名字调用会走到 `UNKNOWN_TOOL`/403，而不是明确说明「功能被关闭」；
- 与需求 a)「必须明确拒绝、不得空结果或伪成功、码可区分」冲突。

因此采用**方法级运行期判断**（`@Value` 注入 boolean），工具始终存在、始终可被调用，但关闭时在参数校验前拒绝。

### 1.2 为什么前端标志走 `/capabilities`，而不是 `/auth-method` 或 `/session`

- `/auth-method` 是**登录前**的认证方式探测，返回 `method/dingtalkEnabled`（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:50-53`），前端只在连接阶段读取（`order-center-web/src/main.tsx:38-39`）；把业务开关塞进认证端点语义不符，且需要在 `order-center-web/src/main.tsx → BusinessTabs → RecordWorkbench` 层层传 prop。
- `/session` 返回身份/租户/scopes/CSRF/displayName（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:54-61`），确实有 `displayName` 这种 UI 数据先例，但它不描述「可调用能力」，且同样需要新增字段与读取点。
- `/capabilities` 本来就是**按身份下发的可调用能力清单**（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:62-65`），并且**已经是导出按钮可见性的唯一依据**（`order-center-web/src/RecordWorkbench.tsx:18`）。在能力条目上加一个可选 `enabled:false`，前端改动最小、单一事实源，且 `Session` 不需要改。
- 为兼容旧后端/旧缓存：字段缺失 = 开启；旧前端忽略未知字段，行为不变。

### 1.3 关闭时 MCP 仍发布工具（有意为之）

关闭时**不**从 `tools/list` 移除工具，只在浏览器能力清单里标 `enabled:false`。这样：

- 已缓存的 MCP 客户端调用时得到稳定业务码，而不是「工具不存在」；
- 浏览器侧即使拿到旧能力列表强行点击，也会到达工具层拿到 `REPORT_EXPORT_DISABLED`，而不是白屏 403。
- 代价：MCP 客户端仍能看到一个当前不可用的工具。列入「开放问题」。

## 2. 逐文件改动

| # | 文件 | 改什么 | 为什么 |
|---|---|---|---|
| 1 | `order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/ReportExportSwitch.java`（新增） | `@Component`，单构造器 `@Value("${ordercenter.report.export.enabled:true}") boolean`，暴露 `enabled()` | 配置的单一读取点；`reporting.interfaces` 已被组件扫描（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/configuration/WorkflowModuleConfiguration.java:5`） |
| 2 | `order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java` | 构造器加 `ReportExportSwitch`；新增 `public boolean enabled()`；`call()` 在 `order:read` 校验之后、参数校验之前加 `if(!settings.enabled())throw new IllegalStateException("REPORT_EXPORT_DISABLED");` | 需求 a)；顺序保证「未授权先拒绝」，不向无权限方泄露配置状态 |
| 3 | `order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java` | `listApi()` 中，当 `dailyExport` 存在且关闭时，给能力对象加 `"enabled": false` | 需求 b/c)；`list()` 不变，MCP 仍发布工具（见 1.3） |
| 4 | `order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponse.java` | 新增分支：`IllegalStateException("REPORT_EXPORT_DISABLED")` → `422 / REPORT_EXPORT_DISABLED / "日报导出功能已关闭，请联系管理员开启"` | 浏览器路径要拿到稳定 `code`；不登记会落到 `:31` 的 500 |
| 5 | `order-center-modules/integration/application/src/main/java/com/hgihtorque/ordercenter/integration/application/McpBusinessResult.java` | `stateMessage` 新增 case，文案含 `（REPORT_EXPORT_DISABLED）` | MCP `IllegalStateException` 若未映射会退化为 `Tool execution failed`（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowMcpRequestHandler.java:46`）；该文案是当前 MCP 契约下唯一可区分载体 |
| 6 | `order-center-web/src/BusinessForm.tsx` | `Capability` 增加可选 `enabled?:boolean` | 类型契约 |
| 7 | `order-center-web/src/RecordWorkbench.tsx` | 取出 `exportCapability`；按钮条件加 `enabled!==false`；`enabled===false` 时渲染「日报导出功能已关闭，请联系管理员开启。」 | 需求 b)；保持原能力缺失时同样不显示（旧行为） |
| 8 | `order-center-web/src/api.ts` | `detail` 码映射新增 `REPORT_EXPORT_DISABLED` → 中文原因 | 旧页面/强制调用时也能显示可读原因，而不是「请检查填写的业务参数。」 |
| 9 | `deploy/production/application-prod.properties` | 末尾显式加 `ordercenter.report.export.enabled=true` | 让生产配置可见、可检索；默认值仍然是代码内 `:true` |
| 10 | `order-center-tests/workflow/src/test/java/com/hgihtorque/ordercenter/workflow/DailyExportSwitchTest.java`（新增） | 默认开/显式关/权限缺失/非法参数/能力标记/属性绑定/MCP 文案 | 见 03 |
| 11 | `order-center-boot/src/test/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponseTest.java` | 增加 `REPORT_EXPORT_DISABLED` 的 422/code/message 断言 | 防止码映射回退成 500 |

### 装配位置说明

- 新 `@Component` 位于 `com.hgihtorque.ordercenter.reporting.interfaces.mcp`，该包在 `WorkflowModuleConfiguration` 的 `@ComponentScan(basePackages={...,"com.hgihtorque.ordercenter.reporting.interfaces",...})` 内（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/configuration/WorkflowModuleConfiguration.java:5`）。`OrderCenterApplication` 通过 `@Import(WorkflowModuleConfiguration.class)` 引入（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/OrderCenterApplication.java:3`）。
- `DailyExportTool` 是单构造器 `@Service`，Spring 自动注入两个参数；测试直接 `new DailyExportTool(exports, new ReportExportSwitch(...))`。
- 开关只在启动期求值（构造器注入），不引入可刷新配置。

## 3. 关闭时的完整执行路径

### 3.1 浏览器初连 / 渲染

1. `GET /api/web/capabilities` → `BrowserBusinessController.capabilities`（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:62-65`）→ `WorkflowToolRegistry.listApi`（`:82`）。
2. `listApi` 基于 `list(caller)`（`:87`）；导出工具仍被加入（`:90`，因为 `order:read` 存在）。
3. 新增逻辑：`dailyExport.enabled()==false` → 给该能力节点写 `enabled:false`。
4. 前端 `order-center-web/src/main.tsx:40` 拿到能力列表，`:67` 传给 `BusinessTabs`，`order-center-web/src/BusinessTabs.tsx:19` 传给 `RecordWorkbench`。
5. `RecordWorkbench` 新增 `exportCapability`；`:18` 因 `enabled===false` 不渲染 `<DailyExport>`，渲染可见原因「日报导出功能已关闭，请联系管理员开启。」

结果：**按钮不显示 + 有可读原因**；不依赖客户端是否理解新字段——旧前端仍会显示按钮，但点击后会走到下面的服务端拒绝。

### 3.2 浏览器强行/旧页面调用

1. `POST /api/web/operations/production_daily_export` → CSRF（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:69`）。
2. 操作白名单（`:73-75`）通过（工具仍在 `list()` 中）。
3. `WorkflowToolRegistry.call` 分派到 `dailyExport.call(...)`（`:130`）。
4. `DailyExportTool.call`：先 scope（`:22`），再新开关判断 → `IllegalStateException("REPORT_EXPORT_DISABLED")`。**不会触达 `DailyReportExportService`，不会生成工作簿、不会查修订。**
5. `BrowserBusinessController.execute` 捕获（`:86`）→ `BusinessErrorResponse` 新分支 → HTTP **422**，响应体 `{code:"REPORT_EXPORT_DISABLED", error:"日报导出功能已关闭，请联系管理员开启", requestId:...}`（`:88`）。
6. 前端 `order-center-web/src/api.ts` 解析 `code`（`:24-25`），`detail` 新映射（`:32`）→ `order-center-web/src/DailyExport.tsx:17` 显示该中文原因。

### 3.3 MCP 调用

1. `tools/call`（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowMcpRequestHandler.java:42`）→ `registry.call` → 同上第 4 步。
2. `IllegalStateException` 被 `:46` 捕获；`McpBusinessResult.stateMessage` 新增 case 命中。
3. 返回 MCP 业务失败结果：`isError:false`、`structuredContent.success:false`、`message:"日报导出功能已关闭（REPORT_EXPORT_DISABLED），请联系管理员开启"`，`data:null`（`order-center-modules/integration/application/src/main/java/com/hgihtorque/ordercenter/integration/application/McpBusinessResult.java:13-17`）。
4. 这是**显式失败**，不是空结果/伪成功；`REPORT_EXPORT_DISABLED` 是稳定可区分字符串。MCP 没有独立 code 字段，见风险/开放问题。

### 3.4 开启时（默认）

- `DailyExportTool.call` 跳过新判断，后续 `:23-26` 与 `DailyReportExportService.export` 完全不变：`order:read`（`order-center-modules/reporting/application/src/main/java/com/hgihtorque/ordercenter/reporting/application/DailyReportExportService.java:21`）、format 白名单（`:20`）、id 正则（`:22`）、证据校验（`:24-29`）、xlsx 生成（`:58-61`）、512 KiB 上限（`:62`）、Base64 + SHA-256（`:63`）。
- 能力对象不带 `enabled` 字段，前端 `enabled!==false` 为真，按钮照旧。
- `/auth-method`、`/session`、MCP `tools/list` 均无变化。

## 4. 明确不在本补丁范围

- 不做按租户/按角色的开关。
- 不拆分 json 证据导出与 xlsx 导出（两者一起关）。
- 不新增管理端 UI、不新增数据库表、不做热更新。
- 不改 `DailyReportExportService`（保持服务层既有语义；是否在该层再加一道防护列入开放问题）。
- 不补该工具的 outputSchema/fields 迁移（历史遗留，见 04 与 MCP 契约规范）。
