// Gestion d'un projet (docs/etape3-meta-interface.md § 3.2) : membres, invitations, jetons, réglages ; plus GET /api/moi
// (accueil de la méta-interface) et l'écriture du journal d'audit (§ 3.4).
// Les routes de § 3.2 répondent aux SESSIONS seulement (mainteneur du projet ou admin) : un jeton Bearer, même
// mainteneur, reçoit 403 ; sinon il pourrait s'ouvrir une session humaine (invitation) et contourner « fermer reste un
// geste humain ». Exception : GET …/reglages est lisible par tout membre du projet (voir écarts).
// Garde-fous : on ne retire ni ne rétrograde le dernier mainteneur (sauf admin) ; un mainteneur ne change pas son
// propre rôle. Le journal ne reçoit jamais de secret (ni jeton, ni lien d'invitation).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Contexte } from "./http.ts";
import type { Depot } from "./depot.ts";
import { estIllisible } from "./depot.ts";
import type { Identite } from "./auth.ts";
import { identifier, validerNom } from "./auth.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, absent, refuse } from "./retours.ts";
import { ROLES_PROJET, ROLES_JETON, ROLE_RECONNEXION, MAX_JOURS_TESTEUR } from "./base.ts";
import type { RoleJeton, Compte } from "./base.ts";
import { json, lireJson } from "./http.ts";
import { lireReglages, ecrireReglages } from "./reglages.ts";
import { demandeActive } from "./demandes.ts";
import { validationsDuDernierBuild, ongletsDuDernierBuild } from "./builds.ts";

// Boîte « À moi » (étape 3.7, E1) : ce qui attend une réponse de ce compte, calculé à chaque lecture (aucune donnée
// nouvelle) : les questions de l'agent sur ses retours, les points « À valider » du dernier build sans aucune réponse
// (contributeurs et plus : un lecteur ne répond pas), et pour un mainteneur ou un admin les tickets en revue à fermer.
// 20 lignes au plus par liste ; les nombres disent le total.
const MAX_A_MOI = 20;
type Ligne = Record<string, string>;
function aMoi(ctx: Contexte, c: Compte, projet: string, role: string | null): { questions: Ligne[]; a_valider: Ligne[]; en_revue: Ligne[]; pour_moi: Ligne[]; mentions: Ligne[]; total: { questions: number; a_valider: number; en_revue: number; pour_moi: number; mentions: number } } {
	const d = ctx.depots.get(projet);
	const vide = { questions: [], a_valider: [], en_revue: [], pour_moi: [], mentions: [], total: { questions: 0, a_valider: 0, en_revue: 0, pour_moi: 0, mentions: 0 } };
	if (!d) return vide;
	const court = (s: unknown, n = 160) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
	const questions: Ligne[] = [];
	for (const [id, x] of d.index) {
		const r = x.donnees;
		if (r.status === "question" && r.by === c.id) questions.push({ id, kind: String(r.kind ?? ""), ref: String(r.ref ?? ""), nom: court(r.name || r.ref, 80), ancre: String(r.anchor || r.tab || ""), question: court(r.reply), quand: String(r.replied || r.updated || "") });
	}
	questions.sort((a, b) => b.quand.localeCompare(a.quand));
	// Étape 3.9, E3 : retours ouverts qui me sont confiés (« pour »), et ceux d'un autre qui me mentionnent (« @id »,
	// « @Prénom » ou « @NomSansEspace », sans tenir compte des accents ni de la casse). Une mention reste du texte.
	const sansAccent = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const jetonsMention = new Set([c.id, c.nom.split(/\s+/)[0] || "", c.nom.replace(/\s+/g, "")].filter(x => x.length >= 2).map(x => "@" + sansAccent(x)));
	const mentionne = (t: string) => { const s = sansAccent(t); return [...jetonsMention].some(m => { const i = s.indexOf(m); return i >= 0 && !/[\p{L}\p{N}_-]/u.test(s[i + m.length] || ""); }); };
	const ouvert = (s: unknown) => s === "nouveau" || s === "pris" || s === "question";
	const pour_moi: Ligne[] = [], mentions: Ligne[] = [];
	for (const [id, x] of d.index) {
		const r = x.donnees;
		if (!ouvert(r.status) || r.fusionne_dans) continue;
		const l = { id, kind: String(r.kind ?? ""), ref: String(r.ref ?? ""), nom: court(r.name || r.ref, 80), ancre: String(r.anchor || r.tab || ""), texte: court(r.text), quand: String(r.updated || r.created || "") };
		if (r.pour === c.id) pour_moi.push(l);
		else if (r.by !== c.id && mentionne(String(r.text ?? ""))) mentions.push(l);
	}
	pour_moi.sort((a, b) => b.quand.localeCompare(a.quand)); mentions.sort((a, b) => b.quand.localeCompare(a.quand));
	// Étape 3.9, E2 : un testeur ne voit rien des autres (ni mentions, ni retours confiés, ni points à valider).
	if (role === "testeur") { pour_moi.length = 0; mentions.length = 0; }
	let a_valider: Ligne[] = [];
	if (role && role !== "lecteur" && role !== "testeur") {
		const repondus = new Set([...d.index.values()].filter(x => x.donnees.kind === "validation").map(x => String(x.donnees.ref)));
		a_valider = validationsDuDernierBuild(ctx.racineProjets, projet).filter(v => !repondus.has(v.id)).map(v => ({ id: v.id, texte: court(v.texte), jalon: v.jalon }));
	}
	const en_revue: Ligne[] = role === "mainteneur" || role === "admin"
		? [...d.tickets.values()].filter(t => !estIllisible(t) && (t as { donnees: { statut: string } }).donnees.statut === "en-revue").map(t => { const x = (t as { donnees: { id: string; titre: string } }).donnees; return { id: x.id, titre: court(x.titre, 120) }; })
		: [];
	return { questions: questions.slice(0, MAX_A_MOI), a_valider: a_valider.slice(0, MAX_A_MOI), en_revue: en_revue.slice(0, MAX_A_MOI), pour_moi: pour_moi.slice(0, MAX_A_MOI), mentions: mentions.slice(0, MAX_A_MOI), total: { questions: questions.length, a_valider: a_valider.length, en_revue: en_revue.length, pour_moi: pour_moi.length, mentions: mentions.length } };
}

const SEMAINE_MS = 7 * 24 * 3600 * 1000;

// Étape 3.9, E2 : onglets d'un testeur (ids d'onglets du dernier build, au moins un) et durée de son accès (jours,
// 1 à MAX_JOURS_TESTEUR, 14 par défaut), comptée à partir de l'acceptation de l'invitation.
function validerTesteur(ctx: Contexte, projet: string, c: Record<string, unknown>): { onglets: string[]; jours: number } {
	const connus = new Set(ongletsDuDernierBuild(ctx.racineProjets, projet).map(o => o.id));
	if (!Array.isArray(c.onglets) || !c.onglets.length || c.onglets.length > 50 || !c.onglets.every(o => typeof o === "string"))
		throw invalide("onglets : liste des onglets du Wiki que le testeur verra (au moins un)");
	const inconnus = (c.onglets as string[]).filter(o => !connus.has(o));
	if (inconnus.length) throw invalide(`onglets inconnus dans le dernier build du Wiki : ${inconnus.join(", ")}`);
	const jours = c.jours === undefined ? 14 : c.jours;
	if (typeof jours !== "number" || !Number.isInteger(jours) || jours < 1 || jours > MAX_JOURS_TESTEUR) throw invalide(`jours : durée de l'accès, de 1 à ${MAX_JOURS_TESTEUR}`);
	return { onglets: [...new Set(c.onglets as string[])], jours };
}
function testeurInvitation(ctx: Contexte, id: string): { onglets?: string[]; jours?: number } {
	const r = ctx.base.db.prepare("SELECT onglets, jours FROM invitations WHERE id = ? AND role = 'testeur'").get(id) as { onglets: string | null; jours: number | null } | undefined;
	if (!r) return {};
	let onglets: string[] = [];
	try { onglets = JSON.parse(r.onglets || "[]"); } catch { onglets = []; }
	return { onglets, jours: Number(r.jours) || 0 };
}
export const MAX_EXPIRATION_MS = 30 * 24 * 3600 * 1000;
const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Expiration d'une invitation : date ISO future, 30 jours au plus (un lien oublié ne vit pas des années), 7 jours par
// défaut.
export function validerExpiration(v: unknown): string {
	if (v === undefined) return new Date(Date.now() + SEMAINE_MS).toISOString();
	const t = typeof v === "string" ? Date.parse(v) : NaN;
	if (Number.isNaN(t) || t <= Date.now() || t > Date.now() + MAX_EXPIRATION_MS) throw invalide("expire : date ISO future, dans 30 jours au plus");
	return new Date(t).toISOString();
}

// Corps vide ou {} (routes sans paramètre, comme les liens de reconnexion).
export async function corpsVide(req: IncomingMessage): Promise<void> {
	const c = await lireJson(req);
	if (c !== undefined && (!estObjet(c) || Object.keys(c).length)) throw invalide("corps : vide ou {} attendu");
}
// Réponse d'une création de lien de reconnexion (étape 3.5, § 2.4) : comme une invitation, plus le compte visé.
export function reponseReconnexion(ctx: Contexte, req: IncomingMessage, r: { id: string; jeton: string; expire: string }, compte: Compte, projet: string | null) {
	const lien = `/invitation/${r.jeton}`;
	return { id: r.id, lien, url: ctx.urlPublique(req) + lien, compte: { id: compte.id, nom: compte.nom }, projet, role: ROLE_RECONNEXION, expire: r.expire };
}

// Une ligne du journal au nom d'un acteur (compte, ou agent:<jeton> avec son propriétaire).
export function journaliser(ctx: Contexte, a: Acteur, action: string, projet: string, cible: string, detail?: unknown): void {
	ctx.base.journaliser({ qui: a.id, pour: a.pour?.id || "", action, projet, cible, detail });
}

// GET /api/moi : qui suis-je, mes projets (rôle, retours nouveaux, tickets à faire), isolement des pages.
export function apiMoi(ctx: Contexte, req: IncomingMessage) {
	const id = identifier(req, ctx.base);
	if (id.type === "agent") throw refuse("réservé aux sessions (méta-interface)");
	if (id.type === "aucun") throw new ErreurApi(401, "revoked", id.cookie ? "session expirée : demande un lien de reconnexion à un mainteneur du projet" : "session requise (lien d'invitation ou de reconnexion)");
	const c = id.compte;
	const projets = ctx.base.projetsDe(c).filter(p => ctx.base.roleSur(c, p.id)).map(p => {
		const d = ctx.depots.get(p.id);
		// Étape 3.9, E2 : un testeur ne voit que ses propres retours, aucun ticket ni demande, et ses onglets et sa fin.
		if (ctx.base.roleSur(c, p.id) === "testeur") {
			const siens = d ? [...d.index.values()].filter(x => x.donnees.by === c.id) : [];
			const t = ctx.base.restriction(c.id, p.id);
			return { id: p.id, titre: p.titre, role: "testeur", retours_nouveaux: siens.filter(x => x.donnees.status === "nouveau").length,
				retours_questions: siens.filter(x => x.donnees.status === "question").length, retours: siens.length, tickets_a_faire: 0, tickets: 0,
				page: `/p/${p.id}/`, demande: null, a_moi: aMoi(ctx, c, p.id, "testeur"), testeur: t };
		}
		const tickets = d ? [...d.tickets.values()].filter(t => !estIllisible(t)) as { donnees: { statut: string } }[] : [];
		return {
			id: p.id, titre: p.titre, role: ctx.base.roleSur(c, p.id),
			retours_nouveaux: d ? [...d.index.values()].filter(x => x.donnees.status === "nouveau").length : 0,
			// Étape 3.6 (lot B) : questions de l'agent en attente d'une réponse (l'Accueil les affiche à côté des retours en attente).
			retours_questions: d ? [...d.index.values()].filter(x => x.donnees.status === "question").length : 0,
			retours: d ? d.index.size : 0,
			tickets_a_faire: tickets.filter(t => t.donnees.statut === "a-faire").length,
			tickets: tickets.length,
			page: `/p/${p.id}/`,
			// Étape 3.5 (§ 5.4) : point d'état de l'accueil, la demande de traitement active ({ id, etat }) ou null.
			demande: d ? demandeActive(ctx, p.id) : null,
			a_moi: aMoi(ctx, c, p.id, ctx.base.roleSur(c, p.id)),
		};
	});
	return {
		compte: { id: c.id, nom: c.nom, admin: c.admin },
		projets,
		// Sans WDD_URL_PAGES, les pages de projet (contenu envoyé par les agents) sont servies sur la même origine que
		// l'administration : la méta-interface l'affiche à l'admin (§ 2).
		isolement: { pages_separees: !!ctx.config.urlPages, url_pages: ctx.config.urlPages || null },
		// Étape 3.5 (§ 8.4, D1) : adresse de l'hôte principal, celle que vise la CLI (WDD_URL, sinon déduite de Host,
		// comme les liens d'invitation) ; l'écran du projet la met dans la phrase « Branche ce dépôt sur le serveur… ».
		url: ctx.urlPublique(req),
	};
}

// Routes § 3.2 ; rend vrai si la route a été traitée.
export async function routeGestion(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, depot: Depot, id: Identite, a: Acteur, seg: string[], m: string): Promise<boolean> {
	const [r0, r1] = seg;
	if (!["membres", "invitations", "jetons", "reglages"].includes(r0)) return false;
	// Lecture des réglages : tout membre du projet (le Kanban en a besoin : couloirs, liens des commits).
	if (r0 === "reglages" && seg.length === 1 && m === "GET") { json(res, 200, { ...lireReglages(depot), rev: depot.rev }); return true; }
	if (id.type !== "compte") throw refuse("réservé aux sessions de la méta-interface : un jeton ne gère ni membres, ni invitations, ni jetons, ni réglages");
	if (a.role !== "mainteneur" && a.role !== "admin") throw refuse("réservé aux mainteneurs du projet et aux admins");
	const moi = id.compte;
	const corpsObjet = async (): Promise<Record<string, unknown>> => {
		const c = await lireJson(req);
		if (!estObjet(c)) throw invalide("objet JSON attendu");
		return c;
	};
	const trace = (action: string, cible: string, detail?: unknown) => journaliser(ctx, a, action, projet, cible, detail);
	// Dernier mainteneur actif : on ne le retire ni ne le rétrograde (sauf admin). Pour un mainteneur, ce cas ne se
	// présente que sur lui-même, déjà refusé (« un mainteneur ne change pas son propre rôle ») : la garde double la règle.
	const gardeDernier = (compte: string) => {
		if (a.role === "admin") return;
		if (ctx.base.roleProjet(compte, projet) === "mainteneur" && !ctx.base.compte(compte)?.desactive && ctx.base.mainteneursActifs(projet) <= 1)
			throw invalide("dernier mainteneur du projet : ni retiré ni rétrogradé (nommer d'abord un autre mainteneur)");
	};

	if (r0 === "membres" && seg.length === 1 && m === "GET") {
		json(res, 200, {
			// Étape 3.5 : admin (compte administrateur) : l'interface n'offre pas de lien de reconnexion pour lui (la route
			// le refuse en 403 : il passe par l'administration).
			membres: ctx.base.membres(projet).map(x => ({ ...x, admin: !!ctx.base.compte(x.compte)?.admin })),
			// Étape 3.9, E2 : onglets du dernier build, à cocher pour un testeur.
			onglets_wiki: ongletsDuDernierBuild(ctx.racineProjets, projet),
			// Étape 3.5 : un lien de reconnexion y figure avec role « reconnexion » et le compte visé (compte_cible).
			invitations: ctx.base.invitations(projet, true).map(i => ({ id: i.id, role: i.role, ...testeurInvitation(ctx, i.id), cree: i.cree, expire: i.expire, par: i.par, par_nom: i.par ? ctx.base.nomDe(i.par) : "",
				compte_cible: i.compte_cible, compte_cible_nom: i.compte_cible ? ctx.base.nomDe(i.compte_cible) : "" })),
		});
		return true;
	}
	// Étape 3.5 (§ 2.4) : lien de reconnexion pour un membre du projet qui n'est pas admin (un admin passe par
	// l'administration), et dont le créateur gère tous les projets. Membre inconnu : 404, comme PUT (on ne sonde pas
	// les comptes du serveur).
	if (r0 === "membres" && seg.length === 3 && seg[2] === "reconnexion" && m === "POST") {
		await corpsVide(req);
		const cible = ctx.base.roleProjet(r1, projet) ? ctx.base.compte(r1) : undefined;
		if (!cible) throw absent("ce compte n'est pas membre du projet");
		if (cible.admin) throw refuse("compte administrateur : son lien de reconnexion se crée dans l'administration");
		if (cible.desactive) throw invalide("compte désactivé : un admin doit le réactiver d'abord");
		// Le lien donne la session entière du compte, sur tous ses projets : refusé s'il a un rôle sur un projet que le
		// créateur ne gère pas (revérifié à l'utilisation, Base.refusReconnexion). Les projets ne sont pas nommés.
		if (ctx.base.projetsHorsDe(cible.id, moi).length) throw refuse("ce compte a aussi un rôle sur un projet que tu ne gères pas : son lien de reconnexion se crée dans l'administration (demander à un admin)");
		const r = ctx.base.nouvelleReconnexion(cible.id, projet, moi.id);
		trace("reconnexion créée", cible.id, { invitation: r.id, expire: r.expire });
		json(res, 201, reponseReconnexion(ctx, req, r, cible, projet));
		return true;
	}
	if (r0 === "membres" && seg.length === 2 && (m === "PUT" || m === "DELETE")) {
		const compte = r1;
		const actuel = ctx.base.roleProjet(compte, projet);
		if (!actuel) throw absent("ce compte n'est pas membre du projet (inviter d'abord)");
		if (compte === moi.id && a.role !== "admin") throw refuse("un mainteneur ne change pas son propre rôle");
		if (m === "PUT") {
			const c = await corpsObjet();
			// Étape 3.9, E2 : { onglets, jours } sur un testeur : nouveaux onglets, fin recomptée à partir de maintenant.
			if (c.role === undefined && actuel === "testeur") {
				for (const k of Object.keys(c)) if (k !== "onglets" && k !== "jours") throw invalide(`clé inconnue : ${k}`);
				const t = validerTesteur(ctx, projet, c);
				const fin = new Date(Date.now() + t.jours * 24 * 3600 * 1000).toISOString();
				ctx.base.modifierRestriction(compte, projet, { onglets: t.onglets, fin });
				ctx.flux.reverifier();
				trace("testeur modifié", compte, { onglets: t.onglets, fin });
				json(res, 200, { compte, role: "testeur", testeur: { onglets: t.onglets, fin } });
				return true;
			}
			for (const k of Object.keys(c)) if (k !== "role") throw invalide(`clé inconnue : ${k}`);
			if (typeof c.role !== "string" || !(ROLES_PROJET as readonly string[]).includes(c.role)) throw invalide(`role : ${ROLES_PROJET.join(", ")}`);
			if (c.role === actuel) { json(res, 200, { compte, role: actuel, inchange: true }); return true; }
			if (c.role !== "mainteneur") gardeDernier(compte);
			const role = c.role;
			// Il quitte le rôle mainteneur : ses invitations en attente sur ce projet sont annulées (sinon il reviendrait
			// mainteneur par un lien créé avant). Ses jetons suivent son rôle (Base.jeton) : un jeton « mainteneur » ne vaut
			// plus que comme « agent » s'il est contributeur, plus rien s'il est lecteur.
			const admin = !!ctx.base.compte(compte)?.admin;
			let annulees: string[] = [];
			ctx.base.transaction(() => {
				ctx.base.donnerRole(compte, projet, role);
				if (actuel === "mainteneur" && !admin) annulees = ctx.base.annulerInvitationsDe(compte, p => p !== projet);
			});
			ctx.flux.reverifier();
			trace("rôle changé", compte, { avant: actuel, apres: role, ...(annulees.length ? { invitations_annulees: annulees } : {}) });
			json(res, 200, { compte, role, invitations_annulees: annulees });
			return true;
		}
		gardeDernier(compte);
		let revoques: string[] = [], annulees: string[] = [];
		const admin = !!ctx.base.compte(compte)?.admin;
		ctx.base.transaction(() => {
			ctx.base.retirerRole(compte, projet);
			// Ses jetons de CE projet sont révoqués ; ses sessions de l'hôte des pages pour ce projet aussi ; ses
			// invitations en attente sur ce projet sont annulées (sauf pour un admin, qui garde le droit d'inviter).
			revoques = ctx.base.revoquerJetonsDe(compte, projet);
			ctx.base.db.prepare("DELETE FROM sessions_pages WHERE compte = ? AND projet = ?").run(compte, projet);
			if (!admin) annulees = ctx.base.annulerInvitationsDe(compte, p => p !== projet);
			// Étape 3.5 : les liens de reconnexion de ce projet qui le visent aussi.
			for (const i of ctx.base.annulerReconnexionsVers(compte, projet)) if (!annulees.includes(i)) annulees.push(i);
		});
		ctx.flux.reverifier();
		trace("rôle retiré", compte, { role: actuel, jetons_revoques: revoques, invitations_annulees: annulees });
		json(res, 200, { compte, retire: true, jetons_revoques: revoques, invitations_annulees: annulees });
		return true;
	}
	if (r0 === "invitations" && seg.length === 1 && m === "POST") {
		const c = await corpsObjet();
		for (const k of Object.keys(c)) if (k !== "role" && k !== "expire" && k !== "onglets" && k !== "jours") throw invalide(`clé inconnue : ${k}`);
		// Un mainteneur invite jusqu'à mainteneur ; jamais admin (rôle global, API admin). Étape 3.9, E2 : ou un testeur.
		if (typeof c.role !== "string" || ![...ROLES_PROJET, "testeur"].includes(c.role)) throw invalide(`role : ${ROLES_PROJET.join(", ")}, testeur`);
		if (c.role !== "testeur" && (c.onglets !== undefined || c.jours !== undefined)) throw invalide("onglets, jours : seulement pour une invitation de testeur");
		const t = c.role === "testeur" ? validerTesteur(ctx, projet, c) : undefined;
		const expire = validerExpiration(c.expire);
		const inv = ctx.base.nouvelleInvitation(projet, c.role, expire, moi.id, t);
		const lien = `/invitation/${inv.jeton}`;
		trace("invitation créée", inv.id, { role: c.role, expire, ...(t || {}) });
		json(res, 201, { id: inv.id, lien, url: ctx.urlPublique(req) + lien, projet, role: c.role, expire, ...(t || {}) });
		return true;
	}
	if (r0 === "invitations" && seg.length === 2 && m === "DELETE") {
		const inv = /^[A-Za-z0-9]{1,40}$/.test(r1) ? ctx.base.invitationParId(r1) : undefined;
		if (!inv || inv.projet !== projet) throw absent("invitation introuvable");
		if (inv.etat !== "attente") throw invalide(`invitation déjà ${inv.etat === "utilisee" ? "utilisée" : inv.etat === "annulee" ? "annulée" : "expirée"}`);
		ctx.base.annulerInvitation(inv.id);
		trace("invitation annulée", inv.id, { role: inv.role });
		ctx.verifierLienAdmin();
		json(res, 204);
		return true;
	}
	if (r0 === "jetons" && seg.length === 1 && m === "GET") { json(res, 200, { jetons: ctx.base.jetons(projet) }); return true; }
	if (r0 === "jetons" && seg.length === 1 && m === "POST") {
		const c = await corpsObjet();
		for (const k of Object.keys(c)) if (k !== "nom" && k !== "role") throw invalide(`clé inconnue : ${k}`);
		const nom = validerNom(c.nom);
		const role = c.role === undefined ? "agent" : c.role;
		if (typeof role !== "string" || !(ROLES_JETON as readonly string[]).includes(role)) throw invalide(`role : ${ROLES_JETON.join(" ou ")}`);
		// Propriétaire : le compte qui le crée (§ 1.4). La valeur n'est montrée qu'ici, une fois.
		const j = ctx.base.creerJeton(projet, nom, role as RoleJeton, moi.id);
		ctx.journal(`jeton ${role} créé : ${j.id} sur ${projet} (pour ${moi.id})`);
		trace("jeton créé", j.id, { nom, role });
		json(res, 201, { id: j.id, jeton: j.jeton, projet, nom, role, pour: { id: moi.id, nom: moi.nom } });
		return true;
	}
	if (r0 === "jetons" && seg.length === 2 && m === "DELETE") {
		const info = ctx.base.jetonParId(r1);
		if (!info || info.projet !== projet || info.revoque) throw absent("jeton introuvable ou déjà révoqué");
		ctx.base.revoquerJeton(r1);
		ctx.flux.reverifier();
		trace("jeton révoqué", r1, { nom: info.nom });
		json(res, 204);
		return true;
	}
	if (r0 === "reglages" && seg.length === 1 && m === "PUT") {
		ctx.modes.verifierEcriture(projet);
		const r = await ecrireReglages(depot, a, await lireJson(req));
		if (!r.inchange) trace("réglages changés", projet, { disciplines: r.reglages.disciplines.map(d => d.nom), url_commit: r.reglages.url_commit, traitement: r.reglages.traitement });
		json(res, 200, r);
		return true;
	}
	return false;
}
