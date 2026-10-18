<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useLibrary } from '../core/library'

const router = useRouter()
const { books, loading, error, loadBooks } = useLibrary()

onMounted(() => void loadBooks())

function openBook(slug: string) {
  void router.push({ name: 'player', params: { slug } })
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

    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-else-if="loading && books.length === 0" class="empty-state">正在载入书架…</p>
    <p v-else-if="books.length === 0" class="empty-state">书架是空的。</p>

    <div v-else class="book-grid">
      <button v-for="book in books" :key="book.slug" class="book-card" @click="openBook(book.slug)">
        <span class="book-card__cover">{{ book.title.slice(0, 1) }}</span>
        <span class="book-card__title">{{ book.title }}</span>
      </button>
    </div>
  </section>
</template>
