/**
 * 平台外壳对纯业务快照的一次翻译：这一句「第几卷、第几篇、第几秒、是否诵读中」
 * 到底要让播放器做什么。
 */

export interface PlayerTarget {
  /** `bookId#chapterIndex`，用来判断是否换了篇章。 */
  readonly key: string | null
  /** 本机可播放的声音来源；取不到时为 null。 */
  readonly source: string | null
  readonly positionSec: number
  readonly speed: number
  readonly playing: boolean
}

export function hearingKey(bookId: string | null | undefined, chapterIndex: number): string | null {
  return bookId === null || bookId === undefined ? null : `${bookId}#${chapterIndex}`
}
