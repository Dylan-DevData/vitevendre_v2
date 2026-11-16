const fs = require('fs/promises');
const path = require('path');
const uploadModel = require('../models/upload.model');
const { sessionsDir, uploadSessionTtlHours, gcIntervalMinutes } = require('../config/env');
const logger = require('../utils/logger');

// Nettoyage périodique des envois abandonnés.
//  1. Supprime les sessions « in_progress » sans activité depuis plus longtemps que le TTL
//     (24 heures par défaut), ainsi que leur fichier temporaire et leur ligne en base.
//  2. Supprime les fichiers .tmp orphelins sans session active lorsqu'ils dépassent le TTL.
async function collect() {
  let sessions = 0;
  let orphans = 0;

  for (;;) {
    const abandoned = await uploadModel.listAbandoned(uploadSessionTtlHours);
    for (const upload of abandoned) {
      await fs.unlink(path.join(sessionsDir, `${upload.id}.tmp`)).catch((error) => {
        if (error.code !== 'ENOENT') logger.error('gc_unlink_failed', { uploadId: upload.id, message: error.message });
      });
      await uploadModel.removeAbandoned(upload.video_id);
    }
    sessions += abandoned.length;
    if (abandoned.length < 500) break;
  }

  const files = await fs.readdir(sessionsDir).catch(() => []);
  if (files.length) {
    const active = await uploadModel.listActiveIds();
    const limit = Date.now() - uploadSessionTtlHours * 3600 * 1000;
    for (const name of files) {
      if (!name.endsWith('.tmp') || active.has(name.slice(0, -4))) continue;
      const file = path.join(sessionsDir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < limit) {
        await fs.unlink(file).catch(() => {});
        orphans += 1;
      }
    }
  }

  if (sessions || orphans) logger.info('gc_done', { sessions, orphans });
  return { sessions, orphans };
}

function start() {
  const run = () => collect().catch((error) => logger.error('gc_failed', { message: error.message }));
  run();
  const timer = setInterval(run, gcIntervalMinutes * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { collect, start };
