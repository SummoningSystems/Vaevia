// Lien de reconnexion depuis la machine du serveur (étape 3.5, § 2.4) : « admin seul et perdu » (installation locale,
// cookies effacés), ou tout compte quand personne ne peut le créer depuis l'interface.
//   node serveur/src/lien.ts --donnees <dossier> reconnexion --admin | --compte <id> [--url <origine> | --port <n>]
// Avoir accès aux fichiers du serveur vaut droit d'admin : la commande ne demande rien d'autre.
// - --admin : le premier admin actif (le plus ancien) ; --compte <id> : ce compte (actif).
// - Le lien (7 jours, usage unique) est écrit seul sur la sortie standard, et dans <dossier>/lien-admin.txt ; les
//   messages vont sur la sortie d'erreur. Le journal d'audit reçoit « reconnexion créée » (qui : lien.ts).
// - Origine du lien : --url, sinon WDD_URL, sinon http://127.0.0.1:<port> avec --port, sinon WDD_PORT, sinon 8080.
// - Le serveur peut tourner pendant ce temps : la base est ouverte avec busy_timeout (base.ts) ; il supprime le fichier
//   quand le lien a servi.
// Codes de sortie : 0 succès, 1 refus (base absente, compte introuvable ou désactivé, aucun admin actif), 2 usage.
import fs from "node:fs";
import path from "node:path";
import { Base } from "./base.ts";
import { ecrireLienAdmin, cheminLienAdmin } from "./lien-admin.ts";

const USAGE = "usage : node serveur/src/lien.ts --donnees <dossier> reconnexion --admin | --compte <id> [--url <origine> | --port <n>]";

class ErreurUsage extends Error { }
class Refus extends Error { }

type Options = { donnees: string; commande: string; admin: boolean; compte: string; url: string; port: string };

function lireOptions(args: string[], env: NodeJS.ProcessEnv): Options {
	const o: Options = { donnees: env.WDD_DONNEES || "", commande: "", admin: false, compte: "", url: env.WDD_URL || "", port: env.WDD_PORT || "" };
	let urlDonnee = false, portDonne = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const valeur = (): string => {
			const v = args[++i];
			if (v === undefined || v.startsWith("--")) throw new ErreurUsage(`${a} demande une valeur`);
			return v;
		};
		if (a === "--donnees") o.donnees = valeur();
		else if (a === "--admin") o.admin = true;
		else if (a === "--compte") o.compte = valeur();
		else if (a === "--url") { o.url = valeur(); urlDonnee = true; }
		else if (a === "--port") { o.port = valeur(); portDonne = true; }
		else if (a === "--aide" || a === "-h" || a === "--help") throw new ErreurUsage("");
		else if (!a.startsWith("-") && !o.commande) o.commande = a;
		else throw new ErreurUsage(`argument inconnu : ${a}`);
	}
	if (o.commande !== "reconnexion") throw new ErreurUsage(o.commande ? `commande inconnue : ${o.commande}` : "commande attendue : reconnexion");
	if (!o.donnees) throw new ErreurUsage("--donnees <dossier> attendu (dossier des données du serveur)");
	if (o.admin === !!o.compte) throw new ErreurUsage("--admin ou --compte <id>, l'un des deux");
	if (urlDonnee && portDonne) throw new ErreurUsage("--url ou --port, pas les deux");
	if (portDonne) o.url = ""; // --port l'emporte sur WDD_URL
	o.url = o.url.replace(/\/+$/, "");
	if (o.url && !/^https?:\/\/[^/]+$/.test(o.url)) throw new ErreurUsage("--url (ou WDD_URL) : origine attendue, ex. https://retours.exemple.fr");
	if (!o.url) {
		const p = o.port || "8080";
		if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new ErreurUsage("--port (ou WDD_PORT) : 1 à 65535");
		o.url = `http://127.0.0.1:${Number(p)}`;
	}
	return o;
}

// Crée le lien et l'écrit ; rend le lien. Exportée pour les tests.
export function lienReconnexion(o: Options, erreur: (m: string) => void): string {
	const donnees = path.resolve(o.donnees);
	// On n'ouvre qu'une base existante : en créer une vide ici donnerait un serveur sans admin à son prochain démarrage.
	if (!fs.existsSync(path.join(donnees, "outil.sqlite"))) throw new Refus(`pas de base outil.sqlite dans ${donnees} (dossier des données du serveur ?)`);
	const base = new Base(donnees);
	try {
		const compte = o.admin ? base.premierAdminActif() : base.compte(o.compte);
		if (!compte) throw new Refus(o.admin ? "aucun administrateur actif : démarrer le serveur sans admin donne un lien de création (lien-admin.txt)" : `compte introuvable : ${o.compte}`);
		if (compte.desactive) throw new Refus(`compte désactivé : ${compte.id} (le réactiver depuis l'administration)`);
		const r = base.nouvelleReconnexion(compte.id, null, null);
		base.journaliser({ qui: "lien.ts", action: "reconnexion créée", cible: compte.id, detail: { invitation: r.id, expire: r.expire, par: "lien.ts" } });
		const lien = `${o.url}/invitation/${r.jeton}`;
		try { ecrireLienAdmin(donnees, lien); }
		catch (e) { erreur(`attention : ${cheminLienAdmin(donnees)} non écrit (${(e as Error)?.message || e})`); }
		erreur(`Lien de reconnexion pour ${compte.nom} (${compte.id}${compte.admin ? ", admin" : ""}), valable 7 jours, une seule fois ; aussi dans ${cheminLienAdmin(donnees)} :`);
		return lien;
	} finally { base.fermer(); }
}

export function principal(args: string[], env: NodeJS.ProcessEnv = process.env): number {
	try {
		const lien = lienReconnexion(lireOptions(args, env), m => process.stderr.write(m + "\n"));
		process.stdout.write(lien + "\n");
		return 0;
	} catch (e) {
		if (e instanceof ErreurUsage) { process.stderr.write((e.message ? e.message + "\n" : "") + USAGE + "\n"); return 2; }
		process.stderr.write(`lien.ts : ${(e as Error)?.message || e}\n`);
		return 1;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = principal(process.argv.slice(2));
