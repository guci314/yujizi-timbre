/**
 * Audio integrity: the download gate.
 *
 * A 88 MB episode that dies at 60 MB looks exactly like a finished download to
 * the network layer. Without a check, those truncated bytes land in Cache
 * Storage, `downloads` records them as stored, and the listener gets a file
 * that plays for six minutes and stops — with no way to tell why.
 *
 * Three gates, cheapest first:
 *   1. the body is not empty;
 *   2. when the server declared a length, the body matches it;
 *   3. when the track is in the shipped manifest, size *and* SHA-256 match.
 *
 * The manifest is generated from the site's own files, so it is a real
 * fingerprint rather than a checksum of whatever the CDN happened to send.
 */

export interface AudioIntegrity {
  readonly size: number
  readonly sha256: string
}

/** Shown verbatim; the download store passes it through to the listener. */
export const INTEGRITY_FAILURE_MESSAGE = '音频校验失败（文件不完整或损坏），请重试'

export class AudioIntegrityError extends Error {
  constructor(message: string = INTEGRITY_FAILURE_MESSAGE) {
    super(message)
    this.name = 'AudioIntegrityError'
  }
}

type IntegrityTable = Record<string, AudioIntegrity>

/**
 * Loaded on first download, not with the app shell: the manifest is ~28 KB and
 * the shelf has no use for it. Vite emits it as its own chunk.
 */
let tablePromise: Promise<IntegrityTable> | undefined

function files(): Promise<IntegrityTable> {
  tablePromise ??= import('./track-integrity.json').then(
    (module) => (module.default as { files: IntegrityTable }).files,
  )
  return tablePromise
}

/** `/玉机子/玉机子讲道德经/28416280.m4a` for any absolute or relative form of that url. */
export async function integrityKeyFor(url: string): Promise<string | undefined> {
  let pathname: string
  try {
    pathname = new URL(url, 'https://www.yujizi.org').pathname
  } catch {
    return undefined
  }

  const table = await files()
  let candidate = pathname
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const normalized = candidate.startsWith('/') ? candidate : `/${candidate}`
    if (Object.prototype.hasOwnProperty.call(table, normalized)) return normalized
    let decoded: string
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      return undefined
    }
    if (decoded === candidate) return undefined
    candidate = decoded
  }
  return undefined
}

export async function expectedIntegrityFor(url: string): Promise<AudioIntegrity | undefined> {
  const key = await integrityKeyFor(url)
  return key === undefined ? undefined : (await files())[key]
}

/** Number of tracks covered by the shipped manifest; asserted in tests. */
export async function integrityEntryCount(): Promise<number> {
  return Object.keys(await files()).length
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    // Failing closed is deliberate: silently skipping the hash would let exactly
    // the corruption this module exists to stop through.
    throw new AudioIntegrityError('当前环境无法校验音频完整性，请用 HTTPS 打开后再下载')
  }
  const digest = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Verify one fully-read body. `expected` is explicit so the rules can be tested
 * without a 88 MB fixture; production callers use {@link assertPayloadIntact}.
 */
export async function verifyBytes(input: {
  bytes: Uint8Array
  declaredLength: number
  expected?: AudioIntegrity
}): Promise<{ sha256: string }> {
  const { bytes, declaredLength, expected } = input

  if (bytes.length === 0) throw new AudioIntegrityError()

  if (declaredLength > 0 && bytes.length !== declaredLength) {
    throw new AudioIntegrityError()
  }

  if (expected !== undefined && bytes.length !== expected.size) throw new AudioIntegrityError()

  const digest = await sha256Hex(bytes)
  if (expected !== undefined && digest !== expected.sha256.toLowerCase()) throw new AudioIntegrityError()
  return { sha256: digest }
}

/** Look the url up in the shipped manifest, then verify the body. */
export async function assertPayloadIntact(
  url: string,
  bytes: Uint8Array,
  declaredLength: number,
): Promise<{ sha256: string }> {
  return verifyBytes({ bytes, declaredLength, expected: await expectedIntegrityFor(url) })
}
