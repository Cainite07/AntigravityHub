let currentNav = 'usage';
    let currentHeatMode = 'month';
    let currentFlowMode = 'day';
    const nowInit = new Date();
    let currentCalYear = nowInit.getFullYear();
    let currentCalMonth = nowInit.getMonth(); // 0-indexed, 8 = 9月
    let selectedCalDate = null;
    let hoveredWeekKey = null;
    let hoveredMonthKey = null;
    let allRecords = [];
    let closeToTray = true;
    let selectedDailyMonth = 'all';
    let isMonthDropdownOpen = false;
    let pendingDeleteId = '';
    let isRefreshing = false;

    let appSettings = {
      theme: window.hubTheme.preference,
      enableClientHud: true,
      enableClientLocalization: false,
      enableThinkingTranslation: false,
      enableClientWindowSize: false,
      clientWindowWidth: 1400,
      clientWindowHeight: 900,
      currency: 'CNY',
      liveUsdToCnyRate: 7.24,
      lastRateFetchTime: '',
      closeToTray: true,
      launchOnStartup: false,
      startMinimized: true,
      checkUpdatesOnStartup: true,
      enableGlobalHotkey: true,
      globalHotkey: 'Alt + A',
      pollIntervalSeconds: 30
    };
    let settingsDraft = null;
    let pendingSettingsSave = null;
    let settingsSaveSequence = 0;
    let clientRestartBusy = false;
    let currentAccountsList = [];
    let isSwitchingAccount = false;

    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function escapeJs(str) {
      if (str == null) return '';
      return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    }


    function quotaValue(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    }
    function quotaLabel(value) { return value == null ? '未知' : `${value}%`; }
    function quotaWidth(value) { return value == null ? 0 : Math.min(100, Math.max(0, value)); }
    function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#3C804F'; }
    function safeAvatarUrl(value) {
      if (typeof value === 'string' && value.length <= 700000 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
      try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch (_) {}
      return './avatar.svg';
    }
    function formatSubscriptionTier(rawTier) {
      if (!rawTier) return { label: '', className: '' };
      const lower = String(rawTier).trim().toLowerCase();
      if (lower.includes('ultra')) return { label: 'ULTRA', className: 'badge-tier-ultra' };
      if (lower.includes('pro')) return { label: 'PRO', className: 'badge-tier-pro' };
      if (lower.includes('free') || lower.includes('免费')) return { label: 'FREE', className: 'badge-tier-free' };
      return { label: String(rawTier).trim().toUpperCase(), className: 'badge-tier-pro' };
    }

    function quotaSyncLabel(account) {
      const status = account.quotaStatus;
      const stamp = account.lastQuotaRefreshTime;
      if (status === 'failed') return '查询失败，保留缓存';
      if (!stamp) return status === 'cached' ? '历史缓存，时间未知' : '尚未同步';
      const date = new Date(stamp);
      if (Number.isNaN(date.getTime())) return String(stamp);
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      return (status === 'fresh' ? '更新于 ' : '缓存于 ') + timeStr;
    }

    let isRecordingHotkey = false;

    function startRecordHotkey() {
      if (isRecordingHotkey) return;
      isRecordingHotkey = true;
      const btn = document.getElementById('hotkey-btn');
      if (btn) {
        btn.classList.add('recording', 'ring-2', 'ring-[color:var(--border-8c3f2b)]', 'animate-pulse');
        btn.innerText = '请按下按键 (Esc 取消)...';
      }
      window.addEventListener('keydown', handleHotkeyKeyDown);
    }

    function stopRecordHotkey() {
      isRecordingHotkey = false;
      const btn = document.getElementById('hotkey-btn');
      if (btn) {
        btn.classList.remove('recording', 'ring-2', 'ring-[color:var(--border-8c3f2b)]', 'animate-pulse');
        btn.innerText = (settingsDraft || appSettings).globalHotkey || 'Alt + A';
      }
      window.removeEventListener('keydown', handleHotkeyKeyDown);
    }

    function handleHotkeyKeyDown(e) {
      e.preventDefault();
      e.stopPropagation();

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        return;
      }

      if (e.key === 'Escape') {
        stopRecordHotkey();
        return;
      }

      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Win');

      let keyName = e.key.toUpperCase();
      if (keyName === ' ') keyName = 'Space';
      parts.push(keyName);

      (settingsDraft || appSettings).globalHotkey = parts.join(' + ');
      stopRecordHotkey();
    }

    function openSettingsModal() {
      const modal = document.getElementById('settings-modal');
      if (!modal || settingsDraft) return;
      settingsDraft = {...appSettings};
      selectTheme(settingsDraft.theme || 'system');
      document.getElementById('set-client-hans').checked = appSettings.enableClientLocalization === true;
      document.getElementById('set-thinking-hans').checked = appSettings.enableThinkingTranslation === true;
      document.getElementById('set-client-size').checked = appSettings.enableClientWindowSize === true;
      document.getElementById('client-width').value = appSettings.clientWindowWidth || 1400;
      document.getElementById('client-height').value = appSettings.clientWindowHeight || 900;
      updateClientSizeInputs();
      if (window.chrome?.webview) window.chrome.webview.postMessage({action:'getClientEnhancementStatus'});

      const setTray = document.getElementById('set-tray');
      if (setTray) setTray.checked = appSettings.closeToTray;

      const setAutostart = document.getElementById('set-autostart');
      if (setAutostart) setAutostart.checked = appSettings.launchOnStartup;

      const setStartMin = document.getElementById('set-start-min');
      if (setStartMin) setStartMin.checked = appSettings.startMinimized;
      document.getElementById('set-check-updates').checked = appSettings.checkUpdatesOnStartup !== false;
      window.chrome?.webview?.postMessage({action:'getHubUpdateStatus'});


      const setHud = document.getElementById('set-hud');
      if (setHud) setHud.checked = appSettings.enableClientHud !== false;

      const setHotkey = document.getElementById('set-hotkey');
      if (setHotkey) setHotkey.checked = appSettings.enableGlobalHotkey;

      const hotkeyBtn = document.getElementById('hotkey-btn');
      if (hotkeyBtn) hotkeyBtn.innerText = appSettings.globalHotkey || 'Alt + A';

      setSettingCurrency(appSettings.currency || 'CNY', false);
      setSettingPollInterval(appSettings.pollIntervalSeconds || 30, false);

      const rateVal = document.getElementById('modal-rate-val');
      if (rateVal && appSettings.liveUsdToCnyRate) {
        rateVal.innerText = Number(appSettings.liveUsdToCnyRate).toFixed(2);
      }

      modal.classList.remove('hidden');
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: true });
      }
    }

    function closeSettingsModal() {
      if (!settingsDraft) return;
      if (isRecordingHotkey) stopRecordHotkey();
      const width = Number(document.getElementById('client-width').value);
      const height = Number(document.getElementById('client-height').value);
      if (!Number.isInteger(width) || width < 640 || width > 7680 || !Number.isInteger(height) || height < 480 || height > 4320) {
        document.getElementById('client-size-error').innerText = '宽度 640–7680，高度 480–4320，请输入整数。';
        return;
      }
      document.getElementById('client-size-error').innerText = '';
      settingsDraft.clientWindowWidth = width; settingsDraft.clientWindowHeight = height;
      [['set-thinking-hans','enableThinkingTranslation'],['set-client-hans','enableClientLocalization'],['set-client-size','enableClientWindowSize'],['set-tray','closeToTray'],['set-autostart','launchOnStartup'],['set-start-min','startMinimized'],['set-hotkey','enableGlobalHotkey'],['set-hud','enableClientHud'],['set-check-updates','checkUpdatesOnStartup']].forEach(([id,key]) => { const el=document.getElementById(id); if(el) settingsDraft[key]=el.checked; });
      const draft=settingsDraft; settingsDraft=null;
      const needsRestart = ['enableClientLocalization','enableThinkingTranslation'].some(k=>draft[k]!==appSettings[k]);
      const keys=['checkUpdatesOnStartup','enableThinkingTranslation','enableClientLocalization','enableClientWindowSize','clientWindowWidth','clientWindowHeight','enableClientHud','theme','currency','closeToTray','launchOnStartup','startMinimized','enableGlobalHotkey','globalHotkey','pollIntervalSeconds'];
      if(keys.some(k=>draft[k]!==appSettings[k])) {
        appSettings={...appSettings,...draft};closeToTray=appSettings.closeToTray;
        const requestId = `settings-${++settingsSaveSequence}`;
        pendingSettingsSave = {requestId, needsRestart};
        if(window.chrome?.webview) window.chrome.webview.postMessage({action:'saveSettings',settings:appSettings,requestId});
      }
      const modal = document.getElementById('settings-modal');
      if (modal) modal.classList.add('hidden');
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: !document.getElementById('hub-update-modal').classList.contains('hidden') });
      }
      if (!window.chrome?.webview && needsRestart) showClientRestartPrompt();
    }

    let hubUpdateState = {state:'idle',currentVersion:'',latestVersion:'',message:'尚未检查',progress:0,notes:''};
    let dismissedHubVersion = '';
    let hubInstallAfterSettings = false;
    let hubFrontendReady = false;
    function hubUpdateBusy() { return hubInstallAfterSettings || ['downloading','verifying','restarting'].includes(hubUpdateState.state); }
    function checkHubUpdates() {
      if (hubUpdateBusy() || hubUpdateState.state === 'checking') return;
      if (!window.chrome?.webview) { showToast('请在 AntigravityHub 中检查更新',false); return; }
      dismissedHubVersion = '';
      window.chrome.webview.postMessage({action:'checkHubUpdate'});
    }
    function onHubUpdateStatus(data) {
      hubUpdateState = {...hubUpdateState,...data};
      const busy = hubUpdateBusy(), hasUpdate = !!hubUpdateState.latestVersion;
      document.getElementById('hub-current-version').innerText = hubUpdateState.currentVersion ? `v${hubUpdateState.currentVersion}` : '';
      const status = document.getElementById('hub-update-status');
      status.innerText = hubUpdateState.message;
      status.dataset.error = String(hubUpdateState.state === 'error');
      const check = document.getElementById('hub-check-update');
      check.disabled = busy || hubUpdateState.state === 'checking';
      check.innerText = hubUpdateState.state === 'checking' ? '检查中…' : '检查更新';
      check.classList.remove('hidden');
      const update = document.getElementById('hub-settings-update');
      update.classList.toggle('hidden',!hasUpdate || busy); update.disabled = busy;
      document.getElementById('hub-update-version').innerText = `v${hubUpdateState.currentVersion}  →  v${hubUpdateState.latestVersion}`;
      const message = document.getElementById('hub-update-message');
      message.innerText = hubUpdateState.state === 'available' ? '更新后将自动重启 Hub，账号和设置会保留。' : hubUpdateState.message;
      const progress = Math.max(0,Math.min(100,Number(hubUpdateState.progress)||0));
      const bar = document.getElementById('hub-update-progress');
      bar.classList.toggle('hidden',!busy); bar.setAttribute('aria-valuenow',String(progress));
      document.getElementById('hub-update-progress-fill').style.width = `${progress}%`;
      const install = document.getElementById('hub-update-install');
      install.disabled = busy || !hasUpdate || hubUpdateState.state === 'checking';
      install.innerText = busy ? (hubUpdateState.state === 'downloading' ? `下载中 ${progress}%` : '正在更新…') : '更新并重启';
      document.getElementById('hub-update-dismiss').disabled = busy;
      document.getElementById('hub-update-later').disabled = busy;
      document.getElementById('hub-update-notes').classList.toggle('hidden',!hubUpdateState.notes || busy);
      document.getElementById('hub-update-notes-text').innerText = hubUpdateState.notes || '';
      if (hubUpdateState.state === 'available' && dismissedHubVersion !== hubUpdateState.latestVersion && !clientRestartBusy) showHubUpdatePrompt();
    }
    function showHubUpdatePrompt() {
      if (!hubUpdateState.latestVersion) return;
      document.getElementById('hub-update-modal').classList.remove('hidden');
      window.chrome?.webview?.postMessage({action:'modalStateChanged',isOpen:true});
      document.getElementById('hub-update-install').focus?.();
    }
    function closeHubUpdatePrompt() {
      if (hubUpdateBusy()) return;
      dismissedHubVersion = hubUpdateState.latestVersion;
      document.getElementById('hub-update-modal').classList.add('hidden');
      const isOpen = !!settingsDraft || !document.getElementById('client-restart-modal').classList.contains('hidden');
      window.chrome?.webview?.postMessage({action:'modalStateChanged',isOpen});
    }
    function startHubUpdate() {
      if (hubUpdateBusy() || !hubUpdateState.latestVersion) return;
      if (!window.chrome?.webview) { showToast('请在 AntigravityHub 中更新',false); return; }
      if (settingsDraft) { closeSettingsModal(); if (settingsDraft) return; }
      if (pendingSettingsSave) {
        hubInstallAfterSettings = true;
        document.getElementById('hub-update-install').disabled = true;
        document.getElementById('hub-update-install').innerText = '正在保存设置…';
        return;
      }
      onHubUpdateStatus({state:'downloading',message:'正在准备更新…',progress:0});
      window.chrome.webview.postMessage({action:'installHubUpdate'});
    }

    function showClientRestartPrompt() {
      const modal = document.getElementById('client-restart-modal');
      if (!modal) return;
      document.getElementById('client-restart-message').innerText = '重启 Antigravity 后生效';
      modal.classList.remove('hidden');
      document.getElementById('client-restart-button').focus?.();
      window.chrome?.webview?.postMessage({action:'modalStateChanged',isOpen:true});
    }
    function closeClientRestartPrompt() {
      if (clientRestartBusy) return;
      document.getElementById('client-restart-modal').classList.add('hidden');
      window.chrome?.webview?.postMessage({action:'modalStateChanged',isOpen:false});
      document.querySelector?.('[onclick="openSettingsModal()"]')?.focus?.();
    }
    function restartAntigravityClient() {
      if (clientRestartBusy) return;
      if (!window.chrome?.webview) { showToast('请在 AntigravityHub 中重启客户端',false); return; }
      clientRestartBusy = true;
      const button = document.getElementById('client-restart-button');
      button.disabled = true; document.getElementById('client-restart-button-label').innerText = '正在重启…';
      document.getElementById('client-restart-dismiss').disabled = true;
      window.chrome.webview.postMessage({action:'restartAntigravityClient'});
    }
    function onClientRestartResult(msg) {
      clientRestartBusy = false;
      const button = document.getElementById('client-restart-button');
      button.disabled = false; document.getElementById('client-restart-button-label').innerText = '重启 Antigravity';
      document.getElementById('client-restart-dismiss').disabled = false;
      if (msg.success) { closeClientRestartPrompt(); showToast('Antigravity 已重新打开',true); }
      else document.getElementById('client-restart-message').innerText = msg.message || '未能重启，请稍后重试';
    }

    function updateClientSizeInputs() {
      const enabled = document.getElementById('set-client-size').checked;
      ['client-width','client-height'].forEach(id => document.getElementById(id).disabled = !enabled);
    }
    function setSettingCurrency(curr, updateObj = true) {
      if (updateObj && settingsDraft) settingsDraft.currency = curr;
      const optCny = document.getElementById('opt-cny');
      const optUsd = document.getElementById('opt-usd');
      if (optCny && optUsd) {
        if (curr === 'USD') {
          optUsd.classList.add('active');
          optCny.classList.remove('active');
        } else {
          optCny.classList.add('active');
          optUsd.classList.remove('active');
        }
      }
    }

    function setSettingPollInterval(sec, updateObj = true) {
      if (updateObj && settingsDraft) settingsDraft.pollIntervalSeconds = sec;
      ['15', '30', '60'].forEach(s => {
        const btn = document.getElementById(`poll-${s}`);
        if (btn) {
          if (parseInt(s, 10) === sec) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        }
      });
    }

    function openDataFolder() {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'openDataFolder' });
      }
    }

    function selectTheme(theme, origin) {
      if(settingsDraft) settingsDraft.theme=theme;
      window.hubTheme.apply(theme, origin);
      ['system','light','dark'].forEach(t=>document.getElementById('theme-'+t)?.classList.toggle('active',t===theme));
    }
    function toggleTheme(origin = document.getElementById("theme-toggle")) {
      const theme=(window.hubTheme.target || document.documentElement.dataset.theme)==='dark'?'light':'dark';
      appSettings.theme=theme;window.hubTheme.apply(theme, origin);
      if(window.chrome?.webview) window.chrome.webview.postMessage({action:'setTheme',theme});
    }

    // 窗口原生拖拽与控制
    function handleHeaderMouseDown(e, action = 'windowDrag', direction) {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
        return;
      }
      if (e.button !== 0 || !window.chrome?.webview) return;
      const x = e.clientX, y = e.clientY;
      const cancel = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', cancel);
        window.removeEventListener('blur', cancel);
      };
      const move = next => {
        if (!(next.buttons & 1)) { cancel(); return; }
        if (Math.hypot(next.clientX - x, next.clientY - y) < 4) return;
        cancel(); window.chrome.webview.postMessage({ action, direction });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', cancel, {once:true});
      window.addEventListener('blur', cancel, {once:true});
    }

    function handleWindowResize(e, dir) {
      if (e.button === 0 && window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'windowResize', direction: dir });
      }
    }

    function minimizeWindow() {
      const root = document.getElementById('app-root') || document.body;
      root.style.filter = 'blur(2.5px)';
      root.style.transition = 'filter 0.12s ease';
      setTimeout(() => {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ action: 'windowMin' });
        }
        setTimeout(() => {
          root.style.filter = '';
          root.style.transition = '';
        }, 200);
      }, 90);
    }

    let isMaximized = false;

    function triggerResize(direction, event) {
      if (isMaximized) return;
      if (event.button !== 0) return; // 仅响应鼠标左键拖拽
      event.preventDefault();
      event.stopPropagation();
      if (window.chrome && window.chrome.webview) {
        handleHeaderMouseDown(event, 'windowResize', direction);
      }
    }

    function toggleMaximize() {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'windowToggleMax' });
      }
    }

    function closeWindow() {
      const root = document.getElementById('app-root') || document.body;
      root.style.filter = 'blur(3px)';
      root.style.opacity = '0.3';
      root.style.transition = 'all 0.12s ease';
      setTimeout(() => {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ action: 'windowClose' });
        }
        setTimeout(() => {
          root.style.filter = '';
          root.style.opacity = '1';
        }, 200);
      }, 90);
    }

    // 弹簧滑动胶囊切换
    function switchNav(tabName, btnEl) {
      currentNav = tabName;
      document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.remove('active');
      });
      btnEl.classList.add('active');

      const pill = document.getElementById('nav-spring-pill');
      const offsetTop = btnEl.offsetTop;
      pill.style.transform = `translateY(${offsetTop - 4}px)`;

      const titleEl = document.getElementById('header-page-title');
      if (tabName === 'usage') titleEl.innerText = '用量统计看板';
      else if (tabName === 'accounts') titleEl.innerText = '账号管理与配额';
      else if (tabName === 'daily') titleEl.innerText = '每日消耗流水';

      document.querySelectorAll('.view-panel').forEach(v => {
        v.classList.add('hidden');
        v.classList.remove('page-slide-in');
      });

      const targetView = document.getElementById(`view-${tabName}`);
      if (targetView) {
        targetView.classList.remove('hidden');
        void targetView.offsetWidth;
        targetView.classList.add('page-slide-in');
      }
    }

    // 热力图模式切换
    function setHeatMode(mode) {
      selectedCalDate = null;
      currentHeatMode = mode;
      const btnYear = document.getElementById('btn-heat-year');
      const btnMonth = document.getElementById('btn-heat-month');
      const wrapYear = document.getElementById('heatmap-year-wrap');
      const wrapMonth = document.getElementById('heatmap-month-wrap');
      const title = document.getElementById('heat-title');

      if (mode === 'year') {
        btnYear.className = 'px-2.5 py-1 rounded-lg transition-all duration-200 bg-[var(--bg-1e1d1a)] text-white shadow-2xs cursor-pointer';
        btnMonth.className = 'px-2.5 py-1 rounded-lg transition-all duration-200 text-[color:var(--text-5a5449)] hover:text-[color:var(--text-1e1d1a)] cursor-pointer';
        wrapYear.classList.remove('hidden');
        wrapMonth.classList.add('hidden');
        title.innerText = '年度活跃热力图';
        renderModelDistribution('all', null, '全量累计');
      } else {
        btnMonth.className = 'px-2.5 py-1 rounded-lg transition-all duration-200 bg-[var(--bg-1e1d1a)] text-white shadow-2xs cursor-pointer';
        btnYear.className = 'px-2.5 py-1 rounded-lg transition-all duration-200 text-[color:var(--text-5a5449)] hover:text-[color:var(--text-1e1d1a)] cursor-pointer';
        wrapYear.classList.add('hidden');
        wrapMonth.classList.remove('hidden');
        title.innerText = '月度消耗日历';
        renderMonthCalendar();
      }
    }

    function prevMonth() {
      currentCalMonth--;
      if (currentCalMonth < 0) {
        currentCalMonth = 11;
        currentCalYear--;
      }
      selectedCalDate = null;
      renderMonthCalendar();
    }

    function nextMonth() {
      currentCalMonth++;
      if (currentCalMonth > 11) {
        currentCalMonth = 0;
        currentCalYear++;
      }
      selectedCalDate = null;
      renderMonthCalendar();
    }

    function resetModelScope() {
      selectedCalDate = null;
      if (currentHeatMode === 'year') renderModelDistribution('all', null, '全量累计');
      else renderMonthCalendar();
    }

    // 渲染模型调度占比画像 (支持 month、day、all 多维作用域联动)
    function renderModelDistribution(scopeType, scopeKey, customTitle) {
      const modelContainer = document.getElementById('model-distribution-list');
      const badgeEl = document.getElementById('model-scope-badge');
      const resetBtn = document.getElementById('model-reset-scope-btn');
      if (!modelContainer) return;

      const stats = window.currentStats;
      if (!stats) return;

      let models = [];
      let scopeLabel = customTitle || '';

      if (scopeType === 'day') {
        models = (stats.dailyModels && stats.dailyModels[scopeKey]) ? stats.dailyModels[scopeKey] : [];
        if (!scopeLabel) scopeLabel = `${scopeKey} 单日`;
        if (resetBtn) {
          resetBtn.innerText = currentHeatMode === 'year' ? '恢复全量' : '恢复当月';
          resetBtn.classList.remove('hidden');
        }
      } else if (scopeType === 'month') {
        models = (stats.monthlyModels && stats.monthlyModels[scopeKey]) ? stats.monthlyModels[scopeKey] : [];
        if (!scopeLabel) {
          const parts = scopeKey.split('-');
          scopeLabel = `${parts[0]}年${parseInt(parts[1], 10)}月`;
        }
        if (resetBtn) resetBtn.classList.add('hidden');
      } else {
        models = stats.models || [];
        if (!scopeLabel) scopeLabel = '全量累计';
        if (resetBtn) resetBtn.classList.add('hidden');
      }

      if (badgeEl) {
        badgeEl.innerText = scopeLabel;
      }

      // 同步联动用量统计看板顶部的 Hero 卡片 (主力模型名称、占比与周期用量)
      const heroModelTitle = document.getElementById('hero-model-title');
      const heroTopModelName = document.getElementById('hero-top-model-name');
      const heroTopModelPct = document.getElementById('hero-top-model-pct');
      const heroTitle = document.getElementById('hero-title');
      const heroBadge = document.getElementById('hero-badge');
      const heroTodayExact = document.getElementById('hero-today-exact');
      const heroSubtext = document.getElementById('hero-subtext');

      if (models && models.length > 0) {
        const topM = models[0];
        if (heroTopModelName) heroTopModelName.innerText = topM.name;
        if (heroTopModelPct) heroTopModelPct.innerText = `占比 ${topM.percentage}%`;
      } else {
        if (heroTopModelName) heroTopModelName.innerText = '-';
        if (heroTopModelPct) heroTopModelPct.innerText = '占比 0%';
      }

      const todayStr = getLocalTodayStr();
      const heroCostBadge = document.getElementById('hero-cost-badge');
      const chipIn = document.getElementById('hero-chip-in');
      const chipCache = document.getElementById('hero-chip-cache');
      const chipOut = document.getElementById('hero-chip-out');

      if (scopeType === 'day') {
        const isToday = (scopeKey === todayStr);
        if (heroModelTitle) heroModelTitle.innerText = isToday ? '今日主力模型' : `${scopeKey.substring(5)} 主力模型`;
        if (heroTitle) heroTitle.innerText = isToday ? '今日实时会话追踪' : `${scopeKey} 会话追踪`;
        if (heroBadge) heroBadge.innerText = isToday ? 'Active Session' : '历史单日';

        const dayRec = allRecords.find(r => r.date === scopeKey);
        const dayTok = dayRec ? dayRec.tokens : models.reduce((sum, m) => sum + m.tokens, 0);
        const dayFmt = dayRec ? dayRec.formatted : fmtTokens(dayTok);
        const dayReqs = dayRec ? dayRec.requests : 0;
        if (heroTodayExact) heroTodayExact.innerText = Number(dayTok).toLocaleString();
        if (heroSubtext) heroSubtext.innerText = `Tokens · 当日消耗 ${dayFmt} (${dayReqs}次会话)`;

        // 联动金额 Badge (直接展示纯净金额，去除任何预估前缀)
        const dayCost = dayRec ? (dayRec.costFormatted || fmtCost(dayRec.costUsd || 0, dayRec.costRmb || 0)) : (dayTok > 0 ? fmtCost(0, 0) : '¥0.00');
        if (heroCostBadge) heroCostBadge.innerText = dayCost;

        // 联动 3 个构成明细 Chips
        if (dayRec) {
          const inTok = dayRec.inputTokens || 0;
          const inFmt = dayRec.inputFormatted || fmtTokens(inTok);
          const inPct = dayTok > 0 ? Math.round((inTok / dayTok) * 1000) / 10 : 0;
          if (chipIn) chipIn.innerHTML = `纯新输入 <b>${inFmt}</b> (${inPct}%)`;

          const cTok = dayRec.cachedTokens || 0;
          const cFmt = dayRec.cachedFormatted || fmtTokens(cTok);
          const cPct = dayRec.cachePercent !== undefined ? dayRec.cachePercent : (dayTok > 0 ? Math.round((cTok / dayTok) * 1000) / 10 : 0);
          if (chipCache) chipCache.innerHTML = `缓存命中 <b>${cFmt}</b> (${cPct}%)`;

          const outSum = (dayRec.outputTokens || 0) + (dayRec.reasoningTokens || 0);
          const outFmt = fmtTokens(outSum);
          const outPct = dayTok > 0 ? Math.round((outSum / dayTok) * 1000) / 10 : 0;
          if (chipOut) chipOut.innerHTML = `生成与思考 <b>${outFmt}</b> (${outPct}%)`;
        } else {
          if (chipIn) chipIn.innerHTML = '纯新输入 <b>0</b> (0%)';
          if (chipCache) chipCache.innerHTML = '缓存命中 <b>0</b> (0%)';
          if (chipOut) chipOut.innerHTML = '生成与思考 <b>0</b> (0%)';
        }
      } else if (scopeType === 'month') {
        const isCurrentMonth = scopeKey === todayStr.substring(0, 7);
        if (isCurrentMonth) {
          if (heroModelTitle) heroModelTitle.innerText = '今日主力模型';
          if (heroTitle) heroTitle.innerText = '今日实时会话追踪';
          if (heroBadge) heroBadge.innerText = 'Active Session';
          if (heroTodayExact && stats.todayTokens !== undefined) heroTodayExact.innerText = Number(stats.todayTokens).toLocaleString();
          if (heroSubtext && stats.totalFormatted) heroSubtext.innerText = `Tokens · 全量累计 ${stats.totalFormatted}`;
          if (heroCostBadge && stats.todayCostFormatted) heroCostBadge.innerText = stats.todayCostFormatted;

          // 若今日存在单日模型记录，优先展示今日主力
          if (stats.dailyModels && stats.dailyModels[todayStr] && stats.dailyModels[todayStr].length > 0) {
            const tm = stats.dailyModels[todayStr][0];
            if (heroTopModelName) heroTopModelName.innerText = tm.name;
            if (heroTopModelPct) heroTopModelPct.innerText = `占比 ${tm.percentage}%`;
          }

          // 恢复为今日 3 个构成 Chips
          if (chipIn && stats.todayInputFormatted) {
            const inPct = stats.todayTokens > 0 ? Math.round(((stats.todayInputTokens || 0) / stats.todayTokens) * 1000) / 10 : 0;
            chipIn.innerHTML = `纯新输入 <b>${escapeHtml(stats.todayInputFormatted || '0')}</b> (${inPct}%)`;
          }
          if (chipCache && stats.todayCachedFormatted) {
            const cPct = stats.todayCachePercent || (stats.todayTokens > 0 ? Math.round(((stats.todayCachedTokens || 0) / stats.todayTokens) * 1000) / 10 : 0);
            chipCache.innerHTML = `缓存命中 <b>${escapeHtml(stats.todayCachedFormatted || '0')}</b> (${cPct}%)`;
          }
          if (chipOut && (stats.todayOutputFormatted || stats.todayReasoningFormatted)) {
            const outSum = (stats.todayOutputTokens || 0) + (stats.todayReasoningTokens || 0);
            const outFmt = fmtTokens(outSum);
            const outPct = stats.todayTokens > 0 ? Math.round((outSum / stats.todayTokens) * 1000) / 10 : 0;
            chipOut.innerHTML = `生成与思考 <b>${outFmt}</b> (${outPct}%)`;
          }
        } else {
          if (heroModelTitle) heroModelTitle.innerText = `${escapeHtml(scopeLabel)} 主力模型`;
          if (heroTitle) heroTitle.innerText = `${escapeHtml(scopeLabel)} 消耗追踪`;
          if (heroBadge) heroBadge.innerText = '选定月份';

          const monthRecs = allRecords.filter(r => r.date.startsWith(scopeKey));
          const monthTokens = monthRecs.reduce((s, r) => s + r.tokens, 0);
          const monthReqs = monthRecs.reduce((s, r) => s + (r.requests || 0), 0);
          const monthUsd = monthRecs.reduce((s, r) => s + (r.costUsd || 0), 0);
          const monthRmb = monthRecs.reduce((s, r) => s + (r.costRmb || 0), 0);
          const monthIn = monthRecs.reduce((s, r) => s + (r.inputTokens || 0), 0);
          const monthCache = monthRecs.reduce((s, r) => s + (r.cachedTokens || 0), 0);
          const monthOut = monthRecs.reduce((s, r) => s + (r.outputTokens || 0) + (r.reasoningTokens || 0), 0);

          if (heroTodayExact) heroTodayExact.innerText = Number(monthTokens).toLocaleString();
          if (heroSubtext) heroSubtext.innerText = `Tokens · 当月消耗 ${fmtTokens(monthTokens)} (${monthReqs}次会话)`;
          if (heroCostBadge) heroCostBadge.innerText = fmtReferenceCost(monthUsd, monthRmb, hasUnpriced(monthRecs));

          if (chipIn) {
            const inPct = monthTokens > 0 ? Math.round((monthIn / monthTokens) * 1000) / 10 : 0;
            chipIn.innerHTML = `纯新输入 <b>${fmtTokens(monthIn)}</b> (${inPct}%)`;
          }
          if (chipCache) {
            const cPct = monthTokens > 0 ? Math.round((monthCache / monthTokens) * 1000) / 10 : 0;
            chipCache.innerHTML = `缓存命中 <b>${fmtTokens(monthCache)}</b> (${cPct}%)`;
          }
          if (chipOut) {
            const outPct = monthTokens > 0 ? Math.round((monthOut / monthTokens) * 1000) / 10 : 0;
            chipOut.innerHTML = `生成与思考 <b>${fmtTokens(monthOut)}</b> (${outPct}%)`;
          }
        }
      } else {
        if (heroModelTitle) heroModelTitle.innerText = '全期主力模型';
        if (heroTitle) heroTitle.innerText = '全周期消耗概览';
        if (heroBadge) heroBadge.innerText = 'All-Time';
        if (heroTodayExact && stats.totalTokens !== undefined) heroTodayExact.innerText = Number(stats.totalTokens).toLocaleString();
        if (heroSubtext && stats.totalFormatted) heroSubtext.innerText = `Tokens · 全量累计 ${stats.totalFormatted}`;
        if (heroCostBadge && stats.totalCostFormatted) heroCostBadge.innerText = stats.totalCostFormatted;

        // 全量累计 Chips
        const totIn = allRecords.reduce((s, r) => s + (r.inputTokens || 0), 0);
        const totCache = allRecords.reduce((s, r) => s + (r.cachedTokens || 0), 0);
        const totOut = allRecords.reduce((s, r) => s + (r.outputTokens || 0) + (r.reasoningTokens || 0), 0);
        const totTok = stats.totalTokens || 1;

        if (chipIn) {
          const inPct = Math.round((totIn / totTok) * 1000) / 10;
          chipIn.innerHTML = `纯新输入 <b>${fmtTokens(totIn)}</b> (${inPct}%)`;
        }
        if (chipCache) {
          const cPct = Math.round((totCache / totTok) * 1000) / 10;
          chipCache.innerHTML = `缓存命中 <b>${fmtTokens(totCache)}</b> (${cPct}%)`;
        }
        if (chipOut) {
          const outPct = Math.round((totOut / totTok) * 1000) / 10;
          chipOut.innerHTML = `生成与思考 <b>${fmtTokens(totOut)}</b> (${outPct}%)`;
        }
      }

      const chipRecords = scopeType === 'day' ? allRecords.filter(r => r.date === scopeKey)
        : scopeType === 'month' ? allRecords.filter(r => scopeKey === todayStr.slice(0, 7) ? r.date === todayStr : r.date.startsWith(scopeKey)) : allRecords;
      renderUsageChips(chipRecords);
      if (!models || models.length === 0) {
        modelContainer.innerHTML = `
          <div class="py-5 text-center text-xs text-[color:var(--text-8a8172)] tone-bg-f4efe6-50 rounded-xl border border-dashed border-[color:var(--border-ddd3c2)]">
            <span>该周期 (${escapeHtml(scopeLabel)}) 暂无模型调度记录</span>
          </div>
        `;
        return;
      }

      modelContainer.innerHTML = models.map(m => `
        <div class="space-y-1">
          <div class="flex justify-between text-xs font-medium">
            <span class="text-[color:var(--text-1e1d1a)] flex items-center gap-2 font-bold truncate max-w-[60%]">
              <span class="w-2 h-2 rounded-full shrink-0" style="background-color: ${safeColor(m.color)}"></span>
              <span class="truncate" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
            </span>
            <div class="flex items-center gap-2">
              ${m.costFormatted ? `<span title="${m.pricingBasis === 'base-variant' ? '该衍生模型沿用基座参考费率；画像与历史记录保留独立模型名' : m.pricingBasis === 'historical' ? '历史模型参考费率；不属于当前七种菜单模型' : m.pricingBasis === 'mixed' ? '按各条记录的参考费率分别计算，不代表订阅账单' : '项目参考估值，不代表订阅账单'}" class="text-[10px] font-bold text-[color:var(--text-9e6c18)] tone-bg-d4a338-15 border tone-border-d4a338-25 px-1.5 py-0.2 rounded num-cell">${escapeHtml(m.costFormatted)}</span>` : ''}
              <span class="text-[color:var(--text-276b38)] font-bold num-cell text-[11px] shrink-0">${escapeHtml(m.formatted)}</span>
              <span class="text-[color:var(--text-7a7367)] text-[10px] shrink-0">· ${quotaWidth(quotaValue(m.percentage))}%</span>
            </div>
          </div>
          <div class="w-full bg-[var(--bg-eae3d5)] h-2 rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500" style="width: ${quotaWidth(quotaValue(m.percentage))}%; background-color: ${safeColor(m.color)}"></div>
          </div>
        </div>
      `).join('');
    }

    // 渲染横向舒展单行紧凑月日历 (节约上下纵深，左右铺满)
    function usageThresholds(values) {
      const active = values.map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      const quantile = q => { if (!active.length) return 0; const index = (active.length - 1) * q; const lower = Math.floor(index); return active[lower] + (active[Math.ceil(index)] - active[lower]) * (index - lower); };
      return [quantile(.25), quantile(.5), quantile(.75)];
    }
    function usageLevel(tokens, thresholds) {
      if (!(Number(tokens) > 0)) return 0;
      return 1 + thresholds.filter(boundary => tokens > boundary).length;
    }

    function renderMonthCalendar() {
      const grid = document.getElementById('month-cal-grid');
      const title = document.getElementById('month-cal-title');
      if (!grid || !title) return;

      title.innerText = `${currentCalYear}年${currentCalMonth + 1}月`;
      grid.innerHTML = '';

      const monthKey = `${currentCalYear}-${String(currentCalMonth + 1).padStart(2, '0')}`;
      if (selectedCalDate && !selectedCalDate.startsWith(monthKey)) {
        selectedCalDate = null;
      }

      // 联动下方模型调度占比画像
      if (selectedCalDate) {
        renderModelDistribution('day', selectedCalDate, `${selectedCalDate} 单日`);
      } else {
        renderModelDistribution('month', monthKey, `${currentCalYear}年${currentCalMonth + 1}月`);
      }

      const firstDay = new Date(currentCalYear, currentCalMonth, 1).getDay();
      const totalDays = new Date(currentCalYear, currentCalMonth + 1, 0).getDate();

      for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'h-7.5 rounded-lg bg-transparent';
        grid.appendChild(empty);
      }

      const recMap = {};
      allRecords.forEach(r => {
        recMap[r.date] = r;
      });

      const todayStr = getLocalTodayStr();
      const thresholds = usageThresholds(allRecords.filter(r => r.date.startsWith(monthKey)).map(r => r.tokens));
      const scaleLabel = document.getElementById('heatmap-scale-label');
      if (scaleLabel) scaleLabel.title = `按当月活跃日期用量分档：${thresholds.map(fmtTokens).join(' / ')} tokens；颜色越深用量越多`;

      for (let day = 1; day <= totalDays; day++) {
        const dStr = String(day).padStart(2, '0');
        const mStr = String(currentCalMonth + 1).padStart(2, '0');
        const dateStr = `${currentCalYear}-${mStr}-${dStr}`;

        const rec = recMap[dateStr];
        const tokens = rec ? rec.tokens : 0;
        const reqs = rec ? rec.requests : 0;
        const isToday = (dateStr === todayStr);
        const isSelected = (dateStr === selectedCalDate);

        const level = usageLevel(tokens, thresholds);

        const cell = document.createElement('div');
        cell.className = `cal-day-cell h-7.5 px-2 flex items-center justify-between rounded-lg border transition-all duration-150 cursor-pointer ${
          isSelected
            ? 'border-[color:var(--border-8c3f2b)] ring-2 ring-[color:var(--border-8c3f2b)] shadow-xs tone-bg-8c3f2b-10'
            : (isToday ? 'border-[color:var(--border-8c3f2b)] ring-1.5 tone-ring-8c3f2b-35 shadow-2xs' : 'border-[color:var(--border-dfd6c5)]')
        } heat-l-${level}`;

        cell.innerHTML = `
          <div class="flex items-center gap-1.5 text-[10.5px] font-bold ${level >= 3 ? 'text-white' : 'text-[color:var(--text-322f2a)]'}">
            <span>${day}</span>
            ${isToday ? '<span class="w-1.5 h-1.5 rounded-full bg-[var(--bg-8c3f2b)] shrink-0"></span>' : ''}
          </div>
          <div class="text-[9.5px] num-cell font-bold truncate ${level >= 3 ? 'text-white' : (tokens > 0 ? 'text-[color:var(--text-276b38)]' : 'text-[color:var(--text-8a8172)]')}">
            ${tokens > 0 ? fmtTokens(tokens) : '-'}
          </div>
        `;

        const dayCost = rec ? (rec.costFormatted || fmtCost(rec.costUsd || 0, rec.costRmb || 0)) : (tokens > 0 ? fmtCost(0, 0) : '¥0.00');
        cell.dataset.date = dateStr;
        cell.dataset.tokens = tokens;
        cell.dataset.reqs = reqs;
        cell.dataset.today = isToday ? '1' : '0';
        cell.dataset.cost = dayCost;

        grid.appendChild(cell);
      }

      grid.onmouseover = (e) => {
        const cell = e.target.closest('.cal-day-cell');
        if (cell && cell.dataset.date) {
          showTooltip(e, cell.dataset.date, Number(cell.dataset.tokens), Number(cell.dataset.reqs), cell.dataset.today === '1', cell.dataset.cost);
        }
      };
      grid.onmouseout = (e) => {
        const related = e.relatedTarget;
        if (!related || !grid.contains(related)) {
          hideTooltip();
        }
      };
      grid.onclick = (e) => {
        const cell = e.target.closest('.cal-day-cell');
        if (cell && cell.dataset.date) {
          const dateStr = cell.dataset.date;
          if (selectedCalDate === dateStr) {
            selectedCalDate = null;
          } else {
            selectedCalDate = dateStr;
          }
          renderMonthCalendar();
        }
      };
    }

    function fmtTokens(n) {
      if (n >= 1000000000) return `${(n / 1000000000).toFixed(2)}B`;
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
      return String(n);
    }

    function hasUnpriced(records) { return records.some(r => (r.unpricedTokens || 0) > 0 || String(r.costFormatted || '').includes('未定价')); }
    function fmtReferenceCost(usd, rmb, incomplete) {
      return incomplete ? ((usd || rmb) > 0 ? `≥${fmtCost(usd, rmb)}（部分未定价）` : '未定价') : fmtCost(usd, rmb);
    }
    function renderUsageChips(records) {
      const sum = field => records.reduce((n, r) => n + (Number(r[field]) || 0), 0);
      const total = sum('tokens'), input = sum('inputTokens'), read = sum('cachedTokens'), write = sum('cacheWriteTokens');
      const output = sum('outputTokens') + sum('reasoningTokens');
      const unknown = Math.max(0, total - input - read - write - output);
      const percent = n => total > 0 ? Math.round(n / total * 1000) / 10 : 0;
      const inChip = document.getElementById('hero-chip-in');
      const cacheChip = document.getElementById('hero-chip-cache');
      const outChip = document.getElementById('hero-chip-out');
      if (inChip) inChip.innerHTML = `纯新输入 <b>${fmtTokens(input)}</b> (${percent(input)}%)`;
      if (cacheChip) {
        cacheChip.innerHTML = `缓存读取 <b>${fmtTokens(read)}</b> (${percent(read)}%)${write > 0 ? ` · 缓存写入 <b>${fmtTokens(write)}</b> (${percent(write)}%)` : ''}`;
        cacheChip.title = '缓存读取：复用已有上下文；缓存写入：创建缓存的 tokens，仅在记录值大于 0 时显示。';
      }
      if (outChip) outChip.innerHTML = `生成与思考 <b>${fmtTokens(output)}</b> (${percent(output)}%)${unknown ? ` · 未分类 ${fmtTokens(unknown)}` : ''}`;
    }

    function fmtCost(usd, rmb) {
      const isUsd = (appSettings && appSettings.currency === 'USD');
      if (isUsd) {
        return `$${(usd || 0).toFixed(2)}`;
      } else {
        let r = rmb;
        if ((!r || r === 0) && usd > 0) {
          const rate = (appSettings && appSettings.liveUsdToCnyRate) || 7.24;
          r = usd * rate;
        }
        return `¥${(r || 0).toFixed(2)}`;
      }
    }

    function formatLocalDate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function getLocalTodayStr() {
      return formatLocalDate(new Date());
    }

    function getCurrentStreak(records) {
      const active = new Set((records || []).filter(r => r.tokens > 0).map(r => r.date));
      const cursor = new Date();
      cursor.setHours(12, 0, 0, 0);
      if (!active.has(formatLocalDate(cursor))) cursor.setDate(cursor.getDate() - 1);
      let streak = 0;
      while (active.has(formatLocalDate(cursor))) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      }
      return streak;
    }

    function showTooltip(e, date, tokens, reqs, isToday, cost) {
      const tt = document.getElementById('floating-tooltip');
      const dEl = document.getElementById('tt-date');
      const tEl = document.getElementById('tt-tokens');
      const cEl = document.getElementById('tt-cost');
      const rEl = document.getElementById('tt-reqs');

      if (!tt || !dEl || !tEl) return;

      dEl.innerHTML = `<span>${escapeHtml(date)}</span>${isToday ? '<span class="text-[9.5px] font-bold px-1.5 py-0.2 rounded bg-[var(--bg-246337)] text-[color:var(--text-d1f2d9)]">今日</span>' : ''}`;
      tEl.innerText = tokens > 0 ? tokens.toLocaleString() : '0';
      if (cEl) {
        cEl.innerText = cost || (tokens > 0 ? fmtCost(0, 0) : '¥0.00');
      }
      rEl.innerText = tokens > 0 ? `${reqs} 次会话交互` : '暂无 Token 消耗';

      const targetEl = (e.target && e.target.closest)
        ? (e.target.closest('.heat-dot') || e.target.closest('.cal-day-cell') || e.target)
        : (e.currentTarget || e.target);
      const rect = targetEl.getBoundingClientRect();
      tt.style.left = `${rect.left + rect.width / 2}px`;
      tt.style.top = `${rect.top - 8}px`;
      tt.style.opacity = '1';
    }

    function hideTooltip() {
      const tt = document.getElementById('floating-tooltip');
      if (tt) tt.style.opacity = '0';
    }

    function switchFlowMode(mode) {
      currentFlowMode = mode;
      const btnDay = document.getElementById('flow-tab-day');
      const btnWeek = document.getElementById('flow-tab-week');
      const btnMonth = document.getElementById('flow-tab-month');
      const vDay = document.getElementById('flow-view-day');
      const vWeek = document.getElementById('flow-view-week');
      const vMonth = document.getElementById('flow-view-month');
      const mFilter = document.getElementById('flow-month-filter-wrap');

      // Reset buttons
      [btnDay, btnWeek, btnMonth].forEach(btn => {
        btn.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-xl transition-all duration-200 text-[color:var(--text-5c5549)] hover:text-[color:var(--text-1e1d1a)] cursor-pointer';
      });

      vDay.classList.add('hidden');
      vWeek.classList.add('hidden');
      vMonth.classList.add('hidden');

      if (mode === 'day') {
        btnDay.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-xl transition-all duration-200 bg-[var(--bg-1e1d1a)] text-white shadow-2xs cursor-pointer';
        vDay.classList.remove('hidden');
        mFilter.classList.remove('hidden');
        renderDailyTable();
        const filtered = (selectedDailyMonth === 'all') 
          ? allRecords 
          : allRecords.filter(r => r.date.startsWith(selectedDailyMonth));
        updateFlowSummary(filtered, selectedDailyMonth);
      } else if (mode === 'week') {
        btnWeek.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-xl transition-all duration-200 bg-[var(--bg-1e1d1a)] text-white shadow-2xs cursor-pointer';
        vWeek.classList.remove('hidden');
        mFilter.classList.add('hidden');
        if (hoverResetTimer) {
          clearTimeout(hoverResetTimer);
          hoverResetTimer = null;
        }
        currentExpandedWeekKey = null;
        hoveredWeekKey = null;
        updateFlowSummary(allRecords, 'all');
        renderWeeklyFlow();
      } else if (mode === 'month') {
        btnMonth.className = 'flex items-center space-x-1.5 px-3 py-1.5 rounded-xl transition-all duration-200 bg-[var(--bg-1e1d1a)] text-white shadow-2xs cursor-pointer';
        vMonth.classList.remove('hidden');
        mFilter.classList.add('hidden');
        if (hoverResetTimer) {
          clearTimeout(hoverResetTimer);
          hoverResetTimer = null;
        }
        currentExpandedMonthKey = null;
        hoveredMonthKey = null;
        updateFlowSummary(allRecords, 'all');
        renderMonthlyFlow();
      }
    }

    // ================= 自定义纸质月份下拉菜单 =================
    function toggleMonthDropdown(e) {
      if (e) e.stopPropagation();
      isMonthDropdownOpen = !isMonthDropdownOpen;
      const menu = document.getElementById('month-dropdown-menu');
      const chevron = document.getElementById('month-chevron');
      if (!menu) return;

      if (isMonthDropdownOpen) {
        menu.classList.remove('hidden');
        requestAnimationFrame(() => {
          menu.classList.remove('opacity-0', 'scale-95');
          menu.classList.add('opacity-100', 'scale-100');
        });
        if (chevron) chevron.classList.add('rotate-180');
      } else {
        closeMonthDropdown();
      }
    }

    function closeMonthDropdown() {
      const menu = document.getElementById('month-dropdown-menu');
      const chevron = document.getElementById('month-chevron');
      if (!menu) return;
      menu.classList.remove('opacity-100', 'scale-100');
      menu.classList.add('opacity-0', 'scale-95');
      setTimeout(() => {
        menu.classList.add('hidden');
        isMonthDropdownOpen = false;
      }, 150);
      if (chevron) chevron.classList.remove('rotate-180');
    }

    document.addEventListener('click', (e) => {
      const wrapper = document.getElementById('flow-month-filter-wrap');
      if (wrapper && !wrapper.contains(e.target) && isMonthDropdownOpen) {
        closeMonthDropdown();
      }

      // 点击页面空白处即刻恢复全量流水汇总 (若当前无卡片展开)
      const isWeekCard = e.target.closest('[id^="week-card-"]');
      const isMonthCard = e.target.closest('[id^="month-card-"]');
      const isInteractive = e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('a');
      if (!isWeekCard && !isMonthCard && !isInteractive) {
        if (!currentExpandedWeekKey && !currentExpandedMonthKey) {
          if (hoverResetTimer) {
            clearTimeout(hoverResetTimer);
            hoverResetTimer = null;
          }
          revertFlowSummaryToDefault();
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isMonthDropdownOpen) {
        closeMonthDropdown();
      }
    });

    // 动态计算并更新流水页面顶部 4 张大卡 (支持全局、单月与单周动态联动重算)
    function updateFlowSummary(records, scopeType, scopeTitle) {
      const isAll = (!scopeType || scopeType === 'all');

      const elDays = document.getElementById('flow-summary-days');
      const elTotal = document.getElementById('flow-summary-total');
      const elAvg = document.getElementById('flow-summary-avg');
      const elPeak = document.getElementById('flow-summary-peak');

      const elDaysLabel = document.getElementById('flow-summary-days-label');
      const elTotalLabel = document.getElementById('flow-summary-total-label');
      const elAvgLabel = document.getElementById('flow-summary-avg-label');
      const elPeakLabel = document.getElementById('flow-summary-peak-label');

      records = records || [];

      let total = 0;
      let totalCostUsd = 0;
      let totalCostRmb = 0;
      let maxRec = records[0];
      records.forEach(r => {
        total += r.tokens;
        totalCostUsd += (r.costUsd || 0);
        totalCostRmb += (r.costRmb || 0);
        if (r.tokens > maxRec.tokens) maxRec = r;
      });

      const count = records.length;
      const avg = count > 0 ? Math.round(total / count) : 0;
      const avgCostUsd = count > 0 ? (totalCostUsd / count) : 0;
      const avgCostRmb = count > 0 ? (totalCostRmb / count) : 0;

      const totalCostFormatted = fmtReferenceCost(totalCostUsd, totalCostRmb, hasUnpriced(records));
      const avgCostFormatted = fmtReferenceCost(avgCostUsd, avgCostRmb, hasUnpriced(records));

      if (elDays) elDays.innerText = `${count} 天`;
      if (elTotal) elTotal.innerHTML = `<span class="text-lg font-black text-[color:var(--text-276b38)] num-cell">${fmtTokens(total)}</span> <span class="text-xs font-bold text-[color:var(--text-9e6c18)] ml-1">(${totalCostFormatted})</span>`;
      if (elAvg) elAvg.innerHTML = `<span class="text-lg font-black text-[color:var(--text-276b38)] num-cell">${fmtTokens(avg)}</span> <span class="text-[10px] text-[color:var(--text-9e6c18)] font-semibold ml-1">(${avgCostFormatted})</span>`;
      if (elPeak && maxRec) {
        const peakCost = maxRec ? (maxRec.costFormatted || fmtCost(maxRec.costUsd || 0, maxRec.costRmb || 0)) : '';
        elPeak.innerHTML = `<span class="text-lg font-black text-[color:var(--text-276b38)] num-cell">${maxRec.date.substring(5)}</span> <span class="text-xs text-[color:var(--text-7a7367)]">(${escapeHtml(maxRec.formatted)})</span> <span class="text-[10px] text-[color:var(--text-9e6c18)] font-bold block">${escapeHtml(peakCost)}</span>`;
      } else if (elPeak) {
        elPeak.innerText = '-';
      }

      if (scopeType === 'week') {
        if (elDaysLabel) elDaysLabel.innerText = scopeTitle ? `${scopeTitle} 覆盖天数` : '当周覆盖天数';
        if (elTotalLabel) elTotalLabel.innerText = '当周累计 Token';
        if (elAvgLabel) elAvgLabel.innerText = '当周日均消耗';
        if (elPeakLabel) elPeakLabel.innerText = '当周最高单日';
      } else if (scopeType === 'month') {
        if (elDaysLabel) elDaysLabel.innerText = scopeTitle ? `${scopeTitle} 活跃天数` : '当月活跃天数';
        if (elTotalLabel) elTotalLabel.innerText = '当月累计 Token';
        if (elAvgLabel) elAvgLabel.innerText = '当月日均消耗';
        if (elPeakLabel) elPeakLabel.innerText = '当月最高单日';
      } else {
        if (elDaysLabel) elDaysLabel.innerText = '全期记录覆盖';
        if (elTotalLabel) elTotalLabel.innerText = '周期累计 Token';
        if (elAvgLabel) elAvgLabel.innerText = '全期日均消耗';
        if (elPeakLabel) elPeakLabel.innerText = '单日最高峰值';
      }
    }

    // ================= 逐月与逐周流水平级手风琴与光标悬浮实时预览 =================
    let currentExpandedMonthKey = null;
    let currentExpandedWeekKey = null;
    let monthGroupsCache = {};
    let weekGroupsCache = {};
    let hoverResetTimer = null;

    function revertFlowSummaryToDefault() {
      if (currentExpandedWeekKey && weekGroupsCache[currentExpandedWeekKey]) {
        const ew = weekGroupsCache[currentExpandedWeekKey];
        updateFlowSummary(ew.days, 'week', `${ew.startDate.substring(5)}至${ew.endDate.substring(5)}`);
      } else if (currentExpandedMonthKey && monthGroupsCache[currentExpandedMonthKey]) {
        const em = monthGroupsCache[currentExpandedMonthKey];
        const parts = em.month.split('-');
        updateFlowSummary(em.days, 'month', `${parts[0]}年${parts[1]}月`);
      } else {
        updateDefaultFlowSummary();
      }
    }

    function updateDefaultFlowSummary() {
      const filtered = currentFlowMode === 'day' && selectedDailyMonth !== 'all';
      const records = filtered ? allRecords.filter(r => r.date.startsWith(selectedDailyMonth)) : allRecords;
      const title = filtered ? `${selectedDailyMonth.slice(0, 4)}年${selectedDailyMonth.slice(5)}月` : null;
      updateFlowSummary(records, filtered ? 'month' : 'all', title);
    }

    function previewWeekCard(safeKey) {
      if (hoverResetTimer) {
        clearTimeout(hoverResetTimer);
        hoverResetTimer = null;
      }
      hoveredWeekKey = safeKey;
      const w = weekGroupsCache[safeKey];
      if (!w) return;
      updateFlowSummary(w.days, 'week', `${w.startDate.substring(5)}至${w.endDate.substring(5)}`);
      const card = document.getElementById('week-card-' + safeKey);
      if (card && currentExpandedWeekKey !== safeKey) {
        card.classList.add('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
      }
    }

    function unpreviewWeekCard(safeKey) {
      if (hoveredWeekKey === safeKey) {
        hoveredWeekKey = null;
      }
      const card = document.getElementById('week-card-' + safeKey);
      if (card && currentExpandedWeekKey !== safeKey) {
        card.classList.remove('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
      }

      // 默认保留刚刚划过的卡片数据，两张卡片间隙绝不跳变闪烁！
      // 启动 3 秒延迟恢复定时器：若 3 秒内未划入新卡片，才平滑回退
      if (hoverResetTimer) clearTimeout(hoverResetTimer);
      hoverResetTimer = setTimeout(() => {
        revertFlowSummaryToDefault();
        hoverResetTimer = null;
      }, 3000);
    }

    function previewMonthCard(safeKey) {
      if (hoverResetTimer) {
        clearTimeout(hoverResetTimer);
        hoverResetTimer = null;
      }
      hoveredMonthKey = safeKey;
      const m = monthGroupsCache[safeKey];
      if (!m) return;
      const parts = m.month.split('-');
      updateFlowSummary(m.days, 'month', `${parts[0]}年${parts[1]}月`);
      const card = document.getElementById('month-card-' + safeKey);
      if (card && currentExpandedMonthKey !== safeKey) {
        card.classList.add('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
      }
    }

    function unpreviewMonthCard(safeKey) {
      if (hoveredMonthKey === safeKey) {
        hoveredMonthKey = null;
      }
      const card = document.getElementById('month-card-' + safeKey);
      if (card && currentExpandedMonthKey !== safeKey) {
        card.classList.remove('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
      }

      // 默认保留刚刚划过的卡片数据，两张卡片间隙绝不跳变闪烁！
      // 启动 3 秒延迟恢复定时器：若 3 秒内未划入新卡片，才平滑回退
      if (hoverResetTimer) clearTimeout(hoverResetTimer);
      hoverResetTimer = setTimeout(() => {
        revertFlowSummaryToDefault();
        hoverResetTimer = null;
      }, 3000);
    }

    function toggleMonthCard(safeKey) {
      if (hoverResetTimer) {
        clearTimeout(hoverResetTimer);
        hoverResetTimer = null;
      }
      const el = document.getElementById('month-details-' + safeKey);
      const icon = document.getElementById('month-icon-' + safeKey);
      const card = document.getElementById('month-card-' + safeKey);
      if (!el) return;

      const isCurrentlyOpen = !el.classList.contains('hidden');

      if (isCurrentlyOpen) {
        el.classList.add('hidden');
        if (icon) icon.classList.remove('rotate-180');
        if (card) {
          card.classList.remove('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
        }
        currentExpandedMonthKey = null;
        revertFlowSummaryToDefault();
      } else {
        // 关闭此前展开的月份
        if (currentExpandedMonthKey && currentExpandedMonthKey !== safeKey) {
          const prevEl = document.getElementById('month-details-' + currentExpandedMonthKey);
          const prevIcon = document.getElementById('month-icon-' + currentExpandedMonthKey);
          const prevCard = document.getElementById('month-card-' + currentExpandedMonthKey);
          if (prevEl) prevEl.classList.add('hidden');
          if (prevIcon) prevIcon.classList.remove('rotate-180');
          if (prevCard) {
            prevCard.classList.remove('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
          }
        }

        el.classList.remove('hidden');
        if (icon) icon.classList.add('rotate-180');
        if (card) {
          card.classList.remove('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
          card.classList.add('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
        }
        currentExpandedMonthKey = safeKey;

        const m = monthGroupsCache[safeKey];
        if (m) {
          const parts = m.month.split('-');
          updateFlowSummary(m.days, 'month', `${parts[0]}年${parts[1]}月`);
        }
      }
    }

    function toggleWeekCard(safeKey) {
      if (hoverResetTimer) {
        clearTimeout(hoverResetTimer);
        hoverResetTimer = null;
      }
      const el = document.getElementById('week-details-' + safeKey);
      const icon = document.getElementById('week-icon-' + safeKey);
      const card = document.getElementById('week-card-' + safeKey);
      if (!el) return;

      const isCurrentlyOpen = !el.classList.contains('hidden');

      if (isCurrentlyOpen) {
        el.classList.add('hidden');
        if (icon) icon.classList.remove('rotate-180');
        if (card) {
          card.classList.remove('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
        }
        currentExpandedWeekKey = null;
        revertFlowSummaryToDefault();
      } else {
        // 关闭此前展开的周
        if (currentExpandedWeekKey && currentExpandedWeekKey !== safeKey) {
          const prevEl = document.getElementById('week-details-' + currentExpandedWeekKey);
          const prevIcon = document.getElementById('week-icon-' + currentExpandedWeekKey);
          const prevCard = document.getElementById('week-card-' + currentExpandedWeekKey);
          if (prevEl) prevEl.classList.add('hidden');
          if (prevIcon) prevIcon.classList.remove('rotate-180');
          if (prevCard) {
            prevCard.classList.remove('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
          }
        }

        el.classList.remove('hidden');
        if (icon) icon.classList.add('rotate-180');
        if (card) {
          card.classList.remove('ring-1.5', 'tone-ring-8c3f2b-35', 'tone-border-8c3f2b-50');
          card.classList.add('ring-1.5', 'tone-ring-3c804f-40', 'bg-[var(--bg-faf8f2)]');
        }
        currentExpandedWeekKey = safeKey;

        const w = weekGroupsCache[safeKey];
        if (w) {
          updateFlowSummary(w.days, 'week', `${w.startDate.substring(5)}至${w.endDate.substring(5)}`);
        }
      }
    }

    function selectDailyMonth(val, label) {
      selectedDailyMonth = val;
      const labelEl = document.getElementById('selected-month-text');
      if (labelEl) labelEl.innerText = label;
      closeMonthDropdown();
      renderMonthDropdownOptions();
      renderDailyTable();

      const filtered = (val === 'all') 
        ? allRecords 
        : allRecords.filter(r => r.date.startsWith(val));
      updateFlowSummary(filtered, val === 'all' ? 'all' : 'month', label);
    }

    function renderMonthDropdownOptions() {
      const menu = document.getElementById('month-dropdown-menu');
      if (!menu || !allRecords) return;

      const mSet = new Set();
      allRecords.forEach(r => mSet.add(r.date.substring(0, 7)));
      const sortedM = Array.from(mSet).sort().reverse();

      const options = [
        { val: 'all', label: '全部月份 (全量记录)' },
        ...sortedM.map(m => {
          const p = m.split('-');
          return { val: m, label: `${p[0]}年${p[1]}月` };
        })
      ];

      menu.innerHTML = options.map(opt => {
        const isSelected = (opt.val === selectedDailyMonth);
        return `
          <div onclick="selectDailyMonth('${opt.val}', '${opt.label}')" 
               class="px-3 py-2 text-xs rounded-xl flex items-center justify-between cursor-pointer transition-colors ${
                 isSelected 
                   ? 'bg-[var(--bg-ede6d8)] text-[color:var(--text-1e1d1a)] font-bold' 
                   : 'text-[color:var(--text-4a443a)] hover:bg-[var(--bg-f2ece0)] hover:text-[color:var(--text-1e1d1a)]'
               }">
            <span>${opt.label}</span>
            ${isSelected ? `<svg class="w-3.5 h-3.5 text-[color:var(--text-1e1d1a)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>` : ''}
          </div>
        `;
      }).join('');
    }

    // 1. 渲染按日明细 (全量 7 列结构，对齐 TokenTracker 标准)
    function renderDailyTable() {
      const tableBody = document.getElementById('daily-table-body');
      if (!tableBody || !allRecords) return;

      const filtered = selectedDailyMonth === 'all' 
        ? allRecords 
        : allRecords.filter(r => r.date.startsWith(selectedDailyMonth));

      const todayStr = getLocalTodayStr();
      tableBody.innerHTML = filtered.map((d) => {
        const isToday = d.date === todayStr;
        const cachePct = d.cachePercent !== undefined ? d.cachePercent : (d.tokens > 0 ? Math.round(((d.cachedTokens || 0) / d.tokens) * 1000) / 10 : 0);
        return `
        <tr class="hover:bg-[var(--bg-faf8f2)] transition-colors">
          <td class="py-2.5 px-4 font-semibold text-[color:var(--text-22201d)]">
            ${escapeHtml(d.date)}${isToday ? ' <span class="text-[10px] tone-bg-8c3f2b-10 text-[color:var(--text-8c3f2b)] font-bold px-1.5 py-0.5 rounded ml-1">今日</span>' : ''}
          </td>
          <td class="py-2.5 px-4 font-bold num-cell ${isToday ? 'text-[color:var(--text-8c3f2b)]' : 'text-[color:var(--text-276b38)]'}">
            ${escapeHtml(d.formatted || fmtTokens(d.tokens))}
            <span class="text-[10px] text-[color:var(--text-8a8172)] font-normal block leading-none pt-0.5">${Number(d.tokens).toLocaleString()}</span>
          </td>
          <td class="py-2.5 px-4 font-semibold num-cell">
            <span class="text-[10.5px] font-bold text-[color:var(--text-9e6c18)] tone-bg-d4a338-15 border tone-border-d4a338-30 px-1.5 py-0.5 rounded">${escapeHtml(d.costFormatted || fmtCost(0, 0))}</span>
          </td>
          <td class="py-2.5 px-4 font-semibold text-[color:var(--text-2b6cb0)] num-cell">
            ${d.inputFormatted || fmtTokens(d.inputTokens || 0)}
          </td>
          <td class="py-2.5 px-4 num-cell">
            <div class="flex items-center gap-1.5 text-[color:var(--text-9e6518)] font-semibold">
              <span>${escapeHtml(d.cachedFormatted || fmtTokens(d.cachedTokens || 0))}${d.cacheWriteTokens > 0 ? ` / 写入 ${escapeHtml(d.cacheWriteFormatted || fmtTokens(d.cacheWriteTokens))}` : ''}</span>
              <span class="text-[9.5px] px-1 py-0.2 rounded tone-bg-b87a28-15 font-black">${cachePct}%</span>
            </div>
          </td>
          <td class="py-2.5 px-4 font-semibold text-[color:var(--text-3c804f)] num-cell">
            ${d.outputFormatted || fmtTokens(d.outputTokens || 0)}
          </td>
          <td class="py-2.5 px-4 font-semibold text-[color:var(--text-6b46c1)] num-cell">
            ${d.reasoningFormatted || fmtTokens(d.reasoningTokens || 0)}
          </td>
          <td class="py-2.5 px-4 text-[color:var(--text-7a7265)] num-cell font-medium">
            ${d.requests} 次
          </td>
        </tr>
      `;
      }).join('');
    }

    // 2. 渲染按周归档 (整卡点击展开，顶部指标联动，无多余按键，柔和宣纸边框)
    function renderWeeklyFlow() {
      const container = document.getElementById('week-cards-container');
      if (!container || !allRecords) return;

      const weekGroups = {};
      allRecords.forEach(r => {
        const dt = new Date(r.date + 'T00:00:00');
        const dayOfWeek = (dt.getDay() + 6) % 7;
        const monday = new Date(dt);
        monday.setDate(dt.getDate() - dayOfWeek);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);

        const key = formatLocalDate(monday);
        if (!weekGroups[key]) {
          weekGroups[key] = {
            startDate: key,
            endDate: formatLocalDate(sunday),
            totalTokens: 0,
            totalCostUsd: 0,
            totalCostRmb: 0,
            totalReqs: 0,
            activeDays: 0,
            days: []
          };
        }
        weekGroups[key].totalTokens += r.tokens;
        weekGroups[key].totalCostUsd += (r.costUsd || 0);
        weekGroups[key].totalCostRmb += (r.costRmb || 0);
        weekGroups[key].totalReqs += r.requests;
        weekGroups[key].activeDays++;
        weekGroups[key].days.push(r);
      });

      const sortedWeeks = Object.values(weekGroups).sort((a, b) => b.startDate.localeCompare(a.startDate));
      const maxWeekTokens = Math.max(...sortedWeeks.map(w => w.totalTokens), 1);

      weekGroupsCache = {};
      sortedWeeks.forEach(w => {
        const safeKey = w.startDate.replace(/[^a-zA-Z0-9]/g, '_');
        weekGroupsCache[safeKey] = w;
      });

      container.innerHTML = sortedWeeks.map((w, idx) => {
        const pct = Math.round((w.totalTokens / maxWeekTokens) * 100);
        const avg = Math.round(w.totalTokens / w.activeDays);
        const today = getLocalTodayStr();
        const isCurWeek = w.startDate <= today && today <= w.endDate;
        const safeKey = w.startDate.replace(/[^a-zA-Z0-9]/g, '_');
        const sortedDays = [...w.days].sort((a, b) => b.date.localeCompare(a.date));
        const weekCostStr = fmtReferenceCost(w.totalCostUsd, w.totalCostRmb, hasUnpriced(w.days));
        const avgCostStr = fmtReferenceCost(w.totalCostUsd / w.activeDays, w.totalCostRmb / w.activeDays, hasUnpriced(w.days));

        const todayStr = getLocalTodayStr();
        const daysTableRows = sortedDays.map(d => `
          <tr class="hover:bg-[var(--bg-faf8f2)] transition-colors">
            <td class="py-2 px-3.5 font-semibold text-[color:var(--text-22201d)]">
              ${escapeHtml(d.date)}${d.date === todayStr ? ' <span class="text-[10px] tone-bg-8c3f2b-10 text-[color:var(--text-8c3f2b)] font-bold px-1.5 py-0.5 rounded ml-1">今日</span>' : ''}
            </td>
            <td class="py-2 px-3.5 font-bold num-cell ${d.date === todayStr ? 'text-[color:var(--text-8c3f2b)]' : 'text-[color:var(--text-276b38)]'}">
              ${escapeHtml(d.formatted || fmtTokens(d.tokens))}
              <span class="text-[10px] text-[color:var(--text-8a8172)] font-normal block leading-none pt-0.5">${Number(d.tokens).toLocaleString()}</span>
            </td>
            <td class="py-2 px-3.5 font-semibold num-cell">
              <span class="text-[10.5px] font-bold text-[color:var(--text-9e6c18)] tone-bg-d4a338-15 border tone-border-d4a338-30 px-1.5 py-0.5 rounded">${escapeHtml(d.costFormatted || fmtCost(d.costUsd || 0, d.costRmb || 0))}</span>
            </td>
            <td class="py-2 px-3.5 text-[color:var(--text-7a7265)] num-cell">${d.requests} 次</td>
          </tr>
        `).join('');

        return `
          <div id="week-card-${safeKey}" 
               onclick="toggleWeekCard('${safeKey}')"
               onmouseenter="previewWeekCard('${safeKey}')"
               onmouseleave="unpreviewWeekCard('${safeKey}')"
               class="paper-card p-4 space-y-3 gentle-bounce border border-[color:var(--border-ddd3c2)] hover:border-[color:var(--border-bfaf98)] hover:shadow-xs cursor-pointer transition-all">
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2.5">
                <span class="w-2 h-2 rounded-full ${isCurWeek ? 'bg-[var(--bg-8c3f2b)] animate-pulse' : 'bg-[var(--bg-3c804f)]'}"></span>
                <h4 class="text-xs font-bold text-[color:var(--text-1e1d1a)]">
                  ${w.startDate.substring(5)} 至 ${w.endDate.substring(5)} 
                  ${isCurWeek ? '<span class="ml-1.5 text-[10px] tone-bg-8c3f2b-10 text-[color:var(--text-8c3f2b)] border tone-border-8c3f2b-25 px-2 py-0.5 rounded-full font-bold">本周</span>' : ''}
                </h4>
              </div>
              <div class="flex items-center space-x-3">
                <div class="text-right">
                  <div class="flex items-baseline justify-end gap-1.5">
                    <span class="text-sm font-black num-cell text-[color:var(--text-276b38)]">${fmtTokens(w.totalTokens)}</span>
                    <span class="text-xs font-bold text-[color:var(--text-9e6c18)] num-cell">${weekCostStr}</span>
                  </div>
                  <span class="text-[10px] text-[color:var(--text-7a7367)]">(${w.activeDays}天活跃 · 日均 ${fmtTokens(avg)} · ${avgCostStr}/天)</span>
                </div>
                <svg id="week-icon-${safeKey}" class="w-4 h-4 text-[color:var(--text-8a8172)] transition-transform duration-200 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>
              </div>
            </div>

            <div class="w-full bg-[var(--bg-eae3d5)] h-2 rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all duration-500 bg-[var(--bg-3c804f)]" style="width: ${pct}%;"></div>
            </div>

            <div class="flex items-center justify-between text-[11px] text-[color:var(--text-7a7367)] pt-0.5">
              <span>精确总计: <b class="text-[color:var(--text-276b38)] num-cell">${Number(w.totalTokens).toLocaleString()}</b> <span class="text-[color:var(--text-9e6c18)] font-bold ml-1">(${weekCostStr})</span></span>
              <span>交互频次: <b class="text-[color:var(--text-1e1d1a)] num-cell">${w.totalReqs.toLocaleString()}</b> 次</span>
            </div>

            <!-- 平级内嵌手风琴明细表 (当前页直接看，绝不跳页) -->
            <div id="week-details-${safeKey}" onclick="event.stopPropagation()" class="hidden pt-2.5 border-t border-[color:var(--border-eae3d5)] space-y-2">
              <div class="flex items-center justify-between text-[11px] font-bold text-[color:var(--text-5a5348)] px-1">
                <span>该周活跃流水清单 (${w.days.length}天 · 合计 ${weekCostStr})</span>
                <span class="text-[10px] text-[color:var(--text-8a8172)]">再次点击卡片可收起</span>
              </div>
              <div class="rounded-xl overflow-hidden border border-[color:var(--border-e2d9c8)] bg-[var(--bg-fdfcf9)]">
                <table class="w-full text-xs text-left">
                  <thead class="bg-[var(--bg-f4efe6)] text-[color:var(--text-7a7265)] text-[11px] font-semibold border-b border-[color:var(--border-e2d9c8)]">
                    <tr>
                      <th class="py-1.5 px-3.5">日期</th>
                      <th class="py-1.5 px-3.5 text-[color:var(--text-276b38)]">Token 消耗</th>
                      <th class="py-1.5 px-3.5 text-[color:var(--text-9e6c18)]">参考估值</th>
                      <th class="py-1.5 px-3.5">会话请求</th>
                    </tr>
                  </thead>
                  <tbody class="flow-rows">
                    ${daysTableRows}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    // 3. 渲染按月汇总 (整卡点击展开，顶部指标联动，无黑框，柔和宣纸边框)
    function renderMonthlyFlow() {
      const container = document.getElementById('month-cards-container');
      if (!container || !allRecords) return;

      const monthGroups = {};
      let grandTotal = 0;
      let grandCostUsd = 0;
      let grandCostRmb = 0;

      allRecords.forEach(r => {
        const mKey = r.date.substring(0, 7);
        if (!monthGroups[mKey]) {
          monthGroups[mKey] = {
            month: mKey,
            totalTokens: 0,
            totalCostUsd: 0,
            totalCostRmb: 0,
            totalReqs: 0,
            activeDays: 0,
            days: []
          };
        }
        monthGroups[mKey].totalTokens += r.tokens;
        monthGroups[mKey].totalCostUsd += (r.costUsd || 0);
        monthGroups[mKey].totalCostRmb += (r.costRmb || 0);
        monthGroups[mKey].totalReqs += r.requests;
        monthGroups[mKey].activeDays++;
        monthGroups[mKey].days.push(r);
        grandTotal += r.tokens;
        grandCostUsd += (r.costUsd || 0);
        grandCostRmb += (r.costRmb || 0);
      });

      const sortedMonths = Object.values(monthGroups).sort((a, b) => b.month.localeCompare(a.month));

      monthGroupsCache = {};
      sortedMonths.forEach(m => {
        const safeKey = m.month.replace(/[^a-zA-Z0-9]/g, '_');
        monthGroupsCache[safeKey] = m;
      });

      container.innerHTML = sortedMonths.map((m, idx) => {
        const pct = grandTotal > 0 ? Math.round((m.totalTokens / grandTotal) * 1000) / 10 : 0;
        const avg = Math.round(m.totalTokens / m.activeDays);
        const parts = m.month.split('-');
        const isCurMonth = m.month === getLocalTodayStr().slice(0, 7);
        const safeKey = m.month.replace(/[^a-zA-Z0-9]/g, '_');
        const sortedDays = [...m.days].sort((a, b) => b.date.localeCompare(a.date));
        const monthCostStr = fmtReferenceCost(m.totalCostUsd, m.totalCostRmb, hasUnpriced(m.days));
        const avgCostStr = fmtReferenceCost(m.totalCostUsd / m.activeDays, m.totalCostRmb / m.activeDays, hasUnpriced(m.days));

        const todayStr = getLocalTodayStr();
        const daysTableRows = sortedDays.map(d => `
          <tr class="hover:bg-[var(--bg-faf8f2)] transition-colors">
            <td class="py-2 px-3.5 font-semibold text-[color:var(--text-22201d)]">
              ${escapeHtml(d.date)}${d.date === todayStr ? ' <span class="text-[10px] tone-bg-8c3f2b-10 text-[color:var(--text-8c3f2b)] font-bold px-1.5 py-0.5 rounded ml-1">今日</span>' : ''}
            </td>
            <td class="py-2 px-3.5 font-bold num-cell ${d.date === todayStr ? 'text-[color:var(--text-8c3f2b)]' : 'text-[color:var(--text-276b38)]'}">
              ${escapeHtml(d.formatted || fmtTokens(d.tokens))}
              <span class="text-[10px] text-[color:var(--text-8a8172)] font-normal block leading-none pt-0.5">${Number(d.tokens).toLocaleString()}</span>
            </td>
            <td class="py-2 px-3.5 font-semibold num-cell">
              <span class="text-[10.5px] font-bold text-[color:var(--text-9e6c18)] tone-bg-d4a338-15 border tone-border-d4a338-30 px-1.5 py-0.5 rounded">${escapeHtml(d.costFormatted || fmtCost(d.costUsd || 0, d.costRmb || 0))}</span>
            </td>
            <td class="py-2 px-3.5 text-[color:var(--text-7a7265)] num-cell">${d.requests} 次</td>
          </tr>
        `).join('');

        return `
          <div id="month-card-${safeKey}"
               onclick="toggleMonthCard('${safeKey}')"
               onmouseenter="previewMonthCard('${safeKey}')"
               onmouseleave="unpreviewMonthCard('${safeKey}')"
               class="paper-card p-5 space-y-3.5 gentle-bounce border border-[color:var(--border-ddd3c2)] hover:border-[color:var(--border-bfaf98)] hover:shadow-xs cursor-pointer transition-all">
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2.5">
                <span class="w-2.5 h-2.5 rounded-full ${isCurMonth ? 'bg-[var(--bg-8c3f2b)] animate-pulse' : 'bg-[var(--bg-3c804f)]'}"></span>
                <h4 class="text-sm font-black text-[color:var(--text-1e1d1a)]">${parts[0]}年 ${parts[1]}月</h4>
                ${isCurMonth ? '<span class="text-[10px] tone-bg-3c804f-10 text-[color:var(--text-3c804f)] border tone-border-3c804f-25 px-2 py-0.5 rounded-full font-bold">当前月份</span>' : ''}
              </div>
              <div class="flex items-center space-x-3">
                <div class="text-right">
                  <div class="flex items-baseline justify-end gap-1.5">
                    <span class="text-base font-black num-cell text-[color:var(--text-276b38)]">${fmtTokens(m.totalTokens)}</span>
                    <span class="text-xs font-bold text-[color:var(--text-9e6c18)] num-cell">${monthCostStr}</span>
                  </div>
                  <span class="text-xs text-[color:var(--text-8a8172)]">占全周期 ${pct}%</span>
                </div>
                <svg id="month-icon-${safeKey}" class="w-4 h-4 text-[color:var(--text-8a8172)] transition-transform duration-200 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                </svg>
              </div>
            </div>

            <div class="w-full bg-[var(--bg-eae3d5)] h-2.5 rounded-full overflow-hidden">
              <div class="h-full rounded-full transition-all duration-500 bg-[var(--bg-1e1d1a)]" style="width: ${pct}%;"></div>
            </div>

            <div class="grid grid-cols-4 gap-3 text-xs bg-[var(--bg-faf8f3)] p-3 rounded-xl border border-[color:var(--border-ebe3d3)]">
              <div>
                <span class="text-[10px] text-[color:var(--text-8a8172)] block font-medium">当月活跃天数</span>
                <b class="text-[color:var(--text-1e1d1a)] font-bold num-cell">${m.activeDays} 天</b>
              </div>
              <div>
                <span class="text-[10px] text-[color:var(--text-8a8172)] block font-medium">当月累计 Tokens</span>
                <div class="flex items-baseline gap-1">
                  <b class="text-[color:var(--text-276b38)] font-bold num-cell">${fmtTokens(m.totalTokens)}</b>
                  <span class="text-[10px] font-bold text-[color:var(--text-9e6c18)]">(${monthCostStr})</span>
                </div>
              </div>
              <div>
                <span class="text-[10px] text-[color:var(--text-8a8172)] block font-medium">当月日均消耗</span>
                <div class="flex items-baseline gap-1">
                  <b class="text-[color:var(--text-276b38)] font-bold num-cell">${fmtTokens(avg)}</b>
                  <span class="text-[9.5px] text-[color:var(--text-9e6c18)] font-semibold">(${avgCostStr})</span>
                </div>
              </div>
              <div>
                <span class="text-[10px] text-[color:var(--text-8a8172)] block font-medium">当月交互频次</span>
                <b class="text-[color:var(--text-1e1d1a)] font-bold num-cell">${m.totalReqs.toLocaleString()} 次</b>
              </div>
            </div>

            <!-- 平级内嵌手风琴明细表 (当前页直接看，绝不跳页) -->
            <div id="month-details-${safeKey}" onclick="event.stopPropagation()" class="hidden pt-3 border-t border-[color:var(--border-eae3d5)] space-y-2">
              <div class="flex items-center justify-between text-xs font-bold text-[color:var(--text-5a5348)] px-1">
                <span>${parts[0]}年${parts[1]}月 逐日明细清单 (共 ${m.days.length} 天 · 合计 ${monthCostStr})</span>
                <span class="text-[11px] text-[color:var(--text-8a8172)]">再次点击卡片可收起</span>
              </div>
              <div class="rounded-xl overflow-hidden border border-[color:var(--border-e2d9c8)] bg-[var(--bg-fdfcf9)]">
                <table class="w-full text-xs text-left">
                  <thead class="bg-[var(--bg-f4efe6)] text-[color:var(--text-7a7265)] text-[11px] font-semibold border-b border-[color:var(--border-e2d9c8)]">
                    <tr>
                      <th class="py-2 px-3.5">日期</th>
                      <th class="py-2 px-3.5 text-[color:var(--text-276b38)]">Token 消耗</th>
                      <th class="py-2 px-3.5 text-[color:var(--text-9e6c18)]">参考估值</th>
                      <th class="py-2 px-3.5">会话请求</th>
                    </tr>
                  </thead>
                  <tbody class="flow-rows">
                    ${daysTableRows}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }


    // 账号切换
    function selectAccount(id, email) {
      if (isSwitchingAccount) return;
      isSwitchingAccount = true;

      showToast(`准备切换至: ${email}，客户端将自动重启；如有任务提醒，请先确认。`, true);

      // Visual feedback: show loading state on the button
      document.querySelectorAll('.account-switch-btn').forEach(btn => {
        if (btn.dataset.id === id) {
          btn.innerHTML = `
            <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>切换中...</span>
          `;
          btn.classList.add('opacity-90', 'pointer-events-none');
        } else {
          btn.classList.add('opacity-50', 'pointer-events-none');
        }
      });

      // A native task-confirmation dialog may remain open indefinitely. Only the backend's
      // final result releases this operation; a UI timer cannot cancel a committed switch.
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          action: 'switchAccount',
          accountId: id
        });
      } else {
        setTimeout(() => {
          isSwitchingAccount = false;
          showToast('浏览器预览不执行真实切号或重启，请在桌面客户端操作。', false);
          renderFullAccountsList(currentAccountsList);
        }, 500);
      }
    }

    // 导入模态窗口控制
    let currentAuthUrl = '';

    function openImportModal() {
      const m = document.getElementById('import-modal');
      if (m) m.classList.remove('hidden');
      switchImportTab('oauth');
      resetOAuthModalState();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: true });
        window.chrome.webview.postMessage({ action: 'getAntigravityClientStatus' });
      }
    }

    function closeImportModal() {
      const m = document.getElementById('import-modal');
      if (m) m.classList.add('hidden');
      cancelGoogleOAuth();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: false });
      }
    }

    function switchImportTab(tab) {
      ['oauth', 'client', 'json'].forEach(t => {
        const btn = document.getElementById('tab-btn-' + t);
        const content = document.getElementById('tab-content-' + t);
        if (!btn || !content) return;
        if (t === tab) {
          btn.className = 'py-2 rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer bg-white text-[color:var(--text-1e1d1a)] shadow-xs font-bold';
          content.classList.remove('hidden');
        } else {
          btn.className = 'py-2 rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer hover:text-[color:var(--text-1e1d1a)] text-[color:var(--text-665e4f)]';
          content.classList.add('hidden');
        }
      });
      if (tab === 'client') {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ action: 'getAntigravityClientStatus' });
        }
      }
    }

    function resetOAuthModalState() {
      const idle = document.getElementById('oauth-idle-state');
      const loading = document.getElementById('oauth-loading-state');
      if (idle) idle.classList.remove('hidden');
      if (loading) loading.classList.add('hidden');
      currentAuthUrl = '';
      const input = document.getElementById('manual-oauth-code');
      if (input) input.value = '';
    }

    function startGoogleOAuth() {
      const idle = document.getElementById('oauth-idle-state');
      const loading = document.getElementById('oauth-loading-state');
      if (idle) idle.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');

      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'startGoogleOAuth' });
      } else {
        currentAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=...';
      }
    }

    function cancelGoogleOAuth() {
      resetOAuthModalState();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'cancelGoogleOAuth' });
      }
    }

    function copyCurrentAuthUrl() {
      if (currentAuthUrl) {
        navigator.clipboard.writeText(currentAuthUrl).then(() => {
          showToast('已复制 Google 官方授权链接', true);
        }).catch(() => {
          showToast('复制失败，请手动选取输入', false);
        });
      } else {
        showToast('暂无有效授权链接', false);
      }
    }

    function submitManualOAuthCode() {
      const input = document.getElementById('manual-oauth-code');
      const code = input ? input.value.trim() : '';
      if (!code) {
        showToast('请粘贴链接或授权 Code', false);
        return;
      }
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'submitManualAuthCode', code: code });
      }
    }

    function importFromCurrentLogin() {
      closeImportModal();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'importCurrentAccount' });
      } else {
        showToast("已识别并成功导入当前系统账号", true);
      }
    }

    function renderClientStatus(data) {
      const ready = !!data.credsFound;
      const textEl = document.getElementById('client-status-text');
      const badgeEl = document.getElementById('client-status-badge');
      const dotEl = document.getElementById('client-status-dot');
      if (textEl) textEl.innerText = data.statusText || (data.isRunning ? `Antigravity 客户端运行中 (PID: ${data.pid})` : '未检测到运行中的 Antigravity 客户端');
      if (badgeEl) {
        badgeEl.innerText = ready ? '可导入' : '未找到凭据';
        badgeEl.className = ready ? 'text-[10px] font-semibold text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded' : 'text-[10px] font-semibold text-amber-700 bg-amber-100/60 px-2 py-0.5 rounded';
      }
      if (dotEl) dotEl.className = ready ? 'w-2.5 h-2.5 rounded-full bg-emerald-500' : 'w-2.5 h-2.5 rounded-full bg-amber-500';
    }

    function importFromJsonFile() {
      closeImportModal();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'importAccountFile' });
      } else {
        showToast("已从文件载入账号凭据", true);
      }
    }

    // 删除账号逻辑
    function confirmDeleteAccount(id, email) {
      pendingDeleteId = id;
      const emailEl = document.getElementById('delete-target-email');
      if (emailEl) emailEl.innerText = email;
      const m = document.getElementById('delete-modal');
      if (m) m.classList.remove('hidden');
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: true });
      }
    }

    function closeDeleteModal() {
      pendingDeleteId = '';
      const m = document.getElementById('delete-modal');
      if (m) m.classList.add('hidden');
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'modalStateChanged', isOpen: false });
      }
    }

    // 全局快捷键：按 Escape 键退出导入或确认模态窗
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const importModal = document.getElementById('import-modal');
        const deleteModal = document.getElementById('delete-modal');
        if (importModal && !importModal.classList.contains('hidden')) {
          closeImportModal();
        }
        if (deleteModal && !deleteModal.classList.contains('hidden')) {
          closeDeleteModal();
        }
      }
    });

    function executeDeleteAccount() {
      if (!pendingDeleteId) return;
      const idToDelete = pendingDeleteId;
      closeDeleteModal();
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'deleteAccount', accountId: idToDelete });
      } else {
        showToast("账号已成功从列表中删除", true);
      }
    }

    function updateTrayToggleUI() {
      const toggleBtn = document.getElementById('toggle-tray');
      const thumb = document.getElementById('toggle-tray-thumb');
      const desc = document.getElementById('tray-status-desc');
      if (!toggleBtn || !thumb) return;
      if (closeToTray) {
        toggleBtn.classList.remove('bg-[var(--bg-d1c7b5)]');
        toggleBtn.classList.add('bg-[var(--bg-1e1d1a)]');
        thumb.classList.remove('translate-x-0');
        thumb.classList.add('translate-x-4');
        if (desc) desc.innerText = '保持后台运行与快捷切号';
      } else {
        toggleBtn.classList.remove('bg-[var(--bg-1e1d1a)]');
        toggleBtn.classList.add('bg-[var(--bg-d1c7b5)]');
        thumb.classList.remove('translate-x-4');
        thumb.classList.add('translate-x-0');
        if (desc) desc.innerText = '点击关闭直接退出程序';
      }
    }

    function toggleCloseToTray() {
      closeToTray = !closeToTray;
      updateTrayToggleUI();
      try {
        localStorage.setItem('antigravity_close_to_tray', closeToTray ? '1' : '0');
      } catch (e) {}
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'setCloseToTray', closeToTray: closeToTray });
      }
      showToast(closeToTray ? "已开启：关闭窗口后保持托盘常驻" : "已开启：关闭窗口将直接彻底退出", true);
    }

    // 吐司通知提示 (温润纸质微卡片，告别粗暴黑底与 Emoji)
    function showToast(message, isSuccess = true) {
      const toast = document.createElement('div');
      toast.className = `fixed bottom-6 right-6 bg-white/95 border border-[color:var(--border-ddd3c2)] text-[color:var(--text-1e1d1a)] px-3.5 py-2 rounded-xl shadow-lg text-xs font-semibold flex items-center gap-2 page-slide-in z-50 backdrop-blur-sm`;
      toast.innerHTML = `<span class="w-2 h-2 rounded-full ${isSuccess ? 'bg-[var(--bg-2e6b3c)]' : 'bg-[var(--bg-8c3f2b)]'} shrink-0"></span><span>${escapeHtml(message)}</span>`;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(6px)';
        toast.style.transition = 'all 0.22s var(--fluid-slide)';
        setTimeout(() => toast.remove(), 240);
      }, 2200);
    }

    // ================= 刷新动效与反馈闭环 (原生轻量化微交互) =================
    let activeRefreshId = null;
    let refreshStartTime = 0;
    let refreshTimer = null;
    let refreshWatchdog = null;

    function refreshData() {
      if (isRefreshing) return;
      isRefreshing = true;
      refreshStartTime = Date.now();
      activeRefreshId = `${refreshStartTime}-${Math.random().toString(16).slice(2)}`;
      const requestId = activeRefreshId;

      const icon = document.getElementById('refresh-icon');
      const label = document.getElementById('refresh-label');
      const btn = document.getElementById('btn-refresh');

      if (btn) {
        btn.classList.remove('bg-[var(--bg-eaf3ec)]', 'text-[color:var(--text-246b35)]', 'border-[color:var(--border-c6e2cc)]', 'scale-105');
        btn.classList.add('scale-95', 'opacity-90', 'border-[color:var(--border-bfa882)]');
      }
      if (icon) {
        icon.classList.add('animate-spin');
      }
      if (label) {
        label.innerText = '正在同步...';
      }

      // Safety watchdog: reset after 8s if backend fails to respond
      if (refreshWatchdog) clearTimeout(refreshWatchdog);
      refreshWatchdog = setTimeout(() => {
        if (isRefreshing) {
          onRefreshFinished({ success: false, message: "刷新超时，保留当前数据显示。", requestId });
        }
      }, 60000);

      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({ action: 'refresh', requestId });
      } else {
        setTimeout(() => onRefreshFinished({ success: false, message: "当前页面未连接桌面宿主。", requestId }), 400);
      }
    }

    function onRefreshFinished(result = {}) {
      if (!isRefreshing || result.requestId !== activeRefreshId) return;
      const success = result.success === true;
      activeRefreshId = null;
      if (!success && result.message) showToast(result.message, false);
      if (refreshWatchdog) {
        clearTimeout(refreshWatchdog);
        refreshWatchdog = null;
      }
      const elapsed = Date.now() - refreshStartTime;
      const minSpinTime = 700; // 保证至少优雅旋转一整圈，杜绝瞬间直变
      const delay = Math.max(0, minSpinTime - elapsed);

      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const icon = document.getElementById('refresh-icon');
        const label = document.getElementById('refresh-label');
        const btn = document.getElementById('btn-refresh');

        if (icon) {
          icon.classList.remove('animate-spin');
        }
        if (btn) {
          btn.classList.remove('scale-95', 'opacity-90', 'border-[color:var(--border-bfa882)]');
          if (success) btn.classList.add('bg-[var(--bg-eaf3ec)]', 'text-[color:var(--text-246b35)]', 'border-[color:var(--border-c6e2cc)]', 'scale-105');
          setTimeout(() => { if (btn) btn.classList.remove('scale-105'); }, 200);
        }
        if (label) {
          label.innerText = success ? '已同步 ✓' : '未完成';
        }

        // 保持成功态 1.4 秒后优雅平滑复原
        setTimeout(() => {
          if (btn) {
            btn.classList.remove('bg-[var(--bg-eaf3ec)]', 'text-[color:var(--text-246b35)]', 'border-[color:var(--border-c6e2cc)]');
          }
          if (label) {
            label.innerText = '刷新';
          }
          isRefreshing = false;
        }, 1400);
      }, delay);
    }

    const CACHE_KEY = 'antigravity_hub_cache_v3';

    function rehydrateFromCache() {
      try {
        const cachedStr = localStorage.getItem(CACHE_KEY);
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && (cached.stats || cached.accounts)) {
            renderHubData(cached, true);
            return true;
          }
        }
      } catch (e) {
        console.warn('[Hub] Cache rehydration error:', e);
      }
      return false;
    }

    // 全量数据渲染总入口
    function renderHubData(data, fromCache = false) {
      if (!data) return;

      if (!fromCache) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        } catch (e) {}
      }

      const accounts = data.accounts || [];
      const currentAccount = data.currentAccount;
      const stats = data.stats;

      if (data.settings) {
        appSettings = Object.assign({}, appSettings, data.settings);
        const rateVal = document.getElementById('modal-rate-val');
        if (rateVal && appSettings.liveUsdToCnyRate) {
          rateVal.innerText = Number(appSettings.liveUsdToCnyRate).toFixed(2);
        }
      }

      const nameEl = document.getElementById('sidebar-name');
      if (nameEl) nameEl.innerText = currentAccount ? (currentAccount.name || currentAccount.displayName || (currentAccount.email || '').split('@')[0]) : '未选择账号';
      const avatarEl = document.getElementById('sidebar-avatar');
      if (avatarEl) avatarEl.onerror = () => { avatarEl.onerror = null; avatarEl.src = './avatar.svg'; };
      if (avatarEl) avatarEl.src = safeAvatarUrl(currentAccount && (currentAccount.avatarDataUrl || currentAccount.avatarUrl));
      const contextLabel = document.getElementById('sidebar-account-context');
      if (contextLabel) contextLabel.innerText = currentAccount && currentAccount.ideRestartPending ? '凭据已更新 · 待重启 IDE' : '当前账号';
      const tierEl = document.getElementById('sidebar-tier');
      if (tierEl) {
        const tierInfo = formatSubscriptionTier(currentAccount && currentAccount.tier);
        if (tierInfo.label) {
          tierEl.innerText = tierInfo.label;
          tierEl.className = `px-2 py-0.5 rounded-md text-[9.5px] tracking-wider shrink-0 ${tierInfo.className}`;
          tierEl.style.display = '';
        } else {
          tierEl.style.display = 'none';
        }
      }

      // 账号总数角标
      const accCountBadge = document.getElementById('sidebar-accounts-count');
      if (accCountBadge) accCountBadge.innerText = accounts.length;

      // 2. Token 统计数据
      if (stats) {
        window.currentStats = stats;
        allRecords = stats.dailyRecords || [];

        const elTodayVal = document.getElementById('stat-today-val');
        if (elTodayVal && stats.todayFormatted) elTodayVal.innerText = stats.todayFormatted;
        const elTodayCost = document.getElementById('stat-today-cost');
        if (elTodayCost && stats.todayCostFormatted) elTodayCost.innerText = stats.todayCostFormatted;
        const elTodayReqs = document.getElementById('stat-today-reqs');
        if (elTodayReqs && stats.todayRequests !== undefined) elTodayReqs.innerText = `${stats.todayRequests} 次会话`;

        // Today breakdown bar & percent
        const barCache = document.getElementById('today-bar-cache');
        const barIn = document.getElementById('today-bar-in');
        const barOut = document.getElementById('today-bar-out');
        const statCachePct = document.getElementById('stat-today-cache-pct');
        if (stats.todayTokens > 0) {
          const percent = value => Math.min(100, Math.max(0, (Number(value) || 0) / stats.todayTokens * 100));
          const cPct = percent((stats.todayCachedTokens || 0) + (stats.todayCacheWriteTokens || 0));
          const inPct = percent(stats.todayInputTokens);
          const outPct = percent((stats.todayOutputTokens || 0) + (stats.todayReasoningTokens || 0));
          if (barCache) barCache.style.width = `${cPct}%`;
          if (barIn) barIn.style.width = `${inPct}%`;
          if (barOut) barOut.style.width = `${outPct}%`;
          if (statCachePct) statCachePct.innerText = `缓存读取 ${Math.round(percent(stats.todayCachedTokens) * 10) / 10}%`;
          if (barCache) barCache.title = `缓存读取 ${stats.todayCachedFormatted || '0'} / 缓存写入 ${stats.todayCacheWriteFormatted || '0'}`;
        } else {
          [barCache, barIn, barOut].forEach(bar => { if (bar) bar.style.width = '0%'; });
          if (statCachePct) statCachePct.innerText = `缓存读取 0%`;
        }

        const el7dVal = document.getElementById('stat-7d-val');
        if (el7dVal && stats.sevenDaysFormatted) el7dVal.innerText = stats.sevenDaysFormatted;
        const el7dCost = document.getElementById('stat-7d-cost');
        if (el7dCost && stats.sevenDaysCostFormatted) el7dCost.innerText = stats.sevenDaysCostFormatted;
        const el7dExact = document.getElementById('stat-7d-exact');
        if (el7dExact && stats.sevenDaysTokens !== undefined) el7dExact.innerText = `${Number(stats.sevenDaysTokens).toLocaleString()} tokens`;

        const el30dVal = document.getElementById('stat-30d-val');
        if (el30dVal && stats.thirtyDaysFormatted) el30dVal.innerText = stats.thirtyDaysFormatted;
        const el30dCost = document.getElementById('stat-30d-cost');
        if (el30dCost && stats.thirtyDaysCostFormatted) el30dCost.innerText = stats.thirtyDaysCostFormatted;
        const el30dExact = document.getElementById('stat-30d-exact');
        if (el30dExact && stats.thirtyDaysTokens !== undefined) el30dExact.innerText = `${Number(stats.thirtyDaysTokens).toLocaleString()} tokens`;

        const elTotVal = document.getElementById('stat-total-val');
        if (elTotVal && stats.totalFormatted) elTotVal.innerText = stats.totalFormatted;
        const elTotCost = document.getElementById('stat-total-cost');
        if (elTotCost && stats.totalCostFormatted) elTotCost.innerText = stats.totalCostFormatted;
        const elTotExact = document.getElementById('stat-total-exact');
        if (elTotExact && stats.totalTokens !== undefined) elTotExact.innerText = `${Number(stats.totalTokens).toLocaleString()} tokens`;

        // Hero 卡片
        const heroToday = document.getElementById('hero-today-exact');
        if (heroToday && stats.todayTokens !== undefined) heroToday.innerText = Number(stats.todayTokens).toLocaleString();
        const heroCostBadge = document.getElementById('hero-cost-badge');
        if (heroCostBadge && stats.todayCostFormatted) heroCostBadge.innerText = stats.todayCostFormatted;
        const heroSub = document.getElementById('hero-subtext');
        if (heroSub) {
          heroSub.innerText = `Tokens · 包含上下文与思考`;
        }

        // Hero 3 个构成明细 Chips
        const chipIn = document.getElementById('hero-chip-in');
        const chipCache = document.getElementById('hero-chip-cache');
        const chipOut = document.getElementById('hero-chip-out');
        if (chipIn && stats.todayInputFormatted) {
          const inPct = stats.todayTokens > 0 ? Math.round(((stats.todayInputTokens || 0) / stats.todayTokens) * 1000) / 10 : 0;
          chipIn.innerHTML = `纯新输入 <b>${escapeHtml(stats.todayInputFormatted || '0')}</b> (${inPct}%)`;
        }
        if (chipCache && stats.todayCachedFormatted) {
          const cPct = stats.todayCachePercent || (stats.todayTokens > 0 ? Math.round(((stats.todayCachedTokens || 0) / stats.todayTokens) * 1000) / 10 : 0);
          chipCache.innerHTML = `缓存命中 <b>${escapeHtml(stats.todayCachedFormatted || '0')}</b> (${cPct}%)`;
        }
        if (chipOut && (stats.todayOutputFormatted || stats.todayReasoningFormatted)) {
          const outSum = (stats.todayOutputTokens || 0) + (stats.todayReasoningTokens || 0);
          const outPct = stats.todayTokens > 0 ? Math.round((outSum / stats.todayTokens) * 1000) / 10 : 0;
          chipOut.innerHTML = `生成与思考 <b>${fmtTokens(outSum)}</b> (${outPct}%)`;
        }

        // 主力模型名称与占比
        if (stats.models && stats.models.length > 0) {
          const topM = stats.models[0];
          const topMName = document.getElementById('hero-top-model-name');
          if (topMName) topMName.innerText = topM.name;
          const topMPct = document.getElementById('hero-top-model-pct');
          if (topMPct) topMPct.innerText = `占比 ${topM.percentage}%`;
        }

        // 模型用量分布 (与当前日历/热力图模式动态联动)
        if (currentHeatMode === 'month') {
          renderMonthCalendar();
        } else if (selectedCalDate) {
          renderModelDistribution('day', selectedCalDate, `${selectedCalDate} 单日`);
        } else {
          renderModelDistribution('all', null, '全量累计');
        }

        // 年度活跃热力图 (全宽自适应拉伸 + 微型高集成矩阵 + 完整悬浮浮窗)
        if (Array.isArray(stats.heatmap)) {
          const heatContainer = document.getElementById('heatmap-grid-year');
          if (heatContainer) {
            heatContainer.innerHTML = '';
            const days = stats.heatmap;
            const yearThresholds = usageThresholds(days.map(day => day.tokens));
            const firstDay = days.length ? new Date(days[0].date + 'T12:00:00') : null;
            const padding = firstDay && !Number.isNaN(firstDay.getTime()) ? (firstDay.getDay() + 6) % 7 : 0;
            const cells = [...Array(padding).fill(null), ...days];
            const monthAxis = document.getElementById('year-month-axis');
            if (monthAxis) {
              monthAxis.innerHTML = '';
              let lastMonth = '';
              days.forEach((day, index) => {
                const month = String(day.date).slice(0, 7);
                if (month === lastMonth) return;
                lastMonth = month;
                if (index === 0 && days.slice(0, 21).some(item => String(item.date).slice(0, 7) !== month)) return;
                const label = document.createElement('span');
                label.style.position = 'absolute';
                label.style.left = `${100 * Math.floor((index + padding) / 7) / Math.max(1, Math.ceil(cells.length / 7))}%`;
                label.innerText = `${Number(month.slice(5))}月`;
                monthAxis.appendChild(label);
              });
            }
            const heatRecMap = {};
            (stats.dailyRecords || []).forEach(r => { heatRecMap[r.date] = r; });

            for (let i = 0; i < cells.length; i += 7) {
              const col = document.createElement('div');
              col.className = 'flex flex-col gap-1 items-center flex-1';
              for (let j = 0; j < 7 && (i + j) < cells.length; j++) {
                const item = cells[i + j];
                const dot = document.createElement('div');
                if (!item) { dot.className = 'w-full aspect-square max-w-[11px] max-h-[11px]'; col.appendChild(dot); continue; }
                dot.className = `w-full aspect-square max-w-[11px] max-h-[11px] rounded-[2px] transition-transform hover:scale-135 heat-l-${usageLevel(item.tokens, yearThresholds)} cursor-pointer heat-dot`;
                dot.title = `${item.date}: ${Number(item.tokens).toLocaleString()} tokens`;
                const rec = heatRecMap[item.date];
                const hReqs = rec ? rec.requests : 0;
                const hCost = rec ? (rec.costFormatted || fmtCost(rec.costUsd || 0, rec.costRmb || 0)) : (item.tokens > 0 ? fmtCost(0, 0) : '¥0.00');
                dot.dataset.date = item.date;
                dot.dataset.tokens = item.tokens;
                dot.dataset.reqs = hReqs;
                dot.dataset.cost = hCost;
                col.appendChild(dot);
              }
              heatContainer.appendChild(col);
            }

            heatContainer.onmouseover = (e) => {
              const dot = e.target.closest('.heat-dot');
              if (dot && dot.dataset.date) {
                showTooltip(e, dot.dataset.date, Number(dot.dataset.tokens), Number(dot.dataset.reqs), false, dot.dataset.cost);
              }
            };
            heatContainer.onmouseout = (e) => {
              const related = e.relatedTarget;
              if (!related || !heatContainer.contains(related)) {
                hideTooltip();
              }
            };
            heatContainer.onclick = (e) => {
              const dot = e.target.closest('.heat-dot');
              if (dot && dot.dataset.date) {
                const d = dot.dataset.date;
                if (selectedCalDate === d) {
                  selectedCalDate = null;
                  renderModelDistribution('all', null, '全量累计');
                } else {
                  selectedCalDate = d;
                  renderModelDistribution('day', d, `${d} 单日`);
                }
              }
            };
          }

          // 刷新年度热力图遥测指标
          const yDays = document.getElementById('year-stat-days');
          const yTokens = document.getElementById('year-stat-tokens');
          const yAvg = document.getElementById('year-stat-avg');
          const yStreak = document.getElementById('year-stat-streak');
          const activeDays = stats.heatmap.filter(day => Number(day.tokens) > 0);
          const periodTokens = activeDays.reduce((sum, day) => sum + Number(day.tokens), 0);
          if (yDays) yDays.innerText = `${activeDays.length} 天`;
          if (yTokens) yTokens.innerText = fmtTokens(periodTokens);
          if (yAvg) yAvg.innerText = fmtTokens(activeDays.length ? Math.round(periodTokens / activeDays.length) : 0);
          if (yStreak) yStreak.innerText = `${getCurrentStreak(stats.dailyRecords || [])} 天连击`;

        }

        // 每日流水明细与统计摘要
        {
          const sideBadge = document.getElementById('sidebar-daily-badge');
          if (sideBadge) sideBadge.innerText = `${allRecords.length}天`;

          renderMonthDropdownOptions();
          updateDefaultFlowSummary();

          if (currentFlowMode === 'day') renderDailyTable();
          else if (currentFlowMode === 'week') renderWeeklyFlow();
          else if (currentFlowMode === 'month') renderMonthlyFlow();
        }
      }

      // 3. 侧边栏专属切号卡列表 (暖玉金沙牛皮纸高阶质感 + 双行独立配额微仪表盘)
      window.currentHubAccount = currentAccount;
      currentAccountsList = accounts;

      const sidebarAccountsSection = document.getElementById('sidebar-accounts-section');
      const sidebarAccountsContainer = document.getElementById('sidebar-accounts-list');
      if (sidebarAccountsSection && sidebarAccountsContainer) {
        if (accounts && accounts.length > 0) {
          sidebarAccountsSection.classList.remove('hidden');
        } else {
          sidebarAccountsSection.classList.add('hidden');
          sidebarAccountsContainer.innerHTML = '';
        }
      }
      if (sidebarAccountsContainer && accounts.length > 0) {
        sidebarAccountsContainer.innerHTML = accounts.map(acc => {
          const isCur = currentAccount && (acc.id === currentAccount.id);
          const shortEmail = escapeHtml((acc.email || '').split('@')[0]);
          const safeId = escapeHtml(escapeJs(acc.id));
          const safeEmail = escapeHtml(escapeJs(acc.email));
          const safeAvatar = escapeHtml(safeAvatarUrl(acc.avatarDataUrl || acc.avatarUrl));
          const g5h = quotaValue(acc.gemini5hQuota);
          const gWeekly = quotaValue(acc.geminiWeeklyQuota);
          const r5h = escapeHtml(acc.resetTime5hDesc ? acc.resetTime5hDesc.replace('后重置', '后') : '');
          const rWeekly = escapeHtml(acc.resetTimeWeeklyDesc ? acc.resetTimeWeeklyDesc.replace('后重置', '后') : '');

          return `
            <div class="relative p-3 rounded-2xl transition-all duration-250 cursor-default select-none ${
              isCur 
                ? 'bg-gradient-to-br from-[var(--bg-dfc8a4)] to-[var(--bg-ceb289)] border-1.5 border-[color:var(--border-9c7d4e)] shadow-[0_4px_16px_-2px_rgba(70,45,15,0.22),inset_0_1px_0_rgba(255,255,255,0.65)]' 
                : 'bg-gradient-to-br from-[var(--bg-e5d7bf)] to-[var(--bg-d4bf9f)] hover:from-[var(--bg-dfceb2)] hover:to-[var(--bg-cdb692)] border border-[color:var(--border-baa484)] hover:border-[color:var(--border-9e8560)] shadow-[0_2px_10px_-2px_rgba(70,45,15,0.12),inset_0_1px_0_rgba(255,255,255,0.6)]'
            }">
              ${isCur ? '<div class="absolute left-0 top-3 bottom-3 w-1 bg-[var(--bg-1e6b37)] rounded-r-full shadow-xs"></div>' : ''}
              
              <!-- 顶部信息区：左侧头像 + 中间两行(用户名/PRO) + 右侧独立状态/按键 -->
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center space-x-2.5 min-w-0 flex-1">
                  <div class="relative w-8 h-8 rounded-full ring-2 ring-white/90 shadow-xs shrink-0 overflow-hidden bg-[var(--bg-ceba9e)]">
                    <img src="${safeAvatar}" 
                         class="w-full h-full object-cover" 
                         alt="账号头像" onerror="this.onerror=null;this.src='./avatar.svg'">
                    ${isCur ? '<span class="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-[var(--bg-1e6b37)] ring-1.5 ring-white"></span>' : ''}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="text-[12.5px] font-black text-[color:var(--text-201c17)] truncate tracking-tight leading-tight">${shortEmail}</div>
                    <div class="flex items-center mt-1">
                      ${(() => {
                        const t = formatSubscriptionTier(acc.tier);
                        return t.label ? `<span class="text-[8.5px] px-1.5 py-0.5 rounded leading-tight tracking-wider ${t.className}">${escapeHtml(t.label)}</span>` : '';
                      })()}
                    </div>
                  </div>
                </div>

                <div class="shrink-0">
                  ${
                    isCur 
                      ? `<span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl tone-bg-1e6b37-18 text-[color:var(--text-144a22)] border tone-border-1e6b37-40 text-[10.5px] font-black shadow-2xs">
                           <span class="relative flex h-2 w-2">
                             <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--bg-2e8b57)] opacity-75"></span>
                             <span class="relative inline-flex rounded-full h-2 w-2 bg-[var(--bg-1e6b37)]"></span>
                           </span>
                           <span>${acc.ideRestartPending ? '等待重启 IDE' : '正在使用'}</span>
                         </span>` 
                      : `<button data-id="${safeId}" onclick="event.stopPropagation(); selectAccount('${safeId}', '${safeEmail}')" 
                                 class="account-switch-btn group/btn relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-b from-[var(--bg-2b251f)] via-[var(--bg-201c17)] to-[var(--bg-161310)] hover:from-[var(--bg-3b332b)] hover:to-[var(--bg-221d17)] text-[color:var(--text-faf6ed)] font-black text-[11px] tracking-wide border tone-border-8c7248-70 hover:border-[color:var(--border-d4af37)] shadow-[0_2px_8px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.18)] hover:shadow-[0_4px_14px_rgba(50,35,15,0.35)] active:scale-95 transition-all duration-200 cursor-pointer">
                           <span class="w-1.5 h-1.5 rounded-full bg-[var(--bg-e2c376)] group-hover/btn:scale-125 transition-transform duration-200"></span>
                           <span>切换</span>
                           <svg class="w-3.5 h-3.5 text-[color:var(--text-e2c376)] group-hover/btn:rotate-180 group-hover/btn:text-[color:var(--text-ffdf78)] transition-all duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                             <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>
                           </svg>
                         </button>`
                  }
                </div>
              </div>

              <!-- 独立两行配额仪表盘：5h 与 周额度分行呈现，各自具备彩色状态标、倒计时芯片与进度条 -->
              <div class="mt-2.5 pt-2 border-t tone-border-baa688-60 space-y-2">
                <!-- 5h 滚动周期 -->
                <div class="space-y-1">
                  <div class="flex items-center justify-between text-[10.5px] leading-none">
                    <span class="text-[color:var(--text-685a46)] font-bold flex items-center gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full ${g5h != null && g5h <= 20 ? 'bg-[var(--bg-dc2626)]' : 'bg-[var(--bg-2563eb)]'}"></span>
                      5h 额度
                    </span>
                    <div class="flex items-center gap-1.5">
                      <span class="num-cell font-black text-[color:var(--text-1e1d1a)] text-[11px]">${quotaLabel(g5h)}</span>
                      ${r5h ? `<span class="text-[8.5px] font-bold text-[color:var(--text-8c3f2b)] tone-bg-8c3f2b-10 px-1.5 py-0.5 rounded border tone-border-8c3f2b-20 leading-none">${r5h}</span>` : ''}
                    </div>
                  </div>
                  <div class="w-full tone-bg-c6b497-70 h-1.5 rounded-full overflow-hidden p-0.5 flex items-center">
                    <div class="h-full ${g5h != null && g5h <= 20 ? 'bg-gradient-to-r from-[var(--bg-ef4444)] to-[var(--bg-dc2626)]' : 'bg-gradient-to-r from-[var(--bg-60a5fa)] to-[var(--bg-2563eb)]'} rounded-full transition-all duration-500 shadow-2xs" style="width: ${quotaWidth(g5h)}%"></div>
                  </div>
                </div>

                <!-- 周周期 -->
                <div class="space-y-1">
                  <div class="flex items-center justify-between text-[10.5px] leading-none">
                    <span class="text-[color:var(--text-685a46)] font-bold flex items-center gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full ${gWeekly != null && gWeekly <= 20 ? 'bg-[var(--bg-dc2626)]' : 'bg-[var(--bg-16a34a)]'}"></span>
                      周额度
                    </span>
                    <div class="flex items-center gap-1.5">
                      <span class="num-cell font-black text-[color:var(--text-1e1d1a)] text-[11px]">${quotaLabel(gWeekly)}</span>
                      ${rWeekly ? `<span class="text-[8.5px] font-bold text-[color:var(--text-1e6b37)] tone-bg-1e6b37-10 px-1.5 py-0.5 rounded border tone-border-1e6b37-20 leading-none">${rWeekly}</span>` : ''}
                    </div>
                  </div>
                  <div class="w-full tone-bg-c6b497-70 h-1.5 rounded-full overflow-hidden p-0.5 flex items-center">
                    <div class="h-full ${gWeekly != null && gWeekly <= 20 ? 'bg-gradient-to-r from-[var(--bg-ef4444)] to-[var(--bg-dc2626)]' : 'bg-gradient-to-r from-[var(--bg-4ade80)] to-[var(--bg-16a34a)]'} rounded-full transition-all duration-500 shadow-2xs" style="width: ${quotaWidth(gWeekly)}%"></div>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }

      // 4. 账号详情全量列表卡片 (尊享深色温润卡纸质感)
      renderFullAccountsList(accounts);
    }

    function renderFullAccountsList(accounts) {
      const fullList = document.getElementById('accounts-full-list');
      if (!fullList) return;

      const currentAccount = window.currentHubAccount;
      const list = accounts || currentAccountsList || [];

      if (list.length === 0) {
        fullList.innerHTML = `
          <div class="col-span-2 py-12 text-center text-xs text-[color:var(--text-8a8172)] bg-[var(--bg-faf8f2)] rounded-2xl border border-dashed border-[color:var(--border-ddd3c2)] space-y-2">
            <svg class="w-8 h-8 mx-auto text-[color:var(--text-a89f8f)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            <div>暂无已导入的 Google 账号</div>
          </div>
        `;
        return;
      }

      fullList.innerHTML = list.map(acc => {
        const isCur = currentAccount && (acc.id === currentAccount.id);
        const shortEmail = (acc.email || '').split('@')[0];
        const name = acc.name || acc.displayName || shortEmail;
        const safeId = escapeHtml(escapeJs(acc.id));
        const safeEmail = escapeHtml(escapeJs(acc.email));
        const safeDisplayName = escapeHtml(name);
        const safeEmailHtml = escapeHtml(acc.email);
        const safeAvatar = escapeHtml(safeAvatarUrl(acc.avatarDataUrl || acc.avatarUrl));
        const g5h = quotaValue(acc.gemini5hQuota);
        const gWeekly = quotaValue(acc.geminiWeeklyQuota);
        const c5h = quotaValue(acc.claude5hQuota);
        const cWeekly = quotaValue(acc.claudeWeeklyQuota);
        const r5hFmt = escapeHtml(acc.resetTime5hFormatted || '滚动重置');
        const r5hDesc = escapeHtml(acc.resetTime5hDesc || '');
        const rWeeklyFmt = escapeHtml(acc.resetTimeWeeklyFormatted || '周期刷新');
        const rWeeklyDesc = escapeHtml(acc.resetTimeWeeklyDesc || '');
        const cr5hFmt = escapeHtml(acc.claudeResetTime5hFormatted || '滚动重置');
        const cr5hDesc = escapeHtml(acc.claudeResetTime5hDesc || '');
        const crWeeklyFmt = escapeHtml(acc.claudeResetTimeWeeklyFormatted || '周期刷新');
        const crWeeklyDesc = escapeHtml(acc.claudeResetTimeWeeklyDesc || '');
        const lastSync = escapeHtml(quotaSyncLabel(acc));

        return `
          <div class="p-5 rounded-2xl space-y-4 gentle-bounce transition-all duration-300 relative ${
            isCur 
              ? 'border-2 border-[color:var(--border-9e855c)] bg-[var(--bg-eae0cd)] shadow-[0_8px_24px_rgba(45,35,20,0.08)]' 
              : 'border-2 border-[color:var(--border-d5c9b3)] bg-[var(--bg-efe7d7)] hover:bg-[var(--bg-eae0cd)] hover:border-[color:var(--border-bca98c)] shadow-2xs'
          }">
            <!-- 头部：单层高雅头像装裱 + PRO金色标识 + 纯净状态徽标 (彻底消除“就绪状态”四个字与重复生效标签) -->
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-3.5">
                <div class="relative">
                  <img src="${safeAvatar}" 
                       class="w-11 h-11 rounded-full border-1.5 border-[color:var(--border-bca98c)] shadow-xs object-cover" 
                       alt="账号头像" onerror="this.onerror=null;this.src='./avatar.svg'">
                  ${isCur ? '<span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[var(--bg-246337)] border-2 border-[color:var(--border-eae0cd)] shadow-xs"></span>' : ''}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-black text-[15px] text-[color:var(--text-1e1d1a)] tracking-tight">${safeDisplayName}</span>
                    ${(() => {
                      const t = formatSubscriptionTier(acc.tier);
                      return t.label ? `<span title="账号订阅档位" class="px-2 py-0.5 rounded-md text-[9.5px] tracking-wider ${t.className}">${escapeHtml(t.label)}</span>` : '';
                    })()}
                  </div>
                  <p class="text-xs text-[color:var(--text-736b5c)] font-semibold mt-0.5">${safeEmailHtml}</p>
                </div>
              </div>
              <div class="text-right space-y-1">
                <div class="flex items-center justify-end">
                  ${
                    isCur
                      ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md tone-bg-246337-15 text-[color:var(--text-185327)] border tone-border-246337-35 text-xs font-black shadow-2xs">
                           <span class="w-2 h-2 rounded-full bg-[var(--bg-246337)] animate-pulse"></span>
                           ${acc.ideRestartPending ? '凭据已更新 · 待重启' : '当前账号'}
                         </span>`
                      : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md tone-bg-dcd0bb-80 text-[color:var(--text-685f4e)] border border-[color:var(--border-cbbda3)] text-xs font-bold">
                           <span class="w-1.5 h-1.5 rounded-full bg-[var(--bg-8a806f)]"></span>
                           就绪备用
                         </span>`
                  }
                </div>
                <div class="text-[10px] text-[color:var(--text-8c8271)] flex items-center justify-end font-medium">
                  <b class="num-cell text-[color:var(--text-5a5244)] font-semibold">${lastSync}</b>
                </div>
              </div>
            </div>

            <!-- 双模型专属资源池分区 (三层独立子卡片架构：指标-进度条-刷新时间各得其所，绝不折行) -->
            <div class="space-y-3 tone-bg-e4d9c4-70 p-3.5 rounded-xl border border-[color:var(--border-d2c5ad)]">
              
              <!-- 1. Gemini 模型资源池 -->
              <div class="space-y-2 pb-3 border-b border-[color:var(--border-d8ccb5)]">
                <div class="flex justify-between items-center">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-[var(--bg-1e1d1a)] ring-2 tone-ring-bfa882-40"></span>
                    <span class="font-black text-xs text-[color:var(--text-1e1d1a)] tracking-tight">Gemini 模型资源池</span>
                  </div>
                  
                </div>

                <!-- 左右双栏：5小时限额卡片 + 周周期限额卡片 -->
                <div class="grid grid-cols-2 gap-2.5">
                  <!-- 5h 限额子卡片 -->
                  <div class="tone-bg-dbd0ba-60 p-2.5 rounded-xl border tone-border-d0c4ac-70 flex flex-col justify-between space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-[color:var(--text-5a5244)] flex items-center gap-1">
                        <svg class="w-3.5 h-3.5 text-[color:var(--text-7a7060)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                        5小时限额
                      </span>
                      <span class="font-black text-xs text-[color:var(--text-1e1d1a)] num-cell">${quotaLabel(g5h)}</span>
                    </div>
                    <div class="w-full tone-bg-c9ba9b-70 h-1.5 rounded-full overflow-hidden">
                      <div class="bg-[var(--bg-1e1d1a)] h-full rounded-full transition-all duration-500" style="width: ${quotaWidth(g5h)}%;"></div>
                    </div>
                    <div class="flex items-center justify-between text-[10px] text-[color:var(--text-6e6454)] whitespace-nowrap pt-0.5">
                      <span class="font-semibold text-[color:var(--text-524b3e)]">${r5hFmt}</span>
                      ${r5hDesc ? `<span class="px-1.5 py-0.5 rounded bg-[var(--bg-cfbf9f)] text-[color:var(--text-8c3f2b)] font-black">${r5hDesc}</span>` : ''}
                    </div>
                  </div>

                  <!-- 周周期限额子卡片 -->
                  <div class="tone-bg-dbd0ba-60 p-2.5 rounded-xl border tone-border-d0c4ac-70 flex flex-col justify-between space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-[color:var(--text-5a5244)] flex items-center gap-1">
                        <svg class="w-3.5 h-3.5 text-[color:var(--text-7a7060)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        周周期限额
                      </span>
                      <span class="font-black text-xs text-[color:var(--text-246337)] num-cell">${quotaLabel(gWeekly)}</span>
                    </div>
                    <div class="w-full tone-bg-c9ba9b-70 h-1.5 rounded-full overflow-hidden">
                      <div class="bg-[var(--bg-246337)] h-full rounded-full transition-all duration-500" style="width: ${quotaWidth(gWeekly)}%;"></div>
                    </div>
                    <div class="flex items-center justify-between text-[10px] text-[color:var(--text-6e6454)] whitespace-nowrap pt-0.5">
                      <span class="font-semibold text-[color:var(--text-524b3e)]">${rWeeklyFmt}</span>
                      ${rWeeklyDesc ? `<span class="px-1.5 py-0.5 rounded bg-[var(--bg-c4d9c7)] text-[color:var(--text-246337)] font-black">${rWeeklyDesc}</span>` : ''}
                    </div>
                  </div>
                </div>
              </div>

              <!-- 2. Claude / 高阶模型专属池 -->
              <div class="space-y-2 pt-0.5">
                <div class="flex justify-between items-center">
                  <div class="flex items-center gap-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-[var(--bg-246337)] ring-2 tone-ring-246337-40"></span>
                    <span class="font-black text-xs text-[color:var(--text-1e1d1a)] tracking-tight">Claude / 高阶模型专属池</span>
                  </div>
                  
                </div>

                <!-- 左右双栏：5小时限额卡片 + 周周期限额卡片 -->
                <div class="grid grid-cols-2 gap-2.5">
                  <!-- Claude 5h 限额子卡片 -->
                  <div class="tone-bg-dbd0ba-60 p-2.5 rounded-xl border tone-border-d0c4ac-70 flex flex-col justify-between space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-[color:var(--text-5a5244)] flex items-center gap-1">
                        <svg class="w-3.5 h-3.5 text-[color:var(--text-7a7060)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                        5小时限额
                      </span>
                      <span class="font-black text-xs text-[color:var(--text-1e1d1a)] num-cell">${quotaLabel(c5h)}</span>
                    </div>
                    <div class="w-full tone-bg-c9ba9b-70 h-1.5 rounded-full overflow-hidden">
                      <div class="bg-[var(--bg-1e1d1a)] h-full rounded-full transition-all duration-500" style="width: ${quotaWidth(c5h)}%;"></div>
                    </div>
                    <div class="flex items-center justify-between text-[10px] text-[color:var(--text-6e6454)] whitespace-nowrap pt-0.5">
                      <span class="font-semibold text-[color:var(--text-524b3e)]">${cr5hFmt}</span>
                      ${cr5hDesc ? `<span class="px-1.5 py-0.5 rounded bg-[var(--bg-cfbf9f)] text-[color:var(--text-8c3f2b)] font-black">${cr5hDesc}</span>` : ''}
                    </div>
                  </div>

                  <!-- Claude 周周期限额子卡片 -->
                  <div class="tone-bg-dbd0ba-60 p-2.5 rounded-xl border tone-border-d0c4ac-70 flex flex-col justify-between space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-[color:var(--text-5a5244)] flex items-center gap-1">
                        <svg class="w-3.5 h-3.5 text-[color:var(--text-7a7060)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                        周周期限额
                      </span>
                      <span class="font-black text-xs text-[color:var(--text-246337)] num-cell">${quotaLabel(cWeekly)}</span>
                    </div>
                    <div class="w-full tone-bg-c9ba9b-70 h-1.5 rounded-full overflow-hidden">
                      <div class="bg-[var(--bg-246337)] h-full rounded-full transition-all duration-500" style="width: ${quotaWidth(cWeekly)}%;"></div>
                    </div>
                    <div class="flex items-center justify-between text-[10px] text-[color:var(--text-6e6454)] whitespace-nowrap pt-0.5">
                      <span class="font-semibold text-[color:var(--text-524b3e)]">${crWeeklyFmt}</span>
                      ${crWeeklyDesc ? `<span class="px-1.5 py-0.5 rounded bg-[var(--bg-c4d9c7)] text-[color:var(--text-246337)] font-black">${crWeeklyDesc}</span>` : ''}
                    </div>
                  </div>
                </div>
              </div>

            </div>

            <!-- 操作按键区 -->
            ${
              isCur
                ? `<div class="w-full py-2.5 rounded-xl bg-[var(--bg-d6c9b0)] text-[color:var(--text-1e1d1a)] font-black text-xs border border-[color:var(--border-bfb094)] flex items-center justify-center gap-2 cursor-default shadow-xs">
                     <svg class="w-4 h-4 text-[color:var(--text-246337)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
                     <span>${acc.ideRestartPending ? '请重启 Antigravity 后使用此账号' : '当前使用账号'}</span>
                   </div>`
                : `<div class="flex items-center gap-2.5">
                     <button data-id="${safeId}" onclick="event.stopPropagation(); selectAccount('${safeId}', '${safeEmail}')" 
                             class="account-switch-btn flex-1 py-2.5 rounded-xl bg-[var(--bg-1e1d1a)] hover:bg-[var(--bg-343029)] text-[color:var(--text-faf8f3)] font-black text-xs shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-98">
                       <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                       <span>一键切换至此账号</span>
                     </button>
                     <button onclick="event.stopPropagation(); confirmDeleteAccount('${safeId}', '${safeEmail}')" title="从列表中删除账号" class="w-9 h-9 rounded-xl border border-[color:var(--border-c8bba0)] bg-[var(--bg-e5dcb9)] hover:bg-[var(--bg-8c3f2b)] hover:text-white hover:border-[color:var(--border-8c3f2b)] text-[color:var(--text-5c5343)] flex items-center justify-center transition-colors cursor-pointer shadow-xs">
                       <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                     </button>
                   </div>`
            }
          </div>
        `;
      }).join('');
    }

    // 初始化事件监听
    function initApp() {
      // 1. 点开即用：0毫秒秒级呈现本地缓存快照，彻底消除卡顿与0值
      const hasCached = window.chrome && window.chrome.webview ? rehydrateFromCache() : false;

      try {
        const savedTray = localStorage.getItem('antigravity_close_to_tray');
        if (savedTray !== null) {
          closeToTray = savedTray === '1';
          updateTrayToggleUI();
        }
      } catch (e) {}

      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.addEventListener('message', event => {
          const msg = event.data;
          if (msg.type === 'hubUpdateStatus') onHubUpdateStatus(msg.data || {});
          if (msg.type === 'clientRestartResult') onClientRestartResult(msg);
          if (msg.type === 'settingsSaveFailed' && pendingSettingsSave?.requestId === msg.requestId) {
            pendingSettingsSave = null; hubInstallAfterSettings = false;
            onHubUpdateStatus({state:'error',message:'设置未能保存，请重试'});
          }
          if (msg.type === 'settingsSaved' && pendingSettingsSave?.requestId === msg.requestId) {
            const saved = pendingSettingsSave; pendingSettingsSave = null;
            if (saved.needsRestart && !hubInstallAfterSettings) showClientRestartPrompt();
            if (hubInstallAfterSettings) { hubInstallAfterSettings = false; startHubUpdate(); }
          }
          if (msg.type === 'clientEnhancementStatus') {
            document.getElementById('client-enhancement-status').innerText = msg.message;
            const status = document.getElementById('client-enhancement-status');
            if (msg.message === '已就绪。') status.classList.add('hidden');
            else status.classList.remove('hidden');
          }
          if (msg.type === 'settingsData'  || msg.type === 'closeToTrayChanged' || msg.type === 'settingsSaved') {
            if (msg.data) {
              if (typeof msg.data.closeToTray === 'boolean') {
                closeToTray = msg.data.closeToTray;
              }
              appSettings = Object.assign({}, appSettings, msg.data);
              if(!settingsDraft) window.hubTheme.apply(appSettings.theme || "system");
              const rateVal = document.getElementById('modal-rate-val');
              if (rateVal && appSettings.liveUsdToCnyRate) {
                rateVal.innerText = Number(appSettings.liveUsdToCnyRate).toFixed(2);
              }
            }
          } else if (msg.type === 'windowRestored') {
            isMaximized = false;
            const edges = document.getElementById('window-resize-edges');
            if (edges) edges.style.display = 'block';
            const root = document.getElementById('app-root') || document.body;
            root.style.filter = '';
            root.style.opacity = '1';
            root.classList.remove('rounded-none');
            root.classList.add('rounded-[20px]', 'border');
            root.classList.remove('window-entrance', 'window-restored-focus');
            void root.offsetWidth;
            root.classList.add('window-restored-focus');
            setTimeout(() => {
              root.classList.remove('window-restored-focus');
            }, 240);
          } else if (msg.type === 'windowMaximized') {
            isMaximized = true;
            const edges = document.getElementById('window-resize-edges');
            if (edges) edges.style.display = 'none';
            const root = document.getElementById('app-root') || document.body;
            root.classList.remove('rounded-[20px]', 'border');
            root.classList.add('rounded-none');
          } else if (msg.type === 'hubData') {
            renderHubData(msg.data);
            if (!hubFrontendReady) { hubFrontendReady = true; window.chrome.webview.postMessage({action:'hubUpdateReady'}); }
          } else if (msg.type === 'refreshCompleted') {
            onRefreshFinished(msg);
          } else if (msg.type === 'operationError') {
            showToast(msg.message || '操作未完成', false);
          } else if (msg.type === 'switchResult') {
            isSwitchingAccount = false;
            const success = msg.data.success ?? msg.data.Success;
            const message = msg.data.message || msg.data.Message || (success ? '切换成功' : '切换失败');
            showToast(message, success || msg.data.cancelled || msg.data.Cancelled);
            renderFullAccountsList(currentAccountsList);
          } else if (msg.type === 'oauthStarted') {
            if (msg.data && msg.data.authUrl) {
              currentAuthUrl = msg.data.authUrl;
            }
          } else if (msg.type === 'oauthCancelled') {
            resetOAuthModalState();
          } else if (msg.type === 'oauthCompleted') {
            const success = msg.data.success ?? msg.data.Success;
            const message = msg.data.message || msg.data.Message || (success ? 'Google 授权成功' : 'Google 授权失败');
            showToast(message, success);
            if (success) {
              closeImportModal();
            } else {
              resetOAuthModalState();
            }
          } else if (msg.type === 'clientStatus') {
            renderClientStatus(msg.data || {});
          } else if (msg.type === 'importResult') {
            const success = msg.data.success ?? msg.data.Success;
            const message = msg.data.message || msg.data.Message || (success ? '导入成功' : '导入失败');
            showToast(message, success);
          } else if (msg.type === 'deleteResult') {
            const success = msg.data.success ?? msg.data.Success;
            const message = msg.data.message || msg.data.Message || (success ? '删除成功' : '删除失败');
            showToast(message, success);
          }
        });
        window.chrome.webview.postMessage({ action: 'getInitialData' });
        window.chrome.webview.postMessage({ action: 'getHubUpdateStatus' });
      } else {
        // A browser preview uses synthetic data only.
        const previewNotice = document.createElement('div');
        previewNotice.className = 'fixed bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-amber-100 text-amber-900 text-xs z-50';
        previewNotice.innerText = '浏览器演示 · 示例数据 · 账号操作需桌面应用';
        document.body.appendChild(previewNotice);
        if (!hasCached) {
          fetch('preview_data.json')
            .then(r => r.json())
            .then(data => renderHubData(data))
            .catch(e => console.error('Fallback load error:', e));
        }
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initApp);
    } else {
      initApp();
    }
  

document.addEventListener("keydown",e=>{if(e.key!=="Escape")return;if(!document.getElementById('hub-update-modal').classList.contains('hidden')){closeHubUpdatePrompt();return;}if(settingsDraft){if(isRecordingHotkey){stopRecordHotkey();e.stopPropagation();}else closeSettingsModal();}else if(!document.getElementById('client-restart-modal').classList.contains('hidden'))closeClientRestartPrompt();});

