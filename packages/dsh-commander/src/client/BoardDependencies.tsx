/**
 * Board dependency affordances (2026-11-24 design): the card gate answers
 * "how many prerequisites are left", and the SVG overlay draws the chain while
 * a card is hovered or its drawer is open. Read-only: no state writes.
 */
import * as React from 'react'
import type { ReactNode } from 'react'
import { dependencyClosure, dependencyEdgePath, statusLabelKey } from './board'
import type { BoardCardBox } from './board'
import type { TaskView } from './types'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Collapsible prerequisite list shown on every card that has dependencies. */
export function DependencyGate({
  task, taskById, t, expanded, onToggle,
}: {
  task: TaskView
  taskById: ReadonlyMap<string, TaskView>
  t: Translate
  expanded: boolean
  onToggle: () => void
}): ReactNode {
  const deps = task.dependsOn ?? []
  const waiting = new Set(task.waitingFor ?? [])
  const waitingCount = deps.filter((id) => waiting.has(id)).length
  const doneCount = deps.length - waitingCount
  const ready = waitingCount === 0
  const pct = deps.length === 0 ? 0 : Math.round((doneCount / deps.length) * 100)
  const ordered = [...deps].sort((a, b) => Number(waiting.has(b)) - Number(waiting.has(a)))
  if (deps.length === 0) return null
  return (
    <div className="dshc-dep-gate" data-ready={ready} data-empty="false">
      <div className="dshc-dep-gate-head">
        <span className="dshc-dep-gate-label">{t('board.card.prereq', { done: doneCount, total: deps.length })}</span>
        <span className="dshc-dep-gate-bar" aria-hidden="true"><i style={{ width: `${String(pct)}%` }} /></span>
        <span className="dshc-dep-gate-state" data-ready={ready}>
          {ready ? t('board.card.depsReady') : t('board.card.remaining', { n: waitingCount })}
        </span>
        <button
          type="button"
          className="dshc-dep-gate-toggle"
          aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); onToggle() }}
        >
          {expanded ? t('board.card.collapseDeps') : t('board.card.expandDeps')}
        </button>
      </div>
      {expanded ? (
        <ul className="dshc-dep-gate-list" data-expanded="true">
          {ordered.map((id) => {
            const dep = taskById.get(id)
            const ok = !waiting.has(id)
            return (
              <li key={id} data-ok={ok} data-status={dep?.status ?? 'archived'}>
                <i className="dshc-dep-dot" data-status={dep?.status ?? 'archived'} aria-hidden="true" />
                <span className="dshc-dep-title">{dep?.title ?? id}</span>
                <em>{dep === undefined ? t('task.status.archived') : t(statusLabelKey(dep.status))}</em>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

interface Edge {
  key: string
  d: string
  state: 'waiting' | 'ready'
}

/**
 * Transient dependency edges over the columns. Coordinates are measured from
 * the wrapper so column-internal scrolling and window resizes stay aligned.
 */
export function DependencyOverlay({
  tasks, activeTaskId, wrapRef, layoutKey,
}: {
  tasks: readonly TaskView[]
  activeTaskId: string | null
  wrapRef: React.RefObject<HTMLDivElement | null>
  layoutKey: string
}): ReactNode {
  const svgRef = React.useRef<SVGSVGElement | null>(null)
  const [edges, setEdges] = React.useState<Edge[]>([])
  const [size, setSize] = React.useState<{ width: number; height: number }>({ width: 0, height: 0 })

  const draw = React.useCallback((): void => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const width = wrap.clientWidth
    const height = wrap.clientHeight
    if (activeTaskId === null || width === 0 || height === 0) {
      setEdges([])
      setSize({ width, height })
      return
    }
    const chain = dependencyClosure(tasks, activeTaskId)
    const base = wrap.getBoundingClientRect()
    const boxes = new Map<string, BoardCardBox>()
    wrap.querySelectorAll<HTMLElement>('[data-task-id]').forEach((element) => {
      const id = element.dataset.taskId
      if (id === undefined || !chain.has(id)) return
      const rect = element.getBoundingClientRect()
      boxes.set(id, {
        left: rect.left - base.left,
        right: rect.right - base.left,
        top: rect.top - base.top,
        bottom: rect.bottom - base.top,
      })
    })
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const next: Edge[] = []
    for (const task of tasks) {
      if (!chain.has(task.id)) continue
      for (const depId of task.dependsOn ?? []) {
        if (!chain.has(depId)) continue
        const from = boxes.get(depId)
        const to = boxes.get(task.id)
        if (from === undefined || to === undefined) continue
        next.push({
          key: `${depId}->${task.id}`,
          d: dependencyEdgePath(from, to),
          state: byId.get(depId)?.status === 'done' ? 'ready' : 'waiting',
        })
      }
    }
    setEdges(next)
    setSize({ width, height })
  }, [activeTaskId, tasks, wrapRef])

  React.useLayoutEffect(() => { draw() }, [draw, layoutKey])

  React.useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return undefined
    let frame = 0
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { draw(); return }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    }
    const targets: Element[] = [wrap, ...Array.from(wrap.querySelectorAll('.dshc-board-columns, .dshc-board-column-body'))]
    targets.forEach((element) => element.addEventListener('scroll', schedule, { passive: true }))
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(wrap)
    return () => {
      targets.forEach((element) => element.removeEventListener('scroll', schedule))
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [draw, wrapRef])

  return (
    <svg
      ref={svgRef}
      className="dshc-deps-layer"
      aria-hidden="true"
      width={size.width === 0 ? undefined : size.width}
      height={size.height === 0 ? undefined : size.height}
      viewBox={`0 0 ${String(Math.max(size.width, 1))} ${String(Math.max(size.height, 1))}`}
    >
      <defs>
        <marker id="dshc-dep-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 8 4 0 8z" fill="var(--dsw-alias-state-warn-primary, #ebcb8b)" />
        </marker>
        <marker id="dshc-dep-arrow-ready" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 8 4 0 8z" fill="var(--dsw-alias-state-success-primary, #a3be8c)" />
        </marker>
      </defs>
      {edges.map((edge) => (
        <g key={edge.key}>
          {edge.state === 'waiting' ? <path className="dshc-dep-edge-casing" d={edge.d} /> : null}
          <path
            className="dshc-dep-edge"
            data-state={edge.state}
            d={edge.d}
            markerEnd={edge.state === 'waiting' ? 'url(#dshc-dep-arrow)' : 'url(#dshc-dep-arrow-ready)'}
          />
        </g>
      ))}
    </svg>
  )
}
