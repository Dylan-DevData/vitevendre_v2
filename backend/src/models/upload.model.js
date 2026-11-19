const { query, withTransaction } = require('../config/db');
const fs = require('fs/promises');
const path = require('path');
const { sessionsDir } = require('../config/env');

const COLUMNS = `id, user_id, video_id, mime_type, fingerprint, status, updated_at`;

// Ouvre une session idempotente. La clé de tâche stable permet qu'un POST réessayé
// après une coupure retrouve la session créée par le premier POST.
async function createOrResume({ userId, mimeType, fingerprint, caption }) {
  return withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT ${COLUMNS} FROM uploads
       WHERE user_id = $1 AND fingerprint = $2 AND status = 'in_progress'
       FOR UPDATE`,
      [userId, fingerprint]
    );
    if (existing.rows[0]) return { upload: existing.rows[0], resumed: true };

    const video = await client.query(
      'INSERT INTO videos (user_id, caption) VALUES ($1, $2) RETURNING id',
      [userId, caption]
    );
    const created = await client.query(
      `INSERT INTO uploads (user_id, video_id, mime_type, fingerprint)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [userId, video.rows[0].id, mimeType, fingerprint]
    );
    return { upload: created.rows[0], resumed: false };
  });
}

async function findOwned(uploadId, userId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM uploads WHERE id = $1 AND user_id = $2`,
    [uploadId, userId]
  );
  return rows[0] || null;
}

// PostgreSQL ne contient pas les octets ni les tailles des morceaux : seulement leur numéro
// et leur nom de fichier. Chaque session possède son dossier sessions/<uploadId>/ ; les .part
// s'y nomment <n>.part (n = numéro d'ordre). On calcule le prochain offset en faisant `stat`
// sur les .part référencés ; la somme retournée reste en mémoire et n'est jamais écrite en base.
async function readPartStats(uploadId, client = null) {
  const runQuery = client ? client.query.bind(client) : query;
  const { rows } = await runQuery(
    `SELECT chunk_number, part_name FROM upload_chunks
     WHERE upload_id = $1 ORDER BY chunk_number`,
    [uploadId]
  );
  let totalBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const expectedName = `${index}.part`;
    if (Number(rows[index].chunk_number) !== index || rows[index].part_name !== expectedName) {
      const error = new Error(`Référence du morceau ${index} invalide.`);
      error.status = 409;
      throw error;
    }
    const stat = await fs.stat(path.join(sessionsDir, uploadId, expectedName)).catch((cause) => {
      const error = new Error(`Fichier du morceau ${index} absent.`);
      error.status = 409;
      error.cause = cause;
      throw error;
    });
    if (!stat.isFile() || stat.size < 1) {
      const error = new Error(`Fichier du morceau ${index} vide ou invalide.`);
      error.status = 409;
      throw error;
    }
    totalBytes += stat.size;
  }
  return { chunkCount: rows.length, totalBytes };
}

// Dans la transaction, verrouille la session pour sérialiser les PATCH concurrents, renomme
// le temporaire en .part, puis insère uniquement upload_id/video_id/chunk_number/part_name.
// `chunkSize` sert aux validations et à la réponse HTTP; aucune taille réelle n'est persistée.
async function appendChunk(uploadId, userId, offset, chunkSize, totalSize, stagingPath) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, video_id, status
       FROM uploads WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [uploadId, userId]
    );
    const upload = rows[0];
    if (!upload) return { kind: 'not_found' };
    if (upload.status !== 'in_progress') return { kind: 'inactive' };

    // Une seule lecture des références calcule à la fois le prochain offset et le numéro
    // du nouveau fichier. Le verrou SQL empêche un autre PATCH d'ajouter un .part entre-temps.
    const partStats = await readPartStats(uploadId, client);
    const receivedBytes = partStats.totalBytes;
    if (offset !== receivedBytes) {
      return { kind: 'offset_conflict', receivedBytes, totalSize };
    }
    if (offset + chunkSize > totalSize) return { kind: 'overflow', receivedBytes, totalSize };

    const chunkNumber = partStats.chunkCount;
    // Nom court dans son dossier de session : sessions/<uploadId>/<n>.part.
    // Le contrôleur a créé le dossier à la création de la session.
    const partName = `${chunkNumber}.part`;
    const partPath = path.join(sessionsDir, uploadId, partName);

    // Après un crash, un .part sans référence peut rester sur disque : on le remplace.
    // Si le résultat du COMMIT est incertain, conserver le fichier permet au prochain GET
    // de le retrouver si la ligne a été validée; sinon le prochain PATCH le remplacera.
    await fs.unlink(partPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.rename(stagingPath, partPath);

    await client.query(
      `INSERT INTO upload_chunks
         (upload_id, video_id, chunk_number, part_name)
       VALUES ($1, $2, $3, $4)`,
      [uploadId, upload.video_id, chunkNumber, partName]
    );

    const updated = await client.query(
      `UPDATE uploads
       SET updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
       RETURNING id`,
      [uploadId, userId]
    );
    if (!updated.rows[0]) {
      const error = new Error('La session a changé pendant l’envoi du morceau.');
      error.status = 409;
      throw error;
    }

    return {
      kind: 'stored',
      chunkNumber,
      partName,
      receivedBytes: receivedBytes + chunkSize,
      totalSize,
    };
  });
}

async function getChunkStats(uploadId) {
  return readPartStats(uploadId);
}

async function getChunk(uploadId, chunkNumber) {
  const { rows } = await query(
    `SELECT chunk_number, part_name
     FROM upload_chunks WHERE upload_id = $1 AND chunk_number = $2`,
    [uploadId, chunkNumber]
  );
  return rows[0] || null;
}

async function complete(uploadId, userId, sourceName) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE uploads SET status = 'complete', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'in_progress'
       RETURNING video_id`,
      [uploadId, userId]
    );
    if (!rows[0]) return null;

    await client.query(
      `UPDATE videos SET status = 'processing', source_name = $2 WHERE id = $1`,
      [rows[0].video_id, sourceName]
    );
    // Garder les références jusqu'à validation et renommage du MP4 final.
    // Les références et l'état changent dans cette transaction; le contrôleur supprime
    // ensuite les fichiers .part correspondants.
    await client.query('DELETE FROM upload_chunks WHERE upload_id = $1', [uploadId]);
    return Number(rows[0].video_id);
  });
}

// La suppression de la vidéo cascade vers uploads puis vers upload_chunks.
async function abort(uploadId, userId) {
  const { rows } = await query(
    `DELETE FROM videos v USING uploads u
     WHERE u.id = $1 AND u.user_id = $2 AND u.status = 'in_progress' AND v.id = u.video_id
     RETURNING u.id`,
    [uploadId, userId]
  );
  return rows.length > 0;
}

async function listAbandoned(hours) {
  const { rows } = await query(
    `SELECT id, video_id FROM uploads
     WHERE status = 'in_progress' AND updated_at < now() - make_interval(hours => $1)
     LIMIT 500`,
    [hours]
  );
  return rows;
}

async function removeAbandoned(videoId) {
  await query(`DELETE FROM videos WHERE id = $1 AND status = 'uploading'`, [videoId]);
}

async function listActiveIds() {
  const { rows } = await query(`SELECT id FROM uploads WHERE status = 'in_progress'`);
  return new Set(rows.map((row) => row.id));
}

async function listKnownIds() {
  const { rows } = await query('SELECT id FROM uploads');
  return new Set(rows.map((row) => row.id));
}

module.exports = {
  createOrResume,
  findOwned,
  appendChunk,
  getChunkStats,
  getChunk,
  complete,
  abort,
  listAbandoned,
  removeAbandoned,
  listActiveIds,
  listKnownIds,
};
