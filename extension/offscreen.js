/**
 * offscreen.js — runs in the hidden offscreen document.
 *
 * The service worker fetches the PDF of a manually saved paper (it holds the
 * activeTab permission from the toolbar click), parks the bytes in Cache
 * Storage — shared by all of the extension's pages and big enough for any
 * PDF, unlike a runtime message — and asks this page to:
 *   1. find and crop Figure 1 at 300 DPI (figure.js),
 *   2. compose a PNG of the paper's full title above that figure,
 *   3. save the PDF and the PNG into the user's library folder
 *      (library-folder.js), or park them until the folder is accessible,
 *   4. keep the same PNG for the library page, plus a small thumbnail of it
 *      for the table.
 * So what the library shows is exactly the image saved in the folder.
 */

import { analyzePdf } from './figure.js';
import { writableFolder, getFolder, savePaperFiles, stashPending, putFigureImage } from './library-folder.js';

const MIN_IMAGE_W = 900;
const THUMB_W = 560;
const THUMB_QUALITY = 0.85;

/** Wrap `text` into lines no wider than `maxWidth` in the context's font. */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The full title in a white header above the figure, on a canvas: bold
 * sans-serif, centered, like a paper's teaser slide.
 */
async function composeTitledFigure(title, figureCanvas) {
  const width = Math.max(MIN_IMAGE_W, figureCanvas.width);
  const fontSize = Math.round(Math.min(56, Math.max(28, width * 0.028)));
  const lineHeight = Math.round(fontSize * 1.4);
  const sidePad = Math.round(width * 0.05);
  const topPad = Math.round(fontSize * 1.1);
  const gapBelowTitle = Math.round(fontSize * 1.5);
  const bottomPad = Math.round(fontSize * 0.6);
  const font = `700 ${fontSize}px 'Helvetica Neue', Helvetica, Arial, sans-serif`;

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const lines = wrapLines(measure, title, width - sidePad * 2);

  const titleBlock = topPad + lines.length * lineHeight + gapBelowTitle;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = titleBlock + figureCanvas.height + bottomPad;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#1f2430';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, width / 2, topPad + i * lineHeight));

  // Figure centered below the title.
  ctx.drawImage(figureCanvas, Math.round((width - figureCanvas.width) / 2), titleBlock);

  return canvas;
}

/** Scaled-down JPEG of the composed image, for the library table. */
function thumbnailDataUrl(canvas) {
  const scale = Math.min(1, THUMB_W / canvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', THUMB_QUALITY);
}

async function processPaper(msg) {
  const cache = await caches.open(msg.cacheName);
  const resp = await cache.match(msg.cacheKey);
  if (!resp) throw new Error('PDF not found in cache');
  const pdf = await resp.blob();

  // pdf.js takes ownership of the buffer it's given, so hand it a copy.
  const analysis = await analyzePdf(await pdf.arrayBuffer(), { needTitle: !msg.title });
  const title = msg.title || analysis.title || msg.fallbackTitle || 'Untitled paper';
  let image = null;
  let thumb = null;
  if (analysis.figure) {
    const composed = await composeTitledFigure(title, analysis.figure.canvas);
    image = await new Promise(resolve => composed.toBlob(resolve, 'image/png'));
    thumb = thumbnailDataUrl(composed);
    await putFigureImage(msg.paperId, image);
  }

  const out = {
    figure: analysis.figure ? { dataUrl: thumb, page: analysis.figure.page } : null,
    title: msg.title ? '' : analysis.title,
    files: null,
    filesStatus: null,
    filesNote: null,
  };

  try {
    const dir = await writableFolder();
    if (dir) {
      out.files = await savePaperFiles(dir, { title, files: msg.files }, { pdf, image });
      out.filesStatus = 'saved';
    } else if (await getFolder()) {
      // Folder chosen but Chrome wants the user to allow access again.
      await stashPending(msg.paperId, { pdf, image });
      out.filesStatus = 'pending';
      out.filesNote = 'Waiting for folder access — reconnect the folder in Settings';
    } else {
      out.filesStatus = 'no-folder';
      out.filesNote = 'Choose a library folder in Settings to save the PDF and image';
    }
  } catch (err) {
    out.filesStatus = 'failed';
    out.filesNote = `Couldn't save files: ${(err && err.message) || err}`;
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'process-paper') return;
  processPaper(msg).then(
    result => sendResponse({ ok: true, ...result }),
    err => sendResponse({ ok: false, error: String((err && err.message) || err) }),
  );
  return true; // async response
});
