// CLI « outil » : ce que les commandes partagent (étape 2, étendu à l'étape 3.5). Contexte d'exécution, erreurs et
// codes de sortie, configuration (.outil.json), fichiers utilisateur (jetons.json, appairages.json), HTTP, affichage,
// et pour l'étape 3.5 : installation locale (installation.json), dossier de travail, recherche d'un programme dans le
// PATH (avec PATHEXT sous Windows), arrêt d'un arbre de processus. Aucune dépendance ; jamais de shell.
// Les modules des commandes (outil.ts, appairage.ts, publier.ts) importent d'ici ; ce module n'importe aucun d'eux.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Règles des notes datées : le module de site/build.js (une seule copie des règles).
export type Serie = { fichier: string; n: unknown };
export const reglesNotes = createRequire(import.meta.url)(path.join(import.meta.dirname, "..", "site", "valider-notes.js")) as {
	nomNotesValide: (nom: string) => boolean;
	trierSeries: (s: Serie[]) => Serie[];
	validerNotes: (s: Serie[]) => { erreurs: string[]; avertissements: string[] };
};

// --- Constantes du contrat (site/retours/CONTRAT.md § 9, docs/etape1-serveur.md) --------------------------------
export const STATUTS = ["nouveau", "pris", "question", "fait", "refuse"];
export const ID_RETOUR = /^[A-Za-z0-9]{1,40}$/;
export const ID_PROJET = /^[a-z0-9-]{1,40}$/;
export const MAX_LOT = 50, MAX_TEXTE = 20000;
export const MAX_CORPS = 1024 * 1024;              // corps JSON du serveur (batch, notes) : 1 Mio
export const MAX_BUILD = 16 * 1024 * 1024;         // data.json : 16 Mio
export const MAX_IMPORT = 500, MAX_IMPORT_OCTETS = 15 * 1024 * 1024; // un appel d'import : 500 retours, sous les 16 Mio du serveur
export const FICHIER_CONFIG = ".outil.json";
export const DELAI_MS = 120000;
// Nom de l'outil (Vaevia, choisi le 27/11/2026) : dossier de
// l'installation locale écrite par l'installeur (installation.json).
export const NOM_INSTALLATION = "Vaevia";
// Dossier de l'outil (dépôt) : cli/.. ; METHODE.md y est trouvé à partir de l'emplacement de la CLI.
export const RACINE_OUTIL = path.resolve(import.meta.dirname, "..");
// Étape 3.9, A4 : version de l'outil (VERSION à la racine du dépôt), comparée à celle du serveur (en-tête X-WDD-Version).
export const VERSION_CLI = (() => { try { return fs.readFileSync(path.join(RACINE_OUTIL, "VERSION"), "utf8").trim().slice(0, 40) || "inconnue"; } catch { return "inconnue"; } })();
export let versionServeur = "";
let avertiVersion = false;

export const CODES = { ok: 0, erreur: 1, usage: 2, conflit: 3, droits: 4 } as const;

export class ErreurCli extends Error {
	sortie: number; details: Record<string, unknown>;
	constructor(sortie: number, message: string, details: Record<string, unknown> = {}) { super(message); this.sortie = sortie; this.details = details; }
}
export const usage = (m: string) => new ErreurCli(CODES.usage, m);
export const erreur = (m: string, details: Record<string, unknown> = {}) => new ErreurCli(CODES.erreur, m, details);
export const droits = (m: string, details: Record<string, unknown> = {}) => new ErreurCli(CODES.droits, m, details);

// --- Contexte d'exécution (injectable pour les tests) ------------------------------------------------------------
// terminal : un humain voit la sortie au fil de l'eau (stdin et stderr sont des terminaux). Absent : faux. Les
// commandes en deux temps (brancher, importer-artifact --autoriser) en dépendent ; les tests le passent à la main.
export type Env = Record<string, string | undefined>;
// question : une réponse en clair à une question O/N (outil installer, dans un terminal) ; absente : lireEntree.
// arret : signal d'arrêt (Ctrl+C) posé par le point d'entrée ; outil veille arrête alors l'agent et termine la demande.
export type Contexte = { env: Env; cwd: string; json: boolean; stdout: (s: string) => void; stderr: (s: string) => void; lireEntree: (invite: string) => Promise<string>; terminal?: boolean;
	question?: (invite: string) => Promise<string>; arret?: AbortSignal };

// --- Lignes de commande -------------------------------------------------------------------------------------------
export type Options = Record<string, string | true | string[]>;
export type Commande = {
	nom: string;                    // « retours liste »
	usage: string;
	resume: string;
	detail?: string;
	exemple: string;
	options: Record<string, "valeur" | "drapeau" | "liste">;   // « liste » : option répétable
	positionnels: [number, number]; // nombre min, max
	apresTiret?: boolean;           // ce qui suit « -- » va dans opt["--"] (une commande à lancer), pas dans les positionnels
	// Refusée (usage, 2) pendant un traitement lancé par la veille (OUTIL_DEMANDE défini) : ce qu'un agent sans humain ne
	// doit pas faire (appairage, import, commande de la veille), imposé par la CLI et pas seulement écrit dans la méthode.
	refuseeSousVeille?: (opt: Options, pos: string[]) => boolean;
	raisonSousVeille?: string;      // phrase propre à la commande, à la place de la raison générale du refus
	faire: (ctx: Contexte, pos: string[], opt: Options) => Promise<number>;
};

// --- Configuration ------------------------------------------------------------------------------------------------
export type Config = { serveur: string; projet: string; chemin: string };

export function normaliserServeur(brut: string): string {
	let u: URL;
	try { u = new URL(brut); } catch { throw usage(`serveur : URL invalide « ${brut} » (ex. https://retours.exemple.fr)`); }
	if (u.protocol !== "http:" && u.protocol !== "https:") throw usage("serveur : http:// ou https:// attendu");
	if (u.username || u.password || u.search || u.hash) throw usage("serveur : ni identifiant, ni ?requête, ni #fragment dans l'URL");
	return u.origin + u.pathname.replace(/\/+$/, "");
}
export const estBouclage = (serveur: string) => { const h = new URL(serveur).hostname; return h === "localhost" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h); };

// .outil.json : dossier courant, puis les parents.
export function chercherConfig(depart: string): string | null {
	let d = path.resolve(depart);
	for (; ;) {
		const p = path.join(d, FICHIER_CONFIG);
		if (fs.existsSync(p)) return p;
		const parent = path.dirname(d);
		if (parent === d) return null;
		d = parent;
	}
}
// Un jeton n'a rien à faire dans .outil.json (fichier commité) : refus, sans l'utiliser.
// Clés suspectes (« auth » seule ou « authorization », pas « auteur » ni « author ») ; valeurs : un texte qui commence
// par wdd_, ou qui contient un jeton n'importe où (« Bearer wdd_… »). Les clés de « publier » (exporteur, notes) ne
// sont pas suspectes.
export const CLE_SECRETE = /jeton|token|secret|bearer|password|mot.?de.?passe|^auth$|authori[sz]ation|api.?key|cle.?api/i;
export function contientJeton(v: unknown, cle = ""): boolean {
	if (cle && CLE_SECRETE.test(cle)) return true;
	if (typeof v === "string") return /^wdd_/.test(v.trim()) || /wdd_[A-Za-z0-9_-]{16,}/.test(v);
	if (Array.isArray(v)) return v.some(x => contientJeton(x));
	if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => contientJeton(x, k));
	return false;
}
// Contenu de .outil.json : serveur et projet s'ils sont des textes ; « publier » tel quel (validé par outil publier) ;
// « brut » : l'objet entier, pour compléter le fichier sans perdre de clé.
export type FichierConfig = { serveur?: string; projet?: string; publier?: unknown; brut: Record<string, unknown> };
export function lireFichierConfig(chemin: string): FichierConfig {
	let o: unknown;
	try { o = JSON.parse(fs.readFileSync(chemin, "utf8").replace(/^\uFEFF/, "")); } catch (e) { throw erreur(`${chemin} : JSON illisible (${(e as Error).message})`); }
	if (!o || typeof o !== "object" || Array.isArray(o)) throw erreur(`${chemin} : objet { "serveur", "projet" } attendu`);
	if (contientJeton(o)) throw erreur(`${chemin} contient un jeton : refusé. Ce fichier est commité avec le code ; retire le jeton (et révoque-le), puis utilise « outil connexion » ou OUTIL_JETON.`);
	const c = o as Record<string, unknown>;
	return { serveur: typeof c.serveur === "string" ? c.serveur : undefined, projet: typeof c.projet === "string" ? c.projet : undefined, publier: c.publier, brut: c };
}
export function chargerConfig(ctx: Contexte): Config {
	const chemin = chercherConfig(ctx.cwd);
	if (!chemin) throw erreur(`${FICHIER_CONFIG} introuvable (dossier courant et parents) : lancer « outil brancher --serveur <URL> » (ou « outil connexion --serveur <URL> --projet <projet> ») à la racine du dépôt du code`);
	const c = lireFichierConfig(chemin);
	if (!c.serveur) throw erreur(`${chemin} : « serveur » manquant`);
	if (!c.projet || !ID_PROJET.test(c.projet)) throw erreur(`${chemin} : « projet » manquant ou invalide ([a-z0-9-]{1,40})`);
	return { serveur: normaliserServeur(c.serveur), projet: c.projet, chemin };
}
// Message commun à connexion et brancher : un .outil.json existant ne se réécrit pas en silence.
export const MESSAGE_AUTRE_PROJET = (chemin: string, projet: unknown, serveur: unknown) =>
	`${chemin} désigne ${projet} sur ${serveur} : modifier ce fichier à la main pour changer de serveur ou de projet`;

// --- Fichiers du dépôt : liens symboliques et jonctions jamais suivis ---------------------------------------------------
// Un dépôt cloné peut apporter des liens (AGENTS.md -> ~/.bashrc, .claude -> ~/.claude ; une jonction sous Windows) :
// lire ou écrire par eux toucherait les fichiers de l'utilisateur hors du dépôt. Rend le premier composant, de la
// racine (exclue) à la cible (comprise), qui est un lien ou une jonction (chemin relatif à la racine), la cible
// elle-même si elle sort de la racine, ou null. Un composant absent arrête l'examen (rien d'autre n'existe plus loin).
export function lienSurLeChemin(racine: string, cible: string): string | null {
	const rel = path.relative(racine, cible);
	if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return cible;
	let p = racine;
	for (const morceau of rel.split(path.sep)) {
		p = path.join(p, morceau);
		let st: fs.Stats;
		try { st = fs.lstatSync(p); } catch { return null; }
		if (st.isSymbolicLink()) return path.relative(racine, p).split(path.sep).join("/");
	}
	return null;
}
export const MESSAGE_LIEN = (lien: string) => `${lien} est un lien symbolique ou une jonction : jamais suivi, rien n'y est lu ni écrit (le remplacer par un vrai fichier ou dossier du dépôt, puis relancer)`;

// --- Fichiers utilisateur (jamais dans le dépôt)-------------------------------------------------------------------
// Dossier : %APPDATA%/outil (Windows), sinon $XDG_CONFIG_HOME/outil ou ~/.config/outil. jetons.json, appairages.json
// (étape 3.5) et veille.json (étape 3.5, § 5.3) y vivent, avec les mêmes droits (dossier 0700, fichier 0600).
export function dossierUtilisateur(env: Env): string {
	if (process.platform === "win32") {
		if (!env.APPDATA) throw erreur("APPDATA non défini : impossible de situer le fichier de jetons (utiliser OUTIL_JETON)");
		return path.join(env.APPDATA, "outil");
	}
	const base = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, ".config") : path.join(os.homedir(), ".config"));
	return path.join(base, "outil");
}
export const fichierJetons = (env: Env): string => path.join(dossierUtilisateur(env), "jetons.json");
// Lecture d'un fichier utilisateur JSON (objet) ; absent : {}.
export function lireFichierUtilisateur(fichier: string): Record<string, any> {
	if (!fs.existsSync(fichier)) return {};
	try {
		const o = JSON.parse(fs.readFileSync(fichier, "utf8"));
		return o && typeof o === "object" && !Array.isArray(o) ? o : {};
	} catch (e) { throw erreur(`${fichier} : illisible (${(e as Error).message})`); }
}
// Écriture atomique (fichier temporaire puis renommage), droits restreints (sans effet sous Windows, où %APPDATA% est
// déjà propre au compte).
export function ecrireFichierUtilisateur(fichier: string, contenu: unknown): void {
	fs.mkdirSync(path.dirname(fichier), { recursive: true, mode: 0o700 });
	const tmp = fichier + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(contenu, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(tmp, fichier);
	try { fs.chmodSync(fichier, 0o600); fs.chmodSync(path.dirname(fichier), 0o700); } catch { }
}
export type Jetons = Record<string, Record<string, string>>;
export const lireJetons = (fichier: string): Jetons => lireFichierUtilisateur(fichier);
export function enregistrerJeton(fichier: string, serveur: string, projet: string, jeton: string): void {
	const tous = lireJetons(fichier);
	(tous[serveur] ??= {})[projet] = jeton;
	ecrireFichierUtilisateur(fichier, tous);
}
// Forme d'un jeton : une ligne de caractères ASCII visibles. Un caractère de contrôle (fichier de deux lignes, par
// exemple) ferait échouer l'en-tête HTTP, dont le message d'erreur recopie la valeur : refus avant, sans la citer.
export const FORME_JETON = /^[\x21-\x7e]{1,500}$/;
export function jetonPour(ctx: Contexte, cfg: Config): string {
	const env = (ctx.env.OUTIL_JETON || "").trim();
	if (env) {
		if (!FORME_JETON.test(env)) throw new ErreurCli(CODES.droits, "OUTIL_JETON n'a pas la forme d'un jeton (une seule ligne, sans espace ni caractère de contrôle ; valeur non affichée) : s'arrêter et demander à l'humain de le redéfinir");
		return env;
	}
	const fichier = fichierJetons(ctx.env);
	const j = lireJetons(fichier)[cfg.serveur]?.[cfg.projet];
	if (!j) throw new ErreurCli(CODES.droits, `aucun jeton pour ${cfg.projet} sur ${cfg.serveur} : lancer « outil brancher » (un clic « Autoriser » dans le navigateur), ou « outil connexion » (jeton lu sur l'entrée standard), ou définir OUTIL_JETON`);
	if (typeof j !== "string" || !FORME_JETON.test(j)) throw new ErreurCli(CODES.droits, `${fichier} : le jeton enregistré pour ${cfg.projet} sur ${cfg.serveur} n'a pas la bonne forme (valeur non affichée) : demander à l'humain de relancer « outil brancher » ou « outil connexion »`);
	return j;
}
// Tout ce qui ressemble à un jeton est masqué dans les messages d'erreur (argument en trop, URL, trace) : un jeton
// passé par erreur en argument ne doit pas ressortir sur stdout ou stderr, que l'agent lit et recopie.
export const masquerJetons = (s: string) => s.replace(/wdd_[A-Za-z0-9_-]{16,}/g, "wdd_…(masqué)");

// --- Installation locale (installeur Windows, docs/etape3-5-prise-en-main.md § 1.2) ------------------------------
// installation.json = { outil, donnees, port, url }, sans secret. Windows : %LOCALAPPDATA%\Vaevia ;
// ailleurs : $XDG_DATA_HOME/Vaevia, à défaut ~/.local/share/Vaevia.
export function dossierInstallation(env: Env): string | null {
	if (process.platform === "win32") return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, NOM_INSTALLATION) : null;
	const base = env.XDG_DATA_HOME || (env.HOME ? path.join(env.HOME, ".local", "share") : null);
	return base ? path.join(base, NOM_INSTALLATION) : null;
}
export const fichierInstallation = (env: Env): string | null => { const d = dossierInstallation(env); return d ? path.join(d, "installation.json") : null; };
// Serveur de l'installation locale (clé « url »), ou null : fichier absent, illisible ou sans URL valable.
export function serveurInstallation(env: Env): { serveur: string; fichier: string } | null {
	const fichier = fichierInstallation(env);
	if (!fichier || !fs.existsSync(fichier)) return null;
	try {
		const o = JSON.parse(fs.readFileSync(fichier, "utf8").replace(/^\uFEFF/, ""));
		if (!o || typeof o.url !== "string") return null;
		return { serveur: normaliserServeur(o.url), fichier };
	} catch { return null; }
}

// --- Dossier de travail (hors du dépôt, docs/etape3-5-prise-en-main.md § 4) ----------------------------------------
// Windows : %LOCALAPPDATA%\outil\travail\<projet> ; ailleurs : $XDG_CACHE_HOME/outil/travail/<projet>, à défaut
// ~/.cache/outil/travail/<projet>. Créé au besoin.
export function dossierTravail(env: Env, projet: string): string {
	if (!ID_PROJET.test(projet)) throw erreur(`projet invalide : ${coupe(projet, 50)}`);
	let base: string;
	if (process.platform === "win32") {
		if (!env.LOCALAPPDATA) throw erreur("LOCALAPPDATA non défini : impossible de situer le dossier de travail");
		base = env.LOCALAPPDATA;
	} else base = env.XDG_CACHE_HOME || (env.HOME ? path.join(env.HOME, ".cache") : path.join(os.homedir(), ".cache"));
	const d = path.join(base, "outil", "travail", projet);
	fs.mkdirSync(d, { recursive: true });
	return d;
}

// --- Programmes (exporteur, agent de la veille, git, navigateur, taskkill) -----------------------------------------
// Sous Windows, un nom de programme sans chemin est d'abord cherché dans le DOSSIER COURANT, par libuv (spawn,
// execFile) comme par cmd.exe, sauf si NoDefaultCurrentDirectoryInExePath est défini : un explorer.exe, taskkill.exe,
// git.exe ou node.bat posé dans le dépôt serait lancé (un commit suffirait). D'où trois règles : les programmes du
// système sont lancés par leur chemin absolu sous SystemRoot validé (programmeSysteme, jamais de repli sur un nom
// seul) ; les autres sont résolus dans le PATH par chercherProgramme, qui ne regarde jamais le dossier courant ; et la
// variable est posée pour ce processus (point d'entrée) et pour chaque enfant (envEnfant), dont cmd.exe, PowerShell et
// les lanceurs .cmd qu'un agent lance à son tour.
export const SANS_DOSSIER_COURANT = "NoDefaultCurrentDirectoryInExePath";
// Valeur d'une variable d'environnement ; sous Windows, sans tenir compte de la casse (une copie de process.env, ou
// l'environnement d'un test, garde la casse d'origine).
export function valeurEnv(env: Env, nom: string, plateforme = process.platform): string | undefined {
	if (env[nom] !== undefined || plateforme !== "win32") return env[nom];
	const k = Object.keys(env).find(x => x.toUpperCase() === nom.toUpperCase());
	return k === undefined ? undefined : env[k];
}
// Environnement d'un programme lancé : celui reçu, sans les variables de « retirer » ni les anciennes valeurs de
// « poser » (sous Windows, quelle que soit leur casse : « Outil_Jeton » est OUTIL_JETON pour l'enfant), plus « poser »
// et, sous Windows, NoDefaultCurrentDirectoryInExePath=1.
export function envEnfant(env: Env, o: { retirer?: string[]; poser?: Record<string, string> } = {}, plateforme = process.platform): Record<string, string> {
	const win = plateforme === "win32";
	const poser: Record<string, string> = { ...(o.poser || {}), ...(win ? { [SANS_DOSSIER_COURANT]: "1" } : {}) };
	const cle = (k: string) => win ? k.toUpperCase() : k;
	const exclues = new Set([...(o.retirer || []), ...Object.keys(poser)].map(cle));
	const r: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && !exclues.has(cle(k))) r[k] = v;
	return { ...r, ...poser };
}
// Programme du système Windows (explorer.exe, System32\taskkill.exe, System32\cmd.exe) : chemin absolu sous
// SystemRoot, s'il est absolu, contient System32 et que le programme y est. Sinon null : l'appelant ne lance rien
// (jamais le nom seul, qui serait cherché dans le dossier courant).
export function programmeSysteme(env: Env, ...parties: string[]): string | null {
	const racine = valeurEnv(env, "SystemRoot", "win32") || valeurEnv(env, "windir", "win32");
	if (!racine || !path.isAbsolute(racine)) return null;
	try {
		if (!fs.statSync(path.join(racine, "System32")).isDirectory()) return null;
		const p = path.join(path.resolve(racine), ...parties);
		return fs.statSync(p).isFile() ? p : null;
	} catch { return null; }
}
// git, résolu dans le PATH (jamais dans le dossier courant, qui est le dépôt).
export function programmeGit(env: Env): string {
	const p = chercherProgramme("git", env, RACINE_OUTIL);
	if (!p) throw erreur("git introuvable dans le PATH : installer Git ou le mettre dans le PATH");
	return p;
}
// Chemin du programme tel que le système le lancerait : un nom avec séparateur est pris relativement à « depuis » ;
// sinon cherché dans le PATH, dont les dossiers relatifs sont ignorés (ils désigneraient le dossier courant). Sous
// Windows, avec les extensions de PATHEXT (« npm » → npm.cmd, « node » → node.exe) ; un nom qui a déjà une extension
// est d'abord pris tel quel. Rend null si rien n'est trouvé.
export function chercherProgramme(nom: string, env: Env, depuis: string): string | null {
	const win = process.platform === "win32";
	const exts = win ? ["", ...String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
	const essayer = (base: string): string | null => {
		for (const e of exts) {
			if (win && e === "" && !path.extname(base)) continue; // sous Windows, un fichier sans extension ne se lance pas
			const p = base + e;
			try { if (fs.statSync(p).isFile()) return p; } catch { }
		}
		return null;
	};
	if (nom.includes("/") || (win && nom.includes("\\")) || path.isAbsolute(nom)) return essayer(path.resolve(depuis, nom));
	const chemins = String(valeurEnv(env, "PATH") ?? "").split(path.delimiter).map(d => d.replace(/^"|"$/g, "")).filter(d => d && path.isAbsolute(d));
	for (const d of chemins) { const p = essayer(path.join(d, nom)); if (p) return p; }
	return null;
}
export const estScriptWindows = (p: string) => /\.(cmd|bat)$/i.test(p);
// Arrêt d'un processus et de ses descendants : taskkill /T /F sous Windows (par son chemin absolu ; introuvable :
// le processus seul) ; ailleurs, le groupe du processus (lancé avec detached: true), sinon le processus seul.
export function arreterArbre(enfant: ChildProcess, env: Env = process.env): void {
	if (!enfant.pid || enfant.exitCode !== null) return;
	if (process.platform === "win32") {
		const taskkill = programmeSysteme(env, "System32", "taskkill.exe");
		if (taskkill) execFile(taskkill, ["/PID", String(enfant.pid), "/T", "/F"], { windowsHide: true, env: envEnfant(env) }, () => { });
		else try { enfant.kill("SIGKILL"); } catch { }
		return;
	}
	try { process.kill(-enfant.pid, "SIGKILL"); } catch { try { enfant.kill("SIGKILL"); } catch { } }
}
export const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// --- HTTP ----------------------------------------------------------------------------------------------------------
export type Reponse = { status: number; corps: any };
let avertiHttp = false;
export function avertirHttp(ctx: Contexte, serveur: string): void {
	if (!avertiHttp && serveur.startsWith("http:") && !estBouclage(serveur)) {
		avertiHttp = true;
		ctx.stderr(`attention : ${serveur} est en http:// : le jeton circule en clair (préférer https://)`);
	}
}
// Requête au serveur, chemin depuis la racine (« /api/… »). Rend le statut et le corps JSON (null s'il n'en a pas),
// sans lever pour un statut d'erreur : à l'appelant de décider (202, 410, 429 de l'appairage ; 204 de DELETE /jeton).
export type ReponseServeur = { status: number; corps: any; texte: string; type: string };
export async function appelServeur(ctx: Contexte, serveur: string, methode: string, chemin: string, o: { jeton?: string; corps?: string | Buffer } = {}): Promise<ReponseServeur> {
	avertirHttp(ctx, serveur);
	const entetes: Record<string, string> = { Accept: "application/json" };
	if (o.jeton) entetes.Authorization = "Bearer " + o.jeton;
	if (o.corps !== undefined) entetes["Content-Type"] = "application/json";
	let r: Response;
	try { r = await fetch(serveur + chemin, { method: methode, headers: entetes, body: o.corps, redirect: "error", signal: AbortSignal.timeout(DELAI_MS) }); }
	catch (e) { throw erreur(`serveur injoignable (${serveur}) : ${(e as Error)?.cause ? String(((e as Error).cause as Error).message || (e as Error).cause) : (e as Error).message}`); }
	const vs = r.headers.get("x-wdd-version");
	if (vs) {
		versionServeur = vs.slice(0, 40);
		if (!avertiVersion && VERSION_CLI !== "inconnue" && versionServeur !== VERSION_CLI) {
			avertiVersion = true;
			ctx.stderr(`attention : la CLI (version ${VERSION_CLI}) et le serveur (version ${versionServeur}) n'ont pas la même version : mettre à jour le dépôt de l'outil sur ce poste, ou le serveur (installeur : il sauvegarde avant de redémarrer)`);
		}
	}
	const texte = await r.text();
	let corps: any = null;
	try { corps = texte ? JSON.parse(texte) : null; } catch { corps = null; }
	return { status: r.status, corps, texte, type: r.headers.get("content-type") || "" };
}
// Requête d'un jeton sur son projet (/api/p/<projet><chemin>) : rend l'objet JSON, ou lève une ErreurCli.
export async function requete(ctx: Contexte, cfg: Config, jeton: string, methode: string, chemin: string, corps?: string | Buffer): Promise<any> {
	const r = await appelServeur(ctx, cfg.serveur, methode, `/api/p/${encodeURIComponent(cfg.projet)}${chemin}`, { jeton, corps });
	const ok = r.status >= 200 && r.status < 300;
	// Une réponse 2xx qui n'est pas un objet JSON (proxy, page de connexion, mauvaise URL) : message utile, pas une trace.
	if (ok && (!r.corps || typeof r.corps !== "object")) throw erreur(`réponse inattendue du serveur (${r.status}, pas du JSON${r.type ? " : " + coupe(r.type, 60) : ""}) : vérifier « serveur » dans ${cfg.chemin}`, { statut: r.status, code: "reponse_inattendue" });
	if (ok) return r.corps;
	throw erreurHttp({ status: r.status, corps: r.corps ?? { message: r.texte.slice(0, 300) } });
}
export function erreurHttp(r: Reponse): ErreurCli {
	const c = r.corps && typeof r.corps === "object" ? r.corps : {};
	const sortie = r.status === 409 ? CODES.conflit : r.status === 401 || r.status === 403 ? CODES.droits : CODES.erreur;
	const details: Record<string, unknown> = { statut: r.status, code: c.code || "inconnu" };
	for (const k of ["document", "index", "id", "erreurs"]) if (c[k] !== undefined) details[k] = c[k];
	const explication = r.status === 401 ? " (jeton invalide ou révoqué : « outil brancher » ou « outil connexion » avec un nouveau jeton)" : "";
	return new ErreurCli(sortie, `${r.status} ${c.code || ""} : ${c.message || "erreur du serveur"}${explication}`.replace(/ {2,}/g, " "), details);
}

// --- Aides d'affichage et de lecture -------------------------------------------------------------------------------
export const maintenant = () => new Date().toISOString();
// Date lisible, à l'heure locale du système (« 23/11/2026 17:38 ») ; l'ISO (UTC) reste dans --json.
export const dateLocale = (iso: unknown) => { const d = new Date(String(iso)); return isNaN(d.getTime()) ? String(iso) : d.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }); };
// Révision du dépôt de design du serveur : à ne pas confondre avec un commit du projet (cité dans les réponses).
export const revision = (rev: unknown) => `enregistré sur le serveur (révision ${String(rev).slice(0, 10)})`;
export const coupe = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export function emettre(ctx: Contexte, donnees: unknown, texte: string | string[]): void {
	if (ctx.json) ctx.stdout(JSON.stringify(donnees, null, 2));
	else ctx.stdout(Array.isArray(texte) ? texte.join("\n") : texte);
}
export function lireJsonFichier(fichier: string, quoi: string): { brut: Buffer; valeur: unknown } {
	if (!fs.existsSync(fichier) || !fs.statSync(fichier).isFile()) throw erreur(`${quoi} introuvable : ${fichier}`);
	const brut = fs.readFileSync(fichier);
	let texte: string;
	try { texte = new TextDecoder("utf-8", { fatal: true }).decode(brut).replace(/^\uFEFF/, ""); } catch { throw erreur(`${fichier} : UTF-8 attendu`); }
	try { return { brut: Buffer.from(texte, "utf8"), valeur: JSON.parse(texte) }; } catch (e) { throw erreur(`${fichier} : JSON invalide (${(e as Error).message})`); }
}
// Délai en secondes d'une option (--delai) : entier de 1 à max.
export function secondesOption(v: unknown, nom: string, max: number): number {
	if (!/^\d{1,6}$/.test(String(v)) || Number(v) < 1 || Number(v) > max) throw usage(`--${nom} : nombre de secondes, de 1 à ${max}`);
	return Number(v);
}
