import { h } from './dom.js';
import { icons } from './icons.js';

// Contrôles de lecture façon TikTok, réutilisables dans les Reels et dans le fil.
//   createSeekBar(media, options)  -> barre de progression (glissable ou non)
//   createTapFeedback()            -> icône ▶ / ⏸ au centre + petit ▶ quand la vidéo est en pause

const SEEK_THROTTLE_MS = 150; // pendant le glissement, on ne repositionne la vidéo que toutes les 150 ms (réseaux lents)

// 75 -> "01:15"
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Barre de progression.
 * options :
 *   interactive (true)  : false = fine ligne non interactive (fil d'accueil)
 *   onScrubChange(bool) : appelé au début / à la fin du glissement
 * Retourne { el, isScrubbing(), cancel({ resume }), reset(), destroy() }.
 */
export function createSeekBar(media, { interactive = true, onScrubChange = () => {} } = {}) {
  const buffered = h('i', { class: 'seek-buffered' });
  const fill = h('i', { class: 'seek-fill' });
  const thumb = h('i', { class: 'seek-thumb' });
  const track = h('div', { class: 'seek-track' }, buffered, fill, thumb);
  const hit = h('div', { class: 'seek' }, track);
  const timeLabel = interactive ? h('div', { class: 'seek-time' }) : null;
  const el = h('div', { class: `seek-layer${interactive ? '' : ' thin'}` }, timeLabel, hit);

  let scrubbing = false;
  let wasPlaying = false;
  let startTime = 0;
  let activePointer = null;
  let targetTime = 0;
  let lastSeekAt = 0;
  let rafId = 0;
  const listeners = [];

  // Durée connue ? (NaN / Infinity tant que le manifeste HLS n'est pas lu)
  const knownDuration = () => (Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0);

  function paintFill(ratio) {
    const r = Math.min(1, Math.max(0, ratio));
    fill.style.transform = `scaleX(${r})`;
    thumb.style.left = `${r * 100}%`;
  }

  // Partie déjà mise en mémoire (gris clair derrière la partie lue).
  function paintBuffered() {
    const duration = knownDuration();
    let end = 0;
    if (duration) {
      const ranges = media.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= media.currentTime + 0.5 && ranges.end(i) > end) end = ranges.end(i);
      }
    }
    buffered.style.transform = `scaleX(${duration ? Math.min(1, end / duration) : 0})`;
  }

  function refresh() {
    const duration = knownDuration();
    hit.classList.toggle('disabled', !duration);
    if (!scrubbing) paintFill(duration ? media.currentTime / duration : 0);
    paintBuffered();
  }

  // Boucle d'animation : suit la lecture de façon fluide (timeupdate ne tire que ~4 fois par seconde).
  function tick() {
    rafId = 0;
    if (!scrubbing) refresh();
    if (!media.paused && !media.ended) rafId = requestAnimationFrame(tick);
  }
  const startLoop = () => { if (!rafId) rafId = requestAnimationFrame(tick); };

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    listeners.push([target, type, fn, options]);
  }

  listen(media, 'play', startLoop);
  listen(media, 'playing', startLoop);
  ['pause', 'ended', 'timeupdate', 'seeked', 'durationchange', 'loadedmetadata', 'emptied'].forEach((type) => listen(media, type, refresh));
  listen(media, 'progress', paintBuffered);

  // ---------- Glissement ----------
  function seekTo(time, force) {
    const now = performance.now();
    if (!force && now - lastSeekAt < SEEK_THROTTLE_MS) return;
    lastSeekAt = now;
    try { media.currentTime = time; } catch (error) { /* ignoré : vidéo pas encore prête */ }
  }

  function ratioFromEvent(event) {
    const rect = hit.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  function updateScrub(event) {
    const duration = knownDuration();
    if (!duration) return;
    const ratio = ratioFromEvent(event);
    targetTime = Math.min(ratio * duration, Math.max(0, duration - 0.05)); // évite de tomber pile sur la fin
    paintFill(ratio);
    timeLabel.textContent = `${formatTime(targetTime)} / ${formatTime(duration)}`;
    seekTo(targetTime, false);
  }

  function beginScrub(event) {
    if (!interactive || scrubbing || !knownDuration()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    scrubbing = true;
    activePointer = event.pointerId;
    startTime = media.currentTime;
    wasPlaying = !media.paused;
    media.pause();
    try { hit.setPointerCapture(event.pointerId); } catch (error) { /* ignoré */ }
    hit.classList.add('active');
    el.classList.add('scrubbing');
    onScrubChange(true);
    updateScrub(event);
    event.preventDefault();
  }

  function endScrub({ commit, resume }) {
    if (!scrubbing) return;
    scrubbing = false;
    hit.classList.remove('active');
    el.classList.remove('scrubbing');
    if (activePointer !== null) {
      try { hit.releasePointerCapture(activePointer); } catch (error) { /* ignoré */ }
      activePointer = null;
    }
    seekTo(commit ? targetTime : startTime, true);
    onScrubChange(false);
    if (resume && wasPlaying) media.play().catch(() => {});
    refresh();
  }

  if (interactive) {
    listen(hit, 'pointerdown', beginScrub);
    listen(hit, 'pointermove', (event) => { if (scrubbing && event.pointerId === activePointer) { updateScrub(event); event.preventDefault(); } });
    listen(hit, 'pointerup', (event) => { if (event.pointerId === activePointer) endScrub({ commit: true, resume: true }); });
    // Annulation par le système : on revient à la position de départ.
    listen(hit, 'pointercancel', (event) => { if (event.pointerId === activePointer) endScrub({ commit: false, resume: true }); });
    listen(hit, 'click', (event) => event.stopPropagation());       // un geste sur la barre n'est jamais un tap sur la vidéo
    listen(hit, 'contextmenu', (event) => event.preventDefault());  // pas de menu au toucher long
  }

  refresh();

  return {
    el,
    isScrubbing: () => scrubbing,
    // Interrompt un glissement en cours (changement d'écran, app en arrière-plan).
    cancel({ resume = false } = {}) { endScrub({ commit: false, resume }); },
    // Nouvelle vidéo : la barre repart de zéro, sans rien garder de la précédente.
    reset() {
      if (scrubbing) endScrub({ commit: false, resume: false });
      paintFill(0);
      buffered.style.transform = 'scaleX(0)';
    },
    // Libère les écouteurs et la boucle d'animation.
    destroy() {
      if (scrubbing) endScrub({ commit: false, resume: false });
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      listeners.forEach(([target, type, fn, options]) => target.removeEventListener(type, fn, options));
      listeners.length = 0;
    },
  };
}

/**
 * Retour visuel du toucher : grande icône ▶ / ⏸ qui grossit puis disparaît en 600 ms,
 * et petit ▶ discret qui reste affiché tant que la vidéo est en pause.
 * Retourne { el, flash('play' | 'pause'), setPaused(bool) }.
 */
export function createTapFeedback() {
  const flashEl = h('div', { class: 'tap-flash hidden' });
  const badge = h('div', { class: 'tap-paused hidden', icon: icons.play });
  const el = h('div', { class: 'tap-fb' }, flashEl, badge);
  let timer;
  return {
    el,
    flash(kind) {
      flashEl.innerHTML = kind === 'pause' ? icons.pause : icons.play; // icônes statiques
      flashEl.classList.remove('hidden', 'go');
      void flashEl.offsetWidth; // relance l'animation
      flashEl.classList.add('go');
      clearTimeout(timer);
      timer = setTimeout(() => flashEl.classList.add('hidden'), 600);
    },
    setPaused(paused) { badge.classList.toggle('hidden', !paused); },
  };
}
