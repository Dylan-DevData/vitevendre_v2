const { query, withTransaction } = require('../config/db');

const COLUMNS = `id, user_id, video_id, mime_type, total_size, received_bytes,
                 fingerprint, status, updated_at`;

// Ouvre une session. Si le même utilisateur renvoie le même fichier (même empreinte)
// alors qu'une session est encore active, on la reprend au lieu d'en créer une autre.
async function createOrResume({ userId, mimeType, totalSize, fingerprint, caption }) {
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

// Insère un morceau et avance l'offset dans une seule transaction. Le verrou de
// la ligne upload sérialise aussi deux PATCH concurrents provenant de serveurs différents.
async function appendChunk(uploadId, userId, offset, data) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, video_id, total_size, received_bytes, status
       FROM uploads WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [uploadId, userId]
    );
    const upload = rows[0];
    if (!upload) return { kind: 'not_found' };
    if (upload.status !== 'in_progress') return { kind: 'inactive' };

    const totalSize = Number(upload.total_size);
    const receivedBytes = Number(upload.received_bytes);
    if (offset !== receivedBytes) {
      return { kind: 'offset_conflict', receivedBytes, totalSize };
    }
    if (offset + data.length > totalSize) return { kind: 'overflow', receivedBytes, totalSize };

    const sequence = await client.query(
      `SELECT COALESCE(MAX(chunk_number) + 1, 0)::bigint AS next_chunk_number
       FROM upload_chunks WHERE upload_id = $1`,
      [uploadId]
    );
    const chunkNumber = Number(sequence.rows[0].next_chunk_number);

    await client.query(
      `INSERT INTO upload_chunks
         (upload_id, video_id, chunk_number, byte_offset, chunk_size, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, upload.video_id, chunkNumber, offset, data.length, data]
    );

    const updated = await client.query(
      `UPDATE uploads
       SET received_bytes = $4, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'in_progress' AND received_bytes = $3
       RETURNING received_bytes`,
      [uploadId, userId, receivedBytes, receivedBytes + data.length]
    );
    if (!updated.rows[0]) {
      // Throwing rolls back the chunk insert too; the byte offset can never get ahead
      // of the data that was actually committed.
      const error = new Error('La session a changé pendant l’envoi du morceau.');
      error.status = 409;
      throw error;
    }

    return {
      kind: 'stored',
      chunkNumber,
      receivedBytes: Number(updated.rows[0].received_bytes),
      totalSize,
    };
  });
}

async function getChunkStats(uploadId) {
  const { rows } = await query(
    `SELECT COUNT(*)::bigint AS chunk_count,
            COALESCE(SUM(chunk_size), 0)::bigint AS total_bytes
     FROM upload_chunks WHERE upload_id = $1`,
    [uploadId]
  );
  return {
    chunkCount: Number(rows[0].chunk_count),
    totalBytes: Number(rows[0].total_bytes),
  };
}

async function getChunk(uploadId, chunkNumber) {
  const { rows } = await query(
    `SELECT byte_offset, chunk_size, data
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
         AND received_bytes = total_size
       RETURNING video_id`,
      [uploadId, userId]
    );
    if (!rows[0]) return null;

    await client.query(
      `UPDATE videos SET status = 'processing', source_name = $2 WHERE id = $1`,
      [rows[0].video_id, sourceName]
    );
    // Garder les morceaux jusqu'à ce que le fichier assemblé soit vérifié et renommé.
    // Leur suppression et le changement d'état sont atomiques dans cette transaction.
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
};
