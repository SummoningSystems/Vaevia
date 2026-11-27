// Actions sur un ticket, partagées par le Kanban et la vue Ticket : prendre, rendre, revue, renvoyer, rouvrir,
// fermer (dialogue des retours), supprimer. Chaque écriture porte la version lue ; un 409 affiche « Quelqu'un a modifié
// ce ticket entre-temps » et recharge le ticket.
import { h, court } from "./dom.js";
import { ecrire, seg } from "./api.js";
import { MESSAGE_409, LIBELLE_STATUT_RETOUR, reponseParDefaut, zoneMessage, nomPersonne } from "./commun.js";
import { relireTicket, relireRetours, actualiserMoi } from "./projet.js";

const base = (p, id) => `/api/p/${seg(p.id)}/tickets/${seg(id)}`;

// Erreur d'une écriture sur un ticket : message, et rechargement si 409.
export async function signalerErreur(p, id, err, msg) {
	if (err.statut === 409) {
		// prendre un ticket tenu par un autre : 409 avec la raison du serveur (« ticket tenu par … »).
		const tenu = /tenu par/.test(err.message);
		msg.dire(tenu ? err.message.charAt(0).toUpperCase() + err.message.slice(1) + "." : MESSAGE_409 + ". Le ticket a été rechargé.", "erreur");
		try { await relireTicket(p, id); } catch { }
		return;
	}
	msg.dire(err.message, "erreur");
	// 403 : le rôle a peut-être changé depuis l'ouverture du projet ; relu, les boutons suivent.
	if (err.statut === 403) await actualiserMoi(p);
}

// Déplacement vers un statut (menu « Déplacer vers… », glisser-déposer). Rend vrai si le ticket a changé.
export async function deplacer(p, doc, cible, msg) {
	const t = doc.donnees;
	let action;
	if (cible === "fait") return await dialogueFermer(p, doc);
	if (t.statut === "a-faire" && cible === "pris") action = "prendre";
	else if (t.statut === "fait" && cible === "a-faire") action = "rouvrir";
	else if (cible === "a-faire") action = "rendre";
	else action = "statut";
	return await agir(p, doc, action, msg, cible);
}

export async function agir(p, doc, action, msg, statut) {
	const id = doc.id;
	try {
		if (action === "statut") await ecrire("PATCH", base(p, id), { version: doc.version, champs: { statut } });
		else if (action === "forcer") await ecrire("POST", base(p, id) + "/prendre", { version: doc.version, forcer: true });
		else if (action === "supprimer") await ecrire("DELETE", base(p, id) + "?version=" + doc.version);
		else await ecrire("POST", base(p, id) + "/" + action, { version: doc.version });
		const quoi = { prendre: "pris", forcer: "pris de force", rendre: "rendu", rouvrir: "rouvert", supprimer: "supprimé", statut: statut === "en-revue" ? "passé en revue" : "renvoyé en cours" }[action];
		msg.dire(`${id} ${quoi}.`, "succes");
		return true;
	} catch (err) {
		await signalerErreur(p, id, err, msg);
		return false;
	}
}

// Dialogue de fermeture : retours liés cochés par défaut, réponse modifiable. Ticket et retours cochés passent à
// « fait » en un seul commit (tout ou rien). Rend vrai si le ticket a été fermé.
export function dialogueFermer(p, doc) {
	return new Promise(fin => {
		const t = doc.donnees;
		const msg = zoneMessage();
		const lies = t.retours.map(id => ({ id, r: p.retours && p.retours.get(id) }));
		const cases = lies.map(({ id, r }) => {
			const c = h("input", { type: "checkbox", id: "fr-" + id, checked: !!r, disabled: !r, dataset: { id } });
			return h("li", { class: "case" }, c, h("label", { for: "fr-" + id },
				r ? `${r.donnees.name || r.donnees.ref} : ${court(r.donnees.text, 100)} (${LIBELLE_STATUT_RETOUR[r.donnees.status] || r.donnees.status})` : `${id} (retour supprimé)`));
		});
		const reponse = h("textarea", { rows: "3", id: "fr-reponse" });
		reponse.value = reponseParDefaut(t);
		const bouton = h("button", { type: "submit", class: "principal" }, "Fermer le ticket");
		const d = h("dialog", { class: "dialogue large", "aria-labelledby": "fr-titre", dataset: { role: "fermer" } });
		const sortir = v => { if (d.open) d.close(); d.remove(); fin(v); };
		const form = h("form", { method: "dialog", class: "formulaire" },
			h("h2", { id: "fr-titre" }, `Fermer ${t.id}`),
			h("p", null, t.pris_par ? `Fait par ${nomPersonne(t.pris_par)}.` : ""),
			lies.length ? h("fieldset", null, h("legend", null, "Retours à passer à « fait »"), h("ul", { class: "liste-cases" }, cases))
				: h("p", null, "Aucun retour lié."),
			h("div", { class: "champ" }, h("label", { for: "fr-reponse" }, "Réponse aux retours"), reponse),
			msg,
			h("div", { class: "actions" }, bouton, h("button", { type: "button", on: { click: () => sortir(false) } }, "Annuler")));
		form.addEventListener("submit", async e => {
			e.preventDefault();
			msg.effacer();
			bouton.disabled = true;
			const cochees = [...form.querySelectorAll("input[type=checkbox][data-id]:checked")];
			// Un retour supprimé pendant que le dialogue est ouvert : décoché, désactivé, signalé ; rien n'est envoyé.
			const disparues = cochees.filter(c => !p.retours || !p.retours.get(c.dataset.id));
			if (disparues.length) {
				for (const c of disparues) {
					c.checked = false; c.disabled = true;
					const l = form.querySelector(`label[for="${CSS.escape(c.id)}"]`);
					if (l) l.textContent = `${c.dataset.id} (retour supprimé)`;
				}
				bouton.disabled = false;
				msg.dire(`Retour supprimé entre-temps : ${disparues.map(c => c.dataset.id).join(", ")}. Il est décoché : vérifie et ferme à nouveau.`, "erreur");
				bouton.focus();
				return;
			}
			try {
				const actuel = p.tickets.get(t.id) || doc;
				const corps = { version: actuel.version, retours: cochees.map(c => ({ id: c.dataset.id, version: p.retours.get(c.dataset.id).version })), reponse: reponse.value };
				await ecrire("POST", base(p, t.id) + "/fermer", corps);
				sortir(true);
			} catch (err) {
				bouton.disabled = false;
				if (err.statut === 409 && err.corps && err.corps.id && err.corps.id !== t.id) {
					msg.dire(`Le retour « ${court(err.corps.document?.donnees?.name || err.corps.id, 60)} » a changé entre-temps. Les retours ont été rechargés : vérifie et ferme à nouveau.`, "erreur");
					try { await relireRetours(p); } catch { }
				} else if (err.statut === 409) {
					msg.dire(MESSAGE_409 + ". Le ticket a été rechargé : vérifie et ferme à nouveau.", "erreur");
					try { await relireTicket(p, t.id); } catch { }
				} else msg.dire(err.message, "erreur");
			}
		});
		d.append(form);
		d.addEventListener("cancel", e => { e.preventDefault(); sortir(false); });
		document.body.append(d);
		d.showModal();
		bouton.focus();
	});
}
