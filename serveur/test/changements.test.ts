// Étape 3.7, L1 et G1 (docs/etape3-7-dix-premieres.md) : ce qui a changé entre deux builds (calculé par build.js
// --precedent, injecté dans la page), et les retours ouverts dont l'élément a disparu du build (avertissement rendu à
// l'agent ; anciennes_refs pour un renommage).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appel, docRetour, dossierTemp, nettoyer, serveurTest, projet, session } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";

const SITE = path.join(RACINE_OUTIL, "site");
const { calculerChangements, refsDeLaPage } = createRequire(import.meta.url)(path.join(SITE, "changements.js"));
const exemple = () => JSON.parse(fs.readFileSync(path.join(SITE, "examples", "data.json"), "utf8"));
const item = (d: any, tab: string, id: string) => d.tabs.find((t: any) => t.id === tab).sections.flatMap((s: any) => s.items).find((i: any) => i.id === id);
const donneesPage = (page: string) => JSON.parse((page.match(/^const DATA = (\{.*\});$/m) || [])[1] || "null");

describe("calculerChangements", () => {
	test("identiques : null", () => { assert.equal(calculerChangements(exemple(), exemple()), null); });
	test("modifié, ajouté, retiré ; champs avant → après ; image et tableau sans contenu", () => {
		const a = exemple(), b = exemple();
		const basilic = item(b, "plantes", "basilic");
		basilic.fields = basilic.fields.map((f: any) => f[0] === "Arrosage" ? ["Arrosage", "tous les 3 jours"] : f).filter((f: any) => f[0] !== "Semis");
		basilic.fields.push(["Exposition", "soleil"]);
		basilic.image = "data:image/png;base64,AAAA";
		basilic.name = "Basilic grand vert";
		const sec = b.tabs[0].sections[0];
		sec.items = sec.items.filter((i: any) => i.id !== "poivron");
		sec.items.push({ id: "aubergine", kind: "plante", name: "Aubergine" });
		const c = calculerChangements(a, b);
		assert.equal(c.depuis, a.generated);
		assert.deepEqual(c.ajoutes.map((x: any) => x.id), ["aubergine"]);
		assert.deepEqual(c.retires.map((x: any) => [x.tab, x.id, x.kind, x.name]), [["plantes", "poivron", "plante", "Poivron"]]);
		assert.equal(c.modifies.length, 1);
		const m = c.modifies[0];
		assert.equal(m.id, "basilic"); assert.equal(m.onglet, "Plantes");
		const champ = (l: string) => m.champs.find((x: any) => x[0] === l);
		assert.deepEqual(champ("Nom"), ["Nom", "Basilic", "Basilic grand vert"]);
		assert.equal(champ("Arrosage")[2], "tous les 3 jours");
		assert.equal(champ("Semis")[2], "", "champ retiré : après vide");
		assert.deepEqual(champ("Exposition"), ["Exposition", "", "soleil"]);
		assert.ok(!JSON.stringify(m).includes("base64"), "l'image n'est jamais recopiée");
		assert.equal(c.coupes, 0);
	});
	test("même id dans deux onglets : deux éléments distincts ; valeurs coupées à 200 ; plafond de 500", () => {
		const mk = (n: number, v: string) => ({ tabs: [{ id: "a", label: "A", sections: [{ id: "s", title: "S", items: Array.from({ length: n }, (_, i) => ({ id: "x" + i, kind: "k", name: "X", text: v })) }] }] });
		const c = calculerChangements(mk(600, "a"), mk(600, "b".repeat(300)));
		assert.equal(c.modifies.length, 500); assert.equal(c.coupes, 100);
		assert.equal(c.modifies[0].champs[0][2].length, 200);
		const deux = { tabs: [{ id: "a", label: "A", sections: [{ id: "s", title: "S", items: [{ id: "x", kind: "k", name: "X" }] }] }, { id: "b", label: "B", sections: [{ id: "s", title: "S", items: [{ id: "x", kind: "k", name: "X" }] }] }] };
		const un = { tabs: [deux.tabs[0]] };
		assert.deepEqual(calculerChangements(un, deux).ajoutes.map((x: any) => x.tab), ["b"]);
	});
	test("renommage déclaré (anciennes_refs) : un élément modifié (« Ref » avant → après), ni retrait ni ajout", () => {
		const a = exemple(), b = exemple();
		const t = item(b, "plantes", "tomate"); t.id = "tomate-coeur"; t.anciennes_refs = ["tomate"];
		const c = calculerChangements(a, b);
		assert.deepEqual(c.ajoutes, []); assert.deepEqual(c.retires, []);
		assert.deepEqual(c.modifies.map((x: any) => [x.id, x.champs[0]]), [["tomate-coeur", ["Ref", "tomate", "tomate-coeur"]]]);
		const sans = exemple(); item(sans, "plantes", "tomate").id = "tomate-coeur";
		const c2 = calculerChangements(a, sans);
		assert.deepEqual([c2.ajoutes.map((x: any) => x.id), c2.retires.map((x: any) => x.id)], [["tomate-coeur"], ["tomate"]]);
	});
	test("refsDeLaPage : éléments, anciennes_refs, notes, onglets (remarque générale)", () => {
		const d = exemple(); item(d, "plantes", "tomate").anciennes_refs = ["tomate-ancienne"];
		d.notes = { sets: [{ changes: [{ id: "V1-x" }], validations: [{ id: "V1-y" }], measures: [{ id: "m-z" }] }] };
		const r = refsDeLaPage(d);
		for (const k of ["plante\u0000tomate", "plante\u0000tomate-ancienne", "nouveaute\u0000V1-x", "validation\u0000V1-y", "mesure\u0000m-z", "general\u0000plantes", "general\u0000a-valider"]) assert.ok(r.has(k), k);
		assert.ok(!r.has("plante\u0000aubergine"));
	});
});

describe("build.js --precedent et anciennes_refs", () => {
	let dir: string;
	before(() => { dir = dossierTemp("chg-build"); });
	after(() => nettoyer(dir));
	const build = (data: unknown, ...extra: string[]) => {
		fs.writeFileSync(path.join(dir, "d.json"), JSON.stringify(data));
		return spawnSync(process.execPath, [path.join(SITE, "build.js"), path.join(dir, "d.json"), path.join(dir, "p.html"), "--no-notes", "--stockage=http", ...extra], { encoding: "utf8" });
	};
	test("sans --precedent : ni changements dans la page ni mention dans le résumé", () => {
		const r = build(exemple());
		assert.equal(r.status, 0, r.stderr);
		assert.equal(donneesPage(fs.readFileSync(path.join(dir, "p.html"), "utf8")).changements, undefined);
		assert.doesNotMatch(r.stdout, /changements/);
	});
	test("avec --precedent : diff injecté, résumé « changements : 1 modifiés, 0 ajoutés, 0 retirés »", () => {
		fs.writeFileSync(path.join(dir, "avant.json"), JSON.stringify(exemple()));
		const b = exemple(); item(b, "plantes", "tomate").name = "Tomate cœur de bœuf";
		const r = build(b, "--precedent", path.join(dir, "avant.json"));
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, / · changements : 1 modifiés, 0 ajoutés, 0 retirés · stockage http/);
		const c = donneesPage(fs.readFileSync(path.join(dir, "p.html"), "utf8")).changements;
		assert.deepEqual(c.modifies[0].champs, [["Nom", "Tomate", "Tomate cœur de bœuf"]]);
	});
	test("--precedent identique : « changements : aucun », rien d'injecté ; illisible : avertissement, build réussi", () => {
		const r = build(exemple(), "--precedent", path.join(dir, "avant.json"));
		assert.equal(r.status, 0); assert.match(r.stdout, /changements : aucun/);
		assert.equal(donneesPage(fs.readFileSync(path.join(dir, "p.html"), "utf8")).changements, undefined);
		const r2 = build(exemple(), "--precedent", path.join(dir, "absent.json"));
		assert.equal(r2.status, 0); assert.match(r2.stderr, /attention : --precedent : lecture impossible/);
	});
	test("onglet « changements » réservé ; anciennes_refs validées", () => {
		const d = exemple(); d.tabs[0].id = "changements";
		assert.match(build(d).stderr, /onglet « changements » : id réservé/);
		const e = exemple();
		item(e, "plantes", "tomate").anciennes_refs = "tomate-v1";
		assert.match(build(e).stderr, /anciennes_refs doit être une liste/);
		item(e, "plantes", "tomate").anciennes_refs = ["tomate"];
		assert.match(build(e).stderr, /contient l'id de l'élément lui-même/);
		item(e, "plantes", "tomate").anciennes_refs = ["basilic"];
		assert.match(build(e).stderr, /« basilic » est l'id d'un autre élément de sorte « plante »/);
		item(e, "plantes", "tomate").anciennes_refs = ["tomate-v1", "route:/"];
		assert.equal(build(e).status, 0, "même texte qu'un élément d'une autre sorte : permis");
	});
});

describe("serveur : changements entre builds et retours sur des éléments disparus", () => {
	let s: Serveur, donnees: string, u: string, maud: string;
	const publier = async (d: unknown) => {
		const r = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } });
		assert.equal(r.status, 201, r.texte);
		return r.corps;
	};
	before(async () => {
		donnees = dossierTemp("chg-serveur");
		s = await serveurTest(donnees); u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("premier build : pas de changements ; le second les montre dans la page servie", async () => {
		const b1 = await publier(exemple());
		assert.doesNotMatch(b1.resume, /changements/);
		const d = exemple(); item(d, "plantes", "courgette").fields.push(["Exposition", "soleil"]);
		const b2 = await publier(d);
		assert.match(b2.resume, /changements : 1 modifiés, 0 ajoutés, 0 retirés/);
		const p = await appel(u, "/p/jardin/", { cookie: maud });
		assert.deepEqual(donneesPage(p.texte).changements.modifies.map((x: any) => x.id), ["courgette"]);
	});
	test("retours ouverts sur une ref disparue : avertissement ; fait ou refusé : ignoré ; anciennes_refs : plus d'avertissement", async () => {
		for (const extra of [{}, {}, { ref: "basilic", name: "Basilic", anchor: "plantes--basilic" }, { ref: "persil" }, { kind: "general", ref: "onglet-disparu", anchor: "" }]) {
			const r = await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour(extra) });
			assert.equal(r.status, 201, r.texte);
			// Le retour sur le persil est appliqué (réponse d'un mainteneur) : il n'est plus ouvert.
			if ((extra as any).ref === "persil") {
				const j = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } });
				const p = await appel(u, `/api/p/jardin/retours/${r.corps.id}`, { bearer: j.corps.jeton, methode: "PATCH", corps: { champs: { status: "fait", reply: "Retiré.", replied: new Date().toISOString() }, version: r.corps.version } });
				assert.equal(p.status, 200, p.texte);
			}
		}
		const d = exemple();
		const tomate = item(d, "plantes", "tomate"); tomate.id = "tomate-coeur";
		// Les liens vers l'ancienne ancre suivent le renommage (build.js refuse une ancre inconnue).
		for (const t of d.tabs) for (const sc of t.sections) for (const it of sc.items) if (it.links) it.links = it.links.map((l: any) => l[1] === "#plantes--tomate" ? [l[0], "#plantes--tomate-coeur"] : l);
		const sec = d.tabs[0].sections[1]; sec.items = sec.items.filter((i: any) => i.id !== "persil");
		const b = await publier(d);
		const av = b.avertissements.find((x: string) => /absents de ce build/.test(x));
		assert.ok(av, JSON.stringify(b.avertissements));
		assert.match(av, /^3 retours ouverts sur des éléments absents de ce build : plante\/tomate \(2\), general\/onglet-disparu \(1\)\. /);
		assert.doesNotMatch(av, /persil|basilic/);
		const log = fs.readFileSync(path.join(donnees, "projets", "jardin", "builds", String(b.build), "build.log"), "utf8");
		assert.match(log, /attention : 3 retours ouverts/);
		tomate.anciennes_refs = ["tomate"];
		const b2 = await publier(d);
		const av2 = b2.avertissements.find((x: string) => /absents de ce build/.test(x));
		assert.match(av2, /^1 retour ouvert sur des éléments absents de ce build : general\/onglet-disparu \(1\)\./);
		const page = (await appel(u, "/p/jardin/", { cookie: maud })).texte;
		assert.match(page, /data-fb-alias|anciennes_refs/, "les anciennes refs sont dans la page");
	});
});

// Garde : le dépôt de l'outil n'est pas touché par ces tests (git status du site inchangé).
test("aucun fichier écrit dans site/", () => {
	const st = execFileSync("git", ["status", "--porcelain", "--", "site/examples"], { cwd: RACINE_OUTIL, encoding: "utf8" });
	assert.equal(st.trim(), "");
});
