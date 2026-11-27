// Étape 3.9, lot 1 (docs/etape3-9-sections-1-a-6.md) : côté serveur de la lecture du Wiki.
// - L7 : GET /api/p/<projet>/tickets-fiches, projection en lecture seule des tickets qui citent des éléments (pages),
//   avec le lien vers le ticket ; permise sur l'hôte des pages, alors que la liste complète des tickets ne l'est pas.
// - L11 : la page servie porte le numéro du build (<meta name="wdd-build">), repris par l'en-tête d'impression.
// - L4 : build.js refuse un statut ou une origine inconnus, et l'erreur revient à l'envoi du build.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, appelHote, dossierTemp, nettoyer, portLibre, serveurTest, projet, session } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";

const exemple = () => JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"), "utf8"));

describe("lecture du Wiki (étape 3.9, lot 1) : tickets des fiches, numéro de build, statut", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string;
	before(async () => {
		donnees = dossierTemp("lecture-wiki");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("L7 : tickets-fiches ne rend que les tickets qui citent un élément, sans description ni critères", async () => {
		const t1 = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Tomate <b>plus</b> grande", pages: ["plante:tomate", "regle:watering.base_interval"], description: "secret de travail", criteres: ["mesurer"] } });
		assert.equal(t1.status, 201, t1.texte);
		await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Sans page" } });
		const r = await appel(u, "/api/p/jardin/tickets-fiches", { cookie: camille });
		assert.equal(r.status, 200, r.texte);
		assert.deepEqual(r.corps.tickets, [{ id: t1.corps.id, titre: "Tomate <b>plus</b> grande", statut: "a-faire", pages: ["plante:tomate", "regle:watering.base_interval"], lien: `/#/p/jardin/t/${t1.corps.id}` }]);
		assert.equal((await appel(u, "/api/p/jardin/tickets-fiches", { cookie: camille, methode: "POST", corps: {} })).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/tickets-fiches")).status, 401, "sans session");
	});

	test("L11 : la page servie porte le numéro du build ; L4 : statut et origine acceptés, valeur inconnue refusée", async () => {
		const d = exemple();
		d.tabs[0].sections[0].items[0].statut = "specifie";
		d.tabs[0].sections[0].items[0].origine = "agent";
		const b = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		const p = await appel(u, "/p/jardin/", { cookie: camille });
		assert.equal(p.status, 200);
		assert.ok(p.texte.includes(`<meta name="wdd-build" content="${b.corps.build}">`), "méta du numéro de build");
		const a = await appel(u, `/api/p/jardin/builds/${b.corps.build}/page`, { cookie: maud });
		assert.ok(a.corps.html.includes(`<meta name="wdd-build" content="${b.corps.build}">`), "même méta pour outil apercu");
		d.tabs[0].sections[0].items[0].statut = "fini";
		const k = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } });
		assert.equal(k.status, 422, k.texte);
		assert.match(k.texte, /statut « fini » inconnu/);
		d.tabs[0].sections[0].items[0].statut = "idee";
		d.tabs[0].sections[0].items[0].image_grande = "https://exemple.invalid/x.png";
		const g = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } });
		assert.equal(g.status, 422); assert.match(g.texte, /image_grande/);
	});

	test("L7 : hôte des pages : tickets-fiches permis (lien vers l'hôte principal), liste complète des tickets refusée", async () => {
		const port = await portLibre();
		const d2 = dossierTemp("lecture-wiki-pages");
		const s2 = await serveurTest(d2, { port, url: `http://127.0.0.1:${port}`, urlPages: `http://localhost:${port}` });
		try {
			await projet(s2.url, "jardin");
			const m = await session(s2.url, "jardin", "maud", "mainteneur", "Maud");
			const t = await appel(s2.url, "/api/p/jardin/tickets", { cookie: m, corps: { titre: "Arrosage", pages: ["plante:tomate"] } });
			assert.equal(t.status, 201, t.texte);
			const c = await session(s2.url, "jardin", "camille", "contributeur", "Camille");
			const r1 = await appelHote(port, `127.0.0.1:${port}`, "/p/jardin/", { cookie: c });
			const loc = new URL(String(r1.entetes.location));
			const r2 = await appelHote(port, `localhost:${port}`, loc.pathname + loc.search);
			const cp = r2.setCookie.find(x => x.includes("Path=/api/p/jardin/"))!.split(";")[0];
			const r = await appelHote(port, `localhost:${port}`, "/api/p/jardin/tickets-fiches", { cookie: cp });
			assert.equal(r.status, 200, r.texte);
			assert.equal(r.corps.tickets[0].lien, `http://127.0.0.1:${port}/#/p/jardin/t/${t.corps.id}`);
			assert.equal((await appelHote(port, `localhost:${port}`, "/api/p/jardin/tickets", { cookie: cp })).status, 404, "liste complète : hôte principal seulement");
			// L8 : un lien de fiche copié sur l'hôte des pages, ouvert sans session : l'entrée par l'hôte principal garde l'ancre.
			const e = await appelHote(port, `localhost:${port}`, "/p/jardin/");
			assert.equal(e.status, 401);
			assert.ok(e.texte.includes(`location.replace(${JSON.stringify(`http://127.0.0.1:${port}/p/jardin/`)}+location.hash)`), "l'ancre suit le passage par l'hôte principal");
		} finally { await s2.arreter(); nettoyer(d2); }
	});
});
