import { createRouter, createWebHashHistory } from 'vue-router'
import ShelfView from './views/ShelfView.vue'

/**
 * Hash history keeps deep links working when the app is served from a
 * sub-path such as `/app/`, which is how it is deployed next to the site.
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'shelf', component: ShelfView },
    {
      path: '/book/:slug',
      name: 'player',
      component: () => import('./views/PlayerView.vue'),
    },
    {
      path: '/bookmarks',
      name: 'bookmarks',
      component: () => import('./views/BookmarksView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
