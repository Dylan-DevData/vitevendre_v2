import { api } from '../api.js';
import { attach } from '../player.js';
import { h, formatCount, toast } from './dom.js';
import { icons } from './icons.js';
import { createSeekBar, createTapFeedback } from './player-controls.js';
import { createFollowButton } from './follow-button.js';

// Délai d'attente pour distinguer un toucher simple d'un double-tap.
const TAP_DELAY = 280;

// Reels plein écran : défilement vertical avec aimantation, une seule vidéo qui joue,
// préchargement de la suivante, toucher simple = pause / lecture, barre de progression glissable,
// double-tap (bords = -/+ 5 s, centre = J'aime), indicateurs de mise en mémoire pour les mauvais réseaux.
// Social : nom de l'auteur touchable (ouvre son profil), bouton « Suivre », commentaires en fenêtre,
// compteurs de J'aime et de commentaires mis à jour en direct.
export function createReels({ realtime, comments, onOpenUser }) {
  const el = h('div', { class: 'view reels-view' });
  const scroller = h('div', { class: 'reels-scroll' });
  const hint = h('div', { class: 'reels-hint hidden' }, 'Touchez l’écran pour activer le son');
  const topbar = h('div', { class: 'reels-top' }, h('h2', {}, 'Reels'));
  el.append(scroller, topbar, hint);

  let videos = [];
  let nodes = [];
  let active = -1;
  let visible = false;
  let soundOn = true;
  let moreLoading = false;
  let moreFn = null;   // (dernièreVidéo) => Promise<vidéos[]> ; null = pas de suite
  const controllers = new Map();

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.intersectionRatio >= 0.75) setActive(Number(entry.target.dataset.index));
    });
  }, { root: scroller, threshold: [0.75] });

  function build(video, index) {
    const media = h('video', { class: 'reel-video', playsinline: true, loop: true, preload: 'none',
      poster: video.posterUrl ? api.base + video.posterUrl : null });
    const spinner = h('div', { class: 'reel-spinner hidden' }, h('i', {}), h('span', {}, ''));
    const quality = h('div', { class: 'reel-quality hidden' });
    const ripple = h('div', { class: 'reel-ripple hidden' });
    const burst = h('div', { class: 'reel-burst hidden', icon: icons.heartFill });
    const feedback = createTapFeedback();           // icône ▶ / ⏸ + petit ▶ en pause
    const state = { userPaused: false };            // true = l'utilisateur a mis en pause lui-même

    // La barre masque la légende et les boutons pendant le glissement, comme TikTok.
    const seek = createSeekBar(media, { onScrubChange: (on) => section.classList.toggle('scrubbing', on) });

    // Dès que la lecture reprend (quelle qu'en soit la cause), le petit ▶ disparaît.
    media.addEventListener('play', () => feedback.setPaused(false));

    const likeCount = h('span', {}, formatCount(video.likeCount || 0));
    const commentCount = h('span', {}, formatCount(video.commentCount || 0));
    const commentButton = h('button', { class: 'rail-btn', type: 'button', 'aria-label': 'Commentaires', icon: icons.comment });
    commentButton.addEventListener('click', (event) => {
      event.stopPropagation();
      comments.open(video, { onCount: (n) => applyStats({ commentCount: n }) });
    });

    // Compteurs en direct (événement « video.stats » du serveur) : les chiffres sont absolus, donc sans risque de doublon.
    function applyStats(stats) {
      if (typeof stats.likeCount === 'number') { video.likeCount = stats.likeCount; likeCount.textContent = formatCount(stats.likeCount); }
      if (typeof stats.commentCount === 'number') { video.commentCount = stats.commentCount; commentCount.textContent = formatCount(stats.commentCount); }
    }
    const likeButton = h('button', { class: `rail-btn${video.likedByMe ? ' on' : ''}`, type: 'button', 'aria-label': 'J’aime',
      icon: video.likedByMe ? icons.heartFill : icons.heart });
    async function setLike(liked) {
      if (liked === likeButton.classList.contains('on')) return;
      likeButton.classList.toggle('on', liked);
      likeButton.innerHTML = liked ? icons.heartFill : icons.heart;
      try {
        const result = liked ? await api.like(video.id) : await api.unlike(video.id);
        video.likeCount = result.likeCount; video.likedByMe = liked;
        likeCount.textContent = formatCount(result.likeCount);
      } catch (error) {
        likeButton.classList.toggle('on', !liked);
        likeButton.innerHTML = !liked ? icons.heartFill : icons.heart;
        toast(error.network ? 'Réseau indisponible.' : error.message);
      }
    }
    likeButton.addEventListener('click', (event) => { event.stopPropagation(); setLike(!likeButton.classList.contains('on')); });

    // --- Buffer / réseau lent (lecture et déplacement dans la vidéo) ---
    let waitTimer; let slowTimer;
    const waitingSoon = () => {
      clearTimeout(waitTimer); clearTimeout(slowTimer);
      // Pas d'indicateur au centre pendant le glissement : l'affichage du temps y est déjà.
      waitTimer = setTimeout(() => { if (!seek.isScrubbing()) spinner.classList.remove('hidden'); }, 400);
      slowTimer = setTimeout(() => { spinner.querySelector('span').textContent = 'Connexion lente… la qualité s’adapte'; }, 3000);
    };
    const ready = () => {
      clearTimeout(waitTimer); clearTimeout(slowTimer);
      spinner.classList.add('hidden'); spinner.querySelector('span').textContent = '';
    };
    media.addEventListener('waiting', waitingSoon);
    media.addEventListener('seeking', waitingSoon);
    media.addEventListener('playing', ready);
    media.addEventListener('canplay', ready);
    media.addEventListener('seeked', ready);

    // --- Gestes ---
    let lastTap = 0; let tapTimer;
    const flash = (node, text) => {
      if (text) node.textContent = text;
      node.classList.remove('hidden');
      node.classList.remove('pop'); void node.offsetWidth; node.classList.add('pop');
      setTimeout(() => node.classList.add('hidden'), 650);
    };

    // Toucher simple : active le son si besoin, sinon bascule pause / lecture.
    function togglePlay() {
      if (soundOn && media.muted) { media.muted = false; hint.classList.add('hidden'); return; }
      if (media.paused) {
        state.userPaused = false;
        media.play().catch(() => {});
        feedback.flash('play');
      } else {
        state.userPaused = true;
        media.pause();
        feedback.flash('pause');
        feedback.setPaused(true);
      }
    }

    const section = h('section', { class: 'reel', 'data-index': index }, media, spinner, quality, ripple, burst, feedback.el,
      h('aside', { class: 'rail' }, likeButton, likeCount, commentButton, commentCount),
      h('div', { class: 'reel-info' },
        h('div', { class: 'reel-who' },
          h('button', { class: 'reel-author', type: 'button', onclick: () => onOpenUser(video.author.id, video.author.name) }, `@${video.author.name}`),
          createFollowButton(video.author, { className: 'follow-btn pill' })),
        video.caption ? h('p', {}, video.caption) : null),
      seek.el);

    section.addEventListener('click', (event) => {
      if (event.target.closest('.rail, .seek, .reel-who')) return; // boutons, barre, auteur : pas des taps sur la vidéo
      const now = Date.now();
      const rect = section.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      if (now - lastTap < TAP_DELAY) {
        // Double-tap : annule le toucher simple en attente (donc pas de pause).
        clearTimeout(tapTimer); lastTap = 0;
        if (x < 0.33) { media.currentTime = Math.max(0, media.currentTime - 5); ripple.className = 'reel-ripple left'; flash(ripple, '−5 s'); }
        else if (x > 0.66) { media.currentTime = Math.min(media.duration || 1e9, media.currentTime + 5); ripple.className = 'reel-ripple right'; flash(ripple, '+5 s'); }
        else { setLike(true); flash(burst); }
        return;
      }
      lastTap = now;
      tapTimer = setTimeout(togglePlay, TAP_DELAY);
    });

    // Remet l'écran de cette vidéo à zéro (on la quitte) : barre vide, plus d'icône de pause.
    function reset() {
      clearTimeout(tapTimer); lastTap = 0;
      seek.reset();
      state.userPaused = false;
      feedback.setPaused(false);
      ready();
      section.classList.remove('scrubbing');
    }

    // Libère timers, écouteurs et boucle d'animation.
    function destroy() {
      clearTimeout(tapTimer); clearTimeout(waitTimer); clearTimeout(slowTimer);
      seek.destroy();
    }

    return { section, media, quality, video, seek, state, reset, destroy, applyStats };
  }

  function mount(index, preload) {
    if (index < 0 || index >= nodes.length || controllers.has(index)) return;
    const node = nodes[index];
    // Le lecteur HLS charge les petits segments au fur et à mesure du défilement des Reels.
    controllers.set(index, attach(node.media, api.base + node.video.hlsUrl, {
      preload,
      onLevel: (name) => {
        node.quality.textContent = name;
        node.quality.classList.remove('hidden');
        clearTimeout(node.qualityTimer);
        node.qualityTimer = setTimeout(() => node.quality.classList.add('hidden'), 2500);
      },
      onFatal: () => unmount(index),
    }));
  }

  function unmount(index) {
    const controller = controllers.get(index);
    if (controller) { controller.destroy(); controllers.delete(index); }
    if (nodes[index]) nodes[index].media.pause();
  }

  function setActive(index) {
    if (index === active) return;
    active = index;
    for (const key of [...controllers.keys()]) if (Math.abs(key - index) > 1) unmount(key);
    mount(index, false);
    mount(index + 1, true);  // préchargement : quelques secondes seulement
    mount(index - 1, true);
    // On quitte les autres vidéos : pause, retour au début, barre remise à zéro.
    nodes.forEach((node, i) => {
      if (i === index) return;
      node.media.pause();
      if (node.media.readyState > 0) { try { node.media.currentTime = 0; } catch (error) { /* ignoré */ } }
      node.reset();
    });
    if (visible) play();
    if (index >= nodes.length - 3 && !moreLoading && moreFn) {
      moreLoading = true;
      moreFn(videos[videos.length - 1])
        .then((more) => { if (more && more.length) append(more); else moreFn = null; })
        .catch(() => {})
        .finally(() => { moreLoading = false; });
    }
  }

  function play() {
    const node = nodes[active];
    if (!node || node.state.userPaused) return;   // on respecte une pause demandée par l'utilisateur
    node.media.muted = !soundOn;
    node.media.play().catch(() => {
      // Le navigateur refuse le son sans geste : on lit en muet et on invite à toucher l'écran.
      node.media.muted = true;
      node.media.play().catch(() => {});
      hint.classList.remove('hidden');
    });
  }

  // Pause de tout, et fin d'un éventuel glissement en cours.
  function pauseAll() {
    nodes.forEach((node) => { node.seek.cancel({ resume: false }); node.media.pause(); });
  }

  // App en arrière-plan (onglet masqué, ou événements Cordova pause / resume) : on met en pause.
  function onBackground() { if (visible) pauseAll(); }
  function onForeground() { if (visible) play(); }
  function onVisibilityChange() { if (document.hidden) onBackground(); else onForeground(); }
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pause', onBackground);
  document.addEventListener('resume', onForeground);

  // Temps réel : mise à jour des compteurs de la vidéo concernée.
  const offStats = realtime.on('video.stats', (data) => {
    nodes.forEach((node) => { if (node.video.id === data.videoId) node.applyStats(data); });
  });

  function append(more) {
    more.forEach((video) => {
      const node = build(video, nodes.length);
      nodes.push(node); videos.push(video);
      scroller.append(node.section);
      observer.observe(node.section);
    });
  }

  return {
    el,
    // Remplace la liste et se positionne sur startIndex.
    setList(list, startIndex = 0, more = null) {
      moreFn = more;
      [...controllers.keys()].forEach(unmount);
      observer.disconnect();
      nodes.forEach((node) => node.destroy());
      scroller.replaceChildren();
      nodes = []; videos = []; active = -1;
      append(list);
      requestAnimationFrame(() => {
        const target = nodes[startIndex];
        if (target) { scroller.scrollTop = target.section.offsetTop; setActive(startIndex); }
      });
    },
    hasVideos: () => nodes.length > 0,
    onShow() { visible = true; if (active < 0 && nodes.length) setActive(0); else play(); },
    onHide() { visible = false; pauseAll(); hint.classList.add('hidden'); },
    // À appeler si l'écran Reels est détruit pour de bon.
    destroy() {
      visible = false;
      pauseAll();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pause', onBackground);
      document.removeEventListener('resume', onForeground);
      offStats();
      observer.disconnect();
      [...controllers.keys()].forEach(unmount);
      nodes.forEach((node) => node.destroy());
    },
  };
}
