// Sécurité, défauts relevés à la relecture de l'étape 1 : page servie avec une CSP sans 'unsafe-inline' (empreintes des
// scripts), libellés « ui » échappés par le gabarit et réduits à du texte par build.js, flux coupé à la révocation
// d'un jeton ou à l'expiration d'une session, client lent coupé, API de test fermée aux autres sites (X-WDD exigé,
// Content-Type JSON, bouclage seulement, redirection locale stricte), ids de projet réservés par Windows.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, ecouter, pause } from "./aide.ts";
import { RACINE_OUTIL, lireConfig } from "../src/config.ts";
import { hacher } from "../src/base.ts";
import type { Serveur } from "../src/principal.ts";

const exemple = () => fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
const scriptsEnLigne = (page: string) => [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[\s/>]/gi)].map(m => m[1]);
const empreinte = (s: string) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`;
const scriptSrc = (csp: string) => (csp.split(";").map(x => x.trim()).find(x => x.startsWith("script-src ")) || "");

describe("page servie : CSP par empreintes, libellés ui", () => {
	let s: Serveur, donnees: string, u: string, bearer: string, contrib: string;
	before(async () => {
		donnees = dossierTemp("csp");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		const adm = await session(u, "jardin", "adm", "admin");
		bearer = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent" } })).corps.jeton;
		contrib = await session(u, "jardin", "essai", "contributeur");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("page du projet : script-src sans 'unsafe-inline', l'empreinte de chaque script en ligne, rien d'autre", async () => {
		const b = await appel(u, "/api/p/jardin/builds", { bearer, brut: exemple(), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		const p = await appel(u, "/p/jardin/", { cookie: contrib });
		assert.equal(p.status, 200);
		const src = scriptSrc(p.entetes.get("content-security-policy") || "");
		assert.ok(src, "script-src présent");
		assert.ok(!/unsafe-inline|unsafe-eval|unsafe-hashes|\*/.test(src), src);
		const scripts = scriptsEnLigne(p.texte);
		assert.ok(scripts.length >= 3, "module, adaptateur, page");
		const attendues = new Set(scripts.map(empreinte));
		assert.deepEqual(new Set(src.replace(/^script-src\s+/, "").split(/\s+/)), attendues);
		assert.ok(!p.texte.includes("\r"), "page servie en LF (ce qui est haché est ce qui est servi)");
	});

	test("page 401 « invitation requise » : son script de relance est autorisé par empreinte", async () => {
		const p = await appel(u, "/p/jardin/");
		assert.equal(p.status, 401);
		const scripts = scriptsEnLigne(p.texte);
		assert.equal(scripts.length, 1);
		assert.equal(scriptSrc(p.entetes.get("content-security-policy") || ""), "script-src " + empreinte(scripts[0]));
		// Après la relance, plus de script : script-src 'none'.
		const p2 = await appel(u, "/p/jardin/?wdd_r=1");
		assert.equal(scriptSrc(p2.entetes.get("content-security-policy") || ""), "script-src 'none'");
	});

	test("gabarit : tout libellé UI inséré dans du HTML passe par esc() (ui.notes.points injecté brut avant correction)", () => {
		const t = fs.readFileSync(path.join(RACINE_OUTIL, "site", "gabarit", "template.html"), "utf8");
		const permis = new Set(["setHead(s, UI.notes[key])"]); // setHead échappe elle-même
		const bruts = [...t.matchAll(/\$\{([^{}]*\bUI\.[^{}]*)\}/g)].map(m => m[1].trim()).filter(e => !e.startsWith("esc(") && !permis.has(e));
		assert.deepEqual(bruts, []);
		assert.ok(t.includes("esc(items.length > 1 ? UI.notes.points : UI.notes.point)"));
	});

	test("build : une valeur de ui qui n'est pas du texte est refusée (422) ; du HTML dans un texte est accepté (échappé à l'affichage)", async () => {
		const d = JSON.parse(exemple().toString("utf8"));
		for (const [cle, v] of [["points", 2], ["point", null], ["points", { a: true }]] as const) {
			const r = await appel(u, "/api/p/jardin/builds", { bearer, corps: { ...d, ui: { notes: { [cle]: v } } } });
			assert.equal(r.status, 422, `${cle} = ${JSON.stringify(v)}`); assert.match(r.corps.message, /data\.ui\.notes/);
		}
		assert.equal((await appel(u, "/api/p/jardin/builds", { bearer, corps: { ...d, ui: "x" } })).status, 422);
		const ok = await appel(u, "/api/p/jardin/builds", { bearer, corps: { ...d, ui: { notes: { points: "<img src=x onerror=alert(1)>" } } } });
		assert.equal(ok.status, 201, ok.texte);
	});
});

describe("flux : accès revérifié", () => {
	let s: Serveur, donnees: string, u: string, adm: string, moi: string;
	before(async () => {
		donnees = dossierTemp("fluxacces");
		s = await serveurTest(donnees, { pingMs: 60000 }); // pas de ping : la coupure doit venir de la révocation elle-même
		u = s.url;
		await projet(u, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		moi = await session(u, "jardin", "moi", "contributeur");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("jeton d'agent révoqué : ses flux ouverts sont coupés tout de suite et ne reçoivent plus rien", async () => {
		const j = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent2" } })).corps;
		const e = await ecouter(s.port, "/api/p/jardin/flux", { bearer: j.jeton });
		const temoin = await ecouter(s.port, "/api/p/jardin/flux", moi);
		try {
			assert.equal(e.status, 200);
			await e.attendre(1); await temoin.attendre(1);
			assert.equal((await appel(u, `/api/admin/jetons/${j.id}`, { cookie: adm, methode: "DELETE" })).status, 204);
			await Promise.race([e.ferme, pause(2000).then(() => { throw new Error("flux du jeton révoqué toujours ouvert"); })]);
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "SECRET-APRES-REVOCATION" }) })).status, 201);
			await temoin.attendre(2);
			assert.ok(!e.evenements.some(x => JSON.stringify(x).includes("SECRET-APRES-REVOCATION")));
			assert.equal(e.evenements.length, 1);
		} finally { e.fermer(); temoin.fermer(); }
	});

	test("session expirée : le flux est coupé à la diffusion suivante, sans rien recevoir", async () => {
		const autre = await session(u, "jardin", "autre", "contributeur");
		const e = await ecouter(s.port, "/api/p/jardin/flux", autre);
		try {
			await e.attendre(1);
			s.ctx.base.db.prepare("UPDATE sessions SET expire = ? WHERE hash = ?").run("2020-01-01T00:00:00.000Z", hacher(autre.split("=")[1]));
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "APRES-EXPIRATION" }) })).status, 201);
			await Promise.race([e.ferme, pause(2000).then(() => { throw new Error("flux d'une session expirée toujours ouvert"); })]);
			assert.ok(!e.evenements.some(x => JSON.stringify(x).includes("APRES-EXPIRATION")));
		} finally { e.fermer(); }
	});
});

describe("client lent, API de test, redirection, ids de projet", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => {
		donnees = dossierTemp("durci");
		s = await serveurTest(donnees, { delaiRequeteMs: 1000 });
		u = s.url;
		await projet(u, "jardin");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	// Envoie les en-têtes d'un POST qui annonce un corps, puis un seul octet ; rend le temps avant la coupure par le serveur.
	const clientLent = (chemin: string, attenteMax: number) => new Promise<{ ferme: boolean; ms: number; reponse: string }>(ok => {
		const t0 = Date.now(); let reponse = "";
		const c = net.connect(s.port, "127.0.0.1", () => c.write(`POST ${chemin} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 16000\r\n\r\n{`));
		c.on("data", b => reponse += b.toString());
		const fin = setTimeout(() => { c.destroy(); ok({ ferme: false, ms: Date.now() - t0, reponse }); }, attenteMax);
		c.on("close", () => { clearTimeout(fin); ok({ ferme: true, ms: Date.now() - t0, reponse }); });
		c.on("error", () => { });
	});

	test("corps annoncé jamais envoyé : connexion coupée après le délai ; invitation inconnue : 404 sans attendre le corps", async () => {
		const moi = await session(u, "jardin", "moi", "contributeur");
		const lent = await clientLent("/api/p/jardin/retours", 8000);
		assert.ok(lent.ferme, "le serveur coupe le client lent");
		const inv = await clientLent("/invitation/" + "a".repeat(43), 8000);
		assert.match(inv.reponse, /^HTTP\/1\.1 404/, "404 tout de suite");
		// Le délai ne touche pas les flux SSE : ouvert bien au-delà, pings reçus.
		const e = await ecouter(s.port, "/api/p/jardin/flux", moi);
		try {
			await pause(2500);
			let ferme = false; e.ferme.then(() => { ferme = true; });
			await pause(10);
			assert.equal(ferme, false, "flux toujours ouvert après 2,5 s (délai de requête : 1 s)");
			assert.ok(e.pings >= 3, `pings reçus : ${e.pings}`);
		} finally { e.fermer(); }
	});

	test("API de test : X-WDD exigé même sans cookie ; corps JSON seulement avec Content-Type application/json", async () => {
		const sans = await appel(u, "/__test/mettre", { xwdd: false, corps: { projet: "jardin", id: "pirate", donnees: docRetour() } });
		assert.equal(sans.status, 403); assert.match(sans.corps.message, /X-WDD/);
		// fetch no-cors d'un autre site : text/plain, sans X-WDD.
		const simple = await appel(u, "/__test/mettre", { xwdd: false, brut: JSON.stringify({ projet: "jardin", id: "pirate", donnees: docRetour() }), entetes: { "Content-Type": "text/plain" } });
		assert.equal(simple.status, 403);
		const texte = await appel(u, "/__test/mettre", { brut: JSON.stringify({ projet: "jardin", id: "pirate", donnees: docRetour() }), entetes: { "Content-Type": "text/plain" } });
		assert.equal(texte.status, 400); assert.match(texte.corps.message, /Content-Type/);
		assert.ok(!(await appel(u, "/__test/retours?projet=jardin")).corps.docs.some((x: any) => x.id === "pirate"));
		// Même règle sur l'API de la page.
		const moi = await session(u, "jardin", "moi", "contributeur");
		const r = await appel(u, "/api/p/jardin/retours", { cookie: moi, brut: JSON.stringify(docRetour()), entetes: { "Content-Type": "text/plain" } });
		assert.equal(r.status, 400); assert.equal(r.corps.code, "invalid_document");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: moi, brut: JSON.stringify(docRetour()), entetes: { "Content-Type": "application/json; charset=utf-8" } })).status, 201);
	});

	test("WDD_TEST=1 refusé hors adresse de bouclage", () => {
		const d = dossierTemp("bouclage");
		try {
			for (const hote of ["0.0.0.0", "::", "192.168.1.10"]) assert.throws(() => lireConfig({}, { donnees: d, test: true, hote }), /WDD_TEST/, hote);
			for (const hote of ["127.0.0.1", "::1", "localhost"]) assert.equal(lireConfig({}, { donnees: d, test: true, hote }).hote, hote);
			assert.equal(lireConfig({}, { donnees: d, test: false, hote: "0.0.0.0" }).hote, "0.0.0.0");
		} finally { nettoyer(d); }
	});

	test("/__test/connexion : redirection vers un chemin local seulement (tabulation, //, /\\ refusés)", async () => {
		for (const suite of ["/%09/evil.example/x", "//evil.example/", "/\\evil.example/", "/%0a/evil", "/ /evil", "https://evil.example/", "/x%00", "evil"]) {
			const r = await appel(u, `/__test/connexion?projet=jardin&compte=essai&suite=${suite}`);
			assert.equal(r.status, 400, suite);
		}
		const ok = await appel(u, `/__test/connexion?projet=jardin&compte=essai&suite=${encodeURIComponent("/p/jardin/?a=1#plantes")}`);
		assert.equal(ok.status, 303); assert.equal(ok.entetes.get("location"), "/p/jardin/?a=1#plantes");
	});

	test("ids de projet réservés par Windows : refusés (400), rien de créé ; 409 sans chemin du serveur", async () => {
		const adm = await session(u, "jardin", "adm", "admin");
		for (const id of ["aux", "nul", "con", "prn", "com1", "lpt9"]) {
			const r = await appel(u, "/api/admin/projets", { cookie: adm, corps: { id, titre: id } });
			assert.equal(r.status, 400, id); assert.equal(r.corps.code, "invalid_document");
		}
		assert.deepEqual(fs.readdirSync(path.join(donnees, "projets")).sort(), ["jardin"]);
		// Dossier présent sans projet en base : 409, sans chemin absolu dans la réponse.
		fs.mkdirSync(path.join(donnees, "projets", "orphelin", "depot"), { recursive: true });
		const c = await appel(u, "/api/admin/projets", { cookie: adm, corps: { id: "orphelin", titre: "x" } });
		assert.equal(c.status, 409);
		assert.ok(!c.texte.includes(donnees) && !c.texte.includes(donnees.replace(/\\/g, "\\\\")), c.texte);
	});
});
