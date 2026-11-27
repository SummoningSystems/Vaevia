// Authentification : session par cookie (comptes humains) ou jeton Bearer (agents), contrôle anti-CSRF, invitations.
// Étape 3 (§ 2) : sur l'hôte des pages (WDD_URL_PAGES), seule compte la session propre à cet hôte (cookie wdd_pages,
// limitée à un projet) ; ni wdd_session ni jeton Bearer n'y valent.
import type { IncomingMessage } from "node:http";
import type { Base, Compte, Role, RoleJeton } from "./base.ts";
import type { Config } from "./config.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi } from "./retours.ts";

export const COOKIE = "wdd_session";
export const COOKIE_PAGES = "wdd_pages";

export function cookies(req: IncomingMessage): Map<string, string> {
	const m = new Map<string, string>();
	for (const part of String(req.headers.cookie || "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
	}
	return m;
}
// Toutes les valeurs d'un cookie (le navigateur peut en envoyer plusieurs de même nom, de chemins différents).
export function valeursCookie(req: IncomingMessage, nom: string): string[] {
	const v: string[] = [];
	for (const part of String(req.headers.cookie || "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === nom) v.push(part.slice(i + 1).trim());
	}
	return v;
}

export function cookieSession(config: Config, jeton: string, maxAge: number): string {
	return `${COOKIE}=${jeton}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.https ? "; Secure" : ""}`;
}
// Cookie de l'hôte des pages (§ 2) : cookie hôte seul (sans Domain), HttpOnly, SameSite=Lax (avec Strict, il ne
// partirait pas sur la navigation venue de l'hôte principal, qui est un autre site). Posé deux fois, limité par Path
// aux chemins du projet : la page (/p/<projet>/) et son API (/api/p/<projet>/). Le navigateur ne l'envoie donc pas aux
// autres projets, et une entrée dans un 2e projet n'écrase pas le cookie du 1er. Le serveur vérifie aussi le projet.
export function cookiesPages(config: Config, projet: string, jeton: string, maxAge: number): string[] {
	const suite = `HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.https ? "; Secure" : ""}`;
	return [`${COOKIE_PAGES}=${jeton}; Path=/p/${projet}/; ${suite}`, `${COOKIE_PAGES}=${jeton}; Path=/api/p/${projet}/; ${suite}`];
}

// Qui fait la requête : un agent (Authorization: Bearer, prioritaire), un compte (cookie de session) ou personne.
export type Identite =
	| { type: "agent"; jetonId: string; nom: string; projet: string; role: RoleJeton; pour: { id: string; nom: string } | null }
	| { type: "compte"; compte: Compte }
	| { type: "aucun"; cookie: boolean };

export function identifier(req: IncomingMessage, base: Base): Identite {
	const auth = String(req.headers.authorization || "");
	if (auth) {
		const m = auth.match(/^Bearer\s+(\S+)$/i);
		const j = m ? base.jeton(m[1]) : undefined;
		if (!j) throw new ErreurApi(401, "revoked", "jeton d'agent invalide ou révoqué");
		return { type: "agent", jetonId: j.id, nom: j.nom, projet: j.projet, role: j.role, pour: j.pour };
	}
	// Plusieurs wdd_session : aucune n'est prise. Le serveur n'en pose qu'une (Path=/, sans Domain) ; une 2e vient
	// d'ailleurs, par exemple d'un script d'un sous-domaine qui pose « Domain=<domaine parent> » pour imposer sa session
	// (connexion forcée). Prendre la 1re ou la dernière lui laisserait une chance.
	const toutes = valeursCookie(req, COOKIE);
	if (toutes.length > 1) return { type: "aucun", cookie: true };
	const c = toutes[0];
	if (c) {
		const compte = base.session(c);
		if (compte) return { type: "compte", compte };
	}
	return { type: "aucun", cookie: !!c };
}

// Hôte des pages : seulement la session wdd_pages de CE projet. Un jeton Bearer y est refusé (les agents passent par
// l'hôte principal).
export function identifierPages(req: IncomingMessage, base: Base, projet: string): Identite {
	if (req.headers.authorization) throw new ErreurApi(403, "permission_denied", "jeton refusé sur l'hôte des pages : utiliser l'adresse principale du serveur");
	const valeurs = valeursCookie(req, COOKIE_PAGES);
	for (const v of valeurs) {
		const compte = base.sessionPages(v, projet);
		if (compte) return { type: "compte", compte };
	}
	return { type: "aucun", cookie: valeurs.length > 0 };
}

// Acteur d'un projet (rôle compris), ou erreur 401 / 403.
export function acteur(id: Identite, base: Base, projet: string): Acteur {
	if (id.type === "aucun") throw new ErreurApi(401, "revoked", id.cookie ? "session expirée : demande un lien de reconnexion à un mainteneur du projet" : "session requise (lien d'invitation ou de reconnexion)");
	if (id.type === "agent") {
		if (id.projet !== projet) throw new ErreurApi(403, "permission_denied", "ce jeton d'agent est limité à un autre projet");
		// Étape 3.9, I2 : jeton « retour » d'une application : le retour est celui de son propriétaire (il le retrouve dans
		// le Wiki, le corrige, reçoit la réponse). Sans propriétaire, il ne vaut rien. La garde d'apiProjet ne lui ouvre
		// que la création d'un retour et l'envoi d'une capture, avant tout droit (« c'est son retour » serait vrai).
		if (id.role === "retour") {
			if (!id.pour) throw new ErreurApi(403, "permission_denied", "jeton retour sans propriétaire");
			const c = base.compte(id.pour.id);
			const externe = !!c && base.roleSur(c, projet) === "testeur";
			return { id: id.pour.id, nom: id.pour.nom, role: "retour", email: `${id.pour.id}@wdd.invalid`, agent: true, jeton: id.jetonId, pour: null, ...(externe ? { externe: true } : {}) };
		}
		// Jeton « mainteneur » (étape 2, § 2.2) : droits du mainteneur (§ 3.1 de l'étape 1) plus l'import ; pas ceux de
		// l'agent (status, reply). Même forme d'id et d'auteur de commit que l'agent.
		return { id: "agent:" + id.jetonId, nom: id.nom, role: id.role, email: `agent-${id.jetonId}@wdd.invalid`, agent: true, jeton: id.jetonId, pour: id.pour };
	}
	const role: Role | null = base.roleSur(id.compte, projet);
	if (!role) throw new ErreurApi(403, "permission_denied", "aucun accès à ce projet");
	return { id: id.compte.id, nom: id.compte.nom, role, email: `${id.compte.id}@wdd.invalid`, agent: false };
}

// Anti-CSRF : toute requête qui modifie (POST, PATCH, PUT, DELETE) et porte un cookie exige X-WDD: 1, et un Origin
// égal à l'hôte s'il est présent. Une requête Bearer sans cookie n'est pas concernée (un site tiers ne peut pas
// poser d'en-tête Authorization sans CORS, que le serveur n'accorde jamais). « attendue » : l'origine de l'hôte qui
// reçoit la requête (WDD_URL_PAGES sur l'hôte des pages) ; par défaut WDD_URL, sinon déduite de Host.
export function verifierCsrf(req: IncomingMessage, config: Config, attendue?: string): void {
	if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method || "")) return;
	if (!req.headers.cookie) return;
	if (req.headers["x-wdd"] !== "1") throw new ErreurApi(403, "permission_denied", "en-tête X-WDD: 1 requis (anti-CSRF)");
	verifierOrigine(req, config, attendue);
}

export function verifierOrigine(req: IncomingMessage, config: Config, attendue?: string): void {
	const origin = req.headers.origin;
	if (origin === undefined) return;
	const cible = attendue || config.url || `${config.https ? "https" : "http"}://${req.headers.host || ""}`;
	let ok = false;
	try { ok = new URL(origin).origin === new URL(cible).origin; } catch { ok = false; }
	if (!ok) throw new ErreurApi(403, "permission_denied", "Origin refusé (anti-CSRF)");
}

// Nom affiché choisi à l'ouverture d'une invitation : 1 à 60 caractères, sans caractère de contrôle ni < >.
export function validerNom(v: unknown): string {
	const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
	// U+FFFD : octets non UTF-8 décodés (formulaire envoyé dans une autre page de code).
	// Au moins une lettre ou un chiffre : Git refuse un nom d'auteur fait seulement de ponctuation (« ' », « :; »).
	if (!s || s.length > 60 || /[\u0000-\u001f\u007f<>�]/.test(s) || !/[\p{L}\p{N}]/u.test(s))
		throw new ErreurApi(400, "invalid_document", "nom affiché : 1 à 60 caractères dont une lettre ou un chiffre, sans < ni >, en UTF-8");
	return s;
}
