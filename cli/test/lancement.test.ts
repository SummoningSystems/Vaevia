// Étape 3.5, CLI : lancement des programmes (relecture du lot CLI). Sous Windows, un nom de programme sans chemin est
// d'abord cherché dans le dossier courant (libuv, cmd.exe), sauf si NoDefaultCurrentDirectoryInExePath est défini :
// un git.exe, taskkill.exe, explorer.exe ou node.bat posé dans le dépôt serait lancé. Vérifié ici : programmes du
// système par leur chemin absolu sous SystemRoot validé (jamais un nom seul), git résolu dans le PATH, variable posée
// pour les enfants, outil.cmd qui ne lance pas le node.bat du dossier courant ; environnement des enfants sans
// OUTIL_JETON quelle que soit sa casse. Les essais de faux programmes passent par un sous-processus de la CLI :
// l'environnement de test ne contient pas NoDefaultCurrentDirectoryInExePath (le processus des tests peut l'avoir).
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { dossierTemp, nettoyer } from "../../serveur/test/aide.ts";
import { RACINE, environnement, lancer, fauxProgrammes, lireTemoin } from "./aide-cli.ts";
import { envEnfant, programmeSysteme } from "../commun.ts";
import { commandeNavigateur } from "../appairage.ts";

const WIN = process.platform === "win32";

describe("CLI outil : lancement des programmes", () => {
	let tmp: string, env: Record<string, string>;
	before(() => {
		tmp = dossierTemp("cli-lancement");
		env = environnement(tmp);
	});
	after(() => nettoyer(tmp));

	test("environnement d'un enfant : clés retirées quelle que soit leur casse (Windows), NoDefaultCurrentDirectoryInExePath posé", () => {
		const e = envEnfant({ Outil_Jeton: "x", outil_jeton: "y", PATH: "p", nodefaultcurrentdirectoryinexepath: "0" }, { retirer: ["OUTIL_JETON"], poser: { OUTIL_DEMANDE: "d1" } }, "win32");
		assert.deepEqual(e, { PATH: "p", OUTIL_DEMANDE: "d1", NoDefaultCurrentDirectoryInExePath: "1" });
		// Ailleurs, la casse compte et rien n'est ajouté.
		assert.deepEqual(envEnfant({ Outil_Jeton: "x", OUTIL_JETON: "y" }, { retirer: ["OUTIL_JETON"] }, "linux"), { Outil_Jeton: "x" });
	});

	test("navigateur : explorer.exe par son chemin absolu sous SystemRoot validé, jamais par son nom seul ; open, xdg-open ailleurs", () => {
		const racine = path.join(tmp, "Windows");
		fs.mkdirSync(path.join(racine, "System32"), { recursive: true });
		fs.writeFileSync(path.join(racine, "explorer.exe"), "");
		const url = "http://127.0.0.1:1/appairage?code=ABCD-EFGH";
		assert.deepEqual(commandeNavigateur({ SystemRoot: racine }, url, "win32"), [path.join(racine, "explorer.exe"), [url]]);
		assert.deepEqual(commandeNavigateur({ systemroot: racine }, url, "win32"), [path.join(racine, "explorer.exe"), [url]], "casse de SystemRoot sans effet");
		// SystemRoot absent, relatif, ou sans System32 : rien n'est lancé (pas de repli sur « explorer.exe »).
		assert.equal(commandeNavigateur({}, url, "win32"), null);
		assert.equal(commandeNavigateur({ SystemRoot: "Windows" }, url, "win32"), null);
		assert.equal(commandeNavigateur({ SystemRoot: tmp }, url, "win32"), null);
		assert.equal(programmeSysteme({ SystemRoot: racine }, "System32", "taskkill.exe"), null, "programme absent : null");
		assert.deepEqual(commandeNavigateur({}, url, "darwin"), ["open", [url]]);
		assert.deepEqual(commandeNavigateur({}, url, "linux"), ["xdg-open", [url]]);
	});

	test("Windows : un git.exe posé dans le dépôt n'est jamais lancé (outil installer, même avec --sans-publier)", { skip: !WIN && "Windows seulement" }, async () => {
		const d = path.join(tmp, "depot-git");
		fs.mkdirSync(d, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: d });
		const temoin = path.join(tmp, "temoin-git.txt");
		const extra = fauxProgrammes(d, ["git.exe"], temoin);
		const r = await lancer(env, ["installer", "--sans-publier", "--json"], { cwd: d, env: extra });
		assert.deepEqual(lireTemoin(temoin), [], "le git.exe du dépôt a été lancé");
		// Le vrai git a répondu : la racine du dépôt est trouvée ; sans serveur, erreur d'usage (rien d'écrit).
		assert.equal(r.code, 2, r.stderr);
		assert.match(r.json.erreur.message, /aucun serveur/);
	});

	test("Windows : outil.cmd lancé depuis un dossier qui contient node.bat lance le vrai node", { skip: !WIN && "Windows seulement" }, async () => {
		const d = path.join(tmp, "depot-node-bat");
		fs.mkdirSync(d, { recursive: true });
		const temoin = path.join(tmp, "temoin-node-bat.txt");
		fs.writeFileSync(path.join(d, "node.bat"), `@echo off\r\necho node.bat>> "${temoin}"\r\n`);
		const cmd = path.join(env.SystemRoot, "System32", "cmd.exe");
		const r = await new Promise<{ code: number; stdout: string }>((ok, ko) => {
			const p = spawn(cmd, ["/d", "/s", "/c", `""${path.join(RACINE, "cli", "outil.cmd")}" methode --chemin"`], { cwd: d, env, windowsHide: true, windowsVerbatimArguments: true });
			let stdout = "";
			p.stdout.setEncoding("utf8"); p.stdout.on("data", c => stdout += c);
			p.on("error", ko); p.on("close", c => ok({ code: c ?? -1, stdout }));
		});
		assert.deepEqual(lireTemoin(temoin), [], "le node.bat du dossier courant a été lancé");
		assert.equal(r.code, 0);
		assert.equal(r.stdout.trim(), path.join(RACINE, "methode", "METHODE.md"));
	});
});
