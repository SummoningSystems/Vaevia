// Bandeau commun du Wiki (docs/etape3-6-wiki-ui.md § A.2) : inséré par le serveur en tête de la page du projet servie,
// dans les deux modes (un seul hôte ; WDD_URL_PAGES). Onglets Wiki · Retours · Kanban · Membres (Membres pour un
// mainteneur ou un admin), liens vers la méta-interface de l'hôte principal, tout échappé, aucun script ajouté (CSP
// par empreintes inchangée), page du gabarit intacte après lui. Aussi : le Wiki pas encore publié porte le bandeau.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appel, appelHote, dossierTemp, nettoyer, serveurTest, projet, session, portLibre } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import { bandeau, phraseBranchement } from "../src/bandeau.ts";

const exemple = () => fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"));
const scriptsEnLigne = (page: string) => [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[\s/>]/gi)].map(m => m[1]);
const empreinte = (s: string) => `'sha256-${crypto.createHash("sha256").update(s, "utf8").digest("base64")}'`;
const scriptSrc = (csp: string) => (csp.split(";").map(x => x.trim()).find(x => x.startsWith("script-src ")) || "");
// Le bandeau seul (du <nav> à sa fermeture) et ses onglets (data-onglet → href).
const nav = (page: string) => (page.match(/<nav class="wdd-bandeau"[\s\S]*?<\/nav>/) || [""])[0];
const onglets = (page: string) => Object.fromEntries([...nav(page).matchAll(/<a href="([^"]*)" data-onglet="([a-z]+)"/g)].map(m => [m[2], m[1]]));

const TITRE_PIEGE = `<script>alert("titre")</script> Jardin "d'été" & co`;
const NOM_PIEGE = `<img src=x onerror=alert(1)> "Zoé" l'ami & co`;

describe("bandeau du Wiki : un seul hôte", () => {
	let s: Serveur, donnees: string, u: string, adm: string, maud: string, camille: string, agentM: string;
	before(async () => {
		donnees = dossierTemp("bandeau");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		await projet(u, "verger");
		adm = await session(u, "jardin", "adm", "admin", "Adèle");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		await session(u, "verger", "camille", "contributeur", "Camille");
		const j = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent M", role: "mainteneur" } });
		assert.equal(j.status, 201, j.texte); assert.equal(j.corps.role, "mainteneur");
		agentM = j.corps.jeton;
		const b = await appel(u, "/api/p/jardin/builds", { cookie: adm, brut: exemple(), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("contributeur : bandeau en tête de <body>, avant la page ; Wiki · Retours · Kanban, sans Membres ; liens relatifs", async () => {
		const p = await appel(u, "/p/jardin/", { cookie: camille });
		assert.equal(p.status, 200);
		assert.match(p.texte, /<body><style>[\s\S]*?\.wdd-bandeau[\s\S]*?<\/style><nav class="wdd-bandeau" id="wdd-bandeau" aria-label="[^"]+">/);
		const iNav = p.texte.indexOf('<nav class="wdd-bandeau"'), iPage = p.texte.indexOf('id="wrap"');
		assert.ok(iNav > 0 && iPage > iNav, "bandeau avant la page");
		assert.deepEqual(Object.keys(onglets(p.texte)), ["accueil", "wiki", "retours", "kanban"], "ordre, sans Membres ni Administration");
		assert.deepEqual(onglets(p.texte), { accueil: "/#/", wiki: "/p/jardin/", retours: "/#/p/jardin/retours", kanban: "/#/p/jardin/kanban" });
		assert.match(nav(p.texte), /<a href="\/p\/jardin\/" data-onglet="wiki" aria-current="page">Wiki<\/a>/);
		// Marque neutre (lot B) : icône SVG en ligne et « Accueil », qui est le lien data-onglet="accueil" ; plus de « Retours ».
		assert.match(nav(p.texte), /<a href="\/#\/" data-onglet="accueil" class="wdd-b-marque"><svg [^>]*aria-hidden="true"[\s\S]*?<\/svg><span class="wdd-b-marque-texte">Accueil<\/span><\/a>/);
		assert.equal((nav(p.texte).match(/>Retours</g) || []).length, 1, "« Retours » seulement pour l'onglet des retours");
		assert.match(nav(p.texte), /<strong class="wdd-b-titre">Projet jardin<\/strong>/);
		assert.match(nav(p.texte), /<span class="wdd-b-nom">Camille<\/span>/);
		// La page du gabarit reste entière (ids et hôtes lus par site/tests/scenarios.js et retours.js).
		for (const id of ['id="fb-top"', 'id="fb-fab"', 'id="fb-panel"', '<meta name="wdd-api" content="/api/p/jardin">']) assert.ok(p.texte.includes(id), id);
	});

	test("aucun script ajouté : script-src = empreintes des scripts de la page, rien d'autre ; aucun style ni script externe", async () => {
		const p = await appel(u, "/p/jardin/", { cookie: camille });
		assert.ok(!/<script/i.test(nav(p.texte)), "pas de script dans le bandeau");
		const attendues = new Set(scriptsEnLigne(p.texte).map(empreinte));
		assert.deepEqual(new Set(scriptSrc(String(p.entetes.get("content-security-policy"))).replace(/^script-src\s+/, "").split(/\s+/)), attendues);
		assert.ok(!/<link\b|@import|url\(/i.test(p.texte.slice(0, p.texte.indexOf("</nav>"))), "ni feuille ni ressource externe dans le bandeau");
		assert.ok(!/ style=/.test(nav(p.texte)), "pas d'attribut style");
	});

	test("mainteneur : onglet Membres ; admin : Membres et Administration", async () => {
		const m = await appel(u, "/p/jardin/", { cookie: maud });
		assert.deepEqual(Object.keys(onglets(m.texte)), ["accueil", "wiki", "retours", "kanban", "membres"]);
		assert.equal(onglets(m.texte).membres, "/#/p/jardin/membres");
		const a = await appel(u, "/p/jardin/", { cookie: adm });
		assert.deepEqual(Object.keys(onglets(a.texte)), ["accueil", "admin", "wiki", "retours", "kanban", "membres"]);
		assert.equal(onglets(a.texte).admin, "/#/admin");
		assert.match(nav(a.texte), /<span class="wdd-b-nom">Adèle<\/span>/);
	});

	test("jeton d'agent (rôle mainteneur) : son nom, ni Membres ni Administration", async () => {
		const p = await appel(u, "/p/jardin/", { bearer: agentM });
		assert.equal(p.status, 200);
		assert.deepEqual(Object.keys(onglets(p.texte)), ["accueil", "wiki", "retours", "kanban"]);
		assert.match(nav(p.texte), /<span class="wdd-b-nom">Agent M<\/span>/);
	});

	test("titre du projet et nom de la personne échappés (<script>, balise, guillemets, apostrophe, &)", async () => {
		s.ctx.base.db.prepare("UPDATE projets SET titre = ? WHERE id = ?").run(TITRE_PIEGE, "jardin");
		s.ctx.base.db.prepare("UPDATE comptes SET nom = ? WHERE id = ?").run(NOM_PIEGE, "camille");
		try {
			const p = await appel(u, "/p/jardin/", { cookie: camille });
			assert.equal(p.status, 200);
			const b = nav(p.texte);
			assert.ok(!p.texte.includes(`<script>alert("titre")`) && !p.texte.includes("<img src=x onerror"), "rien de brut");
			assert.ok(b.includes(`&lt;script&gt;alert(&quot;titre&quot;)&lt;/script&gt; Jardin &quot;d&#39;été&quot; &amp; co`), b);
			assert.ok(b.includes(`&lt;img src=x onerror=alert(1)&gt; &quot;Zoé&quot; l&#39;ami &amp; co`), b);
			// Les empreintes ne changent pas : le titre piégé n'est pas devenu un script.
			assert.deepEqual(new Set(scriptSrc(String(p.entetes.get("content-security-policy"))).replace(/^script-src\s+/, "").split(/\s+/)), new Set(scriptsEnLigne(p.texte).map(empreinte)));
		} finally {
			s.ctx.base.db.prepare("UPDATE projets SET titre = ? WHERE id = ?").run("Projet jardin", "jardin");
			s.ctx.base.db.prepare("UPDATE comptes SET nom = ? WHERE id = ?").run("Camille", "camille");
		}
	});

	test("Wiki pas encore publié : 404 avec le bandeau ; sans session : 401 sans bandeau ; sans accès : 403 sans bandeau", async () => {
		const p = await appel(u, "/p/verger/", { cookie: camille });
		assert.equal(p.status, 404);
		assert.match(p.texte, /Wiki pas encore publié/);
		assert.deepEqual(Object.keys(onglets(p.texte)), ["accueil", "wiki", "retours", "kanban"]);
		assert.equal(onglets(p.texte).kanban, "/#/p/verger/kanban");
		assert.equal(scriptSrc(String(p.entetes.get("content-security-policy"))), "script-src 'none'");
		const sans = await appel(u, "/p/jardin/?wdd_r=1");
		assert.equal(sans.status, 401); assert.ok(!sans.texte.includes("wdd-bandeau"));
		const autre = await session(u, "verger", "rose", "contributeur", "Rose");
		const refus = await appel(u, "/p/jardin/", { cookie: autre });
		assert.equal(refus.status, 403); assert.ok(!refus.texte.includes("wdd-bandeau"));
	});

	test("Wiki pas encore publié : bloc « Brancher un dépôt de code » et phrase mot pour mot pour un mainteneur ou un admin ; ni pour un contributeur, ni pour un jeton", async () => {
		const phrase = `Branche ce dépôt sur le serveur de retours ${u} (projet verger) avec la CLI outil : lance outil methode et suis le § 0.`;
		const maudV = await session(u, "verger", "maud", "mainteneur", "Maud");
		for (const c of [maudV, adm]) {
			const p = await appel(u, "/p/verger/", { cookie: c });
			assert.equal(p.status, 404);
			assert.match(p.texte, /<h2>Brancher un dépôt de code<\/h2>/);
			assert.ok(p.texte.includes(`<p id="phrase-branchement"><code>${phrase}</code></p>`), p.texte);
			assert.ok(!p.texte.slice(p.texte.indexOf("</nav>")).includes("<script"), "sans script");
			assert.equal(scriptSrc(String(p.entetes.get("content-security-policy"))), "script-src 'none'");
		}
		assert.ok(!(await appel(u, "/p/verger/", { cookie: camille })).texte.includes("Brancher un dépôt"), "contributeur : pas de bloc");
		const jv = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "verger", nom: "Agent V" } })).corps.jeton;
		const a = await appel(u, "/p/verger/", { bearer: jv });
		assert.equal(a.status, 404); assert.ok(!a.texte.includes("Brancher un dépôt"), "jeton : pas de bloc");
		// Même phrase que la méta-interface (branchement.js) et que la méthode (gabarit <URL>, <P>).
		assert.equal(phraseBranchement("<URL>", "<P>"), "Branche ce dépôt sur le serveur de retours <URL> (projet <P>) avec la CLI outil : lance outil methode et suis le § 0.");
		assert.ok(fs.readFileSync(path.join(RACINE_OUTIL, "serveur", "ui", "js", "branchement.js"), "utf8").includes("`" + phraseBranchement("${url}", "${projet}") + "`"), "branchement.js");
	});

	test("GET /api/p/<p>/builds/<n>/page (outil apercu) : JSON (jamais text/html), page servie à l'appelant avec son bandeau, CSP calculée sur ce texte ; n invalide ou absent : 404", async () => {
		const n = (await appel(u, "/api/p/jardin/builds", { bearer: agentM })).corps.dernier.build;
		const r = await appel(u, `/api/p/jardin/builds/${n}/page`, { bearer: agentM });
		assert.equal(r.status, 200, r.texte);
		assert.match(String(r.entetes.get("content-type")), /^application\/json/);
		assert.equal(r.entetes.get("content-security-policy"), null);
		assert.equal(r.corps.build, n);
		const servie = await appel(u, "/p/jardin/", { bearer: agentM });
		assert.equal(r.corps.html, servie.texte, "même page que /p/jardin/ pour ce jeton (bandeau compris)");
		assert.equal(r.corps.csp, servie.entetes.get("content-security-policy"));
		assert.ok(!r.corps.html.includes("\r"), "fins de ligne LF");
		assert.deepEqual(new Set(scriptSrc(r.corps.csp).replace(/^script-src\s+/, "").split(/\s+/)), new Set(scriptsEnLigne(r.corps.html).map(empreinte)));
		assert.deepEqual(Object.keys(onglets(r.corps.html)), ["accueil", "wiki", "retours", "kanban"], "bandeau du jeton : ni Membres ni Administration");
		// Un contributeur (session) l'obtient aussi, avec son propre bandeau ; sans identité : 401.
		const c = await appel(u, `/api/p/jardin/builds/${n}/page`, { cookie: camille });
		assert.equal(c.status, 200); assert.match(nav(c.corps.html), /<span class="wdd-b-nom">Camille<\/span>/);
		assert.equal((await appel(u, `/api/p/jardin/builds/${n}/page`)).status, 401);
		for (const x of ["0", "999", "01", "abc", "1.5", ".."]) {
			const e = await appel(u, `/api/p/jardin/builds/${x}/page`, { bearer: agentM });
			assert.equal(e.status, 404, x); assert.equal(e.corps.code, "not_found", x);
		}
		assert.equal((await appel(u, `/api/p/verger/builds/1/page`, { cookie: adm })).status, 404, "projet sans build");
	});

	test("bandeau() : identifiant du projet encodé dans les liens, base absolue préfixée", () => {
		const b = bandeau({ projet: "a-b", titre: "T", nom: "N", role: "mainteneur", agent: false, base: "https://retours.exemple.fr" });
		assert.match(b, /href="https:\/\/retours\.exemple\.fr\/#\/p\/a-b\/kanban" data-onglet="kanban"/);
		assert.match(b, /href="\/p\/a-b\/" data-onglet="wiki" aria-current="page"/);
		assert.match(b, /href="https:\/\/retours\.exemple\.fr\/#\/" data-onglet="accueil"/);
	});

	test("bandeau() : compteurs des onglets Retours (à traiter, dont questions) et Kanban (à faire), comme la méta-interface", () => {
		const b = bandeau({ projet: "a-b", titre: "T", nom: "N", role: "contributeur", agent: false, base: "", retours: 6, questions: 1, aFaire: 3 });
		assert.match(b, /data-onglet="retours">Retours<span class="wdd-b-compte nouveaux"><span aria-hidden="true">6<\/span><span class="wdd-b-invisible"> \(6 à traiter, dont 1 question\)<\/span><\/span><\/a>/);
		assert.match(b, /data-onglet="kanban">Kanban<span class="wdd-b-compte a-faire"><span aria-hidden="true">3<\/span><span class="wdd-b-invisible"> \(3 à faire\)<\/span><\/span><\/a>/);
		assert.equal((b.match(/>Retours</g) || []).length, 1, "« Retours » nomme seulement l'onglet");
		const z = bandeau({ projet: "a-b", titre: "T", nom: "N", role: "contributeur", agent: false, base: "", retours: 0, aFaire: 0 });
		assert.doesNotMatch(z, /wdd-b-compte [a-z]/, "pas de pastille à zéro");
	});
});

describe("bandeau du Wiki : deux hôtes (WDD_URL_PAGES)", () => {
	let s: Serveur, donnees: string, port: number, H: string, P: string, u: string, maud: string, camille: string;
	before(async () => {
		donnees = dossierTemp("bandeau-hotes");
		port = await portLibre();
		H = `127.0.0.1:${port}`; P = `localhost:${port}`;
		u = `http://${H}`;
		s = await serveurTest(donnees, { port, url: u, urlPages: `http://${P}` });
		await projet(u, "jardin");
		await projet(u, "verger");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		await session(u, "verger", "camille", "contributeur", "Camille");
		const b = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: exemple(), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	// Entrée par le jeton : cookie wdd_pages du projet.
	const entrer = async (cookie: string, p = "jardin") => {
		const r1 = await appelHote(port, H, `/p/${p}/`, { cookie });
		assert.equal(r1.status, 303, r1.texte);
		const loc = new URL(String(r1.entetes.location));
		const r2 = await appelHote(port, P, loc.pathname + loc.search);
		assert.equal(r2.status, 303);
		return r2.setCookie.map(c => c.split(";")[0]).find(Boolean)!;
	};

	test("hôte des pages : bandeau de la session wdd_pages, onglets vers WDD_URL/#/…, Wiki relatif", async () => {
		const c = await entrer(camille);
		const p = await appelHote(port, P, "/p/jardin/", { cookie: c });
		assert.equal(p.status, 200);
		assert.deepEqual(onglets(p.texte), { accueil: `${u}/#/`, wiki: "/p/jardin/", retours: `${u}/#/p/jardin/retours`, kanban: `${u}/#/p/jardin/kanban` });
		assert.match(nav(p.texte), /<span class="wdd-b-nom">Camille<\/span>/);
		const m = await appelHote(port, P, "/p/jardin/", { cookie: await entrer(maud) });
		assert.equal(onglets(m.texte).membres, `${u}/#/p/jardin/membres`);
		// Aucune route nouvelle sur l'hôte des pages : la méta-interface et ses fichiers y restent en 404.
		for (const r of ["/", "/ui.css", "/ui.js", "/icone.svg"]) assert.equal((await appelHote(port, P, r, { cookie: c })).status, 404, r);
	});

	test("hôte des pages : Wiki pas encore publié avec le bandeau ; hôte principal : toujours la redirection", async () => {
		const c = await entrer(camille, "verger");
		const p = await appelHote(port, P, "/p/verger/", { cookie: c });
		assert.equal(p.status, 404);
		assert.equal(onglets(p.texte).kanban, `${u}/#/p/verger/kanban`);
		assert.ok(!p.texte.includes("Brancher un dépôt"), "contributeur : pas de bloc");
		// Mainteneur : la phrase porte l'adresse de l'hôte principal (WDD_URL), jamais celle de l'hôte des pages.
		const maudV = await session(u, "verger", "maud", "mainteneur", "Maud");
		const m = await appelHote(port, P, "/p/verger/", { cookie: await entrer(maudV, "verger") });
		assert.equal(m.status, 404);
		assert.ok(m.texte.includes(`<p id="phrase-branchement"><code>Branche ce dépôt sur le serveur de retours ${u} (projet verger) avec la CLI outil : lance outil methode et suis le § 0.</code></p>`), m.texte);
		assert.equal((await appelHote(port, H, "/p/jardin/", { cookie: camille })).status, 303);
	});

	test("aperçu (GET /api/p/<p>/builds/<n>/page) : un jeton d'agent l'obtient sur l'hôte principal, liens du bandeau absolus ; l'hôte des pages ne l'a pas (404)", async () => {
		const adm = await session(u, "jardin", "adm", "admin", "Adèle");
		const jeton = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent pages" } })).corps.jeton;
		const r = await appelHote(port, H, "/api/p/jardin/builds/1/page", { bearer: jeton });
		assert.equal(r.status, 200, r.texte);
		const corps = JSON.parse(r.texte);
		assert.match(corps.html, /^<!doctype html>/i);
		assert.equal(onglets(corps.html).kanban, `${u}/#/p/jardin/kanban`);
		assert.match(corps.csp, /^default-src 'none';.*script-src 'sha256-/);
		const c = await entrer(camille);
		for (const o of [{ cookie: c }, { bearer: jeton }]) assert.equal((await appelHote(port, P, "/api/p/jardin/builds/1/page", o)).status, 404);
	});
});
