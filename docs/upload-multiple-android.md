# File d’upload vidéo

## Architecture livrée

- `noteApp/www/js/upload/storage.js` garde uniquement les métadonnées de chaque tâche dans IndexedDB. Les transactions sont atomiques et les index couvrent `status`, `createdAt` et `uploadSessionId`.
- `upload-queue.js` maintient une file FIFO, déduplique une URI déjà en file, exécute deux uploads en parallèle par défaut (configurable avec `localStorage.setItem('vv.uploadConcurrency', '1'..'5')`) et fournit pause, reprise, annulation et réordonnancement.
- `UploadTask` garde le protocole backend existant. Les offsets du serveur restent la source de vérité après une coupure. Chaque tâche a son AbortController.
- Le sélecteur natif Cordova ouvre le Storage Access Framework en mode multiple. Le plugin conserve uniquement la permission Android gérée par le système ; il ne stocke aucune métadonnée de tâche. Il confirme le grant, vérifie la source, lit des plages bornées et ferme chaque descripteur après la lecture.
- Après redémarrage, les tâches Android sont reconstruites depuis IndexedDB et les URI sont vérifiées à la reprise. Dans le navigateur, le navigateur ne permet pas de reconstituer un objet `File` après fermeture ; une nouvelle sélection est donc requise.
- Les métadonnées ne sont effacées qu’après `video.ready`. Un échec de traitement conserve l’entrée. L’annulation ne supprime l’entrée qu’après confirmation du DELETE côté serveur. Aucun code client ne supprime l’original.

## Vérification exécutée

- `npm.cmd test` dans `noteApp` : réussi (syntaxe de tous les modules JavaScript).
- `npx.cmd cordova build android` : non terminé ; Gradle n’a pas démarré, erreur Windows de chargement de `native-platform.dll`. Le code Android n’a donc pas été compilé dans cette session.
- Tests réels sur appareil : non exécutés ici. À valider sur le téléphone connecté avec la matrice ci-dessous.

## Matrice appareil à compléter

| Scénario | Résultat |
| --- | --- |
| Sélectionner plusieurs vidéos et voir chaque URI dans IndexedDB | À exécuter sur appareil |
| Ajouter une vidéo pendant deux uploads actifs | À exécuter sur appareil |
| Couper le réseau, relancer l’app, reprendre aux offsets serveur | À exécuter sur appareil |
| Supprimer ou révoquer une source, vérifier son état et le message | À exécuter sur appareil |
| Reprendre une URI Android et vérifier ses droits et métadonnées | À exécuter sur appareil |
| Annuler B pendant que A continue | À exécuter sur appareil |
| Perdre la réponse de finalisation, vérifier que les métadonnées restent | À exécuter sur appareil |
| Confirmer `video.ready`, vérifier le nettoyage IndexedDB et le grant | À exécuter sur appareil |
| Vérifier l’original dans la galerie et l’absence de copie Cordova | À exécuter sur appareil |

Android peut interrompre le JavaScript lorsque l’application est suspendue ; la reprise fonctionne au prochain lancement, mais l’upload en arrière-plan n’est pas fourni.
