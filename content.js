(() => {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  let lastUrl = '';
  let indicator = null;
  let extractionTimeout = null;
  let observer = null;
  let autoSyncEnabled = true;    // auto-sync on page load
  let showSyncButton = true;     // show the manual sync button
  let syncInProgress = false;    // guard against concurrent syncs
  let lastSyncTime = 0;          // rate-limit syncs (minimum gap in ms)
  const MIN_SYNC_INTERVAL = 5000;

  // Load settings from storage — returns a promise so init() can await it
  let _settingsLoaded = false;
  const settingsReady = new Promise(resolve => {
    try {
      chrome.storage.local.get(['autoSync', 'showSyncButton', 'enabled'], (r) => {
        if (r.autoSync !== undefined) autoSyncEnabled = r.autoSync !== false;
        else autoSyncEnabled = r.enabled !== false;
        showSyncButton = r.showSyncButton !== false;
        _settingsLoaded = true;
        resolve();
      });
    } catch {
      autoSyncEnabled = false;
      _settingsLoaded = true;
      resolve();
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Scroll page to trigger LinkedIn's lazy-loading of Experience/Education/Skills sections
  // Uses scrollIntoView on elements at increasing depths to trigger IntersectionObservers,
  // plus direct scrollTop manipulation as a fallback for content scripts where
  // window.scrollTo may be ineffective.
  async function scrollToLoadContent() {
    console.log('[ATS Scraper] scrollToLoadContent called');

    // Try multiple scroll targets — LinkedIn may use a custom scroll container
    const scrollable = document.scrollingElement || document.documentElement;
    const mainEl = document.querySelector('main');
    console.log('[ATS Scraper] scrollable:', scrollable.tagName, 'scrollHeight:', scrollable.scrollHeight, 'innerHeight:', window.innerHeight);

    const step = Math.floor(window.innerHeight * 0.7);
    let prevHeight = scrollable.scrollHeight;

    // Scroll down in increments
    for (let pos = step; pos < scrollable.scrollHeight + step; pos += step) {
      // Try all methods to ensure at least one works
      scrollable.scrollTop = pos;
      window.scrollTo(0, pos);
      if (mainEl) mainEl.scrollTop = pos;
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));

      console.log('[ATS Scraper] scroll to', pos, '— actual scrollTop:', scrollable.scrollTop);
      await sleep(400);

      if (scrollable.scrollHeight > prevHeight) {
        prevHeight = scrollable.scrollHeight;
      }
    }

    // Final: scroll to absolute bottom
    scrollable.scrollTop = scrollable.scrollHeight;
    window.scrollTo(0, scrollable.scrollHeight);
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(600);

    // Scroll back to top
    scrollable.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(300);
    console.log('[ATS Scraper] scrollToLoadContent done');
  }

  function isExtensionContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
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
      if (!btn.disabled) runSync().catch(() => {});
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

  // ── Profile top card detection ────────────────────────────────────────────
  // LinkedIn 2025+ uses obfuscated class names. We find the profile top card
  // by looking for a container with an aria-label that includes the profile
  // name pattern (e.g. "Steven Austgen Verified Profile 3rd+") or by
  // structural position (the first major h2 on the page).

  function findProfileTopCard() {
    // Strategy 1: div with aria-label containing "Profile" near the top
    const candidates = safeQueryAll('[aria-label*="Profile"]');
    for (const el of candidates) {
      // The profile card aria-label looks like "Name Verified Profile 3rd+"
      const label = el.getAttribute('aria-label') || '';
      if (/profile\s+(1st|2nd|3rd|3rd\+)/i.test(label)) return el;
    }
    // Strategy 2: The first section with componentkey containing "profile.card"
    const sections = safeQueryAll('[componentkey*="profile.card"], [componentkey*="ProfileTopLevel"]');
    if (sections.length > 0) return sections[0];
    // Strategy 3: walk up from the profile name h2
    return null;
  }

  // ── DOM extraction (2025+ LinkedIn layout) ────────────────────────────────
  // LinkedIn now uses <h2> for the profile name, <p> for headline/location,
  // and all CSS classes are obfuscated hashes. We rely on:
  // - Tag structure (h2, p, section, ul, li, figure)
  // - data-testid attributes
  // - aria-label attributes
  // - Text content patterns (dates, locations)
  // - href patterns (/company/, /school/, /details/)

  function extractName() {
    try {
      // Try h1 first (some layouts still use it)
      const h1 = document.querySelector('h1');
      if (h1 && h1.innerText.trim()) {
        const text = h1.innerText.trim();
        if (!/^\d+\s*notification/i.test(text) && text.length >= 2 && /[a-zA-Z]/.test(text)) {
          return text;
        }
      }

      // LinkedIn 2025+: name is in an h2 inside the profile top card
      const SKIP = /^(\d+\s*notification|messaging|notifications|home|my network|jobs|activity|experience|education|skills|about|interests|people also viewed|people you may know|similar profiles)/i;

      const h2s = document.querySelectorAll('h2');
      for (const h2 of h2s) {
        const text = (h2.innerText || '').trim();
        if (!text || text.length < 2) continue;
        if (SKIP.test(text)) continue;
        if (!/[a-zA-Z]/.test(text)) continue;
        // Skip section headings that are single common words
        if (/^(experience|education|skills|languages|certifications|projects|publications|honors|courses|organizations|volunteer|interests|recommendations)$/i.test(text)) continue;
        return text;
      }
      return null;
    } catch { return null; }
  }

  function extractHeadline() {
    try {
      // Legacy selector
      let el = safeQuery('.text-body-medium.break-words');
      if (el) return safeText(el);

      // 2025+ layout: the headline is a <p> element after the name.
      // Find the name element first, then look for the next sibling <p> that
      // isn't the connection degree (which starts with "·").
      const name = extractName();
      if (!name) return null;

      // Walk all <p> elements looking for the headline near the profile card.
      // The headline is typically the first substantial <p> text after the name
      // that isn't the connection degree, location, or company info.
      const topCard = findProfileTopCard();
      const root = topCard || document;
      const pTags = safeQueryAll('p', root);
      for (const p of pTags) {
        const text = safeText(p);
        if (!text || text.length < 3) continue;
        // Skip connection degree
        if (/^·\s*(1st|2nd|3rd)/i.test(text)) continue;
        // Skip if it's the name itself
        if (text === name) continue;
        // Skip locations (City, State pattern)
        if (/^[A-Z][a-z]+,\s+[A-Z]/.test(text) && text.split(',').length >= 2) continue;
        // The headline is usually a job description - return first match
        return text;
      }

      // Fallback: sibling after h1/h2
      const nameEl = document.querySelector('h1') || document.querySelector('h2');
      if (nameEl) {
        let sibling = nameEl.nextElementSibling;
        while (sibling) {
          const text = safeText(sibling);
          if (text && text.length > 2 && !/^·/.test(text)) return text;
          sibling = sibling.nextElementSibling;
        }
      }
      return null;
    } catch { return null; }
  }

  function extractLocation() {
    try {
      // Legacy selector (older LinkedIn layouts)
      let el = safeQuery('.text-body-small.inline.t-black--light.break-words');
      if (el) return safeText(el);

      // 2025+ DOM: The location <p>, a "·" separator <p>, and a "Contact info" <a>
      // all share the same parent <div>. The rendered "Contact info" link has href="#"
      // (distinguishes it from ~5 other occurrences in embedded JSON/script data).
      // Strategy: find the visible "Contact info" anchor, go to parent <p>, then to
      // that <p>'s parentElement (the container div), and grab the first direct child
      // <p> that isn't a separator or the link itself.
      // NO FALLBACK — return null if this fails. Wrong data is worse than no data.
      const anchors = safeQueryAll('a[href="#"]');
      for (const a of anchors) {
        const linkText = (a.textContent || '').trim();
        if (linkText !== 'Contact info') continue;

        // Verify this is a visible rendered element (not in script/JSON data)
        if (!a.offsetParent && a.offsetWidth === 0 && a.offsetHeight === 0) continue;

        // Navigate: anchor → parent <p> → parent <div> (the container)
        const contactP = a.closest('p');
        const container = contactP ? contactP.parentElement : null;
        if (!container) continue;

        // Iterate only DIRECT children to avoid grabbing text from nested sections
        for (const child of container.children) {
          if (child.tagName !== 'P') continue;
          const text = (child.innerText || '').trim();
          if (!text || text === '·') continue;
          if (text === 'Contact info' || text.includes('Contact info')) continue;
          return text;
        }
      }

      return null;
    } catch { return null; }
  }

  function extractPhotoUrl() {
    try {
      // Legacy selectors
      let img = safeQuery('img.pv-top-card-profile-picture__image--show');
      if (img) return img.src || null;

      // 2025+: The profile photo lives inside a container with aria-label="Profile photo"
      const profilePhotoContainer = safeQuery('[aria-label="Profile photo"]');
      if (profilePhotoContainer) {
        const photo = safeQuery('img[src*="profile-displayphoto"]', profilePhotoContainer);
        if (photo && photo.src) return photo.src;
      }

      // Fallback: find the LARGEST profile-displayphoto img in <main>,
      // excluding mutual connection photos (inside <li> or <ul>).
      const allImgs = safeQueryAll('img[src*="profile-displayphoto"]');
      if (allImgs.length > 0) {
        const mainContent = safeQuery('main') || document.body;
        let bestImg = null;
        let bestSize = 0;
        for (const i of allImgs) {
          if (!mainContent.contains(i)) continue;
          if (i.closest('nav') || i.closest('#global-nav')) continue;
          if (i.closest('ul[role="presentation"]') || i.closest('li')) continue;
          const sizeMatch = i.src.match(/shrink_(\d+)_(\d+)/);
          const size = sizeMatch ? parseInt(sizeMatch[1]) : 100;
          if (size > bestSize) { bestSize = size; bestImg = i; }
        }
        if (bestImg) return bestImg.src;
      }

      // Last resort legacy selectors
      img = safeQuery('img[class*="profile-photo-edit"]') || safeQuery('img[class*="profile-picture"]');
      return img ? img.src || null : null;
    } catch { return null; }
  }

  function extractAbout() {
    try {
      const section = findSectionByHeading('^about$');
      if (!section) return null;

      // 2025+: look for expandable-text-box first
      const expandable = safeQuery('[data-testid="expandable-text-box"]', section);
      if (expandable) return safeText(expandable);

      // Legacy: span[aria-hidden="true"]
      const spans = safeQueryAll('span[aria-hidden="true"]', section);
      const texts = spans.map(s => safeText(s)).filter(Boolean);
      if (texts.length) return texts.join(' ').trim();

      // Fallback: grab all <p> text in section (excluding heading)
      const pTags = safeQueryAll('p', section);
      for (const p of pTags) {
        const text = safeText(p);
        if (text && text.length > 30) return text;
      }
      return null;
    } catch { return null; }
  }

  function extractConnectionDegree() {
    try {
      // Legacy selector
      let el = safeQuery('.dist-value');
      if (el) return safeText(el);

      // 2025+: Look for aria-label on the profile card containing degree info
      const candidates = safeQueryAll('[aria-label*="Profile"]');
      for (const el of candidates) {
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/(1st|2nd|3rd\+?)/i);
        if (match) return match[1];
      }

      // Fallback: look for "· 3rd" pattern in <p> tags near top
      const pTags = safeQueryAll('p');
      for (const p of pTags) {
        const text = safeText(p);
        if (text && /^·\s*(1st|2nd|3rd\+?)$/i.test(text)) {
          return text.replace(/^·\s*/, '').trim();
        }
      }
      return null;
    } catch { return null; }
  }

  function extractFollowersConnections() {
    try {
      let followers = null;
      let connections = null;

      // Search all text-bearing elements for follower/connection counts
      const allElements = safeQueryAll('p, span, div');
      for (const el of allElements) {
        // Only check direct text content to avoid double-counting
        const text = el.innerText || '';
        if (/\d+\s*follower/i.test(text) && !followers) {
          followers = text.trim();
        }
        if (/\d+\+?\s*connection/i.test(text) && !connections) {
          // 2025+ layout: "500+" and "connections" may be in separate <p> tags
          connections = text.trim();
        }
      }

      // 2025+ fallback: look for "500+" followed by "connections" in adjacent elements
      if (!connections) {
        const pTags = safeQueryAll('p');
        for (let i = 0; i < pTags.length - 1; i++) {
          const current = safeText(pTags[i]);
          const next = safeText(pTags[i + 1]);
          if (current && /^\d+\+?$/.test(current) && next && /^connections?$/i.test(next)) {
            connections = `${current} connections`;
            break;
          }
        }
      }

      return { followers, connections };
    } catch { return { followers: null, connections: null }; }
  }

  function findSectionByHeading(heading) {
    try {
      // First try: find <section> containing an h2 that matches
      const sections = safeQueryAll('section');
      for (const section of sections) {
        const h2 = safeQuery('h2', section);
        if (h2 && new RegExp(heading, 'i').test(h2.innerText.trim())) {
          return section;
        }
      }
      // 2025+ fallback: sections may not use <section> tags — find the h2
      // and walk up to its nearest section-like container
      const h2s = safeQueryAll('h2');
      for (const h2 of h2s) {
        if (new RegExp(heading, 'i').test(h2.innerText.trim())) {
          // Walk up to find a reasonable container
          let parent = h2.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            // Look for a container that has the section's content
            if (parent.querySelector('ul') || parent.querySelector('[componentkey]')) {
              return parent;
            }
            parent = parent.parentElement;
          }
          // Return the h2's grandparent as a reasonable section boundary
          return h2.parentElement?.parentElement || h2.parentElement;
        }
      }
      return null;
    } catch { return null; }
  }

  async function expandSection(sectionEl) {
    if (!sectionEl) return;
    try {
      // Click "Show all" / "show more" buttons within the section
      const showBtns = safeQueryAll(
        'button[aria-label*="Show all"], button[aria-label*="show all"], button[aria-label*="more"], button[aria-label*="More"]',
        sectionEl
      );
      // Be selective — only click buttons that look like section expanders
      for (const btn of showBtns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        // Skip "learn more", "read more about X", navigation-style buttons
        if (/learn more|read more|find out/i.test(label)) continue;
        try { btn.click(); } catch {}
      }
      await sleep(800);

      // Click "see more" / "...more" description expansion buttons
      const descBtns = safeQueryAll(
        '[data-testid="expandable-text-button"], button.inline-show-more-text__button, button[class*="inline-show-more-text"]',
        sectionEl
      );
      descBtns.forEach(btn => { try { btn.click(); } catch {} });
      if (descBtns.length) await sleep(500);
    } catch {}
  }

  function extractDescription(el) {
    // 2025+ layout: descriptions use data-testid="expandable-text-box"
    const expandable = safeQuery('[data-testid="expandable-text-box"]', el);
    if (expandable) {
      const text = safeText(expandable);
      if (text && text.length > 10) return text;
    }

    // Legacy: find span[aria-hidden="true"] that isn't a title or metadata
    const allSpans = safeQueryAll('span[aria-hidden="true"]', el);
    for (const span of allSpans) {
      if (span.closest('.t-bold') || span.closest('.t-14')) continue;
      const text = safeText(span);
      if (text && text.length > 20) return text;
    }

    // Last resort: find long <p> text
    const pTags = safeQueryAll('p', el);
    for (const p of pTags) {
      const text = safeText(p);
      if (text && text.length > 50) return text;
    }
    return null;
  }

  function extractLogoUrl(el) {
    // Prefer company logo images (not SVG placeholders)
    const imgs = safeQueryAll('img', el);
    for (const img of imgs) {
      if (!img.src || img.src.startsWith('data:')) continue;
      // Company logos contain "company-logo" in the URL
      if (/company-logo|school-logo/i.test(img.src) || img.src.includes('media.licdn.com')) {
        return img.src;
      }
    }
    // Fallback: any non-data img
    const img = safeQuery('img', el);
    if (img && img.src && !img.src.startsWith('data:')) return img.src;
    return null;
  }

  function cleanCompanyName(raw) {
    if (!raw) return null;
    return raw.split(/\s*·\s*/)[0].trim() || raw;
  }

  function parseDatesAndDuration(raw) {
    if (!raw) return { dates: null, duration: null };
    const parts = raw.split(/\s*·\s*/);
    if (parts.length >= 2) {
      return { dates: parts[0].trim() || null, duration: parts[1].trim() || null };
    }
    if (/^\d+\s*(yr|mo)/i.test(raw.trim())) {
      return { dates: null, duration: raw.trim() };
    }
    return { dates: raw.trim() || null, duration: null };
  }

  // ── Experience parsing (2025+ layout) ─────────────────────────────────────
  // LinkedIn 2025+ experience section structure:
  //   <h2>Experience</h2>
  //   <div> (container for all entries)
  //     <div componentkey="entity-collection-item-...">  (one per company group)
  //       Company logo + name (linked to /company/ID/)
  //       Employment type + total duration: "Full-time · 4 yrs 5 mos"
  //       <ul>
  //         <li> role 1: title, dates, location, description
  //         <li> role 2: ...
  //       </ul>
  //     </div>
  //     <hr> separator
  //     <div componentkey="entity-collection-item-..."> (next company)
  //       Single role: title, company name, dates, location, description
  //     </div>
  //   </div>

  // Date pattern to distinguish date strings from other text
  const DATE_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})\b/i;
  const DURATION_PATTERN = /^\d+\s*(yr|mo)/i;
  const EMPLOYMENT_TYPE_PATTERN = /^(full[- ]time|part[- ]time|contract|freelance|self[- ]employed|seasonal|internship)\b/i;

  function isDateOrDuration(text) {
    if (!text) return false;
    return DATE_PATTERN.test(text) || DURATION_PATTERN.test(text) ||
           /present/i.test(text) || /^\d{4}\s*[-–]\s*(\d{4}|present)/i.test(text);
  }

  function isLocation(text) {
    if (!text) return false;
    // Must look like a geographic location, not a job title
    // "City, State, Country" or "City, State" or "Remote"
    if (/remote|hybrid|on-site/i.test(text) && text.length < 30) return true;
    const parts = text.split(',').map(s => s.trim());
    if (parts.length < 2 || parts.length > 4) return false;
    // Each part should look geographic: short-ish words starting with uppercase,
    // no job-title keywords like "Director", "VP", "Manager", "Operations", etc.
    const jobWords = /\b(director|manager|president|vp|officer|head|lead|principal|partner|analyst|associate|consultant|engineer|operations|strategy|development|marketing|sales|finance|accounting)\b/i;
    if (jobWords.test(text)) return false;
    // Geographic parts are typically short (< 30 chars each) and mostly alpha
    if (parts.every(p => p.length < 35 && /^[A-Z]/.test(p))) return true;
    return false;
  }

  function extractCompanyLinkedInUrl(el) {
    const links = safeQueryAll('a[href*="/company/"]', el);
    for (const link of links) {
      if (link.href && /\/company\//.test(link.href)) {
        return link.href.split('?')[0].replace(/\/$/, '') + '/';
      }
    }
    return null;
  }

  function parseExperienceItems(sectionEl) {
    try {
      const items = [];
      if (!sectionEl) return items;

      // Find all entity collection items (one per company or single role)
      const entityItems = safeQueryAll('[componentkey*="entity-collection-item"]', sectionEl);

      // If no componentkey items found, fall back to li-based parsing
      if (entityItems.length === 0) {
        return parseExperienceItemsLegacy(sectionEl);
      }

      for (const entity of entityItems) {
        try {
          // Check if this is a grouped entry (has <ul> with role sub-items)
          const roleList = safeQuery('ul', entity);

          if (roleList) {
            // GROUPED ENTRY: company header + multiple roles in <ul>/<li>
            // Company name is in the first linked <p> or the first bold-looking text
            // Get company name: check ALL /company/ links (first is logo, second has text)
            const companyLinks = safeQueryAll('a[href*="/company/"]', entity);
            let company = null;
            for (const link of companyLinks) {
              const pTags = safeQueryAll('p', link);
              for (const p of pTags) {
                const text = safeText(p);
                if (text && !EMPLOYMENT_TYPE_PATTERN.test(text) && !DURATION_PATTERN.test(text) && text.length < 100) {
                  company = cleanCompanyName(text);
                  break;
                }
              }
              if (company) break;
            }
            // Fallback: check figure/img aria-label for company name
            if (!company) {
              const logoImg = safeQuery('img[alt*="logo"]', entity);
              if (logoImg) {
                const alt = logoImg.getAttribute('alt') || '';
                company = alt.replace(/\s*logo$/i, '').trim() || null;
              }
            }
            // Fallback: grab the first <p> text before the <ul> that isn't a date/duration/employment type
            // This handles cases like "Operating Advisory Group - Advisor to Comvest Partners"
            // where there's no /company/ link
            if (!company) {
              const allP = safeQueryAll('p', entity);
              for (const p of allP) {
                // Stop if we've reached inside the role list
                if (roleList.contains(p)) break;
                const text = safeText(p);
                if (text && !EMPLOYMENT_TYPE_PATTERN.test(text) && !DURATION_PATTERN.test(text)
                    && !isDateOrDuration(text) && text.length >= 2 && text.length < 120) {
                  company = cleanCompanyName(text);
                  break;
                }
              }
            }
            const logoUrl = extractLogoUrl(entity);
            const companyLinkedInUrl = extractCompanyLinkedInUrl(entity);

            // Parse individual roles from <li> items
            const roleLis = safeQueryAll('li', roleList);
            for (const li of roleLis) {
              const roleData = parseSingleRole(li, company, logoUrl, companyLinkedInUrl);
              if (roleData) items.push(roleData);
            }
          } else {
            // SINGLE ROLE ENTRY
            const roleData = parseSingleRoleEntity(entity);
            if (roleData) items.push(roleData);
          }
        } catch {}
      }

      return items;
    } catch { return []; }
  }

  function parseSingleRole(el, parentCompany, parentLogoUrl, parentCompanyUrl) {
    // Parse a single role <li> within a grouped company entry
    try {
      const pTags = safeQueryAll('p', el);
      if (pTags.length === 0) return null;

      let title = null;
      let dates = null;
      let duration = null;
      let location = null;

      for (const p of pTags) {
        const text = safeText(p);
        if (!text) continue;

        if (!title && !isDateOrDuration(text) && !isLocation(text) && !EMPLOYMENT_TYPE_PATTERN.test(text) && text.length < 120) {
          title = text;
        } else if (!dates && isDateOrDuration(text)) {
          const parsed = parseDatesAndDuration(text);
          dates = parsed.dates;
          duration = parsed.duration;
        } else if (!location && isLocation(text) && title) {
          location = text;
        }
      }

      if (!title) return null;

      const description = extractDescription(el);
      return {
        title,
        company: parentCompany,
        companyLinkedInUrl: parentCompanyUrl || null,
        dates,
        duration,
        description,
        logoUrl: parentLogoUrl
      };
    } catch { return null; }
  }

  function parseSingleRoleEntity(entity) {
    // Parse a single-role entity (not grouped under a company)
    try {
      const pTags = safeQueryAll('p', entity);
      if (pTags.length === 0) return null;

      let title = null;
      let company = null;
      let dates = null;
      let duration = null;

      // In single-role entries, the structure is:
      // <p>Title</p>
      // <p>Company Name · Employment Type</p>  (linked to /company/)
      // <p>Dates · Duration</p>
      // <p>Location</p>
      for (const p of pTags) {
        const text = safeText(p);
        if (!text) continue;

        if (!title && !isDateOrDuration(text) && !EMPLOYMENT_TYPE_PATTERN.test(text) && text.length < 120) {
          title = text;
        } else if (title && !company && !isDateOrDuration(text) && text.length < 120) {
          company = cleanCompanyName(text);
        } else if (!dates && isDateOrDuration(text)) {
          const parsed = parseDatesAndDuration(text);
          dates = parsed.dates;
          duration = parsed.duration;
        }
      }

      // Try to get company from link if not found in <p> tags
      if (!company) {
        const companyLinks = safeQueryAll('a[href*="/company/"]', entity);
        for (const link of companyLinks) {
          const pTags = safeQueryAll('p', link);
          for (const p of pTags) {
            const text = safeText(p);
            if (text && text !== title && !EMPLOYMENT_TYPE_PATTERN.test(text) && !DURATION_PATTERN.test(text)) {
              company = cleanCompanyName(text);
              break;
            }
          }
          if (company) break;
          // Fallback: use link's full text if it's short enough
          const linkText = safeText(link);
          if (linkText && linkText !== title && linkText.length < 80) {
            company = cleanCompanyName(linkText);
            break;
          }
        }
      }
      // Last resort: logo alt text
      if (!company) {
        const logoImg = safeQuery('img[alt*="logo"]', entity);
        if (logoImg) {
          const alt = logoImg.getAttribute('alt') || '';
          company = alt.replace(/\s*logo$/i, '').trim() || null;
        }
      }

      if (!title) return null;

      const logoUrl = extractLogoUrl(entity);
      const description = extractDescription(entity);

      const companyLinkedInUrl = extractCompanyLinkedInUrl(entity);
      return { title, company, companyLinkedInUrl, dates, duration, description, logoUrl };
    } catch { return null; }
  }

  // Legacy experience parsing (for older LinkedIn layouts that still use artdeco classes)
  const LI_SELECTOR = 'li.artdeco-list__item, li.pvs-list__paged-list-item';

  function parseExperienceItemsLegacy(sectionEl) {
    try {
      const items = [];
      if (!sectionEl) return items;

      const allListItems = safeQueryAll(LI_SELECTOR, sectionEl);
      // Also try generic li items if no artdeco items found
      const listItems = allListItems.length > 0 ? allListItems : safeQueryAll('li', sectionEl);

      const topLevelItems = listItems.filter(li => {
        const parentLi = li.parentElement?.closest('li');
        return !parentLi || !sectionEl.contains(parentLi);
      });

      for (const li of topLevelItems) {
        try {
          // Detect grouped entry
          const childRoles = [];
          for (const ul of safeQueryAll('ul', li)) {
            for (const child of safeQueryAll(':scope > li', ul)) {
              const pTags = safeQueryAll('p', child);
              if (pTags.length > 0) childRoles.push(child);
            }
          }

          if (childRoles.length > 0) {
            // Get company name from parent — check all company links
            const companyLinks = safeQueryAll('a[href*="/company/"]', li);
            let company = null;
            for (const companyLink of companyLinks) {
              const pTags = safeQueryAll('p', companyLink);
              for (const p of pTags) {
                const text = safeText(p);
                if (text && !EMPLOYMENT_TYPE_PATTERN.test(text) && !DURATION_PATTERN.test(text)) {
                  company = cleanCompanyName(text);
                  break;
                }
              }
              if (company) break;
            }
            // Logo alt fallback
            if (!company) {
              const logoImg = safeQuery('img[alt*="logo"]', li);
              if (logoImg) company = (logoImg.getAttribute('alt') || '').replace(/\s*logo$/i, '').trim() || null;
            }
            // Legacy fallback
            if (!company) {
              const boldSpan = safeQuery('.t-bold span[aria-hidden="true"]', li);
              company = cleanCompanyName(safeText(boldSpan));
            }
            const logoUrl = extractLogoUrl(li);
            const companyLinkedInUrl = extractCompanyLinkedInUrl(li);

            for (const child of childRoles) {
              const roleData = parseSingleRole(child, company, logoUrl, companyLinkedInUrl);
              if (roleData) items.push(roleData);
            }
          } else {
            const roleData = parseSingleRoleEntity(li);
            if (roleData) items.push(roleData);
          }
        } catch {}
      }
      return items;
    } catch { return []; }
  }

  // ── Education & Skills parsing ──────────────────────────────────────────────

  function parseEducationItems(sectionEl) {
    try {
      const items = [];
      if (!sectionEl) return items;

      // 2025+: find entity items by componentkey or fall back to li
      const entityItems = safeQueryAll('[componentkey]', sectionEl);
      const targets = entityItems.length > 0
        ? entityItems.filter(el => el.querySelector('a[href*="/school/"]') || el.querySelector('figure'))
        : safeQueryAll('li', sectionEl);

      for (const el of targets) {
        try {
          const pTags = safeQueryAll('p', el);
          if (pTags.length === 0) continue;

          let institution = null;
          let degree = null;
          let dates = null;

          for (const p of pTags) {
            const text = safeText(p);
            if (!text) continue;
            // Skip "Activities and societies" prefix text
            if (/^activities and societies/i.test(text)) continue;

            if (!institution && !isDateOrDuration(text)) {
              institution = text;
            } else if (institution && !degree && !isDateOrDuration(text) && !/^\d{4}/.test(text)) {
              degree = text;
            } else if (!dates && (/^\d{4}/.test(text) || /–|—|-/.test(text))) {
              dates = text;
            }
          }

          if (institution) {
            items.push({ institution, degree, dates });
          }
        } catch {}
      }

      // Deduplicate by institution name
      const seen = new Set();
      return items.filter(item => {
        const key = (item.institution || '').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch { return []; }
  }

  function parseSkillItems(sectionEl) {
    try {
      const items = [];
      if (!sectionEl) return items;

      // 2025+: skill items are in div[componentkey*="skill"]
      const skillDivs = safeQueryAll('[componentkey*="skill"]', sectionEl);
      for (const div of skillDivs) {
        const pTags = safeQueryAll('p', div);
        for (const p of pTags) {
          const text = safeText(p);
          if (text && text.length > 1 && text.length < 60 && !/endorsement/i.test(text) && !/^\d+$/.test(text)) {
            if (!items.includes(text)) items.push(text);
            break; // first p in each skill div is the skill name
          }
        }
      }

      if (items.length > 0) return items;

      // Legacy fallback
      const listItems = safeQueryAll('li', sectionEl);
      for (const li of listItems) {
        const skillEl = safeQuery('.hoverable-link-text span[aria-hidden="true"]', li)
          || safeQuery('.t-bold span[aria-hidden="true"]', li);
        const skill = safeText(skillEl);
        if (skill && !items.includes(skill)) items.push(skill);
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

    // Scroll the detail page to trigger lazy-loading of all experience entries
    await scrollToLoadContent();

    // Scrape all experiences from the detail page
    const container = findSectionByHeading('experience') || safeQuery('main') || document.body;
    await expandSection(container);
    const items = parseExperienceItems(container);

    // Navigate back to the main profile
    sessionStorage.setItem('ats-returning', '1');
    window.history.back();
    await sleep(1500);
    sessionStorage.removeItem('ats-returning');

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

  // ── Profile data assembly ────────────────────────────────────────────────────

  async function extractProfileData() {
    if (isRecruiterPage()) return extractRecruiterProfileData();

    // Scroll page to trigger lazy-loading of all sections before extraction
    await scrollToLoadContent();

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
    try {
      // Guard: prevent concurrent syncs and rate-limit
      if (syncInProgress) return;
      const now = Date.now();
      if (now - lastSyncTime < MIN_SYNC_INTERVAL) return;

      // Check extension context is still valid before attempting sync
      if (!isExtensionContextValid()) {
        syncInProgress = false;
        teardown();
        return;
      }

      syncInProgress = true;
      lastSyncTime = now;
      setStatus('syncing', '↑ Syncing...');

      let profileData;
      try {
        profileData = await extractProfileData();
      } catch (err) {
        syncInProgress = false;
        if (/context invalidated/i.test(err.message)) { teardown(); return; }
        setStatus('error', `✗ Extraction failed: ${err.message}`);
        return;
      }

      // Don't sync if we couldn't extract a name — avoids creating ghost records
      if (!profileData.fullName || !profileData.fullName.trim()) {
        setStatus('error', '✗ Could not extract name — try reloading the page');
        syncInProgress = false;
        return;
      }

      // Final context check before sending message
      if (!isExtensionContextValid()) { syncInProgress = false; teardown(); return; }

      chrome.runtime.sendMessage(
        { type: 'SYNC_PROFILE', data: profileData },
        (response) => {
          syncInProgress = false;

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
          // Scroll user back to top of profile
          const el = document.scrollingElement || document.documentElement;
          el.scrollTop = 0;
          window.scrollTo(0, 0);
          document.querySelector('main')?.scrollTo?.(0, 0);
        }
      );
    } catch (err) {
      // Catch-all for "Extension context invalidated" and other fatal errors
      syncInProgress = false;
      if (/context invalidated/i.test(err.message)) teardown();
    }
  }

  // Kill all timers and observers when the extension context dies
  function teardown() {
    syncInProgress = false;
    if (extractionTimeout) { clearTimeout(extractionTimeout); extractionTimeout = null; }
    if (observer) { observer.disconnect(); observer = null; }
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

  // Wait for the tab to be visible (returns immediately if already visible)
  function waitForTabVisible() {
    return new Promise(resolve => {
      if (document.visibilityState === 'visible') return resolve();
      function onVisible() {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVisible);
          resolve();
        }
      }
      document.addEventListener('visibilitychange', onVisible);
    });
  }

  function isProfileContentLoaded() {
    if (isRecruiterPage()) {
      const nameEl = document.querySelector('[data-test-row-lockup-full-name]');
      if (!nameEl || !nameEl.innerText.trim()) return false;
      return !!document.querySelector('[data-test-position-entity]');
    }
    // Check for experience entries (not just the heading)
    return !!(
      document.querySelector('[componentkey*="entity-collection-item"]') ||
      document.querySelector('a[href*="/company/"]') ||
      document.querySelector('[data-testid="expandable-text-box"]')
    );
  }

  function scheduleSync() {
    if (extractionTimeout) clearTimeout(extractionTimeout);
    extractionTimeout = setTimeout(async () => {
      // STEP 1: Wait for the tab to be visible.
      // Background tabs in Chrome don't fully render — LinkedIn won't
      // lazy-load experience sections until the tab is focused.
      await waitForTabVisible();

      // STEP 2: Wait for profile content to fully load.
      for (let attempt = 0; attempt < 12; attempt++) {
        if (!isExtensionContextValid()) return;

        // If tab goes hidden again (user switched away), wait for it to come back
        if (document.visibilityState !== 'visible') {
          await waitForTabVisible();
          // Reset attempts — content loading restarts when tab becomes visible
          attempt = 0;
          continue;
        }

        if (isProfileContentLoaded()) break;

        // After 10 attempts (~15s) with a visible tab, sync with whatever we have
        // (handles profiles with no experience section)
        if (attempt >= 10) break;

        await sleep(1500);
      }

      if (isAnyProfilePage()) {
        runSync().catch(() => {});
      }
    }, 1500);
  }

  async function init() {
    if (!isAnyProfilePage()) return;
    if (!isExtensionContextValid()) return;

    // Wait for storage settings to load before checking flags
    await settingsReady;

    lastUrl = normalizeAnyProfileUrl(window.location.href);

    // If we just navigated back from the experience detail page and it caused
    // a full page reload, skip the auto-sync to break the loop.
    if (sessionStorage.getItem('ats-returning')) {
      sessionStorage.removeItem('ats-returning');
    } else {
      // Always show indicator if sync button is enabled
      if (showSyncButton) ensureIndicator();
      // Only auto-sync if enabled
      if (autoSyncEnabled) scheduleSync();
    }

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      // Bail immediately if extension context is dead
      if (!isExtensionContextValid()) {
        if (observer) { observer.disconnect(); observer = null; }
        return;
      }

      const currentNormalized = normalizeAnyProfileUrl(window.location.href);
      if (currentNormalized !== lastUrl) {
        lastUrl = currentNormalized;
        if (isAnyProfilePage() && autoSyncEnabled) {
          scheduleSync();
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // React to toggle changes from the popup
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if ('autoSync' in changes) {
        autoSyncEnabled = changes.autoSync.newValue !== false;
        if (!autoSyncEnabled) {
          // Stop any pending auto-sync, but keep the button visible
          if (extractionTimeout) { clearTimeout(extractionTimeout); extractionTimeout = null; }
        } else if (isAnyProfilePage()) {
          init();
        }
      }
      if ('showSyncButton' in changes) {
        showSyncButton = changes.showSyncButton.newValue !== false;
        if (!showSyncButton) {
          if (indicator && document.body.contains(indicator)) indicator.style.display = 'none';
        } else if (isAnyProfilePage()) {
          ensureIndicator();
          if (indicator) indicator.style.display = '';
        }
      }
      // Legacy 'enabled' key — treat as controlling both
      if ('enabled' in changes && !('autoSync' in changes)) {
        autoSyncEnabled = changes.enabled.newValue !== false;
        if (!autoSyncEnabled) {
          if (extractionTimeout) { clearTimeout(extractionTimeout); extractionTimeout = null; }
        } else if (isAnyProfilePage()) {
          init();
        }
      }
    });
  } catch {
    // Extension context invalidated — no-op
  }

  // Entry point — run after document_idle
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
