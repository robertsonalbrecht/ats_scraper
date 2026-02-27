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
  const meta = document.getElementById('metaInfo');
  const recordEl = document.getElementById('recordId');

  if (!tab || !tab.url || !/linkedin\.com\/in\//.test(tab.url)) {
    box.textContent = 'Open a LinkedIn profile to sync.';
    box.className = 'status-box idle';
    return;
  }

  chrome.storage.local.get(['lastSync'], (result) => {
    const sync = result.lastSync;

    if (!sync) {
      box.textContent = 'No sync recorded yet.';
      box.className = 'status-box idle';
      return;
    }

    const profileUrl = tab.url.split('?')[0];
    if (sync.profileUrl && sync.profileUrl !== profileUrl) {
      box.textContent = 'No sync for this profile yet.';
      box.className = 'status-box idle';
      return;
    }

    box.textContent = `✓ Synced (${sync.action || 'updated'})`;
    box.className = 'status-box synced';

    if (sync.timestamp) {
      meta.textContent = `Last synced: ${new Date(sync.timestamp).toLocaleString()}`;
    }
    if (sync.recordId) {
      recordEl.textContent = `Record: ${sync.recordId}`;
    }
  });
});
