// Étape 3.5, CLI : « outil installer » (docs/etape3-5-prise-en-main.md § 3), contre un vrai serveur de test, dans des
// dépôts Git temporaires. Deux temps sans terminal (rien d'écrit avant le jeton, puis --oui attend le clic et
// continue) ; idempotence (relancée : rien ne change) ; AGENTS.md absent, présent sans bloc, présent avec un bloc
// ancien (ligne « vérifier sans écrire » remplie gardée, CRLF gardé) ; CLAUDE.md et raccourci ; sans terminal et sans
// --oui (sauté et listé) ; questions O/N dans un terminal (simulé) ; refus hors Git et du dépôt de l'outil ; ancien
// tools/site-retours avec un faux export.mjs (réussite, puis échec rapporté, clé gardée) ; .outil.json complété sans
// perdre de clé ; aucune opération Git d'écriture ; aucun jeton dans les sorties ni dans les fichiers du dépôt.
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { RACINE, environnement, lancer, fichierJetons, lireJson, urlsOuvertes, dossierInstallation } from "./aide-cli.ts";
import { principal } from "../outil.ts";
import { typeProjet } from "../installer.ts";

const EXEMPLES = path.join(RACINE, "site", "examples");
const GABARIT = fs.readFileSync(path.join(RACINE, "methode", "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
const SKILL = fs.readFileSync(path.join(RACINE, "methode", "integrations", "claude", "SKILL.md"), "utf8");
const DEBUT = "<!-- outil:debut -->", FIN = "<!-- outil:fin -->";
const BLOC = GABARIT.slice(GABARIT.indexOf(DEBUT), GABARIT.indexOf(FIN) + FIN.length);

// Faux exporteur de l'ancien site (convention du skill site-retours : --out=<data.json>) ; FAUX_EXPORT=echec : sortie 2.
const EXPORTEUR = `
import fs from "node:fs";
const out = (process.argv.find(a => a.startsWith("--out=")) || "").slice(6);
if (process.env.FAUX_EXPORT === "echec") { console.error("boom : sorte inconnue « x »"); process.exit(2); }
const data = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(EXEMPLES, "data.json"))}, "utf8"));
fs.writeFileSync(out, JSON.stringify(data));
`;

const git = (d: string, ...a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

describe("CLI outil : installer", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, maud: string, adm: string;
	let n = 0;
	before(async () => {
		tmp = dossierTemp("cli-installer");
		env = environnement(tmp);
		s = await serveurTest(path.join(tmp, "donnees"), { intervalleAppairageMs: 100 });
		u = s.url;
		for (const p of ["jardin", "verger", "potager", "rucher", "serre", "ruisseau", "liens", "noyer", "pommier", "prunier", "cerisier", "tilleul"]) await projet(u, p);
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		adm = await session(u, "jardin", "adm", "admin", "Adm");
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	// Un dépôt Git neuf, avec un commit (l'état de Git est comparé avant et après).
	const depot = (fichiers: Record<string, string> = {}) => {
		const d = path.join(tmp, `code-${++n}`);
		fs.mkdirSync(d, { recursive: true });
		git(d, "init", "-q");
		git(d, "config", "user.email", "t@exemple.fr"); git(d, "config", "user.name", "Test");
		for (const [f, c] of Object.entries({ "LISEZMOI.md": "projet\n", ...fichiers })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
		git(d, "add", "-A"); git(d, "commit", "-q", "-m", "départ");
		fs.rmSync(env.OUTIL_TEST_NAVIGATEUR, { force: true });
		return d;
	};
	const etatGit = (d: string) => git(d, "rev-parse", "HEAD") + git(d, "ls-files", "-s") + fs.readdirSync(path.join(d, ".git", "refs", "heads")).join(",");
	const outil = (args: string[], cwd: string, extra?: Record<string, string>) => lancer(env, args, { cwd, env: extra });
	const lire = (d: string, f: string) => fs.readFileSync(path.join(d, f), "utf8");
	const existe = (d: string, f: string) => fs.existsSync(path.join(d, f));
	// Jeton agent enregistré pour <projet> (comme après un appairage), pour les cas qui ne testent pas la connexion.
	const enregistrer = async (p: string) => {
		const j = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: p, nom: "Agent " + p } })).corps.jeton;
		const f = fichierJetons(env);
		const tous = lireJson(f) || {};
		(tous[u] ??= {})[p] = j;
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, JSON.stringify(tous));
		return j as string;
	};
	const sansJeton = (r: { stdout: string; stderr: string }) => assert.ok(!/wdd_[A-Za-z0-9_-]{16,}/.test(r.stdout + r.stderr), "un jeton apparaît dans la sortie");
	const sansJetonDepot = (d: string) => {
		for (const f of git(d, "ls-files", "-o", "-m", "--exclude-standard").split("\n").filter(Boolean)) assert.ok(!/wdd_/.test(lire(d, f)), `jeton dans ${f}`);
	};

	test("type de projet : la racine d'abord, puis deux niveaux de sous-dossiers (godot/project.godot), sans dossier caché ni node_modules", () => {
		const arbre = (nom: string, fichiers: string[]) => {
			const d = path.join(tmp, "type-" + nom);
			for (const f of fichiers) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), ""); }
			fs.mkdirSync(d, { recursive: true });
			return d;
		};
		assert.equal(typeProjet(arbre("vide", [])), "autre");
		assert.equal(typeProjet(arbre("racine", ["project.godot"])), "godot");
		assert.equal(typeProjet(arbre("sous-dossier", ["serveur/go.mod", "godot/project.godot"])), "godot", "projet Godot dans godot/ (cas de la répétition)");
		assert.equal(typeProjet(arbre("unity", ["client/unity/ProjectSettings/ProjectVersion.txt"])), "unity");
		assert.equal(typeProjet(arbre("trois-niveaux", ["a/b/c/project.godot"])), "autre", "repère à trois niveaux : hors de portée");
		assert.equal(typeProjet(arbre("deux-niveaux-godot", ["jeu/client/project.godot"])), "godot");
		assert.equal(typeProjet(arbre("racine-prioritaire", ["package.json", "godot/project.godot"])), "node", "la racine l'emporte");
		assert.equal(typeProjet(arbre("niveau-prioritaire", ["godot/project.godot", "tools/site-retours/package.json"])), "godot", "le premier niveau l'emporte sur le second");
		assert.equal(typeProjet(arbre("ignores", ["node_modules/x/package.json", ".cache/project.godot"])), "autre");
	});

	test("hors d'un dépôt Git : 1 ; dans le dépôt de l'outil : 1 ; rien n'est écrit", async () => {
		const hors = path.join(tmp, "hors-git");
		fs.mkdirSync(hors, { recursive: true });
		const r1 = await outil(["installer", "--serveur", u, "--projet", "jardin", "--json"], hors);
		assert.equal(r1.code, 1, r1.stderr); assert.match(r1.json.erreur.message, /pas dans un dépôt Git/);
		assert.match(r1.json.erreur.message, /documents de design seuls[^\n]*git init, avec l'accord de l'humain/);
		assert.deepEqual(fs.readdirSync(hors), []);
		const d = depot({ "serveur/src/principal.ts": "// faux\n", "methode/METHODE.md": "# faux\n" });
		const avant = etatGit(d);
		const r2 = await outil(["installer", "--serveur", u, "--projet", "jardin", "--oui", "--json"], path.join(d, "serveur"));
		assert.equal(r2.code, 1, r2.stderr); assert.match(r2.json.erreur.message, /dépôt de l'outil lui-même/);
		assert.ok(!existe(d, "AGENTS.md") && !existe(d, ".outil.json"));
		assert.equal(etatGit(d), avant);
		assert.deepEqual(urlsOuvertes(env), [], "aucun appairage demandé");
	});

	test("deux temps sans terminal, ancien site, CLAUDE.md : code d'abord (rien d'écrit), puis --oui attend le clic, écrit, publie ; relancée : rien ne change", async () => {
		const d = depot({ "CLAUDE.md": "# Consignes\n\nNe pas toucher à data/.\n", "project.godot": "", "tools/site-retours/export.mjs": EXPORTEUR,
			"tools/site-retours/notes_2026-11-12.json": fs.readFileSync(path.join(EXEMPLES, "notes_exemple.json"), "utf8") });
		const avantGit = etatGit(d);
		// Premier temps, lancé d'un sous-dossier : le code, rien d'autre.
		fs.mkdirSync(path.join(d, "src"));
		const r1 = await outil(["installer", "--serveur", u, "--projet", "jardin", "--json"], path.join(d, "src"));
		assert.equal(r1.code, 0, r1.stderr);
		assert.equal(r1.json.etat, "attente"); assert.match(r1.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/); assert.equal(r1.json.relance, `outil installer --serveur ${u} --projet jardin --oui`);
		assert.equal(r1.json.depot, fs.realpathSync.native(d));
		assert.ok(r1.stderr.includes(`Ouvre ${u}/appairage?code=${r1.json.code}`), r1.stderr);
		assert.deepEqual(urlsOuvertes(env), [r1.json.url]);
		for (const f of ["AGENTS.md", ".outil.json", ".claude", "src/.outil.json"]) assert.ok(!existe(d, f), `${f} écrit avant le jeton`);
		assert.equal(lire(d, "CLAUDE.md"), "# Consignes\n\nNe pas toucher à data/.\n");
		// Le clic, puis la relance sans --serveur ni --projet (comme l'agent) : elle reprend l'appairage en cours.
		assert.equal((await appel(u, `/api/appairage/${r1.json.code}/autoriser`, { cookie: maud, corps: { projet: "jardin", role: "agent" } })).status, 204);
		const r2 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr + r2.stdout);
		const x = r2.json;
		assert.equal(x.etat, "installe"); assert.equal(x.type, "godot"); assert.equal(x.serveur, u); assert.equal(x.projet, "jardin");
		assert.equal(x.connexion.etat, "branche"); assert.equal(x.connexion.pour.id, "maud");
		assert.equal(x.page, `${u}/p/jardin/`);
		const action = (f: string) => x.fichiers.find((y: any) => y.fichier === f)?.action;
		assert.equal(action("AGENTS.md"), "cree"); assert.equal(action("CLAUDE.md"), "ajoute"); assert.equal(action(".claude/skills/site-retours-outil/SKILL.md"), "cree");
		assert.equal(action(".outil.json"), "cree");
		// AGENTS.md : le bloc du gabarit ; CLAUDE.md : contenu gardé, bloc @AGENTS.md ajouté à la fin ; raccourci copié.
		assert.equal(lire(d, "AGENTS.md"), BLOC + "\n");
		assert.equal(lire(d, "CLAUDE.md"), `# Consignes\n\nNe pas toucher à data/.\n\n${DEBUT}\n@AGENTS.md\n${FIN}\n`);
		assert.equal(lire(d, ".claude/skills/site-retours-outil/SKILL.md"), SKILL.replace(/\r\n/g, "\n"));
		// .outil.json : serveur, projet et publier de l'ancien site ; jamais de jeton.
		assert.deepEqual(lireJson(path.join(d, ".outil.json")), { serveur: u, projet: "jardin",
			publier: { exporteur: ["node", "tools/site-retours/export.mjs", "--out={data}"], notes: "tools/site-retours" } });
		// Première publication avec les anciennes notes.
		assert.equal(x.publication.etat, "publie"); assert.ok(x.publication.build >= 1);
		assert.match(x.publication.resume, /notes : 1 fichier/);
		assert.ok((await appel(u, "/api/p/jardin/notes/notes_2026-11-12.json", { cookie: maud })).corps.title, "ancienne note envoyée");
		// Résumé : fichiers à commiter (vus par Git), à faire, veille Claude ; message de l'ancien site.
		assert.deepEqual([...x.aCommiter].sort(), [".claude/skills/site-retours-outil/SKILL.md", ".outil.json", "AGENTS.md", "CLAUDE.md"]);
		assert.ok(x.aFaire.some((a: string) => /vérifier sans écrire/.test(a)));
		assert.ok(x.aFaire.some((a: string) => /reprends les retours de l'ancien site claude\.ai/.test(a)));
		assert.ok(!x.aFaire.some((a: string) => /écrire l'exporteur/.test(a)));
		assert.match(x.veille, /^outil veille --memoriser -- claude -p /);
		assert.match(x.veille, /--disallowedTools "Bash\(git \*\)" "PowerShell\(git \*\)" Artifact ArtifactData$/, "aucune commande git, par Bash comme par PowerShell");
		assert.match(x.veilleVerifier, /ligne « vérifier sans écrire » d'AGENTS\.md/, "le résumé dit d'ajouter les commandes de test à la liste blanche");
		assert.match(r2.stderr, /ancien site de retours trouvé/);
		// Aucune opération Git : HEAD, index et branches inchangés.
		assert.equal(etatGit(d), avantGit);
		sansJeton(r1); sansJeton(r2); sansJetonDepot(d);
		// Relancée (sans --oui, sans terminal) : déjà fait, rien ne change, pas de nouvelle publication.
		const avant = Object.fromEntries(["AGENTS.md", "CLAUDE.md", ".outil.json", ".claude/skills/site-retours-outil/SKILL.md"].map(f => [f, lire(d, f)]));
		const builds = (await appel(u, "/api/p/jardin/builds", { cookie: maud })).corps.dernier.build;
		const r3 = await outil(["installer", "--json"], d);
		assert.equal(r3.code, 0, r3.stderr);
		assert.equal(r3.json.connexion.etat, "deja");
		assert.ok(r3.json.fichiers.every((f: any) => f.action === "inchange"), JSON.stringify(r3.json.fichiers));
		assert.equal(r3.json.publication.etat, "deja"); assert.equal(r3.json.publication.build, builds);
		assert.equal((await appel(u, "/api/p/jardin/builds", { cookie: maud })).corps.dernier.build, builds, "pas de nouveau build");
		for (const [f, c] of Object.entries(avant)) assert.equal(lire(d, f), c, `${f} modifié par la relance`);
		assert.equal(urlsOuvertes(env).length, 1, "pas de nouvel appairage");
		// Texte lisible.
		const r4 = await outil(["installer"], d);
		assert.equal(r4.code, 0);
		assert.match(r4.stdout, /connexion : déjà faite/); assert.match(r4.stdout, /AGENTS\.md : déjà à jour/); assert.match(r4.stdout, /à commiter : .*AGENTS\.md/);
		assert.match(r4.stdout, /aucune opération Git/); assert.match(r4.stdout, /outil veille --memoriser -- claude/);
	});

	test("AGENTS.md présent sans bloc : sans terminal ni --oui, sauté et listé ; avec --oui, ajouté à la fin (contenu gardé, CRLF et BOM gardés)", async () => {
		await enregistrer("potager");
		const propre = "\uFEFF# Agents\r\n\r\nRègle maison : tests avant tout.\r\n";
		const d = depot({ "AGENTS.md": propre, ".outil.json": JSON.stringify({ serveur: u, projet: "potager", equipe: "bleue" }) });
		const r1 = await outil(["installer", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr);
		const f1 = r1.json.fichiers.find((f: any) => f.fichier === "AGENTS.md");
		assert.equal(f1.action, "saute"); assert.match(f1.detail, /sans terminal ni --oui/);
		assert.ok(r1.json.aFaire.some((a: string) => /AGENTS\.md : modification sautée : relancer avec --oui/.test(a)), JSON.stringify(r1.json.aFaire));
		assert.equal(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8"), propre, "fichier existant non touché");
		// Clé inconnue : avertissement, gardée ; pas d'exporteur : renvoi à la méthode.
		assert.ok(r1.json.avertissements.some((a: string) => /clé inconnue « equipe », gardée/.test(a)));
		assert.equal(r1.json.publication.etat, "sans_exporteur");
		assert.ok(r1.json.aFaire.some((a: string) => /écrire l'exporteur du projet \(autre\) : METHODE\.md § 4/.test(a)));
		assert.equal(r1.json.connexion.etat, "deja");
		// Pas de Claude Code ici : ni CLAUDE.md ni raccourci.
		assert.ok(!existe(d, "CLAUDE.md") && !existe(d, ".claude"));
		assert.match(r1.json.veille, /<commande de ton agent>/);
		const r2 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr);
		assert.equal(r2.json.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "ajoute");
		const t = fs.readFileSync(path.join(d, "AGENTS.md"), "utf8");
		assert.equal(t, propre + "\r\n" + BLOC.replace(/\n/g, "\r\n") + "\r\n");
		assert.deepEqual(lireJson(path.join(d, ".outil.json")), { serveur: u, projet: "potager", equipe: "bleue" }, "clé inconnue gardée, rien d'ajouté");
		// Relancée : inchangé malgré le CRLF.
		const r3 = await outil(["installer", "--json"], d);
		assert.equal(r3.json.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "inchange");
		assert.equal(fs.readFileSync(path.join(d, "AGENTS.md"), "utf8"), t);
	});

	test("AGENTS.md avec un bloc ancien : remplacé, la ligne « vérifier sans écrire » remplie gardée ; le texte hors du bloc gardé ; bloc mal formé : non touché", async () => {
		await enregistrer("rucher");
		const ancien = `# Projet\n\nAvant.\n\n${DEBUT}\n## Ancien bloc\n- vérifier sans écrire dans les données : \`npm test -- --dry\`\n${FIN}\n\nAprès.\n`;
		const d = depot({ "AGENTS.md": ancien, ".outil.json": JSON.stringify({ serveur: u, projet: "rucher" }), "package.json": "{}" });
		const r = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.type, "node");
		assert.equal(r.json.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "remplace");
		const t = lire(d, "AGENTS.md");
		assert.ok(t.startsWith("# Projet\n\nAvant.\n\n" + DEBUT) && t.endsWith(FIN + "\n\nAprès.\n"), t);
		assert.ok(t.includes("- vérifier sans écrire dans les données : `npm test -- --dry`"), "ligne remplie gardée");
		assert.ok(!t.includes("<à compléter par l'agent"));
		assert.ok(t.includes("`outil methode`") && !t.includes("Ancien bloc"));
		assert.ok(!r.json.aFaire.some((a: string) => /vérifier sans écrire/.test(a)), "ligne déjà remplie : rien à faire");
		// Idempotent : la ligne gardée ne fait pas « différer » le bloc.
		const r2 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r2.json.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "inchange");
		assert.equal(lire(d, "AGENTS.md"), t);
		// Bloc mal formé (début sans fin) : non touché, signalé.
		fs.writeFileSync(path.join(d, "AGENTS.md"), `# Projet\n${DEBUT}\nreste\n`);
		const r3 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r3.code, 0);
		assert.equal(r3.json.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "mal-forme");
		assert.equal(lire(d, "AGENTS.md"), `# Projet\n${DEBUT}\nreste\n`);
		assert.ok(r3.json.aFaire.some((a: string) => /mal formé/.test(a)));
	});

	test("dans un terminal : question O/N avant chaque modification d'un fichier existant (n : sauté ; Entrée : oui) ; créer ne demande rien ; --agent claude", async () => {
		await enregistrer("serre");
		const d = depot({ "AGENTS.md": "# Agents\n", ".outil.json": JSON.stringify({ serveur: u, projet: "serre" }) });
		const questions: string[] = [];
		const reponses = ["n"]; // AGENTS.md : non ; ensuite Entrée (oui par défaut)
		const lu = { stdout: "", stderr: "" };
		const code = await principal(["installer", "--agent", "claude", "--sans-publier", "--json"], {
			env, cwd: d, terminal: true, stdout: x => { lu.stdout += x + "\n"; }, stderr: x => { lu.stderr += x + "\n"; }, lireEntree: async () => "",
			question: async (q: string) => { questions.push(q); return reponses.shift() ?? ""; },
		});
		assert.equal(code, 0, lu.stderr);
		const j = JSON.parse(lu.stdout);
		assert.deepEqual(questions.map(q => q.split(" : ")[0]), ["AGENTS.md"], "une question, pour le seul fichier existant modifié");
		assert.match(questions[0], /\? \[O\/n\] $/);
		assert.equal(j.fichiers.find((f: any) => f.fichier === "AGENTS.md").action, "saute");
		assert.equal(lire(d, "AGENTS.md"), "# Agents\n");
		// CLAUDE.md et le raccourci n'existaient pas : créés sans question.
		assert.equal(lire(d, "CLAUDE.md"), `${DEBUT}\n@AGENTS.md\n${FIN}\n`);
		assert.ok(existe(d, ".claude/skills/site-retours-outil/SKILL.md"));
		assert.equal(j.publication.etat, "saute");
		// Le raccourci modifié à la main, CLAUDE.md avec un bloc différent : deux questions, Entrée = oui.
		fs.writeFileSync(path.join(d, ".claude/skills/site-retours-outil/SKILL.md"), "vieux\n");
		fs.writeFileSync(path.join(d, "CLAUDE.md"), `${DEBUT}\n@VIEUX.md\n${FIN}\n`);
		questions.length = 0; lu.stdout = "";
		assert.equal(await principal(["installer", "--sans-publier", "--json"], {
			env, cwd: d, terminal: true, stdout: x => { lu.stdout += x + "\n"; }, stderr: () => { }, lireEntree: async () => "",
			question: async (q: string) => { questions.push(q); return q.startsWith("AGENTS.md") ? "non" : ""; },
		}), 0);
		assert.deepEqual(questions.map(q => q.split(" : ")[0]).sort(), [".claude/skills/site-retours-outil/SKILL.md", "AGENTS.md", "CLAUDE.md"]);
		assert.equal(lire(d, "CLAUDE.md"), `${DEBUT}\n@AGENTS.md\n${FIN}\n`);
		assert.equal(lire(d, ".claude/skills/site-retours-outil/SKILL.md"), SKILL.replace(/\r\n/g, "\n"));
		// --agent inconnu : usage.
		const r = await outil(["installer", "--agent", "copilot", "--json"], d);
		assert.equal(r.code, 2);
	});

	test("ancien exporteur qui échoue : publication rapportée en échec (1), résumé complet, clé publier.exporteur gardée", async () => {
		await enregistrer("verger");
		const d = depot({ ".outil.json": JSON.stringify({ serveur: u, projet: "verger", publier: { notes: "ailleurs" } }), "tools/site-retours/export.mjs": EXPORTEUR });
		fs.mkdirSync(path.join(d, "ailleurs"));
		const r = await outil(["installer", "--oui", "--json"], d, { FAUX_EXPORT: "echec" });
		assert.equal(r.code, 1, r.stderr);
		assert.equal(r.json.etat, "installe", "le résumé reste sur stdout");
		assert.equal(r.json.publication.etat, "echec"); assert.equal(r.json.publication.code, "exporteur_echec");
		assert.match(r.json.publication.message, /boom : sorte inconnue/);
		assert.ok(r.json.aFaire.some((a: string) => /corriger l'exporteur/.test(a)));
		// Clé existante gardée (notes), exporteur ajouté et gardé après l'échec.
		assert.deepEqual(lireJson(path.join(d, ".outil.json")).publier, { notes: "ailleurs", exporteur: ["node", "tools/site-retours/export.mjs", "--out={data}"] });
		assert.equal(r.json.fichiers.find((f: any) => f.fichier === ".outil.json").action, "complete");
		// Corrigé (ici : l'exporteur réussit) : relancée, elle publie.
		const r2 = await outil(["installer", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr); assert.equal(r2.json.publication.etat, "publie");
		sansJeton(r); sansJeton(r2);
	});

	test("OUTIL_JETON refusé par le serveur au moment de publier : échec rapporté (1), fichiers écrits, résumé complet", async () => {
		await enregistrer("ruisseau");
		const d = depot({ ".outil.json": JSON.stringify({ serveur: u, projet: "ruisseau" }), "tools/site-retours/export.mjs": EXPORTEUR });
		const faux = "wdd_" + "Xy7".repeat(12);
		const r = await outil(["installer", "--oui", "--json"], d, { OUTIL_JETON: faux });
		assert.equal(r.code, 1, r.stderr);
		assert.equal(r.json.etat, "installe"); assert.equal(r.json.connexion.etat, "deja");
		assert.equal(r.json.publication.etat, "echec"); assert.match(r.json.publication.message, /^401 /);
		assert.ok(existe(d, "AGENTS.md")); assert.ok(r.json.aCommiter.includes("AGENTS.md"));
		assert.ok(!(r.stdout + r.stderr).includes(faux)); sansJeton(r);
	});

	test("relance après expiration du code, sans --serveur : un nouveau code sur le même serveur et le même projet", async () => {
		const d = depot(); // projet sans jeton enregistré (l'appairage ne vérifie pas son existence)
		const r1 = await outil(["installer", "--serveur", u, "--projet", "etang", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.etat, "attente");
		// Le code a expiré entre-temps (date reculée dans appairages.json).
		const f = path.join(path.dirname(fichierJetons(env)), "appairages.json");
		const a = lireJson(f);
		a[u].etang.permanent.expire = new Date(Date.now() - 1000).toISOString();
		fs.writeFileSync(f, JSON.stringify(a));
		const r2 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr + r2.stdout);
		assert.equal(r2.json.etat, "attente"); assert.notEqual(r2.json.code, r1.json.code);
		assert.equal(r2.json.url, `${u}/appairage?code=${r2.json.code}`);
		assert.match(r2.stderr, /l'appairage en cours a expiré : nouveau code/);
		assert.match(r2.stderr, /projet etang/);
		assert.equal(lireJson(f)[u].etang.permanent.code, r2.json.code);
		assert.ok(!existe(d, "AGENTS.md") && !existe(d, ".outil.json"));
		// Ménage : refuser ce code (l'appairage ne reste pas en attente pour les autres tests).
		assert.equal((await appel(u, `/api/appairage/${r2.json.code}/refuser`, { cookie: maud, methode: "POST" })).status, 204);
	});

	// --- Relecture du lot CLI -------------------------------------------------------------------------------------------
	const autoriserCode = (code: string, p: string) => appel(u, `/api/appairage/${code}/autoriser`, { cookie: adm, corps: { projet: p, role: "agent" } });
	const installation = (url: string) => {
		fs.mkdirSync(dossierInstallation(env), { recursive: true });
		fs.writeFileSync(path.join(dossierInstallation(env), "installation.json"), JSON.stringify({ outil: "C:/outil", donnees: "C:/donnees", port: 1, url }));
	};
	const sansInstallation = () => fs.rmSync(dossierInstallation(env), { recursive: true, force: true });
	// La relance affichée, découpée en arguments (aucune valeur n'y a d'espace dans ces essais).
	const args = (relance: string) => { assert.match(relance, /^outil installer /); return relance.split(" ").slice(1); };

	test("liens symboliques et jonctions : jamais suivis ; .claude jonction, AGENTS.md lien (pendant ou non) refusés et listés ; .outil.json lien : refus avant tout appairage", async () => {
		await enregistrer("liens");
		const dehors = path.join(tmp, "dehors");
		fs.mkdirSync(dehors, { recursive: true });
		// 1. .claude est une jonction vers un dossier extérieur.
		const d = depot({ ".outil.json": JSON.stringify({ serveur: u, projet: "liens" }) });
		fs.symlinkSync(dehors, path.join(d, ".claude"), "junction");
		const r = await outil(["installer", "--sans-publier", "--oui", "--json"], d);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(fs.readdirSync(dehors), [], "écrit hors du dépôt par la jonction .claude");
		const f = r.json.fichiers.find((x: any) => x.fichier === ".claude/skills/site-retours-outil/SKILL.md");
		assert.equal(f.action, "refuse"); assert.match(f.detail, /lien symbolique ou une jonction/);
		assert.ok(r.json.aFaire.some((a: string) => /\.claude.*lien symbolique ou une jonction/.test(a)), JSON.stringify(r.json.aFaire));
		// 2. AGENTS.md lien vers un fichier extérieur, existant (avec --oui) puis pendant (sans --oui) : jamais écrit.
		const ext = path.join(dehors, "bashrc");
		const d2 = depot({ ".outil.json": JSON.stringify({ serveur: u, projet: "liens" }) });
		fs.writeFileSync(ext, "# fichier de l'utilisateur\n");
		try { fs.symlinkSync(ext, path.join(d2, "AGENTS.md"), "file"); } catch { return; } // liens symboliques interdits sur ce poste
		const r2 = await outil(["installer", "--sans-publier", "--oui", "--json"], d2);
		assert.equal(r2.code, 0, r2.stderr);
		assert.equal(fs.readFileSync(ext, "utf8"), "# fichier de l'utilisateur\n", "fichier extérieur modifié par le lien AGENTS.md");
		assert.equal(r2.json.fichiers.find((x: any) => x.fichier === "AGENTS.md").action, "refuse");
		const absent = path.join(dehors, "absent.md");
		fs.rmSync(path.join(d2, "AGENTS.md"));
		fs.symlinkSync(absent, path.join(d2, "AGENTS.md"), "file");
		const r3 = await outil(["installer", "--sans-publier", "--json"], d2);
		assert.equal(r3.code, 0, r3.stderr);
		assert.ok(!fs.existsSync(absent), "fichier extérieur créé par un lien pendant");
		// 3. .outil.json lien : refus avant tout appairage (aucun code demandé).
		const d3 = depot();
		fs.writeFileSync(path.join(dehors, "config.json"), JSON.stringify({ serveur: u, projet: "liens" }));
		fs.symlinkSync(path.join(dehors, "config.json"), path.join(d3, ".outil.json"), "file");
		const a0 = urlsOuvertes(env).length;
		const r4 = await outil(["installer", "--serveur", u, "--json"], d3);
		assert.equal(r4.code, 1, r4.stderr); assert.match(r4.json.erreur.message, /lien symbolique ou une jonction/);
		assert.equal(urlsOuvertes(env).length, a0, "appairage demandé malgré le lien");
	});

	test(".outil.json existant sans projet : complété seulement avec --oui (sauté sans), BOM et CRLF gardés ; la relance citée ne redemande pas de clic", async () => {
		const brut = "\uFEFF{\r\n  \"serveur\": \"" + u + "\"\r\n}\r\n";
		const d = depot({ ".outil.json": brut });
		const r1 = await outil(["installer", "--projet", "noyer", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.etat, "attente");
		assert.equal((await autoriserCode(r1.json.code, "noyer")).status, 204);
		const r2 = await outil(["installer", "--projet", "noyer", "--json"], d);
		assert.equal(r2.code, 0, r2.stderr + r2.stdout);
		assert.equal(r2.json.connexion.etat, "branche");
		assert.equal(fs.readFileSync(path.join(d, ".outil.json"), "utf8"), brut, ".outil.json modifié sans question ni --oui");
		assert.equal(r2.json.fichiers.find((x: any) => x.fichier === ".outil.json").action, "saute");
		assert.equal(r2.json.publication.etat, "saute", "publication tentée avec un .outil.json sans projet");
		const a = r2.json.aFaire.find((x: string) => /^\.outil\.json : modification sautée/.test(x));
		const relance = /« (outil installer [^»]+) »/.exec(a)![1];
		assert.match(relance, /--projet noyer/); assert.match(relance, /--oui$/);
		const r3 = await outil([...args(relance), "--json"], d);
		assert.equal(r3.code, 0, r3.stderr);
		assert.equal(r3.json.connexion.etat, "deja", "un second clic demandé");
		const apres = fs.readFileSync(path.join(d, ".outil.json"), "utf8");
		assert.ok(apres.startsWith("\uFEFF") && apres.includes("\r\n"), "BOM ou CRLF perdu");
		assert.deepEqual(JSON.parse(apres.slice(1)), { serveur: u, projet: "noyer" });
	});

	test("relance sans --serveur : l'appairage en cours l'emporte sur installation.json (autre serveur)", async () => {
		installation("http://127.0.0.1:1");
		try {
			const d = depot();
			const r1 = await outil(["installer", "--serveur", u, "--projet", "pommier", "--oui", "--json"], d);
			assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.etat, "attente");
			assert.equal((await autoriserCode(r1.json.code, "pommier")).status, 204);
			const r2 = await outil(["installer", "--oui", "--json"], d);
			assert.equal(r2.code, 0, r2.stderr + r2.stdout);
			assert.equal(r2.json.etat, "installe"); assert.equal(r2.json.serveur, u); assert.equal(r2.json.projet, "pommier");
		} finally { sansInstallation(); }
	});

	test("relance : la commande affichée reprend --projet, --agent claude, --sans-publier ; « --oui » seul reprend l'appairage gardé quel que soit son projet (pas de second code)", async () => {
		installation(u);
		try {
			// 1. La relance affichée garde les options du premier appel.
			const d = depot();
			const r1 = await outil(["installer", "--projet", "prunier", "--agent", "claude", "--sans-publier", "--oui", "--json"], d);
			assert.equal(r1.code, 0, r1.stderr); assert.equal(r1.json.etat, "attente");
			assert.equal(r1.json.relance, `outil installer --serveur ${u} --projet prunier --agent claude --sans-publier --oui`);
			assert.ok(r1.stderr.includes(`Relance après le clic : ${r1.json.relance}`), r1.stderr);
			assert.ok(!r1.stderr.includes("--attendre"), "message qui cite --attendre alors que la relance est --oui");
			assert.equal((await autoriserCode(r1.json.code, "prunier")).status, 204);
			const r2 = await outil([...args(r1.json.relance), "--json"], d);
			assert.equal(r2.code, 0, r2.stderr + r2.stdout);
			assert.equal(r2.json.etat, "installe"); assert.equal(r2.json.projet, "prunier");
			assert.ok(existe(d, ".claude/skills/site-retours-outil/SKILL.md") && existe(d, "CLAUDE.md"), "raccourci Claude oublié");
			assert.equal(r2.json.publication.etat, "saute", "--sans-publier oublié");
			assert.match(r2.json.veille, /claude -p/);
			// 2. « outil installer --oui » seul, après un premier appel avec --projet : même appairage, pas de nouveau code.
			const d2 = depot();
			const a1 = await outil(["installer", "--projet", "cerisier", "--oui", "--json"], d2);
			assert.equal(a1.json.etat, "attente");
			const ouverts = urlsOuvertes(env).length;
			assert.equal((await autoriserCode(a1.json.code, "cerisier")).status, 204);
			const a2 = await outil(["installer", "--oui", "--json"], d2);
			assert.equal(a2.code, 0, a2.stderr + a2.stdout);
			assert.equal(a2.json.etat, "installe", "nouveau code au lieu de reprendre l'appairage"); assert.equal(a2.json.projet, "cerisier");
			assert.equal(urlsOuvertes(env).length, ouverts, "navigateur rouvert");
		} finally { sansInstallation(); }
	});

	test("un appairage en attente d'un autre dépôt n'est jamais repris : un premier appel ailleurs a son propre code", async () => {
		const a = depot(), b = depot();
		const ra = await outil(["installer", "--serveur", u, "--projet", "mare", "--json"], a); // projet sans jeton enregistré
		assert.equal(ra.code, 0, ra.stderr); assert.equal(ra.json.etat, "attente");
		const t0 = Date.now();
		const rb = await outil(["installer", "--serveur", u, "--json"], b);
		assert.equal(rb.code, 0, rb.stderr); assert.equal(rb.json.etat, "attente");
		assert.notEqual(rb.json.code, ra.json.code, "le code d'un autre dépôt est repris");
		assert.doesNotMatch(rb.json.relance, /--projet/);
		assert.ok(Date.now() - t0 < 30000, "attente sur le code d'un autre dépôt");
		// Ménage.
		for (const c of [ra.json.code, rb.json.code]) assert.equal((await appel(u, `/api/appairage/${c}/refuser`, { cookie: adm, methode: "POST" })).status, 204);
		for (const d of [a, b]) assert.equal((await outil(["installer", "--oui", "--json"], d)).code, 4);
	});

	test("refus, puis projet autorisé différent : la relance citée porte --serveur et --projet, et elle marche", async () => {
		const d = depot();
		const r1 = await outil(["installer", "--serveur", u, "--projet", "tilleul", "--json"], d);
		assert.equal(r1.code, 0, r1.stderr);
		assert.equal((await appel(u, `/api/appairage/${r1.json.code}/refuser`, { cookie: adm, methode: "POST" })).status, 204);
		const r2 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r2.code, 4, r2.stderr);
		const relance = `outil installer --serveur ${u} --projet tilleul --oui`;
		assert.ok(r2.json.erreur.message.includes(relance), r2.json.erreur.message);
		const r3 = await outil([...args(relance), "--json"], d);
		assert.equal(r3.code, 0, r3.stderr); assert.equal(r3.json.etat, "attente");
		assert.equal((await autoriserCode(r3.json.code, "verger")).status, 204);
		const r4 = await outil(["installer", "--oui", "--json"], d);
		assert.equal(r4.code, 1, r4.stderr);
		assert.ok(r4.json.erreur.message.includes(`(« ${relance} »)`), r4.json.erreur.message);
	});
});
