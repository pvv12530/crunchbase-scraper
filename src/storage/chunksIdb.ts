import type { ChunkRecord } from '@shared/models';

const DB_NAME = 'crunchbaseDateBatch';
const DB_VERSION = 1;
const STORE = 'chunks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('byDate', 'dateKey', { unique: false });
      }
    };
  });
}

function recordId(r: ChunkRecord): string {
  return `${r.dateKey}::${r.chunkId}`;
}

export async function putChunk(record: ChunkRecord): Promise<void> {
  const db = await openDb();
  const id = recordId(record);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.put({ id, ...record });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

export async function getChunk(dateKey: string, chunkId: string): Promise<ChunkRecord | undefined> {
  const db = await openDb();
  const id = `${dateKey}::${chunkId}`;
  const record = await new Promise<ChunkRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const v = req.result as (ChunkRecord & { id: string }) | undefined;
      if (!v) {
        resolve(undefined);
        return;
      }
      const { id: _id, ...rest } = v;
      resolve(rest as ChunkRecord);
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return record;
}

export async function deleteChunksForDate(dateKey: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const index = store.index('byDate');
    const range = IDBKeyRange.only(dateKey);
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
}
