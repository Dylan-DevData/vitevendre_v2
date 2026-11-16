export const MIN_CHUNK = 512 * 1024;
export const MAX_CHUNK = 2 * 1024 * 1024;
export const ANDROID_MAX_CHUNK = 1024 * 1024;
const STEP = 256 * 1024;
const TARGET_SECONDS = 4; // un morceau devrait durer ~4 s : assez court pour perdre peu en cas de coupure

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundTo = (value, unit) => Math.round(value / unit) * unit;

// Taille de morceau adaptative (principe de TCP) :
//  - réseau stable : on monte doucement, d'un pas à la fois, vers ce que le débit permet ;
//  - échec ou réseau qui s'effondre : retour immédiat à la taille minimale.
export class ChunkSizer {
  constructor({ min = MIN_CHUNK, max = MAX_CHUNK } = {}) {
    this.min = min;
    this.max = max;
    this.size = min;
    this.speed = 0;    // octets/s lissés
    this.streak = 0;   // succès consécutifs
  }

  next() {
    return this.size;
  }

  setMax(max) {
    const limit = Math.floor(Number(max));
    if (!Number.isSafeInteger(limit) || limit < 1) return;
    this.max = Math.min(this.max, limit);
    this.min = Math.min(this.min, this.max);
    this.size = clamp(this.size, this.min, this.max);
  }

  onSuccess(bytes, milliseconds) {
    // Mesure le débit puis le lisse pour éviter de réagir exagérément à un seul ralentissement.
    const instant = bytes / Math.max(milliseconds, 1) * 1000;
    this.speed = this.speed ? this.speed * 0.6 + instant * 0.4 : instant;
    this.streak += 1;
    // Vise un morceau d'environ quatre secondes, arrondi par pas de 64 Kio.
    const ideal = clamp(roundTo(this.speed * TARGET_SECONDS, 64 * 1024), this.min, this.max);
    // Deux succès consécutifs sont requis avant d'augmenter progressivement la taille.
    if (ideal > this.size && this.streak >= 2) this.size = Math.min(ideal, this.size + STEP);
    else if (ideal < this.size * 0.6) this.size = ideal;
    return this.size;
  }

  onFailure() {
    // Après une coupure, repartir à la taille minimale réduit le coût d'un nouvel échec.
    this.streak = 0;
    this.size = this.min;
    this.speed *= 0.5;
    return this.size;
  }
}
