// Retours : validation des documents (CONTRAT.md § 9), droits par rôle (docs/etape1-serveur.md § 3.1) et opérations
// d'écriture (création, modification, suppression, batch), chacune passée par la file d'attente du projet.
// Les fonctions de validation et de droits sont pures (testées cas par cas dans test/droits.test.ts).
import fs from "node:fs";
import path from "node:path";
import type { Role } from "./base.ts";
import type { Depot, Doc, Donnees, Ecriture, Auteur } from "./depot.ts";
import { ID_RETOUR, ErreurGit, ligne } from "./depot.ts";
import { idAleatoire } from "./base.ts";

export const CHAMPS = ["kind", "ref", "name", "tab", "anchor", "cat", "text", "proposal", "status", "reply", "replied", "created", "updated", "by", "codex"] as const;
// Champs facultatifs (étape 3.7, R2) : « captures », ids des captures jointes (captures.ts), posé à la création seulement.
// Étape 3.9, lot 2 :
//   field          libellé du champ de la fiche visé par le retour (R3) ; posé par l'auteur ;
//   pour           id du compte à qui le retour est confié (E3) ; posé par l'auteur, ou par un mainteneur ;
//   aussi          ids des comptes qui ont dit « Moi aussi » (R6), séparés par une espace ; posé par le serveur seulement ;
//   fusionne_dans  id du retour principal d'un doublon fusionné (R5) ; posé par le serveur seulement.
//   point          point visé sur l'image de la fiche (L9) : « x,y » relatifs (0 à 1, 4 décimales au plus) et, après « @ », les
//                  8 premiers caractères hexadécimaux du SHA-256 de l'image (une capture remplacée depuis se voit) ; posé par l'auteur.
//   externe        « testeur » : retour d'un testeur externe (E2) ; posé par le serveur seulement, à la création.
export const CHAMPS_FACULTATIFS = ["captures", "field", "pour", "aussi", "fusionne_dans", "point", "externe"] as const;
export const FORME_POINT = /^(0(\.\d{1,4})?|1(\.0{1,4})?),(0(\.\d{1,4})?|1(\.0{1,4})?)(@[0-9a-f]{8})?$/;
const PAR_LE_SERVEUR = ["aussi", "fusionne_dans", "externe"];
export const ID_COMPTE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_AUSSI = 200;
const ENSEMBLE_CHAMPS = new Set<string>([...CHAMPS, ...CHAMPS_FACULTATIFS]);
export const FORME_CAPTURES = /^[0-9a-f]{64}\.(png|webp)( [0-9a-f]{64}\.(png|webp)){0,2}$/;
// Champ « captures » d'un nouveau retour : forme (3 au plus), et chaque capture présente dans le projet
// (projets/<projet>/captures/, à côté du dépôt).
export function verifierCapturesCitees(racineProjets: string, projet: string, valeur: unknown): void {
	if (valeur === undefined || valeur === "") return;
	if (typeof valeur !== "string" || !FORME_CAPTURES.test(valeur)) throw invalide("captures : de 1 à 3 ids de capture séparés par une espace");
	for (const id of valeur.split(" ")) if (!fs.existsSync(path.join(racineProjets, projet, "captures", id))) throw invalide(`captures : ${id} inconnue dans ce projet (l'envoyer d'abord)`);
}
const capturesDe = (depot: Depot, d: Donnees) => verifierCapturesCitees(path.dirname(path.dirname(depot.dossier)), depot.projet, d.captures);
export const STATUTS = ["nouveau", "pris", "question", "fait", "refuse"];
const LONGS = new Set(["text", "proposal", "reply"]);
export const MAX_LONG = 20000, MAX_COURT = 1000, MAX_BATCH = 50;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;
export const estIso = (s: unknown): boolean => typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(s));

// Qui écrit : un compte (session) ou un jeton d'agent. Pour un jeton : son id (« jeton ») et son propriétaire
// (« pour », étape 3 § 1.4 ; absent ou null pour un jeton sans propriétaire).
// externe (étape 3.9, I2) : jeton « retour » d'un testeur externe ; ses retours sont marqués comme les siens.
export type Acteur = { id: string; nom: string; role: Role; email: string; agent: boolean; jeton?: string; pour?: { id: string; nom: string } | null; externe?: boolean };

// Auteur des commits d'un acteur : « Agent (pour Benoît) » pour un jeton à propriétaire, sinon le nom affiché.
// Seul endroit où ce nom est calculé (retours, tickets, notes, import, réglages).
export const nomCommit = (a: Acteur): string => a.pour ? `${a.nom} (pour ${a.pour.nom})` : a.nom;
export const auteurDe = (a: Acteur): Auteur => ({ nom: nomCommit(a), email: a.email });

// Erreur d'API : statut HTTP, code du contrat (CONTRAT.md § 6), données en plus (document à jour d'un 409…).
export class ErreurApi extends Error {
	statut: number; code: string; extra: Record<string, unknown>;
	constructor(statut: number, code: string, message: string, extra: Record<string, unknown> = {}) {
		super(message); this.statut = statut; this.code = code; this.extra = extra;
	}
}
export const invalide = (m: string, extra: Record<string, unknown> = {}) => new ErreurApi(400, "invalid_document", m, extra);
export const refuse = (m: string, extra: Record<string, unknown> = {}) => new ErreurApi(403, "permission_denied", m, extra);
export const absent = (m = "retour introuvable", extra: Record<string, unknown> = {}) => new ErreurApi(404, "not_found", m, extra);
export const conflit = (id: string, d: Doc | undefined, extra: Record<string, unknown> = {}) =>
	d ? new ErreurApi(409, "conflict", "version périmée : le retour a changé entre-temps", { ...extra, document: { id, version: d.version, donnees: d.donnees } })
		: absent("retour introuvable", extra);

const estObjet = (v: unknown): v is Donnees => !!v && typeof v === "object" && !Array.isArray(v);

// Un champ isolé : texte, longueur, forme (statut, dates).
export function validerChamp(k: string, v: unknown): void {
	if (!ENSEMBLE_CHAMPS.has(k)) throw invalide(`champ inconnu : ${k}`);
	if (typeof v !== "string") throw invalide(`${k} : texte attendu`);
	const max = LONGS.has(k) ? MAX_LONG : MAX_COURT;
	if (v.length > max) throw invalide(`${k} : ${v.length} caractères, ${max} au plus`);
	if (k === "status" && !STATUTS.includes(v)) throw invalide(`status inconnu : ${v}`);
	if ((k === "created" || k === "updated") && !estIso(v)) throw invalide(`${k} : date ISO 8601 attendue`);
	if (k === "replied" && v !== "" && !estIso(v)) throw invalide("replied : date ISO 8601 ou vide attendue");
	if (k === "field" && v.length > 200) throw invalide("field : 200 caractères au plus (le libellé du champ visé)");
	if (k === "pour" && v !== "" && !ID_COMPTE.test(v)) throw invalide("pour : id de compte attendu, ou vide");
	if (k === "fusionne_dans" && v !== "" && !ID_RETOUR.test(v)) throw invalide("fusionne_dans : id de retour attendu, ou vide");
	if (k === "externe" && v !== "" && v !== "testeur") throw invalide("externe : « testeur » ou vide");
	if (k === "point" && v !== "" && !FORME_POINT.test(v)) throw invalide("point : « x,y » de 0 à 1 (4 décimales au plus), suivi au besoin de « @ » et de 8 caractères hexadécimaux");
	if (k === "aussi" && v !== "") {
		const l = v.split(" ");
		if (l.length > MAX_AUSSI || !l.every(x => ID_COMPTE.test(x)) || new Set(l).size !== l.length) throw invalide(`aussi : ids de compte distincts séparés par une espace (${MAX_AUSSI} au plus)`);
	}
}

// Création : document complet (15 champs ; « by » facultatif, réécrit par le serveur), sans id ni version.
export function validerCreation(corps: unknown, acteur: Acteur): Donnees {
	if (!estObjet(corps)) throw invalide("objet attendu");
	for (const [k, v] of Object.entries(corps)) validerChamp(k, v);
	for (const k of CHAMPS) if (k !== "by" && corps[k] === undefined) throw invalide(`champ manquant : ${k}`);
	if (!corps.kind || !corps.ref) throw invalide("kind et ref ne peuvent pas être vides");
	if (corps.status !== "nouveau") throw invalide("un nouveau retour a le statut « nouveau »");
	if (corps.reply !== "" || corps.replied !== "") throw invalide("reply et replied sont vides à la création");
	for (const k of PAR_LE_SERVEUR) if (corps[k] !== undefined && corps[k] !== "") throw invalide(`${k} : posé par le serveur seulement (« Moi aussi », fusion, testeur externe)`);
	return { ...corps, by: acteur.id };
}

// Modification : champs à fusionner (au moins un), chacun valide.
export function validerChamps(champs: unknown): Donnees {
	if (!estObjet(champs)) throw invalide("champs : objet attendu");
	const cles = Object.keys(champs);
	if (!cles.length) throw invalide("champs : au moins un champ");
	for (const k of cles) validerChamp(k, champs[k]);
	return champs;
}

export function validerVersion(v: unknown): number {
	if (typeof v === "string" && /^\d{1,15}$/.test(v)) v = Number(v);
	if (!Number.isInteger(v) || (v as number) < 1) throw invalide("version : entier ≥ 1 attendu");
	return v as number;
}

// Étape 3.9, E2 : un testeur crée des retours, et ne touche qu'aux siens (jamais « pour », jamais « Moi aussi », ni fusion).
const ECRIVAINS: Role[] = ["contributeur", "mainteneur", "admin", "testeur", "retour"];
const SIEN_TESTEUR = new Set(["text", "proposal", "cat", "status", "updated", "field", "point"]);
const AGENT = new Set(["status", "reply", "replied", "updated"]);
const SIEN = new Set(["text", "proposal", "cat", "status", "updated", "field", "pour", "point"]);
// Étape 3.9, E3 : un mainteneur (ou un admin) confie un retour à quelqu'un, sur n'importe quel retour.
const CONFIER = new Set(["pour", "updated"]);
const AUTRE = new Set(["text", "status", "updated"]);

// Droits (§ 3.1). Rendent null si permis, sinon la raison du refus (403).
export function droitCreer(a: Acteur): string | null {
	return ECRIVAINS.includes(a.role) ? null : `le rôle ${a.role} ne crée pas de retour`;
}
export function droitSupprimer(a: Acteur, d: Donnees): string | null {
	if (a.role === "mainteneur" || a.role === "admin") return null;
	if (a.role === "contributeur" || a.role === "testeur") return d.by === a.id ? null : "seul l'auteur (ou un mainteneur) supprime ce retour";
	return `le rôle ${a.role} ne supprime pas de retour`;
}
export function droitModifier(a: Acteur, d: Donnees, champs: Donnees): string | null {
	const cles = Object.keys(champs);
	const hors = (permis: Set<string>) => cles.filter(k => !permis.has(k));
	if (a.role === "agent") {
		const h = hors(AGENT);
		return h.length ? `l'agent ne modifie que status, reply, replied, updated (refusé : ${h.join(", ")})` : null;
	}
	if (!ECRIVAINS.includes(a.role)) return `le rôle ${a.role} ne modifie pas de retour`;
	if ((a.role === "mainteneur" || a.role === "admin") && !hors(CONFIER).length) return null;
	if (a.role === "testeur") {
		if (d.by !== a.id) return "un testeur ne modifie que ses propres retours";
		const h = hors(SIEN_TESTEUR);
		if (h.length) return `champs non modifiables par un testeur : ${h.join(", ")}`;
		if (champs.status !== undefined && champs.status !== "nouveau") return "l'auteur ne peut remettre le statut qu'à « nouveau »";
		return null;
	}
	if (d.by === a.id) {
		// Son retour : texte, proposition, type ; le statut seulement remis à « nouveau » (réponse à une question).
		const h = hors(SIEN);
		if (h.length) return `champs non modifiables par l'auteur : ${h.join(", ")}`;
		if (champs.status !== undefined && champs.status !== "nouveau") return "l'auteur ne peut remettre le statut qu'à « nouveau »";
		return null;
	}
	// Retour d'un autre : seulement ajouter à la fin du texte, le statut repassant à « nouveau ».
	const h = hors(AUTRE);
	if (h.length) return `sur le retour d'un autre, seul un ajout au texte est permis (refusé : ${h.join(", ")})`;
	const avant = String(d.text ?? "");
	if (typeof champs.text !== "string" || !champs.text.startsWith(avant) || champs.text.length <= avant.length) return "sur le retour d'un autre, le nouveau texte doit commencer par l'ancien et l'allonger";
	if (champs.status !== "nouveau") return "un ajout au retour d'un autre le remet au statut « nouveau »";
	return null;
}

// --- Opérations (chacune dans la file du projet) ------------------------------------------------------------
export type Diffuseur = (depot: Depot) => void;
const sujet = (id: string, action: string, d: Donnees) => `retour ${id} : ${action} (${ligne(d.kind, 40)}/${ligne(d.ref, 60)})`;
// Échec de Git : message générique pour le client (la sortie de Git, chemins du serveur compris, est au journal).
export const MESSAGE_INDISPONIBLE = "écriture impossible dans le dépôt, réessaie";
export const indisponible = (e: unknown): never => {
	if (e instanceof ErreurApi) throw e;
	if (e instanceof ErreurGit) throw new ErreurApi(503, "unavailable", MESSAGE_INDISPONIBLE);
	throw e;
};

// Étape 3.9, E2 : un testeur ne confie pas de retour (il ne connaît pas les membres) ; son retour est marqué « externe »
// (l'agent et l'équipe savent qu'il vient de l'extérieur, et que la réponse lui sera lue).
function sansConfier(a: Acteur, d: Donnees): void {
	if (a.role !== "testeur" && !a.externe) return;
	if (d.pour) throw refuse("un testeur ne confie pas de retour (champ pour)");
	d.externe = "testeur";
}

export function creer(depot: Depot, a: Acteur, corps: unknown, diffuser: Diffuseur): Promise<{ id: string; version: number; rev: string }> {
	const r = droitCreer(a); if (r) return Promise.reject(refuse(r));
	let donnees: Donnees;
	try { donnees = validerCreation(corps, a); sansConfier(a, donnees); capturesDe(depot, donnees); } catch (e) { return Promise.reject(e); }
	return depot.file.executer(async () => {
		let id = idAleatoire(20);
		while (depot.index.has(id) || depot.homonyme(id)) id = idAleatoire(20);
		const doc: Doc = { version: 1, donnees };
		const rev = await depot.appliquer([{ id, doc }], auteurDe(a), sujet(id, "création", donnees)).catch(indisponible);
		diffuser(depot);
		return { id, version: 1, rev };
	});
}

// Série de retours (étape 3.7, R1) : les brouillons d'une séance de test, créés d'un coup. Tout ou rien, un seul
// commit (« série : n retours »), une seule diffusion : l'agent ne voit pas les premiers avant la fin de la série.
// Mêmes règles que creer() pour chaque document ; 50 au plus (MAX_BATCH). Réponse : les ids dans l'ordre reçu.
export function creerSerie(depot: Depot, a: Acteur, corps: unknown, diffuser: Diffuseur): Promise<{ ids: string[]; rev: string }> {
	const r = droitCreer(a); if (r) return Promise.reject(refuse(r));
	let liste: Donnees[];
	try {
		if (!estObjet(corps)) throw invalide("objet { retours } attendu");
		for (const k of Object.keys(corps)) if (k !== "retours") throw invalide(`clé inconnue : ${k}`);
		const l = corps.retours;
		if (!Array.isArray(l) || !l.length) throw invalide("retours : liste non vide attendue");
		if (l.length > MAX_BATCH) throw invalide(`retours : ${MAX_BATCH} au plus (reçu ${l.length})`);
		liste = l.map((x: unknown, i: number) => {
			try { const d = validerCreation(x, a); sansConfier(a, d); capturesDe(depot, d); return d; }
			catch (err) { if (err instanceof ErreurApi) err.extra = { index: i, ...err.extra }; throw err; }
		});
	} catch (e) { return Promise.reject(e); }
	return depot.file.executer(async () => {
		const pris = new Set<string>();
		const ecritures: Ecriture[] = liste.map(donnees => {
			let id = idAleatoire(20);
			while (depot.index.has(id) || depot.homonyme(id) || pris.has(id)) id = idAleatoire(20);
			pris.add(id);
			return { id, doc: { version: 1, donnees } };
		});
		const rev = await depot.appliquer(ecritures, auteurDe(a), `série : ${ecritures.length} retour${ecritures.length > 1 ? "s" : ""}`).catch(indisponible);
		diffuser(depot);
		return { ids: ecritures.map(e => e.id), rev };
	});
}

// Vérifie une écriture sur un retour existant (id, existence, version, champs, droits) ; rend le nouveau document.
function preparerModif(depot: Depot, a: Acteur, id: unknown, version: unknown, champs: unknown, extra: Record<string, unknown> = {}): Ecriture {
	if (typeof id !== "string" || !ID_RETOUR.test(id)) throw absent("retour introuvable (id invalide)", extra);
	const d = depot.index.get(id);
	if (!d) throw absent("retour introuvable", extra);
	const v = validerVersion(version);
	const c = validerChamps(champs);
	const r = droitModifier(a, d.donnees, c); if (r) throw refuse(r, extra);
	if (v !== d.version) throw conflit(id, d, extra);
	return { id, doc: { version: d.version + 1, donnees: { ...d.donnees, ...c } } };
}

export function modifier(depot: Depot, a: Acteur, id: string, corps: unknown, diffuser: Diffuseur): Promise<{ version: number; rev: string }> {
	return depot.file.executer(async () => {
		if (!estObjet(corps)) throw invalide("objet { champs, version } attendu");
		for (const k of Object.keys(corps)) if (k !== "champs" && k !== "version") throw invalide(`clé inconnue : ${k}`);
		const e = preparerModif(depot, a, id, corps.version, corps.champs);
		const rev = await depot.appliquer([e], auteurDe(a), sujet(id, "modification", e.doc!.donnees)).catch(indisponible);
		diffuser(depot);
		return { version: e.doc!.version, rev };
	});
}

export function supprimer(depot: Depot, a: Acteur, id: string, version: unknown, diffuser: Diffuseur): Promise<{ rev: string }> {
	return depot.file.executer(async () => {
		if (!ID_RETOUR.test(id)) throw absent("retour introuvable (id invalide)");
		const d = depot.index.get(id);
		if (!d) throw absent();
		const v = validerVersion(version);
		const r = droitSupprimer(a, d.donnees); if (r) throw refuse(r);
		if (v !== d.version) throw conflit(id, d);
		const rev = await depot.appliquer([{ id, doc: null }], auteurDe(a), sujet(id, "suppression", d.donnees)).catch(indisponible);
		diffuser(depot);
		return { rev };
	});
}

// Batch : tout ou rien. Toutes les entrées sont validées avant d'écrire quoi que ce soit ; la première fautive est
// renvoyée (index, id et, sur un 409, son document à jour) ; un seul commit.
export function batch(depot: Depot, a: Acteur, corps: unknown, diffuser: Diffuseur): Promise<{ versions: { id: string; version: number }[]; rev: string }> {
	return depot.file.executer(async () => {
		if (!estObjet(corps)) throw invalide("objet { ecritures } attendu");
		for (const k of Object.keys(corps)) if (k !== "ecritures") throw invalide(`clé inconnue : ${k}`);
		const liste = corps.ecritures;
		if (!Array.isArray(liste) || !liste.length) throw invalide("ecritures : liste non vide attendue");
		if (liste.length > MAX_BATCH) throw invalide(`ecritures : ${MAX_BATCH} au plus (reçu ${liste.length})`);
		const vus = new Set<string>();
		const ecritures: Ecriture[] = liste.map((x: unknown, i: number) => {
			const extra = { index: i, id: estObjet(x) ? x.id : undefined };
			if (!estObjet(x)) throw invalide("entrée : objet { id, version, champs } attendu", extra);
			for (const k of Object.keys(x)) if (!["id", "version", "champs"].includes(k)) throw invalide(`entrée : clé inconnue ${k}`, extra);
			if (typeof x.id === "string" && vus.has(x.id)) throw invalide("le même retour deux fois dans un batch", extra);
			try {
				const e = preparerModif(depot, a, x.id, x.version, x.champs, extra);
				vus.add(e.id);
				return e;
			} catch (err) {
				if (err instanceof ErreurApi) err.extra = { ...extra, ...err.extra };
				throw err;
			}
		});
		const rev = await depot.appliquer(ecritures, auteurDe(a), `batch : ${ecritures.length} retour${ecritures.length > 1 ? "s" : ""}`).catch(indisponible);
		diffuser(depot);
		return { versions: ecritures.map(e => ({ id: e.id, version: e.doc!.version })), rev };
	});
}

// --- Étape 3.9, lot 2 : « Moi aussi » (R6) et fusion des doublons (R5) ------------------------------------------
const sansVide = (s: unknown) => String(s ?? "").split(" ").filter(Boolean);

// « Moi aussi » : l'acteur (un compte qui écrit, pas un agent, pas l'auteur) s'ajoute à « aussi », ou s'en retire.
// Le statut, le texte et la réponse ne changent pas. Déjà dans l'état demandé : rien n'est écrit (inchange).
export function droitAussi(a: Acteur, d: Donnees): string | null {
	if (a.agent || a.role === "agent") return "un agent ne dit pas « Moi aussi »";
	if (!ECRIVAINS.includes(a.role) || a.role === "testeur") return `le rôle ${a.role} ne dit pas « Moi aussi »`;
	if (d.by === a.id) return "c'est ton retour";
	return null;
}
export function aussi(depot: Depot, a: Acteur, id: string, version: unknown, ajouter: boolean, diffuser: Diffuseur): Promise<{ version: number; rev?: string; inchange?: boolean }> {
	return depot.file.executer(async () => {
		if (!ID_RETOUR.test(id)) throw absent("retour introuvable (id invalide)");
		const d = depot.index.get(id);
		if (!d) throw absent();
		const v = validerVersion(version);
		const r = droitAussi(a, d.donnees); if (r) throw refuse(r);
		if (v !== d.version) throw conflit(id, d);
		const l = sansVide(d.donnees.aussi);
		if (l.includes(a.id) === ajouter) return { version: d.version, inchange: true };
		const n = ajouter ? [...l, a.id] : l.filter(x => x !== a.id);
		if (n.length > MAX_AUSSI) throw invalide(`aussi : ${MAX_AUSSI} au plus`);
		const doc = { version: d.version + 1, donnees: { ...d.donnees, aussi: n.join(" ") } };
		const rev = await depot.appliquer([{ id, doc }], auteurDe(a), sujet(id, ajouter ? "moi aussi" : "plus concerné", d.donnees)).catch(indisponible);
		diffuser(depot);
		return { version: doc.version, rev };
	});
}

// Fusion : un mainteneur (ou un admin, en session) désigne un retour principal et ses doublons. Chaque doublon passe
// « fait », avec une réponse qui dit où il est passé et fusionne_dans ; son texte n'est jamais réécrit. Le principal
// reçoit dans « aussi » les auteurs des doublons (et leurs « aussi »), sauf son propre auteur. Tout ou rien, un commit.
export function droitFusionner(a: Acteur): string | null {
	if (a.agent || a.role === "agent") return "un agent ne fusionne pas de retours (c'est un geste humain)";
	return a.role === "mainteneur" || a.role === "admin" ? null : "seul un mainteneur fusionne des retours";
}
export function fusionner(depot: Depot, a: Acteur, id: string, corps: unknown, maintenant: string, diffuser: Diffuseur): Promise<{ versions: { id: string; version: number }[]; rev: string }> {
	return depot.file.executer(async () => {
		const r = droitFusionner(a); if (r) throw refuse(r);
		if (!estObjet(corps)) throw invalide("objet { version, doublons: [{ id, version }] } attendu");
		for (const k of Object.keys(corps)) if (k !== "version" && k !== "doublons") throw invalide(`clé inconnue : ${k}`);
		if (!ID_RETOUR.test(id)) throw absent("retour introuvable (id invalide)");
		const p = depot.index.get(id);
		if (!p) throw absent("retour principal introuvable");
		if (validerVersion(corps.version) !== p.version) throw conflit(id, p);
		if (p.donnees.fusionne_dans) throw invalide("le principal est lui-même fusionné dans un autre retour");
		const l = corps.doublons;
		if (!Array.isArray(l) || !l.length) throw invalide("doublons : liste non vide attendue");
		if (l.length > MAX_BATCH - 1) throw invalide(`doublons : ${MAX_BATCH - 1} au plus`);
		const vus = new Set<string>([id]);
		const ecritures: Ecriture[] = [];
		const aussiP = sansVide(p.donnees.aussi);
		const ajouter = (x: unknown) => { const s = String(x ?? ""); if (s && s !== p.donnees.by && !aussiP.includes(s)) aussiP.push(s); };
		const nom = String(p.donnees.name || p.donnees.ref || id);
		for (const [i, x] of l.entries()) {
			const extra = { index: i, id: estObjet(x) ? x.id : undefined };
			if (!estObjet(x) || typeof x.id !== "string" || !ID_RETOUR.test(x.id)) throw invalide("doublon : { id, version } attendu", extra);
			if (vus.has(x.id)) throw invalide(x.id === id ? "un retour ne se fusionne pas dans lui-même" : "le même doublon deux fois", extra);
			vus.add(x.id);
			const d = depot.index.get(x.id);
			if (!d) throw absent("doublon introuvable", extra);
			if (validerVersion(x.version) !== d.version) throw conflit(x.id, d, extra);
			if (d.donnees.fusionne_dans) throw invalide("ce doublon est déjà fusionné", extra);
			ajouter(d.donnees.by);
			for (const s of sansVide(d.donnees.aussi)) ajouter(s);
			ecritures.push({ id: x.id, doc: { version: d.version + 1, donnees: { ...d.donnees, status: "fait", fusionne_dans: id,
				reply: `Fusionné dans le retour « ${ligne(nom, 80)} » (${id}), qui reprend le même point : la suite y est suivie.`, replied: maintenant, updated: maintenant } } });
		}
		if (aussiP.length > MAX_AUSSI) throw invalide(`aussi : ${MAX_AUSSI} au plus`);
		ecritures.unshift({ id, doc: { version: p.version + 1, donnees: { ...p.donnees, aussi: aussiP.join(" "), updated: maintenant } } });
		const rev = await depot.appliquer(ecritures, auteurDe(a), `fusion : ${ecritures.length - 1} retour${ecritures.length > 2 ? "s" : ""} dans ${id}`).catch(indisponible);
		diffuser(depot);
		return { versions: ecritures.map(e => ({ id: e.id, version: e.doc!.version })), rev };
	});
}
