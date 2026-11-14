const express = require('express');
const controller = require('../controllers/upload.controller');
const { authenticate } = require('../middlewares/authenticate');

const router = express.Router();

// Toutes les routes demandent un utilisateur connecté. PATCH reste un flux binaire brut :
// aucun parseur JSON ou middleware de formulaire ne doit le mettre en mémoire.
// Protocole de reprise par offset (inspiré de tus.io) :
//   POST   /            ouvre (ou reprend) une session
//   GET    /:id         receivedBytes = offset où reprendre
//   PATCH  /:id         ajoute un morceau (en-tête Upload-Offset, corps = octets bruts, en flux)
//   POST   /:id/complete  vérifie puis lance le transcodage
//   DELETE /:id         annule
// Aucun parseur de corps sur PATCH : le flux de la requête est écrit tel quel sur le disque.
router.post('/', authenticate, controller.createUpload);
router.get('/:id', authenticate, controller.getUpload);
router.patch('/:id', authenticate, controller.appendChunk);
router.post('/:id/complete', authenticate, controller.completeUpload);
router.delete('/:id', authenticate, controller.abortUpload);

module.exports = router;
