const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');
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

// Un seul PATCH à la fois par session dans ce processus. La transaction PostgreSQL
// de appendChunk sérialise également les requêtes si plusieurs processus sont lancés.
const inflight = new Map();
const completing = new Set();

const legacyTmpPath = (uploadId) => path.join(sessionsDir, `${uploadId}.tmp`);
const assemblyTmpPath = (uploadId) => path.join(sourcesDir, `${uploadId}.assembling.tmp`);

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

function isMissing(error) {
  return error && error.code === 'ENOENT';
}

async function removeIfPresent(file) {
  await fsp.unlink(file).catch((error) => {
    if (!isMissing(error)) throw error;
  });
}

// Lit seulement le morceau courant, borné par Content-Length et la limite API.
async function readChunkBody(req, expectedLength) {
  const data = Buffer.allocUnsafe(expectedLength);
  let received = 0;
  try {
    for await (const part of req) {
      if (received + part.length > expectedLength) {
        throw httpError(400, 'Le morceau dépasse Content-Length.');
      }
      part.copy(data, received);
      received += part.length;
    }
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ECONNRESET' || req.aborted) throw httpError(400, 'Envoi interrompu.');
    throw error;
  }
  if (received !== expectedLength) {
    throw httpError(400, `Morceau incomplet : ${expectedLength} octets annoncés, ${received} reçus.`);
  }
  return data;
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

    const { upload, resumed } = await uploadModel.createOrResume({
      userId: req.user.id, mimeType, totalSize, fingerprint, caption,
    });

    return res.status(resumed ? 200 : 201).json({
      ...present(upload),
      resumed,
      maxChunkBytes: uploadChunkMaxBytes,
    });
  } catch (error) {
    return next(error);
  }
}

// GET /api/uploads/:id  -> receivedBytes indique le prochain offset à envoyer.
async function getUpload(req, res, next) {
  try {
    const upload = await uploadModel.findOwned(parseUploadId(req.params.id), req.user.id);
    if (!upload) throw httpError(404, 'Session d’envoi introuvable.');
    return res.json({ ...present(upload), maxChunkBytes: uploadChunkMaxBytes });
  } catch (error) {
    return next(error);
  }
}

// PATCH /api/uploads/:id  Upload-Offset: <octets reçus>  body: octets bruts.
// Le morceau est validé puis enregistré en BYTEA avec son offset dans une transaction.
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

    const total = Number(upload.total_size);
    const dbOffset = Number(upload.received_bytes);
    const offset = Number(req.get('upload-offset'));
    const length = Number(req.get('content-length'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'En-tête Upload-Offset invalide.');
    if (!Number.isSafeInteger(length) || length < 1 || length > uploadChunkMaxBytes) {
      throw httpError(400, `Content-Length doit être compris entre 1 et ${uploadChunkMaxBytes} octets.`);
    }
    if (offset + length > total) throw httpError(400, 'Ce morceau dépasse la taille annoncée.');
    if (offset !== dbOffset) return offsetConflict(res, dbOffset);

    const data = await readChunkBody(req, length);
    const result = await uploadModel.appendChunk(uploadId, req.user.id, offset, data);
    if (result.kind === 'not_found' || result.kind === 'inactive') {
      throw httpError(404, 'Session d’envoi introuvable ou terminée.');
    }
    if (result.kind === 'offset_conflict') return offsetConflict(res, result.receivedBytes);
    if (result.kind === 'overflow') throw httpError(400, 'Ce morceau dépasse la taille annoncée.');

    res.set('Upload-Offset', String(result.receivedBytes));
    return res.json({
      uploadId,
      videoId: Number(upload.video_id),
      chunkNumber: result.chunkNumber,
      receivedBytes: result.receivedBytes,
      totalSize: result.totalSize,
    });
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

// Vérifie les premiers octets : conteneur MP4/MOV/3GP (ftyp) ou WebM/Matroska (EBML).
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

async function* orderedChunkData(uploadId, chunkCount, totalSize) {
  let expectedOffset = 0;
  for (let chunkNumber = 0; chunkNumber < chunkCount; chunkNumber += 1) {
    const chunk = await uploadModel.getChunk(uploadId, chunkNumber);
    if (!chunk) throw httpError(409, `Le morceau ${chunkNumber} manque dans PostgreSQL.`);

    const data = Buffer.isBuffer(chunk.data) ? chunk.data : Buffer.from(chunk.data);
    const byteOffset = Number(chunk.byte_offset);
    const chunkSize = Number(chunk.chunk_size);
    if (byteOffset !== expectedOffset || chunkSize !== data.length || data.length < 1) {
      throw httpError(409, `Le morceau ${chunkNumber} ne suit pas l’ordre attendu.`);
    }
    expectedOffset += data.length;
    if (expectedOffset > totalSize) throw httpError(409, 'Les morceaux dépassent la taille annoncée.');
    yield data;
  }
  if (expectedOffset !== totalSize) throw httpError(409, 'Les morceaux ne forment pas la taille annoncée.');
}

// Assemble en flux depuis PostgreSQL : un seul morceau à la fois est chargé en mémoire.
async function assembleUpload(uploadId, totalSize, destination) {
  const stats = await uploadModel.getChunkStats(uploadId);
  if (!stats.chunkCount || stats.totalBytes !== totalSize) {
    throw httpError(409, 'Les morceaux enregistrés ne correspondent pas à la taille de la vidéo.');
  }

  await removeIfPresent(destination);
  await pipeline(
    Readable.from(orderedChunkData(uploadId, stats.chunkCount, totalSize)),
    fs.createWriteStream(destination, { flags: 'wx' })
  );

  const stat = await fsp.stat(destination);
  if (stat.size !== totalSize) throw httpError(409, 'Le fichier assemblé est incomplet.');
}

// POST /api/uploads/:id/complete
async function completeUpload(req, res, next) {
  const uploadId = parseUploadId(req.params.id);
  if (inflight.has(uploadId) || completing.has(uploadId)) {
    return next(httpError(409, 'Un envoi est encore en cours.'));
  }
  completing.add(uploadId);
  const assemblingFile = assemblyTmpPath(uploadId);
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

    await fsp.mkdir(sourcesDir, { recursive: true });
    try {
      await assembleUpload(uploadId, total, assemblingFile);
    } catch (error) {
      await removeIfPresent(assemblingFile).catch(() => {});
      throw error;
    }

    if (!(await looksLikeVideo(assemblingFile))) {
      await uploadModel.abort(uploadId, req.user.id);
      await removeIfPresent(assemblingFile).catch(() => {});
      await removeIfPresent(legacyTmpPath(uploadId)).catch(() => {});
      throw httpError(422, 'Le fichier reçu n’est pas une vidéo reconnue.');
    }

    const sourceName = `${upload.video_id}${EXTENSIONS[upload.mime_type]}`;
    const sourcePath = path.join(sourcesDir, sourceName);
    // Une tentative précédente peut avoir assemblé le fichier puis s'être arrêtée
    // avant la transaction finale. Les morceaux sont encore en base : on peut refaire.
    await removeIfPresent(sourcePath);
    await fsp.rename(assemblingFile, sourcePath);

    const videoId = await uploadModel.complete(uploadId, req.user.id, sourceName);
    if (!videoId) {
      const current = await uploadModel.findOwned(uploadId, req.user.id);
      if (!current || current.status !== 'complete') {
        throw httpError(409, 'La session a changé pendant l’assemblage. Réessayez.');
      }
    }

    await removeIfPresent(legacyTmpPath(uploadId)).catch((error) => {
      logger.error('legacy_upload_tmp_cleanup_failed', { uploadId, message: error.message });
    });
    const completedVideoId = videoId || Number(upload.video_id);
    queue.enqueue(completedVideoId);
    return res.status(202).json({
      uploadId,
      videoId: completedVideoId,
      status: 'processing',
      message: 'Vidéo assemblée depuis PostgreSQL : transcodage HLS en cours.',
    });
  } catch (error) {
    await removeIfPresent(assemblingFile).catch(() => {});
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
    await removeIfPresent(legacyTmpPath(uploadId)).catch((error) => {
      logger.error('upload_tmp_cleanup_failed', { uploadId, message: error.message });
    });
    await removeIfPresent(assemblyTmpPath(uploadId)).catch((error) => {
      logger.error('upload_assembly_tmp_cleanup_failed', { uploadId, message: error.message });
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
}

module.exports = { createUpload, getUpload, appendChunk, completeUpload, abortUpload };
