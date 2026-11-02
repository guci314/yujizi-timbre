<script setup lang="ts">
import { ref } from 'vue'
import { SLEEP_TIMER_OPTIONS, type SleepTimerOption } from '../pim/player-model'

const props = defineProps<{
  /** Seconds left on a minute timer; undefined when no minute timer runs. */
  remaining: number | undefined
  /** Extra label for modes without a countdown, e.g. 本章结束. */
  label: string | undefined
  onStart: (option: SleepTimerOption) => void
  onCancel: () => void
}>()

const open = ref(false)

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
    <button class="link-button" data-testid="sleep-timer-toggle" :aria-expanded="open" @click="open = !open">
      <template v-if="remaining !== undefined">🌙 {{ formatRemaining(remaining) }}</template>
      <template v-else-if="label !== undefined">🌙 {{ label }}</template>
      <template v-else>🌙 睡眠定时</template>
    </button>

    <div v-if="open" class="sleep-timer__menu" data-testid="sleep-timer-menu">
      <button
        v-for="option in SLEEP_TIMER_OPTIONS"
        :key="option.label"
        class="sleep-timer__option"
        :aria-pressed="label === option.label || (option.kind === 'minutes' && remaining !== undefined && option.label === `${Math.ceil((remaining ?? 0) / 60)} 分钟`)"
        @click="choose(option)"
      >
        {{ option.label }}
      </button>
      <button
        v-if="remaining !== undefined || label !== undefined"
        class="sleep-timer__option sleep-timer__option--danger"
        data-testid="sleep-timer-cancel"
        @click="cancel"
      >
        取消定时
      </button>
    </div>
  </div>
</template>
