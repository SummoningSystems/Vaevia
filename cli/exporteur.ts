// CLI « outil » : pose un exporteur de départ (étape 3.9, G6 ; docs/etape3-9-sections-1-a-6.md, lot 4).
//   outil exporteur <donnees|markdown> [--forcer]
// Le code est recopié depuis methode/exporteurs.md (« Kit de départ » et section Markdown) : un seul endroit à tenir,
// déjà vérifié par les tests. Écrit tools/site-retours/<fichier> dans le dépôt de .outil.json ; déclare
// publier.exporteur dans .outil.json s'il ne l'est pas encore. Ne remplace un fichier existant qu'avec --forcer.
// Aucune opération Git : le résumé dit quoi commiter.
import fs from "node:fs";
import path from "node:path";
import { CODES, usage, erreur, chargerConfig, emettre, RACINE_OUTIL } from "./commun.ts";
import type { Commande } from "./commun.ts";

export const KITS: Record<string, { fichier: string; marque: string }> = {
	donnees: { fichier: "export.mjs", marque: "`tools/site-retours/export.mjs` (kit « donnees »)" },
	markdown: { fichier: "export-md.mjs", marque: "`tools/site-retours/export-md.mjs`" },
};
// Le bloc ```js qui suit la ligne de marque, dans exporteurs.md.
export function codeDuKit(nom: string, doc = fs.readFileSync(path.join(RACINE_OUTIL, "methode", "exporteurs.md"), "utf8")): string {
	const k = KITS[nom];
	const i = doc.split(/\r?\n/).findIndex(l => l.startsWith(k.marque));
	if (i < 0) throw erreur(`kit « ${nom} » introuvable dans methode/exporteurs.md`);
	const reste = doc.split(/\r?\n/).slice(i + 1);
	if (reste[0] !== "```js") throw erreur(`kit « ${nom} » : bloc de code attendu après sa ligne dans methode/exporteurs.md`);
	const fin = reste.indexOf("```", 1);
	return reste.slice(1, fin).join("\n") + "\n";
}

export const COMMANDES_EXPORTEUR: Commande[] = [{
	nom: "exporteur", usage: "outil exporteur <donnees|markdown> [--forcer] [--json]",
	resume: "pose un exporteur de départ dans tools/site-retours/ (fichiers JSON ou CSV du projet, ou documents Markdown) et le déclare dans .outil.json",
	detail: "donnees : export.mjs, qui lit des fichiers JSON ou CSV décrits dans SOURCES (à remplir). markdown : export-md.mjs, pour des documents de design (DOCS, SORTES, ORDRE). " +
		"Recopié depuis methode/exporteurs.md (« Kit de départ ») ; un fichier déjà là n'est remplacé qu'avec --forcer. publier.exporteur de .outil.json est posé s'il manque, jamais changé. Aucune opération Git. " +
		"Un exporteur générique ne lit que des fichiers : une valeur calculée par le projet demande un exporteur propre (METHODE § 4, étape 3).",
	exemple: "outil exporteur donnees\n  outil exporteur markdown",
	options: { forcer: "drapeau" }, positionnels: [1, 1], refuseeSousVeille: () => true,
	faire: async (ctx, pos, opt) => {
		const nom = String(pos[0]);
		if (!KITS[nom]) throw usage(`kit inconnu : « ${nom} » (donnees ou markdown)`);
		const cfg = chargerConfig(ctx);
		const racine = path.dirname(cfg.chemin);
		const rel = path.posix.join("tools", "site-retours", KITS[nom].fichier);
		const f = path.join(racine, rel);
		const existe = fs.existsSync(f);
		if (existe && !opt.forcer) throw erreur(`${rel} existe déjà : rien n'est remplacé (--forcer pour l'écraser)`, { code: "existe" });
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, codeDuKit(nom));
		// .outil.json : publier.exporteur posé s'il manque (les autres clés gardées telles quelles).
		const brut = JSON.parse(fs.readFileSync(cfg.chemin, "utf8").replace(/^﻿/, ""));
		const declare = !brut.publier || !Array.isArray(brut.publier.exporteur) || !brut.publier.exporteur.length;
		if (declare) {
			brut.publier = { ...(brut.publier || {}), exporteur: ["node", rel, "--out={data}"] };
			fs.writeFileSync(cfg.chemin, JSON.stringify(brut, null, 2) + "\n");
		}
		const reglages = nom === "donnees" ? "SOURCES (un onglet par fichier JSON ou CSV)" : "DOCS, SORTES et ORDRE";
		emettre(ctx, { kit: nom, fichier: rel, remplace: existe, declare, a_commiter: [rel, ...(declare ? [path.basename(cfg.chemin)] : [])] }, [
			`${existe ? "remplacé" : "posé"} : ${rel}`,
			declare ? `.outil.json : publier.exporteur = ["node", "${rel}", "--out={data}"]` : ".outil.json : publier.exporteur déjà déclaré, inchangé",
			`à faire : remplir ${reglages} en tête du fichier, choisir les champs utiles (METHODE § 4), puis outil publier`,
			`à commiter : ${rel}${declare ? ", .outil.json" : ""} (aucune opération Git n'a été faite)`,
		]);
		return CODES.ok;
	},
}];
