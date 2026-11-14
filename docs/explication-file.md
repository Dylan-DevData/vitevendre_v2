# Parcours d’une vidéo : du téléphone au lecteur

Ce pense-bête indique **quel fichier fait quoi**, dans l’ordre. Le frontend lit et envoie une petite tranche à la fois ; le backend écrit chaque tranche dans le même fichier temporaire sur le disque.

## A. Frontend : téléphone vers serveur

1. **Choisir le fichier** — `noteApp/www/js/ui/upload-ui.js`  
   Le sélecteur Android renvoie un objet `File`, qui référence la vidéo sur le téléphone. `URL.createObjectURL(file)` sert à l’aperçu. Cela ne copie pas toute la vidéo en mémoire.

2. **Lire une tranche** — `noteApp/www/js/upload/source.js`  
   `FileSource.read(start, end)` utilise `file.slice(start, end)` pour lire seulement la plage demandée. Le frontend garde temporairement cette tranche en mémoire.

3. **Choisir la taille** — `noteApp/www/js/upload/chunk-sizer.js`  
   Commence à **512 Kio**, augmente si le réseau est stable, et ne dépasse pas **2 Mio sur navigateur** ou **1 Mio sur Android**. En cas d’erreur, revient à 512 Kio.

4. **Organiser l’upload et la reprise** — `noteApp/www/js/upload/upload-task.js`  
   Crée la session, lit une tranche, l’envoie, attend la confirmation du serveur, puis passe à la suivante. En cas de coupure, demande l’offset au serveur et reprend à cette position.

5. **Envoyer en HTTP** — `noteApp/www/js/api-core.js`  
   `POST /api/uploads` envoie les métadonnées de la vidéo. Chaque `PATCH /api/uploads/:id` transporte les octets d’une seule tranche et son `Upload-Offset`.

## B. Backend : serveur vers disque

6. **Brancher l’adresse de l’API** — `backend/src/app.js`  
   Monte les routes d’upload sous `/api/uploads`.

7. **Diriger la requête** — `backend/src/routes/upload.routes.js`  
   Protège la route avec l’authentification et dirige `PATCH /:id` vers `appendChunk()`. Le corps reste un flux binaire, sans parseur JSON.

8. **Écrire la tranche** — `backend/src/controllers/upload.controller.js`, fonction `appendChunk()`  
   Vérifie l’offset, puis relie le flux HTTP au fichier temporaire avec `pipeline(req, fs.createWriteStream(...))`. La tranche est ajoutée à la fin du même fichier `.tmp` ; le serveur ne garde pas la vidéo entière en RAM.

9. **Enregistrer la progression** — `backend/src/models/upload.model.js`  
   Après l’écriture réussie sur disque, met à jour `received_bytes` dans PostgreSQL. PostgreSQL garde la progression et les métadonnées, pas les octets vidéo.

## C. Fin de l’upload : disque vers FFmpeg

10. **Valider et déplacer le fichier complet** — `backend/src/controllers/upload.controller.js`, fonction `completeUpload()`  
    Vérifie que tous les octets sont présents. Le `.tmp` contient déjà toutes les tranches dans l’ordre ; il est renommé/déplacé vers `uploads/sources/`. Il n’y a pas de collage des morceaux depuis PostgreSQL.

11. **Mettre en file** — `backend/src/services/transcode-queue.service.js`  
    Ajoute l’identifiant de la vidéo à la file. FFmpeg recevra le chemin du fichier source complet sur disque, pas les requêtes `PATCH`.

12. **Convertir en HLS** — `backend/src/services/ffmpeg.service.js`  
    FFmpeg lit le fichier source et écrit les playlists `.m3u8` et segments `.ts` dans `media/videos/<id>/`. La source brute est ensuite supprimée.

## D. Lecture : serveur vers frontend

13. **Servir playlists et segments** — `backend/src/app.js`  
    Sert les fichiers du dossier `media` quand la vidéo est prête.

14. **Donner l’adresse HLS** — `backend/src/models/video.model.js`  
    Retourne au client l’URL `hlsUrl` vers `master.m3u8`.

15. **Lire la vidéo** — `noteApp/www/js/player.js`, utilisé par `noteApp/www/js/ui/feed.js` et `noteApp/www/js/ui/reels.js`  
    hls.js demande la playlist puis les petits segments selon la lecture et le débit réseau.

## À retenir

```text
File sur le téléphone
  → file.slice() lit une tranche
  → PATCH HTTP envoie cette tranche
  → pipeline l’ajoute au fichier .tmp sur le serveur
  → PostgreSQL mémorise l’offset confirmé
  → fichier .tmp complet déplacé vers uploads/sources/
  → file d’attente → FFmpeg → playlists et segments HLS
  → player.js lit la playlist et les segments
```

**La vidéo entière ne passe pas en RAM.** Le frontend utilise temporairement la tranche en cours et le serveur les tampons normaux de ses flux. Les tranches ne sont pas stockées dans PostgreSQL et ne sont pas conservées en fichiers séparés.
