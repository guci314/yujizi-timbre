/**
 * Library store: online first, catalogue fallback second.
 *
 * The fallback is the whole point of Grid 2 (B3). A downloaded book that needs
 * the network to list its chapters is not downloaded at all.
 */

import { readonly, ref, shallowRef } from 'vue'
import type { Book, BookDetail } from '../core/domain'
import { NoAudioError } from '../core/domain'
import { fetchBookDetail, fetchBookList } from '../core/source/client'
import { detailFromCatalog, mergeBookList } from '../pim/offline-grid'
import { cacheBook, loadCatalog, loadCatalogBook } from './storage-driver'

const books = shallowRef<Book[]>([])
const loading = ref(false)
const offline = ref(false)
const error = ref<string>()

/**
 * Load the shelf. Remote order wins; cached-only books are appended so a book
 * that was downloaded once stays reachable even if the site or network is gone.
 */
export async function loadBooks(force = false): Promise<void> {
  if (books.value.length > 0 && !force) return
  loading.value = true
  error.value = undefined
  try {
    const remote = await fetchBookList()
    const cached = await loadCatalog()
    books.value = mergeBookList(remote, cached)
    offline.value = false
  } catch (cause) {
    const cached = await loadCatalog().catch(() => [])
    if (cached.length > 0) {
      books.value = mergeBookList([], cached)
      offline.value = true
      error.value = undefined
    } else {
      offline.value = true
      error.value = cause instanceof Error ? cause.message : '书架加载失败'
    }
  } finally {
    loading.value = false
  }
}

export function useLibrary() {
  return {
    books: readonly(books),
    loading: readonly(loading),
    offline: readonly(offline),
    error: readonly(error),
    loadBooks,
  }
}

const detailCache = new Map<string, BookDetail>()

export function useBookDetail() {
  const detail = shallowRef<BookDetail>()
  const loading = ref(false)
  const error = ref<string>()
  /** The page is intact but carries no audio; the shelf should stay calm. */
  const noAudio = ref(false)
  /** True when the chapter list came from the local catalogue. */
  const fromCache = ref(false)

  async function load(book: Book): Promise<BookDetail | undefined> {
    const cachedInSession = detailCache.get(book.slug)
    if (cachedInSession !== undefined) {
      detail.value = cachedInSession
      noAudio.value = false
      fromCache.value = false
      return cachedInSession
    }

    loading.value = true
    error.value = undefined
    noAudio.value = false
    fromCache.value = false

    try {
      const loaded = await fetchBookDetail(book)
      detailCache.set(book.slug, loaded)
      // Cache on every successful parse, not only on download: merely visiting a
      // book must be enough to make it readable on the next flight.
      await cacheBook(loaded).catch(() => undefined)
      detail.value = loaded
      return loaded
    } catch (cause) {
      if (cause instanceof NoAudioError) {
        noAudio.value = true
        error.value = cause.message
        return undefined
      }
      const fallback = await loadCatalogBook(book.slug).catch(() => undefined)
      if (fallback !== undefined) {
        const restored = detailFromCatalog(fallback)
        detailCache.set(book.slug, restored)
        detail.value = restored
        fromCache.value = true
        return restored
      }
      error.value = cause instanceof Error ? cause.message : '章节加载失败'
      return undefined
    } finally {
      loading.value = false
    }
  }

  return {
    detail,
    loading: readonly(loading),
    error: readonly(error),
    noAudio: readonly(noAudio),
    fromCache: readonly(fromCache),
    load,
  }
}

/** Test seam. */
export function resetLibrary(): void {
  books.value = []
  detailCache.clear()
  loading.value = false
  offline.value = false
  error.value = undefined
}
