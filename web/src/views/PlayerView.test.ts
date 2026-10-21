import 'fake-indexeddb/auto'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'
import PlayerView from './PlayerView.vue'
import { player } from '../player/shared'
import { resetDownloadsState } from '../core/downloads-store'
import type { BookDetail } from '../core/domain'

const { book } = vi.hoisted(() => ({
  book: {
    slug: 'ddj',
    title: '道德经',
    pageUrl: 'https://www.yujizi.org/道德经.html',
    tracks: [{ name: '第01课前解说', url: 'https://www.yujizi.org/1.m4a' }],
  } satisfies BookDetail,
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { slug: 'ddj' }, name: 'player' }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

vi.mock('../core/library', () => ({
  useLibrary: () => ({ books: { value: [] }, loadBooks: vi.fn() }),
  useBookDetail: () => ({
    detail: shallowRef(book),
    loading: ref(false),
    error: ref<string>(),
    noAudio: ref(false),
    load: vi.fn(),
  }),
}))

describe('PlayerView', () => {
  it('offers the sleep timer in the player', async () => {
    resetDownloadsState()
    const wrapper = mount(PlayerView)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="sleep-timer-toggle"]').exists()).toBe(true)
  })

  it('starts a sleep timer through the player state', async () => {
    resetDownloadsState()
    const state = player()
    const wrapper = mount(PlayerView)
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="sleep-timer-toggle"]').trigger('click')
    const options = wrapper.findAll('.sleep-timer__option')
    expect(options.length).toBeGreaterThan(0)

    await options[0].trigger('click')
    expect(state.sleepTimer.value).toBeDefined()
    expect(state.sleepRemaining.value).toBe(5 * 60)
  })

  it('offers a 30 second jump on each side of the play button', async () => {
    resetDownloadsState()
    const wrapper = mount(PlayerView)
    await wrapper.vm.$nextTick()

    const back = wrapper.find('[data-testid="skip-back"]')
    const forward = wrapper.find('[data-testid="skip-forward"]')
    expect(back.exists()).toBe(true)
    expect(forward.exists()).toBe(true)
    expect(back.attributes('aria-label')).toContain('30')
    expect(forward.attributes('aria-label')).toContain('30')
  })

  it('jumps 30 seconds when the buttons are pressed', async () => {
    resetDownloadsState()
    const state = player()
    const wrapper = mount(PlayerView)
    await wrapper.vm.$nextTick()

    state.seek(100)
    await wrapper.find('[data-testid="skip-back"]').trigger('click')
    expect(state.currentTime.value).toBe(70)

    await wrapper.find('[data-testid="skip-forward"]').trigger('click')
    expect(state.currentTime.value).toBe(100)
  })
})
