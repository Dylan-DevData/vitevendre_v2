const express = require('express');
const controller = require('../controllers/video.controller');
const comments = require('../controllers/comment.controller');
const { authenticate, optionalAuthenticate } = require('../middlewares/authenticate');

const router = express.Router();

router.get('/', optionalAuthenticate, controller.listFeed);
router.get('/:id', optionalAuthenticate, controller.getVideo);
router.post('/:id/like', authenticate, controller.like(true));
router.delete('/:id/like', authenticate, controller.like(false));
router.get('/:id/comments', optionalAuthenticate, comments.listComments);
router.post('/:id/comments', authenticate, comments.addComment);

module.exports = router;
