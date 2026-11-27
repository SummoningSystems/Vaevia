// Vue d'un ticket : description (Markdown rendu sans HTML), critères à cocher, retours liés, pages, commits (liens via
// url_commit), historique (git log du fichier), actions selon les droits. Le formulaire de modification garde la
// version et la saisie : une mise à jour en direct ne l'écrase pas ; un 409 affiche « Quelqu'un a modifié ce ticket
// entre-temps », recharge le ticket et garde ce qui a été tapé.
import { h, remplacer, champ, options, date, court } from "./dom.js";
import { lire, ecrire, seg } from "./api.js";
import { rendreMarkdown } from "./markdown.js";
import { LIBELLE_STATUT, LIBELLE_STATUT_RETOUR, MESSAGE_409, nomPersonne, droits, lienCommit, zoneMessage, confirmer, cleDuFocus, rendreFocus } from "./commun.js";
import { ecouter, libelleDiscipline, teinteDiscipline, relireTicket } from "./projet.js";
import { agir, dialogueFermer, signalerErreur } from "./actions.js";

const PAGE = /^[a-z0-9_\-]+:[^\s]{1,200}$/;

export function vueTicket(racine, app, id) {
	const p = app.projet;
	app.titre(id);
	const msg = zoneMessage();
	const titre = h("h1", { tabindex: "-1" }, id);
	const statut = h("p", { class: "statut-ligne" });
	const actions = h("div", { class: "actions", dataset: { role: "actions" } });
	const infos = h("dl", { class: "infos" });
	const zoneEdition = h("div", { dataset: { role: "edition" } });
	const description = h("div", { class: "markdown", id: "description", dataset: { role: "description" } });
	const criteres = h("ul", { class: "liste-cases", dataset: { role: "criteres" } });
	const retours = h("ul", { class: "liste", dataset: { role: "retours-lies" } });
	const pages = h("ul", { class: "liste" });
	const commits = h("ul", { class: "liste", dataset: { role: "commits" } });
	const zoneCommit = h("div");
	const historique = h("ol", { class: "liste historique", dataset: { role: "historique" } });
	let edition = null;          // formulaire ouvert
	let versionHistorique = -1;
	let formCommit = null;

	remplacer(racine,
		h("p", { class: "fil" }, h("a", { href: `#/p/${p.id}/kanban` }, "← Kanban")),
		titre, statut, msg, actions, infos, zoneEdition,
		h("section", { "aria-labelledby": "s-desc" }, h("h2", { id: "s-desc" }, "Description"), description),
		h("section", { "aria-labelledby": "s-crit" }, h("h2", { id: "s-crit" }, "Critères"), criteres),
		h("section", { "aria-labelledby": "s-ret" }, h("h2", { id: "s-ret" }, "Retours liés"), retours),
		h("section", { "aria-labelledby": "s-pages" }, h("h2", { id: "s-pages" }, "Pages"), pages),
		h("section", { "aria-labelledby": "s-com" }, h("h2", { id: "s-com" }, "Commits"), commits, zoneCommit),
		h("section", { "aria-labelledby": "s-hist" }, h("h2", { id: "s-hist" }, "Historique"), historique));

	const doc = () => (p.tickets ? p.tickets.get(id) : undefined);

	// Repli du focus quand l'élément qui l'avait a disparu : première action, sinon le titre.
	const premiereAction = () => actions.querySelector("button:not([disabled])") || titre;
	// Bouton d'action : après l'action (et son dialogue), le focus revient au même bouton s'il existe encore.
	function bouton(libelle, f, genre, cle) {
		return h("button", { type: "button", class: genre || null, dataset: { cle: "action-" + cle }, on: { click: async () => { await f(); rendreFocus(racine, "action-" + cle, premiereAction); } } }, libelle);
	}

	function dessiner() {
		const cle = cleDuFocus(racine);
		dessinerSans();
		// Mise à jour en direct : le focus clavier reste sur le même bouton ou la même case.
		if (cle) rendreFocus(racine, cle, premiereAction);
	}
	function dessinerSans() {
		const d = doc();
		if (!p.tickets) { remplacer(statut, "Chargement…"); return; }
		if (!d) {
			remplacer(titre, id);
			remplacer(statut, "Ce ticket n'existe pas, ou il a été supprimé.");
			for (const el of [actions, infos, description, criteres, retours, pages, commits, historique]) remplacer(el);
			document.body.dataset.charge = "1";
			return;
		}
		if (d.illisible) {
			remplacer(titre, id);
			remplacer(statut, "Ticket illisible : " + d.erreur + ". À corriger à la main dans le dépôt de design.");
			document.body.dataset.charge = "1";
			return;
		}
		const t = d.donnees, dr = droits(t, p.moi);
		app.titre(`${t.id} · ${t.titre}`);
		remplacer(titre, h("span", { class: "id" }, t.id), " ", h("span", { dataset: { role: "titre" } }, t.titre));
		remplacer(statut, h("span", { class: "badge statut-" + t.statut, dataset: { role: "statut" } }, LIBELLE_STATUT[t.statut]),
			t.pris_par ? ` · ${t.statut === "fait" ? "fait" : "pris"} par ${nomPersonne(t.pris_par)}` : "");

		const a = [];
		if (dr.prendre) a.push(bouton("Prendre", () => agir(p, doc(), "prendre", msg), "principal", "prendre"));
		if (dr.forcer) a.push(bouton("Prendre de force", async () => { if (await confirmer(`Prendre ${t.id}, tenu par ${nomPersonne(t.pris_par)} ? Ce geste est inscrit au journal.`, "Prendre de force", true)) await agir(p, doc(), "forcer", msg); }, null, "forcer"));
		if (dr.revue) a.push(bouton("Passer en revue", () => agir(p, doc(), "statut", msg, "en-revue"), "principal", "revue"));
		if (dr.renvoyer) a.push(bouton("Renvoyer en cours", () => agir(p, doc(), "statut", msg, "pris"), null, "renvoyer"));
		if (dr.rendre) a.push(bouton("Rendre", () => agir(p, doc(), "rendre", msg), null, "rendre"));
		if (dr.fermer) a.push(bouton("Fermer…", async () => { if (await dialogueFermer(p, doc())) msg.dire(`${t.id} fermé.`, "succes"); }, "principal", "fermer"));
		if (dr.rouvrir) a.push(bouton("Rouvrir", () => agir(p, doc(), "rouvrir", msg), null, "rouvrir"));
		if (dr.modifier && !edition) a.push(bouton("Modifier", ouvrirEdition, null, "modifier"));
		if (dr.supprimer) a.push(bouton("Supprimer", async () => {
			if (await confirmer(`Supprimer ${t.id} ? Son numéro ne sera pas réutilisé.`, "Supprimer", true) && await agir(p, doc(), "supprimer", msg)) app.naviguer(`#/p/${p.id}/kanban`);
		}, "danger", "supprimer"));
		remplacer(actions, a);

		remplacer(infos,
			h("dt", null, "Discipline"), h("dd", null, t.discipline ? h("span", { class: "pastille", dataset: { teinte: teinteDiscipline(p, t.discipline) } }, libelleDiscipline(p, t.discipline)) : "aucune"),
			h("dt", null, "Auteur"), h("dd", null, nomPersonne(t.auteur)),
			h("dt", null, "Preneur"), h("dd", { dataset: { role: "preneur" } }, t.pris_par ? nomPersonne(t.pris_par) : "personne"),
			h("dt", null, "Créé"), h("dd", null, date(t.cree)),
			h("dt", null, "Modifié"), h("dd", null, date(t.modifie)),
			h("dt", null, "Version"), h("dd", null, String(d.version)));

		remplacer(description, t.description.trim() ? rendreMarkdown(document, t.description, 3) : h("p", { class: "vide" }, "Pas de description."));

		remplacer(criteres, t.criteres.length ? t.criteres.map((c, i) => {
			const cb = h("input", { type: "checkbox", id: `crit-${i}`, checked: c.fait, disabled: !dr.cocher, dataset: { index: i, cle: "crit-" + i } });
			cb.addEventListener("change", () => cocher(i, cb.checked, cb));
			return h("li", { class: "case" }, cb, h("label", { for: `crit-${i}` }, c.texte));
		}) : h("li", { class: "vide" }, "Aucun critère."));

		remplacer(retours, t.retours.length ? t.retours.map(rid => {
			const r = p.retours && p.retours.get(rid);
			if (!r) return h("li", null, `${rid} (retour supprimé ou pas encore chargé)`);
			const x = r.donnees;
			const ancre = x.anchor ? "#" + encodeURIComponent(x.anchor) : "";
			return h("li", { dataset: { id: rid } },
				h("span", { class: "badge retour-" + x.status }, LIBELLE_STATUT_RETOUR[x.status] || x.status), " ",
				h("a", { href: `/p/${encodeURIComponent(p.id)}/${ancre}`, target: "_blank", rel: "noopener" }, x.name || x.ref), " : ",
				h("span", { class: "texte-retour" }, court(x.text, 400)));
		}) : h("li", { class: "vide" }, "Aucun retour lié."));

		remplacer(pages, t.pages.length ? t.pages.map(pg => h("li", null, h("code", null, pg))) : h("li", { class: "vide" }, "Aucune page."));

		remplacer(commits, t.commits.length ? t.commits.map(c => {
			const u = lienCommit(p.reglages.url_commit, c);
			const court7 = c.hash.slice(0, 7);
			return h("li", null, u ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer", dataset: { hash: c.hash } }, court7) : h("code", { dataset: { hash: c.hash } }, court7),
				c.depot && c.depot !== "code" ? ` (${c.depot})` : "", c.message ? " " + c.message : "");
		}) : h("li", { class: "vide" }, "Aucun commit."));
		if (dr.commits && !formCommit) remplacer(zoneCommit, formCommit = formulaireCommit());
		if (!dr.commits && formCommit) { formCommit = null; remplacer(zoneCommit); }

		if (d.version !== versionHistorique) { versionHistorique = d.version; chargerHistorique(); }
		if (edition) edition.aJour(d);
		document.body.dataset.charge = "1";
	}

	async function chargerHistorique() {
		try {
			const r = await lire(`/api/p/${seg(p.id)}/tickets/${seg(id)}/historique`);
			remplacer(historique, r.historique.length ? r.historique.map(x => h("li", null, h("time", { datetime: x.date }, date(x.date)), " · ", x.auteur, " · ", x.sujet))
				: h("li", { class: "vide" }, "Aucun commit."));
		} catch (e) { remplacer(historique, h("li", { class: "vide" }, "Historique indisponible : " + e.message)); }
	}

	async function cocher(i, fait, cb) {
		const d = doc();
		if (!d) return;
		const liste = d.donnees.criteres.map((c, j) => ({ texte: c.texte, fait: j === i ? fait : c.fait }));
		cb.disabled = true;
		try {
			await ecrire("PATCH", `/api/p/${seg(p.id)}/tickets/${seg(id)}`, { version: d.version, champs: { criteres: liste } });
			msg.dire(`Critère ${fait ? "coché" : "décoché"}.`, "succes");
		} catch (err) {
			cb.checked = !fait;
			await signalerErreur(p, id, err, msg);
		} finally {
			cb.disabled = false;
			// La case est désactivée pendant l'envoi (le focus la quitte) : il y revient.
			rendreFocus(racine, "crit-" + i, premiereAction);
		}
	}

	function formulaireCommit() {
		const m = zoneMessage();
		const hash = h("input", { type: "text", id: "ac-hash", required: true, pattern: "[0-9a-fA-F]{7,40}", autocomplete: "off", spellcheck: "false" });
		const depot = h("input", { type: "text", id: "ac-depot", value: "code", pattern: "[a-z0-9_\\-]{1,40}", autocomplete: "off" });
		const message = h("input", { type: "text", id: "ac-message", maxlength: "200", autocomplete: "off" });
		const f = h("form", { class: "formulaire compact", dataset: { role: "ajout-commit" } },
			h("h3", null, "Ajouter un commit"),
			h("div", { class: "rangee" }, champ("Hash", hash), champ("Dépôt", depot), champ("Message", message)),
			m, h("div", { class: "actions" }, h("button", { type: "submit" }, "Ajouter")));
		f.addEventListener("submit", async e => {
			e.preventDefault();
			const d = doc();
			if (!d) return;
			try {
				const r = await ecrire("POST", `/api/p/${seg(p.id)}/tickets/${seg(id)}/commits`, { version: d.version, commits: [{ hash: hash.value.trim().toLowerCase(), depot: depot.value.trim() || "code", message: message.value.trim() }] });
				m.dire(r.ajoutes ? "Commit ajouté." : "Ce commit était déjà lié.", "succes");
				hash.value = ""; message.value = "";
			} catch (err) { await signalerErreur(p, id, err, m); }
		});
		return f;
	}

	// --- Modification ------------------------------------------------------------------------------------------
	function ouvrirEdition() {
		const d = doc();
		if (!d || d.illisible) return;
		let base = d;                       // version et valeurs de départ
		const sales = new Set();            // champs touchés par la saisie
		const m = zoneMessage();
		const t = d.donnees;
		const eTitre = h("input", { type: "text", required: true, maxlength: "200", value: t.titre, dataset: { champ: "titre" } });
		const eDesc = h("textarea", { rows: "10", maxlength: "20000", dataset: { champ: "description" } });
		eDesc.value = t.description;
		const disciplines = p.reglages.disciplines;
		const eDisc = h("select", { dataset: { champ: "discipline" } }, options([["", "Aucune"], ...disciplines.map(x => [x.nom, x.libelle || x.nom])], t.discipline));
		const ePages = h("input", { type: "text", value: t.pages.join(", "), dataset: { champ: "pages" } });
		const eCrit = h("textarea", { rows: "4", dataset: { champ: "criteres" } });
		eCrit.value = t.criteres.map(c => c.texte).join("\n");
		const note = h("p", { class: "aide", hidden: true });
		const enregistrer = h("button", { type: "submit", class: "principal" }, "Enregistrer");
		const f = h("form", { class: "formulaire carte-form", dataset: { role: "modifier" } },
			h("h2", null, "Modifier le ticket"),
			champ("Titre", eTitre),
			champ("Description (Markdown)", eDesc),
			disciplines.length || t.discipline ? champ("Discipline", eDisc) : null,
			champ("Pages", ePages, "Références « sorte:id », séparées par des virgules."),
			champ("Critères", eCrit, "Un critère par ligne. Les critères gardés restent cochés."),
			note, m,
			h("div", { class: "actions" }, enregistrer, h("button", { type: "button", on: { click: fermerEdition } }, "Annuler")));
		for (const el of [eTitre, eDesc, eDisc, ePages, eCrit]) el.addEventListener("input", () => sales.add(el.dataset.champ));
		eDisc.addEventListener("change", () => sales.add("discipline"));

		const valeur = (champ, x) => ({
			titre: () => eTitre.value.trim(),
			description: () => eDesc.value,
			discipline: () => eDisc.value,
			pages: () => [...new Set(ePages.value.split(",").map(s => s.trim()).filter(Boolean))],
			criteres: () => eCrit.value.split("\n").map(s => s.trim()).filter(Boolean).map(texte => ({ texte, fait: !!(x.criteres.find(c => c.texte === texte) || {}).fait })),
		})[champ]();
		const remettre = (champ, x) => {
			if (champ === "titre") eTitre.value = x.titre;
			if (champ === "description") eDesc.value = x.description;
			if (champ === "discipline") eDisc.value = x.discipline;
			if (champ === "pages") ePages.value = x.pages.join(", ");
			if (champ === "criteres") eCrit.value = x.criteres.map(c => c.texte).join("\n");
		};

		f.addEventListener("submit", async e => {
			e.preventDefault();
			m.effacer();
			const champs = {};
			for (const c of sales) champs[c] = valeur(c, base.donnees);
			if (!Object.keys(champs).length) { fermerEdition(); return; }
			if (champs.titre === "") { m.dire("Le titre ne peut pas être vide.", "erreur"); return; }
			const mauvaises = (champs.pages || []).filter(x => !PAGE.test(x));
			if (mauvaises.length) { m.dire("Pages invalides : " + mauvaises.join(", ") + ".", "erreur"); return; }
			enregistrer.disabled = true;
			try {
				await ecrire("PATCH", `/api/p/${seg(p.id)}/tickets/${seg(id)}`, { version: base.version, champs });
				fermerEdition();
				msg.dire("Ticket enregistré.", "succes");
			} catch (err) {
				enregistrer.disabled = false;
				if (err.statut === 409) {
					// Rechargé ; la saisie reste. Les champs non touchés prennent la nouvelle valeur ; un nouvel
					// « Enregistrer » n'envoie que les champs touchés, sur la nouvelle version.
					m.dire(MESSAGE_409 + ". Le ticket a été rechargé et ta saisie est gardée : vérifie, puis enregistre à nouveau.", "erreur");
					let frais = err.corps && err.corps.document;
					try { frais = await relireTicket(p, id); } catch { }
					if (frais && frais.donnees) {
						base = frais;
						for (const c of ["titre", "description", "discipline", "pages", "criteres"]) if (!sales.has(c)) remettre(c, frais.donnees);
						note.hidden = true;
					}
				} else m.dire(err.message, "erreur");
			}
		});
		edition = {
			// Mise à jour en direct pendant la saisie : rien n'est écrasé, on prévient seulement.
			aJour(dn) {
				if (dn.version !== base.version) {
					note.hidden = false;
					remplacer(note, `Ce ticket a changé pendant ta saisie (version ${dn.version}). Ta saisie est gardée.`);
				}
			},
		};
		remplacer(zoneEdition, f);
		dessiner();
		eTitre.focus();
	}
	function fermerEdition() {
		edition = null;
		remplacer(zoneEdition);
		dessiner();
		rendreFocus(racine, "action-modifier", premiereAction);
	}

	dessiner();
	return ecouter(p, raison => { if (raison === "tickets" || raison === "retours" || raison === "reglages" || raison === "moi") dessiner(); });
}
