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
      // Click section-level "show more" buttons (show all entries)
      const sectionBtns = safeQueryAll(
        'button[aria-label*="more"], button[aria-label*="More"]',
        sectionEl
      );
      sectionBtns.forEach(btn => { try { btn.click(); } catch {} });
      await sleep(800);

      // Click individual description "see more" buttons so full text lands in DOM
      const descBtns = safeQueryAll(
        'button.inline-show-more-text__button, button[class*="inline-show-more-text"]',
        sectionEl
      );
      descBtns.forEach(btn => { try { btn.click(); } catch {} });
      if (descBtns.length) await sleep(500);
    } catch {}
  }

  function extractDescription(el) {
    // Strategy: find span[aria-hidden="true"] that isn't a title, company, or date.
    // Descriptions are the long-form text — typically >30 chars and not inside
    // .t-bold (title) or .t-14 (company/date/location) containers.
    const allSpans = safeQueryAll('span[aria-hidden="true"]', el);
    for (const span of allSpans) {
      // Skip if inside a title or metadata line
      if (span.closest('.t-bold') || span.closest('.t-14')) continue;
      const text = safeText(span);
      if (text && text.length > 20) return text;
    }
    return null;
  }

  function extractLogoUrl(el) {
    const img = safeQuery('img', el);
    if (!img || !img.src || img.src.startsWith('data:')) return null;
    return img.src;
  }

  function cleanCompanyName(raw) {
    // Strip employment type suffix: "Google · Full-time" → "Google"
    if (!raw) return null;
    return raw.split(/\s*·\s*/)[0].trim() || raw;
  }

  function parseDatesAndDuration(raw) {
    // "Jan 2020 - Present · 3 yrs 2 mos" → { dates, duration }
    if (!raw) return { dates: null, duration: null };
    const parts = raw.split(/\s*·\s*/);
    if (parts.length >= 2) {
      return { dates: parts[0].trim() || null, duration: parts[1].trim() || null };
    }
    // Check if the whole string is just a duration (e.g. "3 yrs 2 mos")
    if (/^\d+\s*(yr|mo)/i.test(raw.trim())) {
      return { dates: null, duration: raw.trim() };
    }
    return { dates: raw.trim() || null, duration: null };
  }

  // Selector for list items — LinkedIn uses different classes on main profile vs detail page
  const LI_SELECTOR = 'li.artdeco-list__item, li.pvs-list__paged-list-item';

  function parseExperienceItems(sectionEl) {
    try {
      const items = [];
      if (!sectionEl) return items;

      // Get all list items, then filter to top-level only
      const allListItems = safeQueryAll(LI_SELECTOR, sectionEl);
      const topLevelItems = allListItems.filter(li => {
        const parentLi = li.parentElement?.closest(LI_SELECTOR);
        return !parentLi || !sectionEl.contains(parentLi);
      });

      for (const li of topLevelItems) {
        try {
          // Detect grouped (multi-role) entry by looking for ANY nested li
          // with its own bold title inside nested ul elements
          const childRoles = [];
          for (const ul of safeQueryAll('ul', li)) {
            for (const child of safeQueryAll(':scope > li', ul)) {
              if (safeQuery('.t-bold span[aria-hidden="true"]', child)) {
                childRoles.push(child);
              }
            }
          }

          if (childRoles.length > 0) {
            // GROUPED ENTRY: parent holds company name, children hold individual roles
            const company = cleanCompanyName(
              safeText(safeQuery('.t-bold span[aria-hidden="true"]', li))
            );
            const logoUrl = extractLogoUrl(li);

            for (const child of childRoles) {
              const title = safeText(safeQuery('.t-bold span[aria-hidden="true"]', child));
              if (!title) continue;

              const rawDates = safeText(
                safeQuery('.t-14.t-normal.t-black--light span[aria-hidden="true"]', child)
              );
              const { dates, duration } = parseDatesAndDuration(rawDates);
              const description = extractDescription(child);

              items.push({ title, company, dates, duration, description, logoUrl });
            }
          } else {
            // SINGLE ROLE ENTRY
            const title = safeText(safeQuery('.t-bold span[aria-hidden="true"]', li));
            if (!title) continue;

            const company = cleanCompanyName(
              safeText(safeQuery('.t-14.t-normal span[aria-hidden="true"]', li))
            );

            const rawDates = safeText(
              safeQuery('.t-14.t-normal.t-black--light span[aria-hidden="true"]', li)
            );
            const { dates, duration } = parseDatesAndDuration(rawDates);
            const logoUrl = extractLogoUrl(li);
            const description = extractDescription(li);

            items.push({ title, company, dates, duration, description, logoUrl });
          }
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

    // Navigate back to the main profile.
    // Set a sessionStorage flag first — if history.back() causes a full page
    // reload (which happens on some profiles), the fresh content script will
    // find this flag in init() and skip the auto-sync, breaking the loop.
    sessionStorage.setItem('ats-returning', '1');
    window.history.back();
    await sleep(1500);
    sessionStorage.removeItem('ats-returning'); // clean up for SPA-nav case

    return items;
  }

  // ── LinkedIn Recruiter extraction ───────────────────────────────────────────
  function recruiterExtractName() {
    try {
      const el = safeQuery('[data-test-row-lockup-full-name] .artdeco-entity-lockup__title')
        || safeQuery('[data-test-row-lockup-full-name]');
      return safeText(el);
    } catch { return null; }
  }

  function recruiterExtractHeadline() {
    try {
      const el = safeQuery('[data-test-row-lockup-headline]');
      return safeText(el);
    } catch { return null; }
  }

  function recruiterExtractLocation() {
    try {
      const el = safeQuery('[data-test-row-lockup-location]');
      const text = safeText(el);
      // Strip leading "· " prefix that LinkedIn Recruiter adds
      return text ? text.replace(/^[\u00b7\u2022\u00b7\xb7]\s*/, '').trim() : null;
    } catch { return null; }
  }

  function recruiterExtractPhotoUrl() {
    try {
      const img = safeQuery('img[data-test-lockup-image]');
      return img ? img.src || null : null;
    } catch { return null; }
  }

  function recruiterExtractConnectionDegree() {
    try {
      const el = safeQuery('.artdeco-entity-lockup__degree');
      const text = safeText(el);
      // Strip "· " or "·\u00a0" prefix
      return text ? text.replace(/^[\u00b7\xb7\u2022]\u00a0?/, '').trim() : null;
    } catch { return null; }
  }

  function recruiterExtractConnections() {
    try {
      const el = safeQuery('[data-test-topcard-condensed-lockup-connection-count]');
      return safeText(el);
    } catch { return null; }
  }

  function recruiterExtractAbout() {
    try {
      const el = safeQuery('[data-test-summary-card-text] .text-highlighter__text')
        || safeQuery('[data-test-summary-card-text]');
      return safeText(el);
    } catch { return null; }
  }

  function recruiterExtractPublicUrl() {
    try {
      const el = safeQuery('[data-test-personal-info-profile-link]');
      if (el && el.href) return normalizeProfileUrl(el.href);
      return null;
    } catch { return null; }
  }

  function recruiterParseExperienceItems() {
    try {
      const items = [];
      const positionItems = safeQueryAll('[data-test-position-entity]');
      for (const item of positionItems) {
        try {
          const titleEl = safeQuery('[data-test-position-entity-title] .text-highlighter__text', item)
            || safeQuery('[data-test-position-entity-title]', item);
          const title = safeText(titleEl);
          if (!title) continue;
          const companyEl = safeQuery('[data-test-position-entity-company-name] .text-highlighter__text', item)
            || safeQuery('[data-test-position-entity-company-name]', item);
          const company = safeText(companyEl);
          const dateEl = safeQuery('[data-test-position-entity-date-range]', item);
          const dates = safeText(dateEl);
          const descEl = safeQuery('[data-test-position-entity-description] .text-highlighter__text', item)
            || safeQuery('[data-test-position-entity-description]', item);
          const description = safeText(descEl);
          items.push({ title, company, dates, description });
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  function recruiterParseEducationItems() {
    try {
      const items = [];
      const educationItems = safeQueryAll('[data-test-education-item]');
      for (const item of educationItems) {
        try {
          const institutionEl = safeQuery('[data-test-education-entity-school-name] .text-highlighter__text', item)
            || safeQuery('[data-test-education-entity-school-name]', item);
          const institution = safeText(institutionEl);
          if (!institution) continue;
          const degreeEl = safeQuery('[data-test-education-entity-degree]', item);
          const degree = safeText(degreeEl);
          const dateEl = safeQuery('[data-test-education-entity-date-range]', item);
          const dates = safeText(dateEl);
          items.push({ institution, degree, dates });
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  async function recruiterExpandAndParseSkills() {
    try {
      const expandBtn = safeQuery('[data-test-profile-skills-card] [data-test-expand-more-lower-button]');
      if (expandBtn) {
        try { expandBtn.click(); } catch {}
        await sleep(800);
      }
      return safeQueryAll('[data-test-skill-entity-skill-name]').map(el => safeText(el)).filter(Boolean);
    } catch { return []; }
  }

  async function extractRecruiterProfileData() {
    const publicUrl = recruiterExtractPublicUrl();
    const linkedinUrl = publicUrl || window.location.href.split('?')[0];
    const name = recruiterExtractName();
    const headline = recruiterExtractHeadline();
    const location = recruiterExtractLocation();
    const photoUrl = recruiterExtractPhotoUrl();
    const connectionDegree = recruiterExtractConnectionDegree();
    const connections = recruiterExtractConnections();
    const about = recruiterExtractAbout();
    const workHistory = recruiterParseExperienceItems();
    const education = recruiterParseEducationItems();
    const skills = await recruiterExpandAndParseSkills();
    const currentEntry = workHistory[0] || {};
    return {
      linkedinUrl,
      fullName: name,
      headline,
      location,
      photoUrl,
      about,
      connectionDegree,
      followers: null,
      connections,
      currentTitle: currentEntry.title || null,
      currentCompany: currentEntry.company || null,
      workHistory: workHistory.length ? JSON.stringify(workHistory) : null,
      education: education.length ? JSON.stringify(education) : null,
      skills: skills.length ? JSON.stringify(skills) : null,
    };
  }

  async function extractProfileData() {
    if (isRecruiterPage()) return extractRecruiterProfileData();
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

  function isRecruiterPage() {
    return /linkedin\.com\/talent\/profile\//.test(window.location.href);
  }

  function isAnyProfilePage() {
    return isProfilePage() || isRecruiterPage();
  }

  function normalizeAnyProfileUrl(href) {
    const inMatch = href.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/);
    if (inMatch) return `https://www.linkedin.com/in/${inMatch[1]}/`;
    const talentMatch = href.match(/https?:\/\/(?:www\.)?linkedin\.com\/talent\/profile\/([^/?#]+)/);
    if (talentMatch) return `https://www.linkedin.com/talent/profile/${talentMatch[1]}/`;
    return href.split('?')[0];
  }

  function scheduleSync() {
    if (extractionTimeout) clearTimeout(extractionTimeout);
    extractionTimeout = setTimeout(async () => {
      if (isRecruiterPage()) {
        const nameEl = document.querySelector('[data-test-row-lockup-full-name]');
        if (!nameEl || !nameEl.innerText.trim()) await sleep(1500);
      } else {
        const h1 = document.querySelector('h1');
        if (!h1 || !h1.innerText.trim()) await sleep(1500);
      }
      if (isAnyProfilePage()) {
        runSync();
      }
    }, 1500);
  }

  function init() {
    if (!isAnyProfilePage() || !extensionEnabled) return;

    lastUrl = normalizeAnyProfileUrl(window.location.href);

    // If we just navigated back from the experience detail page and it caused
    // a full page reload, skip the auto-sync to break the loop.
    if (sessionStorage.getItem('ats-returning')) {
      sessionStorage.removeItem('ats-returning');
    } else {
      ensureIndicator();
      scheduleSync();
    }

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      const currentNormalized = normalizeAnyProfileUrl(window.location.href);
      if (currentNormalized !== lastUrl) {
        lastUrl = currentNormalized;
        if (isAnyProfilePage()) {
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
    } else if (isAnyProfilePage()) {
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
