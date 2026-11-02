<script setup lang="ts">
import { ref } from 'vue'
import { SLEEP_OPTIONS, type SleepOption } from '../pim/listening-model'
import { formatCountdown } from '../psm/format-clock'

const props = defineProps<{
  /** 分钟睡眠香剩余秒数；未设分钟香时为 undefined。 */
  remaining: number | undefined
  /** 没有倒计时的睡眠规则（本章诵毕）的显示名。 */
  label: string | undefined
  onStart: (option: SleepOption) => void
  onCancel: () => void
}>()

const open = ref(false)

function optionLabel(option: SleepOption): string {
  return option.kind === 'end-of-chapter' ? '本章诵毕' : `${option.minutes} 分钟`
}

function choose(option: SleepOption): void {
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
      <template v-if="remaining !== undefined">🌙 {{ formatCountdown(remaining) }}</template>
      <template v-else-if="label !== undefined">🌙 {{ label }}</template>
      <template v-else>🌙 睡眠香</template>
    </button>

    <div v-if="open" class="sleep-timer__menu" data-testid="sleep-timer-menu">
      <button
        v-for="option in SLEEP_OPTIONS"
        :key="optionLabel(option)"
        class="sleep-timer__option"
        @click="choose(option)"
      >
        {{ optionLabel(option) }}
      </button>
      <button
        v-if="remaining !== undefined || label !== undefined"
        class="sleep-timer__option sleep-timer__option--danger"
        data-testid="sleep-timer-cancel"
        @click="cancel"
      >
        取消
      </button>
    </div>
  </div>
</template>
