# Parcours d'une vidéo : du téléphone à FFmpeg

Ce document suit un upload reprenable. Le téléphone envoie une tranche à la fois; PostgreSQL conserve chaque tranche et la position confirmée.

## A. Frontend : téléphone vers serveur

1. **Choisir la vidéo** — `noteApp/www/js/ui/upload-ui.js` ou `queued-upload-ui.js` ouvre le sélecteur et crée une tâche par vidéo.
2. **Lire une plage** — `noteApp/www/js/upload/source.js` et `native-video-source.js` lisent seulement la plage demandée du fichier original.
3. **Calculer l'empreinte** — `noteApp/www/js/upload/source.js` identifie le fichier pour qu'une reprise retrouve la bonne session.
4. **Créer ou reprendre la session** — `noteApp/www/js/upload/upload-task.js` appelle `POST /api/uploads`; le serveur renvoie `uploadId`, `videoId` et `receivedBytes`.
5. **Envoyer un morceau** — chaque `PATCH /api/uploads/:id` envoie les octets d'une plage, avec l'offset `Upload-Offset`. Le client attend la confirmation avant de passer à la plage suivante.

## B. Backend : réception et stockage PostgreSQL

6. **Diriger la requête** — `backend/src/routes/upload.routes.js` protège les routes et laisse `PATCH` transporter le corps binaire.
7. **Recevoir et valider le morceau** — `backend/src/controllers/upload.controller.js` vérifie l'offset, la taille déclarée et le nombre d'octets réellement reçus.
8. **Écrire en base** — `backend/src/models/upload.model.js` insère une ligne `upload_chunks` contenant `upload_id`, `video_id`, `chunk_number`, `byte_offset`, `chunk_size` et `data BYTEA`.
9. **Confirmer la progression** — l'insertion du morceau et la mise à jour de `uploads.received_bytes` sont dans la même transaction. Si le réseau coupe avant réception complète, PostgreSQL ne valide ni le morceau partiel ni un nouvel offset.

Chaque vidéo possède sa propre ligne dans `videos`, sa propre session dans `uploads` et ses propres lignes dans `upload_chunks`. Le couple `(upload_id, video_id)` est contrôlé par une clé étrangère.

## C. Coupure réseau et reprise

10. `upload-task.js` demande `GET /api/uploads/:id` après une interruption.
11. `receivedBytes` dans PostgreSQL est la position de reprise faisant foi. Le client rouvre la source originale et relit à partir de cet offset.
12. Une requête répétée pour un ancien offset reçoit **409** et l'offset actuel; elle ne crée pas de doublon.

## D. Finalisation : PostgreSQL vers FFmpeg

13. **Vérifier la fin** — `completeUpload()` refuse l'assemblage si tous les octets annoncés ne sont pas en base.
14. **Assembler en flux** — le backend lit les lignes `upload_chunks` dans l'ordre de `chunk_number`, vérifie chaque `byte_offset` et écrit un fichier source temporaire. Il ne charge qu'un morceau à la fois en mémoire.
15. **Valider le fichier** — le backend vérifie la taille et l'en-tête du conteneur vidéo, puis renomme le fichier complet dans `uploads/sources/`.
16. **Nettoyer les morceaux** — une transaction met `uploads.status` à `complete`, `videos.status` à `processing`, enregistre `source_name` et supprime les lignes `upload_chunks`. Cette suppression arrive après la création du fichier source.
17. **Transcoder** — `backend/src/services/transcode-queue.service.js` met le `videoId` en file; `ffmpeg.service.js` lit le fichier source et crée les playlists et segments HLS.

## Résumé

```text
Vidéo sur le téléphone
  → lecture d'une plage
  → PATCH avec Upload-Offset
  → ligne upload_chunks (upload_id, video_id, chunk_number, byte_offset, data)
  → transaction : morceau enregistré + received_bytes avancé
  → coupure : GET renvoie l'offset confirmé, reprise à cette position
  → fin : lecture ordonnée des morceaux et assemblage en fichier source
  → vérification et renommage du fichier
  → suppression des lignes upload_chunks
  → file de traitement → FFmpeg → HLS
```

Chaque morceau est temporairement stocké dans PostgreSQL. Les octets sont supprimés après assemblage réussi; la session et la vidéo restent dans la base pour suivre le traitement.
