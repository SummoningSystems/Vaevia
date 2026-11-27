// Contexte d'un projet ouvert : moi (GET …/session), réglages, tickets et retours tenus à jour par le flux
// (événements « instantane » et « tickets », envoyés à la connexion puis après chaque commit). Un seul flux à la fois :
// changer de projet ferme le précédent.
import { lire, seg } from "./api.js";

let courant = null;

export function projetCourant() { return courant; }

// Rend le projet une fois « moi » et les réglages lus ; un 2e appel pendant le chargement attend le même.
export function ouvrirProjet(id) {
	if (courant && courant.id === id) return courant.pret;
	fermerProjet();
	const p = nouveauProjet(id);
	courant = p;
	p.pret = charger(p);
	p.pret.catch(() => { if (courant === p) fermerProjet(); });
	return p.pret;
}

function nouveauProjet(id) {
	return {
		id,
		moi: null,
		reglages: { disciplines: [], url_commit: "", traitement: "mainteneur" },
		tickets: null,          // Map id → { id, version, donnees } ou { id, illisible, erreur }
		retours: null,          // Map id → { id, version, donnees }
		direct: "connexion",    // connexion | ouvert | coupe
		ecouteurs: new Set(),
		source: null,
		pret: null,
	};
}

async function charger(p) {
	const id = p.id;
	const [moi, reglages] = await Promise.all([lire(`/api/p/${seg(id)}/session`), lire(`/api/p/${seg(id)}/reglages`).catch(() => null)]);
	if (courant !== p) return p;
	p.moi = moi;
	if (reglages) p.reglages = { traitement: "mainteneur", ...reglages };
	brancherFlux(p);
	// Lecture directe aussi : la vue s'affiche même si le flux tarde (proxy, reconnexion).
	Promise.all([lire(`/api/p/${seg(id)}/tickets`), lire(`/api/p/${seg(id)}/retours`)]).then(([t, r]) => {
		if (courant !== p) return;
		if (!p.tickets) poserTickets(p, t);
		if (!p.retours) poserRetours(p, r);
	}).catch(() => { });
	return p;
}

export function fermerProjet() {
	if (!courant) return;
	if (courant.source) courant.source.close();
	courant.ecouteurs.clear();
	courant = null;
}

// Relit « moi » (rôle) : après un 403, ou en revenant sur un projet déjà ouvert. Prévient les vues si le rôle a changé.
export async function actualiserMoi(p) {
	try {
		const moi = await lire(`/api/p/${seg(p.id)}/session`);
		if (courant !== p) return;
		const change = !p.moi || moi.role !== p.moi.role || moi.nom !== p.moi.nom;
		p.moi = moi;
		if (change) avertir(p, "moi");
	} catch { }
}

export async function relireReglages(p) {
	p.reglages = { traitement: "mainteneur", ...await lire(`/api/p/${seg(p.id)}/reglages`) };
	avertir(p, "reglages");
}

// Relit un ticket tout de suite (après un 409, sans attendre le flux).
export async function relireTicket(p, id) {
	const t = await lire(`/api/p/${seg(p.id)}/tickets/${seg(id)}`);
	if (p.tickets) { p.tickets.set(id, t); avertir(p, "tickets"); }
	return t;
}
export async function relireRetours(p) {
	poserRetours(p, await lire(`/api/p/${seg(p.id)}/retours`));
}

// f(raison) appelé à chaque changement : « tickets », « retours », « reglages », « direct », « moi », « demandes »
// (étape 3.5 : une demande de traitement a changé d'état ; la vue relit GET …/demandes).
export function ecouter(p, f) { p.ecouteurs.add(f); return () => p.ecouteurs.delete(f); }

function avertir(p, raison) { for (const f of [...p.ecouteurs]) { try { f(raison); } catch (e) { console.error(e); } } }

function poserTickets(p, corps) {
	if (!corps || !Array.isArray(corps.docs)) return;
	p.tickets = new Map(corps.docs.map(d => [d.id, d]));
	avertir(p, "tickets");
}
function poserRetours(p, corps) {
	if (!corps || !Array.isArray(corps.docs)) return;
	p.retours = new Map(corps.docs.map(d => [d.id, d]));
	avertir(p, "retours");
}

function brancherFlux(p) {
	const s = new EventSource(`/api/p/${seg(p.id)}/flux`);
	p.source = s;
	s.addEventListener("open", () => { p.direct = "ouvert"; avertir(p, "direct"); });
	s.addEventListener("error", () => { p.direct = s.readyState === EventSource.CLOSED ? "coupe" : "connexion"; avertir(p, "direct"); });
	s.addEventListener("tickets", e => { try { poserTickets(p, JSON.parse(e.data)); } catch { } });
	s.addEventListener("instantane", e => { try { poserRetours(p, JSON.parse(e.data)); } catch { } });
	s.addEventListener("demandes", () => avertir(p, "demandes"));
}

// Tickets lisibles, triés par numéro.
export function ticketsLisibles(p) {
	if (!p.tickets) return [];
	return [...p.tickets.values()].filter(t => !t.illisible).sort((a, b) => numero(a.id) - numero(b.id));
}
export const numero = id => Number(String(id).slice(2)) || 0;

// Tickets qui citent un retour.
export function ticketsDuRetour(p, idRetour) {
	return ticketsLisibles(p).filter(t => t.donnees.retours.includes(idRetour));
}

// Teinte d'une discipline : son rang dans les réglages, modulo 6 (six couleurs dans ui.css,
// [data-teinte]). Rend null sans discipline ou pour une discipline retirée des réglages.
export function teinteDiscipline(p, nom) {
	const i = nom ? p.reglages.disciplines.findIndex(x => x.nom === nom) : -1;
	return i < 0 ? null : String(i % 6);
}

export function libelleDiscipline(p, nom) {
	if (!nom) return "";
	const d = p.reglages.disciplines.find(x => x.nom === nom);
	return d ? d.libelle || d.nom : nom;
}
