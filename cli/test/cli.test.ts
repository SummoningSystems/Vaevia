// Tests de la CLI « outil » (docs/etape2-cli-methode.md § 1) : un vrai serveur de test (comme serveur/test/), la CLI
// lancée en sous-processus avec un HOME / APPDATA temporaire (fichier de jetons), un dossier de « dépôt du code » avec
// .outil.json. Configuration et refus d'un jeton dans .outil.json, codes de sortie, lot tout ou rien, 409 → 3, heure
// posée par la CLI, --json valide, notes, export, import ; retours liste sans --dossier : <travail>/retours.
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const OUTIL = path.join(RACINE, "cli", "outil.ts");
const EXEMPLES = path.join(RACINE, "site", "examples");
// Nombre de commandes de l'aide : 18 à l'étape 3, 21 avec brancher, publier et methode (étape 3.5), 24 avec apercu (étape 3.6), 25 avec capture (étape 3.7), 27 avec exporteur et mcp (étape 3.9), 28 avec executable (étape 3.10).
const NB_COMMANDES = 28;

type Resultat = { code: number; stdout: string; stderr: string; json: any };

describe("CLI outil", () => {
	let s: Serveur, tmp: string, donnees: string, u: string, depot: string, maison: string, code: string;
	let adm: string, contrib: string, agent: string, mainteneur: string;
	// Environnement explicite : aucun OUTIL_JETON hérité, APPDATA / HOME / XDG dans le dossier temporaire.
	let env: Record<string, string>;

	before(async () => {
		tmp = dossierTemp("cli");
		donnees = path.join(tmp, "donnees");
		maison = path.join(tmp, "maison");
		code = path.join(tmp, "code");
		for (const d of [maison, code]) fs.mkdirSync(d, { recursive: true });
		env = {
			PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TEMP: tmp, TMP: tmp,
			APPDATA: path.join(maison, "AppData", "Roaming"), HOME: maison, USERPROFILE: maison, XDG_CONFIG_HOME: path.join(maison, ".config"),
		};
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		await projet(u, "autre");
		depot = depotDe(donnees, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		contrib = await session(u, "jardin", "contrib", "contributeur");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent CLI" } })).corps.jeton;
		mainteneur = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Mainteneur CLI", role: "mainteneur" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	// Lance la CLI (asynchrone : le serveur tourne dans ce processus). Avec --json, stdout doit être du JSON valide.
	function outil(args: string[], o: { cwd?: string; entree?: string; env?: Record<string, string> } = {}): Promise<Resultat> {
		return new Promise((ok, ko) => {
			const p = spawn(process.execPath, [OUTIL, ...args], { cwd: o.cwd || code, env: { ...env, ...(o.env || {}) }, windowsHide: true });
			let stdout = "", stderr = "";
			p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
			p.stdout.on("data", c => stdout += c); p.stderr.on("data", c => stderr += c);
			p.on("error", ko);
			p.on("close", c => {
				let json: any = null;
				if (args.includes("--json")) {
					try { json = JSON.parse(stdout); } catch { return ko(new Error(`--json : stdout n'est pas du JSON (code ${c}) :\n${stdout}\n${stderr}`)); }
				}
				ok({ code: c ?? -1, stdout, stderr, json });
			});
			p.stdin.end(o.entree ?? "");
		});
	}
	const configurer = (dossier = code, contenu: unknown = { serveur: u, projet: "jardin" }) =>
		fs.writeFileSync(path.join(dossier, ".outil.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
	const avecAgent = { env: { OUTIL_JETON: "" } };
	const nouveau = async (extra: Record<string, unknown> = {}) => (await appel(u, "/api/p/jardin/retours", { cookie: contrib, corps: docRetour(extra) })).corps.id as string;
	const doc = async (id: string) => (await appel(u, "/api/p/jardin/retours", { bearer: agent })).corps.docs.find((d: any) => d.id === id);
	const ecrireJson = (nom: string, o: unknown) => { const p = path.join(tmp, nom); fs.writeFileSync(p, JSON.stringify(o, null, 2)); return p; };

	test("aide : toutes les commandes, un exemple chacune ; aide d'une commande ; --json", async () => {
		const r = await outil(["aide"]);
		assert.equal(r.code, 0);
		for (const c of ["connexion", "statut", "retours liste", "retours voir", "retours repondre", "export envoyer", "notes envoyer", "notes liste", "notes voir", "importer-artifact",
			"tickets liste", "tickets voir", "tickets creer", "tickets prendre", "tickets rendre", "tickets revue", "tickets commit", "tickets critere"])
			assert.ok(r.stdout.includes("outil " + c), c);
		// La phrase de départ d'un branchement (étape 3.5, 8.4), mot pour mot.
		assert.ok(r.stdout.includes("« Branche ce dépôt sur le serveur de retours <URL> (projet <P>) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : <URL>/outil). »"), "phrase de départ dans l'aide");
		const j = await outil(["aide", "--json"]);
		assert.equal(j.json.commandes.length, NB_COMMANDES);
		for (const c of j.json.commandes) assert.match(c.exemple, /^outil /, c.commande);
		assert.deepEqual(j.json.codes, { ok: 0, erreur: 1, usage: 2, conflit: 3, droits: 4 });
		const un = await outil(["aide", "retours", "repondre"]);
		assert.equal(un.code, 0); assert.match(un.stdout, /exemple : outil retours repondre --lot/);
		assert.equal((await outil(["retours", "liste", "--aide"])).code, 0);
		const groupe = await outil(["aide", "notes", "--json"]);
		assert.deepEqual(groupe.json.commandes.map((c: any) => c.commande), ["notes envoyer", "notes liste", "notes voir"]);
	});

	test("codes d'usage (2) : commande ou option inconnue, argument manquant ou en trop, valeur invalide", async () => {
		for (const args of [["inconnue"], ["retours"], ["retours", "liste", "--bidon"], ["retours", "voir"], ["retours", "voir", "a", "b"],
			["retours", "liste", "--statut", "termine"], ["retours", "repondre", "X1", "--statut", "fait", "--texte", "t"], ["retours", "repondre", "--lot", "a.json", "--statut", "fait"],
			["notes", "envoyer", "mauvais-nom.json"], ["aide", "inexistante"], ["connexion", "--serveur", "ftp://x", "--projet", "p"]]) {
			const r = await outil([...args, "--json"]);
			assert.equal(r.code, 2, args.join(" ") + " : " + r.stderr);
			assert.equal(r.json.erreur.sortie, 2);
			assert.ok(r.stderr.startsWith("erreur : "));
		}
	});

	test("connexion : .outil.json écrit sans jeton, jeton lu sur l'entrée standard et rangé dans APPDATA/HOME temporaire", async () => {
		const dossier = path.join(tmp, "code-connexion");
		fs.mkdirSync(dossier);
		// Sans .outil.json ni options : usage.
		assert.equal((await outil(["connexion"], { cwd: dossier })).code, 2);
		// Jeton refusé par le serveur : 4, rien d'écrit.
		const faux = await outil(["connexion", "--serveur", u + "/", "--projet", "jardin", "--json"], { cwd: dossier, entree: "wdd_faux\n" });
		assert.equal(faux.code, 4); assert.equal(faux.json.erreur.statut, 401);
		assert.ok(!fs.existsSync(path.join(dossier, ".outil.json")));
		// Entrée vide : 1.
		assert.equal((await outil(["connexion", "--serveur", u, "--projet", "jardin"], { cwd: dossier, entree: "" })).code, 1);
		// Bon jeton, avec BOM et CRLF (redirection d'un fichier écrit sous Windows).
		const r = await outil(["connexion", "--serveur", u + "/", "--projet", "jardin", "--json"], { cwd: dossier, entree: "\uFEFF" + agent + "\r\n" });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.role, "agent"); assert.equal(r.json.configurationCreee, true);
		const cfg = JSON.parse(fs.readFileSync(path.join(dossier, ".outil.json"), "utf8"));
		assert.deepEqual(cfg, { serveur: u, projet: "jardin" }, "serveur normalisé, aucun jeton");
		const attendu = process.platform === "win32" ? path.join(env.APPDATA, "outil", "jetons.json") : path.join(env.XDG_CONFIG_HOME, "outil", "jetons.json");
		assert.equal(r.json.fichierJetons, attendu);
		assert.ok(r.json.fichierJetons.startsWith(maison), "fichier de jetons dans le dossier temporaire");
		assert.deepEqual(JSON.parse(fs.readFileSync(attendu, "utf8")), { [u]: { jardin: agent } });
		if (process.platform !== "win32") assert.equal(fs.statSync(attendu).mode & 0o077, 0, "droits restreints");
		assert.ok(!r.stdout.includes(agent) && !r.stderr.includes(agent), "le jeton n'est jamais affiché");
		// Ensuite, sans OUTIL_JETON : le fichier sert.
		const st = await outil(["statut", "--json"], { cwd: dossier });
		assert.equal(st.code, 0, st.stderr); assert.equal(st.json.role, "agent");
		// Un .outil.json qui désigne un autre projet : usage (pas de réécriture silencieuse).
		assert.equal((await outil(["connexion", "--projet", "autre"], { cwd: dossier, entree: agent })).code, 2);
		// Relancée sans options : reprend .outil.json, ne le réécrit pas.
		const again = await outil(["connexion", "--json"], { cwd: dossier, entree: agent });
		assert.equal(again.code, 0); assert.equal(again.json.configurationCreee, false);
	});

	test("configuration : cherchée dans les parents ; jeton dans .outil.json refusé ; OUTIL_JETON prioritaire ; sans jeton → 4", async () => {
		configurer();
		const sous = path.join(code, "src", "profond");
		fs.mkdirSync(sous, { recursive: true });
		const r = await outil(["statut", "--json"], { cwd: sous, env: { OUTIL_JETON: mainteneur } });
		assert.equal(r.code, 0, r.stderr); assert.equal(r.json.role, "mainteneur", "OUTIL_JETON l'emporte sur le fichier");
		// Sans jeton pour ce serveur et ce projet : 4.
		const dossierAutre = path.join(tmp, "code-autre"); fs.mkdirSync(dossierAutre);
		configurer(dossierAutre, { serveur: u, projet: "autre" });
		const sans = await outil(["statut", "--json"], { cwd: dossierAutre });
		assert.equal(sans.code, 4); assert.match(sans.json.erreur.message, /outil connexion/);
		// Jeton dans .outil.json : refusé, sous toute forme.
		for (const contenu of [{ serveur: u, projet: "jardin", jeton: agent }, { serveur: u, projet: "jardin", auth: { token: "x" } }, { serveur: u, projet: "jardin", note: agent },
			{ serveur: u, projet: "jardin", authorization: "Bearer " + agent }, { serveur: u, projet: "jardin", entetes: ["Authorization: Bearer " + agent] },
			{ serveur: u, projet: "jardin", auth: "x" }, { serveur: u, projet: "jardin", apiKey: "x" }]) {
			configurer(dossierAutre, contenu);
			const k = await outil(["statut", "--json"], { cwd: dossierAutre, env: { OUTIL_JETON: agent } });
			assert.equal(k.code, 1, JSON.stringify(contenu)); assert.match(k.json.erreur.message, /contient un jeton/);
			assert.equal((await outil(["connexion"], { cwd: dossierAutre, entree: agent })).code, 1);
		}
		// Une clé voisine sans secret (auteur, author) n'est pas prise pour un jeton.
		configurer(dossierAutre, { serveur: u, projet: "jardin", auteur: "Équipe", author: "x" });
		assert.equal((await outil(["statut"], { cwd: dossierAutre, env: { OUTIL_JETON: agent } })).code, 0);
		configurer(dossierAutre, "{ pas du json");
		assert.equal((await outil(["statut"], { cwd: dossierAutre, env: { OUTIL_JETON: agent } })).code, 1);
		// Jeton révoqué : 4.
		const j = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Jetable" } })).corps;
		await appel(u, `/api/admin/jetons/${j.id}`, { cookie: adm, methode: "DELETE" });
		assert.equal((await outil(["statut"], { env: { OUTIL_JETON: j.jeton } })).code, 4);
		// Serveur injoignable : 1.
		configurer(dossierAutre, { serveur: "http://127.0.0.1:9", projet: "jardin" });
		assert.equal((await outil(["statut"], { cwd: dossierAutre, env: { OUTIL_JETON: agent } })).code, 1);
	});

	test("statut --json : rôle, retours par statut, dernier build, URL de la page", async () => {
		configurer();
		const id = await nouveau();
		const r = await outil(["statut", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.projet, "jardin"); assert.equal(r.json.role, "agent"); assert.equal(r.json.page, `${u}/p/jardin/`);
		assert.ok(r.json.retours.parStatut.nouveau >= 1);
		assert.equal(r.json.retours.total, Object.values(r.json.retours.parStatut).reduce((a: number, b) => a + (b as number), 0));
		assert.ok(r.json.build === null || typeof r.json.build.build === "number");
		assert.ok(id);
		// Dossier de travail (METHODE § 2.3) : en clair, hors du dépôt ; sans LOCALAPPDATA (Windows) : null, sans échec.
		if (process.platform === "win32") assert.equal(r.json.travail, null);
		const ici = { OUTIL_JETON: agent, LOCALAPPDATA: path.join(tmp, "localappdata"), XDG_CACHE_HOME: path.join(tmp, "cache") };
		const t = await outil(["statut", "--json"], { env: ici });
		assert.equal(t.json.travail, process.platform === "win32" ? path.join(ici.LOCALAPPDATA, "outil", "travail", "jardin") : path.join(ici.XDG_CACHE_HOME, "outil", "travail", "jardin"));
		const h = await outil(["statut"], { env: ici });
		assert.ok(h.stdout.includes(`dossier de travail : ${t.json.travail} (hors du dépôt`), h.stdout);
	});

	test("retours liste : --statut filtre vraiment, --dossier écrit {id, version, donnees} et retire les restes, voir", async () => {
		configurer();
		const a = await nouveau({ ref: "liste-a" }), b = await nouveau({ ref: "liste-b" });
		await appel(u, "/api/p/jardin/retours/batch", { bearer: agent, corps: { ecritures: [{ id: b, version: 1, champs: { status: "fait", reply: "ok", replied: new Date().toISOString(), updated: new Date().toISOString() } }] } });
		const tous = await outil(["retours", "liste", "--json"], { env: { OUTIL_JETON: agent } });
		const nv = await outil(["retours", "liste", "--statut", "nouveau,pris", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(nv.code, 0);
		assert.ok(tous.json.docs.some((d: any) => d.id === b));
		assert.ok(nv.json.docs.some((d: any) => d.id === a));
		assert.ok(!nv.json.docs.some((d: any) => d.id === b), "le filtre --statut est appliqué");
		assert.ok(nv.json.docs.every((d: any) => ["nouveau", "pris"].includes(d.donnees.status)));
		const travail = path.join(tmp, "travail", "retours");
		const l1 = await outil(["retours", "liste", "--dossier", travail, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(l1.json.ecrits, tous.json.docs.length);
		const fb = JSON.parse(fs.readFileSync(path.join(travail, b + ".json"), "utf8"));
		assert.deepEqual(Object.keys(fb), ["id", "version", "donnees"]);
		assert.equal(fb.version, 2); assert.equal(fb.donnees.status, "fait");
		fs.writeFileSync(path.join(travail, "a-moi.json"), "{}");
		fs.writeFileSync(path.join(travail, "Notes.json"), "{\"x\":1}");
		const l2 = await outil(["retours", "liste", "--statut", "nouveau", "--dossier", travail, "--json"], { env: { OUTIL_JETON: agent } });
		assert.ok(l2.json.retires >= 1);
		assert.ok(!fs.existsSync(path.join(travail, b + ".json")), "reste d'une liste précédente retiré");
		assert.ok(fs.existsSync(path.join(travail, a + ".json")));
		assert.ok(fs.existsSync(path.join(travail, "a-moi.json")) && fs.existsSync(path.join(travail, "Notes.json")), "les autres fichiers ne sont pas touchés");
		// Sortie lisible.
		const h = await outil(["retours", "liste", "--statut", "nouveau"], { env: { OUTIL_JETON: agent } });
		assert.match(h.stdout, new RegExp(`${a}  v1  nouveau`));
		// voir
		const v = await outil(["retours", "voir", b, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(v.code, 0); assert.equal(v.json.id, b); assert.equal(v.json.version, 2); assert.equal(v.json.donnees.reply, "ok");
		assert.equal((await outil(["retours", "voir", "Inexistant1", "--json"], { env: { OUTIL_JETON: agent } })).code, 1);
	});

	test("retours liste sans --dossier : <travail>/retours (dossier de travail d'outil statut), chemin affiché ; --dossier n'y touche pas ; sans dossier de travail : la liste seule", async () => {
		configurer();
		const a = await nouveau({ ref: "liste-defaut" });
		const ici = { OUTIL_JETON: agent, LOCALAPPDATA: path.join(tmp, "localappdata-liste"), XDG_CACHE_HOME: path.join(tmp, "cache-liste") };
		const attendu = path.join(process.platform === "win32" ? path.join(ici.LOCALAPPDATA, "outil", "travail", "jardin") : path.join(ici.XDG_CACHE_HOME, "outil", "travail", "jardin"), "retours");
		const st = await outil(["statut", "--json"], { env: ici });
		assert.equal(path.join(st.json.travail, "retours"), attendu, "même dossier de travail qu'outil statut");
		const l = await outil(["retours", "liste", "--statut", "nouveau", "--json"], { env: ici });
		assert.equal(l.code, 0, l.stderr);
		assert.equal(l.json.dossier, attendu); assert.equal(l.json.ecrits, l.json.docs.length); assert.ok(l.json.docs.some((d: any) => d.id === a));
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(attendu, a + ".json"), "utf8"))), ["id", "version", "donnees"]);
		const h = await outil(["retours", "liste", "--statut", "nouveau"], { env: ici });
		assert.ok(h.stdout.includes(`fichier(s) écrit(s) dans ${attendu}`), h.stdout);
		// --dossier explicite : comportement inchangé, le dossier par défaut n'est pas touché.
		const avant = fs.readdirSync(attendu).sort();
		const autre = path.join(tmp, "travail-explicite");
		const e = await outil(["retours", "liste", "--statut", "fait", "--dossier", autre, "--json"], { env: ici });
		assert.equal(e.json.dossier, autre);
		assert.deepEqual(fs.readdirSync(attendu).sort(), avant);
		// Windows sans LOCALAPPDATA : la liste seule, sortie 0, aucun fichier écrit (ailleurs, HOME suffit toujours).
		if (process.platform === "win32") {
			const s0 = await outil(["retours", "liste", "--json"], { env: { OUTIL_JETON: agent } });
			assert.equal(s0.code, 0, s0.stderr);
			assert.equal(s0.json.dossier, null); assert.equal(s0.json.ecrits, undefined); assert.ok(s0.json.docs.length >= 1);
			assert.match(s0.stderr + (await outil(["retours", "liste"], { env: { OUTIL_JETON: agent } })).stdout, /dossier de travail introuvable .* aucun fichier écrit/);
		}
	});

	test("retours repondre : heure posée par la CLI (replied = updated = heure de l'envoi) ; 409 → 3 avec le retour à jour", async () => {
		configurer();
		const id = await nouveau({ ref: "repondre" });
		const avant = Date.now();
		const r = await outil(["retours", "repondre", id, "--statut", "fait", "--version", "1", "--texte", "Fait (J1) : 4 jours → 3 jours.", "--json"], { env: { OUTIL_JETON: agent } });
		const apres = Date.now();
		assert.equal(r.code, 0, r.stderr);
		const d = await doc(id);
		assert.equal(d.version, 2);
		assert.equal(d.donnees.reply, "Fait (J1) : 4 jours → 3 jours.");
		assert.equal(d.donnees.status, "fait");
		assert.equal(d.donnees.replied, d.donnees.updated);
		assert.equal(d.donnees.replied, r.json.heure);
		const t = Date.parse(d.donnees.replied);
		assert.ok(t >= avant - 5 && t <= apres + 5, "heure du système au moment de l'envoi");
		assert.deepEqual(r.json.versions, [{ id, version: 2 }]);
		// Version périmée : 3, document à jour dans la sortie JSON, rien d'écrit.
		const n = nbCommits(depot);
		const c = await outil(["retours", "repondre", id, "--statut", "pris", "--version", "1", "--texte", "Pris.", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(c.code, 3);
		assert.equal(c.json.erreur.statut, 409); assert.equal(c.json.erreur.document.version, 2); assert.equal(c.json.erreur.document.id, id);
		assert.equal(nbCommits(depot), n);
		// Sans --json : le retour à jour est affiché.
		const h = await outil(["retours", "repondre", id, "--statut", "pris", "--version", "1", "--texte", "Pris."], { env: { OUTIL_JETON: agent } });
		assert.equal(h.code, 3); assert.match(h.stdout, /Retour à jour/); assert.match(h.stdout, /version 2/); assert.match(h.stderr, /conflit/);
		// Texte depuis un fichier (plusieurs lignes, guillemets).
		const f = path.join(tmp, "reponse.txt"); fs.writeFileSync(f, "Ligne 1 « citée ».\r\nLigne 2 \"x\".\r\n");
		const tf = await outil(["retours", "repondre", id, "--statut", "question", "--version", "2", "--texte-fichier", f], { env: { OUTIL_JETON: agent } });
		assert.equal(tf.code, 0, tf.stderr);
		assert.equal((await doc(id)).donnees.reply, "Ligne 1 « citée ».\nLigne 2 \"x\".");
		// Jeton mainteneur : pas le droit de répondre (403 → 4).
		const m = await outil(["retours", "repondre", id, "--statut", "fait", "--version", "3", "--texte", "x", "--json"], { env: { OUTIL_JETON: mainteneur } });
		assert.equal(m.code, 4); assert.equal(m.json.erreur.statut, 403);
	});

	test("retours repondre --lot : validation locale avant envoi, tout ou rien, 409 → 3, un commit", async () => {
		configurer();
		const ids = [await nouveau({ ref: "lot-1" }), await nouveau({ ref: "lot-2" }), await nouveau({ ref: "lot-3" })];
		const n0 = nbCommits(depot);
		// Validation locale : rien n'est envoyé.
		const mauvais: unknown[] = [
			[{ id: ids[0], version: 1, statut: "fait", texte: "ok", replied: "2020-01-01T00:00:00Z" }],
			[{ id: ids[0], version: 1, statut: "fait", texte: "ok", updated: "2020-01-01T00:00:00Z" }],
			[{ id: ids[0], version: 1, statut: "termine", texte: "ok" }],
			[{ id: ids[0], version: "1", statut: "fait", texte: "ok" }],
			[{ id: ids[0], version: 1, statut: "fait", texte: "" }],
			[{ id: ids[0], version: 1, statut: "fait", texte: "a" }, { id: ids[0], version: 1, statut: "pris", texte: "b" }],
			[{ id: "../x", version: 1, statut: "fait", texte: "a" }],
			Array.from({ length: 51 }, (_, i) => ({ id: "Id" + i, version: 1, statut: "fait", texte: "a" })),
			[], { id: ids[0] },
		];
		for (const lot of mauvais) {
			const r = await outil(["retours", "repondre", "--lot", ecrireJson("lot-mauvais.json", lot), "--json"], { env: { OUTIL_JETON: agent } });
			assert.equal(r.code, 1, JSON.stringify(lot).slice(0, 100));
			assert.match(r.json.erreur.message, /avant envoi/);
		}
		const pasJson = path.join(tmp, "lot-casse.json"); fs.writeFileSync(pasJson, "[{");
		assert.equal((await outil(["retours", "repondre", "--lot", pasJson], { env: { OUTIL_JETON: agent } })).code, 1);
		assert.equal(nbCommits(depot), n0, "rien d'envoyé");
		// Un lecteur précise le troisième entre la lecture et l'envoi : tout le lot est refusé (3), rien d'écrit.
		const v3 = (await doc(ids[2])).version;
		await appel(u, `/api/p/jardin/retours/${ids[2]}`, { cookie: contrib, methode: "PATCH", corps: { champs: { text: "Trop d'eau.\n\n— Précision : surtout en avril", status: "nouveau" }, version: v3 } });
		const lot = ids.map(id => ({ id, version: 1, statut: "fait", texte: `Fait pour ${id}.` }));
		const f = ecrireJson("lot.json", lot);
		const c = await outil(["retours", "repondre", "--lot", f, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(c.code, 3, c.stderr);
		assert.equal(c.json.erreur.index, 2); assert.equal(c.json.erreur.id, ids[2]);
		assert.equal(c.json.erreur.document.version, 2); assert.match(c.json.erreur.document.donnees.text, /surtout en avril/);
		for (const id of ids.slice(0, 2)) assert.equal((await doc(id)).donnees.status, "nouveau", "tout ou rien");
		assert.equal(nbCommits(depot), n0 + 1, "seulement la précision du lecteur");
		// Version corrigée : un seul commit pour le lot.
		lot[2].version = 2;
		const ok = await outil(["retours", "repondre", "--lot", ecrireJson("lot.json", lot), "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(ok.code, 0, ok.stderr);
		assert.equal(nbCommits(depot), n0 + 2);
		assert.equal(git(depot, "log", "-1", "--format=%an|%s").trim(), "Agent CLI (pour adm)|batch : 3 retours");
		const docs = await Promise.all(ids.map(doc));
		assert.ok(docs.every(d => d.donnees.status === "fait" && d.donnees.replied === ok.json.heure && d.donnees.updated === ok.json.heure));
		// Retour supprimé entre-temps : 404 → 1, avec l'id fautif.
		const sup = await nouveau({ ref: "supprime" });
		await appel(u, `/api/p/jardin/retours/${sup}?version=1`, { cookie: contrib, methode: "DELETE" });
		const r404 = await outil(["retours", "repondre", "--lot", ecrireJson("lot404.json", [{ id: sup, version: 1, statut: "fait", texte: "x" }]), "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(r404.code, 1); assert.equal(r404.json.erreur.statut, 404); assert.equal(r404.json.erreur.id, sup);
	});

	test("notes envoyer / liste : validation locale (règles de build.js), 409 → 3, --remplacer", async () => {
		configurer();
		const n0 = nbCommits(depot);
		const notes = JSON.parse(fs.readFileSync(path.join(EXEMPLES, "notes_exemple.json"), "utf8"));
		const dir = path.join(tmp, "notes"); fs.mkdirSync(dir, { recursive: true });
		const f = path.join(dir, "notes_2026-11-12.json");
		fs.writeFileSync(f, JSON.stringify(notes, null, 2));
		// Locale : jalon non déclaré → 1, rien d'envoyé.
		const faux = path.join(dir, "notes_2026-11-13.json");
		fs.writeFileSync(faux, JSON.stringify({ title: "x", date: "2026-11-13", changes: [{ id: "Z1-a", milestone: "Z1", subject: "s" }] }));
		const l = await outil(["notes", "envoyer", faux, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(l.code, 1); assert.match(l.json.erreur.message, /jalon inconnu « Z1 »/);
		assert.equal(nbCommits(depot), n0);
		const r = await outil(["notes", "envoyer", f, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(r.code, 0, r.stderr); assert.equal(r.json.cree, true);
		assert.equal(nbCommits(depot), n0 + 1);
		const again = await outil(["notes", "envoyer", f, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(again.code, 3); assert.equal(again.json.erreur.statut, 409);
		const idem = await outil(["notes", "envoyer", f, "--remplacer", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(idem.code, 0); assert.equal(idem.json.inchange, true);
		// Règle entre fichiers (vérifiée par le serveur) : un id déjà pris dans une autre série → 1.
		const doublon = path.join(dir, "notes_2026-11-14.json");
		fs.writeFileSync(doublon, JSON.stringify({ title: "y", date: "2026-11-14", milestones: { V1: "x" }, changes: [{ id: "V1-chaleur", milestone: "V1", subject: "s" }] }));
		const d = await outil(["notes", "envoyer", doublon, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(d.code, 1); assert.equal(d.json.erreur.statut, 400); assert.match(d.json.erreur.message, /identifiant en double/);
		const liste = await outil(["notes", "liste", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(liste.code, 0);
		assert.ok(liste.json.notes.some((n: any) => n.nom === "notes_2026-11-12.json" && n.date === "2026-11-12"));
		assert.match((await outil(["notes", "liste"], { env: { OUTIL_JETON: agent } })).stdout, /notes_2026-11-12\.json {2}2026-11-12/);
	});

	test("export envoyer : build, poids, URL ; erreurs de build.js → 1 ; statut voit le build", async () => {
		configurer();
		const r = await outil(["export", "envoyer", path.join(EXEMPLES, "data.json"), "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.json.build >= 1 && r.json.octets > 1000); assert.equal(r.json.page, `${u}/p/jardin/`);
		const st = await outil(["statut", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(st.json.build.build, r.json.build);
		const casse = ecrireJson("data-casse.json", { tabs: [] });
		const e = await outil(["export", "envoyer", casse, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(e.code, 1); assert.equal(e.json.erreur.statut, 422); assert.match(e.json.erreur.message, /data\.title/);
		const pasJson = path.join(tmp, "data-pas-json.json"); fs.writeFileSync(pasJson, "{");
		assert.equal((await outil(["export", "envoyer", pasJson], { env: { OUTIL_JETON: agent } })).code, 1);
		assert.equal((await outil(["export", "envoyer", path.join(tmp, "absent.json")], { env: { OUTIL_JETON: agent } })).code, 1);
	});

	test("importer-artifact : ids gardés ou renommés, refus avec raison (sortie 1), ré-import sans doublon, un commit par import, jeton mainteneur", async () => {
		configurer();
		const dossier = path.join(tmp, "artifact");
		fs.mkdirSync(path.join(dossier, "retours"), { recursive: true });
		const base = { kind: "plante", name: "Tomate", tab: "plantes", anchor: "plantes--tomate", cat: "idee", text: "Import.", proposal: "", status: "fait", reply: "Fait.",
			replied: "2026-11-10T10:00:00.000Z", created: "2026-11-09T08:00:00.000Z", updated: "2026-11-10T10:00:00.000Z", by: "u-claude", codex: "2026-11-01T00:00:00Z" };
		const ecrire = (id: string, o: unknown) => fs.writeFileSync(path.join(dossier, "retours", id + ".json"), typeof o === "string" ? o : JSON.stringify(o));
		ecrire("ImportA1", { ...base, ref: "a" });
		ecrire("import-b-2", { ...base, ref: "b" });
		ecrire("ImportC3", { ...base, ref: "c", status: "fini" });
		ecrire("ImportD4", "{ illisible");
		// Agent : 4.
		assert.equal((await outil(["importer-artifact", dossier, "--json"], { env: { OUTIL_JETON: agent } })).code, 4);
		const n0 = nbCommits(depot);
		const r = await outil(["importer-artifact", dossier, "--json"], { env: { OUTIL_JETON: mainteneur } });
		assert.equal(r.code, 1, "au moins un refus");
		assert.equal(r.json.importes.length, 2);
		assert.deepEqual(r.json.importes.find((x: any) => x.origine === "ImportA1"), { origine: "ImportA1", id: "ImportA1" });
		const renomme = r.json.importes.find((x: any) => x.origine === "import-b-2");
		assert.match(renomme.id, /^[A-Za-z0-9]{20}$/);
		assert.equal(r.json.refuses.length, 2);
		assert.ok(r.json.refuses.some((x: any) => x.fichier === "ImportC3.json" && /status inconnu/.test(x.raison)));
		assert.ok(r.json.refuses.some((x: any) => x.fichier === "ImportD4.json" && /JSON illisible/.test(x.raison)));
		assert.equal(nbCommits(depot), n0 + 1);
		assert.equal(git(depot, "log", "-1", "--format=%an|%s").trim(), "Mainteneur CLI (pour adm)|import depuis claude.ai : 2 retours");
		assert.equal((await doc("ImportA1")).donnees.by, "import:u-claude");
		// Ré-import : rien de nouveau, aucun commit.
		const h = await outil(["importer-artifact", dossier], { env: { OUTIL_JETON: mainteneur } });
		assert.equal(h.code, 1);
		assert.match(h.stdout, /importés : 0 ; ignorés \(déjà présents\) : 2 ; refusés : 2/);
		assert.equal(nbCommits(depot), n0 + 1);
		// Sans erreur : sortie 0 ; dossier sans sous-dossier retours/ accepté.
		const plat = path.join(tmp, "artifact-plat"); fs.mkdirSync(plat);
		fs.writeFileSync(path.join(plat, "ImportE5.json"), JSON.stringify({ ...base, ref: "e" }));
		const p = await outil(["importer-artifact", plat, "--json"], { env: { OUTIL_JETON: mainteneur } });
		assert.equal(p.code, 0, p.stderr); assert.equal(p.json.importes.length, 1);
		assert.equal((await outil(["importer-artifact", path.join(tmp, "absent")], { env: { OUTIL_JETON: mainteneur } })).code, 1);
	});

	test("importer-artifact : découpe en lots de 500 (501 retours → 2 lots, 2 commits)", async () => {
		configurer();
		const dossier = path.join(tmp, "artifact-gros", "retours");
		fs.mkdirSync(dossier, { recursive: true });
		for (let i = 0; i < 501; i++) {
			const t = new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
			fs.writeFileSync(path.join(dossier, `Gros${String(i).padStart(3, "0")}.json`), JSON.stringify({ kind: "plante", ref: "g" + i, name: "G", tab: "plantes", anchor: "", cat: "idee",
				text: "x", proposal: "", status: "nouveau", reply: "", replied: "", created: t, updated: t, by: "", codex: "" }));
		}
		const n0 = nbCommits(depot);
		const r = await outil(["importer-artifact", path.dirname(dossier), "--json"], { env: { OUTIL_JETON: mainteneur } });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.lots, 2); assert.equal(r.json.importes.length, 501);
		assert.equal(nbCommits(depot), n0 + 2);
	});

	test("lanceurs : cli/outil (sh) et cli/outil.cmd transmettent arguments et code de sortie", async () => {
		const lancer = (cmd: string, args: string[]) => new Promise<{ code: number; stdout: string }>((ok, ko) => {
			const p = spawn(cmd, args, { cwd: code, env, windowsHide: true });
			let stdout = ""; p.stdout.setEncoding("utf8"); p.stdout.on("data", c => stdout += c);
			p.on("error", ko); p.on("close", c => ok({ code: c ?? -1, stdout }));
			p.stdin.end();
		});
		const sh = await lancer("sh", [path.join(RACINE, "cli", "outil"), "aide", "--json"]).catch(() => null);
		if (sh) { assert.equal(sh.code, 0); assert.equal(JSON.parse(sh.stdout).commandes.length, NB_COMMANDES); assert.equal((await lancer("sh", [path.join(RACINE, "cli", "outil"), "inconnue"])).code, 2); }
		if (process.platform === "win32") {
			const cmd = await lancer(process.env.ComSpec || "cmd.exe", ["/d", "/c", path.join(RACINE, "cli", "outil.cmd"), "aide", "--json"]);
			assert.equal(cmd.code, 0); assert.equal(JSON.parse(cmd.stdout).commandes.length, NB_COMMANDES);
			assert.equal((await lancer(process.env.ComSpec || "cmd.exe", ["/d", "/c", path.join(RACINE, "cli", "outil.cmd"), "retours", "voir"])).code, 2);
		}
	});

	// --- Défauts de la répétition générale et des relectures (docs/etape2-cli-methode.md, écarts CLI 18 et suivants) ---

	test("lancée par un lien ou une jonction vers cli/ : la CLI s'exécute (pas une sortie 0 muette)", async () => {
		const lien = path.join(tmp, "lien-cli");
		fs.symlinkSync(path.join(RACINE, "cli"), lien, process.platform === "win32" ? "junction" : "dir");
		const r = await new Promise<{ code: number; stdout: string }>((ok, ko) => {
			const p = spawn(process.execPath, [path.join(lien, "outil.ts"), "aide", "--json"], { cwd: code, env, windowsHide: true });
			let stdout = ""; p.stdout.setEncoding("utf8"); p.stdout.on("data", c => stdout += c);
			p.on("error", ko); p.on("close", c => ok({ code: c ?? -1, stdout })); p.stdin.end();
		});
		assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).commandes.length, NB_COMMANDES, "sortie attendue : " + r.stdout);
		// Une commande qui écrit : la réponse arrive vraiment au serveur.
		configurer();
		const id = await nouveau({ ref: "par-lien" });
		const w = await new Promise<number>((ok, ko) => {
			const p = spawn(process.execPath, [path.join(lien, "outil.ts"), "retours", "repondre", id, "--statut", "fait", "--version", "1", "--texte", "via lien"], { cwd: code, env: { ...env, OUTIL_JETON: agent }, windowsHide: true });
			p.on("error", ko); p.on("close", c => ok(c ?? -1)); p.stdin.end();
		});
		assert.equal(w, 0);
		assert.equal((await doc(id)).donnees.reply, "via lien");
		// Le lien seul est retiré (jamais un nettoyage récursif à travers lui, qui viderait cli/).
		try { fs.unlinkSync(lien); } catch { fs.rmdirSync(lien); }
		assert.ok(fs.existsSync(OUTIL));
		assert.ok(!JSON.parse(fs.readFileSync(path.join(RACINE, "cli", "package.json"), "utf8")).bin, "pas de « bin » (npm link : non pris en charge)");
	});

	test("jeton jamais recopié : OUTIL_JETON de deux lignes, jeton passé en argument, trace", async () => {
		configurer();
		const secret = "wdd_SECRETabcdefghijklmnop";
		const r = await outil(["statut", "--json"], { env: { OUTIL_JETON: secret + "\nzz" } });
		assert.equal(r.code, 4, "problème de jeton : s'arrêter et demander à l'humain");
		assert.match(r.json.erreur.message, /OUTIL_JETON n'a pas la forme d'un jeton/);
		assert.ok(!r.stdout.includes("SECRET") && !r.stderr.includes("SECRET"), r.stdout + r.stderr);
		for (const args of [["connexion", secret, "--json"], ["retours", "voir", "Ab1", secret, "--json"]]) {
			const a = await outil(args, { env: { OUTIL_JETON: agent } });
			assert.equal(a.code, 2);
			assert.ok(!a.stdout.includes("SECRET") && !a.stderr.includes("SECRET"), a.stdout + a.stderr);
			assert.match(a.json.erreur.message, /jamais en argument/);
		}
		// Serveur d'une URL qui contient un jeton : masqué aussi.
		const dossier = path.join(tmp, "code-jeton-url"); fs.mkdirSync(dossier, { recursive: true });
		configurer(dossier, { serveur: "pas une url " + agent, projet: "jardin" });
		const m = await outil(["statut", "--json"], { cwd: dossier, env: { OUTIL_JETON: agent } });
		assert.ok(m.code !== 0 && !m.stdout.includes(agent) && !m.stderr.includes(agent));
	});

	test("réponse 2xx qui n'est pas du JSON (proxy, page de connexion) : message utile, sortie 1, pas de trace", async () => {
		const http = await import("node:http");
		const faux = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<html>connexion</html>"); });
		await new Promise<void>(ok => faux.listen(0, "127.0.0.1", ok));
		try {
			const dossier = path.join(tmp, "code-proxy"); fs.mkdirSync(dossier, { recursive: true });
			configurer(dossier, { serveur: `http://127.0.0.1:${(faux.address() as any).port}`, projet: "jardin" });
			for (const args of [["statut", "--json"], ["retours", "repondre", "--lot", ecrireJson("lot-proxy.json", [{ id: "Ab1", version: 1, statut: "fait", texte: "x" }]), "--json"]]) {
				const r = await outil(args, { cwd: dossier, env: { OUTIL_JETON: agent } });
				assert.equal(r.code, 1, r.stderr);
				assert.match(r.json.erreur.message, /réponse inattendue du serveur \(200, pas du JSON : text\/html\)/);
				assert.ok(!/TypeError|erreur interne|    at /.test(r.stdout + r.stderr), r.stdout);
			}
		} finally { await new Promise(ok => faux.close(ok)); }
	});

	test("connexion : le serveur visé est dit sur stderr avant la lecture du jeton", async () => {
		const dossier = path.join(tmp, "code-connexion-2"); fs.mkdirSync(dossier);
		configurer(dossier);
		const r = await outil(["connexion", "--json"], { cwd: dossier, entree: agent });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.stderr.includes(`connexion à jardin sur ${u} (serveur et projet lus dans ${path.join(dossier, ".outil.json")})`), r.stderr);
		assert.ok(!r.stderr.includes(agent));
		const aide = await outil(["aide", "importer-artifact"]);
		assert.match(aide.stdout, /read -rs OUTIL_JETON/); assert.ok(!/OUTIL_JETON=</.test(aide.stdout), "pas de jeton sur la ligne de commande");
	});

	test("notes voir : jalons, commits, ids, texte complet des points à valider ; notes liste : jalons déjà pris ; 409 : autre nom", async () => {
		configurer();
		const dir = path.join(tmp, "notes-voir"); fs.mkdirSync(dir, { recursive: true });
		const long = "Annulation libre jusqu'à 2 h avant le début (regles.preavis_annulation_heures = 2). Autre option : 24 h, plus simple pour l'accueil mais moins souple. Garder 2 h ?";
		const n = { title: "Retours du 20/11", date: "2026-11-20", milestones: { R1: "Rappels · 20/11", R2: "Annulation · 20/11" }, commits: { R1: "a1b2c3d" },
			changes: [{ id: "R1-rappel", milestone: "R1", subject: "Rappel", before: "30 min", after: "15 min" }],
			validations: [{ id: "R2-preavis", milestone: "R2", text: long }] };
		const f = path.join(dir, "notes_2026-11-20.json"); fs.writeFileSync(f, JSON.stringify(n, null, 2));
		const e = await outil(["notes", "envoyer", f], { env: { OUTIL_JETON: agent } });
		assert.equal(e.code, 0, e.stderr);
		assert.match(e.stdout, /ajouté, enregistré sur le serveur \(révision [0-9a-f]{10}\)/); assert.ok(!/commit/.test(e.stdout), "pas « commit » : révision du serveur");
		const v = await outil(["notes", "voir", "notes_2026-11-20.json", "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(v.code, 0, v.stderr); assert.deepEqual(v.json, { nom: "notes_2026-11-20.json", notes: n });
		const h = await outil(["notes", "voir", "notes_2026-11-20.json"], { env: { OUTIL_JETON: agent } });
		assert.ok(h.stdout.includes(long), "texte complet, non tronqué");
		assert.match(h.stdout, /R1 : Rappels · 20\/11 \(commit a1b2c3d\)/); assert.match(h.stdout, /R1-rappel \[R1\] Rappel : 30 min → 15 min/);
		const l = await outil(["notes", "liste", "--json"], { env: { OUTIL_JETON: agent } });
		assert.deepEqual(l.json.notes.find((x: any) => x.nom === "notes_2026-11-20.json").jalons, ["R1", "R2"]);
		assert.match((await outil(["notes", "liste"], { env: { OUTIL_JETON: agent } })).stdout, /jalons déjà pris : .*R1, R2/);
		assert.equal((await outil(["notes", "voir", "notes_2001-01-01.json"], { env: { OUTIL_JETON: agent } })).code, 1);
		assert.equal((await outil(["notes", "voir", "autre.txt"], { env: { OUTIL_JETON: agent } })).code, 2);
		const c = await outil(["notes", "envoyer", f, "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(c.code, 3); assert.match(c.json.erreur.message, /autre nom \(ex\. notes_2026-11-20_2\.json\)/); assert.match(c.json.erreur.message, /décision explicite d'un humain/);
		assert.ok(!/remplacer=1/.test(c.json.erreur.message), "plus d'invitation à ?remplacer=1");
	});

	test("export envoyer : résumé et avertissements du build ; statut : date locale ; repondre : révision du serveur, pas « commit »", async () => {
		configurer();
		const data = JSON.parse(fs.readFileSync(path.join(EXEMPLES, "data.json"), "utf8")); delete data.generated;
		const r = await outil(["export", "envoyer", ecrireJson("data-sans-date.json", data), "--json"], { env: { OUTIL_JETON: agent } });
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.json.resume, /^OK \d+ Ko · .*notes : \d+ fichier\(s\), \d+ nouveautés, \d+ mesures, \d+ points à valider( · changements : (aucun|\d+ modifiés, \d+ ajoutés, \d+ retirés.*))?$/);
		assert.ok(r.json.avertissements.some((a: string) => /data\.generated absent/.test(a)));
		assert.match(r.stderr, /attention \(build\) : data\.generated absent/);
		const h = await outil(["export", "envoyer", path.join(EXEMPLES, "data.json")], { env: { OUTIL_JETON: agent } });
		assert.match(h.stdout, /build n° \d+ : Wiki de \d+ octets → .*\n  OK \d+ Ko · .*points à valider/);
		const st = await outil(["statut"], { env: { OUTIL_JETON: agent } });
		assert.match(st.stdout, /^Wiki : http:\/\/\S+\/p\/jardin\/$/m);
		assert.match(st.stdout, /dernier build : n° \d+ du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(/);
		const stj = await outil(["statut", "--json"], { env: { OUTIL_JETON: agent } });
		assert.ok(!Number.isNaN(Date.parse(stj.json.build.date)) && stj.json.build.date.endsWith("Z"), "ISO gardé dans --json");
		const id = await nouveau({ ref: "revision" });
		const rep = await outil(["retours", "repondre", id, "--statut", "fait", "--version", "1", "--texte", "Fait."], { env: { OUTIL_JETON: agent } });
		assert.equal(rep.code, 0, rep.stderr);
		assert.match(rep.stdout, /enregistré sur le serveur \(révision [0-9a-f]{10}\)/); assert.ok(!/commit/.test(rep.stdout));
	});
});
