# ViteVendre : upload reprenable et lecture vidéo HLS

Ce document suit une vidéo depuis le sélecteur du téléphone jusqu’au backend, puis explique comment elle est convertie et lue. Les chemins ci-dessous sont relatifs à la racine du projet.

## Résumé en une minute

1. Le client garde un objet `File` fourni par le navigateur/Cordova. Il ne charge pas le fichier vidéo entier en mémoire.
2. Il lit une tranche à la fois avec `file.slice()`. La tranche commence à **512 Kio** (512 × 1024 octets), s’adapte au débit, et ne dépasse pas **2 Mio** (2 × 1024 × 1024 octets).
3. Chaque tranche est envoyée en requête HTTP `PATCH`. Le backend la fait passer dans un flux Node.js vers un fichier temporaire `.tmp`.
4. PostgreSQL enregistre l’offset confirmé. Après une coupure, le client demande cet offset au serveur et reprend à cet endroit.
5. Quand tous les octets sont reçus, le backend vérifie la taille et le format, déplace le fichier source, met la vidéo en traitement et la place dans la file FFmpeg.
6. FFmpeg écrit des playlists HLS et des segments vidéo sur le disque. Le frontend lit ensuite la playlist et les segments à la demande.

**« Sans passer par la RAM » signifie ici « sans mettre le fichier complet en RAM ».** Le navigateur garde une tranche en mémoire pendant sa lecture et son envoi ; Node.js et FFmpeg utilisent également leurs tampons de flux normaux. La mémoire utilisée reste limitée par rapport à la taille totale d’une vidéo.

## 1. Sélection et lecture côté client

Fichier : [`noteApp/www/js/ui/upload-ui.js`](../noteApp/www/js/ui/upload-ui.js)

Le champ de sélection est un `<input type="file" accept="video/*">`. Le navigateur donne un objet `File`, qui décrit le fichier choisi et permet de lire des plages sans charger le tout.

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

Avant l’envoi, `computeFingerprint()` dans `source.js` lit seulement les **64 Kio du début**, les **64 Kio de la fin** et utilise aussi la taille totale. Ces octets sont hachés en SHA-256 par [`noteApp/www/js/upload/sha256.js`](../noteApp/www/js/upload/sha256.js).

Cette empreinte sert à retrouver une session interrompue, même si le fichier a été renommé. **Ce n’est pas un SHA-256 de tous les octets de la vidéo** et le serveur ne relit pas la vidéo entière pour recalculer cette empreinte.

## 2. Combien de mégaoctets par morceau ?

Fichier : [`noteApp/www/js/upload/chunk-sizer.js`](../noteApp/www/js/upload/chunk-sizer.js)

| Situation | Taille de la tranche côté client |
|---|---:|
| Début d’envoi ou après une erreur réseau | 512 Kio (0,5 Mio) |
| Réseau stable et rapide | Augmente par pas de 256 Kio |
| Maximum côté client | 2 Mio |
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

Le backend valide le type, la taille, l’empreinte et la légende. `upload.model.js` crée une ligne de vidéo avec l’état `uploading` et une ligne de session `uploads` avec un UUID, le total et `received_bytes = 0`. Il crée aussi le fichier temporaire correspondant :

```text
backend/uploads/sessions/<uuid>.tmp
```

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
4. Transmet le corps avec `pipeline(req, fs.createWriteStream(...))` au fichier temporaire, en mode append (`flags: 'a'`).
5. Vérifie que le nombre d’octets réellement reçus est celui annoncé.
6. Avance `received_bytes` dans PostgreSQL seulement après l’écriture complète.

```js
// Le flux HTTP req est pompé vers le disque ; la vidéo complète n’est pas accumulée en Buffer.
await pipeline(req, fs.createWriteStream(file, { flags: 'a' }));

// L’offset en base avance uniquement après réception exacte de la tranche.
const received = await uploadModel.advance(uploadId, userId, dbOffset, dbOffset + length);
```

`pipeline()` propage les erreurs et applique la contre-pression des flux : si le disque ne suit pas, la lecture du flux réseau ralentit au lieu de remplir une énorme variable en mémoire. Le serveur compte les octets reçus avec un compteur, mais ne les conserve pas tous en mémoire.

Le schéma de la session est dans [`backend/database/schema.sql`](../backend/database/schema.sql). La ligne `uploads.received_bytes` est le prochain offset confirmé, et le fichier `.tmp` contient les octets déjà écrits dans l’ordre.

## 5. Coupure réseau, doublons et reprise

Le serveur est la source de vérité sur l’avancement : `received_bytes`.

- Si le client annonce un offset différent, le serveur répond **409** avec l’offset réel. Le client se recale.
- Si une tranche est coupée en plein milieu, le backend tronque le `.tmp` à la dernière position validée en base. Les octets incomplets ne sont pas considérés comme reçus.
- Après une erreur réseau, le client attend avec un délai croissant, demande `GET /api/uploads/<uuid>` et reprend depuis `receivedBytes`.
- Une seule requête `PATCH` par session est active à la fois ; une nouvelle requête remplace l’ancienne si elle est restée bloquée.
- Pause et annulation sont gérées par `UploadTask`. Une annulation supprime la session incomplète ; une simple coupure conserve la session.
- Après fermeture/redémarrage de l’application, `localStorage` garde les métadonnées de l’envoi, pas les octets de la vidéo. L’utilisateur choisit à nouveau le fichier. Son empreinte est comparée, puis l’envoi reprend à l’offset du serveur.
- Les sessions sans activité sont nettoyées après 24 heures par défaut : [`backend/src/services/gc.service.js`](../backend/src/services/gc.service.js), réglage `UPLOAD_SESSION_TTL_HOURS`.

Les principales fonctions du protocole se trouvent dans `UploadTask.#transfer()`, `UploadTask.#resync()` et `UploadTask.#complete()` dans `upload-task.js`.

## 6. Fin de l’upload : assemblage et passage à FFmpeg

Quand le client a envoyé toutes les tranches, il appelle `POST /api/uploads/<uuid>/complete`.

Le backend ne concatène pas des morceaux gardés en mémoire : **ils ont déjà été ajoutés dans l’ordre dans le même fichier `.tmp`**. À la fin, `completeUpload()` vérifie :

1. Qu’aucune écriture n’est encore en cours.
2. Que `received_bytes` correspond à `total_size`.
3. Que la taille du fichier `.tmp` correspond au total.
4. Que les premiers octets ressemblent à un conteneur accepté (signature MP4/MOV/3GP `ftyp` ou WebM/Matroska EBML).

Il déplace ensuite le fichier temporaire — opération de renommage sur le même disque, sans reconstruire le fichier en RAM — vers :

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
| Lecture d’une tranche et empreinte | `noteApp/www/js/upload/source.js` |
| SHA-256 de l’empreinte partielle | `noteApp/www/js/upload/sha256.js` |
| Taille adaptative 512 Kio–2 Mio | `noteApp/www/js/upload/chunk-sizer.js` |
| Session, tranches, pause, reprise, retry et fin | `noteApp/www/js/upload/upload-task.js` |
| Requêtes HTTP `POST`, `GET`, `PATCH`, `complete`, `abort` | `noteApp/www/js/api-core.js` |
| Déclaration des routes upload | `backend/src/routes/upload.routes.js` |
| Validation et écriture flux vers `.tmp` | `backend/src/controllers/upload.controller.js` |
| Sessions, offset et transactions PostgreSQL | `backend/src/models/upload.model.js` |
| Tables `videos` et `uploads` | `backend/database/schema.sql` |
| Nettoyage de sessions abandonnées | `backend/src/services/gc.service.js` |
| File FFmpeg et reprise après redémarrage | `backend/src/services/transcode-queue.service.js` |
| FFprobe, FFmpeg, qualités HLS et poster | `backend/src/services/ffmpeg.service.js` |
| Service HTTP des playlists et segments | `backend/src/app.js` |
| Lecteur HLS adaptatif | `noteApp/www/js/player.js` |

## Formulation courte pour l’expliquer à l’oral

> « Le téléphone ne charge pas toute la vidéo en mémoire. Il lit le fichier par tranches de 512 Kio à 2 Mio et envoie chaque tranche en `PATCH`. Le backend écrit le flux directement dans un fichier temporaire et confirme l’offset dans PostgreSQL. En cas de coupure, le téléphone redemande l’offset confirmé et repart de là. Quand la taille reçue est complète, le backend renomme ce fichier dans le dossier source et met son ID dans une file FFmpeg. FFmpeg fabrique les qualités HLS et leurs segments sur le disque. Le lecteur reçoit la playlist HLS puis charge les segments nécessaires selon le débit réseau. »

