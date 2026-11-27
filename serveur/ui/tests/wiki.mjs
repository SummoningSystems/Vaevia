// Wiki de l'étape 3.7 dans Edge (ou Chrome) sans fenêtre : ce qui est servi par le vrai serveur, page construite par
// site/build.js. Lot 1 : onglet « Changements » et pastilles (L1), retours sur des éléments disparus et anciennes refs
// (G1). Lot 2 : boîte « À moi » de l'Accueil (E1), vue tableau d'un onglet (L2). Lot 3 : série de retours (R1). Lot 4 : bloc Notifications de l'écran Membres (I1). Lot 5 : capture jointe à un retour (R2). Chaque lot suivant ajoute sa partie ici.
//   node serveur/ui/tests/wiki.mjs <dossier de sortie hors dépôt> <navigateur>
// Serveur de test (WDD_TEST=1, port libre, jamais 8080, données dans <sortie>/donnees), APPDATA et LOCALAPPDATA
// détournés vers <sortie>. Affiche PASS / FAIL par vérification et un BILAN ; captures dans <sortie>. Code 1 si un FAIL.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

const RACINE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
const [OUT, NAV] = process.argv.slice(2);
if (!OUT || !NAV) { console.error("usage : node serveur/ui/tests/wiki.mjs <dossier de sortie> <navigateur>"); process.exit(2); }
const SORTIE = path.join(path.resolve(OUT), "wiki"); fs.rmSync(SORTIE, { recursive: true, force: true }); fs.mkdirSync(SORTIE, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
	if (cond) { pass++; console.log("PASS " + msg); }
	else { fail++; console.log("FAIL " + msg + (extra !== undefined ? "  :: " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const port = await new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
if (port === 8080) throw new Error("port 8080 refusé");
const U = `http://127.0.0.1:${port}`;
// Destinataire de webhook local (I1) : WDD_NOTIF_LOCALES=1 permet son adresse http://127.0.0.1.
const http = await import("node:http");
const recus = [];
const recepteur = http.createServer((req, res) => { let t = ""; req.on("data", c => t += c); req.on("end", () => { recus.push(t); res.writeHead(204); res.end(); }); });
await new Promise(r => recepteur.listen(0, "127.0.0.1", r));
const URL_CROCHET = `http://127.0.0.1:${recepteur.address().port}/crochet`;
const env = { ...process.env, WDD_NOTIF_LOCALES: "1", WDD_DONNEES: path.join(SORTIE, "donnees"), WDD_TEST: "1", WDD_PORT: String(port), WDD_HOTE: "127.0.0.1", WDD_URL: U, APPDATA: path.join(SORTIE, "a"), LOCALAPPDATA: path.join(SORTIE, "l") };
for (const k of ["WDD_URL_PAGES", "WDD_HTTPS", "WDD_UI", "WDD_SITE", "WDD_SAUVEGARDE"]) delete env[k];
const serveur = spawn(process.execPath, [path.join(RACINE, "serveur", "src", "principal.ts")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
await new Promise((r, ko) => { let t = ""; const f = setTimeout(() => ko(new Error("serveur pas démarré : " + t)), 30000); const l = b => { t += b; if (/à l'écoute sur/.test(t)) { clearTimeout(f); r(); } }; serveur.stdout.on("data", l); serveur.stderr.on("data", l); });

let nav;
async function appel(m, c, { corps, brut, cookie } = {}) {
	const h = {}; if (corps || brut) h["Content-Type"] = "application/json"; if (cookie) h.Cookie = cookie; if (m !== "GET") h["X-WDD"] = "1";
	const r = await fetch(U + c, { method: m, headers: h, body: brut ?? (corps ? JSON.stringify(corps) : undefined) });
	const t = await r.text(); if (r.status >= 300) throw new Error(`${m} ${c} ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : null;
}
try {
	const P = "jardin", iso = new Date().toISOString();
	const exemple = () => JSON.parse(fs.readFileSync(path.join(RACINE, "site", "examples", "data.json"), "utf8"));
	const item = (d, tab, id) => d.tabs.find(t => t.id === tab).sections.flatMap(s => s.items).find(i => i.id === id);
	const doc = (ref, extra = {}) => ({ kind: "plante", ref, name: ref, tab: "plantes", anchor: "plantes--" + ref, cat: "idee", text: "Retour sur " + ref, proposal: "", status: "nouveau", reply: "", replied: "", created: iso, updated: iso, by: "benoit", codex: "", ...extra });
	const prep = await appel("POST", "/__test/preparer", { corps: { projet: P, titre: "Jardin", comptes: [{ id: "benoit", nom: "Benoît", role: "admin" }, { id: "camille", nom: "Camille", role: "contributeur" }],
		retours: [{ id: "rtomate", donnees: doc("tomate") }, { id: "rpoivron", donnees: doc("poivron") }, { id: "rbasilic", donnees: doc("basilic") },
		{ id: "rquestion", donnees: doc("basilic", { text: "Combien de feuilles ?", status: "question", reply: "Plutôt 4 ou 5 feuilles par pied ?", replied: iso }) }] } });
	const ck = prep.comptes[0].cookie, ckCamille = prep.comptes[1].cookie;
	// Build 1 : l'exemple. Build 2 : tomate renommée (ancienne ref déclarée), courgette modifiée, poivron retiré.
	// Étape 3.9, L4 : statut et origine, les mêmes dans les deux builds (les comptes de changements restent ceux du lot 1).
	const marquer = x => { Object.assign(item(x, "plantes", "courgette"), { statut: "specifie", origine: "equipe" }); Object.assign(item(x, "plantes", "basilic"), { statut: "idee", origine: "agent" }); return x; };
	await appel("POST", `/api/p/${P}/builds`, { brut: JSON.stringify(marquer(exemple())), cookie: ck });
	const d = marquer(exemple());
	const t = item(d, "plantes", "tomate"); t.id = "tomate-coeur"; t.name = "Tomate cœur de bœuf"; t.anciennes_refs = ["tomate"];
	for (const tb of d.tabs) for (const s of tb.sections) for (const it of s.items) if (it.links) it.links = it.links.map(l => l[1] === "#plantes--tomate" ? [l[0], "#plantes--tomate-coeur"] : l);
	const courgette = item(d, "plantes", "courgette"); courgette.fields = courgette.fields.map(f => f[0] === "Arrosage" ? ["Arrosage", "tous les 3 jours"] : f);
	const sec = d.tabs[0].sections[0]; sec.items = sec.items.filter(i => i.id !== "poivron");
	for (const tb of d.tabs) for (const s of tb.sections) for (const it of s.items) if (it.links) it.links = it.links.filter(l => l[1] !== "#plantes--poivron");
	// Notes de l'exemple (4 points à valider) avant le build 2 : la boîte « À moi » les montre.
	const notes = JSON.parse(fs.readFileSync(path.join(RACINE, "site", "examples", "notes_exemple.json"), "utf8"));
	await appel("PUT", `/api/p/${P}/notes/notes_${notes.date}.json`, { corps: notes, cookie: ck });
	// L10 : image agrandie de la tomate (une seconde image, distincte de la petite).
	const GRANDE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==";
	t.image_grande = GRANDE;
	const b2 = await appel("POST", `/api/p/${P}/builds`, { brut: JSON.stringify(d), cookie: ck });
	// L7 : un ticket cite la courgette (titre avec du balisage, à échapper).
	const tk = await appel("POST", `/api/p/${P}/tickets`, { corps: { titre: "Courgette <b>grimpante</b>", pages: ["plante:courgette"] }, cookie: ck });
	ok(/changements : 2 modifiés, 0 ajoutés, 1 retirés/.test(b2.resume), "build 2 : résumé des changements", b2.resume);
	ok(b2.avertissements.some(a => /^1 retour ouvert sur des éléments absents de ce build : plante\/poivron \(1\)/.test(a)), "build 2 : avertissement poivron seulement (tomate suivie par son ancienne ref)", b2.avertissements);

	// Navigateur.
	const profil = path.join(SORTIE, "profil"); fs.mkdirSync(profil);
	nav = spawn(NAV, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profil}`, "--window-size=1280,900", "--hide-scrollbars", "about:blank"], { stdio: "ignore", windowsHide: true });
	let ws; for (let i = 0; i < 150 && !ws; i++) { try { const [pp, c] = fs.readFileSync(path.join(profil, "DevToolsActivePort"), "utf8").split(/\r?\n/); if (pp && c) ws = `ws://127.0.0.1:${pp}${c}`; } catch { } await sleep(200); }
	const sock = new WebSocket(ws); await new Promise((r, ko) => { sock.onopen = r; sock.onerror = ko; });
	let n = 0; const att = new Map();
	sock.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id && att.has(m.id)) { const a = att.get(m.id); att.delete(m.id); m.error ? a.ko(new Error(m.error.message)) : a.ok(m.result || {}); } };
	const cdp = (method, params = {}, sessionId) => new Promise((r, ko) => { const id = ++n; att.set(id, { ok: r, ko }); sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
	const s = (m, p) => cdp(m, p, sessionId);
	await s("Page.enable"); await s("Runtime.enable");
	await s("Page.addScriptToEvaluateOnNewDocument", { source: `window.__csp=[];window.__err=[];document.addEventListener("securitypolicyviolation",e=>__csp.push(e.violatedDirective+" "+e.blockedURI));addEventListener("error",e=>__err.push(String(e.message)));` });
	const ev = async x => { const r = await s("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || "")); return r.result.value; };
	const attendre = async (x, ms = 8000) => { const fin = Date.now() + ms; while (Date.now() < fin) { if (await ev(x).catch(() => false)) return true; await sleep(100); } return false; };
	const capture = async nom => { const x = await s("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SORTIE, nom + ".png"), Buffer.from(x.data, "base64")); };
	await s("Page.navigate", { url: `${U}/__test/connexion?projet=${P}&compte=benoit&role=admin&nom=Beno%C3%AEt&suite=/p/${P}/` });
	ok(await attendre(`location.pathname==="/p/${P}/" && !!document.querySelector("#fb-fab:not([hidden])") && !!document.querySelector(".fb-btn")`), "Wiki chargé, retours branchés");
	await attendre(`[...document.querySelectorAll(".fb-btn .lbl")].some(x => /retour/.test(x.textContent))`);

	// L1 : onglet Changements, lien de la ligne méta, pastilles.
	const l1 = await ev(`(() => { const t = document.getElementById("t-changements"); const meta = [...document.querySelectorAll("#meta-line a")].map(a => a.textContent.trim());
		const pill = id => { const c = document.getElementById(id); const p = c && c.querySelector(".chg-pill"); return p ? p.textContent : null; };
		return { onglet: t && t.querySelector(".tl").textContent.trim(), ordre: [...document.querySelectorAll("#tabs [data-tab-btn]")].map(b => b.dataset.tabBtn), meta, courgette: pill("plantes--courgette"), tomate: pill("plantes--tomate-coeur"), basilic: pill("plantes--basilic") }; })()`);
	ok(l1.onglet === "Changements", "onglet Changements présent", l1);
	ok(l1.ordre.indexOf("changements") === l1.ordre.indexOf("regles") + 1 && l1.ordre.indexOf("changements") < l1.ordre.indexOf("nouveautes") || (l1.ordre.at(-1) === "changements" && !l1.ordre.includes("nouveautes")), "Changements après les onglets du projet, avant les notes", l1.ordre);
	ok(l1.meta.some(x => /^Changements · 3$/.test(x)), "ligne méta : Changements · 3", l1.meta);
	ok(l1.courgette === "modifié" && l1.tomate === "modifié" && l1.basilic === null, "pastilles « modifié » sur courgette et tomate renommée, rien sur basilic", l1);
	await ev(`document.getElementById("t-changements").click(); 0`); await sleep(150);
	const panneau = await ev(`(() => { const p = document.getElementById("tab-changements"); return { h2: [...p.querySelectorAll("h2")].map(h => h.textContent.replace(/\\s+/g, " ").trim()), lignes: [...p.querySelectorAll(".row.dif")].map(r => r.textContent.replace(/\\s+/g, " ").trim()), liens: [...p.querySelectorAll("a[data-nav]")].map(a => a.dataset.nav) }; })()`);
	ok(JSON.stringify(panneau.h2) === JSON.stringify(["Modifiés 2", "Retirés 1"]), "groupes Modifiés 2 et Retirés 1", panneau.h2);
	ok(panneau.lignes.some(l => /Courgette/.test(l) && /Arrosage/.test(l) && /tous les 3 jours/.test(l)), "courgette : Arrosage avant → après", panneau.lignes);
	ok(panneau.lignes.some(l => /Tomate cœur de bœuf/.test(l) && /Reftomate→tomate-coeur/.test(l.replace(/ /g, ""))), "tomate : Ref tomate → tomate-coeur", panneau.lignes);
	ok(panneau.lignes.some(l => /Poivron/.test(l) && /retiré de cette version/.test(l)), "poivron : retiré", panneau.lignes);
	ok(panneau.liens.includes("plantes--courgette") && !panneau.liens.includes("plantes--poivron"), "liens vers les fiches, pas vers un élément retiré", panneau.liens);
	await capture("changements-clair");
	await ev(`document.querySelector('#tab-changements a[data-nav="plantes--courgette"]').click(); 0`); await sleep(300);
	ok(await ev(`!document.getElementById("tab-plantes").hidden && location.hash === "#plantes--courgette"`), "un lien ouvre la fiche dans son onglet");
	await ev(`document.getElementById("q").value = "arrosage"; document.getElementById("q").dispatchEvent(new Event("input")); document.getElementById("t-changements").click(); 0`); await sleep(150);
	ok(await ev(`[...document.querySelectorAll("#tab-changements .row.dif")].filter(r => !r.hidden).length === 1`), "la recherche filtre les changements (arrosage : courgette seule)");
	await ev(`document.getElementById("q").value = ""; document.getElementById("q").dispatchEvent(new Event("input")); 0`);

	// G1 : ancienne ref suivie sur la fiche ; retour sans fiche dans « Tous les retours ».
	const bt = await ev(`document.querySelector("#plantes--tomate-coeur .fb-btn .lbl").textContent`);
	ok(/1 retour/.test(bt), "fiche renommée : le retour de l'ancienne ref y est compté", bt);
	await ev(`document.querySelector("#plantes--tomate-coeur .fb-btn").click(); 0`); await sleep(200);
	ok(await ev(`/Retour sur tomate/.test(document.getElementById("fb-listwrap").textContent)`), "tiroir de la fiche renommée : le retour de l'ancienne ref");
	await ev(`document.getElementById("fb-close").click(); document.getElementById("fb-fab").click(); 0`); await sleep(200);
	const g1 = await ev(`(() => { const b = document.querySelector('.fb-filter [data-filter="orphelins"]'); return { b: b && b.textContent, filtres: [...document.querySelectorAll(".fb-filter button")].map(x => x.dataset.filter) }; })()`);
	ok(g1.b === "Sans fiche · 1", "filtre « Sans fiche · 1 »", g1);
	await ev(`document.querySelector('.fb-filter [data-filter="orphelins"]').click(); 0`); await sleep(100);
	const orph = await ev(`[...document.querySelectorAll("#fb-listwrap .fb-item")].map(x => x.textContent.replace(/\\s+/g, " ").trim())`);
	ok(orph.length === 1 && /Retour sur poivron/.test(orph[0]) && /absent de cette version/.test(orph[0]), "le retour sur le poivron, marqué absent", orph);
	await ev(`document.querySelector('.fb-filter [data-filter="tous"]').click(); 0`); await sleep(100);
	const tous = await ev(`[...document.querySelectorAll("#fb-listwrap .fb-item")].filter(x => /absent de cette version/.test(x.textContent)).length`);
	ok(tous === 1, "vue Tous : seule la ligne du poivron porte la mention", tous);
	await capture("sans-fiche");
	await ev(`document.getElementById("fb-close").click(); 0`);

	// L2 : vue tableau de l'onglet Plantes (5 éléments après le build 2, champs communs Semis, Récolte, Arrosage).
	await ev(`document.getElementById("t-plantes").click(); window.scrollTo(0, 0); 0`); await sleep(150);
	const avant = await ev(`({ choix: [...document.querySelectorAll("#tab-plantes .vue-choix [data-vue]")].map(b => b.textContent + ":" + b.getAttribute("aria-pressed")), lignes: document.querySelectorAll("#tab-plantes .vt-ligne").length, regles: !!document.querySelector("#tab-regles .vue-choix") })`);
	ok(JSON.stringify(avant.choix) === JSON.stringify(["Fiches:true", "Tableau:false"]) && avant.lignes === 0, "bascule Fiches / Tableau ; tableau pas construit tant qu'on ne s'en sert pas", avant);
	await ev(`document.querySelector('#tab-plantes [data-vue="tableau"]').click(); 0`); await sleep(200);
	const vt = await ev(`(() => { const p = document.getElementById("tab-plantes"); const t = p.querySelector(".vt table");
		return { mode: p.classList.contains("mode-tableau"), cartes: [...p.querySelectorAll(".card")].filter(c => c.getClientRects().length).length, entetes: [...t.tHead.rows[0].cells].map(c => c.textContent.trim()),
			lignes: [...t.tBodies[0].rows].map(r => r.cells[0].textContent.trim()), boutons: p.querySelectorAll(".vt-ligne .fb-btn").length,
			basilic: (p.querySelector('.vt-ligne[data-fb-id="basilic"] .fb-btn .lbl') || {}).textContent }; })()`);
	ok(vt.mode && vt.cartes === 0, "mode tableau : fiches masquées", vt);
	ok(JSON.stringify(vt.entetes.slice(0, 2)) === JSON.stringify(["Nom", "Section"]) && ["Semis", "Récolte", "Arrosage"].every(c => vt.entetes.includes(c)) && vt.entetes.at(-1) === "Retours", "colonnes : Nom, Section, champs communs, Retours", vt.entetes);
	ok(vt.lignes.length === 5 && vt.boutons === 5, "une ligne et un bouton de retour par élément", vt);
	ok(/2 retours · 1 question/.test(vt.basilic || ""), "bouton de la ligne : mêmes compteurs que la fiche", vt.basilic);
	await ev(`document.querySelector('#tab-plantes .vt thead [data-tri="0"]').click(); 0`); await sleep(50);
	const tri1 = await ev(`[...document.querySelectorAll("#tab-plantes .vt tbody tr")].map(r => r.cells[0].textContent.trim())`);
	await ev(`document.querySelector('#tab-plantes .vt thead [data-tri="0"]').click(); 0`); await sleep(50);
	const tri2 = await ev(`({ l: [...document.querySelectorAll("#tab-plantes .vt tbody tr")].map(r => r.cells[0].textContent.trim()), s: document.querySelector('#tab-plantes .vt thead th').getAttribute("aria-sort") })`);
	ok(JSON.stringify(tri1) === JSON.stringify([...tri1].sort((a, b) => a.localeCompare(b, "fr"))) && JSON.stringify(tri2.l) === JSON.stringify([...tri1].reverse()) && tri2.s === "descending", "tri par nom, puis sens inverse (aria-sort)", { tri1, tri2 });
	await ev(`document.getElementById("q").value = "basilic"; document.getElementById("q").dispatchEvent(new Event("input")); 0`); await sleep(100);
	ok(await ev(`[...document.querySelectorAll("#tab-plantes .vt-ligne")].filter(r => !r.hidden).length === 1 && document.querySelector("#t-plantes .n").textContent === "1"`), "recherche en mode tableau : une ligne, compteur de l'onglet à 1");
	await ev(`document.getElementById("q").value = ""; document.getElementById("q").dispatchEvent(new Event("input")); 0`);
	await ev(`document.querySelector('#tab-plantes .vt-ligne[data-fb-id="persil"] .fb-btn').click(); 0`); await sleep(200);
	ok(await ev(`!document.getElementById("fb-panel").hidden && document.getElementById("fb-title").textContent === "Persil"`), "le bouton d'une ligne ouvre le tiroir de l'élément");
	await ev(`document.getElementById("fb-close").click(); 0`);
	await capture("tableau-clair");
	await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
	const t390 = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, tbl: (() => { const b = document.querySelector("#tab-plantes .vt"); return b.scrollWidth > b.clientWidth; })() })`);
	ok(t390.sw <= t390.cw, "390 px : le tableau défile seul, pas la page", t390);
	await capture("tableau-390");
	await s("Emulation.clearDeviceMetricsOverride");
	// Choix retenu au rechargement ; un lien vers une fiche repasse l'onglet en fiches.
	await s("Page.reload"); await attendre(`!!document.querySelector(".fb-btn")`); await sleep(400);
	ok(await ev(`document.getElementById("tab-plantes").classList.contains("mode-tableau") && document.querySelectorAll("#tab-plantes .vt-ligne .fb-btn").length === 5`), "rechargé : mode tableau retenu, boutons posés");
	await ev(`document.querySelector('#tab-plantes .vt-ligne[data-fb-id="persil"] a[data-nav]').click(); 0`); await sleep(300);
	ok(await ev(`!document.getElementById("tab-plantes").classList.contains("mode-tableau") && location.hash === "#plantes--persil" && document.getElementById("plantes--persil").getClientRects().length > 0`), "le nom d'une ligne mène à la fiche (retour en fiches)");

	// R1 : série de retours (brouillons dans le navigateur, puis un envoi, un commit).
	const nbServeur = async () => (await appel("GET", `/api/p/${P}/retours`, { cookie: ck })).docs.length;
	const depotP = path.join(SORTIE, "donnees", "projets", P, "depot");
	const { execFileSync } = await import("node:child_process");
	const dernierCommit = () => execFileSync("git", ["-C", depotP, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
	const barreSerie = () => ev(`(() => { const b = document.getElementById("fb-serie"); return b ? { actif: b.classList.contains("active"), texte: b.textContent.replace(/\\s+/g, " ").trim(), envoi: !!b.querySelector('[data-serie="send"]') && b.querySelector('[data-serie="send"]').disabled } : null; })()`);
	const ecrire = async (id, texte) => {
		await ev(`document.querySelector("#plantes--" + ${JSON.stringify(id)} + " .fb-btn").click(); 0`); await sleep(150);
		await ev(`document.getElementById("fb-text").value = ${JSON.stringify(texte)}; document.getElementById("fb-send").click(); 0`); await sleep(150);
	};
	await ev(`document.getElementById("t-plantes").click(); 0`); await sleep(100);
	let bs = await barreSerie();
	ok(bs && !bs.actif && bs.texte === "Commencer une série", "barre : « Commencer une série »", bs);
	const n0 = await nbServeur();
	await ev(`document.querySelector('[data-serie="start"]').click(); 0`); await sleep(100);
	bs = await barreSerie();
	ok(bs.actif && /Série en cours · 0 brouillon/.test(bs.texte) && bs.envoi === true && /gardés dans ce navigateur/.test(bs.texte), "série commencée : 0 brouillon, envoi désactivé, avertissement navigateur", bs);
	await ev(`document.querySelector("#plantes--courgette .fb-btn").click(); 0`); await sleep(150);
	ok(await ev(`document.getElementById("fb-send").textContent === "Ajouter à la série"`), "formulaire : « Ajouter à la série »");
	await ev(`document.getElementById("fb-text").value = "Feuilles trop grandes"; document.getElementById("fb-send").click(); 0`); await sleep(150);
	const sg1 = await ev(`({ st: document.getElementById("fb-status").textContent, br: [...document.querySelectorAll("#fb-listwrap .st-brouillon")].map(x => x.textContent.replace(/\\s+/g, " ").trim()), lbl: document.querySelector("#plantes--courgette .fb-btn .lbl").textContent })`);
	ok(/Gardé dans la série \(1 en tout\)/.test(sg1.st) && sg1.br.length === 1 && /Brouillon/.test(sg1.br[0]) && /Feuilles trop grandes/.test(sg1.br[0]), "brouillon gardé, visible dans le tiroir de la fiche", sg1);
	ok(sg1.lbl === "✎ 1 brouillon", "bouton de la fiche : « 1 brouillon »", sg1.lbl);
	await ecrire("persil", "Persil plat plutôt");
	await ecrire("ciboulette", "À retirer");
	ok(await nbServeur() === n0, "rien n'est parti au serveur pendant la série");
	await ev(`document.querySelector('[data-draft-del]').click(); 0`); await sleep(100);
	bs = await barreSerie();
	ok(/2 brouillons/.test(bs.texte), "« Retirer de la série » : 2 brouillons", bs.texte);
	await ev(`document.getElementById("fb-close").click(); 0`);
	await s("Page.reload"); await attendre(`!!document.getElementById("fb-serie")`); await sleep(300);
	bs = await barreSerie();
	ok(bs && bs.actif && /2 brouillons/.test(bs.texte), "rechargé : la série et ses brouillons sont toujours là", bs);
	await ev(`document.getElementById("fb-fab").click(); 0`); await sleep(150);
	ok(await ev(`/Brouillons de la série · 2/.test(document.getElementById("fb-listwrap").textContent)`), "vue Tous : brouillons en tête");
	await ev(`document.getElementById("fb-close").click(); 0`);
	await capture("serie-en-cours");
	await ev(`document.querySelector('[data-serie="send"]').click(); 0`);
	ok(await attendre(`/Série envoyée : 2 retours\\. Pour la faire traiter : onglet Retours du bandeau/.test(document.getElementById("fb-serie").textContent)`), "envoyée : message et où demander le traitement");
	ok(await nbServeur() === n0 + 2 && dernierCommit() === "série : 2 retours", "serveur : 2 retours de plus, un commit « série : 2 retours »", dernierCommit());
	ok(await attendre(`/1 retour · 1 en attente/.test(document.querySelector("#plantes--courgette .fb-btn .lbl").textContent)`), "la fiche montre le retour envoyé");
	// Abandon : deux clics, rien envoyé.
	await ev(`document.querySelector('[data-serie="start"]').click(); 0`); await sleep(50);
	await ecrire("basilic", "Brouillon abandonné");
	await ev(`document.getElementById("fb-close").click(); document.querySelector('[data-serie="drop"]').click(); 0`); await sleep(50);
	ok(await ev(`!!document.querySelector('[data-serie="drop-ok"]') && document.activeElement === document.querySelector('[data-serie="drop-ok"]')`), "abandon : confirmation demandée (focus dessus)");
	await ev(`document.querySelector('[data-serie="drop-ok"]').click(); 0`); await sleep(100);
	bs = await barreSerie();
	ok(!bs.actif && await nbServeur() === n0 + 2 && !/brouillon/.test(await ev(`document.querySelector("#plantes--basilic .fb-btn .lbl").textContent`)), "abandonnée : rien envoyé, plus de brouillon", bs);

	// R2 : capture jointe (fichier choisi, puis image collée) ; réencodée par la page, envoyée, vignette affichée.
	await ev(`document.querySelector("#plantes--persil .fb-btn").click(); 0`); await sleep(150);
	ok(await ev(`!!document.querySelector('[data-cap-add]') && document.getElementById("fb-file").accept === "image/*"`), "formulaire : « Joindre une capture »");
	// Une image de 2400 × 1200 (plus grande que 1600 px) dessinée dans la page, mise dans le champ fichier.
	const fabriquer = `(async () => { const c = document.createElement("canvas"); c.width = 2400; c.height = 1200; const g = c.getContext("2d"); g.fillStyle = "#3a7"; g.fillRect(0, 0, 2400, 1200); g.fillStyle = "#fff"; g.fillRect(100, 100, 800, 400);
		const b = await new Promise(ok => c.toBlob(ok, "image/png")); return new File([b], "ecran.png", { type: "image/png" }); })()`;
	await ev(`(async () => { const f = await ${fabriquer}; const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById("fb-file"); i.files = dt.files; i.dispatchEvent(new Event("change")); return 0; })()`);
	ok(await attendre(`document.querySelectorAll("#fb-pieces .fb-piece").length === 1`), "capture choisie : réencodée, envoyée, vignette dans le formulaire");
	// Collage d'une image (Ctrl+V) dans le texte.
	await ev(`(async () => { const f = await ${fabriquer}; const dt = new DataTransfer(); dt.items.add(new File([await f.arrayBuffer()], "colle.png", { type: "image/png" })); document.getElementById("fb-text").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return 0; })()`);
	ok(await attendre(`!/Préparation/.test(document.getElementById("fb-status").textContent) && document.querySelectorAll("#fb-pieces .fb-piece").length === 1`), "image collée : prise ; la même image n’est gardée qu’une fois");
	await ev(`document.getElementById("fb-text").value = "Le menu déborde, voir la capture"; document.getElementById("fb-send").click(); 0`);
	ok(await attendre(`!!document.querySelector("#fb-listwrap .fb-caps img")`), "retour envoyé : vignette dans la liste");
	const cap = await ev(`(async () => { const im = document.querySelector("#fb-listwrap .fb-caps img"); if (!im.complete) await new Promise(r => im.onload = im.onerror = r); return { w: im.naturalWidth, h: im.naturalHeight, src: im.getAttribute("src") }; })()`);
	ok(cap.w === 1600 && cap.h === 800 && /^\/api\/p\/jardin\/captures\/[0-9a-f]{64}\.(webp|png)$/.test(cap.src), "capture servie, réduite à 1600 px, par la même origine", cap);
	const docCap = (await appel("GET", `/api/p/${P}/retours`, { cookie: ck })).docs.find(x => x.donnees.text === "Le menu déborde, voir la capture");
	ok(docCap && /^[0-9a-f]{64}\.(webp|png)( [0-9a-f]{64}\.(webp|png))?$/.test(docCap.donnees.captures), "le retour cite sa capture (champ captures)", docCap && docCap.donnees.captures);
	await ev(`document.querySelector("#fb-listwrap .fb-caps a").removeAttribute("target"); 0`);
	await capture("capture-retour");
	await ev(`document.getElementById("fb-close").click(); 0`);

	// Étape 3.9, lot 1 : statut et origine (L4), filtres (L4, L6), tickets de la fiche (L7), lien (L8), image agrandie
	// (L10), raccourcis (L12), impression (L11).
	const touche = async (key, code, vk, text) => { await s("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, text }); await s("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }); await sleep(120); };
	await ev(`document.getElementById("t-plantes").click(); window.scrollTo(0, 0); 0`); await sleep(150);
	const l4 = await ev(`({ c: [...document.querySelectorAll("#plantes--courgette .badge.st")].map(b => b.textContent), b: [...document.querySelectorAll("#plantes--basilic .badge.st")].map(b => b.textContent + (b.classList.contains("st-agent") ? "*" : "")),
		opts: [...document.querySelectorAll("#f-statut option")].map(o => o.value + "=" + o.textContent), vis: !document.getElementById("filtres").hidden && !document.getElementById("f-statut").hidden })`);
	ok(JSON.stringify(l4.c) === JSON.stringify(["spécifié", "équipe"]) && JSON.stringify(l4.b) === JSON.stringify(["idée", "proposé par l'agent*"]), "L4 : badges de statut et d'origine (agent mis en avant)", l4);
	ok(l4.vis && JSON.stringify(l4.opts) === JSON.stringify(["=Tout statut", "s:idee=idée", "s:specifie=spécifié", "o:agent=Proposé par l'agent", "o:equipe=équipe"]), "L4 : filtre avec les seules valeurs présentes", l4.opts);
	await ev(`{ const f = document.getElementById("f-statut"); f.value = "o:agent"; f.dispatchEvent(new Event("change")); } 0`); await sleep(100);
	const f4 = await ev(`({ v: [...document.querySelectorAll("#tab-plantes .card")].filter(c => !c.hidden).map(c => c.id), n: document.querySelector("#t-plantes .n").textContent, regles: document.querySelector("#t-regles .n").textContent })`);
	ok(JSON.stringify(f4.v) === JSON.stringify(["plantes--basilic"]) && f4.n === "1" && f4.regles === "0", "L4 : « Proposé par l'agent » ne garde que le basilic ; compteurs des onglets", f4);
	await ev(`{ const f = document.getElementById("f-statut"); f.value = ""; f.dispatchEvent(new Event("change")); } 0`); await sleep(100);
	ok(await ev(`!document.getElementById("f-ouverts-l").hidden`), "L6 : case « Avec retours ouverts » montrée, retours lus");
	await ev(`document.getElementById("f-ouverts").click(); 0`); await sleep(100);
	const l6 = await ev(`(() => { const c = [...document.querySelectorAll("#tab-plantes .card")]; return { v: c.filter(x => !x.hidden).map(x => x.id + ":" + x.dataset.fbOuverts), cachees: c.filter(x => x.hidden).map(x => x.id + ":" + x.dataset.fbOuverts) }; })()`);
	ok(l6.v.length > 0 && l6.cachees.length > 0 && l6.v.every(x => Number(x.split(":")[1]) > 0) && l6.cachees.every(x => x.split(":")[1] === "0"), "L6 : seules les fiches avec retours ouverts restent", l6);
	await ev(`document.getElementById("f-ouverts").click(); 0`); await sleep(100);
	ok(await ev(`[...document.querySelectorAll("#tab-plantes .card")].every(c => !c.hidden)`), "L6 : décochée, toutes les fiches reviennent");
	const l7 = await ev(`(() => { const t = document.querySelector("#plantes--courgette .fb-tk"); const a = t && t.querySelector("a"); return t ? { txt: t.textContent.replace(/\\s+/g, " ").trim(), href: a && a.getAttribute("href"), b: !!t.querySelector("b"), autres: document.querySelectorAll(".fb-tk").length } : null; })()`);
	ok(l7 && l7.txt === `Tickets : ${tk.id} · Courgette <b>grimpante</b> (à faire)` && l7.href === `/#/p/${P}/t/${tk.id}` && !l7.b && l7.autres === 1, "L7 : ligne Tickets sur la fiche citée, titre échappé, lien vers le ticket", l7);
	await s("Browser.grantPermissions", { origin: U, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => { });
	await ev(`document.querySelector("#plantes--persil .lien-btn").click(); 0`); await sleep(200);
	const l8 = await ev(`(async () => ({ b: document.querySelector("#plantes--persil .lien-btn").textContent, clip: await navigator.clipboard.readText().catch(e => "?" + e.message), annonce: document.getElementById("annonce").textContent }))()`);
	ok(l8.b === "Lien copié" && l8.clip === `${U}/p/${P}/#plantes--persil` && l8.annonce === "Lien copié", "L8 : « Lien » copie l'adresse de la fiche, annoncée", l8);
	await ev(`{ const b = document.querySelector("#plantes--tomate-coeur button.zoom"); b.focus(); b.click(); } 0`); await sleep(200);
	const l10 = await ev(`({ open: document.getElementById("zoom-dlg").open, src: document.getElementById("zoom-img").getAttribute("src"), t: document.getElementById("zoom-t").textContent })`);
	ok(l10.open && l10.src === GRANDE && l10.t === "Tomate cœur de bœuf", "L10 : clic sur l'image : fenêtre avec l'image grande", { open: l10.open, t: l10.t, grande: l10.src === GRANDE });
	await capture("image-agrandie");
	await touche("Escape", "Escape", 27);
	ok(await ev(`!document.getElementById("zoom-dlg").open && document.activeElement === document.querySelector("#plantes--tomate-coeur button.zoom")`), "L10 : Échap ferme, le focus revient sur l'image");
	await ev(`document.activeElement.blur(); window.scrollTo(0, 0); 0`);
	await touche("j", "KeyJ", 74, "j");
	const j1 = await ev(`document.activeElement.id`);
	await touche("j", "KeyJ", 74, "j");
	const j2 = await ev(`document.activeElement.id`);
	await touche("k", "KeyK", 75, "k");
	const k1 = await ev(`document.activeElement.id`);
	const cartes = await ev(`[...document.querySelectorAll("#tab-plantes .card")].map(c => c.id)`);
	ok(j1 === cartes[1] && j2 === cartes[2] && k1 === cartes[1], "L12 : j et k passent d'une fiche à l'autre (depuis la tomate, fiche courante après l'image)", { j1, j2, k1, cartes: cartes.slice(0, 3) });
	await touche("r", "KeyR", 82, "r");
	ok(await ev(`!document.getElementById("fb-panel").hidden && document.getElementById("fb-title").textContent === document.querySelector("#" + ${JSON.stringify(cartes[1])} + " h3").textContent`), "L12 : r ouvre le retour de la fiche courante");
	await ev(`document.getElementById("fb-text").focus(); 0`);
	await touche("j", "KeyJ", 74, "j");
	ok(await ev(`document.activeElement.id === "fb-text" && document.getElementById("fb-text").value.endsWith("j")`), "L12 : jamais pendant une saisie");
	await ev(`document.getElementById("fb-text").value = ""; document.getElementById("fb-close").click(); document.activeElement.blur(); 0`);
	await touche("?", "Slash", 191, "?");
	ok(await ev(`document.getElementById("aide-dlg").open && document.querySelectorAll("#aide-l dt").length === 6`), "L12 : ? ouvre l'aide des raccourcis");
	await capture("aide-clavier");
	await touche("Escape", "Escape", 27);
	await touche("/", "Slash", 191, "/");
	ok(await ev(`document.activeElement === document.getElementById("q") && !document.getElementById("aide-dlg").open`), "L12 : / va dans la recherche");
	await ev(`document.activeElement.blur(); 0`);
	await s("Emulation.setEmulatedMedia", { media: "print" }); await sleep(200);
	const l11 = await ev(`({ panneaux: [...document.querySelectorAll(".panel")].map(p => getComputedStyle(p).display !== "none"), tete: getComputedStyle(document.getElementById("print-head")).display, txt: document.getElementById("print-head").textContent, onglets: getComputedStyle(document.getElementById("tabs")).display, bandeau: document.getElementById("wdd-bandeau") ? getComputedStyle(document.getElementById("wdd-bandeau")).display : "none" })`);
	ok(l11.panneaux.every(Boolean) && l11.tete === "block" && /^Potager Clair · build 2 · données du .* · imprimé le /.test(l11.txt) && l11.onglets === "none" && l11.bandeau === "none", "L11 : impression : tous les onglets à la suite, en-tête avec le build 2, sans onglets ni bandeau", l11);
	const pdf = await s("Page.printToPDF", { printBackground: false });
	fs.writeFileSync(path.join(SORTIE, "impression.pdf"), Buffer.from(pdf.data, "base64"));
	ok(!Buffer.from(pdf.data, "base64").toString("latin1").includes("wdd_"), "L11 : le PDF ne contient aucun jeton");
	await s("Emulation.setEmulatedMedia", { media: "" });
	await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
	await ev(`document.getElementById("t-plantes").click(); window.scrollTo(0, 0); 0`); await sleep(150);
	const p390 = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
	ok(p390.sw <= p390.cw, "390 px : filtres et pieds de fiche sans défilement horizontal", p390);
	await capture("lot39-390");
	await s("Emulation.clearDeviceMetricsOverride");

	// Étape 3.9, lot 2 : noms des auteurs (écart 31), champ visé (R3), proposition préremplie et gabarit de bug (R4),
	// « Pour » (E3), « Moi aussi » (R6), fusion d'un doublon (R5). Deux retours de Camille sur la ciboulette.
	const docsServeur = async () => (await appel("GET", `/api/p/${P}/retours`, { cookie: ck })).docs;
	const rc = (texte) => ({ kind: "plante", ref: "ciboulette", name: "Ciboulette", tab: "plantes", anchor: "plantes--ciboulette", cat: "idee", text: texte, proposal: "", status: "nouveau", reply: "", replied: "", created: iso, updated: iso, by: "", codex: "" });
	const c1 = (await appel("POST", `/api/p/${P}/retours`, { corps: rc("Les fleurs mauves sont comestibles : le dire."), cookie: ckCamille })).id;
	const c2 = (await appel("POST", `/api/p/${P}/retours`, { corps: rc("Dire que les fleurs se mangent."), cookie: ckCamille })).id;
	await s("Page.reload"); await attendre(`!!document.querySelector(".fb-btn")`); await sleep(500);
	await ev(`document.getElementById("t-plantes").click(); 0`);
	await ev(`{ const b = document.querySelector('#plantes--courgette .fb-champ[data-fb-field="Arrosage"]'); b.focus(); b.click(); } 0`); await sleep(250);
	const r3 = await ev(`({ open: !document.getElementById("fb-panel").hidden, titre: document.getElementById("fb-title").textContent, chip: (document.querySelector(".fb-champ-chip") || {}).textContent, pour: [...document.querySelectorAll("#fb-pour option")].map(o => o.value + "=" + o.textContent) })`);
	ok(r3.open && r3.titre === "Courgette" && /Champ : Arrosage/.test(r3.chip || ""), "R3 : un clic sur le libellé « Arrosage » ouvre un retour sur ce champ", r3);
	ok(JSON.stringify(r3.pour) === JSON.stringify(["=personne en particulier", "benoit=Benoît (toi)", "camille=Camille"]), "E3 / écart 31 : « Pour » propose les membres par leur nom", r3.pour);
	await ev(`document.querySelector('.fb-cats [data-cat="fort"]').click(); 0`);
	const r4a = await ev(`document.getElementById("fb-prop").value`);
	await ev(`document.querySelector('.fb-cats [data-cat="bug"]').click(); 0`);
	const r4b = await ev(`document.getElementById("fb-text").value`);
	await ev(`document.querySelector('.fb-cats [data-cat="fort"]').click(); 0`);
	const r4c = await ev(`document.getElementById("fb-text").value`);
	ok(r4a === "tous les 3 jours" && /^Étapes :/.test(r4b) && r4c === "", "R4 : « Trop fort » part de la valeur actuelle ; « Bug » pose le gabarit, retiré s'il n'a pas été touché", { r4a, r4b, r4c });
	await ev(`document.getElementById("fb-prop").value = "tous les 4 jours"; document.getElementById("fb-pour").value = "camille"; document.getElementById("fb-text").value = "Trop d'eau pour une courgette"; document.getElementById("fb-send").click(); 0`);
	ok(await attendre(`/Envoyé/.test(document.getElementById("fb-status").textContent)`), "R3 : retour envoyé");
	const dc = (await docsServeur()).find(x => x.donnees.text === "Trop d'eau pour une courgette");
	ok(dc && dc.donnees.field === "Arrosage" && dc.donnees.proposal === "tous les 4 jours" && dc.donnees.pour === "camille" && dc.donnees.cat === "fort", "R3, E3 : le retour porte le champ visé, la proposition et « pour »", dc && dc.donnees);
	const ligneR3 = await ev(`[...document.querySelectorAll("#fb-listwrap .fb-item")].map(x => x.querySelector(".meta").textContent.replace(/\\s+/g, " ").trim())[0]`);
	ok(/Champ : Arrosage/.test(ligneR3) && /par toi/.test(ligneR3) && /Pour : Camille/.test(ligneR3), "liste : champ, auteur (« par toi ») et « Pour : Camille »", ligneR3);
	await ev(`document.getElementById("fb-close").click(); document.querySelector("#plantes--ciboulette .fb-btn").click(); 0`); await sleep(250);
	const r6a = await ev(`({ par: [...document.querySelectorAll("#fb-listwrap .fb-item .meta")].map(m => m.textContent).filter(t => /par Camille/.test(t)).length, boutons: document.querySelectorAll('#fb-listwrap [data-aussi]').length })`);
	ok(r6a.par === 2 && r6a.boutons === 2, "écart 31 : « par Camille » sur ses retours ; « Moi aussi » sur chacun", r6a);
	await ev(`document.querySelector('#fb-listwrap [data-aussi="${c1}"]').click(); 0`);
	ok(await attendre(`/Aussi : toi/.test(document.getElementById("fb-listwrap").textContent) && document.querySelector('[data-aussi="${c1}"]').textContent === "Je ne suis plus concerné"`), "R6 : « Moi aussi » : « Aussi : toi », le bouton s'inverse");
	ok((await docsServeur()).find(x => x.id === c1).donnees.aussi === "benoit", "R6 : enregistré sur le serveur (aussi = benoit)");
	await ev(`document.querySelector('#fb-listwrap [data-dup="${c2}"]').click(); 0`); await sleep(150);
	const opts = await ev(`[...document.querySelectorAll("#fb-dup-p option")].map(o => o.value)`);
	ok(opts.includes(c1) && !opts.includes(c2), "R5 : « Doublon de… » propose les autres retours de l'élément", opts);
	await ev(`document.getElementById("fb-dup-p").value = ${JSON.stringify(c1)}; document.querySelector('[data-dup-ok="${c2}"]').click(); 0`);
	ok(await attendre(`/Fusionné dans un autre retour/.test(document.getElementById("fb-listwrap").textContent)`), "R5 : le doublon s'affiche « Fusionné dans un autre retour »");
	const fz = await docsServeur();
	const D2 = fz.find(x => x.id === c2).donnees, D1 = fz.find(x => x.id === c1).donnees;
	ok(D2.status === "fait" && D2.fusionne_dans === c1 && D2.text === "Dire que les fleurs se mangent." && D1.aussi === "benoit", "R5 : serveur : doublon « fait », fusionne_dans, texte intact ; principal inchangé (même autrice)", { D2, aussi: D1.aussi });
	await ev(`{ const s = document.querySelector('[data-confier="${c1}"]'); s.value = "benoit"; s.dispatchEvent(new Event("change", { bubbles: true })); } 0`);
	ok(await attendre(`/Pour : toi/.test(document.getElementById("fb-listwrap").textContent)`), "E3 : un mainteneur confie le retour (« Pour : toi »)");
	await capture("lot2-retours");
	await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
	const l2390 = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, p: (() => { const p = document.getElementById("fb-panel"); return p.scrollWidth <= p.clientWidth + 1; })() })`);
	ok(l2390.sw <= l2390.cw && l2390.p, "390 px : tiroir des retours (doublon, confier) sans défilement horizontal", l2390);
	await capture("lot2-390");
	await s("Emulation.clearDeviceMetricsOverride");
	await ev(`document.getElementById("fb-close").click(); 0`);

	// Sombre et 390 px : onglet Changements sans défilement horizontal.
	await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await ev(`document.getElementById("t-changements").click(); window.scrollTo(0, 0); 0`); await sleep(200); await capture("changements-sombre");
	await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
	const l390 = await ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
	ok(l390.sw <= l390.cw, "390 px : pas de défilement horizontal sur Changements", l390);
	await capture("changements-390");
	await s("Emulation.clearDeviceMetricsOverride");
	const fin = await ev(`({ csp: window.__csp, err: window.__err })`);
	ok(!fin.csp.length, "aucune violation de CSP", fin.csp);
	ok(!fin.err.length, "aucune erreur JS", fin.err);

	// E1 : boîte « À moi » de l'Accueil.
	await s("Page.navigate", { url: `${U}/#/` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="a-moi"]')`), "Accueil : boîte « À moi »");
	const am = await ev(`(() => { const b = document.querySelector('[data-role="a-moi"]'); return { q: [...b.querySelectorAll('[data-type="question"]')].map(l => [l.textContent.replace(/\\s+/g, " ").trim(), l.querySelector("a").getAttribute("href")]),
		v: [...b.querySelectorAll('[data-type="a-valider"] a')].map(a => a.getAttribute("href")), ordre: [...document.querySelector("main, #app, body").querySelectorAll('[data-role="a-moi"], [data-role="projets"]')].map(x => x.dataset.role) }; })()`);
	ok(am.q.length === 1 && /Question basilic — Plutôt 4 ou 5 feuilles par pied \?/.test(am.q[0][0]) && am.q[0][1] === `/p/${P}/#plantes--basilic`, "question de l'agent sur mon retour, avec la question et le lien vers la fiche", am.q);
	ok(am.v.length === 4 && am.v.every(h => h.startsWith(`/p/${P}/#a-valider--`)), "4 points à valider sans réponse, liens vers le Wiki", am.v);
	ok(JSON.stringify(am.ordre) === JSON.stringify(["a-moi", "projets"]), "« À moi » avant la liste des projets", am.ordre);
	await capture("accueil-a-moi");
	await ev(`document.querySelector('[data-role="a-moi-valider"]').click(); 0`);
	ok(await attendre(`location.pathname === "/p/${P}/" && /^#a-valider--/.test(location.hash) && !document.getElementById("tab-a-valider").hidden`), "un point à valider s'ouvre dans le Wiki, onglet À valider");

	// I1 : bloc Notifications de l'écran Membres.
	await s("Page.navigate", { url: `${U}/#/p/${P}/membres` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="form-notifications"]') && /Aucune notification/.test(document.querySelector('[data-role="notif-etat"]').textContent)`), "Membres : bloc Notifications, rien de réglé");
	await ev(`document.getElementById("notif-url").value = ${JSON.stringify(URL_CROCHET)}; document.getElementById("notif-format").value = "json"; document.querySelector('[data-role="form-notifications"] button[type=submit]').click(); 0`);
	ok(await attendre(`/Notifications enregistrées/.test(document.body.textContent) && !!document.querySelector('[data-role="secret-signature"]') && /Vers 127\\.0\\.0\\.1:\\d+\\./.test(document.querySelector('[data-role="notif-etat"]').textContent)`), "enregistrées : hôte affiché, secret de signature montré une fois");
	ok(await ev(`document.getElementById("notif-url").value === "" && !document.querySelector('[data-role="form-notifications"]').textContent.includes("/crochet")`), "l'adresse complète n'est pas réaffichée");
	await ev(`document.querySelector('[data-role="notif-essai"]').click(); 0`);
	ok(await attendre(`/Essai reçu \\(HTTP 204\\)/.test(document.body.textContent)`) && recus.length === 1 && /essai de notification/.test(recus[0]), "« Envoyer un essai » : reçu par le destinataire", recus);
	await ev(`document.getElementById("s-notif").scrollIntoView(); 0`); await sleep(100);
	await capture("membres-notifications");
	const finN = await ev(`({ csp: window.__csp, err: window.__err })`);
	ok(!finN.csp.length && !finN.err.length, "Membres : ni CSP ni erreur JS", finN);

	// A1 : Administration, bloc Sauvegarde et « Sauvegarder maintenant ».
	await s("Page.navigate", { url: `${U}/#/admin` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="sauvegarder"]')`), "Administration : bloc Sauvegarde");
	ok(await ev(`/Aucune sauvegarde pour l'instant/.test(document.querySelector('[data-role="sauvegarde-etat"]').textContent)`), "aucune sauvegarde au départ");
	await ev(`document.querySelector('[data-role="sauvegarder"]').click(); 0`);
	ok(await attendre(`/Sauvegarde faite : \\d+ fichiers/.test(document.body.textContent) && /Dernière sauvegarde : /.test(document.querySelector('[data-role="sauvegarde-derniere"]').textContent)`, 20000), "Sauvegarder maintenant : faite, date affichée");
	ok(await attendre(`!!document.querySelector('[data-role="journal"] tr[data-action="sauvegarde"]')`), "journal : action « sauvegarde »");
	const dossierSauv = path.join(SORTIE, "donnees-sauvegardes");
	ok(fs.existsSync(dossierSauv) && fs.readdirSync(dossierSauv).some(n => /^sauvegarde-\d{8}-\d{6}$/.test(n)), "dossier de sauvegarde créé à côté des données", fs.existsSync(dossierSauv) && fs.readdirSync(dossierSauv));
	await capture("admin-sauvegarde");
	const finA = await ev(`({ csp: window.__csp, err: window.__err })`);
	ok(!finA.csp.length && !finA.err.length, "Administration : ni CSP ni erreur JS", finA);

	// Étape 3.9, lot 3 : état du serveur (A5), fermer les sessions d'un compte (E4), mes sessions (E4), exports (I4),
	// approbation nominative dans le Wiki (E5), versions gardées et ancienne version en lecture seule (L3).
	ok(await attendre(`/Version de l'outil : \\d/.test((document.querySelector('[data-role="version"]') || {}).textContent || "")`), "A5 : État du serveur : version de l'outil");
	const etat = await ev(`({ projets: [...document.querySelectorAll('[data-role="etat-projets"] tbody tr')].map(r => r.dataset.projet + ":" + r.cells[2].textContent), echecs: (document.querySelector('[data-role="echecs"]') || {}).textContent })`);
	ok(etat.projets.some(x => x.startsWith(P + ":2 (dernier : n° 2)")) && /Aucun traitement échoué/.test(etat.echecs || ""), "A5 : place, builds gardés, échecs récents", etat);
	await ev(`document.getElementById("s-etat").scrollIntoView(); 0`); await capture("admin-etat");
	const sessCamille = async () => (await (await fetch(U + "/api/moi/sessions", { headers: { Cookie: ckCamille } })).json());
	ok(Array.isArray((await sessCamille()).sessions), "E4 : Camille a une session");
	await ev(`document.querySelector('[data-role="fermer-sessions"][data-compte="camille"]').click(); 0`);
	await attendre(`!!document.querySelector('dialog[data-role="confirmer"]')`);
	await ev(`document.querySelector('dialog[data-role="confirmer"] .actions .danger').click(); 0`);
	ok(await attendre(`/session\\(s\\) de Camille fermée\\(s\\)/.test(document.body.textContent)`), "E4 : « Fermer ses sessions » (admin) : confirmé, fait");
	ok((await fetch(U + "/api/moi/sessions", { headers: { Cookie: ckCamille } })).status === 401, "E4 : la session de Camille ne vaut plus");
	await s("Page.navigate", { url: `${U}/#/` });
	await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="mes-sessions"]')`);
	await ev(`document.querySelector('[data-role="mes-sessions"] summary').click(); 0`);
	ok(await attendre(`[...document.querySelectorAll('[data-role="mes-sessions"] tbody tr')].some(r => /\\(celle-ci\\)/.test(r.textContent))`), "E4 : Accueil, « Mes sessions » : celle-ci, navigateur, dates");
	await capture("accueil-sessions");
	await s("Page.navigate", { url: `${U}/#/p/${P}/retours` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="export-retours-csv"]') && !!document.querySelector('[data-role="export-journal-csv"]')`), "I4 : Retours : liens d'export (journal pour un admin)");
	const dl = await ev(`fetch(document.querySelector('[data-role="export-retours-csv"]').href).then(async r => ({ s: r.status, d: r.headers.get("content-disposition"), t: (await r.text()).slice(0, 30) }))`);
	ok(dl.s === 200 && /attachment; filename="jardin-retours-/.test(dl.d) && /^id;statut;sorte;ref;nom/.test(dl.t.replace(/^\uFEFF/, "")), "I4 : l'export CSV se télécharge avec la session", dl);
	// E5 : « Validé » de Benoît (admin) sur un point à valider : approbation affichée dans le Wiki.
	const pv = notes.validations[0];
	await appel("POST", `/api/p/${P}/retours`, { cookie: ck, corps: { kind: "validation", ref: pv.id, name: pv.text.slice(0, 60), tab: "a-valider", anchor: "a-valider--" + pv.id.toLowerCase(), cat: "valide", text: "D'accord.", proposal: "", status: "nouveau", reply: "", replied: "", created: new Date().toISOString(), updated: new Date().toISOString(), by: "", codex: d.generated } });
	await s("Page.navigate", { url: `${U}/p/${P}/#a-valider` });
	ok(await attendre(`/Approuvé par Benoît · .* · build 2/.test((document.querySelector('[data-fb-kind="validation"][data-fb-id="${pv.id}"] .fb-appr') || {}).textContent || "")`, 10000), "E5 : « Approuvé par Benoît · date · build 2 » sur le point validé");
	await capture("approbation");
	// L3 : lien « Versions », liste, ancienne version en lecture seule.
	const lv = await ev(`(document.getElementById("lien-versions") || {}).getAttribute ? document.getElementById("lien-versions").getAttribute("href") : null`);
	ok(lv === `/p/${P}/b/`, "L3 : lien « Versions » dans la ligne du Wiki", lv);
	await s("Page.navigate", { url: `${U}/p/${P}/b/` });
	ok(await attendre(`/Versions du Wiki/.test(document.body.textContent) && !!document.querySelector('a[href="1/"]')`), "L3 : liste des versions gardées");
	await ev(`document.querySelector('a[href="1/"]').click(); 0`);
	ok(await attendre(`/Ancienne version : build 1, en lecture seule/.test(document.body.textContent) && !!document.querySelector(".fb-btn")`), "L3 : build 1 servi, avis « Ancienne version »");
	await ev(`document.querySelector("#plantes--basilic .fb-btn").click(); 0`); await sleep(300);
	ok(await ev(`!document.getElementById("fb-text") && /lecture seule|lire/i.test(document.getElementById("fb-formwrap").textContent)`), "L3 : ancienne version : pas de formulaire de retour", await ev(`document.getElementById("fb-formwrap").textContent.slice(0, 120)`));
	await capture("ancienne-version");
	// Étape 3.9, lot 4 : réglages plafond et série (G4, G3) dans Membres ; choix du profil (G5) dans le bandeau de traitement.
	await s("Page.navigate", { url: `${U}/#/p/${P}/membres` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.getElementById("reg-plafond") && !!document.getElementById("reg-serie")`), "G4, G3 : réglages « Plafond d'une vague » et « Lancer le traitement à l'envoi d'une série »");
	await ev(`document.getElementById("reg-plafond").value = "4"; document.getElementById("reg-serie").checked = true; document.querySelector('[data-role="form-reglages"] button[type=submit]').click(); 0`);
	ok(await attendre(`/Réglages enregistrés/.test(document.body.textContent)`), "réglages enregistrés");
	const rg = await appel("GET", `/api/p/${P}/reglages`, { cookie: ck });
	ok(rg.plafond_vague === 4 && rg.traitement_serie === true, "serveur : plafond 4, traitement à l'envoi d'une série", rg);
	const jt = (await appel("POST", "/api/admin/jetons", { cookie: ck, corps: { projet: P, nom: "Agent du test" } })).jeton;
	const veille = () => fetch(`${U}/api/p/${P}/veille`, { method: "POST", headers: { Authorization: "Bearer " + jt, "Content-Type": "application/json" }, body: JSON.stringify({ poste: "poste-essai", profils: ["code", "textes"] }) });
	ok((await veille()).status === 200, "un veilleur annonce les profils « code » et « textes »");
	await s("Page.navigate", { url: `${U}/#/p/${P}/retours` });
	ok(await attendre(`!!document.getElementById("traitement-profil")`, 12000), "G5 : choix du profil à côté de « Traiter les retours »");
	const opts5 = await ev(`[...document.querySelectorAll("#traitement-profil option")].map(o => o.value + "=" + o.textContent)`);
	ok(JSON.stringify(opts5) === JSON.stringify(["=Profil par défaut", "code=Profil « code »", "textes=Profil « textes »"]), "G5 : profils proposés", opts5);
	await veille();
	await ev(`{ const s = document.getElementById("traitement-profil"); s.value = "textes"; s.dispatchEvent(new Event("change")); document.querySelector('[data-role="traiter"]').click(); } 0`);
	ok(await attendre(`/Demande envoyée/.test(document.body.textContent) && /profil « textes »/.test(document.querySelector('[data-role="traitement"], .traitement, section').textContent)`, 10000), "G5 : demande envoyée avec le profil « textes », montré dans la demande active");
	const act = (await appel("GET", `/api/p/${P}/demandes`, { cookie: ck })).active;
	ok(act && act.profil === "textes", "serveur : demande active du profil « textes »", act);
	await capture("traitement-profil");
	if (act) await appel("POST", `/api/p/${P}/demandes/${act.id}/annuler`, { cookie: ck, corps: {} });
	// Étape 3.9, lot 5 : bloc « Forge du code » (I3) et rôle de jeton « Clone » (A6) dans Membres.
	await s("Page.navigate", { url: `${U}/#/p/${P}/membres` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="forge-creer"]') && /Aucun webhook/.test(document.querySelector('[data-role="forge-etat"]').textContent)`), "I3 : Membres, bloc « Forge du code », rien de réglé");
	await ev(`document.querySelector('[data-role="forge-creer"]').click(); 0`);
	ok(await attendre(`!!document.querySelector('[data-role="forge-secret-valeur"]') && /\\/api\\/forge\\/${P}/.test(document.querySelector('[data-role="forge-etat"]').textContent)`), "I3 : webhook créé : secret montré une fois, adresse affichée");
	ok(await ev(`[...document.querySelectorAll("#jet-role option")].some(o => o.value === "clone")`), "A6 : rôle de jeton « Clone »");
	await ev(`document.getElementById("s-forge").scrollIntoView(); 0`); await capture("membres-forge");
	// Étape 3.9, lot 6, L9 : épingle posée d'un clic sur l'image agrandie, au quart de la largeur, aux trois quarts de la hauteur.
	await s("Page.navigate", { url: `${U}/p/${P}/#plantes--tomate-coeur` });
	await attendre(`!!document.querySelector("#plantes--tomate-coeur .fb-btn")`); await sleep(400);
	await ev(`{ const b = document.querySelector("#plantes--tomate-coeur button.zoom"); b.focus(); b.click(); } 0`); await sleep(200);
	ok(await ev(`document.getElementById("zoom-dlg").open && document.getElementById("zoom-cadre").classList.contains("epinglable") && !document.getElementById("zoom-aide").hidden && /Clique sur l'image/.test(document.getElementById("zoom-aide").textContent)`), "L9 : image agrandie, épinglable, aide affichée");
	// Cadre 2:1 sur une image carrée : l'image dessinée (contain) est le carré central ; le point est relatif à elle.
	const rect = await ev(`(() => { const i = document.getElementById("zoom-img"); i.style.width = "400px"; i.style.height = "200px"; const r = i.getBoundingClientRect(); return { x: r.left + 100, y: r.top, w: 200, h: r.height }; })()`);
	for (const type of ["mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type, x: rect.x + rect.w * 0.25, y: rect.y + rect.h * 0.75, button: "left", clickCount: 1 });
	ok(await attendre(`!document.getElementById("zoom-dlg").open && !document.getElementById("fb-panel").hidden && /Point \\(25 %, 75 %\\)/.test((document.querySelector(".fb-point-chip") || {}).textContent || "")`), "L9 : le clic ferme l'image et ouvre le retour de la fiche avec « Point (25 %, 75 %) »");
	await ev(`document.getElementById("fb-text").value = "La tige est mal détourée ici"; document.getElementById("fb-send").click(); 0`);
	ok(await attendre(`/Envoyé/.test(document.getElementById("fb-status").textContent)`), "L9 : retour épinglé envoyé");
	const dp = (await appel("GET", `/api/p/${P}/retours`, { cookie: ck })).docs.find(x => x.donnees.text === "La tige est mal détourée ici");
	const pp = dp && /^([\d.]+),([\d.]+)@[0-9a-f]{8}$/.exec(dp.donnees.point);
	ok(pp && Math.abs(Number(pp[1]) - 0.25) < 0.015 && Math.abs(Number(pp[2]) - 0.75) < 0.015, "L9 : le retour porte le point (à un pixel près) et l'empreinte de l'image", dp && dp.donnees.point);
	ok(await ev(`/Point \\(25 %, 75 %\\)/.test(document.getElementById("fb-listwrap").textContent)`), "L9 : le point se lit dans la liste du tiroir");
	await ev(`document.getElementById("fb-close").click(); { const b = document.querySelector("#plantes--tomate-coeur button.zoom"); b.focus(); b.click(); } 0`); await sleep(300);
	const pin = await ev(`(() => { const p = document.querySelector("#zoom-pins .epingle"); return p ? { n: p.textContent, l: p.style.left, t: p.style.top, anc: p.classList.contains("ancienne"), titre: p.title } : null; })()`);
	ok(pin && pin.n === "1" && Math.abs(parseFloat(pin.l) - 25) < 1.5 && Math.abs(parseFloat(pin.t) - 75) < 1.5 && !pin.anc && /mal détourée/.test(pin.titre), "L9 : rouverte, l'image montre l'épingle 1 à l'endroit posé", pin);
	await ev(`{ const i = document.getElementById("zoom-img"); i.style.width = "400px"; i.style.height = "200px"; window.dispatchEvent(new Event("resize")); } 0`); await sleep(100);
	const surImage = await ev(`(() => { const p = document.querySelector("#zoom-pins .epingle").getBoundingClientRect(), i = document.getElementById("zoom-img").getBoundingClientRect(); return { x: (p.left + p.width / 2 - i.left - 100) / 200, y: (p.top + p.height / 2 - i.top) / i.height }; })()`);
	ok(Math.abs(surImage.x - 0.25) < 0.02 && Math.abs(surImage.y - 0.75) < 0.02, "L9 : l'épingle suit l'image dessinée, pas les marges du cadre", surImage);
	await capture("epingle");
	await ev(`document.querySelector("#zoom-pins .epingle").click(); 0`); await sleep(200);
	ok(await ev(`!document.getElementById("zoom-dlg").open && !document.getElementById("fb-panel").hidden && document.getElementById("fb-title").textContent === "Tomate cœur de bœuf"`), "L9 : une épingle ouvre les retours de la fiche");
	await ev(`document.getElementById("fb-close").click(); 0`);
	// Étape 3.9, lot 6, E2 : testeur externe, invité depuis Membres sur l'onglet Plantes, puis le Wiki de son côté.
	await s("Page.navigate", { url: `${U}/#/p/${P}/membres` });
	ok(await attendre(`document.body.dataset.charge === "1" && !!document.querySelector('[data-role="inv-onglets"] input[data-onglet="plantes"]')`), "E2 : Membres, onglets du Wiki à cocher");
	await ev(`{ const r = document.getElementById("inv-role"); r.value = "testeur"; r.dispatchEvent(new Event("change")); document.querySelector('input[data-onglet="plantes"]').click(); } 0`);
	ok(await ev(`!document.querySelector('[data-role="inv-testeur"]').hidden`), "E2 : le choix « Testeur externe » montre les onglets et la durée");
	await ev(`document.querySelector('[data-role="form-invitation"] button[type="submit"]').click(); 0`);
	ok(await attendre(`!!document.querySelector('[data-role="lien-invitation"]') && /Il verra : Plantes, pendant 14 jours/.test(document.querySelector('[data-role="invitation-creee"]').textContent)`), "E2 : lien d'invitation, onglets et durée rappelés");
	await capture("membres-testeur");
	const lienT = await ev(`document.querySelector('[data-role="lien-invitation"]').value`);
	const accT = await fetch(lienT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nom: "Zoé" }), redirect: "manual" });
	const ckZoe = (accT.headers.get("set-cookie") || "").split(";")[0];
	ok(accT.status === 303 && /^wdd_session=/.test(ckZoe), "E2 : invitation acceptée", accT.status);
	await s("Network.setCookie", { name: "wdd_session", value: ckZoe.slice("wdd_session=".length), url: U, httpOnly: true, sameSite: "Lax" });
	await s("Page.navigate", { url: `${U}/p/${P}/` });
	ok(await attendre(`!!document.querySelector("#plantes--tomate-coeur .fb-btn")`), "E2 : le Wiki du testeur, avec ses boutons de retour");
	ok(await ev(`!/Règles de calcul|Écrans de l'appli/.test(document.body.textContent) && !document.querySelector('#wdd-bandeau [data-onglet="retours"], #wdd-bandeau [data-onglet="kanban"], #lien-versions')`), "E2 : ni onglet caché, ni Retours ni Kanban dans le bandeau, ni lien « Versions »");
	ok(await ev(`!/Retour sur (tomate|poivron|basilic)|mal détourée/.test(document.body.textContent) && !document.querySelector(".fb-tk")`), "E2 : ni retours des autres, ni tickets sur les fiches");
	await ev(`document.querySelector("#plantes--tomate-coeur .fb-btn").click(); 0`); await sleep(200);
	ok(await ev(`!document.getElementById("fb-pour")`), "E2 : pas de « Pour » (il ne connaît pas les membres)");
	await ev(`document.getElementById("fb-text").value = "Testeur : la fiche est claire"; document.getElementById("fb-send").click(); 0`);
	ok(await attendre(`/Envoyé/.test(document.getElementById("fb-status").textContent) && /la fiche est claire/.test(document.getElementById("fb-listwrap").textContent)`), "E2 : le testeur envoie un retour et le voit");
	ok((await appel("GET", `/api/p/${P}/retours`, { cookie: ck })).docs.some(x => x.donnees.text === "Testeur : la fiche est claire"), "E2 : l'équipe reçoit son retour");
	await capture("testeur-wiki");
	const finT = await ev(`({ csp: window.__csp, err: window.__err })`);
	ok(!finT.csp.length && !finT.err.length, "E2 : ni CSP ni erreur JS côté testeur", finT);
	await s("Page.navigate", { url: `${U}/#/p/${P}/kanban` });
	ok(await attendre(`location.pathname === "/p/${P}/" && !!document.querySelector(".fb-btn")`), "E2 : le Kanban renvoie le testeur au Wiki");
	await s("Page.navigate", { url: `${U}/#/` });
	ok(await attendre(`document.body.dataset.charge === "1" && /Testeur externe · accès jusqu'au/.test((document.querySelector('[data-role="testeur-fin"]') || {}).textContent || "") && !document.querySelector('.projet a[href$="/kanban"]')`), "E2 : l'Accueil du testeur : le Wiki seul, et la fin de son accès");
	await capture("testeur-accueil");
	await s("Network.setCookie", { name: "wdd_session", value: ck.split(";")[0].slice("wdd_session=".length), url: U, httpOnly: true, sameSite: "Lax" });
	// Étape 3.9, lot 6, I2 : appairage demandé par une application (role « retour ») : l'écran ne propose que ce rôle.
	const demApp = await appel("POST", "/api/appairage", { corps: { poste: "Potager · Windows", projet: P, role: "retour" } });
	await s("Page.navigate", { url: `${U}/#/appairage/${demApp.code}` });
	ok(await attendre(`!!document.querySelector('[data-role="role-retour"]') && document.getElementById("ap-nom").value === "Application · Potager · Windows" && !document.querySelector('input[name="ap-role"]')`), "I2 : appairage d'une application : rôle « retour » seul, nom « Application · … »");
	await capture("appairage-application");
	await ev(`document.querySelector('[data-role="autoriser"]').click(); 0`);
	ok(await attendre(`/retourne dans l'application/.test((document.querySelector('[data-role="appairage-fini"]') || {}).textContent || "")`), "I2 : autorisé, « retourne dans l'application »");
	const fin3 = await ev(`({ csp: window.__csp, err: window.__err })`);
	ok(!fin3.csp.length && !fin3.err.length, "lot 3 : ni CSP ni erreur JS", fin3);
	await cdp("Browser.close").catch(() => { });
} catch (e) { ok(false, "ERREUR " + (e.stack || e)); }
finally {
	try { nav && nav.kill(); } catch { }
	serveur.kill(); recepteur.close(); await sleep(500);
	console.log(`BILAN wiki : ${pass} PASS, ${fail} FAIL`);
	process.exit(fail ? 1 : 0);
}
