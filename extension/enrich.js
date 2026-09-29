/**
 * enrich.js — fetch paper metadata from public APIs.
 *
 * Loaded by the service worker via importScripts. Exposes
 * self.PaperEnrich.enrich(paper) → Promise<patches | null>.
 *
 * Returning null means "no enrichment path for this source"; throwing means
 * a network/parse error and the caller should mark the entry failed.
 */

(function () {
  // ─── XML helpers (no DOMParser in service workers) ────────────────────────

  function decodeXml(s) {
    return (s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&amp;/g, '&');
  }

  function cleanWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function firstTagText(xml, tag) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
    const m = xml.match(re);
    return m ? decodeXml(m[1]) : '';
  }

  // ─── Per-source fetchers ──────────────────────────────────────────────────

  async function enrichArxiv(paper) {
    const id = paper.sourceId;
    if (!id) return null;

    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`arxiv: HTTP ${r.status}`);
    const xml = await r.text();

    const entryMatch = xml.match(/<entry\b[\s\S]*?<\/entry>/);
    if (!entryMatch) throw new Error('arxiv: no entry');
    const entry = entryMatch[0];

    const title = firstTagText(entry, 'title');
    const summary = firstTagText(entry, 'summary');
    const published = firstTagText(entry, 'published');
    const year = published ? parseInt(published.slice(0, 4), 10) : null;

    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
      .map(m => cleanWhitespace(decodeXml(m[1])))
      .filter(Boolean);

    const journalMatch = entry.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/);
    const venue = journalMatch ? cleanWhitespace(decodeXml(journalMatch[1])) : null;

    const out = {
      title: cleanWhitespace(title),
      authors,
      year,
      abstract: cleanWhitespace(summary),
    };
    if (venue) out.venue = venue;
    return out;
  }

  // ─── OpenReview ───────────────────────────────────────────────────────────

  function pickOpenReviewField(content, key) {
    const v = content && content[key];
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && 'value' in v) return v.value;
    return null;
  }

  async function enrichOpenReview(paper) {
    const id = paper.sourceId;
    if (!id) return null;
    const url = `https://api.openreview.net/notes?id=${encodeURIComponent(id)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`openreview: HTTP ${r.status}`);
    const json = await r.json();
    const note = json && json.notes && json.notes[0];
    if (!note) throw new Error('openreview: no note');

    const c = note.content || {};
    const title = pickOpenReviewField(c, 'title');
    const authorsField = pickOpenReviewField(c, 'authors');
    const venue = pickOpenReviewField(c, 'venue') || pickOpenReviewField(c, 'venueid');
    const abstract = pickOpenReviewField(c, 'abstract');

    let authors = [];
    if (Array.isArray(authorsField)) {
      authors = authorsField.map(a => cleanWhitespace(String(a))).filter(Boolean);
    } else if (typeof authorsField === 'string') {
      authors = authorsField.split(/\s*,\s*|\s* and \s*/).map(cleanWhitespace).filter(Boolean);
    }

    let year = null;
    if (note.cdate) {
      const d = new Date(note.cdate);
      if (!isNaN(d)) year = d.getFullYear();
    }

    const out = { title: cleanWhitespace(title), authors };
    if (year) out.year = year;
    if (venue) out.venue = cleanWhitespace(venue);
    if (abstract) out.abstract = cleanWhitespace(abstract);
    return out;
  }

  // ─── Crossref (DOI-based: biorxiv/medrxiv/acm/springer/science) ───────────

  function stripHtml(s) {
    return (s || '').replace(/<[^>]+>/g, '');
  }

  function decodeHtmlEntities(s) {
    return (s || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function readMetaContent(html, name) {
    const re = new RegExp(
      `<meta\\b[^>]*\\bname=["']${escapeRegExp(name)}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      'i'
    );
    const m = html.match(re);
    return m ? decodeHtmlEntities(m[1]) : '';
  }

  function readMetaContents(html, name) {
    const re = new RegExp(
      `<meta\\b[^>]*\\bname=["']${escapeRegExp(name)}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      'gi'
    );
    const out = [];
    let m;
    while ((m = re.exec(html))) {
      out.push(decodeHtmlEntities(m[1]));
    }
    return out;
  }

  function readScriptField(html, field) {
    const re = new RegExp(`(?:"|')${escapeRegExp(field)}(?:"|')\\s*:\\s*(?:"([^"]+)"|'([^']+)')`, 'i');
    const m = html.match(re);
    return m ? decodeHtmlEntities(m[1] || m[2] || '') : '';
  }

  function normalizeDoi(raw) {
    const s = cleanWhitespace(String(raw || ''))
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/doi\.org\//i, '')
      .replace(/^https?:\/\/dx\.doi\.org\//i, '');
    const m = s.match(/10\.\d{4,9}\/\S+/i);
    return m ? m[0].replace(/[\s"'>).,;]+$/g, '') : '';
  }

  function extractDoiFromIEEEHtml(html) {
    const candidates = [
      readMetaContent(html, 'citation_doi'),
      readMetaContent(html, 'dc.identifier'),
      readScriptField(html, 'doiLink'),
      readScriptField(html, 'doi'),
    ];
    for (const value of candidates) {
      const doi = normalizeDoi(value);
      if (doi) return doi;
    }
    return '';
  }

  async function enrichCrossrefByDoi(doi) {
    if (!doi) return null;
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'PaperClip/1.0 (Chrome extension)' }
    });
    if (!r.ok) throw new Error(`crossref: HTTP ${r.status}`);
    const json = await r.json();
    const m = json && json.message;
    if (!m) throw new Error('crossref: no message');

    const title = (Array.isArray(m.title) ? m.title[0] : m.title) || '';
    const venue = (Array.isArray(m['container-title']) ? m['container-title'][0] : m['container-title']) || null;

    const authors = Array.isArray(m.author)
      ? m.author.map(a => cleanWhitespace(`${a.given || ''} ${a.family || ''}`)).filter(Boolean)
      : [];

    let year = null;
    const dp = (m['published-print'] || m['published-online'] || m.issued || {})['date-parts'];
    if (Array.isArray(dp) && Array.isArray(dp[0]) && dp[0][0]) year = dp[0][0];

    const abstract = m.abstract ? cleanWhitespace(stripHtml(m.abstract)) : null;

    const out = { title: cleanWhitespace(title), authors };
    if (year) out.year = year;
    if (venue) out.venue = cleanWhitespace(venue);
    if (abstract) out.abstract = abstract;
    return out;
  }

  async function enrichCrossref(paper) {
    const doi = paper.doi || paper.sourceId;
    if (!doi) return null;
    return enrichCrossrefByDoi(doi);
  }

  // ─── IEEE Xplore web metadata (arnumber-based) ──────────────────────────
  //
  // ieeexplore.ieee.org sits behind an AWS WAF bot challenge, so a plain
  // fetch from the service worker gets a 202 JS-challenge page instead of the
  // document. The page the user has open already passed the challenge, so the
  // preferred path is to read the metadata from inside that tab (see
  // ieeeTabProbe + ctx.runInIEEETab). The direct fetch is only a fallback.
  //
  // IEEE doesn't emit citation_* meta tags; the metadata lives in an inline
  // script as `xplGlobal.document.metadata = {...};`.

  /**
   * Injected into an IEEE tab via chrome.scripting.executeScript, so it must
   * be self-contained (no closure references). Returns the live metadata
   * object when the tab is already showing this document, otherwise the HTML
   * of /document/<arnumber>/ fetched same-origin (relative URL, so it also
   * works through EZproxy hosts). Returns null on a bot-challenge page.
   */
  async function ieeeTabProbe(arnumber) {
    const g = window.xplGlobal;
    const live = g && g.document && g.document.metadata;
    if (live && String(live.articleNumber) === String(arnumber)) {
      return { metadata: live };
    }
    const r = await fetch(`/document/${arnumber}/`, { credentials: 'include' });
    if (!r.ok) return null;
    const html = await r.text();
    if (/gokuProps|AwsWafIntegration/.test(html)) return null;
    return { html };
  }

  function isIEEEChallengePage(html) {
    return /gokuProps|AwsWafIntegration/.test(html) || !/xplGlobal/.test(html);
  }

  // Pull the JSON object assigned to xplGlobal.document.metadata out of the
  // page HTML by scanning for its balanced closing brace.
  function extractXplMetadata(html) {
    const m = /xplGlobal\.document\.metadata\s*=\s*\{/.exec(html || '');
    if (!m) return null;
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let inString = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }

  function ieeeFromXplMetadata(md) {
    const text = v => cleanWhitespace(decodeHtmlEntities(stripHtml(String(v || ''))));

    const title = text(md.formulaStrippedArticleTitle || md.title || md.displayDocTitle);
    const authors = Array.isArray(md.authors)
      ? md.authors
        .map(a => text(a && (a.name || `${a.firstName || ''} ${a.lastName || ''}`)))
        .filter(Boolean)
      : [];
    const venue = text(md.displayPublicationTitle || md.publicationTitle);
    const abstract = text(md.abstract);
    const doi = normalizeDoi(md.doi);

    let year = null;
    const yearSrc = [md.publicationYear, md.publicationDate, md.conferenceDate, md.onlineDate]
      .map(v => String(v || ''))
      .find(v => /\b(19|20)\d{2}\b/.test(v));
    if (yearSrc) year = parseInt(yearSrc.match(/\b(19|20)\d{2}\b/)[0], 10);

    return { title, authors, year, venue, abstract, doi };
  }

  // Fallback for pages without xplGlobal: whatever meta tags are present.
  function ieeeFromMetaTags(html) {
    const title =
      readMetaContent(html, 'citation_title') ||
      readMetaContent(html, 'dc.title') ||
      '';

    const authors = readMetaContents(html, 'citation_author')
      .map(a => cleanWhitespace(a))
      .filter(Boolean);

    const venue = cleanWhitespace(
      readMetaContent(html, 'citation_journal_title') ||
      readMetaContent(html, 'citation_conference_title') ||
      readMetaContent(html, 'citation_publication_title') ||
      ''
    );

    const abstract = cleanWhitespace(
      readMetaContent(html, 'citation_abstract') ||
      readMetaContent(html, 'description') ||
      ''
    );

    let year = null;
    const pubDate =
      readMetaContent(html, 'citation_publication_date') ||
      readMetaContent(html, 'citation_date') ||
      readMetaContent(html, 'citation_year') ||
      '';
    const yearMatch = String(pubDate).match(/\b(19|20)\d{2}\b/);
    if (yearMatch) year = parseInt(yearMatch[0], 10);

    return { title: cleanWhitespace(title), authors, year, venue, abstract, doi: extractDoiFromIEEEHtml(html) };
  }

  function ieeeFromHtml(html) {
    const md = extractXplMetadata(html);
    return md ? ieeeFromXplMetadata(md) : ieeeFromMetaTags(html);
  }

  function ieeeArnumberFromPaper(paper) {
    if (paper && /^\d+$/.test(String(paper.sourceId || ''))) return String(paper.sourceId);
    if (paper && paper.url) {
      try {
        const u = new URL(paper.url);
        const q = u.searchParams.get('arnumber');
        if (q && /^\d+$/.test(q)) return q;
        const m = (u.pathname || '').match(/\/(?:abstract\/)?document\/(\d+)/i);
        if (m) return m[1];
      } catch {}
    }
    return null;
  }

  async function enrichIEEE(paper, ctx) {
    const arnumber = ieeeArnumberFromPaper(paper);
    if (!arnumber) return null;

    let info = null;

    // 1. Preferred: read from an open IEEE tab that already passed the WAF.
    if (ctx && ctx.runInIEEETab) {
      try {
        const probe = await ctx.runInIEEETab(ieeeTabProbe, [arnumber], paper);
        if (probe && probe.metadata) info = ieeeFromXplMetadata(probe.metadata);
        else if (probe && probe.html) info = ieeeFromHtml(probe.html);
      } catch (err) {
        console.warn('[paperclip] ieee tab probe failed', paper.id, err);
      }
    }

    // 2. Fallback: direct fetch. Usually hits the bot challenge, which comes
    //    back as HTTP 202 — so check the body, not just r.ok.
    if (!info || (!info.title && !info.doi)) {
      const url = `https://ieeexplore.ieee.org/document/${encodeURIComponent(arnumber)}/`;
      const r = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
      });
      if (!r.ok) throw new Error(`ieee: HTTP ${r.status}`);
      const html = await r.text();
      if (isIEEEChallengePage(html)) throw new Error('ieee: blocked by bot challenge');
      info = ieeeFromHtml(html);
    }

    // An empty result must not count as success, or the paper gets stuck as
    // 'ok' with no metadata and is never retried.
    if (!info.title && !info.doi) throw new Error('ieee: no metadata found');

    const out = { title: info.title, authors: info.authors };
    if (info.year) out.year = info.year;
    if (info.venue) out.venue = info.venue;
    if (info.abstract) out.abstract = info.abstract;
    if (info.doi) out.doi = info.doi.toLowerCase();
    return out;
  }

  // ─── Semantic Scholar (universal — provides venue + cross-source IDs) ─────
  //
  // Returns externalIds like { DOI, ArXiv, ACL, MAG, ... } so the same paper
  // visited via different URLs (arxiv abs vs CHI portal) can be deduped.

  function s2IdentifierFor(paper) {
    if (paper.source === 'arxiv' && paper.sourceId) return `arXiv:${paper.sourceId}`;
    if (paper.doi) return `DOI:${paper.doi}`;
    if (paper.source === 'semanticscholar' && paper.sourceId) return paper.sourceId;
    if (paper.url) return `URL:${paper.url}`;
    return null;
  }

  async function fetchS2(identifier) {
    if (!identifier) return null;
    const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(identifier)}?fields=title,authors,year,venue,abstract,externalIds`;
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s2: HTTP ${r.status}`);
    const json = await r.json();
    if (!json || !json.title) return null;

    return {
      title: cleanWhitespace(json.title),
      authors: Array.isArray(json.authors)
        ? json.authors.map(a => cleanWhitespace(a && a.name)).filter(Boolean)
        : [],
      year: json.year || null,
      venue: json.venue ? cleanWhitespace(json.venue) : null,
      abstract: json.abstract ? cleanWhitespace(json.abstract) : null,
      externalIds: json.externalIds || null,
    };
  }

  // ─── Merging primary (source-specific) and supplement (S2) ────────────────
  //
  // Source-specific APIs (arXiv, OpenReview, Crossref) win on title, authors,
  // and abstract — they're authoritative for their domain. S2 wins on venue
  // (it knows where preprints got accepted) and is the only source for
  // externalIds.

  function pickMerged(primary, supplement) {
    if (!primary && !supplement) return null;
    if (!primary) return supplement;
    if (!supplement) return primary;
    return {
      title: primary.title || supplement.title || null,
      authors: (primary.authors && primary.authors.length)
        ? primary.authors
        : (supplement.authors || []),
      year: primary.year || supplement.year || null,
      venue: supplement.venue || primary.venue || null,
      abstract: primary.abstract || supplement.abstract || null,
      externalIds: supplement.externalIds || primary.externalIds || null,
      doi: primary.doi || supplement.doi || null,
    };
  }

  // ─── Dispatch ─────────────────────────────────────────────────────────────
  //
  // Strategy: run the source-specific fetcher (when available) AND a S2
  // lookup, then merge. Source-specific fetcher might throw or return null;
  // S2 might too. As long as ONE returns data, we have something to show.
  // If both fail with errors, propagate so the caller marks 'failed' and
  // retries later. If both return null (i.e. 404s), return null for
  // 'unsupported'.

  // ctx (optional, supplied by the service worker):
  //   runInIEEETab(func, args, paper) — run func inside an open IEEE tab.
  async function enrich(paper, ctx) {
    if (!paper) return null;

    let primary = null;
    let primaryError = null;

    try {
      switch (paper.source) {
        case 'arxiv':
          primary = await enrichArxiv(paper);
          break;
        case 'openreview':
          primary = await enrichOpenReview(paper);
          break;
        case 'biorxiv':
        case 'medrxiv':
        case 'acm':
        case 'springer':
        case 'science':
          primary = await enrichCrossref(paper);
          break;
        case 'ieee':
          primary = await enrichIEEE(paper, ctx);
          break;
      }
    } catch (err) {
      primaryError = err;
      console.warn('[paperclip] primary enrichment failed', paper.id, err);
    }

    let supplement = null;
    let supplementError = null;

    try {
      if (paper.source === 'ieee' && primary && primary.doi) {
        const crossref = await enrichCrossrefByDoi(primary.doi);
        let s2 = null;
        try {
          s2 = await fetchS2(`DOI:${primary.doi}`);
        } catch (err) {
          supplementError = err;
          console.warn('[paperclip] S2 supplement failed', paper.id, err);
        }
        supplement = pickMerged(crossref, s2);
      } else {
        // If the source-specific fetch discovered a DOI, prefer it for S2.
        const identifier = (primary && primary.doi)
          ? `DOI:${primary.doi}`
          : s2IdentifierFor(paper);
        if (identifier) supplement = await fetchS2(identifier);
      }
    } catch (err) {
      supplementError = err;
      console.warn('[paperclip] S2 supplement failed', paper.id, err);
    }

    if (!primary && !supplement) {
      if (primaryError || supplementError) throw primaryError || supplementError;
      return null;
    }

    return pickMerged(primary, supplement);
  }

  self.PaperEnrich = { enrich };
})();
