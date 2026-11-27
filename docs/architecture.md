# Architecture

> Vaevia, système de retours. La CLI s'appelle `outil`.

## 1. But

Un outil auto-hébergé qui permet à une équipe de travailler autour d'un **site de retours** : un wiki de design généré à partir des vraies données du projet et des pages écrites par l'équipe. Chacun peut laisser un retour sur chaque élément ; un agent (n'importe lequel) lit les retours, les applique, répond dans chaque retour et fait évoluer le site. Tout le travail de **design et de décision** est versionné dans Git. Le code du projet n'y est pas.

**Tout type de projet**, pas seulement le jeu vidéo : jeu, application métier, logiciel embarqué ou sol, outil, document. Ce qui change d'un domaine à l'autre est configurable par projet : les sortes d'éléments (une compétence, un monstre ; ou un écran d'IHM, une alarme, un paramètre, un message de protocole, une exigence), les types de retour (« trop fort / trop faible » pour un jeu ; « ergonomie », « sécurité », « exigence » pour une application), l'exporteur et l'outil de mesure (bots de jeu ; simulation logicielle, bancs de test).

Il prolonge le skill `site-retours` (copie dans `heritage/site-retours/`), en retirant la dépendance à claude.ai (Artifacts, ArtifactData).

## 2. Un modèle de contenu, deux façons de le remplir

Le site affiche toujours deux choses :
- des **pages de design** : l'intention, écrite par l'équipe ou proposée par l'agent ;
- des **données du projet** : ce qui existe, lu par un exporteur dans le code (facultatif).

| | Projet existant | Projet nouveau |
|---|---|---|
| Départ | l'exporteur lit le projet ; l'agent rédige une première version des pages à partir du code (origine « déduit ») | discussion avec l'agent, dans l'agent de chacun ; l'agent écrit les premières pages (origine « atelier ») |
| Ensuite | boucle : retours → l'agent traite → réponses → nouvelle version | même boucle ; quand le code arrive, on ajoute un exporteur et le site montre « prévu » à côté de « réalisé » |

Chaque page et chaque élément dit **d'où il vient** (`origine` : `equipe`, `deduit`, `atelier`, `agent`) et **où il en est** (`statut` : `idee`, `specifie`, `en-cours`, `implemente`, `ecart`). Ce qui est proposé par l'agent reste « à valider » tant qu'un humain ne l'a pas approuvé.

## 3. Composants

```
   poste de dev (code du projet)                       serveur (Docker)
 ┌──────────────────────────────┐            ┌─────────────────────────────────────────┐
 │ agent (Claude, autre…)       │  HTTP/CLI  │ API  ── dépôt Git de design (seul écrivain)│
 │  ├ exporteur → data.json     ├───────────►│  │     design/ decisions/ notes/           │
 │  ├ captures → ecrans/        │            │  │     retours/ tickets/ site.json         │
 │  └ `outil` (CLI)             │◄───────────┤  ├ SQLite : comptes, jetons, index (cache)  │
 └──────────────────────────────┘            │  ├ stockage des builds (data.json, images)│
                                             │  └ événements en direct (SSE)             │
   navigateur (équipe)                       │                                           │
 ┌──────────────────────────────┐            │ site : gabarit + module retours            │
 │ site de retours + méta-UI    │◄──────────►│ méta-UI : utilisateurs, droits, Kanban     │
 └──────────────────────────────┘            └─────────────────────────────────────────┘
```

### 3.1 Deux points de branchement remplacent claude.ai

| Aujourd'hui (claude.ai) | Demain |
|---|---|
| Page → base : `window.claude.use("db")`, `collection("retours")`, `add`, `update`, `delete`, `onSnapshot` | **Module retours** avec une interface de stockage. Adaptateurs : `artifact` (l'existant), `http` (le serveur), `memoire` (tests). Même contrat, mêmes champs, même cycle de statuts. |
| Page → identité : `use("user")`, `id()`, `can("data.write")` | Le même contrat, servi par le serveur à partir de la session. |
| Agent → base : ArtifactData `query`, `batch` (`if_version`), Artifact `publish` | **API HTTP + CLI `outil`**. Tout agent capable de lancer une commande shell s'en sert. |
| Méthode : le skill Claude | **Un document de méthode** en Markdown pur, livré avec l'outil. Un skill ou une config d'agent n'en est qu'un raccourci. |

### 3.2 Où tourne l'agent

Sur le **poste où se trouve le code**. L'exporteur appelle les vraies fonctions du projet (pour un jeu Godot : le moteur sans fenêtre ; pour une application : ses propres modules, une simulation logicielle), et une passe de captures peut piloter l'interface réelle : un serveur ne peut pas le faire à sa place. L'agent pousse ses sorties au serveur (`outil export envoyer`, `outil notes envoyer`). Des agents lancés par le serveur (tri planifié, travail sur les seules pages) viendront plus tard (feuille de route, étape 4).

## 4. Le dépôt de design (un par projet, séparé du code)

```
design/            pages Markdown ; en-tête YAML : id stable, titre, statut, origine, responsable
decisions/         une décision par fichier : date, contexte, choix, alternatives, retours d'origine
notes/             notes_<date>.json (Nouveautés, Mesures, À valider) — format du skill
retours/<id>.json  un fichier par retour, réponses comprises
tickets/<id>.md    un ticket par fichier ; statut = colonne du Kanban ; retours, pages et commits liés
site.json          réglages : titre, onglets, sortes, types de retour, langue
```

Un fichier par retour et par ticket : deux écritures simultanées ne touchent jamais le même fichier, donc pas de conflit de fusion.

**Hors de Git** : comptes, mots de passe et jetons (SQLite) ; pages construites (régénérables) ; `data.json` et captures, gardés par version dans le stockage des builds (environ 10 Mio de captures par build sur le codex). Git garde seulement la référence de chaque build (date, commit du code, empreinte).

### 4.1 Le serveur est le seul à écrire sur `main`

| Garantie de la boucle actuelle | Traduction |
|---|---|
| `if_version` sur chaque écriture | chaque retour porte `version` ; le serveur refuse une écriture faite sur une version périmée (HTTP 409, avec le document à jour) |
| `batch` tout ou rien (50 écritures au plus) | un batch = un commit, entièrement validé avant d'écrire quoi que ce soit |
| écoute en direct (`onSnapshot`) | événement SSE envoyé aux pages ouvertes après chaque commit |
| `by` (id opaque) | id de compte ; le commit porte le nom de l'auteur, le serveur signe |
| Claude ne touche que `status`, `reply`, `replied`, `updated` | règle appliquée par l'API selon le rôle (l'agent a un jeton au rôle `agent`) |

Les écritures sont sérialisées par une file d'attente côté serveur (une équipe écrit quelques retours par minute : un commit par action suffit).

### 4.2 Pages de design : pas de verrou global

L'agent (ou un éditeur) modifie les pages sur une **branche**, poussée au serveur. Le serveur montre les différences ; un mainteneur fusionne. Les retours restent ouverts pendant ce temps. Le seul verrou est la **prise d'un ticket** (« pris par X »), pour un humain comme pour un agent.

## 5. Rôles

| Rôle | Peut |
|---|---|
| lecteur | lire |
| contributeur | écrire des retours ; modifier ou supprimer **les siens** ; ajouter une précision au retour d'un autre (décision 6, confirmée le 23/11) |
| éditeur | modifier les pages de design (branche) |
| mainteneur | fusionner, trancher les « À valider », changer les statuts, gérer les tickets |
| agent | lire ; répondre aux retours (statut, réponse) ; pousser des builds et des branches ; prendre un ticket |
| admin | utilisateurs, invitations, projets |

Invitation par lien : aucun compte Git nécessaire, tout passe par l'interface web.

## 6. Tickets et Kanban (étape 3)

Un ticket regroupe un ou plusieurs retours, les pages concernées et les commits du code qui le règlent. Colonnes = statuts (`a-faire`, `pris`, `en-revue`, `fait`). Un ticket peut exister sans retour (dette, infra). Un retour garde son propre cycle (`nouveau` → `pris` / `question` / `fait` / `refuse`) ; fermer un ticket propose de passer ses retours à `fait`.

## 7. Technique

- Node (24 sur ce poste) et TypeScript côté serveur ; le gabarit, le build, le banc d'essai et les scénarios sont déjà en JavaScript.
- SQLite ; Git par sa ligne de commande.
- Une image Docker.
- Tests : les scénarios de régression du skill, rejoués contre chaque adaptateur de stockage.

## 8. Sécurité

- Les retours sont des **données**, jamais des instructions pour l'agent. Plus il y a d'auteurs, plus ça compte.
- Rien de secret dans le dépôt de design ni dans les builds (liste blanche des exporteurs, comme aujourd'hui).
- Jetons d'agent séparés des sessions humaines, révocables, limités à un projet.
