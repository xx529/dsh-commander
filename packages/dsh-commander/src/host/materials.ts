// 报告材料（方案 A）的路径/类型工具：只做本地文件校验与图片读取，不依赖 DSH 包。
// 安全边界：调用方必须给出允许根（任务工作区 + 本报告 present 过的 realpath）。
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { REPORT_IMAGE_MAX_BYTES, REPORT_MATERIAL_URL_MAX } from './config.ts'

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

export interface LocalFileInfo {
  /** realpath 后的绝对路径；后续只应使用它。 */
  realPath: string
  name: string
  bytes: number
  mime?: string
  image: boolean
}

export interface AllowedPathOptions {
  workspaceRoot?: string
  /** 本报告窗口内 present 过的 realpath 集合。 */
  presented: ReadonlySet<string>
}

export function mimeOfPath(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()]
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** 只接受 http(s)、无凭据的 URL；返回规范化字符串。 */
export function normalizeHttpUrl(raw: string): string | undefined {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || text.length > REPORT_MATERIAL_URL_MAX || /[\u0000-\u001f]/.test(text)) return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username !== '' || url.password !== '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** path 是否在 root 内（root/target 必须是规范化绝对路径）。 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** stat + realpath；不是普通文件返回 undefined。 */
export async function statLocalFile(path: string): Promise<LocalFileInfo | undefined> {
  try {
    const realPath = await realpath(path)
    const info = await stat(realPath)
    if (!info.isFile()) return undefined
    return {
      realPath,
      name: basename(realPath),
      bytes: info.size,
      ...(mimeOfPath(realPath) !== undefined ? { mime: mimeOfPath(realPath) as string } : {}),
      image: isImagePath(realPath),
    }
  } catch {
    return undefined
  }
}

/**
 * 把用户/模型给的路径解析成可记录的本地文件：
 * - 相对路径按 workspaceRoot 解析；
 * - 只允许工作区根内，或本报告 present 过的 realpath；
 * - 只接受普通文件。
 */
export async function resolveAllowedLocalPath(input: string, options: AllowedPathOptions): Promise<LocalFileInfo | undefined> {
  const text = String(input ?? '').trim()
  if (text.length === 0) return undefined
  let candidate: string
  if (isAbsolute(text)) candidate = text
  else if (options.workspaceRoot !== undefined && options.workspaceRoot !== '') candidate = resolve(options.workspaceRoot, text)
  else return undefined
  const info = await statLocalFile(candidate)
  if (info === undefined) return undefined
  const root = options.workspaceRoot === undefined || options.workspaceRoot === ''
    ? undefined
    : await realpath(options.workspaceRoot).catch(() => undefined)
  const inWorkspace = root !== undefined && isInside(root, info.realPath)
  if (!inWorkspace && !options.presented.has(info.realPath)) return undefined
  return info
}

function imageMimeFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString('ascii')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** 只读文件头确认图片格式/大小，不读整图（commander_task_report 校验用）。 */
export async function probeLocalImage(path: string): Promise<{ realPath: string; bytes: number; mime: string } | undefined> {
  const info = await statLocalFile(path)
  if (info === undefined || !info.image || info.bytes > REPORT_IMAGE_MAX_BYTES) return undefined
  try {
    const handle = await open(info.realPath, 'r')
    try {
      const head = Buffer.alloc(16)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      const mime = imageMimeFromBytes(head.subarray(0, bytesRead))
      if (mime === undefined) return undefined
      return { realPath: info.realPath, bytes: info.bytes, mime }
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** 读取本地图片（≤8MiB）；按魔数确认格式，失败返回 undefined。 */
export async function readLocalImage(path: string): Promise<{ bytes: Buffer; mime: string } | undefined> {
  const probe = await probeLocalImage(path)
  if (probe === undefined) return undefined
  try {
    const bytes = await readFile(probe.realPath)
    const mime = imageMimeFromBytes(bytes)
    if (mime === undefined) return undefined
    return { bytes, mime }
  } catch {
    return undefined
  }
}

/** HTTP 头里的 filename 安全化。 */
export function sanitizeFilename(name: string): string {
  const cleaned = String(name ?? '').replace(/[\r\n"\\/]/g, '_').trim()
  return cleaned === '' ? 'material' : cleaned.slice(0, 200)
}
