/** Origin of the source site. The bare domain does not resolve, so `www.` is required. */
export const SOURCE_ORIGIN = 'https://www.yujizi.org'

/** One book as listed on the site index. */
export interface Book {
  /** Page file name without `.html`, e.g. `道德经`. Stable identity across sessions. */
  slug: string
  title: string
  pageUrl: string
}

/** One playable track inside a book. */
export interface Track {
  name: string
  /** Absolute, encoded url. */
  url: string
}

/** A book together with its parsed track list. */
export interface BookDetail extends Book {
  tracks: Track[]
}

/** Where the listener stopped, persisted per book. */
export interface Progress {
  bookSlug: string
  trackIndex: number
  currentTime: number
  updatedAt: number
}

/** A saved position with a note. Titles are denormalised so the list renders without refetching books. */
export interface Bookmark {
  id: string
  bookSlug: string
  bookTitle: string
  trackIndex: number
  trackName: string
  currentTime: number
  note: string
  createdAt: number
}

/** Raised when the source page cannot be understood. Never swallowed silently. */
export class SourceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceParseError'
  }
}

/**
 * Raised for a page that carries no audio at all, such as a transcript page.
 * Distinct from {@link SourceParseError}: the page is intact, it is simply
 * not an audio book, so the UI must not report a source-format change.
 */
export class NoAudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoAudioError'
  }
}

/**
 * One track kept on this device.
 * The bytes live in Cache Storage; this record is the index over them, so the
 * UI can list and total downloads without opening the cache.
 */
export interface DownloadedTrack {
  /** Absolute track url, which is also the cache key. */
  url: string
  bookSlug: string
  bookTitle: string
  trackIndex: number
  trackName: string
  /** Bytes stored, or 0 when the server sent no length. */
  sizeBytes: number
  downloadedAt: number
}

/** Raised when the device has no room left for a download. */
export class StorageFullError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageFullError'
  }
}
