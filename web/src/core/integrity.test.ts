import { describe, expect, it } from 'vitest'
import {
  AudioIntegrityError,
  expectedIntegrityFor,
  integrityEntryCount,
  integrityKeyFor,
  sha256Hex,
  verifyBytes,
} from './integrity'

const ENCODED =
  'https://www.yujizi.org/%E5%A4%AA%E4%B9%99%E9%87%91%E5%8D%8E%E5%AE%97%E6%97%A8%E6%9C%97%E8%AF%BB%E5%92%8C%E8%AF%91%E6%96%87/13-%E7%AC%AC%E4%B8%83%E7%AB%A0-%E5%9B%9E%E5%85%89%E6%B4%BB%E6%B3%95-%E5%8E%9F%E6%96%87.m4a'
const RAW = decodeURIComponent(ENCODED)
const KEY = '/太乙金华宗旨朗读和译文/13-第七章-回光活法-原文.m4a'

describe('integrity manifest', () => {
  it('covers every track the site publishes', async () => {
    expect(await integrityEntryCount()).toBe(172)
  })

  it('finds a track whether the url is encoded or raw', async () => {
    expect(await integrityKeyFor(ENCODED)).toBe(KEY)
    expect(await integrityKeyFor(RAW)).toBe(KEY)
    expect(await integrityKeyFor(`https://www.yujizi.org${KEY}`)).toBe(KEY)
  })

  it('ignores the query string and the origin', async () => {
    expect(await integrityKeyFor(`${RAW}?v=2`)).toBe(KEY)
    expect(await integrityKeyFor(`/太乙金华宗旨朗读和译文/13-第七章-回光活法-原文.m4a`)).toBe(KEY)
  })

  it('returns undefined for a track outside the manifest', async () => {
    expect(await integrityKeyFor('https://www.yujizi.org/book/1.m4a')).toBeUndefined()
    expect(await expectedIntegrityFor('https://example.test/unknown.m4a')).toBeUndefined()
  })
})

describe('verifyBytes', () => {
  const payload = new TextEncoder().encode('玉机子')

  it('accepts an empty manifest expectation when the length matches', async () => {
    await expect(verifyBytes({ bytes: payload, declaredLength: payload.length })).resolves.toBeUndefined()
  })

  it('rejects an empty body', async () => {
    await expect(verifyBytes({ bytes: new Uint8Array(0), declaredLength: 0 })).rejects.toBeInstanceOf(
      AudioIntegrityError,
    )
  })

  it('rejects a truncated body when the server declared a length', async () => {
    await expect(verifyBytes({ bytes: payload, declaredLength: payload.length + 1 })).rejects.toThrow(
      '音频校验失败（文件不完整或损坏），请重试',
    )
  })

  it('rejects a body whose size differs from the manifest', async () => {
    await expect(
      verifyBytes({
        bytes: payload,
        declaredLength: payload.length,
        expected: { size: payload.length + 10, sha256: '00'.repeat(32) },
      }),
    ).rejects.toThrow('音频校验失败')
  })

  it('rejects a body whose sha256 differs by one byte', async () => {
    const digest = await sha256Hex(payload)
    const tampered = payload.slice()
    tampered[0] ^= 0xff

    await expect(
      verifyBytes({
        bytes: tampered,
        declaredLength: tampered.length,
        expected: { size: tampered.length, sha256: digest },
      }),
    ).rejects.toThrow('音频校验失败')
  })

  it('accepts a body that matches size and sha256', async () => {
    const digest = await sha256Hex(payload)
    await expect(
      verifyBytes({
        bytes: payload,
        declaredLength: payload.length,
        expected: { size: payload.length, sha256: digest },
      }),
    ).resolves.toBeUndefined()
  })
})
