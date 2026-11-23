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

  /* ---------------- 依据与材料 ---------------- */
  const materials = $$('.materials')

  function syncMaterials(box) {
    if (!box) return
    const toggle = $('[data-toggle-materials]', box)
    if (toggle) toggle.textContent = box.classList.contains('is-collapsed') ? '展开' : '收起'
    const more = $('[data-expand-materials]', box)
    if (more) {
      const label = more.dataset.label || ($('span', more) && $('span', more).textContent) || '查看全部'
      more.dataset.label = label
      const text = $('span', more)
      if (text) text.textContent = box.classList.contains('is-expanded') ? '收起' : label
    }
  }

  function setMaterialsOpen(id, open) {
    const box = document.getElementById(id)
    if (!box) return
    box.classList.toggle('is-collapsed', !open)
    syncMaterials(box)
  }

  function setMaterialsExpanded(id, expanded) {
    const box = document.getElementById(id)
    if (!box) return
    box.classList.toggle('is-expanded', expanded)
    if (expanded) box.classList.remove('is-collapsed')
    syncMaterials(box)
  }

  function jumpToMaterials(id) {
    const box = document.getElementById(id)
    if (!box) return
    setMaterialsOpen(id, true)
    setMaterialsExpanded(id, true)
    const target = box.closest('.ev') || box
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    box.classList.add('is-flash')
    window.setTimeout(() => box.classList.remove('is-flash'), 900)
  }

  $$('[data-toggle-materials]').forEach((button) => {
    button.addEventListener('click', () => {
      const box = document.getElementById(button.dataset.toggleMaterials)
      if (box) setMaterialsOpen(box.id, box.classList.contains('is-collapsed'))
    })
  })

  $$('[data-expand-materials]').forEach((button) => {
    button.addEventListener('click', () => {
      const box = document.getElementById(button.dataset.expandMaterials)
      if (box) setMaterialsExpanded(box.id, !box.classList.contains('is-expanded'))
    })
  })

  $$('[data-jump-materials]').forEach((button) => {
    button.addEventListener('click', () => jumpToMaterials(button.dataset.jumpMaterials))
  })

  /* ---------------- 方案 B：每条验收项自己的材料表 ---------------- */
  function setAllItemMaterials(open) {
    $$('.item-materials').forEach((box) => box.classList.toggle('is-collapsed', !open))
    $$('[data-toggle-item]').forEach((button) => button.setAttribute('aria-expanded', open ? 'true' : 'false'))
  }

  $$('[data-toggle-item]').forEach((button) => {
    button.addEventListener('click', () => {
      const box = document.getElementById(button.dataset.toggleItem)
      if (!box) return
      const open = box.classList.toggle('is-collapsed')
      button.setAttribute('aria-expanded', open ? 'false' : 'true')
    })
  })

  $$('[data-jump-acceptance]').forEach((button) => {
    button.addEventListener('click', () => {
      setAllItemMaterials(true)
      const target = document.getElementById(button.dataset.jumpAcceptance)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  })

  /* ---------------- 图片预览 ---------------- */
  const LIGHTBOX = {
    config: {
      src: 'assets/config.png',
      title: '订单中心模型配置',
      meta: '工作会话交付 · Htdot-OrderCenter · PNG · 128 KB',
      path: '/Users/lzx/Htdot/config-snapshot.png',
    },
    sku: {
      src: 'assets/sku.png',
      title: 'GLM-4.6 与 GLM-5.3-Flash-Legal 的 SKU 边界',
      meta: '工作会话交付 · GLM 兼容性评估 · PNG · 126 KB',
      path: '/Users/lzx/Htdot/sku-boundary.png',
    },
  }
  const lightbox = $('#lightbox')
  const lbImg = $('#lb-img')
  const lbTitle = $('#lb-title')
  const lbMeta = $('#lb-meta')
  const lbCount = $('#lb-count')
  const lbKeys = Object.keys(LIGHTBOX)
  let lbIndex = 0

  function renderLightbox() {
    const key = lbKeys[lbIndex]
    const item = LIGHTBOX[key]
    if (!item) return
    lbImg.src = item.src
    lbImg.alt = item.title
    lbTitle.textContent = item.title
    lbMeta.textContent = item.meta
    lbCount.textContent = `${lbIndex + 1} / ${lbKeys.length}`
    lightbox.dataset.current = key
  }

  function openLightbox(key) {
    const index = lbKeys.indexOf(key)
    lbIndex = index < 0 ? 0 : index
    renderLightbox()
    lightbox.hidden = false
  }

  function closeLightbox() {
    lightbox.hidden = true
  }

  function stepLightbox(delta) {
    lbIndex = (lbIndex + delta + lbKeys.length) % lbKeys.length
    renderLightbox()
  }

  $$('[data-close-lightbox]').forEach((button) => button.addEventListener('click', closeLightbox))
  const lbPrev = $('#lb-prev')
  if (lbPrev) lbPrev.addEventListener('click', () => stepLightbox(-1))
  const lbNext = $('#lb-next')
  if (lbNext) lbNext.addEventListener('click', () => stepLightbox(1))
  const lbCopy = $('#lb-copy')
  if (lbCopy) lbCopy.addEventListener('click', () => showToast('已复制图片路径（设计稿演示）'))
  const lbOpen = $('#lb-open')
  if (lbOpen) lbOpen.addEventListener('click', () => showToast('已在 DSH 中打开原图（设计稿演示）'))

  /* ---------------- 本地文件动作 ---------------- */
  const sheet = $('#file-sheet')
  const sheetTitle = $('#sheet-title')
  const sheetMeta = $('#sheet-meta')
  const sheetPath = $('#sheet-path')

  function openFileSheet(title, path, meta) {
    if (!sheet) return
    sheetTitle.textContent = title
    sheetMeta.textContent = meta || '工作会话交付 · 本地文件'
    sheetPath.textContent = path || '路径由 Host 记录，文件移动后会显示“已缺失”'
    sheet.hidden = false
  }

  function closeFileSheet() {
    if (sheet) sheet.hidden = true
  }

  $$('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeFileSheet))

  // 材料行 / 验收 chips 统一点击：图片 → 预览；文件 → 动作单；链接 → 外部打开提示。
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const lightboxTrigger = target.closest('[data-lightbox]')
    if (lightboxTrigger) {
      openLightbox(lightboxTrigger.dataset.lightbox)
      return
    }
    const fileTrigger = target.closest('[data-file]')
    if (fileTrigger) {
      const row = fileTrigger.closest('.material-row')
      const small = row && $('.m-main small', row)
      openFileSheet(fileTrigger.dataset.file, fileTrigger.dataset.path, small ? small.textContent : '')
      return
    }
    const linkTrigger = target.closest('[data-href]')
    if (linkTrigger) {
      showToast(`打开外部链接 · ${linkTrigger.dataset.href.replace(/^https?:\/\//, '')}（设计稿演示）`)
    }
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
    closeLightbox()
    closeFileSheet()
    if (goal) goal.classList.remove('is-open')
    if (goalToggle) goalToggle.textContent = '展开'
    $$('.brief').forEach((brief) => brief.classList.remove('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '展开全文' })
    materials.forEach((box) => {
      box.classList.remove('is-collapsed')
      box.classList.remove('is-expanded')
      box.classList.remove('is-flash')
      syncMaterials(box)
    })
    setAllItemMaterials(true)
    if (body) body.scrollTop = 0
    showToast('已回到默认：第 1 轮折叠，第 2 轮展开，材料保持摘要')
  }

  function expandAll() {
    setRound('round-1', true, false)
    setRound('round-2', true, false)
    $$('.brief').forEach((brief) => brief.classList.add('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '收起' })
    if (body) body.scrollTop = 0
    showToast('第 1 轮已展开：用户原话 + 派发原文')
  }

  function expandMaterials() {
    setRound('round-1', true, false)
    setRound('round-2', true, false)
    setAllItemMaterials(true)
    const target = document.getElementById('acc-2')
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    showToast('验收材料已全展开：每条验收项各自带材料')
  }

  const acts = {
    reset,
    expand: expandAll,
    materials: expandMaterials,
    lightbox: () => openLightbox('config'),
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
    if (event.key === '4') { expandMaterials(); return }
    if (event.key === '5') { openLightbox('config'); return }
    if (event.key.toLowerCase() === 't') { acts.theme(); return }
    if (event.key === 'Escape') {
      if (lightbox && !lightbox.hidden) { closeLightbox(); return }
      if (sheet && !sheet.hidden) { closeFileSheet(); return }
      if (composer && !composer.hidden) { closeComposer(); return }
    }
  })

  /* URL 参数：?expand=1 / ?compose=1 / ?materials=all / ?focus=materials / ?lightbox=1 */
  if (root.dataset.expand === '1') {
    setRound('round-1', true, false)
    if (goal) goal.classList.add('is-open')
    if (goalToggle) goalToggle.textContent = '收起'
    $$('.brief').forEach((brief) => brief.classList.add('is-expanded'))
    $$('.brief-toggle').forEach((button) => { button.textContent = '收起' })
  }
  if (root.dataset.materials === 'all') {
    setAllItemMaterials(true)
  }
  if (root.dataset.focus === 'materials') {
    window.setTimeout(() => {
      const target = document.getElementById('acc-2')
      if (target) {
        setAllItemMaterials(true)
        target.scrollIntoView({ behavior: 'auto', block: 'start' })
      }
    }, 60)
  }
  if (root.dataset.lightbox === '1') {
    window.setTimeout(() => openLightbox('config'), 120)
  }
  if (root.dataset.sheet === '1') {
    window.setTimeout(() => openFileSheet('Htdot 模型依赖清单.xlsx', '/Users/lzx/Htdot/model-deps.xlsx', '工作会话交付 · XLSX · 24 KB'), 120)
  }
  if (root.dataset.compose === '1') {
    window.setTimeout(openComposer, 60)
  }
})()
