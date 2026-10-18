<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { player } from '../player/shared'

const route = useRoute()
const router = useRouter()
const state = player()

/** Hidden while the player page itself is open; that page has full controls. */
const visible = computed(() => state.book.value !== undefined && route.name !== 'player')
const subtitle = computed(() => state.book.value?.title ?? '')
const title = computed(() => {
  const book = state.book.value
  if (book === undefined) return ''
  return book.tracks[state.trackIndex.value]?.name ?? book.title
})

function openPlayer() {
  const book = state.book.value
  if (book === undefined) return
  void router.push({ name: 'player', params: { slug: book.slug } })
}
</script>

<template>
  <div v-if="visible" class="mini-player">
    <button class="control-button" aria-label="播放或暂停" @click="state.toggle()">
      {{ state.isPlaying.value ? '⏸' : '▶' }}
    </button>
    <button class="mini-player__info" @click="openPlayer">
      <span class="mini-player__title">{{ title }}</span>
      <span class="mini-player__subtitle">{{ subtitle }}</span>
    </button>
    <button class="link-button" @click="openPlayer">展开</button>
  </div>
</template>
