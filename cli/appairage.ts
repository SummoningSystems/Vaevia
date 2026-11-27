// CLI « outil » : appairage d'un poste (étape 3.5, docs/etape3-5-prise-en-main.md § 2.3), sur le modèle de
// l'autorisation d'appareil (RFC 8628, « gh auth login ») : la CLI demande un appairage au serveur, l'humain clique
// « Autoriser » dans son navigateur (où il a sa session), la CLI vient chercher le jeton. Personne ne voit le jeton.
//   outil brancher [--serveur URL] [--projet P] [--role agent|mainteneur] [--poste NOM] [--sans-navigateur]
//                  [--sans-attendre | --attendre] [--delai S]
// En deux temps sans terminal (un agent ne voit la sortie qu'à la fin d'une commande) : le premier appel affiche le
// code et sort (0, etat « attente ») ; le code d'appareil est gardé dans appairages.json (dossier utilisateur, à côté
// de jetons.json, mêmes droits) ; « --attendre » reprend l'appairage et attend la livraison.
// obtenirJeton() sert aussi à « importer-artifact --autoriser » (jeton ponctuel gardé en mémoire) et servira à
// « outil installer » (§ 3). Le code d'appareil vaut un jeton tant que l'appairage n'est pas livré : il n'est jamais
// affiché, ni recopié dans un message.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
	CODES, ErreurCli, usage, erreur, droits, ID_PROJET, FICHIER_CONFIG, FORME_JETON, MESSAGE_AUTRE_PROJET, MESSAGE_LIEN, lireJetons,
	chercherConfig, lireFichierConfig, normaliserServeur, dossierUtilisateur, fichierJetons, lireFichierUtilisateur, ecrireFichierUtilisateur,
	enregistrerJeton, serveurInstallation, fichierInstallation, appelServeur, erreurHttp, emettre, dateLocale, coupe, pause, secondesOption,
	programmeSysteme, envEnfant,
} from "./commun.ts";
import type { Contexte, Commande, Env } from "./commun.ts";

// Code utilisateur (§ 2.1) : 8 caractères d'un alphabet sans ambiguïté, présentés XXXX-XXXX. L'URL de la page
// d'autorisation est construite ici à partir du serveur configuré et de ce code validé, jamais reprise du serveur.
export const CODE_UTILISATEUR = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const CODE_APPAREIL = /^[A-Za-z0-9_-]{20,100}$/;
export const ROLES_APPAIRAGE = ["agent", "mainteneur"] as const;
export type RoleAppairage = typeof ROLES_APPAIRAGE[number];
export type UsageAppairage = "permanent" | "ponctuel";
export const DELAI_TERMINAL_S = 600;     // dans un terminal : 10 min, la durée de l'appairage
export const DELAI_SANS_TERMINAL_S = 90; // --attendre sans terminal : tenir dans le délai d'une commande d'agent

// Un appairage en cours, tel que gardé dans appairages.json.
export type EntreeAppairage = { code_appareil: string; code: string; url: string; expire: string; intervalle: number; poste: string; role: RoleAppairage; usage: UsageAppairage; projet: string | null; cree: string; depot?: string };
// Ce que la livraison donne (le jeton n'est jamais affiché ; il reste en mémoire ou va dans jetons.json).
export type Livraison = { jeton: string; projet: string; role: string; nom: string; pour: { id: string; nom: string }; usage: string; expire: string | null };
export type Issue = { etat: "attente"; entree: EntreeAppairage } | { etat: "livre"; livraison: Livraison };

export const urlAppairage = (serveur: string, code: string): string => {
	if (!CODE_UTILISATEUR.test(code)) throw erreur("code d'appairage reçu du serveur invalide (XXXX-XXXX attendu) : rien n'est ouvert");
	return `${serveur}/appairage?code=${code}`;
};

// --- Nom du poste ---------------------------------------------------------------------------------------------------
// Mêmes règles qu'un nom affiché côté serveur (serveur/src/auth.ts, validerNom) : 1 à 60 caractères dont une lettre ou
// un chiffre, sans caractère de contrôle, ni < ni >.
export function validerPoste(v: unknown): string {
	const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
	if (!s || s.length > 60 || /[\u0000-\u001f\u007f<>\uFFFD]/.test(s) || !/[\p{L}\p{N}]/u.test(s)) throw usage("--poste : 1 à 60 caractères dont une lettre ou un chiffre, sans < ni >");
	return s;
}
export function posteParDefaut(): string {
	const h = os.hostname().replace(/[\u0000-\u001f\u007f<>\uFFFD]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
	return /[\p{L}\p{N}]/u.test(h) ? h : "poste";
}

// --- appairages.json (dossier utilisateur), indexé par serveur, projet demandé (« » : aucun) et usage -----------------
export const fichierAppairages = (env: Env): string => path.join(dossierUtilisateur(env), "appairages.json");
function lireEntreeAppairage(env: Env, serveur: string, projet: string | null, usage_: UsageAppairage): EntreeAppairage | null {
	const e = lireFichierUtilisateur(fichierAppairages(env))[serveur]?.[projet ?? ""]?.[usage_];
	if (!e || typeof e !== "object" || typeof e.code_appareil !== "string" || !CODE_APPAREIL.test(e.code_appareil) || typeof e.code !== "string" || !CODE_UTILISATEUR.test(e.code)
		|| typeof e.expire !== "string" || !(Number(e.intervalle) > 0)) return null;
	return { ...e, url: urlAppairage(serveur, e.code), intervalle: Number(e.intervalle) } as EntreeAppairage;
}
function ecrireEntreeAppairage(env: Env, serveur: string, projet: string | null, usage_: UsageAppairage, entree: EntreeAppairage | null): void {
	const fichier = fichierAppairages(env);
	const tous = lireFichierUtilisateur(fichier);
	const k = projet ?? "";
	if (entree) ((tous[serveur] ??= {})[k] ??= {})[usage_] = entree;
	else {
		if (!tous[serveur]?.[k]?.[usage_]) return;
		delete tous[serveur][k][usage_];
		if (!Object.keys(tous[serveur][k]).length) delete tous[serveur][k];
		if (!Object.keys(tous[serveur]).length) delete tous[serveur];
	}
	ecrireFichierUtilisateur(fichier, tous);
}

// Appairages gardés pour cet usage : serveur et projet demandé (null : aucun), expirés compris ; valable : pas encore
// expiré.
// depot : le dossier d'où il a été demandé (pour reprendre, parmi plusieurs, celui de ce dépôt).
export type AppairageGarde = { serveur: string; projet: string | null; valable: boolean; depot: string | null };
export function appairagesEnCours(env: Env, usage_: UsageAppairage): AppairageGarde[] {
	const l: AppairageGarde[] = [];
	for (const [serveur, parProjet] of Object.entries(lireFichierUtilisateur(fichierAppairages(env)))) {
		if (!parProjet || typeof parProjet !== "object") continue;
		for (const [k, parUsage] of Object.entries(parProjet as Record<string, any>)) {
			const e = parUsage?.[usage_];
			if (e && (k === "" || ID_PROJET.test(k))) l.push({ serveur, projet: k || null, valable: typeof e.expire === "string" && Date.parse(e.expire) > Date.now(), depot: typeof e.depot === "string" ? e.depot : null });
		}
	}
	return l;
}

// Parmi des appairages gardés, ceux demandés depuis ce dossier (ou un de ses sous-dossiers, ou l'un de ses parents,
// comme la racine d'un dépôt) s'il y en a ; sinon tous.
export function parmiCeDepot(l: AppairageGarde[], dossier: string): AppairageGarde[] {
	const d = path.resolve(dossier);
	const dedans = (a: string, b: string) => { const r = path.relative(a, b); return !r || (!r.startsWith("..") && !path.isAbsolute(r)); };
	const ici = l.filter(c => c.depot && (dedans(c.depot, d) || dedans(d, c.depot)));
	return ici.length ? ici : l;
}

// --- Navigateur -----------------------------------------------------------------------------------------------------
// explorer.exe <url> sous Windows, par son chemin absolu sous SystemRoot (le nom seul serait d'abord cherché dans le
// dossier courant, le dépôt : commun.ts, programmeSysteme), open sous macOS, xdg-open ailleurs. null : rien à lancer.
export function commandeNavigateur(env: Env, url: string, plateforme = process.platform): [string, string[]] | null {
	if (plateforme === "win32") { const p = programmeSysteme(env, "explorer.exe"); return p ? [p, [url]] : null; }
	return plateforme === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
}
// Lancé sans shell, détaché, sans attendre ; un échec n'est pas fatal (l'adresse est écrite sur stderr).
// OUTIL_TEST_NAVIGATEUR=<fichier> (tests seulement) : l'URL est ajoutée à ce fichier au lieu d'ouvrir un navigateur.
export function ouvrirNavigateur(ctx: Contexte, url: string): void {
	const test = ctx.env.OUTIL_TEST_NAVIGATEUR;
	if (test) { try { fs.appendFileSync(test, url + "\n"); } catch { } return; }
	const echec = () => ctx.stderr("navigateur non ouvert : ouvre l'adresse ci-dessus à la main");
	const c = commandeNavigateur(ctx.env, url);
	if (!c) return echec();
	const [prog, args] = c;
	try {
		const p = spawn(prog, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true, env: envEnfant(ctx.env) });
		p.on("error", echec);
		p.unref();
	} catch { echec(); }
}

// --- Serveur --------------------------------------------------------------------------------------------------------
type Demande = { serveur: string; projet: string | null; role: RoleAppairage; usage: UsageAppairage; poste: string };
async function demanderAppairage(ctx: Contexte, d: Demande): Promise<EntreeAppairage> {
	const corps = { poste: d.poste, role: d.role, usage: d.usage, ...(d.projet ? { projet: d.projet } : {}) };
	const r = await appelServeur(ctx, d.serveur, "POST", "/api/appairage", { corps: JSON.stringify(corps) });
	if (r.status === 404) throw erreur(`${d.serveur} ne connaît pas l'appairage (serveur antérieur à l'étape 3.5, ou mauvaise adresse) : mettre le serveur à jour, ou utiliser « outil connexion »`, { statut: 404 });
	if (r.status === 429) throw erreur(`429 : ${coupe(r.corps?.message || "trop d'appairages en cours", 200)}`, { statut: 429, code: r.corps?.code || "quota_exceeded" });
	if (r.status !== 201) throw erreurHttp({ status: r.status, corps: r.corps ?? { message: r.texte.slice(0, 300) } });
	const c = r.corps || {};
	if (typeof c.code_appareil !== "string" || !CODE_APPAREIL.test(c.code_appareil) || typeof c.code !== "string" || typeof c.expire !== "string" || isNaN(Date.parse(c.expire)))
		throw erreur(`réponse inattendue du serveur à la demande d'appairage : vérifier l'adresse ${d.serveur}`, { statut: r.status, code: "reponse_inattendue" });
	const intervalle = Number(c.intervalle) > 0 && Number(c.intervalle) <= 60 ? Number(c.intervalle) : 2;
	return { code_appareil: c.code_appareil, code: c.code, url: urlAppairage(d.serveur, c.code), expire: c.expire, intervalle, poste: d.poste, role: d.role, usage: d.usage, projet: d.projet, cree: new Date().toISOString(), depot: path.resolve(ctx.cwd) };
}

// Une interrogation du serveur. Livraison, refus, expiration : l'entrée de appairages.json est retirée. Un refus lève
// l'erreur de sortie 4 ; « ralentir » : slow_down (429), l'interrogation ne compte pas.
type Interrogation = { etat: "attente" } | { etat: "ralentir" } | { etat: "expire" } | { etat: "livre"; livraison: Livraison };
async function interroger(ctx: Contexte, d: Demande, entree: EntreeAppairage, relanceSans: string): Promise<Interrogation> {
	const retirer = () => ecrireEntreeAppairage(ctx.env, d.serveur, d.projet, d.usage, null);
	if (!(Date.parse(entree.expire) > Date.now())) { retirer(); return { etat: "expire" }; }
	const r = await appelServeur(ctx, d.serveur, "POST", "/api/appairage/jeton", { corps: JSON.stringify({ code_appareil: entree.code_appareil }) });
	if (r.status === 202) return { etat: "attente" };
	if (r.status === 429 && r.corps?.code === "slow_down") return { etat: "ralentir" };
	if (r.status === 410) {
		retirer();
		if (r.corps?.code === "refused") throw droits(`appairage refusé (code ${entree.code}) : ${coupe(r.corps?.message || "refusé dans le navigateur", 200)}. Rien n'est enregistré ; s'arrêter et en parler à l'humain. Après son accord, relancer : « ${relanceSans} ».`, { etat: "refuse", statut: 410, code: "refused" });
		return { etat: "expire" };
	}
	if (r.status === 200) {
		const c = r.corps || {};
		retirer();
		if (typeof c.jeton !== "string" || !FORME_JETON.test(c.jeton) || typeof c.projet !== "string" || !ID_PROJET.test(c.projet))
			throw erreur("réponse inattendue du serveur à la livraison (jeton absent ou mal formé, valeur non affichée) : relancer la demande", { statut: 200, code: "reponse_inattendue" });
		return { etat: "livre", livraison: { jeton: c.jeton, projet: c.projet, role: String(c.role || ""), nom: String(c.nom || ""), pour: { id: String(c.pour?.id || ""), nom: String(c.pour?.nom || "") }, usage: String(c.usage || d.usage), expire: typeof c.expire === "string" ? c.expire : null } };
	}
	throw erreurHttp({ status: r.status, corps: r.corps ?? { message: r.texte.slice(0, 300) } });
}
const erreurExpire = (entree: EntreeAppairage, relanceSans: string) =>
	erreur(`appairage expiré (code ${entree.code}) sans clic « Autoriser » : relancer la demande (« ${relanceSans} »)`, { etat: "expire", code: entree.code });

// Interroge le serveur toutes les « intervalle » secondes jusqu'à la livraison, au refus, à l'expiration ou au délai.
// Un slow_down (429) allonge l'intervalle d'autant (RFC 8628 § 3.5). Délai dépassé : l'entrée de appairages.json est
// gardée (on peut relancer --attendre), et l'erreur porte etat « attente ».
async function attendreLivraison(ctx: Contexte, d: Demande, entree: EntreeAppairage, delaiS: number, relance: string, relanceSans: string): Promise<Livraison> {
	const base = entree.intervalle * 1000;
	let pas = base;
	const fin = Date.now() + delaiS * 1000;
	do {
		await pause(pas);
		const r = await interroger(ctx, d, entree, relanceSans);
		if (r.etat === "livre") return r.livraison;
		if (r.etat === "expire") throw erreurExpire(entree, relanceSans);
		if (r.etat === "ralentir") pas += base;
	} while (Date.now() + pas <= fin);
	throw erreur(`toujours en attente du clic « Autoriser » après ${delaiS} s (code ${entree.code}, valable jusqu'à ${dateLocale(entree.expire)}) : rien n'est enregistré. Relance « ${relance} » après le clic.`,
		{ etat: "attente", code: entree.code, url: entree.url, expire: entree.expire });
}

// Obtenir un jeton par appairage. attendre : reprendre l'appairage en cours (sans en créer). Sinon, un appairage en
// cours pour ce serveur, ce projet et cet usage (même rôle, même poste) est d'abord interrogé une fois : livré, il sert ;
// refusé, sortie 4 ; expiré, un nouveau est demandé ; en attente, le même code est réaffiché (sans rouvrir le
// navigateur). À défaut, un nouveau est demandé (et le navigateur ouvert). Sans terminal et sans attendre : rend
// « attente » tout de suite.
export type ParametresAppairage = Demande & { attendre: boolean; sansAttendre?: boolean; delai?: number; sansNavigateur: boolean; relance: string; relanceSans: string };
export async function obtenirJeton(ctx: Contexte, p: ParametresAppairage): Promise<Issue> {
	let entree = lireEntreeAppairage(ctx.env, p.serveur, p.projet, p.usage);
	if (entree && !(Date.parse(entree.expire) > Date.now())) {
		ecrireEntreeAppairage(ctx.env, p.serveur, p.projet, p.usage, null);
		entree = null;
		if (p.attendre) throw erreur(`l'appairage en cours a expiré sans clic « Autoriser » : relancer « ${p.relanceSans} »`, { etat: "expire" });
	}
	let nouveau = false;
	if (p.attendre) {
		if (!entree) throw erreur(`rien à attendre : aucun appairage en cours pour ${p.projet ? `le projet ${p.projet}` : "ce poste"} sur ${p.serveur} ; lancer d'abord « ${p.relanceSans} »`, { etat: "aucun" });
	} else {
		if (entree && (entree.role !== p.role || entree.poste !== p.poste)) entree = null;
		if (entree) {
			const r = await interroger(ctx, p, entree, p.relanceSans);
			if (r.etat === "livre") return { etat: "livre", livraison: r.livraison };
			if (r.etat === "expire") entree = null;
		}
		if (!entree) {
			entree = await demanderAppairage(ctx, p);
			ecrireEntreeAppairage(ctx.env, p.serveur, p.projet, p.usage, entree);
			nouveau = true;
		}
	}
	ctx.stderr(`Ouvre ${entree.url} et vérifie le code ${entree.code}`);
	if (nouveau && !p.sansNavigateur) ouvrirNavigateur(ctx, entree.url);
	if (!p.attendre && (p.sansAttendre || !ctx.terminal)) {
		// « --attendre » n'est cité que si la relance le contient (outil installer relance par --oui).
		ctx.stderr(`En attente du clic « Autoriser ». Rien d'autre n'est fait. ${/(^| )--attendre( |$)/.test(p.relance) ? "Relance avec --attendre après le clic" : "Relance après le clic"} : ${p.relance} (code valable jusqu'à ${dateLocale(entree.expire)}).`);
		return { etat: "attente", entree };
	}
	const delai = p.delai ?? (ctx.terminal ? DELAI_TERMINAL_S : DELAI_SANS_TERMINAL_S);
	ctx.stderr(`en attente du clic « Autoriser » (${delai} s au plus)…`);
	return { etat: "livre", livraison: await attendreLivraison(ctx, p, entree, delai, p.relance, p.relanceSans) };
}

// Le jeton se révoque lui-même (DELETE /api/p/<projet>/jeton). Rend vrai si le serveur l'a révoqué (204).
export async function revoquerJeton(ctx: Contexte, serveur: string, projet: string, jeton: string): Promise<boolean> {
	try { return (await appelServeur(ctx, serveur, "DELETE", `/api/p/${encodeURIComponent(projet)}/jeton`, { jeton })).status === 204; }
	catch { return false; }
}

// --- outil brancher ---------------------------------------------------------------------------------------------------
export type ResultatBrancher = { etat: "branche"; serveur: string; projet: string; role: string; nom: string; pour: { id: string; nom: string }; configuration: string; configurationCreee: boolean; fichierJetons: string };
export type AttenteBrancher = { etat: "attente"; code: string; url: string; expire: string; relance: string };
// relance, relanceSans : les commandes citées dans les messages (outil installer donne les siennes) ; sans elles, elles
// sont construites ici avec le serveur et le projet résolus (une relance « nue » perdrait --serveur et --projet).
// ecrireConfig : faux pour outil installer, qui écrit .outil.json lui-même (question O/N, --oui, BOM et CRLF gardés).
export type OptionsBrancher = { serveur?: string; projet?: string; role?: string; poste?: string; sansNavigateur?: boolean; sansAttendre?: boolean; attendre?: boolean; delai?: number;
	relance?: string; relanceSans?: string; ecrireConfig?: boolean };
const citer = (a: string) => /[\s"]/.test(a) || !a ? JSON.stringify(a) : a;
// Le cœur de « outil brancher », réutilisable (outil installer, § 3) : rend « attente » (code affiché, rien d'écrit
// d'autre que appairages.json) ou le résultat d'un branchement réussi (.outil.json écrit s'il manque, jeton enregistré).
export async function brancher(ctx: Contexte, o: OptionsBrancher): Promise<AttenteBrancher | ResultatBrancher> {
	if (o.attendre && o.sansAttendre) throw usage("--attendre ou --sans-attendre (un seul des deux)");
	const ecrireConfig = o.ecrireConfig !== false;
	const chemin = chercherConfig(ctx.cwd);
	const existant = chemin ? lireFichierConfig(chemin) : null;
	let serveurBrut = o.serveur ?? existant?.serveur;
	let projetBrut = o.projet ?? existant?.projet;
	// --attendre sans serveur ou sans projet connus (pas de .outil.json, options non répétées) : l'appairage en cours,
	// s'il n'y en a qu'un qui convient. Il passe AVANT installation.json, qui peut désigner un autre serveur (serveur
	// temporaire donné par --serveur au premier temps, sur un poste qui a l'installation locale). Les appairages encore
	// valables d'abord ; à défaut, un expiré (pour le dire), seulement sans installation locale.
	let reprise = false;
	if (o.attendre && (!serveurBrut || !projetBrut)) {
		const sv = serveurBrut ? normaliserServeur(serveurBrut) : null, pj = projetBrut;
		const inst = sv ? null : serveurInstallation(ctx.env);
		const tous = parmiCeDepot(appairagesEnCours(ctx.env, "permanent").filter(c => (!sv || c.serveur === sv) && (!pj || c.projet === pj)), ctx.cwd);
		const valables = tous.filter(c => c.valable);
		let l = valables.length || sv || inst ? valables : tous;
		// Plusieurs : ceux du serveur de l'installation locale, s'il y en a un (comportement d'avant).
		if (l.length > 1 && inst) l = l.filter(c => c.serveur === inst.serveur).length === 1 ? l.filter(c => c.serveur === inst.serveur) : [];
		if (l.length === 1) { serveurBrut = l[0].serveur; projetBrut = l[0].projet ?? undefined; reprise = true; }
		else if (l.length > 1 && !sv) throw usage(`plusieurs appairages en cours (${l.map(c => `${c.projet ?? "projet à choisir"} sur ${c.serveur}`).join(" ; ")}) : préciser --serveur et --projet`);
	}
	const installation = !serveurBrut ? serveurInstallation(ctx.env) : null;
	serveurBrut ??= installation?.serveur;
	if (!serveurBrut) throw usage(`aucun serveur : --serveur URL, ou un ${FICHIER_CONFIG} avec « serveur », ou l'installation locale (${fichierInstallation(ctx.env) || "installation.json"} introuvable)`);
	const serveur = normaliserServeur(serveurBrut);
	const projet = projetBrut ?? null;
	if (projet !== null && !ID_PROJET.test(projet)) throw usage("--projet : [a-z0-9-]{1,40}");
	if (existant && ((existant.serveur && normaliserServeur(existant.serveur) !== serveur) || (existant.projet && existant.projet !== projet)))
		throw usage(MESSAGE_AUTRE_PROJET(chemin!, existant.projet, existant.serveur));
	const role = (o.role ?? "agent") as RoleAppairage;
	if (!(ROLES_APPAIRAGE as readonly string[]).includes(role)) throw usage("--role : agent ou mainteneur");
	const poste = o.poste !== undefined ? validerPoste(o.poste) : posteParDefaut();
	// .outil.json à écrire (créé ou complété) : jamais par un lien ou une jonction, refusé avant tout appairage.
	const configuration = chemin ?? path.join(ctx.cwd, FICHIER_CONFIG);
	const aEcrire = ecrireConfig && (!chemin || !existant!.projet || !existant!.serveur);
	if (aEcrire) { try { if (fs.lstatSync(configuration).isSymbolicLink()) throw erreur(MESSAGE_LIEN(configuration)); } catch (e) { if (e instanceof ErreurCli) throw e; } }
	// jetons.json illisible : vu AVANT l'appairage (sinon le jeton serait créé à la livraison sans pouvoir être gardé).
	const fichier = fichierJetons(ctx.env);
	lireJetons(fichier);
	const relanceSans = o.relanceSans ?? ["outil brancher", "--serveur", serveur, ...(projet ? ["--projet", projet] : []), ...(o.role ? ["--role", role] : []), ...(o.poste !== undefined ? ["--poste", citer(poste)] : [])].join(" ");
	const relance = o.relance ?? relanceSans.replace(/^outil brancher/, "outil brancher --attendre");
	const source = o.serveur ? "" : existant?.serveur ? ` (lus dans ${chemin})` : installation ? ` (serveur de l'installation locale, ${installation.fichier})` : reprise ? " (appairage en cours)" : "";
	// Toujours dire, AVANT tout envoi, à quel serveur on s'adresse (un .outil.json d'un dépôt cloné peut désigner
	// n'importe quel serveur).
	ctx.stderr(`appairage de ce poste (« ${poste} », rôle ${role}) avec ${serveur}, ${projet ? `projet ${projet}` : "projet choisi dans le navigateur"}${source}`);
	const issue = await obtenirJeton(ctx, { serveur, projet, role, usage: "permanent", poste, attendre: !!o.attendre, sansAttendre: !!o.sansAttendre, delai: o.delai, sansNavigateur: !!o.sansNavigateur,
		relance, relanceSans });
	if (issue.etat === "attente") return { etat: "attente", code: issue.entree.code, url: issue.entree.url, expire: issue.entree.expire, relance };
	const l = issue.livraison;
	// Jeton reçu mais pas gardé (projet différent, écriture impossible) : il est révoqué, sinon il resterait valable sur
	// le serveur sans que personne ne le tienne.
	const abandonner = async (message: string, details: Record<string, unknown> = {}) => {
		const ok = await revoquerJeton(ctx, serveur, l.projet, l.jeton);
		throw erreur(`${message} Rien n'est enregistré ; ${ok ? "le jeton reçu a été révoqué" : "le jeton reçu n'a pas pu être révoqué : le révoquer dans la vue Membres"}.`, { projetAutorise: l.projet, jetonRevoque: ok, ...details });
	};
	if (existant?.projet && existant.projet !== l.projet) await abandonner(MESSAGE_AUTRE_PROJET(chemin!, existant.projet, existant.serveur ?? serveur) + ` (projet autorisé dans le navigateur : ${l.projet}).`);
	if (projet && projet !== l.projet) await abandonner(`le projet autorisé dans le navigateur (${l.projet}) n'est pas celui demandé (${projet}) : relancer et choisir ${projet} (« ${relanceSans} »).`);
	let cree = false;
	const ancien = lireJetons(fichier)[serveur]?.[l.projet];
	try {
		// Le jeton d'abord : un .outil.json écrit sans jeton gardé laisserait un dépôt à moitié branché.
		enregistrerJeton(fichier, serveur, l.projet, l.jeton);
		if (aEcrire && !chemin) {
			fs.writeFileSync(configuration, JSON.stringify({ serveur, projet: l.projet }, null, 2) + "\n", { flag: "wx" });
			cree = true;
		} else if (aEcrire) {
			// .outil.json sans projet (ou sans serveur) : complété, ses autres clés gardées, BOM et fins de ligne aussi.
			const texte = fs.readFileSync(configuration, "utf8");
			const json = JSON.stringify({ ...existant!.brut, serveur: existant!.serveur ?? serveur, projet: l.projet }, null, 2) + "\n";
			fs.writeFileSync(configuration, (texte.startsWith("﻿") ? "﻿" : "") + (/\r\n/.test(texte) ? json.replace(/\n/g, "\r\n") : json));
		}
	} catch (e) {
		// Écriture impossible : le jeton reçu est retiré de jetons.json s'il y est entré, et révoqué.
		try {
			const tous = lireJetons(fichier);
			if (tous[serveur]?.[l.projet] === l.jeton) { if (typeof ancien === "string") tous[serveur][l.projet] = ancien; else delete tous[serveur][l.projet]; ecrireFichierUtilisateur(fichier, tous); }
		} catch { }
		await abandonner(`jeton reçu mais pas enregistré (${coupe(e instanceof Error ? e.message : String(e), 200)}).`);
	}
	return { etat: "branche", serveur, projet: l.projet, role: l.role, nom: l.nom, pour: l.pour, configuration, configurationCreee: cree, fichierJetons: fichier };
}

export const COMMANDES_APPAIRAGE: Commande[] = [
	{
		nom: "brancher", usage: "outil brancher [--serveur URL] [--projet P] [--role agent|mainteneur] [--poste NOM] [--sans-navigateur] [--sans-attendre | --attendre] [--delai S] [--json]",
		resume: "branche ce poste sur le serveur sans recopier de jeton : affiche un code, ouvre le navigateur ; un clic « Autoriser » d'un membre du projet, et le jeton est enregistré",
		detail: "Serveur : --serveur, sinon .outil.json, sinon l'installation locale (installation.json de l'installeur). Projet : --projet, sinon .outil.json, sinon celui choisi dans le navigateur. " +
			"Avant tout envoi, le serveur et le projet visés sont écrits sur stderr, puis « Ouvre <serveur>/appairage?code=XXXX-XXXX et vérifie le code XXXX-XXXX ». " +
			"Dans un terminal, la commande attend le clic (--delai, 600 s par défaut). Sans terminal (agent), ou avec --sans-attendre, elle sort tout de suite (code 0, etat « attente ») : " +
			"montrer le code à l'humain, attendre qu'il dise avoir cliqué, puis relancer « outil brancher --attendre » (90 s par défaut sans terminal ; relançable tant que le code vaut, 10 min). " +
			"Succès : .outil.json écrit s'il manque (sans jeton), jeton enregistré comme par « outil connexion ». Refus dans le navigateur : 4. Expiration ou délai dépassé : 1. " +
			"Le jeton n'est jamais affiché ; ne jamais le chercher ni le lire. --role mainteneur : seulement si un mainteneur doit l'autoriser (import). Sans navigateur sur ce poste : « outil connexion ».",
		exemple: "outil brancher --serveur http://127.0.0.1:8080 --projet jardin\n  outil brancher --attendre",
		options: { serveur: "valeur", projet: "valeur", role: "valeur", poste: "valeur", "sans-navigateur": "drapeau", "sans-attendre": "drapeau", attendre: "drapeau", delai: "valeur" }, positionnels: [0, 0], refuseeSousVeille: () => true,
		faire: async (ctx, _pos, opt) => {
			const r = await brancher(ctx, {
				serveur: opt.serveur as string | undefined, projet: opt.projet as string | undefined, role: opt.role as string | undefined, poste: opt.poste as string | undefined,
				sansNavigateur: !!opt["sans-navigateur"], sansAttendre: !!opt["sans-attendre"], attendre: !!opt.attendre,
				delai: opt.delai !== undefined ? secondesOption(opt.delai, "delai", 3600) : undefined,
			});
			if (r.etat === "attente") {
				emettre(ctx, r, [`code ${r.code} : en attente du clic « Autoriser » sur ${r.url} (valable jusqu'à ${dateLocale(r.expire)}).`,
					"Rien d'autre n'est fait. Montre ce code à l'humain ; après son clic, relance : " + r.relance]);
				return CODES.ok;
			}
			emettre(ctx, r, [`branché : ${r.projet} sur ${r.serveur}, jeton « ${r.nom} » (rôle ${r.role}${r.pour.nom ? `, pour ${r.pour.nom}` : ""})`,
				`configuration : ${r.configuration}${r.configurationCreee ? " (créée, à commiter)" : ""}`, `jeton enregistré dans ${r.fichierJetons}`]);
			return CODES.ok;
		},
	},
];
