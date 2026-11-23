/* 原型切换逻辑：?variant=A|B|C（另带 theme、status），← → 与 1/2/3 快捷切换。 */
(function () {
  'use strict'

  var VARIANTS = [
    { key: 'A', name: '审阅台' },
    { key: 'B', name: '双栏检视' },
    { key: 'C', name: '事件卷宗' },
    { key: 'D', name: '编年审阅' }
  ]
  var html = document.documentElement
  var body = document.body
  var params = new URLSearchParams(location.search)

  var state = {
    variant: (params.get('variant') || html.getAttribute('data-variant') || 'D').toUpperCase(),
    theme: params.get('theme') || html.getAttribute('data-theme') || 'dark',
    status: params.get('status') || body.getAttribute('data-task-status') || 'review'
  }
  if (!VARIANTS.some(function (v) { return v.key === state.variant })) state.variant = 'D'
  if (state.theme !== 'light' && state.theme !== 'dark') state.theme = 'dark'
  if (state.status !== 'draft' && state.status !== 'review') state.status = 'review'

  var nameEl = document.getElementById('sw-name')
  var themeBtn = document.getElementById('theme-btn')
  var bar = document.querySelector('.switcher')

  function syncSegments () {
    var buttons = document.querySelectorAll('[data-status-choice]')
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-status-choice') === state.status
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false')
    }
  }

  // C 方案的进度条随示例状态前进/后退。
  function syncSteps () {
    var steps = document.querySelectorAll('.c-steps li, .d-steps li')
    var stage = state.status === 'draft' ? 1 : 3 // 第几步是当前（草案停在「待派发」）
    for (var i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('done', i + 1 < stage)
      steps[i].classList.toggle('active', i + 1 === stage)
    }
  }

  function syncChips () {
    var chips = document.querySelectorAll('.status-chip')
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute('data-status', state.status)
    var labels = document.querySelectorAll('[data-status-label]')
    for (var j = 0; j < labels.length; j++) labels[j].textContent = state.status === 'draft' ? '草案' : '待验收'
  }

  function syncTheme () {
    var dark = state.theme === 'dark'
    html.setAttribute('data-theme', dark ? 'dark' : 'light')
    if (themeBtn) {
      var use = themeBtn.querySelector('use')
      if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon')
      themeBtn.setAttribute('title', dark ? '切到浅色' : '切到深色')
    }
  }

  function syncUrl () {
    var q = new URLSearchParams()
    q.set('variant', state.variant)
    q.set('theme', state.theme)
    q.set('status', state.status)
    try {
      history.replaceState(null, '', location.pathname + '?' + q.toString())
    } catch (err) { /* file:// 某些浏览器禁止改地址栏，忽略即可 */ }
  }

  // 把切换器放在「抽屉之外仍可见的看板区域」正中，避免压住抽屉底部的操作条。
  function positionBar () {
    if (!bar) return
    var panel = document.getElementById('panel-' + state.variant)
    var width = panel ? panel.getBoundingClientRect().width : 460
    var freeEdge = window.innerWidth - width - 18
    var barW = bar.offsetWidth || 420
    var half = barW / 2 + 16
    var left
    if (window.innerWidth <= 1000 || freeEdge < barW + 36) {
      left = window.innerWidth / 2
    } else {
      left = Math.max(half, Math.min(freeEdge / 2, freeEdge - half))
    }
    html.style.setProperty('--free-center', left + 'px')
  }

  function apply () {
    html.setAttribute('data-variant', state.variant)
    body.setAttribute('data-task-status', state.status)
    syncChips()
    syncSteps()
    syncTheme()
    syncSegments()
    if (nameEl) {
      var item = VARIANTS.filter(function (v) { return v.key === state.variant })[0]
      nameEl.textContent = state.variant + ' · ' + item.name
    }
    positionBar()
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionBar)
    window.requestAnimationFrame(function () {
      positionBar()
      window.setTimeout(positionBar, 60)
    })
    syncUrl()
  }

  function move (delta) {
    var i = 0
    for (var k = 0; k < VARIANTS.length; k++) if (VARIANTS[k].key === state.variant) i = k
    state.variant = VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length].key
    apply()
  }

  document.querySelectorAll('[data-nav]').forEach(function (btn) {
    btn.addEventListener('click', function () { move(Number(btn.getAttribute('data-nav'))) })
  })

  document.querySelectorAll('[data-status-choice]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.status = btn.getAttribute('data-status-choice')
      apply()
    })
  })

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark'
      apply()
    })
  }

  window.addEventListener('keydown', function (event) {
    var el = event.target
    var tag = el && el.tagName ? el.tagName.toLowerCase() : ''
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
    else if (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4') {
      state.variant = VARIANTS[Number(event.key) - 1].key
      apply()
    }
  })

  var moreBtn = document.getElementById('d-more')
  var moreMenu = document.getElementById('d-menu')
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', function (event) {
      event.stopPropagation()
      var willOpen = moreMenu.hasAttribute('hidden')
      if (willOpen) moreMenu.removeAttribute('hidden')
      else moreMenu.setAttribute('hidden', '')
      moreBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
    })
    document.addEventListener('click', function (event) {
      if (moreMenu.hasAttribute('hidden')) return
      if (moreMenu.contains(event.target)) return
      moreMenu.setAttribute('hidden', '')
      moreBtn.setAttribute('aria-expanded', 'false')
    })
  }

  document.querySelectorAll('[data-jump]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-jump'))
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  window.addEventListener('resize', positionBar)
  apply()
})()
