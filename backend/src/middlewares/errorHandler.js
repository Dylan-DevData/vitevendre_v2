const { nodeEnv } = require('../config/env');

function notFound(req, res) {
  res.status(404).json({ error: `Route introuvable : ${req.method} ${req.originalUrl}` });
}

// Les contrôleurs appellent next(err) ; on renvoie un JSON sans exposer la pile.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error('[erreur]', err);
  // Une erreur 4xx avec un détail (ex : assembleMp4) doit rester visible dans la console,
  // sinon un échec d'assemblage ne laisse aucune trace côté serveur.
  else if (err.details) console.error(`[erreur ${status}] ${err.message}\n${String(err.details).slice(-1200)}`);
  res.status(status).json({
    error: status >= 500 && nodeEnv === 'production' ? 'Erreur serveur' : err.message,
  });
}

module.exports = { notFound, errorHandler };
