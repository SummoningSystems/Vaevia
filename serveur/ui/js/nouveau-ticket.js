// Dialogue « Nouveau ticket » : depuis le Kanban (vide) ou depuis des retours choisis (titre proposé à partir du
// premier retour, retours et pages pré-remplis). Rend l'id du ticket créé, ou null si on annule.
import { h, champ, options, court } from "./dom.js";
import { ecrire, seg } from "./api.js";
import { zoneMessage } from "./commun.js";

const PAGE = /^[a-z0-9_-]+:[^\s]{1,200}$/;
// Caractères de contrôle et séparateurs de ligne (U+0085, U+2028, U+2029) : refusés dans un titre d'une ligne.
const CONTROLE = n => n < 32 || n === 127 || n === 0x85 || n === 0x2028 || n === 0x2029;

// Titre proposé : « Tomate : les feuilles jaunissent », une ligne, 200 caractères au plus, sans caractère de contrôle.
export function titrePropose(retour) {
	if (!retour) return "";
	const d = retour.donnees;
	const premier = String(d.text ?? "").split(/\n/).find(l => l.trim()) || "";
	const brut = (d.name ? d.name + " : " : "") + premier;
	return court(Array.from(brut, c => (CONTROLE(c.codePointAt(0)) ? " " : c)).join(""), 200);
}

// Pages « sorte:id » des retours, valides et sans doublon.
export function pagesDesRetours(retours) {
	const vues = new Set();
	for (const r of retours) {
		const p = `${r.donnees.kind}:${r.donnees.ref}`;
		if (PAGE.test(p) && !vues.has(p)) vues.add(p);
	}
	return [...vues].slice(0, 50);
}

export function dialogueNouveauTicket(projet, retours = []) {
	return new Promise(fin => {
		const msg = zoneMessage();
		const titre = h("input", { type: "text", id: "nt-titre-champ", required: true, maxlength: "200", value: titrePropose(retours[0]), autocomplete: "off" });
		const description = h("textarea", { rows: "6", maxlength: "20000", id: "nt-description" });
		if (retours.length) description.value = retours.map(r => `- ${r.donnees.name || r.donnees.ref} : ${court(r.donnees.text, 300)}`).join("\n");
		const disciplines = projet.reglages.disciplines;
		const discipline = h("select", { id: "nt-discipline" }, options([["", "Aucune"], ...disciplines.map(d => [d.nom, d.libelle || d.nom])], ""));
		const pages = h("input", { type: "text", id: "nt-pages", value: pagesDesRetours(retours).join(", "), autocomplete: "off" });
		const criteres = h("textarea", { rows: "3", id: "nt-criteres" });
		const bouton = h("button", { type: "submit", class: "principal" }, "Créer le ticket");
		const d = h("dialog", { class: "dialogue large", "aria-labelledby": "nt-titre" });
		const fermer = v => { if (d.open) d.close(); d.remove(); fin(v); };
		const form = h("form", { method: "dialog", class: "formulaire", dataset: { role: "nouveau-ticket" } },
			h("h2", { id: "nt-titre" }, retours.length ? `Créer un ticket depuis ${retours.length} retour${retours.length > 1 ? "s" : ""}` : "Nouveau ticket"),
			champ("Titre", titre),
			retours.length ? h("div", { class: "champ" }, h("p", { class: "etiquette" }, "Retours liés"),
				h("ul", { class: "retours-choisis", dataset: { role: "retours-lies" } }, retours.map(r => h("li", { dataset: { id: r.id } }, court(`${r.donnees.name || r.donnees.ref} : ${r.donnees.text}`, 120))))) : null,
			champ("Description (Markdown)", description),
			disciplines.length ? champ("Discipline", discipline) : null,
			champ("Pages", pages, "Références « sorte:id », séparées par des virgules."),
			champ("Critères", criteres, "Un critère par ligne."),
			msg,
			h("div", { class: "actions" }, bouton, h("button", { type: "button", on: { click: () => fermer(null) } }, "Annuler")));
		form.addEventListener("submit", async e => {
			e.preventDefault();
			msg.effacer();
			const corps = {
				titre: titre.value.trim(),
				description: description.value,
				retours: retours.map(r => r.id),
				pages: pages.value.split(",").map(s => s.trim()).filter(Boolean),
				criteres: criteres.value.split("\n").map(s => s.trim()).filter(Boolean),
			};
			if (disciplines.length) corps.discipline = discipline.value;
			const mauvaises = corps.pages.filter(p => !PAGE.test(p));
			if (!corps.titre) { msg.dire("Donne un titre au ticket.", "erreur"); titre.focus(); return; }
			if (mauvaises.length) { msg.dire("Pages invalides : " + mauvaises.join(", ") + ". Forme attendue : sorte:id.", "erreur"); pages.focus(); return; }
			corps.pages = [...new Set(corps.pages)];
			bouton.disabled = true;
			try {
				const r = await ecrire("POST", `/api/p/${seg(projet.id)}/tickets`, corps);
				fermer(r.id);
			} catch (err) {
				msg.dire(err.message, "erreur");
				bouton.disabled = false;
			}
		});
		d.append(form);
		d.addEventListener("cancel", e => { e.preventDefault(); fermer(null); });
		document.body.append(d);
		d.showModal();
		titre.focus();
	});
}
