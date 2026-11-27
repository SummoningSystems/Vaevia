// Dépôt Git sous contraintes réelles (défauts relevés à la relecture de l'étape 1) : verrou de Git pris entre « add » et
// « commit » (une écriture refusée ne doit jamais être emportée par la suivante), verrou bref d'un git extérieur
// (relance), verrous restés d'un arrêt brutal (nettoyés au démarrage), restauration ratée puis retentée, message 503
// sans détail du serveur, ids égaux à la casse près, config locale et .gitattributes du dépôt de design.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits } from "./aide.ts";
import { MESSAGE_INDISPONIBLE } from "../src/retours.ts";
import type { Serveur } from "../src/principal.ts";
import type { Depot } from "../src/depot.ts";

const lireHead = (depot: string, id: string) => JSON.parse(git(depot, "show", `HEAD:retours/${id}.json`));
const fichiersDuCommit = (depot: string, rev = "HEAD") => git(depot, "show", "--name-only", "--format=", rev).trim().split("\n").filter(Boolean).sort();

describe("Git : verrous, restauration, message 503", () => {
	let s: Serveur, donnees: string, u: string, depot: string, moi: string, d: Depot;
	before(async () => {
		donnees = dossierTemp("git");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		moi = await session(u, "jardin", "moi", "contributeur");
		d = s.ctx.depots.get("jardin")!;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const creer = (extra = {}) => appel(u, "/api/p/jardin/retours", { cookie: moi, corps: docRetour(extra) });
	const modifier = (id: string, version: number, champs: Record<string, unknown>) =>
		appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, methode: "PATCH", corps: { champs, version } });
	const verrou = () => path.join(depot, ".git", "index.lock");

	test("verrou pris entre add et commit, tenu pendant la restauration : l'écriture refusée n'entre pas dans le commit suivant", async () => {
		const a = (await creer({ text: "ide 1" })).corps.id, b = (await creer({ text: "autre" })).corps.id;
		const original = d.git.bind(d);
		let piege = true;
		d.relances = 1; d.pauseRelanceMs = 20;
		// Comme un « git status » extérieur qui prend le verrou juste après notre « add » et le garde.
		d.git = async (args, auteur) => {
			const r = await original(args, auteur);
			if (piege && args[0] === "add") { piege = false; fs.writeFileSync(verrou(), ""); }
			return r;
		};
		try {
			const refus = await modifier(a, 1, { text: "REFUSEE 1" });
			assert.equal(refus.status, 503); assert.equal(refus.corps.code, "unavailable");
			// Message générique : ni chemin du serveur, ni sortie de Git.
			assert.equal(refus.corps.message, MESSAGE_INDISPONIBLE);
			assert.ok(!refus.texte.includes(donnees.replace(/\\/g, "/")) && !refus.texte.includes(donnees) && !/index\.lock/.test(refus.texte));
			assert.equal(d.sale, true, "restauration impossible tant que le verrou est tenu : dépôt marqué sale");
			assert.match(git(depot, "diff", "--cached", "--name-only"), new RegExp(`retours/${a}\\.json`), "le reste indexé existe bien");
			// Une écriture pendant que le verrou est tenu : refusée elle aussi (restauration toujours impossible).
			assert.equal((await modifier(b, 1, { text: "autre, encore" })).status, 503);
		} finally { fs.rmSync(verrou(), { force: true }); d.git = original; d.relances = 5; d.pauseRelanceMs = 150; }
		// Verrou retiré : l'écriture suivante restaure d'abord, puis ne commite que son propre fichier.
		const ok = await modifier(b, 1, { text: "autre, modifié" });
		assert.equal(ok.status, 200, ok.texte);
		assert.equal(d.sale, false);
		assert.deepEqual(fichiersDuCommit(depot), [`retours/${b}.json`]);
		assert.equal(lireHead(depot, a).version, 1); assert.equal(lireHead(depot, a).text, "ide 1");
		assert.equal(git(depot, "status", "--porcelain").trim(), "", "arbre et index égaux à HEAD");
		const l = await appel(u, "/api/p/jardin/retours", { cookie: moi });
		assert.equal(l.corps.docs.find((x: any) => x.id === a).donnees.text, "ide 1");
		// Après redémarrage : toujours la version acceptée, jamais l'écriture refusée.
		await s.arreter();
		s = await serveurTest(donnees); u = s.url; d = s.ctx.depots.get("jardin")!;
		moi = await session(u, "jardin", "moi", "contributeur");
		const apres = (await appel(u, "/api/p/jardin/retours", { cookie: moi })).corps.docs.find((x: any) => x.id === a);
		assert.equal(apres.version, 1); assert.equal(apres.donnees.text, "ide 1");
	});

	test("verrou bref d'un git extérieur (git status) : l'écriture est relancée et passe", async () => {
		const avant = nbCommits(depot);
		fs.writeFileSync(verrou(), "");
		setTimeout(() => fs.rmSync(verrou(), { force: true }), 300);
		const r = await creer({ text: "pendant un git status" });
		assert.equal(r.status, 201, r.texte);
		assert.equal(nbCommits(depot), avant + 1);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
	});

	test("verrou tenu pendant toute l'écriture : clean lancé même si reset échoue, aucun fichier fantôme ; tout rentre dans l'ordre ensuite", async () => {
		const victime = (await creer({ text: "toujours vivant" })).corps.id;
		const avant = new Set(fs.readdirSync(path.join(depot, "retours")));
		d.relances = 1; d.pauseRelanceMs = 20;
		fs.writeFileSync(verrou(), "");
		try {
			// « git add » échoue : le fichier du nouveau retour reste non suivi ; reset échoue aussi, clean doit passer.
			const r = await creer({ text: "jamais enregistré" });
			assert.equal(r.status, 503); assert.equal(r.corps.message, MESSAGE_INDISPONIBLE);
			const orphelins = fs.readdirSync(path.join(depot, "retours")).filter(f => !avant.has(f));
			assert.deepEqual(orphelins, [], "aucun fichier de retour refusé laissé sur le disque");
			// Suppression refusée : le fichier reste effacé tant que le verrou empêche la restauration…
			assert.equal((await appel(u, `/api/p/jardin/retours/${victime}?version=1`, { cookie: moi, methode: "DELETE" })).status, 503);
			assert.equal(d.sale, true);
		} finally { fs.rmSync(verrou(), { force: true }); d.relances = 5; d.pauseRelanceMs = 150; }
		// … et revient avant l'écriture suivante.
		assert.equal((await creer({ text: "après" })).status, 201);
		assert.ok(fs.existsSync(path.join(depot, "retours", victime + ".json")), "retour toujours vivant rétabli sur le disque");
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		// Des notes déposées à la main dans notes/ (non commitées) survivent à une écriture ratée et à sa restauration.
		const note = path.join(depot, "notes", "notes_main.json");
		fs.writeFileSync(note, "{}\n");
		const hook = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		try { assert.equal((await creer({ text: "refusé" })).status, 503); } finally { fs.unlinkSync(hook); }
		assert.ok(fs.existsSync(note), "notes déposées à la main gardées");
		fs.unlinkSync(note);
		const memoire = (await appel(u, "/api/p/jardin/retours", { cookie: moi })).corps.docs.length;
		assert.equal(memoire, fs.readdirSync(path.join(depot, "retours")).filter(f => f.endsWith(".json")).length, "mémoire = disque = HEAD");
		assert.ok(!(await appel(u, "/api/p/jardin/retours", { cookie: moi })).corps.docs.some((x: any) => x.donnees.text === "jamais enregistré"));
	});

	test("API de test : 503 au message générique (mettre, notes)", async () => {
		const hook = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, `#!/bin/sh\necho "refus du crochet ${donnees.replace(/\\/g, "/")}" >&2\nexit 1\n`, { mode: 0o755 });
		try {
			const m = await appel(u, "/__test/mettre", { corps: { projet: "jardin", id: "zzhook", donnees: docRetour() } });
			assert.equal(m.status, 503); assert.equal(m.corps.message, MESSAGE_INDISPONIBLE);
			const n = await appel(u, "/__test/notes", { corps: { projet: "jardin", nom: "notes_crochet.json", notes: { date: "2026-11-23" } } });
			assert.equal(n.status, 503); assert.equal(n.corps.message, MESSAGE_INDISPONIBLE);
		} finally { fs.unlinkSync(hook); }
		assert.equal(git(depot, "status", "--porcelain").trim(), "", "notes refusées effacées");
	});

	test("ids égaux à la casse près : refusés par l'API de test, jamais générés", async () => {
		const a = await appel(u, "/__test/mettre", { corps: { projet: "jardin", id: "casse", donnees: docRetour({ text: "casse" }) } });
		assert.equal(a.status, 200);
		const avant = nbCommits(depot);
		const b = await appel(u, "/__test/mettre", { corps: { projet: "jardin", id: "CASSE", donnees: docRetour({ text: "CASSE" }) } });
		assert.equal(b.status, 400); assert.match(b.corps.message, /casse/);
		assert.equal(nbCommits(depot), avant, "aucun commit (surtout pas un commit vide)");
		const docs = (await appel(u, "/__test/retours?projet=jardin")).corps.docs.filter((x: any) => x.id.toLowerCase() === "casse");
		assert.deepEqual(docs.map((x: any) => [x.id, x.donnees.text]), [["casse", "casse"]]);
		assert.equal(d.homonyme("CaSsE"), "casse");
		assert.equal(d.homonyme("casse"), undefined);
	});
});

describe("Git : démarrage après un arrêt brutal, config du dépôt", () => {
	test("verrous restés (index.lock, refs/heads/main.lock) et restes non commités : nettoyés au démarrage, projet chargé, écritures possibles", async () => {
		const donnees = dossierTemp("verrous");
		let s = await serveurTest(donnees);
		try {
			await projet(s.url, "verif");
			let moi = await session(s.url, "verif", "moi", "contributeur");
			assert.equal((await appel(s.url, "/api/p/verif/retours", { cookie: moi, corps: docRetour() })).status, 201);
			await s.arreter();
			const depot = depotDe(donnees, "verif");
			fs.writeFileSync(path.join(depot, ".git", "index.lock"), "");
			fs.writeFileSync(path.join(depot, ".git", "refs", "heads", "main.lock"), "");
			fs.writeFileSync(path.join(depot, "retours", "orphelin1234567890ab.json"), "{}\n");
			s = await serveurTest(donnees);
			assert.ok(s.ctx.depots.has("verif"), "projet chargé (pas ignoré)");
			assert.ok(!fs.existsSync(path.join(depot, ".git", "index.lock")));
			assert.ok(!fs.existsSync(path.join(depot, ".git", "refs", "heads", "main.lock")));
			assert.ok(!fs.existsSync(path.join(depot, "retours", "orphelin1234567890ab.json")));
			moi = await session(s.url, "verif", "moi", "contributeur");
			assert.equal((await appel(s.url, "/api/p/verif/session", { cookie: moi })).status, 200);
			const r = await appel(s.url, "/api/p/verif/retours", { cookie: moi, corps: docRetour() });
			assert.equal(r.status, 201, r.texte);
			assert.equal(git(depot, "status", "--porcelain").trim(), "");
		} finally { await s.arreter(); nettoyer(donnees); }
	});

	test("config locale (autocrlf=false, identité du serveur) et .gitattributes : un clone avec autocrlf=true garde les JSON en LF", async () => {
		const donnees = dossierTemp("configgit");
		let s = await serveurTest(donnees);
		try {
			await projet(s.url, "verif");
			const moi = await session(s.url, "verif", "moi", "contributeur");
			const id = (await appel(s.url, "/api/p/verif/retours", { cookie: moi, corps: docRetour({ text: "a\nb" }) })).corps.id;
			const depot = depotDe(donnees, "verif");
			assert.equal(git(depot, "config", "--local", "--get", "core.autocrlf").trim(), "false");
			assert.equal(git(depot, "config", "--local", "--get", "user.name").trim(), "WDD serveur");
			assert.equal(git(depot, "config", "--local", "--get", "user.email").trim(), "serveur@wdd.invalid");
			const racine = git(depot, "rev-list", "--max-parents=0", "HEAD").trim();
			assert.ok(fichiersDuCommit(depot, racine).includes(".gitattributes"));
			assert.match(git(depot, "show", "HEAD:.gitattributes"), /\*\.json text eol=lf/);
			const clone = path.join(donnees, "clone");
			execFileSync("git", ["-c", "core.autocrlf=true", "clone", "-q", depot, clone], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
			assert.ok(!fs.readFileSync(path.join(clone, "retours", id + ".json"), "utf8").includes("\r"), "LF dans le clone");
			// Dépôt créé avant cette correction (config locale absente) : posée au démarrage.
			await s.arreter();
			git(depot, "config", "--local", "--unset", "core.autocrlf");
			git(depot, "config", "--local", "--unset", "user.name");
			s = await serveurTest(donnees);
			assert.equal(git(depot, "config", "--local", "--get", "core.autocrlf").trim(), "false");
			assert.equal(git(depot, "config", "--local", "--get", "user.name").trim(), "WDD serveur");
		} finally { await s.arreter(); nettoyer(donnees); }
	});
});

