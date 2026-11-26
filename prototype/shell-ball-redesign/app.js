// 壳浮球重设计原型 v2：中心符号 + 推理状态气泡。
// 纯静态，无依赖。只负责注入球体/符号、同步演示状态、驱动气泡时序。
const CURRENT_FLAG = `<svg class="flag" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path class="flag-pole" d="M7.4 4.6v14.8" />
  <path class="flag-cloth" d="M9.2 5.4h8.6l-2.5 3.4 2.5 3.3H9.2z" />
</svg>`

// 新方案不再有旗标；中心符号是一个可选层。
const MARK = `<span class="orb-mark" aria-hidden="true">
  <span class="mark-core"></span>
  <span class="mark-trio"><i></i><i></i><i></i></span>
  <span class="mark-chevron"><svg viewBox="0 0 12 12" fill="none"><path d="M4 2.6L7.4 6 4 9.4" /></svg></span>
  <span class="mark-ring"></span>
</span>`

const SURFACES = {
  current: '',
  aurora: `<i class="wash"></i><i class="aura"></i><i class="ring"></i><i class="arc"></i><i class="spec"></i><i class="bounce"></i>`,
  pulse: `<i class="core"></i><i class="sonar s1"></i><i class="sonar s2"></i><i class="rim"></i>`,
  orbit: `<i class="sphere"></i><i class="spec"></i><i class="path"></i><i class="orbit o1"></i><i class="orbit o2"></i>`,
  prism: `<i class="liquid l1"></i><i class="liquid l2"></i><i class="caustic"></i><i class="irid"></i><i class="irid-inner"></i><i class="spec"></i>`,
}

function orbMarkup(variant, mark, isStatic) {
  const current = variant === 'current'
  const tag = isStatic ? 'span' : 'button'
  const attrs = isStatic
    ? 'aria-hidden="true"'
    : 'type="button" aria-label="指挥官悬浮球"'
  return `<${tag} ${attrs} class="orb${isStatic ? ' is-static' : ''}" data-variant="${variant}" data-mark="${current ? 'none' : mark}">
    <span class="orb-body">
      <span class="orb-surface">${SURFACES[variant]}</span>
      ${current ? `<span class="orb-glyph">${CURRENT_FLAG}</span>` : MARK}
      <span class="orb-badge" aria-hidden="true">3</span>
      ${current ? '<span class="orb-status" data-tone="live" aria-hidden="true"></span>' : ''}
    </span>
  </${tag}>`
}

document.querySelectorAll('[data-orb]').forEach((host) => {
  host.innerHTML = orbMarkup(host.dataset.orb, host.dataset.fixedMark ?? 'none', host.closest('.mark-study') !== null)
})

const body = document.body
const params = new URLSearchParams(location.search)
const STATES = ['idle', 'hover', 'busy', 'pending', 'offline']
const CYCLE = ['idle', 'busy', 'pending', 'offline']
const MARKS = ['none', 'core', 'trio', 'chevron', 'ring']
let state = STATES.includes(params.get('state')) ? params.get('state') : 'idle'
let theme = params.get('theme') === 'light' ? 'light' : 'dark'
let clip = params.get('clip') === '1'
let mark = MARKS.includes(params.get('mark')) ? params.get('mark') : 'none'

// ------------------------------------------------------------ 球体/符号状态
function syncUrl() {
  const url = new URL(location.href)
  if (state === 'idle') url.searchParams.delete('state')
  else url.searchParams.set('state', state)
  if (theme === 'dark') url.searchParams.delete('theme')
  else url.searchParams.set('theme', theme)
  if (!clip) url.searchParams.delete('clip')
  else url.searchParams.set('clip', '1')
  if (mark === 'none') url.searchParams.delete('mark')
  else url.searchParams.set('mark', mark)
  history.replaceState(null, '', url)
}

function apply() {
  body.dataset.state = state
  body.dataset.theme = theme
  body.dataset.clip = clip ? '1' : '0'
  body.dataset.mark = mark
  document.querySelectorAll('[data-control="state"] button').forEach((button) => {
    button.classList.toggle('on', button.dataset.value === state)
  })
  document.querySelectorAll('[data-control="theme"] button').forEach((button) => {
    button.classList.toggle('on', button.dataset.value === theme)
  })
  const toggle = document.querySelector('[data-control="clip"]')
  toggle?.setAttribute('aria-pressed', String(clip))
  // 中心符号只更新“跟随”的球；研究卡保持自己的固定符号。
  document.querySelectorAll('[data-orb]').forEach((host) => {
    if (host.dataset.fixedMark !== undefined) return
    const orb = host.querySelector('.orb')
    if (orb !== null) orb.dataset.mark = mark
  })
  document.querySelectorAll('.mark-card[data-set-mark]').forEach((card) => {
    card.classList.toggle('is-active', card.dataset.setMark === mark)
  })
  document.querySelectorAll('.orb-status').forEach((dot) => {
    dot.dataset.tone = state === 'offline' ? 'offline' : 'live'
  })
  syncUrl()
}

document.querySelectorAll('[data-control="state"] button').forEach((button) => {
  button.addEventListener('click', () => {
    state = button.dataset.value
    apply()
  })
})
document.querySelectorAll('[data-control="theme"] button').forEach((button) => {
  button.addEventListener('click', () => {
    theme = button.dataset.value
    apply()
  })
})
document.querySelector('[data-control="clip"]')?.addEventListener('click', () => {
  clip = !clip
  apply()
})

document.querySelectorAll('.mark-card[data-set-mark]').forEach((card) => {
  card.addEventListener('click', () => {
    mark = card.dataset.setMark
    apply()
  })
})

// 点击任意球体：在待机 / 思考 / 待处理 / 离线之间循环。
document.addEventListener('click', (event) => {
  const orb = event.target.closest?.('.orb')
  if (orb === null || orb === undefined) return
  if (orb.closest('.mark-study') !== null) return
  const current = CYCLE.indexOf(state)
  state = CYCLE[(current + 1) % CYCLE.length]
  apply()
})

// 指针高光：A / D 的 spec 用 --mx/--my 跟随指针。
document.addEventListener('pointerover', (event) => {
  const orb = event.target.closest?.('.orb')
  if (orb === null || orb === undefined) return
  orb.classList.add('is-hover')
})
document.addEventListener('pointerout', (event) => {
  const orb = event.target.closest?.('.orb')
  if (orb === null || orb === undefined) return
  if (event.relatedTarget instanceof Node && orb.contains(event.relatedTarget)) return
  orb.classList.remove('is-hover')
  orb.style.setProperty('--mx', '0px')
  orb.style.setProperty('--my', '0px')
})
document.addEventListener('pointermove', (event) => {
  const orb = event.target.closest?.('.orb')
  if (orb === null || orb === undefined) return
  const rect = orb.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  const x = (event.clientX - rect.left) / rect.width - 0.5
  const y = (event.clientY - rect.top) / rect.height - 0.5
  orb.style.setProperty('--mx', `${(x * 12).toFixed(2)}px`)
  orb.style.setProperty('--my', `${(y * 8).toFixed(2)}px`)
})

// ------------------------------------------------------------ 气泡演示
const ICONS = {
  working: `<svg class="spin" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-opacity=".24" stroke-width="2" /><path d="M13.6 8A5.6 5.6 0 0 0 8 2.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>`,
  success: `<svg viewBox="0 0 16 16" fill="none"><path d="M3.8 8.4l2.7 2.7 5.7-5.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>`,
  error: `<svg viewBox="0 0 16 16" fill="none"><path d="M8 3.2v5.6" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><circle cx="8" cy="12.3" r="1.1" fill="currentColor" /></svg>`,
  typing: `<span class="typing-dots"><i></i><i></i><i></i></span>`,
}

const bubbleWin = document.querySelector('#demoBubbleWin')
const bubbleEl = document.querySelector('#demoBubble')
const bubbleIcon = document.querySelector('#demoBubbleIcon')
const bubbleText = document.querySelector('#demoBubbleText')
const bubbleDetail = document.querySelector('#demoBubbleDetail')
const demoLog = document.querySelector('#demoLog')
let bubbleTimer = 0
let demoTimers = []

function clearDemoTimers() {
  demoTimers.forEach((timer) => window.clearTimeout(timer))
  demoTimers = []
}

function setDemoBallBusy(busy) {
  if (busy) {
    if (state === 'offline' || state === 'pending') return
    state = 'busy'
  } else if (state === 'busy') {
    state = 'idle'
  }
  apply()
}

function setBubble({ tone, text, detail, ttl }) {
  if (bubbleWin === null || bubbleEl === null || bubbleIcon === null || bubbleText === null || bubbleDetail === null) return
  window.clearTimeout(bubbleTimer)
  bubbleWin.dataset.visible = 'true'
  bubbleEl.dataset.tone = tone
  bubbleIcon.innerHTML = ICONS[tone] ?? ICONS.working
  bubbleText.textContent = text
  bubbleDetail.textContent = detail ?? ''
  bubbleDetail.hidden = !detail
  bubbleText.classList.remove('is-in')
  bubbleIcon.classList.remove('is-pop')
  void bubbleText.offsetWidth
  bubbleText.classList.add('is-in')
  bubbleIcon.classList.add('is-pop')
  if (demoLog !== null) demoLog.textContent = detail === undefined ? text : `${text} · ${detail}`
  setDemoBallBusy(tone === 'working' || tone === 'typing')
  if (ttl !== undefined) bubbleTimer = window.setTimeout(hideBubble, ttl)
}

function hideBubble() {
  window.clearTimeout(bubbleTimer)
  if (bubbleWin !== null) bubbleWin.dataset.visible = 'false'
  if (demoLog !== null) demoLog.textContent = '气泡已收起'
  setDemoBallBusy(false)
}

function play(steps) {
  clearDemoTimers()
  steps.forEach(([at, fn]) => {
    demoTimers.push(window.setTimeout(fn, at))
  })
}

const SEQUENCES = {
  create: [
    [0, () => setBubble({ tone: 'typing', text: '正在理解指令', detail: '读取绑定会话' })],
    [700, () => setBubble({ tone: 'working', text: '正在创建任务', detail: '修复登录重试' })],
    [2300, () => setBubble({ tone: 'success', text: '任务已创建', detail: 'T-2048 · 待派发' })],
    [4800, hideBubble],
  ],
  update: [
    [0, () => setBubble({ tone: 'working', text: '正在更新任务', detail: '调整优先级' })],
    [1600, () => setBubble({ tone: 'success', text: '任务已更新', detail: 'P1 · 已写入' })],
    [3800, hideBubble],
  ],
  dispatch: [
    [0, () => setBubble({ tone: 'working', text: '正在派发任务', detail: 'Research · 新会话' })],
    [1800, () => setBubble({ tone: 'success', text: '派发完成', detail: '会话已创建' })],
    [4000, hideBubble],
  ],
  fail: [
    [0, () => setBubble({ tone: 'working', text: '正在更新任务', detail: '版本冲突' })],
    [1200, () => setBubble({ tone: 'error', text: '更新失败', detail: '版本已刷新，请重试' })],
    [5200, hideBubble],
  ],
  chain: [
    [0, () => setBubble({ tone: 'typing', text: '正在理解指令', detail: '读取绑定会话' })],
    [800, () => setBubble({ tone: 'working', text: '正在创建任务', detail: '修复登录重试' })],
    [1800, () => setBubble({ tone: 'working', text: '正在更新任务', detail: '设置优先级 P1' })],
    [2800, () => setBubble({ tone: 'working', text: '正在派发任务', detail: 'Research · 新会话' })],
    [4000, () => setBubble({ tone: 'success', text: '任务已创建', detail: 'T-2048 · 已派发' })],
    [6400, hideBubble],
  ],
}

document.querySelectorAll('[data-bubble-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.bubbleAction
    if (action === 'reset') {
      clearDemoTimers()
      hideBubble()
      return
    }
    const sequence = SEQUENCES[action]
    if (sequence !== undefined) play(sequence)
  })
})

// 供截图/演示直接定位：?demo=working|success|error|chain
const demoParam = params.get('demo')
if (demoParam === 'working') {
  setBubble({ tone: 'working', text: '正在创建任务', detail: '修复登录重试' })
} else if (demoParam === 'success') {
  setBubble({ tone: 'success', text: '任务已创建', detail: 'T-2048 · 待派发' })
} else if (demoParam === 'error') {
  setBubble({ tone: 'error', text: '更新失败', detail: '版本已刷新，请重试' })
} else if (demoParam === 'chain') {
  play(SEQUENCES.chain)
}

apply()
