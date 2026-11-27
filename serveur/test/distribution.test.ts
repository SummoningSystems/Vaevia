// Distribution de la CLI par le serveur (distribution.ts, 27/11/2026) : /outil, l'installeur, l'archive.
// - /outil : la ligne, avec l'adresse du serveur (WDD_URL, sinon celle de la requête) ; hôte des pages : rien ;
// - archive : cli/ sans les tests, methode/, VERSION, les deux règles de site/ ; lanceur exécutable ;
// - la vraie ligne (node -e …), lancée par cmd, PowerShell 5.1 et 7 sous Windows, par sh ailleurs : installe dans un
//   dossier temporaire, et la CLI installée trouve sa méthode ; Windows : PATH ajouté sur une clé de registre d'essai
//   (jamais le vrai PATH), type REG_EXPAND_SZ et %…% gardés, rien en double à la relance ;
// - sans Node 24 : message clair, code 1.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { dossierTemp, nettoyer, serveurTest, appel } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { fichiersCli, ligneInstallation, scriptInstallation, NOM_ARCHIVE } from "../src/distribution.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const WIN = process.platform === "win32";
const TAR = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const VERSION = fs.readFileSync(path.join(RACINE, "VERSION"), "utf8").trim();
const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Asynchrone : le serveur de test tourne dans ce processus et doit répondre pendant que la ligne s'exécute.
const lancer = (exe: string, args: string[], o: SpawnOptions = {}) => new Promise<{ status: number | null; sortie: string }>(ok => {
	const p = spawn(exe, args, { windowsHide: true, ...o }); let sortie = "";
	p.stdout!.on("data", d => sortie += d); p.stderr!.on("data", d => sortie += d);
	const fin = setTimeout(() => p.kill(), 120000);
	p.on("error", e => { clearTimeout(fin); ok({ status: -1, sortie: e.message }); });
	p.on("close", status => { clearTimeout(fin); ok({ status, sortie }); });
});

// Entrées d'un tar (ustar) : nom complet, mode, type.
function entrees(tar: Buffer): { nom: string; mode: number; type: string }[] {
	const r: { nom: string; mode: number; type: string }[] = [];
	for (let i = 0; i + 512 <= tar.length;) {
		const h = tar.subarray(i, i + 512);
		if (h.every(o => o === 0)) break;
		const champ = (d: number, l: number) => h.subarray(d, d + l).toString("utf8").replace(/\0.*$/s, "");
		const nom = (champ(345, 155) ? champ(345, 155) + "/" : "") + champ(0, 100);
		const taille = parseInt(champ(124, 12).trim(), 8) || 0;
		r.push({ nom, mode: parseInt(champ(100, 8).trim(), 8), type: champ(156, 1) });
		i += 512 + Math.ceil(taille / 512) * 512;
	}
	return r;
}

describe("distribution de la CLI : /outil", () => {
	let s: Serveur, tmp: string;
	before(async () => { tmp = dossierTemp("distribution"); s = await serveurTest(path.join(tmp, "donnees")); });
	after(async () => { await s.arreter(); nettoyer(tmp); });
	const envCli = () => ({ ...process.env, APPDATA: path.join(tmp, "a"), LOCALAPPDATA: path.join(tmp, "l"), XDG_CONFIG_HOME: path.join(tmp, "a"), XDG_DATA_HOME: path.join(tmp, "l"), HOME: tmp });

	test("/outil : texte, la ligne avec l'adresse de la requête (sans WDD_URL), Node 24 dit ; POST et autres : 404", async () => {
		const r = await appel(s.url, "/outil");
		assert.equal(r.status, 200);
		assert.match(r.entetes.get("content-type") || "", /^text\/plain; charset=utf-8/);
		assert.ok(r.texte.includes("  " + ligneInstallation(s.url) + "\n"), r.texte);
		assert.match(r.texte, new RegExp(`version ${echapper(VERSION)}`));
		assert.match(r.texte, /Node 24 ou plus/);
		assert.match(r.texte, /outil methode, puis suivre le § 0/);
		assert.equal((await appel(s.url, "/outil/")).texte, r.texte);
		assert.equal((await appel(s.url, "/outil", { methode: "POST", corps: {} })).status, 404);
		for (const c of ["/outil/autre", "/outil/installer.ps1", "/outil/installer.sh", "/outil/a/b"]) assert.equal((await appel(s.url, c)).status, 404, c);
		// La ligne : ni $, ni !, ni %, ni &, ni |, ni accent grave (cmd, PowerShell et sh la lisent pareil).
		assert.ok(!/[$!%&|`]/.test(ligneInstallation(s.url)));
	});

	test("installeur : module JavaScript valide, porte l'adresse du serveur", async () => {
		const r = await appel(s.url, "/outil/installer.mjs");
		assert.equal(r.status, 200);
		assert.match(r.entetes.get("content-type") || "", /^text\/javascript; charset=utf-8/);
		assert.equal(r.texte, scriptInstallation(s.url));
		assert.ok(r.texte.includes(`const SERVEUR = ${JSON.stringify(s.url)}`));
		const f = path.join(tmp, "installer.mjs"); fs.writeFileSync(f, r.texte);
		const c = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
		assert.equal(c.status, 0, c.stderr);
	});

	test("archive : cli/ sans tests, methode/, VERSION, règles de site/ ; lanceur 755 ; extraite, la CLI trouve sa méthode", async () => {
		const r = await fetch(s.url + `/outil/${NOM_ARCHIVE}.tar.gz`);
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("content-type"), "application/gzip");
		const gz = Buffer.from(await r.arrayBuffer());
		const e = entrees(zlib.gunzipSync(gz));
		const noms = e.filter(x => x.type === "0").map(x => x.nom.slice(NOM_ARCHIVE.length + 1));
		assert.deepEqual(noms, fichiersCli());
		for (const f of ["VERSION", "cli/outil", "cli/outil.cmd", "cli/outil.ts", "cli/commun.ts", "methode/METHODE.md", "methode/exporteurs.md", "methode/integrations/claude/SKILL.md", "site/valider-notes.js", "site/changements.js"])
			assert.ok(noms.includes(f), f);
		assert.ok(!noms.some(n => /(^|\/)tests?\//.test(n)), "aucun test");
		assert.ok(noms.every(n => /^(VERSION|cli\/|methode\/|site\/(valider-notes|changements)\.js$)/.test(n)), "rien d'autre");
		assert.equal(e.find(x => x.nom === `${NOM_ARCHIVE}/cli/outil`)!.mode, 0o755);
		const dest = path.join(tmp, "extrait"); fs.mkdirSync(dest);
		fs.writeFileSync(path.join(tmp, "a.tar.gz"), gz);
		const x = spawnSync(TAR, ["-xzf", path.join(tmp, "a.tar.gz"), "-C", dest], { encoding: "utf8", windowsHide: true });
		assert.equal(x.status, 0, x.stderr);
		const m = spawnSync(process.execPath, [path.join(dest, NOM_ARCHIVE, "cli", "outil.ts"), "methode", "--chemin", "--json"], { encoding: "utf8", windowsHide: true, cwd: tmp, env: envCli() });
		assert.equal(m.status, 0, m.stderr);
		assert.equal(JSON.parse(m.stdout).chemin, path.join(dest, NOM_ARCHIVE, "methode", "METHODE.md"));
	});

	test("la vraie ligne, par chaque shell du poste : installe la CLI (dossier temporaire), qui trouve sa méthode ; relancée, met à jour", async () => {
		const ligne = ligneInstallation(s.url);
		const shells: [string, string, string[], SpawnOptions][] = WIN
			? [["cmd", "cmd.exe", ["/d", "/s", "/c", `"${ligne}"`], { windowsVerbatimArguments: true }],
				["powershell 5.1", "powershell", ["-NoProfile", "-NonInteractive", "-Command", ligne], {}],
				["pwsh 7", "pwsh", ["-NoProfile", "-NonInteractive", "-Command", ligne], {}]]
			: [["sh", "sh", ["-c", ligne], {}]];
		let essais = 0;
		for (const [nom, exe, args, o] of shells) {
			if (spawnSync(exe, exe === "cmd.exe" ? ["/d", "/c", "exit 0"] : exe === "sh" ? ["-c", "exit 0"] : ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status !== 0) continue;
			essais++;
			const dossier = path.join(tmp, "inst-" + essais), bin = path.join(tmp, "bin-" + essais);
			const env = { ...envCli(), VAEVIA_OUTIL_DOSSIER: dossier, VAEVIA_OUTIL_BIN: bin, VAEVIA_OUTIL_SANS_PATH: "1" };
			for (const tour of [1, 2]) {
				const r = await lancer(exe, args, { ...o, env });
				assert.equal(r.status, 0, `${nom} (tour ${tour}) : ${r.sortie}`);
				assert.match(r.sortie, new RegExp(`outil ${echapper(VERSION)} installé : ${echapper(dossier)}`), nom);
				assert.ok(r.sortie.includes(`Dans ce terminal (son PATH n'a pas changé) : node "${path.join(dossier, "cli", "outil.ts")}" methode`), nom + " : " + r.sortie);
			}
			const m = spawnSync(process.execPath, [path.join(dossier, "cli", "outil.ts"), "methode", "--chemin", "--json"], { encoding: "utf8", windowsHide: true, cwd: tmp, env: envCli() });
			assert.equal(m.status, 0, m.stderr);
			assert.equal(JSON.parse(m.stdout).chemin, path.join(dossier, "methode", "METHODE.md"));
			if (!WIN) {
				const l = spawnSync(path.join(bin, "outil"), ["methode", "--chemin", "--json"], { encoding: "utf8", cwd: tmp, env: envCli() });
				assert.equal(l.status, 0, l.stderr);
				assert.equal(JSON.parse(l.stdout).chemin, path.join(dossier, "methode", "METHODE.md"));
			}
		}
		assert.ok(essais >= 1, "aucun shell");
	});

	test("Windows : PATH de l'utilisateur sur une clé d'essai : ajouté une fois, %…% et REG_EXPAND_SZ gardés", { skip: !WIN }, async () => {
		const cle = `Software\\VaeviaOutil-essai-${process.pid}-${Date.now()}`;
		const reg = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
		assert.equal(spawnSync(reg, ["add", "HKCU\\" + cle, "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", "C:\\essai\\a;%USERPROFILE%\\essai", "/f"], { windowsHide: true }).status, 0);
		try {
			const dossier = path.join(tmp, "inst-path");
			const env = { ...envCli(), VAEVIA_OUTIL_DOSSIER: dossier, VAEVIA_OUTIL_CLE: cle };
			const ligne = ligneInstallation(s.url);
			const r1 = await lancer("cmd.exe", ["/d", "/s", "/c", `"${ligne}"`], { windowsVerbatimArguments: true, env });
			assert.equal(r1.status, 0, r1.sortie);
			assert.match(r1.sortie, /Ajouté au PATH de l'utilisateur/);
			const lire = () => spawnSync(reg, ["query", "HKCU\\" + cle, "/v", "Path"], { encoding: "utf8", windowsHide: true }).stdout;
			const v1 = lire();
			assert.match(v1, /REG_EXPAND_SZ/);
			assert.ok(v1.includes("C:\\essai\\a;%USERPROFILE%\\essai;" + path.join(dossier, "cli")), v1);
			const r2 = await lancer("cmd.exe", ["/d", "/s", "/c", `"${ligne}"`], { windowsVerbatimArguments: true, env });
			assert.equal(r2.status, 0, r2.sortie);
			assert.match(r2.sortie, /Déjà dans le PATH de l'utilisateur/);
			assert.equal(lire(), v1, "rien en double");
		} finally { spawnSync(reg, ["delete", "HKCU\\" + cle, "/f"], { windowsHide: true }); }
	});

	test("sans Node 24 : message clair, code 1, rien d'installé", async () => {
		const f = path.join(tmp, "vieux.mjs");
		const script = scriptInstallation(s.url);
		assert.ok(script.includes('Number(process.versions.node.split(".")[0])'));
		fs.writeFileSync(f, script.replace('Number(process.versions.node.split(".")[0])', "20"));
		const dossier = path.join(tmp, "inst-vieux");
		const r = await lancer(process.execPath, [f], { env: { ...envCli(), VAEVIA_OUTIL_DOSSIER: dossier, VAEVIA_OUTIL_SANS_PATH: "1" } });
		assert.equal(r.status, 1, r.sortie);
		assert.match(r.sortie, /outil : Node 24 ou plus est requis/);
		assert.equal(fs.existsSync(dossier), false);
	});
});

describe("distribution de la CLI : avec WDD_URL et l'hôte des pages", () => {
	let s: Serveur, tmp: string, port: number;
	before(async () => {
		tmp = dossierTemp("distribution-pages");
		s = await serveurTest(path.join(tmp, "donnees"), { url: "http://127.0.0.1:1", urlPages: "http://localhost:1" });
		port = Number(new URL(s.url).port);
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });
	const avecHote = (hote: string, chemin: string) => new Promise<{ status: number; texte: string }>((ok, ko) => {
		http.get({ host: "127.0.0.1", port, path: chemin, headers: { Host: hote } }, r => { let t = ""; r.on("data", c => t += c); r.on("end", () => ok({ status: r.statusCode!, texte: t })); }).on("error", ko);
	});
	test("hôte principal : la ligne porte WDD_URL ; hôte des pages : 404", async () => {
		const p = await avecHote("127.0.0.1:1", "/outil");
		assert.equal(p.status, 200);
		assert.ok(p.texte.includes(ligneInstallation("http://127.0.0.1:1")));
		assert.equal((await avecHote("127.0.0.1:1", "/outil/installer.mjs")).texte, scriptInstallation("http://127.0.0.1:1"));
		for (const c of ["/outil", "/outil/installer.mjs", `/outil/${NOM_ARCHIVE}.tar.gz`]) assert.equal((await avecHote("localhost:1", c)).status, 404, c);
	});
});
