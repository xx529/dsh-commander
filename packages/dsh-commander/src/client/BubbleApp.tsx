/**
 * 原生壳的独立气泡窗（role=bubble）。
 *
 * 两种内容共用同一个 336×124 透明窗：
 *  - 状态气泡：working 展示 `commanderActivity`（工具 description / assistant 文本，缺省「正在思考」），
 *    文案最多 5 行；busy 结束显示「本轮完成」；
 *  - 快捷输入：球悬停 0.8s 后由 Rust 唤起，输入框可直接发消息。
 *
 * 规则（v0.6）：
 *  - 气泡内容常驻，文案切换靠两层文本（交叉淡化 / 先出后进），宽度与高度按测量值缓动；
 *  - 显隐统一 180ms 弹入 / 150ms 淡出，退场动画结束后才让 Rust 隐藏窗口；
 *  - 输入框优先：输入框打开时气泡先退场，两者不叠加；
 *  - 顶边锚定向下长；球贴屏幕下方时由 Rust 发 anchor=bottom，改底边锚定向上长。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createCommanderStore } from './store'
import { getShellBridge } from './shell-bridge'
import {
  bubbleActivityText,
  bubbleContentWidth,
  bubblePhaseFor,
  bubblePillHeight,
  bubblePillWidth,
  bubbleRowsFromHeight,
  bubbleTextMotion,
  lastAssistantReply,
  BUBBLE_LINE_HEIGHT,
} from './bubble'
import type { BubblePhase } from './bubble'
import type { CommanderStore } from './store'
import type { NativeShellBridge } from './shell-bridge'

const ATTENTION_MS = 5_000

const ENTER_MS = 180
const EXIT_MS = 150
const HANDOFF_MS = 100
const SIZE_MS = 210
const EASE_SIZE = 'cubic-bezier(0.2, 0.9, 0.3, 1)'
const EASE_ENTER = 'cubic-bezier(0.2, 0.9, 0.3, 1.2)'
const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)'
const EXIT_KF = [
  { opacity: 1, transform: 'none' },
  { opacity: 0, transform: 'translateX(4px) scale(0.985)' },
]

const COPY = {
  zh: {
    working: '正在思考',
    success: '已完成 · 点击球查看',
    workingAria: '指挥官正在思考',
    successAria: '本轮已完成，点击浮球查看结果',
    quickUnbound: '先在面板绑定指挥官',
    quickSend: '发送',
    quickAria: '快捷输入',
    quickError: '发送失败',
  },
  en: {
    working: 'Thinking',
    success: 'Done · click the ball',
    workingAria: 'Commander is thinking',
    successAria: 'Turn complete. Click the ball to view.',
    quickUnbound: 'Bind the commander in the panel first',
    quickSend: 'Send',
    quickAria: 'Quick input',
    quickError: 'Send failed',
  },
} as const

type Copy = (typeof COPY)['zh'] | (typeof COPY)['en']
type CommanderView = ReturnType<CommanderStore['getSnapshot']>
type Anchor = 'top' | 'bottom'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** jsdom（harness）没有 Web Animations API：统一走这里，缺失时直接跳到终态。 */
function play(
  el: Element | null,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | null {
  const target = el as (Element & { animate?: (kf: Keyframe[], opts: KeyframeAnimationOptions) => Animation }) | null
  if (target === null || typeof target.animate !== 'function') return null
  return target.animate(keyframes, options)
}

/** 退场动画：演完立刻 cancel。fill:'forwards' 不清掉的话，节点会永久停在 opacity 0。 */
async function playExit(el: Element | null, durationMs: number): Promise<void> {
  const anim = play(el, EXIT_KF, { duration: durationMs, easing: EASE_EXIT, fill: 'forwards' })
  if (anim === null) return
  try {
    await anim.finished
  } catch {
    return
  }
  anim.cancel()
}

function enterKeyframes(side: 'left' | 'right'): Keyframe[] {
  return [
    { opacity: 0, transform: `translateX(${side === 'right' ? -6 : 6}px) scale(0.96)` },
    { opacity: 1, transform: 'none' },
  ]
}

function Check() {
  return (
    <svg className="dshcn-bubble-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.8 8.4l2.7 2.7 5.7-5.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 气泡内容：常驻 pill、双层文本、按测量值缓动尺寸。 */
function BubbleContent(props: { text: string; tone: 'working' | 'success'; side: 'left' | 'right' }) {
  const { text, tone, side } = props
  const pillRef = useRef<HTMLSpanElement | null>(null)
  const copyRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)
  const iconRef = useRef<HTMLSpanElement | null>(null)
  const nowrapRef = useRef<HTMLSpanElement | null>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const prevText = useRef('')
  const prevRows = useRef<number | null>(null)

  // 挂载入场：窗口已由 Rust 显示，内容从球侧弹入。
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return
    play(pillRef.current, enterKeyframes(side), { duration: ENTER_MS, easing: EASE_ENTER })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 文案 / 阶段变化：测宽 → 测行数 → 缓动尺寸 → 切换文本层。
  useLayoutEffect(() => {
    const pill = pillRef.current
    const copy = copyRef.current
    const node = textRef.current
    const nowrap = nowrapRef.current
    const wrap = wrapRef.current
    if (pill === null || copy === null || node === null || nowrap === null || wrap === null) return

    const hasIcon = tone === 'success'
    nowrap.textContent = text
    const width = bubblePillWidth(nowrap.getBoundingClientRect().width, hasIcon)
    const contentWidth = bubbleContentWidth(width, hasIcon)
    wrap.style.width = `${contentWidth}px`
    wrap.textContent = text
    const rows = bubbleRowsFromHeight(wrap.getBoundingClientRect().height)
    const height = bubblePillHeight(rows)
    const copyHeight = Number((rows * BUBBLE_LINE_HEIGHT).toFixed(2))

    const fromWidth = pill.offsetWidth
    const fromHeight = pill.offsetHeight
    const fromCopy = copy.offsetHeight
    pill.style.width = `${width}px`
    pill.style.height = `${height}px`
    copy.style.height = `${copyHeight}px`

    const reduced = prefersReducedMotion()
    if (!reduced) {
      if (fromWidth > 0 && fromWidth !== width) {
        play(pill, [{ width: `${fromWidth}px` }, { width: `${width}px` }], { duration: SIZE_MS, easing: EASE_SIZE })
      }
      if (fromHeight > 0 && fromHeight !== height) {
        play(pill, [{ height: `${fromHeight}px` }, { height: `${height}px` }], { duration: SIZE_MS, easing: EASE_SIZE })
      }
      if (fromCopy > 0 && fromCopy !== copyHeight) {
        play(copy, [{ height: `${fromCopy}px` }, { height: `${copyHeight}px` }], { duration: SIZE_MS, easing: EASE_SIZE })
      }
    }

    const motion = bubbleTextMotion(prevRows.current, rows)
    if (!reduced && motion !== 'none' && prevText.current !== '' && prevText.current !== text) {
      // 旧文案用 ghosts 留在下层播离场；React 不管理它，播完自行移除。
      copy.querySelectorAll('[data-leaving="true"]').forEach((ghost) => ghost.remove())
      const ghost = document.createElement('span')
      ghost.className = 'dshcn-bubble-text'
      ghost.dataset.leaving = 'true'
      ghost.textContent = prevText.current
      copy.insertBefore(ghost, node)
      const outMs = motion === 'sequential' ? 90 : 160
      const inMs = motion === 'sequential' ? 160 : 160
      const inDelay = motion === 'sequential' ? 90 : 0
      const outShift = motion === 'sequential' ? 'translateY(0)' : 'translateY(-3px)'
      const outAnim = play(
        ghost,
        [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: outShift }],
        { duration: outMs, easing: 'linear', fill: 'forwards' },
      )
      if (outAnim === null) ghost.remove()
      else outAnim.finished.then(() => ghost.remove()).catch(() => {})
      play(
        node,
        [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: inMs, delay: inDelay, easing: 'linear', fill: 'backwards' },
      )
    }

    if (hasIcon && prevRows.current !== null) {
      play(iconRef.current, [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }], {
        duration: 260,
        easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
        fill: 'backwards',
      })
    }

    prevText.current = text
    prevRows.current = rows
  }, [text, tone])

  return (
    <>
      <span
        className="dshcn-bubble-pill"
        data-tone={tone}
        ref={pillRef}
      >
        {tone === 'success' ? (
          <span className="dshcn-bubble-icon" ref={iconRef} aria-hidden="true"><Check /></span>
        ) : null}
        <span className="dshcn-bubble-copy" ref={copyRef}>
          <span className="dshcn-bubble-text" ref={textRef}>{text}</span>
        </span>
        <span className="dshcn-bubble-tail" aria-hidden="true" />
      </span>
      <span className="dshcn-bubble-measure" ref={nowrapRef} aria-hidden="true" />
      <span className="dshcn-bubble-measure" data-mode="wrap" ref={wrapRef} aria-hidden="true" />
    </>
  )
}

/** 快捷输入条：与气泡共用同一个窗口和同一套显隐动效。 */
function QuickInput(props: {
  bridge: NativeShellBridge
  copy: Copy
  store: CommanderStore
  view: CommanderView
  ballHovered: boolean
  onClose: () => void
}) {
  const { bridge, copy, store, view, ballHovered, onClose } = props
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const barRef = useRef<HTMLSpanElement | null>(null)
  const bound = view.binding !== null
  const sending = view.sending

  useEffect(() => {
    inputRef.current?.focus()
    if (!prefersReducedMotion()) {
      play(barRef.current, enterKeyframes('left'), { duration: ENTER_MS, easing: EASE_ENTER })
    }
  }, [])

  // 没输入内容时，光标离开浮球就自动收起；有内容则保留，方便移过去点发送。
  useEffect(() => {
    if (!ballHovered && text.trim() === '') onClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ballHovered, text])

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || sending || !bound) return
    setError(null)
    const result = await store.send(value)
    if (result.ok) {
      setText('')
      onClose()
      return
    }
    setError(result.failure.message || copy.quickError)
  }

  const hint = !bound ? copy.quickUnbound : error ?? ''

  return (
    <span
      className="dshcn-quick-bar"
      ref={barRef}
      data-error={error !== null ? 'true' : 'false'}
      role="dialog"
      aria-label={copy.quickAria}
    >
      <span className="dshcn-quick-mark" aria-hidden="true">&gt;</span>
      <span className="dshcn-quick-body">
        <input
          ref={inputRef}
          className="dshcn-quick-input"
          value={text}
          disabled={!bound || sending}
          aria-label={copy.quickAria}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setError(null)
            setText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            }
          }}
        />
        {hint === '' ? null : (
          <span className="dshcn-quick-hint" data-error={error !== null ? 'true' : 'false'}>{hint}</span>
        )}
      </span>
      <button
        type="button"
        className="dshcn-quick-send"
        onClick={() => void submit()}
        disabled={!bound || sending || text.trim() === ''}
        aria-label={copy.quickSend}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </span>
  )
}

export function BubbleApp() {
  const bridge = useMemo(() => getShellBridge(), [])
  const copy = COPY[bridge.locale]
  const [store] = useState(() => createCommanderStore({ baseUrl: '' }))
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [phase, setPhase] = useState<BubblePhase>('hidden')
  const [side, setSide] = useState<'left' | 'right'>('left')
  const [anchor, setAnchor] = useState<Anchor>('top')
  const [quickOpen, setQuickOpen] = useState(false)
  const [ballHovered, setBallHovered] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  // 窗口内实际渲染的内容：输入框优先，切换时先让旧内容退场。
  const [shown, setShown] = useState<'bubble' | 'quick'>('bubble')
  const [shellVisible, setShellVisible] = useState(false)
  const wasBusy = useRef(false)
  const phaseRef = useRef<BubblePhase>('hidden')
  const attentionTimer = useRef<number | null>(null)
  const hideToken = useRef(0)
  const quickCloseToken = useRef(0)
  // 完成气泡只展示 5s，随后浮球进入未读呼吸；点击浮球/打开面板后确认清除。
  const acknowledged = useRef(false)

  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    if (!panelOpen) return
    if (attentionTimer.current !== null) {
      window.clearTimeout(attentionTimer.current)
      attentionTimer.current = null
    }
    void bridge.setBallUnread(false)
  }, [panelOpen, bridge])

  useEffect(() => bridge.onBubbleSide(setSide), [bridge])
  useEffect(() => bridge.onBubbleAnchor(setAnchor), [bridge])
  useEffect(() => bridge.onModeChange(setPanelOpen), [bridge])
  useEffect(() => bridge.onBallHover(setBallHovered), [bridge])
  useEffect(() => bridge.onQuickInput((open) => {
    setQuickOpen(open)
    if (open) setBallHovered(true)
  }), [bridge])

  // 窗口显隐：进场先让 Rust 显示窗口，退场演完 150ms 再隐藏。
  const showShell = (): void => {
    hideToken.current += 1
    // 保险：根节点上若有残留的已完成退场动画（fill:forwards），先清掉再显示
    document.querySelectorAll<HTMLElement>('.dshcn-bubble, .dshcn-quick').forEach((el) => {
      if (typeof el.getAnimations !== 'function') return
      for (const anim of el.getAnimations()) {
        if (anim.playState === 'finished') anim.cancel()
      }
    })
    setShellVisible(true)
    void bridge.setBubble(true)
  }
  const hideShell = (): void => {
    const token = ++hideToken.current
    const finish = (): void => {
      if (hideToken.current !== token) return
      setShellVisible(false)
      void bridge.setBubble(false)
    }
    if (prefersReducedMotion()) {
      finish()
      return
    }
    const el = document.querySelector<HTMLElement>('.dshcn-bubble, .dshcn-quick')
    if (el === null) {
      finish()
      return
    }
    void playExit(el, EXIT_MS).then(finish)
  }

  // 兜底：输入框已打开但页面迟迟没切过去（渲染/交接异常），光标又不在球上时主动收起，
  // 避免 quick_open 卡在壳里把状态气泡永久挡住。
  useEffect(() => {
    if (!quickOpen || ballHovered || shown === 'quick') return
    const timer = window.setTimeout(() => {
      void bridge.setQuickInput(false)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [quickOpen, ballHovered, shown, bridge])

  // 关输入框：先演 100ms 退场再让 Rust 隐藏窗口，和气泡共用一套。
  const closeQuick = (): void => {
    const token = ++quickCloseToken.current
    const el = document.querySelector<HTMLElement>('.dshcn-quick')
    if (el === null || prefersReducedMotion()) {
      void bridge.setQuickInput(false)
      return
    }
    void playExit(el, HANDOFF_MS).then(() => {
      if (quickCloseToken.current !== token) return
      void bridge.setQuickInput(false)
    })
  }

  // 输入框优先：打开时气泡先退 100ms，输入框再入场；收起反过来。
  useEffect(() => {
    const target: 'bubble' | 'quick' = quickOpen ? 'quick' : 'bubble'
    if (target === shown) return
    // 气泡本来就没显示（空闲时悬停唤起）：直接切输入框，不需要退场交接。
    if (target === 'quick' && (phase === 'hidden' || !shellVisible)) {
      setShown('quick')
      return
    }
    const el = document.querySelector<HTMLElement>('.dshcn-bubble, .dshcn-quick')
    if (el === null || prefersReducedMotion()) {
      setShown(target)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (cancelled) return
      setShown(target)
    }, HANDOFF_MS)
    void playExit(el, HANDOFF_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickOpen])

  // 连接断开时不要留着过期的「正在思考」；面板头是连接状态的权威出口。
  // success 文案展示 5s 后收起，浮球转为未读呼吸，直到点击浮球/打开面板确认。
  useEffect(() => {
    if (quickOpen) return
    const next = bubblePhaseFor({ busy: view.busy, connection: view.connection, wasBusy: wasBusy.current })
    if (next === 'hidden') {
      if (phaseRef.current === 'success') {
        if (panelOpen) {
          acknowledged.current = true
          setPhase('hidden')
          hideShell()
        } else if (!acknowledged.current) {
          return
        }
        return
      }
      wasBusy.current = false
      setPhase('hidden')
      hideShell()
      return
    }
    if (next === 'working') {
      acknowledged.current = false
      wasBusy.current = true
      if (attentionTimer.current !== null) {
        window.clearTimeout(attentionTimer.current)
        attentionTimer.current = null
      }
      void bridge.setBallUnread(false)
      setPhase('working')
      showShell()
      return
    }
    // next === 'success'
    if (panelOpen || acknowledged.current) {
      acknowledged.current = true
      wasBusy.current = false
      setPhase('hidden')
      hideShell()
      void bridge.setBallUnread(false)
      return
    }
    if (phaseRef.current === 'success' && attentionTimer.current !== null) return
    wasBusy.current = false
    setPhase('success')
    showShell()
    if (attentionTimer.current !== null) window.clearTimeout(attentionTimer.current)
    attentionTimer.current = window.setTimeout(() => {
      attentionTimer.current = null
      setPhase('hidden')
      hideShell()
      void bridge.setBallUnread(true)
    }, ATTENTION_MS)
  }, [view.busy, view.connection, quickOpen, panelOpen, bridge])

  useEffect(() => () => {
    if (attentionTimer.current !== null) window.clearTimeout(attentionTimer.current)
  }, [])

  // 输入框打开/交接中必须渲染，哪怕气泡阶段已经 hidden（悬停唤起就是这种情况）。
  if (!quickOpen && shown !== 'quick' && phase === 'hidden' && !shellVisible) return null

  const working = phase === 'working'
  const activity = working ? bubbleActivityText(view.activity?.text) : ''
  const workingText = activity === '' ? copy.working : activity
  // 完成态显示最后一轮回复内容，外框仍是绿色打勾（表示“这是回复，不是过程”）
  const replyText = working ? '' : bubbleActivityText(lastAssistantReply(view.messages))
  const successText = replyText === '' ? copy.success : replyText
  const content = quickOpen || shown === 'quick'
    ? (
      <QuickInput
        bridge={bridge}
        copy={copy}
        store={store}
        view={view}
        ballHovered={ballHovered}
        onClose={closeQuick}
      />
    )
    : <BubbleContent text={working ? workingText : successText} tone={working ? 'working' : 'success'} side={side} />

  const isQuick = quickOpen || shown === 'quick'
  return (
    <div
      className={isQuick ? 'dshcn-quick' : 'dshcn-bubble'}
      data-side={side}
      data-anchor={anchor}
      data-phase={phase}
      role={isQuick ? 'dialog' : 'status'}
      aria-live={isQuick ? undefined : 'polite'}
      aria-label={quickOpen ? copy.quickAria : working ? (activity === '' ? copy.workingAria : activity) : copy.successAria}
    >
      {content}
    </div>
  )
}
