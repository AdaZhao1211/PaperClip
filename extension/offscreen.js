/**
 * offscreen.js — runs in the hidden offscreen document.
 *
 * The service worker fetches the PDF (it holds the activeTab permission from
 * the toolbar click), parks the bytes in Cache Storage — shared by all of the
 * extension's pages and big enough for any PDF, unlike a runtime message —
 * and asks this page to crop the first figure.
 */

import { extractFirstFigure } from './figure.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'extract-figure') return;
  (async () => {
    try {
      const cache = await caches.open(msg.cacheName);
      const resp = await cache.match(msg.cacheKey);
      if (!resp) throw new Error('PDF not found in cache');
      const figure = await extractFirstFigure(await resp.arrayBuffer());
      sendResponse({ ok: true, figure });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true; // async response
});
