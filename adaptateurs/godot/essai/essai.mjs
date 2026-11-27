// Essai du greffon Godot retours_app (étape 3.9, I2) avec un vrai Godot 4 : serveur de test (port libre, données
// temporaires, jamais 8080), projet Godot temporaire (copie de essai/projet et du greffon), deux envois depuis le jeu
// (cible de la scène avec capture, cible explicite), puis la touche F8 ouvre le formulaire. Vérifie les retours reçus.
// Godot a besoin d'une fenêtre (--headless n'a pas de rendu, donc pas de capture) : elle est placée hors de l'écran.
// Lancement : node adaptateurs/godot/essai/essai.mjs <dossier de travail hors dépôt> [chemin de godot]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const RACINE = path.resolve(import.meta.dirname, "..", "..", "..");
const [SORTIE, GODOT = "godot"] = process.argv.slice(2);
if (!SORTIE) { console.error("usage : node essai.mjs <dossier de travail> [godot]"); process.exit(2); }
fs.rmSync(SORTIE, { recursive: true, force: true }); fs.mkdirSync(SORTIE, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x !== undefined ? "  :: " + JSON.stringify(x) : "")); } };

const port = await new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const U = `http://127.0.0.1:${port}`;
const env = { ...process.env, WDD_DONNEES: path.join(SORTIE, "donnees"), WDD_TEST: "1", WDD_PORT: String(port), WDD_HOTE: "127.0.0.1", WDD_URL: U, APPDATA: path.join(SORTIE, "a"), LOCALAPPDATA: path.join(SORTIE, "l") };
for (const k of ["WDD_URL_PAGES", "WDD_HTTPS", "WDD_UI", "WDD_SITE", "WDD_SAUVEGARDE"]) delete env[k];
const serveur = spawn(process.execPath, [path.join(RACINE, "serveur", "src", "principal.ts")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
await new Promise((r, ko) => { let t = ""; const f = setTimeout(() => ko(new Error("serveur pas démarré : " + t)), 30000); const l = b => { t += b; if (/à l'écoute sur/.test(t)) { clearTimeout(f); r(); } }; serveur.stdout.on("data", l); serveur.stderr.on("data", l); });
const appel = async (m, c, { corps, brut, cookie } = {}) => {
	const h = {}; if (corps || brut) h["Content-Type"] = "application/json"; if (cookie) h.Cookie = cookie; if (m !== "GET") h["X-WDD"] = "1";
	const r = await fetch(U + c, { method: m, headers: h, body: brut ?? (corps ? JSON.stringify(corps) : undefined) });
	const t = await r.text(); if (r.status >= 300) throw new Error(`${m} ${c} ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : null;
};
try {
	const prep = await appel("POST", "/__test/preparer", { corps: { projet: "jardin", titre: "Jardin", comptes: [{ id: "maud", nom: "Maud", role: "mainteneur" }], retours: [] } });
	const ck = prep.comptes[0].cookie;
	await appel("POST", "/api/p/jardin/builds", { brut: fs.readFileSync(path.join(RACINE, "site", "examples", "data.json"), "utf8"), cookie: ck });
	const jeton = (await appel("POST", "/api/p/jardin/jetons", { corps: { nom: "Essai Godot", role: "retour" }, cookie: ck })).jeton;
	// Projet Godot temporaire : le projet d'essai, le greffon, l'adresse du serveur.
	const proj = path.join(SORTIE, "projet");
	fs.cpSync(path.join(import.meta.dirname, "projet"), proj, { recursive: true });
	fs.cpSync(path.join(RACINE, "adaptateurs", "godot", "addons"), path.join(proj, "addons"), { recursive: true });
	const pg = path.join(proj, "project.godot");
	fs.writeFileSync(pg, fs.readFileSync(pg, "utf8").replace('serveur="SERVEUR"', `serveur="${U}"`));
	spawnSync(GODOT, ["--headless", "--path", proj, "--import"], { encoding: "utf8", timeout: 120000, windowsHide: true });
	const g = spawnSync(GODOT, ["--path", proj, "--position", "-3000,-3000", "--", `--jeton=${jeton}`], { encoding: "utf8", timeout: 120000, windowsHide: true,
		env: { ...process.env, APPDATA: path.join(SORTIE, "godot-appdata") } });
	const sortie = (g.stdout || "") + (g.stderr || "");
	fs.writeFileSync(path.join(SORTIE, "godot.log"), sortie);
	const res = Object.fromEntries([...sortie.matchAll(/^RESULTAT (\S+) (.*)$/gm)].map(m => [m[1], m[2].trim()]));
	ok(res.cible_courante === "ecran:route:/", "Godot : cible de la scène courante (méta retours_ref)", res.cible_courante);
	ok(/^ok \w+/.test(res.envoi1 || ""), "Godot : envoi avec capture", res.envoi1);
	ok(/^ok \w+/.test(res.envoi2 || ""), "Godot : envoi avec cible explicite", res.envoi2);
	ok(res.formulaire === "true" && /ecran:route:\//.test(res.titre || ""), "Godot : F8 ouvre le formulaire sur la cible", [res.formulaire, res.titre]);
	ok(/refus|introuvable/i.test(res.echec_formulaire || "") && /ouvert=true/.test(res.echec_formulaire || ""), "Godot : formulaire, un échec s'affiche et le formulaire reste ouvert", res.echec_formulaire);
	ok(res.formulaire_envoye === "true branches=0", "Godot : formulaire, nouvel essai envoyé, formulaire fermé, signaux débranchés", res.formulaire_envoye);
	ok(!/SCRIPT ERROR|Parse Error/.test(sortie), "Godot : aucune erreur de script", sortie.match(/(SCRIPT ERROR|Parse Error).*/g));
	const docs = (await appel("GET", "/api/p/jardin/retours", { cookie: ck })).docs.map(d => d.donnees);
	const dF = docs.find(d => d.text.startsWith("Essai Godot : par le formulaire"));
	ok(dF && dF.kind === "ecran" && /^[0-9a-f]{64}.png$/.test(dF.captures || ""), "serveur : retour du formulaire, sur l'écran, avec la capture prise à l'ouverture", dF);
	const d1 = docs.find(d => d.text.startsWith("Essai Godot : écran d'accueil")), d2 = docs.find(d => d.text.startsWith("Essai Godot : la tomate"));
	ok(d1 && d1.kind === "ecran" && d1.anchor === "ecrans--route" && d1.name === "Accueil" && /^[0-9a-f]{64}\.png$/.test(d1.captures || "") && /Contexte : Essai retours 0\.1/.test(d1.text), "serveur : retour ancré sur la fiche de l'écran, avec capture et contexte", d1);
	ok(d2 && d2.kind === "plante" && d2.ref === "tomate" && d2.name === "Tomate" && d2.cat === "idee" && d2.by === "maud", "serveur : retour sur la tomate, au nom du propriétaire du jeton", d2);
	// Appairage par le greffon lui-même : Godot demande un code (role retour) ; on l'autorise au nom de Maud.
	const fCode = path.join(SORTIE, "code.txt");
	const ga = spawn(GODOT, ["--path", proj, "--position", "-3000,-3000", "--", "--appairer", `--code=${fCode}`], { windowsHide: true, env: { ...process.env, APPDATA: path.join(SORTIE, "godot-appdata") } });
	let ta = "";
	const finGa = new Promise(r => ga.on("exit", r));
	ga.stdout.on("data", b => ta += b); ga.stderr.on("data", b => ta += b);
	let code = "";
	for (let i = 0; i < 300 && !code; i++) { await new Promise(r => setTimeout(r, 200)); try { code = fs.readFileSync(fCode, "utf8").trim(); } catch { } }
	if (!code) throw new Error("pas de code d'appairage : " + ta);
	const vu = await appel("GET", `/api/appairage/${code}`, { cookie: ck });
	ok(vu.role === "retour" && /^Essai retours · /.test(vu.poste), "Godot : demande d'appairage « retour » au nom de l'application", [vu.role, vu.poste]);
	await appel("POST", `/api/appairage/${code}/autoriser`, { corps: { projet: "jardin", role: "retour" }, cookie: ck });
	await Promise.race([finGa, new Promise(r => setTimeout(r, 60000))]);
	ga.kill();
	fs.writeFileSync(path.join(SORTIE, "godot-appairage.log"), ta);
	ok(/RESULTAT appaire Application · Essai retours/.test(ta) && /RESULTAT envoi3 ok/.test(ta), "Godot : appairé, jeton gardé, retour envoyé", ta.match(/RESULTAT.*/g));
	const cfg = path.join(SORTIE, "godot-appdata", "Godot", "app_userdata", "Essai retours", "retours_app.cfg");
	ok(fs.existsSync(cfg) && !fs.readFileSync(pg, "utf8").includes("wdd_"), "jeton gardé dans user:// (hors du projet)", cfg);
	const d3 = (await appel("GET", "/api/p/jardin/retours", { cookie: ck })).docs.map(d => d.donnees).find(d => d.text.startsWith("Essai Godot : après appairage"));
	ok(d3 && d3.ref === "basilic" && d3.by === "maud", "serveur : retour envoyé avec le jeton appairé", d3);
	if (d1 && d1.captures) {
		const r = await fetch(`${U}/api/p/jardin/captures/${d1.captures}`, { headers: { Cookie: ck } });
		const b = Buffer.from(await r.arrayBuffer());
		fs.writeFileSync(path.join(SORTIE, "capture.png"), b);
		ok(r.status === 200 && b.length > 1000, "capture lisible (écrite dans capture.png)", b.length);
	}
} catch (e) { ok(false, "ERREUR " + (e.stack || e)); }
finally {
	serveur.kill(); await new Promise(r => setTimeout(r, 500));
	console.log(`BILAN godot : ${pass} PASS, ${fail} FAIL`);
	process.exit(fail ? 1 : 0);
}
