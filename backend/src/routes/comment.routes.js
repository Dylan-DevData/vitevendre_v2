const express = require('express');
const controller = require('../controllers/comment.controller');
const { authenticate } = require('../middlewares/authenticate');

const router = express.Router();

router.delete('/:id', authenticate, controller.deleteComment);

module.exports = router;
