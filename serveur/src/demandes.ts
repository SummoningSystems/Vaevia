// « Traiter les retours » depuis l'interface (étape 3.5, docs/etape3-5-prise-en-main.md § 5.2) : un membre crée une
// demande, un agent en veille sur le poste du code (outil veille) la prend, lance l'agent configuré, envoie des
// battements, puis la termine. Tables « demandes » et « veilles » de outil.sqlite, hors de Git (états d'exploitation) ;
// ce que le traitement produit (réponses, builds) passe par les routes habituelles, donc par Git.
//   GET  /api/p/<p>/demandes                         membre (session ou Bearer)   → { veilleurs, active, recentes }
//   POST /api/p/<p>/demandes {}                      session, rôle permis par traitement → 201 demande (409 si une active)
//   POST /api/p/<p>/demandes/<id>/annuler            session : demandeur, mainteneur, admin
//   POST /api/p/<p>/veille {poste}                   Bearer agent                → { demande } (en attente, ou null)
//   POST /api/p/<p>/demandes/<id>/prendre            Bearer agent                → attente → en-cours (409 sinon)
//   POST /api/p/<p>/demandes/<id>/battement {journal?} Bearer, le preneur         → { annuler }
//   POST /api/p/<p>/demandes/<id>/terminer {etat, resume?, code_sortie?, raison?} Bearer, le preneur
// États : attente ──prendre──► en-cours ──► terminee | echouee | annulee ; attente ──annuler / 24 h──► annulee.
// Une demande active (attente ou en-cours) au plus par projet, garantie par un index unique partiel. Vérification
// paresseuse, au début de chaque route : en-cours sans battement depuis 120 s → echouee « veilleur perdu » ; attente
// depuis plus de 24 h → annulee. Chaque changement d'état est diffusé (événement SSE « demandes » {id, etat}, hôte
// principal seulement) et la création, la prise et la fin vont au journal d'audit.
// Aucun texte libre du demandeur : le corps de la création est vide. journal, resume, raison et code_sortie (écrits par
// le poste du code) ne sont donnés qu'au demandeur, aux mainteneurs et aux admins ; ce sont des textes non sûrs, que
// l'interface affiche en texte brut. Tout « wdd_… » y est masqué par le serveur aussi.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Contexte } from "./http.ts";
import type { Depot } from "./depot.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, absent, refuse } from "./retours.ts";
import { idAleatoire } from "./base.ts";
import { validerNom } from "./auth.ts";
import { ligne } from "./depot.ts";
import { json, lireJson } from "./http.ts";
import { corpsVide, journaliser } from "./gestion.ts";
import { lireReglages } from "./reglages.ts";
import type { Traitement } from "./reglages.ts";

export const BATTEMENT_PERDU_MS = 120 * 1000;      // en-cours sans battement depuis 120 s : veilleur perdu
export const ATTENTE_MAX_MS = 24 * 3600 * 1000;     // attente de plus de 24 h : annulée
export const VEILLEUR_VU_MS = 30 * 1000;            // veilleurs listés : vus depuis moins de 30 s
export const MAX_RECENTES = 10;
export const MAX_JOURNAL = 2000, MAX_RESUME = 4000, MAX_RAISON = 200;
const MAX_CORPS_DEMANDE = 64 * 1024;
const ACTIFS = "('attente', 'en-cours')";
export const ETATS_FIN = ["terminee", "echouee", "annulee"] as const;
const ID_DEMANDE = /^[A-Za-z0-9]{1,40}$/;

type Ligne = { id: string; projet: string; etat: string; demandeur: string; cree: string; pris: string | null; preneur: string | null; poste: string;
	battement: string | null; fini: string | null; annulation_demandee: number; journal: string; resume: string; code_sortie: number | null; raison: string; profil: string };
const COLONNES = "id, projet, etat, demandeur, cree, pris, preneur, poste, battement, fini, annulation_demandee, journal, resume, code_sortie, raison, profil";
// Étape 3.9, G5 : nom d'un profil de traitement (une commande mémorisée par le développeur sur son poste). Un nom, jamais
// un texte libre : seul ce nom va du demandeur à la veille, qui le traduit en sa commande.
export const PROFIL = /^[a-z0-9-]{1,30}$/;
export const MAX_PROFILS = 10;

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Un jeton recopié dans la sortie d'un agent n'est jamais gardé (le veilleur masque aussi, avant l'envoi).
export const masquer = (s: string): string => s.replace(/wdd_[A-Za-z0-9_-]+/g, "wdd_…");
const iso = (ms: number) => new Date(ms).toISOString();

// Qui peut lancer un traitement selon le réglage du projet (§ 5.1) : un admin toujours, sauf « personne ».
export function peutLancer(role: string, traitement: Traitement): boolean {
	if (traitement === "personne") return false;
	if (role === "admin" || role === "mainteneur") return true;
	return traitement === "contributeur" && role === "contributeur";
}

// Création d'une demande « Traiter les retours » (étape 3.5 ; étape 3.9 : profil G5, et l'envoi d'une série G3).
// Lève 403 (réglage), 409 (déjà une demande active), 400 (profil invalide ou annoncé par aucun veilleur connecté).
export function creerDemande(ctx: Contexte, projet: string, depot: Depot, a: Acteur, profil: unknown, origine = "") {
	const db = ctx.base.db;
	const traitement = lireReglages(depot).traitement;
	if (!peutLancer(a.role, traitement))
		throw refuse(traitement === "personne" ? "traitement désactivé pour ce projet (réglage « personne »)" : `réservé aux ${traitement === "contributeur" ? "contributeurs, mainteneurs" : "mainteneurs"} et aux admins (réglage du projet)`);
	if (typeof profil !== "string" || (profil !== "" && !PROFIL.test(profil))) throw invalide("profil : nom [a-z0-9-]{1,30}, ou vide (commande par défaut du poste)");
	entretenir(ctx, projet);
	const vs = veilleurs(ctx, projet);
	if (profil && !vs.some(v => v.profils.includes(profil))) throw invalide(`profil « ${profil} » : aucun veilleur connecté ne le propose`);
	const conflit = () => { const x = active(ctx, projet); return new ErreurApi(409, "conflict", "une demande est déjà active pour ce projet", { demande: x ? exposer(ctx, x, complet(a, x)) : null }); };
	if (active(ctx, projet)) throw conflit();
	const id = idAleatoire(16);
	try { db.prepare("INSERT INTO demandes (id, projet, etat, demandeur, cree, profil) VALUES (?, ?, 'attente', ?, ?, ?)").run(id, projet, a.id, iso(Date.now()), profil); }
	catch (e) { if (active(ctx, projet)) throw conflit(); throw e; } // création simultanée : l'index unique tranche
	const l = ligneDe(ctx, projet, id)!;
	const sans = vs.length === 0;
	ctx.journal(`demande ${id} du projet ${projet} créée par ${a.id}${origine ? ` (${origine})` : ""}${sans ? " (aucun veilleur)" : ""}`);
	journaliser(ctx, a, "demande créée", projet, id, { sans_veilleur: sans, ...(profil ? { profil } : {}), ...(origine ? { origine } : {}) });
	signaler(ctx, projet, id, "attente");
	return { ...exposer(ctx, l, true), sans_veilleur: sans };
}

// Forme rendue d'une demande. « complet » : journal, resume, raison, code_sortie en plus (demandeur, mainteneur, admin).
function exposer(ctx: Contexte, l: Ligne, complet: boolean) {
	const j = l.preneur ? ctx.base.jetonParId(l.preneur) : undefined;
	return {
		id: l.id, etat: l.etat, cree: l.cree, pris: l.pris, battement: l.battement, fini: l.fini,
		demandeur: { id: l.demandeur, nom: ctx.base.nomDe(l.demandeur) },
		preneur: l.preneur ? { id: l.preneur, nom: j?.nom ?? "", pour: j?.pour ? { id: j.pour, nom: ctx.base.nomDe(j.pour) } : null } : null,
		poste: l.poste, annulation_demandee: l.annulation_demandee === 1, profil: l.profil || "",
		...(complet ? { code_sortie: l.code_sortie, raison: l.raison, journal: l.journal, resume: l.resume } : {}),
	};
}
const complet = (a: Acteur, l: Ligne) => a.role === "mainteneur" || a.role === "admin" || (!a.agent && a.id === l.demandeur);

function ligneDe(ctx: Contexte, projet: string, id: string): Ligne | undefined {
	return ID_DEMANDE.test(id) ? ctx.base.db.prepare(`SELECT ${COLONNES} FROM demandes WHERE id = ? AND projet = ?`).get(id, projet) as Ligne | undefined : undefined;
}
const active = (ctx: Contexte, projet: string) => ctx.base.db.prepare(`SELECT ${COLONNES} FROM demandes WHERE projet = ? AND etat IN ${ACTIFS} LIMIT 1`).get(projet) as Ligne | undefined;

// Changement d'état : diffusé sur le flux de l'hôte principal, et au journal d'audit si c'est une fin.
function signaler(ctx: Contexte, projet: string, id: string, etat: string): void {
	ctx.flux.diffuserDemandes(projet, { id, etat });
}
function journalFin(ctx: Contexte, qui: { id: string; pour?: string }, projet: string, id: string, detail: Record<string, unknown>): void {
	ctx.base.journaliser({ qui: qui.id, pour: qui.pour || "", action: "demande finie", projet, cible: id, detail });
}

// Vérification paresseuse (à chaque lecture ou écriture des demandes du projet) : veilleur perdu, attente trop longue.
export function entretenir(ctx: Contexte, projet: string): void {
	const db = ctx.base.db, now = Date.now();
	const fins: [string, string, string, string][] = []; // id, état, raison, condition
	for (const { id } of db.prepare("SELECT id FROM demandes WHERE projet = ? AND etat = 'en-cours' AND COALESCE(battement, pris, cree) < ?").all(projet, iso(now - BATTEMENT_PERDU_MS)) as { id: string }[])
		fins.push([id, "echouee", "veilleur perdu", "en-cours"]);
	for (const { id } of db.prepare("SELECT id FROM demandes WHERE projet = ? AND etat = 'attente' AND cree < ?").all(projet, iso(now - ATTENTE_MAX_MS)) as { id: string }[])
		fins.push([id, "annulee", "attente de plus de 24 h", "attente"]);
	for (const [id, etat, raison, avant] of fins) {
		if (Number(db.prepare("UPDATE demandes SET etat = ?, raison = ?, fini = ? WHERE id = ? AND etat = ?").run(etat, raison, iso(now), id, avant).changes) !== 1) continue;
		ctx.journal(`demande ${id} du projet ${projet} : ${etat} (${raison})`);
		journalFin(ctx, { id: "serveur" }, projet, id, { etat, raison });
		signaler(ctx, projet, id, etat);
	}
	// Veilleurs vus il y a plus d'un jour : oubliés (la table ne grossit pas).
	db.prepare("DELETE FROM veilles WHERE projet = ? AND vu < ?").run(projet, iso(now - 24 * 3600 * 1000));
}

// Veilleurs vus depuis moins de 30 s, dont le jeton vaut encore (révoqué, expiré, propriétaire sans droit : absent).
export function veilleurs(ctx: Contexte, projet: string) {
	const l = ctx.base.db.prepare("SELECT jeton, poste, vu, profils FROM veilles WHERE projet = ? AND vu > ? ORDER BY vu DESC").all(projet, iso(Date.now() - VEILLEUR_VU_MS)) as { jeton: string; poste: string; vu: string; profils: string }[];
	const r: { nom: string; pour: { id: string; nom: string } | null; poste: string; vu: string; profils: string[] }[] = [];
	for (const v of l) {
		const j = ctx.base.jetonActif(v.jeton);
		if (j && j.projet === projet && j.role === "agent") r.push({ nom: j.nom, pour: j.pour, poste: v.poste, vu: v.vu, profils: String(v.profils || "").split(",").filter(x => PROFIL.test(x)) });
	}
	return r;
}

// Demande active du projet, pour l'accueil (GET /api/moi) : { id, etat } ou null.
export function demandeActive(ctx: Contexte, projet: string): { id: string; etat: string } | null {
	entretenir(ctx, projet);
	const l = active(ctx, projet);
	return l ? { id: l.id, etat: l.etat } : null;
}

// Routes ; rend vrai si la route a été traitée. seg : les segments après /api/p/<projet>/.
export async function routeDemandes(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, depot: Depot, a: Acteur, seg: string[], m: string): Promise<boolean> {
	const [r0, r1, r2] = seg;
	if (r0 !== "demandes" && r0 !== "veille") return false;
	const db = ctx.base.db;
	const session = () => { if (a.agent) throw refuse("réservé aux sessions de la méta-interface"); };
	const agent = () => { if (!a.agent || a.role !== "agent") throw refuse("réservé à un jeton d'agent (rôle agent) : outil veille"); };
	const corpsObjet = async (cles: string[]): Promise<Record<string, unknown>> => {
		const c = await lireJson(req, MAX_CORPS_DEMANDE);
		if (c === undefined) return {};
		if (!estObjet(c)) throw invalide("objet JSON attendu");
		for (const k of Object.keys(c)) if (!cles.includes(k)) throw invalide(`clé inconnue : ${k}`);
		return c;
	};

	if (r0 === "demandes" && seg.length === 1 && m === "GET") {
		entretenir(ctx, projet);
		const act = active(ctx, projet);
		const recentes = db.prepare(`SELECT ${COLONNES} FROM demandes WHERE projet = ? AND etat NOT IN ${ACTIFS} ORDER BY cree DESC, rowid DESC LIMIT ${MAX_RECENTES}`).all(projet) as Ligne[];
		json(res, 200, { veilleurs: veilleurs(ctx, projet), active: act ? exposer(ctx, act, complet(a, act)) : null, recentes: recentes.map(l => exposer(ctx, l, complet(a, l))) });
		return true;
	}
	if (r0 === "demandes" && seg.length === 1 && m === "POST") {
		session();
		// Aucun texte libre : rien de ce que tape le demandeur n'arrive à l'agent. Seul un nom de profil (étape 3.9, G5),
		// parmi ceux qu'annoncent les veilleurs connectés.
		const cp = await corpsObjet(["profil"]);
		json(res, 201, creerDemande(ctx, projet, depot, a, cp.profil === undefined ? "" : cp.profil));
		return true;
	}
	if (r0 === "veille" && seg.length === 1 && m === "POST") {
		agent();
		const c = await corpsObjet(["poste", "profils"]);
		const poste = validerNom(c.poste);
		// Étape 3.9, G5 : profils mémorisés sur ce poste (noms seulement), annoncés à chaque interrogation.
		const profils = c.profils === undefined ? [] : c.profils;
		if (!Array.isArray(profils) || profils.length > MAX_PROFILS || !profils.every(x => typeof x === "string" && PROFIL.test(x)) || new Set(profils).size !== profils.length)
			throw invalide(`profils : ${MAX_PROFILS} noms distincts au plus, [a-z0-9-]{1,30}`);
		db.prepare("INSERT INTO veilles (jeton, projet, poste, vu, profils) VALUES (?, ?, ?, ?, ?) ON CONFLICT (jeton) DO UPDATE SET projet = excluded.projet, poste = excluded.poste, vu = excluded.vu, profils = excluded.profils")
			.run(a.jeton!, projet, poste, iso(Date.now()), profils.join(","));
		entretenir(ctx, projet);
		const l = db.prepare(`SELECT ${COLONNES} FROM demandes WHERE projet = ? AND etat = 'attente' LIMIT 1`).get(projet) as Ligne | undefined;
		// Étape 3.9, G4 : plafond de la vague (réglage du projet), transmis à l'agent par la veille.
		json(res, 200, { demande: l ? { ...exposer(ctx, l, false), plafond: lireReglages(depot).plafond_vague } : null });
		return true;
	}
	if (r0 !== "demandes" || seg.length !== 3 || m !== "POST" || !["annuler", "prendre", "battement", "terminer"].includes(r2)) return false;

	if (r2 === "annuler") session(); else agent();
	// Corps lu avant tout (y compris pour un id inconnu), avec ses clés permises.
	const c = r2 === "battement" ? await corpsObjet(["journal"]) : r2 === "terminer" ? await corpsObjet(["etat", "resume", "code_sortie", "raison"]) : (await corpsVide(req), {});
	entretenir(ctx, projet);
	let l = ligneDe(ctx, projet, r1);
	if (!l) throw absent("demande introuvable");
	const now = iso(Date.now());
	const conflit = (m: string) => new ErreurApi(409, "conflict", m, { demande: exposer(ctx, ligneDe(ctx, projet, r1)!, complet(a, l!)) });

	if (r2 === "annuler") {
		if (a.role !== "mainteneur" && a.role !== "admin" && a.id !== l.demandeur) throw refuse("seuls le demandeur, un mainteneur ou un admin annulent une demande");
		if (l.etat === "attente") {
			if (Number(db.prepare("UPDATE demandes SET etat = 'annulee', fini = ?, raison = ? WHERE id = ? AND etat = 'attente'").run(now, `annulée par ${ligne(a.nom, 60)}`, l.id).changes) !== 1) throw conflit("la demande a changé entre-temps");
			ctx.journal(`demande ${l.id} du projet ${projet} annulée par ${a.id}`);
			journaliser(ctx, a, "demande finie", projet, l.id, { etat: "annulee", par: "annulation" });
			signaler(ctx, projet, l.id, "annulee");
		} else if (l.etat === "en-cours") {
			if (l.annulation_demandee) { json(res, 200, { demande: exposer(ctx, l, complet(a, l)), inchange: true }); return true; }
			db.prepare("UPDATE demandes SET annulation_demandee = 1 WHERE id = ? AND etat = 'en-cours'").run(l.id);
			ctx.journal(`demande ${l.id} du projet ${projet} : annulation demandée par ${a.id}`);
			journaliser(ctx, a, "annulation demandée", projet, l.id);
			signaler(ctx, projet, l.id, "en-cours");
		} else throw conflit(`demande déjà finie (${l.etat})`);
		l = ligneDe(ctx, projet, l.id)!;
		json(res, 200, { demande: exposer(ctx, l, complet(a, l)) });
		return true;
	}
	if (r2 === "prendre") {
		const poste = (db.prepare("SELECT poste FROM veilles WHERE jeton = ?").get(a.jeton!) as { poste: string } | undefined)?.poste ?? "";
		if (Number(db.prepare("UPDATE demandes SET etat = 'en-cours', preneur = ?, pris = ?, battement = ?, poste = ? WHERE id = ? AND etat = 'attente'").run(a.jeton!, now, now, poste, l.id).changes) !== 1)
			throw conflit(l.etat === "en-cours" ? "demande déjà prise par un autre veilleur" : `demande ${l.etat === "attente" ? "changée entre-temps" : "déjà finie (" + l.etat + ")"}`);
		ctx.journal(`demande ${l.id} du projet ${projet} prise par ${a.id}`);
		journaliser(ctx, a, "demande prise", projet, l.id, { poste });
		signaler(ctx, projet, l.id, "en-cours");
		l = ligneDe(ctx, projet, l.id)!;
		json(res, 200, { demande: exposer(ctx, l, complet(a, l)) });
		return true;
	}
	// battement, terminer : le preneur seulement, sur une demande en cours.
	if (l.preneur !== a.jeton) throw refuse("seul le veilleur qui a pris la demande la fait avancer");
	if (l.etat !== "en-cours") throw conflit(`demande ${l.etat === "attente" ? "pas encore prise" : "déjà finie (" + l.etat + (l.raison ? ", " + l.raison : "") + ")"}`);
	if (r2 === "battement") {
		if (c.journal !== undefined && (typeof c.journal !== "string" || c.journal.length > MAX_JOURNAL)) throw invalide(`journal : texte de ${MAX_JOURNAL} caractères au plus`);
		if (typeof c.journal === "string") db.prepare("UPDATE demandes SET battement = ?, journal = ? WHERE id = ?").run(now, masquer(c.journal), l.id);
		else db.prepare("UPDATE demandes SET battement = ? WHERE id = ?").run(now, l.id);
		db.prepare("UPDATE veilles SET vu = ? WHERE jeton = ?").run(now, a.jeton!);
		json(res, 200, { annuler: l.annulation_demandee === 1 });
		return true;
	}
	// terminer
	if (typeof c.etat !== "string" || !(ETATS_FIN as readonly string[]).includes(c.etat)) throw invalide(`etat : ${ETATS_FIN.join(", ")}`);
	if (c.resume !== undefined && (typeof c.resume !== "string" || c.resume.length > MAX_RESUME)) throw invalide(`resume : texte de ${MAX_RESUME} caractères au plus`);
	// Tout entier sûr : sous Windows, Node rend les codes sans signe (3221225786 pour Ctrl+C, 3221225477 pour un plantage).
	if (c.code_sortie !== undefined && c.code_sortie !== null && !Number.isSafeInteger(c.code_sortie)) throw invalide("code_sortie : entier ou null");
	if (c.raison !== undefined && (typeof c.raison !== "string" || c.raison.length > MAX_RAISON || /[\u0000-\u001f\u007f]/.test(c.raison))) throw invalide(`raison : une ligne de ${MAX_RAISON} caractères au plus`);
	const etat = c.etat, resume = masquer(typeof c.resume === "string" ? c.resume : ""), raison = masquer(typeof c.raison === "string" ? c.raison : "");
	const code = typeof c.code_sortie === "number" ? c.code_sortie : null;
	if (Number(db.prepare("UPDATE demandes SET etat = ?, fini = ?, resume = ?, code_sortie = ?, raison = ? WHERE id = ? AND etat = 'en-cours'").run(etat, now, resume, code, raison, l.id).changes) !== 1)
		throw conflit("la demande a changé entre-temps");
	ctx.journal(`demande ${l.id} du projet ${projet} : ${etat} (code ${code ?? "—"})`);
	journalFin(ctx, { id: a.id, pour: a.pour?.id }, projet, l.id, { etat, code_sortie: code, ...(raison ? { raison } : {}) });
	signaler(ctx, projet, l.id, etat);
	l = ligneDe(ctx, projet, l.id)!;
	json(res, 200, { demande: exposer(ctx, l, complet(a, l)) });
	return true;
}
