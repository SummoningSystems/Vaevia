// Base SQLite de l'outil (outil.sqlite) : comptes, rôles, sessions, invitations, jetons d'agent, projets ; à l'étape 3,
// journal d'audit, jetons d'entrée et sessions de l'hôte des pages.
// Étape 3.5 : expiration et origine des jetons, liens de reconnexion, sessions prolongées à l'usage ; tables des
// appairages (appairage.ts), des demandes de traitement et des veilleurs (demandes.ts).
// Les retours et les tickets n'y sont pas : ils vivent dans le dépôt Git de design de chaque projet (depot.ts).
// Tout secret (session, invitation, jeton, jeton d'entrée) est stocké haché (SHA-256) ; le secret en clair n'est montré
// qu'une fois, et n'entre jamais dans le journal.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import path from "node:path";

// « testeur » (étape 3.9, E2) : personne extérieure invitée pour un temps sur certains onglets du Wiki. Elle ne voit
// que ces onglets (page construite pour elle par le serveur) et ses propres retours ; tout le reste de l'API lui est
// refusé (http.ts, garde en tête d'apiProjet). Jamais donné par PUT membres : seulement par une invitation « testeur ».
export type Role = "lecteur" | "contributeur" | "mainteneur" | "admin" | "agent" | "publieur" | "clone" | "testeur" | "retour";
// Restriction d'un testeur : onglets permis (ids d'onglets du data.json) et fin de l'accès (ISO).
export type Restriction = { onglets: string[]; fin: string };
export const MAX_JOURS_TESTEUR = 90;
export const ROLES_PROJET = ["lecteur", "contributeur", "mainteneur"] as const;

export type Compte = { id: string; nom: string; admin: boolean; desactive?: string | null };
export type Projet = { id: string; titre: string; cree: string };
// Rôle d'un jeton (étape 2, § 2.2) : « agent » (défaut) ou « mainteneur » (droits du mainteneur, plus l'import).
// « publieur » (étape 3.7, G2) : jeton d'une CI, qui ne fait que publier des builds (POST /builds) et lire l'état du
// dernier (GET /builds) ; ni retours, ni notes, ni flux. Jamais donné par un appairage (ROLES_APPAIRAGE).
// « clone » (étape 3.9, A6) : jeton qui ne sert qu'à git clone / fetch du dépôt de design, en lecture seule (clone.ts).
// « retour » (étape 3.9, I2) : jeton d'une application (build de test d'un jeu, d'un logiciel…) qui ne fait que créer des
// retours et envoyer des captures, au nom de son propriétaire (l'auteur du retour est le propriétaire). Obtenu par
// appairage depuis l'application, ou créé dans Membres. Valable pour un testeur externe propriétaire (seul jeton qui
// le soit) ; expire avec lui.
export type RoleJeton = "agent" | "mainteneur" | "publieur" | "clone" | "retour";
export const ROLES_JETON = ["agent", "mainteneur", "publieur", "clone", "retour"] as const;
export const ROLES_APPAIRAGE = ["agent", "mainteneur", "retour"] as const;
export const DUREE_JETON_RETOUR_MS = 30 * 24 * 3600 * 1000;
// pour : le compte propriétaire (étape 3, § 1.4) ; null pour un jeton sans propriétaire (créé avant l'étape 3, ou par /__test/preparer).
export type Jeton = { id: string; projet: string; nom: string; role: RoleJeton; pour: { id: string; nom: string } | null };
// compte_cible : compte existant visé par un lien de reconnexion (étape 3.5, § 2.4), null pour une invitation.
// par : son créateur (null pour lien.ts, le premier lien admin et les invitations d'avant l'étape 3).
export type Invitation = { id: string; projet: string | null; role: string; expire: string; compte_cible: string | null; par: string | null };
export type EntreeJournal = { id: number; quand: string; qui: string; pour: string; action: string; projet: string; cible: string; detail: string };

export const hacher = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");
export const secret = (): string => crypto.randomBytes(32).toString("base64url");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Identifiant aléatoire [A-Za-z0-9]{n} (retours, comptes, jetons), tirage sans biais.
export function idAleatoire(n = 20): string {
	let s = "";
	while (s.length < n) for (const b of crypto.randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALNUM[b % 62];
	return s;
}

const DUREE_SESSION_MS = 30 * 24 * 3600 * 1000;
export const DUREE_ENTREE_MS = 60 * 1000;   // jeton d'entrée sur l'hôte des pages (§ 2) : 60 s, usage unique
export const MAX_SESSIONS_PAGES = 5;        // sessions de l'hôte des pages gardées par compte et par projet
// Étape 3.5 (§ 2.4) : une session qui sert alors qu'il lui reste moins de 15 jours repart pour 30 jours.
export const SEUIL_PROLONGATION_MS = 15 * 24 * 3600 * 1000;
export const DUREE_RECONNEXION_MS = 7 * 24 * 3600 * 1000; // lien de reconnexion : 7 jours, usage unique
// Rôle enregistré sur une ligne d'invitation qui est un lien de reconnexion (compte_cible rempli). Jamais « admin » :
// annulerInvitationsAdmin() et l'acceptation d'une invitation se fondent sur ce rôle.
export const ROLE_RECONNEXION = "reconnexion";
const ATTENTE_VERROU_MS = 5000;

// Colonnes ajoutées aux bases existantes : [table, colonne, définition]. Ajout seulement, à la fin.
const COLONNES: [string, string, string][] = [
	// Étape 2 : rôle des jetons (les jetons existants restent « agent »).
	["jetons", "role", "TEXT NOT NULL DEFAULT 'agent'"],
	// Étape 3 : propriétaire des jetons (vide pour les jetons existants), comptes désactivés, date d'entrée dans un
	// projet, invitations avec un id public (jamais dérivé du secret), leur créateur et leur annulation.
	["jetons", "pour", "TEXT"],
	["comptes", "desactive", "TEXT"],
	["roles", "depuis", "TEXT NOT NULL DEFAULT ''"],
	["invitations", "id", "TEXT"],
	["invitations", "par", "TEXT"],
	["invitations", "annulee", "TEXT"],
	// Étape 3.5 : expiration d'un jeton (§ 2.1, vide = sans fin), son origine affichée (vide pour les jetons existants ;
	// « appairé depuis <poste> (<ip>) » pour un jeton d'appairage), compte visé par un lien de reconnexion (§ 2.4).
	["jetons", "expire", "TEXT"],
	["jetons", "origine", "TEXT NOT NULL DEFAULT ''"],
	["invitations", "compte_cible", "TEXT"],
	// Étape 3.9, E4 : navigateur (résumé lisible de l'User-Agent, jamais l'en-tête brut) et dernier accès d'une session.
	["sessions", "navigateur", "TEXT NOT NULL DEFAULT ''"],
	["sessions", "vu", "TEXT"],
	// Étape 3.9, G5 : profils de traitement annoncés par un veilleur (noms séparés par des virgules), profil d'une demande.
	["veilles", "profils", "TEXT NOT NULL DEFAULT ''"],
	["demandes", "profil", "TEXT NOT NULL DEFAULT ''"],
	// Étape 3.9, E2 : testeurs externes : onglets permis (JSON) et fin de l'accès, sur le rôle ; l'invitation les porte
	// (onglets, durée en jours comptée à partir de l'acceptation).
	["roles", "onglets", "TEXT"],
	["roles", "fin", "TEXT"],
	["invitations", "onglets", "TEXT"],
	["invitations", "jours", "INTEGER"],
];

// Étape 3.9, E4 : « Edge · Windows », « Firefox · Linux »… à partir de l'User-Agent ; « navigateur inconnu » sinon.
export function resumeNavigateur(ua: unknown): string {
	const s = String(ua ?? "");
	const nav = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /curl|node|undici/i.test(s) ? "programme" : "";
	const os = /Windows/.test(s) ? "Windows" : /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iOS" : /Mac OS X/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "";
	return [nav, os].filter(Boolean).join(" · ") || "navigateur inconnu";
}
// Id public d'une session : début de l'empreinte (le secret ne se déduit pas de son empreinte).
const ID_SESSION = 16;

export class Base {
	db: DatabaseSync;
	constructor(dossier: string) {
		this.db = new DatabaseSync(path.join(dossier, "outil.sqlite"));
		// busy_timeout d'abord : la base peut être ouverte en même temps par serveur/src/lien.ts (étape 3.5, § 2.4) ;
		// une écriture concurrente attend le verrou au lieu d'échouer tout de suite (SQLITE_BUSY).
		this.db.exec(`PRAGMA busy_timeout = ${ATTENTE_VERROU_MS}`);
		// Pragmas hors de la transaction : journal_mode ne change pas dans une transaction, foreign_keys y est sans effet.
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		// Montée de version, un seul mécanisme : les tables manquantes sont créées (CREATE TABLE IF NOT EXISTS), puis les
		// colonnes manquantes sont ajoutées (liste COLONNES ci-dessous). Une table nouvelle s'ajoute ici, une colonne
		// nouvelle d'une table existante s'ajoute à COLONNES (jamais dans le CREATE d'une table qui existe déjà en base).
		// Le tout en une transaction BEGIN IMMEDIATE, colonnes relues à l'intérieur : deux processus qui ouvrent en même
		// temps une base d'avant (lien.ts et le serveur, juste après une mise à jour) se suivent. Le second attend le
		// verrou (busy_timeout) et trouve les colonnes déjà là, au lieu d'échouer sur « duplicate column name ».
		this.transaction(() => this.monterVersion());
	}
	// Montée de version, dans la transaction du constructeur.
	monterVersion(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS projets (id TEXT PRIMARY KEY, titre TEXT NOT NULL, cree TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS comptes (id TEXT PRIMARY KEY, nom TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, cree TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS roles (compte TEXT NOT NULL REFERENCES comptes(id), projet TEXT NOT NULL REFERENCES projets(id),
				role TEXT NOT NULL, PRIMARY KEY (compte, projet));
			CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, compte TEXT NOT NULL REFERENCES comptes(id), cree TEXT NOT NULL, expire TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS invitations (hash TEXT PRIMARY KEY, projet TEXT, role TEXT NOT NULL, cree TEXT NOT NULL,
				expire TEXT NOT NULL, utilisee TEXT, compte TEXT);
			CREATE TABLE IF NOT EXISTS jetons (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, projet TEXT NOT NULL REFERENCES projets(id),
				nom TEXT NOT NULL, cree TEXT NOT NULL, revoque TEXT);
			CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, quand TEXT NOT NULL, qui TEXT NOT NULL, pour TEXT NOT NULL DEFAULT '',
				action TEXT NOT NULL, projet TEXT NOT NULL DEFAULT '', cible TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
			CREATE TABLE IF NOT EXISTS entrees (hash TEXT PRIMARY KEY, compte TEXT NOT NULL REFERENCES comptes(id), projet TEXT NOT NULL,
				expire TEXT NOT NULL, utilise TEXT);
			CREATE TABLE IF NOT EXISTS sessions_pages (hash TEXT PRIMARY KEY, compte TEXT NOT NULL REFERENCES comptes(id), projet TEXT NOT NULL,
				cree TEXT NOT NULL, expire TEXT NOT NULL);
			-- Étape 3.5 (§ 2.1) : appairages d'un poste (états d'exploitation, hors de Git ; voir appairage.ts). empreinte :
			-- SHA-256 du code d'appareil (le code lui-même n'est jamais gardé) ; code : code utilisateur, sans tiret ;
			-- *_demande : ce que la CLI demande ; compte, projet, role, nom : choisis à l'autorisation ; interroge : dernière
			-- interrogation acceptée (slow_down) ; jeton : id du jeton créé à la livraison (jamais sa valeur).
			CREATE TABLE IF NOT EXISTS appairages (id TEXT PRIMARY KEY, empreinte TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE,
				cree TEXT NOT NULL, expire TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', poste TEXT NOT NULL,
				projet_demande TEXT, role_demande TEXT NOT NULL, usage TEXT NOT NULL, etat TEXT NOT NULL,
				compte TEXT, projet TEXT, role TEXT, nom TEXT, decide TEXT, interroge TEXT, jeton TEXT);
			-- Étape 3.5 (§ 5.2) : demandes de traitement et veilleurs (états d'exploitation, hors de Git ; voir demandes.ts).
			CREATE TABLE IF NOT EXISTS demandes (id TEXT PRIMARY KEY, projet TEXT NOT NULL, etat TEXT NOT NULL, demandeur TEXT NOT NULL,
				cree TEXT NOT NULL, pris TEXT, preneur TEXT, poste TEXT NOT NULL DEFAULT '', battement TEXT, fini TEXT,
				annulation_demandee INTEGER NOT NULL DEFAULT 0, journal TEXT NOT NULL DEFAULT '', resume TEXT NOT NULL DEFAULT '',
				code_sortie INTEGER, raison TEXT NOT NULL DEFAULT '');
			-- Une demande active au plus par projet, garantie par la base (deux créations simultanées : une seule passe).
			CREATE UNIQUE INDEX IF NOT EXISTS demandes_active ON demandes(projet) WHERE etat IN ('attente', 'en-cours');
			CREATE INDEX IF NOT EXISTS demandes_projet ON demandes(projet, cree);
			CREATE TABLE IF NOT EXISTS veilles (jeton TEXT PRIMARY KEY, projet TEXT NOT NULL, poste TEXT NOT NULL, vu TEXT NOT NULL);
			-- Étape 3.9, I3 : webhook entrant de la forge, un secret par projet (forge.ts ; hors de Git).
			CREATE TABLE IF NOT EXISTS forges (projet TEXT PRIMARY KEY, secret TEXT NOT NULL, cree TEXT NOT NULL, dernier TEXT, dernier_resultat TEXT NOT NULL DEFAULT '');
		`);
		// Colonnes ajoutées aux bases existantes, dans l'ordre des étapes.
		const colonnes = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
		for (const [table, colonne, definition] of COLONNES)
			if (!colonnes(table).includes(colonne)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${definition}`);
		for (const r of this.db.prepare("SELECT hash FROM invitations WHERE id IS NULL").all() as { hash: string }[])
			this.db.prepare("UPDATE invitations SET id = ? WHERE hash = ?").run(idAleatoire(12), r.hash);
		this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS invitations_id ON invitations(id)");
	}
	fermer(): void { try { this.db.close(); } catch { } }

	// Plusieurs écritures en une transaction (tout ou rien).
	transaction<T>(f: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try { const r = f(); this.db.exec("COMMIT"); return r; }
		catch (e) { this.db.exec("ROLLBACK"); throw e; }
	}

	// --- Projets -----------------------------------------------------------------------------------------
	projets(): Projet[] { return this.db.prepare("SELECT id, titre, cree FROM projets ORDER BY id").all() as Projet[]; }
	projet(id: string): Projet | undefined { return this.db.prepare("SELECT id, titre, cree FROM projets WHERE id = ?").get(id) as Projet | undefined; }
	creerProjet(id: string, titre: string): void { this.db.prepare("INSERT INTO projets (id, titre, cree) VALUES (?, ?, ?)").run(id, titre, new Date().toISOString()); }

	// --- Comptes et rôles --------------------------------------------------------------------------------
	compte(id: string): Compte | undefined {
		const r = this.db.prepare("SELECT id, nom, admin, desactive FROM comptes WHERE id = ?").get(id) as { id: string; nom: string; admin: number; desactive: string | null } | undefined;
		return r && { id: r.id, nom: r.nom, admin: r.admin === 1, desactive: r.desactive };
	}
	creerCompte(id: string, nom: string, admin: boolean): void {
		this.db.prepare("INSERT INTO comptes (id, nom, admin, cree) VALUES (?, ?, ?, ?)").run(id, nom, admin ? 1 : 0, new Date().toISOString());
	}
	// Tous les comptes, avec leurs rôles (administration, § 3.3).
	comptes(): { id: string; nom: string; admin: boolean; desactive: string | null; cree: string; projets: { projet: string; role: string }[] }[] {
		const roles = this.db.prepare("SELECT compte, projet, role FROM roles ORDER BY projet").all() as { compte: string; projet: string; role: string }[];
		return (this.db.prepare("SELECT id, nom, admin, desactive, cree FROM comptes ORDER BY cree, id").all() as { id: string; nom: string; admin: number; desactive: string | null; cree: string }[])
			.map(c => ({ id: c.id, nom: c.nom, admin: c.admin === 1, desactive: c.desactive, cree: c.cree, projets: roles.filter(r => r.compte === c.id).map(r => ({ projet: r.projet, role: r.role })) }));
	}
	modifierCompte(id: string, champs: { nom?: string; admin?: boolean; desactive?: boolean }): void {
		if (champs.nom !== undefined) this.db.prepare("UPDATE comptes SET nom = ? WHERE id = ?").run(champs.nom, id);
		if (champs.admin !== undefined) this.db.prepare("UPDATE comptes SET admin = ? WHERE id = ?").run(champs.admin ? 1 : 0, id);
		if (champs.desactive !== undefined) this.db.prepare("UPDATE comptes SET desactive = ? WHERE id = ?").run(champs.desactive ? new Date().toISOString() : null, id);
	}
	adminExiste(): boolean { return !!this.db.prepare("SELECT 1 FROM comptes WHERE admin = 1 LIMIT 1").get(); }
	adminsActifs(): number { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM comptes WHERE admin = 1 AND desactive IS NULL").get() as { n: number }).n); }
	donnerRole(compte: string, projet: string, role: string, restriction?: Restriction): void {
		const r = role === "testeur" && restriction ? restriction : null;
		this.db.prepare("INSERT INTO roles (compte, projet, role, depuis, onglets, fin) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (compte, projet) DO UPDATE SET role = excluded.role, onglets = excluded.onglets, fin = excluded.fin")
			.run(compte, projet, role, new Date().toISOString(), r ? JSON.stringify(r.onglets) : null, r ? r.fin : null);
	}
	// Étape 3.9, E2 : restriction d'un testeur sur un projet (null pour tout autre rôle). Une ligne illisible ne permet
	// aucun onglet et finit tout de suite (refus par défaut).
	restriction(compte: string, projet: string): Restriction | null {
		const r = this.db.prepare("SELECT role, onglets, fin FROM roles WHERE compte = ? AND projet = ?").get(compte, projet) as { role: string; onglets: string | null; fin: string | null } | undefined;
		if (!r || r.role !== "testeur") return null;
		let onglets: string[] = [];
		try { const o = JSON.parse(r.onglets || "[]"); if (Array.isArray(o)) onglets = o.filter(x => typeof x === "string"); } catch { onglets = []; }
		return { onglets, fin: r.fin || new Date(0).toISOString() };
	}
	// Prolonge (ou raccourcit) l'accès d'un testeur, et change ses onglets.
	modifierRestriction(compte: string, projet: string, r: Restriction): boolean {
		return Number(this.db.prepare("UPDATE roles SET onglets = ?, fin = ? WHERE compte = ? AND projet = ? AND role = 'testeur'").run(JSON.stringify(r.onglets), r.fin, compte, projet).changes) > 0;
	}
	retirerRole(compte: string, projet: string): boolean {
		return Number(this.db.prepare("DELETE FROM roles WHERE compte = ? AND projet = ?").run(compte, projet).changes) > 0;
	}
	// Rôle d'un compte sur un projet : « admin » pour un admin global, sinon son rôle de projet, sinon null.
	// Un compte désactivé n'a plus aucun rôle.
	roleSur(compte: Compte, projet: string): Role | null {
		if (compte.desactive) return null;
		if (compte.admin) return "admin";
		const r = this.db.prepare("SELECT role, fin FROM roles WHERE compte = ? AND projet = ?").get(compte.id, projet) as { role: Role; fin: string | null } | undefined;
		if (r && r.role === "testeur" && !(Date.parse(r.fin || "") > Date.now())) return null;
		return r ? r.role : null;
	}
	// Rôle de projet seul (sans l'effet du statut d'admin), ou null.
	roleProjet(compte: string, projet: string): string | null {
		const r = this.db.prepare("SELECT role FROM roles WHERE compte = ? AND projet = ?").get(compte, projet) as { role: string } | undefined;
		return r ? r.role : null;
	}
	projetsDe(compte: Compte): Projet[] {
		if (compte.desactive) return [];
		if (compte.admin) return this.projets();
		return this.db.prepare("SELECT p.id, p.titre, p.cree FROM projets p JOIN roles r ON r.projet = p.id WHERE r.compte = ? ORDER BY p.id").all(compte.id) as Projet[];
	}
	membres(projet: string): { compte: string; nom: string; role: string; depuis: string; desactive: boolean; testeur?: Restriction & { fini: boolean } }[] {
		return (this.db.prepare("SELECT r.compte, c.nom, r.role, r.depuis, c.desactive FROM roles r JOIN comptes c ON c.id = r.compte WHERE r.projet = ? ORDER BY r.depuis, c.nom")
			.all(projet) as { compte: string; nom: string; role: string; depuis: string; desactive: string | null }[])
			.map(m => {
				const t = m.role === "testeur" ? this.restriction(m.compte, projet) : null;
				return { compte: m.compte, nom: m.nom, role: m.role, depuis: m.depuis, desactive: !!m.desactive, ...(t ? { testeur: { ...t, fini: !(Date.parse(t.fin) > Date.now()) } } : {}) };
			});
	}
	// Mainteneurs actifs d'un projet (comptes non désactivés ; les admins globaux ne comptent pas).
	mainteneursActifs(projet: string): number {
		return Number((this.db.prepare("SELECT COUNT(*) AS n FROM roles r JOIN comptes c ON c.id = r.compte WHERE r.projet = ? AND r.role = 'mainteneur' AND c.desactive IS NULL")
			.get(projet) as { n: number }).n);
	}

	// --- Sessions ----------------------------------------------------------------------------------------
	creerSession(compte: string, navigateur = ""): { jeton: string; maxAge: number } {
		const jeton = secret(), now = Date.now();
		this.db.prepare("INSERT INTO sessions (hash, compte, cree, expire, navigateur, vu) VALUES (?, ?, ?, ?, ?, ?)")
			.run(hacher(jeton), compte, new Date(now).toISOString(), new Date(now + DUREE_SESSION_MS).toISOString(), navigateur, new Date(now).toISOString());
		return { jeton, maxAge: Math.floor(DUREE_SESSION_MS / 1000) };
	}
	// Étape 3.9, E4 : sessions d'un compte (hôte principal), la plus récemment vue d'abord ; « courante » : celle du
	// jeton donné. Jamais l'empreinte entière ni le secret : un id public (début de l'empreinte).
	sessionsDe(compte: string, jetonCourant = ""): { id: string; navigateur: string; cree: string; vu: string; expire: string; courante: boolean }[] {
		const courant = jetonCourant ? hacher(jetonCourant) : "";
		return (this.db.prepare("SELECT hash, navigateur, cree, vu, expire FROM sessions WHERE compte = ? AND expire > ? ORDER BY COALESCE(vu, cree) DESC")
			.all(compte, new Date().toISOString()) as { hash: string; navigateur: string; cree: string; vu: string | null; expire: string }[])
			.map(s => ({ id: s.hash.slice(0, ID_SESSION), navigateur: s.navigateur || "navigateur inconnu", cree: s.cree, vu: s.vu || s.cree, expire: s.expire, courante: s.hash === courant }));
	}
	// Ferme une session d'un compte par son id public ; rend vrai si elle existait. Ses sessions de l'hôte des pages,
	// liées au compte et non à la session, restent : « Fermer toutes » (supprimerSessions) les retire aussi.
	fermerSession(compte: string, id: string): boolean {
		if (!/^[0-9a-f]{16}$/.test(id)) return false;
		return Number(this.db.prepare("DELETE FROM sessions WHERE compte = ? AND substr(hash, 1, 16) = ?").run(compte, id).changes) > 0;
	}
	// Dernier accès, noté une fois par minute au plus (appelé à chaque requête par le routeur, comme prolongerSession).
	noterAcces(jeton: string): void {
		const now = Date.now();
		this.db.prepare("UPDATE sessions SET vu = ? WHERE hash = ? AND (vu IS NULL OR vu < ?)").run(new Date(now).toISOString(), hacher(jeton), new Date(now - 60000).toISOString());
	}
	session(jeton: string): Compte | undefined {
		const r = this.db.prepare("SELECT compte, expire FROM sessions WHERE hash = ?").get(hacher(jeton)) as { compte: string; expire: string } | undefined;
		if (!r) return undefined;
		if (Date.parse(r.expire) <= Date.now()) { this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(hacher(jeton)); return undefined; }
		const c = this.compte(r.compte);
		// Compte désactivé : connexion refusée (ses sessions sont aussi supprimées à la désactivation).
		return c && !c.desactive ? c : undefined;
	}
	// Session prolongée à l'usage (étape 3.5, § 2.4) : valable, d'un compte actif, et à moins de 15 jours de sa fin →
	// repart pour 30 jours, à la même valeur de cookie. Rend le nouveau Max-Age (secondes) à renvoyer dans Set-Cookie,
	// ou null (rien à faire). Appelée une fois par requête par le routeur, avant toute réponse ; jamais depuis session(),
	// que le flux SSE rappelle après l'envoi des en-têtes (la ligne serait prolongée sans que le cookie le soit).
	prolongerSession(jeton: string): number | null {
		const h = hacher(jeton), now = Date.now();
		const r = this.db.prepare("SELECT compte, expire FROM sessions WHERE hash = ?").get(h) as { compte: string; expire: string } | undefined;
		if (!r || !this.aProlonger(r.expire, r.compte, now)) return null;
		this.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(now + DUREE_SESSION_MS).toISOString(), h);
		return Math.floor(DUREE_SESSION_MS / 1000);
	}
	// Même règle pour une session de l'hôte des pages, seulement pour son projet.
	prolongerSessionPages(jeton: string, projet: string): number | null {
		const h = hacher(jeton), now = Date.now();
		const r = this.db.prepare("SELECT compte, projet, expire FROM sessions_pages WHERE hash = ?").get(h) as { compte: string; projet: string; expire: string } | undefined;
		if (!r || r.projet !== projet || !this.aProlonger(r.expire, r.compte, now)) return null;
		this.db.prepare("UPDATE sessions_pages SET expire = ? WHERE hash = ?").run(new Date(now + DUREE_SESSION_MS).toISOString(), h);
		return Math.floor(DUREE_SESSION_MS / 1000);
	}
	aProlonger(expire: string, compte: string, now: number): boolean {
		const fin = Date.parse(expire);
		if (!(fin > now) || fin - now >= SEUIL_PROLONGATION_MS) return false;
		const c = this.compte(compte);
		return !!c && !c.desactive;
	}
	// Toutes les sessions d'un compte (principale et pages), à sa désactivation.
	supprimerSessions(compte: string): void {
		this.db.prepare("DELETE FROM sessions WHERE compte = ?").run(compte);
		this.db.prepare("DELETE FROM sessions_pages WHERE compte = ?").run(compte);
		this.db.prepare("DELETE FROM entrees WHERE compte = ?").run(compte);
	}

	// --- Hôte des pages (§ 2) : jeton d'entrée (60 s, usage unique, lié au compte et au projet) et session propre ----
	creerEntree(compte: string, projet: string): string {
		const jeton = secret(), now = Date.now();
		this.db.prepare("DELETE FROM entrees WHERE expire <= ?").run(new Date(now - DUREE_ENTREE_MS).toISOString());
		this.db.prepare("INSERT INTO entrees (hash, compte, projet, expire) VALUES (?, ?, ?, ?)").run(hacher(jeton), compte, projet, new Date(now + DUREE_ENTREE_MS).toISOString());
		return jeton;
	}
	// Consomme le jeton (une seule fois, même en concurrence) ; rend le compte et le projet, ou undefined.
	consommerEntree(jeton: string): { compte: string; projet: string } | undefined {
		const h = hacher(jeton), now = new Date().toISOString();
		const r = this.db.prepare("SELECT compte, projet, expire, utilise FROM entrees WHERE hash = ?").get(h) as { compte: string; projet: string; expire: string; utilise: string | null } | undefined;
		if (!r || r.utilise || Date.parse(r.expire) <= Date.now()) return undefined;
		if (Number(this.db.prepare("UPDATE entrees SET utilise = ? WHERE hash = ? AND utilise IS NULL").run(now, h).changes) !== 1) return undefined;
		return { compte: r.compte, projet: r.projet };
	}
	// À chaque entrée : les sessions expirées sont purgées, et un compte garde au plus MAX_SESSIONS_PAGES sessions par
	// projet (les plus anciennes sont supprimées) : la table ne grossit pas, un vieux cookie volé finit par tomber.
	creerSessionPages(compte: string, projet: string): { jeton: string; maxAge: number } {
		const jeton = secret(), now = Date.now();
		this.transaction(() => {
			this.db.prepare("DELETE FROM sessions_pages WHERE expire <= ?").run(new Date(now).toISOString());
			this.db.prepare("INSERT INTO sessions_pages (hash, compte, projet, cree, expire) VALUES (?, ?, ?, ?, ?)")
				.run(hacher(jeton), compte, projet, new Date(now).toISOString(), new Date(now + DUREE_SESSION_MS).toISOString());
			this.db.prepare(`DELETE FROM sessions_pages WHERE compte = ? AND projet = ? AND rowid NOT IN
				(SELECT rowid FROM sessions_pages WHERE compte = ? AND projet = ? ORDER BY cree DESC, rowid DESC LIMIT ${MAX_SESSIONS_PAGES})`)
				.run(compte, projet, compte, projet);
		});
		return { jeton, maxAge: Math.floor(DUREE_SESSION_MS / 1000) };
	}
	// Session de l'hôte des pages, valable seulement pour son projet.
	sessionPages(jeton: string, projet: string): Compte | undefined {
		const r = this.db.prepare("SELECT compte, projet, expire FROM sessions_pages WHERE hash = ?").get(hacher(jeton)) as { compte: string; projet: string; expire: string } | undefined;
		if (!r || r.projet !== projet) return undefined;
		if (Date.parse(r.expire) <= Date.now()) { this.db.prepare("DELETE FROM sessions_pages WHERE hash = ?").run(hacher(jeton)); return undefined; }
		const c = this.compte(r.compte);
		return c && !c.desactive ? c : undefined;
	}

	// --- Invitations -------------------------------------------------------------------------------------
	creerInvitation(projet: string | null, role: string, expire: string, par: string | null = null): string {
		return this.nouvelleInvitation(projet, role, expire, par).jeton;
	}
	// Rend l'id public (pour l'annuler, le journal) et le secret (affiché une fois).
	nouvelleInvitation(projet: string | null, role: string, expire: string, par: string | null = null, testeur?: { onglets: string[]; jours: number }): { id: string; jeton: string } {
		const jeton = secret(), id = idAleatoire(12);
		const t = role === "testeur" && testeur ? testeur : null;
		this.db.prepare("INSERT INTO invitations (hash, id, projet, role, cree, expire, par, onglets, jours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(hacher(jeton), id, projet, role, new Date().toISOString(), expire, par, t ? JSON.stringify(t.onglets) : null, t ? t.jours : null);
		return { id, jeton };
	}
	// Invitation valable (non utilisée, non annulée, non expirée), sans la consommer.
	invitation(jeton: string): Invitation | undefined {
		const r = this.db.prepare("SELECT id, projet, role, expire, utilisee, annulee, compte_cible, par FROM invitations WHERE hash = ?").get(hacher(jeton)) as (Invitation & { utilisee: string | null; annulee: string | null }) | undefined;
		if (!r || r.utilisee || r.annulee || Date.parse(r.expire) <= Date.now()) return undefined;
		return { id: r.id, projet: r.projet, role: r.role, expire: r.expire, compte_cible: r.compte_cible, par: r.par };
	}
	// Consomme l'invitation et crée le compte, en une transaction : un jeton ne sert qu'une fois.
	accepterInvitation(jeton: string, nom: string): { compte: Compte; projet: string | null; invitation: string; role: string } | undefined {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const inv = this.invitation(jeton);
			// Un lien de reconnexion ne crée jamais de compte (utiliserReconnexion).
			if (!inv || inv.compte_cible) { this.db.exec("ROLLBACK"); return undefined; }
			const id = idAleatoire(20), admin = inv.role === "admin";
			this.creerCompte(id, nom, admin);
			if (!admin && inv.projet) {
				// Étape 3.9, E2 : un testeur reçoit ses onglets, et une fin comptée à partir de maintenant.
				let restriction: Restriction | undefined;
				if (inv.role === "testeur") {
					const r = this.db.prepare("SELECT onglets, jours FROM invitations WHERE hash = ?").get(hacher(jeton)) as { onglets: string | null; jours: number | null };
					let onglets: string[] = [];
					try { const o = JSON.parse(r.onglets || "[]"); if (Array.isArray(o)) onglets = o.filter(x => typeof x === "string"); } catch { onglets = []; }
					const jours = Math.min(MAX_JOURS_TESTEUR, Math.max(1, Number(r.jours) || 1));
					restriction = { onglets, fin: new Date(Date.now() + jours * 24 * 3600 * 1000).toISOString() };
				}
				this.donnerRole(id, inv.projet, inv.role, restriction);
			}
			this.db.prepare("UPDATE invitations SET utilisee = ?, compte = ? WHERE hash = ?").run(new Date().toISOString(), id, hacher(jeton));
			this.db.exec("COMMIT");
			return { compte: { id, nom, admin }, projet: inv.projet, invitation: inv.id, role: inv.role };
		} catch (e) { this.db.exec("ROLLBACK"); throw e; }
	}
	// Lien de reconnexion (étape 3.5, § 2.4) : une ligne d'invitation liée à un compte existant (compte_cible), rôle
	// ROLE_RECONNEXION, 7 jours, usage unique. projet : celui de la route du mainteneur (le lien figure alors parmi les
	// invitations du projet, et s'y annule) ; null pour l'admin et pour lien.ts. par : le créateur, null pour lien.ts.
	nouvelleReconnexion(compte: string, projet: string | null, par: string | null): { id: string; jeton: string; expire: string } {
		const jeton = secret(), id = idAleatoire(12), now = Date.now(), expire = new Date(now + DUREE_RECONNEXION_MS).toISOString();
		this.db.prepare("INSERT INTO invitations (hash, id, projet, role, cree, expire, par, compte_cible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(hacher(jeton), id, projet, ROLE_RECONNEXION, new Date(now).toISOString(), expire, par, compte);
		return { id, jeton, expire };
	}
	// Projets où « compte » a un rôle sans que « createur » y soit mainteneur ou admin. Un lien de reconnexion donne la
	// session entière du compte visé, sur tous ses projets : un mainteneur n'en crée que pour un membre dont il gère
	// tous les projets (sinon il entrerait avec des droits sur un projet qu'il ne gère pas).
	projetsHorsDe(compte: string, createur: Compte): string[] {
		const projets = (this.db.prepare("SELECT projet FROM roles WHERE compte = ? ORDER BY projet").all(compte) as { projet: string }[]).map(r => r.projet);
		return projets.filter(p => { const r = this.roleSur(createur, p); return r !== "mainteneur" && r !== "admin"; });
	}
	// Lien de reconnexion d'un projet (créé par la route du mainteneur) : les règles de sa création, revérifiées à
	// l'utilisation, car les droits ont pu changer entre-temps. Rend la raison d'un refus, ou null. Un lien de
	// l'administration ou de lien.ts (projet null) n'a pas ces règles.
	refusReconnexion(inv: Invitation, cible: Compte): string | null {
		if (inv.projet === null) return null;
		if (cible.admin) return "le compte visé est administrateur : son lien se crée dans l'administration";
		if (!this.roleProjet(cible.id, inv.projet)) return "le compte visé n'est plus membre du projet";
		const par = inv.par ? this.compte(inv.par) : undefined;
		if (!par || par.desactive || this.projetsHorsDe(cible.id, par).length) return "son créateur ne gère plus tous les projets du compte visé : demander un nouveau lien";
		return null;
	}
	// Consomme un lien de reconnexion (une seule fois, même en concurrence) et rend le compte visé. Compte désactivé :
	// « desactive » ; lien de projet qui ne vaut plus (refusReconnexion) : { refus }. Dans les deux cas, le lien n'est
	// pas consommé.
	utiliserReconnexion(jeton: string): { compte: Compte; projet: string | null; invitation: string } | "desactive" | { refus: string } | undefined {
		return this.transaction(() => {
			const inv = this.invitation(jeton);
			if (!inv || !inv.compte_cible) return undefined;
			const c = this.compte(inv.compte_cible);
			if (!c) return undefined;
			if (c.desactive) return "desactive";
			const refus = this.refusReconnexion(inv, c);
			if (refus) return { refus };
			const n = this.db.prepare("UPDATE invitations SET utilisee = ?, compte = ? WHERE hash = ? AND utilisee IS NULL AND annulee IS NULL")
				.run(new Date().toISOString(), c.id, hacher(jeton)).changes;
			if (Number(n) !== 1) return undefined;
			return { compte: c, projet: inv.projet, invitation: inv.id };
		});
	}
	// Annule les liens de reconnexion en attente qui visent un compte : tous (désactivation), ceux d'un projet (retrait
	// du projet), ou, avec null, tous ceux créés par la route d'un projet (compte nommé admin). Rend leurs ids.
	annulerReconnexionsVers(compte: string, projet?: string | null): string[] {
		const now = new Date().toISOString();
		const ids = (projet === undefined
			? this.db.prepare("SELECT id FROM invitations WHERE compte_cible = ? AND utilisee IS NULL AND annulee IS NULL AND expire > ?").all(compte, now)
			: projet === null
				? this.db.prepare("SELECT id FROM invitations WHERE compte_cible = ? AND projet IS NOT NULL AND utilisee IS NULL AND annulee IS NULL AND expire > ?").all(compte, now)
				: this.db.prepare("SELECT id FROM invitations WHERE compte_cible = ? AND projet = ? AND utilisee IS NULL AND annulee IS NULL AND expire > ?").all(compte, projet, now)) as { id: string }[];
		for (const { id } of ids) this.annulerInvitation(id);
		return ids.map(x => x.id);
	}
	// Premier admin actif (le plus ancien), pour lien.ts --admin.
	premierAdminActif(): Compte | undefined {
		const r = this.db.prepare("SELECT id FROM comptes WHERE admin = 1 AND desactive IS NULL ORDER BY cree, id LIMIT 1").get() as { id: string } | undefined;
		return r ? this.compte(r.id) : undefined;
	}
	// Au démarrage sans admin : les anciennes invitations admin non utilisées sont annulées (une seule valable).
	annulerInvitationsAdmin(): void { this.db.prepare("DELETE FROM invitations WHERE role = 'admin' AND utilisee IS NULL").run(); }
	// Invitations (sans secret) : d'un projet, ou toutes (admin) ; « attente » seulement les valables.
	// compte_cible : compte visé par un lien de reconnexion (rôle ROLE_RECONNEXION), null pour une invitation.
	invitations(projet?: string, attente = false): { id: string; projet: string | null; role: string; cree: string; expire: string; par: string | null; utilisee: string | null; compte: string | null; annulee: string | null; compte_cible: string | null; etat: string }[] {
		const lignes = (projet === undefined
			? this.db.prepare("SELECT id, projet, role, cree, expire, par, utilisee, compte, annulee, compte_cible FROM invitations ORDER BY cree DESC").all()
			: this.db.prepare("SELECT id, projet, role, cree, expire, par, utilisee, compte, annulee, compte_cible FROM invitations WHERE projet = ? ORDER BY cree DESC").all(projet)) as
			{ id: string; projet: string | null; role: string; cree: string; expire: string; par: string | null; utilisee: string | null; compte: string | null; annulee: string | null; compte_cible: string | null }[];
		const now = Date.now();
		return lignes.map(l => ({ ...l, etat: l.utilisee ? "utilisee" : l.annulee ? "annulee" : Date.parse(l.expire) <= now ? "expiree" : "attente" }))
			.filter(l => !attente || l.etat === "attente");
	}
	invitationParId(id: string): { id: string; projet: string | null; role: string; compte_cible: string | null; etat: string } | undefined {
		const r = this.db.prepare("SELECT id, projet, role, expire, utilisee, annulee, compte_cible FROM invitations WHERE id = ?").get(id) as { id: string; projet: string | null; role: string; expire: string; utilisee: string | null; annulee: string | null; compte_cible: string | null } | undefined;
		if (!r) return undefined;
		return { id: r.id, projet: r.projet, role: r.role, compte_cible: r.compte_cible, etat: r.utilisee ? "utilisee" : r.annulee ? "annulee" : Date.parse(r.expire) <= Date.now() ? "expiree" : "attente" };
	}
	annulerInvitation(id: string): boolean {
		return Number(this.db.prepare("UPDATE invitations SET annulee = ? WHERE id = ? AND utilisee IS NULL AND annulee IS NULL").run(new Date().toISOString(), id).changes) > 0;
	}
	// Annule les invitations en attente créées par un compte (« par »), quand il perd le droit d'inviter : désactivé,
	// retiré d'un projet, plus mainteneur, plus admin. « garder » : projet (null = invitation admin) dont les invitations
	// restent valables. Rend les ids annulés (pour la réponse et le journal).
	annulerInvitationsDe(par: string, garder: (projet: string | null) => boolean = () => false): string[] {
		const now = new Date().toISOString();
		const lignes = this.db.prepare("SELECT id, projet FROM invitations WHERE par = ? AND utilisee IS NULL AND annulee IS NULL AND expire > ?")
			.all(par, now) as { id: string; projet: string | null }[];
		const ids = lignes.filter(l => !garder(l.projet)).map(l => l.id);
		for (const id of ids) this.annulerInvitation(id);
		return ids;
	}

	// --- Jetons d'agent ----------------------------------------------------------------------------------
	// extra (étape 3.5) : expire (date ISO, jeton ponctuel ; absent = sans fin) et origine (texte affiché par la liste,
	// ex. « appairé depuis <poste> (<ip>) » ; vide par défaut).
	creerJeton(projet: string, nom: string, role: RoleJeton = "agent", pour: string | null = null, extra: { expire?: string | null; origine?: string } = {}): { id: string; jeton: string } {
		const id = idAleatoire(12), jeton = "wdd_" + secret();
		this.db.prepare("INSERT INTO jetons (id, hash, projet, nom, cree, role, pour, expire, origine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(id, hacher(jeton), projet, nom, new Date().toISOString(), role, pour, extra.expire ?? null, extra.origine ?? "");
		return { id, jeton };
	}
	jeton(jeton: string): Jeton | undefined {
		return this.valeurJeton(this.db.prepare("SELECT j.id, j.projet, j.nom, j.role, j.pour, j.expire FROM jetons j WHERE j.hash = ? AND j.revoque IS NULL")
			.get(hacher(jeton)) as { id: string; projet: string; nom: string; role: string; pour: string | null; expire: string | null } | undefined);
	}
	// Même règle, par l'id du jeton (étape 3.5 : liste des veilleurs d'un projet, sans la valeur du jeton).
	jetonActif(id: string): Jeton | undefined {
		return this.valeurJeton(this.db.prepare("SELECT j.id, j.projet, j.nom, j.role, j.pour, j.expire FROM jetons j WHERE j.id = ? AND j.revoque IS NULL")
			.get(id) as { id: string; projet: string; nom: string; role: string; pour: string | null; expire: string | null } | undefined);
	}
	valeurJeton(j: { id: string; projet: string; nom: string; role: string; pour: string | null; expire: string | null } | undefined): Jeton | undefined {
		if (!j) return undefined;
		// Jeton expiré (ponctuel, étape 3.5 § 2.1) : il ne vaut plus. Une date illisible compte comme passée.
		if (j.expire !== null && !(Date.parse(j.expire) > Date.now())) return undefined;
		// Une valeur inconnue en base (écrite à la main) ne donne jamais plus que le rôle agent.
		let role: RoleJeton = j.role === "mainteneur" ? "mainteneur" : j.role === "publieur" ? "publieur" : j.role === "clone" ? "clone" : j.role === "retour" ? "retour" : "agent";
		let pour: { id: string; nom: string } | null = null;
		if (j.pour) {
			// Un jeton ne vaut jamais plus que son propriétaire, relu à chaque requête : propriétaire disparu, désactivé,
			// sans rôle sur le projet (retiré, admin rétrogradé) ou lecteur → le jeton ne vaut plus ; contributeur → un
			// jeton « mainteneur » ne vaut que comme « agent ». S'il retrouve son rôle, le jeton le retrouve aussi.
			const c = this.compte(j.pour);
			const r = c ? this.roleSur(c, j.projet) : null;
			if (!c || !r || r === "lecteur" || r === "agent") return undefined;
			// Étape 3.9 : un testeur externe n'a qu'un jeton « retour » (I2) ; tout autre jeton à son nom ne vaut rien (E2).
			if (r === "testeur" && role !== "retour") return undefined;
			if (r === "contributeur" && role === "mainteneur") role = "agent";
			pour = { id: c.id, nom: c.nom };
		}
		return { id: j.id, projet: j.projet, nom: j.nom, role, pour };
	}
	// Jetons d'un projet (sans secret), révoqués et expirés compris. expire : date ISO, ou null (sans fin) ; expiree :
	// cette date est passée (la vue Membres l'affiche « expiré ») ; origine : texte du serveur, vide par défaut.
	jetons(projet: string): { id: string; nom: string; role: string; pour: { id: string; nom: string } | null; cree: string; revoque: string | null; expire: string | null; expiree: boolean; origine: string }[] {
		const now = Date.now();
		return (this.db.prepare("SELECT j.id, j.nom, j.role, j.pour, c.nom AS pour_nom, j.cree, j.revoque, j.expire, j.origine FROM jetons j LEFT JOIN comptes c ON c.id = j.pour WHERE j.projet = ? ORDER BY j.cree DESC")
			.all(projet) as { id: string; nom: string; role: string; pour: string | null; pour_nom: string | null; cree: string; revoque: string | null; expire: string | null; origine: string }[])
			.map(j => ({ id: j.id, nom: j.nom, role: j.role, pour: j.pour ? { id: j.pour, nom: j.pour_nom || "" } : null, cree: j.cree, revoque: j.revoque,
				expire: j.expire, expiree: j.expire !== null && !(Date.parse(j.expire) > now), origine: j.origine }));
	}
	jetonParId(id: string): { id: string; projet: string; nom: string; pour: string | null; revoque: string | null } | undefined {
		return this.db.prepare("SELECT id, projet, nom, pour, revoque FROM jetons WHERE id = ?").get(id) as { id: string; projet: string; nom: string; pour: string | null; revoque: string | null } | undefined;
	}
	revoquerJeton(id: string): boolean {
		return Number(this.db.prepare("UPDATE jetons SET revoque = ? WHERE id = ? AND revoque IS NULL").run(new Date().toISOString(), id).changes) > 0;
	}
	// Révoque les jetons dont le compte est propriétaire (d'un projet, ou tous) ; rend leurs ids.
	revoquerJetonsDe(compte: string, projet?: string): string[] {
		const ids = (projet === undefined
			? this.db.prepare("SELECT id FROM jetons WHERE pour = ? AND revoque IS NULL").all(compte)
			: this.db.prepare("SELECT id FROM jetons WHERE pour = ? AND projet = ? AND revoque IS NULL").all(compte, projet)) as { id: string }[];
		for (const { id } of ids) this.revoquerJeton(id);
		return ids.map(x => x.id);
	}

	// --- Journal d'audit (§ 3.4) : ajout seul, jamais de secret -------------------------------------------
	journaliser(e: { qui: string; pour?: string; action: string; projet?: string; cible?: string; detail?: unknown }): void {
		const detail = e.detail === undefined ? "" : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
		this.db.prepare("INSERT INTO journal (quand, qui, pour, action, projet, cible, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(new Date().toISOString(), e.qui, e.pour || "", e.action, e.projet || "", e.cible || "", detail.slice(0, 2000));
	}
	// Pages de 100, de la plus récente à la plus ancienne ; « avant » : id de la dernière entrée de la page précédente.
	lireJournal(avant?: number, projet?: string, limite = 100): EntreeJournal[] {
		const conds: string[] = [], vals: (string | number)[] = [];
		if (avant !== undefined) { conds.push("id < ?"); vals.push(avant); }
		if (projet !== undefined) { conds.push("projet = ?"); vals.push(projet); }
		return this.db.prepare(`SELECT id, quand, qui, pour, action, projet, cible, detail FROM journal ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
			.all(...vals, limite) as EntreeJournal[];
	}
	// Nom affiché de « qui » (compte ou agent:<jeton>), pour la lecture du journal.
	nomDe(qui: string): string {
		if (qui.startsWith("agent:")) return (this.db.prepare("SELECT nom FROM jetons WHERE id = ?").get(qui.slice(6)) as { nom: string } | undefined)?.nom ?? "";
		return (this.db.prepare("SELECT nom FROM comptes WHERE id = ?").get(qui) as { nom: string } | undefined)?.nom ?? "";
	}
}
