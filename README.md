# Vaevia, système de retours

Outil auto-hébergé pour faire vivre un wiki de design et ses retours à côté du code : l'équipe commente chaque élément, un agent (quel qu'il soit) traite les retours, et tout le travail de design et de décision est versionné dans Git.

- Architecture : [docs/architecture.md](docs/architecture.md)
- Installer sur un réseau isolé : [docs/hors-ligne.md](docs/hors-ligne.md) ; mettre le serveur en ligne pour l'équipe : [docs/acces-distant.md](docs/acces-distant.md) ; publier depuis une CI : [docs/ci/README.md](docs/ci/README.md) ; retours depuis une application : [docs/retours-depuis-une-application.md](docs/retours-depuis-une-application.md).
- Les commentaires du code citent parfois des notes de conception (`docs/etape…`) qui ne sont pas publiées avec ce dépôt.
- `site/` : le site de retours en cours d'extraction (étape 0).
  - `site/gabarit/template.html` : le gabarit, réduit à l'affichage ;
  - `site/retours/` : le module retours (`retours.js`, `retours.css`), les adaptateurs de stockage (`stockage-<nom>.js`) et leur contrat ([site/retours/CONTRAT.md](site/retours/CONTRAT.md)) ;
  - `site/build.js` : construit la page (un seul fichier HTML autonome) ; `site/valider-notes.js` : règles des notes datées, partagées avec le serveur et la CLI ; `site/changements.js` : changements entre deux builds et refs d'une page (étape 3.7), partagés avec le serveur ; `site/banc_essai.js` et `site/tests/` : banc d'essai et scénarios de régression.
- `serveur/` : le serveur (étape 1 : retours dans un dépôt Git de design, API, SSE, invitations ; étape 2 : notes datées, jetons à rôle, import depuis claude.ai) ; lancer, variables et routes : [serveur/README.md](serveur/README.md).
- `cli/` : la CLI `outil` (étape 2), tout ce dont un agent a besoin pour traiter les retours (lire, répondre par lot, notes, export, import) ; commandes, configuration et codes de sortie : [cli/README.md](cli/README.md).
- `heritage/site-retours/` : copie du skill `site-retours` (gabarit, build, banc d'essai, scénarios), point de départ de l'étape 0. Référence de comparaison : ne pas modifier.

## Installer sur Windows

Double-clic sur `installer.cmd`, à la racine du dépôt. Il vérifie Node 24 et Git (et propose `winget` s'il en manque un), lance le serveur en arrière-plan sur `http://127.0.0.1:8080` (ou le premier port libre jusqu'à 8099), propose le démarrage avec Windows, la CLI `outil` dans le `PATH` et, si `%USERPROFILE%.claude` existe, le raccourci Claude Code, puis ouvre le navigateur sur le lien de création du compte admin. Son résumé donne la phrase à dire à ton agent pour brancher un dépôt (plus bas). Relancé, il ne refait rien de ce qui est fait.

Si tu as déjà un serveur (dossier de données à toi), passe `-Donnees <ce dossier>`, après avoir arrêté ce serveur ; sinon l'installeur en crée un nouveau. Un dossier de données déjà servi par un autre serveur est refusé (« un serveur utilise déjà ce dossier de données (PID, port) : l'arrêter d'abord ») : deux serveurs sur les mêmes données se gêneraient.

- Options, depuis une invite de commandes : `installer.cmd -Oui` (réponses par défaut, aucune question), `-Port <n>`, `-Donnees <dossier>`, `-Reseau` (écoute sur le réseau, pour un essai en équipe sur un réseau de confiance : HTTP en clair, aucune règle de pare-feu créée). `-Reseau` vaut ensuite à chaque démarrage (raccourci du dossier Démarrage, `-Demarrer`), avec le même avertissement ; pour revenir en local : `installer.cmd -Arreter`, puis `installer.cmd` sans `-Reseau`. Une option inconnue ou un `-Port` invalide : code 2.
- `installer.cmd -Arreter`, `installer.cmd -Demarrer` ; `installer.cmd -Reconnecter` : un lien de reconnexion pour l'admin (session expirée, cookies effacés), ouvert dans le navigateur. `-Arreter` n'arrête que le serveur lancé par cette installation (PID et heure de démarrage de `serveur.pid`, `principal.ts` de ce dépôt), jamais un autre.
- Raccourci Claude Code (étape « Raccourci Claude Code », oui par défaut) : copie de [methode/integrations/claude/SKILL.md](methode/integrations/claude/SKILL.md) dans `%USERPROFILE%.claudeskillssite-retours-outilSKILL.md`, pour que Claude Code reconnaisse la phrase de branchement dans un dépôt neuf. Un fichier différent déjà là n'est remplacé que sur un « oui » explicite. Elle porte le même nom que la copie qu'`outil installer` pose dans chaque dépôt, et Claude Code prend la copie personnelle d'abord (d'après sa documentation) : relance `installer.cmd` après chaque mise à jour de l'outil pour la garder à jour.
- Désinstaller : `installer.cmd -Desinstaller` arrête le serveur, retire le raccourci de démarrage, l'entrée du `PATH` si c'est l'installeur qui l'a ajoutée et le raccourci Claude Code s'il est identique à la copie posée, et garde les données (il dit où elles sont). Le `PATH` utilisateur est réécrit avec son type d'origine (ses `%…%` restent tels quels).
- Données hors du profil (par exemple `-Donnees D:\wdd`) : l'installeur avertit si le dossier est ouvert à d'autres comptes du poste (`lien-admin.txt` y donne les droits d'admin) et donne la commande `icacls` qui le réserve à ton compte.
- État de l'installation : `%LOCALAPPDATA%\Vaevia\` (`installation.json`, écrit une fois le serveur prêt et lu par `outil brancher` ; `serveur.log` ; `serveur.pid` ; `cli-path.txt` si l'installeur a ajouté la CLI au `PATH` ; `claude-skill.txt`, empreinte et chemin du raccourci Claude Code posé) ; données par défaut dans son sous-dossier `donnees`.
- Test (Windows, `-Essai` : dossiers temporaires, jamais le port 8080, ni `PATH`, ni Démarrage, ni navigateur ; `-Etat` toujours, `-Donnees` pour l'installation ; raccourci Claude Code seulement avec `-Profil <dossier temporaire>`, qui tient lieu de `%USERPROFILE%` et ne peut mener ni dans le dépôt de l'outil ni au vrai `.claude`) : `WDD_TESTS_TMP=<dossier hors dépôt> node --test "outils/test/*.test.ts"`.

## Brancher un dépôt

Il faut la CLI `outil` dans le `PATH` (l'installeur Windows le propose ; sinon, le dossier `cli/` de ce dépôt). Dans le dépôt du code, dis à ton agent, quel qu'il soit :

> Branche ce dépôt sur le serveur de retours <URL> (projet <P>) avec la CLI outil : lance outil methode et suis le § 0.

La fin de l'installeur et l'écran du projet dans la méta-interface (le Kanban, et le Wiki tant qu'il n'est pas publié) donnent cette phrase avec la bonne adresse et le bon projet. L'agent lance `outil installer` : un clic « Autoriser » dans ton navigateur, puis la page est publiée et il te dit les fichiers à commiter. Détail : [cli/README.md](cli/README.md) (« Brancher un dépôt »), [methode/METHODE.md](methode/METHODE.md) § 0.

## Construire une page

```
node site/build.js <data.json> <page.html> [notes.json ...] [--notes-dir <dossier>] [--no-notes] [--stockage=artifact] [--template <gabarit.html>] [--check]
```
Exemple : `node site/build.js site/examples/data.json <sortie hors dépôt>/site.html site/examples/notes_exemple.json`.
Schéma de `data.json` et des notes : [site/SCHEMA.md](site/SCHEMA.md). Les notes ne sont lues que si elles sont données (fichiers ou `--notes-dir`, le dossier `notes/` du projet), jamais dans `site/`.
`--stockage` choisit l'adaptateur `site/retours/stockage-<nom>.js` (`artifact` par défaut : base d'un Artifact claude.ai ; `http` : serveur de l'étape 1, qui construit lui-même ses pages).

## Tests du serveur et de la CLI

```
WDD_TESTS_TMP=<dossier hors dépôt> node --test "serveur/test/*.test.ts"
WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
```
Chaque test démarre un vrai serveur sur un port libre, dans un dossier temporaire ; ceux de la CLI la lancent en sous-processus avec un `APPDATA` / `HOME` temporaire. Demande Node 24 et Git.

## Tests de régression du système de retours

```
sh site/tests/lancer.sh <dossier de sortie hors dépôt>
```
Attendu : `TOUT PASSE`, avec 83 vérifications PASS sur 11 modes (normal 62, readonly 3, denywrite 2, quota 1, unavailable 1, revoked 3, snapretry 2, silent 3, offline 3, nodb 2, nouser 1). Demande Node 18+ et Edge ou Chrome.

La base d'origine se rejoue de la même façon pour comparer : `sh heritage/site-retours/tests/lancer.sh <autre dossier>`.

Les mêmes scénarios, inchangés, se rejouent contre le serveur de l'étape 1 avec l'adaptateur `http` :

```
sh site/tests/lancer-http.sh <dossier de sortie hors dépôt>
```

Attendu : `TOUT PASSE`, avec 82 PASS sur 10 modes ; `nouser` est sans objet en HTTP. Demande Node 24, Git et Edge ou Chrome. Détail : [site/tests/README-http.md](site/tests/README-http.md).
