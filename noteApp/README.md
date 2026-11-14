# Client ViteVendre v2 (Cordova)

JS pur en modules ES, sans framework. Voir le `README.md` à la racine.

- `www/js/upload/` : `source.js` (lecture par `file.slice()`, empreinte, fichier disparu), `chunk-sizer.js` (512 Ko–2 Mo), `upload-task.js` (envoi, pause, reprise, hors-ligne), `sha256.js` (repli quand `crypto.subtle` est absent en `http://localhost`).
- `www/js/player.js` : hls.js, plafond de résolution selon le réseau, réglage « Économiser les données ».
- `www/js/ui/` : `feed.js` (Accueil), `reels.js` (plein écran), `explore.js`, `profile.js`, `upload-ui.js` (fenêtre de création et bulle d'envoi), `auth.js`.
- `www/js/api-core.js` : client HTTP sans dépendance au navigateur (utilisé aussi par les tests du backend).
- Adresse du serveur : `www/js/config.js` (ou `?api=http://hote:3000` dans l'URL en test navigateur).
