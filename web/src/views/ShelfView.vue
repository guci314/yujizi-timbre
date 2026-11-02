<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../psm/library-store'

const router = useRouter()
const { specs, loading, offline, error, loadBooks } = useLibrary()

onMounted(() => void loadBooks())

function openBook(id: string): void {
  void router.push({ name: 'player', params: { slug: id } })
}
</script>

<template>
  <section>
    <div class="top-nav">
      <h1 class="page-title">书架</h1>
      <span class="top-nav__spacer" />
      <RouterLink class="link-button" :to="{ name: 'downloads' }">离线</RouterLink>
      <RouterLink class="link-button" :to="{ name: 'bookmarks' }">书签</RouterLink>
    </div>

    <p v-if="offline && specs.length > 0" class="badge">离线模式 · 显示本机书箧</p>
    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-else-if="loading && specs.length === 0" class="empty-state">正在载入书架…</p>
    <p v-else-if="specs.length === 0" class="empty-state">书架是空的。</p>

    <div v-else class="book-grid">
      <button v-for="book in specs" :key="book.id" class="book-card" @click="openBook(book.id)">
        <span class="book-card__cover">{{ book.title.slice(0, 1) }}</span>
        <span class="book-card__title">{{ book.title }}</span>
      </button>
    </div>
  </section>
</template>
