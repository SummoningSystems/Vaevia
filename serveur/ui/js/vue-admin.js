// Administration (admin) : bandeau d'isolement des pages (§ 2), projets, comptes (avec leur lien de reconnexion, étape
// 3.5, § 2.4), invitations, sauvegarde (étape 3.7, A1), état du serveur (étape 3.9, A5), journal d'audit.
import { h, remplacer, champ, options, date } from "./dom.js";
import { lire, ecrire, seg } from "./api.js";
import { ROLES, LIBELLE_ROLE, zoneMessage, confirmer, libelleInvitation } from "./commun.js";
import { bandeauIsolement } from "./vue-accueil.js";
import { boiteSecret } from "./vue-membres.js";

export function vueAdmin(racine, app) {
	app.titre("Administration");
	if (!app.moi.compte.admin) {
		remplacer(racine, h("h1", { tabindex: "-1" }, "Administration"), h("p", null, "Cette page est réservée aux administrateurs."));
		document.body.dataset.charge = "1";
		return;
	}
	const mProj = zoneMessage(), mComptes = zoneMessage(), mInv = zoneMessage(), mJournal = zoneMessage(), mSauv = zoneMessage(), mEtat = zoneMessage();
	const etatServeur = h("div", { dataset: { role: "etat-serveur" } });
	const corpsProjets = h("tbody"), corpsComptes = h("tbody"), corpsInv = h("tbody"), corpsJournal = h("tbody");
	const invCreee = h("div", { dataset: { role: "invitation-creee" } });
	const recoCreee = h("div", { dataset: { role: "reconnexion-creee" } });
	let projets = [];
	// Noms des comptes (id → nom) : un lien de reconnexion de la liste des invitations ne donne que l'id du compte visé.
	const noms = new Map();

	// Projet
	const pId = h("input", { type: "text", id: "ap-id", required: true, pattern: "[a-z0-9\\-]{1,40}", maxlength: "40", autocomplete: "off" });
	const pTitre = h("input", { type: "text", id: "ap-titre", required: true, maxlength: "200", autocomplete: "off" });
	const formProj = h("form", { class: "formulaire compact" },
		h("div", { class: "rangee" }, champ("Identifiant", pId, "Lettres minuscules, chiffres, tirets."), champ("Titre", pTitre)),
		h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Créer le projet")));
	formProj.addEventListener("submit", async e => {
		e.preventDefault();
		try {
			const r = await ecrire("POST", "/api/admin/projets", { id: pId.value.trim(), titre: pTitre.value.trim() });
			mProj.dire(`Projet « ${r.titre} » créé.`, "succes");
			pId.value = ""; pTitre.value = "";
			chargerProjets(); app.relireMoi();
		} catch (err) { mProj.dire(err.message, "erreur"); }
	});

	// Invitation (projet ou admin)
	const iProjet = h("select", { id: "ai-projet" });
	const iRole = h("select", { id: "ai-role" }, options([...ROLES, ["admin", "Admin (tout le serveur)"]], "contributeur"));
	const formInv = h("form", { class: "formulaire compact" },
		h("div", { class: "rangee" }, champ("Projet", iProjet), champ("Rôle", iRole)),
		h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Créer une invitation")));
	iRole.addEventListener("change", () => { iProjet.disabled = iRole.value === "admin"; });
	formInv.addEventListener("submit", async e => {
		e.preventDefault();
		try {
			const corps = { role: iRole.value };
			if (iRole.value !== "admin") corps.projet = iProjet.value;
			const r = await ecrire("POST", "/api/admin/invitations", corps);
			remplacer(invCreee, boiteSecret("Lien d'invitation", r.url, `Il marche une seule fois, jusqu'au ${date(r.expire)}.`, "lien-invitation"));
			chargerInvitations();
		} catch (err) { mInv.dire(err.message, "erreur"); }
	});

	// Sauvegarde (étape 3.7, A1) : état, dernière issue, « Sauvegarder maintenant ».
	const etatSauv = h("div", { dataset: { role: "sauvegarde-etat" } });
	const btnSauv = h("button", { type: "button", class: "principal", dataset: { role: "sauvegarder" } }, "Sauvegarder maintenant");
	const taille = n => n >= 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " Mio" : Math.max(1, Math.round(n / 1024)) + " Kio";
	function montrerSauvegarde(e) {
		const d = e.derniere;
		const derniere = !d ? "Aucune sauvegarde pour l'instant."
			: d.ok ? `Dernière sauvegarde : ${date(d.date)}, ${taille(d.octets || 0)} (${d.nom}).`
				: `Dernière tentative échouée, le ${date(d.date)} : ${d.message || "erreur inconnue"}.`;
		remplacer(etatSauv,
			h("p", { class: d && !d.ok ? "message erreur" : null, dataset: { role: "sauvegarde-derniere" } }, derniere),
			h("p", null, "Dossier : ", h("code", null, e.dossier)),
			h("p", { class: "aide" }, e.heures > 0 ? `Sauvegarde automatique toutes les ${String(e.heures).replace(".", ",")} h ; les ${e.garder} plus récentes sont gardées.` : "Pas de sauvegarde automatique (WDD_SAUVEGARDE_HEURES=0)."),
			h("p", { class: "aide" }, "La sauvegarde contient les empreintes des jetons et des sessions : garde-la comme un secret. Mets de préférence le dossier sur un autre disque (WDD_SAUVEGARDE). Pour restaurer : arrêter le serveur, puis ", h("code", null, "installer.cmd -Restaurer <dossier de la sauvegarde>"), "."));
		btnSauv.disabled = !!e.en_cours;
	}
	async function chargerSauvegarde() {
		try { montrerSauvegarde(await lire("/api/admin/sauvegarde")); } catch (err) { mSauv.dire(err.message, "erreur"); }
	}
	btnSauv.addEventListener("click", async () => {
		btnSauv.disabled = true; mSauv.dire("Sauvegarde en cours…");
		try {
			const r = await ecrire("POST", "/api/admin/sauvegarde", {});
			montrerSauvegarde(r);
			mSauv.dire(`Sauvegarde faite : ${r.sauvegarde.fichiers} fichiers, ${taille(r.sauvegarde.octets)}.`, "succes");
			chargerJournal(false);
		} catch (err) { mSauv.dire(err.message, "erreur"); chargerSauvegarde(); }
		finally { btnSauv.disabled = false; }
	});

	// État du serveur (étape 3.9, A5) : version, place par projet, veilleurs connectés, échecs récents.
	async function chargerEtat() {
		try {
			const e = await lire("/api/admin/etat");
			const total = p => p.place.builds + p.place.depot + p.place.captures;
			remplacer(etatServeur,
				h("p", { dataset: { role: "version" } }, `Version de l'outil : ${e.version} · Node ${e.node} · serveur démarré le ${date(e.debut)}.`),
				h("div", { class: "defile" }, h("table", { class: "tableau", dataset: { role: "etat-projets" } },
					h("thead", null, h("tr", null, ["Projet", "Place", "Builds gardés", "Veilleurs connectés"].map(x => h("th", { scope: "col" }, x)))),
					h("tbody", null, e.projets.length ? e.projets.map(p => h("tr", { dataset: { projet: p.id } },
						h("td", { "data-label": "Projet" }, p.titre, " ", h("code", null, p.id)),
						h("td", { "data-label": "Place" }, `${taille(total(p))} (builds ${taille(p.place.builds)}, dépôt ${taille(p.place.depot)}, captures ${taille(p.place.captures)})`),
						h("td", { "data-label": "Builds gardés" }, `${p.builds}${p.dernier ? ` (dernier : n° ${p.dernier})` : ""}`),
						h("td", { "data-label": "Veilleurs connectés" }, p.veilleurs.length ? p.veilleurs.map(v => `${v.nom} sur ${v.poste}`).join(", ") : "aucun"))) : h("tr", null, h("td", { colspan: "4", class: "vide" }, "Aucun projet."))))),
				h("p", { class: "aide" }, e.builds_garder ? `Les ${e.builds_garder} derniers builds de chaque projet sont gardés, plus ceux que cite un retour ouvert (WDD_BUILDS_GARDER).` : "Tous les builds sont gardés (WDD_BUILDS_GARDER=0)."),
				h("h3", null, "Échecs récents"),
				e.traitements_echoues.length || e.builds_refuses.length ? h("ul", { class: "echecs", dataset: { role: "echecs" } },
					e.traitements_echoues.map(x => h("li", null, `${date(x.quand)} · ${x.projet} · traitement ${x.etat === "annulee" ? "annulé" : "échoué"}${x.raison ? " : " + x.raison : ""}`)),
					e.builds_refuses.map(x => h("li", null, `${date(x.quand)} · ${x.projet} · build refusé : ${x.message}`)))
					: h("p", { class: "aide", dataset: { role: "echecs" } }, "Aucun traitement échoué ni build refusé récemment."));
		} catch (err) { mEtat.dire(err.message, "erreur"); }
	}

	// Journal
	const jProjet = h("select", { id: "aj-projet" });
	const plus = h("button", { type: "button", hidden: true }, "Entrées plus anciennes");
	let suivant = null;
	jProjet.addEventListener("change", () => chargerJournal(false));
	plus.addEventListener("click", () => chargerJournal(true));

	const tableau = (role, entetes, corps) => h("div", { class: "defile" }, h("table", { class: "tableau", dataset: { role } },
		h("thead", null, h("tr", null, entetes.map(t => h("th", { scope: "col" }, t)))), corps));
	remplacer(racine,
		h("h1", { tabindex: "-1" }, "Administration"),
		bandeauIsolement(app.moi, true),
		h("section", { "aria-labelledby": "s-proj" }, h("h2", { id: "s-proj" }, "Projets"), mProj,
			tableau("projets", ["Projet", "Retours", "Tickets", "Wiki"], corpsProjets), h("h3", null, "Nouveau projet"), formProj),
		h("section", { "aria-labelledby": "s-comptes" }, h("h2", { id: "s-comptes" }, "Comptes"), mComptes, recoCreee,
			tableau("comptes", ["Nom", "Rôles", "Admin", "État", "Actions"], corpsComptes)),
		h("section", { "aria-labelledby": "s-ainv" }, h("h2", { id: "s-ainv" }, "Invitations"), formInv, mInv, invCreee,
			tableau("invitations", ["Rôle", "Projet", "État", "Créée", "Expire", ""], corpsInv)),
		h("section", { "aria-labelledby": "s-sauv" }, h("h2", { id: "s-sauv" }, "Sauvegarde"), mSauv, etatSauv, h("div", { class: "actions" }, btnSauv)),
		h("section", { "aria-labelledby": "s-etat" }, h("h2", { id: "s-etat" }, "État du serveur"), mEtat, etatServeur),
		h("section", { "aria-labelledby": "s-journal" }, h("h2", { id: "s-journal" }, "Journal"),
			h("div", { class: "filtres" }, h("div", { class: "champ ligne" }, h("label", { for: "aj-projet" }, "Projet"), jProjet)),
			mJournal, tableau("journal", ["Quand", "Qui", "Action", "Projet", "Cible", "Détail"], corpsJournal), plus));

	async function chargerProjets() {
		try {
			projets = (await lire("/api/admin/projets")).projets;
			remplacer(corpsProjets, projets.length ? projets.map(x => h("tr", null,
				h("td", { "data-label": "Projet" }, h("a", { href: `/p/${encodeURIComponent(x.id)}/` }, x.titre), " ", h("code", null, x.id)),
				h("td", { "data-label": "Retours" }, String(x.retours)),
				h("td", { "data-label": "Tickets" }, String(x.tickets ?? 0)),
				h("td", { "data-label": "Wiki" }, x.build ? "build n° " + x.build : "pas publié"))) : h("tr", null, h("td", { colspan: "4", class: "vide" }, "Aucun projet.")));
			const garde = iProjet.value, gardeJ = jProjet.value;
			remplacer(iProjet, options(projets.map(x => [x.id, x.titre]), garde || (projets[0] && projets[0].id)));
			remplacer(jProjet, options([["", "Tous"], ...projets.map(x => [x.id, x.titre])], gardeJ));
		} catch (err) { mProj.dire(err.message, "erreur"); }
	}

	async function chargerComptes() {
		try {
			const r = await lire("/api/admin/comptes");
			for (const c of r.comptes) noms.set(c.id, c.nom);
			remplacer(corpsComptes, r.comptes.map(c => {
				const moi = c.id === app.moi.compte.id;
				const changer = async (champs, question) => {
					if (question && !await confirmer(question, "Confirmer", true)) return;
					try {
						const x = await ecrire("PATCH", `/api/admin/comptes/${seg(c.id)}`, champs);
						const extra = [x.jetons_revoques.length ? `${x.jetons_revoques.length} jeton(s) révoqué(s)` : "", x.invitations_annulees.length ? `${x.invitations_annulees.length} invitation(s) annulée(s)` : ""].filter(Boolean).join(", ");
						mComptes.dire(`Compte « ${x.compte.nom} » modifié${extra ? " : " + extra : ""}.`, "succes");
					} catch (err) { mComptes.dire(err.message, "erreur"); }
					chargerComptes();
				};
				return h("tr", { dataset: { compte: c.id } },
					h("td", { "data-label": "Nom" }, c.nom, moi ? " (toi)" : "", " ", h("code", null, c.id)),
					h("td", { "data-label": "Rôles" }, c.projets.length ? c.projets.map(x => `${x.projet} : ${LIBELLE_ROLE[x.role] || x.role}`).join(", ") : "—"),
					h("td", { "data-label": "Admin" }, c.admin ? "oui" : "non"),
					h("td", { "data-label": "État" }, c.desactive ? "désactivé le " + date(c.desactive) : "actif"),
					h("td", { "data-label": "Actions", class: "boutons" },
						h("button", { type: "button", on: { click: () => changer({ admin: !c.admin }, c.admin ? `Retirer le rôle d'admin à ${c.nom} ?` : `Nommer ${c.nom} admin de tout le serveur ?`) } }, c.admin ? "Retirer admin" : "Nommer admin"),
						c.desactive ? h("button", { type: "button", on: { click: () => changer({ desactive: false }) } }, "Réactiver")
							: h("button", { type: "button", class: "danger", disabled: moi, on: { click: () => changer({ desactive: true }, `Désactiver ${c.nom} ? Ses sessions sont fermées et ses jetons révoqués.`) } }, "Désactiver"),
						// Étape 3.5 (§ 2.4) : pour tout compte actif, admins et soi-même compris ; montré une fois.
						// Étape 3.9, E4 : fermer toutes ses sessions (portable perdu, poste partagé), sans désactiver le compte.
						c.desactive ? null : h("button", { type: "button", dataset: { role: "fermer-sessions", compte: c.id }, on: { click: async () => {
							if (!await confirmer(`Fermer toutes les sessions de ${c.nom} ? ${moi ? "Tu seras déconnecté de ce navigateur aussi." : "Il devra se reconnecter (lien de reconnexion)."}`, "Fermer", true)) return;
							try { const x = await ecrire("DELETE", `/api/admin/comptes/${seg(c.id)}/sessions`); mComptes.dire(`${x.fermees} session(s) de ${c.nom} fermée(s).`, "succes"); chargerJournal(false); }
							catch (err) { mComptes.dire(err.message, "erreur"); }
						} } }, "Fermer ses sessions"),
						c.desactive ? null : h("button", { type: "button", "aria-label": `Lien de reconnexion pour ${c.nom}`, dataset: { role: "reconnexion", compte: c.id }, on: { click: async () => {
							mComptes.effacer(); remplacer(recoCreee);
							try {
								const x = await ecrire("POST", `/api/admin/comptes/${seg(c.id)}/reconnexion`, {});
								remplacer(recoCreee, boiteSecret(`Lien de reconnexion de ${x.compte.nom}`, x.url, `Envoie ce lien à ${x.compte.nom} seulement : il ouvre une session à son nom dans le navigateur qui l'ouvre, une seule fois, jusqu'au ${date(x.expire)}.`, "lien-reconnexion"));
								recoCreee.querySelector("input").focus();
								chargerInvitations();
							} catch (err) { mComptes.dire(err.message, "erreur"); }
						} } }, "Lien de reconnexion")));
			}));
		} catch (err) { mComptes.dire(err.message, "erreur"); }
	}

	const ETATS = { attente: "en attente", utilisee: "utilisée", annulee: "annulée", expiree: "expirée" };
	async function chargerInvitations() {
		try {
			const r = await lire("/api/admin/invitations");
			const liste = r.invitations.slice().sort((a, b) => String(b.cree).localeCompare(String(a.cree)));
			remplacer(corpsInv, liste.length ? liste.map(i => h("tr", null,
				h("td", { "data-label": "Rôle" }, libelleInvitation(i, noms.get(i.compte_cible))),
				h("td", { "data-label": "Projet" }, i.projet || "—"),
				h("td", { "data-label": "État" }, ETATS[i.etat] || i.etat),
				h("td", { "data-label": "Créée" }, date(i.cree)),
				h("td", { "data-label": "Expire" }, date(i.expire)),
				h("td", null, i.etat === "attente" ? h("button", { type: "button", on: { click: async () => {
					try { await ecrire("DELETE", `/api/admin/invitations/${seg(i.id)}`); mInv.dire("Invitation annulée.", "succes"); }
					catch (err) { mInv.dire(err.message, "erreur"); }
					chargerInvitations();
				} } }, "Annuler") : ""))) : h("tr", null, h("td", { colspan: "6", class: "vide" }, "Aucune invitation.")));
		} catch (err) { mInv.dire(err.message, "erreur"); }
	}

	async function chargerJournal(suite) {
		try {
			const q = new URLSearchParams();
			if (suite && suivant) q.set("avant", String(suivant));
			if (jProjet.value) q.set("projet", jProjet.value);
			const r = await lire("/api/admin/journal" + (q.toString() ? "?" + q : ""));
			const lignes = r.entrees.map(e => h("tr", { dataset: { action: e.action } },
				h("td", { "data-label": "Quand" }, date(e.quand)),
				h("td", { "data-label": "Qui" }, e.qui_nom || e.qui, e.pour ? ` · pour ${e.pour_nom || e.pour}` : ""),
				h("td", { "data-label": "Action" }, e.action),
				h("td", { "data-label": "Projet" }, e.projet || "—"),
				h("td", { "data-label": "Cible" }, h("code", null, e.cible || "")),
				h("td", { "data-label": "Détail", class: "detail" }, e.detail === null || e.detail === undefined ? "" : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail))));
			if (suite) corpsJournal.append(...lignes);
			else remplacer(corpsJournal, lignes.length ? lignes : h("tr", null, h("td", { colspan: "6", class: "vide" }, "Journal vide.")));
			suivant = r.suivant;
			plus.hidden = !suivant;
		} catch (err) { mJournal.dire(err.message, "erreur"); }
	}

	(async () => {
		await chargerProjets();
		await Promise.all([chargerComptes().then(chargerInvitations), chargerJournal(false), chargerSauvegarde(), chargerEtat()]);
		document.body.dataset.charge = "1";
	})();
}
