import { api } from '../api.js';
import { h, formatCount, toast } from './dom.js';
import { icons } from './icons.js';
import { createFollowButton } from './follow-button.js';

// Profil public d'un autre utilisateur : en-tête, bouton « Suivre », grille de ses vidéos.
// Les compteurs d'abonnés se mettent à jour en direct (événement « user.stats »).
export function createUserProfile({ realtime, onOpenReels, onBack }) {
  const el = h('div', { class: 'view user-view' });
  let profile = null;
  let videos = [];
  let requestId = 0;
  let nameHint = '';
  const statNodes = {};

  const stat = (key, label) => {
    statNodes[key] = h('b', {}, '0');
    return h('div', {}, statNodes[key], h('span', {}, label));
  };

  function paintStats() {
    if (!profile) return;
    statNodes.videos.textContent = formatCount(videos.length);
    statNodes.followers.textContent = formatCount(profile.followerCount);
    statNodes.following.textContent = formatCount(profile.followingCount);
  }

  function render() {
    const name = profile ? profile.name : nameHint;
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const followButton = profile && !profile.isMe
      ? createFollowButton({ id: profile.id, followedByMe: profile.followedByMe }, {
        className: 'btn follow-btn big',
        onResult: (result) => { profile.followerCount = result.followerCount; paintStats(); },
      })
      : null;
    const grid = h('div', { class: 'grid' }, videos.map((video, index) => h('button', {
      class: 'tile', type: 'button', 'aria-label': video.caption || 'Vidéo', onclick: () => onOpenReels(videos, index),
    }, video.posterUrl ? h('img', { src: api.base + video.posterUrl, alt: '', loading: 'lazy' }) : null)));

    // replaceChildren écrirait « null » en texte : on retire les éléments absents.
    el.replaceChildren(...[
      h('div', { class: 'user-top' },
        h('button', { class: 'top-btn', type: 'button', 'aria-label': 'Retour', icon: icons.back, onclick: onBack }),
        h('b', {}, name)),
      h('div', { class: 'profile-head' },
        h('div', { class: 'avatar big ring' }, h('span', {}, initial)),
        h('div', { class: 'stats' }, stat('videos', 'vidéos'), stat('followers', 'abonnés'), stat('following', 'abonnements'))),
      h('div', { class: 'profile-name' }, name),
      followButton,
      profile && videos.length ? grid : null,
      profile && !videos.length ? h('p', { class: 'empty-text center' }, 'Aucune vidéo publiée.') : null,
    ].filter(Boolean));
    paintStats();
  }

  async function open(userId, name = '') {
    const mine = ++requestId;
    nameHint = name; profile = null; videos = [];
    render();
    try {
      const [{ user }, page] = await Promise.all([api.profile(userId), api.feed({ author: userId, limit: 30 })]);
      if (mine !== requestId) return;   // l'utilisateur a changé d'écran entre-temps
      profile = user; videos = page.videos;
      render();
    } catch (error) {
      if (mine !== requestId) return;
      toast(error.network ? 'Réseau indisponible.' : error.message);
    }
  }

  // Temps réel : nouveaux abonnés, nouvelle vidéo publiée par cette personne.
  realtime.on('user.stats', (data) => {
    if (profile && data.userId === profile.id) { profile.followerCount = data.followerCount; paintStats(); }
  });
  realtime.on('feed.new', () => {
    if (!profile || !el.classList.contains('active')) return;
    api.feed({ author: profile.id, limit: 30 }).then((page) => {
      if (page.videos.length !== videos.length) { videos = page.videos; render(); }
    }).catch(() => {});
  });

  return { el, open, onShow() {}, onHide() { requestId += 1; } };
}
