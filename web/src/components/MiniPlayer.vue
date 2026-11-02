<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePlayer } from '../psm/player-store'

const route = useRoute()
const router = useRouter()
const player = usePlayer()

/** 播放页自己就有完整控件，这里不重复。 */
const visible = computed(() => player.book.value !== null && route.name !== 'player')
const title = computed(() => player.chapterTitle.value || player.bookTitle.value)

function openPlayer(): void {
  const book = player.book.value
  if (book === null) return
  void router.push({ name: 'player', params: { slug: book.id } })
}
</script>

<template>
  <div v-if="visible" class="mini-player">
    <button class="control-button" aria-label="开讲或暂停" @click="player.toggle()">
      {{ player.isPlaying.value ? '⏸' : '▶' }}
    </button>
    <button class="mini-player__info" @click="openPlayer">
      <span class="mini-player__title">{{ title }}</span>
      <span class="mini-player__subtitle">{{ player.bookTitle.value }}</span>
    </button>
    <button class="link-button" @click="openPlayer">展开</button>
  </div>
</template>
