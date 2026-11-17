# Fonctionnement de l'upload vidéo ViteVendre

Ce schéma décrit le trajet d'une vidéo depuis sa sélection sur Android jusqu'à sa publication, ainsi que la reprise d'un transfert interrompu.

![Schéma graphique du fonctionnement complet de l'upload vidéo](./schema-fonctionnement-upload-video.svg)

## Parcours

1. **Sélection** — Android peut renvoyer plusieurs URI `content://`. Le plugin récupère le nom, le type et la taille de chaque vidéo.
2. **Association locale** — La file crée une tâche par vidéo. IndexedDB garde l'URI, l'état et l'`uploadId` de cette tâche; il ne stocke pas les octets vidéo.
3. **Session serveur** — `POST /api/uploads` crée ou reprend une ligne `uploads`, liée à un `videoId` distinct.
4. **Transfert par morceaux** — Le client envoie chaque plage avec `PATCH /api/uploads/:id` et `Upload-Offset`. Le backend insère une ligne `upload_chunks` (`upload_id`, `video_id`, `chunk_number`, `byte_offset`, `chunk_size`, `data BYTEA`) et avance `received_bytes` dans la même transaction.
5. **Plusieurs vidéos** — Chaque vidéo a son `videoId`, son `uploadId` et ses lignes de morceaux. Le nombre de tâches envoyées simultanément est réglable et vaut deux par défaut.
6. **Coupure et reprise** — Après reconnexion ou redémarrage, l'application demande au serveur l'état de son `uploadId`. `receivedBytes` vient de PostgreSQL; le client relit la source à cette position.
7. **Finalisation** — Le backend lit les morceaux un par un dans l'ordre, contrôle leurs offsets et assemble le fichier source. Après vérification et renommage du fichier, il marque l'upload complet et supprime ses lignes `upload_chunks`.
8. **Transcodage** — Le serveur transmet le fichier source à FFmpeg, qui produit le streaming HLS.

## Identifiants

| Valeur | Rôle |
|---|---|
| `videos.id` (`videoId`) | Identifie la vidéo publiée et son transcodage. |
| `uploads.id` (`uploadId`) | Identifie la session reprenable d'une vidéo. |
| `upload_chunks.chunk_number` | Identifie l'ordre d'un morceau dans cette session. |
| `upload_chunks.byte_offset` | Vérifie que les morceaux sont contigus, sans trou ni chevauchement. |

La base garantit le lien session/vidéo avec une clé étrangère composite. Les morceaux ne sont supprimés qu'après l'assemblage vérifié du fichier source; une session abandonnée est nettoyée après 24 heures.
