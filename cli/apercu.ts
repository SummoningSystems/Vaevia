// CLI « outil » : aperçu du Wiki (étape 3.6, docs/etape3-6-wiki-ui.md § A.1). L'agent voit enfin le Wiki qu'il
// publie : le dernier build est téléchargé par l'API (GET /api/p/<projet>/builds/<n>/page : la page servie à ce jeton,
// bandeau compris, et sa CSP ; jeton dans l'en-tête Authorization seulement, jamais dans une URL ni dans un argument de
// processus), écrit dans le dossier de travail, puis capturé par Edge ou Chrome sans fenêtre. Même chemin dans les
// deux modes du serveur (un seul hôte, ou WDD_URL_PAGES).
//   outil apercu [--ancre ID] [--dossier D] [--json]
// Ouvert en file://, le fichier n'a plus l'en-tête CSP du serveur, qui est la défense de fond contre une injection dans
// le build : il la reprend donc en <meta http-equiv> en tête de <head> (cspApercu : sans frame-ancestors, ignoré en
// méta, et sans 'self', qui viserait ici les fichiers du poste). La CSP ne couvre pas la navigation du document
// (meta refresh) : toute requête autre que le fichier est en plus refusée par le protocole (Fetch), et une capture
// prise ailleurs que sur le fichier est retirée. Ni script non haché, ni requête réseau, ni fichier local (cadre,
// image, redirection) dans les captures que l'agent relit.
// Trois captures PNG du fichier local : bureau (1280 px, clair), sombre (1280 px, prefers-color-scheme: dark par
// Emulation.setEmulatedMedia) et téléphone (390 px), le haut de la page (ou de l'ancre). Le navigateur est piloté par
// le protocole DevTools sur un tube (--remote-debugging-pipe : aucun port ouvert), avec un profil neuf créé pour
// l'appel (mkdtemp) et retiré à la fin, et ne reçoit ni le jeton ni OUTIL_JETON. Avant les mesures, les images
// (loading="lazy" dans le gabarit) sont toutes chargées : le contrôle des images couvre la page entière, pas le
// premier écran. Sans navigateur trouvé : sortie 0, un avertissement et le chemin du HTML.
// La page est ouverte hors du serveur (file://) : ses retours sont indisponibles, c'est attendu ; elle doit rester
// lisible. Pas refusée sous la veille (OUTIL_DEMANDE) : elle n'écrit rien sur le serveur.
// OUTIL_TEST_APERCU (tests seulement) : « aucun » = aucun navigateur ; un chemin de fichier = faux navigateur, qui y
// ajoute une ligne JSON par capture demandée et écrit une image PNG de 1 px.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ChildProcess } from "node:child_process";
import { CODES, ErreurCli, erreur, usage, chargerConfig, jetonPour, requete, emettre, coupe, dossierTravail, chercherProgramme, arreterArbre, envEnfant, valeurEnv, pause } from "./commun.ts";
import type { Contexte, Commande, Env } from "./commun.ts";

export type Capture = { nom: "bureau" | "sombre" | "390"; largeur: number; hauteur: number; sombre: boolean; mobile: boolean };
export const CAPTURES: Capture[] = [
	{ nom: "bureau", largeur: 1280, hauteur: 1000, sombre: false, mobile: false },
	{ nom: "sombre", largeur: 1280, hauteur: 1000, sombre: true, mobile: false },
	{ nom: "390", largeur: 390, hauteur: 1400, sombre: false, mobile: true },
];
const ANCRE = /^[a-z0-9]+(-{1,3}[a-z0-9]+)*$/;
const DELAI_NAVIGATEUR_MS = 60000, ATTENTE_RENDU_MS = 1200;
// PNG de 1 × 1 px (faux navigateur des tests).
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// --- Navigateur ---------------------------------------------------------------------------------------------------------
// Chemins absolus connus d'Edge puis de Chrome (Windows : Program Files, Program Files (x86), installation par
// utilisateur sous LOCALAPPDATA ; macOS : /Applications), puis les noms usuels dans le PATH (jamais le dossier courant).
export function candidatsNavigateur(env: Env, plateforme = process.platform): string[] {
	if (plateforme === "win32") {
		const bases = [valeurEnv(env, "ProgramFiles(x86)", "win32") || "C:\\Program Files (x86)", valeurEnv(env, "ProgramFiles", "win32") || "C:\\Program Files", valeurEnv(env, "LOCALAPPDATA", "win32") || ""]
			.filter(b => path.win32.isAbsolute(b));
		return [...bases.map(b => path.win32.join(b, "Microsoft", "Edge", "Application", "msedge.exe")), ...bases.map(b => path.win32.join(b, "Google", "Chrome", "Application", "chrome.exe"))];
	}
	if (plateforme === "darwin") return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
	return [];
}
export const NOMS_NAVIGATEUR = ["msedge", "microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
// OUTIL_NAVIGATEUR=<chemin absolu> (choix de l'humain : Chromium ailleurs, autre navigateur de la même famille) passe
// avant ; un chemin relatif est ignoré (il désignerait le dépôt).
export function trouverNavigateur(env: Env, depuis: string): string | null {
	const choisi = valeurEnv(env, "OUTIL_NAVIGATEUR");
	if (choisi && path.isAbsolute(choisi)) { try { if (fs.statSync(choisi).isFile()) return choisi; } catch { } }
	for (const c of candidatsNavigateur(env)) { try { if (fs.statSync(c).isFile()) return c; } catch { } }
	for (const n of NOMS_NAVIGATEUR) { const p = chercherProgramme(n, env, depuis); if (p) return p; }
	return null;
}

// --- Protocole DevTools sur un tube (fd 3 : vers le navigateur, fd 4 : depuis lui ; messages JSON terminés par \0) ----
type Cdp = { envoyer: (methode: string, params?: Record<string, unknown>, session?: string) => Promise<any>; ecouter: (f: (m: any) => void) => void; fermer: () => void };
function connecterTube(enfant: ChildProcess): Cdp {
	const versLui = enfant.stdio[3] as NodeJS.WritableStream, deLui = enfant.stdio[4] as NodeJS.ReadableStream;
	let n = 0, reste = "", ferme = "";
	const attente = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void; methode: string }>();
	const ecouteurs: ((m: any) => void)[] = [];
	const toutRejeter = (m: string) => { ferme ||= m; for (const a of attente.values()) a.ko(new Error(m)); attente.clear(); };
	deLui.on("data", (b: Buffer) => {
		reste += b.toString("utf8");
		let i: number;
		while ((i = reste.indexOf("\0")) >= 0) {
			const brut = reste.slice(0, i); reste = reste.slice(i + 1);
			let m: any; try { m = JSON.parse(brut); } catch { continue; }
			// Événement (pas de id) : aux écouteurs (Fetch.requestPaused).
			if (!m.id && m.method) { for (const f of ecouteurs) try { f(m); } catch { } continue; }
			const a = m.id ? attente.get(m.id) : undefined;
			if (!a) continue;
			attente.delete(m.id);
			if (m.error) a.ko(new Error(`${a.methode} : ${m.error.message}`)); else a.ok(m.result || {});
		}
	});
	deLui.on("error", () => toutRejeter("tube DevTools fermé"));
	// Navigateur arrêté pendant une écriture : EPIPE sur le tube, à rendre en erreur (sinon le processus s'arrête net).
	(versLui as NodeJS.WritableStream & { on: (e: string, f: (x: Error) => void) => void }).on("error", e => toutRejeter(`tube DevTools fermé (${e.message})`));
	enfant.on("exit", () => toutRejeter("le navigateur s'est arrêté"));
	return {
		envoyer: (methode, params = {}, session) => new Promise((ok, ko) => {
			if (ferme) return ko(new Error(ferme));
			const id = ++n;
			attente.set(id, { ok, ko, methode });
			versLui.write(JSON.stringify(session ? { id, method: methode, params, sessionId: session } : { id, method: methode, params }) + "\0");
		}),
		ecouter: f => { ecouteurs.push(f); },
		fermer: () => { try { versLui.end(); } catch { } },
	};
}
const avecDelai = <T>(p: Promise<T>, ms: number, quoi: string): Promise<T> => {
	let t: NodeJS.Timeout;
	return Promise.race([p, new Promise<T>((_, ko) => { t = setTimeout(() => ko(new Error(`${quoi} : pas de réponse en ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
};

// requetesBloquees : requêtes de la page hors du fichier (réseau, autre fichier), refusées ; horsFichier : la page a
// quitté le fichier avant la capture (redirection), capture retirée.
export type Controle = { capture: string; largeurDocument: number; largeurFenetre: number; images: number; imagesCassees: number; texteCasse: number; requetesBloquees: number; horsFichier: boolean };
// Adresse d'un fichier sans fragment, décodée, en minuscules (lettre de lecteur, encodage) : pour comparer l'URL ouverte
// à celle d'une requête ou du document.
const memeFichier = (u: string) => { const sans = u.split("#")[0]; try { return decodeURI(sans).toLowerCase(); } catch { return sans.toLowerCase(); } };
// Avant les mesures : toutes les images de la page chargées (le gabarit pose loading="lazy" : une fiche basse ne
// serait sinon jamais vérifiée), au plus ATTENTE_IMAGES_MS.
const ATTENTE_IMAGES_MS = 5000;
const CHARGER_IMAGES = `(() => { const imgs = [...document.images].filter(i => i.getAttribute("src"));
	for (const i of imgs) if (i.loading === "lazy") i.loading = "eager";
	return Promise.race([Promise.all(imgs.map(i => i.decode().catch(() => null))), new Promise(r => setTimeout(r, ${ATTENTE_IMAGES_MS}))]).then(() => imgs.length); })()`;
// Mesures prises dans la page après le rendu : débordement horizontal, images (chargées ; cassées ou jamais chargées),
// texte cassé.
const MESURE = `(() => { const t = document.body ? document.body.innerText : "";
	const imgs = [...document.images].filter(i => i.getAttribute("src")), bonne = i => i.complete && i.naturalWidth > 0;
	return JSON.stringify({ largeurDocument: document.documentElement.scrollWidth, largeurFenetre: innerWidth,
		images: imgs.filter(bonne).length, imagesCassees: imgs.filter(i => !bonne(i)).length,
		texteCasse: (t.match(/\\bundefined\\b|\\bNaN\\b|\\[object Object\\]/g) || []).length }); })()`;

// --- CSP du fichier local ----------------------------------------------------------------------------------------------
// La CSP que le serveur poserait sur la page (en-tête), adaptée à un fichier ouvert en file:// : frame-ancestors (et
// report-uri, report-to, sandbox) retirés, ignorés dans une balise <meta> ; 'self' retiré de chaque directive (en
// file://, il désignerait les fichiers du poste : cadre, image ou fetch d'un fichier local), une directive vide
// devient 'none'. Les empreintes des scripts restent valables : leur contenu ne change pas.
export function cspApercu(csp: string): string {
	return csp.split(";").map(d => d.trim()).filter(d => d && !/^(frame-ancestors|report-uri|report-to|sandbox)(\s|$)/i.test(d)).map(d => {
		const [nom, ...sources] = d.split(/\s+/);
		const gardees = sources.filter(s => s.toLowerCase() !== "'self'");
		return `${nom} ${gardees.length ? gardees.join(" ") : "'none'"}`;
	}).join("; ");
}
const escAttr = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
// La page avec sa CSP en <meta http-equiv>, juste après <head> (et <meta charset>), avant tout contenu. Refus (rien
// n'est écrit) si la CSP ne commence pas par default-src 'none' ou n'a pas de script-src, ou si la page n'a pas
// l'enveloppe attendue : jamais de fichier local sans CSP.
export function poserCsp(page: string, csp: unknown): string {
	const directives = typeof csp === "string" ? cspApercu(csp).split("; ") : [];
	const m = /^\s*<!doctype html>\s*<html\b[^>]*>\s*<head\b[^>]*>(\s*<meta charset="?utf-8"?\s*\/?>)?/i.exec(page);
	if (directives[0] !== "default-src 'none'" || !directives.some(d => d.startsWith("script-src ")) || !m)
		throw erreur("réponse inattendue du serveur pour le Wiki (page sans enveloppe, ou CSP absente ou trop large) : aperçu refusé, aucun fichier écrit ; mettre le serveur à jour", { code: "reponse_inattendue" });
	const fin = m.index + m[0].length;
	return page.slice(0, fin) + `<meta http-equiv="Content-Security-Policy" content="${escAttr(directives.join("; "))}">` + page.slice(fin);
}

// Arguments et environnement du navigateur : profil neuf, tube DevTools (aucun port), le fichier local seulement ;
// ni le jeton (il n'est jamais dans un argument) ni OUTIL_JETON.
export const argumentsNavigateur = (profil: string) => ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
	"--hide-scrollbars", "--mute-audio", "--remote-debugging-pipe", `--user-data-dir=${profil}`, "about:blank"];
export const envNavigateur = (env: Env) => envEnfant(env, { retirer: ["OUTIL_JETON"] });

// Profil du navigateur : un dossier neuf créé par l'appel lui-même dans <dossier> (profil-navigateur-XXXXXX), seul
// retiré à la fin ; un dossier déjà présent (--dossier choisi par l'humain) n'est jamais touché.
export async function capturerAvecNavigateur(ctx: Contexte, navigateur: string, url: string, sorties: { capture: Capture; chemin: string }[], dossier: string): Promise<Controle[]> {
	const profil = fs.mkdtempSync(path.join(dossier, "profil-navigateur-"));
	const enfant = spawn(navigateur, argumentsNavigateur(profil),
		{ stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: envNavigateur(ctx.env) });
	const fini = new Promise<void>(ok => { enfant.on("exit", () => ok()); enfant.on("error", () => ok()); });
	const lancement = new Promise<never>((_, ko) => enfant.on("error", e => ko(new Error(`navigateur non lancé : ${e.message}`))));
	lancement.catch(() => { });
	const cdp = connecterTube(enfant);
	try {
		const envoyer = (m: string, p?: Record<string, unknown>, s?: string) => Promise.race([avecDelai(cdp.envoyer(m, p, s), DELAI_NAVIGATEUR_MS, m), lancement]);
		const { targetId } = await envoyer("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await envoyer("Target.attachToTarget", { targetId, flatten: true });
		const s = (m: string, p?: Record<string, unknown>) => envoyer(m, p, sessionId);
		await s("Page.enable"); await s("Runtime.enable");
		// La CSP en <meta> ne couvre pas la navigation du document (meta refresh, lien) : toute requête autre que le
		// fichier lui-même est refusée par le protocole (Fetch), et une capture prise ailleurs que sur le fichier est
		// retirée (horsFichier) : ni réseau, ni autre fichier du poste dans ce que l'agent relit.
		const fichier = memeFichier(url);
		let bloquees = 0;
		cdp.ecouter(ev => {
			if (ev.method !== "Fetch.requestPaused" || ev.sessionId !== sessionId) return;
			const permise = memeFichier(String(ev.params?.request?.url || "")) === fichier;
			if (!permise) bloquees++;
			cdp.envoyer(permise ? "Fetch.continueRequest" : "Fetch.failRequest", permise ? { requestId: ev.params.requestId } : { requestId: ev.params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => { });
		});
		await s("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
		const controles: Controle[] = [];
		for (const { capture: c, chemin } of sorties) {
			const avant = bloquees;
			await s("Emulation.setDeviceMetricsOverride", { width: c.largeur, height: c.hauteur, deviceScaleFactor: 1, mobile: c.mobile });
			await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: c.sombre ? "dark" : "light" }] });
			// about:blank entre deux captures : la même URL (ancre comprise) serait sinon une navigation dans le document.
			await s("Page.navigate", { url: "about:blank" });
			await s("Page.navigate", { url });
			for (let i = 0; i < 100; i++) {
				const r = await s("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
				if (r.result?.value === "complete") break;
				await pause(100);
			}
			await s("Runtime.evaluate", { expression: CHARGER_IMAGES, awaitPromise: true, returnByValue: true });
			await pause(ATTENTE_RENDU_MS);
			const m = await s("Runtime.evaluate", { expression: MESURE, returnByValue: true });
			const img = await s("Page.captureScreenshot", { format: "png" });
			const ici = await s("Runtime.evaluate", { expression: "location.href", returnByValue: true });
			const horsFichier = memeFichier(String(ici.result?.value || "")) !== fichier;
			if (!horsFichier) fs.writeFileSync(chemin, Buffer.from(String(img.data), "base64"));
			// Largeur de référence : celle de la capture (en mode mobile, innerWidth suit le contenu qui déborde).
			controles.push({ capture: c.nom, ...JSON.parse(String(m.result?.value || "{}")), largeurFenetre: c.largeur, requetesBloquees: bloquees - avant, horsFichier });
		}
		await envoyer("Browser.close").catch(() => { });
		return controles;
	} finally {
		cdp.fermer();
		const enVie = () => enfant.exitCode === null && enfant.signalCode === null && !!enfant.pid;
		if (enVie()) await Promise.race([fini, pause(3000)]);
		if (enVie()) { arreterArbre(enfant, ctx.env); await Promise.race([fini, pause(3000)]); }
		try { fs.rmSync(profil, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { }
	}
}

// --- outil apercu -------------------------------------------------------------------------------------------------------
export type ResultatApercu = {
	build: number; page: string; html: string; dossier: string; navigateur: string | null;
	captures: { nom: string; chemin: string; largeur: number; theme: "clair" | "sombre" }[]; controles: Controle[]; avertissements: string[];
};
async function telechargerPage(ctx: Contexte): Promise<{ build: number; page: string; texte: string; projet: string; depot: string }> {
	const cfg = chargerConfig(ctx), jeton = jetonPour(ctx, cfg);
	const b = await requete(ctx, cfg, jeton, "GET", "/builds");
	const build = Number(b?.dernier?.build) || 0;
	if (!build) throw erreur("aucun build sur le serveur : publier d'abord (outil publier), puis relancer outil apercu", { code: "sans_build" });
	// Le Wiki de ce build tel que le serveur le sert à ce jeton (bandeau compris) et sa CSP, par l'API de l'hôte
	// principal : en JSON, dans les deux modes du serveur.
	let p: any;
	try { p = await requete(ctx, cfg, jeton, "GET", `/builds/${build}/page`); } catch (e) {
		if (e instanceof ErreurCli && e.details.statut === 404 && /route inconnue/.test(e.message))
			throw erreur("aperçu impossible : le serveur ne connaît pas encore GET /api/p/<projet>/builds/<n>/page (serveur plus ancien que la CLI : le mettre à jour). " +
				"Ce n'est pas bloquant : continuer sans aperçu, et dire à l'humain de regarder le Wiki lui-même", { statut: 404, code: "apercu_indisponible" });
		if (e instanceof ErreurCli && e.details.statut === 404) throw erreur("le dernier build n'est plus sur le serveur : relancer outil apercu, ou publier d'abord (outil publier)", { statut: 404, code: "sans_build" });
		throw e;
	}
	if (typeof p.html !== "string" || p.build !== build)
		throw erreur(`réponse inattendue du serveur pour le Wiki (ni page ni build ${build}) : vérifier « serveur » dans ${cfg.chemin}`, { code: "reponse_inattendue" });
	return { build, page: `${cfg.serveur}/p/${cfg.projet}/`, texte: poserCsp(p.html, p.csp), projet: cfg.projet, depot: path.dirname(cfg.chemin) };
}
const dedans = (a: string, b: string) => { const r = path.relative(a, b); return !r || (!r.startsWith("..") && !path.isAbsolute(r)); };

export async function apercu(ctx: Contexte, o: { ancre?: string; dossier?: string } = {}): Promise<ResultatApercu> {
	const t = await telechargerPage(ctx);
	const dossier = o.dossier ? path.resolve(ctx.cwd, o.dossier) : path.join(dossierTravail(ctx.env, t.projet), "apercu");
	if (dedans(t.depot, dossier)) throw usage(`--dossier ${dossier} est dans le dépôt du code : l'aperçu (page et captures) reste hors du dépôt (dossier de travail par défaut)`);
	fs.mkdirSync(dossier, { recursive: true });
	const base = `apercu-${t.build}${o.ancre ? "-" + o.ancre : ""}`;
	const html = path.join(dossier, `apercu-${t.build}.html`);
	fs.writeFileSync(html, t.texte);
	const url = pathToFileURL(html).href + (o.ancre ? "#" + o.ancre : "");
	const sorties = CAPTURES.map(c => ({ capture: c, chemin: path.join(dossier, `${base}-${c.nom}.png`) }));
	for (const x of sorties) fs.rmSync(x.chemin, { force: true });
	const avertissements: string[] = [];
	const test = ctx.env.OUTIL_TEST_APERCU;
	const navigateur = test ? (test === "aucun" ? null : "(navigateur de test)") : trouverNavigateur(ctx.env, dossier);
	let controles: Controle[] = [], faites: typeof sorties = [];
	if (!navigateur) avertissements.push(`aucun navigateur trouvé (Edge ou Chrome, chemins habituels puis PATH) : pas de captures ; le Wiki téléchargé est ${html}`);
	else if (test) {
		for (const x of sorties) {
			fs.appendFileSync(test, JSON.stringify({ url, largeur: x.capture.largeur, hauteur: x.capture.hauteur, sombre: x.capture.sombre, mobile: x.capture.mobile }) + "\n");
			fs.writeFileSync(x.chemin, Buffer.from(PNG_1PX, "base64"));
			controles.push({ capture: x.capture.nom, largeurDocument: x.capture.largeur, largeurFenetre: x.capture.largeur, images: 0, imagesCassees: 0, texteCasse: 0, requetesBloquees: 0, horsFichier: false });
		}
		faites = sorties;
	} else {
		try { controles = await capturerAvecNavigateur(ctx, navigateur, url, sorties, dossier); faites = sorties.filter(x => fs.existsSync(x.chemin)); }
		catch (e) { avertissements.push(`captures impossibles avec ${navigateur} (${coupe((e as Error).message, 200)}) : le Wiki téléchargé est ${html}`); }
	}
	for (const c of controles) {
		if (c.largeurDocument > c.largeurFenetre + 1) avertissements.push(`capture ${c.capture} : défilement horizontal (contenu de ${c.largeurDocument} px pour ${c.largeurFenetre} px de large)`);
		if (c.imagesCassees) avertissements.push(`capture ${c.capture} : ${c.imagesCassees} image(s) cassée(s)`);
		if (c.texteCasse) avertissements.push(`capture ${c.capture} : ${c.texteCasse} valeur(s) cassée(s) dans le texte (undefined, NaN, [object Object])`);
		// Le gabarit ne demande rien hors du fichier : une requête bloquée ou une redirection trahit un contenu injecté dans le build.
		if (c.requetesBloquees) avertissements.push(`capture ${c.capture} : ${c.requetesBloquees} requête(s) de la page hors du fichier bloquée(s) (réseau ou autre fichier) : contenu inattendu dans le build, à signaler à l'humain`);
		if (c.horsFichier) avertissements.push(`capture ${c.capture} : la page a quitté le fichier (redirection) : capture retirée ; contenu inattendu dans le build, à signaler à l'humain`);
	}
	return {
		build: t.build, page: t.page, html, dossier, navigateur,
		captures: faites.map(x => ({ nom: x.capture.nom, chemin: x.chemin, largeur: x.capture.largeur, theme: x.capture.sombre ? "sombre" as const : "clair" as const })),
		controles, avertissements,
	};
}

export const COMMANDES_APERCU: Commande[] = [
	{
		nom: "apercu", usage: "outil apercu [--ancre ID] [--dossier D] [--json]",
		resume: "aperçu du Wiki : télécharge le dernier build dans le dossier de travail et en prend trois captures PNG (bureau 1280 px, sombre, 390 px) avec Edge ou Chrome sans fenêtre ; chemins affichés",
		detail: "Chaque capture montre le haut du Wiki, ou de l'onglet ou de la fiche donnés par --ancre. À regarder une à une (outil Read de l'agent, ou une visionneuse) : textes lisibles dans les deux thèmes, images visibles, rien qui déborde à 390 px. " +
			"--ancre : l'onglet ou la fiche à montrer (« objets », « objets--epee », sans #). --dossier : un autre dossier hors du dépôt (défaut : <travail>/apercu). " +
			"Navigateur : OUTIL_NAVIGATEUR (chemin absolu), sinon Edge puis Chrome aux chemins habituels, sinon le PATH. " +
			"Contrôles relevés dans le Wiki entier (images toutes chargées d'abord, même hors du premier écran) : défilement horizontal, images cassées ou jamais chargées, texte cassé (undefined, NaN, [object Object]) ; chacun donne un avertissement. " +
			"Les retours sont indisponibles dans l'aperçu (Wiki ouvert hors du serveur) : c'est attendu. Sans navigateur : sortie 0, un avertissement et le chemin du HTML. " +
			"Le jeton ne part que dans l'en-tête de la requête ; le navigateur ne voit que le fichier local, sous la CSP du serveur reprise en <meta> (ni script non haché, ni réseau, ni autre fichier du poste) ; toute requête hors du fichier est refusée, et une capture prise après une redirection est retirée (avertissement). Avec --json : { build, page, html, dossier, navigateur, captures: [{ nom, chemin, largeur, theme }], controles, avertissements }.",
		exemple: "outil apercu --json\n  outil apercu --ancre objets",
		options: { ancre: "valeur", dossier: "valeur" }, positionnels: [0, 0],
		faire: async (ctx, _pos, opt) => {
			const ancre = opt.ancre === undefined ? undefined : String(opt.ancre).replace(/^#/, "");
			if (ancre !== undefined && (!ANCRE.test(ancre) || ancre.length > 200)) throw usage(`--ancre : id d'onglet ou ancre de fiche (a-z, 0-9, tirets ; ex. objets, objets--epee), reçu « ${coupe(ancre, 60)} »`);
			const r = await apercu(ctx, { ancre, dossier: opt.dossier === undefined ? undefined : String(opt.dossier) });
			for (const a of r.avertissements) ctx.stderr("attention : " + a);
			const total = (k: "images" | "imagesCassees" | "texteCasse") => Math.max(0, ...r.controles.map(c => c[k]));
			const c390 = r.controles.find(c => c.capture === "390");
			emettre(ctx, r, [
				`build n° ${r.build} téléchargé : ${r.html}`,
				...(r.captures.length ? [`captures (${r.navigateur}) :`, ...r.captures.map(c => `  ${c.nom.padEnd(6)} ${String(c.largeur).padStart(4)} px, ${c.theme} : ${c.chemin}`),
					`contrôles : images chargées ${total("images")}, cassées ${total("imagesCassees")} ; texte cassé : ${total("texteCasse")} ; ` +
					`défilement horizontal à 390 px : ${c390 && c390.largeurDocument > c390.largeurFenetre + 1 ? "OUI" : "non"}`,
					"à faire : regarder chaque capture ; les retours y sont indisponibles (Wiki ouvert hors du serveur), c'est attendu"] : ["aucune capture (voir l'avertissement) : le Wiki reste à regarder par l'humain"]),
			]);
			return CODES.ok;
		},
	},
];
