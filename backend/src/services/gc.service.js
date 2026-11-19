const fs = require('fs/promises');
const path = require('path');
const uploadModel = require('../models/upload.model');
const { sessionsDir, uploadSessionTtlHours, gcIntervalMinutes } = require('../config/env');
const logger = require('../utils/logger');

// Nettoyage périodique des envois abandonnés.
//  1. Supprime les sessions « in_progress » sans activité depuis plus longtemps que le TTL
//     (24 heures par défaut) : le dossier sessions/<uploadId>/ et les anciens fichiers plats.
//  2. Supprime les dossiers de session et fichiers temporaires orphelins (plus référencés).
const UUID_DIR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function removeAbandonedFiles(uploadId) {
  // Nouveau layout : un dossier entier par session.
  await fs.rm(path.join(sessionsDir, uploadId), { recursive: true, force: true }).catch((error) => {
    if (error.code !== 'ENOENT') logger.error('gc_unlink_failed', { uploadId, message: error.message });
  });
  // Ancien layout (sessions plates d'avant le passage aux dossiers) : fichiers <uploadId>*.
  const files = await fs.readdir(sessionsDir).catch(() => []);
  for (const name of files.filter((entry) => entry.startsWith(`${uploadId}.`) || entry === `${uploadId}.tmp`)) {
    await fs.unlink(path.join(sessionsDir, name)).catch((error) => {
      if (error.code !== 'ENOENT') logger.error('gc_unlink_failed', { uploadId, message: error.message });
    });
  }
}

async function collect() {
  let sessions = 0;
  let orphans = 0;

  for (;;) {
    const abandoned = await uploadModel.listAbandoned(uploadSessionTtlHours);
    for (const upload of abandoned) {
      await removeAbandonedFiles(String(upload.id));
      await uploadModel.removeAbandoned(upload.video_id);
    }
    sessions += abandoned.length;
    if (abandoned.length < 500) break;
  }

  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  if (entries.length) {
    const active = await uploadModel.listActiveIds();
    const limit = Date.now() - uploadSessionTtlHours * 3600 * 1000;
    for (const entry of entries) {
      const entryPath = path.join(sessionsDir, entry.name);
      if (entry.isDirectory()) {
        // Dossier de session : conservé tant que l'envoi est in_progress. Dès qu'une
        // session n'est plus active et que son mtime dépasse le TTL (24 h), tout le
        // dossier (meta.json compris) disparaît : rien ne s'accumule pour les sessions
        // terminées, contrairement à l'ancien layout où meta.json restait pour toujours.
        if (!UUID_DIR_PATTERN.test(entry.name) || active.has(entry.name.toLowerCase())) continue;
        const stat = await fs.stat(entryPath).catch(() => null);
        if (stat && stat.mtimeMs < limit) {
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
          orphans += 1;
        }
        continue;
      }
      // Fichiers plats (ancien layout ou temporaires égarés à la racine).
      const sessionId = entry.name.match(/^([0-9a-f-]{36})\./i)?.[1]?.toLowerCase() || null;
      const isUploadFile = entry.name.endsWith('.tmp') || entry.name.endsWith('.part') || entry.name.endsWith('.meta.json') || entry.name.endsWith('.assembly-error.log');
      if (!isUploadFile || (sessionId && active.has(sessionId))) continue;
      const stat = await fs.stat(entryPath).catch(() => null);
      if (stat && stat.mtimeMs < limit) {
        await fs.unlink(entryPath).catch(() => {});
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
