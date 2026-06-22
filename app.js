(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    processes: 'cpi_processes',
    materials: 'cpi_materials',
    sterilizationRecords: 'cpi_sterilization_records',
    usageRecords: 'cpi_usage_records',
    currentProcessId: 'cpi_current_process_id',
  };

  const DAY_OFFSETS = { D0: 0, D3: 3, D11: 11, D14: 14 };
  const PROCESS_DAYS = ['D0', 'D3', 'D11', 'D14'];

  const DEFAULT_MATERIALS = [
    { id: 1, name: '鐵架 (Iron Rack)', icon: '🏗️', requiredQty: 2, processDay: 'D0' },
    { id: 2, name: '培養皿 (Petri Dish)', icon: '🧫', requiredQty: 10, processDay: 'D0' },
    { id: 3, name: '離心管 15mL', icon: '🧪', requiredQty: 20, processDay: 'D0' },
    { id: 4, name: '離心管 50mL', icon: '🧪', requiredQty: 10, processDay: 'D3' },
    { id: 5, name: '細胞刮刀 (Cell Scraper)', icon: '🔬', requiredQty: 5, processDay: 'D11' },
    { id: 6, name: '培養瓶 T75', icon: '🧬', requiredQty: 6, processDay: 'D0' },
    { id: 7, name: '培養瓶 T175', icon: '🧬', requiredQty: 4, processDay: 'D3' },
    { id: 8, name: '凍存管 (Cryovial)', icon: '❄️', requiredQty: 20, processDay: 'D14' },
  ];

  const ICON_OPTIONS = ['🏗️', '🧫', '🧪', '🔬', '🧬', '❄️', '💉', '🩺', '🧴', '🧲', '📦', '🔩', '⚗️', '🩹', '🧯', '🪣'];

  // ─── State ───────────────────────────────────────────────────────────
  let processes = [];
  let materials = [];
  let sterilizationRecords = [];
  let usageRecords = [];
  let currentProcessId = null;
  let gasUrl = '';
  let isSyncing = false;

  // Selection state for tile grids
  let sterSelectedIds = new Set();
  let usageSelectedIds = new Set();

  // Confirm callback
  let confirmCallback = null;
  let targetProcessId = null;

  // Dashboard filter
  let dashboardFilter = 'all'; // D0 | D3 | D11 | D14 | all
  let sterHistoryFilter = 'all'; // 'all' | materialId
  let usageHistoryFilter = 'all'; // 'all' | materialId

  // Sort and expansion states
  let dashboardSortOrder = 'asc'; // 'asc' | 'desc'
  let sterHistorySortOrder = 'desc'; // 'desc' | 'asc'
  let usageHistorySortOrder = 'desc'; // 'desc' | 'asc'
  let expandedCardIds = new Set();
  let expandedInventoryCardIds = new Set();
  let inventoryEditMode = false;
  let currentInventoryProcessId = 'all';
  let sterHistoryExpanded = false;
  let usageHistoryExpanded = false;
  let hasSyncedFromCloud = false;

  let lastGeneratedId = 0;
  function generateId() {
    let id = Date.now();
    if (id <= lastGeneratedId) {
      id = lastGeneratedId + 1;
    }
    lastGeneratedId = id;
    return id;
  }

  function formatDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + day;
  }

  function formatShortDate(str) {
    if (!str) return '—';
    const d = new Date(str);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return m + '/' + day;
  }

  function addMonths(str, n) {
    const d = new Date(str);
    const originalDay = d.getDate();
    d.setMonth(d.getMonth() + n);
    // Handle end-of-month overflow (e.g., Jan 31 + 1mo = Feb 28)
    if (d.getDate() !== originalDay) {
      d.setDate(0); // Go to last day of previous month
    }
    return toISODateString(d);
  }

  function addDays(str, n) {
    const d = new Date(str);
    d.setDate(d.getDate() + n);
    return toISODateString(d);
  }

  function toISODateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function todayISO() {
    return toISODateString(new Date());
  }

  function renderIconHtml(icon, size = '32px') {
    if (!icon) return '📦';
    if (icon.startsWith('data:image/') || icon.startsWith('http') || icon.startsWith('blob:')) {
      return '<img src="' + icon + '" style="width: ' + size + '; height: ' + size + '; border-radius: 6px; object-fit: cover; display: block; margin: 0 auto;">';
    }
    return icon;
  }

  function getProcessDayDate(processDay, process) {
    if (!process || !process.startDate) return null;
    const offset = DAY_OFFSETS[processDay];
    if (offset === undefined) return null;
    return addDays(process.startDate, offset);
  }

  function getDaysRemaining(expiryDate) {
    if (!expiryDate) return 0;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDate);
    exp.setHours(0, 0, 0, 0);
    const diffTime = exp.getTime() - now.getTime();
    return Math.round(diffTime / (1000 * 60 * 60 * 24));
  }

  function getExpiryStatus(expiryDate) {
    const days = getDaysRemaining(expiryDate);
    if (days < 0) return 'expired';
    if (days <= 7) return 'expiring';
    return 'valid';
  }

  function getMaterialBatches(materialId, processId, includeOthers = true) {
    const sterRecs = sterilizationRecords.filter(r => (includeOthers || r.processId === processId) && r.materialId === materialId);
    const batches = sterRecs.map(r => ({
      id: r.id,
      materialId: r.materialId,
      processId: r.processId,
      qty: r.qty,
      remainingQty: r.qty,
      sterilizationDate: r.sterilizationDate,
      expiryDate: r.expiryDate
    }));

    const batchIds = new Set(batches.map(b => b.id));
    const useRecs = usageRecords.filter(r => r.materialId === materialId && r.sterilizationRecordId && batchIds.has(r.sterilizationRecordId));

    useRecs.forEach(u => {
      const batch = batches.find(b => b.id === u.sterilizationRecordId);
      if (batch) {
        batch.remainingQty = Math.max(0, batch.remainingQty - u.qty);
      }
    });

    const fifoUseRecs = usageRecords.filter(r => r.materialId === materialId && !r.sterilizationRecordId);
    const processesWithLoadedBatches = new Set(batches.map(b => b.processId));

    processesWithLoadedBatches.forEach(pId => {
      const pUseRecs = fifoUseRecs.filter(r => r.processId === pId);
      const pBatches = batches.filter(b => b.processId === pId);
      const sortedForFifo = [...pBatches].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.id - b.id);
      
      pUseRecs.forEach(u => {
        let usageLeft = u.qty;
        for (let i = 0; i < sortedForFifo.length; i++) {
          const batch = sortedForFifo[i];
          if (batch.remainingQty > 0) {
            const deduct = Math.min(batch.remainingQty, usageLeft);
            batch.remainingQty -= deduct;
            usageLeft -= deduct;
            if (usageLeft <= 0) break;
          }
        }
      });
    });

    return batches.filter(b => b.remainingQty > 0);
  }

  function getProcessName(processId) {
    const proc = processes.find(p => p.id === processId);
    return proc ? proc.name : '未知批次';
  }

  function bindQtyAdjustButtons(container) {
    if (!container) return;
    container.querySelectorAll('.qty-adjust-wrap').forEach(wrap => {
      const input = wrap.querySelector('input');
      if (!input) return;
      const decBtn = wrap.querySelector('.btn-dec');
      const incBtn = wrap.querySelector('.btn-inc');
      if (decBtn) {
        decBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          let val = parseInt(input.value, 10) || 0;
          const min = parseInt(input.getAttribute('min'), 10) || 1;
          if (val > min) {
            input.value = val - 1;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
      if (incBtn) {
        incBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          let val = parseInt(input.value, 10) || 0;
          const max = parseInt(input.getAttribute('max'), 10) || Infinity;
          if (val < max) {
            input.value = val + 1;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      }
    });
  }

  // ─── Data Persistence ────────────────────────────────────────────────
  function loadData() {
    const stored = key => {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch (e) {
        return null;
      }
    };
    processes = stored(STORAGE_KEYS.processes) || [];
    materials = stored(STORAGE_KEYS.materials);
    if (!materials || materials.length === 0) {
      materials = JSON.parse(JSON.stringify(DEFAULT_MATERIALS));
      saveData('materials');
    }
    sterilizationRecords = stored(STORAGE_KEYS.sterilizationRecords) || [];
    usageRecords = stored(STORAGE_KEYS.usageRecords) || [];
    const storedPid = stored(STORAGE_KEYS.currentProcessId);
    currentProcessId = storedPid !== null ? storedPid : null;
    
    // Validate currentProcessId still exists and is not finished
    const activeProcesses = processes.filter(p => p.status !== 'finished');
    if (currentProcessId !== null && !activeProcesses.find(p => p.id === currentProcessId)) {
      currentProcessId = activeProcesses.length > 0 ? activeProcesses[0].id : null;
      saveData('currentProcessId');
    } else if (currentProcessId === null && activeProcesses.length > 0) {
      currentProcessId = activeProcesses[0].id;
      saveData('currentProcessId');
    }
    
    // Load GAS sync URL
    gasUrl = localStorage.getItem('cpi_gas_url') || '';
  }

  function saveData(what) {
    if (what !== 'skipCloud') {
      if (!what || what === 'processes') localStorage.setItem(STORAGE_KEYS.processes, JSON.stringify(processes));
      if (!what || what === 'materials') localStorage.setItem(STORAGE_KEYS.materials, JSON.stringify(materials));
      if (!what || what === 'sterilizationRecords') localStorage.setItem(STORAGE_KEYS.sterilizationRecords, JSON.stringify(sterilizationRecords));
      if (!what || what === 'usageRecords') localStorage.setItem(STORAGE_KEYS.usageRecords, JSON.stringify(usageRecords));
      if (!what || what === 'currentProcessId') localStorage.setItem(STORAGE_KEYS.currentProcessId, JSON.stringify(currentProcessId));
      
      pushToCloud();
    } else {
      localStorage.setItem(STORAGE_KEYS.processes, JSON.stringify(processes));
      localStorage.setItem(STORAGE_KEYS.materials, JSON.stringify(materials));
      localStorage.setItem(STORAGE_KEYS.sterilizationRecords, JSON.stringify(sterilizationRecords));
      localStorage.setItem(STORAGE_KEYS.usageRecords, JSON.stringify(usageRecords));
      localStorage.setItem(STORAGE_KEYS.currentProcessId, JSON.stringify(currentProcessId));
    }
  }

  function updateSyncStatus(status, type = 'info') {
    const el = document.getElementById('sync-status');
    const modalEl = document.getElementById('sync-status-modal');
    
    const updateEl = (target) => {
      if (!target) return;
      if (type === 'error') {
        target.style.color = '#ff6b6b';
        target.textContent = '🔴 同步失敗：' + status;
      } else if (type === 'success') {
        target.style.color = '#00d4aa';
        target.textContent = '🟢 ' + status;
      } else {
        target.style.color = 'var(--text-secondary)';
        target.textContent = '🟡 ' + status;
      }
    };

    updateEl(el);
    updateEl(modalEl);
  }

  function syncWithCloud() {
    if (!gasUrl) {
      updateSyncStatus('未設定雲端同步 (僅使用瀏覽器本機儲存)');
      hasSyncedFromCloud = true;
      return;
    }
    if (isSyncing) return;
    isSyncing = true;
    updateSyncStatus('正在從雲端載入資料...');

    // Show sync loading overlay
    const overlay = document.getElementById('sync-loading-overlay');
    const overlayText = document.getElementById('sync-loading-text');
    const skipBtn = document.getElementById('btn-skip-sync');
    
    if (overlay && !hasSyncedFromCloud) {
      overlay.classList.remove('hidden');
      if (overlayText) overlayText.textContent = '雲端資料同步中，請稍候...';
      if (skipBtn) {
        skipBtn.style.display = 'none';
        // Show skip button after 4 seconds in case connection is extremely slow/hung
        setTimeout(() => {
          if (!hasSyncedFromCloud) {
            skipBtn.style.display = 'block';
          }
        }, 4000);
      }
    }

    // Append cache buster to prevent cached Apps Script responses
    const syncUrl = gasUrl + (gasUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();

    fetch(syncUrl)
      .then(res => res.json())
      .then(data => {
        if (data && data.materials) {
          processes = data.processes || [];
          materials = data.materials || [];
          sterilizationRecords = data.sterilizationRecords || [];
          usageRecords = data.usageRecords || [];
          if (data.currentProcessId !== undefined) {
            currentProcessId = data.currentProcessId;
          }
          
          // Save to local cache without triggering a loop sync back
          saveData('skipCloud');
          
          // Refresh views
          renderProcessPills();
          renderDashboard();
          renderMaterialsList();
          renderSterilizationPage();
          renderUsagePage();
          
          updateSyncStatus('已完成雲端資料同步', 'success');
          
          hasSyncedFromCloud = true;
          if (overlay) overlay.classList.add('hidden');
        } else {
          updateSyncStatus('雲端資料格式錯誤，請檢查試算表', 'error');
          if (overlay) overlay.classList.add('hidden');
        }
      })
      .catch(err => {
        console.error('Fetch sync error:', err);
        updateSyncStatus('連線失敗，使用本機暫存資料', 'error');
        if (overlay) {
          if (overlayText) overlayText.textContent = '無法連線至雲端，已切換至離線暫存模式。';
          setTimeout(() => {
            overlay.classList.add('hidden');
            hasSyncedFromCloud = true;
          }, 1500);
        } else {
          hasSyncedFromCloud = true;
        }
      })
      .finally(() => {
        isSyncing = false;
      });
  }

  function pushToCloud() {
    if (!gasUrl) return;
    if (!hasSyncedFromCloud) {
      console.log('Skipping cloud push: initial sync is not complete yet.');
      return;
    }
    updateSyncStatus('同步至雲端中...');
    
    const payload = {
      action: 'sync',
      data: {
        processes: processes,
        materials: materials,
        sterilizationRecords: sterilizationRecords,
        usageRecords: usageRecords,
        currentProcessId: currentProcessId
      }
    };
    
    // We send payload as JSON string but do NOT set application/json content-type
    // to prevent browser from sending preflight CORS OPTIONS requests to Google Apps Script.
    fetch(gasUrl, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(resData => {
        if (resData && resData.success) {
          updateSyncStatus('已同步至雲端', 'success');
        } else {
          updateSyncStatus('同步失敗: ' + (resData ? resData.error : '未知錯誤'), 'error');
        }
      })
      .catch(err => {
        console.error('Push sync error:', err);
        updateSyncStatus('同步失敗 (連線錯誤)', 'error');
      });
  }

  function performCloudSyncAction(actionCallback, afterCallback) {
    if (!gasUrl) {
      actionCallback();
      saveData('skipCloud');
      if (afterCallback) afterCallback();
      return;
    }

    const overlay = document.getElementById('sync-loading-overlay');
    const overlayText = document.getElementById('sync-loading-text');
    if (overlay) {
      if (overlayText) overlayText.textContent = '正在與雲端同步最新資料...';
      overlay.classList.remove('hidden');
    }

    const syncUrl = gasUrl + (gasUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    fetch(syncUrl)
      .then(res => res.json())
      .then(data => {
        if (data && data.materials) {
          processes = data.processes || [];
          materials = data.materials || [];
          sterilizationRecords = data.sterilizationRecords || [];
          usageRecords = data.usageRecords || [];
          if (data.currentProcessId !== undefined) {
            currentProcessId = data.currentProcessId;
          }
          saveData('skipCloud');
        }
        
        actionCallback();
        saveData(); // saves locally and pushes back to cloud

        if (overlay) overlay.classList.add('hidden');
        
        // Show success status
        updateSyncStatus('已同步至雲端', 'success');
        
        const timeEl = document.getElementById('sync-time-modal');
        if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();

        if (afterCallback) afterCallback();
      })
      .catch(err => {
        console.error('Action cloud sync error:', err);
        showToast('無法同步雲端，已以離線模式儲存於本機');
        
        actionCallback();
        saveData('skipCloud');
        
        if (overlay) overlay.classList.add('hidden');
        if (afterCallback) afterCallback();
      });
  }

  // ─── Empty State Renderer ────────────────────────────────────────────
  function renderEmptyState(itemType, iconType) {
    const icons = {
      material: '<svg viewBox="0 0 64 64" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2"><rect x="12" y="8" width="40" height="48" rx="4"/><line x1="20" y1="20" x2="44" y2="20"/><line x1="20" y1="30" x2="44" y2="30"/><line x1="20" y1="40" x2="36" y2="40"/></svg>',
      sterilization: '<svg viewBox="0 0 64 64" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2"><circle cx="32" cy="32" r="20"/><path d="M32 20v12l8 8"/></svg>',
      usage: '<svg viewBox="0 0 64 64" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 48V20l16-12 16 12v28H16z"/><rect x="24" y="32" width="16" height="16"/></svg>',
      process: '<svg viewBox="0 0 64 64" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="12" width="48" height="40" rx="4"/><line x1="8" y1="24" x2="56" y2="24"/><circle cx="20" cy="36" r="4"/><circle cx="32" cy="44" r="4"/><circle cx="44" cy="36" r="4"/></svg>',
    };
    const messages = {
      material: '尚無耗材資料',
      sterilization: '尚無滅菌紀錄',
      usage: '尚無使用紀錄',
      process: '請先建立或選擇製程批次',
    };
    return '<div class="empty-state">' +
      '<div class="empty-icon">' + (icons[iconType] || icons.material) + '</div>' +
      '<p>' + (messages[itemType] || '無資料') + '</p>' +
      '</div>';
  }

  // ─── Toast ───────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // ─── Modal Management ───────────────────────────────────────────────
  function openModal(name) {
    const id = name.startsWith('modal-') ? name : 'modal-' + name;
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  }

  function closeModal(name) {
    const id = name.startsWith('modal-') ? name : 'modal-' + name;
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  }

  function initModals() {
    // Close on overlay click
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', function (e) {
        if (e.target === this) {
          this.classList.remove('active');
        }
      });
    });
    // Close buttons
    document.querySelectorAll('.modal-close[data-modal]').forEach(btn => {
      btn.addEventListener('click', function () {
        closeModal(this.getAttribute('data-modal'));
      });
    });
  }

  // ─── Confirm Modal ──────────────────────────────────────────────────
  function showConfirm(message, callback) {
    document.getElementById('confirm-message').textContent = message;
    confirmCallback = callback;
    openModal('confirm');
  }

  function initConfirm() {
    document.getElementById('btn-confirm-ok').addEventListener('click', function () {
      closeModal('confirm');
      if (typeof confirmCallback === 'function') {
        confirmCallback();
        confirmCallback = null;
      }
    });
    document.getElementById('btn-confirm-cancel').addEventListener('click', function () {
      closeModal('confirm');
      confirmCallback = null;
    });
  }

  // ─── Tab Navigation ─────────────────────────────────────────────────
  function initTabs() {
    document.querySelectorAll('.tab-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', function () {
        const pageName = this.getAttribute('data-page');
        switchToPage(pageName);
      });
    });
  }

  function switchToPage(pageName) {
    // Update tabs
    document.querySelectorAll('.tab-btn[data-page]').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector('.tab-btn[data-page="' + pageName + '"]');
    if (activeTab) activeTab.classList.add('active');

    // Update pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const activePage = document.getElementById('page-' + pageName);
    if (activePage) activePage.classList.add('active');

    // Re-render
    switch (pageName) {
      case 'dashboard':
        renderProcessPills();
        renderDashboard();
        break;
      case 'materials':
        renderMaterialsList();
        break;
      case 'sterilization':
        renderSterilizationPage();
        break;
      case 'usage':
        renderUsagePage();
        break;
    }

    try {
      localStorage.setItem('cpi_active_page', pageName);
    } catch (e) {}
  }

  // ─── Process CRUD ───────────────────────────────────────────────────
  function initProcessForm() {
    const btnAdd = document.getElementById('btn-add-process');
    const btnEdit = document.getElementById('btn-edit-process');
    const form = document.getElementById('form-process');
    const dateInput = document.getElementById('input-process-date');

    if (btnAdd) {
      btnAdd.addEventListener('click', function () {
        document.getElementById('modal-process-title').textContent = '新增製程批次';
        document.getElementById('input-process-name').value = '';
        document.getElementById('input-process-date').value = todayISO();
        document.getElementById('input-process-id').value = '';
        updateProcessDatePreview(todayISO());
        openModal('process');
      });
    }

    if (btnEdit) {
      btnEdit.addEventListener('click', function () {
        const proc = processes.find(p => p.id === currentProcessId);
        if (!proc) {
          showToast('請先選擇製程批次');
          return;
        }
        document.getElementById('modal-process-title').textContent = '編輯製程批次';
        document.getElementById('input-process-name').value = proc.name;
        document.getElementById('input-process-date').value = proc.startDate;
        document.getElementById('input-process-id').value = proc.id;
        updateProcessDatePreview(proc.startDate);
        openModal('process');
      });
    }

    if (dateInput) {
      dateInput.addEventListener('change', function () {
        updateProcessDatePreview(this.value);
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('input-process-name').value.trim();
        const startDate = document.getElementById('input-process-date').value;
        const editId = document.getElementById('input-process-id').value;

        if (!name) {
          showToast('請輸入批次名稱');
          return;
        }
        if (!startDate) {
          showToast('請選擇起始日期');
          return;
        }

        performCloudSyncAction(() => {
          if (editId) {
            // Edit existing
            const idx = processes.findIndex(p => p.id === Number(editId));
            if (idx !== -1) {
              processes[idx].name = name;
              processes[idx].startDate = startDate;
            }
          } else {
            // Add new
            const proc = { id: generateId(), name: name, startDate: startDate };
            processes.push(proc);
            currentProcessId = proc.id;
          }
        }, () => {
          closeModal('process');
          showToast(editId ? '製程批次已更新' : '製程批次已建立');
          renderProcessPills();
          renderDashboard();
        });
      });
    }
  }

  function updateProcessDatePreview(dateStr) {
    if (!dateStr) return;
    PROCESS_DAYS.forEach(day => {
      const el = document.getElementById('preview-' + day.toLowerCase());
      if (el) {
        const actual = addDays(dateStr, DAY_OFFSETS[day]);
        el.textContent = formatShortDate(actual);
      }
    });
  }

  function deleteProcessConfirm(processId) {
    showConfirm('確定直接刪除此製程批次？\n此操作無法撤銷，相關的所有滅菌及使用紀錄也將被徹底刪除。', function () {
      performCloudSyncAction(() => {
        processes = processes.filter(p => p.id !== processId);
        sterilizationRecords = sterilizationRecords.filter(r => r.processId !== processId);
        usageRecords = usageRecords.filter(r => r.processId !== processId);
        if (currentProcessId === processId) {
          const active = processes.filter(p => p.status !== 'finished');
          currentProcessId = active.length > 0 ? active[0].id : null;
          saveData('currentProcessId');
        }
      }, () => {
        showToast('製程批次已刪除');
        targetProcessId = null;

        // Sync other selectors
        const sterSelect = document.getElementById('ster-process-select');
        if (sterSelect) sterSelect.value = currentProcessId || '';
        const usageSelect = document.getElementById('usage-process-select');
        if (usageSelect) usageSelect.value = currentProcessId || '';

        renderProcessPills();
        renderDashboard();
        renderMaterialsList();
        renderSterilizationPage();
        renderUsagePage();
      });
    });
  }

  function initProcessActionModals() {
    const btnFinish = document.getElementById('btn-process-finish');
    const btnDelete = document.getElementById('btn-process-delete');
    const btnCancel = document.getElementById('btn-process-action-cancel');
    const formFeedback = document.getElementById('form-process-feedback');

    if (btnFinish) {
      btnFinish.addEventListener('click', function () {
        closeModal('process-action');
        // Clear previous values in feedback form
        document.querySelectorAll('input[name="feedback-issues"]').forEach(cb => cb.checked = false);
        const descEl = document.getElementById('input-feedback-desc');
        if (descEl) descEl.value = '';
        
        openModal('process-feedback');
      });
    }

    if (btnDelete) {
      btnDelete.addEventListener('click', function () {
        closeModal('process-action');
        if (targetProcessId) {
          deleteProcessConfirm(targetProcessId);
        }
      });
    }

    if (btnCancel) {
      btnCancel.addEventListener('click', function () {
        closeModal('process-action');
        targetProcessId = null;
      });
    }

    if (formFeedback) {
      formFeedback.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!targetProcessId) return;

        const checkedBoxes = Array.from(document.querySelectorAll('input[name="feedback-issues"]:checked')).map(cb => cb.value);
        const descVal = document.getElementById('input-feedback-desc').value.trim();
        const procId = targetProcessId;

        performCloudSyncAction(() => {
          const idx = processes.findIndex(p => p.id === procId);
          if (idx !== -1) {
            processes[idx].status = 'finished';
            processes[idx].feedback = {
              issues: checkedBoxes,
              description: descVal,
              finishedAt: new Date().toISOString()
            };
          }
          // Set currentProcessId to another active process if it was the selected one
          if (currentProcessId === procId) {
            const active = processes.filter(p => p.id !== procId && p.status !== 'finished');
            currentProcessId = active.length > 0 ? active[0].id : null;
            saveData('currentProcessId');
          }
        }, () => {
          closeModal('process-feedback');
          showToast('製程已結束並封存');
          targetProcessId = null;
          
          // Sync other selectors
          const sterSelect = document.getElementById('ster-process-select');
          if (sterSelect) sterSelect.value = currentProcessId || '';
          const usageSelect = document.getElementById('usage-process-select');
          if (usageSelect) usageSelect.value = currentProcessId || '';

          renderProcessPills();
          renderDashboard();
          renderMaterialsList();
          renderSterilizationPage();
          renderUsagePage();
        });
      });
    }
  }

  function renderProcessPills() {
    const container = document.getElementById('process-pills');
    if (!container) return;

    const activeProcesses = processes.filter(p => p.status !== 'finished');

    if (activeProcesses.length === 0) {
      container.innerHTML = '<div class="no-process-hint">尚無製程批次，請點擊上方按鈕新增</div>';
      return;
    }

    let html = '';
    activeProcesses.forEach(proc => {
      const isActive = proc.id === currentProcessId;
      html += '<button class="process-pill' + (isActive ? ' active' : '') + '" data-id="' + proc.id + '">' +
        '<span class="pill-name">' + escapeHtml(proc.name) + '</span>' +
        '<span class="pill-date">' + formatShortDate(proc.startDate) + '</span>' +
        '<span class="pill-delete" data-id="' + proc.id + '">×</span>' +
        '</button>';
    });
    container.innerHTML = html;

    // Pill click
    container.querySelectorAll('.process-pill').forEach(pill => {
      pill.addEventListener('click', function (e) {
        // Don't switch if clicking delete
        if (e.target.classList.contains('pill-delete')) return;
        const id = Number(this.getAttribute('data-id'));
        currentProcessId = id;
        saveData('currentProcessId');
        
        // Sync other selectors
        const sterSelect = document.getElementById('ster-process-select');
        if (sterSelect) sterSelect.value = id || '';
        const usageSelect = document.getElementById('usage-process-select');
        if (usageSelect) usageSelect.value = id || '';
        
        renderProcessPills();
        renderDashboard();
      });
    });

    // Delete/Archive click
    container.querySelectorAll('.pill-delete').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const id = Number(this.getAttribute('data-id'));
        targetProcessId = id;
        
        const proc = processes.find(p => p.id === id);
        const msgEl = document.getElementById('process-action-message');
        if (msgEl && proc) {
          msgEl.innerHTML = '請選擇要結束「<strong>' + escapeHtml(proc.name) + '</strong>」並封存資料，或是直接將其刪除？';
        }
        
        openModal('process-action');
      });
    });
  }

  // ─── Dashboard ──────────────────────────────────────────────────────
  function initFilterPills() {
    document.querySelectorAll('#filter-pills .pill[data-filter]').forEach(pill => {
      pill.addEventListener('click', function () {
        document.querySelectorAll('#filter-pills .pill').forEach(p => p.classList.remove('active'));
        this.classList.add('active');
        dashboardFilter = this.getAttribute('data-filter');
        renderDashboardMaterials();
      });
    });
  }

  function renderDashboard() {
    const dateCard = document.getElementById('process-date-card');
    const chartCard = document.getElementById('dashboard-chart-card');
    const dashMaterials = document.getElementById('dashboard-materials');
    const proc = processes.find(p => p.id === currentProcessId);

    if (!proc) {
      // No process selected
      if (dateCard) dateCard.style.display = 'none';
      if (chartCard) chartCard.style.display = 'none';
      document.getElementById('stat-total').textContent = '0';
      document.getElementById('stat-ok').textContent = '0';
      document.getElementById('stat-warn').textContent = '0';
      document.getElementById('stat-danger').textContent = '0';
      if (dashMaterials) dashMaterials.innerHTML = renderEmptyState('process', 'process');
      return;
    }

    // Show date card & chart card
    if (dateCard) dateCard.style.display = '';
    if (chartCard) chartCard.style.display = '';
    document.getElementById('process-date-title').textContent = proc.name;
    PROCESS_DAYS.forEach(day => {
      const el = document.getElementById('day-' + day.toLowerCase());
      if (el) el.textContent = formatShortDate(getProcessDayDate(day, proc));
    });

    // Highlight today's day
    const processDays = document.getElementById('process-days');
    if (processDays) {
      processDays.querySelectorAll('.day-badge').forEach(badge => {
        const dayKey = badge.getAttribute('data-day');
        if (dayKey) {
          const dayDate = getProcessDayDate(dayKey, proc);
          const today = todayISO();
          badge.classList.toggle('today', dayDate === today);
        }
      });
    }

    renderDashboardMaterials();
  }

  function getMaterialStatus(material, processId) {
    const proc = processes.find(p => p.id === processId);
    const batches = getMaterialBatches(material.id, processId, false);
    const stock = batches.reduce((s, b) => s + b.remainingQty, 0);

    const sterRecs = sterilizationRecords.filter(r => r.processId === processId && r.materialId === material.id);
    const useRecs = usageRecords.filter(r => r.processId === processId && r.materialId === material.id);
    const totalSterilized = sterRecs.reduce((s, r) => s + r.qty, 0);
    const totalUsed = useRecs.reduce((s, r) => s + r.qty, 0);

    // Calculate usable stock on the process day date
    let usableStock = 0;
    const processDayDate = proc ? getProcessDayDate(material.processDay, proc) : null;
    batches.forEach(b => {
      if (!processDayDate || b.expiryDate >= processDayDate) {
        usableStock += b.remainingQty;
      }
    });

    // Check if any active batch is expiring soon (remaining days <= 15 days relative to today)
    let hasExpiringSoon = false;
    let nearestExpiry = null;
    let expiryStatus = 'valid';
    batches.forEach(b => {
      if (!nearestExpiry || b.expiryDate < nearestExpiry) {
        nearestExpiry = b.expiryDate;
      }
      const daysLeft = getDaysRemaining(b.expiryDate);
      if (daysLeft >= 0 && daysLeft <= 15) {
        hasExpiringSoon = true;
      }
    });
    if (nearestExpiry) {
      expiryStatus = getExpiryStatus(nearestExpiry);
    }

    // Determine overall status
    let status = 'ok';
    if (stock < material.requiredQty || (material.requiredQty > 0 && usableStock === 0)) {
      status = 'danger'; // 庫存量小於需求量顯示不足，或是可用數量為0
    } else if (usableStock < material.requiredQty || hasExpiringSoon) {
      status = 'warn'; // 庫存量足夠但可使用量小於需求量，或是快過期，顯示注意
    }

    return {
      totalSterilized,
      totalUsed,
      stock,
      usableStock,
      nearestExpiry,
      expiryStatus,
      status,
    };
  }

  function renderDashboardMaterials() {
    const container = document.getElementById('dashboard-materials');
    if (!container) return;

    const proc = processes.find(p => p.id === currentProcessId);
    if (!proc) {
      container.innerHTML = renderEmptyState('process', 'process');
      return;
    }

    let statTotal = 0, statOk = 0, statWarn = 0, statDanger = 0;
    const filteredMaterials = [];

    materials.forEach(mat => {
      const info = getMaterialStatus(mat, currentProcessId);
      statTotal++;
      if (info.status === 'ok') statOk++;
      else if (info.status === 'warn') statWarn++;
      else if (info.status === 'danger') statDanger++;

      // Filter
      if (dashboardFilter !== 'all' && mat.processDay !== dashboardFilter) return;
      filteredMaterials.push({ mat, info });
    });

    // Update Stats text
    document.getElementById('stat-total').textContent = statTotal;
    document.getElementById('stat-ok').textContent = statOk;
    document.getElementById('stat-warn').textContent = statWarn;
    document.getElementById('stat-danger').textContent = statDanger;

    // Update Chart Card
    const total = statOk + statWarn + statDanger;
    const pctOk = total > 0 ? Math.round((statOk / total) * 100) : 0;
    const pctWarn = total > 0 ? Math.round((statWarn / total) * 100) : 0;
    const pctDanger = total > 0 ? 100 - pctOk - pctWarn : 0;

    const barOk = document.querySelector('.bar-ok');
    const barWarn = document.querySelector('.bar-warn');
    const barDanger = document.querySelector('.bar-danger');
    if (barOk) barOk.style.width = pctOk + '%';
    if (barWarn) barWarn.style.width = pctWarn + '%';
    if (barDanger) barDanger.style.width = pctDanger + '%';

    const pctOkEl = document.getElementById('chart-ok-pct');
    const pctWarnEl = document.getElementById('chart-warn-pct');
    const pctDangerEl = document.getElementById('chart-danger-pct');
    if (pctOkEl) pctOkEl.textContent = pctOk + '%';
    if (pctWarnEl) pctWarnEl.textContent = pctWarn + '%';
    if (pctDangerEl) pctDangerEl.textContent = pctDanger + '%';

    if (filteredMaterials.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>沒有符合篩選條件的品項</p></div>';
      return;
    }

    // Group materials by processDay
    const groups = {};
    PROCESS_DAYS.forEach(day => { groups[day] = []; });
    filteredMaterials.forEach(item => {
      const day = item.mat.processDay;
      if (!groups[day]) groups[day] = [];
      groups[day].push(item);
    });

    let html = '';
    PROCESS_DAYS.forEach(day => {
      const items = groups[day];
      if (items.length === 0) return;
      const dayDate = getProcessDayDate(day, proc);
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + ' — ' + formatShortDate(dayDate) + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(item => {
        const mat = item.mat;
        const info = item.info;

        const batches = getMaterialBatches(mat.id, currentProcessId, false);
        const groupedByDays = {};
        let minDays = Infinity;
        batches.forEach(b => {
          const days = getDaysRemaining(b.expiryDate);
          if (!groupedByDays[days]) groupedByDays[days] = 0;
          groupedByDays[days] += b.remainingQty;
        });

        const sortedDays = Object.keys(groupedByDays).map(Number).sort((a, b) => a - b);
        const batchTexts = [];
        sortedDays.forEach(days => {
          const qty = groupedByDays[days];
          if (days < minDays) minDays = days;
          let text = qty + '個';
          if (days < 0) {
            text += '已過期';
          } else if (days === 0) {
            text += '今天到期';
          } else {
            text += '剩' + days + '天';
          }
          batchTexts.push(text);
        });

        const daysLeftText = batchTexts.length > 0 ? batchTexts.join('，') : '尚未滅菌';
        let daysLeftClass = 'none';
        if (batches.length > 0) {
          if (minDays < 0 || minDays === 0 || minDays <= 7) {
            daysLeftClass = 'danger';
          } else if (minDays <= 15) {
            daysLeftClass = 'warn';
          } else {
            daysLeftClass = 'ok';
          }
        }

        let detailRowsHtml = '';
        const sortedBatches = [...batches].sort((a, b) => {
          const comp = a.sterilizationDate.localeCompare(b.sterilizationDate) || a.expiryDate.localeCompare(b.expiryDate);
          return (dashboardSortOrder === 'desc' ? -1 : 1) * comp || (a.id - b.id);
        });
        sortedBatches.forEach(b => {
          const isNative = b.processId === currentProcessId;
          const sourceText = isNative ? '本批次' : getProcessName(b.processId);
          detailRowsHtml += '<tr>' +
            '<td>' + escapeHtml(sourceText) + '</td>' +
            '<td>' + formatDate(b.sterilizationDate) + '</td>' +
            '<td>' + formatDate(b.expiryDate) + '</td>' +
            '<td>' + b.remainingQty + ' 個</td>' +
            '</tr>';
        });
        let detailPanelHtml = '';
        if (batches.length > 0) {
          const isExpanded = expandedCardIds.has(mat.id);
          const arrow = dashboardSortOrder === 'desc' ? '▼' : '▲';
          detailPanelHtml = '<div class="tile-details-panel" style="display: ' + (isExpanded ? 'block' : 'none') + ';">' +
            '<table class="details-table">' +
            '<thead>' +
            '<tr>' +
            '<th>來源批次</th>' +
            '<th class="sortable-header" style="cursor: pointer; user-select: none;" title="點擊切換升降序">滅菌日 ' + arrow + '</th>' +
            '<th>到期日</th>' +
            '<th>庫存</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            detailRowsHtml +
            '</tbody>' +
            '</table>' +
            '</div>';
        }

        html += '<div class="material-tile status-' + info.status + '" data-id="' + mat.id + '">' +
          '<div class="tile-status-dot ' + info.status + '"></div>' +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
          '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 庫存: ' + info.stock + '</div>' +
          '<div class="tile-days-left ' + daysLeftClass + '">' + daysLeftText + '</div>' +
          detailPanelHtml +
          '</div>';
      });
      html += '</div></div>';
    });

    container.innerHTML = html;

    // Toggle expand drilldown details on click
    container.querySelectorAll('.material-tile').forEach(tile => {
      tile.style.cursor = 'pointer';
      const id = Number(tile.getAttribute('data-id'));
      if (expandedCardIds.has(id)) {
        tile.classList.add('expanded');
      }

      tile.addEventListener('click', function () {
        const panel = this.querySelector('.tile-details-panel');
        if (panel) {
          const isVisible = panel.style.display === 'block';
          panel.style.display = isVisible ? 'none' : 'block';
          this.classList.toggle('expanded', !isVisible);
          if (!isVisible) {
            expandedCardIds.add(id);
          } else {
            expandedCardIds.delete(id);
          }
        }
      });
      const panel = tile.querySelector('.tile-details-panel');
      if (panel) {
        panel.addEventListener('click', function (e) {
          e.stopPropagation();
        });
      }
      const sortHeader = tile.querySelector('.sortable-header');
      if (sortHeader) {
        sortHeader.addEventListener('click', function (e) {
          e.stopPropagation();
          dashboardSortOrder = (dashboardSortOrder === 'asc') ? 'desc' : 'asc';
          renderDashboard();
        });
      }
    });
  }

  // ─── Material CRUD ──────────────────────────────────────────────────
  function compressImage(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const maxDim = 128;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png');
        callback(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function initMaterialForm() {
    const btnToggleEdit = document.getElementById('btn-toggle-inventory-edit');
    if (btnToggleEdit) {
      btnToggleEdit.addEventListener('click', function () {
        inventoryEditMode = !inventoryEditMode;
        this.classList.toggle('active', inventoryEditMode);
        this.textContent = inventoryEditMode ? '✓' : '✏️';
        renderMaterialsList();
      });
    }

    const invSelect = document.getElementById('inv-process-select');
    if (invSelect) {
      invSelect.addEventListener('change', function () {
        const val = this.value;
        currentInventoryProcessId = val === 'all' ? 'all' : Number(val);
        renderMaterialsList();
      });
    }

    const btnAdd = document.getElementById('btn-add-material');
    const form = document.getElementById('form-material');
    const fileInput = document.getElementById('input-material-file-icon');
    const filePreview = document.getElementById('material-file-preview');
    const imgPreview = document.getElementById('img-file-preview');
    const btnClearFile = document.getElementById('btn-clear-file-icon');
    const customIconInput = document.getElementById('input-material-custom-icon');
    const iconInput = document.getElementById('input-material-icon');
    const picker = document.getElementById('icon-picker');

    if (btnAdd) {
      btnAdd.addEventListener('click', function () {
        document.getElementById('modal-material-title').textContent = '新增耗材';
        document.getElementById('input-material-name').value = '';
        document.getElementById('input-material-icon').value = '📦';
        if (customIconInput) customIconInput.value = '';
        document.getElementById('input-material-qty').value = '1';
        document.getElementById('input-material-day').value = 'D0';
        document.getElementById('input-material-id').value = '';
        
        // Reset file upload
        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.style.display = 'none';
        if (imgPreview) imgPreview.src = '';

        // Reset icon picker
        document.querySelectorAll('#icon-picker .icon-option').forEach(opt => {
          opt.classList.toggle('selected', opt.getAttribute('data-icon') === '📦');
        });
        openModal('material');
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        compressImage(file, function (compressedDataUrl) {
          if (iconInput) iconInput.value = compressedDataUrl;
          if (imgPreview) imgPreview.src = compressedDataUrl;
          if (filePreview) filePreview.style.display = 'flex';

          // Clear emoji picker selection & custom icon text input
          if (picker) {
            picker.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
          }
          if (customIconInput) {
            customIconInput.value = '';
          }
        });
      });
    }

    if (btnClearFile) {
      btnClearFile.addEventListener('click', function () {
        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.style.display = 'none';
        if (imgPreview) imgPreview.src = '';
        if (iconInput) iconInput.value = '📦';

        // Reset to default emoji selection in picker
        if (picker) {
          picker.querySelectorAll('.icon-option').forEach(opt => {
            opt.classList.toggle('selected', opt.getAttribute('data-icon') === '📦');
          });
        }
        if (customIconInput) {
          customIconInput.value = '';
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('input-material-name').value.trim();
        const icon = document.getElementById('input-material-icon').value || '📦';
        const qty = parseInt(document.getElementById('input-material-qty').value, 10) || 1;
        const day = document.getElementById('input-material-day').value;
        const editId = document.getElementById('input-material-id').value;

        if (!name) {
          showToast('請輸入耗材名稱');
          return;
        }

        performCloudSyncAction(() => {
          if (editId) {
            const idx = materials.findIndex(m => m.id === Number(editId));
            if (idx !== -1) {
              materials[idx].name = name;
              materials[idx].icon = icon;
              materials[idx].requiredQty = qty;
              materials[idx].processDay = day;
            }
          } else {
            materials.push({ id: generateId(), name, icon, requiredQty: qty, processDay: day });
          }
        }, () => {
          closeModal('material');
          showToast(editId ? '耗材已更新' : '耗材已新增');
          renderMaterialsList();
          renderDashboard();
          renderSterilizationHistory();
          renderUsageHistory();
        });
      });
    }
  }

  function initIconPicker() {
    const picker = document.getElementById('icon-picker');
    if (!picker) return;

    // Populate icons
    let html = '';
    ICON_OPTIONS.forEach(icon => {
      html += '<button type="button" class="icon-option" data-icon="' + icon + '">' + icon + '</button>';
    });
    picker.innerHTML = html;

    picker.addEventListener('click', function (e) {
      const opt = e.target.closest('.icon-option');
      if (!opt) return;
      picker.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      document.getElementById('input-material-icon').value = opt.getAttribute('data-icon');

      const customIconInput = document.getElementById('input-material-custom-icon');
      if (customIconInput) {
        customIconInput.value = '';
      }

      // Clear file upload
      const fileInput = document.getElementById('input-material-file-icon');
      const filePreview = document.getElementById('material-file-preview');
      const imgPreview = document.getElementById('img-file-preview');
      if (fileInput) fileInput.value = '';
      if (filePreview) filePreview.style.display = 'none';
      if (imgPreview) imgPreview.src = '';
    });

    const customIconInput = document.getElementById('input-material-custom-icon');
    if (customIconInput) {
      customIconInput.addEventListener('input', function () {
        const val = this.value.trim();
        picker.querySelectorAll('.icon-option').forEach(o => o.classList.remove('selected'));
        document.getElementById('input-material-icon').value = val || '📦';

        // Clear file upload
        if (val) {
          const fileInput = document.getElementById('input-material-file-icon');
          const filePreview = document.getElementById('material-file-preview');
          const imgPreview = document.getElementById('img-file-preview');
          if (fileInput) fileInput.value = '';
          if (filePreview) filePreview.style.display = 'none';
          if (imgPreview) imgPreview.src = '';
        }
      });
    }
  }

  function editMaterial(id) {
    const mat = materials.find(m => m.id === id);
    if (!mat) return;
    document.getElementById('modal-material-title').textContent = '編輯耗材';
    document.getElementById('input-material-name').value = mat.name;
    document.getElementById('input-material-icon').value = mat.icon;
    document.getElementById('input-material-qty').value = mat.requiredQty;
    document.getElementById('input-material-day').value = mat.processDay;
    document.getElementById('input-material-id').value = mat.id;

    const fileInput = document.getElementById('input-material-file-icon');
    const filePreview = document.getElementById('material-file-preview');
    const imgPreview = document.getElementById('img-file-preview');
    const customIconInput = document.getElementById('input-material-custom-icon');

    if (fileInput) fileInput.value = '';

    const isImage = mat.icon && (mat.icon.startsWith('data:image/') || mat.icon.startsWith('http') || mat.icon.startsWith('blob:'));
    const isPreset = ICON_OPTIONS.includes(mat.icon);

    if (isImage) {
      if (customIconInput) customIconInput.value = '';
      if (filePreview) filePreview.style.display = 'flex';
      if (imgPreview) imgPreview.src = mat.icon;
      document.querySelectorAll('#icon-picker .icon-option').forEach(opt => {
        opt.classList.remove('selected');
      });
    } else {
      if (filePreview) filePreview.style.display = 'none';
      if (imgPreview) imgPreview.src = '';
      if (customIconInput) {
        customIconInput.value = isPreset ? '' : mat.icon;
      }
      document.querySelectorAll('#icon-picker .icon-option').forEach(opt => {
        opt.classList.toggle('selected', isPreset && opt.getAttribute('data-icon') === mat.icon);
      });
    }

    openModal('material');
  }

  function deleteMaterial(id) {
    const mat = materials.find(m => m.id === id);
    if (!mat) return;
    showConfirm('確定刪除「' + mat.name + '」？\n相關的滅菌及使用紀錄也將被刪除。', function () {
      performCloudSyncAction(() => {
        materials = materials.filter(m => m.id !== id);
        sterilizationRecords = sterilizationRecords.filter(r => r.materialId !== id);
        usageRecords = usageRecords.filter(r => r.materialId !== id);
      }, () => {
        showToast('耗材已刪除');
        renderMaterialsList();
        renderDashboard();
        renderSterilizationHistory();
        renderUsageHistory();
      });
    });
  }

  function renderMaterialsList() {
    const container = document.getElementById('materials-list');
    if (!container) return;

    populateProcessSelect('inv-process-select', {
      defaultText: '— 全部批次庫存 —',
      defaultValue: 'all',
      selectedId: currentInventoryProcessId
    });

    if (materials.length === 0) {
      container.innerHTML = renderEmptyState('material', 'material');
      return;
    }

    // Group by processDay
    const groups = {};
    PROCESS_DAYS.forEach(day => { groups[day] = []; });
    materials.forEach(mat => {
      if (!groups[mat.processDay]) groups[mat.processDay] = [];
      groups[mat.processDay].push(mat);
    });

    let html = '';
    PROCESS_DAYS.forEach(day => {
      const items = groups[day];
      if (items.length === 0) return;
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(mat => {
        const totalSter = sterilizationRecords.filter(r => r.materialId === mat.id).reduce((s, r) => s + r.qty, 0);
        
        let stockText = '總滅菌: ' + totalSter;
        let validStock = totalSter;
        let expiredStock = 0;
        let activeBatches = [];
        let status = 'ok';

        if (currentInventoryProcessId !== 'all') {
          activeBatches = getMaterialBatches(mat.id, currentInventoryProcessId, false);
          validStock = activeBatches.filter(b => getDaysRemaining(b.expiryDate) >= 0).reduce((sum, b) => sum + b.remainingQty, 0);
          expiredStock = activeBatches.filter(b => getDaysRemaining(b.expiryDate) < 0).reduce((sum, b) => sum + b.remainingQty, 0);
          
          stockText = '可用庫存: ' + validStock;
          if (expiredStock > 0) {
            stockText = '可用庫存: ' + validStock + ' ｜ <span style="color: var(--danger); font-weight: 600;">已過期: ' + expiredStock + '</span>';
          }
          stockText = '需求: ' + mat.requiredQty + ' ｜ ' + stockText;
          if (validStock < mat.requiredQty) {
            stockText += ' ｜ <span style="color: var(--danger); font-weight: 600;">不足</span>';
          }
          
          const info = getMaterialStatus(mat, currentInventoryProcessId);
          status = info.status;
        } else {
          activeBatches = getMaterialBatches(mat.id, null, true);
          validStock = activeBatches.filter(b => getDaysRemaining(b.expiryDate) >= 0).reduce((sum, b) => sum + b.remainingQty, 0);
          expiredStock = activeBatches.filter(b => getDaysRemaining(b.expiryDate) < 0).reduce((sum, b) => sum + b.remainingQty, 0);
          
          stockText = '可用庫存: ' + validStock;
          if (expiredStock > 0) {
            stockText = '可用庫存: ' + validStock + ' ｜ <span style="color: var(--danger); font-weight: 600;">已過期: ' + expiredStock + '</span>';
          }
          
          status = validStock > 0 ? 'ok' : 'danger';
        }

        const badgeHtml = '<div class="tile-stock-badge">' + validStock + '</div>';

        let detailPanelHtml = '';
        let expandedClass = '';
        if (!inventoryEditMode && activeBatches.length > 0) {
          const isExpanded = expandedInventoryCardIds.has(mat.id);
          if (isExpanded) expandedClass = ' expanded';
          
          let detailRowsHtml = '';
          const sortedBatches = [...activeBatches].sort((a, b) => b.sterilizationDate.localeCompare(a.sterilizationDate) || a.id - b.id);
          
          sortedBatches.forEach(b => {
            const isSelectedProc = currentInventoryProcessId !== 'all' ? (b.processId === currentInventoryProcessId) : (currentProcessId && b.processId === currentProcessId);
            const sourceText = isSelectedProc ? '本批次' : getProcessName(b.processId);
            const delBtnHtml = '<button class="btn-del-batch-record" data-id="' + b.id + '" title="刪除滅菌紀錄">🗑️</button>';
            
            detailRowsHtml += '<tr>' +
              '<td>' + escapeHtml(sourceText) + '</td>' +
              '<td>' + formatDate(b.sterilizationDate) + '</td>' +
              '<td>' + formatDate(b.expiryDate) + '</td>' +
              '<td>' + b.remainingQty + ' 個</td>' +
              '<td>' + delBtnHtml + '</td>' +
              '</tr>';
          });
          
          detailPanelHtml = '<div class="tile-details-panel" style="display: ' + (isExpanded ? 'block' : 'none') + ';">' +
            '<table class="details-table">' +
            '<thead>' +
            '<tr>' +
            '<th>來源批次</th>' +
            '<th>滅菌日</th>' +
            '<th>到期日</th>' +
            '<th>庫存</th>' +
            '<th>操作</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            detailRowsHtml +
            '</tbody>' +
            '</table>' +
            '</div>';
        }

        const actionsOverlayHtml = inventoryEditMode ? 
          ('<div class="tile-actions-overlay" style="display: flex;">' +
          '<button class="tile-action-btn btn-edit-mat" data-id="' + mat.id + '" title="編輯">✏️</button>' +
          '<button class="tile-action-btn btn-del-mat" data-id="' + mat.id + '" title="刪除">🗑️</button>' +
          '</div>') : '';

        html += '<div class="material-tile' + expandedClass + '" data-id="' + mat.id + '">' +
          badgeHtml +
          actionsOverlayHtml +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
          '<div class="tile-stock">' + stockText + '</div>' +
          detailPanelHtml +
          '</div>';
      });
      html += '</div></div>';
    });

    container.innerHTML = html;

    // Event listeners
    container.querySelectorAll('.material-tile').forEach(tile => {
      const id = Number(tile.getAttribute('data-id'));
      
      tile.addEventListener('click', function (e) {
        if (inventoryEditMode) {
          if (e.target.closest('.btn-del-mat') || e.target.closest('.btn-edit-mat')) return;
          editMaterial(id);
        } else {
          if (e.target.closest('.btn-del-batch-record')) return;
          
          const panel = this.querySelector('.tile-details-panel');
          if (panel) {
            const isVisible = panel.style.display === 'block';
            panel.style.display = isVisible ? 'none' : 'block';
            this.classList.toggle('expanded', !isVisible);
            if (!isVisible) {
              expandedInventoryCardIds.add(id);
            } else {
              expandedInventoryCardIds.delete(id);
            }
          }
        }
      });
    });

    container.querySelectorAll('.btn-edit-mat').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        editMaterial(Number(this.getAttribute('data-id')));
      });
    });

    container.querySelectorAll('.btn-del-mat').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        deleteMaterial(Number(this.getAttribute('data-id')));
      });
    });

    container.querySelectorAll('.btn-del-batch-record').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        const recId = Number(this.getAttribute('data-id'));
        showConfirm('確定刪除此批次的滅菌紀錄？\n該筆紀錄的可用庫存將歸零，相關的使用紀錄也將被刪除。', function () {
          performCloudSyncAction(() => {
            sterilizationRecords = sterilizationRecords.filter(r => r.id !== recId);
            usageRecords = usageRecords.filter(r => r.sterilizationRecordId !== recId);
          }, () => {
            showToast('滅菌紀錄已刪除');
            renderMaterialsList();
            renderDashboard();
            renderSterilizationHistory();
            renderUsageHistory();
          });
        });
      });
    });
  }

  // ─── Sterilization Page ─────────────────────────────────────────────
  function initSterilizationPage() {
    const processSelect = document.getElementById('ster-process-select');
    const batchDate = document.getElementById('ster-batch-date');
    const btnSave = document.getElementById('btn-save-sterilization');
    const btnExport = document.getElementById('btn-export-sterilization');

    if (processSelect) {
      processSelect.addEventListener('change', function () {
        const processId = getSelectedProcessId('ster-process-select');
        currentProcessId = processId;
        saveData('currentProcessId');
        
        // Sync other selectors
        const usageSelect = document.getElementById('usage-process-select');
        if (usageSelect) usageSelect.value = processId || '';
        renderProcessPills();
        
        sterSelectedIds.clear();
        renderSterilizationTiles();
        renderSterilizationHistory();
        updateSterBatchInput();
      });
    }

    if (batchDate) {
      batchDate.addEventListener('change', function () {
        const val = this.value;
        const expiry = val ? addMonths(val, 1) : '';
        const expiryEl = document.getElementById('ster-batch-expiry');
        if (expiryEl) expiryEl.textContent = expiry ? '效期至: ' + formatDate(expiry) : '';
      });
    }

    if (btnSave) {
      btnSave.addEventListener('click', saveSterilization);
    }

    if (btnExport) {
      btnExport.addEventListener('click', function (e) {
        e.stopPropagation();
        exportSterilizationToCsv();
      });
    }

    const headerSter = document.getElementById('header-ster-history');
    const contentSter = document.getElementById('section-ster-history-content');
    if (headerSter && contentSter) {
      headerSter.addEventListener('click', function () {
        sterHistoryExpanded = !sterHistoryExpanded;
        contentSter.style.display = sterHistoryExpanded ? 'block' : 'none';
        const toggleIcon = this.querySelector('.toggle-icon');
        if (toggleIcon) toggleIcon.textContent = sterHistoryExpanded ? '🔼' : '🔽';
      });
    }

    const searchInput = document.getElementById('ster-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        renderSterilizationHistory();
      });
    }

    const matSearchInput = document.getElementById('ster-mat-search-input');
    if (matSearchInput) {
      matSearchInput.addEventListener('input', function () {
        renderSterilizationTiles();
      });
    }
  }

  function exportSterilizationToCsv() {
    const processId = getSelectedProcessId('ster-process-select');
    const proc = processes.find(p => p.id === processId);
    if (!proc) {
      showToast('請先選擇製程批次');
      return;
    }

    const recs = sterilizationRecords
      .filter(r => r.processId === processId)
      .sort((a, b) => b.sterilizationDate.localeCompare(a.sterilizationDate) || b.id - a.id);

    if (recs.length === 0) {
      showToast('目前製程尚無滅菌紀錄可供匯出');
      return;
    }

    let csvContent = "製程批次,滅菌日期,物料名稱,滅菌數量,有效期限,剩餘天數,狀態\n";
    recs.forEach(rec => {
      const mat = materials.find(m => m.id === rec.materialId);
      const matName = mat ? mat.name : '（已刪除）';
      const days = getDaysRemaining(rec.expiryDate);
      let status = '充足';
      if (days < 0) status = '已過期';
      else if (days === 0) status = '今天到期';
      else if (days <= 7) status = '剩餘7天內';
      else if (days <= 15) status = '剩餘15天內';

      const row = [
        '"' + proc.name.replace(/"/g, '""') + '"',
        formatDate(rec.sterilizationDate),
        '"' + matName.replace(/"/g, '""') + '"',
        rec.qty,
        formatDate(rec.expiryDate),
        days < 0 ? '已過期' : days,
        status
      ];
      csvContent += row.join(',') + "\n";
    });

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const filename = '滅菌紀錄_' + proc.name + '_' + todayISO() + '.csv';
    link.setAttribute("download", filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('已匯出 Excel (CSV) 檔案');
  }

  function renderSterilizationPage() {
    populateProcessSelect('ster-process-select');
    sterSelectedIds.clear();
    renderSterilizationTiles();
    renderSterilizationHistory();
    updateSterBatchInput();

    // Set default date
    const batchDate = document.getElementById('ster-batch-date');
    if (batchDate) {
      batchDate.value = todayISO();
      const expiryEl = document.getElementById('ster-batch-expiry');
      if (expiryEl) expiryEl.textContent = '效期至: ' + formatDate(addMonths(todayISO(), 1));
    }
  }

  function renderSterilizationTiles() {
    const container = document.getElementById('ster-tile-groups');
    if (!container) return;

    const processId = getSelectedProcessId('ster-process-select');
    const proc = processes.find(p => p.id === processId);

    if (!proc || materials.length === 0) {
      container.innerHTML = renderEmptyState(proc ? 'material' : 'process', proc ? 'material' : 'process');
      return;
    }

    const searchInput = document.getElementById('ster-mat-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Group materials by processDay
    const groups = {};
    PROCESS_DAYS.forEach(day => { groups[day] = []; });
    materials.forEach(mat => {
      if (searchVal && !mat.name.toLowerCase().includes(searchVal)) return;
      if (!groups[mat.processDay]) groups[mat.processDay] = [];
      groups[mat.processDay].push(mat);
    });

    let html = '';
    PROCESS_DAYS.forEach(day => {
      const items = groups[day];
      if (items.length === 0) return;
      const dayDate = getProcessDayDate(day, proc);
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + ' — ' + formatShortDate(dayDate) + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(mat => {
        const isSelected = sterSelectedIds.has(mat.id);
        const stock = getStock(mat.id, processId);
        html += '<div class="material-tile' + (isSelected ? ' selected' : '') + '" data-id="' + mat.id + '">' +
          '<div class="tile-check">✓</div>' +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
          '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 庫存: ' + stock + '</div>' +
          '<div class="tile-qty-container">' +
          '<span class="tile-qty-label">數量</span>' +
          '<div class="qty-adjust-wrap">' +
          '<button type="button" class="btn-qty-adj btn-dec">-</button>' +
          '<input type="number" class="tile-qty-input" min="1" value="' + mat.requiredQty + '" data-id="' + mat.id + '">' +
          '<button type="button" class="btn-qty-adj btn-inc">+</button>' +
          '</div>' +
          '</div>' +
          '</div>';
      });
      html += '</div></div>';
    });

    container.innerHTML = html;
    bindQtyAdjustButtons(container);

    // Tile click
    container.querySelectorAll('.material-tile').forEach(tile => {
      tile.addEventListener('click', function (e) {
        // Don't toggle if clicking input or its wrapper/label
        if (e.target.closest('.tile-qty-container')) return;
        const id = Number(this.getAttribute('data-id'));
        if (sterSelectedIds.has(id)) {
          sterSelectedIds.delete(id);
          this.classList.remove('selected');
        } else {
          sterSelectedIds.add(id);
          this.classList.add('selected');
        }
        updateSterBatchInput();
      });
    });
  }

  function updateSterBatchInput() {
    const batchInput = document.getElementById('ster-batch-input');
    const countEl = document.getElementById('ster-selected-count');
    if (batchInput) {
      batchInput.style.display = sterSelectedIds.size > 0 ? 'block' : 'none';
    }
    if (countEl) {
      countEl.textContent = '已選擇 ' + sterSelectedIds.size + ' 項耗材';
    }
  }

  function saveSterilization() {
    const processId = getSelectedProcessId('ster-process-select');
    if (!processId) {
      showToast('請先選擇製程批次');
      return;
    }
    if (sterSelectedIds.size === 0) {
      showToast('請選擇至少一項耗材');
      return;
    }
    const dateVal = document.getElementById('ster-batch-date').value;
    if (!dateVal) {
      showToast('請選擇滅菌日期');
      return;
    }
    const expiryDate = addMonths(dateVal, 1);

    const sortedSelectedIds = [...sterSelectedIds].sort((a, b) => {
      const idxA = materials.findIndex(m => m.id === a);
      const idxB = materials.findIndex(m => m.id === b);
      return idxA - idxB;
    });

    sortedSelectedIds.forEach(materialId => {
      const input = document.querySelector('#ster-tile-groups .tile-qty-input[data-id="' + materialId + '"]');
      const qty = input ? parseInt(input.value, 10) || 1 : 1;
      sterilizationRecords.push({
        id: generateId(),
        processId: processId,
        materialId: materialId,
        qty: qty,
        sterilizationDate: dateVal,
        expiryDate: expiryDate,
      });
    });

    saveData('sterilizationRecords');
    showToast('已記錄 ' + sterSelectedIds.size + ' 項滅菌');
    sterSelectedIds.clear();
    renderSterilizationTiles();
    renderSterilizationHistory();
    updateSterBatchInput();
  }

  function renderSterilizationHistory() {
    const container = document.getElementById('sterilization-history');
    if (!container) return;

    const processId = getSelectedProcessId('ster-process-select');
    if (!processId) {
      container.innerHTML = renderEmptyState('process', 'process');
      return;
    }

    // Material filter pills
    let filterHtml = '<div class="history-filter-scroll">';
    filterHtml += '<button class="hist-pill' + (sterHistoryFilter === 'all' ? ' active' : '') + '" data-id="all">全部</button>';
    materials.forEach(m => {
      const isActive = sterHistoryFilter === m.id;
      filterHtml += '<button class="hist-pill' + (isActive ? ' active' : '') + '" data-id="' + m.id + '">' + escapeHtml(m.name) + '</button>';
    });
    filterHtml += '</div>';

    const searchInput = document.getElementById('ster-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    const recs = sterilizationRecords
      .filter(r => r.processId === processId)
      .filter(r => sterHistoryFilter === 'all' || r.materialId === sterHistoryFilter)
      .filter(r => {
        if (!searchVal) return true;
        const mat = materials.find(m => m.id === r.materialId);
        const nameMatch = mat ? mat.name.toLowerCase().includes(searchVal) : false;
        
        const rawDate = r.sterilizationDate.toLowerCase();
        const formattedDate = formatDate(r.sterilizationDate).toLowerCase();
        const cleanSearchVal = searchVal.replace(/[-/]/g, '');
        const cleanRawDate = rawDate.replace(/[-/]/g, '');
        
        const dateMatch = rawDate.includes(searchVal) || 
                          formattedDate.includes(searchVal) || 
                          cleanRawDate.includes(cleanSearchVal);
                          
        return nameMatch || dateMatch;
      });

    recs.sort((a, b) => {
      const comp = a.sterilizationDate.localeCompare(b.sterilizationDate);
      return (sterHistorySortOrder === 'desc' ? -1 : 1) * comp || (a.id - b.id);
    });

    let tableHtml = '';
    if (recs.length === 0) {
      tableHtml = renderEmptyState('sterilization', 'sterilization');
    } else {
      tableHtml = '<div class="history-table-container">' +
        '<table class="history-table">' +
        '<thead>' +
        '<tr>' +
        '<th class="sortable-ster-history-header" style="cursor:pointer; user-select:none;" title="點擊切換升降序">滅菌日期 ' + (sterHistorySortOrder === 'desc' ? '▼' : '▲') + '</th>' +
        '<th>物料名稱</th>' +
        '<th>數量</th>' +
        '<th>有效期限</th>' +
        '<th>狀態</th>' +
        '<th>操作</th>' +
        '</tr>' +
        '</thead>' +
        '<tbody>';
      
      recs.forEach(rec => {
        const mat = materials.find(m => m.id === rec.materialId);
        const matName = mat ? (renderIconHtml(mat.icon, '16px') + ' ' + escapeHtml(mat.name)) : '（已刪除）';
        const daysLeft = getDaysRemaining(rec.expiryDate);
        let badgeText = '';
        let statusClass = 'ok';
        if (daysLeft < 0) {
          badgeText = '已過期';
          statusClass = 'danger';
        } else if (daysLeft === 0) {
          badgeText = '今天到期';
          statusClass = 'danger';
        } else if (daysLeft <= 7) {
          badgeText = '剩 ' + daysLeft + ' 天';
          statusClass = 'danger';
        } else if (daysLeft <= 15) {
          badgeText = '剩 ' + daysLeft + ' 天';
          statusClass = 'warn';
        } else {
          badgeText = '剩 ' + daysLeft + ' 天';
          statusClass = 'ok';
        }

        tableHtml += '<tr>' +
          '<td>' + formatDate(rec.sterilizationDate) + '</td>' +
          '<td>' + matName + '</td>' +
          '<td>' + rec.qty + ' 個</td>' +
          '<td>' + formatDate(rec.expiryDate) + '</td>' +
          '<td><span class="badge badge-' + statusClass + '">' + badgeText + '</span></td>' +
          '<td><button class="btn-del-record" data-type="sterilization" data-id="' + rec.id + '" title="刪除">🗑️</button></td>' +
          '</tr>';
      });
      
      tableHtml += '</tbody></table></div>';
    }

    container.innerHTML = filterHtml + tableHtml;

    // Filter pill click
    container.querySelectorAll('.hist-pill').forEach(pill => {
      pill.addEventListener('click', function () {
        const id = this.getAttribute('data-id');
        sterHistoryFilter = id === 'all' ? 'all' : Number(id);
        renderSterilizationHistory();
      });
    });

    // Sort header click
    const sortHeader = container.querySelector('.sortable-ster-history-header');
    if (sortHeader) {
      sortHeader.addEventListener('click', function () {
        sterHistorySortOrder = (sterHistorySortOrder === 'desc') ? 'asc' : 'desc';
        renderSterilizationHistory();
      });
    }

    // Delete record click
    container.querySelectorAll('.btn-del-record[data-type="sterilization"]').forEach(btn => {
      btn.addEventListener('click', function () {
        const recId = Number(this.getAttribute('data-id'));
        showConfirm('確定刪除此滅菌紀錄？', function () {
          performCloudSyncAction(() => {
            sterilizationRecords = sterilizationRecords.filter(r => r.id !== recId);
            usageRecords = usageRecords.filter(r => r.sterilizationRecordId !== recId);
          }, () => {
            showToast('紀錄已刪除');
            renderSterilizationHistory();
            renderMaterialsList();
            renderDashboard();
            renderUsageHistory();
          });
        });
      });
    });
  }

  // ─── Usage Page ─────────────────────────────────────────────────────
  function initUsagePage() {
    const processSelect = document.getElementById('usage-process-select');
    const btnSave = document.getElementById('btn-save-usage');

    if (processSelect) {
      processSelect.addEventListener('change', function () {
        const processId = getSelectedProcessId('usage-process-select');
        currentProcessId = processId;
        saveData('currentProcessId');
        
        // Sync other selectors
        const sterSelect = document.getElementById('ster-process-select');
        if (sterSelect) sterSelect.value = processId || '';
        renderProcessPills();
        
        usageSelectedIds.clear();
        renderUsageTiles();
        renderUsageHistory();
        updateUsageBatchInput();
      });
    }

    if (btnSave) {
      btnSave.addEventListener('click', saveUsage);
    }

    const searchInput = document.getElementById('usage-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        renderUsageHistory();
      });
    }

    const matSearchInput = document.getElementById('usage-mat-search-input');
    if (matSearchInput) {
      matSearchInput.addEventListener('input', function () {
        renderUsageTiles();
      });
    }
    const headerUsage = document.getElementById('header-usage-history');
    const contentUsage = document.getElementById('section-usage-history-content');
    if (headerUsage && contentUsage) {
      headerUsage.addEventListener('click', function () {
        usageHistoryExpanded = !usageHistoryExpanded;
        contentUsage.style.display = usageHistoryExpanded ? 'block' : 'none';
        const toggleIcon = this.querySelector('.toggle-icon');
        if (toggleIcon) toggleIcon.textContent = usageHistoryExpanded ? '🔼' : '🔽';
      });
    }
  }

  function renderUsagePage() {
    populateProcessSelect('usage-process-select');
    usageSelectedIds.clear();
    renderUsageTiles();
    renderUsageHistory();
    updateUsageBatchInput();
  }

  function getStock(materialId, processId) {
    const batches = getMaterialBatches(materialId, processId);
    return batches.reduce((sum, b) => sum + b.remainingQty, 0);
  }

  function renderUsageTiles() {
    const container = document.getElementById('usage-tile-groups');
    if (!container) return;

    const processId = getSelectedProcessId('usage-process-select');
    const proc = processes.find(p => p.id === processId);

    if (!proc || materials.length === 0) {
      container.innerHTML = renderEmptyState(proc ? 'material' : 'process', proc ? 'material' : 'process');
      return;
    }

    const searchInput = document.getElementById('usage-mat-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Group materials by processDay
    const groups = {};
    PROCESS_DAYS.forEach(day => { groups[day] = []; });
    materials.forEach(mat => {
      if (searchVal && !mat.name.toLowerCase().includes(searchVal)) return;
      if (!groups[mat.processDay]) groups[mat.processDay] = [];
      groups[mat.processDay].push(mat);
    });

    let html = '';
    PROCESS_DAYS.forEach(day => {
      const items = groups[day];
      if (items.length === 0) return;
      const dayDate = getProcessDayDate(day, proc);
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + ' — ' + formatShortDate(dayDate) + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(mat => {
        const batches = getMaterialBatches(mat.id, processId, true);
        const totalStock = batches.reduce((sum, b) => sum + b.remainingQty, 0);

        if (batches.length > 0) {
          const isSelected = usageSelectedIds.has(mat.id);

          // Group active batches by processId and expiryDate to merge identical day/process items
          const grouped = {};
          batches.forEach(b => {
            const key = b.processId + '_' + b.expiryDate;
            if (!grouped[key]) {
              grouped[key] = {
                processId: b.processId,
                expiryDate: b.expiryDate,
                remainingQty: 0
              };
            }
            grouped[key].remainingQty += b.remainingQty;
          });

          const groupedBatches = Object.values(grouped);

          // Sort batches: prioritize native batches of the selected process, then sort by expiry date (FIFO)
          groupedBatches.sort((a, b) => {
            const aIsNative = a.processId === processId;
            const bIsNative = b.processId === processId;
            if (aIsNative && !bIsNative) return -1;
            if (!aIsNative && bIsNative) return 1;
            return a.expiryDate.localeCompare(b.expiryDate);
          });
          
          const defaultBatch = groupedBatches[0];
          const defaultQty = Math.min(mat.requiredQty, defaultBatch.remainingQty);

          let optionsHtml = '';
          groupedBatches.forEach(b => {
            const days = getDaysRemaining(b.expiryDate);
            let expiryText = '';
            if (days < 0) {
              expiryText = '已過期';
            } else if (days === 0) {
              expiryText = '今天到期';
            } else {
              expiryText = '剩' + days + '天';
            }
            
            // Check if it belongs to current process or is borrowed
            const procName = getProcessName(b.processId);
            const isNative = b.processId === processId;
            const prefix = isNative ? '' : '【借自 ' + procName + '】';
            
            optionsHtml += '<option value="' + b.processId + '_' + b.expiryDate + '" data-qty="' + b.remainingQty + '">' +
              prefix + expiryText + ' (庫存: ' + b.remainingQty + ')' +
              '</option>';
          });

          html += '<div class="material-tile' + (isSelected ? ' selected' : '') + '" data-id="' + mat.id + '">' +
            '<div class="tile-check">✓</div>' +
            '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
            '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
            '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 總庫存: ' + totalStock + '</div>' +
            '<div class="tile-batch-select-wrap">' +
            '<select class="tile-batch-select" data-id="' + mat.id + '">' +
            optionsHtml +
            '</select>' +
            '</div>' +
            '<div class="tile-qty-container">' +
            '<span class="tile-qty-label">數量</span>' +
            '<div class="qty-adjust-wrap">' +
            '<button type="button" class="btn-qty-adj btn-dec">-</button>' +
            '<input type="number" class="tile-qty-input" min="1" max="' + defaultBatch.remainingQty + '" value="' + defaultQty + '" data-id="' + mat.id + '">' +
            '<button type="button" class="btn-qty-adj btn-inc">+</button>' +
            '</div>' +
            '</div>' +
            '</div>';
        } else {
          html += '<div class="material-tile disabled" data-id="' + mat.id + '">' +
            '<div class="tile-check">✓</div>' +
            '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
            '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
            '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 庫存: 0</div>' +
            '<div class="tile-qty-container">' +
            '<span class="tile-qty-label">數量</span>' +
            '<div class="qty-adjust-wrap">' +
            '<button type="button" class="btn-qty-adj btn-dec" disabled>-</button>' +
            '<input type="number" class="tile-qty-input" min="1" max="0" value="0" data-id="' + mat.id + '" disabled>' +
            '<button type="button" class="btn-qty-adj btn-inc" disabled>+</button>' +
            '</div>' +
            '</div>' +
            '</div>';
        }
      });
      html += '</div></div>';
    });

    container.innerHTML = html;
    bindQtyAdjustButtons(container);

    // Tile click
    container.querySelectorAll('.material-tile').forEach(tile => {
      tile.addEventListener('click', function (e) {
        if (e.target.closest('.tile-qty-container') || e.target.closest('.tile-batch-select-wrap')) return;
        if (this.classList.contains('disabled')) return;
        const id = Number(this.getAttribute('data-id'));
        if (usageSelectedIds.has(id)) {
          usageSelectedIds.delete(id);
          this.classList.remove('selected');
        } else {
          usageSelectedIds.add(id);
          this.classList.add('selected');
        }
        updateUsageBatchInput();
      });
    });

    // Batch dropdown change listener
    container.querySelectorAll('.tile-batch-select').forEach(select => {
      select.addEventListener('click', function (e) { e.stopPropagation(); });
      select.addEventListener('change', function () {
        const matId = Number(this.getAttribute('data-id'));
        const tile = this.closest('.material-tile');
        if (!tile) return;
        const input = tile.querySelector('.tile-qty-input');
        if (!input) return;

        const selectedOption = this.options[this.selectedIndex];
        if (!selectedOption) return;
        const remainingQty = parseInt(selectedOption.getAttribute('data-qty'), 10) || 0;

        // Update input max
        input.setAttribute('max', remainingQty);

        // Cap value to new max
        let val = parseInt(input.value, 10) || 1;
        if (val > remainingQty) {
          input.value = remainingQty;
        } else if (val <= 0 && remainingQty > 0) {
          input.value = 1;
        }
      });
    });
  }

  function updateUsageBatchInput() {
    const batchInput = document.getElementById('usage-batch-input');
    const countEl = document.getElementById('usage-selected-count');
    if (batchInput) {
      batchInput.style.display = usageSelectedIds.size > 0 ? 'block' : 'none';
    }
    if (countEl) {
      countEl.textContent = '已選擇 ' + usageSelectedIds.size + ' 項耗材';
    }
  }

  function saveUsage() {
    const processId = getSelectedProcessId('usage-process-select');
    if (!processId) {
      showToast('請先選擇製程批次');
      return;
    }
    if (usageSelectedIds.size === 0) {
      showToast('請選擇至少一項耗材');
      return;
    }

    const today = todayISO();
    let hasError = false;

    const sortedSelectedIds = [...usageSelectedIds].sort((a, b) => {
      const idxA = materials.findIndex(m => m.id === a);
      const idxB = materials.findIndex(m => m.id === b);
      return idxA - idxB;
    });

    sortedSelectedIds.forEach(materialId => {
      if (hasError) return;
      
      const select = document.querySelector('#usage-tile-groups .tile-batch-select[data-id="' + materialId + '"]');
      if (!select) {
        hasError = true;
        return;
      }
      const val = select.value;
      const parts = val.split('_');
      if (parts.length !== 2) {
        hasError = true;
        return;
      }
      const targetProcId = Number(parts[0]);
      const targetExpiryDate = parts[1];
      
      const input = document.querySelector('#usage-tile-groups .tile-qty-input[data-id="' + materialId + '"]');
      const qty = input ? parseInt(input.value, 10) || 1 : 1;
      
      const batches = getMaterialBatches(materialId, processId, true);
      const matches = batches.filter(b => b.processId === targetProcId && b.expiryDate === targetExpiryDate);
      const stock = matches.reduce((sum, b) => sum + b.remainingQty, 0);

      if (qty > stock) {
        const mat = materials.find(m => m.id === materialId);
        showToast('「' + (mat ? mat.name : '') + '」該批次庫存不足 (庫存: ' + stock + ')');
        hasError = true;
        return;
      }

      // Deduct from matches using FIFO order (by id)
      matches.sort((a, b) => a.id - b.id);
      let usageLeft = qty;
      for (let i = 0; i < matches.length; i++) {
        const batch = matches[i];
        const deduct = Math.min(batch.remainingQty, usageLeft);
        if (deduct > 0) {
          usageRecords.push({
            id: generateId(),
            processId: processId,
            materialId: materialId,
            sterilizationRecordId: batch.id,
            qty: deduct,
            date: today,
          });
          usageLeft -= deduct;
        }
        if (usageLeft <= 0) break;
      }
    });

    if (hasError) return;

    saveData('usageRecords');
    showToast('已記錄 ' + usageSelectedIds.size + ' 項使用');
    usageSelectedIds.clear();
    renderUsageTiles();
    renderUsageHistory();
    updateUsageBatchInput();
  }

  function renderUsageHistory() {
    const container = document.getElementById('usage-history');
    if (!container) return;

    const processId = getSelectedProcessId('usage-process-select');
    if (!processId) {
      container.innerHTML = renderEmptyState('process', 'process');
      return;
    }

    // Material filter pills
    let filterHtml = '<div class="history-filter-scroll">';
    filterHtml += '<button class="hist-pill' + (usageHistoryFilter === 'all' ? ' active' : '') + '" data-id="all">全部</button>';
    materials.forEach(m => {
      const isActive = usageHistoryFilter === m.id;
      filterHtml += '<button class="hist-pill' + (isActive ? ' active' : '') + '" data-id="' + m.id + '">' + escapeHtml(m.name) + '</button>';
    });
    filterHtml += '</div>';

    const searchInput = document.getElementById('usage-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    const recs = usageRecords
      .filter(r => r.processId === processId)
      .filter(r => usageHistoryFilter === 'all' || r.materialId === usageHistoryFilter)
      .filter(r => {
        if (!searchVal) return true;
        const mat = materials.find(m => m.id === r.materialId);
        const nameMatch = mat ? mat.name.toLowerCase().includes(searchVal) : false;
        
        const rawDate = r.date.toLowerCase();
        const formattedDate = formatDate(r.date).toLowerCase();
        const cleanSearchVal = searchVal.replace(/[-/]/g, '');
        const cleanRawDate = rawDate.replace(/[-/]/g, '');
        
        const dateMatch = rawDate.includes(searchVal) || 
                          formattedDate.includes(searchVal) || 
                          cleanRawDate.includes(cleanSearchVal);
                          
        return nameMatch || dateMatch;
      })
      .sort((a, b) => {
        const comp = a.date.localeCompare(b.date);
        return (usageHistorySortOrder === 'desc' ? -1 : 1) * comp || (a.id - b.id);
      });

    let tableHtml = '';
    if (recs.length === 0) {
      tableHtml = renderEmptyState('usage', 'usage');
    } else {
      tableHtml = '<div class="history-table-container">' +
        '<table class="history-table">' +
        '<thead>' +
        '<tr>' +
        '<th class="sortable-usage-history-header" style="cursor:pointer; user-select:none;" title="點擊切換升降序">使用日期 ' + (usageHistorySortOrder === 'desc' ? '▼' : '▲') + '</th>' +
        '<th>物料名稱</th>' +
        '<th>使用數量</th>' +
        '<th>批次效期</th>' +
        '<th>操作</th>' +
        '</tr>' +
        '</thead>' +
        '<tbody>';
      
      recs.forEach(rec => {
        const mat = materials.find(m => m.id === rec.materialId);
        const matName = mat ? (renderIconHtml(mat.icon, '16px') + ' ' + escapeHtml(mat.name)) : '（已刪除）';
        
        const sterRec = sterilizationRecords.find(sr => sr.id === rec.sterilizationRecordId);
        let expiryText = '—';
        if (sterRec) {
          const days = getDaysRemaining(sterRec.expiryDate);
          if (days < 0) {
            expiryText = '已過期 (' + formatShortDate(sterRec.expiryDate) + ')';
          } else if (days === 0) {
            expiryText = '今天到期 (' + formatShortDate(sterRec.expiryDate) + ')';
          } else {
            expiryText = '剩' + days + '天 (' + formatShortDate(sterRec.expiryDate) + ')';
          }
        }

        tableHtml += '<tr>' +
          '<td>' + formatDate(rec.date) + '</td>' +
          '<td>' + matName + '</td>' +
          '<td>' + rec.qty + ' 個</td>' +
          '<td>' + expiryText + '</td>' +
          '<td><button class="btn-del-record" data-type="usage" data-id="' + rec.id + '" title="刪除">🗑️</button></td>' +
          '</tr>';
      });
      
      tableHtml += '</tbody></table></div>';
    }

    container.innerHTML = filterHtml + tableHtml;

    // Filter pill click
    container.querySelectorAll('.hist-pill').forEach(pill => {
      pill.addEventListener('click', function () {
        const id = this.getAttribute('data-id');
        usageHistoryFilter = id === 'all' ? 'all' : Number(id);
        renderUsageHistory();
      });
    });

    // Sort header click
    const sortHeader = container.querySelector('.sortable-usage-history-header');
    if (sortHeader) {
      sortHeader.addEventListener('click', function () {
        usageHistorySortOrder = (usageHistorySortOrder === 'desc') ? 'asc' : 'desc';
        renderUsageHistory();
      });
    }

    // Delete record click
    container.querySelectorAll('.btn-del-record[data-type="usage"]').forEach(btn => {
      btn.addEventListener('click', function () {
        const recId = Number(this.getAttribute('data-id'));
        showConfirm('確定刪除此使用紀錄？', function () {
          performCloudSyncAction(() => {
            usageRecords = usageRecords.filter(r => r.id !== recId);
          }, () => {
            showToast('紀錄已刪除');
            renderUsageTiles();
            renderUsageHistory();
            renderMaterialsList();
            renderDashboard();
          });
        });
      });
    });
  }

  // ─── Shared Helpers ─────────────────────────────────────────────────
  function populateProcessSelect(selectId, options = {}) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const defaultText = options.defaultText || '— 選擇製程批次 —';
    const defaultValue = options.defaultValue !== undefined ? options.defaultValue : '';
    const selectedId = options.selectedId !== undefined ? options.selectedId : currentProcessId;

    let html = '<option value="' + defaultValue + '"' + (selectedId === defaultValue ? ' selected' : '') + '>' + defaultText + '</option>';
    processes.filter(p => p.status !== 'finished').forEach(proc => {
      const isSelected = proc.id === selectedId;
      html += '<option value="' + proc.id + '"' + (isSelected ? ' selected' : '') + '>' +
        escapeHtml(proc.name) + ' (' + formatShortDate(proc.startDate) + ')' +
        '</option>';
    });
    select.innerHTML = html;
  }

  function getSelectedProcessId(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return null;
    const val = select.value;
    return val ? Number(val) : null;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Service Worker ─────────────────────────────────────────────────
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.log('SW registration failed:', err);
      });
    }
  }

  // ─── Settings & Synchronization ─────────────────────────────────────
  function initSettings() {
    // Open Settings Modal from any button in headers
    document.querySelectorAll('.btn-open-settings').forEach(btn => {
      btn.addEventListener('click', function () {
        const inputGas = document.getElementById('input-gas-url-modal');
        if (inputGas) {
          inputGas.value = gasUrl;
        }
        openModal('settings');
      });
    });

    // Reset System Button inside Settings Modal
    const btnReset = document.getElementById('btn-reset-system-modal');
    if (btnReset) {
      btnReset.addEventListener('click', function () {
        showConfirm('⚠️ 確定重置系統？所有製程、耗材和歷史紀錄將會被清空。', function () {
          localStorage.clear();
          showToast('系統已重置，網頁即將重新整理...');
          setTimeout(function () {
            location.reload();
          }, 1500);
        });
      });
    }

    // Force Reload / Cache Bust inside Settings Modal
    const btnReload = document.getElementById('btn-reload-app');
    if (btnReload) {
      btnReload.addEventListener('click', function () {
        showToast('正在清除快取並重新整理...');
        // Unregister SW
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(function (registrations) {
            for (let registration of registrations) {
              registration.unregister();
            }
          });
        }
        // Clear caches
        if ('caches' in window) {
          caches.keys().then(function (names) {
            for (let name of names) {
              caches.delete(name);
            }
          });
        }
        // Reload page
        setTimeout(function () {
          location.reload();
        }, 800);
      });
    }

    // Google Sheets URL bindings inside Settings Modal
    const inputGasUrl = document.getElementById('input-gas-url-modal');
    const btnSaveGasUrl = document.getElementById('btn-save-gas-url-modal');
    const btnManualSync = document.getElementById('btn-manual-sync-modal');
    const skipBtn = document.getElementById('btn-skip-sync');
    
    if (inputGasUrl) {
      inputGasUrl.value = gasUrl;
    }

    if (btnManualSync) {
      btnManualSync.addEventListener('click', function () {
        if (!gasUrl) {
          showToast('請先輸入並儲存雲端同步網址');
          return;
        }
        hasSyncedFromCloud = false;
        syncWithCloud();
      });
    }

    if (skipBtn) {
      skipBtn.addEventListener('click', function () {
        const overlay = document.getElementById('sync-loading-overlay');
        if (overlay) overlay.classList.add('hidden');
        hasSyncedFromCloud = true;
        showToast('已進入離線暫存模式');
      });
    }
    
    if (btnSaveGasUrl && inputGasUrl) {
      btnSaveGasUrl.addEventListener('click', function () {
        const urlVal = inputGasUrl.value.trim();
        gasUrl = urlVal;
        localStorage.setItem('cpi_gas_url', urlVal);
        showToast('已儲存雲端同步網址');
        hasSyncedFromCloud = false;
        syncWithCloud();
      });
    }
  }

  // ─── Initialization ─────────────────────────────────────────────────
  function init() {
    loadData();
    initTabs();
    initModals();
    initConfirm();
    initProcessActionModals();
    initFilterPills();
    initProcessForm();
    initMaterialForm();
    initIconPicker();
    initSterilizationPage();
    initUsagePage();
    initSettings();
    bindQtyAdjustButtons(document.getElementById('form-material'));

    renderProcessPills();
    renderDashboard();
    renderMaterialsList();
    renderSterilizationPage();
    renderUsagePage();

    // Restore active page or default to dashboard
    let activePage = null;
    try {
      activePage = localStorage.getItem('cpi_active_page');
    } catch (e) {}
    if (!activePage) activePage = 'dashboard';
    switchToPage(activePage);

    registerServiceWorker();

    // Trigger initial cloud sync
    syncWithCloud();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
