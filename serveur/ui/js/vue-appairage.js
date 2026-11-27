// Autoriser un poste (étape 3.5, docs/etape3-5-prise-en-main.md § 2.2) : #/appairage/<code>, ouvert par la CLI
// (outil brancher, outil installer) par GET /appairage?code=…, ou #/appairage pour taper le code.
// - Le code est validé ici avant tout appel : un code inconnu compte dans la limite du serveur (10 par session et par
//   minute, 429 au-delà), un code mal formé aussi.
// - La demande est lue une fois. L'âge et l'expiration avancent sur place, sans relire le serveur ; après Autoriser ou
//   Refuser, l'état final vient de la réponse 204.
// - Le jeton n'apparaît jamais ici : il est créé quand la CLI vient le chercher.
import { h, remplacer, champ, options, date } from "./dom.js";
import { lire, ecrire, seg } from "./api.js";
import { zoneMessage, ilYa, duree } from "./commun.js";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
// Code tapé ou lu dans l'adresse : majuscules, espaces retirés, tiret facultatif ; rend XXXX-XXXX, ou null.
export function normaliserCode(s) {
	const c = String(s ?? "").replace(/\s+/g, "").toUpperCase();
	return CODE.test(c) ? `${c.slice(0, 4)}-${c.slice(-4)}` : null;
}

const titre = () => h("h1", { tabindex: "-1" }, "Autoriser un poste");

// Sans session (GET /api/moi en 401) : un lien d'invitation ne sert qu'une fois, la page ne propose donc pas de le
// rouvrir ; il faut un lien de reconnexion (§ 2.4).
export function appairageSansSession(racine) {
	remplacer(racine, titre(),
		h("div", { class: "bandeau alerte", dataset: { role: "appairage-sans-session" } },
			h("p", null, "Tu n'es pas connecté dans ce navigateur. Demande un lien de reconnexion à un mainteneur ou à l'admin, ouvre-le, puis rouvre ce lien."),
			h("p", { class: "aide" }, "La demande du terminal reste valable 10 minutes ; au-delà, relance la commande.")));
}

export function vueAppairage(racine, app, brut) {
	app.titre("Autoriser un poste");
	let vivant = true, minuterie = null;
	const arreter = () => { if (minuterie) clearInterval(minuterie); minuterie = null; };
	const fini = () => { document.body.dataset.charge = "1"; };
	// Nouveau dessin : le titre qui avait le focus (donné par ui.js au changement de vue) le garde.
	const poser = (...enfants) => {
		const f = document.activeElement;
		const avait = !!f && f.localName === "h1" && racine.contains(f);
		remplacer(racine, ...enfants);
		const t = avait && racine.querySelector("h1");
		if (t) t.focus();
	};

	// Champ pour taper le code (sans code dans l'adresse, après un code mal formé, expiré ou refusé par la limite).
	function formulaireCode(message, genre = "erreur") {
		const msg = zoneMessage();
		const entree = h("input", { type: "text", id: "ap-code", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "12", placeholder: "XXXX-XXXX", class: "saisie-code" });
		const form = h("form", { class: "formulaire compact", dataset: { role: "form-code" } },
			champ("Code affiché par ton terminal ou ton agent", entree, "8 caractères, par exemple ABCD-EF23."),
			msg,
			h("div", { class: "actions" }, h("button", { type: "submit", class: "principal" }, "Continuer")));
		form.addEventListener("submit", e => {
			e.preventDefault();
			const code = normaliserCode(entree.value);
			if (!code) { msg.dire("Code mal formé : 8 lettres ou chiffres (ni I, L, O, 0 ni 1), comme ABCD-EF23.", "erreur"); entree.focus(); return; }
			app.naviguer(`#/appairage/${code}`);
		});
		if (message) msg.dire(message, genre);
		return form;
	}

	function etatFinal(etat, lignes, avecCode = false) {
		arreter();
		const zone = h("div", { class: ["etat-appairage", etat === "autorise" ? "ok" : etat === "refuse" ? "neutre" : "alerte"], role: "status", tabindex: "-1", dataset: { role: "appairage-fini", etat } }, lignes);
		poser(titre(), zone, avecCode ? [h("h2", null, "Un autre code"), formulaireCode()] : null);
		zone.focus();
		fini();
	}
	const expire = () => etatFinal("expire", [
		h("p", null, h("strong", null, "Code expiré ou déjà utilisé.")),
		h("p", null, "Relance ", h("code", null, "outil brancher"), " (ou ", h("code", null, "outil installer"), ") dans ton terminal pour obtenir un nouveau code.")], true);

	function dessiner(a) {
		const msg = zoneMessage();
		const age = h("span", { dataset: { role: "age-appairage" } });
		const reste = h("span");
		const tic = () => {
			if (!vivant) return arreter();
			const now = Date.now();
			if (!(Date.parse(a.expire) > now)) return expire();
			age.textContent = ilYa(a.cree, now);
			reste.textContent = `dans ${duree(Date.parse(a.expire) - now)} (${date(a.expire)})`;
		};

		const projets = a.projets || [];
		const preselection = projets.some(p => p.id === a.projet) ? a.projet : projets[0] && projets[0].id;
		const selProjet = h("select", { id: "ap-projet", disabled: !projets.length }, options(projets.map(p => [p.id, `${p.titre} (${p.id})`]), preselection));
		const roles = h("div", { class: "liste-cases", dataset: { role: "roles-appairage" } });
		// Étape 3.9, I2 : une demande venue d'une application (role « retour ») ne donne qu'un jeton de retours.
		const app = a.role === "retour";
		let roleChoisi = app ? "retour" : a.role === "mainteneur" ? "mainteneur" : "agent";
		function dessinerRoles() {
			const p = projets.find(x => x.id === selProjet.value);
			const max = p ? p.role_max : "agent";
			if (app) { remplacer(roles, h("p", { class: "aide", dataset: { role: "role-retour" } }, "L'application pourra envoyer des retours en ton nom sur ce projet (texte, capture d'écran), et rien d'autre : elle ne lit ni les retours, ni le Wiki. Valable 30 jours, révocable dans Membres → Jetons.")); return; }
			if (max !== "mainteneur") roleChoisi = "agent";
			const radio = (valeur, libelle, aide) => {
				const r = h("input", { type: "radio", name: "ap-role", id: "ap-role-" + valeur, value: valeur, checked: roleChoisi === valeur, "aria-describedby": "ap-role-" + valeur + "-aide" });
				r.addEventListener("change", () => { if (r.checked) roleChoisi = valeur; });
				return h("div", { class: "case" }, r, h("div", null, h("label", { for: r.id }, libelle), h("p", { class: "aide", id: r.id + "-aide" }, aide)));
			};
			remplacer(roles,
				radio("agent", "Agent", "Lit les retours et y répond, prend et avance des tickets, publie le Wiki."),
				max === "mainteneur" ? radio("mainteneur", "Mainteneur", "En plus : importe des retours (importer-artifact) et remplace des notes. Il ne ferme jamais de ticket.") : null);
		}
		selProjet.addEventListener("change", dessinerRoles);
		dessinerRoles();
		const nomDefaut = Array.from(`${app ? "Application" : "Agent"} · ${a.poste}`).slice(0, 60).join("");
		const nom = h("input", { type: "text", id: "ap-nom", maxlength: "60", value: nomDefaut, autocomplete: "off" });
		const autoriser = h("button", { type: "submit", class: "principal", disabled: !projets.length, dataset: { role: "autoriser" } }, "Autoriser");
		const refuser = h("button", { type: "button", class: "danger", dataset: { role: "refuser" } }, "Refuser");
		const occupe = v => { autoriser.disabled = v || !projets.length; refuser.disabled = v; };

		async function decider(quoi) {
			msg.effacer();
			occupe(true);
			const corps = quoi === "autoriser" ? { projet: selProjet.value, role: roleChoisi, ...(nom.value.trim() ? { nom: nom.value.trim() } : {}) } : undefined;
			try {
				await ecrire("POST", `/api/appairage/${seg(a.code)}/${quoi}`, corps);
			} catch (err) {
				if (!vivant) return;
				if (err.statut === 404) return expire();
				// 403 (projet ou rôle non permis), 429 (trop de codes inconnus) : le message du serveur, tel quel.
				occupe(false);
				msg.dire(err.message, "erreur");
				return;
			}
			if (!vivant) return;
			if (quoi === "refuser") return etatFinal("refuse", [
				h("p", null, h("strong", null, "Refusé : le poste ne recevra pas de jeton.")),
				h("p", null, "Le terminal l'apprend à sa prochaine interrogation.")]);
			const p = projets.find(x => x.id === corps.projet);
			etatFinal("autorise", [
				h("p", null, h("strong", null, app ? "Autorisé : retourne dans l'application." : "Autorisé : retourne dans ton terminal.")),
				h("p", null, app ? `« ${a.poste} » peut maintenant envoyer des retours en ton nom sur le projet « ${p ? p.titre : corps.projet} ». Personne ne voit le jeton : l'application l'enregistre elle-même.`
					: `Le poste « ${a.poste} » reçoit un jeton ${corps.role === "mainteneur" ? "mainteneur" : "agent"} pour le projet « ${p ? p.titre : corps.projet} ». Personne ne le voit : la commande l'enregistre elle-même.`),
				a.usage === "ponctuel" ? h("p", null, "Il est valable une heure, pour cette seule opération.") : h("p", { class: "aide" }, "Un mainteneur peut le révoquer dans Membres → Jetons d'agent.")]);
		}

		const form = h("form", { class: "formulaire", dataset: { role: "form-appairage" } },
			projets.length ? champ("Projet", selProjet, a.projet && a.projet !== preselection ? `Le projet demandé (« ${a.projet} ») n'est pas parmi ceux où tu peux autoriser un agent.` : null)
				: h("p", { class: "message erreur", dataset: { role: "sans-projet" } }, "Ton compte ne peut autoriser d'agent sur aucun projet : il faut y être contributeur, mainteneur ou admin. Tu peux refuser la demande."),
			projets.length ? h("fieldset", null, h("legend", null, "Rôle du jeton"), roles) : null,
			projets.length ? champ("Nom du jeton", nom, "Ce que l'agent écrit est signé de ce nom, « pour » toi.") : null,
			a.usage === "ponctuel" ? h("p", { class: "bandeau note", dataset: { role: "ponctuel" } }, "Valable une heure, pour cette seule opération.") : null,
			msg,
			h("div", { class: "actions" }, autoriser, refuser));
		form.addEventListener("submit", e => { e.preventDefault(); decider("autoriser"); });
		refuser.addEventListener("click", () => decider("refuser"));

		poser(titre(),
			h("p", { class: "code-appairage", dataset: { role: "code-appairage" } }, a.code),
			h("p", { class: "avertissement-code" }, "Vérifie que c'est le code affiché par ton terminal ou ton agent. N'autorise que si tu viens de lancer ",
				h("code", null, "outil brancher"), " ou ", h("code", null, "outil installer"), " toi-même."),
			a.meme_ip === false ? h("div", { class: "bandeau alerte", role: "note", dataset: { role: "avertissement-ip" } },
				h("p", null, h("strong", null, "La demande vient d'une autre machine que ton navigateur.")),
				h("p", null, "Si tu n'as rien lancé sur une autre machine, refuse.")) : null,
			h("dl", { class: "infos", dataset: { role: "infos-appairage" } },
				h("dt", null, "Poste"), h("dd", { dataset: { role: "poste" } }, a.poste),
				h("dt", null, "Demandé"), h("dd", null, age),
				h("dt", null, "Expire"), h("dd", null, reste),
				a.ip ? [h("dt", null, "Adresse IP"), h("dd", { dataset: { role: "ip" } }, a.ip)] : null),
			form);
		tic();
		if (vivant && racine.contains(form)) minuterie = setInterval(tic, 1000);
		fini();
	}

	if (!brut) poser(titre(), h("p", null, "Ton terminal ou ton agent affiche un code de 8 caractères : tape-le ici pour autoriser ce poste."), formulaireCode(null));
	else {
		const code = normaliserCode(brut);
		if (!code) poser(titre(), formulaireCode("Code mal formé dans l'adresse : tape le code affiché par ton terminal."));
		else {
			poser(titre(), h("p", null, "Chargement…"));
			lire(`/api/appairage/${seg(code)}`).then(a => { if (vivant) dessiner(a); }, err => {
				if (!vivant) return;
				if (err.statut === 404) return expire();
				if (err.statut === 401) { appairageSansSession(racine); return fini(); }
				poser(titre(), formulaireCode(err.message));
				fini();
			});
			return () => { vivant = false; arreter(); };
		}
	}
	fini();
	return () => { vivant = false; arreter(); };
}
