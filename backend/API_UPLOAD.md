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

- Chaque morceau est une ligne de `upload_chunks`, liée à `upload_id` et `video_id`, avec `chunk_number`, `byte_offset`, `chunk_size` et les octets dans `data BYTEA`.
- L'insertion du morceau et l'avancement de `uploads.received_bytes` se font dans la même transaction PostgreSQL. Un morceau interrompu avant sa réception complète n'est pas enregistré et l'offset ne bouge pas.
- Les morceaux sont acceptés dans l'ordre. À une coupure, le client demande `GET /api/uploads/:id` et reprend depuis `receivedBytes`. Un morceau déjà validé ne sera pas ajouté deux fois.
- Lors de la finalisation, le backend relit les lignes une par une dans l'ordre, vérifie les offsets et la taille, puis assemble un fichier source temporaire. Après validation et renommage du fichier, la transaction finale passe l'upload à `complete`, met la vidéo en `processing` et supprime les lignes de morceaux.
- Le serveur ne charge pas toute la vidéo en mémoire : il garde le morceau courant durant son insertion, puis relit les morceaux un par un pendant l'assemblage.
- Chaque vidéo a un `videoId` et un `uploadId` propres. Les morceaux ne peuvent pas être associés à la mauvaise vidéo : la base vérifie le couple session/vidéo.

## Règles pour le client

- **fingerprint** = signature SHA-256 calculée par le client sur des blocs de contenu et la taille totale, indépendante du nom. Elle permet de reprendre le même fichier renommé et de distinguer un fichier remplacé.
- Taille de morceau libre entre 1 octet et `maxChunkBytes` (4 Mo par défaut). Le client l'adapte au débit : 512 Ko à 2 Mo dans le navigateur, et au plus 1 Mo sur Android pour borner le pont natif.
- Après toute erreur réseau : `GET /api/uploads/:id`, puis reprise à `receivedBytes`.

## Qualités HLS

240p, 480p, 720p, 1080p, mesurées sur le **petit côté** (une vidéo verticale 1080x1920 donne 240x426 ... 1080x1920).
Jamais au-dessus de la source. 240p et 480p sont publiés en premier (vidéo visible tout de suite), 720p et 1080p
sont ajoutés ensuite : le `master.m3u8` est alors réécrit et `renditions` mis à jour.

## Nettoyage

Une session sans activité depuis 24 h (`UPLOAD_SESSION_TTL_HOURS`) est supprimée toutes les heures (`GC_INTERVAL_MINUTES`).
Les morceaux associés sont supprimés par cascade PostgreSQL. Les lignes de morceaux d'un upload réussi sont supprimées
après l'assemblage du fichier source; les métadonnées de session et de vidéo restent en base.

## Remarque d'exploitation

Les morceaux vidéo occupent temporairement PostgreSQL. Ils sont supprimés à la finalisation, mais les sauvegardes et le
journal PostgreSQL peuvent conserver leur historique selon la configuration de la base.
