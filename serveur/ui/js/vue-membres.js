// Membres du projet (mainteneur ou admin) : rôles, liens de reconnexion (étape 3.5, § 2.4), invitations (création, lien
// à copier, annulation), jetons d'agent (création avec affichage unique de la valeur, origine, expiration, révocation),
// réglages (disciplines, url_commit, qui peut lancer le traitement des retours), notifications par webhook (étape 3.7, I1).
import { h, remplacer, champ, options, date, copier } from "./dom.js";
import { lire, ecrire, seg } from "./api.js";
import { ROLES, LIBELLE_ROLE, zoneMessage, confirmer, estMainteneur, nomPersonne, libelleInvitation } from "./commun.js";
import { relireReglages } from "./projet.js";

const JOUR = 24 * 3600 * 1000;
// Réglage « traitement » (étape 3.5, § 5.1) : qui lance « Traiter les retours ».
const TRAITEMENTS = [["personne", "Personne (désactivé)"], ["mainteneur", "Les mainteneurs et les admins"], ["contributeur", "Les contributeurs, les mainteneurs et les admins"]];

export function vueMembres(racine, app) {
	const p = app.projet;
	app.titre("Membres");
	const base = `/api/p/${seg(p.id)}`;
	if (!estMainteneur(p.moi)) {
		remplacer(racine, h("h1", { tabindex: "-1" }, "Membres"), h("p", null, "Cette page est réservée aux mainteneurs du projet et aux admins."));
		document.body.dataset.charge = "1";
		return;
	}
	const mMembres = zoneMessage(), mInv = zoneMessage(), mJet = zoneMessage(), mReg = zoneMessage();
	const corpsMembres = h("tbody"), listeInv = h("ul", { class: "liste", dataset: { role: "invitations" } });
	const corpsJetons = h("tbody");
	const nouvelleInv = h("div", { dataset: { role: "invitation-creee" } });
	const nouveauJeton = h("div", { dataset: { role: "jeton-cree" } });
	const nouvelleReco = h("div", { dataset: { role: "reconnexion-creee" } });

	// --- Invitation --------------------------------------------------------------------------------------------
	const invRole = h("select", { id: "inv-role" }, options([...ROLES, ["testeur", "Testeur externe"]], "contributeur"));
	const invDuree = h("select", { id: "inv-duree" }, options([["1", "1 jour"], ["7", "7 jours"], ["30", "30 jours"]], "7"));
	// Étape 3.9, E2 : testeur externe : onglets du Wiki qu'il verra (cases du dernier build) et durée de son accès.
	let ongletsWiki = [];
	const invOnglets = h("div", { class: "cases", dataset: { role: "inv-onglets" } });
	const invJours = h("select", { id: "inv-jours" }, options([["7", "7 jours"], ["14", "14 jours"], ["30", "30 jours"], ["90", "90 jours"]], "14"));
	const blocTesteur = h("fieldset", { hidden: true, dataset: { role: "inv-testeur" } }, h("legend", null, "Testeur externe"),
		h("p", { class: "aide" }, "Il ne verra que ces onglets du Wiki (une page construite pour lui, sans notes ni anciennes versions) et ses propres retours : ni ceux des autres, ni le Kanban, ni les membres. Son accès s'arrête seul à la fin de la durée."),
		invOnglets, champ("Accès pendant", invJours, "Compté à partir de l'ouverture du lien. Prolongeable dans la liste des membres."));
	const dessinerOnglets = () => remplacer(invOnglets, ongletsWiki.length
		? ongletsWiki.map(o => h("label", { class: "case" }, h("input", { type: "checkbox", value: o.id, dataset: { onglet: o.id } }), " ", o.label))
		: h("p", { class: "aide" }, "Publie d'abord le Wiki : les onglets à ouvrir se choisissent dans sa dernière version."));
	invRole.addEventListener("change", () => { blocTesteur.hidden = invRole.value !== "testeur"; });
	const formInv = h("form", { class: "formulaire compact", dataset: { role: "form-invitation" } },
		h("div", { class: "rangee" }, champ("Rôle", invRole), champ("Valable", invDuree)),
		blocTesteur,
		h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Créer une invitation")));
	formInv.addEventListener("submit", async e => {
		e.preventDefault();
		mInv.effacer();
		try {
			const testeur = invRole.value === "testeur";
			const corps = { role: invRole.value, expire: new Date(Date.now() + Number(invDuree.value) * JOUR - 60000).toISOString(),
				...(testeur ? { onglets: [...invOnglets.querySelectorAll("input:checked")].map(c => c.value), jours: Number(invJours.value) } : {}) };
			if (testeur && !corps.onglets.length) { mInv.dire("Coche au moins un onglet du Wiki pour le testeur.", "erreur"); return; }
			const r = await ecrire("POST", base + "/invitations", corps);
			const quoi = testeur ? ` Il verra : ${r.onglets.map(o => (ongletsWiki.find(x => x.id === o) || { label: o }).label).join(", ")}, pendant ${r.jours} jours après l'ouverture du lien.` : "";
			remplacer(nouvelleInv, boiteSecret("Lien d'invitation", r.url, `Envoie ce lien à la personne invitée (${LIBELLE_ROLE[r.role]}). Il marche une seule fois, jusqu'au ${date(r.expire)}.${quoi}`, "lien-invitation"));
			chargerMembres();
		} catch (err) { mInv.dire(err.message, "erreur"); }
	});

	// --- Jeton ---------------------------------------------------------------------------------------------------
	const jetNom = h("input", { type: "text", id: "jet-nom", required: true, maxlength: "60", value: "Agent", autocomplete: "off" });
	const jetRole = h("select", { id: "jet-role" }, options([["agent", "Agent"], ["mainteneur", "Mainteneur (import, sans fermeture)"], ["publieur", "Publieur (CI : publier le Wiki, rien d'autre)"], ["clone", "Clone (git clone du dépôt de design, lecture seule)"], ["retour", "Retour (application : créer des retours en ton nom, rien d'autre)"]], "agent"));
	const formJet = h("form", { class: "formulaire compact", dataset: { role: "form-jeton" } },
		h("div", { class: "rangee" }, champ("Nom", jetNom), champ("Rôle du jeton", jetRole)),
		h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Créer un jeton")));
	formJet.addEventListener("submit", async e => {
		e.preventDefault();
		mJet.effacer();
		try {
			const r = await ecrire("POST", base + "/jetons", { nom: jetNom.value.trim(), role: jetRole.value });
			// Étape 3.9, A6 : un jeton « clone » sert de mot de passe à git clone (utilisateur libre).
			const aide = r.role === "retour" ? `Copie-le maintenant : il ne sera plus jamais affiché. Il ne sert qu'à envoyer des retours en ton nom depuis une application (POST …/retours/app, voir docs/retours-depuis-une-application.md) : il ne lit rien. Pour un testeur, préfère l'appairage depuis l'application (son propre jeton).`
				: r.role === "clone" ? `Copie-le maintenant : il ne sera plus jamais affiché. C'est le mot de passe de : git clone ${location.origin}/git/${p.id}.git (utilisateur : n'importe lequel). Lecture seule : il ne sert qu'à cloner et récupérer le dépôt de design.`
				: `Copie-le maintenant : il ne sera plus jamais affiché. Ce qu'il écrit est signé « ${nomPersonne({ nom: r.nom, pour: r.pour })} ». Donne-le à l'agent par OUTIL_JETON.`;
			remplacer(nouveauJeton, boiteSecret(`Jeton « ${r.nom} »`, r.jeton, aide, "valeur-jeton"));
			chargerJetons();
		} catch (err) { mJet.dire(err.message, "erreur"); }
	});

	// --- Réglages ------------------------------------------------------------------------------------------------
	const lignesDisc = h("ol", { class: "disciplines", dataset: { role: "disciplines" } });
	const urlCommit = h("input", { type: "url", id: "reg-url", value: p.reglages.url_commit || "", placeholder: "https://git.exemple/{depot}/commit/{hash}", autocomplete: "off" });
	const traitement = h("select", { id: "reg-traitement" }, options(TRAITEMENTS, p.reglages.traitement || "mainteneur"));
	// Étape 3.9 : plafond d'une vague (G4), traitement lancé par l'envoi d'une série (G3).
	const plafond = h("input", { type: "number", id: "reg-plafond", min: "0", max: "500", step: "1", value: String(p.reglages.plafond_vague || 0), inputmode: "numeric" });
	const serieAuto = h("input", { type: "checkbox", id: "reg-serie", checked: !!p.reglages.traitement_serie });
	const ajoutDisc = h("button", { type: "button", on: { click: () => { lignesDisc.append(ligneDiscipline("", "")); lignesDisc.lastChild.querySelector("input").focus(); } } }, "Ajouter une discipline");
	const formReg = h("form", { class: "formulaire", dataset: { role: "form-reglages" } },
		h("fieldset", null, h("legend", null, "Disciplines (couloirs du Kanban)"), lignesDisc, ajoutDisc),
		champ("Lien des commits", urlCommit, "Gabarit avec {hash} et, si besoin, {depot}. http ou https. Vide : hash sans lien."),
		champ("Qui peut lancer le traitement", traitement, "Bouton « Traiter les retours » des vues Kanban et Retours : un agent en veille sur le poste du code traite les retours. Un admin le peut toujours, sauf avec « Personne »."),
		champ("Plafond d'une vague", plafond, "Retours traités au plus par une demande ; les autres attendent la suivante (0 : sans plafond). Évite qu'une grosse vague atteigne le délai, et borne son coût."),
		h("div", { class: "champ ligne" }, serieAuto, h("label", { for: "reg-serie" }, "Lancer le traitement à l'envoi d'une série de retours"),
			h("p", { class: "aide" }, "Si un agent est en veille et qu'aucune demande n'est active. Chaque série a alors un coût d'agent ; l'agent travaille dans la copie de travail du développeur.")),
		mReg, h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Enregistrer les réglages")));
	function ligneDiscipline(nom, libelle) {
		const n = h("input", { type: "text", value: nom, pattern: "[a-z0-9\\-]{1,30}", maxlength: "30", "aria-label": "Nom technique", placeholder: "nom", autocomplete: "off", dataset: { role: "disc-nom" } });
		const l = h("input", { type: "text", value: libelle, maxlength: "40", "aria-label": "Libellé", placeholder: "Libellé", autocomplete: "off", dataset: { role: "disc-libelle" } });
		const li = h("li", { class: "rangee" }, n, l);
		const deplacer = d => { const autre = d < 0 ? li.previousElementSibling : li.nextElementSibling; if (autre) { d < 0 ? autre.before(li) : autre.after(li); n.focus(); } };
		li.append(
			h("button", { type: "button", "aria-label": "Monter", on: { click: () => deplacer(-1) } }, "↑"),
			h("button", { type: "button", "aria-label": "Descendre", on: { click: () => deplacer(1) } }, "↓"),
			h("button", { type: "button", "aria-label": "Retirer", on: { click: () => { li.remove(); ajoutDisc.focus(); } } }, "Retirer"));
		return li;
	}
	function remplirReglages() {
		remplacer(lignesDisc, p.reglages.disciplines.map(d => ligneDiscipline(d.nom, d.libelle)));
		urlCommit.value = p.reglages.url_commit || "";
		traitement.value = p.reglages.traitement || "mainteneur";
		plafond.value = String(p.reglages.plafond_vague || 0);
		serieAuto.checked = !!p.reglages.traitement_serie;
	}
	formReg.addEventListener("submit", async e => {
		e.preventDefault();
		mReg.effacer();
		const disciplines = [...lignesDisc.children].map(li => ({ nom: li.querySelector("[data-role=disc-nom]").value.trim(), libelle: li.querySelector("[data-role=disc-libelle]").value.trim() }))
			.filter(d => d.nom || d.libelle).map(d => ({ nom: d.nom, libelle: d.libelle || d.nom }));
		try {
			const r = await ecrire("PUT", base + "/reglages", { disciplines, url_commit: urlCommit.value.trim(), traitement: traitement.value, plafond_vague: Math.max(0, Math.min(500, Math.floor(Number(plafond.value) || 0))), traitement_serie: serieAuto.checked });
			await relireReglages(p);
			remplirReglages();
			mReg.dire(r && r.inchange ? "Rien à changer." : "Réglages enregistrés.", "succes");
		} catch (err) {
			const t = err.corps && Array.isArray(err.corps.tickets) && err.corps.tickets.length ? ` (tickets : ${err.corps.tickets.join(", ")})` : "";
			mReg.dire(err.message + t, "erreur");
		}
	});

	// --- Forge du code (étape 3.9, I3) : webhook entrant. « T-12 » dans un message de commit attache le commit au ticket.
	const blocForge = h("div", { dataset: { role: "forge" } });
	const mForge = zoneMessage(), secretForge = h("div", { dataset: { role: "forge-secret" } });
	async function chargerForge() {
		try {
			const f = await lire(base + "/forge");
			const creer = h("button", { type: "button", class: f.actif ? null : "principal", dataset: { role: "forge-creer" }, on: { click: async () => {
				if (f.actif && !await confirmer("Remplacer le secret ? La forge refusera ses envois tant que tu n'y auras pas collé le nouveau.", "Remplacer", true)) return;
				try { const r = await ecrire("POST", base + "/forge"); remplacer(secretForge, boiteSecret("Secret du webhook", r.secret, `Copie-le maintenant : il ne sera plus jamais affiché. Dans la forge : webhook « push », adresse ${r.url}, type JSON, et ce secret (GitHub, Gitea, Forgejo : « Secret » ; GitLab : « Secret token »).`, "forge-secret-valeur")); chargerForge(); }
				catch (err) { mForge.dire(err.message, "erreur"); }
			} } }, f.actif ? "Remplacer le secret" : "Créer le webhook");
			const retirer = f.actif ? h("button", { type: "button", class: "danger", on: { click: async () => {
				if (!await confirmer("Retirer le webhook de la forge ? Ses envois seront refusés.", "Retirer", true)) return;
				try { await ecrire("DELETE", base + "/forge"); remplacer(secretForge); mForge.dire("Webhook retiré.", "succes"); chargerForge(); } catch (err) { mForge.dire(err.message, "erreur"); }
			} } }, "Retirer") : null;
			remplacer(blocForge,
				h("p", { class: "aide" }, "La forge (GitHub, Gitea, Forgejo, GitLab) envoie ses push ici. Un « T-12 » dans le message d'un commit attache ce commit au ticket T-12, comme « outil tickets commit ». Rien n'est fermé : la fermeture reste un geste humain, « fixes T-12 » compris."),
				h("p", { dataset: { role: "forge-etat" } }, f.actif ? [`Adresse : `, h("code", null, f.url), `. Dernier envoi : ${f.dernier ? date(f.dernier) + " (" + f.dernier_resultat + ")" : "aucun"}.`] : "Aucun webhook pour l'instant."),
				mForge, secretForge, h("div", { class: "actions" }, creer, retirer));
		} catch (err) { remplacer(blocForge, h("p", { class: "message erreur" }, err.message)); }
	}

	// --- Notifications (étape 3.7, I1) ------------------------------------------------------------------------------
	// Rien ne part sans réglage. L'adresse n'est jamais relue (le serveur n'en rend que l'hôte) : la laisser vide garde
	// celle qui est enregistrée.
	const mNotif = zoneMessage(), secretNotif = h("div", { dataset: { role: "secret-notif" } });
	const EVTS = [["retour", "Nouveaux retours"], ["question", "Questions de l'agent"], ["revue", "Tickets en revue"], ["traitement", "Traitements finis ou échoués"], ["build", "Wiki publié"]];
	const nUrl = h("input", { type: "url", id: "notif-url", autocomplete: "off", spellcheck: "false", placeholder: "https://…" });
	const nFormat = h("select", { id: "notif-format" }, options([["discord", "Discord"], ["slack", "Slack"], ["teams", "Teams"], ["json", "JSON signé (HMAC)"]], "discord"));
	const nContenu = h("select", { id: "notif-contenu" }, options([["titre", "Nombres et lien seulement"], ["complet", "Avec les noms et des extraits des retours"]], "titre"));
	const nRythme = h("select", { id: "notif-rythme" }, options([["chaque", "À chaque événement (regroupés quelques secondes)"], ["quotidien", "Un résumé par jour"]], "chaque"));
	const nActif = h("input", { type: "checkbox", id: "notif-actif", checked: true });
	const nEvts = EVTS.map(([k, l]) => h("label", { class: "case" }, h("input", { type: "checkbox", value: k, checked: true, dataset: { role: "notif-evt" } }), " ", l));
	const nEtat = h("p", { class: "aide", dataset: { role: "notif-etat" } });
	const nEssai = h("button", { type: "button", dataset: { role: "notif-essai" } }, "Envoyer un essai");
	const nRetirer = h("button", { type: "button", class: "danger", dataset: { role: "notif-retirer" } }, "Retirer");
	const formNotif = h("form", { class: "formulaire", dataset: { role: "form-notifications" } },
		champ("Adresse du webhook", nUrl, "Discord, Slack, Teams, ou tout service qui reçoit du JSON. https seulement. Elle contient un secret : elle n'est jamais réaffichée ; vide = garder celle enregistrée."),
		h("div", { class: "rangee" }, champ("Format", nFormat), champ("Contenu", nContenu), champ("Rythme", nRythme)),
		h("fieldset", null, h("legend", null, "Événements"), ...nEvts),
		h("label", { class: "case" }, nActif, " Actives"),
		h("p", { class: "aide" }, "Le texte d'un retour part chez un service tiers seulement avec « Avec les noms et des extraits ». Rien ne part tant que ce bloc n'est pas enregistré."),
		nEtat, mNotif, secretNotif,
		h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Enregistrer les notifications"), nEssai, nRetirer));
	function montrerNotif(e) {
		nRetirer.hidden = nEssai.hidden = !e.configure;
		if (!e.configure) { nEtat.textContent = "Aucune notification : rien ne sort du serveur pour ce projet."; return; }
		nFormat.value = e.format; nContenu.value = e.contenu; nRythme.value = e.rythme; nActif.checked = e.actif;
		for (const c of formNotif.querySelectorAll("[data-role=notif-evt]")) c.checked = e.evenements.includes(c.value);
		nUrl.placeholder = `enregistrée : ${e.origine || "https://" + e.hote}/…`;
		const d = e.dernier;
		nEtat.textContent = `Vers ${e.hote}${e.actif ? "" : " (désactivées)"}.` + (d ? ` Dernier envoi le ${date(d.quand)} : ${d.ok ? "réussi" : "échoué (" + d.message + ")"}.` : " Aucun envoi pour l'instant.");
	}
	async function chargerNotif() { try { montrerNotif(await lire(base + "/notifications")); } catch (err) { mNotif.dire(err.message, "erreur"); } }
	formNotif.addEventListener("submit", async e => {
		e.preventDefault(); mNotif.effacer(); remplacer(secretNotif);
		const corps = { format: nFormat.value, contenu: nContenu.value, rythme: nRythme.value, actif: nActif.checked, evenements: [...formNotif.querySelectorAll("[data-role=notif-evt]")].filter(c => c.checked).map(c => c.value) };
		if (nUrl.value.trim()) corps.url = nUrl.value.trim();
		try {
			const r = await ecrire("PUT", base + "/notifications", corps);
			nUrl.value = ""; montrerNotif(r);
			mNotif.dire("Notifications enregistrées.", "succes");
			if (r.secret) remplacer(secretNotif, boiteSecret("Secret de signature (format JSON)", r.secret, "En-tête X-WDD-Signature : sha256=HMAC-SHA256(secret, corps). Montré une seule fois.", "secret-signature"));
		} catch (err) { mNotif.dire(err.message, "erreur"); }
	});
	nEssai.addEventListener("click", async () => {
		mNotif.dire("Envoi de l'essai…");
		try { const r = await ecrire("POST", base + "/notifications/essai", {}); mNotif.dire(r.ok ? `Essai reçu (${r.message}).` : `Essai échoué : ${r.message}.`, r.ok ? "succes" : "erreur"); }
		catch (err) { mNotif.dire(err.message, "erreur"); }
		chargerNotif();
	});
	nRetirer.addEventListener("click", async () => {
		if (!await confirmer("Retirer les notifications de ce projet ?", "Retirer", true)) return;
		try { await ecrire("DELETE", base + "/notifications"); mNotif.dire("Notifications retirées.", "succes"); } catch (err) { mNotif.dire(err.message, "erreur"); }
		chargerNotif();
	});

	remplacer(racine,
		h("h1", { tabindex: "-1" }, "Membres"),
		h("section", { "aria-labelledby": "s-membres" }, h("h2", { id: "s-membres" }, "Membres et rôles"), mMembres, nouvelleReco,
			h("div", { class: "defile" }, h("table", { class: "tableau", dataset: { role: "membres" } },
				h("thead", null, h("tr", null, h("th", { scope: "col" }, "Nom"), h("th", { scope: "col" }, "Rôle"), h("th", { scope: "col" }, "Depuis"), h("th", { scope: "col" }, "Actions"))),
				corpsMembres))),
		h("section", { "aria-labelledby": "s-inv" }, h("h2", { id: "s-inv" }, "Invitations"), formInv, mInv, nouvelleInv,
			h("h3", null, "En attente"), listeInv),
		h("section", { "aria-labelledby": "s-jet" }, h("h2", { id: "s-jet" }, "Jetons d'agent"),
			h("p", { class: "aide" }, "Un jeton a pour propriétaire le compte qui le crée. Il ne vaut jamais plus que ce compte."),
			formJet, mJet, nouveauJeton,
			h("div", { class: "defile" }, h("table", { class: "tableau", dataset: { role: "jetons" } },
				h("thead", null, h("tr", null, h("th", { scope: "col" }, "Nom"), h("th", { scope: "col" }, "Rôle"), h("th", { scope: "col" }, "Propriétaire"), h("th", { scope: "col" }, "Origine"), h("th", { scope: "col" }, "Créé"), h("th", { scope: "col" }, "Expire"), h("th", { scope: "col" }, "État"))),
				corpsJetons))),
		h("section", { "aria-labelledby": "s-reg" }, h("h2", { id: "s-reg" }, "Réglages du projet"), formReg),
		h("section", { "aria-labelledby": "s-notif" }, h("h2", { id: "s-notif" }, "Notifications"), formNotif),
		h("section", { "aria-labelledby": "s-forge" }, h("h2", { id: "s-forge" }, "Forge du code"), blocForge));
	remplirReglages();
	chargerNotif();
	chargerForge();

	async function chargerMembres() {
		try {
			const r = await lire(base + "/membres");
			app.retenirMembres(r.membres);
			ongletsWiki = Array.isArray(r.onglets_wiki) ? r.onglets_wiki : [];
			if (!invOnglets.querySelector("input:checked")) dessinerOnglets();
			remplacer(corpsMembres, r.membres.map(m => {
				const moi = m.compte === p.moi.id;
				// Choisir un rôle ne l'écrit pas : il faut « Changer ». Sous Windows, Chromium émet « change » à chaque
				// flèche sur une liste fermée ; une flèche changeait donc le rôle tout de suite.
				const bloque = moi && p.moi.role !== "admin";
				const sel = h("select", { "aria-label": `Rôle de ${m.nom}`, disabled: bloque, dataset: { compte: m.compte, cle: "role-" + m.compte } }, options(m.role === "testeur" ? [["testeur", "Testeur externe"], ...ROLES] : ROLES, m.role));
				// Étape 3.9, E2 : un testeur : ses onglets, la fin de son accès, et « Prolonger » (14 jours à partir d'aujourd'hui).
				const t = m.testeur;
				const infoTesteur = t ? h("div", { class: "aide", dataset: { role: "testeur-info", compte: m.compte } },
					`Onglets : ${t.onglets.map(o => (ongletsWiki.find(x => x.id === o) || { label: o }).label).join(", ") || "aucun"} · ${t.fini ? "accès fini le" : "jusqu'au"} ${date(t.fin)} `,
					h("button", { type: "button", dataset: { role: "prolonger", compte: m.compte }, on: { click: async () => {
						mMembres.effacer();
						try { const x = await ecrire("PUT", `${base}/membres/${seg(m.compte)}`, { onglets: t.onglets, jours: 14 }); mMembres.dire(`${m.nom} : accès jusqu'au ${date(x.testeur.fin)}.`, "succes"); }
						catch (err) { mMembres.dire(err.message, "erreur"); }
						chargerMembres();
					} } }, "Prolonger de 14 jours")) : null;
				const changer = h("button", { type: "button", disabled: true, "aria-label": `Changer le rôle de ${m.nom}`, dataset: { role: "changer-role", compte: m.compte } }, "Changer");
				sel.addEventListener("change", () => { changer.disabled = sel.value === m.role; });
				changer.addEventListener("click", async () => {
					mMembres.effacer();
					changer.disabled = true;
					try {
						const x = await ecrire("PUT", `${base}/membres/${seg(m.compte)}`, { role: sel.value });
						mMembres.dire(`${m.nom} : ${LIBELLE_ROLE[x.role]}.${x.invitations_annulees && x.invitations_annulees.length ? ` ${x.invitations_annulees.length} invitation(s) annulée(s).` : ""}`, "succes");
					} catch (err) { mMembres.dire(err.message, "erreur"); }
					await chargerMembres();
					// Le tableau est redessiné : le focus revient à la liste des rôles de la même ligne.
					const s = corpsMembres.querySelector(`[data-cle="role-${CSS.escape(m.compte)}"]`);
					if (s && !s.disabled) s.focus();
				});
				const retirer = h("button", { type: "button", class: "danger", disabled: moi && p.moi.role !== "admin", on: { click: async () => {
					if (!await confirmer(`Retirer ${m.nom} du projet ? Ses jetons de ce projet seront révoqués.`, "Retirer", true)) return;
					try {
						const x = await ecrire("DELETE", `${base}/membres/${seg(m.compte)}`);
						mMembres.dire(`${m.nom} retiré${x.jetons_revoques.length ? ` ; ${x.jetons_revoques.length} jeton(s) révoqué(s)` : ""}.`, "succes");
					} catch (err) { mMembres.dire(err.message, "erreur"); }
					chargerMembres(); chargerJetons();
				} } }, "Retirer");
				// Étape 3.5 (§ 2.4) : lien de reconnexion, montré une fois. Compte admin : pas de bouton (le serveur le refuse
				// toujours ; son lien se crée dans l'administration). Compte qui a un rôle sur un projet que je ne gère pas :
				// refus du serveur (403), affiché tel quel.
				const reconnexion = m.admin ? h("span", { class: "aide", dataset: { role: "reconnexion-admin", compte: m.compte } }, "Admin : lien de reconnexion dans l'Administration") : h("button", { type: "button", disabled: m.desactive, "aria-label": `Lien de reconnexion pour ${m.nom}`, dataset: { role: "reconnexion", compte: m.compte }, on: { click: async () => {
					mMembres.effacer(); remplacer(nouvelleReco);
					try {
						const x = await ecrire("POST", `${base}/membres/${seg(m.compte)}/reconnexion`, {});
						remplacer(nouvelleReco, boiteSecret(`Lien de reconnexion de ${x.compte.nom}`, x.url, `Envoie ce lien à ${x.compte.nom} seulement : il ouvre une session à son nom dans le navigateur qui l'ouvre, une seule fois, jusqu'au ${date(x.expire)}.`, "lien-reconnexion"));
						await chargerMembres();
						nouvelleReco.querySelector("input").focus();
					} catch (err) { mMembres.dire(err.message, "erreur"); }
				} } }, "Lien de reconnexion");
				return h("tr", { dataset: { compte: m.compte } },
					h("td", { "data-label": "Nom" }, m.nom, moi ? " (toi)" : "", m.desactive ? " · désactivé" : "", infoTesteur),
					h("td", { "data-label": "Rôle" }, h("div", { class: "rangee" }, sel, changer)),
					h("td", { "data-label": "Depuis" }, m.depuis ? date(m.depuis) : "—"),
					h("td", { "data-label": "Actions", class: "boutons" }, reconnexion, retirer));
			}));
			remplacer(listeInv, r.invitations.length ? r.invitations.map(i => h("li", { dataset: { id: i.id } },
				`${libelleInvitation(i, i.compte_cible_nom)} · créée le ${date(i.cree)}${i.par_nom ? " par " + i.par_nom : ""} · expire le ${date(i.expire)} `,
				h("button", { type: "button", on: { click: async () => {
					try { await ecrire("DELETE", `${base}/invitations/${seg(i.id)}`); mInv.dire("Invitation annulée.", "succes"); }
					catch (err) { mInv.dire(err.message, "erreur"); }
					chargerMembres();
				} } }, "Annuler"))) : h("li", { class: "vide" }, "Aucune invitation en attente."));
			document.body.dataset.charge = "1";
		} catch (err) { mMembres.dire(err.message, "erreur"); }
	}
	async function chargerJetons() {
		try {
			const r = await lire(base + "/jetons");
			remplacer(corpsJetons, r.jetons.length ? r.jetons.map(j => h("tr", { dataset: { id: j.id } },
				h("td", { "data-label": "Nom" }, j.nom),
				h("td", { "data-label": "Rôle" }, j.role === "mainteneur" ? "Mainteneur" : j.role === "publieur" ? "Publieur (CI)" : j.role === "clone" ? "Clone (lecture du dépôt)" : "Agent"),
				h("td", { "data-label": "Propriétaire" }, j.pour ? j.pour.nom : "aucun"),
				h("td", { "data-label": "Origine", dataset: { role: "origine" } }, j.origine || "—"),
				h("td", { "data-label": "Créé" }, date(j.cree)),
				h("td", { "data-label": "Expire", dataset: { role: "expire" } }, j.expire ? (j.expiree ? "expiré le " : "le ") + date(j.expire) : "jamais"),
				h("td", { "data-label": "État", dataset: { role: "etat-jeton" } }, j.revoque ? "révoqué le " + date(j.revoque) : j.expiree ? "expiré" : h("button", { type: "button", class: "danger", on: { click: async () => {
					if (!await confirmer(`Révoquer le jeton « ${j.nom} » ? L'agent qui l'utilise perdra l'accès tout de suite.`, "Révoquer", true)) return;
					try { await ecrire("DELETE", `${base}/jetons/${seg(j.id)}`); mJet.dire("Jeton révoqué.", "succes"); }
					catch (err) { mJet.dire(err.message, "erreur"); }
					chargerJetons();
				} } }, "Révoquer")))) : h("tr", null, h("td", { colspan: "7", class: "vide" }, "Aucun jeton.")));
		} catch (err) { mJet.dire(err.message, "erreur"); }
	}
	chargerMembres();
	chargerJetons();
}

// Valeur affichée une fois (lien d'invitation, jeton), avec un bouton « Copier ».
export function boiteSecret(titre, valeur, aide, role) {
	const champVal = h("input", { type: "text", readOnly: true, value: valeur, class: "secret", "aria-label": titre, dataset: { role }, spellcheck: "false" });
	const etat = h("span", { class: "aide", role: "status" });
	return h("div", { class: "boite-secret" },
		h("p", { class: "etiquette" }, titre),
		h("div", { class: "rangee" }, champVal,
			h("button", { type: "button", on: { click: async () => { champVal.select(); etat.textContent = await copier(valeur) ? "Copié." : "Sélectionné : copie avec Ctrl+C."; } } }, "Copier")),
		h("p", { class: "aide" }, aide), etat);
}
