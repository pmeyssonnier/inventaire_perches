# Inventaire des perches — Patro Sainte-Suzanne

Application web qui suit le stock de perches par taille : combien on en possède, combien
sont sorties, combien sont revenues. Elle s'installe sur un téléphone et **fonctionne sans
réseau**, ce qui est l'usage normal en camp.

## Fonctions

- Stock par taille, regroupé par couleur de marquage, avec jauge de disponibilité et
  total disponible en tête de page.
- Sortie et retour de perches, avec historique horodaté par type de mouvement.
- Réglages : ajout et suppression de tailles, quantité totale, couleur assignée
  (palette de 20 teintes nommées, ou sélecteur libre), remise à niveau du stock.
- Export et import JSON, avec copie de secours automatique avant tout import.
- Accès protégé par un code PIN.
- Installable (PWA) et **entièrement utilisable hors connexion** : aucune ressource
  n'est chargée depuis un domaine tiers.
- Utilisable au clavier et avec un lecteur d'écran : onglets parcourus aux flèches,
  couleurs annoncées par leur nom, notifications lues à voix haute.

## Où sont les données

Tout est stocké dans le `localStorage` du navigateur, **sur l'appareil et nulle part
ailleurs**. Il n'y a pas de serveur, pas de compte, pas de synchronisation.

Conséquences à connaître :

- Vider les données de navigation, désinstaller l'application ou changer de téléphone
  **efface l'inventaire**.
- Chaque appareil a son propre inventaire ; ils ne se parlent pas.
- **L'export JSON est la seule sauvegarde.** Exportez après chaque grosse modification, et
  gardez le fichier ailleurs que sur l'appareil.

Le transfert d'un appareil à l'autre se fait par « Exporter en JSON » d'un côté et
« Importer un JSON » de l'autre.

## Conditions de fonctionnement

Deux exigences du navigateur, dont l'absence est signalée à l'écran plutôt que de
laisser l'application muette :

- **Contexte sécurisé.** La vérification du code PIN passe par `crypto.subtle`, qui
  n'existe qu'en HTTPS ou sur `localhost`. Servir la page en `http://` sur une adresse
  du réseau local — pour l'installer sur les téléphones, par exemple — empêche donc
  le déverrouillage.
- **Stockage autorisé.** En navigation privée sur iPhone, ou quand le stockage du site
  est bloqué, `localStorage` refuse la moindre écriture : l'application le dit et
  n'affiche pas un inventaire qu'elle ne saurait pas conserver.

## Ce que le code PIN protège, et ce qu'il ne protège pas

Le code PIN **empêche quelqu'un d'ouvrir l'inventaire en prenant le téléphone**. C'est tout,
et c'est déjà utile.

Il ne chiffre rien. L'inventaire est écrit en clair dans le stockage du navigateur : qui sait
ouvrir la console de développement le lit sans connaître le code. Ne mettez donc dans cette
application rien que vous ne confieriez pas à un carnet laissé sur la table.

Le code est haché en SHA-256 avant d'être enregistré, sans sel et sans limitation du nombre
d'essais : un code à quatre chiffres se retrouve par force brute. Pour une vraie protection,
il faudrait dériver une clé du PIN et chiffrer les données (PBKDF2 + AES-GCM) — ce n'est pas
fait aujourd'hui.

## Si l'inventaire devient illisible

Si le contenu enregistré ne peut plus être relu, l'application **n'écrit plus rien** et
affiche un écran dédié. Le contenu d'origine est mis de côté intact et reste exportable
depuis cet écran. On peut alors restaurer la copie de secours, ou repartir d'un inventaire
vide en connaissance de cause.

Quand seules quelques entrées sont abîmées, elles sont écartées, le reste est conservé et un
message indique combien ont été ignorées.

## Lancer en local

Une PWA doit être servie en HTTP ou HTTPS — l'ouvrir en `file://` ne marche pas.

```bash
python -m http.server 8080
```

Puis <http://localhost:8080>.

## Structure

```
index.html               balisage seul
app.js                   toute la logique
styles.css               styles + @font-face locales
service-worker.js        pré-chargement et service hors connexion
manifest.webmanifest     métadonnées d'installation
icons/                   logo et icônes 192 / 512 / favicon
fonts/                   Inter et Roboto Slab, sous-ensemble latin (woff2)
```

## Déploiement

`.github/workflows/deploy-pages.yml` publie la racine du dépôt sur GitHub Pages à chaque
push sur `main`.

Prérequis, à faire **une seule fois** : **Settings → Pages → Build and deployment →
Source = GitHub Actions**. GitHub n'autorise pas un workflow à créer lui-même le site.

Le workflow vérifie la syntaxe de `app.js` et `service-worker.js` avant de publier, puis
inscrit le SHA du commit dans le nom du cache du service worker. Il n'y a donc **aucun
numéro de version à incrémenter à la main** : chaque déploiement repart d'un cache neuf et
atteint les applications déjà installées.

Le fichier `.nojekyll` désactive le traitement Jekyll, sans quoi GitHub Pages ne sert pas
correctement le service worker et le manifeste.

## Format du fichier JSON

```json
{
  "version": 1,
  "exportedAt": "2026-09-14T20:47:00.000Z",
  "poles": [
    { "id": "pA", "size": 3.2, "total": 8, "stock": 6, "color": "#43AA8B" }
  ],
  "movements": [
    { "id": "m1", "type": "sortie", "size": 3.2, "qty": 2, "date": "2026-09-14T20:45:00.000Z" }
  ]
}
```

- `size` en mètres, `total` et `stock` entiers positifs, `color` en `#RRGGBB` ou `null`.
- `type` vaut `sortie` ou `retour`.
- À l'import : 1 Mo maximum, 1 000 tailles et 10 000 mouvements au plus. Les tailles sont
  arrondies à deux décimales, celle affichée, et plafonnées à 100 m.
- À l'enregistrement, l'historique est plafonné aux **500 mouvements les plus récents de
  chaque type**, sans quoi le stockage du navigateur finit par saturer. Les mouvements
  importés sont d'abord retriés du plus récent au plus ancien : un fichier rangé dans
  l'autre sens perdrait sinon ses mouvements récents plutôt que ses vieux.
