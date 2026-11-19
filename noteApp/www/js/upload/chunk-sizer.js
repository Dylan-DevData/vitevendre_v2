// Le premier morceau vaut 512 Kio; après chaque réponse, la taille suit le débit observé.
// Le serveur accepte jusqu'à 4 Mio par PATCH, aussi bien pour le navigateur que pour Android.
export const MIN_CHUNK = 512 * 1024;
export const MAX_CHUNK = 4 * 1024 * 1024;
export const ANDROID_MAX_CHUNK = MAX_CHUNK;
const STEP = 512 * 1024;
const TARGET_SECONDS = 2; // vise une réponse environ toutes les deux secondes
const LOW_SPEED_BYTES_PER_SECOND = 512 * 1024;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const roundTo = (value, unit) => Math.round(value / unit) * unit;

// Taille de morceau adaptative :
//  - débit faible (jusqu'à 512 Kio/s) : on garde des morceaux de 512 Kio ;
//  - débit plus élevé : on vise deux secondes de transfert et on monte par pas de 512 Kio ;
//  - échec réseau : retour immédiat à 512 Kio pour limiter le coût d'une nouvelle tentative.
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
    // Mesure le débit courant et le lisse pour éviter de monter sur un succès atypique.
    const instant = bytes / Math.max(milliseconds, 1) * 1000;
    this.speed = this.speed ? this.speed * 0.6 + instant * 0.4 : instant;
    this.streak += 1;
    // Réagit immédiatement à une vraie baisse : ne pas continuer à envoyer 4 Mio
    // si le dernier morceau révèle maintenant un débit faible.
    if (instant <= LOW_SPEED_BYTES_PER_SECOND) {
      this.speed = instant;
      this.streak = 0;
      this.size = this.min;
      return this.size;
    }

    // Si le débit baisse sans passer sous le seuil faible, réduire dès le prochain morceau.
    const measuredIdeal = clamp(roundTo(instant * TARGET_SECONDS, 64 * 1024), this.min, this.max);
    if (measuredIdeal < this.size) {
      this.size = measuredIdeal;
      return this.size;
    }

    // À faible débit, garder 512 Kio évite qu'une seule requête reste longtemps en attente.
    // Au-dessus de ce seuil, viser deux secondes de données et arrondir par pas de 64 Kio.
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
