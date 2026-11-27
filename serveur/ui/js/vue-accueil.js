// Accueil : mes projets (rôle, retours en attente et questions, tickets à faire, point d'état du traitement des retours). Un projet
// s'ouvre sur son Wiki (étape 3.6, § A.2) ; liens Wiki · Retours · Kanban · Membres. Pour un admin, le bandeau
// d'isolement des pages (§ 2). En tête (étape 3.7, E1), la boîte « À moi » : ce qui attend une réponse de moi.
import { h, remplacer, date } from "./dom.js";
import { LIBELLE_ROLE, zoneMessage, confirmer } from "./commun.js";
import { lire, ecrire, seg } from "./api.js";
import { filtrerRetoursSur } from "./vue-retours.js";

// Bandeau d'isolement : avertissement si les pages de projet sont servies sur la même origine que l'administration.
export function bandeauIsolement(moi, toujours = false) {
	if (!moi.compte.admin) return null;
	const iso = moi.isolement || {};
	if (iso.pages_separees) {
		if (!toujours) return null;
		return h("div", { class: "bandeau ok", role: "note", dataset: { role: "bandeau-isolement" } },
			h("p", null, "Wikis isolés : ils sont servis sur un autre hôte (", h("code", null, iso.url_pages || ""), "), séparé de l'administration."));
	}
	return h("div", { class: "bandeau alerte", role: "note", dataset: { role: "bandeau-isolement" } },
		h("p", null, h("strong", null, "Wikis servis sur la même origine que l'administration. ")),
		h("p", null, "Le Wiki d'un projet contient du contenu envoyé par les agents. Sur la même origine, un script piégé pourrait agir avec les droits d'un admin connecté."),
		h("p", null, "Pour les isoler : poser ", h("code", null, "WDD_URL"), " et ", h("code", null, "WDD_URL_PAGES"),
			" avec un autre nom d'hôte (de préférence un autre domaine), puis redémarrer le serveur. Voir serveur/README.md, « Isolement des pages », et docs/acces-distant.md (HTTPS prêt à l'emploi avec Docker Compose)."));
}

// Même réducteur d'ancre que le gabarit du Wiki (site/gabarit/template.html, slug) : #a-valider--<id réduit>.
const slug = s => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

// Boîte « À moi » (étape 3.7, E1), calculée par le serveur (GET /api/moi, a_moi de chaque projet) : questions de l'agent
// sur mes retours, points « À valider » sans réponse, tickets en revue à fermer (mainteneur). Chaque ligne s'ouvre d'un
// clic : la fiche ou le point dans le Wiki, le ticket dans la méta-interface.
function boiteAMoi(moi) {
	const plusieurs = moi.projets.length > 1;
	const groupes = [];
	const reste = (n, montres) => n > montres ? h("li", { class: "reste" }, `… et ${n - montres} autre${n - montres > 1 ? "s" : ""}`) : null;
	for (const p of moi.projets) {
		const a = p.a_moi;
		if (!a) continue;
		const lignes = [];
		for (const q of a.questions) lignes.push(h("li", { dataset: { type: "question" } },
			h("span", { class: "pastille question" }, "Question"), " ",
			h("a", { href: `${p.page}#${q.ancre}`, dataset: { role: "a-moi-question" } }, q.nom),
			q.question ? h("span", { class: "extrait" }, " — ", q.question) : null));
		const rq = reste(a.total.questions, a.questions.length); if (rq) lignes.push(rq);
		for (const v of a.a_valider) lignes.push(h("li", { dataset: { type: "a-valider" } },
			h("span", { class: "pastille a-valider" }, "À valider"), " ",
			h("a", { href: `${p.page}#a-valider--${slug(v.id)}`, dataset: { role: "a-moi-valider" } }, v.texte || v.id)));
		const rv = reste(a.total.a_valider, a.a_valider.length); if (rv) lignes.push(rv);
		for (const t of a.en_revue) lignes.push(h("li", { dataset: { type: "en-revue" } },
			h("span", { class: "pastille en-revue" }, "En revue"), " ",
			h("a", { href: `#/p/${p.id}/t/${t.id}`, dataset: { role: "a-moi-ticket" } }, `${t.id} · ${t.titre}`)));
		const rt = reste(a.total.en_revue, a.en_revue.length); if (rt) lignes.push(rt);
		// Étape 3.9, E3 : retours qui me sont confiés, et retours qui me mentionnent.
		for (const [cle, lib, role] of [["pour_moi", "Pour toi", "a-moi-pour"], ["mentions", "Mention", "a-moi-mention"]]) {
			for (const r of a[cle] || []) lignes.push(h("li", { dataset: { type: cle } },
				h("span", { class: "pastille " + cle.replace("_", "-") }, lib), " ",
				h("a", { href: `${p.page}#${r.ancre}`, dataset: { role } }, r.nom),
				r.texte ? h("span", { class: "extrait" }, " — ", r.texte) : null));
			const rr = reste((a.total && a.total[cle]) || 0, (a[cle] || []).length); if (rr) lignes.push(rr);
		}
		if (lignes.length) groupes.push(h("div", { class: "a-moi-projet" }, plusieurs ? h("h3", null, p.titre) : null, h("ul", { class: "a-moi-liste" }, lignes)));
	}
	return h("section", { class: "a-moi", "aria-labelledby": "s-a-moi", dataset: { role: "a-moi" } },
		h("h2", { id: "s-a-moi" }, "À moi"),
		groupes.length ? groupes : h("p", { class: "vide a-moi-vide" }, "Rien n'attend ta réponse : ni question de l'agent sur tes retours, ni retour pour toi, ni mention, ni point à valider, ni ticket en revue."));
}

export function vueAccueil(racine, app) {
	const moi = app.moi;
	app.titre("Accueil");
	const liste = moi.projets.length ? h("ul", { class: "projets", dataset: { role: "projets" } }, moi.projets.map(p => {
		const m = p.role === "mainteneur" || p.role === "admin";
		// Étape 3.9, E2 : un testeur externe : le Wiki seul, ses propres retours, la fin de son accès.
		if (p.role === "testeur") return h("li", { class: "projet", dataset: { id: p.id } },
			h("h2", null, h("a", { href: p.page, dataset: { role: "ouvrir-projet" } }, p.titre)),
			h("p", { class: "aide", dataset: { role: "testeur-fin" } }, `Testeur externe · accès jusqu'au ${p.testeur ? date(p.testeur.fin) : "?"}`),
			h("ul", { class: "chiffres" },
				h("li", null, h("strong", null, String(p.retours)), ` retour${p.retours > 1 ? "s" : ""} envoyé${p.retours > 1 ? "s" : ""}`),
				p.retours_questions ? h("li", { class: "questions" }, h("strong", null, String(p.retours_questions)), ` question${p.retours_questions > 1 ? "s" : ""} sur tes retours`) : null),
			h("p", { class: "liens" }, h("a", { href: p.page, dataset: { role: "page-retours" } }, "Wiki")));
		return h("li", { class: "projet", dataset: { id: p.id } },
			h("h2", null, h("a", { href: p.page, dataset: { role: "ouvrir-projet" } }, p.titre)),
			h("p", { class: "aide" }, `${LIBELLE_ROLE[p.role] || p.role} · `, h("code", null, p.id)),
			h("ul", { class: "chiffres" },
				// Des retours attendent : le chiffre mène à la liste filtrée sur « En attente » (même route, filtre posé au clic).
				// Mêmes mots que le Wiki ; l'onglet Retours compte les deux (à traiter = en attente + questions).
				p.retours_nouveaux
					? h("li", { class: "nouveaux" }, h("a", { href: `#/p/${p.id}/retours`, dataset: { role: "retours-nouveaux" }, on: { click: () => filtrerRetoursSur("nouveau") } },
						h("strong", null, String(p.retours_nouveaux)), ` retour${p.retours_nouveaux > 1 ? "s" : ""} en attente`))
					: h("li", null, h("strong", null, "0"), " retour en attente"),
				p.retours_questions
					? h("li", { class: "questions" }, h("a", { href: `#/p/${p.id}/retours`, dataset: { role: "retours-questions" }, on: { click: () => filtrerRetoursSur("question") } },
						h("strong", null, String(p.retours_questions)), ` question${p.retours_questions > 1 ? "s" : ""}`))
					: null,
				h("li", null, h("strong", null, String(p.tickets_a_faire)), ` ticket${p.tickets_a_faire > 1 ? "s" : ""} à faire`),
				// Étape 3.5 (§ 5.4) : une demande de traitement active (en attente ou en cours).
				p.demande ? h("li", { class: "point-etat " + p.demande.etat, dataset: { role: "etat-traitement", etat: p.demande.etat } },
					h("a", { href: `#/p/${p.id}/retours` }, p.demande.etat === "en-cours" ? "Traitement en cours" : "Traitement demandé")) : null),
			h("p", { class: "liens" },
				h("a", { href: p.page, dataset: { role: "page-retours" } }, "Wiki"),
				h("a", { href: `#/p/${p.id}/retours` }, "Retours"),
				h("a", { href: `#/p/${p.id}/kanban` }, "Kanban"),
				m ? h("a", { href: `#/p/${p.id}/membres` }, "Membres") : null));
	})) : h("p", null, "Aucun projet pour l'instant. Demande une invitation à un administrateur.");
	remplacer(racine,
		h("h1", { tabindex: "-1" }, "Mes projets"),
		bandeauIsolement(moi),
		moi.projets.length ? boiteAMoi(moi) : null,
		liste,
		mesSessions());
	document.body.dataset.charge = "1";
}

// Étape 3.9, E4 : mes sessions ouvertes (navigateur, création, dernier accès) ; en fermer une (portable perdu, poste
// partagé). Repliée par défaut ; chargée à l'ouverture. Jamais de secret : un id public par session.
function mesSessions() {
	const m = zoneMessage(), corps = h("tbody");
	async function charger() {
		try {
			const r = await lire("/api/moi/sessions");
			remplacer(corps, r.sessions.map(s => h("tr", { dataset: { session: s.id } },
				h("td", { "data-label": "Navigateur" }, s.navigateur, s.courante ? h("b", null, " (celle-ci)") : null),
				h("td", { "data-label": "Ouverte le" }, date(s.cree)),
				h("td", { "data-label": "Dernier accès" }, date(s.vu)),
				h("td", { "data-label": "" }, h("button", { type: "button", class: s.courante ? "danger" : null, dataset: { role: "fermer-session" }, on: { click: async () => {
					if (s.courante && !await confirmer("Fermer la session de ce navigateur ? Tu seras déconnecté.", "Fermer", true)) return;
					try { await ecrire("DELETE", `/api/moi/sessions/${seg(s.id)}`); if (s.courante) { location.reload(); return; } m.dire("Session fermée.", "succes"); charger(); }
					catch (err) { m.dire(err.message, "erreur"); }
				} } }, s.courante ? "Me déconnecter" : "Fermer")))));
		} catch (err) { m.dire(err.message, "erreur"); }
	}
	const d = h("details", { class: "sessions", dataset: { role: "mes-sessions" } },
		h("summary", null, "Mes sessions"),
		h("p", { class: "aide" }, "Les navigateurs où ton compte est ouvert. Ferme celles que tu ne reconnais pas, ou celle d'un poste partagé."),
		m, h("div", { class: "defile" }, h("table", { class: "tableau" },
			h("thead", null, h("tr", null, ["Navigateur", "Ouverte le", "Dernier accès", ""].map(x => h("th", { scope: "col" }, x)))), corps)));
	d.addEventListener("toggle", () => { if (d.open) charger(); });
	return d;
}
