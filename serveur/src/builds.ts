// Builds : le data.json reçu de l'agent est gardé dans projets/<projet>/builds/<n>/ (hors Git), la page construite par
// site/build.js --stockage=http avec les notes du dépôt de design (notes/), puis servie sur /p/<projet>/.
// La page de build.js est un fragment (format Artifact : ni doctype, ni <head>) : le serveur l'enveloppe à la
// livraison et y pose <meta name="wdd-api" content="/api/p/<projet>"> (voir envelopper()).
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { File } from "./depot.ts";
import { ErreurApi } from "./retours.ts";

const files = new Map<string, File>();

export function dossierBuilds(racineProjets: string, projet: string): string { return path.join(racineProjets, projet, "builds"); }

// Numéro du dernier build complet (page.html présente), 0 s'il n'y en a pas.
export function dernierBuild(racineProjets: string, projet: string): number {
	const dir = dossierBuilds(racineProjets, projet);
	if (!fs.existsSync(dir)) return 0;
	let n = 0;
	for (const f of fs.readdirSync(dir)) if (/^[1-9]\d{0,8}$/.test(f) && Number(f) > n && fs.existsSync(path.join(dir, f, "page.html"))) n = Number(f);
	return n;
}

// Dernier build (numéro, date de construction, poids de la page), ou null : pour « outil statut » (étape 2).
// Étape 3.7 (G2) : empreinte, celle des données reçues pour ce build sans la date d'export (site/changements.js,
// empreinteDonnees) : « outil publier --si-change » ne republie pas des données identiques ; une CI qui tourne à chaque
// fusion ne crée pas un build par commit sans changement.
const cacheEmpreintes = new Map<string, string>();
export function infoDernierBuild(racineProjets: string, projet: string, site = ""): { build: number; date: string; octets: number; empreinte: string } | null {
	const n = dernierBuild(racineProjets, projet);
	if (!n) return null;
	const dir = path.join(dossierBuilds(racineProjets, projet), String(n));
	const st = fs.statSync(path.join(dir, "page.html"));
	let sha = cacheEmpreintes.get(dir);
	if (sha === undefined) {
		try { sha = site ? (moduleChangements(site) as unknown as { empreinteDonnees: (d: unknown) => string }).empreinteDonnees(JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"))) : ""; } catch { sha = ""; }
		if (sha) cacheEmpreintes.set(dir, sha);
		return { build: n, date: st.mtime.toISOString(), octets: st.size, empreinte: sha };
	}
	return { build: n, date: st.mtime.toISOString(), octets: st.size, empreinte: sha };
}

// --- Étape 3.9 : liste des builds (L3, E5, A3), échecs récents (A5), rétention (A3) ----------------------------------
// Un build complet : numéro, date de construction, date des données (generated, que les retours citent dans « codex »),
// résumé (ligne « OK … » de build.log). Relu à chaque appel, gardé en cache par dossier tant qu'il ne change pas.
export type BuildListe = { build: number; date: string; donnees: string; resume: string; octets: number };
const cacheBuilds = new Map<string, BuildListe>();
export function listerBuilds(racineProjets: string, projet: string): BuildListe[] {
	const dir = dossierBuilds(racineProjets, projet);
	if (!fs.existsSync(dir)) return [];
	const l: BuildListe[] = [];
	for (const f of fs.readdirSync(dir)) {
		if (!/^[1-9]\d{0,8}$/.test(f)) continue;
		const b = path.join(dir, f), page = path.join(b, "page.html");
		if (!fs.existsSync(page)) continue;
		let x = cacheBuilds.get(b);
		if (!x) {
			const st = fs.statSync(page);
			let donnees = "", resume = "";
			try { const g = (JSON.parse(fs.readFileSync(path.join(b, "data.json"), "utf8")) as { generated?: unknown }).generated; donnees = typeof g === "string" ? g : ""; } catch { donnees = ""; }
			try { resume = (fs.readFileSync(path.join(b, "build.log"), "utf8").split(/\r?\n/).find(t => /^OK /.test(t)) || "").replace(/ · gabarit .*$/, "").replace(/ -> .*$/, "").slice(0, 300); } catch { resume = ""; }
			x = { build: Number(f), date: st.mtime.toISOString(), donnees, resume, octets: st.size };
			cacheBuilds.set(b, x);
		}
		l.push(x);
	}
	return l.sort((a, b) => b.build - a.build);
}
// Échecs de build récents (A5) : en mémoire seulement, les 20 derniers, tous projets.
export const echecsBuild: { projet: string; quand: string; message: string }[] = [];
// Rétention (A3) : garder les `garder` derniers builds, plus ceux que cite un retour ouvert (codex = date des données),
// jamais le dernier ni l'avant-dernier (diff L1). Rend les numéros supprimés. garder = 0 : rien n'est supprimé.
export function appliquerRetention(racineProjets: string, projet: string, garder: number, codexOuverts: Set<string>): number[] {
	if (!garder || garder < 2) return [];
	const l = listerBuilds(racineProjets, projet);
	const retires: number[] = [];
	for (const [i, b] of l.entries()) {
		if (i < garder || (b.donnees && codexOuverts.has(b.donnees))) continue;
		const d = path.join(dossierBuilds(racineProjets, projet), String(b.build));
		try { fs.rmSync(d, { recursive: true, force: true }); cacheBuilds.delete(d); retires.push(b.build); } catch { /* un fichier ouvert : réessayé au prochain build */ }
	}
	return retires;
}
// Place prise par projet (A5) : builds, dépôt de design, captures, en octets.
export function placeProjet(racineProjets: string, projet: string): { builds: number; depot: number; captures: number } {
	const taille = (d: string): number => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? taille(p) : (() => { try { return fs.statSync(p).size; } catch { return 0; } })(); } } catch { /* absent */ } return n; };
	return { builds: taille(dossierBuilds(racineProjets, projet)), depot: taille(path.join(racineProjets, projet, "depot")), captures: taille(path.join(racineProjets, projet, "captures")) };
}

// Résumé de build.js renvoyé à l'agent (étape 2, écarts CLI) : sa ligne finale sans les chemins du serveur (« OK 70 Ko ·
// 3 onglets · … · notes : 2 fichier(s), 8 nouveautés, 0 mesures, 2 points à valider ») et ses avertissements
// (« attention : … »), sinon perdus dans build.log : l'agent relit la sortie du build comme avant une publication.
export type InfoBuild = { build: number; octets: number; resume: string; avertissements: string[] };
export function lireSortieBuild(stdout: string, stderr: string): { resume: string; avertissements: string[] } {
	const derniere = String(stdout).trim().split(/\r?\n/).pop() || "";
	const resume = derniere.split(" · stockage ")[0].trim();
	const avertissements = String(stderr).split(/\r?\n/).filter(l => l.startsWith("attention : ")).map(l => l.slice("attention : ".length).trim());
	return { resume, avertissements };
}

// Retours ouverts sans élément dans le build (étape 3.7, G1) : un renommage ou un retrait détache des retours de leur
// fiche sans erreur. L'avertissement rejoint ceux de build.js dans le résumé rendu à l'agent ; jamais un échec.
// Refs de la page : site/changements.js (refsDeLaPage, même module que build.js : éléments, anciennes_refs, notes,
// onglets pour la remarque générale), sur les données injectées dans page.html (data.json plus les notes du dépôt,
// que build.js fusionne sans réécrire data.json).
export type RetourOuvert = { kind: string; ref: string };
const OUVERTS = new Set(["nouveau", "pris", "question"]);
export function retoursOuverts(index: Map<string, { donnees: Record<string, unknown> }>): RetourOuvert[] {
	const l: RetourOuvert[] = [];
	for (const d of index.values()) if (OUVERTS.has(String(d.donnees.status))) l.push({ kind: String(d.donnees.kind ?? ""), ref: String(d.donnees.ref ?? "") });
	return l;
}
type Changements = { calculerChangements: unknown; refsDeLaPage: (data: unknown) => Set<string> };
const modules = new Map<string, Changements>();
const exiger = createRequire(import.meta.url);
function moduleChangements(site: string): Changements {
	let m = modules.get(site);
	if (!m) modules.set(site, m = exiger(path.join(site, "changements.js")) as Changements);
	return m;
}
// Données de la page construite (data.json + notes fusionnées), relues dans page.html : « const DATA = {…}; ».
function donneesDeLaPage(page: string): unknown {
	const t = fs.readFileSync(page, "utf8");
	// Une seule ligne : JSON.stringify n'écrit aucune fin de ligne brute (build.js).
	const m = t.match(/^const DATA = (\{.*\});$/m);
	if (!m) return null;
	try { return JSON.parse(m[1]); } catch { return null; }
}
// Points « À valider » du dernier build (notes fusionnées dans la page) : pour la boîte « À moi » de l'Accueil
// (étape 3.7, E1). Lus une fois par build (cache par projet et numéro de build).
export type PointAValider = { id: string; texte: string; jalon: string };
const cacheValidations = new Map<string, { build: number; points: PointAValider[] }>();
export function validationsDuDernierBuild(racineProjets: string, projet: string): PointAValider[] {
	const n = dernierBuild(racineProjets, projet);
	if (!n) return [];
	const c = cacheValidations.get(racineProjets + "\u0000" + projet);
	if (c && c.build === n) return c.points;
	let points: PointAValider[] = [];
	try {
		const data = donneesDeLaPage(path.join(dossierBuilds(racineProjets, projet), String(n), "page.html")) as { notes?: { sets?: { validations?: { id?: unknown; text?: unknown; milestone?: unknown }[] }[] } } | null;
		for (const s of data?.notes?.sets || []) for (const v of s.validations || []) if (v && v.id !== undefined) points.push({ id: String(v.id), texte: String(v.text ?? "").slice(0, 300), jalon: String(v.milestone ?? "") });
	} catch { points = []; }
	cacheValidations.set(racineProjets + "\u0000" + projet, { build: n, points });
	return points;
}

export function avertissementDisparus(site: string, page: string, ouverts: RetourOuvert[]): string | null {
	if (!ouverts.length) return null;
	const data = donneesDeLaPage(page);
	if (!data) return null;
	const refs = moduleChangements(site).refsDeLaPage(data);
	const compte = new Map<string, number>();
	for (const r of ouverts) if (!refs.has(`${r.kind}\u0000${r.ref}`)) compte.set(`${r.kind}/${r.ref}`, (compte.get(`${r.kind}/${r.ref}`) || 0) + 1);
	if (!compte.size) return null;
	const n = [...compte.values()].reduce((a, b) => a + b, 0);
	const l = [...compte.entries()].slice(0, 8).map(([k, c]) => `${k.replace(/[\r\n]+/g, " ").slice(0, 80)} (${c})`);
	return `${n} retour${n > 1 ? "s" : ""} ouvert${n > 1 ? "s" : ""} sur des éléments absents de ce build : ${l.join(", ")}${compte.size > 8 ? ", …" : ""}. ` +
		"Renommage : déclarer l'ancienne ref dans « anciennes_refs » de l'élément (methode/exporteurs.md), ou l'annoncer dans la réponse ; retrait voulu : le dire dans la réponse.";
}

export function construire(racineProjets: string, site: string, projet: string, corps: Buffer, ouverts: () => RetourOuvert[] = () => []): Promise<InfoBuild> {
	let file = files.get(projet);
	if (!file) files.set(projet, file = new File());
	return file.executer(async () => {
		try { JSON.parse(corps.toString("utf8")); } catch (e) { throw new ErreurApi(400, "invalid_document", "data.json : JSON invalide (" + (e as Error).message + ")"); }
		const dir = dossierBuilds(racineProjets, projet);
		fs.mkdirSync(dir, { recursive: true });
		let n = 1;
		for (const f of fs.readdirSync(dir)) if (/^\d+$/.test(f) && Number(f) >= n) n = Number(f) + 1;
		const b = path.join(dir, String(n));
		fs.mkdirSync(b);
		const data = path.join(b, "data.json"), page = path.join(b, "page.html");
		fs.writeFileSync(data, corps);
		const notes = path.join(racineProjets, projet, "depot", "notes");
		// Étape 3.7, L1 : le data.json du dernier build complet, pour que la page montre ce qui a changé depuis.
		const avant = dernierBuild(racineProjets, projet);
		const precedent = avant ? path.join(dir, String(avant), "data.json") : "";
		const args = [path.join(site, "build.js"), data, page, "--stockage=http", ...(fs.existsSync(notes) ? ["--notes-dir", notes] : ["--no-notes"]),
			...(precedent && fs.existsSync(precedent) ? ["--precedent", precedent] : [])];
		const r = await new Promise<{ ok: boolean; sortie: string; stdout: string; stderr: string }>(ok => execFile(process.execPath, args, { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
			(e, stdout, stderr) => ok({ ok: !e, stdout: String(stdout), stderr: String(stderr), sortie: (String(stderr) + (e ? "" : String(stdout))).trim() || String(e?.message || "") })));
		if (!r.ok || !fs.existsSync(page)) {
			fs.rmSync(b, { recursive: true, force: true });
			echecsBuild.unshift({ projet, quand: new Date().toISOString(), message: (r.sortie || "échec du build").replace(/\s+/g, " ").slice(0, 300) });
			echecsBuild.length = Math.min(echecsBuild.length, 20);
			throw new ErreurApi(422, "invalid_document", r.sortie || "échec du build");
		}
		const lu = lireSortieBuild(r.stdout, r.stderr);
		let disparus: string | null = null;
		try { disparus = avertissementDisparus(site, page, ouverts()); } catch { disparus = null; }
		if (disparus) lu.avertissements.push(disparus);
		fs.writeFileSync(path.join(b, "build.log"), r.sortie + (disparus ? "\nattention : " + disparus : "") + "\n");
		return { build: n, octets: fs.statSync(page).size, ...lu };
	});
}

// Étape 3.9, I2 : fiche « sorte:ref » dans le dernier build (ref courante ou ancienne ref déclarée) : nom, onglet,
// ancre (même calcul que build.js) et date des données ; null si elle n'y est pas.
export function ficheDuDernierBuild(racineProjets: string, site: string, projet: string, kind: string, ref: string): { ref: string; name: string; tab: string; anchor: string; codex: string } | null {
	const n = dernierBuild(racineProjets, projet);
	if (!n) return null;
	let d: { generated?: unknown; tabs?: { id: string; sections?: { items?: { id?: unknown; kind?: unknown; name?: unknown; anciennes_refs?: unknown }[] }[] }[] };
	try { d = JSON.parse(fs.readFileSync(path.join(dossierBuilds(racineProjets, projet), String(n), "data.json"), "utf8")); } catch { return null; }
	const { slug } = createRequire(import.meta.url)(path.join(site, "valider-notes.js")) as { slug: (s: string) => string };
	for (const t of Array.isArray(d.tabs) ? d.tabs : [])
		for (const s of Array.isArray(t.sections) ? t.sections : [])
			for (const it of Array.isArray(s.items) ? s.items : []) {
				if (it.kind !== kind || typeof it.id !== "string") continue;
				if (it.id !== ref && !(Array.isArray(it.anciennes_refs) && it.anciennes_refs.includes(ref))) continue;
				return { ref: it.id, name: typeof it.name === "string" ? it.name : it.id, tab: t.id, anchor: `${t.id}--${slug(it.id)}`, codex: typeof d.generated === "string" ? d.generated : "" };
			}
	return null;
}

// Étape 3.9, E2 : onglets du dernier build ({ id, label }), pour choisir ceux d'un testeur ; [] sans build lisible.
export function ongletsDuDernierBuild(racineProjets: string, projet: string): { id: string; label: string }[] {
	const n = dernierBuild(racineProjets, projet);
	if (!n) return [];
	try {
		const d = JSON.parse(fs.readFileSync(path.join(dossierBuilds(racineProjets, projet), String(n), "data.json"), "utf8"));
		return Array.isArray(d.tabs) ? d.tabs.filter((t: { id?: unknown }) => typeof t?.id === "string").map((t: { id: string; label?: unknown }) => ({ id: t.id, label: typeof t.label === "string" ? t.label : t.id })) : [];
	} catch { return []; }
}

// Étape 3.9, E2 : data.json réduit aux onglets permis d'un testeur. Les liens vers un onglet retiré (élément, section ou
// onglet) sont retirés aussi : leur libellé nommerait une fiche cachée, et build.js refuse une ancre absente. Rien
// d'autre n'est réécrit : un texte libre qui parle d'un onglet caché reste lisible (écart noté).
export function donneesAudience(d: Record<string, unknown>, onglets: string[]): Record<string, unknown> {
	const garder = new Set(onglets);
	const tabs = (Array.isArray(d.tabs) ? d.tabs : []).filter((t: { id?: unknown }) => typeof t?.id === "string" && garder.has(t.id)) as Record<string, unknown>[];
	const ongletDe = (ancre: string) => ancre.replace(/^#/, "").split("--")[0];
	const copie = JSON.parse(JSON.stringify({ ...d, tabs }));
	// Sortes : seulement celles des fiches gardées (les libellés des autres nommeraient ce qui est caché).
	if (copie.kinds && typeof copie.kinds === "object" && !Array.isArray(copie.kinds)) {
		const vues = new Set<string>();
		for (const t of copie.tabs as { sections?: { items?: { kind?: unknown }[] }[] }[]) for (const s of t.sections || []) for (const it of s.items || []) if (typeof it.kind === "string") vues.add(it.kind);
		for (const k of Object.keys(copie.kinds)) if (!vues.has(k)) delete copie.kinds[k];
	}
	for (const t of copie.tabs as { sections?: { items?: { links?: unknown }[] }[] }[])
		for (const s of Array.isArray(t.sections) ? t.sections : [])
			for (const it of Array.isArray(s.items) ? s.items : [])
				if (Array.isArray(it.links)) it.links = it.links.filter((l: unknown) => !(Array.isArray(l) && typeof l[1] === "string" && l[1].startsWith("#")) || garder.has(ongletDe(l[1] as string)));
	return copie;
}

// Page d'un testeur pour le build n : construite à la demande par build.js (sans notes, sans comparaison au build
// précédent : ni l'une ni l'autre ne sont filtrées), gardée dans builds/<n>/audience-<empreinte>.html (la rétention et
// la sauvegarde suivent le build). Rend null si aucun onglet permis n'existe dans ce build.
export function pageAudience(racineProjets: string, site: string, projet: string, n: number, onglets: string[]): Promise<string | null> {
	const b = path.join(dossierBuilds(racineProjets, projet), String(n));
	const cle = createHash("sha256").update(JSON.stringify([...onglets].sort())).digest("hex").slice(0, 16);
	const cache = path.join(b, `audience-${cle}.html`);
	if (fs.existsSync(cache)) return Promise.resolve(fs.readFileSync(cache, "utf8"));
	let file = files.get(projet);
	if (!file) files.set(projet, file = new File());
	return file.executer(async () => {
		if (fs.existsSync(cache)) return fs.readFileSync(cache, "utf8");
		const d = JSON.parse(fs.readFileSync(path.join(b, "data.json"), "utf8"));
		const r = donneesAudience(d, onglets);
		if (!(r.tabs as unknown[]).length) return null;
		const entree = path.join(b, `audience-${cle}.json`), sortie = cache + ".tmp";
		fs.writeFileSync(entree, JSON.stringify(r));
		const ok = await new Promise<boolean>(fin => execFile(process.execPath, [path.join(site, "build.js"), entree, sortie, "--stockage=http", "--no-notes"], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, e => fin(!e)));
		fs.rmSync(entree, { force: true });
		if (!ok || !fs.existsSync(sortie)) { fs.rmSync(sortie, { force: true }); throw new ErreurApi(500, "unavailable", "page de testeur : échec du build"); }
		fs.renameSync(sortie, cache);
		return fs.readFileSync(cache, "utf8");
	});
}

const escAttr = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

// Enveloppe de la page servie : la même que celle de l'outil Artifact à la publication (doctype, viewport), plus la
// balise wdd-api qui dit à l'adaptateur http où est l'API du projet. tete : HTML déjà échappé posé en tête de <body>,
// avant la page (le bandeau commun du Wiki, bandeau.ts).
// build (étape 3.9, L11) : numéro du build servi, repris par l'en-tête d'impression de la page.
// lectureSeule (étape 3.9, L3) : ancienne version ; l'adaptateur http n'y propose pas d'écrire de retour.
// sansVersions (étape 3.9, E2) : page d'un testeur externe, qui n'a pas accès aux anciennes versions : pas de lien « Versions ».
export function envelopper(page: string, projet: string, tete = "", build?: number, lectureSeule = false, sansVersions = false): string {
	return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
		`<meta name="wdd-api" content="${escAttr("/api/p/" + projet)}">${build ? `<meta name="wdd-build" content="${Math.floor(build)}">` : ""}${lectureSeule ? `<meta name="wdd-lecture-seule" content="1">` : ""}${sansVersions ? `<meta name="wdd-sans-versions" content="1">` : ""}</head><body>${tete}${page}</body></html>`;
}
