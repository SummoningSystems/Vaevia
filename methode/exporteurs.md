# Exporteurs

Complément de `METHODE.md` (§ 4 et § 5). Le schéma complet de `data.json` est dans `site/SCHEMA.md` du dépôt de l'outil ; `site/build.js`, lancé par le serveur à chaque `outil export envoyer`, en est le juge.

L'exporteur est le seul code propre au projet. Il vit **dans le dépôt du code**, par convention dans `tools/site-retours/` (un seul dossier pour tout le projet, tirets compris, même sous Godot : `res://tools/site-retours/` est valide). Il est commité. Il écrit `data.json` **hors du dépôt**, dans le dossier de travail de l'agent (chemin passé en argument), puis :

```
outil export envoyer <dossier de travail>/data.json
```

Le serveur lit les notes datées de son dépôt de design, construit le Wiki et répond par le numéro de build, le poids et l'URL. Une erreur de construction revient avec le message de `build.js` (code de sortie 1) : la corriger **dans l'exporteur**, jamais en retouchant `data.json` à la main.

## Principes

- **Lire ce que le projet utilise vraiment** : les ressources chargées par le jeu, la configuration lue par l'application, les fonctions qui calculent les valeurs affichées. Si l'écran montre « 12 dégâts » ou « seuil d'alarme 45 °C » via une formule, l'exporteur appelle la même formule, il ne la recopie pas.
- **Jamais de valeur en dur** dans l'exporteur : une constante de démonstration devient vite fausse. Seuls les libellés de présentation (noms d'onglets, de champs) sont écrits à la main.
- **Refs stables** : l'id de chaque élément vient du projet (nom de fichier, clé, route, GUID, identifiant d'exigence), jamais d'un compteur ni d'un ordre d'affichage. Un renommage inévitable se déclare dans `anciennes_refs` de l'élément (liste des anciens id, même sorte) : ses retours restent sur la fiche et le Wiki montre « Ref avant → après » dans l'onglet Changements. Une table de correspondance tenue dans l'exporteur suffit (`{"gobelin": ["goblin"]}`), à garder tant que des retours ouverts portent l'ancienne ref.
- **Sûr** : refuser de tourner sans `--out`, refuser une sortie dans le dépôt ou dans les données de l'utilisateur, ne charger ni écrire aucune sauvegarde ou base réelle, ne rien exporter de secret (clés, jetons, mots de passe, e-mails, adresses internes, données de joueurs, d'utilisateurs ou de clients). Lister explicitement les champs exportés (liste blanche) plutôt que tout sérialiser : un objet sérialisé tel quel est de toute façon refusé par le build.
- **Valeurs** : texte, nombre, booléen ou liste de ceux-ci. Les nombres sont affichés au format du Wiki (`2.5` → « 2,5 » en français) ; une valeur à montrer telle quelle (version, code, année avec séparateur) s'écrit en texte. `null`, `NaN`, un objet : refusés.
- **Images** : si les éléments en ont une, la fiche la montre, en URI `data:` (64 à 128 px), lue dans le fichier source : section « Images » ci-dessous. Une URL `http(s)` est refusée. Le Wiki entier ne dépasse pas 16 Mio.
- **Liens internes** : écrire l'id brut du projet (`#regles--reminder.monthly`) ; le build le réduit en ancre et vérifie qu'elle existe.
- **Types de retour** adaptés au domaine dans `ui.fb.cats` (« Trop fort / Trop faible » sont des types de jeu). Pour une application : `[["bug","Bug"],["ergonomie","Ergonomie"],["texte","Texte"],["idee","Idée"],["autre","Autre"]]`.
- **Rapide et sans fenêtre** : quelques secondes ; affiche un résumé (`N onglets, M éléments -> chemin`) et sort avec un code non nul en cas d'erreur.
- `generated` = date ISO de l'export, prise sur l'horloge du système ; ajouter si possible le commit courant dans `subtitle` (« hors git » sinon, sans planter).

Pour une pile absente ci-dessous (C++, Rust, Java, base de données, fichiers d'exigences) : même forme. Un petit programme dans `tools/site-retours/`, lancé depuis la racine du dépôt, qui lit ce que le logiciel lit (ou appelle ses propres modules) et écrit le JSON. Si le langage du projet ne sait pas écrire le JSON facilement, faire écrire au projet un fichier intermédiaire (CSV, configuration) et le convertir en Node ou en Python, sans recopier de valeur.

## Kit de départ (`outil exporteur`)

Deux exporteurs prêts à poser, le temps d'en écrire un propre au projet :

```
outil exporteur donnees     # fichiers JSON ou CSV du projet
outil exporteur markdown    # documents de design en Markdown (section Markdown, plus bas)
```

- **Ce que fait la commande** : elle écrit l'exporteur dans `tools/site-retours/` (`export.mjs`, ou `export-md.mjs`), recopié depuis ce document. Si `.outil.json` n'a pas encore de `publier.exporteur`, elle le déclare. Un fichier déjà là n'est jamais remplacé sans `--forcer`.
- **Ce qu'il reste à faire** : remplir les réglages en tête du fichier (`SOURCES`, ou `DOCS`, `SORTES`, `ORDRE`), choisir les champs utiles à la décision, puis publier (`outil publier`).
- **Limite** : un exporteur générique lit des fichiers. Une valeur calculée par le jeu ou l'application (dégâts réels, seuil appliqué) demande un exporteur qui appelle les fonctions du projet (sections par moteur et par langage, plus bas). YAML : le convertir avec l'outil du projet, ou écrire l'exporteur dans la pile du projet, qui sait déjà le lire.

L'exporteur « donnees » (vérifié avec `build.js` sur un JSON indexé, avec image et virgule décimale, et un CSV à « ; » avec une cellule entre guillemets) :

`tools/site-retours/export.mjs` (kit « donnees »)
```js
// node tools/site-retours/export.mjs --out=<chemin du json hors dépôt>
// Exporteur de départ (outil exporteur donnees) : des fichiers JSON ou CSV du projet → data.json du Wiki. À adapter :
// remplir SOURCES (un onglet par fichier), puis choisir les champs utiles à la décision (METHODE § 4, étape 1).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TITRE = "Données du projet", IMAGE_MAX = 200 * 1024;
const CATS = null;   // types de retour du domaine, ex. [["fort","Trop fort"],["faible","Trop faible"],["texte","Texte"],["idee","Idée"],["autre","Autre"]]
// Une source par onglet. fichier : chemin depuis la racine du dépôt (.json ou .csv) ; chemin : où est la liste dans un
// JSON (« donnees.ennemis »), vide si le fichier est la liste ; id, nom : colonnes ou clés (id absent d'un objet indexé :
// la clé) ; champs : les colonnes montrées, dans l'ordre ([] : toutes les valeurs simples), ou { cle: "Libellé" } ;
// image : colonne d'un chemin d'image (relatif au fichier, ou au dépôt) ; texte : colonne d'une description courte.
const SOURCES = [
	// { fichier: "data/ennemis.json", chemin: "", onglet: "ennemis", libelle: "Ennemis", sorte: "ennemi", libelleSorte: "Ennemi",
	//   id: "id", nom: "nom", champs: { pv: "PV", vitesse: "Vitesse", degats: "Dégâts" }, image: "icone", texte: "description" },
];
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6);
if (!out || path.resolve(out).startsWith(root + path.sep)) { console.error("--out=<chemin hors dépôt> obligatoire"); process.exit(2); }
if (!SOURCES.length) { console.error("SOURCES est vide : décrire les fichiers à lire en tête de cet exporteur"); process.exit(1); }
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
const simple = v => ["string", "number", "boolean"].includes(typeof v);
const valeur = v => typeof v === "string" && /^-?\d+(?:[.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(",", ".")) : v;
function csv(t) {   // séparateur deviné sur la première ligne (; , ou tabulation), guillemets doublés
	t = t.replace(/^﻿/, "");
	const sep = [";", "\t", ","].map(s => [s, (t.split(/\r?\n/)[0].match(new RegExp(s === "\t" ? "\t" : "\\" + s, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
	const lignes = []; let l = [], c = "", q = false;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (q) { if (ch === '"' && t[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
		else if (ch === '"') q = true;
		else if (ch === sep) { l.push(c); c = ""; }
		else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; l.push(c); c = ""; if (l.some(x => x !== "")) lignes.push(l); l = []; }
		else c += ch;
	}
	l.push(c); if (l.some(x => x !== "")) lignes.push(l);
	const [tete, ...reste] = lignes;
	return reste.map(r => Object.fromEntries(tete.map((h, k) => [h.trim(), r[k] ?? ""])));
}
let manquantes = 0;
function image(src, fichier) {
	if (!src || typeof src !== "string") return null;
	const cand = [path.resolve(path.dirname(fichier), src), path.resolve(root, src.replace(/^res:\/\//, ""))];
	const f = cand.find(x => fs.existsSync(x));
	const mime = f && MIME[path.extname(f).toLowerCase()];
	if (!f || !mime || fs.statSync(f).size > IMAGE_MAX) { manquantes++; return null; }
	return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
}
const kinds = {}, tabs = [];
for (const s of SOURCES) {
	const fichier = path.join(root, s.fichier);
	let liste = s.fichier.toLowerCase().endsWith(".csv") ? csv(fs.readFileSync(fichier, "utf8")) : JSON.parse(fs.readFileSync(fichier, "utf8"));
	for (const k of (s.chemin || "").split(".").filter(Boolean)) liste = liste?.[k];
	if (liste && !Array.isArray(liste) && typeof liste === "object") liste = Object.entries(liste).map(([k, v]) => ({ [s.id || "id"]: k, ...v }));
	if (!Array.isArray(liste)) { console.error(`${s.fichier} : liste introuvable (chemin « ${s.chemin || ""} »)`); process.exit(1); }
	const pris = new Set([s.id, s.nom, s.image, s.texte].filter(Boolean));
	const libelles = Array.isArray(s.champs) ? Object.fromEntries(s.champs.map(c => [c, c])) : s.champs && typeof s.champs === "object" ? s.champs : {};
	const items = liste.map((o, i) => {
		const id = String(o[s.id || "id"] ?? "");
		if (!id) { console.error(`${s.fichier} : élément ${i + 1} sans « ${s.id || "id"} »`); process.exit(1); }
		const cles = Object.keys(libelles).length ? Object.keys(libelles) : Object.keys(o).filter(k => !pris.has(k) && simple(o[k]));
		const fields = cles.filter(k => o[k] !== undefined && o[k] !== null && o[k] !== "").map(k => [String(libelles[k] || k[0].toUpperCase() + k.slice(1)), valeur(o[k])]).filter(([, v]) => simple(v));
		const im = s.image ? image(o[s.image], fichier) : null;
		return { id, kind: s.sorte, name: String(o[s.nom || "nom"] ?? id), ...(im ? { image: im } : {}), ...(fields.length ? { fields } : {}), ...(s.texte && o[s.texte] ? { text: String(o[s.texte]).slice(0, 600) } : {}) };
	});
	kinds[s.sorte] = s.libelleSorte || s.sorte;
	tabs.push({ id: s.onglet, label: s.libelle, intro: `Lu dans ${s.fichier}.`, sections: [{ id: "tous", title: s.libelle, items }] });
}
fs.writeFileSync(out, JSON.stringify({ title: TITRE, generated: new Date().toISOString(), kinds, ...(CATS ? { ui: { fb: { cats: CATS } } } : {}), tabs }, null, "\t"));
console.log(`export OK : ${tabs.length} onglets, ${tabs.reduce((n, t) => n + t.sections[0].items.length, 0)} éléments${manquantes ? `, ${manquantes} image(s) introuvable(s) ou trop lourde(s)` : ""} -> ${out}`);
```

## Images

Si les éléments du projet ont une image (icône, sprite, portrait, capture d'écran), la fiche la montre : champ `image` de l'élément, en URI `data:` (le serveur ne sert que le Wiki, sans fichier à côté).

- **Le fichier source** (`.png`, `.svg`…), jamais la ressource importée par le moteur : un clone neuf n'a pas le cache d'import (`.godot/` de Godot, `Library/` d'Unity), et l'exporteur tourne souvent dans un clone neuf.
- **Petite** : 64 à 128 px de côté, en PNG. Une icône de 96 px pèse de 2 à 6 Ko ; au-delà d'un Wiki de 2 Mo, le build prévient.
- **Pixel art** : réduire au plus proche voisin, et `"pixelArt": true` dans `data.json` (images affichées sans lissage).
- **Image agrandie** (facultatif) : `image_grande`, une seconde URI `data:` plus grande (512 px au plus), montrée au clic sur l'image de la fiche. Sans elle, le clic montre l'image de la fiche. À garder pour ce qui se juge en grand (sprite, portrait, écran) : le Wiki entier reste sous 16 Mio.
- **Image introuvable** : pas de champ `image`, la fiche reste lisible ; l'exporteur le dit dans son résumé (« 3 images introuvables »), sans échouer.
- **Jamais le chemin écrit en texte** dans `fields` (`["Icône", "res://…png"]`) : le build le signale (« image écrite comme du texte : … »).
- Vérifier le rendu : `outil apercu`, puis regarder les captures (`METHODE.md` § 4).

**Godot 4** (vérifié avec Godot 4.7 dans un projet sans `.godot/`, lancé par `-s`) :
```gdscript
## Image en URI data: PNG, côté le plus long réduit à `taille` px. Lit le fichier source (png, jpg, webp, svg) par son
## chemin absolu : la texture importée n'existe pas dans un clone neuf, et un chemin res:// donnerait un avertissement.
static func image_data(chemin: String, taille := 96, pixel := false) -> String:
	if chemin.is_empty() or not FileAccess.file_exists(chemin):
		return ""
	var img := Image.load_from_file(ProjectSettings.globalize_path(chemin))
	if img == null or img.is_empty():
		return ""
	if img.is_compressed():
		img.decompress()
	var cote := maxi(img.get_width(), img.get_height())
	if cote > taille:
		var k := float(taille) / cote
		img.resize(maxi(1, roundi(img.get_width() * k)), maxi(1, roundi(img.get_height() * k)),
			Image.INTERPOLATE_NEAREST if pixel else Image.INTERPOLATE_LANCZOS)
	return "data:image/png;base64," + Marshalls.raw_to_base64(img.save_png_to_buffer())

## Chemin de l'image d'une ressource (.tres, .tscn) SANS la charger : ses dépendances, lues dans le fichier.
static func image_de(ressource: String) -> String:
	for dep in ResourceLoader.get_dependencies(ressource):
		var p: String = dep.get_slice("::", dep.get_slice_count("::") - 1)   # « res://… » ou « uid://…::Type::res://… »
		if p.get_extension().to_lower() in ["png", "jpg", "jpeg", "webp", "svg"]:
			return p
	return ""
```
Emploi : `"image": image_data(image_de(ITEMS_DIR + f))`, ou `image_data(String(ligne["icon"]))` pour un chemin lu dans un CSV ; n'ajouter la clé que si le résultat n'est pas vide.

**Node** (aucune dépendance : pas de redimensionnement ; une icône déjà petite, ou un SVG, passe telle quelle) :
```js
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".gif": "image/gif" };
function imageData(fichier, max = 64 * 1024) {                 // chemin relatif à la racine du dépôt
  const p = path.join(root, fichier), type = MIME[path.extname(p).toLowerCase()];
  if (!type || !fs.existsSync(p)) return undefined;             // pas d'image : la fiche reste lisible
  const b = fs.readFileSync(p);
  if (b.length > max) { console.warn(`attention : ${fichier} : ${b.length} octets, trop lourd pour une icône`); return undefined; }
  return `data:${type};base64,${b.toString("base64")}`;
}
```
Une image plus lourde : une vignette faite par un outil que le projet a déjà, jamais une dépendance ajoutée pour cela.

**Python** (Pillow s'il est déjà là, sinon le fichier tel quel jusqu'à 64 Kio) :
```python
import base64, io, mimetypes
def image_data(chemin, taille=96):
    p = root / chemin
    if not p.is_file():
        return None                                   # pas d'image : la fiche reste lisible
    try:
        from PIL import Image
    except ImportError:
        if p.stat().st_size > 64 * 1024:
            return None
        return f"data:{mimetypes.guess_type(p.name)[0]};base64," + base64.b64encode(p.read_bytes()).decode()
    with Image.open(p) as im:
        im.thumbnail((taille, taille))                # pixel art : im.thumbnail((taille, taille), Image.Resampling.NEAREST)
        b = io.BytesIO(); im.save(b, "PNG")
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()
```

**Unity** (voie 1) : lire le fichier source de l'asset, pas la texture importée (souvent illisible sans *Read/Write*) :
```csharp
// path : AssetDatabase.GetAssetPath(e.icon), relatif au projet (« Assets/…/epee.png »). Graphics.Blit : pas de -nographics.
static string ImageData(string path, int taille = 96) {
    var src = new Texture2D(2, 2);
    if (string.IsNullOrEmpty(path) || !File.Exists(path) || !src.LoadImage(File.ReadAllBytes(path))) return null;
    float k = Mathf.Min(1f, (float)taille / Mathf.Max(src.width, src.height));
    int w = Mathf.Max(1, Mathf.RoundToInt(src.width * k)), h = Mathf.Max(1, Mathf.RoundToInt(src.height * k));
    var rt = RenderTexture.GetTemporary(w, h); Graphics.Blit(src, rt);
    var avant = RenderTexture.active; RenderTexture.active = rt;
    var dst = new Texture2D(w, h, TextureFormat.RGBA32, false); dst.ReadPixels(new Rect(0, 0, w, h), 0, 0); dst.Apply();
    RenderTexture.active = avant; RenderTexture.ReleaseTemporary(rt);
    return "data:image/png;base64," + Convert.ToBase64String(dst.EncodeToPNG());
}
```
Voie 2 (lecture texte) : la fonction Node ci-dessus, avec le chemin retrouvé par le GUID de l'icône (le `.meta` qui porte ce `guid`).

## Godot 4 (GDScript, sans fenêtre)

Une scène dédiée (les autoloads du projet sont chargés, contrairement à `-s`) :

`tools/site-retours/export.tscn`
```
[gd_scene load_steps=2 format=3]
[ext_resource type="Script" path="res://tools/site-retours/export.gd" id="1"]
[node name="Export" type="Node"]
script = ExtResource("1")
```

`tools/site-retours/export.gd`
```gdscript
extends Node
## Export du Wiki : lit les vraies ressources du jeu et écrit data.json.
##   godot --headless --path . res://tools/site-retours/export.tscn -- --out=<chemin absolu du json, hors projet>

const ITEMS_DIR := "res://res/items/"

func _ready() -> void:
	var out := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--out="): out = a.substr(6)
	var root := ProjectSettings.globalize_path("res://")
	if out.is_empty() or out.begins_with("user://") or out.begins_with("res://") or out.simplify_path().begins_with(root.simplify_path()):
		push_error("export : --out=<chemin absolu hors projet> obligatoire"); get_tree().quit(2); return
	var items: Array = []
	for f in DirAccess.get_files_at(ITEMS_DIR):
		f = f.trim_suffix(".remap")
		if not f.ends_with(".tres"): continue
		var res: Resource = load(ITEMS_DIR + f)
		if res == null:                          # clone neuf sans import : voir plus bas
			push_error("export : %s illisible" % f); get_tree().quit(1); return
		var id := f.get_basename()               # ref stable : le nom de la ressource
		items.append({
			"id": id, "kind": "objet", "name": tr(res.display_name),
			"fields": [["Prix", res.price], ["Effet", res.describe()]],   # la fonction du jeu, pas une copie
		})
	var data := {
		"title": ProjectSettings.get_setting("application/config/name"),
		"generated": Time.get_datetime_string_from_system(true) + "Z",
		"kinds": {"objet": "Objet"},
		"tabs": [{"id": "objets", "label": "Objets", "sections": [{"id": "tous", "title": "Tous les objets", "items": items}]}],
	}
	var file := FileAccess.open(out, FileAccess.WRITE)
	if file == null:
		push_error("export : écriture impossible de %s" % out); get_tree().quit(1); return
	file.store_string(JSON.stringify(data, "\t"))
	file.close()
	print("export OK : %d objets -> %s" % [items.size(), out])
	get_tree().quit(0)
```
- Si le jeu charge une sauvegarde au démarrage (autoload), prévoir un mode « contrôle » qui ne lit ni n'écrit la vraie sauvegarde, et le vérifier dans l'exporteur avant tout.
- Un `Dictionary` ou une `Resource` mis tel quel dans `fields` est refusé : extraire les valeurs une à une.
- **Clone neuf** (pas de `.godot/`) : `load()` d'une ressource qui référence une texture, un son ou une scène importés rend `null` (« No loader found »). Lancer une fois `godot --headless --path . --import` (vérifié avec Godot 4.7 : crée `.godot/`, ignoré par Git, et les `.import` absents à côté des sources ; il crée aussi un `.uid` à côté de chaque script qui n'en a pas : s'ils ne sont pas suivis par Git, ils restent hors de la liste des fichiers à commiter avec le Wiki), ou lire ce qu'il faut sans charger ces ressources (CSV, `image_de()` ci-dessus). Un `null` arrête l'export avec un message, jamais une fiche vide en silence.
- Images : section « Images » ci-dessus (`image_data()`, `image_de()`).
- Windows : `godot_console.exe` pour voir la sortie.

## Unity

Deux voies. La première donne les valeurs **calculées** (méthodes, propriétés) ; la seconde, seulement les valeurs **sérialisées**, mais marche éditeur ouvert.

**Piège** : `-batchmode` refuse de démarrer si le projet est déjà ouvert dans l'éditeur. Fermer Unity, ou appeler la même fonction depuis un menu de l'éditeur (`[MenuItem]` ci-dessous), ou prendre la voie texte.

### Voie 1 : script d'éditeur C# (batchmode ou menu)

`Assets/Editor/SiteRetoursExport.cs`
```csharp
// Unity.exe -batchmode -quit -projectPath <projet> -executeMethod SiteRetoursExport.Run -out=<chemin du json hors projet> -logFile -
using System; using System.Collections.Generic; using System.Globalization; using System.IO; using System.Text;
using UnityEditor; using UnityEngine;

public static class SiteRetoursExport {
    public static void Run() {
        string outPath = null;
        foreach (var a in Environment.GetCommandLineArgs()) if (a.StartsWith("-out=")) outPath = a.Substring(5);
        int code = Export(outPath);
        EditorApplication.Exit(code);   // sans Exit, un échec sortirait quand même avec 0
    }

    [MenuItem("Tools/Site de retours/Exporter data.json")]
    static void FromMenu() {
        var p = EditorUtility.SaveFilePanel("data.json du Wiki (hors projet)", "", "data.json", "json");
        if (!string.IsNullOrEmpty(p)) Export(p);
    }

    static int Export(string outPath) {
        var project = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        if (string.IsNullOrEmpty(outPath) || Path.GetFullPath(outPath).StartsWith(project, StringComparison.OrdinalIgnoreCase)) {
            Debug.LogError("export : -out=<chemin hors projet> obligatoire"); return 2;
        }
        try {
            var items = new List<string>();
            foreach (var guid in AssetDatabase.FindAssets("t:EnemyData")) {         // le type du projet
                var e = AssetDatabase.LoadAssetAtPath<EnemyData>(AssetDatabase.GUIDToAssetPath(guid));
                items.Add(Obj(
                    ("id", Str(guid)),                       // ref stable : le GUID survit à un renommage
                    ("kind", Str("ennemi")), ("name", Str(e.displayName)), ("subtitle", Str(e.name)),
                    ("fields", Arr(Field("PV", e.maxHp), Field("Dégâts", e.Damage()), Field("Vitesse", e.speed)))));   // e.Damage() : la méthode du jeu
            }
            var json = Obj(
                ("title", Str(Application.productName)), ("generated", Str(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"))),
                ("kinds", Obj(("ennemi", Str("Ennemi")))),
                ("tabs", Arr(Obj(("id", Str("ennemis")), ("label", Str("Ennemis")),
                    ("sections", Arr(Obj(("id", Str("tous")), ("title", Str("Ennemis")), ("items", Arr(items.ToArray())))))))));
            File.WriteAllText(outPath, json, new UTF8Encoding(false));
            Debug.Log($"export OK : {items.Count} ennemis -> {outPath}");
            return 0;
        } catch (Exception ex) { Debug.LogException(ex); return 1; }
    }

    // JSON à la main : JsonUtility ne sait ni les dictionnaires ni les listes hétérogènes.
    static string Str(string s) {
        var b = new StringBuilder("\"");
        foreach (var c in s ?? throw new Exception("texte nul")) {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c == '\n') b.Append("\\n");
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
    static string Val(object v) {
        switch (v) {
            case string s: return Str(s);
            case bool x: return x ? "true" : "false";
            case float f when !float.IsNaN(f) && !float.IsInfinity(f): return f.ToString("R", CultureInfo.InvariantCulture);
            case double d when !double.IsNaN(d) && !double.IsInfinity(d): return d.ToString("R", CultureInfo.InvariantCulture);
            case int i: return i.ToString(CultureInfo.InvariantCulture);
            default: throw new Exception("valeur non exportable : " + v);
        }
    }
    static string Field(string label, object v) => "[" + Str(label) + "," + Val(v) + "]";
    static string Arr(params string[] xs) => "[" + string.Join(",", xs) + "]";
    static string Obj(params (string k, string v)[] kv) { var p = new List<string>(); foreach (var (k, v) in kv) p.Add(Str(k) + ":" + v); return "{" + string.Join(",", p) + "}"; }
}
```
Lancement : `"<Unity>/Editor/Unity.exe" -batchmode -quit -projectPath . -executeMethod SiteRetoursExport.Run -out=<travail>/data.json -logFile -`. Lire la sortie (`-logFile -`) : une erreur de compilation du projet empêche l'export.

### Voie 2 : lecture texte des `.asset` (Node, éditeur ouvert)

Possible seulement si le projet sérialise en texte (*Project Settings > Editor > Asset Serialization : Force Text*, le réglage par défaut). Limites : valeurs **brutes** telles que sérialisées (pas de propriété calculée, pas de formule), références vers d'autres assets sous forme de GUID, noms de champ C# (`maxHp`) plutôt que libellés de l'inspecteur.

`tools/site-retours/export-unity-yaml.mjs`
```js
// node tools/site-retours/export-unity-yaml.mjs --out=<chemin du json hors dépôt>
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6);
if (!out || path.resolve(out).startsWith(root + path.sep)) { console.error("--out=<chemin hors dépôt> obligatoire"); process.exit(2); }
const DIR = path.join(root, "Assets/Data/Enemies");
// GUID du script EnemyData.cs, lu dans son .meta : seuls les assets de ce type sont exportés.
const SCRIPT_GUID = fs.readFileSync(path.join(root, "Assets/Scripts/EnemyData.cs.meta"), "utf8").match(/^guid: (\w+)/m)[1];
const scalar = v => { v = v.trim(); return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.replace(/^"(.*)"$/, "$1"); };
const items = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith(".asset")).sort()) {
  const y = fs.readFileSync(path.join(DIR, f), "utf8");
  if (!y.includes(`guid: ${SCRIPT_GUID}`)) continue;
  const o = Object.fromEntries([...y.matchAll(/^  (\w+): (.*)$/gm)].map(m => [m[1], scalar(m[2])]));   // champs de premier niveau
  const guid = fs.readFileSync(path.join(DIR, f + ".meta"), "utf8").match(/^guid: (\w+)/m)[1];      // ref stable
  items.push({ id: guid, kind: "ennemi", name: o.displayName || o.m_Name, subtitle: o.m_Name,
    fields: [["PV", o.maxHp], ["Dégâts", o.damage], ["Vitesse", o.speed]] });
}
fs.writeFileSync(out, JSON.stringify({ title: "Mon jeu", generated: new Date().toISOString(), kinds: { ennemi: "Ennemi" },
  tabs: [{ id: "ennemis", label: "Ennemis", sections: [{ id: "tous", title: "Ennemis", items }] }] }, null, "\t"));
console.log(`export OK : ${items.length} ennemis -> ${out}`);
```
Une valeur absente (champ renommé) donne `undefined`, que le build refuse : c'est voulu.

## Écrans (captures du logiciel)

L'onglet « Écrans » (`METHODE.md` § 4, étape 1) montre chaque écran ou interface du logiciel, capturé par un script à partir du vrai logiciel. Il est à proposer pour toute application, tout jeu, tout logiciel avec une interface.

- **Une fiche par écran** : `id` stable (la route, le nom de la scène, l'id de la fenêtre), `kind: "ecran"`, `image` (vignette de 320 px) et `image_grande` (1280 px au plus, montrée au clic), des champs (route ou scène, comment on y arrive), un `text` court, et des `links` vers les fiches de ce qu'il montre.
- **La liste des écrans vient du projet** quand c'est possible : routes du routeur, scènes du jeu, fenêtres déclarées. Sinon, une petite liste dans `tools/site-retours/ecrans.json` (id, chemin ou scène, élément à attendre), tenue dans le dépôt.
- **Données de démonstration seulement** : aucune capture sur une base réelle ni sur un compte réel. Une capture peut montrer une donnée personnelle ou un secret ; regarde-les avant d'envoyer.
- **Poids** : WebP pour la grande image (60 à 100 Kio pour 1280 × 800), vignette de 6 à 10 Kio. Trente écrans font environ 3 Mio ; le Wiki entier reste sous 16 Mio.
- **Deux temps** : le script de captures écrit `ecrans.json` dans le dossier de travail (hors du dépôt) ; l'exporteur le lit et ajoute l'onglet. Les captures se refont quand l'interface change, pas à chaque publication.
- **Le logiciel à lancer** (moteur, exécutable de l'application, navigateur) : `outil executable <nom>` donne son chemin sur ce poste (enregistré, sinon le `PATH`). Introuvable : `METHODE.md` § 4, « Logiciel à lancer » (le chercher dans ce que dit le projet, mettre en place le script de capture, sinon demander le chemin à l'humain). Les fiches sans image ne viennent qu'en dernier, quand l'humain a dit « sans » ou sous la veille, et le compte rendu le dit.

**Application web** (vérifié avec Edge sur une page servie en local : 3 écrans, 237 Kio). Le script ouvre Edge ou Chrome sans fenêtre par le protocole DevTools, sans dépendance. Il attend l'élément voulu, puis prend la grande image et la vignette par `Page.captureScreenshot` avec `clip.scale`. L'application doit tourner (`--base`).

`tools/site-retours/captures-ecrans.mjs`
```js
// node tools/site-retours/captures-ecrans.mjs --out=<dossier hors dépôt> [--base=http://127.0.0.1:5173]
// Captures des écrans d'une application web, avec Edge ou Chrome sans fenêtre (protocole DevTools, aucune dépendance).
// Écrit <out>/ecrans.json : { "<id>": { "image": "data:image/webp…", "image_grande": "data:image/webp…" } }, que
// l'exporteur lit pour l'onglet « Écrans ». L'application tourne sur des données de démonstration, jamais réelles.
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import { spawn } from "node:child_process";
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg("out"), base = (arg("base") || "http://127.0.0.1:5173").replace(/\/+$/, "");
if (!out) { console.error("--out=<dossier hors dépôt> obligatoire"); process.exit(2); }
// Les écrans : id stable (ref de la fiche), chemin à ouvrir, et au besoin un sélecteur à attendre. À lire dans le routeur
// de l'application quand c'est possible plutôt qu'à recopier ; ici, une liste tenue dans le dépôt.
const ECRANS = JSON.parse(fs.readFileSync(new URL("./ecrans.json", import.meta.url), "utf8"));   // [{ id, chemin, attendre? }]
const LARGEUR = 1280, HAUTEUR = 800, PETITE = 0.25;   // image_grande 1280 × 800 ; image 320 × 200
const NAV = process.env.OUTIL_NAVIGATEUR || ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => fs.existsSync(p));
if (!NAV) { console.error("Edge ou Chrome introuvable (OUTIL_NAVIGATEUR=<chemin>)"); process.exit(1); }
const profil = fs.mkdtempSync(path.join(os.tmpdir(), "captures-"));
const nav = spawn(NAV, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profil}`, `--window-size=${LARGEUR},${HAUTEUR}`, "about:blank"], { stdio: "ignore" });
const pause = ms => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 100 && !ws; i++) { try { const [p, c] = fs.readFileSync(path.join(profil, "DevToolsActivePort"), "utf8").split(/\r?\n/); if (p && c) ws = `ws://127.0.0.1:${p}${c}`; } catch { } await pause(150); }
const sock = new WebSocket(ws); await new Promise((ok, ko) => { sock.onopen = ok; sock.onerror = ko; });
let n = 0; const att = new Map();
sock.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && att.has(m.id)) { const a = att.get(m.id); att.delete(m.id); m.error ? a.ko(new Error(m.error.message)) : a.ok(m.result || {}); } };
const cdp = (method, params = {}, sessionId) => new Promise((ok, ko) => { const id = ++n; att.set(id, { ok, ko }); sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
const s = (m, p) => cdp(m, p, sessionId);
await s("Page.enable"); await s("Runtime.enable");
await s("Emulation.setDeviceMetricsOverride", { width: LARGEUR, height: HAUTEUR, deviceScaleFactor: 1, mobile: false });
const res = {}; let ratees = 0;
for (const e of ECRANS) {
	try {
		await s("Page.navigate", { url: base + e.chemin });
		for (let i = 0; i < 50; i++) { const r = await s("Runtime.evaluate", { expression: `document.readyState === "complete" && ${e.attendre ? `!!document.querySelector(${JSON.stringify(e.attendre)})` : "true"}`, returnByValue: true }); if (r.result.value) break; await pause(100); }
		await pause(300);   // polices, animations d'entrée
		const clip = { x: 0, y: 0, width: LARGEUR, height: HAUTEUR };
		const g = await s("Page.captureScreenshot", { format: "webp", quality: 80, clip: { ...clip, scale: 1 } });
		const p = await s("Page.captureScreenshot", { format: "webp", quality: 85, clip: { ...clip, scale: PETITE } });
		res[e.id] = { image: "data:image/webp;base64," + p.data, image_grande: "data:image/webp;base64," + g.data };
	} catch (err) { ratees++; console.error(`écran ${e.id} : ${err.message}`); }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "ecrans.json"), JSON.stringify(res));
await cdp("Browser.close").catch(() => { }); nav.kill(); await pause(300); fs.rmSync(profil, { recursive: true, force: true });
const octets = Object.values(res).reduce((t, x) => t + x.image.length + x.image_grande.length, 0);
console.log(`captures OK : ${Object.keys(res).length} écrans${ratees ? `, ${ratees} ratés` : ""}, ${Math.round(octets / 1024)} Kio -> ${path.join(out, "ecrans.json")}`);
process.exit(ratees ? 1 : 0);
```

`tools/site-retours/ecrans.json` (exemple) : `[{ "id": "accueil", "chemin": "/", "attendre": "main" }, { "id": "reglages", "chemin": "/#/reglages", "attendre": "form" }]`.

**Godot 4** (vérifié avec Godot 4.7.2 sur un projet de deux scènes). Il faut une fenêtre : `--headless` n'a pas de rendu, donc pas d'image. `--position -3000,-3000` la met hors de l'écran. Sur une CI : un affichage virtuel (`xvfb-run`). Le script instancie chaque scène, attend quelques images, lit le viewport, et écrit une vignette PNG et une grande image WebP.

```
godot --path . --position -3000,-3000 -s res://tools/site-retours/captures.gd -- --out=<dossier de travail>
```
Godot hors du `PATH` : `outil executable godot` donne son chemin sur ce poste ; introuvable, `METHODE.md` § 4, « Logiciel à lancer ». Dans `publier.exporteur`, garde le nom nu (`"godot"`) : `outil publier` lance le chemin enregistré.

`tools/site-retours/captures.gd`
```gdscript
## Captures des écrans du jeu pour l'onglet « Écrans » du Wiki. Avec une fenêtre (le mode --headless n'a pas de rendu) :
##   godot --path . -s res://tools/site-retours/captures.gd -- --out=<dossier hors du projet>
## Écrit <out>/ecrans.json : { "<id>": { "image": "data:image/png;base64,…", "image_grande": "data:image/webp;base64,…" } }.
extends SceneTree

const ECRANS := [ # id stable (ref de la fiche) et scène ; à lire dans la liste des scènes du jeu quand c'est possible
	{ "id": "menu", "scene": "res://scenes/menu.tscn" },
	{ "id": "jeu", "scene": "res://scenes/jeu.tscn" },
]
const PETITE := 320
const GRANDE := 1280

func _initialize() -> void:
	_capturer.call_deferred()

func _capturer() -> void:
	var out := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--out="): out = a.substr(6)
	if out == "":
		push_error("--out=<dossier hors du projet> obligatoire"); quit(2); return
	DirAccess.make_dir_recursive_absolute(out)
	var res := {}
	for e in ECRANS:
		var s: Node = load(e.scene).instantiate()
		root.add_child(s)
		for i in 5: await process_frame          # quelques images : mise en page, polices
		await RenderingServer.frame_post_draw
		var img := root.get_viewport().get_texture().get_image()
		var g := img.duplicate() as Image
		if g.get_width() > GRANDE: g.resize(GRANDE, int(g.get_height() * GRANDE / g.get_width()), Image.INTERPOLATE_LANCZOS)
		var p := img.duplicate() as Image
		p.resize(PETITE, int(p.get_height() * PETITE / p.get_width()), Image.INTERPOLATE_LANCZOS)
		res[e.id] = { "image": "data:image/png;base64," + Marshalls.raw_to_base64(p.save_png_to_buffer()),
			"image_grande": "data:image/webp;base64," + Marshalls.raw_to_base64(g.save_webp_to_buffer(true, 0.8)) }
		s.queue_free()
		await process_frame
	var f := FileAccess.open(out.path_join("ecrans.json"), FileAccess.WRITE)
	f.store_string(JSON.stringify(res)); f.close()
	print("captures OK : %d écrans -> %s" % [res.size(), out.path_join("ecrans.json")])
	quit(0)
```

Pour une scène qui demande un état (une partie en cours, un inventaire rempli), le script la prépare avant la capture, avec les fonctions du jeu et des données de démonstration. Unity : même principe, avec `ScreenCapture.CaptureScreenshotAsTexture()` dans un script d'éditeur lancé en mode lecture (non vérifié ici).

**Logiciel de bureau Windows** (Win32, WinForms, WPF, Qt… ; vérifié avec la Table des caractères de Windows 11, sous Windows PowerShell 5.1 et PowerShell 7 : 2 écrans, 252 Kio). Pas de dépendance : le script lance l'exécutable, attend sa fenêtre, la met à 1280 × 800, la capture par `PrintWindow` (même cachée derrière une autre fenêtre), retire la bordure invisible de Windows, puis ferme le logiciel. Un écran = un lancement, avec ses arguments (un fichier de démonstration à ouvrir, une vue). Il faut une session Windows ouverte. Le chemin de l'exécutable vient d'`outil executable <nom>` ; le script ne le cherche pas lui-même.

```
outil executable appli
pwsh -NoProfile -File tools/site-retours/captures-fenetre.ps1 -Exe "<chemin affiché>" -Out <dossier de travail>
```
Sans PowerShell 7 (`pwsh`) : `powershell -NoProfile -ExecutionPolicy Bypass -File …`. Windows PowerShell 5.1 lit un script sans BOM comme de l'ANSI et casse les accents : enregistre le fichier en UTF-8 **avec BOM**. Une application qui ouvre sa fenêtre par un lanceur (autre processus) : donne l'exécutable de l'application elle-même. Une fenêtre dessinée par le GPU (jeu, Electron) peut sortir noire : pour un jeu, le script du moteur (Godot plus haut) ; pour Electron, le navigateur sur sa page.

`tools/site-retours/ecrans-fenetre.json` (exemple) : `[{ "id": "principal", "attendre": 2 }, { "id": "reglages", "args": ["--demo", "--vue=reglages"], "attendre": 3 }]`.

`tools/site-retours/captures-fenetre.ps1`
```powershell
# powershell -NoProfile -ExecutionPolicy Bypass -File tools/site-retours/captures-fenetre.ps1 -Exe <chemin> -Out <dossier hors dépôt>
# Captures des écrans d'un logiciel de bureau Windows (Win32, WinForms, WPF, Qt…) pour l'onglet « Écrans » du Wiki :
# lance l'exécutable, attend sa fenêtre, la capture (PrintWindow, même cachée derrière une autre), puis le ferme.
# Un écran = un lancement, avec ses arguments (ouvrir un fichier de démonstration, une vue). Écrit <Out>/ecrans.json :
# { "<id>": { "image": "data:image/png;base64,…", "image_grande": "data:image/jpeg;base64,…" } }, que l'exporteur lit.
# Données de démonstration seulement : jamais un fichier ni un compte réel. Il faut une session ouverte (un bureau).
param(
	[Parameter(Mandatory = $true)][string]$Exe,   # chemin donné par « outil executable <nom> »
	[Parameter(Mandatory = $true)][string]$Out,
	[int]$Largeur = 1280, [int]$Hauteur = 800, [int]$Petite = 320
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { Write-Error "exécutable introuvable : $Exe (outil executable <nom> <chemin>)"; exit 1 }
# Les écrans : id stable (ref de la fiche), arguments, attente en secondes ; liste tenue dans le dépôt, à côté du script.
$ecrans = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot "ecrans-fenetre.json") | ConvertFrom-Json   # [{ id, args?, attendre? }]
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class Fen {
	[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
	[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int l, int ht, bool r);
	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
	[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int t);
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Gauche, Haut, Droite, Bas; }
}
"@
[void][Fen]::SetProcessDPIAware()   # tailles en pixels réels, même avec une mise à l'échelle de 125 ou 150 %
function En-Base64([System.Drawing.Bitmap]$b, [string]$format) {
	$m = New-Object System.IO.MemoryStream
	if ($format -eq "jpeg") {
		$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
		$p = New-Object System.Drawing.Imaging.EncoderParameters 1
		$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
		$b.Save($m, $codec, $p)
	} else { $b.Save($m, [System.Drawing.Imaging.ImageFormat]::Png) }
	"data:image/$format;base64," + [Convert]::ToBase64String($m.ToArray())
}
function Reduite([System.Drawing.Bitmap]$b, [int]$l) {
	if ($b.Width -le $l) { return $b }
	$r = New-Object System.Drawing.Bitmap $l, ([int]($b.Height * $l / $b.Width))
	$g = [System.Drawing.Graphics]::FromImage($r); $g.InterpolationMode = "HighQualityBicubic"; $g.DrawImage($b, 0, 0, $r.Width, $r.Height); $g.Dispose()
	$r
}
$res = [ordered]@{}; $ratees = 0
foreach ($e in $ecrans) {
	$proc = $null
	try {
		$a = @{ FilePath = $Exe; PassThru = $true }
		if ($e.args) { $a.ArgumentList = @($e.args) }
		$proc = Start-Process @a
		$h = [IntPtr]::Zero
		for ($i = 0; $i -lt 100 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 150; $proc.Refresh(); $h = $proc.MainWindowHandle }
		if ($h -eq [IntPtr]::Zero) { throw "aucune fenêtre au bout de 15 s (un lanceur qui ouvre un autre processus ? lancer l'exécutable de l'application elle-même)" }
		[void][Fen]::MoveWindow($h, 0, 0, $Largeur, $Hauteur, $true)
		Start-Sleep -Seconds ([double]($(if ($e.attendre) { $e.attendre } else { 2 })))   # mise en page, chargement
		$r = New-Object Fen+RECT; [void][Fen]::GetWindowRect($h, [ref]$r)
		$b = New-Object System.Drawing.Bitmap ($r.Droite - $r.Gauche), ($r.Bas - $r.Haut)
		$g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc()
		$ok = [Fen]::PrintWindow($h, $dc, 2)   # 2 : PW_RENDERFULLCONTENT (fenêtres dessinées par le GPU)
		$g.ReleaseHdc($dc); $g.Dispose()
		if (-not $ok) { throw "PrintWindow a échoué" }
		# Sans la bordure invisible de Windows 10 et 11 (quelques pixels noirs autour) : le cadre visible seulement.
		$v = New-Object Fen+RECT
		if ([Fen]::DwmGetWindowAttribute($h, 9, [ref]$v, 16) -eq 0) {
			$zone = New-Object System.Drawing.Rectangle ($v.Gauche - $r.Gauche), ($v.Haut - $r.Haut), ($v.Droite - $v.Gauche), ($v.Bas - $v.Haut)
			if ($zone.Width -gt 0 -and $zone.Height -gt 0 -and $zone.Right -le $b.Width -and $zone.Bottom -le $b.Height) { $b = $b.Clone($zone, $b.PixelFormat) }
		}
		$res[$e.id] = [ordered]@{ image = En-Base64 (Reduite $b $Petite) "png"; image_grande = En-Base64 (Reduite $b $Largeur) "jpeg" }
	} catch { $ratees++; Write-Warning "écran $($e.id) : $($_.Exception.Message)" }
	finally { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } }
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$f = Join-Path $Out "ecrans.json"
[System.IO.File]::WriteAllText($f, ($res | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding $false))
$ko = [int](($res.Values | ForEach-Object { $_.image.Length + $_.image_grande.Length } | Measure-Object -Sum).Sum / 1024)
Write-Output ("captures OK : {0} écrans{1}, {2} Kio -> {3}" -f $res.Count, $(if ($ratees) { ", $ratees ratés" } else { "" }), $ko, $f)
exit $(if ($ratees) { 1 } else { 0 })
```

**Dans l'exporteur** : lire `ecrans.json` s'il existe (son chemin en option, dans le dossier de travail), et ajouter l'onglet.
```js
const captures = fs.existsSync(cheminEcrans) ? JSON.parse(fs.readFileSync(cheminEcrans, "utf8")) : {};
tabs.push({ id: "ecrans", label: "Écrans", intro: "Chaque écran du logiciel, capturé sur des données de démonstration. Clique sur une capture pour l'agrandir.",
  sections: [{ id: "tous", title: "Écrans", items: ECRANS.map(e => ({ id: e.id, kind: "ecran", name: e.nom || e.id,
    ...(captures[e.id] ? { image: captures[e.id].image, image_grande: captures[e.id].image_grande } : {}),
    fields: [["Accès", e.chemin || e.scene]], ...(e.texte ? { text: e.texte } : {}), wide: false })) }] });
kinds.ecran = "Écran";
```
Une fiche sans capture reste utile (son nom, son accès, ses retours) ; le résumé de l'exporteur compte les écrans sans image.

## Node (application web, outil)

`tools/site-retours/export.mjs`
```js
// node tools/site-retours/export.mjs --out=<chemin du json hors dépôt>
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6);
if (!out || path.resolve(out).startsWith(root + path.sep)) { console.error("--out=<chemin hors dépôt> obligatoire"); process.exit(2); }
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const features = read("src/config/features.json");                  // la config que l'appli charge vraiment
const routes = read("src/routes.json");
let commit = "hors git";
try { commit = execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { }
const PARAMS = { rounding: "Arrondi", min_share: "Part minimale", day: "Jour" };   // liste blanche : rien d'autre ne sort
const data = {
  title: "Mon appli", subtitle: `Revue · ${commit}`, generated: new Date().toISOString(),
  kinds: { fonction: "Fonctionnalité", ecran: "Écran" },
  ui: { fb: { cats: [["bug", "Bug"], ["ergonomie", "Ergonomie"], ["texte", "Texte"], ["idee", "Idée"], ["autre", "Autre"]] } },
  tabs: [
    { id: "fonctions", label: "Fonctionnalités", sections: [{ id: "toutes", title: "Fonctionnalités",
      items: Object.entries(features).map(([key, f]) => ({ id: key, kind: "fonction", name: f.label,
        fields: [["Active", f.enabled], ...Object.entries(f.params).filter(([k]) => k in PARAMS).map(([k, v]) => [PARAMS[k], v])] })) }] },
    { id: "ecrans", label: "Écrans", sections: [{ id: "routes", title: "Routes",
      items: routes.map(r => ({ id: "route:" + r.path, kind: "ecran", name: r.title, fields: [["Route", r.path]],
        links: r.features.map(k => [features[k].label, "#fonctions--" + k]) })) }] },   // id brut : le build réduit l'ancre
  ],
};
fs.writeFileSync(out, JSON.stringify(data, null, "\t"));
console.log(`export OK : ${data.tabs.length} onglets -> ${out}`);
```
- Lire les JSON avec `fs` (pas `import … with { type: "json" }`).
- Config en TypeScript, alias de chemins ou code qui dépend du navigateur : faire écrire la config par l'application elle-même (script du projet qui importe le module et l'écrit en JSON), puis la lire ici. Ne jamais recopier les valeurs.

## Python (logiciel, outil, configuration)

Exemple : les paramètres et seuils d'alarme d'un logiciel de supervision, lus dans le fichier que le logiciel charge.

`tools/site-retours/export.py` (lancé comme script, jamais importé : le tiret du dossier ne gêne pas)
```python
"""python tools/site-retours/export.py --out <chemin du json hors dépôt>"""
import argparse, json, datetime, pathlib, sys, tomllib

ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); a = ap.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(a.out).resolve()
if out.is_relative_to(root): sys.exit("--out doit être hors dépôt")
cfg = tomllib.loads((root / "config" / "alarmes.toml").read_text(encoding="utf-8"))   # le fichier que le logiciel lit
NIVEAUX = {"info": "muted", "alerte": "warn", "critique": "bad"}
items = [{"id": key, "kind": "alarme", "name": al["libelle"],          # ref stable : la clé de l'alarme
          "badges": [{"text": al["niveau"], "tone": NIVEAUX.get(al["niveau"], "muted")}],
          "fields": [["Seuil", al["seuil"]], ["Unité", al["unite"]], ["Délai (s)", al["delai_s"]]]}
         for key, al in cfg["alarmes"].items()]
data = {"title": "Supervision", "generated": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
        "kinds": {"alarme": "Alarme"},
        "ui": {"fb": {"cats": [["seuil", "Seuil"], ["libelle", "Libellé"], ["ergonomie", "Ergonomie"], ["bug", "Bug"], ["autre", "Autre"]]}},
        "tabs": [{"id": "alarmes", "label": "Alarmes", "sections": [{"id": "toutes", "title": "Alarmes", "items": items}]}]}
out.write_text(json.dumps(data, ensure_ascii=False, indent="\t", allow_nan=False), encoding="utf-8")
print(f"export OK : {len(items)} alarmes -> {out}")
```
(Python 3.11+ pour `tomllib` et `datetime.UTC`.)

## Markdown (pages de design, document, Wiki)

Sert aux projets sans code (`METHODE.md` § 5) : documents déjà écrits par l'équipe, dans leur dossier, ou pages écrites dans `design/` ; et à tout document en Markdown. Un onglet par fichier ; un `.docx` se convertit d'abord en `.md` à côté de l'original (§ 5.1).

Ce que l'exporteur reconnaît, dans la forme où les équipes écrivent déjà (on adapte l'exporteur, jamais les pages) :

| Dans la page | Sur le Wiki |
|---|---|
| texte avant le premier `##` | chapeau de l'onglet |
| `## Titre` sans `###` ni catalogue | une fiche (page « plate » : toutes ses fiches dans une section) |
| `## Famille` puis des `### Élément` | une section, une fiche par `###` |
| tableau dont la 1re colonne est `id`, `ref`, `Nom` ou `Name` (3 colonnes au moins) | une fiche par ligne, les autres colonnes en champs ; une colonne `Image` (ou `Icône`) donne l'image |
| puces `- **Clé** : valeur` ; tableau à deux colonnes | champs (`1,5` devient un nombre, affiché « 1,5 ») |
| autre tableau | `table` de la fiche (le premier seulement) |
| première image `![](chemin local)` | image de la fiche (png, jpg, webp, gif, svg ; 200 Kio au plus, sans réduction : sinon, pas d'image et le résumé le compte) |
| blocs de code | ignorés |

Réglages en tête du fichier :
- `DOCS` : le dossier des pages, celui où l'équipe les tient ;
- `SORTES` : la sorte des fiches de chaque page (`{ creatures: ["creature", "Créature"] }`), ce qui évite de toucher aux pages ; à défaut, la clé `sorte:` de l'en-tête, sinon `section` ;
- `ORDRE` : les pages à mettre en tête des onglets ;
- `CATS` : les types de retour du domaine.

En-tête facultatif en tête de fichier, entre deux lignes `---`, une clé par ligne :
```
---
id: alarmes
titre: Alarmes et alertes
statut: specifie
origine: atelier
responsable: Camille
---
```
- `id` : l'identifiant stable de la page ; il donne l'onglet et le début des refs, et survit au renommage du fichier. Sans lui, c'est le chemin du fichier.
- `statut` : `idee`, `specifie`, `en-cours`, `implemente` ou `ecart`.
- `origine` : `equipe`, `deduit`, `atelier` ou `agent`.
- `source` : le fichier d'origine d'une page convertie (`economie.docx`).
- `sorte`, `libelle` : la sorte des fiches, et son libellé.

`statut`, `origine` et `source` sont affichés en tête de l'onglet. `statut` et `origine` passent aussi sur chaque fiche de la page (badges, filtre « proposé par l'agent » du Wiki).

La ref d'une fiche est `<id de la page>#<ancre>`. L'ancre est l'ancre explicite `{#id}` en fin de titre, sinon le titre réduit, et pour une ligne de catalogue, la colonne `id`, sinon le nom réduit. Sans ancre explicite, un titre ou un nom renommé détache ses retours, et deux ancres identiques dans une page reçoivent `-2`, `-3` selon leur ordre (l'exporteur le signale). Poser des ancres dans les pages de l'équipe se fait avec son accord (§ 5.1). Le balisage simple (`**`, `_`, `` ` ``, liens, puces) est retiré du texte.

`tools/site-retours/export-md.mjs` (vérifié avec `build.js` sur un dossier de documents de jeu : prose, catalogue, `###` avec puces et images, tableaux à deux colonnes)
```js
// node tools/site-retours/export-md.mjs --out=<chemin du json hors dépôt>
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCS = path.join(root, "design");    // dossier des pages (sous-dossiers compris) : celui où l'équipe les tient
const TITRE = "Design du projet", MAX = 600, IMAGE_MAX = 200 * 1024;   // titre du Wiki, longueur des extraits, poids d'image
const SORTES = {};    // sorte des fiches par id de page, sans toucher aux pages : { creatures: ["creature", "Créature"] } (sinon l'en-tête sorte:)
const ORDRE = [];     // ids de page à mettre en tête des onglets, dans cet ordre (les autres suivent par nom de fichier)
const CATS = null;   // types de retour du domaine (METHODE § 4), ex. [["fort","Trop fort"],["faible","Trop faible"],["texte","Texte"],["idee","Idée"],["autre","Autre"]]
const out = process.argv.find(a => a.startsWith("--out="))?.slice(6);
if (!out || path.resolve(out).startsWith(root + path.sep)) { console.error("--out=<chemin hors dépôt> obligatoire"); process.exit(2); }
const slug = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const RESERVED = new Set(["settings", "sidebar", "customize", "upgrade", "downloads", "nouveautes", "mesures", "a-valider", "changements"]);
const STATUTS = { idee: "idée", specifie: "spécifié", "en-cours": "en cours", implemente: "implémenté", ecart: "écart" };
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
const plain = s => s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2")
  .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "• ").replace(/^#{4,6}\s+/gm, "");
const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
const valeur = v => /^-?\d+(?:[.,]\d+)?$/.test(v) ? Number(v.replace(",", ".")) : v || "—";   // « 1,5 » → 1.5, affiché « 1,5 »
const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith(".md") ? [path.join(d, e.name)] : []).sort();
let manquantes = 0;
function image(src, depuis) {                // ![](chemin local) → URI data: ; rien (et compté) si absente, lointaine ou trop lourde
  const f = path.resolve(path.dirname(depuis), decodeURI(src.trim().replace(/^<|>$/g, "")));
  const mime = MIME[path.extname(f).toLowerCase()];
  if (/^[a-z]+:/i.test(src) || !mime || !fs.existsSync(f) || fs.statSync(f).size > IMAGE_MAX) { manquantes++; return null; }
  return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
}
// Contenu d'un bloc : puces « **Clé** : valeur » et tableaux à deux colonnes → champs ; tableau plus large → table, ou
// catalogue (1re colonne « id », « ref », « nom » ou « name ») : une fiche par ligne ; première image → image ; le reste → texte.
function lire(lines, fichier) {
  const r = { fields: [], tables: [], catalogues: [], img: null, text: [] };
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(`{3}|~{3})/.test(l)) { fence = !fence; continue; }
    if (fence) continue;                                       // code : ni texte ni champ
    if (/^\s*\|/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || "") && (lines[i + 1] || "").includes("-")) {
      const head = cells(l), rows = []; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      if (head.length >= 3 && /^(id|ref|nom|name)$/i.test(plain(head[0]))) r.catalogues.push({ head, rows });
      else if (head.length === 2) rows.forEach(x => r.fields.push([plain(x[0] || "—"), valeur(plain(x[1] || ""))]));
      else r.tables.push({ head: head.map(plain), rows: rows.map(x => head.map((_, k) => plain(x[k] ?? ""))) });
      continue;
    }
    const puce = l.match(/^\s*[-*+]\s+\*\*([^*]+?)\s*:?\*\*\s*:?\s*(.+)$/);
    if (puce) { r.fields.push([plain(puce[1]), valeur(plain(puce[2]).trim())]); continue; }
    const im = !r.img && l.match(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/);
    if (im) r.img = image(im[1], fichier);
    r.text.push(l);
  }
  const body = plain(r.text.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
  r.body = body.length > MAX ? body.slice(0, body.lastIndexOf(" ", MAX)) + " …" : body;
  return r;
}
const fiche = (id, kind, name, c) => ({ id, kind, name, ...(c.img ? { image: c.img } : {}), ...(c.fields.length ? { fields: c.fields } : {}),
  ...(c.tables[0] ? { table: c.tables[0] } : {}), ...(c.body ? { text: c.body } : {}) });
const tabs = [], tabIds = new Set(), kinds = { section: "Section" };
for (const file of files(DOCS)) {
  const rel = path.relative(DOCS, file).replace(/\\/g, "/").replace(/\.md$/, "");
  let lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const meta = {};
  if (lines[0] === "---") {                                   // en-tête facultatif : « clé: valeur », une par ligne
    const end = lines.indexOf("---", 1);
    if (end > 0) { for (const l of lines.slice(1, end)) { const m = l.match(/^(\w+):\s*(.*?)\s*$/); if (m) meta[m[1]] = m[2]; } lines = lines.slice(end + 1); }
  }
  const pageId = meta.id || rel, [s0, lib] = SORTES[pageId] || [meta.sorte, meta.libelle];
  const sorte = s0 ? slug(s0).replace(/-/g, "_") : "section";
  if (sorte !== "section") kinds[sorte] = lib || s0[0].toUpperCase() + s0.slice(1);
  let tabId = slug(pageId); if (RESERVED.has(tabId) || tabId.startsWith("comment-")) tabId = "doc-" + tabId;
  if (tabIds.has(tabId)) { console.error(`${rel} : id de page « ${pageId} » déjà pris`); process.exit(1); }
  tabIds.add(tabId);
  // Découpage : préambule, blocs « ## », sous-blocs « ### ». Ancre explicite {#id} lue en priorité.
  const blocs = [{ head: "Introduction", anchor: "introduction", lines: [], subs: [] }];
  let title = meta.titre || "", fence = false;
  for (const line of lines) {
    if (/^\s*(`{3}|~{3})/.test(line)) fence = !fence;
    const h = !fence && line.match(/^(#{1,3}) (.+?)\s*(?:\{#([\w.-]+)\})?\s*$/);
    if (h && h[1] === "#" && !title) { title = plain(h[2]); continue; }
    if (h && h[1] === "##") { blocs.push({ head: plain(h[2]), anchor: h[3] || slug(h[2]), lines: [], subs: [] }); continue; }
    if (h && h[1] === "###") { blocs.at(-1).subs.push({ head: plain(h[2]), anchor: h[3] || slug(h[2]), lines: [] }); continue; }
    const b = blocs.at(-1); (b.subs.at(-1) || b).lines.push(line);
  }
  title ||= rel;
  const refs = new Map();
  const ref = a => { const n = (refs.get(a) || 0) + 1; refs.set(a, n);
    if (n > 1) console.warn(`attention : ${rel} : ancre « ${a} » en double, ref ${a}-${n} (dépend de l'ordre ; ajouter {#id})`);
    return `${pageId}#${a}${n > 1 ? "-" + n : ""}`; };
  const sections = []; let preambule = "";
  const lus = blocs.map(b => ({ b, c: lire(b.lines, file) }));
  const structure = lus.some(({ b, c }) => b.subs.length || c.catalogues.length);   // familles : une section par « ## »
  for (const { b, c } of lus) {
    const vide = !c.body && !c.fields.length && !c.tables.length && !c.img;
    if (b === blocs[0] && !c.fields.length && !c.tables.length && !c.img && !c.catalogues.length) { preambule = c.body; continue; }   // texte seul : en tête d'onglet
    const items = [];
    if (!vide) items.push(fiche(ref(b.anchor), structure ? "section" : sorte, b.head, c));
    for (const s of b.subs) items.push(fiche(ref(s.anchor), sorte, s.head, lire(s.lines, file)));
    for (const cat of c.catalogues) {
      const k = cat.head.map(h => plain(h).toLowerCase());
      const iNom = k.findIndex(h => h === "nom" || h === "name"), iImg = k.findIndex(h => /^(image|icône|icone|illustration)$/.test(h));
      for (const row of cat.rows) {
        const nom = plain(row[iNom >= 0 ? iNom : 0] || ""), id = /^(id|ref)$/.test(k[0]) ? plain(row[0]) : slug(nom);
        if (!nom && !id) continue;
        const img = iImg >= 0 ? (row[iImg].match(/\(([^)\s]+)/) || [, row[iImg]])[1] : "";
        const fields = row.map((v, j) => [plain(cat.head[j]), valeur(plain(v))]).filter((_, j) => j !== 0 && j !== iNom && j !== iImg);
        const im = img ? image(img, file) : null;
        items.push({ id: ref(id), kind: sorte, name: nom || id, ...(im ? { image: im } : {}), ...(fields.length ? { fields } : {}) });
      }
    }
    if (c.tables.length > 1) console.warn(`attention : ${rel} « ${b.head} » : ${c.tables.length} tableaux, seul le premier est affiché`);
    if (!items.length) continue;
    if (structure || !sections.length) sections.push({ id: structure ? slug(b.anchor) : "sections", title: structure ? b.head : title, items });
    else sections[0].items.push(...items);
  }
  for (const s of sections) for (const it of s.items) {          // statut et origine de la page : ceux de ses fiches
    if (STATUTS[meta.statut]) it.statut = meta.statut;
    if (["equipe", "deduit", "atelier", "agent"].includes(meta.origine)) it.origine = meta.origine;
  }
  const etat = [meta.statut && "Statut : " + (STATUTS[meta.statut] || meta.statut), meta.origine && "origine : " + meta.origine,
    meta.responsable && "responsable : " + meta.responsable, meta.source && "source : " + meta.source].filter(Boolean).join(" · ");
  const intro = [etat, preambule.replace(/\s+/g, " ")].filter(Boolean).join(" — ");
  if (sections.length) tabs.push({ id: tabId, label: title, ...(intro ? { intro } : {}), sections, rang: ORDRE.includes(pageId) ? ORDRE.indexOf(pageId) : ORDRE.length });
}
tabs.sort((a, b) => a.rang - b.rang).forEach(t => delete t.rang);   // tri stable : l'ordre des fichiers reste pour les autres
fs.writeFileSync(out, JSON.stringify({ title: TITRE, generated: new Date().toISOString(), kinds, ...(CATS ? { ui: { fb: { cats: CATS } } } : {}), tabs }, null, "\t"));
const n = tabs.reduce((s, t) => s + t.sections.reduce((u, x) => u + x.items.length, 0), 0);
console.log(`export OK : ${tabs.length} pages, ${n} fiches${manquantes ? `, ${manquantes} image(s) introuvable(s), lointaine(s) ou trop lourde(s)` : ""} -> ${out}`);
```
Garder les extraits courts : le Wiki sert à commenter, pas à relire tout le texte. Quand le code du projet arrive, ajouter un exporteur de données à côté (deux sources fusionnées dans le même `data.json`, onglets distincts) : le Wiki montre alors l'intention (pages de design) à côté de ce qui existe (données).
