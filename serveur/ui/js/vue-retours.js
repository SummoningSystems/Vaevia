// Retours du projet : tableau filtrable (statut, sorte, auteur, texte), sélection multiple → « Créer un ticket », et
// pour chaque retour les tickets qui le citent. Mis à jour en direct (flux) sans perdre filtres ni sélection. En tête,
// le bandeau « Traitement » (traitement.js).
import { h, remplacer, options, date, court } from "./dom.js";
import { STATUTS_RETOUR, LIBELLE_STATUT_RETOUR, zoneMessage } from "./commun.js";
import { ecouter, ticketsDuRetour } from "./projet.js";
import { dialogueNouveauTicket } from "./nouveau-ticket.js";
import { bandeauTraitement } from "./traitement.js";

const filtres = { statut: "", sorte: "", auteur: "", texte: "" };

// Depuis l'Accueil (« n retours en attente », « n questions ») : la liste s'ouvre filtrée sur ce statut, les autres filtres remis à zéro.
export function filtrerRetoursSur(statut) { Object.assign(filtres, { statut, sorte: "", auteur: "", texte: "" }); }

export function vueRetours(racine, app) {
	const p = app.projet;
	app.titre("Retours");
	const choisis = new Set();
	const msg = zoneMessage();
	const fStatut = h("select", { id: "r-statut" });
	const fSorte = h("select", { id: "r-sorte" });
	const fAuteur = h("select", { id: "r-auteur" });
	const fTexte = h("input", { type: "search", id: "r-texte", value: filtres.texte, autocomplete: "off" });
	const compte = h("p", { class: "aide", role: "status" });
	const creer = h("button", { type: "button", class: "principal", disabled: true, on: { click: creerTicket } }, "Créer un ticket");
	creer.hidden = p.moi.role === "lecteur";
	const tousCase = h("input", { type: "checkbox", id: "r-tous", "aria-label": "Tout sélectionner (retours affichés)" });
	const corps = h("tbody");
	const table = h("table", { class: "tableau retours", dataset: { role: "retours" } },
		h("caption", { class: "invisible" }, "Retours du projet"),
		h("thead", null, h("tr", null,
			// Libellé : agrandit la zone cliquable ; son texte ne se voit que sous 40 rem, où le reste de l'en-tête est masqué.
			h("th", { scope: "col" }, h("label", { class: "case-sel" }, tousCase, h("span", { class: "tout-libelle", "aria-hidden": "true" }, "Tout sélectionner"))),
			h("th", { scope: "col" }, "Élément"), h("th", { scope: "col" }, "Statut"), h("th", { scope: "col" }, "Texte"),
			h("th", { scope: "col" }, "Auteur"), h("th", { scope: "col" }, "Date"), h("th", { scope: "col" }, "Tickets"))),
		corps);
	const traitement = bandeauTraitement(p);
	remplacer(racine,
		h("div", { class: "barre" }, h("h1", { tabindex: "-1" }, "Retours"), creer),
		traitement.el,
		h("div", { class: "filtres", role: "group", "aria-label": "Filtres" },
			h("div", { class: "champ ligne" }, h("label", { for: "r-statut" }, "Statut"), fStatut),
			h("div", { class: "champ ligne" }, h("label", { for: "r-sorte" }, "Sorte"), fSorte),
			h("div", { class: "champ ligne" }, h("label", { for: "r-auteur" }, "Auteur"), fAuteur),
			h("div", { class: "champ ligne" }, h("label", { for: "r-texte" }, "Texte"), fTexte)),
		compte, msg, h("div", { class: "defile" }, table), exporter(p));
	for (const [el, k] of [[fStatut, "statut"], [fSorte, "sorte"], [fAuteur, "auteur"]]) el.addEventListener("change", () => { filtres[k] = el.value; dessiner(); });
	fTexte.addEventListener("input", () => { filtres.texte = fTexte.value; dessiner(); });
	tousCase.addEventListener("change", () => {
		for (const r of visibles()) tousCase.checked ? choisis.add(r.id) : choisis.delete(r.id);
		dessiner();
	});

	function tous() { return p.retours ? [...p.retours.values()].sort((a, b) => String(b.donnees.created).localeCompare(String(a.donnees.created))) : []; }
	function visibles() {
		const t = filtres.texte.trim().toLowerCase();
		return tous().filter(r => {
			const d = r.donnees;
			if (filtres.statut && d.status !== filtres.statut) return false;
			if (filtres.sorte && d.kind !== filtres.sorte) return false;
			if (filtres.auteur && d.by !== filtres.auteur) return false;
			if (t && ![d.text, d.name, d.ref, d.reply, d.proposal].some(x => String(x || "").toLowerCase().includes(t))) return false;
			return true;
		});
	}

	async function creerTicket() {
		const liste = tous().filter(r => choisis.has(r.id)).reverse();
		if (!liste.length) return;
		if (liste.length > 50) { msg.dire("50 retours au plus par ticket.", "erreur"); return; }
		const id = await dialogueNouveauTicket(p, liste);
		if (id) { choisis.clear(); app.naviguer(`#/p/${p.id}/t/${id}`); }
	}

	function dessiner() {
		const focus = document.activeElement && racine.contains(document.activeElement) ? document.activeElement.id : null;
		if (!p.retours) { remplacer(corps, h("tr", null, h("td", { colspan: "7", class: "chargement", role: "status" }, "Chargement des retours…"))); return; }
		const t = tous();
		const uniques = k => [...new Set(t.map(r => r.donnees[k]).filter(Boolean))].sort();
		// Filtre gardé d'un autre projet : remis à « Toutes » / « Tous » s'il n'a plus de valeur ici.
		if (filtres.sorte && !uniques("kind").includes(filtres.sorte)) filtres.sorte = "";
		if (filtres.auteur && !uniques("by").includes(filtres.auteur)) filtres.auteur = "";
		remplacer(fStatut, options([["", "Tous"], ...STATUTS_RETOUR], filtres.statut));
		remplacer(fSorte, options([["", "Toutes"], ...uniques("kind").map(k => [k, k])], filtres.sorte));
		remplacer(fAuteur, options([["", "Tous"], ...uniques("by").map(k => [k, app.nomCompte(k)])], filtres.auteur));
		for (const id of [...choisis]) if (!p.retours.has(id)) choisis.delete(id);
		const v = visibles();
		remplacer(corps, v.length ? v.map(ligne) : h("tr", null, h("td", { colspan: "7", class: "vide" }, "Aucun retour.")));
		tousCase.checked = v.length > 0 && v.every(r => choisis.has(r.id));
		remplacer(compte, `${v.length} retour${v.length > 1 ? "s" : ""} affiché${v.length > 1 ? "s" : ""} sur ${t.length} · ${choisis.size} sélectionné${choisis.size > 1 ? "s" : ""}`);
		creer.disabled = !choisis.size;
		if (focus && document.activeElement !== document.getElementById(focus)) { const el = document.getElementById(focus); if (el) el.focus(); }
		document.body.dataset.charge = "1";
	}

	function ligne(r) {
		const d = r.donnees;
		const cb = h("input", { type: "checkbox", id: "sel-" + r.id, checked: choisis.has(r.id), dataset: { id: r.id }, "aria-label": `Sélectionner le retour sur ${d.name || d.ref}` });
		cb.addEventListener("change", () => { cb.checked ? choisis.add(r.id) : choisis.delete(r.id); dessiner(); });
		const ancre = d.anchor ? "#" + encodeURIComponent(d.anchor) : "";
		const cites = ticketsDuRetour(p, r.id);
		return h("tr", { dataset: { id: r.id } },
			h("td", null, h("label", { class: "case-sel" }, cb)),
			h("td", { "data-label": "Élément" }, h("a", { href: `/p/${encodeURIComponent(p.id)}/${ancre}`, target: "_blank", rel: "noopener" }, d.name || d.ref), h("span", { class: "sorte" }, " · " + d.kind)),
			h("td", { "data-label": "Statut" }, h("span", { class: "badge retour-" + d.status }, LIBELLE_STATUT_RETOUR[d.status] || d.status)),
			h("td", { "data-label": "Texte", class: "texte-retour" }, court(d.text, 300), d.reply ? h("span", { class: "reponse" }, "Réponse : " + court(d.reply, 200)) : null),
			h("td", { "data-label": "Auteur" }, app.nomCompte(d.by)),
			h("td", { "data-label": "Date" }, date(d.created)),
			h("td", { "data-label": "Tickets", dataset: { role: "tickets-cites" } }, cites.length ? cites.map((x, i) => [i ? ", " : "", h("a", { href: `#/p/${p.id}/t/${x.id}` }, x.id)]) : "—"));
	}

	dessiner();
	const d = ecouter(p, raison => { if (raison === "retours" || raison === "tickets") dessiner(); });
	return () => { d(); traitement.demonter(); };
}

// Étape 3.9, I4 et E5 : exports du projet (CSV pour un tableur, séparateur « ; » ; JSON), téléchargés avec la session.
// Le journal d'audit : mainteneur ou admin seulement (le serveur le vérifie aussi).
function exporter(p) {
	const base = `/api/p/${encodeURIComponent(p.id)}/export/`;
	const lien = (quoi, fmt) => h("a", { href: base + quoi + "." + fmt, download: "", dataset: { role: `export-${quoi}-${fmt}` } }, fmt.toUpperCase());
	const ligne = (quoi, libelle) => h("li", null, libelle, " : ", lien(quoi, "csv"), " · ", lien(quoi, "json"));
	const m = p.moi.role === "mainteneur" || p.moi.role === "admin";
	return h("details", { class: "exports", dataset: { role: "exports" } },
		h("summary", null, "Exporter"),
		h("ul", { class: "liste" },
			ligne("retours", "Retours (tous, avec réponses, auteurs et build commenté)"),
			ligne("tickets", "Tickets"),
			ligne("approbations", "Approbations des points « À valider » (qui, quand, quel build)"),
			m ? ligne("journal", "Journal d'audit du projet") : null),
		h("p", { class: "aide" }, "Le CSV s'ouvre dans un tableur (séparateur « ; »). Une cellule qui commencerait par = + - ou @ y reçoit une apostrophe : aucune formule ne s'exécute. Une approbation est le « Validé » d'un mainteneur ou d'un admin ; celui d'un contributeur reste un avis."));
}
