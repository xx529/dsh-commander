/* 多轮任务详情设计稿的本地交互：轮次展开/收起、brief 展开、继续派发 composer、设计稿切换。 */

(function () {
  const root = document.documentElement
  const $ = (selector, scope) => (scope || document).querySelector(selector)
  const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector))

  const body = $('#d-body')
  const toast = $('#toast')
  const composer = $('#composer')
  const composerText = $('#composer-text')

  const showToast = (text) => {
    if (!toast) return
    toast.textContent = text
    toast.hidden = false
    window.clearTimeout(showToast.timer)
    showToast.timer = window.setTimeout(() => { toast.hidden = true }, 3200)
  }

  /* ---------------- 轮次展开 / 收起 ---------------- */
  function setRound(id, open, scroll) {
    const section = document.getElementById(id)
    if (!section) return
    section.classList.toggle('is-collapsed', !open)
    const toggle = $(`[data-toggle-round="${id}"]`, section)
    if (toggle) toggle.textContent = open ? '收起' : '展开'
    const tab = $(`.round-tab[data-jump="${id}"]`)
    if (tab) tab.classList.toggle('is-current', open)
    if (open && scroll) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  function toggleRound(id) {
    const section = document.getElementById(id)
    if (!section) return
    const willOpen = section.classList.contains('is-collapsed')
    setRound(id, willOpen, willOpen)
  }

  $$('[data-toggle-round]').forEach((button) => {
    button.addEventListener('click', () => toggleRound(button.dataset.toggleRound))
  })

  $$('[data-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.jump
      setRound(id, true, true)
    })
  })

  /* ---------------- 目标 / brief / 验收 ---------------- */
  const goal = $('#goal')
  const goalToggle = $('#goal-toggle')
  if (goal && goalToggle) {
    if (root.dataset.expand === '1') {
      goal.classList.add('is-open')
      goalToggle.textContent = '收起'
    }
    goalToggle.addEventListener('click', () => {
      const open = goal.classList.toggle('is-open')
      goalToggle.textContent = open ? '收起' : '展开'
    })
  }

  $$('.brief-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const card = button.closest('.dispatch-card')
      const brief = $('.brief', card)
      if (!brief) return
      const open = brief.classList.toggle('is-expanded')
      button.textContent = open ? '收起' : '展开全文'
    })
  })

  $$('[data-toggle-acc]').forEach((button) => {
    button.addEventListener('click', () => {
      const box = document.getElementById(button.dataset.toggleAcc)
      if (box) box.classList.toggle('is-open')
    })
  })

  /* ---------------- 继续派发 composer ---------------- */
  function openComposer() {
    if (!composer) return
    composer.hidden = false
    const foot = composer.closest('.d-foot')
    if (foot) foot.classList.add('is-composing')
    const continueButton = $('#continue')
    if (continueButton) continueButton.setAttribute('aria-expanded', 'true')
    window.setTimeout(() => composerText && composerText.focus(), 30)
    if (body) body.scrollTop = body.scrollHeight
  }

  function closeComposer() {
    if (!composer) return
    composer.hidden = true
    const foot = composer.closest('.d-foot')
    if (foot) foot.classList.remove('is-composing')
    const continueButton = $('#continue')
    if (continueButton) continueButton.setAttribute('aria-expanded', 'false')
  }

  const continueButton = $('#continue')
  if (continueButton) continueButton.addEventListener('click', openComposer)
  const composerClose = $('#composer-close')
  if (composerClose) composerClose.addEventListener('click', closeComposer)
  const composerCancel = $('#composer-cancel')
  if (composerCancel) composerCancel.addEventListener('click', closeComposer)

  $$('.target').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.target').forEach((item) => item.classList.remove('is-on'))
      button.classList.add('is-on')
    })
  })

  if (composer) {
    composer.addEventListener('submit', (event) => {
      event.preventDefault()
      closeComposer()
      showToast('已通知指挥官继续派发；确认后进入第 3 轮')
    })
  }

  const accept = $('#accept')
  if (accept) {
    accept.addEventListener('click', () => {
      showToast('验收通过（设计稿演示）')
    })
  }

  /* ---------------- 设计稿控件 ---------------- */
  function reset() {
    setRound('round-1', false, false)
    setRound('round-2', true, false)
    closeComposer()
    if (goal) goal.classList.remove('is-open')
    if (goalToggle) goalToggle.textContent = '展开'
    $$('.brief').forEach((brief) => brief.classList.remove('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '展开全文' })
    if (body) body.scrollTop = 0
    showToast('已回到默认：第 1 轮折叠，第 2 轮展开')
  }

  function expandAll() {
    setRound('round-1', true, false)
    setRound('round-2', true, false)
    $$('.brief').forEach((brief) => brief.classList.add('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '收起' })
    if (body) body.scrollTop = 0
    showToast('第 1 轮已展开：用户原话 + 派发原文')
  }

  const acts = {
    reset,
    expand: expandAll,
    compose: openComposer,
    theme: () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      root.setAttribute('data-theme', next)
      const button = $('.switcher [data-act="theme"]')
      if (button) button.textContent = next === 'dark' ? '浅色' : '深色'
    },
  }

  $$('.switcher [data-act]').forEach((button) => {
    button.addEventListener('click', () => {
      const act = button.dataset.act
      if (acts[act]) acts[act]()
      $$('.switcher [data-act]').forEach((item) => item.classList.toggle('is-on', item === button && act === 'reset'))
    })
  })

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement) return
    if (event.key === '1') { reset(); return }
    if (event.key === '2') { expandAll(); return }
    if (event.key === '3') { openComposer(); return }
    if (event.key.toLowerCase() === 't') { acts.theme(); return }
    if (event.key === 'Escape') {
      if (composer && !composer.hidden) { closeComposer(); return }
    }
  })

  /* URL 参数：?expand=1 或 ?compose=1 */
  if (root.dataset.expand === '1') {
    setRound('round-1', true, false)
    if (goal) goal.classList.add('is-open')
    if (goalToggle) goalToggle.textContent = '收起'
    $$('.brief').forEach((brief) => brief.classList.add('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '收起' })
  }
  if (root.dataset.compose === '1') {
    window.setTimeout(openComposer, 60)
  }
})()
