/**
 * V4 · `storageDomain` 域 `commander`（per-record）探针（P-A Host 探针插件）
 *
 * 验证协议 §5.4 的 8 步：域声明/open、往返、key 规则、update+version、并发、并发抛错、
 * 重启持久、schema 校验。附带 V4-C1 的**声明层事实核查**：蓝图 §4.1 的 `defineDomain`
 * 是否接受 7 张表（尤其 `boardEdits`）。
 *
 * zod schema 采用「照搬 ARCHITECTURE §3.3 字段」的探针版（非生产 schema 模块）；
 * V4 判的是存储语义，schema 字段保真度由实现/tester 另审。
 *
 * 路由（webServer，loopback）：
 *   GET /probe/v4/meta          服务/后端/根路径/zod 版本
 *   GET /probe/v4/spec          定义层核查：defineDomain(蓝图 spec) 抛什么；表名规则
 *   GET /probe/v4/run           阶段一：open/往返/key/update/并发/并发抛错/应用层 version 重试/schema 前置校验
 *   GET /probe/v4/restart-check 阶段二（**另一次 Host 启动**）：重启后读回记录与 version
 *   GET /probe/v4/schema-open   隔离域：写入非法记录 → close → 再 open → 捕获 invalid-record
 *   GET /probe/v4/tree          物理布局：列举 $DSH_HOME/storages 下文件
 *   GET /probe/v4/quit          写 summary 后 appExit(0)
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'probe-v4'
export const inject = []

const errText = (error) => String(error?.message ?? error)
const safe = (fn) => { try { return { ok: true, value: fn() } } catch (error) { return { ok: false, error: errText(error) } } }
const now = () => Date.now()

/** 从探针所在安装解析 zod（CLI 自带 zod 4.x；探针零依赖）。 */
async function loadZod() {
  const anchor = process.argv[1]
  const require_ = createRequire(anchor)
  const entry = require_.resolve('zod')
  const mod = await import(pathToFileURL(entry).href)
  return { z: mod.z ?? mod.default?.z, version: mod.z ? 'unknown' : 'unknown', entry }
}

/** 蓝图 §4.3-5 的 key 归一化（应用层规则，照搬实现约束）。 */
function sanitizeKey(raw) {
  const replaced = String(raw).replace(/[^a-zA-Z0-9_-]/g, '-')
  if (replaced === raw) return replaced
  const digest = createHash('sha1').update(String(raw), 'utf8').digest('hex').slice(0, 8)
  return `${replaced}--${digest}`
}

export function apply(ctx, config = {}) {
  const outDir = config.outDir ?? '/tmp/dsh-commander-probe/evidence/v4'
  const opsFile = join(outDir, 'domain-ops.jsonl')
  const summaryFile = join(outDir, 'v4-probe-summary.json')
  const startedAt = new Date().toISOString()
  const logs = []
  const pushLog = (entry) => {
    logs.push({ at: new Date().toISOString(), ...entry })
    try {
      appendFileSync(opsFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } catch { /* 证据目录不可写时仍有内存副本 */ }
  }
  try { mkdirSync(outDir, { recursive: true }); appendFileSync(opsFile, '') } catch { /* noop */ }

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body, null, 2) + '\n')
  }
  const query = (req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return { get: (name) => url.searchParams.get(name) ?? undefined }
  }

  // ---- zod + 域声明（在路由内惰性初始化，失败也返回 JSON 而不是让 Host 崩） ----
  let schemasPromise
  const loadSchemas = () => (schemasPromise ??= (async () => {
    const { z, entry } = await loadZod()
    const AcceptanceItem = z.object({
      id: z.string(), text: z.string(), verify: z.string().optional(), evidence: z.string().optional(),
      source: z.literal('commander'),
      derivedFrom: z.object({ sessionId: z.string(), seq: z.number() }).optional(),
      state: z.enum(['evidence_present', 'insufficient']),
    })
    const CapabilityPlan = z.object({
      policy: z.enum(['inherit', 'auto']), executor: z.literal('capability-panel'),
      status: z.enum(['inherited', 'applied', 'fallback', 'failed']),
      enabled: z.array(z.string()), disabled: z.array(z.string()),
      durationMs: z.number().optional(), reason: z.string().optional(), at: z.number(),
    })
    const TaskTimelineItem = z.object({
      at: z.number(),
      type: z.enum(['created', 'dispatch', 'session_stop', 'report', 'status', 'user_edit', 'accept', 'rework']),
      text: z.string(), sessionId: z.string().optional(), seq: z.number().optional(),
    })
    const TaskRecordSchema = z.object({
      v: z.literal(1), id: z.string(), title: z.string(), goal: z.string(),
      status: z.enum(['draft', 'proposed', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled', 'archived']),
      workspaceId: z.string(), priority: z.enum(['low', 'normal', 'high', 'urgent']),
      commandId: z.string(), dispatchId: z.string().optional(),
      assignments: z.array(z.string()), primarySessionId: z.string().optional(),
      acceptance: z.array(AcceptanceItem), capabilities: CapabilityPlan.optional(),
      progress: z.object({ label: z.string(), pct: z.number().optional(), at: z.number() }).optional(),
      block: z.object({ reason: z.string(), code: z.string().optional(), since: z.number() }).optional(),
      timeline: z.array(TaskTimelineItem), version: z.number().int(),
      createdAt: z.number(), updatedAt: z.number(), lastActivityAt: z.number(), archivedAt: z.number().optional(),
    })
    const SessionLinkRecordSchema = z.object({
      v: z.literal(1), sessionId: z.string(), workspaceId: z.string(), taskId: z.string(),
      role: z.enum(['work', 'commander']), mode: z.enum(['new', 'attach']), createdAt: z.number(),
      lastInjected: z.object({ turnId: z.string(), seq: z.number(), at: z.number() }).optional(),
      status: z.enum(['queued', 'running', 'idle', 'missing']),
    })
    const ConfigRecordSchema = z.object({
      v: z.literal(1),
      commander: z.object({
        workspaceId: z.string(), workspacePath: z.string(), sessionId: z.string(),
        model: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }),
        agentPreset: z.string().optional(),
      }),
      jev: z.object({
        provider: z.enum(['typesafe', 'custom']), endpoint: z.string(), model: z.string(),
        keySource: z.enum(['env', 'credential']), envVar: z.string(),
        threshold: z.number(), confidenceFloor: z.number(), timeoutMs: z.number(),
        onTimeout: z.enum(['pause_and_ask', 'use_model']),
      }),
      board: z.object({ archiveAfterDays: z.number(), syncUserEdits: z.boolean() }),
      ui: z.object({ theme: z.enum(['follow', 'light', 'dark']), entryPosition: z.enum(['br', 'bl']), hotkey: z.string() }),
      updatedAt: z.number(),
    })
    const WorkspaceRecordSchema = z.object({
      v: z.literal(1), id: z.string(), name: z.string(), path: z.string(), allowed: z.boolean(),
      summary: z.string(), summarySource: z.enum(['manual', 'model']), summaryUpdatedAt: z.number().optional(),
      capabilityPolicy: z.object({
        mode: z.enum(['inherit', 'auto']),
        lastSelection: z.object({
          status: z.enum(['applied', 'fallback', 'failed']), enabled: z.array(z.string()),
          disabled: z.array(z.string()), durationMs: z.number().optional(), reason: z.string().optional(), at: z.number(),
        }).optional(),
      }),
    })
    const CommandRecordSchema = z.object({
      v: z.literal(1), id: z.string(), text: z.string(), sessionId: z.string(), seq: z.number(),
      createdAt: z.number(), taskIds: z.array(z.string()), truncated: z.boolean().optional(),
    })
    const DispatchRecordSchema = z.object({
      v: z.literal(1), id: z.string(), taskId: z.string(), createdAt: z.number(),
      prefilter: z.object({ workspaceIds: z.array(z.string()), sessionIds: z.array(z.string()), scores: z.record(z.string(), z.number()), truncated: z.boolean() }),
      candidates: z.array(z.unknown()), modelSuggestion: z.string(),
      jev: z.object({
        provider: z.string(), endpoint: z.string(), model: z.string(), requestId: z.string(),
        latencyMs: z.number(), ok: z.boolean(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
        answers: z.unknown().optional(), pMax: z.number().optional(), concentration: z.number().optional(),
        usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
      }),
      outcome: z.enum(['auto', 'confirmed', 'overridden', 'cancelled', 'jev_unavailable', 'rejected']),
      finalTarget: z.object({ workspaceId: z.string(), mode: z.enum(['new', 'attach']), sessionId: z.string().optional() }).optional(),
      confirmedBy: z.literal('user').optional(), reason: z.string().optional(),
    })
    const BoardEditRecordSchema = z.object({
      v: z.literal(1), id: z.string(), taskId: z.string(), field: z.string(),
      before: z.unknown(), after: z.unknown(), actor: z.literal('user'), at: z.number(),
      injectedAt: z.number().optional(), injectionKey: z.string().optional(),
    })
    return { z, zodEntry: entry, schemas: { TaskRecordSchema, SessionLinkRecordSchema, ConfigRecordSchema, WorkspaceRecordSchema, CommandRecordSchema, DispatchRecordSchema, BoardEditRecordSchema } }
  })())

  let facilityRef
  const getFacility = () => {
    if (facilityRef === undefined) facilityRef = ctx.get('storageDomain')
    return facilityRef
  }

  /** 蓝图 §4.1 的原样声明（用于核查 defineDomain 是否接受 7 表名字）。 */
  const blueprintTables = (schemas) => ({
    config: schemas.ConfigRecordSchema,
    workspaces: schemas.WorkspaceRecordSchema,
    commands: schemas.CommandRecordSchema,
    tasks: schemas.TaskRecordSchema,
    dispatches: schemas.DispatchRecordSchema,
    boardEdits: schemas.BoardEditRecordSchema,
    sessions: schemas.SessionLinkRecordSchema,
  })

  const route = (ws, path, handler) => {
    ws.register({
      kind: 'exact', path,
      handler: async (req, res) => {
        try { await handler(req, res) } catch (error) {
          pushLog({ kind: 'route/error', path, error: errText(error) })
          json(res, 500, { ok: false, path, error: errText(error) })
        }
      },
    })
  }

  const registerRoutes = async (hostCtx) => {
    const ws = hostCtx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') {
      pushLog({ kind: 'routes/unavailable' })
      return
    }
    const { z, zodEntry, schemas } = await loadSchemas()
    pushLog({ kind: 'boot', zodEntry, outDir })

    route(ws, '/probe/v4/meta', async (req, res) => {
      const backends = {}
      for (const name of ['json', 'sqlite']) {
        const resolved = safe(() => hostCtx.get('storage')?.backend?.get?.(name))
        backends[name] = { resolved: resolved.ok ? typeof resolved.value : null, kv: resolved.ok ? typeof resolved.value?.kv?.open : null, error: resolved.ok ? null : resolved.error }
      }
      json(res, 200, {
        ok: true, node: process.version, startedAt,
        dshHome: process.env.DSH_HOME ?? null,
        storageService: typeof safe(() => hostCtx.get('storageDomain')).value,
        storageDomainType: typeof getFacility(),
        backends,
        storagesRoot: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages') : null,
        zodEntry,
        schemasLoaded: Object.keys(schemas),
        facilities: safe(() => typeof getFacility()?.open).value,
      })
    })

    route(ws, '/probe/v4/spec', async (req, res) => {
      const tables = blueprintTables(schemas)
      const nameChecks = Object.keys(tables).map((table) => ({ table, matchesUnitNameRe: /^[a-z][a-z0-9_]*$/.test(table) }))
      // 尝试 1：完全照蓝图 §4.1 调 defineDomain（探针从 storage-domain 包导入运行时符号）
      let defineDomainResult = null
      try {
        const require_ = createRequire(process.argv[1])
        const entry = require_.resolve('@deepseek-ai/dsh-storage-domain')
        const mod = await import(pathToFileURL(entry).href)
        const spec = mod.defineDomain({
          name: 'commander', version: 1, layout: 'per-record',
          tables: {
            config: mod.domainTable(schemas.ConfigRecordSchema),
            workspaces: mod.domainTable(schemas.WorkspaceRecordSchema),
            commands: mod.domainTable(schemas.CommandRecordSchema),
            tasks: mod.domainTable(schemas.TaskRecordSchema),
            dispatches: mod.domainTable(schemas.DispatchRecordSchema),
            boardEdits: mod.domainTable(schemas.BoardEditRecordSchema),
            sessions: mod.domainTable(schemas.SessionLinkRecordSchema),
          },
        })
        defineDomainResult = { ok: true, specName: spec.name, tables: Object.keys(spec.tables) }
      } catch (error) {
        defineDomainResult = { ok: false, error: errText(error), name: error?.name }
      }
      pushLog({ kind: 'spec/defineDomain', nameChecks, defineDomainResult })
      json(res, 200, { ok: true, nameChecks, defineDomainResult })
    })

    /** 表名口径：blueprint = 冻结 blueprint 的 7 表原名；renamed = 仅把 cardEdits 改成下划线式（探索性，需 lead 批准后的最小改法）。 */
    const specTablesFor = (mode) => {
      const tables = {
        config: { valueSchema: schemas.ConfigRecordSchema },
        workspaces: { valueSchema: schemas.WorkspaceRecordSchema },
        commands: { valueSchema: schemas.CommandRecordSchema },
        tasks: { valueSchema: schemas.TaskRecordSchema },
        dispatches: { valueSchema: schemas.DispatchRecordSchema },
        sessions: { valueSchema: schemas.SessionLinkRecordSchema },
      }
      tables[mode === 'renamed' ? 'board_edits' : 'boardEdits'] = { valueSchema: schemas.BoardEditRecordSchema }
      return tables
    }

    route(ws, '/probe/v4/run', async (req, res) => {
      const { get } = query(req)
      const mode = get('tables') === 'renamed' ? 'renamed' : 'blueprint'
      const facility = getFacility()
      if (facility === undefined) return json(res, 200, { ok: false, reason: 'storageDomain_unavailable' })
      const cases = {}
      const fail = (name, error) => { cases[name] = { ok: false, error: errText(error) }; pushLog({ kind: 'case', name, ok: false, error: errText(error) }) }
      const pass = (name, detail) => { cases[name] = { ok: true, ...detail }; pushLog({ kind: 'case', name, ok: true, detail }) }

      // 手工构 spec（不调 defineDomain，以便按 mode 实测表名；命名规范冲突另记）
      const spec = { name: 'commander', version: 1, layout: 'per-record', tables: specTablesFor(mode) }
      let domain
      try {
        domain = await facility.open(spec)
        pass('C1_open', { domainName: domain.name, tables: Object.keys(spec.tables).map((name) => typeof domain.table(name)?.get) })
      } catch (error) {
        fail('C1_open', error)
        return json(res, 200, { ok: false, cases })
      }

      const tasks = domain.table('tasks')
      const sessions = domain.table('sessions')
      const configTable = domain.table('config')
      const t = now()
      const taskV1 = {
        v: 1, id: 'task_test_0001', title: '历史遗留 HTTP 客户端迁移', goal: '替换 vendored fork 并更新依赖',
        status: 'draft', workspaceId: 'ws_htdot', priority: 'normal', commandId: 'cmd_test_0001',
        assignments: [], acceptance: [{ id: 'acc_1', text: 'hello() 走 HTTP 客户端', source: 'commander', state: 'insufficient' }],
        capabilities: { policy: 'inherit', executor: 'capability-panel', status: 'inherited', enabled: [], disabled: [], at: t },
        timeline: [{ at: t, type: 'created', text: '创建任务' }],
        version: 1, createdAt: t, updatedAt: t, lastActivityAt: t,
      }

      // C2 往返
      try {
        await tasks.put('task_test_0001', taskV1)
        const read = tasks.get('task_test_0001')
        const equal = JSON.stringify(read) === JSON.stringify(taskV1)
        pass('C2_roundtrip', { equal, readVersion: read?.version, timelineLength: read?.timeline?.length ?? null, keyFieldsEqual: read?.id === taskV1.id && read?.v === 1 && read?.status === taskV1.status && read?.version === 1 })
      } catch (error) { fail('C2_roundtrip', error) }

      // C3 key 规则：`__` 复合 key 成功；含 `/`、`:` 的 key 被拒；拒绝后域仍可读写；应用层 sanitizeKey
      try {
        const sessionKey = 'ws_htdot__sess_8f31a2'
        const link = {
          v: 1, sessionId: 'sess_8f31a2', workspaceId: 'ws_htdot', taskId: 'task_test_0001',
          role: 'work', mode: 'new', createdAt: now(), status: 'queued',
        }
        await sessions.put(sessionKey, link)
        const readBack = sessions.get(sessionKey)
        const compoundKeyOk = readBack !== undefined && readBack.sessionId === 'sess_8f31a2'
        let badKeyError = null
        try { await sessions.put('bad/key:1', { ...link }) } catch (error) { badKeyError = errText(error) }
        const afterRejectOk = (() => {
          try { return sessions.get(sessionKey) !== undefined } catch { return false }
        })()
        let subsequentWriteOk = false
        try { await sessions.put('ws_htdot__sess_after_reject', { ...link, sessionId: 'sess_after_reject' }); subsequentWriteOk = sessions.get('ws_htdot__sess_after_reject') !== undefined } catch { subsequentWriteOk = false }
        const rawBad = 'ws/htdot:1'
        const sanitized = sanitizeKey(rawBad)
        let sanitizedWriteOk = false
        try { await sessions.put(sanitized, { ...link, sessionId: 'sess_sanitized' }); sanitizedWriteOk = sessions.get(sanitized) !== undefined } catch { sanitizedWriteOk = false }
        pass('C3_keys', { compoundKeyOk, badKeyError, afterRejectOk, subsequentWriteOk, sanitize: { raw: rawBad, sanitized, matchesRe: /^[a-zA-Z0-9_-]+$/.test(sanitized), sanitizedWriteOk } })
      } catch (error) { fail('C3_keys', error) }

      // C4 单次 update + version
      try {
        const updated = await tasks.update('task_test_0001', (rec) => ({ ...rec, status: 'proposed', version: rec.version + 1, updatedAt: now(), lastActivityAt: now(), timeline: [...rec.timeline, { at: now(), type: 'status', text: 'proposed' }] }))
        pass('C4_update', { version: updated.version, status: updated.status, timelineLength: updated.timeline.length })
      } catch (error) { fail('C4_update', error) }

      // C5 并发：两次未 await 的 update（不 await 第一次即发第二次）→ 都 resolve，version 精确 +2
      try {
        const before = tasks.get('task_test_0001')
        const p1 = tasks.update('task_test_0001', (rec) => ({ ...rec, version: rec.version + 1, updatedAt: now(), progress: { label: 'concurrent-a', at: now() } }))
        const p2 = tasks.update('task_test_0001', (rec) => ({ ...rec, version: rec.version + 1, updatedAt: now(), block: { reason: 'concurrent-b', since: now() } }))
        const [r1, r2] = await Promise.all([p1, p2])
        const final = tasks.get('task_test_0001')
        pass('C5_concurrent', {
          beforeVersion: before.version, r1Version: r1.version, r2Version: r2.version,
          finalVersion: final.version, versionDelta: final.version - before.version,
          progressKept: final.progress?.label === 'concurrent-a', blockKept: final.block?.reason === 'concurrent-b',
          statusKept: final.status === 'proposed',
        })
      } catch (error) { fail('C5_concurrent', error) }

      // C5b 并发回调抛错：reject 且不半写
      try {
        const before = tasks.get('task_test_0001')
        let thrown = null
        try {
          await tasks.update('task_test_0001', (rec) => { throw new Error('probe: update callback failed') })
        } catch (error) { thrown = errText(error) }
        const after = tasks.get('task_test_0001')
        pass('C5b_update_throw', { thrown, unchanged: JSON.stringify(after) === JSON.stringify(before), version: after.version })
      } catch (error) { fail('C5b_update_throw', error) }

      // C5c 应用层 version 冲突重试（实现口径：expectedVersion 落后 → 重读重试）
      try {
        const staleSnapshot = tasks.get('task_test_0001')
        await tasks.update('task_test_0001', (rec) => ({ ...rec, version: rec.version + 1, updatedAt: now() })) // 让快照变旧
        const attempt = async (expectedVersion, tries = 3) => {
          let lastError
          for (let attemptNo = 1; attemptNo <= tries; attemptNo += 1) {
            const current = tasks.get('task_test_0001')
            if (current.version !== expectedVersion) { lastError = `version-conflict: expected ${expectedVersion}, found ${current.version}`; expectedVersion = current.version; continue }
            const next = await tasks.update('task_test_0001', (rec) => ({ ...rec, version: rec.version + 1, progress: { label: 'retried', at: now() }, updatedAt: now() }))
            return { ok: true, attempt: attemptNo, version: next.version, finalLabel: next.progress?.label }
          }
          return { ok: false, error: lastError }
        }
        const retried = await attempt(staleSnapshot.version)
        pass('C5c_version_retry', { staleVersion: staleSnapshot.version, retried })
      } catch (error) { fail('C5c_version_retry', error) }

      // C8b 应用层 schema 前置校验（蓝图 §4.2 口径）：缺必填字段 → zod 拒绝，不 put
      try {
        const invalidTask = { v: 1, id: 'task_bad_0001', title: '缺字段', goal: 'x', status: 'draft', workspaceId: 'ws_htdot', priority: 'normal', commandId: 'cmd_x', assignments: [], acceptance: [], timeline: [], version: 1, createdAt: now(), updatedAt: now(), lastActivityAt: now() } // 缺 lastActivityAt? 有；缺 priority? 有。此处故意缺 status 之外… 用解析判断
        const parsed = schemas.TaskRecordSchema.safeParse(invalidTask)
        const invalid2 = { ...invalidTask }
        delete invalid2.status
        const parsed2 = schemas.TaskRecordSchema.safeParse(invalid2)
        pass('C8b_schema_prevalidate', {
          missingStatusAccepted: parsed2.success, missingStatusIssues: parsed2.success ? null : parsed2.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`).slice(0, 3),
          invalidStatusAccepted: (() => { const x = { ...invalidTask, status: 'bogus' }; return schemas.TaskRecordSchema.safeParse(x).success })(),
        })
      } catch (error) { fail('C8b_schema_prevalidate', error) }

      // config singleton + 记录 close
      try {
        const cfg = {
          v: 1,
          commander: { workspaceId: 'ws_htdot', workspacePath: '<repo>/.probe/ws-cold', sessionId: 'sess_commander_0001', model: { provider: 'deepseek-official', model: 'deepseek-chat' } },
          jev: { provider: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', keySource: 'env', envVar: 'JEV_API_KEY', threshold: 0.8, confidenceFloor: 0.5, timeoutMs: 1500, onTimeout: 'pause_and_ask' },
          board: { archiveAfterDays: 30, syncUserEdits: true },
          ui: { theme: 'follow', entryPosition: 'br', hotkey: 'Mod+Shift+K' },
          updatedAt: now(),
        }
        await configTable.put('singleton', cfg)
        pass('C4b_config_singleton', { readBack: configTable.get('singleton')?.commander?.sessionId ?? null })
      } catch (error) { fail('C4b_config_singleton', error) }

      try {
        const sizes = { tasks: tasks.size, sessions: sessions.size, config: configTable.size }
        await domain.close()
        pass('close', sizes)
      } catch (error) { fail('close', error) }

      try { mkdirSync(dirname(summaryFile), { recursive: true }); writeFileSync(summaryFile, JSON.stringify({ phase: 'run', mode, at: new Date().toISOString(), cases, logs }, null, 2) + '\n') } catch { /* noop */ }
      json(res, 200, { ok: true, phase: 'run', mode, tables: Object.keys(spec.tables), cases })
    })

    route(ws, '/probe/v4/restart-check', async (req, res) => {
      const { get } = query(req)
      const mode = get('tables') === 'renamed' ? 'renamed' : 'blueprint'
      const facility = getFacility()
      if (facility === undefined) return json(res, 200, { ok: false, reason: 'storageDomain_unavailable' })
      const spec = { name: 'commander', version: 1, layout: 'per-record', tables: specTablesFor(mode) }
      let out
      try {
        const domain = await facility.open(spec)
        const task = domain.table('tasks').get('task_test_0001')
        const sessionLink = domain.table('sessions').get('ws_htdot__sess_8f31a2')
        const sanitized = domain.table('sessions').get(sanitizeKey('ws/htdot:1'))
        const cfg = domain.table('config').get('singleton')
        out = {
          ok: true,
          mode,
          tables: Object.keys(spec.tables),
          task: task === undefined ? null : { id: task.id, v: task.v, status: task.status, version: task.version, timelineLength: task.timeline?.length ?? null, progress: task.progress?.label ?? null, block: task.block?.reason ?? null },
          sessionCompoundKey: sessionLink === undefined ? null : { sessionId: sessionLink.sessionId, role: sessionLink.role, status: sessionLink.status },
          sanitizedKeyPresent: sanitized !== undefined,
          configSingleton: cfg === undefined ? null : { commanderSessionId: cfg.commander?.sessionId ?? null, jevModel: cfg.jev?.model ?? null },
          tableSizes: { tasks: domain.table('tasks').size, sessions: domain.table('sessions').size, config: domain.table('config').size },
        }
        await domain.close()
      } catch (error) { out = { ok: false, error: errText(error) } }
      try { writeFileSync(summaryFile, JSON.stringify({ phase: 'restart-check', at: new Date().toISOString(), out, logs }, null, 2) + '\n') } catch { /* noop */ }
      json(res, 200, out)
    })

    route(ws, '/probe/v4/schema-open', async (req, res) => {
      const facility = getFacility()
      if (facility === undefined) return json(res, 200, { ok: false, reason: 'storageDomain_unavailable' })
      const spec = { name: 'cmd_probe_invalid', version: 1, layout: 'per-record', tables: { tasks: { valueSchema: schemas.TaskRecordSchema } } }
      const out = { ok: true, steps: {} }
      try {
        const domain = await facility.open(spec)
        // 绕过应用层校验直接写一条非法记录：验证存储层的 durable 边界校验（open 时 invalid-record）
        await domain.table('tasks').put('task_bad_schema', { v: 1, id: 'task_bad_schema', title: '缺字段记录' })
        out.steps.writeAccepted = true
        await domain.close()
      } catch (error) { out.steps.writeAccepted = false; out.steps.writeError = errText(error) }
      try {
        const domain2 = await facility.open(spec)
        out.steps.reopen = { ok: true, note: 'unexpected: invalid record accepted on open' }
        await domain2.close()
      } catch (error) {
        out.steps.reopen = { ok: false, error: errText(error), code: error?.code ?? null, name: error?.name ?? null }
      }
      pushLog({ kind: 'schema-open', out })
      json(res, 200, out)
    })

    route(ws, '/probe/v4/tree', async (req, res) => {
      const root = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages') : null
      const walk = (dir, prefix = '') => {
        const out = []
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const full = join(dir, entry.name)
          const rel = prefix + entry.name
          if (entry.isDirectory()) out.push({ path: rel, type: 'dir' }, ...walk(full, rel + '/'))
          else { let size = null; try { size = statSync(full).size } catch { /* noop */ } out.push({ path: rel, type: 'file', size }) }
        }
        return out
      }
      json(res, 200, { ok: true, root, entries: root === null ? [] : walk(root) })
    })

    route(ws, '/probe/v4/quit', async (req, res) => {
      try { writeFileSync(summaryFile, JSON.stringify({ phase: 'quit', at: new Date().toISOString(), startedAt, node: process.version, env: { DSH_HOME: process.env.DSH_HOME ?? null }, logs }, null, 2) + '\n') } catch { /* noop */ }
      json(res, 200, { ok: true, summaryFile, logs: logs.length })
      setTimeout(() => {
        const exit = (() => { try { return ctx.get('appExit') } catch { return undefined } })()
        if (typeof exit === 'function') exit(0); else process.exit(0)
      }, 150)
    })

    pushLog({ kind: 'routes/registered', origin: (() => { try { return ws.getOrigin() } catch { return null } })() })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => { void registerRoutes(hostCtx) })
  } else {
    setTimeout(() => { void registerRoutes(ctx) }, 1000)
  }
}
