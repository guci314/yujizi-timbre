import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SleepTimerButton from './SleepTimerButton.vue'
import { SLEEP_TIMER_OPTIONS } from '../player/sleep'

describe('SleepTimerButton', () => {
  it('shows the sleep timer choices when opened', async () => {
    const wrapper = mount(SleepTimerButton, {
      props: {
        remaining: undefined,
        active: undefined,
        onStart: () => {},
        onCancel: () => {},
      },
    })

    expect(wrapper.find('[data-testid="sleep-timer-menu"]').exists()).toBe(false)

    await wrapper.find('[data-testid="sleep-timer-toggle"]').trigger('click')

    const menu = wrapper.find('[data-testid="sleep-timer-menu"]')
    expect(menu.exists()).toBe(true)
    expect(menu.findAll('button').length).toBe(SLEEP_TIMER_OPTIONS.length)
  })

  it('shows the time left when a timer runs', () => {
    const wrapper = mount(SleepTimerButton, {
      props: {
        remaining: 754,
        active: SLEEP_TIMER_OPTIONS[2],
        onStart: () => {},
        onCancel: () => {},
      },
    })

    expect(wrapper.find('[data-testid="sleep-timer-toggle"]').text()).toContain('12:34')
  })

  it('offers to cancel a running timer', async () => {
    let cancelled = false
    const wrapper = mount(SleepTimerButton, {
      props: {
        remaining: 60,
        active: SLEEP_TIMER_OPTIONS[0],
        onStart: () => {},
        onCancel: () => {
          cancelled = true
        },
      },
    })

    await wrapper.find('[data-testid="sleep-timer-toggle"]').trigger('click')
    await wrapper.find('[data-testid="sleep-timer-cancel"]').trigger('click')

    expect(cancelled).toBe(true)
  })
})
