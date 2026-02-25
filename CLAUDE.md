# CLAUDE.md — ATS LinkedIn Scraper

This file is read by Claude Code at the start of every session. Keep it up to date.

---

## Project Overview

A Manifest V3 Chrome extension (`ats_scraper`) that auto-fires on LinkedIn profile pages, extracts candidate data from the DOM, and upserts it into an Airtable base. Zero-click workflow: visit a LinkedIn `/in/` profile and the record appears (or updates) in the ATS.

---

## File Structure

```
manifest.json    MV3 manifest — permissions, content script, service worker
content.js       MutationObserver, DOM extraction, status indicator injection, SPA nav
background.js    Service worker: Airtable API calls (GET/POST/PATCH), debounce
popup.html       Extension toolbar popup
popup.js         Reads chrome.storage.local to display last sync result
options.html     Settings form: API key, Base ID, Table ID, field mappings
options.js       Saves/loads config from chrome.storage.local
styles.css       Status indicator styles injected into LinkedIn page
CLAUDE.md        This file
README.md        One-liner project description
```

---

## Architecture

### Data Flow
1. User visits `linkedin.com/in/<profile>`
2. `content.js` fires (via manifest `content_scripts` declaration)
3. MutationObserver waits for `h1` to appear, then waits 1500ms for page to settle
4. DOM extraction runs — clicks "show more" buttons, scrapes all sections
5. `chrome.runtime.sendMessage({type: 'SYNC_PROFILE', data})` sent to `background.js`
6. `background.js` debounces (1500ms per-tab), then calls Airtable API
7. Airtable GET checks for existing record by LinkedIn URL
8. POST (new) or PATCH (existing, blank fields only) — always updates Last Synced
9. Response sent back to `content.js` → status indicator updates

### Key Decisions

| Concern | Solution |
|---|---|
| CORS | All Airtable fetch calls in `background.js` (service worker), never `content.js` |
| SPA navigation | Dual layer: `chrome.tabs.onUpdated` re-injects `content.js` + `lastUrl` tracking in MutationObserver |
| Debounce | 1500ms per-tab timer (`Map<tabId, timeoutId>`) in `background.js` |
| Upsert | Never overwrite populated Airtable fields; always update `Last Synced` |
| Serialization | Work History, Education, Skills stored as JSON strings (Airtable long text) |
| Resilience | Every DOM selector wrapped in try/catch; returns null on failure |

### chrome.storage.local Keys
- `apiKey` — Airtable Personal Access Token
- `baseId` — Airtable Base ID (app...)
- `tableId` — Airtable Table ID or name
- `fieldMap` — Object mapping data keys to Airtable column names (see below)
- `lastSync` — Object: `{ profileUrl, action, recordId, timestamp }` (written after each sync)

### fieldMap Keys (defaults)
```
linkedinUrl      → "LinkedIn URL"
fullName         → "Full Name"
headline         → "Headline"
location         → "Location"
currentCompany   → "Current Company"
currentTitle     → "Current Title"
about            → "About"
workHistory      → "Work History"
education        → "Education"
skills           → "Skills"
photoUrl         → "Photo URL"
connectionDegree → "Connection Degree"
followers        → "Followers"
connections      → "Connections"
lastSynced       → "Last Synced"
```

---

## Loading the Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this project directory
4. Click the extension icon in the toolbar → **Open Settings**
5. Enter Airtable Personal Access Token, Base ID, and Table ID
6. Click **Test Connection** to verify, then **Save Settings**
7. Navigate to any `https://www.linkedin.com/in/` profile to trigger a sync

---

## Airtable Setup Requirements

Your Airtable table must have columns matching the field map names (or reconfigure in Options):

| Column | Type | Notes |
|---|---|---|
| LinkedIn URL | Single line text | Used as unique key for upsert lookups |
| Full Name | Single line text | |
| Headline | Single line text | |
| Location | Single line text | |
| Current Company | Single line text | |
| Current Title | Single line text | |
| About | Long text | |
| Work History | Long text | JSON array of `{title, company, dates, description}` |
| Education | Long text | JSON array of `{institution, degree, dates}` |
| Skills | Long text | JSON array of strings |
| Photo URL | URL | |
| Connection Degree | Single line text | "1st", "2nd", "3rd+" |
| Followers | Single line text | |
| Connections | Single line text | |
| Last Synced | Single line text or Date | ISO 8601 string |

The Personal Access Token needs scopes: `data.records:read`, `data.records:write`.

---

## Actions Taken

### Session 1 — 2026-02-24
- Planned and implemented the full extension from scratch
- Created all 8 project files: `manifest.json`, `content.js`, `background.js`, `popup.html`, `popup.js`, `options.html`, `options.js`, `styles.css`
- Implemented MV3-compliant service worker pattern (no persistent background page)
- Implemented dual-layer SPA navigation handling
- Implemented smart Airtable upsert (never overwrite, always update Last Synced)
- Implemented status indicator injected into LinkedIn DOM with auto-fade on success

---

## Still To Do / Known Limitations

### Not Yet Implemented
- [ ] Extension icons (16px, 48px, 128px PNG files) — manifest references none currently; Chrome will show a default puzzle-piece icon
- [ ] Rate limit handling — no retry/backoff on Airtable HTTP 429 responses
- [ ] Debug logging — no persistent error log; failed syncs only show in the status indicator
- [ ] Bulk sync — no way to re-sync a profile without navigating away and back
- [ ] Manual "Sync Now" button in popup

### Known Fragility
- LinkedIn DOM selectors will break when LinkedIn updates their front-end (they do this regularly). When that happens, update the selector functions in `content.js`:
  - `extractName()` — relies on `h1`
  - `extractHeadline()` — relies on `.text-body-medium.break-words`
  - `extractLocation()` — relies on `.text-body-small.inline.t-black--light.break-words`
  - `parseExperienceItems()` / `parseEducationItems()` / `parseSkillItems()` — rely on `li.artdeco-list__item` and `.t-bold span[aria-hidden="true"]`
- The "show more" expander targets `button[aria-label*="more"]` — may need updating if LinkedIn changes button labels

### Testing Checklist
- [ ] First sync on a new profile → creates record in Airtable with all fields
- [ ] Re-visit same profile → updates only Last Synced, no other fields overwritten
- [ ] Navigate between profiles rapidly → only one Airtable call fires per profile (debounce)
- [ ] Visit profile with no internet → status shows "✗ Error: ..."
- [ ] Open extension without configuring → status shows "✗ Configure extension first"
- [ ] Options page: Save → Test Connection → verify Airtable responds

---

## Common Issues

**Status indicator never appears**
→ Check `chrome://extensions` for extension errors. Most likely the content script failed to inject. Try reloading the extension.

**"Configure extension first" on every profile**
→ Open Options, fill in all three fields (API key, Base ID, Table ID), and Save.

**Airtable records created but fields are empty**
→ Column names in Airtable don't match the field map. Open Options and update the right-side field name inputs to exactly match your Airtable column names (case-sensitive).

**Only "Last Synced" updates on revisits**
→ This is correct behavior — the extension never overwrites existing data.

**SPA navigation not triggering re-sync**
→ The background service worker may have been terminated. Navigate away and back, or reload the extension from `chrome://extensions`.
