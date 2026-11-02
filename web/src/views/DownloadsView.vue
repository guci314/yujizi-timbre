<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { formatBytes, ratio } from '../core/format'
import { ensureDownloadsLoaded, useDownloads } from '../psm/download-store'
import { useLibrary } from '../psm/library-store'

const router = useRouter()
const downloads = useDownloads()
const { specs, loadBooks } = useLibrary()

/** Downloads grouped by book, largest first. */
const groups = computed(() => {
  const bySlug = new Map<string, { slug: string; title: string; count: number; bytes: number }>()
  for (const entry of downloads.entries.value) {
    const group = bySlug.get(entry.bookSlug) ?? {
      slug: entry.bookSlug,
      title: entry.bookTitle,
      count: 0,
      bytes: 0,
    }
    group.count += 1
    group.bytes += entry.sizeBytes
    bySlug.set(entry.bookSlug, group)
  }
  return [...bySlug.values()].sort((left, right) => right.bytes - left.bytes)
})

const usedRatio = computed(() =>
  downloads.usage.value === undefined ? 0 : ratio(downloads.usage.value.usage, downloads.usage.value.quota),
)
const usedPercent = computed(() => Math.round(usedRatio.value * 100))

onMounted(async () => {
  await Promise.all([ensureDownloadsLoaded(), loadBooks()])
  await downloads.refresh()
  // First visit after an upgrade pays for hashing the legacy tracks; later
  // visits skip every record that already carries its sha256 stamp.
  await downloads.audit()
})
</script>

<template>
  <section>
    <div class="top-nav">
      <button class="link-button" @click="router.back()">返回</button>
      <span class="top-nav__spacer" />
      <RouterLink class="link-button" :to="{ name: 'shelf' }">书架</RouterLink>
    </div>

    <h1 class="page-title">离线下载</h1>

    <div class="storage-card">
      <p class="storage-card__line">
        <strong>{{ formatBytes(downloads.totalBytes.value) }}</strong>
        <span class="muted">篇章已收进本机书箧</span>
      </p>
      <div v-if="downloads.usageLabel.value" class="storage-meter" :aria-label="`存储已用 ${usedPercent}%`">
        <span class="storage-meter__fill" :style="{ width: `${Math.max(usedPercent, 1)}%` }" />
      </div>
      <p v-if="downloads.usageLabel.value" class="muted storage-card__hint">
        {{ downloads.usageLabel.value }}（浏览器按可用磁盘估算，随时会变）
      </p>
      <p v-else class="muted storage-card__hint">这个浏览器不提供存储用量信息。</p>

      <div class="storage-card__actions">
        <button class="link-button" @click="downloads.persist()">申请持久保存</button>
        <span v-if="downloads.persisted.value === true" class="muted">已获得持久保存</span>
        <span v-else-if="downloads.persisted.value === false" class="muted">
          未获授权（不影响使用，装到主屏幕可免除 7 天清理）
        </span>
      </div>

      <div class="storage-card__actions">
        <button class="link-button" :disabled="downloads.auditing.value" @click="downloads.audit()">
          {{ downloads.auditing.value ? '核对中…' : '核对账实' }}
        </button>
        <span v-if="downloads.auditNote.value" class="muted">{{ downloads.auditNote.value }}</span>
      </div>
    </div>

    <p v-if="downloads.error.value" class="error-banner">{{ downloads.error.value }}</p>

    <p v-if="groups.length === 0" class="empty-state">
      还没有留存任何篇章。在书页点「留存」保存单篇，或点「留存整卷」。
    </p>

    <template v-else>
      <div v-for="group in groups" :key="group.slug" class="download-group">
        <div class="download-group__head">
          <button class="link-button" @click="router.push({ name: 'player', params: { slug: group.slug } })">
            {{ group.title }}
          </button>
          <span class="muted">{{ group.count }} 篇 · {{ formatBytes(group.bytes) }}</span>
          <button class="link-button link-button--danger" :disabled="downloads.busy.value" @click="downloads.dropBook(group.slug)">
            清除
          </button>
        </div>
      </div>

      <div class="download-all">
        <button class="link-button link-button--danger" :disabled="downloads.busy.value" @click="downloads.dropAll()">
          清除全部下载
        </button>
        <span class="muted">共 {{ specs.length }} 卷可留存</span>
      </div>
    </template>

    <ul class="download-list">
      <li v-for="entry in downloads.entries.value" :key="entry.url" class="download-row">
        <span class="download-row__name">{{ entry.bookTitle }} · {{ entry.trackName }}</span>
        <span class="muted">{{ formatBytes(entry.sizeBytes) }}</span>
        <button class="link-button link-button--danger" :disabled="downloads.busy.value" @click="downloads.dropTrack(entry.url)">
          删除
        </button>
      </li>
    </ul>
  </section>
</template>
