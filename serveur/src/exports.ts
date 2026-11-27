// Étape 3.9 (docs/etape3-9-sections-1-a-6.md, lot 3) :
// - I4 : export des retours, tickets, journal d'audit et approbations d'un projet, en CSV (séparateur « ; », BOM UTF-8,
//   fins de ligne CRLF : s'ouvre tel quel dans un tableur en français) ou en JSON. Formules neutralisées : une cellule
//   qui commence par = + - @ (ou une tabulation, un retour chariot) reçoit une apostrophe devant.
// - E5 : approbations nominatives des points « À valider », calculées sans donnée nouvelle : un retour de sorte
//   « validation », de type « valide », écrit par un compte qui est mainteneur ou admin du projet au moment de l'export.
//   Qui, quand, quel point, et quel build (celui dont la date des données est le « codex » du retour). Un « valide »
//   d'un contributeur est un avis, pas une approbation. Le serveur prouve qu'il a enregistré, pas que la personne a
//   signé (une signature personnelle est un autre chantier).
import type { Base } from "./base.ts";
import type { Depot } from "./depot.ts";
import { listerBuilds, validationsDuDernierBuild } from "./builds.ts";
import type { BuildListe } from "./builds.ts";

type Ligne = Record<string, string | number>;

// Build commenté par un retour : celui dont la date des données est son « codex ». Plusieurs builds avec les mêmes données
// (republication sans changement) : le dernier publié avant le retour, sinon le premier. "" si aucun n'est gardé.
function buildDuRetour(builds: BuildListe[], codex: unknown, cree: unknown): number | "" {
	const l = builds.filter(b => b.donnees && b.donnees === String(codex ?? ""));
	if (!l.length) return "";
	const avant = l.filter(b => b.date <= String(cree ?? ""));
	return avant.length ? Math.max(...avant.map(b => b.build)) : Math.min(...l.map(b => b.build));
}

export function neutraliser(v: unknown): string {
	const s = v === null || v === undefined ? "" : String(v);
	return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}
export function csv(colonnes: string[], lignes: Ligne[]): string {
	const cel = (v: unknown) => { const s = neutraliser(v); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
	return "﻿" + [colonnes.map(cel).join(";"), ...lignes.map(l => colonnes.map(c => cel(l[c])).join(";"))].join("\r\n") + "\r\n";
}

const nomDe = (base: Base, id: unknown): string => { const s = String(id ?? ""); if (!s) return ""; const c = base.compte(s); return c ? (c.desactive ? "ancien membre" : c.nom) : "ancien membre"; };

export function lignesRetours(base: Base, depot: Depot, racine: string, projet: string): Ligne[] {
	const builds = listerBuilds(racine, projet);
	return [...depot.index.entries()].map(([id, d]) => {
		const r = d.donnees;
		return {
			id, statut: String(r.status ?? ""), sorte: String(r.kind ?? ""), ref: String(r.ref ?? ""), nom: String(r.name ?? ""), onglet: String(r.tab ?? ""),
			type: String(r.cat ?? ""), champ: String(r.field ?? ""), texte: String(r.text ?? ""), proposition: String(r.proposal ?? ""), reponse: String(r.reply ?? ""),
			auteur: nomDe(base, r.by), pour: nomDe(base, r.pour), aussi: String(r.aussi ?? "").split(" ").filter(Boolean).map(x => nomDe(base, x)).join(", "),
			fusionne_dans: String(r.fusionne_dans ?? ""), cree: String(r.created ?? ""), modifie: String(r.updated ?? ""), repondu: String(r.replied ?? ""),
			build: buildDuRetour(builds, r.codex, r.created), version: d.version,
		};
	}).sort((a, b) => String(a.cree).localeCompare(String(b.cree)));
}
export const COLONNES_RETOURS = ["id", "statut", "sorte", "ref", "nom", "onglet", "type", "champ", "texte", "proposition", "reponse", "auteur", "pour", "aussi", "fusionne_dans", "cree", "modifie", "repondu", "build", "version"];

export function lignesTickets(base: Base, depot: Depot): Ligne[] {
	const l: Ligne[] = [];
	for (const [id, e] of depot.tickets) {
		if (!("donnees" in e)) continue;
		const t = e.donnees as unknown as { titre?: string; statut?: string; discipline?: string | null; pris_par?: { id?: string; nom?: string } | null; retours?: string[]; pages?: string[]; criteres?: { texte: string; fait: boolean }[]; commits?: { hash: string }[]; auteur?: { nom?: string }; cree?: string; modifie?: string; description?: string };
		const cr = t.criteres || [];
		l.push({ id, titre: t.titre || "", statut: t.statut || "", discipline: t.discipline || "", pris_par: t.pris_par?.nom || (t.pris_par?.id ? nomDe(base, t.pris_par.id) : ""), auteur: t.auteur?.nom || "",
			retours: (t.retours || []).join(" "), pages: (t.pages || []).join(" "), criteres: `${cr.filter(c => c.fait).length}/${cr.length}`, commits: (t.commits || []).map(c => c.hash.slice(0, 12)).join(" "),
			cree: t.cree || "", modifie: t.modifie || "", description: t.description || "" });
	}
	return l.sort((a, b) => Number(String(a.id).slice(2)) - Number(String(b.id).slice(2)));
}
export const COLONNES_TICKETS = ["id", "titre", "statut", "discipline", "pris_par", "auteur", "retours", "pages", "criteres", "commits", "cree", "modifie", "description"];

export function lignesJournal(base: Base, projet: string): Ligne[] {
	const l: Ligne[] = [];
	let avant: number | undefined;
	for (let i = 0; i < 100; i++) {   // 10 000 entrées au plus, par pages de 100, de la plus récente à la plus ancienne
		const e = base.lireJournal(avant, projet, 100);
		for (const x of e) l.push({ id: x.id, quand: x.quand, qui: nomDe(base, x.qui) || x.qui, pour: x.pour ? nomDe(base, x.pour) : "", action: x.action, cible: x.cible, detail: x.detail });
		if (e.length < 100) break;
		avant = e[e.length - 1].id;
	}
	return l;
}
export const COLONNES_JOURNAL = ["id", "quand", "qui", "pour", "action", "cible", "detail"];

export function approbations(base: Base, depot: Depot, racine: string, projet: string): Ligne[] {
	const points = new Map(validationsDuDernierBuild(racine, projet).map(p => [p.id, p]));
	const builds = listerBuilds(racine, projet);
	const l: Ligne[] = [];
	for (const [id, d] of depot.index) {
		const r = d.donnees;
		if (r.kind !== "validation" || r.cat !== "valide" || !r.by) continue;
		const c = base.compte(String(r.by));
		const role = c && !c.desactive ? (c.admin ? "admin" : base.roleProjet(c.id, projet)) : null;
		if (role !== "mainteneur" && role !== "admin") continue;
		const p = points.get(String(r.ref));
		l.push({ point: String(r.ref), texte: p ? p.texte : String(r.name ?? ""), jalon: p ? p.jalon : "", approuve_par: c!.nom, compte: c!.id, role, quand: String(r.created ?? ""),
			build: buildDuRetour(builds, r.codex, r.created), retour: id, statut_retour: String(r.status ?? ""), commentaire: String(r.text ?? "") });
	}
	return l.sort((a, b) => String(a.quand).localeCompare(String(b.quand)));
}
export const COLONNES_APPROBATIONS = ["point", "texte", "jalon", "approuve_par", "compte", "role", "quand", "build", "retour", "statut_retour", "commentaire"];
