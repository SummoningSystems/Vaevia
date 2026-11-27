// Étape 3.9, A7 (docs/hors-ligne.md) : vérification « aucun appel sortant » et paquet hors ligne, fabriqué, relu,
// décompressé, puis lancé avec son propre Node (CLI et serveur, port libre, données temporaires, jamais 8080).
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "outils/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const VERSION = fs.readFileSync(path.join(RACINE, "VERSION"), "utf8").trim();
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const tmpBase = process.env.WDD_TESTS_TMP || os.tmpdir();

describe("hors ligne : vérification et paquet", () => {
	let tmp: string;
	before(() => { tmp = fs.mkdtempSync(path.join(tmpBase, "hors-ligne-")); });
	after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const verifier = (args: string[]) => spawnSync(process.execPath, [path.join(RACINE, "outils", "verifier-hors-ligne.mjs"), ...args], { encoding: "utf8" });

	test("verifier-hors-ligne : OK sur le code livré ; une adresse externe écrite en dur le fait échouer", () => {
		const r = verifier(["--json"]);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const j = JSON.parse(r.stdout);
		assert.deepEqual(j.inconnus, []); assert.ok(j.fichiers > 50 && j.connexions > 0);
		const faux = path.join(tmp, "faux");
		fs.mkdirSync(path.join(faux, "serveur", "src"), { recursive: true });
		fs.writeFileSync(path.join(faux, "serveur", "src", "x.ts"), 'await fetch("https://collecte.exemple-externe.net/x");\nconst ok = "http://127.0.0.1:8080/";\n');
		const k = verifier(["--racine", faux]);
		assert.equal(k.status, 1); assert.match(k.stdout, /serveur\/src\/x\.ts:1 : collecte\.exemple-externe\.net/); assert.ok(!/127\.0\.0\.1/.test(k.stdout.split("ÉCHEC")[1]));
	});

	test("paquet : archive avec Node, installeur, CLI, manifeste vérifiable ; sans tests, heritage/ ni documents internes ; décompressé, son Node lance la CLI et le serveur", async () => {
		const out = path.join(tmp, "paquet");
		const r = spawnSync(process.execPath, [path.join(RACINE, "outils", "paquet-hors-ligne.mjs"), "--out", out], { encoding: "utf8", timeout: 300000 });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const zip = path.join(out, `outil-hors-ligne-${VERSION}.zip`);
		assert.ok(fs.existsSync(zip));
		const liste = spawnSync(TAR, ["-tf", zip], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
		const p = `outil-hors-ligne-${VERSION}/`;
		for (const f of ["installer.cmd", "VERSION", "MANIFESTE.txt", "cli/outil.ts", "cli/outil.cmd", "serveur/src/principal.ts", "site/build.js", "methode/METHODE.md", "docs/hors-ligne.md", process.platform === "win32" ? "node/node.exe" : "node/node"])
			assert.ok(liste.includes(p + f), f);
		assert.ok(!liste.some(f => /\/(test|tests)\/|\/heritage\/|docs\/pilotes\.md|docs\/etape/.test(f)), "ni tests, ni heritage, ni documents internes");
		// Décompressé : manifeste vérifié sur quelques fichiers, puis le Node livré lance la CLI et le serveur.
		const dest = path.join(tmp, "installe");
		fs.mkdirSync(dest);
		assert.equal(spawnSync(TAR, ["-xf", zip, "-C", dest]).status, 0);
		const base = path.join(dest, `outil-hors-ligne-${VERSION}`);
		const man = fs.readFileSync(path.join(base, "MANIFESTE.txt"), "utf8").split("\n").filter(l => /^[0-9a-f]{64}  /.test(l));
		assert.equal(man.length, liste.filter(f => !f.endsWith("/") && !f.endsWith("MANIFESTE.txt")).length, "une ligne par fichier");
		for (const l of man.filter(l => / (VERSION|cli\/outil\.ts|serveur\/src\/http\.ts)$/.test(l))) {
			const [h, f] = l.split("  ");
			assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(base, f))).digest("hex"), h, f);
		}
		const node = path.join(base, "node", process.platform === "win32" ? "node.exe" : "node");
		const aide = spawnSync(node, [path.join(base, "cli", "outil.ts"), "aide"], { encoding: "utf8" });
		assert.equal(aide.status, 0, aide.stderr); assert.match(aide.stdout, /outil exporteur/);
		const port = await new Promise<number>(ok => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const n = (s.address() as net.AddressInfo).port; s.close(() => ok(n)); }); });
		assert.notEqual(port, 8080);
		const env = { ...process.env, WDD_DONNEES: path.join(tmp, "donnees"), WDD_PORT: String(port), WDD_HOTE: "127.0.0.1", WDD_URL: `http://127.0.0.1:${port}`, WDD_SAUVEGARDE_HEURES: "0" };
		for (const k of ["WDD_URL_PAGES", "WDD_TEST", "WDD_SAUVEGARDE"]) delete env[k];
		const srv = spawn(node, [path.join(base, "serveur", "src", "principal.ts")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		try {
			await new Promise<void>((ok, ko) => { let t = ""; const f = setTimeout(() => ko(new Error("pas démarré : " + t)), 30000); const l = (b: Buffer) => { t += b; if (/à l'écoute sur/.test(t)) { clearTimeout(f); ok(); } }; srv.stdout.on("data", l); srv.stderr.on("data", l); });
			const s = await fetch(`http://127.0.0.1:${port}/api/sante`);
			assert.equal(s.status, 200);
			assert.equal((await fetch(`http://127.0.0.1:${port}/api/moi`)).headers.get("x-wdd-version"), VERSION);
		} finally { srv.kill(); await new Promise(r => setTimeout(r, 500)); }
	});
});
