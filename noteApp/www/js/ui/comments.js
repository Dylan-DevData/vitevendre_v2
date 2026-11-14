import { api, session } from '../api.js';
import { h, timeAgo, toast } from './dom.js';
import { icons } from './icons.js';

const MAX_LENGTH = 500;

// Fenêtre de commentaires qui monte du bas (une seule instance réutilisée par Reels et fil).
//   const comments = createComments({ realtime, onOpenUser });
//   comments.open(video, { onCount });   // onCount(n) : nouveau total, pour mettre à jour le compteur affiché
// En direct : tant que la fenêtre est ouverte, le téléphone rejoint le salon « video:<id> » et reçoit
// les commentaires ajoutés / supprimés par les autres, sans rien recharger.
export function createComments({ realtime, onOpenUser }) {
  let sheet = null;
  let video = null;
  let items = [];
  let total = 0;
  let nextBefore = null;
  let loading = false;
  let sending = false;
  let onCount = () => {};
  let cleanups = [];
  let ui = null;

  const myId = () => (session.user ? session.user.id : null);
  const canDelete = (comment) => myId() !== null && (comment.author.id === myId() || (video && video.author.id === myId()));

  function setTotal(value) {
    total = Math.max(0, value);
    if (ui) ui.title.textContent = total ? `Commentaires (${total})` : 'Commentaires';
    onCount(total);
  }

  function renderItem(comment) {
    const initial = (comment.author.name || '?').trim().charAt(0).toUpperCase();
    const who = h('button', { class: 'cm-who', type: 'button', onclick: () => { close(); onOpenUser(comment.author.id); } },
      h('div', { class: 'avatar' }, h('span', {}, initial)));
    const del = canDelete(comment)
      ? h('button', { class: 'cm-del', type: 'button', 'aria-label': 'Supprimer le commentaire', icon: icons.trash, onclick: () => remove(comment) })
      : null;
    return h('li', { class: 'cm-item', 'data-id': comment.id }, who,
      h('div', { class: 'cm-main' },
        h('div', { class: 'cm-head' }, h('b', {}, comment.author.name), h('time', {}, timeAgo(comment.createdAt))),
        h('p', { class: 'cm-body' }, comment.body)),
      del);
  }

  function paint() {
    ui.list.replaceChildren(...items.map(renderItem));
    ui.empty.classList.toggle('hidden', items.length > 0 || loading);
    ui.more.classList.toggle('hidden', !nextBefore);
  }

  async function loadPage() {
    if (loading) return;
    loading = true; ui.more.disabled = true;
    try {
      const page = await api.comments(video.id, { before: nextBefore, limit: 20 });
      const known = new Set(items.map((c) => c.id));
      items = items.concat(page.comments.filter((c) => !known.has(c.id)));
      nextBefore = page.nextBefore;
      setTotal(page.total);
    } catch (error) {
      toast(error.network ? 'Réseau indisponible.' : error.message);
    }
    loading = false; ui.more.disabled = false;
    paint();
  }

  // Après une coupure du temps réel : on récupère la première page et on garde ce qu'on avait de plus ancien.
  async function refresh() {
    if (!video || loading) return;
    try {
      const page = await api.comments(video.id, { limit: 20 });
      const oldest = page.comments.length ? page.comments[page.comments.length - 1].id : 0;
      items = page.comments.concat(page.nextBefore ? items.filter((c) => c.id < oldest) : []);
      if (page.nextBefore && !nextBefore) nextBefore = page.nextBefore;
      setTotal(page.total);
      paint();
    } catch (error) { /* la prochaine reconnexion réessaiera */ }
  }

  function addLive(comment) {
    if (items.some((c) => c.id === comment.id)) return;   // déjà ajouté par notre propre envoi
    items.unshift(comment);
    paint();
  }

  async function remove(comment) {
    try {
      const result = await api.deleteComment(comment.id);
      items = items.filter((c) => c.id !== comment.id);
      setTotal(result.commentCount);
      paint();
    } catch (error) {
      toast(error.network ? 'Réseau indisponible.' : error.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const text = ui.input.value.trim();
    if (!text || sending) return;
    sending = true; ui.send.disabled = true;
    try {
      const result = await api.addComment(video.id, text);
      ui.input.value = '';
      addLive(result.comment);
      setTotal(result.commentCount);
      ui.scroller.scrollTop = 0;
    } catch (error) {
      toast(error.network ? 'Réseau indisponible.' : error.message);
    }
    sending = false; ui.send.disabled = false;
    ui.input.focus();
  }

  function build() {
    const title = h('h2', {}, 'Commentaires');
    const closeButton = h('button', { class: 'cm-close', type: 'button', 'aria-label': 'Fermer', icon: icons.close, onclick: () => close() });
    const list = h('ul', { class: 'cm-list' });
    const empty = h('p', { class: 'cm-empty hidden' }, 'Aucun commentaire. Lancez la discussion !');
    const more = h('button', { class: 'link cm-more hidden', type: 'button', onclick: loadPage }, 'Voir plus de commentaires');
    const scroller = h('div', { class: 'cm-scroll' }, list, empty, more);
    const input = h('input', { class: 'cm-input', type: 'text', maxlength: MAX_LENGTH, placeholder: 'Ajouter un commentaire…', autocomplete: 'off', enterkeyhint: 'send' });
    const send = h('button', { class: 'cm-send', type: 'submit', 'aria-label': 'Envoyer', icon: icons.send });
    const form = h('form', { class: 'cm-form' }, input, send);
    form.addEventListener('submit', submit);
    const backdrop = h('div', { class: 'sheet-backdrop', onclick: () => close() });
    const panel = h('div', { class: 'sheet-panel cm-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Commentaires' },
      h('div', { class: 'sheet-grip' }),
      h('div', { class: 'cm-top' }, title, closeButton),
      scroller, form);
    ui = { title, list, empty, more, scroller, input, send };
    return h('div', { class: 'sheet cm-sheet' }, backdrop, panel);
  }

  function onKey(event) { if (event.key === 'Escape') close(); }

  function open(target, options = {}) {
    if (sheet) close();
    video = target; items = []; nextBefore = null; loading = false; sending = false;
    onCount = options.onCount || (() => {});
    sheet = build();
    total = target.commentCount || 0;
    ui.title.textContent = total ? `Commentaires (${total})` : 'Commentaires';
    document.body.append(sheet);
    document.addEventListener('keydown', onKey);

    // Temps réel : salon de cette vidéo.
    const room = `video:${target.id}`;
    realtime.join(room);
    cleanups = [
      () => realtime.leave(room),
      realtime.on('comment.new', (data) => {
        if (!video || data.videoId !== video.id) return;
        addLive(data.comment); setTotal(data.commentCount);
      }),
      realtime.on('comment.deleted', (data) => {
        if (!video || data.videoId !== video.id) return;
        items = items.filter((c) => c.id !== data.commentId); setTotal(data.commentCount); paint();
      }),
      realtime.on('connection', (state) => { if (state.online && state.again) refresh(); }),
    ];
    loadPage();
  }

  function close() {
    if (!sheet) return;
    cleanups.forEach((fn) => fn());
    cleanups = [];
    document.removeEventListener('keydown', onKey);
    sheet.remove();
    sheet = null; video = null; ui = null; onCount = () => {};
  }

  return { open, close, isOpen: () => Boolean(sheet) };
}
