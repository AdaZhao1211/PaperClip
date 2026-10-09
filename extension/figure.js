/**
 * figure.js — find and crop the first figure in a PDF.
 *
 * Loaded as an ES module by offscreen.js (and nothing else). Pure logic over
 * pdf.js: no chrome.* APIs, so it can be tested in a plain page.
 *
 * Strategy: walk the drawing operators of the first few pages, tracking the
 * current transform, and note where each embedded raster image is painted.
 * Images that touch or nearly touch are grouped (a teaser is often a grid
 * of small pictures), and the first group big enough to be a figure — not a
 * logo or icon — wins. That region of the page is then
 * rendered and cropped, so the result looks exactly as it does in the PDF.
 *
 * Figures drawn purely as vector graphics contain no raster image and are
 * not detected.
 */

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

const { OPS } = pdfjsLib;

const MAX_PAGES = 5;
// Minimum painted size (PDF points; a letter page is 612 × 792) for a group
// of images to count as a figure rather than a logo, icon or rule.
const MIN_FIGURE_W = 90;
const MIN_FIGURE_H = 60;
const MAX_ASPECT = 6;
// Images within this distance (points) of each other form one group;
// images smaller than MIN_TILE are ignored entirely.
const MERGE_GAP = 14;
const MIN_TILE = 20;
// Output thumbnail
const OUT_MAX_W = 560;
const OUT_QUALITY = 0.82;

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

// pdf.js paints an image into the unit square of the current transform.
function unitSquareBox(M) {
  const pts = [apply(M, 0, 0), apply(M, 1, 0), apply(M, 0, 1), apply(M, 1, 1)];
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

const boxW = b => b.x2 - b.x1;
const boxH = b => b.y2 - b.y1;

/** Boxes (PDF user space) of every raster image painted on the page. */
async function imageBoxes(page) {
  const ops = await page.getOperatorList();
  const boxes = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.transform:
        ctm = mul(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.beginGroup:
        stack.push(ctm);
        if (args[0] && Array.isArray(args[0].matrix)) ctm = mul(ctm, args[0].matrix);
        break;
      case OPS.endGroup:
        if (stack.length) ctm = stack.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        boxes.push(unitSquareBox(ctm));
        break;
    }
  }
  return boxes;
}

function isFigureSized(b) {
  const w = boxW(b), h = boxH(b);
  if (w < MIN_FIGURE_W || h < MIN_FIGURE_H) return false;
  const aspect = w / h;
  return aspect <= MAX_ASPECT && aspect >= 1 / MAX_ASPECT;
}

function near(a, b) {
  return a.x1 - MERGE_GAP <= b.x2 && b.x1 - MERGE_GAP <= a.x2 &&
         a.y1 - MERGE_GAP <= b.y2 && b.y1 - MERGE_GAP <= a.y2;
}

/**
 * Group image boxes that touch or nearly touch (a teaser is often a grid of
 * small pictures) and return the first group, in paint order, that is big
 * enough to be a figure.
 */
function figureRegion(boxes, pageBox) {
  const tiles = boxes
    .map(b => ({
      x1: Math.max(b.x1, pageBox.x1), y1: Math.max(b.y1, pageBox.y1),
      x2: Math.min(b.x2, pageBox.x2), y2: Math.min(b.y2, pageBox.y2),
    }))
    .filter(b => boxW(b) >= MIN_TILE && boxH(b) >= MIN_TILE);

  const used = new Set();
  for (let i = 0; i < tiles.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let region = { ...tiles[i] };
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < tiles.length; j++) {
        if (used.has(j) || !near(region, tiles[j])) continue;
        const t = tiles[j];
        used.add(j);
        region = {
          x1: Math.min(region.x1, t.x1), y1: Math.min(region.y1, t.y1),
          x2: Math.max(region.x2, t.x2), y2: Math.max(region.y2, t.y2),
        };
        grew = true;
      }
    }
    if (isFigureSized(region)) return region;
  }
  return null;
}

/** Render just `region` (PDF user space) of the page and return a JPEG data URL. */
async function cropRegion(page, region) {
  const scale = Math.min(3, Math.max(1, OUT_MAX_W / boxW(region)));
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

  let out = canvas;
  if (width > OUT_MAX_W) {
    out = document.createElement('canvas');
    out.width = OUT_MAX_W;
    out.height = Math.round(height * OUT_MAX_W / width);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  }
  return { dataUrl: out.toDataURL('image/jpeg', OUT_QUALITY), width: out.width, height: out.height };
}

/**
 * Find and crop the first figure in a PDF.
 * Resolves to { dataUrl, width, height, page } or null when no raster figure
 * is found in the first MAX_PAGES pages.
 */
export async function extractFirstFigure(data) {
  const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
  const pdf = await loadingTask.promise;
  try {
    const pages = Math.min(pdf.numPages, MAX_PAGES);
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n);
      const [x1, y1, x2, y2] = page.view;
      const region = figureRegion(await imageBoxes(page), { x1, y1, x2, y2 });
      if (region) return { ...(await cropRegion(page, region)), page: n };
    }
    return null;
  } finally {
    loadingTask.destroy();
  }
}
