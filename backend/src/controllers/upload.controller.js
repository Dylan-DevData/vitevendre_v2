const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const uploadModel = require('../models/upload.model');
const queue = require('../services/transcode-queue.service');
const { sessionsDir, sourcesDir, maxVideoBytes, uploadChunkMaxBytes } = require('../config/env');
const { httpError } = require('../utils/httpError');
const logger = require('../utils/logger');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
};

// Un seul PATCH à la fois par session : évite deux écritures concurrentes dans le même .tmp.
// Si le téléphone relance un morceau alors que l'ancienne requête (coupée côté réseau mais
// encore ouverte côté serveur) traîne, la NOUVELLE prend la main : l'ancienne est fermée.
const inflight = new Map(); // uploadId -> { req, done } : requête PATCH actuellement active.
const completing = new Set();

const tmpPath = (uploadId) => path.join(sessionsDir, `${uploadId}.tmp`);

function parseUploadId(value) {
  if (!UUID_PATTERN.test(value)) throw httpError(400, 'Identifiant d’envoi invalide.');
  return value.toLowerCase();
}

function present(upload) {
  return {
    uploadId: upload.id,
    videoId: Number(upload.video_id),
    status: upload.status,
    totalSize: Number(upload.total_size),
    receivedBytes: Number(upload.received_bytes),
  };
}

// POST /api/uploads  { mime_type, total_size, fingerprint, caption }
async function createUpload(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mimeType = body.mime_type;
    const totalSize = Number(body.total_size);
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.toLowerCase() : '';
    const caption = typeof body.caption === 'string' ? body.caption.trim() : '';

    if (!EXTENSIONS[mimeType]) throw httpError(415, 'Type de vidéo non accepté.');
    if (!Number.isSafeInteger(totalSize) || totalSize < 1
      || (maxVideoBytes > 0 && totalSize > maxVideoBytes)) {
      throw httpError(413, 'La taille de la vidéo est invalide ou trop élevée.');
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw httpError(400, 'L’empreinte doit contenir 64 caractères hexadécimaux.');
    }
    if (caption.length > 300) throw httpError(400, 'La légende dépasse 300 caractères.');

    // Crée une session ou retrouve celle du même compte et de la même empreinte interrompue.
    const { upload, resumed } = await uploadModel.createOrResume({
      userId: req.user.id, mimeType, totalSize, fingerprint, caption,
    });

    await fsp.mkdir(sessionsDir, { recursive: true });
    if (!resumed) await fsp.writeFile(tmpPath(upload.id), '', { flag: 'a' });

    return res.status(resumed ? 200 : 201).json({
      ...present(upload),
      resumed,
      maxChunkBytes: uploadChunkMaxBytes,
    });
  } catch (error) {
    return next(error);
  }
}

// GET /api/uploads/:id  -> où reprendre ? (receivedBytes = prochain offset à envoyer)
async function getUpload(req, res, next) {
  try {
    const upload = await uploadModel.findOwned(parseUploadId(req.params.id), req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    return res.json({ ...present(upload), maxChunkBytes: uploadChunkMaxBytes });
  } catch (error) {
    return next(error);
  }
}

// PATCH /api/uploads/:id   Upload-Offset: <octets déjà reçus>   body: octets bruts
// Chaque morceau est écrit en flux (aucun tampon en RAM) à la fin du fichier .tmp.
async function appendChunk(req, res, next) {
  const uploadId = parseUploadId(req.params.id);
  const previous = inflight.get(uploadId);
  if (previous) {
    previous.req.destroy();
    await previous.done;
  }
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  inflight.set(uploadId, { req, done });
  try {
    const upload = await uploadModel.findOwned(uploadId, req.user.id);
    if (!upload || upload.status !== 'in_progress') {
      throw httpError(404, 'Session d’envoi introuvable ou terminée.');
    }
    // PostgreSQL garde le dernier offset confirmé ; toute tranche doit commencer à cet endroit.
    const total = Number(upload.total_size);
    const dbOffset = Number(upload.received_bytes);

    const offset = Number(req.get('upload-offset'));
    const length = Number(req.get('content-length'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'En-tête Upload-Offset invalide.');
    if (!Number.isSafeInteger(length) || length < 1 || length > uploadChunkMaxBytes) {
      throw httpError(400, `Content-Length doit être compris entre 1 et ${uploadChunkMaxBytes} octets.`);
    }
    if (offset + length > total) throw httpError(400, 'Ce morceau dépasse la taille annoncée.');

    // Désynchronisation (morceau déjà reçu, ou client en retard) : on renvoie l'offset réel.
    if (offset !== dbOffset) return offsetConflict(res, dbOffset);

    // Le .tmp peut contenir des octets d'un morceau précédent interrompu : on le ramène
    // exactement à l'offset validé avant d'ajouter la suite.
    const file = tmpPath(uploadId);
    const stat = await fsp.stat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat || stat.size < dbOffset) {
      const actual = stat ? stat.size : 0;
      await fsp.writeFile(file, '', { flag: 'a' });
      await uploadModel.resetReceived(uploadId, actual);
      return offsetConflict(res, actual);
    }
    if (stat.size > dbOffset) await fsp.truncate(file, dbOffset);

    let written = 0;
    req.on('data', (data) => { written += data.length; });
    try {
      // pipeline relie le flux réseau au disque avec contre-pression, sans Buffer de taille vidéo.
      await pipeline(req, fs.createWriteStream(file, { flags: 'a' }));
    } catch (error) {
      await fsp.truncate(file, dbOffset).catch(() => {});
      throw error.code === 'ECONNRESET' || req.aborted ? httpError(400, 'Envoi interrompu.') : error;
    }
    if (written !== length) {
      await fsp.truncate(file, dbOffset).catch(() => {});
      throw httpError(400, `Morceau incomplet : ${length} octets annoncés, ${written} reçus.`);
    }

    // La base n'avance qu'après confirmation que tous les octets de la tranche sont sur disque.
    const received = await uploadModel.advance(uploadId, req.user.id, dbOffset, dbOffset + length);
    if (received === null) throw httpError(409, 'La session a changé pendant l’envoi. Réinterrogez-la.');
    res.set('Upload-Offset', String(received));
    return res.json({ uploadId, receivedBytes: received, totalSize: total });
  } catch (error) {
    return next(error);
  } finally {
    if (inflight.get(uploadId) && inflight.get(uploadId).req === req) inflight.delete(uploadId);
    release();
  }
}

function offsetConflict(res, receivedBytes) {
  res.set('Upload-Offset', String(receivedBytes));
  return res.status(409).json({
    error: 'Offset inattendu : reprenez à receivedBytes.',
    receivedBytes,
  });
}

// Vérifie les premiers octets : conteneur MP4/MOV/3GP ("ftyp") ou WebM/Matroska (EBML).
async function looksLikeVideo(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, 12, 0);
    if (bytesRead < 12) return false;
    return head.toString('latin1', 4, 8) === 'ftyp'
      || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3);
  } finally {
    await handle.close();
  }
}

// POST /api/uploads/:id/complete
async function completeUpload(req, res, next) {
  const uploadId = parseUploadId(req.params.id);
  if (inflight.has(uploadId) || completing.has(uploadId)) {
    return next(httpError(409, 'Un envoi est encore en cours.'));
  }
  completing.add(uploadId);
  try {
    const upload = await uploadModel.findOwned(uploadId, req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    if (upload.status === 'complete') {
      return res.status(200).json({ ...present(upload), message: 'Déjà en cours de traitement.' });
    }
    if (upload.status !== 'in_progress') throw httpError(409, 'Cette session est terminée.');

    const total = Number(upload.total_size);
    if (Number(upload.received_bytes) !== total) {
      return res.status(409).json({
        error: 'Il manque encore des octets.',
        receivedBytes: Number(upload.received_bytes),
        totalSize: total,
      });
    }

    // Compare la taille du fichier temporaire à la taille annoncée et à l'offset enregistré.
    const file = tmpPath(uploadId);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || stat.size !== total) {
      const actual = stat ? stat.size : 0;
      await uploadModel.resetReceived(uploadId, actual);
      throw httpError(409, 'Le fichier reçu est incomplet : reprenez l’envoi.');
    }
    if (!(await looksLikeVideo(file))) {
      await uploadModel.abort(uploadId, req.user.id);
      await fsp.unlink(file).catch(() => {});
      throw httpError(422, 'Le fichier reçu n’est pas une vidéo reconnue.');
    }

    const sourceName = `${upload.video_id}${EXTENSIONS[upload.mime_type]}`;
    await fsp.mkdir(sourcesDir, { recursive: true });
    // Les morceaux sont déjà réunis dans ce fichier : rename le déplace sans recharger son contenu.
    await fsp.rename(file, path.join(sourcesDir, sourceName));

    const videoId = await uploadModel.complete(uploadId, req.user.id, sourceName);
    if (!videoId) throw httpError(404, 'Session d’envoi introuvable.');
    // Le traitement est asynchrone : 202 signifie « reçu, conversion en cours ».
    queue.enqueue(videoId);
    return res.status(202).json({
      uploadId,
      videoId,
      status: 'processing',
      message: 'Vidéo reçue : transcodage HLS en cours.',
    });
  } catch (error) {
    return next(error);
  } finally {
    completing.delete(uploadId);
  }
}

// DELETE /api/uploads/:id
async function abortUpload(req, res, next) {
  try {
    const uploadId = parseUploadId(req.params.id);
    const removed = await uploadModel.abort(uploadId, req.user.id);
    if (!removed) throw httpError(404, 'Session d’envoi introuvable.');
    await fsp.unlink(tmpPath(uploadId)).catch((error) => {
      if (error.code !== 'ENOENT') logger.error('upload_tmp_cleanup_failed', { uploadId, message: error.message });
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

module.exports = { createUpload, getUpload, appendChunk, completeUpload, abortUpload };
