// Étape 3.9, lot 5 (docs/etape3-9-sections-1-a-6.md) : webhook entrant de la forge (I3), clone en lecture seule (A6).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, git, depotDe } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

// Git du test isolé du poste : ni configuration globale ou système, ni gestionnaire d'identifiants (il garderait le jeton
// de test dans le magasin du système, et le resservirait au clone « sans jeton »).
const VIDE = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "wdd-lot5-gitconfig-vide");
fs.writeFileSync(VIDE, "");
const ENV_GIT = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: VIDE };
const gitAsync = (args: string[], cwd?: string) => new Promise<{ code: number; sortie: string }>(ok => execFile("git", ["-c", "credential.helper=", ...args], { cwd, encoding: "utf8", env: ENV_GIT },
	(e, so, se) => ok({ code: e ? (typeof (e as any).code === "number" ? (e as any).code : 1) : 0, sortie: String(so) + String(se) })));

describe("lot 5 : forge (webhook entrant), clone en lecture seule", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string, adm: string, secret: string;
	before(async () => {
		donnees = dossierTemp("lot5");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		adm = await session(u, "jardin", "adm", "admin", "Adm");
		for (const t of ["Arrosage", "Semis"]) assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: t } })).status, 201);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const envoyer = (corps: string, entetes: Record<string, string>) => fetch(u + "/api/forge/jardin", { method: "POST", headers: { "Content-Type": "application/json", ...entetes }, body: corps });
	const ticket = async (id: string) => (await appel(u, `/api/p/jardin/tickets/${id}`, { cookie: maud })).corps.donnees;
	const push = (commits: { id: string; message: string }[], depot = "Mon-Jeu") => JSON.stringify({ ref: "refs/heads/main", repository: { name: depot }, commits });
	const hmac = (corps: string) => crypto.createHmac("sha256", secret).update(corps).digest("hex");

	test("I3 : réglage par un mainteneur (secret montré une fois) ; un contributeur ne le peut pas", async () => {
		assert.equal((await appel(u, "/api/p/jardin/forge", { cookie: camille, methode: "POST" })).status, 403);
		const r = await appel(u, "/api/p/jardin/forge", { cookie: maud, methode: "POST" });
		assert.equal(r.status, 201, r.texte);
		secret = r.corps.secret;
		assert.equal(r.corps.url, `${u}/api/forge/jardin`); assert.ok(secret.length >= 30);
		const g = await appel(u, "/api/p/jardin/forge", { cookie: maud });
		assert.equal(g.corps.actif, true); assert.ok(!g.texte.includes(secret), "le secret n'est plus jamais rendu");
	});

	test("I3 : signature GitHub, Gitea, GitLab ; « T-1 » attache le commit (dépôt, première ligne) ; rien n'est fermé ; mauvaise signature : 401", async () => {
		const c1 = push([{ id: "a".repeat(40), message: "T-1 : arrosage à 2 jours\n\ndétails" }, { id: "b".repeat(40), message: "fixes T-2 et T-99 (inconnu)" }, { id: "c".repeat(40), message: "sans ticket" }]);
		const r1 = await envoyer(c1, { "X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=" + hmac(c1) });
		assert.equal(r1.status, 200, await r1.clone().text());
		assert.deepEqual((await r1.json()).tickets, { "T-1": 1, "T-2": 1 });
		const t1 = await ticket("T-1"), t2 = await ticket("T-2");
		assert.deepEqual(t1.commits, [{ hash: "a".repeat(40), depot: "mon-jeu", message: "T-1 : arrosage à 2 jours" }]);
		assert.equal(t2.statut, "a-faire", "« fixes T-2 » ne ferme rien");
		assert.match(git(depotDe(donnees, "jardin"), "log", "-3", "--format=%an %s"), /Forge ticket T-1/);
		const c2 = push([{ id: "a".repeat(40), message: "T-1 : même commit, renvoyé" }, { id: "d".repeat(40), message: "T-1 suite" }]);
		const r2 = await envoyer(c2, { "X-Gitea-Event": "push", "X-Gitea-Signature": hmac(c2) });
		assert.deepEqual((await r2.json()).tickets, { "T-1": 1 }, "le commit déjà attaché n'est pas compté deux fois");
		const c3 = push([{ id: "e".repeat(40), message: "T-2 depuis GitLab" }], "outils");
		assert.equal((await envoyer(c3, { "X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": secret })).status, 200);
		assert.equal((await ticket("T-2")).commits.length, 2);
		assert.equal((await envoyer(c3, { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) })).status, 401);
		assert.equal((await envoyer(c3, { "X-Gitlab-Token": "mauvais" })).status, 401);
		assert.equal((await envoyer(c3, {})).status, 401, "sans signature");
		const p = JSON.stringify({ zen: "x" });
		assert.equal((await (await envoyer(p, { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=" + hmac(p) })).json()).pong, true);
		const g = await appel(u, "/api/p/jardin/forge", { cookie: maud });
		assert.match(g.corps.dernier_resultat, /1 commit\(s\), tickets : T-2 \+1/);
		const j = await appel(u, "/api/admin/journal", { cookie: adm });
		assert.ok(j.corps.entrees.some((e: any) => e.action === "commits de la forge"));
		assert.equal((await appel(u, "/api/p/jardin/forge", { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await envoyer(c3, { "X-Gitlab-Token": secret })).status, 401, "retiré : plus rien n'est accepté");
	});

	test("A6 : git clone et git fetch avec un jeton « clone » ; sans jeton ou avec un autre rôle : refusé ; push impossible ; le jeton n'ouvre pas l'API", async () => {
		const jc = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Clone de Maud", role: "clone" } });
		assert.equal(jc.status, 201, jc.texte);
		const clone = jc.corps.jeton;
		const agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } })).corps.jeton;
		const hote = new URL(u).host;
		const dest = path.join(donnees + "-clones");
		fs.mkdirSync(dest, { recursive: true });
		try {
			const ok = await gitAsync(["clone", "-q", `http://x:${clone}@${hote}/git/jardin.git`, path.join(dest, "a")]);
			assert.equal(ok.code, 0, ok.sortie);
			assert.ok(fs.existsSync(path.join(dest, "a", "tickets", "T-1.md")), "les tickets sont dans le clone");
			assert.equal(execFileSync("git", ["-C", path.join(dest, "a"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), git(depotDe(donnees, "jardin"), "rev-parse", "HEAD").trim());
			// Nouvelle écriture sur le serveur, puis fetch.
			await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Après le clone" } });
			const f = await gitAsync(["-C", path.join(dest, "a"), "pull", "-q", "--ff-only"]);
			assert.equal(f.code, 0, f.sortie);
			assert.ok(fs.existsSync(path.join(dest, "a", "tickets", "T-3.md")));
			// Push : refusé (aucune route receive-pack).
			fs.writeFileSync(path.join(dest, "a", "pirate.md"), "x");
			execFileSync("git", ["-c", "credential.helper=", "-C", path.join(dest, "a"), "-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "add", "pirate.md"]);
			execFileSync("git", ["-c", "credential.helper=", "-C", path.join(dest, "a"), "-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "pirate"]);
			const p = await gitAsync(["-C", path.join(dest, "a"), "push", "-q", "origin", "HEAD:main"]);
			assert.notEqual(p.code, 0, "le push doit échouer");
			assert.ok(!fs.existsSync(path.join(depotDe(donnees, "jardin"), "pirate.md")));
			// Sans jeton, avec un jeton agent : 401.
			assert.notEqual((await gitAsync(["clone", "-q", `http://${hote}/git/jardin.git`, path.join(dest, "b")])).code, 0);
			assert.equal((await fetch(`${u}/git/jardin.git/info/refs?service=git-upload-pack`, { headers: { Authorization: "Bearer " + agent } })).status, 401);
			assert.equal((await fetch(`${u}/git/jardin.git/info/refs?service=git-receive-pack`, { headers: { Authorization: "Bearer " + clone } })).status, 403);
			assert.equal((await fetch(`${u}/git/jardin.git/git-receive-pack`, { method: "POST", headers: { Authorization: "Bearer " + clone } })).status, 404);
			assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: clone })).status, 403, "le jeton clone n'ouvre pas l'API");
		} finally { nettoyer(dest); }
	});
});
