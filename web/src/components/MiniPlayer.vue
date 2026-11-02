<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePlayer } from '../psm/player-store'

const route = useRoute()
const router = useRouter()
const player = usePlayer()

/** Hidden on the player page itself, whose full controls are already on screen. */
const visible = computed(() => player.book.value !== null && route.name !== 'player')
const title = computed(() => player.trackName.value || player.book.value?.title || '')
const subtitle = computed(() => player.book.value?.title ?? '')

function openPlayer(): void {
  const book = player.book.value
  if (book === null) return
  void router.push({ name: 'player', params: { slug: book.slug } })
}
</script>

<template>
  <div v-if="visible" class="mini-player">
    <button class="control-button" aria-label="播放或暂停" @click="player.toggle()">
      {{ player.isPlaying.value ? '⏸' : '▶' }}
    </button>
    <button class="mini-player__info" @click="openPlayer">
      <span class="mini-player__title">{{ title }}</span>
      <span class="mini-player__subtitle">{{ subtitle }}</span>
    </button>
    <button class="link-button" @click="openPlayer">展开</button>
  </div>
</template>
