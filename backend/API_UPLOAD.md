# ViteVendre v2 : API d'upload reprenable et lecture HLS

Toutes les routes `/api/uploads` exigent `Authorization: Bearer <jwt>`.

| Étape | Requête | Réponse utile |
|---|---|---|
| Ouvrir / reprendre | `POST /api/uploads` `{mime_type, total_size, fingerprint, caption}` | `uploadId, videoId, receivedBytes, resumed, maxChunkBytes` (201 neuf, 200 repris) |
| Où reprendre ? | `GET /api/uploads/:id` | `receivedBytes` = prochain offset à envoyer |
| Envoyer un morceau | `PATCH /api/uploads/:id` + `Upload-Offset: <n>` + corps `application/octet-stream` | `chunkNumber, receivedBytes` ; **409** + `receivedBytes` si offset inattendu |
| Terminer | `POST /api/uploads/:id/complete` | 202 `{videoId}` ; 409 si octets manquants |
| Annuler | `DELETE /api/uploads/:id` | 204 |
| Suivre le traitement | `GET /api/videos/:id` | `status` (processing, ready, failed), `renditions` |
| Fil | `GET /api/videos?before=<id>&limit=10` | `videos[].hlsUrl, posterUrl, nextBefore` |

## Stockage des morceaux et reprise

- Chaque morceau confirmé est un fichier `uploads/sessions/<uploadId>.<chunkNumber>.part`. La ligne `upload_chunks` garde seulement `upload_id`, `video_id`, `chunk_number` et `part_name`.
- La taille attendue est dans `<uploadId>.meta.json`; les tailles réelles et `receivedBytes` sont calculés depuis les fichiers référencés, jamais enregistrés en base.
- Le fichier est déplacé depuis un fichier temporaire avant d'inscrire sa référence dans PostgreSQL. Un morceau interrompu avant sa réception complète n'est pas référencé et n'avance pas l'offset calculé.
- Les morceaux sont acceptés dans l'ordre. À une coupure, le client demande `GET /api/uploads/:id` et reprend depuis `receivedBytes`. Un morceau déjà validé ne sera pas ajouté deux fois.
- Lors de la finalisation, le backend vérifie les références, offsets et tailles, puis prépare un manifeste ordonné. FFmpeg lit directement les `.part` comme un seul flux et remuxe le MP4 (ou réencode les codecs incompatibles) avant le transcodage HLS.
- Le serveur ne charge pas toute la vidéo en mémoire : il garde le morceau courant durant sa réception, puis lit les fichiers un par un pendant l'assemblage.
- Chaque vidéo a un `videoId` et un `uploadId` propres. Les morceaux ne peuvent pas être associés à la mauvaise vidéo : la base vérifie le couple session/vidéo.

## Règles pour le client

- **fingerprint** = clé aléatoire stable pour cette tâche, sauvegardée dans IndexedDB. Elle rend `POST /api/uploads` idempotent après une coupure et évite de lire toute la vidéo avant l'envoi; elle ne constitue pas une empreinte d'intégrité du contenu. Les anciennes tâches avec une signature SHA-256 du contenu restent compatibles.
- Taille de morceau libre entre 1 octet et `maxChunkBytes` (4 Mio par défaut). Le client démarre à 512 Kio; sous environ 512 Kio/s il garde cette taille, puis l'adapte au débit mesuré jusqu'à 4 Mio sur le navigateur comme sur Android.
- Après toute erreur réseau : `GET /api/uploads/:id`, puis reprise à `receivedBytes`.

## Qualités HLS

240p, 480p, 720p, 1080p, mesurées sur le **petit côté** (une vidéo verticale 1080x1920 donne 240x426 ... 1080x1920).
Jamais au-dessus de la source. 240p et 480p sont publiés en premier (vidéo visible tout de suite), 720p et 1080p
sont ajoutés ensuite : le `master.m3u8` est alors réécrit et `renditions` mis à jour.

## Nettoyage

Une session sans activité depuis 24 h (`UPLOAD_SESSION_TTL_HOURS`) est supprimée toutes les heures (`GC_INTERVAL_MINUTES`).
Les références des morceaux sont supprimées par cascade PostgreSQL et leurs fichiers `.part` sont supprimés avec la session. Le fichier de taille de session est supprimé quand la session est annulée ou arrive à expiration.
Après un upload réussi, les lignes et fichiers temporaires des morceaux sont supprimés; les métadonnées de session et de vidéo restent en base.

## Remarque d'exploitation

Les morceaux vidéo occupent temporairement `uploads/sessions`; prévoir assez d'espace disque pour les sessions actives.
La commande `npm run db:init` migre les anciennes données `BYTEA` vers les `.part` avant de supprimer les colonnes contenant les octets, offsets et tailles des morceaux.
