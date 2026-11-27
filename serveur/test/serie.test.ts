// Étape 3.7, R1 (docs/etape3-7-dix-premieres.md) : série de retours, POST /api/p/<projet>/retours/serie. Tout ou rien,
// un seul commit, une seule diffusion ; mêmes règles que la création d'un retour ; aussi sur l'hôte des pages (le Wiki
// l'envoie), avec l'Origin de l'hôte des pages.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { appel, appelHote, docRetour, dossierTemp, nettoyer, serveurTest, projet, session, portLibre, depotDe, nbCommits, git, ecouter } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

describe("série de retours (un seul hôte)", () => {
	let s: Serveur, donnees: string, u: string, camille: string, lea: string, maud: string;
	const serie = (cookie: string, retours: unknown) => appel(u, "/api/p/jardin/retours/serie", { cookie, corps: { retours } });
	const docs = async () => (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs;
	before(async () => {
		donnees = dossierTemp("serie");
		s = await serveurTest(donnees); u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("trois retours : un commit « série : 3 retours », ids dans l'ordre, auteur posé par le serveur, une diffusion", async () => {
		const flux = await ecouter(s.port, "/api/p/jardin/flux", camille);
		try {
			await flux.attendre(1);
			const avant = nbCommits(depotDe(donnees, "jardin"));
			const r = await serie(camille, [docRetour({ text: "Un" }), docRetour({ ref: "basilic", text: "Deux", by: "quelquun" }), docRetour({ text: "Trois" })]);
			assert.equal(r.status, 201, r.texte);
			assert.equal(r.corps.ids.length, 3); assert.match(r.corps.ids[0], /^[A-Za-z0-9]{20}$/);
			assert.equal(nbCommits(depotDe(donnees, "jardin")), avant + 1);
			assert.equal(git(depotDe(donnees, "jardin"), "log", "-1", "--format=%s").trim(), "série : 3 retours");
			const d = await docs();
			assert.deepEqual(r.corps.ids.map((id: string) => d.find((x: any) => x.id === id).donnees.text), ["Un", "Deux", "Trois"]);
			assert.ok(r.corps.ids.every((id: string) => d.find((x: any) => x.id === id).donnees.by === "camille"), "by = le compte, pas la valeur envoyée");
			await flux.attendre(2);
			await new Promise(r2 => setTimeout(r2, 300));
			assert.equal(flux.evenements.length, 2, "une seule diffusion pour la série");
		} finally { flux.fermer(); }
	});

	test("tout ou rien : une entrée invalide → 400 avec son index, rien créé ; liste vide, plus de 50, clé inconnue : 400", async () => {
		const n = (await docs()).length, c = nbCommits(depotDe(donnees, "jardin"));
		const r = await serie(camille, [docRetour(), docRetour({ status: "fait" })]);
		assert.equal(r.status, 400); assert.equal(r.corps.index, 1, r.texte);
		assert.equal((await serie(camille, [])).status, 400);
		assert.equal((await serie(camille, Array.from({ length: 51 }, () => docRetour()))).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/retours/serie", { cookie: camille, corps: { retours: [docRetour()], autre: 1 } })).status, 400);
		assert.equal((await docs()).length, n); assert.equal(nbCommits(depotDe(donnees, "jardin")), c);
	});

	test("droits : un lecteur ne crée pas de série (403) ; 50 retours passent", async () => {
		assert.equal((await serie(lea, [docRetour()])).status, 403);
		const r = await serie(camille, Array.from({ length: 50 }, (_, i) => docRetour({ text: "Lot " + i })));
		assert.equal(r.status, 201, r.texte); assert.equal(r.corps.ids.length, 50);
	});
});

describe("série de retours sur l'hôte des pages", () => {
	let s: Serveur, donnees: string, port: number, u: string, uPages: string, H: string, P: string, camille: string;
	before(async () => {
		donnees = dossierTemp("serie-pages");
		port = await portLibre();
		H = `127.0.0.1:${port}`; P = `localhost:${port}`; u = `http://${H}`; uPages = `http://${P}`;
		s = await serveurTest(donnees, { port, url: u, urlPages: uPages });
		await projet(u, "jardin");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	test("Origin de l'hôte des pages : 201 ; Origin de l'hôte principal : 403", async () => {
		const r1 = await appelHote(port, H, "/p/jardin/", { cookie: camille });
		const loc = new URL(String(r1.entetes.location));
		const r2 = await appelHote(port, P, loc.pathname + loc.search);
		const c = r2.setCookie.find(x => x.includes("Path=/api/p/jardin/"))!.split(";")[0];
		const ok = await appelHote(port, P, "/api/p/jardin/retours/serie", { cookie: c, origin: uPages, corps: { retours: [docRetour(), docRetour()] } });
		assert.equal(ok.status, 201, ok.texte); assert.equal(ok.corps.ids.length, 2);
		assert.equal((await appelHote(port, P, "/api/p/jardin/retours/serie", { cookie: c, origin: u, corps: { retours: [docRetour()] } })).status, 403);
	});
});
