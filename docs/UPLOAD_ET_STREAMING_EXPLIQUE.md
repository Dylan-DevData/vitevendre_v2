# ViteVendre : upload reprenable et lecture vidéo HLS

Ce document suit une vidéo depuis le sélecteur du téléphone jusqu’au backend, puis explique comment elle est convertie et lue. Les chemins ci-dessous sont relatifs à la racine du projet.

## Résumé en une minute

1. Le navigateur garde un objet `File`. Android garde une URI `content://` accordée par le sélecteur système. Aucun des deux ne copie la vidéo entière en mémoire.
2. Le client lit une tranche à la fois : `file.slice()` sur le web ou le pont natif Android. Elle commence à **512 Kio**, s’adapte au débit, et ne dépasse pas **2 Mio sur le web** ou **1 Mio sur Android**.
3. Chaque tranche est envoyée en requête HTTP `PATCH`. Le backend l’enregistre dans `upload_chunks` en PostgreSQL avec son numéro, son offset et les octets.
4. L’insertion du morceau et la progression sont atomiques. Après une coupure, le client demande `receivedBytes` au serveur et reprend à cet endroit.
5. Quand tous les octets sont reçus, le backend relit et assemble les morceaux dans l’ordre, vérifie le fichier source, supprime les lignes de morceaux et place la vidéo dans la file FFmpeg.
6. FFmpeg écrit des playlists HLS et des segments vidéo sur le disque. Le frontend lit ensuite la playlist et les segments à la demande.

**« Sans passer par la RAM » signifie ici « sans mettre le fichier complet en RAM ».** Le navigateur garde une tranche en mémoire pendant sa lecture et son envoi ; Node.js et FFmpeg utilisent également leurs tampons de flux normaux. La mémoire utilisée reste limitée par rapport à la taille totale d’une vidéo.

## 1. Sélection et lecture côté client

Fichier : [`noteApp/www/js/ui/upload-ui.js`](../noteApp/www/js/ui/upload-ui.js)

Sur le web, le champ `<input type="file">` fournit un objet `File` et le navigateur redemande ce fichier après un rechargement si la page a perdu sa référence. Sur Android, `noteApp/www/js/ui/upload-ui.js` appelle le pont natif [`noteApp/cordova-plugins/vitevendre-persistent-video/src/android/VvVideoSource.java`](../noteApp/cordova-plugins/vitevendre-persistent-video/src/android/VvVideoSource.java). Celui-ci ouvre `Intent.ACTION_OPEN_DOCUMENT`, conserve l’autorisation en lecture avec `takePersistableUriPermission`, puis stocke l’URI et les métadonnées dans `SharedPreferences`.

Le pont [`noteApp/www/js/upload/native-video-source.js`](../noteApp/www/js/upload/native-video-source.js) représente cette URI comme une source lisible par plages. Il renvoie au JavaScript uniquement une plage encodée, jamais les octets du fichier complet. Si le fournisseur Android refuse l’accès persistant ou le déplacement de lecture, l’application explique qu’il faut choisir la vidéo avec Fichiers/Téléchargements.

```js
// L’aperçu utilise une URL locale du fichier. Il ne transforme pas le fichier entier en chaîne/base64.
previewUrl = URL.createObjectURL(file);

// Au clic sur Publier, on transmet l’objet File à la tâche d’upload.
begin(file, caption);
```

La fonction `begin()` crée une `UploadTask`. Le code d’envoi principal est dans [`noteApp/www/js/upload/upload-task.js`](../noteApp/www/js/upload/upload-task.js), tandis que [`noteApp/www/js/upload/source.js`](../noteApp/www/js/upload/source.js) fournit la lecture par plage.

```js
// Ne lit que la plage demandée : start inclus, end exclu.
const buffer = await readBlob(this.file.slice(start, end));
return new Uint8Array(buffer);
```

Par exemple, `file.slice(0, 524288)` lit les premiers 512 Kio. Au tour suivant, le client lit la tranche suivante. Il ne fait pas `await file.arrayBuffer()` sur le fichier entier.

### Empreinte pour retrouver la même vidéo

Avant l’envoi, `computeFingerprint()` dans `source.js` parcourt le contenu par blocs fixes de **512 Kio**. Il calcule le SHA-256 de chaque bloc, puis chaîne chaque résultat avec le précédent et la taille totale. Ainsi, une modification au milieu du fichier change la signature. Le nom n’entre pas dans le calcul : renommer la vidéo ne change pas sa signature.

Cette vérification lit tout le fichier avant l’upload et encore une fois lors d’une reprise. Elle utilise au plus un bloc à la fois en mémoire ; elle ne copie jamais la vidéo entière dans la RAM ou dans un stockage local. SHA-256 est fourni par [`noteApp/www/js/upload/sha256.js`](../noteApp/www/js/upload/sha256.js).

## 2. Combien de mégaoctets par morceau ?

Fichier : [`noteApp/www/js/upload/chunk-sizer.js`](../noteApp/www/js/upload/chunk-sizer.js)

| Situation | Taille de la tranche côté client |
|---|---:|
| Début d’envoi ou après une erreur réseau | 512 Kio (0,5 Mio) |
| Réseau stable et rapide | Augmente par pas de 256 Kio |
| Maximum côté client | 2 Mio sur le web ; 1 Mio sur Android (plage encodée par le pont natif) |
| Dernière tranche | Peut être plus petite que la taille courante |

Après chaque succès, le client mesure le débit. Il vise une tranche qui prend environ quatre secondes à envoyer, l’arrondit au multiple de 64 Kio le plus proche, puis ajuste progressivement la taille. Il faut deux succès consécutifs pour augmenter la taille. En cas d’échec, elle retombe à 512 Kio.

Exemple pour une vidéo d’environ 10 Mio : cela représente environ 20 tranches à 512 Kio, ou environ 5 tranches à 2 Mio. Le nombre réel dépend du débit et de la dernière tranche.

### Limite côté serveur : différente de la taille choisie par le client

Dans `backend/.env.example`, `UPLOAD_CHUNK_MAX_BYTES=4194304`, soit **4 Mio**. C’est la taille maximale qu’un `PATCH` peut contenir, pas la taille habituelle que le client envoie. Le client plafonne à 2 Mio, donc il reste sous cette limite.

Le serveur prend aussi en charge `MAX_VIDEO_BYTES`. La valeur `0` signifie qu’il n’impose pas de plafond de taille total applicatif ; le disque, PostgreSQL et les limites de requêtes restent évidemment des ressources finies.

## 3. Ouverture d’une session d’envoi

Fichiers : [`noteApp/www/js/upload/upload-task.js`](../noteApp/www/js/upload/upload-task.js), [`noteApp/www/js/api-core.js`](../noteApp/www/js/api-core.js), [`backend/src/routes/upload.routes.js`](../backend/src/routes/upload.routes.js), [`backend/src/controllers/upload.controller.js`](../backend/src/controllers/upload.controller.js), [`backend/src/models/upload.model.js`](../backend/src/models/upload.model.js).

Le client commence par envoyer une petite requête JSON :

```http
POST /api/uploads
Authorization: Bearer <jeton>
Content-Type: application/json

{
  "mime_type": "video/mp4",
  "total_size": 15728640,
  "fingerprint": "<empreinte SHA-256>",
  "caption": "Ma vidéo"
}
```

Le backend valide le type, la taille, l’empreinte et la légende. `upload.model.js` crée une ligne de vidéo avec l’état `uploading` et une ligne de session `uploads` avec un UUID, le total et `received_bytes = 0`. Les morceaux seront insérés dans `upload_chunks`; aucun fichier temporaire de session n’est créé.

Le dossier exact dépend de `UPLOAD_DIR` dans `backend/.env` et du dossier depuis lequel le backend est lancé. Avec `UPLOAD_DIR=./uploads` et un démarrage depuis `backend`, les chemins ci-dessus sont ceux du projet. Si la même personne renvoie un fichier de même empreinte avec une session encore active, le backend retourne cette session au lieu d’en créer une autre.

## 4. Envoi et écriture d’une tranche

Le client envoie les octets bruts, pas du JSON ni du Base64 :

```http
PATCH /api/uploads/<uuid>
Authorization: Bearer <jeton>
Upload-Offset: 1048576
Content-Type: application/octet-stream
Content-Length: 524288

<les octets de cette tranche>
```

La fonction correspondante est `patchChunk()` dans `api-core.js`. Elle utilise `fetch()` avec le `Uint8Array` comme corps. Côté backend, `upload.routes.js` précise qu’aucun parseur JSON ne traite le corps de cette route `PATCH`.

Dans `appendChunk()` (`backend/src/controllers/upload.controller.js`), le backend :

1. Vérifie la session et que l’utilisateur est bien son propriétaire.
2. Vérifie `Upload-Offset`, `Content-Length`, la taille maximale d’une tranche et le total annoncé.
3. Compare l’offset envoyé par le téléphone à `received_bytes` en base.
4. Lit le corps, borné par `Content-Length` et la taille maximale d’un morceau.
5. Insère `upload_id`, `video_id`, `chunk_number`, `byte_offset`, `chunk_size` et les octets `BYTEA` dans `upload_chunks`.
6. Avance `received_bytes` dans la même transaction PostgreSQL que l’insertion du morceau.

```js
// Le morceau borné est inséré avec son numéro et son offset.
// Son insertion et l'avancement de received_bytes sont dans la même transaction.
const result = await uploadModel.appendChunk(uploadId, userId, offset, data);
```

Le backend conserve en mémoire uniquement le morceau courant, borné par `Content-Length` et `UPLOAD_CHUNK_MAX_BYTES`. Les octets confirmés sont conservés dans les lignes PostgreSQL jusqu'à l'assemblage final; la vidéo entière n'est jamais chargée en mémoire.

Le schéma de la session et des morceaux est dans [`backend/database/schema.sql`](../backend/database/schema.sql). `uploads.received_bytes` est le prochain offset confirmé; les lignes `upload_chunks` contiennent les plages déjà reçues.

## 5. Coupure réseau, doublons et reprise

Le serveur est la source de vérité sur l’avancement : `received_bytes`.

- Si le client annonce un offset différent, le serveur répond **409** avec l’offset réel. Le client se recale.
- Si une tranche est coupée en plein milieu, la requête ne complète pas l’insertion transactionnelle. Aucun morceau partiel n’est conservé et `received_bytes` ne bouge pas.
- Après une erreur réseau, le client attend avec un délai croissant, demande `GET /api/uploads/<uuid>` et reprend depuis `receivedBytes`.
- Une seule requête `PATCH` par session est active à la fois ; une nouvelle requête remplace l’ancienne si elle est restée bloquée.
- Pause et annulation sont gérées par `UploadTask`. Une annulation supprime la session incomplète ; une simple coupure conserve la session.
- Android stocke seulement URI, nom, MIME, taille, signature et ID de session dans les préférences privées natives. Après redémarrage, « Reprendre » relit directement l’URI si l’autorisation existe ; sinon l’application demande de choisir à nouveau le fichier.
- Le navigateur ne persiste jamais le fichier. Tant que la page vit, il garde son objet `File` ; après rechargement il redemande le fichier. `localStorage` ne contient que des métadonnées, jamais un chemin présenté comme capable de rouvrir le fichier.
- Les sessions sans activité sont nettoyées après 24 heures par défaut : [`backend/src/services/gc.service.js`](../backend/src/services/gc.service.js), réglage `UPLOAD_SESSION_TTL_HOURS`.

Les principales fonctions du protocole se trouvent dans `UploadTask.#transfer()`, `UploadTask.#resync()` et `UploadTask.#complete()` dans `upload-task.js`.

## 6. Fin de l’upload : assemblage et passage à FFmpeg

Quand le client a envoyé toutes les tranches, il appelle `POST /api/uploads/<uuid>/complete`.

Le backend ne charge pas la vidéo entière en mémoire. À la fin, `completeUpload()` relit les lignes `upload_chunks` une par une dans l’ordre et vérifie :

1. Qu’aucune écriture n’est encore en cours.
2. Que `received_bytes` correspond à `total_size`.
3. Que les offsets et la taille assemblée correspondent au total.
4. Que les premiers octets ressemblent à un conteneur accepté (signature MP4/MOV/3GP `ftyp` ou WebM/Matroska EBML).

Il assemble ensuite un fichier source temporaire, vérifie son en-tête et le renomme vers :

```text
backend/uploads/sources/<videoId>.<extension>
```

Le modèle marque la session `complete`, la vidéo `processing`, et `transcode-queue.service.js` ajoute son ID à la file. Le client reçoit HTTP **202 Accepted** : cela signifie que le fichier est reçu et que le traitement démarre, pas que FFmpeg a déjà terminé.

### File de traitement

Fichier : [`backend/src/services/transcode-queue.service.js`](../backend/src/services/transcode-queue.service.js)

La file garde des identifiants de vidéo en mémoire, pas les fichiers vidéo. `TRANSCODE_CONCURRENCY=1` signifie qu’une vidéo est transcodée à la fois. Au démarrage du backend, `recoverPending()` relit les vidéos `processing` en base et les remet en file si le serveur avait redémarré.

## 7. FFmpeg : la source devient plusieurs fichiers HLS

Fichier : [`backend/src/services/ffmpeg.service.js`](../backend/src/services/ffmpeg.service.js)

1. `ffprobe` lit les métadonnées de la source : dimensions, durée, images par seconde, audio et rotation.
2. Le backend choisit les qualités qui ne dépassent pas la résolution source : 240p, 480p, 720p et 1080p selon la taille disponible.
3. FFmpeg est lancé comme processus externe (`spawn`) avec le chemin du fichier source. Sa sortie est écrite dans `backend/media/videos/<videoId>/`.
4. Une première passe produit 240p et 480p ; dès qu’elles sont prêtes, la vidéo passe à `ready` et peut être lue.
5. Une seconde passe ajoute 720p et 1080p si la source les permet. La playlist master est alors actualisée.
6. La source brute est supprimée à la fin, même si le transcodage échoue (`finally` dans `processOne()`).

Chaque qualité contient une playlist `index.m3u8` et des segments `.ts` (environ deux secondes chacun). `master.m3u8` présente au lecteur les qualités disponibles. Une vidéo verticale de 1080 × 1920 peut ainsi produire 240 × 426, 480 × 854, 720 × 1280 et 1080 × 1920.

Les événements `video.ready`, `video.renditions` et `video.failed` mettent l’interface à jour. La bulle d’envoi interroge aussi l’état du traitement toutes les quatre secondes comme filet de sécurité si l’événement temps réel est perdu.

## 8. Lecture/streaming du backend vers le frontend

Fichiers : [`backend/src/app.js`](../backend/src/app.js), [`noteApp/www/js/player.js`](../noteApp/www/js/player.js), `noteApp/www/js/ui/feed.js` et `noteApp/www/js/ui/reels.js`.

Une fois publiée, l’application reçoit l’URL du `master.m3u8` sous `/media/videos/<videoId>/master.m3u8`. Express vérifie que la vidéo est `ready`, puis sert la playlist et les segments depuis le dossier `media`. Les playlists ne sont pas mises en cache longtemps parce qu’elles peuvent être réécrites quand des qualités supérieures arrivent ; les segments `.ts` sont immuables et peuvent être mis en cache.

Dans le navigateur ou WebView Android, `player.js` utilise `hls.js` si disponible. Le lecteur demande la playlist, choisit une qualité selon le débit et télécharge les petits segments à mesure de la lecture. Il ne télécharge pas l’upload source original en un seul bloc. HLS.js maintient néanmoins un tampon de lecture borné (configuré dans `player.js`) : ce tampon vidéo est distinct du mécanisme d’upload.

## Carte des fichiers importants

| Rôle | Fichier |
|---|---|
| Sélecteur, aperçu, fenêtre de publication et bulle de progression | `noteApp/www/js/ui/upload-ui.js` |
| Sélecteur Android et accès URI persistant | `noteApp/cordova-plugins/vitevendre-persistent-video/src/android/VvVideoSource.java` |
| Pont JavaScript pour URI Android et plages bornées | `noteApp/www/js/upload/native-video-source.js` |
| Lecture de plage et signature chaînée de tout le contenu | `noteApp/www/js/upload/source.js` |
| SHA-256 de chaque bloc de signature | `noteApp/www/js/upload/sha256.js` |
| Taille adaptative 512 Kio–2 Mio web, 512 Kio–1 Mio Android | `noteApp/www/js/upload/chunk-sizer.js` |
| Session, tranches, pause, reprise, retry et fin | `noteApp/www/js/upload/upload-task.js` |
| Requêtes HTTP `POST`, `GET`, `PATCH`, `complete`, `abort` | `noteApp/www/js/api-core.js` |
| Déclaration des routes upload | `backend/src/routes/upload.routes.js` |
| Validation, stockage des morceaux et assemblage | `backend/src/controllers/upload.controller.js` |
| Sessions, morceaux, offsets et transactions PostgreSQL | `backend/src/models/upload.model.js` |
| Tables `videos`, `uploads` et `upload_chunks` | `backend/database/schema.sql` |
| Nettoyage de sessions abandonnées | `backend/src/services/gc.service.js` |
| File FFmpeg et reprise après redémarrage | `backend/src/services/transcode-queue.service.js` |
| FFprobe, FFmpeg, qualités HLS et poster | `backend/src/services/ffmpeg.service.js` |
| Service HTTP des playlists et segments | `backend/src/app.js` |
| Lecteur HLS adaptatif | `noteApp/www/js/player.js` |

## Formulation courte pour l’expliquer à l’oral

> « Le téléphone ne charge pas toute la vidéo en mémoire. Android conserve une URI accordée par le sélecteur système ; le navigateur garde son objet `File`. Le client lit des plages bornées, calcule une signature par blocs, puis envoie chaque tranche en `PATCH`. PostgreSQL enregistre chaque morceau avec sa session, sa vidéo et son offset dans une transaction. En cas de coupure, le client reprend à `receivedBytes`. Quand tous les morceaux sont reçus, le backend les assemble en fichier source, supprime leurs lignes après vérification et passe la vidéo à FFmpeg pour produire le HLS. »

