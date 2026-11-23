// 只读解析 DSH 会话日志 `session.vN.jsonl.zstd`（多帧拼接 zstd + JSONL）。
//
// 来源与算法：与 `docs/research/probes/read-session-log.mjs`（scout 探针）同一实现，
// 复制到 tools/ 下是为了让评估工具自包含、不依赖 docs/research/ 的后续改动。
// 背景：DSH 会话日志是多帧 Zstandard 容器（每批写入一帧），Node 的
// `zstdDecompressSync` 只解第一帧；DSH 自己用 scanZstdFrames + 逐帧解码读
// （A/dsh-session-persistence-jsonl/src/zstd.ts）。这里按 magic 0x28B52FFD
// 切候选帧、失败则并帧重试，等价复刻。
//
// 隐私：本模块只返回事件数组，不做任何打印；调用方负责“不把正文写进报告”。
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

/** 贪心解码：从 start 起找最短能成功解码的候选终点，返回 {decoded, end}。 */
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
    index = starts.findIndex((offset) => offset >= frame.end)
    if (index < 0) break
  }
  return out
}

/** 解析成事件数组。 */
export function readSessionLog(path) {
  const frames = decodeFrames(readFileSync(path))
  const text = Buffer.concat(frames).toString('utf8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

/** 从 user/message 事件提取纯文本（忽略图片等非文本 part）。 */
export function userMessageText(event) {
  const parts = event?.data?.content
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}
