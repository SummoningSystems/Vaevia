// Étape 3.9, lot 3 (docs/etape3-9-sections-1-a-6.md) : sessions (E4), exports (I4), approbations (E5), rétention et
// anciennes versions (A3, L3), version (A4), page d'état (A5), sauvegarde hors du serveur (A4).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
const lancer = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ status: number; stdout: string; stderr: string }>(ok => execFile(process.execPath, args, { env, encoding: "utf8" }, (e, stdout, stderr) => ok({ status: e ? (typeof (e as any).code === "number" ? (e as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
import { appel, appelHote, docRetour, dossierTemp, nettoyer, portLibre, serveurTest, projet, session } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import { csv } from "../src/exports.ts";

const exemple = () => JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"), "utf8"));
const VERSION = fs.readFileSync(path.join(RACINE_OUTIL, "VERSION"), "utf8").trim();

describe("lot 3 : sessions, exports, approbations, versions du Wiki, état", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string, adm: string;
	before(async () => {
		donnees = dossierTemp("lot3");
		s = await serveurTest(donnees, { buildsGarder: 3 });
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		adm = await session(u, "jardin", "adm", "admin", "Adèle");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("E4 : mes sessions (sans secret), en fermer une ; un admin ferme toutes celles d'un compte", async () => {
		const autre = await session(u, "jardin", "camille", "contributeur", "Camille");
		const l = await appel(u, "/api/moi/sessions", { cookie: camille });
		assert.equal(l.status, 200, l.texte);
		assert.equal(l.corps.sessions.length, 2);
		assert.equal(l.corps.sessions.filter((x: any) => x.courante).length, 1);
		for (const x of l.corps.sessions) { assert.match(x.id, /^[0-9a-f]{16}$/); assert.ok(x.navigateur && x.cree && x.vu && x.expire); }
		assert.ok(!l.texte.includes(camille.split("=")[1].split(";")[0]), "jamais la valeur du cookie");
		const autreId = l.corps.sessions.find((x: any) => !x.courante).id;
		assert.equal((await appel(u, `/api/moi/sessions/${autreId}`, { cookie: camille, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: autre })).status, 401, "la session fermée ne vaut plus");
		assert.equal((await appel(u, `/api/moi/sessions/${autreId}`, { cookie: camille, methode: "DELETE" })).status, 404);
		assert.equal((await appel(u, `/api/moi/sessions/${autreId}`, { cookie: camille, methode: "DELETE", xwdd: false })).status, 403, "anti-CSRF");
		const j = await appel(u, "/api/admin/journal", { cookie: adm });
		assert.ok(j.corps.entrees.some((e: any) => e.action === "session fermée" && e.cible === autreId));
		const c2 = await session(u, "jardin", "camille", "contributeur", "Camille");
		assert.equal((await appel(u, "/api/admin/comptes/camille/sessions", { cookie: maud, methode: "DELETE" })).status, 403, "un mainteneur ne le peut pas");
		const f = await appel(u, "/api/admin/comptes/camille/sessions", { cookie: adm, methode: "DELETE" });
		assert.equal(f.status, 200, f.texte); assert.equal(f.corps.fermees, 2);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: c2 })).status, 401);
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
	});

	test("I4, E5 : exports CSV (BOM, « ; », formules neutralisées) et JSON ; approbations d'un mainteneur seulement", async () => {
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: "=HYPERLINK(\"x\");2", proposal: "+3" }) });
		await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour({ kind: "validation", ref: "V1-seuil", name: "Seuil à 28 °C", tab: "a-valider", anchor: "a-valider--v1-seuil", cat: "valide", text: "OK pour moi" }) });
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ kind: "validation", ref: "V1-seuil", name: "Seuil à 28 °C", tab: "a-valider", anchor: "a-valider--v1-seuil", cat: "valide", text: "Moi aussi" }) });
		const r = await appel(u, "/api/p/jardin/export/retours.csv", { cookie: camille });
		assert.equal(r.status, 200);
		assert.match(String(r.entetes.get("content-type")), /text\/csv/);
		assert.match(String(r.entetes.get("content-disposition")), /attachment; filename="jardin-retours-\d{4}-\d\d-\d\d\.csv"/);
		assert.ok(r.texte.replace(/^﻿/, "").startsWith("id;statut;sorte;ref;nom;"), r.texte.slice(0, 40));
		assert.equal(csv(["a"], [{ a: "=1" }]), "﻿a\r\n'=1\r\n", "BOM, CRLF, formule neutralisée");
		assert.ok(r.texte.includes(`"'=HYPERLINK(""x"");2"`), "formule neutralisée et citée");
		assert.ok(r.texte.includes(";'+3;"), "proposition « +3 » neutralisée");
		assert.ok(r.texte.includes(";Camille;"), "auteur par son nom");
		const t = await appel(u, "/api/p/jardin/export/tickets.json", { cookie: camille });
		assert.equal(t.status, 200); assert.equal(t.corps.export, "tickets"); assert.ok(Array.isArray(t.corps.lignes));
		assert.equal((await appel(u, "/api/p/jardin/export/journal.csv", { cookie: camille })).status, 403, "journal : mainteneur");
		assert.equal((await appel(u, "/api/p/jardin/export/journal.json", { cookie: maud })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/export/secret.csv", { cookie: maud })).status, 404);
		const a = await appel(u, "/api/p/jardin/approbations", { cookie: camille });
		assert.equal(a.status, 200);
		assert.deepEqual(a.corps.approbations.map((x: any) => [x.point, x.approuve_par, x.role]), [["V1-seuil", "Maud", "mainteneur"]], "le « valide » de Camille est un avis");
		const ac = await appel(u, "/api/p/jardin/export/approbations.csv", { cookie: maud });
		assert.ok(ac.texte.includes("V1-seuil;Seuil à 28 °C;;Maud;maud;mainteneur;"), ac.texte.slice(0, 300));
	});

	test("A3, L3 : rétention (3 gardés, plus celui que cite un retour ouvert) ; versions gardées et ancienne version en lecture seule", async () => {
		const generes: string[] = [];
		for (let i = 1; i <= 5; i++) {
			const d = exemple(); d.generated = `2026-11-0${i}T10:00:00Z`; generes.push(d.generated);
			const b = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } });
			assert.equal(b.status, 201, b.texte);
			if (i === 1) await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ codex: d.generated, text: "Sur le build 1" }) });
		}
		const l = await appel(u, "/api/p/jardin/builds?tous=1", { cookie: maud });
		assert.deepEqual(l.corps.builds.map((b: any) => b.build), [5, 4, 3, 1], "le 2 est supprimé ; le 1 gardé (un retour ouvert le cite)");
		assert.equal(l.corps.builds[0].donnees, generes[4]); assert.match(l.corps.builds[0].resume, /^OK /);
		const liste = await appel(u, "/p/jardin/b/", { cookie: camille });
		assert.equal(liste.status, 200);
		assert.match(liste.texte, /Versions du Wiki/); assert.match(liste.texte, /href="3\/">Build 3/); assert.match(liste.texte, /href="..\/">Build 5<\/a> \(dernier\)/);
		const v3 = await appel(u, "/p/jardin/b/3/", { cookie: camille });
		assert.equal(v3.status, 200);
		assert.ok(v3.texte.includes(`<meta name="wdd-lecture-seule" content="1">`) && v3.texte.includes(`<meta name="wdd-build" content="3">`));
		assert.match(v3.texte, /Ancienne version : build 3, en lecture seule/);
		const v5 = await appel(u, "/p/jardin/b/5/", { cookie: camille });
		assert.ok(!v5.texte.includes("<meta name=\"wdd-lecture-seule\""), "le dernier build n'est pas en lecture seule");
		assert.equal((await appel(u, "/p/jardin/b/2/", { cookie: camille })).status, 404, "supprimé par la rétention");
		assert.equal((await appel(u, "/p/jardin/b/3/")).status, 401, "sans session");
	});

	test("A4, A5 : version dans l'en-tête X-WDD-Version ; page d'état réservée à l'admin", async () => {
		const r = await appel(u, "/api/p/jardin/retours", { cookie: camille });
		assert.equal(r.entetes.get("x-wdd-version"), VERSION);
		assert.equal((await appel(u, "/api/admin/etat", { cookie: maud })).status, 403);
		const e = await appel(u, "/api/admin/etat", { cookie: adm });
		assert.equal(e.status, 200, e.texte);
		assert.equal(e.corps.version, VERSION);
		const p = e.corps.projets.find((x: any) => x.id === "jardin");
		assert.equal(p.builds, 4); assert.equal(p.dernier, 5); assert.ok(p.place.builds > 0 && p.place.depot > 0);
		assert.ok(Array.isArray(e.corps.traitements_echoues) && Array.isArray(e.corps.builds_refuses));
		assert.equal(e.corps.builds_garder, 3);
	});

	test("L3 : hôte des pages : l'ancienne version passe par l'entrée et y retombe", async () => {
		const port = await portLibre();
		const d2 = dossierTemp("lot3-pages");
		const s2 = await serveurTest(d2, { port, url: `http://127.0.0.1:${port}`, urlPages: `http://localhost:${port}` });
		try {
			await projet(s2.url, "jardin");
			const m = await session(s2.url, "jardin", "maud", "mainteneur", "Maud");
			for (let i = 0; i < 2; i++) await appel(s2.url, "/api/p/jardin/builds", { cookie: m, brut: JSON.stringify(exemple()), entetes: { "Content-Type": "application/json" } });
			const r1 = await appelHote(port, `127.0.0.1:${port}`, "/p/jardin/b/1/", { cookie: m });
			assert.equal(r1.status, 303);
			const loc = new URL(String(r1.entetes.location));
			assert.equal(loc.searchParams.get("b"), "1");
			const r2 = await appelHote(port, `localhost:${port}`, loc.pathname + loc.search);
			assert.equal(r2.status, 303); assert.equal(r2.entetes.location, "/p/jardin/b/1/");
			const cp = r2.setCookie.map(x => x.split(";")[0]).join("; ");
			const r3 = await appelHote(port, `localhost:${port}`, "/p/jardin/b/1/", { cookie: cp });
			assert.equal(r3.status, 200); assert.match(r3.texte, /Ancienne version : build 1/);
		} finally { await s2.arreter(); nettoyer(d2); }
	});

	test("A4 : sauvegarde hors du serveur : refusée tant qu'un serveur tient les données, faite une fois arrêté", async () => {
		const d3 = dossierTemp("lot3-sauv");
		const s3 = await serveurTest(d3);
		await projet(s3.url, "jardin");
		const outil = path.join(RACINE_OUTIL, "serveur", "src", "sauvegarde.ts");
		const env = { ...process.env }; delete env.WDD_DONNEES; delete env.WDD_SAUVEGARDE;
		const ko = await lancer([outil, d3, d3 + "-sauv"], env);
		assert.equal(ko.status, 1, ko.stdout + ko.stderr); assert.match(ko.stderr, /^ÉCHEC /);
		await s3.arreter();
		try {
			const ok = await lancer([outil, d3, d3 + "-sauv"], env);
			assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /^OK sauvegarde sauvegarde-\d{8}-\d{6}/);
			const n = fs.readdirSync(d3 + "-sauv").find(x => /^sauvegarde-/.test(x))!;
			assert.ok(fs.existsSync(path.join(d3 + "-sauv", n, "manifeste.json")) && fs.existsSync(path.join(d3 + "-sauv", n, "outil.sqlite")));
			assert.ok(!fs.existsSync(path.join(d3, "serveur.verrou")), "verrou rendu");
		} finally { nettoyer(d3); nettoyer(d3 + "-sauv"); }
	});
});
