// Fichier <WDD_DONNEES>/lien-admin.txt (étape 3.5, § 1.1 et § 2.4) : une ligne, le lien d'invitation admin du premier
// démarrage, ou un lien de reconnexion donné par serveur/src/lien.ts. L'installeur Windows l'ouvre dans le navigateur,
// Docker le lit par « docker compose exec wdd cat /donnees/lien-admin.txt ».
// - Écrit d'un coup (fichier temporaire puis renommage) : un lecteur ne voit jamais un fichier à moitié écrit, et une
//   vérification concurrente ne le prend pas pour un lien inconnu. Droits 0600 hors Windows.
// - Supprimé dès que son lien ne vaut plus (utilisé, annulé, expiré, inconnu) : vérifié après chaque utilisation ou
//   annulation d'invitation, et toutes les minutes (expiration). Le lien est retrouvé à partir du contenu du fichier
//   (jeton → empreinte en base), jamais d'un état en mémoire : lien.ts l'écrit depuis un autre processus.
// - Au démarrage avec un admin : supprimé, sauf s'il porte un lien de reconnexion encore valable (lien.ts a pu être
//   lancé avant le serveur).
// Aucune erreur de fichier ne remonte : une écriture d'invitation qui a réussi ne doit pas répondre 500 pour autant.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Base } from "./base.ts";

export const FICHIER_LIEN_ADMIN = "lien-admin.txt";
export const cheminLienAdmin = (donnees: string): string => path.join(donnees, FICHIER_LIEN_ADMIN);
const JETON_DU_LIEN = /\/invitation\/([A-Za-z0-9_-]{20,100})\s*$/;

// Écrit le lien (une ligne). Lève une erreur si l'écriture échoue (lien.ts la signale ; le serveur la journalise).
export function ecrireLienAdmin(donnees: string, lien: string): void {
	const cible = cheminLienAdmin(donnees);
	const tmp = `${cible}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.writeFileSync(tmp, lien + "\n", { mode: 0o600 });
		if (process.platform !== "win32") fs.chmodSync(tmp, 0o600); // le mode ne vaut qu'à la création, et l'umask s'y applique
		try { fs.renameSync(tmp, cible); }
		catch { fs.rmSync(cible, { force: true }); fs.renameSync(tmp, cible); } // Windows : cible momentanément ouverte
	} finally { fs.rmSync(tmp, { force: true }); }
}

export function supprimerLienAdmin(donnees: string): void {
	try { fs.rmSync(cheminLienAdmin(donnees), { force: true }); } catch { }
}

// Supprime le fichier si son lien ne vaut plus ; « demarrage » : supprime aussi un lien de création d'admin quand un
// admin existe déjà. Rend vrai si le fichier a été supprimé.
export function verifierLienAdmin(donnees: string, base: Base, demarrage = false, journal: (m: string) => void = () => { }): boolean {
	try {
		let texte: string;
		try { texte = fs.readFileSync(cheminLienAdmin(donnees), "utf8"); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
		const m = texte.trim().match(JETON_DU_LIEN);
		const inv = m ? base.invitation(m[1]) : undefined;
		const garder = !!inv && (!demarrage || !!inv.compte_cible || !base.adminExiste());
		if (garder) return false;
		fs.rmSync(cheminLienAdmin(donnees), { force: true });
		journal(`${FICHIER_LIEN_ADMIN} supprimé (${inv ? "un administrateur existe déjà" : "lien utilisé, annulé ou expiré"})`);
		return true;
	} catch (e) {
		journal(`${FICHIER_LIEN_ADMIN} : vérification impossible (${(e as Error)?.message || e})`);
		return false;
	}
}
