// Fichier d'un ticket (docs/etape3-meta-interface.md § 1.1) : tickets/T-<n>.md dans le dépôt de design.
//   ---
//   id: "T-12"
//   version: 3
//   titre: "…"
//   …                       une clé par ligne, valeur en JSON sur une ligne (c'est aussi du YAML valide)
//   ---
//   Description en Markdown.
// Clés connues seulement, toujours écrites dans l'ordre de CLES. La lecture est stricte : clé inconnue, manquante ou
// en double, valeur hors des règles → erreur (le ticket est alors listé « illisible » et refuse toute écriture).
// Ce module ne dépend d'aucun autre : depot.ts s'en sert pour relire les tickets, tickets.ts pour les écrire.

export const ID_TICKET = /^T-([1-9]\d{0,8})$/;
export const FICHIER_TICKET = /^T-([1-9]\d{0,8})\.md$/;
export const STATUTS_TICKET = ["a-faire", "pris", "en-revue", "fait"] as const;
export type StatutTicket = typeof STATUTS_TICKET[number];

// Qui : un compte ou un jeton d'agent ; « pour » = le propriétaire du jeton (§ 1.4).
export type Personne = { type: "compte" | "agent"; id: string; nom: string; pour?: { id: string; nom: string } };
export type Critere = { texte: string; fait: boolean };
export type CommitLie = { hash: string; depot: string; message: string };
export type Ticket = {
	id: string;
	titre: string;
	statut: StatutTicket;
	discipline: string;
	pris_par: Personne | null;
	retours: string[];
	pages: string[];
	criteres: Critere[];
	commits: CommitLie[];
	auteur: Personne;
	cree: string;
	modifie: string;
	description: string;
};
export type DocTicket = { version: number; donnees: Ticket };

// Ordre des clés de l'en-tête (la description suit, hors en-tête).
export const CLES = ["id", "version", "titre", "statut", "discipline", "pris_par", "retours", "pages", "criteres", "commits", "auteur", "cree", "modifie"] as const;

export const MAX_TITRE = 200, MAX_DESCRIPTION = 20000, MAX_RETOURS_LIES = 50, MAX_PAGES = 50, MAX_CRITERES = 30, MAX_TEXTE_CRITERE = 500,
	MAX_COMMITS = 100, MAX_MESSAGE_COMMIT = 200;
export const ID_RETOUR_LIE = /^[A-Za-z0-9]{1,40}$/;
export const PAGE = /^[a-z0-9_-]+:[^\s]{1,200}$/;
export const HASH = /^[0-9a-f]{7,40}$/;
export const DEPOT_CODE = /^[a-z0-9_-]{1,40}$/;
export const DISCIPLINE = /^[a-z0-9-]{1,30}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;
const estIso = (s: unknown): boolean => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s));
// Une ligne : aucun caractère de contrôle (ni retour à la ligne ni tabulation).
const UNE_LIGNE = /^[^\u0000-\u001f\u007f]*$/;

export class ErreurTicket extends Error { }
const err = (m: string): never => { throw new ErreurTicket(m); };
const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clesExactes = (o: Record<string, unknown>, permises: string[], quoi: string) => {
	for (const k of Object.keys(o)) if (!permises.includes(k)) err(`${quoi} : clé inconnue ${k}`);
};

export function validerPersonne(v: unknown, quoi: string): Personne {
	if (!estObjet(v)) return err(`${quoi} : objet attendu`);
	clesExactes(v, ["type", "id", "nom", "pour"], quoi);
	if (v.type !== "compte" && v.type !== "agent") err(`${quoi}.type : compte ou agent`);
	if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(v.id)) err(`${quoi}.id invalide`);
	if (typeof v.nom !== "string" || !v.nom || v.nom.length > 200 || !UNE_LIGNE.test(v.nom)) err(`${quoi}.nom invalide`);
	const p: Personne = { type: v.type as Personne["type"], id: v.id as string, nom: v.nom as string };
	if (v.pour !== undefined) {
		const pour = v.pour;
		if (!estObjet(pour)) return err(`${quoi}.pour : objet attendu`);
		clesExactes(pour, ["id", "nom"], `${quoi}.pour`);
		if (typeof pour.id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(pour.id)) err(`${quoi}.pour.id invalide`);
		if (typeof pour.nom !== "string" || !pour.nom || pour.nom.length > 200 || !UNE_LIGNE.test(pour.nom)) err(`${quoi}.pour.nom invalide`);
		p.pour = { id: pour.id as string, nom: pour.nom as string };
	}
	return p;
}

// Champs que le client peut écrire (création, PATCH) : forme et limites. Les règles qui dépendent du projet (retours
// existants, disciplines déclarées) sont vérifiées par tickets.ts.
export function validerTitre(v: unknown): string {
	if (typeof v !== "string") return err("titre : texte attendu");
	const t = v.trim();
	if (!t || t.length > MAX_TITRE || !UNE_LIGNE.test(t)) err(`titre : 1 à ${MAX_TITRE} caractères, sur une ligne`);
	return t;
}
export function validerDescription(v: unknown): string {
	if (typeof v !== "string") return err("description : texte attendu");
	// Fins de ligne normalisées en LF : le fichier est relu en LF (un dépôt cloné sous Windows peut l'avoir en CRLF).
	const d = v.replace(/\r\n?/g, "\n");
	if (d.length > MAX_DESCRIPTION) err(`description : ${d.length} caractères, ${MAX_DESCRIPTION} au plus`);
	if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(d)) err("description : caractère de contrôle refusé");
	// Un demi-caractère UTF-16 isolé deviendrait U+FFFD dans le fichier (UTF-8) : la mémoire et le dépôt divergeraient.
	if (!d.isWellFormed()) err("description : texte Unicode mal formé (demi-caractère isolé)");
	return d;
}
export function validerDiscipline(v: unknown): string {
	if (typeof v !== "string" || (v !== "" && !DISCIPLINE.test(v))) return err("discipline : [a-z0-9-]{1,30} ou vide");
	return v;
}
export function validerRetoursLies(v: unknown): string[] {
	if (!Array.isArray(v)) return err("retours : liste d'ids attendue");
	if (v.length > MAX_RETOURS_LIES) err(`retours : ${MAX_RETOURS_LIES} au plus`);
	const vus = new Set<string>();
	for (const x of v) {
		if (typeof x !== "string" || !ID_RETOUR_LIE.test(x)) err("retours : id de retour invalide");
		if (vus.has(x as string)) err(`retours : ${x} en double`);
		vus.add(x as string);
	}
	return v as string[];
}
export function validerPages(v: unknown): string[] {
	if (!Array.isArray(v)) return err("pages : liste de références sorte:id attendue");
	if (v.length > MAX_PAGES) err(`pages : ${MAX_PAGES} au plus`);
	const vus = new Set<string>();
	for (const x of v) {
		if (typeof x !== "string" || !PAGE.test(x)) err("pages : référence sorte:id attendue ([a-z0-9_-]+:id sans espace, 200 caractères au plus)");
		if (vus.has(x as string)) err(`pages : ${x} en double`);
		vus.add(x as string);
	}
	return v as string[];
}
// Critères : [{texte, fait?}] ; un texte seul est accepté (fait: false).
export function validerCriteres(v: unknown): Critere[] {
	if (!Array.isArray(v)) return err("criteres : liste attendue");
	if (v.length > MAX_CRITERES) err(`criteres : ${MAX_CRITERES} au plus`);
	return v.map((x: unknown, i: number) => {
		const o = typeof x === "string" ? { texte: x } : x;
		if (!estObjet(o)) return err(`criteres[${i}] : objet { texte, fait } attendu`);
		clesExactes(o, ["texte", "fait"], `criteres[${i}]`);
		const texte = typeof o.texte === "string" ? o.texte.trim() : "";
		if (!texte || texte.length > MAX_TEXTE_CRITERE || !UNE_LIGNE.test(texte)) err(`criteres[${i}].texte : 1 à ${MAX_TEXTE_CRITERE} caractères, sur une ligne`);
		if (o.fait !== undefined && typeof o.fait !== "boolean") err(`criteres[${i}].fait : vrai ou faux`);
		return { texte, fait: o.fait === true };
	});
}
// Un commit cité : hash hexadécimal (7 à 40, mis en minuscules), dépôt (défaut « code »), message d'une ligne.
export function validerCommit(x: unknown, i: number): CommitLie {
	if (!estObjet(x)) return err(`commits[${i}] : objet { hash, depot?, message? } attendu`);
	clesExactes(x, ["hash", "depot", "message"], `commits[${i}]`);
	const hash = typeof x.hash === "string" ? x.hash.toLowerCase() : "";
	if (!HASH.test(hash)) err(`commits[${i}].hash : hexadécimal de 7 à 40 caractères`);
	const depot = x.depot === undefined ? "code" : x.depot;
	if (typeof depot !== "string" || !DEPOT_CODE.test(depot)) err(`commits[${i}].depot : [a-z0-9_-]{1,40}`);
	const message = x.message === undefined ? "" : x.message;
	if (typeof message !== "string" || message.length > MAX_MESSAGE_COMMIT || !UNE_LIGNE.test(message)) err(`commits[${i}].message : ${MAX_MESSAGE_COMMIT} caractères au plus, sur une ligne`);
	return { hash, depot: depot as string, message: message as string };
}
// Deux commits sont le même si même dépôt et l'un des hash est le préfixe de l'autre.
export const memeCommit = (a: CommitLie, b: CommitLie): boolean => a.depot === b.depot && (a.hash.startsWith(b.hash) || b.hash.startsWith(a.hash));
export function validerCommits(v: unknown): CommitLie[] {
	if (!Array.isArray(v)) return err("commits : liste attendue");
	if (v.length > MAX_COMMITS) err(`commits : ${MAX_COMMITS} au plus`);
	const l = v.map(validerCommit);
	l.forEach((c, i) => { for (let j = 0; j < i; j++) if (memeCommit(c, l[j])) err(`commits[${i}] : doublon de commits[${j}]`); });
	return l;
}

// Ticket complet (lecture d'un fichier, ou avant écriture) : toutes les clés, chacune valide, statut et preneur cohérents.
export function validerTicket(o: Record<string, unknown>, idAttendu?: string): Ticket {
	if (typeof o.id !== "string" || !ID_TICKET.test(o.id)) err("id : T-<n> attendu");
	if (idAttendu !== undefined && o.id !== idAttendu) err(`id ${o.id} différent du nom du fichier (${idAttendu})`);
	if (!(STATUTS_TICKET as readonly string[]).includes(o.statut as string)) err(`statut inconnu : ${o.statut}`);
	const pris = o.pris_par === null ? null : validerPersonne(o.pris_par, "pris_par");
	const statut = o.statut as StatutTicket;
	if (statut === "a-faire" && pris) err("un ticket à faire n'a pas de preneur");
	if ((statut === "pris" || statut === "en-revue") && !pris) err(`un ticket ${statut} a un preneur`);
	if (!estIso(o.cree) || !estIso(o.modifie)) err("cree, modifie : dates ISO 8601 attendues");
	const titre = validerTitre(o.titre);
	if (titre !== o.titre) err("titre : espaces en trop au début ou à la fin");
	const description = validerDescription(o.description);
	if (description !== o.description) err("description : fins de ligne CR");
	return {
		id: o.id as string, titre, statut, discipline: validerDiscipline(o.discipline), pris_par: pris,
		retours: validerRetoursLies(o.retours), pages: validerPages(o.pages), criteres: validerCriteres(o.criteres).map((c, i) => {
			const brut = (o.criteres as Record<string, unknown>[])[i];
			if (typeof brut !== "object" || typeof brut.fait !== "boolean") err(`criteres[${i}] : { texte, fait } attendu`);
			return c;
		}),
		commits: validerCommits(o.commits).map((c, i) => {
			const brut = (o.commits as Record<string, unknown>[])[i];
			if (brut.depot === undefined || brut.message === undefined || brut.hash !== c.hash) err(`commits[${i}] : { hash (minuscules), depot, message } attendu`);
			return c;
		}),
		auteur: validerPersonne(o.auteur, "auteur"), cree: o.cree as string, modifie: o.modifie as string, description,
	};
}

// Une valeur JSON sur une ligne : JSON.stringify échappe LF et CR, mais pas U+2028, U+2029 (fins de ligne pour une
// expression régulière JS) ni U+0085 (fin de ligne en YAML 1.1). Ils sont écrits échappés (\u2028…) : JSON.parse rend
// le même texte, et le fichier reste une ligne par clé pour tout lecteur.
const SAUTS_UNICODE = /[\u0085\u2028\u2029]/g;
const valeurJson = (v: unknown): string => JSON.stringify(v).replace(SAUTS_UNICODE, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

// Texte du fichier. Une valeur JSON ne contient jamais de retour à la ligne (voir valeurJson).
export function serialiser(doc: DocTicket): string {
	const t = doc.donnees;
	const valeurs: Record<string, unknown> = { ...t, version: doc.version };
	const lignes = CLES.map(k => `${k}: ${valeurJson(valeurs[k])}`);
	return `---\n${lignes.join("\n")}\n---\n${t.description}\n`;
}

// Lecture stricte d'un fichier. idAttendu : l'id tiré du nom du fichier.
export function analyser(brut: string, idAttendu?: string): DocTicket {
	const texte = brut.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!texte.startsWith("---\n")) err("en-tête absent (première ligne « --- » attendue)");
	const fin = texte.indexOf("\n---\n", 3);
	if (fin < 0) err("en-tête non fermé (ligne « --- » attendue)");
	const entete = texte.slice(4, fin);
	let description = texte.slice(fin + 5);
	// Le fichier se termine par une fin de ligne ajoutée à l'écriture.
	if (description.endsWith("\n")) description = description.slice(0, -1);
	const o: Record<string, unknown> = {};
	for (const l of entete.split("\n")) {
		if (!l.trim()) continue;
		// [^\n] et non « . » : « . » ne reconnaît pas U+2028 ni U+2029, qu'un fichier écrit avant leur échappement
		// (ou à la main) peut contenir tels quels dans une valeur.
		const m = l.match(/^([a-z_]+):[ \t]?([^\n]*)$/);
		if (!m) err(`ligne d'en-tête illisible : ${l.slice(0, 60)}`);
		const [, k, v] = m!;
		if (!(CLES as readonly string[]).includes(k)) err(`clé inconnue : ${k}`);
		if (k in o) err(`clé en double : ${k}`);
		try { o[k] = JSON.parse(v); } catch { err(`${k} : valeur JSON sur une ligne attendue`); }
	}
	for (const k of CLES) if (!(k in o)) err(`clé manquante : ${k}`);
	const version = o.version;
	if (!Number.isInteger(version) || (version as number) < 1) err("version : entier ≥ 1 attendu");
	o.description = description;
	return { version: version as number, donnees: validerTicket(o, idAttendu) };
}

export const numero = (id: string): number => Number(id.slice(2));
export const cheminTicket = (id: string): string => {
	if (!ID_TICKET.test(id)) throw new ErreurTicket("id de ticket invalide");
	return `tickets/${id}.md`;
};
