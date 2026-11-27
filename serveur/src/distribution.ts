// Distribution de la CLI « outil » par le serveur lui-même (27/11/2026) : un développeur (ou son agent) l'installe avec
// une ligne, sans cloner le dépôt de l'outil ni régler son PATH à la main. Hôte principal seulement, sans
// authentification : la CLI ne contient aucun secret (le jeton s'obtient ensuite par « outil installer », un clic).
//   GET /outil                      mode d'emploi en texte (pour l'humain et pour l'agent) : la ligne à lancer
//   GET /outil/installer.mjs        l'installeur, en JavaScript, que la ligne télécharge et exécute avec Node
//   GET /outil/vaevia-outil.tar.gz  la CLI : cli/ (sans les tests), methode/, VERSION, les deux règles de site/
// Une seule ligne, la même dans cmd, PowerShell, Git Bash, Linux et macOS : « node -e "fetch(…).then(…import(…))" ».
// Node est requis de toute façon par la CLI. Pas de « powershell … irm … | iex » : Microsoft Defender le classe comme
// cheval de Troie (Trojan:Win32/Commando.B!ml) et bloque le processus (constaté le 27/11/2026).
// L'installeur n'installe pas Node : sans Node 24 ou plus, il le dit et s'arrête (installer un logiciel est un choix de
// l'humain). Dossiers : Windows %LOCALAPPDATA%\Programs\vaevia-outil (PATH de l'utilisateur) ; ailleurs
// ~/.local/share/vaevia-outil et un lanceur ~/.local/bin/outil. VAEVIA_OUTIL_DOSSIER, VAEVIA_OUTIL_BIN et
// VAEVIA_OUTIL_SANS_PATH=1 et VAEVIA_OUTIL_CLE servent aux tests.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RACINE_OUTIL } from "./config.ts";

export const NOM_ARCHIVE = "vaevia-outil";

// Les fichiers de la CLI, relatifs à la racine de l'outil ; null si la CLI n'est pas dans cette installation.
export function fichiersCli(racine = RACINE_OUTIL): string[] | null {
	const cli = path.join(racine, "cli");
	if (!fs.existsSync(path.join(cli, "outil.ts"))) return null;
	const r: string[] = ["VERSION", "site/valider-notes.js", "site/changements.js"].filter(f => fs.existsSync(path.join(racine, f)));
	for (const f of fs.readdirSync(cli, { withFileTypes: true })) if (f.isFile()) r.push("cli/" + f.name);
	const parcourir = (rel: string) => {
		for (const f of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
			const p = rel + "/" + f.name;
			if (f.isDirectory()) parcourir(p); else if (f.isFile()) r.push(p);
		}
	};
	if (fs.existsSync(path.join(racine, "methode"))) parcourir("methode");
	return r.sort();
}

// Archive tar (ustar) compressée : noms sous « vaevia-outil/ », lanceurs exécutables, dates de la VERSION.
function entete(nom: string, taille: number, mode: number, mtime: number, type: "0" | "5"): Buffer {
	const b = Buffer.alloc(512);
	const ecrire = (s: string, debut: number, long: number) => b.write(s, debut, long, "utf8");
	const octal = (n: number, long: number) => n.toString(8).padStart(long - 1, "0") + "\0";
	let nomCourt = nom, prefixe = "";
	if (Buffer.byteLength(nom) > 100) {
		const i = nom.lastIndexOf("/", 154);
		if (i <= 0 || Buffer.byteLength(nom.slice(i + 1)) > 100) throw new Error("nom trop long pour l'archive : " + nom);
		prefixe = nom.slice(0, i); nomCourt = nom.slice(i + 1);
	}
	ecrire(nomCourt, 0, 100); ecrire(octal(mode, 8), 100, 8); ecrire(octal(0, 8), 108, 8); ecrire(octal(0, 8), 116, 8);
	ecrire(octal(taille, 12), 124, 12); ecrire(octal(mtime, 12), 136, 12); b.fill(" ", 148, 156); ecrire(type, 156, 1);
	ecrire("ustar\0", 257, 6); ecrire("00", 263, 2); ecrire(prefixe, 345, 155);
	let somme = 0; for (const o of b) somme += o;
	ecrire(somme.toString(8).padStart(6, "0") + "\0 ", 148, 8);
	return b;
}
export function archiveCli(racine = RACINE_OUTIL): Buffer | null {
	const fichiers = fichiersCli(racine);
	if (!fichiers) return null;
	let mtime = Math.floor(Date.now() / 1000);
	try { mtime = Math.floor(fs.statSync(path.join(racine, "VERSION")).mtimeMs / 1000); } catch { }
	const morceaux: Buffer[] = [];
	const dossiers = new Set<string>();
	for (const f of fichiers) {
		const parties = f.split("/");
		for (let i = 1; i < parties.length; i++) {
			const d = parties.slice(0, i).join("/");
			if (!dossiers.has(d)) { dossiers.add(d); morceaux.push(entete(`${NOM_ARCHIVE}/${d}/`, 0, 0o755, mtime, "5")); }
		}
		const contenu = fs.readFileSync(path.join(racine, f));
		const executable = f === "cli/outil";
		morceaux.push(entete(`${NOM_ARCHIVE}/${f}`, contenu.length, executable ? 0o755 : 0o644, mtime, "0"), contenu);
		const reste = contenu.length % 512;
		if (reste) morceaux.push(Buffer.alloc(512 - reste));
	}
	morceaux.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(morceaux), { level: 9 });
}

// L'adresse que les scripts téléchargent : WDD_URL, sinon l'origine de la requête (un seul hôte, tout Host accepté).
export function origineServeur(url: string, req: IncomingMessage): string {
	if (url) return url;
	const hote = String(req.headers.host || "127.0.0.1").replace(/[^A-Za-z0-9.:[\]-]/g, "");
	return `http://${hote}`;
}

// La ligne à lancer : sans « $ », « ! », « % », « & », « | » ni accent grave, elle se lit pareil dans cmd, PowerShell
// et sh. L'adresse ne contient ni guillemet ni apostrophe (origineServeur, et WDD_URL validée comme une origine).
export const ligneInstallation = (u: string) =>
	`node -e "fetch('${u}/outil/installer.mjs').then(r=>r.text()).then(t=>import('data:text/javascript,'+encodeURIComponent(t))).catch(e=>{console.error('outil : installation impossible depuis ${u} : '+(e.cause?e.cause:e).message);process.exitCode=1})"`;

export function texteOutil(u: string, version: string): string {
	return [
		`Vaevia (version ${version}) : la CLI « outil », pour brancher un dépôt de code sur ce serveur (${u}).`,
		"",
		"Il faut Node 24 ou plus, et Git, sur le poste. Sans Node : l'installer d'abord (Windows : winget install OpenJS.NodeJS.LTS ;",
		"Linux, macOS : le gestionnaire de paquets), puis rouvrir le terminal.",
		"",
		"Installer la CLI : une ligne, la même dans cmd, PowerShell, Git Bash, Linux et macOS (dossier de l'utilisateur, sans",
		"droits d'administrateur ; relancer la même ligne met à jour) :",
		"",
		`  ${ligneInstallation(u)}`,
		"",
		"Elle affiche le chemin complet de « outil » : s'en servir dans le terminal déjà ouvert, dont le PATH n'a pas changé.",
		"Ensuite, dans le dépôt du code : outil methode, puis suivre le § 0.",
		"",
	].join("\n");
}

// Mise à jour du PATH de l'utilisateur sous Windows : relu tel quel (ses %…% restent), réécrit avec son type d'origine,
// puis WM_SETTINGCHANGE pour les terminaux ouverts ensuite. Fichier local lancé par -File (rien n'est téléchargé par
// PowerShell). Le dossier à ajouter arrive par VAEVIA_CLI. Sortie : « ajoute » ou « deja ».
const PATH_WINDOWS = String.raw`$ErrorActionPreference = 'Stop'
# VAEVIA_OUTIL_CLE : une autre cle de HKCU (tests) ; sinon Environment, le PATH de l'utilisateur.
$n = if ($env:VAEVIA_OUTIL_CLE) { $env:VAEVIA_OUTIL_CLE } else { 'Environment' }
$c = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($n, $true)
if ($null -eq $c) { throw "cle de registre introuvable : HKCU, $n" }
$b = [string]$c.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$k = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($null -ne $c.GetValue('Path', $null)) { $k = $c.GetValueKind('Path') }
$p = @($b -split ';' | Where-Object { $_ })
$d = $env:VAEVIA_CLI
if ($p | Where-Object { $_.TrimEnd('\') -ieq $d.TrimEnd('\') }) { $c.Close(); 'deja'; exit 0 }
$c.SetValue('Path', ((@($p) + $d) -join ';'), $k); $c.Close()
$s = '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
try { $t = Add-Type -MemberDefinition $s -Name Diffusion -Namespace VaeviaOutil -PassThru; $r = [UIntPtr]::Zero; [void]$t::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$r) } catch { }
'ajoute'
`;

// L'installeur : un module JavaScript, exécuté par la ligne (import d'une URL data:, donc sans import.meta.url).
export function scriptInstallation(u: string): string {
	return `// Vaevia : installe la CLI « outil » depuis ${u}.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
const SERVEUR = ${JSON.stringify(u)}, NOM = ${JSON.stringify(NOM_ARCHIVE)}, MARQUE = "lanceur de vaevia-outil";
const PATH_WINDOWS = ${JSON.stringify(PATH_WINDOWS)};
const win = process.platform === "win32";
class Echec extends Error {}
async function principal() {
	const majeure = Number(process.versions.node.split(".")[0]);
	if (!(majeure >= 24)) throw new Echec("Node 24 ou plus est requis (celui-ci : " + process.versions.node + "). Installer Node (Windows : winget install OpenJS.NodeJS.LTS), rouvrir le terminal, puis relancer la même ligne.");
	const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
	const dossier = process.env.VAEVIA_OUTIL_DOSSIER || (win ? path.join(local, "Programs", NOM) : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), NOM));
	const systeme = process.env.SystemRoot || "C:\\\\Windows";
	const tar = win ? path.join(systeme, "System32", "tar.exe") : "tar";
	const r = await fetch(SERVEUR + "/outil/" + NOM + ".tar.gz");
	if (!r.ok) throw new Echec("téléchargement de la CLI refusé par le serveur (" + r.status + ")");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), NOM + "-"));
	try {
		const archive = path.join(tmp, "outil.tar.gz");
		fs.writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
		const x = spawnSync(tar, ["-xzf", archive, "-C", tmp], { encoding: "utf8", windowsHide: true });
		if (x.status !== 0) throw new Echec("archive illisible (" + tar + " : " + ((x.stderr || "").trim() || (x.error && x.error.message) || "code " + x.status) + ")");
		const source = path.join(tmp, NOM);
		if (!fs.existsSync(path.join(source, "cli", "outil.ts"))) throw new Echec("archive incomplète (cli/outil.ts absent)");
		fs.mkdirSync(path.dirname(dossier), { recursive: true });
		// Remplacement de l'ancienne version, avec quelques essais (un antivirus peut lire encore les fichiers).
		for (let i = 0; ; i++) {
			try { fs.rmSync(dossier, { recursive: true, force: true }); fs.cpSync(source, dossier, { recursive: true }); break; }
			catch (e) { if (i >= 9) throw e; await new Promise(ok => setTimeout(ok, 300)); }
		}
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	const cli = path.join(dossier, "cli");
	const version = (() => { try { return fs.readFileSync(path.join(dossier, "VERSION"), "utf8").trim(); } catch { return "?"; } })();
	const direct = 'node "' + path.join(cli, "outil.ts") + '"';
	console.log("outil " + version + " installé : " + dossier);
	if (win) {
		if (process.env.VAEVIA_OUTIL_SANS_PATH === "1") console.log("PATH inchangé (VAEVIA_OUTIL_SANS_PATH=1).");
		else {
			const f = path.join(os.tmpdir(), NOM + "-path-" + process.pid + ".ps1");
			fs.writeFileSync(f, PATH_WINDOWS);
			try {
				const p = spawnSync(path.join(systeme, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", f],
					{ encoding: "utf8", windowsHide: true, env: { ...process.env, VAEVIA_CLI: cli } });
				const sortie = (p.stdout || "").trim();
				if (p.status !== 0 || !/^(ajoute|deja)$/m.test(sortie)) console.log("PATH de l'utilisateur non modifié (" + ((p.stderr || "").trim().split(/\\r?\\n/)[0] || "code " + p.status) + ") : ajouter " + cli + " à la main.");
				else console.log(/ajoute/.test(sortie) ? "Ajouté au PATH de l'utilisateur : les terminaux ouverts désormais trouvent « outil » (cmd, PowerShell, Git Bash)." : "Déjà dans le PATH de l'utilisateur.");
			} finally { fs.rmSync(f, { force: true }); }
		}
	} else {
		const bin = process.env.VAEVIA_OUTIL_BIN || path.join(os.homedir(), ".local", "bin");
		fs.mkdirSync(bin, { recursive: true });
		const lanceur = path.join(bin, "outil");
		if (fs.existsSync(lanceur) && !fs.readFileSync(lanceur, "utf8").includes(MARQUE)) throw new Echec(lanceur + " existe déjà et n'est pas de vaevia-outil : rien n'est remplacé ; lancer « " + direct + " ».");
		const q = s => "'" + s.replace(/'/g, "'\\\\''") + "'";
		fs.writeFileSync(lanceur, "#!/bin/sh\\n# " + MARQUE + " (" + SERVEUR + ")\\nexec node " + q(path.join(cli, "outil.ts")) + ' "$@"\\n', { mode: 0o755 });
		fs.chmodSync(lanceur, 0o755);
		const dansPath = (process.env.PATH || "").split(":").includes(bin);
		console.log("Lanceur : " + lanceur + (dansPath ? " (dans le PATH)." : " ; " + bin + " n'est pas dans le PATH : ajouter export PATH=\\"" + bin + ":$PATH\\" au profil du shell."));
	}
	console.log("Dans ce terminal (son PATH n'a pas changé) : " + direct + " methode");
	console.log("Serveur : " + SERVEUR);
}
principal().catch(e => { console.error("outil : " + (e instanceof Echec ? e.message : "échec de l'installation : " + (e && e.message || e))); process.exitCode = 1; });
`;
}

// Routeur : true si la requête est servie. Hôte principal, GET ou HEAD.
export function servirOutil(url: string, version: string, req: IncomingMessage, res: ServerResponse, seg: string[]): boolean {
	if (seg[0] !== "outil" || seg.length > 2) return false;
	const m = req.method || "GET";
	if (m !== "GET" && m !== "HEAD") return false;
	const u = origineServeur(url, req);
	const envoyer = (type: string, corps: Buffer | string, nom?: string) => {
		const b = typeof corps === "string" ? Buffer.from(corps, "utf8") : corps;
		res.writeHead(200, { "Content-Type": type, "Content-Length": b.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
			...(nom ? { "Content-Disposition": `attachment; filename="${nom}"` } : {}) });
		res.end(m === "HEAD" ? undefined : b);
	};
	const sous = seg.length === 1 || seg[1] === "" ? "" : seg[1];
	if (sous === "") { envoyer("text/plain; charset=utf-8", texteOutil(u, version)); return true; }
	if (sous === "installer.mjs") { envoyer("text/javascript; charset=utf-8", scriptInstallation(u)); return true; }
	if (sous === `${NOM_ARCHIVE}.tar.gz`) {
		const a = archiveCli();
		if (!a) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("la CLI n'est pas dans cette installation du serveur\n"); return true; }
		envoyer("application/gzip", a, `${NOM_ARCHIVE}.tar.gz`);
		return true;
	}
	return false;
}
