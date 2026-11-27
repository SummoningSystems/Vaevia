// Notes datées (notes_<date>.json, schéma : SCHEMA.md) : règles de validation partagées par site/build.js, le serveur
// (PUT /api/p/<projet>/notes/<nom>, serveur/src/notes.ts) et la CLI (outil notes envoyer). Une seule copie des règles :
// une note acceptée par le serveur est une note que build.js accepte, et inversement.
// CommonJS sans dépendance (Node 18 ou plus), comme build.js ; importable depuis un module ES (export par défaut).
"use strict";

// Réducteur d'ancre : même fonction que le gabarit (lettres ASCII, chiffres, tirets simples).
const slug = s => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const isStr = v => typeof v === "string" && v.trim() !== "";
const isId = v => isStr(v) || (typeof v === "number" && Number.isFinite(v));
const show = v => { const s = JSON.stringify(v); return s && s.length > 80 ? s.slice(0, 77) + "…" : s; };

// Liste de notes -> onglet du gabarit (ancres #nouveautes--<id>, #mesures--<id>, #a-valider--<id>).
const NOTE_TAB = { changes: "nouveautes", measures: "mesures", validations: "a-valider" };
// Fichiers lus par build.js dans un dossier de notes (--notes-dir) et par le serveur dans notes/.
const FICHIER_NOTES = /^notes_.*\.json$/i;
// Nom d'un fichier de notes envoyé au serveur (PUT /api/p/<projet>/notes/<nom>, outil notes envoyer) :
// notes_AAAA-MM-JJ[_suffixe].json, date réelle, suffixe en minuscules (a-z, 0-9, -) : deux noms qui ne diffèrent que
// par la casse partageraient un fichier sous Windows.
const NOM_NOTES = /^notes_(\d{4})-(\d\d)-(\d\d)(_[a-z0-9-]{1,40})?\.json$/;
function nomNotesValide(nom) {
	const m = String(nom).match(NOM_NOTES);
	if (!m) return false;
	const a = Number(m[1]), mo = Number(m[2]), j = Number(m[3]);
	const d = new Date(Date.UTC(a, mo - 1, j));
	return d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j;
}

// Séries : [{ fichier, n }] (fichier = nom de base, n = contenu lu). La plus récente d'abord, toujours : champ
// « date », puis nom de fichier. Trie sur place et rend la liste.
function trierSeries(sets) {
	return sets.sort((a, b) => String((b.n && b.n.date) || "").localeCompare(String((a.n && a.n.date) || "")) || b.fichier.localeCompare(a.fichier));
}

// Valide un ensemble de séries comme le fait build.js : ids uniques par liste dans TOUS les fichiers (ancre comprise),
// jalons déclarés, champs obligatoires. Les séries doivent être triées (trierSeries) : les messages nomment le fichier
// vu en second. Normalise sur place (liste absente -> []), comme build.js qui passe ensuite les séries au gabarit.
// Rend { erreurs, avertissements } (textes, mêmes messages que build.js).
function validerNotes(sets) {
	const erreurs = [], avertissements = [];
	const err = m => erreurs.push(m), warn = m => avertissements.push(m);
	const seen = { changes: new Map(), measures: new Map(), validations: new Map() };
	const seenSlug = { changes: new Map(), measures: new Map(), validations: new Map() };
	for (const { fichier: file, n } of sets) {
		if (!n || typeof n !== "object" || Array.isArray(n)) { err(`${file} : objet attendu`); continue; }
		if (!isStr(n.title) && !isStr(n.label)) err(`${file} : title manquant`);
		if (!isStr(n.date)) warn(`${file} : « date » absente (AAAA-MM-JJ) : l'ordre des séries se fait alors sur le nom de fichier`);
		const ms = n.milestones || {};
		for (const key of Object.keys(NOTE_TAB)) {
			if (n[key] === undefined) { n[key] = []; continue; }
			if (!Array.isArray(n[key])) { err(`${file} : « ${key} » doit être une liste`); n[key] = []; continue; }
			for (const row of n[key]) {
				if (!row || !isId(row.id)) { err(`${file} : identifiant absent dans « ${key} »`); continue; }
				const id = String(row.id);
				if (seen[key].has(id)) err(`${file} : identifiant en double dans « ${key} » : ${id} (aussi dans ${seen[key].get(id)}) ; une ref de retour doit rester unique`);
				else if (seenSlug[key].has(slug(id))) err(`${file} : « ${id} » donne la même ancre #${NOTE_TAB[key]}--${slug(id)} que « ${seenSlug[key].get(slug(id))} » ; choisir un autre id`);
				seen[key].set(id, file); seenSlug[key].set(slug(id), id);
				if (key !== "measures" && row.milestone !== undefined && !ms[row.milestone]) err(`${file} : jalon inconnu « ${row.milestone} » pour ${id} (à déclarer dans « milestones »)`);
				if (key === "changes" && !isStr(row.subject)) err(`${file} : nouveauté ${id} sans « subject »`);
				if (key === "validations" && !isStr(row.text)) err(`${file} : point à valider ${id} sans texte`);
				if (key === "measures") {
					if (!isStr(row.label)) err(`${file} : mesure ${id} sans « label »`);
					if (!Array.isArray(row.steps) || !row.steps.length) err(`${file} : mesure ${id} sans « steps »`);
					else for (const s of row.steps) if (!s || !isStr(String(s.when ?? "")) || s.value === undefined || s.value === null || s.value === "") err(`${file} : mesure ${id} : étape incomplète ${show(s)}`);
				}
			}
		}
	}
	return { erreurs, avertissements };
}

// Nombre de lignes d'une liste (changes, measures, validations) dans toutes les séries.
const totalNotes = (sets, key) => sets.reduce((s, x) => s + ((x.n && x.n[key]) || []).length, 0);

// Ancres créées par les notes (onglet, puis onglet--<id réduit> de chaque ligne), pour vérifier les liens de data.json.
function ancresNotes(sets) {
	const anchors = new Set();
	for (const key of Object.keys(NOTE_TAB)) if (totalNotes(sets, key)) {
		anchors.add(NOTE_TAB[key]);
		for (const { n } of sets) for (const r of (n && n[key]) || []) if (r && isId(r.id)) anchors.add(`${NOTE_TAB[key]}--${slug(r.id)}`);
	}
	return anchors;
}

module.exports = { slug, isStr, isId, show, NOTE_TAB, FICHIER_NOTES, NOM_NOTES, nomNotesValide, trierSeries, validerNotes, totalNotes, ancresNotes };
