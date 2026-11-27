// Routage HTTP : pages (accueil, invitation, page du projet), API page et agent (/api/p/<projet>/…), API admin
// (/api/admin/…) et API de test (/__test/…, seulement si WDD_TEST=1). Voir docs/etape1-serveur.md § 4.
// Étape 3 (docs/etape3-meta-interface.md) : tickets (§ 3.1), gestion du projet (§ 3.2, gestion.ts), administration
// (§ 3.3), journal (§ 3.4), méta-interface servie depuis serveur/ui/ (statique.ts), isolement des pages (§ 2) :
// avec WDD_URL_PAGES, l'hôte des pages ne répond qu'aux routes du Wiki (la page du projet), l'hôte principal ne sert plus de
// page construite (il redirige avec un jeton d'entrée), un Host inconnu reçoit 421.
// Toute erreur d'API répond { code, message } avec le code du contrat (CONTRAT.md § 6).
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Base, Compte, Invitation } from "./base.ts";
import type { Config } from "./config.ts";
import { VERSION_OUTIL } from "./config.ts";
import type { Flux } from "./flux.ts";
import type { Modes } from "./test-api.ts";
import { Depot, ID_PROJET, ID_RETOUR, RESERVE_WINDOWS, ligne } from "./depot.ts";
import { ROLES_PROJET, ROLES_JETON, resumeNavigateur } from "./base.ts";
import type { RoleJeton } from "./base.ts";
import { ErreurApi, creer, creerSerie, modifier, supprimer, batch, invalide, absent, auteurDe, droitCreer, aussi, fusionner } from "./retours.ts";
import type { Acteur } from "./retours.ts";
import { identifier, identifierPages, acteur, verifierCsrf, verifierOrigine, cookieSession, cookiesPages, validerNom, valeursCookie, COOKIE, COOKIE_PAGES } from "./auth.ts";
import type { Identite } from "./auth.ts";
import { construire, dernierBuild, dossierBuilds, envelopper, infoDernierBuild, retoursOuverts, listerBuilds, appliquerRetention, placeProjet, echecsBuild, pageAudience, ficheDuDernierBuild } from "./builds.ts";
import { recevoirForge, routeConfigForge, MAX_CORPS_FORGE } from "./forge.ts";
import { servirGit } from "./clone.ts";
import { csv, lignesRetours, lignesTickets, lignesJournal, approbations, COLONNES_RETOURS, COLONNES_TICKETS, COLONNES_JOURNAL, COLONNES_APPROBATIONS } from "./exports.ts";
import { ecrireNotes, listerNotes, lireNotes } from "./notes.ts";
import { importer } from "./import.ts";
import { traiterTest } from "./test-api.ts";
import { creerTicket, modifierTicket, changerEtat, ajouterCommits, fermerTicket, supprimerTicket, listerTickets, historiqueTicket } from "./tickets.ts";
import type { ContexteTickets } from "./tickets.ts";
import { ID_TICKET } from "./ticket-fichier.ts";
import { estIllisible } from "./depot.ts";
import { nomsDisciplines, lireReglages } from "./reglages.ts";
import { routeGestion, apiMoi, journaliser, validerExpiration, corpsVide, reponseReconnexion } from "./gestion.ts";
import { servirStatique, uiPresente, servirIndex } from "./statique.ts";
import { bandeau, phraseBranchement } from "./bandeau.ts";
import { apiAppairage, redirigerAppairage } from "./appairage.ts";
import { routeDemandes, veilleurs, masquer, creerDemande } from "./demandes.ts";
import { lancerSauvegarde } from "./sauvegarde.ts";
import { routeNotifications } from "./notifications.ts";
import { enregistrerCapture, lireCapture, MAX_CAPTURE } from "./captures.ts";
import type { Notifieur } from "./notifications.ts";
import type { EtatSauvegarde } from "./sauvegarde.ts";

export type Contexte = {
	config: Config;
	base: Base;
	flux: Flux;
	modes: Modes;
	depots: Map<string, Depot>;
	racineProjets: string;
	configGit: string;
	journal: (m: string) => void;
	urlPublique: (req?: IncomingMessage) => string;
	// Supprime lien-admin.txt si son lien ne vaut plus (étape 3.5, § 1.1) ; après chaque utilisation ou annulation.
	verifierLienAdmin: () => void;
	// Codes d'appairage inconnus par session (empreinte du cookie → instants), pour la limite de 10 par minute (appairage.ts).
	essaisCodes: Map<string, number[]>;
	// Sauvegarde (étape 3.7, A1) : dossier, planification, dernière issue (sauvegarde.ts).
	sauvegarde: EtatSauvegarde;
	// Notifications par webhook (étape 3.7, I1).
	notifieur: Notifieur;
};

export const MAX_CORPS = 1024 * 1024;            // corps JSON : 1 Mio
export const MAX_BUILD = 16 * 1024 * 1024;       // data.json d'un build : 16 Mio (limite de taille de la page)
export const MAX_IMPORT_OCTETS = 16 * 1024 * 1024; // import : 500 retours de textes longs dépassent 1 Mio

// --- Réponses ---------------------------------------------------------------------------------------------
// X-WDD-Version (étape 3.9, A4) : la CLI compare sa version à celle du serveur.
const DEBUT_SERVEUR = new Date().toISOString();   // étape 3.9, A5 : heure de démarrage (chargement du module)
export const ENTETES_COMMUNS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Cache-Control": "no-store", "X-WDD-Version": VERSION_OUTIL };
// CSP des pages HTML. Scripts : jamais 'unsafe-inline', seulement l'empreinte (sha256) de chaque <script> en ligne de
// la page envoyée, calculée à la livraison. Un gestionnaire en ligne injecté par des données (<img onerror=…> dans un
// libellé mal échappé) ne s'exécute donc pas. Le build est du contenu actif : cette CSP est la défense de fond (voir
// docs/etape1-serveur.md, écarts) ; à l'étape 3, WDD_URL_PAGES le sert en plus sur une autre origine.
const CSP_BASE = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SCRIPT_EN_LIGNE = /<script\b[^>]*>([\s\S]*?)<\/script[\s/>]/gi;
// formAction : origine permise en plus de 'self' pour la cible d'un formulaire (page d'invitation seulement).
export function cspPour(corps: string, formAction = ""): string {
	const empreintes = new Set<string>();
	for (const m of corps.matchAll(SCRIPT_EN_LIGNE)) empreintes.add(`'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
	const base = formAction ? CSP_BASE.replace("form-action 'self'", `form-action 'self' ${formAction}`) : CSP_BASE;
	return `${base}; script-src ${empreintes.size ? [...empreintes].join(" ") : "'none'"}`;
}

export function json(res: ServerResponse, statut: number, corps?: unknown, entetes: Record<string, string> = {}): void {
	if (res.headersSent) { res.destroy(); return; }
	if (statut === 204 || corps === undefined) { res.writeHead(statut, { ...ENTETES_COMMUNS, ...entetes }); res.end(); return; }
	const s = JSON.stringify(corps);
	res.writeHead(statut, { ...ENTETES_COMMUNS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s), ...entetes });
	res.end(s);
}
// Fins de ligne en LF : le navigateur les normalise avant de calculer l'empreinte d'un script (gabarit en CRLF après un
// checkout Windows), on sert donc exactement ce qui est haché.
const normaliserLf = (s: string) => s.replace(/\r\n?/g, "\n");
function html(res: ServerResponse, statut: number, brut: string, entetes: Record<string, string | string[]> = {}, formAction = ""): void {
	const corps = normaliserLf(brut);
	res.writeHead(statut, { ...ENTETES_COMMUNS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": cspPour(corps, formAction), "X-Frame-Options": "DENY", "Content-Length": Buffer.byteLength(corps), ...entetes });
	res.end(corps);
}
function erreur(res: ServerResponse, e: unknown, journal: (m: string) => void): void {
	if (e instanceof ErreurApi) return json(res, e.statut, { code: e.code, message: e.message, ...e.extra });
	journal("erreur interne : " + ((e as Error)?.stack || e));
	json(res, 500, { code: "unavailable", message: "erreur interne du serveur" });
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
// tete : HTML déjà échappé posé avant le contenu (le bandeau du Wiki, bandeau.ts). Mêmes jetons que la méta-interface
// (serveur/ui/ui.css, direction « Studio ») et même gouttière que le bandeau : le titre s'aligne sur la marque, clair et
// sombre selon le système ; titre en Bahnschrift (police de Windows, replis système), focus orange de 3 px.
const STYLE_PAGE_SIMPLE = `:root{color-scheme:light dark;--fond:#eceef4;--surface:#ffffff;--surface-2:#e4e7ef;--bord:#d3d7e3;--texte:#171a2e;--doux:#4c5370;--lien:#3a2fb3;--focus:#c2410c;--g:16px}` +
	`@media (prefers-color-scheme:dark){:root{--fond:#121527;--surface:#1a1e35;--surface-2:#242946;--bord:#323858;--texte:#e9ebf7;--doux:#a8aecb;--lien:#b5acff;--focus:#ff9d4d}}` +
	`@media (min-width:64rem){:root{--g:24px}}` +
	`*{box-sizing:border-box}body{margin:0;background:var(--fond);color:var(--texte);font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:anywhere}` +
	`main{max-width:1280px;margin:0 auto;padding:20px var(--g) 48px}main>*{max-width:44rem}` +
	`h1,h2{font-family:Bahnschrift,"DIN Alternate","Barlow Semi Condensed","Roboto Condensed","Segoe UI",system-ui,sans-serif}` +
	`h1{font-size:24px;line-height:1.2;font-weight:700;margin:.25rem 0 .75rem}h2{font-size:17px;font-weight:600;margin:1.5rem 0 .4rem}p{margin:.5rem 0}` +
	`a{color:var(--lien);text-underline-offset:2px}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--focus);outline-offset:2px}` +
	`input,button{font:inherit;padding:.4rem .6rem}` +
	`code{font-family:ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;font-size:.9em;overflow-wrap:anywhere;background:var(--surface-2);border-radius:4px;padding:0 .25em}` +
	`#phrase-branchement{background:var(--surface);border:1px solid var(--bord);border-left:4px solid var(--lien);border-radius:8px;padding:.5rem .7rem;line-height:1.55}#phrase-branchement code{background:none;padding:0}`;
function pageSimple(titre: string, corps: string, tete = ""): string {
	return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titre)}</title>` +
		`<style>${STYLE_PAGE_SIMPLE}</style></head><body>${tete}<main><h1>${esc(titre)}</h1>${corps}</main></body></html>`;
}

// --- Corps de requête -------------------------------------------------------------------------------------
export function lireCorps(req: IncomingMessage, max: number): Promise<Buffer> {
	return new Promise((ok, ko) => {
		const annonce = Number(req.headers["content-length"] || 0);
		if (annonce > max) { req.resume(); return ko(new ErreurApi(413, "quota_exceeded", `corps trop gros (${max} octets au plus)`)); }
		const morceaux: Buffer[] = []; let n = 0, trop = false;
		req.on("data", (b: Buffer) => { n += b.length; if (n > max) trop = true; else morceaux.push(b); });
		req.on("end", () => trop ? ko(new ErreurApi(413, "quota_exceeded", `corps trop gros (${max} octets au plus)`)) : ok(Buffer.concat(morceaux)));
		req.on("error", ko);
	});
}
// Corps JSON : Content-Type application/json exigé dès qu'il y a un corps. Un formulaire ou un fetch « simple » d'un
// autre site (text/plain, sans pré-vérification CORS) est ainsi refusé, cookie ou pas. Refus en 400 invalid_document
// (pas 415, que le contrat ne connaît pas : l'adaptateur le lirait « unavailable »).
export async function lireJson(req: IncomingMessage, max = MAX_CORPS): Promise<unknown> {
	const b = await lireCorps(req, max);
	if (!b.length) return undefined;
	if (!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] || ""))) throw invalide("corps : Content-Type application/json attendu");
	try { return JSON.parse(utf8(b)); } catch { throw invalide("corps : JSON invalide (UTF-8 attendu)"); }
}
// Décodage UTF-8 strict : des octets invalides (client qui envoie dans une autre page de code) sont refusés, plutôt
// qu'enregistrés en caractères de remplacement dans un retour ou un nom d'auteur.
const decodeur = new TextDecoder("utf-8", { fatal: true });
export const utf8 = (b: Buffer): string => decodeur.decode(b);

// --- Hôtes (§ 2) ------------------------------------------------------------------------------------------
// Sans WDD_URL_PAGES : un seul hôte, tout Host accepté (comportement de l'étape 1). Avec : Host comparé à WDD_URL et
// WDD_URL_PAGES (port par défaut du schéma ignoré), tout autre → « inconnu » (421).
export type Hote = "principal" | "pages" | "inconnu";
const hoteNormalise = (h: string, url: string): string => {
	const u = new URL(url), port = u.protocol === "https:" ? "443" : "80";
	const s = h.trim().toLowerCase();
	return s.endsWith(":" + port) ? s.slice(0, -(port.length + 1)) : s;
};
export function hoteDe(config: Config, req: IncomingMessage): Hote {
	if (!config.urlPages) return "principal";
	const h = String(req.headers.host || "");
	if (!h) return "inconnu";
	if (hoteNormalise(h, config.url) === new URL(config.url).host.toLowerCase()) return "principal";
	if (hoteNormalise(h, config.urlPages) === new URL(config.urlPages).host.toLowerCase()) return "pages";
	return "inconnu";
}

// --- Routeur ----------------------------------------------------------------------------------------------
export function routeur(ctx: Contexte) {
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		try {
			const brut = String(req.url || "/");
			const q = brut.indexOf("?");
			const chemin = q < 0 ? brut : brut.slice(0, q);
			const params = new URLSearchParams(q < 0 ? "" : brut.slice(q + 1));
			// Segments décodés un par un ; un segment indécodable ne correspond à aucune route.
			const seg = chemin.split("/").slice(1).map(s => { try { return decodeURIComponent(s); } catch { return "\u0000"; } });
			const m = req.method || "GET";
			// Santé (étape 3.5, § 1.1) : sans authentification ni base, sur tout hôte, AVANT le contrôle de Host (le
			// HEALTHCHECK Docker appelle 127.0.0.1:8080, hôte inconnu avec WDD_URL_PAGES). Seule exception au 421. Ne dit
			// rien d'autre (ni version, ni présence d'un admin).
			if (chemin === "/api/sante" && (m === "GET" || m === "HEAD")) return json(res, 200, { ok: true });
			const hote = hoteDe(ctx.config, req);
			if (hote === "inconnu") return json(res, 421, { code: "not_found", message: "hôte inconnu : ce serveur ne répond qu'à WDD_URL et WDD_URL_PAGES" });
			prolonger(ctx, req, res, hote, seg);
			if (hote === "pages") return await routeurPages(ctx, req, res, seg, m, params);
			// Étape 3.9, A6 : clone en lecture seule du dépôt de design (git http-backend ; clone.ts), hôte principal seulement.
			if (await servirGit(req, res, chemin, q < 0 ? "" : brut.slice(q + 1), ctx.base, ctx.depots, ctx.journal)) return;

			if (seg[0] === "__test") {
				if (!ctx.config.test) return json(res, 404, { code: "not_found", message: "introuvable" });
				verifierCsrf(req, ctx.config);
				// Sans authentification par construction : X-WDD: 1 exigé même sans cookie, pour qu'une page d'un autre
				// site (fetch no-cors, formulaire) ne puisse pas piloter un serveur de test ouvert sur le poste.
				if (m !== "GET" && m !== "HEAD" && req.headers["x-wdd"] !== "1") throw new ErreurApi(403, "permission_denied", "en-tête X-WDD: 1 requis (API de test)");
				return await traiterTest(ctx, req, res, seg.slice(1), m, params);
			}
			if (seg[0] === "api" && seg[1] === "p" && seg.length >= 4) return await apiProjet(ctx, req, res, seg[2], seg.slice(3), m, params, false);
			if (seg[0] === "api" && seg[1] === "admin") return await apiAdmin(ctx, req, res, seg.slice(2), m, params);
			// Étape 3.9, I3 : webhook entrant de la forge. Ni cookie ni X-WDD : authentifié par la signature du corps (forge.ts).
			if (seg[0] === "api" && seg[1] === "forge" && seg.length === 3 && m === "POST") {
				const projetF = seg[2], depotF = ID_PROJET.test(projetF) ? ctx.depots.get(projetF) : undefined;
				const corpsF = await lireCorps(req, MAX_CORPS_FORGE);
				if (!depotF) throw absent("projet introuvable");
				const r = await recevoirForge(ctx.base, depotF, projetF, corpsF, req.headers, a => contexteTickets(ctx, depotF, projetF, a), m2 => ctx.journal(m2));
				return json(res, r.statut, r.corps);
			}
			if (seg[0] === "api" && seg[1] === "moi" && seg.length === 2 && m === "GET") return json(res, 200, apiMoi(ctx, req));
			// Étape 3.9, E4 : mes sessions (navigateur, création, dernier accès), et en fermer une ; session seulement.
			if (seg[0] === "api" && seg[1] === "moi" && seg[2] === "sessions") return mesSessions(ctx, req, res, seg.slice(3), m);
			// Étape 3.5 (§ 2.1, § 2.2) : appairage d'un poste, et l'adresse que la CLI fait ouvrir (vers la méta-interface).
			if (seg[0] === "api" && seg[1] === "appairage") return await apiAppairage(ctx, req, res, seg.slice(2), m);
			if (seg[0] === "appairage" && seg.length === 1 && (m === "GET" || m === "HEAD")) return redirigerAppairage(res, params);
			if (seg[0] === "invitation" && seg.length === 2) return await invitation(ctx, req, res, seg[1], m);
			if (seg[0] === "p" && seg.length >= 2 && ID_PROJET.test(seg[1]) && (m === "GET" || m === "HEAD")) {
				if (seg.length === 2) { res.writeHead(301, { Location: `/p/${seg[1]}/` }); return void res.end(); }
				if (seg.length === 3 && seg[2] === "") return ctx.config.urlPages ? versHotePages(ctx, req, res, seg[1], params) : await pageProjet(ctx, req, res, seg[1], params, false);
				// Étape 3.9, L3 : versions gardées (/p/<projet>/b/) et ancienne version (/p/<projet>/b/<n>/).
				const v = versionDe(seg);
				if (v !== undefined) return ctx.config.urlPages ? versHotePages(ctx, req, res, seg[1], params, v) : await pageProjet(ctx, req, res, seg[1], params, false, v);
			}
			if (chemin === "/favicon.ico" && !uiPresente(ctx.config, "favicon.ico")) { res.writeHead(204); return void res.end(); }
			if (m === "GET" || m === "HEAD") {
				// Méta-interface (serveur/ui/) sous « / » ; sans elle, la page d'accueil de l'étape 1.
				if (chemin === "/") return servirIndex(ctx.config, res) ? undefined : accueil(ctx, req, res);
				if (seg[0] !== "api" && seg[0] !== "p" && servirStatique(ctx.config, res, seg)) return;
			}
			json(res, 404, { code: "not_found", message: "introuvable" });
		} catch (e) { erreur(res, e, ctx.journal); }
	};
}

// Session prolongée à l'usage (étape 3.5, § 2.4) : une fois par requête, avant toute réponse. La ligne en base et le
// cookie (même valeur, nouveau Max-Age) changent ensemble : res.setHeader est fusionné avec le writeHead de la réponse,
// et une réponse qui pose elle-même un cookie (invitation, entrée sur l'hôte des pages) le remplace. Hôte principal :
// la session wdd_session, si elle est seule (deux valeurs : aucune session, comme identifier) et sans Bearer
// (prioritaire). Hôte des pages : la session wdd_pages du projet de l'adresse, reposée avec ses deux Path.
// Une réponse qui porte le cookie n'est jamais gardée par un cache partagé (RFC 9111 § 7.3 : Set-Cookie ne l'empêche
// pas) : Cache-Control: no-store posé avec lui, pour les réponses sans Cache-Control propre (redirections 301, 204) ;
// celles qui en ont un sont no-store, ou private (fichiers de la méta-interface, statique.ts).
function prolonger(ctx: Contexte, req: IncomingMessage, res: ServerResponse, hote: Hote, seg: string[]): void {
	try {
		if (hote === "principal") {
			if (req.headers.authorization) return;
			const v = valeursCookie(req, COOKIE);
			if (v.length !== 1) return;
			ctx.base.noterAcces(v[0]);   // étape 3.9, E4 : dernier accès (une fois par minute au plus)
			const maxAge = ctx.base.prolongerSession(v[0]);
			if (maxAge !== null) { res.setHeader("Set-Cookie", cookieSession(ctx.config, v[0], maxAge)); res.setHeader("Cache-Control", "no-store"); }
			return;
		}
		const projet = seg[0] === "p" ? seg[1] : seg[0] === "api" && seg[1] === "p" ? seg[2] : undefined;
		if (!projet || !ID_PROJET.test(projet)) return;
		for (const v of valeursCookie(req, COOKIE_PAGES)) {
			const maxAge = ctx.base.prolongerSessionPages(v, projet);
			if (maxAge !== null) { res.setHeader("Set-Cookie", cookiesPages(ctx.config, projet, v, maxAge)); res.setHeader("Cache-Control", "no-store"); return; }
		}
	} catch (e) { ctx.journal("prolongation de session impossible : " + ((e as Error)?.message || e)); }
}

// Hôte des pages : seulement la page de retours d'un projet et son API (session, retours, flux, écritures de retours).
// Tout le reste répond 404 : admin, membres, jetons, tickets, méta-interface, invitations, API de test.
async function routeurPages(ctx: Contexte, req: IncomingMessage, res: ServerResponse, seg: string[], m: string, params: URLSearchParams): Promise<void> {
	if (seg[0] === "api" && seg[1] === "p" && seg.length >= 4) {
		const r = seg.slice(3);
		const permis = (m === "GET" && r.length === 1 && ["session", "retours", "flux"].includes(r[0]))
			|| (m === "POST" && r.length === 1 && r[0] === "retours")
			// Étape 3.7, R2 : captures jointes aux retours (envoi, puis affichage dans le Wiki).
			|| (m === "POST" && r.length === 1 && r[0] === "captures")
			|| (m === "GET" && r.length === 2 && r[0] === "captures")
			// Étape 3.9, L7 : tickets qui citent des éléments, en lecture seule, pour la ligne « Tickets » des fiches.
			|| (m === "GET" && r.length === 1 && r[0] === "tickets-fiches")
			// Étape 3.9, lot 2 : noms des membres, « Moi aussi », fusion des doublons (un mainteneur, depuis le Wiki).
			|| (m === "GET" && r.length === 1 && r[0] === "noms")
			|| (m === "GET" && r.length === 1 && r[0] === "approbations")
			|| ((m === "POST" || m === "DELETE") && r.length === 3 && r[0] === "retours" && r[2] === "aussi")
			|| (m === "POST" && r.length === 3 && r[0] === "retours" && r[2] === "fusionner")
			// Étape 3.7, R1 : envoi d'une série de retours depuis le Wiki.
			|| (m === "POST" && r.length === 2 && r[0] === "retours" && r[1] === "serie")
			|| ((m === "PATCH" || m === "DELETE") && r.length === 2 && r[0] === "retours" && r[1] !== "batch");
		if (permis) return await apiProjet(ctx, req, res, seg[2], r, m, params, true);
	}
	if (seg[0] === "p" && seg.length >= 2 && ID_PROJET.test(seg[1]) && (m === "GET" || m === "HEAD")) {
		if (seg.length === 2) { res.writeHead(301, { Location: `/p/${seg[1]}/` }); return void res.end(); }
		if (seg.length === 3 && seg[2] === "") return await pagesEntree(ctx, req, res, seg[1], params);
		const v = versionDe(seg);
		if (v !== undefined) return await pageProjet(ctx, req, res, seg[1], params, true, v);
	}
	if (seg.length === 1 && seg[0] === "favicon.ico") { res.writeHead(204); return void res.end(); }
	json(res, 404, { code: "not_found", message: "introuvable" });
}

// --- Étape 3.9, I2 : retours depuis une application -------------------------------------------------------
const CATS_APP = ["bug", "idee", "texte", "fort", "faible", "autre"];
const CIBLE_APP = /^([a-z0-9][a-z0-9_-]{0,39}):(.{1,200})$/s;
export const PLAFOND_APP = { retours: 100, captures: 50 };
const quotasApp = new Map<string, { jour: string; retours: number; captures: number }>();
// Plafond par personne et par jour (UTC), en mémoire : un build part chez des gens extérieurs.
// Par propriétaire (un nouvel appairage ne le remet pas à zéro), pour un jeton « retour » comme pour un testeur externe.
function plafondApp(a: Acteur, quoi: "retours" | "captures", n = 1): void {
	const jour = new Date().toISOString().slice(0, 10), cle = a.id;
	let q = quotasApp.get(cle);
	if (!q || q.jour !== jour) quotasApp.set(cle, q = { jour, retours: 0, captures: 0 });
	if (q[quoi] + n > PLAFOND_APP[quoi]) throw new ErreurApi(429, "quota_exceeded", `plafond du jour atteint : ${PLAFOND_APP[quoi]} ${quoi} au plus par personne (retours depuis une application, testeurs externes)`);
	q[quoi] += n;
}
function retourDepuisApp(ctx: Contexte, projet: string, c: unknown, a: Acteur): { donnees: Record<string, unknown>; fiche: { trouvee: boolean; kind: string; ref: string; name: string; anchor: string } } {
	if (!c || typeof c !== "object" || Array.isArray(c)) throw invalide("objet { text, cible?, cat?, captures?, contexte? } attendu");
	const o = c as Record<string, unknown>;
	for (const k of Object.keys(o)) if (!["text", "cible", "cat", "captures", "contexte"].includes(k)) throw invalide(`clé inconnue : ${k}`);
	if (typeof o.text !== "string" || !o.text.trim()) throw invalide("text : le retour, non vide");
	const cat = o.cat === undefined ? "bug" : o.cat;
	if (typeof cat !== "string" || !CATS_APP.includes(cat)) throw invalide(`cat : ${CATS_APP.join(", ")}`);
	const cible = o.cible === undefined ? "" : o.cible;
	if (typeof cible !== "string") throw invalide("cible : « sorte:ref » (texte), ou vide");
	const m = cible ? CIBLE_APP.exec(cible) : null;
	if (cible && !m) throw invalide("cible : « sorte:ref » (sorte en minuscules, chiffres, - et _ ; ref de 1 à 200 caractères)");
	const captures = o.captures === undefined ? [] : o.captures;
	if (!Array.isArray(captures) || captures.length > 3 || !captures.every(x => typeof x === "string" && /^[0-9a-f]{64}\.(png|webp)$/.test(x))) throw invalide("captures : ids rendus par POST …/captures (3 au plus)");
	const contexte = o.contexte === undefined ? "" : o.contexte;
	if (typeof contexte !== "string" || contexte.length > 300 || /[\r\n]/.test(contexte)) throw invalide("contexte : une ligne, 300 caractères au plus (version, écran, système…)");
	const kind = m ? m[1] : "general", ref = m ? m[2] : "application";
	let f = m ? ficheDuDernierBuild(ctx.racineProjets, ctx.config.site, projet, kind, ref) : null;
	// Un testeur externe (en session ou par son jeton « retour ») ne résout une cible que dans ses onglets : sinon le nom
	// et l'ancre d'une fiche cachée lui reviendraient (réponse, puis son propre retour). Hors de ses onglets : sans fiche.
	if (f && (a.role === "testeur" || a.externe)) { const t = ctx.base.restriction(a.id, projet); if (!t || !t.onglets.includes(f.tab)) f = null; }
	const now = new Date().toISOString();
	const texte = o.text.trim() + (contexte.trim() ? `\n\nContexte : ${contexte.trim()}` : "");
	const donnees: Record<string, unknown> = { kind, ref: f ? f.ref : ref, name: f ? f.name : m ? ref : "Application (sans fiche)", tab: f ? f.tab : "", anchor: f ? f.anchor : "",
		cat, text: texte, proposal: "", status: "nouveau", reply: "", replied: "", created: now, updated: now, by: "", codex: f ? f.codex : "", ...(captures.length ? { captures: captures.join(" ") } : {}) };
	return { donnees, fiche: { trouvee: !!f, kind, ref: String(donnees.ref), name: String(donnees.name), anchor: String(donnees.anchor) } };
}

// --- Contexte d'une requête sur un projet ---------------------------------------------------------------
// Étape 3.9, I3 : contexte des écritures de tickets (celui de la route des tickets), pour un acteur donné.
function contexteTickets(ctx: Contexte, depot: Depot, projet: string, a: Acteur): ContexteTickets {
	return { depot, a, disciplines: () => nomsDisciplines(depot),
		diffuser: retoursAussi => { if (retoursAussi) ctx.flux.diffuser(projet, depot.instantane()); ctx.flux.diffuserTickets(projet, depot.instantaneTickets()); },
		journaliser: (action, cible, detail) => journaliser(ctx, a, action, projet, cible, detail) };
}
function depotDe(ctx: Contexte, projet: string): Depot {
	const d = ID_PROJET.test(projet) ? ctx.depots.get(projet) : undefined;
	if (!d) throw absent("projet introuvable");
	return d;
}
const diffuseur = (ctx: Contexte) => (depot: Depot) => ctx.flux.diffuser(depot.projet, depot.instantane());

async function apiProjet(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, seg: string[], m: string, params: URLSearchParams, pages: boolean): Promise<void> {
	verifierCsrf(req, ctx.config, pages ? ctx.config.urlPages : undefined);
	const qui = (): Identite => pages ? identifierPages(req, ctx.base, projet) : identifier(req, ctx.base);
	const id: Identite = qui();
	if (id.type === "aucun") acteur(id, ctx.base, projet); // 401 avant toute autre réponse
	const depot = depotDe(ctx, projet);
	ctx.modes.verifierAcces(projet);
	const a: Acteur = acteur(id, ctx.base, projet);
	const [r0, r1, r2] = seg;
	// Étape 3.7, G2 : un jeton « publieur » (CI) ne fait que publier un build et lire l'état du dernier ; tout le reste
	// lui est refusé, avant toute autre route (retours, notes, flux, tickets, demandes, gestion).
	if (a.role === "publieur" && !(r0 === "builds" && seg.length === 1 && (m === "POST" || m === "GET"))) throw new ErreurApi(403, "permission_denied", "jeton publieur : seulement POST et GET /builds (publication par la CI)");
	// Étape 3.9, A6 : un jeton « clone » ne sert qu'à git clone / fetch (/git/<projet>.git), jamais à l'API.
	if (a.role === "clone") throw new ErreurApi(403, "permission_denied", "jeton clone : seulement git clone et git fetch du dépôt de design (/git/<projet>.git)");
	// Étape 3.9, E2 : un testeur externe n'a que sa session, ses propres retours (lire, créer, série, modifier,
	// supprimer), les captures et le flux (filtré). Tout le reste lui est refusé, avant toute autre route : liste
	// blanche, pour qu'une route ajoutée plus tard lui reste fermée.
	if (a.role === "testeur") {
		const permis = (m === "GET" && seg.length === 1 && (r0 === "session" || r0 === "retours" || r0 === "flux"))
			|| (m === "POST" && seg.length === 1 && (r0 === "retours" || r0 === "captures"))
			|| (m === "GET" && seg.length === 2 && r0 === "captures")
			|| (m === "POST" && seg.length === 2 && r0 === "retours" && r1 === "serie")
			|| ((m === "PATCH" || m === "DELETE") && seg.length === 2 && r0 === "retours" && r1 !== "batch" && r1 !== "serie");
		if (!permis) throw new ErreurApi(403, "permission_denied", "testeur externe : seulement ses propres retours, depuis le Wiki");
	}
	// Étape 3.9, I2 : un jeton « retour » (application) ne crée que des retours et n'envoie que des captures ; il lit sa
	// session (pour vérifier l'appairage). Rien d'autre, ni lecture des retours.
	if (a.role === "retour") {
		const permis = (m === "GET" && seg.length === 1 && r0 === "session")
			|| (m === "POST" && seg.length === 1 && r0 === "captures")
			|| (m === "POST" && seg.length === 2 && r0 === "retours" && r1 === "app");
		if (!permis) throw new ErreurApi(403, "permission_denied", "jeton retour : seulement POST …/retours/app et POST …/captures (retours depuis une application)");
	}
	const sien = (d: { donnees: Record<string, unknown> }) => a.role !== "testeur" || d.donnees.by === a.id;
	// Ce qu'un testeur relit de ses propres retours : sans « aussi » (ids d'autres comptes) ; un doublon fusionné garde
	// son statut, mais sa réponse ne cite pas l'autre retour (nom de fiche, id).
	const masquer = <T extends { donnees: Record<string, unknown> }>(d: T): T => {
		if (a.role !== "testeur") return d;
		const { aussi, fusionne_dans, ...reste } = d.donnees;
		return { ...d, donnees: fusionne_dans ? { ...reste, reply: "Fusionné avec un autre retour qui reprend le même point : la suite y est suivie." } : reste };
	};
	const ecrire = () => { if (a.role === "lecteur") throw new ErreurApi(403, "permission_denied", "le rôle lecteur n'écrit pas"); ctx.modes.verifierEcriture(projet); };

	if (r0 === "session" && seg.length === 1 && m === "GET") {
		const proprietaire = a.role === "mainteneur" || a.role === "admin";
		let ecriture: boolean | null = ["contributeur", "mainteneur", "admin", "testeur"].includes(a.role);
		const imposee = ctx.modes.ecriture(projet);
		if (imposee !== undefined) ecriture = imposee;
		return json(res, 200, { id: a.id, nom: a.nom, role: a.role, proprietaire, ecriture, ...(a.pour ? { pour: a.pour } : {}), ...(a.role === "testeur" ? { testeur: true } : {}) });
	}
	if (r0 === "retours" && seg.length === 1 && m === "GET") {
		if (ctx.modes.retenir(projet, res)) return;
		const st = params.get("status");
		const statuts = st ? new Set(st.split(",").map(s => s.trim()).filter(Boolean)) : null;
		const inst = depot.instantane(d => sien(d) && (!statuts || statuts.has(String(d.donnees.status))));
		return json(res, 200, { ...inst, docs: inst.docs.map(masquer) });
	}
	if (r0 === "flux" && seg.length === 1 && m === "GET") {
		if (ctx.modes.retenir(projet, res)) return;
		if (ctx.modes.refuserFlux(projet)) throw new ErreurApi(503, "unavailable", "flux refusé (mode de test snapretry)");
		// Le flux reste ouvert des heures : session ou jeton revérifiés à chaque ping et à chaque diffusion (jeton
		// révoqué, session expirée, accès retiré : flux coupé). Même règle d'identité que la requête (hôte des pages :
		// wdd_pages seulement). L'événement « tickets » n'est pas émis sur l'hôte des pages.
		const valide = (): boolean => {
			try { const i = qui(); if (i.type === "aucun") return false; acteur(i, ctx.base, projet); return true; }
			catch { return false; }
		};
		// Étape 3.9, E2 : un testeur ne reçoit que ses propres retours, et jamais les tickets (sur aucun hôte).
		const testeur = a.role === "testeur";
		const filtre = testeur ? (c: unknown) => { const x = c as { docs?: { donnees: Record<string, unknown> }[] }; return Array.isArray(x?.docs) ? { ...x, docs: x.docs.filter(sien).map(masquer) } : x; } : undefined;
		ctx.flux.ouvrir(res, projet, depot.instantane(), valide, pages || testeur ? undefined : depot.instantaneTickets(), filtre);
		ctx.modes.apresOuvertureFlux(projet, res);
		return;
	}
	if (r0 === "retours" && seg.length === 1 && m === "POST") {
		ecrire();
		if (a.role === "testeur") plafondApp(a, "retours");
		const r = await creer(depot, a, await lireJson(req), diffuseur(ctx));
		return json(res, 201, r);
	}
	// Étape 3.7 (R2) : captures. Envoi : qui crée des retours ; corps brut PNG ou WebP (réencodé par la page), 2 Mio au plus.
	if (r0 === "captures" && seg.length === 1 && m === "POST") {
		ecrire();
		if (a.role === "retour" || a.role === "testeur") plafondApp(a, "captures");
		const d = droitCreer(a); if (d) throw new ErreurApi(403, "permission_denied", d);
		const corps = await lireCorps(req, MAX_CAPTURE);
		return json(res, 201, enregistrerCapture(ctx.racineProjets, projet, corps));
	}
	// Lecture : tout membre du projet (et un agent). Jamais en HTML : type fixé, nosniff, CSP fermée, bac à sable.
	if (r0 === "captures" && seg.length === 2 && m === "GET") {
		const c = lireCapture(ctx.racineProjets, projet, r1);
		res.writeHead(200, { ...ENTETES_COMMUNS, "Cache-Control": "private, max-age=86400, immutable", "Content-Type": c.type, "Content-Length": c.corps.length,
			"Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": `inline; filename="capture.${r1.endsWith(".png") ? "png" : "webp"}"`, "Cross-Origin-Resource-Policy": "same-origin" });
		return void res.end(c.corps);
	}
	// Étape 3.9, I2 : retour depuis une application (protocole générique, docs/retours-depuis-une-application.md). Le
	// client n'envoie que la cible (« sorte:ref »), le texte, la catégorie, ses captures et une ligne de contexte ; le
	// serveur complète le nom, l'onglet et l'ancre d'après le dernier build, et pose dates, auteur et statut. Une cible
	// absente du dernier build (ou aucune) donne un retour « sans fiche ». Tout auteur de retours peut s'en servir.
	if (r0 === "retours" && r1 === "app" && seg.length === 2 && m === "POST") {
		ecrire();
		if (a.role === "retour" || a.role === "testeur") plafondApp(a, "retours");
		const c = await lireJson(req);
		const d = retourDepuisApp(ctx, projet, c, a);
		const r = await creer(depot, a, d.donnees, diffuseur(ctx));
		return json(res, 201, { ...r, fiche: d.fiche });
	}
	if (r0 === "retours" && r1 === "serie" && seg.length === 2 && m === "POST") {
		ecrire();
		const corpsSerie = await lireJson(req, 4 * MAX_CORPS);
		if (a.role === "testeur") { const l = (corpsSerie as { retours?: unknown })?.retours; plafondApp(a, "retours", Array.isArray(l) ? l.length : 1); }
		const serie = await creerSerie(depot, a, corpsSerie, diffuseur(ctx));
		// Étape 3.9, G3 : réglage « traitement_serie » : l'envoi d'une série lance « Traiter les retours », si un veilleur est
		// connecté, qu'aucune demande n'est active et que l'auteur de la série peut lancer un traitement. Sinon, rien.
		let demande: { id: string } | null = null;
		if (lireReglages(depot).traitement_serie && veilleurs(ctx, projet).length) {
			try { demande = { id: creerDemande(ctx, projet, depot, a, "", "envoi d'une série").id }; } catch { demande = null; }
		}
		return json(res, 201, { ...serie, demande });
	}
	if (r0 === "retours" && r1 === "batch" && seg.length === 2 && m === "POST") {
		ecrire();
		return json(res, 200, await batch(depot, a, await lireJson(req), diffuseur(ctx)));
	}
	if (r0 === "retours" && seg.length === 2 && r1 !== "batch" && m === "PATCH") {
		ecrire();
		if (!ID_RETOUR.test(r1)) { await lireCorps(req, MAX_CORPS).catch(() => { }); throw absent("retour introuvable (id invalide)"); }
		return json(res, 200, await modifier(depot, a, r1, await lireJson(req), diffuseur(ctx)));
	}
	if (r0 === "retours" && seg.length === 2 && r1 !== "batch" && m === "DELETE") {
		ecrire();
		await supprimer(depot, a, r1, params.get("version"), diffuseur(ctx));
		return json(res, 204);
	}
	// Étape 3.9, R6 : « Moi aussi » (POST { version }) ou plus concerné (DELETE ?version=).
	if (r0 === "retours" && seg.length === 3 && r2 === "aussi" && (m === "POST" || m === "DELETE")) {
		ecrire();
		const version = m === "POST" ? ((await lireJson(req)) as { version?: unknown } | null)?.version : params.get("version");
		return json(res, 200, await aussi(depot, a, r1, version, m === "POST", diffuseur(ctx)));
	}
	// Étape 3.9, R5 : fusion de doublons dans le retour r1 ({ version, doublons: [{ id, version }] }).
	if (r0 === "retours" && seg.length === 3 && r2 === "fusionner" && m === "POST") {
		ecrire();
		const r = await fusionner(depot, a, r1, await lireJson(req), new Date().toISOString(), diffuseur(ctx));
		journaliser(ctx, a, "retours fusionnés", projet, r1, { doublons: r.versions.length - 1 });
		return json(res, 200, r);
	}
	// Étape 3.9, I4 : exports (retours, tickets, approbations : tout membre ; journal : mainteneur ou admin, en session).
	if (r0 === "export" && seg.length === 2 && m === "GET") {
		const x = /^(retours|tickets|journal|approbations)\.(csv|json)$/.exec(r1 || "");
		if (!x) throw absent("export inconnu (retours, tickets, journal ou approbations ; .csv ou .json)");
		const [, quoi, fmt] = x;
		if (quoi === "journal" && (a.agent || (a.role !== "mainteneur" && a.role !== "admin"))) throw new ErreurApi(403, "permission_denied", "le journal d'audit s'exporte par un mainteneur ou un admin");
		const [cols, lignes] = quoi === "retours" ? [COLONNES_RETOURS, lignesRetours(ctx.base, depot, ctx.racineProjets, projet)]
			: quoi === "tickets" ? [COLONNES_TICKETS, lignesTickets(ctx.base, depot)]
				: quoi === "journal" ? [COLONNES_JOURNAL, lignesJournal(ctx.base, projet)]
					: [COLONNES_APPROBATIONS, approbations(ctx.base, depot, ctx.racineProjets, projet)];
		const nom = `${projet}-${quoi}-${new Date().toISOString().slice(0, 10)}.${fmt}`;
		const corps = fmt === "csv" ? csv(cols, lignes) : JSON.stringify({ projet, export: quoi, quand: new Date().toISOString(), lignes }, null, 1);
		res.writeHead(200, { ...ENTETES_COMMUNS, "Cache-Control": "no-store", "Content-Type": fmt === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${nom}"` });
		return void res.end(corps);
	}
	// Étape 3.9, E5 : approbations nominatives (pour la ligne « Approuvé par … » des points « À valider » du Wiki).
	if (r0 === "approbations" && seg.length === 1 && m === "GET") return json(res, 200, { approbations: approbations(ctx.base, depot, ctx.racineProjets, projet) });
	// Étape 3.9, écart 31 : noms affichés des membres du projet, lisibles par tout membre (jamais d'e-mail). Un id
	// d'auteur, de « Moi aussi » ou de « pour » qui n'est plus membre : son nom s'il est admin, sinon « ancien membre ».
	if (r0 === "noms" && seg.length === 1 && m === "GET") {
		const noms: Record<string, string> = {};
		// Étape 3.9, E2 : un testeur externe se reconnaît à son nom (ses retours viennent de l'extérieur, à modérer).
		for (const x of ctx.base.membres(projet)) noms[x.compte] = x.desactive ? "ancien membre" : x.role === "testeur" ? `${x.nom} (testeur externe)` : x.nom;
		for (const d of depot.index.values()) for (const k of [d.donnees.by, d.donnees.pour, ...String(d.donnees.aussi ?? "").split(" ")]) {
			const s = String(k ?? "");
			if (!s || noms[s] !== undefined) continue;
			const c = ctx.base.compte(s);
			noms[s] = c && c.admin && !c.desactive ? c.nom : "ancien membre";
		}
		return json(res, 200, { noms });
	}
	if (r0 === "builds" && seg.length === 1 && m === "POST") {
		if (!["agent", "mainteneur", "admin", "publieur"].includes(a.role)) throw new ErreurApi(403, "permission_denied", "seuls un agent, un publieur, un mainteneur ou un admin publient un build");
		const corps = await lireCorps(req, MAX_BUILD);
		const r = await construire(ctx.racineProjets, ctx.config.site, projet, corps, () => retoursOuverts(depot.index));
		ctx.journal(`build ${r.build} du projet ${projet} (${r.octets} octets) par ${ligne(a.nom)}`);
		ctx.notifieur.build(projet, r.build);
		// Étape 3.9, A3 : rétention des builds (WDD_BUILDS_GARDER), jamais ceux que cite un retour ouvert.
		const ouverts = new Set([...depot.index.values()].filter(d => ["nouveau", "pris", "question"].includes(String(d.donnees.status))).map(d => String(d.donnees.codex ?? "")).filter(Boolean));
		const retires = appliquerRetention(ctx.racineProjets, projet, ctx.config.buildsGarder, ouverts);
		if (retires.length) ctx.journal(`rétention : builds ${retires.join(", ")} du projet ${projet} supprimés`);
		return json(res, 201, r);
	}
	// Étape 2 : dernier build (pour « outil statut »), notes, import.
	if (r0 === "builds" && seg.length === 1 && m === "GET") {
		// Étape 3.9, L3 : ?tous=1 ajoute la liste des builds gardés (numéro, dates, résumé).
		return json(res, 200, { dernier: infoDernierBuild(ctx.racineProjets, projet, ctx.config.site), page: `${ctx.urlPublique(req)}/p/${projet}/`, ...(params.get("tous") === "1" ? { builds: listerBuilds(ctx.racineProjets, projet) } : {}) });
	}
	// Étape 3.6 (§ A.1, « outil apercu ») : la page d'un build telle que le serveur la sert à l'appelant (enveloppe,
	// bandeau, fins de ligne LF) et la CSP qu'il poserait sur elle. En JSON, jamais en text/html : ouverte par un
	// navigateur connecté, la page s'exécuterait sinon sur l'origine de la méta-interface, ce qu'évite WDD_URL_PAGES.
	// Hôte principal seulement (routeurPages ne la laisse pas passer) ; même accès que GET /builds : un jeton d'agent
	// l'obtient dans les deux modes (un seul hôte, ou WDD_URL_PAGES).
	if (r0 === "builds" && seg.length === 3 && r2 === "page" && m === "GET") {
		const fichier = /^[1-9]\d{0,8}$/.test(r1) ? path.join(dossierBuilds(ctx.racineProjets, projet), r1, "page.html") : "";
		if (!fichier || !fs.existsSync(fichier)) throw absent("build introuvable");
		const page = normaliserLf(envelopper(fs.readFileSync(fichier, "utf8"), projet, teteWiki(ctx, projet, a), Number(r1)));
		return json(res, 200, { build: Number(r1), html: page, csp: cspPour(page) });
	}
	if (r0 === "notes" && seg.length === 1 && m === "GET") return json(res, 200, listerNotes(depot));
	if (r0 === "notes" && seg.length === 2 && m === "GET") {
		const brut = lireNotes(depot, r1);
		res.writeHead(200, { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(brut) });
		return void res.end(brut);
	}
	if (r0 === "notes" && seg.length === 2 && m === "PUT") {
		ecrire();
		if (!["agent", "mainteneur", "admin"].includes(a.role)) throw new ErreurApi(403, "permission_denied", "seuls un agent, un mainteneur ou un admin écrivent des notes");
		const remplacer = params.get("remplacer") === "1";
		const r = await ecrireNotes(depot, ctx.config.site, auteurDe(a), r1, await lireJson(req), remplacer, ctx.journal);
		if (!r.inchange) ctx.journal(`notes ${r.nom} du projet ${projet} par ${ligne(a.nom)}`);
		return json(res, r.cree ? 201 : 200, r);
	}
	if (r0 === "import" && seg.length === 1 && m === "POST") {
		ecrire();
		if (a.role !== "mainteneur" && a.role !== "admin") throw new ErreurApi(403, "permission_denied", "seuls un mainteneur ou un admin importent des retours");
		const r = await importer(depot, a, await lireJson(req, MAX_IMPORT_OCTETS), diffuseur(ctx));
		ctx.journal(`import du projet ${projet} par ${ligne(a.nom)} : ${r.importes.length} importés, ${r.ignores.length} ignorés, ${r.refuses.length} refusés`);
		return json(res, 200, r);
	}

	// --- Étape 3.5 (§ 2.1) : un jeton se révoque lui-même (fin d'un import ponctuel, déconnexion d'un poste) -------
	// Bearer seulement : une session révoque par DELETE …/jetons/<id> (gestion.ts). Absente de l'hôte des pages (404).
	if (r0 === "jeton" && seg.length === 1 && m === "DELETE") {
		if (id.type !== "agent") throw new ErreurApi(403, "permission_denied", "réservé à un jeton d'agent (Authorization: Bearer), qui se révoque lui-même");
		ctx.base.revoquerJeton(id.jetonId);
		ctx.flux.reverifier(); // ses flux ouverts sont coupés tout de suite
		ctx.journal(`jeton révoqué par lui-même : ${id.jetonId} sur ${projet}`);
		journaliser(ctx, a, "jeton révoqué", projet, id.jetonId, { nom: id.nom, par: "lui-même" });
		return json(res, 204);
	}

	// --- Étape 3.9, L7 : tickets qui citent des éléments (champ pages), pour les fiches du Wiki. Projection en lecture
	// seule (id, titre, statut, pages, lien vers le ticket dans la méta-interface de l'hôte principal).
	if (r0 === "tickets-fiches" && seg.length === 1 && m === "GET") {
		const base = pages ? ctx.config.url : "";   // WDD_URL, déjà sans « / » final (config.ts)
		const tickets: { id: string; titre: string; statut: string; pages: string[]; lien: string }[] = [];
		for (const d of depot.instantaneTickets(undefined, false).docs) {
			if (!("donnees" in d)) continue;
			const t = d.donnees as { titre?: unknown; statut?: unknown; pages?: unknown };
			if (!Array.isArray(t.pages) || !t.pages.length) continue;
			tickets.push({ id: d.id, titre: String(t.titre ?? ""), statut: String(t.statut ?? ""), pages: t.pages.map(String), lien: `${base}/#/p/${projet}/t/${d.id}` });
		}
		return json(res, 200, { tickets });
	}
	// --- Étape 3.9, I3 : réglage du webhook entrant de la forge (mainteneur, en session).
	if (r0 === "forge" && seg.length === 1) {
		if (m !== "GET") verifierCsrf(req, ctx.config);
		if (m === "POST" || m === "DELETE") await lireCorps(req, MAX_CORPS).catch(() => { });
		const r = routeConfigForge(ctx.base, a, projet, m, ctx.urlPublique(req));
		return json(res, r.statut, r.corps);
	}
	// --- Étape 3 : tickets (§ 3.1), sessions et jetons selon § 1.3 ---------------------------------------------
	if (r0 === "tickets") {
		const tc: ContexteTickets = {
			depot, a,
			disciplines: () => nomsDisciplines(depot),
			diffuser: retoursAussi => {
				if (retoursAussi) ctx.flux.diffuser(projet, depot.instantane());
				ctx.flux.diffuserTickets(projet, depot.instantaneTickets());
			},
			journaliser: (action, cible, detail) => journaliser(ctx, a, action, projet, cible, detail),
		};
		const ecrireTicket = () => ctx.modes.verifierEcriture(projet);
		if (seg.length === 1 && m === "GET") return json(res, 200, listerTickets(depot, a, params));
		if (seg.length === 1 && m === "POST") { ecrireTicket(); return json(res, 201, await creerTicket(tc, await lireJson(req))); }
		if (seg.length >= 2 && !ID_TICKET.test(r1)) { await lireCorps(req, MAX_CORPS).catch(() => { }); throw absent("ticket introuvable (id T-<n> attendu)"); }
		if (seg.length === 2 && m === "GET") {
			const e = depot.tickets.get(r1);
			if (!e) throw absent("ticket introuvable");
			return json(res, 200, estIllisible(e) ? { id: r1, illisible: true, erreur: e.erreur } : { id: r1, version: e.version, donnees: e.donnees });
		}
		if (seg.length === 3 && r2 === "historique" && m === "GET") return json(res, 200, await historiqueTicket(depot, r1));
		if (seg.length === 2 && m === "PATCH") { ecrireTicket(); return json(res, 200, await modifierTicket(tc, r1, await lireJson(req))); }
		if (seg.length === 2 && m === "DELETE") { ecrireTicket(); await supprimerTicket(tc, r1, params.get("version")); return json(res, 204); }
		if (seg.length === 3 && m === "POST") {
			ecrireTicket();
			if (r2 === "prendre" || r2 === "rendre" || r2 === "rouvrir") return json(res, 200, await changerEtat(tc, r1, r2, await lireJson(req)));
			if (r2 === "commits") return json(res, 200, await ajouterCommits(tc, r1, await lireJson(req)));
			if (r2 === "fermer") return json(res, 200, await fermerTicket(tc, r1, await lireJson(req)));
		}
		throw absent("route inconnue");
	}
	// --- Étape 3.5 (§ 5.2) : demandes de traitement et veilleurs (demandes.ts) ---------------------------------
	if (await routeDemandes(ctx, req, res, projet, depot, a, seg, m)) return;
	// --- Étape 3 : membres, invitations, jetons, réglages (§ 3.2, sessions seulement) ---------------------------
	if (await routeNotifications({ base: ctx.base, notifieur: ctx.notifieur, config: ctx.config }, req, res, projet, id, a, seg, m,
		{ json, lireJson: r => lireJson(r), corpsVide, trace: (action, detail) => ctx.base.journaliser({ qui: a.id, action, projet, cible: "notifications", detail }) })) return;
	if (await routeGestion(ctx, req, res, projet, depot, id, a, seg, m)) return;
	throw absent("route inconnue");
}

// --- Page du projet ---------------------------------------------------------------------------------------
// Étape 3.9, E4 : GET /api/moi/sessions (mes sessions), DELETE /api/moi/sessions/<id> (en fermer une, même la
// courante). Session de l'hôte principal seulement ; fermeture journalisée, sans jamais de secret.
function mesSessions(ctx: Contexte, req: IncomingMessage, res: ServerResponse, reste: string[], m: string): void {
	if (m !== "GET") verifierCsrf(req, ctx.config);
	const id = identifier(req, ctx.base);
	if (id.type === "agent") throw new ErreurApi(403, "permission_denied", "réservé aux sessions");
	if (id.type !== "compte") throw new ErreurApi(401, "revoked", "session requise");
	const courant = valeursCookie(req, COOKIE)[0] || "";
	if (!reste.length && m === "GET") return json(res, 200, { sessions: ctx.base.sessionsDe(id.compte.id, courant) });
	if (reste.length === 1 && m === "DELETE") {
		if (!ctx.base.fermerSession(id.compte.id, reste[0])) throw absent("session introuvable");
		ctx.base.journaliser({ qui: id.compte.id, action: "session fermée", cible: reste[0], detail: { par: "lui-même" } });
		return json(res, 204);
	}
	throw absent("route inconnue");
}

// Page « invitation requise ». Hôte principal : le cookie SameSite=Strict n'est pas envoyé quand on arrive d'un autre
// site (lien dans une messagerie) ; la page se recharge une fois d'elle-même (navigation interne, le cookie part
// alors), puis s'arrête. Hôte des pages : renvoi vers l'hôte principal (qui redonne un jeton d'entrée), au plus une fois
// par minute dans l'onglet, pour ne jamais boucler si le navigateur refuse le cookie ; sinon un lien.
function page401(ctx: Contexte, res: ServerResponse, projet: string, params: URLSearchParams, pages: boolean, raison = ""): void {
	if (pages) {
		const cible = `${ctx.config.url}/p/${projet}/`;
		// Étape 3.9, L8 : l'ancre (#onglet--element d'un lien copié) suit le passage par l'hôte principal ; les redirections
		// HTTP qui suivent la gardent d'elles-mêmes. Seul le fragment est ajouté, derrière une adresse fixe.
		const script = `<script>try{var t=+(sessionStorage.getItem("wdd_entree")||0);if(Date.now()-t>60000){sessionStorage.setItem("wdd_entree",String(Date.now()));location.replace(${JSON.stringify(cible)}+location.hash);}}catch(e){}</script>`;
		return html(res, 401, pageSimple("Entrée requise", `<p>${raison ? esc(raison) + " " : ""}Ce Wiki s'ouvre depuis le serveur principal.</p><p><a href="${esc(cible)}">Ouvrir le Wiki</a></p>${raison ? "" : script}`));
	}
	const relance = params.get("wdd_r") === "1" ? "" : `<script>location.replace(location.pathname + "?wdd_r=1" + location.hash);</script>`;
	html(res, 401, pageSimple("Invitation requise", `<p>Ce Wiki est privé. Ouvre le lien d'invitation que tu as reçu pour y accéder. Session expirée : demande un lien de reconnexion à un mainteneur du projet.</p>${relance}`));
}

// Étape 3.9, L3 : version = un numéro de build gardé (page en lecture seule), ou « liste » (les versions gardées).
async function pageProjet(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, params: URLSearchParams, pages: boolean, version?: number | "liste"): Promise<void> {
	let id: Identite;
	try { id = pages ? identifierPages(req, ctx.base, projet) : identifier(req, ctx.base); } catch { id = { type: "aucun", cookie: false }; }
	// Sans session, on ne dit pas si le projet existe : 401 d'abord.
	if (id.type !== "aucun" && !ctx.depots.has(projet)) return html(res, 404, pageInconnu(pages ? ctx.config.url : ""));
	let a: Acteur;
	try { a = acteur(id, ctx.base, projet); } catch (e) {
		if (e instanceof ErreurApi && e.statut === 403) return html(res, 403, pageSimple("Accès refusé", "<p>Ton compte n'a pas accès à ce projet. Demande une invitation à un administrateur.</p>"));
		return page401(ctx, res, projet, params, pages);
	}
	// Étape 3.9 : un jeton qui ne lit rien (« retour » d'une application) n'ouvre pas le Wiki.
	if (a.role === "retour") return html(res, 403, pageSimple("Accès refusé", "<p>Ce jeton sert seulement à envoyer des retours depuis une application.</p>"));
	const titre = ctx.base.projet(projet)?.titre || projet;
	const tete = teteWiki(ctx, projet, a);
	const n = dernierBuild(ctx.racineProjets, projet);
	if (!n) {
		// Projet neuf : c'est l'écran où l'on arrive (titre du projet à l'Accueil, lien de l'Administration), au moment où
		// aucun agent n'est encore branché. Un mainteneur ou un admin (pas un jeton) y trouve donc le bloc « Brancher un
		// dépôt de code » du Kanban (branchement.js) : même phrase, adresse de l'hôte principal (celle que donne
		// /api/moi : WDD_URL, ou déduite de Host), sans script.
		const brancher = !a.agent && (a.role === "mainteneur" || a.role === "admin")
			? `<h2>Brancher un dépôt de code</h2><p>Dis à ton agent de code (Claude Code, Codex…), ouvert dans le dossier du dépôt :</p>` +
			`<p id="phrase-branchement"><code>${esc(phraseBranchement(ctx.urlPublique(req), projet))}</code></p>` +
			`<p>Il faut la CLI « outil » dans le PATH du poste du code : l'installeur Windows (installer.cmd) l'y ajoute.</p>` : "";
		return html(res, 404, pageSimple("Wiki pas encore publié", `<p>Le Wiki du projet « ${esc(titre)} » n'est pas encore publié : l'agent du projet le publie avec <code>outil publier</code> (API : <code>POST /api/p/${esc(projet)}/builds</code>). Les onglets Retours et Kanban sont déjà ouverts.</p>${brancher}`, tete));
	}
	if (version === "liste" && a.role !== "testeur") {
		const l = listerBuilds(ctx.racineProjets, projet);
		const date = (s: string) => s ? new Date(s).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" }) : "";
		const lignes = l.map(b => `<li><a href="${b.build === n ? "../" : b.build + "/"}">Build ${b.build}</a>${b.build === n ? " (dernier)" : ""} · publié le ${esc(date(b.date))}${b.donnees ? ` · données du ${esc(date(b.donnees))}` : ""}${b.resume ? `<br><small>${esc(b.resume)}</small>` : ""}</li>`).join("");
		return html(res, 200, pageSimple("Versions du Wiki", `<p>Les versions gardées du Wiki de « ${esc(titre)} », la plus récente d'abord. Une ancienne version se lit sans pouvoir y écrire de retour.</p><ul class="versions">${lignes}</ul>`, tete));
	}
	// Étape 3.9, E2 : un testeur ne lit que la dernière version, réduite à ses onglets (page construite pour lui).
	if (a.role === "testeur") {
		if (version !== undefined) return html(res, 403, pageSimple("Accès refusé", "<p>Seule la dernière version du Wiki t'est ouverte.</p><p><a href=\"../\">Dernière version</a></p>", tete));
		const t = ctx.base.restriction(a.id, projet);
		let p: string | null = null;
		try { p = await pageAudience(ctx.racineProjets, ctx.config.site, projet, n, t ? t.onglets : []); }
		catch { return html(res, 500, pageSimple("Wiki indisponible", "<p>La page n'a pas pu être préparée. Réessaie dans un moment, ou préviens l'équipe.</p>", tete)); }
		if (p === null) return html(res, 200, pageSimple("Rien à montrer pour le moment", "<p>Les onglets du Wiki qui te sont ouverts ne sont pas dans la version publiée. Préviens l'équipe qui t'a invité.</p>", tete));
		return html(res, 200, envelopper(p, projet, tete, n, false, true));
	}
	const voulu = typeof version === "number" ? version : n;
	const fichier = path.join(dossierBuilds(ctx.racineProjets, projet), String(voulu), "page.html");
	if (!Number.isInteger(voulu) || voulu < 1 || !fs.existsSync(fichier)) return html(res, 404, pageSimple("Version introuvable", `<p>Le build ${esc(String(voulu))} n'est pas (ou plus) gardé. <a href="../">Toutes les versions</a></p>`, tete));
	const page = fs.readFileSync(fichier, "utf8");
	const ancien = voulu !== n;
	const avis = ancien ? `<p class="wdd-ancienne" role="note">Ancienne version : build ${voulu}, en lecture seule. <a href="../../">Dernière version</a> · <a href="../">Toutes les versions</a></p>` : "";
	html(res, 200, envelopper(page, projet, tete + avis, voulu, ancien));
}

// Bandeau commun du Wiki (étape 3.6, § A.2) pour cet appelant : liens vers la méta-interface de l'hôte principal
// (bandeau.ts). Le même sur la page servie et dans l'aperçu (GET /api/p/<projet>/builds/<n>/page).
// Compteurs des onglets (lot B) : ceux de la méta-interface, lus dans le dépôt chargé au moment de servir la page.
function teteWiki(ctx: Contexte, projet: string, a: Acteur): string {
	const titre = ctx.base.projet(projet)?.titre || projet;
	const d = ctx.depots.get(projet);
	let retours = 0, questions = 0, aFaire = 0;
	if (a.role === "testeur") return bandeau({ projet, titre, nom: a.nom, role: a.role, agent: a.agent, base: ctx.config.urlPages ? ctx.config.url : "", testeur: true });
	if (d) {
		for (const x of d.index.values()) { if (x.donnees.status === "nouveau") retours++; else if (x.donnees.status === "question") { retours++; questions++; } }
		for (const t of d.tickets.values()) if (!estIllisible(t) && t.donnees.statut === "a-faire") aFaire++;
	}
	return bandeau({ projet, titre, nom: a.nom, role: a.role, agent: a.agent, base: ctx.config.urlPages ? ctx.config.url : "", retours, questions, aFaire });
}

function etatSauvegardePublic(ctx: Contexte) {
	const e = ctx.sauvegarde;
	return { dossier: e.dossier, heures: e.heures, garder: e.garder, en_cours: e.enCours, derniere: e.derniere };
}

// Projet inconnu (404) : un lien vers l'Accueil, sur l'hôte principal (base : WDD_URL depuis l'hôte des pages, sinon « »).
function pageInconnu(base: string): string {
	return pageSimple("Projet introuvable", `<p>Ce projet n'existe pas, ou son adresse a changé.</p><p><a href="${esc(base + "/")}">Retour à l'accueil</a></p>`);
}

// Hôte principal avec WDD_URL_PAGES : plus de page construite ici. Un compte qui a accès au projet reçoit un jeton
// d'entrée (60 s, usage unique, lié au compte et au projet) et part vers l'hôte des pages (303).
// Étape 3.9, L3 : [« p », projet, « b », « »] → « liste » ; [« p », projet, « b », n, « »] → n ; sinon undefined.
function versionDe(seg: string[]): number | "liste" | undefined {
	if (seg[2] !== "b") return undefined;
	if (seg.length === 4 && seg[3] === "") return "liste";
	if (seg.length === 5 && seg[4] === "" && /^[1-9][0-9]{0,8}$/.test(seg[3])) return Number(seg[3]);
	return undefined;
}
const versionEnParam = (v: number | "liste" | undefined): string => v === undefined ? "" : `&b=${v}`;
const versionDeParam = (b: string | null): string => b === "liste" ? "b/" : b && /^[1-9][0-9]{0,8}$/.test(b) ? `b/${b}/` : "";
function versHotePages(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, params: URLSearchParams, version?: number | "liste"): void {
	let id: Identite;
	try { id = identifier(req, ctx.base); } catch { id = { type: "aucun", cookie: false }; }
	if (id.type !== "aucun" && !ctx.depots.has(projet)) return html(res, 404, pageInconnu(""));
	try { acteur(id, ctx.base, projet); } catch (e) {
		if (e instanceof ErreurApi && e.statut === 403) return html(res, 403, pageSimple("Accès refusé", "<p>Ton compte n'a pas accès à ce projet. Demande une invitation à un administrateur.</p>"));
		return page401(ctx, res, projet, params, false);
	}
	if (id.type !== "compte") return html(res, 403, pageSimple("Accès refusé", "<p>Le Wiki s'ouvre avec un compte, pas avec un jeton d'agent.</p>"));
	const jeton = ctx.base.creerEntree(id.compte.id, projet);
	res.writeHead(303, { ...ENTETES_COMMUNS, Location: `${ctx.config.urlPages}/p/${projet}/?entree=${encodeURIComponent(jeton)}${versionEnParam(version)}` });
	res.end();
}

// Hôte des pages : échange du jeton d'entrée contre le cookie wdd_pages (limité au projet), puis redirection sans le
// paramètre ; sans paramètre, la page du projet pour la session wdd_pages.
async function pagesEntree(ctx: Contexte, req: IncomingMessage, res: ServerResponse, projet: string, params: URLSearchParams): Promise<void> {
	const entree = params.get("entree");
	if (entree === null) return await pageProjet(ctx, req, res, projet, params, true);
	const r = /^[A-Za-z0-9_-]{20,100}$/.test(entree) ? ctx.base.consommerEntree(entree) : undefined;
	if (!r || r.projet !== projet) return page401(ctx, res, projet, params, true, "Lien d'entrée expiré ou déjà utilisé.");
	const compte: Compte | undefined = ctx.base.compte(r.compte);
	if (!compte || !ctx.base.roleSur(compte, projet)) return html(res, 403, pageSimple("Accès refusé", "<p>Ton compte n'a plus accès à ce projet.</p>"));
	const s = ctx.base.creerSessionPages(compte.id, projet);
	res.writeHead(303, { ...ENTETES_COMMUNS, Location: `/p/${projet}/${versionDeParam(params.get("b"))}`, "Set-Cookie": cookiesPages(ctx.config, projet, s.jeton, s.maxAge) });
	res.end();
}

function accueil(ctx: Contexte, req: IncomingMessage, res: ServerResponse): void {
	let id: Identite;
	try { id = identifier(req, ctx.base); } catch { id = { type: "aucun", cookie: false }; }
	if (id.type !== "compte") return html(res, 401, pageSimple("Retours", "<p>Accès sur invitation : ouvre le lien que tu as reçu.</p>"));
	const ps = ctx.base.projetsDe(id.compte);
	const liste = ps.length ? `<ul>${ps.map(p => `<li><a href="/p/${esc(p.id)}/">${esc(p.titre)}</a> <code>${esc(p.id)}</code></li>`).join("")}</ul>` : "<p>Aucun projet pour l'instant.</p>";
	const admin = id.compte.admin ? `<p>Administration : API <code>/api/admin/…</code> (voir serveur/README.md).</p>` : "";
	html(res, 200, pageSimple("Retours", `<p>Connecté : ${esc(id.compte.nom)}</p>${liste}${admin}`));
}

// --- Invitations ------------------------------------------------------------------------------------------
// GET : formulaire (nom affiché). POST : compte créé, session posée, redirection vers /p/<projet>/ (ou / pour un admin).
// Le POST est authentifié par le jeton d'invitation lui-même, pas par un cookie : il n'exige pas X-WDD (un
// formulaire HTML ne peut pas l'envoyer), mais refuse un Origin d'un autre site.
async function invitation(ctx: Contexte, req: IncomingMessage, res: ServerResponse, jeton: string, m: string): Promise<void> {
	const inv = /^[A-Za-z0-9_-]{20,100}$/.test(jeton) ? ctx.base.invitation(jeton) : undefined;
	if (inv?.compte_cible) return await reconnexion(ctx, req, res, jeton, inv, m);
	if (m === "GET" || m === "HEAD") {
		if (!inv) return html(res, 404, pageSimple("Invitation invalide", "<p>Ce lien d'invitation n'est plus valable (déjà utilisé, expiré ou inconnu). Demande un nouveau lien.</p>"));
		const ou = inv.projet ? `au projet « ${esc(ctx.base.projet(inv.projet)?.titre || inv.projet)} » (${esc(inv.role)})` : "comme administrateur";
		// Le POST répond 303 vers /p/<projet>/, qui renvoie vers l'hôte des pages (WDD_URL_PAGES). Chromium applique
		// form-action à toute la chaîne de redirections : sans cette origine, la navigation était bloquée (compte créé,
		// personne restée sur le formulaire). Seulement sur cette page.
		return html(res, 200, pageSimple("Invitation", `<p>Tu es invité ${ou}. Choisis le nom affiché avec tes retours.</p>` +
			`<form method="post"><p><label>Nom affiché <input name="nom" required maxlength="60" autofocus></label></p><p><button>Entrer</button></p></form>`), {}, inv.projet ? ctx.config.urlPages : "");
	}
	if (m !== "POST") throw absent("route inconnue");
	verifierOrigine(req, ctx.config);
	// Jeton inconnu : 404 tout de suite, sans attendre un corps (qu'un client lent n'enverrait jamais).
	if (!inv) { req.resume(); throw new ErreurApi(404, "not_found", "invitation invalide (déjà utilisée, expirée ou inconnue)"); }
	let b: string;
	try { b = utf8(await lireCorps(req, 16 * 1024)); } catch (e) { throw e instanceof ErreurApi ? e : invalide("corps : UTF-8 attendu"); }
	let nom: unknown;
	if (String(req.headers["content-type"] || "").includes("application/json")) { try { nom = (JSON.parse(b) || {}).nom; } catch { nom = undefined; } }
	else nom = new URLSearchParams(b).get("nom");
	const n = validerNom(nom);
	const r = ctx.base.accepterInvitation(jeton, n);
	if (!r) throw new ErreurApi(404, "not_found", "invitation invalide (déjà utilisée, expirée ou inconnue)");
	const s = ctx.base.creerSession(r.compte.id, resumeNavigateur(req.headers["user-agent"]));
	ctx.journal(`invitation acceptée : compte ${r.compte.id} (${r.compte.nom})${r.projet ? " sur " + r.projet : " admin"}`);
	ctx.base.journaliser({ qui: r.compte.id, action: "invitation utilisée", projet: r.projet || "", cible: r.invitation, detail: { role: r.role } });
	ctx.base.journaliser({ qui: r.compte.id, action: r.role === "admin" ? "admin donné" : "rôle donné", projet: r.projet || "", cible: r.compte.id, detail: { role: r.role, par: "invitation" } });
	ctx.verifierLienAdmin();
	res.writeHead(303, { ...ENTETES_COMMUNS, Location: r.projet ? `/p/${r.projet}/` : "/", "Set-Cookie": cookieSession(ctx.config, s.jeton, s.maxAge) });
	res.end();
}

// Lien de reconnexion (étape 3.5, § 2.4), même adresse qu'une invitation (/invitation/<jeton>). GET : une page avec
// le nom du compte et un bouton, sans champ ; il ne consomme rien (un aperçu de lien dans une messagerie grillerait
// sinon un lien à usage unique). POST (le bouton) : consomme le lien, donne une session au compte existant, 303 vers
// « / » (la méta-interface). Compte désactivé, ou lien de projet qui ne vaut plus (Base.refusReconnexion : compte
// nommé admin, retiré du projet, créateur qui ne gère plus tous ses projets) : refusé (403), le lien n'est pas consommé.
async function reconnexion(ctx: Contexte, req: IncomingMessage, res: ServerResponse, jeton: string, inv: Invitation, m: string): Promise<void> {
	const compte = inv.compte_cible ? ctx.base.compte(inv.compte_cible) : undefined;
	if (m === "GET" || m === "HEAD") {
		if (!compte) return html(res, 404, pageSimple("Lien invalide", "<p>Ce lien de reconnexion n'est plus valable. Demande un nouveau lien.</p>"));
		if (compte.desactive) return html(res, 403, pageSimple("Compte désactivé", "<p>Ce compte est désactivé : le lien de reconnexion ne peut pas servir. Demande à un administrateur.</p>"));
		if (ctx.base.refusReconnexion(inv, compte)) return html(res, 403, pageSimple("Lien refusé", "<p>Les droits de ce compte ont changé depuis la création du lien : il ne peut plus servir. Demande un nouveau lien à un administrateur.</p>"));
		return html(res, 200, pageSimple("Reconnexion", `<p>Lien de reconnexion pour <strong>${esc(compte.nom)}</strong> : il ouvre une session dans ce navigateur, une seule fois.</p>` +
			`<form method="post"><p><button autofocus>Entrer en tant que ${esc(compte.nom)}</button></p></form>`));
	}
	if (m !== "POST") throw absent("route inconnue");
	verifierOrigine(req, ctx.config);
	req.resume(); // corps sans objet (formulaire vide)
	const r = ctx.base.utiliserReconnexion(jeton);
	if (r === "desactive") throw new ErreurApi(403, "permission_denied", "compte désactivé : lien de reconnexion refusé");
	if (r && "refus" in r) throw new ErreurApi(403, "permission_denied", "lien de reconnexion refusé : " + r.refus);
	if (!r) throw new ErreurApi(404, "not_found", "lien de reconnexion invalide (déjà utilisé, expiré ou inconnu)");
	const s = ctx.base.creerSession(r.compte.id, resumeNavigateur(req.headers["user-agent"]));
	ctx.journal(`reconnexion : compte ${r.compte.id} (${ligne(r.compte.nom)})`);
	ctx.base.journaliser({ qui: r.compte.id, action: "reconnexion utilisée", projet: r.projet || "", cible: r.invitation });
	ctx.verifierLienAdmin();
	res.writeHead(303, { ...ENTETES_COMMUNS, Location: "/", "Set-Cookie": cookieSession(ctx.config, s.jeton, s.maxAge) });
	res.end();
}

// --- API admin --------------------------------------------------------------------------------------------
export async function creerProjet(ctx: Contexte, id: unknown, titre: unknown, auteur: { nom: string; email: string }): Promise<{ id: string; titre: string; rev: string }> {
	if (typeof id !== "string" || !ID_PROJET.test(id)) throw invalide("id de projet : [a-z0-9-]{1,40}");
	// Noms de périphérique réservés de Windows : le dossier ne peut pas être créé (git init échouerait).
	if (RESERVE_WINDOWS.test(id)) throw invalide(`id de projet réservé par Windows : ${id}`);
	if (typeof titre !== "string" || !titre.trim() || titre.length > 200) throw invalide("titre : 1 à 200 caractères");
	if (ctx.base.projet(id) || ctx.depots.has(id)) throw new ErreurApi(409, "conflict", "ce projet existe déjà");
	const depot = new Depot(id, ctx.racineProjets, ctx.configGit, ctx.journal);
	// Pas de chemin absolu dans la réponse : il est au journal.
	if (fs.existsSync(depot.dossier)) { ctx.journal(`projet ${id} : le dossier existe déjà (${depot.dossier})`); throw new ErreurApi(409, "conflict", "le dossier du projet existe déjà sur le serveur"); }
	try { await depot.creer(titre.trim(), auteur); }
	catch (e) {
		// Rien de créé à moitié : le dossier du dépôt est retiré, la requête peut être refaite.
		ctx.journal(`projet ${id} : création impossible (${(e as Error)?.message || e})`);
		try { fs.rmSync(depot.dossier, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { }
		try { fs.rmdirSync(path.dirname(depot.dossier)); } catch { }
		throw new ErreurApi(503, "unavailable", "création du dépôt impossible, réessaie");
	}
	ctx.base.creerProjet(id, titre.trim());
	ctx.depots.set(id, depot);
	ctx.journal(`projet créé : ${id}`);
	return { id, titre: titre.trim(), rev: depot.rev };
}

async function apiAdmin(ctx: Contexte, req: IncomingMessage, res: ServerResponse, seg: string[], m: string, params: URLSearchParams): Promise<void> {
	verifierCsrf(req, ctx.config);
	const id = identifier(req, ctx.base);
	if (id.type === "aucun") throw new ErreurApi(401, "revoked", "session requise");
	if (id.type !== "compte" || !id.compte.admin) throw new ErreurApi(403, "permission_denied", "réservé aux administrateurs");
	const admin = id.compte;
	const corpsObjet = async (): Promise<Record<string, unknown>> => {
		const c = await lireJson(req);
		if (!c || typeof c !== "object" || Array.isArray(c)) throw invalide("objet JSON attendu");
		return c as Record<string, unknown>;
	};
	const trace = (action: string, projet: string, cible: string, detail?: unknown) => ctx.base.journaliser({ qui: admin.id, action, projet, cible, detail });
	const p = seg.join("/");
	// Étape 3.7, A1 : état de la sauvegarde, et « Sauvegarder maintenant » (une à la fois).
	if (p === "sauvegarde" && m === "GET") return json(res, 200, etatSauvegardePublic(ctx));
	// Étape 3.9, A5 : état du serveur pour l'admin : version, place par projet, dernière sauvegarde, veilleurs connectés,
	// derniers traitements échoués et derniers builds refusés (jetons masqués).
	if (p === "etat" && m === "GET") {
		const projets = ctx.base.projets().map(pr => {
			const place = placeProjet(ctx.racineProjets, pr.id);
			return { id: pr.id, titre: pr.titre, builds: listerBuilds(ctx.racineProjets, pr.id).length, dernier: dernierBuild(ctx.racineProjets, pr.id), place, veilleurs: veilleurs(ctx, pr.id).map(v => ({ nom: v.nom, poste: v.poste, vu: v.vu })) };
		});
		const echecs = (ctx.base.db.prepare("SELECT projet, etat, fini, raison, resume FROM demandes WHERE etat IN ('echouee', 'annulee') ORDER BY fini DESC LIMIT 10").all() as { projet: string; etat: string; fini: string | null; raison: string; resume: string }[])
			.map(d => ({ projet: d.projet, etat: d.etat, quand: d.fini || "", raison: masquer(d.raison).slice(0, 300), resume: masquer(d.resume).slice(0, 300) }));
		return json(res, 200, { version: VERSION_OUTIL, node: process.version, debut: DEBUT_SERVEUR, projets, sauvegarde: etatSauvegardePublic(ctx), traitements_echoues: echecs,
			builds_refuses: echecsBuild.slice(0, 10).map(e => ({ ...e, message: masquer(e.message) })), builds_garder: ctx.config.buildsGarder });
	}
	if (p === "sauvegarde" && m === "POST") {
		await corpsVide(req);
		if (ctx.sauvegarde.enCours) throw new ErreurApi(409, "conflict", "une sauvegarde est déjà en cours");
		try {
			const r = await lancerSauvegarde({ base: ctx.base, depots: ctx.depots, racineProjets: ctx.racineProjets }, ctx.sauvegarde, ctx.journal);
			trace("sauvegarde", "", r.nom, { octets: r.octets, fichiers: r.fichiers });
			return json(res, 201, { ...etatSauvegardePublic(ctx), sauvegarde: { nom: r.nom, fichiers: r.fichiers, octets: r.octets, duree_ms: r.duree_ms } });
		} catch (e) {
			if (e instanceof ErreurApi) throw e;
			throw new ErreurApi(500, "unavailable", "sauvegarde impossible : " + String((e as Error)?.message || e).slice(0, 300));
		}
	}
	if (p === "projets" && m === "GET") {
		return json(res, 200, { projets: ctx.base.projets().map(x => ({ ...x, retours: ctx.depots.get(x.id)?.index.size ?? 0, tickets: ctx.depots.get(x.id)?.tickets.size ?? 0, rev: ctx.depots.get(x.id)?.rev ?? "", build: dernierBuild(ctx.racineProjets, x.id) })) });
	}
	if (p === "projets" && m === "POST") {
		const c = await corpsObjet();
		const r = await creerProjet(ctx, c.id, c.titre, { nom: admin.nom, email: `${admin.id}@wdd.invalid` });
		trace("projet créé", r.id, r.id, { titre: r.titre });
		return json(res, 201, r);
	}
	if (p === "invitations" && m === "POST") {
		const c = await corpsObjet();
		const role = String(c.role ?? "");
		if (![...ROLES_PROJET, "admin"].includes(role)) throw invalide(`role : ${ROLES_PROJET.join(", ")} ou admin`);
		let projet: string | null = null;
		if (role !== "admin") {
			if (typeof c.projet !== "string" || !ctx.base.projet(c.projet)) throw absent("projet introuvable");
			projet = c.projet;
		}
		const expire = validerExpiration(c.expire);
		const inv = ctx.base.nouvelleInvitation(projet, role, expire, admin.id);
		const lien = `/invitation/${inv.jeton}`;
		trace("invitation créée", projet || "", inv.id, { role, expire });
		return json(res, 201, { id: inv.id, lien, url: ctx.urlPublique(req) + lien, projet, role, expire });
	}
	if (p === "invitations" && m === "GET") return json(res, 200, { invitations: ctx.base.invitations() });
	// Annuler toute invitation, admin comprise (celles d'un projet s'annulent aussi par la route du projet).
	if (seg[0] === "invitations" && seg.length === 2 && m === "DELETE") {
		const inv = /^[A-Za-z0-9]{1,40}$/.test(seg[1]) ? ctx.base.invitationParId(seg[1]) : undefined;
		if (!inv) throw absent("invitation introuvable");
		if (inv.etat !== "attente") throw invalide(`invitation déjà ${inv.etat === "utilisee" ? "utilisée" : inv.etat === "annulee" ? "annulée" : "expirée"}`);
		ctx.base.annulerInvitation(inv.id);
		trace("invitation annulée", inv.projet || "", inv.id, { role: inv.role });
		ctx.verifierLienAdmin();
		return json(res, 204);
	}
	if (p === "jetons" && m === "POST") {
		const c = await corpsObjet();
		if (typeof c.projet !== "string" || !ctx.base.projet(c.projet)) throw absent("projet introuvable");
		const nom = validerNom(c.nom);
		const role = c.role === undefined ? "agent" : c.role;
		if (typeof role !== "string" || !(ROLES_JETON as readonly string[]).includes(role)) throw invalide(`role : ${ROLES_JETON.join(" ou ")}`);
		// Propriétaire (§ 1.4) : l'admin qui le crée, sauf « pour » = l'id d'un autre compte (écart serveur 4 de l'étape 3).
		let pour: string = admin.id;
		if (c.pour !== undefined) {
			const pc = typeof c.pour === "string" ? ctx.base.compte(c.pour) : undefined;
			if (!pc || pc.desactive) throw absent("pour : compte introuvable ou désactivé");
			// Un jeton ne vaut jamais plus que son propriétaire (Base.jeton) : refusé d'avance s'il ne vaudrait rien.
			const r = ctx.base.roleSur(pc, c.projet);
			if (!r || r === "lecteur" || r === "testeur") throw invalide("pour : ce compte n'est ni contributeur, ni mainteneur de ce projet, ni admin");
			pour = pc.id;
		}
		const j = ctx.base.creerJeton(c.projet, nom, role as RoleJeton, pour);
		ctx.journal(`jeton ${role} créé : ${j.id} (${ligne(nom)}) sur ${c.projet}`);
		trace("jeton créé", c.projet, j.id, { nom, role, pour });
		return json(res, 201, { id: j.id, jeton: j.jeton, projet: c.projet, nom, role, pour: { id: pour, nom: ctx.base.compte(pour)!.nom } });
	}
	if (seg[0] === "jetons" && seg.length === 2 && m === "DELETE") {
		const info = ctx.base.jetonParId(seg[1]);
		if (!ctx.base.revoquerJeton(seg[1])) throw absent("jeton introuvable ou déjà révoqué");
		ctx.flux.reverifier(); // les flux ouverts avec ce jeton sont coupés tout de suite
		ctx.journal(`jeton d'agent révoqué : ${ligne(seg[1], 40)}`);
		trace("jeton révoqué", info?.projet || "", seg[1], { nom: info?.nom });
		return json(res, 204);
	}
	// --- Étape 3 (§ 3.3) : comptes, journal ---------------------------------------------------------------------
	if (p === "comptes" && m === "GET") return json(res, 200, { comptes: ctx.base.comptes() });
	// Étape 3.9, E4 : un admin ferme toutes les sessions d'un compte (hôte principal et hôte des pages), sans le désactiver.
	if (seg[0] === "comptes" && seg.length === 3 && seg[2] === "sessions" && m === "DELETE") {
		const cible = ctx.base.compte(seg[1]);
		if (!cible) throw absent("compte introuvable");
		const n = ctx.base.sessionsDe(cible.id).length;
		ctx.base.supprimerSessions(cible.id);
		ctx.flux.reverifier();
		trace("sessions fermées", "", cible.id, { sessions: n });
		return json(res, 200, { fermees: n });
	}
	if (seg[0] === "comptes" && seg.length === 3 && seg[2] === "sessions" && m === "GET") {
		const cible = ctx.base.compte(seg[1]);
		if (!cible) throw absent("compte introuvable");
		return json(res, 200, { sessions: ctx.base.sessionsDe(cible.id) });
	}
	if (seg[0] === "comptes" && seg.length === 2 && m === "PATCH") {
		const c = await corpsObjet();
		const cible = ctx.base.compte(seg[1]);
		if (!cible) throw absent("compte introuvable");
		for (const k of Object.keys(c)) if (!["nom", "desactive", "admin"].includes(k)) throw invalide(`clé inconnue : ${k}`);
		if (!Object.keys(c).length) throw invalide("au moins nom, desactive ou admin");
		const champs: { nom?: string; admin?: boolean; desactive?: boolean } = {};
		if (c.nom !== undefined) champs.nom = validerNom(c.nom);
		if (c.desactive !== undefined) { if (typeof c.desactive !== "boolean") throw invalide("desactive : vrai ou faux"); champs.desactive = c.desactive; }
		if (c.admin !== undefined) { if (typeof c.admin !== "boolean") throw invalide("admin : vrai ou faux"); champs.admin = c.admin; }
		// On ne désactive pas, ni ne retire le rôle d'admin, au dernier admin actif.
		const adminActif = cible.admin && !cible.desactive;
		if (adminActif && (champs.desactive === true || champs.admin === false) && ctx.base.adminsActifs() <= 1)
			throw invalide("dernier administrateur actif : ni désactivé ni rétrogradé (nommer d'abord un autre admin)");
		let revoques: string[] = [], annulees: string[] = [];
		ctx.base.transaction(() => {
			ctx.base.modifierCompte(cible.id, champs);
			if (champs.desactive === true) {
				// Désactiver : sessions supprimées (principale et pages), jetons dont il est propriétaire révoqués,
				// invitations en attente qu'il a créées annulées (sinon il reviendrait par son propre lien).
				ctx.base.supprimerSessions(cible.id);
				revoques = ctx.base.revoquerJetonsDe(cible.id);
				annulees = ctx.base.annulerInvitationsDe(cible.id);
				// Étape 3.5 : les liens de reconnexion en attente qui le visent aussi (réactivé, il en faudra un nouveau,
				// comme ses anciens cookies ne reviennent pas).
				for (const i of ctx.base.annulerReconnexionsVers(cible.id)) if (!annulees.includes(i)) annulees.push(i);
			} else if (champs.admin === false && cible.admin) {
				// Plus admin : ses invitations admin, et celles des projets où il n'est pas mainteneur, sont annulées.
				// Ses jetons suivent son rôle (Base.jeton) : sans rôle sur leur projet, ils ne valent plus.
				annulees = ctx.base.annulerInvitationsDe(cible.id, p => p !== null && ctx.base.roleProjet(cible.id, p) === "mainteneur");
			} else if (champs.admin === true && !cible.admin) {
				// Étape 3.5 : nommé admin, les liens de reconnexion qui le visent, créés par la route d'un projet, sont
				// annulés : sinon le mainteneur qui l'a créé entrerait avec une session admin (aussi refusé à l'utilisation,
				// Base.refusReconnexion). Ceux de l'administration et de lien.ts restent.
				annulees = ctx.base.annulerReconnexionsVers(cible.id, null);
			}
		});
		ctx.flux.reverifier();
		ctx.verifierLienAdmin();
		if (champs.desactive === true) trace("compte désactivé", "", cible.id, { jetons_revoques: revoques, invitations_annulees: annulees });
		const autres = { ...champs }; delete autres.desactive;
		if (Object.keys(autres).length || champs.desactive === false)
			trace("compte modifié", "", cible.id, { ...autres, ...(champs.desactive === false ? { reactive: true } : {}), ...(champs.desactive !== true && annulees.length ? { invitations_annulees: annulees } : {}) });
		const apres = ctx.base.comptes().find(x => x.id === cible.id);
		return json(res, 200, { compte: apres, jetons_revoques: revoques, invitations_annulees: annulees });
	}
	// Étape 3.5 (§ 2.4) : lien de reconnexion pour tout compte actif (admin compris, soi-même compris).
	if (seg[0] === "comptes" && seg.length === 3 && seg[2] === "reconnexion" && m === "POST") {
		await corpsVide(req);
		const cible = ctx.base.compte(seg[1]);
		if (!cible) throw absent("compte introuvable");
		if (cible.desactive) throw invalide("compte désactivé : le réactiver d'abord");
		const r = ctx.base.nouvelleReconnexion(cible.id, null, admin.id);
		trace("reconnexion créée", "", cible.id, { invitation: r.id, expire: r.expire });
		return json(res, 201, reponseReconnexion(ctx, req, r, cible, null));
	}
	if (p === "journal" && m === "GET") {
		const av = params.get("avant"), pr = params.get("projet");
		if (av !== null && !/^[1-9]\d{0,15}$/.test(av)) throw invalide("avant : id d'entrée attendu");
		if (pr !== null && !ID_PROJET.test(pr)) throw invalide("projet : id de projet attendu");
		const entrees = ctx.base.lireJournal(av === null ? undefined : Number(av), pr === null ? undefined : pr, 100)
			.map(e => ({ ...e, qui_nom: ctx.base.nomDe(e.qui), pour_nom: e.pour ? ctx.base.nomDe(e.pour) : "", detail: (() => { try { return e.detail ? JSON.parse(e.detail) : null; } catch { return e.detail; } })() }));
		return json(res, 200, { entrees, suivant: entrees.length === 100 ? entrees[99].id : null });
	}
	throw absent("route inconnue");
}
