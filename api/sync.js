// Extract Notion ID from page/database URL or raw string
function extractId(str) {
  if (!str) return '';
  const clean = str.replace(/-/g, '').trim();
  if (clean.length === 32) return clean;
  const match = str.match(/([a-f0-9]{32})/i);
  return match ? match[1] : str;
}

// Stable FNV-1a 32-bit hash to map Notion UUID to unique positive integer
function uuidToHashId(uuid) {
  if (!uuid) return 0;
  let hash = 2166136261;
  const clean = uuid.replace(/-/g, '').toLowerCase();
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

// Custom lightweight Notion API fetch client
async function notionFetch(token, endpoint, options = {}) {
  const url = `https://api.notion.com/v1${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
    ...options.headers
  };
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(`Notion API error: ${res.status} - ${JSON.stringify(errorData)}`);
  }
  return res.json();
}

// Fetch all pages in a database with pagination support
async function queryAllPages(token, databaseId) {
  if (!databaseId) return [];
  const results = [];
  let cursor = undefined;

  do {
    const response = await notionFetch(token, `/databases/${databaseId}/query`, {
      method: 'POST',
      body: cursor ? { start_cursor: cursor } : {}
    });
    // Only include non-archived pages
    const activePages = response.results.filter(p => !p.archived);
    results.push(...activePages);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

// Get or auto-create databases under a parent page
async function resolveDatabases(token, pageId) {
  // 1. If explicit database IDs are provided in env, use them directly
  if (process.env.NOTION_PROCESSES_DB_ID &&
      process.env.NOTION_MATERIALS_DB_ID &&
      process.env.NOTION_RECIPES_DB_ID &&
      process.env.NOTION_STERILIZATION_DB_ID &&
      process.env.NOTION_USAGE_DB_ID) {
    return {
      processes: extractId(process.env.NOTION_PROCESSES_DB_ID),
      materials: extractId(process.env.NOTION_MATERIALS_DB_ID),
      recipes: extractId(process.env.NOTION_RECIPES_DB_ID),
      sterilization: extractId(process.env.NOTION_STERILIZATION_DB_ID),
      usage: extractId(process.env.NOTION_USAGE_DB_ID)
    };
  }

  if (!pageId) {
    throw new Error('Missing NOTION_PAGE_ID or individual Database IDs in environment configuration.');
  }

  // 2. Fetch children blocks of the parent page to find existing databases
  const cleanPageId = extractId(pageId);
  const children = await notionFetch(token, `/blocks/${cleanPageId}/children?page_size=100`);
  
  const dbs = {};
  for (const block of children.results) {
    if (block.type === 'child_database') {
      const title = block.child_database.title;
      if (title === 'CPI_Process_Runs' || title === '製程批次') dbs.processes = block.id;
      if (title === 'CPI_Material_Catalog' || title === '物料品項庫') dbs.materials = block.id;
      if (title === 'CPI_Recipe_Templates' || title === '製程配方模板') dbs.recipes = block.id;
      if (title === 'CPI_Sterilization_Records' || title === '滅菌紀錄') dbs.sterilization = block.id;
      if (title === 'CPI_Usage_Records' || title === '使用紀錄') dbs.usage = block.id;
    }
  }

  // Helper to ensure relation property exists on database
  async function ensureRelation(token, dbId, propName, targetDbId) {
    try {
      const dbInfo = await notionFetch(token, `/databases/${dbId}`);
      const properties = dbInfo.properties || {};
      if (!properties[propName]) {
        console.log(`Adding relation column "${propName}" to database ${dbId}...`);
        await notionFetch(token, `/databases/${dbId}`, {
          method: 'PATCH',
          body: {
            properties: {
              [propName]: {
                relation: {
                  database_id: targetDbId,
                  single_property: {}
                }
              }
            }
          }
        });
      }
    } catch (e) {
      console.warn(`Failed to ensure relation ${propName} on database ${dbId}:`, e);
    }
  }

  // Helper to ensure rollup property exists on database
  async function ensureRollup(token, dbId, propName, relationPropName, targetPropName) {
    try {
      const dbInfo = await notionFetch(token, `/databases/${dbId}`);
      const properties = dbInfo.properties || {};
      if (!properties[propName]) {
        console.log(`Adding rollup column "${propName}" to database ${dbId}...`);
        await notionFetch(token, `/databases/${dbId}`, {
          method: 'PATCH',
          body: {
            properties: {
              [propName]: {
                rollup: {
                  relation_property_name: relationPropName,
                  rollup_property_name: targetPropName,
                  function: 'show_original'
                }
              }
            }
          }
        });
      }
    } catch (e) {
      console.warn(`Failed to ensure rollup ${propName} on database ${dbId}:`, e);
    }
  }

  // Helper to delete legacy properties
  async function cleanLegacyProperties(token, dbId) {
    try {
      const dbInfo = await notionFetch(token, `/databases/${dbId}`);
      const properties = dbInfo.properties || {};
      const updates = {};
      
      const keysToClean = ['ID', '配方ID', '製程批次ID', '物料ID', '滅菌紀錄ID', '需求數量', '製程天數'];
      keysToClean.forEach(key => {
        if (properties[key]) {
          updates[key] = null;
        }
      });

      if (Object.keys(updates).length > 0) {
        console.log(`Cleaning up legacy columns in database ${dbId}...`);
        await notionFetch(token, `/databases/${dbId}`, {
          method: 'PATCH',
          body: { properties: updates }
        });
      }
    } catch (e) {
      console.warn(`Failed to clean legacy properties on database ${dbId}:`, e);
    }
  }

  // 3. Create missing databases in dependency order
  if (!dbs.recipes) {
    console.log('Creating CPI_Recipe_Templates database...');
    const db = await notionFetch(token, '/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: cleanPageId },
        title: [{ type: 'text', text: { content: 'CPI_Recipe_Templates' } }],
        properties: {
          '配方名稱': { title: {} },
          '材料配置': { rich_text: {} }
        }
      }
    });
    dbs.recipes = db.id;
  }

  if (!dbs.materials) {
    console.log('Creating CPI_Material_Catalog database...');
    const db = await notionFetch(token, '/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: cleanPageId },
        title: [{ type: 'text', text: { content: 'CPI_Material_Catalog' } }],
        properties: {
          '物料名稱': { title: {} },
          '圖示': { rich_text: {} }
        }
      }
    });
    dbs.materials = db.id;
  } else {
    await cleanLegacyProperties(token, dbs.materials);
  }

  if (!dbs.processes) {
    console.log('Creating CPI_Process_Runs database...');
    const db = await notionFetch(token, '/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: cleanPageId },
        title: [{ type: 'text', text: { content: 'CPI_Process_Runs' } }],
        properties: {
          '名稱': { title: {} },
          '起始日期': { date: {} },
          '狀態': { select: { options: [{ name: 'finished', color: 'green' }] } },
          '當前啟用': { checkbox: {} },
          '已封存': { checkbox: {} },
          '製程配方': { relation: { database_id: dbs.recipes, single_property: {} } },
          '結束日期': { date: {} },
          '異常紀錄': { rich_text: {} },
          '結案資訊': { rich_text: {} }
        }
      }
    });
    dbs.processes = db.id;
  } else {
    await ensureRelation(token, dbs.processes, '製程配方', dbs.recipes);
    await cleanLegacyProperties(token, dbs.processes);
  }

  if (!dbs.sterilization) {
    console.log('Creating CPI_Sterilization_Records database...');
    const db = await notionFetch(token, '/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: cleanPageId },
        title: [{ type: 'text', text: { content: 'CPI_Sterilization_Records' } }],
        properties: {
          '紀錄名稱': { title: {} },
          '滅菌日期': { date: {} },
          '數量': { number: { format: 'number' } },
          '過期日期': { date: {} },
          '製程批次': { relation: { database_id: dbs.processes, single_property: {} } },
          '物料品項': { relation: { database_id: dbs.materials, single_property: {} } }
        }
      }
    });
    dbs.sterilization = db.id;
  } else {
    await ensureRelation(token, dbs.sterilization, '製程批次', dbs.processes);
    await ensureRelation(token, dbs.sterilization, '物料品項', dbs.materials);
    await cleanLegacyProperties(token, dbs.sterilization);
  }

  if (!dbs.usage) {
    console.log('Creating CPI_Usage_Records database...');
    const db = await notionFetch(token, '/databases', {
      method: 'POST',
      body: {
        parent: { type: 'page_id', page_id: cleanPageId },
        title: [{ type: 'text', text: { content: 'CPI_Usage_Records' } }],
        properties: {
          '紀錄名稱': { title: {} },
          '使用日期': { date: {} },
          '數量': { number: { format: 'number' } },
          '備註': { rich_text: {} },
          '製程批次': { relation: { database_id: dbs.processes, single_property: {} } },
          '物料品項': { relation: { database_id: dbs.materials, single_property: {} } },
          '滅菌紀錄': { relation: { database_id: dbs.sterilization, single_property: {} } },
          '來源滅菌批次': {
            rollup: {
              relation_property_name: '滅菌紀錄',
              rollup_property_name: '製程批次',
              function: 'show_original'
            }
          }
        }
      }
    });
    dbs.usage = db.id;
  } else {
    await ensureRelation(token, dbs.usage, '製程批次', dbs.processes);
    await ensureRelation(token, dbs.usage, '物料品項', dbs.materials);
    await ensureRelation(token, dbs.usage, '滅菌紀錄', dbs.sterilization);
    await ensureRollup(token, dbs.usage, '來源滅菌批次', '滅菌紀錄', '製程批次');
    await cleanLegacyProperties(token, dbs.usage);
  }

  return dbs;
}

// Diff-based synchronization function using UUID hashing for stable client matching
async function syncTable(token, databaseId, clientItems, buildPropsFn, hasChangedFn) {
  const existingPages = await queryAllPages(token, databaseId);
  
  // Map existing pages by their hashed stable ID
  const existingMap = new Map();
  for (const page of existingPages) {
    const hashId = uuidToHashId(page.id);
    existingMap.set(String(hashId), page);
  }

  const createdMappings = [];

  for (const item of clientItems) {
    // Check if it exists in Notion (by comparing stable hash values)
    const existingPage = existingMap.get(String(item.id));
    const properties = await buildPropsFn(item);

    if (!existingPage) {
      // 1. Create page
      const newPage = await notionFetch(token, '/pages', {
        method: 'POST',
        body: {
          parent: { database_id: databaseId },
          properties
        }
      });
      // Map client's temp ID (timestamp) to the stable numeric hash of the new Notion page
      const realHashId = uuidToHashId(newPage.id);
      createdMappings.push({ tempId: item.id, realId: realHashId });
    } else {
      existingMap.delete(String(item.id));
      
      // 2. Update page if changed
      if (hasChangedFn(item, existingPage.properties)) {
        try {
          await notionFetch(token, `/pages/${existingPage.id}`, {
            method: 'PATCH',
            body: {
              properties
            }
          });
        } catch (updateErr) {
          console.warn(`Failed to update page ${existingPage.id}:`, updateErr.message);
        }
      }
    }
  }

  // 3. Archive/Delete remaining pages (ones that exist in Notion but not in client)
  for (const [idVal, page] of existingMap.entries()) {
    if (page.archived) continue; // Skip already archived
    try {
      await notionFetch(token, `/pages/${page.id}`, {
        method: 'PATCH',
        body: {
          archived: true
        }
      });
    } catch (archiveErr) {
      console.warn(`Failed to archive page ${page.id}, skipping:`, archiveErr.message);
    }
  }

  return createdMappings;
}

// Main serverless handler
export default async function handler(req, res) {
  try {
    const token = process.env.NOTION_TOKEN;
    const pageId = process.env.NOTION_PAGE_ID;

    if (!token) {
      return res.status(200).json({ success: false, error: 'NOTION_NOT_CONFIGURED' });
    }

    const dbs = await resolveDatabases(token, pageId);

    if (req.method === 'GET') {
      // ─── READ DATA FROM NOTION ──────────────────────────────────────
      const [procPages, matPages, recipePages, sterPages, usagePages] = await Promise.all([
        queryAllPages(token, dbs.processes),
        queryAllPages(token, dbs.materials),
        queryAllPages(token, dbs.recipes),
        queryAllPages(token, dbs.sterilization),
        queryAllPages(token, dbs.usage)
      ]);

      // Map definitions to resolve Relation page UUIDs to stable numeric IDs
      const getStableId = (uuid) => (uuid ? uuidToHashId(uuid) : 0);

      let currentProcessId = null;

      const processes = procPages.map(page => {
        const props = page.properties;
        const hashId = getStableId(page.id);
        const name = props['名稱']?.title?.map(t => t.plain_text).join('') || '未命名製程';
        const startDate = props['起始日期']?.date?.start || '';
        const selectStatus = props['狀態']?.select?.name || '';
        const isArchived = props['已封存']?.checkbox || false;
        
        const relRecipePageId = props['製程配方']?.relation?.[0]?.id || '';
        const recipeId = getStableId(relRecipePageId) || 1;
        
        const status = (isArchived || selectStatus === 'finished') ? 'finished' : '';
        const isActive = props['當前啟用']?.checkbox || false;
        
        if (isActive) {
          currentProcessId = hashId;
        }

        const finishedAt = props['結束日期']?.date?.start || '';
        const issuesText = props['異常紀錄']?.rich_text?.map(t => t.plain_text).join('') || '';
        const description = props['結案資訊']?.rich_text?.map(t => t.plain_text).join('') || '';
        
        let feedback = null;
        if (finishedAt || issuesText || description) {
          feedback = {
            finishedAt,
            issues: issuesText ? issuesText.split(',').map(s => s.trim()).filter(Boolean) : [],
            description
          };
        }

        const item = { id: hashId, name, startDate, recipeId };
        if (status) item.status = status;
        if (feedback) item.feedback = feedback;
        return item;
      });

      const materials = matPages.map(page => {
        const props = page.properties;
        return {
          id: getStableId(page.id),
          name: props['物料名稱']?.title?.map(t => t.plain_text).join('') || '未命名物料',
          icon: props['圖示']?.rich_text?.map(t => t.plain_text).join('') || '📦'
        };
      });

      const recipes = recipePages.map(page => {
        const props = page.properties;
        const configJson = props['材料配置']?.rich_text?.map(t => t.plain_text).join('') || '[]';
        let requirements = [];
        try {
          requirements = JSON.parse(configJson);
        } catch (e) {
          console.error('Failed to parse materialsConfig JSON', configJson, e);
        }
        return {
          id: getStableId(page.id),
          name: props['配方名稱']?.title?.map(t => t.plain_text).join('') || '未命名配方',
          requirements: requirements.map(req => ({
            ...req,
            materialId: getStableId(req.materialId) // Map material reference as well
          }))
        };
      });

      const sterilizationRecords = sterPages.map(page => {
        const props = page.properties;
        const processId = getStableId(props['製程批次']?.relation?.[0]?.id);
        const materialId = getStableId(props['物料品項']?.relation?.[0]?.id);
        return {
          id: getStableId(page.id),
          sterilizationDate: props['滅菌日期']?.date?.start || '',
          processId,
          materialId,
          qty: props['數量']?.number || 0,
          expiryDate: props['過期日期']?.date?.start || ''
        };
      });

      const usageRecords = usagePages.map(page => {
        const props = page.properties;
        const processId = getStableId(props['製程批次']?.relation?.[0]?.id);
        const materialId = getStableId(props['物料品項']?.relation?.[0]?.id);
        const sterId = getStableId(props['滅菌紀錄']?.relation?.[0]?.id);
        const sterilizationRecordId = sterId || 'FIFO';
        const remark = props['備註']?.rich_text?.map(t => t.plain_text).join('') || '';

        return {
          id: getStableId(page.id),
          usageDate: props['使用日期']?.date?.start || '',
          processId,
          materialId,
          qty: props['數量']?.number || 0,
          sterilizationRecordId,
          remark
        };
      });

      return res.status(200).json({
        processes,
        materials,
        recipes,
        sterilizationRecords,
        usageRecords,
        currentProcessId
      });

    } else if (req.method === 'POST') {
      // ─── WRITE DATA TO NOTION (DIFF SYNC) ───────────────────────────
      const { data } = req.body;
      if (!data) {
        return res.status(400).json({ success: false, error: 'Missing data in request body' });
      }

      const clientCurId = data.currentProcessId;
      const allCreatedMappings = {};

      // Prepare lookup maps of stable client numeric IDs to actual Notion page UUIDs
      const [procPages, matPages, recipePages, sterPages] = await Promise.all([
        queryAllPages(token, dbs.processes),
        queryAllPages(token, dbs.materials),
        queryAllPages(token, dbs.recipes),
        queryAllPages(token, dbs.sterilization)
      ]);

      const procUuidMap = new Map(procPages.map(p => [uuidToHashId(p.id), p.id]));
      const matUuidMap = new Map(matPages.map(m => [uuidToHashId(m.id), m.id]));
      const recipeUuidMap = new Map(recipePages.map(r => [uuidToHashId(r.id), r.id]));
      const sterUuidMap = new Map(sterPages.map(s => [uuidToHashId(s.id), s.id]));

      // A helper to resolve the client ID to a Notion UUID
      const getNotionUuid = (id, map, mappingsKey) => {
        if (allCreatedMappings[id]) return allCreatedMappings[id];
        return map.get(id) || '';
      };

      // 1. Sync Recipes first
      const recipeMappings = await syncTable(token, dbs.recipes, data.recipes || [], async (item) => {
        const mappedReqs = (item.requirements || []).map(req => ({
          ...req,
          materialId: getNotionUuid(req.materialId, matUuidMap)
        }));
        const configJson = JSON.stringify(mappedReqs);

        return {
          '配方名稱': { title: [{ text: { content: item.name || '未命名配方' } }] },
          '材料配置': { rich_text: [{ text: { content: configJson } }] }
        };
      }, (item, props) => {
        const name = props['配方名稱']?.title?.map(t => t.plain_text).join('') || '';
        const configJson = props['材料配置']?.rich_text?.map(t => t.plain_text).join('') || '[]';
        
        const mappedReqs = (item.requirements || []).map(req => ({
          ...req,
          materialId: getNotionUuid(req.materialId, matUuidMap)
        }));
        const clientConfig = JSON.stringify(mappedReqs);
        return name !== item.name || configJson !== clientConfig;
      });
      recipeMappings.forEach(m => { allCreatedMappings[m.tempId] = m.realId; });

      // 2. Sync Materials
      const matMappings = await syncTable(token, dbs.materials, data.materials || [], async (item) => {
        return {
          '物料名稱': { title: [{ text: { content: item.name || '未命名物料' } }] },
          '圖示': { rich_text: [{ text: { content: item.icon || '📦' } }] }
        };
      }, (item, props) => {
        const name = props['物料名稱']?.title?.map(t => t.plain_text).join('') || '';
        const icon = props['圖示']?.rich_text?.map(t => t.plain_text).join('') || '📦';
        return name !== item.name || icon !== item.icon;
      });
      matMappings.forEach(m => { allCreatedMappings[m.tempId] = m.realId; });

      // 3. Sync Processes
      const procMappings = await syncTable(token, dbs.processes, data.processes || [], async (item) => {
        const isActive = item.id === clientCurId;
        const isArchived = item.status === 'finished';
        const issuesVal = (item.feedback && item.feedback.issues) ? item.feedback.issues.join(', ') : '';
        const recipePageId = getNotionUuid(item.recipeId, recipeUuidMap);

        return {
          '名稱': { title: [{ text: { content: item.name || '未命名製程' } }] },
          '起始日期': item.startDate ? { date: { start: item.startDate } } : { date: null },
          '狀態': item.status ? { select: { name: item.status } } : { select: null },
          '當前啟用': { checkbox: isActive },
          '已封存': { checkbox: isArchived },
          '製程配方': recipePageId ? { relation: [{ id: recipePageId }] } : { relation: [] },
          '結束日期': (item.feedback && item.feedback.finishedAt) ? { date: { start: item.feedback.finishedAt } } : { date: null },
          '異常紀錄': { rich_text: [{ text: { content: issuesVal } }] },
          '結案資訊': { rich_text: [{ text: { content: (item.feedback && item.feedback.description) || '' } }] }
        };
      }, (item, props) => {
        const name = props['名稱']?.title?.map(t => t.plain_text).join('') || '';
        const startDate = props['起始日期']?.date?.start || '';
        const status = props['狀態']?.select?.name || '';
        const isActive = props['當前啟用']?.checkbox || false;
        const isArchived = props['已封存']?.checkbox || false;
        const finishedAt = props['結束日期']?.date?.start || '';
        const issuesText = props['異常紀錄']?.rich_text?.map(t => t.plain_text).join('') || '';
        const description = props['結案資訊']?.rich_text?.map(t => t.plain_text).join('') || '';

        const relRecipePageId = props['製程配方']?.relation?.[0]?.id || '';
        const targetRecipeUuid = getNotionUuid(item.recipeId, recipeUuidMap);
        const clientActive = item.id === clientCurId;
        const clientArchived = item.status === 'finished';

        return name !== item.name ||
               startDate !== item.startDate ||
               status !== (item.status || '') ||
               isActive !== clientActive ||
               isArchived !== clientArchived ||
               relRecipePageId !== targetRecipeUuid ||
               finishedAt !== (item.feedback?.finishedAt || '') ||
               issuesText !== ((item.feedback?.issues || []).join(', ')) ||
               description !== (item.feedback?.description || '');
      });
      procMappings.forEach(m => { allCreatedMappings[m.tempId] = m.realId; });

      // 4. Sync Sterilization Records
      const materialsMap = new Map((data.materials || []).map(m => [m.id, m]));

      const sterMappings = await syncTable(token, dbs.sterilization, data.sterilizationRecords || [], async (item) => {
        const procPageId = getNotionUuid(item.processId, procUuidMap);
        const matPageId = getNotionUuid(item.materialId, matUuidMap);
        
        const matName = materialsMap.get(item.materialId)?.name || '物料';
        const sterDate = item.sterilizationDate || '';
        const titleVal = `${matName} (${sterDate})`;

        return {
          '紀錄名稱': { title: [{ text: { content: titleVal } }] },
          '滅菌日期': item.sterilizationDate ? { date: { start: item.sterilizationDate } } : { date: null },
          '數量': { number: item.qty || 0 },
          '過期日期': item.expiryDate ? { date: { start: item.expiryDate } } : { date: null },
          '製程批次': procPageId ? { relation: [{ id: procPageId }] } : { relation: [] },
          '物料品項': matPageId ? { relation: [{ id: matPageId }] } : { relation: [] }
        };
      }, (item, props) => {
        const sterilizationDate = props['滅菌日期']?.date?.start || '';
        const qty = props['數量']?.number || 0;
        const expiryDate = props['過期日期']?.date?.start || '';

        const relProcPageId = props['製程批次']?.relation?.[0]?.id || '';
        const relMatPageId = props['物料品項']?.relation?.[0]?.id || '';

        const targetProcUuid = getNotionUuid(item.processId, procUuidMap);
        const targetMatUuid = getNotionUuid(item.materialId, matUuidMap);

        return sterilizationDate !== item.sterilizationDate ||
               qty !== item.qty ||
               expiryDate !== item.expiryDate ||
               relProcPageId !== targetProcUuid ||
               relMatPageId !== targetMatUuid;
      });
      sterMappings.forEach(m => { allCreatedMappings[m.tempId] = m.realId; });

      // 5. Sync Usage Records
      await syncTable(token, dbs.usage, data.usageRecords || [], async (item) => {
        const procPageId = getNotionUuid(item.processId, procUuidMap);
        const matPageId = getNotionUuid(item.materialId, matUuidMap);
        const sterPageId = (item.sterilizationRecordId === 'FIFO' || !item.sterilizationRecordId) ? '' : getNotionUuid(item.sterilizationRecordId, sterUuidMap);
        
        const matName = materialsMap.get(item.materialId)?.name || '物料';
        const usageDate = item.usageDate || '';
        const titleVal = `${matName} 使用 (${usageDate})`;

        return {
          '紀錄名稱': { title: [{ text: { content: titleVal } }] },
          '使用日期': item.usageDate ? { date: { start: item.usageDate } } : { date: null },
          '數量': { number: item.qty || 0 },
          '備註': { rich_text: [{ text: { content: item.remark || '' } }] },
          '製程批次': procPageId ? { relation: [{ id: procPageId }] } : { relation: [] },
          '物料品項': matPageId ? { relation: [{ id: matPageId }] } : { relation: [] },
          '滅菌紀錄': sterPageId ? { relation: [{ id: sterPageId }] } : { relation: [] }
        };
      }, (item, props) => {
        const usageDate = props['使用日期']?.date?.start || '';
        const qty = props['數量']?.number || 0;
        const remark = props['備註']?.rich_text?.map(t => t.plain_text).join('') || '';

        const relProcPageId = props['製程批次']?.relation?.[0]?.id || '';
        const relMatPageId = props['物料品項']?.relation?.[0]?.id || '';
        const relSterPageId = props['滅菌紀錄']?.relation?.[0]?.id || '';

        const targetProcUuid = getNotionUuid(item.processId, procUuidMap);
        const targetMatUuid = getNotionUuid(item.materialId, matUuidMap);
        const targetSterUuid = (item.sterilizationRecordId === 'FIFO' || !item.sterilizationRecordId) ? '' : getNotionUuid(item.sterilizationRecordId, sterUuidMap);

        return usageDate !== item.usageDate ||
               qty !== item.qty ||
               remark !== (item.remark || '') ||
               relProcPageId !== targetProcUuid ||
               relMatPageId !== targetMatUuid ||
               relSterPageId !== targetSterUuid;
      });

      let currentProcessId = data.currentProcessId;
      if (allCreatedMappings[currentProcessId]) {
        currentProcessId = allCreatedMappings[currentProcessId];
      }

      return res.status(200).json({
        success: true,
        idMappings: allCreatedMappings,
        currentProcessId
      });
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
    }
  } catch (error) {
    console.error('API Error details:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal Server Error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
