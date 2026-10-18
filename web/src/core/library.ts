import { readonly, ref, shallowRef } from 'vue'
import type { Book, BookDetail } from './domain'
import { NoAudioError } from './domain'
import { fetchBookDetail, fetchBookList } from './source/client'

const books = shallowRef<Book[]>([])
const loading = ref(false)
const error = ref<string>()

/**
 * Load the book list once and keep it for the session.
 * Errors surface in `error` rather than throwing, so the shelf can render a message.
 */
export function useLibrary() {
  async function loadBooks(force = false): Promise<void> {
    if (books.value.length > 0 && !force) return
    loading.value = true
    error.value = undefined
    try {
      books.value = await fetchBookList()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '书架加载失败'
    } finally {
      loading.value = false
    }
  }

  return { books: readonly(books), loading: readonly(loading), error: readonly(error), loadBooks }
}

const detailCache = new Map<string, BookDetail>()

/** Load one book's track list, caching it for the session. */
export function useBookDetail() {
  const detail = shallowRef<BookDetail>()
  const loading = ref(false)
  const error = ref<string>()
  /** True when the page is intact but carries no audio, so the UI stays calm. */
  const noAudio = ref(false)

  async function load(book: Book): Promise<BookDetail | undefined> {
    const cached = detailCache.get(book.slug)
    if (cached !== undefined) {
      detail.value = cached
      noAudio.value = false
      return cached
    }
    loading.value = true
    error.value = undefined
    noAudio.value = false
    try {
      const loaded = await fetchBookDetail(book)
      detailCache.set(book.slug, loaded)
      detail.value = loaded
      return loaded
    } catch (cause) {
      noAudio.value = cause instanceof NoAudioError
      error.value = cause instanceof Error ? cause.message : '章节加载失败'
      return undefined
    } finally {
      loading.value = false
    }
  }

  return { detail, loading: readonly(loading), error: readonly(error), noAudio: readonly(noAudio), load }
}

/** Drop cached book details; used by tests. */
export function clearDetailCache(): void {
  detailCache.clear()
}
