// Module retours : le système de retours d'un site de retours, indépendant de l'endroit où les retours sont gardés.
//
// Un bouton « ✎ Retour » sur chaque élément marqué, un tiroir latéral (formulaire, liste de l'élément, vue « Tous les
// retours » avec filtres), la remarque générale sur l'onglet courant, le bouton flottant et sa pastille, la note sous
// les onglets et les modes dégradés (page ouverte comme fichier, lecteur sans base, lecture seule, base pleine, base
// muette, écoute perdue). Les retours sont lus et écrits par un adaptateur de stockage (voir CONTRAT.md) : ce module
// ne connaît ni claude.ai ni un serveur.
//
// Interface publique (window.Retours) :
//   Retours.marque(kind, id, name, anciennes)  -> attributs HTML data-fb-* à poser sur un élément commentable ;
//                                   anciennes (facultatif) : refs d'avant un renommage, dont les retours s'affichent ici
//   Retours.emplacement()           -> HTML de l'emplacement du bouton, à placer dans l'élément marqué
//   Retours.textes                  -> libellés par défaut (gelés)
//   Retours.decorer()               -> pose les boutons sur les éléments marqués ajoutés après demarrer (vue tableau)
//   Retours.ecrire(el, { point })   -> (étape 3.9, L9) ouvre le formulaire de l'élément marqué el, avec un point sur son
//                                      image ; rend faux si l'on ne peut pas écrire (fichier, lecture seule…)
//   Retours.epingles(kind, id, anciennes) -> [{ id, n, x, y, empreinte, statut, texte }] : retours qui portent un point
//   Retours.demarrer({
//     stockage,      // adaptateur (CONTRAT.md) : { nom, textes?, connecter() }
//     textes,        // libellés à remplacer (fusion sur un niveau, comme « ui.fb » de data.json), facultatif
//     codex,         // version de la page commentée (data.generated), écrite dans chaque nouveau retour
//     page: {        // ce que l'affichage fournit
//       sorte(kind),           // libellé d'une sorte d'élément
//       date(iso),             // date lisible dans la langue de la page
//       ongletCourant(),       // { id, label } de l'onglet affiché, ou null
//       aller(tab, el),        // ouvrir l'onglet, poser l'ancre, montrer l'élément (el peut être null)
//     },
//     progression,   // facultatif : { element (id ou nœud), kind, ids: [refs], texte: "{a} sur {n}…" }
//   })
//
// Tickets (étape 3.9, L7), seulement si l'adaptateur sait tickets() (CONTRAT.md § 4) : une ligne « Tickets » sur chaque
// fiche citée par un ticket. Filtre de la page (L6) : chaque élément marqué porte data-fb-ouverts (retours ouverts), et
// l'événement « retours:maj » ({ detail: { pret } }) part sur document à chaque mise à jour.
//
// Série de retours (étape 3.7, R1), seulement si l'adaptateur sait ajouterSerie(liste) (CONTRAT.md § 10) : « Commencer
// une série » ; les nouveaux retours restent alors en brouillon dans ce navigateur (localStorage, par page et par
// lecteur) ; « Envoyer la série » les écrit d'un coup (tout ou rien), puis dit où demander le traitement. Les réponses
// et précisions partent toujours tout de suite.
//
// Marquage attendu dans la page (produit par l'affichage avant demarrer) :
//   - chaque élément commentable porte Retours.marque(...) et, à l'intérieur, Retours.emplacement() ;
//   - son id est l'ancre du retour (champ « anchor »), ou à défaut son data-fb-anchor (une ligne de tableau qui
//     renvoie à la fiche) ; l'onglet est le data-tab de l'ancêtre le plus proche ;
//   - les hôtes du module sont dans la page : #fb-top (#fb-general, #fb-all-top), #fb-off, #fb-fab (#fb-fab-l,
//     #fb-fab-n), #fb-panel (#fb-eyebrow, #fb-close, #fb-title, #fb-body) ; leurs styles sont dans retours.css.
"use strict";
window.Retours = (() => {
	"use strict";
	const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	const fmt = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
	const isObj = v => v && typeof v === "object" && !Array.isArray(v);

	// Libellés par défaut. Une page dans une autre langue les remplace par « textes » (data.json : « ui.fb »).
	const TEXTES = Object.freeze({
		retour: "✎ Retour", one: "retour", many: "retours", waiting: "en attente",
		general: "✎ Remarque générale sur cet onglet", generalName: "Onglet « {t} »", all: "Tous les retours", allTitle: "Tous les retours", follow: "Suivi",
		fab: "Retours", close: "Fermer", question: "question", questions: "questions",
		// Compteur de l'onglet Retours du bandeau du serveur, pour les lecteurs d'écran (même texte que bandeau.ts).
		count: "{n} à traiter", countQ: "{n} à traiter, dont {q} {w}",
		offline: "Retours indisponibles ici : cette page est ouverte comme fichier. Ouvre la page publiée sur claude.ai pour écrire un retour.",
		offlineForm: "Retours indisponibles ici : ouvre la page publiée sur claude.ai pour écrire un retour sur cet élément.",
		unavailable: "Retours indisponibles pour ce lecteur (connecte-toi à claude.ai ou demande l'accès à la page).",
		lost: "Les retours ne sont plus accessibles sur cette page ; recharge-la pour les retrouver.",
		gone: "Ce retour n'existe plus ; ton texte est gardé.",
		readOnly: "Ce lien permet de lire les retours, pas d'en écrire.",
		type: "Type de retour", yours: "Ton retour", answer: "Réponse",
		placeholder: "Ce qui ne va pas, ce que tu voudrais voir…",
		proposal: "Valeur ou texte proposé (facultatif)", proposalPh: "ex. 6 au lieu de 4, ou un autre nom",
		send: "Envoyer", sendAnswer: "Envoyer la réponse", cancel: "Annuler", sent: "Envoyé.",
		replyQ: "Ta réponse à la question de Claude ; le retour repasse en attente.", replyP: "Une précision sur ce retour ; il repasse en attente.",
		answerBtn: "Répondre", precise: "Ajouter une précision", del: "Supprimer", delOk: "Confirmer la suppression", keep: "Garder",
		proposalLbl: "Proposition :", claude: "Réponse de Claude", answerWord: "Réponse", precisionWord: "Précision", of: "du",
		needText: "Écris ton retour avant d'envoyer.", needCat: "Choisis un type de retour avant d'envoyer.",
		full: "La base des retours est pleine : supprime d'anciens retours appliqués.", failed: "L'envoi n'a pas abouti. Réessaie dans un instant ; ton texte est gardé.",
		// Écriture refusée car le retour a changé entre-temps (code « conflict » : adaptateur à versions, voir CONTRAT.md).
		conflict: "Ce retour a changé entre-temps : relis-le, puis renvoie ; ton texte est gardé.",
		// Suppression refusée pour la même raison.
		conflictDel: "Ce retour a changé entre-temps : relis-le avant de le supprimer.",
		// Réponse ou précision refusée sur ce retour seulement (code « permission_denied » sur modifier, voir CONTRAT.md).
		denied: "Tu ne peux pas modifier ce retour ; ton texte est gardé.",
		// Document refusé par le stockage (code « invalid_document » : texte trop long, champ invalide).
		rejected: "Le stockage a refusé ce retour (texte trop long ou champ invalide) ; ton texte est gardé.",
		late: "Les retours enregistrés ne répondent pas encore ; la liste peut être incomplète.",
		help: "Quand tu as fini une série, dis à Claude « traite les retours » : il les lit, modifie le projet, puis répond ici dans chaque retour.",
		seeAll: "Voir tous les retours", none: "Aucun retour sur cet élément pour l'instant.",
		noneAll: "Aucun retour pour l'instant. Chaque élément a un bouton « ✎ Retour ».", noneCat: "Rien dans cette catégorie.",
		cats: [["fort", "Trop fort"], ["faible", "Trop faible"], ["texte", "Texte ou nom"], ["idee", "Idée"], ["bug", "Bug"], ["autre", "Autre"]],
		// Un point a valider, une nouveaute, une mesure ou une remarque generale a ses propres types, sans
		// preselection (un accord ne doit jamais partir en « Trop fort » par megarde).
		catsBy: {
			general: [["idee", "Idée"], ["texte", "Présentation"], ["bug", "Bug"], ["autre", "Autre"]],
			validation: [["valide", "Validé"], ["revoir", "À revoir"], ["question", "Question"], ["autre", "Autre"]],
			nouveaute: [["valide", "Validé"], ["revoir", "À revoir"], ["fort", "Trop fort"], ["faible", "Trop faible"], ["texte", "Texte ou nom"], ["question", "Question"]],
			mesure: [["question", "Question"], ["revoir", "À revoir"], ["idee", "Idée"], ["autre", "Autre"]],
		},
		// Mêmes mots que la méta-interface du serveur (serveur/ui/js/commun.js, STATUTS_RETOUR). « À traiter » = en attente
		// + questions : c'est ce que compte le bouton flottant, comme l'onglet Retours du serveur.
		status: { nouveau: "En attente", pris: "Pris en compte", question: "Question", fait: "Appliqué", refuse: "Non retenu" },
		filters: { ouverts: "À traiter", question: "Questions", pris: "Pris en compte", fait: "Appliqués", refuse: "Non retenus", tous: "Tous", orphelins: "Sans fiche" },
		// Retour dont l'élément n'est plus dans la page (renommé ou retiré) : visible seulement dans « Tous les retours ».
		orphan: "absent de cette version",
		// Série de retours (étape 3.7, R1).
		serieStart: "Commencer une série", serieHelp: "Pendant une séance de test : tes retours restent en brouillon dans ce navigateur, puis partent ensemble.",
		serieOne: "{n} brouillon", serieMany: "{n} brouillons", serieTitle: "Série en cours",
		serieSend: "Envoyer la série", serieDrop: "Abandonner", serieDropOk: "Confirmer l'abandon", serieKeep: "Garder",
		serieAdd: "Ajouter à la série", serieKept: "Gardé dans la série ({n} en tout).", serieFull: "La série est pleine ({n} retours) : envoie-la d'abord.",
		serieLocal: "Brouillons gardés dans ce navigateur seulement, jusqu'à l'envoi (perdus en navigation privée ou si tu vides les données du site).",
		serieSent: "Série envoyée : {n} retours.", serieNext: "Quand tu veux qu'elle soit traitée, dis-le à l'agent.", serieEmpty: "La série est vide : écris d'abord un retour.",
		serieFailed: "La série n'est pas partie ; ses brouillons sont gardés. Réessaie dans un instant.",
		draft: "Brouillon", draftRemove: "Retirer de la série", draftsTitle: "Brouillons de la série",
		// Captures jointes (étape 3.7, R2), si l'adaptateur sait envoyerCapture.
		capAttach: "Joindre une capture", capPaste: "ou colle une image (Ctrl+V), ou dépose-la ici", capMax: "3 captures au plus par retour.",
		capNotImage: "Ce fichier n'est pas une image.", capPreparing: "Préparation de la capture…", capFailed: "La capture n'a pas pu être envoyée ; ton texte est gardé.",
		capRemove: "Retirer la capture", capAlt: "Capture jointe au retour", capNote: "Réencodée avant l'envoi (sans métadonnées). N'y laisse rien de confidentiel.",
		// Tickets qui citent l'élément (étape 3.9, L7), si l'adaptateur sait tickets().
		tickets: "Tickets", ticketSt: { "a-faire": "à faire", pris: "pris", "en-revue": "en revue", fait: "fait" },
		// Étape 3.9, lot 2 : champ visé (R3), gabarit de bug et proposition préremplie (R4), « Moi aussi » (R6), fusion (R5),
		// noms des auteurs (écart 31), « pour » (E3).
		fieldLbl: "Champ :", fieldRemove: "Retirer le champ visé", fieldHint: "Retour sur le champ « {f} » de la fiche",
		bugTpl: "Étapes :\n\nAttendu :\n\nObtenu :", prefillCats: ["fort", "faible"],
		you: "toi", former: "ancien membre", byLbl: "par {n}",
		aussiBtn: "Moi aussi", aussiOff: "Je ne suis plus concerné", aussiLbl: "Aussi :",
		pourLbl: "Pour (facultatif)", pourNone: "personne en particulier", pourShow: "Pour :", confier: "Confier à",
		dupBtn: "Doublon de…", dupOf: "Doublon de", dupOk: "Fusionner", dupNone: "Aucun autre retour sur cet élément.",
		mergedIn: "Fusionné dans un autre retour", mergedGo: "Voir le retour principal",
		serieAuto: "Le traitement est lancé : l'agent en veille va la prendre (réglage du projet).",
		// Étape 3.9, L9 : point posé sur l'image agrandie d'une fiche.
		pointLbl: "Point sur l'image :", pointRemove: "Retirer le point", pointShow: "Point ({x} %, {y} %)",
		apprLbl: "Approuvé par {n} · {d}", apprBuild: " · build {b}",
	});
	// Fusion sur un niveau, comme « ui.fb » de data.json dans le gabarit d'origine : chaque clé fournie remplace la
	// valeur par défaut, en entier (un « status » ou un « catsBy » fourni remplace tout l'objet par défaut).
	function fusion(base, ...surcharges) {
		let r = { ...base };
		for (const s of surcharges) if (isObj(s)) r = { ...r, ...s };
		return r;
	}

	// Anciennes refs : en JSON dans data-fb-alias, seulement s'il y en a (sinon le DOM reste celui d'avant).
	const marque = (kind, id, name, anciennes) => ` data-fb-kind="${esc(kind)}" data-fb-id="${esc(id)}" data-fb-name="${esc(name)}"` +
		(Array.isArray(anciennes) && anciennes.length ? ` data-fb-alias="${esc(JSON.stringify(anciennes.map(String)))}"` : "");
	const emplacement = () => `<span class="fb-slot"></span>`;

	let demarre = false, decorerCourant = null;
	// Éléments marqués ajoutés après le démarrage (vue tableau du gabarit) : boutons posés tout de suite.
	function decorer() { if (decorerCourant) decorerCourant(); }
	// Étape 3.9, L9 : ouvrir le formulaire d'un élément marqué, avec un point (rend faux si l'on ne peut pas écrire) ; les
	// épingles d'un élément (retours qui portent un point), numérotées dans l'ordre de création.
	let ecrireCourant = null, epinglesCourant = null;
	function ecrire(el, extra) { return ecrireCourant ? ecrireCourant(el, extra) : false; }
	function epingles(kind, id, anciennes) { return epinglesCourant ? epinglesCourant(kind, id, anciennes) : []; }
	function demarrer(opts) {
		if (demarre) throw new Error("Retours.demarrer : le module est déjà démarré");
		const o = opts || {};
		const stockage = o.stockage;
		if (!stockage || typeof stockage.connecter !== "function") throw new Error("Retours.demarrer : stockage.connecter() manquant (voir CONTRAT.md)");
		demarre = true;
		const page = o.page || {};
		const kindLabel = typeof page.sorte === "function" ? page.sorte : k => k;
		const fmtDate = typeof page.date === "function" ? page.date : iso => String(iso || "");
		const progression = isObj(o.progression) ? o.progression : null;
		const codex = o.codex || "";
		// Libellés : défauts du module, puis ceux de l'adaptateur (ex. un serveur ne parle pas de claude.ai), puis la page.
		const F = fusion(TEXTES, stockage.textes, o.textes);

		// Retours lus par l'adaptateur ; l'agent les applique au projet puis repond dans chaque retour (status, reply,
		// replied). Champs : kind, ref, name, tab, anchor, cat, text, proposal, status, reply, replied, created, updated,
		// by, codex (= la version de la page commentee). Schema et droits : CONTRAT.md.
		const fbCats = kind => F.catsBy[kind] || F.cats;
		const fbDefaultCat = kind => F.catsBy[kind] ? "" : F.cats[0][0];
		const FB_CAT_LABEL = Object.fromEntries([...F.cats, ...Object.values(F.catsBy).flat()]);
		const catLabel = (kind, cat) => ((fbCats(kind).find(c => c[0] === cat) || [])[1]) || FB_CAT_LABEL[cat] || cat || "";
		// offline : "" (base branchee), "file" (page ouverte comme fichier), "nodb" (pas de base pour ce lecteur).
		// late : la base n'a pas encore repondu au bout de 10 s ; lost : l'ecoute est morte (revoked ou erreur repetee).
		// versions : version de chaque retour quand l'adaptateur en fournit (renvoyee a chaque ecriture, CONTRAT.md).
		// Série en cours (R1) : null, ou { brouillons: [{ cle, donnees }] }, relue et écrite dans localStorage.
		const MAX_SERIE = 50;
		// Captures du formulaire en cours (R2) : [{ id, apercu }], envoyées dès qu'elles sont jointes ; vidées à l'envoi du retour.
		const MAX_CAPTURES = 3, COTE_MAX = 1600;
		let pieces = [], prepare = 0;
		const capturesOk = () => !!(fb.col && typeof fb.col.envoyerCapture === "function" && typeof fb.col.urlCapture === "function");
		let serie = null, serieMsg = "", serieConfirme = false;
		const fb = { opener: null, col: null, uid: null, owner: false, all: [], versions: new Map(), target: null, view: "element", filter: "ouverts", cat: "", replyTo: null, confirmDel: null, sending: false, readOnly: false, offline: "", late: false, lost: false, recu: false, noms: null, field: "", fieldVal: "", dup: null, point: "" };
		const fbPanel = document.getElementById("fb-panel");
		const fbBody = document.getElementById("fb-body");
		const fbOpen = r => r.status === "nouveau" || r.status === "question";
		const aliasDe = el => { try { const a = JSON.parse(el.dataset.fbAlias || "[]"); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; } };
		const fbFor = (kind, id, anciennes) => { const refs = [String(id), ...(anciennes || [])]; return fb.all.filter(r => r.kind === kind && refs.includes(String(r.ref))); };
		// Refs présentes dans la page (éléments, leurs anciennes refs, onglets pour la remarque générale) : un retour hors de
		// cette liste porte sur un élément renommé ou retiré. La page est construite avant demarrer et ne change plus.
		const presentes = new Set();
		document.querySelectorAll("[data-fb-kind]").forEach(el => { for (const r of [el.dataset.fbId, ...aliasDe(el)]) presentes.add(el.dataset.fbKind + "\u0000" + r); });
		document.querySelectorAll("[data-tab]").forEach(el => presentes.add("general\u0000" + el.dataset.tab));
		const fbOrphan = r => !presentes.has(r.kind + "\u0000" + String(r.ref));
		const newest = (a, b) => String(b.created).localeCompare(String(a.created));
		const versionDe = id => fb.versions.has(id) ? { version: fb.versions.get(id) } : {};
		document.getElementById("fb-general").textContent = F.general;
		document.getElementById("fb-all-top").textContent = F.all;
		document.getElementById("fb-fab-l").textContent = F.fab;
		document.getElementById("fb-close").textContent = F.close;
		// Note sous les onglets : page hors base, base muette ou ecoute perdue.
		function fbNote() {
			const t = fb.offline === "file" ? F.offline : fb.offline ? F.unavailable : fb.lost ? F.lost : fb.late ? F.late : "";
			const n = document.getElementById("fb-off");
			n.textContent = t; n.hidden = !t;
		}
		// Supprimer : ses propres retours, ou tous pour le proprietaire de la page (les droits de la base sont plus larges).
		const fbCanDel = r => fb.owner || (fb.uid ? r.by === fb.uid : !r.by);

		function fbCtx(el) { const p = el.closest("[data-tab]"); return { tab: p ? p.dataset.tab : "", anchor: el.id || el.dataset.fbAnchor || "" }; }
		// Un bouton par element marque ; ne reecrit que ce qui change.
		function fbDecorate() {
			if (!fb.col && !fb.offline) return;
			document.querySelectorAll("[data-fb-kind]").forEach(el => {
				const slot = el.querySelector(".fb-slot"); if (!slot) return;
				let btn = slot.firstElementChild;
				if (!btn) { slot.innerHTML = `<button type="button" class="fb-btn"><span class="dot" hidden></span><span class="lbl"></span></button>`; btn = slot.firstElementChild; }
				const list = fbFor(el.dataset.fbKind, el.dataset.fbId, aliasDe(el)).sort(newest);
				const open = list.filter(fbOpen).length;
				let lbl = F.retour;
				const q = list.filter(r => r.status === "question").length;
				if (list.length && F.catsBy[el.dataset.fbKind] && list[0].cat) lbl = `✎ ${catLabel(el.dataset.fbKind, list[0].cat)} · ${F.status[list[0].status] || list[0].status}${list.length > 1 ? ` · +${list.length - 1}` : ""}`;
				else if (list.length) lbl = `✎ ${list.length} ${list.length > 1 ? F.many : F.one}${q ? ` · ${q} ${q > 1 ? F.questions : F.question}` : open ? ` · ${open} ${F.waiting}` : ""}`;
				const nb = brouillonsDe(el.dataset.fbKind, el.dataset.fbId, aliasDe(el)).length;
				if (nb) lbl = (list.length ? lbl + " · " : "✎ ") + fmt(nb > 1 ? F.serieMany : F.serieOne, { n: nb });
				const span = btn.querySelector(".lbl"), dot = btn.querySelector(".dot");
				if (span.textContent !== lbl) span.textContent = lbl;
				const cls = list.length ? "fb-btn st-" + (list.some(r => r.status === "question") ? "question" : open ? "nouveau" : list[0].status) : "fb-btn";
				if (btn.className !== cls) btn.className = cls;
				if (dot.hidden !== !list.length) dot.hidden = !list.length;
				// Étape 3.9, L6 : retours ouverts de l'élément, lus par le filtre « avec retours ouverts » de la page.
				if (el.dataset.fbOuverts !== String(open)) el.dataset.fbOuverts = String(open);
			});
			// La page sait ainsi quand les retours sont lus (fb.recu) et quand ils changent.
			try { document.dispatchEvent(new CustomEvent("retours:maj", { detail: { pret: !!(fb.col && fb.recu) } })); } catch (e) { }
			// Progression d'une liste de points (ex. « À valider ») : combien ont au moins un retour.
			if (progression) {
				const vp = typeof progression.element === "string" ? document.getElementById(progression.element) : progression.element;
				if (vp && fb.col) { const ids = (progression.ids || []).map(String); const a = ids.filter(id => fbFor(progression.kind, id).length).length; vp.textContent = fmt(progression.texte, { a, n: ids.length }); }
			}
		}

		function fbGoto(r) {
			const el = (r.anchor && document.getElementById(r.anchor)) || [...document.querySelectorAll("[data-fb-kind]")].find(x => x.dataset.fbKind === r.kind && x.dataset.fbId === String(r.ref));
			const tab = el ? fbCtx(el).tab : r.tab;
			if (!tab) return;
			if (typeof page.aller === "function") page.aller(tab, el || null);
			if (window.innerWidth < 900) fbClose(false);
		}

		// Dans fbItem et fbForm, les lignes du HTML genere gardent l'indentation du gabarit d'origine (decalage voulu) :
		// le DOM produit reste identique, espaces compris, a celui d'avant l'extraction.
		// Étape 3.9 : nom affiché d'un compte (écart 31), seulement si l'adaptateur sait noms() ; sinon rien n'est montré.
		const nomDe = id => !fb.noms || !id ? "" : id === fb.uid ? F.you : fb.noms[id] || F.former;
		const aussiDe = r => String(r.aussi || "").split(" ").filter(Boolean);
		function fbItem(r, withTarget) {
			const cat = catLabel(r.kind, r.cat);
			const acts = [];
			const fusionne = !!r.fusionne_dans;
			if (!fb.readOnly) {
				acts.push(`<button type="button" class="btn small" data-reply="${esc(r.id)}">${esc(r.status === "question" ? F.answerBtn : F.precise)}</button>`);
				if (fbCanDel(r)) acts.push(fb.confirmDel === r.id ? `<button type="button" class="btn small danger" data-del-ok="${esc(r.id)}">${esc(F.delOk)}</button><button type="button" class="btn small" data-del-no="1">${esc(F.keep)}</button>` : `<button type="button" class="btn small danger" data-del="${esc(r.id)}">${esc(F.del)}</button>`);
				// R6 : « Moi aussi » sur le retour d'un autre (pas un retour fusionné).
				if (typeof fb.col?.aussi === "function" && fb.uid && r.by !== fb.uid && !fusionne)
					acts.push(`<button type="button" class="btn small" data-aussi="${esc(r.id)}" aria-pressed="${aussiDe(r).includes(fb.uid)}">${esc(aussiDe(r).includes(fb.uid) ? F.aussiOff : F.aussiBtn)}</button>`);
				// R5 : un mainteneur désigne ce retour comme doublon d'un autre du même élément ; E3 : il le confie à quelqu'un.
				if (fb.owner && typeof fb.col?.fusionner === "function" && !fusionne && !withTarget) acts.push(`<button type="button" class="btn small" data-dup="${esc(r.id)}">${esc(F.dupBtn)}</button>`);
				if (fb.owner && fb.noms && !fusionne && !withTarget) acts.push(`<label class="fb-confier">${esc(F.confier)} <select data-confier="${esc(r.id)}">${optionsPour(r.pour)}</select></label>`);
			}
			const dup = fb.dup === r.id ? dupHtml(r) : "";
			const aussi = aussiDe(r);
			return `<div class="fb-item st-${esc(r.status)}">
		${withTarget ? `<button type="button" class="goto" data-goto="${esc(r.id)}">${esc(r.name || r.ref)}</button>` : ""}
		<div class="meta"><span class="fb-pill">${esc(F.status[r.status] || r.status)}</span>${withTarget ? `<span>${esc(kindLabel(r.kind))}</span>` : ""}${withTarget && fbOrphan(r) ? `<span class="fb-orphan">${esc(F.orphan || TEXTES.orphan)}</span>` : ""}${cat ? `<span>${esc(cat)}</span>` : ""}${r.field ? `<span class="fb-field">${esc(F.fieldLbl)} ${esc(r.field)}</span>` : ""}${r.point ? `<span class="fb-point">${esc(pointTexte(r.point))}</span>` : ""}<span>${esc(fmtDate(r.created))}</span>${nomDe(r.by) ? `<span>${esc(fmt(F.byLbl, { n: nomDe(r.by) }))}</span>` : ""}${r.pour && nomDe(r.pour) ? `<span class="fb-pour">${esc(F.pourShow)} ${esc(nomDe(r.pour))}</span>` : ""}</div>
		<div class="txt">${esc(r.text)}</div>${aussi.length ? `<div class="fb-aussi">${esc(F.aussiLbl)} ${esc(fb.noms ? aussi.map(nomDe).join(", ") : String(aussi.length))}</div>` : ""}${fusionne ? `<div class="fb-merged">${esc(F.mergedIn)} · <button type="button" class="linkish" data-merged="${esc(r.fusionne_dans)}">${esc(F.mergedGo)}</button></div>` : ""}
		${r.proposal ? `<div><b>${esc(F.proposalLbl)}</b> ${esc(r.proposal)}</div>` : ""}
		${vignettes(r.captures)}
		${r.reply && !fusionne ? `<div class="reply"><small>${esc(F.claude)}${r.replied ? " · " + esc(fmtDate(r.replied)) : ""}</small>${esc(r.reply)}</div>` : ""}
		${acts.length ? `<div class="acts">${acts.join("")}</div>` : ""}${dup}
	</div>`;
		}
		// Membres à qui confier un retour (noms connus, sans les anciens membres).
		function optionsPour(pour) {
			const l = Object.entries(fb.noms || {}).filter(([, n]) => n !== F.former && n !== "ancien membre").sort((a, b) => a[1].localeCompare(b[1]));
			return `<option value="">${esc(F.pourNone)}</option>` + l.map(([id, n]) => `<option value="${esc(id)}"${id === pour ? " selected" : ""}>${esc(id === fb.uid ? `${n} (${F.you})` : n)}</option>`).join("");
		}
		// Choix du retour principal d'un doublon : les autres retours du même élément, pas déjà fusionnés.
		function dupHtml(r) {
			const autres = fbFor(r.kind, r.ref).filter(x => x.id !== r.id && !x.fusionne_dans).sort(newest);
			if (!autres.length) return `<p class="fb-msg">${esc(F.dupNone)}</p>`;
			const ext = x => { const t = String(x.text || "").replace(/\s+/g, " "); return (t.length > 60 ? t.slice(0, 60) + " …" : t) + (nomDe(x.by) ? ` (${nomDe(x.by)})` : ""); };
			return `<div class="fb-dup"><label>${esc(F.dupOf)} <select id="fb-dup-p">${autres.map(x => `<option value="${esc(x.id)}">${esc(ext(x))}</option>`).join("")}</select></label><button type="button" class="btn small" data-dup-ok="${esc(r.id)}">${esc(F.dupOk)}</button><button type="button" class="btn small" data-dup-no="1">${esc(F.cancel)}</button></div>`;
		}

		function fbForm() {
			if (fb.offline) return `<p class="fb-msg">${esc(fb.offline === "file" ? F.offlineForm : F.unavailable)}</p>`;
			if (fb.lost) return `<p class="fb-msg">${esc(F.lost)}</p>`;
			if (fb.readOnly) return `<p class="fb-msg">${esc(F.readOnly)}</p>`;
			const reply = fb.replyTo && fb.all.find(r => r.id === fb.replyTo);
			// En reponse : rappeler l'element et la question (la liste peut etre hors de l'ecran, ou ce soit la vue « Tous »).
			const ctx = reply ? `<p class="ctx"><b>${esc(reply.name || reply.ref)}</b></p>${reply.reply ? `<div class="reply"><small>${esc(F.claude)}</small>${esc(reply.reply)}</div>` : ""}` : "";
			return `<form class="fb-form" id="fb-form">
		${reply ? `${ctx}<p class="fb-msg">${esc(reply.status === "question" ? F.replyQ : F.replyP)}</p>` : `<label>${esc(F.type)}</label><div class="fb-cats">${fbCats(fb.target.kind).map(([k, l]) => `<button type="button" data-cat="${esc(k)}" aria-pressed="${k === fb.cat}">${esc(l)}</button>`).join("")}</div>`}
		<label for="fb-text">${esc(reply ? F.answer : F.yours)}</label>
		<textarea id="fb-text" placeholder="${esc(reply ? "" : F.placeholder)}"></textarea>
		${reply ? "" : `<label for="fb-prop">${esc(F.proposal)}</label><input id="fb-prop" type="text" placeholder="${esc(F.proposalPh)}">`}${!reply && fb.point ? `<p class="fb-champ-chip fb-point-chip"><span>${esc(F.pointLbl)} <b>${esc(pointTexte(fb.point))}</b></span><button type="button" class="btn small" data-point-del="1" aria-label="${esc(F.pointRemove)}">×</button></p>` : ""}${!reply && fb.field ? `<p class="fb-champ-chip"><span>${esc(F.fieldLbl)} <b>${esc(fb.field)}</b></span><button type="button" class="btn small" data-field-del="1" aria-label="${esc(F.fieldRemove)}">×</button></p>` : ""}${!reply && fb.noms ? `<label for="fb-pour">${esc(F.pourLbl)}</label><select id="fb-pour">${optionsPour("")}</select>` : ""}
		${!reply && capturesOk() ? `<div class="fb-captures" id="fb-captures"><div class="fb-cap-row"><button type="button" class="btn small" data-cap-add="1">${esc(F.capAttach)}</button><span class="fb-msg">${esc(F.capPaste)}</span><input type="file" id="fb-file" accept="image/*" tabindex="-1" aria-hidden="true" hidden></div><div class="fb-pieces" id="fb-pieces"></div><p class="fb-msg fb-cap-note">${esc(F.capNote)}</p></div>` : ""}
		<div class="fb-send-row"><button type="submit" class="btn send" id="fb-send">${esc(reply ? F.sendAnswer : serie ? F.serieAdd : F.send)}</button>${reply ? `<button type="button" class="btn" data-reply-cancel="1">${esc(F.cancel)}</button>` : ""}<span class="fb-msg" id="fb-status" role="status"></span></div>
	</form>`;
		}
		// Le formulaire et la liste se redessinent separement : un retour qui arrive ne coupe pas la saisie.
		function fbRender() {
			if (fbPanel.hidden) return;
			const el = fb.view === "element";
			document.getElementById("fb-eyebrow").textContent = el ? kindLabel(fb.target.kind) : F.follow;
			document.getElementById("fb-title").textContent = el ? fb.target.name : F.allTitle;
			if (fb.offline) { fbBody.innerHTML = `<div id="fb-formwrap"></div>`; fbRenderForm(); return; }
			fbBody.innerHTML = `<div id="fb-formwrap"></div><div id="fb-listwrap"></div>` + (el ? `<p class="fb-help">${esc(F.help)}</p><button type="button" class="btn" data-all="1">${esc(F.seeAll)}</button>` : "");
			fbRenderForm(); fbRenderList();
		}
		function fbRenderForm() {
			const w = document.getElementById("fb-formwrap"); if (!w) return;
			const keep = document.getElementById("fb-text")?.value || "";
			w.innerHTML = fb.view === "element" || fb.replyTo ? fbForm() : "";
			const ta = document.getElementById("fb-text"); if (ta && keep && !fb.replyTo) ta.value = keep;
			rendrePieces();
			const fi = document.getElementById("fb-file");
			if (fi) fi.addEventListener("change", () => { for (const f of [...(fi.files || [])]) joindre(f); fi.value = ""; });
		}
		// Le retour auquel on repondait a disparu (supprime ailleurs) : on le dit et le texte saisi n'est pas perdu.
		function fbDropReply() {
			const keep = (document.getElementById("fb-text")?.value || "").trim();
			fb.replyTo = null; fbRenderForm();
			const w = document.getElementById("fb-formwrap"); if (!w) return;
			const s = document.getElementById("fb-status");
			if (s) s.textContent = F.gone;
			else w.innerHTML = `<div class="fb-form"><p class="fb-msg" role="status">${esc(F.gone)}</p>${keep ? `<div class="reply">${esc(keep)}</div>` : ""}</div>`;
		}
		function fbRenderList() {
			const w = document.getElementById("fb-listwrap"); if (!w || fbPanel.hidden) return;
			// Base muette ou ecoute perdue : le dire en tete de liste, tant que l'etat dure (pas seulement a l'instant ou il survient).
			const warn = fb.lost ? F.lost : fb.late ? F.late : "";
			const warnHtml = warn ? `<p class="fb-msg" role="status">${esc(warn)}</p>` : "";
			if (fb.view === "element") {
				const list = fbFor(fb.target.kind, fb.target.id, fb.target.anciennes).sort(newest);
				const br = brouillonsDe(fb.target.kind, fb.target.id, fb.target.anciennes);
				w.innerHTML = warnHtml + (br.length ? `<div class="fb-list fb-drafts">${br.map(b => brouillonHtml(b, false)).join("")}</div>` : "") +
					(list.length ? `<div class="fb-list">${list.map(r => fbItem(r, false)).join("")}</div>` : warn || br.length ? "" : `<p class="fb-help">${esc(F.none)}</p>`);
				return;
			}
			const FL = [["ouverts", fbOpen], ["question", r => r.status === "question"], ["pris", r => r.status === "pris"], ["fait", r => r.status === "fait"], ["refuse", r => r.status === "refuse"], ["tous", () => true]];
			// « Sans fiche » : seulement s'il y en a (élément renommé ou retiré depuis le retour).
			if (fb.all.some(fbOrphan)) FL.push(["orphelins", fbOrphan]);
			const f = FL.find(x => x[0] === fb.filter) || FL[0];
			const list = fb.all.filter(f[1]).sort(newest);
			const br = serie ? serie.brouillons : [];
			w.innerHTML = warnHtml + (br.length ? `<h4 class="fb-drafts-title">${esc(F.draftsTitle)} · ${br.length}</h4><div class="fb-list fb-drafts">${br.map(b => brouillonHtml(b, true)).join("")}</div>` : "") + `<div class="fb-filter">${FL.map(([k, p]) => `<button type="button" data-filter="${k}" aria-pressed="${k === f[0]}">${esc(F.filters[k] || TEXTES.filters[k])} · ${fb.all.filter(p).length}</button>`).join("")}</div>` +
				(list.length ? `<div class="fb-list">${list.map(r => fbItem(r, true)).join("")}</div>` : `<p class="fb-help">${esc(fb.all.length ? F.noneCat : F.noneAll)}</p>`);
		}
		function fbRefreshFab() {
			const n = fb.all.filter(fbOpen).length, q = fb.all.filter(r => r.status === "question").length;
			const b = document.getElementById("fb-fab-n");
			b.hidden = !n; b.textContent = q ? `${n} · ${q} ${q > 1 ? F.questions : F.question}` : String(n);
			// Bandeau du serveur (serveur/src/bandeau.ts) au-dessus de la page : son onglet « Retours » porte le même compteur,
			// posé au moment de servir la page ; il suit ici les retours en direct, pour que les deux chiffres restent égaux.
			const onglet = document.querySelector('#wdd-bandeau [data-onglet="retours"]');
			if (onglet) {
				let c = onglet.querySelector(".wdd-b-compte");
				if (!n) { if (c) c.remove(); return; }
				if (!c) {
					c = document.createElement("span"); c.className = "wdd-b-compte nouveaux";
					const v = document.createElement("span"); v.setAttribute("aria-hidden", "true");
					const t = document.createElement("span"); t.className = "wdd-b-invisible";
					c.append(v, t); onglet.append(c);
				}
				c.firstChild.textContent = String(n);
				c.lastChild.textContent = ` (${fmt(q ? F.countQ : F.count, { n, q, w: q > 1 ? F.questions : F.question })})`;
			}
		}
		// Tiroir plein écran (écran étroit) : la page dessous devient inerte, sinon le focus y passerait, invisible sous le
		// tiroir. Plus étroit que l'écran, le tiroir laisse la page utilisable à côté.
		function fbModal() {
			const plein = !fbPanel.hidden && fbPanel.getBoundingClientRect().width >= document.documentElement.clientWidth - 1;
			for (const id of ["wrap", "wdd-bandeau", "fb-fab"]) { const e = document.getElementById(id); if (e && e.inert !== plein) e.inert = plein; }
		}
		function fbShow(view, target) {
			// Ouvert depuis la page (tiroir fermé, ou déjà ouvert à côté sur un écran large) : l'élément qui avait le focus le
			// retrouve à la fermeture. Depuis le tiroir lui-même (« Voir tous les retours »), on garde le précédent.
			const a = document.activeElement;
			if (a && a !== document.body && !fbPanel.contains(a)) fb.opener = a;
			else if (fbPanel.hidden) fb.opener = null;
			fb.view = view; fb.replyTo = null; fb.confirmDel = null;
			// Le type repart de zero a chaque element : un « Bug » choisi sur une fiche ne suit pas sur la suivante.
			if (target) { if (!fb.target || fb.target.kind !== target.kind || fb.target.id !== target.id) pieces = []; fb.target = target; fb.cat = fbDefaultCat(target.kind); fb.field = ""; fb.fieldVal = ""; fb.dup = null; fb.point = ""; }
			fbPanel.hidden = false; fbModal(); fbRender();
			(document.getElementById("fb-text") || document.getElementById("fb-close")).focus({ preventScroll: true });
		}
		// Fermer rend le focus à l'élément qui a ouvert le tiroir s'il est encore affiché (il peut être dans un onglet caché),
		// sinon au bouton flottant. Pas après « aller à l'élément » (fbGoto), qui montre lui-même l'élément visé.
		function fbClose(rendre = true) {
			if (fbPanel.hidden) return;
			fbPanel.hidden = true; fbModal();
			const o = fb.opener; fb.opener = null;
			if (!rendre) return;
			const fab = document.getElementById("fb-fab");
			const cible = o && o.isConnected && o.getClientRects().length ? o : !fab.hidden ? fab : null;
			if (cible) cible.focus();
		}
		window.addEventListener("resize", () => { if (!fbPanel.hidden) fbModal(); });

		// --- Série de retours (R1) -----------------------------------------------------------------------------
		const cleSerie = () => "wdd-serie:" + location.pathname + ":" + (fb.uid || "");
		const serieOk = () => !!(fb.col && typeof fb.col.ajouterSerie === "function" && !fb.readOnly && !fb.offline && !fb.lost);
		function lireSerie() {
			try {
				const o = JSON.parse(localStorage.getItem(cleSerie()) || "null");
				if (o && Array.isArray(o.brouillons)) return { brouillons: o.brouillons.filter(b => b && typeof b.cle === "string" && isObj(b.donnees)).slice(0, MAX_SERIE) };
			} catch (e) { }
			return null;
		}
		function ecrireSerie() { try { if (serie) localStorage.setItem(cleSerie(), JSON.stringify(serie)); else localStorage.removeItem(cleSerie()); } catch (e) { } }
		function brouillonsDe(kind, id, anciennes) {
			if (!serie) return [];
			const refs = [String(id), ...(anciennes || [])];
			return serie.brouillons.filter(b => b.donnees.kind === kind && refs.includes(String(b.donnees.ref)));
		}
		function brouillonHtml(b, withTarget) {
			const r = b.donnees, cat = catLabel(r.kind, r.cat);
			return `<div class="fb-item st-brouillon">
		${withTarget ? `<span class="goto">${esc(r.name || r.ref)}</span>` : ""}
		<div class="meta"><span class="fb-pill">${esc(F.draft)}</span>${withTarget ? `<span>${esc(kindLabel(r.kind))}</span>` : ""}${cat ? `<span>${esc(cat)}</span>` : ""}</div>
		<div class="txt">${esc(r.text)}</div>
		${r.proposal ? `<div><b>${esc(F.proposalLbl)}</b> ${esc(r.proposal)}</div>` : ""}
		${vignettes(r.captures)}
		<div class="acts"><button type="button" class="btn small" data-draft-del="${esc(b.cle)}">${esc(F.draftRemove)}</button></div>
	</div>`;
		}
		// Barre de la série, dans #fb-top (créée ici : la page n'a rien à prévoir, et l'adaptateur artifact n'en a pas).
		let barre = null;
		function fbSerie() {
			if (!serieOk()) { if (barre) barre.hidden = true; return; }
			if (!barre) {
				barre = document.createElement("div");
				barre.className = "fb-serie"; barre.id = "fb-serie";
				document.getElementById("fb-top").appendChild(barre);
				barre.addEventListener("click", e => {
					const b = e.target.closest("button"); if (!b) return;
					const a = b.dataset.serie;
					if (a === "start") { serie = { brouillons: [] }; ecrireSerie(); serieMsg = ""; fbSerie(); fbRenderForm(); }
					else if (a === "drop") { serieConfirme = true; fbSerie(); barre.querySelector('[data-serie="drop-ok"]').focus(); }
					else if (a === "keep") { serieConfirme = false; fbSerie(); }
					else if (a === "drop-ok") { serie = null; serieConfirme = false; ecrireSerie(); serieMsg = ""; fbSerie(); fbDecorate(); fbRenderForm(); fbRenderList(); }
					else if (a === "send") envoyerSerie();
				});
			}
			barre.hidden = false;
			if (!serie) {
				barre.classList.remove("active");
				barre.innerHTML = `<button type="button" class="btn" data-serie="start" title="${esc(F.serieHelp)}">${esc(F.serieStart)}</button>${serieMsg ? `<span class="fb-msg" role="status">${esc(serieMsg)}</span>` : `<span class="fb-msg" role="status"></span>`}`;
				return;
			}
			const n = serie.brouillons.length;
			barre.classList.add("active");
			barre.innerHTML = `<span class="fb-serie-etat"><b>${esc(F.serieTitle)}</b> · ${esc(fmt(n > 1 ? F.serieMany : F.serieOne, { n }))}</span>` +
				`<button type="button" class="btn send" data-serie="send"${n ? "" : " disabled"}>${esc(F.serieSend)}</button>` +
				(serieConfirme ? `<button type="button" class="btn danger" data-serie="drop-ok">${esc(F.serieDropOk)}</button><button type="button" class="btn" data-serie="keep">${esc(F.serieKeep)}</button>`
					: `<button type="button" class="btn" data-serie="drop">${esc(F.serieDrop)}</button>`) +
				`<span class="fb-msg" role="status">${esc(serieMsg || F.serieLocal)}</span>`;
		}
		// --- Captures (R2) -------------------------------------------------------------------------------------
		// Champ « captures » d'un nouveau retour, seulement s'il y en a (le document reste celui d'avant sinon).
		const champCaptures = () => pieces.length ? { captures: pieces.map(p => p.id).join(" ") } : {};
		// Étape 3.9 : champ visé (R3) et « pour » (E3), seulement s'ils sont posés (le document reste celui d'avant sinon).
		const champsLot2 = () => { const p = (document.getElementById("fb-pour")?.value || ""); return { ...(fb.field ? { field: fb.field } : {}), ...(p ? { pour: p } : {}), ...(fb.point ? { point: fb.point } : {}) }; };
		function vignettes(ids) {
			if (!ids || typeof ids !== "string" || !capturesOk()) return "";
			const l = ids.split(" ").filter(x => /^[0-9a-f]{64}\.(png|webp)$/.test(x));
			return l.length ? `<div class="fb-caps">${l.map(id => { const u = fb.col.urlCapture(id); return `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(F.capAlt)}" loading="lazy"></a>`; }).join("")}</div>` : "";
		}
		function rendrePieces() {
			const w = document.getElementById("fb-pieces"); if (!w) return;
			w.innerHTML = pieces.map((p, i) => `<span class="fb-piece"><img src="${esc(p.apercu)}" alt="${esc(F.capAlt)}"><button type="button" class="btn small" data-cap-del="${i}" aria-label="${esc(F.capRemove)}">×</button></span>`).join("");
		}
		function capMsg(t) { const s = document.getElementById("fb-status"); if (s) s.textContent = t; }
		// Réencodage dans le navigateur : l'image est redessinée (1600 px au plus), puis exportée en WebP (PNG sinon). Les
		// métadonnées (EXIF, position) ne passent pas ; ce qui part est une image neuve.
		async function reencoder(file) {
			let src;
			if (typeof createImageBitmap === "function") src = await createImageBitmap(file);
			else src = await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => { const im = new Image(); im.onload = () => ok(im); im.onerror = ko; im.src = r.result; }; r.onerror = ko; r.readAsDataURL(file); });
			const w0 = src.width, h0 = src.height, k = Math.min(1, COTE_MAX / Math.max(w0, h0));
			const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
			c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
			let blob = await new Promise(ok => c.toBlob(ok, "image/webp", 0.85));
			if (!blob || blob.type !== "image/webp") blob = await new Promise(ok => c.toBlob(ok, "image/png"));
			const t = document.createElement("canvas"), kt = Math.min(1, 96 / Math.max(c.width, c.height));
			t.width = Math.max(1, Math.round(c.width * kt)); t.height = Math.max(1, Math.round(c.height * kt));
			t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
			return { blob, apercu: t.toDataURL("image/png") };
		}
		async function joindre(file) {
			if (!capturesOk() || fb.replyTo || !document.getElementById("fb-captures")) return;
			if (!file || !/^image\//.test(file.type || "")) { capMsg(F.capNotImage); return; }
			if (pieces.length + prepare >= MAX_CAPTURES) { capMsg(F.capMax); return; }
			prepare++; capMsg(F.capPreparing);
			try {
				const { blob, apercu } = await reencoder(file);
				const { id } = await fb.col.envoyerCapture(blob);
				if (!pieces.some(p => p.id === id)) pieces.push({ id, apercu });
				capMsg("");
			} catch (e) { capMsg(e && e.code === "quota_exceeded" ? F.full : e && e.code === "invalid_document" ? F.rejected : F.capFailed); }
			finally { prepare--; rendrePieces(); }
		}
		fbPanel.addEventListener("paste", e => {
			if (!document.getElementById("fb-captures")) return;
			const fichiers = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type));
			if (!fichiers.length) return;
			e.preventDefault();
			for (const f of fichiers) joindre(f);
		});
		fbPanel.addEventListener("dragover", e => { if (document.getElementById("fb-captures") && e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
		fbPanel.addEventListener("drop", e => {
			if (!document.getElementById("fb-captures") || !e.dataTransfer || !e.dataTransfer.files.length) return;
			e.preventDefault();
			for (const f of [...e.dataTransfer.files]) joindre(f);
		});

		let envoiSerie = false;
		async function envoyerSerie() {
			if (!serie || envoiSerie) return;
			if (!serie.brouillons.length) { serieMsg = F.serieEmpty; fbSerie(); return; }
			envoiSerie = true;
			const b = barre && barre.querySelector('[data-serie="send"]'); if (b) b.disabled = true;
			const n = serie.brouillons.length;
			try {
				const rs = await fb.col.ajouterSerie(serie.brouillons.map(x => x.donnees));
				serie = null; serieConfirme = false; ecrireSerie();
				serieMsg = fmt(F.serieSent, { n }) + " " + (rs && rs.demande ? F.serieAuto : F.serieNext);
			} catch (e) {
				const code = e && e.code;
				if (code === "permission_denied") { fb.readOnly = true; serieMsg = F.readOnly; }
				else if (code === "revoked") { fb.lost = true; fbNote(); serieMsg = F.lost; }
				else serieMsg = code === "quota_exceeded" ? F.full : code === "invalid_document" ? F.rejected : F.serieFailed;
			} finally { envoiSerie = false; }
			fbSerie(); fbDecorate(); fbRenderForm(); fbRenderList();
		}

		async function fbSubmit() {
			const text = document.getElementById("fb-text").value.trim();
			const st = document.getElementById("fb-status");
			if (!text) { st.textContent = F.needText; return; }
			if (!fb.replyTo && !fbCats(fb.target.kind).some(c => c[0] === fb.cat)) { st.textContent = F.needCat; return; }
			if (fb.sending) return;
			if (prepare) { st.textContent = F.capPreparing; return; }
			fb.sending = true; document.getElementById("fb-send").disabled = true;
			const now = new Date().toISOString();
			const wasReply = !!fb.replyTo;
			try {
				if (fb.replyTo) {
					const r = fb.all.find(x => x.id === fb.replyTo);
					// Seuls text, status et updated changent ; la version connue part a cote, jamais dans le document.
					await fb.col.modifier(fb.replyTo, { text: `${r.text}\n\n— ${r.status === "question" ? F.answerWord : F.precisionWord} ${F.of} ${fmtDate(now)} : ${text}`, status: "nouveau", updated: now }, versionDe(fb.replyTo));
					fb.replyTo = null;
				} else if (serie) {
					const t = fb.target;
					if (serie.brouillons.length >= MAX_SERIE) { st.textContent = fmt(F.serieFull, { n: MAX_SERIE }); return; }
					serie.brouillons.push({ cle: now + ":" + Math.random().toString(36).slice(2, 8), donnees: { kind: t.kind, ref: String(t.id), name: t.name, tab: t.tab, anchor: t.anchor, cat: fb.cat, text, proposal: (document.getElementById("fb-prop")?.value || "").trim(), status: "nouveau", reply: "", replied: "", created: now, updated: now, by: fb.uid || "", codex, ...champCaptures(), ...champsLot2() } });
					pieces = []; fb.field = ""; fb.fieldVal = ""; fb.point = "";
					ecrireSerie(); serieMsg = ""; fbSerie(); fbDecorate();
					document.getElementById("fb-text").value = "";
					fbRenderForm(); fbRenderList();
					const s3 = document.getElementById("fb-status"); if (s3) s3.textContent = fmt(F.serieKept, { n: serie.brouillons.length });
					return;
				} else {
					const t = fb.target;
					await fb.col.ajouter({ kind: t.kind, ref: String(t.id), name: t.name, tab: t.tab, anchor: t.anchor, cat: fb.cat, text, proposal: (document.getElementById("fb-prop")?.value || "").trim(), status: "nouveau", reply: "", replied: "", created: now, updated: now, by: fb.uid || "", codex, ...champCaptures(), ...champsLot2() });
					pieces = []; fb.field = ""; fb.fieldVal = ""; fb.point = "";
				}
				document.getElementById("fb-text").value = "";
				fbRenderForm(); fbRenderList();
				const s2 = document.getElementById("fb-status"); if (s2) s2.textContent = F.sent;
			} catch (e) {
				const code = e && e.code;
				// invalid_argument sur ajouter() = droit d'ecriture insuffisant : lecture seule pour la visite. Sur modifier(),
				// c'est aussi le code d'un retour supprime entre-temps : on ne bloque que cette reponse, et le texte reste.
				// permission_denied et not_found disent la meme chose sans ambiguite (adaptateurs autres qu'artifact). Sur
				// modifier(), permission_denied peut viser ce seul retour (celui d'un autre) : refus ponctuel, texte garde.
				if ((code === "permission_denied" || code === "invalid_argument" || code === "transform_error") && !wasReply) { fb.readOnly = true; fbRenderForm(); fbRenderList(); }
				else if ((code === "invalid_argument" || code === "not_found") && wasReply) fbDropReply();
				else if (code === "revoked") { fb.lost = true; fbNote(); fbRenderForm(); fbRenderList(); }
				else { const s2 = document.getElementById("fb-status"); if (s2) s2.textContent = code === "quota_exceeded" ? F.full : code === "conflict" ? F.conflict : code === "permission_denied" ? F.denied : code === "invalid_document" ? F.rejected : F.failed; }
			} finally {
				fb.sending = false; const b = document.getElementById("fb-send"); if (b) b.disabled = false;
			}
		}

		document.addEventListener("click", e => {
			const b = e.target.closest(".fb-btn"); if (!b) return;
			const el = b.closest("[data-fb-kind]");
			fbShow("element", { kind: el.dataset.fbKind, id: el.dataset.fbId, name: el.dataset.fbName, anciennes: aliasDe(el), ...fbCtx(el) });
		});
		// Étape 3.9, R3 : un champ de la fiche marqué par la page (data-fb-field, data-fb-valeur) ouvre un retour sur ce champ.
		document.addEventListener("click", e => {
			const c = e.target.closest("[data-fb-field]"); if (!c) return;
			const el = c.closest("[data-fb-kind]"); if (!el) return;
			fbShow("element", { kind: el.dataset.fbKind, id: el.dataset.fbId, name: el.dataset.fbName, anciennes: aliasDe(el), ...fbCtx(el) });
			fb.field = String(c.dataset.fbField || "").slice(0, 200); fb.fieldVal = String(c.dataset.fbValeur || "");
			fbRenderForm(); preremplir();
			const ta = document.getElementById("fb-text"); if (ta) ta.focus({ preventScroll: true });
		});
		// R4 : « trop fort / trop faible » sur un champ visé : la proposition part de sa valeur actuelle ; « bug » : un gabarit
		// étapes / attendu / obtenu dans un texte encore vide. Jamais par-dessus ce que l'on a écrit ; effaçable d'un geste.
		function preremplir() {
			const ta = document.getElementById("fb-text"), pr = document.getElementById("fb-prop");
			if (pr && !pr.value && fb.fieldVal && (F.prefillCats || []).includes(fb.cat)) pr.value = fb.fieldVal;
			if (ta && fb.cat === "bug" && !ta.value.trim()) ta.value = F.bugTpl;
			else if (ta && fb.cat !== "bug" && ta.value === F.bugTpl) ta.value = "";
		}
		fbPanel.addEventListener("change", async e => {
			const s = e.target.closest("select[data-confier]"); if (!s) return;
			try { await fb.col.modifier(s.dataset.confier, { pour: s.value, updated: new Date().toISOString() }, versionDe(s.dataset.confier)); }
			catch (err) { fbRenderList(); const w = document.getElementById("fb-listwrap"); if (w) w.insertAdjacentHTML("afterbegin", `<p class="fb-msg" role="status">${esc(err && err.code === "conflict" ? F.conflict : F.failed)}</p>`); }
		});
		document.getElementById("fb-general").addEventListener("click", () => {
			const t = typeof page.ongletCourant === "function" ? page.ongletCourant() : null; if (!t) return;
			fbShow("element", { kind: "general", id: t.id, name: fmt(F.generalName, { t: t.label }), tab: t.id, anchor: "" });
		});
		document.getElementById("fb-all-top").addEventListener("click", () => fbShow("all"));
		document.getElementById("fb-fab").addEventListener("click", () => fbPanel.hidden || fb.view !== "all" ? fbShow("all") : fbClose());
		document.getElementById("fb-close").addEventListener("click", () => fbClose());
		document.addEventListener("keydown", e => { if (e.key === "Escape" && !fbPanel.hidden) fbClose(); });
		fbPanel.addEventListener("submit", e => { e.preventDefault(); fbSubmit(); });
		fbPanel.addEventListener("click", async e => {
			const t = e.target.closest("button"); if (!t) return;
			const d = t.dataset;
			if (d.cat) { fb.cat = d.cat; fbPanel.querySelectorAll(".fb-cats button").forEach(x => x.setAttribute("aria-pressed", String(x === t))); preremplir(); }
			else if (d.fieldDel) { fb.field = ""; fb.fieldVal = ""; fbRenderForm(); }
			else if (d.pointDel) { fb.point = ""; fbRenderForm(); }
			else if (d.aussi) {
				const r = fb.all.find(x => x.id === d.aussi); if (!r) return;
				t.disabled = true;
				try { await fb.col.aussi(r.id, !aussiDe(r).includes(fb.uid), versionDe(r.id)); }
				catch (err) { t.disabled = false; const w = document.getElementById("fb-listwrap"); if (w) w.insertAdjacentHTML("afterbegin", `<p class="fb-msg" role="status">${esc(err && err.code === "conflict" ? F.conflict : err && err.code === "permission_denied" ? F.denied : F.failed)}</p>`); }
			}
			else if (d.dup) { fb.dup = d.dup; fbRenderList(); const s = document.getElementById("fb-dup-p"); if (s) s.focus(); }
			else if (d.dupNo) { fb.dup = null; fbRenderList(); }
			else if (d.dupOk) {
				const p = document.getElementById("fb-dup-p")?.value; if (!p) return;
				t.disabled = true;
				try { await fb.col.fusionner(p, [{ id: d.dupOk, ...versionDe(d.dupOk) }], versionDe(p)); fb.dup = null; fbRenderList(); }
				catch (err) { t.disabled = false; const w = document.getElementById("fb-listwrap"); if (w) w.insertAdjacentHTML("afterbegin", `<p class="fb-msg" role="status">${esc(err && err.code === "conflict" ? F.conflict : err && err.code === "permission_denied" ? F.denied : F.failed)}</p>`); }
			}
			else if (d.merged) { const r = fb.all.find(x => x.id === d.merged); if (r) fbGoto(r); }
			else if (d.filter) { fb.filter = d.filter; fbRenderList(); }
			else if (d.all) fbShow("all");
			else if (d.goto) { const r = fb.all.find(x => x.id === d.goto); if (r) fbGoto(r); }
			else if (d.reply) { fb.replyTo = d.reply; fbRenderForm(); document.getElementById("fb-text").focus(); fbBody.scrollTo(0, 0); }
			else if (d.replyCancel) { fb.replyTo = null; fbRenderForm(); }
			else if (d.capAdd) { const fi = document.getElementById("fb-file"); if (fi) fi.click(); }
			else if (d.capDel !== undefined) { pieces.splice(Number(d.capDel), 1); rendrePieces(); }
			else if (d.draftDel) { if (serie) { serie.brouillons = serie.brouillons.filter(b => b.cle !== d.draftDel); ecrireSerie(); fbSerie(); fbDecorate(); fbRenderList(); } }
			else if (d.del) { fb.confirmDel = d.del; fbRenderList(); }
			else if (d.delNo) { fb.confirmDel = null; fbRenderList(); }
			else if (d.delOk) {
				fb.confirmDel = null;
				try { await fb.col.supprimer(d.delOk, versionDe(d.delOk)); }
				catch (err) {
					fbRenderList();
					// Version perimee (adaptateur a versions) : le dire en tete de liste. Les autres refus restent muets, comme
					// dans le gabarit d'origine (CONTRAT.md § 6).
					const w = document.getElementById("fb-listwrap");
					if (w && err && err.code === "conflict") w.insertAdjacentHTML("afterbegin", `<p class="fb-msg" role="status">${esc(F.conflictDel)}</p>`);
				}
			}
		});

		// Étape 3.9, L7 : tickets qui citent chaque élément (champ pages « sorte:ref » d'un ticket, alias compris), en une
		// ligne au-dessus du pied des fiches (pas dans les lignes de tableau). Titre et statut sont des données : échappés.
		async function fbTickets() {
			let l;
			try { l = await fb.col.tickets(); } catch (e) { return; }
			if (!Array.isArray(l) || !l.length) return;
			document.querySelectorAll("[data-fb-kind]").forEach(el => {
				if (el.tagName === "TR") return;
				const slot = el.querySelector(".fb-slot"), pied = slot && slot.parentElement;
				if (!pied || pied === el) return;
				const refs = [String(el.dataset.fbId), ...aliasDe(el)].map(r => el.dataset.fbKind + ":" + r);
				const cites = l.filter(t => Array.isArray(t.pages) && t.pages.some(p => refs.includes(String(p))));
				const old = el.querySelector(":scope > .fb-tk");
				if (old) old.remove();
				if (!cites.length) return;
				const lien = t => /^(https?:\/\/[^\s"'<>]+|\/)[^\s"'<>]*$/.test(String(t.lien || "")) ? String(t.lien) : "";
				const html = cites.map(t => { const u = lien(t), txt = `${esc(t.id)} · ${esc(t.titre)}`; return `<span class="fb-tk-t">${u ? `<a href="${esc(u)}">${txt}</a>` : txt} <small>(${esc(F.ticketSt[t.statut] || t.statut)})</small></span>`; }).join("");
				pied.insertAdjacentHTML("beforebegin", `<div class="fb-tk"><span class="fb-tk-l">${esc(F.tickets)} :</span> ${html}</div>`);
			});
		}
		// Étape 3.9, E5 : sur chaque point « À valider » approuvé (le « Validé » d'un mainteneur ou d'un admin), une ligne
		// « Approuvé par … · date · build n ». Relue à chaque changement des retours, au plus toutes les 5 s.
		let apprAttente = 0, apprDernier = 0;
		function fbApprobations() {
			if (typeof fb.col?.approbations !== "function") return;
			const now = Date.now();
			if (now - apprDernier < 5000) { if (!apprAttente) apprAttente = setTimeout(() => { apprAttente = 0; fbApprobations(); }, 5000 - (now - apprDernier)); return; }
			apprDernier = now;
			fb.col.approbations().then(l => {
				if (!Array.isArray(l)) return;
				document.querySelectorAll('[data-fb-kind="validation"]').forEach(el => {
					const old = el.querySelector(":scope > .fb-appr"); if (old) old.remove();
					const a = l.filter(x => String(x.point) === String(el.dataset.fbId));
					const slot = el.querySelector(".fb-slot"), pied = slot && slot.parentElement;
					if (!a.length || !pied || pied === el) return;
					pied.insertAdjacentHTML("beforebegin", `<div class="fb-appr">${a.map(x => esc(fmt(F.apprLbl, { n: x.approuve_par, d: fmtDate(x.quand) })) + (x.build ? esc(fmt(F.apprBuild, { b: x.build })) : "")).join("<br>")}</div>`);
				});
			}, () => { });
		}
		// Étape 3.9, L9 : « x,y@empreinte » → « Point (41 %, 23 %) ».
		function pointTexte(p) { const m = /^([\d.]+),([\d.]+)/.exec(String(p || "")); return m ? fmt(F.pointShow, { x: Math.round(Number(m[1]) * 100), y: Math.round(Number(m[2]) * 100) }) : ""; }
		ecrireCourant = (el, extra) => {
			if (!el || !el.dataset || !el.dataset.fbKind) return false;
			fbShow("element", { kind: el.dataset.fbKind, id: el.dataset.fbId, name: el.dataset.fbName, anciennes: aliasDe(el), ...fbCtx(el) });
			if (extra && typeof extra.point === "string" && /^(0(\.\d{1,4})?|1(\.0{1,4})?),(0(\.\d{1,4})?|1(\.0{1,4})?)(@[0-9a-f]{8})?$/.test(extra.point)) { fb.point = extra.point; fbRenderForm(); }
			const ta = document.getElementById("fb-text"); if (ta) ta.focus({ preventScroll: true });
			return !!(fb.col && !fb.readOnly && !fb.offline && !fb.lost);
		};
		epinglesCourant = (kind, id, anciennes) => fbFor(kind, id, anciennes || []).filter(r => r.point && !r.fusionne_dans).sort((a, b) => String(a.created).localeCompare(String(b.created)))
			.map((r, i) => { const m = /^([\d.]+),([\d.]+)(?:@([0-9a-f]{8}))?$/.exec(r.point) || []; return { id: r.id, n: i + 1, x: Number(m[1]), y: Number(m[2]), empreinte: m[3] || "", statut: r.status, texte: String(r.text || "").slice(0, 160) }; })
			.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
		decorerCourant = fbDecorate;
		// Branche le stockage. Sans base (page ouverte comme fichier, lecteur sans acces), la page reste lisible : boutons
		// visibles, retours indisponibles, et la note dit pourquoi.
		(async () => {
			let c = null;
			try { c = await stockage.connecter(); } catch (e) { c = null; }
			if (!c || !c.retours) { fb.offline = (c && c.horsLigne === "file") ? "file" : "nodb"; fbNote(); fbDecorate(); return; }
			const id = c.identite || {};
			fb.uid = id.id || null;
			fb.owner = id.proprietaire === true;
			if (id.ecriture === false) fb.readOnly = true;
			fb.col = c.retours;
			document.getElementById("fb-top").hidden = false;
			document.getElementById("fb-fab").hidden = false;
			if (typeof fb.col.ajouterSerie === "function") { serie = lireSerie(); fbSerie(); }
			fbDecorate();
			if (typeof fb.col.tickets === "function") fbTickets();
			// Étape 3.9, écart 31 : noms affichés des membres (auteurs, « Moi aussi », « pour »), lus une fois.
			if (typeof fb.col.noms === "function") fb.col.noms().then(n => { if (isObj(n)) { fb.noms = n; fbRenderForm(); fbRenderList(); } }, () => { });
			const refresh = () => { fbNote(); fbRenderForm(); fbRenderList(); fbSerie(); };
			let late = 0, retried = false;
			const arm = () => { clearTimeout(late); late = setTimeout(() => { fb.late = true; refresh(); }, 10000); };
			// Apres une erreur, l'ecoute est morte : un seul nouvel abonnement (sauf revoked, definitif), puis on le dit.
			const listen = () => fb.col.ecouter(snap => {
				if (!snap.depuisCache) { clearTimeout(late); if (fb.late) { fb.late = false; fbNote(); fbRenderForm(); } }
				const docs = snap.docs || [];
				// L'id du stockage l'emporte sur un eventuel champ « id » du document. Toujours en texte : la page le relit
				// dans des attributs data-* et le compare avec ===.
				fb.all = docs.map(d => ({ ...d.donnees, id: String(d.id) }));
				fb.recu = true;
				fbApprobations();
				fb.versions = new Map(docs.filter(d => d.version !== undefined && d.version !== null).map(d => [String(d.id), d.version]));
				if (fb.replyTo && !fb.all.some(r => r.id === fb.replyTo)) fbDropReply();
				fbDecorate(); fbRefreshFab(); fbRenderList();
			}, e => {
				clearTimeout(late);
				if (!retried && !(e && e.code === "revoked")) { retried = true; arm(); setTimeout(listen, 1500 + Math.random() * 1000); return; }
				fb.lost = true; fb.late = false; refresh();
			});
			arm(); listen();
		})();
	}

	return Object.freeze({ demarrer, marque, emplacement, decorer, ecrire, epingles, textes: TEXTES });
})();
