const express = require('express');
const controller = require('../controllers/upload.controller');
const { authenticate } = require('../middlewares/authenticate');

const router = express.Router();

// Toutes les routes demandent un utilisateur connecté. PATCH reste un flux binaire brut :
// aucun parseur JSON ou middleware de formulaire ne doit le mettre en mémoire.
// Protocole de reprise par offset (inspiré de tus.io) :
//   POST   /            ouvre (ou reprend) une session
//   GET    /:id         receivedBytes = offset où reprendre
//   PATCH  /:id         ajoute une plage brute qui sera stockée en fichier .part
//   POST   /:id/complete  FFmpeg lit les .part dans l'ordre, crée le MP4 puis lance le HLS
//   DELETE /:id         annule
// Aucun parseur sur PATCH : le contrôleur reçoit un morceau borné, le met sur disque
// et conserve seulement sa référence dans PostgreSQL; tailles et offsets sont calculés sur disque.
router.post('/', authenticate, controller.createUpload);
router.get('/:id', authenticate, controller.getUpload);
router.patch('/:id', authenticate, controller.appendChunk);
router.post('/:id/complete', authenticate, controller.completeUpload);
router.delete('/:id', authenticate, controller.abortUpload);

module.exports = router;
