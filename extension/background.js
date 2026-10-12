/**
 * background.js — Service Worker
 *
 * Two responsibilities:
 *   1. Toolbar badge: shows count of open real-web tabs, color-coded by load.
 *   2. Paper auto-capture: any paper URL visited gets persisted to
 *      chrome.storage.local.papers permanently, with metadata enrichment
 *      kicked off in the background.
 */

// Pull in the URL classifier and metadata fetcher.
importScripts('papers.js', 'enrich.js');

// ─── Badge updater ────────────────────────────────────────────────────────────

// Always clear the badge — we don't surface tab counts on the toolbar icon.
async function updateBadge() {
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {}
}

// ─── Paper auto-capture ───────────────────────────────────────────────────────

const PAPERS_KEY = 'papers';

// 'auto'   — every paper tab the user opens is added to the library.
// 'manual' — nothing is added until the user clicks the toolbar icon on the
//            tab. Papers already in the library still get their visit count /
//            last-seen updated.
// The switch lives in the new-tab page's settings menu.
const CAPTURE_MODE_KEY = 'captureMode';

async function getCaptureMode() {
  const store = await chrome.storage.local.get(CAPTURE_MODE_KEY);
  return store[CAPTURE_MODE_KEY] === 'manual' ? 'manual' : 'auto';
}

/**
 * Classification for a tab added by hand that the URL classifier doesn't
 * recognize (e.g. a PDF served without a .pdf path). The user chose it, so
 * store it keyed by its URL.
 */
function manualClassification(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const norm = `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.pathname}${u.search || ''}`;
  return { source: 'pdf', sourceId: null, canonicalId: `url:${norm}` };
}

const SOURCE_LABELS = {
  arxiv: 'arXiv',
  openreview: 'OpenReview',
  biorxiv: 'bioRxiv',
  medrxiv: 'medRxiv',
  acm: 'ACM',
  ieee: 'IEEE',
  springer: 'Springer',
  nature: 'Nature',
  science: 'Science',
  nips: 'NeurIPS',
  mlr: 'PMLR',
  acl: 'ACL',
  semanticscholar: 'Semantic Scholar',
  pdf: 'PDF',
};

/**
 * Heuristic: does this string look like a URL or filename, not a real paper
 * title? Chrome's PDF viewer often sets tab.title to the URL with no scheme
 * (e.g. "arxiv.org/pdf/2604.22615"), and we don't want that as a "title".
 */
function looksLikeUrlOrFilename(s) {
  if (!s) return false;
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  // host/path with no spaces (real titles always have spaces)
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+$/i.test(t) && !/\s/.test(t)) return true;
  // bare PDF filename
  if (/^[\w.-]+\.pdf$/i.test(t)) return true;
  return false;
}

/**
 * Fallback title cleanup for when enrichment hasn't run yet. Trims trailing
 * site-name garbage like " - arXiv" or " | OpenReview", and rejects titles
 * that are just the URL.
 */
function fallbackTitle(rawTitle, cls) {
  const cleaned = (rawTitle || '')
    .replace(/\s*[-|–—]\s*(arXiv|OpenReview|bioRxiv|medRxiv|ACM Digital Library|IEEE Xplore|Springer|Nature|Science|NeurIPS|ACL Anthology|Semantic Scholar).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && !looksLikeUrlOrFilename(cleaned)) return cleaned;
  // Build a friendly placeholder from the classification, if available
  if (cls && cls.sourceId) {
    const label = SOURCE_LABELS[cls.source] || cls.source;
    return `${label}:${cls.sourceId}`;
  }
  return '';
}

// Per-tab dedup: tabId → canonicalId of the last paper we logged on that tab.
// Used so onUpdated firing multiple times during one navigation only counts
// a single visit.
const lastCapturedByTab = new Map();

/**
 * Look up an existing paper entry by canonical ID. If the direct key isn't
 * present, also check whether any other entry has this ID in its aliases —
 * which means this canonical ID was merged into a different primary record.
 * Without this, every backfill scan after a merge re-creates the duplicate.
 */
function findExistingPaper(papers, canonicalId) {
  if (papers[canonicalId]) return papers[canonicalId];
  for (const p of Object.values(papers)) {
    if (Array.isArray(p.aliases) && p.aliases.includes(canonicalId)) return p;
  }
  return null;
}

/**
 * Upsert a paper into storage.
 *
 * mode:
 *   'visit'    — real navigation. Bump visitCount + lastSeenAt if the tab's
 *                paper changed; otherwise just refresh title if missing.
 *   'discover' — found via tab scan / backfill. Add only if absent.
 *                Doesn't bump visitCount or lastSeenAt for existing entries.
 *   'manual'   — the user clicked the toolbar icon. Adds the tab even in
 *                manual capture mode, and even if the classifier doesn't
 *                recognize the URL.
 *
 * In manual capture mode, 'visit' and 'discover' never create new entries.
 *
 * Returns { id, created } for the paper the tab maps to, or null.
 */
async function capturePaper(tab, mode = 'visit') {
  if (!tab || !tab.url) return null;
  const cls = classifyPaper(tab.url) || (mode === 'manual' ? manualClassification(tab.url) : null);
  if (!cls) {
    if (tab.id != null) lastCapturedByTab.delete(tab.id);
    return null;
  }

  const now = new Date().toISOString();
  const store = await chrome.storage.local.get([PAPERS_KEY, CAPTURE_MODE_KEY]);
  const papers = store[PAPERS_KEY] || {};
  const existing = findExistingPaper(papers, cls.canonicalId);
  const mayCreate = mode === 'manual' || store[CAPTURE_MODE_KEY] !== 'manual';
  if (!existing && !mayCreate) return null;

  let didMutate = false;

  if (existing) {
    if (mode === 'visit' || mode === 'manual') {
      const tabPrev = tab.id != null ? lastCapturedByTab.get(tab.id) : null;
      const isFreshVisit = tabPrev !== cls.canonicalId;
      if (isFreshVisit) {
        existing.lastSeenAt = now;
        existing.visitCount = (existing.visitCount || 0) + 1;
        didMutate = true;
      }
      if (tab.url && existing.url !== tab.url) {
        existing.url = tab.url;
        didMutate = true;
      }
      const t = fallbackTitle(tab.title || '', cls);
      if (!existing.title && t) {
        existing.title = t;
        didMutate = true;
      }
    }
    // mode === 'discover' on an existing entry: nothing to do.
  } else {
    papers[cls.canonicalId] = {
      id: cls.canonicalId,
      url: tab.url,
      source: cls.source,
      sourceId: cls.sourceId,
      doi: cls.doi || null,
      title: fallbackTitle(tab.title || '', cls),
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1,
      readStatus: 'unread',
      enrichmentStatus: 'pending',
      enrichedAt: null
    };
    didMutate = true;
  }

  if (tab.id != null) lastCapturedByTab.set(tab.id, cls.canonicalId);
  const result = { id: (existing || papers[cls.canonicalId]).id, created: !existing };
  if (!didMutate) return result;

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });

  // Kick off metadata enrichment for new entries (or retry if previously failed).
  // Use the stored entry's id, which may differ from cls.canonicalId when this
  // URL points to a merged record under a different primary key.
  const paper = existing || papers[cls.canonicalId];
  if (paper && paper.enrichmentStatus !== 'ok' && paper.enrichmentStatus !== 'unsupported') {
    scheduleEnrichment(paper.id);
  }
  return result;
}

// ─── Auto-attach related tabs ─────────────────────────────────────────────────
//
// When a tab loads that ISN'T itself a paper URL but mentions a paper we
// already have (via arXiv ID or DOI in the URL or page title), attach the
// tab to that paper as a linked URL. This is silent and zero-confirmation —
// arXiv IDs and DOIs are unique enough that false positives are negligible.
// Lower-confidence matches (slug / title overlap) are surfaced in the popup
// as "Suggested" entries instead.

function findVeryHighConfidenceMatch(papers, tab) {
  if (!tab || !tab.url) return null;
  const url = (tab.url || '').toLowerCase();
  const title = (tab.title || '').toLowerCase();
  const haystack = `${url} ${title}`;

  for (const p of Object.values(papers)) {
    if (p.source === 'arxiv' && p.sourceId) {
      const id = p.sourceId.toLowerCase();
      if (id.length >= 7 && haystack.includes(id)) {
        return { paper: p, why: 'arxiv-id' };
      }
    }
    if (p.doi) {
      const d = String(p.doi).toLowerCase();
      // DOIs are noisy substrings; require the slash form so e.g. '10.1109/'
      // doesn't accidentally match dates or product codes.
      if (d.includes('/') && haystack.includes(d)) {
        return { paper: p, why: 'doi' };
      }
    }
  }
  return null;
}

async function maybeAutoAttachToRelated(tab) {
  if (!tab || !tab.url || !tab.title) return;
  if (!/^https?:/i.test(tab.url)) return;
  if (await getCaptureMode() === 'manual') return;
  // Skip tabs that ARE a paper URL — those are auto-captured as the paper
  // itself, not as an attachment to a different paper.
  if (classifyPaper(tab.url)) return;

  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const match = findVeryHighConfidenceMatch(papers, tab);
  if (!match) return;

  const paper = match.paper;
  paper.attachments = Array.isArray(paper.attachments) ? paper.attachments : [];
  if (paper.attachments.some(a => a && a.url === tab.url)) return; // already linked

  paper.attachments.push({
    url: tab.url,
    title: tab.title,
    addedAt: new Date().toISOString(),
    autoAttached: true,
    matchReason: match.why,
  });
  if (!paper.starred) paper.starred = true;

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

/**
 * Scan every currently-open tab and add any papers we don't already have.
 * Used on extension install, browser startup, and on every new-tab page load.
 */
async function backfillExistingTabs() {
  let added = 0;
  if (await getCaptureMode() === 'manual') return added;
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url) continue;
      const cls = classifyPaper(t.url);
      if (cls) {
        const before = (await chrome.storage.local.get(PAPERS_KEY))[PAPERS_KEY] || {};
        // Skip if this canonical ID already exists OR is in another paper's
        // aliases (merged duplicate). Otherwise we'd recreate the dupe each
        // time the new-tab page opens.
        if (!findExistingPaper(before, cls.canonicalId)) {
          await capturePaper(t, 'discover');
          added += 1;
        }
      } else {
        // Non-paper tab — but it might mention a paper we have (via arXiv
        // ID or DOI). Attach it as a related URL if so.
        await maybeAutoAttachToRelated(t);
      }
    }
  } catch (err) {
    console.warn('[paperclip] backfill error', err);
  }
  return added;
}

// ─── Metadata enrichment queue ────────────────────────────────────────────────
//
// All enrichment runs serially through a single Promise chain with a small
// throttle delay between requests. arXiv and Semantic Scholar both rate-limit
// hard — firing 30+ concurrent requests gets most of them rejected. One per
// second is well within everyone's budget.

const ENRICH_THROTTLE_MS = 900;

// Bumped whenever the enrichment schema or behavior changes meaningfully.
// retryStuckEnrichments() re-runs anything below the current version.
// v3: IEEE metadata read from the open tab (v2 marked WAF-blocked IEEE
// papers as 'ok' with no data).
const ENRICHMENT_VERSION = 3;

const enrichQueued = new Set();
let enrichChain = Promise.resolve();

function scheduleEnrichment(canonicalId) {
  if (enrichQueued.has(canonicalId)) return;
  enrichQueued.add(canonicalId);
  enrichChain = enrichChain.then(async () => {
    try {
      await runEnrichmentOnce(canonicalId);
    } catch (err) {
      console.warn('[paperclip] enrich queue error', canonicalId, err);
    } finally {
      enrichQueued.delete(canonicalId);
    }
    await new Promise(r => setTimeout(r, ENRICH_THROTTLE_MS));
  });
}

async function runEnrichmentOnce(canonicalId) {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  const paper = papers[canonicalId];
  if (!paper) return;

  const isCurrent = (paper.enrichmentVersion || 0) >= ENRICHMENT_VERSION;
  if ((paper.enrichmentStatus === 'ok' || paper.enrichmentStatus === 'unsupported') && isCurrent) {
    return;
  }

  let patches = null;
  let enrichError = null;
  try {
    patches = await PaperEnrich.enrich(paper, { runInIEEETab });
  } catch (err) {
    enrichError = err;
    console.warn('[paperclip] enrich error', canonicalId, err);
  }

  // Enrichment takes seconds of network time, during which the user may tag
  // the paper, a figure may be saved, etc. Apply the results to a fresh read
  // so none of that is overwritten with the stale copy from above.
  const fresh = (await chrome.storage.local.get(PAPERS_KEY))[PAPERS_KEY] || {};
  return applyEnrichment(fresh, canonicalId, patches, enrichError);
}

async function applyEnrichment(papers, canonicalId, patches, enrichError) {
  const paper = papers[canonicalId];
  if (!paper) return; // deleted meanwhile

  if (enrichError) {
    paper.enrichmentStatus = 'failed';
    paper.enrichedAt = new Date().toISOString();
    paper.enrichmentVersion = ENRICHMENT_VERSION;
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches == null) {
    paper.enrichmentStatus = 'unsupported';
    paper.enrichedAt = new Date().toISOString();
    paper.enrichmentVersion = ENRICHMENT_VERSION;
    await chrome.storage.local.set({ [PAPERS_KEY]: papers });
    return;
  }

  if (patches.title) paper.title = patches.title;
  if (Array.isArray(patches.authors) && patches.authors.length) paper.authors = patches.authors;
  if (patches.year != null) paper.year = patches.year;
  if (patches.venue) paper.venue = patches.venue;
  if (patches.abstract) paper.abstract = patches.abstract;
  if (patches.externalIds) paper.externalIds = patches.externalIds;
  if (patches.doi && !paper.doi) paper.doi = patches.doi;
  paper.enrichmentStatus = 'ok';
  paper.enrichedAt = new Date().toISOString();
  paper.enrichmentVersion = ENRICHMENT_VERSION;

  // Now that we know this paper's external IDs (DOI / ArXiv / etc.), check
  // whether any other entry in the library is the same paper under a
  // different canonical ID — same paper visited via arxiv URL and via the
  // CHI portal, for example. If so, merge them.
  dedupeAcrossExternalIds(papers, canonicalId);

  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

// ─── IEEE: read metadata from inside an open tab ─────────────────────────────
//
// IEEE Xplore answers service-worker fetches with an AWS WAF bot challenge.
// A tab the user has open already passed it, so we run the probe there: its
// same-origin fetch carries the WAF token cookie.

function isIEEEHost(host) {
  host = (host || '').toLowerCase();
  return host === 'ieeexplore.ieee.org' || /^ieeexplore-ieee-org\./.test(host);
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === 'complete') return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Run `func(...args)` in an open IEEE Xplore tab and return its result.
 * Tries tabs showing this paper first, then any other IEEE tab. Tabs where
 * injection fails (Chrome's PDF viewer, hosts without permission) or that
 * return null (still on the bot challenge) are skipped.
 */
async function runInIEEETab(func, args, paper) {
  const tabs = (await chrome.tabs.query({})).filter(t => {
    try { return isIEEEHost(new URL(t.url).hostname); } catch { return false; }
  });
  const isThisPaper = t => {
    const cls = classifyPaper(t.url);
    return !!cls && (cls.canonicalId === paper.id ||
      (Array.isArray(paper.aliases) && paper.aliases.includes(cls.canonicalId)));
  };
  tabs.sort((a, b) => isThisPaper(b) - isThisPaper(a));

  for (const tab of tabs) {
    try {
      if (tab.status !== 'complete' && !(await waitForTabComplete(tab.id))) continue;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func,
        args,
      });
      if (res && res.result) return res.result;
    } catch (err) {
      console.warn('[paperclip] ieee tab injection failed', tab.id, err);
    }
  }
  return null;
}

/**
 * When an IEEE tab finishes loading, retry any IEEE paper whose enrichment
 * failed — the first attempt often runs while the tab is still on the bot
 * challenge, and only a loaded tab can supply the metadata.
 */
async function retryIEEEOnTabLoad(tab) {
  const cls = classifyPaper(tab.url);
  if (!cls || cls.source !== 'ieee') return;
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  for (const p of Object.values(papers)) {
    if (p.source === 'ieee' && (p.enrichmentStatus === 'failed' || p.enrichmentStatus === 'pending')) {
      scheduleEnrichment(p.id);
    }
  }
}

/**
 * Find any papers that need enrichment and re-queue them. Includes:
 *   - 'pending' or 'failed' status (never finished or transient error)
 *   - 'ok' but enrichmentVersion is below the current code (schema upgrade)
 * Called after backfill, on browser startup, and on extension install.
 */
async function retryStuckEnrichments() {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  for (const p of Object.values(papers)) {
    const isCurrent = (p.enrichmentVersion || 0) >= ENRICHMENT_VERSION;
    if (
      p.enrichmentStatus === 'pending' ||
      p.enrichmentStatus === 'failed' ||
      !isCurrent
    ) {
      scheduleEnrichment(p.id);
    }
  }
}

// ─── Cross-source duplicate detection ─────────────────────────────────────────
//
// Same paper opened from multiple sources (arxiv pre-print + ACM camera-ready)
// gets stored under different canonical IDs. After enrichment fills in the
// externalIds field via Semantic Scholar, we can detect these duplicates by
// matching shared DOIs / arXiv IDs and merge them.

function externalIdSet(paper) {
  const ids = new Set();
  if (typeof paper.id === 'string') {
    if (paper.id.startsWith('arxiv:')) {
      ids.add(`arxiv:${paper.id.slice(6).toLowerCase().replace(/v\d+$/, '')}`);
    } else if (paper.id.startsWith('doi:')) {
      ids.add(`doi:${paper.id.slice(4).toLowerCase()}`);
    }
  }
  if (paper.doi) ids.add(`doi:${String(paper.doi).toLowerCase()}`);
  const ext = paper.externalIds || {};
  if (ext.DOI) ids.add(`doi:${String(ext.DOI).toLowerCase()}`);
  if (ext.ArXiv) ids.add(`arxiv:${String(ext.ArXiv).toLowerCase().replace(/v\d+$/, '')}`);
  return ids;
}

function papersAreDuplicates(a, b) {
  if (a.id === b.id) return false;
  const aIds = externalIdSet(a);
  if (aIds.size === 0) return false;
  for (const id of externalIdSet(b)) {
    if (aIds.has(id)) return true;
  }
  return false;
}

function mergePapers(primary, secondary) {
  if (!primary.firstSeenAt || (secondary.firstSeenAt && secondary.firstSeenAt < primary.firstSeenAt)) {
    primary.firstSeenAt = secondary.firstSeenAt;
  }
  if (!primary.lastSeenAt || (secondary.lastSeenAt && secondary.lastSeenAt > primary.lastSeenAt)) {
    primary.lastSeenAt = secondary.lastSeenAt;
  }
  primary.visitCount = (primary.visitCount || 0) + (secondary.visitCount || 0);

  if (!primary.title && secondary.title) primary.title = secondary.title;
  if (!primary.year && secondary.year) primary.year = secondary.year;
  if (!primary.venue && secondary.venue) primary.venue = secondary.venue;
  if (!primary.abstract && secondary.abstract) primary.abstract = secondary.abstract;
  if ((!primary.authors || primary.authors.length === 0) && Array.isArray(secondary.authors) && secondary.authors.length) {
    primary.authors = secondary.authors;
  }
  if (!primary.doi && secondary.doi) primary.doi = secondary.doi;
  // The figure lives in its own storage key; keep pointing at it.
  if (primary.figureStatus !== 'ok' && secondary.figureStatus === 'ok') {
    primary.figureKey = secondary.figureKey;
    primary.figureStatus = 'ok';
  }

  // externalIds union, primary wins on conflicts
  primary.externalIds = { ...(secondary.externalIds || {}), ...(primary.externalIds || {}) };

  // Track aliases so we know which canonical IDs got folded in here.
  const aliases = new Set(primary.aliases || []);
  aliases.add(secondary.id);
  if (Array.isArray(secondary.aliases)) {
    for (const a of secondary.aliases) aliases.add(a);
  }
  primary.aliases = [...aliases];

  if (secondary.readStatus === 'read') primary.readStatus = 'read';
}

function dedupeAcrossExternalIds(papers, paperId) {
  const target = papers[paperId];
  if (!target) return false;

  const matches = [];
  for (const p of Object.values(papers)) {
    if (p.id === paperId) continue;
    if (papersAreDuplicates(target, p)) matches.push(p);
  }
  if (matches.length === 0) return false;

  // Pick primary as the entry with the earliest firstSeenAt — keeps the
  // user's library order stable.
  const all = [target, ...matches];
  all.sort((a, b) => (a.firstSeenAt || '').localeCompare(b.firstSeenAt || ''));
  const primary = all[0];

  for (const s of all.slice(1)) {
    mergePapers(primary, s);
    delete papers[s.id];
  }
  return true;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  retryStuckEnrichments();
});

chrome.runtime.onStartup.addListener(async () => {
  updateBadge();
  await backfillExistingTabs();
  retryStuckEnrichments();
});

chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  if (tab && tab.url) {
    capturePaper(tab, 'visit');
    maybeAutoAttachToRelated(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateBadge();
  lastCapturedByTab.delete(tabId);
});

// ─── Manual mode: toolbar icon ────────────────────────────────────────────────
//
// In manual mode, clicking the toolbar icon saves the current tab. The badge
// shows each tab's state: "+" on a paper tab that isn't saved yet, "✓" once
// it's in the library. In auto mode the icon does nothing and has no badge.

async function updateTabBadge(tab) {
  if (!tab || tab.id == null) return;
  let text = '';
  if (tab.url && await getCaptureMode() === 'manual') {
    const papers = (await chrome.storage.local.get(PAPERS_KEY))[PAPERS_KEY] || {};
    const cls = classifyPaper(tab.url);
    const manual = manualClassification(tab.url);
    const saved = (cls && findExistingPaper(papers, cls.canonicalId)) ||
                  (manual && findExistingPaper(papers, manual.canonicalId));
    if (saved) text = '✓';
    else if (cls) text = '+';
  }
  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({
        tabId: tab.id,
        color: text === '✓' ? '#3d7a4a' : '#c8713a',
      });
    }
  } catch {}
}

async function updateActionTitle() {
  const title = await getCaptureMode() === 'manual'
    ? 'PaperClip — click to save this tab'
    : 'PaperClip — auto-adding papers you open';
  try { await chrome.action.setTitle({ title }); } catch {}
}

chrome.action.onClicked.addListener(async (tab) => {
  if (await getCaptureMode() !== 'manual') return;
  const result = await capturePaper(tab, 'manual');
  updateTabBadge(tab);
  if (!result) return;
  // Process the PDF now, while the click's activeTab grant lets us fetch it
  // (paywalled PDFs work too: the fetch carries the user's cookies): crop
  // Figure 1 and save the PDF + title image to the library folder.
  // Clicking a paper that's already saved redoes all of it — a fresh crop,
  // and its files overwritten under the same names — leaving tags, notes
  // and other library data untouched.
  scheduleFigureExtraction(tab.url, result.id);
});

// ─── Manual saves: first figure + files in the library folder ─────────────────
//
// The service worker fetches the PDF and parks it in Cache Storage; a hidden
// offscreen document (offscreen.js) runs pdf.js on it to crop the first
// figure, composes an image of the full title above that figure, and saves
// the PDF and image into the user's library folder (library-folder.js).
//
// The figure thumbnail shown in the table is stored under its own key
// ('figure:<paper id>') so the papers map stays small.
//   paper.figureStatus: 'pending' | 'ok' | 'none' (no raster figure) | 'failed'
//   paper.filesStatus:  'saved' | 'pending' (waiting for folder access) |
//                       'no-folder' | 'failed'
//   paper.files:        { pdf, image } file names in the folder

const FIGURE_CACHE = 'paperclip-pdf';
const MAX_PDF_BYTES = 120 * 1024 * 1024;

/** PDF URL for a paper tab: abstract pages map to their PDF, PDFs map to themselves. */
function pdfUrlForTab(rawUrl) {
  const u = new URL(rawUrl);
  const cls = classifyPaper(rawUrl);
  switch (cls && cls.source) {
    case 'arxiv':      return `${u.origin}/pdf/${cls.sourceId}`;
    case 'openreview': return `${u.origin}/pdf?id=${encodeURIComponent(cls.sourceId)}`;
    case 'acm':        return `${u.origin}/doi/pdf/${cls.doi}`;
    case 'ieee':       return `${u.origin}/stampPDF/getPDF.jsp?tp=&arnumber=${cls.sourceId}`;
    default:           return rawUrl;
  }
}

function looksLikePdf(buf) {
  const head = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
  return new TextDecoder('latin1').decode(head).includes('%PDF-');
}

async function patchStoredPaper(id, mutate) {
  const store = await chrome.storage.local.get(PAPERS_KEY);
  const papers = store[PAPERS_KEY] || {};
  if (!papers[id]) return;
  mutate(papers[id]);
  await chrome.storage.local.set({ [PAPERS_KEY]: papers });
}

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Render PDFs with pdf.js to crop the first figure of saved papers.',
  });
}

/**
 * True when the paper's title is a stand-in (its URL, a file name, or
 * "arXiv:2401.12345") rather than the real title.
 */
function hasPlaceholderTitle(paper) {
  const t = (paper.title || '').trim();
  if (!t || looksLikeUrlOrFilename(t) || /\.pdf$/i.test(t)) return true;
  const label = SOURCE_LABELS[paper.source] || paper.source;
  return !!paper.sourceId && t === `${label}:${paper.sourceId}`;
}

/**
 * The paper once its metadata lookup (which finds the real title) has
 * finished, or after `timeoutMs`. Reading storage keeps the worker alive.
 */
async function paperAfterEnrichment(paperId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const paper = ((await chrome.storage.local.get(PAPERS_KEY))[PAPERS_KEY] || {})[paperId];
    if (!paper || paper.enrichmentStatus !== 'pending' || Date.now() > deadline) return paper;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function extractFigure(pdfUrl, paperId) {
  await patchStoredPaper(paperId, p => { p.figureStatus = 'pending'; delete p.figureNote; });
  const cacheKey = `https://paperclip.invalid/pdf/${encodeURIComponent(paperId)}`;
  const cache = await caches.open(FIGURE_CACHE);
  try {
    const resp = await fetch(pdfUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error(`PDF download failed (HTTP ${resp.status})`);
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_PDF_BYTES) throw new Error('PDF is too large');
    if (!looksLikePdf(buf)) {
      await patchStoredPaper(paperId, p => { p.figureStatus = 'none'; p.figureNote = 'This page is not a PDF'; });
      return;
    }
    await cache.put(cacheKey, new Response(buf, { headers: { 'Content-Type': 'application/pdf' } }));

    // The title goes on the saved image and names the files, so wait for the
    // metadata lookup to find the real one. If it can't, the offscreen page
    // reads the title from the PDF itself.
    const paper = await paperAfterEnrichment(paperId);
    if (!paper) return; // deleted meanwhile

    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'process-paper',
      cacheName: FIGURE_CACHE,
      cacheKey,
      paperId,
      title: hasPlaceholderTitle(paper) ? '' : paper.title,
      fallbackTitle: paper.title,
      files: paper.files || null,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'PDF processing failed');

    const figureKey = `figure:${paperId}`;
    if (res.figure) await chrome.storage.local.set({ [figureKey]: res.figure.dataUrl });
    await patchStoredPaper(paperId, p => {
      if (res.figure) {
        p.figureKey = figureKey;
        p.figureStatus = 'ok';
        p.figurePage = res.figure.page;
        delete p.figureNote;
      } else {
        p.figureStatus = 'none';
        p.figureNote = 'No Figure 1 found in the first pages of the PDF';
      }
      // A title read from the PDF beats a placeholder like the file name.
      if (res.title && hasPlaceholderTitle(p)) p.title = res.title;
      if (res.files) p.files = res.files;
      p.filesStatus = res.filesStatus;
      if (res.filesNote) p.filesNote = res.filesNote;
      else delete p.filesNote;
    });
  } catch (err) {
    console.warn('[paperclip] figure extraction failed', paperId, err);
    await patchStoredPaper(paperId, p => {
      p.figureStatus = 'failed';
      p.figureNote = String((err && err.message) || err);
    });
  } finally {
    cache.delete(cacheKey);
  }
}

// One extraction at a time; close the offscreen document when idle to free
// pdf.js's memory.
let figureChain = Promise.resolve();
let figureJobs = 0;
const figureQueued = new Set(); // paper ids waiting to be processed

function scheduleFigureExtraction(tabUrl, paperId) {
  // Repeated clicks while a paper is still waiting don't queue it again.
  if (figureQueued.has(paperId)) return;
  let pdfUrl;
  try { pdfUrl = pdfUrlForTab(tabUrl); } catch { return; }
  figureQueued.add(paperId);
  figureJobs++;
  figureChain = figureChain
    .then(() => {
      figureQueued.delete(paperId);
      return extractFigure(pdfUrl, paperId);
    })
    .finally(async () => {
      if (--figureJobs === 0) {
        try { await chrome.offscreen.closeDocument(); } catch {}
      }
    });
}

async function updateAllTabBadges() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) updateTabBadge(t);
}

// Switching modes, or adding / deleting papers, changes which tabs need a "+".
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CAPTURE_MODE_KEY]) updateActionTitle();
  if (changes[CAPTURE_MODE_KEY] || changes[PAPERS_KEY]) updateAllTabBadges();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();
  if (changeInfo.url || changeInfo.status === 'complete') updateTabBadge(tab);
  // Capture on URL change (eager — don't wait for load to finish), on load
  // complete (so we get the final title), and on title-only updates (Chrome
  // sometimes sets the title after status='complete'). capturePaper dedupes
  // per-tab so we don't overcount visits when multiple events fire.
  if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
    if (tab && tab.url) {
      capturePaper(tab, 'visit');
      maybeAutoAttachToRelated(tab);
      if (changeInfo.status === 'complete') retryIEEEOnTabLoad(tab);
    }
  }
});

// Message handler: the new-tab page asks us to re-scan tabs whenever it
// loads, as a safety net for anything we missed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'paperclip:backfill') {
    (async () => {
      const count = await backfillExistingTabs();
      retryStuckEnrichments();
      sendResponse({ ok: true, count });
    })();
    return true; // keep channel open for async response
  }
});

// Initial run
updateBadge();
updateActionTitle();
updateAllTabBadges();
backfillExistingTabs().then(() => retryStuckEnrichments());
