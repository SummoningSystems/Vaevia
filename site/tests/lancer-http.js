#!/usr/bin/env node
// Rejoue site/tests/scenarios.js (inchangé) contre le serveur de l'étape 1 avec l'adaptateur « http »
// (docs/etape1-serveur.md § 6, critère 2). Appelé par lancer-http.sh, qui trouve Edge ou Chrome :
//   node site/tests/lancer-http.js <dossier de sortie hors dépôt> <navigateur> [mode ...]
// Node 24 (TypeScript du serveur exécuté directement, WebSocket et fetch intégrés). Aucune dépendance.
//
// Déroulé :
// 1. un serveur de test (WDD_TEST=1, port libre, données dans <sortie>/donnees, effacé au départ) ;
// 2. le lien d'invitation admin affiché au démarrage est consommé (POST /invitation/<jeton>) : cookie admin ;
// 3. par mode, un projet « essai-<mode> » (POST /api/admin/projets), les notes de l'exemple (POST /__test/notes,
//    aucune API de notes à l'étape 1), le build de site/examples/data.json (POST /api/p/<projet>/builds : build.js
//    --stockage=http côté serveur), puis l'état du mode (POST /__test/mode, retours posés) ;
// 4. Edge sans fenêtre piloté par le protocole DevTools : un contexte neuf par mode (cookies, sessionStorage),
//    la cale (cale-http.js) puis scenarios.js injectés avant tout script de la page, la session du compte « essai »
//    posée par /__test/connexion, qui redirige vers la vraie page /p/<projet>/ (servie avec sa CSP) ;
// 5. résultats lus dans <pre id="__results"> (PASS / FAIL / INFO), comme lancer.sh ; git log du projet « normal ».
// Serveur et navigateur sont arrêtés à la fin, même en cas d'échec. Code de sortie 1 si un FAIL.
// Modes sans objet en HTTP (non rejoués) : voir README-http.md.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const [sortieBrute, navigateur, ...modesDemandes] = process.argv.slice(2);
if (!sortieBrute || !navigateur) { console.error("usage : node lancer-http.js <dossier de sortie> <navigateur> [mode ...]"); process.exit(2); }
const SITE = path.resolve(__dirname, "..");
const RACINE = path.resolve(SITE, "..");
const SORTIE = path.resolve(sortieBrute);
const TOUS = ["normal", "readonly", "denywrite", "quota", "unavailable", "revoked", "snapretry", "silent", "offline", "nodb"];
const SANS_OBJET = { nouser: "le serveur ne sert la page et l'API qu'à une session, qui a toujours un compte : by vient de la session (README-http.md)" };
const MODES = modesDemandes.length ? modesDemandes : TOUS;
for (const m of MODES) if (!TOUS.includes(m) && !SANS_OBJET[m]) { console.error("mode inconnu : " + m); process.exit(2); }
// Modes où le flux répond tout de suite : la cale attend ce premier instantané comme une écriture.
const ATTENDRE_INSTANTANE = new Set(["normal", "readonly", "denywrite", "quota", "unavailable", "revoked"]);
// Délai maximal par mode (une marge : il ne compte que si la page ne finit pas).
const DELAI_MODE_MS = 60000;
// WDD_BANC_LENTEUR=<ms> : chaque commit des projets d'essai attend ce temps (crochet pre-commit), pour éprouver
// l'attente de la cale sur un serveur lent. 0 par défaut.
const LENTEUR_MS = Math.max(0, Number(process.env.WDD_BANC_LENTEUR || 0) || 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const journal = m => console.error("[lancer-http] " + m);

let serveur = null, edge = null, cdp = null;

// --- Serveur de test -------------------------------------------------------------------------------------
async function demarrerServeur(donnees) {
	const env = { ...process.env, WDD_DONNEES: donnees, WDD_TEST: "1", WDD_PORT: "0", WDD_HOTE: "127.0.0.1" };
	delete env.WDD_URL; delete env.WDD_HTTPS;
	const p = spawn(process.execPath, [path.join(RACINE, "serveur", "src", "principal.ts")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	serveur = p;
	const log = fs.createWriteStream(path.join(SORTIE, "serveur.log"));
	let texte = "";
	return await new Promise((ok, ko) => {
		const fin = setTimeout(() => ko(new Error("le serveur n'a pas démarré en 30 s (voir serveur.log)")), 30000);
		const lire = b => {
			log.write(b);
			if (texte === null) return;
			texte += b.toString("utf8");
			const m = texte.match(/à l'écoute sur (http:\/\/\S+) \(PID (\d+)\)/);
			const a = texte.match(/\/invitation\/([A-Za-z0-9_-]{20,100})/);
			if (m && a) { clearTimeout(fin); texte = null; ok({ url: m[1], pid: Number(m[2]), jetonAdmin: a[1] }); }
		};
		p.stdout.on("data", lire);
		p.stderr.on("data", lire);
		p.on("exit", c => { clearTimeout(fin); ko(new Error("le serveur s'est arrêté (code " + c + ", voir serveur.log)")); });
	});
}

// Requête JSON au serveur. Avec un cookie, ou vers l'API de test : X-WDD: 1 (anti-CSRF ; exigé partout sur /__test/).
async function appel(base, methode, chemin, corps, cookie, brut) {
	const h = {};
	if (corps !== undefined || brut !== undefined) h["Content-Type"] = "application/json";
	if (cookie) { h.Cookie = cookie; h["X-WDD"] = "1"; }
	if (chemin.startsWith("/__test/")) h["X-WDD"] = "1";
	const r = await fetch(base + chemin, { method: methode, headers: h, redirect: "manual", body: brut !== undefined ? brut : corps !== undefined ? JSON.stringify(corps) : undefined });
	const t = await r.text();
	let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
	return { status: r.status, corps: j, texte: t, entetes: r.headers };
}
async function exiger(base, methode, chemin, corps, cookie, brut) {
	const r = await appel(base, methode, chemin, corps, cookie, brut);
	if (r.status < 200 || r.status >= 400) throw new Error(`${methode} ${chemin} -> ${r.status} ${r.texte.slice(0, 300)}`);
	return r;
}

// Un flux ouvert puis coupé en mode revoked : le projet répond ensuite 401 partout, alors que la page reste servie.
function couperUnFlux(base, projet, cookie) {
	return new Promise((ok, ko) => {
		const u = new URL(base + `/api/p/${projet}/flux`);
		const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Cookie: cookie } }, res => {
			if (res.statusCode !== 200) { res.resume(); return ko(new Error("flux : HTTP " + res.statusCode)); }
			res.on("data", () => { });
			res.on("error", () => { });
			res.on("close", () => ok());
		});
		req.on("error", () => ok());
		setTimeout(() => { req.destroy(); ko(new Error("flux non coupé en 5 s")); }, 5000).unref();
	});
}

// --- Edge par le protocole DevTools ------------------------------------------------------------------------
async function demarrerEdge(profil) {
	fs.rmSync(profil, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	fs.mkdirSync(profil, { recursive: true });
	edge = spawn(navigateur, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0",
		`--user-data-dir=${profil}`, "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows", "--disable-extensions", "about:blank"], { stdio: "ignore", windowsHide: true });
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
	return new Promise((ok, ko) => {
		const ws = new WebSocket(url);
		let n = 0;
		const attente = new Map();
		ws.onmessage = ev => {
			const m = JSON.parse(String(ev.data));
			if (m.id && attente.has(m.id)) {
				const a = attente.get(m.id); attente.delete(m.id);
				m.error ? a.ko(new Error(`CDP ${a.methode} : ${m.error.message}`)) : a.ok(m.result || {});
			}
		};
		ws.onerror = () => ko(new Error("connexion DevTools impossible"));
		ws.onclose = () => { for (const a of attente.values()) a.ko(new Error("connexion DevTools fermée")); attente.clear(); };
		ws.onopen = () => ok({
			envoyer: (methode, params = {}, sessionId) => new Promise((ok2, ko2) => {
				const id = ++n;
				attente.set(id, { ok: ok2, ko: ko2, methode });
				ws.send(JSON.stringify(sessionId ? { id, method: methode, params, sessionId } : { id, method: methode, params }));
			}),
			fermer: () => { try { ws.close(); } catch (e) { } },
		});
	});
}

const LIRE_RESULTATS = `(() => { const p = document.getElementById("__results"); return p ? p.textContent : ""; })()`;

// Un mode : contexte neuf, scripts injectés avant ceux de la page, navigation, attente du « END » des scénarios.
async function jouer(mode, url, config, cale, scenarios) {
	const { browserContextId } = await cdp.envoyer("Target.createBrowserContext", { disposeOnDetach: true });
	let targetId = null;
	try {
		({ targetId } = await cdp.envoyer("Target.createTarget", { url: "about:blank", browserContextId, width: 1280, height: 900 }));
		const { sessionId } = await cdp.envoyer("Target.attachToTarget", { targetId, flatten: true });
		const s = (m, p) => cdp.envoyer(m, p, sessionId);
		await s("Page.enable");
		await s("Emulation.setFocusEmulationEnabled", { enabled: true });
		await s("Page.addScriptToEvaluateOnNewDocument", { source: `window.__WDD_CALE = ${JSON.stringify(config)};\n${cale}` });
		await s("Page.addScriptToEvaluateOnNewDocument", { source: scenarios });
		await s("Page.navigate", { url });
		const fin = Date.now() + DELAI_MODE_MS;
		let t = "";
		while (Date.now() < fin) {
			await sleep(250);
			try { t = (await s("Runtime.evaluate", { expression: LIRE_RESULTATS, returnByValue: true })).result.value || ""; } catch (e) { t = ""; }
			if (/^END$/m.test(t)) break;
		}
		// Diagnostic de la cale : minuteurs retenus pendant les écritures, et partis au plafond (une attente vaine). Un
		// minuteur parti au plafond est un ÉCHEC : l'instantané attendu après une écriture n'est jamais arrivé, et la cale
		// l'a masqué (les scénarios ne le vérifient pas toujours par le DOM).
		try {
			const d = (await s("Runtime.evaluate", { expression: "JSON.stringify((window.__T || {}).cale || null)", returnByValue: true })).result.value;
			if (d && d !== "null") {
				t += "\nINFO cale : " + d;
				const p = Number((JSON.parse(d) || {}).plafonds) || 0;
				if (p > 0) t += `\nFAIL cale : ${p} minuteur(s) partis au plafond (instantané attendu jamais reçu)`;
			}
		} catch (e) { }
		try { fs.writeFileSync(path.join(SORTIE, `dom_${mode}.html`), (await s("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true })).result.value || ""); } catch (e) { }
		return t || `FAIL pas de résultats (mode ${mode})`;
	} finally {
		if (targetId) await cdp.envoyer("Target.closeTarget", { targetId }).catch(() => { });
		await cdp.envoyer("Target.disposeBrowserContext", { browserContextId }).catch(() => { });
	}
}

// --- Déroulé -------------------------------------------------------------------------------------------------
async function principal() {
	fs.mkdirSync(SORTIE, { recursive: true });
	const donnees = path.join(SORTIE, "donnees");
	fs.rmSync(donnees, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	const S = await demarrerServeur(donnees);
	const base = S.url;
	journal(`serveur de test ${base} (PID ${S.pid}), données ${donnees}`);

	// Compte admin par le lien d'invitation affiché au démarrage (usage unique).
	const inv = await appel(base, "POST", "/invitation/" + S.jetonAdmin, { nom: "Banc admin" });
	const cookieAdmin = ((inv.entetes.get("set-cookie") || "").match(/wdd_session=[^;]+/) || [])[0];
	if (inv.status !== 303 || !cookieAdmin) throw new Error("invitation admin refusée : " + inv.status + " " + inv.texte);

	const data = fs.readFileSync(path.join(SITE, "examples", "data.json"));
	const notes = JSON.parse(fs.readFileSync(path.join(SITE, "examples", "notes_exemple.json"), "utf8"));
	const cale = fs.readFileSync(path.join(__dirname, "cale-http.js"), "utf8");
	const scenarios = fs.readFileSync(path.join(__dirname, "scenarios.js"), "utf8");

	cdp = await connecterCdp(await demarrerEdge(path.join(SORTIE, "edge_http")));
	const bilan = [];
	let echec = false;
	for (const mode of MODES) {
		if (SANS_OBJET[mode]) { console.log(`MODE ${mode}\nINFO sans objet en HTTP : ${SANS_OBJET[mode]}`); bilan.push(`${mode} sans objet`); continue; }
		const projet = "essai-" + mode;
		await exiger(base, "POST", "/api/admin/projets", { id: projet, titre: "Essai " + mode }, cookieAdmin);
		if (LENTEUR_MS) fs.writeFileSync(path.join(donnees, "projets", projet, "depot", ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep " + (LENTEUR_MS / 1000).toFixed(3) + "\n", { mode: 0o755 });
		await exiger(base, "POST", "/__test/notes", { projet, nom: "notes_exemple.json", notes });
		const b = await exiger(base, "POST", `/api/p/${projet}/builds`, undefined, cookieAdmin, data);
		let url = `${base}/__test/connexion?projet=${projet}&compte=essai&role=contributeur&nom=essai&suite=${encodeURIComponent(`/p/${projet}/`)}`;
		const config = { mode, projet, attendreInstantane: ATTENDRE_INSTANTANE.has(mode) };
		if (mode === "readonly") {
			// Comme le banc : un retour d'un autre lecteur (question) sur le premier élément marqué de l'exemple.
			const iso = m => new Date(Date.now() - m * 60000).toISOString();
			await exiger(base, "POST", "/__test/mettre", { projet, id: "seedro", donnees: { kind: "plante", ref: "tomate", name: "Tomate", tab: "plantes", anchor: "plantes--tomate", cat: "idee", text: "Retour d'un autre lecteur.", proposal: "", status: "question", reply: "Une question ?", replied: iso(5), created: iso(60), updated: iso(5), by: "autre", codex: "" } });
		}
		if (["readonly", "denywrite", "quota", "unavailable", "revoked", "silent", "snapretry"].includes(mode)) await exiger(base, "POST", "/__test/mode", { projet, mode });
		if (mode === "nodb") {
			// Session finie alors que la page est servie : le projet répond 401 partout (mode revoked déjà déclenché).
			const s = await exiger(base, "POST", "/__test/session", { projet, compte: "banc", role: "contributeur" });
			await exiger(base, "POST", "/__test/mode", { projet, mode: "revoked" });
			await couperUnFlux(base, projet, "wdd_session=" + s.corps.session);
			const r = await appel(base, "GET", `/api/p/${projet}/session`, undefined, "wdd_session=" + s.corps.session);
			if (r.status !== 401) throw new Error("nodb : la session devrait répondre 401, reçu " + r.status);
		}
		if (mode === "offline") {
			// La page servie, enregistrée telle quelle, puis ouverte comme fichier.
			const s = await exiger(base, "POST", "/__test/session", { projet, compte: "essai", role: "contributeur" });
			const r = await exiger(base, "GET", `/p/${projet}/`, undefined, "wdd_session=" + s.corps.session);
			const f = path.join(SORTIE, "page_http_offline.html");
			fs.writeFileSync(f, r.texte);
			url = pathToFileURL(f).href;
			config.projet = "";
		}
		const t = await jouer(mode, url, config, cale, scenarios);
		console.log(t);
		const nPass = (t.match(/^PASS /mg) || []).length;
		const ko = /^FAIL/m.test(t) || !/^END$/m.test(t);
		if (ko) echec = true;
		bilan.push(`${mode} ${nPass}${ko ? " (ÉCHEC)" : ""}`);
		journal(`mode ${mode} : ${nPass} PASS${ko ? ", ÉCHEC" : ""} (build ${b.corps && b.corps.build})`);
	}

	// Critère 5 : historique du projet après le scénario normal.
	const depotNormal = path.join(donnees, "projets", "essai-normal", "depot");
	if (fs.existsSync(depotNormal)) {
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(donnees, "gitconfig") };
		const log = execFileSync("git", ["-C", depotNormal, "log", "--reverse", "--format=%h %an <%ae> | %s"], { env, encoding: "utf8" });
		fs.writeFileSync(path.join(SORTIE, "git_log_normal.txt"), log);
		journal(`git log de essai-normal : ${log.trim().split("\n").length} commits (git_log_normal.txt)`);
	}
	console.log("BILAN " + bilan.join(", "));
	return echec;
}

async function arreter() {
	if (cdp) { await Promise.race([cdp.envoyer("Browser.close").catch(() => { }), sleep(3000)]); cdp.fermer(); }
	if (edge && edge.exitCode === null) { await sleep(500); if (edge.exitCode === null) { try { edge.kill(); } catch (e) { } } }
	if (serveur && serveur.exitCode === null) {
		const pid = serveur.pid;
		serveur.kill();
		await Promise.race([new Promise(r => serveur.once("exit", r)), sleep(5000)]);
		journal(`serveur arrêté (PID ${pid})`);
	}
}

principal().then(async echec => {
	await arreter();
	console.log(echec ? "DES ÉCHECS" : "TOUT PASSE");
	process.exit(echec ? 1 : 0);
}, async e => {
	console.error("FAIL " + ((e && e.stack) || e));
	await arreter();
	console.log("DES ÉCHECS");
	process.exit(1);
});
