// CLI « outil » : veille sur le poste du code (étape 3.5, docs/etape3-5-prise-en-main.md § 5.3). Un membre clique
// « Traiter les retours » dans la méta-interface ; la veille prend la demande, lance l'agent configuré par le
// développeur, envoie des battements avec la fin de sa sortie (jetons masqués), l'arrête si la demande est annulée, puis
// termine la demande (terminee, echouee, annulee) avec un résumé masqué (fin de la sortie standard ; en cas d'échec,
// suivie de la fin de la sortie d'erreur) et une raison. L'état Git du dépôt (HEAD, dernier mouvement du reflog de HEAD,
// toutes les refs, stashs) est relevé avant et après l'agent : s'il a changé, le résumé commence par une alerte et la
// raison le dit ; si seules des refs distantes (refs/remotes, fetch ou push) ont changé, l'alerte le dit.
//   outil veille [--poste NOM] [--delai-max S] [--une-fois] [--memoriser] [-- <commande> <args…>]
// Jeton : celui du projet, de rôle agent (mainteneur ou absent : 4). Commande : ce qui suit « -- » ; avec --memoriser,
// gardée dans veille.json (dossier utilisateur, à côté de jetons.json), indexée par le chemin de .outil.json, et
// reprise par « outil veille » seul. Elle ne vient JAMAIS de .outil.json : un commit suffirait sinon à faire lancer
// n'importe quoi sur le poste à chaque clic.
// Lancement : spawn sans shell, dans le dossier de .outil.json, entrée fermée, environnement courant plus
// OUTIL_DEMANDE=<id>. Aucun jeton n'est ajouté à l'environnement de l'agent : il passe par « outil », qui lit
// jetons.json. Si OUTIL_JETON est déjà défini dans l'environnement de la veille, il est laissé tel quel (choix : l'agent
// en a besoin pour « outil » quand le jeton ne vient pas de jetons.json ; le retirer casserait ce cas sans rien protéger,
// puisque l'agent tourne avec les droits de la même personne). Windows : la commande est cherchée dans le PATH avec
// PATHEXT ; un .exe est lancé directement ; un .cmd ou un .bat passe par cmd.exe /d /s /c, chaque argument entre
// guillemets, et un argument qui contient % ! ^ " & | < > ou un retour à la ligne y est refusé.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
	CODES, ErreurCli, usage, erreur, droits, chargerConfig, jetonPour, requete, emettre, coupe, secondesOption, dateLocale,
	dossierUtilisateur, lireFichierUtilisateur, ecrireFichierUtilisateur, chercherProgramme, estScriptWindows, arreterArbre, contientJeton,
	programmeSysteme, programmeGit, envEnfant,
} from "./commun.ts";
import type { Contexte, Commande, Config, Env } from "./commun.ts";
import { posteParDefaut, validerPoste } from "./appairage.ts";

// L'exemple pour Claude Code (§ 5.3), vérifié tel quel par la recette : liste blanche en entier (une exécution sans
// interface refuse toute commande hors de sa liste), aucune commande git (par Bash comme par PowerShell : les règles
// « allow » d'un .claude/settings.json de projet s'ajoutent à la liste blanche, les règles « deny » l'emportent), ni
// Artifact.
export const COMMANDE_VEILLE_CLAUDE = "outil veille --memoriser -- claude -p \"Traite les retours du serveur en suivant AGENTS.md (traitement lancé par la veille).\" " +
	"--allowedTools \"Bash(outil *)\" \"PowerShell(outil *)\" Read Glob Grep Edit Write " +
	"--disallowedTools \"Bash(git *)\" \"PowerShell(git *)\" Artifact ArtifactData";
export const REGLE_SANS_HUMAIN = "Traitement sans humain (règle par défaut, METHODE.md « Lancé par la veille ») : lire et répondre aux retours, modifier les fichiers du projet, " +
	"lancer « outil publier » ; interdits : toute commande git (commit, push, branche, stash…), ticket pris ou modifié, Artifact claude.ai. Les modifications restent dans la copie de travail, à relire avant de commiter.";
// Dépôt changé pendant le traitement (HEAD, reflog de HEAD, une ref locale ou un stash) : première ligne du résumé,
// raison, ligne de la veille. Seules des refs distantes (refs/remotes/*) changées : un fetch (de l'IDE, du développeur)
// ou un push vers un remote nommé ; un texte à part, pour ne pas parler d'un commit qui n'a pas eu lieu.
export const ALERTE_DEPOT = "⚠ Le dépôt a changé pendant le traitement (commit, branche ou stash) : vérifie avant de pousser.";
export const RAISON_DEPOT = "dépôt changé pendant le traitement (commit, branche ou stash)";
export const ALERTE_DEPOT_DISTANT = "⚠ Des refs distantes (refs/remotes) ont changé pendant le traitement (fetch ou push) : vérifie qu'aucun push n'a été fait.";
export const RAISON_DEPOT_DISTANT = "refs distantes changées pendant le traitement (fetch ou push)";

export const INTERVALLE_VEILLE_MS = 5000, INTERVALLE_BATTEMENT_MS = 15000, DELAI_MAX_S = 3600;
const MAX_JOURNAL = 2000, MAX_RESUME = 4000, MAX_RAISON = 200, TAMPON = 16000;
const MAX_ARGS = 200, MAX_ARG = 8000;
// Caractères que cmd.exe interprète même entre guillemets (ou qui fermeraient les guillemets).
export const INTERDITS_CMD = /[%!^"&|<>\r\n]/;

// OUTIL_TEST_VEILLE_MS=<interrogation>,<battement> (tests seulement) : intervalles raccourcis.
function intervalles(env: Env): { veille: number; battement: number } {
	const m = /^(\d{2,6}),(\d{2,6})$/.exec(String(env.OUTIL_TEST_VEILLE_MS || ""));
	return m ? { veille: Number(m[1]), battement: Number(m[2]) } : { veille: INTERVALLE_VEILLE_MS, battement: INTERVALLE_BATTEMENT_MS };
}

// --- veille.json (dossier utilisateur) : commande mémorisée, indexée par le chemin de .outil.json ----------------------
export const fichierVeille = (env: Env): string => path.join(dossierUtilisateur(env), "veille.json");
const cleVeille = (chemin: string) => path.resolve(chemin);
// La commande et sa date de mémorisation (affichée au démarrage : une commande changée à l'insu du développeur se voit).
// Étape 3.9, G5 : profils de traitement, des commandes nommées en plus de la commande par défaut (« textes » : un agent
// sans droit sur le code ; « code » : avec vérification). Le nom est choisi par un humain dans l'interface ; la commande
// reste sur ce poste, jamais sur le serveur.
export const PROFIL = /^[a-z0-9-]{1,30}$/;
type Memo = { commande: string[]; memorise: string };
const estCommande = (c: unknown): c is string[] => Array.isArray(c) && c.length > 0 && c.every(x => typeof x === "string");
function commandesMemorisees(env: Env, chemin: string): { defaut: Memo | null; profils: Record<string, Memo> } {
	const e = lireFichierUtilisateur(fichierVeille(env))[cleVeille(chemin)];
	const memo = (x: any): Memo | null => x && estCommande(x.commande) ? { commande: x.commande, memorise: typeof x.memorise === "string" ? x.memorise : "" } : null;
	const profils: Record<string, Memo> = {};
	if (e && e.profils && typeof e.profils === "object") for (const [n, x] of Object.entries(e.profils)) { const m = memo(x); if (m && PROFIL.test(n)) profils[n] = m; }
	return { defaut: memo(e), profils };
}
function memoriser(env: Env, chemin: string, commande: string[], profil = ""): string {
	const f = fichierVeille(env);
	const tous = lireFichierUtilisateur(f);
	const e = tous[cleVeille(chemin)] && typeof tous[cleVeille(chemin)] === "object" ? tous[cleVeille(chemin)] : {};
	const memo = { commande, memorise: new Date().toISOString() };
	tous[cleVeille(chemin)] = profil ? { ...e, profils: { ...(e.profils || {}), [profil]: memo } } : { ...e, ...memo };
	ecrireFichierUtilisateur(f, tous);
	return f;
}

// --- Commande à lancer ---------------------------------------------------------------------------------------------------
export type Lancement = { programme: string; args: string[]; verbatim: boolean; affichage: string };
const affichage = (c: string[]) => c.map(a => /[\s"]/.test(a) || !a ? JSON.stringify(a) : a).join(" ");
// Un argument pour cmd.exe /s /c : entre guillemets ; les barres obliques inverses finales doublées (sinon la dernière
// échapperait le guillemet fermant pour le programme qui relit sa ligne de commande).
const citerCmd = (a: string) => `"${a.replace(/(\\+)$/, "$1$1")}"`;
// cmd.exe par son chemin absolu sous SystemRoot (jamais « cmd.exe » seul, cherché d'abord dans le dossier courant).
function cmdExe(env: Env): string {
	const p = programmeSysteme(env, "System32", "cmd.exe");
	if (!p) throw erreur("cmd.exe introuvable (SystemRoot non défini ou invalide) : un agent .cmd ou .bat ne peut pas être lancé ; lancer directement un .exe (par ex. node <script.js>)");
	return p;
}
// Vérifie la commande et prépare son lancement, AVANT toute demande prise (une commande refusée ne bloque jamais une
// demande). Sous Windows : .exe ou .com direct, .cmd ou .bat par cmd.exe avec refus des caractères dangereux, autre
// extension refusée.
export function preparerCommande(commande: string[], env: Env, dossier: string, plateforme = process.platform): Lancement {
	if (!commande.length || !commande[0].trim()) throw usage("commande vide après « -- »");
	if (commande.length > MAX_ARGS || commande.some(a => a.length > MAX_ARG || a.includes("\0"))) throw usage(`commande : ${MAX_ARGS} arguments au plus, de ${MAX_ARG} caractères au plus`);
	if (commande.some(a => contientJeton(a))) throw usage("un argument de la commande ressemble à un jeton (wdd_…) : un jeton ne se passe jamais en argument ; l'agent passe par « outil », qui lit jetons.json. Si un jeton a été tapé, le révoquer.");
	const win = plateforme === "win32";
	const resolu = chercherProgramme(commande[0], env, dossier);
	if (!resolu) throw erreur(`commande introuvable : « ${coupe(commande[0], 200)} » (ni relative au dossier de .outil.json, ni dans le PATH${win ? " avec PATHEXT" : ""}) : rien n'est lancé`, { code: "commande_introuvable" });
	const args = commande.slice(1);
	if (!win) return { programme: resolu, args, verbatim: false, affichage: affichage(commande) };
	const ext = path.extname(resolu).toLowerCase();
	if (ext === ".exe" || ext === ".com") return { programme: resolu, args, verbatim: false, affichage: affichage(commande) };
	if (estScriptWindows(resolu)) {
		const faux = [resolu, ...args].findIndex(a => INTERDITS_CMD.test(a));
		if (faux >= 0) throw usage(`${faux === 0 ? `le chemin du script « ${coupe(resolu, 200)} »` : `l'argument n° ${faux} (« ${coupe(args[faux - 1], 80)} »)`} contient un caractère que cmd.exe interprète (% ! ^ " & | < > ou un retour à la ligne) : ` +
			`refusé, car ${path.basename(resolu)} est un script .cmd/.bat qui ne se lance que par cmd.exe. Retirer ce caractère, ou lancer directement un .exe (par ex. node <script.js>).`);
		return { programme: cmdExe(env), args: ["/d", "/s", "/c", `"${[resolu, ...args].map(citerCmd).join(" ")}"`], verbatim: true, affichage: affichage(commande) };
	}
	throw usage(`« ${coupe(resolu, 200)} » n'est ni un .exe, ni un .cmd, ni un .bat : lancer un .exe (par ex. node <script.js>)`);
}

// --- Sortie de l'agent : tampon, masquage ----------------------------------------------------------------------------------
// Tout ce qui ressemble à un jeton (wdd_…, quelle que soit sa longueur) est masqué, ainsi que les valeurs exactes des
// jetons connus. Le masquage se fait sur tout le tampon AVANT de couper la fin : couper d'abord pourrait séparer le
// préfixe wdd_ du reste d'un jeton.
export const MARQUE_MASQUE = "wdd_…(masqué)";
export function masquerSortie(t: string, secrets: string[] = []): string {
	t = t.replace(/wdd_[A-Za-z0-9_-]*/g, MARQUE_MASQUE);
	for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join(MARQUE_MASQUE);
	return t;
}
const fin = (s: string, n: number) => s.length <= n ? s : "…" + s.slice(-(n - 1));
// Tampon trop long : on garde la seconde moitié, à partir de la première fin de ligne (une ligne coupée au début
// pourrait commencer au milieu d'un jeton).
function rogner(t: string): string {
	if (t.length <= TAMPON) return t;
	const g = t.slice(-TAMPON / 2), i = g.indexOf("\n");
	return i >= 0 ? g.slice(i + 1) : g.replace(/^[A-Za-z0-9_-]+/, "");
}
const uneLigne = (s: string) => coupe(s.replace(/[\u0000-\u001f\u007f]+/g, " "), MAX_RAISON);
// Résumé de la demande (textes déjà masqués) : la fin de la sortie standard ; en cas d'échec, suivie de la fin de la
// sortie d'erreur (au plus le tiers du résumé), sous un intertitre.
export const INTERTITRE_ERREURS = "--- sortie d'erreur ---";
export function resume(sortie: string, erreurs: string, max = MAX_RESUME): string {
	if (!erreurs.trim()) return fin(sortie, max);
	const e = INTERTITRE_ERREURS + "\n" + fin(erreurs, Math.floor(max / 3));
	const reste = max - e.length - 1;
	return sortie.trim() ? fin(sortie.replace(/\s+$/, ""), reste) + "\n" + e : e;
}
// Avec une alerte (ALERTE_DEPOT ou ALERTE_DEPOT_DISTANT ; "" : aucune) en première ligne : le reste est coupé d'autant
// (4 000 caractères en tout).
export const resumeAvecAlerte = (sortie: string, erreurs: string, alerte: string): string =>
	alerte ? alerte + "\n" + resume(sortie, erreurs, MAX_RESUME - alerte.length - 1) : resume(sortie, erreurs);

// --- État Git du dépôt, avant et après l'agent ------------------------------------------------------------------------------
// Deux parts. « local » : HEAD (commit et branche : passer sur une autre branche au même commit ne change ni le commit de
// HEAD ni les refs), le dernier mouvement du reflog de HEAD et leur nombre (un commit suivi d'un reset --hard laisse
// HEAD et les refs comme avant, pas le reflog), les refs hors refs/remotes (refs/heads, refs/tags, refs/stash…) et la
// liste des stashs. « distant » : les refs refs/remotes/* (un fetch, ou un push vers un remote nommé, ne change qu'elles).
// Limite : un push vers une URL d'un commit déjà présent ne laisse aucune trace locale ; la protection reste la liste
// noire de la commande (« Bash(git *) », « PowerShell(git *) »). Lecture seule, sans shell, git résolu dans le PATH
// (jamais celui du dépôt), --no-optional-locks. null : pas un dépôt Git, ou git absent : pas de contrôle (la demande se
// traite quand même).
export type EtatDepot = { local: string; distant: string };
export type ChangementDepot = "local" | "distant" | null;
const estDistante = (ligne: string) => ligne.slice(ligne.indexOf(" ") + 1).startsWith("refs/remotes/");
export async function etatDepot(dossier: string, env: Env): Promise<EtatDepot | null> {
	let programme: string;
	try { programme = programmeGit(env); } catch { return null; }
	const git = (args: string[]) => new Promise<string | null>(ok => execFile(programme, ["--no-optional-locks", ...args],
		{ cwd: dossier, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: envEnfant(env) },
		(e, sortie) => ok(e ? null : String(sortie))));
	if ((await git(["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return null;
	const refs = await git(["for-each-ref", "--format=%(objectname) %(refname)"]);
	if (refs === null) return null;
	const lignes = refs.split("\n").map(l => l.trim()).filter(Boolean);
	const head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim() || "(aucun commit)";
	const branche = (await git(["symbolic-ref", "--quiet", "HEAD"]))?.trim() || "(HEAD détaché)";
	// Reflog vide ou absent (aucun commit, core.logAllRefUpdates=false) : une valeur fixe, jamais null.
	const reflog = (await git(["reflog", "-n", "1", "--format=%H%x09%gs", "HEAD"]))?.trim() || "(reflog vide ou illisible)";
	const mouvements = (await git(["rev-list", "--walk-reflogs", "--count", "HEAD"]))?.trim() || "?";
	const stashs = (await git(["stash", "list", "--format=%H"])) ?? "(stashs illisibles)";
	return {
		local: ["HEAD " + head, "branche " + branche, `reflog ${mouvements} ${reflog}`, ...lignes.filter(l => !estDistante(l)), "stashs", stashs.trim()].join("\n"),
		distant: lignes.filter(estDistante).join("\n"),
	};
}
// Avant illisible (pas un dépôt, pas de git) : pas de contrôle. Après illisible : compte comme un changement local.
export function changementDepot(avant: EtatDepot | null, apres: EtatDepot | null): ChangementDepot {
	if (!avant) return null;
	if (!apres || apres.local !== avant.local) return "local";
	return apres.distant !== avant.distant ? "distant" : null;
}
const ALERTES: Record<"local" | "distant", { alerte: string; raison: string }> = {
	local: { alerte: ALERTE_DEPOT, raison: RAISON_DEPOT },
	distant: { alerte: ALERTE_DEPOT_DISTANT, raison: RAISON_DEPOT_DISTANT },
};

// --- Boucle -----------------------------------------------------------------------------------------------------------------
export type Traitee = { id: string; etat: string; code_sortie: number | null; raison: string };
// lancements : « » pour la commande par défaut, un nom par profil (G5).
type Veille = { cfg: Config; jeton: string; poste: string; lancements: Map<string, Lancement>; delaiMaxS: number; uneFois: boolean; arret: AbortSignal };

const heure = () => new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// Une ligne par événement, à l'heure locale ; sur stderr avec --json (stdout garde le seul résultat JSON).
const evenement = (ctx: Contexte) => (m: string) => { const l = `[${heure()}] ${m}`; if (ctx.json) ctx.stderr(l); else ctx.stdout(l); };
function attendre(ms: number, arret: AbortSignal): Promise<void> {
	return new Promise(ok => {
		if (arret.aborted) return ok();
		const fini = () => { clearTimeout(t); arret.removeEventListener("abort", fini); ok(); };
		const t = setTimeout(fini, ms);
		arret.addEventListener("abort", fini);
	});
}
const nomPersonne = (p: any) => p && typeof p === "object" && p.nom ? String(p.nom) : "?";

async function veiller(ctx: Contexte, v: Veille): Promise<Traitee[]> {
	const evt = evenement(ctx), iv = intervalles(ctx.env);
	const traitees: Traitee[] = [];
	let enPanne = "";
	while (!v.arret.aborted) {
		let demande: any;
		try { demande = (await requete(ctx, v.cfg, v.jeton, "POST", "/veille", JSON.stringify({ poste: v.poste, profils: [...v.lancements.keys()].filter(Boolean) }))).demande; }
		catch (e) {
			if (e instanceof ErreurCli && e.sortie === CODES.droits) throw e; // jeton révoqué, rôle changé : s'arrêter
			const m = e instanceof ErreurCli ? e.message : String(e);
			if (m !== enPanne) evt(`serveur : ${coupe(m, 200)} ; nouvel essai toutes les ${Math.round(iv.veille / 1000) || 1} s`);
			enPanne = m;
			await attendre(iv.veille, v.arret);
			continue;
		}
		if (enPanne) { evt("serveur de nouveau joignable"); enPanne = ""; }
		if (!demande || typeof demande.id !== "string") { await attendre(iv.veille, v.arret); continue; }
		if (v.arret.aborted) break;
		try { await requete(ctx, v.cfg, v.jeton, "POST", `/demandes/${encodeURIComponent(demande.id)}/prendre`); }
		catch (e) {
			if (e instanceof ErreurCli && e.sortie === CODES.droits) throw e;
			evt(e instanceof ErreurCli && e.sortie === CODES.conflit ? `demande ${demande.id} : prise par un autre veilleur` : `demande ${demande.id} non prise : ${coupe(e instanceof ErreurCli ? e.message : String(e), 200)}`);
			await attendre(iv.veille, v.arret);
			continue;
		}
		const profil = typeof demande.profil === "string" ? demande.profil : "";
		const lancement = v.lancements.get(profil);
		const plafond = Number.isInteger(demande.plafond) && demande.plafond > 0 ? demande.plafond : 0;
		if (!lancement) {
			// Profil demandé mais pas (ou plus) mémorisé sur ce poste : la demande se termine en échec, rien n'est lancé.
			const raison = profil ? `profil « ${profil} » non mémorisé sur ce poste (outil veille --memoriser --profil ${profil} -- <commande>)` : "aucune commande par défaut sur ce poste (outil veille --memoriser -- <commande>)";
			try { await requete(ctx, v.cfg, v.jeton, "POST", `/demandes/${encodeURIComponent(demande.id)}/terminer`, JSON.stringify({ etat: "echouee", resume: raison, code_sortie: null, raison: coupe(raison, MAX_RAISON) })); } catch { }
			evt(`demande ${demande.id} : ${raison}`);
			traitees.push({ id: demande.id, etat: "echouee", code_sortie: null, raison });
			if (v.uneFois) break;
			continue;
		}
		evt(`demande ${demande.id} prise (demandée par ${nomPersonne(demande.demandeur)})${profil ? `, profil « ${profil} »` : ""}${plafond ? `, plafond de ${plafond} retours` : ""} : lancement de ${lancement.affichage}`);
		traitees.push(await traiter(ctx, { ...v, lancement, profil, plafond }, demande.id, iv.battement, evt));
		if (v.uneFois) break;
	}
	return traitees;
}

type Motif = "annulee" | "delai" | "arret" | "perdue";
async function traiter(ctx: Contexte, v: Veille & { lancement: Lancement; profil: string; plafond: number }, id: string, battementMs: number, evt: (m: string) => void): Promise<Traitee> {
	const win = process.platform === "win32";
	const secrets = [v.jeton, String(ctx.env.OUTIL_JETON || "").trim()];
	// Journal (battements) : les deux flux mêlés, dans l'ordre d'arrivée. Résumé : la sortie standard seule (METHODE § 6.8 :
	// le résumé de l'agent sur stdout) ; la sortie d'erreur (avertissements de l'agent, chemins du poste) n'y entre qu'en
	// cas d'échec, sous un intertitre, pour le diagnostic.
	let tampon = "", sortie = "", erreurs = "", motif: Motif | null = null, erreurLancement: string | null = null;
	const masque = () => masquerSortie(tampon, secrets);
	// État Git du dépôt avant l'agent (comparé après sa fin) : la liste noire de la commande n'arrête pas tout agent.
	const dossier = path.dirname(v.cfg.chemin);
	const depotAvant = await etatDepot(dossier, ctx.env);
	let enfant: ChildProcess | null = null;
	let fini!: (r: { code: number | null; signal: string | null }) => void;
	const finProcessus = new Promise<{ code: number | null; signal: string | null }>(r => { fini = r; });
	try {
		enfant = spawn(v.lancement.programme, v.lancement.args, {
			// NoDefaultCurrentDirectoryInExePath (envEnfant) : hérité de cmd.exe, PowerShell et des lanceurs .cmd que l'agent
			// lance (claude.cmd de npm, outil.cmd), qui ne prennent alors plus le node.bat ou node.exe du dépôt.
			// Étape 3.9 : OUTIL_PROFIL (G5, le nom du profil choisi) et OUTIL_PLAFOND (G4, retours au plus pour cette vague :
			// « outil retours liste » s'y tient d'elle-même).
			cwd: dossier, env: envEnfant(ctx.env, { poser: { OUTIL_DEMANDE: id, ...(v.profil ? { OUTIL_PROFIL: v.profil } : {}), ...(v.plafond ? { OUTIL_PLAFOND: String(v.plafond) } : {}) } }), stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true, windowsVerbatimArguments: v.lancement.verbatim, detached: !win,
		});
	} catch (e) { erreurLancement = (e as Error).message; fini({ code: null, signal: null }); }
	const arreter = (m: Motif) => {
		if (motif) return;
		motif = m;
		if (!enfant) return;
		arreterArbre(enfant, ctx.env);
		const secours = setTimeout(() => { try { enfant!.kill("SIGKILL"); } catch { } }, 5000);
		secours.unref();
	};
	if (enfant) {
		enfant.stdout!.setEncoding("utf8"); enfant.stderr!.setEncoding("utf8");
		enfant.stdout!.on("data", (b: string) => { tampon = rogner(tampon + b); sortie = rogner(sortie + b); });
		enfant.stderr!.on("data", (b: string) => { tampon = rogner(tampon + b); erreurs = rogner(erreurs + b); });
		enfant.on("error", e => { erreurLancement = (e as NodeJS.ErrnoException).code || e.message; fini({ code: null, signal: null }); });
		// « close » attend la fin des tubes ; un petit-enfant qui les garderait ouverts ne bloque pas la veille : après
		// « exit », 3 s au plus.
		enfant.on("close", (code, signal) => fini({ code, signal }));
		enfant.on("exit", (code, signal) => { setTimeout(() => fini({ code, signal }), 3000).unref(); });
	}
	let battementEnCours: Promise<void> | null = null;
	const battement = setInterval(() => {
		if (battementEnCours || motif) return;
		battementEnCours = (async () => { try {
			const r = await requete(ctx, v.cfg, v.jeton, "POST", `/demandes/${encodeURIComponent(id)}/battement`, JSON.stringify({ journal: fin(masque(), MAX_JOURNAL) }));
			if (r.annuler === true && !motif) { evt(`demande ${id} : annulation demandée depuis l'interface : arrêt de l'agent`); arreter("annulee"); }
		} catch (e) {
			if (e instanceof ErreurCli && (e.sortie === CODES.conflit || e.sortie === CODES.droits)) {
				evt(`demande ${id} : plus en cours sur le serveur (${coupe(e.message, 160)}) : arrêt de l'agent`);
				arreter("perdue");
			} else evt(`demande ${id} : battement non envoyé (${coupe(e instanceof ErreurCli ? e.message : String(e), 160)})`);
		} finally { battementEnCours = null; } })();
	}, battementMs);
	const delai = setTimeout(() => { evt(`demande ${id} : délai dépassé (${v.delaiMaxS} s) : arrêt de l'agent`); arreter("delai"); }, v.delaiMaxS * 1000);
	const surArret = () => { evt(`demande ${id} : veille arrêtée (Ctrl+C) : arrêt de l'agent`); arreter("arret"); };
	if (v.arret.aborted) surArret(); else v.arret.addEventListener("abort", surArret);
	let res: { code: number | null; signal: string | null };
	try { res = await finProcessus; }
	finally { clearInterval(battement); clearTimeout(delai); v.arret.removeEventListener("abort", surArret); }
	// Dernier battement, avec la fin des sorties : sans lui, le journal perd ce que l'agent a écrit depuis le précédent
	// (tout, pour un agent de moins de 15 s). Après celui en cours, pour qu'un journal plus ancien n'arrive pas après ;
	// un seul essai, sa réponse (annuler) n'a plus d'objet. Pas pour une demande perdue : le serveur la refuserait.
	if (battementEnCours) await battementEnCours;
	if (motif !== "perdue") {
		try { await requete(ctx, v.cfg, v.jeton, "POST", `/demandes/${encodeURIComponent(id)}/battement`, JSON.stringify({ journal: fin(masque(), MAX_JOURNAL) })); }
		catch (e) { evt(`demande ${id} : dernier journal non envoyé (${coupe(e instanceof ErreurCli ? e.message : String(e), 160)})`); }
	}
	const code = typeof res.code === "number" ? res.code : null;
	// Après l'agent (arrêté ou non) : un dépôt qui n'est plus lisible compte comme changé.
	const changement = depotAvant === null ? null : changementDepot(depotAvant, await etatDepot(dossier, ctx.env));
	const { alerte, raison: raisonDepot } = changement ? ALERTES[changement] : { alerte: "", raison: "" };
	if (alerte) evt(`demande ${id} : ${alerte}`);
	if (motif === "perdue") return { id, etat: "perdue", code_sortie: code, raison: raisonDepot ? `plus en cours sur le serveur ; ${raisonDepot}` : "plus en cours sur le serveur" };
	let etat: "terminee" | "echouee" | "annulee", raison: string;
	if (motif === "annulee") { etat = "annulee"; raison = "annulée depuis l'interface"; }
	else if (motif === "delai") { etat = "echouee"; raison = "délai dépassé"; }
	else if (motif === "arret") { etat = "echouee"; raison = "veille arrêtée"; }
	else if (erreurLancement) { etat = "echouee"; raison = `agent non lancé (${erreurLancement})`; }
	else if (code === 0) { etat = "terminee"; raison = ""; }
	else { etat = "echouee"; raison = code !== null ? `code de sortie ${code}` : `arrêté par le signal ${res.signal ?? "?"}`; }
	if (raisonDepot) raison = raison ? `${raison} ; ${raisonDepot}` : raisonDepot;
	raison = uneLigne(masquerSortie(raison, secrets));
	const corps = JSON.stringify({ etat, resume: resumeAvecAlerte(masquerSortie(sortie, secrets), etat === "terminee" ? "" : masquerSortie(erreurs, secrets), alerte), code_sortie: code, raison });
	for (let essai = 1; ; essai++) {
		try { await requete(ctx, v.cfg, v.jeton, "POST", `/demandes/${encodeURIComponent(id)}/terminer`, corps); break; }
		catch (e) {
			const definitif = e instanceof ErreurCli && (e.sortie === CODES.conflit || e.sortie === CODES.droits || e.sortie === CODES.usage);
			if (definitif || essai >= 3) { evt(`demande ${id} : fin non enregistrée sur le serveur (${coupe(e instanceof ErreurCli ? e.message : String(e), 160)})`); break; }
			await new Promise(r => setTimeout(r, 2000));
		}
	}
	evt(`demande ${id} : ${etat}${raison ? ` (${raison})` : ""}${code !== null ? `, code de sortie ${code}` : ""}`);
	return { id, etat, code_sortie: code, raison };
}

// --- outil veille -------------------------------------------------------------------------------------------------------
export const COMMANDES_VEILLE: Commande[] = [
	{
		nom: "veille", usage: "outil veille [--poste NOM] [--delai-max S] [--une-fois] [--memoriser [--profil NOM]] [-- <commande> <args…>] [--json]",
		resume: "veille sur le poste du code : prend les demandes « Traiter les retours » de l'interface, lance l'agent donné après « -- » (ou mémorisé), suit et termine la demande",
		detail: "Jeton du projet de rôle agent (outil brancher) ; un jeton mainteneur ou absent : 4. Commande : ce qui suit « -- » ; --memoriser la garde dans veille.json (fichier utilisateur, indexé par le chemin de .outil.json) " +
			"et « outil veille » seul la reprend ; elle ne vient jamais de .outil.json. Boucle : interrogation toutes les 5 s, prise de la demande, lancement sans shell dans le dossier de .outil.json " +
			"(entrée fermée, environnement courant plus OUTIL_DEMANDE=<id>, aucun jeton ajouté ; OUTIL_JETON, s'il est déjà défini, est laissé), battement toutes les 15 s avec la fin de la sortie (jetons masqués), et un dernier à la fin de l'agent, avant terminer, " +
			"annulation depuis l'interface : arrêt de l'arbre de processus ; fin : code 0 → terminee, sinon echouee ; résumé : les 4 000 derniers caractères de la sortie STANDARD, masqués (en cas d'échec, suivis de la fin de la sortie d'erreur), le journal des battements ayant les deux sorties. Dépôt Git : HEAD, dernier mouvement du reflog de HEAD, refs et stashs relevés avant et après l'agent ; s'ils ont changé, la demande se termine quand même, " +
				`le résumé commence par « ${ALERTE_DEPOT} », la raison le dit et la veille l'affiche ; si seules des refs refs/remotes ont changé (fetch, push vers un remote nommé) : « ${ALERTE_DEPOT_DISTANT} ». ` +
				"Un push vers une URL d'un commit déjà présent ne se voit pas localement : la protection reste la liste noire (« Bash(git *) », « PowerShell(git *) »). --delai-max (3 600 s) : arrêt, echouee « délai dépassé ». " +
			"Profils (étape 3.9) : --memoriser --profil NOM -- <commande> garde une commande nommée de plus (NOM : [a-z0-9-]{1,30}, 10 au plus) ; la veille annonce ses profils au serveur, et « Traiter les retours » propose de choisir. Une demande d'un profil inconnu de ce poste se termine en échec, sans rien lancer. L'agent reçoit OUTIL_PROFIL (le profil) et OUTIL_PLAFOND (réglage plafond_vague du projet : « outil retours liste » ne donne pas plus de retours). " +
			"Ctrl+C : arrêt de l'agent, echouee « veille arrêtée », sortie 0. --une-fois : une demande, puis s'arrête. Windows : PATH et PATHEXT ; .exe direct ; .cmd/.bat par cmd.exe, " +
			"un argument avec % ! ^ \" & | < > ou un retour à la ligne y est refusé. Une ligne par événement, à l'heure locale (sur stderr avec --json, qui rend { serveur, projet, poste, traitees } à la fin). " +
			REGLE_SANS_HUMAIN,
		exemple: COMMANDE_VEILLE_CLAUDE + "\n  outil veille",
		options: { poste: "valeur", "delai-max": "valeur", "une-fois": "drapeau", memoriser: "drapeau", profil: "valeur" }, positionnels: [0, 0], apresTiret: true, refuseeSousVeille: () => true,
		faire: async (ctx, _pos, opt) => {
			const poste = opt.poste !== undefined ? validerPoste(opt.poste) : posteParDefaut();
			const delaiMaxS = opt["delai-max"] !== undefined ? secondesOption(opt["delai-max"], "delai-max", 7 * 24 * 3600) : DELAI_MAX_S;
			const cfg = chargerConfig(ctx);
			const donnee = Array.isArray(opt["--"]) && (opt["--"] as string[]).length ? opt["--"] as string[] : null;
			if (opt.memoriser && !donnee) throw usage(`--memoriser : la commande à garder suit « -- », par ex. :\n  ${COMMANDE_VEILLE_CLAUDE}`);
			const profilOpt = opt.profil === undefined ? "" : String(opt.profil);
			if (profilOpt && !opt.memoriser) throw usage("--profil s'emploie avec --memoriser : outil veille --memoriser --profil NOM -- <commande>");
			if (profilOpt && !PROFIL.test(profilOpt)) throw usage("--profil : [a-z0-9-]{1,30}");
			// Commandes : celle donnée après « -- » (sans --memoriser : la seule de cette veille), sinon les mémorisées
			// (la commande par défaut et les profils ; une commande qui vient d'être mémorisée y est déjà).
			const lancements = new Map<string, Lancement>();
			let memorisee: Memo | null = null;
			if (donnee && !opt.memoriser) lancements.set("", preparerCommande(donnee, ctx.env, path.dirname(cfg.chemin)));
			else {
				if (donnee) preparerCommande(donnee, ctx.env, path.dirname(cfg.chemin)); // refusée avant d'être gardée
				const m = commandesMemorisees(ctx.env, cfg.chemin);
				const avec = donnee ? (profilOpt ? { ...m, profils: { ...m.profils, [profilOpt]: { commande: donnee, memorise: new Date().toISOString() } } } : { ...m, defaut: { commande: donnee, memorise: new Date().toISOString() } }) : m;
				if (Object.keys(avec.profils).length + 1 > 10) throw usage("10 profils au plus par dépôt");
				memorisee = avec.defaut;
				if (avec.defaut) lancements.set("", preparerCommande(avec.defaut.commande, ctx.env, path.dirname(cfg.chemin)));
				for (const [n, x] of Object.entries(avec.profils)) lancements.set(n, preparerCommande(x.commande, ctx.env, path.dirname(cfg.chemin)));
			}
			if (!lancements.size) throw usage(`aucune commande à lancer pour ${cfg.chemin} : la donner après « -- » (avec --memoriser pour la garder sur ce poste). Pour Claude Code :\n  ${COMMANDE_VEILLE_CLAUDE}\n${REGLE_SANS_HUMAIN}`);
			const lancement = lancements.get("") ?? [...lancements.values()][0];
			const jeton = jetonPour(ctx, cfg);
			const s = await requete(ctx, cfg, jeton, "GET", "/session");
			if (s.role !== "agent") throw droits(`la veille demande un jeton de rôle agent pour ${cfg.projet} (celui-ci : ${s.role}) : brancher ce poste avec un jeton agent (« outil brancher »), sans OUTIL_JETON mainteneur`, { role: s.role });
			if (opt.memoriser && donnee) ctx.stderr(`commande${profilOpt ? ` du profil « ${profilOpt} »` : ""} mémorisée dans ${memoriser(ctx.env, cfg.chemin, donnee, profilOpt)} pour ${cfg.chemin}`);
			// Ctrl+C : le signal du contexte (tests), sinon SIGINT de ce processus ; un second Ctrl+C sort tout de suite.
			let surSigint: (() => void) | null = null;
			let arret = ctx.arret;
			if (!arret) {
				const c = new AbortController();
				arret = c.signal;
				surSigint = () => { if (c.signal.aborted) process.exit(130); c.abort(); };
				process.on("SIGINT", surSigint);
			}
			const evt = evenement(ctx);
			const autres = [...lancements.entries()].filter(([n]) => n).map(([n, l]) => `profil « ${n} » : ${l.affichage}`);
			evt(`veille de ${cfg.projet} sur ${cfg.serveur}, poste « ${poste} » (jeton « ${s.nom} ») ; commande${memorisee ? ` mémorisée le ${memorisee.memorise ? dateLocale(memorisee.memorise) : "?"}` : ""} : ${lancements.has("") ? lancement.affichage : "(aucune par défaut)"}${autres.length ? " ; " + autres.join(" ; ") : ""} ; dossier : ${path.dirname(cfg.chemin)}${opt["une-fois"] ? " ; une seule demande" : ""}. Ctrl+C pour arrêter.`);
			let traitees: Traitee[];
			try { traitees = await veiller(ctx, { cfg, jeton, poste, lancements, delaiMaxS, uneFois: !!opt["une-fois"], arret }); }
			finally { if (surSigint) process.removeListener("SIGINT", surSigint); }
			emettre(ctx, { serveur: cfg.serveur, projet: cfg.projet, poste, traitees }, `veille arrêtée : ${traitees.length} demande(s) traitée(s)${traitees.length ? " (" + traitees.map(t => `${t.id} ${t.etat}`).join(", ") + ")" : ""}`);
			return CODES.ok;
		},
	},
];
