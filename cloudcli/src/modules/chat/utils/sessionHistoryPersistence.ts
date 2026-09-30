import type { NormalizedMessage } from '@/shared/types';

type CachedHistory = {
  cacheKey: string;
  sessionId: string;
  messages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  fetchedAt: number;
};

const DATABASE_NAME = 'cloudcli-session-history';
const STORE_NAME = 'transcripts';
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 2);
      request.onblocked = () => reject(new Error('Transcript cache upgrade blocked by another tab'));
      // Old snapshots were keyed only by session and cannot safely be reused
      // by a different signed-in account or provider.
      request.onupgradeneeded = () => {
        if (request.result.objectStoreNames.contains(STORE_NAME)) request.result.deleteObjectStore(STORE_NAME);
        request.result.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          databasePromise = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

/** Keeps fetched transcript rows available after a page reload. */
export async function readSessionHistory(cacheKey: string): Promise<CachedHistory | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME);
      const request = transaction.objectStore(STORE_NAME).get(cacheKey);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    return null;
  }
}

/** Stores provider rows and finalized live rows; stream deltas remain in memory. */
export async function writeSessionHistory(history: CachedHistory): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(history);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch (error) {
    console.warn('[SessionStore] Could not persist transcript:', error);
  }
}
