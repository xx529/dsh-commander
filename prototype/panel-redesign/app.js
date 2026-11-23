/*
 * 指挥官面板 · 交互重设计原型（抛弃型）
 *
 * 问题：派发确认卡、审批卡目前都塞在对话流里，和消息抢注意力；绑定信息只有一枚
 *      「已绑定」pill；进行中的任务默认折叠。三套方案分别回答「这些状态该住在哪」：
 *
 *   A 待处理坞：窄面板 420×660，顶部固定「待你处理」坞 + 任务轨，对话区只放对话。
 *   B 双栏收件箱：600×660，左侧对话，右侧独立「待处理 / 任务」栏，绑定信息常显。
 *   C 处理抽屉：420×660，对话纯净，派发/审批收进底部抽屉，用角标 + 抽屉进入。
 *
 * 交互可点：采用建议 / 自定义 / 取消 / 允许 / 拒绝 / 任务展开 / 绑定浮层 / 抽屉。
 * 还原状态而非真实 Host：无持久化、无网络，所有变更是本地演示态。
 */
(function () {
  'use strict'

  const VARIANTS = [
    { key: 'A', name: '待处理坞', tag: '上方固定 · 对话归对话' },
    { key: 'B', name: '双栏收件箱', tag: '动作独立成栏' },
    { key: 'C', name: '处理抽屉', tag: '浮层处理 · 聊天纯净' }
  ]
  const params = new URLSearchParams(location.search)
  const html = document.documentElement
  const stage = document.getElementById('stage')
  const switcher = document.getElementById('switcher')
  const toastEl = document.getElementById('toast')
  const debugEl = document.getElementById('debug')
  const ball = document.getElementById('ball')
  const badgeEl = document.getElementById('ball-badge')

  const VERSION = 1
  const STORAGE_KEY = 'dshc-panel-redesign-v' + VERSION

  const TASK_LABEL = {
    running: '进行中', queued: '已排队', proposed: '待派发',
    blocked: '受阻', review: '待验收', done: '已完成'
  }
  const TASK_TONE = {
    running: 'run', queued: 'queued', proposed: 'warn',
    blocked: 'warn', review: 'ok', done: 'ok'
  }

  const WORKSPACES = [
    { id: 'agent-workspace', name: 'agent-workspace' },
    { id: 'htdot', name: 'HtDot' },
    { id: 'mira', name: 'Mira' }
  ]

  const APPROVALS = [
    {
      id: 'ap-1',
      task: '整理 rc.5 breaking changes 清单',
      session: '整理 rc.5 breaking changes',
      sessionId: '6c3c58e5',
      tool: 'Bash',
      cmd: 'pnpm --filter dsh-commander test',
      hint: '执行测试并回写结果'
    },
    {
      id: 'ap-2',
      task: '整理 rc.5 breaking changes 清单',
      session: '核对 rc.5 契约差异',
      sessionId: 'a41d9f22',
      tool: 'Edit',
      cmd: 'docs/HANDOVER.md',
      hint: '追加升级步骤 2 段'
    }
  ]

  function initialMessages () {
    return [
      {
        id: 'm1', role: 'user',
        text: '先看 rc.5 的 breaking changes。',
        at: '23:01'
      },
      {
        id: 'm2', role: 'ai',
        text: '拆成 changelog、插件契约、升级步骤三件事。确认目标后我再派发。',
        at: '23:02'
      },
      {
        id: 'm3', role: 'decision', action: 'custom',
        title: '已确认派发 · 自定义选择',
        target: 'agent-workspace / 已有会话 6c3c58e5',
        at: '23:03',
        raw: '[dispatch-confirm] 自定义\ndecisionId=dec_7a31c9e4402fbd0188a2c1\ntaskId=task_0e2b71c9a44f\ntarget=workspace:agent-workspace;mode:attach;sessionId=6c3c58e5'
      },
      {
        id: 'm4', role: 'event',
        text: '工作会话回报 · 找到 2 处 breaking change',
        at: '23:06'
      },
      {
        id: 'm5', role: 'ai',
        text: '回报：缺 `output.render` 会被运行时拒绝。',
        at: '23:07'
      }
    ]
  }

  function makeState () {
    return {
      variant: readVariant(params.get('variant')),
      theme: params.get('theme') === 'light' ? 'light' : 'dark',
      ballStyle: params.get('ball') === 'ink' ? 'ink' : 'blue',
      panelOpen: true,
      debug: false,
      connection: params.get('conn') === 'polling' ? 'polling' : 'live',
      noticeDismissed: false,
      bindingOpen: false,
      tasksOpen: false,
      dockTab: 'dispatch',
      dockCollapsed: false,
      detailsOpen: false,
      railTab: 'pending',
      sheetOpen: params.get('sheet') === '1',
      dispatch: { phase: 'open' },
      approvalIndex: 0,
      approvals: APPROVALS.map(item => ({ ...item })),
      tasks: [
        {
          id: 'task_1',
          title: '整理 rc.5 breaking changes 清单',
          workspace: 'agent-workspace',
          status: 'running',
          pct: 45,
          note: '2 分钟前更新'
        },
        {
          id: 'task_2',
          title: '调研 DSH 0.2.2-rc.5 的更新内容与升级兼容性',
          workspace: 'agent-workspace',
          status: 'proposed',
          pct: 0,
          note: '等待确认派发目标'
        }
      ],
      custom: { workspace: 'agent-workspace', mode: 'new', session: 'sess_6c3c58e5' },
      messages: initialMessages(),
      openRecords: [],
      draft: '',
      busy: false,
      seq: 10,
      toast: null
    }
  }

  let state = makeState()
  let toastTimer = 0

  function readVariant (raw) {
    const key = String(raw || 'C').toUpperCase()
    return VARIANTS.some(v => v.key === key) ? key : 'C'
  }

  /* ------------------------------------------------------------------ utils */
  function esc (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]))
  }

  function fmt (text) {
    return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
  }

  function icon (name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>'
  }

  function nowTime () {
    try {
      return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    } catch (err) {
      return '23:09'
    }
  }

  function uid (prefix) {
    state.seq += 1
    return prefix + '_' + state.seq
  }

  function addClassIf (value, cls) {
    return value ? cls : ''
  }

  /* ---------------------------------------------------------------- derived */
  function dispatchActive () {
    return state.dispatch.phase === 'open' || state.dispatch.phase === 'custom'
  }

  function dispatchVisible () {
    const phase = state.dispatch.phase
    return phase !== 'resolved' && phase !== 'cancelled'
  }

  function pendingCount () {
    return (dispatchActive() ? 1 : 0) + state.approvals.length
  }

  function runningTasks () {
    return state.tasks.filter(task => task.status === 'running')
  }

  function waitingTasks () {
    return state.tasks.filter(task => task.status === 'proposed' || task.status === 'queued')
  }

  function primaryTask () {
    return runningTasks()[0] || state.tasks[0]
  }

  function activeApproval () {
    return state.approvals[Math.min(state.approvalIndex, state.approvals.length - 1)]
  }

  function live () {
    return state.connection === 'live'
  }

  function connLabel () {
    return live() ? '实时同步' : '3 秒快照'
  }

  function pendingHint () {
    const s = state.dispatch.phase
    if (s === 'sending') return '发送中…'
    if (s === 'sent') return '等待回执'
    return pendingCount()
  }

  /* --------------------------------------------------------------- actions */
  function showToast (text, tone) {
    if (toastTimer) clearTimeout(toastTimer)
    state.toast = { text: text, tone: tone || 'ok' }
    renderToast()
    toastTimer = setTimeout(function () {
      toastTimer = 0
      state.toast = null
      renderToast()
    }, 2800)
  }

  function setVariant (key) {
    if (state.variant === key) return
    state.variant = key
    state.bindingOpen = false
    syncURL()
    render()
  }

  function cycleVariant (delta) {
    const index = VARIANTS.findIndex(v => v.key === state.variant)
    const next = (index + delta + VARIANTS.length) % VARIANTS.length
    setVariant(VARIANTS[next].key)
  }

  function resetDemo () {
    const keep = { variant: state.variant, theme: state.theme, debug: state.debug, ballStyle: state.ballStyle }
    state = makeState()
    state.variant = keep.variant
    state.theme = keep.theme
    state.debug = keep.debug
    state.ballStyle = keep.ballStyle
    syncURL()
    render()
    showToast('演示已重置 · 派发确认 / 2 条审批 / 1 条进行中任务')
  }

  function togglePanel () {
    state.panelOpen = !state.panelOpen
    if (state.panelOpen && state.variant === 'C' && pendingCount() > 0) state.sheetOpen = true
    render()
  }

  function toggleTheme () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark'
    syncURL()
    render()
  }

  function openBinding () {
    state.bindingOpen = true
    state.sheetOpen = false
    render()
  }

  function closePopover () {
    if (!state.bindingOpen) return
    state.bindingOpen = false
    render()
  }

  function dismissNotice () {
    state.noticeDismissed = true
    render()
  }

  function retryConnection () {
    state.connection = 'live'
    state.noticeDismissed = true
    render()
    showToast('已恢复实时同步')
  }

  function adoptDispatch () {
    sendDispatch('adopt', { workspace: 'agent-workspace', mode: 'new' })
  }

  function openCustom () {
    if (state.dispatch.phase !== 'open') return
    state.dispatch.phase = 'custom'
    state.detailsOpen = false
    render()
  }

  function backCustom () {
    if (state.dispatch.phase !== 'custom') return
    state.dispatch.phase = 'open'
    render()
  }

  function confirmCustom () {
    if (state.dispatch.phase !== 'custom') return
    if (state.custom.mode === 'attach' && !state.custom.session) return
    sendDispatch('custom', {
      workspace: state.custom.workspace,
      mode: state.custom.mode,
      session: state.custom.session
    })
  }

  function sendDispatch (action, target) {
    if (state.dispatch.phase !== 'open' && state.dispatch.phase !== 'custom') return
    state.dispatch.phase = 'sending'
    state.busy = true
    state.detailsOpen = false
    render()

    setTimeout(function () {
      if (state.dispatch.phase !== 'sending') return
      state.dispatch.phase = 'sent'
      state.dispatch.target = target
      state.busy = false
      addDecision(action, target)
      addAssistant(ackText(action, target))
      render()
      showToast('已发送确认 · 等待指挥官回执', 'ok')

      setTimeout(function () {
        if (state.dispatch.phase !== 'sent') return
        state.dispatch.phase = 'resolved'
        const task = state.tasks.find(item => item.id === 'task_2')
        if (task) {
          task.status = 'running'
          task.pct = 12
          task.note = '刚刚开始 · 已创建新会话'
        }
        render()
        showToast('任务已创建并开始运行 · 看板已更新')
        maybeCloseSheet()
      }, 3200)
    }, 680)
  }

  function cancelDispatch () {
    if (state.dispatch.phase !== 'open' && state.dispatch.phase !== 'custom') return
    state.dispatch.phase = 'cancelled'
    addDecision('cancel', null)
    addAssistant('已取消这次派发。需要调整目标时告诉我。')
    render()
    showToast('已取消派发', 'warn')
    maybeCloseSheet()
  }

  function ackText (action, target) {
    if (action === 'adopt') {
      return '收到，已按「采用建议」派发到 agent-workspace / 新建会话。任务创建后我会在这里更新状态。'
    }
    const mode = target && target.mode === 'attach'
      ? '已有会话 ' + (target.session || '').replace('sess_', '')
      : '新建会话'
    return '收到，已按自定义目标派发到 ' + (target ? target.workspace : 'agent-workspace') + ' / ' + mode + '。任务创建后我会在这里更新状态。'
  }

  function addAssistant (text) {
    state.messages.push({ id: uid('m'), role: 'ai', text: text, at: nowTime() })
  }

  function addDecision (action, target) {
    const isCustom = action === 'custom'
    const isCancel = action === 'cancel'
    const workspace = target ? target.workspace : 'agent-workspace'
    const mode = isCancel ? 'cancel' : (target && target.mode === 'attach' ? 'attach' : 'new')
    const session = target && target.session ? target.session : ''
    const title = isCancel
      ? '已取消派发'
      : isCustom ? '已确认派发 · 自定义选择' : '已确认派发 · 采用建议'
    const targetText = isCancel
      ? workspace
      : workspace + ' / ' + (mode === 'attach' ? '已有会话 ' + session.replace('sess_', '') : '新建会话')
    const raw = [
      '[dispatch-confirm] ' + (isCancel ? '取消' : isCustom ? '自定义' : '采用建议'),
      'decisionId=dec_5d9c40117c7af00150457f',
      'taskId=task_mwm9391f6e58d',
      'target=workspace:' + workspace + ';mode:' + mode + (mode === 'attach' && session ? ';sessionId=' + session : '')
    ].join('\n')
    state.messages.push({
      id: uid('m'),
      role: 'decision',
      action: action,
      title: title,
      target: targetText,
      at: nowTime(),
      raw: raw
    })
  }

  function answerApproval (allow, id) {
    const item = id ? state.approvals.find(row => row.id === id) : activeApproval()
    if (!item) return
    const removedIndex = state.approvals.findIndex(row => row.id === item.id)
    state.approvals = state.approvals.filter(row => row.id !== item.id)
    if (state.approvalIndex >= state.approvals.length) {
      state.approvalIndex = Math.max(0, state.approvals.length - 1)
    } else if (removedIndex >= 0 && removedIndex < state.approvalIndex) {
      state.approvalIndex -= 1
    }
    if (state.approvals.length === 0) state.dockTab = 'dispatch'
    if (state.approvals.length === 0 && state.railTab === 'pending' && !dispatchVisible()) state.railTab = 'tasks'
    render()
    showToast(allow ? '已允许本次 · 仅界面处理，不进入指挥官上下文' : '已拒绝 · 工作会话会收到结果', allow ? 'ok' : 'warn')
    maybeCloseSheet()
  }

  function stepApproval (delta) {
    const next = state.approvalIndex + delta
    if (next < 0 || next >= state.approvals.length) return
    state.approvalIndex = next
    render()
  }

  function maybeCloseSheet () {
    if (state.variant !== 'C' || !state.sheetOpen) return
    if (state.approvals.length > 0) return
    if (dispatchActive()) return
    setTimeout(function () {
      if (state.variant !== 'C' || !state.sheetOpen) return
      if (state.approvals.length > 0 || dispatchActive()) return
      state.sheetOpen = false
      render()
    }, 900)
  }

  function submitComposer () {
    const text = state.draft.trim()
    if (!text || state.busy) return
    state.messages.push({ id: uid('m'), role: 'user', text: text, at: nowTime() })
    state.draft = ''
    state.busy = true
    render()
    setTimeout(function () {
      state.busy = false
      addAssistant('收到。我先确认当前任务的执行状态，稍后把结果整理到看板。')
      render()
    }, 1050)
  }

  function toggleRecord (id) {
    if (!id) return
    const index = state.openRecords.indexOf(id)
    if (index >= 0) state.openRecords.splice(index, 1)
    else state.openRecords.push(id)
    render()
  }

  function syncURL () {
    const query = new URLSearchParams()
    query.set('variant', state.variant)
    if (state.theme === 'light') query.set('theme', 'light')
    if (!live()) query.set('conn', 'polling')
    try {
      history.replaceState(null, '', '?' + query.toString())
    } catch (err) { /* file:// 下个别浏览器会拒绝，忽略 */ }
  }

  /* ----------------------------------------------------------------- render */
  function render () {
    syncURL()
    html.setAttribute('data-theme', state.theme)
    html.setAttribute('data-variant', state.variant)

    const active = document.activeElement
    const composerFocused = !!(active && active.matches && active.matches('[data-composer]'))

    stage.innerHTML = state.panelOpen ? renderPanel() : ''
    const count = pendingCount()
    ball.setAttribute('aria-expanded', state.panelOpen ? 'true' : 'false')
    ball.setAttribute('aria-label', (state.panelOpen ? '收起指挥官面板' : '打开指挥官') + (count > 0 ? '，' + count + ' 项待处理' : ''))
    ball.setAttribute('data-open', state.panelOpen ? 'true' : 'false')
    ball.setAttribute('data-style', state.ballStyle)
    ball.setAttribute('data-conn', state.connection)
    ball.setAttribute('data-busy', state.busy ? 'true' : 'false')
    badgeEl.hidden = count === 0
    badgeEl.textContent = String(count)
    const labelSub = document.getElementById('ball-label-sub')
    if (labelSub) {
      labelSub.textContent = count > 0
        ? count + ' 项待处理'
        : state.busy ? '正在处理' : live() ? '等待指令' : '快照同步'
      labelSub.setAttribute('data-tone', count > 0 || !live() ? 'warn' : 'muted')
    }
    switcher.innerHTML = renderSwitcher()
    debugEl.hidden = !state.debug
    if (state.debug) debugEl.textContent = debugText()
    renderToast()

    if (state.panelOpen) {
      hydrateComposer(composerFocused)
      const transcript = stage.querySelector('.transcript')
      if (transcript) transcript.scrollTop = transcript.scrollHeight
      hydrateTranscript()
      const sheetBody = stage.querySelector('.sheet-body')
      if (sheetBody && state.sheetOpen) sheetBody.scrollTop = 0
    }
  }

  function renderPanel () {
    if (state.variant === 'B') return renderB()
    if (state.variant === 'C') return renderC()
    return renderA()
  }

  function renderSwitcher () {
    const current = VARIANTS.find(v => v.key === state.variant) || VARIANTS[0]
    return '' +
      '<span class="proto">PROTOTYPE</span>' +
      '<button class="sw-arrow" type="button" data-act="prev" title="上一个方案（←）" aria-label="上一个方案">' + icon('left') + '</button>' +
      '<div class="sw-label"><b>' + current.key + '</b><span>' + current.name + '</span><em>' + current.tag + '</em></div>' +
      '<button class="sw-arrow" type="button" data-act="next" title="下一个方案（→）" aria-label="下一个方案">' + icon('right') + '</button>' +
      '<span class="sw-div"></span>' +
      '<button class="sw-tool" type="button" data-act="reset" title="重置演示状态（R）">重置</button>' +
      '<button class="sw-tool" type="button" data-act="conn" title="模拟 SSE 断线，查看提示框">' + (live() ? '断线' : '重连') + '</button>' +
      '<button class="sw-tool" type="button" data-act="theme" title="切换明暗主题">' + (state.theme === 'dark' ? '浅色' : '深色') + '</button>' +
      '<button class="sw-tool" type="button" data-act="debug" aria-pressed="' + (state.debug ? 'true' : 'false') + '" title="显示本地状态（D）">状态</button>' +
      '<span class="sw-hint">← →</span>'
  }

  function renderToast () {
    toastEl.hidden = !state.toast
    if (!state.toast) {
      toastEl.innerHTML = ''
      return
    }
    toastEl.setAttribute('data-tone', state.toast.tone || 'ok')
    toastEl.innerHTML = icon('check') + '<span>' + esc(state.toast.text) + '</span>'
  }

  function debugText () {
    return JSON.stringify({
      variant: state.variant,
      panelOpen: state.panelOpen,
      connection: state.connection,
      dispatch: state.dispatch.phase,
      pending: pendingCount(),
      approvals: state.approvals.length,
      tasks: state.tasks.map(task => task.status + ' ' + task.pct + '%'),
      messages: state.messages.length,
      sheetOpen: state.sheetOpen,
      dockTab: state.dockTab,
      railTab: state.railTab,
      custom: state.custom
    }, null, 2)
  }

  /* -------------------------------------------------------------- fragments */
  function pendingChip () {
    const count = pendingCount()
    if (count === 0) return ''
    return '<button class="pending-chip" type="button" data-act="focus-pending" title="查看需要你处理的事项"><span class="dot"></span>待处理 ' + count + '</button>'
  }

  function header (opts) {
    const showPending = !opts || opts.pending !== false
    const bindingLine = opts && opts.binding
      ? '<button class="bind-line" type="button" data-act="open-binding" aria-haspopup="dialog">' +
          '<span class="dot" data-tone="' + (live() ? '' : 'warn') + '"></span>' +
          '<span>已绑定</span><span class="sep">·</span>' +
          '<span class="name">调研 DSH 0.2.2-rc.5</span>' + icon('down') +
        '</button>'
      : '<span class="p-title">指挥官</span>'
    return '' +
      '<header class="p-head">' +
        '<span class="p-mark">' + icon('flag') + '</span>' +
        '<div class="p-headtext">' + (opts && opts.binding ? '<span class="p-title">指挥官</span>' : '') + bindingLine + '</div>' +
        '<div class="p-head-actions">' +
          (showPending ? pendingChip() : '') +
          '<button class="icon-btn" type="button" data-act="board" title="打开看板">' + icon('board') + '</button>' +
          '<button class="icon-btn" type="button" data-act="close-panel" title="关闭面板（Esc）">' + icon('close') + '</button>' +
        '</div>' +
      '</header>'
  }

  function noticeHTML () {
    if (live() || state.noticeDismissed) return ''
    return '' +
      '<div class="notice" role="status">' +
        icon('alert') +
        '<span class="notice-text"><b>实时连接已断开</b> · 正在读取 3 秒快照</span>' +
        '<button class="btn sm" type="button" data-v="ghost" data-act="notice-retry">重试</button>' +
        '<button class="btn sm icon-only" type="button" data-v="ghost" data-act="notice-dismiss" title="忽略这条提示" aria-label="忽略提示">' + icon('close') + '</button>' +
      '</div>'
  }

  function dispatchCard (context) {
    const phase = state.dispatch.phase
    const showRecommendation = phase !== 'custom'
    const targetChips = '<span class="chip" data-tone="ws">' + icon('folder') + 'agent-workspace</span>' +
      '<span class="chip">' + icon('msg') + '新建会话</span>' +
      (context === 'rail' ? '' : '<span class="chip" data-tone="ok">' + icon('check') + '白名单内</span>')
    const expired = false
    const border = ''
    const headRight = (phase === 'open' || phase === 'custom')
      ? '<span class="act-timer" data-tone="' + (expired ? 'warn' : '') + '">剩余 01:15</span>' +
        (phase === 'custom' ? '' : '<button class="icon-btn" type="button" style="width:22px;height:22px" data-act="details" title="候选目标与决策依据" aria-expanded="' + (state.detailsOpen ? 'true' : 'false') + '">' + icon('more') + '</button>')
      : (phase === 'sent' ? '<span class="act-timer">等待回执</span>' : '')

    return '' +
      '<article class="act' + (context === 'rail' ? ' rail-card' : '') + '" data-kind="dispatch" data-phase="' + phase + '">' +
        '<div class="act-head">' +
          '<span class="act-kind">' + icon('branch') + '派发确认</span>' +
          '<div class="act-head-right">' + headRight + '</div>' +
        '</div>' +
        '<div class="act-title">调研 DSH 0.2.2-rc.5 的更新内容与升级兼容性</div>' +
        (showRecommendation
          ? '<div class="act-target">' + targetChips + '</div>' +
            '<div class="act-conf"><span>置信度 <b>62%</b> · 阈值 80%</span><span>Jev pMax</span></div>' +
            '<div class="meter"><i style="width:62%"></i><b style="left:80%"></b></div>' +
            '<div class="act-reason">只有 agent-workspace 同时满足白名单与能力要求。</div>' +
            (state.detailsOpen ? dispatchDetails() : '')
          : '') +
        dispatchBody(context, phase) +
      '</article>'
  }

  function dispatchDetails () {
    return '' +
      '<div class="act-details">' +
        '<div class="cand" data-rec="true"><span class="cand-name">agent-workspace</span><span class="cand-mode">新建会话</span><span class="cand-pct">62%</span></div>' +
        '<div class="cand"><span class="cand-name">HtDot</span><span class="cand-mode">新建会话</span><span class="cand-pct">28%</span></div>' +
        '<div class="cand"><span class="cand-name">Mira</span><span class="cand-mode">已有会话 · 6c3c58e5</span><span class="cand-pct">10%</span></div>' +
        '<div class="act-note">决策 jev · 0.62 / 阈值 0.80 · 低置信度必须人工确认</div>' +
      '</div>'
  }

  function dispatchBody (context, phase) {
    if (phase === 'sending') {
      return '<div class="act-status"><span class="spinner"></span>正在发送确认…</div>'
    }
    if (phase === 'sent') {
      return '<div class="act-status"><span class="spinner"></span>已发送确认，等待指挥官处理…</div>'
    }
    if (phase === 'custom') {
      return customForm(context)
    }
    return '' +
      '<div class="act-actions">' +
        '<button class="btn" type="button" data-v="secondary" data-act="custom">自定义选择</button>' +
        '<button class="btn" type="button" data-v="primary" data-act="adopt">采用建议</button>' +
        '<button class="btn" type="button" data-v="ghost" data-act="cancel">取消</button>' +
      '</div>'
  }

  function customForm (context) {
    const attach = state.custom.mode === 'attach'
    const sessionOptions = [
      { id: 'sess_6c3c58e5', label: '6c3c58e5 · 调研 DSH 0.2.2-rc.5' },
      { id: 'sess_a41d9f22', label: 'a41d9f22 · 核对 rc.5 契约差异' },
      { id: 'sess_5b28d0e1', label: '5b28d0e1 · 整理 breaking changes' }
    ]
    return '' +
      '<div class="form">' +
        '<label class="field"><span>工作区</span><span class="select-wrap">' +
          '<select data-field="workspace">' +
            WORKSPACES.map(row => '<option value="' + row.id + '"' + (row.id === state.custom.workspace ? ' selected' : '') + '>' + row.name + '</option>').join('') +
          '</select>' + icon('down') +
        '</span></label>' +
        '<div class="field"><span>会话</span>' +
          '<div class="seg">' +
            '<button type="button" data-act="custom-mode" data-mode="new" data-on="' + (!attach) + '">新建会话</button>' +
            '<button type="button" data-act="custom-mode" data-mode="attach" data-on="' + attach + '">已有会话</button>' +
          '</div>' +
        '</div>' +
        (attach
          ? '<label class="field"><span>选择会话</span><span class="select-wrap">' +
              '<select data-field="session">' +
                sessionOptions.map(row => '<option value="' + row.id + '"' + (row.id === state.custom.session ? ' selected' : '') + '>' + row.label + '</option>').join('') +
              '</select>' + icon('down') +
            '</span></label>'
          : '') +
        '<div class="form-actions">' +
          '<button class="btn" type="button" data-v="ghost" data-act="custom-back">返回</button>' +
          '<button class="btn" type="button" data-v="primary" data-act="custom-confirm">确认派发</button>' +
        '</div>' +
      '</div>'
  }

  function approvalCard (item, context, opts) {
    const index = state.approvals.findIndex(row => row.id === item.id)
    const total = state.approvals.length
    const queue = opts && opts.queue && total > 1
      ? '<div class="queue-nav">' +
          '<button type="button" data-act="approval-prev" title="上一条审批" aria-label="上一条审批"' + (index <= 0 ? ' disabled' : '') + '>' + icon('left') + '</button>' +
          '<span>' + (index + 1) + '/' + total + '</span>' +
          '<button type="button" data-act="approval-next" title="下一条审批" aria-label="下一条审批"' + (index >= total - 1 ? ' disabled' : '') + '>' + icon('right') + '</button>' +
        '</div>'
      : ''
    const openBtn = context === 'rail'
      ? '<button class="icon-btn" type="button" data-act="open-session" title="打开工作会话" aria-label="打开工作会话">' + icon('external') + '</button>'
      : '<button class="btn" type="button" data-v="ghost" data-act="open-session">' + icon('external') + '打开会话</button>'
    return '' +
      '<article class="act' + (context === 'rail' ? ' rail-card' : '') + '" data-kind="approval">' +
        '<div class="act-head">' +
          '<span class="act-kind">' + icon('shield') + '工作会话审批</span>' +
          '<div class="act-head-right">' + queue + '<span class="act-timer">仅在界面处理</span>' + (context === 'rail' ? openBtn : '') + '</div>' +
        '</div>' +
        '<div class="act-title">' + esc(item.task) + '</div>' +
        '<div class="cmd"><span class="tool">' + esc(item.tool) + '</span><code>' + esc(item.cmd) + '</code></div>' +
        '<div class="act-meta"><span>会话 ' + esc(item.session) + '</span>' + (context === 'rail' ? '' : '<span>' + esc(item.hint) + '</span>') + '</div>' +
        '<div class="act-actions">' +
          (context === 'rail' ? '' : openBtn + '<span class="spacer"></span>') +
          '<button class="btn" type="button" data-v="secondary" data-act="reject" data-approval="' + esc(item.id) + '">拒绝</button>' +
          '<button class="btn" type="button" data-v="primary" data-act="allow" data-approval="' + esc(item.id) + '">允许本次</button>' +
        '</div>' +
      '</article>'
  }

  function transcriptHTML () {
    return state.messages.map(messageHTML).join('') +
      (state.busy ? '<div class="msg msg-ai"><div class="msg-author"><span class="av">' + icon('flag') + '</span>指挥官</div><div class="typing"><i></i><i></i><i></i></div></div>' : '')
  }

  function transcriptShell (inner, extra) {
    return '<div class="transcript-shell"><div class="transcript' + (extra ? ' ' + extra : '') + '">' + inner + '</div></div>'
  }

  function messageHTML (message) {
    if (message.role === 'user') {
      return '<div class="msg msg-user"><div class="bubble">' + fmt(message.text) + '</div><span class="msg-time">' + esc(message.at) + '</span></div>'
    }
    if (message.role === 'ai') {
      return '<div class="msg msg-ai">' +
        '<div class="msg-author"><span class="av">' + icon('flag') + '</span>指挥官<span class="msg-time">' + esc(message.at) + '</span></div>' +
        '<div class="text">' + fmt(message.text) + '</div>' +
      '</div>'
    }
    if (message.role === 'event') {
      return '<div class="event"><span class="line"></span>' + icon('check') + '<span>' + esc(message.text) + '</span><span class="line"></span></div>'
    }
    if (message.role === 'decision') {
      const open = state.openRecords.indexOf(message.id) >= 0
      return '<div class="rec">' +
        '<button class="rec-head" type="button" data-act="toggle-record" data-id="' + esc(message.id) + '" aria-expanded="' + open + '">' +
          '<span class="ok">' + icon('check') + '</span>' +
          '<span class="rec-title">' + esc(message.title) + '</span>' +
          '<span class="rec-meta">' + esc(message.target) + '</span>' +
          '<span class="rec-time">' + esc(message.at) + '</span>' +
          icon('down', 'chev') +
        '</button>' +
        (open
          ? '<div class="rec-raw"><div class="cap">发给指挥官的协议消息 · 保留可审计</div><pre>' + esc(message.raw) + '</pre></div>'
          : '') +
      '</div>'
    }
    return ''
  }

  function composerHTML (extra) {
    const hint = state.busy
      ? '指挥官正在处理…'
      : live() ? '实时同步 · 审批仅在界面处理' : '轮询同步 · 3 秒快照'
    const tone = state.busy ? '' : live() ? 'ok' : 'warn'
    const disabled = state.busy || state.draft.trim() === ''
    return '' +
      '<footer class="composer' + (extra ? ' ' + extra : '') + '">' +
        '<div class="compose-box">' +
          '<textarea data-composer rows="1" placeholder="输入指令，Enter 发送，Shift+Enter 换行" aria-label="给指挥官下指令">' + esc(state.draft) + '</textarea>' +
          '<div class="compose-row">' +
            '<span class="compose-hint" data-tone="' + tone + '">' + esc(hint) + '</span>' +
            '<button class="btn" type="button" data-v="primary" data-act="send"' + (disabled ? ' disabled' : '') + '>' + (state.busy ? '发送中…' : '发送') + '</button>' +
          '</div>' +
        '</div>' +
      '</footer>'
  }

  function bindPopover () {
    return '' +
      '<div class="pop-layer">' +
        '<div class="pop-scrim" data-act="close-popover"></div>' +
        '<div class="pop" role="dialog" aria-label="绑定信息">' +
          '<div class="pop-head"><span class="pop-title">绑定信息</span><span class="pop-sub">只读 · 来自 Host</span>' +
            '<button class="icon-btn" type="button" data-act="close-popover" title="关闭">' + icon('close') + '</button>' +
          '</div>' +
          '<dl class="bind-grid">' +
            '<dt>会话</dt><dd>调研 DSH 0.2.2-rc.5<br><span class="mono">6c3c58e5 · 23:03 创建</span></dd>' +
            '<dt>工作区</dt><dd>agent-workspace <span class="muted">/ 可写</span></dd>' +
            '<dt>模型</dt><dd>deepseek-chat <span class="muted">· 推理 中</span></dd>' +
            '<dt>连接</dt><dd><span class="state"><span class="dot"></span>已绑定 · ' + connLabel() + '</span></dd>' +
          '</dl>' +
          '<div class="pop-actions">' +
            '<button class="btn" type="button" data-v="ghost" data-act="open-session">' + icon('external') + '打开会话</button>' +
            '<button class="btn" type="button" data-v="secondary" data-act="rebind">换绑…</button>' +
          '</div>' +
        '</div>' +
      '</div>'
  }

  function statusPopover () {
    const running = runningTasks()
    return '' +
      '<div class="pop-layer">' +
        '<div class="pop-scrim" data-act="close-popover"></div>' +
        '<div class="pop" role="dialog" aria-label="指挥状态">' +
          '<div class="pop-head"><span class="pop-title">指挥状态</span><span class="pop-sub">绑定 · 任务 · 连接</span>' +
            '<button class="icon-btn" type="button" data-act="close-popover" title="关闭">' + icon('close') + '</button>' +
          '</div>' +
          '<div class="status-block">' +
            '<div class="status-label">绑定 <b>已绑定</b></div>' +
            '<dl class="bind-grid">' +
              '<dt>会话</dt><dd>调研 DSH 0.2.2-rc.5<br><span class="mono">6c3c58e5</span></dd>' +
              '<dt>工作区</dt><dd>agent-workspace</dd>' +
              '<dt>模型</dt><dd>deepseek-chat</dd>' +
            '</dl>' +
            '<div class="pop-actions">' +
              '<button class="btn" type="button" data-v="ghost" data-act="open-session">' + icon('external') + '打开会话</button>' +
              '<button class="btn" type="button" data-v="secondary" data-act="rebind">换绑…</button>' +
            '</div>' +
          '</div>' +
          '<div class="status-block">' +
            '<div class="status-label">任务 <b>进行中 ' + running.length + '</b></div>' +
            state.tasks.map(task =>
              '<div class="status-task">' +
                '<span class="chip" data-tone="' + (TASK_TONE[task.status] || 'queued') + '">' + (TASK_LABEL[task.status] || task.status) + '</span>' +
                '<span class="name">' + esc(task.title) + '</span>' +
                '<span class="st">' + (task.status === 'running' ? task.pct + '%' : '') + '</span>' +
              '</div>'
            ).join('') +
          '</div>' +
          '<div class="status-block">' +
            '<div class="status-label">连接</div>' +
            '<div class="status-task"><span>' + (live() ? '实时同步 · SSE' : '轮询快照 · 3 秒') + '</span>' +
              (live() ? '' : '<span class="st"><button class="link-btn" type="button" data-act="notice-retry">重试</button></span>') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
  }

  /* ------------------------------------------------------------- variant A */
  function renderA () {
    const tabs = dispatchVisible() && state.approvals.length > 0
    const active = dockTabActive()
    return '' +
      '<section class="panel panel-a" role="dialog" aria-label="指挥官">' +
        header({ binding: true }) +
        noticeHTML() +
        (dispatchVisible() || state.approvals.length > 0
          ? dockHTML(tabs, active)
          : '') +
        taskRailHTML() +
        transcriptShell(transcriptHTML()) +
        composerHTML() +
        (state.bindingOpen ? bindPopover() : '') +
      '</section>'
  }

  function dockTabActive () {
    if (state.dockTab === 'approval' && state.approvals.length > 0) return 'approval'
    if (dispatchVisible()) return 'dispatch'
    if (state.approvals.length > 0) return 'approval'
    return null
  }

  function dockHTML (tabs, active) {
    const waitingOnly = pendingCount() === 0 && state.dispatch.phase === 'sent'
    const title = waitingOnly
      ? '<span class="dock-title"><span class="pulse"></span>派发处理中</span>'
      : '<span class="dock-title"><span class="pulse"></span>需要你处理 <b>' + pendingCount() + '</b></span>'
    let tabsHTML = ''
    if (tabs) {
      tabsHTML = '<div class="dock-tabs">' +
        (dispatchVisible()
          ? '<button type="button" data-act="dock-tab" data-tab="dispatch" data-on="' + (active === 'dispatch') + '">派发确认' + (state.dispatch.phase === 'sent' ? ' · 等待' : '') + '</button>'
          : '') +
        (state.approvals.length > 0
          ? '<button type="button" data-act="dock-tab" data-tab="approval" data-on="' + (active === 'approval') + '">审批<span class="count">' + state.approvals.length + '</span></button>'
          : '') +
      '</div>'
    }
    return '' +
      '<div class="dock" data-collapsed="' + (state.dockCollapsed ? 'true' : 'false') + '">' +
        '<div class="dock-head">' +
          title +
          tabsHTML +
          '<button class="icon-btn" type="button" data-act="dock-collapse" title="' + (state.dockCollapsed ? '展开待处理' : '收起待处理') + '" aria-label="' + (state.dockCollapsed ? '展开待处理' : '收起待处理') + '">' + icon(state.dockCollapsed ? 'down' : 'up') + '</button>' +
        '</div>' +
        '<div class="dock-body">' +
          (active === 'approval' && state.approvals.length > 0
            ? approvalCard(activeApproval(), 'dock', { queue: true })
            : dispatchVisible() ? dispatchCard('dock') : '') +
        '</div>' +
      '</div>'
  }

  function taskRailHTML () {
    const running = runningTasks().length
    const waiting = waitingTasks().length
    const waitingLabel = state.tasks.some(task => task.status === 'proposed') ? '待派发' : '排队'
    const current = primaryTask()
    if (!current) return ''
    return '' +
      '<div class="taskrail">' +
        '<button class="taskrail-head" type="button" data-act="toggle-tasks" aria-expanded="' + (state.tasksOpen ? 'true' : 'false') + '">' +
          '<span class="live"></span>' +
          '<span class="count">进行中 ' + running + '</span>' +
          (waiting > 0 ? '<span>· ' + waitingLabel + ' ' + waiting + '</span>' : '') +
          '<span class="divider"></span>' +
          '<span class="current">' + esc(current.title) + '</span>' +
          (current.status === 'running' ? '<span class="pct">' + current.pct + '%</span>' : '') +
          (running > 1 ? '<span class="more">+' + (running - 1) + '</span>' : '') +
          icon(state.tasksOpen ? 'up' : 'down') +
        '</button>' +
        (state.tasksOpen
          ? '<div class="taskrail-rows">' + state.tasks.map(task =>
              '<button class="task-row" type="button" data-act="open-task" data-id="' + esc(task.id) + '" title="打开任务会话">' +
                '<span class="chip" data-tone="' + (TASK_TONE[task.status] || 'queued') + '">' + (TASK_LABEL[task.status] || task.status) + '</span>' +
                '<span class="t-name">' + esc(task.title) + '</span>' +
                '<span class="t-ws">' + esc(task.workspace) + '</span>' +
                (task.status === 'running' ? '<span class="t-pct">' + task.pct + '%</span>' : '') +
              '</button>'
            ).join('') + '</div>'
          : '') +
      '</div>'
  }

  /* ------------------------------------------------------------- variant B */
  function renderB () {
    const pending = pendingCount()
    return '' +
      '<section class="panel panel-b" role="dialog" aria-label="指挥官">' +
        header({ binding: false }) +
        '<div class="b-bind">' +
          '<div class="b-bind-item session">' +
            '<label>指挥官会话</label>' +
            '<strong><span class="dot"></span>调研 DSH 0.2.2-rc.5</strong>' +
          '</div>' +
          '<div class="b-bind-item workspace">' +
            '<label>工作区</label>' +
            '<strong class="mono">agent-workspace</strong>' +
          '</div>' +
          '<div class="b-bind-item model">' +
            '<label>模型</label>' +
            '<strong>deepseek-chat</strong>' +
          '</div>' +
          '<button class="btn sm" type="button" data-v="ghost" data-act="rebind">换绑</button>' +
        '</div>' +
        '<div class="b-body">' +
          '<div class="b-chat">' +
            noticeHTML() +
            transcriptShell(transcriptHTML()) +
            composerHTML() +
          '</div>' +
          '<aside class="b-rail" aria-label="待处理与任务">' +
            '<div class="rail-head">' +
              '<div class="rail-tabs">' +
                '<button type="button" data-act="rail-tab" data-tab="pending" data-on="' + (state.railTab !== 'tasks') + '">待处理' + (pending > 0 ? '<span class="count">' + pending + '</span>' : '') + '</button>' +
                '<button type="button" data-act="rail-tab" data-tab="tasks" data-on="' + (state.railTab === 'tasks') + '">任务<span class="count">' + state.tasks.length + '</span></button>' +
              '</div>' +
            '</div>' +
            '<div class="rail-scroll">' +
              (state.railTab === 'tasks' ? railTasks() : railPending()) +
            '</div>' +
            '<div class="rail-foot"><span class="dot"></span>' + (live() ? '实时同步 · 已绑定' : '快照同步 · 3 秒') + '</div>' +
          '</aside>' +
        '</div>' +
      '</section>'
  }

  function railPending () {
    if (!dispatchVisible() && state.approvals.length === 0) {
      return '<div class="rail-empty">' + icon('check') + '全部处理完 · 指挥官会继续跟进</div>'
    }
    return '' +
      (dispatchVisible() ? dispatchCard('rail') : '') +
      state.approvals.map(item => approvalCard(item, 'rail')).join('')
  }

  function railTasks () {
    return state.tasks.map(task =>
      '<button class="rail-task" type="button" data-act="open-task" data-id="' + esc(task.id) + '" style="text-align:left">' +
        '<div class="rt-top">' +
          '<span class="chip" data-tone="' + (TASK_TONE[task.status] || 'queued') + '">' + (TASK_LABEL[task.status] || task.status) + '</span>' +
          '<span class="rt-name">' + esc(task.title) + '</span>' +
        '</div>' +
        '<div class="rt-meta"><span class="mono">' + esc(task.workspace) + '</span><span>·</span><span>' + esc(task.note) + '</span>' +
          (task.status === 'running' ? '<span style="margin-left:auto" class="mono">' + task.pct + '%</span>' : '') +
        '</div>' +
        '<div class="rt-bar"><i style="width:' + (task.status === 'running' ? task.pct : 0) + '%"></i></div>' +
      '</button>'
    ).join('')
  }

  /* ------------------------------------------------------------- variant C */
  function renderC () {
    const pending = pendingCount()
    const running = runningTasks().length
    const waiting = waitingTasks().length
    const sheetOpen = state.sheetOpen
    return '' +
      '<section class="panel panel-c" role="dialog" aria-label="指挥官">' +
        header({ binding: false, pending: false }) +
        '<div class="c-status">' +
          '<button class="group" type="button" data-act="open-binding" title="绑定信息与连接">' +
            '<span class="dot" data-tone="' + (live() ? '' : 'warn') + '"></span>已绑定<span class="sep">·</span><span class="name">调研 DSH 0.2.2-rc.5</span>' + icon('down') +
          '</button>' +
          '<button class="group taskc" type="button" data-act="open-binding" title="任务状态">' +
            '进行中 <b>' + running + '</b>' + (waiting > 0 ? '<span class="sep">·</span>待派发 ' + waiting : '') +
          '</button>' +
          '<span class="spacer"></span>' +
          (live()
            ? '<span class="group">' + icon('check') + '实时</span>'
            : '<button class="group warn" type="button" data-act="open-binding">' + icon('alert') + '轮询 3s</button>') +
        '</div>' +
        noticeHTML() +
        transcriptShell(transcriptHTML(), 'c-transcript') +
        '<div class="c-composer">' +
          composerHTML() +
          (pending > 0 && !sheetOpen
            ? '<button class="c-pending-fab" type="button" data-act="open-sheet">' + icon('inbox') + pending + ' 项待处理' + icon('up') + '</button>'
            : '') +
        '</div>' +
        (sheetOpen ? sheetHTML() : '') +
        (state.bindingOpen ? statusPopover() : '') +
      '</section>'
  }

  function sheetHTML () {
    const pending = pendingCount()
    const waiting = state.dispatch.phase === 'sent'
    return '' +
      '<div class="sheet-scrim" data-act="close-sheet"></div>' +
      '<section class="sheet" role="dialog" aria-modal="true" aria-label="需要你处理">' +
        '<div class="sheet-grab"></div>' +
        '<div class="sheet-head">' +
          '<span class="sheet-title">需要你处理 <span class="count">' + pending + '</span></span>' +
          '<span class="sheet-sub">处理完自动收起 · 不进对话</span>' +
          '<button class="icon-btn" type="button" data-act="close-sheet" title="收起（Esc）" aria-label="收起">' + icon('down') + '</button>' +
        '</div>' +
        '<div class="sheet-body">' +
          (waiting ? '<div class="c-wait"><span class="spinner"></span>已发送确认，等待指挥官处理…</div>' : '') +
          (dispatchActive() ? dispatchCard('sheet') : '') +
          state.approvals.map(item => approvalCard(item, 'sheet')).join('') +
          (pending === 0 && !waiting ? '<div class="rail-empty">' + icon('check') + '全部处理完 · 抽屉即将收起</div>' : '') +
        '</div>' +
        '<div class="sheet-foot">' +
          '<span>审批仅在界面处理，不进入指挥官上下文</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn" type="button" data-v="ghost" data-act="close-sheet">暂时收起</button>' +
        '</div>' +
      '</section>'
  }

  /* ---------------------------------------------------------------- hydrate */
  function hydrateTranscript () {
    const transcript = stage.querySelector('.transcript')
    if (!transcript) return
    const shell = transcript.parentElement
    const sync = function () {
      if (!shell) return
      shell.setAttribute('data-scrolled', transcript.scrollTop > 2 ? 'true' : 'false')
    }
    transcript.addEventListener('scroll', sync, { passive: true })
    sync()
  }

  function hydrateComposer (focus) {
    const textarea = stage.querySelector('[data-composer]')
    if (!textarea) return

    const resize = function () {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 78) + 'px'
    }
    resize()

    textarea.addEventListener('input', function () {
      state.draft = textarea.value
      resize()
      const send = stage.querySelector('[data-act="send"]')
      if (send) send.disabled = state.busy || state.draft.trim() === ''
    })

    textarea.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      event.preventDefault()
      submitComposer()
    })

    if (focus) {
      textarea.focus()
      const end = textarea.value.length
      try { textarea.setSelectionRange(end, end) } catch (err) { /* noop */ }
    }
  }

  /* ----------------------------------------------------------------- events */
  document.addEventListener('click', function (event) {
    const target = event.target.closest ? event.target.closest('[data-act]') : null
    if (!target) return
    const act = target.getAttribute('data-act')

    switch (act) {
      case 'prev': cycleVariant(-1); break
      case 'next': cycleVariant(1); break
      case 'reset': resetDemo(); break
      case 'theme': toggleTheme(); break
      case 'conn':
        state.connection = live() ? 'polling' : 'live'
        state.noticeDismissed = false
        render()
        showToast(live() ? '已恢复实时同步' : '已模拟 SSE 断线 · 顶部出现降级提示', live() ? 'ok' : 'warn')
        break
      case 'debug':
        state.debug = !state.debug
        render()
        break
      case 'close-panel': state.panelOpen = false; render(); break
      case 'focus-pending':
        if (state.variant === 'C') { state.sheetOpen = true; state.bindingOpen = false }
        if (state.variant === 'A') { state.dockTab = 'dispatch'; state.dockCollapsed = false }
        if (state.variant === 'B') state.railTab = 'pending'
        render()
        break
      case 'dock-tab':
        state.dockTab = target.getAttribute('data-tab') || 'dispatch'
        state.dockCollapsed = false
        render()
        break
      case 'dock-collapse':
        state.dockCollapsed = !state.dockCollapsed
        render()
        break
      case 'toggle-tasks':
        state.tasksOpen = !state.tasksOpen
        render()
        break
      case 'rail-tab':
        state.railTab = target.getAttribute('data-tab') || 'pending'
        render()
        break
      case 'open-sheet':
        state.sheetOpen = true
        state.bindingOpen = false
        render()
        break
      case 'close-sheet':
        state.sheetOpen = false
        render()
        break
      case 'open-binding':
        openBinding()
        break
      case 'close-popover':
        closePopover()
        break
      case 'details':
        state.detailsOpen = !state.detailsOpen
        render()
        break
      case 'adopt': adoptDispatch(); break
      case 'custom': openCustom(); break
      case 'custom-back': backCustom(); break
      case 'custom-confirm': confirmCustom(); break
      case 'cancel': cancelDispatch(); break
      case 'custom-mode':
        state.custom.mode = target.getAttribute('data-mode') === 'attach' ? 'attach' : 'new'
        render()
        break
      case 'allow': answerApproval(true, target.getAttribute('data-approval')); break
      case 'reject': answerApproval(false, target.getAttribute('data-approval')); break
      case 'approval-prev': stepApproval(-1); break
      case 'approval-next': stepApproval(1); break
      case 'notice-retry': retryConnection(); break
      case 'notice-dismiss': dismissNotice(); break
      case 'open-session':
        state.bindingOpen = false
        showToast('打开工作会话（原型中不跳转）')
        render()
        break
      case 'open-task':
        state.bindingOpen = false
        showToast('打开任务「' + (findTaskTitle(target.getAttribute('data-id')) || '') + '」（原型中不跳转）')
        break
      case 'board':
        showToast('看板页沿用现状，不在此次重设计范围')
        break
      case 'rebind':
        state.bindingOpen = false
        showToast('打开「设置 → 指挥官」换绑（原型中不跳转）')
        render()
        break
      case 'toggle-record':
        toggleRecord(target.getAttribute('data-id'))
        break
      case 'send': submitComposer(); break
      default: break
    }
  })

  function findTaskTitle (id) {
    const task = state.tasks.find(row => row.id === id)
    return task ? task.title : ''
  }

  document.addEventListener('change', function (event) {
    const field = event.target && event.target.getAttribute ? event.target.getAttribute('data-field') : null
    if (!field) return
    if (field === 'workspace') state.custom.workspace = event.target.value
    if (field === 'session') state.custom.session = event.target.value
  })

  ball.addEventListener('click', togglePanel)

  document.addEventListener('keydown', function (event) {
    const tag = document.activeElement ? document.activeElement.tagName : ''
    const typing = tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || (document.activeElement && document.activeElement.isContentEditable)

    if (event.key === 'Escape') {
      if (state.bindingOpen) { state.bindingOpen = false; render(); return }
      if (state.sheetOpen && state.variant === 'C') { state.sheetOpen = false; render(); return }
      if (state.panelOpen) { state.panelOpen = false; render() }
      return
    }
    if (typing) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); cycleVariant(-1); return }
    if (event.key === 'ArrowRight') { event.preventDefault(); cycleVariant(1); return }
    if (event.key === '1' || event.key === '2' || event.key === '3') {
      setVariant(VARIANTS[Number(event.key) - 1].key)
      return
    }
    if (event.key === 'r' || event.key === 'R') { resetDemo(); return }
    if (event.key === 'd' || event.key === 'D') { state.debug = !state.debug; render() }
  })

  render()
})()
