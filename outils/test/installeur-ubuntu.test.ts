// Installeur Ubuntu (installer-ubuntu.sh, à la racine) : ce qui se vérifie sans Docker ni apt, sur tout poste qui a bash
// (Git Bash sous Windows). Le parcours complet (apt, image, Caddy interne, mode http, arrêt, relance) a été rejoué le
// 27/11/2026 dans une Ubuntu 24.04 branchée sur le Docker du poste : voir docs/acces-distant.md, « Ce qui est vérifié ».
//   - syntaxe ; fins de ligne LF (bash lit mal un CR) ; bit exécutable dans Git ;
//   - --aide (0), option inconnue, --port et --mode invalides (2), sans rien écrire (pas de .env créé).
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "outils/test/*.test.ts"
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT = path.join(RACINE, "installer-ubuntu.sh");

// bash : celui de Git sous Windows (jamais celui de System32, qui est WSL), sinon celui du PATH.
function trouverBash(): string | null {
	if (process.platform !== "win32") return "bash";
	const w = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
	for (const git of (w.stdout || "").split(/\r?\n/).filter(Boolean)) {
		for (const rel of [["..", "bin", "bash.exe"], ["..", "usr", "bin", "bash.exe"], ["..", "..", "bin", "bash.exe"]]) {
			const b = path.resolve(path.dirname(git), ...rel);
			if (fs.existsSync(b)) return b;
		}
	}
	return null;
}
const BASH = trouverBash();

describe("installeur Ubuntu : installer-ubuntu.sh", { skip: BASH ? false : "bash introuvable (Git Bash)" }, () => {
	// Lancé sur une copie, dans un dossier temporaire : aucun cas ci-dessous ne doit écrire .env (refus avant les réglages).
	const lancer = (args: string[]) => {
		const tmp = fs.mkdtempSync(path.join(process.env.WDD_TESTS_TMP || os.tmpdir(), "ubuntu-"));
		try {
			for (const f of ["installer-ubuntu.sh", "docker-compose.yml", ".env.exemple"]) fs.copyFileSync(path.join(RACINE, f), path.join(tmp, f));
			const r = spawnSync(BASH!, ["installer-ubuntu.sh", ...args], { cwd: tmp, encoding: "utf8", windowsHide: true, timeout: 30000 });
			return { ...r, env: fs.existsSync(path.join(tmp, ".env")) };
		} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	};

	test("syntaxe (bash -n), fins de ligne LF, bit exécutable dans Git", () => {
		const n = spawnSync(BASH!, ["-n", SCRIPT], { encoding: "utf8", windowsHide: true });
		assert.equal(n.status, 0, n.stderr);
		assert.ok(!fs.readFileSync(SCRIPT, "utf8").includes("\r"), "aucun CR");
		const g = spawnSync("git", ["ls-files", "-s", "installer-ubuntu.sh"], { cwd: RACINE, encoding: "utf8", windowsHide: true });
		if (g.status === 0 && g.stdout.trim()) assert.match(g.stdout, /^100755 /, "mode 100755");
	});

	test("--aide : 0, les trois modes et les commandes", () => {
		const r = lancer(["--aide"]);
		assert.equal(r.status, 0, r.stderr);
		for (const m of ["interne", "internet", "http", "--mettre-a-jour", "--reconnecter", "--domaine-pages", "Il faut Internet"]) assert.ok(r.stdout.includes(m), m);
		assert.ok(!r.stdout.includes("set -euo"), "l'aide s'arrête avant le code");
	});

	test("usage (2) sans rien écrire : option inconnue, --port, --mode", () => {
		for (const [args, motif] of [
			[["--truc"], /option inconnue : --truc/],
			[["--port", "0"], /--port : un nombre/],
			[["--port", "abc"], /--port : un nombre/],
			[["--mode", "nuage"], /--mode : interne, internet ou http/],
			[["--mode"], /--mode demande une valeur/],
		] as [string[], RegExp][]) {
			const r = lancer(args);
			assert.equal(r.status, 2, args.join(" ") + " : " + r.stderr);
			assert.match(r.stderr, motif);
			assert.equal(r.env, false, args.join(" ") + " : .env écrit");
		}
	});
});
