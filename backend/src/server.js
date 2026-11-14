const app = require('./app');
const { port, requestTimeoutMs, headersTimeoutMs } = require('./config/env');
const { pool } = require('./config/db');
const queue = require('./services/transcode-queue.service');
const gc = require('./services/gc.service');
const realtime = require('./services/realtime.service');
const { authenticateToken } = require('./middlewares/authenticate');

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`API ViteVendre en écoute sur http://0.0.0.0:${port}`);
  // Reprend les transcodages interrompus puis démarre le nettoyage périodique.
  queue.recoverPending().catch((error) => {
    console.error('[video] reprise des traitements interrompue :', error.message);
  });
  gc.start();
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(headersTimeoutMs, requestTimeoutMs);
});

// WebSocket temps réel sur le même port : ws://hôte:3000/ws?token=<jwt>
const live = realtime.attach(server, { verifyToken: authenticateToken });

function shutdown() {
  console.log('Arrêt en cours…');
  live.close();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
