// Point d'entrée du serveur de l'étape 1 (docs/etape1-serveur.md).
//   WDD_DONNEES=<dossier> node serveur/src/principal.ts
// Variables d'environnement : serveur/README.md. demarrer() sert aussi aux tests (port 0, dossier temporaire).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { lireConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { Base } from "./base.ts";
import { Depot } from "./depot.ts";
import { Flux } from "./flux.ts";
import { Modes } from "./test-api.ts";
import { routeur } from "./http.ts";
import { FICHIER_LIEN_ADMIN, cheminLienAdmin, ecrireLienAdmin, verifierLienAdmin } from "./lien-admin.ts";
import { prendreVerrou } from "./verrou.ts";
import { derniereSauvegarde, lancerSauvegarde } from "./sauvegarde.ts";
import { Notifieur } from "./notifications.ts";
import type { EtatSauvegarde } from "./sauvegarde.ts";
import type { Verrou } from "./verrou.ts";
import type { Contexte } from "./http.ts";

export type Serveur = { url: string; port: number; ctx: Contexte; lienAdmin: string | null; arreter: () => Promise<void> };

// Configuration Git propre au serveur (GIT_CONFIG_GLOBAL) : rien de la machine ne s'applique aux dépôts de design.
const CONFIG_GIT = `[core]\n\tautocrlf = false\n\tsafecrlf = false\n\tquotepath = false\n\tfsmonitor = false\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[gc]\n\tauto = 0\n`;

export async function demarrer(surcharge: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Promise<Serveur> {
	const config = lireConfig(env, surcharge);
	const journal = (m: string) => { if (!config.silencieux) console.log(`[${new Date().toISOString()}] ${m}`); };
	// Un seul serveur par dossier de données (verrou.ts), avant toute lecture ou écriture des données ; rendu si le
	// démarrage échoue.
	const verrou = await prendreVerrou(config.donnees, config.port, config.hote);
	try { return await demarrerVerrouille(config, journal, verrou); }
	catch (e) { verrou.liberer(); throw e; }
}

async function demarrerVerrouille(config: Config, journal: (m: string) => void, verrou: Verrou): Promise<Serveur> {
	const racineProjets = path.join(config.donnees, "projets");
	fs.mkdirSync(racineProjets, { recursive: true });
	const configGit = path.join(config.donnees, "gitconfig");
	fs.writeFileSync(configGit, CONFIG_GIT);
	const base = new Base(config.donnees);
	const flux = new Flux(config.pingMs);
	const modes = new Modes(flux);
	const depots = new Map<string, Depot>();
	let adresse = "";
	const urlPublique = (req?: IncomingMessage) => config.url || (req?.headers.host ? `${config.https ? "https" : "http"}://${req.headers.host}` : adresse);
	const sauvegarde: EtatSauvegarde = { dossier: config.sauvegarde, heures: config.sauvegardeHeures, garder: config.sauvegardeGarder, enCours: false, derniere: null };
	try { sauvegarde.derniere = derniereSauvegarde(config.sauvegarde); } catch { sauvegarde.derniere = null; }
	const ctx: Contexte = { config, base, flux, modes, depots, racineProjets, configGit, journal, urlPublique,
		verifierLienAdmin: () => { verifierLienAdmin(config.donnees, base, false, journal); }, essaisCodes: new Map(), sauvegarde, notifieur: null as unknown as Notifieur };

	// Index de chaque projet relu depuis son dépôt (le dépôt fait foi). Aucun git du serveur ne tourne encore : les
	// verrous de Git restés d'un arrêt brutal sont supprimés d'abord (sinon toutes les écritures du projet, ou son
	// chargement, échoueraient indéfiniment).
	for (const p of base.projets()) {
		const d = new Depot(p.id, racineProjets, configGit, journal);
		const verrous = d.supprimerVerrous();
		if (verrous.length) journal(`projet ${p.id} : verrous de Git restés d'un arrêt brutal, supprimés (${verrous.join(", ")})`);
		try {
			await d.configurerLocal();
			await d.charger();
			depots.set(p.id, d);
			journal(`projet ${p.id} : ${d.index.size} retours, ${d.rev.slice(0, 10)}`);
		} catch (e) { journal(`ERREUR projet ${p.id} : dépôt illisible, projet ignoré (${(e as Error).message})`); }
	}

	// Notifications (étape 3.7, I1) : état de départ pris sur les dépôts chargés, puis observation du flux.
	const notifieur = new Notifieur(base, depots, { locales: config.notifLocales, regroupementMs: config.notifRegroupementMs, essaiMs: config.notifEssaiMs, delaiMs: config.notifDelaiMs },
		journal, p => `${config.url || adresse}/p/${p}/`);
	ctx.notifieur = notifieur;
	flux.observateur = (t, p, c) => notifieur.observer(t, p, c);

	// Délai de réception d'une requête entière (en-têtes et corps) : un client qui annonce un corps sans jamais l'envoyer
	// est coupé. Il ne vaut que pour la réception : la réponse d'un flux SSE (GET sans corps) n'est pas concernée.
	const serveur = http.createServer({
		requestTimeout: config.delaiRequeteMs, headersTimeout: Math.min(30000, config.delaiRequeteMs),
		connectionsCheckingInterval: Math.min(30000, Math.max(100, Math.floor(config.delaiRequeteMs / 4))),
	}, routeur(ctx));
	await new Promise<void>((ok, ko) => { serveur.once("error", ko); serveur.listen(config.port, config.hote, () => ok()); });
	const port = (serveur.address() as AddressInfo).port;
	verrou.ecoute(port);
	adresse = `http://${config.hote === "0.0.0.0" || config.hote === "::" ? "localhost" : config.hote}:${port}`;

	// Premier démarrage (aucun admin) : un lien d'invitation admin, affiché une fois et écrit dans lien-admin.txt (étape
	// 3.5, § 1.1). Un nouveau démarrage sans admin annule le précédent, en affiche un nouveau et réécrit le fichier. Avec
	// un admin, le fichier est supprimé (sauf lien de reconnexion encore valable, voir lien-admin.ts).
	let lienAdmin: string | null = null;
	if (!base.adminExiste()) {
		base.annulerInvitationsAdmin();
		const jeton = base.creerInvitation(null, "admin", new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString());
		lienAdmin = `${config.url || adresse}/invitation/${jeton}`;
		try { ecrireLienAdmin(config.donnees, lienAdmin); }
		catch (e) { journal(`${FICHIER_LIEN_ADMIN} : écriture impossible (${(e as Error)?.message || e})`); }
		if (!config.silencieux) console.log(`\nAucun administrateur : ouvre ce lien pour créer le compte admin (valable 7 jours, une seule fois ; aussi dans ${cheminLienAdmin(config.donnees)}) :\n  ${lienAdmin}\n`);
	} else verifierLienAdmin(config.donnees, base, true, journal);
	// Expiration du lien du fichier : vérifiée toutes les minutes (les utilisations et annulations le sont tout de suite).
	const minuterieLien = setInterval(ctx.verifierLienAdmin, config.verifLienMs);
	minuterieLien.unref();
	// Sauvegarde planifiée (étape 3.7, A1) : vérifiée toutes les 10 min (et 1 min après le démarrage) ; lancée quand la
	// dernière sauvegarde réussie date de plus de WDD_SAUVEGARDE_HEURES. Un échec est réessayé à la vérification suivante.
	let minuterieSauvegarde: NodeJS.Timeout | null = null, premiereSauvegarde: NodeJS.Timeout | null = null;
	if (config.sauvegardeHeures > 0) {
		const echeance = () => {
			const d = sauvegarde.derniere;
			const derniereOk = d && d.ok ? Date.parse(d.date) : 0;
			if (sauvegarde.enCours || Date.now() - derniereOk < config.sauvegardeHeures * 3600 * 1000) return;
			lancerSauvegarde({ base, depots, racineProjets }, sauvegarde, journal).catch(() => { });
		};
		premiereSauvegarde = setTimeout(echeance, config.verifSauvegardeMs); premiereSauvegarde.unref();
		minuterieSauvegarde = setInterval(echeance, config.verifSauvegardeMs * 10); minuterieSauvegarde.unref();
	}
	journal(`serveur à l'écoute sur ${adresse} (PID ${process.pid}) ; données : ${config.donnees}${config.test ? " ; API de test ACTIVE (WDD_TEST=1)" : ""}`);

	let arrete = false;
	const arreter = async () => {
		if (arrete) return;
		arrete = true;
		clearInterval(minuterieLien);
		if (minuterieSauvegarde) clearInterval(minuterieSauvegarde);
		if (premiereSauvegarde) clearTimeout(premiereSauvegarde);
		flux.fermer();
		await notifieur.fermer();
		modes.liberer();
		await new Promise<void>(ok => { serveur.close(() => ok()); serveur.closeAllConnections(); });
		// Une sauvegarde en cours finit avant la fermeture de la base (2 min au plus).
		for (let i = 0; sauvegarde.enCours && i < 2400; i++) await new Promise(r => setTimeout(r, 50));
		// Les écritures en cours finissent avant la fermeture de la base.
		await Promise.all([...depots.values()].map(d => d.file.fin));
		base.fermer();
		verrou.liberer();
	};
	return { url: adresse, port, ctx, lienAdmin, arreter };
}

// Lancement direct : node serveur/src/principal.ts
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	demarrer().then(s => {
		const fin = () => { s.arreter().then(() => process.exit(0)); };
		process.on("SIGINT", fin);
		process.on("SIGTERM", fin);
	}, e => { console.error("démarrage impossible : " + ((e as Error)?.message || e)); process.exit(1); });
}
