// commander_task_report 的材料构建：显式 materials + 会话事件 deliverables/presented 自动归并。
// 只做校验/去重/上限；不做远程抓取，不读文档内容，不存文件字节。
import { basename } from 'node:path'
import {
  REPORT_FILE_MAX_BYTES,
  REPORT_IMAGE_MAX_BYTES,
  REPORT_MATERIALS_MAX,
  REPORT_SESSION_MATERIALS_MAX,
  REPORT_MATERIAL_DESCRIPTION_MAX,
  REPORT_MATERIAL_PATH_MAX,
  REPORT_MATERIAL_TITLE_MAX,
  REPORT_MATERIAL_URL_MAX,
  REPORT_MATERIAL_WARNINGS_MAX,
} from './config.ts'
import type { AcceptanceItem, ReportMaterial, ReportMaterialKind } from './schema.ts'
import { isImagePath, normalizeHttpUrl, probeLocalImage, resolveAllowedLocalPath, statLocalFile } from './materials.ts'
import { createId } from './store/base.ts'

export interface ReportEventLike {
  seq?: unknown
  type?: unknown
  data?: unknown
}

export interface BuildReportMaterialsInput {
  events: readonly ReportEventLike[]
  seqFrom: number
  seqTo: number
  sessionId: string
  workspaceRoot?: string
  rawMaterials: readonly unknown[]
  /** 本次 commander_task_report 生成的验收项；materials[].acceptanceIndex 映射用。 */
  acceptance: readonly AcceptanceItem[]
}

export interface BuildReportMaterialsResult {
  materials: ReportMaterial[]
  warnings: string[]
}

interface PresentedCandidate {
  realPath: string
  name: string
  bytes: number
  image: boolean
  description?: string
  seq?: number
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const asInt = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined)

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length < REPORT_MATERIAL_WARNINGS_MAX) warnings.push(message)
}

function clipText(value: string, max: number, warnings: string[], field: string): string {
  if (value.length <= max) return value
  pushWarning(warnings, `${field} 超过 ${max} 字符，已截断`)
  return value.slice(0, max)
}

function kindOf(value: unknown): ReportMaterialKind | undefined {
  return value === 'link' || value === 'file' || value === 'image' ? value : undefined
}

function materialState(bytes: number, kind: ReportMaterialKind): ReportMaterial['state'] {
  if (kind === 'image' && bytes > REPORT_IMAGE_MAX_BYTES) return 'too_large'
  if (kind === 'file' && bytes > REPORT_FILE_MAX_BYTES) return 'too_large'
  return 'ok'
}

async function collectPresented(input: BuildReportMaterialsInput, warnings: string[]): Promise<{ candidates: PresentedCandidate[]; realPaths: Set<string> }> {
  const candidates: PresentedCandidate[] = []
  const realPaths = new Set<string>()
  for (const event of input.events) {
    if (event.type !== 'deliverables/presented') continue
    const seq = asInt(event.seq)
    if (seq !== undefined && (seq < input.seqFrom || seq > input.seqTo)) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const files = Array.isArray(data.files) ? data.files : []
    for (const raw of files) {
      const record = (raw ?? {}) as Record<string, unknown>
      const path = asString(record.path)
      if (path === undefined) continue
      const info = await statLocalFile(path)
      if (info === undefined) {
        pushWarning(warnings, `present 文件不可读，已跳过：${path}`)
        continue
      }
      realPaths.add(info.realPath)
      candidates.push({
        realPath: info.realPath,
        name: info.name,
        bytes: info.bytes,
        image: info.image,
        ...(asString(record.description) !== undefined ? { description: asString(record.description) as string } : {}),
        ...(seq !== undefined ? { seq } : {}),
      })
    }
  }
  return { candidates, realPaths }
}

function assistantTextOf(event: ReportEventLike): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  const message = (data.message ?? {}) as Record<string, unknown>
  const content = Array.isArray(message.content) ? message.content : Array.isArray(data.content) ? data.content : []
  const parts: string[] = []
  for (const block of content) {
    const record = (block ?? {}) as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

function lastAssistantReply(events: readonly ReportEventLike[], seqFrom: number, seqTo: number): { text: string; seq?: number } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const seq = asInt(event.seq)
    if (seq !== undefined && (seq < seqFrom || seq > seqTo)) continue
    const text = assistantTextOf(event)
    if (text === '') continue
    return { text, ...(seq !== undefined ? { seq } : {}) }
  }
  return undefined
}

function cleanLabel(value: string): string {
  return value
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./u, '') } catch { return 'link' }
}

/** 裸 URL 末尾常跟句号/括号/中文标点；循环剥掉，避免 new URL 把 `。` 编码进路径。 */
function trimBareUrlTrailingPunctuation(value: string): string {
  const trailing = /[)\]}>,.;:!?。，、；：！？）】》”’]+$/u
  let text = value
  while (trailing.test(text)) text = text.replace(trailing, '')
  return text
}

function isLocalUrlHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1'
  } catch {
    return false
  }
}

/**
 * 从工作会话最后一条 assistant 文本里抓 Markdown 图片 / 链接 / 裸 URL。
 * 只抓 HTTP(S) 链接和图片；本地文档仍以 present/显式材料为准，避免把「产出与证据」里的一堆路径全刷进材料区。
 */
async function collectSessionMaterials(input: BuildReportMaterialsInput, warnings: string[]): Promise<ReportMaterial[]> {
  const reply = lastAssistantReply(input.events, input.seqFrom, input.seqTo)
  if (reply === undefined) return []
  const withoutCode = reply.text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
  const materials: ReportMaterial[] = []
  const seen = new Set<string>()
  const push = (material: ReportMaterial): void => {
    if (materials.length >= REPORT_SESSION_MATERIALS_MAX) return
    const key = material.url !== undefined ? `url:${material.url}` : `path:${material.path ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    materials.push(material)
  }
  const derivedFrom = { sessionId: input.sessionId, seq: reply.seq ?? input.seqTo }

  const imagePattern = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g
  const imageSpans: Array<[number, number]> = []
  for (const match of withoutCode.matchAll(imagePattern)) {
    if (match.index !== undefined) imageSpans.push([match.index, match.index + match[0].length])
    const target = (match[2] ?? '').replace(/^<|>$/g, '').trim()
    const label = cleanLabel(match[1] ?? '')
    if (target === '') continue
    const url = normalizeHttpUrl(target)
    if (url !== undefined) {
      if (isLocalUrlHost(url)) continue
      push({
        id: createId('mat'),
        kind: 'image',
        title: clipText(label === '' ? hostnameOf(url) : label, REPORT_MATERIAL_TITLE_MAX, warnings, 'session.image.title'),
        url,
        source: 'session',
        derivedFrom,
        state: 'unverified',
      })
      continue
    }
    // 本地图片：只接受工作区内/本报告 present 过的真实图片。
    const info = await resolveAllowedLocalPath(target, {
      ...(input.workspaceRoot !== undefined && input.workspaceRoot !== '' ? { workspaceRoot: input.workspaceRoot } : {}),
      presented: new Set(),
    })
    if (info === undefined) continue
    const probe = await probeLocalImage(info.realPath)
    if (probe === undefined) continue
    push({
      id: createId('mat'),
      kind: 'image',
      title: clipText(label === '' ? info.name : label, REPORT_MATERIAL_TITLE_MAX, warnings, 'session.image.title'),
      path: probe.realPath,
      source: 'session',
      derivedFrom,
      state: 'ok',
      meta: { mime: probe.mime, bytes: probe.bytes },
    })
  }

  // 去掉图片后再抓链接，避免同一 URL 被重复计入。
  let withoutImages = withoutCode
  for (const [start, end] of imageSpans.reverse()) withoutImages = withoutImages.slice(0, start) + ' ' + withoutImages.slice(end)
  const linkPattern = /\[([^\]]+)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g
  const linkSpans: Array<[number, number]> = []
  for (const match of withoutImages.matchAll(linkPattern)) {
    if (match.index !== undefined) linkSpans.push([match.index, match.index + match[0].length])
    const target = (match[2] ?? '').replace(/^<|>$/g, '').trim()
    const url = normalizeHttpUrl(target)
    if (url === undefined || isLocalUrlHost(url)) continue
    const label = cleanLabel(match[1] ?? '')
    push({
      id: createId('mat'),
      kind: 'link',
      title: clipText(label === '' ? hostnameOf(url) : label, REPORT_MATERIAL_TITLE_MAX, warnings, 'session.link.title'),
      url,
      source: 'session',
      derivedFrom,
      state: 'unverified',
    })
  }

  // 裸 URL 只在 Markdown 链接之外抓：否则 `[label](url)、[next](url)` 会把 `)、[next` 吃进 URL。
  let withoutLinks = withoutImages
  for (const [start, end] of linkSpans.reverse()) withoutLinks = withoutLinks.slice(0, start) + ' ' + withoutLinks.slice(end)
  const barePattern = /\bhttps?:\/\/[^\s<>"'`\[\]()（）【】《》、，。；：！？“”‘’]+/gi
  for (const match of withoutLinks.matchAll(barePattern)) {
    const cleaned = trimBareUrlTrailingPunctuation(match[0] ?? '')
    const url = normalizeHttpUrl(cleaned)
    if (url === undefined || isLocalUrlHost(url)) continue
    push({
      id: createId('mat'),
      kind: 'link',
      title: clipText(hostnameOf(url), REPORT_MATERIAL_TITLE_MAX, warnings, 'session.link.title'),
      url,
      source: 'session',
      derivedFrom,
      state: 'unverified',
    })
  }
  return materials
}

function addMaterial(
  map: Map<string, ReportMaterial>,
  material: ReportMaterial,
  warnings: string[],
): void {
  const key = material.url !== undefined ? `url:${material.url}` : `path:${material.path ?? ''}`
  const existing = map.get(key)
  if (existing !== undefined) {
    // 显式材料优先；present 重复时把 acceptanceIds 合并到已有材料。
    if (material.acceptanceIds !== undefined && material.acceptanceIds.length > 0) {
      const merged = new Set([...(existing.acceptanceIds ?? []), ...material.acceptanceIds])
      existing.acceptanceIds = [...merged]
    }
    return
  }
  if (map.size >= REPORT_MATERIALS_MAX) {
    pushWarning(warnings, `材料超过 ${REPORT_MATERIALS_MAX} 项，已截断`)
    return
  }
  map.set(key, material)
}

export async function buildReportMaterials(input: BuildReportMaterialsInput): Promise<BuildReportMaterialsResult> {
  const warnings: string[] = []
  const materials = new Map<string, ReportMaterial>()
  const presented = await collectPresented(input, warnings)
  const rawMaterials = input.rawMaterials.slice(0, REPORT_MATERIALS_MAX + 8)
  if (input.rawMaterials.length > rawMaterials.length) {
    pushWarning(warnings, `materials 超过 ${rawMaterials.length} 项，已截断`)
  }

  for (let index = 0; index < rawMaterials.length; index += 1) {
    const record = (rawMaterials[index] ?? {}) as Record<string, unknown>
    const kind = kindOf(record.kind)
    if (kind === undefined) {
      pushWarning(warnings, `materials[${String(index)}] kind 必须是 link|file|image`)
      continue
    }
    const titleInput = asString(record.title)
    const urlInput = asString(record.url)
    const pathInput = asString(record.path)
    const description = asString(record.description)
    const acceptanceIndex = asInt(record.acceptanceIndex)
    const derivedSeq = asInt(record.derivedFromSeq) ?? input.seqTo
    const acceptanceIds = acceptanceIndex === undefined
      ? undefined
      : input.acceptance[acceptanceIndex] === undefined
        ? (() => { pushWarning(warnings, `materials[${String(index)}] acceptanceIndex 越界，已忽略关联`); return undefined })()
        : [input.acceptance[acceptanceIndex]?.id as string]
    let fallbackTitle = 'material'
    if (pathInput !== undefined) fallbackTitle = basename(pathInput)
    else if (urlInput !== undefined) {
      try { fallbackTitle = new URL(urlInput).hostname } catch { fallbackTitle = 'material' }
    }
    let title = titleInput === undefined ? fallbackTitle : titleInput
    title = clipText(title, REPORT_MATERIAL_TITLE_MAX, warnings, `materials[${String(index)}].title`)
    const common = {
      id: createId('mat'),
      kind,
      title,
      ...(description !== undefined ? { description: clipText(description, REPORT_MATERIAL_DESCRIPTION_MAX, warnings, `materials[${String(index)}].description`) } : {}),
      source: 'commander' as const,
      ...(acceptanceIds !== undefined && acceptanceIds.length > 0 ? { acceptanceIds } : {}),
      derivedFrom: { sessionId: input.sessionId, seq: derivedSeq },
    }

    if (kind === 'link') {
      if (urlInput === undefined) {
        pushWarning(warnings, `materials[${String(index)}] link 缺少 url，已跳过`)
        continue
      }
      if (urlInput.length > REPORT_MATERIAL_URL_MAX) {
        pushWarning(warnings, `materials[${String(index)}] url 过长，已跳过`)
        continue
      }
      const url = normalizeHttpUrl(urlInput)
      if (url === undefined) {
        pushWarning(warnings, `materials[${String(index)}] url 不是 http(s)，已跳过`)
        continue
      }
      addMaterial(materials, { ...common, url, state: 'unverified' }, warnings)
      continue
    }

    if (kind === 'image' && urlInput !== undefined) {
      const url = normalizeHttpUrl(urlInput)
      if (url === undefined) {
        pushWarning(warnings, `materials[${String(index)}] 图片 url 不是 http(s)，已跳过`)
        continue
      }
      addMaterial(materials, { ...common, url, state: 'unverified' }, warnings)
      continue
    }

    if (pathInput === undefined) {
      pushWarning(warnings, `materials[${String(index)}] ${kind} 缺少 path，已跳过`)
      continue
    }
    if (pathInput.length > REPORT_MATERIAL_PATH_MAX) {
      pushWarning(warnings, `materials[${String(index)}] path 过长，已跳过`)
      continue
    }
    const info = await resolveAllowedLocalPath(pathInput, {
      ...(input.workspaceRoot !== undefined && input.workspaceRoot !== '' ? { workspaceRoot: input.workspaceRoot } : {}),
      presented: presented.realPaths,
    })
    if (info === undefined) {
      pushWarning(warnings, `materials[${String(index)}] 文件不存在、不是普通文件或不在允许范围：${pathInput}`)
      continue
    }
    const state = materialState(info.bytes, kind)
    if (kind === 'image' && state === 'ok') {
      const probe = await probeLocalImage(info.realPath)
      if (probe === undefined) {
        pushWarning(warnings, `materials[${String(index)}] 不是支持的 PNG/JPEG/WebP/GIF 图片，已跳过：${pathInput}`)
        continue
      }
      addMaterial(materials, {
        ...common,
        path: probe.realPath,
        state: 'ok',
        meta: { mime: probe.mime, bytes: probe.bytes },
      }, warnings)
      continue
    }
    addMaterial(materials, {
      ...common,
      path: info.realPath,
      state,
      meta: { ...(info.mime !== undefined ? { mime: info.mime } : {}), bytes: info.bytes },
    }, warnings)
  }

  // present 自动归并：显式材料优先；同一 realpath 已在显式材料里时只合并 acceptanceIds。
  for (const candidate of presented.candidates) {
    const kind: ReportMaterialKind = candidate.image ? 'image' : 'file'
    addMaterial(materials, {
      id: createId('mat'),
      kind,
      title: clipText(candidate.name, REPORT_MATERIAL_TITLE_MAX, warnings, 'presented.title'),
      path: candidate.realPath,
      ...(candidate.description !== undefined
        ? { description: clipText(candidate.description, REPORT_MATERIAL_DESCRIPTION_MAX, warnings, 'presented.description') }
        : {}),
      source: 'presented',
      ...(candidate.seq !== undefined ? { derivedFrom: { sessionId: input.sessionId, seq: candidate.seq } } : {}),
      state: materialState(candidate.bytes, kind),
      meta: { bytes: candidate.bytes },
    }, warnings)
  }

  const sessionMaterials = await collectSessionMaterials(input, warnings)
  for (const material of sessionMaterials) addMaterial(materials, material, warnings)

  return { materials: [...materials.values()], warnings }
}
