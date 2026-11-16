// Ce magasin contient uniquement les métadonnées de la file. Les objets File/Blob et les octets
// vidéo ne doivent jamais y être enregistrés.
const DB_NAME = 'vitevendre-uploads';
const DB_VERSION = 1;
const STORE = 'tasks';

function openDb() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB indisponible.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('status', 'status');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('uploadSessionId', 'uploadSessionId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Ouverture IndexedDB impossible.'));
  });
}

async function request(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      const req = action(store);
      if (req) { req.onsuccess = () => { result = req.result; }; req.onerror = () => reject(req.error); }
    } catch (error) { db.close(); reject(error); return; }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Transaction IndexedDB annulée.')); };
  });
}

function metadataOnly(value) {
  const allowed = ['id', 'uri', 'uriType', 'name', 'mimeType', 'size', 'lastModified', 'fingerprint', 'fingerprintScheme',
    'uploadSessionId', 'videoId', 'uploadedBytes', 'status', 'retryCount', 'createdAt', 'updatedAt',
    'lastError', 'permissionPersisted', 'lastVerificationAt', 'caption', 'queueOrder', 'sourceLocation'];
  const clean = {};
  for (const key of allowed) if (value[key] !== undefined) clean[key] = value[key];
  return clean;
}

export const uploadStorage = {
  async put(value) {
    const now = Date.now();
    const record = metadataOnly({ createdAt: now, ...value, updatedAt: now });
    if (!record.id) throw new Error('Identifiant de tâche manquant.');
    return request('readwrite', (store) => store.put(record));
  },
  get(id) { return request('readonly', (store) => store.get(id)); },
  all() { return request('readonly', (store) => store.getAll()); },
  remove(id) { return request('readwrite', (store) => store.delete(id)); },
};
