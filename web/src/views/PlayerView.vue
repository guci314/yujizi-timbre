<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addBookmark } from '../core/bookmarks'
import { formatBytes } from '../core/format'
import { formatTime, PLAYBACK_RATES, SKIP_SECONDS, type SleepTimerOption } from '../pim/player-model'
import { useDownloads, ensureDownloadsLoaded } from '../psm/download-store'
import { useBookDetail, useLibrary } from '../psm/library-store'
import { usePlayer } from '../psm/player-store'
import { readProgress } from '../psm/storage-driver'
import SleepTimerButton from '../components/SleepTimerButton.vue'

const route = useRoute()
const router = useRouter()
const { books, loadBooks, offline } = useLibrary()
const { detail, loading, error, noAudio, fromCache, load } = useBookDetail()
const player = usePlayer()
const downloads = useDownloads()

const localError = ref<string>()
const savedTrackIndex = ref(0)
const savedTime = ref(0)

const slug = computed(() => String(route.params.slug ?? ''))
/** True only when the *player* is on this book, which is not the same as viewing it. */
const isPlayingBook = computed(() => player.book.value?.slug === slug.value)

/** What the page displays: the live session here, otherwise the last saved position. */
const trackIndex = computed(() => (isPlayingBook.value ? player.trackIndex.value : savedTrackIndex.value))
const currentTime = computed(() => (isPlayingBook.value ? player.currentTime.value : savedTime.value))
const duration = computed(() => (isPlayingBook.value ? player.duration.value : 0))
const isPlaying = computed(() => isPlayingBook.value && player.isPlaying.value)
const track = computed(() => detail.value?.tracks[trackIndex.value])
const canNext = computed(() => isPlayingBook.value && player.canNext.value)
const canPrevious = computed(() => isPlayingBook.value && player.canPrevious.value)
const downloadedHere = computed(() => downloads.downloadedCount(slug.value))
const allDownloaded = computed(
  () => (detail.value?.tracks.length ?? 0) > 0 && downloadedHere.value >= (detail.value?.tracks.length ?? 0),
)
const sleepLabel = computed(() => (player.sleepMode.value === 'end-of-chapter' ? '本章结束' : undefined))
const sleepRemaining = computed(() =>
  player.sleepMode.value === 'minutes' ? player.sleepRemaining.value : undefined,
)
/**
 * The live duration when this book is playing; otherwise a generous window so a
 * listener can pre-set a start position before the first tap.
 */
const sliderMax = computed(() => (duration.value > 0 ? duration.value : Math.max(3600, currentTime.value)))

async function openFromRoute(): Promise<void> {
  const target = slug.value
  localError.value = undefined
  savedTrackIndex.value = 0
  savedTime.value = 0
  await Promise.all([loadBooks(), ensureDownloadsLoaded()])
  if (target !== slug.value) return

  const book = books.value.find((candidate) => candidate.slug === target)
  if (book === undefined) {
    localError.value = '找不到这本书'
    return
  }

  const loaded = await load(book)
  if (loaded === undefined || target !== slug.value) return

  const progress = await readProgress(loaded.slug)
  if (progress !== undefined && progress.trackIndex < loaded.tracks.length) {
    savedTrackIndex.value = progress.trackIndex
    savedTime.value = progress.currentTime
  }

  // Bookmark hop: the position travels in the route, so it cannot be dropped (B1).
  const queryTrack = Number(route.query.track)
  const queryTime = Number(route.query.time)
  if (Number.isInteger(queryTrack) && queryTrack >= 0) {
    player.playAt(loaded, queryTrack, Number.isFinite(queryTime) ? queryTime : 0)
    return
  }

  // Viewing a book must not touch a session that is already playing another one (B2).
  if (player.ctx.value.state === 'S0_IDLE') {
    player.prepare(loaded, savedTrackIndex.value, savedTime.value)
  }
}

onMounted(() => void openFromRoute())

/** The component is reused when only the slug changes; reload instead of showing stale chapters. */
watch(slug, () => void openFromRoute())

function primary(): void {
  const book = detail.value
  if (book === undefined) return
  if (isPlayingBook.value) {
    player.toggle()
    return
  }
  // A play control on a detail page means "play this book", never "toggle whatever
  // else is loaded". This is the UI half of the B2 fix.
  player.playAt(book, trackIndex.value, currentTime.value)
}

function playChapter(index: number): void {
  const book = detail.value
  if (book === undefined) return
  player.playAt(book, index, 0)
}

function seekTo(seconds: number): void {
  if (isPlayingBook.value) {
    player.seek(seconds)
    return
  }
  // Not this book's session: move the page's own start marker, so the next tap
  // on play begins where the listener pointed instead of at the saved second.
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

function setSleep(option: SleepTimerOption | null): void {
  player.setSleep(option)
}

async function addCurrentBookmark(): Promise<void> {
  const book = detail.value
  if (book === undefined) return
  await addBookmark({
    bookSlug: book.slug,
    bookTitle: book.title,
    trackIndex: trackIndex.value,
    trackName: track.value?.name ?? book.title,
    currentTime: currentTime.value,
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
    <p v-else-if="loading" class="empty-state">正在载入章节…</p>

    <template v-if="detail">
      <p v-if="fromCache" class="badge">离线模式 · 章节表来自本机缓存</p>
      <p v-if="offline && !fromCache" class="badge">离线模式</p>

      <div class="now-playing">
        <p class="now-playing__book">
          {{ detail.title }} · 第 {{ trackIndex + 1 }} / {{ detail.tracks.length }} 章
          <span v-if="isPlayingBook" class="muted">· 正在播放</span>
        </p>
        <p class="now-playing__track">{{ track?.name ?? '未选择章节' }}</p>

        <p v-if="isPlayingBook && player.error.value" class="error-banner">
          {{ player.error.value }}
          <button class="link-button" @click="player.toggle()">重试</button>
        </p>

        <div class="progress-row">
          <span>{{ formatTime(currentTime) }}</span>
          <input
            type="range"
            min="0"
            :max="sliderMax"
            step="1"
            :value="currentTime"
            aria-label="播放进度"
            @input="onSeek"
          />
          <span>{{ duration > 0 ? formatTime(duration) : '—' }}</span>
        </div>
        <p v-if="!isPlayingBook" class="muted preview-hint">
          这本书尚未开始播放。拖动进度或点 ±30 秒可先选好起点，点 ▶ 从该处开始。
        </p>

        <div class="controls">
          <button class="control-button" data-testid="skip-back" aria-label="后退 30 秒" @click="skip(-SKIP_SECONDS)">
            ⟲
          </button>
          <button
            class="control-button control-button--primary"
            aria-label="播放或暂停"
            @click="primary"
          >
            {{ isPlaying ? '⏸' : '▶' }}
          </button>
          <button
            class="control-button"
            data-testid="skip-forward"
            aria-label="前进 30 秒"
            @click="skip(SKIP_SECONDS)"
          >
            ⟳
          </button>
        </div>

        <div class="chapter-controls">
          <button class="link-button" :disabled="!canPrevious" @click="player.previous()">上一章</button>
          <button class="link-button" :disabled="!canNext" @click="player.next()">下一章</button>
        </div>

        <div class="rates">
          <button
            v-for="rate in PLAYBACK_RATES"
            :key="rate"
            class="rate-chip"
            :aria-pressed="player.rate.value === rate"
            @click="player.setRate(rate)"
          >
            {{ rate }}×
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
            {{ sleepLabel ?? '倒计时结束' }}后自动停止播放（暂停时不计时）
          </p>
        </div>
      </div>

      <div class="chapter-list">
        <div class="chapter-list__head chapter-list__head--actions">
          <span>
            共 {{ detail.tracks.length }} 章<template v-if="downloadedHere > 0"> · 已存 {{ downloadedHere }} 集</template>
          </span>
          <span class="chapter-list__buttons">
            <button class="link-button" :disabled="downloads.bookBusy.value || allDownloaded" @click="downloads.saveBook(detail)">
              {{ allDownloaded ? '已全部下载' : '下载整本' }}
            </button>
            <button
              v-if="downloadedHere > 0"
              class="link-button link-button--danger"
              :disabled="downloads.busy.value"
              @click="downloads.dropBook(detail.slug)"
            >
              清除本书
            </button>
          </span>
        </div>

        <p v-if="downloads.error.value" class="error-banner error-banner--inline">{{ downloads.error.value }}</p>

        <ul class="chapter-list__items">
          <li v-for="(item, index) in detail.tracks" :key="item.url" class="chapter-row">
            <button
              class="chapter-item"
              :class="{ 'chapter-item--offline': offline && !downloads.isDownloaded(item.url) }"
              :aria-current="isPlayingBook && index === player.trackIndex.value"
              @click="playChapter(index)"
            >
              <span class="chapter-item__index">{{ index + 1 }}</span>
              <span>{{ item.name }}</span>
              <span v-if="offline && !downloads.isDownloaded(item.url)" class="muted chapter-item__note">需联网</span>
            </button>
            <span class="chapter-row__actions">
              <span v-if="downloads.progressFor(item.url)" class="chapter-row__progress">
                {{ formatBytes(downloads.progressFor(item.url)!.received) }}
                <template v-if="downloads.progressFor(item.url)!.total > 0">
                  / {{ formatBytes(downloads.progressFor(item.url)!.total) }}
                </template>
              </span>
              <span v-else-if="downloads.isDownloaded(item.url)" class="chapter-row__stored">
                ✓ {{ formatBytes(downloads.recordFor(item.url)?.sizeBytes ?? 0) }}
              </span>
              <span v-else-if="downloads.failureFor(item.url)" class="chapter-row__stored" :title="downloads.failureFor(item.url)">
                ✕ 失败
              </span>
              <button
                v-if="downloads.isDownloaded(item.url)"
                class="link-button link-button--danger"
                aria-label="删除这一集的下载"
                @click="downloads.dropTrack(item.url)"
              >
                删除
              </button>
              <button
                v-else
                class="link-button"
                :disabled="downloads.isActive(item.url)"
                aria-label="下载这一集"
                @click="downloads.saveTrack(detail, item, index)"
              >
                {{ downloads.isActive(item.url) ? '下载中…' : '下载' }}
              </button>
            </span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
