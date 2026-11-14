import { api, session } from './api.js';
import { createRealtime } from './services/realtime.js';
import { social } from './services/social.js';
import { subscribeNetwork } from './services/network.js';
import { createAuth } from './ui/auth.js';
import { createFeed } from './ui/feed.js';
import { createExplore } from './ui/explore.js';
import { createReels } from './ui/reels.js';
import { createProfile } from './ui/profile.js';
import { createUserProfile } from './ui/user-profile.js';
import { createComments } from './ui/comments.js';
import { createUploader } from './ui/upload-ui.js';
import { h, toast } from './ui/dom.js';
import { icons } from './ui/icons.js';

const root = document.getElementById('root');
let realtime = null;
let stopNetwork = () => {};

function showAuth() {
  if (realtime) realtime.close();
  social.reset();
  stopNetwork();
  document.body.classList.remove('reels-mode');
  root.replaceChildren(createAuth({ onSuccess: showApp }).el);
}

function showApp() {
  let current = null;
  let lastTab = 'home';   // écran où revenir depuis un profil public
  let uploader;

  // Temps réel (WebSocket) : une seule connexion pour toute l'application.
  if (realtime) realtime.close();
  social.reset();
  realtime = createRealtime();
  const live = realtime;

  // Fenêtre de commentaires partagée par le fil et les Reels.
  const comments = createComments({ realtime: live, onOpenUser: (id, name) => openUser(id, name) });

  const feed = createFeed({ onOpenReels: (list, index) => openReels(list, index, 'feed'), onOpenUser: (id, name) => openUser(id, name), comments, realtime: live });
  const explore = createExplore({ onOpenReels: (list, index) => openReels(list, index, 'feed') });
  const reels = createReels({ realtime: live, comments, onOpenUser: (id, name) => openUser(id, name) });
  const profile = createProfile({
    onOpenReels: (list, index) => openReels(list, index, 'none'),
    onLogout: () => { live.close(); session.clear(); showAuth(); },
    realtime: live,
  });
  const userView = createUserProfile({
    realtime: live,
    onOpenReels: (list, index) => openReels(list, index, 'none'),
    onBack: () => show(lastTab),
  });
  const views = { home: feed, explore, reels, profile, user: userView };

  // Ouvre le profil public d'un auteur (son propre profil : onglet Profil).
  function openUser(id, name) {
    comments.close();
    if (session.user && session.user.id === id) { show('profile'); return; }
    userView.open(id, name);
    show('user');
  }

  // Suite du défilement : global pour fil/explorer, rien pour le profil (liste fermée).
  const moreFromFeed = async (last) => {
    if (!last) return [];
    return (await api.feed({ before: last.id, limit: 8 })).videos;
  };
  function openReels(list, index, source) {
    reels.setList(list, index, source === 'feed' ? moreFromFeed : null);
    show('reels');
  }

  uploader = createUploader({
    onPublished: () => { feed.refresh(); profile.reload(); explore.reset(); },
    onViewProfile: () => show('profile'),
  });

  const offline = h('div', { class: 'offline hidden', role: 'status' }, 'Hors connexion');
  const topbar = h('header', { class: 'topbar' },
    h('h1', { class: 'brand' }, 'ViteVendre'),
    h('button', { class: 'top-btn', type: 'button', 'aria-label': 'Nouvelle vidéo', icon: icons.plus, onclick: () => uploader.openComposer() }));

  const tabs = [
    ['home', icons.home, 'Accueil'],
    ['explore', icons.search, 'Explorer'],
    ['add', icons.plus, 'Créer'],
    ['reels', icons.reels, 'Reels'],
    ['profile', icons.user, 'Profil'],
  ].map(([name, icon, label]) => h('button', { class: 'tab', type: 'button', 'data-tab': name, 'aria-label': label, icon,
    onclick: () => (name === 'add' ? uploader.openComposer() : show(name)) }));
  const tabbar = h('nav', { class: 'tabbar' }, tabs);
  const stage = h('main', { class: 'stage' }, Object.values(views).map((view) => view.el));

  root.replaceChildren(h('div', { class: 'app' }, offline, topbar, stage, uploader.elements[0], tabbar), ...uploader.elements.slice(1));

  async function show(name) {
    if (current === name) { if (name === 'home') feed.el.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (current) views[current].onHide();
    if (current && current !== 'user') lastTab = current;
    current = name;
    comments.close();
    Object.entries(views).forEach(([key, view]) => view.el.classList.toggle('active', key === name));
    tabs.forEach((tab) => tab.classList.toggle('on', tab.dataset.tab === name));
    document.body.classList.toggle('reels-mode', name === 'reels');
    topbar.classList.toggle('hidden', name === 'reels');
    if (name === 'reels' && !reels.hasVideos()) {
      const list = feed.getVideos().length ? feed.getVideos() : (await api.feed({ limit: 8 }).catch(() => ({ videos: [] }))).videos;
      reels.setList(list, 0, moreFromFeed);
    }
    views[name].onShow();
  }

  // Événements poussés par le serveur : vidéo prête / publiée, nouvel abonné.
  // (Les compteurs, commentaires et profils s'abonnent eux-mêmes dans leurs modules.)
  // Relie les événements du WebSocket à la bulle d'upload et à l'actualisation du fil.
  live.on('video.ready', (data) => uploader.handleEvent('video.ready', data));
  live.on('video.renditions', (data) => uploader.handleEvent('video.renditions', data));
  live.on('video.failed', (data) => uploader.handleEvent('video.failed', data));
  live.on('feed.new', () => feed.notifyNew());
  live.on('follow.new', (data) => toast(`${data.follower.name} s’est abonné à vous`));
  live.connect();

  stopNetwork();
  stopNetwork = subscribeNetwork((snapshot) => offline.classList.toggle('hidden', snapshot.online));

  show('home');
  uploader.showInterrupted();
}

window.addEventListener('vv:logout', showAuth);
if (session.token) showApp(); else showAuth();
