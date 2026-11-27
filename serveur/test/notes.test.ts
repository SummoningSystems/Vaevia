// Notes datées par l'API (étape 2, § 2.1) : PUT validé avec les règles de site/build.js (module partagé
// site/valider-notes.js), un commit, 409 sans ?remplacer=1, liste et contenu, droits, noms refusés.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, git, depotDe, nbCommits } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { regles } from "../src/notes.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const { nomNotesValide } = regles(path.join(RACINE, "site"));
const exemple = () => JSON.parse(fs.readFileSync(path.join(RACINE, "site", "examples", "notes_exemple.json"), "utf8"));
// Une petite série valide, jalons volontairement dans un ordre non alphabétique (l'ordre d'affichage).
const serie = (prefixe: string, date = "2026-11-20") => ({
	title: "Retours du " + date, date,
	milestones: { [prefixe + "2"]: "Deuxième", [prefixe + "1"]: "Premier" },
	changes: [{ id: `${prefixe}1-a`, milestone: prefixe + "1", subject: "Sujet", before: "avant", after: "après" }],
	validations: [{ id: `${prefixe}2-b`, milestone: prefixe + "2", text: "À valider ?" }],
});

describe("notes datées (§ 2.1)", () => {
	let s: Serveur, donnees: string, u: string, depot: string, agent: string, adm: string, contrib: string, lecteur: string, mainteneur: string;
	before(async () => {
		donnees = dossierTemp("notes");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		contrib = await session(u, "jardin", "contrib", "contributeur");
		lecteur = await session(u, "jardin", "lect", "lecteur");
		mainteneur = await session(u, "jardin", "maint", "mainteneur", "Mainteneuse");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent notes" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const put = (nom: string, corps: unknown, o: { bearer?: string; cookie?: string; remplacer?: boolean } = { bearer: agent }) =>
		appel(u, `/api/p/jardin/notes/${nom}${o.remplacer ? "?remplacer=1" : ""}`, { methode: "PUT", corps, bearer: o.bearer, cookie: o.cookie });

	test("noms : notes_AAAA-MM-JJ[_suffixe].json, date valide, suffixe en minuscules", () => {
		for (const n of ["notes_2026-11-20.json", "notes_2026-11-20_2.json", "notes_2024-02-29_vague-b.json"]) assert.ok(nomNotesValide(n), n);
		for (const n of ["notes_2026-13-01.json", "notes_2026-02-30.json", "notes_exemple.json", "notes_2026-11-20_A.json", "notes_2026-11-20_.json",
			"Notes_2026-11-20.json", "notes_2026-11-20.JSON", "notes_2026-11-20.json.bak", "../notes_2026-11-20.json", "notes_2026-11-20_a b.json"]) assert.ok(!nomNotesValide(n), n);
	});

	test("PUT par l'agent : 201, un commit à son nom, fichier tel que reçu (ordre des clés gardé, LF)", async () => {
		const avant = nbCommits(depot);
		const n = serie("J");
		const r = await put("notes_2026-11-20.json", n);
		assert.equal(r.status, 201, r.texte);
		assert.equal(r.corps.nom, "notes_2026-11-20.json");
		assert.equal(r.corps.cree, true);
		assert.equal(nbCommits(depot), avant + 1);
		assert.match(git(depot, "log", "-1", "--format=%an|%s"), /^Agent notes \(pour adm\)\|notes : notes_2026-11-20\.json\n$/);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		const brut = fs.readFileSync(path.join(depot, "notes", "notes_2026-11-20.json"), "utf8");
		assert.equal(brut, JSON.stringify(n, null, 2) + "\n");
		assert.deepEqual(Object.keys(JSON.parse(brut).milestones), ["J2", "J1"], "ordre des jalons gardé");
		assert.equal(r.corps.rev, git(depot, "rev-parse", "HEAD").trim());
	});

	test("GET liste et contenu ; 404 sur un nom absent ou une traversée", async () => {
		const l = await appel(u, "/api/p/jardin/notes", { bearer: agent });
		assert.equal(l.status, 200);
		const e = l.corps.notes.find((x: any) => x.nom === "notes_2026-11-20.json");
		assert.equal(e.date, "2026-11-20"); assert.equal(e.titre, "Retours du 2026-11-20"); assert.ok(e.octets > 0);
		assert.deepEqual(e.jalons, ["J2", "J1"], "jalons déjà pris, dans l'ordre du fichier");
		const c = await appel(u, "/api/p/jardin/notes/notes_2026-11-20.json", { cookie: lecteur });
		assert.equal(c.status, 200);
		assert.match(c.entetes.get("content-type") || "", /application\/json/);
		assert.deepEqual(c.corps, serie("J"));
		assert.equal((await appel(u, "/api/p/jardin/notes/notes_2001-01-01.json", { bearer: agent })).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/notes/..%2Fsite.json", { bearer: agent })).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/notes/.gitkeep", { bearer: agent })).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/notes")).status, 401);
	});

	test("409 si le fichier existe sans ?remplacer=1 ; remplacement : un commit ; contenu identique : aucun commit", async () => {
		const avant = nbCommits(depot);
		const n2 = { ...serie("J"), intro: "Corrigée." };
		const r = await put("notes_2026-11-20.json", n2);
		assert.equal(r.status, 409); assert.equal(r.corps.code, "conflict");
		assert.equal(nbCommits(depot), avant);
		const r2 = await put("notes_2026-11-20.json", n2, { bearer: agent, remplacer: true });
		assert.equal(r2.status, 200, r2.texte);
		assert.equal(r2.corps.cree, false);
		assert.equal(nbCommits(depot), avant + 1);
		assert.match(git(depot, "log", "-1", "--format=%s"), /\(remplacement\)/);
		const r3 = await put("notes_2026-11-20.json", n2, { bearer: agent, remplacer: true });
		assert.equal(r3.status, 200); assert.equal(r3.corps.inchange, true);
		assert.equal(nbCommits(depot), avant + 1);
		// Remplacer un fichier absent le crée.
		const r4 = await put("notes_2026-11-20_b.json", serie("K"), { bearer: agent, remplacer: true });
		assert.equal(r4.status, 201, r4.texte);
	});

	test("règles de build.js sur l'ensemble des fichiers : id en double, ancre en double, jalon non déclaré, champs ; rien d'écrit", async () => {
		const avant = nbCommits(depot);
		const cas: [unknown, RegExp][] = [
			[serie("J", "2026-11-21"), /identifiant en double dans « changes » : J1-a/],
			[{ ...serie("L"), changes: [{ id: "j1 a", milestone: "L1", subject: "s" }] }, /même ancre #nouveautes--j1-a/],
			[{ ...serie("M"), changes: [{ id: "M1-x", milestone: "M9", subject: "s" }] }, /jalon inconnu « M9 »/],
			[{ ...serie("N"), title: "" }, /title manquant/],
			[{ ...serie("P"), measures: [{ id: "mesure-p", label: "x", steps: [{ when: "avant" }] }] }, /étape incomplète/],
			[{ ...serie("Q"), validations: "non" }, /« validations » doit être une liste/],
		];
		for (const [corps, motif] of cas) {
			const r = await put("notes_2026-11-21.json", corps);
			assert.equal(r.status, 400, JSON.stringify(corps));
			assert.equal(r.corps.code, "invalid_document");
			assert.match(r.corps.message, motif);
			assert.ok(Array.isArray(r.corps.erreurs) && r.corps.erreurs.length);
		}
		assert.equal((await put("notes_2026-11-21.json", [1, 2])).status, 400, "liste au lieu d'un objet");
		assert.equal(nbCommits(depot), avant);
		assert.ok(!fs.existsSync(path.join(depot, "notes", "notes_2026-11-21.json")));
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		// Un remplacement ne se compare pas à lui-même : remplacer J par une version qui garde les mêmes ids passe.
		assert.equal((await put("notes_2026-11-20.json", { ...serie("J"), intro: "v3" }, { bearer: agent, remplacer: true })).status, 200);
	});

	test("noms refusés (400) et route sans nom", async () => {
		for (const nom of ["notes_exemple.json", "notes_2026-02-30.json", "notes_2026-11-20_B.json", "autre.json", "notes_2026-11-20.txt"]) {
			const r = await put(encodeURIComponent(nom), serie("Z"));
			assert.equal(r.status, 400, nom);
		}
		assert.equal((await put("..%2F..%2Fsite.json", serie("Z"))).status, 400);
		assert.ok(!fs.readdirSync(path.join(depot, "notes")).some(f => /exemple|B\.json|autre/.test(f)));
	});

	test("droits : agent, mainteneur, admin écrivent ; contributeur et lecteur non ; anti-CSRF par cookie", async () => {
		assert.equal((await put("notes_2026-11-22.json", serie("C"), { cookie: contrib })).status, 403);
		assert.equal((await put("notes_2026-11-22.json", serie("C"), { cookie: lecteur })).status, 403);
		const sansXwdd = await appel(u, "/api/p/jardin/notes/notes_2026-11-22.json", { methode: "PUT", corps: serie("C"), cookie: mainteneur, xwdd: false });
		assert.equal(sansXwdd.status, 403);
		const m = await put("notes_2026-11-22.json", serie("C"), { cookie: mainteneur });
		assert.equal(m.status, 201, m.texte);
		assert.match(git(depot, "log", "-1", "--format=%an"), /Mainteneuse/);
		assert.equal((await put("notes_2026-11-23.json", serie("D"), { cookie: adm })).status, 201);
		const brut = await appel(u, "/api/p/jardin/notes/notes_2026-11-24.json", { methode: "PUT", brut: JSON.stringify(serie("E")), bearer: agent, entetes: { "Content-Type": "text/plain" } });
		assert.equal(brut.status, 400, "Content-Type application/json exigé");
	});

	test("le build lit les notes écrites par l'API (même règles : une note acceptée passe build.js)", async () => {
		// Les notes de l'exemple, sous un nom daté, puis le build de l'exemple.
		const r = await put("notes_2026-11-12.json", exemple());
		assert.equal(r.status, 201, r.texte);
		const data = fs.readFileSync(path.join(RACINE, "site", "examples", "data.json"));
		const b = await appel(u, "/api/p/jardin/builds", { brut: data, bearer: agent, entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		const page = fs.readFileSync(path.join(donnees, "projets", "jardin", "builds", String(b.corps.build), "page.html"), "utf8");
		assert.ok(page.includes("V1-chaleur") && page.includes("J1-a"), "notes de l'exemple et de l'API dans la page");
		const info = await appel(u, "/api/p/jardin/builds", { bearer: agent });
		assert.equal(info.status, 200);
		assert.equal(info.corps.dernier.build, b.corps.build);
		assert.ok(info.corps.dernier.octets > 0 && !Number.isNaN(Date.parse(info.corps.dernier.date)));
		assert.equal(info.corps.page, `${u}/p/jardin/`);
	});
});
