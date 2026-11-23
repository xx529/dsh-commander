// 原生壳进程管理（契约：docs/architecture/native-shell-contract.md §3.3）。
// 只负责 spawn / 握手 / 心跳 / 退避重启 / 退出；窗口行为在壳内，业务在 HTTP 数据面。
import { spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HostFrame, ShellFrame } from './protocol.ts'
import { encodeHostFrame, parseShellFrame, SHELL_PROTOCOL } from './protocol.ts'

export type ShellPhase = 'disabled' | 'starting' | 'running' | 'failed' | 'stopped'

export interface ShellStatus {
  phase: ShellPhase
  pid: number | null
  restarts: number
  lastError: string | null
  panelOpen: boolean
  visible: boolean
  focused: boolean
}

export interface ShellSpawnOptions {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
}

/** ChildProcess 的最小面，便于单测注入 fake。 */
export interface ShellProcess {
  pid?: number
  stdin: { write(chunk: string): boolean; end(): void } | null
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): void } | null
  stderr: { on(event: 'data', listener: (chunk: unknown) => void): void } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnFn = (options: ShellSpawnOptions) => ShellProcess

export interface SupervisorOptions {
  /** 壳可执行文件绝对路径；null = 当前平台没有产物（降级，不重启）。 */
  binaryPath: string | null
  origin: string
  windowToken: string
  stateDir: string
  theme: 'light' | 'dark' | 'follow'
  locale: 'zh' | 'en'
  entryPos: { x: number; y: number } | null
  hotkey: string
  parentPid?: number
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  spawn?: SpawnFn
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  maxRestarts?: number
  heartbeatMs?: number
  pongTimeoutMs?: number
  stableResetMs?: number
  onStatusChange?: (status: ShellStatus) => void
}

export interface ShellSupervisor {
  start(): void
  stop(): void
  status(): ShellStatus
}

const DEFAULT_MAX_RESTARTS = 12
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_PONG_TIMEOUT_MS = 30_000
const DEFAULT_STABLE_RESET_MS = 180_000
const BALL_SIZE = 56
const PANEL_WIDTH = 420
const PANEL_HEIGHT = 660

/** 解析包内壳产物：native/dist/<platform>-<arch>/dsh-commander-shell[.exe]。 */
export function resolveShellBinary(packageRoot: string, platform = process.platform, arch = process.arch): string | null {
  const name = platform === 'win32' ? 'dsh-commander-shell.exe' : 'dsh-commander-shell'
  const candidates = [
    join(packageRoot, 'native', 'dist', `${platform}-${arch}`, name),
    join(packageRoot, 'native', 'dist', name),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function defaultSpawn(options: ShellSpawnOptions): ShellProcess {
  const child = nodeSpawn(options.command, options.args, { env: options.env, stdio: options.stdio })
  return child as unknown as ShellProcess
}

/**
 * 创建一个壳进程 supervisor。`start()` 幂等；`stop()` 后不会自动重启。
 * @param options - 产物路径、origin、token、窗口偏好与可注入的时钟/进程工厂（测试用）。
 */
export function createShellSupervisor(options: SupervisorOptions): ShellSupervisor {
  const spawnFn = options.spawn ?? defaultSpawn
  const now = options.now ?? Date.now
  const setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
  const setTimeoutFn = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS
  const stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS
  const log = options.log ?? (() => {})

  let child: ShellProcess | null = null
  let phase: ShellPhase = 'disabled'
  let pid: number | null = null
  let restarts = 0
  let lastError: string | null = null
  let panelOpen = false
  let visible = false
  let focused = false
  let buffer = ''
  let stopping = false
  let started = false
  let lastPongAt = 0
  let heartbeat: unknown
  let restartTimer: unknown
  let stableTimer: unknown

  const status = (): ShellStatus => ({ phase, pid, restarts, lastError, panelOpen, visible, focused })

  function emit(): void {
    options.onStatusChange?.(status())
  }

  function write(frame: HostFrame): void {
    try {
      child?.stdin?.write(encodeHostFrame(frame))
    } catch (error) {
      log('warn', `write frame failed: ${String(error)}`)
    }
  }

  function readyFrame(): HostFrame {
    return {
      type: 'ready',
      origin: options.origin,
      theme: options.theme,
      locale: options.locale,
      ball: { size: BALL_SIZE },
      panel: { width: PANEL_WIDTH, height: PANEL_HEIGHT },
      entryPos: options.entryPos,
      hotkey: options.hotkey,
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat !== undefined) {
      clearIntervalFn(heartbeat)
      heartbeat = undefined
    }
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    lastPongAt = now()
    heartbeat = setIntervalFn(() => {
      if (now() - lastPongAt > pongTimeoutMs) {
        log('warn', `shell heartbeat timeout after ${pongTimeoutMs}ms`)
        lastError = 'heartbeat timeout'
        const dying = child
        child = null
        try {
          dying?.kill('SIGKILL')
        } catch {
          // ignore
        }
        scheduleRestart()
        return
      }
      write({ type: 'ping', at: now() })
    }, heartbeatMs)
  }

  function onFrame(frame: ShellFrame): void {
    switch (frame.type) {
      case 'hello':
        if (frame.protocol !== SHELL_PROTOCOL) {
          lastError = `protocol mismatch: shell=${frame.protocol} host=${SHELL_PROTOCOL}`
          log('error', lastError)
          phase = 'failed'
          emit()
          const current = child
          child = null
          pid = null
          stopHeartbeat()
          try {
            current?.kill('SIGKILL')
          } catch {
            // ignore
          }
          return
        }
        phase = 'running'
        pid = frame.pid
        lastError = null
        lastPongAt = now()
        log('info', `shell ready pid=${frame.pid} platform=${frame.platform} arch=${frame.arch}`)
        write(readyFrame())
        startHeartbeat()
        if (stableTimer !== undefined) clearTimeoutFn(stableTimer)
        stableTimer = setTimeoutFn(() => {
          restarts = 0
        }, stableResetMs)
        emit()
        return
      case 'pong':
        lastPongAt = now()
        return
      case 'window/visibility':
        panelOpen = frame.panelOpen
        visible = frame.visible
        focused = frame.focused
        emit()
        return
      case 'window/bounds':
        return
      case 'log':
        log(frame.level, `[shell] ${frame.message}`)
        return
    }
  }

  function onStdout(chunk: unknown): void {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        const frame = parseShellFrame(line)
        if (frame === null) log('warn', `unparseable shell frame: ${line.slice(0, 200)}`)
        else onFrame(frame)
      }
      index = buffer.indexOf('\n')
    }
    if (buffer.length > 1_048_576) buffer = ''
  }

  function scheduleRestart(): void {
    if (stopping) return
    // 防重入：exit 与心跳超时可能同时触发，避免并发 spawn 出多个壳窗口。
    if (restartTimer !== undefined) return
    if (restarts >= maxRestarts) {
      phase = 'failed'
      lastError = lastError ?? 'restart budget exhausted'
      log('error', `shell restart budget exhausted (${maxRestarts})`)
      emit()
      return
    }
    const delay = Math.min(30_000, 750 * 2 ** restarts)
    restarts += 1
    phase = 'starting'
    emit()
    restartTimer = setTimeoutFn(() => {
      restartTimer = undefined
      if (!stopping) launch()
    }, delay)
  }

  function onExit(code: number | null, signal: string | null): void {
    stopHeartbeat()
    child = null
    pid = null
    if (stopping) {
      phase = 'stopped'
      emit()
      return
    }
    lastError = `exit code=${String(code)} signal=${String(signal)}`
    log('warn', `shell exited (${lastError})`)
    scheduleRestart()
  }

  function launch(): void {
    if (options.binaryPath === null) {
      phase = 'disabled'
      emit()
      return
    }
    // 确保上一个壳已退出，避免残留窗口。
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      child = null
      pid = null
    }
    phase = 'starting'
    emit()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_COMMANDER_WINDOW_URL: `${options.origin}/commander/window?token=${encodeURIComponent(options.windowToken)}`,
      DSH_COMMANDER_PARENT_PID: String(options.parentPid ?? process.pid),
      DSH_COMMANDER_STATE_DIR: options.stateDir,
      DSH_COMMANDER_HOTKEY: options.hotkey,
      DSH_COMMANDER_THEME: options.theme,
      DSH_COMMANDER_LOCALE: options.locale,
      DSH_COMMANDER_LOG: '1',
    }
    try {
      const next = spawnFn({ command: options.binaryPath, args: [], env, stdio: ['pipe', 'pipe', 'pipe'] })
      child = next
      pid = next.pid ?? null
      buffer = ''
      next.stdout?.on('data', onStdout)
      next.stderr?.on('data', (chunk) => log('warn', `shell stderr: ${String(chunk).trim().slice(0, 500)}`))
      // 旧进程的 exit 不能触发重启（只有当前 child 才有资格）。
      next.on('exit', (code, signal) => {
        if (child !== next) return
        onExit(code, signal)
      })
    } catch (error) {
      lastError = String(error)
      log('error', `shell spawn failed: ${lastError}`)
      scheduleRestart()
    }
  }

  function stopProcess(): void {
    const current = child
    child = null
    pid = null
    stopHeartbeat()
    if (current !== null) {
      try {
        current.stdin?.write(encodeHostFrame({ type: 'shutdown' }))
      } catch {
        // ignore
      }
      setTimeoutFn(() => {
        try {
          current.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, 1_500)
    }
    phase = 'stopped'
    emit()
  }

  return {
    start(): void {
      if (started || options.binaryPath === null) {
        if (!started && options.binaryPath === null) {
          phase = 'disabled'
          emit()
        }
        return
      }
      started = true
      stopping = false
      // 清理上一次 Host 留下的单实例锁；旧壳会由父 PID 看门狗自行退出。
      try {
        unlinkSync(join(options.stateDir, 'shell.pid'))
      } catch {
        // ignore
      }
      // pnpm file: 安装一般保留可执行位；丢了也能在这里补回来（失败不影响后续 spawn）。
      try {
        chmodSync(options.binaryPath, 0o755)
      } catch {
        // ignore
      }
      phase = 'starting'
      emit()
      launch()
    },
    stop(): void {
      if (stopping) return
      stopping = true
      started = false
      if (restartTimer !== undefined) {
        clearTimeoutFn(restartTimer)
        restartTimer = undefined
      }
      if (stableTimer !== undefined) {
        clearTimeoutFn(stableTimer)
        stableTimer = undefined
      }
      stopProcess()
    },
    status,
  }
}
