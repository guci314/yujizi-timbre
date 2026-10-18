import type { Book } from '../domain'
import { SOURCE_ORIGIN } from '../domain'

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}：${url}`)
  }
  return response.text()
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
