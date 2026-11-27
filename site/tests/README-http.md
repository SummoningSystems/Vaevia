# Scénarios de régression contre le serveur (adaptateur `http`)

`site/tests/scenarios.js`, **inchangé**, rejoué contre le vrai serveur de l'étape 1 (`serveur/`) avec l'adaptateur `site/retours/stockage-http.js` (critère 2 de [docs/etape1-serveur.md](../../docs/etape1-serveur.md) § 6).

```
sh site/tests/lancer-http.sh <dossier de sortie hors dépôt> [mode ...]
```

Attendu : `TOUT PASSE`, avec 82 vérifications PASS sur 10 modes rejoués (normal 62, readonly 3, denywrite 2, quota 1, unavailable 1, revoked 3, snapretry 2, silent 3, offline 3, nodb 2). Le mode `nouser` est sans objet en HTTP (voir plus bas). Il faut Node 24, Git et Edge ou Chrome ; comptez environ 30 s, dont 11 s pour `silent`.

`WDD_BANC_LENTEUR=<ms>` fait attendre chaque commit des projets d'essai (crochet `pre-commit`). Cela éprouve la cale sur un serveur lent ; les 82 PASS tiennent à 300 ms et à 1 s par commit.

## Déroulé (`lancer-http.js`)

1. **Serveur de test.** `node serveur/src/principal.ts` est lancé avec `WDD_TEST=1`, un port libre (`WDD_PORT=0`) et les données dans `<sortie>/donnees`, effacé au départ.
2. **Compte admin.** Le lien d'invitation admin affiché au démarrage est consommé (`POST /invitation/<jeton>`) ; on obtient le cookie admin.
3. **Préparation de chaque mode**, dans un projet `essai-<mode>` :
   - création par `POST /api/admin/projets` ;
   - notes de l'exemple par `POST /__test/notes`, car aucune API ne les écrit encore à l'étape 1 ;
   - build de `site/examples/data.json` par `POST /api/p/<projet>/builds` (le serveur lance `build.js --stockage=http` avec `notes/` du dépôt) ;
   - état du mode par `POST /__test/mode`, et le retour d'un autre lecteur pour `readonly`.
4. **Edge sans fenêtre, piloté par le protocole DevTools.**
   - Chaque mode a un contexte de navigation neuf (cookies et `sessionStorage` vides).
   - La cale `cale-http.js` puis `scenarios.js` sont injectés par `Page.addScriptToEvaluateOnNewDocument`, donc avant tout script de la page, comme le faux `window.claude` du banc.
   - La navigation passe par `/__test/connexion`, qui pose le cookie de session du compte `essai` puis redirige vers la vraie page `/p/<projet>/`, servie avec sa CSP.
   - Le serveur n'injecte rien : une page servie normalement ne contient jamais la cale.
5. **Résultats.** Ils sont lus dans `<pre id="__results">` (PASS, FAIL, INFO), comme avec `lancer.sh`. La ligne `INFO cale` donne le nombre de minuteurs retenus et le nombre de ceux partis au plafond. Ce dernier doit rester à 0 : sinon une ligne `FAIL cale : N minuteur(s) partis au plafond` est ajoutée et le mode est en échec (un instantané attendu après une écriture n'est jamais arrivé ; la cale l'aurait masqué, les scénarios ne le vérifiant pas toujours par le DOM). Témoin : sans diffusion après une modification, le mode `normal` donne `FAIL cale : 10 minuteur(s)…` et « DES ÉCHECS ».
6. **Fin.** `<sortie>/git_log_normal.txt` reçoit l'historique du projet `essai-normal` : un commit par écriture, avec son auteur (critère 5). Le navigateur et le serveur sont arrêtés, même après un échec.

Fichiers écrits dans `<sortie>` : `serveur.log`, `dom_<mode>.html`, `page_http_offline.html`, `git_log_normal.txt`, `donnees/` et `edge_http/` (profil du navigateur). Rien n'est écrit dans le dépôt.

## La cale `window.__T`

| Banc (`banc_essai.js`) | Cale HTTP |
|---|---|
| `T.docs.get/has/entries/keys/values/forEach/size` | XHR synchrone `GET /__test/retours` : l'état du serveur, sans effet des modes ; seules les `donnees` sont rendues |
| `T.docs.set(id, d)`, `T.put(id, d)` | `POST /__test/mettre` : écrit tel quel, version +1, commit, diffusion |
| `T.docs.delete(id)` | `POST /__test/supprimer { diffuser: false }` : comme le banc, sans instantané |
| `T.writeServer(id, champs)` | `POST /__test/ecrire` : fusion, version +1, commit, diffusion |
| `T.emit()` | `POST /__test/diffuser` |
| `T.version` | versions du serveur, lues comme `T.docs` |
| `T.log` | rempli depuis les vraies requêtes de la page : `["add", document]`, `["update", id, champs]`, `["delete", id]` |
| `T.errors`, `T.mode` | comme le banc |

**Le temps.** Le banc répond en quelques millisecondes. Ici, un commit prend des dizaines de millisecondes, parfois plus, alors que les scénarios n'attendent que 10 à 150 ms après une écriture. La cale retient donc les minuteurs de la page (`setTimeout`) tant que le serveur n'a pas fini, c'est-à-dire tant que :
- une requête `fetch` de la page est en vol, jusqu'à la lecture de son corps ;
- ou un flux est ouvert et l'instantané de la dernière écriture diffusée, reconnu à son `rev`, n'y est pas encore arrivé.

Les minuteurs retenus repartent ensuite dans l'ordre de leurs échéances. Garde-fous :
- **plafond** : 5 s par minuteur ;
- **un instantané n'est attendu que si un flux est ouvert ou en connexion**, et seulement après une écriture diffusée : rien n'est attendu en `silent` (aucune écriture), ni en `revoked` et `nodb` (flux fermés). Une requête en vol retient toujours, jusqu'à la lecture de son corps ;
- **une écriture refusée** n'attend aucun instantané ;
- **premier instantané** : il est attendu seulement dans les modes où le flux répond tout de suite. Ce n'est pas le cas de `snapretry`, où il dépend d'un minuteur du module.

## Modes

| Mode | En HTTP | PASS (base) |
|---|---|---|
| `normal` | rejoué | 62 (62) |
| `readonly` | rejoué : `/__test/mode readonly`, donc session avec `ecriture: false` ; retour d'un autre lecteur posé par `/__test/mettre` (id `seedro`, le banc dit `seed-ro`, que la forme des ids refuse) | 3 (3) |
| `denywrite` | rejoué : `ecriture: null`, puis un POST refusé en 403 `permission_denied`, ce qui met la page en lecture seule | 2 (2) |
| `quota` | rejoué : 507, donc `quota_exceeded` | 1 (1) |
| `unavailable` | rejoué : 503, donc `unavailable` | 1 (1) |
| `revoked` | rejoué : un instantané, flux coupé ~50 ms après, puis `/session` en 401, donc `revoked` | 3 (3) |
| `snapretry` | rejoué : premier flux en 503, `unavailable`, relance unique du module, le second flux marche | 2 (2) |
| `silent` | rejoué : le flux reste ouvert sans réponse ; message « ne répondent pas encore » au bout de 10 s | 3 (3) |
| `offline` | rejoué : la page servie (enveloppe et `wdd-api` compris), enregistrée, puis ouverte en `file://` ; l'adaptateur répond `"file"` | 3 (3) |
| `nodb` | rejoué : session finie alors que la page est déjà servie. Le harnais déclenche le mode `revoked` avant d'ouvrir la page (un flux ouvert puis coupé), si bien que tout `/api/p/<projet>/*` répond 401 alors que `/p/<projet>/` est encore servie. `/session` répond 401, donc `{ horsLigne: "nodb" }` | 2 (2) |
| `nouser` | **sans objet** (raison ci-dessous) | — (1) |

**Pourquoi `nouser` est sans objet.**
- **Ce que vérifie le banc.** Une base présente mais sans identité (`use("user")` nul) : le retour créé a `by === ""`, et un retour sans auteur est supprimable par tous.
- **Pourquoi ce cas n'existe pas avec le serveur.** Le serveur ne sert la page et l'API qu'à une session ou à un jeton, qui ont toujours un compte ; il réécrit `by` à partir de la session (§ 3.1) et ne laisse jamais un retour sans auteur. Sans session, on obtient `nodb`, qui est rejoué.
- **Ce qui couvre le même chemin.** Côté page, il passe par `identite.id === null`, que l'adaptateur ne produit que si le serveur renvoyait un `id` vide. Les tests du serveur (`node --test`) couvrent la réécriture de `by`.

Total HTTP : 82 PASS, contre 83 pour la base ; l'écart est la vérification de `nouser`.

## Ce que les scénarios n'exercent pas

Chaque mode part d'un contexte de navigation neuf, sans version périmée. Deux chemins de l'adaptateur échappent donc aux scénarios :
- la copie livrée en `depuisCache: true` avant la réponse ;
- le 409 dont le `document` est livré tout de suite.

Ils ont été vérifiés à part le 23/11, par un essai ponctuel dans Edge piloté par DevTools (hors dépôt) :
- **Nouvel abonnement** : `[true, false]`.
- **Rechargement de la page** : le module reçoit d'abord la copie de `sessionStorage`, puis la réponse.
- **`modifier` avec une version périmée** : rejet `conflict` avec `document` en version 2, livré avant le rejet dans un instantané `depuisCache: false`.
- **Avec la bonne version** : succès.
