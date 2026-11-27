// Dépôt Git de design d'un projet : un fichier par retour (retours/<id>.json), le serveur seul écrivain sur main.
// - Git par sa ligne de commande (execFile, jamais de shell), isolé de la configuration de la machine : ni config
//   système ni globale (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL vers un fichier du serveur), Git ne remonte pas
//   au-dessus de projets/ (GIT_CEILING_DIRECTORIES), auteur et committer toujours explicites.
// - Une file d'attente par projet sérialise toutes les écritures : valider → écrire → git add → git commit → index.
//   Le commit ne prend que les chemins de l'écriture (git commit -- <chemins>) : un reste indexé par une écriture
//   ratée n'est jamais emporté par la suivante.
// - Étape 3 : même chose pour tickets/T-<n>.md, tickets/.dernier et site.json (appliquerTout : un seul commit pour
//   des retours, des tickets et les réglages, tout ou rien).
// - Si Git échoue, les fichiers sont restaurés (reset --hard + clean de retours/ et tickets/ seulement : des notes
//   peuvent être déposées à la main dans notes/, jamais effacées) et l'index relu depuis le dépôt ; si la restauration échoue elle
//   aussi (verrou tenu), le dépôt est marqué « sale » : la restauration est retentée avant l'écriture suivante,
//   refusée (503) tant qu'elle ne passe pas. Si Git échoue APRÈS le commit (HEAD a bougé), l'écriture est gardée.
// - Au chargement, des restes non commités dans retours/, tickets/ ou site.json sont remis au dernier commit, ces chemins
//   seulement (restaurerChemins) : une note modifiée à la main n'est pas touchée.
// - Un verrou de Git (.git/index.lock, refs/…/*.lock) tenu brièvement par un git lancé de l'extérieur (IDE, humain
//   qui lit le dépôt) : la commande est relancée quelques fois avant d'échouer. Au démarrage, aucun git du serveur ne
//   tourne : les verrous restés d'un arrêt brutal sont supprimés (supprimerVerrous, appelé par principal.ts).
// - L'index en mémoire est un cache : au démarrage il est relu depuis les fichiers du dernier commit.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FICHIER_TICKET, analyser, serialiser, cheminTicket, numero } from "./ticket-fichier.ts";
import type { DocTicket } from "./ticket-fichier.ts";

export type Donnees = Record<string, unknown>;
export type Doc = { version: number; donnees: Donnees };
// Une écriture : le nouveau document (version comprise), ou null pour une suppression.
export type Ecriture = { id: string; doc: Doc | null };
export type Auteur = { nom: string; email: string };
// Étape 3 : un ticket lu (version et données), ou illisible (listé, toute écriture refusée jusqu'à correction).
export type EntreeTicket = DocTicket | { illisible: true; erreur: string };
export const estIllisible = (e: EntreeTicket | undefined): e is { illisible: true; erreur: string } => !!e && "illisible" in e;
// Une écriture générale, en un seul commit : retours, tickets (null = suppression), tickets/.dernier, site.json.
export type Changement = { retours?: Ecriture[]; tickets?: { id: string; doc: DocTicket | null }[]; dernier?: number; site?: Donnees };

// Ids de retour : le serveur en génère de 20 caractères ; sont acceptés (API, API de test, fichiers relus) ceux
// de 1 à 40 caractères [A-Za-z0-9] : aucune forme ne peut sortir de retours/ (ni point, ni barre, ni deux-points).
export const ID_RETOUR = /^[A-Za-z0-9]{1,40}$/;
export const ID_PROJET = /^[a-z0-9-]{1,40}$/;
// Noms de périphérique réservés par Windows : refusés à la création d'un projet (le dossier ne pourrait pas exister).
export const RESERVE_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export const COMMITTER: Auteur = { nom: "WDD serveur", email: "serveur@wdd.invalid" };

export class ErreurGit extends Error { }

// Sortie d'erreur de Git quand un verrou est pris (« Unable to create '…/index.lock': File exists », « cannot lock ref »).
const VERROU = /Unable to create '[^']*\.lock'|cannot lock ref/i;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
// Attributs du dépôt de design : un git lancé hors du serveur (autocrlf=true de Git for Windows) garde les JSON en LF.
const GITATTRIBUTES = "*.json text eol=lf\n*.md text eol=lf\n.dernier text eol=lf\n";

// File d'attente : chaque tâche commence quand la précédente est finie (réussie ou non).
export class File {
	fin: Promise<unknown> = Promise.resolve();
	executer<T>(tache: () => Promise<T>): Promise<T> {
		const p = this.fin.then(tache, tache);
		this.fin = p.catch(() => { });
		return p;
	}
}

// JSON trié par clés, indenté, LF : des diffs lisibles.
export function jsonTrie(o: unknown): string {
	const trier = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(trier);
		if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, trier((v as Donnees)[k])]));
		return v;
	};
	return JSON.stringify(trier(o), null, 2) + "\n";
}

// Une ligne de message ou un nom d'auteur : ni retour à la ligne, ni caractère de contrôle, ni < > (Git les refuse).
export const ligne = (s: unknown, max = 80): string => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export class Depot {
	projet: string;
	dossier: string;            // .../projets/<projet>/depot
	envGit: NodeJS.ProcessEnv;
	index = new Map<string, Doc>();
	// Étape 3 : tickets (tickets/T-<n>.md), plus grand numéro attribué (tickets/.dernier et fichiers présents),
	// réglages (site.json ; null s'il est illisible, l'erreur dans siteErreur).
	tickets = new Map<string, EntreeTicket>();
	dernier = 0;
	site: Donnees | null = {};
	siteErreur = "";
	rev = "";
	file = new File();
	sale = false;               // une restauration a échoué : à refaire avant la prochaine écriture
	relances = 5;               // nouvelles tentatives d'une commande Git qui bute sur un verrou
	pauseRelanceMs = 150;       // pause entre deux tentatives (de 1 à 2 fois cette valeur)
	journal: (m: string) => void;
	constructor(projet: string, racineProjets: string, configGit: string, journal: (m: string) => void = () => { }) {
		this.journal = journal;
		if (!ID_PROJET.test(projet)) throw new Error("id de projet invalide");
		this.projet = projet;
		this.dossier = path.join(racineProjets, projet, "depot");
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const k of Object.keys(env)) if (/^GIT_/.test(k)) delete env[k];
		Object.assign(env, {
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: configGit, GIT_CEILING_DIRECTORIES: racineProjets,
			GIT_TERMINAL_PROMPT: "0", GIT_COMMITTER_NAME: COMMITTER.nom, GIT_COMMITTER_EMAIL: COMMITTER.email, LC_ALL: "C",
		});
		this.envGit = env;
	}

	// Une commande Git, relancée quelques fois si un verrou est pris. Sans risque à cet endroit : la commande a échoué
	// avant d'agir (add, reset, commit sur index.lock), ou au pire a laissé un objet orphelin (commit sur un verrou de ref).
	async git(args: string[], auteur?: Auteur): Promise<string> {
		for (let i = 0; ; i++) {
			try { return await this.gitUneFois(args, auteur); }
			catch (e) {
				if (i >= this.relances || !(e instanceof ErreurGit) || !VERROU.test(e.message)) throw e;
				await pause(this.pauseRelanceMs * (1 + Math.random()));
			}
		}
	}
	gitUneFois(args: string[], auteur?: Auteur): Promise<string> {
		const env = auteur ? { ...this.envGit, GIT_AUTHOR_NAME: auteur.nom, GIT_AUTHOR_EMAIL: auteur.email } : this.envGit;
		return new Promise((ok, ko) => execFile("git", ["-C", this.dossier, ...args], { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60000 },
			(e, stdout, stderr) => e ? ko(new ErreurGit(`git ${args[0]} : ${String(stderr || e.message).trim()}`)) : ok(String(stdout))));
	}

	cheminRetour(id: string): string {
		if (!ID_RETOUR.test(id)) throw new Error("id de retour invalide");
		return path.join(this.dossier, "retours", id + ".json");
	}

	// Crée le dépôt (branche main) avec un premier commit : site.json, .gitattributes et les dossiers retours/ et notes/.
	async creer(titre: string, auteur: Auteur): Promise<void> {
		if (fs.existsSync(path.join(this.dossier, ".git"))) throw new Error("le dépôt existe déjà");
		fs.mkdirSync(path.join(this.dossier, "retours"), { recursive: true });
		fs.mkdirSync(path.join(this.dossier, "notes"), { recursive: true });
		await this.git(["init", "-q", "-b", "main"]);
		await this.configurerLocal();
		fs.writeFileSync(path.join(this.dossier, ".gitattributes"), GITATTRIBUTES);
		fs.writeFileSync(path.join(this.dossier, "site.json"), jsonTrie({ titre }));
		fs.writeFileSync(path.join(this.dossier, "retours", ".gitkeep"), "");
		fs.writeFileSync(path.join(this.dossier, "notes", ".gitkeep"), "");
		await this.git(["add", "-A"]);
		await this.git(["commit", "-q", "-m", `projet ${this.projet} : création`, "-m", `Par: ${ligne(auteur.nom, 60)}`], auteur);
		await this.charger();
	}

	// Relit l'index depuis le dépôt (qui fait foi). Les restes d'une écriture interrompue (fichiers non commités dans
	// retours/, tickets/, site.json) sont d'abord effacés : seul le dernier commit compte (une correction à la main se fait
	// par un commit, serveur arrêté).
	async charger(): Promise<void> {
		if (!fs.existsSync(path.join(this.dossier, ".git"))) throw new Error(`dépôt absent : ${this.dossier}`);
		const sale = (await this.git(["status", "--porcelain", "--", "retours", "tickets", "site.json"])).trim();
		if (sale) {
			this.journal(`projet ${this.projet} : fichiers non commités remis au dernier commit (${sale.split("\n").map(l => l.slice(3)).join(", ").slice(0, 300)})`);
			// Ces chemins seulement : une note modifiée à la main dans notes/ (même suivie) n'est pas touchée.
			await this.restaurerChemins();
		}
		this.rev = (await this.git(["rev-parse", "HEAD"])).trim();
		const index = new Map<string, Doc>();
		const dir = path.join(this.dossier, "retours");
		for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			const m = f.match(/^([A-Za-z0-9]{1,40})\.json$/);
			if (!m) continue;
			try {
				const o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
				if (!o || typeof o !== "object" || Array.isArray(o)) continue;
				const version = Number.isInteger(o.version) && o.version > 0 ? o.version : 1;
				delete o.version;
				index.set(m[1], { version, donnees: o });
			} catch { /* fichier illisible : ignoré (il reste dans Git) */ }
		}
		this.index = index;
		const dernierLu = this.chargerTickets();
		// .dernier absent ou illisible (supprimé ou abîmé à la main) : le plus grand numéro jamais créé est aussi cherché
		// dans l'historique, pour ne jamais réutiliser le numéro d'un ticket supprimé (§ 1.1).
		if (!dernierLu) {
			let max = 0;
			try {
				for (const l of (await this.git(["log", "--format=", "--name-only", "--diff-filter=A", "--", "tickets"])).split("\n")) {
					const m = l.trim().match(/^tickets\/T-([1-9]\d{0,8})\.md$/);
					if (m) max = Math.max(max, Number(m[1]));
				}
			} catch { /* historique illisible : on garde les fichiers présents */ }
			if (max > this.dernier) {
				this.journal(`projet ${this.projet} : tickets/.dernier absent ou illisible ; numérotation reprise de l'historique (T-${max})`);
				this.dernier = max;
			}
		}
		this.chargerSite();
	}

	// Tickets : chaque tickets/T-<n>.md lu strictement ; un fichier illisible est gardé comme tel (listé, écritures
	// refusées). Plus grand numéro attribué : tickets/.dernier, ou plus grand si des fichiers vont au-delà.
	// Rend vrai si tickets/.dernier a été lu ; faux s'il manque ou ne contient pas un entier de 1 à 9 chiffres (« 1e20 »
	// est refusé : l'id T-<n> n'a que 9 chiffres au plus).
	chargerTickets(): boolean {
		const tickets = new Map<string, EntreeTicket>();
		const dir = path.join(this.dossier, "tickets");
		let dernier = 0;
		for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			if (!FICHIER_TICKET.test(f)) continue;
			const id = f.slice(0, -3);
			dernier = Math.max(dernier, numero(id));
			try { tickets.set(id, analyser(fs.readFileSync(path.join(dir, f), "utf8"), id)); }
			catch (e) {
				const erreur = String((e as Error)?.message || e).slice(0, 300);
				tickets.set(id, { illisible: true, erreur });
				this.journal(`ERREUR projet ${this.projet} : ticket ${id} illisible (${erreur}) ; écritures refusées jusqu'à correction`);
			}
		}
		let lu = false;
		try {
			const brut = fs.readFileSync(path.join(dir, ".dernier"), "utf8").trim();
			if (/^\d{1,9}$/.test(brut)) {
				lu = true;
				dernier = Math.max(dernier, Number(brut));
			} else this.journal(`ERREUR projet ${this.projet} : tickets/.dernier illisible (${JSON.stringify(brut.slice(0, 30))}), ignoré`);
		} catch { /* absent : aucun ticket encore, ou supprimé à la main */ }
		this.tickets = tickets;
		this.dernier = dernier;
		return lu;
	}

	// site.json : réglages (titre, disciplines, url_commit). Illisible : site = null (réglages refusés en écriture).
	chargerSite(): void {
		const p = path.join(this.dossier, "site.json");
		this.site = {}; this.siteErreur = "";
		if (!fs.existsSync(p)) return;
		try {
			const o = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
			if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("objet JSON attendu");
			this.site = o;
		} catch (e) {
			this.site = null; this.siteErreur = String((e as Error)?.message || e).slice(0, 200);
			this.journal(`ERREUR projet ${this.projet} : site.json illisible (${this.siteErreur})`);
		}
	}

	// Config locale du dépôt. L'isolement du serveur (GIT_CONFIG_*) ne vaut que pour ses propres commandes : un git
	// lancé de l'extérieur dans ce dépôt (humain, agent, futur CLI) prendrait la config de la machine (autocrlf=true de
	// Git for Windows, identité de l'utilisateur). Appelé à la création et au démarrage (dépôts créés avant).
	async configurerLocal(): Promise<void> {
		for (const [k, v] of [["core.autocrlf", "false"], ["core.safecrlf", "false"], ["user.name", COMMITTER.nom], ["user.email", COMMITTER.email]]) {
			const actuel = await this.git(["config", "--local", "--get", k]).then(s => s.trim(), () => "");
			if (actuel !== v) await this.git(["config", "--local", k, v]);
		}
	}

	// Au démarrage seulement (aucun git du serveur ne tourne encore) : supprime les verrous restés d'un arrêt brutal
	// (.git/index.lock, HEAD.lock, packed-refs.lock, config.lock, refs/**/*.lock). Jamais en marche : un verrou peut
	// alors être celui d'un git légitime lancé de l'extérieur. Rend les chemins supprimés (relatifs à .git).
	supprimerVerrous(): string[] {
		const gitDir = path.join(this.dossier, ".git"), faits: string[] = [];
		const ote = (p: string) => { try { fs.rmSync(p, { force: true }); faits.push(path.relative(gitDir, p).split(path.sep).join("/")); } catch { } };
		for (const f of ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock"]) if (fs.existsSync(path.join(gitDir, f))) ote(path.join(gitDir, f));
		const parcourir = (d: string) => {
			let ents: fs.Dirent[] = [];
			try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
			for (const e of ents) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) parcourir(p);
				else if (e.name.endsWith(".lock")) ote(p);
			}
		};
		parcourir(path.join(gitDir, "refs"));
		return faits;
	}

	// Remet l'arbre de travail et l'index de Git au dernier commit. clean est lancé même si reset échoue (avec un
	// verrou de ref, reset restaure l'arbre puis sort en erreur). En cas d'échec, le dépôt reste marqué « sale ».
	// Au chargement : remet au dernier commit retours/, tickets/ et site.json SEULEMENT (index et arbre), sans toucher au
	// reste du dépôt (notes/ modifiées à la main, fichiers indexés de l'extérieur). Un chemin absent de HEAD et de l'index
	// (tickets/ d'un dépôt d'avant l'étape 3) ne gêne pas : reset et ls-files l'acceptent. Échec : dépôt « sale ».
	async restaurerChemins(): Promise<void> {
		const chemins = ["retours", "tickets", "site.json"];
		let erreur: unknown = null;
		try {
			await this.git(["reset", "-q", "--", ...chemins]);
			const fichiers = [...new Set((await this.git(["ls-files", "-z", "-m", "-d", "--", ...chemins])).split("\0").filter(Boolean))];
			for (let i = 0; i < fichiers.length; i += 200) await this.git(["checkout", "-q", "--", ...fichiers.slice(i, i + 200)]);
		} catch (e) { erreur = e; }
		try { await this.git(["clean", "-fdq", "--", "retours", "tickets"]); } catch (e) { erreur ??= e; }
		if (erreur) { this.sale = true; throw erreur; }
		this.sale = false;
	}

	async restaurer(): Promise<void> {
		let erreur: unknown = null;
		try { await this.git(["reset", "-q", "--hard", "HEAD"]); } catch (e) { erreur = e; }
		try { await this.git(["clean", "-fdq", "--", "retours", "tickets"]); } catch (e) { erreur ??= e; }
		if (erreur) { this.sale = true; throw erreur; }
		this.sale = false;
	}

	// Dans la file, avant toute écriture : si une restauration a échoué, la refaire et relire l'index ; tant qu'elle ne
	// passe pas, l'écriture est refusée (ErreurGit, donc 503).
	async assainir(): Promise<void> {
		if (!this.sale) return;
		try { await this.restaurer(); await this.charger(); this.journal(`projet ${this.projet} : dépôt restauré`); }
		catch (e) {
			const err = e instanceof ErreurGit ? e : new ErreurGit(String((e as Error)?.message || e));
			this.journal(`projet ${this.projet} : dépôt toujours à restaurer, écriture refusée (${err.message})`);
			throw err;
		}
	}

	// Id déjà pris à la casse près (« casse » et « CASSE ») : sur un système de fichiers qui ne distingue pas la casse
	// (Windows, macOS), les deux partageraient le même fichier. Rend l'id existant, ou undefined.
	homonyme(id: string): string | undefined {
		if (this.index.has(id)) return undefined;
		const bas = id.toLowerCase();
		for (const k of this.index.keys()) if (k.toLowerCase() === bas) return k;
		return undefined;
	}

	// Écrit les fichiers, les commite en un seul commit, puis met l'index à jour. À appeler DANS la file du projet,
	// après validation complète. Rend le nouveau rev. En cas d'échec : fichiers restaurés, index relu, ErreurGit.
	appliquer(ecritures: Ecriture[], auteur: Auteur, sujet: string): Promise<string> {
		return this.appliquerTout({ retours: ecritures }, auteur, sujet);
	}

	// Écriture générale (retours, tickets, tickets/.dernier, site.json) : un seul commit limité à ses chemins, tout ou
	// rien. Sur échec, l'arbre est restauré et l'état en mémoire ne bouge pas.
	async appliquerTout(ch: Changement, auteur: Auteur, sujet: string): Promise<string> {
		const chemins: string[] = [];
		await this.assainir();
		const revAvant = this.rev;
		let commite = false;        // le commit a réussi (HEAD a bougé) ; une erreur ensuite ne l'annule pas
		try {
			const ecrire = (rel: string, contenu: string | null) => {
				const p = path.join(this.dossier, ...rel.split("/"));
				chemins.push(rel);
				// tickets/ manque dans un dépôt créé avant l'étape 3 : créé à la première écriture, sans commit à part.
				if (contenu !== null) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, contenu); }
				else if (fs.existsSync(p)) fs.unlinkSync(p);
			};
			for (const e of ch.retours || []) {
				const p = this.cheminRetour(e.id);
				ecrire(path.relative(this.dossier, p).split(path.sep).join("/"), e.doc ? jsonTrie({ ...e.doc.donnees, version: e.doc.version }) : null);
			}
			for (const t of ch.tickets || []) ecrire(cheminTicket(t.id), t.doc ? serialiser(t.doc) : null);
			if (ch.dernier !== undefined) ecrire("tickets/.dernier", `${ch.dernier}\n`);
			if (ch.site !== undefined) ecrire("site.json", jsonTrie(ch.site));
			const message = ["-m", ligne(sujet, 200), "-m", `Par: ${ligne(auteur.nom, 60)}`];
			if (chemins.length) {
				await this.git(["add", "-A", "--", ...chemins]);
				// Ces chemins seulement (forme --only) : rien d'autre d'indexé n'entre dans ce commit.
				await this.git(["commit", "-q", ...message, "--", ...chemins], auteur);
			} else await this.git(["commit", "-q", "--allow-empty", ...message], auteur);
			commite = true;
			this.rev = (await this.git(["rev-parse", "HEAD"])).trim();
		} catch (e) {
			const err = e instanceof ErreurGit ? e : new ErreurGit(String((e as Error)?.message || e));
			this.journal(`projet ${this.projet} : écriture refusée (${err.message})`);
			try { await this.restaurer(); }
			catch (r) { this.journal(`projet ${this.projet} : restauration impossible, retentée avant la prochaine écriture (${(r as Error)?.message || r})`); }
			// L'index en mémoire n'a pas bougé (mis à jour seulement après le commit) : il reste égal à HEAD.
			if (!this.sale) { try { await this.charger(); } catch { } }
			// Git a échoué APRÈS le commit (rev-parse, par exemple) : HEAD a bougé, l'écriture est faite. charger() vient de
			// tout relire depuis ce commit : on rend le succès, pour que l'appelant diffuse et réponde 200 (sinon le client
			// verrait 503, réessaierait et recevrait 409, et le flux resterait périmé). « commite » est exigé : this.rev peut
			// être en retard sur HEAD (notes, commit extérieur), et charger() le remet à jour même quand CE commit a échoué.
			if (commite && !this.sale && this.rev && this.rev !== revAvant) {
				this.journal(`projet ${this.projet} : le commit était fait malgré l'erreur ; écriture gardée (${this.rev.slice(0, 7)})`);
				return this.rev;
			}
			throw err;
		}
		for (const e of ch.retours || []) {
			if (e.doc) this.index.set(e.id, e.doc);
			else this.index.delete(e.id);
		}
		for (const t of ch.tickets || []) {
			if (t.doc) this.tickets.set(t.id, t.doc);
			else this.tickets.delete(t.id);
		}
		if (ch.dernier !== undefined) this.dernier = Math.max(this.dernier, ch.dernier);
		if (ch.site !== undefined) { this.site = ch.site; this.siteErreur = ""; }
		return this.rev;
	}

	// Instantané pour l'API et le flux : { docs: [{ id, version, donnees }], rev }, trié par id.
	instantane(filtre?: (d: Doc) => boolean): { docs: { id: string; version: number; donnees: Donnees }[]; rev: string } {
		const docs = [...this.index.entries()].filter(([, d]) => !filtre || filtre(d)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([id, d]) => ({ id, version: d.version, donnees: d.donnees }));
		return { docs, rev: this.rev };
	}

	// Tickets pour l'API et le flux : { docs: [{ id, version, donnees }], rev }, triés par numéro ; un ticket illisible
	// est listé { id, illisible: true, erreur } (sauf illisibles: false).
	instantaneTickets(filtre?: (d: DocTicket) => boolean, illisibles = true): { docs: ({ id: string; version: number; donnees: unknown } | { id: string; illisible: true; erreur: string })[]; rev: string } {
		const docs = [...this.tickets.entries()].sort(([a], [b]) => numero(a) - numero(b))
			.filter(([, t]) => estIllisible(t) ? illisibles : !filtre || filtre(t))
			.map(([id, t]) => estIllisible(t) ? { id, illisible: true as const, erreur: t.erreur } : { id, version: t.version, donnees: t.donnees });
		return { docs, rev: this.rev };
	}
}
