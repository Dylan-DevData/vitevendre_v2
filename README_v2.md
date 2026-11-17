# README v2 — Upload vidéo avec morceaux stockés dans PostgreSQL

Cette version enregistre les morceaux d’une vidéo dans PostgreSQL pendant l’upload. Après réception complète, le backend les assemble en un fichier source dans `backend/uploads/sources/`, puis passe ce fichier à FFmpeg.

## Modèle de données

### `videos`

Une ligne représente une vidéo. Son `id` (`videoId`) est créé par le serveur et sert à suivre son traitement et ses fichiers HLS.

### `uploads`

Une ligne représente la session d’envoi reprenable d’une vidéo.

| Colonne | Rôle |
|---|---|
| `id` (`uploadId`) | UUID de la session serveur. |
| `user_id` | Propriétaire de l’upload. |
| `video_id` | Identifiant de la vidéo liée à cette session. |
| `mime_type` | Type déclaré, par exemple `video/mp4`. |
| `total_size` | Taille totale annoncée par le client. |
| `received_bytes` | Offset du prochain octet à envoyer; il n’avance qu’avec l’enregistrement réussi d’un morceau. |
| `fingerprint` | Empreinte client utilisée pour retrouver une session du même fichier. |
| `status` | État SQL autorisé : `in_progress`, `complete` ou `aborted`. L’annulation actuelle supprime la vidéo et la session au lieu de conserver une ligne `aborted`. |
| `created_at`, `updated_at` | Dates de création et de dernière activité. |

### `upload_chunks`

Une ligne représente un morceau reçu. Les octets binaires sont conservés dans `data BYTEA`.

| Colonne | Rôle |
|---|---|
| `upload_id` | Session à laquelle appartient le morceau. |
| `video_id` | Vidéo associée à cette session. La clé étrangère composite vérifie que le couple correspond à `uploads`. |
| `chunk_number` | Numéro d’ordre du morceau, à partir de zéro. La clé primaire est `(upload_id, chunk_number)`. |
| `byte_offset` | Position du premier octet de ce morceau dans la vidéo complète. |
| `chunk_size` | Nombre d’octets du morceau. |
| `data` | Octets vidéo du morceau, stockés dans PostgreSQL en `BYTEA`. |
| `created_at` | Date d’insertion du morceau. |

Le schéma est défini dans [`backend/database/schema.sql`](backend/database/schema.sql). Chaque vidéo possède son `videoId`, son `uploadId` et ses propres lignes `upload_chunks`. Les morceaux de deux vidéos différentes ne sont pas mélangés.

## Déroulement d’un upload

1. **Création de la session** — Le client envoie `POST /api/uploads` avec le type, la taille, l’empreinte et la légende. Le serveur crée une ligne `videos`, puis une ligne `uploads` liée à cette vidéo. Il renvoie les identifiants `videoId` et `uploadId`, ainsi que `receivedBytes`.
2. **Envoi d’un morceau** — Le client envoie `PATCH /api/uploads/:uploadId` avec les octets d’une seule plage et l’en-tête `Upload-Offset`.
3. **Validation et enregistrement** — Le backend vérifie l’offset, le `Content-Length`, la limite du morceau et la taille totale. Il lit au plus un morceau en mémoire, puis insère une ligne dans `upload_chunks` et avance `uploads.received_bytes` dans la même transaction PostgreSQL.
4. **Reprise après coupure** — Le client demande `GET /api/uploads/:uploadId`. `receivedBytes` est la position confirmée par la base. Le client relit la vidéo originale à partir de cette position. Si une requête est arrivée à PostgreSQL mais que sa réponse réseau a été perdue, l’offset permet au client de se recaler sans ajouter le morceau une deuxième fois.
5. **Assemblage** — Quand `received_bytes` atteint `total_size`, le client appelle `POST /api/uploads/:uploadId/complete`. Le backend relit les morceaux un par un, dans l’ordre de `chunk_number`, vérifie que leurs offsets sont continus et écrit le fichier temporaire d’assemblage dans le dossier des sources.
6. **Finalisation** — Le backend vérifie la taille et l’en-tête vidéo, puis renomme le fichier complet en `uploads/sources/<videoId>.<extension>`. Une transaction marque l’upload `complete`, la vidéo `processing`, enregistre `source_name` et supprime les lignes `upload_chunks`.
7. **FFmpeg** — Le backend transmet le `videoId` à la file de traitement. FFmpeg lit le fichier source et produit les qualités et segments HLS. Après le transcodage, le fichier source brut est supprimé.

## Plusieurs vidéos

La file locale crée une tâche distincte pour chaque vidéo sélectionnée. Chaque tâche conserve son URI et son `uploadSessionId`; le serveur a une ligne `uploads` et un `videoId` distincts pour chacune. La file cliente lance deux uploads simultanément par défaut, avec une progression et une reprise séparées.

## Coupure au milieu d’un morceau

Le backend attend d’avoir reçu le morceau complet avant de lancer la transaction. Si la connexion tombe avant cela, la ligne du morceau n’est pas créée et `received_bytes` ne change pas. Après reconnexion, le client demande l’offset réel et renvoie la plage qui n’a pas été confirmée.

L’insertion du morceau et l’avancement de l’offset sont atomiques : PostgreSQL ne peut pas confirmer un offset dont les octets n’ont pas été enregistrés.

## Nettoyage et migration

- `DELETE /api/uploads/:uploadId` annule la session; la suppression de la vidéo supprime par cascade sa session et ses morceaux.
- Une session sans activité depuis 24 heures est supprimée par le nettoyage périodique; ses morceaux sont supprimés par cascade PostgreSQL.
- Les morceaux d’un upload réussi sont supprimés après la création et la vérification du fichier assemblé. Les informations de la session et de la vidéo restent en base pour suivre le traitement.
- Pour installer le nouveau schéma, lancer `npm run db:init` depuis `backend/`. Les anciennes sessions actives qui avaient déjà des octets dans un fichier `.tmp` repartent de l’offset zéro, car leurs octets ne se trouvent pas dans `upload_chunks`.

## Validation de la vidéo

Le backend vérifie que le nombre d’octets assemblés correspond à la taille annoncée et que l’en-tête ressemble à un conteneur vidéo pris en charge. FFprobe et FFmpeg effectuent ensuite le traitement média. L’empreinte fournie par le client sert à retrouver une session de reprise; le backend ne recalcule pas actuellement cette empreinte sur tout le fichier assemblé.

## Tests

Depuis `backend/`, la suite peut être lancée avec une base dédiée :

```bash
E2E_DATABASE_URL=postgresql://utilisateur@localhost:5432/base_de_test npm test
```

Les tests de bout en bout effacent le schéma `public` de `E2E_DATABASE_URL`. Il faut donc utiliser une base de test séparée, jamais la base de l’application. La suite vérifie les morceaux en base, les coupures et reprises, l’assemblage, le transcodage HLS et le nettoyage.
