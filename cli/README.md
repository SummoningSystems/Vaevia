# CLI `outil` (étapes 2, 3 et 3.5, nom provisoire)

Tout ce dont un agent (quel qu'il soit) a besoin pour traiter une vague de retours contre le serveur : lire, répondre par lot, envoyer les notes datées et l'export, importer une ancienne page claude.ai ; suivre un chantier par un ticket (créer, prendre, attacher ses commits, cocher les critères, passer en revue) ; et, depuis l'étape 3.5, brancher un poste sans recopier de jeton (`outil brancher`), brancher un dépôt en une commande (`outil installer`), publier en une commande (`outil publier`), veiller sur le poste du code pour « Traiter les retours » depuis l'interface (`outil veille`) et lire la méthode (`outil methode`). Spécification : [docs/etape2-cli-methode.md](../docs/etape2-cli-methode.md) § 1, [docs/etape3-meta-interface.md](../docs/etape3-meta-interface.md) § 5.1 et [docs/etape3-5-prise-en-main.md](../docs/etape3-5-prise-en-main.md) § 2.3, § 3, § 4, § 5.3, § 6.1 ; méthode de travail : [methode/METHODE.md](../methode/METHODE.md) (ou `outil methode`).

Node 24, TypeScript exécuté directement, **aucune dépendance**. Git (pour `tickets commit` et `installer`, en lecture seulement pour ce dernier), le navigateur (`brancher`), l'exporteur (`publier`) et l'agent (`veille`) sont lancés par `execFile` ou `spawn`, jamais par un shell ; seule exception, un agent `.cmd` ou `.bat` sous Windows passe par `cmd.exe /d /s /c`, avec les refus décrits plus bas. **Windows** : un programme lancé par son nom seul serait d'abord cherché dans le dossier courant, c'est-à-dire le dépôt (un `git.exe`, `taskkill.exe`, `explorer.exe` ou `node.bat` commité y serait lancé). Les programmes du système (`explorer.exe`, `taskkill.exe`, `cmd.exe`) sont donc lancés par leur chemin absolu sous `SystemRoot` validé, sans repli sur le nom seul ; `git` est résolu dans le `PATH` (dossiers absolus seulement) ; et `NoDefaultCurrentDirectoryInExePath=1` est posé pour la CLI et pour chaque programme lancé (l'agent de la veille, et les `.cmd` ou PowerShell qu'il lance à son tour, en héritent). `cli/outil.cmd` le pose aussi avant d'appeler `node`.

| Fichier | Rôle |
|---|---|
| `outil.ts` | point d'entrée (`principal`), analyse des options, aide, commandes des étapes 2 et 3, `methode`, `importer-artifact` (avec `--autoriser`) |
| `commun.ts` | contexte, erreurs et codes de sortie, `.outil.json`, fichiers utilisateur (`jetons.json`, `appairages.json`), HTTP, affichage ; étape 3.5 : `installation.json`, dossier de travail, recherche d'un programme dans le `PATH` (avec `PATHEXT`), arrêt d'un arbre de processus |
| `appairage.ts` | `outil brancher` et `obtenirJeton()` (appairage, attente, livraison, révocation de soi) |
| `publier.ts` | `outil publier`, et l'envoi d'un build et d'une note partagé avec `export envoyer` et `notes envoyer` |
| `apercu.ts` | `outil apercu` (étape 3.6) : dernier build téléchargé, captures par Edge ou Chrome sans fenêtre (protocole DevTools sur un tube) |
| `installer.ts` | `outil installer` (dépôt, connexion par `brancher`, blocs d'`AGENTS.md` et `CLAUDE.md`, raccourci Claude, ancien site, `.outil.json`, première publication par `publier`) |
| `executable.ts` | `outil executable` (étape 3.10) : chemins des logiciels à lancer (moteur, application), propres au poste, dans `executables.json` du dossier utilisateur ; repris par `outil publier` pour un exporteur nommé par son nom nu |
| `veille.ts` | `outil veille` (commande mémorisée dans `veille.json`, boucle, lancement de l'agent, battements, masquage, arrêt de l'arbre de processus) |

```sh
node cli/outil.ts <commande> [options]      # partout
cli/outil <commande>                        # Git Bash, macOS, Linux (lanceur sh)
cli\outil.cmd <commande>                    # cmd, PowerShell
```

Mettre `cli/` dans le `PATH` pour taper `outil` (un lien ou une jonction vers `cli/` marche aussi). L'installeur Windows le fait (étape 3.5), et le bloc d'`AGENTS.md` écrit par `outil installer` suppose `outil` dans le `PATH` : sans lui, l'agent le dit à l'humain au lieu de chercher (à défaut, `node <dépôt de l'outil>/cli/outil.ts …` reste possible à la main). Sous Git Bash, si le bit d'exécution est perdu au clonage : `sh cli/outil …`. Pas d'installation par `npm link` ni `npm install -g` : Node n'exécute pas le TypeScript placé sous `node_modules`.

## Sorties

- Lisible par défaut ; **`--json` partout** : le résultat en JSON sur stdout, les messages sur stderr. En cas d'erreur, stdout porte `{ "erreur": { "sortie", "message", "statut"?, "code"?, "document"?, "index"?, "id"?, "erreurs"? } }`.
- Codes de sortie :

| Code | Sens |
|---|---|
| 0 | succès |
| 1 | erreur (fichier invalide, refus du serveur 400/404/422, build refusé, serveur injoignable ou réponse qui n'est pas du JSON, import avec des refus) |
| 2 | usage (commande, option ou argument) : `outil aide <commande>` |
| 3 | conflit de version (409) : relire, corriger la version, renvoyer ; pour un ticket : tenu par un autre (ne pas forcer) ou modifié entre-temps |
| 4 | droits : jeton absent, invalide ou révoqué (401), rôle insuffisant (403), ticket qui n'est pas à toi (403) |

## Configuration

- **`.outil.json`** dans le dépôt du **code** (commité, sans secret), cherché dans le dossier courant puis les parents :
  ```json
  { "serveur": "https://retours.exemple.fr", "projet": "drako",
    "publier": { "exporteur": ["node", "tools/site-retours/export.mjs", "--out={data}"], "notes": "tools/site-retours" } }
  ```
  `publier` (étape 3.5) n'est lu que par `outil publier`.
  Un jeton trouvé dans ce fichier (clé `jeton`, `token`, `auth`, `authorization`, `apiKey`…, valeur `wdd_…` ou valeur qui contient un jeton, comme `Bearer wdd_…`) est **refusé** : la commande s'arrête (code 1) sans l'utiliser.
- **Jeton** : variable `OUTIL_JETON`, sinon fichier utilisateur indexé par serveur puis projet :
  - Windows : `%APPDATA%\outil\jetons.json` ;
  - ailleurs : `$XDG_CONFIG_HOME/outil/jetons.json`, à défaut `~/.config/outil/jetons.json` (dossier `0700`, fichier `0600`).
- **`outil brancher`** (étape 3.5, plus bas) : la façon simple, sans jeton à recopier.
- **`outil connexion [--serveur URL] [--projet P]`** (poste sans navigateur) : écrit `.outil.json` dans le dossier courant s'il n'en trouve pas, lit le jeton sur **l'entrée standard** (jamais en argument : il resterait dans l'historique), le vérifie par `/session` puis l'enregistre. Avant de lire le jeton, elle écrit sur stderr le projet et le serveur auxquels il sera envoyé (et le `.outil.json` d'où ils viennent). Dans un terminal, la saisie est masquée ; sinon tout le flux est lu (`outil connexion < jeton.txt`, ou coller puis Ctrl+D / Ctrl+Z Entrée).
- Un jeton n'est jamais recopié dans un message : `OUTIL_JETON` ou un jeton enregistré qui n'a pas la forme d'un jeton (caractère de contrôle, deux lignes) est refusé sans être cité, et tout `wdd_…` est masqué dans les messages d'erreur.
- Jeton ponctuel (par ex. mainteneur pour l'import) sans le laisser dans l'historique : `read -rs OUTIL_JETON; export OUTIL_JETON` (sh), ou `$env:OUTIL_JETON = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Jeton')).Password` (PowerShell).

- **Fichiers utilisateur de l'étape 3.5**, à côté de `jetons.json`, mêmes droits : `appairages.json` (appairages en cours, indexés par serveur, projet demandé et usage ; il contient le code d'appareil, aussi secret qu'un jeton tant qu'il n'est pas livré, jamais affiché) ; `veille.json` (commande de la veille mémorisée par `--memoriser`, indexée par le chemin absolu de `.outil.json` : `{ "<chemin>": { "commande": [...], "memorise": "<ISO>" } }`).
- **Installation locale** (écrite par l'installeur, sans secret, `{ outil, donnees, port, url }`) : `%LOCALAPPDATA%\Vaevia\installation.json` sous Windows ; ailleurs `$XDG_DATA_HOME/Vaevia/installation.json`, à défaut `~/.local/share/Vaevia/installation.json`. `brancher` y prend le serveur (clé `url`) quand ni `--serveur` ni `.outil.json` ne le donnent.
- **Dossier de travail** (hors du dépôt, créé au besoin) : `%LOCALAPPDATA%\outil\travail\<projet>\` sous Windows ; ailleurs `$XDG_CACHE_HOME/outil/travail/<projet>/`, à défaut `~/.cache/outil/travail/<projet>/`. `publier` y fait écrire `data.json`.

Un jeton s'obtient d'un mainteneur du projet (méta-interface, vue Membres) ou de l'admin du serveur (`POST /api/admin/jetons {projet, nom, role}`, voir [serveur/README.md](../serveur/README.md)) : rôle `agent` pour traiter les retours et les tickets, `mainteneur` pour l'import. Son propriétaire est le compte qui le crée : les écritures sont signées « Agent · pour Alex ».

## Commandes

| Commande | Rôle |
|---|---|
| `outil aide [commande]` | aide complète, un exemple par commande |
| `outil connexion [--serveur URL] [--projet P]` | ci-dessus |
| `outil brancher [--serveur URL] [--projet P] [--role agent\|mainteneur] [--poste NOM] [--sans-navigateur] [--sans-attendre \| --attendre] [--delai S]` | appairage : un code, un clic « Autoriser » dans le navigateur, le jeton enregistré (plus bas) |
| `outil installer [--serveur URL] [--projet P] [--agent claude] [--oui] [--sans-publier] [--attendre] [--sans-navigateur] [--poste NOM] [--delai S]` | branche le dépôt du code en une commande, idempotente, sans opération Git (plus bas) |
| `outil statut` | projet, rôle du jeton, retours par statut, disciplines du projet (valeurs de `--discipline`), dernier build (numéro, date), URL de la page, dossier de travail (`travail` en `--json` ; hors du dépôt, METHODE § 2.3) |
| `outil retours liste [--statut nouveau,pris] [--dossier D]` | liste, et un fichier `<id>.json` par retour (`{id, version, donnees}`) dans `<travail>/retours` (le dossier de travail d'`outil statut`) ou dans `--dossier D` ; le chemin est affiché ; les fichiers d'une liste précédente absents de la nouvelle sont retirés, aucun autre fichier n'est touché ; sans dossier de travail (`LOCALAPPDATA` ou `HOME` non défini) et sans `--dossier` : la liste seule, `dossier: null` |
| `outil retours voir <id>` | un retour complet |
| `outil retours repondre <id> --statut S (--texte T \| --texte-fichier F) --version N` | une réponse |
| `outil retours repondre --lot fichier.json` | lot `[{id, version, statut, texte}]`, 50 au plus, 1 Mio au plus, tout ou rien ; validé localement avant l'envoi |
| `outil export envoyer data.json` | `POST /builds` : numéro de build, poids, URL, résumé de `build.js` (onglets, éléments, notes lues) et ses avertissements (sur stderr) |
| `outil notes envoyer notes_AAAA-MM-JJ[_suffixe].json [--remplacer]` | validation locale (module de `site/build.js`), puis `PUT /notes/<nom>` ; `--remplacer` sur décision d'un humain seulement |
| `outil notes liste` | notes présentes dans le dépôt de design, avec les jalons déjà pris |
| `outil notes voir <nom>` | contenu d'un fichier de notes : jalons et commits, ids, nouveautés, mesures, texte complet des points à valider |
| `outil publier` | notes, exporteur, envoi de `data.json`, adresse de la page (plus bas) |
| `outil apercu [--ancre ID] [--dossier D]` | aperçu du Wiki : dernier build téléchargé dans `<travail>/apercu`, trois captures PNG (bureau 1280 px, sombre, 390 px), chemins affichés ; sans navigateur, sortie 0 et un avertissement (plus bas) |
| `outil executable [<nom> [<chemin> \| --oublier]]` | chemin d'un logiciel à lancer, propre à ce poste (enregistré, sinon le `PATH`), seul sur la sortie standard ; avec un chemin : l'enregistre dans `executables.json` du dossier utilisateur (`{ serveur: { projet: { nom: chemin } } }`), jamais dans le dépôt ; sans argument : la liste. Enregistrer et oublier sont refusés sous la veille. `outil publier` lance le chemin enregistré quand `publier.exporteur` commence par ce nom |
| `outil importer-artifact <dossier> [--autoriser [--attendre] [--sans-navigateur] [--delai S]]` | import d'un dossier ArtifactData (`retours/<doc_id>.json`), lots de 500, bilan ; `--autoriser` : jeton mainteneur ponctuel par appairage, en mémoire, révoqué après l'import (plus bas) |
| `outil methode [--chemin]` | affiche `METHODE.md` de l'outil (ou son chemin), trouvé à partir de l'emplacement de la CLI : `AGENTS.md` dit « `outil methode` » au lieu d'un chemin propre à une machine |
| `outil veille [--poste NOM] [--delai-max S] [--une-fois] [--memoriser] [-- <commande> <args…>]` | veille sur le poste du code : prend les demandes « Traiter les retours » de l'interface et lance l'agent (plus bas) |
| `outil tickets liste [--statut a,b] [--discipline x] [--miens]` | tickets du projet ; `--miens` : ceux dont le jeton est le preneur, y compris en revue et faits (à reprendre : `--miens --statut pris`) |
| `outil tickets voir <T-n>` | un ticket : statut, preneur, retours, pages, critères numérotés, commits, description |
| `outil tickets creer --titre T [--retours id,id] [--pages sorte:id,…] [--discipline x] [--texte … \| --texte-fichier F] [--critere …]…` | crée un ticket `a-faire` ; `--critere` répétable ; formes vérifiées avant l'envoi |
| `outil tickets prendre <T-n>` | prend un ticket à faire ; tenu par un autre : sortie 3, rien d'écrit ; **pas d'option pour forcer** |
| `outil tickets rendre <T-n>` | le remet à faire, sans preneur |
| `outil tickets revue <T-n>` | `pris` → `en-revue` ; signale les critères non cochés (stderr) ; ticket déjà en revue tenu par un autre : 4 |
| `outil tickets commit <T-n> <rev>… [--depot code]` | résout chaque `<rev>` dans le dépôt Git du **dossier courant** (`<rev>^{commit}`, puis le sujet) ; commit absent ou dossier hors dépôt : refusé avant tout envoi ; envoie hash complet et sujet |
| `outil tickets critere <T-n> <numéro> [--fait\|--pas-fait]` | coche ou décoche un critère (1 = le premier) ; déjà dans cet état : rien d'écrit (4 si le ticket n'est pas à toi) |

**Pas de commande `fermer`** (ni `rouvrir`, ni `supprimer`) : fermer un ticket est un geste humain, depuis la méta-interface. `outil tickets fermer` sort en code 2 avec ce message. `prendre`, `rendre`, `revue`, `commit` et `critere` relisent la version juste avant d'écrire ; un 409 sort en code 3 sans nouvel essai, sauf `commit`, qui réessaie une fois si seuls les commits du ticket ont changé entre-temps.

En sortie lisible, les dates sont à l'heure locale (« 23/11/2026 17:38 ») et le hash d'une écriture du serveur s'appelle **révision** (« enregistré sur le serveur (révision 267f0ce902) ») : ce n'est pas un commit du projet, à citer dans les réponses. `--json` garde l'ISO (UTC) et `rev`.

Réponses : `replied` et `updated` prennent **l'heure du système au moment de l'envoi**, la même pour tout le lot ; un lot qui contient `replied` ou `updated` est refusé. Sur un 409, rien n'est écrit, le retour à jour est affiché (dans `erreur.document` avec `--json`) et la sortie vaut 3.

## Brancher un poste : `outil brancher` (étape 3.5)

Même principe que `gh auth login` (autorisation d'appareil, RFC 8628) : la CLI demande un appairage, un membre du projet clique « Autoriser » dans son navigateur (où il a sa session), la CLI reçoit le jeton et l'enregistre. Personne ne voit le jeton, ni l'humain ni l'agent.

1. **Serveur** : `--serveur`, sinon `.outil.json`, sinon `installation.json` (plus haut). Sans serveur : usage (2). **Projet** : `--projet`, sinon `.outil.json`, sinon celui que l'humain choisit dans le navigateur. **Poste** : `--poste`, sinon le nom de la machine (règles d'un nom affiché). **Rôle** : `agent` (défaut) ou `mainteneur`.
2. Avant tout envoi, stderr dit le serveur, le projet et d'où ils viennent ; puis « Ouvre `<serveur>/appairage?code=XXXX-XXXX` et vérifie le code XXXX-XXXX ». L'URL est **construite par la CLI** (serveur configuré et code validé), jamais reprise de la réponse. Sauf `--sans-navigateur`, le navigateur s'ouvre (`explorer.exe`, `open`, `xdg-open`, sans shell, détaché ; un échec n'est pas fatal).
3. **Dans un terminal** (stdin et stderr sont des terminaux) : la commande attend le clic, en interrogeant le serveur à chaque `intervalle` (2 s), jusqu'à `--delai` (600 s).
4. **Sans terminal** (agent), ou avec `--sans-attendre` : la commande sort tout de suite, code 0, `{ "etat": "attente", "code", "url", "expire", "relance" }`, et dit « En attente du clic « Autoriser ». Rien d'autre n'est fait. Relance avec --attendre après le clic : <relance> ». La relance porte le serveur et le projet résolus (`outil brancher --attendre --serveur <URL> --projet <projet>`). L'agent montre le code à l'humain, attend qu'il dise avoir cliqué, puis lance **cette relance** (90 s par défaut sans terminal ; relançable tant que le code vaut, 10 min ; `outil brancher --attendre` seul marche aussi quand un seul appairage est en cours).
5. **Succès** : `.outil.json` écrit s'il manque (complété s'il n'a pas de projet), jeton enregistré comme par `connexion`, sortie 0. **Refus** : 4. **Expiration** : 1.

Précisions (choix de l'implémentation) :
- Relancée sans `--attendre` pendant qu'un appairage est gardé (même serveur, projet, rôle et poste), elle l'**interroge d'abord une fois** : autorisé, le branchement se termine (0) ; refusé, 4 ; expiré, un nouveau code est demandé ; encore en attente, elle **réaffiche le même code** au lieu d'en créer un autre, sans rouvrir le navigateur. Relancer ne laisse donc jamais un code mort affiché.
- `--attendre` sans `--serveur` ni `.outil.json` reprend l'appairage en cours s'il n'y en a qu'un (de préférence celui demandé depuis ce dossier, et encore valable), **avant** `installation.json`, qui peut désigner un autre serveur ; s'il y en a plusieurs, ceux du serveur de l'installation locale, sinon usage (2) avec la liste.
- Refus, projet autorisé différent, expiration : le message cite la commande complète à relancer (`--serveur`, `--projet`), car l'appairage gardé est alors retiré.
- `jetons.json` illisible : vu **avant** l'appairage (sortie 1, aucun jeton créé). Jeton reçu mais impossible à enregistrer (écriture de `jetons.json` ou de `.outil.json`) : il est **révoqué**, et le message le dit.
- `.outil.json` à écrire qui est un lien symbolique ou une jonction : refus avant tout appairage ; une création se fait avec le drapeau `wx` (jamais par un lien pendant). Une complétion garde BOM et fins de ligne.
- **Délai dépassé** sans clic : sortie 1, `erreur.etat: "attente"` (avec `code`, `url`, `expire`) ; l'appairage est **gardé**, on relance `--attendre`.
- Un `429 slow_down` allonge l'intervalle d'autant (RFC 8628 § 3.5).
- Si `.outil.json` désigne un autre projet ou un autre serveur, refus avant tout envoi (2, même message que `connexion`). Si le projet **autorisé dans le navigateur** n'est pas celui de `.outil.json` (ou de `--projet`) : rien n'est enregistré, sortie 1, et le jeton reçu est **révoqué** (`DELETE /jeton`), sinon il resterait valable sans que personne ne le tienne.
- Sortie `--json` du succès : `{ etat: "branche", serveur, projet, role, nom, pour: { id, nom }, configuration, configurationCreee, fichierJetons }`.

**Import ponctuel** : `outil importer-artifact <dossier> --autoriser` demande un appairage `role: mainteneur, usage: ponctuel` pour le projet de `.outil.json` (le dossier est vérifié avant). Le jeton (une heure) reste **en mémoire**, il n'est jamais écrit ; après l'import, il est révoqué par `DELETE /api/p/<projet>/jeton`, **même si l'import échoue** (`jetonRevoque` dans la sortie, ou dans `erreur`). Sans terminal, en deux temps : le premier appel affiche le code et sort (0) ; `… --autoriser --attendre` attend le jeton, importe et révoque. Un clic d'un contributeur donne un jeton `agent` : l'import est refusé (4), le message le dit, et le jeton est révoqué. Sans `--autoriser`, le comportement de l'étape 2 reste ; une erreur de rôle propose `--autoriser`.

## Publier : `outil publier` (étape 3.5)

Lit `publier` dans `.outil.json` :
- **`exporteur`** : tableau de 1 à 30 textes de 500 caractères au plus (sans retour à la ligne), le premier est le programme. Lancé **sans shell**, dans le dossier de `.outil.json`, entrée fermée, environnement courant **sans `OUTIL_JETON`** (quelle que soit la casse de son nom sous Windows : `Outil_Jeton` aussi). `{data}` est remplacé par le chemin absolu de `data.json` dans le dossier de travail. Délai : 10 min. Sa sortie (stdout et stderr) passe ligne à ligne sur notre stderr (« exporteur : … ») ; stdout reste au JSON de `--json`. Un premier élément nu (`godot`) enregistré par `outil executable` pour ce projet est lancé par ce chemin avant toute recherche dans le `PATH` (étape 3.10). Sous Windows, un `.cmd` ou un `.bat` est refusé avant tout envoi (y compris un nom comme `npm`, que le `PATH` résout en `npm.cmd`) : lancer `node`, ou un `.exe`.
- **`notes`** : dossier relatif à `.outil.json` ; ses `notes_*.json` sont validés ensemble (règles de `site/build.js`), puis : absent du serveur, envoyé ; identique (même JSON), sauté ; différent, avertissement sans remplacement (« `outil notes envoyer <f> --remplacer`, sur décision d'un humain »).

Étapes : programme vérifié, notes, exporteur (l'ancien `data.json` du dossier de travail est retiré d'abord : un exporteur qui n'écrit rien ne republie pas la fois d'avant), envoi comme `outil export envoyer` (même résumé, mêmes avertissements), adresse de la page. Code de sortie non nul de l'exporteur, délai dépassé, `data.json` absent ou illisible : 1, rien n'est envoyé, avec la fin de sa sortie. Sans `publier.exporteur` : 1, avec la marche à suivre (rien n'est envoyé, pas même les notes).

**Confiance** : `.outil.json` est commité, donc `outil publier` lance une commande écrite dans le dépôt. C'est le même niveau de confiance que `npm run` : **ne pas publier depuis un dépôt dont on n'a pas relu `.outil.json`**.

## Voir le Wiki : `outil apercu` (étape 3.6)

L'agent voit enfin le Wiki qu'il publie (`METHODE.md` § 4, étape 6).
- **Téléchargement** : numéro du dernier build (`GET /api/p/<projet>/builds`), puis sa page par l'API (`GET /api/p/<projet>/builds/<n>/page`, sur l'hôte principal, dans les deux modes du serveur) : `{ build, html, csp }`, la page telle que servie à ce jeton (bandeau compris) et la CSP que le serveur poserait sur elle. Le jeton part dans l'en-tête `Authorization` seulement. Écrite (`apercu-<n>.html`) dans `<travail>/apercu`, ou `--dossier D` (refusé dans le dépôt du code). Serveur plus ancien que la CLI (route inconnue) : sortie 1, `apercu_indisponible`, message « pas bloquant ».
- **CSP du fichier local** : ouvert en `file://`, le fichier n'a plus l'en-tête CSP du serveur, défense de fond contre une injection dans le build. La CLI la reprend en `<meta http-equiv="Content-Security-Policy">` juste après `<meta charset>` : sans `frame-ancestors` (ignoré en méta) et sans `'self'` (en `file://`, il désignerait les fichiers du poste ; une directive vide devient `'none'`). La CSP ne couvre pas la navigation du document (`<meta http-equiv="refresh">`) : toute requête de la page autre que le fichier est en plus refusée par le protocole DevTools (`Fetch.enable`, `Fetch.failRequest`), et une capture prise ailleurs que sur le fichier (`location.href`) est retirée ; l'une et l'autre donnent un avertissement (contenu inattendu dans le build). Ni script non haché, ni requête réseau, ni cadre, image ou redirection vers un fichier local dans les captures (vérifié avec le vrai navigateur, `test/apercu.test.ts`). Sans CSP stricte dans la réponse (`default-src 'none'`, `script-src`), rien n'est écrit (`reponse_inattendue`).
- **Captures** : Edge ou Chrome sans fenêtre, cherché à `OUTIL_NAVIGATEUR` (chemin absolu), puis aux chemins habituels (Windows : `Program Files (x86)`, `Program Files`, `LOCALAPPDATA` ; macOS : `/Applications`), puis dans le `PATH` (`msedge`, `google-chrome`, `chromium`…, dossiers absolus seulement). Profil neuf créé par l'appel dans le dossier de sortie (`profil-navigateur-XXXXXX`, `mkdtemp`), seul retiré à la fin : un dossier déjà là n'est jamais touché ; pilotage par le protocole DevTools sur un tube (`--remote-debugging-pipe` : aucun port ouvert) ; environnement sans `OUTIL_JETON` ; le navigateur n'ouvre que le fichier local (`file://`, `--ancre` en fragment). Trois PNG : `bureau` (1280 × 1000, clair), `sombre` (1280 × 1000, `prefers-color-scheme: dark` par `Emulation.setEmulatedMedia`), `390` (390 × 1400, mobile) ; chacune montre le haut de la page, ou de l'ancre (`--ancre` avec l'ancre d'une fiche, ex. `objets--epee`, pour une fiche plus bas).
- **Contrôles** relevés dans le Wiki après le rendu, sur la page entière (les images, en `loading="lazy"` dans le gabarit, sont d'abord toutes chargées, 5 s au plus) : largeur du document (débordement horizontal), images chargées, et cassées ou jamais chargées, texte cassé (`undefined`, `NaN`, `[object Object]`) ; chaque anomalie donne un avertissement (`attention : …` sur stderr, `avertissements` en `--json`).
- Les retours sont indisponibles dans l'aperçu (Wiki ouvert hors du serveur) : c'est attendu. Sans navigateur, ou si le navigateur échoue : **sortie 0**, un avertissement et le chemin du HTML. Permise sous la veille (`OUTIL_DEMANDE`) : elle n'écrit rien sur le serveur, et la liste blanche de la veille (`Bash(outil *)`, `Read`) suffit à lancer la commande et à lire les captures.

## Brancher un dépôt : `outil installer` (étape 3.5)

**Phrase de départ**, que l'humain dit à son agent (donnée à la fin de l'installeur Windows et sur l'écran du projet dans la méta-interface) : « Branche ce dépôt sur le serveur de retours <URL> (projet <P>) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : <URL>/outil). » Elle nomme la CLI et une commande de départ : un agent neuf, sans raccourci, comprend sinon « remote Git » ou « serveur du jeu ». Le § 0 de `METHODE.md` lui fait lancer `outil installer`.

Depuis le dépôt du **code**. **Idempotente** : relancée, elle dit ce qui est déjà fait et ne refait rien. **Aucune opération Git d'écriture** : Git ne sert qu'à lire (`rev-parse --show-toplevel`, `--no-optional-locks status`), et le résumé liste les fichiers à commiter.

1. **Dépôt** : racine `git rev-parse --show-toplevel` (lancée d'un sous-dossier, elle travaille à la racine). Hors d'un dépôt Git : 1. Le dépôt de l'outil lui-même (`serveur/src/principal.ts` et `methode/METHODE.md`) est refusé (1). Un `.outil.json` au-dessus de la racine est refusé (1). Rien n'est écrit avant ces contrôles.
2. **Connexion** : un jeton de `jetons.json` pour ce serveur et ce projet qui répond à `/session` : déjà fait. Sinon `outil brancher` (mêmes règles ; serveur par `--serveur`, `.outil.json` ou `installation.json`). **Sans terminal**, elle s'arrête sur le code : sortie 0, `{ etat: "attente", depot, code, url, expire, relance }`, et **rien d'autre n'est écrit**. `relance` est la commande à lancer après le clic : `outil installer --serveur <URL> [--projet P] [--agent claude] [--sans-publier] [--poste N] [--sans-navigateur] --oui`, avec le serveur résolu et les options du premier appel (une relance `--oui` seule perdrait `--agent claude` et `--sans-publier`). Relancée pendant qu'un appairage est gardé, elle attend le clic comme `brancher --attendre` (90 s sans terminal), puis continue ; s'il a expiré, un nouveau code au même endroit. L'appairage gardé pour **ce dépôt** (jamais celui d'un autre dépôt) donne le serveur et le projet qui manquent, **avant** `installation.json`, et sans `--projet` il est repris quel que soit le projet demandé au premier temps. `--attendre` force l'attente. Les messages de refus et de projet différent citent la même relance complète. `brancher` n'écrit pas `.outil.json` ici : c'est l'étape 7.
3. **Type de projet** (constat, dans le résumé et les messages) : `godot` (`project.godot`), `unity` (`ProjectSettings/ProjectVersion.txt`), `node` (`package.json`), `python` (`pyproject.toml`, `requirements.txt`), sinon `autre`. Le repère est cherché à la racine, puis dans les sous-dossiers sur deux niveaux (par ex. `godot/project.godot`), sans dossier caché ni `node_modules`.
4. **`AGENTS.md`** : le bloc `<!-- outil:debut -->` … `<!-- outil:fin -->` du gabarit [`methode/AGENTS.md`](../methode/AGENTS.md) (sans chemin propre à une machine : méthode par `outil methode`, CLI `outil`). Absent : créé. Présent sans le bloc : ajouté à la fin, contenu gardé. Présent avec le bloc : remplacé s'il diffère ; la ligne « vérifier sans écrire », **une fois remplie par l'agent, est gardée** (sinon chaque relance effacerait son travail) ; le texte hors du bloc n'est jamais touché. Un bloc mal formé (un début sans fin, deux blocs) n'est pas touché et se signale.
5. **Claude Code** (`--agent claude`, ou `CLAUDE.md` ou `.claude/` présent) : le raccourci [`methode/integrations/claude/SKILL.md`](../methode/integrations/claude/SKILL.md) copié dans `.claude/skills/site-retours-outil/SKILL.md` ; le bloc `<!-- outil:debut -->` `@AGENTS.md` `<!-- outil:fin -->` dans `CLAUDE.md` (mêmes règles que pour `AGENTS.md`).
6. **Ancien site de retours** (`tools/site-retours/`) : des `notes_*.json` donnent `publier.notes: "tools/site-retours"` ; `export.mjs` donne `publier.exporteur: ["node", "tools/site-retours/export.mjs", "--out={data}"]` (convention du skill `site-retours`). Une clé déjà présente n'est pas remplacée. Message : comment reprendre ses retours (Claude : « reprends les retours de l'ancien site claude.ai » ; ailleurs : `outil importer-artifact <dossier> --autoriser`).
7. **`.outil.json`** : créé ou complété (`serveur`, `projet`, `publier`), clés existantes gardées, jamais de jeton ; une clé inconnue reçoit un avertissement et reste.
8. **Première publication** : `outil publier`, sauf `--sans-publier`, sans exporteur (renvoi à `METHODE.md` § 4), ou si le projet a déjà un build (« déjà publiée » : relancer ne republie pas). Un échec de l'exporteur est rapporté avec sa sortie ; la clé reste pour que l'agent la corrige ; le résumé complet sort quand même, avec le **code 1**.
9. **Résumé** : adresse de la page, fichiers à commiter (ceux que Git voit modifiés ou non suivis parmi `.outil.json`, `AGENTS.md`, `CLAUDE.md`, le raccourci), ce qui reste à faire (ligne « vérifier sans écrire », exporteur, anciens retours, modifications sautées), la commande de veille.

**Questions et `--oui`** : dans un terminal, une question O/N précède chaque modification d'un fichier **existant** (`AGENTS.md`, `CLAUDE.md`, raccourci, `.outil.json`) ; Entrée vaut oui, toute autre réponse que o/oui/y/yes vaut non. Sans terminal (agent) et sans `--oui`, ces modifications sont sautées et listées « relancer avec --oui ». Créer un fichier absent ne demande rien. Un `.outil.json` existant sans projet n'est complété qu'avec la question ou `--oui` (sauté sinon, BOM et CRLF gardés) ; la publication est alors sautée, et la relance citée porte `--projet` (le jeton est déjà enregistré : pas de second clic).

**Liens symboliques et jonctions** : jamais suivis. Un lien sur le chemin d'un fichier à écrire (`AGENTS.md`, `CLAUDE.md`, `.claude`, `.claude/skills`, …) le fait refuser (`refuse`), listé dans les avertissements et « à faire » ; un `.outil.json` lien arrête la commande avant tout appairage (1). Une création se fait avec le drapeau `wx`.

Sortie `--json` : `{ etat: "installe", depot, type, serveur, projet, page, connexion: { etat: "deja" | "branche", nom, role, pour? }, fichiers: [{ fichier, action, detail? }], ancienSite, publication: { etat: "publie" | "deja" | "saute" | "sans_exporteur" | "echec", build?, page?, resume?, message?, code? }, aCommiter, aFaire, veille, veilleVerifier, avertissements }`, où `action` ∈ `cree`, `ajoute`, `remplace`, `complete`, `inchange`, `saute`, `refuse` (lien symbolique ou jonction), `mal-forme`.

## Veille sur le poste du code : `outil veille` (étape 3.5)

Un membre clique « Traiter les retours » dans la méta-interface ; la veille, lancée **une fois par l'humain** sur le poste du code, prend la demande et lance l'agent qu'il a configuré. Le code ne quitte pas le poste.

- **Jeton** : celui du projet (`jetons.json` ou `OUTIL_JETON`), de rôle `agent` (vérifié par `/session`) ; mainteneur ou absent : 4.
- **Commande** : ce qui suit `--` (ni `--json` ni `--aide` placés après `--` ne sont lus par la veille). Avec `--memoriser`, elle est gardée dans `veille.json` (fichier utilisateur, indexé par le chemin de `.outil.json`) et `outil veille` seul la reprend. Elle ne vient **jamais** de `.outil.json` : un commit suffirait sinon à faire lancer n'importe quoi sur le poste à chaque clic. Sans commande : usage (2), avec l'exemple Claude Code. Un argument qui ressemble à un jeton est refusé (2), jamais mémorisé. La commande est vérifiée **avant** de prendre une demande (introuvable : 1 ; refusée : 2).
- **Exemple Claude Code** (une exécution sans interface refuse toute commande hors de sa liste blanche, d'où la liste en entier) :
  ```
  outil veille --memoriser -- claude -p "Traite les retours du serveur en suivant AGENTS.md (traitement lancé par la veille)." --allowedTools "Bash(outil *)" "PowerShell(outil *)" Read Glob Grep Edit Write --disallowedTools "Bash(git *)" "PowerShell(git *)" Artifact ArtifactData
  ```
  Règle par défaut d'un traitement sans humain : lire et répondre aux retours, modifier les fichiers du projet, `outil publier` ; aucune commande `git` (ni commit, ni push, ni branche, ni stash…), ni ticket pris ou modifié, ni Artifact claude.ai. Toute commande `git` est refusée, par Bash comme par PowerShell : une règle `deny` l'emporte sur les `allow` d'un `.claude/settings.json` de projet (comportement documenté de Claude Code, non vérifié ici avec un vrai `claude`). Les modifications restent dans la copie de travail, à relire avant de commiter.
- **Boucle** : `POST /veille {poste}` toutes les 5 s (serveur injoignable : une ligne, puis nouvel essai ; 401/403 : sortie 4) ; une demande arrive : `prendre` (409 : un autre veilleur l'a prise, on continue) ; lancement par `spawn` **sans shell**, dans le dossier de `.outil.json`, entrée standard fermée, environnement courant plus `OUTIL_DEMANDE=<id>` et, sous Windows, `NoDefaultCurrentDirectoryInExePath=1`, **aucun jeton ajouté** (l'agent passe par `outil`, qui lit `jetons.json`). Battement toutes les 15 s avec la fin de la sortie (2 000 caractères), et un dernier à la fin de l'agent, avant `terminer` (sinon le journal perd la fin des sorties, et tout pour un agent de moins de 15 s ; pas pour une demande perdue). `annuler` : arrêt de l'arbre de processus (`taskkill /PID <pid> /T /F` sous Windows, groupe de processus ailleurs), puis `terminer annulee` « annulée depuis l'interface ». Fin : code 0 → `terminee`, sinon `echouee` « code de sortie N » ; `resume` : les 4 000 derniers caractères de la **sortie standard** (METHODE § 6.8 : le résumé de l'agent), suivis, sauf en `terminee`, de la fin de la sortie d'erreur sous « --- sortie d'erreur --- » ; le journal des battements a les deux sorties. `--delai-max` (3 600 s) : arrêt, `echouee` « délai dépassé ». Un 409 au battement (demande finie côté serveur, par ex. « veilleur perdu ») : l'agent est arrêté, sans `terminer`.
- **Dépôt changé pendant le traitement** : avant de lancer l'agent et après sa fin (quelle qu'elle soit), la veille relève l'état Git du dossier de `.outil.json` : `rev-parse HEAD`, `symbolic-ref HEAD` (un changement de branche sur le même commit), le dernier mouvement du reflog de HEAD et leur nombre (`reflog -n 1`, `rev-list --walk-reflogs --count HEAD` : un commit suivi d'un `reset --hard` laisse HEAD et les refs comme avant, pas le reflog), `for-each-ref` (toutes les refs) et `stash list`, en lecture seule (`--no-optional-locks`), `git` résolu dans le `PATH`. Si HEAD, la branche, le reflog, une ref hors `refs/remotes` ou les stashs ont changé, la demande se termine quand même, mais le résumé commence par « ⚠ Le dépôt a changé pendant le traitement (commit, branche ou stash) : vérifie avant de pousser. » (le reste est coupé d'autant : 4 000 caractères en tout), la raison le dit (« dépôt changé pendant le traitement (commit, branche ou stash) », après « code de sortie N » s'il y en a un) et la veille affiche la même alerte. Si seules des refs `refs/remotes/*` ont changé (un `git fetch` de l'IDE ou du développeur, un push vers un remote nommé) : « ⚠ Des refs distantes (refs/remotes) ont changé pendant le traitement (fetch ou push) : vérifie qu'aucun push n'a été fait. », raison « refs distantes changées pendant le traitement (fetch ou push) ». Limite : un push vers une URL (sans remote nommé) d'un commit déjà présent en local ne laisse aucune trace dans le dépôt ; la protection reste la liste noire de la commande (`"Bash(git *)"`, `"PowerShell(git *)"`). Hors d'un dépôt Git, ou sans `git` : pas de contrôle.
- **Masquage** : tout `wdd_…` (quelle que soit sa longueur) et la valeur exacte des jetons connus sont remplacés par `wdd_…(masqué)` dans le journal et le résumé, sur toute la sortie gardée **avant** d'en couper la fin (couper d'abord pourrait séparer le préfixe `wdd_` du reste d'un jeton). Le serveur masque aussi.
- **`OUTIL_JETON` déjà défini** dans l'environnement de la veille : **laissé** à l'agent. Choix : l'agent en a besoin pour `outil` quand le jeton ne vient pas de `jetons.json` ; le retirer casserait ce cas sans rien protéger, puisque l'agent tourne avec les droits de la même personne. La veille n'ajoute jamais de jeton.
- **Windows** : la commande est cherchée dans le `PATH` avec `PATHEXT`. Un `.exe` ou un `.com` (cas de `claude` installé nativement) est lancé directement. Un `.cmd` ou un `.bat` (cas d'une installation par npm) passe par `cmd.exe /d /s /c "<ligne>"`, chaque argument entre guillemets, les barres obliques inverses finales doublées ; un argument (ou le chemin du script) qui contient `%`, `!`, `^`, `"`, `&`, `|`, `<`, `>` ou un retour à la ligne y est **refusé** (2), avec un message clair. Une autre extension est refusée.
- **Ctrl+C** : arrêt de l'agent en cours, `terminer echouee` « veille arrêtée », sortie 0 (un second Ctrl+C sort tout de suite, code 130).
- **Affichage** : une ligne par événement, à l'heure locale (`[14:03:27] demande … prise (demandée par Maud) : lancement de …`) ; la sortie de l'agent n'est pas recopiée (elle part dans le journal de la demande). Avec `--json`, les événements passent sur stderr et stdout reçoit à la fin `{ serveur, projet, poste, traitees: [{ id, etat, code_sortie, raison }] }`.
- **`--une-fois`** : traite une demande puis s'arrête (tests, essais).
- **Commande reprise** : la ligne de démarrage donne la date de sa mémorisation (« commande mémorisée le 24/11/2026 10:02 : … ») : une commande changée à l'insu du développeur se voit.
- **Lancé par la veille** (`OUTIL_DEMANDE` défini) : `outil veille`, `outil brancher`, `outil installer`, `outil connexion` et `outil importer-artifact --autoriser` sont **refusés** (2). Un agent qu'un retour piégé pousserait à remplacer la commande mémorisée (`veille.json`, hors de la copie de travail que le développeur relit) ou à demander un appairage ne le peut donc pas ; les autres commandes (`statut`, `retours`, `publier`, `aide`…) marchent.

## Exemples de sortie `--json`

Forme des sorties (valeurs abrégées par « … »), relevée sur un serveur de test.

`outil connexion --serveur http://127.0.0.1:8080 --projet jardin --json < jeton.txt`
```json
{ "serveur": "http://127.0.0.1:8080", "projet": "jardin", "role": "agent", "nom": "Agent",
  "configuration": "C:\\dev\\jardin\\.outil.json", "configurationCreee": true,
  "fichierJetons": "C:\\Users\\moi\\AppData\\Roaming\\outil\\jetons.json" }
```

`outil brancher --serveur http://127.0.0.1:8080 --projet jardin --json`, sans terminal (premier temps)
```json
{ "etat": "attente", "code": "HK7P-3MZQ", "url": "http://127.0.0.1:8080/appairage?code=HK7P-3MZQ", "expire": "2026-11-24T10:42:07.512Z",
  "relance": "outil brancher --attendre --serveur http://127.0.0.1:8080 --projet jardin" }
```

`outil brancher --attendre --serveur http://127.0.0.1:8080 --projet jardin --json`, après le clic
```json
{ "etat": "branche", "serveur": "http://127.0.0.1:8080", "projet": "jardin", "role": "agent", "nom": "Agent · PC-BUREAU",
  "pour": { "id": "maud", "nom": "Maud" }, "configuration": "C:\\dev\\jardin\\.outil.json", "configurationCreee": true,
  "fichierJetons": "C:\\Users\\moi\\AppData\\Roaming\\outil\\jetons.json" }
```

`outil publier --json`
```json
{ "build": 4, "octets": 73120, "page": "http://127.0.0.1:8080/p/jardin/", "resume": "OK 71 Ko · … · notes : 2 fichier(s), …", "avertissements": [],
  "serveur": "http://127.0.0.1:8080", "projet": "jardin",
  "notes": { "dossier": "C:\\dev\\jardin\\tools\\site-retours", "envoyees": ["notes_2026-11-24.json"], "identiques": ["notes_2026-11-23.json"], "differentes": [] },
  "exporteur": { "commande": ["node", "tools/site-retours/export.mjs", "--out=C:\\Users\\moi\\AppData\\Local\\outil\\travail\\jardin\\data.json"],
    "dossier": "C:\\dev\\jardin", "data": "C:\\Users\\moi\\AppData\\Local\\outil\\travail\\jardin\\data.json" } }
```

`outil installer --serveur http://127.0.0.1:8080 --projet jardin --json`, sans terminal (premier temps)
```json
{ "etat": "attente", "depot": "C:\\dev\\jardin", "code": "HK7P-3MZQ", "url": "http://127.0.0.1:8080/appairage?code=HK7P-3MZQ",
  "expire": "2026-11-24T10:42:07.512Z", "relance": "outil installer --serveur http://127.0.0.1:8080 --projet jardin --oui" }
```

`outil installer --serveur http://127.0.0.1:8080 --projet jardin --oui --json` (la relance), après le clic
```json
{ "etat": "installe", "depot": "C:\\dev\\jardin", "type": "godot", "serveur": "http://127.0.0.1:8080", "projet": "jardin", "page": "http://127.0.0.1:8080/p/jardin/",
  "connexion": { "etat": "branche", "nom": "Agent · PC-BUREAU", "role": "agent", "pour": { "id": "maud", "nom": "Maud" } },
  "fichiers": [ { "fichier": "AGENTS.md", "action": "cree" }, { "fichier": ".claude/skills/site-retours-outil/SKILL.md", "action": "cree" },
    { "fichier": "CLAUDE.md", "action": "ajoute" }, { "fichier": ".outil.json", "action": "cree" } ],
  "ancienSite": { "dossier": "tools/site-retours", "notes": true, "exporteur": true },
  "publication": { "etat": "publie", "build": 1, "page": "http://127.0.0.1:8080/p/jardin/", "resume": "OK 71 Ko · … · notes : 1 fichier(s), …" },
  "aCommiter": [ ".claude/skills/site-retours-outil/SKILL.md", ".outil.json", "AGENTS.md", "CLAUDE.md" ],
  "aFaire": [ "AGENTS.md : remplir la ligne « vérifier sans écrire dans les données » (…)", "reprendre les retours de l'ancien site claude.ai (…)" ],
  "veille": "outil veille --memoriser -- claude -p \"Traite les retours …\" …", "avertissements": [] }
```

`outil veille --une-fois --json -- node outils/agent.mjs`
```json
{ "serveur": "http://127.0.0.1:8080", "projet": "jardin", "poste": "PC-BUREAU",
  "traitees": [ { "id": "Qm3x…", "etat": "terminee", "code_sortie": 0, "raison": "" } ] }
```

`outil methode --chemin --json` : `{ "chemin": "C:\\Outils\\Vaevia\\methode\\METHODE.md" }` (sans `--chemin` : `{ chemin, texte }`).

`outil statut --json`
```json
{ "serveur": "http://127.0.0.1:8080", "projet": "jardin", "role": "agent", "nom": "Agent",
  "retours": { "total": 3, "parStatut": { "nouveau": 2, "pris": 0, "question": 0, "fait": 1, "refuse": 0 } },
  "disciplines": [ { "nom": "programmation", "libelle": "Programmation" } ],
  "rev": "6f0c…", "build": { "build": 2, "date": "2026-11-23T16:40:12.311Z", "octets": 73120 },
  "page": "http://127.0.0.1:8080/p/jardin/" }
```

`outil retours liste --statut nouveau --json` (sans `--dossier` : `<travail>/retours`)
```json
{ "docs": [ { "id": "Ab12…", "version": 1, "donnees": { "kind": "plante", "ref": "tomate", "status": "nouveau", "…": "…" } } ],
  "rev": "6f0c…", "dossier": "C:\\Users\\maud\\AppData\\Local\\outil\\travail\\jardin\\retours", "ecrits": 1, "retires": 0 }
```

`outil retours voir Ab12… --json` : `{ "id", "version", "donnees" }`.

`outil retours repondre --lot lot.json --json`
```json
{ "versions": [ { "id": "Ab12…", "version": 2 } ], "rev": "91d2…", "heure": "2026-11-23T16:41:03.527Z" }
```
Sur un conflit (sortie 3) :
```json
{ "erreur": { "sortie": 3, "message": "conflit : le retour Ab12… a changé depuis la lecture (version 2 sur le serveur). …",
  "statut": 409, "code": "conflict", "document": { "id": "Ab12…", "version": 2, "donnees": { "…": "…" } }, "index": 0, "id": "Ab12…" } }
```

`outil export envoyer data.json --json`
```json
{ "build": 3, "octets": 73120, "page": "http://127.0.0.1:8080/p/jardin/",
  "resume": "OK 71 Ko · 3 onglets · 9 éléments (…) · notes : 2 fichier(s), 8 nouveautés, 0 mesures, 2 points à valider",
  "avertissements": [] }
```

`outil notes envoyer notes_2026-11-23.json --json` : `{ "nom": "notes_2026-11-23.json", "rev": "a3b4…", "cree": true, "inchange": false, "avertissements": [] }`

`outil notes liste --json` : `{ "notes": [ { "nom": "notes_2026-11-23.json", "date": "2026-11-23", "titre": "Retours du 22/11", "jalons": ["J1", "J2"], "octets": 812 } ], "rev": "a3b4…" }`

`outil notes voir notes_2026-11-23.json --json` : `{ "nom": "notes_2026-11-23.json", "notes": { "title": "…", "milestones": { "J1": "…" }, "commits": { "J1": "…" }, "changes": […], "validations": […] } }`

`outil tickets creer --titre "Créneaux du forum : ouverture à 7 h 30" --retours xECM…,b1E2… --pages salle:forum --critere "…" --critere "…" --json` : `{ "id": "T-1", "version": 1, "rev": "bb88…" }`

`outil tickets prendre T-1 --json` : `{ "id": "T-1", "version": 2, "rev": "1444…" }` (déjà tenu par toi : `"inchange": true`, rien d'écrit). `outil tickets rendre T-2 --json` : même forme.

`outil tickets liste --miens --json` et `outil tickets voir T-1 --json` : `{ "docs": [ { "id", "version", "donnees" } ], "rev" }` et `{ "id", "version", "donnees" }`, où `donnees` est le ticket :
```json
{ "id": "T-1", "titre": "Créneaux du forum : ouverture à 7 h 30", "statut": "pris", "discipline": "",
  "pris_par": { "type": "agent", "id": "2Guw…", "nom": "Agent", "pour": { "id": "alex", "nom": "Alex" } },
  "retours": ["xECM…", "b1E2…"], "pages": ["salle:forum"],
  "criteres": [ { "texte": "une demande à 7 h 45 est acceptée", "fait": true }, { "texte": "une demande à 7 h 15 est refusée", "fait": false } ],
  "commits": [ { "hash": "b08dd295cf95acd9149745c1cb17276a6bc73bc9", "depot": "code", "message": "T-1 : ouverture à 07:30" } ],
  "auteur": { "type": "agent", "id": "2Guw…", "nom": "Agent", "pour": { "id": "alex", "nom": "Alex" } },
  "cree": "2026-11-23T20:04:33.210Z", "modifie": "2026-11-23T20:04:34.511Z", "description": "Le forum ouvre à 8 h ; l'équipe demande 7 h 30." }
```

`outil tickets commit T-1 HEAD --json`
```json
{ "id": "T-1", "version": 3, "ajoutes": 1, "inchange": false, "reessai": false, "rev": "2589…",
  "commits": [ { "rev": "HEAD", "hash": "b08dd295cf95acd9149745c1cb17276a6bc73bc9", "depot": "code", "message": "T-1 : ouverture à 07:30" } ] }
```

`outil tickets critere T-1 1 --fait --json` : `{ "id": "T-1", "numero": 1, "texte": "une demande à 7 h 45 est acceptée", "fait": true, "version": 4, "rev": "8eab…" }`

`outil tickets revue T-1 --json` : `{ "id": "T-1", "statut": "en-revue", "version": 5, "rev": "b2b3…" }`

Ticket tenu par un autre (sortie 3) :
```json
{ "erreur": { "sortie": 3, "message": "T-3 est tenu par Camille (pris) : il n'est pas à toi. Rien n'a été écrit. Ne force jamais : …",
  "statut": 409, "code": "conflict", "document": { "id": "T-3", "version": 2, "donnees": { "…": "…" } } } }
```

`outil importer-artifact ./export --json`
```json
{ "dossier": "C:\\…\\export\\retours", "fichiers": 4, "lots": 1,
  "importes": [ { "origine": "ImportA1", "id": "ImportA1" }, { "origine": "import-b-2", "id": "q7Xc…" } ],
  "ignores": [], "refuses": [ { "origine": "ImportC3", "fichier": "ImportC3.json", "raison": "status inconnu : fini" } ] }
```

## Tests

```sh
WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"      # depuis la racine ; ou « npm test » dans cli/
```

Chaque test démarre un vrai serveur de test (comme `serveur/test/`) et lance la CLI en sous-processus, avec `APPDATA`, `HOME`, `USERPROFILE` et `XDG_CONFIG_HOME` dans le dossier temporaire et sans `OUTIL_JETON` hérité : le vrai fichier de jetons n'est jamais touché.

Étape 3.5 (`test/brancher.test.ts`, `test/publier.test.ts`, aides dans `test/aide-cli.ts`) : `LOCALAPPDATA`, `XDG_DATA_HOME` et `XDG_CACHE_HOME` aussi dans le dossier temporaire (l'installation locale et le dossier de travail réels ne sont jamais lus), et **`OUTIL_TEST_NAVIGATEUR=<fichier>`** dans l'environnement de chaque test : l'URL d'appairage est ajoutée à ce fichier au lieu d'ouvrir un navigateur (variable réservée aux tests). Le clic « Autoriser » est fait par une session de test contre le vrai serveur (`intervalleAppairageMs: 100`) ; le mode « dans un terminal » est lancé dans le processus du test, avec `terminal: true` dans le contexte de `principal()` ; `slow_down` est vérifié contre un serveur factice. Les sorties sont vérifiées sans jeton ni code d'appareil.

Étape 3.6 (`test/apercu.test.ts`) : **`OUTIL_TEST_APERCU`** (variable réservée aux tests) remplace le navigateur : un chemin de fichier y reçoit une ligne JSON par capture demandée (URL, largeur, thème) et chaque capture est une image PNG de 1 px ; `aucun` simule l'absence de navigateur. Le vrai lancement est vérifié avec une copie de `node` donnée par `OUTIL_NAVIGATEUR` (elle refuse `--headless=new` et s'arrête : sortie 0 et avertissement, profil retiré) ; arguments et environnement du navigateur vérifiés sans jeton. Aussi : l'avertissement « image écrite comme du texte » du build, de `site/build.js` jusqu'à `outil export envoyer` (un retour à la ligne dans une donnée ne forge pas de ligne « attention : » ; un `res://` de scène ou de script n'est pas une image) ; la CSP posée en `<meta>` ; un dossier « profil-navigateur » de l'humain gardé ; un serveur avec `WDD_URL_PAGES` (aperçu par l'API) et un serveur sans la route. Un groupe lance le **vrai** Edge ou Chrome du poste (sauté s'il n'y en a pas) sur une page piégée servie par un faux serveur : script non haché bloqué, aucune requête réseau, image et cadre de fichiers locaux bloqués, script haché exécuté, 40 images cassées en bas de page comptées à chaque capture.

`test/installer.test.ts` : dépôts Git temporaires (`git init`, un commit) ; HEAD, index et branches comparés avant et après (aucune écriture Git) ; deux temps sans terminal, idempotence, trois cas d'`AGENTS.md` (CRLF et BOM gardés, ligne « vérifier sans écrire » gardée), `CLAUDE.md` et raccourci, `--oui`, questions O/N (dans le processus du test, `terminal: true` et une fonction `question` qui répond), refus hors Git et du dépôt de l'outil, ancien `tools/site-retours` avec un faux `export.mjs` (réussite, puis échec rapporté). `test/veille.test.ts` : faux agent Node (succès, avec le journal final complet, échec, dépôt changé : commit, branche, stash, commit puis `reset --hard`, et sur le clone d'un dépôt nu `fetch` seul, `push origin` seul, push vers une URL puis `reset --hard`, annulation avec un petit-enfant dont l'arrêt est vérifié, délai, Ctrl+C par le signal `arret` du contexte, `--memoriser`, jeton mainteneur refusé, masquage par la CLI, environnement sans jeton ajouté) et, sous Windows seulement, un faux `.cmd` trouvé par `PATH`/`PATHEXT` (arguments de l'exemple Claude intacts ; `&` refusé). **`OUTIL_TEST_VEILLE_MS=<interrogation>,<battement>`** (millisecondes, variable réservée aux tests) raccourcit les intervalles de 5 s et 15 s. Relecture du lot : `test/lancement.test.ts` (environnement des enfants, chemin absolu d'`explorer.exe`, et sous Windows un faux `git.exe` posé dans le dépôt et un `node.bat` du dossier courant face à `outil.cmd`, jamais lancés), et dans les autres fichiers : faux `taskkill.exe` et `node.bat` dans le dossier de `.outil.json` (veille, agent `.cmd`), `Outil_Jeton` jamais transmis à l'exporteur, refus sous `OUTIL_DEMANDE`, liens et jonctions, `.outil.json` sans projet, relances (options gardées, appairage en cours avant `installation.json`, refus et mauvais projet), `jetons.json` illisible ou non inscriptible. Les faux programmes sont des copies de `node.exe` qui n'écrivent que dans un fichier témoin (`aide-cli.ts`, `fauxProgrammes`), lancées par un sous-processus de la CLI dont l'environnement n'a pas `NoDefaultCurrentDirectoryInExePath`.
