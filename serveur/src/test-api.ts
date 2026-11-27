// API de test (/__test/*), active seulement avec WDD_TEST=1 (404 sinon) : rejouer les scénarios de régression de
// site/tests/scenarios.js contre le vrai serveur (docs/etape1-serveur.md § 4.4).
// Modes simulés, par projet (réglés par POST /__test/mode, « normal » par défaut) :
//   readonly    session « ecriture: false », écritures refusées (403)
//   denywrite   session « ecriture: null », écritures refusées (403 permission_denied)
//   quota       écritures refusées en 507 (quota_exceeded)
//   unavailable écritures refusées en 503 (unavailable)
//   revoked     chaque flux est coupé ~50 ms après son premier instantané ; dès qu'un flux a été coupé, toute
//               requête /api/p/<projet>/* répond 401 (revoked), jusqu'au prochain /__test/mode. Changer de mode
//               pour revoked coupe aussi les flux déjà ouverts.
//   silent      GET /retours et le flux ne répondent jamais (requêtes gardées ouvertes)
//   snapretry   le premier flux ouvert après le réglage du mode est refusé (503), les suivants marchent
//
// Routes (corps JSON, Content-Type application/json ; en-tête X-WDD: 1 exigé sur tout POST, même sans cookie, pour
// qu'une page d'un autre site ne puisse pas piloter un serveur de test ; WDD_TEST=1 refusé hors adresse de bouclage) :
//   POST /__test/projet {id, titre}                       crée le projet s'il n'existe pas
//   POST /__test/session {projet, compte, nom?, role}     compte d'id choisi (ex. « essai »), rôle, cookie de session
//   GET  /__test/connexion?projet=&compte=&role=&nom=&suite=   idem par une navigation (pose le cookie, puis 303
//                                                         vers suite, /p/<projet>/ par défaut) : pour Edge sans fenêtre
//   GET  /__test/retours?projet=<p>                       instantané, sans effet des modes (équivalent de T.docs)
//   POST /__test/reinitialiser {projet}                   vide les retours (un commit) et diffuse
//   POST /__test/mettre {projet, id, donnees}             équivalent de T.put : écrit tel quel, version +1, commit, diffusion
//   POST /__test/ecrire {projet, id, champs}              équivalent de T.writeServer : fusion, version +1, commit, diffusion
//   POST /__test/supprimer {projet, id, diffuser}         suppression, commit ; diffusion sauf diffuser: false
//   POST /__test/diffuser {projet}                        rediffuse l'instantané courant (équivalent de T.emit)
//   POST /__test/notes {projet, nom, notes}               écrit notes/<nom> (notes_*.json) dans le dépôt, un commit, SANS
//                                                         valider (l'API PUT /api/p/<projet>/notes/<nom> valide, étape 2)
//   POST /__test/mode {projet, mode}                      mode simulé (ci-dessus)
// Étape 3 (scénarios de la méta-interface) :
//   POST /__test/preparer {projet, titre?, retours?, comptes?, invitations?, jetons?}
//        crée le projet s'il manque, puis, dans l'ordre : retours de départ (un seul commit ; chaque entrée
//        { id?, donnees } est complétée par un document valide par défaut), comptes ({ id, nom?, role } : rôle sur le
//        projet ou admin, session rendue), invitations ({ role, expire? } : lien rendu), jetons ({ nom, role?, pour? } :
//        pour = id d'un compte, propriétaire). Rend les ids, sessions, liens et jetons créés (banc de test seulement).
//   POST /__test/reinitialiser {projet, tickets: true}    vide aussi les tickets (tickets/.dernier gardé)
// Les ids de retour suivent la même forme que l'API ([A-Za-z0-9]{1,40}) : « zautre » des scénarios passe, « ../x » non.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Flux } from "./flux.ts";
import type { Contexte } from "./http.ts";
import type { Auteur, Doc, Donnees } from "./depot.ts";
import { ErreurApi, invalide, absent, indisponible, validerChamp, CHAMPS } from "./retours.ts";
import { ID_RETOUR, ID_PROJET, ligne } from "./depot.ts";
import { json, lireJson, creerProjet } from "./http.ts";
import { cookieSession, validerNom } from "./auth.ts";
import { commiterNotes } from "./notes.ts";
import { idAleatoire, ROLES_JETON } from "./base.ts";
import type { RoleJeton } from "./base.ts";
import { validerExpiration } from "./gestion.ts";

export const MODES = ["normal", "readonly", "denywrite", "quota", "unavailable", "revoked", "silent", "snapretry"] as const;
export type Mode = typeof MODES[number];
type Etat = { mode: Mode; revoque: boolean; flux: number };

export class Modes {
	etats = new Map<string, Etat>();
	retenus = new Map<ServerResponse, string>();
	flux: Flux;
	constructor(flux: Flux) { this.flux = flux; }

	etat(projet: string): Etat {
		let e = this.etats.get(projet);
		if (!e) this.etats.set(projet, e = { mode: "normal", revoque: false, flux: 0 });
		return e;
	}
	mode(projet: string): Mode { return this.etats.get(projet)?.mode ?? "normal"; }

	definir(projet: string, mode: string): void {
		if (!(MODES as readonly string[]).includes(mode)) throw new ErreurApi(400, "invalid_document", `mode inconnu : ${mode} (${MODES.join(", ")})`);
		this.liberer(projet);
		const e = this.etat(projet);
		e.mode = mode as Mode; e.revoque = false; e.flux = 0;
		if (mode === "revoked" && [...this.flux.clients].some(c => c.projet === projet)) { this.flux.couper(projet); e.revoque = true; }
	}

	// 401 pour tout le projet après une révocation simulée.
	verifierAcces(projet: string): void {
		if (this.etats.get(projet)?.revoque) throw new ErreurApi(401, "revoked", "accès révoqué (mode de test revoked)");
	}
	// Refus d'écriture simulé, ou rien.
	verifierEcriture(projet: string): void {
		switch (this.mode(projet)) {
			case "readonly": case "denywrite": throw new ErreurApi(403, "permission_denied", "écriture refusée (mode de test " + this.mode(projet) + ")");
			case "quota": throw new ErreurApi(507, "quota_exceeded", "base pleine (mode de test quota)");
			case "unavailable": throw new ErreurApi(503, "unavailable", "stockage indisponible (mode de test unavailable)");
		}
	}
	// Valeur de « ecriture » imposée à la session, ou undefined.
	ecriture(projet: string): boolean | null | undefined {
		const m = this.mode(projet);
		return m === "readonly" ? false : m === "denywrite" ? null : undefined;
	}
	// Mode silent : la requête est gardée ouverte, sans réponse. Rend vrai si elle a été retenue.
	retenir(projet: string, res: ServerResponse): boolean {
		if (this.mode(projet) !== "silent") return false;
		this.retenus.set(res, projet);
		res.on("close", () => this.retenus.delete(res));
		return true;
	}
	// Mode snapretry : le premier flux est refusé.
	refuserFlux(projet: string): boolean {
		const e = this.etat(projet);
		return e.mode === "snapretry" && ++e.flux === 1;
	}
	// Mode revoked : coupe le flux peu après son premier instantané, puis révoque le projet.
	apresOuvertureFlux(projet: string, res: ServerResponse): void {
		if (this.mode(projet) !== "revoked") return;
		const t = setTimeout(() => { const e = this.etat(projet); if (e.mode === "revoked") { e.revoque = true; res.destroy(); } }, 50);
		res.on("close", () => clearTimeout(t));
	}
	liberer(projet?: string): void {
		for (const [res, p] of [...this.retenus]) if (!projet || p === projet) { this.retenus.delete(res); res.destroy(); }
	}
}

// --- Routes -----------------------------------------------------------------------------------------------
// Compte de test d'id choisi (créé s'il manque), rôle sur le projet, nouvelle session.
function sessionTest(ctx: Contexte, projet: string, compteBrut: unknown, roleBrut: unknown, nomBrut: unknown): { compte: string; role: string; jeton: string; cookie: string } {
	const compte = String(compteBrut ?? "");
	if (!/^[A-Za-z0-9-]{1,40}$/.test(compte)) throw invalide("compte : [A-Za-z0-9-]{1,40}");
	const role = String(roleBrut ?? "contributeur");
	if (!["lecteur", "contributeur", "mainteneur", "admin"].includes(role)) throw invalide("role inconnu");
	const nom = validerNom(nomBrut ?? compte);
	if (!ctx.base.compte(compte)) ctx.base.creerCompte(compte, nom, role === "admin");
	if (role !== "admin") ctx.base.donnerRole(compte, projet, role);
	else ctx.base.db.prepare("UPDATE comptes SET admin = 1 WHERE id = ?").run(compte);
	const s = ctx.base.creerSession(compte, "programme de test");
	return { compte, role, jeton: s.jeton, cookie: cookieSession(ctx.config, s.jeton, s.maxAge) };
}
// Chemin local sûr pour une redirection : « / » suivi de caractères d'URL imprimables (ni espace ni caractère de
// contrôle, que le navigateur retire : « /\t/hote » deviendrait « //hote »), sans « // » ni « /\ » en tête, et qui
// reste sur la même origine.
export function cheminLocal(s: string): boolean {
	if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/?#-]*$/.test(s) || /^\/[\/\\]/.test(s)) return false;
	try { return new URL(s, "http://h.invalid").origin === "http://h.invalid"; } catch { return false; }
}
const AUTEUR_TEST: Auteur = { nom: "banc de test", email: "test@wdd.invalid" };
const estObjet = (v: unknown): v is Donnees => !!v && typeof v === "object" && !Array.isArray(v);

export async function traiterTest(ctx: Contexte, req: IncomingMessage, res: ServerResponse, seg: string[], m: string, params: URLSearchParams): Promise<void> {
	const route = seg.join("/");
	if (route === "retours" && m === "GET") {
		const d = ctx.depots.get(params.get("projet") || "");
		if (!d) throw absent("projet introuvable");
		return json(res, 200, d.instantane());
	}
	if (route === "connexion" && m === "GET") {
		// Pour un navigateur sans fenêtre (Edge --dump-dom ne sait pas poser de cookie) : session puis redirection.
		const projet = params.get("projet") || "";
		if (!ID_PROJET.test(projet) || !ctx.depots.has(projet)) throw absent("projet introuvable");
		const s = sessionTest(ctx, projet, params.get("compte"), params.get("role") ?? undefined, params.get("nom") ?? undefined);
		const suite = params.get("suite") || `/p/${projet}/`;
		if (!cheminLocal(suite)) throw invalide("suite : chemin local attendu (/…)");
		res.writeHead(303, { Location: suite, "Set-Cookie": s.cookie, "Cache-Control": "no-store" });
		return void res.end();
	}
	if (m !== "POST") throw absent("route de test inconnue");
	const c = await lireJson(req);
	if (!estObjet(c)) throw invalide("objet JSON attendu");
	if (route === "projet") {
		if (typeof c.id === "string" && ctx.depots.has(c.id)) return json(res, 200, { id: c.id, existe: true });
		return json(res, 201, await creerProjet(ctx, c.id, c.titre ?? c.id, AUTEUR_TEST));
	}
	if (route === "preparer") return json(res, 200, await preparer(ctx, c));
	const projet = String(c.projet ?? "");
	const depot = ID_PROJET.test(projet) ? ctx.depots.get(projet) : undefined;
	if (!depot) throw absent("projet introuvable");
	const diffuser = () => ctx.flux.diffuser(projet, depot.instantane());
	const idRetour = (): string => { if (typeof c.id !== "string" || !ID_RETOUR.test(c.id)) throw invalide("id de retour : [A-Za-z0-9]{1,40}"); return c.id; };
	const commit = (p: Promise<string>) => p.catch(indisponible);

	switch (route) {
		case "session": {
			const s = sessionTest(ctx, projet, c.compte, c.role, c.nom);
			return json(res, 200, { id: s.compte, role: s.role, session: s.jeton }, { "Set-Cookie": s.cookie });
		}
		case "notes": {
			const nom = String(c.nom ?? "");
			if (!/^notes_[A-Za-z0-9_-]{1,60}\.json$/.test(nom)) throw invalide("nom : notes_<a-z, 0-9, _ ou ->.json");
			if (!estObjet(c.notes)) throw invalide("notes : objet attendu");
			const texte = JSON.stringify(c.notes, null, 2) + "\n";
			return await depot.file.executer(async () => {
				// Sur échec : seul ce fichier de notes est retiré ; d'autres notes déposées à la main dans notes/ restent.
				await commiterNotes(depot, nom, texte, AUTEUR_TEST, `notes : ${nom} (test)`, ctx.journal).catch(indisponible);
				json(res, 200, { nom, rev: depot.rev });
			});
		}
		case "diffuser":
			diffuser();
			return json(res, 200, { projet, rev: depot.rev });
		case "mode":
			ctx.modes.definir(projet, String(c.mode ?? ""));
			return json(res, 200, { projet, mode: ctx.modes.mode(projet) });
		case "reinitialiser":
			return await depot.file.executer(async () => {
				const ids = [...depot.index.keys()];
				const tickets = c.tickets === true ? [...depot.tickets.keys()] : [];
				const rev = await commit(depot.appliquerTout({ retours: ids.map(id => ({ id, doc: null })), tickets: tickets.map(id => ({ id, doc: null })) }, AUTEUR_TEST,
					`test : réinitialisation (${ids.length} retours${tickets.length ? `, ${tickets.length} tickets` : ""})`));
				diffuser();
				if (tickets.length) ctx.flux.diffuserTickets(projet, depot.instantaneTickets());
				json(res, 200, { supprimes: ids.length, tickets_supprimes: tickets.length, rev });
			});
		case "mettre": {
			const id = idRetour();
			if (!estObjet(c.donnees)) throw invalide("donnees : objet attendu");
			const donnees = { ...c.donnees };
			delete donnees.version;
			return await depot.file.executer(async () => {
				// Sur un système de fichiers qui ne distingue pas la casse, « CASSE » écraserait le fichier de « casse ».
				const h = depot.homonyme(id);
				if (h) throw invalide(`id de retour déjà pris à la casse près : ${h}`);
				const doc: Doc = { version: (depot.index.get(id)?.version ?? 0) + 1, donnees };
				const rev = await commit(depot.appliquer([{ id, doc }], AUTEUR_TEST, `retour ${id} : mise (test) (${ligne(donnees.kind, 40)}/${ligne(donnees.ref, 60)})`));
				diffuser();
				json(res, 200, { id, version: doc.version, rev });
			});
		}
		case "ecrire": {
			const id = idRetour();
			if (!estObjet(c.champs)) throw invalide("champs : objet attendu");
			const champs = { ...c.champs };
			delete champs.version;
			return await depot.file.executer(async () => {
				const d = depot.index.get(id);
				if (!d) throw absent();
				const doc: Doc = { version: d.version + 1, donnees: { ...d.donnees, ...champs } };
				const rev = await commit(depot.appliquer([{ id, doc }], AUTEUR_TEST, `retour ${id} : écriture (test) (${ligne(doc.donnees.kind, 40)}/${ligne(doc.donnees.ref, 60)})`));
				diffuser();
				json(res, 200, { id, version: doc.version, rev });
			});
		}
		case "supprimer": {
			const id = idRetour();
			return await depot.file.executer(async () => {
				const d = depot.index.get(id);
				if (!d) throw absent();
				const rev = await commit(depot.appliquer([{ id, doc: null }], AUTEUR_TEST, `retour ${id} : suppression (test) (${ligne(d.donnees.kind, 40)}/${ligne(d.donnees.ref, 60)})`));
				if (c.diffuser !== false) diffuser();
				json(res, 200, { id, rev, diffuse: c.diffuser !== false });
			});
		}
	}
	throw absent("route de test inconnue");
}

// --- Étape 3 : préparation d'un projet pour les scénarios de la méta-interface -----------------------------------
const nouveauRetour = (extra: Donnees): Donnees => {
	const t = new Date().toISOString();
	return { kind: "element", ref: "exemple", name: "Exemple", tab: "general", anchor: "general--exemple", cat: "idee", text: "Retour de départ.", proposal: "",
		status: "nouveau", reply: "", replied: "", created: t, updated: t, by: "banc", codex: "", ...extra };
};
async function preparer(ctx: Contexte, c: Donnees) {
	const projet = String(c.projet ?? "");
	if (!ID_PROJET.test(projet)) throw invalide("projet : [a-z0-9-]{1,40}");
	if (!ctx.depots.has(projet)) await creerProjet(ctx, projet, typeof c.titre === "string" && c.titre ? c.titre : projet, AUTEUR_TEST);
	const depot = ctx.depots.get(projet)!;
	const liste = (v: unknown, quoi: string): Donnees[] => {
		if (v === undefined) return [];
		if (!Array.isArray(v) || v.some(x => !estObjet(x))) throw invalide(`${quoi} : liste d'objets attendue`);
		return v as Donnees[];
	};
	const sortie = { projet, retours: [] as { id: string; version: number }[], comptes: [] as { id: string; role: string; session: string; cookie: string }[],
		invitations: [] as { id: string; role: string; lien: string; url: string }[], jetons: [] as { id: string; nom: string; role: string; jeton: string; pour: string | null }[] };

	const retours = liste(c.retours, "retours");
	if (retours.length) {
		await depot.file.executer(async () => {
			const ecritures = retours.map((x, i) => {
				const id = x.id === undefined ? idAleatoire(20) : x.id;
				if (typeof id !== "string" || !ID_RETOUR.test(id)) throw invalide(`retours[${i}].id : [A-Za-z0-9]{1,40}`);
				if (!estObjet(x.donnees ?? {})) throw invalide(`retours[${i}].donnees : objet attendu`);
				const donnees = nouveauRetour((x.donnees ?? {}) as Donnees);
				for (const k of Object.keys(donnees)) validerChamp(k, donnees[k]);
				for (const k of CHAMPS) if (donnees[k] === undefined) throw invalide(`retours[${i}] : champ manquant ${k}`);
				if (depot.homonyme(id)) throw invalide(`retours[${i}].id déjà pris à la casse près`);
				return { id, doc: { version: (depot.index.get(id)?.version ?? 0) + 1, donnees } as Doc };
			});
			await depot.appliquer(ecritures, AUTEUR_TEST, `test : préparation (${ecritures.length} retours)`).catch(indisponible);
			ctx.flux.diffuser(projet, depot.instantane());
			for (const e of ecritures) sortie.retours.push({ id: e.id, version: e.doc.version });
		});
	}
	for (const x of liste(c.comptes, "comptes")) {
		const s = sessionTest(ctx, projet, x.id, x.role, x.nom);
		sortie.comptes.push({ id: s.compte, role: s.role, session: s.jeton, cookie: "wdd_session=" + s.jeton });
	}
	for (const x of liste(c.invitations, "invitations")) {
		const role = String(x.role ?? "contributeur");
		if (!["lecteur", "contributeur", "mainteneur"].includes(role)) throw invalide("invitations : role lecteur, contributeur ou mainteneur");
		const inv = ctx.base.nouvelleInvitation(projet, role, validerExpiration(x.expire), null);
		sortie.invitations.push({ id: inv.id, role, lien: `/invitation/${inv.jeton}`, url: `${ctx.urlPublique()}/invitation/${inv.jeton}` });
	}
	for (const x of liste(c.jetons, "jetons")) {
		const nom = validerNom(x.nom);
		const role = String(x.role ?? "agent");
		if (!(ROLES_JETON as readonly string[]).includes(role)) throw invalide("jetons : role agent ou mainteneur");
		let pour: string | null = null;
		if (x.pour !== undefined && x.pour !== null) {
			const pc = typeof x.pour === "string" ? ctx.base.compte(x.pour) : undefined;
			if (!pc) throw invalide("jetons : pour = id d'un compte existant");
			// Un jeton ne vaut jamais plus que son propriétaire (Base.jeton) : refusé s'il ne vaudrait rien.
			const r = ctx.base.roleSur(pc, projet);
			if (!r || r === "lecteur") throw invalide("jetons : pour = un contributeur, un mainteneur du projet ou un admin");
			pour = pc.id;
		}
		const j = ctx.base.creerJeton(projet, nom, role as RoleJeton, pour);
		sortie.jetons.push({ id: j.id, nom, role, jeton: j.jeton, pour });
	}
	return sortie;
}
