// Étape 3.9, lot 2 (docs/etape3-9-sections-1-a-6.md) : côté serveur des retours.
// - R3 / E3 : champs facultatifs field (champ visé) et pour (à qui le retour est confié) ; un mainteneur confie un retour.
// - R6 : « Moi aussi » (POST / DELETE …/retours/<id>/aussi), posé par le serveur seulement.
// - R5 : fusion des doublons par un mainteneur, tout ou rien, un commit, textes jamais réécrits.
// - Écart 31 : GET …/noms, noms affichés des membres pour tout membre, « ancien membre » pour un compte retiré.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { appel, appelHote, docRetour, dossierTemp, nettoyer, portLibre, serveurTest, projet, session, git, depotDe } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

describe("retours, lot 2 : champ visé, pour, « Moi aussi », fusion, noms", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string, leo: string, agent: string;
	before(async () => {
		donnees = dossierTemp("retours-lot2");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		leo = await session(u, "jardin", "leo", "contributeur", "Léo");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const doc = async (id: string) => (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((d: any) => d.id === id);
	const creer = async (cookie: string, extra: Record<string, unknown> = {}) => { const r = await appel(u, "/api/p/jardin/retours", { cookie, corps: docRetour(extra) }); assert.equal(r.status, 201, r.texte); return r.corps.id as string; };

	test("R3, E3 : field et pour à la création ; aussi et fusionne_dans refusés ; un mainteneur confie, pas un contributeur", async () => {
		const id = await creer(camille, { field: "Arrosage", pour: "leo" });
		const d = await doc(id);
		assert.equal(d.donnees.field, "Arrosage"); assert.equal(d.donnees.pour, "leo");
		for (const x of [{ aussi: "leo" }, { fusionne_dans: id }, { pour: "pas un id !" }, { field: "x".repeat(201) }])
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour(x) })).status, 400, JSON.stringify(x).slice(0, 40));
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: leo, methode: "PATCH", corps: { version: 1, champs: { pour: "leo" } } })).status, 403, "contributeur : pas sur le retour d'un autre");
		const m = await appel(u, `/api/p/jardin/retours/${id}`, { cookie: maud, methode: "PATCH", corps: { version: 1, champs: { pour: "maud" } } });
		assert.equal(m.status, 200, m.texte);
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: maud, methode: "PATCH", corps: { version: 2, champs: { pour: "camille", text: "réécrit" } } })).status, 403, "confier, pas réécrire");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: camille, methode: "PATCH", corps: { version: 2, champs: { field: "Semis" } } })).status, 200, "l'auteur corrige le champ visé");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { bearer: agent, methode: "PATCH", corps: { version: 3, champs: { pour: "leo" } } })).status, 403, "l'agent ne confie pas");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: camille, methode: "PATCH", corps: { version: 3, champs: { aussi: "leo" } } })).status, 403, "aussi : jamais par PATCH");
	});

	test("L9 (étape 3.9, lot 6) : point sur l'image : forme validée, posé par l'auteur, pas par un autre", async () => {
		const id = await creer(camille, { point: "0.25,0.75@0123abcd" });
		assert.equal((await doc(id)).donnees.point, "0.25,0.75@0123abcd");
		for (const p of ["1.5,0", "0.123456,0.1", "0.5;0.5", "0.5,0.5@xyz"]) assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ point: p }) })).status, 400, p);
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: camille, methode: "PATCH", corps: { version: 1, champs: { point: "0.3,0.7@0123abcd" } } })).status, 200, "l'auteur le corrige");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}`, { cookie: leo, methode: "PATCH", corps: { version: 2, champs: { point: "0,0" } } })).status, 403);
	});

	test("R6 : « Moi aussi » ajoute puis retire l'acteur ; ni l'auteur, ni un agent ; version vérifiée", async () => {
		const id = await creer(camille);
		const r1 = await appel(u, `/api/p/jardin/retours/${id}/aussi`, { cookie: leo, corps: { version: 1 } });
		assert.equal(r1.status, 200, r1.texte); assert.equal(r1.corps.version, 2);
		let d = await doc(id);
		assert.equal(d.donnees.aussi, "leo"); assert.equal(d.donnees.status, "nouveau"); assert.equal(d.donnees.text, "Trop d'eau.");
		assert.match(git(depotDe(donnees, "jardin"), "log", "-1", "--format=%s"), new RegExp(`retour ${id} : moi aussi`));
		const r2 = await appel(u, `/api/p/jardin/retours/${id}/aussi`, { cookie: leo, corps: { version: 2 } });
		assert.equal(r2.corps.inchange, true, "déjà dit : rien n'est écrit");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}/aussi`, { cookie: maud, corps: { version: 1 } })).status, 409);
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}/aussi`, { cookie: camille, corps: { version: 2 } })).status, 403, "l'auteur");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}/aussi`, { bearer: agent, corps: { version: 2 } })).status, 403, "un agent");
		assert.equal((await appel(u, `/api/p/jardin/retours/${id}/aussi`, { cookie: maud, corps: { version: 2 } })).status, 200);
		const del = await appel(u, `/api/p/jardin/retours/${id}/aussi?version=3`, { cookie: leo, methode: "DELETE" });
		assert.equal(del.status, 200, del.texte);
		d = await doc(id);
		assert.equal(d.donnees.aussi, "maud");
	});

	test("R5 : fusion par un mainteneur : doublons « fait », réponse et fusionne_dans ; auteurs dans « aussi » du principal ; un commit", async () => {
		const p = await creer(camille, { text: "Arrosage trop fréquent." });
		const d1 = await creer(leo, { text: "Il faut arroser moins souvent." });
		const d2 = await creer(maud, { text: "Moins d'eau, svp." });
		await appel(u, `/api/p/jardin/retours/${d2}/aussi`, { cookie: camille, corps: { version: 1 } });
		const corps = { version: 1, doublons: [{ id: d1, version: 1 }, { id: d2, version: 2 }] };
		assert.equal((await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { cookie: leo, corps })).status, 403, "contributeur");
		assert.equal((await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { bearer: agent, corps })).status, 403, "agent");
		assert.equal((await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { cookie: maud, corps: { version: 1, doublons: [{ id: p, version: 1 }] } })).status, 400, "dans lui-même");
		assert.equal((await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { cookie: maud, corps: { version: 1, doublons: [{ id: d1, version: 9 }] } })).status, 409, "version d'un doublon");
		const avant = Number(git(depotDe(donnees, "jardin"), "rev-list", "--count", "HEAD").trim());
		const r = await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { cookie: maud, corps });
		assert.equal(r.status, 200, r.texte);
		assert.equal(Number(git(depotDe(donnees, "jardin"), "rev-list", "--count", "HEAD").trim()), avant + 1, "un seul commit");
		assert.match(git(depotDe(donnees, "jardin"), "log", "-1", "--format=%s").trim(), new RegExp(`^fusion : 2 retours dans ${p}$`));
		const P = await doc(p), D1 = await doc(d1), D2 = await doc(d2);
		assert.equal(P.donnees.aussi, "leo maud", "auteurs des doublons ; camille, auteur du principal, n'y est pas");
		assert.equal(P.donnees.text, "Arrosage trop fréquent."); assert.equal(P.donnees.status, "nouveau");
		for (const D of [D1, D2]) {
			assert.equal(D.donnees.status, "fait"); assert.equal(D.donnees.fusionne_dans, p);
			assert.match(D.donnees.reply, new RegExp(`^Fusionné dans le retour « Tomate » \\(${p}\\)`));
		}
		assert.equal(D1.donnees.text, "Il faut arroser moins souvent.", "texte jamais réécrit");
		assert.equal((await appel(u, `/api/p/jardin/retours/${p}/fusionner`, { cookie: maud, corps: { version: 2, doublons: [{ id: d1, version: 2 }] } })).status, 400, "déjà fusionné");
		const adm = await session(u, "jardin", "adm", "admin", "Adèle");
		const j = await appel(u, "/api/admin/journal?projet=jardin", { cookie: adm });
		assert.ok(JSON.stringify(j.corps).includes("retours fusionnés"), "journal d'audit");
	});

	test("E3 : « À moi » liste les retours ouverts qui me sont confiés et ceux qui me mentionnent", async () => {
		const p = await creer(maud, { text: "À trancher par le son.", pour: "camille" });
		const m = await creer(maud, { text: "@Camille peux-tu regarder ? Et @camillette aussi." });
		await creer(maud, { text: "Rien pour @camillette seule." });
		const r = await appel(u, "/api/moi", { cookie: camille });
		const a = r.corps.projets.find((x: any) => x.id === "jardin").a_moi;
		assert.deepEqual(a.pour_moi.map((x: any) => x.id), [p]);
		assert.deepEqual(a.mentions.map((x: any) => x.id), [m], "« @camillette » ne vaut pas « @camille »");
		assert.equal(a.total.pour_moi, 1); assert.equal(a.total.mentions, 1);
		const l = await appel(u, "/api/moi", { cookie: leo });
		assert.equal(l.corps.projets.find((x: any) => x.id === "jardin").a_moi.pour_moi.length, 0);
	});

	test("écart 31 : noms lisibles par tout membre, sans e-mail ; compte retiré : « ancien membre »", async () => {
		await creer(leo);
		let r = await appel(u, "/api/p/jardin/noms", { cookie: camille });
		assert.equal(r.status, 200, r.texte);
		assert.equal(r.corps.noms.maud, "Maud"); assert.equal(r.corps.noms.leo, "Léo"); assert.equal(r.corps.noms.camille, "Camille");
		assert.ok(!/@/.test(r.texte), "aucune adresse e-mail");
		assert.equal((await appel(u, "/api/p/jardin/membres/leo", { cookie: maud, methode: "DELETE" })).status, 200);
		r = await appel(u, "/api/p/jardin/noms", { cookie: camille });
		assert.equal(r.corps.noms.leo, "ancien membre");
		assert.equal((await appel(u, "/api/p/jardin/noms")).status, 401);
	});

	test("hôte des pages : noms, « Moi aussi » et fusion permis", async () => {
		const port = await portLibre();
		const d2 = dossierTemp("retours-lot2-pages");
		const s2 = await serveurTest(d2, { port, url: `http://127.0.0.1:${port}`, urlPages: `http://localhost:${port}` });
		try {
			await projet(s2.url, "jardin");
			const m = await session(s2.url, "jardin", "maud", "mainteneur", "Maud");
			const c = await session(s2.url, "jardin", "camille", "contributeur", "Camille");
			const a = (await appel(s2.url, "/api/p/jardin/retours", { cookie: c, corps: docRetour() })).corps.id;
			const b = (await appel(s2.url, "/api/p/jardin/retours", { cookie: c, corps: docRetour({ text: "Doublon." }) })).corps.id;
			const entree = async (ck: string) => {
				const r1 = await appelHote(port, `127.0.0.1:${port}`, "/p/jardin/", { cookie: ck });
				const loc = new URL(String(r1.entetes.location));
				const r2 = await appelHote(port, `localhost:${port}`, loc.pathname + loc.search);
				return r2.setCookie.find(x => x.includes("Path=/api/p/jardin/"))!.split(";")[0];
			};
			const cm = await entree(m);
			const o = { origin: `http://localhost:${port}` };
			assert.equal((await appelHote(port, `localhost:${port}`, "/api/p/jardin/noms", { cookie: cm })).status, 200);
			const x = await appelHote(port, `localhost:${port}`, `/api/p/jardin/retours/${a}/aussi`, { cookie: cm, ...o, corps: { version: 1 } });
			assert.equal(x.status, 200, x.texte);
			const f = await appelHote(port, `localhost:${port}`, `/api/p/jardin/retours/${a}/fusionner`, { cookie: cm, ...o, corps: { version: 2, doublons: [{ id: b, version: 1 }] } });
			assert.equal(f.status, 200, f.texte);
		} finally { await s2.arreter(); nettoyer(d2); }
	});
});
