// Jetons à rôle (étape 2, § 2.2) et import depuis un artefact claude.ai (§ 2.3) : ids gardés, collision, id invalide,
// ré-import idempotent, un seul commit, refus avec raison, 500 au plus, droits.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { Base } from "../src/base.ts";
import { idDerive } from "../src/import.ts";

// Document tel que l'écrit ArtifactData (out_dir) : les 15 champs, sans version.
const docArtifact = (extra: Record<string, unknown> = {}) => docRetour({ by: "u-claude-1", status: "fait", reply: "Fait.", replied: "2026-11-10T10:00:00.000Z",
	created: "2026-11-09T08:00:00.000Z", updated: "2026-11-10T10:00:00.000Z", ...extra });

describe("jetons à rôle (§ 2.2)", () => {
	let s: Serveur, donnees: string, u: string, adm: string, contrib: string;
	before(async () => {
		donnees = dossierTemp("jetons");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		contrib = await session(u, "jardin", "contrib", "contributeur");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const jeton = (corps: Record<string, unknown>) => appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", ...corps } });

	test("role : agent par défaut, mainteneur sur demande, toute autre valeur refusée", async () => {
		const a = await jeton({ nom: "Agent" });
		assert.equal(a.status, 201); assert.equal(a.corps.role, "agent");
		const m = await jeton({ nom: "Import", role: "mainteneur" });
		assert.equal(m.status, 201); assert.equal(m.corps.role, "mainteneur");
		for (const role of ["admin", "contributeur", "lecteur", "", 3, null]) assert.equal((await jeton({ nom: "X", role })).status, 400, String(role));
		const sa = await appel(u, "/api/p/jardin/session", { bearer: a.corps.jeton });
		assert.deepEqual([sa.corps.role, sa.corps.proprietaire, sa.corps.ecriture], ["agent", false, false]);
		const sm = await appel(u, "/api/p/jardin/session", { bearer: m.corps.jeton });
		assert.deepEqual([sm.corps.role, sm.corps.proprietaire, sm.corps.ecriture], ["mainteneur", true, true]);
		assert.equal(sm.corps.id, "agent:" + m.corps.id);
	});

	test("jeton mainteneur : droits du mainteneur (créer, supprimer tout retour), pas ceux de l'agent (reply)", async () => {
		const m = (await jeton({ nom: "Mainteneur", role: "mainteneur" })).corps;
		const a = (await jeton({ nom: "Agent2" })).corps;
		const c = await appel(u, "/api/p/jardin/retours", { cookie: contrib, corps: docRetour() });
		assert.equal(c.status, 201);
		const rep = await appel(u, `/api/p/jardin/retours/${c.corps.id}`, { methode: "PATCH", bearer: m.jeton, corps: { champs: { status: "fait", reply: "ok" }, version: 1 } });
		assert.equal(rep.status, 403, "un mainteneur ne répond pas à la place de l'agent");
		const cree = await appel(u, "/api/p/jardin/retours", { bearer: m.jeton, corps: docRetour() });
		assert.equal(cree.status, 201, cree.texte);
		const doc = (await appel(u, "/api/p/jardin/retours", { bearer: m.jeton })).corps.docs.find((d: any) => d.id === cree.corps.id);
		assert.equal(doc.donnees.by, "agent:" + m.id);
		assert.equal((await appel(u, `/api/p/jardin/retours/${c.corps.id}?version=1`, { methode: "DELETE", bearer: m.jeton })).status, 204);
		// L'agent ne crée ni ne supprime, comme à l'étape 1.
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: a.jeton, corps: docRetour() })).status, 403);
		// Build permis aux deux.
		const data = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "site", "examples", "data.json"));
		assert.equal((await appel(u, "/api/p/jardin/builds", { bearer: m.jeton, brut: data, entetes: { "Content-Type": "application/json" } })).status, 201);
	});

	test("base de l'étape 1 (sans colonne role) : colonne ajoutée, jetons existants « agent »", () => {
		const dir = dossierTemp("base-ancienne");
		try {
			const db = new DatabaseSync(path.join(dir, "outil.sqlite"));
			db.exec(`CREATE TABLE projets (id TEXT PRIMARY KEY, titre TEXT NOT NULL, cree TEXT NOT NULL);
				CREATE TABLE jetons (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, projet TEXT NOT NULL REFERENCES projets(id), nom TEXT NOT NULL, cree TEXT NOT NULL, revoque TEXT);
				INSERT INTO projets VALUES ('jardin', 'Jardin', '2026-11-01T00:00:00Z');`);
			db.prepare("INSERT INTO jetons (id, hash, projet, nom, cree) VALUES ('ancien', ?, 'jardin', 'Ancien', '2026-11-01T00:00:00Z')").run(
				"0".repeat(64));
			db.close();
			const b = new Base(dir);
			const cols = (b.db.prepare("PRAGMA table_info(jetons)").all() as { name: string }[]).map(c => c.name);
			assert.ok(cols.includes("role"));
			assert.equal((b.db.prepare("SELECT role FROM jetons WHERE id = 'ancien'").get() as { role: string }).role, "agent");
			const j = b.creerJeton("jardin", "Neuf", "mainteneur");
			assert.equal(b.jeton(j.jeton)?.role, "mainteneur");
			b.fermer();
			new Base(dir).fermer(); // deuxième ouverture : rien à migrer
		} finally { nettoyer(dir); }
	});
});

describe("import depuis claude.ai (§ 2.3)", () => {
	let s: Serveur, donnees: string, u: string, depot: string, adm: string, contrib: string, lecteur: string, mainteneur: string, agent: string, jetonM: string;
	before(async () => {
		donnees = dossierTemp("import");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		contrib = await session(u, "jardin", "contrib", "contributeur");
		lecteur = await session(u, "jardin", "lect", "lecteur");
		mainteneur = await session(u, "jardin", "maint", "mainteneur");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent" } })).corps.jeton;
		jetonM = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Import claude.ai", role: "mainteneur" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const importer = (retours: unknown, qui: { bearer?: string; cookie?: string } = { bearer: jetonM }) => appel(u, "/api/p/jardin/import", { corps: { retours }, ...qui });
	const docs = async () => (await appel(u, "/api/p/jardin/retours", { bearer: agent })).corps.docs as any[];

	test("ids gardés, by → import:<by>, version 1, champs gardés, un seul commit", async () => {
		const avant = nbCommits(depot);
		const lot = [
			{ id: "AbCdEf123", donnees: docArtifact({ ref: "tomate" }) },
			{ id: "GhIjKl456", donnees: docArtifact({ ref: "courge", status: "question", reply: "Laquelle ?", by: "" }) },
			{ id: "MnOpQr789", donnees: docArtifact({ ref: "salade", status: "nouveau", reply: "", replied: "" }) },
		];
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte);
		assert.deepEqual(r.corps.importes, lot.map(x => ({ origine: x.id, id: x.id })));
		assert.deepEqual([r.corps.ignores, r.corps.refuses], [[], []]);
		assert.equal(nbCommits(depot), avant + 1);
		assert.equal(git(depot, "log", "-1", "--format=%an|%s").trim(), "Import claude.ai (pour adm)|import depuis claude.ai : 3 retours");
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		const d = (await docs()).find(x => x.id === "AbCdEf123");
		assert.equal(d.version, 1);
		assert.deepEqual(d.donnees, { ...lot[0].donnees, by: "import:u-claude-1" });
		assert.equal((await docs()).find(x => x.id === "GhIjKl456").donnees.by, "import:");
		const f = JSON.parse(fs.readFileSync(path.join(depot, "retours", "AbCdEf123.json"), "utf8"));
		assert.equal(f.version, 1); assert.equal(f.status, "fait"); assert.equal(f.reply, "Fait.");
	});

	test("collision (id pris par un autre retour, à la casse près compris) et id invalide : nouvel id dérivé, correspondance renvoyée", async () => {
		const lot = [
			{ id: "AbCdEf123", donnees: docArtifact({ ref: "autre", created: "2026-11-11T08:00:00.000Z" }) },  // même id, autre created
			{ id: "abcdef123", donnees: docArtifact({ ref: "casse", created: "2026-11-11T09:00:00.000Z" }) },  // homonyme à la casse près
			{ id: "doc-avec-tirets_1", donnees: docArtifact({ ref: "tirets" }) },                                // id invalide
			{ id: "Double", donnees: docArtifact({ ref: "double-1", created: "2026-11-12T08:00:00.000Z" }) },
			{ id: "Double", donnees: docArtifact({ ref: "double-2", created: "2026-11-12T09:00:00.000Z" }) }, // même id dans l'appel
		];
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte);
		const ids = r.corps.importes.map((x: any) => x.id);
		assert.equal(ids.length, 5);
		assert.equal(new Set(ids.map((x: string) => x.toLowerCase())).size, 5, "aucun homonyme");
		assert.equal(r.corps.importes[0].id, idDerive("AbCdEf123", "2026-11-11T08:00:00.000Z"));
		assert.equal(r.corps.importes[1].id, idDerive("abcdef123", "2026-11-11T09:00:00.000Z"));
		assert.equal(r.corps.importes[2].id, idDerive("doc-avec-tirets_1", "2026-11-09T08:00:00.000Z"));
		assert.equal(r.corps.importes[3].id, "Double");
		assert.equal(r.corps.importes[4].id, idDerive("Double", "2026-11-12T09:00:00.000Z"));
		for (const x of r.corps.importes) assert.match(x.id, /^[A-Za-z0-9]{1,40}$/);
		const tous = await docs();
		assert.equal(tous.find(x => x.id === "AbCdEf123").donnees.ref, "tomate", "le retour déjà présent n'est pas touché");
		assert.equal(tous.find(x => x.id === r.corps.importes[2].id).donnees.ref, "tirets");
	});

	test("id d'origine = nom réservé de Windows (CON, aux, nul, COM1, lpt9) : id dérivé, les autres entrées importées, ré-import stable", async () => {
		const reserves = ["CON", "aux", "nul", "COM1", "lpt9"];
		const lot = [...reserves.map((id, i) => ({ id, donnees: docArtifact({ ref: "reserve-" + i, created: `2026-11-14T08:00:0${i}.000Z` }) })),
			{ id: "BonVoisin1", donnees: docArtifact({ ref: "voisin", created: "2026-11-14T09:00:00.000Z" }) }];
		const avant = nbCommits(depot);
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte);
		assert.equal(r.corps.importes.length, 6); assert.deepEqual(r.corps.refuses, []);
		reserves.forEach((id, i) => assert.equal(r.corps.importes[i].id, idDerive(id, `2026-11-14T08:00:0${i}.000Z`), id));
		assert.deepEqual(r.corps.importes[5], { origine: "BonVoisin1", id: "BonVoisin1" });
		assert.equal(nbCommits(depot), avant + 1);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		const r2 = await importer(lot);
		assert.deepEqual([r2.status, r2.corps.importes.length, r2.corps.ignores.length, nbCommits(depot)], [200, 0, 6, avant + 1]);
	});

	test("by d'origine long : « import:<by> » reste dans la limite d'un champ court (1000)", async () => {
		const r = await importer([{ id: "LongBy1", donnees: docArtifact({ ref: "long-by", by: "x".repeat(1000), created: "2026-11-15T08:00:00.000Z" }) }]);
		assert.equal(r.status, 200, r.texte); assert.equal(r.corps.importes.length, 1);
		const f = JSON.parse(fs.readFileSync(path.join(depot, "retours", "LongBy1.json"), "utf8"));
		assert.equal(f.by.length, 1000); assert.ok(f.by.startsWith("import:xxx"));
	});

	test("ré-import du même dossier : tout ignoré (renommés compris), aucun commit", async () => {
		const avant = nbCommits(depot), n = (await docs()).length;
		const lot = [
			{ id: "AbCdEf123", donnees: docArtifact({ ref: "tomate" }) },
			{ id: "GhIjKl456", donnees: docArtifact({ ref: "courge", status: "question", reply: "Laquelle ?", by: "" }) },
			{ id: "AbCdEf123", donnees: docArtifact({ ref: "autre", created: "2026-11-11T08:00:00.000Z" }) },
			{ id: "abcdef123", donnees: docArtifact({ ref: "casse", created: "2026-11-11T09:00:00.000Z" }) },
			{ id: "doc-avec-tirets_1", donnees: docArtifact({ ref: "tirets" }) },
			{ id: "Double", donnees: docArtifact({ ref: "double-2", created: "2026-11-12T09:00:00.000Z" }) },
		];
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte);
		assert.deepEqual(r.corps.importes, []);
		assert.equal(r.corps.ignores.length, 6);
		assert.equal(nbCommits(depot), avant);
		assert.equal((await docs()).length, n);
		// Un retour modifié depuis l'import (statut, réponse) reste reconnu : seul « created » compte.
		const v = (await docs()).find(x => x.id === "MnOpQr789").version;
		assert.equal((await appel(u, "/api/p/jardin/retours/batch", { bearer: agent, corps: { ecritures: [{ id: "MnOpQr789", version: v, champs: { status: "pris" } }] } })).status, 200);
		const r2 = await importer([{ id: "MnOpQr789", donnees: docArtifact({ ref: "salade", status: "nouveau", reply: "", replied: "" }) }]);
		assert.deepEqual([r2.corps.importes.length, r2.corps.ignores], [0, ["MnOpQr789"]]);
	});

	test("entrées refusées avec leur raison, les autres importées", async () => {
		const sans = docArtifact({ ref: "sans-codex" }); delete (sans as any).codex;
		const lot = [
			{ id: "Bon1", donnees: docArtifact({ ref: "bon", created: "2026-11-13T08:00:00.000Z" }) },
			{ id: "Manque", donnees: sans },
			{ id: "Inconnu", donnees: { ...docArtifact(), version: 3 } },
			{ id: "Statut", donnees: docArtifact({ status: "termine" }) },
			{ id: "Date", donnees: docArtifact({ created: "hier" }) },
			{ id: "Vide", donnees: docArtifact({ ref: "" }) },
			{ id: "Long", donnees: docArtifact({ text: "x".repeat(20001) }) },
			{ id: "Nombre", donnees: docArtifact({ cat: 3 }) },
			{ id: 42, donnees: docArtifact() },
			"pas un objet",
			{ id: "Cle", donnees: docArtifact(), version: 2 },
		];
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte);
		assert.deepEqual(r.corps.importes, [{ origine: "Bon1", id: "Bon1" }]);
		assert.equal(r.corps.refuses.length, 10);
		const raison = (i: number) => r.corps.refuses.find((x: any) => x.index === i).raison;
		assert.match(raison(1), /champs manquants : codex/);
		assert.match(raison(2), /champ inconnu : version/);
		assert.match(raison(3), /status inconnu/);
		assert.match(raison(4), /created : date ISO/);
		assert.match(raison(5), /kind et ref/);
		assert.match(raison(6), /20000 au plus/);
		assert.match(raison(7), /texte attendu/);
		assert.match(raison(8), /id d'origine/);
		assert.equal(r.corps.refuses.find((x: any) => x.index === 10).origine, "Cle");
		// Tout refusé : aucun commit.
		const avant = nbCommits(depot);
		const r2 = await importer([{ id: "X", donnees: {} }]);
		assert.deepEqual([r2.status, r2.corps.importes.length, r2.corps.refuses.length, nbCommits(depot)], [200, 0, 1, avant]);
	});

	test("corps : 500 au plus, liste non vide, clés connues", async () => {
		assert.equal((await importer([])).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/import", { bearer: jetonM, corps: { retours: [], autre: 1 } })).status, 400);
		const trop = Array.from({ length: 501 }, (_, i) => ({ id: "T" + i, donnees: docArtifact() }));
		const r = await importer(trop);
		assert.equal(r.status, 400); assert.match(r.corps.message, /500 au plus/);
	});

	test("500 retours aux textes longs (plus de 1 Mio) : un seul commit", async () => {
		const avant = nbCommits(depot), n = (await docs()).length;
		const lot = Array.from({ length: 500 }, (_, i) => ({ id: "Lot" + String(i).padStart(3, "0") + "x".repeat(30),
			donnees: docArtifact({ ref: "r" + i, text: "é".repeat(3000), created: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }) }));
		const r = await importer(lot);
		assert.equal(r.status, 200, r.texte.slice(0, 300));
		assert.equal(r.corps.importes.length, 500);
		assert.equal(nbCommits(depot), avant + 1);
		assert.equal(git(depot, "log", "-1", "--format=%s").trim(), "import depuis claude.ai : 500 retours");
		assert.equal((await docs()).length, n + 500);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
	});

	test("droits : mainteneur (session ou jeton) et admin ; agent, contributeur, lecteur refusés ; 401 sans identité", async () => {
		const un = (ref: string) => [{ id: "Droit" + ref, donnees: docArtifact({ ref, created: "2026-11-14T08:00:00.000Z" }) }];
		assert.equal((await importer(un("a"), { bearer: agent })).status, 403);
		assert.equal((await importer(un("a"), { cookie: contrib })).status, 403);
		assert.equal((await importer(un("a"), { cookie: lecteur })).status, 403);
		assert.equal((await importer(un("a"), {})).status, 401);
		assert.equal((await importer(un("m"), { cookie: mainteneur })).status, 200);
		assert.equal((await importer(un("adm"), { cookie: adm })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/import", { corps: { retours: un("x") }, cookie: mainteneur, xwdd: false })).status, 403, "anti-CSRF");
	});
});
