import type { Bookmark, Progress } from '../domain'

const DB_NAME = 'timbre-web'
const DB_VERSION = 1
const PROGRESS_STORE = 'progress'
const BOOKMARK_STORE = 'bookmarks'

let dbPromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: 'bookSlug' })
      }
      if (!db.objectStoreNames.contains(BOOKMARK_STORE)) {
        const store = db.createObjectStore(BOOKMARK_STORE, { keyPath: 'id' })
        store.createIndex('bookSlug', 'bookSlug', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'))
  })
  return dbPromise
}

/** Run one request against one object store and settle on its result. */
function against<T>(name: string, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = db.transaction(name, mode).objectStore(name)
        const outcome = body(request)
        outcome.onsuccess = () => resolve(outcome.result)
        outcome.onerror = () => reject(outcome.error ?? new Error(`${name} 读写失败`))
      }),
  )
}

/** Read where a book stopped, or undefined when it was never played. */
export function loadProgress(bookSlug: string): Promise<Progress | undefined> {
  return against(PROGRESS_STORE, 'readonly', (store) => store.get(bookSlug))
}

/** Persist where a book stopped. Called on a throttle, not every second. */
export async function saveProgress(progress: Progress): Promise<Progress> {
  await against(PROGRESS_STORE, 'readwrite', (store) => store.put(progress))
  return progress
}

/** Every stored progress entry, most recent first. */
export async function loadAllProgress(): Promise<Progress[]> {
  const entries = await against<Progress[]>(PROGRESS_STORE, 'readonly', (store) => store.getAll())
  return entries.sort((left, right) => right.updatedAt - left.updatedAt)
}

/** Bookmarks of one book, oldest first. */
export async function loadBookmarks(bookSlug: string): Promise<Bookmark[]> {
  const db = await openDatabase()
  const entries = await new Promise<Bookmark[]>((resolve, reject) => {
    const index = db.transaction(BOOKMARK_STORE, 'readonly').objectStore(BOOKMARK_STORE).index('bookSlug')
    const request = index.getAll(bookSlug)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取书签失败'))
  })
  return entries.sort((left, right) => left.createdAt - right.createdAt)
}

/** Bookmarks of every book, keyed by book slug, newest first within each book. */
export async function loadAllBookmarks(): Promise<Record<string, Bookmark[]>> {
  const all = await against<Bookmark[]>(BOOKMARK_STORE, 'readonly', (store) => store.getAll())
  const grouped: Record<string, Bookmark[]> = {}
  for (const bookmark of all.sort((left, right) => right.createdAt - left.createdAt)) {
    ;(grouped[bookmark.bookSlug] ??= []).push(bookmark)
  }
  return grouped
}

export async function saveBookmark(bookmark: Bookmark): Promise<Bookmark> {
  await against(BOOKMARK_STORE, 'readwrite', (store) => store.put(bookmark))
  return bookmark
}

export function deleteBookmark(id: string): Promise<undefined> {
  return against(BOOKMARK_STORE, 'readwrite', (store) => store.delete(id))
}

/**
 * Close the cached connection and drop the database.
 * Only for tests: production code keeps one connection for the app's lifetime.
 */
export async function deleteDatabase(): Promise<void> {
  const pending = dbPromise
  dbPromise = undefined
  if (pending !== undefined) {
    const db = await pending.catch(() => undefined)
    db?.close()
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}
