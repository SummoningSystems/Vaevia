// Étape 3.5, appairage d'un poste (docs/etape3-5-prise-en-main.md § 2.1, § 2.2 pour la redirection) : cycle complet,
// une seule livraison (y compris en concurrence), expiration et purge, refus, limites (429), rôles, session seulement
// et anti-CSRF, IP seulement en écoute locale, jeton ponctuel expiré, révocation de soi, hôte des pages en 404.
// Aucun secret dans un message d'assertion : jetons et codes d'appareil sont comparés par assert.ok(…, "texte"), et
// les réponses qui en portent ne sont jamais passées en message (r.texte).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { appel, appelHote, dossierTemp, nettoyer, serveurTest, session, portLibre, pause } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const INTERVALLE = 100; // ms (2 s en vrai) : Config.intervalleAppairageMs
const attendre = () => pause(INTERVALLE + 20);
const passe = () => new Date(Date.now() - 1000).toISOString();

describe("appairage (§ 2.1)", () => {
	let s: Serveur, donnees: string, u: string;
	let maud: string, camille: string, lea: string, adm: string, zoe: string, admin: string;
	before(async () => {
		donnees = dossierTemp("35-appairage");
		s = await serveurTest(donnees, { intervalleAppairageMs: INTERVALLE });
		u = s.url;
		const p = await appel(u, "/__test/preparer", { corps: { projet: "jardin", comptes: [
			{ id: "maud", nom: "Maud", role: "mainteneur" }, { id: "camille", nom: "Camille", role: "contributeur" }, { id: "lea", nom: "Léa", role: "lecteur" },
			{ id: "adm", nom: "Adm", role: "admin" }, { id: "zoe", nom: "Zoé", role: "contributeur" }] } });
		assert.equal(p.status, 200, "préparation");
		[maud, camille, lea, adm, zoe] = p.corps.comptes.map((c: any) => c.cookie);
		admin = adm;
		assert.equal((await appel(u, "/__test/preparer", { corps: { projet: "verger" } })).status, 200);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	const creer = (corps: unknown) => appel(u, "/api/appairage", { corps });
	const interroger = (code_appareil: string) => appel(u, "/api/appairage/jeton", { corps: { code_appareil } });
	const voir = (code: string, cookie: string) => appel(u, `/api/appairage/${code}`, { cookie });
	const autoriser = (code: string, cookie: string, corps: unknown) => appel(u, `/api/appairage/${code}/autoriser`, { cookie, corps });
	const refuser = (code: string, cookie: string) => appel(u, `/api/appairage/${code}/refuser`, { cookie, methode: "POST" });
	// Livraison : attend l'intervalle, puis interroge.
	const livrer = async (ca: string) => { await attendre(); return interroger(ca); };
	const tables = () => JSON.stringify([s.ctx.base.db.prepare("SELECT * FROM appairages").all(), s.ctx.base.db.prepare("SELECT * FROM journal").all(), s.ctx.base.db.prepare("SELECT id, hash, nom, origine FROM jetons").all()]);

	test("cycle : création, attente (202), slow_down (429), page d'autorisation, autorisation, livraison unique (200 puis 410)", async () => {
		const c = await creer({ poste: "Poste-Benoit", projet: "jardin" });
		assert.equal(c.status, 201);
		assert.match(c.corps.code, CODE);
		assert.ok(/^[A-Za-z0-9_-]{43}$/.test(c.corps.code_appareil), "code d'appareil : 32 octets en base64url");
		assert.equal(c.corps.intervalle, INTERVALLE / 1000);
		const reste = Date.parse(c.corps.expire) - Date.now();
		assert.ok(reste > 9 * 60 * 1000 && reste <= 10 * 60 * 1000, "expire dans 10 min");
		assert.deepEqual(Object.keys(c.corps).sort(), ["code", "code_appareil", "expire", "intervalle"]);
		const ca: string = c.corps.code_appareil;
		assert.ok(!tables().includes(ca), "le code d'appareil n'est pas gardé en clair");
		// Attente, puis interrogation trop rapprochée.
		const a1 = await interroger(ca);
		assert.equal(a1.status, 202); assert.deepEqual(a1.corps, { etat: "attente" });
		const vite = await interroger(ca);
		assert.equal(vite.status, 429); assert.equal(vite.corps.code, "slow_down");
		assert.equal((await livrer(ca)).status, 202);
		// Page d'autorisation : la demande, l'IP (écoute locale), les projets que ce compte peut autoriser.
		const v = await voir(c.corps.code, maud);
		assert.equal(v.status, 200, v.texte);
		assert.equal(v.corps.code, c.corps.code); assert.equal(v.corps.poste, "Poste-Benoit");
		assert.deepEqual([v.corps.projet, v.corps.role, v.corps.usage, v.corps.ip, v.corps.meme_ip], ["jardin", "agent", "permanent", "127.0.0.1", true]);
		assert.ok(v.corps.cree && v.corps.expire === c.corps.expire);
		assert.deepEqual(v.corps.projets, [{ id: "jardin", titre: "jardin", role_max: "mainteneur" }]);
		assert.deepEqual((await voir(c.corps.code, camille)).corps.projets, [{ id: "jardin", titre: "jardin", role_max: "agent" }]);
		assert.deepEqual((await voir(c.corps.code, lea)).corps.projets, [], "un lecteur n'autorise rien");
		assert.deepEqual((await voir(c.corps.code, adm)).corps.projets.map((p: any) => [p.id, p.role_max]), [["jardin", "mainteneur"], ["verger", "mainteneur"]]);
		assert.equal((await voir(c.corps.code.toLowerCase().replace("-", ""), maud)).status, 200, "code en minuscules, sans tiret : accepté");
		// Autorisation.
		const au = await autoriser(c.corps.code, maud, { projet: "jardin", role: "agent" });
		assert.equal(au.status, 204, au.texte);
		assert.equal((await voir(c.corps.code, maud)).status, 404, "déjà traité");
		assert.equal((await autoriser(c.corps.code, maud, { projet: "jardin", role: "agent" })).status, 404);
		// Livraison : le jeton est créé à ce moment, une seule fois.
		assert.equal(s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons").get()!.n, 0, "aucun jeton avant la livraison");
		const l = await livrer(ca);
		assert.equal(l.status, 200);
		assert.ok(typeof l.corps.jeton === "string" && l.corps.jeton.startsWith("wdd_"), "jeton livré");
		const jeton: string = l.corps.jeton;
		assert.deepEqual([l.corps.projet, l.corps.role, l.corps.nom, l.corps.pour, l.corps.usage, l.corps.expire], ["jardin", "agent", "Agent · Poste-Benoit", { id: "maud", nom: "Maud" }, "permanent", null]);
		const se = await appel(u, "/api/p/jardin/session", { bearer: jeton });
		assert.equal(se.status, 200); assert.equal(se.corps.role, "agent"); assert.deepEqual(se.corps.pour, { id: "maud", nom: "Maud" });
		const encore = await livrer(ca);
		assert.equal(encore.status, 410); assert.equal(encore.corps.code, "expired");
		assert.ok(!("jeton" in (encore.corps || {})), "une seule livraison");
		// Vue Membres : origine du jeton, sans fin.
		const js = (await appel(u, "/api/p/jardin/jetons", { cookie: maud })).corps.jetons;
		assert.equal(js.length, 1);
		assert.deepEqual([js[0].nom, js[0].origine, js[0].expire, js[0].expiree, js[0].pour.id], ["Agent · Poste-Benoit", "appairé depuis Poste-Benoit (127.0.0.1)", null, false, "maud"]);
		// Journal : autorisation et création du jeton ; jamais de secret dans les tables.
		const j = s.ctx.base.lireJournal();
		const auto = j.find(e => e.action === "appairage autorisé")!;
		assert.equal(auto.qui, "maud"); assert.equal(auto.projet, "jardin");
		assert.deepEqual(JSON.parse(auto.detail), { poste: "Poste-Benoit", ip: "127.0.0.1", role: "agent", usage: "permanent", nom: "Agent · Poste-Benoit" });
		const cr = j.find(e => e.action === "jeton créé")!;
		assert.equal(cr.qui, "maud"); assert.equal(cr.cible, js[0].id); assert.equal(JSON.parse(cr.detail).par, "appairage");
		const t = tables();
		assert.ok(!t.includes(jeton) && !t.includes(ca), "ni jeton ni code d'appareil en base (journal, appairages, jetons)");
	});

	test("livraison unique en concurrence : une seule réponse 200, un seul jeton créé", async () => {
		const c = await creer({ poste: "Concurrent" });
		assert.equal((await autoriser(c.corps.code, camille, { projet: "jardin", role: "agent" })).status, 204);
		await attendre();
		const rs = await Promise.all(Array.from({ length: 6 }, () => interroger(c.corps.code_appareil)));
		assert.equal(rs.filter(r => r.status === 200).length, 1, "une seule livraison");
		assert.ok(rs.every(r => [200, 410, 429].includes(r.status)), "les autres : 410 ou 429");
		assert.equal(s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons WHERE origine = 'appairé depuis Concurrent (127.0.0.1)'").get()!.n, 1);
		assert.equal((await livrer(c.corps.code_appareil)).status, 410);
	});

	test("refus : 410 refused jusqu'à l'expiration ; la page ne montre plus le code ; journal", async () => {
		const c = await creer({ poste: "Inconnu" });
		assert.equal((await refuser(c.corps.code, camille)).status, 204);
		const r = await interroger(c.corps.code_appareil);
		assert.equal(r.status, 410); assert.equal(r.corps.code, "refused");
		assert.equal((await livrer(c.corps.code_appareil)).corps.code, "refused", "toujours refusé");
		assert.equal((await voir(c.corps.code, maud)).status, 404);
		assert.equal((await autoriser(c.corps.code, maud, { projet: "jardin", role: "agent" })).status, 404, "un refus est définitif");
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}/refuser`, { cookie: maud, corps: { raison: "x" } })).status, 400, "refuser : corps vide");
		const e = s.ctx.base.lireJournal().find(x => x.action === "appairage refusé")!;
		assert.equal(e.qui, "camille");
	});

	test("expiration : 404 à la page, 410 expired à la CLI, rien de livré ; purge à la création suivante", async () => {
		const exp = (code: string) => s.ctx.base.db.prepare("UPDATE appairages SET expire = ? WHERE code = ?").run(passe(), code.replace("-", ""));
		const a = await creer({ poste: "Lent" });
		exp(a.corps.code);
		assert.equal((await voir(a.corps.code, maud)).status, 404);
		assert.equal((await autoriser(a.corps.code, maud, { projet: "jardin", role: "agent" })).status, 404);
		const r = await interroger(a.corps.code_appareil);
		assert.equal(r.status, 410); assert.equal(r.corps.code, "expired");
		// Autorisé, puis expiré avant que la CLI ne vienne : pas de jeton.
		const b = await creer({ poste: "Distrait" });
		assert.equal((await autoriser(b.corps.code, maud, { projet: "jardin", role: "agent" })).status, 204);
		exp(b.corps.code);
		assert.equal((await interroger(b.corps.code_appareil)).status, 410);
		assert.equal(s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons WHERE origine LIKE 'appairé depuis Distrait%'").get()!.n, 0);
		// Purge : les expirés disparaissent à la création suivante ; un code d'appareil purgé ou inconnu : 410 expired.
		const n = () => Number(s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM appairages WHERE poste IN ('Lent', 'Distrait')").get()!.n);
		assert.equal(n(), 1, "« Lent », expiré, purgé dès la création de « Distrait »");
		await creer({ poste: "Suivant" });
		assert.equal(n(), 0, "purgés");
		assert.equal((await interroger(a.corps.code_appareil)).corps.code, "expired");
		assert.equal((await interroger("x".repeat(43))).corps.code, "expired", "inconnu");
	});

	test("rôles : lecteur refusé, contributeur → agent seulement, mainteneur et admin → mainteneur ; nom par défaut coupé à 60", async () => {
		const c = await creer({ poste: "Poste", role: "mainteneur", projet: "jardin" });
		assert.equal((await autoriser(c.corps.code, lea, { projet: "jardin", role: "agent" })).status, 403, "lecteur");
		assert.equal((await autoriser(c.corps.code, camille, { projet: "jardin", role: "mainteneur" })).status, 403, "contributeur : pas mainteneur");
		assert.equal((await autoriser(c.corps.code, camille, { projet: "verger", role: "agent" })).status, 403, "projet où il n'a pas de rôle");
		assert.equal((await autoriser(c.corps.code, adm, { projet: "inexistant", role: "agent" })).status, 403, "projet inexistant");
		for (const corps of [{ projet: "jardin" }, { projet: "jardin", role: "admin" }, { projet: "jardin", role: "agent", nom: "<b>" }, { projet: "jardin", role: "agent", autre: 1 }, { role: "agent" }])
			assert.equal((await autoriser(c.corps.code, maud, corps)).status, 400, JSON.stringify(corps));
		// Admin sans rôle de projet : mainteneur sur tout projet ; nom choisi.
		assert.equal((await autoriser(c.corps.code, adm, { projet: "verger", role: "mainteneur", nom: "Import du verger" })).status, 204);
		const l = await livrer(c.corps.code_appareil);
		assert.equal(l.status, 200);
		assert.deepEqual([l.corps.projet, l.corps.role, l.corps.nom, l.corps.pour.id], ["verger", "mainteneur", "Import du verger", "adm"]);
		assert.equal((await appel(u, "/api/p/verger/session", { bearer: l.corps.jeton })).corps.role, "mainteneur");
		// Contributeur : agent.
		const d = await creer({ poste: "P".repeat(60) });
		assert.equal((await autoriser(d.corps.code, camille, { projet: "jardin", role: "agent" })).status, 204);
		const ld = await livrer(d.corps.code_appareil);
		assert.equal(ld.corps.role, "agent");
		assert.ok(ld.corps.nom.length === 60 && ld.corps.nom.startsWith("Agent · P"), "nom par défaut coupé à 60 caractères");
		// Création : validation.
		for (const corps of [{}, { poste: "" }, { poste: "<x>" }, { poste: "x".repeat(61) }, { poste: "a", role: "admin" }, { poste: "a", usage: "toujours" }, { poste: "a", projet: "../x" }, { poste: "a", jeton: "x" }])
			assert.equal((await creer(corps)).status, 400, JSON.stringify(corps));
		assert.equal((await appel(u, "/api/appairage/jeton", { corps: { code_appareil: "court" } })).status, 400);
		assert.equal((await appel(u, "/api/appairage/jeton", { corps: {} })).status, 400);
		assert.equal((await appel(u, "/api/appairage", { brut: "poste=x", entetes: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 400, "JSON seulement");
	});

	test("le compte qui a autorisé est relu à la livraison : désactivé → 410 refused, rien de créé ; passé contributeur → jeton agent", async () => {
		const c = await creer({ poste: "Zoe-PC" });
		assert.equal((await autoriser(c.corps.code, zoe, { projet: "jardin", role: "agent" })).status, 204);
		assert.equal((await appel(u, "/api/admin/comptes/zoe", { cookie: admin, methode: "PATCH", corps: { desactive: true } })).status, 200);
		const r = await livrer(c.corps.code_appareil);
		assert.equal(r.status, 410); assert.equal(r.corps.code, "refused");
		assert.equal(s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM jetons WHERE pour = 'zoe'").get()!.n, 0);
		// Mainteneur rétrogradé entre l'autorisation et la livraison.
		const m2 = await session(u, "jardin", "max", "mainteneur", "Max");
		const d = await creer({ poste: "Max-PC", role: "mainteneur" });
		assert.equal((await autoriser(d.corps.code, m2, { projet: "jardin", role: "mainteneur" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/membres/max", { cookie: maud, methode: "PUT", corps: { role: "contributeur" } })).status, 200);
		const l = await livrer(d.corps.code_appareil);
		assert.equal(l.status, 200); assert.equal(l.corps.role, "agent");
	});

	test("session seulement, anti-CSRF : Bearer 403, sans session 401, sans X-WDD ou Origin étranger 403", async () => {
		const c = await creer({ poste: "Csrf" });
		const jeton = (await appel(u, "/__test/preparer", { corps: { projet: "jardin", jetons: [{ nom: "Agent", pour: "maud" }] } })).corps.jetons[0].jeton;
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}`, { bearer: jeton })).status, 403);
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}/autoriser`, { bearer: jeton, corps: { projet: "jardin", role: "agent" } })).status, 403, "un jeton ne s'en donne pas d'autre");
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}`)).status, 401);
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}/refuser`, { methode: "POST" })).status, 401);
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}/autoriser`, { cookie: maud, xwdd: false, corps: { projet: "jardin", role: "agent" } })).status, 403, "sans X-WDD");
		assert.equal((await appel(u, `/api/appairage/${c.corps.code}/autoriser`, { cookie: maud, origin: "https://ailleurs.exemple", corps: { projet: "jardin", role: "agent" } })).status, 403, "Origin étranger");
		assert.equal((await appel(u, "/api/appairage", { cookie: maud, xwdd: false, corps: { poste: "x" } })).status, 403, "création avec un cookie : X-WDD exigé");
		assert.equal((await voir(c.corps.code, maud)).status, 200, "toujours en attente");
	});

	test("ponctuel : le jeton expire au bout d'une heure ; expiré → 401 et « expiré » dans la vue Membres ; révocation de soi", async () => {
		const c = await creer({ poste: "Import", role: "mainteneur", usage: "ponctuel", projet: "jardin" });
		const v = await voir(c.corps.code, maud);
		assert.deepEqual([v.corps.role, v.corps.usage], ["mainteneur", "ponctuel"]);
		assert.equal((await autoriser(c.corps.code, maud, { projet: "jardin", role: "mainteneur" })).status, 204);
		const l = await livrer(c.corps.code_appareil);
		assert.equal(l.status, 200); assert.equal(l.corps.usage, "ponctuel");
		const reste = Date.parse(l.corps.expire) - Date.now();
		assert.ok(reste > 59 * 60 * 1000 && reste <= 3600 * 1000, "expire dans une heure");
		const jeton: string = l.corps.jeton;
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jeton })).status, 200);
		const id = (await appel(u, "/api/p/jardin/jetons", { cookie: maud })).corps.jetons.find((j: any) => j.origine === "appairé depuis Import (127.0.0.1)").id;
		s.ctx.base.db.prepare("UPDATE jetons SET expire = ? WHERE id = ?").run(passe(), id);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jeton })).status, 401, "jeton ponctuel expiré");
		const ligne = (await appel(u, "/api/p/jardin/jetons", { cookie: maud })).corps.jetons.find((j: any) => j.id === id);
		assert.equal(ligne.expiree, true);
		// Révocation de soi (fin d'un import ponctuel).
		const c2 = await creer({ poste: "Import2", role: "mainteneur", usage: "ponctuel" });
		assert.equal((await autoriser(c2.corps.code, maud, { projet: "jardin", role: "mainteneur" })).status, 204);
		const j2: string = (await livrer(c2.corps.code_appareil)).corps.jeton;
		assert.equal((await appel(u, "/api/p/jardin/jeton", { bearer: j2, methode: "DELETE" })).status, 204);
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: j2 })).status, 401);
	});

	test("limites : 10 codes inconnus par session et par minute (GET, autoriser, refuser), puis 429 même pour un bon code", async () => {
		const c = await creer({ poste: "Limite" });
		const s1 = await session(u, "jardin", "maud", "mainteneur", "Maud");
		for (let i = 0; i < 4; i++) assert.equal((await voir("2222-2222", s1)).status, 404);
		for (let i = 0; i < 3; i++) assert.equal((await autoriser("2222-2223", s1, { projet: "jardin", role: "agent" })).status, 404);
		for (let i = 0; i < 2; i++) assert.equal((await refuser("2222-2224", s1)).status, 404);
		assert.equal((await voir("pas-un-code", s1)).status, 404, "forme invalide : comptée aussi");
		const t = await voir(c.corps.code, s1);
		assert.equal(t.status, 429); assert.equal(t.corps.code, "quota_exceeded");
		assert.equal((await autoriser(c.corps.code, s1, { projet: "jardin", role: "agent" })).status, 429);
		// Une autre session n'est pas touchée ; une minute plus tard, la session limitée repasse.
		const s2 = await session(u, "jardin", "maud", "mainteneur", "Maud");
		assert.equal((await voir(c.corps.code, s2)).status, 200);
		for (const [cle, l] of s.ctx.essaisCodes) s.ctx.essaisCodes.set(cle, l.map(x => x - 61 * 1000));
		assert.equal((await voir(c.corps.code, s1)).status, 200);
	});

	test("limites : 30 appairages en attente sur le serveur, 60 créations par minute (429)", async () => {
		const db = s.ctx.base.db;
		db.prepare("DELETE FROM appairages").run();
		for (let i = 0; i < 30; i++) assert.equal((await creer({ poste: `P${i}` })).status, 201);
		const r31 = await creer({ poste: "P30" });
		assert.equal(r31.status, 429); assert.equal(r31.corps.code, "quota_exceeded"); assert.match(r31.corps.message, /en attente/);
		// Traités (refusés) : plus en attente, mais créés dans la minute.
		db.prepare("UPDATE appairages SET etat = 'refuse'").run();
		for (let i = 0; i < 30; i++) assert.equal((await creer({ poste: `Q${i}` })).status, 201);
		db.prepare("UPDATE appairages SET etat = 'refuse'").run();
		const r61 = await creer({ poste: "Q30" });
		assert.equal(r61.status, 429); assert.match(r61.corps.message, /minute/);
		// Une minute plus tard.
		db.prepare("UPDATE appairages SET cree = ?").run(new Date(Date.now() - 61 * 1000).toISOString());
		assert.equal((await creer({ poste: "Plus tard" })).status, 201);
		db.prepare("DELETE FROM appairages").run();
	});

	test("IP vue : « même IP » faux si la demande vient d'une autre adresse (écoute locale)", async () => {
		const c = await creer({ poste: "Ailleurs" });
		s.ctx.base.db.prepare("UPDATE appairages SET ip = '192.0.2.7' WHERE code = ?").run(c.corps.code.replace("-", ""));
		const v = await voir(c.corps.code, maud);
		assert.deepEqual([v.corps.ip, v.corps.meme_ip], ["192.0.2.7", false]);
	});
});

describe("appairage : IP seulement en écoute locale (§ 2.1)", () => {
	for (const [nom, surcharge, locale] of [
		["WDD_URL d'un autre nom que la boucle locale : ip et meme_ip null, origine sans IP", { url: "http://retours.exemple.invalid" }, false],
		["écoute sur 0.0.0.0 : ip null", { hote: "0.0.0.0", test: false }, false],
		["WDD_URL de bouclage (localhost) : ip donnée", { url: "http://localhost:9" }, true],
	] as const) {
		test(nom, async () => {
			const donnees = dossierTemp("35-appairage-ip");
			const s = await serveurTest(donnees, { intervalleAppairageMs: INTERVALLE, ...surcharge });
			try {
				const u = `http://127.0.0.1:${s.port}`;
				// Sans API de test (0.0.0.0) : compte et session posés directement en base.
				s.ctx.base.creerProjet("jardin", "Jardin");
				s.ctx.base.creerCompte("maud", "Maud", false);
				s.ctx.base.donnerRole("maud", "jardin", "mainteneur");
				const cookie = "wdd_session=" + s.ctx.base.creerSession("maud").jeton;
				const c = await appel(u, "/api/appairage", { corps: { poste: "Poste" } });
				assert.equal(c.status, 201);
				const v = await appel(u, `/api/appairage/${c.corps.code}`, { cookie });
				assert.equal(v.status, 200, v.texte);
				if (locale) assert.deepEqual([v.corps.ip, v.corps.meme_ip], ["127.0.0.1", true]);
				else assert.deepEqual([v.corps.ip, v.corps.meme_ip], [null, null]);
				assert.equal((await appel(u, `/api/appairage/${c.corps.code}/autoriser`, { cookie, corps: { projet: "jardin", role: "agent" } })).status, 204);
				await attendre();
				const l = await appel(u, "/api/appairage/jeton", { corps: { code_appareil: c.corps.code_appareil } });
				assert.equal(l.status, 200);
				const origine = s.ctx.base.jetons("jardin")[0].origine;
				assert.equal(origine, locale ? "appairé depuis Poste (127.0.0.1)" : "appairé depuis Poste");
				const detail = JSON.parse(s.ctx.base.lireJournal().find(e => e.action === "appairage autorisé")!.detail);
				assert.equal("ip" in detail, locale);
			} finally { await s.arreter(); nettoyer(donnees); }
		});
	}
});

describe("appairage : hôte principal seulement ; redirection /appairage?code= (§ 2.2)", () => {
	let s: Serveur, donnees: string, port: number, H: string, P: string;
	before(async () => {
		donnees = dossierTemp("35-appairage-hotes");
		port = await portLibre();
		H = `127.0.0.1:${port}`; P = `localhost:${port}`;
		s = await serveurTest(donnees, { port, url: `http://${H}`, urlPages: `http://${P}`, intervalleAppairageMs: INTERVALLE });
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("hôte des pages : toutes les routes d'appairage en 404 ; hôte inconnu : 421", async () => {
		const c = await appelHote(port, H, "/api/appairage", { corps: { poste: "Poste" } });
		assert.equal(c.status, 201, "hôte principal");
		for (const [m, chemin, corps] of [["POST", "/api/appairage", { poste: "x" }], ["GET", `/api/appairage/${c.corps.code}`], ["POST", `/api/appairage/${c.corps.code}/autoriser`, { projet: "jardin", role: "agent" }],
			["POST", `/api/appairage/${c.corps.code}/refuser`], ["POST", "/api/appairage/jeton", { code_appareil: c.corps.code_appareil }], ["GET", `/appairage?code=${c.corps.code}`]] as [string, string, unknown?][]) {
			const r = await appelHote(port, P, chemin, { methode: m, corps });
			assert.equal(r.status, 404, `${m} ${chemin.replace(c.corps.code, "<code>")} sur l'hôte des pages`);
		}
		assert.equal((await appelHote(port, "autre.invalid", "/api/appairage", { corps: { poste: "x" } })).status, 421);
		// La demande n'a pas bougé : toujours en attente.
		const r = await appelHote(port, H, "/api/appairage/jeton", { corps: { code_appareil: c.corps.code_appareil } });
		assert.equal(r.status, 202);
	});

	test("GET /appairage?code=XXXX-XXXX → 303 /#/appairage/XXXX-XXXX ; code invalide ou absent → /#/appairage", async () => {
		for (const [q, cible] of [["?code=ABCD-EFGH", "/#/appairage/ABCD-EFGH"], ["?code=abcdefgh", "/#/appairage/ABCD-EFGH"], ["?code=ABCI-EFGH", "/#/appairage"],
			["?code=%3Cscript%3E", "/#/appairage"], ["?code=ABCD-EFGH%0D%0ASet-Cookie:x", "/#/appairage"], ["", "/#/appairage"], ["?code=ABCD-EFGHJ", "/#/appairage"]]) {
			const r = await appelHote(port, H, "/appairage" + q);
			assert.equal(r.status, 303, q); assert.equal(r.entetes.location, cible, q);
		}
		assert.equal((await appelHote(port, H, "/appairage", { methode: "POST", corps: {} })).status, 404);
	});
});
