/**
 * 原生壳的独立气泡窗（role=bubble）。
 *
 * 两种内容共用同一个 336×76 透明窗：
 *  - 状态：working 展示 `commanderActivity`（工具 description / assistant 文本，缺省「正在思考」），
 *    busy 结束显示「本轮完成」；
 *  - 快捷输入：球悬停 0.8s 后由 Rust 唤起，输入框可直接发消息，不必打开面板。
 *
 * 气泡窗的显隐、定位、click-through 与键盘焦点由 Rust 负责；这里只渲染内容。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createCommanderStore } from './store'
import { getShellBridge } from './shell-bridge'
import { bubbleActivityText, bubblePhaseFor } from './bubble'
import type { BubblePhase } from './bubble'
import type { CommanderStore } from './store'
import type { NativeShellBridge } from './shell-bridge'

const ATTENTION_MS = 5_000

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

function Check() {
  return (
    <svg className="dshcn-bubble-check" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.8 8.4l2.7 2.7 5.7-5.7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function QuickInput(props: {
  bridge: NativeShellBridge
  copy: Copy
  side: 'left' | 'right'
  store: CommanderStore
  view: CommanderView
  ballHovered: boolean
}) {
  const { bridge, copy, side, store, view, ballHovered } = props
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bound = view.binding !== null
  const sending = view.sending

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 没输入内容时，光标离开浮球就自动收起；有内容则保留，方便移过去点发送。
  useEffect(() => {
    if (!ballHovered && text.trim() === '') {
      void bridge.setQuickInput(false)
    }
  }, [ballHovered, text, bridge])

  const close = (): void => {
    void bridge.setQuickInput(false)
  }

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || sending || !bound) return
    setError(null)
    const result = await store.send(value)
    if (result.ok) {
      setText('')
      close()
      return
    }
    setError(result.failure.message || copy.quickError)
  }

  const hint = !bound ? copy.quickUnbound : error ?? ''

  return (
    <div
      className="dshcn-quick"
      data-side={side}
      data-error={error !== null ? 'true' : 'false'}
      role="dialog"
      aria-label={copy.quickAria}
    >
      <div className="dshcn-quick-bar">
        <span className="dshcn-quick-mark" aria-hidden="true">&gt;</span>
        <div className="dshcn-quick-body">
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
                close()
              }
            }}
          />
          {hint === '' ? null : (
            <span className="dshcn-quick-hint" data-error={error !== null ? 'true' : 'false'}>{hint}</span>
          )}
        </div>
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
      </div>
    </div>
  )
}

export function BubbleApp() {
  const bridge = useMemo(() => getShellBridge(), [])
  const copy = COPY[bridge.locale]
  const [store] = useState(() => createCommanderStore({ baseUrl: '' }))
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [phase, setPhase] = useState<BubblePhase>('hidden')
  const [side, setSide] = useState<'left' | 'right'>('left')
  const [quickOpen, setQuickOpen] = useState(false)
  const [ballHovered, setBallHovered] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const wasBusy = useRef(false)
  const phaseRef = useRef<BubblePhase>('hidden')
  const attentionTimer = useRef<number | null>(null)
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
  useEffect(() => bridge.onModeChange(setPanelOpen), [bridge])
  useEffect(() => bridge.onBallHover(setBallHovered), [bridge])
  useEffect(() => bridge.onQuickInput((open) => {
    setQuickOpen(open)
    // 快捷输入能弹出，说明光标当时就在球上；先置 true，等原生发离开事件再判断。
    if (open) setBallHovered(true)
  }), [bridge])

  // 连接断开时不要留着过期的「正在思考」；面板头是连接状态的权威出口。
  // success 文案展示 5s 后收起，浮球转为未读呼吸，直到点击浮球/打开面板确认。
  useEffect(() => {
    // 快捷输入打开时它独占气泡窗，状态气泡的显隐等关闭后再由本 effect 重新驱动。
    if (quickOpen) return
    const next = bubblePhaseFor({ busy: view.busy, connection: view.connection, wasBusy: wasBusy.current })
    if (next === 'hidden') {
      // 完成提示是常驻的，只由点击浮球/打开面板确认；连接短暂抖动不清掉它。
      if (phaseRef.current === 'success') {
        if (panelOpen) {
          acknowledged.current = true
          setPhase('hidden')
          void bridge.setBubble(false)
        } else if (!acknowledged.current) {
          return
        }
        return
      }
      wasBusy.current = false
      setPhase('hidden')
      void bridge.setBubble(false)
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
      void bridge.setBubble(true)
      return
    }
    // next === 'success'
    if (panelOpen || acknowledged.current) {
      acknowledged.current = true
      wasBusy.current = false
      setPhase('hidden')
      void bridge.setBubble(false)
      void bridge.setBallUnread(false)
      return
    }
    // 已经在倒计时/展示中就不要因为 quickOpen/connection 变化重置 5s。
    if (phaseRef.current === 'success' && attentionTimer.current !== null) return
    wasBusy.current = false
    setPhase('success')
    void bridge.setBubble(true)
    if (attentionTimer.current !== null) window.clearTimeout(attentionTimer.current)
    attentionTimer.current = window.setTimeout(() => {
      attentionTimer.current = null
      setPhase('hidden')
      void bridge.setBubble(false)
      void bridge.setBallUnread(true)
    }, ATTENTION_MS)
  }, [view.busy, view.connection, quickOpen, panelOpen, bridge])

  useEffect(() => () => {
    if (attentionTimer.current !== null) window.clearTimeout(attentionTimer.current)
  }, [])

  if (quickOpen) {
    return <QuickInput bridge={bridge} copy={copy} side={side} store={store} view={view} ballHovered={ballHovered} />
  }

  if (phase === 'hidden') return null

  const working = phase === 'working'
  // working 时优先显示当前工具 description / assistant 文本，无活动再回退「正在思考」。
  const activity = working ? bubbleActivityText(view.activity?.text) : ''
  const workingText = activity === '' ? copy.working : activity
  return (
    <div
      className="dshcn-bubble"
      data-side={side}
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={working ? (activity === '' ? copy.workingAria : activity) : copy.successAria}
    >
      <span className="dshcn-bubble-pill" data-tone={working ? 'working' : 'success'} key={phase}>
        {working ? null : <span className="dshcn-bubble-icon" aria-hidden="true"><Check /></span>}
        <span className="dshcn-bubble-text">{working ? workingText : copy.success}</span>
        <span className="dshcn-bubble-tail" aria-hidden="true" />
      </span>
    </div>
  )
}
