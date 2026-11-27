// Pilote de scénarios du système de retours, pour l'exemple du skill (examples/data.json + notes_exemple.json).
// Injecté par « banc_essai.js --scenarios » dans t_<mode>.html ; résultats écrits dans le bloc pre « __results »
// (PASS / FAIL / INFO), lus avec Edge --dump-dom. TEST LOCAL UNIQUEMENT : ne jamais publier ces pages.
(() => {
	const T = window.__T, MODE = T ? T.mode : "?";
	const out = []; const flush = () => { let p = document.getElementById("__results"); if (!p) { p = document.createElement("pre"); p.id = "__results"; document.body.appendChild(p); } p.textContent = "MODE " + MODE + "\n" + out.join("\n"); };
	const ok = (cond, msg, extra) => out.push((cond ? "PASS " : "FAIL ") + msg + (extra !== undefined ? "  :: " + JSON.stringify(extra) : ""));
	const info = (msg, v) => out.push("INFO " + msg + (v !== undefined ? "  :: " + JSON.stringify(v) : ""));
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const $ = s => document.querySelector(s);
	const $$ = s => [...document.querySelectorAll(s)];
	const txt = s => ($(s) || {}).textContent || "";
	const click = el => { if (!el) throw new Error("élément absent pour click"); el.click(); };
	const btnOf = (kind, id) => $$("[data-fb-kind]").find(e => e.dataset.fbKind === kind && e.dataset.fbId === id)?.querySelector(".fb-btn");
	const panelBtn = label => $$("#fb-panel button").find(b => b.textContent.trim().startsWith(label));
	const setVal = (sel, v) => { const e = $(sel); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); };
	const submit = () => click($("#fb-send"));
	const docs = () => [...T.docs.entries()].map(([id, d]) => ({ ...d, id }));
	const pressed = () => $$(".fb-cats button").map(b => b.getAttribute("aria-pressed") === "true");
	const SCHEMA = ["kind", "ref", "name", "tab", "anchor", "cat", "text", "proposal", "status", "reply", "replied", "created", "updated", "by", "codex"].sort();
	const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

	async function normal() {
		await sleep(300);
		ok($("#fb-off").hidden, "note hors ligne cachée");
		ok(!$("#fb-top").hidden && !$("#fb-fab").hidden, "barre retours + bouton flottant visibles");
		ok(txt("#fb-all-top") === "Tous les retours", "libellé « Tous les retours »", txt("#fb-all-top"));
		const marked = $$("[data-fb-kind]").length, btns = $$(".fb-btn").length;
		ok(marked === btns && btns === 24, "un bouton par élément (15 + 3 + 2 + 4)", { marked, btns });
		ok($("#fb-fab-n").hidden, "compteur flottant caché à vide");
		ok(/0 sur 4/.test(txt("#val-progress")), "progression à valider 0 sur 4", txt("#val-progress"));
		ok(/2,5/.test(txt("#regles--frost-alert")), "nombre décimal au format français", txt("#regles--frost-alert dl"));
		ok(!!$("#regles--watering-base-interval table"), "table rendue");
		ok($('#plantes--tomate a[data-nav="regles--watering-base-interval"]') !== null, "lien à id brut réduit par build.js");

		// 1. retour sur la tomate
		click(btnOf("plante", "tomate")); await sleep(30);
		ok(!$("#fb-panel").hidden, "tiroir ouvert");
		ok(txt("#fb-title") === "Tomate" && txt("#fb-eyebrow") === "Plante", "titre et sorte du tiroir", [txt("#fb-title"), txt("#fb-eyebrow")]);
		let cats = $$(".fb-cats button");
		ok(cats.length === 6 && pressed()[0], "6 types, le premier présélectionné");
		ok(document.activeElement === $("#fb-text"), "focus dans la zone de texte");
		submit(); await sleep(20);
		ok(txt("#fb-status") === "Écris ton retour avant d'envoyer.", "texte vide refusé", txt("#fb-status"));
		click(cats[3]);
		const NASTY = "Trop d'eau ? « été » 🌱 <" + "/script> \"guillemets\"";
		setVal("#fb-text", NASTY); setVal("#fb-prop", "tous les 3 jours");
		submit(); await sleep(150);
		const d = docs()[0] || {};
		ok(docs().length === 1, "un document créé", docs().length);
		ok(JSON.stringify(Object.keys(d).filter(k => k !== "id").sort()) === JSON.stringify(SCHEMA), "champs du document = schema.md", Object.keys(d));
		ok(d.kind === "plante" && d.ref === "tomate" && d.name === "Tomate" && d.tab === "plantes" && d.anchor === "plantes--tomate", "kind/ref/name/tab/anchor");
		ok(d.cat === "idee" && d.status === "nouveau" && d.reply === "" && d.replied === "", "cat/status/reply", { cat: d.cat, status: d.status });
		ok(d.text === NASTY && d.proposal === "tous les 3 jours", "texte et proposition intacts");
		ok(ISO.test(d.created) && d.created === d.updated, "created/updated ISO", d.created);
		ok(d.by === "essai" && d.codex === "2026-11-15T09:30:00Z", "by et codex", [d.by, d.codex]);
		ok(txt("#fb-status") === "Envoyé." && $("#fb-text").value === "", "message Envoyé, zone vidée");
		ok(pressed()[3], "le type choisi reste sélectionné après envoi");
		ok(btnOf("plante", "tomate").textContent.trim() === "✎ 1 retour · 1 en attente", "bouton tomate après envoi", btnOf("plante", "tomate").textContent.trim());
		ok(txt("#fb-fab-n") === "1", "compteur flottant 1", txt("#fb-fab-n"));
		ok(!!panelBtn("Supprimer"), "Supprimer proposé sur son propre retour");
		const id1 = d.id;

		// 2. saisie en cours pendant une mise à jour
		setVal("#fb-text", "brouillon en cours");
		T.writeServer(id1, { updated: new Date().toISOString() }); await sleep(50);
		ok($("#fb-text").value === "brouillon en cours", "la saisie survit à un snapshot");
		setVal("#fb-text", "");

		// 3. Claude pose une question
		T.writeServer(id1, { status: "question", reply: "Tous les 3 jours partout, ou seulement en avril ?", replied: "2026-11-15T18:40:00Z" }); await sleep(50);
		ok(btnOf("plante", "tomate").classList.contains("st-question"), "bouton passe en question");
		ok(btnOf("plante", "tomate").textContent.trim() === "✎ 1 retour · 1 question", "le bouton dit « question »", btnOf("plante", "tomate").textContent.trim());
		ok(txt("#fb-fab-n") === "1 · 1 question", "compteur flottant avec question", txt("#fb-fab-n"));
		click(panelBtn("Répondre")); await sleep(20);
		ok(/Tomate/.test(txt("#fb-formwrap")) && /seulement en avril/.test(txt("#fb-formwrap")), "formulaire de réponse : élément et question rappelés", txt("#fb-formwrap").slice(0, 160));
		ok(!$(".fb-cats"), "pas de type en mode réponse");
		setVal("#fb-text", "Seulement en avril."); submit(); await sleep(150);
		const d1 = T.docs.get(id1);
		ok(d1.status === "nouveau" && /— Réponse du .* : Seulement en avril\.$/.test(d1.text), "réponse ajoutée à text, statut nouveau", d1.text);
		const upd = T.log.filter(l => l[0] === "update").at(-1);
		ok(upd && JSON.stringify(Object.keys(upd[2]).sort()) === JSON.stringify(["status", "text", "updated"]), "update ne touche que text/status/updated");

		// 4. point à valider, nouveauté, retour au type par défaut
		click(btnOf("validation", "V1-seuil-chaleur")); await sleep(30);
		ok($$(".fb-cats button").length === 4 && pressed().every(p => !p), "validation : 4 types sans présélection");
		setVal("#fb-text", "OK pour 28."); submit(); await sleep(30);
		ok(txt("#fb-status") === "Choisis un type de retour avant d'envoyer.", "type obligatoire", txt("#fb-status"));
		click($$(".fb-cats button")[0]); submit(); await sleep(150);
		const dv = docs().find(x => x.kind === "validation");
		ok(dv && dv.cat === "valide" && dv.anchor === "a-valider--v1-seuil-chaleur", "document validation", dv && { cat: dv.cat, anchor: dv.anchor });
		ok(btnOf("validation", "V1-seuil-chaleur").textContent.trim() === "✎ Validé · En attente", "bouton validation", btnOf("validation", "V1-seuil-chaleur").textContent.trim());
		ok(/1 sur 4/.test(txt("#val-progress")), "progression 1 sur 4", txt("#val-progress"));
		click(btnOf("nouveaute", "V1-chaleur")); await sleep(20);
		ok(pressed().every(p => !p), "nouveauté sans présélection");
		click(btnOf("plante", "courgette")); await sleep(20);
		click($$(".fb-cats button")[4]); // Bug
		click(btnOf("plante", "persil")); await sleep(20);
		ok(pressed()[0] && !pressed()[4], "le type repart du défaut sur une autre fiche", pressed());

		// 5. remarque générale : ses propres types, sans présélection
		click($("#fb-close")); await sleep(10);
		click($("#t-ecrans")); await sleep(10);
		click($("#fb-general")); await sleep(20);
		ok(txt("#fb-title") === "Onglet « Écrans de l'appli »" && txt("#fb-eyebrow") === "Remarque générale", "tiroir remarque générale");
		ok($$(".fb-cats button").map(b => b.textContent).join("|") === "Idée|Présentation|Bug|Autre" && pressed().every(p => !p), "remarque générale : 4 types sans présélection", $$(".fb-cats button").map(b => b.textContent));
		setVal("#fb-text", "Il manque l'écran de connexion."); submit(); await sleep(30);
		ok(/Choisis un type/.test(txt("#fb-status")), "remarque générale : type obligatoire");
		click($$(".fb-cats button")[1]); submit(); await sleep(150);
		const dg = docs().find(x => x.kind === "general");
		ok(dg && dg.ref === "ecrans" && dg.cat === "texte" && dg.anchor === "", "document général", dg && { ref: dg.ref, cat: dg.cat });

		// 6. réponses de Claude, vue Tous, filtres, retours d'un autre lecteur, champ id parasite
		T.writeServer(dg.id, { status: "fait", reply: "Ajouté.", replied: "2026-11-15T19:00:00Z" });
		T.writeServer(dv.id, { status: "refuse", reply: "Non retenu.", replied: "2026-11-15T19:00:00Z" });
		T.put("zautre", { kind: "plante", ref: "basilic", name: "Basilic", tab: "plantes", anchor: "plantes--basilic", cat: "idee", text: "Retour d'un collègue.", proposal: "", status: "pris", reply: "Pris pour J4.", replied: "2026-11-15T19:00:00Z", created: "2026-11-15T08:00:00Z", updated: "2026-11-15T08:00:00Z", by: "collegue", codex: "", id: "faux-id" });
		T.emit(); await sleep(50);
		click($("#fb-fab")); await sleep(20);
		ok(txt("#fb-title") === "Tous les retours", "vue Tous");
		const counts = Object.fromEntries($$(".fb-filter button").map(b => [b.dataset.filter, b.textContent]));
		ok(/· 1$/.test(counts.ouverts) && /· 1$/.test(counts.pris) && /· 1$/.test(counts.fait) && /· 1$/.test(counts.refuse) && /· 4$/.test(counts.tous), "compteurs des filtres", counts);
		click($(".fb-filter [data-filter=pris]")); await sleep(10);
		const other = $$("#fb-listwrap .fb-item")[0];
		ok(other && /collègue/.test(other.textContent) && ![...other.querySelectorAll("button")].some(b => b.textContent === "Supprimer"), "pas de Supprimer sur le retour d'un autre");
		ok(other && other.querySelector("[data-goto]").dataset.goto === "zautre", "l'id réel l'emporte sur un champ id du document", other && other.querySelector("[data-goto]").dataset.goto);
		click($(".fb-filter [data-filter=tous]")); await sleep(10);
		ok(!$("#fb-formwrap").innerHTML.trim(), "pas de formulaire en vue Tous");
		const doneItem = $$("#fb-listwrap .fb-item").find(x => /Ajouté/.test(x.textContent));
		click([...doneItem.querySelectorAll("button")].find(b => b.textContent === "Ajouter une précision")); await sleep(20);
		ok(/Onglet « Écrans de l'appli »/.test(txt("#fb-formwrap")) && /Ajouté\./.test(txt("#fb-formwrap")), "précision en vue Tous : élément et réponse rappelés", txt("#fb-formwrap").slice(0, 160));
		setVal("#fb-text", "Merci"); submit(); await sleep(150);
		ok(T.docs.get(dg.id).status === "nouveau" && /Précision du/.test(T.docs.get(dg.id).text), "précision : retour repassé en nouveau");
		ok(!$("#fb-text"), "formulaire de précision refermé après envoi (vue Tous)");
		const g = $$("#fb-listwrap .goto").find(b => b.textContent === "Tomate");
		click(g); await sleep(50);
		ok(!$("#tab-plantes").hidden && location.hash === "#plantes--tomate", "aller à : onglet et ancre", location.hash);

		// 7. suppression avec confirmation
		click(btnOf("plante", "tomate")); await sleep(20);
		click(panelBtn("Supprimer")); await sleep(10);
		ok(!!panelBtn("Confirmer la suppression") && T.docs.has(id1), "confirmation demandée, rien supprimé");
		click(panelBtn("Garder")); await sleep(10);
		ok(!panelBtn("Confirmer la suppression"), "Garder annule");
		click(panelBtn("Supprimer")); await sleep(10);
		click(panelBtn("Confirmer la suppression")); await sleep(80);
		ok(!T.docs.has(id1) && btnOf("plante", "tomate").textContent.trim() === "✎ Retour", "document supprimé, bouton revenu à vide");

		// 8. le retour disparaît pendant qu'on y répond (snapshot) : réponse annulée, texte gardé
		click(btnOf("validation", "V1-seuil-chaleur")); await sleep(20);
		click(panelBtn("Ajouter une précision")); await sleep(10);
		setVal("#fb-text", "texte en cours");
		T.docs.delete(dv.id); T.emit(); await sleep(50);
		ok(!fbFormIsReply() && $("#fb-text") && $("#fb-text").value === "texte en cours" && /n'existe plus/.test(txt("#fb-status")), "retour disparu : réponse annulée, texte gardé", txt("#fb-status"));
		// 9. le retour est supprimé côté base sans snapshot : update() rejette invalid_argument, pas de lecture seule
		click(btnOf("plante", "basilic")); await sleep(20);
		click(panelBtn("Ajouter une précision")); await sleep(10);
		setVal("#fb-text", "précision perdue ?");
		T.docs.delete("zautre"); submit(); await sleep(100);
		ok(/n'existe plus/.test(txt("#fb-status")) && $("#fb-text") && $("#fb-text").value === "précision perdue ?", "update d'un retour supprimé : message, texte gardé", txt("#fb-status"));
		ok(!/pas d'en écrire/.test(txt("#fb-formwrap")), "pas de passage en lecture seule");

		// 10. recherche et Échap
		click($("#fb-close"));
		click($("#t-plantes")); setVal("#q", "basilic"); await sleep(10);
		{ const vis = $$("#tab-plantes .card").filter(c => !c.hidden).map(c => c.id); ok(vis.includes("plantes--basilic") && !vis.includes("plantes--courgette"), "recherche basilic", vis); }
		setVal("#q", "");
		click(btnOf("plante", "persil")); await sleep(10);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		ok($("#fb-panel").hidden, "Échap ferme le tiroir");
	}
	const fbFormIsReply = () => /Envoyer la réponse/.test(txt("#fb-send"));

	async function readonly() {
		await sleep(300);
		click(btnOf("plante", "tomate")); await sleep(20);
		ok(/pas d'en écrire/.test(txt("#fb-formwrap")) && !$("#fb-text"), "lecture seule : pas de formulaire");
		ok(!panelBtn("Supprimer") && !panelBtn("Ajouter") && !panelBtn("Répondre"), "lecture seule : aucune action");
		ok($$("#fb-listwrap .fb-item").length === 1, "lecture seule : retour existant visible");
	}
	async function denywrite() {
		await sleep(300);
		click(btnOf("plante", "tomate")); await sleep(20);
		ok(!!$("#fb-text"), "droits inconnus : formulaire gardé");
		setVal("#fb-text", "essai"); submit(); await sleep(100);
		ok(/pas d'en écrire/.test(txt("#fb-formwrap")), "refus invalid_argument sur add -> lecture seule");
	}
	async function quota() {
		await sleep(300);
		click(btnOf("plante", "tomate")); await sleep(20);
		setVal("#fb-text", "garde-moi"); submit(); await sleep(100);
		ok(/base des retours est pleine/.test(txt("#fb-status")) && $("#fb-text").value === "garde-moi" && !$("#fb-send").disabled, "quota : message, texte gardé, bouton réactivé");
	}
	async function unavailable() {
		await sleep(300);
		click(btnOf("plante", "tomate")); await sleep(20);
		setVal("#fb-text", "garde-moi"); submit(); await sleep(100);
		ok(/n'a pas abouti/.test(txt("#fb-status")) && $("#fb-text").value === "garde-moi", "indisponible : message et texte gardé");
	}
	async function revoked() {
		await sleep(400);
		ok(!$("#fb-off").hidden && /plus accessibles/.test(txt("#fb-off")), "revoked : note sous les onglets", txt("#fb-off"));
		click(btnOf("plante", "tomate")); await sleep(20);
		ok(!$("#fb-text") && /plus accessibles/.test(txt("#fb-body")), "revoked : pas de formulaire, message dans le tiroir");
		ok(!/Aucun retour sur cet élément/.test(txt("#fb-body")), "revoked : ne prétend pas qu'il n'y a aucun retour");
	}
	async function snapretry() {
		await sleep(3500);
		ok($("#fb-off").hidden, "écoute relancée une fois : pas de message", txt("#fb-off"));
		click(btnOf("plante", "tomate")); await sleep(20);
		setVal("#fb-text", "après relance"); submit(); await sleep(150);
		ok(docs().length === 1 && $$("#fb-listwrap .fb-item").length === 1, "écoute relancée : le retour apparaît");
	}
	async function silent() {
		await sleep(200);
		click(btnOf("plante", "tomate")); await sleep(11000);
		ok(/ne répondent pas encore/.test(txt("#fb-listwrap")), "base muette : message dans le tiroir", txt("#fb-listwrap"));
		ok(/ne répondent pas encore/.test(txt("#fb-off")) && !$("#fb-off").hidden, "base muette : note sous les onglets");
		click($("#fb-close")); click(btnOf("plante", "persil")); await sleep(20);
		ok(/ne répondent pas encore/.test(txt("#fb-listwrap")), "base muette : message encore là sur un autre élément");
	}
	async function offline() {
		await sleep(300);
		ok(!$("#fb-off").hidden && /ouverte comme fichier/.test(txt("#fb-off")), "hors claude.ai : note « fichier »");
		ok($("#fb-fab").hidden && $("#fb-top").hidden && $$(".fb-btn").length === 24, "hors ligne : boutons visibles, ni flottant ni barre");
		click(btnOf("plante", "tomate")); await sleep(20);
		ok(/ouvre la page publiée/.test(txt("#fb-body")) && !$("#fb-text"), "hors ligne : message dans le tiroir");
	}
	async function nodb() {
		await sleep(300);
		ok(!$("#fb-off").hidden && /indisponibles pour ce lecteur/.test(txt("#fb-off")) && !/fichier/.test(txt("#fb-off")), "sans base sur claude.ai : pas de message « fichier »", txt("#fb-off"));
		click(btnOf("plante", "tomate")); await sleep(20);
		ok(/indisponibles pour ce lecteur/.test(txt("#fb-body")), "sans base : message dans le tiroir");
	}
	async function nouser() {
		await sleep(300);
		click(btnOf("plante", "tomate")); await sleep(20);
		setVal("#fb-text", "sans user"); submit(); await sleep(100);
		const d = docs().at(-1);
		ok(d && d.by === "" && !!panelBtn("Supprimer"), "sans user : by vide, retour sans auteur supprimable");
	}
	const SC = { normal, readonly, denywrite, quota, unavailable, revoked, snapretry, silent, offline, nodb, nouser };
	window.addEventListener("load", async () => {
		out.push("START"); flush();
		try { await SC[MODE](); } catch (e) { out.push("FAIL exception : " + ((e && e.stack) || e)); }
		for (const e of T.errors) out.push("FAIL erreur JS : " + e);
		out.push("END"); flush();
	});
})();
