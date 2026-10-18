<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBookDetail, useLibrary } from '../core/library'
import { player } from '../player/shared'
import { formatTime, PLAYBACK_RATES } from '../player/playback'
import { addBookmark } from '../core/bookmarks'

const route = useRoute()
const router = useRouter()
const { books, loadBooks } = useLibrary()
const { detail, loading, error, noAudio, load } = useBookDetail()
const state = player()
const localError = ref<string>()

const slug = computed(() => String(route.params.slug ?? ''))
const track = computed(() => detail.value?.tracks[state.trackIndex.value])
const canNext = computed(() => state.trackIndex.value < (detail.value?.tracks.length ?? 0) - 1)
const canPrevious = computed(() => state.trackIndex.value > 0)
const isCurrentBook = computed(() => state.book.value?.slug === slug.value)

onMounted(async () => {
  await loadBooks()
  const book = books.value.find((candidate) => candidate.slug === slug.value)
  if (book === undefined) {
    localError.value = '找不到这本书'
    return
  }
  if (isCurrentBook.value) return
  const loaded = await load(book)
  if (loaded !== undefined) await state.open(loaded)
})

function onSeek(event: Event) {
  state.seek(Number((event.target as HTMLInputElement).value))
}

async function addCurrentBookmark() {
  const book = detail.value
  if (book === undefined) return
  await addBookmark({
    bookSlug: book.slug,
    bookTitle: book.title,
    trackIndex: state.trackIndex.value,
    trackName: track.value?.name ?? book.title,
    currentTime: state.currentTime.value,
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
      <div class="now-playing">
        <p class="now-playing__book">{{ detail.title }} · 第 {{ state.trackIndex.value + 1 }} / {{ detail.tracks.length }} 章</p>
        <p class="now-playing__track">{{ track?.name ?? '未选择章节' }}</p>

        <p v-if="state.error.value" class="error-banner">{{ state.error.value }}</p>

        <div class="progress-row">
          <span>{{ formatTime(state.currentTime.value) }}</span>
          <input
            type="range"
            min="0"
            :max="state.duration.value || 0"
            step="1"
            :value="state.currentTime.value"
            aria-label="播放进度"
            @input="onSeek"
          />
          <span>{{ formatTime(state.duration.value) }}</span>
        </div>

        <div class="controls">
          <button class="control-button" :disabled="!canPrevious" aria-label="上一章" @click="state.previous()">⏮</button>
          <button class="control-button control-button--primary" aria-label="播放或暂停" @click="state.toggle()">
            {{ state.isPlaying.value ? '⏸' : '▶' }}
          </button>
          <button class="control-button" :disabled="!canNext" aria-label="下一章" @click="state.next()">⏭</button>
        </div>

        <div class="rates">
          <button
            v-for="rate in PLAYBACK_RATES"
            :key="rate"
            class="rate-chip"
            :aria-pressed="state.rate.value === rate"
            @click="state.setRate(rate)"
          >
            {{ rate }}×
          </button>
        </div>
      </div>

      <div class="chapter-list">
        <p class="chapter-list__head">共 {{ detail.tracks.length }} 章</p>
        <ul class="chapter-list__items">
          <li v-for="(item, index) in detail.tracks" :key="item.url">
            <button
              class="chapter-item"
              :aria-current="index === state.trackIndex.value"
              @click="state.playTrack(index)"
            >
              <span class="chapter-item__index">{{ index + 1 }}</span>
              <span>{{ item.name }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
