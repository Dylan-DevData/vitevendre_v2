# Backend ViteVendre v2

API Express 5 + PostgreSQL + FFmpeg. Voir le `README.md` à la racine pour le démarrage, et `API_UPLOAD.md` pour le protocole d'upload.

| Zone | Fichiers |
|---|---|
| Comptes (téléphone + mot de passe, JWT) | `controllers/auth.controller.js`, `models/user.model.js` |
| Upload reprenable par offset | `controllers/upload.controller.js`, `models/upload.model.js`, `routes/upload.routes.js` |
| Transcodage HLS | `services/ffmpeg.service.js`, `services/transcode-queue.service.js` |
| Nettoyage des sessions abandonnées | `services/gc.service.js` |
| Fil, J'aime | `controllers/video.controller.js`, `models/video.model.js` |
| Temps réel : hub d'événements + SSE | `services/events.service.js`, `routes/events.routes.js` |
| Temps réel : WebSocket (`ws`) | `services/realtime.service.js` (branché dans `server.js`) |
| Commentaires | `controllers/comment.controller.js`, `models/comment.model.js`, `routes/comment.routes.js` |
| Profils publics, abonnements | `controllers/user.controller.js`, `models/follow.model.js`, `routes/user.routes.js` |
| Schéma | `database/schema.sql` |

Routes : `POST /api/auth/register|login` · `/api/uploads` (voir API_UPLOAD.md) · `GET /api/videos?before=&limit=&author=me|<id>` · `GET /api/videos/:id` · `POST|DELETE /api/videos/:id/like` · `GET /api/events?token=…` (SSE : `video.ready`, `video.renditions`, `video.failed`, `feed.new`) · `/media/videos/:id/master.m3u8` (servi seulement si la vidéo est publiée).

### Commentaires, abonnements, profils (v3)

| Route | Rôle |
|---|---|
| `GET /api/videos/:id/comments?before=&limit=` | commentaires du plus récent au plus ancien (`comments`, `total`, `nextBefore`) |
| `POST /api/videos/:id/comments` `{ "body": "…" }` | ajoute un commentaire (1 à 500 caractères, 8 par minute et par personne, sinon 429) |
| `DELETE /api/comments/:id` | supprime : auteur du commentaire, propriétaire de la vidéo ou admin (sinon 403) |
| `GET /api/users/:id` | profil public : `videoCount`, `followerCount`, `followingCount`, `likeCount`, `followedByMe`, `isMe` |
| `POST\|DELETE /api/users/:id/follow` | suivre / ne plus suivre (idempotent ; 400 si on se suit soi-même) |

Les vidéos renvoyées par l'API contiennent aussi `commentCount` et `author.followedByMe`.
La liste des vidéos d'un auteur reste `GET /api/videos?author=<id>`.

### Temps réel par WebSocket

Connexion : `ws://hôte:3000/ws?token=<jwt>` (`wss://` derrière HTTPS). Sans jeton : lecture seule anonyme ; jeton invalide : 401.

- Client → serveur : `{"type":"join"|"leave","room":"video:12"}` · `{"type":"ping"}`. Salons autorisés : `video:<id>` (30 par connexion au plus).
- Serveur → client : `{"event":"…","data":{…}}`.

| Événement | Destinataires | Données |
|---|---|---|
| `hello` | la connexion | `userId` |
| `comment.new` | salon `video:<id>` | `videoId`, `comment`, `commentCount` |
| `comment.deleted` | salon `video:<id>` | `videoId`, `commentId`, `commentCount` |
| `video.stats` | tout le monde | `videoId` + `likeCount` et/ou `commentCount` (valeurs absolues) |
| `user.stats` | tout le monde | `userId`, `followerCount` |
| `follow.new` | la personne suivie | `follower {id,name}`, `followerCount` |
| `video.ready`, `video.renditions`, `video.failed` | l'auteur de la vidéo | comme avant |
| `feed.new` | tout le monde | `videoId` |

Mise à jour d'une base existante : `npm install` (ajoute `ws`) puis `npm run db:init` — les nouvelles tables sont créées sans toucher aux données.
Tests : `npm test` (le test `social-live.test.js` demande `E2E_DATABASE_URL`).

Variables d'environnement : voir `.env.example`. `UPLOAD_SESSION_TTL_HOURS` (24) fixe le délai du nettoyage, `MAX_VIDEO_BYTES` (0 = sans plafond) la taille maximale.
