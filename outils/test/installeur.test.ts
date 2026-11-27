// Étape 3.5, installeur Windows (docs/etape3-5-prise-en-main.md § 1.2 et § 2.4, -Reconnecter) : outils/installer.ps1
// lancé par powershell.exe (Windows PowerShell 5.1, jamais pwsh) en -Essai, dans des dossiers temporaires, sur un port
// libre (jamais 8080), avec APPDATA / LOCALAPPDATA / USERPROFILE temporaires. Parcours : installation (une ligne « ✓ »
// par étape, accents intacts), /api/sante, installation.json lu par la CLI, lien admin sur la sortie et utilisable
// (POST du formulaire : compte admin créé), deuxième lancement sans relance (même PID), -Reconnecter, -Arreter (par
// installer.cmd : processus mort), -Demarrer, -Desinstaller (arrêté, données gardées). Aussi : BOM UTF-8, analyse
// syntaxique par 5.1, refus d'usage de -Essai, PATH utilisateur et dossier Démarrage réels inchangés.
// Relecture du lot : erreurs d'usage (code 2), jonction vers le dépôt refusée, chemins à « %OS% » (journal au bon
// endroit), serveur étranger jamais arrêté (serveur.pid « PID heure »), dossier de données déjà servi par un autre
// serveur refusé (serveur.verrou), base abîmée (« s'est arrêté au démarrage », installation.json non écrit, verrou
// rendu), accès ouverts signalés, avertissement -Reseau de -Demarrer, -Desinstaller sans installation, PATH utilisateur
// (type et %…% gardés, entrée de l'utilisateur laissée) sur une clé de registre temporaire, .env et variantes ignorés.
// Après la répétition générale (§ 8.4, D1) : phrase « Branche ce dépôt sur le serveur de retours … » dans le résumé ;
// raccourci Claude Code (skill utilisateur site-retours-outil) jamais écrit en -Essai sans -Profil, même si
// %USERPROFILE%\.claude existe ; avec un -Profil temporaire : copie octet pour octet du modèle, fichier différent laissé,
// pas de dossier .claude → sans objet ; -Desinstaller retire la copie seulement si elle est identique à celle posée.
// Relecture : ligne du résumé quand la copie personnelle est celle de l'outil (elle masque celle d'un dépôt branché) ;
// -Essai -Profil menant au vrai .claude de l'utilisateur (profil réel par os.userInfo) : code 2, rien écrit.
// Sauté hors Windows. Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "outils/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appel, dossierTemp, nettoyer } from "../../serveur/test/aide.ts";
import { environnement } from "../../cli/test/aide-cli.ts";
import { serveurInstallation } from "../../cli/commun.ts";

const WINDOWS = process.platform === "win32";
const RACINE = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(RACINE, "outils", "installer.ps1");
const CMD = path.join(RACINE, "installer.cmd");
const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LIEN = /^https?:\/\/[^\s/]+\/invitation\/[A-Za-z0-9_-]{20,100}$/;
const JETON = /wdd_[A-Za-z0-9_-]{16,}/;
const SKILL = path.join(RACINE, "methode", "integrations", "claude", "SKILL.md");
const skillDans = (profil: string) => path.join(profil, ".claude", "skills", "site-retours-outil", "SKILL.md");
// Ligne du résumé quand la copie personnelle est celle de l'outil : elle masque la copie d'un dépôt branché (même nom).
const MASQUE_PROJET = "cette copie personnelle passe avant celle d'un dépôt branché (même nom, site-retours-outil)";

type Resultat = { code: number; sortie: string };

// Lance un programme, sorties lues en octets puis décodées en UTF-8 (c'est ce qui vérifie l'encodage) ; entrée fermée.
function lancer(exe: string, args: string[], env: Record<string, string>, o: { verbatim?: boolean } = {}): Promise<Resultat> {
	return new Promise((ok, ko) => {
		const p = spawn(exe, args, { env, cwd: env.TEMP, windowsHide: true, windowsVerbatimArguments: !!o.verbatim, stdio: ["ignore", "pipe", "pipe"] });
		const morceaux: Buffer[] = [];
		p.stdout.on("data", c => morceaux.push(c)); p.stderr.on("data", c => morceaux.push(c));
		const minuterie = setTimeout(() => { p.kill(); ko(new Error(`${path.basename(exe)} ${args.join(" ")} : plus de 120 s`)); }, 120000);
		p.on("error", e => { clearTimeout(minuterie); ko(e); });
		p.on("close", c => { clearTimeout(minuterie); ok({ code: c ?? -1, sortie: Buffer.concat(morceaux).toString("utf8") }); });
	});
}
const portLibre = (): Promise<number> => new Promise((ok, ko) => {
	const s = net.createServer();
	s.once("error", ko);
	s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); });
});
const vivant = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const attendreMort = async (pid: number) => { for (let i = 0; i < 50 && vivant(pid); i++) await new Promise(r => setTimeout(r, 100)); return !vivant(pid); };
const sante = async (port: number) => { try { const r = await fetch(`http://127.0.0.1:${port}/api/sante`); return r.status === 200 && (await r.json()).ok === true; } catch { return false; } };
const lienDe = (sortie: string, etiquette: string) => {
	const m = sortie.match(new RegExp(`^${etiquette} \\(-Essai\\) : (\\S+)\\s*$`, "m"));
	assert.ok(m, `ligne « ${etiquette} (-Essai) » attendue :\n${sortie}`);
	assert.match(m![1], LIEN);
	return m![1];
};
// PATH utilisateur réel et raccourci réel du dossier Démarrage : lus seulement, pour vérifier que -Essai n'y touche pas.
// Le dossier Démarrage est lu comme l'installeur le lit ([Environment]::GetFolderPath('Startup'), registre), avec
// l'environnement réel et avec celui du test (APPDATA temporaire ne le déplace pas forcément).
const pathUtilisateur = () => { try { return execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true }); } catch { return "(absent)"; } };
const dossierDemarrage = (e: NodeJS.ProcessEnv) => execFileSync(POWERSHELL, ["-NoProfile", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('Startup')"], { env: e, encoding: "utf8", windowsHide: true }).trim();
const raccourcis = (dossiers: string[]) => dossiers.map(d => d ? fs.existsSync(path.join(d, "Vaevia (serveur).lnk")) : false);
// Processus lancés par l'installeur pendant le test : {pid, debut} lus dans serveur.pid. Arrêtés à la fin seulement si
// c'est encore le même processus (même heure de démarrage, principal.ts dans sa ligne de commande) : un PID repris
// entre-temps par un autre programme n'est jamais tué.
type Lance = { pid: number; debut: string };
function arreterSiNotre(l: Lance) {
	const ps = `$p = Get-Process -Id ${l.pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }
try { $d = $p.StartTime.ToUniversalTime().Ticks } catch { exit 0 }
if ("$d" -ne '${l.debut}') { exit 0 }
$w = Get-CimInstance Win32_Process -Filter "ProcessId=${l.pid}" -ErrorAction SilentlyContinue
if (-not $w -or -not $w.CommandLine -or ($w.CommandLine -notmatch 'principal\\.ts|WDD_I_PRINCIPAL')) { exit 0 }
& taskkill.exe /PID ${l.pid} /T /F | Out-Null`;
	spawnSync(POWERSHELL, ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true });
}

describe("installeur Windows : outils/installer.ps1 en -Essai", { skip: WINDOWS ? false : "Windows seulement" }, () => {
	let tmp: string, env: Record<string, string>, etat: string, donnees: string, port: number;
	const lances = new Map<string, Lance>();
	const etrangers: ChildProcess[] = [];
	let pathAvant = "", demarrages: string[] = [], raccourcisAvant: boolean[] = [];
	const ps = (...args: string[]) => lancer(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], env);
	const essai = (...args: string[]) => ps("-Essai", "-Etat", etat, ...args);
	// serveur.pid : « PID heure » (ticks UTC de démarrage du processus).
	const pidDe = (dossierEtat: string) => {
		const t = fs.readFileSync(path.join(dossierEtat, "serveur.pid"), "utf8").trim();
		const m = t.match(/^(\d+) (\d+)$/);
		assert.ok(m, `serveur.pid « PID heure » attendu : ${t}`);
		lances.set(`${m![1]} ${m![2]}`, { pid: Number(m![1]), debut: m![2] });
		return Number(m![1]);
	};
	const pidLu = () => pidDe(etat);
	const portLibreSauf8080 = async () => { let p: number; do p = await portLibre(); while (p === 8080); return p; };
	// Serveur « étranger » : node <dépôt>\serveur\src\principal.ts lancé à la main (chemin absolu à antislashs), sur ses
	// propres données et son port. Il n'appartient à aucune installation.
	const serveurEtranger = async (d: string, p: number) => {
		const c = spawn(process.execPath, [path.join(RACINE, "serveur", "src", "principal.ts")], { env: { PATH: env.PATH, SystemRoot: env.SystemRoot, WDD_DONNEES: d, WDD_PORT: String(p) }, stdio: "ignore", windowsHide: true });
		etrangers.push(c);
		for (let i = 0; i < 100 && !(await sante(p)); i++) await new Promise(r => setTimeout(r, 100));
		assert.ok(await sante(p), "serveur étranger prêt");
		return c;
	};
	const verifierSortie = (r: Resultat) => {
		assert.doesNotMatch(r.sortie, /\uFFFD|Ã|â€/, "accents cassés :\n" + r.sortie);
		assert.doesNotMatch(r.sortie, JETON, "jeton dans la sortie");
	};

	let base: string;
	before(async () => {
		// Espace et accent dans tous les chemins, comme sous C:\Users\<Prénom Nom>\ : journal redirigé par cmd,
		// WDD_DONNEES, --donnees de lien.ts, arguments transmis par installer.cmd, installation.json lu par la CLI.
		base = dossierTemp("installeur");
		tmp = path.join(base, "Prénom Nom");
		fs.mkdirSync(tmp);
		env = environnement(tmp);
		etat = path.join(env.LOCALAPPDATA, "Vaevia"); // là où la CLI cherche installation.json
		donnees = path.join(tmp, "Données locales");
		port = await portLibreSauf8080();
		// Un %USERPROFILE%\.claude (temporaire) existe : -Essai sans -Profil ne doit pourtant rien y écrire.
		fs.mkdirSync(path.join(env.USERPROFILE, ".claude"), { recursive: true });
		pathAvant = pathUtilisateur();
		demarrages = [dossierDemarrage(process.env), dossierDemarrage(env)];
		raccourcisAvant = raccourcis(demarrages);
	});
	after(() => {
		for (const l of lances.values()) arreterSiNotre(l);
		for (const c of etrangers) if (c.exitCode === null) c.kill();
		nettoyer(base);
	});

	test("fichiers : installer.ps1 en UTF-8 avec BOM, analysé sans erreur par Windows PowerShell 5.1 ; installer.cmd en ASCII, CRLF", async () => {
		const octets = fs.readFileSync(SCRIPT);
		assert.deepEqual([...octets.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
		assert.ok(octets.toString("utf8").includes("✓"));
		const analyse = await lancer(POWERSHELL, ["-NoProfile", "-Command",
			`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }; exit 1 }; 'version ' + $PSVersionTable.PSVersion.Major`], env);
		assert.equal(analyse.code, 0, analyse.sortie);
		assert.match(analyse.sortie, /version 5/, "Windows PowerShell 5.x");
		const cmd = fs.readFileSync(CMD);
		assert.ok(cmd.every(o => o < 0x80), "installer.cmd en ASCII");
		assert.ok(cmd.toString("latin1").split("\n").slice(0, -1).every(l => l.endsWith("\r")), "installer.cmd en CRLF");
	});

	test("installer.cmd : code de sortie transmis ; pause seulement sans argument et lancé par « cmd /c » (double-clic)", async () => {
		const cmd = (fichier: string, args: string) => lancer(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${fichier}"${args}"`], env, { verbatim: true });
		// Le vrai installer.cmd : refus d'usage (avant toute écriture), code 2 transmis, pas de pause (argument donné).
		const usage = await cmd(CMD, " -Essai");
		assert.equal(usage.code, 2, usage.sortie); assert.match(usage.sortie, /✗ -Essai exige/);
		// Une copie à côté d'un faux outils\installer.ps1 (exit 7) : jamais le vrai sans argument (installation réelle).
		const faux = path.join(tmp, "copie cmd");
		fs.mkdirSync(path.join(faux, "outils"), { recursive: true });
		fs.copyFileSync(CMD, path.join(faux, "installer.cmd"));
		fs.writeFileSync(path.join(faux, "outils", "installer.ps1"), "exit 7\r\n");
		const avec = await cmd(path.join(faux, "installer.cmd"), " -Arreter");
		assert.equal(avec.code, 7); assert.equal(avec.sortie.trim(), "", "pas de pause avec un argument");
		const sans = await cmd(path.join(faux, "installer.cmd"), "");
		assert.equal(sans.code, 7); assert.notEqual(sans.sortie.trim(), "", "pause (message de « pause ») sans argument");
	});

	test("erreurs d'usage : -Port abc, option inconnue, argument en trop : code 2, ligne « ✗ » et ligne d'usage", async () => {
		for (const args of [["-Port", "abc"], ["-Port", "70000"], ["-Inconnue"], ["-Arreter", "en-trop"]]) {
			const r = await essai(...args);
			assert.equal(r.code, 2, `${args.join(" ")} :\n${r.sortie}`);
			assert.match(r.sortie, /^✗ (-Port : un nombre de 1 à 65535|option ou argument inconnu)/m, r.sortie);
			assert.match(r.sortie, /usage : installer\.cmd/);
		}
		assert.ok(!fs.existsSync(etat), "rien créé");
	});

	test("-Essai : -Donnees et -Etat exigés, 8080 refusé, données dans le dépôt de l'outil refusées (rien créé)", async () => {
		const sans = await ps("-Essai", "-Donnees", donnees);
		assert.equal(sans.code, 2, sans.sortie); assert.match(sans.sortie, /✗ -Essai exige/);
		const p8080 = await essai("-Donnees", donnees, "-Port", "8080");
		assert.equal(p8080.code, 2, p8080.sortie); assert.match(p8080.sortie, /8080 n'est jamais utilisé/);
		const dansDepot = path.join(RACINE, "donnees-essai-installeur");
		const r = await essai("-Donnees", dansDepot, "-Port", String(port));
		assert.equal(r.code, 2, r.sortie); assert.match(r.sortie, /dans le dépôt de l'outil/);
		assert.ok(!fs.existsSync(dansDepot));
		assert.ok(!fs.existsSync(path.join(etat, "installation.json")));
		// -Profil : seulement avec -Essai, et jamais dans le dépôt de l'outil.
		// -Arreter : même si ce refus disparaissait, jamais une installation réelle (PATH, Démarrage, 8080).
		const profilSeul = await ps("-Profil", path.join(tmp, "profil seul"), "-Arreter");
		assert.equal(profilSeul.code, 2, profilSeul.sortie); assert.match(profilSeul.sortie, /✗ -Profil ne sert qu'avec -Essai/);
		const profilDepot = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", path.join(RACINE, "profil-essai"));
		assert.equal(profilDepot.code, 2, profilDepot.sortie); assert.match(profilDepot.sortie, /-Profil .* dans le dépôt de l'outil/);
		assert.ok(!fs.existsSync(path.join(RACINE, "profil-essai")));
		assert.ok(!fs.existsSync(path.join(etat, "installation.json")));
	});

	test("-Essai -Profil menant au vrai .claude de l'utilisateur (profil réel, casse, barre finale, sous-dossier de .claude) : code 2, rien écrit", async () => {
		// Profil réel lu sans la variable USERPROFILE (celle du test est temporaire), comme l'installeur. Seulement avec
		// -Desinstaller sur un état vide : même si le refus disparaissait, rien n'est écrit dans le vrai profil (le retrait
		// n'agit que sur une copie retenue dans claude-skill.txt, absent ici).
		const vrai = os.userInfo().homedir;
		assert.notEqual(path.resolve(vrai).toLowerCase(), path.resolve(env.USERPROFILE).toLowerCase(), "USERPROFILE du test temporaire");
		const vraiClaude = path.join(vrai, ".claude");
		const lister = () => { try { return fs.readdirSync(path.join(vraiClaude, "skills")).sort().join("|"); } catch { return "(absent)"; } };
		const avant = lister();
		const etatVrai = path.join(tmp, "etat profil réel");
		for (const p of [vrai, vrai.toUpperCase() + "\\", path.join(vraiClaude, "sous-dossier")]) {
			const r = await ps("-Essai", "-Etat", etatVrai, "-Profil", p, "-Desinstaller");
			assert.equal(r.code, 2, `${p} :\n${r.sortie}`);
			assert.match(r.sortie, /✗ -Profil .* mène au vrai dossier \.claude de l'utilisateur/, r.sortie);
		}
		assert.equal(lister(), avant, "vrai .claude\\skills inchangé");
		assert.ok(!fs.existsSync(etatVrai), "rien créé");
		// Un dossier sous le profil réel, hors de son .claude (les dossiers temporaires des tests) : accepté.
		const sousProfil = await ps("-Essai", "-Etat", etatVrai, "-Profil", path.join(tmp, "profil sous le vrai"), "-Arreter");
		assert.doesNotMatch(sousProfil.sortie, /mène au vrai dossier/, sousProfil.sortie);
	});

	test("données dans le dépôt par une jonction : refusées comme le fait le serveur (chemin réel), rien créé", async () => {
		// Sur une copie de installer.ps1 (sa racine est la copie) : la jonction ne mène jamais au vrai dépôt.
		const copie = path.join(tmp, "copie jonction");
		fs.mkdirSync(path.join(copie, "outils"), { recursive: true });
		fs.copyFileSync(SCRIPT, path.join(copie, "outils", "installer.ps1"));
		const lien = path.join(tmp, "lien jonction");
		execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "mklink", "/J", lien, copie], { stdio: "ignore", windowsHide: true });
		const etatJ = path.join(tmp, "etat jonction");
		try {
			const r = await lancer(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(copie, "outils", "installer.ps1"), "-Essai", "-Etat", etatJ, "-Donnees", path.join(lien, "donnees"), "-Port", String(port)], env);
			assert.equal(r.code, 2, r.sortie); assert.match(r.sortie, /dans le dépôt de l'outil/);
			assert.ok(!fs.existsSync(path.join(copie, "donnees")), "aucun dossier créé dans le dépôt");
			assert.ok(!fs.existsSync(path.join(etatJ, "installation.json")));
		} finally {
			// La jonction seule (rmdir sans /s ne suit pas le lien), avant tout nettoyage récursif.
			execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "rmdir", lien], { stdio: "ignore", windowsHide: true });
			fs.rmSync(path.join(copie, "donnees"), { recursive: true, force: true });
		}
		assert.ok(fs.existsSync(path.join(copie, "outils", "installer.ps1")), "la copie est intacte");
	});

	let lienAdmin = "", pid = 0;
	test("installation : une ligne par étape, /api/sante, installation.json lu par la CLI, lien admin sur la sortie", async () => {
		const r = await essai("-Donnees", donnees, "-Port", String(port));
		assert.equal(r.code, 0, r.sortie);
		verifierSortie(r);
		for (const l of ["✓ Prérequis : Node v", "✓ Dossiers : données ", "✓ Port : " + port, "✓ Démarrage : serveur lancé en arrière-plan (PID ",
			"– Démarrage avec Windows : sans objet (-Essai)", "– CLI dans le PATH : sans objet (-Essai)", "✓ Attente : le serveur répond", "– Navigateur : sans objet (-Essai)",
			// En -Essai, les commandes proposées portent -Essai -Etat (que -Essai exige).
			"Désinstaller (les données sont gardées)", `"${CMD}" -Essai -Etat "${etat}" -Arreter`, `"${CMD}" -Essai -Etat "${etat}" -Desinstaller`,
			`"${CMD}" -Essai -Etat "${etat}" -Demarrer`,
			// Raccourci Claude Code : jamais en -Essai sans -Profil (même avec un %USERPROFILE%\.claude).
			"– Raccourci Claude Code : sans objet (-Essai sans -Profil)",
			// D1 : la phrase à dire à son agent, avec l'adresse du serveur, nomme la CLI et la commande de départ.
			`« Branche ce dépôt sur le serveur de retours http://127.0.0.1:${port} (projet <P>) avec la CLI outil : lance outil methode et suis le § 0. »`,
			"bloc « Brancher un dépôt de code »"]) assert.ok(r.sortie.includes(l), `« ${l} » attendu :\n${r.sortie}`);
		assert.doesNotMatch(r.sortie, /^✗/m);
		assert.ok(!r.sortie.includes(MASQUE_PROJET), "pas de ligne sur la copie personnelle sans copie posée");
		assert.ok(!fs.existsSync(path.join(env.USERPROFILE, ".claude", "skills")), "rien écrit dans %USERPROFILE%\\.claude");
		assert.ok(!fs.existsSync(path.join(etat, "claude-skill.txt")));
		pid = pidLu();
		assert.ok(vivant(pid), "PID du serveur vivant");
		assert.ok(r.sortie.includes(`(PID ${pid})`));
		assert.ok(await sante(port), "/api/sante");
		// installation.json : {outil, donnees, port, url}, sans secret, à l'endroit où la CLI le cherche.
		const inst = JSON.parse(fs.readFileSync(path.join(etat, "installation.json"), "utf8").replace(/^\uFEFF/, ""));
		assert.deepEqual(Object.keys(inst), ["outil", "donnees", "port", "url"]);
		assert.deepEqual(inst, { outil: RACINE, donnees, port, url: `http://127.0.0.1:${port}` });
		assert.equal(serveurInstallation({ LOCALAPPDATA: env.LOCALAPPDATA })?.serveur, `http://127.0.0.1:${port}`);
		assert.ok(fs.existsSync(path.join(donnees, "outil.sqlite")));
		// Le serveur tient le verrou de ses données (PID du node qui écoute, port réel).
		const verrou = JSON.parse(fs.readFileSync(path.join(donnees, "serveur.verrou"), "utf8"));
		assert.equal(verrou.pid, pid); assert.equal(verrou.port, port); assert.equal(verrou.ecoute, true);
		const journal = fs.readFileSync(path.join(etat, "serveur.log"), "utf8");
		assert.match(journal, /démarrage par installer\.ps1/); assert.ok(journal.includes(`(PID ${pid})`), "le PID écrit est celui du node qui écoute");
		lienAdmin = lienDe(r.sortie, "Lien admin");
		assert.equal(fs.readFileSync(path.join(donnees, "lien-admin.txt"), "utf8").trim(), lienAdmin);
		assert.ok(lienAdmin.startsWith(`http://127.0.0.1:${port}/invitation/`));
	});

	test("-Reconnecter sans admin : le lien de création sert", async () => {
		const r = await essai("-Reconnecter");
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /Aucun compte admin encore/);
		assert.equal(lienDe(r.sortie, "Lien de reconnexion"), lienAdmin);
		assert.equal(pidLu(), pid, "pas relancé");
	});

	test("le lien admin crée le compte admin (formulaire), puis lien-admin.txt disparaît", async () => {
		const u = new URL(lienAdmin);
		const f = await appel(u.origin, u.pathname);
		assert.equal(f.status, 200); assert.match(f.texte, /<form method="post">/);
		const r = await appel(u.origin, u.pathname, { brut: "nom=Administratrice", entetes: { "Content-Type": "application/x-www-form-urlencoded" } });
		assert.equal(r.status, 303); assert.equal(r.entetes.get("location"), "/");
		const cookie = (r.entetes.get("set-cookie") || "").split(";")[0];
		const moi = await appel(u.origin, "/api/moi", { cookie });
		assert.equal(moi.status, 200); assert.equal(moi.corps.compte.admin, true);
		assert.ok(!fs.existsSync(path.join(donnees, "lien-admin.txt")));
	});

	test("deuxième lancement : pas relancé (même PID), plus de lien admin, l'accueil à la place", async () => {
		const r = await essai("-Donnees", donnees, "-Port", String(port));
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.ok(r.sortie.includes(`– Démarrage : le serveur tourne déjà (PID ${pid}), pas relancé`), r.sortie);
		assert.match(r.sortie, /– Port : \d+ \(serveur déjà lancé\)/);
		assert.equal(pidLu(), pid);
		assert.doesNotMatch(r.sortie, /^Lien admin \(-Essai\)/m);
		assert.ok(r.sortie.includes(`Accueil (-Essai) : http://127.0.0.1:${port}/`));
	});

	// Profils temporaires du raccourci Claude Code (tiennent lieu de %USERPROFILE%) ; P1 sert aussi à -Desinstaller.
	let profil1 = "", profil2 = "", posee = Buffer.alloc(0);
	const MODIFIE = "---\nname: site-retours-outil\ndescription: copie modifiée à la main\n---\n";
	test("raccourci Claude Code (-Essai -Profil) : copie du modèle, déjà à jour, fichier différent laissé, pas de .claude → sans objet", async () => {
		profil1 = path.join(tmp, "profil un"); profil2 = path.join(tmp, "profil deux");
		const profil3 = path.join(tmp, "profil sans claude");
		for (const p of [profil1, profil2]) fs.mkdirSync(path.join(p, ".claude"), { recursive: true });
		fs.mkdirSync(profil3, { recursive: true });
		const modele = fs.readFileSync(SKILL); // lu maintenant : le modèle peut changer d'un lot à l'autre
		const cible1 = skillDans(profil1);
		const r1 = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", profil1);
		assert.equal(r1.code, 0, r1.sortie); verifierSortie(r1);
		assert.ok(r1.sortie.includes(`✓ Raccourci Claude Code : ${cible1}`), r1.sortie);
		assert.ok(fs.readFileSync(cible1).equals(modele), "copie octet pour octet du modèle");
		// Même nom que la copie d'un dépôt branché, qu'elle masque dans Claude Code : le résumé dit de relancer l'installeur.
		const masque = `Raccourci Claude Code (${cible1}) : ${MASQUE_PROJET}`;
		assert.ok(r1.sortie.includes(masque) && r1.sortie.includes(`relance "${CMD}" -Essai -Etat "${etat}" après chaque mise à jour de l'outil`), r1.sortie);
		posee = modele;
		const marque = fs.readFileSync(path.join(etat, "claude-skill.txt"), "utf8").split(/\r?\n/);
		assert.match(marque[0], /^[0-9A-F]{64}$/); assert.equal(marque[1], cible1, "empreinte retenue pour ce chemin");
		const r2 = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", profil1);
		assert.equal(r2.code, 0, r2.sortie);
		assert.ok(r2.sortie.includes(`✓ Raccourci Claude Code : ${cible1} déjà à jour`) && r2.sortie.includes(masque), r2.sortie);
		// Copie posée par une version précédente du modèle, pas modifiée depuis (même empreinte) : mise à jour (oui par défaut).
		const ancienne = "---\nname: site-retours-outil\ndescription: ancienne version du modèle\n---\n";
		fs.writeFileSync(cible1, ancienne);
		fs.writeFileSync(path.join(etat, "claude-skill.txt"), `${createHash("sha256").update(ancienne).digest("hex").toUpperCase()}\r\n${cible1}\r\n`);
		const rMaj = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", profil1);
		assert.equal(rMaj.code, 0, rMaj.sortie);
		assert.ok(rMaj.sortie.includes(`✓ Raccourci Claude Code : ${cible1} mis à jour`) && rMaj.sortie.includes(masque), rMaj.sortie);
		assert.ok(fs.readFileSync(cible1).equals(modele));
		// Un fichier différent déjà là : jamais remplacé sans « oui » explicite (-Essai répond la valeur par défaut : non).
		const cible2 = skillDans(profil2);
		fs.mkdirSync(path.dirname(cible2), { recursive: true });
		fs.writeFileSync(cible2, MODIFIE);
		const r3 = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", profil2);
		assert.equal(r3.code, 0, r3.sortie); verifierSortie(r3);
		assert.ok(r3.sortie.includes(`– Raccourci Claude Code : ${cible2} différent de celui de l'outil, laissé tel quel`), r3.sortie);
		assert.equal(fs.readFileSync(cible2, "utf8"), MODIFIE);
		assert.ok(!r3.sortie.includes(MASQUE_PROJET), "fichier de l'utilisateur laissé : pas de ligne sur la copie de l'outil");
		assert.equal(fs.readFileSync(path.join(etat, "claude-skill.txt"), "utf8").split(/\r?\n/)[1], cible1, "empreinte de P1 gardée");
		const r4 = await essai("-Donnees", donnees, "-Port", String(port), "-Profil", profil3);
		assert.equal(r4.code, 0, r4.sortie);
		assert.ok(r4.sortie.includes(`– Raccourci Claude Code : sans objet (pas de dossier ${path.join(profil3, ".claude")})`), r4.sortie);
		assert.ok(!fs.existsSync(path.join(profil3, ".claude")), "aucun dossier .claude créé");
		assert.equal(pidLu(), pid, "pas relancé");
	});

	test("-Reconnecter : lien de reconnexion du premier admin, qui donne une session admin", async () => {
		const r = await essai("-Reconnecter");
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /✓ Lien de reconnexion créé/);
		const lien = lienDe(r.sortie, "Lien de reconnexion");
		assert.notEqual(lien, lienAdmin);
		assert.equal(fs.readFileSync(path.join(donnees, "lien-admin.txt"), "utf8").trim(), lien);
		const u = new URL(lien);
		const g = await appel(u.origin, u.pathname);
		assert.equal(g.status, 200); assert.match(g.texte, /Reconnexion/); assert.match(g.texte, /Administratrice/);
		const p = await appel(u.origin, u.pathname, { brut: "", entetes: { "Content-Type": "application/x-www-form-urlencoded" } });
		assert.equal(p.status, 303);
		const moi = await appel(u.origin, "/api/moi", { cookie: (p.entetes.get("set-cookie") || "").split(";")[0] });
		assert.equal(moi.status, 200); assert.equal(moi.corps.compte.admin, true);
		assert.equal(pidLu(), pid, "pas relancé");
	});

	test("-Arreter par installer.cmd (arguments transmis, pas de pause) : processus mort, serveur.pid retiré", async () => {
		const r = await lancer(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${CMD}" -Essai -Etat "${etat}" -Arreter"`], env, { verbatim: true });
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.ok(r.sortie.includes(`✓ Serveur arrêté (PID ${pid})`), r.sortie);
		assert.ok(await attendreMort(pid), "processus du serveur mort");
		assert.equal(await sante(port), false);
		assert.ok(!fs.existsSync(path.join(etat, "serveur.pid")));
		const encore = await essai("-Arreter");
		assert.equal(encore.code, 0); assert.match(encore.sortie, /– Aucun serveur de cette installation ne tourne/);
	});

	test("-Demarrer : relancé sur le même port, avec les mêmes données", async () => {
		const r = await essai("-Demarrer");
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /✓ Démarrage : serveur lancé/); assert.match(r.sortie, /✓ Attente : le serveur répond/);
		const nouveau = pidLu();
		assert.notEqual(nouveau, pid); assert.ok(vivant(nouveau));
		assert.ok(await sante(port));
		pid = nouveau;
		const encore = await essai("-Demarrer");
		assert.equal(encore.code, 0, encore.sortie); assert.ok(encore.sortie.includes(`le serveur tourne déjà (PID ${pid})`));
	});

	// Étape 3.7 : un serveur lancé avant une mise à jour de l'outil exécute l'ancien code ; l'installeur le redémarre
	// (oui par défaut ; -Essai prend la réponse par défaut). La date du code est celle du fichier le plus récent de
	// serveur/src, serveur/ui et site : un fichier du site est « touché », puis remis à sa date.
	test("code de l'outil modifié depuis le démarrage : ancien serveur arrêté et relancé ; sinon pas relancé", async () => {
		const f = path.join(RACINE, "site", "SCHEMA.md");
		const st = fs.statSync(f);
		const maintenant = new Date(Date.now() + 2000);
		fs.utimesSync(f, maintenant, maintenant);
		try {
			const r = await essai("-Demarrer");
			assert.equal(r.code, 0, r.sortie); verifierSortie(r);
			assert.ok(r.sortie.includes(`! le serveur (PID ${pid}) a démarré avant la dernière mise à jour de l'outil`), r.sortie);
			assert.ok(r.sortie.includes(`✓ Démarrage : ancien serveur arrêté (PID ${pid}), relancé avec le code à jour`), r.sortie);
			assert.match(r.sortie, /✓ Attente : le serveur répond/);
			const nouveau = pidLu();
			assert.notEqual(nouveau, pid); assert.ok(await attendreMort(pid), "ancien serveur arrêté");
			pid = nouveau;
		} finally { fs.utimesSync(f, st.atime, st.mtime); }
		const encore = await essai("-Demarrer");
		assert.ok(encore.sortie.includes(`– Démarrage : le serveur tourne déjà (PID ${pid}), pas relancé`), encore.sortie);
	});

	test("-Restaurer : pas une sauvegarde → refus ; une sauvegarde → arrêt, restauration, anciennes données gardées, relance", async () => {
		const pasSauv = await essai("-Restaurer", tmp);
		assert.equal(pasSauv.code, 1, pasSauv.sortie); verifierSortie(pasSauv);
		assert.match(pasSauv.sortie, /✗ Restauration : .* n'est pas une sauvegarde \(manifeste\.json absent\)/);
		assert.ok(vivant(pid), "serveur laissé tel quel");
		// Une sauvegarde d'un autre serveur (projet « verger »), faite par l'Administration.
		const { serveurTest, session, projet } = await import("../../serveur/test/aide.ts");
		const autre = path.join(base, "autre-donnees");
		const s = await serveurTest(autre, { sauvegarde: path.join(base, "autre-sauv") });
		let nom = "";
		try {
			await projet(s.url, "verger");
			const adm = await session(s.url, "verger", "adm", "admin", "Adèle");
			const r = await appel(s.url, "/api/admin/sauvegarde", { cookie: adm, corps: {} });
			assert.equal(r.status, 201, r.texte); nom = r.corps.sauvegarde.nom;
		} finally { await s.arreter(); }
		const r = await essai("-Restaurer", path.join(base, "autre-sauv", nom));
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /✓ Serveur arrêté/);
		assert.match(r.sortie, /✓ Restauration : sauvegarde du .* restaurée dans .*\(\d+ fichiers, projets : verger\) ; données d'avant gardées dans .*avant-restauration-/);
		assert.match(r.sortie, /✓ Attente : le serveur répond/);
		const nouveau = pidLu(); assert.notEqual(nouveau, pid); pid = nouveau;
		assert.ok(fs.existsSync(path.join(donnees, "projets", "verger", "depot")), "projet restauré");
		assert.ok(fs.readdirSync(path.dirname(donnees)).some(n => n.startsWith(path.basename(donnees) + ".avant-restauration-")), "anciennes données à côté");
	});

	test("chemin d'état à « %OS% » : cmd ne le développe pas, le journal (et le lien admin) est au bon endroit", async () => {
		// OS défini dans l'environnement (environnement() ne le transmet pas) : sinon cmd n'aurait rien à développer.
		const envOs = { ...env, OS: process.env.OS || "Windows_NT" };
		const etatPct = path.join(tmp, "a%OS%b", "etat"), donneesPct = path.join(tmp, "données %OS%"), p = await portLibreSauf8080();
		const r = await lancer(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Essai", "-Etat", etatPct, "-Donnees", donneesPct, "-Port", String(p)], envOs);
		const lu = fs.existsSync(path.join(etatPct, "serveur.pid")) ? pidDe(etatPct) : 0;
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		const journal = fs.readFileSync(path.join(etatPct, "serveur.log"), "utf8");
		assert.match(journal, /démarrage par installer\.ps1/); assert.ok(journal.includes(`(PID ${lu})`), journal);
		assert.match(journal, /\/invitation\//, "le lien admin est dans le journal annoncé");
		assert.ok(!fs.existsSync(path.join(tmp, `a${envOs.OS}b`)), "aucun dossier au nom développé");
		assert.ok(await sante(p));
		const a = await lancer(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Essai", "-Etat", etatPct, "-Arreter"], envOs);
		assert.equal(a.code, 0, a.sortie); assert.ok(a.sortie.includes(`✓ Serveur arrêté (PID ${lu})`), a.sortie);
		assert.ok(await attendreMort(lu));
	});

	test("serveur étranger : jamais pris pour le nôtre (serveur.pid ancien format, ou autre heure de démarrage), jamais arrêté ; ses données refusées à une autre installation", async () => {
		const donneesE = path.join(tmp, "données étrangères"), pE = await portLibreSauf8080();
		const etranger = await serveurEtranger(donneesE, pE);
		const etatE = path.join(tmp, "etat étranger");
		fs.mkdirSync(etatE, { recursive: true });
		for (const contenu of [`${etranger.pid}\r\n`, `${etranger.pid} 123456789\r\n`]) {
			fs.writeFileSync(path.join(etatE, "serveur.pid"), contenu);
			const r = await ps("-Essai", "-Etat", etatE, "-Arreter");
			assert.equal(r.code, 0, r.sortie);
			assert.match(r.sortie, /– Aucun serveur de cette installation ne tourne/, r.sortie);
			assert.ok(vivant(etranger.pid!) && await sante(pE), `serveur étranger toujours vivant (serveur.pid « ${contenu.trim()} »)`);
		}
		// Une autre installation sur ces données : refusée avant toute écriture, aucun second serveur.
		const etatF = path.join(tmp, "etat second"), pF = await portLibreSauf8080();
		const r = await ps("-Essai", "-Etat", etatF, "-Donnees", donneesE, "-Port", String(pF));
		if (fs.existsSync(path.join(etatF, "serveur.pid"))) pidDe(etatF);
		assert.equal(r.code, 1, r.sortie); verifierSortie(r);
		assert.ok(r.sortie.includes(`✗ Dossiers : un serveur utilise déjà ce dossier de données (PID ${etranger.pid}, port ${pE}) : l'arrêter d'abord`), r.sortie);
		assert.ok(!fs.existsSync(path.join(etatF, "installation.json")), "installation.json non écrit");
		assert.equal(await sante(pF), false, "aucun second serveur");
		assert.ok(vivant(etranger.pid!) && await sante(pE));
		etranger.kill();
	});

	test("verrou périmé (PID vivant mais pas un serveur, port muet, comme après taskkill /F puis PID repris) : pas de refus, le serveur le reprend", async () => {
		const donneesV = path.join(tmp, "données verrou périmé"), etatV = path.join(tmp, "etat verrou périmé"), pV = await portLibreSauf8080(), muet = await portLibreSauf8080();
		fs.mkdirSync(donneesV, { recursive: true });
		// PID de ce processus de test : vivant, démarré avant le verrou, mais rien n'écoute sur le port du verrou.
		fs.writeFileSync(path.join(donneesV, "serveur.verrou"), JSON.stringify({ pid: process.pid, port: muet, hote: "127.0.0.1", debut: new Date().toISOString(), ecoute: true, jeton: "ancien" }) + "\n");
		const r = await ps("-Essai", "-Etat", etatV, "-Donnees", donneesV, "-Port", String(pV));
		const lu = fs.existsSync(path.join(etatV, "serveur.pid")) ? pidDe(etatV) : 0;
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		const v = JSON.parse(fs.readFileSync(path.join(donneesV, "serveur.verrou"), "utf8"));
		assert.equal(v.pid, lu); assert.equal(v.port, pV); assert.notEqual(v.jeton, "ancien");
		const a = await ps("-Essai", "-Etat", etatV, "-Arreter");
		assert.equal(a.code, 0, a.sortie); assert.ok(await attendreMort(lu));
	});

	test("base abîmée : accès ouverts signalés, « s'est arrêté au démarrage » (pas « après 30 s »), installation.json non écrit, verrou rendu", async () => {
		const donneesC = path.join(tmp, "données abîmées"), etatC = path.join(tmp, "etat abîmé"), pC = await portLibreSauf8080();
		fs.mkdirSync(donneesC, { recursive: true });
		fs.writeFileSync(path.join(donneesC, "outil.sqlite"), "pas une base\n");
		// Dossier ouvert aux Utilisateurs authentifiés (S-1-5-11), comme un dossier créé à la racine d'un disque.
		execFileSync("icacls", [donneesC, "/grant", "*S-1-5-11:(OI)(CI)R"], { stdio: "ignore", windowsHide: true });
		const debut = Date.now();
		const r = await ps("-Essai", "-Etat", etatC, "-Donnees", donneesC, "-Port", String(pC));
		if (fs.existsSync(path.join(etatC, "serveur.pid"))) pidDe(etatC);
		assert.equal(r.code, 1, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /! le dossier des données est ouvert à d'autres comptes de ce poste/);
		assert.match(r.sortie, /icacls ".*" \/inheritance:r \/grant:r \*S-1-5-21-[\d-]+:\(OI\)\(CI\)F/);
		assert.match(r.sortie, /✗ Attente : le serveur s'est arrêté au démarrage/);
		assert.doesNotMatch(r.sortie, /après 30 s/);
		assert.match(r.sortie, /démarrage impossible/, "fin du journal montrée");
		assert.ok(Date.now() - debut < 25000, "sans attendre 30 s");
		assert.ok(!fs.existsSync(path.join(etatC, "installation.json")), "installation.json écrit seulement après un démarrage réussi");
		assert.ok(!fs.existsSync(path.join(donneesC, "serveur.verrou")), "verrou rendu");
	});

	test("-Demarrer d'une installation -Reseau : avertissement réseau, même si le démarrage échoue (port pris)", async () => {
		// Port tenu par le test sur 127.0.0.1 : le serveur n'est jamais lancé sur 0.0.0.0 (pas de fenêtre du pare-feu).
		const etatR = path.join(tmp, "etat réseau"), pR = await portLibreSauf8080();
		fs.mkdirSync(etatR, { recursive: true });
		fs.writeFileSync(path.join(etatR, "installation.json"), JSON.stringify({ outil: RACINE, donnees: path.join(tmp, "données réseau"), port: pR, url: `http://poste-essai:${pR}` }));
		const tenu = net.createServer();
		await new Promise<void>(ok => tenu.listen(pR, "127.0.0.1", () => ok()));
		try {
			const r = await ps("-Essai", "-Etat", etatR, "-Demarrer");
			assert.equal(r.code, 1, r.sortie); verifierSortie(r);
			assert.match(r.sortie, /! -Reseau : écoute sur 0\.0\.0\.0 \(http:\/\/poste-essai:\d+\)\. HTTP en clair/);
			assert.match(r.sortie, /Pour revenir en local : ".*installer\.cmd" -Essai -Etat "[^"]+" -Arreter, puis ".*installer\.cmd" -Essai -Etat "[^"]+" sans -Reseau/);
			assert.ok(r.sortie.includes(`✗ Démarrage : le port ${pR} est pris par un autre programme`), r.sortie);
		} finally { await new Promise(ok => tenu.close(ok)); }
	});

	test("-Desinstaller sans installation : « – Aucune installation », rien d'annoncé comme retiré", async () => {
		const r = await ps("-Essai", "-Etat", path.join(tmp, "etat vide"), "-Desinstaller");
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.match(r.sortie, /– Aucune installation dans .*etat vide/);
		assert.doesNotMatch(r.sortie, /Installation retirée/);
	});

	test("-Desinstaller : arrêté, installation retirée, données gardées et dites ; raccourci Claude Code retiré seulement s'il est identique à la copie posée", async () => {
		// Copie posée puis modifiée : laissée.
		const cible1 = skillDans(profil1);
		fs.writeFileSync(cible1, MODIFIE);
		const r = await essai("-Profil", profil1, "-Desinstaller");
		assert.equal(r.code, 0, r.sortie); verifierSortie(r);
		assert.ok(r.sortie.includes(`– Raccourci Claude Code : ${cible1} modifié depuis sa pose, laissé tel quel`), r.sortie);
		assert.equal(fs.readFileSync(cible1, "utf8"), MODIFIE);
		// Remise à l'identique de la copie posée : retirée (et son dossier vide), le reste de .claude gardé.
		fs.writeFileSync(cible1, posee);
		const r2 = await essai("-Profil", profil1, "-Desinstaller");
		assert.equal(r2.code, 0, r2.sortie); verifierSortie(r2);
		assert.ok(r2.sortie.includes(`✓ Raccourci Claude Code : ${cible1} retiré`), r2.sortie);
		assert.ok(!fs.existsSync(path.dirname(cible1)), "dossier site-retours-outil retiré");
		assert.ok(fs.existsSync(path.join(profil1, ".claude", "skills")), "le reste de .claude est gardé");
		assert.ok(!fs.existsSync(path.join(etat, "claude-skill.txt")), "empreinte retirée");
		// Un fichier que l'installeur n'a pas posé : laissé.
		const r3 = await essai("-Profil", profil2, "-Desinstaller");
		assert.equal(r3.code, 0, r3.sortie);
		assert.ok(r3.sortie.includes(`– Raccourci Claude Code : ${skillDans(profil2)} n'a pas été posé par l'installeur, laissé tel quel`), r3.sortie);
		assert.equal(fs.readFileSync(skillDans(profil2), "utf8"), MODIFIE);
		assert.ok(r.sortie.includes(`✓ Serveur arrêté (PID ${pid})`), r.sortie);
		assert.match(r.sortie, /– Démarrage avec Windows et PATH : sans objet \(-Essai\)/);
		assert.ok(r.sortie.includes(`Données gardées : ${donnees}`), r.sortie);
		assert.ok(await attendreMort(pid));
		assert.equal(await sante(port), false);
		assert.ok(fs.existsSync(path.join(donnees, "outil.sqlite")), "données gardées");
		assert.ok(!fs.existsSync(path.join(etat, "installation.json")));
		assert.equal(serveurInstallation({ LOCALAPPDATA: env.LOCALAPPDATA }), null);
		const apres = await essai("-Demarrer");
		assert.equal(apres.code, 1); assert.match(apres.sortie, /✗ aucune installation/);
	});

	test("PATH utilisateur (fonctions de l'installeur, sur une clé de registre temporaire) : type et %…% gardés, entrée de l'utilisateur laissée", async () => {
		// Jamais HKCU\Environment : les fonctions sont extraites du script et visent une clé jetable, sans WM_SETTINGCHANGE.
		const texte = fs.readFileSync(SCRIPT, "utf8");
		assert.doesNotMatch(texte, /SetEnvironmentVariable\('Path'/, "le PATH ne passe que par $CLE_ENVIRONNEMENT");
		const cle = `HKCU:\\Software\\Vaevia-essai-${process.pid}-${Date.now()}`;
		const cli = path.join(RACINE, "cli");
		const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
		const essaiPs = path.join(tmp, "essai-path.ps1");
		fs.writeFileSync(essaiPs, "\uFEFF" + `Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$noms = @('Lire-PathUtilisateur', 'Ecrire-PathUtilisateur', 'Entrees-PathUtilisateur', 'Est-EntreeCli', 'Cli-DansPath', 'Ajouter-CliPath', 'Retirer-CliPath', 'Ecrire-Texte', 'Ecrire-Avertissement')
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(SCRIPT)}, [ref]$null, [ref]$null)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { if ($noms -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) } }
function Annoncer-Environnement { }
$Essai = $false; $UTF8 = New-Object System.Text.UTF8Encoding $false
$CLE_ENVIRONNEMENT = ${q(cle)}; $CLI = ${q(cli)}; $FICHIER_PATH_AJOUTE = ${q(path.join(tmp, "cli-path.txt"))}
$brut = { $k = Get-Item -LiteralPath $CLE_ENVIRONNEMENT; @{ v = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); t = [string]$k.GetValueKind('Path') } }
[void](New-Item -Path $CLE_ENVIRONNEMENT -Force)
try {
	[void](New-ItemProperty -LiteralPath $CLE_ENVIRONNEMENT -Name 'Path' -Value '%USERPROFILE%\\a;%WDD_JAMAIS_DEFINIE%\\b' -PropertyType ExpandString)
	$r = [ordered]@{ avant = (Cli-DansPath) }
	Ajouter-CliPath
	$r.ajout = & $brut; $r.marque = Test-Path -LiteralPath $FICHIER_PATH_AJOUTE; $r.dans = (Cli-DansPath)
	$r.retrait = Retirer-CliPath; $r.apres = & $brut; $r.marqueApres = Test-Path -LiteralPath $FICHIER_PATH_AJOUTE
	# Entrée mise par l'utilisateur lui-même (REG_SZ, sans marque) : laissée par -Desinstaller.
	Set-ItemProperty -LiteralPath $CLE_ENVIRONNEMENT -Name 'Path' -Value ('C:\\x;' + $CLI) -Type String
	$r.dansUtilisateur = (Cli-DansPath); $r.retraitUtilisateur = Retirer-CliPath; $r.apresUtilisateur = & $brut
	$r | ConvertTo-Json -Compress -Depth 3
} finally { Remove-Item -LiteralPath $CLE_ENVIRONNEMENT -Recurse -Force }
`);
		const r = await lancer(POWERSHELL, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", essaiPs], env);
		assert.equal(r.code, 0, r.sortie);
		const o = JSON.parse(r.sortie.trim().split(/\r?\n/).pop()!);
		assert.equal(o.avant, false);
		assert.deepEqual(o.ajout, { v: `%USERPROFILE%\\a;%WDD_JAMAIS_DEFINIE%\\b;${cli}`, t: "ExpandString" }, "valeur brute et type gardés");
		assert.equal(o.marque, true); assert.equal(o.dans, true);
		assert.equal(o.retrait, "retire");
		assert.deepEqual(o.apres, { v: "%USERPROFILE%\\a;%WDD_JAMAIS_DEFINIE%\\b", t: "ExpandString" });
		assert.equal(o.marqueApres, false);
		assert.equal(o.dansUtilisateur, true); assert.equal(o.retraitUtilisateur, "pas-ajoute");
		assert.deepEqual(o.apresUtilisateur, { v: `C:\\x;${cli}`, t: "String" });
		assert.equal(spawnSync("reg", ["query", cle.replace(/^HKCU:/, "HKCU")], { stdio: "ignore", windowsHide: true }).status, 1, "clé temporaire retirée");
	});

	test(".gitignore : .env et ses variantes ignorés, .env.exemple suivi", () => {
		const ignore = (f: string) => spawnSync("git", ["-C", RACINE, "check-ignore", "-q", "--no-index", f], { windowsHide: true }).status === 0;
		for (const f of [".env", ".env.local", ".env.prod"]) assert.ok(ignore(f), `${f} ignoré`);
		assert.equal(ignore(".env.exemple"), false, ".env.exemple suivi");
	});

	test("-Essai n'a touché ni au PATH utilisateur ni au dossier Démarrage réels", () => {
		assert.equal(pathUtilisateur(), pathAvant);
		assert.deepEqual(raccourcis(demarrages), raccourcisAvant);
		assert.ok(demarrages[0], "dossier Démarrage réel lu");
	});
});

