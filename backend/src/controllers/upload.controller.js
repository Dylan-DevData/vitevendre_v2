const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const uploadModel = require('../models/upload.model');
const queue = require('../services/transcode-queue.service');
const { assembleMp4, supportedProtocols, concatPartsToFile } = require('../services/ffmpeg.service');
const { sessionsDir, sourcesDir, maxVideoBytes, uploadChunkMaxBytes } = require('../config/env');
const { httpError } = require('../utils/httpError');
const logger = require('../utils/logger');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Ces conteneurs sont acceptés en entrée; le fichier validé en sortie est toujours MP4.
const ACCEPTED_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp']);

// Un seul PATCH à la fois par session dans ce processus. La transaction PostgreSQL
// de appendChunk sérialise également les requêtes si plusieurs processus sont lancés.
const inflight = new Map();
const completing = new Set();

// Chaque session vit dans son propre dossier uploads/sessions/<uploadId>/ :
// les .part (<n>.part), le .meta.json, les temporaires et le journal d'assemblage.
// Une vidéo = un dossier : aucune session n'encombre les autres, et le nettoyage
// est un seul rm récursif.
const sessionDirOf = (uploadId) => path.join(sessionsDir, uploadId);
const concatManifestPath = (uploadId) => path.join(sessionDirOf(uploadId), 'concat.tmp');
const combinedPartsPath = (uploadId) => path.join(sessionDirOf(uploadId), 'combined.tmp');
const uploadMetadataPath = (uploadId) => path.join(sessionDirOf(uploadId), 'meta.json');
const assemblyTmpPath = (uploadId) => path.join(sourcesDir, `${uploadId}.assembling.mp4`);
const stagingTmpPath = (uploadId) => path.join(sessionDirOf(uploadId), `${crypto.randomUUID()}.incoming.tmp`);

function parseUploadId(value) {
  if (!UUID_PATTERN.test(value)) throw httpError(400, 'Identifiant d’envoi invalide.');
  return value.toLowerCase();
}

function present(upload, totalSize, receivedBytes) {
  return {
    uploadId: upload.id,
    videoId: Number(upload.video_id),
    status: upload.status,
    totalSize,
    receivedBytes,
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

// Suppression des fichiers temporaires du dossier de session.
// Par défaut (Retirer, échec, session abandonnée) : rm récursif, il ne reste plus rien.
// Avec keepMetadata (assemblage RÉUSSI) : seuls les temporaires sont supprimés
// (combined.tmp, *.incoming.tmp, assembly-error.log). Les .part, meta.json et le
// manifeste concat.tmp (l'inputPath de FFmpeg, quelques centaines d'octets) RESTENT
// dans le dossier de session : la session reste reconstituable — ré-assemblage
// immédiat puisque le manifeste pointe déjà vers les .part — tant que le GC n'a
// pas supprimé le dossier entier (session non in_progress + TTL 24 h dépassé).
const PERSISTENT_SESSION_FILE = (name) => name === 'meta.json' || name === 'concat.tmp' || /^\d+\.part$/.test(name);

async function removeUploadFiles(uploadId, { keepMetadata = false } = {}) {
  const sessionDir = sessionDirOf(uploadId);
  if (!keepMetadata) {
    await fsp.rm(sessionDir, { recursive: true, force: true });
    return;
  }
  const entries = await fsp.readdir(sessionDir).catch(() => []);
  await Promise.all(entries
    .filter((name) => !PERSISTENT_SESSION_FILE(name))
    .map((name) => fsp.rm(path.join(sessionDir, name), { recursive: true, force: true })));
}

// La taille réelle est un petit fichier de session sur disque, jamais une colonne SQL.
// La vidéo elle-même reste uniquement dans les fichiers .part.
async function readUploadTotalSize(uploadId) {
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(uploadMetadataPath(uploadId), 'utf8'));
  } catch (cause) {
    const error = httpError(409, 'Les métadonnées de cette session sont absentes ou illisibles.');
    error.cause = cause;
    throw error;
  }
  if (!Number.isSafeInteger(metadata.totalSize) || metadata.totalSize < 1) {
    throw httpError(409, 'La taille de la session est invalide.');
  }
  return metadata.totalSize;
}

async function ensureUploadMetadata(uploadId, totalSize) {
  const metadataPath = uploadMetadataPath(uploadId);
  try {
    const existing = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
    if (existing.totalSize !== totalSize) throw httpError(409, 'La taille ne correspond pas à cette session.');
    return;
  } catch (error) {
    if (error.status) throw error;
    if (!isMissing(error)) throw httpError(409, 'Les métadonnées de cette session sont illisibles.');
  }

  const temporary = `${metadataPath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify({ totalSize }), { flag: 'wx' });
  try {
    await fsp.rename(temporary, metadataPath);
  } finally {
    await removeIfPresent(temporary).catch(() => {});
  }
}

// Lit le corps binaire du PATCH, jamais le fichier vidéo complet. `expectedLength` a déjà
// été comparé à UPLOAD_CHUNK_MAX_BYTES : ce Buffer ne contient donc que le morceau courant.
// On vérifie les octets réellement reçus avant d'écrire un .part, pour qu'une coupure réseau
// ne crée pas une référence vers un fichier incomplet.
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

// POST /api/uploads { mime_type, total_size, fingerprint, caption }.
// `total_size` est écrit dans le petit fichier .meta.json sur disque, pas dans PostgreSQL.
// Le champ fingerprint est une clé de reprise légère; cette requête ne transporte aucun octet vidéo.
async function createUpload(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mimeType = body.mime_type;
    const totalSize = Number(body.total_size);
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.toLowerCase() : '';
    const caption = typeof body.caption === 'string' ? body.caption.trim() : '';

    if (!ACCEPTED_MIME_TYPES.has(mimeType)) throw httpError(415, 'Type de vidéo non accepté.');
    if (!Number.isSafeInteger(totalSize) || totalSize < 1
      || (maxVideoBytes > 0 && totalSize > maxVideoBytes)) {
      throw httpError(413, 'La taille de la vidéo est invalide ou trop élevée.');
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw httpError(400, 'L’empreinte doit contenir 64 caractères hexadécimaux.');
    }
    if (caption.length > 300) throw httpError(400, 'La légende dépasse 300 caractères.');

    const { upload, resumed } = await uploadModel.createOrResume({
      userId: req.user.id, mimeType, fingerprint, caption,
    });
    await fsp.mkdir(sessionDirOf(upload.id), { recursive: true });
    await ensureUploadMetadata(upload.id, totalSize);
    const progress = await uploadModel.getChunkStats(upload.id);

    return res.status(resumed ? 200 : 201).json({
      ...present(upload, totalSize, progress.totalBytes),
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
    const totalSize = await readUploadTotalSize(upload.id);
    const receivedBytes = upload.status === 'complete'
      ? totalSize
      : (await uploadModel.getChunkStats(upload.id)).totalBytes;
    return res.json({ ...present(upload, totalSize, receivedBytes), maxChunkBytes: uploadChunkMaxBytes });
  } catch (error) {
    return next(error);
  }
}

// PATCH /api/uploads/:id reçoit une tranche brute avec Upload-Offset.
// Étapes : valider la session et l'offset; lire exactement Content-Length; écrire le morceau
// dans un temporaire; demander au modèle de le renommer en .part puis d'inscrire sa référence.
// Aucune taille réelle et aucun octet du morceau ne sont écrits dans une colonne PostgreSQL.
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

    const total = await readUploadTotalSize(uploadId);
    const dbOffset = (await uploadModel.getChunkStats(uploadId)).totalBytes;
    const offset = Number(req.get('upload-offset'));
    const length = Number(req.get('content-length'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, 'En-tête Upload-Offset invalide.');
    if (!Number.isSafeInteger(length) || length < 1 || length > uploadChunkMaxBytes) {
      throw httpError(400, `Content-Length doit être compris entre 1 et ${uploadChunkMaxBytes} octets.`);
    }
    if (offset + length > total) throw httpError(400, 'Ce morceau dépasse la taille annoncée.');
    if (offset !== dbOffset) return offsetConflict(res, dbOffset);

    const data = await readChunkBody(req, length);
    const stagingPath = stagingTmpPath(uploadId);
    let result;
    try {
      await fsp.writeFile(stagingPath, data, { flag: 'wx' });
      result = await uploadModel.appendChunk(uploadId, req.user.id, offset, data.length, total, stagingPath);
    } finally {
      await removeIfPresent(stagingPath);
    }
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

// Prépare l'entrée de FFmpeg en fonction des protocoles réellement disponibles,
// sans jamais lire ni recopier inutilement le contenu des .part en Node :
//  1. `concatf:` (FFmpeg >= 8) lit un manifeste de chemins, ordre et existence déjà validés.
//  2. `concat:` (universel) concatène au niveau des octets via des URLs séparées par `|;
//     plafonné par la longueur de ligne de commande.
//  3. Sinon, concaténation Node en un fichier temporaire (un .part lu à la fois).
// Un uploadId correspond à une vidéo; plusieurs vidéos ont des sessions et MP4 séparés.
const MAX_CONCAT_URL_CHARS = 16000;
// Relance limitée quand l'assemblage échoue sans cause fatale : sur Windows, un
// antivirus peut verrouiller un .part ou le MP4 provisoire pendant la écriture FFmpeg.
const ASSEMBLY_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assembleWithRetry(input, outputPath, runOptions) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await assembleMp4(input, outputPath, runOptions);
    } catch (error) {
      // Sans protocole compatible ou sans FFmpeg fonctionnel, réessayer ne change rien.
      if (error.code === 'FFMPEG_CONCATF_UNAVAILABLE' || error.status === 503 || attempt >= ASSEMBLY_ATTEMPTS) throw error;
      await sleep(300 * attempt);
    }
  }
}

async function prepareFfmpegInput(uploadId, totalSize) {
  const stats = await uploadModel.getChunkStats(uploadId);
  if (!stats.chunkCount || stats.totalBytes !== totalSize) {
    throw httpError(409, 'Les morceaux enregistrés ne correspondent pas à la taille de la vidéo.');
  }

  const partNames = [];
  let expectedOffset = 0;
  for (let chunkNumber = 0; chunkNumber < stats.chunkCount; chunkNumber += 1) {
    const chunk = await uploadModel.getChunk(uploadId, chunkNumber);
    if (!chunk) throw httpError(409, `La référence du morceau ${chunkNumber} manque dans PostgreSQL.`);
    if (Number(chunk.chunk_number) !== chunkNumber) {
      throw httpError(409, `Le morceau ${chunkNumber} ne suit pas l’ordre attendu.`);
    }
    const expectedName = `${chunkNumber}.part`;
    if (chunk.part_name !== expectedName || path.basename(chunk.part_name) !== chunk.part_name) {
      throw httpError(409, `La référence du morceau ${chunkNumber} est invalide.`);
    }
    const stat = await fsp.stat(path.join(sessionDirOf(uploadId), expectedName)).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!stat || !stat.isFile() || stat.size < 1) {
      throw httpError(409, `Le fichier du morceau ${chunkNumber} est absent ou vide.`);
    }
    expectedOffset += stat.size;
    if (expectedOffset > totalSize) throw httpError(409, 'Les morceaux dépassent la taille annoncée.');
    partNames.push(expectedName);
  }
  if (expectedOffset !== totalSize) throw httpError(409, 'Les morceaux ne forment pas la taille annoncée.');

  let protocols;
  try {
    protocols = await supportedProtocols();
  } catch (error) {
    throw httpError(503, 'Impossible d’interroger FFmpeg pour choisir la méthode d’assemblage.');
  }

  if (protocols.has('concatf')) {
    const manifestPath = concatManifestPath(uploadId);
    await removeIfPresent(manifestPath);
    // Les noms générés ne contiennent ni chemin ni caractère de contrôle; une ligne
    // du manifeste pointe exactement vers un .part déjà validé dans le dossier de session.
    await fsp.writeFile(manifestPath, `${partNames.join('\n')}\n`, { flag: 'wx' });
    return { input: `concatf:${path.basename(manifestPath)}`, cwd: sessionDirOf(uploadId), temporaryPath: manifestPath };
  }

  const concatUrl = `concat:${partNames.join('|')}`;
  if (protocols.has('concat') && concatUrl.length <= MAX_CONCAT_URL_CHARS) {
    return { input: concatUrl, cwd: sessionDirOf(uploadId), temporaryPath: null };
  }

  const combinedPath = combinedPartsPath(uploadId);
  await concatPartsToFile(partNames.map((name) => path.join(sessionDirOf(uploadId), name)), combinedPath);
  return { input: combinedPath, cwd: sessionDirOf(uploadId), temporaryPath: combinedPath };
}

// POST /api/uploads/:id/complete.
// Quand tous les morceaux sont présents, FFmpeg les lit via le manifeste et produit le MP4.
// Après validation par FFprobe, le MP4 est conservé comme source; les références PostgreSQL
// et les fichiers .part sont supprimés, puis la file lance le passage FFmpeg vers HLS.
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
      const totalSize = await readUploadTotalSize(uploadId);
      // Reprise d'un complete déjà traité : nettoyer les morceaux restants, garde meta.json.
      await removeUploadFiles(uploadId, { keepMetadata: true }).catch((error) => {
        logger.error('upload_parts_cleanup_failed', { uploadId, message: error.message });
      });
      queue.enqueue(Number(upload.video_id));
      return res.status(200).json({
        ...present(upload, totalSize, totalSize),
        message: 'Déjà en cours de traitement.',
      });
    }
    if (upload.status !== 'in_progress') throw httpError(409, 'Cette session est terminée.');

    const total = await readUploadTotalSize(uploadId);
    const receivedBytes = (await uploadModel.getChunkStats(uploadId)).totalBytes;
    if (receivedBytes !== total) {
      return res.status(409).json({
        error: 'Il manque encore des octets.',
        receivedBytes,
        totalSize: total,
      });
    }

    await fsp.mkdir(sessionDirOf(uploadId), { recursive: true });
    await fsp.mkdir(sourcesDir, { recursive: true });
    let ffmpegInput;
    try {
      ffmpegInput = await prepareFfmpegInput(uploadId, total);
      // FFmpeg lit la suite ordonnée des .part (concatf, concat: ou fichier combiné
      // en dernier repli) et écrit le MP4 final. Le repli Node n'est atteint que si
      // aucun protocole concat n'existe sur ce FFmpeg.
      await assembleWithRetry(ffmpegInput.input, assemblingFile, { cwd: ffmpegInput.cwd });
    } catch (error) {
      if (error.status === 422) {
        // L'assemblage échoue rarement : garder le stderr FFmpeg dans le log est la
        // seule façon de diagnostiquer un média réel qui refuse copie et réencodage.
        logger.error('upload_assembly_failed', {
          uploadId,
          status: error.status,
          message: error.message,
          details: error.details ? String(error.details).slice(-1200) : null,
        });
        // On écrit aussi le détail sur disque, et on CONSERVE la session et les .part :
        // l'échec reste relançable (Reprendre) et reproductible octet pour octet.
        await fsp.writeFile(
          path.join(sessionDirOf(uploadId), 'assembly-error.log'),
          `${new Date().toISOString()}\n${error.message}\n${error.details || ''}`,
          'utf8',
        ).catch(() => {});
      }
      throw error;
    } finally {
      // Le manifeste concat.tmp (inputPath concatf:) est CONSERVÉ dans le dossier de
      // session pour réutiliser l'assemblage plus tard. Seul combined.tmp — la copie
      // complète de la vidéo du repli Node — reste un temporaire à supprimer.
      if (ffmpegInput && ffmpegInput.temporaryPath && ffmpegInput.temporaryPath === combinedPartsPath(uploadId)) {
        await removeIfPresent(ffmpegInput.temporaryPath).catch(() => {});
      }
    }

    if (!(await looksLikeVideo(assemblingFile))) {
      await uploadModel.abort(uploadId, req.user.id);
      await removeUploadFiles(uploadId).catch(() => {});
      await removeIfPresent(assemblingFile).catch(() => {});
      throw httpError(422, 'Le fichier reçu n’est pas une vidéo reconnue.');
    }

    const sourceName = `${upload.video_id}.mp4`;
    const sourcePath = path.join(sourcesDir, sourceName);
    // Si une tentative précédente s'est arrêtée avant la transaction finale, les références
    // et .part existent encore; on peut remplacer la sortie provisoire et refaire l'assemblage.
    // VARIANTE A (active, production) : le MP4 assemblé est PROVISOIRE. La file HLS le lit,
    // puis transcode-queue.service.js supprime la source après transcodage réussi : seuls les
    // .ts/.m3u8 restent. Aucun MP4 lisible ne subsiste sur le serveur.
    await removeIfPresent(sourcePath);
    await fsp.rename(assemblingFile, sourcePath);
    // VARIANTE B (commentée, TEST) : conserver en plus une copie TOUJOURS LISIBLE du MP4
    // assemblé, distincte de la source de la file, pour l'ouvrir dans VLC ou la passer à
    // ffprobe après un upload réel sur le téléphone. Décommentez la ligne, redémarrez l'API,
    // envoyez une vidéo, puis inspectez uploads/sources/<videoId>.assembled-test.mp4. Rien
    // ne la supprime : ni la file HLS (elle ne retire que <videoId>.mp4), ni le GC (il ne
    // touche que uploads/sessions). Recommentez après le test pour ne pas remplir le disque.
    // await fsp.copyFile(assemblingFile, path.join(sourcesDir, `${upload.video_id}.assembled-test.mp4`));

    const videoId = await uploadModel.complete(uploadId, req.user.id, sourceName);
    if (!videoId) {
      const current = await uploadModel.findOwned(uploadId, req.user.id);
      if (!current || current.status !== 'complete') {
        throw httpError(409, 'La session a changé pendant l’assemblage. Réessayez.');
      }
    }

    // Succès : temporaires et combined.tmp disparaissent ; les .part, meta.json et
    // le manifeste concat.tmp restent pour réutiliser l'assemblage, jusqu'au GC.
    await removeUploadFiles(uploadId, { keepMetadata: true }).catch((error) => {
      logger.error('upload_parts_cleanup_failed', { uploadId, message: error.message });
    });
    const completedVideoId = videoId || Number(upload.video_id);
    queue.enqueue(completedVideoId);
    return res.status(202).json({
      uploadId,
      videoId: completedVideoId,
      status: 'processing',
      message: 'FFmpeg a assemblé le MP4 ; le transcodage HLS est en cours.',
    });
  } catch (error) {
    // Le manifeste concat.tmp est conservé même en échec : la session reste
    // relançable avec son inputPath tel quel. Seuls combined.tmp et le MP4
    // provisoire partent.
    await removeIfPresent(combinedPartsPath(uploadId)).catch(() => {});
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
    await removeUploadFiles(uploadId).catch((error) => {
      logger.error('upload_parts_cleanup_failed', { uploadId, message: error.message });
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
