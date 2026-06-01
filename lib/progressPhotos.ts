'use client';

/**
 * lib/progressPhotos.ts
 *
 * Device-local progress-photo store, keyed by date (YYYY-MM-DD). Body photos are
 * sensitive, so they live in IndexedDB on THIS device only — never uploaded,
 * never synced. IndexedDB (not localStorage) because images are binary-ish and
 * would blow localStorage's ~5 MB quota that the workout DB also shares.
 *
 * Photos are resized + JPEG-compressed before storing (≈720px, ~q0.7) so a
 * year of weekly shots stays small. One photo per day (re-saving overwrites).
 */

const DB_NAME  = 'queProgress';
const STORE    = 'photos';
const DB_VER   = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); // key = date string
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(db => new Promise<T>((resolve, reject) => {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }));
}

/** Resize + compress an image File to a storable JPEG data URL (longest edge ≤ max). */
export function compressProgressPhoto(file: File, max = 720, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('no-canvas')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad-image')); };
    img.src = url;
  });
}

export async function savePhoto(date: string, dataUrl: string): Promise<void> {
  await tx('readwrite', store => store.put(dataUrl, date));
}

export async function getPhoto(date: string): Promise<string | null> {
  try { return (await tx<string | undefined>('readonly', store => store.get(date))) ?? null; }
  catch { return null; }
}

export async function deletePhoto(date: string): Promise<void> {
  await tx('readwrite', store => store.delete(date));
}

/** All dates that have a photo, newest first. */
export async function listPhotoDates(): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', store => store.getAllKeys());
    return (keys as string[]).sort().reverse();
  } catch { return []; }
}
