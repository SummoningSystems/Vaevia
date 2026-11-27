#!/usr/bin/env node
// Site de retours : assemble la page à partir des données exportées par le projet et des notes datées.
//
//   node build.js <data.json> <page.html> [notes.json ...] [--template <gabarit.html>] [--notes-dir <dossier>] [--no-notes] [--check]
//
// - <data.json> : produit par l'exporteur du projet (schéma : references/schema.md du skill site-retours).
// - <page.html> : la page à publier (hors dépôt de préférence).
// - notes : fichiers donnés après la page, sinon tous les notes_*.json de --notes-dir (par défaut le dossier de ce
//   script, c'est-à-dire tools/site-retours/ du projet). Toujours triées de la plus récente à la plus ancienne
//   (champ « date », puis nom de fichier), quel que soit l'ordre de la ligne de commande.
// - gabarit : --template, sinon template.html à côté de ce script (copie du projet), sinon ../assets/template.html
//   (le gabarit du skill).
// - --check : valide sans écrire la page.
// Aucune dépendance : Node 18 ou plus.
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = { template: "", notesDir: "", noNotes: false, check: false };
const pos = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--template") opt.template = args[++i] || "";
	else if (a === "--notes-dir") opt.notesDir = args[++i] || "";
	else if (a === "--no-notes") opt.noNotes = true;
	else if (a === "--check") opt.check = true;
	else if (a === "-h" || a === "--help") { usage(0); }
	else if (a.startsWith("--")) { console.error("option inconnue : " + a); usage(1); }
	else pos.push(a);
}
const [dataPath, outPath, ...notesArgs] = pos;
if (!dataPath || (!outPath && !opt.check)) usage(1);

function usage(code) {
	console.error("usage : node build.js <data.json> <page.html> [notes.json ...] [--template <gabarit.html>] [--notes-dir <dossier>] [--no-notes] [--check]");
	process.exit(code);
}

const errors = [], warnings = [];
const err = m => errors.push(m), warn = m => warnings.push(m);
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); } catch (e) { console.error(`lecture impossible de ${p} : ${e.message}`); process.exit(1); } };
// Même fonction que le gabarit : lettres ASCII, chiffres, tirets simples.
const slug = s => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const isStr = v => typeof v === "string" && v.trim() !== "";
const isId = v => isStr(v) || (typeof v === "number" && Number.isFinite(v));
// Valeur affichable : texte, nombre fini ou booléen (Oui / Non). Un objet, null ou NaN trahit une donnée mal lue.
const okScalar = x => typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
const show = v => { const s = JSON.stringify(v); return s && s.length > 80 ? s.slice(0, 77) + "…" : s; };
// Noms d'ancre réservés par claude.ai, et onglets ajoutés par le gabarit pour les notes.
const RESERVED = new Set(["settings", "sidebar", "customize", "upgrade", "downloads", "nouveautes", "mesures", "a-valider"]);
// Sortes de retour réservées au gabarit (notes datées et remarque générale sur un onglet).
const RESERVED_KINDS = new Set(["nouveaute", "mesure", "validation", "general"]);
const TONES = new Set(["", "accent", "good", "warn", "bad", "muted"]);

// --- Dossier des notes -----------------------------------------------------------------------------------
// Lancé directement depuis le skill (sans copie dans le projet), le dossier du script n'est pas celui du projet :
// on n'y lit pas de notes, sinon des notes déposées là fuiraient dans tous les projets.
const inSkill = /[\\/]\.claude[\\/]skills[\\/]site-retours[\\/]scripts$/i.test(__dirname);
if (!opt.notesDir) {
	if (inSkill && !notesArgs.length && !opt.noNotes) warn("build.js lancé depuis le skill : notes non lues ; passer --notes-dir <projet>/tools/site-retours (ou copier build.js dans le projet)");
	opt.notesDir = inSkill ? "" : __dirname;
}

// --- Gabarit ---------------------------------------------------------------------------------------------
const tplCandidates = opt.template ? [opt.template] : [path.join(__dirname, "template.html"), path.join(__dirname, "..", "assets", "template.html")];
const tplPath = tplCandidates.find(p => fs.existsSync(p));
if (!tplPath) { console.error("gabarit introuvable : " + tplCandidates.join(" ; ")); process.exit(1); }
const tpl = fs.readFileSync(tplPath, "utf8");
if (tpl.split("/*__DATA__*/null").length !== 2) { console.error(`le gabarit doit contenir une seule fois /*__DATA__*/null (${tplPath})`); process.exit(1); }

// --- Données ---------------------------------------------------------------------------------------------
const d = readJson(dataPath);
if (!d || typeof d !== "object" || Array.isArray(d)) { console.error("data.json : un objet est attendu"); process.exit(1); }
if (!isStr(d.title)) err("data.title : texte non vide attendu");
for (const k of ["subtitle", "intro", "generated"]) if (d[k] !== undefined && typeof d[k] !== "string") err(`data.${k} : texte attendu`);
if (!d.generated) { d.generated = new Date().toISOString(); warn("data.generated absent : date de construction utilisée (l'exporteur devrait l'écrire)"); }
if (d.kinds !== undefined && (typeof d.kinds !== "object" || Array.isArray(d.kinds))) err("data.kinds : objet { sorte: libellé } attendu");
if (!Array.isArray(d.tabs) || !d.tabs.length) err("data.tabs : liste non vide attendue");

// Un lien interne peut citer l'id brut du projet : « #onglet--reminder.monthly » devient « #onglet--reminder-monthly ».
// La partie onglet (avant le premier « -- ») est gardée ; « --- » désigne une section.
function normAnchor(a) {
	const i = a.indexOf("--");
	if (i < 0) return a;
	const tab = a.slice(0, i), rest = a.slice(i + 2);
	return rest.startsWith("-") ? `${tab}---${slug(rest.slice(1))}` : `${tab}--${slug(rest)}`;
}

const anchors = new Set();
const kindsUsed = new Map();
const links = [];
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
			if (it.image !== undefined) {
				if (typeof it.image !== "string") err(`${iw2} : image doit être un texte`);
				else if (/^(https?:)?\/\//i.test(it.image)) err(`${iw2} : image externe bloquée par la page publiée ; utiliser une URI data: ou un fichier publié à côté (chemin relatif)`);
			}
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
for (const k of kindsUsed.keys()) if (!(d.kinds || {})[k]) warn(`sorte « ${k} » sans libellé dans data.kinds (affichée telle quelle)`);

// --- Notes datées ----------------------------------------------------------------------------------------
let notesPaths = [];
if (notesArgs.length) notesPaths = notesArgs;
else if (!opt.noNotes && opt.notesDir && fs.existsSync(opt.notesDir)) notesPaths = fs.readdirSync(opt.notesDir).filter(f => /^notes_.*\.json$/i.test(f)).map(f => path.join(opt.notesDir, f));
for (const p of notesPaths) if (!fs.existsSync(p)) { console.error("notes introuvables : " + p); process.exit(1); }
const sets = notesPaths.map(p => ({ p, n: readJson(p) }));
// La série la plus récente d'abord, toujours.
sets.sort((a, b) => String((b.n && b.n.date) || "").localeCompare(String((a.n && a.n.date) || "")) || path.basename(b.p).localeCompare(path.basename(a.p)));
const NOTE_TAB = { changes: "nouveautes", measures: "mesures", validations: "a-valider" };
const seen = { changes: new Map(), measures: new Map(), validations: new Map() };
const seenSlug = { changes: new Map(), measures: new Map(), validations: new Map() };
for (const { p, n } of sets) {
	const file = path.basename(p);
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
if (sets.length) d.notes = { sets: sets.map(s => s.n) };
const total = key => sets.reduce((s, x) => s + ((x.n && x.n[key]) || []).length, 0);
for (const key of Object.keys(NOTE_TAB)) if (total(key)) {
	anchors.add(NOTE_TAB[key]);
	for (const { n } of sets) for (const r of (n && n[key]) || []) if (r && isId(r.id)) anchors.add(`${NOTE_TAB[key]}--${slug(r.id)}`);
}
for (const [w, a] of links) if (!anchors.has(a)) err(`${w} : lien vers #${a}, ancre inconnue (onglet, onglet--élément ou onglet---section)`);

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
let out = tpl.replace("/*__DATA__*/null", () => json);
// Le <title> de la page (nom de l'artefact dans la galerie) vient de data.title ; il doit rester dans les 8 premiers Ko.
out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${escHtml(d.title)}</title>`);
if (out.indexOf("<title>") > 8192) console.warn("attention : le <title> n'est pas dans les 8 premiers Ko de la page");
// Contrôle de syntaxe de chaque script en ligne.
const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error("aucun <script> dans la page"); process.exit(1); }
for (const js of scripts) { try { new Function(js); } catch (e) { console.error("script de la page invalide : " + e.message); process.exit(1); } }
const kb = Buffer.byteLength(out, "utf8") / 1024;
if (kb > 16 * 1024) { console.error(`page trop lourde : ${kb.toFixed(0)} Ko (16 Mo au plus, images data: comprises)`); process.exit(1); }
if (kb > 2 * 1024) console.warn(`attention : page de ${(kb / 1024).toFixed(1)} Mo ; Claude relit ce qu'il publie : réduire les icônes et raccourcir les extraits`);
if (!opt.check) { fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); fs.writeFileSync(outPath, out); }
const kinds = [...kindsUsed.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
console.log(`${opt.check ? "VALIDE" : "OK"} ${kb.toFixed(0)} Ko · ${d.tabs.length} onglets · ${itemCount} éléments (${kinds}) · ` +
	(sets.length ? `notes : ${sets.length} fichier(s), ${total("changes")} nouveautés, ${total("measures")} mesures, ${total("validations")} points à valider` : "sans notes") +
	` · gabarit ${tplPath}${opt.check ? "" : " -> " + outPath}`);
