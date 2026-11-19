# README v2 — Upload vidéo par fichiers `.part`

Le backend stocke chaque morceau reçu dans `backend/uploads/sessions/` sous la forme `<uploadId>.<chunkNumber>.part`. PostgreSQL conserve seulement la référence de chaque morceau; la taille attendue est dans `<uploadId>.meta.json` et l’offset de reprise est calculé depuis les fichiers `.part`. À réception complète, FFmpeg lit ces morceaux dans l’ordre et produit un MP4 final dans `uploads/sources/`, puis le traitement HLS démarre.

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
| `fingerprint` | Clé aléatoire propre à la tâche, persistée dans IndexedDB pour rendre la création de session réessayable. Les anciennes empreintes de contenu restent acceptées. |
| `status` | État SQL autorisé : `in_progress`, `complete` ou `aborted`. L’annulation actuelle supprime la vidéo et la session au lieu de conserver une ligne `aborted`. |
| `created_at`, `updated_at` | Dates de création et de dernière activité. |

### `upload_chunks`

Une ligne représente la référence d’un morceau reçu. Elle ne contient ni octets vidéo ni taille du morceau.

| Colonne | Rôle |
|---|---|
| `upload_id` | Session à laquelle appartient le morceau. |
| `video_id` | Vidéo associée à cette session. La clé étrangère composite vérifie que le couple correspond à `uploads`. |
| `chunk_number` | Numéro d’ordre du morceau, à partir de zéro. La clé primaire est `(upload_id, chunk_number)`. |
| `part_name` | Nom du fichier du morceau sous `uploads/sessions/`, par exemple `<uploadId>.0.part`. |
| `created_at` | Date d’insertion du morceau. |

Le schéma est défini dans [`backend/database/schema.sql`](backend/database/schema.sql). Chaque vidéo possède son `videoId`, son `uploadId` et ses propres lignes `upload_chunks`. Les morceaux de deux vidéos différentes ne sont pas mélangés.

## Déroulement d’un upload

1. **Création de la session** — Le client envoie `POST /api/uploads` avec le type, la taille, la clé de tâche et la légende. Cette clé est créée sans lire la vidéo; le serveur crée une ligne `videos`, puis une ligne `uploads` liée à cette vidéo. Il renvoie `videoId`, `uploadId` et `receivedBytes`.
2. **Envoi d’un morceau** — Le client envoie `PATCH /api/uploads/:uploadId` avec les octets d’une seule plage et l’en-tête `Upload-Offset`.
3. **Validation et enregistrement** — Le backend vérifie l’offset, le `Content-Length`, la limite du morceau et la taille attendue. Il écrit le morceau dans un `.part`, puis enregistre sa seule référence dans `upload_chunks`.
4. **Reprise après coupure** — Le client demande `GET /api/uploads/:uploadId`. Le serveur calcule `receivedBytes` en additionnant les tailles des `.part` référencés; la base ne stocke pas cet offset ni les tailles réelles.
5. **Vérification des morceaux** — Quand `receivedBytes` atteint `totalSize`, le client appelle `POST /api/uploads/:uploadId/complete`. Le backend contrôle les références, l’ordre et les tailles lues sur disque, puis prépare un manifeste ordonné des `.part` pour FFmpeg.
6. **MP4 final** — FFmpeg lit le manifeste comme un flux continu et remuxe en MP4; si les codecs ne sont pas compatibles avec MP4, il les réencode. Le MP4 est validé et placé dans `uploads/sources/<videoId>.mp4`. Une transaction marque l’upload `complete`, la vidéo `processing`, enregistre `source_name` et supprime les lignes `upload_chunks`; les `.part` sont ensuite supprimés.
7. **HLS** — Le backend transmet le `videoId` à la file de traitement. FFmpeg lit le MP4 et produit les qualités et segments HLS. Après le transcodage, le fichier source est supprimé.

## Plusieurs vidéos

La file locale crée une tâche distincte pour chaque vidéo sélectionnée. Chaque tâche conserve son URI et son `uploadSessionId`; le serveur a une ligne `uploads` et un `videoId` distincts pour chacune. La file cliente lance deux uploads simultanément par défaut, avec une progression et une reprise séparées.

## Coupure au milieu d’un morceau

Le backend attend d’avoir reçu le morceau complet avant de créer sa référence. Si la connexion tombe avant cela, aucun `.part` confirmé n’est ajouté. Après reconnexion, le serveur recalcule l’offset depuis les fichiers référencés et le client renvoie la plage qui manque.

Le serveur n’ajoute la référence à PostgreSQL qu’après l’écriture complète du `.part`. Après une coupure, un fichier temporaire non référencé n’avance pas l’offset calculé; le client reprend au total des morceaux référencés.

## Nettoyage et migration

- `DELETE /api/uploads/:uploadId` annule la session; la suppression de la vidéo supprime par cascade sa session et ses morceaux.
- Une session sans activité depuis 24 heures est supprimée par le nettoyage périodique; ses références et fichiers `.part` sont supprimés.
- Les morceaux d’un upload réussi sont supprimés après la création et la vérification du MP4. Les informations de la session et de la vidéo restent en base pour suivre le traitement.
- Pour installer le schéma mis à jour, lancer `npm run db:init` depuis `backend/`. La migration exporte les anciens morceaux `BYTEA` en `.part` et les tailles de session en `.meta.json`, puis retire les colonnes de contenu et de taille de PostgreSQL.

## Validation de la vidéo

Le backend vérifie que le nombre d’octets reçus correspond à la taille annoncée. FFmpeg valide le média et produit un MP4 lisible avant le traitement HLS. La clé fournie par le client rend la création de session réessayable; le serveur utilise l’`uploadId` sauvegardé pour reprendre les morceaux.

## Tests

Depuis `backend/`, la suite peut être lancée avec une base dédiée :

```bash
E2E_DATABASE_URL=postgresql://utilisateur@localhost:5432/base_de_test npm test
```

Les tests de bout en bout effacent le schéma `public` de `E2E_DATABASE_URL`. Il faut donc utiliser une base de test séparée, jamais la base de l’application.
