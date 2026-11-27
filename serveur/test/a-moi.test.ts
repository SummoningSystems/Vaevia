// Étape 3.7, E1 (docs/etape3-7-dix-premieres.md) : boîte « À moi » de l'Accueil, calculée par GET /api/moi (a_moi de
// chaque projet) : questions de l'agent sur MES retours, points « À valider » du dernier build sans aucune réponse
// (pas pour un lecteur), tickets en revue (mainteneur et admin seulement).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, docRetour, dossierTemp, nettoyer, serveurTest, projet, session } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";

const SITE = path.join(RACINE_OUTIL, "site");

describe("boîte « À moi »", () => {
	let s: Serveur, donnees: string, u: string, maud: string, camille: string, lea: string, agent: string;
	const moi = async (cookie: string) => (await appel(u, "/api/moi", { cookie })).corps.projets.find((p: any) => p.id === "jardin").a_moi;
	before(async () => {
		donnees = dossierTemp("a-moi");
		s = await serveurTest(donnees); u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("sans build ni retour : listes vides", async () => {
		assert.deepEqual(await moi(camille), { questions: [], a_valider: [], en_revue: [], pour_moi: [], mentions: [], total: { questions: 0, a_valider: 0, en_revue: 0, pour_moi: 0, mentions: 0 } });
	});

	test("questions de l'agent : seulement sur mes retours, avec la question et l'ancre", async () => {
		const mien = (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: "Trop d'eau ?" }) })).corps;
		const autre = (await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour({ ref: "basilic", name: "Basilic", anchor: "plantes--basilic" }) })).corps;
		for (const [r, q] of [[mien, "Tous les 3 jours ou 4 ?"], [autre, "Quelle variété ?"]] as const) {
			const p = await appel(u, `/api/p/jardin/retours/${r.id}`, { bearer: agent, methode: "PATCH", corps: { champs: { status: "question", reply: q, replied: new Date().toISOString() }, version: r.version } });
			assert.equal(p.status, 200, p.texte);
		}
		const c = await moi(camille);
		assert.equal(c.total.questions, 1);
		assert.deepEqual({ ...c.questions[0], quand: "" }, { id: mien.id, kind: "plante", ref: "tomate", nom: "Tomate", ancre: "plantes--tomate", question: "Tous les 3 jours ou 4 ?", quand: "" });
		assert.equal((await moi(maud)).questions[0].ref, "basilic");
	});

	test("points « À valider » du dernier build sans réponse ; pas pour un lecteur", async () => {
		const notes = JSON.parse(fs.readFileSync(path.join(SITE, "examples", "notes_exemple.json"), "utf8"));
		const r = await appel(u, `/api/p/jardin/notes/notes_${notes.date}.json`, { bearer: agent, methode: "PUT", corps: notes });
		assert.ok(r.status === 201 || r.status === 200, r.texte);
		const b = await appel(u, "/api/p/jardin/builds", { bearer: agent, brut: fs.readFileSync(path.join(SITE, "examples", "data.json")), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		const ids = notes.validations.map((v: any) => v.id);
		let c = await moi(camille);
		assert.deepEqual(c.a_valider.map((v: any) => v.id), ids);
		assert.equal(c.a_valider[0].texte, notes.validations[0].text.slice(0, 159) + (notes.validations[0].text.length > 160 ? "…" : ""));
		// Une réponse de n'importe qui (ici Maud) retire le point de la boîte de tous.
		const v0 = ids[0];
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour({ kind: "validation", ref: v0, name: v0, tab: "a-valider", anchor: "a-valider--x", cat: "valide" }) })).status, 201);
		c = await moi(camille);
		assert.deepEqual(c.a_valider.map((v: any) => v.id), ids.slice(1));
		assert.equal((await moi(lea)).total.a_valider, 0, "un lecteur ne valide pas");
	});

	test("tickets en revue : pour un mainteneur seulement", async () => {
		const t = (await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "Arrosage par forte chaleur" } })).corps;
		assert.ok(t.id, JSON.stringify(t));
		assert.equal((await appel(u, `/api/p/jardin/tickets/${t.id}/prendre`, { cookie: camille, corps: { version: 1 } })).status, 200);
		const r = await appel(u, `/api/p/jardin/tickets/${t.id}`, { cookie: camille, methode: "PATCH", corps: { version: 2, champs: { statut: "en-revue" } } });
		assert.equal(r.status, 200, r.texte);
		assert.deepEqual((await moi(maud)).en_revue, [{ id: t.id, titre: "Arrosage par forte chaleur" }]);
		assert.equal((await moi(camille)).total.en_revue, 0);
	});
});
