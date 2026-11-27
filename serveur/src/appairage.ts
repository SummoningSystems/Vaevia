// Appairage d'un poste (étape 3.5, docs/etape3-5-prise-en-main.md § 2.1), sur le modèle de l'autorisation d'appareil
// (RFC 8628, « gh auth login ») : la CLI demande un appairage, l'humain l'autorise dans son navigateur (où il a sa
// session), la CLI vient chercher le jeton. Personne ne voit le jeton, ni l'humain ni l'agent.
//   POST /api/appairage {poste, projet?, role?, usage?}       personne    → 201 {code_appareil, code, expire, intervalle}
//   GET  /api/appairage/<code>                               session     → la demande et les projets que ce compte peut autoriser
//   POST /api/appairage/<code>/autoriser {projet, role, nom?} session     → 204 (journal)
//   POST /api/appairage/<code>/refuser                       session     → 204 (journal)
//   POST /api/appairage/jeton {code_appareil}                personne    → 202 attente | 200 jeton (une fois) | 410 | 429
//   GET  /appairage?code=XXXX-XXXX                           personne    → 303 vers /#/appairage/XXXX-XXXX
// Hôte principal seulement (l'hôte des pages répond 404, routeurPages). Table « appairages » de outil.sqlite, hors de Git.
// Rien de secret n'est gardé en clair : du code d'appareil, seule l'empreinte (SHA-256) est en base ; le jeton n'existe
// pas avant la livraison (il est créé quand la CLI vient le chercher), et n'est jamais écrit ni au journal ni en base.
// Limites : 30 appairages en attente sur le serveur, 60 créations par minute (pas de limite par IP : derrière Docker ou
// un proxy, tout le monde a la même) ; 10 codes inconnus par session et par minute (GET, autoriser, refuser) ; une
// interrogation par intervalle. IP et « même IP » seulement en écoute locale (l'adresse vue y est vraie).
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { Contexte } from "./http.ts";
import type { Compte, RoleJeton } from "./base.ts";
import type { Config } from "./config.ts";
import { hacher, secret, idAleatoire, ROLES_APPAIRAGE as ROLES_JETON, DUREE_JETON_RETOUR_MS } from "./base.ts";
import { estBouclage } from "./config.ts";
import { ErreurApi, invalide, absent, refuse } from "./retours.ts";
import { identifier, verifierCsrf, validerNom, valeursCookie, COOKIE } from "./auth.ts";
import { ID_PROJET, ligne } from "./depot.ts";
import { json, lireJson, ENTETES_COMMUNS } from "./http.ts";
import { corpsVide } from "./gestion.ts";

export const DUREE_APPAIRAGE_MS = 10 * 60 * 1000;     // un appairage vaut 10 min
export const DUREE_PONCTUEL_MS = 3600 * 1000;         // jeton ponctuel : 1 h après sa livraison
export const MAX_EN_ATTENTE = 30;                     // appairages en attente sur le serveur
export const MAX_PAR_MINUTE = 60;                     // créations par minute, sur le serveur
export const MAX_INCONNUS = 10;                       // codes inconnus par session et par minute
const MINUTE_MS = 60 * 1000;
// Code utilisateur : 8 caractères sans ambiguïté (ni I, L, O, 0, 1), présentés XXXX-XXXX.
export const ALPHABET_CODE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const CODE_APPAREIL = /^[A-Za-z0-9_-]{20,100}$/;
export const USAGES = ["permanent", "ponctuel"] as const;

type Ligne = { id: string; code: string; cree: string; expire: string; ip: string; poste: string; projet_demande: string | null; role_demande: string; usage: string;
	etat: string; compte: string | null; projet: string | null; role: string | null; nom: string | null; interroge: string | null };
const COLONNES = "id, code, cree, expire, ip, poste, projet_demande, role_demande, usage, etat, compte, projet, role, nom, interroge";

const estObjet = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const trop = (m: string, code = "quota_exceeded") => new ErreurApi(429, code, m);
const presente = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
// Code saisi ou lu dans l'adresse : majuscules, tiret facultatif ; rend la forme gardée en base (sans tiret), ou null.
export function normaliserCode(s: unknown): string | null {
	if (typeof s !== "string") return null;
	const c = s.trim().toUpperCase();
	return CODE.test(c) ? c.replace("-", "") : null;
}
function tirerCode(): string {
	let s = "";
	while (s.length < 8) for (const b of crypto.randomBytes(16)) if (b < 248 && s.length < 8) s += ALPHABET_CODE[b % 31];
	return s;
}

// Écoute locale : serveur sur une adresse de bouclage, sans WDD_URL ou avec une WDD_URL de bouclage. L'adresse vue par
// le serveur y est celle du poste ; ailleurs (Docker, proxy), ce serait celle du proxy : on ne la donne pas.
export function ecouteLocale(config: Config): boolean {
	if (!estBouclage(config.hote)) return false;
	if (!config.url) return true;
	return estBouclage(new URL(config.url).hostname.replace(/^\[|\]$/g, ""));
}
const ipDe = (req: IncomingMessage): string => String(req.socket.remoteAddress || "").replace(/^::ffff:/i, "");

// GET /appairage?code=XXXX-XXXX : vers la page d'autorisation de la méta-interface ; code invalide : la page sans code.
export function redirigerAppairage(res: ServerResponse, params: URLSearchParams): void {
	const code = normaliserCode(params.get("code"));
	res.writeHead(303, { ...ENTETES_COMMUNS, Location: code ? `/#/appairage/${presente(code)}` : "/#/appairage" });
	res.end();
}

// Routes /api/appairage/… ; seg : les segments après « appairage ».
export async function apiAppairage(ctx: Contexte, req: IncomingMessage, res: ServerResponse, seg: string[], m: string): Promise<void> {
	verifierCsrf(req, ctx.config);
	if (seg.length === 0 && m === "POST") return json(res, 201, await creer(ctx, req));
	if (seg.length === 1 && seg[0] === "jeton" && m === "POST") {
		const r = await livrer(ctx, req);
		return json(res, r.statut, r.corps);
	}
	if (seg.length === 1 && m === "GET") return json(res, 200, lire(ctx, req, seg[0]));
	if (seg.length === 2 && m === "POST" && (seg[1] === "autoriser" || seg[1] === "refuser")) {
		await decider(ctx, req, seg[0], seg[1]);
		return json(res, 204);
	}
	await lireJson(req).catch(() => { });
	throw absent("route inconnue");
}

// --- Création (sans authentification) ------------------------------------------------------------------------
async function creer(ctx: Contexte, req: IncomingMessage) {
	const c = await lireJson(req, 16 * 1024);
	if (!estObjet(c)) throw invalide("objet { poste, projet?, role?, usage? } attendu");
	for (const k of Object.keys(c)) if (!["poste", "projet", "role", "usage"].includes(k)) throw invalide(`clé inconnue : ${k}`);
	const poste = validerNom(c.poste);
	// Le projet demandé n'est qu'une préférence (présélection de la page) : sa forme est vérifiée, pas son existence
	// (une requête sans authentification ne doit pas pouvoir sonder les projets du serveur).
	if (c.projet !== undefined && c.projet !== null && (typeof c.projet !== "string" || !ID_PROJET.test(c.projet))) throw invalide("projet : [a-z0-9-]{1,40}");
	const projet = typeof c.projet === "string" ? c.projet : null;
	const role = c.role ?? "agent";
	if (typeof role !== "string" || !(ROLES_JETON as readonly string[]).includes(role)) throw invalide(`role : ${ROLES_JETON.join(" ou ")}`);
	const usage = c.usage ?? "permanent";
	if (typeof usage !== "string" || !(USAGES as readonly string[]).includes(usage)) throw invalide(`usage : ${USAGES.join(" ou ")}`);
	const codeAppareil = secret();
	const ip = ipDe(req);
	const r = ctx.base.transaction(() => {
		const db = ctx.base.db, now = Date.now(), iso = new Date(now).toISOString();
		// Les appairages expirés sont purgés à chaque création.
		db.prepare("DELETE FROM appairages WHERE expire <= ?").run(iso);
		const n = (sql: string, ...v: string[]) => Number((db.prepare(sql).get(...v) as { n: number }).n);
		if (n("SELECT COUNT(*) AS n FROM appairages WHERE etat = 'attente' AND expire > ?", iso) >= MAX_EN_ATTENTE)
			throw trop(`trop d'appairages en attente sur ce serveur (${MAX_EN_ATTENTE} au plus) : réessaie dans quelques minutes`);
		if (n("SELECT COUNT(*) AS n FROM appairages WHERE cree > ?", new Date(now - MINUTE_MS).toISOString()) >= MAX_PAR_MINUTE)
			throw trop(`trop d'appairages créés en une minute (${MAX_PAR_MINUTE} au plus) : réessaie dans une minute`);
		let code = tirerCode();
		for (let i = 0; i < 20 && db.prepare("SELECT 1 FROM appairages WHERE code = ?").get(code); i++) code = tirerCode();
		const id = idAleatoire(12), expire = new Date(now + DUREE_APPAIRAGE_MS).toISOString();
		db.prepare("INSERT INTO appairages (id, empreinte, code, cree, expire, ip, poste, projet_demande, role_demande, usage, etat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attente')")
			.run(id, hacher(codeAppareil), code, iso, expire, ip, poste, projet, role, usage);
		return { id, code, expire };
	});
	ctx.journal(`appairage ${r.id} demandé depuis « ${ligne(poste, 60)} » (${role}, ${usage}${projet ? ", projet " + projet : ""})`);
	return { code_appareil: codeAppareil, code: presente(r.code), expire: r.expire, intervalle: ctx.config.intervalleAppairageMs / 1000 };
}

// --- Côté navigateur (session) --------------------------------------------------------------------------------
// Session seulement : un jeton Bearer n'autorise pas d'appairage (il se donnerait d'autres jetons). Rend le compte et la
// clé de la session (empreinte du cookie) pour la limite des codes inconnus.
function sessionDe(ctx: Contexte, req: IncomingMessage): { compte: Compte; cle: string } {
	const id = identifier(req, ctx.base);
	if (id.type === "agent") throw refuse("réservé aux sessions de la méta-interface : un jeton n'autorise pas d'appairage");
	if (id.type === "aucun") throw new ErreurApi(401, "revoked", id.cookie ? "session expirée : demande un lien de reconnexion à un mainteneur du projet" : "session requise (lien d'invitation ou de reconnexion)");
	return { compte: id.compte, cle: hacher(valeursCookie(req, COOKIE)[0] || "") };
}
// Limite des codes inconnus (10 par session et par minute), en mémoire du serveur : vérifiée avant toute recherche.
function verifierEssais(ctx: Contexte, cle: string): void {
	const now = Date.now();
	const l = (ctx.essaisCodes.get(cle) || []).filter(t => t > now - MINUTE_MS);
	if (l.length) ctx.essaisCodes.set(cle, l); else ctx.essaisCodes.delete(cle);
	if (l.length >= MAX_INCONNUS) throw trop(`trop de codes inconnus (${MAX_INCONNUS} par minute au plus) : vérifie le code et réessaie dans une minute`);
}
function noterInconnu(ctx: Contexte, cle: string): ErreurApi {
	const l = ctx.essaisCodes.get(cle) || [];
	l.push(Date.now());
	ctx.essaisCodes.set(cle, l);
	return absent("code d'appairage inconnu, expiré ou déjà traité");
}
// Appairage en attente et non expiré, par son code ; sinon 404 (compté comme code inconnu).
function enAttente(ctx: Contexte, cle: string, brut: string): Ligne {
	verifierEssais(ctx, cle);
	const code = normaliserCode(brut);
	const a = code ? ctx.base.db.prepare(`SELECT ${COLONNES} FROM appairages WHERE code = ?`).get(code) as Ligne | undefined : undefined;
	if (!a || a.etat !== "attente" || !(Date.parse(a.expire) > Date.now())) throw noterInconnu(ctx, cle);
	return a;
}
// Rôle le plus haut qu'un compte peut donner à un jeton sur un projet : contributeur → agent ; mainteneur, admin →
// mainteneur ; sinon (lecteur, aucun rôle, désactivé) null.
function roleMax(ctx: Contexte, compte: Compte, projet: string): RoleJeton | null {
	if (!ctx.base.projet(projet)) return null;
	const r = ctx.base.roleSur(compte, projet);
	return r === "mainteneur" || r === "admin" ? "mainteneur" : r === "contributeur" ? "agent" : null;
}
// Étape 3.9, I2 : un jeton « retour » (application) peut être autorisé par tout auteur de retours du projet, testeur
// externe compris ; jamais par un lecteur.
function peutRetour(ctx: Contexte, compte: Compte, projet: string): boolean {
	if (!ctx.base.projet(projet)) return false;
	const r = ctx.base.roleSur(compte, projet);
	return r === "contributeur" || r === "mainteneur" || r === "admin" || r === "testeur";
}
// Rôle le plus haut pour cette demande : « retour » si c'est ce qu'elle demande, sinon roleMax.
const maxPour = (ctx: Contexte, compte: Compte, projet: string, demande: string): RoleJeton | null =>
	demande === "retour" ? (peutRetour(ctx, compte, projet) ? "retour" : null) : roleMax(ctx, compte, projet);

function lire(ctx: Contexte, req: IncomingMessage, brut: string) {
	const { compte, cle } = sessionDe(ctx, req);
	const a = enAttente(ctx, cle, brut);
	const locale = ecouteLocale(ctx.config);
	const projets = ctx.base.projetsDe(compte).map(p => ({ id: p.id, titre: p.titre, role_max: maxPour(ctx, compte, p.id, a.role_demande) })).filter(p => p.role_max !== null);
	return {
		code: presente(a.code), poste: a.poste, cree: a.cree, expire: a.expire,
		projet: a.projet_demande, role: a.role_demande, usage: a.usage,
		ip: locale ? a.ip || null : null,
		meme_ip: locale ? (a.ip ? a.ip === ipDe(req) : null) : null,
		projets,
	};
}

async function decider(ctx: Contexte, req: IncomingMessage, brut: string, quoi: "autoriser" | "refuser"): Promise<void> {
	const { compte, cle } = sessionDe(ctx, req);
	// Corps lu d'abord (vide pour refuser), puis le code : un code inconnu compte dans la limite, quel que soit le corps.
	const c = quoi === "autoriser" ? await lireJson(req, 16 * 1024) : await corpsVide(req);
	const a = enAttente(ctx, cle, brut);
	let choix: { projet: string; role: RoleJeton; nom: string } | null = null;
	if (quoi === "autoriser") {
		if (!estObjet(c)) throw invalide("objet { projet, role, nom? } attendu");
		for (const k of Object.keys(c)) if (!["projet", "role", "nom"].includes(k)) throw invalide(`clé inconnue : ${k}`);
		if (typeof c.projet !== "string" || !ID_PROJET.test(c.projet)) throw invalide("projet : [a-z0-9-]{1,40}");
		if (typeof c.role !== "string" || !(ROLES_JETON as readonly string[]).includes(c.role)) throw invalide(`role : ${ROLES_JETON.join(" ou ")}`);
		// Étape 3.9, I2 : le rôle d'une demande « retour » reste « retour » (jamais élargi), et inversement.
		if ((a.role_demande === "retour") !== (c.role === "retour")) throw refuse(a.role_demande === "retour" ? "cette demande vient d'une application : role retour seulement" : "role retour : seulement pour une demande venue d'une application");
		const max = maxPour(ctx, compte, c.projet, c.role);
		if (!max) throw refuse(c.role === "retour" ? "ce compte ne peut pas envoyer de retours sur ce projet" : "ce compte ne peut pas autoriser d'agent sur ce projet (contributeur, mainteneur ou admin requis)");
		if (c.role === "mainteneur" && max !== "mainteneur") throw refuse("role mainteneur : réservé aux mainteneurs du projet et aux admins");
		// Nom par défaut « Agent · <poste> » (« Application · <poste> » pour un jeton retour), coupé à 60 caractères.
		const nom = c.nom === undefined ? validerNom(`${c.role === "retour" ? "Application" : "Agent"} · ${a.poste}`.slice(0, 60)) : validerNom(c.nom);
		choix = { projet: c.projet, role: c.role as RoleJeton, nom };
	}
	const now = new Date().toISOString();
	const n = choix
		? ctx.base.db.prepare("UPDATE appairages SET etat = 'autorise', compte = ?, projet = ?, role = ?, nom = ?, decide = ? WHERE id = ? AND etat = 'attente' AND expire > ?")
			.run(compte.id, choix.projet, choix.role, choix.nom, now, a.id, now).changes
		: ctx.base.db.prepare("UPDATE appairages SET etat = 'refuse', compte = ?, decide = ? WHERE id = ? AND etat = 'attente' AND expire > ?").run(compte.id, now, a.id, now).changes;
	if (Number(n) !== 1) throw noterInconnu(ctx, cle); // traité entre-temps (autre onglet)
	const ip = ecouteLocale(ctx.config) && a.ip ? { ip: a.ip } : {};
	if (choix) {
		ctx.journal(`appairage ${a.id} autorisé par ${compte.id} : ${choix.role} sur ${choix.projet}`);
		ctx.base.journaliser({ qui: compte.id, action: "appairage autorisé", projet: choix.projet, cible: a.id, detail: { poste: a.poste, ...ip, role: choix.role, usage: a.usage, nom: choix.nom } });
	} else {
		ctx.journal(`appairage ${a.id} refusé par ${compte.id}`);
		ctx.base.journaliser({ qui: compte.id, action: "appairage refusé", projet: a.projet_demande && ctx.base.projet(a.projet_demande) ? a.projet_demande : "", cible: a.id, detail: { poste: a.poste, ...ip, role: a.role_demande, usage: a.usage } });
	}
}

// --- Livraison (sans authentification : le code d'appareil fait foi) -----------------------------------------
// Une seule fois : le jeton est créé à ce moment, dans la même transaction que le passage à « livre ». Une interrogation
// trop rapprochée (slow_down) ne compte pas et ne livre rien. Un appairage expiré, purgé, inconnu ou déjà livré :
// 410 expired (la purge les rend indiscernables) ; refusé : 410 refused, jusqu'à son expiration.
async function livrer(ctx: Contexte, req: IncomingMessage): Promise<{ statut: number; corps: unknown }> {
	const c = await lireJson(req, 16 * 1024);
	if (!estObjet(c)) throw invalide("objet { code_appareil } attendu");
	for (const k of Object.keys(c)) if (k !== "code_appareil") throw invalide(`clé inconnue : ${k}`);
	if (typeof c.code_appareil !== "string" || !CODE_APPAREIL.test(c.code_appareil)) throw invalide("code_appareil invalide");
	const empreinte = hacher(c.code_appareil);
	const intervalle = ctx.config.intervalleAppairageMs;
	const r = ctx.base.transaction(() => {
		const db = ctx.base.db, now = Date.now(), iso = new Date(now).toISOString();
		const a = db.prepare(`SELECT ${COLONNES} FROM appairages WHERE empreinte = ?`).get(empreinte) as Ligne | undefined;
		if (!a || a.etat === "livre" || !(Date.parse(a.expire) > now)) return { fin: "expired" as const };
		if (a.etat === "refuse") return { fin: "refused" as const };
		// Tolérance de 10 % : une CLI qui dort exactement « intervalle » peut arriver un peu tôt.
		if (a.interroge && now - Date.parse(a.interroge) < intervalle * 0.9) return { fin: "slow_down" as const };
		db.prepare("UPDATE appairages SET interroge = ? WHERE id = ?").run(iso, a.id);
		if (a.etat !== "autorise") return { fin: "attente" as const };
		// Le compte qui a autorisé est relu : désactivé ou sans droit sur le projet depuis, rien n'est livré (sinon le
		// jeton reprendrait vie à sa réactivation). Passé contributeur : un jeton mainteneur ne vaudrait que comme agent,
		// il est créé « agent » (Base.jeton ferait de même à chaque requête).
		const compte = a.compte ? ctx.base.compte(a.compte) : undefined;
		const max = compte && a.projet ? maxPour(ctx, compte, a.projet, a.role === "retour" ? "retour" : "agent") : null;
		if (!compte || !a.projet || !max) {
			db.prepare("UPDATE appairages SET etat = 'refuse' WHERE id = ?").run(a.id);
			return { fin: "refused" as const, raison: "le compte qui a autorisé n'a plus accès à ce projet" };
		}
		const role: RoleJeton = a.role === "retour" ? "retour" : a.role === "mainteneur" && max === "mainteneur" ? "mainteneur" : "agent";
		const nom = a.nom || validerNom(`${role === "retour" ? "Application" : "Agent"} · ${a.poste}`.slice(0, 60));
		// Étape 3.9, I2 : un jeton « retour » expire au bout de 30 jours (ou à la fin de l'accès d'un testeur externe).
		const finTesteur = role === "retour" ? ctx.base.restriction(compte.id, a.projet)?.fin : undefined;
		const expire = a.usage === "ponctuel" ? new Date(now + DUREE_PONCTUEL_MS).toISOString()
			: role === "retour" ? new Date(Math.min(now + DUREE_JETON_RETOUR_MS, finTesteur ? Date.parse(finTesteur) : Infinity)).toISOString() : null;
		const locale = ecouteLocale(ctx.config);
		const origine = `appairé depuis ${a.poste}${locale && a.ip ? ` (${a.ip})` : ""}`;
		const j = ctx.base.creerJeton(a.projet, nom, role, compte.id, { expire, origine });
		if (Number(db.prepare("UPDATE appairages SET etat = 'livre', jeton = ? WHERE id = ? AND etat = 'autorise'").run(j.id, a.id).changes) !== 1)
			throw new ErreurApi(503, "unavailable", "livraison concurrente, réessaie");
		ctx.base.journaliser({ qui: compte.id, action: "jeton créé", projet: a.projet, cible: j.id, detail: { nom, role, par: "appairage", appairage: a.id, usage: a.usage, expire, origine } });
		return { fin: "livre" as const, id: a.id, jeton: j.jeton, jetonId: j.id, projet: a.projet, role, nom, pour: { id: compte.id, nom: compte.nom }, usage: a.usage, expire };
	});
	switch (r.fin) {
		case "expired": throw new ErreurApi(410, "expired", "appairage expiré, inconnu ou déjà livré : relancer la demande");
		case "refused": throw new ErreurApi(410, "refused", "raison" in r && r.raison ? `appairage refusé : ${r.raison}` : "appairage refusé dans le navigateur");
		case "slow_down": throw trop(`interrogation trop rapprochée : une toutes les ${intervalle / 1000} s`, "slow_down");
		case "attente": return { statut: 202, corps: { etat: "attente" } };
	}
	ctx.journal(`appairage ${r.id} livré : jeton ${r.role} ${r.jetonId} sur ${r.projet} (pour ${r.pour.id})`);
	return { statut: 200, corps: { jeton: r.jeton, projet: r.projet, role: r.role, nom: r.nom, pour: r.pour, usage: r.usage, expire: r.expire } };
}
