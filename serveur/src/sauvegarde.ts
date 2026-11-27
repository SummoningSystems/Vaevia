// Sauvegarde des données du serveur (étape 3.7, A1 ; docs/etape3-7-dix-premieres.md). Une sauvegarde est un dossier
// sauvegarde-AAAAMMJJ-HHMMSS (heure UTC) dans le dossier des sauvegardes (WDD_SAUVEGARDE, sinon <données>-sauvegardes) :
// - outil.sqlite : copie à chaud par VACUUM INTO (cohérente, même pendant des écritures) ;
// - projets/<id>/captures : captures jointes aux retours (étape 3.7, R2) ; écrites une fois, jamais modifiées ;
// - projets/<id>/depot : dépôt Git de design, copié pendant que la file du projet est tenue (aucune écriture ne
//   s'intercale) ; projets/<id>/builds : seuls les builds complets (page.html présente), qui ne changent plus ;
// - manifeste.json : format, date, projets, et taille plus SHA-256 de chaque fichier, que la restauration vérifie.
// Écrite d'abord sous <nom>.partiel, renommée à la fin : une sauvegarde interrompue n'est jamais prise pour bonne.
// Pas copiés : gitconfig (réécrit à chaque démarrage), serveur.verrou, lien-admin.txt (lien d'invitation, secret).
// La sauvegarde contient les empreintes des jetons et des sessions : la traiter comme un secret.
// Planifiée par le serveur (WDD_SAUVEGARDE_HEURES, 24 par défaut, 0 = jamais ; WDD_SAUVEGARDE_GARDER, 7 par défaut) ;
// en mode test (WDD_TEST=1), seulement si WDD_SAUVEGARDE_HEURES est donné.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Base } from "./base.ts";
import type { Depot } from "./depot.ts";

export const FORMAT_SAUVEGARDE = 1;
export const NOM_SAUVEGARDE = /^sauvegarde-\d{8}-\d{6}(-\d{1,3})?$/;
export type InfoSauvegarde = { nom: string; dossier: string; date: string; fichiers: number; octets: number; duree_ms: number; projets: string[] };
export type EtatSauvegarde = {
	dossier: string; heures: number; garder: number;
	enCours: boolean;
	derniere: { date: string; ok: boolean; nom?: string; octets?: number; message?: string } | null;
};
export type Manifeste = { format: number; date: string; projets: string[]; fichiers: Record<string, { octets: number; sha256: string }> };

const deux = (n: number) => String(n).padStart(2, "0");
const horodatage = (d: Date) => `${d.getUTCFullYear()}${deux(d.getUTCMonth() + 1)}${deux(d.getUTCDate())}-${deux(d.getUTCHours())}${deux(d.getUTCMinutes())}${deux(d.getUTCSeconds())}`;

export function empreinteFichier(f: string): string {
	const h = crypto.createHash("sha256");
	const fd = fs.openSync(f, "r");
	try {
		const tampon = Buffer.allocUnsafe(1024 * 1024);
		for (let n; (n = fs.readSync(fd, tampon, 0, tampon.length, null)) > 0;) h.update(tampon.subarray(0, n));
	} finally { fs.closeSync(fd); }
	return h.digest("hex");
}
// Fichiers d'un dossier, chemins relatifs en « / », triés.
export function fichiersDe(racine: string): string[] {
	const l: string[] = [];
	const marcher = (rel: string) => {
		for (const e of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
			const r = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) marcher(r);
			else if (e.isFile()) l.push(r);
		}
	};
	marcher("");
	return l.sort();
}

export type SourceSauvegarde = { base: Base; depots: Map<string, Depot>; racineProjets: string };

export async function sauvegarder(src: SourceSauvegarde, dossierSauvegardes: string, maintenant = new Date()): Promise<InfoSauvegarde> {
	const debut = Date.now();
	fs.mkdirSync(dossierSauvegardes, { recursive: true });
	let nom = "sauvegarde-" + horodatage(maintenant);
	for (let i = 2; fs.existsSync(path.join(dossierSauvegardes, nom)) || fs.existsSync(path.join(dossierSauvegardes, nom + ".partiel")); i++) nom = `sauvegarde-${horodatage(maintenant)}-${i}`;
	const partiel = path.join(dossierSauvegardes, nom + ".partiel"), final = path.join(dossierSauvegardes, nom);
	fs.mkdirSync(partiel);
	try {
		// Base : VACUUM INTO écrit une copie cohérente (transaction de lecture), sans arrêter les écritures.
		src.base.db.exec(`VACUUM INTO '${path.join(partiel, "outil.sqlite").replace(/'/g, "''")}'`);
		const projets: string[] = [];
		for (const p of src.base.projets()) {
			const dirP = path.join(src.racineProjets, p.id);
			if (!fs.existsSync(dirP)) continue;
			projets.push(p.id);
			const dest = path.join(partiel, "projets", p.id);
			fs.mkdirSync(dest, { recursive: true });
			const depotSrc = path.join(dirP, "depot");
			const copier = async () => { if (fs.existsSync(depotSrc)) fs.cpSync(depotSrc, path.join(dest, "depot"), { recursive: true }); };
			const d = src.depots.get(p.id);
			if (d) await d.file.executer(copier); else await copier();
			const captures = path.join(dirP, "captures");
			if (fs.existsSync(captures)) for (const c of fs.readdirSync(captures)) if (/^[0-9a-f]{64}\.(png|webp)$/.test(c)) { fs.mkdirSync(path.join(dest, "captures"), { recursive: true }); fs.copyFileSync(path.join(captures, c), path.join(dest, "captures", c)); }
			const builds = path.join(dirP, "builds");
			if (fs.existsSync(builds)) for (const b of fs.readdirSync(builds)) {
				if (/^[1-9]\d{0,8}$/.test(b) && fs.existsSync(path.join(builds, b, "page.html"))) fs.cpSync(path.join(builds, b), path.join(dest, "builds", b), { recursive: true });
			}
		}
		const fichiers: Manifeste["fichiers"] = {};
		let octets = 0;
		for (const f of fichiersDe(partiel)) {
			const abs = path.join(partiel, f), t = fs.statSync(abs).size;
			fichiers[f] = { octets: t, sha256: empreinteFichier(abs) };
			octets += t;
		}
		const m: Manifeste = { format: FORMAT_SAUVEGARDE, date: maintenant.toISOString(), projets, fichiers };
		fs.writeFileSync(path.join(partiel, "manifeste.json"), JSON.stringify(m, null, 1) + "\n");
		fs.renameSync(partiel, final);
		return { nom, dossier: final, date: m.date, fichiers: Object.keys(fichiers).length, octets, duree_ms: Date.now() - debut, projets };
	} catch (e) {
		fs.rmSync(partiel, { recursive: true, force: true, maxRetries: 3 });
		throw e;
	}
}

// Garde les « garder » sauvegardes les plus récentes (ordre des noms = ordre des dates) ; ne touche qu'aux dossiers
// dont le nom est celui d'une sauvegarde, et aux restes « .partiel » d'une sauvegarde interrompue de plus d'un jour.
export function tournerSauvegardes(dossierSauvegardes: string, garder: number, maintenant = Date.now()): string[] {
	if (!fs.existsSync(dossierSauvegardes) || garder < 1) return [];
	const noms = fs.readdirSync(dossierSauvegardes).filter(n => NOM_SAUVEGARDE.test(n) && fs.statSync(path.join(dossierSauvegardes, n)).isDirectory()).sort();
	const suppr = noms.slice(0, Math.max(0, noms.length - garder));
	for (const n of fs.readdirSync(dossierSauvegardes)) {
		if (n.endsWith(".partiel") && NOM_SAUVEGARDE.test(n.slice(0, -".partiel".length)) && maintenant - fs.statSync(path.join(dossierSauvegardes, n)).mtimeMs > 24 * 3600 * 1000) suppr.push(n);
	}
	for (const n of suppr) fs.rmSync(path.join(dossierSauvegardes, n), { recursive: true, force: true, maxRetries: 3 });
	return suppr;
}

// Dernière sauvegarde complète présente (au démarrage : l'Administration la montre avant la première de ce processus).
export function derniereSauvegarde(dossierSauvegardes: string): EtatSauvegarde["derniere"] {
	if (!fs.existsSync(dossierSauvegardes)) return null;
	const n = fs.readdirSync(dossierSauvegardes).filter(x => NOM_SAUVEGARDE.test(x)).sort().pop();
	if (!n) return null;
	try {
		const m = JSON.parse(fs.readFileSync(path.join(dossierSauvegardes, n, "manifeste.json"), "utf8")) as Manifeste;
		return { date: m.date, ok: true, nom: n, octets: Object.values(m.fichiers).reduce((a, f) => a + f.octets, 0) };
	} catch { return null; }
}

// Une sauvegarde à la fois ; résultat gardé dans l'état (date, issue) pour l'Administration et le journal.
export async function lancerSauvegarde(src: SourceSauvegarde, etat: EtatSauvegarde, journal: (m: string) => void): Promise<InfoSauvegarde> {
	if (etat.enCours) throw Object.assign(new Error("une sauvegarde est déjà en cours"), { enCours: true });
	etat.enCours = true;
	try {
		const r = await sauvegarder(src, etat.dossier);
		etat.derniere = { date: r.date, ok: true, nom: r.nom, octets: r.octets };
		const suppr = tournerSauvegardes(etat.dossier, etat.garder);
		journal(`sauvegarde ${r.nom} : ${r.fichiers} fichiers, ${Math.round(r.octets / 1024)} Kio, ${r.duree_ms} ms${suppr.length ? ` ; anciennes supprimées : ${suppr.join(", ")}` : ""}`);
		return r;
	} catch (e) {
		etat.derniere = { date: new Date().toISOString(), ok: false, message: String((e as Error)?.message || e).slice(0, 300) };
		journal(`ERREUR sauvegarde : ${etat.derniere.message}`);
		throw e;
	} finally { etat.enCours = false; }
}

// Étape 3.9, A4 : sauvegarde hors du serveur, serveur arrêté (l'installeur la lance avant de redémarrer un serveur dont
// le code a changé). Le verrou des données est pris : refus si un serveur vivant les tient.
//   node serveur/src/sauvegarde.ts [<dossier des données>] [<dossier des sauvegardes>]   (sinon WDD_DONNEES, WDD_SAUVEGARDE)
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	const [d, s] = process.argv.slice(2);
	const donnees = path.resolve(d || process.env.WDD_DONNEES || "");
	if (!d && !process.env.WDD_DONNEES) { console.error("usage : node serveur/src/sauvegarde.ts <dossier des données> [<dossier des sauvegardes>] (sinon WDD_DONNEES, WDD_SAUVEGARDE)"); process.exit(2); }
	if (!fs.existsSync(path.join(donnees, "outil.sqlite"))) { console.error(`ÉCHEC pas de données dans ${donnees} (outil.sqlite absent)`); process.exit(1); }
	const dossier = path.resolve(s || process.env.WDD_SAUVEGARDE || donnees.replace(/[\/]+$/, "") + "-sauvegardes");
	const { prendreVerrou } = await import("./verrou.ts");
	const { Base } = await import("./base.ts");
	let verrou: { liberer: () => void };
	try { verrou = await prendreVerrou(donnees, 0, "sauvegarde"); }
	catch (e) { console.error("ÉCHEC " + (e as Error).message); process.exit(1); }
	const base = new Base(donnees);
	try {
		const r = await sauvegarder({ base, depots: new Map(), racineProjets: path.join(donnees, "projets") }, dossier);
		console.log(`OK sauvegarde ${r.nom} : ${r.fichiers} fichiers, ${Math.round(r.octets / 1024)} Kio, dans ${dossier}`);
	} catch (e) { console.error("ÉCHEC " + (e as Error).message); process.exitCode = 1; }
	finally { base.fermer(); verrou.liberer(); }
}
