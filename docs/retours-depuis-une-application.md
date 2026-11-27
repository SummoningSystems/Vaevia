# Retours depuis une application

Étape 3.9, idée I2. Un testeur envoie un retour sans quitter le logiciel qu'il essaie : un jeu, une application de bureau, un outil métier, une application web. Une touche ouvre un petit formulaire. Le retour part ancré sur la fiche de l'objet visé, celle que l'exporteur publie dans le Wiki, avec une capture de l'écran.

Le protocole ne dépend d'aucun moteur : trois requêtes HTTP. Le greffon Godot (`adaptateurs/godot/`) n'en est que le premier adaptateur ; un exemple `curl` suit, et tout autre langage fait de même.

## Principe

- **Ancrage** : l'application connaît la ref de ce qu'elle montre, la même que dans le `data.json` de l'exporteur : `sorte:ref`, par exemple `ecran:options`, `plante:tomate`, `arme:arc-long`. Elle l'envoie comme cible.
  - Le serveur retrouve la fiche dans le dernier build, ancienne ref comprise, et complète le nom, l'onglet et l'ancre.
  - Une cible inconnue du dernier build, ou aucune cible, donne un retour « sans fiche » que l'équipe range.
- **Jeton** : jamais de jeton d'agent dans un build distribué. L'application obtient un jeton « retour » par appairage : elle affiche un code, et le testeur l'autorise dans son navigateur, où il est connecté.
  - Le jeton ne fait que créer des retours et envoyer des captures, au nom du testeur : il ne lit rien.
  - Il expire au bout de 30 jours, ou à la fin de l'accès d'un testeur externe.
  - Il est gardé sur la machine du testeur, jamais dans le build.
- **Plafond** : 100 retours et 50 captures par personne et par jour (tous ses jetons « retour » ensemble ; le même plafond vaut pour un testeur externe dans le Wiki). Un nouvel appairage ne le remet pas à zéro.

## Le protocole

| Étape | Requête | Réponse |
|---|---|---|
| 1. Demander un appairage | `POST /api/appairage` `{ "poste": "Mon jeu · Windows", "projet": "<projet>", "role": "retour" }` | `201 { code_appareil, code, expire, intervalle }` |
| 2. Le testeur autorise | il ouvre `<serveur>/appairage?code=<code>` et clique « Autoriser » | (navigateur) |
| 3. Venir chercher le jeton | `POST /api/appairage/jeton` `{ "code_appareil": "…" }`, toutes les `intervalle` secondes | `202` en attente, `200 { jeton, expire, … }` une fois, `410` refusé ou expiré |
| 4. Joindre une capture (facultatif) | `POST /api/p/<projet>/captures`, corps PNG ou WebP brut, 2 Mio et 4096 px au plus, `Authorization: Bearer <jeton>` | `201 { id }` |
| 5. Envoyer le retour | `POST /api/p/<projet>/retours/app`, `Authorization: Bearer <jeton>` | `201 { id, fiche: { trouvee, kind, ref, name, anchor } }` |

Corps de l'étape 5 :

| Clé | Obligatoire | Valeur |
|---|---|---|
| `text` | oui | le retour, non vide |
| `cible` | non | `sorte:ref` ; absente : retour sans fiche |
| `cat` | non | `bug` (défaut), `idee`, `texte`, `fort`, `faible`, `autre` |
| `captures` | non | ids rendus par l'étape 4, 3 au plus |
| `contexte` | non | une ligne, 300 caractères au plus : version, écran, système ; ajoutée à la fin du texte |

Réponses d'erreur :
- 401 : jeton révoqué, expiré, ou propriétaire sans accès. Il faut appairer à nouveau.
- 403 : route refusée à ce jeton.
- 400 : corps invalide (le message dit quoi).
- 429 : plafond du jour atteint.

Les mêmes routes servent à tout auteur de retours en session, ou avec un jeton « retour » créé dans Membres → Jetons. C'est utile pour un poste de démonstration ou un outil maison.

## Exemple avec curl

```sh
S=https://retours.exemple.fr P=potager
# 1 à 3 : appairage (une fois par machine)
curl -s -X POST $S/api/appairage -H 'Content-Type: application/json' -d '{"poste":"Essai curl","projet":"'$P'","role":"retour"}'
#   → ouvrir $S/appairage?code=XXXX-XXXX dans le navigateur, autoriser, puis :
curl -s -X POST $S/api/appairage/jeton -H 'Content-Type: application/json' -d '{"code_appareil":"<code_appareil>"}'
# 4 et 5 : un retour avec capture
ID=$(curl -s -X POST $S/api/p/$P/captures -H "Authorization: Bearer $JETON" -H 'Content-Type: image/png' --data-binary @ecran.png | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -X POST $S/api/p/$P/retours/app -H "Authorization: Bearer $JETON" -H 'Content-Type: application/json' \
  -d '{"text":"Le bouton Semer est caché","cible":"ecran:semis","cat":"bug","captures":["'$ID'"],"contexte":"Potager 0.3 · Windows"}'
```

## Adaptateur Godot 4

Le greffon est dans `adaptateurs/godot/addons/retours_app/`.

1. **Installer** : copie le dossier `addons/retours_app` dans le projet, puis active le greffon (Projet → Paramètres du projet → Greffons). Il ajoute le nœud autochargé `RetoursApp`.
2. **Régler** (Paramètres du projet, section `retours_app`) :
   - `serveur` : l'adresse du serveur ;
   - `projet` : l'id du projet ;
   - `touche` : F8 par défaut ;
   - `actif` : `debug` par défaut, c'est-à-dire seulement dans les builds de débogage ; `toujours` pour un build de test exporté en version publiée ; `jamais`.
3. **Ancrer** : pose la méta `retours_ref` sur les nœuds qui correspondent à une fiche du Wiki, avec la même ref que l'exporteur : la racine d'une scène pour un écran (`ecran:options`), un contrôle ou un objet pour un élément (`arme:arc-long`).
   - La cible est le contrôle survolé, ou son parent le plus proche qui porte la méta. Sinon, c'est la racine de la scène courante. Sinon, le retour part sans fiche.
   - Pour un objet du monde (2D, 3D), appelle `RetoursApp.envoyer(texte, "arme:arc-long")` depuis ton propre code de sélection.
4. **Utiliser** :
   - La touche capture l'écran, puis ouvre le formulaire (texte, catégorie, capture jointe ou non).
   - La première fois, le formulaire propose de relier la copie au serveur. Il montre le code, ouvre le navigateur, et garde le jeton dans `user://retours_app.cfg`.
   - Sans formulaire : `RetoursApp.envoyer(texte, cible, categorie, image)`, `RetoursApp.appairer()`, `RetoursApp.cible_courante()`. Signaux : `envoye(id)`, `erreur(message)`, `code_appairage(code, adresse)`, `appaire(nom)`.

## Ce qui est vérifié

- **Protocole** : `serveur/test/app.test.ts`, 5 tests en `fetch` nu, sans adaptateur :
  - cible complétée d'après le dernier build, ancienne ref suivie, cible inconnue ou absente ;
  - capture jointe, et validation du corps ;
  - le jeton n'ouvre rien d'autre, ni l'API, ni la page, ni les versions ;
  - plafond par personne (un nouveau jeton ne le remet pas à zéro) ;
  - appairage autorisé par un testeur externe, rôle jamais élargi, retour marqué externe, jeton coupé à la fin de son accès.
- **Écran d'appairage** dans le navigateur (`wiki.mjs`) : seul le rôle « retour » est proposé, avec le nom « Application · … ».
- **Greffon avec Godot 4.7.2**, sur un projet temporaire (`adaptateurs/godot/essai/essai.mjs`, 12 vérifications) :
  - cible lue sur la scène ;
  - envoi avec capture ;
  - cible explicite ;
  - F8 ouvre le formulaire ;
  - appairage fait par le greffon lui-même (code, autorisation, jeton gardé dans `user://`, envoi).
- **Greffon dans un clone temporaire d'un vrai jeu** : envoi avec capture de l'écran du jeu, et formulaire ouvert par-dessus.
  - Deux défauts trouvés et corrigés : le jeu consommait la touche avant le greffon, d'où la lecture de l'état de la touche à chaque image ; et le formulaire était mal centré.

## Ce qui n'est pas vérifié

- Un build exporté (seulement l'éditeur et l'exécution du projet), et HTTPS depuis Godot : le certificat d'un serveur auto-hébergé doit être reconnu par le système.
- Unity, Unreal, une application web : pas d'adaptateur ; le protocole ci-dessus suffit.
- La pose de la méta `retours_ref` par l'exporteur : c'est au projet de la faire, en reprenant les refs de son `data.json`.
