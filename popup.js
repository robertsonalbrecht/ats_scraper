'use strict';

document.getElementById('optionsLink').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Enable/disable toggle
const toggle = document.getElementById('enableToggle');
chrome.storage.local.get(['enabled'], (result) => {
  toggle.checked = result.enabled !== false; // default on
});
toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const box = document.getElementById('statusBox');
  const lancorBox = document.getElementById('lancorStatusBox');
  const meta = document.getElementById('metaInfo');
  const recordEl = document.getElementById('recordId');

  if (!tab || !tab.url || !/linkedin\.com\/in\//.test(tab.url)) {
    box.textContent = 'Open a LinkedIn profile to sync.';
    box.className = 'status-box idle';
    if (lancorBox) { lancorBox.textContent = 'Open a LinkedIn profile to sync.'; lancorBox.className = 'status-box idle'; }
    return;
  }

  chrome.storage.local.get(['lastSync', 'recruitmentAppUrl'], (result) => {
    const sync = result.lastSync;
    const recruitmentAppUrl = (result.recruitmentAppUrl || 'http://localhost:3000').replace(/\/$/, '');

    // ── Lancor status ──────────────────────────────────────────────────────
    if (lancorBox) {
      if (!sync) {
        lancorBox.textContent = 'Lancor: no sync yet — visit a profile.';
        lancorBox.className = 'status-box idle';
      } else if (sync.lancorResult && !sync.lancorResult.error) {
        const action = sync.lancorResult.action === 'created' ? 'Added to pool ✓' : 'Profile updated ✓';
        lancorBox.textContent = `Lancor: ${action}`;
        lancorBox.className = 'status-box synced';
      } else if (sync.lancorResult && sync.lancorResult.error) {
        lancorBox.textContent = `Lancor: ${sync.lancorResult.error}`;
        lancorBox.className = 'status-box error';
      } else {
        lancorBox.textContent = 'Lancor: syncing…';
        lancorBox.className = 'status-box idle';
      }
    }

    // ── Airtable status ────────────────────────────────────────────────────
    if (!sync) {
      box.textContent = 'No sync recorded yet.';
      box.className = 'status-box idle';
      return;
    }

    const profileUrl = tab.url.split('?')[0];
    if (sync.profileUrl && sync.profileUrl !== profileUrl) {
      box.textContent = 'No Airtable sync for this profile yet.';
      box.className = 'status-box idle';
    } else if (sync.airtableResult && !sync.airtableResult.error) {
      box.textContent = `\u2713 Airtable synced (${sync.airtableResult.action || 'updated'})`;
      box.className = 'status-box synced';
    } else if (sync.airtableResult && sync.airtableResult.error === 'NOT_CONFIGURED') {
      box.textContent = 'Airtable: not configured (optional).';
      box.className = 'status-box idle';
    } else {
      box.textContent = `\u2713 Synced (${sync.action || 'updated'})`;
      box.className = 'status-box synced';
    }

    if (sync.timestamp) {
      meta.textContent = `Last synced: ${new Date(sync.timestamp).toLocaleString()}`;
    }
    if (sync.recordId) {
      recordEl.textContent = `Record: ${sync.recordId}`;
    }

    // Show recruitment section whenever we have a sync for this profile
    // (Lancor sync is sufficient — Airtable is optional)
    const hasLancorSync = sync.lancorResult && !sync.lancorResult.error;
    const profileMatch = !sync.profileUrl || sync.profileUrl === profileUrl;
    if (profileMatch && (hasLancorSync || sync.action)) {
      showRecruitSection(sync, recruitmentAppUrl);
    }
  });
});

// ── Recruitment App section ────────────────────────────────────────────────

function showRecruitSection(sync, recruitmentAppUrl) {
  const section = document.getElementById('recruitSection');
  section.style.display = 'block';

  // Parse workHistory — stored as JSON string in profileData
  let workItems = [];
  if (sync.profileData && sync.profileData.workHistory) {
    try {
      workItems = JSON.parse(sync.profileData.workHistory);
    } catch (e) {}
  }

  // Filter for active roles: dates contains "Present" or is null/blank
  const activeRoles = workItems.filter(item => !item.dates || /present/i.test(item.dates));

  // Fallback chain when workHistory scrape failed:
  // 1. currentTitle/currentCompany (extracted from first work history entry)
  // 2. First segment of headline (e.g. "CEO | Capital-Aligned..." → "CEO")
  const profileData = sync.profileData || {};
  if (activeRoles.length === 0) {
    const title = profileData.currentTitle
      || (profileData.headline ? profileData.headline.split('|')[0].trim() : '');
    const company = profileData.currentCompany || '';
    if (title || company) {
      activeRoles.push({ title, company, dates: 'Present' });
    }
  }

  const employerSelect = document.getElementById('employerSelect');
  employerSelect.innerHTML = '';
  if (activeRoles.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no active roles found)';
    employerSelect.appendChild(opt);
  } else {
    activeRoles.forEach((item, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      // Show company as primary label; clean title (first segment before |) as hint
      const cleanTitle = (item.title || '').split(/\s*[|·]\s*/)[0].trim();
      opt.textContent = item.company
        ? `${item.company}${cleanTitle ? '  —  ' + cleanTitle : ''}`
        : cleanTitle;
      employerSelect.appendChild(opt);
    });
  }

  // Fetch search projects
  const searchSelect = document.getElementById('searchSelect');
  fetchSearchProjects(recruitmentAppUrl, searchSelect);

  // Wire up send button
  document.getElementById('sendToRecruitBtn').addEventListener('click', () => {
    sendToRecruitApp(sync, activeRoles, recruitmentAppUrl);
  });
}

async function fetchSearchProjects(recruitmentAppUrl, searchSelect) {
  searchSelect.innerHTML = '';
  searchSelect.className = 'recruit-select';
  const loadOpt = document.createElement('option');
  loadOpt.textContent = 'Loading\u2026';
  loadOpt.disabled = true;
  searchSelect.appendChild(loadOpt);

  try {
    const res = await fetch(`${recruitmentAppUrl}/api/searches/active`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const searches = await res.json();

    searchSelect.innerHTML = '';
    if (searches.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no active searches)';
      searchSelect.appendChild(opt);
    } else {
      searches.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        searchSelect.appendChild(opt);
      });
    }
  } catch (e) {
    searchSelect.innerHTML = '';
    searchSelect.className = 'recruit-select error';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = `Error: ${e.message}`;
    opt.disabled = true;
    searchSelect.appendChild(opt);
  }
}

async function sendToRecruitApp(sync, activeRoles, recruitmentAppUrl) {
  const btn = document.getElementById('sendToRecruitBtn');
  const statusEl = document.getElementById('sendStatus');
  const employerSelect = document.getElementById('employerSelect');
  const searchSelect = document.getElementById('searchSelect');

  btn.disabled = true;
  btn.textContent = 'Sending\u2026';
  statusEl.className = 'send-status';

  const selectedIdx = parseInt(employerSelect.value, 10);
  const selectedRole = (!isNaN(selectedIdx) && activeRoles[selectedIdx]) ? activeRoles[selectedIdx] : {};
  const searchId = searchSelect.value || null;

  const profileData = sync.profileData || {};

  let workHistoryParsed = [];
  if (profileData.workHistory) {
    try { workHistoryParsed = JSON.parse(profileData.workHistory); } catch (e) {}
  }

  // Clean title: take only the first segment before " | " or " · "
  const rawTitle = selectedRole.title || profileData.currentTitle || '';
  const cleanTitle = rawTitle.split(/\s*[|·]\s*/)[0].trim();

  const payload = {
    fullName:       profileData.fullName       || '',
    currentTitle:   cleanTitle,
    currentCompany: selectedRole.company       || profileData.currentCompany || '',
    location:       profileData.location       || '',
    linkedinUrl:    profileData.linkedinUrl    || sync.profileUrl || '',
    workHistory:    workHistoryParsed,
    searchId,
  };

  try {
    const res = await fetch(`${recruitmentAppUrl}/api/candidates/prefill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    btn.textContent = '\u2713 Sent';
    statusEl.textContent = 'Candidate added to recruitment app';
    statusEl.className = 'send-status ok';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Send to Recruitment App';
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.className = 'send-status fail';
  }
}
