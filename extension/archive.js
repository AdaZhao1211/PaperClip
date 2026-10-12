/**
 * archive.js — .zip export and import for the library.
 *
 * ES module, loaded on demand by the new-tab page (app.js).
 *
 * Writing streams through fflate (vendor/fflate): PDFs and images are stored
 * as-is (already compressed), the JSON is deflated. Output goes to a writable
 * sink chunk by chunk, so a library of large PDFs never sits in memory.
 *
 * Reading uses the zip's central directory and File.slice(), so each entry is
 * a lazy slice of the file — stored entries are never copied, deflated ones
 * are inflated with the browser's DecompressionStream. Works for zips made
 * by other tools too (no ZIP64, i.e. archives under 4 GB).
 */

import { Zip, ZipPassThrough, ZipDeflate } from './vendor/fflate/fflate.mjs';

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * Write `entries` ([{ name, blob }]) as a zip into `sink`, an object with
 * async write(Uint8Array) and close() — e.g. a FileSystemWritableFileStream.
 */
export async function writeZip(entries, sink) {
  let writing = Promise.resolve();
  let failure = null;
  const zip = new Zip((err, chunk) => {
    if (err) { failure = err; return; }
    // Copy: fflate may reuse its buffers after the callback returns.
    const copy = chunk.slice();
    writing = writing.then(() => sink.write(copy));
  });

  for (const { name, blob } of entries) {
    const compress = /\.(json|txt|csv|md)$/i.test(name);
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(file);
    const reader = blob.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      file.push(value, false);
      await writing; // backpressure: don't read ahead of the sink
    }
    file.push(new Uint8Array(0), true);
  }
  zip.end();
  await writing;
  if (failure) throw failure;
  await sink.close();
}

/** A sink that collects the zip in memory, for when no file picker is available. */
export function memorySink() {
  const parts = [];
  return {
    async write(chunk) { parts.push(chunk); },
    async close() {},
    blob: () => new Blob(parts, { type: 'application/zip' }),
  };
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

async function bytesAt(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}

/**
 * List the files in a zip (a File or Blob).
 * Resolves to [{ name, blob }] where each blob is read lazily.
 */
export async function readZip(file) {
  // End of central directory: in the last 22 bytes + up to 64 KB of comment.
  const tailLen = Math.min(file.size, 22 + 65535);
  const tail = await bytesAt(file, file.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = tail.getUint16(eocd + 10, true);
  const cdirSize = tail.getUint32(eocd + 12, true);
  const cdirOffset = tail.getUint32(eocd + 16, true);

  const cdir = await bytesAt(file, cdirOffset, cdirSize);
  const decoder = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cdir.getUint32(p, true) !== CDIR_SIG) throw new Error('Corrupt zip directory');
    const method = cdir.getUint16(p + 10, true);
    const compSize = cdir.getUint32(p + 20, true);
    const nameLen = cdir.getUint16(p + 28, true);
    const extraLen = cdir.getUint16(p + 30, true);
    const commentLen = cdir.getUint16(p + 32, true);
    const localOffset = cdir.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(cdir.buffer, cdir.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry

    // The data starts after the local header, whose name/extra lengths can
    // differ from the central directory's.
    const local = await bytesAt(file, localOffset, 30);
    if (local.getUint32(0, true) !== LOCAL_SIG) throw new Error(`Corrupt zip entry: ${name}`);
    const dataStart = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    const raw = file.slice(dataStart, dataStart + compSize);

    let blob;
    if (method === 0) {
      blob = raw;
    } else if (method === 8) {
      blob = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    } else {
      throw new Error(`Unsupported compression in zip entry: ${name}`);
    }
    entries.push({ name, blob });
  }
  return entries;
}
