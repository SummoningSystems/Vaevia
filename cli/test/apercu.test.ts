// Étape 3.6, CLI : « outil apercu » (docs/etape3-6-wiki-ui.md § A.1) et l'avertissement « image écrite comme du
// texte » du build, contre un vrai serveur de test. Faux navigateur (OUTIL_TEST_APERCU : fichier des captures
// demandées, ou « aucun ») ; vrai lancement d'un faux programme (copie de node) pour vérifier que le navigateur ne
// reçoit ni le jeton ni OUTIL_JETON, qu'un navigateur qui échoue ne fait pas échouer la commande et qu'un dossier
// « profil-navigateur » de l'humain n'est pas touché ; recherche du navigateur (chemins connus, PATH sans dossier
// relatif) ; CSP du serveur reprise en <meta> ; hôte des pages séparé : aperçu par l'API de l'hôte principal ; pas
// refusée sous la veille. Le vrai Edge ou Chrome du poste n'est lancé que par le dernier groupe (page piégée : script
// non haché, réseau, fichiers locaux, images en loading="lazy"), sauté sans navigateur.
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, portLibre } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";
import { lireSortieBuild } from "../../serveur/src/builds.ts";
import { RACINE, environnement, lancer, dossierTravail } from "./aide-cli.ts";
import { candidatsNavigateur, trouverNavigateur, argumentsNavigateur, envNavigateur, cspApercu, poserCsp, capturerAvecNavigateur, CAPTURES } from "../apercu.ts";

// PNG de 1 × 1 px valide.
const PNG_1PX_TEST = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

const EXEMPLES = path.join(RACINE, "site", "examples");
const exemple = () => JSON.parse(fs.readFileSync(path.join(EXEMPLES, "data.json"), "utf8"));

describe("CLI outil : apercu et avertissement d'image", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, code: string, agent: string, captures: string;
	before(async () => {
		tmp = dossierTemp("cli-apercu");
		captures = path.join(tmp, "captures.jsonl");
		env = environnement(tmp);
		s = await serveurTest(path.join(tmp, "donnees"));
		u = s.url;
		await projet(u, "jardin");
		const adm = await session(u, "jardin", "adm", "admin");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent apercu" } })).corps.jeton;
		code = path.join(tmp, "code");
		fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }));
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	const outil = (args: string[], extra: Record<string, string> = {}) => lancer(env, args, { cwd: code, env: { OUTIL_JETON: agent, ...extra } });
	const sansJeton = (t: string) => assert.ok(!t.includes(agent) && !/wdd_[A-Za-z0-9_-]{16,}/.test(t), "aucun jeton");

	test("sans build : sortie 1, publier d'abord", async () => {
		const r = await outil(["apercu", "--json"], { OUTIL_TEST_APERCU: captures });
		assert.equal(r.code, 1, r.stderr); assert.equal(r.json.erreur.code, "sans_build"); assert.match(r.stderr, /outil publier/);
	});

	test("build : une valeur de champ en chemin d'image donne un avertissement regroupé (pas une erreur) ; l'exemple n'en donne pas", async () => {
		const propre = await outil(["export", "envoyer", path.join(EXEMPLES, "data.json"), "--json"]);
		assert.equal(propre.code, 0, propre.stderr);
		assert.ok(!propre.json.avertissements.some((a: string) => /image écrite comme du texte/.test(a)), JSON.stringify(propre.json.avertissements));
		const d = exemple(), items = d.tabs[0].sections[0].items;
		items[0].fields.push(["Icône", "res://assets/icones/tomate.png"]);
		items[1].fields.push(["Sprites", ["courgette.webp", "autre"]]);
		items[2].fields.push(["Déjà bon", "data:image/png;base64,AAAA"], ["Note", "voir le plan"]);
		for (const it of d.tabs[1].sections[0].items) (it.fields ??= []).push(["Capture", "captures/" + it.id.replace(/\W/g, "") + ".JPG"]);
		const f = path.join(tmp, "data-images.json"); fs.writeFileSync(f, JSON.stringify(d));
		const r = await outil(["export", "envoyer", f, "--json"]);
		assert.equal(r.code, 0, r.stderr);
		const a = r.json.avertissements.filter((x: string) => /^image écrite comme du texte/.test(x));
		assert.equal(a.length, 1, "une seule ligne : " + JSON.stringify(r.json.avertissements));
		assert.match(a[0], /^image écrite comme du texte : \d+ valeur\(s\) de champ/);
		assert.match(a[0], /res:\/\/assets\/icones\/tomate\.png/); assert.match(a[0], /courgette\.webp/); assert.match(a[0], / ; …\)/);
		assert.ok(!/data:image/.test(a[0]) && !/voir le plan/.test(a[0]), "ni URI data:, ni texte ordinaire");
		assert.match(a[0], /URI data:.*methode\/exporteurs\.md/);
		assert.match(r.stderr, /attention \(build\) : image écrite comme du texte/);
	});

	test("apercu : dernier build téléchargé dans <travail>/apercu, trois captures (1280 clair, 1280 sombre, 390), chemins en --json, aucun jeton", async () => {
		fs.rmSync(captures, { force: true });
		const b = (await appel(u, "/api/p/jardin/builds", { bearer: agent })).corps.dernier.build;
		const r = await outil(["apercu", "--json"], { OUTIL_TEST_APERCU: captures });
		assert.equal(r.code, 0, r.stderr);
		const dossier = path.join(dossierTravail(env, "jardin"), "apercu");
		assert.equal(r.json.build, b); assert.equal(r.json.dossier, dossier); assert.equal(r.json.page, `${u}/p/jardin/`);
		assert.equal(r.json.html, path.join(dossier, `apercu-${b}.html`));
		const html = fs.readFileSync(r.json.html, "utf8");
		assert.match(html, /^<!doctype html>/i); assert.match(html, /<meta name="wdd-api" content="\/api\/p\/jardin">/); assert.match(html, /<title>[^<]+<\/title>/);
		sansJeton(html);
		// La CSP du serveur reprise en <meta>, juste après <meta charset>, adaptée au fichier local ; ses empreintes sont
		// celles des scripts du fichier (contenu inchangé).
		const servie = await appel(u, "/p/jardin/", { bearer: agent });
		const meta = html.match(/^<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
		assert.ok(meta, html.slice(0, 300));
		assert.equal(meta![1], cspApercu(String(servie.entetes.get("content-security-policy"))));
		assert.ok(!/'self'|frame-ancestors/.test(meta![1]), meta![1]);
		assert.match(meta![1], /^default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; script-src 'sha256-/);
		const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[\s/>]/gi)].map(m => `'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
		assert.deepEqual(new Set(meta![1].split("; ").find(d => d.startsWith("script-src "))!.slice(11).split(" ")), new Set(scripts));
		assert.equal(html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]+">/, ""), servie.texte, "le reste : la page servie à ce jeton, bandeau compris");
		assert.deepEqual(r.json.captures.map((c: any) => [c.nom, c.largeur, c.theme]), [["bureau", 1280, "clair"], ["sombre", 1280, "sombre"], ["390", 390, "clair"]]);
		for (const c of r.json.captures) {
			assert.equal(path.dirname(c.chemin), dossier);
			assert.deepEqual([...fs.readFileSync(c.chemin).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG");
		}
		const demandes = fs.readFileSync(captures, "utf8").trim().split("\n").map(l => JSON.parse(l));
		assert.deepEqual(demandes.map(x => [x.largeur, x.sombre, x.mobile]), [[1280, false, false], [1280, true, false], [390, false, true]]);
		for (const x of demandes) assert.equal(x.url, new URL("file:///" + r.json.html.replace(/\\/g, "/")).href, "le navigateur ne voit que le fichier local");
		assert.deepEqual(r.json.avertissements, []);
		sansJeton(r.stdout + r.stderr + fs.readFileSync(captures, "utf8"));
		// Sortie lisible : les trois chemins et le rappel de les regarder.
		const h = await outil(["apercu"], { OUTIL_TEST_APERCU: captures });
		assert.equal(h.code, 0, h.stderr);
		assert.match(h.stdout, /build n° \d+ téléchargé : /); assert.match(h.stdout, /bureau +1280 px, clair : /); assert.match(h.stdout, /sombre +1280 px, sombre : /); assert.match(h.stdout, /390 +390 px, clair : /);
		assert.match(h.stdout, /regarder chaque capture/); assert.match(h.stdout, /retours y sont indisponibles/);
	});

	test("apercu --ancre : l'onglet dans l'URL et dans le nom des captures ; ancre invalide : usage ; --dossier dans le dépôt : refusé", async () => {
		fs.rmSync(captures, { force: true });
		const r = await outil(["apercu", "--ancre", "#plantes--tomate", "--json"], { OUTIL_TEST_APERCU: captures });
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.json.captures.every((c: any) => path.basename(c.chemin).startsWith(`apercu-${r.json.build}-plantes--tomate-`)));
		assert.ok(fs.readFileSync(captures, "utf8").trim().split("\n").every(l => JSON.parse(l).url.endsWith(".html#plantes--tomate")));
		for (const a of ["../x", "a b", "A", "x\"onload", ""]) assert.equal((await outil(["apercu", "--ancre", a], { OUTIL_TEST_APERCU: captures })).code, 2, a);
		const dedans = await outil(["apercu", "--dossier", path.join(code, "captures")], { OUTIL_TEST_APERCU: captures });
		assert.equal(dedans.code, 2); assert.match(dedans.stderr, /hors du dépôt/);
		assert.ok(!fs.existsSync(path.join(code, "captures")));
		const ailleurs = await outil(["apercu", "--dossier", path.join(tmp, "ailleurs"), "--json"], { OUTIL_TEST_APERCU: captures });
		assert.equal(ailleurs.code, 0, ailleurs.stderr); assert.equal(ailleurs.json.dossier, path.join(tmp, "ailleurs"));
	});

	test("apercu sans navigateur : sortie 0, un avertissement et le chemin du HTML ; sous la veille (OUTIL_DEMANDE) : permise", async () => {
		const r = await outil(["apercu", "--json"], { OUTIL_TEST_APERCU: "aucun" });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.json.captures, []); assert.equal(r.json.navigateur, null);
		assert.match(r.stderr, /attention : aucun navigateur trouvé/); assert.ok(r.stderr.includes(r.json.html)); assert.ok(fs.existsSync(r.json.html));
		const h = await outil(["apercu"], { OUTIL_TEST_APERCU: "aucun" });
		assert.equal(h.code, 0); assert.match(h.stdout, /aucune capture/);
		const v = await outil(["apercu", "--json"], { OUTIL_TEST_APERCU: captures, OUTIL_DEMANDE: "d-1" });
		assert.equal(v.code, 0, v.stderr); assert.equal(v.json.captures.length, 3);
	});

	test("navigateur : ni jeton ni OUTIL_JETON (environnement, arguments), tube DevTools sans port ; un navigateur qui échoue au lancement : sortie 0 et avertissement", async () => {
		const e = envNavigateur({ PATH: "p", OUTIL_JETON: agent, Outil_Jeton: agent, AUTRE: "x" });
		assert.equal(e.AUTRE, "x"); sansJeton(JSON.stringify(e));
		const a = argumentsNavigateur(path.join(tmp, "profil"));
		assert.ok(a.includes("--headless=new") && a.includes("--remote-debugging-pipe") && !a.some(x => /remote-debugging-port/.test(x)), JSON.stringify(a));
		assert.ok(a.includes("--user-data-dir=" + path.join(tmp, "profil")));
		// Vrai lancement d'un programme qui n'est pas un navigateur (une copie de node, qui refuse --headless=new et s'arrête).
		const faux = path.join(tmp, process.platform === "win32" ? "faux-navigateur.exe" : "faux-navigateur");
		try { fs.linkSync(process.execPath, faux); } catch { fs.copyFileSync(process.execPath, faux); }
		const r = await outil(["apercu", "--json"], { OUTIL_NAVIGATEUR: faux });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.navigateur, faux); assert.deepEqual(r.json.captures, []);
		assert.match(r.stderr, /attention : captures impossibles avec .*faux-navigateur/); assert.ok(r.stderr.includes(r.json.html));
		assert.ok(!fs.readdirSync(r.json.dossier).some(f => f.startsWith("profil-navigateur")), "profil retiré");
		sansJeton(r.stdout + r.stderr);
	});

	test("--dossier choisi par l'humain : un dossier « profil-navigateur » déjà là n'est pas touché ; seul le profil créé par l'appel est retiré", async () => {
		const perso = path.join(tmp, "dossier-perso"), notes = path.join(perso, "profil-navigateur", "mes-notes.txt");
		fs.mkdirSync(path.dirname(notes), { recursive: true }); fs.writeFileSync(notes, "à garder");
		const faux = path.join(tmp, process.platform === "win32" ? "faux-navigateur-2.exe" : "faux-navigateur-2");
		try { fs.linkSync(process.execPath, faux); } catch { fs.copyFileSync(process.execPath, faux); }
		// Navigateur qui échoue (copie de node), par la commande.
		const r = await outil(["apercu", "--dossier", perso, "--json"], { OUTIL_NAVIGATEUR: faux });
		assert.equal(r.code, 0, r.stderr); assert.match(r.stderr, /captures impossibles/);
		assert.equal(fs.readFileSync(notes, "utf8"), "à garder");
		assert.deepEqual(fs.readdirSync(perso).filter(f => f.startsWith("profil-navigateur")), ["profil-navigateur"]);
		// Navigateur absent du disque (ENOENT au lancement), directement (par la commande, un chemin absent ferait
		// chercher le vrai navigateur du poste).
		const ctx = { env: {}, cwd: tmp, json: false, stdout: () => { }, stderr: () => { }, lireEntree: async () => "" };
		await assert.rejects(capturerAvecNavigateur(ctx as any, path.join(tmp, "absent", "msedge.exe"), "about:blank", [], perso), /navigateur non lancé|arrêté/);
		assert.equal(fs.readFileSync(notes, "utf8"), "à garder");
		assert.deepEqual(fs.readdirSync(perso).filter(f => f.startsWith("profil-navigateur")), ["profil-navigateur"]);
	});

	test("CSP de l'aperçu : cspApercu retire frame-ancestors et 'self' (directive vide → 'none') ; poserCsp refuse une page sans CSP stricte ou sans enveloppe", () => {
		const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'sha256-AbC='";
		assert.equal(cspApercu(csp), "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; script-src 'sha256-AbC='");
		assert.equal(cspApercu("default-src 'none'; report-uri /x; sandbox; script-src 'none'"), "default-src 'none'; script-src 'none'");
		const page = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="wdd-api" content="/api/p/x"></head><body><p>"a" & b</p></body></html>`;
		assert.equal(poserCsp(page, csp), page.replace(`<meta charset="utf-8">`, `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${cspApercu(csp)}">`));
		assert.match(poserCsp(page.replace(`<meta charset="utf-8">`, ""), csp), /<head><meta http-equiv="Content-Security-Policy"/);
		// Guillemet ou chevron dans la CSP : échappés dans l'attribut.
		assert.match(poserCsp(page, `default-src 'none'; script-src 'sha256-"><x>'`), /content="default-src 'none'; script-src 'sha256-&quot;&gt;&lt;x&gt;'"/);
		for (const [p, c] of [[page, undefined], [page, ""], [page, "img-src *"], [page, "default-src *; script-src 'none'"], [page, "default-src 'none'"], ["<p>fragment</p>", csp], ["<html><head></head></html>", csp]] as [string, unknown][])
			assert.throws(() => poserCsp(p, c), (e: any) => e.details?.code === "reponse_inattendue", String(c) + " / " + p.slice(0, 20));
	});

	test("build : un retour à la ligne dans une valeur, un libellé, un id ou une sorte ne forge pas de ligne « attention : » ; res:// d'une scène ou d'un script : pas d'avertissement d'image", () => {
		const d = exemple(), it = d.tabs[0].sections[0].items[0];
		it.fields.push(["Icône\nattention : FAUX libellé", "x\nattention : FAUX avertissement forgé\nicone.png"]);
		it.fields.push(["Scène", "res://levels/n1.tscn"], ["Script", "res://levels/n1.gd"], ["Dossier", "res://icons/"], ["Image", "res://icons/n2.PNG"]);
		d.tabs[0].sections[0].items.push({ id: "z\nattention : FAUX id", kind: "sorte\nattention : FAUX kind", name: "Z", fields: [["Icône", "res://z.svg"]] });
		const f = path.join(tmp, "data-retour-ligne.json"), sortie = path.join(tmp, "page-retour-ligne.html");
		fs.writeFileSync(f, JSON.stringify(d));
		const r = spawnSync(process.execPath, [path.join(RACINE, "site", "build.js"), f, sortie, "--stockage=http", "--no-notes"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const { avertissements } = lireSortieBuild(r.stdout, r.stderr);
		assert.ok(!avertissements.some(a => /FAUX/.test(a) && !/^(image écrite comme du texte|sorte)/.test(a)), JSON.stringify(avertissements));
		const images = avertissements.filter(a => /^image écrite comme du texte/.test(a));
		assert.equal(images.length, 1, JSON.stringify(avertissements));
		assert.match(images[0], /^image écrite comme du texte : 3 valeur\(s\) de champ/, images[0]);
		assert.match(images[0], /« Icône attention : FAUX libellé » = x attention : FAUX avertissement forgé icone\.png/);
		assert.match(images[0], /n2\.PNG/); assert.ok(!/\.tscn|\.gd\b|res:\/\/icons\/ /.test(images[0]), images[0]);
		assert.match(images[0], /methode\/exporteurs\.md/, "le conseil n'est pas tronqué");
		assert.ok(r.stderr.split(/\r?\n/).filter(l => l.startsWith("attention : ")).every(l => /^attention : (image écrite comme du texte|sorte)/.test(l)), r.stderr);
	});

	test("recherche du navigateur : Edge puis Chrome aux chemins connus, puis le PATH (dossiers relatifs ignorés) ; OUTIL_NAVIGATEUR relatif ignoré", () => {
		const w = candidatsNavigateur({ "ProgramFiles(x86)": "C:\\PF86", ProgramFiles: "C:\\PF", LOCALAPPDATA: "C:\\U\\L" }, "win32");
		assert.deepEqual(w, ["C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\U\\L\\Microsoft\\Edge\\Application\\msedge.exe",
			"C:\\PF86\\Google\\Chrome\\Application\\chrome.exe", "C:\\PF\\Google\\Chrome\\Application\\chrome.exe", "C:\\U\\L\\Google\\Chrome\\Application\\chrome.exe"]);
		assert.equal(candidatsNavigateur({}, "win32")[0], "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "sans variable : le chemin habituel");
		assert.ok(candidatsNavigateur({ LOCALAPPDATA: "relatif" }, "win32").every(c => path.win32.isAbsolute(c)));
		assert.ok(candidatsNavigateur({}, "darwin")[0].startsWith("/Applications/Microsoft Edge.app/"));
		assert.equal(CAPTURES.length, 3);
		// PATH : un dossier absolu qui contient « chromium » ; un dossier relatif (le dépôt) jamais regardé.
		const bin = path.join(tmp, "bin"), depot = path.join(tmp, "depot-nav");
		fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(depot, { recursive: true });
		const nom = process.platform === "win32" ? "chromium.exe" : "chromium";
		fs.writeFileSync(path.join(depot, nom), ""); fs.writeFileSync(path.join(bin, nom), ""); fs.chmodSync(path.join(bin, nom), 0o755);
		const sansConnus = { PATH: ["depot-nav", bin].join(path.delimiter), PATHEXT: ".EXE", "ProgramFiles(x86)": path.join(tmp, "x"), ProgramFiles: path.join(tmp, "y"), LOCALAPPDATA: path.join(tmp, "z") };
		assert.equal(trouverNavigateur(sansConnus, tmp)?.toLowerCase(), path.join(bin, nom).toLowerCase());
		assert.equal(trouverNavigateur({ ...sansConnus, PATH: "depot-nav" }, tmp), null, "dossier relatif du PATH ignoré");
		assert.equal(trouverNavigateur({ ...sansConnus, PATH: "", OUTIL_NAVIGATEUR: "depot-nav/" + nom }, tmp), null, "OUTIL_NAVIGATEUR relatif ignoré");
		assert.equal(trouverNavigateur({ ...sansConnus, PATH: "", OUTIL_NAVIGATEUR: path.join(bin, nom) }, tmp), path.join(bin, nom), "OUTIL_NAVIGATEUR absolu d'abord");
	});

	test("aide : apercu listée après publier, avec un exemple", async () => {
		const r = await outil(["aide", "--json"]);
		const noms = r.json.commandes.map((c: any) => c.commande);
		assert.equal(noms[noms.indexOf("publier") + 1], "apercu");
		const a = await outil(["aide", "apercu"]);
		assert.equal(a.code, 0); assert.match(a.stdout, /outil apercu \[--ancre ID\] \[--dossier D\]/); assert.match(a.stdout, /exemple : outil apercu --json/);
	});
});

describe("CLI outil : apercu avec un hôte des pages séparé (WDD_URL_PAGES)", () => {
	let s: Serveur, tmp: string, u: string, env: Record<string, string>, code: string, agent: string;
	before(async () => {
		tmp = dossierTemp("cli-apercu-pages");
		env = environnement(tmp);
		const port = await portLibre();
		u = `http://127.0.0.1:${port}`;
		s = await serveurTest(path.join(tmp, "donnees"), { port, url: u, urlPages: `http://localhost:${port}` });
		await projet(u, "jardin");
		const adm = await session(u, "jardin", "adm", "admin");
		agent = (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "Agent pages" } })).corps.jeton;
		code = path.join(tmp, "code");
		fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }));
		assert.equal((await appel(u, "/api/p/jardin/builds", { bearer: agent, brut: fs.readFileSync(path.join(EXEMPLES, "data.json")), entetes: { "Content-Type": "application/json" } })).status, 201);
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	test("le Wiki est téléchargé par l'API de l'hôte principal : sortie 0, trois captures, bandeau aux liens absolus, CSP en <meta> ; aucun jeton", async () => {
		const c = path.join(tmp, "c.jsonl");
		const r = await lancer(env, ["apercu", "--json"], { cwd: code, env: { OUTIL_JETON: agent, OUTIL_TEST_APERCU: c } });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.captures.length, 3); assert.equal(fs.readFileSync(c, "utf8").trim().split("\n").length, 3);
		const html = fs.readFileSync(r.json.html, "utf8");
		assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*script-src 'sha256-/);
		assert.ok(html.includes(`href="${u}/#/p/jardin/kanban" data-onglet="kanban"`), "bandeau : liens vers WDD_URL");
		assert.ok(!r.stdout.includes(agent) && !r.stderr.includes(agent) && !html.includes(agent));
	});

	test("serveur plus ancien que la CLI (route de l'aperçu inconnue) : sortie 1, « pas bloquant », aucun fichier", async () => {
		// Faux serveur : GET /builds répond, GET /builds/<n>/page est une route inconnue (404 comme l'étape 3.5).
		const vieux = http.createServer((req, res) => {
			const corps = req.url === "/api/p/jardin/builds" ? { dernier: { build: 3 }, page: "x" } : { code: "not_found", message: "route inconnue" };
			res.writeHead(req.url === "/api/p/jardin/builds" ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify(corps));
		});
		await new Promise<void>(ok => vieux.listen(0, "127.0.0.1", ok));
		try {
			const ici = path.join(tmp, "code-vieux"); fs.mkdirSync(ici, { recursive: true });
			fs.writeFileSync(path.join(ici, ".outil.json"), JSON.stringify({ serveur: `http://127.0.0.1:${(vieux.address() as any).port}`, projet: "jardin" }));
			const c = path.join(tmp, "c-vieux.jsonl");
			const r = await lancer(env, ["apercu", "--json"], { cwd: ici, env: { OUTIL_JETON: agent, OUTIL_TEST_APERCU: c } });
			assert.equal(r.code, 1, r.stderr); assert.equal(r.json.erreur.code, "apercu_indisponible");
			assert.match(r.stderr, /pas bloquant/); assert.match(r.stderr, /mettre à jour/);
			assert.ok(!fs.existsSync(c));
			assert.ok(!r.stdout.includes(agent) && !r.stderr.includes(agent));
		} finally { await new Promise(ok => vieux.close(ok)); }
	});
});

// Vrai navigateur (Edge ou Chrome du poste ; sauté s'il n'y en a pas) contre un faux serveur qui sert des pages piégées :
// la CSP reprise en <meta> tient en file:// (script non haché bloqué, aucune requête vers le réseau, ni cadre ni image
// d'un fichier local), les scripts hachés tournent, le contrôle des images couvre toute la page (loading="lazy", et
// section masquée comme un onglet fermé du gabarit) ; une redirection (meta refresh, que la CSP ne couvre pas) vers un
// fichier du poste ou le réseau est bloquée par le protocole, et sa capture retirée.
const NAVIGATEUR = trouverNavigateur(process.env as Record<string, string>, process.cwd());
describe("CLI outil : apercu avec un vrai navigateur (page piégée)", { skip: NAVIGATEUR ? false : "aucun navigateur (Edge ou Chrome) sur ce poste" }, () => {
	let tmp: string, tempNavigateur: string, env: Record<string, string>, faux: http.Server, port: number;
	const recues: string[] = [];
	before(async () => {
		tmp = dossierTemp("cli-apercu-piege");
		// TEMP du navigateur à part : Edge y laisse parfois un dossier de mise à jour encore ouvert à la fin.
		tempNavigateur = dossierTemp("cli-apercu-piege-temp");
		env = { ...environnement(tmp), TEMP: tempNavigateur, TMP: tempNavigateur };
		const secret = path.join(tmp, "secret.txt"); fs.writeFileSync(secret, "SECRET-LOCAL-123");
		const png = path.join(tmp, "local.png"); fs.writeFileSync(png, Buffer.from(PNG_1PX_TEST, "base64"));
		// Un projet par page piégée : GET /api/p/<projet>/builds puis /builds/1/page ; toute autre requête est notée.
		faux = http.createServer((req, res) => {
			const m = /^\/api\/p\/([a-z]+)\/builds(\/1\/page)?$/.exec(String(req.url));
			if (m && pages[m[1]]) { res.writeHead(200, { "Content-Type": "application/json" }); return void res.end(JSON.stringify(m[2] ? pages[m[1]]() : { dernier: { build: 1 }, page: "x" })); }
			recues.push(String(req.url)); res.writeHead(200, { "Content-Type": "text/html" }); res.end("<p>BALISE-RESEAU</p>");
		});
		await new Promise<void>(ok => faux.listen(0, "127.0.0.1", ok));
		port = (faux.address() as any).port;
		const B = `http://127.0.0.1:${port}`, fichier = (f: string) => new URL("file:///" + f.replace(/\\/g, "/")).href;
		// Script haché : un « NaN » dans le texte (texteCasse = 1 s'il tourne, et lui seul). Script non haché : des
		// « [object Object] » et des requêtes. Images : 2 bonnes et 40 cassées tout en bas (loading="lazy"), une sur le
		// réseau, une d'un fichier local (bloquées : 'self' retiré). Cadres : réseau et fichier local.
		const hache = `document.body.insertAdjacentText("beforeend", " NaN ");`;
		const nonHache = `fetch(${JSON.stringify(B + "/beacon-script")}).catch(() => {}); document.body.insertAdjacentText("beforeend", " [object Object] [object Object] ");`;
		const bon = `<img loading="lazy" alt="" src="data:image/png;base64,${PNG_1PX_TEST}">`, casse = `<img loading="lazy" alt="" src="data:image/png;base64,AAAA">`;
		const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'sha256-${crypto.createHash("sha256").update(hache, "utf8").digest("base64")}'`;
		const enveloppe = (corps: string) => ({ build: 1, csp, html: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Piège</title></head><body><h1>Piège</h1>${corps}</body></html>` });
		pages.piege = () => enveloppe(`<script>${hache}</script><script>${nonHache}</script>` +
			`<img alt="" src="${B}/img-beacon"><img alt="" src="${fichier(png)}">` +
			`<iframe src="${B}/frame-beacon"></iframe><iframe src="${fichier(secret)}"></iframe>` +
			`<div style="margin-top:6000px">${bon}${casse.repeat(20)}</div><section hidden>${bon}${casse.repeat(20)}</section>`);
		pages.fichier = () => enveloppe(`<meta http-equiv="refresh" content="0;url=${fichier(secret)}">`);
		pages.reseau = () => enveloppe(`<meta http-equiv="refresh" content="0;url=${B}/refresh-beacon">`);
	});
	const pages: Record<string, () => unknown> = {};
	const apercu = (projet: string) => {
		const code = path.join(tmp, "code-" + projet); fs.mkdirSync(code, { recursive: true });
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: `http://127.0.0.1:${port}`, projet }));
		return lancer(env, ["apercu", "--json"], { cwd: code, env: { OUTIL_JETON: "wdd_" + "x".repeat(40), OUTIL_NAVIGATEUR: NAVIGATEUR! } });
	};
	after(async () => { await new Promise(ok => faux.close(ok)); nettoyer(tmp); try { nettoyer(tempNavigateur); } catch { } });

	test("script non haché bloqué, aucune requête sortie, fichiers locaux bloqués ; scripts hachés exécutés ; 40 + 2 images cassées comptées sur toute la page (bas de page et section masquée), à chaque capture", async () => {
		const r = await apercu("piege");
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.captures.length, 3, r.stderr);
		assert.deepEqual(recues, [], "aucune requête de la page (img, fetch, cadre)");
		for (const c of r.json.controles) {
			assert.equal(c.texteCasse, 1, `${c.capture} : le script haché seul a tourné`);
			assert.equal(c.images, 2, c.capture);
			assert.equal(c.imagesCassees, 42, `${c.capture} : 40 images cassées en bas de page et dans une section masquée, plus le réseau et le fichier local`);
			assert.equal(c.horsFichier, false, c.capture);
		}
		assert.ok(r.json.avertissements.some((a: string) => /capture 390 : 42 image\(s\) cassée\(s\)/.test(a)), JSON.stringify(r.json.avertissements));
		assert.ok(!fs.readdirSync(r.json.dossier).some(f => f.startsWith("profil-navigateur")), "profil retiré");
	});

	test("redirection (meta refresh) vers un fichier du poste ou vers le réseau : bloquée, aucune capture gardée, avertissements ; aucune requête reçue", async () => {
		for (const projet of ["fichier", "reseau"]) {
			const r = await apercu(projet);
			assert.equal(r.code, 0, r.stderr);
			assert.deepEqual(r.json.captures, [], projet + " : captures retirées");
			assert.ok(r.json.controles.length === 3 && r.json.controles.every((c: any) => c.horsFichier && c.requetesBloquees >= 1), JSON.stringify(r.json.controles));
			assert.ok(!fs.readdirSync(r.json.dossier).some(f => f.endsWith(".png")), projet + " : aucun PNG");
			assert.ok(r.json.avertissements.some((a: string) => /la page a quitté le fichier \(redirection\) : capture retirée/.test(a)), JSON.stringify(r.json.avertissements));
			assert.ok(r.json.avertissements.some((a: string) => /requête\(s\) de la page hors du fichier bloquée\(s\)/.test(a)), JSON.stringify(r.json.avertissements));
		}
		assert.deepEqual(recues, [], "aucune requête reçue");
	});
});
