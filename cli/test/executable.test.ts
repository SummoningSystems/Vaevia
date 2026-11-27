// Étape 3.10 (décision 3 de l'étape 3.6) : outil executable, chemins des logiciels à lancer, propres au poste.
// - enregistrer, lire, lister, oublier ; fichier utilisateur, jamais le dépôt ; chemin inexistant refusé ;
// - nom inconnu : code 1 et la marche à suivre (demander à l'humain, ou la dire sous la veille) ;
// - sous la veille : lire permis, enregistrer et oublier refusés (usage, 2) ;
// - outil publier lance le chemin enregistré quand publier.exporteur commence par ce nom ; outil statut le montre.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { dossierTemp, nettoyer, serveurTest, projet, session, appel } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { environnement, lancer, fichierJetons, dossierUtilisateur } from "./aide-cli.ts";

const EXPORTEUR = `
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const out = process.argv.find(a => a.startsWith("--out=")).slice(6);
fs.writeFileSync(out, JSON.stringify({ title: "Jardin", generated: "2026-11-26T10:00:00Z", kinds: { plante: "Plante" },
  tabs: [{ id: "plantes", label: "Plantes", sections: [{ id: "toutes", title: "Plantes", items: [{ id: "tomate", kind: "plante", name: "Tomate" }] }] }] }));
console.log("export OK");
`;

describe("outil executable : logiciels à lancer, propres au poste", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, code: string, fichier: string;
	before(async () => {
		tmp = dossierTemp("cli-executable");
		env = environnement(tmp);
		s = await serveurTest(path.join(tmp, "donnees"));
		u = s.url;
		await projet(u, "jardin");
		const adm = await session(u, "jardin", "adm", "admin", "Adm");
		const agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent 3.10" } })).corps.jeton;
		fs.mkdirSync(path.dirname(fichierJetons(env)), { recursive: true });
		fs.writeFileSync(fichierJetons(env), JSON.stringify({ [u]: { jardin: agent } }));
		code = path.join(tmp, "code");
		fs.mkdirSync(path.join(code, "tools", "site-retours"), { recursive: true });
		fs.writeFileSync(path.join(code, "tools", "site-retours", "export.mjs"), EXPORTEUR);
		// Le nom « moteur-local » n'est nulle part dans le PATH : seul l'enregistrement le rend lançable.
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin", publier: { exporteur: ["moteur-local", "tools/site-retours/export.mjs", "--out={data}"] } }, null, 2));
		fichier = path.join(dossierUtilisateur(env), "executables.json");
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });
	const outil = (args: string[], extra: Record<string, string> = {}) => lancer(env, args, { cwd: code, env: extra });

	test("nom inconnu : code 1, la marche à suivre ; publier dit d'enregistrer le chemin", async () => {
		const r = await outil(["executable", "moteur-local", "--json"]);
		assert.equal(r.code, 1);
		assert.equal(r.json.erreur.code, "executable_inconnu");
		assert.match(r.json.erreur.message, /demander à l'humain le chemin de moteur-local/);
		assert.match(r.json.erreur.message, /outil executable moteur-local <chemin>/);
		assert.match(r.json.erreur.message, /Sous la veille, ne pas demander/);
		const p = await outil(["publier"]);
		assert.equal(p.code, 1);
		assert.match(p.stderr, /ni enregistré par « outil executable »/);
		assert.match(p.stderr, /outil executable moteur-local <chemin>/);
		const l = await outil(["executable"]);
		assert.equal(l.code, 0);
		assert.match(l.stdout, /aucun logiciel enregistré pour jardin/);
	});

	test("nom invalide et chemin inexistant refusés ; rien n'est écrit", async () => {
		assert.equal((await outil(["executable", "Godot"])).code, 2);
		assert.equal((await outil(["executable", "../godot", "x"])).code, 2);
		const r = await outil(["executable", "moteur-local", path.join(tmp, "absent.exe"), "--json"]);
		assert.equal(r.code, 1);
		assert.equal(r.json.erreur.code, "executable_introuvable");
		assert.equal(fs.existsSync(fichier), false);
		assert.equal((await outil(["executable", "--oublier"])).code, 2);
	});

	test("enregistrer : fichier utilisateur (jamais le dépôt) ; lire rend le chemin seul ; statut le montre ; publier le lance", async () => {
		const e = await outil(["executable", "moteur-local", process.execPath]);
		assert.equal(e.code, 0, e.stderr);
		assert.match(e.stdout, /ce poste seulement, rien à commiter/);
		assert.deepEqual(JSON.parse(fs.readFileSync(fichier, "utf8")), { [u]: { jardin: { "moteur-local": process.execPath } } });
		assert.deepEqual(fs.readdirSync(code).sort(), [".outil.json", "tools"]);
		assert.equal(JSON.parse(fs.readFileSync(path.join(code, ".outil.json"), "utf8")).publier.exporteur[0], "moteur-local");
		const r = await outil(["executable", "moteur-local"]);
		assert.equal(r.code, 0);
		assert.equal(r.stdout.trim(), process.execPath);
		const j = await outil(["executable", "moteur-local", "--json"]);
		assert.deepEqual(j.json, { projet: "jardin", nom: "moteur-local", chemin: process.execPath, source: "enregistre" });
		const l = await outil(["executable", "--json"]);
		assert.deepEqual(l.json.executables, [{ nom: "moteur-local", chemin: process.execPath, existe: true }]);
		const st = await outil(["statut"]);
		assert.match(st.stdout, new RegExp(`logiciels enregistrés sur ce poste : moteur-local \\(${process.execPath.replace(/[\\.()]/g, "\\$&")}\\)`));
		assert.deepEqual((await outil(["statut", "--json"])).json.executables, { "moteur-local": process.execPath });
		const p = await outil(["publier", "--json"]);
		assert.equal(p.code, 0, p.stderr);
		assert.equal(p.json.build, 1);
		assert.match(p.stderr, /exporteur : export OK/);
	});

	test("sous la veille : lire permis ; enregistrer et oublier refusés (2), sans rien changer", async () => {
		const veille = { OUTIL_DEMANDE: "D1" };
		const avant = fs.readFileSync(fichier, "utf8");
		const r = await outil(["executable", "moteur-local"], veille);
		assert.equal(r.code, 0);
		assert.equal(r.stdout.trim(), process.execPath);
		const e = await outil(["executable", "autre", process.execPath], veille);
		assert.equal(e.code, 2);
		assert.match(e.stderr, /choix de l'humain/);
		assert.match(e.stderr, /« À valider »/);
		assert.equal((await outil(["executable", "moteur-local", "--oublier"], veille)).code, 2);
		assert.equal(fs.readFileSync(fichier, "utf8"), avant);
	});

	test("chemin enregistré disparu : le PATH prend le relais, avec un avertissement ; oublier le retire", async () => {
		const copie = path.join(tmp, "copie-node" + (process.platform === "win32" ? ".exe" : ""));
		fs.copyFileSync(process.execPath, copie);
		assert.equal((await outil(["executable", "node", copie])).code, 0);
		fs.rmSync(copie);
		const r = await outil(["executable", "node"]);
		assert.equal(r.code, 0);
		assert.match(r.stderr, /n'existe plus/);
		assert.notEqual(r.stdout.trim(), copie);
		const o = await outil(["executable", "node", "--oublier"]);
		assert.equal(o.code, 0);
		assert.match(o.stdout, /node : oublié/);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fichier, "utf8"))[u].jardin), ["moteur-local"]);
	});
});

describe("méthode : logiciel à lancer (décision 3 de l'étape 3.6)", () => {
	const RACINE_OUTIL = path.resolve(import.meta.dirname, "..", "..");
	const methode = fs.readFileSync(path.join(RACINE_OUTIL, "methode", "METHODE.md"), "utf8");
	const exporteurs = fs.readFileSync(path.join(RACINE_OUTIL, "methode", "exporteurs.md"), "utf8");
	test("METHODE : chercher, mettre en place, demander (humain présent), dire (veille) ; plus de « fiches sans image » d'emblée", () => {
		const quatre = methode.slice(methode.indexOf("## 4. Créer ou refaire le Wiki"), methode.indexOf("## 5. "));
		assert.match(quatre, /\*\*Logiciel à lancer \(moteur, application, navigateur\)\.\*\*/);
		assert.match(quatre, /Ce n'est pas propre aux jeux/);
		assert.match(quatre, /\*\*Mettre en place toi-même l'outil de capture\*\*[^\n]*captures-fenetre\.ps1/);
		assert.match(quatre, /Tu n'installes ni ne télécharges aucun logiciel sans l'accord de l'humain/);
		assert.match(quatre, /\*\*une question fermée\*\*[^\n]*outil executable godot <chemin>/);
		assert.match(quatre, /\*\*Sous la veille\*\*[^\n]*aucune question[^\n]*« À valider »/);
		assert.doesNotMatch(methode, /Sans moyen de capturer \(moteur introuvable, pas d'affichage\) : les fiches sans image/);
		const zero = methode.slice(methode.indexOf("## 0. Mise en place"), methode.indexOf("## 1. Principes"));
		assert.match(zero, /Seule question permise : le chemin d'un logiciel à lancer/);
		const veille = methode.slice(methode.indexOf("### 6.8 Lancé par la veille"), methode.indexOf("## 7. "));
		assert.match(veille, /\*\*Logiciel introuvable\*\*[^\n]*enregistrer est refusé/);
		assert.match(methode, /\| `outil executable \[<nom> \[<chemin>\]\]` \|/);
		assert.doesNotMatch(exporteurs, /Sans moyen de capturer \(moteur absent du `PATH`/);
		assert.match(exporteurs, /\*\*Le logiciel à lancer\*\*[^\n]*outil executable <nom>/);
	});
	test("exporteurs.md : la recette « Logiciel de bureau Windows » est un script PowerShell qui se lit sans erreur", { skip: process.platform !== "win32" }, () => {
		const i = exporteurs.indexOf("`tools/site-retours/captures-fenetre.ps1`\n```powershell\n");
		assert.ok(i > 0, "bloc captures-fenetre.ps1");
		const debut = exporteurs.indexOf("\n", exporteurs.indexOf("```powershell", i)) + 1;
		const code = exporteurs.slice(debut, exporteurs.indexOf("\n```", debut));
		assert.match(code, /PrintWindow/); assert.match(code, /outil executable <nom>/);
		const tmp = dossierTemp("cli-fenetre");
		try {
			const f = path.join(tmp, "captures-fenetre.ps1");
			fs.writeFileSync(f, "﻿" + code);
			const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
				`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`], { encoding: "utf8", windowsHide: true });
			assert.equal(ps.status, 0, ps.stderr);
			assert.equal(ps.stdout.trim(), "0", ps.stdout);
		} finally { nettoyer(tmp); }
	});
});
