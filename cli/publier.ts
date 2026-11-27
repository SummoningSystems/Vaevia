// CLI « outil » : publier en une commande (étape 3.5, docs/etape3-5-prise-en-main.md § 4), et l'envoi d'un build et
// d'une note qu'elle partage avec « outil export envoyer » et « outil notes envoyer » (étape 2).
//   outil publier [--si-change] [--sans-notes] [--json]
// Étape 3.7 (G2), publication par une CI : jeton « publieur » dans OUTIL_JETON ; --sans-notes (un publieur n'écrit pas
// de notes), --si-change (rien n'est envoyé si data.json est identique à celui du dernier build : sortie 0, « inchangé »).
// Lit « publier » dans .outil.json : { "exporteur": ["node", "tools/site-retours/export.mjs", "--out={data}"],
// "notes": "tools/site-retours" }. Étapes : notes (absentes envoyées, identiques sautées, différentes en
// avertissement, jamais remplacées) ; exporteur (sans shell, dans le dossier de .outil.json, {data} = data.json du
// dossier de travail, 10 min au plus) ; envoi de data.json ; adresse du Wiki.
// Confiance : .outil.json est commité, donc publier lance une commande écrite dans le dépôt (comme « npm run ») : ne
// pas publier depuis un dépôt dont on n'a pas relu .outil.json.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
	CODES, ErreurCli, erreur, MAX_CORPS, MAX_BUILD, reglesNotes, chargerConfig, lireFichierConfig, jetonPour, requete, emettre, lireJsonFichier, coupe,
	dossierTravail, chercherProgramme, estScriptWindows, arreterArbre, masquerJetons, envEnfant,
} from "./commun.ts";
import type { Contexte, Commande, Config } from "./commun.ts";
import { NOM_EXECUTABLE, resoudreExecutable } from "./executable.ts";

// Empreinte des données sans la date d'export : même module que le serveur (site/changements.js).
const reglesChangements = createRequire(import.meta.url)(path.join(import.meta.dirname, "..", "site", "changements.js")) as { empreinteDonnees: (d: unknown) => string };

export const DELAI_EXPORTEUR_MS = 10 * 60 * 1000;
const MAX_ARGS = 30, MAX_ARG = 500, FIN_SORTIE = 4000;

// --- Envoi d'un build (POST /builds) ---------------------------------------------------------------------------------
export type ResultatBuild = { build: number; octets: number; page: string; resume: string; avertissements: string[] };
// Les avertissements du build (data.generated absent, sorte sans libellé, page lourde…) passent sur stderr : à relire,
// comme la sortie de build.js avant une publication.
export async function envoyerBuild(ctx: Contexte, cfg: Config, jeton: string, brut: Buffer, fichier: string): Promise<ResultatBuild> {
	if (brut.length > MAX_BUILD) throw erreur(`${fichier} : ${brut.length} octets, 16 Mio au plus (réduire les images)`);
	const r = await requete(ctx, cfg, jeton, "POST", "/builds", brut);
	const avertissements: string[] = Array.isArray(r.avertissements) ? r.avertissements.map(String) : [];
	for (const a of avertissements) ctx.stderr("attention (build) : " + a);
	return { build: r.build, octets: r.octets, page: `${cfg.serveur}/p/${cfg.projet}/`, resume: typeof r.resume === "string" ? r.resume : "", avertissements };
}
export const lignesBuild = (r: ResultatBuild) => [`build n° ${r.build} : Wiki de ${r.octets} octets → ${r.page}`, ...(r.resume ? [`  ${r.resume}`] : [])];

// --- Notes datées ------------------------------------------------------------------------------------------------------
export type NoteLocale = { nom: string; fichier: string; brut: Buffer; valeur: Record<string, unknown> };
// Un fichier de notes local : nom (notes_AAAA-MM-JJ[_suffixe].json), UTF-8, objet JSON, 1 Mio au plus.
export function lireNoteLocale(fichier: string): NoteLocale {
	const nom = path.basename(fichier);
	if (!reglesNotes.nomNotesValide(nom)) throw new ErreurCli(CODES.usage, `nom de fichier : notes_AAAA-MM-JJ.json ou notes_AAAA-MM-JJ_<suffixe>.json (date réelle ; suffixe a-z, 0-9, -), reçu « ${nom} »`);
	const { brut, valeur } = lireJsonFichier(fichier, "fichier de notes");
	if (!valeur || typeof valeur !== "object" || Array.isArray(valeur)) throw erreur(`${nom} : objet attendu`);
	if (brut.length > MAX_CORPS) throw erreur(`${nom} : ${brut.length} octets, 1 Mio au plus`);
	return { nom, fichier, brut, valeur: valeur as Record<string, unknown> };
}
// Validation locale (règles de site/build.js) d'une ou plusieurs séries ; les avertissements passent sur stderr.
export function validerNotesLocales(ctx: Contexte, notes: NoteLocale[], ou: string): void {
	const { erreurs, avertissements } = reglesNotes.validerNotes(reglesNotes.trierSeries(notes.map(n => ({ fichier: n.nom, n: structuredClone(n.valeur) }))));
	if (erreurs.length) throw erreur(`notes refusées avant envoi${ou} (règles de site/build.js) :\n  ${erreurs.join("\n  ")}`, { erreurs });
	for (const a of avertissements) ctx.stderr("attention : " + a);
}
// PUT /notes/<nom> ; un fichier déjà présent n'est remplacé qu'avec remplacer (décision d'un humain).
export async function envoyerNote(ctx: Contexte, cfg: Config, jeton: string, n: NoteLocale, remplacer: boolean): Promise<any> {
	try { return await requete(ctx, cfg, jeton, "PUT", `/notes/${encodeURIComponent(n.nom)}${remplacer ? "?remplacer=1" : ""}`, n.brut); }
	catch (e) {
		if (e instanceof ErreurCli && e.sortie === CODES.conflit) e.message = `${n.nom} existe déjà sur le serveur (rien n'a été écrit) : une note envoyée ne se remplace pas ; ` +
			`prendre un autre nom (ex. ${n.nom.replace(/^(notes_\d{4}-\d{2}-\d{2})(_[a-z0-9-]+)?\.json$/, "$1_2.json")}). --remplacer : seulement sur décision explicite d'un humain.`;
		throw e;
	}
}
export type BilanNotes = { dossier: string; envoyees: string[]; identiques: string[]; differentes: string[] };
// Notes du dossier : absentes du serveur envoyées ; identiques (même JSON) sautées ; différentes : avertissement, sans
// remplacement. Toutes sont validées ensemble avant le premier envoi.
export async function synchroniserNotes(ctx: Contexte, cfg: Config, jeton: string, dossier: string): Promise<BilanNotes> {
	if (!fs.existsSync(dossier) || !fs.statSync(dossier).isDirectory()) throw erreur(`publier.notes : dossier introuvable : ${dossier} (corriger « publier.notes » dans ${cfg.chemin})`);
	const locales: NoteLocale[] = [];
	for (const f of fs.readdirSync(dossier).filter(f => /^notes_.*\.json$/i.test(f)).sort()) {
		if (!reglesNotes.nomNotesValide(f)) { ctx.stderr(`attention : ${f} ignoré (nom attendu : notes_AAAA-MM-JJ.json ou notes_AAAA-MM-JJ_<suffixe>.json)`); continue; }
		locales.push(lireNoteLocale(path.join(dossier, f)));
	}
	const bilan: BilanNotes = { dossier, envoyees: [], identiques: [], differentes: [] };
	if (!locales.length) return bilan;
	validerNotesLocales(ctx, locales, ` (${dossier})`);
	const presentes = new Set(((await requete(ctx, cfg, jeton, "GET", "/notes")).notes as any[]).map(n => String(n.nom)));
	for (const n of locales) {
		if (!presentes.has(n.nom)) { await envoyerNote(ctx, cfg, jeton, n, false); bilan.envoyees.push(n.nom); continue; }
		const distante = await requete(ctx, cfg, jeton, "GET", `/notes/${encodeURIComponent(n.nom)}`);
		if (isDeepStrictEqual(distante, n.valeur)) { bilan.identiques.push(n.nom); continue; }
		bilan.differentes.push(n.nom);
		ctx.stderr(`attention : ${n.nom} diffère de la version du serveur : non remplacée. Pour la remplacer : outil notes envoyer ${n.fichier} --remplacer, sur décision d'un humain`);
	}
	return bilan;
}

// --- Configuration « publier » de .outil.json ----------------------------------------------------------------------------
export type ConfigPublier = { exporteur: string[] | null; notes: string | null };
const CONTROLE = /[\u0000-\u001f\u007f]/;
export function lireConfigPublier(ctx: Contexte, chemin: string, v: unknown): ConfigPublier {
	if (v === undefined || v === null) return { exporteur: null, notes: null };
	if (typeof v !== "object" || Array.isArray(v)) throw erreur(`${chemin} : « publier » doit être un objet { "exporteur": [...], "notes": "..." }`);
	const p = v as Record<string, unknown>;
	for (const k of Object.keys(p)) if (k !== "exporteur" && k !== "notes") ctx.stderr(`attention : ${chemin} : clé inconnue « publier.${coupe(k, 40)} » ignorée (connues : exporteur, notes)`);
	let exporteur: string[] | null = null, notes: string | null = null;
	if (p.exporteur !== undefined) {
		const e = p.exporteur;
		if (!Array.isArray(e) || e.length < 1 || e.length > MAX_ARGS || e.some(x => typeof x !== "string" || x.length > MAX_ARG || CONTROLE.test(x)) || !String(e[0]).trim())
			throw erreur(`${chemin} : « publier.exporteur » : liste de 1 à ${MAX_ARGS} textes de ${MAX_ARG} caractères au plus, sans retour à la ligne, le premier étant le programme (ex. ["node", "tools/site-retours/export.mjs", "--out={data}"])`);
		exporteur = e as string[];
	}
	if (p.notes !== undefined) {
		if (typeof p.notes !== "string" || !p.notes.trim() || p.notes.length > MAX_ARG || CONTROLE.test(p.notes) || path.isAbsolute(p.notes))
			throw erreur(`${chemin} : « publier.notes » : un dossier relatif à ${path.basename(chemin)} (ex. "tools/site-retours")`);
		notes = p.notes;
	}
	return { exporteur, notes };
}
const MARCHE_A_SUIVRE = (chemin: string) => `pas d'exporteur : « publier.exporteur » manque dans ${chemin}. Marche à suivre : écrire l'exporteur du projet (METHODE.md § 4, lisible par « outil methode »), ` +
	`qui écrit data.json au chemin reçu à la place de {data}, puis ajouter à ${path.basename(chemin)} : "publier": { "exporteur": ["node", "tools/site-retours/export.mjs", "--out={data}"], "notes": "tools/site-retours" } ` +
	"(chemins de ton projet), et relancer « outil publier ». En attendant : outil notes envoyer <notes_….json>, puis outil export envoyer <data.json>.";

// --- Exporteur ---------------------------------------------------------------------------------------------------------
// Programme de l'exporteur, tel qu'il sera lancé. Sous Windows, un .cmd ou un .bat ne se lance que par un shell, que
// publier n'utilise jamais : refusé avant tout envoi (y compris « npm », qui se résout en npm.cmd).
// Étape 3.10 : un nom nu (« godot ») enregistré sur ce poste par « outil executable » passe avant le PATH ; .outil.json
// reste le même sur tous les postes.
export function programmeExporteur(ctx: Contexte, exporteur: string[], dossier: string, cfg?: Pick<Config, "serveur" | "projet">): string {
	const nom = exporteur[0];
	const refus = (p: string) => erreur(`exporteur refusé : « ${coupe(p, 200)} » est un script .cmd ou .bat, qui ne se lance que par un shell (jamais utilisé par outil publier). ` +
		"Lancer node, ou un .exe : par ex. [\"node\", \"tools/site-retours/export.mjs\", \"--out={data}\"].", { code: "exporteur_refuse" });
	if (process.platform === "win32" && estScriptWindows(nom)) throw refus(nom);
	const enregistre = cfg && NOM_EXECUTABLE.test(nom) ? resoudreExecutable(ctx, cfg, nom, dossier) : null;
	const resolu = enregistre ? enregistre.chemin : chercherProgramme(nom, ctx.env, dossier);
	if (process.platform === "win32" && resolu && estScriptWindows(resolu)) throw refus(resolu);
	return resolu ?? nom;
}
// Lance l'exporteur (spawn sans shell, entrée fermée, environnement sans OUTIL_JETON) ; sa sortie (stdout et stderr)
// passe ligne à ligne sur notre stderr (stdout reste au JSON de --json). Code non nul, délai, programme introuvable :
// ErreurCli (1) avec la fin de sa sortie.
export function lancerExporteur(ctx: Contexte, programme: string, args: string[], dossier: string, delaiMs = DELAI_EXPORTEUR_MS): Promise<void> {
	return new Promise((ok, ko) => {
		// Sans OUTIL_JETON, quelle que soit la casse de son nom sous Windows (« Outil_Jeton » : envEnfant).
		const env = envEnfant(ctx.env, { retirer: ["OUTIL_JETON"] });
		let fin = "", delaiDepasse = false;
		const tampons = { out: "", err: "" };
		const recevoir = (k: "out" | "err") => (morceau: string) => {
			fin = (fin + morceau).slice(-FIN_SORTIE);
			tampons[k] += morceau;
			const lignes = tampons[k].split(/\r?\n/);
			tampons[k] = lignes.pop() ?? "";
			for (const l of lignes) ctx.stderr("exporteur : " + masquerJetons(l));
		};
		let p: ReturnType<typeof spawn>;
		try { p = spawn(programme, args, { cwd: dossier, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }); }
		catch (e) { return ko(erreur(`exporteur non lancé (${coupe(programme, 200)}) : ${(e as Error).message}`)); }
		const minuterie = setTimeout(() => { delaiDepasse = true; arreterArbre(p, ctx.env); }, delaiMs);
		p.stdout!.setEncoding("utf8"); p.stderr!.setEncoding("utf8");
		p.stdout!.on("data", recevoir("out")); p.stderr!.on("data", recevoir("err"));
		p.on("error", e => {
			clearTimeout(minuterie);
			const code = (e as NodeJS.ErrnoException).code;
			ko(erreur(code === "ENOENT" || code === "EINVAL"
				? `exporteur introuvable : « ${coupe(programme, 200)} » (ni relatif au dossier de .outil.json, ni enregistré par « outil executable », ni dans le PATH${process.platform === "win32" ? " ; un .cmd ou .bat est refusé : lancer node ou un .exe" : ""}). ` +
					`Un logiciel installé ailleurs (moteur, application) : demander son chemin à l'humain, puis « outil executable ${/^[a-z0-9][a-z0-9._-]{0,39}$/.test(programme) ? programme : "<nom>"} <chemin> » (METHODE § 4, « Logiciel à lancer »)`
				: `exporteur non lancé (${coupe(programme, 200)}) : ${e.message}`, { code: "exporteur_introuvable" }));
		});
		p.on("close", (code, signal) => {
			clearTimeout(minuterie);
			for (const k of ["out", "err"] as const) if (tampons[k]) ctx.stderr("exporteur : " + masquerJetons(tampons[k]));
			const sortie = fin.trim() ? `\nfin de sa sortie :\n${fin.trim().split(/\r?\n/).slice(-30).join("\n")}` : " (aucune sortie)";
			if (delaiDepasse) return ko(erreur(`exporteur arrêté au bout de ${Math.round(delaiMs / 60000)} min (délai dépassé) : rien n'a été envoyé.${sortie}`, { code: "exporteur_delai" }));
			if (code !== 0) return ko(erreur(`l'exporteur a échoué (code ${code ?? signal}) : rien n'a été envoyé ; le corriger, puis relancer outil publier.${sortie}`, { code: "exporteur_echec", sortieExporteur: code }));
			ok();
		});
	});
}

// --- outil publier -----------------------------------------------------------------------------------------------------
export type ResultatPublier = ResultatBuild & { serveur: string; projet: string; notes: BilanNotes | null; exporteur: { commande: string[]; dossier: string; data: string }; inchange?: boolean };
export type OptionsPublier = { siChange?: boolean; sansNotes?: boolean };
// Le cœur de « outil publier », réutilisable (outil installer, § 3 étape 8 ; la veille via l'agent).
export async function publier(ctx: Contexte, o: OptionsPublier = {}): Promise<ResultatPublier> {
	const cfg = chargerConfig(ctx);
	const conf = lireConfigPublier(ctx, cfg.chemin, lireFichierConfig(cfg.chemin).publier);
	if (!conf.exporteur) throw erreur(MARCHE_A_SUIVRE(cfg.chemin), { code: "sans_exporteur" });
	const dossier = path.dirname(cfg.chemin);
	const jeton = jetonPour(ctx, cfg);
	const data = path.join(dossierTravail(ctx.env, cfg.projet), "data.json");
	const commande = conf.exporteur.map(a => a.replaceAll("{data}", data));
	// Programme vérifié avant le moindre envoi (un .cmd refusé ne laisse pas des notes envoyées derrière lui).
	const programme = programmeExporteur(ctx, commande, dossier, cfg);
	// 1. Notes.
	const notes = conf.notes && !o.sansNotes ? await synchroniserNotes(ctx, cfg, jeton, path.resolve(dossier, conf.notes)) : null;
	// 2. Exporteur. L'ancien data.json est retiré d'abord : un exporteur qui n'écrit rien ne republie pas la fois d'avant.
	fs.rmSync(data, { force: true });
	ctx.stderr(`exporteur : ${commande.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(" ")} (dans ${dossier})`);
	await lancerExporteur(ctx, programme, commande.slice(1), dossier);
	if (!fs.existsSync(data)) throw erreur(`l'exporteur s'est terminé sans écrire ${data}${conf.exporteur.some(a => a.includes("{data}")) ? "" : " (aucun argument ne contient {data} : c'est par lui que l'exporteur reçoit le chemin de data.json)"} : rien n'a été envoyé`, { code: "data_absent" });
	const { brut } = lireJsonFichier(data, "data.json");
	// 3. Envoi, sauf --si-change et données identiques à celles du dernier build.
	if (o.siChange) {
		const dernier = (await requete(ctx, cfg, jeton, "GET", "/builds")).dernier;
		const sha = reglesChangements.empreinteDonnees(JSON.parse(brut.toString("utf8")));
		if (dernier && dernier.empreinte && dernier.empreinte === sha) return { serveur: cfg.serveur, projet: cfg.projet, notes, exporteur: { commande, dossier, data }, build: dernier.build, octets: dernier.octets, page: `${cfg.serveur}/p/${cfg.projet}/`, resume: "", avertissements: [], inchange: true };
	}
	const b = await envoyerBuild(ctx, cfg, jeton, brut, data);
	return { serveur: cfg.serveur, projet: cfg.projet, notes, exporteur: { commande, dossier, data }, ...b };
}

export const COMMANDES_PUBLIER: Commande[] = [
	{
		nom: "publier", usage: "outil publier [--si-change] [--sans-notes] [--json]",
		resume: "publie le Wiki en une commande : notes du dossier « publier.notes », exporteur « publier.exporteur » de .outil.json, envoi de data.json, adresse du Wiki",
		detail: "Configuration dans .outil.json : \"publier\": { \"exporteur\": [\"node\", \"tools/site-retours/export.mjs\", \"--out={data}\"], \"notes\": \"tools/site-retours\" }. " +
			"Notes (notes_*.json du dossier) : absentes du serveur envoyées, identiques sautées, différentes signalées sans remplacement (outil notes envoyer <f> --remplacer, sur décision d'un humain). " +
			"Exporteur : lancé sans shell dans le dossier de .outil.json, {data} = chemin absolu de data.json dans le dossier de travail (hors du dépôt), 10 min au plus ; sa sortie passe sur stderr ; " +
			"sous Windows, un .cmd ou .bat est refusé (lancer node ou un .exe). Code non nul, ou data.json absent ou illisible : sortie 1, rien n'est envoyé. Puis envoi comme « outil export envoyer ». " +
			"Sans publier.exporteur : sortie 1 et la marche à suivre. Confiance : publier lance une commande écrite dans le dépôt (comme npm run) ; ne pas publier depuis un dépôt dont on n'a pas relu .outil.json. " +
			"CI (jeton « publieur » dans OUTIL_JETON) : --sans-notes (pas d'envoi de notes) et --si-change (rien d'envoyé si data.json est identique au dernier build ; « inchangé », sortie 0). Exemples : docs/ci/.",
		exemple: "outil publier --json\n  outil publier --si-change --sans-notes --json   (dans une CI)",
		options: { "si-change": "drapeau", "sans-notes": "drapeau" }, positionnels: [0, 0],
		faire: async (ctx, _pos, opt) => {
			const r = await publier(ctx, { siChange: !!opt["si-change"], sansNotes: !!opt["sans-notes"] });
			const n = r.notes;
			if (r.inchange) { emettre(ctx, r, [`inchangé : data.json identique au build n° ${r.build}, rien d'envoyé`, `Wiki : ${r.page}`]); return CODES.ok; }
			emettre(ctx, r, [
				...(n ? [`notes (${n.dossier}) : ${n.envoyees.length} envoyée(s)${n.envoyees.length ? ` (${n.envoyees.join(", ")})` : ""}, ${n.identiques.length} déjà sur le serveur, ` +
					`${n.differentes.length} différente(s) non remplacée(s)${n.differentes.length ? ` (${n.differentes.join(", ")})` : ""}`] : [opt["sans-notes"] ? "notes : --sans-notes, aucune note envoyée" : "notes : pas de « publier.notes », aucune note envoyée"]),
				`exporteur : data.json écrit (${r.exporteur.data})`,
				...lignesBuild(r),
				`Wiki : ${r.page}`,
			]);
			return CODES.ok;
		},
	},
];
