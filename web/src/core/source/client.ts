import type { Book } from '../domain'
import { SOURCE_ORIGIN } from '../domain'

/**
 * A hanging request is worse than a failing one: without a deadline the shelf
 * spins forever and the cached catalogue is never consulted. Captive portals
 * and half-dead mobile links are common enough to budget for.
 */
const FETCH_TIMEOUT_MS = 8_000

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`请求失败 ${response.status}：${url}`)
    }
    return await response.text()
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error('网络超时，已改用本机缓存')
    }
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and parse the site index into the book list.
 * The site sends `access-control-allow-origin: *`, so no proxy is involved.
 */
export async function fetchBookList(): Promise<Book[]> {
  const { parseBookList } = await import('./yujizi')
  return parseBookList(await fetchText(`${SOURCE_ORIGIN}/index.html`))
}

/** Fetch and parse one book page into its track list. */
export async function fetchBookDetail(book: Book) {
  const { parseBookDetail } = await import('./yujizi')
  return parseBookDetail(book, await fetchText(book.pageUrl))
}
