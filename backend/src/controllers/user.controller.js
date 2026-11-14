const userModel = require('../models/user.model');
const followModel = require('../models/follow.model');
const events = require('../services/events.service');
const { httpError } = require('../utils/httpError');

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, 'Identifiant d’utilisateur invalide.');
  return id;
}

function presentProfile(row, viewerId) {
  return {
    id: row.id,
    name: row.full_name,
    createdAt: row.created_at,
    videoCount: row.video_count,
    followerCount: row.follower_count,
    followingCount: row.following_count,
    likeCount: row.like_count,
    followedByMe: row.followed_by_me,
    isMe: viewerId === row.id,
  };
}

// GET /api/users/:id : profil public (la liste des vidéos vient de GET /api/videos?author=<id>)
async function getProfile(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const viewerId = req.user ? req.user.id : null;
    const row = await userModel.findPublicProfile(id, viewerId);
    if (!row) throw httpError(404, 'Utilisateur introuvable.');
    return res.json({ user: presentProfile(row, viewerId) });
  } catch (error) {
    return next(error);
  }
}

// POST / DELETE /api/users/:id/follow
function setFollow(following) {
  return async (req, res, next) => {
    try {
      const targetId = parseId(req.params.id);
      if (targetId === req.user.id) throw httpError(400, 'Vous ne pouvez pas vous suivre vous-même.');
      if (!(await userModel.findActiveById(targetId))) throw httpError(404, 'Utilisateur introuvable.');

      const changed = following
        ? await followModel.follow(req.user.id, targetId)
        : await followModel.unfollow(req.user.id, targetId);
      const followerCount = await followModel.followerCount(targetId);

      if (changed) {
        events.broadcast('user.stats', { userId: targetId, followerCount });
        if (following) {
          // Notification en direct pour la personne suivie.
          const me = await userModel.findActiveById(req.user.id);
          events.emitToUser(targetId, 'follow.new', {
            follower: { id: req.user.id, name: me ? me.full_name : '' },
            followerCount,
          });
        }
      }
      return res.json({ following, followerCount });
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { getProfile, setFollow };
