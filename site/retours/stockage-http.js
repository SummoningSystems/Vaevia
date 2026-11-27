// Adaptateur de stockage « http » : les retours sur le serveur de l'outil (docs/etape1-serveur.md § 4 et § 5), chaque
// écriture devenant un commit dans le dépôt Git de design du projet. Contrat : CONTRAT.md.
//
// - Configuration : <meta name="wdd-api" content="/api/p/<projet>">, posée par le serveur à la livraison de la page
//   (chemin local, même origine). Page ouverte comme fichier (file:) ou sans cette balise : « file ».
// - connecter() : GET <api>/session -> { id, nom, role, proprietaire, ecriture } ; tout échec (401 session finie,
//   403 sans accès, réseau…) : « nodb ».
// - ecouter() : EventSource sur <api>/flux ; chaque événement « instantane » ({ docs: [{ id, version, donnees }], rev })
//   est livré en entier avec depuisCache: false. S'il a une copie précédente (abonnement précédent de la visite, ou
//   page rechargée dans le même onglet : sessionStorage), il la livre d'abord avec depuisCache: true.
//   Sur erreur du flux : l'EventSource est fermé (pas de reconnexion automatique du navigateur), puis erreur() avec
//   « revoked » si /session répond 401, « unavailable » sinon ; le module relance l'écoute une fois (CONTRAT.md § 5).
// - Écritures : fetch même origine (credentials same-origin), en-têtes Content-Type: application/json et X-WDD: 1
//   (anti-CSRF du serveur) ; la version connue part dans le corps (PATCH) ou l'URL (DELETE), jamais dans le document.
//   Un 409 porte le document à jour : il est livré tout de suite dans un instantané (s'il est plus récent que la copie
//   connue), avant le rejet « conflict ».
// - Codes d'erreur (CONTRAT.md § 6) : 400/422 invalid_document, 401 revoked, 403 permission_denied, 404 not_found,
//   409 conflict, 413/507 quota_exceeded ; réseau, délai dépassé, 429, 5xx et le reste : unavailable. Le code du corps
//   de la réponse n'est pas repris : seul le statut HTTP compte (jamais invalid_argument ni transform_error, réservés
//   à l'adaptateur artifact).
"use strict";
window.RetoursStockage = (() => {
	"use strict";
	// Le serveur n'est pas claude.ai, et l'agent qui répond n'est pas forcément Claude. Les clés reprises par les
	// scénarios de régression gardent leurs mots repères (« ouverte comme fichier », « ouvre la page publiée »,
	// « indisponibles pour ce lecteur »). « status » est fourni en entier (fusion sur un niveau, CONTRAT.md § 8), avec les
	// mots de la méta-interface (serveur/ui/js/commun.js, STATUTS_RETOUR).
	const textes = Object.freeze({
		offline: "Retours indisponibles ici : cette page est ouverte comme fichier. Ouvre la page publiée sur le serveur de retours pour écrire un retour.",
		offlineForm: "Retours indisponibles ici : ouvre la page publiée sur le serveur de retours pour écrire un retour sur cet élément.",
		unavailable: "Retours indisponibles pour ce lecteur (ta session a pris fin ou ce compte n'a pas accès au projet : rouvre ton lien d'invitation).",
		replyQ: "Ta réponse à la question de l'agent ; le retour repasse en attente.",
		claude: "Réponse de l'agent",
		help: "Quand tu as fini une série, demande à l'agent de traiter les retours : il les lit, modifie le projet, puis répond ici dans chaque retour.",
		status: { nouveau: "En attente", pris: "Pris en compte", question: "Question", fait: "Appliqué", refuse: "Non retenu" },
		// Sur le serveur, le bandeau du Wiki a déjà un onglet « Retours » (la liste du projet dans la méta-interface) : le
		// bouton flottant, qui ouvre le tiroir de suivi de la page, porte un autre nom.
		fab: "Suivi des retours",
		// Après l'envoi d'une série (étape 3.7, R1) : où demander le traitement sur le serveur.
		serieNext: "Pour la faire traiter : onglet Retours du bandeau, bouton « Traiter les retours ».",
	});
	const CODES = { 400: "invalid_document", 401: "revoked", 403: "permission_denied", 404: "not_found", 409: "conflict", 413: "quota_exceeded", 422: "invalid_document", 507: "quota_exceeded" };
	const DELAI_MS = 30000; // une écriture qui ne répond pas finit en « unavailable » (le bouton d'envoi est rendu)
	const echec = (code, message, extra) => Object.assign(new Error(message || code), { code, message: message || code }, extra || {});

	// Chemin de l'API : un chemin local (« /api/p/<projet> »), jamais une autre origine. null sans balise valable.
	function lireApi() {
		const meta = document.querySelector('meta[name="wdd-api"]');
		const v = meta ? String(meta.getAttribute("content") || "").replace(/\/+$/, "") : "";
		return /^\/(?![\/\\])[^\s?#]*$/.test(v) ? v : null;
	}

	async function connecter() {
		if (location.protocol === "file:") return { horsLigne: "file" };
		const api = lireApi();
		if (api === null) return { horsLigne: "file" };

		async function appel(methode, chemin, corps) {
			const ecrit = methode !== "GET";
			const entetes = ecrit ? { "Content-Type": "application/json", "X-WDD": "1" } : {};
			const o = { method: methode, credentials: "same-origin", cache: "no-store", headers: entetes };
			if (corps !== undefined) o.body = JSON.stringify(corps);
			if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") o.signal = AbortSignal.timeout(DELAI_MS);
			let r;
			try { r = await fetch(api + chemin, o); } catch (e) { throw echec("unavailable", "serveur injoignable"); }
			let j = null;
			if (r.status !== 204) { try { j = await r.json(); } catch (e) { j = null; } }
			if (!r.ok) throw echec(CODES[r.status] || "unavailable", j && typeof j.message === "string" ? j.message : "HTTP " + r.status, r.status === 409 && j && j.document ? { document: j.document } : null);
			return j;
		}

		let s;
		try { s = await appel("GET", "/session"); } catch (e) { return { horsLigne: "nodb" }; }
		if (!s || typeof s !== "object") return { horsLigne: "nodb" };
		const identite = {
			id: typeof s.id === "string" && s.id ? s.id : null,
			proprietaire: s.proprietaire === true,
			ecriture: s.ecriture === true ? true : s.ecriture === false ? false : null,
		};
		// Étape 3.9, L3 : ancienne version du Wiki (balise posée par le serveur) : lecture seule pour cette page.
		if (document.querySelector('meta[name="wdd-lecture-seule"]')) identite.ecriture = false;

		// Dernière liste connue (en mémoire, et dans sessionStorage pour un rechargement dans le même onglet).
		const CLE = "wdd-retours:" + api;
		let copie = null;
		try { const t = sessionStorage.getItem(CLE); const o = t && JSON.parse(t); if (o && Array.isArray(o.docs)) copie = o.docs; } catch (e) { copie = null; }
		const memoriser = docs => { copie = docs; try { sessionStorage.setItem(CLE, JSON.stringify({ docs })); } catch (e) { } };
		const instantane = (docs, cache) => ({ depuisCache: cache, docs: docs.map(d => ({ id: d.id, donnees: d.donnees, version: d.version })) });
		// Abonnement en cours (un seul à la fois : le module ne se réabonne qu'après une erreur, qui ferme le précédent).
		let actif = null;

		// 409 : le document à jour est livré tout de suite, s'il est plus récent que la copie (la diffusion qui suit
		// apportera de toute façon la liste complète).
		function appliquerConflit(e) {
			const d = e && e.document;
			if (!actif || !copie || !d || typeof d !== "object") return;
			const i = copie.findIndex(x => x.id === String(d.id));
			if (i < 0 || !(Number(d.version) > Number(copie[i].version)) || !d.donnees || typeof d.donnees !== "object") return;
			const docs = copie.slice();
			docs[i] = { id: String(d.id), version: d.version, donnees: d.donnees };
			memoriser(docs);
			try { actif.suivant(instantane(docs, false)); } catch (x) { }
		}
		const ecriture = async (methode, chemin, corps) => {
			try { return await appel(methode, chemin, corps); } catch (e) { if (e.code === "conflict") appliquerConflit(e); throw e; }
		};
		const versionDe = o => (o && o.version !== undefined && o.version !== null ? o.version : undefined);

		const retours = Object.freeze({
			async ajouter(donnees) {
				const r = await ecriture("POST", "/retours", donnees);
				if (!r || r.id === undefined || r.id === null || r.id === "") throw echec("unavailable", "réponse du serveur sans id");
				return { id: String(r.id) };
			},
			// Étape 3.7, R2 : capture jointe (image déjà réencodée par le module, PNG ou WebP) ; rend son id. urlCapture :
			// adresse de lecture, même origine (img-src 'self' de la page).
			async envoyerCapture(blob) {
				const o = { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": blob.type || "application/octet-stream", "X-WDD": "1" }, body: blob };
				if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") o.signal = AbortSignal.timeout(DELAI_MS);
				let r;
				try { r = await fetch(api + "/captures", o); } catch (e) { throw echec("unavailable", "serveur injoignable"); }
				let j = null; try { j = await r.json(); } catch (e) { j = null; }
				if (!r.ok) throw echec(CODES[r.status] || "unavailable", j && typeof j.message === "string" ? j.message : "HTTP " + r.status);
				if (!j || typeof j.id !== "string") throw echec("unavailable", "réponse du serveur sans id");
				return { id: j.id };
			},
			urlCapture(id) { return api + "/captures/" + encodeURIComponent(id); },
			// Étape 3.7, R1 : une série de nouveaux retours, d'un coup (tout ou rien, un commit). Rend les ids dans l'ordre.
			async ajouterSerie(liste) {
				const r = await ecriture("POST", "/retours/serie", { retours: liste });
				if (!r || !Array.isArray(r.ids) || r.ids.length !== liste.length) throw echec("unavailable", "réponse du serveur sans ids");
				// Étape 3.9, G3 : demande de traitement lancée par l'envoi (réglage du projet), sinon null.
				return { ids: r.ids.map(String), demande: r.demande && typeof r.demande.id === "string" ? { id: r.demande.id } : null };
			},
			// Étape 3.9, L7 : tickets qui citent des éléments (lecture seule) ; lien vers le ticket dans la méta-interface.
			async tickets() {
				const r = await appel("GET", "/tickets-fiches");
				return r && Array.isArray(r.tickets) ? r.tickets : [];
			},
			// Étape 3.9, lot 2 : noms affichés des membres (écart 31), « Moi aussi » (R6), fusion des doublons (R5).
			async noms() {
				const r = await appel("GET", "/noms");
				return r && r.noms && typeof r.noms === "object" ? r.noms : {};
			},
			// Étape 3.9, E5 : approbations nominatives des points « À valider » (lecture seule).
			async approbations() {
				const r = await appel("GET", "/approbations");
				return r && Array.isArray(r.approbations) ? r.approbations : [];
			},
			async aussi(id, oui, options) {
				const v = versionDe(options);
				if (oui) await ecriture("POST", "/retours/" + encodeURIComponent(id) + "/aussi", { version: v });
				else await ecriture("DELETE", "/retours/" + encodeURIComponent(id) + "/aussi" + (v === undefined ? "" : "?version=" + encodeURIComponent(v)));
			},
			async fusionner(id, doublons, options) {
				await ecriture("POST", "/retours/" + encodeURIComponent(id) + "/fusionner", { version: versionDe(options), doublons });
			},
			async modifier(id, champs, options) {
				await ecriture("PATCH", "/retours/" + encodeURIComponent(id), { champs, version: versionDe(options) });
			},
			async supprimer(id, options) {
				const v = versionDe(options);
				await ecriture("DELETE", "/retours/" + encodeURIComponent(id) + (v === undefined ? "" : "?version=" + encodeURIComponent(v)));
			},
			ecouter(suivant, erreur) {
				const abo = { suivant, fini: false, recu: false };
				actif = abo;
				let es;
				try { es = new EventSource(api + "/flux"); } catch (e) { es = null; }
				const fermer = () => { abo.fini = true; if (es) es.close(); if (actif === abo) actif = null; };
				// Fermé avant d'appeler erreur() : le module se réabonne sans jamais appeler la fonction de désabonnement.
				const abandonner = () => {
					if (abo.fini) return;
					fermer();
					appel("GET", "/session").then(() => "unavailable", e => (e && e.code === "revoked" ? "revoked" : "unavailable"))
						.then(code => { try { erreur(echec(code, code === "revoked" ? "session terminée" : "flux des retours interrompu")); } catch (x) { } });
				};
				if (!es) { Promise.resolve().then(abandonner); return fermer; }
				// Copie précédente d'abord (microtâche : jamais pendant l'appel à ecouter), si la réponse n'est pas déjà là.
				if (copie) { const c = copie; Promise.resolve().then(() => { if (!abo.fini && !abo.recu) { try { suivant(instantane(c, true)); } catch (x) { } } }); }
				es.addEventListener("instantane", ev => {
					if (abo.fini) return;
					let corps;
					try { corps = JSON.parse(ev.data); } catch (e) { return; }
					if (!corps || !Array.isArray(corps.docs)) return;
					const docs = corps.docs.filter(d => d && d.id !== undefined && d.id !== null && d.donnees && typeof d.donnees === "object")
						.map(d => ({ id: String(d.id), version: d.version, donnees: d.donnees }));
					abo.recu = true;
					memoriser(docs);
					try { suivant(instantane(docs, false)); } catch (x) { }
				});
				es.onerror = abandonner;
				return fermer;
			},
		});
		// Étape 3.9, E2 : un testeur externe n'a ni tickets, ni noms des membres, ni approbations, ni « Moi aussi », ni
		// fusion (le serveur les lui refuse) : le module ne les propose pas.
		if (s.testeur === true) {
			const { tickets, noms, approbations, aussi, fusionner, ...reste } = retours;
			return { identite, retours: Object.freeze(reste) };
		}
		return { identite, retours };
	}
	return Object.freeze({ nom: "http", textes, connecter });
})();
