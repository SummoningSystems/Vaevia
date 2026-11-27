// Flux SSE (instantané à la connexion, après chaque commit, pings), API de test (mettre, écrire, supprimer,
// réinitialiser) et modes simulés ; builds (site/build.js --stockage=http) et page servie avec <meta name="wdd-api">.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, depotDe, nbCommits, ecouter, pause, git } from "./aide.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import type { Serveur } from "../src/principal.ts";

describe("flux SSE et API de test", () => {
	let s: Serveur, donnees: string, u: string, moi: string;
	before(async () => {
		donnees = dossierTemp("flux");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		moi = await session(u, "jardin", "essai", "contributeur");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const mode = (m: string) => appel(u, "/__test/mode", { corps: { projet: "jardin", mode: m } });

	test("instantané à la connexion, après chaque commit, et pings", async () => {
		const e = await ecouter(s.port, "/api/p/jardin/flux", moi);
		try {
			assert.equal(e.status, 200);
			await e.attendre(1);
			assert.deepEqual(e.evenements[0].docs, []);
			assert.match(e.evenements[0].rev, /^[0-9a-f]{40}$/);
			const r = await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() });
			await e.attendre(2);
			const dernier = e.evenements[1];
			assert.deepEqual(dernier, (await appel(u, "/api/p/jardin/retours", { cookie: moi })).corps, "même corps que GET /retours");
			assert.equal(dernier.docs[0].id, r.corps.id); assert.equal(dernier.docs[0].version, 1); assert.equal(dernier.docs[0].donnees.by, "essai");
			await pause(500);
			assert.ok(e.pings >= 1, "au moins un « : ping »");
		} finally { e.fermer(); }
	});

	test("API de test : mettre (tel quel), écrire (fusion), supprimer avec ou sans diffusion, réinitialiser", async () => {
		const depot = depotDe(donnees, "jardin");
		const e = await ecouter(s.port, "/api/p/jardin/flux", moi);
		try {
			await e.attendre(1);
			const c0 = nbCommits(depot);
			const zautre = docRetour({ ref: "basilic", by: "collegue", status: "pris", id: "faux-id" });
			const m = await appel(u, "/__test/mettre", { corps: { projet: "jardin", id: "zautre", donnees: zautre } });
			assert.equal(m.status, 200); assert.equal(m.corps.version, 1);
			await e.attendre(2);
			const doc = e.evenements[1].docs.find((d: any) => d.id === "zautre");
			assert.deepEqual(doc.donnees, zautre, "écrit tel quel, champ id parasite compris");
			const w = await appel(u, "/__test/ecrire", { corps: { projet: "jardin", id: "zautre", champs: { status: "fait", reply: "Fait." } } });
			assert.equal(w.corps.version, 2);
			await e.attendre(3);
			assert.equal(e.evenements[2].docs.find((d: any) => d.id === "zautre").donnees.status, "fait");
			assert.equal((await appel(u, "/__test/ecrire", { corps: { projet: "jardin", id: "absent", champs: {} } })).status, 404);
			// Le retour d'un autre : un contributeur ajoute une précision (scénario normal, étape 6).
			const p = await appel(u, "/api/p/jardin/retours/zautre", { cookie: moi, methode: "PATCH", corps: { champs: { text: zautre.text + "\n\n— Précision du 23/11 : merci", status: "nouveau", updated: new Date().toISOString() }, version: 2 } });
			assert.equal(p.status, 200, p.texte);
			await e.attendre(4);
			// Suppression sans diffusion : commit, mais pas d'événement ; la page qui écrit dessus reçoit 404.
			const sd = await appel(u, "/__test/supprimer", { corps: { projet: "jardin", id: "zautre", diffuser: false } });
			assert.equal(sd.status, 200);
			await pause(300);
			assert.equal(e.evenements.length, 4);
			const pz = await appel(u, "/api/p/jardin/retours/zautre", { cookie: moi, methode: "PATCH", corps: { champs: { text: "x", status: "nouveau" }, version: 3 } });
			assert.equal(pz.status, 404); assert.equal(pz.corps.code, "not_found");
			// T.emit : rediffusion de l'état courant (zautre absent).
			assert.equal((await appel(u, "/__test/diffuser", { corps: { projet: "jardin" } })).status, 200);
			await e.attendre(5);
			assert.ok(!e.evenements[4].docs.some((d: any) => d.id === "zautre"));
			e.evenements.splice(4, 1);
			// Suppression avec diffusion.
			await appel(u, "/__test/mettre", { corps: { projet: "jardin", id: "seed2", donnees: docRetour() } });
			await e.attendre(5);
			await appel(u, "/__test/supprimer", { corps: { projet: "jardin", id: "seed2" } });
			await e.attendre(6);
			assert.ok(!e.evenements[5].docs.some((d: any) => d.id === "seed2"));
			assert.equal(nbCommits(depot), c0 + 6);
			assert.match(git(depot, "log", "-1", "--format=%an <%ae>"), /^banc de test <test@wdd\.invalid>/);
			// Réinitialiser : tout vidé, un commit, diffusé.
			const r = await appel(u, "/__test/reinitialiser", { corps: { projet: "jardin" } });
			assert.equal(r.status, 200); assert.ok(r.corps.supprimes >= 1);
			await e.attendre(7);
			assert.deepEqual(e.evenements[6].docs, []);
			assert.deepEqual((await appel(u, "/__test/retours?projet=jardin")).corps.docs, []);
			assert.equal(nbCommits(depot), c0 + 7);
		} finally { e.fermer(); }
	});

	test("GET /__test/connexion : cookie posé puis redirection locale seulement", async () => {
		const r = await appel(u, "/__test/connexion?projet=jardin&compte=essai2&role=lecteur");
		assert.equal(r.status, 303); assert.equal(r.entetes.get("location"), "/p/jardin/");
		const cookie = (r.entetes.get("set-cookie") || "").split(";")[0];
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie })).corps.role, "lecteur");
		for (const suite of ["//mechant.example/", "https://mechant.example/", "/\\mechant.example"])
			assert.equal((await appel(u, "/__test/connexion?projet=jardin&compte=essai2&suite=" + encodeURIComponent(suite))).status, 400, suite);
		assert.equal((await appel(u, "/__test/connexion?projet=inconnu&compte=essai2")).status, 404);
	});

	test("modes quota, unavailable, readonly, denywrite : écritures refusées avec le bon code", async () => {
		for (const [m, statut, code, ecriture] of [["quota", 507, "quota_exceeded", true], ["unavailable", 503, "unavailable", true], ["readonly", 403, "permission_denied", false], ["denywrite", 403, "permission_denied", null]] as const) {
			assert.equal((await mode(m)).status, 200);
			const r = await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() });
			assert.equal(r.status, statut, m); assert.equal(r.corps.code, code, m);
			assert.equal((await appel(u, "/api/p/jardin/session", { cookie: moi })).corps.ecriture, ecriture, m);
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi })).status, 200, m + " : lecture");
		}
		await mode("normal");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() })).status, 201);
		assert.equal((await mode("inconnu")).status, 400);
	});

	test("mode silent : GET /retours et le flux ne répondent jamais ; libérés au changement de mode", async () => {
		await mode("silent");
		const ctrl = new AbortController();
		const g = fetch(u + "/api/p/jardin/retours", { headers: { Cookie: moi }, signal: ctrl.signal }).then(r => r.status, () => "abandon");
		const course = await Promise.race([g, pause(600).then(() => "muet")]);
		assert.equal(course, "muet");
		ctrl.abort();
		assert.equal(await g, "abandon");
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: moi })).status, 200, "la session répond");
		const pendant = fetch(u + "/api/p/jardin/flux", { headers: { Cookie: moi } }).then(r => r.status, () => "coupe");
		await pause(200);
		await mode("normal");
		assert.equal(await pendant, "coupe");
	});

	test("mode snapretry : premier flux refusé (503), le second marche", async () => {
		await mode("snapretry");
		const r1 = await appel(u, "/api/p/jardin/flux", { cookie: moi });
		assert.equal(r1.status, 503); assert.equal(r1.corps.code, "unavailable");
		const e = await ecouter(s.port, "/api/p/jardin/flux", moi);
		try { assert.equal(e.status, 200); await e.attendre(1); } finally { e.fermer(); }
		await mode("normal");
	});

	test("mode revoked : un instantané, flux coupé, puis 401 partout jusqu'au mode suivant", async () => {
		const ouvert = await ecouter(s.port, "/api/p/jardin/flux", moi);
		await ouvert.attendre(1);
		await mode("revoked");
		await ouvert.ferme; // les flux déjà ouverts sont coupés
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: moi })).status, 401);
		await mode("revoked"); // nouveau réglage : la page peut se connecter
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: moi })).status, 200);
		const e = await ecouter(s.port, "/api/p/jardin/flux", moi);
		await e.attendre(1);
		await e.ferme;
		const r = await appel(u, "/api/p/jardin/session", { cookie: moi });
		assert.equal(r.status, 401); assert.equal(r.corps.code, "revoked");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour() })).status, 401);
		await mode("normal");
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: moi })).status, 200);
	});
});

describe("builds et page servie", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => { donnees = dossierTemp("builds"); s = await serveurTest(donnees); u = s.url; await projet(u, "jardin"); });
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("POST /builds : build.js --stockage=http avec les notes du dépôt ; page servie avec <meta name=\"wdd-api\">", async () => {
		const adm = await session(u, "jardin", "adm", "admin");
		const bearer = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent" } })).corps.jeton;
		const contrib = await session(u, "jardin", "essai", "contributeur");
		const exemple = fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
		assert.equal((await appel(u, "/p/jardin/", { cookie: contrib })).status, 404, "pas encore de build");
		assert.equal((await appel(u, "/api/p/jardin/builds", { cookie: contrib, brut: exemple })).status, 403, "un contributeur ne publie pas");
		// Notes du dépôt de design (notes/).
		fs.copyFileSync(path.join(RACINE_OUTIL, "site", "examples", "notes_exemple.json"), path.join(depotDe(donnees, "jardin"), "notes", "notes_2026-11-12.json"));
		const b = await appel(u, "/api/p/jardin/builds", { bearer, brut: exemple, entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte); assert.equal(b.corps.build, 1); assert.ok(b.corps.octets > 10000);
		assert.ok(fs.existsSync(path.join(donnees, "projets", "jardin", "builds", "1", "data.json")));
		const p = await appel(u, "/p/jardin/", { cookie: contrib });
		assert.equal(p.status, 200);
		assert.match(p.texte, /^<!doctype html>/);
		assert.match(p.texte, /<meta name="wdd-api" content="\/api\/p\/jardin">/);
		assert.match(p.texte, /window\.RetoursStockage = /);
		assert.match(p.texte, /nom: "http"/);
		assert.match(p.texte, /V1-chaleur/, "notes du dépôt incluses");
		assert.ok(!/window\.claude\?\.use/.test(p.texte), "pas l'adaptateur artifact");
		// Erreur de build : invalid_document avec le message de build.js, aucun build gardé.
		const mauvais = await appel(u, "/api/p/jardin/builds", { bearer, corps: { tabs: [] } });
		assert.equal(mauvais.status, 422); assert.equal(mauvais.corps.code, "invalid_document");
		assert.match(mauvais.corps.message, /data\.title/);
		assert.equal((await appel(u, "/api/p/jardin/builds", { bearer, brut: "{pas du json" })).status, 400);
		assert.ok(!fs.existsSync(path.join(donnees, "projets", "jardin", "builds", "2")));
		// Nouveau build : servi à son tour.
		const d2 = JSON.parse(exemple.toString("utf8")); d2.title = "Jardin, version 2";
		const b2 = await appel(u, "/api/p/jardin/builds", { bearer, corps: d2 });
		assert.equal(b2.corps.build, 2);
		assert.match((await appel(u, "/p/jardin/", { cookie: contrib })).texte, /<title>Jardin, version 2<\/title>/);
		// Le dépôt de design n'a pas bougé (builds hors Git).
		assert.equal(git(depotDe(donnees, "jardin"), "status", "--porcelain", "--", "retours").trim(), "");
	});

	test("POST /builds : résumé et avertissements de build.js renvoyés (sans chemin du serveur) ; image en chemin relatif refusée", async () => {
		const adm = await session(u, "jardin", "adm2", "admin");
		const bearer = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent 2" } })).corps.jeton;
		const exemple = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"), "utf8"));
		const sans = { ...exemple }; delete sans.generated;
		const b = await appel(u, "/api/p/jardin/builds", { bearer, corps: sans });
		assert.equal(b.status, 201, b.texte);
		assert.match(b.corps.resume, /^OK \d+ Ko · \d+ onglets · .* · notes : 1 fichier\(s\), \d+ nouveautés, \d+ mesures, \d+ points à valider( · changements : (aucun|\d+ modifiés, \d+ ajoutés, \d+ retirés.*))?$/);
		assert.ok(!b.corps.resume.includes(donnees) && !/gabarit|->/.test(b.corps.resume), "aucun chemin du serveur");
		assert.ok(b.corps.avertissements.some((a: string) => /data\.generated absent/.test(a)), JSON.stringify(b.corps.avertissements));
		// Le serveur ne sert que la page : une image en chemin relatif serait cassée, build.js la refuse (stockage http).
		const rel = structuredClone(exemple); rel.tabs[0].sections[0].items[0].image = "icone.png";
		const r = await appel(u, "/api/p/jardin/builds", { bearer, corps: rel });
		assert.equal(r.status, 422); assert.match(r.corps.message, /URI data: seulement avec le stockage http/);
	});

	test("POST /__test/notes : notes écrites dans notes/ et commitées, lues par le build suivant ; noms contrôlés", async () => {
		await projet(u, "verger");
		const depot = depotDe(donnees, "verger");
		const avant = nbCommits(depot);
		const notes = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "notes_exemple.json"), "utf8"));
		const r = await appel(u, "/__test/notes", { corps: { projet: "verger", nom: "notes_exemple.json", notes } });
		assert.equal(r.status, 200, r.texte);
		assert.equal(nbCommits(depot), avant + 1);
		assert.equal(git(depot, "log", "-1", "--format=%an <%ae> %s").trim(), "banc de test <test@wdd.invalid> notes : notes_exemple.json (test)");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(depot, "notes", "notes_exemple.json"), "utf8")), notes);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		for (const nom of ["../x.json", "notes_a/b.json", "autre.json", "notes_.json", "notes_x.txt"])
			assert.equal((await appel(u, "/__test/notes", { corps: { projet: "verger", nom, notes } })).status, 400, nom);
		assert.equal((await appel(u, "/__test/notes", { corps: { projet: "verger", nom: "notes_y.json", notes: [1] } })).status, 400);
		assert.equal((await appel(u, "/__test/notes", { corps: { projet: "inconnu", nom: "notes_y.json", notes } })).status, 404);
		const adm = await session(u, "verger", "adm2", "admin");
		const exemple = fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
		const b = await appel(u, "/api/p/verger/builds", { cookie: adm, brut: exemple, entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		assert.match((await appel(u, "/p/verger/", { cookie: adm })).texte, /V1-chaleur/, "notes incluses dans le build");
	});
});
