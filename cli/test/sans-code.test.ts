// Étape 3.8, projet sans code (documents de design seulement) : l'exporteur Markdown de référence, extrait tel quel de
// methode/exporteurs.md, tourne sur un dossier de documents comme les équipes les écrivent (prose, catalogue, ### avec
// puces et image, tableau à deux colonnes) ; build.js accepte le résultat ; METHODE § 5 dit comment lire des documents
// déjà écrits et ce que « vérifié » veut dire sans code. Aucun serveur.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dossierTemp, nettoyer } from "../../serveur/test/aide.ts";
import { RACINE } from "./aide-cli.ts";

const METHODE = fs.readFileSync(path.join(RACINE, "methode", "METHODE.md"), "utf8");
const EXPORTEURS = fs.readFileSync(path.join(RACINE, "methode", "exporteurs.md"), "utf8");
// PNG 1×1 transparent.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("projet sans code : exporteur Markdown de référence et METHODE § 5", () => {
	const tmp = dossierTemp("sans-code");
	after(() => nettoyer(tmp));

	function preparer(reglages: (code: string) => string) {
		const depot = path.join(tmp, "depot-" + Math.random().toString(36).slice(2, 8));
		const ecrire = (rel: string, c: string | Buffer) => { const f = path.join(depot, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
		const m = EXPORTEURS.match(/`tools\/site-retours\/export-md\.mjs`[^\n]*\n```js\n([\s\S]*?)\n```/);
		assert.ok(m, "bloc de l'exporteur Markdown dans exporteurs.md");
		ecrire("tools/site-retours/export-md.mjs", reglages(m![1]));
		ecrire("GDD/vision.md", "# Vision\n\nJeu de défense, en solo.\n\n## Piliers\n\nLa lumière est la seule arme.\n");
		ecrire("GDD/creatures.md", "# Créatures\n\nElles marchent vers le phare.\n\n## Bestiaire\n\n| Nom | Points d'ombre | Vitesse | Image |\n|---|---|---|---|\n| Feu follet | 2 | 1,5 | ![](images/f.png) |\n| Noyé | 10 | 0,5 | |\n\n## Vagues\n\nCinq vagues par nuit.\n");
		ecrire("GDD/gardiens.md", "---\nstatut: specifie\norigine: equipe\n---\n# Gardiens\n\n## Gardiens jouables\n\n### L'Allumeuse {#allumeuse}\n\n![Allumeuse](images/a.png)\n\n- **Portée** : 2 cases\n- **Coût** : 30\n\nElle lance une fusée.\n\n### Le Guetteur\n\n- **Portée** : 5 cases\n");
		ecrire("GDD/phares.md", "# Phares\n\n## Phare de la Pointe\n\n| Propriété | Valeur |\n|---|---|\n| Nuit | 1 |\n| Rochers | 4 |\n\n```\nignoré\n```\n");
		ecrire("GDD/images/a.png", PNG); ecrire("GDD/images/f.png", PNG);
		return depot;
	}
	const reglages = (code: string) => code
		.replace(`path.join(root, "design")`, `path.join(root, "GDD")`)
		.replace(/^const SORTES = \{\};/m, `const SORTES = { creatures: ["creature", "Créature"], gardiens: ["gardien", "Gardien"], phares: ["phare", "Phare"] };`)
		.replace(/^const ORDRE = \[\];/m, `const ORDRE = ["vision"];`);

	test("exporteurs.md : l'exporteur Markdown extrait du document range les fiches par famille, et build.js l'accepte", () => {
		const depot = preparer(reglages);
		const out = path.join(tmp, "data-" + path.basename(depot) + ".json");
		const r = spawnSync(process.execPath, [path.join(depot, "tools", "site-retours", "export-md.mjs"), "--out=" + out], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /export OK : 4 pages, 7 fiches -> /);
		const d = JSON.parse(fs.readFileSync(out, "utf8"));
		assert.deepEqual(d.tabs.map((t: any) => t.id), ["vision", "creatures", "gardiens", "phares"], "ORDRE, puis l'ordre des fichiers");
		assert.deepEqual(d.kinds, { section: "Section", creature: "Créature", gardien: "Gardien", phare: "Phare" });
		const tab = (id: string) => d.tabs.find((t: any) => t.id === id);
		const items = (id: string) => tab(id).sections.flatMap((s: any) => s.items);
		// Préambule en chapeau de l'onglet, pas en fiche.
		assert.equal(tab("creatures").intro, "Elles marchent vers le phare.");
		assert.ok(!items("creatures").some((i: any) => i.name === "Introduction"));
		// Catalogue : une fiche par ligne, ref tirée du nom, nombres à virgule, image de la colonne Image.
		const feu = items("creatures").find((i: any) => i.id === "creatures#feu-follet");
		assert.equal(feu.kind, "creature");
		assert.deepEqual(feu.fields, [["Points d'ombre", 2], ["Vitesse", 1.5]]);
		assert.match(feu.image, /^data:image\/png;base64,/);
		assert.ok(!items("creatures").find((i: any) => i.id === "creatures#noye").image);
		// Prose d'une page structurée : fiche de sorte « section », dans sa propre section.
		assert.deepEqual(tab("creatures").sections.map((s: any) => s.id), ["bestiaire", "vagues"]);
		assert.equal(items("creatures").find((i: any) => i.id === "creatures#vagues").kind, "section");
		// ### avec ancre explicite, puces en champs, première image.
		const all = items("gardiens").find((i: any) => i.id === "gardiens#allumeuse");
		assert.equal(all.kind, "gardien");
		assert.deepEqual(all.fields, [["Portée", "2 cases"], ["Coût", 30]]);
		assert.match(all.image, /^data:image\/png;/);
		assert.equal(all.text, "Elle lance une fusée.");
		// Étape 3.9, L4 : statut et origine de l'en-tête de la page, sur chacune de ses fiches ; rien sans en-tête.
		assert.equal(all.statut, "specifie"); assert.equal(all.origine, "equipe");
		assert.equal(feu.statut, undefined);
		assert.ok(items("gardiens").find((i: any) => i.id === "gardiens#le-guetteur"));
		// Page plate : chaque ## est une fiche de la sorte de la page ; tableau à deux colonnes en champs ; code ignoré.
		const pointe = items("phares")[0];
		assert.equal(pointe.kind, "phare");
		assert.deepEqual(pointe.fields, [["Nuit", 1], ["Rochers", 4]]);
		assert.ok(!JSON.stringify(pointe).includes("ignoré"));
		// Juge : build.js.
		const b = spawnSync(process.execPath, [path.join(RACINE, "site", "build.js"), out, "--check"], { encoding: "utf8" });
		assert.equal(b.status, 0, b.stderr + b.stdout);
		// Sortie dans le dépôt : refusée.
		const refus = spawnSync(process.execPath, [path.join(depot, "tools", "site-retours", "export-md.mjs"), "--out=" + path.join(depot, "data.json")], { encoding: "utf8" });
		assert.equal(refus.status, 2);
	});

	test("exporteurs.md : l'exporteur Markdown réserve les onglets du Wiki, dont changements (étape 3.7)", () => {
		const m = EXPORTEURS.match(/const RESERVED = new Set\(\[([^\]]*)\]\)/);
		assert.ok(m);
		for (const id of ["nouveautes", "mesures", "a-valider", "changements"]) assert.ok(m![1].includes(`"${id}"`), id);
		const depot = preparer(c => reglages(c));
		fs.writeFileSync(path.join(depot, "GDD", "changements.md"), "# Journal\n\n## Version 2\n\nTexte.\n");
		const out = path.join(tmp, "data-reserve.json");
		const r = spawnSync(process.execPath, [path.join(depot, "tools", "site-retours", "export-md.mjs"), "--out=" + out], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.ok(JSON.parse(fs.readFileSync(out, "utf8")).tabs.some((t: any) => t.id === "doc-changements"));
		assert.equal(spawnSync(process.execPath, [path.join(RACINE, "site", "build.js"), out, "--check"], { encoding: "utf8" }).status, 0);
	});

	test("étape 3.9 : onglet « Écrans » proposé au cadrage (METHODE § 4) ; recettes de captures web et Godot (exporteurs.md)", () => {
		const quatre = METHODE.slice(METHODE.indexOf("## 4. Créer ou refaire le Wiki"), METHODE.indexOf("## 5. "));
		assert.match(quatre, /\*\*un onglet « Écrans »\*\*, à proposer pour tout logiciel qui a une interface/);
		assert.match(quatre, /jamais dessinées ni prises sur des données réelles/);
		const ecrans = EXPORTEURS.slice(EXPORTEURS.indexOf("## Écrans (captures du logiciel)"), EXPORTEURS.indexOf("## Node (application web, outil)"));
		assert.ok(ecrans.length > 1000, "section Écrans avant Node");
		assert.match(ecrans, /`tools\/site-retours\/captures-ecrans\.mjs`\n```js\n[\s\S]*Page\.captureScreenshot[\s\S]*\n```/);
		assert.match(ecrans, /`tools\/site-retours\/captures\.gd`\n```gdscript\n[\s\S]*get_viewport\(\)\.get_texture\(\)\.get_image\(\)[\s\S]*\n```/);
		assert.match(ecrans, /--headless` n'a pas de rendu/);
	});

	test("METHODE.md § 5 : documents déjà écrits (formats, cadrage par familles, refs, rien d'inventé) et vérification sans code", () => {
		const zero = METHODE.slice(METHODE.indexOf("## 0. Mise en place"), METHODE.indexOf("## 1. Principes"));
		const cinq = METHODE.slice(METHODE.indexOf("## 5. "), METHODE.indexOf("## 6. "));
		assert.match(cinq, /^## 5\. Projet sans code/m);
		for (const s of ["### 5.1 Documents déjà écrits par l'équipe", "### 5.2 Rien d'écrit encore", "### 5.3 Vérifier sans code"]) assert.ok(cinq.includes(s), s);
		assert.match(zero, /Dépôt sans code[^\n]*§ 5\.1/);
		assert.match(zero, /n'est pas dans un dépôt Git[^\n]*demande à l'humain/);
		assert.match(cinq, /laquelle fait foi est une décision de l'humain/);
		assert.match(cinq, /une fiche par élément avec ses valeurs/);
		assert.match(cinq, /Poser des ancres modifie les pages de l'équipe/);
		assert.match(cinq, /question ouverte[^\n]*point « À valider »/);
		assert.match(cinq, /non mesuré : pas encore de jeu/);
		assert.match(METHODE, /### 6\.3[\s\S]*Projet sans code : § 5\.3/);
	});
});
