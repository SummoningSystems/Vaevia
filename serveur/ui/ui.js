// Méta-interface (docs/etape3-meta-interface.md § 4) : point d'entrée. Routage par le fragment d'URL (#/…), le
// serveur ne sert que « / » et les fichiers de serveur/ui/ :
//   #/                     accueil (mes projets ; un projet s'ouvre sur son Wiki, /p/<projet>/, hors de cette interface)
//   #/p/<projet>           le Wiki du projet (/p/<projet>/, hors de cette interface) : un projet s'ouvre sur son Wiki
//   #/p/<projet>/kanban    Kanban
//   #/p/<projet>/t/T-<n>   ticket
//   #/p/<projet>/retours   retours du projet
//   #/p/<projet>/membres   membres, invitations, jetons, réglages (mainteneur)
//   #/admin                administration (admin)
//   #/appairage[/<code>]   autoriser un poste (étape 3.5, § 2.2) ; sans code, un champ pour le taper
// Aucune donnée du serveur n'est insérée comme HTML : tout passe par des nœuds texte (js/dom.js).
import { h, remplacer } from "./js/dom.js";
import { lire, seg } from "./js/api.js";
import { ouvrirProjet, fermerProjet, ecouter, actualiserMoi } from "./js/projet.js";
import { fermerMenu } from "./js/commun.js";
import { vueAccueil } from "./js/vue-accueil.js";
import { vueKanban } from "./js/vue-kanban.js";
import { vueTicket } from "./js/vue-ticket.js";
import { vueRetours } from "./js/vue-retours.js";
import { vueMembres } from "./js/vue-membres.js";
import { vueAdmin } from "./js/vue-admin.js";
import { vueAppairage, appairageSansSession } from "./js/vue-appairage.js";

const ID_PROJET = "([a-z0-9-]{1,40})";
// Code d'appairage tel que tapé ou reçu : la vue le valide elle-même (rien n'est envoyé au serveur s'il est mal formé).
const RE_APPAIRAGE = /^\/appairage(?:\/([^/]{0,20}))?$/;
const ROUTES = [
	[/^\/?$/, "accueil"],
	[/^\/admin$/, "admin"],
	[RE_APPAIRAGE, "appairage"],
	[new RegExp(`^/p/${ID_PROJET}$`), "wiki"],
	[new RegExp(`^/p/${ID_PROJET}/kanban$`), "kanban"],
	[new RegExp(`^/p/${ID_PROJET}/t/(T-[1-9]\\d{0,8})$`), "ticket"],
	[new RegExp(`^/p/${ID_PROJET}/retours$`), "retours"],
	[new RegExp(`^/p/${ID_PROJET}/membres$`), "membres"],
];

const vue = document.getElementById("vue");
const navProjet = document.getElementById("nav-projet");
const qui = document.getElementById("qui");
const lienAdmin = document.getElementById("lien-admin");
const direct = document.getElementById("direct");
const marque = document.querySelector("a.marque");

// Lien de la barre qui nomme la vue courante (Accueil, Administration) : aria-current, retiré ailleurs.
function marquerBarre(route) {
	for (const [el, r] of [[marque, "accueil"], [lienAdmin, "admin"]]) {
		if (route === r) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
	}
}

const app = {
	moi: null,
	projet: null,
	noms: new Map(),
	// Titre de l'onglet du navigateur : la vue, puis le projet ouvert (pas de nom de produit).
	titre(t) { const p = this.projet && this.moi && this.moi.projets.find(x => x.id === this.projet.id); document.title = [t, p ? p.titre : ""].filter(Boolean).join(" · ") || "Accueil"; },
	naviguer(hash) { if (location.hash === hash) afficher(); else location.hash = hash; },
	// Nom d'un compte (auteur d'un retour) : connu par la liste des membres, ou soi-même ; sinon l'id.
	nomCompte(id) { return id ? this.noms.get(id) || id : "inconnu"; },
	retenirMembres(liste) { for (const m of liste) this.noms.set(m.compte, m.nom); },
	async relireMoi() { this.moi = await lire("/api/moi"); },
};

let demonter = null;
let numeroAffichage = 0;

async function afficher() {
	const n = ++numeroAffichage;
	fermerMenu(false);
	if (demonter) { try { demonter(); } catch { } demonter = null; }
	delete document.body.dataset.charge;
	let chemin;
	try { chemin = decodeURIComponent(location.hash.replace(/^#/, "")) || "/"; } catch { chemin = "?"; }
	let route = null, params = [];
	for (const [re, nom] of ROUTES) { const m = chemin.match(re); if (m) { route = nom; params = m.slice(1); break; } }
	document.body.dataset.vue = route || "introuvable";
	marquerBarre(route);
	if (!route) {
		fermerProjet(); app.projet = null; dessinerNavProjet(null);
		app.titre("Page introuvable");
		remplacer(vue, h("h1", { tabindex: "-1" }, "Page introuvable"), h("p", null, h("a", { href: "#/" }, "Retour à l'accueil")));
		return focaliser();
	}
	// Étape 3.6 (§ A.2, point 19) : un projet s'ouvre sur son Wiki, comme depuis l'Accueil. Même adresse que l'onglet Wiki.
	if (route === "wiki") {
		fermerProjet(); app.projet = null; dessinerNavProjet(null);
		const cible = `/p/${encodeURIComponent(params[0])}/`;
		remplacer(vue, h("p", { role: "status" }, "Ouverture du Wiki…"));
		location.replace(cible);
		return;
	}
	try {
		if (route === "accueil" || route === "admin" || route === "appairage") {
			fermerProjet(); app.projet = null;
			if (route === "accueil") await app.relireMoi();
			if (n !== numeroAffichage) return;
			dessinerNavProjet(null);
			demonter = (route === "accueil" ? vueAccueil : route === "admin" ? vueAdmin : vueAppairage)(vue, app, params[0]) || null;
		} else {
			const id = params[0];
			// Étape 3.9, E2 : un testeur externe n'a que le Wiki (le serveur lui refuse les autres vues) : on l'y envoie.
			const pm = app.moi && app.moi.projets ? app.moi.projets.find(x => x.id === id) : null;
			if (pm && pm.role === "testeur") { remplacer(vue, h("p", { role: "status" }, "Ouverture du Wiki…")); location.replace(pm.page); return; }
			if (!app.projet || app.projet.id !== id) remplacer(vue, h("p", { class: "chargement", role: "status" }, "Chargement du projet…"));
			const dejaOuvert = !!app.projet && app.projet.id === id;
			const p = await ouvrirProjet(id);
			if (n !== numeroAffichage) return;
			// Projet déjà ouvert : le rôle peut avoir changé depuis (relu en arrière-plan ; la vue se redessine).
			if (dejaOuvert) actualiserMoi(p);
			app.projet = p;
			app.noms.set(p.moi.id, p.moi.nom);
			dessinerNavProjet(p, route);
			const f = { kanban: vueKanban, ticket: vueTicket, retours: vueRetours, membres: vueMembres }[route];
			const d1 = f(vue, app, params[1]);
			const d2 = ecouter(p, r => {
				if (r === "direct") dessinerDirect(p);
				if (r === "moi") dessinerNavProjet(p, route);
				if (r === "retours" || r === "tickets") compterNavProjet(p);
			});
			dessinerDirect(p);
			demonter = () => { if (d1) d1(); d2(); };
			// Noms des auteurs de retours (étape 3.9, écart 31) : lisibles par tout membre (GET …/noms, sans e-mail ; un compte
			// retiré y est « ancien membre »). Comme avant pour un mainteneur : montrés au prochain dessin de la vue.
			if (!app.nomsCharges?.has(id)) {
				(app.nomsCharges ||= new Set()).add(id);
				lire(`/api/p/${seg(id)}/noms`).then(r => { for (const [k, v] of Object.entries((r && r.noms) || {})) app.noms.set(k, v); }).catch(() => { });
			}
		}
	} catch (err) {
		if (n !== numeroAffichage) return;
		fermerProjet(); app.projet = null; dessinerNavProjet(null);
		app.titre("Impossible d'ouvrir cette page");
		const texte = err.statut === 404 ? "Ce projet n'existe pas." : err.statut === 403 ? "Ton compte n'a pas accès à ce projet." : err.message;
		remplacer(vue, h("h1", { tabindex: "-1" }, "Impossible d'ouvrir cette page"), h("p", { class: "message erreur", role: "alert" }, texte), h("p", null, h("a", { href: "#/" }, "Retour à l'accueil")));
		document.body.dataset.charge = "1";
	}
	focaliser();
}

// Après un changement de vue, le focus va au titre (lecteurs d'écran, clavier).
let premiere = true;
function focaliser() {
	if (premiere) { premiere = false; return; }
	const t = vue.querySelector("h1");
	if (t && !vue.contains(document.activeElement)) t.focus({ preventScroll: false });
}

function dessinerNavProjet(p, route) {
	navProjet.hidden = !p;
	// Hors d'un projet (Accueil, erreur, Administration) : ni onglets ni état du direct (sinon « En direct » resterait affiché).
	if (!p) { remplacer(navProjet); direct.hidden = true; return; }
	const titre = (app.moi && app.moi.projets.find(x => x.id === p.id) || {}).titre || p.id;
	// actif : "page" (la vue de l'onglet) ou "true" (une vue qui en dépend : le ticket sous le Kanban).
	const lien = (href, texte, actif, compte) => h("a", { href, "aria-current": actif || null }, texte, compte || null);
	const courant = r => route === r ? "page" : r === "kanban" && route === "ticket" ? "true" : null;
	const m = p.moi.role === "mainteneur" || p.moi.role === "admin";
	// Compteurs (retours à traiter, tickets à faire) : remplis par compterNavProjet, sans redessiner la barre (le focus reste).
	const compte = (role, classe) => h("span", { class: "onglet-compte " + classe, dataset: { role }, hidden: true });
	// Étape 3.6 (§ A.2) : Wiki · Retours · Kanban · Membres. Le Wiki est la page servie du projet (/p/<projet>/, sur
	// l'hôte des pages avec WDD_URL_PAGES), qui porte le même bandeau (serveur/src/bandeau.ts).
	remplacer(navProjet,
		h("span", { class: "projet-nom", title: titre }, titre),
		h("ul", null,
			h("li", null, h("a", { href: `/p/${encodeURIComponent(p.id)}/`, dataset: { role: "page-retours" } }, "Wiki")),
			h("li", null, lien(`#/p/${p.id}/retours`, "Retours", courant("retours"), compte("compte-retours", "nouveaux"))),
			h("li", null, lien(`#/p/${p.id}/kanban`, "Kanban", courant("kanban"), compte("compte-kanban", "a-faire"))),
			m ? h("li", null, lien(`#/p/${p.id}/membres`, "Membres", courant("membres"))) : null));
	compterNavProjet(p);
}

// Compteurs des onglets, d'après les données déjà chargées du projet (aucune requête de plus). Caché à zéro ou tant que
// les données ne sont pas là. Le nombre visible est doublé d'un texte pour les lecteurs d'écran.
function compterNavProjet(p) {
	const poser = (role, n, texte) => {
		const el = navProjet.querySelector(`[data-role=${role}]`);
		if (!el) return;
		el.hidden = !n;
		remplacer(el, n ? [h("span", { "aria-hidden": "true" }, String(n)), h("span", { class: "invisible" }, ` (${texte})`)] : null);
	};
	// Retours à traiter = en attente + questions, comme le bouton flottant du Wiki et l'onglet du bandeau (bandeau.ts).
	const l = p.retours ? [...p.retours.values()] : [];
	const questions = l.filter(r => r.donnees.status === "question").length;
	const aTraiter = questions + l.filter(r => r.donnees.status === "nouveau").length;
	const aFaire = p.tickets ? [...p.tickets.values()].filter(t => !t.illisible && t.donnees.statut === "a-faire").length : 0;
	poser("compte-retours", aTraiter, `${aTraiter} à traiter${questions ? `, dont ${questions} question${questions > 1 ? "s" : ""}` : ""}`);
	poser("compte-kanban", aFaire, `${aFaire} à faire`);
}

function dessinerDirect(p) {
	const textes = { ouvert: "En direct", connexion: "Connexion au direct…", coupe: "Direct coupé : recharge la page" };
	direct.hidden = !p;
	if (!p) return;
	direct.className = "direct " + p.direct;
	// Le texte est dans un span : entre 48 et 64 rem, « En direct » se réduit à son point (ui.css), texte gardé pour les
	// lecteurs d'écran et en info-bulle.
	remplacer(direct, h("span", { class: "direct-texte" }, textes[p.direct] || ""));
	direct.title = textes[p.direct] || "";
}

async function demarrer() {
	try {
		app.moi = await lire("/api/moi");
	} catch (err) {
		// Page d'appairage sans session (§ 2.2) : son propre texte (lien de reconnexion, puis rouvrir ce lien).
		let chemin = "";
		try { chemin = decodeURIComponent(location.hash.replace(/^#/, "")); } catch { }
		if (err.statut === 401 && RE_APPAIRAGE.test(chemin)) {
			document.body.dataset.vue = "appairage";
			appairageSansSession(vue);
			document.body.dataset.charge = "1";
			return;
		}
		document.body.dataset.vue = "connexion";
		app.titre("Connexion");
		remplacer(vue, h("h1", { tabindex: "-1" }, "Connexion"),
			err.statut === 401
				? [h("p", null, "Accès sur invitation : la première fois, ouvre le lien d'invitation que tu as reçu."),
					h("p", { dataset: { role: "texte-401" } }, "Session expirée, ou nouveau navigateur : demande un lien de reconnexion à un mainteneur du projet (ou à l'admin), puis ouvre-le.")]
				: h("p", null, err.statut === 403 ? "Cette interface s'ouvre avec un compte, pas avec un jeton d'agent." : err.message));
		document.body.dataset.charge = "1";
		return;
	}
	remplacer(qui, app.moi.compte.nom);
	qui.parentElement.title = app.moi.compte.nom;
	lienAdmin.hidden = !app.moi.compte.admin;
	window.addEventListener("hashchange", afficher);
	afficher();
}

// Lien « Aller au contenu » : le fragment sert au routage, on donne donc le focus à la zone principale sans changer
// d'adresse (sinon « #principal » serait lu comme une route : « Page introuvable »).
document.querySelector("a.evitement").addEventListener("click", e => {
	e.preventDefault();
	document.getElementById("principal").focus();
});

demarrer();
