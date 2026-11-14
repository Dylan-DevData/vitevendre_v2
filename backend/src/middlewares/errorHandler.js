const { nodeEnv } = require('../config/env');

function notFound(req, res) {
  res.status(404).json({ error: `Route introuvable : ${req.method} ${req.originalUrl}` });
}

// Les contrôleurs appellent next(err) ; on renvoie un JSON sans exposer la pile.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error('[erreur]', err);
  res.status(status).json({
    error: status >= 500 && nodeEnv === 'production' ? 'Erreur serveur' : err.message,
  });
}

module.exports = { notFound, errorHandler };
