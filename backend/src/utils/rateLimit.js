// Limiteur simple en mémoire : au plus `max` actions par fenêtre de `windowMs` et par clé (ex. utilisateur).
// Suffisant pour un seul serveur ; à remplacer par Redis si l'API est répliquée.
function createRateLimiter({ max, windowMs }) {
  const hits = new Map(); // clé -> [horodatages]

  // Nettoyage périodique pour ne pas garder les clés inactives en mémoire.
  const sweeper = setInterval(() => {
    const limit = Date.now() - windowMs;
    hits.forEach((list, key) => {
      const recent = list.filter((t) => t > limit);
      if (recent.length) hits.set(key, recent); else hits.delete(key);
    });
  }, Math.max(windowMs, 60000));
  sweeper.unref();

  return {
    // true = action autorisée (et comptée) ; false = trop d'actions récentes.
    take(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => t > now - windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

module.exports = { createRateLimiter };
