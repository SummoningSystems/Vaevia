# Mettre le serveur en ligne pour l'équipe (étape 3.7, A2)

Par défaut, le serveur n'écoute que sur la machine qui le fait tourner. `-Reseau` (installeur Windows) ou `WDD_PORT_PUBLIE` (Docker) l'ouvrent au réseau, mais en HTTP clair : liens d'invitation et cookies de session passent alors en clair. Pour une équipe qui ne partage pas un bureau, il faut du HTTPS devant le serveur. C'est ce que fait cette page, avec Caddy, un mandataire HTTPS en un seul binaire, ajouté à Docker Compose.

## Ce qu'il faut

- **Une machine qui fait tourner Docker**, avec les ports 80 et 443 ouverts vers elle.
- **Deux noms qui pointent vers cette machine** :
  - un pour l'administration (`WDD_DOMAINE`, par ex. `retours.exemple.fr`) ;
  - un pour les Wikis (`WDD_DOMAINE_PAGES`, par ex. `retours-pages.exemple`).

  De préférence, ce sont deux domaines différents, pas un sous-domaine : voir `serveur/README.md`, « Isolement des pages ». Le Wiki d'un projet contient du contenu envoyé par les agents, et il ne doit pas tourner sur l'origine de l'administration.
- **Sur Internet :** rien d'autre. Caddy obtient et renouvelle seul les certificats (Let's Encrypt).
- **Sur un réseau isolé :** une autorité interne (voir plus bas), et des noms résolus par le DNS interne ou par le fichier `hosts` de chaque poste.

## Étapes

1. Dans `.env` (copie de `.env.exemple`), régler les domaines :

   ```sh
   WDD_DOMAINE=retours.exemple.fr
   WDD_DOMAINE_PAGES=retours-pages.exemple
   # Réseau isolé seulement :
   # WDD_CADDYFILE=Caddyfile.interne
   ```

   `WDD_URL`, `WDD_URL_PAGES` et `WDD_HTTPS=1` sont posés par `docker-compose.https.yml` à partir de ces deux noms : ne pas les remplir à la main. Laisser `WDD_PORT_PUBLIE` à `127.0.0.1:8080` : le serveur reste joignable par Caddy et par la machine elle-même seulement.

2. Lancer :

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
   ```

3. Ouvrir `https://<WDD_DOMAINE>/`. Au premier démarrage, le lien du compte admin est dans le conteneur :

   ```sh
   docker compose exec wdd cat /donnees/lien-admin.txt
   ```

4. **Pour un poste de développeur :** `outil brancher` avec `https://<WDD_DOMAINE>`. La phrase de branchement de l'écran du projet donne déjà la bonne adresse.

## Réseau isolé (sans Internet)

`WDD_CADDYFILE=Caddyfile.interne` fait signer les certificats par l'autorité interne de Caddy (`tls internal`), sans aucun appel sortant. Son certificat racine est à installer sur chaque poste de l'équipe, dans le magasin des autorités de confiance :

```sh
docker compose -f docker-compose.yml -f docker-compose.https.yml exec caddy cat /data/caddy/pki/authorities/local/root.crt > racine-caddy.crt
```

Ce fichier n'est pas secret : c'est la clé privée qui l'est, et elle reste dans le volume `wdd-caddy`. Pour un réseau qui a déjà sa propre autorité, remplacer `tls internal` par les chemins de son certificat et de sa clé (directive `tls <cert> <clé>` de Caddy). Les notifications vers une messagerie interne demandent en plus `WDD_NOTIF_LOCALES=1`.

## Ce qu'il faut savoir avant d'ouvrir

- **Les liens d'invitation et d'entrée deviennent joignables depuis Internet.** Un lien d'invitation vaut 7 jours au plus, une fois. Le lien d'entrée sur l'hôte des pages vaut 60 s, une fois, et n'est pas lié au navigateur (écart 27 de l'étape 3). Envoyer les invitations par un canal privé.
- **Sauvegardes.** Activer la sauvegarde (Administration → Sauvegarde ; volume `wdd-sauvegardes`), et sauvegarder aussi le volume `wdd-caddy` (certificats, autorité interne). Pour restaurer sous Docker, le serveur doit être arrêté :

  ```sh
  docker compose stop wdd
  docker compose run --rm wdd node serveur/src/restaurer.ts /sauvegardes/sauvegarde-AAAAMMJJ-HHMMSS
  docker compose start wdd
  ```

  `/donnees` est un point de montage, qui ne peut pas être renommé. Les anciennes données sont donc gardées dans `/donnees/.avant-restauration-<date>`, dans le même volume.
- **Version de Caddy.** Elle est figée (`caddy:2.8.4`). La changer est une décision : lire ses notes de version.
- **Sans Docker.** Un Caddy installé à la main, sous Windows ou Linux, avec le même `Caddyfile` marche aussi :
  - remplacer `wdd:8080` par `127.0.0.1:8080` ;
  - lancer le serveur avec `WDD_URL`, `WDD_URL_PAGES` et `WDD_HTTPS=1`.

## Ce qui n'est pas vérifié

- **Validation des fichiers.** Les deux `Caddyfile` n'ont pas été validés par Caddy lui-même : le Docker du poste de développement n'était pas démarré. `docker compose config` valide la composition.
- **Essais réels.** Aucune mise en ligne réelle : ni certificat Let's Encrypt, ni autorité interne installée sur un poste.
