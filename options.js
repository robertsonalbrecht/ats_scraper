'use strict';

const FIELD_DEFS = [
  { key: 'linkedinUrl',      label: 'LinkedIn URL',       default: 'LinkedIn URL' },
  { key: 'fullName',         label: 'Full Name',          default: 'Full Name' },
  { key: 'headline',         label: 'Headline',           default: 'Headline' },
  { key: 'location',         label: 'Location',           default: 'Location' },
  { key: 'currentCompany',   label: 'Current Company',    default: 'Current Company' },
  { key: 'currentTitle',     label: 'Current Title',      default: 'Current Title' },
  { key: 'about',            label: 'About',              default: 'About' },
  { key: 'workHistory',      label: 'Work History',       default: 'Work History' },
  { key: 'education',        label: 'Education',          default: 'Education' },
  { key: 'skills',           label: 'Skills',             default: 'Skills' },
  { key: 'photoUrl',         label: 'Photo URL',          default: 'Photo URL' },
  { key: 'connectionDegree', label: 'Connection Degree',  default: 'Connection Degree' },
  { key: 'followers',        label: 'Followers',          default: 'Followers' },
  { key: 'connections',      label: 'Connections',        default: 'Connections' },
  { key: 'lastSynced',       label: 'Last Synced',        default: 'Last Synced' },
];

function renderFieldMappings(savedMap) {
  const container = document.getElementById('fieldMappings');
  container.innerHTML = '';

  for (const field of FIELD_DEFS) {
    const row = document.createElement('div');
    row.className = 'field-row';

    const label = document.createElement('span');
    label.textContent = `${field.label} →`;

    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.key = field.key;
    input.value = (savedMap && savedMap[field.key]) ? savedMap[field.key] : field.default;
    input.placeholder = field.default;

    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);
  }
}

// Load saved settings
chrome.storage.local.get(['apiKey', 'baseId', 'tableId', 'fieldMap'], (stored) => {
  document.getElementById('apiKey').value  = stored.apiKey  || '';
  document.getElementById('baseId').value  = stored.baseId  || '';
  document.getElementById('tableId').value = stored.tableId || '';
  renderFieldMappings(stored.fieldMap || {});
});

// Save settings
document.getElementById('saveBtn').addEventListener('click', () => {
  const fieldMap = {};
  document.querySelectorAll('#fieldMappings input[data-key]').forEach(input => {
    fieldMap[input.dataset.key] = input.value.trim() || input.placeholder;
  });

  const data = {
    apiKey:   document.getElementById('apiKey').value.trim(),
    baseId:   document.getElementById('baseId').value.trim(),
    tableId:  document.getElementById('tableId').value.trim(),
    fieldMap,
  };

  chrome.storage.local.set(data, () => {
    showStatus('Settings saved ✓', true);
  });
});

// Test connection
document.getElementById('testBtn').addEventListener('click', async () => {
  const apiKey  = document.getElementById('apiKey').value.trim();
  const baseId  = document.getElementById('baseId').value.trim();
  const tableId = document.getElementById('tableId').value.trim();

  if (!apiKey || !baseId || !tableId) {
    showStatus('Fill in all credential fields first.', false);
    return;
  }

  showStatus('Testing...', null);

  try {
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}?maxRecords=1`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    if (res.ok) {
      showStatus('Connection successful ✓', true);
    } else {
      const err = await res.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${res.status}`;
      showStatus(`Error: ${msg}`, false);
    }
  } catch (e) {
    showStatus(`Network error: ${e.message}`, false);
  }
});

function showStatus(message, ok) {
  const el = document.getElementById('statusMsg');
  el.textContent = message;
  el.className = ok === true ? 'ok' : ok === false ? 'fail' : '';

  if (ok !== null) {
    setTimeout(() => {
      el.textContent = '';
      el.className = '';
    }, 4000);
  }
}
