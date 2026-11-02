/**
 * 书架外壳：远端目录优先，本机书箧兜底。
 *
 * 纯业务层只认识「卷与篇」；地址、页面、网络协议都在这里被消化掉。
 */

import { readonly, ref, shallowRef } from 'vue'
import type { Book, BookCatalogEntry, BookDetail } from '../core/domain'
import { NoAudioError } from '../core/domain'
import { fetchBookDetail, fetchBookList } from '../core/source/client'
import { mergeShelf } from '../pim/shelf'
import type { BookSpec } from '../pim/listening-model'
import { registerTracks } from './media-index'
import { cacheBook, loadCatalog, loadCatalogBook } from './storage-driver'

const books = shallowRef<Book[]>([])
const specs = shallowRef<BookSpec[]>([])
const cachedSpecs = shallowRef<BookSpec[]>([])
const loading = ref(false)
const offline = ref(false)
const error = ref<string>()

/** 一卷的纯业务规格；篇章时长留待诵读时获知。 */
export function bookSpecFrom(book: BookDetail): BookSpec {
  return {
    id: book.slug,
    title: book.title,
    chapters: book.tracks.map((track, index) => ({
      index,
      title: track.name,
      durationSec: 0,
    })),
  }
}

function specFromCatalog(entry: BookCatalogEntry): BookSpec {
  return {
    id: entry.slug,
    title: entry.title,
    chapters: entry.tracks.map((track, index) => ({
      index,
      title: track.name,
      durationSec: 0,
    })),
  }
}

export async function loadBooks(force = false): Promise<void> {
  if (specs.value.length > 0 && !force) return
  loading.value = true
  error.value = undefined
  try {
    const remote = await fetchBookList()
    books.value = remote
    const entries = await loadCatalog().catch(() => [])
    cachedSpecs.value = entries.map(specFromCatalog)
    for (const entry of entries) registerTracks(entry.slug, entry.tracks)
    specs.value = mergeShelf(
      remote.map((book) => ({ id: book.slug, title: book.title, chapters: [] })),
      cachedSpecs.value,
    )
    offline.value = false
  } catch (cause) {
    const entries = await loadCatalog().catch(() => [])
    cachedSpecs.value = entries.map(specFromCatalog)
    for (const entry of entries) registerTracks(entry.slug, entry.tracks)
    if (cachedSpecs.value.length > 0) {
      specs.value = mergeShelf([], cachedSpecs.value)
      offline.value = true
      error.value = undefined
    } else {
      specs.value = []
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
    specs: readonly(specs),
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
  const noAudio = ref(false)
  const fromCache = ref(false)

  async function load(book: Book): Promise<BookDetail | undefined> {
    return loadBy(book.slug, () => fetchBookDetail(book))
  }

  /** 远端列表里没有这本书时（离线只剩书箧），直接从本机目录取。 */
  async function loadFromCatalog(slug: string): Promise<BookDetail | undefined> {
    const cached = await loadCatalogBook(slug)
    if (cached === undefined) {
      error.value = '本机书箧里没有这一卷'
      return undefined
    }
    registerTracks(cached.slug, cached.tracks)
    const restored: BookDetail = {
      slug: cached.slug,
      title: cached.title,
      pageUrl: cached.pageUrl,
      tracks: cached.tracks,
    }
    detailCache.set(slug, restored)
    detail.value = restored
    fromCache.value = true
    return restored
  }

  async function loadBy(slug: string, fetchDetail: () => Promise<BookDetail>): Promise<BookDetail | undefined> {
    const inSession = detailCache.get(slug)
    if (inSession !== undefined) {
      detail.value = inSession
      noAudio.value = false
      fromCache.value = false
      registerTracks(inSession.slug, inSession.tracks)
      return inSession
    }

    loading.value = true
    error.value = undefined
    noAudio.value = false
    fromCache.value = false

    try {
      const loaded = await fetchDetail()
      detailCache.set(loaded.slug, loaded)
      registerTracks(loaded.slug, loaded.tracks)
      // 只访问过一次也算数：下次飞行模式仍能打开这一卷的目录。
      await cacheBook(loaded).catch(() => undefined)
      detail.value = loaded
      return loaded
    } catch (cause) {
      if (cause instanceof NoAudioError) {
        noAudio.value = true
        error.value = cause.message
        return undefined
      }
      return loadFromCatalog(slug)
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
    loadFromCatalog,
  }
}

/** 测试用。 */
export function resetLibrary(): void {
  books.value = []
  specs.value = []
  cachedSpecs.value = []
  detailCache.clear()
  loading.value = false
  offline.value = false
  error.value = undefined
}
