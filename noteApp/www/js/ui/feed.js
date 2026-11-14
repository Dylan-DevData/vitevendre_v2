import { api } from '../api.js';
import { attach } from '../player.js';
import { h, timeAgo, formatCount, toast } from './dom.js';
import { icons } from './icons.js';
import { createSeekBar, createTapFeedback } from './player-controls.js';
import { createFollowButton } from './follow-button.js';

// Accueil façon Instagram : cartes avec la vidéo qui démarre (muette) quand elle est
// visible, bouton J'aime, commentaires, auteur touchable (profil) avec bouton « Suivre »,
// légende, et pastille "Nouvelles vidéos" alimentée en temps réel.
// Les compteurs de J'aime et de commentaires se mettent à jour en direct.
export function createFeed({ onOpenReels, onOpenUser, comments, realtime }) {
  const el = h('div', { class: 'view feed-view' });
  const list = h('div', { class: 'feed-list' });
  const sentinel = h('div', { class: 'sentinel' });
  const empty = h('div', { class: 'empty hidden' },
    h('div', { class: 'empty-icon', icon: icons.film }),
    h('p', { class: 'empty-title' }, 'Aucune vidéo pour le moment'),
    h('p', { class: 'empty-text' }, 'Touchez + pour publier la première.'));
  const pill = h('button', { class: 'new-pill hidden', type: 'button', onclick: () => refresh(true) }, 'Nouvelles vidéos');
  const status = h('div', { class: 'feed-status' });
  el.append(pill, list, empty, status, sentinel);

  let videos = [];
  let nextBefore = null;
  let loading = false;
  let finished = false;
  let muted = true;
  const controllers = new Map();
  const cardStats = new Map();   // id de vidéo -> fonction qui met à jour ses compteurs

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = entry.target.querySelector('video');
      if (!video) return;
      if (entry.intersectionRatio >= 0.6) start(video, entry.target);
      else if (!entry.isIntersecting) stop(video);
      else video.pause();
    });
  }, { root: el, threshold: [0, 0.6] });

  const moreObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) load();
  }, { root: el, rootMargin: '600px' });
  moreObserver.observe(sentinel);

  function start(video, card) {
    if (!controllers.has(video)) {
      const badge = card.querySelector('.quality-badge');
      controllers.set(video, attach(video, video.dataset.hls, {
        onLevel: (name) => { badge.textContent = name; },
        onFatal: () => stop(video),
      }));
    }
    video.muted = muted;
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }

  function stop(video) {
    video.pause();
    const controller = controllers.get(video);
    if (controller) { controller.destroy(); controllers.delete(video); }
  }

  function card(video, index) {
    const media = h('video', {
      playsinline: true, loop: true, muted: true, preload: 'none',
      poster: video.posterUrl ? api.base + video.posterUrl : null,
      // L'URL vient du backend et désigne la playlist HLS, pas un gros fichier MP4 à télécharger.
      'data-hls': api.base + video.hlsUrl,
    });
    media.muted = true;
    const soundButton = h('button', { class: 'media-btn sound', type: 'button', 'aria-label': 'Son', icon: icons.mute });
    soundButton.addEventListener('click', (event) => {
      event.stopPropagation();
      muted = !muted;
      list.querySelectorAll('video').forEach((v) => { v.muted = muted; });
      list.querySelectorAll('.sound').forEach((b) => { b.innerHTML = muted ? icons.mute : icons.volume; });
    });
    const badge = h('span', { class: 'quality-badge' });

    // Toucher simple = pause / lecture, avec une fine barre de progression non interactive.
    const feedback = createTapFeedback();
    const seek = createSeekBar(media, { interactive: false });
    media.addEventListener('play', () => feedback.setPaused(false));
    const mediaBox = h('div', { class: 'post-media' }, media, badge, soundButton, feedback.el, seek.el);
    mediaBox.addEventListener('click', () => {
      if (media.paused) { media.play().catch(() => {}); feedback.flash('play'); }
      else { media.pause(); feedback.flash('pause'); feedback.setPaused(true); }
    });

    const likeLabel = (n) => (n ? `${formatCount(n)} J’aime` : 'Soyez le premier à aimer');
    const commentLabel = (n) => (n ? `Voir les ${formatCount(n)} commentaires` : 'Ajouter un commentaire…');
    const likeCount = h('span', { class: 'like-count' }, likeLabel(video.likeCount));
    const commentsLink = h('button', { class: 'comments-link', type: 'button' }, commentLabel(video.commentCount || 0));
    const openComments = () => comments.open(video, { onCount: (n) => applyStats({ commentCount: n }) });
    commentsLink.addEventListener('click', openComments);
    const commentButton = h('button', { class: 'act', type: 'button', 'aria-label': 'Commentaires', icon: icons.comment, onclick: openComments });

    function applyStats(stats) {
      if (typeof stats.likeCount === 'number') { video.likeCount = stats.likeCount; likeCount.textContent = likeLabel(stats.likeCount); }
      if (typeof stats.commentCount === 'number') { video.commentCount = stats.commentCount; commentsLink.textContent = commentLabel(stats.commentCount); }
    }
    cardStats.set(video.id, applyStats);
    const likeButton = h('button', { class: `act like${video.likedByMe ? ' on' : ''}`, type: 'button', 'aria-label': 'J’aime',
      icon: video.likedByMe ? icons.heartFill : icons.heart });
    likeButton.addEventListener('click', async () => {
      const liked = !likeButton.classList.contains('on');
      likeButton.classList.toggle('on', liked);
      likeButton.innerHTML = liked ? icons.heartFill : icons.heart;
      try {
        const result = liked ? await api.like(video.id) : await api.unlike(video.id);
        video.likeCount = result.likeCount;
        video.likedByMe = liked;
        likeCount.textContent = likeLabel(result.likeCount);
      } catch (error) {
        likeButton.classList.toggle('on', !liked);
        likeButton.innerHTML = !liked ? icons.heartFill : icons.heart;
        toast(error.network ? 'Réseau indisponible.' : error.message);
      }
    });

    const initial = (video.author.name || '?').trim().charAt(0).toUpperCase();
    return h('article', { class: 'post', 'data-id': video.id },
      h('header', { class: 'post-head' },
        h('button', { class: 'post-who', type: 'button', onclick: () => onOpenUser(video.author.id, video.author.name) },
          h('div', { class: 'avatar ring' }, h('span', {}, initial)),
          h('div', { class: 'post-author' }, video.author.name)),
        createFollowButton(video.author, { className: 'follow-btn' })),
      mediaBox,
      h('div', { class: 'post-actions' }, likeButton, commentButton,
        h('button', { class: 'act', type: 'button', 'aria-label': 'Plein écran', icon: icons.expand,
          onclick: () => onOpenReels(videos, index) })),
      likeCount,
      video.caption ? h('p', { class: 'caption' }, h('b', {}, video.author.name), ' ', video.caption) : null,
      commentsLink,
      h('time', { class: 'when' }, timeAgo(video.createdAt)));
  }

  function render(newVideos, startIndex) {
    newVideos.forEach((video, i) => {
      const node = card(video, startIndex + i);
      list.append(node);
      observer.observe(node);
    });
    empty.classList.toggle('hidden', videos.length > 0);
  }

  async function load() {
    if (loading || finished) return;
    loading = true;
    status.textContent = videos.length ? 'Chargement…' : '';
    try {
      const page = await api.feed({ before: nextBefore, limit: 6 });
      const start = videos.length;
      videos = videos.concat(page.videos);
      nextBefore = page.nextBefore;
      finished = !page.nextBefore;
      render(page.videos, start);
      status.textContent = '';
    } catch (error) {
      status.textContent = error.network ? 'Réseau indisponible — nouvel essai dans un instant…' : error.message;
      setTimeout(() => { loading = false; load(); }, 4000);
      return;
    }
    loading = false;
  }

  async function refresh(scrollTop = false) {
    controllers.forEach((controller, video) => stop(video));
    list.replaceChildren();
    cardStats.clear();
    videos = []; nextBefore = null; finished = false; loading = false;
    pill.classList.add('hidden');
    if (scrollTop) el.scrollTo({ top: 0 });
    await load();
  }

  // Temps réel : compteurs de la carte concernée.
  realtime.on('video.stats', (data) => {
    const update = cardStats.get(data.videoId);
    if (update) update(data);
  });

  return {
    el,
    getVideos: () => videos,
    refresh,
    load,
    onShow() { load(); },
    onHide() { controllers.forEach((controller, video) => video.pause()); },
    // Temps réel : une vidéo vient d'être publiée.
    notifyNew() {
      if (el.scrollTop < 120) refresh();
      else pill.classList.remove('hidden');
    },
  };
}
