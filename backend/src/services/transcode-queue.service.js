const fs = require('fs/promises');
const path = require('path');
const videoModel = require('../models/video.model');
const { sourcesDir, mediaDir, transcodeConcurrency } = require('../config/env');
const { processVideo } = require('./ffmpeg.service');
const events = require('./events.service');
const logger = require('../utils/logger');

// File d'attente en mémoire. L'état réel est en base (videos.status = 'processing') :
// après un redémarrage, recoverPending() remet les vidéos interrompues dans la file.
const pending = [];
const queued = new Set();
let running = 0;

function enqueue(videoId) {
  const id = Number(videoId);
  if (!Number.isSafeInteger(id) || id < 1 || queued.has(id)) return;
  queued.add(id);
  pending.push(id);
  pump();
}

function pump() {
  while (running < transcodeConcurrency && pending.length) {
    const id = pending.shift();
    running += 1;
    processOne(id)
      .catch((error) => logger.error('video_processing_failed', { videoId: id, message: error.message }))
      .finally(() => {
        queued.delete(id);
        running -= 1;
        setImmediate(pump);
      });
  }
}

async function processOne(videoId) {
  const video = await videoModel.getForProcessing(videoId);
  if (!video || !video.source_name || path.basename(video.source_name) !== video.source_name) return;
  // La file ne garde que des identifiants ; FFmpeg lira la source depuis le disque.
  const sourcePath = path.join(sourcesDir, video.source_name);
  try {
    // La première passe publie dès que les qualités de base sont prêtes.
    await processVideo(sourcePath, videoId, {
      onReady: async (meta) => {
        // Publie l'état en base avant d'avertir le téléphone et les autres clients connectés.
        await videoModel.markReady(videoId, meta);
        events.emitToUser(video.user_id, 'video.ready', { videoId, renditions: meta.renditions });
        events.broadcast('feed.new', { videoId });
      },
      onRenditions: async (names) => {
        await videoModel.setRenditions(videoId, names);
        events.emitToUser(video.user_id, 'video.renditions', { videoId, renditions: names });
      },
    });
  } catch (error) {
    await fs.rm(path.join(mediaDir, 'videos', String(videoId)), { recursive: true, force: true });
    await videoModel.markFailed(videoId);
    events.emitToUser(video.user_id, 'video.failed', { videoId, message: error.message });
    throw error;
  } finally {
    // La source brute (parfois plusieurs Go) est supprimée après le transcodage.
    await fs.unlink(sourcePath).catch((error) => {
      if (error.code !== 'ENOENT') logger.error('source_cleanup_failed', { videoId, message: error.message });
    });
  }
}

async function recoverPending() {
  const ids = await videoModel.listProcessing();
  ids.forEach(enqueue);
  return ids.length;
}

module.exports = { enqueue, recoverPending };
