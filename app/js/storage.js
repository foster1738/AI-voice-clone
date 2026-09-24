// Tiny IndexedDB wrapper: recordings and AI models live on the device only.
const DB = 'voxmorph';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('takes')) db.createObjectStore('takes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('models')) db.createObjectStore('models', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const store = {
  put: (name, value) => tx(name, 'readwrite', (s) => s.put(value)),
  get: (name, id) => tx(name, 'readonly', (s) => s.get(id)),
  all: (name) => tx(name, 'readonly', (s) => s.getAll()),
  delete: (name, id) => tx(name, 'readwrite', (s) => s.delete(id)),
};

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* best effort */
  }
}
