import { SOURCE_ORIGIN } from '../domain'
import type { Book, BookDetail, Track } from '../domain'
import { NoAudioError, SourceParseError } from '../domain'

const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'aac', 'flac', 'ogg', 'opus']

/**
 * Resolve a site-relative path to an absolute url.
 * Chinese path segments must be encoded; already-encoded input is left intact.
 */
export function absoluteUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return encodeURI(decodeURI(path))
  }
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${SOURCE_ORIGIN}${encodeURI(decodeURI(normalized))}`
}

/**
 * Extract every book link from the site index.
 * Internal `.html` links that are not the index itself are books.
 */
export function parseBookList(html: string): Book[] {
  const seen = new Set<string>()
  const books: Book[] = []
  const linkPattern = /href="\/([^"/]+)\.html"/g

  for (const match of html.matchAll(linkPattern)) {
    const slug = decodeURIComponent(match[1])
    if (slug === 'index' || seen.has(slug)) continue
    seen.add(slug)
    books.push({ slug, title: slug, pageUrl: absoluteUrl(`/${slug}.html`) })
  }

  if (books.length === 0) {
    throw new SourceParseError('首页没有找到任何书籍链接，站点结构可能已变化')
  }
  return books
}

/**
 * Extract `const musicList = [{ name, url }, ...]` from a book page.
 * The array uses unquoted keys, so this leans on a tolerant object pattern
 * rather than JSON.parse.
 */
export function parseMusicList(html: string): Track[] {
  const declaration = html.match(/musicList\s*=\s*\[([\s\S]*?)\]/)
  if (!declaration) return []

  const objectPattern = /\{([^{}]*)\}/g
  const tracks: Track[] = []

  for (const object of declaration[1].matchAll(objectPattern)) {
    const name = readStringField(object[1], 'name')
    const url = readStringField(object[1], 'url')
    if (url === undefined) continue
    tracks.push({ name: name ?? url.split('/').pop() ?? url, url: absoluteUrl(url) })
  }
  return tracks
}

function readStringField(source: string, field: string): string | undefined {
  const pattern = new RegExp(`["']?${field}["']?\\s*:\\s*(["'])(.*?)\\1`)
  return source.match(pattern)?.[2]
}

/** Last-resort extraction: any audio link on the page, in document order. */
export function parseAudioLinks(html: string): Track[] {
  const extensionPattern = AUDIO_EXTENSIONS.join('|')
  const linkPattern = new RegExp(`(?:href|src)="([^"]+\\.(?:${extensionPattern}))"`, 'gi')
  const seen = new Set<string>()
  const tracks: Track[] = []

  for (const match of html.matchAll(linkPattern)) {
    const url = absoluteUrl(match[1])
    if (seen.has(url)) continue
    seen.add(url)
    tracks.push({ name: decodeURIComponent(match[1].split('/').pop() ?? url), url })
  }
  return tracks
}

/**
 * Whether the page loads the site's audio player.
 * A page without it is a transcript page, not a broken audio book, so the two
 * cases must not share one error.
 */
export function referencesAudioPlayer(html: string): boolean {
  return html.includes('musicplayer.js')
}

/**
 * Parse a book page, degrading through the known shapes of the site.
 * @throws NoAudioError when the page is a transcript page with no audio at all.
 * @throws SourceParseError when an audio page yields no track, meaning the shape changed.
 */
export function parseBookDetail(book: Book, html: string): BookDetail {
  const tracks = parseMusicList(html)
  if (tracks.length > 0) return { ...book, tracks }

  const fallback = parseAudioLinks(html)
  if (fallback.length > 0) return { ...book, tracks: fallback }

  if (!referencesAudioPlayer(html)) {
    throw new NoAudioError(`《${book.title}》是文字记录，没有音频内容`)
  }
  throw new SourceParseError(`《${book.title}》页面没有可播放的音轨，书源格式可能已变化`)
}
