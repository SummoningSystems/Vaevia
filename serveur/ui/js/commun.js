// Libellés, droits vus par l'interface, messages, dialogues et menu partagés par les vues.
// Les droits calculés ici ne servent qu'à proposer les bons boutons : le serveur reste juge (§ 1.3).
import { h, remplacer } from "./dom.js";

export const STATUTS = [["a-faire", "À faire"], ["pris", "Pris"], ["en-revue", "En revue"], ["fait", "Fait"]];
export const LIBELLE_STATUT = Object.fromEntries(STATUTS);
// Mêmes mots que le Wiki (site/retours/stockage-http.js, « status ») : un retour porte le même nom des deux côtés.
// « À traiter » = en attente + question (compteur de l'onglet Retours, bouton flottant du Wiki).
export const STATUTS_RETOUR = [["nouveau", "En attente"], ["pris", "Pris en compte"], ["question", "Question"], ["fait", "Appliqué"], ["refuse", "Non retenu"]];
export const LIBELLE_STATUT_RETOUR = Object.fromEntries(STATUTS_RETOUR);
export const ROLES = [["lecteur", "Lecteur"], ["contributeur", "Contributeur"], ["mainteneur", "Mainteneur"]];
export const LIBELLE_ROLE = { ...Object.fromEntries(ROLES), admin: "Admin", testeur: "Testeur externe" };
export const MESSAGE_409 = "Quelqu'un a modifié ce ticket entre-temps";
// Libellé d'une ligne d'invitation : un lien de reconnexion (étape 3.5, § 2.4) est une invitation au rôle
// « reconnexion », liée à un compte existant.
export const libelleInvitation = (i, nomCible) => i.role === "reconnexion" ? `Reconnexion de ${nomCible || i.compte_cible || "?"}` : LIBELLE_ROLE[i.role] || i.role;

// Durée lisible : « 20 s », « 3 min », « 2 h », « 3 j ».
export function duree(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	if (s < 86400) return `${Math.floor(s / 3600)} h`;
	return `${Math.floor(s / 86400)} j`;
}
// « il y a 20 s » depuis une date ISO (vide si illisible).
export function ilYa(iso, maintenant = Date.now()) {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? "" : "il y a " + duree(maintenant - t);
}

// « Agent · pour Camille » pour un jeton à propriétaire, le nom sinon.
export function nomPersonne(p) {
	if (!p) return "personne";
	return p.pour && p.pour.nom ? `${p.nom} · pour ${p.pour.nom}` : String(p.nom ?? "");
}

// Moi, vu du projet (GET …/session) : { id, nom, role }.
const estMoi = (p, moi) => !!p && !!moi && p.type === "compte" && p.id === moi.id;
export const estMainteneur = moi => !!moi && (moi.role === "mainteneur" || moi.role === "admin");
export const tient = (t, moi) => (t.statut === "pris" || t.statut === "en-revue") && estMoi(t.pris_par, moi);
export const estAuteur = (t, moi) => estMoi(t.auteur, moi);
export const estAMoi = (t, moi) => estMoi(t.pris_par, moi);

export function droits(t, moi) {
	const lecteur = !moi || moi.role === "lecteur";
	const m = estMainteneur(moi), tenu = tient(t, moi), enCours = t.statut === "pris" || t.statut === "en-revue";
	const champs = !lecteur && (m || (t.statut !== "fait" && estAuteur(t, moi)));
	return {
		modifier: champs,
		cocher: champs || (!lecteur && tenu && t.statut !== "fait"),
		prendre: !lecteur && t.statut === "a-faire",
		forcer: m && enCours && !estMoi(t.pris_par, moi),
		rendre: !lecteur && enCours && (tenu || m),
		revue: !lecteur && t.statut === "pris" && (tenu || m),
		renvoyer: !lecteur && t.statut === "en-revue" && (tenu || m),
		fermer: m && enCours,
		rouvrir: m && t.statut === "fait",
		supprimer: m,
		commits: !lecteur && (tenu || m),
	};
}

// Déplacements permis depuis le statut d'un ticket : [statut cible, action].
export function deplacements(t, moi) {
	const d = droits(t, moi), r = [];
	if (t.statut === "a-faire" && d.prendre) r.push(["pris", "prendre"]);
	if (t.statut === "pris") {
		if (d.rendre) r.push(["a-faire", "rendre"]);
		if (d.revue) r.push(["en-revue", "revue"]);
		if (d.fermer) r.push(["fait", "fermer"]);
	}
	if (t.statut === "en-revue") {
		if (d.rendre) r.push(["a-faire", "rendre"]);
		if (d.renvoyer) r.push(["pris", "renvoyer"]);
		if (d.fermer) r.push(["fait", "fermer"]);
	}
	if (t.statut === "fait" && d.rouvrir) r.push(["a-faire", "rouvrir"]);
	return r;
}

// Lien d'un commit d'après le gabarit url_commit (http(s) seulement), ou null.
export function lienCommit(gabarit, c) {
	if (!gabarit) return null;
	const brut = gabarit.split("{depot}").join(encodeURIComponent(c.depot || "code")).split("{hash}").join(encodeURIComponent(c.hash));
	if (!/^https?:\/\//i.test(brut)) return null;
	try { const u = new URL(brut); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
}

// Réponse par défaut de la fermeture, comme le serveur : « Réglé par T-12 (commits 411d036, 9fe02ab). »
export function reponseParDefaut(t) {
	if (!t.commits.length) return `Réglé par ${t.id}.`;
	const hs = t.commits.slice(0, 10).map(c => c.hash.slice(0, 7));
	return `Réglé par ${t.id} (commit${hs.length > 1 ? "s" : ""} ${hs.join(", ")}${t.commits.length > 10 ? ", …" : ""}).`;
}

// --- Messages -------------------------------------------------------------------------------------------------
// Une zone de message par bloc : role=status, ou role=alert pour une erreur.
export function zoneMessage() {
	const el = h("div", { class: "message", role: "status", hidden: true });
	el.dire = (texte, genre = "info") => {
		el.className = "message " + genre;
		el.setAttribute("role", genre === "erreur" ? "alert" : "status");
		remplacer(el, texte);
		el.hidden = !texte;
	};
	el.effacer = () => { el.hidden = true; remplacer(el); };
	return el;
}

// --- Dialogues --------------------------------------------------------------------------------------------------
// Confirmation dans un <dialog> (pas de window.confirm, bloquant). Geste destructeur (danger) : le focus va sur
// « Annuler », pour qu'un double appui sur Entrée ne supprime rien.
export function confirmer(question, libelleOui = "Confirmer", danger = false) {
	return new Promise(ok => {
		const d = h("dialog", { class: "dialogue", "aria-labelledby": "confirmer-titre", dataset: { role: "confirmer" } });
		const fin = v => { if (d.open) d.close(); d.remove(); ok(v); };
		const annuler = h("button", { type: "button", on: { click: () => fin(false) } }, "Annuler");
		d.append(
			h("h2", { id: "confirmer-titre" }, "Confirmer"),
			h("p", null, question),
			h("div", { class: "actions" },
				h("button", { type: "button", class: danger ? "danger" : "principal", on: { click: () => fin(true) } }, libelleOui),
				annuler));
		d.addEventListener("cancel", e => { e.preventDefault(); fin(false); });
		document.body.append(d);
		d.showModal();
		if (danger) annuler.focus();
	});
}

// Focus gardé à travers un nouveau dessin : l'élément qui avait le focus est retrouvé par sa clé (data-cle). S'il a
// disparu (bouton « Prendre » après la prise), le focus va au repli (première action, sinon le titre).
export function cleDuFocus(racine) {
	const f = document.activeElement;
	return f && f !== document.body && racine.contains(f) && f.dataset && f.dataset.cle ? f.dataset.cle : null;
}
export function rendreFocus(racine, cle, repli) {
	const f = document.activeElement;
	// Le focus est encore sur un élément vivant (champ de saisie, dialogue, autre zone) : on n'y touche pas.
	if (f && f !== document.body && f.isConnected) return;
	const el = cle && racine.querySelector(`[data-cle="${CSS.escape(cle)}"]`);
	const cible = el && !el.disabled ? el : typeof repli === "function" ? repli() : repli;
	if (cible) cible.focus({ preventScroll: !!el });
}

// --- Menu « Déplacer vers… » -------------------------------------------------------------------------------------
// Bouton qui ouvre une liste d'actions : Entrée, Espace ou flèche bas ouvre, flèches pour choisir, Échap ferme.
let menuOuvert = null;
let apresFermeture = null;
export const unMenuEstOuvert = () => !!menuOuvert;
export function siMenuFerme(f) { apresFermeture = f; }

export function boutonMenu(libelle, cle, entrees, choisir, etiquette) {
	const b = h("button", { type: "button", class: "menu-bouton", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": etiquette, dataset: { cle } }, libelle);
	const conteneur = h("div", { class: "menu" }, b);
	if (!entrees.length) { b.disabled = true; b.title = "Aucun déplacement possible pour toi"; return conteneur; }
	const ouvrir = (dernier = false) => {
		fermerMenu(false);
		const items = entrees.map(([valeur, texte]) => h("button", {
			type: "button", role: "menuitem", tabindex: "-1", dataset: { valeur },
			on: { click: () => { fermerMenu(false); choisir(valeur); } },
		}, texte));
		const liste = h("div", { role: "menu", class: "menu-liste", "aria-label": etiquette }, items);
		liste.addEventListener("keydown", e => {
			const i = items.indexOf(document.activeElement);
			if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
			else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
			else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
			else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
			else if (e.key === "Escape") { e.preventDefault(); fermerMenu(); }
			else if (e.key === "Tab") fermerMenu(false);
		});
		conteneur.append(liste);
		b.setAttribute("aria-expanded", "true");
		menuOuvert = { b, liste, conteneur };
		(dernier ? items[items.length - 1] : items[0]).focus();
	};
	b.addEventListener("click", () => (menuOuvert && menuOuvert.b === b ? fermerMenu() : ouvrir()));
	b.addEventListener("keydown", e => {
		if (e.key === "ArrowDown") { e.preventDefault(); ouvrir(); }
		else if (e.key === "ArrowUp") { e.preventDefault(); ouvrir(true); }
	});
	return conteneur;
}

export function fermerMenu(rendreFocus = true) {
	if (!menuOuvert) return;
	const { b, liste } = menuOuvert;
	menuOuvert = null;
	liste.remove();
	b.setAttribute("aria-expanded", "false");
	if (rendreFocus && b.isConnected) b.focus();
	const f = apresFermeture; apresFermeture = null;
	if (f) f();
}
document.addEventListener("mousedown", e => { if (menuOuvert && !menuOuvert.conteneur.contains(e.target)) fermerMenu(false); });
document.addEventListener("focusin", e => { if (menuOuvert && !menuOuvert.conteneur.contains(e.target)) fermerMenu(false); });
