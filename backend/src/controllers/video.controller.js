const videoModel = require('../models/video.model');
const events = require('../services/events.service');
const { httpError } = require('../utils/httpError');

function parseId(value, message) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, message);
  return id;
}

// GET /api/videos?before=<id>&limit=10&author=<id|me>
async function listFeed(req, res, next) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
    const before = req.query.before === undefined ? null : parseId(req.query.before, 'Curseur invalide.');
    let authorId = null;
    if (req.query.author === 'me') {
      if (!req.user) throw httpError(401, 'Authentification requise.');
      authorId = req.user.id;
    } else if (req.query.author !== undefined) {
      authorId = parseId(req.query.author, 'Auteur invalide.');
    }
    const videos = await videoModel.feed({
      viewerId: req.user ? req.user.id : null, beforeId: before, limit, authorId,
    });
    return res.json({
      videos,
      nextBefore: videos.length === limit ? videos[videos.length - 1].id : null,
    });
  } catch (error) {
    return next(error);
  }
}

// GET /api/videos/:id
async function getVideo(req, res, next) {
  try {
    const id = parseId(req.params.id, 'Identifiant de vidéo invalide.');
    const video = await videoModel.findVisible(id, req.user ? req.user.id : null);
    if (!video) throw httpError(404, 'Vidéo introuvable.');
    return res.json({ video });
  } catch (error) {
    return next(error);
  }
}

// POST / DELETE /api/videos/:id/like
function like(liked) {
  return async (req, res, next) => {
    try {
      const id = parseId(req.params.id, 'Identifiant de vidéo invalide.');
      const result = await videoModel.setLike(req.user.id, id, liked);
      if (!result) throw httpError(404, 'Vidéo introuvable.');
      // Temps réel : le compteur de J'aime se met à jour chez tous les spectateurs.
      events.broadcast('video.stats', { videoId: id, likeCount: result.likeCount });
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { listFeed, getVideo, like };
