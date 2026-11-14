import { getNetworkSnapshot, subscribeNetwork } from './services/network.js';

const DATA_SAVER_KEY = 'vv.dataSaver';

export const prefs = {
  get dataSaver() { try { return window.localStorage.getItem(DATA_SAVER_KEY) === '1'; } catch (e) { return false; } },
  set dataSaver(value) { try { window.localStorage.setItem(DATA_SAVER_KEY, value ? '1' : '0'); } catch (e) { /* ignoré */ } },
};

// Plafond de résolution (petit côté) selon le réseau du spectateur :
//   2G / économie de données du système ........ 240p
//   3G, ou "Économiser les données" activé ..... 480p
//   4G / Wi-Fi ................................. pas de plafond (hls.js choisit seul, jusqu'à 1080p)
// Le plafond n'empêche pas hls.js de descendre plus bas si le débit mesuré chute.
export function resolutionCap() {
  const net = getNetworkSnapshot();
  if (net.saveData || net.quality === 'slow') return 240;
  if (prefs.dataSaver || net.quality === 'medium') return 480;
  return Infinity;
}

// Estimation de débit initiale (bit/s) : évite de démarrer en 1080p sur un réseau faible.
function initialEstimate() {
  const cap = resolutionCap();
  if (cap <= 240) return 250000;
  if (cap <= 480) return 800000;
  return 3000000;
}

const shortSide = (level) => Math.min(level.width || Infinity, level.height || Infinity);

/**
 * Branche une vidéo HLS sur un élément <video>.
 * options : preload (true = ne charge que quelques secondes d'avance),
 *           onLevel(nom), onFatal(), onStall(bool)
 * Retourne { destroy(), applyCap(), get levelName }.
 */
export function attach(video, url, options = {}) {
  const { preload = false, onLevel = () => {}, onFatal = () => {} } = options;
  let hls = null;
  let unsubscribe = () => {};

  if (window.Hls && window.Hls.isSupported()) {
    // hls.js demande la playlist puis les petits segments au fil de la lecture, pas la source brute.
    hls = new window.Hls({
      capLevelToPlayerSize: true,
      maxBufferLength: preload ? 4 : 14,
      maxMaxBufferLength: preload ? 6 : 30,
      abrEwmaDefaultEstimate: initialEstimate(),
      abrBandWidthFactor: 0.8,       // prudent : préfère la fluidité à la qualité
      abrBandWidthUpFactor: 0.6,     // monte en qualité seulement si le débit est nettement meilleur
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 800,
    });
    const applyCap = () => {
      const cap = resolutionCap();
      let index = -1;
      if (Number.isFinite(cap)) {
        hls.levels.forEach((level, i) => { if (shortSide(level) <= cap) index = i; });
        if (index < 0) index = 0;
      }
      hls.autoLevelCapping = index;
    };
    hls.on(window.Hls.Events.MANIFEST_PARSED, applyCap);
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (event, data) => {
      const level = hls.levels[data.level];
      if (level) onLevel(`${shortSide(level)}p`);
    });
    hls.on(window.Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls.startLoad(), 1500);
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { hls.destroy(); onFatal(); }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    unsubscribe = subscribeNetwork(() => { if (hls.levels && hls.levels.length) applyCap(); });
    return {
      applyCap,
      destroy() { unsubscribe(); hls.destroy(); },
      get levelName() {
        const level = hls.levels && hls.levels[hls.currentLevel];
        return level ? `${shortSide(level)}p` : '';
      },
    };
  }

  // Lecture HLS native (Safari / iOS) : le système gère lui-même la qualité.
  // Les navigateurs avec HLS natif (par exemple Safari) lisent directement l'URL de playlist.
  video.src = url;
  return {
    applyCap() {},
    destroy() { video.removeAttribute('src'); video.load(); },
    levelName: '',
  };
}
