# 04 风险与回滚：`production_daily_export` 开关

> 目标仓库：`/Users/lzx/Documents/sunteng/Htdot-OrderCenter`。以下按影响排序。

## 1. 默认值对生产的影响

- 默认 **开启**：代码内 `${ordercenter.report.export.enabled:true}`（`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/ReportExportSwitch.java`，补丁新增），且 `deploy/production/application-prod.properties` 显式写 `true`。未配置该键的既有部署行为不变。
- **失败开放（fail-open）**：属性名拼错、profile 未加载、配置中心漏发时，开关仍然是 `true`。这是「不改变现有行为」的代价。若业务要求「配置缺失即关闭」，应去掉 `:true` 默认并在所有环境显式配置；否则启动会因占位符无法解析而失败，需要另行评估。
- 该开关是**全局**的，不是按租户/角色。关闭会同时停掉所有租户、所有有 `order:read` 用户的 json 与 xlsx 导出。

## 2. 求值时机 / 缓存 / 启动期

- `ReportExportSwitch` 用构造器 `@Value` 注入，**只在 Spring 启动时求值一次**；没有 `@RefreshScope`、没有 Actuator refresh、没有数据库轮询。改配置必须重启/重新发布实例。
- `/api/web/capabilities` 每次请求都会重新组装（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:62-65`），但前端只在连接时拉取一次（`order-center-web/src/main.tsx:40`）并存入 React state，之后不会自动刷新。开关切换后：
  - 已打开页面仍按旧 flag 显示，需刷新/重新连接；
  - 旧页面强行点击会由服务端拒绝（422 + 可读原因），不会静默成功。
- 若未来引入配置热更新，`@Value` 构造器注入不会跟随变化，需要改成可刷新的配置 Bean；当前设计明确不支持。

## 3. 多实例 / 多进程

- 开关是**进程内配置**：每个 JVM 读取自己的环境变量/配置文件。滚动发布或灰度时可能出现：
  - A 实例 `false`：`/capabilities` 标 `enabled:false`、调用被拒；
  - B 实例 `true`：同一用户刷新后按钮又出现、调用成功。
- `/mcp` 与 `/api/web` 若经负载均衡打到不同实例，拒绝行为会随实例漂移。切换窗口内应确保所有实例使用同一配置值，或一次性全量重启。
- 浏览器会话（`/session` 的 CSRF）不跨实例共享（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:56-58` 使用 servlet session）；这与本开关无关，但会影响「切换后要求用户重新连接」的体验。
- stdio 形态（`StdioLauncher`）也会加载同一 Spring 上下文，同样受该属性影响；stdio 部署需单独设置属性（见 `order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/StdioLauncher.java:25` 的既有属性注入方式）。

## 4. 行为与契约风险

- **MCP 没有独立错误码字段**：本补丁把 `REPORT_EXPORT_DISABLED` 放进中文 message（`order-center-modules/integration/application/src/main/java/com/hgihtorque/ordercenter/integration/application/McpBusinessResult.java` 新增 case）。MCP 失败信封只有 `success/message/data`（`order-center-modules/integration/application/src/main/java/com/hgihtorque/ordercenter/integration/application/McpBusinessResult.java:13-17`），调用方若只做机器匹配，需要匹配文本。要提供真正的 `code` 字段，必须扩展共享结果契约，影响所有工具，需单独评审。
- **MCP 仍发布工具**：关闭时 `tools/list` 仍包含 `production_daily_export`（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowToolRegistry.java:90` 未改）。好处是调用方能拿到明确拒绝；坏处是工具目录显示「可用」但调用必失败。若更希望「关闭即不可见」，改为在 `list()` 过滤即可，但浏览器会在白名单层得到 403（`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java:73-75`），拿不到 `REPORT_EXPORT_DISABLED`。
- **浏览器白名单仍允许该操作**：关闭时工具仍在 `list()` 中，白名单放行，最终由工具拒绝。若将来新增第二个派发入口而漏掉工具层，防护会被绕过。防御性方案是在 `DailyReportExportService.export` 也加一道开关判断；本补丁未做（保持服务层现状、避免改动既有服务测试），列入开放问题。
- **HTTP 状态选择**：本补丁返回 422（与 `EXPORT_TOO_LARGE` 的既有风格一致，`order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BusinessErrorResponse.java:20-21`）。若前端/网关按 403/503 做特殊处理，需要同步调整；码本身是稳定的。
- **审计**：关闭态调用仍会进入 `order-center-boot/src/main/java/com/hgihtorque/ordercenter/boot/web/BrowserBusinessController.java` 的审计（`:83`、`:90`）和 MCP 的 `McpFailureDiagnostics`（`order-center-modules/workflow/interfaces/src/main/java/com/hgihtorque/ordercenter/workflow/interfaces/mcp/WorkflowMcpRequestHandler.java:46`），与其它业务失败一致；确认审计报表是否需要单列该原因。
- **可读原因的位置**：按钮被移除，原因以内联文本出现在详情工具栏（`order-center-web/src/RecordWorkbench.tsx:18`）。没有 tooltip/禁用态样式；若设计要求「置灰 + tooltip」，需要 UI 稿另行实现。

## 5. 部署配置需同步的位置

| 位置 | 现状/动作 |
|---|---|
| `deploy/production/application-prod.properties` | 补丁已在末尾显式加 `ordercenter.report.export.enabled=true` |
| `deploy/production/application-prod.properties:2` 的 `spring.config.import` | 生产还会导入 `file:/etc/order-center-business/application-extra.properties`，**实际覆盖值可能在这里**，发布前确认 |
| `deploy/tx/qa/manifests/business-secret.yaml:129` | QA ConfigMap 已承载 `ordercenter.kingdee.browser.enabled` 一类属性；若 QA 要验证关闭态，应在此同步 |
| `deploy/compose.local.yaml` | 本地用环境变量风格（`:27`、`:37`）；可加 `ORDERCENTER_REPORT_EXPORT_ENABLED: "false"` 验证；Spring relaxed binding 会把环境变量映射到 `ordercenter.report.export.enabled` |
| 其它环境 | 任何注入 `ORDERCENTER_*`/`ordercenter.*` 的 ConfigMap、Secret、启动脚本都要检查；默认不配即开启 |

注意：`deploy/application-container.yml` **没有**业务开关（其 `:17` 是健康检查 probes），不要误改。

## 6. 回滚

- **配置回滚**：把 `ordercenter.report.export.enabled` 改回 `true`（或删除覆盖项），重启实例即可。无数据库迁移、无数据写入、无外部副作用。
- **代码回滚**：补丁是纯新增字段/分支；回退后：
  - `DailyExportTool` 恢复单构造器；
  - 旧前端忽略能力条目上的 `enabled` 字段，行为回到「始终显示按钮」；
  - 已发出的 422 错误码消失，调用恢复。
- **不会丢失**：已下载文件、历史修订、审计记录均不受影响。
- **灰度建议**：先在单实例/QA 用 `false` 验证 UI 与 MCP 拒绝，再全量；回滚只需改配置重启，不需要回滚代码。

## 7. 验证缺口（本次交付的真实限制）

1. 本机没有 `mvn`、没有 `order-center-web/node_modules`，**未编译、未跑 JUnit、未跑 `tsc`/Vite**；`patch.diff` 只经过 `git apply --check` 与「应用后与手工编辑结果逐文件 SHA-256 比对」。
2. 没有 Spring MVC 端到端测试覆盖「关闭态 422 + 能力标记」；建议按 03 §5 补。
3. 没有前端点击走查；`npm run build` 可能暴露类型/编译问题（本补丁的 TS 改动很小，但未实证）。
4. MCP 契约审查记录（`docs/api/mcp-tool-review-template.md`）未填写，`scripts/verify-mcp-contract.ps1` 未运行；按 `AGENTS.md:7-15` 合并前必须补。
5. 该工具本身没有 outputSchema/fields（`order-center-modules/reporting/interfaces/src/main/java/com/hgihtorque/ordercenter/reporting/interfaces/mcp/DailyExportTool.java:11-19`），属于历史遗留；本次只改行为与错误码，不应被解读为工具已符合统一契约规范。
