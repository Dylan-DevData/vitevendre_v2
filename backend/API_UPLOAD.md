# ViteVendre v2 : API d'upload reprenable et lecture HLS

Toutes les routes `/api/uploads` exigent `Authorization: Bearer <jwt>`.

| Étape | Requête | Réponse utile |
|---|---|---|
| Ouvrir / reprendre | `POST /api/uploads` `{mime_type, total_size, fingerprint, caption}` | `uploadId, videoId, receivedBytes, resumed, maxChunkBytes` (201 neuf, 200 repris) |
| Où reprendre ? | `GET /api/uploads/:id` | `receivedBytes` = prochain offset à envoyer |
| Envoyer un morceau | `PATCH /api/uploads/:id` + `Upload-Offset: <n>` + corps `application/octet-stream` | `receivedBytes` ; **409** + `receivedBytes` si offset inattendu |
| Terminer | `POST /api/uploads/:id/complete` | 202 `{videoId}` ; 409 si octets manquants |
| Annuler | `DELETE /api/uploads/:id` | 204 |
| Suivre le traitement | `GET /api/videos/:id` | `status` (processing, ready, failed), `renditions` |
| Fil | `GET /api/videos?before=<id>&limit=10` | `videos[].hlsUrl`, `posterUrl`, `nextBefore` |

## Règles pour le client
- **fingerprint** = SHA-256 de (64 premiers Ko + 64 derniers Ko + taille exacte). Indépendant du nom du fichier :
  un fichier renommé reprend la même session, et un fichier remplacé en crée une nouvelle.
- Taille de morceau libre entre 1 octet et `maxChunkBytes` (4 Mo par défaut). Le client peut donc l'adapter
  (512 Ko à 2 Mo) selon le débit mesuré sur chaque morceau.
- Après toute erreur réseau : `GET /api/uploads/:id`, puis reprise à `receivedBytes`. Jamais de réémission
  de ce qui est déjà validé. Un morceau interrompu en plein vol est ignoré par le serveur (le .tmp est
  ramené à l'offset validé avant l'écriture suivante).
- Le serveur écrit en flux (`createWriteStream`, flags `a`) : aucun morceau n'est gardé en RAM.

## Qualités HLS
240p, 480p, 720p, 1080p, mesurées sur le **petit côté** (une vidéo verticale 1080x1920 donne 240x426 ... 1080x1920).
Jamais au-dessus de la source. 240p et 480p sont publiés en premier (vidéo visible tout de suite), 720p et 1080p
sont ajoutés ensuite : le `master.m3u8` est alors réécrit et `renditions` mis à jour.

## Nettoyage
Une session sans activité depuis 24 h (`UPLOAD_SESSION_TTL_HOURS`) est supprimée (fichier .tmp et base), toutes
les heures (`GC_INTERVAL_MINUTES`).

## Tester
`E2E_DATABASE_URL=postgresql://... node --test test/e2e.test.js` (PostgreSQL, ffmpeg et ffprobe requis).
