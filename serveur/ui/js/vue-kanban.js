// Kanban d'un projet : quatre colonnes, couloirs par discipline si le projet en a, filtres « à moi » et discipline.
// Chaque carte a un menu « Déplacer vers… » (clavier) ; le glisser-déposer fait la même chose à la souris.
// Mises à jour en direct par le flux (événement « tickets »). En tête, le bandeau « Traitement » (traitement.js) et,
// pour un mainteneur ou un admin, le bloc « Brancher un dépôt de code » (branchement.js).
import { h, remplacer, options } from "./dom.js";
import { STATUTS, LIBELLE_STATUT, nomPersonne, estAMoi, estMainteneur, deplacements, boutonMenu, unMenuEstOuvert, siMenuFerme, zoneMessage } from "./commun.js";
import { ecouter, ticketsLisibles, libelleDiscipline, teinteDiscipline } from "./projet.js";
import { deplacer } from "./actions.js";
import { dialogueNouveauTicket } from "./nouveau-ticket.js";
import { bandeauTraitement } from "./traitement.js";
import { blocBranchement } from "./branchement.js";

const filtres = { aMoi: false, discipline: "" };

export function vueKanban(racine, app) {
	const p = app.projet;
	app.titre("Kanban");
	const msg = zoneMessage();
	const aMoi = h("input", { type: "checkbox", id: "f-amoi", checked: filtres.aMoi });
	const disc = h("select", { id: "f-discipline" });
	const tableau = h("div", { class: "kanban", dataset: { role: "kanban" } });
	const illisibles = h("div");
	const nouveau = h("button", { type: "button", class: "principal", on: { click: creer } }, "Nouveau ticket");
	nouveau.hidden = p.moi.role === "lecteur";
	const traitement = bandeauTraitement(p);
	// Construit une fois (replié ou ouvert reste tel quel), mis ou retiré selon le rôle à chaque dessin.
	const branchement = blocBranchement(p, app);
	const zoneBranchement = h("div");
	remplacer(racine,
		h("div", { class: "barre" },
			h("h1", { tabindex: "-1" }, "Kanban"),
			nouveau),
		traitement.el,
		zoneBranchement,
		h("div", { class: "filtres", role: "group", "aria-label": "Filtres" },
			h("div", { class: "case" }, aMoi, h("label", { for: "f-amoi" }, "À moi")),
			h("div", { class: "champ ligne" }, h("label", { for: "f-discipline" }, "Discipline"), disc)),
		msg, illisibles, tableau);
	aMoi.addEventListener("change", () => { filtres.aMoi = aMoi.checked; dessiner(); });
	disc.addEventListener("change", () => { filtres.discipline = disc.value; dessiner(); });

	async function creer() {
		const id = await dialogueNouveauTicket(p);
		if (id) app.naviguer(`#/p/${p.id}/t/${id}`);
	}

	async function choisir(t, cible) {
		msg.effacer();
		const r = await deplacer(p, t, cible, msg);
		if (r) dessiner();
		const b = racine.querySelector(`[data-cle="deplacer-${t.id}"]`);
		if (b) b.focus();
	}

	function carte(doc) {
		const t = doc.donnees;
		const faits = t.criteres.filter(c => c.fait).length;
		const entrees = deplacements(t, p.moi).map(([cible]) => [cible, LIBELLE_STATUT[cible]]);
		const teinte = teinteDiscipline(p, t.discipline);
		const el = h("article", { class: "carte", dataset: { id: t.id, statut: t.statut, teinte }, draggable: entrees.length ? "true" : null, "aria-labelledby": "titre-" + t.id },
			h("p", { class: "carte-id" }, t.id),
			h("h3", { id: "titre-" + t.id }, h("a", { href: `#/p/${p.id}/t/${t.id}`, dataset: { cle: "lien-" + t.id } }, t.titre)),
			h("ul", { class: "carte-infos" },
				t.discipline ? h("li", { class: "pastille", dataset: { teinte } }, libelleDiscipline(p, t.discipline)) : null,
				// Un ticket fermé garde son preneur : c'est « qui l'a fait ».
				t.pris_par ? h("li", { dataset: { role: "preneur" } }, (t.statut === "fait" ? "Fait par " : "Pris par ") + nomPersonne(t.pris_par)) : null,
				h("li", null, `${t.retours.length} retour${t.retours.length > 1 ? "s" : ""}`),
				h("li", null, `${t.commits.length} commit${t.commits.length > 1 ? "s" : ""}`),
				t.criteres.length ? h("li", null, `critères ${faits}/${t.criteres.length}`) : null),
			boutonMenu("Déplacer vers…", "deplacer-" + t.id, entrees, cible => choisir(doc, cible), `Déplacer ${t.id} vers…`));
		el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; });
		return el;
	}

	function colonne(statut, docs) {
		const col = h("section", { class: "colonne", dataset: { statut }, "aria-label": LIBELLE_STATUT[statut] },
			h("h2", null, LIBELLE_STATUT[statut], " ", h("span", { class: "compte" }, String(docs.length))),
			docs.length ? docs.map(carte) : h("p", { class: "vide" }, "Aucun ticket."));
		col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("survol"); });
		col.addEventListener("dragleave", () => col.classList.remove("survol"));
		col.addEventListener("drop", e => {
			e.preventDefault();
			col.classList.remove("survol");
			const id = e.dataTransfer.getData("text/plain");
			const doc = p.tickets && p.tickets.get(id);
			if (!doc || doc.illisible || doc.donnees.statut === statut) return;
			if (!deplacements(doc.donnees, p.moi).some(([c]) => c === statut)) { msg.dire(`${id} ne peut pas aller vers « ${LIBELLE_STATUT[statut]} ».`, "erreur"); return; }
			choisir(doc, statut);
		});
		return col;
	}

	function dessiner() {
		// Un menu ouvert n'est pas détruit sous le clavier : on redessine à sa fermeture.
		if (unMenuEstOuvert()) { siMenuFerme(dessiner); return; }
		const disciplines = p.reglages.disciplines;
		// Filtre gardé d'un autre projet (ou discipline retirée) : remis à « Toutes ».
		if (filtres.discipline && filtres.discipline !== "-" && !disciplines.some(d => d.nom === filtres.discipline)) filtres.discipline = "";
		if (!disciplines.length) filtres.discipline = "";
		remplacer(disc, options([["", "Toutes"], ...disciplines.map(d => [d.nom, d.libelle || d.nom]), ["-", "Sans discipline"]], filtres.discipline));
		disc.parentElement.hidden = !disciplines.length;
		nouveau.hidden = p.moi.role === "lecteur";
		const m = estMainteneur(p.moi);
		if (m !== zoneBranchement.contains(branchement)) remplacer(zoneBranchement, m ? branchement : null);
		if (!p.tickets) { remplacer(tableau, h("p", { class: "chargement", role: "status" }, "Chargement des tickets…")); return; }
		const focus = document.activeElement && racine.contains(document.activeElement) ? document.activeElement.dataset.cle : null;
		let docs = ticketsLisibles(p);
		if (filtres.aMoi) docs = docs.filter(d => estAMoi(d.donnees, p.moi));
		if (filtres.discipline === "-") docs = docs.filter(d => !d.donnees.discipline);
		else if (filtres.discipline) docs = docs.filter(d => d.donnees.discipline === filtres.discipline);
		const bad = [...p.tickets.values()].filter(t => t.illisible);
		remplacer(illisibles, bad.length ? h("p", { class: "message erreur" }, "Tickets illisibles (à corriger dans le dépôt) : " + bad.map(t => t.id).join(", ")) : null);
		const couloirs = disciplines.length ? [...disciplines.map(d => [d.nom, d.libelle || d.nom]), ["", "Sans discipline"]] : [[null, ""]];
		remplacer(tableau, couloirs.map(([nom, libelle]) => {
			const dedans = nom === null ? docs : docs.filter(d => d.donnees.discipline === nom);
			if (nom !== null && !dedans.length && (filtres.discipline || nom === "")) return null;
			const cols = h("div", { class: "colonnes" }, STATUTS.map(([s]) => colonne(s, dedans.filter(d => d.donnees.statut === s))));
			return nom === null ? cols : h("section", { class: "couloir", dataset: { discipline: nom, teinte: teinteDiscipline(p, nom) }, "aria-label": "Couloir " + libelle },
				h("h2", { class: "couloir-titre" }, libelle, " ", h("span", { class: "compte", title: "tickets du couloir" }, String(dedans.length))), cols);
		}));
		if (focus) { const el = racine.querySelector(`[data-cle="${CSS.escape(focus)}"]`); if (el) el.focus(); }
		document.body.dataset.charge = "1";
	}

	dessiner();
	const d = ecouter(p, raison => { if (raison === "tickets" || raison === "reglages" || raison === "moi") dessiner(); });
	return () => { d(); traitement.demonter(); };
}
