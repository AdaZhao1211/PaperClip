/**
 * figure.js — find and crop Figure 1 of a PDF, faithfully.
 *
 * Loaded as an ES module by offscreen.js. Pure logic over pdf.js: no
 * chrome.* APIs, so it can be tested in a plain page.
 *
 * The crop follows what a person does by hand:
 *   1. Locate Figure 1 by its caption ("Figure 1:", "Fig. 1.", …), on
 *      whichever of the first pages it is.
 *   2. Choose the crop: start from the graphics next to the caption and grow
 *      the region over everything that belongs to the figure — raster images,
 *      vector drawings (arrows, plots, boxes) and their labels — stopping at
 *      the caption and at the paper's body text.
 *   3. Check the boundary: a text line cut by the crop edge is either pulled
 *      in (a figure label) or pushed out (caption, body text, headings).
 *   4. Render just that rectangle at 300 DPI, so photos, diagrams and text
 *      in the figure stay sharp.
 * If no caption is found, the first group of embedded images big enough to
 * be a figure is used as the starting point instead.
 *
 * Coordinates are PDF user space (points, y pointing up) unless noted.
 */

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const { OPS } = pdfjsLib;

const MAX_PAGES = 5;
const RENDER_DPI = 300;
const MAX_CROP_PX = 5000;       // safety cap on the rendered width/height
const CAPTION_RE = /^(figure|fig\.?)\s*1(?:\.\d+)?\s*[:.|—–-]/i;
const CAPTION_SEARCH_PT = 160;  // how far from the caption the figure may start
const GRAPHIC_GAP = 8;          // graphics this close belong together
const LABEL_GAP = 8;            // labels this close to the figure belong to it
const PAD = 3;                  // breathing room around the crop
// Fallback (no caption): minimum size of a group of raster images.
const MIN_FIGURE_W = 90;
const MIN_FIGURE_H = 60;
const MAX_ASPECT = 6;

// ─── Geometry ─────────────────────────────────────────────────────────────────

// Affine matrices as [a, b, c, d, e, f], composed like canvas transform():
// mul(A, B) applies B first, then A.
function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function apply(M, x, y) {
  return [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
}

/** Axis-aligned box of the rectangle (x1,y1)-(x2,y2) after transform M. */
function transformBox(M, x1, y1, x2, y2) {
  const pts = [apply(M, x1, y1), apply(M, x2, y1), apply(M, x1, y2), apply(M, x2, y2)];
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

const boxW = b => b.x2 - b.x1;
const boxH = b => b.y2 - b.y1;
const area = b => Math.max(0, boxW(b)) * Math.max(0, boxH(b));

function intersect(a, b) {
  const r = { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
  return r.x2 > r.x1 && r.y2 > r.y1 ? r : null;
}

function union(a, b) {
  return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
}

function near(a, b, gap) {
  return a.x1 - gap <= b.x2 && b.x1 - gap <= a.x2 && a.y1 - gap <= b.y2 && b.y1 - gap <= a.y2;
}

const contains = (outer, inner) =>
  inner.x1 >= outer.x1 - 0.5 && inner.x2 <= outer.x2 + 0.5 && inner.y1 >= outer.y1 - 0.5 && inner.y2 <= outer.y2 + 0.5;

const hOverlap = (a, b) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
const vOverlap = (a, b) => Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);

// ─── Page contents: graphics and text lines ──────────────────────────────────

const PAINT_OPS = new Set([
  OPS.fill, OPS.eoFill, OPS.stroke, OPS.closeStroke, OPS.fillStroke,
  OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const FILL_ONLY_OPS = new Set([OPS.fill, OPS.eoFill]);

function isWhite(args) {
  const v = args && args[0];
  if (typeof v === 'string') return /^#?f{6}$/i.test(v.replace('#', '')) || /^#?fff$/i.test(v);
  if (Array.isArray(args) && args.length >= 3 && args.every(n => typeof n === 'number')) {
    const max = Math.max(...args) > 1 ? 255 : 1;
    return args.slice(0, 3).every(n => n >= 0.98 * max);
  }
  return false;
}

/**
 * Boxes of everything painted on the page except text: raster images and
 * vector paths, each clipped to the clip region in effect. White fills
 * (backgrounds) and page-sized shapes are skipped.
 */
async function pageGraphics(page, pageBox) {
  const ops = await page.getOperatorList();
  const pageArea = area(pageBox);
  const out = [];
  let state = { ctm: [1, 0, 0, 1, 0, 0], clip: pageBox, white: false };
  const stack = [];
  let pendingClip = false;

  const add = (box, kind) => {
    const b = intersect(box, state.clip);
    if (!b || area(b) > pageArea * 0.5) return;
    if (boxW(b) < 0.5 && boxH(b) < 0.5) return;
    out.push({ ...b, kind });
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(state);
        state = { ...state };
        break;
      case OPS.restore:
        if (stack.length) state = stack.pop();
        break;
      case OPS.transform:
        state.ctm = mul(state.ctm, args);
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(state);
        state = { ...state };
        if (Array.isArray(args[0]) && args[0].length === 6) state.ctm = mul(state.ctm, args[0]);
        const bbox = args[1];
        if (Array.isArray(bbox) && bbox.length === 4) {
          state.clip = intersect(state.clip, transformBox(state.ctm, ...bbox)) || { x1: 0, y1: 0, x2: 0, y2: 0 };
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        if (stack.length) state = stack.pop();
        break;
      case OPS.beginGroup:
        stack.push(state);
        state = { ...state };
        if (args[0] && Array.isArray(args[0].matrix)) state.ctm = mul(state.ctm, args[0].matrix);
        break;
      case OPS.endGroup:
        if (stack.length) state = stack.pop();
        break;
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillCMYKColor:
      case OPS.setFillColor:
        state.white = isWhite(args);
        break;
      case OPS.setFillColorN:
      case OPS.setFillColorSpace:
        state.white = false;
        break;
      case OPS.constructPath: {
        const [paintOp, , minMax] = args;
        if (!minMax || !Number.isFinite(minMax[0])) { pendingClip = false; break; }
        const box = transformBox(state.ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
        if (pendingClip) {
          state.clip = intersect(state.clip, box) || { x1: 0, y1: 0, x2: 0, y2: 0 };
          pendingClip = false;
        }
        if (PAINT_OPS.has(paintOp) && !(FILL_ONLY_OPS.has(paintOp) && state.white)) add(box, 'path');
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        add(transformBox(state.ctm, 0, 0, 1, 1), 'image');
        break;
      case OPS.paintImageMaskXObject:
        add(transformBox(state.ctm, 0, 0, 1, 1), 'path');
        break;
    }
  }
  return out;
}

/** Text runs merged into lines, each with its box, text and font size. */
async function textLines(page) {
  const { items } = await page.getTextContent();
  const runs = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || it.height || 1;
    const vertical = Math.abs(b) > Math.abs(a);
    const box = vertical
      ? { x1: x - size, x2: x + size * 0.25, y1: Math.min(y, y + it.width), y2: Math.max(y, y + it.width) }
      : { x1: x, x2: x + it.width, y1: y - size * 0.25, y2: y + size * 0.85 };
    runs.push({ ...box, str: it.str, size, base: y, vertical });
  }
  runs.sort((p, q) => (q.base - p.base) || (p.x1 - q.x1));

  const lines = [];
  for (const r of runs) {
    let line = null;
    if (!r.vertical) {
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 12; i--) {
        const L = lines[i];
        if (L.vertical) continue;
        if (Math.abs(L.base - r.base) < 0.5 * Math.min(L.size, r.size) &&
            r.x1 - L.x2 < 1.2 * Math.max(L.size, r.size) && r.x1 >= L.x1 - 1) {
          line = L;
          break;
        }
      }
    }
    if (line) {
      const space = r.x1 - line.x2 > 0.15 * r.size ? ' ' : '';
      line.str += space + r.str;
      line.x2 = Math.max(line.x2, r.x2);
      line.y1 = Math.min(line.y1, r.y1);
      line.y2 = Math.max(line.y2, r.y2);
      line.size = Math.max(line.size, r.size);
    } else {
      lines.push({ ...r });
    }
  }
  for (const L of lines) L.str = L.str.replace(/\s+/g, ' ').trim();
  return lines;
}

/** Most common font size, weighted by amount of text: the body text size. */
function bodyFontSize(lines) {
  const weight = new Map();
  for (const L of lines) {
    const s = Math.round(L.size * 2) / 2;
    weight.set(s, (weight.get(s) || 0) + L.str.length);
  }
  let best = 10, bestW = -1;
  for (const [s, w] of weight) if (w > bestW) { best = s; bestW = w; }
  return best;
}

// ─── Finding the figure ──────────────────────────────────────────────────────

/** The caption line of Figure 1 plus the lines that continue it. */
function captionBlock(lines, captionLine) {
  let block = { x1: captionLine.x1, y1: captionLine.y1, x2: captionLine.x2, y2: captionLine.y2 };
  const members = new Set([captionLine]);
  let last = captionLine;
  const below = lines
    .filter(L => !L.vertical && L.base < captionLine.base)
    .sort((p, q) => q.base - p.base);
  for (const L of below) {
    if (L.y2 < last.y1 - last.size * 0.9) break; // gap: caption ended
    if (hOverlap(L, block) <= 0) continue;        // other column
    if (Math.abs(L.size - captionLine.size) > 1.5) break;
    block = union(block, L);
    members.add(L);
    last = L;
  }
  return { box: block, members };
}

/** Groups of nearly touching raster images; the first one sized like a figure. */
function firstImageCluster(graphics) {
  const tiles = graphics.filter(g => g.kind === 'image' && boxW(g) >= 20 && boxH(g) >= 20);
  const used = new Set();
  for (let i = 0; i < tiles.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let region = { ...tiles[i] };
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < tiles.length; j++) {
        if (used.has(j) || !near(region, tiles[j], 14)) continue;
        used.add(j);
        region = union(region, tiles[j]);
        grew = true;
      }
    }
    const w = boxW(region), h = boxH(region);
    if (w >= MIN_FIGURE_W && h >= MIN_FIGURE_H && w / h <= MAX_ASPECT && h / w <= MAX_ASPECT) return region;
  }
  return null;
}

/**
 * Grow `seed` into the whole figure and settle its boundary.
 * `allowed(box)` limits where the figure may extend (e.g. above its caption).
 */
function growFigure(seed, graphics, lines, caption, pageBox, allowed) {
  const body = bodyFontSize(lines);
  const bodyLines = lines.filter(L => !L.vertical && Math.abs(L.size - body) <= 0.6);
  const sortedWidths = bodyLines.map(boxW).sort((a, b) => a - b);
  const columnWidth = sortedWidths[Math.floor(sortedWidths.length * 0.9)] || boxW(pageBox) / 2;

  const isCaption = L => caption && caption.members.has(L);
  // Text that is part of the page, not the figure: caption, paragraphs of
  // body text, headings and the paper's title block.
  const isPageText = L => isCaption(L) ||
    (!L.vertical && Math.abs(L.size - body) <= 0.6 && boxW(L) >= 0.45 * columnWidth) ||
    L.size > body * 1.5;

  const usableGraphics = graphics.filter(allowed);
  const labels = lines.filter(L => !isPageText(L) && allowed(L));

  // Side-by-side panels: a graphic in the same horizontal band as the
  // figure and under its caption's width belongs to it, however wide the
  // gap between panels.
  const sidePanel = g => caption &&
    hOverlap(g, caption.box) >= 0.5 * boxW(g) &&
    vOverlap(region, g) >= 0.5 * Math.min(boxH(g), boxH(region));

  // 1. Grow over touching graphics, side-by-side panels and nearby labels.
  let region = { ...seed };
  const inFigure = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of usableGraphics) {
      if (!inFigure.has(g) && (near(region, g, GRAPHIC_GAP) || sidePanel(g))) {
        inFigure.add(g);
        region = union(region, g);
        grew = true;
      }
    }
    for (const L of labels) {
      if (!inFigure.has(L) && near(region, L, LABEL_GAP)) {
        inFigure.add(L);
        region = union(region, L);
        grew = true;
      }
    }
  }

  // 2. Settle the boundary: lines cut by the edge are pulled in when they're
  //    labels, pushed out when they're page text.
  const settle = r => {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const L of lines) {
        if (!intersect(r, L) || contains(r, L)) continue;
        if (!isPageText(L) && allowed(L)) {
          r = union(r, L);
          changed = true;
        } else {
          const cy = (r.y1 + r.y2) / 2;
          const ly = (L.y1 + L.y2) / 2;
          if (ly > cy) r = { ...r, y2: Math.min(r.y2, L.y1 - 0.5) };
          else r = { ...r, y1: Math.max(r.y1, L.y2 + 0.5) };
          changed = true;
        }
      }
      if (!changed) break;
    }
    return r;
  };
  region = settle(region);

  // 3. Page text sitting wholly above or below every graphic inside the
  //    region (e.g. an author line) is not part of the figure: trim it off.
  const graphicsInside = usableGraphics.filter(g => intersect(region, g));
  if (graphicsInside.length) {
    const gTop = Math.max(...graphicsInside.map(g => g.y2));
    const gBottom = Math.min(...graphicsInside.map(g => g.y1));
    for (const L of lines) {
      if (!isPageText(L) || !contains(region, L)) continue;
      if (L.y1 >= gTop) region = { ...region, y2: Math.min(region.y2, L.y1 - 0.5) };
      else if (L.y2 <= gBottom) region = { ...region, y1: Math.max(region.y1, L.y2 + 0.5) };
    }
  }

  // 4. A little padding, kept off the page text.
  region = {
    x1: Math.max(pageBox.x1, region.x1 - PAD), y1: Math.max(pageBox.y1, region.y1 - PAD),
    x2: Math.min(pageBox.x2, region.x2 + PAD), y2: Math.min(pageBox.y2, region.y2 + PAD),
  };
  for (const L of lines) {
    if (!isPageText(L) || !intersect(region, L) || contains(region, L) && !isCaption(L)) continue;
    const ly = (L.y1 + L.y2) / 2;
    if (ly > (region.y1 + region.y2) / 2) region.y2 = Math.min(region.y2, L.y1 - 0.5);
    else region.y1 = Math.max(region.y1, L.y2 + 0.5);
  }
  return region;
}

/** Locate Figure 1 on the first pages. Resolves to { pageNumber, region } or null. */
async function findFigure(pdf) {
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const scanned = [];

  // 1. By caption.
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n);
    const [x1, y1, x2, y2] = page.view;
    const pageBox = { x1, y1, x2, y2 };
    const lines = await textLines(page);
    const captionLine = lines
      .filter(L => !L.vertical && CAPTION_RE.test(L.str))
      .sort((p, q) => q.base - p.base)[0];
    const entry = { n, page, pageBox, lines, graphics: null };
    scanned.push(entry);
    if (!captionLine) continue;

    const caption = captionBlock(lines, captionLine);
    entry.graphics = await pageGraphics(page, pageBox);
    const cap = caption.box;

    // Figures sit above their caption; occasionally below.
    for (const side of ['above', 'below']) {
      const allowed = side === 'above' ? b => b.y1 >= cap.y2 - 0.5 : b => b.y2 <= cap.y1 + 0.5;
      const dist = g => (side === 'above' ? g.y1 - cap.y2 : cap.y1 - g.y2);
      const seed = entry.graphics
        .filter(g => allowed(g) && hOverlap(g, cap) > 0 && dist(g) <= CAPTION_SEARCH_PT)
        .sort((p, q) => dist(p) - dist(q))[0];
      if (seed) {
        return { pageNumber: n, region: growFigure(seed, entry.graphics, lines, caption, pageBox, allowed) };
      }
    }
  }

  // 2. No usable caption: the first group of embedded images that's figure-sized.
  for (const entry of scanned) {
    entry.graphics ||= await pageGraphics(entry.page, entry.pageBox);
    const seed = firstImageCluster(entry.graphics);
    if (seed) {
      return { pageNumber: entry.n, region: growFigure(seed, entry.graphics, entry.lines, null, entry.pageBox, () => true) };
    }
  }
  return null;
}

/** Render just `region` (PDF user space) of the page at 300 DPI. */
async function renderRegion(page, region) {
  let scale = RENDER_DPI / 72;
  scale = Math.min(scale, MAX_CROP_PX / boxW(region), MAX_CROP_PX / boxH(region));
  const viewport = page.getViewport({ scale });
  // PDF user space → canvas pixels (viewport.transform handles scale,
  // rotation and the flipped y axis).
  const [vx1, vy1] = apply(viewport.transform, region.x1, region.y1);
  const [vx2, vy2] = apply(viewport.transform, region.x2, region.y2);
  const left = Math.floor(Math.min(vx1, vx2));
  const top = Math.floor(Math.min(vy1, vy2));
  const width = Math.ceil(Math.abs(vx2 - vx1));
  const height = Math.ceil(Math.abs(vy2 - vy1));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: [1, 0, 0, 1, -left, -top],
    // 'display' paces rendering with requestAnimationFrame, which never
    // fires in a hidden offscreen document; 'print' renders straight through.
    intent: 'print',
  }).promise;
  return canvas;
}

// ─── Title from the PDF ───────────────────────────────────────────────────────
//
// Used when the paper's real title isn't known (e.g. a PDF that metadata
// lookup can't identify). Prefer the document's Title field when it looks
// like a real title; otherwise take the largest text near the top of page 1.

function plausibleTitle(s) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  if (words.length < 3 || t.length > 300) return '';
  // Small caps and ligatures can extract as fragments ("L RA: L -R A …").
  if (words.filter(w => w.replace(/[^\p{L}]/gu, '').length <= 1).length > words.length * 0.3) return '';
  if (/^(microsoft word|untitled|arxiv|paper|main|manuscript)\b/i.test(t)) return '';
  if (/\.(pdf|docx?|tex)$/i.test(t)) return '';
  return t;
}

async function guessTitle(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    const fromInfo = plausibleTitle(info && info.Title);
    if (fromInfo) return fromInfo;
  } catch {}

  const page = await pdf.getPage(1);
  const [, , , pageTop] = page.view;
  const { items } = await page.getTextContent();
  // Text in the top 60% of the page, with its font size and position.
  const runs = items
    .filter(it => it.str && it.str.trim())
    .map(it => ({ str: it.str, size: Math.abs(it.transform[3]) || it.height, x: it.transform[4], y: it.transform[5] }))
    .filter(r => r.y > pageTop * 0.4);
  if (!runs.length) return '';
  const maxSize = Math.max(...runs.map(r => r.size));
  // Lines set in (nearly) the largest font, top to bottom, left to right.
  const big = runs
    .filter(r => r.size >= maxSize * 0.9)
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const text = big.map(r => r.str).join(' ').replace(/\s+/g, ' ').replace(/\s+([,:;.?!])/g, '$1').trim();
  return plausibleTitle(text);
}

/**
 * Analyze a PDF (an ArrayBuffer, which pdf.js takes ownership of).
 * Resolves to:
 *   figure: { canvas, page, region } — Figure 1 rendered at 300 DPI, or null
 *   title:  a title read from the PDF when `needTitle` is set, else ''
 */
export async function analyzePdf(data, { needTitle = false } = {}) {
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  try {
    let figure = null;
    const found = await findFigure(pdf);
    if (found) {
      const page = await pdf.getPage(found.pageNumber);
      figure = { canvas: await renderRegion(page, found.region), page: found.pageNumber, region: found.region };
    }
    const title = needTitle ? await guessTitle(pdf) : '';
    return { figure, title };
  } finally {
    loadingTask.destroy();
  }
}
