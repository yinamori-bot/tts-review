// Everything stays in this browser (IndexedDB). Nothing is sent anywhere.
// Stores: chapters (meta + units), audio (the chapter's m4a as a Blob),
//         issues (what the listener pointed out), alts (candidate takes from the Mac).
const NAME = 'tts-review', VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('chapters', { keyPath: 'id' });
      db.createObjectStore('audio', { keyPath: 'id' });
      db.createObjectStore('issues', { keyPath: 'id' }).createIndex('chapter', 'chapter');
      db.createObjectStore('alts', { keyPath: 'id' }).createIndex('issue', 'issue');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export async function get(name, key) { return req((await store(name)).get(key)); }
export async function all(name) { return req((await store(name)).getAll()); }
export async function put(name, val) { return req((await store(name, 'readwrite')).put(val)); }
export async function del(name, key) { return req((await store(name, 'readwrite')).delete(key)); }
export async function byIndex(name, index, key) { return req((await store(name)).index(index).getAll(key)); }

export async function persist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

// Small settings and play positions live in localStorage.
const P = 'ttsr:';
export function load(k, def) { try { const v = localStorage.getItem(P + k); return v == null ? def : JSON.parse(v); } catch { return def; } }
export function save(k, v) { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch {} }
