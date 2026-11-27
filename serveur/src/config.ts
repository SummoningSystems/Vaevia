// Configuration du serveur, lue dans l'environnement (voir serveur/README.md).
import fs from "node:fs";
import path from "node:path";

export type Config = {
	donnees: string;        // WDD_DONNEES : dossier des données (outil.sqlite, projets/), hors dépôt de l'outil
	port: number;           // WDD_PORT (8080 par défaut ; 0 = port libre, pour les tests)
	hote: string;           // WDD_HOTE : adresse d'écoute (127.0.0.1 par défaut ; 0.0.0.0 dans Docker)
	https: boolean;         // WDD_HTTPS=1 : derrière un proxy HTTPS (cookie Secure)
	test: boolean;          // WDD_TEST=1 : active /__test/*
	url: string;            // WDD_URL : adresse publique (liens d'invitation, contrôle d'Origin) ; déduite sinon
	urlPages: string;       // WDD_URL_PAGES : origine de l'hôte des pages de projet (étape 3, § 2) ; vide = même origine
	site: string;           // WDD_SITE : dossier site/ de l'outil (build.js) ; ../../site par défaut
	ui: string;             // WDD_UI : dossier de la méta-interface (fichiers statiques) ; serveur/ui par défaut
	pingMs: number;         // intervalle des « : ping » du flux SSE (25 s ; réglable pour les tests)
	delaiRequeteMs: number; // délai pour recevoir une requête entière, corps compris (60 s ; réglable pour les tests)
	verifLienMs: number;    // vérification périodique de lien-admin.txt (60 s ; réglable pour les tests)
	sauvegarde: string;     // WDD_SAUVEGARDE : dossier des sauvegardes (étape 3.7, A1) ; <WDD_DONNEES>-sauvegardes par défaut
	sauvegardeHeures: number; // WDD_SAUVEGARDE_HEURES : intervalle de la sauvegarde planifiée (24 ; 0 = jamais ; 0 en mode test sauf si donné)
	sauvegardeGarder: number; // WDD_SAUVEGARDE_GARDER : sauvegardes gardées (7)
	buildsGarder: number;     // WDD_BUILDS_GARDER : builds gardés par projet (30 ; 0 = tous), plus ceux que cite un retour ouvert (étape 3.9, A3)
	verifSauvegardeMs: number;
	notifLocales: boolean;  // WDD_NOTIF_LOCALES=1 : notifications vers http et adresses internes permises (étape 3.7, I1)
	notifRegroupementMs: number; // événements regroupés avant envoi (10 s ; réglable pour les tests)
	notifEssaiMs: number[];  // pauses entre les essais d'envoi (2 s puis 10 s)
	notifDelaiMs: number;    // délai d'un envoi (10 s) // première vérification de l'échéance 1 min après le démarrage, puis toutes les 10 min (réglable pour les tests)
	intervalleAppairageMs: number; // intervalle d'interrogation d'un appairage (2 s, étape 3.5 § 2.1 ; réglable pour les tests)
	silencieux: boolean;    // pas de journal sur la sortie (tests)
};

// Racine du dépôt de l'outil : serveur/src/ -> ../..
// Étape 3.9, A4 : version de l'outil (fichier VERSION à la racine du dépôt), « inconnue » s'il manque.
export const VERSION_OUTIL = (() => { try { return fs.readFileSync(path.join(path.resolve(import.meta.dirname, "..", ".."), "VERSION"), "utf8").trim().slice(0, 40) || "inconnue"; } catch { return "inconnue"; } })();
export const RACINE_OUTIL = path.resolve(import.meta.dirname, "..", "..");

export function lireConfig(env: NodeJS.ProcessEnv = process.env, surcharge: Partial<Config> = {}): Config {
	const donnees = surcharge.donnees ?? env.WDD_DONNEES ?? "";
	const c: Config = {
		donnees,
		port: surcharge.port ?? (env.WDD_PORT !== undefined ? Number(env.WDD_PORT) : 8080),
		hote: surcharge.hote ?? env.WDD_HOTE ?? "127.0.0.1",
		https: surcharge.https ?? env.WDD_HTTPS === "1",
		test: surcharge.test ?? env.WDD_TEST === "1",
		url: (surcharge.url ?? env.WDD_URL ?? "").replace(/\/+$/, ""),
		urlPages: (surcharge.urlPages ?? env.WDD_URL_PAGES ?? "").replace(/\/+$/, ""),
		site: surcharge.site ?? env.WDD_SITE ?? path.join(RACINE_OUTIL, "site"),
		ui: surcharge.ui ?? env.WDD_UI ?? path.join(RACINE_OUTIL, "serveur", "ui"),
		pingMs: surcharge.pingMs ?? 25000,
		delaiRequeteMs: surcharge.delaiRequeteMs ?? 60000,
		verifLienMs: surcharge.verifLienMs ?? 60000,
		intervalleAppairageMs: surcharge.intervalleAppairageMs ?? 2000,
		silencieux: surcharge.silencieux ?? false,
		sauvegarde: surcharge.sauvegarde ?? env.WDD_SAUVEGARDE ?? "",
		sauvegardeHeures: surcharge.sauvegardeHeures ?? (env.WDD_SAUVEGARDE_HEURES !== undefined && env.WDD_SAUVEGARDE_HEURES !== "" ? Number(env.WDD_SAUVEGARDE_HEURES) : (surcharge.test ?? env.WDD_TEST === "1") ? 0 : 24),
		sauvegardeGarder: surcharge.sauvegardeGarder ?? (env.WDD_SAUVEGARDE_GARDER ? Number(env.WDD_SAUVEGARDE_GARDER) : 7),
		buildsGarder: surcharge.buildsGarder ?? (env.WDD_BUILDS_GARDER ? Number(env.WDD_BUILDS_GARDER) : 30),
		verifSauvegardeMs: surcharge.verifSauvegardeMs ?? 60 * 1000,
		notifLocales: surcharge.notifLocales ?? env.WDD_NOTIF_LOCALES === "1",
		notifRegroupementMs: surcharge.notifRegroupementMs ?? 10000,
		notifEssaiMs: surcharge.notifEssaiMs ?? [2000, 10000],
		notifDelaiMs: surcharge.notifDelaiMs ?? 10000,
	};
	verifierConfig(c);
	return c;
}

export const estBouclage = (h: string): boolean => /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::1" || h === "localhost";

function verifierConfig(c: Config): void {
	if (!c.donnees) throw new Error("WDD_DONNEES manquant : dossier des données du serveur (hors du dépôt de l'outil)");
	c.donnees = path.resolve(c.donnees);
	fs.mkdirSync(c.donnees, { recursive: true });
	c.donnees = fs.realpathSync.native(c.donnees);
	// Les dépôts de design ne doivent jamais se trouver dans le dépôt de l'outil (Git remonterait jusqu'à lui).
	const outil = fs.realpathSync.native(RACINE_OUTIL);
	const rel = path.relative(outil, c.donnees);
	if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) throw new Error(`WDD_DONNEES (${c.donnees}) est dans le dépôt de l'outil (${outil}) : choisir un dossier hors de ce dépôt`);
	if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) throw new Error("WDD_PORT invalide");
	if (!fs.existsSync(path.join(c.site, "build.js"))) throw new Error(`build.js introuvable dans ${c.site} (WDD_SITE)`);
	if (c.url && !/^https?:\/\/[^/]+$/.test(c.url)) throw new Error("WDD_URL : origine attendue, ex. https://retours.exemple.fr (sans chemin)");
	// Hôte des pages (étape 3, § 2) : une autre origine, d'un autre nom d'hôte (les cookies ne sont pas isolés par port).
	if (c.urlPages) {
		if (!/^https?:\/\/[^/]+$/.test(c.urlPages)) throw new Error("WDD_URL_PAGES : origine attendue, ex. https://pages.retours.exemple.fr (sans chemin)");
		if (!c.url) throw new Error("WDD_URL_PAGES demande WDD_URL : le serveur reconnaît ses deux hôtes par l'en-tête Host");
		if (new URL(c.urlPages).hostname.toLowerCase() === new URL(c.url).hostname.toLowerCase())
			throw new Error("WDD_URL_PAGES : même nom d'hôte que WDD_URL ; les cookies ne sont pas isolés par port, prendre un autre nom (de préférence un autre domaine, ex. retours-pages.fr ; un sous-domaine marche, mais isole moins : voir serveur/README.md)");
	}
	// L'API de test n'a aucune authentification (elle donne même un compte admin) : jamais hors de la machine.
	if (c.test && !estBouclage(c.hote)) throw new Error(`WDD_TEST=1 refusé avec WDD_HOTE=${c.hote} : l'API de test n'écoute que sur une adresse de bouclage (127.0.0.1, ::1, localhost)`);
	if (!Number.isInteger(c.delaiRequeteMs) || c.delaiRequeteMs < 1) throw new Error("délai de requête invalide");
	// Sauvegardes (étape 3.7, A1) : à côté des données par défaut, jamais dedans (une restauration renomme le dossier des
	// données) ni dans le dépôt de l'outil.
	c.sauvegarde = path.resolve(c.sauvegarde || c.donnees.replace(/[\\/]+$/, "") + "-sauvegardes");
	const dans = (parent: string, enfant: string) => { const r = path.relative(parent, enfant); return !r || (!r.startsWith("..") && !path.isAbsolute(r)); };
	if (dans(c.donnees, c.sauvegarde)) throw new Error(`WDD_SAUVEGARDE (${c.sauvegarde}) est dans le dossier des données : choisir un dossier à côté, de préférence sur un autre disque`);
	if (dans(outil, c.sauvegarde)) throw new Error(`WDD_SAUVEGARDE (${c.sauvegarde}) est dans le dépôt de l'outil : choisir un dossier hors de ce dépôt`);
	if (!Number.isFinite(c.sauvegardeHeures) || c.sauvegardeHeures < 0) throw new Error("WDD_SAUVEGARDE_HEURES : nombre d'heures positif attendu (0 = pas de sauvegarde planifiée)");
	if (!Number.isInteger(c.buildsGarder) || c.buildsGarder < 0 || c.buildsGarder === 1 || c.buildsGarder > 100000) throw new Error("WDD_BUILDS_GARDER : 0 (tous) ou un entier de 2 à 100000 attendu");
	if (!Number.isInteger(c.sauvegardeGarder) || c.sauvegardeGarder < 1 || c.sauvegardeGarder > 1000) throw new Error("WDD_SAUVEGARDE_GARDER : entier de 1 à 1000 attendu");
}
