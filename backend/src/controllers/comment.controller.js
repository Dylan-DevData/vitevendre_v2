const commentModel = require('../models/comment.model');
const videoModel = require('../models/video.model');
const events = require('../services/events.service');
const { httpError } = require('../utils/httpError');
const { createRateLimiter } = require('../utils/rateLimit');

const MAX_BODY = 500;
// 8 commentaires par minute et par personne : bloque le spam sans gêner une vraie discussion.
const postLimiter = createRateLimiter({ max: 8, windowMs: 60 * 1000 });

function parseId(value, message) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, message);
  return id;
}

// GET /api/videos/:id/comments?before=<id>&limit=20
async function listComments(req, res, next) {
  try {
    const videoId = parseId(req.params.id, 'Identifiant de vidéo invalide.');
    if (!(await videoModel.isReady(videoId))) throw httpError(404, 'Vidéo introuvable.');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const before = req.query.before === undefined ? null : parseId(req.query.before, 'Curseur invalide.');
    const [comments, total] = await Promise.all([
      commentModel.list({ videoId, beforeId: before, limit }),
      commentModel.count(videoId),
    ]);
    return res.json({
      comments,
      total,
      nextBefore: comments.length === limit ? comments[comments.length - 1].id : null,
    });
  } catch (error) {
    return next(error);
  }
}

// POST /api/videos/:id/comments   { "body": "..." }
async function addComment(req, res, next) {
  try {
    const videoId = parseId(req.params.id, 'Identifiant de vidéo invalide.');
    const raw = req.body && typeof req.body === 'object' ? req.body.body : undefined;
    const body = typeof raw === 'string' ? raw.trim() : '';
    if (!body) throw httpError(400, 'Le commentaire est vide.');
    if (body.length > MAX_BODY) throw httpError(400, `Le commentaire dépasse ${MAX_BODY} caractères.`);
    if (!(await videoModel.isReady(videoId))) throw httpError(404, 'Vidéo introuvable.');
    if (!postLimiter.take(req.user.id)) throw httpError(429, 'Doucement : trop de commentaires en peu de temps.');

    const comment = await commentModel.create({ videoId, userId: req.user.id, body });
    const commentCount = await commentModel.count(videoId);

    // Temps réel : ceux qui ont la fenêtre ouverte reçoivent le commentaire, tout le monde le nouveau compteur.
    events.emitToRoom(`video:${videoId}`, 'comment.new', { videoId, comment, commentCount });
    events.broadcast('video.stats', { videoId, commentCount });
    return res.status(201).json({ comment, commentCount });
  } catch (error) {
    return next(error);
  }
}

// DELETE /api/comments/:id : l'auteur du commentaire, le propriétaire de la vidéo ou un admin.
async function deleteComment(req, res, next) {
  try {
    const commentId = parseId(req.params.id, 'Identifiant de commentaire invalide.');
    const found = await commentModel.findWithOwner(commentId);
    if (!found) throw httpError(404, 'Commentaire introuvable.');
    const allowed = found.user_id === req.user.id
      || found.video_owner_id === req.user.id
      || req.user.role === 'admin';
    if (!allowed) throw httpError(403, 'Vous ne pouvez pas supprimer ce commentaire.');

    await commentModel.remove(commentId);
    const videoId = Number(found.video_id);
    const commentCount = await commentModel.count(videoId);
    events.emitToRoom(`video:${videoId}`, 'comment.deleted', { videoId, commentId, commentCount });
    events.broadcast('video.stats', { videoId, commentCount });
    return res.json({ deleted: true, commentCount });
  } catch (error) {
    return next(error);
  }
}

module.exports = { listComments, addComment, deleteComment };
