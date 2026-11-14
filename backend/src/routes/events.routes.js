const express = require('express');
const { authenticate } = require('../middlewares/authenticate');
const events = require('../services/events.service');

const router = express.Router();

// EventSource ne sait pas envoyer d'en-tête Authorization : le jeton passe en ?token=.
function tokenFromQuery(req, res, next) {
  if (!req.get('authorization') && typeof req.query.token === 'string') {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}

router.get('/', tokenFromQuery, authenticate, (req, res) => events.subscribe(req.user.id, res));

module.exports = router;
