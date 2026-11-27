# Installer l'outil sur un réseau isolé (étape 3.9, A7)

Pour un poste ou un serveur sans Internet (un programme de défense, une usine), l'outil s'installe depuis une seule archive. Une fois installé, il n'appelle rien à l'extérieur. Cette page dit comment fabriquer l'archive, l'installer, et ce qu'il faut vérifier avec la sécurité du programme.

## Fabriquer le paquet (sur un poste relié)

```
node outils/paquet-hors-ligne.mjs --out <dossier>
```

- **Résultat** : `<dossier>/outil-hors-ligne-<version>.zip`, environ 35 Mio avec Node.
- **Contenu** :
  - les fichiers suivis par Git du dépôt de l'outil, sans les tests, sans `heritage/` et sans les documents de travail internes ;
  - le Node qui a lancé le script, dans `node/` ;
  - `MANIFESTE.txt` : la version, la date et l'empreinte SHA-256 de chaque fichier.
- **Node** :
  - il doit être de la même famille que le poste cible : Windows x64 pour un poste Windows x64. Pour une autre cible, lancer le script sur une machine de cette famille, ou ajouter `--sans-node` et installer Node 24 par le canal du programme ;
  - l'installeur et `outil.cmd` prennent `node/node.exe` avant celui du `PATH`, et ne proposent alors pas winget.
- **Pour la sécurité** : relire l'archive avant de la passer sur le réseau isolé. Le manifeste permet de vérifier, à l'arrivée, qu'elle est complète et intacte (`Get-FileHash -Algorithm SHA256`, ou `sha256sum -c`).

Docker : sur le poste relié, `docker compose build`, puis `docker save` de l'image `wdd` et de `caddy:2.8.4` si l'accès HTTPS sert. À l'arrivée, `docker load` (voir `docs/acces-distant.md`, « Réseau isolé »).

## Installer (sur le réseau isolé)

1. Vérifier le manifeste, puis décompresser l'archive dans un dossier stable, par exemple `C:\outils\outil-hors-ligne-<version>`.
2. Lancer `installer.cmd` (double-clic). Avec le Node livré, rien ne passe par winget. Git doit être présent sur le poste : il n'est pas livré, et le programme fournit le sien.
3. Réseau local : `installer.cmd -Reseau`, et du HTTPS devant le serveur (`docs/acces-distant.md`, « Réseau isolé » : autorité interne de Caddy, ou celle du programme).

Mettre à jour : un nouveau paquet décompressé à la place de l'ancien, puis `installer.cmd`. Il sauvegarde les données avant de relancer le serveur.

## Ce qui ne sort jamais, et ce qui pourrait sortir

`node outils/verifier-hors-ligne.mjs` relit le code livré : le serveur, la page du Wiki, la méta-interface, la CLI et l'installeur. Il échoue sur toute adresse externe écrite en dur. Il liste aussi les endroits qui ouvrent une connexion ; chacun vise une adresse que donne un humain, ou le serveur lui-même :

| Connexion | Quand | Par défaut |
|---|---|---|
| CLI → serveur | à chaque commande | vers l'adresse de `.outil.json` |
| Page du Wiki, méta-interface → leur serveur | à l'usage | même origine (CSP `default-src 'self'`) : rien d'externe ne se charge |
| Notifications par webhook | à chaque événement | **rien** tant qu'un mainteneur n'en règle pas ; une adresse interne est refusée sans `WDD_NOTIF_LOCALES=1` |
| Serveur → `127.0.0.1` | au démarrage (verrou des données) | boucle locale |
| Installeur → winget | si Node ou Git manque | proposé, jamais sans accord ; inutile avec le Node livré |
| L'agent → son fournisseur | à chaque traitement | **hors de l'outil** : l'agent autorisé et son fournisseur se choisissent avec la sécurité du programme |

## Liste de contrôle avec la sécurité du programme

- [ ] Archive relue, et manifeste vérifié à l'arrivée.
- [ ] `node outils/verifier-hors-ligne.mjs` : « OK », sur la version installée.
- [ ] HTTPS devant le serveur, avec une autorité interne ; certificat racine installé sur les postes.
- [ ] Notifications : aucune, ou vers une messagerie interne seulement (`WDD_NOTIF_LOCALES=1`).
- [ ] Sauvegarde : dossier sur un autre disque (`WDD_SAUVEGARDE`), et restauration essayée une fois (`installer.cmd -Restaurer`).
- [ ] Agent : celui autorisé par la sécurité. Ses outils sont bornés par la commande de veille (`outil veille --memoriser`), et le profil sans code (« textes ») est le seul permis si le code est sensible.
- [ ] Clone du dépôt de design (`/git/<projet>.git`) : jetons « clone » donnés au cas par cas ; le dépôt contient les ids des auteurs de retours.

## Ce qui n'est pas vérifié

- **Réseau isolé réel** : pas d'essai sur un vrai réseau isolé. L'archive a été fabriquée, décompressée, et son Node a lancé le serveur et la CLI sur le poste de développement.
- **Avant la mise en ligne** : le choix de l'agent et son fournisseur, la valeur probante des approbations (étape 3.9, E5), l'homologation : à voir avec le responsable sécurité du programme.
