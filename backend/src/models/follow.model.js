const { query } = require('../config/db');

async function followerCount(userId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM follows WHERE followee_id = $1', [userId]);
  return rows[0].n;
}

// Retourne true si l'abonnement vient d'être créé (false s'il existait déjà).
async function follow(followerId, followeeId) {
  const result = await query(
    'INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [followerId, followeeId]
  );
  return result.rowCount === 1;
}

async function unfollow(followerId, followeeId) {
  const result = await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [followerId, followeeId]);
  return result.rowCount === 1;
}

module.exports = { followerCount, follow, unfollow };
