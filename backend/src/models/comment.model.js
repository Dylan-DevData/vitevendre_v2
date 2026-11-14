const { query } = require('../config/db');

function present(row) {
  return {
    id: Number(row.id),
    videoId: Number(row.video_id),
    body: row.body,
    createdAt: row.created_at,
    author: { id: row.user_id, name: row.author_name },
  };
}

const SELECT_COMMENT = `
  SELECT c.id, c.video_id, c.user_id, c.body, c.created_at, u.full_name AS author_name
  FROM comments c JOIN users u ON u.id = c.user_id`;

// Commentaires d'une vidéo, du plus récent au plus ancien (curseur par id décroissant).
async function list({ videoId, beforeId, limit }) {
  const { rows } = await query(
    `${SELECT_COMMENT}
     WHERE c.video_id = $1 AND ($2::bigint IS NULL OR c.id < $2)
     ORDER BY c.id DESC
     LIMIT $3`,
    [videoId, beforeId, limit]
  );
  return rows.map(present);
}

async function count(videoId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM comments WHERE video_id = $1', [videoId]);
  return rows[0].n;
}

async function create({ videoId, userId, body }) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO comments (video_id, user_id, body) VALUES ($1, $2, $3)
       RETURNING id, video_id, user_id, body, created_at
     )
     SELECT i.*, u.full_name AS author_name FROM inserted i JOIN users u ON u.id = i.user_id`,
    [videoId, userId, body]
  );
  return present(rows[0]);
}

// Commentaire + propriétaire de la vidéo (pour décider qui a le droit de supprimer).
async function findWithOwner(commentId) {
  const { rows } = await query(
    `SELECT c.id, c.video_id, c.user_id, v.user_id AS video_owner_id
     FROM comments c JOIN videos v ON v.id = c.video_id
     WHERE c.id = $1`,
    [commentId]
  );
  return rows[0] || null;
}

async function remove(commentId) {
  await query('DELETE FROM comments WHERE id = $1', [commentId]);
}

module.exports = { list, count, create, findWithOwner, remove };
