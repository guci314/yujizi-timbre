<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addBookmark } from '../core/bookmarks'
import { formatBytes } from '../core/format'
import type { BookDetail } from '../core/domain'
import { bookSpecFrom, useBookDetail, useLibrary } from '../psm/library-store'
import { usePlayer } from '../psm/player-store'
import { readProgress } from '../psm/storage-driver'
import { ensureDownloadsLoaded, useDownloads } from '../psm/download-store'
import {
  PLAYBACK_SPEEDS,
  SKIP_SECONDS,
  type BookSpec,
  type SleepOption,
} from '../pim/listening-model'
import SleepTimerButton from '../components/SleepTimerButton.vue'
import { formatClock } from '../psm/format-clock'

const route = useRoute()
const router = useRouter()
const { books, loadBooks, offline } = useLibrary()
const { detail, loading, error, noAudio, fromCache, load, loadFromCatalog } = useBookDetail()
const player = usePlayer()
const downloads = useDownloads()

const localError = ref<string>()
const savedChapter = ref(0)
const savedTime = ref(0)
/** 这一卷的纯业务规格，供播放器使用。 */
const spec = ref<BookSpec>()

const slug = computed(() => String(route.params.slug ?? ''))
/** 只有在播放器正诵读这一卷时，页面才显示实时进度。 */
const isPlayingBook = computed(() => player.book.value?.id === slug.value)

const chapterIndex = computed(() => (isPlayingBook.value ? player.chapterIndex.value : savedChapter.value))
const position = computed(() => (isPlayingBook.value ? player.positionSec.value : savedTime.value))
const chapterDuration = computed(() => (isPlayingBook.value ? player.chapterDuration.value : 0))
const isPlaying = computed(() => isPlayingBook.value && player.isPlaying.value)
const chapterTitle = computed(
  () => spec.value?.chapters[chapterIndex.value]?.title ?? '未选篇章',
)
const sliderMax = computed(() =>
  chapterDuration.value > 0 ? chapterDuration.value : Math.max(3600, position.value),
)
const downloadedHere = computed(() => downloads.downloadedCount(slug.value))
const allDownloaded = computed(
  () => (spec.value?.chapters.length ?? 0) > 0 && downloadedHere.value >= (spec.value?.chapters.length ?? 0),
)
const sleepLabel = computed(() => (player.sleepMode.value === 'end-of-chapter' ? '本章诵毕' : undefined))
const sleepRemaining = computed(() =>
  player.sleepMode.value === 'minutes' ? player.sleepRemaining.value : undefined,
)

async function openFromRoute(): Promise<void> {
  const target = slug.value
  localError.value = undefined
  savedChapter.value = 0
  savedTime.value = 0

  await Promise.all([loadBooks(), ensureDownloadsLoaded()])
  if (target !== slug.value) return

  const listed = books.value.find((candidate) => candidate.slug === target)
  const loaded: BookDetail | undefined =
    listed !== undefined ? await load(listed) : await loadFromCatalog(target)
  if (loaded === undefined || target !== slug.value) return

  spec.value = bookSpecFrom(loaded)

  const progress = await readProgress(loaded.slug)
  if (progress !== undefined && progress.trackIndex < loaded.tracks.length) {
    savedChapter.value = progress.trackIndex
    savedTime.value = progress.currentTime
  }

  // 书签带着章节与秒数来，那就精准落点开讲。
  const queryChapter = Number(route.query.track)
  const queryTime = Number(route.query.time)
  if (Number.isInteger(queryChapter) && queryChapter >= 0) {
    player.jumpAndPlay(spec.value, queryChapter, Number.isFinite(queryTime) ? queryTime : 0)
    return
  }

  // 翻看这一卷的目录，绝不能掐断正在诵读的另一卷。
  if (player.state.value === 'S0_IDLE') {
    player.open(spec.value, savedChapter.value, savedTime.value)
  }
}

onMounted(() => void openFromRoute())
watch(slug, () => void openFromRoute())

function primary(): void {
  if (spec.value === undefined) return
  if (isPlayingBook.value) {
    player.toggle()
    return
  }
  // 详情页的播放键只意味着「诵这一卷」，不是「切换当前那一卷」。
  player.jumpAndPlay(spec.value, chapterIndex.value, position.value)
}

function playChapter(index: number): void {
  if (spec.value === undefined) return
  player.jumpAndPlay(spec.value, index, 0)
}

function seekTo(seconds: number): void {
  if (isPlayingBook.value) {
    player.seek(seconds)
    return
  }
  savedTime.value = Math.max(0, seconds)
}

function skip(delta: number): void {
  if (isPlayingBook.value) {
    player.skip(delta)
    return
  }
  savedTime.value = Math.max(0, savedTime.value + delta)
}

function onSeek(event: Event): void {
  seekTo(Number((event.target as HTMLInputElement).value))
}

function setSleep(option: SleepOption | null): void {
  player.setSleep(option)
}

async function addCurrentBookmark(): Promise<void> {
  const book = detail.value
  if (book === undefined) return
  await addBookmark({
    bookSlug: book.slug,
    bookTitle: book.title,
    trackIndex: chapterIndex.value,
    trackName: spec.value?.chapters[chapterIndex.value]?.title ?? book.title,
    currentTime: position.value,
  })
  localError.value = undefined
  await router.push({ name: 'bookmarks' })
}
</script>

<template>
  <section class="player">
    <div class="top-nav">
      <button class="link-button" @click="router.back()">返回</button>
      <span class="top-nav__spacer" />
      <button class="link-button" :disabled="detail === undefined" @click="addCurrentBookmark">加书签</button>
    </div>

    <p v-if="localError" class="error-banner">{{ localError }}</p>
    <p v-else-if="noAudio" class="empty-state">{{ error }}</p>
    <p v-else-if="error" class="error-banner">{{ error }}</p>
    <p v-else-if="loading" class="empty-state">正在载入篇章…</p>

    <template v-if="detail && spec">
      <p v-if="fromCache" class="badge">离线模式 · 目录来自本机书箧</p>
      <p v-if="offline && !fromCache" class="badge">离线模式</p>

      <div class="now-playing">
        <p class="now-playing__book">
          {{ detail.title }} · 第 {{ chapterIndex + 1 }} / {{ spec.chapters.length }} 篇
          <span v-if="isPlaying" class="muted">· 正在诵读</span>
        </p>
        <p class="now-playing__track">{{ chapterTitle }}</p>

        <p v-if="isPlayingBook && player.error.value" class="error-banner">
          {{ player.error.value }}
          <button class="link-button" @click="player.toggle()">重试</button>
        </p>

        <div class="progress-row">
          <span>{{ formatClock(position) }}</span>
          <input
            type="range"
            min="0"
            :max="sliderMax"
            step="1"
            :value="position"
            aria-label="诵读进度"
            @input="onSeek"
          />
          <span>{{ chapterDuration > 0 ? formatClock(chapterDuration) : '—' }}</span>
        </div>
        <p v-if="!isPlayingBook" class="muted preview-hint">
          这一卷尚未开讲。拖动进度或点 ±30 秒可先选好起点，点 ▶ 从该处开始。
        </p>

        <div class="controls">
          <button class="control-button" data-testid="skip-back" aria-label="后退 30 秒" @click="skip(-SKIP_SECONDS)">
            ⟲
          </button>
          <button class="control-button control-button--primary" aria-label="开讲或暂停" @click="primary">
            {{ isPlaying ? '⏸' : '▶' }}
          </button>
          <button class="control-button" data-testid="skip-forward" aria-label="前进 30 秒" @click="skip(SKIP_SECONDS)">
            ⟳
          </button>
        </div>

        <div class="chapter-controls">
          <button class="link-button" :disabled="!isPlayingBook || !player.canPrevious.value" @click="player.previous()">
            上一篇
          </button>
          <button class="link-button" :disabled="!isPlayingBook || !player.canNext.value" @click="player.next()">
            下一篇
          </button>
        </div>

        <div class="rates">
          <button
            v-for="speed in PLAYBACK_SPEEDS"
            :key="speed"
            class="rate-chip"
            :aria-pressed="player.speed.value === speed"
            @click="player.setSpeed(speed)"
          >
            {{ speed }}×
          </button>
        </div>

        <div class="sleep-timer-row">
          <SleepTimerButton
            :remaining="sleepRemaining"
            :label="sleepLabel"
            :on-start="setSleep"
            :on-cancel="() => setSleep(null)"
          />
          <p v-if="player.sleepMode.value !== 'off'" class="sleep-timer-note">
            {{ sleepLabel ?? '倒计时结束' }}后自动止息（静置时不走针）
          </p>
        </div>
      </div>

      <div class="chapter-list">
        <div class="chapter-list__head chapter-list__head--actions">
          <span>
            共 {{ spec.chapters.length }} 篇<template v-if="downloadedHere > 0"> · 已存 {{ downloadedHere }} 篇</template>
          </span>
          <span class="chapter-list__buttons">
            <button class="link-button" :disabled="downloads.bookBusy.value || allDownloaded" @click="downloads.saveBook(detail)">
              {{ allDownloaded ? '已全部留存' : '留存整卷' }}
            </button>
            <button
              v-if="downloadedHere > 0"
              class="link-button link-button--danger"
              :disabled="downloads.busy.value"
              @click="downloads.dropBook(detail.slug)"
            >
              释出全卷
            </button>
          </span>
        </div>

        <p v-if="downloads.error.value" class="error-banner error-banner--inline">{{ downloads.error.value }}</p>

        <ul class="chapter-list__items">
          <li
            v-for="(chapter, index) in spec.chapters"
            :key="chapter.index"
            class="chapter-row"
          >
            <button
              class="chapter-item"
              :class="{ 'chapter-item--offline': offline && !downloads.isDownloaded(detail.tracks[index].url) }"
              :aria-current="isPlayingBook && index === player.chapterIndex.value"
              @click="playChapter(index)"
            >
              <span class="chapter-item__index">{{ index + 1 }}</span>
              <span>{{ chapter.title }}</span>
              <span
                v-if="offline && !downloads.isDownloaded(detail.tracks[index].url)"
                class="muted chapter-item__note"
              >需联网</span>
            </button>
            <span class="chapter-row__actions">
              <span v-if="downloads.progressFor(detail.tracks[index].url)" class="chapter-row__progress">
                {{ formatBytes(downloads.progressFor(detail.tracks[index].url)!.received) }}
                <template v-if="downloads.progressFor(detail.tracks[index].url)!.total > 0">
                  / {{ formatBytes(downloads.progressFor(detail.tracks[index].url)!.total) }}
                </template>
              </span>
              <span v-else-if="downloads.isDownloaded(detail.tracks[index].url)" class="chapter-row__stored">
                ✓ {{ formatBytes(downloads.recordFor(detail.tracks[index].url)?.sizeBytes ?? 0) }}
              </span>
              <span v-else-if="downloads.failureFor(detail.tracks[index].url)" class="chapter-row__stored">
                ✕ {{ downloads.failureFor(detail.tracks[index].url) }}
              </span>
              <button
                v-if="downloads.isDownloaded(detail.tracks[index].url)"
                class="link-button link-button--danger"
                aria-label="释出这一篇"
                @click="downloads.dropTrack(detail.tracks[index].url)"
              >
                释出
              </button>
              <button
                v-else
                class="link-button"
                :disabled="downloads.isActive(detail.tracks[index].url)"
                aria-label="留存这一篇"
                @click="downloads.saveTrack(detail, detail.tracks[index], index)"
              >
                {{ downloads.isActive(detail.tracks[index].url) ? '留存中…' : '留存' }}
              </button>
            </span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
