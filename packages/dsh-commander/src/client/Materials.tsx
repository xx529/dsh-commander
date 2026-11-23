// 方案 A：报告级「依据与材料」UI（图片缩略图 / 链接 / 文档 / 图片灯箱 / 文件动作单）。
// 只接收任务详情里的 ReportMaterialView；链接外开，文档先复制路径，图片走 Host 签名 imageUrl。
import * as React from 'react'
import type { ReactNode } from 'react'
import type { ReportMaterialView } from './types'
import { getShellBridge } from './shell-bridge'

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function materialImageSrc(material: ReportMaterialView): string | undefined {
  if (material.kind !== 'image') return undefined
  const src = material.imageUrl ?? material.url
  return src !== undefined && src !== '' ? src : undefined
}

export function isPreviewableImage(material: ReportMaterialView): boolean {
  return materialImageSrc(material) !== undefined && material.state !== 'too_large' && material.state !== 'unsupported'
}

export function openMaterialLink(url: string | undefined): void {
  if (url === undefined || url === '') return
  try {
    const bridge = getShellBridge()
    if (bridge.available) {
      void bridge.openExternal(url)
      return
    }
  } catch {
    // 浏览器/测试环境：走 window.open
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function copyMaterialText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 回退到 textarea
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function domainOf(url: string | undefined): string {
  if (url === undefined) return ''
  try {
    return new URL(url).hostname.replace(/^www\./u, '')
  } catch {
    return ''
  }
}

function sourceLabel(material: ReportMaterialView, t: Translate): string {
  if (material.source === 'presented') return t('board.drawer.materialSourcePresented')
  if (material.source === 'session') return t('board.drawer.materialSourceSession')
  return t('board.drawer.materialSourceCommander')
}

function materialMeta(material: ReportMaterialView, t: Translate): string {
  const source = sourceLabel(material, t)
  if (material.kind === 'link') {
    const domain = domainOf(material.url)
    return [source, domain, t('board.drawer.materialExternal')].filter((part) => part !== '').join(' · ')
  }
  if (material.state === 'too_large') return `${source} · ${t('board.drawer.materialTooLarge')}`
  if (material.state === 'unsupported') return `${source} · ${t('board.drawer.materialUnsupported')}`
  if (material.state === 'missing') return `${source} · ${t('board.drawer.materialMissing')}`
  const type = material.path?.split('.').at(-1)?.toUpperCase()
    ?? material.meta?.mime?.split('/').at(-1)?.toUpperCase()
    ?? ''
  const size = formatBytes(material.meta?.bytes)
  return [source, type, size].filter((part) => part !== '').join(' · ')
}

function MaterialIcon({ kind }: { kind: 'link' | 'file' | 'image' | 'external' | 'more' | 'copy' | 'close' | 'prev' | 'next' | 'chevron' }): ReactNode {
  const common = { width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (kind === 'link') {
    return <svg viewBox="0 0 24 24" {...common}><path d="M10.2 13.8a3.2 3.2 0 0 1 0-4.5l2.5-2.5a3.2 3.2 0 0 1 4.5 4.5l-1.4 1.4" /><path d="M13.8 10.2a3.2 3.2 0 0 1 0 4.5l-2.5 2.5a3.2 3.2 0 0 1-4.5-4.5l1.4-1.4" /></svg>
  }
  if (kind === 'file') {
    return <svg viewBox="0 0 24 24" {...common}><path d="M6.5 3.5h7l4 4v13h-11z" /><path d="M13.5 3.5v4h4" /></svg>
  }
  if (kind === 'image') {
    return <svg viewBox="0 0 24 24" {...common}><rect x="3.5" y="4.5" width="17" height="15" rx="2.4" /><circle cx="9" cy="9.4" r="1.3" /><path d="m5.4 17 4.2-4.2 2.8 2.8 2.4-2.4 3.8 3.8" /></svg>
  }
  if (kind === 'external') {
    return <svg viewBox="0 0 24 24" {...common}><path d="M14 4.8h5.2V10M19 5 11.2 12.8" /><path d="M18.6 14.2v3.6a2.2 2.2 0 0 1-2.2 2.2H5.8a2.2 2.2 0 0 1-2.2-2.2V7.2A2.2 2.2 0 0 1 5.8 5h3.6" /></svg>
  }
  if (kind === 'more') {
    return <svg viewBox="0 0 24 24" width={13} height={13} fill="currentColor" aria-hidden><circle cx="5.6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18.4" cy="12" r="1.4" /></svg>
  }
  if (kind === 'copy') {
    return <svg viewBox="0 0 24 24" {...common}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>
  }
  if (kind === 'close') {
    return <svg viewBox="0 0 24 24" {...common}><path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" /></svg>
  }
  if (kind === 'prev') {
    return <svg viewBox="0 0 24 24" {...common}><path d="m9.2 5.8 6.2 6.2-6.2 6.2" transform="rotate(180 12 12)" /></svg>
  }
  return <svg viewBox="0 0 24 24" {...common}><path d="m5.8 9.2 6.2 6.2 6.2-6.2" /></svg>
}

function materialKindOf(material: ReportMaterialView): 'link' | 'file' | 'image' {
  if (material.kind === 'image') {
    return isPreviewableImage(material) ? 'image' : 'file'
  }
  if (material.kind === 'link') return 'link'
  return 'file'
}

function MaterialRow({ material, t, onOpen }: { material: ReportMaterialView; t: Translate; onOpen: (material: ReportMaterialView) => void }): ReactNode {
  const kind = materialKindOf(material)
  return (
    <li>
      <button type="button" className="dshc-d-mat-row" onClick={() => { onOpen(material) }}>
        <span className="dshc-d-mat-icon" data-kind={kind}> <MaterialIcon kind={kind} /> </span>
        <span className="dshc-d-mat-main">
          <b>{material.title ?? t('board.drawer.materials')}</b>
          <small>{materialMeta(material, t)}</small>
        </span>
        <span className="dshc-d-mat-trail">
          {kind === 'link' ? <MaterialIcon kind="external" /> : <MaterialIcon kind="more" />}
        </span>
      </button>
    </li>
  )
}

export function MaterialsSection({ materials, t, sectionRef, onOpen }: {
  materials: readonly ReportMaterialView[]
  t: Translate
  sectionRef?: React.Ref<HTMLDivElement>
  onOpen: (material: ReportMaterialView) => void
}): ReactNode {
  const [collapsed, setCollapsed] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  if (materials.length === 0) return null
  const images = materials.filter(isPreviewableImage)
  const rows = materials.filter((material) => !isPreviewableImage(material))
  const visibleImages = expanded ? images : images.slice(0, 2)
  const visibleRows = expanded ? rows : rows.slice(0, 3)
  const hiddenCount = materials.length - visibleImages.length - visibleRows.length
  const linkCount = materials.filter((material) => material.kind === 'link').length
  const fileCount = materials.filter((material) => material.kind === 'file').length
  const imageCount = materials.filter((material) => material.kind === 'image').length
  const summary = [
    imageCount > 0 ? t('board.drawer.materialsImages', { count: String(imageCount) }) : '',
    linkCount > 0 ? t('board.drawer.materialsLinks', { count: String(linkCount) }) : '',
    fileCount > 0 ? t('board.drawer.materialsFiles', { count: String(fileCount) }) : '',
  ].filter((part) => part !== '').join(' · ')
  return (
    <div className="dshc-d-mat" ref={sectionRef}>
      <header className="dshc-d-mat-head">
        <span className="dshc-d-mat-title">{t('board.drawer.materials')}</span>
        <span className="dshc-d-mat-count">{String(materials.length)}</span>
        <span className="dshc-d-mat-sum">{summary}</span>
        <button type="button" className="dshc-d-link dshc-d-mat-toggle" onClick={() => { setCollapsed((value) => !value) }}>
          {collapsed ? t('board.drawer.expand') : t('board.drawer.collapse')}
        </button>
      </header>
      {collapsed ? null : (
        <div className="dshc-d-mat-body">
          {visibleImages.length === 0 ? null : (
            <div className="dshc-d-mat-gallery" data-count={String(visibleImages.length)}>
              {visibleImages.map((material) => {
                const src = materialImageSrc(material)
                return (
                  <button
                    type="button"
                    className="dshc-d-mat-shot"
                    key={material.id ?? src}
                    onClick={() => { onOpen(material) }}
                    aria-label={`${t('board.drawer.materialPreview')}: ${material.title ?? ''}`}
                  >
                    <span className="dshc-d-mat-shot-img">
                      {src === undefined ? null : <img src={src} alt={material.title ?? ''} loading="lazy" referrerPolicy="no-referrer" />}
                      <span className="dshc-d-mat-shot-zoom"><MaterialIcon kind="external" /></span>
                    </span>
                    <span className="dshc-d-mat-shot-cap">
                      <b>{material.title ?? t('board.drawer.materials')}</b>
                      <small>{sourceLabel(material, t)}</small>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {visibleRows.length === 0 ? null : (
            <ul className="dshc-d-mat-list">
              {visibleRows.map((material) => <MaterialRow key={material.id} material={material} t={t} onOpen={onOpen} />)}
            </ul>
          )}
          {hiddenCount > 0 || expanded ? (
            <button type="button" className="dshc-d-mat-more" onClick={() => { setExpanded((value) => !value) }}>
              {expanded ? t('board.drawer.collapse') : t('board.drawer.materialsOpenAll', { count: String(materials.length) })}
              <MaterialIcon kind="chevron" />
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function AcceptanceMaterialChips({ materials, acceptanceId, t, onOpen }: {
  materials: readonly ReportMaterialView[]
  acceptanceId: string | undefined
  t: Translate
  onOpen: (material: ReportMaterialView) => void
}): ReactNode {
  if (acceptanceId === undefined) return null
  const linked = materials.filter((material) => material.acceptanceIds?.includes(acceptanceId) === true)
  if (linked.length === 0) return null
  const visible = linked.slice(0, 2)
  const hidden = linked.length - visible.length
  return (
    <span className="dshc-d-mat-chips">
      {visible.map((material) => {
        const kind = materialKindOf(material)
        return (
          <button type="button" className="dshc-d-mat-chip" key={material.id} onClick={() => { onOpen(material) }}>
            <MaterialIcon kind={kind} />
            {material.title ?? t('board.drawer.materials')}
          </button>
        )
      })}
      {hidden > 0 ? <span className="dshc-d-mat-chip-more">{`+${String(hidden)}`}</span> : null}
    </span>
  )
}

export function MaterialLightbox({ images, index, t, onChange, onClose }: {
  images: readonly ReportMaterialView[]
  index: number
  t: Translate
  onChange: (index: number) => void
  onClose: () => void
}): ReactNode {
  const [copied, setCopied] = React.useState(false)
  const material = images[index]
  const src = material === undefined ? undefined : materialImageSrc(material)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'ArrowLeft' && images.length > 1) onChange((index - 1 + images.length) % images.length)
      if (event.key === 'ArrowRight' && images.length > 1) onChange((index + 1) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [images.length, index, onChange, onClose])
  if (material === undefined || src === undefined) return null
  const path = material.path ?? material.url ?? ''
  return (
    <div className="dshc-d-lb" role="dialog" aria-modal="true" aria-label={t('board.drawer.materialPreview')}>
      <button type="button" className="dshc-d-lb-scrim" aria-label={t('board.drawer.materialClose')} onClick={onClose} />
      <div className="dshc-d-lb-card">
        <header className="dshc-d-lb-head">
          <span className="dshc-d-lb-count">{`${String(index + 1)} / ${String(images.length)}`}</span>
          <span className="dshc-d-lb-kicker">{t('board.drawer.materialPreview')}</span>
          <button type="button" className="dshc-d-lb-close" onClick={onClose} aria-label={t('board.drawer.materialClose')}><MaterialIcon kind="close" /></button>
        </header>
        <div className="dshc-d-lb-stage">
          {images.length <= 1 ? null : (
            <button type="button" className="dshc-d-lb-nav prev" onClick={() => { onChange((index - 1 + images.length) % images.length) }} aria-label={t('board.drawer.materialPrev')}>
              <MaterialIcon kind="prev" />
            </button>
          )}
          <img src={src} alt={material.title ?? ''} />
          {images.length <= 1 ? null : (
            <button type="button" className="dshc-d-lb-nav next" onClick={() => { onChange((index + 1) % images.length) }} aria-label={t('board.drawer.materialNext')}>
              <MaterialIcon kind="next" />
            </button>
          )}
        </div>
        <footer className="dshc-d-lb-foot">
          <div className="dshc-d-lb-copy">
            <b>{material.title ?? t('board.drawer.materials')}</b>
            <small>{materialMeta(material, t)}</small>
          </div>
          <div className="dshc-d-lb-actions">
            <button type="button" className="dshc-d-lb-btn" onClick={() => { void copyMaterialText(path).then((ok) => { setCopied(ok) }) }}>
              <MaterialIcon kind="copy" />{copied ? t('board.drawer.materialCopied') : t('board.drawer.materialCopyPath')}
            </button>
            <button type="button" className="dshc-d-lb-btn primary" onClick={onClose}>{t('board.drawer.materialClose')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}

export function MaterialFileSheet({ material, t, onClose }: { material: ReportMaterialView; t: Translate; onClose: () => void }): ReactNode {
  const [copied, setCopied] = React.useState(false)
  const path = material.path ?? material.url ?? ''
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div className="dshc-d-fs" role="dialog" aria-modal="true" aria-label={material.title ?? t('board.drawer.materials')}>
      <button type="button" className="dshc-d-fs-scrim" aria-label={t('board.drawer.materialClose')} onClick={onClose} />
      <div className="dshc-d-fs-card">
        <span className="dshc-d-fs-grip" aria-hidden />
        <header className="dshc-d-fs-head">
          <span className="dshc-d-mat-icon" data-kind="file"><MaterialIcon kind="file" /></span>
          <span className="dshc-d-fs-main">
            <b>{material.title ?? t('board.drawer.materials')}</b>
            <small>{materialMeta(material, t)}</small>
          </span>
          <button type="button" className="dshc-d-lb-close" onClick={onClose} aria-label={t('board.drawer.materialClose')}><MaterialIcon kind="close" /></button>
        </header>
        <div className="dshc-d-fs-path">{path === '' ? '—' : path}</div>
        <div className="dshc-d-fs-actions">
          <button type="button" className="dshc-d-fs-btn" onClick={() => { void copyMaterialText(path).then((ok) => { setCopied(ok) }) }}>
            <MaterialIcon kind="copy" />{copied ? t('board.drawer.materialCopied') : t('board.drawer.materialCopyPath')}
          </button>
          <button type="button" className="dshc-d-fs-btn primary" onClick={onClose}>{t('board.drawer.materialClose')}</button>
        </div>
        <p className="dshc-d-fs-note">{t('board.drawer.materialFileHint')}</p>
      </div>
    </div>
  )
}
