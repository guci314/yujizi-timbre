<script setup lang="ts">
import { ref } from 'vue'
import { SLEEP_TIMER_OPTIONS, type SleepTimerOption } from '../player/sleep'

const props = defineProps<{
  /** Seconds left on the running timer; undefined when no timer runs. */
  remaining: number | undefined
  /** The timer in force, if any. */
  active: SleepTimerOption | undefined
  onStart: (option: SleepTimerOption) => void
  onCancel: () => void
}>()

const open = ref(false)

/** `m:ss` for the time left on the running timer. */
function formatRemaining(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

function choose(option: SleepTimerOption): void {
  props.onStart(option)
  open.value = false
}

function cancel(): void {
  props.onCancel()
  open.value = false
}
</script>

<template>
  <div class="sleep-timer">
    <button
      class="link-button"
      data-testid="sleep-timer-toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <template v-if="remaining !== undefined">🌙 {{ formatRemaining(remaining) }}</template>
      <template v-else>🌙 睡眠定时</template>
    </button>

    <div v-if="open" class="sleep-timer__menu" data-testid="sleep-timer-menu">
      <button
        v-for="option in SLEEP_TIMER_OPTIONS"
        :key="option.label"
        class="sleep-timer__option"
        :aria-pressed="active?.label === option.label"
        @click="choose(option)"
      >
        {{ option.label }}
      </button>
      <button
        v-if="remaining !== undefined"
        class="sleep-timer__option sleep-timer__option--danger"
        data-testid="sleep-timer-cancel"
        @click="cancel"
      >
        取消定时
      </button>
    </div>
  </div>
</template>
