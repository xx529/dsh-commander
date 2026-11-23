#!/usr/bin/env node
/**
 * scout 探针脚本：只读解析 DSH 会话日志 `session.vN.jsonl.zstd`。
 *
 * 背景（取自 @deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts）：
 * 会话日志是**多帧拼接的 Zstandard 容器**（每批写入一帧），Node 的
 * `zstdDecompressSync` 只解第一帧；DSH 自己用 scanZstdFrames + 逐帧解码读。
 * 本脚本用同一策略的独立实现（按 magic 0x28B52FFD 切候选帧、失败则并帧重试），
 * 让 devops 不依赖内部源码也能只读抽取会话事件。
 *
 * 用法：
 *   node read-session-log.mjs <session.vN.jsonl.zstd> [--events] [--jsonl]
 * 输出：默认打印结构摘要（事件类型计数、header 字段、user/assistant 消息条数），
 *       --jsonl 时逐行输出解码后的原始 JSON（谨慎：含用户内容）。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** 切出所有可能帧起点：magic 的位置 + 0。 */
function magicOffsets(buffer) {
  const offsets = [0]
  for (let i = 4; i + 4 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  return offsets
}

/** 贪心解码：从 start 起找最短能成功解码的候选终点，返回 {text, end}。 */
function decodeFrameAt(buffer, starts, index) {
  const start = starts[index]
  for (let j = index + 1; j <= starts.length; j += 1) {
    const end = j === starts.length ? buffer.length : starts[j]
    try {
      const decoded = zstdDecompressSync(buffer.subarray(start, end))
      return { decoded, end }
    } catch {
      // 该候选终点不完整（或切点落在压缩数据里），继续并帧
    }
  }
  return undefined
}

/** 解码整个多帧容器，返回 Buffer[]（每帧一段 JSONL 文本）。 */
export function decodeFrames(buffer) {
  const starts = magicOffsets(buffer)
  const out = []
  let index = 0
  while (index < starts.length) {
    const frame = decodeFrameAt(buffer, starts, index)
    if (frame === undefined) break
    out.push(frame.decoded)
    // 下一帧起点 = 本次终点在 starts 里的位置
    index = starts.findIndex(offset => offset >= frame.end)
    if (index < 0) break
  }
  return out
}

/** 解析成事件数组。 */
export function readSessionLog(path) {
  const frames = decodeFrames(readFileSync(path))
  const text = Buffer.concat(frames).toString('utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line))
}

const isMain = process.argv[1]?.endsWith('read-session-log.mjs')
if (isMain) {
  const file = process.argv[2]
  const wantEvents = process.argv.includes('--events')
  const wantJsonl = process.argv.includes('--jsonl')
  if (file === undefined) {
    process.stderr.write('usage: node read-session-log.mjs <session.vN.jsonl.zstd> [--events] [--jsonl]\n')
    process.exit(2)
  }
  const events = readSessionLog(file)
  if (wantJsonl) {
    for (const event of events) process.stdout.write(JSON.stringify(event) + '\n')
  } else {
    const header = events.find(event => event.type === 'session') ?? events[0]
    const types = {}
    for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1
    const summary = {
      file,
      events: events.length,
      header: header === undefined ? null : {
        type: header.type,
        version: header.version,
        id: header.id,
        createdAt: header.createdAt,
        cwd: header.cwd,
        origin: header.origin,
        agentPreset: header.agentPreset,
        parentSession: header.parentSession,
      },
      types,
      userMessages: events.filter(event => event.type === 'user/message' || event.role === 'user').length,
      assistantMessages: events.filter(event => event.type === 'assistant/message' || event.role === 'assistant').length,
    }
    if (wantEvents) summary.firstTypeSamples = [...new Set(events.map(event => event.type))].slice(0, 30)
    process.stdout.write(JSON.stringify(summary, undefined, 2) + '\n')
  }
}
