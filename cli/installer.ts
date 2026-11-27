// CLI « outil » : brancher un dépôt de code en une commande (étape 3.5, docs/etape3-5-prise-en-main.md § 3).
//   outil installer [--serveur URL] [--projet P] [--agent claude] [--oui] [--sans-publier] [--attendre]
//                   [--sans-navigateur] [--poste NOM] [--delai S] [--json]
// Depuis le dépôt du code. Étapes : dépôt (racine Git, refus du dépôt de l'outil) ; connexion (jeton déjà enregistré
// qui répond à /session, sinon « outil brancher », en deux temps sans terminal) ; type de projet (constat) ; AGENTS.md
// (bloc <!-- outil:debut --> … <!-- outil:fin --> du gabarit methode/AGENTS.md) ; Claude Code (raccourci copié dans
// .claude/skills/site-retours-outil/SKILL.md, bloc « @AGENTS.md » dans CLAUDE.md) ; ancien site de retours
// (tools/site-retours/ : publier.notes, publier.exporteur) ; .outil.json créé ou complété, sans perdre de clé ;
// première publication (« outil publier ») ; résumé (Wiki, fichiers à commiter, ce qui reste à faire, veille).
// Idempotente : relancée, elle dit ce qui est déjà fait et ne refait rien. Aucune opération Git d'écriture : Git ne sert
// qu'à lire (rev-parse, status --no-optional-locks). Une modification d'un fichier EXISTANT demande une question O/N
// dans un terminal ; sans terminal et sans --oui, elle est sautée et listée « à faire : relancer avec --oui ». Créer un
// fichier absent ne demande rien.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
	CODES, ErreurCli, usage, erreur, FICHIER_CONFIG, FORME_JETON, RACINE_OUTIL, MESSAGE_AUTRE_PROJET, ID_PROJET,
	chercherConfig, lireFichierConfig, normaliserServeur, fichierJetons, lireJetons, serveurInstallation, appelServeur, requete, jetonPour, lienSurLeChemin, MESSAGE_LIEN,
	emettre, dateLocale, coupe, secondesOption, masquerJetons, programmeGit, envEnfant,
} from "./commun.ts";
import type { Contexte, Commande, Config, Env } from "./commun.ts";
import { brancher, appairagesEnCours } from "./appairage.ts";
import { publier, lireConfigPublier } from "./publier.ts";
import { COMMANDE_VEILLE_CLAUDE } from "./veille.ts";

export const DEBUT = "<!-- outil:debut -->", FIN = "<!-- outil:fin -->";
export const GABARIT_AGENTS = path.join(RACINE_OUTIL, "methode", "AGENTS.md");
export const GABARIT_SKILL = path.join(RACINE_OUTIL, "methode", "integrations", "claude", "SKILL.md");
export const SKILL_CLAUDE = ".claude/skills/site-retours-outil/SKILL.md"; // relatif à la racine du dépôt
export const BLOC_CLAUDE = `${DEBUT}\n@AGENTS.md\n${FIN}`;
export const ANCIEN_SITE = "tools/site-retours";
export const EXPORTEUR_ANCIEN = ["node", "tools/site-retours/export.mjs", "--out={data}"]; // convention du skill site-retours
const citer = (a: string) => /[\s"]/.test(a) || !a ? JSON.stringify(a) : a;
const CLES_CONNUES = ["serveur", "projet", "publier"];
// La ligne « vérifier sans écrire » du bloc d'AGENTS.md : l'agent la remplit (METHODE.md § 0) ; une fois remplie, elle
// est gardée quand le bloc est remplacé (sinon chaque relance effacerait son travail).
const LIGNE_VERIFIER = /^- vérifier sans écrire\b.*$/m;
const A_COMPLETER = "<à compléter par l'agent";
export const MESSAGE_ANCIEN_SITE = "Ses retours peuvent être repris : avec Claude, demande « reprends les retours de l'ancien site claude.ai » ; " +
	"ailleurs, exporte-les puis `outil importer-artifact <dossier> --autoriser`.";

// --- Git (lecture seulement, par execFile) -------------------------------------------------------------------------
// git est résolu dans le PATH (programmeGit) : par son nom seul, Windows le chercherait d'abord dans le dossier courant,
// le dépôt, avant toute question et même avec --sans-publier.
function git(env: Env, cwd: string, args: string[]): Promise<{ ok: boolean; sortie: string }> {
	const programme = programmeGit(env);
	return new Promise((ok, ko) => execFile(programme, ["--no-optional-locks", ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: envEnfant(env) }, (e, sortie) => {
		if (e && (e as NodeJS.ErrnoException).code === "ENOENT") return ko(erreur("git introuvable : installer Git ou le mettre dans le PATH"));
		ok({ ok: !e, sortie: String(sortie ?? "") });
	}));
}
async function racineDepot(env: Env, cwd: string): Promise<string> {
	const r = await git(env, cwd, ["rev-parse", "--show-toplevel"]);
	const top = r.sortie.trim();
	if (!r.ok || !top) throw erreur(`${cwd} n'est pas dans un dépôt Git : lancer « outil installer » depuis le dépôt du projet ; un dossier de documents de design seuls (projet sans code) devient un dépôt par git init, avec l'accord de l'humain (METHODE § 0) ; rien n'a été fait`, { code: "hors_depot" });
	try { return fs.realpathSync.native(path.resolve(top)); } catch { return path.resolve(top); }
}
// Fichiers gérés par l'installeur que Git voit modifiés ou non suivis (git status, sans verrou ni écriture de l'index).
async function aCommiter(env: Env, racine: string, geres: string[]): Promise<string[] | null> {
	const r = await git(env, racine, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...geres]);
	if (!r.ok) return null;
	const l: string[] = [];
	const champs = r.sortie.split("\0");
	for (let i = 0; i < champs.length; i++) {
		const e = champs[i];
		if (e.length < 4) continue;
		if (e[0] === "R" || e[0] === "C") i++; // renommage : le champ suivant est l'ancien nom
		l.push(e.slice(3));
	}
	return [...new Set(l)];
}

// --- Fichiers texte : BOM et fins de ligne gardés, comparaison sur le texte normalisé (LF, sans BOM) -------------------
type Texte = { bom: boolean; crlf: boolean; norm: string };
function lireTexte(f: string): Texte | null {
	if (!fs.existsSync(f)) return null;
	if (!fs.statSync(f).isFile()) throw erreur(`${f} existe mais n'est pas un fichier : rien n'y est écrit`);
	const brut = fs.readFileSync(f, "utf8");
	const bom = brut.startsWith("\uFEFF");
	const sans = bom ? brut.slice(1) : brut;
	return { bom, crlf: /\r\n/.test(sans), norm: sans.replace(/\r\n/g, "\n") };
}
// Création (modele null) avec le drapeau « wx » : un fichier apparu entre-temps, ou un lien pendant, n'est jamais écrasé
// ni suivi.
function ecrireTexte(f: string, norm: string, modele: Texte | null): void {
	fs.mkdirSync(path.dirname(f), { recursive: true });
	const t = modele?.crlf ? norm.replace(/\n/g, "\r\n") : norm;
	fs.writeFileSync(f, (modele?.bom ? "\uFEFF" : "") + t, { flag: modele ? "w" : "wx" });
}
const normaliser = (s: string) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

// Le bloc d'un gabarit (de DEBUT à FIN compris).
export function blocDuGabarit(fichier: string): string {
	const t = normaliser(fs.readFileSync(fichier, "utf8"));
	const d = t.indexOf(DEBUT), f = t.indexOf(FIN);
	if (d < 0 || f < d) throw erreur(`gabarit sans bloc ${DEBUT} … ${FIN} : ${fichier} (dépôt de l'outil incomplet ?)`);
	return t.slice(d, f + FIN.length);
}
// Fusion d'un bloc dans un texte (normalisé). « garder » ajuste le nouveau bloc d'après l'ancien (ligne remplie).
export type Fusion = { texte: string; action: "cree" | "ajoute" | "remplace" | "inchange" } | { action: "mal-forme"; raison: string };
export function fusionnerBloc(existant: string | null, bloc: string, garder?: (ancien: string, nouveau: string) => string): Fusion {
	if (existant === null) return { texte: bloc + "\n", action: "cree" };
	const nd = existant.split(DEBUT).length - 1, nf = existant.split(FIN).length - 1;
	if (nd === 0 && nf === 0) {
		const corps = existant.replace(/\s+$/, "");
		return { texte: (corps ? corps + "\n\n" : "") + bloc + "\n", action: "ajoute" };
	}
	const d = existant.indexOf(DEBUT), f = existant.indexOf(FIN);
	if (nd !== 1 || nf !== 1 || f < d) return { action: "mal-forme", raison: `il faut un seul ${DEBUT} suivi d'un seul ${FIN}` };
	const ancien = existant.slice(d, f + FIN.length);
	const nouveau = garder ? garder(ancien, bloc) : bloc;
	if (ancien === nouveau) return { texte: existant, action: "inchange" };
	return { texte: existant.slice(0, d) + nouveau + existant.slice(f + FIN.length), action: "remplace" };
}
export const garderLigneVerifier = (ancien: string, nouveau: string): string => {
	const l = ancien.match(LIGNE_VERIFIER)?.[0];
	return l && !l.includes(A_COMPLETER) && LIGNE_VERIFIER.test(nouveau) ? nouveau.replace(LIGNE_VERIFIER, () => l) : nouveau;
};

// --- Type de projet (constat, pour les messages) -----------------------------------------------------------------------
// La racine d'abord, puis ses sous-dossiers sur deux niveaux (projet Godot dans « godot/ », Unity dans « client/ »…),
// niveau par niveau : le premier niveau qui a un repère donne le type. Ni lien ni jonction suivis ; ni dossier caché
// (.git…), ni node_modules ; 200 dossiers au plus par niveau.
const IGNORES_TYPE = new Set(["node_modules"]);
function sousDossiers(dossiers: string[]): string[] {
	const r: string[] = [];
	for (const d of dossiers) {
		let entrees: fs.Dirent[];
		try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
		for (const e of entrees) {
			if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".") || IGNORES_TYPE.has(e.name)) continue;
			r.push(path.join(d, e.name));
			if (r.length >= 200) return r;
		}
	}
	return r;
}
export function typeProjet(racine: string): string {
	let niveau = [racine];
	for (let n = 0; n <= 2 && niveau.length; n++) {
		const a = (p: string) => niveau.some(d => fs.existsSync(path.join(d, p)));
		if (a("project.godot")) return "godot";
		if (a("ProjectSettings/ProjectVersion.txt")) return "unity";
		if (a("package.json")) return "node";
		if (a("pyproject.toml") || a("requirements.txt")) return "python";
		niveau = sousDossiers(niveau);
	}
	return "autre";
}

// --- outil installer -------------------------------------------------------------------------------------------------
export type ActionFichier = "cree" | "ajoute" | "remplace" | "complete" | "inchange" | "saute" | "refuse" | "mal-forme";
export type BilanFichier = { fichier: string; action: ActionFichier; detail?: string };
export type Publication = { etat: "publie" | "deja" | "saute" | "sans_exporteur" | "echec"; build?: number; page?: string; resume?: string; message?: string; code?: string };
export type ResultatInstaller = {
	etat: "installe"; depot: string; type: string; serveur: string; projet: string; page: string;
	connexion: { etat: "deja" | "branche"; nom: string; role: string; pour?: { id: string; nom: string } };
	fichiers: BilanFichier[]; ancienSite: { dossier: string; notes: boolean; exporteur: boolean } | null;
	publication: Publication; aCommiter: string[]; aFaire: string[]; veille: string; veilleVerifier: string; avertissements: string[];
};
export type ResultatAttente = { etat: "attente"; depot: string; code: string; url: string; expire: string; relance: string };
type OptionsInstaller = { serveur?: string; projet?: string; agent?: string; oui: boolean; sansPublier: boolean; attendre: boolean; sansNavigateur: boolean; poste?: string; delai?: number };

export async function installer(ctx: Contexte, o: OptionsInstaller): Promise<ResultatInstaller | ResultatAttente> {
	if (o.agent !== undefined && o.agent !== "claude") throw usage("--agent : claude (le seul agent connu ; sans --agent, Claude Code est reconnu à CLAUDE.md ou .claude/)");
	// 1. Dépôt.
	const racine = await racineDepot(ctx.env, ctx.cwd);
	if (fs.existsSync(path.join(racine, "serveur", "src", "principal.ts")) && fs.existsSync(path.join(racine, "methode", "METHODE.md")))
		throw erreur(`${racine} est le dépôt de l'outil lui-même : « outil installer » se lance depuis le dépôt du CODE d'un projet (rien n'a été fait)`, { code: "depot_outil" });
	const ctxR: Contexte = { ...ctx, cwd: racine };
	const cheminConfig = path.join(racine, FICHIER_CONFIG);
	const trouve = chercherConfig(racine);
	if (trouve && path.resolve(trouve) !== path.resolve(cheminConfig))
		throw erreur(`${trouve} est au-dessus du dépôt ${racine} : le déplacer à la racine du dépôt, ou le retirer, puis relancer (rien n'a été fait)`);
	const avertissements: string[] = [];
	const avertir = (m: string) => { avertissements.push(m); ctx.stderr("attention : " + m); };
	ctx.stderr(`installation dans ${racine}`);

	// 2. Connexion.
	// .outil.json par un lien ou une jonction : refus avant tout appairage (il serait lu, puis écrit, hors du dépôt).
	const lienConfig = lienSurLeChemin(racine, cheminConfig);
	if (lienConfig) throw erreur(MESSAGE_LIEN(lienConfig) + " (rien n'a été fait)", { code: "lien" });
	const existant = fs.existsSync(cheminConfig) ? lireFichierConfig(cheminConfig) : null;
	const serveurDonne = o.serveur ?? existant?.serveur;
	let serveurConnu = serveurDonne ? normaliserServeur(serveurDonne) : undefined;
	let projetConnu = o.projet ?? existant?.projet;
	if (projetConnu !== undefined && !ID_PROJET.test(projetConnu)) throw usage("--projet : [a-z0-9-]{1,40}");
	if (existant && serveurConnu && projetConnu && ((existant.serveur && normaliserServeur(existant.serveur) !== serveurConnu) || (existant.projet && existant.projet !== projetConnu)))
		throw usage(MESSAGE_AUTRE_PROJET(cheminConfig, existant.projet, existant.serveur));
	// Relance après le premier temps : l'appairage gardé dans appairages.json pour ce dépôt (encore valable ; à défaut,
	// expiré, pour un nouveau code au même endroit) donne le serveur et le projet qui manquent. Il passe AVANT installation.json, qui
	// peut désigner un autre serveur (§ 7.4 : serveur temporaire passé par --serveur au premier temps) ; sans --projet,
	// il est repris quel que soit le projet demandé au premier temps.
	// Seulement ceux demandés depuis CE dépôt : un appairage en attente d'un autre dépôt n'est jamais repris (un premier
	// appel ailleurs y attendrait 90 s le clic d'un autre code, avec un autre projet).
	const enCours = appairagesEnCours(ctx.env, "permanent").filter(c => c.depot !== null && path.resolve(c.depot) === path.resolve(racine)
		&& (!serveurConnu || c.serveur === serveurConnu) && (projetConnu === undefined || c.projet === projetConnu));
	const candidats = enCours.some(c => c.valable) ? enCours.filter(c => c.valable) : enCours;
	if (candidats.length > 1) throw usage(`plusieurs appairages en cours (${candidats.map(c => `${c.projet ?? "projet à choisir"} sur ${c.serveur}`).join(" ; ")}) : préciser --serveur et --projet`);
	const garde = candidats[0] ?? null;
	if (garde) { serveurConnu ??= garde.serveur; if (projetConnu === undefined && garde.projet) projetConnu = garde.projet; }
	if (!serveurConnu) { const i = serveurInstallation(ctx.env); if (i) serveurConnu = i.serveur; }
	// La commande à relancer, avec ce qui est résolu et les options données (une relance « --oui » seule perdrait
	// --serveur, --projet, --agent et --sans-publier).
	const relancer = (sv: string | undefined, pj: string | undefined) => ["outil installer", ...(sv ? ["--serveur", sv] : []), ...(pj ? ["--projet", pj] : []),
		...(o.agent ? ["--agent", o.agent] : []), ...(o.sansPublier ? ["--sans-publier"] : []), ...(o.poste !== undefined ? ["--poste", citer(o.poste)] : []),
		...(o.sansNavigateur ? ["--sans-navigateur"] : []), "--oui"].join(" ");
	let relance = relancer(serveurConnu, projetConnu);
	let connexion: ResultatInstaller["connexion"] | null = null;
	let serveur = serveurConnu ?? "", projet = projetConnu ?? "";
	if (serveurConnu && projetConnu) {
		const j = lireJetons(fichierJetons(ctx.env))[serveurConnu]?.[projetConnu];
		if (typeof j === "string" && FORME_JETON.test(j)) {
			ctx.stderr(`connexion : vérification du jeton enregistré pour ${projetConnu} sur ${serveurConnu}`);
			const r = await appelServeur(ctx, serveurConnu, "GET", `/api/p/${encodeURIComponent(projetConnu)}/session`, { jeton: j });
			if (r.status === 200 && r.corps && typeof r.corps === "object") connexion = { etat: "deja", nom: String(r.corps.nom ?? ""), role: String(r.corps.role ?? "") };
			else ctx.stderr(`connexion : le jeton enregistré ne répond pas (${r.status}) : nouvel appairage`);
		}
	}
	if (!connexion) {
		// .outil.json n'est pas écrit par brancher (ecrireConfig: false) : il l'est à l'étape 7, avec question ou --oui.
		const base = { serveur: serveurConnu, projet: projetConnu, poste: o.poste, sansNavigateur: o.sansNavigateur, delai: o.delai, relance, relanceSans: relance, ecrireConfig: false };
		// Un appairage gardé → attendre le clic (comme « outil brancher --attendre ») ; expiré entre-temps : nouveau code
		// au même endroit.
		let r: Awaited<ReturnType<typeof brancher>>;
		try { r = await brancher(ctxR, { ...base, attendre: o.attendre || !!garde }); }
		catch (e) {
			if (!(e instanceof ErreurCli && e.details.etat === "expire" && garde && !o.attendre)) throw e;
			ctx.stderr("l'appairage en cours a expiré : nouveau code");
			r = await brancher(ctxR, { ...base, attendre: false });
		}
		if (r.etat === "attente") return { etat: "attente", depot: racine, code: r.code, url: r.url, expire: r.expire, relance };
		connexion = { etat: "branche", nom: r.nom, role: r.role, pour: r.pour };
		serveur = r.serveur; projet = r.projet;
	}
	// Désormais serveur et projet sont connus : les relances citées dans le résumé les portent.
	relance = relancer(serveur, projet);

	// 3. Type de projet.
	const type = typeProjet(racine);
	const fichiers: BilanFichier[] = [];
	// Écriture d'un fichier : absent (ou créé dans cette exécution) → écrit ; existant → question dans un terminal,
	// sauté sans terminal et sans --oui.
	// Un lien ou une jonction sur le chemin (AGENTS.md, .claude, .claude/skills…) : jamais suivi, ni lu ni écrit ; refusé
	// et listé (commun.ts, lienSurLeChemin).
	const refusLien = (rel: string): boolean => {
		const lien = lienSurLeChemin(racine, path.join(racine, ...rel.split("/")));
		if (!lien) return false;
		fichiers.push({ fichier: rel, action: "refuse", detail: MESSAGE_LIEN(lien) });
		avertir(`${rel} : ${MESSAGE_LIEN(lien)}`);
		return true;
	};
	const ecrire = async (rel: string, norm: string, avant: Texte | null, action: ActionFichier) => {
		const f = path.join(racine, rel);
		if (action === "inchange") { fichiers.push({ fichier: rel, action }); return; }
		if (avant && !(await permis(ctx, o.oui, `${rel} : ${LIBELLES[action]}`))) {
			fichiers.push({ fichier: rel, action: "saute", detail: `${LIBELLES[action]} : sauté (${ctx.terminal ? "refusé" : "sans terminal ni --oui"})` });
			return;
		}
		ecrireTexte(f, norm, avant);
		fichiers.push({ fichier: rel, action });
	};
	const avecBloc = async (rel: string, bloc: string, garder?: (a: string, n: string) => string) => {
		if (refusLien(rel)) return;
		const avant = lireTexte(path.join(racine, rel));
		const fu = fusionnerBloc(avant ? avant.norm : null, bloc, garder);
		if (fu.action === "mal-forme") { fichiers.push({ fichier: rel, action: "mal-forme", detail: fu.raison }); avertir(`${rel} : bloc mal formé (${fu.raison}) : non modifié, à corriger à la main`); return; }
		await ecrire(rel, fu.texte, avant, fu.action);
	};

	// 4. AGENTS.md.
	await avecBloc("AGENTS.md", blocDuGabarit(GABARIT_AGENTS), garderLigneVerifier);

	// 5. Claude Code.
	const claude = o.agent === "claude" || fs.existsSync(path.join(racine, "CLAUDE.md")) || fs.existsSync(path.join(racine, ".claude"));
	if (claude) {
		const skill = normaliser(fs.readFileSync(GABARIT_SKILL, "utf8"));
		if (!refusLien(SKILL_CLAUDE)) {
			const avant = lireTexte(path.join(racine, SKILL_CLAUDE));
			await ecrire(SKILL_CLAUDE, skill, avant, !avant ? "cree" : avant.norm === skill ? "inchange" : "remplace");
		}
		await avecBloc("CLAUDE.md", BLOC_CLAUDE);
	}

	// 6. Ancien site de retours.
	const dossierAncien = path.join(racine, ...ANCIEN_SITE.split("/"));
	let ancienSite: ResultatInstaller["ancienSite"] = null;
	if (fs.existsSync(dossierAncien) && fs.statSync(dossierAncien).isDirectory()) {
		ancienSite = { dossier: ANCIEN_SITE, notes: fs.readdirSync(dossierAncien).some(f => /^notes_.*\.json$/i.test(f)), exporteur: fs.existsSync(path.join(dossierAncien, "export.mjs")) };
		ctx.stderr(`ancien site de retours trouvé (${ANCIEN_SITE}/${ancienSite.notes ? ", notes datées" : ""}${ancienSite.exporteur ? ", export.mjs" : ""}). ${MESSAGE_ANCIEN_SITE}`);
	}

	// 7. .outil.json : créé ou complété ; clés existantes gardées, jamais de jeton.
	const actuel = fs.existsSync(cheminConfig) ? lireFichierConfig(cheminConfig) : null;
	const brut = actuel?.brut ?? {};
	for (const k of Object.keys(brut)) if (!CLES_CONNUES.includes(k)) avertir(`${FICHIER_CONFIG} : clé inconnue « ${coupe(k, 40)} », gardée (connues : ${CLES_CONNUES.join(", ")})`);
	const cible: Record<string, unknown> = { ...brut };
	if (typeof brut.serveur !== "string") cible.serveur = serveur;
	if (typeof brut.projet !== "string") cible.projet = projet;
	if (ancienSite && (ancienSite.notes || ancienSite.exporteur)) {
		const p = brut.publier;
		if (p !== undefined && (!p || typeof p !== "object" || Array.isArray(p))) avertir(`${FICHIER_CONFIG} : « publier » n'est pas un objet : non complété (à corriger à la main)`);
		else {
			const pub: Record<string, unknown> = { ...(p as Record<string, unknown> | undefined) };
			if (ancienSite.exporteur && pub.exporteur === undefined) pub.exporteur = EXPORTEUR_ANCIEN;
			if (ancienSite.notes && pub.notes === undefined) pub.notes = ANCIEN_SITE;
			cible.publier = pub;
		}
	}
	{
		const norm = JSON.stringify(cible, null, 2) + "\n";
		const avant = actuel ? lireTexte(cheminConfig) : null;
		const action: ActionFichier = !actuel ? "cree" : isDeepStrictEqual(cible, brut) ? "inchange" : "complete";
		await ecrire(FICHIER_CONFIG, norm, avant, action);
	}

	// 8. Première publication.
	const page = `${serveur}/p/${projet}/`;
	const aFaire: string[] = [];
	let publication: Publication;
	const configSautee = fichiers.some(f => f.fichier === FICHIER_CONFIG && f.action === "saute");
	const effectif = fs.existsSync(cheminConfig) ? lireFichierConfig(cheminConfig) : null;
	if (o.sansPublier) publication = { etat: "saute", message: "--sans-publier : pas de publication (outil publier pour publier)" };
	else if (!effectif?.serveur || !effectif.projet) publication = { etat: "saute", message: `${FICHIER_CONFIG} sans serveur ou sans projet (modification sautée) : pas de publication ; relancer « ${relance} », puis outil publier` };
	else {
		let exporteur: string[] | null = null;
		try { exporteur = lireConfigPublier(ctxR, cheminConfig, effectif.publier).exporteur; }
		catch (e) { if (!(e instanceof ErreurCli)) throw e; avertir(e.message); }
		if (!exporteur) publication = { etat: "sans_exporteur", message: "pas d'exporteur (« publier.exporteur » de .outil.json) : pas de publication" };
		else {
			const cfg: Config = { serveur, projet, chemin: cheminConfig };
			// Tout échec ici (jeton d'OUTIL_JETON refusé, serveur injoignable, exporteur) devient « echec » : les fichiers
			// sont déjà écrits, le résumé doit sortir.
			try {
				const dernier = (await requete(ctxR, cfg, jetonPour(ctxR, cfg), "GET", "/builds")).dernier;
				if (dernier && typeof dernier === "object") publication = { etat: "deja", build: Number(dernier.build), page, message: `Wiki déjà publié (build n° ${dernier.build} du ${dateLocale(dernier.date)}) : « outil publier » pour republier` };
				else {
					ctx.stderr("première publication : outil publier");
					const r = await publier(ctxR);
					publication = { etat: "publie", build: r.build, page: r.page, resume: r.resume };
				}
			} catch (e) {
				if (!(e instanceof ErreurCli)) throw e;
				publication = { etat: "echec", message: masquerJetons(e.message), code: typeof e.details.code === "string" ? e.details.code : undefined };
				ctx.stderr("erreur (publication) : " + masquerJetons(e.message));
			}
		}
	}

	// 9. Résumé.
	for (const f of fichiers) {
		if (f.action === "saute") aFaire.push(`${f.fichier} : modification sautée : relancer avec --oui (« ${relance} »)`);
		if (f.action === "refuse") aFaire.push(`${f.fichier} : ${f.detail}`);
		if (f.action === "mal-forme") aFaire.push(`${f.fichier} : bloc ${DEBUT} … ${FIN} mal formé, à corriger à la main, puis relancer`);
	}
	const agents = lireTexte(path.join(racine, "AGENTS.md"));
	if (agents && agents.norm.match(LIGNE_VERIFIER)?.[0].includes(A_COMPLETER))
		aFaire.push("AGENTS.md : remplir la ligne « vérifier sans écrire dans les données » (commandes de test du projet, sans effet sur ses données)");
	if (publication.etat === "sans_exporteur" && !configSautee)
		aFaire.push(`écrire l'exporteur du projet (${type}) : METHODE.md § 4 (« outil methode »), le déclarer dans « publier.exporteur » de .outil.json, puis « outil publier »`);
	if (publication.etat === "echec") aFaire.push("corriger l'exporteur (« publier.exporteur » de .outil.json, gardé) d'après sa sortie, puis « outil publier »");
	if (ancienSite) aFaire.push(`reprendre les retours de l'ancien site claude.ai (si l'humain le demande) : ${MESSAGE_ANCIEN_SITE}`);
	const geres = ["AGENTS.md", FICHIER_CONFIG, ...(claude ? ["CLAUDE.md", SKILL_CLAUDE] : [])];
	const vus = await aCommiter(ctx.env, racine, geres);
	const commiter = vus ?? fichiers.filter(f => ["cree", "ajoute", "remplace", "complete"].includes(f.action)).map(f => f.fichier);
	const veille = claude ? COMMANDE_VEILLE_CLAUDE : "outil veille --memoriser -- <commande de ton agent> (outil aide veille)";
	return { etat: "installe", depot: racine, type, serveur, projet, page, connexion, fichiers, ancienSite, publication, aCommiter: commiter, aFaire, veille, veilleVerifier: VEILLE_VERIFIER, avertissements };
}

// La liste blanche de la veille n'a pas les commandes de test du projet : sans elles, l'agent de la veille ne vérifie rien
// et ne passe rien à « fait » (METHODE § 6.8). Le développeur les ajoute, sous sa responsabilité.
export const VEILLE_VERIFIER = "pour que l'agent de la veille puisse vérifier (et passer des retours à « fait ») : ajouter à sa liste blanche les commandes " +
	"de la ligne « vérifier sans écrire » d'AGENTS.md (Claude Code : après --allowedTools, par ex. \"Bash(go test *)\")";

const LIBELLES: Record<ActionFichier, string> = {
	cree: "créer", ajoute: "ajouter le bloc à la fin", remplace: "remplacer le bloc (ou le fichier) par la version de l'outil", complete: "compléter (serveur, projet, publier ; clés existantes gardées)",
	inchange: "inchangé", saute: "sauté", refuse: "refusé", "mal-forme": "bloc mal formé",
};
const LIBELLES_FAIT: Record<ActionFichier, string> = {
	cree: "créé", ajoute: "bloc ajouté à la fin", remplace: "bloc remplacé (version de l'outil)", complete: "complété (clés existantes gardées)",
	inchange: "déjà à jour", saute: "sauté", refuse: "refusé", "mal-forme": "bloc mal formé, non modifié",
};
// Question O/N avant la modification d'un fichier existant : dans un terminal seulement (Entrée = oui) ; sans terminal,
// non (la modification est listée à faire) ; --oui : oui sans question.
async function permis(ctx: Contexte, oui: boolean, quoi: string): Promise<boolean> {
	if (oui) return true;
	if (!ctx.terminal) return false;
	const rep = (await (ctx.question ?? ctx.lireEntree)(`${quoi} ? [O/n] `)).trim().toLowerCase();
	return rep === "" || rep === "o" || rep === "oui" || rep === "y" || rep === "yes";
}

export const COMMANDES_INSTALLER: Commande[] = [
	{
		nom: "installer", usage: "outil installer [--serveur URL] [--projet P] [--agent claude] [--oui] [--sans-publier] [--attendre] [--sans-navigateur] [--poste NOM] [--delai S] [--json]",
		resume: "branche le dépôt du code en une commande : connexion (appairage), AGENTS.md, raccourci Claude, ancien site de retours, .outil.json, première publication ; idempotente, aucune opération Git",
		detail: "Depuis le dépôt du code (racine : git rev-parse --show-toplevel ; refuse le dépôt de l'outil). Connexion : un jeton déjà enregistré qui répond, sinon « outil brancher » ; " +
			"sans terminal, la commande s'arrête sur le code (sortie 0, etat « attente ») sans rien écrire d'autre : montrer ce code à l'humain, attendre qu'il dise avoir cliqué « Autoriser », puis relancer la commande affichée (« relance » : --serveur, --projet et les options du premier appel, plus --oui), qui attend le clic et continue ; « outil installer --oui » seul reprend aussi l'appairage en cours de ce dépôt. " +
			`AGENTS.md : bloc ${DEBUT} … ${FIN} créé, ajouté à la fin ou remplacé (la ligne « vérifier sans écrire », une fois remplie, est gardée). ` +
			`Claude Code (--agent claude, ou CLAUDE.md ou .claude/ présent) : raccourci copié dans ${SKILL_CLAUDE}, bloc « @AGENTS.md » dans CLAUDE.md. ` +
			`Ancien site (${ANCIEN_SITE}/) : publier.notes (notes_*.json) et publier.exporteur (export.mjs) dans .outil.json. .outil.json créé ou complété, clés existantes gardées, jamais de jeton. ` +
			"Première publication par « outil publier » (sauf --sans-publier, sans exporteur, ou déjà publiée) ; un échec est rapporté (sortie 1) et la clé reste, à corriger. " +
			"Questions : dans un terminal, une question O/N (Entrée = oui) avant chaque modification d'un fichier EXISTANT ; sans terminal et sans --oui, ces modifications sont sautées et listées « relancer avec --oui ». " +
			"Créer un fichier absent ne demande rien. Aucune opération Git d'écriture : le résumé liste les fichiers à commiter, ce qui reste à faire et la commande de veille.",
		exemple: "outil installer --serveur http://127.0.0.1:8080 --projet jardin --oui\n  outil installer --serveur http://127.0.0.1:8080 --projet jardin --oui   (la relance affichée, après le clic)",
		options: { serveur: "valeur", projet: "valeur", agent: "valeur", oui: "drapeau", "sans-publier": "drapeau", attendre: "drapeau", "sans-navigateur": "drapeau", poste: "valeur", delai: "valeur" }, positionnels: [0, 0], refuseeSousVeille: () => true,
		faire: async (ctx, _pos, opt) => {
			const r = await installer(ctx, {
				serveur: opt.serveur as string | undefined, projet: opt.projet as string | undefined, agent: opt.agent as string | undefined, poste: opt.poste as string | undefined,
				oui: !!opt.oui, sansPublier: !!opt["sans-publier"], attendre: !!opt.attendre, sansNavigateur: !!opt["sans-navigateur"],
				delai: opt.delai !== undefined ? secondesOption(opt.delai, "delai", 3600) : undefined,
			});
			if (r.etat === "attente") {
				emettre(ctx, r, [`code ${r.code} : en attente du clic « Autoriser » sur ${r.url} (valable jusqu'à ${dateLocale(r.expire)}).`,
					"Rien d'autre n'est fait. Montre ce code à l'humain ; après son clic, relance : " + r.relance]);
				return CODES.ok;
			}
			const p = r.publication;
			emettre(ctx, r, [
				`dépôt : ${r.depot} (type ${r.type})`,
				r.connexion.etat === "deja" ? `connexion : déjà faite (jeton « ${r.connexion.nom} », rôle ${r.connexion.role}) sur ${r.serveur}, projet ${r.projet}`
					: `connexion : branché sur ${r.serveur}, projet ${r.projet} (jeton « ${r.connexion.nom} », rôle ${r.connexion.role}${r.connexion.pour?.nom ? `, pour ${r.connexion.pour.nom}` : ""})`,
				"fichiers :", ...r.fichiers.map(f => `  ${f.fichier} : ${f.action === "saute" && f.detail ? f.detail : LIBELLES_FAIT[f.action]}${f.action === "mal-forme" && f.detail ? ` (${f.detail})` : ""}`),
				`publication : ${p.etat === "publie" ? `build n° ${p.build}${p.resume ? ` (${p.resume})` : ""}` : p.etat === "echec" ? `échec : ${p.message}` : p.message}`,
				`Wiki : ${r.page}`,
				`à commiter : ${r.aCommiter.length ? r.aCommiter.join(", ") : "rien"} (aucune opération Git n'a été faite)`,
				...(r.aFaire.length ? ["à faire :", ...r.aFaire.map(x => "  - " + x)] : ["à faire : rien"]),
				"veille (« Traiter les retours » depuis l'interface ; à lancer une fois sur ce poste, par l'humain) :", "  " + r.veille, "  " + r.veilleVerifier,
			]);
			return p.etat === "echec" ? CODES.erreur : CODES.ok;
		},
	},
];
