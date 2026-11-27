#!/usr/bin/env node
// Site de retours : assemble la page à partir des données exportées par le projet et des notes datées, du module
// retours et de l'adaptateur de stockage choisi. La page reste UN fichier HTML autonome (contrat Artifact).
//
//   node build.js <data.json> <page.html> [notes.json ...] [--template <gabarit.html>] [--stockage=<nom>] [--notes-dir <dossier>] [--no-notes] [--precedent <data.json>] [--check]
//
// - <data.json> : produit par l'exporteur du projet (schéma : SCHEMA.md à côté de ce script).
// - <page.html> : la page à publier (hors dépôt de préférence).
// - notes : fichiers donnés après la page, sinon tous les notes_*.json de --notes-dir (le dossier notes/ du dépôt de
//   design du projet, voir docs/architecture.md § 4). Sans l'un ni l'autre, aucune note (avec un avertissement) :
//   ce dossier-ci sert à tous les projets, des notes déposées ici fuiraient dans chacun. Toujours triées de la plus
//   récente à la plus ancienne (champ « date », puis nom de fichier), quel que soit l'ordre de la ligne de commande.
// - gabarit : --template, sinon gabarit/template.html à côté de ce script. Il porte quatre repères, chacun une seule
//   fois : RETOURS_CSS (styles du module), RETOURS (module), STOCKAGE (adaptateur) et DATA (données).
// - --stockage=<nom> (ou --stockage <nom>) : adaptateur retours/stockage-<nom>.js ; « artifact » par défaut
//   (base d'un Artifact claude.ai). Contrat des adaptateurs : retours/CONTRAT.md.
// - --precedent <data.json> : données du build précédent (le serveur passe celles du build n-1). La page montre alors
//   ce qui a changé (onglet « Changements », badges « modifié » / « nouveau ») : diff calculé, jamais écrit à la main.
// - --check : valide sans écrire la page.
// Aucune dépendance : Node 18 ou plus.
"use strict";
const fs = require("fs");
const path = require("path");
// Règles des notes datées, partagées avec le serveur et la CLI (une seule copie : valider-notes.js).
const { slug, isStr, isId, show, FICHIER_NOTES, trierSeries, validerNotes, totalNotes, ancresNotes } = require("./valider-notes.js");
// Ce qui a changé depuis le build précédent (--precedent), partagé avec le serveur (refs disparues).
const { calculerChangements } = require("./changements.js");

const args = process.argv.slice(2);
const opt = { template: "", stockage: "artifact", notesDir: "", noNotes: false, check: false, precedent: "" };
const pos = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--template") opt.template = args[++i] || "";
	else if (a === "--stockage") opt.stockage = args[++i] || "";
	else if (a.startsWith("--stockage=")) opt.stockage = a.slice("--stockage=".length);
	else if (a === "--notes-dir") opt.notesDir = args[++i] || "";
	else if (a === "--no-notes") opt.noNotes = true;
	else if (a === "--precedent") opt.precedent = args[++i] || "";
	else if (a === "--check") opt.check = true;
	else if (a === "-h" || a === "--help") { usage(0); }
	else if (a.startsWith("--")) { console.error("option inconnue : " + a); usage(1); }
	else pos.push(a);
}
const [dataPath, outPath, ...notesArgs] = pos;
if (!dataPath || (!outPath && !opt.check)) usage(1);

function usage(code) {
	console.error("usage : node build.js <data.json> <page.html> [notes.json ...] [--template <gabarit.html>] [--stockage=<nom>] [--notes-dir <dossier>] [--no-notes] [--precedent <data.json>] [--check]");
	process.exit(code);
}

const errors = [], warnings = [];
// Un message tient sur une ligne : une fin de ligne venue des données (valeur, libellé, id, sorte) forgerait sinon une
// ligne « attention : … » que le serveur rend à l'agent comme un avertissement (serveur/src/builds.ts, lireSortieBuild).
const uneLigne = m => String(m).replace(/\s*[\r\n]+\s*/g, " ");
const err = m => errors.push(uneLigne(m)), warn = m => warnings.push(uneLigne(m));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); } catch (e) { console.error(`lecture impossible de ${p} : ${e.message}`); process.exit(1); } };
// slug (même fonction que le gabarit), isStr, isId et show viennent de valider-notes.js.
// Valeur affichable : texte, nombre fini ou booléen (Oui / Non). Un objet, null ou NaN trahit une donnée mal lue.
const okScalar = x => typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
// Noms d'ancre réservés par claude.ai, et onglets ajoutés par le gabarit pour les notes.
const RESERVED = new Set(["settings", "sidebar", "customize", "upgrade", "downloads", "nouveautes", "mesures", "a-valider", "changements"]);
// Sortes de retour réservées au gabarit (notes datées et remarque générale sur un onglet).
const RESERVED_KINDS = new Set(["nouveaute", "mesure", "validation", "general"]);
const TONES = new Set(["", "accent", "good", "warn", "bad", "muted"]);
// Étape 3.9, L4 : statut et origine d'un élément (architecture § 2), comme l'en-tête des pages Markdown.
const STATUTS_EL = new Set(["idee", "specifie", "en-cours", "implemente", "ecart"]);
const ORIGINES_EL = new Set(["equipe", "deduit", "atelier", "agent"]);

// --- Dossier des notes -----------------------------------------------------------------------------------
// Le dossier de ce script est celui de l'outil, partagé par tous les projets : on n'y lit jamais de notes, sinon des
// notes déposées là fuiraient dans la page de chaque projet. Les notes viennent des arguments ou de --notes-dir.
if (!opt.notesDir && !notesArgs.length && !opt.noNotes) warn("aucune note lue : passer les fichiers notes_*.json après la page, ou --notes-dir <dossier notes/ du projet> (--no-notes pour taire cet avertissement)");

// --- Gabarit ---------------------------------------------------------------------------------------------
const tplCandidates = opt.template ? [opt.template] : [path.join(__dirname, "gabarit", "template.html")];
const tplPath = tplCandidates.find(p => fs.existsSync(p));
if (!tplPath) { console.error("gabarit introuvable : " + tplCandidates.join(" ; ")); process.exit(1); }
const tpl = fs.readFileSync(tplPath, "utf8");
// Repères d'injection : chacun une seule fois dans le gabarit.
const MARKS = { css: "/*__RETOURS_CSS__*/", module: "/*__RETOURS__*/", stockage: "/*__STOCKAGE__*/", data: "/*__DATA__*/null" };
for (const m of Object.values(MARKS)) if (tpl.split(m).length !== 2) { console.error(`le gabarit doit contenir une seule fois ${m} (${tplPath})`); process.exit(1); }
// Contrat Artifact : la publication ajoute elle-même doctype, html, head et body ; aucun script ni style externe
// (contrôlé plus bas sur le gabarit et sur chaque code injecté).
if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(tpl)) { console.error(`le gabarit ne doit contenir ni doctype, ni <html>, <head> ou <body> : la publication les ajoute (${tplPath})`); process.exit(1); }
// Ressource externe : script ou feuille chargés par URL, @import, ou url(...) vers http(s) ou « // ». Une URI data:
// (une icône SVG et son xmlns http://www.w3.org/2000/svg, par exemple) ne commence pas par « // » : elle passe.
// Les données (data.json) ne sont pas lues ici : leurs liens https:// sont des liens, et leurs images sont vérifiées plus bas.
// Les motifs CSS ne valent que pour le gabarit et retours.css : un adaptateur peut écrire new URL("https://…").
const EXTERNE_HTML = /<script\b[^>]*\bsrc\s*=|<link\b/i, EXTERNE_CSS = /@import\b|url\(\s*['"]?\s*(https?:)?\/\//i;
const externe = (c, ou, css) => { const m = c.match(EXTERNE_HTML) || (css && c.match(EXTERNE_CSS)); if (m) { console.error(`ressource externe interdite (${ou}) : « ${m[0]} » ; la page publiée doit tout contenir`); process.exit(1); } };
externe(tpl, tplPath, true);

// --- Module retours et adaptateur de stockage -------------------------------------------------------------
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(opt.stockage)) { console.error(`--stockage : nom invalide « ${opt.stockage} » (a-z, 0-9, tirets)`); process.exit(1); }
const RETOURS_DIR = path.join(__dirname, "retours");
const readCode = p => { try { return fs.readFileSync(p, "utf8").replace(/^﻿/, ""); } catch (e) { console.error(`lecture impossible de ${p} : ${e.message}`); process.exit(1); } };
const stockagePath = path.join(RETOURS_DIR, `stockage-${opt.stockage}.js`);
if (!fs.existsSync(stockagePath)) {
	const dispo = fs.existsSync(RETOURS_DIR) ? fs.readdirSync(RETOURS_DIR).map(f => (f.match(/^stockage-(.+)\.js$/) || [])[1]).filter(Boolean) : [];
	console.error(`adaptateur de stockage introuvable : ${stockagePath} (disponibles : ${dispo.join(", ") || "aucun"})`); process.exit(1);
}
const code = { css: readCode(path.join(RETOURS_DIR, "retours.css")), module: readCode(path.join(RETOURS_DIR, "retours.js")), stockage: readCode(stockagePath) };
if (!/\bwindow\.Retours\s*=/.test(code.module)) { console.error("retours.js doit définir window.Retours"); process.exit(1); }
if (!/\bwindow\.RetoursStockage\s*=/.test(code.stockage)) { console.error(`${path.basename(stockagePath)} doit définir window.RetoursStockage`); process.exit(1); }
// Le module ne dépend d'aucun stockage : il ne parle jamais à window.claude (c'est le rôle de l'adaptateur). Garde
// textuelle, pas une preuve : window, globalThis ou self suivis de .claude ou ["claude"], ou un claude global nu
// employé comme objet (claude.use, claude?.use). Les textes « claude.ai » ne sont pas visés.
if (/\b(window|globalThis|self)\s*(\?\.\s*|\.\s*)claude\b|\b(window|globalThis|self)\s*(\?\.\s*)?\[\s*["'`]claude["'`]\s*\]|(^|[^.\w$])claude\s*(\?\.|\.)\s*use\b/.test(code.module)) { console.error("retours.js ne doit pas référencer window.claude : passer par l'adaptateur de stockage"); process.exit(1); }
for (const [k, c] of Object.entries(code)) {
	externe(c, k === "module" ? "retours.js" : k === "css" ? "retours.css" : path.basename(stockagePath), k === "css");
	// « <!-- » dans un script ferait entrer l'analyseur HTML dans un état d'échappement : refusé plutôt que réécrit.
	if (c.includes("<!--")) { console.error(`« <!-- » interdit dans le code injecté (${k})`); process.exit(1); }
	for (const m of Object.values(MARKS)) if (c.includes(m)) { console.error(`le code injecté (${k}) contient le repère ${m}`); process.exit(1); }
}

// --- Données ---------------------------------------------------------------------------------------------
const d = readJson(dataPath);
if (!d || typeof d !== "object" || Array.isArray(d)) { console.error("data.json : un objet est attendu"); process.exit(1); }
if (!isStr(d.title)) err("data.title : texte non vide attendu");
for (const k of ["subtitle", "intro", "generated"]) if (d[k] !== undefined && typeof d[k] !== "string") err(`data.${k} : texte attendu`);
if (!d.generated) { d.generated = new Date().toISOString(); warn("data.generated absent : date de construction utilisée (l'exporteur devrait l'écrire)"); }
if (d.kinds !== undefined && (typeof d.kinds !== "object" || Array.isArray(d.kinds))) err("data.kinds : objet { sorte: libellé } attendu");
if (!Array.isArray(d.tabs) || !d.tabs.length) err("data.tabs : liste non vide attendue");
// Textes d'interface (ui, ui.notes, ui.fb…) : du texte seulement, rangé dans des objets ou des listes (ui.fb.cats).
// Le gabarit et le module les échappent à l'affichage ; un nombre, un booléen ou null trahit une erreur d'exporteur.
const textesSeulement = (v, ou) => {
	if (typeof v === "string") return;
	if (Array.isArray(v)) return v.forEach((x, i) => textesSeulement(x, `${ou}[${i}]`));
	if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => textesSeulement(x, `${ou}.${k}`));
	err(`${ou} : texte attendu (reçu ${show(v)})`);
};
if (d.ui !== undefined) { if (!d.ui || typeof d.ui !== "object" || Array.isArray(d.ui)) err("data.ui : objet attendu"); else textesSeulement(d.ui, "data.ui"); }

// Un lien interne peut citer l'id brut du projet : « #onglet--reminder.monthly » devient « #onglet--reminder-monthly ».
// La partie onglet (avant le premier « -- ») est gardée ; « --- » désigne une section.
function normAnchor(a) {
	const i = a.indexOf("--");
	if (i < 0) return a;
	const tab = a.slice(0, i), rest = a.slice(i + 2);
	return rest.startsWith("-") ? `${tab}---${slug(rest.slice(1))}` : `${tab}--${slug(rest)}`;
}

// Valeur de champ qui ressemble à un chemin d'image (res://…/x.png, ….png) : l'exporteur a écrit le chemin au lieu de
// l'image. Un avertissement, pas une erreur (un champ « Fichier » peut vouloir montrer le chemin) ; regroupé en une
// ligne. Sur l'extension seulement : un res:// de scène (.tscn) ou de script (.gd) montré exprès n'est pas une image.
const IMAGE_EN_TEXTE = /\.(png|jpe?g|webp|svg|gif)$/i;
const imagesEnTexte = [];
const anchors = new Set();
const kindsUsed = new Map();
const links = [];
// Anciennes refs déclarées (renommage) et ids par sorte : un alias ne doit pas désigner un autre élément de même sorte.
const alias = [], idsParSorte = new Map();
let itemCount = 0;
const tabIds = new Set();
for (const [ti, tab] of (Array.isArray(d.tabs) ? d.tabs : []).entries()) {
	const where = `onglet ${ti + 1}`;
	if (!tab || !isStr(tab.id)) { err(`${where} : id manquant`); continue; }
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tab.id)) err(`onglet « ${tab.id} » : l'id ne doit contenir que a-z, 0-9 et des tirets simples (ancre d'URL)`);
	if (RESERVED.has(tab.id) || tab.id.startsWith("comment-")) err(`onglet « ${tab.id} » : id réservé (claude.ai ou onglets de notes)`);
	if (tabIds.has(tab.id)) err(`onglet « ${tab.id} » : id en double`);
	tabIds.add(tab.id); anchors.add(tab.id);
	if (!isStr(tab.label)) err(`onglet « ${tab.id} » : label manquant`);
	// Vue tableau (étape 3.7, L2) : colonnes déclarées par l'exporteur, libellés de champs (sinon déduites par la page).
	if (tab.columns !== undefined && (!Array.isArray(tab.columns) || !tab.columns.length || tab.columns.length > 12 || !tab.columns.every(isStr))) err(`onglet « ${tab.id} » : columns doit être une liste de 1 à 12 libellés de champs (vue tableau)`);
	if (!Array.isArray(tab.sections)) { err(`onglet « ${tab.id} » : sections (liste) manquante`); continue; }
	const secIds = new Set(), itemSlugs = new Map();
	for (const [si, sec] of tab.sections.entries()) {
		const sw = `onglet « ${tab.id} », section ${si + 1}`;
		if (!sec || !isId(sec.id)) { err(`${sw} : id manquant`); continue; }
		if (secIds.has(slug(sec.id))) err(`${sw} : id de section en double (${sec.id})`);
		secIds.add(slug(sec.id)); anchors.add(`${tab.id}---${slug(sec.id)}`);
		if (!isStr(sec.title)) err(`${sw} : title manquant`);
		if (!Array.isArray(sec.items)) { err(`${sw} : items (liste) manquante`); continue; }
		for (const [ii, it] of sec.items.entries()) {
			const iw = `onglet « ${tab.id} », section « ${sec.id} », élément ${ii + 1}`;
			if (!it || typeof it !== "object") { err(`${iw} : objet attendu`); continue; }
			if (!isId(it.id)) { err(`${iw} : id manquant (utiliser l'identifiant du projet, jamais un index)`); continue; }
			const s = slug(it.id);
			if (itemSlugs.has(s)) err(`${iw} : id « ${it.id} » en double dans l'onglet (ou même ancre que « ${itemSlugs.get(s)} »)`);
			itemSlugs.set(s, it.id); anchors.add(`${tab.id}--${s}`);
			const iw2 = `${iw} (${it.id})`;
			if (!isStr(it.kind)) err(`${iw2} : kind manquant`);
			else if (RESERVED_KINDS.has(it.kind)) err(`${iw2} : kind « ${it.kind} » réservé au gabarit (${[...RESERVED_KINDS].join(", ")})`);
			else kindsUsed.set(it.kind, (kindsUsed.get(it.kind) || 0) + 1);
			if (!isStr(it.name)) err(`${iw2} : name manquant`);
			if (isStr(it.kind)) { if (!idsParSorte.has(it.kind)) idsParSorte.set(it.kind, new Set()); idsParSorte.get(it.kind).add(String(it.id)); }
			if (it.anciennes_refs !== undefined) {
				if (!Array.isArray(it.anciennes_refs) || !it.anciennes_refs.every(isId)) err(`${iw2} : anciennes_refs doit être une liste d'identifiants (les refs d'avant un renommage)`);
				else for (const a of it.anciennes_refs) {
					if (String(a) === String(it.id)) err(`${iw2} : anciennes_refs contient l'id de l'élément lui-même`);
					else alias.push([it.kind, String(a), iw2]);
				}
			}
			if (it.image !== undefined) {
				if (typeof it.image !== "string") err(`${iw2} : image doit être un texte`);
				else if (/^(https?:)?\/\//i.test(it.image)) err(`${iw2} : image externe bloquée par la page publiée ; utiliser une URI data:${opt.stockage === "http" ? "" : " ou un fichier publié à côté (chemin relatif)"}`);
				// Serveur (stockage http) : seule la page est servie, aucun fichier à côté ; un chemin relatif serait une image cassée.
				else if (opt.stockage === "http" && it.image && !/^data:/i.test(it.image)) err(`${iw2} : image « ${it.image.slice(0, 60)} » : URI data: seulement avec le stockage http (aucun fichier n'est servi à côté de la page)`);
			}
			// Étape 3.9 : image agrandie au clic (L10), même règle que image ; statut et origine de l'élément (L4).
			if (it.image_grande !== undefined) {
				if (typeof it.image_grande !== "string" || !it.image_grande) err(`${iw2} : image_grande doit être un texte`);
				else if (/^(https?:)?\/\//i.test(it.image_grande)) err(`${iw2} : image_grande externe bloquée par la page publiée ; utiliser une URI data:`);
				else if (opt.stockage === "http" && !/^data:/i.test(it.image_grande)) err(`${iw2} : image_grande : URI data: seulement avec le stockage http`);
				if (it.image === undefined) err(`${iw2} : image_grande sans image (la petite image de la fiche est celle qu'on clique)`);
			}
			if (it.statut !== undefined && !STATUTS_EL.has(it.statut)) err(`${iw2} : statut « ${it.statut} » inconnu (${[...STATUTS_EL].join(", ")})`);
			if (it.origine !== undefined && !ORIGINES_EL.has(it.origine)) err(`${iw2} : origine « ${it.origine} » inconnue (${[...ORIGINES_EL].join(", ")})`);
			if (it.badges !== undefined) {
				if (!Array.isArray(it.badges)) err(`${iw2} : badges doit être une liste`);
				else for (const b of it.badges) if (!(isStr(b) || (b && isStr(b.text) && TONES.has(b.tone || "")))) err(`${iw2} : badge invalide ${show(b)} (texte, ou { text, tone: accent|good|warn|bad|muted })`);
			}
			if (it.fields !== undefined) {
				if (!Array.isArray(it.fields)) err(`${iw2} : fields doit être une liste de [libellé, valeur]`);
				else for (const f of it.fields) {
					if (!Array.isArray(f) || f.length !== 2 || !isStr(f[0])) { err(`${iw2} : champ invalide ${show(f)}`); continue; }
					const v = f[1];
					if (!(okScalar(v) || (Array.isArray(v) && v.length && v.every(okScalar)))) err(`${iw2} : « ${f[0]} » : texte, nombre, booléen ou liste non vide de ceux-ci attendu, reçu ${show(v)} (l'exporteur a-t-il sérialisé un objet ou lu la mauvaise donnée ?)`);
					else if ([].concat(v).some(x => typeof x === "string" && /\b(undefined|NaN)\b|\[object Object\]/.test(x))) err(`${iw2} : « ${f[0]} » contient ${show(v)}`);
					else for (const x of [].concat(v)) if (typeof x === "string" && !/^data:/i.test(x.trim()) && IMAGE_EN_TEXTE.test(x.trim())) imagesEnTexte.push(`${tab.id}/${it.id} « ${f[0].replace(/\s+/g, " ").trim()} » = ${x.replace(/\s+/g, " ").trim().slice(0, 80)}`);
				}
			}
			if (it.table !== undefined) {
				const t = it.table;
				if (!t || typeof t !== "object" || !Array.isArray(t.rows) || !t.rows.length) err(`${iw2} : table attendue sous la forme { head: [..], rows: [[..], ..] }`);
				else {
					if (t.head !== undefined && (!Array.isArray(t.head) || !t.head.every(okScalar))) err(`${iw2} : table.head doit être une liste de textes`);
					for (const r of t.rows) {
						if (!Array.isArray(r) || !r.every(okScalar)) { err(`${iw2} : ligne de table invalide ${show(r)} (textes ou nombres)`); continue; }
						if (Array.isArray(t.head) && r.length !== t.head.length) err(`${iw2} : ligne de table de ${r.length} cases pour ${t.head.length} colonnes : ${show(r)}`);
					}
				}
			}
			if (it.list !== undefined && (!Array.isArray(it.list) || !it.list.every(x => typeof x === "string" || (typeof x === "number" && Number.isFinite(x))))) err(`${iw2} : list doit être une liste de textes`);
			if (it.text !== undefined && typeof it.text !== "string") err(`${iw2} : text doit être un texte`);
			if (it.links !== undefined) {
				if (!Array.isArray(it.links)) err(`${iw2} : links doit être une liste de [libellé, '#ancre']`);
				else for (const l of it.links) {
					if (!Array.isArray(l) || l.length !== 2 || !isStr(l[0]) || !isStr(l[1])) { err(`${iw2} : lien invalide ${show(l)}`); continue; }
					if (l[1].startsWith("#")) { l[1] = "#" + normAnchor(l[1].slice(1)); links.push([iw2, l[1].slice(1)]); }
					else if (!/^https:\/\//.test(l[1])) err(`${iw2} : lien « ${l[1]} » : '#ancre' ou https:// attendu`);
				}
			}
			itemCount++;
		}
	}
}
for (const [k, a, w] of alias) if (idsParSorte.get(k)?.has(a)) err(`${w} : anciennes_refs « ${a} » est l'id d'un autre élément de sorte « ${k} » (les retours de cet élément changeraient de fiche)`);
for (const k of kindsUsed.keys()) if (!(d.kinds || {})[k]) warn(`sorte « ${k} » sans libellé dans data.kinds (affichée telle quelle)`);
if (imagesEnTexte.length) warn(`image écrite comme du texte : ${imagesEnTexte.length} valeur(s) de champ ressemblent à un chemin d'image (${imagesEnTexte.slice(0, 3).join(" ; ")}${imagesEnTexte.length > 3 ? " ; …" : ""}) : ` +
	"lire le fichier source de l'image, la réduire (64 à 128 px) et l'écrire en URI data: dans « image » de l'élément (methode/exporteurs.md, « Images »)");

// --- Notes datées (règles : valider-notes.js) ----------------------------------------------------------
let notesPaths = [];
if (notesArgs.length) notesPaths = notesArgs;
else if (!opt.noNotes && opt.notesDir && fs.existsSync(opt.notesDir)) notesPaths = fs.readdirSync(opt.notesDir).filter(f => FICHIER_NOTES.test(f)).map(f => path.join(opt.notesDir, f));
for (const p of notesPaths) if (!fs.existsSync(p)) { console.error("notes introuvables : " + p); process.exit(1); }
// La série la plus récente d'abord, toujours.
const sets = trierSeries(notesPaths.map(p => ({ fichier: path.basename(p), n: readJson(p) })));
const verdict = validerNotes(sets);
verdict.erreurs.forEach(err); verdict.avertissements.forEach(warn);
if (sets.length) d.notes = { sets: sets.map(s => s.n) };
const total = key => totalNotes(sets, key);
for (const a of ancresNotes(sets)) anchors.add(a);
for (const [w, a] of links) if (!anchors.has(a)) err(`${w} : lien vers #${a}, ancre inconnue (onglet, onglet--élément ou onglet---section)`);

// --- Changements depuis le build précédent (L1) ---------------------------------------------------------
// Illisible ou absent : un avertissement, jamais un échec (le build lui-même est bon).
let changements = null, precedentLu = false;
if (opt.precedent) {
	let p = null;
	try { p = JSON.parse(fs.readFileSync(opt.precedent, "utf8").replace(/^﻿/, "")); } catch (e) { warn(`--precedent : lecture impossible (${e.message}) ; page construite sans les changements`); }
	if (p && typeof p === "object" && !Array.isArray(p)) { precedentLu = true; changements = calculerChangements(p, d); if (changements) d.changements = changements; }
	else if (p) warn("--precedent : un objet est attendu ; page construite sans les changements");
}

// --- Rapport et écriture ---------------------------------------------------------------------------------
for (const w of warnings) console.warn("attention : " + w);
if (errors.length) {
	for (const e of errors.slice(0, 60)) console.error("erreur : " + e);
	if (errors.length > 60) console.error(`… et ${errors.length - 60} autres erreurs`);
	process.exit(1);
}
// Tout « < » des données devient la séquence unicode u003c précédée d'un antislash (valide en JSON et en JS) :
// aucune donnée ne peut fermer la balise <script> ni ouvrir un commentaire HTML ; U+2028 et U+2029 aussi échappés.
const BS = String.fromCharCode(92), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
const json = JSON.stringify(d).replace(/</g, BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Tout « </ » du code injecté devient « <\/ » (même sens dans une chaîne, un gabarit littéral, une expression
// régulière ou un commentaire JS, et dans un commentaire ou une chaîne CSS) : rien ne peut fermer <script> ou <style>.
const safe = c => c.split("</").join("<" + BS + "/");
const inject = { [MARKS.css]: safe(code.css), [MARKS.module]: safe(code.module), [MARKS.stockage]: safe(code.stockage), [MARKS.data]: json };
// Un seul passage, remplacement par fonction : le contenu injecté n'est jamais relu (ni « $& », ni repère qu'il contiendrait).
const reMarks = new RegExp(Object.keys(inject).map(m => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "g");
let out = tpl.replace(reMarks, m => inject[m]);
// Le <title> de la page (nom de l'artefact dans la galerie) vient de data.title ; il doit rester dans les 8 premiers Ko.
out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${escHtml(d.title)}</title>`);
if (out.indexOf("<title>") > 8192) console.warn("attention : le <title> n'est pas dans les 8 premiers Ko de la page");
// Contrôle de syntaxe de chaque script en ligne.
const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error("aucun <script> dans la page"); process.exit(1); }
for (const js of scripts) { try { new Function(js); } catch (e) { console.error("script de la page invalide : " + e.message); process.exit(1); } }
const kb = Buffer.byteLength(out, "utf8") / 1024;
if (kb > 16 * 1024) { console.error(`page trop lourde : ${kb.toFixed(0)} Ko (16 Mo au plus, images data: comprises)`); process.exit(1); }
if (kb > 2 * 1024) console.warn(`attention : page de ${(kb / 1024).toFixed(1)} Mo ; la page est relue avant chaque publication et se charge sur téléphone : réduire les icônes et raccourcir les extraits`);
if (!opt.check) { fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); fs.writeFileSync(outPath, out); }
const kinds = [...kindsUsed.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
console.log(`${opt.check ? "VALIDE" : "OK"} ${kb.toFixed(0)} Ko · ${d.tabs.length} onglets · ${itemCount} éléments (${kinds}) · ` +
	(sets.length ? `notes : ${sets.length} fichier(s), ${total("changes")} nouveautés, ${total("measures")} mesures, ${total("validations")} points à valider` : "sans notes") +
	(precedentLu ? ` · changements : ${changements ? `${changements.modifies.length} modifiés, ${changements.ajoutes.length} ajoutés, ${changements.retires.length} retirés${changements.coupes ? ` (+${changements.coupes} non listés)` : ""}` : "aucun"}` : "") +
	` · stockage ${opt.stockage} · gabarit ${tplPath}${opt.check ? "" : " -> " + outPath}`);
