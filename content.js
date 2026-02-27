(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let lastUrl = '';
  let indicator = null;
  let extractionTimeout = null;
  let observer = null;
  let extensionEnabled = true; // kept in sync with chrome.storage; true by default

  // Initialise from storage immediately so the flag is accurate before init() runs
  chrome.storage.local.get(['enabled'], (r) => { extensionEnabled = r.enabled !== false; });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function normalizeProfileUrl(href) {
    const match = href.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/);
    return match ? `https://www.linkedin.com/in/${match[1]}/` : href.split('?')[0];
  }

  function safeText(el) {
    try {
      return el ? el.innerText.trim() || null : null;
    } catch {
      return null;
    }
  }

  function safeQuery(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function safeQueryAll(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  // ── Status indicator ───────────────────────────────────────────────────────
  function ensureIndicator() {
    if (indicator && document.body.contains(indicator)) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'ats-status-indicator';

    const textEl = document.createElement('span');
    textEl.id = 'ats-status-text';
    indicator.appendChild(textEl);

    const btn = document.createElement('button');
    btn.id = 'ats-sync-btn';
    btn.textContent = '↺ Sync';
    btn.addEventListener('click', () => {
      if (!btn.disabled) runSync();
    });
    indicator.appendChild(btn);

    document.body.appendChild(indicator);
    return indicator;
  }

  function setStatus(state, message) {
    const el = ensureIndicator();
    el.classList.remove('ats-fade-out');
    el.dataset.state = state;

    const textEl = el.querySelector('#ats-status-text');
    if (textEl) textEl.textContent = message;

    const btn = el.querySelector('#ats-sync-btn');
    if (btn) btn.disabled = (state === 'syncing');

    if (state === 'success') {
      setTimeout(() => {
        el.classList.add('ats-fade-out');
      }, 5000);
    }
  }

  // ── DOM extraction ─────────────────────────────────────────────────────────
  function extractName() {
    try {
      const h1 = document.querySelector('h1');
      return safeText(h1);
    } catch { return null; }
  }

  function extractHeadline() {
    try {
      // Primary selector
      let el = safeQuery('.text-body-medium.break-words');
      if (el) return safeText(el);
      // Fallback: sibling div after h1
      const h1 = document.querySelector('h1');
      if (h1) {
        let sibling = h1.nextElementSibling;
        while (sibling) {
          const text = safeText(sibling);
          if (text && text.length > 2) return text;
          sibling = sibling.nextElementSibling;
        }
      }
      return null;
    } catch { return null; }
  }

  function extractLocation() {
    try {
      const el = safeQuery('.text-body-small.inline.t-black--light.break-words');
      return safeText(el);
    } catch { return null; }
  }

  function extractPhotoUrl() {
    try {
      let img = safeQuery('img.pv-top-card-profile-picture__image--show');
      if (img) return img.src || null;
      img = safeQuery('img[class*="profile-photo-edit"]');
      if (img) return img.src || null;
      // Broader fallback
      img = safeQuery('img[class*="profile-picture"]');
      if (img) return img.src || null;
      return null;
    } catch { return null; }
  }

  function extractAbout() {
    try {
      const sections = safeQueryAll('section');
      for (const section of sections) {
        const heading = safeQuery('h2', section);
        if (heading && /about/i.test(heading.innerText)) {
          // The about text lives in a div/span after the heading
          const textDiv = safeQuery('.display-flex.ph5.pv3', section)
            || safeQuery('[class*="full-width"] span[aria-hidden="true"]', section)
            || safeQuery('div[class*="display-flex"] span[aria-hidden="true"]', section);
          if (textDiv) return safeText(textDiv);
          // Fallback: grab all visible text in section
          const spans = safeQueryAll('span[aria-hidden="true"]', section);
          const texts = spans.map(s => safeText(s)).filter(Boolean);
          return texts.join(' ').trim() || null;
        }
      }
      return null;
    } catch { return null; }
  }

  function extractConnectionDegree() {
    try {
      const el = safeQuery('.dist-value');
      return safeText(el);
    } catch { return null; }
  }

  function extractFollowersConnections() {
    try {
      const spans = safeQueryAll('span');
      let followers = null;
      let connections = null;
      for (const span of spans) {
        const text = span.innerText || '';
        if (/follower/i.test(text) && !followers) {
          followers = text.trim();
        }
        if (/connection/i.test(text) && !connections) {
          connections = text.trim();
        }
      }
      return { followers, connections };
    } catch { return { followers: null, connections: null }; }
  }

  function findSectionByHeading(heading) {
    try {
      const sections = safeQueryAll('section');
      for (const section of sections) {
        const h2 = safeQuery('h2', section);
        if (h2 && new RegExp(heading, 'i').test(h2.innerText)) {
          return section;
        }
      }
      return null;
    } catch { return null; }
  }

  async function expandSection(sectionEl) {
    if (!sectionEl) return;
    try {
      const btns = safeQueryAll(
        'button[aria-label*="more"], button[aria-label*="More"]',
        sectionEl
      );
      btns.forEach(btn => {
        try { btn.click(); } catch {}
      });
      await sleep(800);
    } catch {}
  }

  function parseExperienceItems(sectionEl) {
    try {
      const items = [];
      const listItems = safeQueryAll('li.artdeco-list__item', sectionEl);

      for (const li of listItems) {
        try {
          const titleEl = safeQuery('.t-bold span[aria-hidden="true"]', li);
          const title = safeText(titleEl);
          if (!title) continue; // skip non-content items

          const companyEl = safeQuery('.t-14.t-normal span[aria-hidden="true"]', li);
          const company = safeText(companyEl);

          const dateEl = safeQuery('.t-14.t-normal.t-black--light span[aria-hidden="true"]', li);
          const dates = safeText(dateEl);

          const descEl = safeQuery('.pvs-list__outer-container', li);
          const description = safeText(descEl);

          items.push({ title, company, dates, description });
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  function parseEducationItems(sectionEl) {
    try {
      const items = [];
      const listItems = safeQueryAll('li.artdeco-list__item', sectionEl);

      for (const li of listItems) {
        try {
          const institutionEl = safeQuery('.t-bold span[aria-hidden="true"]', li);
          const institution = safeText(institutionEl);
          if (!institution) continue;

          const degreeEl = safeQuery('.t-14.t-normal span[aria-hidden="true"]', li);
          const degree = safeText(degreeEl);

          const dateEl = safeQuery('.t-14.t-normal.t-black--light span[aria-hidden="true"]', li);
          const dates = safeText(dateEl);

          items.push({ institution, degree, dates });
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  function parseSkillItems(sectionEl) {
    try {
      const items = [];
      const listItems = safeQueryAll('li.artdeco-list__item', sectionEl);

      for (const li of listItems) {
        try {
          const skillEl = safeQuery('.hoverable-link-text span[aria-hidden="true"]', li)
            || safeQuery('.t-bold span[aria-hidden="true"]', li);
          const skill = safeText(skillEl);
          if (skill) items.push(skill);
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  async function extractAllExperiences() {
    // Already on the experience detail page — scrape it directly
    if (/\/details\/experience/.test(window.location.href)) {
      const container = findSectionByHeading('experience') || safeQuery('main') || document.body;
      await expandSection(container);
      return parseExperienceItems(container);
    }

    // Look for a "Show all X experiences" link inside the experience section
    const expSection = findSectionByHeading('experience');
    const showAllLink = safeQuery('a[href*="/details/experience"]', expSection || document);

    if (!showAllLink) {
      // All experiences are already shown inline
      await expandSection(expSection);
      return parseExperienceItems(expSection);
    }

    // Navigate to the full experience detail page
    showAllLink.click();
    await sleep(2500);

    // Scrape all experiences from the detail page
    const container = findSectionByHeading('experience') || safeQuery('main') || document.body;
    await expandSection(container);
    const items = parseExperienceItems(container);

    // Navigate back to the main profile
    window.history.back();
    await sleep(1500);

    return items;
  }

  async function extractProfileData() {
    const profileUrl = normalizeProfileUrl(window.location.href);

    // Extract all stable fields from the main page before any navigation
    const name = extractName();
    const headline = extractHeadline();
    const location = extractLocation();
    const photoUrl = extractPhotoUrl();
    const about = extractAbout();
    const connectionDegree = extractConnectionDegree();
    const { followers, connections } = extractFollowersConnections();

    // Expand and extract education/skills (inline, no navigation needed)
    const eduSection = findSectionByHeading('education');
    const skillSection = findSectionByHeading('skills');
    await Promise.all([expandSection(eduSection), expandSection(skillSection)]);
    const education = parseEducationItems(eduSection);
    const skills = parseSkillItems(skillSection);

    // Extract all experiences — navigates to detail page and back if needed
    const workHistory = await extractAllExperiences();

    const currentEntry = workHistory[0] || {};

    return {
      linkedinUrl: profileUrl,
      fullName: name,
      headline,
      location,
      photoUrl,
      about,
      connectionDegree,
      followers,
      connections,
      currentTitle: currentEntry.title || null,
      currentCompany: currentEntry.company || null,
      workHistory: workHistory.length ? JSON.stringify(workHistory) : null,
      education: education.length ? JSON.stringify(education) : null,
      skills: skills.length ? JSON.stringify(skills) : null,
    };
  }

  // ── Main sync flow ─────────────────────────────────────────────────────────
  async function runSync() {
    if (!extensionEnabled) return;
    setStatus('syncing', '↑ Syncing...');

    let profileData;
    try {
      profileData = await extractProfileData();
    } catch (err) {
      setStatus('error', `✗ Extraction failed: ${err.message}`);
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'SYNC_PROFILE', data: profileData },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('error', `✗ Extension error: ${chrome.runtime.lastError.message}`);
          return;
        }
        if (!response) {
          setStatus('error', '✗ No response from background');
          return;
        }
        if (response.error) {
          if (response.error === 'NOT_CONFIGURED') {
            setStatus('error', '✗ Configure extension first');
          } else {
            setStatus('error', `✗ Error: ${response.error}`);
          }
          return;
        }
        const action = response.action === 'created' ? 'created' : 'updated';
        setStatus('success', `✓ Synced (${action})`);
      }
    );
  }

  // ── SPA-aware initialization ───────────────────────────────────────────────
  function isProfilePage() {
    return /linkedin\.com\/in\//.test(window.location.href);
  }

  function scheduleSync() {
    if (extractionTimeout) clearTimeout(extractionTimeout);
    // Wait for profile content to load (h1 must be present)
    extractionTimeout = setTimeout(async () => {
      const h1 = document.querySelector('h1');
      if (!h1 || !h1.innerText.trim()) {
        // Retry once more after another second
        await sleep(1500);
      }
      if (isProfilePage()) {
        runSync();
      }
    }, 1500);
  }

  function init() {
    if (!isProfilePage() || !extensionEnabled) return;

    lastUrl = normalizeProfileUrl(window.location.href);
    ensureIndicator();
    scheduleSync();

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      const currentNormalized = normalizeProfileUrl(window.location.href);
      if (currentNormalized !== lastUrl) {
        lastUrl = currentNormalized;
        if (isProfilePage()) {
          scheduleSync();
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // React to enable/disable toggle changes from the popup
  chrome.storage.onChanged.addListener((changes) => {
    if (!('enabled' in changes)) return;
    extensionEnabled = changes.enabled.newValue !== false;

    if (!extensionEnabled) {
      // Kill any pending sync immediately
      if (extractionTimeout) { clearTimeout(extractionTimeout); extractionTimeout = null; }
      if (observer) observer.disconnect();
      if (indicator && document.body.contains(indicator)) {
        indicator.style.display = 'none';
      }
    } else if (isProfilePage()) {
      if (indicator) indicator.style.display = '';
      init();
    }
  });

  // Entry point — run after document_idle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
