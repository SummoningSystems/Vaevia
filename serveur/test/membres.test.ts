// Projet, membres, jetons, réglages (docs/etape3-meta-interface.md § 3.2), administration (§ 3.3), journal (§ 3.4),
// jetons « pour X » et leur révocation (§ 1.4), GET /api/moi. Les routes de § 3.2 répondent aux sessions seulement.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits, ecouter } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

describe("membres, invitations, jetons, réglages (§ 3.2)", () => {
	let s: Serveur, donnees: string, u: string, depot: string;
	let adm: string, maud: string, marc: string, camille: string, lea: string, agent: string, jetonM: string;
	before(async () => {
		donnees = dossierTemp("membres");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		await projet(u, "verger");
		depot = depotDe(donnees, "jardin");
		adm = await session(u, "jardin", "adm", "admin", "Admin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		marc = await session(u, "jardin", "marc", "mainteneur", "Marc");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent" } })).corps.jeton;
		jetonM = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Jeton M", role: "mainteneur" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("§ 3.2 : sessions seulement ; 403 avec un Bearer, même mainteneur ; 403 pour un contributeur ou un lecteur", async () => {
		const routes: [string, string, unknown?][] = [
			["GET", "/api/p/jardin/membres"], ["PUT", "/api/p/jardin/membres/camille", { role: "lecteur" }], ["DELETE", "/api/p/jardin/membres/camille"],
			["POST", "/api/p/jardin/invitations", { role: "contributeur" }], ["DELETE", "/api/p/jardin/invitations/abc"],
			["GET", "/api/p/jardin/jetons"], ["POST", "/api/p/jardin/jetons", { nom: "x" }], ["DELETE", "/api/p/jardin/jetons/abc"],
			["PUT", "/api/p/jardin/reglages", { url_commit: "" }],
		];
		for (const [methode, chemin, corps] of routes) {
			for (const bearer of [agent, jetonM]) {
				const r = await appel(u, chemin, { bearer, methode, corps });
				assert.equal(r.status, 403, `${methode} ${chemin} avec un jeton : ${r.texte}`);
			}
			for (const cookie of [camille, lea]) assert.equal((await appel(u, chemin, { cookie, methode, corps })).status, 403, `${methode} ${chemin} contributeur/lecteur`);
		}
		assert.equal((await appel(u, "/api/p/jardin/membres", { cookie: maud })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/membres", { cookie: adm })).status, 200, "admin sans rôle de projet");
		assert.equal((await appel(u, "/api/moi", { bearer: agent })).status, 403);
	});

	// La garde du « dernier mainteneur » (gestion.ts) n'est pas atteignable par l'API : un mainteneur ne change pas son propre
	// rôle, et un autre mainteneur fait qu'il n'est pas le dernier ; l'admin passe outre. Elle reste en défense.
	test("membres : liste, changement de rôle, soi-même refusé (le dernier mainteneur ne se rétrograde donc pas), non-membre 404, l'admin passe outre", async () => {
		const l = (await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps;
		assert.deepEqual(l.membres.map((x: any) => [x.compte, x.role]).sort(), [["camille", "contributeur"], ["lea", "lecteur"], ["marc", "mainteneur"], ["maud", "mainteneur"]]);
		assert.ok(l.membres.every((x: any) => !Number.isNaN(Date.parse(x.depuis)) && typeof x.nom === "string"));
		const put = (cookie: string, compte: string, role: unknown) => appel(u, `/api/p/jardin/membres/${compte}`, { cookie, methode: "PUT", corps: { role } });
		assert.equal((await put(maud, "lea", "contributeur")).status, 200);
		assert.equal((await put(maud, "lea", "admin")).status, 400);
		assert.equal((await put(maud, "maud", "contributeur")).status, 403, "un mainteneur ne change pas son propre rôle");
		assert.equal((await appel(u, "/api/p/jardin/membres/maud", { cookie: maud, methode: "DELETE" })).status, 403);
		assert.equal((await put(maud, "inconnu", "lecteur")).status, 404);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "rôle changé" && e.cible === "lea" && /lecteur/.test(e.detail) && /contributeur/.test(e.detail)));
		// Marc rétrogradé par Maud (il en reste un) ; Maud est alors la dernière : elle ne se rétrograde pas, l'admin le peut.
		assert.equal((await put(maud, "marc", "contributeur")).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/membres", { cookie: marc })).status, 403, "Marc n'est plus mainteneur");
		assert.equal(s.ctx.base.mainteneursActifs("jardin"), 1);
		assert.equal((await put(maud, "maud", "contributeur")).status, 403);
		const a = await put(adm, "maud", "contributeur");
		assert.equal(a.status, 200, "l'admin peut rétrograder le dernier mainteneur");
		assert.equal((await put(adm, "maud", "mainteneur")).status, 200);
		assert.equal((await put(adm, "marc", "mainteneur")).status, 200);
	});

	test("retirer un membre : ses écritures cessent, ses jetons de CE projet sont révoqués, ses flux coupés", async () => {
		await session(u, "verger", "marc", "mainteneur", "Marc");
		const jJardin = (await appel(u, "/api/p/jardin/jetons", { cookie: marc, corps: { nom: "Agent de Marc" } })).corps;
		const jVerger = (await appel(u, "/api/p/verger/jetons", { cookie: marc, corps: { nom: "Agent de Marc" } })).corps;
		assert.deepEqual(jJardin.pour, { id: "marc", nom: "Marc" });
		const e = await ecouter(s.port, "/api/p/jardin/flux", { bearer: jJardin.jeton });
		await e.attendre(1);
		const r = await appel(u, "/api/p/jardin/membres/marc", { cookie: maud, methode: "DELETE" });
		assert.equal(r.status, 200, r.texte); assert.deepEqual(r.corps.jetons_revoques, [jJardin.id]);
		await Promise.race([e.ferme, new Promise((_, k) => setTimeout(() => k(new Error("flux non coupé")), 3000))]);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jJardin.jeton })).status, 401);
		assert.equal((await appel(u, "/api/p/verger/session", { bearer: jVerger.jeton })).status, 200, "jeton d'un autre projet intact");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: marc, corps: docRetour() })).status, 403);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "rôle retiré" && e.cible === "marc" && e.qui === "maud"));
		assert.equal((await appel(u, "/api/p/jardin/membres/marc", { cookie: maud, methode: "DELETE" })).status, 404);
		await session(u, "jardin", "marc", "mainteneur", "Marc");
	});

	test("invitations du projet : jusqu'à mainteneur, listées en attente, annulées ; utilisée → journal", async () => {
		const c = await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "mainteneur" } });
		assert.equal(c.status, 201, c.texte); assert.match(c.corps.lien, /^\/invitation\/[A-Za-z0-9_-]+$/); assert.match(c.corps.id, /^[A-Za-z0-9]{12}$/);
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "admin" } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur", expire: "2000-01-01T00:00:00Z" } })).status, 400);
		const l = (await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps.invitations;
		const vue = l.find((i: any) => i.id === c.corps.id);
		assert.ok(vue); assert.equal(vue.role, "mainteneur"); assert.equal(vue.par, "maud");
		assert.ok(!JSON.stringify(l).includes(c.corps.lien.split("/").pop()), "aucun secret dans la liste");
		// Annuler : le lien ne vaut plus.
		assert.equal((await appel(u, `/api/p/jardin/invitations/${c.corps.id}`, { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, c.corps.lien)).status, 404);
		assert.equal((await appel(u, `/api/p/jardin/invitations/${c.corps.id}`, { cookie: maud, methode: "DELETE" })).status, 400, "déjà annulée");
		// Invitation d'un autre projet : 404.
		const v = await appel(u, "/api/admin/invitations", { cookie: adm, corps: { projet: "verger", role: "lecteur" } });
		assert.equal((await appel(u, `/api/p/jardin/invitations/${v.corps.id}`, { cookie: maud, methode: "DELETE" })).status, 404);
		// Utilisée : compte créé avec le rôle ; journal « invitation utilisée » et « rôle donné ».
		const i2 = (await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "contributeur" } })).corps;
		const ent = await appel(u, i2.lien, { corps: { nom: "Nina" } });
		assert.equal(ent.status, 303);
		const j = s.ctx.base.lireJournal();
		const util = j.find(e => e.action === "invitation utilisée" && e.cible === i2.id);
		assert.ok(util); assert.equal(util!.projet, "jardin");
		assert.ok(j.some(e => e.action === "rôle donné" && e.qui === util!.qui && /contributeur/.test(e.detail)));
		assert.ok(j.some(e => e.action === "invitation créée" && e.cible === i2.id && e.qui === "maud"));
		assert.ok(j.some(e => e.action === "invitation annulée" && e.cible === c.corps.id));
		assert.ok((await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps.membres.some((m: any) => m.nom === "Nina" && m.role === "contributeur"));
	});

	test("invitations : expiration de 30 jours au plus ; celles d'un mainteneur retiré ou rétrogradé sont annulées", async () => {
		const jours = (n: number) => new Date(Date.now() + n * 86400000).toISOString();
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur", expire: "2099-01-01T00:00:00Z" } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur", expire: jours(31) } })).status, 400);
		assert.equal((await appel(u, "/api/admin/invitations", { cookie: adm, corps: { role: "admin", expire: jours(31) } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur", expire: jours(29) } })).status, 201);
		// Un 3e mainteneur, Paul, invite ; il est retiré : ses liens ne valent plus (ceux de Maud, si).
		await session(u, "jardin", "paul", "mainteneur", "Paul");
		const paul = await session(u, "jardin", "paul", "mainteneur", "Paul");
		await session(u, "verger", "paul", "mainteneur", "Paul");
		const ip = (await appel(u, "/api/p/jardin/invitations", { cookie: paul, corps: { role: "mainteneur", expire: jours(20) } })).corps;
		const ipv = (await appel(u, "/api/p/verger/invitations", { cookie: paul, corps: { role: "lecteur" } })).corps;
		const im = (await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur" } })).corps;
		const r = await appel(u, "/api/p/jardin/membres/paul", { cookie: maud, methode: "DELETE" });
		assert.equal(r.status, 200); assert.deepEqual(r.corps.invitations_annulees, [ip.id]);
		assert.equal((await appel(u, ip.lien)).status, 404, "le lien de Paul sur jardin ne vaut plus");
		assert.equal((await appel(u, ipv.lien)).status, 200, "son lien sur verger (où il reste mainteneur) vaut toujours");
		assert.equal((await appel(u, im.lien)).status, 200, "le lien de Maud vaut toujours");
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "rôle retiré" && e.cible === "paul" && e.detail.includes(ip.id)));
		// Rétrogradé (mainteneur → contributeur) : ses invitations de ce projet sont annulées.
		await session(u, "jardin", "paul", "mainteneur", "Paul");
		const ip2 = (await appel(u, "/api/p/jardin/invitations", { cookie: paul, corps: { role: "mainteneur" } })).corps;
		const d = await appel(u, "/api/p/jardin/membres/paul", { cookie: maud, methode: "PUT", corps: { role: "contributeur" } });
		assert.equal(d.status, 200); assert.deepEqual(d.corps.invitations_annulees, [ip2.id]);
		assert.equal((await appel(u, ip2.lien)).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/membres/paul", { cookie: maud, methode: "DELETE" })).status, 200);
	});

	test("un jeton ne vaut jamais plus que son propriétaire : rétrogradé, son jeton mainteneur ne vaut qu'agent ; lecteur ou sans rôle, plus rien", async () => {
		await session(u, "jardin", "rose", "mainteneur", "Rose");
		const rose = await session(u, "jardin", "rose", "mainteneur", "Rose");
		const jm = (await appel(u, "/api/p/jardin/jetons", { cookie: rose, corps: { nom: "Agent de Rose", role: "mainteneur" } })).corps.jeton;
		const role = async () => { const r = await appel(u, "/api/p/jardin/session", { bearer: jm }); return r.status === 200 ? r.corps.role : r.status; };
		const put = (r: string) => appel(u, "/api/p/jardin/membres/rose", { cookie: maud, methode: "PUT", corps: { role: r } });
		assert.equal(await role(), "mainteneur");
		assert.equal((await put("contributeur")).status, 200);
		assert.equal(await role(), "agent", "contributeur : le jeton ne vaut qu'agent");
		const t = await appel(u, "/api/p/jardin/tickets", { bearer: jm, corps: { titre: "x" } });
		assert.equal(t.status, 201, "il agit comme agent");
		assert.equal((await appel(u, `/api/p/jardin/tickets/${t.corps.id}?version=1`, { bearer: jm, methode: "DELETE" })).status, 403, "mais ne supprime pas (droit du mainteneur)");
		assert.equal((await appel(u, `/api/p/jardin/tickets/${t.corps.id}?version=1`, { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await put("lecteur")).status, 200);
		assert.equal(await role(), 401, "lecteur : le jeton ne vaut plus");
		assert.equal((await put("mainteneur")).status, 200);
		assert.equal(await role(), "mainteneur", "son rôle revient, le jeton aussi");
		// Propriétaire désactivé directement en base (sans révocation) : le jeton ne vaut plus.
		s.ctx.base.db.prepare("UPDATE comptes SET desactive = ? WHERE id = 'rose'").run(new Date().toISOString());
		assert.equal(await role(), 401, "propriétaire désactivé, jeton non révoqué");
		s.ctx.base.db.prepare("UPDATE comptes SET desactive = NULL WHERE id = 'rose'").run();
		assert.equal(await role(), "mainteneur");
		assert.equal((await appel(u, "/api/p/jardin/membres/rose", { cookie: maud, methode: "DELETE" })).status, 200);
	});

	test("jetons du projet : propriétaire = le créateur, valeur montrée une fois, liste sans secret, révocation", async () => {
		const c = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent CI", role: "agent" } });
		assert.equal(c.status, 201, c.texte); assert.match(c.corps.jeton, /^wdd_/); assert.deepEqual(c.corps.pour, { id: "maud", nom: "Maud" });
		assert.equal((await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "x", role: "admin" } })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "x", projet: "verger" } })).status, 400);
		const l = await appel(u, "/api/p/jardin/jetons", { cookie: maud });
		const vu = l.corps.jetons.find((j: any) => j.id === c.corps.id);
		assert.deepEqual(Object.keys(vu).sort(), ["cree", "expire", "expiree", "id", "nom", "origine", "pour", "revoque", "role"]);
		assert.ok(!l.texte.includes(c.corps.jeton));
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: c.corps.jeton })).corps.pour.nom, "Maud");
		assert.equal((await appel(u, `/api/p/verger/jetons/${c.corps.id}`, { cookie: adm, methode: "DELETE" })).status, 404, "jeton d'un autre projet");
		assert.equal((await appel(u, `/api/p/jardin/jetons/${c.corps.id}`, { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: c.corps.jeton })).status, 401);
		assert.equal((await appel(u, `/api/p/jardin/jetons/${c.corps.id}`, { cookie: maud, methode: "DELETE" })).status, 404);
		const j = s.ctx.base.lireJournal();
		assert.ok(j.some(e => e.action === "jeton créé" && e.cible === c.corps.id && e.qui === "maud"));
		assert.ok(j.some(e => e.action === "jeton révoqué" && e.cible === c.corps.id));
	});

	test("réglages : lecture par tout membre (jeton compris), écriture par un mainteneur en session ; validation ; un commit ; titre gardé", async () => {
		const g = await appel(u, "/api/p/jardin/reglages", { bearer: agent });
		assert.equal(g.status, 200); assert.deepEqual([g.corps.disciplines, g.corps.url_commit], [[], ""]);
		assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: lea })).status, 200);
		const put = (corps: unknown, cookie = maud) => appel(u, "/api/p/jardin/reglages", { cookie, methode: "PUT", corps });
		const disc = (n: number) => Array.from({ length: n }, (_, i) => ({ nom: `d${i}`, libelle: `D${i}` }));
		for (const corps of [{ disciplines: disc(13) }, { disciplines: [{ nom: "Majuscule", libelle: "x" }] }, { disciplines: [{ nom: "a", libelle: "x" }, { nom: "a", libelle: "y" }] },
			{ disciplines: [{ nom: "a", libelle: "x".repeat(41) }] }, { disciplines: [{ nom: "a", libelle: "" }] }, { disciplines: [{ nom: "a", libelle: "x", couleur: "rouge" }] },
			{ url_commit: "javascript:alert(1)//{hash}" }, { url_commit: "https://git.exemple/commit/" }, { url_commit: "ftp://x/{hash}" }, { url_commit: "https://x/{hash}/{autre}" },
			{ titre: "nouveau titre" }, {}])
			assert.equal((await put(corps)).status, 400, JSON.stringify(corps).slice(0, 70));
		const n0 = nbCommits(depot);
		const ok = await put({ disciplines: [{ nom: "programmation", libelle: "Programmation" }, { nom: "ihm", libelle: "IHM" }, { nom: "securite", libelle: "Sécurité" }], url_commit: "https://git.exemple/{depot}/commit/{hash}" });
		assert.equal(ok.status, 200, ok.texte);
		assert.equal(nbCommits(depot), n0 + 1);
		assert.deepEqual(git(depot, "show", "--name-only", "--format=", "HEAD").trim(), "site.json");
		assert.match(git(depot, "log", "-1", "--format=%an|%s"), /^Maud\|réglages : 3 disciplines, lien des commits/);
		const site = JSON.parse(git(depot, "show", "HEAD:site.json"));
		assert.equal(site.titre, "Projet jardin"); assert.equal(site.disciplines.length, 3); assert.equal(site.url_commit, "https://git.exemple/{depot}/commit/{hash}");
		assert.deepEqual((await appel(u, "/api/p/jardin/reglages", { cookie: camille })).corps.disciplines.map((d: any) => d.nom), ["programmation", "ihm", "securite"]);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "réglages changés" && e.qui === "maud"));
		// Retirer une discipline utilisée : 400 avec la liste des tickets.
		const t = await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "IHM du forum", discipline: "ihm" } });
		const retrait = await put({ disciplines: [{ nom: "programmation", libelle: "Programmation" }] });
		assert.equal(retrait.status, 400); assert.deepEqual(retrait.corps.tickets, [t.corps.id]);
		assert.equal((await put({ disciplines: [{ nom: "ihm", libelle: "Interface" }] })).status, 200, "retirer les disciplines inutilisées, renommer un libellé");
		assert.equal((await put({ url_commit: "" })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud })).corps.url_commit, "");
		// Relu au redémarrage.
		await s.arreter();
		s = await serveurTest(donnees); u = s.url;
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		assert.deepEqual((await appel(u, "/api/p/jardin/reglages", { cookie: maud })).corps.disciplines, [{ nom: "ihm", libelle: "Interface" }]);
		adm = await session(u, "jardin", "adm", "admin", "Admin");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
	});

	test("site.json illisible : réglages par défaut en lecture, écriture refusée (422)", async () => {
		await projet(u, "casse");
		const d = depotDe(donnees, "casse");
		await s.arreter();
		fs.writeFileSync(path.join(d, "site.json"), "{ pas du json");
		git(d, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "à la main");
		s = await serveurTest(donnees); u = s.url;
		const m = await session(u, "casse", "maud", "mainteneur", "Maud");
		assert.deepEqual((await appel(u, "/api/p/casse/reglages", { cookie: m })).corps.disciplines, []);
		assert.equal((await appel(u, "/api/p/casse/reglages", { cookie: m, methode: "PUT", corps: { url_commit: "" } })).status, 422);
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		adm = await session(u, "jardin", "adm", "admin", "Admin");
	});

	test("GET /api/moi : compte, projets (rôle, retours nouveaux, tickets à faire), isolement des pages", async () => {
		const r = await appel(u, "/api/moi", { cookie: maud });
		assert.equal(r.status, 200);
		assert.deepEqual(r.corps.compte, { id: "maud", nom: "Maud", admin: false });
		const j = r.corps.projets.find((p: any) => p.id === "jardin");
		assert.equal(j.role, "mainteneur"); assert.equal(j.page, "/p/jardin/");
		assert.equal(j.tickets_a_faire, 1); assert.equal(typeof j.retours_nouveaux, "number");
		assert.deepEqual(r.corps.isolement, { pages_separees: false, url_pages: null });
		assert.equal(r.corps.url, u, "adresse de l'hôte principal (sans WDD_URL : déduite de Host)");
		assert.equal((await appel(u, "/api/moi")).status, 401);
		assert.ok((await appel(u, "/api/moi", { cookie: adm })).corps.projets.length >= 2, "l'admin voit tous les projets");
	});
});

describe("GET /api/moi, champ url (étape 3.5, § 8.4) : WDD_URL plutôt que l'hôte de la requête", () => {
	let s: Serveur, donnees: string;
	before(async () => { donnees = dossierTemp("moi-url"); s = await serveurTest(donnees, { url: "http://poste-essai:8123" }); });
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("requête sur 127.0.0.1 : url = WDD_URL (l'adresse que vise la CLI)", async () => {
		await projet(s.url, "jardin");
		const maud = await session(s.url, "jardin", "maud", "mainteneur", "Maud");
		const r = await appel(s.url, "/api/moi", { cookie: maud });
		assert.equal(r.status, 200);
		assert.equal(r.corps.url, "http://poste-essai:8123");
	});
});

describe("administration (§ 3.3), désactivation et révocation (§ 1.4), journal (§ 3.4)", () => {
	let s: Serveur, donnees: string, u: string, adm: string, maud: string;
	const secrets: string[] = [];
	before(async () => {
		donnees = dossierTemp("admin");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		adm = await session(u, "jardin", "adm", "admin", "Admin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		secrets.push(adm.split("=")[1], maud.split("=")[1]);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("comptes : liste avec rôles ; modifier le nom ; réservé à l'admin", async () => {
		const l = await appel(u, "/api/admin/comptes", { cookie: adm });
		assert.equal(l.status, 200);
		const m = l.corps.comptes.find((c: any) => c.id === "maud");
		assert.deepEqual(m.projets, [{ projet: "jardin", role: "mainteneur" }]); assert.equal(m.desactive, null); assert.equal(m.admin, false);
		assert.equal((await appel(u, "/api/admin/comptes", { cookie: maud })).status, 403);
		const p = await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { nom: "Maud B." } });
		assert.equal(p.status, 200, p.texte); assert.equal(p.corps.compte.nom, "Maud B.");
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { nom: "<b>" } })).status, 400);
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { role: "x" } })).status, 400);
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { desactive: "oui" } })).status, 400);
		assert.equal((await appel(u, "/api/admin/comptes/personne", { cookie: adm, methode: "PATCH", corps: { nom: "x" } })).status, 404);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "compte modifié" && e.cible === "maud"));
	});

	test("désactiver : sessions supprimées, jetons dont il est propriétaire révoqués (flux coupé), connexion refusée ; signature « Agent (pour Maud B.) »", async () => {
		const j = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent" } })).corps;
		// Jeton sans propriétaire (créé avant l'étape 3, ou par l'API de test) : créé ici directement en base.
		const sansProprio = s.ctx.base.creerJeton("jardin", "Ancien");
		// POST /api/admin/jetons sans « pour » : propriétaire = l'admin qui le crée (écart serveur 4).
		const parAdmin = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent admin" } })).corps;
		secrets.push(j.jeton, sansProprio.jeton, parAdmin.jeton);
		assert.deepEqual(parAdmin.pour, { id: "adm", nom: "Admin" });
		assert.equal(s.ctx.base.jetons("jardin").find(x => x.id === parAdmin.id)?.pour?.id, "adm");
		// Commit signé « Agent (pour Maud B.) ».
		const t = await appel(u, "/api/p/jardin/tickets", { bearer: j.jeton, corps: { titre: "Signé" } });
		assert.equal(t.status, 201);
		const depot = depotDe(donnees, "jardin");
		assert.equal(git(depot, "log", "-1", "--format=%an").trim(), "Agent (pour Maud B.)");
		const e = await ecouter(s.port, "/api/p/jardin/flux", { bearer: j.jeton });
		await e.attendre(1);
		const inv = (await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "mainteneur" } })).corps;
		secrets.push(inv.lien.split("/").pop());
		const d = await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { desactive: true } });
		assert.equal(d.status, 200, d.texte); assert.deepEqual(d.corps.jetons_revoques, [j.id]); assert.ok(d.corps.compte.desactive);
		assert.deepEqual(d.corps.invitations_annulees, [inv.id], "ses invitations en attente sont annulées");
		assert.equal((await appel(u, inv.lien)).status, 404, "il ne revient pas par son propre lien");
		await Promise.race([e.ferme, new Promise((_, k) => setTimeout(() => k(new Error("flux non coupé")), 3000))]);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: j.jeton })).status, 401, "jeton révoqué");
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: sansProprio.jeton })).status, 200, "jeton sans propriétaire : intact");
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: parAdmin.jeton })).status, 200, "jeton d'un autre propriétaire : intact");
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: maud })).status, 401, "session supprimée");
		assert.equal((await appel(u, "/api/moi", { cookie: maud })).status, 401);
		assert.ok(!(await appel(u, "/api/p/jardin/membres", { cookie: adm })).corps.membres.find((m: any) => m.compte === "maud" && !m.desactive));
		const je = s.ctx.base.lireJournal().find(x => x.action === "compte désactivé" && x.cible === "maud");
		assert.ok(je); assert.match(je!.detail, new RegExp(j.id));
		// Réactiver : le compte revient, ses jetons restent révoqués, son ancienne session aussi ; une nouvelle session marche.
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { desactive: false } })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: j.jeton })).status, 401);
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: maud })).status, 401, "l'ancienne session ne revit pas");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud B.");
		secrets.push(maud.split("=")[1]);
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: maud })).status, 200);
	});

	test("dernier admin : ni désactivé ni rétrogradé ; possible avec un second admin", async () => {
		assert.equal((await appel(u, "/api/admin/comptes/adm", { cookie: adm, methode: "PATCH", corps: { desactive: true } })).status, 400);
		assert.equal((await appel(u, "/api/admin/comptes/adm", { cookie: adm, methode: "PATCH", corps: { admin: false } })).status, 400);
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: adm, methode: "PATCH", corps: { admin: true } })).status, 200);
		assert.equal((await appel(u, "/api/admin/comptes/adm", { cookie: maud, methode: "PATCH", corps: { admin: false } })).status, 200);
		assert.equal((await appel(u, "/api/admin/comptes/maud", { cookie: maud, methode: "PATCH", corps: { admin: false } })).status, 400, "Maud est maintenant la dernière");
		assert.equal((await appel(u, "/api/admin/comptes/adm", { cookie: maud, methode: "PATCH", corps: { admin: true } })).status, 200);
	});

	test("admin rétrogradé ou désactivé : ses invitations admin annulées, ses jetons sans rôle ne valent plus ; DELETE /api/admin/invitations/<id>", async () => {
		await session(u, "jardin", "adm2", "admin", "Admin 2");
		const adm2 = await session(u, "jardin", "adm2", "admin", "Admin 2");
		await projet(u, "ruche");
		await session(u, "ruche", "adm2", "mainteneur", "Admin 2");
		// Jetons créés par adm2 : sur jardin (aucun rôle de projet), sur ruche (mainteneur).
		const jj = (await appel(u, "/api/p/jardin/jetons", { cookie: adm2, corps: { nom: "J", role: "mainteneur" } })).corps;
		const jr = (await appel(u, "/api/p/ruche/jetons", { cookie: adm2, corps: { nom: "R", role: "mainteneur" } })).corps;
		secrets.push(jj.jeton, jr.jeton);
		const ia = (await appel(u, "/api/admin/invitations", { cookie: adm2, corps: { role: "admin" } })).corps;
		const ij = (await appel(u, "/api/admin/invitations", { cookie: adm2, corps: { projet: "jardin", role: "lecteur" } })).corps;
		const ir = (await appel(u, "/api/admin/invitations", { cookie: adm2, corps: { projet: "ruche", role: "lecteur" } })).corps;
		secrets.push(...[ia, ij, ir].map(i => i.lien.split("/").pop()));
		const p = await appel(u, "/api/admin/comptes/adm2", { cookie: adm, methode: "PATCH", corps: { admin: false } });
		assert.equal(p.status, 200, p.texte);
		assert.deepEqual([...p.corps.invitations_annulees].sort(), [ia.id, ij.id].sort(), "invitation admin et celle de jardin ; celle de ruche reste");
		assert.equal((await appel(u, ia.lien)).status, 404); assert.equal((await appel(u, ij.lien)).status, 404); assert.equal((await appel(u, ir.lien)).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jj.jeton })).status, 401, "sans rôle sur jardin : le jeton ne vaut plus");
		assert.equal((await appel(u, "/api/p/jardin/tickets", { bearer: jj.jeton, corps: { titre: "x" } })).status, 401);
		assert.equal((await appel(u, "/api/p/ruche/session", { bearer: jr.jeton })).corps.role, "mainteneur", "mainteneur de ruche : le jeton vaut");
		// L'admin annule une invitation, admin comprise ; déjà annulée : 400 ; inconnue : 404 ; réservé aux admins.
		const ia2 = (await appel(u, "/api/admin/invitations", { cookie: adm, corps: { role: "admin" } })).corps;
		secrets.push(ia2.lien.split("/").pop());
		assert.equal((await appel(u, `/api/admin/invitations/${ia2.id}`, { cookie: adm2, methode: "DELETE" })).status, 403);
		assert.equal((await appel(u, `/api/admin/invitations/${ia2.id}`, { cookie: adm, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, ia2.lien)).status, 404);
		assert.equal((await appel(u, `/api/admin/invitations/${ia2.id}`, { cookie: adm, methode: "DELETE" })).status, 400);
		assert.equal((await appel(u, "/api/admin/invitations/inconnue", { cookie: adm, methode: "DELETE" })).status, 404);
		assert.equal((await appel(u, `/api/admin/invitations/${ir.id}`, { cookie: adm, methode: "DELETE" })).status, 204, "invitation d'un projet");
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "invitation annulée" && e.cible === ia2.id && e.qui === "adm"));
		// POST /api/admin/jetons « pour » : refusé si le compte ne vaudrait rien sur ce projet.
		assert.equal((await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "x", pour: "adm2" } })).status, 400, "adm2 n'a plus de rôle sur jardin");
		const ok = await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "ruche", nom: "x", pour: "adm2" } });
		assert.equal(ok.status, 201); secrets.push(ok.corps.jeton);
	});

	test("invitations (admin) : toutes, sans secret ; journal : pages de 100, filtre projet, noms, aucun secret", async () => {
		await projet(u, "verger");
		const i = await appel(u, "/api/admin/invitations", { cookie: adm, corps: { projet: "jardin", role: "contributeur" } });
		const i2 = await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "lecteur" } });
		secrets.push(i.corps.lien.split("/").pop(), i2.corps.lien.split("/").pop());
		const l = await appel(u, "/api/admin/invitations", { cookie: adm });
		assert.equal(l.status, 200);
		assert.ok(l.corps.invitations.some((x: any) => x.id === i.corps.id && x.etat === "attente" && x.projet === "jardin"));
		for (const s2 of secrets) assert.ok(!l.texte.includes(s2));
		// Assez d'entrées pour deux pages.
		for (let k = 0; k < 105; k++) s.ctx.base.journaliser({ qui: "adm", action: "essai", projet: k % 2 ? "verger" : "jardin", cible: String(k) });
		const p1 = await appel(u, "/api/admin/journal", { cookie: adm });
		assert.equal(p1.status, 200); assert.equal(p1.corps.entrees.length, 100); assert.equal(p1.corps.suivant, p1.corps.entrees[99].id);
		assert.ok(p1.corps.entrees[0].id > p1.corps.entrees[99].id, "du plus récent au plus ancien");
		assert.equal(p1.corps.entrees[0].qui_nom, "Admin");
		const p2 = await appel(u, `/api/admin/journal?avant=${p1.corps.suivant}`, { cookie: adm });
		assert.ok(p2.corps.entrees.length > 0 && p2.corps.entrees.every((e: any) => e.id < p1.corps.suivant));
		const v = await appel(u, "/api/admin/journal?projet=verger", { cookie: adm });
		assert.ok(v.corps.entrees.length > 0 && v.corps.entrees.every((e: any) => e.projet === "verger"));
		assert.equal((await appel(u, "/api/admin/journal?avant=abc", { cookie: adm })).status, 400);
		assert.equal((await appel(u, "/api/admin/journal", { cookie: maud })).status, 200, "Maud est admin à nouveau");
		// Aucun secret dans toute la table : jetons, sessions, liens d'invitation, jetons d'entrée.
		const tout = JSON.stringify(s.ctx.base.db.prepare("SELECT * FROM journal").all());
		assert.ok(secrets.length >= 7);
		for (const s2 of secrets) assert.ok(!tout.includes(s2), "secret dans le journal");
		assert.ok(!/wdd_[A-Za-z0-9_-]{16,}/.test(tout));
		assert.ok(!/invitation\/[A-Za-z0-9_-]{20,}/.test(tout));
		// Les actions attendues sont là.
		const actions = new Set(s.ctx.base.lireJournal(undefined, undefined, 10000).map(e => e.action));
		for (const a of ["invitation créée", "jeton créé", "compte modifié", "compte désactivé"]) assert.ok(actions.has(a), a);
	});

	test("projet créé (API admin) : journalisé ; jeton admin avec « pour »", async () => {
		const r = await appel(u, "/api/admin/projets", { cookie: adm, corps: { id: "potager", titre: "Potager" } });
		assert.equal(r.status, 201);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "projet créé" && e.projet === "potager" && e.qui === "adm"));
		const j = await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "potager", nom: "Agent", pour: "maud" } });
		assert.equal(j.status, 201, j.texte); assert.deepEqual(j.corps.pour, { id: "maud", nom: "Maud B." });
		assert.equal((await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "potager", nom: "Agent", pour: "personne" } })).status, 404);
	});
});

describe("API de test de l'étape 3 (écart 22) : préparer, réinitialiser les tickets, modes simulés", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => { donnees = dossierTemp("api-test"); s = await serveurTest(donnees); u = s.url; });
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("POST /__test/preparer, modes sur les tickets et les réglages, reinitialiser { tickets: true }", async () => {
		const p = await appel(u, "/__test/preparer", { corps: { projet: "jardin", retours: [{ donnees: { text: "a" } }, { id: "Fixe1", donnees: {} }],
			comptes: [{ id: "maud", role: "mainteneur", nom: "Maud" }, { id: "lea", role: "lecteur", nom: "Léa" }], invitations: [{ role: "contributeur" }], jetons: [{ nom: "Agent", pour: "maud" }] } });
		assert.equal(p.status, 200, p.texte);
		assert.equal(p.corps.retours.length, 2); assert.ok(p.corps.retours.some((r: any) => r.id === "Fixe1" && r.version === 1));
		assert.deepEqual(p.corps.comptes.map((c: any) => c.id), ["maud", "lea"]);
		assert.equal(p.corps.invitations.length, 1); assert.match(p.corps.invitations[0].lien, /^\/invitation\//);
		assert.equal(p.corps.jetons[0].pour, "maud");
		const maud = p.corps.comptes[0].cookie;
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: p.corps.jetons[0].jeton })).corps.pour.id, "maud");
		assert.equal((await appel(u, p.corps.invitations[0].lien)).status, 200);
		// Un jeton « pour » un lecteur ne vaudrait rien : refusé.
		assert.equal((await appel(u, "/__test/preparer", { corps: { projet: "jardin", jetons: [{ nom: "x", pour: "lea" }] } })).status, 400);
		for (const [mode, attendu] of [["readonly", 403], ["quota", 507], ["unavailable", 503], ["denywrite", 403]] as const) {
			assert.equal((await appel(u, "/__test/mode", { corps: { projet: "jardin", mode } })).status, 200);
			assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "x" } })).status, attendu, `${mode} : ticket`);
			assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { url_commit: "https://x/{hash}" } })).status, attendu, `${mode} : réglages`);
		}
		await appel(u, "/__test/mode", { corps: { projet: "jardin", mode: "normal" } });
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "x" } })).corps.id, "T-1");
		const ri = await appel(u, "/__test/reinitialiser", { corps: { projet: "jardin", tickets: true } });
		assert.equal(ri.status, 200, ri.texte); assert.equal(ri.corps.tickets_supprimes, 1);
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud })).corps.docs.length, 0);
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "y" } })).corps.id, "T-2", ".dernier gardé : T-1 n'est pas réutilisé");
	});
});
