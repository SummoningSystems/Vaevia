# Contrat de stockage des retours

Ce contrat sépare le **module retours** (`retours.js` : boutons, tiroir, formulaire, listes, modes dégradés) de **l'endroit où les retours sont gardés**. Un adaptateur le satisfait :

| Adaptateur | Fichier | État |
|---|---|---|
| `artifact` | `stockage-artifact.js` | fait : base d'un Artifact claude.ai (`window.claude`, contrat db/user 0.2.96), comportement identique au gabarit d'origine, sauf un écart voulu : un `db.collection()` qui lève donne `"nodb"` au lieu d'une page sans boutons (§ 2) |
| `http` | `stockage-http.js` | fait (étape 1) : serveur Git (`serveur/`), versions par document, refus 409, mises à jour en direct par SSE ; scénarios rejoués par `site/tests/lancer-http.sh` |
| `memoire` | à venir | tests sans navigateur claude.ai ni serveur |

Le build choisit l'adaptateur (`node site/build.js … --stockage=<nom>`, `artifact` par défaut) et l'injecte dans la page à côté du module. Le module ne connaît que ce contrat : il ne référence jamais `window.claude` ni une URL de serveur. Un nouvel adaptateur doit pouvoir s'écrire **sans modifier `retours.js`** ; c'est le critère de ce document.

Les mots en `code` sont les noms exacts de l'interface.

## 1. Forme d'un adaptateur

Un fichier JavaScript autonome (aucune dépendance, aucun `import`, il est injecté dans un `<script>` en ligne) qui définit **`window.RetoursStockage`** :

```js
window.RetoursStockage = {
  nom: "artifact",              // texte, pour les messages du build
  textes: { … },                // facultatif : libellés propres à ce stockage (voir § 8)
  async connecter() { … },      // voir § 2 ; appelé une seule fois, au démarrage du module
};
```

Contraintes de fichier : pas de `<!--` ; `</` est réécrit `<\/` par le build (sans effet dans une chaîne, un gabarit littéral, une expression régulière ou un commentaire) ; la page construite est vérifiée par une compilation de chaque script ; aucune ressource externe (`<script src>`, `<link>`, `@import`, `url(http…)`), le build le refuse.

**Configuration.** `connecter()` ne reçoit aucun argument et le build injecte le fichier tel quel : l'adaptateur déduit sa configuration de la page elle-même, de `location` (le serveur sert la page, l'API est à côté : `new URL("api/…", location.href)`) ou d'une balise `<meta>` posée par le serveur qui sert la page (jeton CSRF, id du projet). Rien n'est écrit en dur pour un projet.

## 2. `connecter()`

Appelé par le module juste après l'affichage de la page. Résout l'**un** des deux résultats suivants (un rejet est traité comme `{ horsLigne: "nodb" }`) :

**Pas de stockage pour cette visite** : `{ horsLigne: "file" | "nodb" }`

| Valeur | Sens | Ce que fait le module |
|---|---|---|
| `"file"` | la page n'est pas servie par son stockage (fichier local, capture) | boutons visibles, tiroir avec message « ouvre la page publiée », note `offline` sous les onglets ; ni barre ni bouton flottant |
| `"nodb"` | le stockage existe mais pas pour ce lecteur (déconnecté, pas d'accès) | idem avec le message `unavailable` ; aucun message « fichier » |

Toute autre valeur vaut `"nodb"`.

**Stockage branché** : `{ identite, retours }`

- `identite` (§ 3) : qui écrit ;
- `retours` (§ 4) : la collection des retours de cette page.

Le module affiche alors la barre (« Remarque générale », « Tous les retours ») et le bouton flottant, puis s'abonne (§ 5).

Pour `artifact` : `use("db")` est attendu d'abord ; `null` ou une erreur donne `"nodb"` si `window.claude` existe, `"file"` sinon. `use("user")` n'est demandé que si la base existe. Écart voulu avec le gabarit d'origine : si `db.collection("retours")` lève, l'ancien gabarit restait sans boutons, sans barre et sans note (sa promesse de démarrage était rejetée) ; ici le rejet de `connecter()` donne `"nodb"`.

## 3. Identité

```js
identite = {
  id: "…" | null,             // identifiant opaque et stable du lecteur ; null si inconnu
  proprietaire: true | false, // vrai seulement si c'est sûr
  ecriture: true | false | null, // droit d'écrire des retours ; null = inconnu
}
```

- `id` n'est jamais affiché ; il est écrit dans le champ `by` des retours créés et sert à proposer « Supprimer » sur ses propres retours (`by === id`). Sans `id`, seuls les retours sans auteur (`by === ""`) sont supprimables, sauf pour le propriétaire.
- `proprietaire` : peut supprimer tous les retours (côté page ; le stockage reste juge).
- `ecriture === false` : lecture seule d'emblée (pas de formulaire, ni « Répondre », ni « Supprimer »). `null` : le formulaire est proposé, et le premier refus d'écriture fait passer en lecture seule (§ 6).
- Une identité partielle est permise : un champ illisible garde sa valeur par défaut (`null`, `false`, `null`).

| | `artifact` | `http` |
|---|---|---|
| `id` | `user.id()` | id du compte de la session |
| `proprietaire` | `user.isOwner()` | rôle `mainteneur` ou `admin` |
| `ecriture` | `user.can("data.write")` (`true`, `false` ou inconnu) | rôle ≥ `contributeur` |

## 4. Collection `retours`

```js
retours = {
  async ajouter(donnees)              -> { id }        // crée un retour
  async modifier(id, champs, options) -> rien          // fusionne champs dans le retour id
  async supprimer(id, options)        -> rien          // supprime le retour id
  ecouter(suivant, erreur)            -> désabonner()  // § 5
}
options = { version }   // facultatif : la version connue du document (§ 7) ; absente si le stockage n'en donne pas
```

- `id` : **texte non vide**, partout (rendu par `ajouter`, passé à `modifier` et `supprimer`, livré dans les instantanés). Le module relit les ids dans des attributs HTML et les compare avec `===` : un stockage à ids numériques (SQLite) les convertit en texte. Le module convertit aussi, par prudence, les ids des instantanés en texte : il passe donc toujours un id texte à `modifier` et `supprimer`.
- `ajouter(donnees)` reçoit un document complet (§ 9) ; l'id est choisi par le stockage. Le module n'utilise pas la valeur rendue et attend l'écoute pour afficher le retour.
- `modifier(id, champs)` fusionne (les autres champs restent). Le module n'envoie que `text`, `status` et `updated`. Un retour absent est une erreur (§ 6), jamais une création.
- `supprimer(id)` : supprimer un retour déjà absent peut réussir ou échouer, le module redessine la liste dans les deux cas (et ne dit rien, sauf sur `conflict`, § 6).
- `options` n'est **jamais** mêlé aux champs du document : un adaptateur sans versions l'ignore.
- Toute erreur est un rejet d'un objet portant `code` (texte) ; voir § 6.
- **Facultatif (étape 3.7, R1) : `async ajouterSerie(liste) -> { ids }`.** Crée d'un coup les retours de `liste` (documents complets, § 9 ; 50 au plus), tout ou rien ; `ids` dans l'ordre de la liste. Seulement si l'adaptateur la fournit, le module propose « Commencer une série » : les nouveaux retours restent en brouillon dans le navigateur (`localStorage`, par page et par lecteur), puis « Envoyer la série » appelle `ajouterSerie`. L'adaptateur `http` la fournit (`POST <api>/retours/serie`, un commit) ; l'adaptateur `artifact` ne la fournit pas, et rien ne change pour lui. Une erreur garde les brouillons. Libellé facultatif de l'adaptateur : `serieNext` (où demander le traitement après l'envoi).
- **Facultatif (étape 3.7, R2) : `async envoyerCapture(blob) -> { id }` et `urlCapture(id) -> adresse`.** Seulement si l'adaptateur fournit les deux, le formulaire d'un nouveau retour propose « Joindre une capture » (aussi par collage ou dépôt). Le module réencode l'image dans le navigateur (canvas, 1600 px au plus, WebP sinon PNG : sans métadonnées), l'envoie, puis met les ids dans le champ facultatif `captures` du document (§ 9), séparés par une espace, 3 au plus. Il affiche les vignettes de `urlCapture(id)`, qui est une adresse de même origine. L'adaptateur `http` les fournit (`POST <api>/captures`, `GET <api>/captures/<id>`) ; l'adaptateur `artifact` non, et rien ne change pour lui.
- **Facultatif (étape 3.9, L7) : `async tickets() -> [{ id, titre, statut, pages, lien }]`.** Les tickets du projet qui citent des éléments (`pages` : références `sorte:ref`). Seulement si l'adaptateur la fournit, le module ajoute une ligne « Tickets » sur chaque fiche citée (alias compris), au-dessus de son pied, avec un lien `lien` vers le ticket (adresse `http(s)` ou chemin local, sinon pas de lien). Titre et statut sont des données, échappés. L'adaptateur `http` la fournit (`GET <api>/tickets-fiches`, lecture seule, permise sur l'hôte des pages) ; l'adaptateur `artifact` non.
- **Facultatif (étape 3.9, lot 2) : `async noms() -> { id: nom }`, `async aussi(id, oui, options)`, `async fusionner(id, doublons, options)`.** `noms` : noms affichés des membres (jamais d'e-mail ; « ancien membre » pour un compte retiré), montrés comme auteur (« par … »), dans « Aussi : … » et dans le choix « Pour ». `aussi` : l'appelant s'ajoute aux « Moi aussi » d'un retour d'un autre (`oui`), ou s'en retire ; rien d'autre ne change. `fusionner` : un propriétaire fusionne `doublons` (`[{ id, version }]`) dans le retour `id` ; chaque doublon passe `fait` avec une réponse et `fusionne_dans`, et le principal reçoit leurs auteurs dans `aussi` ; tout ou rien. Chacune n'est proposée par le module que si l'adaptateur la fournit (`http` : `GET <api>/noms`, `POST|DELETE <api>/retours/<id>/aussi`, `POST <api>/retours/<id>/fusionner`) ; `artifact` ne les fournit pas. Champ visé (`field`) : la page marque un champ par `data-fb-field` (libellé) et `data-fb-valeur` (valeur affichée) ; un clic ouvre le formulaire de l'élément avec ce champ.
- **Facultatif (étape 3.9, E5) : `async approbations() -> [{ point, approuve_par, quand, build, … }]`.** Approbations nominatives des points « À valider » (le « Validé » d'un mainteneur ou d'un admin, calculé par le stockage). Le module ajoute « Approuvé par … · date · build n » sur chaque élément de sorte `validation` concerné, relu à chaque changement des retours (au plus toutes les 5 s). `http` : `GET <api>/approbations`. Ancienne version du Wiki (étape 3.9, L3) : la balise `<meta name="wdd-lecture-seule">`, posée par le serveur, met l'adaptateur `http` en lecture seule (`identite.ecriture: false`).

## 5. Écoute

`ecouter(suivant, erreur)` s'abonne aux retours de la page et rend une fonction de désabonnement. **Le module n'appelle jamais cette fonction**, même avant de se réabonner après une erreur (point 5) : avant d'appeler `erreur`, l'adaptateur ferme lui-même tout ce que cet abonnement a ouvert (`EventSource`, minuteurs, requêtes), sinon l'ancien flux resterait ouvert à côté du nouveau.

```js
suivant(instantane)
instantane = {
  docs: [{ id, donnees, version? }, …], // TOUTE la collection, à chaque appel (pas un delta)
  depuisCache: true | false,             // vrai : copie locale, la réponse du stockage n'est pas encore arrivée
}
erreur(e)   // e.code (§ 6) ; après une erreur, l'écoute est morte
```

Sémantique attendue, qui est celle du module :

1. **Cache puis réponse.** Un adaptateur peut livrer d'abord une copie locale (`depuisCache: true`), puis la réponse du stockage (`false`). Seul un instantané `depuisCache: false` prouve que le stockage répond. Un adaptateur sans cache livre directement `false`.
2. **Base muette.** Si aucun instantané `depuisCache: false` n'arrive dans les 10 s qui suivent l'abonnement, le module affiche « Les retours enregistrés ne répondent pas encore » (note sous les onglets et en tête de liste) ; le message disparaît à la première réponse.
3. **Après chaque écriture**, le stockage livre un nouvel instantané complet, y compris pour les écritures faites par d'autres (l'agent, un autre lecteur). C'est le seul chemin par lequel le module voit un retour créé, modifié ou supprimé : il ne modifie jamais sa liste de lui-même.
4. **L'id du stockage l'emporte** sur un éventuel champ `id` dans `donnees`.
5. **Erreur.** Après `erreur(e)`, le module considère l'écoute morte. Sauf si `e.code === "revoked"`, il rappelle `ecouter` **une seule fois**, 1,5 à 2,5 s plus tard (le compteur de 10 s repart). Une seconde erreur, ou `revoked`, rend les retours inaccessibles pour la visite (« recharge la page »). Un adaptateur doit donc accepter un second appel à `ecouter`, et ne signaler une erreur que lorsqu'il a renoncé (une reconnexion qu'il sait faire lui-même ne remonte pas).
6. Le retour de `suivant` et de `erreur` est ignoré ; ils ne lèvent pas d'exception en temps normal.
7. **Limite connue : pas d'état « reconnexion en cours ».** Le compteur de 10 s n'est armé qu'à l'abonnement (et à la relance) ; un instantané `depuisCache: true` reçu après une réponse ne le réarme pas, et la relance unique vaut pour toute la visite (elle n'est pas rendue après un instantané réussi). Pendant qu'un adaptateur se reconnecte seul (point 5), la page montre donc la dernière liste sans signaler qu'elle peut être périmée ; les écritures restent protégées par les versions (§ 7). C'est le comportement du gabarit d'origine, gardé à l'étape 0 ; un signal de liste périmée (par exemple un instantané `depuisCache: true` après une réponse, qui réarmerait le compteur) est à trancher avec l'adaptateur `http` (étape 1).

Pour `artifact` : `onSnapshot` de la collection `retours`, `depuisCache = !!snap.metadata?.fromCache` (un instantané sans `metadata` compte comme une réponse), `donnees = doc.data()`, aucune version.

Pour `http` :
- **Cache d'abord.** Au début de chaque abonnement, l'adaptateur livre la dernière liste connue, en mémoire ou dans `sessionStorage` (relance du module, rechargement dans le même onglet), avec `depuisCache: true`.
- **Flux.** Un `EventSource` sur `/flux` reçoit l'instantané complet à la connexion, puis après chaque commit du serveur ; chaque instantané est livré en `depuisCache: false`. Il n'y a pas de `GET` de la liste à part : la connexion au flux en tient lieu.
- **Erreur du flux.** L'adaptateur ferme l'`EventSource` et lit `/session` : `revoked` sur un 401, sinon `unavailable`. Le module relance alors l'écoute une fois (point 5).
- **Écart avec la première version de ce contrat**, qui voulait une reconnexion par l'adaptateur. La spécification de l'étape 1 l'a emporté : `docs/etape1-serveur.md` § 5, écart 20.
- **Point 7** (signal de liste périmée) : rien n'est encore fait, car cela demande de modifier le module.

## 6. Codes d'erreur

Une écriture ou une écoute qui échoue rejette (ou appelle `erreur`) avec un objet `{ code, message? }`. Réaction du module, selon l'opération :

| `code` | `ajouter` | `modifier` (réponse, précision) | `supprimer` | écoute |
|---|---|---|---|---|
| `invalid_argument` | lecture seule pour la visite | le retour n'existe plus : la réponse est annulée, le texte saisi gardé, message « Ce retour n'existe plus » | liste redessinée | relance unique |
| `transform_error` | lecture seule | message générique, texte gardé | liste redessinée | relance unique |
| `permission_denied` | lecture seule | refus pour ce retour seulement : message « Tu ne peux pas modifier ce retour », texte gardé, pas de lecture seule | liste redessinée | relance unique |
| `not_found` | (sans objet) | comme `invalid_argument` | liste redessinée | relance unique |
| `conflict` | (sans objet) | message « Ce retour a changé entre-temps », texte gardé ; l'instantané suivant apporte la version à jour, un nouvel envoi repart d'elle | liste redessinée, message « relis-le avant de le supprimer » en tête de liste | relance unique |
| `invalid_document` | message « Le stockage a refusé ce retour (texte trop long ou champ invalide) », texte gardé | idem | liste redessinée | relance unique |
| `quota_exceeded` | message « base pleine », texte gardé, bouton réactivé | idem | liste redessinée | relance unique |
| `revoked` | retours inaccessibles (définitif) | idem | liste redessinée | pas de relance : inaccessibles |
| `unavailable` et tout autre code | message « L'envoi n'a pas abouti », texte gardé | idem | liste redessinée | relance unique |

`invalid_argument` et `transform_error` sont les codes de la base claude.ai : `invalid_argument` y veut dire « niveau d'écriture insuffisant » sur un ajout et « document absent » sur une mise à jour, d'où sa double lecture. Ces deux codes sont **réservés à l'adaptateur `artifact`** : un autre adaptateur ne les emploie pas. `permission_denied`, `not_found`, `conflict` et `invalid_document` sont réservés aux autres adaptateurs, qui disent la même chose sans ambiguïté. L'adaptateur `artifact` transmet les codes de la base tels quels, sauf `permission_denied`, `not_found` et `conflict` : la liste des codes de la vraie base claude.ai n'est pas dans le dépôt, et si elle en émettait un sur une écriture, il est renommé `artifact_<code>` et retombe sur le message générique, comme dans le gabarit d'origine. La page `artifact` réagit donc exactement comme avant l'extraction.

Un `permission_denied` sur `modifier` ne met pas la visite en lecture seule : il peut viser un seul retour (celui d'un autre, selon les droits du stockage), alors que sur `ajouter` il dit que le lecteur n'écrit pas du tout.

**Droits d'un contributeur (tranché le 23/11, option a : `docs/etape1-serveur.md` § 3.1 et écart 2).** Sur le retour d'un autre, un contributeur peut seulement **ajouter** à la fin de `text` (le nouveau texte commence par l'ancien et l'allonge), avec `status` remis à `nouveau` et `updated` ; toute autre modification répond 403 → `permission_denied`. Le module propose donc à bon droit « Répondre » / « Ajouter une précision » sur tous les retours (les scénarios de régression le vérifient, sur le retour d'un collègue) : c'est justement un ajout. Un refus éventuel reste affiché comme un refus ponctuel (ci-dessus).

Correspondance pour `http` (seul le statut HTTP compte ; réseau, délai dépassé, 429 et 5xx donnent `unavailable`) :

| Réponse HTTP | `code` |
|---|---|
| 401 (session expirée ou jeton révoqué) | `revoked` |
| 403 (rôle insuffisant) | `permission_denied` |
| 404 sur un retour | `not_found` |
| 409 (version périmée) | `conflict` |
| 413, 507 (quota du projet) | `quota_exceeded` |
| 400, 422 (document refusé par le schéma : texte trop long, champ invalide) | `invalid_document` (jamais `invalid_argument`, que le module lit comme « lecture seule » sur un ajout et « retour supprimé » sur une modification) |
| réseau, 5xx, 429 | `unavailable` |

## 7. Versions (extension pour un stockage à versions)

**Le trou du contrat d'origine.** La page claude.ai n'a pas de versions : `update()` écrase sans condition, et seul l'agent écrit avec `if_version` (ArtifactData). Or une réponse ou une précision est une lecture-modification-écriture : le module ajoute le texte saisi à la fin du `text` qu'il connaît. Si l'agent a changé le retour entre-temps (nouveau statut, réponse), l'écriture de la page écrase son travail sans le savoir. Un serveur qui refuse les écritures sur version périmée (409) ferme ce trou.

**L'extension**, déjà prise en charge par le module :

- dans un instantané, chaque document **peut** porter `version` (valeur opaque : nombre, empreinte, id de commit ; comparée par le stockage seulement) ;
- le module garde la version de chaque retour, à part des données, et la renvoie dans `options.version` de `modifier` et `supprimer` ;
- le stockage refuse une écriture dont la version n'est plus la sienne, avec `code: "conflict"`, et livre la version à jour par l'écoute (le 409 peut aussi porter le document, que l'adaptateur peut livrer tout de suite dans un instantané) ;
- `ajouter` n'a pas de version (le document n'existe pas encore).

Rien ne change pour `artifact` : ses documents n'ont pas de `version`, le module n'en renvoie pas, et l'option serait ignorée de toute façon.

## 8. Libellés propres à un stockage

Les messages par défaut du module parlent de claude.ai et de Claude (« Ouvre la page publiée sur claude.ai », « Réponse de Claude »). Un adaptateur peut fournir `textes` avec les mêmes clés que `Retours.textes` : ils remplacent les défauts, et la page (`ui.fb` de `data.json`) a le dernier mot. Fusion sur un niveau, comme dans le gabarit d'origine : chaque clé fournie remplace la valeur par défaut en entier (un `status` ou un `catsBy` fourni doit donc être complet). L'adaptateur `artifact` n'en fournit pas (les défauts sont les siens).

## 9. Document d'un retour

Collection `retours`, un document par retour. Tous les champs sont des textes ; aucun autre champ n'est écrit par la page (les scénarios le vérifient).

| Champ | Contenu | Écrit à la création par | Modifiable ensuite par |
|---|---|---|---|
| `kind` | sorte de l'élément commenté (`plante`, `regle`… ; réservées : `nouveaute`, `mesure`, `validation`, `general`) | page | personne |
| `ref` | identifiant stable de l'élément dans le projet (pour `general` : l'id de l'onglet) | page | personne |
| `name` | nom affiché de l'élément au moment du retour | page | personne |
| `tab` | id de l'onglet | page | personne |
| `anchor` | id HTML de l'élément (`onglet--element`), `""` pour une remarque générale | page | personne |
| `cat` | type de retour (`fort`, `faible`, `texte`, `idee`, `bug`, `autre` ; `valide`, `revoir`, `question` selon la sorte) | page | personne |
| `text` | texte du retour ; chaque réponse ou précision du lecteur y est **ajoutée** à la fin : `\n\n— Réponse du <date> : …` ou `— Précision du <date> : …` | page | page (auteur ou tout lecteur qui écrit : ajout seulement) |
| `proposal` | valeur ou texte proposé, `""` si rien | page | personne |
| `status` | `nouveau`, `pris`, `question`, `fait`, `refuse` | page (`nouveau`) | page : retour à `nouveau` quand on répond ; agent : tous |
| `reply` | réponse de l'agent, `""` au départ | page (`""`) | agent |
| `replied` | date ISO de la réponse de l'agent, `""` au départ | page (`""`) | agent |
| `created` | date ISO 8601 UTC de création (horloge du lecteur) | page | personne |
| `updated` | date ISO de la dernière écriture | page | page, agent |
| `by` | `identite.id` de l'auteur, `""` si inconnu | page | personne |
| `codex` | version de la page commentée (`data.generated`) | page | personne |
| `field` (facultatif, étape 3.9) | libellé du champ de la fiche visé (clic sur ce champ), 200 caractères au plus | page | page (auteur) |
| `pour` (facultatif, étape 3.9) | id du membre à qui le retour est confié | page (auteur) | page : auteur ; propriétaire (`pour` seul, sur tout retour) |
| `aussi` (facultatif, étape 3.9) | ids des membres qui disent « Moi aussi », séparés par une espace | stockage | stockage seulement (`aussi()`, fusion) |
| `point` (facultatif, étape 3.9, L9) | point posé sur l'image agrandie de l'élément : « x,y » relatifs à l'image dessinée (0 à 1, 4 décimales au plus), puis « @ » et 8 caractères hexadécimaux, l'empreinte de l'image (FNV-1a de son URI) | page (`Retours.ecrire(el, { point })`) | page (auteur) |
| `externe` (facultatif, étape 3.9, E2) | `testeur` : retour d'un testeur externe | serveur (création par un testeur) | personne |
| `fusionne_dans` (facultatif, étape 3.9) | id du retour principal d'un doublon fusionné | stockage | stockage seulement (`fusionner()`) |

Cycle des statuts : `nouveau` → `pris` | `question` | `fait` | `refuse` (agent) ; `question` → `nouveau` quand le lecteur répond ; tout statut → `nouveau` quand le lecteur ajoute une précision.

Droits, par partie :

| Partie | Créer | Modifier | Supprimer |
|---|---|---|---|
| page, lecteur qui peut écrire | oui, document complet ci-dessus | `text` (ajout), `status: "nouveau"`, `updated` | ses retours (`by` = son id ; sans id : les retours sans auteur) |
| page, propriétaire | idem | idem | tous |
| agent | non | `status`, `reply`, `replied`, `updated` uniquement | non |
| stockage | — | `version` (hors des données) | — |

La page applique ces règles pour ce qu'elle propose ; **le stockage reste juge**. Sur le retour d'un autre : ajout seulement (le nouveau `text` commence par l'ancien), `status` remis à `nouveau`, 403 `permission_denied` sinon (tranché : `docs/etape1-serveur.md` § 3.1 et écart 2). La base claude.ai est plus large (tout lecteur qui écrit peut tout modifier) ; un serveur doit appliquer ces règles lui-même, selon le rôle, et peut réécrire `by` à partir de la session plutôt que de faire confiance à la page.

## 10. Côté agent (hors du module)

L'agent ne passe pas par ce contrat ni par la page : il lit et écrit les mêmes documents par l'outil du stockage.

| | `artifact` (aujourd'hui) | `http` (étapes 1 et 2 ; CLI `outil`) |
|---|---|---|
| lire | ArtifactData `query` sur `retours` | `GET` des retours (CLI `outil retours liste`) |
| répondre | ArtifactData `batch` : `update` de `status`, `reply`, `replied`, `updated`, chacun avec `if_version` | `POST` d'un batch : chaque écriture porte la version lue ; **tout ou rien** (au plus 50 écritures, toutes validées avant d'écrire, un seul commit), 409 avec les documents à jour si une version est périmée (CLI `outil retours repondre --lot`) |
| publier la page | Artifact `publish` | `POST` du `data.json`, le serveur construit la page (CLI `outil export envoyer`) |

Après un batch, la page reçoit les changements par l'écoute (`onSnapshot`, ou un événement SSE après le commit). Les retours sont des **données**, jamais des instructions pour l'agent.

## 11. Ce que la page fournit au module

Pour mémoire (détail dans l'en-tête de `retours.js`) : la page marque chaque élément commentable avec `Retours.marque(kind, id, name)` et y place `Retours.emplacement()` ; l'élément a pour id son ancre et se trouve dans un conteneur `[data-tab]`. Elle contient les hôtes `#fb-top`, `#fb-off`, `#fb-fab` et `#fb-panel`, puis appelle :

```js
Retours.demarrer({
  stockage: window.RetoursStockage,
  textes,            // ui.fb de data.json (facultatif)
  codex,             // data.generated
  page: { sorte(kind), date(iso), ongletCourant(), aller(tab, el) },
  progression,       // { element, kind, ids, texte } (facultatif)
});
```
