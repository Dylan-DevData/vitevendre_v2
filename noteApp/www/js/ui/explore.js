import { api } from '../api.js';
import { h } from './dom.js';
import { icons } from './icons.js';

// Explorer : grille 3 colonnes des vidéos récentes ; toucher ouvre le Reels à cet endroit.
export function createExplore({ onOpenReels }) {
  const el = h('div', { class: 'view explore-view' });
  const grid = h('div', { class: 'grid' });
  const status = h('div', { class: 'feed-status' });
  const sentinel = h('div', { class: 'sentinel' });
  el.append(h('div', { class: 'search-box' }, h('span', { icon: icons.search }), h('span', {}, 'Vidéos récentes')), grid, status, sentinel);
  let videos = []; let next = null; let loading = false; let finished = false;

  async function load() {
    if (loading || finished) return;
    loading = true;
    try {
      const page = await api.feed({ before: next, limit: 18 });
      page.videos.forEach((video) => {
        const index = videos.length;
        videos.push(video);
        grid.append(h('button', { class: 'tile', type: 'button', onclick: () => onOpenReels(videos, index), 'aria-label': video.caption || 'Vidéo' },
          video.posterUrl ? h('img', { src: api.base + video.posterUrl, alt: '', loading: 'lazy' }) : null));
      });
      next = page.nextBefore; finished = !page.nextBefore; status.textContent = '';
    } catch (error) {
      status.textContent = error.network ? 'Réseau indisponible…' : error.message;
    }
    loading = false;
  }
  new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) load(); }, { root: el, rootMargin: '400px' }).observe(sentinel);

  return {
    el,
    onShow() { load(); },
    onHide() {},
    reset() { grid.replaceChildren(); videos = []; next = null; finished = false; load(); },
  };
}
