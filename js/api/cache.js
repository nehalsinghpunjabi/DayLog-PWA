// DayLog 2.0 — IndexedDB cache layer.
//
// IndexedDB is a CACHE ONLY. Supabase is the source of truth. This layer exists
// for fast reads and offline viewing. All writes flow App -> Supabase -> cache;
// nothing here is authoritative and nothing here is trusted for conflict
// resolution — a cache miss simply means "ask Supabase".

const DB_NAME = "daylog-cache";
const DB_VERSION = 1;

// Object stores mirror the Supabase tables plus a blob store for image data.
const STORES = [
  "day_entries",
  "meetings",
  "photos",
  "contacts",
  "card",
  "media",   // { id, blob, mime } cached image bytes (thumbnails / backups)
  "meta",    // { id, value } small key/value (e.g. last sync time)
];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    Promise.resolve(fn(os)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const cache = {
  async put(store, value) {
    await tx(store, "readwrite", (os) => reqAsPromise(os.put(value)));
    return value;
  },

  async putMany(store, values) {
    await tx(store, "readwrite", (os) => {
      for (const v of values) os.put(v);
    });
    return values;
  },

  async get(store, id) {
    return tx(store, "readonly", (os) => reqAsPromise(os.get(id)));
  },

  async all(store) {
    return tx(store, "readonly", (os) => reqAsPromise(os.getAll())) || [];
  },

  async delete(store, id) {
    await tx(store, "readwrite", (os) => reqAsPromise(os.delete(id)));
  },

  async clear(store) {
    await tx(store, "readwrite", (os) => reqAsPromise(os.clear()));
  },

  // Replace an entire store's contents with a fresh server snapshot.
  async replace(store, values) {
    await tx(store, "readwrite", (os) => {
      os.clear();
      for (const v of values) os.put(v);
    });
    return values;
  },

  // --- media blob helpers -------------------------------------------------
  async putMedia(id, blob, mime) {
    return this.put("media", { id, blob, mime: mime || blob.type });
  },

  async getMediaURL(id) {
    const rec = await this.get("media", id);
    if (!rec || !rec.blob) return null;
    return URL.createObjectURL(rec.blob);
  },

  async setMeta(id, value) {
    return this.put("meta", { id, value });
  },

  async getMeta(id) {
    const rec = await this.get("meta", id);
    return rec ? rec.value : null;
  },
};
