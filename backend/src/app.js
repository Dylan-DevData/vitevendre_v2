const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');

const { corsOrigin, mediaDir, sessionsDir, sourcesDir } = require('./config/env');
const { query } = require('./config/db');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

const app = express();

[mediaDir, sessionsDir, sourcesDir].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((o) => o.trim()),
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Upload-Offset'],
  })
);
// Ne lit que le JSON : le corps application/octet-stream des PATCH reste un flux intact.
app.use(express.json({ limit: '1mb' }));

// Un média n'est servi que si sa vidéo est publiée (status = 'ready').
// Vérifie l'état avant d'exposer une playlist ou un segment HLS au lecteur.
app.use('/media', async (req, res, next) => {
  const match = req.path.match(/^\/videos\/([1-9]\d*)\//);
  if (!match) return res.status(404).json({ error: 'Média introuvable.' });
  try {
    const { rows } = await query(`SELECT 1 FROM videos WHERE id = $1 AND status = 'ready'`, [match[1]]);
    if (!rows.length) return res.status(404).json({ error: 'Média introuvable.' });
    return next();
  } catch (error) {
    return next(error);
  }
});

// Fichiers HLS (master.m3u8, index.m3u8, segments .ts) et affiches.
// Les segments ne changent jamais : cache long. Le master peut être réécrit quand
// 720p/1080p arrivent : jamais mis en cache.
// Express lit les playlists et segments depuis le disque au fil des requêtes, pas tout le média en RAM.
app.use('/media', express.static(mediaDir, {
  fallthrough: true,
  index: false,
  setHeaders(res, filePath) {
    res.setHeader('Accept-Ranges', 'bytes');
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.jpg')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

app.get('/api/health', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT now() AS now');
    res.json({ status: 'ok', db: 'ok', time: rows[0].now });
  } catch (err) {
    next(err);
  }
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/uploads', require('./routes/upload.routes'));
app.use('/api/videos', require('./routes/video.routes'));
app.use('/api/events', require('./routes/events.routes'));
app.use('/api/comments', require('./routes/comment.routes'));
app.use('/api/users', require('./routes/user.routes'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
