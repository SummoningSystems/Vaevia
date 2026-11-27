// Étape 3.5, CLI : « outil publier » (docs/etape3-5-prise-en-main.md § 4) et « outil methode » (§ 6.1), contre un vrai
// serveur de test. Faux exporteur en Node (écrit data.json à {data}, échoue, n'écrit rien) ; notes absentes envoyées,
// identiques sautées, différentes signalées sans remplacement ; dossier de travail hors du dépôt ; clé « publier » de
// .outil.json acceptée (pas prise pour un secret) ; .cmd refusé sous Windows sans jamais être lancé ; OUTIL_JETON
// jamais passé à l'exporteur ; aucun jeton dans les sorties.
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { RACINE, environnement, lancer, dossierTravail } from "./aide-cli.ts";
import { lancerExporteur } from "../publier.ts";

const EXEMPLES = path.join(RACINE, "site", "examples");

// Faux exporteur : --out=<chemin> ; FAUX_MODE=echec (sortie 2), rien (sortie 0 sans écrire), sinon copie de l'exemple.
// Il refuse de tourner si OUTIL_JETON lui est transmis (sortie 3).
const EXPORTEUR = `
import fs from "node:fs";
if (process.env.OUTIL_JETON !== undefined) { console.error("OUTIL_JETON transmis à l'exporteur"); process.exit(3); }
const out = (process.argv.find(a => a.startsWith("--out=")) || "").slice(6);
console.log("export : début (stdout)");
console.error("export : progression (stderr)");
if (process.env.FAUX_MODE === "echec") { console.error("boom : sorte inconnue « x »"); process.exit(2); }
if (process.env.FAUX_MODE === "rien") process.exit(0);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(EXEMPLES, "data.json"))}, "utf8"));
data.title = process.env.FAUX_TITRE || "Publié par le faux exporteur";
// Date d'export : réécrite à chaque passage, comme un vrai exporteur (--si-change ne la compare pas).
data.generated = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify(data));
console.log("export : écrit " + out);
`;

describe("CLI outil : publier et methode", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, code: string, agent: string, adm: string;
	before(async () => {
		tmp = dossierTemp("cli-publier");
		env = environnement(tmp);
		s = await serveurTest(path.join(tmp, "donnees"));
		u = s.url;
		await projet(u, "jardin");
		adm = await session(u, "jardin", "adm", "admin");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent publier" } })).corps.jeton;
		code = path.join(tmp, "code");
		fs.mkdirSync(path.join(code, "tools", "site-retours"), { recursive: true });
		fs.writeFileSync(path.join(code, "tools", "site-retours", "export.mjs"), EXPORTEUR);
		fs.copyFileSync(path.join(EXEMPLES, "notes_exemple.json"), path.join(code, "tools", "site-retours", "notes_2026-11-12.json"));
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	const configurer = (publier: unknown) => fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin", ...(publier === undefined ? {} : { publier }) }, null, 2));
	const PUBLIER = { exporteur: ["node", "tools/site-retours/export.mjs", "--out={data}"], notes: "tools/site-retours" };
	const outil = (args: string[], extra: Record<string, string> = {}, cwd = code) => lancer(env, args, { cwd, env: { OUTIL_JETON: agent, ...extra } });
	const sansJeton = (r: { stdout: string; stderr: string }) => assert.ok(!r.stdout.includes(agent) && !r.stderr.includes(agent) && !/wdd_[A-Za-z0-9_-]{16,}/.test(r.stdout + r.stderr), "aucun jeton dans la sortie");
	const dernierBuild = async () => (await appel(u, "/api/p/jardin/builds", { bearer: agent })).corps.dernier?.build ?? 0;
	const noteServeur = async (nom: string) => (await appel(u, `/api/p/jardin/notes/${nom}`, { bearer: agent })).corps;

	test("publier : notes absentes envoyées, exporteur lancé (sortie sur stderr, sans OUTIL_JETON), data.json du dossier de travail envoyé, adresse de la page", async () => {
		configurer(PUBLIER);
		const r = await outil(["publier", "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.json.notes.envoyees, ["notes_2026-11-12.json"]); assert.deepEqual(r.json.notes.identiques, []); assert.deepEqual(r.json.notes.differentes, []);
		assert.equal(r.json.page, `${u}/p/jardin/`); assert.ok(r.json.build >= 1 && r.json.octets > 1000);
		assert.match(r.json.resume, /^OK .*notes : 1 fichier\(s\)/);
		// Dossier de travail : hors du dépôt, dans le dossier temporaire de l'utilisateur.
		assert.equal(r.json.exporteur.data, path.join(dossierTravail(env, "jardin"), "data.json"));
		assert.ok(!r.json.exporteur.data.startsWith(code) && fs.existsSync(r.json.exporteur.data));
		assert.deepEqual(r.json.exporteur.commande, ["node", "tools/site-retours/export.mjs", `--out=${r.json.exporteur.data}`]);
		assert.equal(r.json.exporteur.dossier, code);
		// La sortie de l'exporteur passe sur stderr ; stdout reste le JSON.
		assert.match(r.stderr, /exporteur : export : début \(stdout\)/); assert.match(r.stderr, /exporteur : export : progression \(stderr\)/);
		assert.equal(await dernierBuild(), r.json.build);
		assert.ok((await noteServeur("notes_2026-11-12.json")).title, "note envoyée");
		sansJeton(r);
		// Sortie lisible.
		const h = await outil(["publier"]);
		assert.equal(h.code, 0, h.stderr);
		assert.match(h.stdout, /notes \(.*\) : 0 envoyée\(s\), 1 déjà sur le serveur, 0 différente\(s\) non remplacée\(s\)/);
		assert.match(h.stdout, /build n° \d+ : Wiki de \d+ octets → /); assert.match(h.stdout, new RegExp(`Wiki : ${u}/p/jardin/`));
	});

	// Étape 3.7, G2 : publication par une CI, avec un jeton « publieur ».
	test("CI : jeton publieur, --si-change --sans-notes : publie si les données changent, « inchangé » sinon (date d'export ignorée) ; notes refusées au publieur", async () => {
		configurer(PUBLIER);
		const pub = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "CI", role: "publieur" } })).corps.jeton;
		assert.ok(pub);
		const ci = (args: string[], extra: Record<string, string> = {}) => lancer(env, args, { cwd: code, env: { OUTIL_JETON: pub, ...extra } });
		const avant = await dernierBuild();
		const r1 = await ci(["publier", "--si-change", "--sans-notes", "--json"], { FAUX_TITRE: "Titre CI 1" });
		assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.inchange, undefined); assert.equal(r1.json.notes, null);
		assert.equal(await dernierBuild(), avant + 1);
		const r2 = await ci(["publier", "--si-change", "--sans-notes", "--json"], { FAUX_TITRE: "Titre CI 1" });
		assert.equal(r2.code, 0, r2.stderr); assert.equal(r2.json.inchange, true); assert.equal(r2.json.build, avant + 1);
		assert.equal(await dernierBuild(), avant + 1, "rien d'envoyé");
		const h = await ci(["publier", "--si-change", "--sans-notes"], { FAUX_TITRE: "Titre CI 1" });
		assert.match(h.stdout, new RegExp(`inchangé : data.json identique au build n° ${avant + 1}, rien d'envoyé`));
		const r3 = await ci(["publier", "--si-change", "--sans-notes", "--json"], { FAUX_TITRE: "Titre CI 2" });
		assert.equal(r3.code, 0, r3.stderr); assert.equal(r3.json.build, avant + 2);
		// Sans --sans-notes, le publieur bute sur les notes (403) : rien n'est publié.
		const r4 = await ci(["publier", "--json"], { FAUX_TITRE: "Titre CI 3" });
		assert.notEqual(r4.code, 0); assert.match(r4.stderr + r4.stdout, /publieur/);
		assert.equal(await dernierBuild(), avant + 2);
		for (const r of [r1, r2, r3, r4]) assert.ok(!(r.stdout + r.stderr).includes(pub), "aucun jeton dans la sortie");
	});

	test("publier : note identique sautée, différente signalée sans remplacement, nouvelle envoyée ; aucune ne se remplace", async () => {
		configurer(PUBLIER);
		const dir = path.join(code, "tools", "site-retours");
		const f12 = path.join(dir, "notes_2026-11-12.json");
		const avant = await noteServeur("notes_2026-11-12.json");
		const modifiee = { ...JSON.parse(fs.readFileSync(f12, "utf8")), title: "Titre changé en local" };
		fs.writeFileSync(f12, JSON.stringify(modifiee, null, 2));
		fs.writeFileSync(path.join(dir, "notes_2026-11-20.json"), JSON.stringify({ title: "Vague du 20", date: "2026-11-20", milestones: { W1: "Vague · 20/11" }, changes: [{ id: "W1-a", milestone: "W1", subject: "Arrosage" }] }));
		try {
			const r = await outil(["publier", "--json"]);
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.json.notes.envoyees, ["notes_2026-11-20.json"]);
			assert.deepEqual(r.json.notes.differentes, ["notes_2026-11-12.json"]);
			assert.match(r.stderr, /notes_2026-11-12\.json diffère de la version du serveur : non remplacée\. Pour la remplacer : outil notes envoyer .*--remplacer, sur décision d'un humain/);
			assert.deepEqual(await noteServeur("notes_2026-11-12.json"), avant, "jamais remplacée");
			const again = await outil(["publier", "--json"]);
			assert.deepEqual(again.json.notes.identiques, ["notes_2026-11-20.json"]); assert.deepEqual(again.json.notes.envoyees, []);
		} finally { fs.copyFileSync(path.join(EXEMPLES, "notes_exemple.json"), f12); }
		// Une note locale invalide : refus avant tout envoi (1), rien d'envoyé ni de construit.
		const b0 = await dernierBuild();
		fs.writeFileSync(path.join(dir, "notes_2026-11-21.json"), JSON.stringify({ title: "x", date: "2026-11-21", changes: [{ id: "Z9-a", milestone: "Z9", subject: "s" }] }));
		try {
			const r = await outil(["publier", "--json"]);
			assert.equal(r.code, 1); assert.match(r.json.erreur.message, /notes refusées avant envoi.*jalon inconnu « Z9 »/s);
			assert.equal(await dernierBuild(), b0);
			assert.equal((await appel(u, "/api/p/jardin/notes/notes_2026-11-21.json", { bearer: agent })).status, 404);
		} finally { fs.rmSync(path.join(dir, "notes_2026-11-21.json")); }
	});

	test("publier : exporteur en échec (1, fin de sa sortie), sans data.json (1, l'ancien n'est pas renvoyé), sans exporteur (1, marche à suivre, rien d'envoyé)", async () => {
		configurer(PUBLIER);
		const b0 = await dernierBuild();
		const e = await outil(["publier", "--json"], { FAUX_MODE: "echec" });
		assert.equal(e.code, 1);
		assert.match(e.json.erreur.message, /l'exporteur a échoué \(code 2\)/); assert.match(e.json.erreur.message, /boom : sorte inconnue « x »/);
		assert.match(e.stderr, /exporteur : boom/);
		assert.equal(await dernierBuild(), b0, "rien d'envoyé");
		// Un data.json d'une publication précédente reste dans le dossier de travail : il ne doit pas repartir.
		const data = path.join(dossierTravail(env, "jardin"), "data.json");
		fs.mkdirSync(path.dirname(data), { recursive: true }); fs.writeFileSync(data, fs.readFileSync(path.join(EXEMPLES, "data.json")));
		const rien = await outil(["publier", "--json"], { FAUX_MODE: "rien" });
		assert.equal(rien.code, 1); assert.match(rien.json.erreur.message, /sans écrire .*data\.json/);
		assert.equal(await dernierBuild(), b0);
		// Sans {data} dans la commande : le message le dit.
		configurer({ exporteur: ["node", "tools/site-retours/export.mjs"] });
		const sansData = await outil(["publier", "--json"], { FAUX_MODE: "rien" });
		assert.equal(sansData.code, 1); assert.match(sansData.json.erreur.message, /aucun argument ne contient \{data\}/);
		// Sans exporteur : 1, la marche à suivre ; les notes ne partent pas.
		const dir = path.join(code, "tools", "site-retours");
		fs.writeFileSync(path.join(dir, "notes_2026-11-22.json"), JSON.stringify({ title: "y", date: "2026-11-22", milestones: { X1: "x" }, changes: [{ id: "X1-a", milestone: "X1", subject: "s" }] }));
		try {
			for (const p of [undefined, { notes: "tools/site-retours" }]) {
				configurer(p);
				const r = await outil(["publier", "--json"]);
				assert.equal(r.code, 1); assert.equal(r.json.erreur.code, "sans_exporteur");
				assert.match(r.json.erreur.message, /METHODE\.md § 4/); assert.match(r.json.erreur.message, /"exporteur": \["node", "tools\/site-retours\/export\.mjs", "--out=\{data\}"\]/);
			}
			assert.equal((await appel(u, "/api/p/jardin/notes/notes_2026-11-22.json", { bearer: agent })).status, 404, "aucune note envoyée sans exporteur");
		} finally { fs.rmSync(path.join(dir, "notes_2026-11-22.json")); }
		// « publier » mal formé : 1. Exporteur introuvable : 1.
		for (const p of [{ exporteur: "node export.mjs" }, { exporteur: [] }, { exporteur: ["node", "a\nb"] }, { exporteur: ["node"], notes: path.join(tmp, "abs") }, "x"]) {
			configurer(p);
			const r = await outil(["publier", "--json"]);
			assert.equal(r.code, 1, JSON.stringify(p)); assert.match(r.json.erreur.message, /publier/);
		}
		configurer({ exporteur: ["programme-qui-n-existe-pas-wdd", "--out={data}"] });
		const intr = await outil(["publier", "--json"]);
		assert.equal(intr.code, 1); assert.match(intr.json.erreur.message, /exporteur introuvable/);
		// Un jeton dans « publier » reste refusé.
		configurer({ exporteur: ["node", "x.mjs", "--jeton=" + agent] });
		const jt = await outil(["publier", "--json"]);
		assert.equal(jt.code, 1); assert.match(jt.json.erreur.message, /contient un jeton/); sansJeton(jt);
	});

	test("publier sous Windows : un exporteur .cmd ou .bat est refusé avant tout envoi, sans être lancé", { skip: process.platform !== "win32" && "Windows seulement" }, async () => {
		const temoin = path.join(tmp, "cmd-lance.txt");
		fs.writeFileSync(path.join(code, "tools", "export.cmd"), `@echo off\r\necho lance> "${temoin}"\r\n`);
		fs.writeFileSync(path.join(code, "tools", "export.bat"), `@echo off\r\necho lance> "${temoin}"\r\n`);
		// « exporte » sans extension, trouvé dans le PATH sous la forme exporte.cmd (comme npm → npm.cmd).
		const bin = path.join(tmp, "bin"); fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "exporte.cmd"), `@echo off\r\necho lance> "${temoin}"\r\n`);
		const b0 = await dernierBuild();
		for (const [exporteur, extra] of [[["tools/export.cmd", "{data}"], {}], [["tools\\export.bat"], {}], [["exporte", "--out={data}"], { PATH: bin + path.delimiter + env.PATH }]] as [string[], Record<string, string>][]) {
			configurer({ exporteur, notes: "tools/site-retours" });
			const r = await outil(["publier", "--json"], extra);
			assert.equal(r.code, 1, exporteur.join(" "));
			assert.equal(r.json.erreur.code, "exporteur_refuse"); assert.match(r.json.erreur.message, /\.cmd ou \.bat/); assert.match(r.json.erreur.message, /Lancer node, ou un \.exe/);
		}
		assert.ok(!fs.existsSync(temoin), "le script n'a jamais été lancé");
		assert.equal(await dernierBuild(), b0, "rien d'envoyé");
	});

	test("Windows : le jeton défini sous une autre casse (Outil_Jeton) sert à publier mais n'est jamais transmis à l'exporteur", { skip: process.platform !== "win32" && "Windows seulement" }, async () => {
		configurer(PUBLIER);
		// Le faux exporteur sort en 3 s'il lit OUTIL_JETON (sous Windows, process.env ne tient pas compte de la casse).
		const r = await lancer(env, ["publier", "--json"], { cwd: code, env: { Outil_Jeton: agent } });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(!/OUTIL_JETON transmis/.test(r.stderr), r.stderr);
		sansJeton(r);
	});

	test("exporteur : délai dépassé → arrêt de l'arbre de processus, erreur « délai dépassé » (lancerExporteur, délai court)", async () => {
		const lignes: string[] = [];
		const ctx = { env, cwd: code, json: false, stdout: () => { }, stderr: (x: string) => { lignes.push(x); }, lireEntree: async () => "" };
		const t0 = Date.now();
		await assert.rejects(lancerExporteur(ctx, process.execPath, ["-e", "console.log('lent'); setTimeout(() => {}, 60000)"], code, 300),
			(e: any) => e.sortie === 1 && /délai dépassé/.test(e.message) && e.details.code === "exporteur_delai");
		assert.ok(Date.now() - t0 < 15000, "arrêté sans attendre la fin du programme");
		assert.ok(lignes.some(l => l === "exporteur : lent"), lignes.join("\n"));
	});

	test("METHODE.md : les sections vers lesquelles renvoient AGENTS.md, la veille et le raccourci Claude existent ; plus de jeton à coller pour brancher", () => {
		const methode = fs.readFileSync(path.join(RACINE, "methode", "METHODE.md"), "utf8");
		const agents = fs.readFileSync(path.join(RACINE, "methode", "AGENTS.md"), "utf8");
		// AGENTS.md, l'aide de la veille et l'exemple Claude renvoient à « Lancé par la veille » : un titre de ce nom.
		assert.match(agents, /section « Lancé par la veille » de la méthode/);
		// La règle « une commande simple par appel » dès AGENTS.md, lu avant la méthode (2e répétition, défaut 2 : trois
		// premiers appels composés refusés sous la veille).
		assert.ok(agents.includes("une commande simple par appel, ni enchaînement (`;`, `&&`, `|`), ni variable"), "AGENTS.md : une commande simple par appel");
		assert.match(methode, /^#{2,3} [\d.]+ Lancé par la veille$/m);
		const veille = methode.slice(methode.search(/^#{2,3} [\d.]+ Lancé par la veille$/m)).split(/^## /m)[0];
		for (const r of [/OUTIL_DEMANDE/, /[Aa]ucune question/, /`question`/, /aucune commande `git`/, /ni commit, ni push, ni branche/, /stash/, /alerte/, /aucun ticket pris ni modifié/, /--remplacer/, /importer-artifact/, /résumé court sur la sortie standard/, /fichiers modifiés/, /reste `nouveau`/])
			assert.match(veille, r, String(r));
		// § 0 « Mise en place » : installer --oui, montrer le code, jamais de jeton, ligne « vérifier sans écrire », exporteur, reprise sur demande.
		assert.match(methode, /^## 0\. Mise en place$/m);
		const zero = methode.slice(methode.indexOf("## 0. Mise en place"), methode.indexOf("## 1. Principes"));
		for (const r of [/outil installer --oui/, /[Mm]ontre d'abord ce code/, /relance la commande affichée/, /jamais de jeton/, /vérifier sans écrire/, /publier\.exporteur/, /importer-artifact <dossier> --autoriser/, /seulement si l'humain l'a demandé/])
			assert.match(zero, r, String(r));
		// La phrase de départ (8.4, point 1), mot pour mot : § 0, README racine, cli/README.md (l'aide : test de l'aide).
		const phrase = "Branche ce dépôt sur le serveur de retours <URL> (projet <P>) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : <URL>/outil).";
		assert.ok(zero.includes(phrase), "§ 0");
		for (const f of ["README.md", path.join("cli", "README.md")]) assert.ok(fs.readFileSync(path.join(RACINE, f), "utf8").includes(phrase), f);
		// Brancher ne passe plus par un jeton collé : outil connexion seulement pour un poste sans navigateur.
		assert.doesNotMatch(methode, /demande à l'humain de lancer `outil connexion`/);
		assert.doesNotMatch(methode, /l'humain lance `outil connexion --serveur/);
		for (const l of methode.split("\n").filter(x => x.includes("outil connexion") && !x.includes("Ce que tu ne fais pas"))) assert.match(l, /sans navigateur/, l);
		// La boucle cite outil publier ; importer-artifact --autoriser n'est plus interdit quand l'humain demande la reprise.
		const boucle = methode.slice(methode.indexOf("## 6. "), methode.indexOf("## 7. "));
		assert.match(boucle, /`outil publier`/);
		assert.doesNotMatch(methode, /`outil importer-artifact` \(migration faite par un mainteneur\) : tu ne t'en sers pas/);
	});

	test("METHODE.md et exporteurs.md : leçons de la répétition 3.6 (vérification lancée, deux formes de règle, autre pile dite, .uid hors commit)", () => {
		const methode = fs.readFileSync(path.join(RACINE, "methode", "METHODE.md"), "utf8");
		const exporteurs = fs.readFileSync(path.join(RACINE, "methode", "exporteurs.md"), "utf8");
		const zero = methode.slice(methode.indexOf("## 0. Mise en place"), methode.indexOf("## 1. Principes"));
		const quatre = methode.slice(methode.indexOf("## 4. Créer ou refaire le Wiki"), methode.indexOf("## 5. "));
		// Run A : ligne « vérifier sans écrire » remplie avec une commande Godot jamais lancée.
		assert.match(zero, /Seulement des commandes que tu as lancées et vues passer/);
		// Run B : `& "C:/…"` refusé par la règle PowerShell, chemin nu accepté par la règle Bash : les deux formes.
		assert.ok(zero.includes("`\"Bash(go test *)\" \"PowerShell(go test *)\"`"), "§ 0 : deux formes de règle");
		assert.ok(zero.includes("l'appel PowerShell `& \"C:/…/godot.exe\" …` n'est pas couvert par `\"PowerShell(C:/…/godot.exe *)\"`"), "§ 0 : forme & non couverte");
		assert.match(zero, /forme Bash, chemin nu[^\n]*`"Bash\(C:\/…\/godot\.exe \*\)"`/);
		// Run A : exporteur Node au lieu de Godot, sans le dire.
		assert.match(quatre, /autre pile que celle du projet[^\n]*compte rendu/);
		// Run B : l'import Godot crée des .uid non suivis, à ne pas commiter avec le Wiki.
		assert.match(quatre, /`\*\.uid` non suivis/);
		assert.match(exporteurs, /`\.uid` à côté de chaque script[^\n]*hors de la liste des fichiers à commiter/);
	});

	test("methode : affiche METHODE.md de l'outil, ou son chemin (--chemin), depuis n'importe quel dossier ; --json", async () => {
		const ailleurs = path.join(tmp, "ailleurs"); fs.mkdirSync(ailleurs, { recursive: true });
		const attendu = path.join(RACINE, "methode", "METHODE.md");
		const r = await lancer(env, ["methode"], { cwd: ailleurs });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trimEnd(), fs.readFileSync(attendu, "utf8").trimEnd());
		const c = await lancer(env, ["methode", "--chemin"], { cwd: ailleurs });
		assert.equal(c.code, 0); assert.equal(c.stdout.trim(), attendu);
		const j = await lancer(env, ["methode", "--json"], { cwd: ailleurs });
		assert.equal(j.json.chemin, attendu); assert.match(j.json.texte, /^# Méthode/);
		assert.deepEqual((await lancer(env, ["methode", "--chemin", "--json"], { cwd: ailleurs })).json, { chemin: attendu });
		assert.equal((await lancer(env, ["methode", "x"], { cwd: ailleurs })).code, 2);
		// L'aide liste les commandes de l'étape 3.5.
		const aide = await lancer(env, ["aide"], { cwd: ailleurs });
		for (const x of ["outil brancher", "outil publier", "outil methode", "--autoriser"]) assert.ok(aide.stdout.includes(x), x);
	});
});
