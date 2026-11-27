// Bloc « Brancher un dépôt de code » de l'écran du projet (Kanban), pour un mainteneur ou un admin seulement (étape
// 3.5, § 8.4, D1). La phrase exacte à dire à son agent de code : elle nomme le serveur de retours, le projet, la CLI
// « outil » et sa commande de départ (un agent neuf ne comprend pas « Branche ce dépôt sur le serveur <URL> » seul).
// Adresse : celle de l'hôte principal (GET /api/moi, champ url : WDD_URL, ou déduite de Host), sinon l'origine de la
// page. Copier : navigator.clipboard, sinon le texte est sélectionné (Ctrl+C). Replié ou ouvert : retenu par projet
// dans ce navigateur (localStorage, s'il marche ; sinon ouvert).
import { h, copier } from "./dom.js";

export function phraseBranchement(url, projet) {
	return `Branche ce dépôt sur le serveur de retours ${url} (projet ${projet}) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : ${url}/outil).`;
}

const CLE = "wdd-branchement-replie";
function replies() {
	try { const l = JSON.parse(localStorage.getItem(CLE) || "[]"); return new Set(Array.isArray(l) ? l : []); } catch { return new Set(); }
}
function retenir(projet, replie) {
	try {
		const s = replies();
		if (replie) s.add(projet); else s.delete(projet);
		localStorage.setItem(CLE, JSON.stringify([...s]));
	} catch { }
}

function selectionner(el) {
	const s = window.getSelection();
	if (!s) return;
	const r = document.createRange();
	r.selectNodeContents(el);
	s.removeAllRanges();
	s.addRange(r);
}

export function blocBranchement(p, app) {
	const brute = app.moi && app.moi.url;
	const url = typeof brute === "string" && /^https?:\/\/[^/\s]+$/.test(brute) ? brute : location.origin;
	const phrase = phraseBranchement(url, p.id);
	const texte = h("p", { class: "phrase", dataset: { role: "phrase-branchement" } }, phrase);
	const etat = h("span", { class: "aide", role: "status", dataset: { role: "etat-copie" } });
	const bouton = h("button", { type: "button", dataset: { role: "copier-branchement" }, on: { click: async () => {
		selectionner(texte);
		etat.textContent = await copier(phrase) ? "Copié." : "Sélectionné : copie avec Ctrl+C.";
	} } }, "Copier");
	const bloc = h("details", { class: "branchement", dataset: { role: "branchement" } },
		h("summary", null, "Brancher un dépôt de code"),
		h("p", null, "Dis à ton agent de code (Claude Code, Codex…), ouvert dans le dossier du dépôt :"),
		texte,
		h("div", { class: "actions" }, bouton, etat),
		h("p", { class: "aide" }, "Il faut la CLI « outil » dans le PATH du poste du code : l'installeur Windows (installer.cmd) l'y ajoute."));
	bloc.open = !replies().has(p.id);
	bloc.addEventListener("toggle", () => retenir(p.id, !bloc.open));
	return bloc;
}
