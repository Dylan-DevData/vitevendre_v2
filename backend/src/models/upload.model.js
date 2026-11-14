const { query, withTransaction } = require('../config/db');

const COLUMNS = `id, user_id, video_id, mime_type, total_size, received_bytes,
                 fingerprint, status, updated_at`;

// Ouvre une session. Si le même utilisateur renvoie le même fichier (même empreinte)
// alors qu'une session est encore active, on la reprend au lieu d'en créer une autre.
async function createOrResume({ userId, mimeType, totalSize, fingerprint, caption }) {
  return withTransaction(async (client) => {
    // Cherche d'abord une session active du même utilisateur et verrouille sa ligne pour reprise.
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
      `INSERT INTO uploads (user_id, video_id, mime_type, total_size, fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNS}`,
      [userId, video.rows[0].id, mimeType, totalSize, fingerprint]
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

// Avance le compteur seulement si personne d'autre ne l'a modifié (contrôle optimiste).
async function advance(uploadId, userId, fromOffset, toOffset) {
  // UPDATE conditionnel : aucun offset ne bouge si la session a changé entre-temps.
  const { rows } = await query(
    `UPDATE uploads
     SET received_bytes = $4, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'in_progress' AND received_bytes = $3
     RETURNING received_bytes`,
    [uploadId, userId, fromOffset, toOffset]
  );
  return rows[0] ? Number(rows[0].received_bytes) : null;
}

// Réaligne la base sur la taille réelle du fichier .tmp (coupure en cours d'écriture).
async function resetReceived(uploadId, bytes) {
  await query(
    `UPDATE uploads SET received_bytes = $2, updated_at = now()
     WHERE id = $1 AND status = 'in_progress'`,
    [uploadId, bytes]
  );
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
    // PostgreSQL stocke les métadonnées et l'état ; les octets vidéo restent dans les fichiers.
    await client.query(
      `UPDATE videos SET status = 'processing', source_name = $2 WHERE id = $1`,
      [rows[0].video_id, sourceName]
    );
    return Number(rows[0].video_id);
  });
}

// Annulation : la vidéo "uploading" est supprimée, ce qui supprime aussi la session (CASCADE).
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

module.exports = {
  createOrResume,
  findOwned,
  advance,
  resetReceived,
  complete,
  abort,
  listAbandoned,
  removeAbandoned,
  listActiveIds,
};
