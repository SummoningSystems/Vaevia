#!/usr/bin/env node
// Scénario Edge de la méta-interface (docs/etape3-meta-interface.md § 6, critère 3). Appelé par lancer.sh :
//   node serveur/ui/tests/scenario.js <dossier de sortie hors dépôt> <navigateur>
// Node 24, aucune dépendance (fetch et WebSocket intégrés).
//
// Déroulé :
// 1. serveur A : WDD_TEST=1, port libre P, WDD_URL=http://127.0.0.1:P, WDD_URL_PAGES=http://localhost:P (deux hôtes) ;
//    serveur B : sans WDD_URL_PAGES (bandeau « même origine » de l'administration) ;
// 2. données par POST /__test/preparer (projet « jardin », retours, comptes Camille mainteneur et Alex admin,
//    invitation contributeur), notes et build de site/examples/data.json ;
// 3. Edge sans fenêtre (profil neuf dans <sortie>/edge, --remote-debugging-port=0), un contexte par personne ;
// 4. parcours : hôte des pages par le jeton d'entrée (page connectée, retour écrit, /api/admin en 404), entrée par
//    invitation, membres (invitation, jeton affiché une fois, réglages), ticket depuis deux retours, échappement d'une
//    description piégée, Kanban en direct, déplacement au clavier, commit lié, 409 sans perte de saisie, fermeture qui
//    passe les retours à « fait », administration (journal, bandeau), 360 px sans défilement horizontal sur chaque vue,
//    aucune violation de CSP ni exception dans la méta-interface ;
// 5. étape 3.5 : page d'appairage (sans session, lien de reconnexion ouvert par un clic, code, IP et avertissement
//    d'une autre machine, autoriser au clavier → la CLI simulée reçoit le jeton une fois, refuser, ponctuel, code tapé,
//    429), bandeau Traitement (sans veilleur, faux veilleur piloté par HTTP avec le jeton appairé : attente → en cours →
//    terminée, résumé en texte brut, annulations, rôle, réglage « personne »), point d'état de l'accueil, lien de
//    reconnexion créé par l'admin ; bloc « Brancher un dépôt de code » du Kanban (phrase exacte, Copier) pour un
//    mainteneur, absent pour un contributeur.
// 6. étape 3.6 (§ A.2) : le Wiki d'abord. L'accueil ouvre un projet sur son Wiki ; onglets Wiki · Retours · Kanban ·
//    Membres ; bandeau commun rendu par le serveur en tête du Wiki (deux hôtes et un seul) : onglets, nom, titre,
//    Membres selon le rôle, clair et sombre, 360 px, onglets du gabarit intacts, lien Kanban du bandeau qui arrive
//    connecté sur l'hôte principal (malgré wdd_session SameSite=Strict), lien Wiki de la méta-interface.
// Sortie : PASS / FAIL par vérification, BILAN ; captures PNG et journaux dans <sortie>. Code 1 si un FAIL.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

const [sortieBrute, navigateur] = process.argv.slice(2);
if (!sortieBrute || !navigateur) { console.error("usage : node scenario.js <dossier de sortie> <navigateur>"); process.exit(2); }
const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const SORTIE = path.resolve(sortieBrute);
const PROJET = "jardin";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const journal = m => console.error("[scenario-ui] " + m);

// --- Résultats ----------------------------------------------------------------------------------------------
let nPass = 0, nFail = 0;
function ok(cond, msg, extra) {
	if (cond) nPass++; else nFail++;
	console.log((cond ? "PASS " : "FAIL ") + msg + (!cond && extra !== undefined ? "  :: " + JSON.stringify(extra).slice(0, 400) : ""));
	return !!cond;
}
const etape = t => console.log("--- " + t);

// --- Serveurs -----------------------------------------------------------------------------------------------
const serveurs = [];
function portLibre() {
	return new Promise((ok2, ko) => {
		const s = net.createServer();
		s.once("error", ko);
		s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok2(p)); });
	});
}
async function demarrerServeur(nom, pagesSeparees) {
	const port = await portLibre();
	const donnees = path.join(SORTIE, "donnees-" + nom);
	fs.rmSync(donnees, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	const env = { ...process.env, WDD_DONNEES: donnees, WDD_TEST: "1", WDD_PORT: String(port), WDD_HOTE: "127.0.0.1", WDD_URL: `http://127.0.0.1:${port}` };
	delete env.WDD_HTTPS; delete env.WDD_UI; delete env.WDD_URL_PAGES;
	if (pagesSeparees) env.WDD_URL_PAGES = `http://localhost:${port}`;
	const p = spawn(process.execPath, [path.join(RACINE, "serveur", "src", "principal.ts")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	serveurs.push(p);
	const log = fs.createWriteStream(path.join(SORTIE, `serveur-${nom}.log`));
	let texte = "";
	return await new Promise((ok2, ko) => {
		const fin = setTimeout(() => ko(new Error(`serveur ${nom} : pas démarré en 30 s (voir serveur-${nom}.log)`)), 30000);
		const lire = b => {
			log.write(b);
			if (texte === null) return;
			texte += b.toString("utf8");
			if (/à l'écoute sur http:\/\/\S+ \(PID \d+\)/.test(texte)) { clearTimeout(fin); texte = null; ok2({ url: `http://127.0.0.1:${port}`, pages: `http://localhost:${port}`, port, pid: p.pid }); }
		};
		p.stdout.on("data", lire);
		p.stderr.on("data", lire);
		p.on("exit", c => { clearTimeout(fin); if (texte !== null) ko(new Error(`serveur ${nom} arrêté (code ${c})`)); });
	});
}

// Requête au serveur depuis Node (préparation, vérifications, second acteur).
async function appel(base, methode, chemin, { corps, brut, cookie, bearer } = {}) {
	const h = {};
	if (corps !== undefined || brut !== undefined) h["Content-Type"] = "application/json";
	if (cookie) { h.Cookie = cookie; }
	if (methode !== "GET") h["X-WDD"] = "1";
	if (bearer) h.Authorization = "Bearer " + bearer;
	const r = await fetch(base + chemin, { method: methode, headers: h, redirect: "manual", body: brut !== undefined ? brut : corps !== undefined ? JSON.stringify(corps) : undefined });
	const t = await r.text();
	let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
	return { status: r.status, corps: j, texte: t };
}
async function exiger(base, methode, chemin, o) {
	const r = await appel(base, methode, chemin, o);
	if (r.status < 200 || r.status >= 300) throw new Error(`${methode} ${chemin} -> ${r.status} ${r.texte.slice(0, 300)}`);
	return r.corps;
}

// Requête par node:http, avec une adresse source au choix (localAddress) : un appairage « depuis une autre machine »
// part de 127.0.0.2, le navigateur de 127.0.0.1 (le serveur en écoute locale compare les deux, meme_ip).
function requeteHttp(base, methode, chemin, corps, localAddress) {
	return new Promise((ok2, ko) => {
		const u = new URL(base + chemin);
		const b = corps === undefined ? null : Buffer.from(JSON.stringify(corps));
		const entetes = { ...(b ? { "Content-Type": "application/json", "Content-Length": b.length } : {}), ...(methode !== "GET" ? { "X-WDD": "1" } : {}) };
		const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: methode, headers: entetes, ...(localAddress ? { localAddress } : {}) }, res => {
			let t = "";
			res.setEncoding("utf8");
			res.on("data", c => { t += c; });
			res.on("end", () => { let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; } ok2({ status: res.statusCode, corps: j }); });
		});
		r.on("error", ko);
		if (b) r.write(b);
		r.end();
	});
}

// --- Navigateur (protocole DevTools) --------------------------------------------------------------------------
let edge = null, cdp = null;
async function demarrerEdge() {
	const profil = path.join(SORTIE, "edge");
	fs.rmSync(profil, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(profil, { recursive: true });
	edge = spawn(navigateur, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
		`--user-data-dir=${profil}`, "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows", "--disable-extensions", "--host-resolver-rules=MAP localhost 127.0.0.1", "about:blank"],
		{ stdio: "ignore", windowsHide: true });
	edge.on("error", e => journal("navigateur : " + e.message));
	const fichier = path.join(profil, "DevToolsActivePort");
	for (let i = 0; i < 150; i++) {
		if (fs.existsSync(fichier)) {
			const [port, chemin] = fs.readFileSync(fichier, "utf8").split(/\r?\n/);
			if (port && chemin) return `ws://127.0.0.1:${port}${chemin}`;
		}
		await sleep(200);
	}
	throw new Error("le navigateur n'a pas ouvert son port DevTools en 30 s");
}

function connecterCdp(url) {
	return new Promise((ok2, ko) => {
		const ws = new WebSocket(url);
		let n = 0;
		const attente = new Map(), ecouteurs = new Map();
		ws.onmessage = ev => {
			const m = JSON.parse(String(ev.data));
			if (m.id && attente.has(m.id)) {
				const a = attente.get(m.id); attente.delete(m.id);
				m.error ? a.ko(new Error(`CDP ${a.methode} : ${m.error.message}`)) : a.ok(m.result || {});
			} else if (m.method && m.sessionId && ecouteurs.has(m.sessionId)) ecouteurs.get(m.sessionId)(m.method, m.params);
		};
		ws.onerror = () => ko(new Error("connexion DevTools impossible"));
		ws.onclose = () => { for (const a of attente.values()) a.ko(new Error("connexion DevTools fermée")); attente.clear(); };
		ws.onopen = () => ok2({
			envoyer: (methode, params = {}, sessionId) => new Promise((ok3, ko3) => {
				const id = ++n;
				attente.set(id, { ok: ok3, ko: ko3, methode });
				ws.send(JSON.stringify(sessionId ? { id, method: methode, params, sessionId } : { id, method: methode, params }));
			}),
			ecouter: (sessionId, f) => ecouteurs.set(sessionId, f),
			fermer: () => { try { ws.close(); } catch { } },
		});
	});
}

// Capture, dans chaque document : violations de CSP, erreurs et rejets non traités.
const SONDE = `(() => {
	window.__csp = []; window.__erreurs = [];
	document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + e.blockedURI + " " + (e.sourceFile || "") + ":" + e.lineNumber));
	window.addEventListener("error", e => window.__erreurs.push(String(e.message)));
	window.addEventListener("unhandledrejection", e => window.__erreurs.push("rejet : " + String(e.reason && e.reason.message || e.reason)));
})();`;

const onglets = [];
class Onglet {
	static async ouvrir(nom) {
		const o = new Onglet();
		o.nom = nom;
		o.problemes = [];
		({ browserContextId: o.contexte } = await cdp.envoyer("Target.createBrowserContext", { disposeOnDetach: true }));
		({ targetId: o.cible } = await cdp.envoyer("Target.createTarget", { url: "about:blank", browserContextId: o.contexte, width: 1280, height: 900 }));
		({ sessionId: o.session } = await cdp.envoyer("Target.attachToTarget", { targetId: o.cible, flatten: true }));
		cdp.ecouter(o.session, (m, p) => {
			if (m === "Runtime.exceptionThrown") o.problemes.push({ url: p.exceptionDetails.url || "", texte: "exception : " + (p.exceptionDetails.exception?.description || p.exceptionDetails.text) });
			if (m === "Log.entryAdded" && p.entry.level === "error" && p.entry.source !== "network") o.problemes.push({ url: p.entry.url || "", texte: `${p.entry.source} : ${p.entry.text}` });
			// console.error de la page : une vue qui lève une exception pendant un dessin en direct est attrapée par
			// projet.js (avertir), qui la passe à console.error ; Runtime.exceptionThrown ne la voit donc pas.
			if (m === "Runtime.consoleAPICalled" && p.type === "error") o.problemes.push({ url: p.stackTrace?.callFrames?.[0]?.url || "", texte: "erreur : console.error : " + (p.args || []).map(a => a.value ?? a.description ?? "").join(" ") });
		});
		for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await o.s(m);
		await o.s("Emulation.setFocusEmulationEnabled", { enabled: true });
		await o.s("Page.addScriptToEvaluateOnNewDocument", { source: SONDE });
		onglets.push(o);
		return o;
	}
	s(m, p) { return cdp.envoyer(m, p, this.session); }
	async eval(expr) {
		// Délai : un onglet figé (boucle sans fin dans une vue) ne répond plus ; le scénario échoue au lieu d'attendre.
		let minuterie;
		const delai = new Promise((_, ko) => { minuterie = setTimeout(() => ko(new Error(`eval (${this.nom}) : onglet sans réponse en 20 s`)), 20000); });
		const r = await Promise.race([this.s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }), delai]).finally(() => clearTimeout(minuterie));
		if (r.exceptionDetails) throw new Error(`eval (${this.nom}) : ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n  ${expr.slice(0, 200)}`);
		return r.result.value;
	}
	async essayer(expr) { try { return await this.eval(expr); } catch { return undefined; } }
	async attendre(expr, ms = 10000) {
		const fin = Date.now() + ms;
		while (Date.now() < fin) {
			if (await this.essayer(`!!(${expr})`)) return true;
			await sleep(100);
		}
		return false;
	}
	async aller(url, condition = "document.readyState === 'complete'") {
		await this.relever();
		await this.s("Page.navigate", { url });
		await sleep(150);
		return await this.attendre(condition, 15000);
	}
	// Méta-interface prête : vue affichée et données chargées.
	async vue(nom) { return await this.attendre(`document.body && document.body.dataset.vue === ${JSON.stringify(nom)} && document.body.dataset.charge === "1"`, 15000); }
	async hash(h, nom) { await this.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(50); return await this.vue(nom); }
	async cliquer(sel) { await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("absent : " + ${JSON.stringify(sel)}); e.click(); })()`); }
	async cliquerTexte(sel, texte) {
		await this.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim() === ${JSON.stringify(texte)}); if (!e) throw new Error("absent : " + ${JSON.stringify(texte)}); e.click(); })()`);
	}
	async valeur(sel, v) { await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`); }
	async focus(sel, fin = false) { await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); ${fin ? "e.setSelectionRange(e.value.length, e.value.length);" : ""} })()`); }
	async taper(texte) { await this.s("Input.insertText", { text: texte }); }
	async touche(cle) {
		const T = { Enter: [13, "\r"], Escape: [27, ""], ArrowDown: [40, ""], ArrowUp: [38, ""], Tab: [9, ""], Space: [32, " "] }[cle];
		const key = cle === "Space" ? " " : cle;
		await this.s("Input.dispatchKeyEvent", { type: "keyDown", key, code: cle, windowsVirtualKeyCode: T[0], nativeVirtualKeyCode: T[0], ...(T[1] ? { text: T[1], unmodifiedText: T[1] } : {}) });
		await this.s("Input.dispatchKeyEvent", { type: "keyUp", key, code: cle, windowsVirtualKeyCode: T[0], nativeVirtualKeyCode: T[0] });
		await sleep(80);
	}
	texte(sel) { return this.essayer(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`); }
	async capture(nom) {
		try {
			const r = await this.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
			fs.writeFileSync(path.join(SORTIE, nom + ".png"), Buffer.from(r.data, "base64"));
		} catch (e) { journal("capture " + nom + " : " + e.message); }
	}
	async largeur(w) {
		if (w) await this.s("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: true });
		else await this.s("Emulation.clearDeviceMetricsOverride");
		await sleep(300);
	}
	// Relève les violations de CSP et erreurs du document courant (avant de le quitter).
	async relever() {
		const r = await this.essayer(`JSON.stringify({ url: location.href, csp: window.__csp || [], erreurs: window.__erreurs || [] })`);
		if (!r) return;
		const x = JSON.parse(r);
		for (const c of x.csp) this.problemes.push({ url: x.url, texte: "CSP : " + c });
		for (const e of x.erreurs) this.problemes.push({ url: x.url, texte: "erreur : " + e });
		await this.essayer("window.__csp = []; window.__erreurs = []; 0");
	}
	async fermer() {
		await this.relever();
		await cdp.envoyer("Target.closeTarget", { targetId: this.cible }).catch(() => { });
		await cdp.envoyer("Target.disposeBrowserContext", { browserContextId: this.contexte }).catch(() => { });
	}
}

// Onglets du bandeau du Wiki (étape 3.6, § A.2) : « nom=href », dans l'ordre.
const ONGLETS_BANDEAU = `[...document.querySelectorAll("#wdd-bandeau [data-onglet]")].map(a => a.dataset.onglet + "=" + a.getAttribute("href"))`;

// Pas de défilement horizontal à 360 px.
async function verifier360(o, nom) {
	await o.largeur(360);
	const m = JSON.parse(await o.eval(`JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth,
		large: [...document.querySelectorAll("body *")].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > document.documentElement.clientWidth + 1; }).slice(0, 5).map(e => e.tagName + "." + e.className + "#" + e.id) })`));
	ok(m.sw <= m.cw && m.bw <= m.cw, `360 px sans défilement horizontal : ${nom}`, m);
	await o.capture("360-" + nom);
	await o.largeur(0);
}

// --- Scénario -------------------------------------------------------------------------------------------------
async function principal() {
	fs.mkdirSync(SORTIE, { recursive: true });
	const A = await demarrerServeur("a", true);
	const B = await demarrerServeur("b", false);
	journal(`serveur A ${A.url} (pages ${A.pages}, PID ${A.pid}) ; serveur B ${B.url} (PID ${B.pid})`);
	const U = A.url;

	// Données
	const t0 = Date.now();
	const iso = m => new Date(t0 - m * 60000).toISOString();
	const prep = await exiger(U, "POST", "/__test/preparer", { corps: {
		projet: PROJET, titre: "Jardin",
		retours: [
			{ id: "r1", donnees: { kind: "plante", ref: "tomate", name: "Tomate", tab: "plantes", anchor: "plantes--tomate", cat: "bug", text: 'Les feuilles jaunissent <img src=x onerror="window.__xssRetour=1">', by: "camille", created: iso(30), updated: iso(30) } },
			{ id: "r2", donnees: { kind: "plante", ref: "courgette", name: "Courgette", tab: "plantes", anchor: "plantes--courgette", cat: "idee", text: "Arroser moins souvent en mai.", by: "alex", created: iso(20), updated: iso(20) } },
			{ id: "r3", donnees: { kind: "plante", ref: "poivron", name: "Poivron", tab: "plantes", anchor: "plantes--poivron", cat: "texte", text: "Déjà réglé.", status: "fait", by: "alex", created: iso(10), updated: iso(10) } },
		],
		comptes: [{ id: "camille", nom: "Camille", role: "mainteneur" }, { id: "alex", nom: "Alex", role: "admin" }],
		invitations: [{ role: "contributeur" }],
	} });
	const cookieAlex = prep.comptes.find(c => c.id === "alex").cookie;
	const invitationSam = prep.invitations[0].url;
	const notes = JSON.parse(fs.readFileSync(path.join(RACINE, "site", "examples", "notes_exemple.json"), "utf8"));
	await exiger(U, "POST", "/__test/notes", { corps: { projet: PROJET, nom: "notes_exemple.json", notes } });
	await exiger(U, "POST", `/api/p/${PROJET}/builds`, { brut: fs.readFileSync(path.join(RACINE, "site", "examples", "data.json")), cookie: cookieAlex });
	await exiger(B.url, "POST", "/__test/preparer", { corps: { projet: PROJET, titre: "Jardin B" } });

	cdp = await connecterCdp(await demarrerEdge());
	const camille = await Onglet.ouvrir("camille");

	// 1. Deux hôtes : la page de retours s'ouvre sur l'hôte des pages par le jeton d'entrée.
	etape("Hôte des pages (jeton d'entrée)");
	await camille.aller(`${U}/__test/connexion?projet=${PROJET}&compte=camille&role=mainteneur&nom=Camille&suite=/`);
	ok(await camille.vue("accueil"), "méta-interface : accueil de Camille");
	ok(await camille.texte("#qui") === "Camille", "nom du compte dans l'en-tête");
	ok(await camille.eval(`!!document.querySelector('[data-role=projets] li[data-id="${PROJET}"]')`), "le projet est listé");
	// Étape 3.6 (§ A.2) : le titre du projet ouvre son Wiki ; liens dans l'ordre Wiki · Retours · Kanban · Membres.
	ok(await camille.eval(`document.querySelector('li[data-id="${PROJET}"] h2 a').getAttribute("href") === "/p/${PROJET}/"`), "accueil : le titre du projet mène à son Wiki", await camille.essayer(`document.querySelector('li[data-id="${PROJET}"] h2 a').getAttribute("href")`));
	const liensAccueil = await camille.eval(`[...document.querySelectorAll('li[data-id="${PROJET}"] .liens a')].map(a => a.textContent)`);
	ok(JSON.stringify(liensAccueil) === JSON.stringify(["Wiki", "Retours", "Kanban", "Membres"]), "accueil : liens Wiki · Retours · Kanban · Membres", liensAccueil);
	await camille.relever();
	await camille.cliquer(`li[data-id="${PROJET}"] a[data-role=page-retours]`);
	const surPages = await camille.attendre(`location.host === "localhost:${A.port}" && document.querySelectorAll(".fb-btn").length > 0`, 20000);
	ok(surPages, "la page de retours s'ouvre sur l'hôte des pages (localhost)", await camille.essayer("location.href"));
	ok(!/entree=/.test(await camille.eval("location.href")), "le jeton d'entrée est retiré de l'adresse", await camille.essayer("location.href"));
	const cookies = (await camille.s("Network.getCookies", { urls: [`${A.pages}/p/${PROJET}/`, `${A.pages}/api/p/${PROJET}/session`] })).cookies;
	const cp = cookies.filter(c => c.name === "wdd_pages");
	ok(cp.length === 2 && cp.every(c => c.httpOnly && c.sameSite === "Lax" && c.domain === "localhost") && cp.some(c => c.path === `/p/${PROJET}/`) && cp.some(c => c.path === `/api/p/${PROJET}/`),
		"cookie wdd_pages : deux Path du projet, HttpOnly, SameSite=Lax, hôte seul", cp.map(c => ({ path: c.path, sameSite: c.sameSite, httpOnly: c.httpOnly, domain: c.domain })));
	ok(!cookies.some(c => c.name === "wdd_session"), "aucun wdd_session envoyé à l'hôte des pages");
	const sess = await camille.eval(`fetch("/api/p/${PROJET}/session").then(r => r.json())`);
	ok(sess.nom === "Camille" && sess.role === "mainteneur" && sess.ecriture === true, "page connectée : session de Camille", sess);
	const MARQUE = "Retour écrit depuis l'hôte des pages " + t0;
	await camille.cliquer(`[data-fb-kind="plante"][data-fb-id="courgette"] .fb-btn`);
	await camille.attendre(`!document.querySelector("#fb-panel").hidden`);
	await camille.valeur("#fb-text", MARQUE);
	await camille.cliquer("#fb-send");
	await camille.attendre(`document.querySelector("#fb-status") && document.querySelector("#fb-status").textContent === "Envoyé."`, 10000);
	const apres = await exiger(U, "GET", `/__test/retours?projet=${PROJET}`);
	const ecrit = apres.docs.find(d => d.donnees.text === MARQUE);
	ok(!!ecrit && ecrit.donnees.by === "camille", "un retour écrit depuis la page de l'hôte des pages, signé Camille", ecrit && ecrit.donnees.by);
	const refus = await camille.eval(`Promise.all(["/api/admin/projets", "/api/admin/journal", "/", "/api/moi", "/api/p/${PROJET}/tickets", "/api/p/${PROJET}/membres", "/ui.js"].map(u => fetch(u).then(r => u + " " + r.status)))`);
	ok(refus.every(x => x.endsWith(" 404")), "hôte des pages : /api/admin, méta-interface, tickets, membres → 404", refus);
	await camille.capture("pages-hote-retours");
	await camille.relever();
	const problemesPages = camille.problemes.filter(p => p.url.startsWith(A.pages));
	ok(!problemesPages.some(p => /^CSP/.test(p.texte)), "page de retours : aucune violation de CSP", problemesPages);
	camille.problemes = camille.problemes.filter(p => !p.url.startsWith(A.pages));

	// 1 bis. Étape 3.6 (§ A.2) : bandeau commun en tête du Wiki, rendu par le serveur sur l'hôte des pages.
	etape("Bandeau du Wiki (deux hôtes)");
	const obCamille = await camille.eval(ONGLETS_BANDEAU);
	ok(JSON.stringify(obCamille) === JSON.stringify([`accueil=${U}/#/`, `wiki=/p/${PROJET}/`, `retours=${U}/#/p/${PROJET}/retours`, `kanban=${U}/#/p/${PROJET}/kanban`, `membres=${U}/#/p/${PROJET}/membres`]),
		"bandeau du Wiki : Accueil, puis Wiki · Retours · Kanban · Membres vers l'hôte principal (mainteneur)", obCamille);
	ok(await camille.texte("#wdd-bandeau .wdd-b-nom") === "Camille" && await camille.texte("#wdd-bandeau .wdd-b-titre") === "Jardin", "bandeau : nom de la personne et titre du projet",
		[await camille.texte("#wdd-bandeau .wdd-b-nom"), await camille.texte("#wdd-bandeau .wdd-b-titre")]);
	ok(await camille.eval(`document.querySelector("#wdd-bandeau [data-onglet=wiki]").getAttribute("aria-current") === "page"`), "bandeau : Wiki est l'onglet courant");
	// Lot B : l'onglet Retours du bandeau compte les retours à traiter (en attente + questions), comme le bouton flottant.
	const compteBandeau = `(() => { const fab = document.getElementById("fb-fab"), f = document.getElementById("fb-fab-n"), c = document.querySelector("#wdd-bandeau [data-onglet=retours] .wdd-b-compte"); if (!fab || fab.hidden) return null; return [f.hidden ? "" : f.textContent.split(" ")[0], c ? c.firstChild.textContent : ""]; })()`;
	ok(await camille.attendre(`(() => { const x = ${compteBandeau}; return x && x[0] === x[1]; })()`, 8000), "bandeau : compteur de l'onglet Retours = bouton flottant (à traiter)", await camille.essayer(compteBandeau));
	ok(await camille.eval(`document.getElementById("wdd-bandeau").getBoundingClientRect().bottom <= document.querySelector("header.top").getBoundingClientRect().top && getComputedStyle(document.getElementById("wdd-bandeau")).position === "static"`),
		"bandeau au-dessus de l'en-tête du Wiki, dans le flux (ni fixe ni collant)");
	// La page reste entière sous le bandeau : onglets du gabarit (adresse #…), tiroir des retours.
	await camille.eval(`(() => { const p = document.getElementById("fb-panel"), c = document.getElementById("fb-close"); if (p && !p.hidden && c) c.click(); return 0; })()`);
	const ongletGabarit = await camille.eval(`(() => { const b = [...document.querySelectorAll("nav.tabs button")]; const t = b[b.length - 1]; t.click(); return { selection: t.getAttribute("aria-selected"), hash: location.hash, n: b.length }; })()`);
	ok(ongletGabarit.n > 1 && ongletGabarit.selection === "true" && ongletGabarit.hash.length > 1, "Wiki sous le bandeau : un onglet du gabarit s'ouvre (adresse #… mise à jour)", ongletGabarit);
	await camille.eval(`(() => { document.querySelector("nav.tabs button").click(); window.scrollTo(0, 0); return 0; })()`);
	await sleep(150);
	await camille.capture("wiki-bandeau-clair");
	const fondBandeau = await camille.eval(`getComputedStyle(document.getElementById("wdd-bandeau")).backgroundColor`);
	await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await sleep(200);
	const fondBandeauSombre = await camille.eval(`getComputedStyle(document.getElementById("wdd-bandeau")).backgroundColor`);
	await camille.capture("wiki-bandeau-sombre");
	await camille.largeur(360);
	await camille.capture("wiki-bandeau-360-sombre");
	await camille.largeur(0);
	await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await sleep(200);
	ok(fondBandeau !== fondBandeauSombre && fondBandeau === await camille.eval(`getComputedStyle(document.getElementById("wdd-bandeau")).backgroundColor`), "bandeau : thème sombre selon le système", [fondBandeau, fondBandeauSombre]);
	await verifier360(camille, "wiki-bandeau");
	await camille.relever();
	ok(!camille.problemes.some(p => p.url.startsWith(A.pages)), "Wiki avec son bandeau : aucune violation de CSP ni exception", camille.problemes.filter(p => p.url.startsWith(A.pages)));
	camille.problemes = camille.problemes.filter(p => !p.url.startsWith(A.pages));
	// Lien Kanban du bandeau : l'hôte principal est un autre site (wdd_session SameSite=Strict ne part pas avec le
	// document « / »), mais l'interface est statique et ses requêtes portent le cookie : on arrive connecté.
	await camille.cliquer("#wdd-bandeau [data-onglet=kanban]");
	ok(await camille.attendre(`location.host === "127.0.0.1:${A.port}" && location.hash === "#/p/${PROJET}/kanban" && document.body.dataset.vue === "kanban" && document.body.dataset.charge === "1"`, 20000)
		&& await camille.texte("#qui") === "Camille", "bandeau → Kanban : arrive connecté sur l'hôte principal", await camille.essayer(`location.href + " " + document.body.dataset.vue + " " + (document.getElementById("qui") || {}).textContent`));
	const navProjet = await camille.eval(`[...document.querySelectorAll("#nav-projet li a")].map(a => a.firstChild.textContent + "=" + a.getAttribute("href"))`);
	ok(JSON.stringify(navProjet) === JSON.stringify([`Wiki=/p/${PROJET}/`, `Retours=#/p/${PROJET}/retours`, `Kanban=#/p/${PROJET}/kanban`, `Membres=#/p/${PROJET}/membres`]), "méta-interface : onglets Wiki · Retours · Kanban · Membres", navProjet);
	ok(await camille.eval(`document.querySelector('#nav-projet a[aria-current=page]').firstChild.textContent === "Kanban"`), "méta-interface : Kanban est l'onglet courant");
	// Étape 3.6 (lot B) : compteur des retours à traiter (en attente + questions) sur l'onglet Retours, d'après les retours
	// déjà chargés ; le même nombre que le bouton flottant du Wiki.
	const nNouveauxNav = (await exiger(U, "GET", `/__test/retours?projet=${PROJET}`)).docs.filter(d => d.donnees.status === "nouveau" || d.donnees.status === "question").length;
	ok(await camille.attendre(`(() => { const c = document.querySelector("#nav-projet [data-role=compte-retours]"); return c && (${nNouveauxNav} ? !c.hidden && c.firstChild.textContent === "${nNouveauxNav}" : c.hidden); })()`, 5000),
		"onglet Retours : compteur des retours à traiter", await camille.essayer(`(document.querySelector("#nav-projet [data-role=compte-retours]") || {}).textContent`));
	await camille.relever();
	await camille.cliquer(`#nav-projet a[data-role=page-retours]`);
	ok(await camille.attendre(`location.host === "localhost:${A.port}" && document.getElementById("wdd-bandeau") && document.querySelectorAll(".fb-btn").length > 0`, 20000),
		"onglet Wiki de la méta-interface : le Wiki s'ouvre sur l'hôte des pages, avec son bandeau", await camille.essayer("location.href"));
	// Étape 3.6 (point 19) : #/p/<projet> sans suffixe ouvre le Wiki, comme depuis l'Accueil (et non plus le Kanban).
	await camille.aller(`${U}/#/p/${PROJET}`, `location.host === "localhost:${A.port}" && !!document.getElementById("wdd-bandeau")`);
	ok(await camille.attendre(`location.host === "localhost:${A.port}" && location.pathname === "/p/${PROJET}/" && document.getElementById("wdd-bandeau") && document.querySelectorAll(".fb-btn").length > 0`, 20000),
		"#/p/<projet> ouvre le Wiki du projet (hôte des pages, avec son bandeau)", await camille.essayer("location.href"));

	// 2. Entrée par invitation (Sam, contributeur).
	etape("Entrée par invitation");
	const sam = await Onglet.ouvrir("sam");
	await sam.aller(invitationSam, `document.querySelector("input[name=nom]")`);
	await sam.focus("input[name=nom]");
	await sam.taper("Sam");
	await sam.cliquer("form button");
	const entre = await sam.attendre(`location.host === "localhost:${A.port}" && document.querySelectorAll(".fb-btn").length > 0`, 20000);
	await sam.relever();
	ok(entre, "invitation acceptée : la page de retours s'ouvre sur l'hôte des pages", { url: await sam.essayer("location.href"), csp: sam.problemes.filter(p => /form-action|form data/.test(p.texte)).map(p => p.texte.slice(0, 200)) });
	const obSam = await sam.eval(ONGLETS_BANDEAU);
	ok(JSON.stringify(obSam.map(x => x.split("=")[0])) === JSON.stringify(["accueil", "wiki", "retours", "kanban"]) && await sam.texte("#wdd-bandeau .wdd-b-nom") === "Sam",
		"bandeau du Wiki d'un contributeur : son nom, pas d'onglet Membres", obSam);
	await sam.aller(`${U}/`);
	ok(await sam.vue("accueil"), "méta-interface ouverte par la session de l'invitation");
	ok(await sam.texte("#qui") === "Sam", "compte « Sam » dans l'en-tête");
	ok(/Contributeur/.test(await sam.texte(`li[data-id="${PROJET}"]`)), "rôle contributeur affiché", await sam.texte(`li[data-id="${PROJET}"]`));
	ok(!await sam.eval(`!!document.querySelector('li[data-id="${PROJET}"] a[href$="/membres"]')`), "pas de lien Membres pour un contributeur");
	ok(await sam.eval(`document.getElementById("lien-admin").hidden`), "pas de lien Administration pour Sam");
	await verifier360(sam, "accueil");
	await sam.fermer();

	// 3. Membres : invitation, jeton affiché une fois, réglages.
	etape("Membres");
	await camille.aller(`${U}/#/p/${PROJET}/membres`);
	ok(await camille.vue("membres"), "vue Membres");
	ok(await camille.attendre(`[...document.querySelectorAll("table[data-role=membres] tr[data-compte]")].some(t => t.cells[0].textContent.startsWith("Sam"))`), "Sam figure parmi les membres");
	// Rôle : une flèche sur la liste fermée n'écrit rien ; « Changer » écrit, puis le focus revient à la liste.
	// Le compte de Sam a un id tiré au hasard (créé par l'invitation) : lu dans le tableau.
	const idSam = await camille.eval(`[...document.querySelectorAll("table[data-role=membres] tr[data-compte]")].find(t => t.cells[0].textContent.startsWith("Sam")).dataset.compte`);
	const roleSam = async () => (await exiger(U, "GET", `/api/p/${PROJET}/membres`, { cookie: cookieAlex })).membres.find(m => m.compte === idSam).role;
	await camille.focus(`select[data-compte="${idSam}"]`);
	await camille.touche("ArrowDown");
	await sleep(500);
	const apresFleche = await roleSam();
	ok(apresFleche === "contributeur" && await camille.eval(`!document.querySelector('[data-role=changer-role][data-compte="${idSam}"]').disabled`), "membres : une flèche sur la liste des rôles n'écrit rien (« Changer » à confirmer)", apresFleche);
	await camille.cliquer(`[data-role=changer-role][data-compte="${idSam}"]`);
	ok(await camille.attendre(`/Sam : Mainteneur/.test(document.body.textContent)`) && await roleSam() === "mainteneur", "membres : « Changer » écrit le rôle choisi");
	ok(await camille.attendre(`document.activeElement && document.activeElement.localName === "select" && document.activeElement.dataset.compte === ${JSON.stringify(idSam)}`, 3000), "membres : le focus revient à la liste des rôles de la ligne", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	await camille.valeur(`select[data-compte="${idSam}"]`, "contributeur");
	await camille.cliquer(`[data-role=changer-role][data-compte="${idSam}"]`);
	ok(await camille.attendre(`/Sam : Contributeur/.test(document.body.textContent)`) && await roleSam() === "contributeur", "membres : Sam remis contributeur");
	await camille.cliquer("form[data-role=form-invitation] button[type=submit]");
	ok(await camille.attendre(`/\\/invitation\\/[A-Za-z0-9_-]{20,}$/.test((document.querySelector("[data-role=lien-invitation]") || {}).value || "")`), "invitation créée : lien à copier affiché",
		await camille.essayer(`(document.querySelector("[data-role=lien-invitation]") || {}).value`));
	const lienInvitation = await camille.eval(`document.querySelector("[data-role=lien-invitation]").value`);
	ok(await camille.attendre(`document.querySelectorAll("[data-role=invitations] li[data-id]").length === 1`), "invitation en attente listée (celle de Sam est utilisée)");
	await camille.valeur("#jet-nom", "Agent de Camille");
	await camille.cliquer("form[data-role=form-jeton] button[type=submit]");
	await camille.attendre(`(document.querySelector("[data-role=valeur-jeton]") || {}).value`);
	const jeton = await camille.eval(`document.querySelector("[data-role=valeur-jeton]").value`);
	ok(/^[A-Za-z0-9_-]{20,}$/.test(jeton), "jeton créé : valeur affichée");
	ok(/pour Camille/.test(await camille.texte("[data-role=jeton-cree]")), "le jeton est signé « Agent de Camille · pour Camille »", await camille.texte("[data-role=jeton-cree]"));
	const sj = await appel(U, "GET", `/api/p/${PROJET}/session`, { bearer: jeton });
	ok(sj.status === 200 && sj.corps.pour && sj.corps.pour.nom === "Camille", "le jeton marche (Bearer) et a pour propriétaire Camille", sj.corps);
	ok(await camille.attendre(`[...document.querySelectorAll("table[data-role=jetons] tr")].some(t => /Agent de Camille/.test(t.textContent) && /Camille/.test(t.cells[2].textContent))`), "jeton listé avec son propriétaire");
	await verifier360(camille, "membres");
	await camille.hash(`#/p/${PROJET}/retours`, "retours");
	await camille.hash(`#/p/${PROJET}/membres`, "membres");
	ok(!await camille.eval(`!!document.querySelector("[data-role=valeur-jeton]")`) && !await camille.eval(`document.body.textContent.includes(${JSON.stringify(jeton)})`), "la valeur du jeton n'est plus affichée ensuite");
	ok(!await camille.eval(`!!document.querySelector("[data-role=lien-invitation]") || [...document.querySelectorAll("input")].some(i => i.value.includes(${JSON.stringify(lienInvitation)})) || document.body.textContent.includes(${JSON.stringify(lienInvitation)})`), "le lien d'invitation n'est plus affiché ensuite");
	// Réglages : deux disciplines et le lien des commits.
	for (const [nom, lib] of [["programmation", "Programmation"], ["ihm", "IHM"]]) {
		await camille.cliquerTexte("form[data-role=form-reglages] button", "Ajouter une discipline");
		await camille.eval(`(() => { const l = document.querySelector("[data-role=disciplines]").lastElementChild; l.querySelector("[data-role=disc-nom]").value = ${JSON.stringify(nom)}; l.querySelector("[data-role=disc-libelle]").value = ${JSON.stringify(lib)}; })()`);
	}
	await camille.valeur("#reg-url", "https://git.exemple/{depot}/commit/{hash}");
	await camille.cliquer("form[data-role=form-reglages] button[type=submit]");
	ok(await camille.attendre(`/Réglages enregistrés/.test(document.querySelector("form[data-role=form-reglages]").textContent)`), "réglages enregistrés");
	const reg = await exiger(U, "GET", `/api/p/${PROJET}/reglages`, { cookie: cookieAlex });
	ok(reg.disciplines.map(d => d.nom).join(",") === "programmation,ihm" && reg.url_commit === "https://git.exemple/{depot}/commit/{hash}", "réglages écrits dans site.json", reg);

	// 4. Retours → ticket depuis deux retours, description piégée.
	etape("Retours et création d'un ticket");
	ok(await camille.hash(`#/p/${PROJET}/retours`, "retours"), "vue Retours");
	ok(await camille.attendre(`document.querySelectorAll("table[data-role=retours] tbody tr[data-id]").length === 4`), "quatre retours listés");
	ok(/<img src=x onerror/.test(await camille.texte(`tr[data-id="r1"] .texte-retour`)) && await camille.eval(`document.querySelectorAll("img").length === 0`), "texte d'un retour piégé affiché comme du texte");
	await camille.valeur("#r-statut", "fait");
	ok(await camille.attendre(`document.querySelectorAll("table[data-role=retours] tbody tr[data-id]").length === 1`), "filtre par statut (fait : 1 retour)");
	await camille.valeur("#r-statut", "");
	await camille.valeur("#r-texte", "jaunissent");
	ok(await camille.attendre(`document.querySelectorAll("table[data-role=retours] tbody tr[data-id]").length === 1`), "filtre par texte");
	await camille.valeur("#r-texte", "");
	await camille.attendre(`document.querySelectorAll("table[data-role=retours] tbody tr[data-id]").length === 4`);
	await verifier360(camille, "retours");
	await camille.cliquer("#sel-r1");
	await camille.cliquer("#sel-r2");
	await camille.cliquerTexte(".barre button", "Créer un ticket");
	ok(await camille.attendre(`document.querySelector("form[data-role=nouveau-ticket]")`), "dialogue « Créer un ticket » ouvert");
	const titrePropose = await camille.eval(`document.querySelector("#nt-titre-champ").value`);
	ok(titrePropose.startsWith("Tomate : Les feuilles jaunissent"), "titre proposé à partir du premier retour", titrePropose);
	ok(await camille.eval(`document.querySelectorAll("[data-role=retours-lies] li").length === 2`), "deux retours pré-remplis");
	ok(await camille.eval(`document.querySelector("#nt-pages").value`) === "plante:tomate, plante:courgette", "pages pré-remplies", await camille.essayer(`document.querySelector("#nt-pages").value`));
	// Gras, italique, citation et adresse nue aussi : un « **x** » figeait l'onglet (expression partagée de markdown.js).
	const PIEGE = "# Titre piégé\nTexte <img src=x onerror=\"window.__xss=1\"> et <script>window.__xss=2</script>\n\n- [clic](javascript:window.__xss=3)\n- [doc](https://exemple.org/doc)\n\n`code <b>gras</b>`\n\n```\n<img src=y onerror=window.__xss=4>\n```\n\n" +
		"Un mot en **gras**, un *italique* et **[lien gras](https://exemple.org/gras)**.\n\n> Citation avec https://exemple.org/nue.";
	await camille.focus("#nt-description");
	await camille.eval(`document.querySelector("#nt-description").select()`);
	await camille.taper(PIEGE);
	await camille.valeur("#nt-discipline", "programmation");
	await camille.focus("#nt-criteres");
	await camille.taper("Les feuilles restent vertes");
	await camille.cliquer("form[data-role=nouveau-ticket] button[type=submit]");
	ok(await camille.attendre(`location.hash === "#/p/${PROJET}/t/T-1" && document.body.dataset.vue === "ticket" && document.body.dataset.charge === "1" && document.querySelector("[data-role=titre]")`), "ticket T-1 créé, vue Ticket ouverte");
	const t1 = (await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex })).donnees;
	ok(t1.retours.join(",") === "r1,r2" && t1.pages.join(",") === "plante:tomate,plante:courgette" && t1.discipline === "programmation" && t1.description === PIEGE && t1.criteres.length === 1, "T-1 : retours, pages, discipline, description, critère", t1);

	// 5. Échappement.
	etape("Échappement de la description");
	const x = JSON.parse(await camille.eval(`JSON.stringify((() => { const d = document.querySelector("[data-role=description]"); return {
		img: document.querySelectorAll("img").length, script: d.querySelectorAll("script").length,
		js: d.querySelectorAll('a[href^="javascript" i]').length, doc: [...d.querySelectorAll("a")].map(a => a.getAttribute("href")),
		h3: (d.querySelector("h3") || {}).textContent, li: d.querySelectorAll("li").length, code: [...d.querySelectorAll("code")].map(c => c.textContent),
		gras: [...d.querySelectorAll("strong")].map(e => e.textContent), em: [...d.querySelectorAll("em")].map(e => e.textContent), citation: (d.querySelector("blockquote") || {}).textContent,
		texte: d.textContent, xss: [window.__xss, window.__xssRetour], titre: document.querySelector("h1").textContent }; })())`));
	ok(x.img === 0 && x.script === 0, "aucune balise img ni script créée par la description", x);
	ok(x.js === 0 && x.doc.join(" ") === "https://exemple.org/doc https://exemple.org/gras https://exemple.org/nue", "lien javascript: rendu en texte, liens https gardés (dont adresse nue)", x.doc);
	ok(x.gras.join("|") === "gras|lien gras" && x.em.join("|") === "italique" && x.citation === "Citation avec https://exemple.org/nue.", "gras, italique (lien dans du gras) et citation rendus une seule fois", { gras: x.gras, em: x.em, citation: x.citation });
	ok(x.texte.includes("[clic](javascript:window.__xss=3)"), "le lien javascript: reste visible comme texte");
	ok(x.texte.includes('<img src=x onerror="window.__xss=1">') && x.texte.includes("<script>"), "le HTML de la description est affiché comme du texte");
	ok(x.h3 === "Titre piégé" && x.li === 2 && x.code.includes("code <b>gras</b>") && x.code.some(c => c.includes("<img src=y")), "titre, liste et code rendus", x);
	ok(x.xss[0] == null && x.xss[1] == null, "aucun script injecté ne s'est exécuté", x.xss);
	ok(x.titre.includes("<img src=x onerror"), "titre du ticket (venu d'un retour piégé) affiché comme du texte");
	ok(/Tomate/.test(await camille.texte("[data-role=retours-lies]")) && /Courgette/.test(await camille.texte("[data-role=retours-lies]")), "retours liés affichés");
	ok(await camille.eval(`[...document.querySelectorAll("[data-role=retours-lies] a")].some(a => a.getAttribute("href") === "/p/${PROJET}/#plantes--tomate")`), "lien vers l'élément sur la page de retours");
	await camille.hash(`#/p/${PROJET}/retours`, "retours");
	ok(await camille.attendre(`(document.querySelector('tr[data-id="r1"] [data-role=tickets-cites]') || {}).textContent === "T-1"`), "vue Retours : T-1 cite le retour r1");

	// 6. Kanban : couloirs, direct, clavier.
	etape("Kanban");
	ok(await camille.hash(`#/p/${PROJET}/kanban`, "kanban"), "vue Kanban");
	ok(await camille.eval(`!!document.querySelector('.couloir[data-discipline="programmation"] .colonne[data-statut="a-faire"] .carte[data-id="T-1"]')`), "T-1 dans le couloir Programmation, colonne À faire");
	ok(await camille.eval(`document.querySelectorAll(".couloir").length >= 2`), "couloirs par discipline");
	// Étape 3.5 (§ 8.4, D1) : la phrase à dire à son agent, pour un mainteneur, avec l'hôte principal et le projet.
	const PHRASE = `Branche ce dépôt sur le serveur de retours ${U} (projet ${PROJET}) avec la CLI outil : lance outil methode et suis le § 0.`;
	ok(await camille.eval(`(() => { const b = document.querySelector("details[data-role=branchement]"); return !!b && b.open && /Brancher un dépôt de code/.test(b.querySelector("summary").textContent) && b.getClientRects().length > 0; })()`),
		"Kanban (mainteneur) : bloc « Brancher un dépôt de code » visible, ouvert");
	const phraseLue = await camille.texte("[data-role=phrase-branchement]");
	ok(phraseLue.includes(U) && phraseLue.includes(`(projet ${PROJET})`), "bloc de branchement : la phrase contient l'URL de l'hôte principal et le projet", phraseLue);
	ok(phraseLue === PHRASE, "bloc de branchement : la phrase exacte (CLI outil, outil methode, § 0)", phraseLue);
	ok(/CLI « outil » dans le PATH/.test(await camille.texte("details[data-role=branchement]")), "bloc de branchement : la CLI dans le PATH est dite");
	await camille.cliquer("[data-role=copier-branchement]");
	ok(await camille.attendre(`/^(Copié\\.|Sélectionné : copie avec Ctrl\\+C\\.)$/.test(document.querySelector("[data-role=etat-copie]").textContent)`, 5000)
		&& await camille.eval(`String(getSelection()) === ${JSON.stringify(PHRASE)}`), "bloc de branchement : Copier (presse-papiers, ou phrase sélectionnée)", await camille.texte("[data-role=etat-copie]"));
	await exiger(U, "POST", `/api/p/${PROJET}/tickets`, { cookie: cookieAlex, corps: { titre: "Ticket créé ailleurs" } });
	ok(await camille.attendre(`document.querySelector('.carte[data-id="T-2"]')`, 8000), "mise à jour en direct : T-2 apparaît sans recharger");
	// L'agent de Camille (jeton créé plus haut) prend T-2 : signé « Agent de Camille · pour Camille ».
	await exiger(U, "POST", `/api/p/${PROJET}/tickets/T-2/prendre`, { bearer: jeton, corps: { version: 1 } });
	ok(await camille.attendre(`(document.querySelector('.colonne[data-statut="pris"] .carte[data-id="T-2"] [data-role=preneur]') || {}).textContent === "Pris par Agent de Camille · pour Camille"`, 8000),
		"carte : preneur « Agent de Camille · pour Camille »", await camille.texte(`.carte[data-id="T-2"] [data-role=preneur]`));
	await camille.focus(`[data-cle="deplacer-T-1"]`);
	await camille.touche("Enter");
	ok(await camille.attendre(`document.activeElement && document.activeElement.getAttribute("role") === "menuitem"`), "Entrée ouvre le menu « Déplacer vers… », focus sur la première action");
	ok(await camille.eval(`document.activeElement.textContent`) === "Pris", "première action : Pris", await camille.essayer("document.activeElement.textContent"));
	await camille.touche("Escape");
	ok(await camille.eval(`document.activeElement.dataset.cle === "deplacer-T-1" && !document.querySelector("[role=menu]")`), "Échap ferme le menu et rend le focus au bouton");
	await camille.touche("Enter");
	await camille.touche("Enter");
	ok(await camille.attendre(`document.querySelector('.colonne[data-statut="pris"] .carte[data-id="T-1"]')`, 8000), "au clavier : T-1 déplacé vers Pris");
	ok(await camille.attendre(`document.activeElement && document.activeElement.dataset.cle === "deplacer-T-1"`, 3000), "le focus reste sur le bouton de la carte déplacée", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	ok(/Camille/.test(await camille.texte(`.carte[data-id="T-1"] [data-role=preneur]`)), "preneur affiché sur la carte");
	await camille.touche("ArrowDown");
	ok(await camille.attendre(`document.activeElement && document.activeElement.getAttribute("role") === "menuitem"`), "flèche bas ouvre aussi le menu");
	const choix = await camille.eval(`[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(b => b.textContent)`);
	ok(choix.join(",") === "À faire,En revue,Fait", "depuis Pris : À faire, En revue, Fait", choix);
	await camille.touche("ArrowDown");
	ok(await camille.eval(`document.activeElement.textContent`) === "En revue", "flèche bas : En revue");
	await camille.touche("Enter");
	ok(await camille.attendre(`document.querySelector('.colonne[data-statut="en-revue"] .carte[data-id="T-1"]')`, 8000), "au clavier : T-1 déplacé vers En revue");
	const t1b = (await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex })).donnees;
	ok(t1b.statut === "en-revue" && t1b.pris_par && t1b.pris_par.nom === "Camille", "serveur : T-1 en revue, pris par Camille", { statut: t1b.statut, pris_par: t1b.pris_par });
	await camille.cliquer("#f-amoi");
	ok(await camille.attendre(`document.querySelector('.carte[data-id="T-1"]') && !document.querySelector('.carte[data-id="T-2"]')`), "filtre « à moi »");
	await camille.cliquer("#f-amoi");
	await camille.valeur("#f-discipline", "-");
	ok(await camille.attendre(`!document.querySelector('.carte[data-id="T-1"]') && document.querySelector('.carte[data-id="T-2"]')`), "filtre discipline (sans discipline)");
	await camille.valeur("#f-discipline", "");
	await camille.attendre(`document.querySelector('.carte[data-id="T-1"]') && document.querySelector('.carte[data-id="T-2"]')`);
	await camille.capture("kanban-clair");
	await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await sleep(200);
	const fonds = await camille.eval(`getComputedStyle(document.body).backgroundColor`);
	await camille.capture("kanban-sombre");
	await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await sleep(200);
	ok(fonds !== await camille.eval(`getComputedStyle(document.body).backgroundColor`), "thème sombre selon le système", fonds);
	await verifier360(camille, "kanban");
	// Un filtre gardé d'un projet à l'autre ne doit pas vider le Kanban du second ; un fragment mal formé non plus.
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: "verger", titre: "Verger", comptes: [{ id: "camille", nom: "Camille", role: "mainteneur" }] } });
	await exiger(U, "POST", "/api/p/verger/tickets", { cookie: cookieAlex, corps: { titre: "Tailler les pommiers" } });
	await camille.valeur("#f-discipline", "programmation");
	ok(await camille.hash("#/p/verger/kanban", "kanban") && await camille.attendre(`document.querySelector('.carte[data-id="T-1"]') && /Tailler/.test(document.querySelector('.carte[data-id="T-1"]').textContent)`), "autre projet : son Kanban s'affiche malgré le filtre du premier");
	await camille.eval(`location.hash = "#/%"`);
	ok(await camille.attendre(`document.body.dataset.vue === "introuvable" && /introuvable/.test(document.querySelector("h1").textContent)`), "fragment mal formé : page introuvable, sans erreur");
	await camille.hash(`#/p/${PROJET}/kanban`, "kanban");
	await camille.valeur("#f-discipline", "");

	// 7. Ticket : commit lié, 409 sans perte de saisie, fermeture.
	etape("Ticket : commit, 409, fermeture");
	ok(await camille.hash(`#/p/${PROJET}/t/T-1`, "ticket"), "vue Ticket T-1");
	await camille.cliquer("#crit-0");
	ok(await camille.attendre(`document.querySelector("#crit-0") && document.querySelector("#crit-0").checked && /Critère coché/.test(document.body.textContent)`, 8000), "critère coché dans la vue Ticket");
	ok((await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex })).donnees.criteres[0].fait === true, "serveur : critère fait");
	await camille.valeur("#ac-hash", "411d036");
	await camille.valeur("#ac-message", "T-1 : arrosage");
	await camille.cliquer("form[data-role=ajout-commit] button[type=submit]");
	ok(await camille.attendre(`(document.querySelector('[data-role=commits] a[data-hash="411d036"]') || {}).href === "https://git.exemple/code/commit/411d036"`, 8000), "commit lié avec son lien (url_commit)");
	ok(await camille.attendre(`document.querySelectorAll("[data-role=historique] li").length >= 4`), "historique du ticket (git log)", await camille.texte("[data-role=historique]"));
	await camille.cliquerTexte("[data-role=actions] button", "Modifier");
	ok(await camille.attendre(`document.querySelector("form[data-role=modifier]")`), "formulaire de modification ouvert");
	await camille.focus(`form[data-role=modifier] textarea[data-champ=description]`, true);
	const SAISIE = "\n\nSaisie à garder.";
	await camille.taper(SAISIE);
	const v = await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex });
	await exiger(U, "PATCH", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex, corps: { version: v.version, champs: { titre: "Titre changé par Alex" } } });
	ok(await camille.attendre(`document.querySelector("[data-role=titre]").textContent === "Titre changé par Alex"`, 8000), "la modification d'Alex arrive en direct pendant la saisie");
	ok((await camille.eval(`document.querySelector("form[data-role=modifier] textarea[data-champ=description]").value`)).endsWith(SAISIE), "la saisie n'est pas écrasée par le direct");
	await camille.cliquer("form[data-role=modifier] button[type=submit]");
	ok(await camille.attendre(`/Quelqu'un a modifié ce ticket entre-temps/.test((document.querySelector("form[data-role=modifier] .message.erreur") || {}).textContent || "")`, 8000), "409 : « Quelqu'un a modifié ce ticket entre-temps »");
	ok((await camille.eval(`document.querySelector("form[data-role=modifier] textarea[data-champ=description]").value`)).endsWith(SAISIE), "409 : la saisie est gardée");
	ok(await camille.eval(`document.querySelector("form[data-role=modifier] input[data-champ=titre]").value`) === "Titre changé par Alex", "409 : ticket rechargé (champ non touché à jour)");
	await camille.capture("ticket-409");
	await camille.cliquer("form[data-role=modifier] button[type=submit]");
	ok(await camille.attendre(`!document.querySelector("form[data-role=modifier]")`, 8000), "nouvel enregistrement accepté");
	const t1c = (await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-1`, { cookie: cookieAlex })).donnees;
	ok(t1c.titre === "Titre changé par Alex" && t1c.description === PIEGE + SAISIE, "serveur : titre d'Alex gardé, description de Camille enregistrée", { titre: t1c.titre });
	await verifier360(camille, "ticket");
	await camille.cliquerTexte("[data-role=actions] button", "Fermer…");
	ok(await camille.attendre(`document.querySelector("dialog[data-role=fermer][open]")`), "dialogue de fermeture ouvert");
	ok(await camille.eval(`document.querySelectorAll("dialog[data-role=fermer] input[type=checkbox][data-id]:checked").length === 2`), "les deux retours liés sont cochés par défaut");
	const rep = await camille.eval(`document.querySelector("#fr-reponse").value`);
	ok(rep === "Réglé par T-1 (commit 411d036).", "réponse par défaut proposée", rep);
	await camille.capture("ticket-fermer");
	await camille.cliquer("dialog[data-role=fermer] button[type=submit]");
	ok(await camille.attendre(`!document.querySelector("dialog[data-role=fermer]") && (document.querySelector("[data-role=statut]") || {}).textContent === "Fait"`, 8000), "ticket fermé (Fait)");
	const fin = await exiger(U, "GET", `/__test/retours?projet=${PROJET}`);
	const r1 = fin.docs.find(d => d.id === "r1").donnees, r2 = fin.docs.find(d => d.id === "r2").donnees;
	ok(r1.status === "fait" && r2.status === "fait" && r1.reply === rep && r2.reply === rep, "les retours liés sont passés à « fait » avec la réponse", { r1: r1.status, r2: r2.status });
	await camille.hash(`#/p/${PROJET}/kanban`, "kanban");
	ok(await camille.attendre(`document.querySelector('.colonne[data-statut="fait"] .carte[data-id="T-1"]')`), "Kanban : T-1 dans Fait");
	ok(await camille.texte(`.carte[data-id="T-1"] [data-role=preneur]`) === "Fait par Camille", "carte d'un ticket fermé : « Fait par … », pas « Pris par »", await camille.texte(`.carte[data-id="T-1"] [data-role=preneur]`));

	// 7 bis. Clavier, focus, rôle relu, fermeture robuste (défauts de la relecture).
	etape("Clavier, focus et rôles");
	await camille.focus("a.evitement");
	await camille.touche("Enter");
	ok(await camille.attendre(`document.activeElement && document.activeElement.id === "principal"`, 3000) && await camille.eval(`location.hash === "#/p/${PROJET}/kanban" && document.body.dataset.vue === "kanban"`),
		"« Aller au contenu » : focus sur le contenu, la vue reste (pas de « Page introuvable »)", await camille.essayer(`location.hash + " " + document.body.dataset.vue`));
	// Témoin du banc : un console.error de la page est bien relevé (puis retiré du bilan).
	await camille.eval(`console.error("TEMOIN console.error"); 0`);
	await sleep(300);
	ok(camille.problemes.some(p => p.texte.includes("TEMOIN console.error")), "banc : un console.error de la page est relevé");
	camille.problemes = camille.problemes.filter(p => !p.texte.includes("TEMOIN console.error"));
	// Kanban : le focus sur le titre d'une carte reste pendant une mise à jour en direct.
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: PROJET, retours: [
		{ id: "r4", donnees: { kind: "plante", ref: "radis", name: "Radis", cat: "bug", text: "Semis trop serré.", by: "camille" } },
		{ id: "r5", donnees: { kind: "plante", ref: "navet", name: "Navet", cat: "idee", text: "Ajouter le navet.", by: "camille" } }] } });
	await camille.focus(`.carte[data-id="T-2"] h3 a`);
	await exiger(U, "POST", `/api/p/${PROJET}/tickets`, { cookie: cookieAlex, corps: { titre: "Ticket du focus", retours: ["r4", "r5"], criteres: ["premier", "second"] } });
	ok(await camille.attendre(`document.querySelector('.carte[data-id="T-3"]')`, 8000), "T-3 arrive en direct");
	ok(await camille.eval(`document.activeElement === document.querySelector('.carte[data-id="T-2"] h3 a')`), "Kanban : le focus reste sur le titre de la carte après une mise à jour en direct", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	// Vue Ticket : « Prendre » au clavier, puis un critère à l'Espace ; le focus n'est jamais perdu.
	ok(await camille.hash(`#/p/${PROJET}/t/T-3`, "ticket"), "vue Ticket T-3");
	await camille.eval(`[...document.querySelectorAll("[data-role=actions] button")].find(b => b.textContent === "Prendre").focus()`);
	await camille.touche("Enter");
	ok(await camille.attendre(`(document.querySelector("[data-role=statut]") || {}).textContent === "Pris"`, 8000), "T-3 pris au clavier");
	// Lot B : sur la vue Ticket, l'onglet Kanban est marqué comme parent (aria-current="true", pas "page").
	ok(await camille.eval(`(() => { const l = [...document.querySelectorAll("#nav-projet a[aria-current]")]; return l.length === 1 && l[0].firstChild.textContent === "Kanban" && l[0].getAttribute("aria-current") === "true"; })()`), "vue Ticket : Kanban marqué comme onglet parent");
	ok(await camille.attendre(`document.activeElement && document.activeElement.localName === "button" && !!document.activeElement.closest("[data-role=actions]")`, 3000), "après « Prendre » (bouton disparu), le focus va sur une action", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	await camille.focus("#crit-1");
	await camille.touche("Space");
	ok(await camille.attendre(`document.querySelector("#crit-1").checked && /Critère coché/.test(document.body.textContent)`, 8000), "critère coché à l'Espace");
	ok((await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-3`, { cookie: cookieAlex })).donnees.criteres[1].fait === true, "serveur : critère 2 de T-3 fait");
	ok(await camille.attendre(`document.activeElement && document.activeElement.id === "crit-1"`, 3000), "le focus reste sur la case cochée", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	const v3 = await exiger(U, "GET", `/api/p/${PROJET}/tickets/T-3`, { cookie: cookieAlex });
	await exiger(U, "PATCH", `/api/p/${PROJET}/tickets/T-3`, { cookie: cookieAlex, corps: { version: v3.version, champs: { titre: "Ticket du focus (changé par Alex)" } } });
	ok(await camille.attendre(`/changé par Alex/.test(document.querySelector("[data-role=titre]").textContent)`, 8000) && await camille.eval(`document.activeElement && document.activeElement.id === "crit-1"`),
		"vue Ticket : le focus reste sur la case pendant une mise à jour en direct", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	// Fermeture : un retour supprimé pendant que le dialogue est ouvert est décoché et signalé ; la fermeture passe ensuite.
	await camille.cliquerTexte("[data-role=actions] button", "Fermer…");
	ok(await camille.attendre(`document.querySelectorAll("dialog[data-role=fermer][open] input[type=checkbox][data-id]:checked").length === 2`), "dialogue de fermeture de T-3 : deux retours cochés");
	const sup = await appel(U, "DELETE", `/api/p/${PROJET}/retours/r5?version=1`, { cookie: cookieAlex });
	await sleep(1000);
	await camille.cliquer("dialog[data-role=fermer] button[type=submit]");
	ok(sup.status === 204 && await camille.attendre(`/supprimé entre-temps/.test(document.querySelector("dialog[data-role=fermer] .message").textContent) && !document.querySelector("dialog[data-role=fermer] button[type=submit]").disabled && document.querySelector("#fr-r5").disabled && !document.querySelector("#fr-r5").checked`, 5000),
		"fermeture : retour supprimé pendant le dialogue décoché et signalé, bouton actif", { suppression: sup.status, texte: await camille.texte("dialog[data-role=fermer] .message") });
	await camille.cliquer("dialog[data-role=fermer] button[type=submit]");
	ok(await camille.attendre(`!document.querySelector("dialog[data-role=fermer]") && (document.querySelector("[data-role=statut]") || {}).textContent === "Fait"`, 8000), "fermeture ensuite acceptée (T-3 fait)");
	ok((await exiger(U, "GET", `/__test/retours?projet=${PROJET}`)).docs.find(d => d.id === "r4").donnees.status === "fait", "r4 passé à « fait »");
	// Confirmation d'un geste destructeur : le focus est sur « Annuler » ; Entrée ne supprime rien.
	ok(await camille.hash(`#/p/${PROJET}/t/T-2`, "ticket"), "vue Ticket T-2");
	await camille.cliquerTexte("[data-role=actions] button", "Supprimer");
	ok(await camille.attendre(`document.querySelector("dialog[data-role=confirmer][open]") && document.activeElement.textContent === "Annuler"`, 3000), "confirmation « Supprimer » : focus sur « Annuler »", await camille.essayer("document.activeElement.textContent"));
	await camille.touche("Enter");
	const confirmationFermee = await camille.attendre(`!document.querySelector("dialog[data-role=confirmer]")`, 3000);
	await sleep(1000);   // une suppression lancée par Entrée aurait le temps d'aboutir
	ok(confirmationFermee && (await appel(U, "GET", `/api/p/${PROJET}/tickets/T-2`, { cookie: cookieAlex })).status === 200, "Entrée dans la confirmation : T-2 n'est pas supprimé");
	// Rôle relu : Camille perd le rôle de mainteneur sur verger pendant que le projet est ouvert.
	ok(await camille.hash("#/p/verger/t/T-1", "ticket") && await camille.attendre(`[...document.querySelectorAll("[data-role=actions] button")].some(b => b.textContent === "Supprimer")`), "verger : Camille mainteneuse voit « Supprimer »");
	await exiger(U, "PUT", "/api/p/verger/membres/camille", { cookie: cookieAlex, corps: { role: "contributeur" } });
	await camille.hash("#/p/verger/kanban", "kanban");
	ok(await camille.attendre(`!document.querySelector('#nav-projet a[href$="/membres"]')`, 5000), "rôle relu en changeant de vue : plus de lien Membres");
	ok(await camille.hash("#/p/verger/t/T-1", "ticket") && await camille.attendre(`![...document.querySelectorAll("[data-role=actions] button")].some(b => b.textContent === "Supprimer")`, 5000), "rôle relu : plus de bouton « Supprimer »");
	// Rôle relu après un 403 : rendue mainteneuse, puis rétrogradée pendant qu'elle regarde le ticket.
	await exiger(U, "PUT", "/api/p/verger/membres/camille", { cookie: cookieAlex, corps: { role: "mainteneur" } });
	await camille.hash("#/p/verger/kanban", "kanban");
	ok(await camille.hash("#/p/verger/t/T-1", "ticket") && await camille.attendre(`[...document.querySelectorAll("[data-role=actions] button")].some(b => b.textContent === "Supprimer")`, 5000), "de nouveau mainteneuse : « Supprimer » revient");
	await exiger(U, "PUT", "/api/p/verger/membres/camille", { cookie: cookieAlex, corps: { role: "contributeur" } });
	await camille.cliquerTexte("[data-role=actions] button", "Supprimer");
	await camille.attendre(`document.querySelector("dialog[data-role=confirmer][open]")`, 3000);
	await camille.cliquer("dialog[data-role=confirmer] button.danger");
	ok(await camille.attendre(`/mainteneur/.test((document.querySelector(".message.erreur") || {}).textContent || "") && ![...document.querySelectorAll("[data-role=actions] button")].some(b => b.textContent === "Supprimer")`, 5000),
		"403 : message du serveur, rôle relu, « Supprimer » disparaît", await camille.texte(".message.erreur"));
	ok((await appel(U, "GET", "/api/p/verger/tickets/T-1", { cookie: cookieAlex })).status === 200, "verger : T-1 n'est pas supprimé");

	// 8. Administration.
	etape("Administration");
	// Une entrée de journal sur verger, pour que le filtre par projet ait quelque chose à retirer.
	await exiger(U, "POST", "/api/p/verger/invitations", { cookie: cookieAlex, corps: { role: "lecteur" } });
	const alex = await Onglet.ouvrir("alex");
	await alex.aller(`${U}/__test/connexion?projet=${PROJET}&compte=alex&role=admin&nom=Alex&suite=/`);
	await alex.vue("accueil");
	ok(!await alex.eval(`document.getElementById("lien-admin").hidden`), "lien Administration pour un admin");
	ok(await alex.hash("#/admin", "admin"), "vue Administration");
	ok(await alex.attendre(`document.querySelectorAll("table[data-role=journal] tbody tr[data-action]").length > 0`), "journal affiché");
	const actions = await alex.eval(`[...new Set([...document.querySelectorAll("table[data-role=journal] tr[data-action]")].map(t => t.dataset.action))]`);
	ok(["jeton créé", "invitation créée", "invitation utilisée", "réglages changés"].every(a => actions.includes(a)), "journal : jeton créé, invitation créée et utilisée, réglages changés", actions);
	ok(!await alex.eval(`document.body.textContent.includes(${JSON.stringify(jeton)})`), "le journal n'affiche pas le jeton");
	ok(await alex.eval(`[...document.querySelectorAll("table[data-role=comptes] tr[data-compte]")].some(t => t.cells[0].textContent.startsWith("Sam"))`), "comptes : Sam listé");
	ok(/isolés/.test(await alex.texte("[data-role=bandeau-isolement]")), "bandeau : Wikis isolés sur un autre hôte", await alex.texte("[data-role=bandeau-isolement]"));
	const lignesJournal = `[...document.querySelectorAll("table[data-role=journal] tbody tr[data-action]")]`;
	ok(await alex.attendre(`${lignesJournal}.some(t => t.cells[3].textContent === "verger")`), "journal sans filtre : des lignes de verger");
	await alex.valeur("#aj-projet", PROJET);
	ok(await alex.attendre(`${lignesJournal}.length > 0 && ${lignesJournal}.every(t => t.cells[3].textContent === "${PROJET}")`), "journal filtré par projet : verger disparaît");
	await alex.valeur("#aj-projet", "");
	ok(await alex.attendre(`${lignesJournal}.some(t => t.cells[3].textContent === "verger")`), "journal : « Tous » remet verger");
	await alex.capture("admin");
	await verifier360(alex, "admin");
	await alex.fermer();
	const alexB = await Onglet.ouvrir("alex-b");
	await alexB.aller(`${B.url}/__test/connexion?projet=${PROJET}&compte=alex&role=admin&nom=Alex&suite=/`);
	await alexB.vue("accueil");
	ok(/même origine que l'administration/.test(await alexB.texte("[data-role=bandeau-isolement]")), "sans WDD_URL_PAGES : bandeau « même origine » à l'accueil de l'admin");
	ok(await alexB.hash("#/admin", "admin") && /même origine/.test(await alexB.texte("[data-role=bandeau-isolement]")), "sans WDD_URL_PAGES : bandeau dans l'administration");
	await alexB.capture("admin-meme-origine");
	// Étape 3.6 (§ A.2) : un seul hôte. Le Wiki porte le même bandeau, liens relatifs ; Administration pour un admin.
	// Avant tout build : « Wiki pas encore publié », avec le bandeau (un nom long, à 360 px).
	const longB = await Onglet.ouvrir("long-b");
	const NOM_LONG = "Marguerite-Alexandrine de la Fontaine-Beauregard du Vergé";
	await longB.aller(`${B.url}/__test/connexion?projet=${PROJET}&compte=longb&role=contributeur&nom=${encodeURIComponent(NOM_LONG)}&suite=${encodeURIComponent(`/p/${PROJET}/`)}`, `document.getElementById("wdd-bandeau")`);
	const obLong = await longB.eval(ONGLETS_BANDEAU);
	ok(/Wiki pas encore publié/.test(await longB.texte("main h1")) && JSON.stringify(obLong.map(x => x.split("=")[0])) === JSON.stringify(["accueil", "wiki", "retours", "kanban"]) && await longB.texte("#wdd-bandeau .wdd-b-nom") === NOM_LONG,
		"un seul hôte, Wiki pas encore publié : la page porte le bandeau (contributeur, nom long)", { h1: await longB.texte("main h1"), obLong });
	await longB.capture("wiki-pas-publie");
	await verifier360(longB, "wiki-pas-publie-nom-long");
	await longB.fermer();
	const cookieAlexB = (await exiger(B.url, "POST", "/__test/preparer", { corps: { projet: PROJET, comptes: [{ id: "alexb", nom: "Alex B", role: "admin" }] } })).comptes[0].cookie;
	await exiger(B.url, "POST", `/api/p/${PROJET}/builds`, { brut: fs.readFileSync(path.join(RACINE, "site", "examples", "data.json")), cookie: cookieAlexB });
	await alexB.aller(`${B.url}/p/${PROJET}/`, `document.getElementById("wdd-bandeau") && document.querySelectorAll(".fb-btn").length > 0`);
	const obB = await alexB.eval(ONGLETS_BANDEAU);
	ok(JSON.stringify(obB) === JSON.stringify(["accueil=/#/", "admin=/#/admin", `wiki=/p/${PROJET}/`, `retours=/#/p/${PROJET}/retours`, `kanban=/#/p/${PROJET}/kanban`, `membres=/#/p/${PROJET}/membres`])
		&& await alexB.texte("#wdd-bandeau .wdd-b-nom") === "Alex" && await alexB.texte("#wdd-bandeau .wdd-b-titre") === "Jardin B", "un seul hôte : bandeau du Wiki, liens relatifs, Administration pour l'admin", obB);
	await alexB.capture("wiki-bandeau-un-hote");
	await alexB.relever();
	await alexB.cliquer("#wdd-bandeau [data-onglet=kanban]");
	ok(await alexB.attendre(`location.pathname === "/" && location.hash === "#/p/${PROJET}/kanban" && document.body.dataset.vue === "kanban" && document.body.dataset.charge === "1"`, 15000) && await alexB.texte("#qui") === "Alex",
		"un seul hôte : bandeau → Kanban, connecté", await alexB.essayer(`location.href + " " + document.body.dataset.vue`));
	await alexB.fermer();
	// Témoin de l'étape 2 : sans hôte des pages, le même formulaire d'invitation aboutit (la redirection reste sur
	// l'origine du formulaire, permise par « form-action 'self' »).
	const invB = (await exiger(B.url, "POST", "/__test/preparer", { corps: { projet: PROJET, invitations: [{ role: "contributeur" }] } })).invitations[0].url;
	const samB = await Onglet.ouvrir("sam-b");
	await samB.aller(invB, `document.querySelector("input[name=nom]")`);
	await samB.focus("input[name=nom]");
	await samB.taper("Sam");
	await samB.cliquer("form button");
	ok(await samB.attendre(`location.pathname === "/p/${PROJET}/"`, 10000), "sans WDD_URL_PAGES : l'invitation mène à /p/<projet>/ (témoin)", await samB.essayer("location.href"));
	await samB.fermer();

	// 10. Étape 3.5 (§ 2.2, § 2.4) : appairage d'un poste et liens de reconnexion. Le jeton livré n'est jamais affiché :
	// les vérifications ne passent que son rôle, son nom et son propriétaire.
	etape("Appairage d'un poste, liens de reconnexion");
	const livrer = codeAppareil => appel(U, "POST", "/api/appairage/jeton", { corps: { code_appareil: codeAppareil } });
	const sansJeton = r => ({ status: r.status, code: r.corps && r.corps.code, role: r.corps && r.corps.role, nom: r.corps && r.corps.nom, pour: r.corps && r.corps.pour, usage: r.corps && r.corps.usage });
	const a1 = await requeteHttp(U, "POST", "/api/appairage", { poste: "Poste du code", projet: PROJET });
	ok(a1.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(a1.corps.code), "appairage demandé (CLI simulée) : code XXXX-XXXX", { status: a1.status });
	const A1 = a1.corps;
	// Sans session : le texte du § 2.2 (lien de reconnexion), jamais « rouvre ton lien d'invitation ».
	const poste = await Onglet.ouvrir("poste");
	await poste.aller(`${U}/appairage?code=${A1.code}`);
	ok(await poste.vue("appairage") && await poste.eval(`location.hash`) === `#/appairage/${A1.code}`, "GET /appairage?code= : redirigé vers #/appairage/<code>", await poste.essayer("location.href"));
	const texteSans = await poste.texte("[data-role=appairage-sans-session]");
	ok(/Demande un lien de reconnexion à un mainteneur ou à l'admin, ouvre-le, puis rouvre ce lien/.test(texteSans) && !/invitation/i.test(texteSans), "sans session : « demande un lien de reconnexion », pas de lien d'invitation à rouvrir", texteSans);
	// Lien de reconnexion pour Sam (mainteneur, vue Membres) : montré une fois, listé, ouvert par un clic.
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: "verger", comptes: [{ id: "dom", nom: "Dom", role: "contributeur" }] } });
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: PROJET, comptes: [{ id: "dom", nom: "Dom", role: "contributeur" }] } });
	// Eve : membre du projet ET admin du serveur (le serveur refuse toujours son lien de reconnexion, en 403).
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: PROJET, comptes: [{ id: "eve", nom: "Eve", role: "contributeur" }] } });
	await exiger(U, "POST", "/__test/preparer", { corps: { projet: PROJET, comptes: [{ id: "eve", nom: "Eve", role: "admin" }] } });
	ok(await camille.hash(`#/p/${PROJET}/membres`, "membres"), "vue Membres (reconnexion)");
	await camille.attendre(`document.querySelector('tr[data-compte="eve"]')`);
	ok(!await camille.eval(`!!document.querySelector('[data-role=reconnexion][data-compte="eve"]')`) && /Administration/.test(await camille.texte(`[data-role=reconnexion-admin][data-compte="eve"]`)),
		"membre admin : pas de bouton « Lien de reconnexion » (renvoi à l'Administration)", await camille.texte(`tr[data-compte="eve"]`));
	await camille.attendre(`document.querySelector('[data-role=reconnexion][data-compte="dom"]')`);
	await camille.cliquer(`[data-role=reconnexion][data-compte="dom"]`);
	ok(await camille.attendre(`/projet que tu ne gères pas/.test((document.querySelector("section[aria-labelledby=s-membres] .message.erreur") || {}).textContent || "") && !document.querySelector("[data-role=lien-reconnexion]")`),
		"reconnexion refusée (compte qui a un rôle sur un autre projet) : le refus 403 du serveur est affiché en clair", await camille.texte("section[aria-labelledby=s-membres] .message"));
	await camille.cliquer(`[data-role=reconnexion][data-compte="${idSam}"]`);
	ok(await camille.attendre(`/\\/invitation\\/[A-Za-z0-9_-]{20,}$/.test((document.querySelector("[data-role=lien-reconnexion]") || {}).value || "")`), "lien de reconnexion de Sam : affiché une fois, à copier");
	const lienReco = await camille.eval(`document.querySelector("[data-role=lien-reconnexion]").value`);
	ok(/Copier/.test(await camille.texte("[data-role=reconnexion-creee]")) && await camille.eval(`document.activeElement === document.querySelector("[data-role=lien-reconnexion]")`), "lien de reconnexion : bouton Copier, focus sur le lien");
	ok(await camille.attendre(`[...document.querySelectorAll("[data-role=invitations] li[data-id]")].some(l => l.textContent.startsWith("Reconnexion de Sam"))`), "liste des invitations : « Reconnexion de Sam »", await camille.texte("[data-role=invitations]"));
	await poste.aller(lienReco, `document.querySelector("form button")`);
	ok(/Entrer en tant que Sam/.test(await poste.texte("form button")) && !await poste.eval(`!!document.querySelector("input[name=nom]")`), "page de reconnexion : « Entrer en tant que Sam », sans champ de nom");
	await poste.cliquer("form button");
	ok(await poste.attendre(`location.pathname === "/" && document.body.dataset.vue === "accueil" && document.body.dataset.charge === "1"`, 15000) && await poste.texte("#qui") === "Sam", "lien de reconnexion ouvert : session de Sam dans ce navigateur");
	ok(!(await exiger(U, "GET", `/api/p/${PROJET}/membres`, { cookie: cookieAlex })).invitations.some(i => i.role === "reconnexion"), "le lien de reconnexion a servi (plus en attente)");
	await camille.hash(`#/p/${PROJET}/retours`, "retours");
	await camille.hash(`#/p/${PROJET}/membres`, "membres");
	const pageMembres = await camille.eval(`document.body.textContent + " " + [...document.querySelectorAll("input")].map(i => i.value).join(" ")`);
	ok(!await camille.eval(`!!document.querySelector("[data-role=lien-reconnexion]")`) && !pageMembres.includes(lienReco), "le lien de reconnexion n'est plus affiché ensuite");
	// Sam rouvre le lien d'appairage : code en grand, poste, IP (écoute locale), même machine, rôle Agent seulement.
	await poste.aller(`${U}/appairage?code=${A1.code}`);
	ok(await poste.vue("appairage") && await poste.attendre(`document.querySelector("[data-role=form-appairage]")`), "avec session : page d'autorisation");
	ok(await poste.texte("[data-role=code-appairage]") === A1.code, "le code est affiché en grand", await poste.texte("[data-role=code-appairage]"));
	ok(/Vérifie que c'est le code affiché par ton terminal ou ton agent\. N'autorise que si tu viens de lancer outil brancher ou outil installer toi-même\./.test(await poste.texte("main")), "avertissement sur le code");
	ok(await poste.texte("[data-role=poste]") === "Poste du code" && /^il y a \d+ s$/.test(await poste.texte("[data-role=age-appairage]")) && await poste.texte("[data-role=ip]") === "127.0.0.1", "poste, âge de la demande, IP (écoute locale)",
		{ poste: await poste.texte("[data-role=poste]"), age: await poste.texte("[data-role=age-appairage]"), ip: await poste.texte("[data-role=ip]") });
	ok(!await poste.eval(`!!document.querySelector("[data-role=avertissement-ip]")`), "même machine : pas d'avertissement d'IP");
	ok(await poste.eval(`document.querySelector("#ap-projet").value === ${JSON.stringify(PROJET)} && !!document.querySelector("#ap-role-agent") && document.querySelector("#ap-role-agent").checked && !document.querySelector("#ap-role-mainteneur")`), "contributeur : projet demandé présélectionné, rôle Agent seulement");
	ok(!await poste.eval(`!!document.querySelector("[data-role=ponctuel]")`), "permanent : pas de mention « une heure »");
	ok((await livrer(A1.code_appareil)).status === 202, "CLI : 202 attente avant le clic");
	await sleep(2100);
	await poste.focus("[data-role=autoriser]");
	await poste.touche("Enter");
	ok(await poste.attendre(`document.querySelector("[data-role=appairage-fini][data-etat=autorise]")`, 8000) && /Autorisé : retourne dans ton terminal\./.test(await poste.texte("[data-role=appairage-fini]")), "au clavier : Autoriser → « Autorisé : retourne dans ton terminal »", await poste.texte("main"));
	const l1 = await livrer(A1.code_appareil);
	const jetonAppaire = l1.corps && l1.corps.jeton;
	ok(l1.status === 200 && typeof jetonAppaire === "string" && l1.corps.role === "agent" && l1.corps.nom === "Agent · Poste du code" && l1.corps.pour.nom === "Sam" && l1.corps.projet === PROJET, "CLI : jeton reçu (agent, « Agent · Poste du code », pour Sam)", sansJeton(l1));
	const pagePoste = await poste.eval(`document.body.textContent + " " + [...document.querySelectorAll("input")].map(i => i.value).join(" ")`);
	ok(!!jetonAppaire && !pagePoste.includes(jetonAppaire), "le jeton n'apparaît pas dans la page");
	const sa = await appel(U, "GET", `/api/p/${PROJET}/session`, { bearer: jetonAppaire });
	ok(sa.status === 200 && sa.corps.nom === "Agent · Poste du code" && sa.corps.pour && sa.corps.pour.nom === "Sam", "le jeton appairé marche (Bearer), propriétaire Sam", { status: sa.status, nom: sa.corps && sa.corps.nom });
	await sleep(2100);
	const l1b = await livrer(A1.code_appareil);
	ok(l1b.status === 410 && l1b.corps.code === "expired", "CLI : une seule livraison (410 expired ensuite)", sansJeton(l1b));
	await poste.aller(`${U}/appairage?code=${A1.code}`);
	ok(await poste.vue("appairage") && await poste.attendre(`document.querySelector("[data-role=appairage-fini][data-etat=expire]")`) && /Code expiré ou déjà utilisé/.test(await poste.texte("main")), "code déjà utilisé : « expiré ou déjà utilisé », avec un champ pour un autre code");
	await camille.hash(`#/p/${PROJET}/retours`, "retours");
	ok(await camille.hash(`#/p/${PROJET}/membres`, "membres") && await camille.attendre(`[...document.querySelectorAll("table[data-role=jetons] tr[data-id]")].some(t => /Agent · Poste du code/.test(t.textContent) && t.querySelector("[data-role=origine]").textContent === "appairé depuis Poste du code (127.0.0.1)" && t.querySelector("[data-role=expire]").textContent === "jamais")`),
		"Membres : origine « appairé depuis Poste du code (127.0.0.1) », n'expire pas", await camille.texte("table[data-role=jetons]"));
	// Une autre machine (adresse source 127.0.0.2), ponctuel et mainteneur : avertissement, mention « une heure », refus.
	let a2;
	try { a2 = await requeteHttp(U, "POST", "/api/appairage", { poste: "Autre machine", projet: PROJET, role: "mainteneur", usage: "ponctuel" }, "127.0.0.2"); }
	catch (e) { a2 = { status: 0, corps: null, erreur: e.message }; }
	ok(a2.status === 201, "appairage demandé depuis une autre adresse (127.0.0.2)", { status: a2.status, erreur: a2.erreur });
	if (a2.status === 201) {
		const A2 = a2.corps;
		await camille.aller(`${U}/appairage?code=${A2.code}`);
		ok(await camille.vue("appairage") && await camille.attendre(`document.querySelector("[data-role=form-appairage]")`), "Camille : page d'autorisation de l'autre machine");
		ok(await camille.texte("[data-role=ip]") === "127.0.0.2" && /La demande vient d'une autre machine que ton navigateur\./.test(await camille.texte("[data-role=avertissement-ip]")), "autre machine : avertissement d'IP visible", await camille.texte("[data-role=avertissement-ip]"));
		ok(/Valable une heure, pour cette seule opération\./.test(await camille.texte("[data-role=ponctuel]")), "ponctuel : « valable une heure, pour cette seule opération »");
		ok(await camille.eval(`!!document.querySelector("#ap-role-mainteneur") && document.querySelector("#ap-role-mainteneur").checked`), "mainteneuse : rôle Mainteneur proposé et présélectionné (demandé)");
		await verifier360(camille, "appairage");
		await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
		await camille.largeur(360);
		await camille.capture("appairage-360-sombre");
		await camille.largeur(0);
		await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
		await camille.cliquer("[data-role=refuser]");
		ok(await camille.attendre(`document.querySelector("[data-role=appairage-fini][data-etat=refuse]")`, 8000) && /Refusé/.test(await camille.texte("[data-role=appairage-fini]")), "Refuser → « Refusé »");
		const l2 = await livrer(A2.code_appareil);
		ok(l2.status === 410 && l2.corps.code === "refused", "CLI : 410 refused", sansJeton(l2));
	}
	// Ponctuel autorisé en mainteneur : la vue Membres affiche son expiration ; le jeton se révoque lui-même.
	const A3 = (await requeteHttp(U, "POST", "/api/appairage", { poste: "Import", projet: PROJET, role: "mainteneur", usage: "ponctuel" })).corps;
	await camille.hash(`#/appairage/${A3.code}`, "appairage");
	await camille.attendre(`document.querySelector("[data-role=form-appairage]")`);
	ok(await camille.eval(`document.activeElement && document.activeElement.localName === "h1" && document.activeElement.isConnected`), "page d'appairage ouverte par la navigation : le focus est sur le titre", await camille.essayer("document.activeElement.outerHTML.slice(0, 80)"));
	await camille.cliquer("[data-role=autoriser]");
	await camille.attendre(`document.querySelector("[data-role=appairage-fini][data-etat=autorise]")`, 8000);
	ok(/une heure/.test(await camille.texte("[data-role=appairage-fini]")), "ponctuel autorisé : l'état final rappelle « une heure »");
	const l3 = await livrer(A3.code_appareil);
	ok(l3.status === 200 && l3.corps.role === "mainteneur" && l3.corps.usage === "ponctuel" && !!l3.corps.expire, "CLI : jeton ponctuel mainteneur, avec expiration", sansJeton(l3));
	ok(await camille.hash(`#/p/${PROJET}/membres`, "membres") && await camille.attendre(`[...document.querySelectorAll("table[data-role=jetons] tr[data-id]")].some(t => /Agent · Import/.test(t.textContent) && /^le /.test(t.querySelector("[data-role=expire]").textContent) && t.querySelector("[data-role=origine]").textContent === "appairé depuis Import (127.0.0.1)")`),
		"Membres : jeton ponctuel avec sa date d'expiration", await camille.texte("table[data-role=jetons]"));
	ok((await appel(U, "DELETE", `/api/p/${PROJET}/jeton`, { bearer: l3.corps.jeton })).status === 204, "le jeton ponctuel se révoque lui-même");
	// Sans code : un champ ; un code mal formé n'appelle pas le serveur, un code bien formé ouvre sa page.
	ok(await camille.hash("#/appairage", "appairage") && await camille.eval(`!!document.querySelector("form[data-role=form-code] #ap-code")`), "#/appairage sans code : champ pour taper le code");
	await camille.focus("#ap-code");
	await camille.taper("abcd-ef01");
	await camille.touche("Enter");
	ok(await camille.attendre(`/Code mal formé/.test(document.querySelector("form[data-role=form-code]").textContent)`) && await camille.eval(`location.hash`) === "#/appairage", "code mal formé : refusé sur place, sans appel");
	await camille.valeur("#ap-code", "abcd ef23");
	await camille.touche("Enter");
	ok(await camille.attendre(`location.hash === "#/appairage/ABCD-EF23" && document.querySelector("[data-role=appairage-fini][data-etat=expire]")`), "code tapé (minuscules, espace) : normalisé, ouvert ; inconnu → « expiré ou déjà utilisé »", await camille.essayer("location.hash"));
	// 429 : dix codes inconnus dans la minute (session à part, pour ne pas bloquer Camille).
	const essais = await Onglet.ouvrir("essais");
	await essais.aller(`${U}/__test/connexion?projet=${PROJET}&compte=essais&role=contributeur&nom=Essais&suite=/`);
	await essais.vue("accueil");
	const A4 = (await requeteHttp(U, "POST", "/api/appairage", { poste: "Essais", projet: PROJET })).corps;
	await essais.eval(`Promise.all(Array.from({ length: 10 }, () => fetch("/api/appairage/ZZZZ-ZZZZ").then(r => r.status)))`);
	await essais.hash(`#/appairage/${A4.code}`, "appairage");
	ok(/trop de codes inconnus/.test(await essais.texte("form[data-role=form-code] .message")), "429 : « trop de codes inconnus », affiché", await essais.texte("main"));
	await essais.fermer();

	// 11. Bandeau « Traitement » (§ 5.4) : sans veilleur, faux veilleur piloté par HTTP (jeton appairé), annulations,
	// rôle, réglage « personne ».
	etape("Traitement des retours");
	const nNouveaux = (await exiger(U, "GET", `/__test/retours?projet=${PROJET}`)).docs.filter(d => d.donnees.status === "nouveau").length;
	const bandeau = `document.querySelector("[data-role=traitement]")`;
	const etatBandeau = e => `${bandeau} && ${bandeau}.dataset.etat === ${JSON.stringify(e)}`;
	ok(await camille.hash(`#/p/${PROJET}/kanban`, "kanban") && await camille.attendre(etatBandeau("libre")), "Kanban : bandeau Traitement chargé");
	ok(/Aucun agent en veille : sur le poste du code, lancer outil veille\./.test(await camille.texte("[data-role=veille]")), "sans veilleur : « Aucun agent en veille … outil veille »", await camille.texte("[data-role=veille]"));
	const libelleTraiter = `Traiter les retours (${nNouveaux} en attente)`;
	ok(await camille.texte("[data-role=traiter]") === libelleTraiter && await camille.eval(`!document.querySelector("[data-role=traiter]").disabled`), `bouton « ${libelleTraiter} » actif`, await camille.texte("[data-role=traiter]"));
	ok(await camille.hash(`#/p/${PROJET}/retours`, "retours") && await camille.attendre(etatBandeau("libre")), "vue Retours : bandeau Traitement aussi");
	await camille.hash(`#/p/${PROJET}/kanban`, "kanban");
	await camille.attendre(etatBandeau("libre"));
	await camille.focus("[data-role=traiter]");
	await camille.touche("Enter");
	ok(await camille.attendre(etatBandeau("attente")) && /Aucun agent en veille/.test(await camille.texte("[data-role=traitement] .message")), "au clavier : demande créée, en attente, « aucun agent en veille » signalé", await camille.texte("[data-role=traitement]"));
	ok(await camille.eval(`document.querySelector("[data-role=traiter]").disabled`) && /déjà active/.test(await camille.texte("[data-role=raison]")), "demande active : bouton désactivé, raison écrite", await camille.texte("[data-role=raison]"));
	ok(await camille.attendre(`document.activeElement && document.activeElement.isConnected && document.activeElement !== document.body && ${bandeau}.contains(document.activeElement)`, 3000), "le focus reste dans le bandeau", await camille.essayer("document.activeElement.outerHTML.slice(0, 120)"));
	ok((await exiger(U, "GET", `/api/p/${PROJET}/demandes`, { cookie: cookieAlex })).active.etat === "attente", "serveur : une demande en attente");
	await camille.cliquer("[data-role=annuler-demande]");
	ok(await camille.attendre(etatBandeau("libre")) && await camille.eval(`!!document.querySelector('[data-role=recentes] li[data-etat="annulee"]')`), "Annuler (en attente) : la demande passe dans les dernières, « Annulée »");
	// Un contributeur : bouton désactivé, raison du réglage ; il ne voit pas le résumé des demandes des autres.
	await poste.aller(`${U}/#/p/${PROJET}/kanban`);
	ok(await poste.vue("kanban") && await poste.attendre(etatBandeau("libre")) && await poste.eval(`document.querySelector("[data-role=traiter]").disabled`) && /Réservé aux mainteneurs et aux admins/.test(await poste.texte("[data-role=raison]")),
		"contributeur (Sam) : bouton désactivé, « réservé aux mainteneurs et aux admins »", await poste.texte("[data-role=traitement]"));
	ok(await poste.eval(`!document.querySelector("[data-role=branchement]") && !document.body.textContent.includes("Branche ce dépôt")`), "contributeur (Sam) : pas de bloc « Brancher un dépôt de code »");
	// Faux veilleur : le jeton appairé (agent, pour Sam), une présence toutes les 4 s.
	const veille = () => appel(U, "POST", `/api/p/${PROJET}/veille`, { bearer: jetonAppaire, corps: { poste: "poste-code" } });
	const v0 = await veille();
	ok(v0.status === 200 && v0.corps.demande === null, "faux veilleur : présence, aucune demande");
	const presence = setInterval(() => { veille().catch(() => { }); }, 4000);
	try {
		ok(await poste.attendre(`/Agent en veille : Agent · Poste du code · pour Sam, sur poste-code/.test((document.querySelector("[data-role=veille]") || {}).textContent || "")`, 15000), "relecture périodique : le veilleur apparaît sans événement (chez Sam)", await poste.texte("[data-role=veille]"));
		await camille.cliquer("[data-role=traiter]");
		ok(await camille.attendre(`${etatBandeau("attente")} && /Agent en veille : Agent · Poste du code · pour Sam, sur poste-code, vu il y a \\d+ s/.test(document.querySelector("[data-role=veille]").textContent)`, 8000),
			"avec veilleur : « Agent en veille : Agent · Poste du code · pour Sam, sur poste-code, vu il y a … »", await camille.texte("[data-role=veille]"));
		const d1 = (await veille()).corps.demande;
		ok(!!d1 && d1.etat === "attente", "faux veilleur : la demande en attente lui est donnée");
		ok((await appel(U, "POST", `/api/p/${PROJET}/demandes/${d1.id}/prendre`, { bearer: jetonAppaire })).status === 200, "faux veilleur : prendre");
		ok(await camille.attendre(`${etatBandeau("en-cours")} && /En cours depuis .*Agent · Poste du code · pour Sam sur poste-code/.test(document.querySelector("[data-role=demande-active]").textContent)`, 3000), "bandeau : « En cours depuis … », preneur et poste", await camille.texte("[data-role=demande-active]"));
		ok(await camille.hash("#/", "accueil") && await camille.attendre(`(document.querySelector('li[data-id="${PROJET}"] [data-role=etat-traitement]') || {}).textContent === "Traitement en cours"`), "Accueil : point d'état « Traitement en cours »", await camille.texte(`li[data-id="${PROJET}"]`));
		await camille.hash(`#/p/${PROJET}/kanban`, "kanban");
		await camille.attendre(etatBandeau("en-cours"));
		const b1 = await appel(U, "POST", `/api/p/${PROJET}/demandes/${d1.id}/battement`, { bearer: jetonAppaire, corps: { journal: "lecture des retours…" } });
		ok(b1.status === 200 && b1.corps.annuler === false, "faux veilleur : battement, pas d'annulation");
		const RESUME = "Trois retours traités.\n<img src=x onerror=\"window.__xssResume=1\"> **pas du Markdown**\nFichiers modifiés : notes.txt";
		ok((await appel(U, "POST", `/api/p/${PROJET}/demandes/${d1.id}/terminer`, { bearer: jetonAppaire, corps: { etat: "terminee", resume: RESUME, code_sortie: 0 } })).status === 200, "faux veilleur : terminer (terminee)");
		ok(await camille.attendre(`${etatBandeau("libre")} && document.querySelector('[data-role=recentes] li[data-etat="terminee"]')`, 3000), "bandeau : demande terminée, dans les dernières");
		await camille.focus("[data-role=recentes] > summary");
		await camille.touche("Enter");
		ok(await camille.attendre(`document.querySelector("[data-role=recentes]").open`), "au clavier : « Dernières demandes » se déplie");
		await camille.focus(`[data-role=recentes] li[data-id="${d1.id}"] [data-role=resume] > summary`);
		await camille.touche("Enter");
		ok(await camille.attendre(`document.querySelector('[data-role=recentes] li[data-id="${d1.id}"] [data-role=resume]').open`), "au clavier : le résumé se déplie");
		const pre = await camille.eval(`document.querySelector('[data-role=recentes] li[data-id="${d1.id}"] [data-role=resume] pre').textContent`);
		ok(pre === RESUME && await camille.eval(`document.querySelectorAll("img").length === 0 && !document.querySelector("[data-role=traitement] strong em, [data-role=resume] strong") && window.__xssResume === undefined`), "résumé en texte brut (ni HTML ni Markdown)", pre);
		ok(await poste.attendre(`document.querySelector('[data-role=recentes] li[data-id="${d1.id}"]') && !document.querySelector('[data-role=recentes] li[data-id="${d1.id}"] [data-role=resume]')`, 8000), "Sam (ni demandeur ni mainteneur) : pas de résumé");
		// Annulation d'une demande en cours : l'agent l'apprend au battement suivant.
		await camille.cliquer("[data-role=traiter]");
		await camille.attendre(etatBandeau("attente"));
		const d2 = (await veille()).corps.demande;
		await appel(U, "POST", `/api/p/${PROJET}/demandes/${d2.id}/prendre`, { bearer: jetonAppaire });
		ok(await camille.attendre(etatBandeau("en-cours"), 3000) && await camille.eval(`document.querySelector('[data-role=recentes] li[data-id="${d1.id}"] [data-role=resume]').open`), "en cours ; le résumé déplié reste déplié après la relecture");
		await camille.focus("[data-role=annuler-demande]");
		await camille.touche("Enter");
		ok(await camille.attendre(`document.querySelector("[data-role=annulation-demandee]")`, 8000) && /Annulation demandée/.test(await camille.texte("[data-role=traitement] .message")), "Annuler (en cours) : « Annulation demandée »");
		const b2 = await appel(U, "POST", `/api/p/${PROJET}/demandes/${d2.id}/battement`, { bearer: jetonAppaire, corps: {} });
		ok(b2.status === 200 && b2.corps.annuler === true, "faux veilleur : le battement rend annuler: true");
		await appel(U, "POST", `/api/p/${PROJET}/demandes/${d2.id}/terminer`, { bearer: jetonAppaire, corps: { etat: "annulee", resume: "Arrêté.", code_sortie: null, raison: "annulée depuis l'interface" } });
		ok(await camille.attendre(`${etatBandeau("libre")} && /Annulée.*annulée depuis l'interface/.test((document.querySelector('[data-role=recentes] li[data-id="${d2.id}"]') || {}).textContent || "")`, 3000), "bandeau : « Annulée », avec la raison du veilleur");
		ok(await camille.eval(`[...document.querySelectorAll("[data-role=traitement] .message")].every(m => m.hidden)`), "demande finie : le message « Annulation demandée » est effacé", await camille.texte("[data-role=traitement] .message"));
		await camille.capture("kanban-traitement");
		await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
		await camille.largeur(360);
		await camille.capture("kanban-traitement-360-sombre");
		await camille.largeur(0);
		await camille.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
		await verifier360(camille, "kanban-traitement");
	} finally { clearInterval(presence); }
	// Réglage « personne » (Membres → Réglages) : le bouton se désactive, avec sa raison ; le serveur refuse aussi.
	ok(await camille.hash(`#/p/${PROJET}/membres`, "membres") && await camille.eval(`document.querySelector("#reg-traitement").value`) === "mainteneur", "Membres → Réglages : « Qui peut lancer le traitement » (mainteneur par défaut)");
	await camille.valeur("#reg-traitement", "personne");
	await camille.cliquer("form[data-role=form-reglages] button[type=submit]");
	ok(await camille.attendre(`/Réglages enregistrés/.test(document.querySelector("form[data-role=form-reglages]").textContent)`), "réglage « personne » enregistré");
	const reg2 = await exiger(U, "GET", `/api/p/${PROJET}/reglages`, { cookie: cookieAlex });
	ok(reg2.traitement === "personne" && reg2.disciplines.length === 2, "site.json : traitement personne, disciplines gardées", reg2);
	ok(await camille.hash(`#/p/${PROJET}/kanban`, "kanban") && await camille.attendre(`${etatBandeau("libre")} && document.querySelector("[data-role=traiter]").disabled && /Traitement désactivé pour ce projet/.test(document.querySelector("[data-role=raison]").textContent)`), "réglage « personne » : bouton désactivé, « traitement désactivé »", await camille.texte("[data-role=traitement]"));
	ok((await appel(U, "POST", `/api/p/${PROJET}/demandes`, { cookie: cookieAlex, corps: {} })).status === 403, "serveur : même un admin est refusé (403)");
	await poste.fermer();

	// 12. Administration : lien de reconnexion d'un compte (admin), ouvert dans un autre navigateur.
	etape("Administration : lien de reconnexion");
	const alex2 = await Onglet.ouvrir("alex-2");
	await alex2.aller(`${U}/__test/connexion?projet=${PROJET}&compte=alex&role=admin&nom=Alex&suite=/`);
	await alex2.vue("accueil");
	ok(await alex2.hash("#/admin", "admin") && await alex2.attendre(`document.querySelector('table[data-role=comptes] [data-role=reconnexion][data-compte="camille"]')`), "Administration : « Lien de reconnexion » sur chaque compte actif");
	await alex2.cliquer(`table[data-role=comptes] [data-role=reconnexion][data-compte="camille"]`);
	ok(await alex2.attendre(`/\\/invitation\\/[A-Za-z0-9_-]{20,}$/.test((document.querySelector("[data-role=lien-reconnexion]") || {}).value || "")`), "lien de reconnexion de Camille affiché une fois");
	const lienRecoC = await alex2.eval(`document.querySelector("[data-role=lien-reconnexion]").value`);
	ok(await alex2.attendre(`[...document.querySelectorAll("table[data-role=invitations] tbody tr")].some(t => t.cells[0].textContent === "Reconnexion de Camille")`), "invitations : « Reconnexion de Camille »");
	await alex2.capture("admin-reconnexion");
	await alex2.fermer();
	const camille2 = await Onglet.ouvrir("camille-2");
	await camille2.aller(lienRecoC, `document.querySelector("form button")`);
	await camille2.cliquer("form button");
	ok(await camille2.attendre(`location.pathname === "/" && document.body.dataset.vue === "accueil" && document.body.dataset.charge === "1"`, 15000) && await camille2.texte("#qui") === "Camille", "lien de reconnexion (admin) ouvert : session de Camille");
	await camille2.fermer();

	// 9. Propreté : ni violation de CSP ni exception dans la méta-interface.
	etape("CSP et erreurs");
	await camille.fermer();
	const tous = onglets.flatMap(o => o.problemes.map(p => ({ onglet: o.nom, ...p })));
	// La page d'invitation (servie par le serveur, pas par la méta-interface) est vérifiée à l'étape 2.
	const meta = tous.filter(p => !p.url.startsWith(A.pages) && !(p.url + " " + p.texte).includes("/invitation/"));
	ok(!meta.some(p => /CSP|Content Security Policy|Refused/i.test(p.texte)), "méta-interface : aucune violation de CSP", meta);
	ok(!meta.some(p => /exception|erreur :/.test(p.texte)), "méta-interface : aucune exception", meta);
	if (tous.length) fs.writeFileSync(path.join(SORTIE, "problemes.json"), JSON.stringify(tous, null, 2));
}

async function arreter() {
	if (cdp) { await Promise.race([cdp.envoyer("Browser.close").catch(() => { }), sleep(3000)]); cdp.fermer(); }
	if (edge && edge.exitCode === null) { await sleep(500); if (edge.exitCode === null) { try { edge.kill(); } catch { } } }
	for (const s of serveurs) if (s.exitCode === null) {
		s.kill();
		await Promise.race([new Promise(r => s.once("exit", r)), sleep(5000)]);
		journal(`serveur arrêté (PID ${s.pid})`);
	}
}

principal().catch(e => { nFail++; console.log("FAIL arrêt du scénario : " + ((e && e.stack) || e)); }).then(async () => {
	await arreter();
	console.log(`BILAN ${nPass} PASS, ${nFail} FAIL`);
	console.log(nFail ? "DES ÉCHECS" : "TOUT PASSE");
	process.exit(nFail ? 1 : 0);
});
