// Étape 3.5, lot serveur A (docs/etape3-5-prise-en-main.md) : montée de version d'une base de l'étape 3 (§ 1.1),
// lien-admin.txt et GET /api/sante (§ 1.1), jetons expirés, origine et auto-révocation (§ 2.1), liens de reconnexion,
// serveur/src/lien.ts et session prolongée à l'usage (§ 2.4).
// Aucun secret dans un message d'assertion : les liens et jetons sont comparés par assert.ok(a === b, "texte").
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { appel, appelHote, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, portLibre, ecouter, pause } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import { Base, hacher } from "../src/base.ts";

const FICHIER = "lien-admin.txt";
const lienDe = (donnees: string) => path.join(donnees, FICHIER);
const lire = (donnees: string): string | null => { try { return fs.readFileSync(lienDe(donnees), "utf8"); } catch { return null; } };
const cookieDe = (r: { entetes: Headers }) => (r.entetes.get("set-cookie") || "").split(";")[0];
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const JOUR = 24 * 3600 * 1000;
const cheminDe = (url: string) => new URL(url).pathname;

// Schéma de outil.sqlite à l'étape 3 (commit f34567f, serveur/src/base.ts) : les CREATE puis les ALTER de ses
// migrations, dans leur ordre. Une base créée par le serveur de l'étape 3 a exactement ces colonnes.
const SCHEMA_ETAPE3 = `
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
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
	ALTER TABLE jetons ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
	ALTER TABLE jetons ADD COLUMN pour TEXT;
	ALTER TABLE comptes ADD COLUMN desactive TEXT;
	ALTER TABLE roles ADD COLUMN depuis TEXT NOT NULL DEFAULT '';
	ALTER TABLE invitations ADD COLUMN id TEXT;
	ALTER TABLE invitations ADD COLUMN par TEXT;
	ALTER TABLE invitations ADD COLUMN annulee TEXT;
	CREATE UNIQUE INDEX IF NOT EXISTS invitations_id ON invitations(id);
`;
// Secrets de la base de l'étape 3 (stockés hachés, comme le faisait le serveur).
const S_ADM = "sessionAdmEtape3sessionAdmEtape3sessionAdm", S_CAM = "sessionCamEtape3sessionCamEtape3sessionCam";
const J_MAUD = "wdd_jetonMaudEtape3jetonMaudEtape3jetonMaudEtape", J_ANCIEN = "wdd_jetonAncienEtape2jetonAncienEtape2jetonAnci";
const INV = "invitationEtape3invitationEtape3invitation", S_PAGES = "sessionPagesEtape3sessionPagesEtape3sessio";

describe("montée de version : base de l'étape 3 (§ 1.1)", () => {
	let s: Serveur | undefined, donnees: string;
	before(async () => {
		donnees = dossierTemp("35-migration");
		// Le dépôt de design du projet, créé par le serveur (son format n'a pas changé depuis l'étape 3) ; puis la base
		// remplacée par une base de l'étape 3.
		const s0 = await serveurTest(donnees);
		await projet(s0.url, "jardin");
		await s0.arreter();
		for (const f of ["outil.sqlite", "outil.sqlite-wal", "outil.sqlite-shm"]) fs.rmSync(path.join(donnees, f), { force: true });
		const db = new DatabaseSync(path.join(donnees, "outil.sqlite"));
		db.exec(SCHEMA_ETAPE3);
		const t = (ms = 0) => new Date(Date.now() + ms).toISOString();
		db.prepare("INSERT INTO projets (id, titre, cree) VALUES ('jardin', 'Projet jardin', ?)").run(t(-60 * JOUR));
		for (const [id, nom, admin] of [["adm", "Admin", 1], ["maud", "Maud", 0], ["camille", "Camille", 0]] as const)
			db.prepare("INSERT INTO comptes (id, nom, admin, cree) VALUES (?, ?, ?, ?)").run(id, nom, admin, t(-50 * JOUR));
		db.prepare("INSERT INTO roles (compte, projet, role, depuis) VALUES ('maud', 'jardin', 'mainteneur', ?), ('camille', 'jardin', 'contributeur', ?)").run(t(-40 * JOUR), t(-40 * JOUR));
		db.prepare("INSERT INTO sessions (hash, compte, cree, expire) VALUES (?, 'adm', ?, ?), (?, 'camille', ?, ?)").run(hacher(S_ADM), t(-5 * JOUR), t(25 * JOUR), hacher(S_CAM), t(-5 * JOUR), t(25 * JOUR));
		db.prepare("INSERT INTO sessions_pages (hash, compte, projet, cree, expire) VALUES (?, 'camille', 'jardin', ?, ?)").run(hacher(S_PAGES), t(-5 * JOUR), t(25 * JOUR));
		db.prepare("INSERT INTO jetons (id, hash, projet, nom, cree, revoque, role, pour) VALUES ('jmaud', ?, 'jardin', 'Agent de Maud', ?, NULL, 'mainteneur', 'maud')").run(hacher(J_MAUD), t(-10 * JOUR));
		db.prepare("INSERT INTO jetons (id, hash, projet, nom, cree, revoque, role, pour) VALUES ('jancien', ?, 'jardin', 'Ancien', ?, NULL, 'agent', NULL)").run(hacher(J_ANCIEN), t(-30 * JOUR));
		db.prepare("INSERT INTO invitations (hash, id, projet, role, cree, expire, par) VALUES (?, 'inv3', 'jardin', 'lecteur', ?, ?, 'maud')").run(hacher(INV), t(-JOUR), t(6 * JOUR));
		db.prepare("INSERT INTO journal (quand, qui, action, projet, cible) VALUES (?, 'adm', 'projet créé', 'jardin', 'jardin')").run(t(-60 * JOUR));
		db.close();
		// Lien admin d'un ancien premier démarrage, resté sur le disque : supprimé au démarrage (un admin existe).
		fs.writeFileSync(lienDe(donnees), "http://127.0.0.1:8080/invitation/ancienLienAdminAncienLienAdminAncienLie\n");
		s = await serveurTest(donnees, { test: false });
	});
	after(async () => { await s?.arreter(); nettoyer(donnees); });

	test("colonnes ajoutées ; comptes, sessions, jetons et invitation de l'étape 3 marchent ; lien admin ancien supprimé", async () => {
		const u = s!.url;
		assert.equal(s!.lienAdmin, null);
		assert.equal(lire(donnees), null, "lien-admin.txt supprimé au démarrage : un admin existe");
		const colonnes = (t: string) => (s!.ctx.base.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
		for (const c of ["expire", "origine"]) assert.ok(colonnes("jetons").includes(c), `jetons.${c}`);
		assert.ok(colonnes("invitations").includes("compte_cible"));
		assert.ok(s!.ctx.depots.has("jardin"), "projet chargé");
		// Sessions.
		const moi = await appel(u, "/api/moi", { cookie: "wdd_session=" + S_ADM });
		assert.equal(moi.status, 200); assert.equal(moi.corps.compte.id, "adm"); assert.equal(moi.corps.compte.admin, true);
		const se = await appel(u, "/api/p/jardin/session", { cookie: "wdd_session=" + S_CAM });
		assert.equal(se.status, 200); assert.equal(se.corps.role, "contributeur");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: "wdd_session=" + S_CAM, corps: docRetour() })).status, 201, "écriture par une session de l'étape 3");
		assert.equal(s!.ctx.base.sessionPages(S_PAGES, "jardin")?.id, "camille", "session de l'hôte des pages");
		// Jetons : à propriétaire (rôle suivi) et sans propriétaire (créé avant l'étape 3).
		const jm = await appel(u, "/api/p/jardin/session", { bearer: J_MAUD });
		assert.equal(jm.status, 200); assert.equal(jm.corps.role, "mainteneur"); assert.deepEqual(jm.corps.pour, { id: "maud", nom: "Maud" });
		const ja = await appel(u, "/api/p/jardin/session", { bearer: J_ANCIEN });
		assert.equal(ja.status, 200); assert.equal(ja.corps.role, "agent");
		const mau = await appel(u, "/api/p/jardin/jetons", { cookie: "wdd_session=" + S_ADM });
		for (const j of mau.corps.jetons) { assert.equal(j.expire, null); assert.equal(j.expiree, false); assert.equal(j.origine, ""); }
		// Invitation en attente.
		assert.equal((await appel(u, "/invitation/" + INV)).status, 200);
		const membres = await appel(u, "/api/p/jardin/membres", { cookie: "wdd_session=" + S_ADM });
		assert.deepEqual(membres.corps.invitations.map((i: any) => [i.id, i.role, i.compte_cible]), [["inv3", "lecteur", null]]);
		// Les routes nouvelles sur la base montée de version.
		const rc = await appel(u, "/api/admin/comptes/camille/reconnexion", { cookie: "wdd_session=" + S_ADM, corps: {} });
		assert.equal(rc.status, 201, rc.texte);
		assert.equal((await appel(u, "/api/p/jardin/jeton", { bearer: J_ANCIEN, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: J_ANCIEN })).status, 401);
	});

	test("deuxième démarrage sur la base montée : rien ne change, tout marche encore", async () => {
		await s!.arreter();
		s = await serveurTest(donnees, { test: false });
		assert.equal(s.lienAdmin, null);
		assert.equal((await appel(s.url, "/api/moi", { cookie: "wdd_session=" + S_ADM })).status, 200);
		assert.equal((await appel(s.url, "/api/p/jardin/session", { bearer: J_MAUD })).status, 200);
		assert.equal((await appel(s.url, "/invitation/" + INV)).status, 200);
	});
});

describe("lien-admin.txt (§ 1.1)", () => {
	let s: Serveur | undefined, donnees: string;
	before(() => { donnees = dossierTemp("35-lien-admin"); });
	after(async () => { await s?.arreter(); nettoyer(donnees); });
	const demarrer = async () => { await s?.arreter(); s = await serveurTest(donnees, { test: false, verifLienMs: 100 }); return s; };

	test("premier démarrage : le lien admin est écrit (une ligne, 0600 hors Windows) ; nouveau démarrage sans admin : réécrit, l'ancien annulé", async () => {
		const s1 = await demarrer();
		const t1 = lire(donnees);
		assert.ok(s1.lienAdmin && t1 === s1.lienAdmin + "\n", "le fichier contient le lien affiché, sur une ligne");
		if (process.platform !== "win32") assert.equal(fs.statSync(lienDe(donnees)).mode & 0o777, 0o600);
		assert.deepEqual(fs.readdirSync(donnees).filter(f => f.endsWith(".tmp")), [], "pas de fichier temporaire laissé");
		const ancien = cheminDe(s1.lienAdmin!);
		const s2 = await demarrer();
		const t2 = lire(donnees);
		assert.ok(s2.lienAdmin && t2 === s2.lienAdmin + "\n" && t2 !== t1, "fichier réécrit avec le nouveau lien");
		assert.equal((await appel(s2.url, ancien)).status, 404, "l'ancien lien reste annulé");
	});

	test("lien utilisé : fichier supprimé ; démarrage avec un admin : pas de fichier", async () => {
		const chemin = cheminDe(s!.lienAdmin!);
		const r = await appel(s!.url, chemin, { brut: "nom=Admin", entetes: FORM });
		assert.equal(r.status, 303);
		assert.equal(lire(donnees), null, "supprimé dès l'utilisation");
		const s3 = await demarrer();
		assert.equal(s3.lienAdmin, null);
		assert.equal(lire(donnees), null);
	});

	test("lien annulé ou expiré : fichier supprimé ; au démarrage avec un admin, un lien de reconnexion valable est gardé", async () => {
		const u = s!.url;
		const admin = await cookieAdmin();
		// Annulé : le fichier porte une invitation admin, annulée par l'API.
		const ia = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { role: "admin" } });
		fs.writeFileSync(lienDe(donnees), ia.corps.url + "\n");
		assert.equal((await appel(u, `/api/admin/invitations/${ia.corps.id}`, { cookie: admin, methode: "DELETE" })).status, 204);
		assert.equal(lire(donnees), null, "supprimé à l'annulation");
		// Expiré : vérifié par la minuterie (100 ms ici, 60 s en vrai).
		const courte = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { role: "admin", expire: new Date(Date.now() + 2000).toISOString() } });
		fs.writeFileSync(lienDe(donnees), courte.corps.url + "\n");
		await pause(300);
		assert.notEqual(lire(donnees), null, "encore valable");
		await pause(2500);
		assert.equal(lire(donnees), null, "supprimé à l'expiration");
		// Démarrage avec un admin : une invitation admin encore valable est supprimée du fichier…
		const ib = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { role: "admin" } });
		fs.writeFileSync(lienDe(donnees), ib.corps.url + "\n");
		await demarrer();
		assert.equal(lire(donnees), null, "lien de création d'admin : supprimé au démarrage");
		// … un lien de reconnexion valable (lien.ts lancé avant le serveur) est gardé, jusqu'à son annulation.
		const rc = await appel(s!.url, "/api/admin/comptes/" + (await appel(s!.url, "/api/moi", { cookie: admin })).corps.compte.id + "/reconnexion", { cookie: admin, corps: {} });
		assert.equal(rc.status, 201);
		fs.writeFileSync(lienDe(donnees), rc.corps.url + "\n");
		await demarrer();
		assert.ok(lire(donnees) === rc.corps.url + "\n", "lien de reconnexion gardé au démarrage");
		assert.equal((await appel(s!.url, `/api/admin/invitations/${rc.corps.id}`, { cookie: admin, methode: "DELETE" })).status, 204);
		assert.equal(lire(donnees), null);
		// Contenu illisible : supprimé à la vérification suivante.
		fs.writeFileSync(lienDe(donnees), "n'importe quoi\n");
		await pause(400);
		assert.equal(lire(donnees), null);
	});

	// Premier admin (créé au test 2) : session par un lien de reconnexion de lien.ts, sans passer par l'interface.
	let cookieAdminMemo = "";
	async function cookieAdmin(): Promise<string> {
		if (cookieAdminMemo) return cookieAdminMemo;
		const r = lienTs(["--donnees", donnees, "reconnexion", "--admin", "--url", s!.url]);
		assert.equal(r.status, 0, r.stderr);
		const p = await appel(s!.url, cheminDe(r.stdout.trim()), { brut: "", entetes: FORM });
		assert.equal(p.status, 303);
		return cookieAdminMemo = cookieDe(p);
	}
});

describe("GET /api/sante (§ 1.1)", () => {
	test("200 {ok: true} sans authentification ; GET et HEAD seulement ; rien d'autre", async () => {
		const donnees = dossierTemp("35-sante");
		const s = await serveurTest(donnees, { test: false });
		try {
			const r = await appel(s.url, "/api/sante");
			assert.equal(r.status, 200); assert.equal(r.texte, '{"ok":true}');
			assert.equal(r.entetes.get("cache-control"), "no-store");
			assert.equal((await appel(s.url, "/api/sante", { methode: "HEAD" })).status, 200);
			assert.equal((await appel(s.url, "/api/sante", { corps: {} })).status, 404);
			assert.equal((await appel(s.url, "/api/sante?x=1")).status, 200);
		} finally { await s.arreter(); nettoyer(donnees); }
	});

	test("avec WDD_URL_PAGES : répond sur un hôte inconnu (avant le 421) et sur l'hôte des pages ; les routes nouvelles y sont en 404", async () => {
		const donnees = dossierTemp("35-sante-hotes");
		const port = await portLibre();
		const H = `retours.test:${port}`, P = `pages.test:${port}`;
		const s = await serveurTest(donnees, { port, url: `http://${H}`, urlPages: `http://${P}` });
		try {
			for (const hote of [`127.0.0.1:${port}`, "inconnu.example", H, P]) {
				const r = await appelHote(port, hote, "/api/sante");
				assert.equal(r.status, 200, hote); assert.deepEqual(r.corps, { ok: true });
			}
			assert.equal((await appelHote(port, `127.0.0.1:${port}`, "/api/moi")).status, 421, "toute autre route : 421 sur un hôte inconnu");
			assert.equal((await appelHote(port, `127.0.0.1:${port}`, "/api/sante", { corps: {} })).status, 421, "POST /api/sante : pas d'exception");
			// Routes nouvelles de ce lot sur l'hôte des pages : 404.
			const t = (chemin: string, corps: unknown) => appelHote(port, H, chemin, { corps, entetes: { "X-WDD": "1" } });
			assert.equal((await t("/__test/projet", { id: "jardin", titre: "Jardin" })).status, 201);
			const maud = "wdd_session=" + (await t("/__test/session", { projet: "jardin", compte: "maud", role: "mainteneur" })).corps.session;
			const jeton = (await appelHote(port, H, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent" } })).corps.jeton;
			assert.ok(/^wdd_/.test(jeton), "jeton créé");
			assert.equal((await appelHote(port, P, "/api/p/jardin/jeton", { bearer: jeton, methode: "DELETE" })).status, 404);
			assert.equal((await appelHote(port, P, "/api/p/jardin/membres/maud/reconnexion", { cookie: maud, corps: {} })).status, 404);
			assert.equal((await appelHote(port, P, "/api/admin/comptes/maud/reconnexion", { cookie: maud, corps: {} })).status, 404);
			assert.equal((await appelHote(port, H, "/api/p/jardin/session", { bearer: jeton })).status, 200, "le jeton vaut encore");
		} finally { await s.arreter(); nettoyer(donnees); }
	});
});

describe("jetons : expiration, origine, révocation de soi (§ 2.1)", () => {
	let s: Serveur, donnees: string, u: string, maud: string;
	before(async () => {
		donnees = dossierTemp("35-jetons");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin"); await projet(u, "verger");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("jeton expiré : refusé (401), listé expiré avec son origine ; date future : valable ; date illisible : refusé", async () => {
		const b = s.ctx.base;
		const passe = b.creerJeton("jardin", "Ponctuel", "mainteneur", "maud", { expire: new Date(Date.now() - 1000).toISOString(), origine: "appairé depuis poste-1 (127.0.0.1)" });
		const futur = b.creerJeton("jardin", "Ponctuel 2", "mainteneur", "maud", { expire: new Date(Date.now() + 3600 * 1000).toISOString() });
		const illisible = b.creerJeton("jardin", "Illisible", "agent", "maud", { expire: "bientôt" });
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: passe.jeton })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: illisible.jeton })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: futur.jeton })).corps.role, "mainteneur");
		const l = (await appel(u, "/api/p/jardin/jetons", { cookie: maud })).corps.jetons;
		const vu = (id: string) => l.find((j: any) => j.id === id);
		assert.equal(vu(passe.id).expiree, true); assert.equal(vu(passe.id).origine, "appairé depuis poste-1 (127.0.0.1)"); assert.equal(vu(passe.id).revoque, null);
		assert.equal(vu(futur.id).expiree, false); assert.match(vu(futur.id).expire, /^\d{4}-/); assert.equal(vu(futur.id).origine, "");
		assert.equal(vu(illisible.id).expiree, true);
		assert.ok(!JSON.stringify(l).includes("wdd_"), "liste sans secret");
	});

	test("jeton qui expire pendant un flux : le flux est coupé", async () => {
		const j = s.ctx.base.creerJeton("jardin", "Court", "agent", "maud", { expire: new Date(Date.now() + 2000).toISOString() });
		const e = await ecouter(s.port, "/api/p/jardin/flux", { bearer: j.jeton });
		assert.equal(e.status, 200);
		await Promise.race([e.ferme, pause(5000).then(() => { throw new Error("flux d'un jeton expiré toujours ouvert"); })]);
	});

	test("DELETE /api/p/<p>/jeton : le jeton se révoque lui-même (204, flux coupé, journal) ; session, autre projet, sans authentification : refusés", async () => {
		const c = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Import ponctuel", role: "mainteneur" } });
		const { id, jeton } = c.corps;
		assert.equal((await appel(u, "/api/p/verger/jeton", { bearer: jeton, methode: "DELETE" })).status, 403, "jeton d'un autre projet");
		assert.equal((await appel(u, "/api/p/jardin/jeton", { cookie: maud, methode: "DELETE" })).status, 403, "une session ne passe pas par cette route");
		assert.equal((await appel(u, "/api/p/jardin/jeton", { methode: "DELETE" })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jeton })).status, 200, "toujours valable après les refus");
		const e = await ecouter(s.port, "/api/p/jardin/flux", { bearer: jeton });
		const r = await appel(u, "/api/p/jardin/jeton", { bearer: jeton, methode: "DELETE" });
		assert.equal(r.status, 204); assert.equal(r.texte, "");
		await Promise.race([e.ferme, pause(2000).then(() => { throw new Error("flux du jeton révoqué toujours ouvert"); })]);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jeton })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/jeton", { bearer: jeton, methode: "DELETE" })).status, 401, "déjà révoqué");
		const l = (await appel(u, "/api/p/jardin/jetons", { cookie: maud })).corps.jetons.find((j: any) => j.id === id);
		assert.match(l.revoque, /^\d{4}-/);
		const ligne = s.ctx.base.lireJournal().find(x => x.action === "jeton révoqué" && x.cible === id);
		assert.ok(ligne); assert.equal(ligne.qui, "agent:" + id); assert.equal(ligne.pour, "maud"); assert.equal(JSON.parse(ligne.detail).par, "lui-même");
		assert.ok(!JSON.stringify(s.ctx.base.lireJournal(undefined, undefined, 1000)).includes(jeton), "jamais de jeton au journal");
	});
});

describe("liens de reconnexion (§ 2.4)", () => {
	let s: Serveur, donnees: string, u: string, adm: string, maud: string, camille: string, lea: string, agent: string;
	before(async () => {
		donnees = dossierTemp("35-reconnexion");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin"); await projet(u, "verger");
		adm = await session(u, "jardin", "adm", "admin", "Admin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		await session(u, "verger", "rose", "contributeur", "Rose");
		await session(u, "jardin", "noe", "contributeur", "Noé");
		await session(u, "jardin", "chef", "mainteneur", "Chef");
		await session(u, "jardin", "chef", "admin", "Chef"); // admin et mainteneur de jardin
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const nbComptes = () => s.ctx.base.comptes().length;

	test("mainteneur → lien pour un membre ; la page ne demande pas de nom ; session pour le compte existant ; usage unique ; journal", async () => {
		const r = await appel(u, "/api/p/jardin/membres/camille/reconnexion", { cookie: maud, corps: {} });
		assert.equal(r.status, 201, r.texte);
		assert.match(r.corps.lien, /^\/invitation\/[A-Za-z0-9_-]{43}$/);
		assert.ok(r.corps.url === u + r.corps.lien, "url = adresse publique + lien");
		assert.deepEqual([r.corps.compte, r.corps.projet, r.corps.role], [{ id: "camille", nom: "Camille" }, "jardin", "reconnexion"]);
		assert.ok(Math.abs(Date.parse(r.corps.expire) - Date.now() - 7 * JOUR) < 60000, "7 jours");
		assert.equal((await appel(u, "/api/p/jardin/membres/camille/reconnexion", { cookie: maud, methode: "POST" })).status, 201, "sans corps aussi");
		// Listé parmi les invitations du projet, avec le compte visé.
		const lm = (await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps;
		// Chaque membre dit s'il est admin (l'interface ne propose pas de lien pour lui : la route le refuse en 403).
		assert.deepEqual(lm.membres.filter((x: any) => x.admin).map((x: any) => x.compte), ["chef"]);
		assert.ok(lm.membres.every((x: any) => typeof x.admin === "boolean"));
		assert.equal((await appel(u, "/api/p/jardin/membres/chef/reconnexion", { cookie: maud, corps: {} })).status, 403);
		const inv = lm.invitations.find((i: any) => i.id === r.corps.id);
		assert.deepEqual([inv.role, inv.compte_cible, inv.compte_cible_nom, inv.par], ["reconnexion", "camille", "Camille", "maud"]);
		// GET : page sans champ de nom, avec un bouton ; ne consomme rien.
		const avant = nbComptes();
		for (let i = 0; i < 2; i++) {
			const g = await appel(u, r.corps.lien);
			assert.equal(g.status, 200); assert.match(g.texte, /<form method="post">/); assert.doesNotMatch(g.texte, /name="nom"/); assert.match(g.texte, /Camille/);
		}
		// POST : formulaire vide (ni X-WDD ni nom) → session de camille, 303 vers « / ».
		const p = await appel(u, r.corps.lien, { brut: "", entetes: FORM });
		assert.equal(p.status, 303); assert.equal(p.entetes.get("location"), "/");
		const nouveau = cookieDe(p);
		assert.match(p.entetes.get("set-cookie") || "", /^wdd_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
		const se = await appel(u, "/api/p/jardin/session", { cookie: nouveau });
		assert.equal(se.corps.id, "camille"); assert.equal(se.corps.role, "contributeur");
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: camille })).status, 200, "l'ancienne session reste");
		assert.equal(nbComptes(), avant, "aucun compte créé");
		// Usage unique.
		assert.equal((await appel(u, r.corps.lien)).status, 404);
		assert.equal((await appel(u, r.corps.lien, { brut: "", entetes: FORM })).status, 404);
		assert.equal((await appel(u, r.corps.lien, { corps: { nom: "Autre" } })).status, 404);
		// Journal : création et utilisation, l'id du lien seulement.
		const j = s.ctx.base.lireJournal(undefined, undefined, 1000);
		assert.ok(j.some(e => e.action === "reconnexion créée" && e.qui === "maud" && e.cible === "camille" && e.projet === "jardin" && JSON.parse(e.detail).invitation === r.corps.id));
		assert.ok(j.some(e => e.action === "reconnexion utilisée" && e.qui === "camille" && e.cible === r.corps.id));
		assert.ok(!JSON.stringify(j).includes(r.corps.lien.split("/").pop()), "jamais de lien au journal");
		// Origin d'un autre site : refusé.
		const r2 = await appel(u, "/api/p/jardin/membres/camille/reconnexion", { cookie: maud, corps: {} });
		assert.equal((await appel(u, r2.corps.lien, { brut: "", origin: "https://mechant.example", entetes: FORM })).status, 403);
		// Un lien de reconnexion ne crée jamais de compte, même par la fonction d'acceptation d'une invitation.
		assert.equal(s.ctx.base.accepterInvitation(r2.corps.lien.split("/").pop(), "Intrus"), undefined);
		assert.equal((await appel(u, r2.corps.lien)).status, 200, "toujours valable");
	});

	test("route du mainteneur : refus (admin, non-membre, contributeur, lecteur, jeton, sans session, corps, CSRF)", async () => {
		const route = (c: string) => `/api/p/jardin/membres/${c}/reconnexion`;
		assert.equal((await appel(u, route("chef"), { cookie: maud, corps: {} })).status, 403, "membre admin : par l'administration");
		assert.equal((await appel(u, route("rose"), { cookie: maud, corps: {} })).status, 404, "pas membre de jardin");
		assert.equal((await appel(u, route("personne"), { cookie: maud, corps: {} })).status, 404);
		assert.equal((await appel(u, route("lea"), { cookie: camille, corps: {} })).status, 403, "contributeur");
		assert.equal((await appel(u, route("camille"), { cookie: lea, corps: {} })).status, 403, "lecteur");
		assert.equal((await appel(u, route("camille"), { bearer: agent, corps: {} })).status, 403, "jeton");
		assert.equal((await appel(u, route("camille"), { corps: {} })).status, 401);
		assert.equal((await appel(u, route("camille"), { cookie: maud, corps: { expire: "2030-01-01T00:00:00Z" } })).status, 400, "aucun paramètre");
		assert.equal((await appel(u, route("camille"), { cookie: maud, corps: {}, xwdd: false })).status, 403, "anti-CSRF");
		assert.equal((await appel(u, "/api/p/verger/membres/rose/reconnexion", { cookie: maud, corps: {} })).status, 403, "mainteneur d'un autre projet");
		// L'admin passe aussi par la route du projet, pour un membre non admin.
		assert.equal((await appel(u, route("lea"), { cookie: adm, corps: {} })).status, 201);
	});

	test("route admin : tout compte, admin compris ; refus pour un non-admin, un jeton, un compte inconnu", async () => {
		for (const c of ["chef", "adm", "rose"]) {
			const r = await appel(u, `/api/admin/comptes/${c}/reconnexion`, { cookie: adm, corps: {} });
			assert.equal(r.status, 201, r.texte); assert.equal(r.corps.projet, null); assert.equal(r.corps.compte.id, c);
		}
		const r = await appel(u, "/api/admin/comptes/chef/reconnexion", { cookie: adm, methode: "POST" });
		const p = await appel(u, r.corps.lien, { brut: "", entetes: FORM });
		assert.equal(p.status, 303);
		const moi = await appel(u, "/api/moi", { cookie: cookieDe(p) });
		assert.equal(moi.corps.compte.id, "chef"); assert.equal(moi.corps.compte.admin, true);
		assert.equal((await appel(u, "/api/admin/comptes/personne/reconnexion", { cookie: adm, corps: {} })).status, 404);
		assert.equal((await appel(u, "/api/admin/comptes/camille/reconnexion", { cookie: maud, corps: {} })).status, 403);
		assert.equal((await appel(u, "/api/admin/comptes/camille/reconnexion", { bearer: agent, corps: {} })).status, 403);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "reconnexion créée" && e.qui === "adm" && e.cible === "rose" && e.projet === ""));
	});

	test("compte désactivé : création refusée ; ses liens en attente annulés ; un lien qui le vise est refusé sans être consommé", async () => {
		const lien = (await appel(u, "/api/admin/comptes/rose/reconnexion", { cookie: adm, corps: {} })).corps;
		const d = await appel(u, "/api/admin/comptes/rose", { cookie: adm, methode: "PATCH", corps: { desactive: true } });
		assert.equal(d.status, 200); assert.ok(d.corps.invitations_annulees.includes(lien.id), "lien qui le vise annulé");
		assert.equal((await appel(u, lien.lien)).status, 404);
		assert.equal((await appel(u, lien.lien, { brut: "", entetes: FORM })).status, 404);
		assert.equal((await appel(u, "/api/admin/comptes/rose/reconnexion", { cookie: adm, corps: {} })).status, 400, "création refusée");
		assert.equal((await appel(u, "/api/admin/comptes/rose", { cookie: adm, methode: "PATCH", corps: { desactive: false } })).status, 200);
		assert.equal((await appel(u, lien.lien)).status, 404, "réactivé : l'ancien lien ne revient pas");
		// Désactivé en base sans passer par l'API (aucune annulation) : la page et le POST refusent, le lien reste.
		const l2 = (await appel(u, "/api/p/jardin/membres/noe/reconnexion", { cookie: maud, corps: {} })).corps;
		s.ctx.base.db.prepare("UPDATE comptes SET desactive = ? WHERE id = 'noe'").run(new Date().toISOString());
		assert.equal((await appel(u, l2.lien)).status, 403);
		const p = await appel(u, l2.lien, { brut: "", entetes: FORM });
		assert.equal(p.status, 403); assert.equal(p.corps.code, "permission_denied"); assert.equal(p.entetes.get("set-cookie"), null);
		assert.equal((await appel(u, "/api/p/jardin/membres/noe/reconnexion", { cookie: maud, corps: {} })).status, 400, "création refusée par la route du projet");
		s.ctx.base.db.prepare("UPDATE comptes SET desactive = NULL WHERE id = 'noe'").run();
		assert.equal((await appel(u, l2.lien, { brut: "", entetes: FORM })).status, 303, "non consommé par le refus");
	});

	test("retrait du projet et annulation : le lien ne vaut plus", async () => {
		const a = (await appel(u, "/api/p/jardin/membres/noe/reconnexion", { cookie: maud, corps: {} })).corps;
		const d = await appel(u, "/api/p/jardin/membres/noe", { cookie: maud, methode: "DELETE" });
		assert.equal(d.status, 200); assert.ok(d.corps.invitations_annulees.includes(a.id));
		assert.equal((await appel(u, a.lien)).status, 404);
		const b = (await appel(u, "/api/p/jardin/membres/camille/reconnexion", { cookie: maud, corps: {} })).corps;
		assert.equal((await appel(u, `/api/p/jardin/invitations/${b.id}`, { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, b.lien, { brut: "", entetes: FORM })).status, 404);
	});

	// Relecture : un lien créé par un mainteneur ne devient jamais une session admin.
	test("cible nommée admin : les liens de reconnexion de projet qui la visent sont annulés ; en base sans l'API, le lien est refusé sans être consommé", async () => {
		await session(u, "jardin", "zoe", "contributeur", "Zoé");
		const l = (await appel(u, "/api/p/jardin/membres/zoe/reconnexion", { cookie: maud, corps: {} })).corps;
		// Celui de l'administration (créé par un admin) reste valable.
		const la = (await appel(u, "/api/admin/comptes/zoe/reconnexion", { cookie: adm, corps: {} })).corps;
		const p = await appel(u, "/api/admin/comptes/zoe", { cookie: adm, methode: "PATCH", corps: { admin: true } });
		assert.equal(p.status, 200); assert.deepEqual(p.corps.invitations_annulees, [l.id]);
		assert.equal((await appel(u, l.lien)).status, 404);
		const u1 = await appel(u, l.lien, { brut: "", entetes: FORM });
		assert.equal(u1.status, 404); assert.equal(u1.entetes.get("set-cookie"), null);
		assert.equal((await appel(u, la.lien)).status, 200, "lien de l'administration gardé");
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "compte modifié" && e.cible === "zoe" && JSON.parse(e.detail).invitations_annulees?.includes(l.id)));
		// Admin en base, sans passer par l'API (aucune annulation) : page et POST refusés (403), lien non consommé.
		await session(u, "jardin", "yan", "contributeur", "Yan");
		const l2 = (await appel(u, "/api/p/jardin/membres/yan/reconnexion", { cookie: maud, corps: {} })).corps;
		s.ctx.base.db.prepare("UPDATE comptes SET admin = 1 WHERE id = 'yan'").run();
		assert.equal((await appel(u, l2.lien)).status, 403);
		const u2 = await appel(u, l2.lien, { brut: "", entetes: FORM });
		assert.equal(u2.status, 403); assert.equal(u2.corps.code, "permission_denied"); assert.equal(u2.entetes.get("set-cookie"), null);
		s.ctx.base.db.prepare("UPDATE comptes SET admin = 0 WHERE id = 'yan'").run();
		assert.equal((await appel(u, l2.lien, { brut: "", entetes: FORM })).status, 303, "non consommé par le refus");
	});

	test("membre d'un autre projet que le mainteneur ne gère pas : création refusée (403), et revérifié à l'utilisation", async () => {
		const route = (c: string) => `/api/p/jardin/membres/${c}/reconnexion`;
		await session(u, "jardin", "gael", "contributeur", "Gaël"); await session(u, "verger", "gael", "mainteneur", "Gaël");
		await session(u, "jardin", "hugo", "contributeur", "Hugo"); await session(u, "verger", "hugo", "lecteur", "Hugo");
		await session(u, "jardin", "ines", "contributeur", "Inès");
		const vic = await session(u, "jardin", "vic", "mainteneur", "Vic"); await session(u, "verger", "vic", "mainteneur", "Vic");
		const r = await appel(u, route("gael"), { cookie: maud, corps: {} });
		assert.equal(r.status, 403); assert.equal(r.corps.code, "permission_denied"); assert.match(r.corps.message, /administration/);
		assert.equal((await appel(u, route("hugo"), { cookie: maud, corps: {} })).status, 403, "même lecteur ailleurs");
		assert.equal((await appel(u, route("gael"), { cookie: vic, corps: {} })).status, 201, "mainteneur des deux projets");
		assert.equal((await appel(u, route("gael"), { cookie: adm, corps: {} })).status, 201, "admin");
		// Rôle reçu ailleurs après la création : le lien est refusé (page et POST), sans être consommé.
		const l = (await appel(u, route("ines"), { cookie: maud, corps: {} })).corps;
		await session(u, "verger", "ines", "contributeur", "Inès");
		assert.equal((await appel(u, l.lien)).status, 403);
		const p = await appel(u, l.lien, { brut: "", entetes: FORM });
		assert.equal(p.status, 403); assert.equal(p.entetes.get("set-cookie"), null);
		s.ctx.base.retirerRole("ines", "verger");
		// Créateur qui n'est plus mainteneur du projet (en base, sans l'annulation de l'API) : refusé aussi.
		s.ctx.base.donnerRole("maud", "jardin", "contributeur");
		assert.equal((await appel(u, l.lien, { brut: "", entetes: FORM })).status, 403, "créateur rétrogradé");
		s.ctx.base.donnerRole("maud", "jardin", "mainteneur");
		// Cible qui n'est plus membre du projet du lien : refusé.
		s.ctx.base.retirerRole("ines", "jardin");
		assert.equal((await appel(u, l.lien, { brut: "", entetes: FORM })).status, 403, "cible retirée");
		s.ctx.base.donnerRole("ines", "jardin", "contributeur");
		const ok = await appel(u, l.lien, { brut: "", entetes: FORM });
		assert.equal(ok.status, 303, "droits revenus : le lien sert");
		assert.equal((await appel(u, "/api/moi", { cookie: cookieDe(ok) })).corps.compte.id, "ines");
	});
});

// Lance serveur/src/lien.ts sans aucune variable WDD_* de l'environnement (sauf celles données).
function lienTs(args: string[], env: Record<string, string> = {}) {
	const propre: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("WDD_")) propre[k] = v;
	const r = spawnSync(process.execPath, [path.join(RACINE_OUTIL, "serveur", "src", "lien.ts"), ...args], { encoding: "utf8", env: { ...propre, ...env }, timeout: 30000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("serveur/src/lien.ts (§ 2.4)", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => {
		donnees = dossierTemp("35-lien-ts");
		s = await serveurTest(donnees, { verifLienMs: 100 });
		u = s.url;
		await projet(u, "jardin");
		await session(u, "jardin", "adm", "admin", "Admin");
		await session(u, "jardin", "camille", "contributeur", "Camille");
		await session(u, "jardin", "zoe", "contributeur", "Zoé");
		assert.equal((await appel(u, "/api/admin/comptes/zoe", { cookie: await session(u, "jardin", "adm", "admin", "Admin"), methode: "PATCH", corps: { desactive: true } })).status, 200);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("--admin, serveur en marche : lien sur la sortie et dans lien-admin.txt ; il donne une session au premier admin ; fichier supprimé après usage", async () => {
		const r = lienTs(["--donnees", donnees, "reconnexion", "--admin", "--url", "http://retours.test"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(/^http:\/\/retours\.test\/invitation\/[A-Za-z0-9_-]{43}\n$/.test(r.stdout), "sortie : le lien seul, sur une ligne");
		assert.ok(lire(donnees) === r.stdout, "même lien dans lien-admin.txt");
		if (process.platform !== "win32") assert.equal(fs.statSync(lienDe(donnees)).mode & 0o777, 0o600);
		assert.match(r.stderr, /Admin \(adm, admin\)/); assert.ok(!r.stderr.includes(r.stdout.trim()), "le lien n'est pas sur la sortie d'erreur");
		const chemin = cheminDe(r.stdout.trim());
		assert.equal((await appel(u, chemin)).status, 200);
		const p = await appel(u, chemin, { brut: "", entetes: FORM });
		assert.equal(p.status, 303);
		assert.equal((await appel(u, "/api/moi", { cookie: cookieDe(p) })).corps.compte.id, "adm");
		assert.equal(lire(donnees), null, "fichier supprimé quand le lien a servi");
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "reconnexion créée" && e.qui === "lien.ts" && e.cible === "adm"));
	});

	test("--compte, origine du lien : --port, WDD_URL, défaut 127.0.0.1:8080", async () => {
		const a = lienTs(["--donnees", donnees, "reconnexion", "--compte", "camille", "--port", "4321"]);
		assert.equal(a.status, 0, a.stderr); assert.ok(a.stdout.startsWith("http://127.0.0.1:4321/invitation/"), "--port");
		const b = lienTs(["reconnexion", "--compte", "camille"], { WDD_DONNEES: donnees, WDD_URL: "https://retours.exemple.fr/" });
		assert.equal(b.status, 0, b.stderr); assert.ok(b.stdout.startsWith("https://retours.exemple.fr/invitation/"), "WDD_URL");
		const c = lienTs(["--donnees", donnees, "reconnexion", "--compte", "camille"]);
		assert.equal(c.status, 0, c.stderr); assert.ok(c.stdout.startsWith("http://127.0.0.1:8080/invitation/"), "défaut");
		const p = await appel(u, cheminDe(c.stdout.trim()), { brut: "", entetes: FORM });
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: cookieDe(p) })).corps.id, "camille");
		// Les liens précédents restent valables (le fichier ne garde que le dernier).
		assert.equal((await appel(u, cheminDe(a.stdout.trim()))).status, 200);
	});

	test("refus (1) et usage (2) : compte inconnu ou désactivé, aucun admin actif, base absente, arguments", async () => {
		const avant = lire(donnees);
		assert.equal(lienTs(["--donnees", donnees, "reconnexion", "--compte", "personne"]).status, 1);
		const z = lienTs(["--donnees", donnees, "reconnexion", "--compte", "zoe"]);
		assert.equal(z.status, 1); assert.match(z.stderr, /désactivé/); assert.equal(z.stdout, "");
		const vide = dossierTemp("35-lien-ts-vide");
		try {
			assert.equal(lienTs(["--donnees", vide, "reconnexion", "--admin"]).status, 1, "base absente");
			assert.deepEqual(fs.readdirSync(vide), [], "aucune base créée");
			new Base(vide).fermer(); // base sans compte
			const r = lienTs(["--donnees", vide, "reconnexion", "--admin"]);
			assert.equal(r.status, 1); assert.match(r.stderr, /aucun administrateur actif/);
		} finally { nettoyer(vide); }
		for (const args of [[], ["--donnees", donnees], ["--donnees", donnees, "reconnexion"], ["--donnees", donnees, "reconnexion", "--admin", "--compte", "adm"],
			["--donnees", donnees, "autre", "--admin"], ["reconnexion", "--admin"], ["--donnees", donnees, "reconnexion", "--admin", "--url", "http://x/chemin"],
			["--donnees", donnees, "reconnexion", "--admin", "--port", "0"], ["--donnees", donnees, "reconnexion", "--admin", "--url", "http://x", "--port", "1"],
			["--donnees", donnees, "reconnexion", "--compte"]]) {
			const r = lienTs(args);
			assert.equal(r.status, 2, args.join(" ")); assert.match(r.stderr, /usage :/); assert.equal(r.stdout, "");
		}
		assert.ok(lire(donnees) === avant, "fichier inchangé par les refus");
	});
});

describe("session prolongée à l'usage (§ 2.4)", () => {
	test("hôte principal : moins de 15 jours restants → 30 jours, même cookie, Set-Cookie avec le nouveau Max-Age ; sinon rien", async () => {
		const donnees = dossierTemp("35-prolongee");
		const s = await serveurTest(donnees);
		try {
			const u = s.url;
			await projet(u, "jardin");
			const cookie = await session(u, "jardin", "camille", "contributeur", "Camille");
			const v = cookie.split("=")[1], h = hacher(v);
			const fin = () => Date.parse((s.ctx.base.db.prepare("SELECT expire FROM sessions WHERE hash = ?").get(h) as { expire: string }).expire) - Date.now();
			const poser = (ms: number) => s.ctx.base.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(Date.now() + ms).toISOString(), h);
			const attendu = `wdd_session=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
			// 20 jours restants : rien.
			poser(20 * JOUR);
			let r = await appel(u, "/api/p/jardin/session", { cookie });
			assert.equal(r.status, 200); assert.equal(r.entetes.get("set-cookie"), null);
			assert.ok(Math.abs(fin() - 20 * JOUR) < 60000);
			// 10 jours restants : prolongée, sur une réponse JSON…
			poser(10 * JOUR);
			r = await appel(u, "/api/p/jardin/session", { cookie });
			assert.equal(r.status, 200); assert.ok(r.entetes.get("set-cookie") === attendu, "Set-Cookie : même valeur, Max-Age de 30 jours");
			assert.ok(Math.abs(fin() - 30 * JOUR) < 60000, "30 jours en base");
			assert.equal((await appel(u, "/api/p/jardin/session", { cookie })).entetes.get("set-cookie"), null, "une seule fois");
			// … sur une écriture (201) et sur une page HTML.
			poser(JOUR);
			r = await appel(u, "/api/p/jardin/retours", { cookie, corps: docRetour() });
			assert.equal(r.status, 201); assert.ok(r.entetes.get("set-cookie") === attendu, "sur une écriture");
			poser(JOUR);
			r = await appel(u, "/p/jardin/", { cookie });
			assert.ok(r.entetes.get("set-cookie") === attendu, "sur une page HTML");
			// Flux SSE : le cookie part avec les en-têtes ; les vérifications à chaque ping ne prolongent rien.
			poser(JOUR);
			const e = await ecouter(s.port, "/api/p/jardin/flux", cookie);
			assert.equal(e.status, 200); e.fermer();
			assert.ok(Math.abs(fin() - 30 * JOUR) < 60000);
			// Expirée : 401, rien de posé ; deux wdd_session : aucune session, rien de posé ; Bearer prioritaire : rien.
			poser(10 * JOUR);
			r = await appel(u, "/api/p/jardin/session", { cookie: `${cookie}; wdd_session=autre` });
			assert.equal(r.status, 401); assert.equal(r.entetes.get("set-cookie"), null);
			const jeton = (await appel(u, "/api/admin/jetons", { cookie: await session(u, "jardin", "adm", "admin"), corps: { projet: "jardin", nom: "A" } })).corps.jeton;
			r = await appel(u, "/api/p/jardin/session", { cookie, bearer: jeton });
			assert.equal(r.status, 200); assert.equal(r.entetes.get("set-cookie"), null);
			poser(-1000);
			r = await appel(u, "/api/p/jardin/session", { cookie });
			assert.equal(r.status, 401); assert.equal(r.entetes.get("set-cookie"), null);
			// Compte désactivé (en base, sessions gardées) : rien de prolongé.
			const c2 = await session(u, "jardin", "lea", "contributeur", "Léa");
			const h2 = hacher(c2.split("=")[1]);
			s.ctx.base.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(Date.now() + JOUR).toISOString(), h2);
			s.ctx.base.db.prepare("UPDATE comptes SET desactive = ? WHERE id = 'lea'").run(new Date().toISOString());
			r = await appel(u, "/api/p/jardin/session", { cookie: c2 });
			assert.equal(r.status, 401); assert.equal(r.entetes.get("set-cookie"), null);
		} finally { await s.arreter(); nettoyer(donnees); }
	});

	test("hôte des pages : la session wdd_pages du projet de l'adresse est prolongée, cookie reposé avec ses deux Path", async () => {
		const donnees = dossierTemp("35-prolongee-pages");
		const port = await portLibre();
		const H = `127.0.0.1:${port}`, P = `localhost:${port}`;
		const s = await serveurTest(donnees, { port, url: `http://${H}`, urlPages: `http://${P}` });
		try {
			await projet(`http://${H}`, "jardin"); await projet(`http://${H}`, "verger");
			await session(`http://${H}`, "jardin", "camille", "contributeur", "Camille");
			await session(`http://${H}`, "verger", "camille", "contributeur", "Camille");
			const b = s.ctx.base;
			const sp = b.creerSessionPages("camille", "jardin");
			const fin = (j: string) => Date.parse((b.db.prepare("SELECT expire FROM sessions_pages WHERE hash = ?").get(hacher(j)) as { expire: string }).expire) - Date.now();
			const poser = (j: string, ms: number) => b.db.prepare("UPDATE sessions_pages SET expire = ? WHERE hash = ?").run(new Date(Date.now() + ms).toISOString(), hacher(j));
			poser(sp.jeton, 10 * JOUR);
			// Adresse d'un autre projet : rien (le cookie n'y vaut pas).
			let r = await appelHote(port, P, "/api/p/verger/session", { cookie: "wdd_pages=" + sp.jeton });
			assert.equal(r.status, 401); assert.deepEqual(r.setCookie, []);
			assert.ok(Math.abs(fin(sp.jeton) - 10 * JOUR) < 60000);
			r = await appelHote(port, P, "/api/p/jardin/session", { cookie: "wdd_pages=" + sp.jeton });
			assert.equal(r.status, 200);
			const attendus = [`wdd_pages=${sp.jeton}; Path=/p/jardin/; HttpOnly; SameSite=Lax; Max-Age=2592000`, `wdd_pages=${sp.jeton}; Path=/api/p/jardin/; HttpOnly; SameSite=Lax; Max-Age=2592000`];
			assert.ok(JSON.stringify(r.setCookie) === JSON.stringify(attendus), "deux cookies, même valeur, Max-Age de 30 jours");
			assert.ok(Math.abs(fin(sp.jeton) - 30 * JOUR) < 60000);
			// Sur la page aussi (/p/<projet>/).
			poser(sp.jeton, JOUR);
			r = await appelHote(port, P, "/p/jardin/", { cookie: "wdd_pages=" + sp.jeton });
			assert.ok(JSON.stringify(r.setCookie) === JSON.stringify(attendus), "sur la page");
			// wdd_session n'est pas prolongée sur l'hôte des pages (elle n'y vaut rien).
			const cookie = await session(`http://${H}`, "jardin", "camille", "contributeur", "Camille");
			b.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(Date.now() + JOUR).toISOString(), hacher(cookie.split("=")[1]));
			r = await appelHote(port, P, "/api/p/jardin/session", { cookie });
			assert.equal(r.status, 401); assert.deepEqual(r.setCookie, []);
			assert.equal((await appelHote(port, H, "/api/p/jardin/session", { cookie })).setCookie.length, 1, "prolongée sur l'hôte principal");
			// Relecture : une réponse qui porte le cookie prolongé n'est jamais gardée par un cache partagé (redirections et
			// 204 sans Cache-Control propre compris).
			b.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(Date.now() + JOUR).toISOString(), hacher(cookie.split("=")[1]));
			assert.match(String((await appelHote(port, H, "/p/jardin", { cookie })).entetes["cache-control"]), /\bno-store\b/, "301 de l'hôte principal");
			poser(sp.jeton, JOUR);
			r = await appelHote(port, P, "/p/jardin", { cookie: "wdd_pages=" + sp.jeton });
			assert.equal(r.status, 301); assert.equal(r.setCookie.length, 2);
			assert.match(String(r.entetes["cache-control"]), /\bno-store\b/, "301 de l'hôte des pages");
		} finally { await s.arreter(); nettoyer(donnees); }
	});

	test("réponse qui porte le cookie prolongé : jamais gardée par un cache partagé (fichiers de l'interface, redirection, 204)", async () => {
		const donnees = dossierTemp("35-prolongee-cache");
		const s = await serveurTest(donnees);
		try {
			const u = s.url;
			await projet(u, "jardin");
			const cookie = await session(u, "jardin", "camille", "contributeur", "Camille");
			const h = hacher(cookie.split("=")[1]);
			for (const chemin of ["/", "/ui.js", "/ui.css", "/js/api.js", "/icone.svg", "/p/jardin", "/favicon.ico", "/api/moi"]) {
				s.ctx.base.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run(new Date(Date.now() + JOUR).toISOString(), h);
				const r = await appel(u, chemin, { cookie });
				assert.ok(r.status < 400, `${chemin} : ${r.status}`);
				assert.ok(r.entetes.get("set-cookie") !== null, `${chemin} : cookie prolongé`);
				assert.match(r.entetes.get("cache-control") || "", /\b(private|no-store)\b/, `${chemin} : Cache-Control`);
			}
			// Sans prolongation, un fichier de l'interface reste revalidé, gardé par le navigateur seulement.
			const r = await appel(u, "/ui.js");
			assert.equal(r.entetes.get("cache-control"), "private, no-cache");
		} finally { await s.arreter(); nettoyer(donnees); }
	});
});

// Relecture : montée de version faite par deux processus en même temps (lien.ts et le serveur, juste après une mise
// à jour). Le second voyait les colonnes absentes, puis son ALTER échouait (« duplicate column name »).
describe("montée de version concurrente (§ 1.1)", () => {
	test("un autre processus ajoute les colonnes pendant que Base s'ouvre : Base attend le verrou et ne les rajoute pas", async () => {
		const donnees = dossierTemp("35-migration-concurrente");
		try {
			// Base de l'étape 3 dont les tables nouvelles existent déjà (un premier processus vient de les créer).
			const db0 = new DatabaseSync(path.join(donnees, "outil.sqlite"));
			db0.exec(SCHEMA_ETAPE3);
			db0.close();
			new Base(donnees).fermer();
			const db = new DatabaseSync(path.join(donnees, "outil.sqlite"));
			db.exec("ALTER TABLE jetons DROP COLUMN expire; ALTER TABLE jetons DROP COLUMN origine; ALTER TABLE invitations DROP COLUMN compte_cible;");
			// L'autre processus : verrou d'écriture pris, colonnes ajoutées, pas encore validé.
			db.exec("BEGIN IMMEDIATE");
			db.exec("ALTER TABLE jetons ADD COLUMN expire TEXT; ALTER TABLE jetons ADD COLUMN origine TEXT NOT NULL DEFAULT ''; ALTER TABLE invitations ADD COLUMN compte_cible TEXT;");
			const code = `import { Base } from ${JSON.stringify("file:///" + path.join(RACINE_OUTIL, "serveur", "src", "base.ts").replace(/\\/g, "/"))};
				try { new Base(process.argv[1]).fermer(); console.log("ok"); } catch (e) { console.log("erreur : " + e.message); process.exitCode = 1; }`;
			const enfant = spawn(process.execPath, ["--input-type=module", "-e", code, donnees], { stdio: ["ignore", "pipe", "pipe"] });
			let sortie = "";
			enfant.stdout.on("data", d => sortie += d); enfant.stderr.on("data", d => sortie += d);
			const fin = new Promise<number | null>(ok => enfant.on("close", ok));
			await pause(2000); // l'enfant a démarré et attend le verrou (busy_timeout de 5 s)
			db.exec("COMMIT");
			db.close();
			assert.equal(await fin, 0, sortie);
			assert.equal(sortie.trim(), "ok");
			const b = new Base(donnees);
			const colonnes = (b.db.prepare("PRAGMA table_info(jetons)").all() as { name: string }[]).map(c => c.name);
			assert.deepEqual(colonnes.filter(c => c === "expire" || c === "origine"), ["expire", "origine"]);
			b.fermer();
		} finally { nettoyer(donnees); }
	});
});
