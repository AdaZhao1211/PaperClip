/**
 * library-folder.js — the local folder where saved papers' files go.
 *
 * ES module, used by the offscreen document (saving files right after a
 * manual save) and the new-tab page (settings, export, import).
 *
 * Extensions can't write to an arbitrary path, so the folder is chosen with
 * the File System Access API (showDirectoryPicker) and its handle is kept in
 * IndexedDB. Chrome may ask the user to allow access again after a restart;
 * until then, files are parked in Cache Storage ("pending") and written once
 * access is granted (flushPending).
 *
 * Each saved paper gets two files named after its short title:
 *   <Short Title>.pdf  — the paper
 *   <Short Title>.png  — the full title above the paper's Figure 1
 * The same PNG is kept in IndexedDB so the library page can show it even
 * when the folder isn't accessible (putFigureImage / getFigureImage).
 * paper.files = { pdf, image } records the names (image may be null).
 */

const DB_NAME = 'paperclip';
const DB_STORE = 'handles';
const IMAGE_STORE = 'images';
const FOLDER_KEY = 'libraryFolder';

export const PENDING_CACHE = 'paperclip-pending';
const RW = { mode: 'readwrite' };

// ─── Folder handle ────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRequest(mode, fn, store = DB_STORE) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getFolder() {
  return (await dbRequest('readonly', s => s.get(FOLDER_KEY))) || null;
}

// ─── Title + figure image, as shown in the library ───────────────────────────

export function putFigureImage(paperId, blob) {
  return dbRequest('readwrite', s => s.put(blob, paperId), IMAGE_STORE);
}

export async function getFigureImage(paperId) {
  return (await dbRequest('readonly', s => s.get(paperId), IMAGE_STORE)) || null;
}

export function deleteFigureImage(paperId) {
  return dbRequest('readwrite', s => s.delete(paperId), IMAGE_STORE);
}

/** Let the user pick the folder. Needs a user gesture (call from a click). */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({ id: 'paperclip-library', mode: 'readwrite', startIn: 'documents' });
  await dbRequest('readwrite', s => s.put(handle, FOLDER_KEY));
  return handle;
}

/**
 * 'none' (no folder chosen) | 'granted' | 'prompt' | 'denied'.
 * With `request`, asks the user for access if needed — only works from a
 * user gesture.
 */
export async function folderAccess(handle, { request = false } = {}) {
  if (!handle) return 'none';
  let state = await handle.queryPermission(RW);
  if (state !== 'granted' && request) state = await handle.requestPermission(RW);
  return state;
}

/** The folder handle if it's chosen and writable right now, else null. */
export async function writableFolder() {
  const handle = await getFolder();
  return (await folderAccess(handle)) === 'granted' ? handle : null;
}

// ─── Files ────────────────────────────────────────────────────────────────────

export async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function readFile(dir, name) {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}

export async function writeFile(dir, name, blob) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await blob.stream().pipeTo(writable); // closes the writable
  } catch (err) {
    try { await writable.abort(); } catch {}
    throw err;
  }
}

const SHORT_TITLE_MAX = 40;
const TRAILING_FILLER = /^(a|an|the|of|for|with|in|on|to|and|or|via|from|by|at|as|using|towards?)$/i;

/**
 * A short, human name for a paper: the part before a colon when there is
 * one ("LoRA: Low-Rank Adaptation of …" → "LoRA"), else the leading words up
 * to about 40 characters, without a dangling "with"/"of"/…
 * ("High-Resolution Image Synthesis with Latent Diffusion Models" →
 * "High-Resolution Image Synthesis").
 */
export function shortTitle(title) {
  const t = (title || '').replace(/\s+/g, ' ').trim();
  const colon = t.indexOf(':');
  if (colon >= 2 && colon <= 60) return t.slice(0, colon).trim();
  if (t.length <= SHORT_TITLE_MAX) return t;
  const words = [];
  for (const w of t.split(' ')) {
    if (words.length && [...words, w].join(' ').length > SHORT_TITLE_MAX) break;
    words.push(w);
  }
  while (words.length > 1 && TRAILING_FILLER.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Make a string safe as a file name on macOS, Windows and Linux. */
export function safeFileBase(s) {
  return (s || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
}

/**
 * Base name (without extension) for a paper's files. Re-saving a paper keeps
 * its existing names; otherwise a name not used by any other file is picked:
 * "Title", "Title (2)", …
 */
async function chooseBaseName(dir, title, existing) {
  const current = existing && (existing.pdf || existing.image);
  if (current) return current.replace(/\.[^.]+$/, '');
  const base = safeFileBase(shortTitle(title)) || 'Untitled paper';
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const taken = await Promise.all(['pdf', 'png', 'jpg'].map(ext => fileExists(dir, `${name}.${ext}`)));
    if (!taken.some(Boolean)) return name;
  }
}

/** Write a paper's PDF and title+figure image. Returns the new paper.files. */
export async function savePaperFiles(dir, { title, files: existing }, { pdf, image }) {
  const base = await chooseBaseName(dir, title, existing);
  const files = { pdf: null, image: null };
  if (pdf) {
    files.pdf = `${base}.pdf`;
    await writeFile(dir, files.pdf, pdf);
  }
  if (image) {
    files.image = `${base}.png`;
    await writeFile(dir, files.image, image);
  }
  // Redoing a paper saved before images were PNG leaves its old image
  // (e.g. "Name.jpg") behind; remove that file, which belongs to this paper.
  if (files.image && existing && existing.image && existing.image !== files.image) {
    try { await dir.removeEntry(existing.image); } catch {}
  }
  return files;
}

// ─── Pending files (folder not accessible yet) ───────────────────────────────

const pendingKey = (paperId, kind) =>
  `https://paperclip.invalid/pending/${encodeURIComponent(paperId)}/${kind}`;

export async function stashPending(paperId, { pdf, image }) {
  const cache = await caches.open(PENDING_CACHE);
  if (pdf) await cache.put(pendingKey(paperId, 'pdf'), new Response(pdf));
  if (image) await cache.put(pendingKey(paperId, 'image'), new Response(image));
}

/**
 * Write the parked files of every paper whose filesStatus is 'pending'.
 * Returns { [paperId]: files } for the papers written.
 */
export async function flushPending(dir, papers) {
  const cache = await caches.open(PENDING_CACHE);
  const written = {};
  for (const p of papers) {
    if (p.filesStatus !== 'pending') continue;
    const get = async kind => {
      const resp = await cache.match(pendingKey(p.id, kind));
      return resp ? resp.blob() : null;
    };
    const pdf = await get('pdf');
    const image = await get('image');
    if (!pdf && !image) continue;
    written[p.id] = await savePaperFiles(dir, p, { pdf, image });
    await cache.delete(pendingKey(p.id, 'pdf'));
    await cache.delete(pendingKey(p.id, 'image'));
  }
  return written;
}
