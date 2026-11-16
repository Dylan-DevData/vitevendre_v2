# Fonctionnement de l’upload vidéo ViteVendre

Ce schéma décrit le trajet d’une vidéo depuis sa sélection sur Android jusqu’à sa publication, ainsi que la reprise d’un transfert interrompu.

## Schéma de fonctionnement

![Schéma graphique du fonctionnement complet de l’upload vidéo](./schema-fonctionnement-upload-video.svg)

Le diagramme ci-dessus est une image SVG intégrée au document; elle reste visible même si l’aperçu Markdown ne sait pas afficher Mermaid.

Le SVG ci-dessus suit les étapes dans l’ordre. Orange : reprise après coupure réseau. Rouge : arrêt de la seule tâche concernée.

## Lecture du schéma

1. **Sélection** — Android peut renvoyer plusieurs URI `content://`. Le plugin demande l’autorisation de lecture et récupère le nom, le type, la taille et les métadonnées disponibles.
2. **Association locale** — La file crée une tâche avec un identifiant unique pour chaque vidéo. IndexedDB enregistre cette tâche, son URI, son état et, dès qu’elle existe, son `uploadId`. Elle ne reçoit jamais les octets vidéo.
3. **Accès au contenu** — JavaScript transmet l’URI au plugin Cordova. Android résout l’URI avec `ContentResolver` et lit la plage demandée depuis le fichier original.
4. **Empreinte** — Le plugin Android calcule l’empreinte de contenu par blocs de 512 Kio, avec un tampon borné. Cette vérification ne charge pas la vidéo entière en mémoire.
5. **Session serveur** — Le client envoie les métadonnées nécessaires avec `POST /api/uploads`. Le backend renvoie un `uploadId` propre à cette vidéo; l’application le sauvegarde dans sa tâche IndexedDB.
6. **Transfert par morceaux** — Pour chaque morceau, le client lit une plage de la source et l’envoie avec `PATCH /api/uploads/:id` et l’en-tête `Upload-Offset`. Le backend ajoute les octets au fichier temporaire de cette session et met à jour `receivedBytes` dans PostgreSQL.
7. **Plusieurs envois** — Chaque vidéo a sa propre tâche, sa propre URI et sa propre session. La file démarre au maximum deux tâches à la fois par défaut; la limite est réglable.
8. **Coupure et reprise** — Après reconnexion ou redémarrage, l’application retrouve chaque tâche grâce à son identifiant, rouvre son URI avec le plugin, puis demande au serveur l’état de son `uploadId`. `receivedBytes` donné par le serveur est la position de reprise faisant foi. Les octets déjà confirmés ne sont pas renvoyés.
9. **Finalisation** — Quand tous les octets sont reçus, le client appelle `POST /api/uploads/:id/complete`. Le backend vérifie le fichier temporaire, le déplace dans son stockage source, met la vidéo en traitement, puis lance FFmpeg pour produire le streaming HLS.
10. **Nettoyage local** — Le client retire la tâche temporaire d’IndexedDB seulement après la confirmation finale que la vidéo est prête. Le fichier original du téléphone n’est pas supprimé.

## Comment IndexedDB relie une URI à la bonne vidéo

Chaque tâche possède une clé `id` unique et conserve sa propre URI ainsi que son `uploadSessionId` :

| Clé de tâche | URI Android | Session serveur |
|---|---|---|
| `tache-A` | `content://…/video/125` | `session-A` |
| `tache-B` | `content://…/video/348` | `session-B` |

L’URI sert au plugin Android pour rouvrir le fichier. L’`uploadSessionId` sert à interroger le serveur pour cette même vidéo. `uploadedBytes` est une valeur locale indicative; le serveur reste la source de vérité pour la reprise.

## Limites à expliquer à l’oral

- `content://…` est une référence comprise par Android, pas un chemin physique que JavaScript peut ouvrir directement.
- Une autorisation persistante dépend du fournisseur Android. Si elle n’est pas conservée ou si l’URI ne fonctionne plus après redémarrage, l’application doit demander une nouvelle sélection.
- IndexedDB conserve les informations de reprise, mais ne garde pas JavaScript actif en arrière-plan. Si Android ferme l’application, le transfert s’arrête jusqu’à sa réouverture.
- Le backend suit un offset cumulatif (`receivedBytes`) car les morceaux sont envoyés dans l’ordre; il ne dépend pas d’une liste locale de morceaux supposés reçus.
