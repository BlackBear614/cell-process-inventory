(function () {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────
  const STORAGE_KEYS = {
    processes: 'cpi_processes',
    materials: 'cpi_materials',
    recipes: 'cpi_recipes',
    sterilizationRecords: 'cpi_sterilization_records',
    usageRecords: 'cpi_usage_records',
    currentProcessId: 'cpi_current_process_id',
  };

  const DEFAULT_MATERIALS = [
    { id: 1, name: '鐵架 (Iron Rack)', icon: '🏗️' },
    { id: 2, name: '培養皿 (Petri Dish)', icon: '🧫' },
    { id: 3, name: '離心管 15mL', icon: '🧪' },
    { id: 4, name: '離心管 50mL', icon: '🧪' },
    { id: 5, name: '細胞刮刀 (Cell Scraper)', icon: '🔬' },
    { id: 6, name: '培養瓶 T75', icon: '🧬' },
    { id: 7, name: '培養瓶 T175', icon: '🧬' },
    { id: 8, name: '凍存管 (Cryovial)', icon: '❄️' },
  ];

  const DEFAULT_RECIPES = [
    {
      id: 1,
      name: '預設製程 (Default)',
      requirements: [
        { materialId: 1, requiredQty: 2, processDay: 'D0' },
        { materialId: 2, requiredQty: 10, processDay: 'D0' },
        { materialId: 3, requiredQty: 20, processDay: 'D0' },
        { materialId: 4, requiredQty: 10, processDay: 'D3' },
        { materialId: 5, requiredQty: 5, processDay: 'D11' },
        { materialId: 6, requiredQty: 6, processDay: 'D0' },
        { materialId: 7, requiredQty: 4, processDay: 'D3' },
        { materialId: 8, requiredQty: 20, processDay: 'D14' },
      ]
    }
  ];

  const ICON_OPTIONS = ['🏗️', '🧫', '🧪', '🔬', '🧬', '❄️', '💉', '🩺', '🧴', '🧲', '📦', '🔩', '⚗️', '🩹', '🧯', '🪣'];

  // ─── State ───────────────────────────────────────────────────────────
  let processes = [];
  let materials = [];
  let recipes = [];
  let sterilizationRecords = [];
  let usageRecords = [];
  let currentProcessId = null;
  let activeAlternatives = {}; // Key: "processId_day_primaryMaterialId", Value: selectedMaterialId
  let gasUrl = '/api/sync';
  let isNotionConfigured = true;
  let isSyncing = false;
  let formMaterialContext = 'library'; // 'library' | 'recipe'

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

  let isInitialized = false;

  let lastGeneratedId = 0;
  function generateId() {
    let id = Date.now();
    if (id <= lastGeneratedId) {
      id = lastGeneratedId + 1;
    }
    lastGeneratedId = id;
    return id;
  }

  function cleanId(val) {
    if (val === undefined || val === null || val === '') return '';
    return isNaN(val) ? String(val) : Number(val);
  }

  function findRecipe(id) {
    return recipes.find(r => cleanId(r.id) === cleanId(id));
  }
  function findMaterial(id) {
    return materials.find(m => cleanId(m.id) === cleanId(id));
  }
  function findProcess(id) {
    return processes.find(p => cleanId(p.id) === cleanId(id));
  }

  function updateLocalIds(mappings) {
    const mapId = (id) => cleanId(mappings[id] || id);
    processes.forEach(p => {
      p.id = mapId(p.id);
      p.recipeId = mapId(p.recipeId);
    });
    materials.forEach(m => {
      m.id = mapId(m.id);
    });
    recipes.forEach(r => {
      r.id = mapId(r.id);
      if (r.requirements) {
        r.requirements.forEach(req => {
          req.materialId = mapId(req.materialId);
        });
      }
    });
    sterilizationRecords.forEach(s => {
      s.id = mapId(s.id);
      s.processId = mapId(s.processId);
      s.materialId = mapId(s.materialId);
    });
    usageRecords.forEach(u => {
      u.id = mapId(u.id);
      u.processId = mapId(u.processId);
      u.materialId = mapId(u.materialId);
      if (u.sterilizationRecordId !== 'FIFO') {
        u.sterilizationRecordId = mapId(u.sterilizationRecordId);
      }
    });
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
    const offset = parseInt(processDay.substring(1), 10);
    if (isNaN(offset)) return null;
    return addDays(process.startDate, offset);
  }

  function getRecipeProcessDays(recipe) {
    if (!recipe || !recipe.requirements) return ['D0', 'D3', 'D11', 'D14'];
    const days = new Set();
    recipe.requirements.forEach(req => {
      if (req.processDay) days.add(req.processDay);
    });
    const daysList = Array.from(days);
    daysList.sort((a, b) => {
      const offsetA = parseInt(a.substring(1), 10) || 0;
      const offsetB = parseInt(b.substring(1), 10) || 0;
      return offsetA - offsetB;
    });
    return daysList.length > 0 ? daysList : ['D0', 'D3', 'D11', 'D14'];
  }

  function getProcessDayMaterials(processId, dayLabel) {
    const proc = findProcess(processId);
    if (!proc) return [];
    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    if (!recipe || !recipe.requirements) return [];
    
    const reqs = recipe.requirements.filter(r => r.processDay === dayLabel);
    return reqs.map(r => {
      const mat = findMaterial(r.materialId);
      if (!mat) return null;
      return {
        id: mat.id,
        name: mat.name,
        icon: mat.icon,
        requiredQty: r.requiredQty,
        processDay: r.processDay,
        alternatives: r.alternatives || []
      };
    }).filter(Boolean);
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

  function getMaterialStatus(mat, processId) {
    const proc = findProcess(processId);
    if (!proc) return { status: 'danger', requiredQty: 0, processDay: '' };
    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    if (!recipe || !recipe.requirements) return { status: 'danger', requiredQty: 0, processDay: '' };

    const req = recipe.requirements.find(r => cleanId(r.materialId) === cleanId(mat.id));
    if (!req) return { status: 'ok', requiredQty: 0, processDay: '' };

    const stock = getStock(mat.id, processId);
    let status = 'ok';
    if (stock === 0) status = 'danger';
    else if (stock < req.requiredQty) status = 'warn';

    let alternativeAvailable = false;
    if (status !== 'ok' && req.alternatives && req.alternatives.length > 0) {
      for (const alt of req.alternatives) {
        const altStock = getStock(alt.materialId, processId);
        if (altStock >= alt.requiredQty) {
          alternativeAvailable = true;
          break;
        }
      }
      if (alternativeAvailable) {
        status = 'warn';
      }
    }

    return { 
      status, 
      requiredQty: req.requiredQty, 
      processDay: req.processDay, 
      stock,
      alternatives: req.alternatives || [],
      alternativeAvailable
    };
  }

  function getMaterialBatches(materialId, processId, includeOthers = true) {
    const sterRecs = sterilizationRecords.filter(r => (includeOthers || cleanId(r.processId) === cleanId(processId)) && cleanId(r.materialId) === cleanId(materialId));
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
    const useRecs = usageRecords.filter(r => cleanId(r.materialId) === cleanId(materialId) && r.sterilizationRecordId && batchIds.has(r.sterilizationRecordId));

    useRecs.forEach(u => {
      const batch = batches.find(b => cleanId(b.id) === cleanId(u.sterilizationRecordId));
      if (batch) {
        batch.remainingQty = Math.max(0, batch.remainingQty - u.qty);
      }
    });

    const fifoUseRecs = usageRecords.filter(r => cleanId(r.materialId) === cleanId(materialId) && !r.sterilizationRecordId);
    const processesWithLoadedBatches = new Set(batches.map(b => b.processId));

    processesWithLoadedBatches.forEach(pId => {
      const pUseRecs = fifoUseRecs.filter(r => cleanId(r.processId) === cleanId(pId));
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
    const proc = findProcess(processId);
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
    
    // Load Materials Library
    materials = stored(STORAGE_KEYS.materials);
    if (!materials || materials.length === 0) {
      materials = JSON.parse(JSON.stringify(DEFAULT_MATERIALS));
      saveData('materials');
    }

    // Load Recipes Config
    recipes = stored(STORAGE_KEYS.recipes);
    if (!recipes || recipes.length === 0) {
      recipes = JSON.parse(JSON.stringify(DEFAULT_RECIPES));
      saveData('recipes');
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
    
    // Load Notion sync URL
    gasUrl = '/api/sync';
  }

  function saveData(what) {
    if (what !== 'skipCloud') {
      if (!what || what === 'processes') localStorage.setItem(STORAGE_KEYS.processes, JSON.stringify(processes));
      if (!what || what === 'materials') localStorage.setItem(STORAGE_KEYS.materials, JSON.stringify(materials));
      if (!what || what === 'recipes') localStorage.setItem(STORAGE_KEYS.recipes, JSON.stringify(recipes));
      if (!what || what === 'sterilizationRecords') localStorage.setItem(STORAGE_KEYS.sterilizationRecords, JSON.stringify(sterilizationRecords));
      if (!what || what === 'usageRecords') localStorage.setItem(STORAGE_KEYS.usageRecords, JSON.stringify(usageRecords));
      if (!what || what === 'currentProcessId') localStorage.setItem(STORAGE_KEYS.currentProcessId, JSON.stringify(currentProcessId));
      
      pushToCloud();
    } else {
      localStorage.setItem(STORAGE_KEYS.processes, JSON.stringify(processes));
      localStorage.setItem(STORAGE_KEYS.materials, JSON.stringify(materials));
      localStorage.setItem(STORAGE_KEYS.recipes, JSON.stringify(recipes));
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
    if (isSyncing) return;
    isSyncing = true;
    updateSyncStatus('正在從 Notion 載入資料...');

    // Show sync loading overlay
    const overlay = document.getElementById('sync-loading-overlay');
    const overlayText = document.getElementById('sync-loading-text');
    const skipBtn = document.getElementById('btn-skip-sync');
    
    if (overlay && !hasSyncedFromCloud) {
      overlay.classList.remove('hidden');
      if (overlayText) overlayText.textContent = 'Notion 資料同步中，請稍候...';
      if (skipBtn) {
        skipBtn.style.display = 'none';
        setTimeout(() => {
          if (!hasSyncedFromCloud) {
            skipBtn.style.display = 'block';
          }
        }, 4000);
      }
    }

    const syncUrl = gasUrl + (gasUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();

    fetch(syncUrl)
      .then(res => res.json())
      .then(data => {
        if (data && data.success === false && data.error === 'NOTION_NOT_CONFIGURED') {
          isNotionConfigured = false;
          updateSyncStatus('未連接 Notion (僅使用本機儲存)');
          hasSyncedFromCloud = true;
          if (overlay) overlay.classList.add('hidden');
          return;
        }

        if (data && data.materials) {
          isNotionConfigured = true;
          processes = data.processes || [];
          materials = data.materials || [];
          recipes = data.recipes || [];
          sterilizationRecords = data.sterilizationRecords || [];
          usageRecords = data.usageRecords || [];
          if (data.currentProcessId !== undefined) {
            currentProcessId = data.currentProcessId;
          }
          
          saveData('skipCloud');
          
          populateRecipeDropdowns();
          renderProcessPills();
          renderDashboard();
          renderMaterialsList();
          renderSterilizationPage();
          renderUsagePage();
          
          updateSyncStatus('已完成 Notion 資料同步', 'success');
          
          hasSyncedFromCloud = true;
          if (overlay) overlay.classList.add('hidden');
        } else {
          updateSyncStatus('同步錯誤：資料格式不符', 'error');
          if (overlay) overlay.classList.add('hidden');
        }
      })
      .catch(err => {
        console.error('Fetch sync error:', err);
        updateSyncStatus('連線失敗，使用本機暫存資料', 'error');
        if (overlay) {
          if (overlayText) overlayText.textContent = '無法連線至 Notion，已切換至離線暫存模式。';
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
    if (!isNotionConfigured) return;
    if (!hasSyncedFromCloud) {
      console.log('Skipping cloud push: initial sync is not complete yet.');
      return;
    }
    updateSyncStatus('同步至 Notion 中...');

    const payload = {
      action: 'sync',
      data: {
        processes: processes,
        materials: materials,
        recipes: recipes,
        sterilizationRecords: sterilizationRecords,
        usageRecords: usageRecords,
        currentProcessId: currentProcessId
      }
    };
    
    fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(resData => {
        if (resData && resData.success !== false) {
          updateSyncStatus('已同步至 Notion', 'success');
          // If server returned ID mappings
          if (resData.idMappings && Object.keys(resData.idMappings).length > 0) {
            console.log('Applying server ID mappings:', resData.idMappings);
            updateLocalIds(resData.idMappings);
            if (resData.currentProcessId) {
              currentProcessId = resData.currentProcessId;
            }
            saveData('skipCloud');
            renderAll();
          }
        } else {
          updateSyncStatus('同步失敗: ' + (resData ? resData.error : '未知錯誤'), 'error');
        }
      })
      .catch(err => {
        console.error('Push sync error:', err);
        updateSyncStatus('同步失敗 (連線錯誤)', 'error');
      });
  }

  let isCloudSyncActionRunning = false;

  function performCloudSyncAction(actionCallback, afterCallback) {
    if (isCloudSyncActionRunning) {
      console.warn('Sync action already running, ignoring duplicate call.');
      return;
    }
    isCloudSyncActionRunning = true;

    if (!isNotionConfigured) {
      actionCallback();
      saveData('skipCloud');
      isCloudSyncActionRunning = false;
      if (afterCallback) afterCallback();
      return;
    }

    const overlay = document.getElementById('sync-loading-overlay');
    const overlayText = document.getElementById('sync-loading-text');
    if (overlay) {
      if (overlayText) overlayText.textContent = '正在與 Notion 同步最新資料...';
      overlay.classList.remove('hidden');
    }

    const syncUrl = gasUrl + (gasUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    fetch(syncUrl)
      .then(res => res.json())
      .then(data => {
        if (data && data.success === false && data.error === 'NOTION_NOT_CONFIGURED') {
          isNotionConfigured = false;
          updateSyncStatus('未連接 Notion (僅使用本機儲存)');
          actionCallback();
          saveData('skipCloud');
          isCloudSyncActionRunning = false;
          if (overlay) overlay.classList.add('hidden');
          if (afterCallback) afterCallback();
          return;
        }

        if (data && data.materials) {
          isNotionConfigured = true;
          processes = data.processes || [];
          materials = data.materials || [];
          recipes = data.recipes || [];
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
        
        updateSyncStatus('已同步至 Notion', 'success');
        
        const timeEl = document.getElementById('sync-time-modal');
        if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();

        isCloudSyncActionRunning = false;
        if (afterCallback) afterCallback();
      })
      .catch(err => {
        console.error('Action cloud sync error:', err);
        showToast('無法同步 Notion，已以離線模式儲存於本機');
        
        actionCallback();
        saveData('skipCloud');
        
        isCloudSyncActionRunning = false;
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
    if (el) {
      el.classList.add('active');
      if (id === 'modal-material' || id === 'modal-recipe-edit') {
        el.style.zIndex = '300';
      } else if (id === 'modal-confirm') {
        el.style.zIndex = '400';
      }
    }
  }

  function closeModal(name) {
    const id = name.startsWith('modal-') ? name : 'modal-' + name;
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove('active');
      if (id === 'modal-material' || id === 'modal-recipe-edit' || id === 'modal-confirm') {
        el.style.zIndex = '';
      }
    }
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
    const recipeSelect = document.getElementById('input-process-recipe');

    if (btnAdd) {
      btnAdd.addEventListener('click', function () {
        populateRecipeDropdowns();
        document.getElementById('modal-process-title').textContent = '新增製程批次';
        document.getElementById('input-process-name').value = '';
        document.getElementById('input-process-date').value = todayISO();
        document.getElementById('input-process-id').value = '';
        if (recipeSelect) recipeSelect.value = '1'; // Default recipe
        updateProcessDatePreview(todayISO());
        openModal('process');
      });
    }

    if (btnEdit) {
      btnEdit.addEventListener('click', function () {
        const proc = findProcess(currentProcessId);
        if (!proc) {
          showToast('請先選擇製程批次');
          return;
        }
        populateRecipeDropdowns();
        document.getElementById('modal-process-title').textContent = '編輯製程批次';
        document.getElementById('input-process-name').value = proc.name;
        document.getElementById('input-process-date').value = proc.startDate;
        document.getElementById('input-process-id').value = proc.id;
        if (recipeSelect) recipeSelect.value = proc.recipeId || 1;
        updateProcessDatePreview(proc.startDate);
        openModal('process');
      });
    }

    if (dateInput) {
      dateInput.addEventListener('change', function () {
        updateProcessDatePreview(this.value);
      });
    }

    if (recipeSelect) {
      recipeSelect.addEventListener('change', function () {
        if (dateInput) {
          updateProcessDatePreview(dateInput.value);
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('input-process-name').value.trim();
        const startDate = document.getElementById('input-process-date').value;
        const editId = document.getElementById('input-process-id').value;
        const rId = recipeSelect ? cleanId(recipeSelect.value) : 1;

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
            const idx = processes.findIndex(p => cleanId(p.id) === cleanId(editId));
            if (idx !== -1) {
              processes[idx].name = name;
              processes[idx].startDate = startDate;
              processes[idx].recipeId = rId;
            }
          } else {
            // Add new
            const proc = { id: generateId(), name: name, startDate: startDate, recipeId: rId };
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
    const recipeSelect = document.getElementById('input-process-recipe');
    const rId = recipeSelect ? cleanId(recipeSelect.value) : 1;
    const recipe = recipes.find(r => cleanId(r.id) === cleanId(rId)) || DEFAULT_RECIPES[0];
    const procDays = getRecipeProcessDays(recipe);

    const previewDaysContainer = document.getElementById('preview-days');
    if (previewDaysContainer) {
      let previewHtml = '';
      procDays.forEach(day => {
        const offset = parseInt(day.substring(1), 10) || 0;
        const actual = addDays(dateStr, offset);
        previewHtml += `<div class="day-badge small"><span class="day-label">${day}</span><span class="day-date">${formatShortDate(actual)}</span></div>`;
      });
      previewDaysContainer.innerHTML = previewHtml;
    }
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
        const id = cleanId(this.getAttribute('data-id'));
        targetProcessId = id;
        
        const proc = findProcess(id);
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
    const proc = findProcess(currentProcessId);

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

    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    const procDays = getRecipeProcessDays(recipe);

    // Dynamic process days rendering
    const processDays = document.getElementById('process-days');
    if (processDays) {
      let daysHtml = '';
      const today = todayISO();
      procDays.forEach(day => {
        const dayDate = getProcessDayDate(day, proc);
        const isToday = dayDate === today;
        daysHtml += `<div class="day-badge ${isToday ? 'today' : ''}" data-day="${day}">` +
          `<span class="day-label">${day}</span>` +
          `<span class="day-date">${formatShortDate(dayDate)}</span>` +
          `</div>`;
      });
      processDays.innerHTML = daysHtml;
    }

    // Dynamic filter pills rendering
    const filterPillsContainer = document.getElementById('filter-pills');
    if (filterPillsContainer) {
      let pillsHtml = `<button class="pill ${dashboardFilter === 'all' ? 'active' : ''}" data-filter="all">全部</button>`;
      procDays.forEach(day => {
        pillsHtml += `<button class="pill ${dashboardFilter === day ? 'active' : ''}" data-filter="${day}">${day}</button>`;
      });
      filterPillsContainer.innerHTML = pillsHtml;
      
      // Bind click events
      filterPillsContainer.querySelectorAll('.pill').forEach(btn => {
        btn.addEventListener('click', function () {
          filterPillsContainer.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
          this.classList.add('active');
          dashboardFilter = this.getAttribute('data-filter');
          renderDashboardMaterials();
        });
      });
    }

    renderDashboardMaterials();
  }

  function renderDashboardMaterials() {
    const container = document.getElementById('dashboard-materials');
    if (!container) return;

    const proc = findProcess(currentProcessId);
    if (!proc) {
      container.innerHTML = renderEmptyState('process', 'process');
      return;
    }

    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    const procDays = getRecipeProcessDays(recipe);

    let statTotal = 0, statOk = 0, statWarn = 0, statDanger = 0;
    const filteredMaterials = [];

    materials.forEach(mat => {
      const info = getMaterialStatus(mat, currentProcessId);
      if (info.requiredQty === 0) return; // Skip materials not configured in the recipe
      
      statTotal++;
      if (info.status === 'ok') statOk++;
      else if (info.status === 'warn') statWarn++;
      else if (info.status === 'danger') statDanger++;

      // Filter
      if (dashboardFilter !== 'all' && info.processDay !== dashboardFilter) return;
      
      const enrichedMat = {
        ...mat,
        requiredQty: info.requiredQty,
        processDay: info.processDay
      };
      filteredMaterials.push({ mat: enrichedMat, info });
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
    procDays.forEach(day => { groups[day] = []; });
    filteredMaterials.forEach(item => {
      const day = item.mat.processDay;
      if (!groups[day]) groups[day] = [];
      groups[day].push(item);
    });

    let html = '';
    procDays.forEach(day => {
      const items = groups[day];
      if (!items || items.length === 0) return;
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

        let alternativesHtml = '';
        if (info.alternatives && info.alternatives.length > 0) {
          alternativesHtml = '<div class="tile-alts-panel" style="margin-top: 8px; font-size: 11px; opacity: 0.85; border-top: 1px dashed rgba(255,255,255,0.08); padding-top: 6px; width: 100%; box-sizing: border-box;">';
          alternativesHtml += '<div style="font-weight: 600; margin-bottom: 4px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">🔄 可替代方案：</div>';
          info.alternatives.forEach(alt => {
            const altMat = findMaterial(alt.materialId);
            if (altMat) {
              const altStock = getStock(alt.materialId, currentProcessId);
              const isStockOk = altStock >= alt.requiredQty;
              const statusDot = isStockOk ? '🟢' : '🔴';
              const noteText = alt.note ? ` (${alt.note})` : '';
              alternativesHtml += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px;">` +
                `<span style="display: flex; align-items: center; gap: 2px;">${statusDot} ${altMat.icon} ${escapeHtml(altMat.name)}${escapeHtml(noteText)}</span>` +
                `<span>需求: ${alt.requiredQty} | 庫存: ${altStock}</span>` +
                `</div>`;
            }
          });
          alternativesHtml += '</div>';
        }

        html += '<div class="material-tile status-' + info.status + '" data-id="' + mat.id + '">' +
          '<div class="tile-status-dot ' + info.status + '"></div>' +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          '<div class="tile-name">' + escapeHtml(mat.name) + '</div>' +
          '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 庫存: ' + info.stock + '</div>' +
          '<div class="tile-days-left ' + daysLeftClass + '">' + daysLeftText + '</div>' +
          alternativesHtml +
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
      const altsPanel = tile.querySelector('.tile-alts-panel');
      if (altsPanel) {
        altsPanel.addEventListener('click', function (e) {
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
        currentInventoryProcessId = val === 'all' ? 'all' : cleanId(val);
        renderMaterialsList();
      });
    }

    const btnAdd = document.getElementById('btn-add-material');
    const form = document.getElementById('form-material');
    const fileInput = document.getElementById('input-material-file-icon');
    const filePreview = document.getElementById('material-file-preview');
    const imgPreview = document.getElementById('img-file-preview');
    const btnClearFile = document.getElementById('btn-clear-file-icon');
    const iconInput = document.getElementById('input-material-icon');
    const urlIconInput = document.getElementById('input-material-url-icon');

    if (btnAdd) {
      btnAdd.addEventListener('click', function () {
        document.getElementById('modal-material-title').textContent = '新增物料';
        document.getElementById('input-material-name').value = '';
        document.getElementById('input-material-icon').value = '📦';
        if (urlIconInput) urlIconInput.value = '';
        document.getElementById('input-material-id').value = '';
        
        // Hide quantity and day configs since they are recipe-dependent
        const formRow = document.querySelector('#form-material .form-row');
        if (formRow) formRow.style.display = 'none';
        
        // Reset file upload
        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.style.display = 'none';
        if (imgPreview) imgPreview.src = '';
        
        formMaterialContext = 'library';
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

          if (urlIconInput) {
            urlIconInput.value = '';
          }
        });
      });
    }

    if (urlIconInput) {
      urlIconInput.addEventListener('input', function () {
        const val = this.value.trim();
        if (val) {
          if (iconInput) iconInput.value = val;
          // Clear file upload
          if (fileInput) fileInput.value = '';
          if (filePreview) filePreview.style.display = 'none';
          if (imgPreview) imgPreview.src = '';
        } else {
          if (iconInput) iconInput.value = '📦';
        }
      });
    }

    if (btnClearFile) {
      btnClearFile.addEventListener('click', function () {
        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.style.display = 'none';
        if (imgPreview) imgPreview.src = '';
        if (iconInput) iconInput.value = '📦';
        if (urlIconInput) {
          urlIconInput.value = '';
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('input-material-name').value.trim();
        const icon = document.getElementById('input-material-icon').value || '📦';
        const editId = document.getElementById('input-material-id').value;

        if (!name) {
          showToast('請輸入品項名稱');
          return;
        }

        performCloudSyncAction(() => {
          if (editId) {
            const idx = materials.findIndex(m => cleanId(m.id) === cleanId(editId));
            if (idx !== -1) {
              materials[idx].name = name;
              materials[idx].icon = icon;
            }
          } else {
            materials.push({ id: generateId(), name, icon });
          }
        }, () => {
          closeModal('material');
          showToast(editId ? '物料已更新' : '物料已新增');
          if (formMaterialContext === 'library') {
            renderMaterialLibrary();
          }
          renderMaterialsList();
          renderDashboard();
          renderSterilizationHistory();
          renderUsageHistory();
        });
      });
    }
  }

  function initIconPicker() {
    // Left empty since emoji picker was removed
  }

  function editMaterial(id) {
    const mat = findMaterial(id);
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
    const urlIconInput = document.getElementById('input-material-url-icon');

    if (fileInput) fileInput.value = '';

    const isDataOrBlob = mat.icon && (mat.icon.startsWith('data:image/') || mat.icon.startsWith('blob:'));
    const isUrl = mat.icon && (mat.icon.startsWith('http://') || mat.icon.startsWith('https://'));

    if (isDataOrBlob) {
      if (urlIconInput) urlIconInput.value = '';
      if (filePreview) filePreview.style.display = 'flex';
      if (imgPreview) imgPreview.src = mat.icon;
    } else if (isUrl) {
      if (urlIconInput) urlIconInput.value = mat.icon;
      if (filePreview) filePreview.style.display = 'none';
      if (imgPreview) imgPreview.src = '';
    } else {
      if (urlIconInput) urlIconInput.value = mat.icon || '';
      if (filePreview) filePreview.style.display = 'none';
      if (imgPreview) imgPreview.src = '';
    }

    openModal('material');
  }

  function deleteMaterial(id) {
    const mat = findMaterial(id);
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

    // Group by processDay based on active process and recipe configuration
    const groups = {};
    let procDays = [];

    if (currentInventoryProcessId !== 'all') {
      const proc = findProcess(currentInventoryProcessId);
      const recipe = proc ? (findRecipe(proc.recipeId) || DEFAULT_RECIPES[0]) : null;
      if (recipe) {
        procDays = getRecipeProcessDays(recipe);
        procDays.forEach(day => { groups[day] = []; });
        recipe.requirements.forEach(req => {
          const mat = findMaterial(req.materialId);
          if (!mat) return;
          const enrichedMat = {
            ...mat,
            requiredQty: req.requiredQty,
            processDay: req.processDay
          };
          if (!groups[req.processDay]) groups[req.processDay] = [];
          groups[req.processDay].push(enrichedMat);
        });
      } else {
        procDays = ['所有物料品項'];
        groups['所有物料品項'] = materials.map(mat => ({ ...mat, requiredQty: 0, processDay: 'all' }));
      }
    } else {
      procDays = ['所有物料品項'];
      groups['所有物料品項'] = materials.map(mat => ({ ...mat, requiredQty: 0, processDay: 'all' }));
    }

    let html = '';
    procDays.forEach(day => {
      const items = groups[day];
      if (!items || items.length === 0) return;
      
      let tilesHtml = '';
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
          if (mat.requiredQty > 0) {
            stockText = '需求: ' + mat.requiredQty + ' ｜ ' + stockText;
            if (validStock < mat.requiredQty) {
              stockText += ' ｜ <span style="color: var(--danger); font-weight: 600;">不足</span>';
            }
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

        let tagHtml = '';
        if (validStock > 0) {
          if (currentInventoryProcessId !== 'all' && mat.requiredQty > 0 && validStock < mat.requiredQty) {
            tagHtml = `<span class="notion-tag yellow">🟡 庫存不足 (${validStock}/${mat.requiredQty})</span>`;
          } else {
            tagHtml = `<span class="notion-tag green">🟢 已滅菌 (${validStock})</span>`;
          }
        } else {
          tagHtml = '<span class="notion-tag red">🔴 尚未滅菌</span>';
        }

        const badgeHtml = `<div style="position: absolute; top: 12px; right: 12px;">${tagHtml}</div>`;

        let detailPanelHtml = '';
        let expandedClass = '';
        if (activeBatches.length > 0) {
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

        tilesHtml += '<div class="material-tile' + expandedClass + '" data-id="' + mat.id + '" style="position: relative; padding-top: 16px;">' +
          badgeHtml +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          '<div class="tile-name" style="margin-top: 8px;">' + escapeHtml(mat.name) + '</div>' +
          '<div class="tile-stock">' + stockText + '</div>' +
          detailPanelHtml +
          '</div>';
      });

      if (tilesHtml !== '') {
        html += '<div class="tile-group">';
        html += '<div class="tile-group-header">' + day + '</div>';
        html += '<div class="tile-group-grid">';
        html += tilesHtml;
        html += '</div></div>';
      }
    });

    if (html === '') {
      container.innerHTML = renderEmptyState('material', 'material');
      return;
    }

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

    if (processSelect) {
      processSelect.addEventListener('change', function () {
        const processId = getSelectedProcessId('ster-process-select');
        currentProcessId = processId;
        saveData('currentProcessId');
        
        // Sync other selectors
        const usageSelect = document.getElementById('usage-process-select');
        if (usageSelect) usageSelect.value = processId || '';
        renderProcessPills();
        
        // Clear selected items (user will manually click to select)
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
    const proc = findProcess(processId);
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
      const mat = findMaterial(rec.materialId);
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
    const proc = findProcess(processId);

    if (!proc || materials.length === 0) {
      container.innerHTML = renderEmptyState(proc ? 'material' : 'process', proc ? 'material' : 'process');
      return;
    }

    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    const procDays = getRecipeProcessDays(recipe);

    const searchInput = document.getElementById('ster-mat-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Group materials by processDay based on recipe requirements
    const groups = {};
    procDays.forEach(day => { groups[day] = []; });
    recipe.requirements.forEach(req => {
      const activeMaterialId = activeAlternatives[`${processId}_${req.processDay}_${req.materialId}`] || req.materialId;
      let activeRequiredQty = req.requiredQty;
      if (activeMaterialId !== req.materialId) {
        const alt = (req.alternatives || []).find(a => a.materialId === activeMaterialId);
        if (alt) {
          activeRequiredQty = alt.requiredQty;
        }
      }

      const mat = findMaterial(activeMaterialId);
      if (!mat) return;
      if (searchVal && !mat.name.toLowerCase().includes(searchVal)) return;

      const enrichedMat = {
        ...mat,
        requiredQty: activeRequiredQty,
        processDay: req.processDay,
        primaryMaterialId: req.materialId,
        alternatives: req.alternatives || []
      };
      if (!groups[req.processDay]) groups[req.processDay] = [];
      groups[req.processDay].push(enrichedMat);
    });

    let html = '';
    procDays.forEach(day => {
      const items = groups[day];
      if (!items || items.length === 0) return;
      const dayDate = getProcessDayDate(day, proc);
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + ' — ' + formatShortDate(dayDate) + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(mat => {
        const isSelected = sterSelectedIds.has(mat.id);
        const stock = getStock(mat.id, processId);
        const deficit = mat.requiredQty - stock;
        
        let tagHtml = '';
        let defaultQty = mat.requiredQty;
        
        if (deficit <= 0) {
          tagHtml = '<span class="notion-tag green" style="font-size: 10px; padding: 2px 6px;">已補足</span>';
          defaultQty = mat.requiredQty;
        } else {
          tagHtml = `<span class="notion-tag yellow" style="font-size: 10px; padding: 2px 6px;">待補: ${deficit}</span>`;
          defaultQty = deficit;
        }

        let nameHtml = '';
        if (mat.alternatives && mat.alternatives.length > 0) {
          const primaryMat = findMaterial(mat.primaryMaterialId);
          const primaryReq = recipe.requirements.find(r => r.materialId === mat.primaryMaterialId && r.processDay === day);
          const primaryQty = primaryReq ? primaryReq.requiredQty : mat.requiredQty;
          
          let selectOptions = `<option value="${mat.primaryMaterialId}" data-qty="${primaryQty}" ${mat.id === mat.primaryMaterialId ? 'selected' : ''}>${primaryMat.icon} ${escapeHtml(primaryMat.name)} (主要, 需求: ${primaryQty})</option>`;
          mat.alternatives.forEach((alt, idx) => {
            const altMat = findMaterial(alt.materialId);
            if (altMat) {
              const noteText = alt.note ? ` - ${alt.note}` : '';
              selectOptions += `<option value="${alt.materialId}" data-qty="${alt.requiredQty}" ${mat.id === alt.materialId ? 'selected' : ''}>${altMat.icon} ${escapeHtml(altMat.name)} (備選 ${idx + 1}, 需求: ${alt.requiredQty}${noteText})</option>`;
            }
          });
          
          nameHtml = `<div class="tile-name-select-wrap" style="margin-top: 8px; width: 100%;">` +
            `<select class="tile-item-select" data-day="${day}" data-primary-id="${mat.primaryMaterialId}" data-previous-id="${mat.id}" style="width: 100%; padding: 6px 20px 6px 8px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: var(--text-primary); font-size: 11px; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; appearance: none; -webkit-appearance: none; background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2214%22%20height%3D%2214%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255,255,255,0.6)%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%20%2F%3E%3C%2F%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;">` +
            selectOptions +
            `</select>` +
            `</div>`;
        } else {
          nameHtml = '<div class="tile-name" style="margin-top: 8px;">' + escapeHtml(mat.name) + '</div>';
        }

        html += '<div class="material-tile' + (isSelected ? ' selected' : '') + '" data-id="' + mat.id + '" style="position: relative;">' +
          '<div class="tile-check"></div>' +
          '<div style="position: absolute; top: 8px; right: 8px;">' + tagHtml + '</div>' +
          '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
          nameHtml +
          '<div class="tile-stock">需求: ' + mat.requiredQty + ' ｜ 庫存: ' + stock + '</div>' +
          '<div class="tile-qty-container">' +
          '<span class="tile-qty-label">數量</span>' +
          '<div class="qty-adjust-wrap">' +
          '<button type="button" class="btn-qty-adj btn-dec">-</button>' +
          '<input type="number" class="tile-qty-input" min="1" value="' + defaultQty + '" data-id="' + mat.id + '">' +
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
        // Don't toggle if clicking input or its wrapper/label or the item select dropdown
        if (e.target.closest('.tile-qty-container') || e.target.closest('.tile-name-select-wrap')) return;
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

    // Item select change (alternatives)
    container.querySelectorAll('.tile-item-select').forEach(select => {
      select.addEventListener('click', function (e) { e.stopPropagation(); });
      select.addEventListener('change', function () {
        const primaryId = Number(this.getAttribute('data-primary-id'));
        const previousId = Number(this.getAttribute('data-previous-id'));
        const newId = Number(this.value);
        const day = this.getAttribute('data-day');

        activeAlternatives[`${processId}_${day}_${primaryId}`] = newId;

        if (sterSelectedIds.has(previousId)) {
          sterSelectedIds.delete(previousId);
          sterSelectedIds.add(newId);
        }

        renderSterilizationTiles();
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
      countEl.textContent = sterSelectedIds.size;
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
        const mat = findMaterial(r.materialId);
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
        const mat = findMaterial(rec.materialId);
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
    const proc = findProcess(processId);

    if (!proc || materials.length === 0) {
      container.innerHTML = renderEmptyState(proc ? 'material' : 'process', proc ? 'material' : 'process');
      return;
    }

    const recipe = findRecipe(proc.recipeId) || DEFAULT_RECIPES[0];
    const procDays = getRecipeProcessDays(recipe);

    const searchInput = document.getElementById('usage-mat-search-input');
    const searchVal = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Group materials by processDay based on recipe requirements
    const groups = {};
    procDays.forEach(day => { groups[day] = []; });
    recipe.requirements.forEach(req => {
      const activeMaterialId = activeAlternatives[`${processId}_${req.processDay}_${req.materialId}`] || req.materialId;
      let activeRequiredQty = req.requiredQty;
      if (activeMaterialId !== req.materialId) {
        const alt = (req.alternatives || []).find(a => a.materialId === activeMaterialId);
        if (alt) {
          activeRequiredQty = alt.requiredQty;
        }
      }

      const mat = findMaterial(activeMaterialId);
      if (!mat) return;
      if (searchVal && !mat.name.toLowerCase().includes(searchVal)) return;

      const enrichedMat = {
        ...mat,
        requiredQty: activeRequiredQty,
        processDay: req.processDay,
        primaryMaterialId: req.materialId,
        alternatives: req.alternatives || []
      };
      if (!groups[req.processDay]) groups[req.processDay] = [];
      groups[req.processDay].push(enrichedMat);
    });

    let html = '';
    procDays.forEach(day => {
      const items = groups[day];
      if (!items || items.length === 0) return;
      const dayDate = getProcessDayDate(day, proc);
      html += '<div class="tile-group">';
      html += '<div class="tile-group-header">' + day + ' — ' + formatShortDate(dayDate) + '</div>';
      html += '<div class="tile-group-grid">';
      items.forEach(mat => {
        const batches = getMaterialBatches(mat.id, processId, true);
        const totalStock = batches.reduce((sum, b) => sum + b.remainingQty, 0);

        let nameHtml = '';
        if (mat.alternatives && mat.alternatives.length > 0) {
          const primaryMat = findMaterial(mat.primaryMaterialId);
          const primaryReq = recipe.requirements.find(r => r.materialId === mat.primaryMaterialId && r.processDay === day);
          const primaryQty = primaryReq ? primaryReq.requiredQty : mat.requiredQty;
          
          let selectOptions = `<option value="${mat.primaryMaterialId}" data-qty="${primaryQty}" ${mat.id === mat.primaryMaterialId ? 'selected' : ''}>${primaryMat.icon} ${escapeHtml(primaryMat.name)} (主要, 需求: ${primaryQty})</option>`;
          mat.alternatives.forEach((alt, idx) => {
            const altMat = findMaterial(alt.materialId);
            if (altMat) {
              const noteText = alt.note ? ` - ${alt.note}` : '';
              selectOptions += `<option value="${alt.materialId}" data-qty="${alt.requiredQty}" ${mat.id === alt.materialId ? 'selected' : ''}>${altMat.icon} ${escapeHtml(altMat.name)} (備選 ${idx + 1}, 需求: ${alt.requiredQty}${noteText})</option>`;
            }
          });
          
          nameHtml = `<div class="tile-name-select-wrap" style="margin-top: 8px; width: 100%;">` +
            `<select class="tile-item-select" data-day="${day}" data-primary-id="${mat.primaryMaterialId}" data-previous-id="${mat.id}" style="width: 100%; padding: 6px 20px 6px 8px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: var(--text-primary); font-size: 11px; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; appearance: none; -webkit-appearance: none; background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20width%3D%2214%22%20height%3D%2214%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255,255,255,0.6)%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%20%2F%3E%3C%2F%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;">` +
            selectOptions +
            `</select>` +
            `</div>`;
        } else {
          nameHtml = '<div class="tile-name" style="margin-top: 8px;">' + escapeHtml(mat.name) + '</div>';
        }

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
            '<div class="tile-check"></div>' +
            '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
            nameHtml +
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
            '<div class="tile-check"></div>' +
            '<div class="tile-icon">' + renderIconHtml(mat.icon, '36px') + '</div>' +
            nameHtml +
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
        if (e.target.closest('.tile-qty-container') || e.target.closest('.tile-batch-select-wrap') || e.target.closest('.tile-name-select-wrap')) return;
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

    // Item select change (alternatives)
    container.querySelectorAll('.tile-item-select').forEach(select => {
      select.addEventListener('click', function (e) { e.stopPropagation(); });
      select.addEventListener('change', function () {
        const primaryId = Number(this.getAttribute('data-primary-id'));
        const previousId = Number(this.getAttribute('data-previous-id'));
        const newId = Number(this.value);
        const day = this.getAttribute('data-day');

        activeAlternatives[`${processId}_${day}_${primaryId}`] = newId;

        if (usageSelectedIds.has(previousId)) {
          usageSelectedIds.delete(previousId);
          usageSelectedIds.add(newId);
        }

        renderUsageTiles();
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
      countEl.textContent = usageSelectedIds.size;
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
      
      const isExpired = getDaysRemaining(targetExpiryDate) < 0;
      if (isExpired) {
        const mat = findMaterial(materialId);
        const confirmUse = confirm(`⚠️ 警告：此批「${mat ? mat.name : '物料'}」已過期（有效期限為 ${targetExpiryDate}）。\n確定仍要強行使用嗎？（系統會自動在備註中標記「[過期使用]」）`);
        if (!confirmUse) {
          hasError = true;
          return;
        }
      }

      const input = document.querySelector('#usage-tile-groups .tile-qty-input[data-id="' + materialId + '"]');
      const qty = input ? parseInt(input.value, 10) || 1 : 1;
      
      const batches = getMaterialBatches(materialId, processId, true);
      const matches = batches.filter(b => b.processId === targetProcId && b.expiryDate === targetExpiryDate);
      const stock = matches.reduce((sum, b) => sum + b.remainingQty, 0);

      if (qty > stock) {
        const mat = findMaterial(materialId);
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
            usageDate: today,
            remark: isExpired ? '[過期使用]' : ''
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
        const mat = findMaterial(r.materialId);
        const nameMatch = mat ? mat.name.toLowerCase().includes(searchVal) : false;
        
        const dateVal = r.usageDate || r.date || '';
        const rawDate = dateVal.toLowerCase();
        const formattedDate = formatDate(dateVal).toLowerCase();
        const cleanSearchVal = searchVal.replace(/[-/]/g, '');
        const cleanRawDate = rawDate.replace(/[-/]/g, '');
        
        const dateMatch = rawDate.includes(searchVal) || 
                          formattedDate.includes(searchVal) || 
                          cleanRawDate.includes(cleanSearchVal);
                          
        return nameMatch || dateMatch;
      })
      .sort((a, b) => {
        const dateA = a.usageDate || a.date || '';
        const dateB = b.usageDate || b.date || '';
        const comp = dateA.localeCompare(dateB);
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
        const mat = findMaterial(rec.materialId);
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

        const displayDate = rec.usageDate || rec.date || '';
        tableHtml += '<tr>' +
          '<td>' + formatDate(displayDate) + '</td>' +
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
    return val ? cleanId(val) : null;
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
        hasSyncedFromCloud = false;
        syncWithCloud();
      });
    }

    // Material Library & Recipes Manager triggers
    const btnLibMat = document.getElementById('btn-open-material-library');
    if (btnLibMat) {
      btnLibMat.addEventListener('click', function () {
        closeModal('settings');
        renderMaterialLibrary();
        openModal('material-library');
      });
    }

    const btnRecipeList = document.getElementById('btn-open-recipe-list');
    if (btnRecipeList) {
      btnRecipeList.addEventListener('click', function () {
        closeModal('settings');
        renderRecipeList();
        openModal('recipe-list');
      });
    }
  }

  // ─── Material Library Controller ────────────────────────────────────
  function renderMaterialLibrary() {
    const listContainer = document.getElementById('library-material-list');
    if (!listContainer) return;
    let html = '';
    if (materials.length === 0) {
      html = '<div style="color: var(--text-secondary); text-align: center; padding: 20px;">物料庫目前為空。</div>';
    } else {
      materials.forEach(mat => {
        html += `<div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 10px 14px; border-radius: var(--radius-md);">` +
          `<div style="display: flex; align-items: center; gap: 12px;">` +
          `<span style="font-size: 24px; display: flex; align-items: center;">${renderIconHtml(mat.icon, '28px')}</span>` +
          `<span style="font-weight: 500; font-size: 14px;">${escapeHtml(mat.name)}</span>` +
          `</div>` +
          `<div style="display: flex; gap: 8px;">` +
          `<button type="button" class="btn-secondary btn-edit-lib-mat" data-id="${mat.id}" style="padding: 6px 10px; font-size: 11px;">編輯</button>` +
          `<button type="button" class="btn-danger btn-delete-lib-mat" data-id="${mat.id}" style="padding: 6px 10px; font-size: 11px;">刪除</button>` +
          `</div>` +
          `</div>`;
      });
    }
    listContainer.innerHTML = html;

    // Bind edit buttons
    listContainer.querySelectorAll('.btn-edit-lib-mat').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = Number(this.getAttribute('data-id'));
        const mat = findMaterial(id);
        if (mat) {
          document.getElementById('modal-material-title').textContent = '編輯物料品項';
          document.getElementById('input-material-name').value = mat.name;
          document.getElementById('input-material-id').value = mat.id;
          
          // Select icon option
          document.querySelectorAll('#icon-picker .icon-option').forEach(opt => {
            opt.classList.toggle('selected', opt.getAttribute('data-icon') === mat.icon);
          });
          document.getElementById('input-material-icon').value = mat.icon;

          // Clear custom and file icon
          document.getElementById('input-material-custom-icon').value = '';
          const fileInput = document.getElementById('input-material-file-icon');
          const previewWrap = document.getElementById('material-file-preview');
          const previewImg = document.getElementById('img-file-preview');
          if (fileInput) fileInput.value = '';
          if (previewWrap && previewImg) {
            if (mat.icon.startsWith('data:image/') || mat.icon.startsWith('http') || mat.icon.startsWith('blob:')) {
              previewWrap.style.display = 'flex';
              previewImg.src = mat.icon;
            } else {
              previewWrap.style.display = 'none';
              previewImg.src = '';
            }
          }

          const rowEl = document.querySelector('#form-material .form-row');
          if (rowEl) rowEl.style.display = 'none';
          
          formMaterialContext = 'library';
          openModal('material');
        }
      });
    });

    // Bind delete buttons
    listContainer.querySelectorAll('.btn-delete-lib-mat').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = Number(this.getAttribute('data-id'));
        showConfirm('確定要從物料庫刪除此品項嗎？這不會刪除已產生的滅菌與使用歷史紀錄，但相關配方中將無法再選用此物料。', function () {
          performCloudSyncAction(() => {
            materials = materials.filter(m => m.id !== id);
            // Also clean up from recipes
            recipes.forEach(r => {
              r.requirements = r.requirements.filter(req => req.materialId !== id);
            });
            saveData();
          }, () => {
            showToast('物料品項已刪除');
            renderMaterialLibrary();
            renderMaterialsList();
          });
        });
      });
    });
  }

  // ─── Recipe Manager Controller ──────────────────────────────────────
  function renderRecipeList() {
    const listContainer = document.getElementById('recipe-list-container');
    if (!listContainer) return;
    let html = '';
    recipes.forEach(recipe => {
      const itemsCount = recipe.requirements ? recipe.requirements.length : 0;
      html += `<div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 12px 16px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: space-between;">` +
        `<div>` +
        `<div style="font-weight: 600; font-size: 14px; color: var(--text-primary);">${escapeHtml(recipe.name)}</div>` +
        `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">包含 ${itemsCount} 項物料需求</div>` +
        `</div>` +
        `<div style="display: flex; gap: 8px;">` +
        `<button type="button" class="btn-secondary btn-edit-recipe-item" data-id="${recipe.id}" style="padding: 6px 10px; font-size: 11px;">編輯</button>` +
        `<button type="button" class="btn-danger btn-delete-recipe-item" data-id="${recipe.id}" style="padding: 6px 10px; font-size: 11px;">刪除</button>` +
        `</div>` +
        `</div>`;
    });
    listContainer.innerHTML = html;

    listContainer.querySelectorAll('.btn-edit-recipe-item').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = Number(this.getAttribute('data-id'));
        openRecipeEditor(id);
      });
    });

    listContainer.querySelectorAll('.btn-delete-recipe-item').forEach(btn => {
      btn.addEventListener('click', function () {
        const id = Number(this.getAttribute('data-id'));
        if (id === 1) {
          showToast('預設製程不能刪除');
          return;
        }
        showConfirm('確定要刪除此配方嗎？這不會刪除已選用此配方的舊批次紀錄，但後續新增批次時將無法再選用此配方。', function () {
          performCloudSyncAction(() => {
            recipes = recipes.filter(r => r.id !== id);
            saveData();
          }, () => {
            showToast('配方已刪除');
            renderRecipeList();
            populateRecipeDropdowns();
          });
        });
      });
    });
  }

  function openRecipeEditor(recipeId = null) {
    const titleEl = document.getElementById('modal-recipe-edit-title');
    const nameInput = document.getElementById('input-recipe-name');
    const idInput = document.getElementById('input-recipe-id');
    const requirementsContainer = document.getElementById('recipe-requirements-container');
    
    if (!requirementsContainer) return;
    requirementsContainer.innerHTML = '';

    if (recipeId) {
      const recipe = findRecipe(recipeId);
      if (recipe) {
        titleEl.textContent = '編輯製程配方';
        nameInput.value = recipe.name;
        idInput.value = recipe.id;
        
        (recipe.requirements || []).forEach(req => {
          addRecipeRequirementRow(req.materialId, req.requiredQty, req.processDay, req.alternatives);
        });
      }
    } else {
      titleEl.textContent = '新增製程配方';
      nameInput.value = '';
      idInput.value = '';
      addRecipeRequirementRow();
    }
    
    openModal('recipe-edit');
  }

  function addRecipeRequirementRow(materialId = '', qty = 1, day = 'D0', alternatives = []) {
    const container = document.getElementById('recipe-requirements-container');
    if (!container) return;

    const group = document.createElement('div');
    group.className = 'recipe-req-group';
    group.style.borderBottom = '1px dashed rgba(255,255,255,0.1)';
    group.style.paddingBottom = '12px';
    group.style.marginBottom = '12px';

    let options = '<option value="">-- 選擇物料 --</option>';
    materials.forEach(mat => {
      if (!mat.id) {
        mat.id = generateId();
      }
      const isSelected = Number(materialId) === mat.id;
      options += `<option value="${mat.id}" ${isSelected ? 'selected' : ''}>${mat.icon} ${escapeHtml(mat.name)}</option>`;
    });
    
    const dayOptions = ['D0', 'D3', 'D11', 'D14', 'D1', 'D2', 'D5', 'D7', 'D10', 'D15', 'D21', 'D28', 'D30'];
    if (!dayOptions.includes(day)) {
      dayOptions.push(day);
    }
    dayOptions.sort((a,b) => (parseInt(a.substring(1), 10)||0) - (parseInt(b.substring(1), 10)||0));

    let dayOptionsHtml = '';
    dayOptions.forEach(dOpt => {
      dayOptionsHtml += `<option value="${dOpt}" ${day === dOpt ? 'selected' : ''}>${dOpt}</option>`;
    });

    group.innerHTML = `
      <div class="recipe-req-row" style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <div style="flex: 2;">
          <select class="req-mat-select" style="width: 100%; padding: 8px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: var(--text-primary); box-sizing: border-box; font-size: 12px;" required>
            ${options}
          </select>
        </div>
        <div style="flex: 1; min-width: 80px;">
          <input type="number" class="req-qty-input" min="1" value="${qty}" style="width: 100%; padding: 8px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: var(--text-primary); box-sizing: border-box; text-align: center; font-size: 12px;" required>
        </div>
        <div style="flex: 1; min-width: 80px;">
          <select class="req-day-select" style="width: 100%; padding: 8px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: var(--text-primary); box-sizing: border-box; font-size: 12px;" required>
            ${dayOptionsHtml}
          </select>
        </div>
        <div style="display: flex; gap: 4px;">
          <button type="button" class="btn-add-alt-row" title="新增備選" style="background: rgba(0, 122, 255, 0.15); border: 1px solid rgba(0, 122, 255, 0.3); color: #3897ff; font-size: 11px; padding: 0 8px; height: 30px; border-radius: 6px; cursor: pointer; white-space: nowrap;">➕ 備選</button>
          <button type="button" class="btn-qty-adj btn-dec btn-remove-req-row" style="background: rgba(255,59,48,0.1); border: 1px solid rgba(255,59,48,0.2); color: var(--danger); font-size: 14px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: pointer;">×</button>
        </div>
      </div>
      <div class="recipe-alt-rows-container" style="padding-left: 24px; display: flex; flex-direction: column; gap: 6px;">
        <!-- Nested alternative rows -->
      </div>
    `;

    container.appendChild(group);

    const altContainer = group.querySelector('.recipe-alt-rows-container');

    // Populate existing alternatives
    if (alternatives && alternatives.length > 0) {
      alternatives.forEach(alt => {
        addRecipeAlternativeRow(altContainer, alt.materialId, alt.requiredQty, alt.note);
      });
    }

    group.querySelector('.btn-remove-req-row').addEventListener('click', function () {
      container.removeChild(group);
    });

    group.querySelector('.btn-add-alt-row').addEventListener('click', function () {
      addRecipeAlternativeRow(altContainer);
    });
  }

  function addRecipeAlternativeRow(container, altMaterialId = '', altQty = 1, altNote = '') {
    const row = document.createElement('div');
    row.className = 'recipe-alt-row';
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';

    let options = '<option value="">-- 選擇替代物料 --</option>';
    materials.forEach(mat => {
      const isSelected = Number(altMaterialId) === mat.id;
      options += `<option value="${mat.id}" ${isSelected ? 'selected' : ''}>${mat.icon} ${escapeHtml(mat.name)}</option>`;
    });

    row.innerHTML = `
      <div style="color: var(--text-secondary); font-size: 11px; width: 14px;">↳</div>
      <div style="flex: 2;">
        <select class="alt-mat-select" style="width: 100%; padding: 6px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.3); color: var(--text-primary); box-sizing: border-box; font-size: 11px;" required>
          ${options}
        </select>
      </div>
      <div style="flex: 1; min-width: 60px;">
        <input type="number" class="alt-qty-input" min="1" value="${altQty}" style="width: 100%; padding: 6px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.3); color: var(--text-primary); box-sizing: border-box; text-align: center; font-size: 11px;" required>
      </div>
      <div style="flex: 1.5; min-width: 80px;">
        <input type="text" class="alt-note-input" placeholder="備註(如:人少夠用)" value="${escapeHtml(altNote)}" style="width: 100%; padding: 6px; border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.3); color: var(--text-primary); box-sizing: border-box; font-size: 11px;">
      </div>
      <div>
        <button type="button" class="btn-remove-alt-row" style="background: rgba(255,59,48,0.1); border: 1px solid rgba(255,59,48,0.2); color: var(--danger); font-size: 12px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 4px; cursor: pointer;">×</button>
      </div>
    `;

    container.appendChild(row);

    row.querySelector('.btn-remove-alt-row').addEventListener('click', function () {
      container.removeChild(row);
    });
  }

  function initRecipeForm() {
    const form = document.getElementById('form-recipe-edit');
    const btnAddRow = document.getElementById('btn-add-recipe-requirement');

    if (btnAddRow) {
      btnAddRow.addEventListener('click', function () {
        addRecipeRequirementRow();
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const name = document.getElementById('input-recipe-name').value.trim();
        const editId = document.getElementById('input-recipe-id').value;

        if (!name) {
          showToast('請輸入配方名稱');
          return;
        }

        const requirements = [];
        const groups = document.querySelectorAll('.recipe-req-group');
        let hasDuplicate = false;
        const matDayKeys = new Set();

        for (let group of groups) {
          const matSelect = group.querySelector('.req-mat-select');
          const qtyInput = group.querySelector('.req-qty-input');
          const daySelect = group.querySelector('.req-day-select');

          const materialId = Number(matSelect.value);
          const qty = parseInt(qtyInput.value, 10) || 1;
          const day = daySelect.value;

          if (!materialId) {
            showToast('請為所有配置行選擇物料品項');
            return;
          }

          const checkKey = materialId + '_' + day;
          if (matDayKeys.has(checkKey)) {
            hasDuplicate = true;
          }
          matDayKeys.add(checkKey);

          // Get alternatives
          const alternatives = [];
          const altRows = group.querySelectorAll('.recipe-alt-row');
          for (let altRow of altRows) {
            const altMatSelect = altRow.querySelector('.alt-mat-select');
            const altQtyInput = altRow.querySelector('.alt-qty-input');
            const altNoteInput = altRow.querySelector('.alt-note-input');

            const altMatId = Number(altMatSelect.value);
            const altQty = parseInt(altQtyInput.value, 10) || 1;
            const altNote = altNoteInput.value.trim();

            if (!altMatId) {
              showToast('請為所有備選行選擇替代物料');
              return;
            }

            alternatives.push({
              materialId: altMatId,
              requiredQty: altQty,
              note: altNote
            });
          }

          requirements.push({
            materialId,
            requiredQty: qty,
            processDay: day,
            alternatives
          });
        }

        if (hasDuplicate) {
          showToast('⚠️ 同一配方中，相同物料在同一天不能重複配置！');
          return;
        }

        performCloudSyncAction(() => {
          if (editId) {
            const idx = recipes.findIndex(r => r.id === Number(editId));
            if (idx !== -1) {
              recipes[idx].name = name;
              recipes[idx].requirements = requirements;
            }
          } else {
            recipes.push({
              id: generateId(),
              name,
              requirements
            });
          }
          saveData();
        }, () => {
          closeModal('recipe-edit');
          showToast(editId ? '配方已更新' : '配方已建立');
          renderRecipeList();
          populateRecipeDropdowns();
          renderMaterialsList();
          renderDashboard();
        });
      });
    }
  }

  function populateRecipeDropdowns() {
    const select = document.getElementById('input-process-recipe');
    if (!select) return;
    let html = '';
    recipes.forEach(r => {
      html += `<option value="${r.id}">${escapeHtml(r.name)}</option>`;
    });
    select.innerHTML = html;
  }

  // ─── Initialization ─────────────────────────────────────────────────
  function init() {
    if (isInitialized) return;
    isInitialized = true;
    loadData();
    initTabs();
    initModals();
    initConfirm();
    initProcessActionModals();
    initProcessForm();
    initMaterialForm();
    initIconPicker();
    initRecipeForm();
    initSterilizationPage();
    initUsagePage();
    initSettings();
    populateRecipeDropdowns();

    // Bind settings buttons for Material Library and Recipes
    const btnAddRecipe = document.getElementById('btn-add-recipe');
    if (btnAddRecipe) {
      btnAddRecipe.addEventListener('click', function () {
        openRecipeEditor();
      });
    }

    const btnAddLibMat = document.getElementById('btn-add-library-material');
    if (btnAddLibMat) {
      btnAddLibMat.addEventListener('click', function () {
        document.getElementById('modal-material-title').textContent = '新增物料品項';
        document.getElementById('input-material-name').value = '';
        document.getElementById('input-material-icon').value = '📦';
        const customIconInput = document.getElementById('input-material-custom-icon');
        if (customIconInput) customIconInput.value = '';
        document.getElementById('input-material-id').value = '';

        const formRow = document.querySelector('#form-material .form-row');
        if (formRow) formRow.style.display = 'none';

        // Reset file upload
        const fileInput = document.getElementById('input-material-file-icon');
        const filePreview = document.getElementById('material-file-preview');
        const imgPreview = document.getElementById('img-file-preview');
        if (fileInput) fileInput.value = '';
        if (filePreview) filePreview.style.display = 'none';
        if (imgPreview) imgPreview.src = '';

        // Reset icon picker
        document.querySelectorAll('#icon-picker .icon-option').forEach(opt => {
          opt.classList.toggle('selected', opt.getAttribute('data-icon') === '📦');
        });
        
        formMaterialContext = 'library';
        openModal('material');
      });
    }



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
