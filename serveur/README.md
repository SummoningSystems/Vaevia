# Serveur (étapes 1 à 3.5)

Étape 3.5 (prise en main, [docs/etape3-5-prise-en-main.md](../docs/etape3-5-prise-en-main.md)), partie serveur faite : `lien-admin.txt`, `GET /api/sante`, expiration et origine des jetons, révocation d'un jeton par lui-même, liens de reconnexion (`serveur/src/lien.ts` compris), session prolongée à l'usage, appairage d'un poste, réglage `traitement`, demandes de traitement et veilleurs, Docker Compose (§ 1.3 : `docker-compose.yml`, `.env.exemple`, `HEALTHCHECK`, section « Docker Compose »). Détail plus bas, section « Étape 3.5 ».

Étape 3 : tickets, gestion du projet (membres, invitations, jetons, réglages), administration, journal d'audit, isolement des pages de projet, méta-interface servie depuis `serveur/ui/`. Spécification : [docs/etape3-meta-interface.md](../docs/etape3-meta-interface.md) (voir aussi ses « Écarts et précisions », sous-section « Serveur »).

Serveur minimal de l'outil : sert le Wiki d'un projet (la page construite par l'agent, avec un bouton de retour sur chaque élément), garde chaque retour dans le dépôt Git de design du projet (un commit par écriture) et diffuse les changements en direct (SSE). Spécification : [docs/etape1-serveur.md](../docs/etape1-serveur.md) ; ajouts de l'étape 2 (notes datées, jetons à rôle, import depuis claude.ai, dernier build) : [docs/etape2-cli-methode.md](../docs/etape2-cli-methode.md) § 2 ; contrat côté page : [site/retours/CONTRAT.md](../site/retours/CONTRAT.md). Les agents passent par la CLI [`outil`](../cli/README.md).

Node 24, TypeScript exécuté directement (suppression des types), aucune dépendance npm. Git doit être dans le `PATH`.

## Lancer

```sh
WDD_DONNEES=<dossier de données hors du dépôt> node serveur/src/principal.ts
```

Au premier démarrage (aucun admin), la sortie affiche **une fois** un lien d'invitation admin (`…/invitation/<jeton>`, valable 7 jours, usage unique), et l'écrit dans `<WDD_DONNEES>/lien-admin.txt` (une ligne, droits 0600 hors Windows) ; un nouveau démarrage sans admin l'annule, en affiche un autre et réécrit le fichier. Le fichier est supprimé dès que son lien ne vaut plus (utilisé, annulé, expiré) et au démarrage quand un admin existe (voir « Étape 3.5 »). La sortie donne aussi le PID (`serveur à l'écoute sur … (PID n)`). Arrêt : Ctrl+C ou SIGTERM.

Admin perdu (cookies effacés, aucun autre admin) : `node serveur/src/lien.ts --donnees <dossier> reconnexion --admin` sur la machine du serveur (voir « Étape 3.5 »).

| Variable | Rôle | Défaut |
|---|---|---|
| `WDD_DONNEES` | dossier des données : `outil.sqlite`, `gitconfig`, `projets/<projet>/depot` et `builds/` ; refusé s'il est dans le dépôt de l'outil ; un seul serveur à la fois (`serveur.verrou`, voir « Étape 3.5 ») | (obligatoire) |

| `WDD_PORT` | port d'écoute | `8080` |
| `WDD_HOTE` | adresse d'écoute | `127.0.0.1` (`0.0.0.0` dans Docker) |
| `WDD_URL` | adresse publique (`https://retours.exemple.fr`) : liens d'invitation, contrôle d'`Origin` derrière un proxy | déduite de `Host` |
| `WDD_HTTPS` | `1` derrière un proxy HTTPS : cookie `Secure` | — |
| `WDD_TEST` | `1` active l'API de test `/__test/*` (404 sinon). Jamais en production ; refusé si `WDD_HOTE` n'est pas une adresse de bouclage | — |
| `WDD_SITE` | dossier `site/` de l'outil (pour `build.js`) | `../site` |
| `WDD_URL_PAGES` | origine de l'**hôte des pages** de projet (`https://pages.retours.exemple.fr`), étape 3 § 2. Exige `WDD_URL` et un **autre nom d'hôte** (refusée au démarrage sinon : les cookies ne sont pas isolés par port). De préférence un **autre domaine** (voir ci-dessous). Avec elle : `Host` inconnu → 421, `/p/<projet>/` de l'hôte principal redirige vers l'hôte des pages | — (même origine) |
| `WDD_UI` | dossier de la méta-interface (fichiers statiques) | `serveur/ui` |
| `WDD_SAUVEGARDE` | dossier des sauvegardes (étape 3.7, A1) : jamais dans les données ni dans le dépôt de l'outil ; de préférence sur un autre disque | `<WDD_DONNEES>-sauvegardes` (`/sauvegardes` dans Docker, volume à part) |
| `WDD_SAUVEGARDE_HEURES` | intervalle de la sauvegarde planifiée par le serveur, en heures ; `0` = jamais | `24` (`0` avec `WDD_TEST=1`) |
| `WDD_NOTIF_LOCALES` | `1` : notifications par webhook permises vers `http` et des adresses internes (étape 3.7, I1 ; réseau isolé). Sinon `https` vers une adresse publique seulement | — |
| `WDD_SAUVEGARDE_GARDER` | nombre de sauvegardes gardées (les plus anciennes sont supprimées) | `7` |

### Isolement des pages (`WDD_URL_PAGES`)

Le Wiki d'un projet (sa page) est construit à partir du `data.json` envoyé par un agent : c'est du contenu actif. Sans `WDD_URL_PAGES`, il est servi sur la même origine que l'administration (la méta-interface le signale à l'admin). Avec :

1. `GET /p/<projet>/` sur l'hôte principal (session) → 303 vers `WDD_URL_PAGES/p/<projet>/?entree=<jeton>` ; jeton d'entrée aléatoire, haché en base, usage unique, 60 s, lié au compte et au projet.
2. L'hôte des pages l'échange contre le cookie `wdd_pages` (`HttpOnly`, `SameSite=Lax`, sans `Domain`, posé deux fois avec `Path=/p/<projet>/` et `Path=/api/p/<projet>/`, valable pour ce projet seulement), puis redirige vers `/p/<projet>/`.
3. Sur l'hôte des pages ne répondent que `/p/<projet>/` et `/api/p/<projet>/session|retours|flux`, `POST …/retours`, `PATCH`/`DELETE …/retours/<id>` ; tout le reste → 404. Ni `wdd_session` ni jeton Bearer n'y valent. Le flux n'y émet pas l'événement `tickets`.
4. Sans cookie valable, la page de l'hôte des pages renvoie vers l'hôte principal (une fois par minute au plus dans l'onglet), sinon un lien.

Exemple derrière un proxy : `WDD_URL=https://retours.exemple.fr WDD_URL_PAGES=https://retours-pages.exemple WDD_HTTPS=1`, les deux noms pointant vers le même serveur. En local : `WDD_URL=http://127.0.0.1:8080 WDD_URL_PAGES=http://localhost:8080`.

Limites à connaître :
- **Un autre domaine vaut mieux qu'un sous-domaine.** Un sous-domaine (`pages.retours.exemple.fr`) marche. Mais un script d'une page peut alors poser un cookie pour le domaine parent. Le serveur refuse une requête qui porte deux cookies `wdd_session` : il n'y a donc pas de connexion forcée, mais la personne peut être déconnectée de la méta-interface. Avec un autre domaine (`retours-pages.exemple`), ce cas n'existe pas.
- **Les projets ne sont pas isolés entre eux sur l'hôte des pages.** Tous les projets partagent l'origine `WDD_URL_PAGES`. Le `Path` du cookie n'isole rien à l'intérieur d'une origine : un script actif dans la page d'un projet peut écrire des retours dans un autre projet, au nom d'un visiteur entré dans les deux. L'isolement tient entre l'administration et les pages, pas entre projets.
- **Le lien d'entrée n'est pas lié au navigateur.** Un membre qui envoie son propre lien `…?entree=` (valable 60 s, une fois) à quelqu'un le connecte à sa place sur l'hôte des pages de ce projet.

### Docker Compose (serveur d'équipe, étape 3.5 § 1.3)

`docker-compose.yml`, à la racine du dépôt, décrit un service `wdd` construit avec `serveur/Dockerfile`. Le contexte est la racine du dépôt (l'image embarque `site/`), et `serveur/Dockerfile.dockerignore` n'y laisse entrer que le nécessaire : ni `.env`, ni `heritage/`, ni les tests.
- Les données sont dans le volume `wdd-donnees`, monté sur `/donnees`. Compose préfixe son nom par celui du projet : `<projet>_wdd-donnees`, où `<projet>` est le nom du dossier en minuscules (`vaevia`), ou la valeur de `-p`.
- `WDD_URL`, `WDD_URL_PAGES`, `WDD_HTTPS` et `WDD_PORT_PUBLIE` sont lus dans `.env`, à côté de `docker-compose.yml`. Ce fichier n'est jamais commité (`.gitignore`). `.env.exemple` est le modèle commenté.
- Le port publié est `WDD_PORT_PUBLIE`, par défaut `127.0.0.1:8080` : le serveur n'est joignable que de la machine elle-même (navigateur local, proxy HTTPS local). L'ouvrir au réseau (`WDD_PORT_PUBLIE=8080`) est un choix explicite, à faire en connaissance de cause :
  - tant qu'aucun proxy HTTPS n'est devant, tout passe en HTTP clair, lien admin et cookies de session compris, et le cookie n'a pas `Secure` ;
  - sous Linux, Docker ouvre lui-même les ports publiés par ses règles iptables, qui passent avant ufw et firewalld : le pare-feu de l'hôte ne protège pas ce port.
- Dans le conteneur, le serveur écoute toujours sur 8080.
- Un seul serveur par volume : le serveur tient `/donnees/serveur.verrou` (voir « Étape 3.5 », verrou du dossier des données). Après un arrêt brutal du conteneur, le verrou laissé désigne le PID 1, celui du nouveau serveur : il est repris.
- Le conteneur est relancé après un arrêt ou un redémarrage de Docker (`restart: unless-stopped`), sauf si on l'a arrêté soi-même.
- Le `HEALTHCHECK` de l'image appelle `http://127.0.0.1:8080/api/sante` avec le `fetch` de Node (`node -e`, l'image n'a pas de curl), toutes les 15 s, avec un délai de 5 s et un démarrage de 30 s. La route répond avant le contrôle de `Host` : l'état reste `healthy` avec `WDD_URL_PAGES`, où `127.0.0.1` est un hôte inconnu.

Étapes, depuis la racine du dépôt :

1. Préparer `.env` :

   ```sh
   cp .env.exemple .env      # puis régler WDD_URL (voir ci-dessous)
   ```

   Donner `WDD_URL` dès que le port publié n'est pas le 8080 de la machine ou qu'un proxy est devant. Sans elle, les liens créés dans l'interface prennent l'adresse de la requête (`Host`), mais les deux liens créés sans requête pointent vers l'adresse vue de l'intérieur du conteneur : celui du premier démarrage (`lien-admin.txt`, `http://localhost:8080/…`) et celui de `lien.ts` (`http://127.0.0.1:8080/…`).

2. Démarrer, puis attendre l'état `healthy` :

   ```sh
   docker compose up -d                 # construit l'image au premier lancement ; --build après une mise à jour du dépôt
   docker compose ps                    # STATUS : « Up … (healthy) »
   ```

3. Lire le lien du compte admin (premier démarrage), puis l'ouvrir dans un navigateur :

   ```sh
   docker compose exec wdd cat /donnees/lien-admin.txt
   ```

   Le fichier disparaît dès que le lien a servi. Le lien est aussi dans `docker compose logs wdd` : ce journal est donc à garder pour soi.

   Sous Git Bash (Windows), préfixer ces commandes par `MSYS_NO_PATHCONV=1` (`MSYS_NO_PATHCONV=1 docker compose exec wdd cat /donnees/lien-admin.txt`), ou les lancer depuis PowerShell : sinon MSYS réécrit `/donnees/…` en `C:/Program Files/Git/donnees/…`, et la commande échoue.

4. Admin perdu (cookies effacés, aucun autre admin) : un lien de reconnexion, valable 7 jours et une fois. Il s'affiche et s'écrit dans `lien-admin.txt` (voir « Étape 3.5 », `serveur/src/lien.ts`) :

   ```sh
   docker compose exec wdd node serveur/src/lien.ts --donnees /donnees reconnexion --admin
   ```

5. Mettre le serveur derrière un proxy HTTPS (Caddy, nginx, Traefik…), qui termine TLS et renvoie vers le port publié :
   - `WDD_URL=https://retours.exemple.fr` : l'adresse publique, pour les liens et le contrôle d'`Origin`.
   - `WDD_HTTPS=1` : le cookie de session est posé avec `Secure`.
   - `WDD_URL_PAGES=https://retours-pages.exemple` (conseillé) : l'hôte des pages de projet, d'un autre nom d'hôte, de préférence d'un autre domaine (voir « Isolement des pages »). Le proxy envoie les deux noms au même serveur, **avec leur en-tête `Host` d'origine** : avec `WDD_URL_PAGES`, un `Host` inconnu reçoit 421.
   - `WDD_PORT_PUBLIE` : le défaut (`127.0.0.1:8080`) convient si le proxy tourne sur la même machine ; le port n'est alors pas joignable du réseau sans passer par lui. Proxy sur une autre machine : `WDD_PORT_PUBLIE=8080`, et le trafic entre le proxy et le serveur reste en HTTP clair (pare-feu de l'hôte contourné par Docker, voir plus haut).
   - Puis `docker compose up -d` : le conteneur est recréé, les données restent dans le volume.
   - Le flux des retours est en SSE. Le serveur envoie `X-Accel-Buffering: no` (nginx ne met alors pas la réponse en mémoire tampon) et un ping toutes les 25 s : le délai de lecture du proxy doit dépasser 25 s.

Arrêt : `docker compose down`. Les données restent dans le volume ; `down -v` les efface.

Sans Compose :

```sh
docker build -f serveur/Dockerfile -t wdd-serveur .          # depuis la racine du dépôt (l'image embarque site/)
docker run -d -p 127.0.0.1:8080:8080 -v wdd-donnees:/donnees -e WDD_URL=http://localhost:8080 --name wdd wdd-serveur

docker exec wdd cat /donnees/lien-admin.txt                   # lien admin (aussi dans docker logs wdd)
```

## Tests

```sh
node --test "serveur/test/*.test.ts"          # depuis la racine ; ou « npm test » dans serveur/
```

Chaque test démarre un serveur sur un port libre dans un dossier temporaire : `WDD_TESTS_TMP` s'il est donné (chemin long, hors dépôt), sinon le dossier temporaire du système ; effacé à la fin sauf avec `WDD_GARDER=1`. `node --test serveur/` (un dossier) n'est pas accepté par Node 24, et `node --test` sans motif prendrait aussi `src/test-api.ts` et `test/aide.ts` pour des tests.

## Code

| Fichier | Rôle |
|---|---|
| `src/principal.ts` | démarrage (`demarrer()`, utilisé aussi par les tests), lien admin, arrêt propre |
| `src/config.ts` | variables d'environnement |
| `src/base.ts` | SQLite : projets, comptes, rôles, sessions, invitations, jetons (secrets hachés SHA-256) ; tables `appairages`, `demandes` et `veilles` (étape 3.5), montée de version |
| `src/depot.ts` | dépôt Git d'un projet, isolé de la config Git de la machine ; file d'attente ; commit limité aux chemins de l'écriture ; relance sur verrou, restauration retentée, verrous nettoyés au démarrage ; index en mémoire relu au démarrage |
| `src/retours.ts` | validation des documents, droits § 3.1 (fonctions pures), création, modification, suppression, batch |
| `src/auth.ts` | cookie de session, jeton Bearer, anti-CSRF |
| `src/http.ts` | routage, pages (accueil, invitation, Wiki du projet) et leur CSP par empreintes, API page, agent, admin |
| `src/flux.ts` | flux SSE ; accès revérifié à chaque ping et à chaque diffusion (flux coupé à la révocation d'un jeton, à l'expiration d'une session) ; événements `tickets` et `demandes` sur l'hôte principal seulement |
| `src/builds.ts` | builds (`site/build.js --stockage=http`, avec `--precedent` : le `data.json` du build d'avant, étape 3.7 L1), avertissement des retours ouverts sur des éléments disparus (G1), enveloppe de la page avec `<meta name="wdd-api">` et le bandeau, dernier build |
| `src/notifications.ts` | notifications par webhook (étape 3.7, I1) : réglages en base, observation du flux, envoi regroupé hors des écritures, signature HMAC, adresses internes refusées, routes `/notifications` |
| `src/sauvegarde.ts` | sauvegarde à chaud (étape 3.7, A1) : `VACUUM INTO`, dépôts copiés dans la file du projet, builds complets, `manifeste.json` (tailles, SHA-256), rotation, état pour l'Administration |
| `src/restaurer.ts` | commande `node serveur/src/restaurer.ts <sauvegarde> [<données>]` : manifeste vérifié, verrou, anciennes données renommées à côté, contrôles (`integrity_check`, `git rev-parse HEAD`), retour arrière en cas d'échec |
| `src/bandeau.ts` | bandeau commun du Wiki (étape 3.6, § A.2) : onglets Wiki · Retours · Kanban · Membres, liens vers la méta-interface, tout échappé |
| `src/notes.ts` | notes datées (`notes/notes_<date>.json`) : liste, lecture, écriture validée par `site/valider-notes.js` (les règles de `build.js`) sur l'ensemble des notes, un commit |
| `src/import.ts` | import depuis un artefact claude.ai : validation entrée par entrée, ids gardés ou dérivés, ré-import ignoré, un commit |
| `src/test-api.ts` | modes simulés et routes `/__test/*` |
| `src/ticket-fichier.ts` | format de `tickets/T-<n>.md` (en-tête une clé par ligne, valeur JSON sur une ligne), validation stricte, lecture et écriture |
| `src/tickets.ts` | droits (§ 1.3) et cycle (§ 1.2) en fonctions pures (`transition()`, seule à changer statut et preneur), opérations dans la file du projet, fermeture tout ou rien, historique |
| `src/reglages.ts` | réglages de `site.json` : disciplines, `url_commit`, `traitement` (étape 3.5) |
| `src/gestion.ts` | membres, invitations, jetons, réglages du projet (sessions seulement), `GET /api/moi`, écriture du journal |
| `src/statique.ts` | fichiers de la méta-interface (liste blanche d'extensions, pas de traversée, CSP `script-src 'self'`) |
| `src/verrou.ts` | `serveur.verrou` : un seul serveur par dossier de données, verrou périmé repris (étape 3.5) |
| `src/lien-admin.ts` | `lien-admin.txt` : écriture d'un coup (temporaire puis renommage, 0600), suppression quand son lien ne vaut plus (étape 3.5) |
| `src/lien.ts` | commande `node serveur/src/lien.ts … reconnexion` : lien de reconnexion depuis la machine du serveur (étape 3.5) |
| `src/appairage.ts` | appairage d'un poste (étape 3.5, § 2.1) : création, page d'autorisation, autorisation ou refus, livraison unique du jeton, limites, IP en écoute locale, redirection `/appairage?code=` |
| `src/demandes.ts` | « Traiter les retours » (étape 3.5, § 5.2) : demandes et veilleurs, une active par projet, vérification paresseuse (veilleur perdu, attente de 24 h), droits selon `traitement`, événement `demandes` |
| `ui/` | méta-interface (HTML, CSS, JS sans build : accueil, Kanban, ticket, retours, membres, administration) ; `ui/tests/` (scénario Edge : `sh serveur/ui/tests/lancer.sh <dossier>`) n'est jamais servi |

## Routes

Erreurs : `{ "code", "message" }` (+ `document` sur un 409, + `index`/`id` dans un batch). Codes : 400/422 `invalid_document`, 401 `revoked`, 403 `permission_denied`, 404 `not_found`, 409 `conflict`, 413/507 `quota_exceeded`, 503/5xx `unavailable` ; étape 3.5 : 410 `expired` ou `refused` (livraison d'un appairage), 429 `slow_down` (interrogation trop rapprochée) ou `quota_exceeded` (limites de l'appairage).

**Anti-CSRF** : toute requête POST, PATCH, PUT ou DELETE qui porte un cookie doit envoyer `X-WDD: 1`, et un `Origin` égal à l'hôte s'il est présent (sinon 403). Sur `/__test/*`, `X-WDD: 1` est exigé même sans cookie. Un agent (Bearer, sans cookie) n'est pas concerné. Tout corps JSON exige `Content-Type: application/json` (sinon 400 ; sauf les builds et le formulaire d'invitation).

**Page servie** : la CSP n'a pas `'unsafe-inline'` pour les scripts. Le serveur autorise par empreinte (`sha256`) chaque `<script>` en ligne de la page qu'il envoie. Le build est du contenu actif servi sur la même origine que l'API admin : voir l'écart 28 de la spécification.

**Bandeau du Wiki** (étape 3.6, § A.2, `src/bandeau.ts`) : en servant le Wiki d'un projet (dernier build, ou la page « Wiki pas encore publié »), le serveur pose en tête de `<body>` le bandeau de la méta-interface : marque, Accueil (et Administration pour un admin), titre du projet, onglets **Wiki · Retours · Kanban · Membres** (Membres pour un mainteneur ou un admin, jamais pour un jeton d'agent), nom de la personne. Wiki est l'onglet courant (`/p/<projet>/`) ; les autres sont des liens vers la méta-interface, toujours une route du fragment (`/#/p/<projet>/retours|kanban|membres`) : absolus vers `WDD_URL` avec `WDD_URL_PAGES`, relatifs sans. Arrivé depuis l'hôte des pages, le document `/` part sans `wdd_session` (`SameSite=Strict`, autre site) ; c'est un fichier statique, et les requêtes de l'interface qui suivent portent le cookie : on arrive connecté. Rendu par le serveur, sans cadre ni script ni route nouvelle sur l'hôte des pages ; titre et nom échappés ; un `<style>` en ligne (classes `wdd-b…`), clair et sombre comme la page, dans le flux (ni fixe ni collant). Sans session, 401 et 403 restent sans bandeau.

**Dépôt de design** : ne pas y travailler pendant que le serveur tourne, le cloner pour le lire. Un `git status` extérieur ne gêne plus, car le serveur relance une commande qui bute sur un verrou ; mais un commit fait à la main ne serait pas vu avant le redémarrage. Au démarrage, les verrous de Git restés d'un arrêt brutal sont supprimés. Le dépôt a sa config locale (`core.autocrlf=false`, identité du serveur) et un `.gitattributes` (`*.json text eol=lf`).

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `GET /` | — | liste des projets du compte connecté |
| `GET /invitation/<jeton>` | — | formulaire « nom affiché » ; avec `WDD_URL_PAGES`, sa CSP permet aussi cette origine dans `form-action` (la redirection après l'envoi y mène) |
| `GET /outil`, `/outil/installer.mjs`, `/outil/vaevia-outil.tar.gz` | — | hôte principal seulement : la CLI `outil` et sa méthode, à installer sur un poste d'une ligne (`node -e "fetch(…)…"`, la même dans tout terminal) ; voir `serveur/src/distribution.ts` |
| `POST /invitation/<jeton>` | — | `nom` (formulaire ou JSON) → compte, cookie `wdd_session`, 303 vers `/p/<projet>/` (`/` pour un admin) |
| `GET /p/<projet>/` | session | Wiki : page du dernier build, précédée du bandeau commun ; 401 « invitation requise », 403, 404 sans build (« Wiki pas encore publié », avec le bandeau ; pour un mainteneur ou un admin, pas pour un jeton, le bloc « Brancher un dépôt de code » et sa phrase, comme sur le Kanban) |
| `GET /api/p/<projet>/session` | session, agent | `{ id, nom, role, proprietaire, ecriture }` |
| `GET /api/p/<projet>/retours[?status=a,b]` | session, agent | `{ docs: [{ id, version, donnees }], rev }` |
| `GET /api/p/<projet>/flux` | session, agent | SSE : `event: instantane` (même corps), `: ping` toutes les 25 s |
| `POST /api/p/<projet>/retours` | contributeur+ | document complet sans `id`/`version` → `201 { id, version, rev }` |
| `PATCH /api/p/<projet>/retours/<id>` | selon § 3.1 | `{ champs, version }` → `{ version, rev }` |
| `DELETE /api/p/<projet>/retours/<id>?version=<n>` | auteur, mainteneur, admin | `204` |
| `POST /api/p/<projet>/retours/batch` | selon § 3.1 | `{ ecritures: [{ id, version, champs }] }` (≤ 50, tout ou rien, un commit) → `{ versions: [{ id, version }], rev }` |
| `GET`, `PUT`, `DELETE /api/p/<projet>/notifications`, `POST …/notifications/essai` | mainteneur ou admin, en session | étape 3.7 (I1) : `GET` → `{ configure, actif, hote, origine, format, contenu, evenements, rythme, dernier }` (jamais l'adresse entière ni le secret) ; `PUT { url?, format, contenu, evenements, rythme, actif, nouveau_secret? }` (url vide = garder l'enregistrée ; `secret` rendu seulement à sa création) ; `essai` → `{ ok, message }` |
| `POST /api/p/<projet>/retours/serie` | session (contributeur et plus), aussi sur l'hôte des pages | étape 3.7 (R1) : `{ retours: [documents] }`, 50 au plus, tout ou rien, un commit « série : n retours », une diffusion → `201 { ids, rev }` (ids dans l'ordre reçu) ; une entrée invalide → `400` avec son `index` |
| `POST /api/p/<projet>/builds` | agent, mainteneur, admin | corps = `data.json` (≤ 16 Mio) → `201 { build, octets, resume, avertissements }` (`resume` : ligne finale de `build.js` sans les chemins du serveur, avec « changements : n modifiés, n ajoutés, n retirés » depuis le build précédent ; `avertissements` : ses lignes « attention : … », plus celle des retours ouverts sur des éléments absents du build, étape 3.7) ; image en chemin relatif refusée (422) : le serveur ne sert que la page |
| `GET /api/p/<projet>/builds` | session, agent, publieur | `{ dernier: { build, date, octets, empreinte } \| null, page }` (étape 2 ; `empreinte`, étape 3.7 G2 : SHA-256 des données sans `generated`) |
| `GET /api/p/<projet>/builds/<n>/page` | session, agent | étape 3.6 (`outil apercu`) : `{ build, html, csp }`, la page du build `<n>` telle que `GET /p/<projet>/` la sert à l'appelant (enveloppe, bandeau, fins de ligne LF) et la CSP qui l'accompagnerait. En JSON, jamais en `text/html` : la page ne s'exécute pas sur l'origine de la méta-interface. Hôte principal seulement (404 sur l'hôte des pages), donc aussi avec `WDD_URL_PAGES` ; 404 si `<n>` n'est pas un build construit |
| `GET /api/p/<projet>/notes` | session, agent | `{ notes: [{ nom, date, titre, jalons, octets }], rev }` : les `notes_*.json` du dépôt (`jalons` : clés de `milestones`, dans l'ordre) |
| `GET /api/p/<projet>/notes/<nom>` | session, agent | le fichier tel qu'il est dans le dépôt (JSON) ; 404 si absent |
| `PUT /api/p/<projet>/notes/<nom>[?remplacer=1]` | agent, mainteneur, admin | `<nom>` = `notes_AAAA-MM-JJ[_suffixe].json` (suffixe a-z, 0-9, -), corps = les notes (≤ 1 Mio), validées avec les règles de `site/build.js` sur l'ensemble des notes du dépôt → `201` (création) ou `200` (remplacement) `{ nom, rev, cree, inchange, avertissements }`, un commit ; 409 si le fichier existe sans `?remplacer=1` ; 400 avec `erreurs` |
| `POST /api/p/<projet>/import` | mainteneur, admin | `{ retours: [{ id, donnees }] }` (≤ 500, ≤ 16 Mio) → `{ importes: [{ origine, id }], ignores, refuses: [{ index, origine, raison }], rev }` ; un commit « import depuis claude.ai : n retours » (aucun si rien d'importé) |
| `GET /api/admin/projets` | admin | projets, nombre de retours, rev, dernier build |
| `POST /api/admin/projets` | admin | `{ id, titre }` → dépôt créé avec un premier commit |
| `POST /api/admin/invitations` | admin | `{ projet, role, expire? }` (role : lecteur, contributeur, mainteneur, admin ; expire : date ISO, 7 jours par défaut, 30 jours au plus) → `{ id, lien, url, projet, role, expire }` |
| `DELETE /api/admin/invitations/<id>` | admin | annule une invitation en attente, admin comprise (`204` ; déjà utilisée, annulée ou expirée : 400) |
| `POST /api/admin/jetons` | admin | `{ projet, nom, role?, pour? }` → `{ id, jeton, projet, nom, role, pour }` (jeton affiché une fois) ; `role` : `agent` (défaut) ou `mainteneur` ; propriétaire : l'admin qui le crée, ou `pour` (id d'un compte contributeur ou mainteneur du projet, ou admin) |
| `DELETE /api/admin/jetons/<id>` | admin | révoque un jeton |

### Étape 3

`GET /` sert la méta-interface (`serveur/ui/index.html`, CSP `script-src 'self'`), sinon la page d'accueil de l'étape 1 ; les autres fichiers de `serveur/ui/` sont servis par leur chemin (`.html .js .mjs .css .svg .png .webp .ico .woff2 .json .txt` seulement). Hôte principal seulement.

**Tickets** (sessions et jetons, droits du § 1.3 de la spécification). Listes : `{ docs: [{ id, version, donnees }], rev }` ; un ticket illisible y figure en `{ id, illisible: true, erreur }` (sans filtre) et refuse toute écriture (422).

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `GET /api/p/<p>/tickets[?statut=a,b&discipline=x&pris_par=moi]` | tout membre, agent | liste |
| `GET /api/p/<p>/tickets/<T-n>` | tout membre, agent | `{ id, version, donnees }` |
| `GET /api/p/<p>/tickets/<T-n>/historique` | tout membre, agent | `{ id, historique: [{ hash, auteur, date, sujet }] }` : `git log --follow` du fichier, 200 au plus, du plus récent au plus ancien |
| `POST /api/p/<p>/tickets` | contributeur+, agent | `{ titre, description?, discipline?, retours?, pages?, criteres? }` → `201 { id, version, rev }` |
| `PATCH /api/p/<p>/tickets/<T-n>` | auteur, preneur (critères cochés, statut), mainteneur | `{ version, champs }` ; `statut` : transitions sauf vers/depuis `fait` → `{ version, rev }` |
| `POST …/tickets/<T-n>/prendre` | contributeur+, agent ; `forcer` : mainteneur | `{ version, forcer? }` ; tenu par un autre → 409 avec le ticket |
| `POST …/tickets/<T-n>/rendre` | preneur, mainteneur | `{ version }` |
| `POST …/tickets/<T-n>/commits` | preneur, mainteneur | `{ version, commits: [{ hash, depot?, message? }] }` ; doublons ignorés → `{ version, rev, ajoutes }` |
| `POST …/tickets/<T-n>/fermer` | mainteneur ou admin **en session** (jamais un jeton) | `{ version, retours: [{ id, version }], reponse? }` : ticket et retours en un commit, tout ou rien |
| `POST …/tickets/<T-n>/rouvrir` | mainteneur (jeton mainteneur compris) | `{ version }` |
| `DELETE …/tickets/<T-n>?version=<n>` | mainteneur | `204` ; le numéro reste réservé (`tickets/.dernier`) |
| `GET /api/p/<p>/flux` | | en plus d'`instantane` : `event: tickets` (même corps que la liste) à la connexion et après chaque commit qui touche un ticket ; jamais sur l'hôte des pages |

**Projet** (sessions seulement ; 403 avec un Bearer, même mainteneur) :

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `GET /api/moi` | session | `{ compte, projets: [{ id, titre, role, retours_nouveaux, retours, tickets_a_faire, tickets, page, demande }], isolement: { pages_separees, url_pages } }` ; `demande` (étape 3.5) : la demande de traitement active `{ id, etat }`, ou `null` ; `retours_questions` (étape 3.6) ; `a_moi` (étape 3.7, E1) : `{ questions, a_valider, en_revue, total }`, ce qui attend une réponse de ce compte (questions de l'agent sur ses retours, points « À valider » du dernier build sans réponse, tickets en revue pour un mainteneur), 20 lignes par liste |
| `GET /api/p/<p>/membres` | mainteneur, admin | `{ membres: [{ compte, nom, role, depuis, desactive, admin }], invitations: [{ id, role, cree, expire, par, par_nom, compte_cible, compte_cible_nom }] }` (un lien de reconnexion y figure avec `role: "reconnexion"` et le compte visé ; `compte_cible` vaut `null` pour une invitation ; `admin` : le compte est administrateur, l'interface ne lui propose pas de lien de reconnexion) |
| `PUT /api/p/<p>/membres/<compte>` | mainteneur, admin | `{ role }` (membre existant) ; ni soi-même, ni le dernier mainteneur (sauf admin) ; un mainteneur qui quitte ce rôle perd ses invitations en attente sur ce projet → `{ compte, role, invitations_annulees }` |
| `DELETE /api/p/<p>/membres/<compte>` | mainteneur, admin | retire l'accès, révoque ses jetons de ce projet, annule ses invitations en attente sur ce projet, coupe ses flux → `{ compte, retire, jetons_revoques, invitations_annulees }` |
| `POST /api/p/<p>/invitations` | mainteneur, admin | `{ role, expire? }` (jusqu'à mainteneur ; `expire` : 30 jours au plus) → `201 { id, lien, url, projet, role, expire }` |
| `DELETE /api/p/<p>/invitations/<id>` | mainteneur, admin | annule (`204`) |
| `GET /api/p/<p>/jetons` | mainteneur, admin | `{ jetons: [{ id, nom, role, pour, cree, revoque, expire, expiree, origine }] }` (sans secret ; `expire` : date ISO ou `null` ; `expiree` : date passée, à afficher « expiré » ; `origine` : texte, vide pour les jetons créés à la main) |
| `POST /api/p/<p>/jetons` | mainteneur, admin | `{ nom, role? }` → `201 { id, jeton, projet, nom, role, pour }` ; propriétaire = le créateur ; ses commits sont signés « Nom (pour Propriétaire) » |
| `DELETE /api/p/<p>/jetons/<id>` | mainteneur, admin | révoque (`204`) |
| `GET /api/p/<p>/reglages` | tout membre, agent | `{ disciplines: [{ nom, libelle }], url_commit, traitement, rev }` |
| `PUT /api/p/<p>/reglages` | mainteneur, admin (session) | `{ disciplines?, url_commit?, traitement? }` (une clé absente garde sa valeur) ; écrit `site.json`, un commit ; retirer une discipline utilisée → 400 avec `tickets` |

**Administration** (admin, session) : `GET /api/admin/comptes` (comptes et rôles) ; `PATCH /api/admin/comptes/<id> { nom?, desactive?, admin? }` (désactiver : sessions supprimées, jetons dont il est propriétaire révoqués, invitations en attente qu'il a créées annulées, connexion refusée ; `admin: false` annule ses invitations admin et celles des projets où il n'est pas mainteneur ; `admin: true` (étape 3.5) annule les liens de reconnexion qui le visent créés par la route du projet ; jamais le dernier admin actif, ni désactivé ni rétrogradé ; réponse `{ compte, jetons_revoques, invitations_annulees }`) ; `GET /api/admin/invitations` (toutes, sans secret, avec `etat` et `compte_cible` ; les liens de reconnexion y figurent avec `role: "reconnexion"`) ; `DELETE /api/admin/invitations/<id>` ; `GET /api/admin/journal?avant=<id>&projet=<p>` (pages de 100, `suivant` pour la page suivante). Étape 3.7 (A1) : `GET /api/admin/sauvegarde` → `{ dossier, heures, garder, en_cours, derniere }` ; `POST /api/admin/sauvegarde` (corps vide) → `201` avec en plus `sauvegarde: { nom, fichiers, octets, duree_ms }`, `409` si une sauvegarde est déjà en cours ; action `sauvegarde` au journal. `POST /api/admin/jetons` : le propriétaire est l'admin qui crée le jeton, sauf `pour` (id d'un autre compte) ; ses commits sont signés « Nom (pour Admin) ».

**Un jeton ne vaut jamais plus que son propriétaire.** Son rôle est relu à chaque requête : propriétaire désactivé, sans rôle sur le projet (retiré, admin rétrogradé) ou lecteur → le jeton ne vaut plus (401) ; contributeur → un jeton `mainteneur` ne vaut que comme `agent`. Si le propriétaire retrouve son rôle, le jeton le retrouve aussi (sauf s'il a été révoqué). Un jeton sans propriétaire (créé avant l'étape 3) n'est pas concerné.

**Journal d'audit** (table `journal` de `outil.sqlite`, ajout seul, jamais de secret) : projet créé ; invitation créée, utilisée, annulée ; rôle donné, changé, retiré ; jeton créé, révoqué ; compte modifié, désactivé ; réglages changés ; prise forcée ; ticket supprimé, rouvert ; étape 3.5 : reconnexion créée, reconnexion utilisée, jeton révoqué par lui-même (`detail.par: "lui-même"`), appairage autorisé, appairage refusé, jeton créé à la livraison d'un appairage (`detail.par: "appairage"`), demande créée, demande prise, annulation demandée, demande finie (`qui` = `serveur` pour une fin constatée par le serveur : veilleur perdu, attente de 24 h).

**Dépôt de design** : `tickets/T-<n>.md`, `tickets/.dernier` et `site.json` suivent les règles des retours : commit limité aux chemins, restauration sur échec (`clean` de `retours/` et `tickets/`), fichiers non commités de `retours/`, `tickets/` et `site.json` remis au dernier commit au démarrage (les notes ne sont pas touchées). Les valeurs de l'en-tête d'un ticket sont écrites sur une ligne, U+2028, U+2029 et U+0085 échappés. Sans `tickets/.dernier` lisible, la numérotation reprend le plus grand numéro de l'historique Git. Une correction à la main se fait par un commit, serveur arrêté.

**Jetons** (`Authorization: Bearer <jeton>`, un projet chacun) :
- `agent` : lire ; modifier seulement `status`, `reply`, `replied`, `updated` ; builds et notes. Ni création ni suppression de retour.
- `publieur` (étape 3.7, G2) : `POST` et `GET /builds` seulement (publication par une CI, `docs/ci/README.md`) ; tout le reste → 403. Jamais par un appairage.
- `mainteneur` : les droits d'un mainteneur (créer, ajouter au retour d'un autre, supprimer tout retour), builds, notes, plus l'**import** ; pas ceux de l'agent (il ne répond pas aux retours).

Les jetons créés avant l'étape 2 sont des jetons `agent` (colonne ajoutée au démarrage).

**Import** (`POST …/import`) : chaque entrée est validée seule (les 15 champs du contrat, `by` facultatif) ; une entrée refusée n'empêche pas les autres. L'id d'origine est gardé s'il est valide (`[A-Za-z0-9]{1,40}`, hors noms de périphérique réservés de Windows : `CON`, `aux`, `nul`, `COM1`…) et libre à la casse près ; sinon un id dérivé de l'id d'origine et de `created` est donné (correspondance dans `importes`). `by` devient `import:<by d'origine>` (tronqué à 1000 caractères), la version repart à 1. Un retour déjà présent avec le même id (d'origine ou dérivé) et le même `created` est ignoré : ré-importer le même dossier ne crée rien.

### Étape 3.5

Spécification : [docs/etape3-5-prise-en-main.md](../docs/etape3-5-prise-en-main.md) § 1.1, § 2.1 (appairage, jetons), § 2.2 (redirection seulement), § 2.4, § 5.1 et § 5.2. Tests : `test/prise-en-main-a.test.ts`, `test/appairage.test.ts`, `test/demandes.test.ts`.

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `GET /api/sante` (et `HEAD`) | personne | `200 {"ok":true}`, rien d'autre (ni version, ni présence d'un admin). Répond **avant** le contrôle de `Host` : sur tout hôte, hôte des pages et hôte inconnu compris (le `HEALTHCHECK` Docker appelle `127.0.0.1:8080`). Seule exception au 421 ; un `POST` n'en profite pas |
| `DELETE /api/p/<p>/jeton` | Bearer (le jeton lui-même) | le jeton se révoque : `204`, flux coupés, journal (« jeton révoqué », `qui` = `agent:<id>`, `detail.par: "lui-même"`). Session : 403 ; jeton d'un autre projet : 403. Hôte des pages : 404 |
| `POST /api/p/<p>/membres/<compte>/reconnexion` | mainteneur, admin (session) | corps vide ou `{}` → `201 { id, lien, url, compte: { id, nom }, projet, role: "reconnexion", expire }`. Membre du projet seulement (404 sinon, comme `PUT`), pas un admin (403 : l'administration s'en charge), pas un compte désactivé (400), et seulement si le créateur gère (mainteneur ou admin) **tous** les projets où ce compte a un rôle (403 sinon, « demander à un admin » ; les projets ne sont pas nommés) : le lien donne la session entière du compte. Journal « reconnexion créée » (`cible` = le compte, `detail.invitation` = l'id du lien) |
| `POST /api/admin/comptes/<compte>/reconnexion` | admin (session) | même réponse, `projet: null` ; tout compte actif, admin et soi-même compris ; compte inconnu : 404 ; désactivé : 400 |

**Lien de reconnexion.** C'est une ligne d'invitation liée à un compte existant (colonne `invitations.compte_cible`, rôle `reconnexion`), valable 7 jours, à usage unique, à la même adresse qu'une invitation (`/invitation/<jeton>`).
- `GET` montre le nom du compte et un bouton « Entrer en tant que … », **sans champ de nom**. Il ne consomme rien : un aperçu de lien dans une messagerie ne grille pas le lien.
- `POST` (le bouton, formulaire vide, `Origin` vérifié comme pour une invitation) consomme le lien, donne une session au compte existant, et répond `303` vers `/`. Aucun compte n'est créé. Journal « reconnexion utilisée ».
- Compte désactivé : `GET` 403, `POST` 403, et le lien n'est pas consommé.
- Lien créé par la route du projet : ses règles sont revérifiées à l'utilisation. Compte visé devenu admin, retiré du projet, ou avec un rôle sur un projet que le créateur ne gère pas (créateur rétrogradé, désactivé, ou rôle reçu ailleurs) : `GET` 403, `POST` 403, lien non consommé. Nommer un compte admin (`PATCH … { admin: true }`) annule ces liens (`invitations_annulees`). Désactiver un compte annule les liens en attente qui le visent (ils figurent dans `invitations_annulees`) ; le retirer d'un projet annule ceux de ce projet.
- Un lien créé par la route du projet figure dans `GET …/membres` et s'annule par `DELETE …/invitations/<id>` ; tout lien s'annule par `DELETE /api/admin/invitations/<id>`. Il est annulé, comme une invitation, quand son créateur perd le droit d'inviter.

**`serveur/src/lien.ts`** (sur la machine du serveur : avoir accès aux fichiers vaut droit d'admin) :

```sh
node serveur/src/lien.ts --donnees <dossier> reconnexion --admin          # premier admin actif (le plus ancien)
node serveur/src/lien.ts --donnees <dossier> reconnexion --compte <id>    # un compte actif
docker compose exec wdd node serveur/src/lien.ts --donnees /donnees reconnexion --admin
```

- Le lien est écrit **seul** sur la sortie standard (une ligne), et dans `<dossier>/lien-admin.txt` ; les messages vont sur la sortie d'erreur. Journal : « reconnexion créée », `qui` = `lien.ts`.
- Origine du lien : `--url <origine>`, sinon `WDD_URL`, sinon `http://127.0.0.1:<port>` avec `--port <n>` (qui l'emporte sur `WDD_URL`), sinon `WDD_PORT`, sinon `8080`. `--donnees` peut venir de `WDD_DONNEES`.
- Codes de sortie : `0` ; `1` refus (pas de `outil.sqlite` dans le dossier, aucune base n'est créée ; compte introuvable ou désactivé ; aucun admin actif) ; `2` usage.
- Le serveur peut tourner pendant ce temps : la base est ouverte avec `busy_timeout` (5 s), le serveur aussi. Il supprime le fichier quand le lien a servi. La montée de version de la base se fait en une transaction (`BEGIN IMMEDIATE`) : lancés en même temps sur une base d'avant, `lien.ts` et le serveur se suivent au lieu d'échouer.

**`lien-admin.txt`.** Une ligne, droits 0600 hors Windows, écrite d'un coup (fichier temporaire puis renommage).
- Il est supprimé dès que son lien ne vaut plus : utilisé, annulé (par l'API, ou par la désactivation du compte visé), expiré ou illisible. Le serveur vérifie après chaque utilisation ou annulation, et toutes les minutes pour l'expiration. Le lien est retrouvé à partir du contenu du fichier : `lien.ts` l'écrit depuis un autre processus.
- Au démarrage avec un admin, il est supprimé, **sauf** s'il porte un lien de reconnexion encore valable (cas de `lien.ts` lancé avant le serveur, par exemple par l'installeur).

**Verrou du dossier des données (`serveur.verrou`, `serveur/src/verrou.ts`).** Un seul serveur par `WDD_DONNEES` : deux serveurs sur les mêmes données écriraient tous deux dans `outil.sqlite` et dans les dépôts de design, et le second supprimerait au démarrage les verrous de Git du premier.
- Le serveur crée `<WDD_DONNEES>/serveur.verrou` de façon exclusive, avant toute autre lecture ou écriture des données : `{pid, port, hote, debut, ecoute, jeton}`, le port réel y étant écrit dès l'écoute (`ecoute: true`). Il le retire à l'arrêt (SIGINT, SIGTERM) et quand le démarrage échoue.
- Verrou d'un autre serveur vivant : démarrage refusé (`démarrage impossible : un autre serveur utilise déjà ce dossier de données (…) : PID n, port p. L'arrêter d'abord.`, code 1). Un serveur encore en train de démarrer (`ecoute: false`) compte pour vivant pendant 2 min.
- Verrou périmé, repris : PID mort (arrêt brutal, `taskkill /F`, `kill -9`) ; PID de ce processus (sous Docker, node est le PID 1 à chaque démarrage du conteneur) ; PID vivant dont le serveur écoutait mais ne répond plus à `/api/sante`, trois essais de 2 s (PID repris par un autre programme après un redémarrage).
- `lien.ts` n'en a pas besoin : il travaille à côté du serveur, par la base. L'installeur Windows le lit pour refuser, avant d'écrire quoi que ce soit, un dossier de données déjà servi par un autre serveur.
- Limite : deux démarrages simultanés sur un verrou périmé laissent une fenêtre étroite. Si le refus persiste alors qu'aucun serveur ne tourne avec ces données, supprimer le fichier.

**Session prolongée à l'usage.** Une session qui sert alors qu'il lui reste moins de 15 jours repart pour 30 jours, à la même valeur de cookie. Une réponse qui porte ce cookie n'est jamais gardée par un cache partagé : `Cache-Control: no-store` est posé avec lui (redirections, 204), et les fichiers de la méta-interface sont servis en `private, no-cache`.
- La réponse renvoie alors `Set-Cookie` avec le nouveau `Max-Age` : `wdd_session` sur l'hôte principal, et sur l'hôte des pages `wdd_pages` pour le projet de l'adresse, avec ses deux `Path`.
- C'est fait une fois par requête, avant la réponse. Rien n'est prolongé avec deux `wdd_session`, avec un en-tête `Authorization` (le jeton passe avant), pour une session expirée ou un compte désactivé. Les vérifications du flux SSE à chaque ping ne prolongent rien.

**Jetons.** Colonnes `jetons.expire` (date ISO, vide = sans fin ; `Base.jeton()` refuse un jeton expiré, flux compris) et `jetons.origine` (texte, vide pour les jetons existants). `Base.creerJeton(projet, nom, role, pour, { expire, origine })`. L'appairage les remplit : `origine` = « appairé depuis <poste> (<ip>) », sans IP hors écoute locale ; un jeton ponctuel expire une heure après sa livraison.

#### Appairage d'un poste (§ 2.1)

Sur le modèle de l'autorisation d'appareil (RFC 8628) : la CLI demande, l'humain autorise dans son navigateur, la CLI vient chercher le jeton. Personne ne le voit. Hôte principal seulement : sur l'hôte des pages, toutes ces routes répondent 404.

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `POST /api/appairage` | personne | `{ poste, projet?, role?, usage? }` → `201 { code_appareil, code, expire, intervalle }`. `poste` : 1 à 60 caractères, règles d'un nom affiché ; `projet` : forme d'un id (son existence n'est pas vérifiée, il ne sert qu'à présélectionner) ; `role` : `agent` (défaut) ou `mainteneur` ; `usage` : `permanent` (défaut) ou `ponctuel`. `code_appareil` : 32 octets aléatoires en base64url, seule son empreinte est gardée ; `code` : `XXXX-XXXX` (alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`) ; `expire` : 10 min ; `intervalle` : en **secondes** (2). Plus de 30 appairages en attente sur le serveur, ou 60 créations dans la minute : `429 quota_exceeded`. Les expirés sont purgés à chaque création |
| `GET /api/appairage/<code>` | session (403 avec un Bearer) | `{ code, poste, cree, expire, projet, role, usage, ip, meme_ip, projets: [{ id, titre, role_max }] }` : `projet`, `role`, `usage` sont ceux demandés ; `projets` : ceux où ce compte peut autoriser, avec le rôle le plus haut possible (`agent` pour un contributeur, `mainteneur` pour un mainteneur ou un admin ; un lecteur n'en a aucun). Code accepté en minuscules et sans tiret. Inconnu, expiré ou déjà traité : 404 |
| `POST /api/appairage/<code>/autoriser` | session (CSRF) | `{ projet, role, nom? }` → `204`. `projet` : contributeur, mainteneur ou admin (403 sinon, projet inexistant compris) ; `role: mainteneur` seulement pour un mainteneur ou un admin du projet (403) ; `nom` : par défaut « Agent · <poste> », coupé à 60 caractères. Journal « appairage autorisé » (`detail` : poste, IP en écoute locale, rôle, usage, nom) |
| `POST /api/appairage/<code>/refuser` | session (CSRF) | corps vide ou `{}` → `204`. Journal « appairage refusé » |
| `POST /api/appairage/jeton` | personne | `{ code_appareil }` → `202 { etat: "attente" }` ; ou, **une seule fois**, `200 { jeton, projet, role, nom, pour: { id, nom }, usage, expire }` (le jeton est créé à ce moment, propriétaire = le compte qui a autorisé ; `expire` : date ISO pour un ponctuel, `null` sinon) ; `410 { code: "refused" }` (refusé, jusqu'à son expiration) ; `410 { code: "expired" }` (expiré, purgé, inconnu, ou déjà livré : la purge les rend indiscernables) ; `429 { code: "slow_down" }` (moins d'un `intervalle` depuis la dernière interrogation acceptée, à 10 % près ; une interrogation refusée ne compte pas et ne livre rien) |
| `GET /appairage?code=XXXX-XXXX` | personne | `303` vers `/#/appairage/XXXX-XXXX` (page d'autorisation de la méta-interface) ; code invalide ou absent : `/#/appairage` |

- **Au plus 10 codes inconnus par session et par minute** (`GET`, `autoriser` et `refuser` comptent, une forme invalide aussi), puis `429 quota_exceeded`, même pour un bon code. En mémoire du serveur.
- **Livraison** : le compte qui a autorisé est relu. Désactivé, ou sans droit sur le projet depuis : `410 refused`, rien n'est créé (sinon le jeton reprendrait vie à sa réactivation). Passé contributeur : le jeton est créé `agent`. Journal « jeton créé » (`qui` = ce compte, `detail.par: "appairage"`), jamais la valeur.
- **IP** : `ip` et `meme_ip` (même adresse que le navigateur qui regarde) seulement en **écoute locale** (`WDD_HOTE` de bouclage, sans `WDD_URL` ou avec une `WDD_URL` de bouclage) ; sinon `null`, et seule la vérification du code protège (pas de réglage de proxy de confiance). L'origine du jeton suit la même règle.
- Pas de limite par IP : derrière Docker ou un proxy, tout le monde a la même.
- `Config.intervalleAppairageMs` (2 000 par défaut) ne se règle que par surcharge, pour les tests.

#### Demandes de traitement et veilleurs (§ 5.1, § 5.2)

Réglage `traitement` de `site.json` (`PUT …/reglages`, versionné comme les disciplines) : `personne`, `mainteneur` (défaut) ou `contributeur`. Il dit qui peut créer une demande ; un admin le peut toujours, sauf avec `personne`. Valeur illisible écrite à la main : le défaut.

| Méthode et chemin | Qui | Rôle |
|---|---|---|
| `GET /api/p/<p>/demandes` | tout membre (session ou Bearer) | `{ veilleurs: [{ nom, pour, poste, vu }], active, recentes }` ; `veilleurs` : vus depuis moins de 30 s, avec un jeton encore valable ; `active` : la demande `attente` ou `en-cours`, ou `null` ; `recentes` : les 10 dernières demandes **finies** (sans l'active), de la plus récente à la plus ancienne |
| `POST /api/p/<p>/demandes` | session, rôle permis par `traitement` (CSRF) | corps vide ou `{}` (toute clé : 400) → `201` demande `attente` + `sans_veilleur` (booléen). Une demande active : `409 { code: "conflict", demande }`. Bearer : 403 |
| `POST /api/p/<p>/demandes/<id>/annuler` | session : demandeur, mainteneur, admin | corps vide → `200 { demande }` : `attente` → `annulee` ; `en-cours` → `annulation_demandee: true` (déjà demandée : `inchange: true`) ; finie : 409 |
| `POST /api/p/<p>/veille` | Bearer, rôle `agent` | `{ poste }` (règles d'un nom affiché) → `200 { demande }` : la demande en `attente`, ou `null`. Met à jour `vu` |
| `POST /api/p/<p>/demandes/<id>/prendre` | Bearer, rôle `agent` | corps vide → `200 { demande }` : `attente` → `en-cours`, preneur = ce jeton, `poste` = celui de sa dernière veille ; sinon `409 { demande }` |
| `POST /api/p/<p>/demandes/<id>/battement` | Bearer, le preneur (403 sinon) | `{ journal? }` (2 000 caractères au plus) → `200 { annuler }`. Demande plus en cours (finie, perdue) : `409 { demande }` |
| `POST /api/p/<p>/demandes/<id>/terminer` | Bearer, le preneur | `{ etat, resume?, code_sortie?, raison? }` : `etat` ∈ `terminee`, `echouee`, `annulee` ; `resume` : 4 000 caractères au plus ; `code_sortie` : entier (sûr, les codes Windows sans signe compris) ou `null` ; `raison` : une ligne de 200 caractères au plus (« délai dépassé », « veille arrêtée ») → `200 { demande }`. Plus en cours : 409 |

- **Demande** : `{ id, etat, cree, pris, battement, fini, demandeur: { id, nom }, preneur: { id, nom, pour } | null, poste, annulation_demandee }`, plus `code_sortie`, `raison`, `journal` et `resume` **seulement pour le demandeur, un mainteneur ou un admin** (un jeton `mainteneur` compris ; un jeton `agent` ne les voit pas). Ce sont des textes non sûrs (écrits par le poste du code, ou par le serveur pour `raison`), à afficher en texte brut. Tout `wdd_…` y est masqué (`wdd_…`) par le serveur.
- **Une active au plus par projet**, garantie par un index unique de la base (créations simultanées : une seule passe).
- **Vérification paresseuse**, au début de chaque route des demandes (et de `GET /api/moi`) : `en-cours` sans battement depuis 120 s → `echouee`, raison « veilleur perdu » ; `attente` depuis plus de 24 h → `annulee`, raison « attente de plus de 24 h ».
- **Flux** : chaque changement d'état envoie `event: demandes` avec `{ id, etat }` sur `GET /api/p/<p>/flux` de l'hôte principal (annulation demandée : `etat: "en-cours"`) ; la page relit alors les demandes. Jamais sur l'hôte des pages, où toutes ces routes répondent 404.
- **Aucun texte libre du demandeur** : rien de ce qu'il tape n'arrive à l'agent.
- Journal d'audit : création, prise, annulation demandée, fin.

**Base existante.** Au démarrage, les tables manquantes sont créées et les colonnes manquantes ajoutées (liste `COLONNES` de `src/base.ts`, un seul mécanisme). Une base de l'étape 3 garde ses comptes, ses sessions, ses jetons et ses invitations (testé : `test/prise-en-main-a.test.ts`).

### API de test (`WDD_TEST=1`)

| Route | Rôle |
|---|---|
| `POST /__test/projet {id, titre}` | crée le projet s'il n'existe pas |
| `POST /__test/session {projet, compte, nom?, role}` | compte d'id choisi (ex. `essai`, pour `by === "essai"` des scénarios), cookie de session (aussi rendu dans `session`) |
| `GET /__test/connexion?projet=&compte=&role=&nom=&suite=` | idem par navigation : cookie puis 303 vers `suite` (chemin local, `/p/<projet>/` par défaut) |
| `GET /__test/retours?projet=` | instantané sans effet des modes (`T.docs`) |
| `POST /__test/reinitialiser {projet}` | vide les retours (un commit) |
| `POST /__test/mettre {projet, id, donnees}` | `T.put` + diffusion : écrit tel quel, version +1, commit |
| `POST /__test/ecrire {projet, id, champs}` | `T.writeServer` : fusion, version +1, commit, diffusion |
| `POST /__test/supprimer {projet, id, diffuser}` | suppression, commit ; diffusion sauf `diffuser: false` |
| `POST /__test/diffuser {projet}` | rediffuse l'instantané courant (`T.emit`) |
| `POST /__test/notes {projet, nom, notes}` | écrit `notes/<nom>` (`notes_*.json`) dans le dépôt, un commit, **sans validation** (l'API `PUT …/notes/<nom>` valide) |
| `POST /__test/preparer {projet, titre?, retours?, comptes?, invitations?, jetons?}` | étape 3 : crée le projet s'il manque ; retours de départ en un commit (`[{ id?, donnees }]`, complétés par un document valide), comptes (`[{ id, nom?, role }]`, session et `cookie` rendus), invitations (`[{ role, expire? }]`, `lien` et `url` rendus), jetons (`[{ nom, role?, pour? }]`, valeur rendue) |
| `POST /__test/reinitialiser {projet, tickets: true}` | vide aussi les tickets (`tickets/.dernier` gardé) |
| `POST /__test/mode {projet, mode}` | `normal`, `readonly`, `denywrite`, `quota`, `unavailable`, `revoked`, `silent`, `snapretry` (détail en tête de `src/test-api.ts`) |

Les commits de l'API de test ont pour auteur `banc de test <test@wdd.invalid>`.

Les scénarios de régression de la page se rejouent contre ce serveur : `sh site/tests/lancer-http.sh <dossier de sortie hors dépôt>` (détail : [site/tests/README-http.md](../site/tests/README-http.md)).

## Exemples (curl)

Envoyer du JSON en UTF-8 depuis un fichier (`--data-binary @fichier.json`) : sous Windows, curl convertit les arguments `-d` dans la page de code de la console, et le serveur refuse un corps qui n'est pas en UTF-8.

```sh
U=http://127.0.0.1:8080
# 1. Compte admin : lien affiché au premier démarrage
curl -c admin.txt --data-urlencode "nom=Admin" "$U/invitation/<jeton>"
# 2. Projet, invitation d'un contributeur
curl -b admin.txt -H "X-WDD: 1" -H "Content-Type: application/json" -d '{"id":"jardin","titre":"Jardin"}' $U/api/admin/projets
curl -b admin.txt -H "X-WDD: 1" -H "Content-Type: application/json" -d '{"projet":"jardin","role":"contributeur"}' $U/api/admin/invitations
# 3. Ouvrir l'invitation (ou dans un navigateur)
curl -c moi.txt -H "Content-Type: application/json" -d '{"nom":"Camille"}' "$U/invitation/<jeton>"
curl -b moi.txt $U/api/p/jardin/session
# 4. Un retour (document complet, voir CONTRAT.md § 9)
curl -b moi.txt -H "X-WDD: 1" -H "Content-Type: application/json" --data-binary @retour.json $U/api/p/jardin/retours
# 5. Agent : jeton, lecture, réponses en batch, notes, build (la CLI « outil » fait tout cela : cli/README.md)
curl -b admin.txt -H "X-WDD: 1" -H "Content-Type: application/json" -d '{"projet":"jardin","nom":"Claude"}' $U/api/admin/jetons
curl -b admin.txt -H "X-WDD: 1" -H "Content-Type: application/json" -d '{"projet":"jardin","nom":"Import","role":"mainteneur"}' $U/api/admin/jetons
curl -H "Authorization: Bearer <jeton>" "$U/api/p/jardin/retours?status=nouveau"
curl -H "Authorization: Bearer <jeton>" -H "Content-Type: application/json" --data-binary @batch.json $U/api/p/jardin/retours/batch
curl -X PUT -H "Authorization: Bearer <jeton>" -H "Content-Type: application/json" --data-binary @notes_2026-11-23.json $U/api/p/jardin/notes/notes_2026-11-23.json
curl -H "Authorization: Bearer <jeton>" -H "Content-Type: application/json" --data-binary @site/examples/data.json $U/api/p/jardin/builds
# 6. Historique
git -C "$WDD_DONNEES/projets/jardin/depot" log --format='%h %an <%ae> | %s'
```
