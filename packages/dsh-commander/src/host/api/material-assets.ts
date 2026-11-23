// 报告材料资产：本地图片的签名 URL + 只读字节读取。
// 安全：URL 只含 taskId/materialId + HMAC；不接收客户端路径，不服务非 image 材料。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename } from 'node:path'
import type { StoreSet } from '../store/index.ts'
import type { ReportMaterial } from '../schema.ts'
import { readLocalImage, sanitizeFilename } from '../materials.ts'

export interface MaterialAssetBytes {
  bytes: Buffer
  mime: string
  filename: string
}

export interface MaterialAssets {
  /** 详情接口用：本地图片返回签名绝对/相对 URL；远程/文档/无路径返回 undefined。 */
  url(taskId: string, material: ReportMaterial): string | undefined
  /** 资产路由用：校验签名 + 重新校验文件后返回图片字节。 */
  read(taskId: string, materialId: string, signature: string): Promise<MaterialAssetBytes | undefined>
}

export interface MaterialAssetsOptions {
  stores: StoreSet
  /** 例如 http://127.0.0.1:PORT；为空时返回相对 URL。 */
  origin?: () => string
}

export function createMaterialAssets(options: MaterialAssetsOptions): MaterialAssets {
  const secret = randomBytes(32)
  const sign = (taskId: string, materialId: string): string =>
    createHmac('sha256', secret).update(`${taskId}\u0000${materialId}`, 'utf8').digest('base64url').slice(0, 32)

  const signatureMatches = (actual: string, expected: string): boolean => {
    const a = Buffer.from(actual)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const materialsOf = (taskId: string): ReportMaterial[] => {
    const task = options.stores.tasks.get(taskId)
    if (task === undefined) return []
    return [
      ...(task.reportMaterials ?? []),
      ...(task.acceptanceHistory ?? []).flatMap((round) => round.materials ?? []),
    ]
  }

  return {
    url(taskId, material) {
      if (material.kind !== 'image' || material.path === undefined || material.state === 'too_large' || material.state === 'unsupported') return undefined
      const base = (options.origin?.() ?? '').replace(/\/+$/, '')
      const sig = sign(taskId, material.id)
      return `${base}/commander/tasks/${encodeURIComponent(taskId)}/materials/${encodeURIComponent(material.id)}?sig=${encodeURIComponent(sig)}`
    },

    async read(taskId, materialId, signature) {
      if (signature === '' || !signatureMatches(signature, sign(taskId, materialId))) return undefined
      const material = materialsOf(taskId).find((item) => item.id === materialId)
      if (material === undefined || material.kind !== 'image' || material.path === undefined) return undefined
      const image = await readLocalImage(material.path)
      if (image === undefined) return undefined
      return { bytes: image.bytes, mime: image.mime, filename: sanitizeFilename(basename(material.path)) }
    },
  }
}
