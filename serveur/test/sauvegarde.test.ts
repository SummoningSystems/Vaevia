// Étape 3.7, A1 (docs/etape3-7-dix-premieres.md) : sauvegarde à chaud (bouton de l'Administration, planifiée),
// rotation, restauration vérifiée (manifeste, verrou, contrôles, retour arrière).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, docRetour, dossierTemp, nettoyer, serveurTest, projet, session, pause, git } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL, lireConfig } from "../src/config.ts";
import { tournerSauvegardes, NOM_SAUVEGARDE } from "../src/sauvegarde.ts";
import { restaurer, verifierSauvegarde } from "../src/restaurer.ts";

const exemple = () => fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
const nbRetours = async (u: string, cookie: string) => (await appel(u, "/api/p/jardin/retours", { cookie })).corps.docs.length;

describe("sauvegarde et restauration", () => {
	let racine: string, donnees: string, s: Serveur, u: string, adm: string, cam: string, sauv: string;
	before(async () => {
		racine = dossierTemp("sauvegarde");
		donnees = path.join(racine, "donnees");
		sauv = path.join(racine, "mes-sauvegardes");
		s = await serveurTest(donnees, { sauvegarde: sauv }); u = s.url;
		await projet(u, "jardin");
		adm = await session(u, "jardin", "adm", "admin", "Adèle");
		cam = await session(u, "jardin", "camille", "contributeur", "Camille");
		for (let i = 0; i < 3; i++) assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: cam, corps: docRetour({ text: "Retour " + i }) })).status, 201);
		assert.equal((await appel(u, "/api/p/jardin/builds", { cookie: adm, brut: exemple(), entetes: { "Content-Type": "application/json" } })).status, 201);
	});
	after(async () => { await s?.arreter().catch(() => { }); nettoyer(racine); });

	test("état : dossier configuré, aucune sauvegarde ; réservé à l'admin en session", async () => {
		const e = await appel(u, "/api/admin/sauvegarde", { cookie: adm });
		assert.equal(e.status, 200, e.texte);
		assert.equal(e.corps.dossier, sauv); assert.equal(e.corps.derniere, null); assert.equal(e.corps.en_cours, false);
		assert.equal((await appel(u, "/api/admin/sauvegarde", { cookie: cam, corps: {} })).status, 403);
		assert.equal((await appel(u, "/api/admin/sauvegarde", { corps: {} })).status, 401);
	});

	let premiere = "";
	test("sauvegarde pendant des écritures : complète, manifeste vérifiable, journal d'audit", async () => {
		const ecritures = Array.from({ length: 12 }, (_, i) => appel(u, "/api/p/jardin/retours", { cookie: cam, corps: docRetour({ text: "Pendant " + i }) }));
		const r = await appel(u, "/api/admin/sauvegarde", { cookie: adm, corps: {} });
		assert.equal(r.status, 201, r.texte);
		for (const e of await Promise.all(ecritures)) assert.equal(e.status, 201);
		premiere = r.corps.sauvegarde.nom;
		assert.match(premiere, NOM_SAUVEGARDE);
		assert.equal(r.corps.derniere.ok, true); assert.equal(r.corps.derniere.nom, premiere);
		const dir = path.join(sauv, premiere);
		const v = verifierSauvegarde(dir);
		assert.ok("manifeste" in v, JSON.stringify(v));
		const f = Object.keys((v as any).manifeste.fichiers);
		assert.ok(f.includes("outil.sqlite"));
		assert.ok(f.some(x => x.startsWith("projets/jardin/depot/.git/")), "dépôt Git copié");
		assert.ok(f.includes("projets/jardin/builds/1/page.html") && f.includes("projets/jardin/builds/1/data.json"), "build copié");
		assert.ok(!f.some(x => /serveur\.verrou|lien-admin|gitconfig/.test(x)), "ni verrou, ni lien admin, ni gitconfig");
		assert.ok(!fs.readdirSync(sauv).some(n => n.endsWith(".partiel")), "aucun reste partiel");
		// Le dépôt copié est un dépôt Git valide, propre, au commit d'un instant cohérent.
		// --no-optional-locks : git status ne réécrit pas .git/index (la sauvegarde resterait sinon « altérée »).
		assert.equal(git(path.join(dir, "projets", "jardin", "depot"), "--no-optional-locks", "status", "--porcelain").trim(), "");
		assert.ok("manifeste" in verifierSauvegarde(dir), "sauvegarde intacte après la vérification");
		const j = await appel(u, "/api/admin/journal", { cookie: adm });
		assert.ok(JSON.stringify(j.corps).includes('"sauvegarde"'), "action « sauvegarde » au journal d'audit");
	});

	test("restauration dans un dossier neuf : retours, comptes, sessions et Wiki relus par un serveur", async () => {
		const neuf = path.join(racine, "restaure");
		const b = await restaurer(path.join(sauv, premiere), neuf);
		assert.equal(b.ok, true, b.message); assert.equal(b.avant, "");
		const s2 = await serveurTest(neuf, { sauvegarde: path.join(racine, "sauv2") });
		try {
			const n = await nbRetours(s2.url, cam);
			assert.ok(n >= 3 && n <= 15, "les retours de la sauvegarde : " + n);
			assert.equal((await appel(s2.url, "/api/moi", { cookie: adm })).corps.compte?.id ?? (await appel(s2.url, "/api/moi", { cookie: adm })).corps.id, "adm", "session de l'admin encore valable");
			const p = await appel(s2.url, "/p/jardin/", { cookie: cam });
			assert.equal(p.status, 200); assert.match(p.texte, /Potager Clair/);
		} finally { await s2.arreter(); }
	});

	test("refus pendant qu'un serveur tient les données : rien ne change", async () => {
		const avant = fs.readdirSync(donnees).sort();
		const b = await restaurer(path.join(sauv, premiere), donnees);
		assert.equal(b.ok, false); assert.match(b.message, /rien n'a changé/);
		assert.deepEqual(fs.readdirSync(donnees).sort(), avant);
		assert.ok(!fs.readdirSync(racine).some(n => n.includes("avant-restauration")));
	});

	test("manifeste altéré, fichier manquant, chemin forgé : refusés avant toute écriture", async () => {
		const copie = path.join(racine, "copie");
		fs.cpSync(path.join(sauv, premiere), copie, { recursive: true });
		const cible = path.join(racine, "cible-alteree");
		fs.appendFileSync(path.join(copie, "projets", "jardin", "builds", "1", "data.json"), " ");
		let b = await restaurer(copie, cible);
		assert.equal(b.ok, false); assert.match(b.message, /taille différente : projets\/jardin\/builds\/1\/data\.json/);
		assert.ok(!fs.existsSync(cible));
		const m = JSON.parse(fs.readFileSync(path.join(copie, "manifeste.json"), "utf8"));
		m.fichiers["../hors.txt"] = { octets: 1, sha256: "x" };
		fs.writeFileSync(path.join(copie, "manifeste.json"), JSON.stringify(m));
		b = await restaurer(copie, cible);
		assert.equal(b.ok, false); assert.match(b.message, /chemin refusé|taille différente/);
		b = await restaurer(path.join(racine, "nulle-part"), cible);
		assert.equal(b.ok, false); assert.match(b.message, /manifeste\.json illisible/);
		assert.ok(!fs.existsSync(cible));
	});

	test("restauration sur des données existantes (serveur arrêté) : anciennes données gardées à côté", async () => {
		await s.arreter();
		const nAvant = fs.readdirSync(path.join(donnees, "projets", "jardin", "builds")).length;
		const b = await restaurer(path.join(sauv, premiere), donnees, new Date(2026, 10, 25, 12, 0, 0));
		assert.equal(b.ok, true, b.message);
		assert.equal(b.avant, donnees + ".avant-restauration-20261125-120000");
		assert.ok(fs.existsSync(path.join(b.avant!, "outil.sqlite")), "anciennes données intactes");
		assert.equal(fs.readdirSync(path.join(donnees, "projets", "jardin", "builds")).length, nAvant);
		s = await serveurTest(donnees, { sauvegarde: sauv }); u = s.url;
		assert.ok(await nbRetours(u, cam) >= 3);
	});

	test("échec du contrôle : données d'avant remises en place", async () => {
		await s.arreter();
		const copie = path.join(racine, "copie-sans-git");
		fs.cpSync(path.join(sauv, premiere), copie, { recursive: true });
		// Un dépôt dont HEAD ne mène nulle part : manifeste réécrit pour qu'il soit cohérent avec les fichiers.
		const head = path.join(copie, "projets", "jardin", "depot", ".git", "HEAD");
		fs.writeFileSync(head, "ref: refs/heads/nulle-part\n");
		const m = JSON.parse(fs.readFileSync(path.join(copie, "manifeste.json"), "utf8"));
		const { empreinteFichier } = await import("../src/sauvegarde.ts");
		m.fichiers["projets/jardin/depot/.git/HEAD"] = { octets: fs.statSync(head).size, sha256: empreinteFichier(head) };
		fs.writeFileSync(path.join(copie, "manifeste.json"), JSON.stringify(m));
		const avant = fs.readdirSync(donnees).sort();
		const b = await restaurer(copie, donnees, new Date(2026, 10, 25, 13, 0, 0));
		assert.equal(b.ok, false); assert.match(b.message, /données d'avant remises en place : dépôt de design du projet jardin/);
		assert.deepEqual(fs.readdirSync(donnees).sort(), avant);
		assert.ok(!fs.existsSync(donnees + ".avant-restauration-20261125-130000"));
		s = await serveurTest(donnees, { sauvegarde: sauv }); u = s.url;
	});

	// Docker : /donnees est un point de montage, qu'on ne peut pas renommer. Le contenu part alors dans un sous-dossier.
	test("point de montage : contenu déplacé dans .avant-restauration-…, restauré ; en cas d'échec, remis en place", async () => {
		await s.arreter();
		const avantNoms = fs.readdirSync(donnees).sort();
		const copie = path.join(racine, "copie-sans-git"); // sauvegarde altérée du test précédent : son contrôle échoue
		let b = await restaurer(copie, donnees, new Date(2026, 10, 25, 14, 0, 0), { parContenu: true });
		assert.equal(b.ok, false); assert.match(b.message, /données d'avant remises en place/);
		assert.deepEqual(fs.readdirSync(donnees).sort(), avantNoms, "contenu remis tel quel");
		b = await restaurer(path.join(sauv, premiere), donnees, new Date(2026, 10, 25, 15, 0, 0), { parContenu: true });
		assert.equal(b.ok, true, b.message);
		assert.equal(b.avant, path.join(donnees, ".avant-restauration-20261125-150000"));
		assert.ok(fs.existsSync(path.join(b.avant!, "outil.sqlite")) && !fs.existsSync(path.join(b.avant!, "serveur.verrou")), "anciennes données dans le volume, sans notre verrou");
		s = await serveurTest(donnees, { sauvegarde: sauv }); u = s.url;
		assert.ok(await nbRetours(u, cam) >= 3, "le serveur relit les données restaurées (le sous-dossier ne le gêne pas)");
	});
});

describe("rotation, planification, configuration", () => {
	let racine: string;
	before(() => { racine = dossierTemp("sauv-rotation"); });
	after(() => nettoyer(racine));
	test("rotation : garde les N plus récentes, ne touche à rien d'autre", () => {
		const d = path.join(racine, "rot");
		for (const n of ["sauvegarde-20261101-000000", "sauvegarde-20261102-000000", "sauvegarde-20261103-000000", "sauvegarde-20261103-000000-2", "autre-dossier", "sauvegarde-20261104-000000.partiel"]) fs.mkdirSync(path.join(d, n), { recursive: true });
		fs.writeFileSync(path.join(d, "notes.txt"), "x");
		const suppr = tournerSauvegardes(d, 2, Date.now());
		assert.deepEqual(suppr, ["sauvegarde-20261101-000000", "sauvegarde-20261102-000000"]);
		assert.deepEqual(fs.readdirSync(d).sort(), ["autre-dossier", "notes.txt", "sauvegarde-20261103-000000", "sauvegarde-20261103-000000-2", "sauvegarde-20261104-000000.partiel"]);
		assert.deepEqual(tournerSauvegardes(d, 2, Date.now() + 2 * 24 * 3600 * 1000), ["sauvegarde-20261104-000000.partiel"], "reste partiel de plus d'un jour retiré");
	});
	test("planifiée : lancée quand l'échéance est passée, une seule fois par intervalle", async () => {
		const donnees = path.join(racine, "plan"), sauv = path.join(racine, "plan-sauv");
		const s = await serveurTest(donnees, { sauvegarde: sauv, sauvegardeHeures: 1, verifSauvegardeMs: 100 });
		try {
			for (let i = 0; i < 50 && !(fs.existsSync(sauv) && fs.readdirSync(sauv).some(n => NOM_SAUVEGARDE.test(n))); i++) await pause(100);
			await pause(1200);
			assert.equal(fs.readdirSync(sauv).filter(n => NOM_SAUVEGARDE.test(n)).length, 1);
			assert.equal(s.ctx.sauvegarde.derniere?.ok, true);
		} finally { await s.arreter(); }
	});
	test("configuration : défaut à côté des données ; refus dedans ou dans le dépôt de l'outil ; valeurs invalides", () => {
		const donnees = path.join(racine, "cfg");
		const c = lireConfig({ WDD_DONNEES: donnees });
		assert.equal(c.sauvegarde, fs.realpathSync.native(donnees) + "-sauvegardes");
		assert.equal(c.sauvegardeHeures, 24); assert.equal(c.sauvegardeGarder, 7);
		assert.equal(lireConfig({ WDD_DONNEES: donnees, WDD_TEST: "1" }).sauvegardeHeures, 0, "mode test : pas de planification par défaut");
		assert.throws(() => lireConfig({ WDD_DONNEES: donnees, WDD_SAUVEGARDE: path.join(donnees, "s") }), /dans le dossier des données/);
		assert.throws(() => lireConfig({ WDD_DONNEES: donnees, WDD_SAUVEGARDE: path.join(RACINE_OUTIL, "s") }), /dans le dépôt de l'outil/);
		assert.throws(() => lireConfig({ WDD_DONNEES: donnees, WDD_SAUVEGARDE_HEURES: "-1" }), /WDD_SAUVEGARDE_HEURES/);
		assert.throws(() => lireConfig({ WDD_DONNEES: donnees, WDD_SAUVEGARDE_GARDER: "0" }), /WDD_SAUVEGARDE_GARDER/);
	});
});
