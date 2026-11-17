(function () {
  'use strict';

  var SCENES = ['workbench', 'panel', 'board', 'detail', 'settings', 'spec'];
  var root = document.documentElement;
  var stage = document.getElementById('stage');
  var segs = Array.prototype.slice.call(document.querySelectorAll('.seg[data-scene]'));
  var current = 'workbench';

  /* ---------- toast ---------- */
  var toast = document.getElementById('toast');
  var toastText = document.getElementById('toast-text');
  var toastTimer = null;

  function showToast(msg) {
    if (!toast || !toastText || !msg) return;
    toastText.textContent = msg;
    toast.hidden = false;
    void toast.offsetWidth;
    toast.classList.add('is-in');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.remove('is-in');
      window.setTimeout(function () { toast.hidden = true; }, 200);
    }, 2600);
  }

  /* ---------- theme ---------- */
  var themeButtons = Array.prototype.slice.call(document.querySelectorAll('[data-theme-choice]'));
  var themeSelect = document.getElementById('theme-select');
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var themeChoice = 'dark';

  function applyTheme(choice) {
    themeChoice = choice;
    var resolved = choice;
    if (choice === 'system') resolved = (mql && mql.matches) ? 'light' : 'dark';
    root.setAttribute('data-theme', resolved === 'light' ? 'light' : 'dark');
    themeButtons.forEach(function (btn) {
      var on = btn.getAttribute('data-theme-choice') === choice;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (themeSelect && themeSelect.value !== choice) themeSelect.value = choice;
  }

  themeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyTheme(btn.getAttribute('data-theme-choice'));
    });
  });

  if (themeSelect) {
    themeSelect.addEventListener('change', function () { applyTheme(themeSelect.value); });
  }

  if (mql) {
    var onScheme = function () { if (themeChoice === 'system') applyTheme('system'); };
    if (mql.addEventListener) mql.addEventListener('change', onScheme);
    else if (mql.addListener) mql.addListener(onScheme);
  }

  applyTheme('dark');

  /* ---------- stage scale ---------- */
  var stageWrap = stage ? stage.parentElement : null;

  function fitStage() {
    if (!stage || !stageWrap) return;
    var pad = 20;
    var w = stageWrap.clientWidth - pad * 2;
    var h = stageWrap.clientHeight - pad;
    if (w <= 0 || h <= 0) return;
    var scale = Math.min(w / 1440, h / 900, 1);
    stage.style.setProperty('--stage-scale', String(scale));
  }

  /* ---------- scene switching ---------- */
  function setScene(name) {
    if (SCENES.indexOf(name) === -1) return;
    current = name;
    SCENES.forEach(function (key) {
      var scene = document.getElementById('scene-' + key);
      if (!scene) return;
      scene.hidden = key !== name;
      scene.classList.remove('is-entering');
    });
    var active = document.getElementById('scene-' + name);
    if (active) {
      void active.offsetWidth;
      active.classList.add('is-entering');
    }
    segs.forEach(function (btn) {
      var on = btn.getAttribute('data-scene') === name;
      btn.classList.toggle('is-active', on);
      if (on) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    if (name === 'detail') openDrawer();
    else closeDrawer(true);
    if (name === 'panel') {
      var stream = document.getElementById('panel-stream');
      var card = document.getElementById('dispatch-card');
      if (stream && card) {
        // bring the dispatch decision into view: it is the point of this screen
        stream.scrollTop = Math.max(0, card.offsetTop - stream.offsetTop - 8);
      }
    }
  }

  segs.forEach(function (btn) {
    btn.addEventListener('click', function () { setScene(btn.getAttribute('data-scene')); });
  });

  /* delegated: nav jumps + demo toasts + card opening */
  stage.addEventListener('click', function (event) {
    var jump = event.target.closest('[data-scene-jump]');
    if (jump) {
      setScene(jump.getAttribute('data-scene-jump'));
      return;
    }

    var openDetail = event.target.closest('[data-open-detail]');
    if (openDetail) {
      setScene('detail');
      return;
    }

    var hit = event.target.closest('.tcard__hit');
    if (hit) {
      var host = hit.closest('.tcard');
      if (host && host.hasAttribute('data-open-detail')) setScene('detail');
      else if (host && host.dataset.toast) showToast(host.dataset.toast);
      return;
    }

    var quick = event.target.closest('.tcard__quick button');
    if (quick) {
      event.stopPropagation();
      var label = quick.getAttribute('aria-label') || '已完成';
      var titleEl = quick.closest('.tcard').querySelector('.tcard__title');
      showToast(label + '：' + (titleEl ? titleEl.textContent : '任务'));
      return;
    }

    var approve = event.target.closest('[data-approve]');
    if (approve) {
      handleApproval(approve.getAttribute('data-approve'));
      return;
    }

    var toastBtn = event.target.closest('[data-toast]');
    if (toastBtn && !toastBtn.classList.contains('tcard__hit')) {
      showToast(toastBtn.dataset.toast);
    }
  });

  /* ---------- tool call fold ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('[data-tool-toggle]'), function (btn) {
    btn.addEventListener('click', function () {
      var body = btn.nextElementSibling;
      if (!body) return;
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      body.hidden = expanded;
    });
  });

  /* ---------- workbench approval ---------- */
  var approvalCard = document.getElementById('wb-approval');
  var approvalDone = false;

  function handleApproval(verdict) {
    if (!approvalCard || approvalDone) return;
    approvalDone = true;

    var wrap = document.createElement('div');
    wrap.className = 'approval is-done';
    if (verdict === 'deny') {
      wrap.style.borderLeftColor = 'var(--danger)';
      wrap.innerHTML =
        '<div class="approval__head">' +
        '<svg class="od-icon" style="--od-icon-size:12px;color:var(--danger)" aria-hidden="true"><use href="#i-close"/></svg>' +
        '<span>工作会话审批</span>' +
        '<span class="pill pill--danger"><i></i>已拒绝</span>' +
        '</div>' +
        '<p class="approval__note" style="padding-top:8px;color:var(--danger)">已拒绝 · HtDot 会停下来等你</p>';
      showToast('已拒绝这次运行');
    } else {
      wrap.innerHTML =
        '<div class="approval__head">' +
        '<svg class="od-icon" style="--od-icon-size:12px;color:var(--success)" aria-hidden="true"><use href="#i-check"/></svg>' +
        '<span>工作会话审批</span>' +
        '<span class="pill pill--success"><i></i>已允许</span>' +
        '</div>' +
        '<p class="approval__note" style="padding-top:8px;color:var(--success)">' +
        (verdict === 'always' ? '本工作区已始终允许运行测试' : '已允许 · pnpm vitest 正在运行') +
        '</p>';
      showToast(verdict === 'always' ? 'HtDot 已设为总是允许测试' : '已允许，测试继续跑');
    }

    approvalCard.replaceWith(wrap);
    approvalCard = wrap;
  }

  /* ---------- panel · Jev dispatch ---------- */
  var dispatchCard = document.getElementById('dispatch-card');
  var adoptBtn = document.getElementById('btn-adopt');
  var dispatched = false;

  function dispatchTask(successText, target, wsKey) {
    dispatchCard.classList.add('is-done');
    dispatchCard.style.borderLeftColor = 'var(--success)';

    dispatchCard.innerHTML =
      '<div class="auto-strip" style="background:transparent;padding:0">' +
      '<span class="auto-strip__icon"><svg class="od-icon" style="--od-icon-size:13px" aria-hidden="true"><use href="#i-check"/></svg></span>' +
      '<span class="auto-strip__text">' + esc(successText) + '</span>' +
      '<span class="pill pill--success"><i></i>进行中</span>' +
      '</div>' +
      '<p class="dispatch__foot mono" style="border-top:0;padding-top:0">目标 ' + esc(target) + ' · 17:03 · 已进入看板</p>';

    var taskCard = document.createElement('div');
    taskCard.className = 'tcard tcard--run';
    taskCard.setAttribute('data-ws', wsKey);
    taskCard.setAttribute('data-open-detail', '');
    taskCard.innerHTML =
      '<button class="tcard__hit" type="button" aria-label="打开任务：订单导出改流式 + 补单测"></button>' +
      '<span class="tcard__title">订单导出改流式 + 补单测</span>' +
      '<span class="progress">' +
      '<span class="progress__bar"><i style="width:8%"></i></span>' +
      '<span class="progress__meta"><span>8%</span><span>已派发 · 刚开始</span></span>' +
      '</span>' +
      '<span class="tcard__foot"><span class="ws ws--' + wsKey + '">' + wsKey.charAt(0).toUpperCase() + '</span><time>17:03</time></span>';

    var stream = document.getElementById('panel-stream');
    if (stream) {
      stream.appendChild(taskCard);
      stream.scrollTop = stream.scrollHeight;
    }

    showToast('已派发到 ' + target + '，稍后播报进度');
  }

  function adoptSuggestion() {
    if (!dispatchCard || dispatched) return;
    dispatched = true;
    var picked = dispatchCard.querySelector('.option.is-picked .option__main strong');
    var target = picked ? picked.textContent.trim() : 'HtDot · 新会话';
    dispatchTask('已派发 · 你确认了 Jev 62% 的建议', target, 'htdot');
    return;
  }

  /* custom selection: expand inline form, then dispatch */
  var customForm = document.getElementById('custom-form');
  var customToggle = document.getElementById('btn-custom');
  var customCollapse = document.getElementById('btn-custom-collapse');
  var customDispatch = document.getElementById('btn-custom-dispatch');
  var customWs = document.getElementById('custom-ws');
  var customSession = document.getElementById('custom-session');

  function scrollPanelToBottom() {
    var stream = document.getElementById('panel-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  var dispatchActs = document.getElementById('dispatch-acts');

  /* capability plan preview follows the chosen workspace */
  var capTitle = document.getElementById('dispatch-cap-title');
  var capNames = document.getElementById('dispatch-cap-names');
  function syncCapPreview() {
    if (!customWs || !capTitle || !capNames) return;
    var key = /^Mira/.test(customWs.value) ? 'Mira' : (/^Live/.test(customWs.value) ? 'Live' : 'HtDot');
    if (key === 'HtDot') {
      capTitle.textContent = '自动选择（能力面板）';
      capNames.textContent = 'vitest、export-bench';
    } else {
      capTitle.textContent = '继承工作区（默认）';
      capNames.textContent = '使用已启用能力';
    }
  }
  if (customWs) customWs.addEventListener('change', syncCapPreview);

  if (customToggle && customForm) {
    customToggle.addEventListener('click', function () {
      if (dispatched) return;
      customForm.hidden = false;
      dispatchCard.classList.add('is-custom');
      if (dispatchActs) dispatchActs.hidden = true;
      scrollPanelToBottom();
      window.setTimeout(scrollPanelToBottom, 40);
      if (customWs) customWs.focus({ preventScroll: true });
    });
  }

  if (customCollapse && customForm) {
    customCollapse.addEventListener('click', function () {
      customForm.hidden = true;
      dispatchCard.classList.remove('is-custom');
      if (dispatchActs) dispatchActs.hidden = false;
      if (customToggle) customToggle.focus({ preventScroll: true });
    });
  }

  if (customDispatch) {
    customDispatch.addEventListener('click', function () {
      if (dispatched) return;
      dispatched = true;
      var wsText = customWs ? customWs.value : 'HtDot（电商后台：订单、结算、导出链路）';
      var sessText = customSession ? customSession.value : '新建会话';
      var wsKey = /^Mira/.test(wsText) ? 'mira' : (/^Live/.test(wsText) ? 'live' : 'htdot');
      var wsName = wsKey === 'mira' ? 'Mira' : (wsKey === 'live' ? 'Live' : 'HtDot');
      var sessName = /新建/.test(sessText) ? '新建会话' : sessText.replace(/（.*$/, '');
      dispatchTask('已派发 · 你自定义了目标 ' + wsName + ' · ' + sessName, wsName + ' · ' + sessName, wsKey);
    });
  }

  function esc(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  if (adoptBtn) adoptBtn.addEventListener('click', adoptSuggestion);

  /* option selection (visual only, demo picks a target) */
  Array.prototype.forEach.call(document.querySelectorAll('.option'), function (option) {
    option.addEventListener('click', function () {
      if (dispatched) return;
      var group = option.parentElement;
      Array.prototype.forEach.call(group.querySelectorAll('.option'), function (o) {
        o.classList.remove('is-picked');
        o.setAttribute('aria-pressed', 'false');
      });
      option.classList.add('is-picked');
      option.setAttribute('aria-pressed', 'true');
    });
  });

  /* ---------- board filters ---------- */
  var filters = Array.prototype.slice.call(document.querySelectorAll('.filter[data-filter]'));
  var liveCards = Array.prototype.slice.call(document.querySelectorAll('#board-columns .tcard'));
  var boardSearch = document.getElementById('board-search');
  var activeWs = 'all';

  function syncCounts() {
    Array.prototype.forEach.call(document.querySelectorAll('#board-columns .col'), function (col) {
      var body = col.querySelector('.col__body');
      var n = col.querySelector('.n');
      if (!body || !n) return;
      var visible = 0;
      Array.prototype.forEach.call(body.querySelectorAll('.tcard'), function (card) {
        if (!card.hidden) visible += 1;
      });
      n.textContent = String(visible);
    });
  }

  function applyFilters() {
    var q = boardSearch ? boardSearch.value.trim().toLowerCase() : '';
    liveCards.forEach(function (card) {
      var titleEl = card.querySelector('.tcard__title');
      var title = titleEl ? titleEl.textContent : '';
      var matchWs = activeWs === 'all' || card.dataset.ws === activeWs;
      var matchQ = !q || title.toLowerCase().indexOf(q) !== -1;
      card.hidden = !(matchWs && matchQ);
    });
    syncCounts();
  }

  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filters.forEach(function (f) { f.classList.remove('is-active'); });
      btn.classList.add('is-active');
      activeWs = btn.getAttribute('data-filter');
      applyFilters();
    });
  });

  if (boardSearch) boardSearch.addEventListener('input', applyFilters);

  /* ---------- detail drawer ---------- */
  var drawer = document.getElementById('detail-drawer');
  var scrim = document.getElementById('detail-scrim');
  var closeBtn = document.getElementById('btn-close-drawer');

  function openDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    if (scrim) scrim.hidden = false;
    drawer.focus({ preventScroll: true });
  }

  function closeDrawer(silent) {
    if (!drawer) return;
    drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    if (!silent) setScene('board');
  }

  if (closeBtn) closeBtn.addEventListener('click', function () { closeDrawer(false); });
  if (scrim) scrim.addEventListener('click', function () { closeDrawer(false); });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && current === 'detail') {
      event.preventDefault();
      closeDrawer(false);
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      var active = document.activeElement;
      if (active && (active.id === 'commander-composer' || active.id === 'dsh-composer')) {
        event.preventDefault();
        showToast('演示：只做本地展示，不会真的发送');
      }
    }
  });

  /* ---------- detail actions ---------- */
  var acceptBtn = document.getElementById('btn-accept');
  var reworkBtn = document.getElementById('btn-rework');
  var dwStatus = document.getElementById('dw-status');
  var dwFoot = document.getElementById('dw-foot');
  var tlNow = document.getElementById('tl-now');

  if (acceptBtn) {
    acceptBtn.addEventListener('click', function () {
      if (acceptBtn.disabled) return;
      acceptBtn.disabled = true;
      if (reworkBtn) reworkBtn.disabled = true;
      if (dwStatus) {
        dwStatus.className = 'pill pill--success';
        dwStatus.innerHTML = '<i></i>已通过';
      }
      if (tlNow) {
        tlNow.className = 'tl tl--ok';
        var text = tlNow.querySelector('.tl__text');
        if (text) text.innerHTML = '<b>已通过验收</b> · 归档到 HtDot';
      }
      if (dwFoot) {
        dwFoot.innerHTML =
          '<div class="receipt" style="flex:1;justify-content:center;height:34px">' +
          '<svg class="od-icon" style="--od-icon-size:13px" aria-hidden="true"><use href="#i-check"/></svg>' +
          '<span>已通过验收 · 结果写回工作区会话</span></div>';
      }
      showToast('已通过验收，任务归档');
    });
  }

  if (reworkBtn) {
    reworkBtn.addEventListener('click', function () {
      if (reworkBtn.disabled) return;
      showToast('已退回：让 HtDot 补一条内存曲线再交');
    });
  }

  /* ---------- settings ---------- */
  var setNav = Array.prototype.slice.call(document.querySelectorAll('[data-set]'));
  var setPanels = Array.prototype.slice.call(document.querySelectorAll('.set-panel'));

  setNav.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-set');
      setNav.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        if (on) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      });
      setPanels.forEach(function (panel) {
        var on = panel.id === 'set-' + key;
        panel.hidden = !on;
      });
      var body = document.querySelector('.set-body');
      if (body) body.scrollTop = 0;
    });
  });

  /* switches */
  Array.prototype.forEach.call(document.querySelectorAll('.switch[role="switch"]'), function (sw) {
    sw.addEventListener('click', function () {
      var on = sw.getAttribute('aria-checked') === 'true';
      sw.setAttribute('aria-checked', on ? 'false' : 'true');
    });
  });

  /* API key source segmented control */
  var keySources = Array.prototype.slice.call(document.querySelectorAll('[data-key-source]'));
  var keyPanes = {
    env: document.getElementById('key-pane-env'),
    manual: document.getElementById('key-pane-manual')
  };

  keySources.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-key-source');
      keySources.forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      Object.keys(keyPanes).forEach(function (k) {
        if (keyPanes[k]) keyPanes[k].hidden = k !== key;
      });
    });
  });

  /* workspace summarize */
  Array.prototype.forEach.call(document.querySelectorAll('[data-summarize]'), function (btn) {
    btn.addEventListener('click', function () {
      showToast('已根据最近 5 个会话生成摘要，可编辑后保存');
      var name = btn.getAttribute('data-summarize');
      var text = name === 'Mira' ? '重新生成' : '生成摘要';
      if (text === '重新生成') btn.textContent = text;
    });
  });

  /* threshold slider */
  var slider = document.getElementById('threshold-slider');
  var sliderValue = document.getElementById('threshold-value');

  function paintSlider() {
    if (!slider) return;
    var min = Number(slider.min || 0);
    var max = Number(slider.max || 100);
    var val = Number(slider.value);
    var pct = ((val - min) / (max - min)) * 100;
    slider.style.setProperty('--fill', pct.toFixed(1) + '%');
    if (sliderValue) sliderValue.textContent = val + '%';
    var thr = document.querySelectorAll('.conf__thr');
    Array.prototype.forEach.call(thr, function (node) {
      if (node.closest('.spec__body')) {
        node.style.left = pct.toFixed(1) + '%';
      }
    });
  }

  if (slider) {
    slider.addEventListener('input', paintSlider);
    paintSlider();
  }

  /* concurrency stepper */
  Array.prototype.forEach.call(document.querySelectorAll('.stepper'), function (stepper) {
    var out = stepper.querySelector('output');
    if (!out) return;
    var base = Number(out.textContent) || 1;
    Array.prototype.forEach.call(stepper.querySelectorAll('[data-step]'), function (btn) {
      btn.addEventListener('click', function () {
        var delta = Number(btn.getAttribute('data-step'));
        var next = Math.max(1, Math.min(8, (Number(out.textContent) || base) + delta));
        out.textContent = String(next);
      });
    });
  });

  /* ---------- S4 background board (clone of the real board) ---------- */
  var detailSlot = document.getElementById('detail-board-slot');
  var liveColumns = document.getElementById('board-columns');

  if (detailSlot && liveColumns) {
    var clone = liveColumns.cloneNode(true);
    clone.removeAttribute('id');
    Array.prototype.forEach.call(clone.querySelectorAll('.tcard__hit'), function (btn) {
      btn.removeAttribute('tabindex');
      btn.setAttribute('tabindex', '-1');
    });
    Array.prototype.forEach.call(clone.querySelectorAll('button, input, select, textarea'), function (el) {
      el.setAttribute('tabindex', '-1');
    });
    // show every card in the ghost board so each column reads as populated
    Array.prototype.forEach.call(clone.querySelectorAll('.tcard'), function (card) { card.hidden = false; });
    detailSlot.appendChild(clone);
  }

  /* ---------- boot ---------- */
  fitStage();
  window.addEventListener('resize', fitStage, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitStage, { passive: true });
  }
  setScene('workbench');
})();
