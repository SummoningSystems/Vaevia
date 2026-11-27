// Sécurité : anti-CSRF, validation des ids (traversée de chemin), limites de taille, API de test fermée sans
// WDD_TEST=1 ; comptes : premier lien admin, invitations (usage unique, haché, expiration), jetons d'agent, API admin.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appel, appelBrut, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, depotDe, nbCommits } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

describe("anti-CSRF et ids", () => {
	let s: Serveur, donnees: string, u: string, moi: string, bearer: string;
	before(async () => {
		donnees = dossierTemp("securite");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		moi = await session(u, "jardin", "moi", "contributeur");
		const adm = await session(u, "jardin", "adm", "admin");
		bearer = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("cookie sans X-WDD : écriture refusée (403), lecture permise", async () => {
		const r = await appel(u, "/api/p/jardin/retours", { cookie: moi, xwdd: false, corps: docRetour() });
		assert.equal(r.status, 403); assert.equal(r.corps.code, "permission_denied"); assert.match(r.corps.message, /X-WDD/);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, xwdd: false })).status, 200);
		const id = (await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() })).corps.id;
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, xwdd: false, methode: "PATCH", corps: { champs: { proposal: "x" }, version: 1 } })).status, 403);
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}?version=1`, { cookie: moi, xwdd: false, methode: "DELETE" })).status, 403);
		assert.equal((await appel(u, "/api/admin/projets", { cookie: moi, xwdd: false, corps: { id: "x", titre: "x" } })).status, 403);
		assert.equal((await appel(u, "/__test/reinitialiser", { cookie: moi, xwdd: false, corps: { projet: "jardin" } })).status, 403);
	});
	test("Origin d'un autre site refusé ; Origin de l'hôte accepté", async () => {
		const r = await appel(u, "/api/p/jardin/retours", { cookie: moi, origin: "https://mechant.example", corps: docRetour() });
		assert.equal(r.status, 403); assert.match(r.corps.message, /Origin/);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, origin: "null", corps: docRetour() })).status, 403);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, origin: u, corps: docRetour() })).status, 201);
	});
	test("jeton Bearer sans cookie : pas d'en-tête X-WDD exigé", async () => {
		const id = (await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() })).corps.id;
		const r = await appel(u, `/api/p/jardin/retours/${id}`, { bearer, methode: "PATCH", corps: { champs: { status: "pris" }, version: 1 } });
		assert.equal(r.status, 200);
	});
	test("sans session : 401 revoked ; session inconnue : 401", async () => {
		const r = await appel(u, "/api/p/jardin/session");
		assert.equal(r.status, 401); assert.equal(r.corps.code, "revoked");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: "wdd_session=inconnu", xwdd: false })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: "wdd_faux" })).status, 401);
		assert.equal((await appel(u, "/api/p/inexistant/session")).status, 401, "pas de fuite de l'existence d'un projet");
	});
	test("ids : traversée de chemin refusée, rien hors de retours/", async () => {
		const sentinelle = path.join(donnees, "projets", "jardin", "sentinelle.json");
		fs.writeFileSync(sentinelle, "{}");
		const avant = nbCommits(depotDe(donnees, "jardin"));
		const h = { Cookie: moi, "X-WDD": "1", "Content-Type": "application/json" };
		const corps = JSON.stringify({ champs: { proposal: "x" }, version: 1 });
		for (const id of ["..%2Fsentinelle", "..%2F..%2Fsentinelle", "%2E%2E%2Fsentinelle", "..", "a.json", "a%00b", "%E0%A4%A", "x".repeat(41), "abc-def", "abc_def"]) {
			const p = await appelBrut(s.port, "PATCH", `/api/p/jardin/retours/${id}`, h, corps);
			assert.equal(p.status, 404, `PATCH ${id}`);
			const d = await appelBrut(s.port, "DELETE", `/api/p/jardin/retours/${id}?version=1`, h);
			assert.equal(d.status, 404, `DELETE ${id}`);
		}
		for (const id of ["../sentinelle", "../../sentinelle", "a/b", "a.json", ""]) {
			const r = await appel(u, "/__test/mettre", { corps: { projet: "jardin", id, donnees: docRetour() } });
			assert.equal(r.status, 400, `/__test/mettre ${id}`);
			const r2 = await appel(u, "/__test/supprimer", { corps: { projet: "jardin", id } });
			assert.equal(r2.status, 400, `/__test/supprimer ${id}`);
		}
		for (const p of ["../x", "Jardin", "a/b", "x".repeat(41)]) {
			const r = await appel(u, "/__test/mode", { corps: { projet: p, mode: "normal" } });
			assert.equal(r.status, 404, `projet ${p}`);
		}
		assert.ok(fs.existsSync(sentinelle));
		assert.equal(fs.readFileSync(sentinelle, "utf8"), "{}");
		assert.equal(nbCommits(depotDe(donnees, "jardin")), avant);
	});
	test("limites : corps > 1 Mio (413 quota_exceeded), texte > 20 000 caractères (400 invalid_document), JSON invalide (400)", async () => {
		const gros = await appel(u, "/api/p/jardin/retours", { cookie: moi, brut: JSON.stringify(docRetour({ text: "x".repeat(1100 * 1024) })), entetes: { "Content-Type": "application/json" } });
		assert.equal(gros.status, 413); assert.equal(gros.corps.code, "quota_exceeded");
		const long = await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "x".repeat(20001) }) });
		assert.equal(long.status, 400); assert.equal(long.corps.code, "invalid_document");
		const casse = await appel(u, "/api/p/jardin/retours", { cookie: moi, brut: "{pas du json", entetes: { "Content-Type": "application/json" } });
		assert.equal(casse.status, 400); assert.equal(casse.corps.code, "invalid_document");
		// Octets non UTF-8 (« é » en Latin-1) : refusés, jamais enregistrés en caractères de remplacement.
		const latin1 = Buffer.from(JSON.stringify(docRetour({ text: "Trop d'eau en ete" })).replace("ete", "été"), "latin1");
		const l1 = await appel(u, "/api/p/jardin/retours", { cookie: moi, brut: latin1, entetes: { "Content-Type": "application/json" } });
		assert.equal(l1.status, 400); assert.equal(l1.corps.code, "invalid_document");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "x".repeat(20000) }) })).status, 201);
	});
});

describe("API de test fermée sans WDD_TEST=1", () => {
	test("toutes les routes /__test répondent 404", async () => {
		const donnees = dossierTemp("sanstest");
		const s = await serveurTest(donnees, { test: false });
		try {
			for (const r of ["projet", "session", "mode", "reinitialiser", "mettre", "ecrire", "supprimer"]) {
				const x = await appel(s.url, "/__test/" + r, { corps: { projet: "jardin", id: "abc", compte: "x", role: "admin" } });
				assert.equal(x.status, 404, r); assert.equal(x.corps.code, "not_found");
			}
			assert.equal((await appel(s.url, "/__test/retours?projet=jardin")).status, 404);
		} finally { await s.arreter(); nettoyer(donnees); }
	});
});

describe("comptes, invitations, jetons, API admin", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => { donnees = dossierTemp("comptes"); s = await serveurTest(donnees, { test: false }); u = s.url; });
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const cookieDe = (r: { entetes: Headers }) => (r.entetes.get("set-cookie") || "").split(";")[0];

	test("premier démarrage : lien d'invitation admin ; parcours complet jusqu'à un retour", async () => {
		assert.ok(s.lienAdmin && s.lienAdmin.startsWith(u + "/invitation/"));
		const chemin = s.lienAdmin!.slice(u.length);
		const f = await appel(u, chemin);
		assert.equal(f.status, 200); assert.match(f.texte, /<form method="post">/);
		// Formulaire HTML : ni X-WDD ni JSON.
		const r = await appel(u, chemin, { brut: "nom=Administratrice", entetes: { "Content-Type": "application/x-www-form-urlencoded" } });
		assert.equal(r.status, 303); assert.equal(r.entetes.get("location"), "/");
		const sc = r.entetes.get("set-cookie") || "";
		assert.match(sc, /^wdd_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
		const admin = cookieDe(r);
		// Usage unique.
		assert.equal((await appel(u, chemin)).status, 404);
		assert.equal((await appel(u, chemin, { brut: "nom=Autre", entetes: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 404);
		// Admin : projet, invitation, jeton.
		assert.equal((await appel(u, "/api/admin/projets", { cookie: admin, corps: { id: "Mauvais Id", titre: "x" } })).status, 400);
		const p = await appel(u, "/api/admin/projets", { cookie: admin, corps: { id: "jardin", titre: "Jardin" } });
		assert.equal(p.status, 201); assert.match(p.corps.rev, /^[0-9a-f]{40}$/);
		assert.equal(nbCommits(depotDe(donnees, "jardin")), 1);
		assert.equal((await appel(u, "/api/admin/projets", { cookie: admin, corps: { id: "jardin", titre: "Jardin" } })).status, 409);
		const l = await appel(u, "/api/admin/projets", { cookie: admin });
		assert.deepEqual(l.corps.projets.map((x: any) => [x.id, x.titre, x.retours]), [["jardin", "Jardin", 0]]);
		const inv = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { projet: "jardin", role: "contributeur" } });
		assert.equal(inv.status, 201); assert.match(inv.corps.lien, /^\/invitation\/[A-Za-z0-9_-]{43}$/);
		assert.ok(Math.abs(Date.parse(inv.corps.expire) - Date.now() - 7 * 86400000) < 60000, "expiration par défaut 7 jours");
		assert.equal(inv.corps.url, u + inv.corps.lien);
		// Contributeur : JSON avec un cookie étranger présent (ignoré par la route d'invitation).
		const acc = await appel(u, inv.corps.lien, { corps: { nom: "Camille" }, entetes: { Cookie: "autre=1" } });
		assert.equal(acc.status, 303); assert.equal(acc.entetes.get("location"), "/p/jardin/");
		const cam = cookieDe(acc);
		const se = await appel(u, "/api/p/jardin/session", { cookie: cam });
		assert.equal(se.corps.nom, "Camille"); assert.equal(se.corps.role, "contributeur"); assert.match(se.corps.id, /^[A-Za-z0-9]{20}$/);
		const ret = await appel(u, "/api/p/jardin/retours", { cookie: cam, corps: docRetour() });
		assert.equal(ret.status, 201);
		// Contributeur : pas d'API admin.
		assert.equal((await appel(u, "/api/admin/projets", { cookie: cam })).status, 403);
		assert.equal((await appel(u, "/api/admin/projets")).status, 401);
		// Origin étranger sur le POST d'invitation : refusé.
		const inv2 = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { projet: "jardin", role: "lecteur" } });
		assert.equal((await appel(u, inv2.corps.lien, { brut: "nom=X", origin: "https://mechant.example", entetes: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 403);
		// Nom invalide : refusé, invitation toujours valable.
		assert.equal((await appel(u, inv2.corps.lien, { brut: "nom=%3Cscript%3E", entetes: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 400);
		assert.equal((await appel(u, inv2.corps.lien, { brut: "nom=Beno%EEt", entetes: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 400, "nom non UTF-8");
		for (const nom of ["'", ":;", "  ", "--"]) // Git refuserait ces noms d'auteur : chaque écriture du compte échouerait
			assert.equal((await appel(u, inv2.corps.lien, { corps: { nom } })).status, 400, `nom ${JSON.stringify(nom)}`);
		assert.equal((await appel(u, "/api/admin/jetons", { cookie: admin, corps: { projet: "jardin", nom: "::" } })).status, 400, "nom de jeton");
		assert.equal((await appel(u, inv2.corps.lien)).status, 200);
		// Jeton d'agent : affiché une fois, stocké haché, révocable.
		const j = await appel(u, "/api/admin/jetons", { cookie: admin, corps: { projet: "jardin", nom: "Claude" } });
		assert.equal(j.status, 201);
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: j.corps.jeton })).status, 200);
		assert.equal((await appel(u, `/api/admin/jetons/${j.corps.id}`, { cookie: admin, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: j.corps.jeton })).status, 401);
		// Rien en clair dans la base.
		const db = new DatabaseSync(path.join(donnees, "outil.sqlite"), { readOnly: true });
		const tout = JSON.stringify([db.prepare("SELECT * FROM sessions").all(), db.prepare("SELECT * FROM invitations").all(), db.prepare("SELECT * FROM jetons").all()]);
		db.close();
		for (const secret of [admin.split("=")[1], cam.split("=")[1], j.corps.jeton, inv2.corps.lien.split("/").pop(), chemin.split("/").pop()]) assert.ok(!tout.includes(secret), "secret en clair dans outil.sqlite");
		// Invitation expirée : refusée.
		const passe = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { projet: "jardin", role: "lecteur", expire: "2020-01-01T00:00:00Z" } });
		assert.equal(passe.status, 400);
		const courte = await appel(u, "/api/admin/invitations", { cookie: admin, corps: { projet: "jardin", role: "lecteur", expire: new Date(Date.now() + 1500).toISOString() } });
		await new Promise(r => setTimeout(r, 1600));
		assert.equal((await appel(u, courte.corps.lien)).status, 404);
	});

	test("page du projet : 401 « invitation requise » sans session (le 404 sans build est vérifié dans flux.test.ts)", async () => {
		const r = await appel(u, "/p/jardin/");
		assert.equal(r.status, 401); assert.match(r.texte, /Invitation requise/);
		assert.match(r.entetes.get("content-security-policy") || "", /frame-ancestors 'none'/);
		assert.equal((await appel(u, "/p/jardin")).status, 301);
		assert.equal((await appel(u, "/p/inexistant/")).status, 401, "sans session, pas de fuite de l'existence d'un projet");
	});

	test("redémarrage avec un admin : plus de lien admin", async () => {
		await s.arreter();
		s = await serveurTest(donnees, { test: false });
		u = s.url;
		assert.equal(s.lienAdmin, null);
	});
});
