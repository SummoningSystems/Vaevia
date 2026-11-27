// Ce qui a changé entre deux builds (étape 3.7, L1) et refs d'une page (étape 3.7, G1). Partagé par build.js, qui
// injecte le diff dans la page, et par le serveur, qui compare les refs aux retours ouverts (CommonJS, comme
// valider-notes.js). Aucune dépendance.
//
// calculerChangements(avant, apres) -> { depuis, modifies: [...], ajoutes: [...], retires: [...], coupes } | null
//   avant, apres : deux data.json (déjà validés pour « apres »). Clé d'un élément : onglet + id (unique dans un onglet).
//   Valeurs mises en texte comme à l'affichage du gabarit, coupées à 200 caractères ; 500 entrées au plus (coupes :
//   nombre d'entrées laissées de côté). null si rien n'a changé.
// refsDeLaPage(data) -> Set de « sorte\u0000ref » : éléments (et leurs anciennes_refs), notes datées, onglets (sorte
//   « general », la remarque générale sur un onglet).
"use strict";

const MAX_VALEUR = 200, MAX_ENTREES = 500;
const couper = s => s.length > MAX_VALEUR ? s.slice(0, MAX_VALEUR - 1) + "…" : s;
// Même rendu que le gabarit (cell / val) pour les booléens et les listes ; les nombres restent bruts (la locale est
// celle du lecteur, appliquée par la page).
const cellule = x => typeof x === "boolean" ? (x ? "Oui" : "Non") : String(x ?? "");
const valeur = v => couper(Array.isArray(v) ? v.map(cellule).join(", ") : cellule(v));
const texteBadge = b => typeof b === "string" ? b : b && typeof b === "object" ? String(b.text ?? "") : "";

function elements(data) {
	const m = new Map();
	for (const tab of (data && Array.isArray(data.tabs) ? data.tabs : [])) {
		if (!tab || typeof tab.id !== "string") continue;
		for (const sec of (Array.isArray(tab.sections) ? tab.sections : [])) {
			for (const it of (sec && Array.isArray(sec.items) ? sec.items : [])) {
				if (!it || it.id === undefined || it.id === null) continue;
				m.set(`${tab.id}\u0000${it.id}`, { tab: tab.id, onglet: String(tab.label ?? tab.id), it });
			}
		}
	}
	return m;
}

// Différences entre deux fiches : [libellé, avant, après] (avant ou après vides pour un ajout ou un retrait de champ).
function differences(a, b) {
	const d = [];
	const cmp = (lib, x, y) => { if (x !== y) d.push([lib, x, y]); };
	cmp("Nom", valeur(a.name), valeur(b.name));
	cmp("Sous-titre", valeur(a.subtitle), valeur(b.subtitle));
	if ((a.image || "") !== (b.image || "")) d.push(["Image", a.image ? "image" : "", b.image ? (a.image ? "image changée" : "image") : ""]);
	cmp("Badges", valeur((a.badges || []).map(texteBadge)), valeur((b.badges || []).map(texteBadge)));
	// Étape 3.9, L4 : statut et origine (valeurs brutes : idee, specifie… ; le gabarit les traduit à l'affichage).
	cmp("Statut", valeur(a.statut), valeur(b.statut));
	cmp("Origine", valeur(a.origine), valeur(b.origine));
	const fa = new Map((Array.isArray(a.fields) ? a.fields : []).filter(Array.isArray).map(f => [String(f[0]), valeur(f[1])]));
	const fb = new Map((Array.isArray(b.fields) ? b.fields : []).filter(Array.isArray).map(f => [String(f[0]), valeur(f[1])]));
	for (const [k, v] of fb) cmp(k, fa.has(k) ? fa.get(k) : "", v);
	for (const [k, v] of fa) if (!fb.has(k)) d.push([k, v, ""]);
	cmp("Texte", valeur(a.text), valeur(b.text));
	cmp("Liste", valeur(a.list || []), valeur(b.list || []));
	if (JSON.stringify(a.table ?? null) !== JSON.stringify(b.table ?? null)) d.push(["Tableau", a.table ? "tableau" : "", b.table ? (a.table ? "tableau modifié" : "tableau") : ""]);
	return d;
}

function calculerChangements(avant, apres) {
	const ea = elements(avant), eb = elements(apres);
	const modifies = [], ajoutes = [], retires = [];
	let n = 0, coupes = 0;
	const garder = () => n < MAX_ENTREES ? (n++, true) : (coupes++, false);
	const ident = (e) => ({ tab: e.tab, onglet: e.onglet, id: String(e.it.id), kind: String(e.it.kind ?? ""), name: String(e.it.name ?? e.it.id) });
	// Renommage déclaré (anciennes_refs, même onglet et même sorte) : le même élément, modifié, pas un retrait plus un ajout.
	const repris = new Set();
	const ancien = (e) => {
		for (const r of (Array.isArray(e.it.anciennes_refs) ? e.it.anciennes_refs : [])) {
			const k = `${e.tab}\u0000${r}`, a = ea.get(k);
			if (a && !eb.has(k) && !repris.has(k) && String(a.it.kind ?? "") === String(e.it.kind ?? "")) { repris.add(k); return a; }
		}
		return null;
	};
	for (const [k, e] of eb) {
		let a = ea.get(k), renomme = false;
		if (!a) { a = ancien(e); renomme = !!a; }
		if (!a) { if (garder()) ajoutes.push(ident(e)); continue; }
		const champs = differences(a.it, e.it);
		if (renomme) champs.unshift(["Ref", String(a.it.id), String(e.it.id)]);
		if (champs.length && garder()) modifies.push({ ...ident(e), champs });
	}
	for (const [k, e] of ea) if (!eb.has(k) && !repris.has(k) && garder()) retires.push(ident(e));
	if (!modifies.length && !ajoutes.length && !retires.length && !coupes) return null;
	return { depuis: typeof avant?.generated === "string" ? avant.generated : "", modifies, ajoutes, retires, coupes };
}

const NOTES = [["changes", "nouveaute"], ["measures", "mesure"], ["validations", "validation"]];
function refsDeLaPage(data) {
	const refs = new Set();
	const ajouter = (kind, ref) => refs.add(`${kind}\u0000${ref}`);
	for (const tab of (data && Array.isArray(data.tabs) ? data.tabs : [])) {
		if (!tab || typeof tab.id !== "string") continue;
		ajouter("general", tab.id);
		for (const sec of (Array.isArray(tab.sections) ? tab.sections : []))
			for (const it of (sec && Array.isArray(sec.items) ? sec.items : [])) {
				if (!it || it.id === undefined || it.id === null) continue;
				ajouter(String(it.kind ?? ""), String(it.id));
				for (const a of (Array.isArray(it.anciennes_refs) ? it.anciennes_refs : [])) ajouter(String(it.kind ?? ""), String(a));
			}
	}
	// Onglets ajoutés par le gabarit : notes datées (et leur remarque générale), changements.
	for (const s of (data && data.notes && Array.isArray(data.notes.sets) ? data.notes.sets : []))
		for (const [cle, kind] of NOTES) for (const x of (Array.isArray(s[cle]) ? s[cle] : [])) if (x && x.id !== undefined) ajouter(kind, String(x.id));
	for (const t of ["nouveautes", "mesures", "a-valider", "changements"]) ajouter("general", t);
	return refs;
}

// Empreinte des données d'un build, sans la date d'export (« generated », que l'exporteur réécrit à chaque passage) :
// deux exports identiques sur le fond ont la même (étape 3.7, G2 : « outil publier --si-change »). SHA-256 du JSON
// (ordre des clés tel que lu : un même exporteur l'écrit toujours dans le même ordre). Node seulement.
function empreinteDonnees(data) {
	const crypto = require("crypto");
	const o = data && typeof data === "object" && !Array.isArray(data) ? { ...data } : data;
	if (o && typeof o === "object") delete o.generated;
	return crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
}

module.exports = { calculerChangements, refsDeLaPage, empreinteDonnees, MAX_ENTREES };
