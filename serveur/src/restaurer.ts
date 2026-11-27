// Restauration d'une sauvegarde (étape 3.7, A1 ; sauvegarde.ts), serveur arrêté.
//   node serveur/src/restaurer.ts <dossier de la sauvegarde> [<dossier des données>]
// Dossier des données : 2e argument, sinon WDD_DONNEES. Code 0 si restauré et contrôlé, 1 sinon (rien n'est changé, ou
// l'état d'avant est remis), 2 pour une erreur d'usage.
// 1. Le manifeste est vérifié en entier (chaque fichier : présent, même taille, même SHA-256) avant toute écriture.
// 2. Le verrou du dossier des données est pris (verrou.ts) : refus si un serveur vivant le tient.
// 3. Les données en place sont renommées en <dossier>.avant-restauration-<date> (jamais supprimées), puis la sauvegarde
//    est copiée dans un dossier neuf. Si le dossier ne peut pas être renommé (point de montage : /donnees sous Docker),
//    son contenu est déplacé dans <dossier>/.avant-restauration-<date>, dans le même volume.
// 4. Contrôles : PRAGMA integrity_check de outil.sqlite, et « git rev-parse HEAD » de chaque dépôt de design. En cas
//    d'échec, le dossier neuf est retiré et les données d'avant reprennent leur nom.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { cheminVerrou, prendreVerrou } from "./verrou.ts";
import { empreinteFichier, FORMAT_SAUVEGARDE } from "./sauvegarde.ts";
import type { Manifeste } from "./sauvegarde.ts";

export type Bilan = { ok: boolean; message: string; avant?: string; projets?: string[] };

const deux = (n: number) => String(n).padStart(2, "0");
const horodatage = (d: Date) => `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;

export function verifierSauvegarde(dossier: string): { manifeste: Manifeste } | { erreur: string } {
	let m: Manifeste;
	try { m = JSON.parse(fs.readFileSync(path.join(dossier, "manifeste.json"), "utf8")); }
	catch (e) { return { erreur: `manifeste.json illisible dans ${dossier} (${(e as Error).message}) : ce n'est pas une sauvegarde complète` }; }
	if (m?.format !== FORMAT_SAUVEGARDE || !m.fichiers || typeof m.fichiers !== "object") return { erreur: `format de sauvegarde inconnu (${m?.format}) : attendu ${FORMAT_SAUVEGARDE}` };
	if (!m.fichiers["outil.sqlite"]) return { erreur: "outil.sqlite absent du manifeste" };
	for (const [rel, f] of Object.entries(m.fichiers)) {
		// Chemins relatifs simples seulement : un manifeste forgé ne fait rien lire ni écrire hors de la sauvegarde.
		if (!/^[^\\:]+$/.test(rel) || rel.split("/").some(x => !x || x === "." || x === "..")) return { erreur: `chemin refusé dans le manifeste : ${rel}` };
		const abs = path.join(dossier, ...rel.split("/"));
		let t: number;
		try { t = fs.statSync(abs).size; } catch { return { erreur: `fichier manquant : ${rel}` }; }
		if (t !== f.octets) return { erreur: `taille différente : ${rel} (${t} octets, ${f.octets} attendus)` };
		if (empreinteFichier(abs) !== f.sha256) return { erreur: `empreinte différente : ${rel} (fichier altéré)` };
	}
	return { manifeste: m };
}

function controler(donnees: string, projets: string[]): string | null {
	try {
		const db = new DatabaseSync(path.join(donnees, "outil.sqlite"));
		try {
			const r = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
			if (r.length !== 1 || r[0].integrity_check !== "ok") return "outil.sqlite : " + r.map(x => x.integrity_check).join(" ; ").slice(0, 300);
		} finally { db.close(); }
	} catch (e) { return "outil.sqlite illisible : " + (e as Error).message; }
	for (const p of projets) {
		const d = path.join(donnees, "projets", p, "depot");
		if (!fs.existsSync(d)) continue;
		try { execFileSync("git", ["-C", d, "rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
		catch (e) { return `dépôt de design du projet ${p} : ${String((e as { stderr?: Buffer }).stderr || (e as Error).message).trim().slice(0, 300)}`; }
	}
	return null;
}

export async function restaurer(sauvegarde: string, donnees: string, maintenant = new Date(), o: { parContenu?: boolean } = {}): Promise<Bilan> {
	sauvegarde = path.resolve(sauvegarde); donnees = path.resolve(donnees);
	const v = verifierSauvegarde(sauvegarde);
	if ("erreur" in v) return { ok: false, message: "sauvegarde refusée, rien n'a changé : " + v.erreur };
	const rel = path.relative(donnees, sauvegarde);
	if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) return { ok: false, message: "la sauvegarde est dans le dossier des données : la copier ailleurs d'abord" };
	// Verrou : refus si un serveur vivant tient ces données. Tenu jusqu'au renommage : aucun serveur ne démarre entre les
	// deux ; il part ensuite avec l'ancien dossier (périmé : son PID, celui de cette commande, sera mort).
	let verrou: { liberer: () => void } | null = null;
	if (fs.existsSync(donnees)) {
		try { verrou = await prendreVerrou(donnees, 0, "restauration"); }
		catch (e) { return { ok: false, message: "rien n'a changé : " + (e as Error).message + " (arrêter le serveur d'abord : installer.cmd -Arreter)" }; }
	}
	let avant = "", dedans = false;
	if (fs.existsSync(donnees)) {
		avant = `${donnees.replace(/[\\/]+$/, "")}.avant-restauration-${horodatage(maintenant)}`;
		for (let i = 2; fs.existsSync(avant); i++) avant = `${donnees.replace(/[\\/]+$/, "")}.avant-restauration-${horodatage(maintenant)}-${i}`;
		let erreur: Error | null = null;
		if (o.parContenu) erreur = Object.assign(new Error("point de montage (essai)"), { code: "EBUSY" });
		else try { fs.renameSync(donnees, avant); } catch (e) { erreur = e as Error; }
		if (erreur) {
			// Point de montage (Docker : EBUSY, EXDEV, EPERM…) : le contenu part dans un sous-dossier du même volume.
			const nom = `.avant-restauration-${horodatage(maintenant)}`;
			avant = path.join(donnees, nom);
			for (let i = 2; fs.existsSync(avant); i++) avant = path.join(donnees, `${nom}-${i}`);
			const entrees = fs.readdirSync(donnees).filter(n => !n.startsWith(".avant-restauration-"));
			const deplaces: string[] = [];
			try {
				fs.mkdirSync(avant);
				for (const n of entrees) { fs.renameSync(path.join(donnees, n), path.join(avant, n)); deplaces.push(n); }
				dedans = true;
			} catch (e2) {
				for (const n of deplaces) { try { fs.renameSync(path.join(avant, n), path.join(donnees, n)); } catch { } }
				try { fs.rmdirSync(avant); } catch { }
				verrou?.liberer();
				return { ok: false, message: `rien n'a changé : ni renommage de ${donnees} (${erreur.message}) ni déplacement de son contenu (${(e2 as Error).message}) ; un programme a-t-il un fichier ouvert dedans ?` };
			}
		}
	}
	verrou?.liberer();
	// Le verrou de cette commande est parti avec l'ancien dossier : retiré (il ne désigne aucun serveur).
	const retirerNotreVerrou = (dir: string) => { try { const f = cheminVerrou(dir); if (JSON.parse(fs.readFileSync(f, "utf8")).pid === process.pid) fs.rmSync(f, { force: true }); } catch { } };
	if (avant) retirerNotreVerrou(avant);
	const annuler = (pourquoi: string): Bilan => {
		if (dedans) {
			for (const n of fs.readdirSync(donnees)) if (path.join(donnees, n) !== avant) fs.rmSync(path.join(donnees, n), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			for (const n of fs.readdirSync(avant)) fs.renameSync(path.join(avant, n), path.join(donnees, n));
			fs.rmdirSync(avant);
			retirerNotreVerrou(donnees);
		} else {
			fs.rmSync(donnees, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			if (avant) fs.renameSync(avant, donnees);
		}
		return { ok: false, message: `restauration annulée, données d'avant remises en place : ${pourquoi}` };
	};
	try {
		fs.mkdirSync(donnees, { recursive: true });
		for (const relF of Object.keys(v.manifeste.fichiers)) {
			const dest = path.join(donnees, ...relF.split("/"));
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(path.join(sauvegarde, ...relF.split("/")), dest);
		}
		fs.mkdirSync(path.join(donnees, "projets"), { recursive: true });
	} catch (e) { return annuler("copie impossible : " + (e as Error).message); }
	const pb = controler(donnees, v.manifeste.projets || []);
	if (pb) return annuler(pb);
	return { ok: true, message: `sauvegarde du ${v.manifeste.date} restaurée dans ${donnees} (${Object.keys(v.manifeste.fichiers).length} fichiers, projets : ${(v.manifeste.projets || []).join(", ") || "aucun"})` + (avant ? ` ; données d'avant gardées dans ${avant}` : ""), avant, projets: v.manifeste.projets || [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	const [s, d] = process.argv.slice(2);
	const donnees = d || process.env.WDD_DONNEES || "";
	if (!s || !donnees) { console.error("usage : node serveur/src/restaurer.ts <dossier de la sauvegarde> [<dossier des données>] (sinon WDD_DONNEES)"); process.exit(2); }
	const b = await restaurer(s, donnees);
	(b.ok ? console.log : console.error)((b.ok ? "OK " : "ÉCHEC ") + b.message);
	process.exit(b.ok ? 0 : 1);
}
