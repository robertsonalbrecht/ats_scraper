'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';
const DEBOUNCE_MS = 1500;

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
  followers:        'Followers',
  connections:      'Connections',
  lastSynced:       'Last Synced',
};

// Per-tab debounce timers: tabId → timeoutId
const debounceMap = new Map();

// ── Config loading ─────────────────────────────────────────────────────────
async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['apiKey', 'baseId', 'tableId', 'fieldMap'],
      (items) => {
        resolve({
          apiKey:   items.apiKey   || null,
          baseId:   items.baseId   || null,
          tableId:  items.tableId  || null,
          fieldMap: items.fieldMap || DEFAULT_FIELD_MAP,
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
      followers:        data.followers,
      connections:      data.connections,
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
      await saveLastSync({ profileUrl, action: 'created', recordId, timestamp: now });
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
        followers:        profileData.followers,
        connections:      profileData.connections,
      };

      for (const [key, newValue] of Object.entries(mapping)) {
        const fieldName = fieldMap[key];
        if (!fieldName || isBlank(newValue)) continue;
        // Only patch if existing field is blank
        if (isBlank(existingFields[fieldName])) {
          patch[fieldName] = newValue;
        }
      }

      // Always update Last Synced
      patch[fieldMap.lastSynced] = now;

      const recordId = existingRecord.id;
      await airtableRequest('PATCH', `${tablePath}/${recordId}`, apiKey, {
        fields: patch,
      });

      await saveLastSync({ profileUrl, action: 'updated', recordId, timestamp: now });
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

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'SYNC_PROFILE') return false;

  const tabId = sender.tab?.id;

  // Debounce per tab
  if (tabId && debounceMap.has(tabId)) {
    clearTimeout(debounceMap.get(tabId));
  }

  const timerId = setTimeout(async () => {
    if (tabId) debounceMap.delete(tabId);
    try {
      const result = await syncToAirtable(message.data);
      sendResponse(result);
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }, DEBOUNCE_MS);

  if (tabId) debounceMap.set(tabId, timerId);

  // Keep message channel open for async sendResponse
  return true;
});

// ── SPA navigation backup: re-inject content script on LinkedIn profile URLs ──
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !/linkedin\.com\/in\//.test(tab.url)) return;

  // Re-inject content script to handle SPA navigation where manifest
  // content_scripts may not re-fire
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  }).catch(() => {
    // Tab may have navigated away or script already running — ignore
  });
});
