# Parcours d'une vidéo : du téléphone à FFmpeg

Ce document suit un upload reprenable. Le téléphone envoie une tranche à la fois; le serveur stocke chaque tranche en fichier `.part` et PostgreSQL conserve sa référence et son numéro d'ordre. Le serveur calcule la position confirmée depuis les fichiers.

## A. Frontend : téléphone vers serveur

1. **Choisir la vidéo** — `noteApp/www/js/ui/upload-ui.js` ou `queued-upload-ui.js` ouvre le sélecteur et crée une tâche par vidéo.
2. **Lire une plage** — `noteApp/www/js/upload/source.js` et `native-video-source.js` lisent seulement la plage demandée du fichier original.
3. **Préparer la reprise** — `noteApp/www/js/upload/source.js` crée une clé aléatoire par tâche et `upload-queue.js` la stocke dans IndexedDB avec l'URI. Le client n'a pas besoin de lire toute la vidéo avant l'upload.
4. **Créer ou reprendre la session** — `noteApp/www/js/upload/upload-task.js` appelle `POST /api/uploads`; le serveur renvoie `uploadId`, `videoId` et `receivedBytes`.
5. **Envoyer un morceau** — chaque `PATCH /api/uploads/:id` envoie les octets d'une plage, avec l'offset `Upload-Offset`. Le client attend la confirmation avant de passer à la plage suivante.

## B. Backend : réception et stockage des morceaux sur disque

6. **Diriger la requête** — `backend/src/routes/upload.routes.js` protège les routes et laisse `PATCH` transporter le corps binaire.
7. **Recevoir et valider le morceau** — `backend/src/controllers/upload.controller.js` vérifie l'offset, la taille déclarée et le nombre d'octets réellement reçus.
8. **Écrire sur disque** — `backend/src/controllers/upload.controller.js` écrit `uploads/sessions/<uploadId>.<chunkNumber>.part`.
9. **Enregistrer la référence** — `backend/src/models/upload.model.js` enregistre seulement `part_name`, `upload_id`, `video_id` et `chunk_number`. Si le réseau coupe avant réception complète, aucun `.part` confirmé n'est référencé.

Chaque vidéo possède sa propre ligne dans `videos`, sa propre session dans `uploads` et ses propres lignes dans `upload_chunks`. Le couple `(upload_id, video_id)` est contrôlé par une clé étrangère.

## C. Coupure réseau et reprise

10. `upload-task.js` demande `GET /api/uploads/:id` après une interruption.
11. `receivedBytes` est calculé par le serveur en additionnant la taille des `.part` référencés. Le client rouvre la source originale et relit à partir de cet offset.
12. Une requête répétée pour un ancien offset reçoit **409** et l'offset actuel; elle ne crée pas de doublon.

## D. Finalisation : fichiers `.part` vers FFmpeg

13. **Vérifier la fin** — `completeUpload()` refuse l'assemblage si tous les octets annoncés ne sont pas confirmés.
14. **Préparer l'entrée FFmpeg** — le backend vérifie chaque référence et la taille de son fichier sur disque, puis écrit un manifeste qui liste les `.part` dans l'ordre de `chunk_number`.
15. **Créer le MP4** — `ffmpeg.service.js` lance FFmpeg avec le protocole `concatf`; FFmpeg lit les `.part` comme le flux continu du fichier original, remuxe en MP4 ou réencode les codecs incompatibles. FFprobe valide le résultat, qui est enregistré sous `uploads/sources/<videoId>.mp4`.
16. **Nettoyer les morceaux** — une transaction met `uploads.status` à `complete`, `videos.status` à `processing`, enregistre `source_name` et supprime les lignes `upload_chunks`. Les fichiers `.part` sont ensuite supprimés.
17. **Transcoder** — `backend/src/services/transcode-queue.service.js` met le `videoId` en file; FFmpeg lit le MP4 et crée les playlists et segments HLS.

## Résumé

```text
Vidéo sur le téléphone
  → lecture d'une plage
  → PATCH avec Upload-Offset
  → fichier uploads/sessions/<uploadId>.<n>.part
  → upload_chunks garde seulement les références
  → coupure : GET renvoie l'offset confirmé, reprise à cette position
  → fin : validation des .part et manifeste ordonné
  → FFmpeg lit les .part et produit uploads/sources/<videoId>.mp4
  → suppression des lignes upload_chunks
  → file de traitement → FFmpeg → HLS
```

Chaque morceau est temporairement stocké dans `uploads/sessions/`; PostgreSQL conserve sa référence. Les `.part` sont supprimés après création du MP4; la session et la vidéo restent dans la base pour suivre le traitement.
