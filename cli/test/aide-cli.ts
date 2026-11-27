// Aides des tests de la CLI de l'étape 3.5 (brancher, importer-artifact --autoriser, publier, methode) : environnement
// entièrement temporaire (APPDATA, LOCALAPPDATA, HOME, USERPROFILE, XDG_*), navigateur remplacé par un fichier
// (OUTIL_TEST_NAVIGATEUR), CLI lancée en sous-processus (jamais un terminal) ou dans ce processus (terminal simulé).
// Le vrai dossier utilisateur, l'installation locale réelle et le port 8080 ne sont jamais touchés.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { principal } from "../outil.ts";

export const RACINE = path.resolve(import.meta.dirname, "..", "..");
export const OUTIL = path.join(RACINE, "cli", "outil.ts");
export type Resultat = { code: number; stdout: string; stderr: string; json: any };

// Environnement de test : tout dans <tmp>/maison ; aucune variable héritée hors PATH, SystemRoot, PATHEXT.
export function environnement(tmp: string): Record<string, string> {
	const maison = path.join(tmp, "maison");
	fs.mkdirSync(maison, { recursive: true });
	return {
		PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", PATHEXT: process.env.PATHEXT || "", TEMP: tmp, TMP: tmp,
		APPDATA: path.join(maison, "AppData", "Roaming"), LOCALAPPDATA: path.join(maison, "AppData", "Local"), HOME: maison, USERPROFILE: maison,
		XDG_CONFIG_HOME: path.join(maison, ".config"), XDG_DATA_HOME: path.join(maison, ".local", "share"), XDG_CACHE_HOME: path.join(maison, ".cache"),
		OUTIL_TEST_NAVIGATEUR: path.join(tmp, "navigateur.txt"),
	};
}
// Fichiers utilisateur attendus (mêmes règles que cli/commun.ts).
export const dossierUtilisateur = (env: Record<string, string>) => process.platform === "win32" ? path.join(env.APPDATA, "outil") : path.join(env.XDG_CONFIG_HOME, "outil");
export const fichierJetons = (env: Record<string, string>) => path.join(dossierUtilisateur(env), "jetons.json");
export const fichierAppairages = (env: Record<string, string>) => path.join(dossierUtilisateur(env), "appairages.json");
export const dossierInstallation = (env: Record<string, string>) => process.platform === "win32" ? path.join(env.LOCALAPPDATA, "Vaevia") : path.join(env.XDG_DATA_HOME, "Vaevia");
export const dossierTravail = (env: Record<string, string>, projet: string) => process.platform === "win32" ? path.join(env.LOCALAPPDATA, "outil", "travail", projet) : path.join(env.XDG_CACHE_HOME, "outil", "travail", projet);
export const lireJson = (f: string) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
export const urlsOuvertes = (env: Record<string, string>) => fs.existsSync(env.OUTIL_TEST_NAVIGATEUR) ? fs.readFileSync(env.OUTIL_TEST_NAVIGATEUR, "utf8").split("\n").filter(Boolean) : [];

// CLI en sous-processus (stdin est un tube : jamais un terminal). Avec --json, stdout doit être du JSON valide.
export function lancer(env: Record<string, string>, args: string[], o: { cwd: string; env?: Record<string, string>; entree?: string }): Promise<Resultat> {
	return new Promise((ok, ko) => {
		const p = spawn(process.execPath, [OUTIL, ...args], { cwd: o.cwd, env: { ...env, ...(o.env || {}) }, windowsHide: true });
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

// CLI dans ce processus, avec un terminal simulé (ctx.terminal) : sert au mode « dans un terminal » (attente en une
// commande). stderr est lisible au fil de l'eau (lu.stderr) pour y prendre le code affiché.
export function lancerDansTerminal(env: Record<string, string>, args: string[], cwd: string): { lu: { stdout: string; stderr: string }; fin: Promise<Resultat> } {
	const lu = { stdout: "", stderr: "" };
	const fin = principal(args, { env, cwd, stdout: s => { lu.stdout += s + "\n"; }, stderr: s => { lu.stderr += s + "\n"; }, lireEntree: async () => "", terminal: true })
		.then(code => ({ code, stdout: lu.stdout, stderr: lu.stderr, json: args.includes("--json") ? JSON.parse(lu.stdout) : null }));
	return { lu, fin };
}
// Windows : faux programmes « posés dans le dépôt » (taskkill.exe, git.exe…), copies de node.exe sous un autre nom.
// Lancés, ils ne font rien d'autre qu'écrire leur nom dans le fichier témoin : la sonde est chargée par NODE_OPTIONS
// (--require), et ne fait rien dans un node.exe ordinaire (la CLI, l'exporteur, l'agent). Rend les variables à
// ajouter à l'environnement de la CLI. Un fichier .bat ou .cmd (node.bat) s'écrit à part, avec le même témoin.
export function fauxProgrammes(dossier: string, noms: string[], temoin: string): Record<string, string> {
	const sonde = path.join(path.dirname(temoin), "sonde-faux-programme.cjs");
	fs.writeFileSync(sonde, `const path = require("node:path"), fs = require("node:fs");
const nom = path.basename(process.execPath).toLowerCase();
if (nom !== "node.exe" && nom !== "node") { fs.appendFileSync(process.env.SONDE_TEMOIN, nom + "\\n"); process.exit(0); }
`);
	for (const n of noms) {
		const f = path.join(dossier, n);
		fs.rmSync(f, { force: true });
		try { fs.linkSync(process.execPath, f); } catch { fs.copyFileSync(process.execPath, f); }
	}
	return { NODE_OPTIONS: "--require " + JSON.stringify(sonde), SONDE_TEMOIN: temoin };
}
export const lireTemoin = (temoin: string) => fs.existsSync(temoin) ? fs.readFileSync(temoin, "utf8").split(/\r?\n/).filter(Boolean) : [];

export async function attendreQue(f: () => boolean, ms = 10000, quoi = "condition"): Promise<void> {
	const fin = Date.now() + ms;
	while (!f()) {
		if (Date.now() > fin) throw new Error(`délai dépassé : ${quoi}`);
		await new Promise(r => setTimeout(r, 25));
	}
}
