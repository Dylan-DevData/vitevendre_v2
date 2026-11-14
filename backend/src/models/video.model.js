const { query } = require('../config/db');

async function getForProcessing(videoId) {
  const { rows } = await query(
    `SELECT id, user_id, source_name FROM videos WHERE id = $1 AND status IN ('processing', 'ready')`,
    [videoId]
  );
  return rows[0] || null;
}

// Les premières qualités existent : la vidéo devient visible dans le fil.
async function markReady(videoId, meta) {
  await query(
    `UPDATE videos
     SET status = 'ready', width = $2, height = $3, duration_s = $4,
         renditions = $5, poster_key = $6, published_at = now()
     WHERE id = $1`,
    [videoId, meta.width, meta.height, meta.duration, meta.renditions, meta.posterKey]
  );
}

async function setRenditions(videoId, renditions) {
  await query('UPDATE videos SET renditions = $2 WHERE id = $1', [videoId, renditions]);
}

async function markFailed(videoId) {
  await query(`UPDATE videos SET status = 'failed' WHERE id = $1`, [videoId]);
}

// Vidéos dont le transcodage a été interrompu par un arrêt du serveur.
async function listProcessing() {
  const { rows } = await query(
    `SELECT id FROM videos WHERE status = 'processing' ORDER BY id LIMIT 1000`
  );
  return rows.map((row) => Number(row.id));
}

const SELECT_VIDEO = `
  SELECT v.*, u.full_name AS author_name,
         (SELECT count(*)::int FROM video_likes l WHERE l.video_id = v.id) AS like_count,
         EXISTS (SELECT 1 FROM video_likes l WHERE l.video_id = v.id AND l.user_id = $1) AS liked_by_me,
         (SELECT count(*)::int FROM comments c WHERE c.video_id = v.id) AS comment_count,
         EXISTS (SELECT 1 FROM follows f WHERE f.followee_id = v.user_id AND f.follower_id = $1) AS author_followed_by_me
  FROM videos v JOIN users u ON u.id = v.user_id`;

function present(row) {
  return {
    id: Number(row.id),
    caption: row.caption,
    status: row.status,
    author: { id: row.user_id, name: row.author_name, followedByMe: row.author_followed_by_me },
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_s === null ? null : Number(row.duration_s),
    renditions: row.renditions,
    // Le client reçoit le master HLS ; il chargera ensuite les playlists de qualité et segments.
    hlsUrl: row.status === 'ready' ? `/media/videos/${row.id}/master.m3u8` : null,
    posterUrl: row.poster_key ? `/media/${row.poster_key}` : null,
    likeCount: row.like_count,
    likedByMe: row.liked_by_me,
    commentCount: row.comment_count,
    createdAt: row.created_at,
  };
}

// Fil d'actualité : curseur par id décroissant.
//  - sans authorId : vidéos prêtes de tout le monde ;
//  - avec authorId : vidéos de cet auteur (toutes, même en traitement, si c'est le demandeur).
async function feed({ viewerId, beforeId, limit, authorId = null }) {
  const { rows } = await query(
    `${SELECT_VIDEO}
     WHERE ($3::bigint IS NULL OR v.id < $3)
       AND (
         ($4::int IS NULL AND v.status = 'ready')
         OR ($4::int IS NOT NULL AND v.user_id = $4 AND (v.status = 'ready' OR v.user_id = $1))
       )
     ORDER BY v.id DESC
     LIMIT $2`,
    [viewerId, limit, beforeId, authorId]
  );
  return rows.map(present);
}

// Visible par son auteur (suivi du traitement) ou par tous si prête.
async function findVisible(videoId, viewerId) {
  const { rows } = await query(
    `${SELECT_VIDEO} WHERE v.id = $2 AND (v.status = 'ready' OR v.user_id = $1)`,
    [viewerId, videoId]
  );
  return rows[0] ? present(rows[0]) : null;
}

async function setLike(userId, videoId, liked) {
  const exists = await query(`SELECT 1 FROM videos WHERE id = $1 AND status = 'ready'`, [videoId]);
  if (!exists.rows.length) return null;
  if (liked) {
    await query(
      'INSERT INTO video_likes (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, videoId]
    );
  } else {
    await query('DELETE FROM video_likes WHERE user_id = $1 AND video_id = $2', [userId, videoId]);
  }
  const { rows } = await query('SELECT count(*)::int AS n FROM video_likes WHERE video_id = $1', [videoId]);
  return { liked, likeCount: rows[0].n };
}

async function isReady(videoId) {
  const { rows } = await query(`SELECT 1 FROM videos WHERE id = $1 AND status = 'ready'`, [videoId]);
  return rows.length > 0;
}

module.exports = {
  getForProcessing,
  markReady,
  setRenditions,
  markFailed,
  listProcessing,
  feed,
  findVisible,
  setLike,
  isReady,
};
