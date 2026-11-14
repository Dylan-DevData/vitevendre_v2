import { api } from '../api.js';
import { UploadTask } from '../upload/upload-task.js';
import { h, formatBytes, formatEta, toast } from './dom.js';
import { icons } from './icons.js';

const PENDING_KEY = 'vv.pending';
const CIRCUMFERENCE = 2 * Math.PI * 18;
const ALLOWED = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];

const loadPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)); } catch (e) { return null; } };
const savePending = (value) => {
  try { if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value)); else localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignoré */ }
};

function ring() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('class', 'ring-svg');
  const track = document.createElementNS(ns, 'circle');
  const bar = document.createElementNS(ns, 'circle');
  [track, bar].forEach((c) => { c.setAttribute('cx', '22'); c.setAttribute('cy', '22'); c.setAttribute('r', '18'); });
  track.setAttribute('class', 'track'); bar.setAttribute('class', 'bar');
  bar.style.strokeDasharray = String(CIRCUMFERENCE);
  svg.append(track, bar);
  return { svg, bar };
}

// Envoi façon Telegram : une bulle persistante au-dessus de la barre d'onglets, avec anneau de
// progression, vitesse, temps restant, pause/reprise, annulation, et passage "traitement" ->
// "publiée" en direct (événements du serveur) sans rien rafraîchir.
export function createUploader({ onPublished, onViewProfile }) {
  let task = null;
  let lastFile = null;
  let pending = loadPending();
  let publishedVideoId = null;
  let pollTimer = null;
  let hideTimer = null;

  // ---------- Bulle ----------
  const r = ring();
  const iconSlot = h('span', { class: 'ring-icon' });
  const ringButton = h('button', { class: 'ring-btn', type: 'button' }, r.svg, iconSlot);
  const title = h('strong', { class: 'bubble-title' });
  const sub = h('span', { class: 'bubble-sub' });
  const action = h('button', { class: 'bubble-action hidden', type: 'button' });
  const closeButton = h('button', { class: 'bubble-close', type: 'button', 'aria-label': 'Annuler', icon: icons.close });
  const bubble = h('div', { class: 'bubble hidden', role: 'status', 'aria-live': 'polite' },
    ringButton, h('div', { class: 'bubble-text' }, title, sub), action, closeButton);

  const picker = h('input', { type: 'file', accept: 'video/*', class: 'hidden', 'aria-hidden': 'true' });

  function show({ heading, detail = '', fraction = 0, spin = false, glyph = icons.upload, button = null, closable = true, tone = '' }) {
    clearTimeout(hideTimer);
    bubble.className = `bubble ${tone}`;
    title.textContent = heading;
    sub.textContent = detail;
    r.bar.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, fraction))));
    ringButton.classList.toggle('spin', spin);
    iconSlot.innerHTML = glyph;
    action.classList.toggle('hidden', !button);
    if (button) { action.textContent = button.label; action.onclick = button.run; }
    closeButton.classList.toggle('hidden', !closable);
  }
  const hideBubble = () => { bubble.classList.add('hidden'); };

  // ---------- États de la tâche ----------
  function render(snap) {
    const fraction = snap.total ? snap.sent / snap.total : 0;
    const percent = Math.round(fraction * 100);
    const progress = `${formatBytes(snap.sent)} / ${formatBytes(snap.total)}`;
    switch (snap.state) {
      case 'hashing':
        return show({ heading: 'Préparation de la vidéo…', detail: 'Vérification du fichier', spin: true, glyph: icons.film });
      case 'uploading': {
        const speed = snap.speed ? `${formatBytes(snap.speed)}/s` : '';
        return show({
          heading: `Envoi de la vidéo · ${percent} %`,
          detail: [progress, speed, formatEta(snap.eta)].filter(Boolean).join(' · '),
          fraction, glyph: icons.pause,
        });
      }
      case 'waiting-network':
        return show({ heading: 'En attente du réseau…', detail: `${progress} · l’envoi reprendra tout seul`, fraction, spin: true, glyph: icons.upload, tone: 'warn' });
      case 'paused':
        return show({ heading: `En pause · ${percent} %`, detail: progress, fraction, glyph: icons.play });
      case 'processing':
        return show({ heading: 'Traitement de la vidéo…', detail: 'Création des qualités 240p → 1080p', fraction: 1, spin: true, glyph: icons.film, closable: false });
      case 'source-gone':
        return show({ heading: 'Fichier introuvable', detail: 'Il a été supprimé ou déplacé. Choisissez-le à nouveau pour reprendre.',
          fraction, glyph: icons.close, tone: 'error', button: { label: 'Choisir', run: () => picker.click() } });
      case 'mismatch':
        return show({ heading: 'Ce n’est pas le même fichier', detail: 'Choisissez la vidéo d’origine pour reprendre.',
          fraction, glyph: icons.close, tone: 'error', button: { label: 'Choisir', run: () => picker.click() } });
      case 'error':
        return show({ heading: 'Envoi interrompu', detail: snap.error || 'Une erreur est survenue.', fraction, glyph: icons.retry, tone: 'error',
          button: lastFile ? { label: 'Réessayer', run: () => begin(lastFile, pending && pending.caption, pending && pending.fingerprint) } : null });
      default:
    }
  }

  function begin(file, caption, expectedFingerprint = null) {
    lastFile = file;
    // La tâche émet ses états/progrès ; elle garde une seule tranche en mémoire à la fois.
    task = new UploadTask({ file, caption, api, expectedFingerprint });
    pending = { fileName: file.name, size: file.size, caption, fingerprint: expectedFingerprint, videoId: null };
    savePending(pending);
    const current = task;
    task.addEventListener('session', (event) => {
      pending.fingerprint = event.detail.fingerprint;
      pending.videoId = event.detail.videoId;
      savePending(pending);
    });
    task.addEventListener('state', (event) => { if (task === current) render(event.detail); });
    task.addEventListener('progress', (event) => { if (task === current) render(event.detail); });
    render(task.snapshot());
    task.start().then((result) => {
      if (!result || task !== current) return;
      publishedVideoId = result.videoId;
      watchProcessing(result.videoId);
    }).catch(() => { /* l'état d'erreur est déjà affiché par la bulle */ });
  }

  // Filet de sécurité si le flux temps réel est coupé : on interroge le serveur toutes les 4 s.
  function watchProcessing(videoId) {
    clearInterval(pollTimer);
    // Secours au WebSocket : demande le statut au backend si un événement temps réel a été perdu.
    pollTimer = setInterval(async () => {
      try {
        const { video } = await api.getVideo(videoId);
        if (video.status === 'ready') handleEvent('video.ready', { videoId, renditions: video.renditions });
        else if (video.status === 'failed') handleEvent('video.failed', { videoId });
      } catch (error) { /* réseau absent : on réessaie */ }
    }, 4000);
  }

  // Événements temps réel (SSE) poussés par le serveur.
  // Les événements video.ready/failed font passer la bulle de « traitement » à son résultat.
  function handleEvent(name, data) {
    if (data.videoId !== publishedVideoId && !(pending && data.videoId === pending.videoId)) return;
    if (name === 'video.ready') {
      clearInterval(pollTimer);
      savePending(null); pending = null; task = null;
      show({ heading: 'Vidéo publiée', detail: `Qualités prêtes : ${(data.renditions || []).join(', ')}`, fraction: 1, glyph: icons.check, tone: 'ok',
        button: { label: 'Voir', run: () => { hideBubble(); onViewProfile(); } } });
      hideTimer = setTimeout(hideBubble, 9000);
      onPublished();
    } else if (name === 'video.renditions' && bubble.classList.contains('ok')) {
      sub.textContent = `Qualités prêtes : ${data.renditions.join(', ')}`;
    } else if (name === 'video.failed') {
      clearInterval(pollTimer);
      savePending(null); pending = null; task = null;
      show({ heading: 'Traitement impossible', detail: 'La vidéo n’a pas pu être convertie. Essayez un autre fichier.', glyph: icons.close, tone: 'error' });
    }
  }

  // ---------- Interactions de la bulle ----------
  ringButton.addEventListener('click', () => {
    if (!task) return;
    if (task.state === 'paused') task.resume();
    else task.pause();
  });
  closeButton.addEventListener('click', async () => {
    if (task && !['processing'].includes(task.state)) await task.cancel();
    savePending(null); pending = null; task = null; lastFile = null;
    hideBubble();
  });
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';
    if (file && pending) begin(file, pending.caption, pending.fingerprint);
  });

  // ---------- Fenêtre de création (+) ----------
  let chosen = null;
  let previewUrl = null;
  // Le navigateur/Cordova retourne un objet File qui référence le média sélectionné ;
  // on garde cette référence, on ne copie pas toute la vidéo dans une variable JS.
  const input = h('input', { type: 'file', accept: 'video/*', class: 'hidden', 'aria-hidden': 'true' });
  const pickButton = h('button', { class: 'pick', type: 'button' }, h('span', { icon: icons.film }), h('span', {}, 'Choisir une vidéo'));
  const preview = h('div', { class: 'preview hidden' });
  const caption = h('textarea', { class: 'caption-input', rows: '3', maxlength: '300', placeholder: 'Écrivez une légende…' });
  const publish = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Publier');
  const cancel = h('button', { class: 'btn secondary', type: 'button' }, 'Annuler');
  const sheet = h('div', { class: 'sheet hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Nouvelle vidéo' },
    h('div', { class: 'sheet-backdrop' }),
    h('div', { class: 'sheet-panel' },
      h('div', { class: 'sheet-grip' }),
      h('h2', {}, 'Nouvelle vidéo'),
      pickButton, preview, caption,
      h('p', { class: 'hint' }, 'L’envoi se fait par petits morceaux : une coupure réseau ne perd rien, il reprend là où il s’est arrêté.'),
      h('div', { class: 'sheet-buttons' }, cancel, publish)));

  function closeSheet() {
    sheet.classList.add('hidden');
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    chosen = null; preview.replaceChildren(); preview.classList.add('hidden');
    caption.value = ''; publish.disabled = true; pickButton.classList.remove('hidden');
  }
  pickButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    // Le sélecteur système remet le File ici. Sa taille/type sont des métadonnées du fichier.
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.type && !ALLOWED.includes(file.type)) { toast('Format non pris en charge (MP4, MOV, WebM ou 3GP).'); return; }
    chosen = file;
    // URL.createObjectURL référence le fichier local pour l'aperçu, sans le convertir en Base64.
    previewUrl = URL.createObjectURL(file);
    preview.replaceChildren(
      h('video', { src: previewUrl, muted: true, playsinline: true, preload: 'metadata' }),
      h('div', { class: 'preview-info' }, h('b', {}, file.name || 'video'), h('span', {}, formatBytes(file.size))));
    preview.classList.remove('hidden');
    pickButton.classList.add('hidden');
    publish.disabled = false;
  });
  cancel.addEventListener('click', closeSheet);
  sheet.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);
  publish.addEventListener('click', () => {
    if (!chosen) return;
    // Passe la référence File à UploadTask : elle lira plus tard des plages avec file.slice().
    const file = chosen; const text = caption.value.trim();
    closeSheet();
    begin(file, text);
  });

  // Après un redémarrage de l'app : on montre l'envoi interrompu et on propose de reprendre.
  function showInterrupted() {
    if (!pending || task) return;
    show({ heading: 'Envoi interrompu', detail: `${pending.fileName} · choisissez à nouveau la vidéo pour reprendre`, glyph: icons.upload, tone: 'warn',
      button: { label: 'Reprendre', run: () => picker.click() } });
  }

  return {
    elements: [bubble, sheet, picker, input],
    openComposer() {
      if (task && !['error', 'source-gone', 'mismatch', 'cancelled'].includes(task.state)) { toast('Un envoi est déjà en cours.'); return; }
      sheet.classList.remove('hidden');
    },
    handleEvent,
    showInterrupted,
  };
}
