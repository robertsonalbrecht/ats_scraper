'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

const DEFAULT_FIELD_MAP = {
  linkedinUrl:      'LinkedIn URL',
  fullName:         'Full Name',
  headline:         'Headline',
  location:         'Location',
  currentCompany:   'Current Company',
  currentTitle:     'Current Title',
  about:            'About',
  workHistory:      'Work History',
  education:        'Education',
  skills:           'Skills',
  photoUrl:         'Photo URL',
  connectionDegree: 'Connection Degree',
  lastSynced:       'Last Synced',
};

// ── Config loading ─────────────────────────────────────────────────────────
async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['apiKey', 'baseId', 'tableId', 'fieldMap', 'recruitmentAppUrl'],
      (items) => {
        resolve({
          apiKey:            items.apiKey            || null,
          baseId:            items.baseId            || null,
          tableId:           items.tableId           || null,
          fieldMap:          items.fieldMap          || DEFAULT_FIELD_MAP,
          recruitmentAppUrl: items.recruitmentAppUrl || null,
        });
      }
    );
  });
}

// ── Airtable helpers ───────────────────────────────────────────────────────
async function airtableRequest(method, path, apiKey, body = null) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${AIRTABLE_BASE_URL}${path}`, options);
  const json = await response.json();

  if (!response.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return json;
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

// ── Core sync logic ────────────────────────────────────────────────────────
async function syncToAirtable(profileData) {
  const config = await loadConfig();

  if (!config.apiKey || !config.baseId || !config.tableId) {
    return { error: 'NOT_CONFIGURED' };
  }

  const { apiKey, baseId, tableId, fieldMap } = config;
  const tablePath = `/${baseId}/${encodeURIComponent(tableId)}`;
  const profileUrl = profileData.linkedinUrl;

  // 1. Search for existing record by LinkedIn URL
  let existingRecord = null;
  try {
    const searchUrl = `${tablePath}?filterByFormula=(${encodeURIComponent(
      `{${fieldMap.linkedinUrl}}="${profileUrl}"`
    )})`;
    const searchResult = await airtableRequest('GET', searchUrl, apiKey);
    if (searchResult.records && searchResult.records.length > 0) {
      existingRecord = searchResult.records[0];
    }
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  }

  const now = new Date().toISOString();

  // Build full field object from extracted data
  function buildFields(data, fmap) {
    const fields = {};
    const mapping = {
      linkedinUrl:      data.linkedinUrl,
      fullName:         data.fullName,
      headline:         data.headline,
      location:         data.location,
      currentCompany:   data.currentCompany,
      currentTitle:     data.currentTitle,
      about:            data.about,
      workHistory:      data.workHistory,
      education:        data.education,
      skills:           data.skills,
      photoUrl:         data.photoUrl,
      connectionDegree: data.connectionDegree,
    };

    for (const [key, value] of Object.entries(mapping)) {
      const fieldName = fmap[key];
      if (fieldName && !isBlank(value)) {
        fields[fieldName] = value;
      }
    }
    return fields;
  }

  if (!existingRecord) {
    // 2. Create new record
    try {
      const fields = buildFields(profileData, fieldMap);
      fields[fieldMap.lastSynced] = now;

      const result = await airtableRequest('POST', tablePath, apiKey, {
        records: [{ fields }],
      });

      const recordId = result.records?.[0]?.id;
      await saveLastSync({ profileUrl, action: 'created', recordId, timestamp: now, profileData });
      return { action: 'created', recordId };
    } catch (err) {
      return { error: `Create failed: ${err.message}` };
    }
  } else {
    // 3. Update existing record — only patch blank fields
    try {
      const existingFields = existingRecord.fields;
      const patch = {};

      const mapping = {
        linkedinUrl:      profileData.linkedinUrl,
        fullName:         profileData.fullName,
        headline:         profileData.headline,
        location:         profileData.location,
        currentCompany:   profileData.currentCompany,
        currentTitle:     profileData.currentTitle,
        about:            profileData.about,
        workHistory:      profileData.workHistory,
        education:        profileData.education,
        skills:           profileData.skills,
        photoUrl:         profileData.photoUrl,
        connectionDegree: profileData.connectionDegree,
      };

      // These fields are always overwritten so the most complete scraped data wins
      const alwaysUpdate = new Set(['workHistory', 'education', 'skills', 'location']);

      for (const [key, newValue] of Object.entries(mapping)) {
        const fieldName = fieldMap[key];
        if (!fieldName || isBlank(newValue)) continue;
        // Always overwrite list fields; only patch other fields when blank
        if (alwaysUpdate.has(key) || isBlank(existingFields[fieldName])) {
          patch[fieldName] = newValue;
        }
      }

      // Always update Last Synced
      patch[fieldMap.lastSynced] = now;

      const recordId = existingRecord.id;
      await airtableRequest('PATCH', `${tablePath}/${recordId}`, apiKey, {
        fields: patch,
      });

      await saveLastSync({ profileUrl, action: 'updated', recordId, timestamp: now, profileData });
      return { action: 'updated', recordId };
    } catch (err) {
      return { error: `Update failed: ${err.message}` };
    }
  }
}

// ── Storage helpers ────────────────────────────────────────────────────────
async function saveLastSync(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ lastSync: data }, resolve);
  });
}

// ── Lancor sync ────────────────────────────────────────────────────────────
async function syncToLancor(profileData) {
  const config = await loadConfig();
  const baseUrl = (config.recruitmentAppUrl || 'http://localhost:3000').replace(/\/$/, '');

  let workHistoryParsed = [];
  if (profileData.workHistory) {
    try {
      workHistoryParsed = typeof profileData.workHistory === 'string'
        ? JSON.parse(profileData.workHistory)
        : profileData.workHistory;
    } catch {}
  }

  // Clean title: take only the first segment before " | " or " · "
  const rawTitle = profileData.currentTitle || '';
  const cleanTitle = rawTitle.split(/\s*[|·]\s*/)[0].trim();

  const payload = {
    fullName:       profileData.fullName       || '',
    currentTitle:   cleanTitle,
    currentCompany: profileData.currentCompany || '',
    location:       profileData.location       || '',
    linkedinUrl:    profileData.linkedinUrl    || '',
    photoUrl:       profileData.photoUrl       || '',
    workHistory:    workHistoryParsed,
  };

  const res = await fetch(`${baseUrl}/api/candidates/prefill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json; // { action: 'created'|'updated', id }
}

// ── Message handler ────────────────────────────────────────────────────────
// Process immediately — content.js already debounces before sending.
// No setTimeout here: MV3 service workers can be terminated before a delayed
// callback fires, causing silent sync failures.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'SYNC_PROFILE') return false;

  async function handleSync() {
    const now = new Date().toISOString();

    // Always attempt Lancor sync (independent of Airtable config)
    const lancorResult = await syncToLancor(message.data).catch(e => ({ error: e.message }));

    // Attempt Airtable sync (only succeeds if configured)
    const airtableResult = await syncToAirtable(message.data).catch(e => ({ error: e.message }));

    // Persist combined result for popup to read
    await saveLastSync({
      profileUrl:    message.data.linkedinUrl,
      action:        lancorResult.action || airtableResult.action || 'unknown',
      lancorResult,
      airtableResult,
      timestamp:     now,
      profileData:   message.data,
    });

    return { lancorResult, airtableResult };
  }

  handleSync().then(result => {
    logSyncResult(message.data.linkedinUrl, 'success', result);
    sendResponse(result);
  }).catch(err => {
    logSyncResult(message.data.linkedinUrl, 'error', err.message);
    sendResponse({ error: err.message });
  });

  // Return true to keep the message channel open for the async response
  return true;
});

// ── Sync logging (persists last 20 results for debugging) ────────────────────

async function logSyncResult(url, status, detail) {
  try {
    const { syncLog = [] } = await chrome.storage.local.get(['syncLog']);
    syncLog.unshift({
      url: url || 'unknown',
      status,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200),
      timestamp: new Date().toISOString()
    });
    // Keep only last 20 entries
    if (syncLog.length > 20) syncLog.length = 20;
    await chrome.storage.local.set({ syncLog });
  } catch { /* ignore storage errors */ }
}
