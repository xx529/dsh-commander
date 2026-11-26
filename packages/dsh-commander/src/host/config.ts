// 运行期常量与默认值（M0）。数值来源：ARCHITECTURE §3.3 / implementation-plan §4.3 / m0-contract-patch §1.6/§2。
export const DOMAIN_NAME = 'commander'
export const DOMAIN_VERSION = 1

/** per-record 表名（表名必须匹配 /^[a-z][a-z0-9_]*$/；board_edits 为 Lead 裁定的平台适配名）。 */
export const TABLE_NAMES = [
  'config',
  'workspaces',
  'commands',
  'tasks',
  'dispatches',
  'board_edits',
  'sessions',
] as const
export type TableName = (typeof TABLE_NAMES)[number]

/** config 表的 singleton key。 */
export const CONFIG_KEY = 'singleton'

/** 消息内存环 / 快照 / 截断（m0-contract-patch §1.6）。 */
export const MESSAGE_RING_MAX = 500
export const MESSAGE_SNAPSHOT_MAX = 200
export const MESSAGE_MAX_CHARS = 8192
export const MESSAGE_TRUNCATE_HEAD = 6144
export const MESSAGE_TRUNCATE_TAIL = 2048

/** 请求文本上限（POST /commander/message）。 */
export const PROMPT_TEXT_MAX = 8192

/** requestId 幂等 LRU（5 分钟）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000
export const IDEMPOTENCY_MAX_ENTRIES = 256

/** SSE 心跳（15s）。 */
export const SSE_HEARTBEAT_MS = 15_000

/** timeline 上限与折叠（implementation-plan §4.3-6）。 */
export const TIMELINE_MAX = 100
export const TIMELINE_FOLD_COUNT = 20

/** 快照 tasks 上限（implementation-plan §8.3）。 */
export const SNAPSHOT_TASKS_MAX = 200

/** 乐观并发重试次数（写失败可重试）与应用层 version 重试（§4.3-3）。 */
export const UPDATE_RETRY_ATTEMPTS = 3

/** 默认配置（PUT /commander/config 未提交段的默认值）。 */
export const DEFAULT_JEV = {
  provider: 'typesafe' as const,
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  apiKeyEnv: 'JEV_API_KEY',
  workspaceThreshold: 0.8,
  sessionThreshold: 0.8,
  timeoutMs: 1500,
  onTimeout: 'pause_and_ask' as const,
  /** 超过阈值自动派发（默认关闭；用户 2026-11-19 开放为可配置项）。 */
  autoDispatch: false,
}

export const DEFAULT_UI = {
  theme: 'follow' as const,
  entryPosition: 'br' as const,
  /** 默认开启浮窗（用户可在指挥官设置里关闭）。 */
  entryEnabled: true,
  /** 默认开启 macOS 原生壳（桌面浮窗）；用户可在设置里关闭。 */
  nativeShell: true,
  hotkey: '',
}

export const JEVA_THRESHOLD_MIN = 0.5
export const JEVA_THRESHOLD_MAX = 0.99
export const JEV_TIMEOUT_MIN = 500
export const JEV_TIMEOUT_MAX = 30_000
export const WORKSPACES_MAX = 100
export const WORKSPACE_SUMMARY_MAX = 500
export const REQUEST_ID_MIN = 8
export const REQUEST_ID_MAX = 64
export const WORKSPACES_ALLOWED_POLICIES = ['inherit', 'auto'] as const
export const UI_THEMES = ['follow', 'light', 'dark'] as const
export const UI_ENTRY_POSITIONS = ['br', 'bl'] as const

// ---------------------------------------------------------------- M1 运行期常量（不写 ConfigRecord 冻结 schema；m1-contract-patch §1.1）
/** 全确认模式：M1 恒为 false；commander_task_dispatch 首次永远 needs_confirmation。 */
export const AUTO_DISPATCH = false
/** 决策仅内存 TTL 30 分钟（惰性清理，不建定时器）。 */
export const DECISION_TTL_MS = 30 * 60 * 1000
/** 确认卡候选上限（m1-contract-patch §1.3）。 */
export const DISPATCH_CANDIDATES_MAX = 8
/** Jev 单请求 token 预算（字符数/3 近似；两段式后仅作观测口径，不再切换请求模式）。 */
export const JEV_TOKEN_BUDGET = 24_000
/** 会话段候选上限（Choice 最多 255 个选项，预留 new）。 */
export const JEV_SESSION_CANDIDATES_MAX = 250
/** 会话段证据：把该会话的用户提问放进选项描述（每条/每会话/总量限额，避免挤爆 32k）。 */
export const JEV_SESSION_QUESTION_MAX_CHARS = 240
export const JEV_SESSION_QUESTION_CHARS_PER_SESSION = 1200
export const JEV_SESSION_QUESTIONS_TOTAL_CHARS = 45_000
/** 最多为多少个候选（按最近活动倒序）读取提问，其余只带标题。 */
export const JEV_SESSION_QUESTIONS_SESSIONS_MAX = 60
/** Jev 请求默认 model / key 环境变量（key 只从 env 读，不落盘）。 */
export const JEV_DEFAULT_MODEL = 'jev-latest'
export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_DEFAULT_KEY_ENV = 'JEV_API_KEY'
export const JEV_KEY_ENV_FALLBACKS = ['TYPESAFE_API_KEY'] as const
/** Jev 429/529 最多重试次数（退避 1 次）。 */
export const JEV_RETRY_MAX = 1
export const JEV_RETRY_DELAY_MS = 500

/** 解析派发门控阈值：新字段优先，旧配置回退到 `threshold`，再回退默认值。 */
export function resolveJevThresholds(jev: {
  workspaceThreshold?: number
  sessionThreshold?: number
  /** 旧版单一阈值（兼容已存在的配置记录）。 */
  threshold?: number
}): { workspace: number; session: number } {
  const legacy = typeof jev.threshold === 'number' ? jev.threshold : undefined
  return {
    workspace: typeof jev.workspaceThreshold === 'number' ? jev.workspaceThreshold : legacy ?? DEFAULT_JEV.workspaceThreshold,
    session: typeof jev.sessionThreshold === 'number' ? jev.sessionThreshold : legacy ?? DEFAULT_JEV.sessionThreshold,
  }
}
/** M2：看板人工改动注入合并窗口（一次性 timer，非 scheduler）。 */
export const BOARD_EDIT_MERGE_MS = 30_000
/** M2：任务详情 boardEdits 摘要条数。 */
export const BOARD_EDITS_DETAIL_MAX = 20
/** M2：回收站列表上限。 */
export const ARCHIVE_LIST_MAX = 100
/** M2：人工改板标题长度上限。 */
export const BOARD_TITLE_MAX = 200
/** M3：turn/end 注入文本上限（整条，含元数据行与截断标记；不得超投递上限 PROMPT_TEXT_MAX=8192）。 */
export const INJECTION_TEXT_MAX = 8_192
/** M3：截断保留的头部上限；尾部用剩余预算（约 2KB 减去标记与元数据行）。 */
export const INJECTION_HEAD_MAX = 6_144
export const INJECTION_TAIL_MAX = 2_048
/** M3：注入投递失败补一次（之后无论成败写 lastInjected，避免风暴）。 */
export const INJECTION_RETRY_MAX = 1
/** M3：允许注入的 turn/end reason。 */
export const INJECTION_REASONS = ['completed', 'error', 'blocked', 'max-tokens'] as const
/** M3：commander_task_report summary 上限。 */
export const REPORT_SUMMARY_MAX = 800

/** 报告材料（方案 A：报告级链接/文档/图片）上限与字段长度。 */
export const REPORT_MATERIALS_MAX = 24
/** 从工作会话最后回复自动抓取的链接/图片上限（避免长报告把材料区刷爆）。 */
export const REPORT_SESSION_MATERIALS_MAX = 12
export const REPORT_MATERIAL_TITLE_MAX = 200
export const REPORT_MATERIAL_DESCRIPTION_MAX = 500
export const REPORT_MATERIAL_URL_MAX = 2048
export const REPORT_MATERIAL_PATH_MAX = 1024
/** 本地图片读取/展示上限（DSH 图片附件同量级）。 */
export const REPORT_IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 本地文档只做元数据校验；超过该大小仍可记录为 too_large，不阻塞报告。 */
export const REPORT_FILE_MAX_BYTES = 50 * 1024 * 1024
/** commander_task_report 一次返回的丢弃/截断原因上限。 */
export const REPORT_MATERIAL_WARNINGS_MAX = 10
/** M3：rework 批注上限。 */
export const REWORK_COMMENT_MAX = 1_000
/** M3：快照 workSessions 上限。 */
export const WORK_SESSIONS_MAX = 200
/** M1 不启用 turn/end 注入（M3）；只做 turn/start 的 queued→running 机械状态更新。 */
export const INJECTION_ENABLED = false
/** turn-end 注入文本截断（沿用 plan §7.2；M3 使用，M1 仅保留纯函数与测试）。 */
export const INJECTION_MAX_BYTES = 8192
export const INJECTION_HEAD_BYTES = 6144
export const INJECTION_TAIL_BYTES = 2048

// ---------------------------------------------------------------- R1 会话轮换 / 交接简报
/** 轮换周期（天）允许范围与默认值。 */
export const ROTATION_PERIOD_MIN_DAYS = 1
export const ROTATION_PERIOD_MAX_DAYS = 7
export const ROTATION_DEFAULT_PERIOD_DAYS = 1
/** 一天毫秒数（纯时间差判定，与时区/自然日无关）。 */
export const ROTATION_DAY_MS = 86_400_000
/** 交接简报总量上限（Unicode 码点）；未完成段不计入裁剪。 */
export const BRIEF_MAX_CHARS = 4_096
/** 简报分节上限：本周期任务 / 当前未完成 / 用户最近原话。 */
export const BRIEF_TASKS_MAX = 20
export const BRIEF_UNFINISHED_MAX = 10
export const BRIEF_USER_LINES_MAX = 10
/** 用户原话单条与总量上限。 */
export const BRIEF_USER_LINE_CHARS = 120
export const BRIEF_USER_TAIL_CHARS = 800
/** 任务标题、结论、阻塞原因上限。 */
export const BRIEF_TITLE_CHARS = 60
export const BRIEF_CONCLUSION_CHARS = 80
export const BRIEF_BLOCK_REASON_CHARS = 100
/** 轮换失败后的自动重试退避（手动 force 不受限）。 */
export const ROTATION_FAILURE_BACKOFF_MS = 10 * 60 * 1000
/** create 后等待 Agent 注册的重试（次数 / 间隔）。 */
export const ROTATION_AGENT_RETRY_COUNT = 3
export const ROTATION_AGENT_RETRY_DELAY_MS = 50
/** 单次轮换超时（超过按失败处理；不阻塞旧绑定）。 */
export const ROTATION_TIMEOUT_MS = 10_000
/** 退役指挥官在快照里的展示上限。 */
export const FORMER_COMMANDERS_MAX = 10
