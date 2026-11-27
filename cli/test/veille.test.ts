// Étape 3.5, CLI : « outil veille » (docs/etape3-5-prise-en-main.md § 5.3), contre un vrai serveur de test, avec un
// faux agent en Node. Succès (terminee, journal final avec les deux sorties), échec (echouee, code de sortie), annulation pendant l'exécution (arbre de
// processus arrêté, petit-enfant compris), délai (--delai-max), Ctrl+C (signal d'arrêt du contexte), masquage des
// wdd_… par la CLI (marque propre, distincte de celle du serveur), --memoriser (veille.json, jamais .outil.json),
// refus d'un jeton mainteneur (4), commande absente (2, exemple Claude), --json après « -- » laissé à l'agent ;
// environnement de l'agent : OUTIL_DEMANDE, aucun jeton ajouté. Windows seulement : un faux .cmd trouvé par
// PATH/PATHEXT reçoit ses arguments intacts (ceux de l'exemple Claude), un argument avec & est refusé. Dépôt Git changé
// pendant le traitement (faux agent qui commite, change de branche, met de côté, ou commite puis fait reset --hard) :
// alerte en tête du résumé, raison, ligne de la veille ; agent qui ne change rien : pas d'alerte. Refs distantes seules
// (clone d'un dépôt nu : fetch seul, push origin seul) : alerte « refs distantes » ; commit, push vers une URL puis
// reset : alerte du dépôt.
// Intervalles raccourcis par OUTIL_TEST_VEILLE_MS (variable réservée aux tests).
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { environnement, lancer, attendreQue, fichierJetons, dossierUtilisateur, lireJson, fauxProgrammes, lireTemoin } from "./aide-cli.ts";
import { principal } from "../outil.ts";
import { MARQUE_MASQUE, masquerSortie, resume, resumeAvecAlerte, INTERTITRE_ERREURS, ALERTE_DEPOT, RAISON_DEPOT, ALERTE_DEPOT_DISTANT, RAISON_DEPOT_DISTANT } from "../veille.ts";

const FAUX_JETON = "wdd_" + "Zq9".repeat(14);
// Faux agent : FAUX_AGENT=succes (défaut), echec (sortie 3), dort (lance un petit-enfant, écrit les deux PID dans
// FAUX_PIDS, travaille 60 s).
const AGENT = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const mode = process.env.FAUX_AGENT || "succes";
console.log("OUTIL_DEMANDE=" + process.env.OUTIL_DEMANDE);
console.log("OUTIL_JETON " + (process.env.OUTIL_JETON === undefined ? "absent" : "présent"));
console.log("env-jeton " + (Object.values(process.env).some(v => /wdd_[A-Za-z0-9_-]{16,}/.test(String(v))) ? "oui" : "non"));
console.log("cwd=" + process.cwd());
console.log("args=" + JSON.stringify(process.argv.slice(2)));
console.log("jeton recopié par erreur : ${FAUX_JETON} fin");
console.error("avertissement de l'agent : C:\\\\Users\\\\poste\\\\.claude.json ${FAUX_JETON} fin");
if (mode === "echec") { console.error("échec voulu"); process.exit(3); }
if (mode === "dort") {
	// Sous Windows, détaché : hors de l'objet job de libuv, qui l'arrêterait avec son parent ; seul taskkill /T l'atteint.
	// Ailleurs, dans le groupe de processus de l'agent.
	const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: process.platform === "win32" });
	fs.writeFileSync(process.env.FAUX_PIDS, JSON.stringify([process.pid, p.pid]));
	setInterval(() => console.log("travail…"), 100);
	setTimeout(() => process.exit(0), 60000);
} else console.log("résumé : 2 retours traités");
`;

// Faux agent Git (dépôt changé pendant le traitement) : FAUX_GIT=rien (lecture seule, défaut), commit, branche (passe
// sur l'autre branche, au même commit : seul HEAD change), stash, commit-reset (commit puis reset --hard HEAD~1 : HEAD
// et refs comme avant), fetch (git fetch --no-tags origin), push (git push origin main), push-url-reset (commit, push
// vers l'URL FAUX_URL, sans remote nommé, puis reset --hard HEAD~1) ; FAUX_LONG=n caractères de sortie en plus ;
// FAUX_CODE=code de sortie.
const AGENT_GIT = `
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const git = (...a) => execFileSync("git", ["-c", "user.name=Agent", "-c", "user.email=agent@exemple.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
const mode = process.env.FAUX_GIT || "rien";
git("status", "--short"); git("log", "-1", "--format=%H");
if (mode === "commit") { fs.writeFileSync("change.txt", String(Date.now())); git("add", "change.txt"); git("commit", "-q", "-m", "commit de l'agent"); }
if (mode === "branche") git("checkout", "-q", git("symbolic-ref", "--short", "HEAD").trim() === "main" ? "autre" : "main");
if (mode === "stash") { fs.appendFileSync("suivi.txt", "modifié\\n"); git("stash", "push", "-q"); }
const commit = () => { fs.writeFileSync("change.txt", String(Date.now())); git("add", "change.txt"); git("commit", "-q", "-m", "commit de l'agent"); };
if (mode === "commit-reset") { commit(); git("reset", "-q", "--hard", "HEAD~1"); }
if (mode === "fetch") git("fetch", "-q", "--no-tags", "origin");
if (mode === "push") git("push", "-q", "origin", "main");
if (mode === "push-url-reset") { commit(); git("push", "-q", process.env.FAUX_URL, "HEAD:refs/heads/main"); git("reset", "-q", "--hard", "HEAD~1"); }
if (process.env.FAUX_LONG) console.log("x".repeat(Number(process.env.FAUX_LONG)));
console.log("résumé : agent git " + mode);
process.exit(Number(process.env.FAUX_CODE || 0));
`;

const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("CLI outil : veille", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, maud: string, adm: string, agent: string, code: string, agentJs: string;
	before(async () => {
		tmp = dossierTemp("cli-veille");
		env = { ...environnement(tmp), OUTIL_TEST_VEILLE_MS: "100,200" };
		s = await serveurTest(path.join(tmp, "donnees"));
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		adm = await session(u, "jardin", "adm", "admin", "Adm");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent veille" } })).corps.jeton;
		// Le jeton agent vient de jetons.json (comme après « outil brancher ») : rien dans l'environnement.
		fs.mkdirSync(path.dirname(fichierJetons(env)), { recursive: true });
		fs.writeFileSync(fichierJetons(env), JSON.stringify({ [u]: { jardin: agent } }));
		code = path.join(tmp, "code");
		fs.mkdirSync(path.join(code, "outils"), { recursive: true });
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }, null, 2));
		agentJs = path.join(code, "outils", "agent.mjs");
		fs.writeFileSync(agentJs, AGENT);
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	const outil = (args: string[], extra: Record<string, string> = {}) => lancer(env, args, { cwd: code, env: extra });
	const creer = async () => {
		const r = await appel(u, "/api/p/jardin/demandes", { cookie: maud, corps: {} });
		assert.equal(r.status, 201, r.texte);
		return r.corps.id as string;
	};
	const demande = async (id: string) => {
		const r = (await appel(u, "/api/p/jardin/demandes", { cookie: maud })).corps;
		return r.active?.id === id ? r.active : r.recentes.find((x: any) => x.id === id);
	};
	const sansJeton = (r: { stdout: string; stderr: string }) => {
		assert.ok(!(r.stdout + r.stderr).includes(agent), "le jeton de la veille apparaît dans la sortie");
		assert.ok(!/wdd_[A-Za-z0-9_-]{16,}/.test(r.stdout + r.stderr), "un jeton apparaît dans la sortie");
	};

	test("masquage : tout wdd_…, quelle que soit sa longueur, et les jetons connus, avant de couper", () => {
		assert.equal(masquerSortie(`a ${FAUX_JETON} b wdd_x c`), `a ${MARQUE_MASQUE} b ${MARQUE_MASQUE} c`);
		assert.equal(masquerSortie("valeur secrete-123 ici", ["secrete-123"]), `valeur ${MARQUE_MASQUE} ici`);
	});

	test("résumé : fin de la sortie standard ; avec une sortie d'erreur (échec), sa fin sous un intertitre ; 4 000 caractères au plus", () => {
		assert.equal(resume("a\nb\n", ""), "a\nb\n");
		assert.equal(resume("", "panne\n"), `${INTERTITRE_ERREURS}\npanne\n`);
		const r = resume("s".repeat(9000) + "\nFIN-SORTIE", "e".repeat(9000) + "\nFIN-ERREUR");
		assert.ok(r.length <= 4000, String(r.length));
		assert.ok(r.indexOf("FIN-SORTIE") < r.indexOf(INTERTITRE_ERREURS) && r.endsWith("FIN-ERREUR"), r.slice(-200));
		assert.ok(r.split(INTERTITRE_ERREURS)[1].length < 1400, "la sortie d'erreur prend au plus le tiers");
	});

	test("résumé avec l'alerte du dépôt changé : première ligne, 4 000 caractères en tout ; sans changement, le résumé ordinaire", () => {
		const r = resumeAvecAlerte("s".repeat(9000) + "\nFIN", "e".repeat(9000), ALERTE_DEPOT);
		assert.ok(r.length <= 4000, String(r.length));
		assert.equal(r.split("\n")[0], ALERTE_DEPOT); assert.ok(r.includes("FIN") && r.includes(INTERTITRE_ERREURS));
		assert.equal(resumeAvecAlerte("a\n", "", ""), resume("a\n", ""));
		const d = resumeAvecAlerte("s".repeat(9000) + "\nFIN", "", ALERTE_DEPOT_DISTANT);
		assert.ok(d.length <= 4000 && d.endsWith("FIN"), String(d.length)); assert.equal(d.split("\n")[0], ALERTE_DEPOT_DISTANT);
	});

	describe("dépôt Git changé pendant le traitement (HEAD, refs, stashs relevés avant et après l'agent)", () => {
		let depot: string, agentGit: string;
		const g = (...a: string[]) => execFileSync("git", ["-C", depot, "-c", "user.name=Test", "-c", "user.email=test@exemple.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
		before(() => {
			depot = path.join(tmp, "code-git");
			fs.mkdirSync(depot, { recursive: true });
			g("init", "-q", "-b", "main");
			fs.writeFileSync(path.join(depot, "suivi.txt"), "départ\n");
			g("add", "suivi.txt"); g("commit", "-q", "-m", "départ"); g("branch", "autre");
			fs.writeFileSync(path.join(depot, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }, null, 2));
			agentGit = path.join(tmp, "agent-git.mjs");
			fs.writeFileSync(agentGit, AGENT_GIT);
		});
		const veilleGit = (extra: Record<string, string>, json = true) =>
			lancer(env, ["veille", "--une-fois", ...(json ? ["--json"] : []), "--", "node", agentGit], { cwd: depot, env: extra });

		test("l'agent ne change rien (lecture seule) : pas d'alerte, raison vide", async () => {
			const id = await creer();
			const r = await veilleGit({ FAUX_GIT: "rien" });
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.json.traitees, [{ id, etat: "terminee", code_sortie: 0, raison: "" }]);
			const d = await demande(id);
			assert.equal(d.etat, "terminee"); assert.equal(d.raison, "");
			assert.match(d.resume, /^résumé : agent git rien/);
			assert.ok(!d.resume.includes(ALERTE_DEPOT) && !r.stderr.includes(ALERTE_DEPOT), r.stderr);
		});

		test("l'agent commite : terminee quand même, le résumé commence par l'alerte (4 000 caractères en tout), la raison et la veille le disent", async () => {
			const n = Number(g("rev-list", "--count", "HEAD").trim());
			const id = await creer();
			const r = await veilleGit({ FAUX_GIT: "commit", FAUX_LONG: "9000" });
			assert.equal(r.code, 0, r.stderr);
			assert.equal(Number(g("rev-list", "--count", "HEAD").trim()), n + 1, "le faux agent a bien commité");
			assert.deepEqual(r.json.traitees, [{ id, etat: "terminee", code_sortie: 0, raison: RAISON_DEPOT }]);
			const d = await demande(id);
			assert.equal(d.etat, "terminee"); assert.equal(d.raison, RAISON_DEPOT);
			assert.equal(d.resume.split("\n")[0], ALERTE_DEPOT);
			assert.ok(d.resume.length <= 4000 && d.resume.includes("résumé : agent git commit"), String(d.resume.length));
			assert.match(r.stderr, new RegExp(`demande ${id} : ⚠ Le dépôt a changé pendant le traitement`), "la veille l'affiche");
		});

		test("changement de branche seul (même commit) ou stash : alerte ; en échec, la raison garde le code de sortie ; texte lisible : sur stdout", async () => {
			const id = await creer();
			const r = await veilleGit({ FAUX_GIT: "branche", FAUX_CODE: "3" });
			assert.equal(r.code, 0, r.stderr);
			assert.equal(g("symbolic-ref", "--short", "HEAD").trim(), "autre");
			const d = await demande(id);
			assert.equal(d.etat, "echouee"); assert.equal(d.raison, `code de sortie 3 ; ${RAISON_DEPOT}`);
			assert.equal(d.resume.split("\n")[0], ALERTE_DEPOT);
			const id2 = await creer();
			const h = await veilleGit({ FAUX_GIT: "stash" }, false);
			assert.equal(h.code, 0, h.stderr);
			assert.equal(g("stash", "list").trim().split("\n").length, 1, "le faux agent a bien mis de côté");
			const d2 = await demande(id2);
			assert.equal(d2.etat, "terminee"); assert.equal(d2.raison, RAISON_DEPOT); assert.equal(d2.resume.split("\n")[0], ALERTE_DEPOT);
			assert.ok(h.stdout.includes(`demande ${id2} : ${ALERTE_DEPOT}`), h.stdout);
		});

		test("commit puis reset --hard HEAD~1 (HEAD et refs comme avant) : vu par le reflog de HEAD, alerte", async () => {
			const head = g("rev-parse", "HEAD").trim(), refs = g("for-each-ref");
			const id = await creer();
			const r = await veilleGit({ FAUX_GIT: "commit-reset" });
			assert.equal(r.code, 0, r.stderr);
			assert.equal(g("rev-parse", "HEAD").trim(), head); assert.equal(g("for-each-ref"), refs, "HEAD et refs inchangés");
			const d = await demande(id);
			assert.equal(d.etat, "terminee"); assert.equal(d.raison, RAISON_DEPOT); assert.equal(d.resume.split("\n")[0], ALERTE_DEPOT);
		});
	});

	describe("refs distantes (refs/remotes) seules changées : alerte à part (fetch ou push) ; push vers une URL puis reset : alerte du dépôt", () => {
		let nu: string, clone: string, amont: string, agentGit: string;
		const gIn = (d: string) => (...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=Test", "-c", "user.email=test@exemple.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
		const commitDans = (d: string, sujet: string) => { fs.writeFileSync(path.join(d, "f.txt"), sujet + "\n"); gIn(d)("add", "f.txt"); gIn(d)("commit", "-q", "-m", sujet); };
		before(() => {
			nu = path.join(tmp, "origine.git"); clone = path.join(tmp, "code-distant"); amont = path.join(tmp, "amont");
			execFileSync("git", ["init", "-q", "--bare", "-b", "main", nu]);
			execFileSync("git", ["clone", "-q", nu, amont], { stdio: "ignore" }); // dépôt nu vide : avertissement de git, sans intérêt
			gIn(amont)("symbolic-ref", "HEAD", "refs/heads/main"); commitDans(amont, "départ"); gIn(amont)("push", "-q", "origin", "main");
			execFileSync("git", ["clone", "-q", nu, clone]);
			fs.writeFileSync(path.join(clone, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }, null, 2));
			agentGit = path.join(tmp, "agent-git-distant.mjs");
			fs.writeFileSync(agentGit, AGENT_GIT);
		});
		const veilleDistant = (extra: Record<string, string>) =>
			lancer(env, ["veille", "--une-fois", "--json", "--", "node", agentGit], { cwd: clone, env: extra });
		const verifierDistant = async (id: string, r: { code: number; stderr: string }) => {
			assert.equal(r.code, 0, r.stderr);
			const d = await demande(id);
			assert.equal(d.etat, "terminee"); assert.equal(d.raison, RAISON_DEPOT_DISTANT);
			assert.equal(d.resume.split("\n")[0], ALERTE_DEPOT_DISTANT);
			assert.ok(!d.resume.includes(ALERTE_DEPOT) && !d.raison.includes(RAISON_DEPOT), d.resume);
			assert.ok(r.stderr.includes(`demande ${id} : ${ALERTE_DEPOT_DISTANT}`), r.stderr);
		};

		test("fetch seul (commit poussé en amont par un autre clone) : alerte « refs distantes », pas celle du commit", async () => {
			commitDans(amont, "amont 2"); gIn(amont)("push", "-q", "origin", "main");
			const head = gIn(clone)("rev-parse", "HEAD").trim();
			const id = await creer();
			const r = await veilleDistant({ FAUX_GIT: "fetch" });
			assert.equal(gIn(clone)("rev-parse", "HEAD").trim(), head, "HEAD inchangé");
			assert.equal(gIn(clone)("rev-parse", "origin/main").trim(), gIn(amont)("rev-parse", "HEAD").trim(), "le fetch a bien eu lieu");
			await verifierDistant(id, r);
		});

		test("push origin main d'un commit déjà présent en local (seule refs/remotes/origin/main change) : alerte « refs distantes »", async () => {
			gIn(clone)("merge", "-q", "--ff-only", "origin/main"); commitDans(clone, "local 3");
			const id = await creer();
			const r = await veilleDistant({ FAUX_GIT: "push" });
			assert.equal(gIn(nu)("rev-parse", "main").trim(), gIn(clone)("rev-parse", "HEAD").trim(), "le push a bien eu lieu");
			await verifierDistant(id, r);
		});

		test("commit, push vers une URL (sans remote nommé), puis reset --hard : alerte du dépôt (reflog de HEAD)", async () => {
			const head = gIn(clone)("rev-parse", "HEAD").trim(), refs = gIn(clone)("for-each-ref");
			const id = await creer();
			const r = await veilleDistant({ FAUX_GIT: "push-url-reset", FAUX_URL: nu });
			assert.equal(r.code, 0, r.stderr);
			assert.equal(gIn(clone)("rev-parse", "HEAD").trim(), head); assert.equal(gIn(clone)("for-each-ref"), refs, "HEAD et refs du clone inchangés");
			assert.equal(gIn(nu)("log", "-1", "--format=%s", "main").trim(), "commit de l'agent", "le dépôt nu a reçu le commit");
			const d = await demande(id);
			assert.equal(d.raison, RAISON_DEPOT); assert.equal(d.resume.split("\n")[0], ALERTE_DEPOT);
		});
	});

	test("succès : demande prise, agent lancé dans le dossier de .outil.json avec OUTIL_DEMANDE et sans jeton ajouté, terminee, résumé masqué par la CLI", async () => {
		const id = await creer();
		const r = await outil(["veille", "--une-fois", "--poste", "Poste-Veille", "--json", "--", "node", agentJs]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.json.traitees, [{ id, etat: "terminee", code_sortie: 0, raison: "" }]);
		assert.equal(r.json.poste, "Poste-Veille"); assert.equal(r.json.projet, "jardin");
		// Une ligne par événement, à l'heure locale, sur stderr avec --json.
		assert.match(r.stderr, /^\[\d{2}:\d{2}:\d{2}\] veille de jardin sur /m);
		assert.match(r.stderr, new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] demande ${id} prise \\(demandée par Maud\\)`, "m"));
		assert.match(r.stderr, new RegExp(`^\\[\\d{2}:\\d{2}:\\d{2}\\] demande ${id} : terminee, code de sortie 0`, "m"));
		const d = await demande(id);
		assert.equal(d.etat, "terminee"); assert.equal(d.code_sortie, 0); assert.equal(d.poste, "Poste-Veille");
		assert.match(d.resume, new RegExp(`OUTIL_DEMANDE=${id}`));
		assert.match(d.resume, /OUTIL_JETON absent/); assert.match(d.resume, /env-jeton non/);
		assert.ok(d.resume.includes("cwd=" + code), d.resume);
		assert.match(d.resume, /résumé : 2 retours traités/);
		assert.ok(d.resume.includes(`jeton recopié par erreur : ${MARQUE_MASQUE} fin`), "masqué par la CLI (marque de la CLI, pas celle du serveur)");
		assert.ok(!d.resume.includes(FAUX_JETON.slice(4)), "jeton recopié non masqué");
		// Résumé = sortie standard seule : la sortie d'erreur (avertissements, chemins du poste) n'y est pas en cas de succès.
		assert.ok(!d.resume.includes("avertissement de l'agent") && !d.resume.includes(INTERTITRE_ERREURS), d.resume);
		// Journal : un dernier battement à la fin de l'agent (2e répétition, défaut 1), avec les deux sorties jusqu'au bout,
		// masquées ; sans lui, un agent plus court que l'intervalle des battements laisse le journal vide.
		assert.match(d.journal, /résumé : 2 retours traités/, "fin de la sortie standard dans le journal");
		assert.match(d.journal, /avertissement de l'agent/, "sortie d'erreur dans le journal");
		assert.ok(!d.journal.includes(FAUX_JETON.slice(4)), "jeton non masqué dans le journal");
		sansJeton(r);
		// Texte lisible : les événements sur stdout.
		const id2 = await creer();
		const h = await outil(["veille", "--une-fois", "--", "node", agentJs]);
		assert.equal(h.code, 0, h.stderr);
		assert.match(h.stdout, new RegExp(`demande ${id2} : terminee`)); assert.match(h.stdout, /veille arrêtée : 1 demande\(s\) traitée\(s\)/);
	});

	test("échec : code de sortie non nul → echouee, code et raison", async () => {
		const id = await creer();
		// OUTIL_JETON déjà défini dans l'environnement de la veille : laissé à l'agent (choix documenté), jamais recopié.
		const r = await outil(["veille", "--une-fois", "--json", "--", "node", agentJs], { FAUX_AGENT: "echec", OUTIL_JETON: agent });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.json.traitees, [{ id, etat: "echouee", code_sortie: 3, raison: "code de sortie 3" }]);
		const d = await demande(id);
		assert.equal(d.etat, "echouee"); assert.equal(d.code_sortie, 3); assert.equal(d.raison, "code de sortie 3");
		assert.match(d.resume, /échec voulu/);
		// Échec : la sortie standard, puis la sortie d'erreur sous un intertitre, masquée elle aussi.
		assert.ok(d.resume.indexOf("OUTIL_DEMANDE=") < d.resume.indexOf(INTERTITRE_ERREURS) && d.resume.indexOf(INTERTITRE_ERREURS) < d.resume.indexOf("échec voulu"), d.resume);
		assert.ok(d.resume.includes(`avertissement de l'agent : C:\\Users\\poste\\.claude.json ${MARQUE_MASQUE} fin`), d.resume);
		assert.match(d.resume, /OUTIL_JETON présent/); assert.ok(!d.resume.includes(agent));
		sansJeton(r);
	});

	test("annulation pendant l'exécution : battement → annuler, arbre de processus arrêté (petit-enfant compris), annulee", async () => {
		const id = await creer();
		const pids = path.join(tmp, "pids-annulation.json");
		const veille = outil(["veille", "--une-fois", "--json", "--", "node", agentJs], { FAUX_AGENT: "dort", FAUX_PIDS: pids });
		await attendreQue(() => fs.existsSync(pids), 15000, "agent lancé");
		const [p1, p2] = JSON.parse(fs.readFileSync(pids, "utf8"));
		assert.ok(vivant(p1) && vivant(p2));
		// Le journal arrive par les battements.
		let journal = "";
		for (let i = 0; i < 50 && !/travail…/.test(journal); i++) { await new Promise(r => setTimeout(r, 100)); journal = (await demande(id)).journal || ""; }
		assert.match(journal, /travail…/, "fin de la sortie envoyée par le battement");
		assert.ok(!journal.includes(FAUX_JETON.slice(4)));
		assert.match(journal, /avertissement de l'agent/, "le journal a aussi la sortie d'erreur");
		assert.equal((await appel(u, `/api/p/jardin/demandes/${id}/annuler`, { cookie: maud, methode: "POST" })).status, 200);
		const r = await veille;
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.traitees[0].etat, "annulee");
		const d = await demande(id);
		assert.equal(d.etat, "annulee"); assert.equal(d.raison, "annulée depuis l'interface");
		assert.match(r.stderr, /annulation demandée depuis l'interface : arrêt de l'agent/);
		await attendreQue(() => !vivant(p1) && !vivant(p2), 10000, "agent et petit-enfant arrêtés");
	});

	test("--delai-max : agent arrêté, echouee « délai dépassé »", async () => {
		const id = await creer();
		const pids = path.join(tmp, "pids-delai.json");
		const t0 = Date.now();
		const r = await outil(["veille", "--une-fois", "--delai-max", "1", "--json", "--", "node", agentJs], { FAUX_AGENT: "dort", FAUX_PIDS: pids });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(Date.now() - t0 < 30000);
		assert.equal(r.json.traitees[0].etat, "echouee"); assert.equal(r.json.traitees[0].raison, "délai dépassé");
		const d = await demande(id);
		assert.equal(d.etat, "echouee"); assert.equal(d.raison, "délai dépassé");
		const [p1, p2] = JSON.parse(fs.readFileSync(pids, "utf8"));
		await attendreQue(() => !vivant(p1) && !vivant(p2), 10000, "agent arrêté");
	});

	test("Ctrl+C (signal d'arrêt) pendant un traitement : agent arrêté, echouee « veille arrêtée », sortie 0 ; --json après « -- » reste à l'agent", async () => {
		const id = await creer();
		const pids = path.join(tmp, "pids-arret.json");
		const arret = new AbortController();
		const lu = { stdout: "", stderr: "" };
		const fin = principal(["veille", "--une-fois", "--", "node", agentJs, "--json", "--aide"], {
			env: { ...env, FAUX_AGENT: "dort", FAUX_PIDS: pids }, cwd: code, arret: arret.signal,
			stdout: x => { lu.stdout += x + "\n"; }, stderr: x => { lu.stderr += x + "\n"; }, lireEntree: async () => "",
		});
		await attendreQue(() => fs.existsSync(pids), 15000, "agent lancé");
		arret.abort();
		assert.equal(await fin, 0, lu.stderr);
		const d = await demande(id);
		assert.equal(d.etat, "echouee"); assert.equal(d.raison, "veille arrêtée");
		assert.ok(d.resume.includes('args=["--json","--aide"]'), d.resume);
		assert.match(lu.stdout, /veille arrêtée \(Ctrl\+C\)/, "texte lisible : --json n'a pas été pris par la veille");
		const [p1, p2] = JSON.parse(fs.readFileSync(pids, "utf8"));
		await attendreQue(() => !vivant(p1) && !vivant(p2), 10000, "agent arrêté");
		// Arrêt sans demande en cours : sortie 0 tout de suite.
		const a2 = new AbortController();
		const f2 = principal(["veille", "--", "node", agentJs], { env, cwd: code, arret: a2.signal, stdout: () => { }, stderr: () => { }, lireEntree: async () => "" });
		setTimeout(() => a2.abort(), 300);
		assert.equal(await f2, 0);
	});

	test("--memoriser : commande gardée dans veille.json (indexée par le chemin de .outil.json, jamais dans .outil.json), reprise par « outil veille » seul", async () => {
		const config = fs.readFileSync(path.join(code, ".outil.json"), "utf8");
		const fichier = path.join(dossierUtilisateur(env), "veille.json");
		fs.rmSync(fichier, { force: true });
		// Sans commande ni mémoire : usage, avec l'exemple Claude.
		const r0 = await outil(["veille", "--une-fois", "--json"]);
		assert.equal(r0.code, 2); assert.match(r0.json.erreur.message, /outil veille --memoriser -- claude -p "Traite les retours/);
		assert.match(r0.json.erreur.message, /--disallowedTools "Bash\(git \*\)" "PowerShell\(git \*\)" Artifact ArtifactData/);
		assert.equal((await outil(["veille", "--memoriser", "--json"])).code, 2, "--memoriser sans commande");
		const id = await creer();
		const r1 = await outil(["veille", "--une-fois", "--memoriser", "--json", "--", "node", agentJs, "mémo"]);
		assert.equal(r1.code, 0, r1.stderr);
		assert.equal(r1.json.traitees[0].etat, "terminee"); assert.equal((await demande(id)).etat, "terminee");
		const m = lireJson(fichier);
		assert.deepEqual(Object.keys(m), [path.join(code, ".outil.json")]);
		assert.deepEqual(m[path.join(code, ".outil.json")].commande, ["node", agentJs, "mémo"]);
		assert.equal(fs.readFileSync(path.join(code, ".outil.json"), "utf8"), config, ".outil.json inchangé");
		if (process.platform !== "win32") assert.equal(fs.statSync(fichier).mode & 0o077, 0);
		const id2 = await creer();
		const r2 = await outil(["veille", "--une-fois", "--json"]);
		assert.equal(r2.code, 0, r2.stderr);
		assert.match(r2.stderr, /commande mémorisée le .* : node /);
		const d = await demande(id2);
		assert.equal(d.etat, "terminee"); assert.ok(d.resume.includes('args=["mémo"]'));
		// Un jeton en argument : refusé, jamais mémorisé.
		const r3 = await outil(["veille", "--memoriser", "--json", "--", "node", agentJs, FAUX_JETON]);
		assert.equal(r3.code, 2); sansJeton(r3);
		assert.deepEqual(lireJson(fichier)[path.join(code, ".outil.json")].commande, ["node", agentJs, "mémo"]);
	});

	test("lancé par la veille (OUTIL_DEMANDE) : veille, brancher, installer, connexion, importer-artifact --autoriser refusés (2) ; la commande mémorisée reste ; sa date est affichée", { timeout: 90000 }, async () => {
		const fichier = path.join(dossierUtilisateur(env), "veille.json");
		await creer();
		const r0 = await outil(["veille", "--memoriser", "--une-fois", "--json", "--", "node", agentJs, "humain"]);
		assert.equal(r0.code, 0, r0.stderr);
		const avant = fs.readFileSync(fichier, "utf8");
		const sousVeille = { OUTIL_DEMANDE: "d1" };
		for (const args of [["veille", "--memoriser", "--json", "--", "node", "-e", "1"], ["veille", "--json"], ["brancher", "--serveur", u, "--json"], ["installer", "--oui", "--json"],
			["connexion", "--json"], ["importer-artifact", tmp, "--autoriser", "--json"]]) {
			const r = await outil(args, sousVeille);
			assert.equal(r.code, 2, `${args.join(" ")} : ${r.stderr}`);
			assert.match(r.json.erreur.message, /lancé par la veille \(OUTIL_DEMANDE défini\)/, args.join(" "));
		}
		assert.equal(fs.readFileSync(fichier, "utf8"), avant, "veille.json réécrit par un agent de la veille");
		// Le reste marche : aide, statut.
		assert.equal((await outil(["aide", "veille", "--json"], sousVeille)).code, 0);
		assert.equal((await outil(["statut", "--json"], sousVeille)).code, 0);
		// La commande reprise dit quand elle a été mémorisée.
		await creer();
		const r = await outil(["veille", "--une-fois", "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /commande mémorisée le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} : node /);
	});

	test("jeton mainteneur : 4, rien n'est pris ; commande introuvable : 1 avant tout appel", async () => {
		const mainteneur = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Mainteneur", role: "mainteneur" } })).corps.jeton;
		const id = await creer();
		const r = await outil(["veille", "--une-fois", "--json", "--", "node", agentJs], { OUTIL_JETON: mainteneur });
		assert.equal(r.code, 4, r.stderr); assert.match(r.json.erreur.message, /rôle agent/);
		sansJeton(r); assert.ok(!(r.stdout + r.stderr).includes(mainteneur));
		const r2 = await outil(["veille", "--une-fois", "--json", "--", "programme-qui-n-existe-pas-xyz"]);
		assert.equal(r2.code, 1); assert.match(r2.json.erreur.message, /commande introuvable/);
		assert.equal((await demande(id)).etat, "attente", "demande non prise");
		assert.equal((await appel(u, `/api/p/jardin/demandes/${id}/annuler`, { cookie: maud, methode: "POST" })).status, 200);
	});

	test("Windows : un faux .cmd trouvé par PATH et PATHEXT reçoit ses arguments intacts (exemple Claude) ; un argument avec & est refusé", { skip: process.platform !== "win32" && "Windows seulement" }, async () => {
		const bin = path.join(tmp, "bin avec espace");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "faux-agent.cmd"), `@echo off\r\nnode "${agentJs}" %*\r\n`);
		const PATH = bin + path.delimiter + env.PATH;
		const id = await creer();
		const args = ["-p", "Traite les retours du serveur en suivant AGENTS.md (traitement lancé par la veille).", "--allowedTools", "Bash(outil *)", "PowerShell(outil *)", "Read", "--disallowedTools", "Bash(git *)", "PowerShell(git *)", "C:\\dossier avec espace\\", "simple"];
		const r = await outil(["veille", "--une-fois", "--json", "--", "faux-agent", ...args], { PATH });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.traitees[0].etat, "terminee");
		const d = await demande(id);
		assert.ok(d.resume.includes("args=" + JSON.stringify(args)), d.resume);
		const id2 = await creer();
		const r2 = await outil(["veille", "--une-fois", "--json", "--", "faux-agent", "a&b"], { PATH });
		assert.equal(r2.code, 2, r2.stderr); assert.match(r2.json.erreur.message, /contient un caractère que cmd\.exe interprète/);
		assert.equal((await demande(id2)).etat, "attente", "rien n'est lancé ni pris");
		assert.equal((await appel(u, `/api/p/jardin/demandes/${id2}/annuler`, { cookie: maud, methode: "POST" })).status, 200);
	});

	test("Windows : ni le taskkill.exe ni le node.bat posés dans le dossier de .outil.json ne sont lancés (agent .cmd, délai dépassé)", { skip: process.platform !== "win32" && "Windows seulement" }, async () => {
		const bin = path.join(tmp, "bin-agent");
		fs.mkdirSync(bin, { recursive: true });
		// Comme le lanceur npm de claude : un .cmd qui appelle « node » par son nom.
		fs.writeFileSync(path.join(bin, "agent-npm.cmd"), `@echo off\r\nnode "${agentJs}" %*\r\n`);
		const temoin = path.join(tmp, "temoin-veille.txt");
		const plantes = [path.join(code, "taskkill.exe"), path.join(code, "node.bat")];
		const extra = fauxProgrammes(code, ["taskkill.exe"], temoin);
		fs.writeFileSync(path.join(code, "node.bat"), `@echo off\r\necho node.bat>> "${temoin}"\r\n`);
		try {
			const PATH = bin + path.delimiter + env.PATH;
			// 1. L'agent .cmd : « node » est le vrai node, pas le node.bat du dossier.
			const id = await creer();
			const r = await outil(["veille", "--une-fois", "--json", "--", "agent-npm"], { PATH, ...extra });
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(lireTemoin(temoin), [], "un programme du dépôt a été lancé");
			assert.equal(r.json.traitees[0].etat, "terminee");
			assert.match((await demande(id)).resume, /OUTIL_DEMANDE=/);
			// 2. Délai dépassé : l'arbre est arrêté par le taskkill du système, pas par celui du dossier.
			const id2 = await creer();
			const pids = path.join(tmp, "pids-taskkill.json");
			const r2 = await outil(["veille", "--une-fois", "--delai-max", "1", "--json", "--", "node", agentJs], { FAUX_AGENT: "dort", FAUX_PIDS: pids, ...extra });
			assert.equal(r2.code, 0, r2.stderr);
			assert.equal((await demande(id2)).raison, "délai dépassé");
			const [p1, p2] = JSON.parse(fs.readFileSync(pids, "utf8"));
			await attendreQue(() => !vivant(p1) && !vivant(p2), 10000, "agent et petit-enfant arrêtés par taskkill /T");
			assert.deepEqual(lireTemoin(temoin), [], "le taskkill.exe du dépôt a été lancé");
		} finally { for (const f of plantes) fs.rmSync(f, { force: true }); }
	});
});
