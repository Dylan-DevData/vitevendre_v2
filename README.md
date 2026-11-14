# ViteVendre v2 — vidéos courtes avec upload résilient et streaming adaptatif

Application mobile (Cordova) + API (Node.js / Express / PostgreSQL / FFmpeg) pour publier et regarder des vidéos,
pensée pour les réseaux instables : l'envoi reprend après chaque coupure, la lecture baisse la qualité toute seule.

```
backend/   API Express : comptes, upload reprenable, transcodage HLS, fil, J'aime, temps réel (SSE)
noteApp/   Application Cordova (JS pur, ES modules) : fil, Explorer, Reels plein écran, profil, bulle d'envoi
docs/ancien-projet/   Anciens documents de la version « marketplace » (archivés, plus à jour)
```

## Démarrage rapide

Prérequis : Node 20+, PostgreSQL 13+, FFmpeg et FFprobe dans le PATH.

```bash
# 1. Backend
cd backend
cp .env.example .env          # renseigner DATABASE_URL et JWT_SECRET
npm install
npm run db:init               # crée les tables (npm run db:reset pour tout effacer)
npm start                     # écoute sur le port 3000

# 2. Client dans un navigateur (test rapide)
cd ../noteApp && npm install  # copie aussi hls.js dans www/lib
cd www && python3 -m http.server 8000
# ouvrir http://IP_DE_LA_MACHINE:8000/?api=http://IP_DE_LA_MACHINE:3000

# 3. Client Android
cd .. && cordova platform add android   # première fois seulement
# adapter API_BASE_URL dans www/js/config.js (ou 10.0.2.2:3000 pour l'émulateur)
cordova run android
```

## Ce que fait le système

**Upload (client → serveur)** — détail du protocole dans `backend/API_UPLOAD.md`
- Le fichier n'est jamais chargé en mémoire : le client lit une tranche à la fois avec `file.slice()`.
- Taille de morceau adaptative de 512 Ko à 2 Mo : +256 Ko après deux succès si le débit le permet, retour à 512 Ko après une coupure.
- Empreinte = SHA-256 des 64 premiers Ko + 64 derniers Ko + taille exacte. Renommer le fichier ne change rien ; un fichier différent est détecté.
- Reprise : le serveur est la source de vérité (`receivedBytes`). Après coupure, le client l'interroge et repart à cet octet, sans renvoyer ce qui est validé.
- Fichier supprimé ou déplacé pendant une pause : la lecture échoue, l'envoi s'arrête proprement et l'utilisateur est prévenu. Il peut resélectionner le fichier pour reprendre.
- Côté serveur, chaque morceau est écrit en flux à la fin d'un seul fichier `.tmp` (`createWriteStream`, flags `a`). Un morceau interrompu en route est ignoré.
- Une session sans activité depuis 24 h est supprimée automatiquement (fichier et base).

**Transcodage (serveur)**
- Une seule commande FFmpeg décode la source une fois et produit HLS 240p, 480p, 720p et 1080p (jamais au-dessus de la source).
- 240p et 480p sortent d'abord et la vidéo est publiée tout de suite ; 720p et 1080p sont ajoutés ensuite et le `master.m3u8` est réécrit.
- Les résolutions se mesurent sur le petit côté : une vidéo verticale 1080×1920 donne 240×426, 480×854, 720×1280, 1080×1920.
- La source brute est supprimée après le transcodage.

**Lecture (client)**
- hls.js choisit la qualité selon le débit mesuré et redescend seul si le réseau se dégrade. Un plafond s'ajoute selon le réseau : 2G ou économie de données → 240p ; 3G ou réglage « Économiser les données » → 480p ; sinon jusqu'à 1080p.
- Reels plein écran : défilement aimanté, une seule vidéo joue, la suivante est préchargée (quelques secondes), double-tap sur les bords = −5 s / +5 s, au centre = J'aime, indicateur de chargement avec message « Connexion lente… ».
- Bulle d'envoi façon Telegram : progression, vitesse, temps restant, pause/reprise, attente du réseau, passage « Traitement » → « Publiée » en direct (événements SSE, avec interrogation de secours).

## Tests

```bash
cd backend
E2E_DATABASE_URL=postgresql://utilisateur@localhost:5432/base_de_test npm test
```
⚠️ Les tests **effacent le schéma public** de cette base : utiliser une base dédiée. Sans `E2E_DATABASE_URL`, les tests de bout en bout sont ignorés. Ils couvrent : coupure en plein morceau, reprise, fichier renommé, fichier supprimé, hors-ligne, transcodage HLS réel, nettoyage 24 h, temps réel, J'aime et visibilité.

`cd noteApp && npm test` vérifie la syntaxe des modules du client.

## Limites connues
- Non testé sur un vrai téléphone Android : les essais ont eu lieu dans Chrome (mobile émulé, réseau limité et coupé). À valider : sélection d'un gros fichier via le sélecteur Android et comportement du WebView en arrière-plan.
- L'envoi s'arrête si Android suspend l'application. Au retour, la bulle propose de reprendre (le serveur garde la session 24 h).
- FFmpeg en 1080p est coûteux en processeur : `TRANSCODE_CONCURRENCY=1` traite une vidéo à la fois.
- Fonctions volontairement absentes de cette version : abonnements, commentaires, recherche, compression sur le téléphone avant envoi.
