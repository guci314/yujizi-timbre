import { describe, expect, it } from 'vitest'
import indexFixture from './__fixtures__/index.html?raw'
import bookFixture from './__fixtures__/book-ddj.html?raw'
import mp3Fixture from './__fixtures__/book-mp3.html?raw'
import transcriptFixture from './__fixtures__/book-transcript.html?raw'
import {
  absoluteUrl,
  parseAudioLinks,
  parseBookDetail,
  parseBookList,
  parseMusicList,
  referencesAudioPlayer,
} from './yujizi'
import { NoAudioError, SOURCE_ORIGIN, SourceParseError } from '../domain'

describe('absoluteUrl', () => {
  it('prefixes site-relative paths with the www origin', () => {
    expect(absoluteUrl('/玉机子/a.m4a').startsWith(`${SOURCE_ORIGIN}/`)).toBe(true)
  })

  it('encodes chinese path segments exactly once', () => {
    const url = absoluteUrl('/玉机子/玉机子讲道德经/28416280.m4a')
    expect(url).toContain('%E7%8E%89%E6%9C%BA%E5%AD%90')
    expect(url).not.toContain('%25')
  })

  it('leaves already-encoded input untouched', () => {
    const encoded = encodeURI('/玉机子/a.m4a')
    expect(absoluteUrl(encoded)).toBe(`${SOURCE_ORIGIN}${encoded}`)
    expect(absoluteUrl(encoded)).not.toContain('%25')
  })

  it('keeps absolute urls on their own host', () => {
    expect(absoluteUrl('https://example.com/x.m4a')).toBe('https://example.com/x.m4a')
  })
})

describe('parseBookList', () => {
  it('reads every book page from the real index', () => {
    const books = parseBookList(indexFixture)
    expect(books.length).toBe(11)
    expect(books.map((book) => book.slug)).toContain('道德经')
  })

  it('skips the index itself and duplicates', () => {
    const html = '<a href="/index.html">i</a><a href="/a.html">a</a><a href="/a.html">a</a><a href="/b.html">b</a>'
    expect(parseBookList(html).map((book) => book.slug)).toEqual(['a', 'b'])
  })

  it('reports an unreadable index instead of returning nothing', () => {
    expect(() => parseBookList('<html><body>维护中</body></html>')).toThrow(SourceParseError)
  })
})

describe('parseMusicList', () => {
  it('extracts every track from the real book page', () => {
    const tracks = parseMusicList(bookFixture)
    expect(tracks.length).toBe(83)
    expect(tracks[0].name).toBe('第01课前解说')
    expect(tracks[0].url).toContain('28416280.m4a')
    expect(tracks[0].url.startsWith(`${SOURCE_ORIGIN}/`)).toBe(true)
  })

  it('returns an empty list when the declaration is absent', () => {
    expect(parseMusicList('<html></html>')).toEqual([])
  })
})

describe('parseAudioLinks', () => {
  it('collects distinct audio links as a fallback', () => {
    const html = '<a href="/x/1.m4a">1</a><a href="/x/1.m4a">1</a><audio src="/x/2.mp3"></audio>'
    expect(parseAudioLinks(html).map((track) => track.url)).toHaveLength(2)
  })
})

describe('parseBookDetail', () => {
  const book = { slug: '道德经', title: '道德经', pageUrl: `${SOURCE_ORIGIN}/道德经.html` }

  it('prefers the music list', () => {
    expect(parseBookDetail(book, bookFixture).tracks).toHaveLength(83)
  })

  it('falls back to loose audio links when the list is missing', () => {
    const html = '<audio src="/x/2.mp3"></audio><script src="/js/musicplayer.js"></script>'
    expect(parseBookDetail(book, html).tracks).toHaveLength(1)
  })

  it('reads an mp3 book', () => {
    expect(parseBookDetail(book, mp3Fixture).tracks).toHaveLength(12)
    expect(parseBookDetail(book, mp3Fixture).tracks[0].url).toMatch(/\.mp3$/)
  })

  it('reports a transcript page as having no audio, not a broken source', () => {
    const transcript = { slug: '玉师聊修行', title: '玉师聊修行', pageUrl: `${SOURCE_ORIGIN}/玉师聊修行.html` }
    expect(() => parseBookDetail(transcript, transcriptFixture)).toThrow(NoAudioError)
    expect(() => parseBookDetail(transcript, transcriptFixture)).toThrow(/没有音频内容/)
  })

  it('reports a changed shape when an audio page yields nothing', () => {
    const html = '<script src="/js/musicplayer.js"></script>'
    expect(() => parseBookDetail(book, html)).toThrow(SourceParseError)
    expect(() => parseBookDetail(book, html)).toThrow(/书源格式可能已变化/)
  })
})

describe('referencesAudioPlayer', () => {
  it('detects the player script on audio books', () => {
    expect(referencesAudioPlayer(bookFixture)).toBe(true)
    expect(referencesAudioPlayer(mp3Fixture)).toBe(true)
  })

  it('is false on transcript pages', () => {
    expect(referencesAudioPlayer(transcriptFixture)).toBe(false)
  })
})
