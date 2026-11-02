<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Bookmark } from '../core/domain'
import { listBookmarks, removeBookmark } from '../core/bookmarks'
import { formatClock } from '../psm/format-clock'

const router = useRouter()
const grouped = ref<Record<string, Bookmark[]>>({})
const loading = ref(true)
const error = ref<string>()

const groups = computed(() =>
  Object.entries(grouped.value).map(([slug, items]) => ({
    slug,
    title: items[0]?.bookTitle ?? slug,
    items,
  })),
)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    grouped.value = await listBookmarks()
    error.value = undefined
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '书签加载失败'
  } finally {
    loading.value = false
  }
}

async function remove(id: string): Promise<void> {
  await removeBookmark(id)
  await refresh()
}

/**
 * A bookmark is a position, so the position must travel with the navigation.
 * Pushing only the slug is what made every bookmark open at the wrong second (B1).
 */
function openBookmark(item: Bookmark): void {
  void router.push({
    name: 'player',
    params: { slug: item.bookSlug },
    query: { track: String(item.trackIndex), time: String(item.currentTime) },
  })
}

onMounted(() => void refresh())
</script>

<template>
  <section>
    <div class="top-nav">
      <button class="link-button" @click="router.back()">返回</button>
      <span class="top-nav__spacer" />
      <RouterLink class="link-button" :to="{ name: 'shelf' }">书架</RouterLink>
    </div>

    <h1 class="page-title">书签</h1>

    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-else-if="loading" class="empty-state">正在载入…</p>
    <p v-else-if="groups.length === 0" class="empty-state">还没有书签。播放时点「加书签」即可记录当前位置。</p>

    <div v-for="group in groups" :key="group.slug" class="bookmark-group">
      <h2 class="bookmark-group__title">{{ group.title }}</h2>
      <div v-for="item in group.items" :key="item.id" class="bookmark-row">
        <button class="bookmark-row__main" @click="openBookmark(item)">
          <span class="bookmark-row__label">{{ item.trackName }}</span>
          <span class="bookmark-row__meta">{{ formatClock(item.currentTime) }} · 第 {{ item.trackIndex + 1 }} 章</span>
        </button>
        <button class="link-button link-button--danger" @click="remove(item.id)">删除</button>
      </div>
    </div>
  </section>
</template>
