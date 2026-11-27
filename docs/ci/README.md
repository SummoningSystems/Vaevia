# Publier le Wiki depuis une CI (étape 3.7, G2)

Le Wiki n'est utile que s'il est à jour. Une tâche de CI peut le republier à chaque fusion sur la branche principale. Elle lance l'exporteur du projet, puis envoie `data.json`.

## 1. Un jeton « publieur »

Dans la méta-interface : projet → **Membres** → **Jetons d'agent** → rôle **Publieur (CI : publier le Wiki, rien d'autre)**. Le jeton n'est montré qu'une fois.

Ce jeton ne fait que deux choses :
- `POST /api/p/<projet>/builds`, pour publier ;
- `GET /api/p/<projet>/builds`, pour lire l'état du dernier build.

Tout le reste lui est refusé (403) : il ne lit ni ne répond aux retours, n'écrit pas de notes, n'ouvre pas le flux. S'il fuit, le pire est un Wiki republié avec des données fausses, que le build suivant corrige.

Le jeton va dans les **secrets** de la CI, sous le nom `OUTIL_JETON`. Il ne va jamais dans le dépôt : `outil` refuse un jeton trouvé dans `.outil.json`.

## 2. La commande

```sh
outil publier --si-change --sans-notes --json
```

- `--sans-notes` : un publieur n'écrit pas de notes. Les notes datées restent le travail de l'agent ou d'un humain.
- `--si-change` : rien n'est envoyé si les données sont identiques à celles du dernier build. La date d'export (`generated`) n'est pas comparée. La sortie est alors « inchangé », avec le code 0. Une fusion qui ne touche pas aux données ne crée pas de build.
- Le dépôt doit contenir `.outil.json` (serveur, projet, `publier.exporteur`), comme sur un poste de développeur.

Le runner a besoin de Node 24 ou plus, et de la CLI `outil` : le dépôt de l'outil cloné, ou une copie de `cli/` et `site/`. Il a aussi besoin de ce que demande l'exporteur. Pour Godot, cela veut dire un Godot sans fenêtre sur le runner ; ce n'est pas vérifié ici, moteur par moteur.

## 3. Exemples

Les adresses (`https://retours.exemple.fr`, dépôt de l'outil) sont à remplacer. Chaque exemple clone l'outil à une version figée : choisis-en une et garde-la.

### GitHub Actions (`.github/workflows/wiki.yml`)

```yaml
name: Wiki
on:
  push:
    branches: [main]
jobs:
  publier:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Outil (version figée)
        run: git clone --depth 1 --branch <version> <dépôt de l'outil> "$RUNNER_TEMP/outil"
      - name: Publier le Wiki
        env:
          OUTIL_JETON: ${{ secrets.OUTIL_JETON }}
        run: node "$RUNNER_TEMP/outil/cli/outil.ts" publier --si-change --sans-notes --json
```

### GitLab CI (`.gitlab-ci.yml`)

```yaml
wiki:
  image: node:24
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - git clone --depth 1 --branch <version> <dépôt de l'outil> /tmp/outil
    - node /tmp/outil/cli/outil.ts publier --si-change --sans-notes --json
  # OUTIL_JETON : variable masquée et protégée (Settings → CI/CD → Variables).
```

### Gitea / Forgejo Actions (`.gitea/workflows/wiki.yml`)

Même forme que GitHub Actions. Le secret est déclaré dans les réglages du dépôt, sous Actions → Secrets.

## 4. Ce qui n'est pas vérifié

- Ces fichiers n'ont tourné sur aucune vraie forge. La commande, elle, est testée (`cli/test`, `serveur/test/publieur.test.ts`).
- Les exporteurs de moteur (Godot, Unity) sans fenêtre sur un runner n'ont pas été vérifiés.
