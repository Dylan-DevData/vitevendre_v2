const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');
const userModel = require('../models/user.model');
const { httpError } = require('../utils/httpError');

// Vérifie un JWT puis relit le compte en base pour appliquer son statut actuel.
// Partagé par les routes HTTP et par la connexion WebSocket.
async function authenticateToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw httpError(401, 'Jeton invalide ou expiré.');
    }
    throw error;
  }

  if (!payload || typeof payload !== 'object' || !/^[1-9]\d*$/.test(payload.sub || '')) {
    throw httpError(401, 'Jeton invalide.');
  }

  const user = await userModel.findActiveById(Number(payload.sub));
  if (!user) throw httpError(401, 'Compte introuvable ou suspendu.');
  return {
    id: user.id,
    role: user.role,
  };
}

async function authenticateRequest(req, allowAnonymous) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    if (allowAnonymous) return null;
    throw httpError(401, 'Authentification requise.');
  }
  return authenticateToken(match[1]);
}

async function authenticate(req, res, next) {
  try {
    req.user = await authenticateRequest(req, false);
    return next();
  } catch (error) {
    return next(error);
  }
}

async function optionalAuthenticate(req, res, next) {
  try {
    req.user = await authenticateRequest(req, true);
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { authenticate, optionalAuthenticate, authenticateToken };
