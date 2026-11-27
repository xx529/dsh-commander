#!/usr/bin/env node
/**
 * 安装时构建（pnpm 对 git 依赖执行的 `prepare` 钩子）。
 *
 * 背景：`lib/` 与 `native/dist/` 都不入库，从 GitHub 安装的包默认没有可执行的
 * 产物（`exports` 指向不存在的 `lib/host/index.js`）。pnpm 会在拉取 git 依赖后
 * 先 `npm install` 装 devDependencies、再执行本包的 `prepare`；本脚本就是在这里
 * 把两半构建出来，pnpm 随后的打包会把 `lib/` 与 `native/dist/` 一起收进安装结果。
 *
 * 行为：
 * 1. Host（tsc）+ Client（tsdown + wrap-client）+ 原生窗口页（tsdown iife）；
 *    JS 构建失败即失败——没有产物的安装没有意义。
 * 2. 原生壳（Tauri）：仅当包内还没有对应产物时才处理，顺序是
 *    a) 本地缓存 `~/.dsh/commander/native-cache/v<ver>-<platform>-<arch>/`；
 *    b) GitHub Release 预编译产物（`releases/download/v<ver>/dsh-commander-shell-<platform>-<arch>`，
 *       带 `.sha256` 校验，下载后 chmod + ad-hoc 重签）；
 *    c) 兜底才用 cargo 冷编译（慢，且 DSH 安装有 10 分钟无输出超时，可能被杀）。
 *    任何一步失败只告警，插件降级为页内浮窗，不阻断安装。`COMMANDER_SKIP_NATIVE=1` 可跳过。
 *
 * 本地工作区 `pnpm install` 也会触发本钩子：此时 `native/dist` 已存在，原生部分
 * 直接跳过，只重建 `lib/`。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const binDir = join(pkgRoot, 'node_modules', '.bin')

const log = (message) => console.log(`[dsh-commander:prepare] ${message}`)

function bin(name) {
  const local = join(binDir, name)
  return existsSync(local) ? local : name
}

function run(label, command, args, extraEnv = {}, { fatal = true } = {}) {
  log(`${label}: ${[command, ...args].join(' ')}`)
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    const reason = `${label} exit ${String(result.status ?? result.signal)}`
    if (fatal) throw new Error(reason)
    log(`warning: ${reason} (${seconds}s) — continuing`)
    return false
  }
  log(`${label}: ok in ${seconds}s`)
  return true
}

function nodeArch() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'x64':
      return 'x64'
    default:
      return process.arch
  }
}

function shellBinaryPath() {
  const name = process.platform === 'win32' ? 'dsh-commander-shell.exe' : 'dsh-commander-shell'
  return join(pkgRoot, 'native', 'dist', `${process.platform}-${nodeArch()}`, name)
}

function buildJavaScript() {
  const wrapClient = join(repoRoot, 'tools', 'dev', 'wrap-client.mjs')
  if (!existsSync(wrapClient)) {
    throw new Error(`missing client wrapper: ${wrapClient} (install from the repository root, not a detached package)`)
  }
  run('host', bin('tsc'), ['-p', 'tsconfig.host.json'])
  run('client', bin('tsdown'), [])
  run('client-wrap', process.execPath, [wrapClient, 'dsh-commander', 'lib/client.cjs', 'lib/client.js'])
  run('window', bin('tsdown'), ['--config', 'tsdown.window.config.ts'])
  const bundle = join(pkgRoot, 'lib', 'window.iife.js')
  const target = join(pkgRoot, 'lib', 'window.js')
  if (existsSync(bundle)) renameSync(bundle, target)
  if (!existsSync(join(pkgRoot, 'lib', 'host', 'index.js')) || !existsSync(join(pkgRoot, 'lib', 'client.js'))) {
    throw new Error('build finished without lib/host/index.js or lib/client.js')
  }
}


/** 包版本 → GitHub Release tag（`v0.2.2` 之类）。 */
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return ''
  }
}

function assetName() {
  return `dsh-commander-shell-${process.platform}-${nodeArch()}${process.platform === 'win32' ? '.exe' : ''}`
}

function nativeCacheDir(version) {
  return join(homedir(), '.dsh', 'commander', 'native-cache', `v${version}-${process.platform}-${nodeArch()}`)
}

/** 把一份壳二进制装到包内产物位：可执行位 + macOS ad-hoc 重签。 */
function installBinary(source) {
  const target = shellBinaryPath()
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  if (process.platform === 'darwin') {
    // 拷贝可能破坏/丢失签名；显式 ad-hoc 重签，避免 Gatekeeper 判 Code Signature Invalid。
    spawnSync('codesign', ['--force', '--sign', '-', target], { stdio: 'ignore' })
  }
  return existsSync(target)
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * 优先用发布的预编译壳：比在安装时冷编译快两个数量级，也不会撞上安装的静默超时。
 * 返回 true 表示已就位；任何失败都返回 false 交给 cargo 兜底。
 */
async function fetchNativeBinary() {
  const version = packageVersion()
  if (version === '') return false
  const name = assetName()
  const cache = join(nativeCacheDir(version), name)
  if (existsSync(cache)) {
    log(`native: using cached release asset ${cache}`)
    return installBinary(cache)
  }
  const base = `https://github.com/xx529/dsh-commander/releases/download/v${version}`
  try {
    log(`native: downloading prebuilt shell v${version} (${name})`)
    const expected = (await download(`${base}/${name}.sha256`)).toString('utf8').trim().split(/\s+/)[0].toLowerCase()
    const binary = await download(`${base}/${name}`)
    const actual = createHash('sha256').update(binary).digest('hex')
    if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
      throw new Error(`checksum mismatch (expected ${expected}, got ${actual})`)
    }
    mkdirSync(dirname(cache), { recursive: true })
    writeFileSync(cache, binary)
    log(`native: release asset verified (${actual.slice(0, 12)}…)`)
    return installBinary(cache)
  } catch (error) {
    log(`native: prebuilt download unavailable (${error instanceof Error ? error.message : String(error)})`)
    return false
  }
}

async function buildNative() {
  const existing = shellBinaryPath()
  if (existsSync(existing)) {
    log(`native: skipped (already present: ${existing})`)
    return
  }
  if (process.env.COMMANDER_SKIP_NATIVE === '1') {
    log('native: skipped (COMMANDER_SKIP_NATIVE=1) — the plugin will fall back to the in-page overlay')
    return
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    log(`native: skipped (unsupported platform: ${process.platform})`)
    return
  }
  if (await fetchNativeBinary()) {
    log('native: prebuilt shell installed')
    return
  }
  const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
  if (cargo.status !== 0) {
    log('native: skipped (cargo not found) — the plugin will fall back to the in-page overlay')
    return
  }
  // 复用用户级 cargo 缓存；构建立即产出到插件状态目录，避免每次安装都冷编译。
  const env = {
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(homedir(), '.dsh', 'commander', 'native-build'),
  }
  log('native: building the Tauri shell (first run compiles dependencies and can take minutes)')
  run('native', 'bash', ['native/build.sh'], env, { fatal: false })
  if (!existsSync(shellBinaryPath())) {
    log('native: no shell binary produced — the plugin will fall back to the in-page overlay')
  }
}

async function main() {
  log(`preparing ${pkgRoot}`)
  buildJavaScript()
  await buildNative()
  log('done')
}

try {
  await main()
} catch (error) {
  console.error(`[dsh-commander:prepare] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
