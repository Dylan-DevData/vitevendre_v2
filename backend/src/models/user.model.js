const { query } = require('../config/db');

async function findByPhone(phone) {
  const { rows } = await query(
    `SELECT id, phone, password_hash, full_name, role, status
     FROM users WHERE phone = $1`,
    [phone]
  );
  return rows[0] || null;
}

async function findActiveById(id) {
  const { rows } = await query(
    `SELECT id, phone, full_name, role, status
     FROM users WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return rows[0] || null;
}

async function createUser({ phone, passwordHash, fullName }) {
  const { rows } = await query(
    `INSERT INTO users (phone, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, phone, full_name, role, created_at`,
    [phone, passwordHash, fullName]
  );
  return rows[0];
}

// Profil public : compteurs + "est-ce que le demandeur suit cette personne ?".
async function findPublicProfile(id, viewerId) {
  const { rows } = await query(
    `SELECT u.id, u.full_name, u.created_at,
            (SELECT count(*)::int FROM videos v WHERE v.user_id = u.id AND v.status = 'ready') AS video_count,
            (SELECT count(*)::int FROM follows f WHERE f.followee_id = u.id) AS follower_count,
            (SELECT count(*)::int FROM follows f WHERE f.follower_id = u.id) AS following_count,
            (SELECT count(*)::int FROM video_likes l JOIN videos v ON v.id = l.video_id
              WHERE v.user_id = u.id AND v.status = 'ready') AS like_count,
            EXISTS (SELECT 1 FROM follows f WHERE f.followee_id = u.id AND f.follower_id = $2) AS followed_by_me
     FROM users u
     WHERE u.id = $1 AND u.status = 'active'`,
    [id, viewerId]
  );
  return rows[0] || null;
}

module.exports = { findByPhone, findActiveById, createUser, findPublicProfile };
