import { describe, expect, it } from 'vitest'
import {
  formatTime,
  nextIndex,
  nowPlayingTitle,
  previousIndex,
  resumePosition,
  seekTarget,
} from './playback'

describe('formatTime', () => {
  it('formats under an hour', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(61)).toBe('1:01')
    expect(formatTime(599)).toBe('9:59')
  })

  it('formats past an hour with padded minutes', () => {
    expect(formatTime(3600)).toBe('1:00:00')
    expect(formatTime(3725)).toBe('1:02:05')
  })

  it('degrades safely for invalid input', () => {
    expect(formatTime(Number.NaN)).toBe('0:00')
    expect(formatTime(-5)).toBe('0:00')
  })
})

describe('resumePosition', () => {
  it('starts at zero when nothing was saved', () => {
    expect(resumePosition(0, 600)).toBe(0)
  })

  it('rewinds a few seconds to restore context', () => {
    expect(resumePosition(120, 600)).toBe(117)
  })

  it('never rewinds below zero', () => {
    expect(resumePosition(2, 600)).toBe(0)
  })

  it('rewinds from the end of a finished track', () => {
    expect(resumePosition(600, 600)).toBe(597)
  })

  it('clamps a position that exceeds the track', () => {
    expect(resumePosition(605, 600)).toBe(599)
  })

  it('rewinds without a known duration', () => {
    expect(resumePosition(50, Number.NaN)).toBe(47)
  })
})

describe('nextIndex', () => {
  it('advances while tracks remain', () => {
    expect(nextIndex(0, 3)).toBe(1)
  })

  it('stops at the last track', () => {
    expect(nextIndex(2, 3)).toBeUndefined()
  })
})

describe('previousIndex', () => {
  it('goes back from a later track', () => {
    expect(previousIndex(2)).toBe(1)
  })

  it('stops at the first track', () => {
    expect(previousIndex(0)).toBeUndefined()
  })
})

describe('nowPlayingTitle', () => {
  const book = {
    slug: 'ddj',
    title: '道德经',
    pageUrl: 'https://www.yujizi.org/道德经.html',
    tracks: [
      { name: '第01课前解说', url: 'https://www.yujizi.org/a.m4a' },
      { name: '第02章', url: 'https://www.yujizi.org/b.m4a' },
    ],
  }

  it('uses the chapter name', () => {
    expect(nowPlayingTitle(book, 1)).toBe('第02章')
  })

  it('falls back to the book title for a missing chapter', () => {
    expect(nowPlayingTitle(book, 9)).toBe('道德经')
  })
})

describe('seekTarget', () => {
  it('moves 30 seconds forward', () => {
    expect(seekTarget(100, 30)).toBe(130)
  })

  it('moves 30 seconds back', () => {
    expect(seekTarget(100, -30)).toBe(70)
  })

  it('stops at the start instead of going negative', () => {
    expect(seekTarget(10, -30)).toBe(0)
  })

  it('stops at the end instead of running past it', () => {
    expect(seekTarget(580, 30, 600)).toBe(600)
  })

  it('keeps the position when the duration is unknown', () => {
    expect(seekTarget(100, 30, Number.NaN)).toBe(130)
  })
})
