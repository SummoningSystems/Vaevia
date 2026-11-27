// Notes datées du dépôt de design (notes/notes_<date>.json), étape 2 § 2.1 :
//   PUT /api/p/<projet>/notes/<nom>[?remplacer=1]   (agent, mainteneur, admin) : validé, un commit
//   GET /api/p/<projet>/notes                         liste
//   GET /api/p/<projet>/notes/<nom>                   contenu (le fichier tel qu'il est dans le dépôt)
// Validation : les règles de site/build.js (site/valider-notes.js, même module), appliquées à l'ensemble que lirait le
// build après l'écriture : les notes déjà dans notes/ (sauf celle remplacée) plus la nouvelle. Ids uniques dans tous
// les fichiers, jalons déclarés, champs obligatoires.
// Le fichier est écrit tel que reçu (JSON indenté, LF), sans trier les clés : l'ordre de « milestones » est l'ordre
// d'affichage des jalons.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Depot, Auteur } from "./depot.ts";
import { ErreurGit, ligne } from "./depot.ts";
import { ErreurApi, invalide, absent, indisponible } from "./retours.ts";
import { RACINE_OUTIL } from "./config.ts";

// Règles : site/valider-notes.js (CommonJS, partagé avec build.js et la CLI). Pour valider, celui du site dont le
// serveur lance build.js (WDD_SITE) : la validation est celle du build qui lira ces notes.
type Serie = { fichier: string; n: unknown };
export type Regles = {
	FICHIER_NOTES: RegExp;
	nomNotesValide: (nom: string) => boolean;
	trierSeries: (s: Serie[]) => Serie[];
	validerNotes: (s: Serie[]) => { erreurs: string[]; avertissements: string[] };
};
const exiger = createRequire(import.meta.url);
const cache = new Map<string, Regles>();
export function regles(site: string): Regles {
	let r = cache.get(site);
	if (!r) cache.set(site, r = exiger(path.join(site, "valider-notes.js")) as Regles);
	return r;
}
// Fichiers lus par build.js dans notes/.
const { FICHIER_NOTES } = regles(path.join(RACINE_OUTIL, "site"));

const dossierNotes = (depot: Depot) => path.join(depot.dossier, "notes");
// Fichiers de notes présents (ceux que lit build.js), triés. Les noms viennent du disque : on ne joint jamais un nom
// reçu à un chemin, on le cherche dans cette liste.
export function fichiersNotes(depot: Depot): string[] {
	const dir = dossierNotes(depot);
	return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => FICHIER_NOTES.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
}

// Liste : nom, date, titre, jalons déclarés (clés de « milestones », dans l'ordre), poids. Les jalons servent à l'agent
// pour numéroter la vague suivante en continu (METHODE § 6.3) ; le détail se lit avec GET …/notes/<nom>.
export function listerNotes(depot: Depot): { notes: { nom: string; date: string; titre: string; jalons: string[]; octets: number }[]; rev: string } {
	const notes = fichiersNotes(depot).map(nom => {
		const p = path.join(dossierNotes(depot), nom);
		let date = "", titre = "", jalons: string[] = [];
		try {
			const o = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
			if (o && typeof o === "object") {
				date = typeof o.date === "string" ? o.date : ""; titre = typeof o.title === "string" ? o.title : typeof o.label === "string" ? o.label : "";
				if (o.milestones && typeof o.milestones === "object" && !Array.isArray(o.milestones)) jalons = Object.keys(o.milestones);
			}
		} catch { /* illisible : listé sans date ni titre */ }
		return { nom, date, titre, jalons, octets: fs.statSync(p).size };
	});
	return { notes, rev: depot.rev };
}

// Contenu brut d'un fichier de notes (nom cherché dans la liste du dossier), ou 404.
export function lireNotes(depot: Depot, nom: string): string {
	const trouve = fichiersNotes(depot).find(f => f === nom);
	if (!trouve) throw absent("notes introuvables");
	return fs.readFileSync(path.join(dossierNotes(depot), trouve), "utf8");
}

// Écrit notes/<nom> et le commite seul, dans la file du projet (à appeler DANS depot.file). Rend le nouveau rev.
// Sur échec de Git : fichier remis comme au dernier commit (un nouveau fichier est retiré ; d'autres notes déposées à
// la main dans notes/ ne sont jamais touchées), ErreurGit.
export async function commiterNotes(depot: Depot, nom: string, texte: string, auteur: Auteur, sujet: string, journal: (m: string) => void): Promise<string> {
	await depot.assainir();
	const dir = dossierNotes(depot), chemin = "notes/" + nom;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, nom), texte);
	try {
		await depot.git(["add", "--", chemin]);
		await depot.git(["commit", "-q", "--allow-empty", "-m", ligne(sujet, 200), "-m", `Par: ${ligne(auteur.nom, 60)}`, "--", chemin], auteur);
		depot.rev = (await depot.git(["rev-parse", "HEAD"])).trim();
		return depot.rev;
	} catch (e) {
		journal(`projet ${depot.projet} : notes refusées (${(e as Error)?.message || e})`);
		try { await depot.restaurer(); } catch { }
		try { await depot.git(["clean", "-fq", "--", chemin]); } catch { }
		throw e instanceof ErreurGit ? e : new ErreurGit(String((e as Error)?.message || e));
	}
}

// PUT : valide (nom, objet, règles de build.js sur l'ensemble), puis un commit. 409 si le fichier existe sans
// ?remplacer=1. Rend { nom, rev, cree, inchange, avertissements }.
export function ecrireNotes(depot: Depot, site: string, auteur: Auteur, nom: string, corps: unknown, remplacer: boolean, journal: (m: string) => void):
	Promise<{ nom: string; rev: string; cree: boolean; inchange: boolean; avertissements: string[] }> {
	if (!regles(site).nomNotesValide(nom)) return Promise.reject(invalide("nom : notes_AAAA-MM-JJ.json ou notes_AAAA-MM-JJ_<suffixe>.json (date valide ; suffixe : a-z, 0-9, -)"));
	if (!corps || typeof corps !== "object" || Array.isArray(corps)) return Promise.reject(invalide("notes : objet JSON attendu"));
	const texte = JSON.stringify(corps, null, 2) + "\n";
	return depot.file.executer(async () => {
		const presents = fichiersNotes(depot);
		const homonyme = presents.find(f => f.toLowerCase() === nom.toLowerCase());
		if (homonyme && homonyme !== nom) throw new ErreurApi(409, "conflict", `un fichier de notes de même nom à la casse près existe : ${homonyme}`);
		const existe = !!homonyme;
		if (existe && !remplacer) throw new ErreurApi(409, "conflict", `notes déjà présentes : ${nom} (?remplacer=1 pour les remplacer)`);
		// L'ensemble que lira le build : les autres fichiers tels qu'ils sont, plus le nouveau contenu.
		const series: Serie[] = [];
		for (const f of presents) {
			if (f === nom) continue;
			let n: unknown;
			try { n = JSON.parse(fs.readFileSync(path.join(dossierNotes(depot), f), "utf8").replace(/^﻿/, "")); }
			catch (e) { throw invalide(`notes déjà présentes illisibles : ${f} (${(e as Error).message}) ; le build échouerait aussi`); }
			series.push({ fichier: f, n });
		}
		series.push({ fichier: nom, n: structuredClone(corps) });
		const r = regles(site);
		const { erreurs, avertissements } = r.validerNotes(r.trierSeries(series));
		if (erreurs.length) throw invalide(`notes refusées (règles de site/build.js) : ${erreurs.slice(0, 20).join(" ; ")}${erreurs.length > 20 ? ` ; … et ${erreurs.length - 20} autres` : ""}`, { erreurs });
		if (existe && fs.readFileSync(path.join(dossierNotes(depot), nom), "utf8") === texte) return { nom, rev: depot.rev, cree: false, inchange: true, avertissements };
		const rev = await commiterNotes(depot, nom, texte, auteur, `notes : ${nom}${existe ? " (remplacement)" : ""}`, journal).catch(indisponible);
		return { nom, rev, cree: !existe, inchange: false, avertissements };
	});
}
