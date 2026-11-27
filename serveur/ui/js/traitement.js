// Bandeau « Traitement des retours » (étape 3.5, docs/etape3-5-prise-en-main.md § 5.4), dans les vues Kanban et
// Retours : agents en veille, bouton « Traiter les retours (N en attente) » (ou la raison qui l'empêche), demande active
// avec « Annuler », dix dernières demandes avec leur résumé.
// - Relu (GET …/demandes) à l'ouverture, à chaque événement « demandes » du flux, à la reconnexion du flux et toutes
//   les 10 s : la présence d'un veilleur n'a pas d'événement. Une réponse plus ancienne que la dernière demandée est
//   jetée (prendre puis terminer envoient deux événements de suite).
// - Les âges (« vu il y a 4 s ») avancent sur place chaque seconde, sans nouveau dessin : un dessin garde le focus
//   (data-cle) et les résumés dépliés.
// - journal, resume et raison viennent du poste du code : textes non sûrs, affichés en texte brut (nœuds texte),
//   jamais en Markdown. Le serveur ne les donne qu'au demandeur, aux mainteneurs et aux admins.
import { h, remplacer, date } from "./dom.js";
import { lire, ecrire, seg } from "./api.js";
import { zoneMessage, nomPersonne, ilYa, duree, cleDuFocus, rendreFocus, estMainteneur } from "./commun.js";
import { ecouter, relireReglages, actualiserMoi } from "./projet.js";

// « En attente d'un agent » : « En attente » seul nomme déjà l'état d'un retour (STATUTS_RETOUR), juste au-dessus.
export const LIBELLE_ETAT_DEMANDE = { attente: "En attente d'un agent", "en-cours": "En cours", terminee: "Terminée", echouee: "Échouée", annulee: "Annulée" };
const RELECTURE_MS = 10000;

// Comme le serveur (demandes.ts, peutLancer) : un admin toujours, sauf « personne ». Le serveur reste juge.
export function peutLancer(role, traitement) {
	if (traitement === "personne") return false;
	if (role === "admin" || role === "mainteneur") return true;
	return traitement === "contributeur" && role === "contributeur";
}

// Âge mis à jour chaque seconde : « il y a 4 s » (forme ilya) ou « 3 min » (forme duree).
const age = (iso, forme = "ilya") => h("span", { class: "age", dataset: { depuis: iso || "", forme } }, texteAge(iso, forme));
function texteAge(iso, forme, now = Date.now()) {
	if (!iso) return "";
	return forme === "duree" ? duree(now - Date.parse(iso)) : ilYa(iso, now);
}

export function bandeauTraitement(p) {
	const base = `/api/p/${seg(p.id)}`;
	const msg = zoneMessage();
	const corps = h("div", { class: "traitement-corps" });
	const titre = h("h2", { id: "traitement-titre", tabindex: "-1" }, "Traitement des retours");
	const section = h("section", { class: "traitement", "aria-labelledby": "traitement-titre", dataset: { role: "traitement", etat: "chargement" } }, titre, corps, msg);
	let etat = null, erreur = "", vivant = true, numero = 0, envoi = false, recentesOuvertes = false;
	const resumesOuverts = new Set();
	// Le message d'un geste réussi (demande envoyée, annulation) vaut pour l'état que rend sa réponse : il est effacé quand
	// une lecture lancée APRÈS cette réponse montre un autre état (prise, finie, une autre demande). Une lecture partie
	// avant peut montrer l'état d'avant : elle ne compte pas.
	let etatDuMessage = null, numeroDuMessage = 0;
	const signature = a => a ? `${a.id}:${a.etat}:${a.annulation_demandee ? 1 : 0}` : "aucune";
	const marquer = a => { etatDuMessage = signature(a); numeroDuMessage = numero; };
	// Réponse sans les instants « vu » des veilleurs (qui changent toutes les 5 s) : rien d'autre n'a changé, pas de
	// nouveau dessin (un résumé déplié garderait sinon ni sa position ni la sélection).
	const empreinte = r => JSON.stringify({ ...r, veilleurs: (r.veilleurs || []).map(({ vu, ...x }) => x) });
	let derniere = "";

	async function relire() {
		const n = ++numero;
		try {
			const r = await lire(`${base}/demandes`);
			if (!vivant || n !== numero) return;
			const e = empreinte(r), meme = !erreur && e === derniere;
			etat = r; erreur = ""; derniere = e;
			if (etatDuMessage !== null && n > numeroDuMessage && signature(r.active) !== etatDuMessage) { msg.effacer(); etatDuMessage = null; }
			if (meme) {
				// Seuls les âges des veilleurs changent : mis à jour sur place.
				const spans = section.querySelectorAll("[data-role=veille] span.age");
				(r.veilleurs || []).forEach((v, i) => { if (spans[i]) spans[i].dataset.depuis = v.vu; });
				tic();
				return;
			}
		} catch (err) {
			if (!vivant || n !== numero) return;
			erreur = err.message; derniere = "";
		}
		dessiner();
	}

	function nouveaux() {
		if (!p.retours) return null;
		let n = 0;
		for (const r of p.retours.values()) if (r.donnees && r.donnees.status === "nouveau") n++;
		return n;
	}

	function raisonBouton() {
		const t = p.reglages.traitement || "mainteneur";
		const role = p.moi ? p.moi.role : "";
		if (t === "personne") return "Traitement désactivé pour ce projet (réglage dans Membres → Réglages).";
		if (!peutLancer(role, t)) return t === "contributeur" ? "Réservé aux contributeurs, aux mainteneurs et aux admins (réglage du projet)." : "Réservé aux mainteneurs et aux admins (réglage du projet).";
		if (etat && etat.active) return "Une demande est déjà active : attends sa fin, ou annule-la.";
		if (envoi) return "Envoi de la demande…";
		if (!etat) return "Chargement de l'état du traitement…";
		return "";
	}

	async function lancer() {
		msg.effacer(); etatDuMessage = null;
		envoi = true; dessiner();
		try {
			// Étape 3.9, G5 : le profil choisi (un nom annoncé par un veilleur), sinon la commande par défaut du poste.
			const r = await ecrire("POST", `${base}/demandes`, profilChoisi && profilsProposes().includes(profilChoisi) ? { profil: profilChoisi } : {});
			if (!vivant) return;
			marquer(r);
			msg.dire(r && r.sans_veilleur
				? "Demande envoyée. Aucun agent en veille : elle attend qu'un poste lance outil veille (24 h au plus)."
				: "Demande envoyée : l'agent en veille va la prendre.", "succes");
		} catch (err) {
			if (!vivant) return;
			msg.dire(err.message, "erreur");
			// 403 : réglage ou rôle changé depuis l'ouverture du projet ; relus, le bouton et sa raison suivent.
			if (err.statut === 403) { try { await relireReglages(p); } catch { } await actualiserMoi(p); }
		} finally { envoi = false; }
		if (vivant) await relire();
	}

	async function annuler(d) {
		msg.effacer(); etatDuMessage = null;
		try {
			const r = await ecrire("POST", `${base}/demandes/${seg(d.id)}/annuler`, {});
			if (!vivant) return;
			const x = r && r.demande;
			// Annulée tout de suite : plus de demande active ; en cours : annulation demandée.
			marquer(x && x.etat === "en-cours" ? x : null);
			msg.dire(x && x.etat === "en-cours" ? "Annulation demandée : l'agent s'arrête à son prochain battement." : "Demande annulée.", "succes");
		} catch (err) {
			if (!vivant) return;
			msg.dire(err.message, "erreur");
			if (err.statut === 403) await actualiserMoi(p);
		}
		if (vivant) await relire();
	}

	function ligneVeille() {
		const v = etat ? etat.veilleurs || [] : [];
		if (!v.length) return h("p", { class: "veille aucune", dataset: { role: "veille", veilleurs: "0" } },
			"Aucun agent en veille : sur le poste du code, lancer ", h("code", null, "outil veille"), ".");
		return h("ul", { class: "veille", dataset: { role: "veille", veilleurs: String(v.length) } }, v.map(x =>
			h("li", null, "Agent en veille : ", nomPersonne(x), x.poste ? `, sur ${x.poste}` : "", ", vu ", age(x.vu))));
	}

	function blocActive(d, veilleurs) {
		const moi = p.moi || {};
		const peutAnnuler = !d.annulation_demandee && (estMainteneur(moi) || (d.demandeur && d.demandeur.id === moi.id));
		const parQui = (d.demandeur && d.demandeur.nom ? `, demandée par ${d.demandeur.nom}` : "") + (d.profil ? `, profil « ${d.profil} »` : "");
		const lignes = d.etat === "attente"
			? [h("p", null, h("strong", null, LIBELLE_ETAT_DEMANDE.attente), " depuis ", age(d.cree, "duree"), parQui, "."),
				veilleurs ? null : h("p", { class: "aide" }, "Aucun agent en veille : elle sera prise quand un poste lancera outil veille.")]
			: [h("p", null, h("strong", null, "En cours"), " depuis ", age(d.pris || d.cree, "duree"),
				d.preneur ? `, par ${nomPersonne(d.preneur)}` : "", d.poste ? ` sur ${d.poste}` : "", parQui, ".")];
		if (d.annulation_demandee) lignes.push(h("p", { dataset: { role: "annulation-demandee" } }, "Annulation demandée : l'agent s'arrête à son prochain battement."));
		if (typeof d.journal === "string" && d.journal) lignes.push(texteDepliable(d.id + ":journal", "Dernière sortie de l'agent", d.journal, "journal"));
		return h("div", { class: "demande-active", dataset: { role: "demande-active", etat: d.etat, id: d.id } }, lignes,
			peutAnnuler ? h("div", { class: "actions" }, h("button", { type: "button", dataset: { cle: "annuler", role: "annuler-demande" }, on: { click: () => annuler(d) } }, "Annuler la demande")) : null);
	}

	// Texte brut dépliable (résumé, journal) ; l'état déplié survit aux nouveaux dessins.
	function texteDepliable(cle, libelle, texte, role) {
		const d = h("details", { class: "texte-brut", open: resumesOuverts.has(cle), dataset: { role } },
			h("summary", { dataset: { cle: "deplier-" + cle } }, libelle), h("pre", null, texte));
		d.addEventListener("toggle", () => { d.open ? resumesOuverts.add(cle) : resumesOuverts.delete(cle); });
		return d;
	}

	function blocRecentes() {
		const l = etat ? etat.recentes || [] : [];
		const d = h("details", { class: "recentes", open: recentesOuvertes, dataset: { role: "recentes" } },
			h("summary", { dataset: { cle: "recentes" } }, `Dernières demandes (${l.length})`),
			l.length ? h("ul", { class: "liste-demandes" }, l.map(x => h("li", { dataset: { id: x.id, etat: x.etat } },
				h("p", null, h("strong", null, LIBELLE_ETAT_DEMANDE[x.etat] || x.etat), " · ", date(x.fini || x.cree),
					x.demandeur && x.demandeur.nom ? ` · demandée par ${x.demandeur.nom}` : "",
					x.preneur ? ` · ${nomPersonne(x.preneur)}${x.poste ? " sur " + x.poste : ""}` : "",
					typeof x.raison === "string" && x.raison ? ` · ${x.raison}` : "",
					x.etat === "echouee" && x.code_sortie !== null && x.code_sortie !== undefined ? ` · code de sortie ${x.code_sortie}` : ""),
				typeof x.resume === "string" && x.resume ? texteDepliable(x.id, "Résumé", x.resume, "resume") : null)))
				: h("p", { class: "vide" }, "Aucune demande finie pour l'instant."));
		d.addEventListener("toggle", () => { recentesOuvertes = d.open; });
		return d;
	}

	// Profils proposés par les veilleurs connectés (étape 3.9, G5) ; « » : la commande par défaut.
	let profilChoisi = "";
	const profilsProposes = () => [...new Set((etat ? etat.veilleurs || [] : []).flatMap(v => v.profils || []))].sort();
	function choixProfil() {
		const l = profilsProposes();
		if (!l.length) return null;
		if (profilChoisi && !l.includes(profilChoisi)) profilChoisi = "";
		const s = h("select", { id: "traitement-profil", dataset: { cle: "profil", role: "profil" } },
			[["", "Profil par défaut"], ...l.map(x => [x, `Profil « ${x} »`])].map(([v, lib]) => h("option", { value: v, selected: v === profilChoisi }, lib)));
		s.addEventListener("change", () => { profilChoisi = s.value; });
		return h("div", { class: "champ ligne" }, h("label", { for: "traitement-profil" }, "Profil"), s);
	}
	function dessiner() {
		if (!vivant) return;
		const cle = cleDuFocus(section);
		const n = nouveaux();
		const raison = raisonBouton();
		const bouton = h("button", { type: "button", class: "principal", disabled: !!raison, dataset: { cle: "traiter", role: "traiter" },
			"aria-describedby": raison ? "traitement-raison" : null, on: { click: lancer } },
			n === null ? "Traiter les retours" : `Traiter les retours (${n} en attente)`);
		section.dataset.etat = !etat ? (erreur ? "erreur" : "chargement") : etat.active ? etat.active.etat : "libre";
		remplacer(corps,
			erreur ? h("p", { class: "message erreur" }, "État du traitement illisible : " + erreur) : null,
			etat ? ligneVeille() : null,
			h("div", { class: "actions" }, raison ? null : choixProfil(), bouton, raison ? h("p", { class: "aide", id: "traitement-raison", dataset: { role: "raison" } }, raison) : null),
			etat && etat.active ? blocActive(etat.active, (etat.veilleurs || []).length > 0) : null,
			etat ? blocRecentes() : null);
		if (cle) rendreFocus(section, cle, () => section.querySelector("[data-cle=annuler]") || titre);
	}

	function tic() {
		const now = Date.now();
		for (const s of section.querySelectorAll("span.age[data-depuis]")) {
			const t = texteAge(s.dataset.depuis, s.dataset.forme, now);
			if (s.textContent !== t) s.textContent = t;
		}
	}

	const d = ecouter(p, raison => {
		if (raison === "demandes" || (raison === "direct" && p.direct === "ouvert")) relire();
		else if (raison === "retours" || raison === "reglages" || raison === "moi") dessiner();
	});
	const minuterieRelecture = setInterval(() => { if (!document.hidden) relire(); }, RELECTURE_MS);
	const minuterieAge = setInterval(tic, 1000);
	dessiner();
	relire();
	return {
		el: section,
		demonter() { vivant = false; d(); clearInterval(minuterieRelecture); clearInterval(minuterieAge); },
	};
}
