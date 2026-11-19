import { api } from '../api.js';
import { UploadQueue } from '../upload/upload-queue.js';
import { pickAndroidVideos, isNativeAndroid, releaseAndroidUri } from '../upload/native-video-source.js';
import { h, formatBytes, toast } from './dom.js';

const labels = {
  queued: 'En attente', hashing: 'Vérification', 'checking-source': 'Vérification', 'reading-chunk': 'Lecture du morceau', uploading: 'Envoi', 'waiting-network': 'Attente réseau',
  paused: 'En pause', processing: 'Traitement', missing_file: 'Fichier absent', inaccessible_file: 'Accès perdu',
  mismatch: 'Fichier différent', moved_file: 'Fichier déplacé', error: 'Erreur', needs_selection: 'À resélectionner',
};
const terminalStates = new Set(['missing_file', 'inaccessible_file', 'moved_file', 'mismatch']);

function terminalMessage(item) {
  const name = `"${item.name}"`;
  if (item.state === 'missing_file') return `La vidéo ${name} a été supprimée ou n'est plus accessible à son emplacement d'origine. L'envoi a été interrompu. Sélectionnez une autre vidéo pour publier.`;
  if (item.state === 'moved_file') return `La vidéo ${name} a été déplacée et son accès d'origine n'est plus valide. L'envoi a été interrompu. Sélectionnez une autre vidéo pour publier.`;
  if (item.state === 'mismatch') return `La vidéo ${name} a été modifiée ou remplacée. L'envoi a été interrompu pour éviter d'envoyer un autre fichier.`;
  return `La vidéo ${name} n'est plus accessible depuis ViteVendre. L'envoi a été interrompu. Sélectionnez une autre vidéo pour publier.`;
}
function terminalLabel(item) {
  if (item.state === 'missing_file') return 'Vidéo supprimée ou inaccessible';
  if (item.state === 'moved_file') return 'Vidéo déplacée ou inaccessible';
  if (item.state === 'mismatch') return 'Vidéo modifiée ou remplacée';
  return 'Vidéo inaccessible';
}

export function createQueuedUploader({ onPublished, onViewProfile }) {
  const maxUploads = Number(localStorage.getItem('vv.uploadConcurrency')) || 2;
  const queue = new UploadQueue({ api, concurrency: Math.min(5, Math.max(1, maxUploads)) });
  const list = h('div', { class: 'upload-queue' });
  const addButton = h('button', { class: 'queue-add', type: 'button' }, '+ Ajouter des vidéos');
  const concurrency = h('select', { class: 'queue-concurrency', 'aria-label': 'Nombre maximal d’envois simultanés' },
    ...[1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), selected: n === queue.concurrency }, `${n} envoi${n > 1 ? 's' : ''} à la fois`)));
  const webPicker = h('input', { type: 'file', accept: 'video/*', multiple: true, class: 'hidden', 'aria-hidden': 'true' });
  let published = false;
  const panel = h('section', { class: 'queue-panel', 'aria-label': 'File des envois' }, h('div', { class: 'queue-toolbar' }, addButton, concurrency), list);
  const veil = h('div', { class: 'queue-veil hidden' });
  const previousStates = new Map();
  const card = (item) => {
    const terminal = terminalStates.has(item.state);
    const progress = item.total ? Math.min(100, Math.round(100 * item.sent / item.total)) : 0;
    const progressBar = terminal ? null : h('progress', { max: 100, value: progress, 'aria-label': `${progress}%` });
    const state = terminal ? terminalLabel(item) : (labels[item.state] || item.state);
    const detail = h('small', {}, terminal ? `${state} · ${terminalMessage(item)}` : `${progress}% · ${formatBytes(item.sent)} / ${formatBytes(item.total)} · ${state}${item.speed ? ` · ${formatBytes(item.speed)}/s` : ''}${item.error ? ` · ${item.error}` : ''}`);
    const controls = h('div', { class: 'queue-controls' });
    if (terminal) {
      controls.append(h('button', { type: 'button', class: 'danger-text', onclick: () => removeJob(item.id) }, 'Retirer'));
    } else if (item.state !== 'processing') {
      controls.append(h('button', { type: 'button', 'aria-label': 'Monter', onclick: () => queue.move(item.id, -1) }, '↑'));
      controls.append(h('button', { type: 'button', 'aria-label': 'Descendre', onclick: () => queue.move(item.id, 1) }, '↓'));
      const retryable = ['error', 'queued', 'paused'].includes(item.state);
      controls.append(h('button', { type: 'button', onclick: () => retryable ? queue.resume(item.id) : queue.pause(item.id) }, retryable ? 'Reprendre' : 'Pause'));
      controls.append(h('button', { type: 'button', class: 'danger-text', onclick: () => cancelJob(item.id) }, 'Annuler'));
    }
    return h('article', { class: `queue-item${terminal ? ' queue-item-terminal' : ''}` }, h('strong', {}, item.name), detail, progressBar, controls);
  };
  function render(items) { list.replaceChildren(...items.map(card)); panel.classList.toggle('hidden', items.length === 0); }
  queue.addEventListener('change', (e) => {
    for (const item of e.detail) {
      const previous = previousStates.get(item.id);
      if (previous !== item.state) {
        if (terminalStates.has(item.state)) toast(terminalMessage(item));
      }
      previousStates.set(item.id, item.state);
    }
    render(e.detail);
  });
  async function cancelJob(id) {
    try { await queue.cancel(id); toast('Envoi annulé.'); }
    catch (error) { toast(`Annulation impossible : ${error.message}`); }
  }
  async function removeJob(id) {
    await queue.removeTerminal(id);
  }
  async function choose() {
    try {
      if (isNativeAndroid()) {
        const files = await pickAndroidVideos();
        for (const file of files) await queue.add(file);
      } else webPicker.click();
    } catch (error) { if (error.code !== 'PICKER_CANCELLED') toast(error.message); }
  }
  addButton.addEventListener('click', choose);
  concurrency.addEventListener('change', () => {
    queue.concurrency = Math.min(5, Math.max(1, Number(concurrency.value) || 2));
    localStorage.setItem('vv.uploadConcurrency', String(queue.concurrency));
    queue.pump();
  });
  webPicker.addEventListener('change', async () => {
    for (const file of [...(webPicker.files || [])]) await queue.add(file);
    webPicker.value = '';
  });
  const ready = queue.ready.then(async () => {
    render(queue.snapshot());
    // Le dernier morceau ne suffit pas : seule la confirmation finale du backend valide la publication.
    for (const item of queue.snapshot().filter((x) => x.state === 'processing')) watch(item.id);
  });
  const timers = new Map();
  function watch(id) {
    const job = queue.jobs.get(id);
    if (!job?.meta.videoId || timers.has(id)) return;
    const timer = setInterval(async () => {
      try {
        const { video } = await api.getVideo(job.meta.videoId);
        if (video.status === 'ready') handleEvent('video.ready', { videoId: job.meta.videoId, renditions: video.renditions });
        else if (video.status === 'failed') handleEvent('video.failed', { videoId: job.meta.videoId });
      } catch { /* Nouvelle tentative lorsque la connexion revient. */ }
    }, 4000);
    timers.set(id, timer);
  }
  queue.addEventListener('change', (e) => e.detail.filter((x) => x.state === 'processing').forEach((x) => watch(x.id)));
  function handleEvent(name, data) {
    const job = [...queue.jobs.values()].find((j) => Number(j.meta.videoId) === Number(data.videoId));
    if (!job) return;
    if (name === 'video.ready') {
      clearInterval(timers.get(job.meta.id)); timers.delete(job.meta.id);
      queue.complete(data.videoId).then(() => { published = true; onPublished(); toast('Vidéo publiée.'); });
    } else if (name === 'video.failed') {
      clearInterval(timers.get(job.meta.id)); timers.delete(job.meta.id);
      job.state = 'error'; job.error = 'Le traitement serveur a échoué. La session reste conservée.';
      queue.save(job);
    }
  }
  return {
    elements: [panel, webPicker], ready,
    openComposer: choose,
    handleEvent,
    showInterrupted() { render(queue.snapshot()); },
  };
}
