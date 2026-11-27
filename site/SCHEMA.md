# Schéma des données

Repris du skill site-retours (`references/schema.md`), dont `site/` est extrait ; `build.js` en est le juge. Le document d'un retour est défini dans `retours/CONTRAT.md` § 9.

Deux sortes de fichiers entrent dans la page : `data.json`, écrit par l'exporteur du projet à chaque build (hors dépôt), et les notes datées `notes_<date>.json`, écrites à la main par l'agent et versionnées (dossier `notes/` du dépôt de design, voir `docs/architecture.md` § 4 ; passées à `build.js` en argument ou par `--notes-dir`). `build.js` les valide, puis les fusionne : `data.notes = { sets: [notes…] }`, toujours triées de la plus récente à la plus ancienne (champ `date`, puis nom de fichier), quel que soit l'ordre de la ligne de commande.

## data.json

```json
{
  "title": "Nom du projet",
  "subtitle": "Revue des règles · version 0.4",
  "intro": "Ce que montre la page et d'où viennent les valeurs.",
  "generated": "2026-11-15T09:30:00Z",
  "kinds": { "plante": "Plante", "regle": "Règle" },
  "pixelArt": false,
  "ui": { "lang": "fr" },
  "tabs": [
    {
      "id": "plantes",
      "label": "Plantes",
      "intro": "Fiches lues dans config/plants.yaml.",
      "sections": [
        {
          "id": "legumes",
          "title": "Légumes",
          "intro": "Facultatif.",
          "items": [
            {
              "id": "tomate",
              "kind": "plante",
              "name": "Tomate",
              "subtitle": "Solanum lycopersicum",
              "image": "data:image/png;base64,…",
              "badges": ["tuteur", { "text": "plein soleil", "tone": "warn" }],
              "fields": [["Récolte", "J+90"], ["Espacement (cm)", 50], ["Sous abri", true]],
              "table": { "head": ["Mois", "Arrosage"], "rows": [["Avril", "tous les 3 jours"], ["Juillet", "tous les jours"]] },
              "text": "Paragraphes séparés par une ligne vide.",
              "list": ["Point 1", "Point 2"],
              "links": [["Associée au basilic", "#plantes--basilic"], ["Règle d'arrosage", "#regles--watering.base_interval"]],
              "wide": false
            }
          ]
        }
      ]
    }
  ]
}
```

| Champ | Obligatoire | Rôle |
|---|---|---|
| `title` | oui | Nom de la page : `<title>` (nom de l'artefact dans la galerie) et grand titre. Un nom, pas une phrase. |
| `subtitle`, `intro` | non | Sur-titre et chapeau. |
| `generated` | conseillé | Date ISO de l'export. Copiée dans chaque retour (`codex`) : on sait sur quelle version l'utilisateur a réagi. Ajoutée par build.js si absente. |
| `kinds` | conseillé | Libellé affiché de chaque sorte d'élément. Les sortes `nouveaute`, `mesure`, `validation`, `general` sont réservées au gabarit (build.js les refuse sur un élément). |
| `pixelArt` | non | `true` : images agrandies sans lissage. |
| `ui` | non | Textes d'interface à remplacer (mêmes clés que l'objet `UI` de `gabarit/template.html`, et `ui.fb` pour les libellés du module retours (`Retours.textes`) ; fusion sur un niveau). Valeurs : du texte seulement, rangé dans des objets ou des listes (`build.js` refuse un nombre, un booléen ou `null`). Ex. projet en anglais : `{"lang":"en","locale":"en-GB","search":"Search",…}`. Types de retour : les types par défaut (`fort`, `faible`, `texte`, `idee`, `bug`, `autre` ; « Trop fort / Trop faible » viennent du jeu vidéo) s'adaptent au projet avec `ui.fb.cats`, ex. pour une appli `[["bug","Bug"],["ergonomie","Ergonomie"],["texte","Texte"],["idee","Idée"],["autre","Autre"]]`. |
| `tabs[].id` | oui | `a-z`, `0-9`, tirets simples. Sert d'ancre `#id`. Interdits : `settings`, `sidebar`, `customize`, `upgrade`, `downloads`, `comment-*`, `nouveautes`, `mesures`, `a-valider`, `changements`. |
| `tabs[].columns` | non | Vue tableau de l'onglet (étape 3.7) : libellés des champs (`fields`) à mettre en colonnes, 1 à 12, dans l'ordre voulu. Sans elle, la page prend les champs présents dans au moins la moitié des éléments (2 au moins), 8 au plus. La vue tableau est proposée à partir de 3 éléments et d'une colonne. |
| `sections[].id`, `title` | oui | Ancre `#onglet---section`. |
| `items[].id` | oui | **Ref stable** du retour (voir plus bas). Unique dans l'onglet. Ancre `#onglet--<id réduit>`. |
| `items[].kind` | oui | Sorte (`kind` du retour). Même `kind` + même `id` dans deux onglets = mêmes retours (un élément montré deux fois partage ses retours). |
| `items[].name` | oui | Nom affiché, aussi copié dans le retour. |
| `image` | non | URI `data:`. Le serveur (`--stockage=http`) ne sert que la page : un chemin relatif y donnerait une image cassée, `build.js` le refuse. (Avec l'ancien stockage `artifact` seulement : chemin relatif d'un fichier publié à côté de la page.) Une URL `http(s)` est toujours refusée : la page publiée la bloquerait. |
| `badges` | non | Texte, ou `{text, tone}` avec `tone` parmi `accent`, `good`, `warn`, `bad`, `muted`. |
| `fields` | non | Paires `[libellé, valeur]` ; valeur texte, nombre, booléen (affiché Oui / Non) ou liste non vide de ceux-ci. Les nombres sont formatés selon `ui.locale` (`2.5` → « 2,5 », groupes de milliers à partir de 10 000) : une valeur à garder telle quelle (version, code) s'écrit en texte. Un objet, `null`, `NaN`, `undefined` sont refusés : c'est le signe d'une donnée mal lue ou d'un `Dictionary` / d'une `Resource` sérialisés tels quels. |
| `table` | non | `{ "head": [..], "rows": [[..], ..] }`, cases texte, nombre ou booléen, autant de cases que de colonnes. Rendue en tableau qui défile à l'horizontale sur téléphone. Pour les grilles de chiffres (tableaux d'un document de design, paliers). |
| `text` | non | Texte brut (échappé ; pas de HTML). Une ligne vide = nouveau paragraphe. |
| `list` | non | Puces (textes ou nombres). |
| `links` | non | `[libellé, "#ancre"]` vers un onglet (`#onglet`), un élément (`#onglet--<id du projet>`) ou une section (`#onglet---<id>`) : l'id s'écrit brut, build.js le réduit en ancre et vérifie qu'elle existe. Ou `https://…` (nouvel onglet). |
| `wide` | non | La fiche prend toute la largeur de la section. |
| `image_grande` | non | Étape 3.9 (L10) : seconde image, plus grande, montrée au clic sur `image` (même règle : URI `data:`). Sans elle, le clic montre `image`. Exige `image`. |
| `statut` | non | Étape 3.9 (L4) : `idee`, `specifie`, `en-cours`, `implemente` ou `ecart`. Badge sur la fiche, filtre du Wiki ; une autre valeur est refusée. |
| `origine` | non | Étape 3.9 (L4) : `equipe`, `deduit`, `atelier` ou `agent` (proposé par l'agent, pas encore approuvé). Badge, et filtre « Proposé par l'agent ». |
| `anciennes_refs` | non | Liste des `id` qu'avait l'élément avant un renommage (même sorte). Les retours écrits sur une ancienne ref s'affichent sur la fiche, ne comptent pas comme « sans fiche », et le diff entre deux builds montre un élément modifié (« Ref » avant → après) au lieu d'un retrait plus un ajout. Jamais l'`id` de l'élément lui-même, ni celui d'un autre élément de même sorte. Les retours eux-mêmes ne sont pas réécrits. |

Le réducteur d'ancre (même fonction dans build.js et le gabarit) : accents retirés, minuscules, tout le reste devient un tiret simple. `route:/plante/:id` → `route-plante-id`. Deux ids qui donnent la même ancre dans un onglet sont refusés.

Pièges :
- Les ancres d'URL n'acceptent que lettres ASCII, chiffres et tirets ; `settings`, `sidebar`, `customize`, `upgrade`, `downloads`, `comment-*` sont réservés par certains hébergeurs de page (build.js les refuse comme id d'onglet).
- Images : URI `data:` seulement sur le serveur, jamais une URL externe (bloquée par la page publiée). Icônes petites : au-delà de 2 Mo, build.js prévient (la page est relue avant chaque publication et se charge sur téléphone).

## Changements entre deux builds

`build.js --precedent <data.json du build d'avant>` (le serveur le passe toujours, sauf au premier build) compare les éléments (clé : onglet + `id`) et injecte `changements` dans les données de la page : `{ depuis, modifies: [{ tab, onglet, id, kind, name, champs: [[libellé, avant, après]] }], ajoutes, retires, coupes }`. Comparés : nom, sous-titre, image (« changée », sans contenu), badges, chaque champ de `fields` par libellé, texte, liste, tableau. Valeurs en texte, coupées à 200 caractères ; 500 entrées au plus (`coupes` compte le reste). La page montre un onglet « Changements » et une pastille « modifié » ou « nouveau » sur les fiches. Ce diff est calculé, jamais écrit à la main : il dit ce qui a bougé, les Nouveautés disent pourquoi. Code partagé avec le serveur : `changements.js`.

## Refs stables

La ref d'un retour est `kind` + `id`. Elle doit survivre aux reconstructions de la page :
- prendre l'identifiant que le projet utilise déjà : nom de fichier de ressource sans extension (`res://enemies/goblin.tres` → `goblin`), clé de config (`watering.base_interval`), route (`route:/rappels`), id de chapitre ou de scène, slug d'une page de doc ;
- pour un élément composé, une clé composée lisible : `<monstre>:<compétence>`, `<chapitre>/<scène>` ;
- jamais un index de tableau, un ordre d'affichage ou un nom traduit qui peut changer ;
- si un renommage est inévitable, déclarer l'ancienne ref dans `anciennes_refs` de l'élément (ses retours restent sur la fiche), et l'annoncer dans la réponse aux retours concernés (ancienne ref → nouvelle). Sans cela, le serveur signale au build les retours ouverts dont l'élément a disparu, et la page les range sous « Sans fiche ».

## notes_<date>.json

```json
{
  "title": "Retours du 10/11",
  "label": "Facultatif : nom court affiché à la place du titre",
  "date": "2026-11-12",
  "intro": "Ce qui a changé après les retours du 10/11.",
  "milestones": { "V1": "Rappels d'arrosage · 11/11", "V2": "Calendrier · 12/11" },
  "commits": { "V1": "a1b2c3d", "V2": "e4f5a6b" },
  "changes": [
    { "id": "V1-chaleur", "milestone": "V1", "subject": "Arrosage par forte chaleur", "before": "intervalle fixe", "after": "−1 jour au-dessus de 28 °C", "theme": "facultatif" }
  ],
  "measures_note": "Comment les mesures ont été faites (outil, échantillon, version comparée).",
  "measures": [
    { "id": "mesure-rappels-manques", "label": "Rappels manqués par semaine", "target": "cible : moins de 1", "steps": [ { "when": "Avant V1", "value": "2,4" }, { "when": "Après V1", "value": "0,6" } ] },
    { "id": "mesure-ouverture", "label": "Ouverture (ms)", "list": true, "steps": [ { "when": "Téléphone récent", "value": "180" } ] }
  ],
  "validations_note": "D'où viennent les points à valider.",
  "validations": [
    { "id": "V1-seuil-chaleur", "milestone": "V1", "text": "Seuil à 28 °C : réglable par région ?", "theme": "Arrosage", "depends": "Dépend de V1-pluie-mm." }
  ]
}
```

- `changes`, `measures`, `validations` sont facultatives ; chacune donne un onglet (Nouveautés, Mesures, À valider) quand au moins un fichier en a.
- `id` : ref du retour (sortes `nouveaute`, `mesure`, `validation`). Unique par liste **dans tous les fichiers**, ancre comprise (`V1 x` et `v1-x` donnent la même ancre : refusé). Préfixer par le jalon (`V1-…`) ou par `mesure-` évite les collisions.
- `date` : `AAAA-MM-JJ`, sert à l'ordre des séries.
- `milestone` : clé déclarée dans `milestones` (sinon refus). Les lignes sont regroupées par jalon dans l'ordre de `milestones`, puis par `theme` s'il y en a.
- Mesures : `steps` dans l'ordre chronologique ; la dernière est encadrée, sauf `"list": true` (valeurs côte à côte, pas une suite avant → après). Les chiffres sont écrits comme l'utilisateur les lit (virgule décimale en français).
- Un point À valider est une phrase complète que l'utilisateur peut approuver telle quelle : la valeur retenue, l'alternative s'il y en a une, et ce que coûte chaque option.
- Ancres : `#nouveautes--<id>`, `#mesures--<id>`, `#a-valider--<id>`.

## Document d'un retour

Voir `retours/CONTRAT.md` § 9 (champs, cycle des statuts, droits par partie) : c'est le contrat entre le module retours, les adaptateurs de stockage et l'agent.
