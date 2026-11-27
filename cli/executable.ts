// CLI « outil » : chemins des logiciels que l'agent lance pour exporter ou capturer (moteur du jeu, application,
// navigateur), propres au poste (étape 3.10, décision 3 de l'étape 3.6, docs/etape3-10-decisions-3-6.md).
//   outil executable                       les logiciels enregistrés pour ce projet
//   outil executable <nom>                 le chemin à lancer : celui enregistré, sinon celui du PATH
//   outil executable <nom> <chemin>        enregistre le chemin donné par l'humain
//   outil executable <nom> --oublier       retire l'enregistrement
// Fichier utilisateur, jamais dans le dépôt : <dossier utilisateur>/executables.json =
// { "<serveur>": { "<projet>": { "<nom>": "<chemin absolu>" } } }. .outil.json reste le même sur tous les postes
// (["godot", …] dans publier.exporteur) ; outil publier lance le chemin enregistré pour ce nom. Enregistrer ou oublier
// est refusé sous la veille : le programme lancé sur le poste est un choix de l'humain.
import fs from "node:fs";
import path from "node:path";
import { CODES, usage, erreur, chargerConfig, emettre, coupe, dossierUtilisateur, lireFichierUtilisateur, ecrireFichierUtilisateur, chercherProgramme } from "./commun.ts";
import type { Commande, Config, Contexte, Env } from "./commun.ts";

export const NOM_EXECUTABLE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const fichierExecutables = (env: Env): string => path.join(dossierUtilisateur(env), "executables.json");

// Les logiciels enregistrés pour ce projet ; un fichier illisible ou absent : aucun.
export function executablesDuProjet(env: Env, cfg: Pick<Config, "serveur" | "projet">): Record<string, string> {
	let tous: Record<string, any>;
	try { tous = lireFichierUtilisateur(fichierExecutables(env)); } catch { return {}; }
	const p = tous[cfg.serveur]?.[cfg.projet];
	if (!p || typeof p !== "object") return {};
	return Object.fromEntries(Object.entries(p).filter(([n, c]) => NOM_EXECUTABLE.test(n) && typeof c === "string" && path.isAbsolute(c))) as Record<string, string>;
}
const estFichier = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// Le programme à lancer pour un nom nu (« godot ») : le chemin enregistré s'il existe encore, sinon le PATH.
export function resoudreExecutable(ctx: Contexte, cfg: Pick<Config, "serveur" | "projet">, nom: string, depuis: string): { chemin: string | null; source: "enregistre" | "path" | null; enregistreAbsent?: string } {
	const enr = NOM_EXECUTABLE.test(nom) ? executablesDuProjet(ctx.env, cfg)[nom] : undefined;
	if (enr && estFichier(enr)) return { chemin: enr, source: "enregistre" };
	const p = chercherProgramme(nom, ctx.env, depuis);
	return { chemin: p, source: p ? "path" : null, ...(enr ? { enregistreAbsent: enr } : {}) };
}

const A_FAIRE = (nom: string) => `demander à l'humain le chemin de ${nom} (une question fermée, METHODE § 4, « Logiciel à lancer »), puis : outil executable ${nom} <chemin>. ` +
	"Sous la veille, ne pas demander : le dire dans le compte rendu et dans un point « À valider » des notes.";

export const COMMANDES_EXECUTABLE: Commande[] = [{
	nom: "executable", usage: "outil executable [<nom> [<chemin> | --oublier]] [--json]",
	resume: "chemins des logiciels à lancer pour exporter ou capturer (moteur, application), propres au poste et jamais dans le dépôt : liste, chemin d'un nom, enregistrement",
	detail: "Sans argument : les logiciels enregistrés pour ce projet. Avec un nom : le chemin à lancer (celui enregistré, sinon celui du PATH), seul sur la sortie standard ; introuvable : code 1 et la marche à suivre. " +
		"Avec un nom et un chemin : enregistre ce chemin (un fichier qui existe ; relatif : au dossier courant) dans executables.json du dossier utilisateur (%APPDATA%/outil sous Windows), jamais dans le dépôt. " +
		"outil publier lance le chemin enregistré quand publier.exporteur commence par ce nom (« godot », « unity »…). Enregistrer et oublier sont refusés sous la veille.",
	exemple: "outil executable godot \"C:/Outils/Godot_v4.7.2/Godot_v4.7.2-stable_win64.exe\"\n  outil executable godot\n  outil executable",
	options: { oublier: "drapeau" }, positionnels: [0, 2],
	refuseeSousVeille: (opt, pos) => Boolean(opt.oublier) || pos.length > 1,
	raisonSousVeille: "le programme lancé sur ce poste est un choix de l'humain. Lire un chemin (outil executable <nom>) reste permis ; sans chemin, le dire dans le compte rendu et dans un point « À valider » des notes (METHODE § 4, « Logiciel à lancer »).",
	faire: async (ctx, pos, opt) => {
		const cfg = chargerConfig(ctx);
		const depuis = path.dirname(cfg.chemin);
		const fichier = fichierExecutables(ctx.env);
		const [nom, chemin] = pos;
		if (nom !== undefined && !NOM_EXECUTABLE.test(nom)) throw usage(`nom : [a-z0-9][a-z0-9._-]{0,39} (par ex. godot, unity, appli), reçu « ${coupe(nom, 40)} »`);
		if (opt.oublier && (nom === undefined || chemin !== undefined)) throw usage("--oublier : outil executable <nom> --oublier");
		if (nom === undefined) {
			const liste = Object.entries(executablesDuProjet(ctx.env, cfg)).map(([n, c]) => ({ nom: n, chemin: c, existe: estFichier(c) }));
			emettre(ctx, { projet: cfg.projet, fichier, executables: liste }, liste.length
				? [`logiciels enregistrés pour ${cfg.projet} (${fichier}) :`, ...liste.map(x => `  ${x.nom} : ${x.chemin}${x.existe ? "" : " (introuvable : réenregistrer)"}`)]
				: `aucun logiciel enregistré pour ${cfg.projet} (outil executable <nom> <chemin>)`);
			return CODES.ok;
		}
		if (opt.oublier || chemin !== undefined) {
			let cible: string | null = null;
			if (chemin !== undefined) {
				cible = path.resolve(ctx.cwd, chemin);
				if (!estFichier(cible)) throw erreur(`${coupe(cible, 200)} : fichier introuvable (le chemin de l'exécutable lui-même, par ex. …/Godot_v4.7.2-stable_win64.exe) : rien n'est enregistré`, { code: "executable_introuvable" });
			}
			const tous = lireFichierUtilisateur(fichier);
			const projet = ((tous[cfg.serveur] ??= {})[cfg.projet] ??= {});
			const avant = typeof projet[nom] === "string" ? projet[nom] : null;
			if (cible) projet[nom] = cible; else delete projet[nom];
			ecrireFichierUtilisateur(fichier, tous);
			emettre(ctx, { projet: cfg.projet, nom, chemin: cible, avant, fichier }, cible
				? [`${nom} : ${cible}${avant && avant !== cible ? ` (remplace ${avant})` : ""}`, `enregistré dans ${fichier} (ce poste seulement, rien à commiter)`]
				: (avant ? `${nom} : oublié (était ${avant})` : `${nom} : rien d'enregistré, rien à oublier`));
			return CODES.ok;
		}
		const r = resoudreExecutable(ctx, cfg, nom, depuis);
		if (!r.chemin) throw erreur(`${nom} : ${r.enregistreAbsent ? `le chemin enregistré n'existe plus (${r.enregistreAbsent}), et ` : "aucun chemin enregistré pour ce projet, et "}introuvable dans le PATH : ${A_FAIRE(nom)}`, { code: "executable_inconnu", nom });
		if (r.enregistreAbsent) ctx.stderr(`attention : le chemin enregistré pour ${nom} n'existe plus (${r.enregistreAbsent}) : celui du PATH est pris`);
		emettre(ctx, { projet: cfg.projet, nom, chemin: r.chemin, source: r.source }, r.chemin);
		return CODES.ok;
	},
}];
