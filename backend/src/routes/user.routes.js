const express = require('express');
const controller = require('../controllers/user.controller');
const { authenticate, optionalAuthenticate } = require('../middlewares/authenticate');

const router = express.Router();

router.get('/:id', optionalAuthenticate, controller.getProfile);
router.post('/:id/follow', authenticate, controller.setFollow(true));
router.delete('/:id/follow', authenticate, controller.setFollow(false));

module.exports = router;
