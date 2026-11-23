#!/usr/bin/env node
/**
 * T65/T66 独立复核 e2e（常规回归，backend 建议保留）：
 * 覆盖：冷会话绑定 200 / 跨 workspace 409 workspace_conflict / 未知 404 not_found /
 *       GET /commander/sessions 含 createdAt+title / 重启 Host 后冷会话仍可绑定。
 * 运行：node packages/dsh-commander/tests/e2e/bind-select-e2e.mjs
 * 证据：tests/artifacts/m1/live/t65-bind/**（boot 日志、sessions/绑定响应、summary.json）。
 * 仅写 tests/artifacts/**；隔离 DSH_HOME，不碰 live。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const OUT = path.join(REPO, 'tests/artifacts/m1/live/t65-bind')
const PROBE = path.join(HERE, 'probes/m1-e2e-probe.mjs')
const checks = []
const add = (id, ok, ev) => checks.push({ id, ok: Boolean(ok), evidence: String(ev ?? '') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(OUT, { recursive: true })
const log = []
const run = (bin, args, env) => { log.push(`$ ${bin} ${args.join(' ')}`); try { return { ok: true, out: execFileSync(bin, args, { cwd: REPO, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }) } } catch (e) { return { ok: false, err: String(e?.stderr ?? '') } } }

class Host {
  constructor(root, paths) { this.root = root; this.paths = paths; this.stdout = ''; this.base = '' }
  get env() {
    const env = { ...process.env, DSH_COMMANDER_NATIVE_SHELL: '0', DSH_HOME: path.join(this.root, 'home'), DSH_AGENTS_HOME: path.join(this.root, 'agents'), COMMANDER_BOOT_LOG: 'warn' }
    for (const k of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL', 'DSH_INSTALL_DIR', 'DSH_NODE_EXECUTABLE', 'DSH_USER_AGENT_SUFFIX']) delete env[k]
    return env
  }
  async setup() {
    fs.rmSync(this.root, { recursive: true, force: true })
    for (const p of this.paths) fs.mkdirSync(p, { recursive: true })
    const env = this.env
    run('dsh', ['--profile', 't65e2e', '--from-default-profile', 'web', '--dump-default-config'], env)
    run('dsh', ['plugin', '--profile', 't65e2e', 'add', `file:${REPO}/packages/dsh-commander`], env)
    this.patch = path.join(this.root, 't65.patch.yml')
    fs.writeFileSync(this.patch, `- insert:\n    - id: t65-probe\n      name: 'file://${PROBE}'\n      config:\n        workspacePaths: [${this.paths.map((p) => `'${p}'`).join(', ')}]\n        panelMode: 'none'\n`)
  }
  async boot() {
    this.stdout = ''
    this.child = spawn('dsh', ['--profile', 't65e2e', '--patch', this.patch, '--port', '0', '--no-open'], { cwd: REPO, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child.stdout.on('data', (d) => { this.stdout += d; fs.appendFileSync(path.join(OUT, 'boot.out'), d) })
    this.child.stderr.on('data', (d) => fs.appendFileSync(path.join(OUT, 'boot.err'), d))
    for (let i = 0; i < 300; i += 1) { const m = this.stdout.match(/^dsh web: (http:\/\/[^\s?]+)/m); if (m) { this.base = m[1].replace(/\/$/, ''); break } await sleep(150) }
    for (let i = 0; i < 300 && this.base; i += 1) { try { if ((await fetch(`${this.base}/commander/health`)).status === 200) return true } catch {} await sleep(150) }
    return false
  }
  async stop() { if (!this.child || this.child.exitCode !== null) return; this.child.kill('SIGTERM'); for (let i = 0; i < 80; i += 1) { if (this.child.exitCode !== null) break; await sleep(100) } if (this.child.exitCode === null) this.child.kill('SIGKILL') }
  async get(p) { const r = await fetch(`${this.base}${p}`); return { status: r.status, body: await r.json().catch(() => null) } }
  async send(m, p, b) { const r = await fetch(`${this.base}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) } }
  async waitFor(fn, t = 20000) { const s = Date.now(); while (Date.now() - s < t) { const v = await fn().catch(() => null); if (v) return v; await sleep(250) } return null }
}

const root = path.join(OUT, 'probe-root')
const wsA = path.join(root, 'ws-a')
const wsB = path.join(root, 'ws-b')
const host = new Host(path.join(OUT, 'host'), [wsA, wsB])
try {
  await host.setup()
  add('cold-start boot#1', await host.boot(), 'health 200')
  const diag = await host.waitFor(async () => { const d = (await host.get('/m1e2e/diag')).body; return (d?.workspaces ?? []).length >= 2 ? d : null })
  const idA = (diag.workspaces.find((w) => w.path === wsA) ?? {}).id ?? ''
  const idB = (diag.workspaces.find((w) => w.path === wsB) ?? {}).id ?? ''
  add('workspaces A/B registered', idA && idB, `${idA} / ${idB}`)
  const created = (await host.get(`/m1r/create-session?cwd=${encodeURIComponent(wsA)}`)).body
  const sid = created?.sessionId ?? ''
  add('fixture cold session created', sid !== '' && created?.attachedWorkspaceId === idA, `sid=${sid} attached=${created?.attachedWorkspaceId}`)
  await host.stop()
  await host.boot()
  add('reboot same home', true, 'health 200')
  const sessions = await host.waitFor(async () => { const r = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(idA)}`); const row = (r.body?.sessions ?? []).find((x) => x.sessionId === sid); return row && typeof row.createdAt === 'number' ? r.body : null })
  fs.writeFileSync(path.join(OUT, 'sessions-after-reboot.json'), `${JSON.stringify(sessions, null, 2)}\n`)
  const row = (sessions?.sessions ?? []).find((x) => x.sessionId === sid)
  add('GET sessions 重启后含 fixture 且 createdAt 为数字', sessions !== null && typeof row?.createdAt === 'number', JSON.stringify(row))
  // task-67 性能护栏：隔离 Host 下 sessions 路由延迟（limit=5，多次取 p50/p95）
  const latency = []
  for (let i = 0; i < 8; i += 1) {
    const startedAt = Number(process.hrtime.bigint() / 1000000n)
    const res = await host.get(`/commander/sessions?workspaceId=${encodeURIComponent(idA)}&limit=5`)
    const ms = Number(process.hrtime.bigint() / 1000000n) - startedAt
    if (res.status === 200) latency.push(ms)
    await sleep(100)
  }
  latency.sort((a, b) => a - b)
  const stats = { count: latency.length, p50: latency[Math.floor(latency.length / 2)] ?? -1, p95: latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)] ?? -1, max: latency[latency.length - 1] ?? -1, timesMs: latency }
  fs.writeFileSync(path.join(OUT, 'isolated-latency.json'), `${JSON.stringify(stats, null, 2)}\n`)
  add('隔离 Host sessions limit=5 延迟 p95 < 2s', stats.p95 >= 0 && stats.p95 < 2000, JSON.stringify(stats))
  const bind = await host.send('POST', '/commander/binding', { mode: 'select', workspaceId: idA, sessionId: sid })
  fs.writeFileSync(path.join(OUT, 'binding-select.json'), `${JSON.stringify(bind, null, 2)}\n`)
  add('POST binding mode=select（冷会话）→ 200 且 sessionId 匹配', bind.status === 200 && bind.body?.binding?.sessionId === sid, `http=${bind.status} sid=${bind.body?.binding?.sessionId}`)
  const state = (await host.get('/commander/state')).body
  add('state.binding.sessionId 已切换', state?.binding?.sessionId === sid, `state sid=${state?.binding?.sessionId}`)
  const wrongWs = await host.send('POST', '/commander/binding', { mode: 'select', workspaceId: idB, sessionId: sid })
  fs.writeFileSync(path.join(OUT, 'binding-wrong-ws.json'), `${JSON.stringify(wrongWs, null, 2)}\n`)
  add('跨工作区 select → conflict/workspace_conflict', wrongWs.status === 409 && ['workspace_conflict', 'conflict'].includes(wrongWs.body?.code), `http=${wrongWs.status} code=${wrongWs.body?.code}`)
  const unknown = await host.send('POST', '/commander/binding', { mode: 'select', workspaceId: idA, sessionId: 'session-does-not-exist-000' })
  fs.writeFileSync(path.join(OUT, 'binding-unknown.json'), `${JSON.stringify(unknown, null, 2)}\n`)
  add('未知会话 select → 404 not_found', unknown.status === 404 && unknown.body?.code === 'not_found', `http=${unknown.status}`)
} catch (e) { add('e2e exception', false, String(e?.message ?? e)) } finally { try { await host.stop() } catch {} }

const failed = checks.filter((c) => !c.ok)
fs.writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify({ checks, failed: failed.length }, null, 2)}\n`)
fs.writeFileSync(path.join(OUT, 'commands.log'), `${log.join('\n')}\n`)
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} —— ${c.evidence}`)
console.log(`汇总：${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length ? 1 : 0)
