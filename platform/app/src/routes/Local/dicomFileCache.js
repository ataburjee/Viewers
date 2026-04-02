const DB_NAME = 'ohif-local-dicom-cache';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cacheDicomFiles(files) {
  // Read all buffers BEFORE opening the transaction.
  // IndexedDB transactions auto-commit when the event loop yields (await),
  // so all async work must happen outside the transaction.
  const entries = await Promise.all(
    files.map(async file => ({
      name: file.name,
      buffer: await file.arrayBuffer(),
    }))
  );

  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  store.clear();
  for (const entry of entries) {
    store.put({ name: entry.name, buffer: entry.buffer });
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getCachedDicomFiles() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      db.close();
      const entries = request.result || [];
      const files = entries.map(
        entry => new File([entry.buffer], entry.name, { type: 'application/dicom' })
      );
      resolve(files);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

export async function clearDicomCache() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
