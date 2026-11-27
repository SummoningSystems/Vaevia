// Réglages d'un projet (docs/etape3-meta-interface.md § 1.5), dans site.json du dépôt de design :
//   disciplines : [{ nom, libelle }], 12 au plus, nom [a-z0-9-]{1,30} unique, libellé 1 à 40 caractères ; vide par défaut
//   url_commit  : gabarit http(s) avec {hash} (et {depot} s'il le faut) ; vide = hash affiché sans lien
//   traitement  : qui lance « Traiter les retours » (étape 3.5, § 5.1) : personne, mainteneur (défaut) ou contributeur ;
//                 un admin le peut toujours, sauf « personne » (demandes.ts)
//   plafond_vague    : retours traités au plus par une demande de traitement (étape 3.9, G4) ; 0 = sans plafond (défaut)
//   traitement_serie : l'envoi d'une série de retours lance « Traiter les retours » (étape 3.9, G3) ; faux par défaut
// Les autres clés de site.json (titre…) sont gardées telles quelles. Un commit par écriture (mainteneur, session).
import type { Depot } from "./depot.ts";
import { estIllisible } from "./depot.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, indisponible, auteurDe } from "./retours.ts";
import { DISCIPLINE } from "./ticket-fichier.ts";

export type Discipline = { nom: string; libelle: string };
export const TRAITEMENTS = ["personne", "mainteneur", "contributeur"] as const;
export type Traitement = typeof TRAITEMENTS[number];
export const TRAITEMENT_DEFAUT: Traitement = "mainteneur";
export type Reglages = { disciplines: Discipline[]; url_commit: string; traitement: Traitement; plafond_vague: number; traitement_serie: boolean };
export const MAX_PLAFOND = 500;
const CLES = ["disciplines", "url_commit", "traitement", "plafond_vague", "traitement_serie"];
export function validerPlafond(v: unknown): number {
	if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > MAX_PLAFOND) throw invalide(`plafond_vague : entier de 0 (sans plafond) à ${MAX_PLAFOND}`);
	return v as number;
}
export function validerBooleen(v: unknown, nom: string): boolean {
	if (typeof v !== "boolean") throw invalide(`${nom} : vrai ou faux`);
	return v;
}
export const MAX_DISCIPLINES = 12;

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validerDisciplines(v: unknown): Discipline[] {
	if (!Array.isArray(v)) throw invalide("disciplines : liste [{ nom, libelle }] attendue");
	if (v.length > MAX_DISCIPLINES) throw invalide(`disciplines : ${MAX_DISCIPLINES} au plus`);
	const vus = new Set<string>();
	return v.map((x: unknown, i: number) => {
		if (!estObjet(x)) throw invalide(`disciplines[${i}] : objet { nom, libelle } attendu`);
		for (const k of Object.keys(x)) if (k !== "nom" && k !== "libelle") throw invalide(`disciplines[${i}] : clé inconnue ${k}`);
		if (typeof x.nom !== "string" || !DISCIPLINE.test(x.nom)) throw invalide(`disciplines[${i}].nom : [a-z0-9-]{1,30}`);
		if (vus.has(x.nom)) throw invalide(`disciplines : ${x.nom} en double`);
		vus.add(x.nom);
		const libelle = typeof x.libelle === "string" ? x.libelle.trim() : "";
		if (!libelle || libelle.length > 40 || /[\u0000-\u001f\u007f]/.test(libelle)) throw invalide(`disciplines[${i}].libelle : 1 à 40 caractères, sur une ligne`);
		return { nom: x.nom, libelle };
	});
}

export function validerUrlCommit(v: unknown): string {
	if (typeof v !== "string") throw invalide("url_commit : texte attendu (vide pour aucun lien)");
	const s = v.trim();
	if (!s) return "";
	if (s.length > 500) throw invalide("url_commit : 500 caractères au plus");
	if (!s.includes("{hash}")) throw invalide("url_commit : le gabarit doit contenir {hash}");
	let u: URL;
	try { u = new URL(s.replaceAll("{hash}", "0123abc").replaceAll("{depot}", "code")); } catch { throw invalide("url_commit : URL invalide"); }
	if (u.protocol !== "http:" && u.protocol !== "https:") throw invalide("url_commit : http: ou https: seulement");
	if (/[{}]/.test(s.replaceAll("{hash}", "").replaceAll("{depot}", ""))) throw invalide("url_commit : seuls {hash} et {depot} sont reconnus");
	return s;
}

export function validerTraitement(v: unknown): Traitement {
	if (typeof v !== "string" || !(TRAITEMENTS as readonly string[]).includes(v)) throw invalide(`traitement : ${TRAITEMENTS.join(", ")}`);
	return v as Traitement;
}

// Réglages lus dans site.json ; une valeur illisible (écrite à la main) donne la valeur par défaut.
export function lireReglages(depot: Depot): Reglages {
	const s = depot.site || {};
	let disciplines: Discipline[] = [], url_commit = "", traitement: Traitement = TRAITEMENT_DEFAUT, plafond_vague = 0, traitement_serie = false;
	try { if (s.disciplines !== undefined) disciplines = validerDisciplines(s.disciplines); } catch { disciplines = []; }
	try { if (s.url_commit !== undefined) url_commit = validerUrlCommit(s.url_commit); } catch { url_commit = ""; }
	try { if (s.traitement !== undefined) traitement = validerTraitement(s.traitement); } catch { traitement = TRAITEMENT_DEFAUT; }
	try { if (s.plafond_vague !== undefined) plafond_vague = validerPlafond(s.plafond_vague); } catch { plafond_vague = 0; }
	try { if (s.traitement_serie !== undefined) traitement_serie = validerBooleen(s.traitement_serie, "traitement_serie"); } catch { traitement_serie = false; }
	return { disciplines, url_commit, traitement, plafond_vague, traitement_serie };
}
export const nomsDisciplines = (depot: Depot): string[] => lireReglages(depot).disciplines.map(d => d.nom);

// PUT : { disciplines?, url_commit?, traitement? } ; une clé absente garde sa valeur. Retirer une discipline utilisée par un ticket : 400 avec la liste des tickets.
export function ecrireReglages(depot: Depot, a: Acteur, corps: unknown): Promise<{ reglages: Reglages; rev: string; inchange?: boolean }> {
	return depot.file.executer(async () => {
		if (!estObjet(corps)) throw invalide("objet { disciplines?, url_commit?, traitement?, plafond_vague?, traitement_serie? } attendu");
		for (const k of Object.keys(corps)) if (!CLES.includes(k)) throw invalide(`clé inconnue : ${k}`);
		if (!Object.keys(corps).length) throw invalide("au moins disciplines, url_commit, traitement, plafond_vague ou traitement_serie");
		if (depot.site === null) throw new ErreurApi(422, "invalid_document", `site.json illisible (${depot.siteErreur}) : à corriger à la main dans le dépôt de design`);
		const avant = lireReglages(depot);
		const apres: Reglages = {
			disciplines: corps.disciplines === undefined ? avant.disciplines : validerDisciplines(corps.disciplines),
			url_commit: corps.url_commit === undefined ? avant.url_commit : validerUrlCommit(corps.url_commit),
			traitement: corps.traitement === undefined ? avant.traitement : validerTraitement(corps.traitement),
			plafond_vague: corps.plafond_vague === undefined ? avant.plafond_vague : validerPlafond(corps.plafond_vague),
			traitement_serie: corps.traitement_serie === undefined ? avant.traitement_serie : validerBooleen(corps.traitement_serie, "traitement_serie"),
		};
		const gardees = new Set(apres.disciplines.map(d => d.nom));
		const retirees = avant.disciplines.map(d => d.nom).filter(n => !gardees.has(n));
		if (retirees.length) {
			const concernes = [...depot.tickets.values()].filter(t => !estIllisible(t) && retirees.includes(t.donnees.discipline)).map(t => (t as { donnees: { id: string } }).donnees.id);
			if (concernes.length) throw invalide(`discipline utilisée, retrait refusé (${retirees.join(", ")}) : tickets ${concernes.join(", ")}`, { tickets: concernes });
		}
		if (JSON.stringify(apres) === JSON.stringify(avant) && CLES.every(k => (depot.site as Record<string, unknown>)[k] !== undefined)) return { reglages: apres, rev: depot.rev, inchange: true };
		const site = { ...depot.site, disciplines: apres.disciplines, url_commit: apres.url_commit, traitement: apres.traitement, plafond_vague: apres.plafond_vague, traitement_serie: apres.traitement_serie };
		const rev = await depot.appliquerTout({ site }, auteurDe(a), `réglages : ${apres.disciplines.length} discipline${apres.disciplines.length > 1 ? "s" : ""}${apres.url_commit ? ", lien des commits" : ""}, traitement : ${apres.traitement}${apres.plafond_vague ? `, plafond ${apres.plafond_vague}` : ""}${apres.traitement_serie ? ", traitement à l'envoi d'une série" : ""}`).catch(indisponible);
		return { reglages: apres, rev };
	});
}
