// Écritures : file d'attente (100 écritures concurrentes -> 100 commits), versions (409), batch tout ou rien,
// auteur des commits, restauration si le commit échoue, rechargement de l'index depuis le dépôt au redémarrage.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

describe("écritures et commits", () => {
	let s: Serveur, donnees: string, u: string, depot: string, moi: string, collegue: string, bearer: string;
	before(async () => {
		donnees = dossierTemp("ecritures");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		moi = await session(u, "jardin", "moi", "contributeur", "Benoît Lefèvre");
		collegue = await session(u, "jardin", "collegue", "contributeur", "Collègue");
		const adm = await session(u, "jardin", "adm", "admin");
		bearer = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent essai" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const creer = (cookie: string, extra = {}) => appel(u, "/api/p/jardin/retours", { cookie, corps: docRetour(extra) });
	const fichiers = () => fs.readdirSync(path.join(depot, "retours")).filter(f => f.endsWith(".json")).sort();

	test("file d'attente : 100 écritures concurrentes -> 100 commits, aucune perte", async () => {
		const avant = nbCommits(depot), n0 = fichiers().length;
		const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => creer(i % 2 ? moi : collegue, { text: "retour n° " + i })));
		assert.ok(rs.every(r => r.status === 201), rs.map(r => r.status).join(","));
		assert.equal(new Set(rs.map(r => r.corps.id)).size, 100);
		assert.equal(nbCommits(depot), avant + 100);
		assert.equal(fichiers().length, n0 + 100);
		const l = await appel(u, "/api/p/jardin/retours", { cookie: moi });
		const textes = new Set(l.corps.docs.map((d: any) => d.donnees.text));
		for (let i = 0; i < 100; i++) assert.ok(textes.has("retour n° " + i));
		assert.equal(git(depot, "status", "--porcelain").trim(), "", "arbre propre");
		// 20 modifications concurrentes du même retour avec la même version : une seule passe, les autres 409.
		const id = rs[0].corps.id;
		const ps = await Promise.all(Array.from({ length: 20 }, (_, i) => appel(u, `/api/p/jardin/retours/${id}`, { cookie: collegue, methode: "PATCH", corps: { champs: { proposal: "p" + i }, version: 1 } })));
		assert.equal(ps.filter(r => r.status === 200).length, 1);
		assert.equal(ps.filter(r => r.status === 409).length, 19);
	});

	test("fichier d'un retour : 15 champs + version, JSON trié, indenté, LF", async () => {
		const r = await creer(moi, { text: "ligne 1\nligne 2" });
		const brut = fs.readFileSync(path.join(depot, "retours", r.corps.id + ".json"), "utf8");
		assert.ok(!brut.includes("\r"));
		assert.ok(brut.endsWith("}\n"));
		const o = JSON.parse(brut);
		assert.deepEqual(Object.keys(o), [...Object.keys(o)].sort());
		assert.equal(Object.keys(o).length, 16);
		assert.equal(o.version, 1);
		assert.match(brut, /^\{\n  "anchor": /);
	});

	test("versions : 409 avec le document à jour sur PATCH et DELETE, 404 si absent", async () => {
		const r = await creer(moi);
		const id = r.corps.id;
		const p1 = await appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "a" }, version: 1 } });
		assert.equal(p1.status, 200); assert.equal(p1.corps.version, 2);
		const p2 = await appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "b" }, version: 1 } });
		assert.equal(p2.status, 409); assert.equal(p2.corps.code, "conflict");
		assert.equal(p2.corps.document.version, 2); assert.equal(p2.corps.document.donnees.proposal, "a"); assert.equal(p2.corps.document.id, id);
		const d1 = await appel(u, `/api/p/jardin/retours/${id}?version=1`, { cookie: moi, methode: "DELETE" });
		assert.equal(d1.status, 409); assert.equal(d1.corps.document.version, 2);
		const sansVersion = await appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, methode: "DELETE" });
		assert.equal(sansVersion.status, 400);
		const d2 = await appel(u, `/api/p/jardin/retours/${id}?version=2`, { cookie: moi, methode: "DELETE" });
		assert.equal(d2.status, 204);
		assert.ok(!fs.existsSync(path.join(depot, "retours", id + ".json")));
		const d3 = await appel(u, `/api/p/jardin/retours/${id}?version=2`, { cookie: moi, methode: "DELETE" });
		assert.equal(d3.status, 404); assert.equal(d3.corps.code, "not_found");
		const p3 = await appel(u, `/api/p/jardin/retours/${id}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "c" }, version: 2 } });
		assert.equal(p3.status, 404);
	});

	test("batch : tout ou rien, un seul commit", async () => {
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push((await creer(moi, { text: "batch " + i })).corps.id);
		const lire = async () => Object.fromEntries((await appel(u, "/api/p/jardin/retours", { bearer })).corps.docs.map((d: any) => [d.id, d]));
		const avant = nbCommits(depot), contenu = ids.map(id => fs.readFileSync(path.join(depot, "retours", id + ".json"), "utf8"));
		const t = new Date().toISOString();
		const bon = (id: string) => ({ id, version: 1, champs: { status: "fait", reply: "Fait.", replied: t, updated: t } });
		// Une entrée invalide (champ inconnu, ou refusé à l'agent) : aucun fichier ni commit.
		for (const [mauvaise, statut, code] of [
			[{ id: ids[2], version: 1, champs: { couleur: "rouge" } }, 400, "invalid_document"],
			[{ id: ids[2], version: 1, champs: { text: "réécrit" } }, 403, "permission_denied"],
			[{ id: "ZZZZZZZZZZZZZZZZZZZZ", version: 1, champs: { status: "fait" } }, 404, "not_found"],
			[{ id: "../../x", version: 1, champs: { status: "fait" } }, 404, "not_found"],
			[{ id: ids[2], version: 1, champs: { replied: "pas une date" } }, 400, "invalid_document"],
		] as const) {
			const r = await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [bon(ids[0]), bon(ids[1]), mauvaise] } });
			assert.equal(r.status, statut, r.texte); assert.equal(r.corps.code, code); assert.equal(r.corps.index, 2);
			assert.equal(nbCommits(depot), avant);
			assert.deepEqual(ids.map(id => fs.readFileSync(path.join(depot, "retours", id + ".json"), "utf8")), contenu);
		}
		// Une version périmée : 409 avec la première entrée fautive et son document à jour.
		await appel(u, `/api/p/jardin/retours/${ids[1]}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "changé" }, version: 1 } });
		const avant2 = nbCommits(depot);
		const c = await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [bon(ids[0]), bon(ids[1]), bon(ids[2])] } });
		assert.equal(c.status, 409); assert.equal(c.corps.index, 1); assert.equal(c.corps.id, ids[1]);
		assert.equal(c.corps.document.version, 2); assert.equal(c.corps.document.donnees.proposal, "changé");
		assert.equal(nbCommits(depot), avant2);
		assert.equal((await lire())[ids[0]].version, 1);
		// Doublon, liste vide, plus de 50 : refusés.
		assert.equal((await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [bon(ids[0]), bon(ids[0])] } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [] } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: Array.from({ length: 51 }, () => bon(ids[0])) } })).status, 400);
		// Tout bon : un seul commit, chaque version +1.
		const ok = await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [bon(ids[0]), { ...bon(ids[1]), version: 2 }, bon(ids[2])] } });
		assert.equal(ok.status, 200, ok.texte);
		assert.deepEqual(ok.corps.versions, [{ id: ids[0], version: 2 }, { id: ids[1], version: 3 }, { id: ids[2], version: 2 }]);
		assert.equal(nbCommits(depot), avant2 + 1);
		assert.equal(git(depot, "log", "-1", "--format=%s").trim(), "batch : 3 retours");
		const apres = await lire();
		assert.ok(ids.every(id => apres[id].donnees.status === "fait" && apres[id].donnees.reply === "Fait."));
		assert.equal(apres[ids[1]].donnees.proposal, "changé", "les autres champs restent");
		// Message accordé : « batch : 1 retour ».
		const un = await appel(u, "/api/p/jardin/retours/batch", { bearer, corps: { ecritures: [{ ...bon(ids[0]), version: 2, champs: { reply: "Fait, relu." } }] } });
		assert.equal(un.status, 200, un.texte);
		assert.equal(git(depot, "log", "-1", "--format=%s").trim(), "batch : 1 retour");
	});

	test("auteur des commits : nom affiché et <id>@wdd.invalid ; committer le serveur ; trailer Par:", async () => {
		const r = await creer(moi, { kind: "regle", ref: "arrosage" });
		const [an, ae, cn, ce, sujet] = git(depot, "log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%s").trim().split("\n");
		assert.equal(an, "Benoît Lefèvre"); assert.equal(ae, "moi@wdd.invalid");
		assert.equal(cn, "WDD serveur"); assert.equal(ce, "serveur@wdd.invalid");
		assert.equal(sujet, `retour ${r.corps.id} : création (regle/arrosage)`);
		assert.equal(git(depot, "log", "-1", "--format=%(trailers:key=Par,valueonly)").trim(), "Benoît Lefèvre");
		await appel(u, `/api/p/jardin/retours/${r.corps.id}`, { bearer, methode: "PATCH", corps: { champs: { status: "pris" }, version: 1 } });
		const [an2, ae2, s2] = git(depot, "log", "-1", "--format=%an%n%ae%n%s").trim().split("\n");
		assert.equal(an2, "Agent essai (pour adm)", "jeton de l'API admin : propriétaire = l'admin (écart serveur 4)"); assert.match(ae2, /^agent-[A-Za-z0-9]+@wdd\.invalid$/);
		assert.equal(s2, `retour ${r.corps.id} : modification (regle/arrosage)`);
		await appel(u, `/api/p/jardin/retours/${r.corps.id}?version=2`, { cookie: moi, methode: "DELETE" });
		assert.equal(git(depot, "log", "-1", "--format=%s").trim(), `retour ${r.corps.id} : suppression (regle/arrosage)`);
	});

	test("échec du commit : fichiers restaurés, index inchangé, 503 unavailable", async () => {
		const r = await creer(moi);
		const avant = nbCommits(depot), fichiersAvant = fichiers(), contenu = fs.readFileSync(path.join(depot, "retours", r.corps.id + ".json"), "utf8");
		const hook = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, "#!/bin/sh\necho refus du crochet >&2\nexit 1\n", { mode: 0o755 });
		try {
			const c = await creer(moi);
			assert.equal(c.status, 503); assert.equal(c.corps.code, "unavailable");
			const p = await appel(u, `/api/p/jardin/retours/${r.corps.id}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "x" }, version: 1 } });
			assert.equal(p.status, 503);
			const d = await appel(u, `/api/p/jardin/retours/${r.corps.id}?version=1`, { cookie: moi, methode: "DELETE" });
			assert.equal(d.status, 503);
		} finally { fs.unlinkSync(hook); }
		assert.equal(nbCommits(depot), avant);
		assert.deepEqual(fichiers(), fichiersAvant);
		assert.equal(fs.readFileSync(path.join(depot, "retours", r.corps.id + ".json"), "utf8"), contenu);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		const l = await appel(u, "/api/p/jardin/retours", { cookie: moi });
		assert.equal(l.corps.docs.find((x: any) => x.id === r.corps.id).version, 1);
		assert.equal(l.corps.docs.length, fichiersAvant.length);
		assert.equal((await creer(moi)).status, 201, "le serveur écrit de nouveau");
	});
});

describe("rechargement de l'index au redémarrage", () => {
	test("le dépôt fait foi : retours et versions relus, restes non commités effacés", async () => {
		const donnees = dossierTemp("recharge");
		try {
			let s = await serveurTest(donnees);
			await projet(s.url, "jardin");
			const moi = await session(s.url, "jardin", "moi", "contributeur");
			const a = (await appel(s.url, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "A" }) })).corps.id;
			const b = (await appel(s.url, "/api/p/jardin/retours", { cookie: moi, corps: docRetour({ text: "B" }) })).corps.id;
			await appel(s.url, `/api/p/jardin/retours/${a}`, { cookie: moi, methode: "PATCH", corps: { champs: { proposal: "pa" }, version: 1 } });
			const avant = (await appel(s.url, "/api/p/jardin/retours", { cookie: moi })).corps;
			await s.arreter();
			// Restes d'une écriture interrompue : un fichier non commité et un fichier modifié sans commit.
			const depot = depotDe(donnees, "jardin");
			fs.writeFileSync(path.join(depot, "retours", "Orphelin00000000000.json"), JSON.stringify({ text: "jamais commité", version: 1 }));
			fs.writeFileSync(path.join(depot, "retours", b + ".json"), JSON.stringify({ text: "modifié hors commit", version: 9 }));
			s = await serveurTest(donnees);
			const moi2 = await session(s.url, "jardin", "moi", "contributeur");
			const apres = (await appel(s.url, "/api/p/jardin/retours", { cookie: moi2 })).corps;
			assert.deepEqual(apres, avant);
			assert.equal(apres.docs.find((d: any) => d.id === a).version, 2);
			assert.ok(!fs.existsSync(path.join(depot, "retours", "Orphelin00000000000.json")));
			// La session d'avant le redémarrage vaut toujours (SQLite).
			assert.equal((await appel(s.url, "/api/p/jardin/session", { cookie: moi })).status, 200);
			// Écriture après rechargement : la version continue.
			const p = await appel(s.url, `/api/p/jardin/retours/${a}`, { cookie: moi2, methode: "PATCH", corps: { champs: { proposal: "pb" }, version: 2 } });
			assert.equal(p.corps.version, 3);
			await s.arreter();
		} finally { nettoyer(donnees); }
	});
});
