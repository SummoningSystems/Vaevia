#!/usr/bin/env node
// Banc d'essai local du système de retours, sans rien publier ni écrire dans une base d'artefact.
//
//   node banc_essai.js <page.html> <dossier de sortie> [--scenarios <pilote.js>]
//
// Écrit dans le dossier (hors dépôt, ex. le scratchpad) :
// - banc.html       : la page avec un faux window.claude (base en mémoire, perdue à la fermeture) et trois retours
//                     d'essai posés sur les trois premiers éléments (en attente, question de Claude, appliqué) ;
// - banc_tous.html  : idem, tiroir « Tous les retours » ouvert au chargement ;
// - cadre390.html   : un cadre de 390 px de large pour voir une page en largeur téléphone avec Edge sans fenêtre
//                     (Edge headless ne descend pas sous ~500 px) : cadre390.html#<page encodée, ancre comprise>,
//                     ex. cadre390.html#banc.html%23a-valider
// Modes de la fausse base, par ?mode= dans l'URL (banc.html?mode=quota) :
//   normal (défaut) · readonly (can = false) · denywrite (can = null puis refus invalid_argument) · quota ·
//   unavailable (écritures refusées) · revoked (écoute coupée) · snapretry (première écoute perdue, la seconde
//   marche) · silent (la base ne répond jamais) ·
//   nodb (use("db") = null sur claude.ai) · nouser (use("user") = null) · offline (pas de window.claude).
// --scenarios <pilote.js> : écrit aussi t_<mode>.html pour chaque mode, avec le pilote injecté en fin de page et sans
//   retours d'essai (tests de régression du gabarit : voir references/verification.md).
// La fausse base suit le contrat db/user 0.2.96 : use() asynchrone et mémorisé, documents figés, metadata.fromCache
// (copie en cache puis réponse), update() d'un document absent rejeté en invalid_argument.
// Ces fichiers ne doivent jamais être publiés : ils simulent la base.
"use strict";
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2);
const si = argv.indexOf("--scenarios");
const driverPath = si >= 0 ? argv.splice(si, 2)[1] : "";
const [page, outDir] = argv;
if (!page || !outDir || (si >= 0 && !driverPath)) { console.error("usage : node banc_essai.js <page.html> <dossier de sortie> [--scenarios <pilote.js>]"); process.exit(1); }
const html = fs.readFileSync(page, "utf8");
// Point d'injection : le script principal du gabarit (fins de ligne LF ou CRLF).
const MARK = /<script>\r?\n"use strict";/;
if (!MARK.test(html)) { console.error("point d'injection introuvable (la page vient-elle du gabarit site-retours ?)"); process.exit(1); }

// Fausse base. Sérialisée telle quelle dans la page : elle ne doit utiliser aucune variable de ce fichier.
function fakeClaude(opts) {
	const MODE = new URLSearchParams(location.search).get("mode") || window.__MODE || "normal";
	const T = window.__T = { mode: MODE, errors: [], log: [], docs: new Map(), version: new Map(), subs: [] };
	addEventListener("error", e => T.errors.push("onerror: " + e.message + " @" + (e.lineno || "")));
	addEventListener("unhandledrejection", e => T.errors.push("unhandled: " + ((e.reason && (e.reason.code || e.reason.message)) || e.reason)));
	if (MODE === "offline") return;
	const freeze = o => Object.freeze(JSON.parse(JSON.stringify(o)));
	const meta = cache => ({ fromCache: !!cache, hasPendingWrites: false });
	const snapDoc = (id, cache) => { const d = T.docs.get(id); return Object.freeze({ id, exists: true, data: () => d, metadata: meta(cache) }); };
	const snap = cache => { const docs = [...T.docs.keys()].sort().map(id => snapDoc(id, cache)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta(cache) }; };
	const emit = () => setTimeout(() => T.subs.forEach(s => s.next(snap(false))), 5);
	const err = (code, message) => Object.assign(new Error(message || code), { code, message: message || code });
	const iso = m => new Date(Date.now() - m * 60000).toISOString();
	let nid = 0, seeded = false, snapCalls = 0;
	T.emit = emit;
	T.put = (id, data) => { T.docs.set(id, freeze(data)); T.version.set(id, (T.version.get(id) || 0) + 1); };
	T.writeServer = (id, patch) => { T.put(id, { ...T.docs.get(id), ...patch }); emit(); };
	// Trois retours d'essai posés sur les trois premiers éléments marqués (banc.html) ; en lecture seule, un retour
	// d'un autre lecteur sur le premier élément.
	const seed = () => {
		seeded = true;
		const first = document.querySelector("[data-fb-kind]");
		if (MODE === "readonly" && first) T.put("seed-ro", { kind: first.dataset.fbKind, ref: first.dataset.fbId, name: first.dataset.fbName, tab: (first.closest("[data-tab]") || { dataset: {} }).dataset.tab || "", anchor: first.id, cat: "idee", text: "Retour d'un autre lecteur.", proposal: "", status: "question", reply: "Une question ?", replied: iso(5), created: iso(60), updated: iso(5), by: "autre", codex: "" });
		if (!opts.seed) return;
		const st = [["nouveau", "", "idee"], ["question", "Tu préfères la valeur actuelle partout, ou seulement ici ?", "texte"], ["fait", "Fait : avant 4, après 6 (jalon d'essai, commit 0000000).", "autre"]];
		[...document.querySelectorAll("[data-fb-kind]")].slice(0, 3).forEach((el, i) => {
			const val = el.dataset.fbKind === "validation";
			T.put("essai" + (i + 1), { kind: el.dataset.fbKind, ref: el.dataset.fbId, name: el.dataset.fbName, tab: (el.closest("[data-tab]") || { dataset: {} }).dataset.tab || "", anchor: el.id, cat: val ? ["valide", "question", "revoir"][i] : st[i][2], text: "Retour d'essai n° " + (i + 1) + " (banc local).", proposal: i === 0 ? "proposition d'essai" : "", status: st[i][0], reply: st[i][1], replied: st[i][1] ? iso(5) : "", created: iso(60 - i * 10), updated: iso(5), by: i === 1 ? "autre-lecteur" : "essai", codex: "" });
		});
	};
	const docRef = (col, id) => ({
		id, path: col + "/" + id,
		async get() { return T.docs.has(id) ? snapDoc(id) : { id, exists: false, data: () => undefined, metadata: meta(false) }; },
		async set(data) { T.log.push(["set", id]); if (MODE === "denywrite") throw err("invalid_argument"); T.put(id, data); emit(); },
		async update(data) {
			T.log.push(["update", id, data]);
			if (MODE === "denywrite") throw err("invalid_argument", "below write level");
			if (MODE === "unavailable") throw err("unavailable");
			if (MODE === "revoked") throw err("revoked");
			if (!T.docs.has(id)) throw err("invalid_argument", "update of a missing document");
			T.put(id, { ...T.docs.get(id), ...data }); emit();
		},
		async delete() { T.log.push(["delete", id]); if (MODE === "denywrite") throw err("invalid_argument"); if (MODE === "revoked") throw err("revoked"); T.docs.delete(id); emit(); },
	});
	const colRef = p => {
		const c = {
			path: p,
			doc: id => docRef(p, id === undefined ? "auto" + (++nid) : id),
			async add(data) {
				T.log.push(["add", data]);
				if (MODE === "denywrite") throw err("invalid_argument", "below write level");
				if (MODE === "quota") throw err("quota_exceeded", "collection full");
				if (MODE === "unavailable") throw err("unavailable");
				if (MODE === "revoked") throw err("revoked");
				if (!data || typeof data !== "object" || Array.isArray(data)) throw err("invalid_argument");
				for (const [k, v] of Object.entries(data)) if (v === undefined) throw err("transform_error", "undefined field " + k);
				const id = "auto" + (++nid); T.put(id, data); emit();
				return docRef(p, id);
			},
			where() { return c; }, orderBy() { return c; }, limit() { return c; },
			async get() { return snap(false); },
			onSnapshot(next, error) {
				if (!seeded) seed();
				T.subs.push({ next, error });
				if (MODE === "revoked") { setTimeout(() => next(snap(true)), 10); setTimeout(() => error && error(err("revoked")), 60); return () => { }; }
				if (MODE === "silent") return () => { };
				if (MODE === "snapretry" && ++snapCalls === 1) { setTimeout(() => error && error(err("unavailable")), 30); return () => { }; }
				setTimeout(() => next(snap(true)), 10);
				setTimeout(() => next(snap(false)), 40);
				return () => { };
			},
		};
		return c;
	};
	const db = Object.freeze({ collection: colRef });
	const canWrite = MODE === "readonly" ? false : MODE === "denywrite" ? null : true;
	const user = Object.freeze({
		id: async () => "essai",
		isOwner: async () => false, canEdit: async () => canWrite !== false,
		can: async name => name === "data.write" ? canWrite : null,
		me: async () => ({ id: "essai", name: "", avatarUrl: "", color: "", email: null, isOwner: false, canEdit: canWrite !== false }),
		profiles: async () => ({}),
	});
	const memo = {};
	window.claude = Object.freeze({
		use: name => memo[name] || (memo[name] = new Promise(res => setTimeout(() => res(
			name === "db" ? (MODE === "nodb" ? null : db) : name === "user" ? (MODE === "nouser" ? null : user) : null), 60))),
	});
	if (opts.openAll) addEventListener("load", () => setTimeout(() => { const b = document.getElementById("fb-fab"); if (b && !b.hidden) b.click(); }, 400));
}
const stub = o => `<script>
// BANC D'ESSAI : faux window.claude, base en mémoire. Ne jamais publier ce fichier.
(${fakeClaude.toString()})(${JSON.stringify(o)});
</script>
`;
// Même enveloppe que l'outil Artifact à la publication (doctype, viewport) : la page n'est pas en mode quirks.
const SKEL = ['<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>', "</body></html>"];
const inject = (o, tail, head = "") => {
	let h = html.replace(MARK, m => stub(o) + m);
	if (tail) h = h.replace(/<\/script>\s*$/, () => `</script>\n<script>\n${tail}\n</script>\n`);
	return SKEL[0] + head + h + SKEL[1];
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "banc.html"), inject({ seed: true, openAll: false }));
fs.writeFileSync(path.join(outDir, "banc_tous.html"), inject({ seed: true, openAll: true }));
fs.writeFileSync(path.join(outDir, "cadre390.html"), `<!doctype html><meta charset="utf-8"><title>Cadre 390</title><style>body{margin:0;background:#888}iframe{width:390px;height:1700px;border:0;display:block}</style><iframe id="f"></iframe><script>document.getElementById("f").src = decodeURIComponent(location.hash.slice(1)) || "banc.html";</script>`);
const written = ["banc.html", "banc_tous.html", "cadre390.html"];
if (driverPath) {
	const driver = fs.readFileSync(driverPath, "utf8");
	for (const m of ["normal", "readonly", "denywrite", "quota", "unavailable", "revoked", "snapretry", "silent", "nodb", "nouser", "offline"]) {
		fs.writeFileSync(path.join(outDir, `t_${m}.html`), inject({ seed: false, openAll: false }, driver, `<script>window.__MODE=${JSON.stringify(m)};</script>\n`));
		written.push(`t_${m}.html`);
	}
}
console.log(`banc d'essai écrit dans ${outDir} : ${written.join(", ")} (à ne jamais publier)`);
