/**
 * 篇章定位：纯业务 PIM 只说「第几卷、第几篇」，平台外壳在这里把它换成本机
 * 能取用的声音地址。PIM 因此永远不认识地址、协议或文件。
 */

import type { Track } from '../core/domain'

const tracksByBook = new Map<string, readonly Track[]>()

export function registerTracks(bookId: string, tracks: readonly Track[]): void {
  tracksByBook.set(bookId, tracks)
}

export function resolveTrack(bookId: string, chapterIndex: number): Track | undefined {
  return tracksByBook.get(bookId)?.[chapterIndex]
}

export function hasBookTracks(bookId: string): boolean {
  return tracksByBook.has(bookId)
}

export function clearMediaIndex(): void {
  tracksByBook.clear()
}
