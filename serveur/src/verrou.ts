// Verrou du dossier des données : un seul serveur par WDD_DONNEES (étape 3.5, relecture de l'installeur).
// Deux serveurs sur les mêmes données écriraient tous deux dans outil.sqlite et dans les dépôts de design (le serveur
// doit y être le seul écrivain), et le second supprimerait au démarrage les verrous de Git du premier.
// - <WDD_DONNEES>/serveur.verrou, créé de façon exclusive (« wx ») avant toute autre lecture ou écriture des données :
//   {pid, port, hote, debut, ecoute, jeton}. Le port réel y est écrit dès l'écoute (ecoute: true). L'installeur Windows
//   le lit aussi (outils/installer.ps1) pour refuser avant de lancer quoi que ce soit.
// - Retiré à l'arrêt (arreter()) et si le démarrage échoue ; un arrêt brutal (taskkill /F, kill -9, coupure) le laisse.
// - Verrou existant : refus seulement si un autre serveur est vraisemblablement vivant. Il est repris (verrou périmé)
//   si son PID est mort, si c'est le PID de ce processus (Docker : node est le PID 1 à chaque démarrage du conteneur)
//   sans que ce processus serve déjà ce dossier, ou si le serveur qu'il désigne écoutait mais ne répond plus à
//   /api/sante sur son port (PID repris par un autre programme, après un redémarrage de la machine par exemple).
//   Un serveur encore en train de démarrer (ecoute: false) est attendu 2 min avant d'être tenu pour mort.
// - lien.ts n'en a pas besoin : il travaille à côté du serveur, par la base, sans toucher aux dépôts.
// Limite : deux démarrages simultanés sur un verrou périmé laissent une fenêtre étroite (relecture juste avant le retrait).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const FICHIER_VERROU = "serveur.verrou";
export type ContenuVerrou = { pid: number; port: number; hote: string; debut: string; ecoute: boolean; jeton: string };
export type Verrou = { fichier: string; ecoute: (port: number) => void; liberer: () => void };

const DEMARRAGE_MAX_MS = 120000;
// Dossiers servis par ce processus (tests : plusieurs serveurs dans un même processus, même PID).
const tenus = new Set<string>();
const liberations = new Set<() => void>();
let sortieBranchee = false;

export const cheminVerrou = (donnees: string): string => path.join(donnees, FICHIER_VERROU);

function vivant(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function lire(fichier: string): ContenuVerrou | null | undefined {
	let t: string;
	try { t = fs.readFileSync(fichier, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
	try {
		const o = JSON.parse(t);
		if (Number.isInteger(o?.pid) && o.pid > 0 && typeof o.jeton === "string") return o as ContenuVerrou;
	} catch { }
	return null; // illisible (en cours d'écriture, ou abîmé)
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
// /api/sante du serveur du verrou : trois essais de 2 s (un serveur vivant peut rester muet quelques secondes, par
// exemple pendant l'attente d'un verrou SQLite de 5 s).
async function repond(hote: string, port: number): Promise<boolean> {
	if (!Number.isInteger(port) || port <= 0) return false;
	const h = hote === "0.0.0.0" || !hote ? "127.0.0.1" : hote === "::" ? "[::1]" : hote.includes(":") ? `[${hote}]` : hote;
	for (let i = 0; i < 3; i++) {
		if (i) await pause(1000);
		try { const r = await fetch(`http://${h}:${port}/api/sante`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return true; } catch { }
	}
	return false;
}

// Prend le verrou du dossier (chemin réel, déjà créé) ; lève une erreur claire si un autre serveur s'en sert.
export async function prendreVerrou(donnees: string, port: number, hote: string): Promise<Verrou> {
	const fichier = cheminVerrou(donnees);
	const cle = process.platform === "win32" ? donnees.toLowerCase() : donnees;
	if (tenus.has(cle)) throw new Error(`ce processus sert déjà le dossier des données ${donnees}`);
	const moi: ContenuVerrou = { pid: process.pid, port, hote, debut: new Date().toISOString(), ecoute: false, jeton: crypto.randomBytes(12).toString("base64url") };
	const ecrire = (flag: string) => fs.writeFileSync(fichier, JSON.stringify(moi) + "\n", { flag });
	let pris = false;
	for (let essai = 0; essai < 5 && !pris; essai++) {
		try { ecrire("wx"); pris = true; break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
		let autre = lire(fichier);
		if (autre === null) { await pause(200); autre = lire(fichier); } // peut-être en cours d'écriture
		if (autre === undefined) continue; // retiré entre-temps
		if (autre && autre.pid !== process.pid && vivant(autre.pid)) {
			const age = Date.now() - Date.parse(autre.debut);
			const occupe = autre.ecoute ? await repond(autre.hote, autre.port) : !(age > DEMARRAGE_MAX_MS);
			if (occupe) throw new Error(`un autre serveur utilise déjà ce dossier de données (${donnees}) : PID ${autre.pid}, port ${autre.port}${autre.ecoute ? "" : " (en cours de démarrage)"}. L'arrêter d'abord. Si aucun serveur ne tourne avec ces données, supprimer ${fichier}.`);
		}
		// Périmé (ou illisible) : retiré s'il n'a pas changé depuis la lecture, puis nouvel essai (« wx » : un seul gagne).
		const encore = lire(fichier);
		if (encore === undefined || (autre && encore && encore.jeton === autre.jeton) || (!autre && encore === null)) fs.rmSync(fichier, { force: true });
	}
	if (!pris) throw new Error(`verrou ${fichier} impossible à prendre`);
	tenus.add(cle);
	const a_moi = () => lire(fichier)?.jeton === moi.jeton;
	let libre = false;
	const liberer = () => {
		if (libre) return;
		libre = true;
		tenus.delete(cle);
		liberations.delete(liberer);
		try { if (a_moi()) fs.rmSync(fichier, { force: true }); } catch { }
	};
	liberations.add(liberer);
	if (!sortieBranchee) { sortieBranchee = true; process.once("exit", () => { for (const l of [...liberations]) l(); }); }
	return {
		fichier,
		ecoute: (p: number) => { if (!libre && a_moi()) { moi.port = p; moi.ecoute = true; ecrire("w"); } },
		liberer,
	};
}
