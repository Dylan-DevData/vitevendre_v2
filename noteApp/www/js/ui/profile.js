import { api, session } from '../api.js';
import { prefs } from '../player.js';
import { h, toast, formatCount } from './dom.js';

const LABELS = { processing: 'Traitement…', failed: 'Échec', uploading: 'Envoi…' };

// Profil : en-tête façon Instagram + grille de mes vidéos (avec leur état de traitement en direct).
export function createProfile({ onOpenReels, onLogout, realtime }) {
  const el = h('div', { class: 'view profile-view' });
  let videos = [];
  let counts = { followerCount: 0, followingCount: 0 };
  const followersNode = h('b', {}, '0');
  const followingNode = h('b', {}, '0');
  const paintCounts = () => {
    followersNode.textContent = formatCount(counts.followerCount);
    followingNode.textContent = formatCount(counts.followingCount);
  };

  function render() {
    const user = session.user || {};
    const initial = (user.fullName || '?').trim().charAt(0).toUpperCase();
    const saver = h('input', { type: 'checkbox', id: 'saver' });
    saver.checked = prefs.dataSaver;
    saver.addEventListener('change', () => {
      prefs.dataSaver = saver.checked;
      toast(saver.checked ? 'Économie de données : qualité limitée à 480p.' : 'Qualité automatique jusqu’à 1080p.');
    });
    const grid = h('div', { class: 'grid' }, videos.map((video, index) => h('button', {
      class: `tile${video.status !== 'ready' ? ' pending' : ''}`, type: 'button', 'data-id': video.id,
      onclick: () => (video.status === 'ready' ? onOpenReels(videos.filter((v) => v.status === 'ready'), videos.filter((v) => v.status === 'ready').indexOf(video)) : toast('Cette vidéo n’est pas encore prête.')),
    }, video.posterUrl ? h('img', { src: api.base + video.posterUrl, alt: '', loading: 'lazy' }) : null,
    LABELS[video.status] ? h('span', { class: `tile-badge ${video.status}` }, LABELS[video.status]) : null)));
    el.replaceChildren(
      h('div', { class: 'profile-head' },
        h('div', { class: 'avatar big ring' }, h('span', {}, initial)),
        h('div', { class: 'stats' },
          h('div', {}, h('b', {}, String(videos.filter((v) => v.status === 'ready').length)), h('span', {}, 'vidéos')),
          h('div', {}, followersNode, h('span', {}, 'abonnés')),
          h('div', {}, followingNode, h('span', {}, 'abonnements')))),
      h('div', { class: 'profile-name' }, user.fullName || ''),
      h('label', { class: 'switch-row', for: 'saver' }, h('span', {}, 'Économiser les données'), saver),
      h('button', { class: 'btn secondary', type: 'button', onclick: onLogout }, 'Se déconnecter'),
      videos.length ? grid : h('p', { class: 'empty-text center' }, 'Vous n’avez pas encore publié de vidéo.'));
    paintCounts();
  }

  async function load() {
    try {
      const page = await api.feed({ author: 'me', limit: 30 });
      videos = page.videos;
    } catch (error) { /* on garde l'affichage précédent */ }
    try {
      const me = session.user;
      if (me) counts = (await api.profile(me.id)).user;
    } catch (error) { /* compteurs précédents conservés */ }
    render();
  }

  // Temps réel : quelqu'un s'abonne (ou se désabonne) pendant que le profil est ouvert.
  realtime.on('user.stats', (data) => {
    const me = session.user;
    if (me && data.userId === me.id) { counts.followerCount = data.followerCount; paintCounts(); }
  });

  render();
  return { el, onShow: load, onHide() {}, reload: load };
}
