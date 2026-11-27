// Étape 3.7, G2 (docs/etape3-7-dix-premieres.md, docs/ci/README.md) : jeton « publieur » d'une CI. Il publie un build
// et lit l'état du dernier (avec l'empreinte des données, sans la date d'export) ; tout le reste lui est refusé. Jamais
// donné par un appairage ; un jeton publieur d'un contributeur reste publieur.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { appel, docRetour, dossierTemp, nettoyer, serveurTest, projet, session } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";

const exemple = () => fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
const { empreinteDonnees } = createRequire(import.meta.url)(path.join(RACINE_OUTIL, "site", "changements.js"));

describe("jeton publieur", () => {
	let s: Serveur, donnees: string, u: string, maud: string, camille: string, pub: string, idRetour: string;
	before(async () => {
		donnees = dossierTemp("publieur");
		s = await serveurTest(donnees); u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		const j = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "CI", role: "publieur" } });
		assert.equal(j.status, 201, j.texte); assert.equal(j.corps.role, "publieur");
		pub = j.corps.jeton;
		idRetour = (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() })).corps.id;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("publie un build et lit le dernier : empreinte des données sans la date d'export", async () => {
		const b = await appel(u, "/api/p/jardin/builds", { bearer: pub, brut: exemple(), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		const g = await appel(u, "/api/p/jardin/builds", { bearer: pub });
		assert.equal(g.status, 200);
		const d = JSON.parse(exemple().toString("utf8"));
		assert.equal(g.corps.dernier.empreinte, empreinteDonnees(d));
		assert.equal(empreinteDonnees({ ...d, generated: "2030-01-01T00:00:00Z" }), g.corps.dernier.empreinte, "la date d'export ne compte pas");
		assert.notEqual(empreinteDonnees({ ...d, title: "Autre" }), g.corps.dernier.empreinte);
	});

	test("tout le reste : 403 (retours, notes, flux, session, tickets, demandes, jetons, page d'un build)", async () => {
		const refus: [string, string, unknown?][] = [
			["GET", "/api/p/jardin/retours"], ["POST", "/api/p/jardin/retours", docRetour()], ["PATCH", `/api/p/jardin/retours/${idRetour}`, { version: 1, champs: { status: "fait" } }],
			["POST", "/api/p/jardin/retours/batch", { ecritures: [] }], ["POST", "/api/p/jardin/retours/serie", { retours: [docRetour()] }],
			["GET", "/api/p/jardin/notes"], ["PUT", "/api/p/jardin/notes/notes_2026-11-25.json", { date: "2026-11-25" }], ["GET", "/api/p/jardin/flux"], ["GET", "/api/p/jardin/session"],
			["GET", "/api/p/jardin/tickets"], ["POST", "/api/p/jardin/tickets", { titre: "x" }], ["GET", "/api/p/jardin/demandes"], ["GET", "/api/p/jardin/jetons"],
			["GET", "/api/p/jardin/builds/1/page"], ["POST", "/api/p/jardin/import", { retours: [] }], ["GET", "/api/p/jardin/reglages"],
		];
		for (const [methode, chemin, corps] of refus) {
			const r = await appel(u, chemin, { bearer: pub, methode, corps });
			assert.equal(r.status, 403, `${methode} ${chemin} : ${r.status} ${r.texte.slice(0, 100)}`);
		}
		assert.equal((await appel(u, "/api/moi", { bearer: pub })).status, 403);
	});

	test("jeton publieur d'un contributeur : reste publieur ; un contributeur ne peut pas en créer (gestion : mainteneur)", async () => {
		assert.equal((await appel(u, "/api/p/jardin/jetons", { cookie: camille, corps: { nom: "CI", role: "publieur" } })).status, 403);
		const l = await appel(u, "/api/p/jardin/jetons", { cookie: maud });
		assert.ok(l.corps.jetons.some((j: any) => j.role === "publieur" && j.nom === "CI"));
	});

	test("appairage : le rôle publieur n'est pas proposé (400)", async () => {
		const r = await appel(u, "/api/appairage", { corps: { poste: "poste", projet: "jardin", role: "publieur", usage: "permanent" } });
		assert.equal(r.status, 400, r.texte);
		assert.match(r.texte, /agent ou mainteneur/);
	});
});
