import test from 'node:test'
import assert from 'node:assert/strict'
import { createShellSupervisor, resolveShellBinary } from '../../src/host/native/supervisor.ts'

class FakeClock {
  now = 0
  private seq = 0
  private timers = new Map<number, { at: number; every?: number; fn: () => void }>()

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number)
  }

  setInterval = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.now + ms, every: ms, fn })
    return id
  }

  clearInterval = (id: unknown): void => {
    this.timers.delete(id as number)
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let nextId: number | undefined
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextId = id
          nextAt = timer.at
        }
      }
      if (nextId === undefined) break
      this.now = nextAt
      const timer = this.timers.get(nextId)
      if (timer === undefined) continue
      if (timer.every === undefined) this.timers.delete(nextId)
      else timer.at += timer.every
      timer.fn()
    }
    this.now = target
  }
}

class FakeProcess {
  static nextPid = 1000
  pid = FakeProcess.nextPid++
  stdinWrites: string[] = []
  killed = false
  private stdoutListeners: Array<(chunk: unknown) => void> = []
  private stderrListeners: Array<(chunk: unknown) => void> = []
  private exitListener: ((code: number | null, signal: string | null) => void) | null = null

  stdin = {
    write: (chunk: string): boolean => {
      this.stdinWrites.push(chunk)
      return true
    },
    end: (): void => {},
  }

  stdout = {
    on: (_event: 'data', listener: (chunk: unknown) => void): void => {
      this.stdoutListeners.push(listener)
    },
  }

  stderr = {
    on: (_event: 'data', listener: (chunk: unknown) => void): void => {
      this.stderrListeners.push(listener)
    },
  }

  on(_event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
    this.exitListener = listener
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  emit(frame: Record<string, unknown>): void {
    const line = `${JSON.stringify(frame)}\n`
    for (const listener of this.stdoutListeners) listener(line)
  }

  exit(code: number | null = 0): void {
    this.exitListener?.(code, null)
  }

  lastFrame(): Record<string, unknown> {
    const line = this.stdinWrites.at(-1) ?? '{}'
    return JSON.parse(line.trim()) as Record<string, unknown>
  }
}

function makeSupervisor() {
  const clock = new FakeClock()
  const processes: FakeProcess[] = []
  const phases: string[] = []
  const supervisor = createShellSupervisor({
    binaryPath: '/tmp/dsh-commander-shell',
    origin: 'http://127.0.0.1:1234',
    windowToken: 'tok-123',
    stateDir: '/tmp/commander-state',
    theme: 'follow',
    locale: 'zh',
    entryPos: null,
    hotkey: 'Alt+Space',
    spawn: () => {
      const child = new FakeProcess()
      processes.push(child)
      return child
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    onStatusChange: (status) => phases.push(status.phase),
  })
  return { clock, processes, phases, supervisor }
}

function hello(process_: FakeProcess): void {
  process_.emit({ type: 'hello', protocol: 1, platform: 'darwin', arch: 'arm64', pid: process_.pid, capabilities: ['ball', 'panel', 'hotkey'], hotkey: 'Alt+Space' })
}

test('supervisor handshakes, emits ready and reports running', () => {
  const { processes, supervisor } = makeSupervisor()
  supervisor.start()
  assert.equal(supervisor.status().phase, 'starting')
  assert.equal(processes.length, 1)

  hello(processes[0] as FakeProcess)
  assert.equal(supervisor.status().phase, 'running')
  assert.equal(supervisor.status().pid, (processes[0] as FakeProcess).pid)
  const ready = (processes[0] as FakeProcess).lastFrame()
  assert.equal(ready.type, 'ready')
  assert.equal(ready.origin, 'http://127.0.0.1:1234')
  assert.equal(ready.hotkey, 'Alt+Space')
  assert.deepEqual(ready.panel, { width: 420, height: 660 })
})

test('supervisor sends ping and restarts after a pong timeout', () => {
  const { clock, processes, supervisor } = makeSupervisor()
  supervisor.start()
  hello(processes[0] as FakeProcess)

  clock.advance(10_000)
  assert.equal((processes[0] as FakeProcess).lastFrame().type, 'ping')

  clock.advance(30_001)
  assert.equal((processes[0] as FakeProcess).killed, true)
  assert.equal(supervisor.status().phase, 'starting')

  clock.advance(750)
  assert.equal(processes.length, 2)
})

test('supervisor ignores pong and stays running', () => {
  const { clock, processes, supervisor } = makeSupervisor()
  supervisor.start()
  hello(processes[0] as FakeProcess)

  clock.advance(10_000)
  processes[0]?.emit({ type: 'pong', at: 10_000 })
  clock.advance(20_000)
  processes[0]?.emit({ type: 'pong', at: 30_000 })
  clock.advance(20_000)
  assert.equal(supervisor.status().phase, 'running')
  assert.equal((processes[0] as FakeProcess).killed, false)
})

test('supervisor restarts after an unexpected exit with backoff', () => {
  const { clock, processes, supervisor } = makeSupervisor()
  supervisor.start()
  hello(processes[0] as FakeProcess)

  processes[0]?.exit(1)
  assert.equal(supervisor.status().phase, 'starting')
  clock.advance(750)
  assert.equal(processes.length, 2)
  assert.equal(supervisor.status().restarts, 1)
})

test('supervisor stops the shell with a shutdown frame and does not restart', () => {
  const { clock, processes, supervisor } = makeSupervisor()
  supervisor.start()
  hello(processes[0] as FakeProcess)

  supervisor.stop()
  assert.equal((processes[0] as FakeProcess).lastFrame().type, 'shutdown')
  assert.equal(supervisor.status().phase, 'stopped')
  clock.advance(60_000)
  assert.equal(processes.length, 1)
})

test('supervisor rejects a protocol mismatch and does not restart', () => {
  const { clock, processes, supervisor } = makeSupervisor()
  supervisor.start()
  processes[0]?.emit({ type: 'hello', protocol: 99, platform: 'darwin', arch: 'arm64', pid: 1, capabilities: [] })
  assert.equal(supervisor.status().phase, 'failed')
  clock.advance(60_000)
  assert.equal(processes.length, 1)
})

test('supervisor reports disabled when no binary is present', () => {
  const disabled = createShellSupervisor({
    binaryPath: null,
    origin: 'http://127.0.0.1:1',
    windowToken: 't',
    stateDir: '/tmp',
    theme: 'follow',
    locale: 'zh',
    entryPos: null,
    hotkey: 'Alt+Space',
    spawn: () => {
      throw new Error('should not spawn')
    },
  })
  disabled.start()
  assert.equal(disabled.status().phase, 'disabled')
})

test('resolveShellBinary prefers the platform-arch directory', () => {
  const present = resolveShellBinary('/this/does/not/exist', 'darwin', 'arm64')
  assert.equal(present, null)
  const windows = resolveShellBinary('/this/does/not/exist', 'win32', 'x64')
  assert.equal(windows, null)
})
