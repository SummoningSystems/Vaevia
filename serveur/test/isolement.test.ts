// Isolement des pages de projet (docs/etape3-meta-interface.md § 2) : hôte principal 127.0.0.1, hôte des pages
// localhost (même port, autre nom d'hôte). Routes refusées sur l'hôte des pages, jeton d'entrée à usage unique et
// expiré, cookie wdd_pages limité au projet, Origin de l'hôte des pages, 421 pour un Host inconnu (seulement avec
// WDD_URL_PAGES), refus au démarrage, flux sans « tickets » sur l'hôte des pages. Plus la méta-interface statique.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { appel, appelHote, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, portLibre, ecouter, pause } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL, lireConfig } from "../src/config.ts";
import { hacher } from "../src/base.ts";

describe("isolement des pages : deux hôtes (127.0.0.1 et localhost)", () => {
	let s: Serveur, donnees: string, port: number, H: string, P: string, u: string, uPages: string, maud: string, camille: string, agent: string;
	before(async () => {
		donnees = dossierTemp("isolement");
		port = await portLibre();
		H = `127.0.0.1:${port}`; P = `localhost:${port}`;
		u = `http://${H}`; uPages = `http://${P}`;
		s = await serveurTest(donnees, { port, url: u, urlPages: uPages });
		await projet(u, "jardin");
		await projet(u, "verger");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		await session(u, "verger", "camille", "contributeur", "Camille");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent" } })).corps.jeton;
		const exemple = fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
		for (const p of ["jardin", "verger"]) {
			const b = await appel(u, `/api/p/${p}/builds`, { bearer: p === "jardin" ? agent : (await appel(u, "/api/admin/jetons", { cookie: await session(u, p, "adm", "admin"), corps: { projet: p, nom: "A" } })).corps.jeton, brut: exemple, entetes: { "Content-Type": "application/json" } });
			assert.equal(b.status, 201, b.texte);
		}
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	// Entrée complète : /p/<p>/ sur l'hôte principal → 303 vers l'hôte des pages avec ?entree= → cookie → 303 /p/<p>/.
	const entrer = async (cookie: string, p = "jardin") => {
		const r1 = await appelHote(port, H, `/p/${p}/`, { cookie });
		assert.equal(r1.status, 303, r1.texte);
		const loc = new URL(String(r1.entetes.location));
		assert.equal(loc.origin, uPages); assert.equal(loc.pathname, `/p/${p}/`);
		const entree = loc.searchParams.get("entree")!;
		assert.match(entree, /^[A-Za-z0-9_-]{40,}$/);
		const r2 = await appelHote(port, P, loc.pathname + loc.search);
		return { r2, entree };
	};
	const cookiePages = (setCookie: string[], p = "jardin") => {
		const c = setCookie.find(x => x.includes(`Path=/api/p/${p}/`))!;
		return c.split(";")[0];
	};

	test("démarrage : WDD_URL_PAGES de même nom d'hôte refusée (même sur un autre port) ; sans WDD_URL refusée", () => {
		const base = { donnees, port: 0, silencieux: true, test: true, hote: "127.0.0.1" };
		assert.throws(() => lireConfig({}, { ...base, url: "http://127.0.0.1:8080", urlPages: "http://127.0.0.1:8081" }), /même nom d'hôte/);
		assert.throws(() => lireConfig({}, { ...base, url: "https://Retours.exemple.fr", urlPages: "https://retours.exemple.fr:8443" }), /même nom d'hôte/);
		assert.throws(() => lireConfig({}, { ...base, url: "", urlPages: "https://pages.exemple.fr" }), /WDD_URL/);
		assert.throws(() => lireConfig({}, { ...base, url: "https://a.exemple.fr", urlPages: "https://pages.exemple.fr/chemin" }), /origine/);
		assert.doesNotThrow(() => lireConfig({}, { ...base, url: "https://retours.exemple.fr", urlPages: "https://pages.retours.exemple.fr" }));
	});

	test("Host inconnu → 421 ; Host absent → 421", async () => {
		for (const h of ["exemple.fr", `127.0.0.2:${port}`, `localhost:${port + 1}`]) {
			const r = await appelHote(port, h, "/api/p/jardin/session", { cookie: maud });
			assert.equal(r.status, 421, h);
		}
		// HTTP/1.0 sans en-tête Host.
		const brut = await new Promise<string>((ok, ko) => {
			const so = net.connect(port, "127.0.0.1", () => so.end("GET /api/p/jardin/session HTTP/1.0\r\n\r\n"));
			let t = ""; so.setEncoding("utf8"); so.on("data", d => t += d); so.on("end", () => ok(t)); so.on("error", ko);
		});
		assert.match(brut, /^HTTP\/1\.[01] 421 /);
		assert.equal((await appelHote(port, P.toUpperCase(), "/api/p/jardin/session")).status, 401, "Host reconnu sans tenir compte de la casse (hôte des pages, sans session)");
		assert.equal((await appelHote(port, H, "/api/p/jardin/session", { cookie: maud })).status, 200);
	});

	test("entrée par jeton : cookie wdd_pages (HttpOnly, SameSite=Lax, sans Domain, limité aux chemins du projet), puis la page", async () => {
		const { r2 } = await entrer(camille);
		assert.equal(r2.status, 303); assert.equal(r2.entetes.location, "/p/jardin/", "redirigé sans le paramètre");
		assert.equal(r2.setCookie.length, 2);
		for (const c of r2.setCookie) {
			assert.match(c, /^wdd_pages=[A-Za-z0-9_-]+;/); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.doesNotMatch(c, /Domain=/i);
		}
		assert.deepEqual(r2.setCookie.map(c => c.match(/Path=([^;]+)/)![1]).sort(), ["/api/p/jardin/", "/p/jardin/"]);
		const c = cookiePages(r2.setCookie);
		const page = await appelHote(port, P, "/p/jardin/", { cookie: c });
		assert.equal(page.status, 200);
		assert.match(page.texte, /<meta name="wdd-api" content="\/api\/p\/jardin">/);
		assert.match(String(page.entetes["content-security-policy"]), /script-src 'sha256-/);
		const ses = await appelHote(port, P, "/api/p/jardin/session", { cookie: c });
		assert.equal(ses.status, 200); assert.equal(ses.corps.id, "camille"); assert.equal(ses.corps.ecriture, true);
	});

	test("jeton d'entrée : usage unique, expiré après 60 s, lié au projet ; sans session sur l'hôte principal : 401", async () => {
		const { r2, entree } = await entrer(camille);
		assert.equal(r2.status, 303);
		const encore = await appelHote(port, P, `/p/jardin/?entree=${entree}`);
		assert.equal(encore.status, 401, "déjà utilisé"); assert.equal(encore.setCookie.length, 0);
		// Expiré : la date d'expiration est avancée en base.
		const r1 = await appelHote(port, H, "/p/jardin/", { cookie: camille });
		const e2 = new URL(String(r1.entetes.location)).searchParams.get("entree")!;
		s.ctx.base.db.prepare("UPDATE entrees SET expire = ? WHERE hash = ?").run(new Date(Date.now() - 1000).toISOString(), hacher(e2));
		assert.equal((await appelHote(port, P, `/p/jardin/?entree=${e2}`)).status, 401, "expiré");
		// Un jeton du projet jardin ne vaut pas pour verger (et il est consommé).
		const r3 = await appelHote(port, H, "/p/jardin/", { cookie: camille });
		const e3 = new URL(String(r3.entetes.location)).searchParams.get("entree")!;
		assert.equal((await appelHote(port, P, `/p/verger/?entree=${e3}`)).status, 401);
		assert.equal((await appelHote(port, P, `/p/jardin/?entree=${e3}`)).status, 401, "consommé par la tentative");
		assert.equal((await appelHote(port, P, "/p/jardin/?entree=inconnu")).status, 401);
		// Sur l'hôte principal, sans session : « invitation requise » ; agent : refusé.
		assert.equal((await appelHote(port, H, "/p/jardin/")).status, 401);
		assert.equal((await appelHote(port, H, "/p/jardin/", { bearer: agent })).status, 403);
		// Le jeton d'entrée est haché en base.
		const rf = await appelHote(port, H, "/p/jardin/", { cookie: camille });
		const e4 = new URL(String(rf.entetes.location)).searchParams.get("entree")!;
		const brut = JSON.stringify(s.ctx.base.db.prepare("SELECT * FROM entrees").all());
		assert.ok(!brut.includes(e4) && brut.includes(hacher(e4)));
	});

	test("cookie limité au projet ; wdd_session et Bearer sans effet sur l'hôte des pages ; hôte principal ne sert plus la page", async () => {
		const c = cookiePages((await entrer(camille)).r2.setCookie);
		assert.equal((await appelHote(port, P, "/api/p/verger/session", { cookie: c })).status, 401, "cookie de jardin sur verger");
		assert.equal((await appelHote(port, P, "/p/verger/", { cookie: c })).status, 401);
		// Deux projets : deux cookies, chacun le sien.
		const cv = cookiePages((await entrer(camille, "verger")).r2.setCookie, "verger");
		assert.equal((await appelHote(port, P, "/api/p/verger/session", { cookie: `${c}; ${cv}` })).status, 200);
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: `${cv}; ${c}` })).status, 200);
		// La session de l'hôte principal ne vaut rien ici ; un jeton est refusé.
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: camille })).status, 401);
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { bearer: agent })).status, 403);
		assert.equal((await appelHote(port, P, "/p/jardin/", { cookie: camille })).status, 401);
		// Le cookie de l'hôte des pages ne vaut rien sur l'hôte principal.
		assert.equal((await appelHote(port, H, "/api/p/jardin/session", { cookie: c.replace("wdd_pages", "wdd_session") })).status, 401);
		assert.equal((await appelHote(port, H, "/api/p/jardin/session", { cookie: c })).status, 401);
	});

	test("hôte des pages : seules les routes de la page répondent ; tout le reste → 404, même connecté", async () => {
		const c = cookiePages((await entrer(camille)).r2.setCookie);
		const cm = cookiePages((await entrer(maud)).r2.setCookie);
		const refusees: [string, string, unknown?][] = [
			["GET", "/"], ["GET", "/index.html"], ["GET", "/ui.js"], ["GET", "/api/moi"], ["GET", "/api/admin/projets"], ["POST", "/api/admin/projets", { id: "x", titre: "x" }],
			["GET", "/api/admin/journal"], ["GET", "/api/p/jardin/membres"], ["POST", "/api/p/jardin/invitations", { role: "mainteneur" }], ["GET", "/api/p/jardin/jetons"],
			["POST", "/api/p/jardin/jetons", { nom: "x" }], ["GET", "/api/p/jardin/tickets"], ["POST", "/api/p/jardin/tickets", { titre: "x" }], ["GET", "/api/p/jardin/reglages"],
			["POST", "/api/p/jardin/retours/batch", { ecritures: [] }], ["POST", "/api/p/jardin/builds", {}], ["GET", "/api/p/jardin/notes"], ["POST", "/api/p/jardin/import", { retours: [] }],
			["GET", "/invitation/abcdefghijklmnopqrstuvwxyz"], ["GET", "/__test/retours?projet=jardin"], ["POST", "/__test/mode", { projet: "jardin", mode: "normal" }],
		];
		for (const [methode, chemin, corps] of refusees) for (const cookie of [c, cm]) {
			const r = await appelHote(port, P, chemin, { cookie, methode, corps, entetes: chemin.startsWith("/__test") ? { "X-WDD": "1" } : {} });
			assert.equal(r.status, 404, `${methode} ${chemin} : ${r.status} ${r.texte.slice(0, 80)}`);
		}
	});

	test("hôte des pages : écrire un retour (Origin de l'hôte des pages) ; Origin de l'hôte principal refusé ; X-WDD exigé", async () => {
		const c = cookiePages((await entrer(camille)).r2.setCookie);
		const r = await appelHote(port, P, "/api/p/jardin/retours", { cookie: c, origin: uPages, corps: docRetour() });
		assert.equal(r.status, 201, r.texte);
		const id = r.corps.id;
		assert.equal((await appelHote(port, P, "/api/p/jardin/retours", { cookie: c, origin: u, corps: docRetour() })).status, 403);
		assert.equal((await appelHote(port, P, "/api/p/jardin/retours", { cookie: c, xwdd: false, corps: docRetour() })).status, 403);
		const p = await appelHote(port, P, `/api/p/jardin/retours/${id}`, { cookie: c, origin: uPages, methode: "PATCH", corps: { version: 1, champs: { proposal: "moins" } } });
		assert.equal(p.status, 200, p.texte);
		assert.equal((await appelHote(port, P, `/api/p/jardin/retours/${id}?version=2`, { cookie: c, origin: uPages, methode: "DELETE" })).status, 204);
		const l = await appelHote(port, P, "/api/p/jardin/retours", { cookie: c });
		assert.equal(l.status, 200); assert.ok(Array.isArray(l.corps.docs));
		// Sur l'hôte principal, l'Origin des pages est refusé (le cookie de session y est Strict de toute façon).
		assert.equal((await appelHote(port, H, "/api/p/jardin/retours", { cookie: camille, origin: uPages, corps: docRetour() })).status, 403);
		assert.equal((await appelHote(port, H, "/api/p/jardin/retours", { cookie: camille, origin: u, corps: docRetour() })).status, 201);
	});

	test("flux : pas d'événement « tickets » sur l'hôte des pages ; l'hôte principal l'a ; accès retiré → flux coupé", async () => {
		const c = cookiePages((await entrer(camille)).r2.setCookie);
		const ep = await ecouter(port, "/api/p/jardin/flux", c, P);
		const eh = await ecouter(port, "/api/p/jardin/flux", camille, H);
		try {
			assert.equal(ep.status, 200);
			await ep.attendre(1); await eh.attendre(1); await eh.attendreTickets(1);
			await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "Visible sur l'hôte principal seulement" } });
			await eh.attendreTickets(2);
			await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
			await ep.attendre(2);
			await pause(100);
			assert.equal(ep.tickets.length, 0, "aucun événement tickets sur l'hôte des pages");
			// Accès retiré : le flux de l'hôte des pages est coupé.
			assert.equal((await appel(u, "/api/p/jardin/membres/camille", { cookie: maud, methode: "DELETE" })).status, 200);
			await Promise.race([ep.ferme, new Promise((_, k) => setTimeout(() => k(new Error("flux de l'hôte des pages non coupé")), 3000))]);
			assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: c })).status, 401, "sessions de l'hôte des pages du projet supprimées");
		} finally { ep.fermer(); eh.fermer(); }
		await session(u, "jardin", "camille", "contributeur", "Camille");
	});

	test("compte désactivé : sa session de l'hôte des pages cesse aussi", async () => {
		const adm = await session(u, "jardin", "adm", "admin", "Admin");
		const c = cookiePages((await entrer(camille)).r2.setCookie);
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: c })).status, 200);
		assert.equal((await appel(u, "/api/admin/comptes/camille", { cookie: adm, methode: "PATCH", corps: { desactive: true } })).status, 200);
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: c })).status, 401);
		assert.equal((await appel(u, "/api/admin/comptes/camille", { cookie: adm, methode: "PATCH", corps: { desactive: false } })).status, 200);
		// Réactivé : les anciennes sessions ne reviennent pas (elles ont été supprimées, pas seulement masquées).
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: c })).status, 401, "ancien wdd_pages");
		assert.equal((await appelHote(port, H, "/api/p/jardin/session", { cookie: camille })).status, 401, "ancienne wdd_session");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		await session(u, "verger", "camille", "contributeur", "Camille");
	});

	test("sessions de l'hôte des pages : expirées purgées, 5 au plus par compte et par projet (les plus anciennes tombent)", async () => {
		const premiere = cookiePages((await entrer(camille)).r2.setCookie);
		s.ctx.base.db.prepare("INSERT INTO sessions_pages (hash, compte, projet, cree, expire) VALUES ('perimee', 'camille', 'verger', ?, ?)").run("2020-01-01T00:00:00.000Z", "2020-01-31T00:00:00.000Z");
		const cookies: string[] = [];
		for (let i = 0; i < 6; i++) cookies.push(cookiePages((await entrer(camille)).r2.setCookie));
		const n = (p: string) => Number((s.ctx.base.db.prepare("SELECT COUNT(*) AS n FROM sessions_pages WHERE compte = 'camille' AND projet = ?").get(p) as { n: number }).n);
		assert.equal(n("jardin"), 5);
		assert.equal(n("verger"), 0, "session expirée purgée");
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: premiere })).status, 401, "la plus ancienne est tombée");
		assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: cookies[0] })).status, 401);
		for (const c of cookies.slice(1)) assert.equal((await appelHote(port, P, "/api/p/jardin/session", { cookie: c })).status, 200);
	});

	test("deux cookies wdd_session (un posé par un sous-domaine) : aucune session n'est prise", async () => {
		assert.equal((await appelHote(port, H, "/api/moi", { cookie: camille })).status, 200);
		for (const c of [`${maud}; ${camille}`, `${camille}; ${maud}`, `${camille}; wdd_session=autre`]) {
			const r = await appelHote(port, H, "/api/moi", { cookie: c });
			assert.equal(r.status, 401, c);
		}
	});

	test("GET /api/moi signale l'isolement ; invitation acceptée → /p/<projet>/ → hôte des pages", async () => {
		assert.deepEqual((await appel(u, "/api/moi", { cookie: maud })).corps.isolement, { pages_separees: true, url_pages: uPages });
		assert.equal((await appel(u, "/api/moi", { cookie: maud })).corps.url, u, "url : l'hôte principal (WDD_URL), pas celui des pages");
		const inv = (await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "contributeur" } })).corps;
		const r = await appelHote(port, H, inv.lien, { corps: { nom: "Nina" }, origin: u });
		assert.equal(r.status, 303); assert.equal(r.entetes.location, "/p/jardin/");
		const nina = r.setCookie[0].split(";")[0];
		const { r2 } = await entrer(nina);
		assert.equal(r2.status, 303);
	});
	test("page d'invitation : form-action permet l'hôte des pages (le navigateur applique form-action à toute la chaîne de redirections)", async () => {
		const inv = (await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "contributeur" } })).corps;
		const r = await appelHote(port, H, inv.lien);
		assert.equal(r.status, 200);
		const csp = String(r.entetes["content-security-policy"]);
		assert.ok(csp.includes(`form-action 'self' ${uPages};`), csp);
		// Les autres pages gardent form-action 'self' seul (ici : invitation inconnue, page d'entrée requise).
		for (const chemin of ["/invitation/abcdefghijklmnopqrstuvwxyz", "/p/jardin/"]) {
			const autre = String((await appelHote(port, H, chemin)).entetes["content-security-policy"]);
			assert.ok(autre.includes("form-action 'self';"), chemin + " : " + autre);
		}
	});
});

describe("sans WDD_URL_PAGES : comportement de l'étape 1", () => {
	let s: Serveur, donnees: string, u: string;
	before(async () => { donnees = dossierTemp("meme-origine"); s = await serveurTest(donnees); u = s.url; await projet(u, "jardin"); });
	after(async () => { await s.arreter(); nettoyer(donnees); });
	test("Host quelconque accepté (pas de 421), /p/<projet>/ servi sur place (pas de redirection), isolement signalé absent", async () => {
		const c = await session(u, "jardin", "camille", "contributeur");
		assert.equal((await appelHote(s.port, "nimporte.quoi:1", "/api/p/jardin/session", { cookie: c })).status, 200);
		assert.equal((await appelHote(s.port, "localhost", "/p/jardin/", { cookie: c })).status, 404, "aucun build : 404, pas de redirection");
		assert.deepEqual((await appel(u, "/api/moi", { cookie: c })).corps.isolement, { pages_separees: false, url_pages: null });
	});
	test("page d'invitation : form-action 'self' seul", async () => {
		const adm = await session(u, "jardin", "adm", "admin");
		const inv = (await appel(u, "/api/p/jardin/invitations", { cookie: adm, corps: { role: "contributeur" } })).corps;
		const r = await appel(u, inv.lien);
		assert.equal(r.status, 200);
		assert.match(String(r.entetes.get("content-security-policy")), /form-action 'self';/);
	});
});

describe("méta-interface : fichiers statiques de serveur/ui/", () => {
	let s: Serveur, donnees: string, u: string, ui: string;
	before(async () => {
		donnees = dossierTemp("ui");
		ui = path.join(donnees, "ui");
		fs.mkdirSync(path.join(ui, "css"), { recursive: true });
		fs.mkdirSync(path.join(ui, "tests"), { recursive: true });
		fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>UI</title><script src=\"/app.js\"></script>");
		fs.writeFileSync(path.join(ui, "app.js"), "console.log(1)");
		fs.writeFileSync(path.join(ui, "css", "style.css"), "body{}");
		fs.writeFileSync(path.join(ui, "notes.ts"), "secret");
		fs.writeFileSync(path.join(ui, ".env"), "secret");
		fs.writeFileSync(path.join(ui, "tests", "scenario.js"), "secret");
		fs.writeFileSync(path.join(donnees, "dehors.js"), "secret");
		s = await serveurTest(donnees, { ui });
		u = s.url;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("index.html sous / avec CSP script-src 'self' ; types MIME ; liste blanche, pas de traversée, tests/ jamais servi", async () => {
		const r = await appel(u, "/");
		assert.equal(r.status, 200); assert.match(r.texte, /<title>UI<\/title>/);
		const csp = r.entetes.get("content-security-policy")!;
		assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp, /unsafe-inline/); assert.match(csp, /default-src 'none'/);
		assert.equal(r.entetes.get("content-type"), "text/html; charset=utf-8");
		assert.equal((await appel(u, "/app.js")).entetes.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal((await appel(u, "/css/style.css")).entetes.get("content-type"), "text/css; charset=utf-8");
		assert.equal((await appel(u, "/css/style.css")).entetes.get("x-content-type-options"), "nosniff");
		for (const ch of ["/notes.ts", "/.env", "/tests/scenario.js", "/Tests/scenario.js", "/TESTS/scenario.js", "/tEsTs/scenario.js", "/../dehors.js", "/%2e%2e/dehors.js", "/css/..%2f..%2fdehors.js", "/css%2f..%2f..%2fdehors.js", "/%5c..%5cdehors.js", "/absent.js", "/css/"]) {
			const r2 = await appel(u, ch);
			assert.equal(r2.status, 404, ch); assert.ok(!r2.texte.includes("secret"), ch);
		}
		assert.equal((await appel(u, "/api/p/jardin/session")).status, 401, "les routes de l'API passent avant les fichiers");
	});

	test("interface absente : la page d'accueil de l'étape 1", async () => {
		await s.arreter();
		s = await serveurTest(donnees, { ui: path.join(donnees, "absente") });
		u = s.url;
		const r = await appel(u, "/");
		assert.equal(r.status, 401); assert.match(r.texte, /Accès sur invitation/);
		assert.equal((await appel(u, "/app.js")).status, 404);
	});

	test("l'interface livrée (serveur/ui/) est servie par défaut, sans script en ligne", async () => {
		await s.arreter();
		s = await serveurTest(donnees);
		u = s.url;
		const r = await appel(u, "/");
		assert.equal(r.status, 200);
		assert.doesNotMatch(r.texte, /<script(?![^>]*\bsrc=)[^>]*>/, "aucun script en ligne");
		assert.doesNotMatch(r.texte, /\son[a-z]+=|style=/i, "ni gestionnaire ni style en ligne");
	});
});
