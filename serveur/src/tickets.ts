// Tickets (docs/etape3-meta-interface.md § 1) : droits (§ 1.3), cycle (§ 1.2) et opérations, chacune dans la file
// d'écriture du projet, un commit par écriture. Fermer écrit le ticket ET ses retours dans un seul commit, tout ou rien.
// Les fonctions de droits et de transitions sont pures (testées cas par cas dans test/tickets.test.ts) ; les routes
// PATCH (champ statut) et prendre / rendre / fermer / rouvrir passent toutes par transition().
import type { Depot, Doc } from "./depot.ts";
import { ID_RETOUR, estIllisible, ligne } from "./depot.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, refuse, absent, conflit, indisponible, auteurDe, validerVersion, MAX_LONG } from "./retours.ts";
import type { Ticket, DocTicket, Personne, StatutTicket, CommitLie } from "./ticket-fichier.ts";
import {
	ID_TICKET, STATUTS_TICKET, ErreurTicket, validerTitre, validerDescription, validerDiscipline, validerRetoursLies, validerPages,
	validerCriteres, validerCommit, memeCommit, MAX_COMMITS, analyser, serialiser,
} from "./ticket-fichier.ts";
import { isDeepStrictEqual } from "node:util";

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// --- Qui ----------------------------------------------------------------------------------------------------
export function personneDe(a: Acteur): Personne {
	if (a.agent) {
		const p: Personne = { type: "agent", id: a.jeton || a.id.replace(/^agent:/, ""), nom: a.nom };
		if (a.pour) p.pour = { id: a.pour.id, nom: a.pour.nom };
		return p;
	}
	return { type: "compte", id: a.id, nom: a.nom };
}
const meme = (p: Personne | null, a: Acteur): boolean => {
	if (!p) return false;
	const q = personneDe(a);
	return p.type === q.type && p.id === q.id;
};
// Le tient : il en est le preneur et le ticket est en cours (pris ou en revue).
export const tient = (a: Acteur, t: Ticket): boolean => (t.statut === "pris" || t.statut === "en-revue") && meme(t.pris_par, a);
export const estAuteur = (a: Acteur, t: Ticket): boolean => meme(t.auteur, a);
// Mainteneur : compte mainteneur, admin, ou jeton mainteneur (qui ne ferme jamais : voir transition()).
export const estMainteneur = (a: Acteur): boolean => a.role === "mainteneur" || a.role === "admin";
const nomPersonne = (p: Personne | null): string => !p ? "personne" : p.pour ? `${p.nom} · pour ${p.pour.nom}` : p.nom;

// --- Droits (§ 1.3) : null si permis, sinon la raison (403) ---------------------------------------------------
export function droitCreerTicket(a: Acteur): string | null {
	return (a.role === "lecteur" || a.role === "testeur" || a.role === "retour") ? `le rôle ${a.role} ne crée pas de ticket` : null;
}
// Champs titre, description, discipline, retours, pages, criteres. « cocherSeulement » : la liste des critères ne
// change que par leurs cases « fait » (mêmes textes, même ordre).
export function droitChampsTicket(a: Acteur, t: Ticket, champs: string[], cocherSeulement: boolean): string | null {
	if ((a.role === "lecteur" || a.role === "testeur" || a.role === "retour")) return `le rôle ${a.role} ne modifie pas de ticket`;
	if (estMainteneur(a)) return null;
	if (t.statut === "fait") return "ticket fait : seul un mainteneur le modifie (ou le rouvre)";
	if (estAuteur(a, t)) return null;
	if (tient(a, t)) {
		if (champs.length === 1 && champs[0] === "criteres" && cocherSeulement) return null;
		return "sur un ticket que tu tiens sans en être l'auteur, seules les cases des critères se cochent";
	}
	return a.agent ? "un agent ne modifie pas le ticket d'un autre" : "seul l'auteur (ou un mainteneur) modifie ce ticket";
}
export function droitCommits(a: Acteur, t: Ticket): string | null {
	if ((a.role === "lecteur" || a.role === "testeur" || a.role === "retour")) return `le rôle ${a.role} n'ajoute pas de commit`;
	if (estMainteneur(a) || tient(a, t)) return null;
	return "seul le preneur du ticket (ou un mainteneur) y ajoute des commits";
}
export function droitSupprimerTicket(a: Acteur): string | null {
	return estMainteneur(a) ? null : "seul un mainteneur supprime un ticket";
}

// --- Cycle (§ 1.2) ------------------------------------------------------------------------------------------
export type Action = "prendre" | "rendre" | "revue" | "renvoyer" | "fermer" | "rouvrir";
export type Issue =
	| { ok: true; statut: StatutTicket; pris_par: Personne | null; inchange?: boolean; forcee?: boolean }
	| { ok: false; statut: 400 | 403 | 409; raison: string };
const non = (statut: 400 | 403 | 409, raison: string): Issue => ({ ok: false, statut, raison });

// Seule fonction qui change le statut ou le preneur d'un ticket.
export function transition(a: Acteur, t: Ticket, action: Action, forcer = false): Issue {
	if ((a.role === "lecteur" || a.role === "testeur" || a.role === "retour")) return non(403, `le rôle ${a.role} ne change pas l'état d'un ticket`);
	const preneurOuMainteneur = tient(a, t) || estMainteneur(a);
	const inchange = (): Issue => ({ ok: true, statut: t.statut, pris_par: t.pris_par, inchange: true });
	switch (action) {
		case "prendre":
			if (t.statut === "fait") return non(400, "ticket fait : le rouvrir d'abord");
			if (t.statut === "a-faire") return { ok: true, statut: "pris", pris_par: personneDe(a) };
			if (meme(t.pris_par, a)) return inchange();
			if (!forcer) return non(409, `ticket tenu par ${nomPersonne(t.pris_par)}`);
			if (!estMainteneur(a)) return non(403, "seul un mainteneur prend de force un ticket tenu par un autre");
			return { ok: true, statut: "pris", pris_par: personneDe(a), forcee: true };
		case "rendre":
			if (t.statut === "fait") return non(400, "ticket fait : le rouvrir (mainteneur) plutôt que le rendre");
			if (t.statut === "a-faire") return inchange();
			if (!preneurOuMainteneur) return non(403, "seul le preneur (ou un mainteneur) rend ce ticket");
			return { ok: true, statut: "a-faire", pris_par: null };
		case "revue":
			if (t.statut === "en-revue" && preneurOuMainteneur) return inchange();
			if (t.statut !== "pris") return non(400, `passage en revue impossible depuis « ${t.statut} » (le ticket doit être pris)`);
			if (!preneurOuMainteneur) return non(403, "seul le preneur (ou un mainteneur) passe ce ticket en revue");
			return { ok: true, statut: "en-revue", pris_par: t.pris_par };
		case "renvoyer":
			if (t.statut === "pris" && preneurOuMainteneur) return inchange();
			if (t.statut !== "en-revue") return non(400, `renvoi impossible depuis « ${t.statut} » (le ticket doit être en revue)`);
			if (!preneurOuMainteneur) return non(403, "seul le preneur (ou un mainteneur) renvoie ce ticket");
			return { ok: true, statut: "pris", pris_par: t.pris_par };
		case "fermer":
			// Fermer reste un geste humain : jamais un jeton, même mainteneur.
			if (a.agent) return non(403, "un agent ne ferme jamais un ticket : la fermeture est humaine (mainteneur)");
			if (!estMainteneur(a)) return non(403, "seul un mainteneur ou un admin ferme un ticket");
			if (t.statut === "fait") return non(400, "ticket déjà fait");
			if (t.statut === "a-faire") return non(400, "ticket à faire : il doit être pris ou en revue pour être fermé");
			return { ok: true, statut: "fait", pris_par: t.pris_par };
		case "rouvrir":
			if (!estMainteneur(a)) return non(403, "seul un mainteneur rouvre un ticket");
			if (t.statut !== "fait") return non(400, "seul un ticket fait se rouvre");
			return { ok: true, statut: "a-faire", pris_par: null };
	}
}
// Champ « statut » d'un PATCH : la transition équivalente (jamais vers « fait », jamais depuis « fait »).
export function actionPourStatut(de: StatutTicket, vers: StatutTicket): Action | null | string {
	if (de === vers) return null;
	if (vers === "fait") return "pour fermer, utiliser POST …/fermer (mainteneur)";
	if (de === "fait") return "pour rouvrir, utiliser POST …/rouvrir (mainteneur)";
	if (vers === "pris") return de === "a-faire" ? "prendre" : "renvoyer";
	if (vers === "a-faire") return "rendre";
	if (vers === "en-revue") return de === "pris" ? "revue" : "un ticket à faire doit être pris avant d'être passé en revue";
	return "transition inconnue";
}

// --- Opérations -----------------------------------------------------------------------------------------------
export type ContexteTickets = {
	depot: Depot;
	a: Acteur;
	disciplines: () => string[];
	diffuser: (retoursAussi: boolean) => void;
	journaliser: (action: string, cible: string, detail?: unknown) => void;
};
const conflitTicket = (id: string, d: DocTicket, raison = "version périmée : le ticket a changé entre-temps") =>
	new ErreurApi(409, "conflict", raison, { document: { id, version: d.version, donnees: d.donnees } });
const erreurIssue = (id: string, d: DocTicket, i: Issue & { ok: false }): ErreurApi =>
	i.statut === 409 ? conflitTicket(id, d, i.raison) : i.statut === 403 ? refuse(i.raison) : invalide(i.raison);

// Ticket existant et lisible, sinon 404 ou 422.
function trouver(depot: Depot, id: string): DocTicket {
	if (!ID_TICKET.test(id)) throw absent("ticket introuvable (id T-<n> attendu)");
	const e = depot.tickets.get(id);
	if (!e) throw absent("ticket introuvable");
	if (estIllisible(e)) throw new ErreurApi(422, "invalid_document", `ticket illisible (${e.erreur}) : à corriger à la main dans le dépôt de design, par un commit, serveur arrêté`, { illisible: true });
	return e;
}
// Erreur de forme (ticket-fichier.ts) → 400.
function forme<T>(f: () => T): T {
	try { return f(); } catch (e) { if (e instanceof ErreurTicket) throw invalide(e.message); throw e; }
}
function verifierRetoursExistent(depot: Depot, ids: string[]): void {
	const manquants = ids.filter(id => !depot.index.has(id));
	if (manquants.length) throw invalide(`retours introuvables : ${manquants.join(", ")}`, { retours: manquants });
}
function verifierDiscipline(ctx: ContexteTickets, d: string): void {
	if (d && !ctx.disciplines().includes(d)) throw invalide(`discipline inconnue : ${d} (disciplines du projet : ${ctx.disciplines().join(", ") || "aucune"})`);
}
// Sujet du commit quand seules des cases de critères changent (mêmes textes, même ordre) : « critère 2 coché »,
// « critères 1, 3 cochés, critère 2 décoché ». L'historique dit ainsi quel critère a été coché. Sinon : null.
function casesChangees(avant: Ticket["criteres"], apres: Ticket["criteres"]): string | null {
	if (avant.length !== apres.length || avant.some((c, i) => c.texte !== apres[i].texte)) return null;
	const coches: number[] = [], decoches: number[] = [];
	apres.forEach((c, i) => { if (c.fait !== avant[i].fait) (c.fait ? coches : decoches).push(i + 1); });
	const partie = (l: number[], mot: string) => l.length > 1 ? `critères ${l.join(", ")} ${mot}s` : `critère ${l[0]} ${mot}`;
	const parties = [coches.length ? partie(coches, "coché") : "", decoches.length ? partie(decoches, "décoché") : ""].filter(Boolean);
	return parties.length ? parties.join(", ") : null;
}
const sujet = (id: string, action: string, t?: Ticket) => `ticket ${id} : ${action}${t ? ` (${ligne(t.titre, 60)})` : ""}`;
const maintenant = () => new Date().toISOString();

// Écrit un ticket (et éventuellement des retours, .dernier) en un commit, puis diffuse.
async function ecrire(ctx: ContexteTickets, id: string, doc: DocTicket | null, message: string, extra: { retours?: { id: string; doc: Doc }[]; dernier?: number } = {}): Promise<string> {
	// Avant le commit : le fichier, relu depuis ses octets UTF-8, doit redonner exactement le document. Sinon le ticket
	// deviendrait illisible (ou différent) au prochain chargement ; mieux vaut refuser l'écriture (400).
	if (doc) {
		const relu = forme(() => analyser(Buffer.from(serialiser(doc), "utf8").toString("utf8"), id));
		if (!isDeepStrictEqual(relu, doc)) throw invalide("ticket : le fichier ne se relirait pas à l'identique (caractère refusé)");
	}
	const rev = await ctx.depot.appliquerTout({ tickets: [{ id, doc }], retours: extra.retours, dernier: extra.dernier }, auteurDe(ctx.a), message).catch(indisponible);
	ctx.diffuser(!!extra.retours?.length);
	return rev;
}

const CHAMPS_CREATION = ["titre", "description", "discipline", "retours", "pages", "criteres"];
export function creerTicket(ctx: ContexteTickets, corps: unknown): Promise<{ id: string; version: number; rev: string }> {
	const r = droitCreerTicket(ctx.a); if (r) return Promise.reject(refuse(r));
	return ctx.depot.file.executer(async () => {
		if (!estObjet(corps)) throw invalide("objet { titre, description?, discipline?, retours?, pages?, criteres? } attendu");
		for (const k of Object.keys(corps)) if (!CHAMPS_CREATION.includes(k)) throw invalide(`clé inconnue ou posée par le serveur : ${k}`);
		const titre = forme(() => validerTitre(corps.titre));
		const description = corps.description === undefined ? "" : forme(() => validerDescription(corps.description));
		const discipline = corps.discipline === undefined ? "" : forme(() => validerDiscipline(corps.discipline));
		const retours = corps.retours === undefined ? [] : forme(() => validerRetoursLies(corps.retours));
		const pages = corps.pages === undefined ? [] : forme(() => validerPages(corps.pages));
		const criteres = corps.criteres === undefined ? [] : forme(() => validerCriteres(corps.criteres));
		verifierDiscipline(ctx, discipline);
		verifierRetoursExistent(ctx.depot, retours);
		const n = ctx.depot.dernier + 1, id = `T-${n}`, t = maintenant();
		if (!ID_TICKET.test(id)) throw invalide("numérotation des tickets épuisée (T-999999999 atteint)");
		const donnees: Ticket = { id, titre, statut: "a-faire", discipline, pris_par: null, retours, pages, criteres, commits: [], auteur: personneDe(ctx.a), cree: t, modifie: t, description };
		const rev = await ecrire(ctx, id, { version: 1, donnees }, sujet(id, "création", donnees), { dernier: n });
		return { id, version: 1, rev };
	});
}

const CHAMPS_PATCH = ["titre", "description", "discipline", "retours", "pages", "criteres", "statut"];
export function modifierTicket(ctx: ContexteTickets, id: string, corps: unknown): Promise<{ version: number; rev: string; inchange?: boolean }> {
	if (ctx.a.role === "lecteur" || ctx.a.role === "testeur" || ctx.a.role === "retour") return Promise.reject(refuse("le rôle lecteur ne modifie pas de ticket"));
	return ctx.depot.file.executer(async () => {
		const d = trouver(ctx.depot, id);
		if (!estObjet(corps)) throw invalide("objet { version, champs } attendu");
		for (const k of Object.keys(corps)) if (k !== "champs" && k !== "version") throw invalide(`clé inconnue : ${k}`);
		const v = validerVersion(corps.version);
		const champs = corps.champs;
		if (!estObjet(champs) || !Object.keys(champs).length) throw invalide("champs : objet non vide attendu");
		for (const k of Object.keys(champs)) if (!CHAMPS_PATCH.includes(k)) throw invalide(`champ non modifiable : ${k}`);
		const t = d.donnees, n: Ticket = { ...t };
		if (champs.titre !== undefined) n.titre = forme(() => validerTitre(champs.titre));
		if (champs.description !== undefined) n.description = forme(() => validerDescription(champs.description));
		if (champs.discipline !== undefined) n.discipline = forme(() => validerDiscipline(champs.discipline));
		if (champs.retours !== undefined) n.retours = forme(() => validerRetoursLies(champs.retours));
		if (champs.pages !== undefined) n.pages = forme(() => validerPages(champs.pages));
		if (champs.criteres !== undefined) n.criteres = forme(() => validerCriteres(champs.criteres));
		let statut: StatutTicket | undefined;
		if (champs.statut !== undefined) {
			if (!(STATUTS_TICKET as readonly string[]).includes(champs.statut as string)) throw invalide(`statut inconnu : ${champs.statut}`);
			statut = champs.statut as StatutTicket;
		}
		// Droits sur les champs (hors statut), puis sur la transition.
		const autres = Object.keys(champs).filter(k => k !== "statut");
		if (autres.length) {
			const cocher = champs.criteres !== undefined && n.criteres.length === t.criteres.length && n.criteres.every((c, i) => c.texte === t.criteres[i].texte);
			const r = droitChampsTicket(ctx.a, t, autres, cocher); if (r) throw refuse(r);
		}
		let issue: Issue | null = null;
		if (statut !== undefined) {
			const act = actionPourStatut(t.statut, statut);
			if (typeof act === "string" && !["prendre", "rendre", "revue", "renvoyer"].includes(act)) throw invalide(act);
			if (act) {
				issue = transition(ctx.a, t, act as Action);
				if (!issue.ok && issue.statut === 403) throw refuse(issue.raison);
			}
		}
		if (v !== d.version) throw conflitTicket(id, d);
		if (issue && !issue.ok) throw erreurIssue(id, d, issue);
		// Seulement le statut, et rien ne change (statut actuel, ou transition sans effet) : aucune écriture. Sans cela, un
		// PATCH { statut: <actuel> } écrirait sans aucun contrôle de droits.
		if (!autres.length && (!issue || (issue.ok && issue.inchange))) return { version: d.version, rev: ctx.depot.rev, inchange: true };
		if (champs.discipline !== undefined) verifierDiscipline(ctx, n.discipline);
		// Les retours liés ne sont revérifiés que si le champ est écrit (un retour supprimé depuis ne bloque pas le ticket).
		if (champs.retours !== undefined) verifierRetoursExistent(ctx.depot, n.retours.filter(r => !t.retours.includes(r)));
		if (issue && issue.ok) { n.statut = issue.statut; n.pris_par = issue.pris_par; }
		n.modifie = maintenant();
		const action = issue && issue.ok && !issue.inchange ? { "a-faire": "rendu", pris: "pris", "en-revue": "en revue", fait: "fait" }[issue.statut]
			: autres.length === 1 && autres[0] === "criteres" ? casesChangees(t.criteres, n.criteres) || "modification" : "modification";
		const rev = await ecrire(ctx, id, { version: d.version + 1, donnees: n }, sujet(id, action, n));
		return { version: d.version + 1, rev };
	});
}

// prendre, rendre, rouvrir : { version[, forcer] }.
export function changerEtat(ctx: ContexteTickets, id: string, action: "prendre" | "rendre" | "rouvrir", corps: unknown): Promise<{ version: number; rev: string; inchange?: boolean }> {
	return ctx.depot.file.executer(async () => {
		const d = trouver(ctx.depot, id);
		if (!estObjet(corps)) throw invalide("objet { version" + (action === "prendre" ? ", forcer?" : "") + " } attendu");
		for (const k of Object.keys(corps)) if (k !== "version" && !(action === "prendre" && k === "forcer")) throw invalide(`clé inconnue : ${k}`);
		const v = validerVersion(corps.version);
		if (corps.forcer !== undefined && typeof corps.forcer !== "boolean") throw invalide("forcer : vrai ou faux");
		const issue = transition(ctx.a, d.donnees, action, corps.forcer === true);
		if (!issue.ok && issue.statut === 403) throw refuse(issue.raison);
		if (v !== d.version) throw conflitTicket(id, d);
		if (!issue.ok) throw erreurIssue(id, d, issue);
		if (issue.inchange) return { version: d.version, rev: ctx.depot.rev, inchange: true };
		const n: Ticket = { ...d.donnees, statut: issue.statut, pris_par: issue.pris_par, modifie: maintenant() };
		const libelle = action === "prendre" ? (issue.forcee ? "pris de force" : "pris") : action === "rendre" ? "rendu" : "rouvert";
		const rev = await ecrire(ctx, id, { version: d.version + 1, donnees: n }, sujet(id, libelle, n));
		if (issue.forcee) ctx.journaliser("prise forcée", id, { avant: d.donnees.pris_par });
		if (action === "rouvrir") ctx.journaliser("ticket rouvert", id);
		return { version: d.version + 1, rev };
	});
}

// Ajout de commits : doublons (même dépôt, hash préfixe l'un de l'autre) ignorés, dans la requête comme avec l'existant.
export function ajouterCommits(ctx: ContexteTickets, id: string, corps: unknown): Promise<{ version: number; rev: string; ajoutes: number; inchange?: boolean }> {
	return ctx.depot.file.executer(async () => {
		const d = trouver(ctx.depot, id);
		if (!estObjet(corps)) throw invalide("objet { version, commits } attendu");
		for (const k of Object.keys(corps)) if (k !== "version" && k !== "commits") throw invalide(`clé inconnue : ${k}`);
		const v = validerVersion(corps.version);
		if (!Array.isArray(corps.commits) || !corps.commits.length) throw invalide("commits : liste non vide attendue");
		if (corps.commits.length > MAX_COMMITS) throw invalide(`commits : ${MAX_COMMITS} au plus`);
		const recus: CommitLie[] = corps.commits.map((c: unknown, i: number) => forme(() => validerCommit(c, i)));
		const r = droitCommits(ctx.a, d.donnees); if (r) throw refuse(r);
		if (v !== d.version) throw conflitTicket(id, d);
		const liste: CommitLie[] = [...d.donnees.commits];
		let ajoutes = 0;
		for (const c of recus) if (!liste.some(x => memeCommit(x, c))) { liste.push(c); ajoutes++; }
		if (!ajoutes) return { version: d.version, rev: ctx.depot.rev, ajoutes: 0, inchange: true };
		if (liste.length > MAX_COMMITS) throw invalide(`commits : ${MAX_COMMITS} au plus par ticket`);
		const n: Ticket = { ...d.donnees, commits: liste, modifie: maintenant() };
		const rev = await ecrire(ctx, id, { version: d.version + 1, donnees: n }, sujet(id, `commits (+${ajoutes})`, n));
		return { version: d.version + 1, rev, ajoutes };
	});
}

// Réponse par défaut de la fermeture : « Réglé par T-12 (commits 411d036, 9fe02ab). »
export function reponseParDefaut(t: Ticket): string {
	if (!t.commits.length) return `Réglé par ${t.id}.`;
	const h = t.commits.slice(0, 10).map(c => c.hash.slice(0, 7));
	return `Réglé par ${t.id} (commit${h.length > 1 ? "s" : ""} ${h.join(", ")}${t.commits.length > 10 ? ", …" : ""}).`;
}

// Fermer : { version, retours: [{ id, version }], reponse? }. Ticket et retours (status fait, reply, replied, updated)
// en un seul commit ; toutes les versions vérifiées avant d'écrire quoi que ce soit.
export function fermerTicket(ctx: ContexteTickets, id: string, corps: unknown): Promise<{ version: number; rev: string; retours: { id: string; version: number }[] }> {
	return ctx.depot.file.executer(async () => {
		const d = trouver(ctx.depot, id);
		if (!estObjet(corps)) throw invalide("objet { version, retours, reponse? } attendu");
		for (const k of Object.keys(corps)) if (!["version", "retours", "reponse"].includes(k)) throw invalide(`clé inconnue : ${k}`);
		const v = validerVersion(corps.version);
		const liste = corps.retours === undefined ? [] : corps.retours;
		if (!Array.isArray(liste)) throw invalide("retours : liste [{ id, version }] attendue");
		if (corps.reponse !== undefined && (typeof corps.reponse !== "string" || corps.reponse.length > MAX_LONG)) throw invalide(`reponse : texte de ${MAX_LONG} caractères au plus`);
		const issue = transition(ctx.a, d.donnees, "fermer");
		if (!issue.ok && issue.statut === 403) throw refuse(issue.raison);
		if (v !== d.version) throw conflitTicket(id, d);
		if (!issue.ok) throw erreurIssue(id, d, issue);
		const reponse = typeof corps.reponse === "string" && corps.reponse.trim() ? corps.reponse : reponseParDefaut(d.donnees);
		const t = maintenant(), vus = new Set<string>();
		const retours = liste.map((x: unknown, index: number) => {
			const extra = { index, id: estObjet(x) ? x.id : undefined };
			if (!estObjet(x)) throw invalide("retours : entrée { id, version } attendue", extra);
			for (const k of Object.keys(x)) if (k !== "id" && k !== "version") throw invalide(`retours : clé inconnue ${k}`, extra);
			if (typeof x.id !== "string" || !ID_RETOUR.test(x.id)) throw absent("retour introuvable (id invalide)", extra);
			if (vus.has(x.id)) throw invalide("le même retour deux fois", extra);
			vus.add(x.id);
			if (!d.donnees.retours.includes(x.id)) throw invalide(`le retour ${x.id} n'est pas lié à ${id}`, extra);
			const r = ctx.depot.index.get(x.id);
			if (!r) throw absent("retour introuvable", extra);
			const vr = validerVersion(x.version);
			if (vr !== r.version) throw conflit(x.id, r, extra);
			return { id: x.id, doc: { version: r.version + 1, donnees: { ...r.donnees, status: "fait", reply: reponse, replied: t, updated: t } } };
		});
		const n: Ticket = { ...d.donnees, statut: issue.statut, pris_par: issue.pris_par, modifie: t };
		const rev = await ecrire(ctx, id, { version: d.version + 1, donnees: n }, sujet(id, `fermé (${retours.length} retour${retours.length > 1 ? "s" : ""})`, n), { retours });
		return { version: d.version + 1, rev, retours: retours.map((r: { id: string; doc: Doc }) => ({ id: r.id, version: r.doc.version })) };
	});
}

export function supprimerTicket(ctx: ContexteTickets, id: string, version: unknown): Promise<{ rev: string }> {
	return ctx.depot.file.executer(async () => {
		const d = trouver(ctx.depot, id);
		const v = validerVersion(version);
		const r = droitSupprimerTicket(ctx.a); if (r) throw refuse(r);
		if (v !== d.version) throw conflitTicket(id, d);
		// .dernier ne bouge pas : le numéro reste réservé.
		const rev = await ecrire(ctx, id, null, sujet(id, "suppression", d.donnees));
		ctx.journaliser("ticket supprimé", id, { titre: d.donnees.titre });
		return { rev };
	});
}

// Liste filtrée : statut=a,b ; discipline=x ; pris_par=moi. Les tickets illisibles sont listés sans filtre seulement.
export function listerTickets(depot: Depot, a: Acteur, params: URLSearchParams) {
	const st = params.get("statut"), disc = params.get("discipline"), pp = params.get("pris_par");
	const statuts = st ? st.split(",").map(s => s.trim()).filter(Boolean) : null;
	for (const s of statuts || []) if (!(STATUTS_TICKET as readonly string[]).includes(s)) throw invalide(`statut inconnu : ${s}`);
	if (pp !== null && pp !== "moi") throw invalide("pris_par : seulement « moi »");
	const filtre = (d: DocTicket) => (!statuts || statuts.includes(d.donnees.statut)) && (disc === null || d.donnees.discipline === disc) && (pp === null || meme(d.donnees.pris_par, a));
	return depot.instantaneTickets(filtre, !statuts && disc === null && pp === null);
}

// Historique d'un ticket : les commits Git de son fichier (git log --follow), du plus récent au plus ancien.
export async function historiqueTicket(depot: Depot, id: string): Promise<{ id: string; historique: { hash: string; auteur: string; date: string; sujet: string }[] }> {
	if (!ID_TICKET.test(id) || !depot.tickets.has(id)) throw absent("ticket introuvable");
	const sortie = await depot.git(["log", "--follow", "-n", "200", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", `tickets/${id}.md`]).catch(indisponible);
	const historique = sortie.split("\n").filter(Boolean).map(l => { const [hash, auteur, date, s] = l.split("\x1f"); return { hash, auteur, date, sujet: s }; });
	return { id, historique };
}
