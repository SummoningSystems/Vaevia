// Étape 3.5, CLI : « outil brancher » et « outil importer-artifact --autoriser » (docs/etape3-5-prise-en-main.md § 2.3),
// contre un vrai serveur de test démarré par demarrer() ; l'autorisation est faite par une session de test (le clic
// « Autoriser » de la page). Deux temps sans terminal, attente dans un terminal (simulé), refus (4), expiration et
// délai (1), slow_down respecté (serveur factice), URL construite par la CLI, installation locale, .outil.json d'un
// autre projet, jeton ponctuel en mémoire et révoqué même si l'import échoue. Aucun jeton ni code d'appareil dans
// stdout ou stderr ; jamais de vrai navigateur (OUTIL_TEST_NAVIGATEUR).
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { environnement, lancer, lancerDansTerminal, attendreQue, fichierJetons, fichierAppairages, dossierInstallation, lireJson, urlsOuvertes } from "./aide-cli.ts";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;

describe("CLI outil : brancher (appairage)", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>;
	let maud: string, camille: string, adm: string;
	let n = 0;
	before(async () => {
		tmp = dossierTemp("cli-brancher");
		env = environnement(tmp);
		s = await serveurTest(path.join(tmp, "donnees"), { intervalleAppairageMs: 100 });
		u = s.url;
		await projet(u, "jardin");
		await projet(u, "verger");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		adm = await session(u, "jardin", "adm", "admin", "Adm");
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	// Un dossier « dépôt du code » neuf par test, et un navigateur factice vidé.
	const depot = (contenu?: unknown) => {
		const d = path.join(tmp, `code-${++n}`);
		fs.mkdirSync(d, { recursive: true });
		if (contenu !== undefined) fs.writeFileSync(path.join(d, ".outil.json"), JSON.stringify(contenu));
		fs.rmSync(env.OUTIL_TEST_NAVIGATEUR, { force: true });
		return d;
	};
	const outil = (args: string[], cwd: string, extra?: Record<string, string>) => lancer(env, args, { cwd, env: extra });
	const autoriser = (code: string, cookie: string, corps: unknown) => appel(u, `/api/appairage/${code}/autoriser`, { cookie, corps });
	const appairages = () => lireJson(fichierAppairages(env)) || {};
	const codesAppareil = () => JSON.stringify(appairages()).match(/"code_appareil": ?"([^"]+)"/g)?.map(x => x.replace(/.*"([^"]+)"$/, "$1")) || [];
	// Aucun secret (jeton, code d'appareil) dans une sortie.
	const sansSecret = (r: { stdout: string; stderr: string }, secrets: string[]) => {
		for (const x of secrets) assert.ok(!r.stdout.includes(x) && !r.stderr.includes(x), "un secret apparaît dans la sortie");
		assert.ok(!/wdd_[A-Za-z0-9_-]{16,}/.test(r.stdout + r.stderr), "un jeton apparaît dans la sortie");
	};
	const jetonsActifsPonctuels = () => Number((s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons WHERE revoque IS NULL AND expire IS NOT NULL AND expire <> ''").get() as any).n);
	const revocationsParLuiMeme = () => (s.ctx.base.db.prepare("SELECT detail FROM journal WHERE action = 'jeton révoqué'").all() as any[]).filter(x => /lui-même/.test(x.detail)).length;

	test("deux temps sans terminal : le code et l'URL tout de suite (0), appairages.json ; puis --attendre après le clic : jeton enregistré, .outil.json écrit", async () => {
		const d = depot();
		const r1 = await outil(["brancher", "--serveur", u + "/", "--projet", "jardin", "--poste", "Poste-Test", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr);
		assert.deepEqual(Object.keys(r1.json).sort(), ["code", "etat", "expire", "relance", "url"]);
		assert.equal(r1.json.relance, `outil brancher --attendre --serveur ${u} --projet jardin --poste Poste-Test`);
		assert.equal(r1.json.etat, "attente"); assert.match(r1.json.code, CODE);
		assert.equal(r1.json.url, `${u}/appairage?code=${r1.json.code}`);
		assert.ok(r1.stderr.includes(`Ouvre ${u}/appairage?code=${r1.json.code} et vérifie le code ${r1.json.code}`), r1.stderr);
		assert.ok(r1.stderr.includes("En attente du clic « Autoriser ». Rien d'autre n'est fait. Relance avec --attendre après le clic"), r1.stderr);
		assert.match(r1.stderr, /appairage de ce poste \(« Poste-Test », rôle agent\) avec .*, projet jardin/);
		assert.ok(r1.stderr.indexOf("appairage de ce poste") < r1.stderr.indexOf("Ouvre "), "serveur et projet dits avant tout envoi");
		assert.deepEqual(urlsOuvertes(env), [r1.json.url], "navigateur ouvert sur l'URL construite par la CLI");
		const codes = codesAppareil();
		assert.equal(codes.length, 1, "code d'appareil gardé dans appairages.json");
		assert.ok(fichierAppairages(env).startsWith(path.join(tmp, "maison")));
		if (process.platform !== "win32") assert.equal(fs.statSync(fichierAppairages(env)).mode & 0o077, 0, "mêmes droits que jetons.json");
		assert.ok(!fs.existsSync(path.join(d, ".outil.json")), "pas de .outil.json avant la livraison");
		assert.ok(!lireJson(fichierJetons(env))?.[u]?.jardin, "aucun jeton avant la livraison");
		sansSecret(r1, codes);
		// Relancée avant le clic : le même code, pas de nouvel appairage ni de nouvel onglet.
		const r1b = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--poste", "Poste-Test", "--json"], d);
		assert.equal(r1b.code, 0); assert.equal(r1b.json.code, r1.json.code);
		assert.equal(urlsOuvertes(env).length, 1);
		// Texte lisible : le code et la relance.
		const h = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--poste", "Poste-Test", "--sans-navigateur"], d);
		assert.match(h.stdout, new RegExp(`code ${r1.json.code} : en attente du clic « Autoriser »`)); assert.match(h.stdout, /outil brancher --attendre/);
		// Le clic « Autoriser » (session de Maud, mainteneuse), puis --attendre.
		assert.equal((await autoriser(r1.json.code, maud, { projet: "jardin", role: "agent" })).status, 204);
		const r2 = await outil(["brancher", "--attendre", "--serveur", u, "--projet", "jardin", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr);
		const jetons = lireJson(fichierJetons(env));
		const jeton: string = jetons[u].jardin;
		assert.ok(typeof jeton === "string" && jeton.startsWith("wdd_"), "jeton enregistré");
		sansSecret(r2, [jeton, ...codes]);
		assert.equal(r2.json.etat, "branche"); assert.equal(r2.json.serveur, u); assert.equal(r2.json.projet, "jardin"); assert.equal(r2.json.role, "agent");
		assert.equal(r2.json.nom, "Agent · Poste-Test"); assert.deepEqual(r2.json.pour, { id: "maud", nom: "Maud" });
		assert.equal(r2.json.configuration, path.join(d, ".outil.json")); assert.equal(r2.json.configurationCreee, true); assert.equal(r2.json.fichierJetons, fichierJetons(env));
		assert.deepEqual(lireJson(path.join(d, ".outil.json")), { serveur: u, projet: "jardin" }, ".outil.json sans jeton");
		assert.equal(codesAppareil().length, 0, "appairage retiré à la livraison");
		// Le jeton sert : statut, sans OUTIL_JETON.
		const st = await outil(["statut", "--json"], d);
		assert.equal(st.code, 0, st.stderr); assert.equal(st.json.role, "agent"); assert.match(st.json.nom, /Agent · Poste-Test/);
		// Plus rien à attendre : 1.
		const r3 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r3.code, 1); assert.match(r3.json.erreur.message, /rien à attendre/);
	});

	test("--attendre lancé avant le clic : interroge jusqu'au clic ; refus → 4 ; expiration → 1 ; délai dépassé → 1, appairage gardé", async () => {
		const d = depot({ serveur: u, projet: "jardin" });
		// Attente, clic pendant l'attente.
		const r1 = await outil(["brancher", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr);
		assert.match(r1.stderr, /\(lus dans .*\.outil\.json\)/);
		const attente = outil(["brancher", "--attendre", "--delai", "30", "--json"], d);
		await new Promise(r => setTimeout(r, 600));
		assert.equal((await autoriser(r1.json.code, camille, { projet: "jardin", role: "agent" })).status, 204);
		const r2 = await attente;
		assert.equal(r2.code, 0, r2.stderr); assert.equal(r2.json.pour.id, "camille"); assert.equal(r2.json.configurationCreee, false);
		// Refus : 4, rien d'enregistré, appairage retiré.
		const avant = fs.readFileSync(fichierJetons(env), "utf8");
		const r3 = await outil(["brancher", "--json"], d);
		assert.equal((await appel(u, `/api/appairage/${r3.json.code}/refuser`, { cookie: maud, methode: "POST" })).status, 204);
		const r4 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r4.code, 4, r4.stderr); assert.match(r4.json.erreur.message, /refusé/); assert.equal(r4.json.erreur.etat, "refuse");
		assert.equal(fs.readFileSync(fichierJetons(env), "utf8"), avant, "rien d'enregistré");
		assert.equal(codesAppareil().length, 0);
		// Relancée sans --attendre, l'appairage repris est d'abord interrogé : refusé → 4 ; autorisé → branché.
		const p1 = await outil(["brancher", "--json"], d);
		assert.equal((await appel(u, `/api/appairage/${p1.json.code}/refuser`, { cookie: maud, methode: "POST" })).status, 204);
		const p2 = await outil(["brancher", "--json"], d);
		assert.equal(p2.code, 4, p2.stderr); assert.equal(p2.json.erreur.etat, "refuse");
		const p3 = await outil(["brancher", "--json"], d);
		assert.equal(p3.code, 0); assert.equal(p3.json.etat, "attente"); assert.notEqual(p3.json.code, p1.json.code, "nouvel appairage après le refus");
		assert.equal((await autoriser(p3.json.code, camille, { projet: "jardin", role: "agent" })).status, 204);
		const p4 = await outil(["brancher", "--json"], d);
		assert.equal(p4.code, 0, p4.stderr); assert.equal(p4.json.etat, "branche");
		assert.equal(codesAppareil().length, 0);
		// Expiration côté serveur : 1, appairage retiré.
		const r5 = await outil(["brancher", "--json"], d);
		s.ctx.base.db.prepare("UPDATE appairages SET expire = ? WHERE etat = 'attente'").run(new Date(Date.now() - 1000).toISOString());
		const r6 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r6.code, 1, r6.stderr); assert.match(r6.json.erreur.message, /expiré/);
		assert.equal(codesAppareil().length, 0); assert.ok(r5.json.code);
		// Expiration locale (appairages.json) : 1 sans attendre.
		await outil(["brancher", "--json"], d);
		const a = appairages(); a[u].jardin.permanent.expire = new Date(Date.now() - 1000).toISOString();
		fs.writeFileSync(fichierAppairages(env), JSON.stringify(a));
		const r7 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r7.code, 1); assert.match(r7.json.erreur.message, /expiré/);
		// Délai dépassé sans clic : 1, etat « attente », appairage gardé (on peut relancer --attendre).
		const r8 = await outil(["brancher", "--json"], d);
		const t0 = Date.now();
		const r9 = await outil(["brancher", "--attendre", "--delai", "1", "--json"], d);
		assert.equal(r9.code, 1); assert.equal(r9.json.erreur.etat, "attente"); assert.equal(r9.json.erreur.code, r8.json.code);
		assert.match(r9.json.erreur.message, /toujours en attente .* outil brancher --attendre/);
		assert.ok(Date.now() - t0 < 10000);
		assert.equal(codesAppareil().length, 1, "appairage gardé");
		assert.equal(fs.readFileSync(fichierJetons(env), "utf8").length > 0, true);
		sansSecret({ stdout: r9.stdout + r8.stdout, stderr: r9.stderr + r8.stderr }, codesAppareil());
	});

	test("dans un terminal : une seule commande affiche le code puis attend le clic ; --sans-attendre sort tout de suite ; --sans-navigateur n'ouvre rien", async () => {
		const d = depot();
		const { lu, fin } = lancerDansTerminal(env, ["brancher", "--serveur", u, "--projet", "jardin", "--sans-navigateur", "--json"], d);
		await attendreQue(() => /vérifie le code [A-Z0-9]{4}-[A-Z0-9]{4}/.test(lu.stderr), 10000, "code affiché");
		const code = lu.stderr.match(/vérifie le code ([A-Z0-9]{4}-[A-Z0-9]{4})/)![1];
		assert.match(lu.stderr, /en attente du clic « Autoriser » \(600 s au plus\)/);
		assert.equal(lu.stdout, "", "rien sur stdout avant la fin");
		assert.equal((await autoriser(code, maud, { projet: "jardin", role: "mainteneur" })).status, 204);
		const r = await fin;
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.etat, "branche"); assert.equal(r.json.role, "mainteneur");
		assert.deepEqual(urlsOuvertes(env), [], "--sans-navigateur : rien d'ouvert");
		sansSecret(r, [lireJson(fichierJetons(env))[u].jardin]);
		// --sans-attendre dans un terminal : le code, et la main tout de suite.
		const d2 = depot();
		const sa = lancerDansTerminal(env, ["brancher", "--serveur", u, "--projet", "verger", "--sans-attendre", "--json"], d2);
		const r2 = await sa.fin;
		assert.equal(r2.code, 0); assert.equal(r2.json.etat, "attente");
		assert.deepEqual(urlsOuvertes(env), [r2.json.url]);
		// --attendre et --sans-attendre ensemble : usage.
		assert.equal((await outil(["brancher", "--attendre", "--sans-attendre", "--serveur", u], d2)).code, 2);
	});

	test(".outil.json d'un autre projet : refus avant tout envoi (2) ; projet autorisé différent : rien d'enregistré, jeton reçu révoqué (1)", async () => {
		const d = depot({ serveur: u, projet: "jardin" });
		const r = await outil(["brancher", "--projet", "verger", "--json"], d);
		assert.equal(r.code, 2); assert.match(r.json.erreur.message, /désigne jardin sur .* modifier ce fichier à la main/);
		const autre = await outil(["brancher", "--serveur", "http://127.0.0.1:9", "--json"], d);
		assert.equal(autre.code, 2, "un autre serveur que celui de .outil.json");
		// L'humain autorise « verger » (l'admin peut) alors que .outil.json dit « jardin ».
		const r1 = await outil(["brancher", "--json"], d);
		const avant = lireJson(fichierJetons(env));
		const rev0 = revocationsParLuiMeme();
		assert.equal((await autoriser(r1.json.code, adm, { projet: "verger", role: "agent" })).status, 204);
		const r2 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r2.code, 1, r2.stderr);
		assert.match(r2.json.erreur.message, /désigne jardin sur .* modifier ce fichier à la main/);
		assert.match(r2.json.erreur.message, /Rien n'est enregistré ; le jeton reçu a été révoqué/);
		assert.deepEqual(lireJson(fichierJetons(env)), avant, "rien d'enregistré");
		assert.equal(revocationsParLuiMeme(), rev0 + 1, "jeton reçu révoqué");
		assert.deepEqual(lireJson(path.join(d, ".outil.json")), { serveur: u, projet: "jardin" });
		sansSecret(r2, []);
	});

	test("serveur : options, sinon .outil.json, sinon installation.json de l'installation locale ; sans serveur : usage (2)", async () => {
		const d = depot();
		fs.rmSync(dossierInstallation(env), { recursive: true, force: true });
		const sans = await outil(["brancher", "--json"], d);
		assert.equal(sans.code, 2); assert.match(sans.json.erreur.message, /aucun serveur/); assert.match(sans.json.erreur.message, /installation\.json/);
		fs.mkdirSync(dossierInstallation(env), { recursive: true });
		fs.writeFileSync(path.join(dossierInstallation(env), "installation.json"), JSON.stringify({ outil: "C:/outil", donnees: "C:/donnees", port: 1, url: u }));
		const r = await outil(["brancher", "--json"], d);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.url, `${u}/appairage?code=${r.json.code}`);
		assert.match(r.stderr, /serveur de l'installation locale/); assert.match(r.stderr, /projet choisi dans le navigateur/);
		// Sans projet demandé : celui choisi dans le navigateur est écrit dans .outil.json.
		assert.equal((await autoriser(r.json.code, adm, { projet: "verger", role: "agent" })).status, 204);
		const r2 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr); assert.equal(r2.json.projet, "verger");
		assert.deepEqual(lireJson(path.join(d, ".outil.json")), { serveur: u, projet: "verger" });
		fs.rmSync(dossierInstallation(env), { recursive: true, force: true });
		// Options invalides : usage.
		for (const args of [["--role", "admin"], ["--poste", "<x>"], ["--delai", "0"], ["--projet", "Pas Bon"]]) assert.equal((await outil(["brancher", "--serveur", u, ...args], d)).code, 2, args.join(" "));
	});

	test("serveur factice : slow_down respecté (intervalle allongé), URL construite par la CLI et jamais reprise du serveur, code invalide refusé", async () => {
		const appels: number[] = [];
		let mode: "normal" | "code-faux" = "normal";
		const jetonFactice = "wdd_" + "F".repeat(43);
		const faux = http.createServer((q, r) => {
			let corps = ""; q.on("data", c => corps += c);
			q.on("end", () => {
				const rep = (st: number, o: unknown) => { r.writeHead(st, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
				if (q.url === "/api/appairage" && q.method === "POST")
					return rep(201, { code_appareil: "A".repeat(43), code: mode === "code-faux" ? "abcd\" x" : "ABCD-EFGH", expire: new Date(Date.now() + 600000).toISOString(), intervalle: 0.2, url: "http://malveillant.exemple/" });
				if (q.url === "/api/appairage/jeton") {
					appels.push(Date.now());
					if (appels.length === 1) return rep(429, { code: "slow_down", message: "trop vite" });
					if (appels.length === 2) return rep(202, { etat: "attente" });
					return rep(200, { jeton: jetonFactice, projet: "jardin", role: "agent", nom: "Agent · x", pour: { id: "maud", nom: "Maud" }, usage: "permanent", expire: null });
				}
				rep(404, { code: "not_found", message: "?" });
			});
		});
		await new Promise<void>(ok => faux.listen(0, "127.0.0.1", ok));
		const f = `http://127.0.0.1:${(faux.address() as any).port}`;
		try {
			// Un seul appairage en cours : « outil brancher --attendre » le reprend sans qu'on répète --serveur ni --projet.
			fs.rmSync(fichierAppairages(env), { force: true });
			const d = depot();
			const r1 = await outil(["brancher", "--serveur", f, "--projet", "jardin", "--json"], d);
			assert.equal(r1.code, 0, r1.stderr);
			assert.equal(r1.json.url, `${f}/appairage?code=ABCD-EFGH`);
			assert.deepEqual(urlsOuvertes(env), [`${f}/appairage?code=ABCD-EFGH`], "URL construite par la CLI");
			assert.ok(!r1.stdout.includes("malveillant") && !r1.stderr.includes("malveillant"));
			const t0 = Date.now();
			const r2 = await outil(["brancher", "--attendre", "--json"], d);
			assert.equal(r2.code, 0, r2.stderr);
			assert.equal(appels.length, 3);
			assert.ok(appels[0] - t0 >= 150, "première interrogation après un intervalle");
			assert.ok(appels[1] - appels[0] >= 380, `après slow_down, intervalle allongé (${appels[1] - appels[0]} ms)`);
			assert.ok(appels[2] - appels[1] >= 380, `et gardé (${appels[2] - appels[1]} ms)`);
			assert.equal(lireJson(fichierJetons(env))[f].jardin, jetonFactice);
			sansSecret(r2, [jetonFactice, "A".repeat(43)]);
			// Code mal formé renvoyé par le serveur : refusé, rien d'ouvert.
			mode = "code-faux";
			const d2 = depot();
			const r3 = await outil(["brancher", "--serveur", f, "--projet", "verger", "--json"], d2);
			assert.equal(r3.code, 1); assert.match(r3.json.erreur.message, /code d'appairage reçu du serveur invalide/);
			assert.deepEqual(urlsOuvertes(env), []);
		} finally { await new Promise(ok => faux.close(ok)); }
	});

	test("importer-artifact --autoriser : jeton mainteneur ponctuel en mémoire, import, puis révoqué ; en deux temps ; révoqué même si l'import échoue", async () => {
		const d = depot({ serveur: u, projet: "jardin" });
		const art = path.join(tmp, "artifact-autoriser", "retours");
		fs.mkdirSync(art, { recursive: true });
		const base = { ...docRetour(), status: "fait", reply: "Fait.", replied: "2026-11-10T10:00:00.000Z", by: "u-claude" };
		fs.writeFileSync(path.join(art, "AutoA1.json"), JSON.stringify({ ...base, ref: "auto-a" }));
		fs.writeFileSync(path.join(art, "AutoB2.json"), JSON.stringify({ ...base, ref: "auto-b" }));
		const jetonsAvant = fs.existsSync(fichierJetons(env)) ? fs.readFileSync(fichierJetons(env), "utf8") : "";
		// Dossier absent : 1, aucun appairage demandé.
		const abs = await outil(["importer-artifact", path.join(tmp, "absent"), "--autoriser", "--json"], d);
		assert.equal(abs.code, 1); assert.ok(!appairages()[u]?.jardin?.ponctuel);
		// Premier temps : le code, rien d'importé.
		const r1 = await outil(["importer-artifact", path.dirname(art), "--autoriser", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.etat, "attente"); assert.match(r1.json.code, CODE);
		assert.ok(r1.stderr.includes(`Ouvre ${u}/appairage?code=${r1.json.code} et vérifie le code ${r1.json.code}`));
		assert.match(r1.stderr, /--autoriser --attendre/);
		assert.ok(appairages()[u].jardin.ponctuel, "appairage ponctuel gardé à part");
		const demande = (await appel(u, `/api/appairage/${r1.json.code}`, { cookie: maud })).corps;
		assert.deepEqual([demande.role, demande.usage, demande.projet], ["mainteneur", "ponctuel", "jardin"]);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.filter((x: any) => /^Auto/.test(x.id)).length, 0);
		// Clic d'une mainteneuse, puis --attendre : import, révocation.
		assert.equal((await autoriser(r1.json.code, maud, { projet: "jardin", role: "mainteneur" })).status, 204);
		const rev0 = revocationsParLuiMeme();
		const r2 = await outil(["importer-artifact", path.dirname(art), "--autoriser", "--attendre", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr);
		assert.equal(r2.json.importes.length, 2); assert.equal(r2.json.jetonRevoque, true);
		assert.match(r2.stderr, /jeton ponctuel révoqué/);
		assert.equal(revocationsParLuiMeme(), rev0 + 1); assert.equal(jetonsActifsPonctuels(), 0);
		assert.equal(fs.existsSync(fichierJetons(env)) ? fs.readFileSync(fichierJetons(env), "utf8") : "", jetonsAvant, "jeton jamais écrit");
		sansSecret(r2, codesAppareil());
		// Échec de l'import (une contributrice autorise : jeton agent, import refusé 403) : révoqué quand même.
		const r3 = await outil(["importer-artifact", path.dirname(art), "--autoriser", "--json"], d);
		assert.equal((await autoriser(r3.json.code, camille, { projet: "jardin", role: "agent" })).status, 204);
		const r4 = await outil(["importer-artifact", path.dirname(art), "--autoriser", "--attendre", "--json"], d);
		assert.equal(r4.code, 4, r4.stderr);
		assert.match(r4.json.erreur.message, /rôle agent/); assert.match(r4.json.erreur.message, /jeton ponctuel révoqué/);
		assert.equal(r4.json.erreur.jetonRevoque, true);
		assert.equal(revocationsParLuiMeme(), rev0 + 2); assert.equal(jetonsActifsPonctuels(), 0);
		sansSecret(r4, []);
		// Sans --autoriser, avec un jeton agent : le message de rôle propose --autoriser.
		const agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent import" } })).corps.jeton;
		const r5 = await outil(["importer-artifact", path.dirname(art), "--json"], d, { OUTIL_JETON: agent });
		assert.equal(r5.code, 4); assert.match(r5.json.erreur.message, /relancer avec --autoriser/);
		// --attendre sans --autoriser : usage.
		assert.equal((await outil(["importer-artifact", path.dirname(art), "--attendre"], d)).code, 2);
	});
	// Relecture du lot CLI : jeton livré mais non enregistrable → jamais laissé actif sur le serveur ; relance après un
	// refus ou un mauvais projet : la commande citée est complète ; --attendre préfère l'appairage en cours à
	// installation.json.
	const jetonsAgentActifs = (poste: string) => Number((s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons WHERE revoque IS NULL AND nom = ?").get("Agent · " + poste) as any).n);
	test("jetons.json illisible ou non inscriptible après le clic : sortie 1, aucun jeton laissé actif sur le serveur (jamais créé, ou révoqué)", async () => {
		const f = fichierJetons(env);
		const sauve = fs.existsSync(f) ? fs.readFileSync(f) : null;
		try {
			// 1. Illisible : vu avant d'interroger le serveur, le jeton n'est pas créé.
			const d = depot();
			const r1 = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--poste", "Poste-Illisible", "--json"], d);
			assert.equal(r1.code, 0, r1.stderr);
			assert.equal((await autoriser(r1.json.code, maud, { projet: "jardin", role: "agent" })).status, 204);
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(f, "{ pas du json");
			const r2 = await outil(["brancher", "--attendre", "--serveur", u, "--projet", "jardin", "--json"], d);
			assert.equal(r2.code, 1, r2.stderr); assert.match(r2.json.erreur.message, /illisible/);
			assert.equal(jetonsAgentActifs("Poste-Illisible"), 0, "jeton actif que personne ne tient");
			assert.ok(!fs.existsSync(path.join(d, ".outil.json")), ".outil.json écrit sans jeton enregistré");
			// 2. Écriture impossible (jetons.json.tmp est un dossier) : le jeton reçu est révoqué, et c'est dit.
			fs.writeFileSync(f, "{}");
			fs.mkdirSync(f + ".tmp", { recursive: true });
			const d2 = depot();
			const r3 = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--poste", "Poste-Bloque", "--json"], d2);
			assert.equal((await autoriser(r3.json.code, maud, { projet: "jardin", role: "agent" })).status, 204);
			const r4 = await outil(["brancher", "--attendre", "--serveur", u, "--projet", "jardin", "--json"], d2);
			assert.equal(r4.code, 1, r4.stderr);
			assert.match(r4.json.erreur.message, /le jeton reçu a été révoqué/);
			assert.equal(jetonsAgentActifs("Poste-Bloque"), 0, "jeton reçu non révoqué");
			assert.ok(!fs.existsSync(path.join(d2, ".outil.json")), ".outil.json laissé sans jeton");
			sansSecret(r4, []);
		} finally {
			fs.rmSync(f + ".tmp", { recursive: true, force: true });
			if (sauve) fs.writeFileSync(f, sauve); else fs.rmSync(f, { force: true });
		}
	});

	test(".outil.json lien symbolique pendant (vers un fichier hors du dossier) : brancher et connexion refusent (1) avant tout appairage, rien n'est créé dehors", async () => {
		const d = depot();
		const dehors = path.join(tmp, "dehors-brancher.json");
		try { fs.symlinkSync(dehors, path.join(d, ".outil.json"), "file"); } catch { return; } // liens symboliques interdits sur ce poste
		const a0 = codesAppareil().length;
		const r = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--json"], d);
		assert.equal(r.code, 1, r.stderr); assert.match(r.json.erreur.message, /lien symbolique ou une jonction/);
		assert.equal(codesAppareil().length, a0, "appairage demandé malgré le lien");
		// connexion avec un jeton valable (lu sur l'entrée standard) : refus au moment d'écrire .outil.json.
		const j = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent lien" } })).corps.jeton;
		const avant = JSON.stringify(lireJson(fichierJetons(env)));
		const c = await lancer(env, ["connexion", "--serveur", u, "--projet", "jardin", "--json"], { cwd: d, entree: j + "\n" });
		assert.equal(c.code, 1, c.stderr); assert.match(c.json.erreur.message, /lien symbolique ou une jonction/);
		assert.equal(JSON.stringify(lireJson(fichierJetons(env))), avant, "jeton enregistré malgré le refus");
		sansSecret(c, [j]);
		assert.ok(!fs.existsSync(dehors), "fichier créé hors du dépôt par le lien");
	});

	test("--attendre sans --serveur : l'appairage en cours l'emporte sur installation.json (qui désigne un autre serveur)", async () => {
		fs.mkdirSync(dossierInstallation(env), { recursive: true });
		fs.writeFileSync(path.join(dossierInstallation(env), "installation.json"), JSON.stringify({ outil: "C:/outil", donnees: "C:/donnees", port: 1, url: "http://127.0.0.1:1" }));
		try {
			const d = depot();
			const r1 = await outil(["brancher", "--serveur", u, "--projet", "verger", "--json"], d);
			assert.equal(r1.code, 0, r1.stderr);
			assert.equal((await autoriser(r1.json.code, adm, { projet: "verger", role: "agent" })).status, 204);
			const r2 = await outil(["brancher", "--attendre", "--json"], d);
			assert.equal(r2.code, 0, r2.stderr + r2.stdout);
			assert.equal(r2.json.serveur, u); assert.equal(r2.json.projet, "verger");
		} finally { fs.rmSync(dossierInstallation(env), { recursive: true, force: true }); }
	});

	test("refus, puis projet autorisé différent : la relance citée porte --serveur et --projet, et elle marche", async () => {
		const d = depot();
		const r1 = await outil(["brancher", "--serveur", u, "--projet", "jardin", "--poste", "Poste-Refus", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr);
		assert.match(r1.stderr, new RegExp(`Relance avec --attendre après le clic : outil brancher --attendre --serveur ${u} --projet jardin`));
		assert.equal((await appel(u, `/api/appairage/${r1.json.code}/refuser`, { cookie: maud, methode: "POST" })).status, 204);
		const r2 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r2.code, 4, r2.stderr);
		const relance = `outil brancher --serveur ${u} --projet jardin`;
		assert.ok(r2.json.erreur.message.includes(relance), r2.json.erreur.message);
		const r3 = await outil(relance.split(" ").slice(1).concat("--poste", "Poste-Refus", "--json"), d);
		assert.equal(r3.code, 0, r3.stderr); assert.equal(r3.json.etat, "attente");
		// L'humain choisit « verger » : rien d'enregistré, et la relance citée est complète.
		assert.equal((await autoriser(r3.json.code, adm, { projet: "verger", role: "agent" })).status, 204);
		const r4 = await outil(["brancher", "--attendre", "--json"], d);
		assert.equal(r4.code, 1, r4.stderr);
		assert.ok(r4.json.erreur.message.includes(`choisir jardin (« ${relance}`), r4.json.erreur.message);
	});
});
