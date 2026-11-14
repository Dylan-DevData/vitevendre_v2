import { api } from '../api.js';
import { toast } from '../ui/dom.js';

// État partagé des abonnements : une seule vérité pour tous les écrans (Reels, fil, profil).
// Suivre quelqu'un dans un Reel met aussitôt à jour son bouton dans le fil et sur son profil.
const state = new Map();       // userId -> true (abonné) | false
const listeners = new Set();

export const social = {
  // `fallback` = valeur envoyée par le serveur avec la vidéo, tant qu'on n'a rien changé nous-mêmes.
  isFollowing: (userId, fallback = false) => (state.has(userId) ? state.get(userId) : Boolean(fallback)),

  set(userId, following) {
    if (state.get(userId) === following) return;
    state.set(userId, following);
    [...listeners].forEach((fn) => fn(userId, following));
  },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  // Changement immédiat à l'écran, annulé si le serveur refuse. Retourne { following, followerCount } ou null.
  async toggle(userId, next) {
    const previous = state.has(userId) ? state.get(userId) : !next;
    this.set(userId, next);
    try {
      return next ? await api.follow(userId) : await api.unfollow(userId);
    } catch (error) {
      this.set(userId, previous);
      toast(error.network ? 'Réseau indisponible.' : error.message);
      return null;
    }
  },

  reset() { state.clear(); listeners.clear(); },
};
