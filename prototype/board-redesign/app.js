/* =====================================================================
 * 看板 / 回收站 · 视觉方案原型（一次性，勿并入生产）
 *
 * 三套结构完全不同的方案，?variant=A|B|C 切换；看板与回收站两屏共用同一套
 * 假数据。数据、分页、筛选全部在内存里模拟，只为回答「界面应该长什么样」。
 *
 *   A  紧凑六列 + 卡片内「依赖闸门」      回收站：数据表 + 页码分页
 *   B  状态分组列表 + 主从详情（依赖图）   回收站：分月列表 + 无限加载 + 预览
 *   C  依赖地图（节点/连线）+ 状态泳道    回收站：归档时间流 + 批量加载
 * ===================================================================== */
'use strict';

/* ------------------------------------------------------------------ 基础 */
const VERSIONS = {
  combo: '六列 + 悬停依赖链',
  A: '对照 A · 六列 + 表格回收站',
  B: '对照 B · 分组列表 + 主从详情',
  C: '对照 C · 独立依赖视图',
};
const STATUS = [
  { id: 'proposed', label: '待派发' },
  { id: 'queued', label: '待运行' },
  { id: 'running', label: '运行中' },
  { id: 'blocked', label: '受阻' },
  { id: 'review', label: '待验收' },
  { id: 'done', label: '已验收' },
];
const STATUS_LABEL = Object.fromEntries(STATUS.map((s) => [s.id, s.label]));
const PRIO_LABEL = { low: '低', normal: '普通', high: '高', urgent: '紧急' };
const NOW = Date.parse('2026-11-24T10:33:00+08:00');
const minAgo = (m) => NOW - m * 60_000;

const ICON = {
  search: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chain: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6.6 9.4 9.4 6.6M5.3 8.1 4 9.4a2.4 2.4 0 0 0 3.4 3.4l1.3-1.3M10.7 7.9 12 6.6a2.4 2.4 0 0 0-3.4-3.4L7.3 4.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  dots: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.2" cy="8" r="1.15" fill="currentColor"/><circle cx="8" cy="8" r="1.15" fill="currentColor"/><circle cx="12.8" cy="8" r="1.15" fill="currentColor"/></svg>',
  restore: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6.5a4.6 4.6 0 1 1-.4 3.1M4 3.2v3.4h3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8h9M8.4 4.4 12 8l-3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ------------------------------------------------------------------ 看板数据 */
const t = (id, title, status, ws, prio, round, deps, minsAgo, extra = {}) => ({
  id, title, status, ws, prio, round, deps, at: minAgo(minsAgo), ...extra,
});

const BOARD = [
  // 链 1：SSE 降级
  t('t201', '调研 DSH SSE 断线语义与重连上限', 'done', 'Research', 'normal', 1, [], 245),
  t('t202', '设计「3 秒只读快照」降级契约', 'review', 'Research', 'high', 1, ['t201'], 53, { sessions: 3, capability: 5 }),
  t('t203', '实现 client 重连与快照降级', 'running', 'agent-workspace', 'urgent', 2, ['t201'], 35, { sessions: 2, capability: 4, stale: true }),
  t('t204', '补 SSE 降级集成测试（断线/429/重连）', 'queued', 'agent-workspace', 'high', 1, ['t203'], 28),
  t('t205', '发布 0.5.0 并更新安装说明', 'proposed', 'docs-site', 'normal', 1, ['t204'], 21),

  // 链 2：回收站分页
  t('t211', '盘点 archive API 游标语义与上限', 'done', 'agent-workspace', 'normal', 1, [], 875),
  t('t212', '回收站分页 + 搜索接口', 'running', 'agent-workspace', 'high', 2, ['t211'], 12, { sessions: 4, capability: 3 }),
  t('t213', '回收站 UI 分页与批量恢复', 'queued', 'agent-workspace', 'normal', 1, ['t212'], 29),
  t('t214', '回收站保留策略与清理节奏', 'proposed', 'Research', 'low', 1, ['t212', 't213'], 930),

  // 链 3：依赖展示
  t('t221', '看板依赖徽标文案重写', 'review', 'docs-site', 'normal', 1, ['t201'], 73),
  t('t222', '看板卡依赖链展开交互', 'proposed', 'agent-workspace', 'high', 1, ['t221', 't212'], 7, { pending: true }),
  t('t223', '依赖就绪时提醒指挥官（不自动派发）', 'queued', 'agent-workspace', 'normal', 1, ['t221'], 895),

  // 链 4：桌面端
  t('t231', 'agent-desktop 截屏失败复现与最小用例', 'blocked', 'agent-desktop', 'high', 1, [], 1_680, { block: 'permission_denied' }),
  t('t232', '修复 desktop 截屏权限弹窗', 'proposed', 'agent-desktop', 'normal', 1, ['t231'], 1_120),
  t('t233', '清理测试残留 profile 与临时目录', 'blocked', 'docs-site', 'low', 1, ['t211'], 2_420, { block: 'workspace_locked' }),

  // 独立任务
  t('t241', '补 commander_task_list 输出 schema 测试', 'queued', 'agent-workspace', 'normal', 1, [], 91),
  t('t242', '整理本周研究简报（11-17 ~ 11-23）', 'review', 'Research', 'normal', 1, [], 738, { sessions: 2 }),
  t('t243', '排查线上 SSE 429 断流（含日志）', 'blocked', 'Research', 'urgent', 2, ['t203'], 2_620, { block: 'upstream_429', stale: true }),
  t('t244', '重写 README 安装步骤（pnpm 版本约束）', 'proposed', 'docs-site', 'low', 1, [], 3_930),
  t('t245', '核验 publish 脚本 dry-run', 'done', 'agent-workspace', 'normal', 1, [], 1_240),
  t('t246', '同步 i18n 两份字典（zh / en）', 'running', 'agent-workspace', 'normal', 1, [], 18, { sessions: 1 }),
  t('t247', '审查 PR #412 存储迁移（7 张表）', 'review', 'agent-workspace', 'high', 2, ['t211'], 103, { sessions: 3, capability: 2 }),
  t('t248', '修正看板时间格式化（跨日/跨年）', 'review', 'agent-workspace', 'low', 1, [], 913),
  t('t249', '调研 OpenUI Lang 定位与生态', 'queued', 'Research', 'normal', 1, [], 1_208),
  t('t250', '整理 M1 验证证据到 docs/validation', 'done', 'docs-site', 'low', 1, [], 4_060),
  t('t251', '核实 GPT 最近一周是否发新模型', 'done', 'Research', 'normal', 1, [], 5_320),
  t('t252', '修复回收站恢复后计数不刷新', 'done', 'agent-workspace', 'normal', 1, [], 6_400),
  t('t253', '核查 Gemini 最近一周是否发布新模型', 'done', 'Research', 'low', 1, [], 5_050),
];
const TASK_BY_ID = new Map(BOARD.map((task) => [task.id, task]));

/** 依赖派生：谁在等、是否就绪。 */
function depInfo(task) {
  const deps = task.deps.map((id) => TASK_BY_ID.get(id)).filter(Boolean);
  const waiting = deps.filter((d) => d.status !== 'done');
  return { deps, waiting, ready: deps.length > 0 && waiting.length === 0 };
}
/** 依赖闭包（用于「聚焦依赖链」）。 */
function chainOf(taskId) {
  const set = new Set([taskId]);
  const walk = (id, dir) => {
    const task = TASK_BY_ID.get(id);
    if (!task) return;
    if (dir === 'up') {
      task.deps.forEach((dep) => {
        if (!set.has(dep)) { set.add(dep); walk(dep, dir); }
      });
      return;
    }
    BOARD.filter((row) => row.deps.includes(id)).forEach((row) => {
      if (!set.has(row.id)) { set.add(row.id); walk(row.id, dir); }
    });
  };
  walk(taskId, 'up');
  walk(taskId, 'down');
  return set;
}

/* ------------------------------------------------------------------ 回收站数据 */
const RESEARCH_TITLES = [
  '调研 MCP 协议最近一个月（{r1} ~ {r2}）是否有更新',
  '调研 A2UI 协议最近一个月（{r1} ~ {r2}）更新情况',
  '调研 Agent Skills 协议最近一个月（{r1} ~ {r2}）是否有更新',
  '调研 DSH 中 intelligent UI / OpenUI Lang / A2UI 相关插件与 desktop profile 兼容性',
  '调研 HarnessX 与 DSH 的关系：插件、桌面客户端还是同名项目',
  '调研 pydantic-ai 本周（{r1} ~ {r2}）更新情况',
  '调研 FastAPI 本周（{r1} ~ {r2}）更新情况',
  '调研 SQLModel 本周（{r1} ~ {r2}）更新情况',
  '调研 OpenUI Lang：定位、语法规范与生态现状',
  '调研面壁智能近半年（{r1} ~ {r2}）是否发布新模型',
  '核查腾讯混元最近一周（{r1} ~ {r2}）是否发布大模型',
  '核查 Gemini 最近一周（{r1} ~ {r2}）是否发布新模型',
  '核查 GPT 最近一周（{r1} ~ {r2}）是否发布新模型',
  '核查 GLM 最近一周（{r1} ~ {r2}）是否发布新模型',
  '核查 Kimi 最近一周（{r1} ~ {r2}）是否发布新模型',
  '核查 DeepSeek 本周（{r1} ~ {r2}）是否发布新模型',
  '调研 Qwen4 是否发布及其能力提升',
  '调研 Claude 本周（{r1} ~ {r2}）模型更新与定价',
  '调研 Mistral 最近一个月（{r1} ~ {r2}）发布节奏',
  '调研 Llama 系列最近一个月（{r1} ~ {r2}）生态进展',
];
const TASK_TITLES = [
  '补 SSE 断线重连的回归用例',
  '梳理 commander 域的 7 张表与写入路径',
  '修复窄窗口下横向滚动条消失',
  '验证 3 秒只读快照降级在弱网下的表现',
  '把验收材料从会话搬进任务详情',
  '对齐看板时间格式与相对时间',
  '复现恢复后计数不刷新的问题',
  '清理 playwright 下载失败的缓存目录',
  '核对 i18n 字典中缺失的 key',
  '补 pnpm workspace 的 node 版本约束',
  '给 archive 接口补 limit 越界测试',
  '统一派发确认卡的文案',
  '检查 SSE 降级时的只读快照',
  '补充任务依赖的就绪提醒',
];
const MODULES = ['看板', '回收站', 'SSE 降级', '派发门控', 'i18n', '存储迁移', '验收材料', '桌面端', '会话轮换', '验收路由', '任务详情', '构建脚本'];

const TRASH_WS = ['Research', 'agent-workspace', 'agent-desktop', 'docs-site'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTrash(count) {
  const rand = mulberry32(0x51ee7);
  const rows = [];
  let researchIdx = 0;
  let taskIdx = 0;
  const md = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  for (let i = 0; i < count; i += 1) {
    const days = Math.floor(rand() * 186);
    const secs = Math.floor(rand() * 86_400);
    const archivedAt = NOW - days * 86_400_000 - secs * 1_000 - i * 1_000;
    let title;
    if (i % 5 < 2) {
      const tpl = RESEARCH_TITLES[researchIdx % RESEARCH_TITLES.length];
      researchIdx += 1;
      const end = archivedAt - 2 * 86_400_000;
      title = tpl.replace('{r1}', md(end - 6 * 86_400_000)).replace('{r2}', md(end));
    } else {
      const module = MODULES[taskIdx % MODULES.length];
      const base = TASK_TITLES[Math.floor(taskIdx / MODULES.length) % TASK_TITLES.length];
      taskIdx += 1;
      title = `${module}：${base}`;
    }
    const status = rand() < 0.805 ? 'archived' : 'cancelled';
    const wsRoll = rand();
    const ws = wsRoll < 0.44 ? 'Research' : wsRoll < 0.84 ? 'agent-workspace' : wsRoll < 0.94 ? 'agent-desktop' : 'docs-site';
    const prioRoll = rand();
    const prio = prioRoll < 0.68 ? 'normal' : prioRoll < 0.84 ? 'high' : prioRoll < 0.93 ? 'low' : 'urgent';
    rows.push({
      id: `tsk-${(0x8f2a + i).toString(16).slice(-4)}${i}`,
      title,
      status,
      ws,
      prio,
      round: 1 + Math.floor(rand() * 3),
      sessions: Math.floor(rand() * 4),
      archivedAt,
    });
  }
  return rows.sort((a, b) => b.archivedAt - a.archivedAt);
}

/* ------------------------------------------------------------------ 格式化 */
const pad = (n) => String(n).padStart(2, '0');
const fmtMD = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtFull = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDay = (ms) => {
  const d = new Date(ms);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${week}`;
};
const monthKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (key) => `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`;
const num = (n) => n.toLocaleString('zh-CN');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ 状态 */
const params = new URLSearchParams(location.search);
const state = {
  variant: VERSIONS[params.get('variant')] ? params.get('variant') : 'combo',
  tab: params.get('tab') === 'trash' ? 'trash' : 'board',
  theme: params.get('theme') === 'light' ? 'light' : 'dark',
  scale: 1,
  boardQuery: '',
  boardFilter: 'all',
  focusChain: !!params.get('focus'),
  showAllEdges: false,
  selected: 't203',
  expanded: new Set(['t222']),
  trashQuery: '',
  trashStatus: 'all',
  trashWs: 'all',
  trashMonth: 'all',
  page: 1,
  pageSize: 50,
  loaded: 100,
  trashSel: new Set(),
  cZoom: 1,
  hover: null,
};

/* 回收站总数随「数据 ×N」变化；列表只渲染当前批次。 */
let TRASH = makeTrash(1_284);
const trashTotal = () => TRASH.length;
function trashMatches(row, options = {}) {
  const q = state.trashQuery.trim().toLowerCase();
  if (state.trashStatus !== 'all' && row.status !== state.trashStatus) return false;
  if (state.trashWs !== 'all' && row.ws !== state.trashWs) return false;
  if (options.ignoreMonth !== true && state.trashMonth !== 'all' && monthKey(row.archivedAt) !== state.trashMonth) return false;
  if (q !== '' && !(`${row.title} ${row.id}`.toLowerCase().includes(q))) return false;
  return true;
}
const filteredTrash = () => TRASH.filter((row) => trashMatches(row));
/** 月份下拉/导航用：应用搜索、状态、工作区，但不应用月份本身。 */
const trashMonthBase = () => TRASH.filter((row) => trashMatches(row, { ignoreMonth: true }));
const trashMonths = () => [...new Set(trashMonthBase().map((row) => monthKey(row.archivedAt)))];
const trashFilterActive = () => state.trashQuery.trim() !== ''
  || state.trashStatus !== 'all' || state.trashWs !== 'all' || state.trashMonth !== 'all';

/* 看板筛选 */
const filteredBoard = () => {
  const q = state.boardQuery.trim().toLowerCase();
  return BOARD.filter((task) => {
    const info = depInfo(task);
    if (state.boardFilter === 'deps' && info.deps.length === 0) return false;
    if (state.boardFilter === 'ready' && !info.ready) return false;
    if (state.boardFilter === 'blocked' && task.status !== 'blocked' && task.block === undefined) return false;
    if (state.boardFilter === 'high' && task.prio !== 'high' && task.prio !== 'urgent') return false;
    if (q !== '' && !(`${task.title} ${task.ws} ${task.id}`.toLowerCase().includes(q))) return false;
    return true;
  });
};

/* ------------------------------------------------------------------ 小组件 */
function statusDot(status) {
  return `<i class="dot" data-status="${status}" aria-hidden="true"></i>`;
}
function pill(text, tone = 'muted', extra = '') {
  return `<span class="pill" data-tone="${tone}" ${extra}>${text}</span>`;
}
function depBadge(task) {
  const info = depInfo(task);
  if (info.deps.length === 0) return '';
  if (info.waiting.length > 0) {
    return `<span class="pill dep-pill" data-tone="waiting" title="${esc(info.waiting.map((d) => d.title).join('、'))}">${ICON.chain}等 ${info.waiting.length} 个前置</span>`;
  }
  return `<span class="pill dep-pill" data-tone="ready" title="前置任务均已完成">${ICON.chain}前置已就绪</span>`;
}

/* ------------------------------------------------------------------ 外壳 */
function renderTopbar() {
  const boardCount = filteredBoard().length;
  return `<div class="topbar-inner">
    <div class="brand">
      <div class="brand-title">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>看板</h1>
        <span class="variant-chip">方案 ${state.variant === 'combo' ? '组合' : state.variant}</span>
      </div>
      <p class="brand-sub">指挥官自动维护：优先级与标题改动会同步给指挥官</p>
    </div>
    <div class="topbar-actions">
      <div class="tabs" role="tablist" aria-label="看板视图">
        <button type="button" class="tab" role="tab" data-action="tab" data-tab="board" aria-selected="${state.tab === 'board'}">
          看板<span class="tab-count">${boardCount}</span>
        </button>
        <button type="button" class="tab" role="tab" data-action="tab" data-tab="trash" aria-selected="${state.tab === 'trash'}">
          回收站<span class="tab-count">${num(trashTotal())}</span>
        </button>
      </div>
      <button type="button" class="btn btn-ghost" data-action="noop">返回对话</button>
    </div>
  </div>`;
}

function renderDock() {
  return `<div class="dock-inner">
    <button type="button" class="dock-arrow" data-action="cycle" data-dir="-1" title="上一个方案（←）" aria-label="上一个方案">‹</button>
    <div class="dock-label"><b>${state.variant === 'combo' ? '组合' : state.variant}</b><span>${VERSIONS[state.variant]}</span></div>
    <button type="button" class="dock-arrow" data-action="cycle" data-dir="1" title="下一个方案（→）" aria-label="下一个方案">›</button>
    <span class="dock-sep" aria-hidden="true"></span>
    <button type="button" class="dock-btn" data-action="tab" data-tab="board" data-on="${state.tab === 'board'}">看板</button>
    <button type="button" class="dock-btn" data-action="tab" data-tab="trash" data-on="${state.tab === 'trash'}">回收站</button>
    <span class="dock-sep" aria-hidden="true"></span>
    <button type="button" class="dock-btn" data-action="theme">${state.theme === 'dark' ? '浅色' : '深色'}</button>
    <button type="button" class="dock-btn" data-action="scale" title="回收站数据量 ×10，验证分页">数据 ×${state.scale}</button>
    <button type="button" class="dock-btn" data-action="reset">重置</button>
  </div>`;
}

/* ------------------------------------------------------------------ 方案 A · 看板 */
function boardToolbar(tasks, withFocusSwitch) {
  const stats = {
    all: tasks.length,
    deps: tasks.filter((task) => task.deps.length > 0).length,
    ready: tasks.filter((task) => depInfo(task).ready).length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    high: tasks.filter((task) => task.prio === 'high' || task.prio === 'urgent').length,
  };
  const chips = [
    ['all', '全部', stats.all],
    ['deps', '有依赖', stats.deps],
    ['ready', '已就绪', stats.ready],
    ['blocked', '受阻', stats.blocked],
    ['high', '高优', stats.high],
  ];
  return `<div class="toolbar">
    <label class="search">${ICON.search}<input type="search" data-input="board-query" placeholder="搜索任务、工作区、任务 ID…" value="${esc(state.boardQuery)}" /></label>
    <div class="chips" role="group" aria-label="任务筛选">
      ${chips.map(([id, label, n]) => `<button type="button" class="chip" data-action="board-filter" data-filter="${id}" data-on="${state.boardFilter === id}">${label}<b>${n}</b></button>`).join('')}
    </div>
    <span class="toolbar-gap"></span>
    ${withFocusSwitch
      ? `<label class="switch"><input type="checkbox" data-input="focus-chain" ${state.focusChain ? 'checked' : ''} /><span>聚焦依赖链</span></label>
         <span class="toolbar-hint">${state.focusChain ? '已高亮所选任务的上下游，再点一次卡片取消' : '点卡片聚焦它的上下游依赖'}</span>`
      : `<span class="toolbar-hint" data-board-hint>悬停任务卡查看依赖链 · 点卡片固定</span>`}
  </div>`;
}

function renderColumns(tasks, options = {}) {
  const counts = Object.fromEntries(STATUS.map((col) => [col.id, tasks.filter((task) => task.status === col.id).length]));
  const chainSet = !options.ignoreFocus && state.focusChain && state.selected ? chainOf(state.selected) : null;
  return `<div class="a-columns">
    ${STATUS.map((col) => {
      const list = tasks.filter((task) => task.status === col.id);
      return `<section class="a-col" data-status="${col.id}" aria-label="${col.label}">
        <header class="a-col-head">
          ${statusDot(col.id)}
          <h2>${col.label}</h2>
          <span class="a-col-count">${counts[col.id]}</span>
          <span class="a-col-line" aria-hidden="true"></span>
        </header>
        <div class="a-col-body">
          ${list.length === 0 ? `<div class="a-empty">暂无任务</div>` : list.map((task) => renderCardA(task, chainSet)).join('')}
        </div>
      </section>`;
    }).join('')}
  </div>`;
}

function renderBoardA() {
  const tasks = filteredBoard();
  return `<div class="a-board">${boardToolbar(tasks, true)}${renderColumns(tasks)}</div>`;
}

/** 推荐组合：六列常驻；悬停/点选任务卡时在卡上直接画依赖连线。 */
function renderBoardCombo() {
  const tasks = filteredBoard();
  return `<div class="a-board">
    ${boardToolbar(tasks, false)}
    <div class="a-board-body">
      ${renderColumns(tasks, { ignoreFocus: true })}
      <svg class="a-edges" aria-hidden="true"></svg>
    </div>
  </div>`;
}

function renderCardA(task, chainSet) {
  const info = depInfo(task);
  const downstream = BOARD.filter((row) => row.deps.includes(task.id)).length;
  const inChain = chainSet !== null && chainSet.has(task.id);
  const dim = chainSet !== null && !inChain;
  return `<article class="a-card" data-id="${task.id}" data-status="${task.status}" data-pending="${task.pending === true}" data-dim="${dim}" data-selected="${state.selected === task.id}" data-chain="${inChain && state.selected !== task.id}" tabindex="0" role="button" aria-label="${esc(task.title)}">
    <div class="a-card-head">
      <h3 class="a-card-title">${esc(task.title)}</h3>
      ${task.stale ? `<span class="mini-badge" data-tone="warn">疑似停滞</span>` : ''}
      ${task.pending ? `<span class="mini-badge" data-tone="wait">待确认</span>` : ''}
    </div>
    <div class="a-card-meta">
      <span class="ws">${task.ws}</span>
      <span class="sep">·</span>
      <span>第 ${task.round} 轮</span>
      <span class="sep">·</span>
      <span class="prio" data-prio="${task.prio}">${PRIO_LABEL[task.prio]}</span>
      ${downstream > 0 ? `<span class="downstream">下游 ${downstream}</span>` : ''}
    </div>
    ${info.deps.length === 0 ? '' : `<div class="a-gate" data-ready="${info.ready}">${renderGate(task, info)}</div>`}
    ${task.block ? `<div class="a-block">${ICON.chain}<span>受阻：${esc(task.block)}</span></div>` : ''}
    <div class="a-card-foot">
      <time>${fmtMD(task.at)}</time>
      <span class="a-card-foot-right">
        ${typeof task.capability === 'number' ? `<span>能力 ${task.capability}</span>` : ''}
        ${typeof task.sessions === 'number' ? `<span>会话 ${task.sessions}</span>` : ''}
      </span>
      <span class="a-card-acts">
        <button type="button" class="link-btn" data-action="noop">打开会话</button>
        ${task.status === 'done' ? '<button type="button" class="link-btn" data-action="noop">归档</button>' : ''}
      </span>
    </div>
  </article>`;
}

function renderGate(task, info) {
  const expanded = state.expanded.has(task.id);
  const doneCount = info.deps.length - info.waiting.length;
  const pct = Math.round((doneCount / info.deps.length) * 100);
  const shown = expanded ? info.deps : info.deps.slice(0, 2);
  const rest = info.deps.length - shown.length;
  return `<div class="a-gate-head">
      <span class="a-gate-icon">${ICON.chain}</span>
      <span class="a-gate-label">前置 <b>${doneCount}/${info.deps.length}</b></span>
      <span class="a-gate-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="a-gate-state" data-ready="${info.ready}">${info.ready ? '已就绪' : `还差 ${info.waiting.length} 个`}</span>
      <button type="button" class="a-gate-toggle" data-action="toggle-gate" data-id="${task.id}" aria-expanded="${expanded}">${expanded ? '收起' : '展开'}</button>
    </div>
    <ul class="a-gate-list" data-expanded="${expanded}">
      ${shown.map((dep) => `<li data-ok="${dep.status === 'done'}" data-status="${dep.status}" title="${esc(dep.title)}">
        <i class="dot" data-status="${dep.status}" aria-hidden="true"></i>
        <span class="a-gate-title">${esc(dep.title)}</span>
        <em>${STATUS_LABEL[dep.status]}</em>
      </li>`).join('')}
      ${!expanded && rest > 0 ? `<li class="a-gate-more">+${rest}</li>` : ''}
    </ul>`;
}

/* ------------------------------------------------------------------ 方案 A · 回收站 */
function pageCount(total) {
  return Math.max(1, Math.ceil(total / state.pageSize));
}
function pageList(page, last) {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const set = new Set([1, last, page, page - 1, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (page >= last - 2) [last - 3, last - 2, last - 1].forEach((n) => set.add(n));
  const nums = [...set].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

function renderTrashA() {
  const rows = filteredTrash();
  const total = rows.length;
  const last = pageCount(total);
  const page = Math.min(state.page, last);
  const start = (page - 1) * state.pageSize;
  const slice = rows.slice(start, start + state.pageSize);
  const months = trashMonths();
  const selCount = state.trashSel.size;
  let currentMonth = '';
  const body = slice.map((row) => {
    const m = monthKey(row.archivedAt);
    let head = '';
    if (m !== currentMonth) {
      currentMonth = m;
      head = `<div class="a-month"><span>${monthLabel(m)}</span><b>${rows.filter((r) => monthKey(r.archivedAt) === m).length} 条</b></div>`;
    }
    return `${head}<div class="a-row" data-id="${row.id}" data-selected="${state.trashSel.has(row.id)}" data-cancelled="${row.status === 'cancelled'}">
      <span class="c-check"><input type="checkbox" data-action="trash-select" data-id="${row.id}" ${state.trashSel.has(row.id) ? 'checked' : ''} aria-label="选择 ${esc(row.title)}" /></span>
      <span class="c-title">
        <span class="a-row-title">${esc(row.title)}</span>
        <span class="a-row-sub">${row.id} · 会话 ${row.sessions}</span>
      </span>
      <span class="c-type">${pill(row.status === 'archived' ? '已归档' : '已取消', row.status === 'archived' ? 'muted' : 'danger')}</span>
      <span class="c-ws">${row.ws}</span>
      <span class="c-round">第 ${row.round} 轮</span>
      <span class="c-time">${fmtMD(row.archivedAt)}</span>
      <span class="c-act">
        <button type="button" class="btn btn-sm" data-action="restore" data-id="${row.id}">${ICON.restore}恢复</button>
      </span>
    </div>`;
  }).join('');

  return `<div class="a-trash">
    <div class="toolbar">
      <label class="search">${ICON.search}<input type="search" data-input="trash-query" placeholder="搜索归档任务、任务 ID…" value="${esc(state.trashQuery)}" /></label>
      <div class="chips" role="group" aria-label="回收站筛选">
        ${[['all', '全部'], ['archived', '已归档'], ['cancelled', '已取消']].map(([id, label]) => `<button type="button" class="chip" data-action="trash-status" data-status="${id}" data-on="${state.trashStatus === id}">${label}</button>`).join('')}
      </div>
      <label class="select">工作区
        <select data-input="trash-ws">
          <option value="all">全部</option>
          ${TRASH_WS.map((ws) => `<option value="${ws}" ${state.trashWs === ws ? 'selected' : ''}>${ws}</option>`).join('')}
        </select>
      </label>
      <label class="select">月份
        <select data-input="trash-month">
          <option value="all">全部</option>
          ${months.map((m) => `<option value="${m}" ${state.trashMonth === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
      </label>
      <span class="toolbar-gap"></span>
      ${selCount > 0 ? `<span class="bulk"><b>已选 ${selCount}</b><button type="button" class="btn btn-sm" data-action="bulk-restore">批量恢复</button><button type="button" class="link-btn" data-action="clear-selection">取消</button></span>` : ''}
    </div>
    <div class="a-table" role="table" aria-label="回收站任务">
      <div class="a-thead" role="row">
        <span class="c-check"><input type="checkbox" data-action="select-page" ${slice.length > 0 && slice.every((r) => state.trashSel.has(r.id)) ? 'checked' : ''} aria-label="全选本页" /></span>
        <span class="c-title">任务</span>
        <span class="c-type">类型</span>
        <span class="c-ws">工作区</span>
        <span class="c-round">轮次</span>
        <span class="c-time">归档时间</span>
        <span class="c-act">操作</span>
      </div>
      <div class="a-tbody" role="rowgroup">${body || `<div class="a-empty big">没有匹配的归档任务</div>`}</div>
    </div>
    <footer class="a-pager">
      <span class="pager-info">共 <b>${num(total)}</b> 条 · 第 ${total === 0 ? 0 : start + 1}–${Math.min(start + slice.length, total)} 条 · DOM ${slice.length} 行</span>
      <div class="pager-pages">
        <button type="button" class="pager-btn" data-action="trash-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="上一页">‹</button>
        ${pageList(page, last).map((n) => (n === '…'
          ? `<span class="pager-gap">…</span>`
          : `<button type="button" class="pager-btn" data-action="trash-page" data-page="${n}" data-on="${n === page}">${n}</button>`)).join('')}
        <button type="button" class="pager-btn" data-action="trash-page" data-page="${page + 1}" ${page >= last ? 'disabled' : ''} aria-label="下一页">›</button>
      </div>
      <span class="pager-size">每页
        <select data-input="page-size">${[25, 50, 100].map((n) => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
        条
      </span>
    </footer>
  </div>`;
}

/* ------------------------------------------------------------------ 方案 B · 看板 */
function renderBoardB() {
  const tasks = filteredBoard();
  const selected = tasks.find((task) => task.id === state.selected) ?? tasks.find((task) => task.status === 'running') ?? tasks[0];
  const groups = STATUS.map((col) => ({ ...col, list: tasks.filter((task) => task.status === col.id) }));
  const depCount = tasks.filter((task) => task.deps.length > 0).length;
  const blockedCount = tasks.filter((task) => task.status === 'blocked').length;
  return `<div class="b-layout">
    <aside class="b-rail" aria-label="任务列表">
      <div class="b-rail-head">
        <label class="search">${ICON.search}<input type="search" data-input="board-query" placeholder="搜索任务…" value="${esc(state.boardQuery)}" /></label>
        <div class="b-rail-filter">
          <button type="button" class="chip" data-action="board-filter" data-filter="all" data-on="${state.boardFilter === 'all'}">全部 ${tasks.length}</button>
          <button type="button" class="chip" data-action="board-filter" data-filter="deps" data-on="${state.boardFilter === 'deps'}">有依赖 ${depCount}</button>
          <button type="button" class="chip" data-action="board-filter" data-filter="blocked" data-on="${state.boardFilter === 'blocked'}">受阻 ${blockedCount}</button>
        </div>
      </div>
      <div class="b-rail-scroll">
        ${groups.map((group) => `<section class="b-group" data-status="${group.id}" data-open="true">
          <header class="b-group-head">
            ${statusDot(group.id)}
            <h2>${group.label}</h2>
            <span class="b-group-count">${group.list.length}</span>
            <span class="b-group-line" aria-hidden="true"></span>
          </header>
          ${group.list.length === 0 ? `<div class="b-group-empty">无任务</div>` : group.list.map((task) => {
            const info = depInfo(task);
            return `<button type="button" class="b-row" data-action="select-task" data-id="${task.id}" data-active="${selected && selected.id === task.id}" data-status="${task.status}">
              <span class="b-row-title">${esc(task.title)}</span>
              <span class="b-row-meta">
                <span class="ws">${task.ws}</span>
                ${info.deps.length > 0 ? `<span class="b-dep" data-ready="${info.ready}">${ICON.chain}${info.ready ? '就绪' : `等 ${info.waiting.length}`}</span>` : ''}
                ${task.block ? `<span class="b-dep" data-ready="false">受阻</span>` : ''}
                <time>${fmtMD(task.at)}</time>
              </span>
            </button>`;
          }).join('')}
        </section>`).join('')}
        ${tasks.length === 0 ? `<div class="a-empty big">没有匹配的任务</div>` : ''}
      </div>
      <footer class="b-rail-foot">${tasks.length} 个任务 · ${depCount} 个有依赖 · ${blockedCount} 个受阻</footer>
    </aside>
    <section class="b-detail" aria-label="任务详情">${selected ? renderDetailB(selected) : `<div class="a-empty big">选择一个任务</div>`}</section>
  </div>`;
}

function renderDetailB(task) {
  const info = depInfo(task);
  const downstream = BOARD.filter((row) => row.deps.includes(task.id));
  return `<header class="b-detail-head">
    <div class="b-crumb">看板 / ${STATUS_LABEL[task.status]} / ${task.id}</div>
    <div class="b-title-row">
      <h1>${esc(task.title)}</h1>
      <div class="b-detail-acts">
        <button type="button" class="btn" data-action="noop">打开会话</button>
        <button type="button" class="btn btn-ghost" data-action="noop">${task.status === 'done' ? '归档' : '取消'}</button>
      </div>
    </div>
    <div class="b-pills">
      ${pill(STATUS_LABEL[task.status], 'status', `data-status="${task.status}"`)}
      ${pill(`第 ${task.round} 轮`, 'muted')}
      ${pill(PRIO_LABEL[task.prio], 'prio', `data-prio="${task.prio}"`)}
      <span class="b-ws">${task.ws}</span>
      ${task.stale ? pill('疑似停滞', 'warn') : ''}
      ${task.block ? pill(`受阻 · ${task.block}`, 'danger') : ''}
    </div>
  </header>
  <div class="b-body">
    <section class="b-deps">
      <div class="b-sec-head"><h2>依赖关系</h2><span>${info.deps.length} 个前置 · ${downstream.length} 个下游</span></div>
      <div class="b-graph">
        <div class="b-graph-col">
          <h3>前置任务</h3>
          ${info.deps.length === 0 ? `<div class="b-node empty">无前置 · 可独立派发</div>` : info.deps.map((dep) => `<button type="button" class="b-node" data-action="select-task" data-id="${dep.id}" data-status="${dep.status}">
            <span class="b-node-top">${statusDot(dep.status)}<span>${STATUS_LABEL[dep.status]}</span></span>
            <span class="b-node-title">${esc(dep.title)}</span>
          </button>`).join('')}
        </div>
        <div class="b-graph-link" data-ready="${info.ready}">
          <span class="b-link-line"></span>
          <span class="b-link-cap">${info.deps.length === 0 ? '独立' : info.ready ? '已就绪' : `等 ${info.waiting.length} 个`}</span>
        </div>
        <div class="b-graph-col current">
          <h3>当前任务</h3>
          <div class="b-node current" data-status="${task.status}">
            <span class="b-node-top">${statusDot(task.status)}<span>${STATUS_LABEL[task.status]}</span></span>
            <span class="b-node-title">${esc(task.title)}</span>
            <span class="b-node-sub">${task.ws} · 第 ${task.round} 轮 · ${fmtMD(task.at)}</span>
          </div>
        </div>
        <div class="b-graph-link"><span class="b-link-line"></span><span class="b-link-cap">${downstream.length === 0 ? '无下游' : `${downstream.length} 个`}</span></div>
        <div class="b-graph-col">
          <h3>下游任务</h3>
          ${downstream.length === 0 ? `<div class="b-node empty">暂无任务依赖它</div>` : downstream.map((row) => `<button type="button" class="b-node" data-action="select-task" data-id="${row.id}" data-status="${row.status}">
            <span class="b-node-top">${statusDot(row.status)}<span>${STATUS_LABEL[row.status]}</span></span>
            <span class="b-node-title">${esc(row.title)}</span>
          </button>`).join('')}
        </div>
      </div>
    </section>

    <div class="b-cols">
      <section class="b-facts">
        <div class="b-sec-head"><h2>任务信息</h2></div>
        <dl>
          <div><dt>工作区</dt><dd>${task.ws}</dd></div>
          <div><dt>轮次</dt><dd>第 ${task.round} 轮</dd></div>
          <div><dt>会话</dt><dd>${typeof task.sessions === 'number' ? `${task.sessions} 个` : '—'}</dd></div>
          <div><dt>最近活动</dt><dd>${fmtMD(task.at)}</dd></div>
          <div><dt>能力</dt><dd>${typeof task.capability === 'number' ? `${task.capability} 项` : '继承工作区'}</dd></div>
          <div><dt>验收</dt><dd>${task.status === 'review' ? '待人工验收' : '—'}</dd></div>
        </dl>
      </section>
      <section class="b-timeline">
        <div class="b-sec-head"><h2>最近事件</h2><span>来自会话事件</span></div>
        <ol>
          <li><time>${fmtMD(task.at)}</time><span>${task.stale ? '工作会话超过 20 分钟无活动，标记为疑似停滞' : '工作会话更新了任务进展'}</span></li>
          <li><time>${fmtMD(task.at - 42 * 60_000)}</time><span>指挥官同步了看板状态为「${STATUS_LABEL[task.status]}」</span></li>
          <li><time>${fmtMD(task.at - 96 * 60_000)}</time><span>${task.deps.length > 0 ? `建立依赖：${info.deps.map((d) => d.title).join('、')}` : '任务创建，无前置依赖'}</span></li>
        </ol>
      </section>
    </div>
    <section class="b-sessions">
      <div class="b-sec-head"><h2>工作会话</h2><span>${typeof task.sessions === 'number' ? `${task.sessions} 个会话` : '暂无会话'}</span></div>
      <div class="b-session-row">
        <span class="b-session-status" data-status="${task.status}"></span>
        <div class="b-session-main"><b>agent-workspace · ${task.title.slice(0, 18)}…</b><em>主会话 · session-${task.id.slice(1)}8f</em></div>
        <span class="b-session-meta">${task.status === 'running' ? '进行中' : '已结束'}</span>
        <time>${fmtMD(task.at)}</time>
      </div>
      ${(task.sessions ?? 0) > 1 ? `<div class="b-session-row">
        <span class="b-session-status" data-status="done"></span>
        <div class="b-session-main"><b>agent-workspace · 补充调研</b><em>关联会话 · session-${task.id.slice(1)}a2</em></div>
        <span class="b-session-meta">已结束</span>
        <time>${fmtMD(task.at - 180 * 60_000)}</time>
      </div>` : ''}
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ 方案 B · 回收站 */
function renderTrashB() {
  const rows = filteredTrash();
  const total = rows.length;
  const loaded = Math.min(state.loaded, total);
  const slice = rows.slice(0, loaded);
  const selected = slice.find((row) => row.id === state.selected) ?? slice[0];
  const months = [];
  slice.forEach((row) => {
    const m = monthKey(row.archivedAt);
    if (!months.includes(m)) months.push(m);
  });
  return `<div class="b-layout b-trash-layout">
    <aside class="b-rail" aria-label="归档列表">
      <div class="b-rail-head">
        <label class="search">${ICON.search}<input type="search" data-input="trash-query" placeholder="搜索归档任务…" value="${esc(state.trashQuery)}" /></label>
        <div class="b-rail-filter">
          ${[['all', '全部'], ['archived', '已归档'], ['cancelled', '已取消']].map(([id, label]) => `<button type="button" class="chip" data-action="trash-status" data-status="${id}" data-on="${state.trashStatus === id}">${label}</button>`).join('')}
        </div>
      </div>
      <div class="b-rail-scroll">
        ${months.map((m) => `<section class="b-group" data-status="trash">
          <header class="b-group-head">
            <span class="b-month-dot" aria-hidden="true"></span>
            <h2>${monthLabel(m)}</h2>
            <span class="b-group-count">${rows.filter((r) => monthKey(r.archivedAt) === m).length}</span>
            <span class="b-group-line"></span>
          </header>
          ${slice.filter((r) => monthKey(r.archivedAt) === m).map((row) => `<button type="button" class="b-row" data-action="select-task" data-id="${row.id}" data-active="${selected && selected.id === row.id}" data-status="${row.status}">
            <span class="b-row-title">${esc(row.title)}</span>
            <span class="b-row-meta">
              <span class="ws">${row.ws}</span>
              <span class="b-dep" data-ready="${row.status === 'archived' ? 'true' : 'false'}">${row.status === 'archived' ? '已归档' : '已取消'}</span>
              <time>${fmtMD(row.archivedAt)}</time>
            </span>
          </button>`).join('')}
        </section>`).join('')}
        ${total === 0 ? `<div class="a-empty big">没有匹配的归档任务</div>` : ''}
      </div>
      <footer class="b-rail-foot b-load-more">
        <span>已加载 ${num(loaded)} / ${num(total)} 条</span>
        <button type="button" class="btn btn-sm" data-action="trash-more" ${loaded >= total ? 'disabled' : ''}>${loaded >= total ? '已到末尾' : '加载更多 50 条'}</button>
      </footer>
    </aside>
    <section class="b-detail" aria-label="归档任务详情">${selected ? renderTrashDetailB(selected) : `<div class="a-empty big">选择左侧任务查看详情</div>`}</section>
  </div>`;
}

function renderTrashDetailB(row) {
  return `<header class="b-detail-head">
    <div class="b-crumb">回收站 / ${row.status === 'archived' ? '已归档' : '已取消'} / ${row.id}</div>
    <div class="b-title-row">
      <h1>${esc(row.title)}</h1>
      <div class="b-detail-acts">
        <button type="button" class="btn" data-action="restore" data-id="${row.id}">${ICON.restore}恢复任务</button>
        <button type="button" class="btn btn-ghost" data-action="noop">打开原会话</button>
      </div>
    </div>
    <div class="b-pills">
      ${pill(row.status === 'archived' ? '已归档' : '已取消', row.status === 'archived' ? 'muted' : 'danger')}
      ${pill(`第 ${row.round} 轮`, 'muted')}
      ${pill(PRIO_LABEL[row.prio], 'prio', `data-prio="${row.prio}"`)}
      <span class="b-ws">${row.ws}</span>
    </div>
  </header>
  <div class="b-body">
    <section class="b-facts">
      <div class="b-sec-head"><h2>归档信息</h2></div>
      <dl>
        <div><dt>归档时间</dt><dd>${fmtFull(row.archivedAt)}</dd></div>
        <div><dt>原状态</dt><dd>${row.status === 'archived' ? '已验收（人工归档）' : '已取消（人工取消）'}</dd></div>
        <div><dt>工作区</dt><dd>${row.ws}</dd></div>
        <div><dt>轮次</dt><dd>第 ${row.round} 轮</dd></div>
        <div><dt>会话</dt><dd>${row.sessions} 个</dd></div>
        <div><dt>任务 ID</dt><dd class="mono">${row.id}</dd></div>
      </dl>
    </section>
    <section class="b-note">
      <div class="b-sec-head"><h2>归档前摘要</h2><span>来自最后一条会话回复</span></div>
      <p>任务在「${row.ws}」中执行完毕，产出已整理为验收内容；${row.status === 'archived' ? '人工验收通过后归档' : '由人工取消，未走验收'}。归档后任务不再进入看板，只保留在回收站，可随时恢复。</p>
      <div class="b-material-chips">
        <span class="b-material">报告 · report.md</span>
        <span class="b-material">截图 · 2 张</span>
        <span class="b-material">验收 · ${row.status === 'archived' ? '3/3' : '1/3'}</span>
      </div>
    </section>
    <section class="b-note">
      <div class="b-sec-head"><h2>恢复说明</h2></div>
      <p>恢复会把任务放回「待派发」列，状态回到 draft，不会自动重新派发给工作区；需要你或指挥官再次确认派发。</p>
      <p class="muted">恢复操作仅人工可用（Host 校验 actor）。原型中只做演示，不写任何数据。</p>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ 方案 C · 看板 */
function renderMapControls() {
  return `<div class="toolbar c-toolbar">
    <div class="c-legend">
      <span><i class="dot" data-status="done"></i>已验收</span>
      <span><i class="dot" data-status="running"></i>运行中</span>
      <span><i class="dot" data-status="blocked"></i>受阻</span>
      <span class="c-legend-line" data-ready="false"></span><span>等待前置</span>
      <span class="c-legend-line" data-ready="true"></span><span>已就绪</span>
    </div>
    <span class="toolbar-gap"></span>
    <label class="switch"><input type="checkbox" data-input="show-all-edges" ${state.showAllEdges ? 'checked' : ''} /><span>显示已完成前置</span></label>
    <label class="switch" title="点选节点后只保留它的上下游"><input type="checkbox" data-input="focus-chain" ${state.focusChain ? 'checked' : ''} /><span>聚焦依赖链</span></label>
    <div class="c-zoom">
      <button type="button" class="icon-btn" data-action="zoom" data-step="-1" aria-label="缩小">−</button>
      <span>${Math.round(state.cZoom * 100)}%</span>
      <button type="button" class="icon-btn" data-action="zoom" data-step="1" aria-label="放大">+</button>
    </div>
  </div>`;
}

function renderMapStage(tasks) {
  const counts = Object.fromEntries(STATUS.map((col) => [col.id, tasks.filter((task) => task.status === col.id).length]));
  const chainSet = state.focusChain && state.selected ? chainOf(state.selected) : null;
  return `<div class="c-stage-wrap" style="--col-min:${Math.round(196 * state.cZoom)}px">
    ${STATUS.map((col) => `<section class="c-stage" data-status="${col.id}" aria-label="${col.label}">
      <header class="c-stage-head">${statusDot(col.id)}<h2>${col.label}</h2><span>${counts[col.id]}</span></header>
      <div class="c-stage-body">
        ${tasks.filter((task) => task.status === col.id).map((task) => {
          const info = depInfo(task);
          const inChain = chainSet !== null && chainSet.has(task.id);
          const dim = chainSet !== null && !inChain;
          return `<article class="c-node" data-id="${task.id}" data-status="${task.status}" data-dim="${dim}" data-selected="${state.selected === task.id}" data-chain="${inChain && state.selected !== task.id}" tabindex="0" role="button" aria-label="${esc(task.title)}">
            <div class="c-node-top">
              <span class="c-node-title">${esc(task.title)}</span>
              ${info.deps.length > 0 ? `<span class="c-node-dep" data-ready="${info.ready}" title="${esc(info.deps.map((d) => `${d.title}（${STATUS_LABEL[d.status]}）`).join('、'))}">${ICON.chain}${info.deps.length}</span>` : ''}
            </div>
            <div class="c-node-meta">
              <span>${task.ws.replace('-workspace', '')}</span>
              <span>·</span>
              <span>R${task.round}</span>
              ${task.stale ? `<span class="c-node-flag" data-tone="warn">停滞</span>` : ''}
              ${task.block ? `<span class="c-node-flag" data-tone="danger">${esc(task.block)}</span>` : ''}
            </div>
            ${info.waiting.length > 0 ? `<div class="c-node-wait" title="${esc(info.waiting.map((d) => d.title).join('、'))}">等 ${info.waiting.length} 个前置 · ${esc(shortTitle(info.waiting[0].title))}${info.waiting.length > 1 ? '…' : ''}</div>` : ''}
          </article>`;
        }).join('') || `<div class="a-empty">暂无任务</div>`}
      </div>
    </section>`).join('')}
    <svg class="c-edges" aria-hidden="true"></svg>
  </div>`;
}

function renderMapFoot(tasks) {
  const depCount = tasks.filter((task) => task.deps.length > 0).length;
  const waitingCount = tasks.reduce((n, task) => n + depInfo(task).waiting.length, 0);
  return `<div class="c-foot">
    <span>${tasks.length} 个任务 · ${depCount} 个有依赖 · ${waitingCount} 条等待中的前置</span>
    <span class="c-foot-hint">点击节点高亮上下游；虚线 = 仍在等待前置完成</span>
  </div>`;
}

function renderBoardC() {
  const tasks = filteredBoard();
  return `<div class="c-board">${renderMapControls()}<div class="c-canvas">${renderMapStage(tasks)}</div>${renderMapFoot(tasks)}</div>`;
}

function shortTitle(title) {
  return title.length > 10 ? `${title.slice(0, 10)}…` : title;
}

/* ------------------------------------------------------------------ 方案 C · 回收站 */
function renderTrashC() {
  const rows = filteredTrash();
  const total = rows.length;
  const loaded = Math.min(state.loaded, total);
  const slice = rows.slice(0, loaded);
  const activeFilter = trashFilterActive();
  const monthBase = trashMonthBase();
  const months = [...new Set(monthBase.map((row) => monthKey(row.archivedAt)))];
  const monthCount = (m) => monthBase.filter((row) => monthKey(row.archivedAt) === m).length;
  const archived = rows.filter((r) => r.status === 'archived').length;
  const cancelled = total - archived;
  const recent = rows.filter((r) => NOW - r.archivedAt < 30 * 86_400_000).length;

  const groups = [];
  slice.forEach((row) => {
    const m = monthKey(row.archivedAt);
    const day = new Date(row.archivedAt).toDateString();
    let month = groups.find((g) => g.key === m);
    if (!month) { month = { key: m, days: [], count: monthCount(m) }; groups.push(month); }
    let d = month.days.find((x) => x.key === day);
    if (!d) { d = { key: day, at: row.archivedAt, rows: [] }; month.days.push(d); }
    d.rows.push(row);
  });

  return `<div class="c-trash">
    <div class="toolbar c-trash-toolbar">
      <label class="search">${ICON.search}<input type="search" data-input="trash-query" placeholder="搜索归档任务、任务 ID…" value="${esc(state.trashQuery)}" /></label>
      <div class="chips" role="group" aria-label="回收站筛选">
        ${[['all', '全部'], ['archived', '已归档'], ['cancelled', '已取消']].map(([id, label]) => `<button type="button" class="chip" data-action="trash-status" data-status="${id}" data-on="${state.trashStatus === id}">${label}</button>`).join('')}
      </div>
      <label class="select">工作区
        <select data-input="trash-ws">
          <option value="all">全部</option>
          ${TRASH_WS.map((ws) => `<option value="${ws}" ${state.trashWs === ws ? 'selected' : ''}>${ws}</option>`).join('')}
        </select>
      </label>
      <label class="select">月份
        <select data-input="trash-month">
          <option value="all">全部</option>
          ${months.map((m) => `<option value="${m}" ${state.trashMonth === m ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
        </select>
      </label>
      ${activeFilter ? `<button type="button" class="link-btn c-clear" data-action="trash-clear">清除筛选</button>` : ''}
      <span class="toolbar-gap"></span>
      <span class="toolbar-hint">${activeFilter ? `筛选后 ${num(total)} 条` : `共 ${num(total)} 条`} · 每批 60 条进 DOM</span>
    </div>
    <div class="c-stats">
      <div class="c-stat" data-active="${activeFilter}"><span>${activeFilter ? '筛选结果' : '全部归档'}</span><b>${num(total)}</b><em>${activeFilter ? `全量 ${num(TRASH.length)} 条` : `仅加载 ${num(loaded)} 条到 DOM`}</em></div>
      <div class="c-stat"><span>已归档</span><b>${num(archived)}</b><em>已验收后人工归档</em></div>
      <div class="c-stat"><span>已取消</span><b>${num(cancelled)}</b><em>非终态人工取消</em></div>
      <div class="c-stat"><span>近 30 天</span><b>${num(recent)}</b><em>可按月清理</em></div>
    </div>
    <div class="c-trash-body">
      <nav class="c-months" aria-label="月份">
        <h2>归档月份</h2>
        <button type="button" class="c-month" data-action="jump-month" data-month="all" data-on="${state.trashMonth === 'all'}">
          <span>全部月份</span><b>${num(monthBase.length)}</b>
        </button>
        ${months.map((m) => `<button type="button" class="c-month" data-action="jump-month" data-month="${m}" data-on="${state.trashMonth === m}">
          <span>${monthLabel(m)}</span><b>${num(monthCount(m))}</b>
        </button>`).join('') || '<div class="a-empty">无匹配月份</div>'}
        <div class="c-months-note">按月分段渲染；每批 60 条，历史数据不会一次性进 DOM。</div>
      </nav>
      <div class="c-stream">
        ${groups.length === 0 ? `<div class="a-empty big">没有匹配的归档任务</div>` : groups.map((month) => `
          <section class="c-month-group" data-month="${month.key}">
            <header class="c-month-head"><h2>${monthLabel(month.key)}</h2><span>${month.count} 条</span></header>
            ${month.days.map((day) => `<section class="c-day">
              <header class="c-day-head"><h3>${fmtDay(day.at)}</h3><span>${day.rows.length} 条</span></header>
              <div class="c-day-grid">
                ${day.rows.map((row) => `<article class="c-tcard" data-status="${row.status}">
                  <div class="c-tcard-top">
                    <span class="c-tcard-type">${row.status === 'archived' ? '已归档' : '已取消'}</span>
                    <time>${fmtMD(row.archivedAt)}</time>
                  </div>
                  <h4>${esc(row.title)}</h4>
                  <div class="c-tcard-foot">
                    <span>${row.ws}</span><span>第 ${row.round} 轮</span>
                    <button type="button" class="btn btn-sm" data-action="restore" data-id="${row.id}">${ICON.restore}恢复</button>
                  </div>
                </article>`).join('')}
              </div>
            </section>`).join('')}
          </section>`).join('')}
        <div class="c-load">
          <span>已渲染 ${num(loaded)} / ${num(total)} 条</span>
          <div class="c-load-bar"><i style="width:${total === 0 ? 0 : Math.round((loaded / total) * 100)}%"></i></div>
          <button type="button" class="btn" data-action="trash-more" ${loaded >= total ? 'disabled' : ''}>${loaded >= total ? '已到末尾' : '加载更早的 60 条'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 六列内悬停依赖 */
let hoveredTaskId = null;
let pinnedTaskId = null;

const activeChainId = () => hoveredTaskId ?? pinnedTaskId;

function applyChainHighlight() {
  const id = activeChainId();
  const chain = id === null ? null : chainOf(id);
  document.querySelectorAll('.a-board .a-card').forEach((card) => {
    const inChain = chain !== null && chain.has(card.dataset.id);
    card.classList.toggle('is-dim', chain !== null && !inChain);
    card.classList.toggle('is-chain', inChain && card.dataset.id !== id);
    card.classList.toggle('is-hover', card.dataset.id === id);
  });
  const hint = document.querySelector('[data-board-hint]');
  if (hint) {
    const hintId = activeChainId();
    const task = hintId === null ? undefined : TASK_BY_ID.get(hintId);
    const name = shortTitle(task ? task.title : (hintId ?? ''));
    hint.textContent = hintId === null
      ? '悬停任务卡查看依赖链 · 点卡片固定'
      : hoveredTaskId !== null
        ? `查看「${name}」的依赖链 · 点卡片固定`
        : `已固定「${name}」 · 点空白取消`;
  }
  drawKanbanEdges(id);
}

function drawKanbanEdges(id) {
  const svg = document.querySelector('.a-edges');
  const body = document.querySelector('.a-board-body');
  if (!svg || !body) return;
  if (id === null) { svg.innerHTML = ''; return; }
  const chain = chainOf(id);
  const base = body.getBoundingClientRect();
  const rectOf = (taskId) => {
    const el = document.querySelector(`.a-card[data-id="${taskId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left - base.left, right: r.right - base.left, midY: r.top - base.top + r.height / 2 };
  };
  const paths = [];
  BOARD.forEach((task) => {
    if (!chain.has(task.id)) return;
    task.deps.forEach((depId) => {
      if (!chain.has(depId)) return;
      const dep = TASK_BY_ID.get(depId);
      const from = rectOf(depId);
      const to = rectOf(task.id);
      if (!from || !to) return;
      const forward = from.left <= to.left;
      const sx = forward ? from.right : from.left;
      const tx = forward ? to.left : to.right;
      const sy = from.midY;
      const ty = to.midY;
      const dx = Math.max(32, Math.abs(tx - sx) * 0.42) * (tx >= sx ? 1 : -1);
      const waiting = dep !== undefined && dep.status !== 'done';
      const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
      if (waiting) {
        paths.push(`<path class="a-edge-casing" d="${d}" />`);
        paths.push(`<path class="a-edge-line" data-state="waiting" d="${d}" marker-end="url(#a-arrow-waiting)" />`);
        return;
      }
      // 已验收的前置用细虚线连起来，交代完整链条，但不抢正在等待的边。
      paths.push(`<path class="a-edge-line" data-state="ready" d="${d}" />`);
    });
  });
  const w = body.clientWidth;
  const h = body.clientHeight;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = `<defs>
    <marker id="a-arrow-waiting" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" fill="var(--amber)"/></marker>
  </defs>${paths.join('')}`;
}

function wireBoardHover() {
  const board = document.querySelector('.a-board-body');
  const cols = board === null ? null : board.querySelector('.a-columns');
  if (board === null || cols === null) return;
  const redraw = () => { if (activeChainId() !== null) drawKanbanEdges(activeChainId()); };
  cols.addEventListener('pointerover', (event) => {
    const card = event.target.closest?.('.a-card');
    if (card === undefined || card === null || hoveredTaskId === card.dataset.id) return;
    hoveredTaskId = card.dataset.id;
    applyChainHighlight();
  });
  cols.addEventListener('pointerout', (event) => {
    if (event.target.closest?.('.a-card') === undefined || event.target.closest?.('.a-card') === null) return;
    if (event.relatedTarget?.closest?.('.a-card') !== undefined && event.relatedTarget?.closest?.('.a-card') !== null) return;
    if (hoveredTaskId === null) return;
    hoveredTaskId = null;
    applyChainHighlight();
  });
  cols.addEventListener('pointerleave', () => {
    if (hoveredTaskId === null) return;
    hoveredTaskId = null;
    applyChainHighlight();
  });
  cols.addEventListener('focusin', (event) => {
    const card = event.target.closest?.('.a-card');
    if (card === undefined || card === null) return;
    hoveredTaskId = card.dataset.id;
    applyChainHighlight();
  });
  cols.addEventListener('focusout', (event) => {
    if (event.target.closest?.('.a-card') === undefined || event.target.closest?.('.a-card') === null) return;
    hoveredTaskId = null;
    applyChainHighlight();
  });
  cols.addEventListener('scroll', redraw, { passive: true });
  board.querySelectorAll('.a-col-body').forEach((el) => el.addEventListener('scroll', redraw, { passive: true }));
}

/* ------------------------------------------------------------------ 画连线 */
function drawEdges() {
  const wrap = document.querySelector('.c-stage-wrap');
  const svg = document.querySelector('.c-edges');
  if (!wrap || !svg) return;
  const wrapRect = wrap.getBoundingClientRect();
  const nodes = new Map();
  wrap.querySelectorAll('.c-node').forEach((node) => {
    const rect = node.getBoundingClientRect();
    nodes.set(node.dataset.id, {
      left: rect.left - wrapRect.left,
      right: rect.right - wrapRect.left,
      top: rect.top - wrapRect.top,
      bottom: rect.bottom - wrapRect.top,
      centerY: rect.top - wrapRect.top + rect.height / 2,
      status: node.dataset.status,
    });
  });
  const chainSet = state.focusChain && state.selected ? chainOf(state.selected) : null;
  const paths = [];
  BOARD.forEach((task) => {
    const target = nodes.get(task.id);
    if (!target) return;
    task.deps.forEach((depId) => {
      const source = nodes.get(depId);
      if (!source) return;
      const related = chainSet !== null && chainSet.has(task.id) && chainSet.has(depId);
      const inChain = chainSet === null || (chainSet.has(task.id) && chainSet.has(depId));
      // 默认只画「还在等前置」的连线；已完成的前置收起来，避免整张图变成面条。
      if (source.status === 'done' && !state.showAllEdges && !related) return;
      const stateName = source.status === 'done' ? 'ready' : 'waiting';
      const backward = source.right < target.left;
      const sx = backward ? source.right : source.left;
      const tx = backward ? target.left : target.right;
      const sy = source.centerY;
      const ty = target.centerY;
      const dx = Math.max(36, Math.abs(tx - sx) * 0.45) * (tx >= sx ? 1 : -1);
      const path = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
      paths.push(`<path class="c-edge" data-state="${stateName}" data-related="${related}" data-dim="${!inChain}" d="${path}"${related ? ` marker-end="url(#c-arrow-${stateName})"` : ''} />`);
    });
  });
  svg.setAttribute('width', String(wrap.scrollWidth));
  svg.setAttribute('height', String(wrap.scrollHeight));
  svg.setAttribute('viewBox', `0 0 ${wrap.scrollWidth} ${wrap.scrollHeight}`);
  svg.innerHTML = `<defs>
    <marker id="c-arrow-ready" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8z" fill="var(--green)"/></marker>
    <marker id="c-arrow-waiting" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 8 4 0 8z" fill="var(--amber)"/></marker>
  </defs>${paths.join('')}`;
}

/* ------------------------------------------------------------------ 渲染 */
function render() {
  const app = document.getElementById('app');
  app.dataset.variant = state.variant;
  app.dataset.tab = state.tab;
  document.documentElement.dataset.theme = state.theme;
  document.getElementById('topbar').innerHTML = renderTopbar();
  document.getElementById('dock').innerHTML = renderDock();
  const screen = document.getElementById('screen');
  const scrollTop = screen.querySelector('.c-canvas')?.scrollTop ?? 0;
  if (state.tab === 'board') {
    screen.innerHTML = state.variant === 'A' ? renderBoardA()
      : state.variant === 'B' ? renderBoardB()
        : state.variant === 'C' ? renderBoardC() : renderBoardCombo();
  } else {
    screen.innerHTML = state.variant === 'A' ? renderTrashA()
      : state.variant === 'B' ? renderTrashB() : renderTrashC();
  }
  if (state.tab === 'board') {
    const canvas = screen.querySelector('.c-canvas');
    if (canvas) {
      if (scrollTop > 0) canvas.scrollTop = scrollTop;
      requestAnimationFrame(() => drawEdges());
    }
  }
  if (state.variant === 'combo' && state.tab === 'board') {
    hoveredTaskId = null;
    if (pinnedTaskId !== null && document.querySelector(`.a-card[data-id="${pinnedTaskId}"]`) === null) pinnedTaskId = null;
    wireBoardHover();
    requestAnimationFrame(() => { if (activeChainId() !== null) applyChainHighlight(); });
  }
  syncUrl();
}

function syncUrl() {
  const next = new URLSearchParams(location.search);
  next.set('variant', state.variant);
  next.set('tab', state.tab);
  next.set('theme', state.theme);
  const qs = next.toString();
  try {
    history.replaceState(null, '', `${location.pathname}${qs === '' ? '' : `?${qs}`}`);
  } catch {
    /* file:// 下部分浏览器禁止改 history，忽略即可 */
  }
}

/* ------------------------------------------------------------------ 交互 */
let toastTimer;
function toast(text) {
  const node = document.getElementById('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2_200);
}

function cycleVariant(dir) {
  const keys = Object.keys(VERSIONS);
  const idx = keys.indexOf(state.variant);
  state.variant = keys[(idx + dir + keys.length) % keys.length];
  state.selected = state.variant === 'B' ? 't203' : state.selected;
  pinnedTaskId = null;
  hoveredTaskId = null;
  render();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  render();
}

function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = tab === 'board' ? 't203' : null;
  pinnedTaskId = null;
  hoveredTaskId = null;
  render();
}

function restoreOne(id) {
  const row = TRASH.find((r) => r.id === id) ?? BOARD.find((t2) => t2.id === id);
  toast(`已恢复「${row ? shortTitle(row.title) : id}」到待派发（原型演示，不写数据）`);
  state.trashSel.delete(id);
  render();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) {
    const card = event.target.closest('.a-card, .c-node');
    if (card && state.variant === 'combo' && card.classList.contains('a-card')) {
      pinnedTaskId = pinnedTaskId === card.dataset.id ? null : card.dataset.id;
      applyChainHighlight();
      return;
    }
    if (card) {
      if (state.focusChain && state.selected === card.dataset.id) {
        state.focusChain = false;
      } else {
        state.selected = card.dataset.id;
        state.focusChain = true;
      }
      render();
      return;
    }
    if (state.variant === 'combo' && event.target.closest('.a-columns') !== null) {
      pinnedTaskId = null;
      hoveredTaskId = null;
      applyChainHighlight();
    }
    return;
  }
  const action = target.dataset.action;
  if (action === 'noop') return;
  if (action === 'tab') { setTab(target.dataset.tab); return; }
  if (action === 'cycle') { cycleVariant(Number(target.dataset.dir)); return; }
  if (action === 'theme') { toggleTheme(); return; }
  if (action === 'reset') {
    Object.assign(state, {
      boardQuery: '', boardFilter: 'all', focusChain: false, selected: 't203',
      trashQuery: '', trashStatus: 'all', trashWs: 'all', trashMonth: 'all',
      page: 1, pageSize: 50, loaded: 100, cZoom: 1,
    });
    state.trashSel.clear();
    state.expanded = new Set(['t222']);
    if (state.scale !== 1) { state.scale = 1; TRASH = makeTrash(1_284); }
    render();
    return;
  }
  if (action === 'scale') {
    state.scale = state.scale === 1 ? 10 : 1;
    TRASH = makeTrash(1_284 * state.scale);
    state.page = 1;
    state.loaded = state.scale === 10 ? 100 : 100;
    state.trashSel.clear();
    render();
    toast(`回收站数据量 ×${state.scale}：共 ${num(TRASH.length)} 条，仍只渲染当前页`);
    return;
  }
  if (action === 'board-filter') {
    state.boardFilter = target.dataset.filter;
    render();
    return;
  }
  if (action === 'trash-clear') {
    state.trashQuery = '';
    state.trashStatus = 'all';
    state.trashWs = 'all';
    state.trashMonth = 'all';
    state.page = 1;
    state.loaded = 100;
    render();
    return;
  }
  if (action === 'toggle-gate') {
    const id = target.dataset.id;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    render();
    return;
  }
  if (action === 'select-task') {
    state.selected = target.dataset.id;
    render();
    return;
  }
  if (action === 'trash-status') {
    state.trashStatus = target.dataset.status;
    state.page = 1;
    state.loaded = 100;
    state.trashSel.clear();
    render();
    return;
  }
  if (action === 'trash-page') {
    state.page = Math.max(1, Number(target.dataset.page));
    render();
    document.querySelector('.a-tbody')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (action === 'trash-more') {
    state.loaded = Math.min(state.loaded + (state.variant === 'C' ? 60 : 50), trashTotal());
    render();
    return;
  }
  if (action === 'jump-month') {
    state.trashMonth = target.dataset.month;
    render();
    if (state.trashMonth !== 'all') {
      const group = document.querySelector(`.c-month-group[data-month="${target.dataset.month}"]`);
      group?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    return;
  }
  if (action === 'zoom') {
    state.cZoom = Math.min(1.3, Math.max(0.8, Number((state.cZoom + Number(target.dataset.step) * 0.1).toFixed(2))));
    render();
    return;
  }
  if (action === 'trash-select') {
    event.stopPropagation();
    if (state.trashSel.has(target.dataset.id)) state.trashSel.delete(target.dataset.id);
    else state.trashSel.add(target.dataset.id);
    render();
    return;
  }
  if (action === 'select-page') {
    const rows = filteredTrash().slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    const all = rows.every((r) => state.trashSel.has(r.id));
    rows.forEach((r) => { if (all) state.trashSel.delete(r.id); else state.trashSel.add(r.id); });
    render();
    return;
  }
  if (action === 'clear-selection') {
    state.trashSel.clear();
    render();
    return;
  }
  if (action === 'bulk-restore') {
    const n = state.trashSel.size;
    state.trashSel.clear();
    render();
    toast(`已恢复 ${n} 个任务（原型演示，不写数据）`);
    return;
  }
  if (action === 'restore') { restoreOne(target.dataset.id); }
});

document.addEventListener('input', (event) => {
  const input = event.target.closest('[data-input]');
  if (!input) return;
  const key = input.dataset.input;
  if (key === 'board-query') { state.boardQuery = input.value; }
  if (key === 'trash-query') { state.trashQuery = input.value; state.page = 1; state.loaded = 100; state.trashSel.clear(); }
  if (key === 'focus-chain') { state.focusChain = input.checked; }
  if (key === 'show-all-edges') { state.showAllEdges = input.checked; }
  if (key === 'trash-ws') { state.trashWs = input.value; state.page = 1; state.loaded = 100; }
  if (key === 'trash-month') { state.trashMonth = input.value; state.page = 1; state.loaded = 100; }
  if (key === 'page-size') { state.pageSize = Number(input.value); state.page = 1; }
  render();
  if (key === 'board-query' || key === 'trash-query') {
    const next = document.querySelector(`[data-input="${key}"]`);
    if (next) {
      next.focus();
      const len = next.value.length;
      next.setSelectionRange(len, len);
    }
  }
});

document.addEventListener('change', (event) => {
  const input = event.target.closest('select[data-input]');
  if (!input) return;
  const key = input.dataset.input;
  if (key === 'trash-ws') { state.trashWs = input.value; state.page = 1; state.loaded = 100; }
  if (key === 'trash-month') { state.trashMonth = input.value; state.page = 1; state.loaded = 100; }
  if (key === 'page-size') { state.pageSize = Number(input.value); state.page = 1; }
  render();
});

document.addEventListener('keydown', (event) => {
  const tag = (event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable) return;
  if (event.key === 'ArrowLeft') { cycleVariant(-1); }
  if (event.key === 'ArrowRight') { cycleVariant(1); }
  if (['1', '2', '3', '4'].includes(event.key)) {
    state.variant = Object.keys(VERSIONS)[Number(event.key) - 1];
    render();
  }
  if (event.key.toLowerCase() === 't') toggleTheme();
});

window.addEventListener('resize', () => {
  if (state.tab === 'board' && document.querySelector('.c-canvas')) drawEdges();
  if (state.variant === 'combo' && state.tab === 'board' && activeChainId() !== null) drawKanbanEdges(activeChainId());
});

/* 卡片点击：聚焦模式下选中该卡；否则在 B/C 选中，A 仅选中。 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const card = event.target.closest?.('.a-card, .c-node');
  if (!card) return;
  if (state.variant === 'combo' && card.classList.contains('a-card')) {
    pinnedTaskId = pinnedTaskId === card.dataset.id ? null : card.dataset.id;
    applyChainHighlight();
    return;
  }
  state.selected = card.dataset.id;
  render();
});

render();
