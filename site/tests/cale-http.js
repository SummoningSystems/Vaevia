// Cale window.__T pour rejouer site/tests/scenarios.js (inchangé) contre le serveur de l'étape 1 (WDD_TEST=1), avec
// l'adaptateur « http ». TEST LOCAL UNIQUEMENT : injectée par site/tests/lancer-http.js dans l'onglet d'Edge piloté
// (Page.addScriptToEvaluateOnNewDocument : avant tout script de la page, donc avant le module retours et l'adaptateur,
// au même endroit que le faux window.claude du banc), jamais par le serveur ni dans une page servie normalement.
// Configuration posée juste avant par le pilote : window.__WDD_CALE = { mode, projet, attendreInstantane }.
//
// Ce que les scénarios attendent de window.__T (banc_essai.js), traduit en appels /__test/* :
//   T.mode, T.errors, T.log                 comme le banc ; T.log est rempli depuis les vraies requêtes de la page
//                                           (["add", document], ["update", id, champs], ["delete", id])
//   T.docs (lecture : get, has, entries, keys, values, forEach, size, itération)
//                                           XHR synchrone GET /__test/retours : l'état du serveur, sans effet des modes
//   T.docs.set(id, d) = T.put(id, d)        POST /__test/mettre (écrit tel quel, version +1, commit, diffusion)
//   T.docs.delete(id)                       POST /__test/supprimer { diffuser: false } (comme le banc : sans instantané)
//   T.writeServer(id, champs)               POST /__test/ecrire (fusion, version +1, commit, diffusion)
//   T.emit()                                POST /__test/diffuser
//   T.version (lecture, comme T.docs)       versions du serveur
//
// Le temps. Le banc répond en quelques millisecondes ; un commit prend ~100 ms ou plus, alors que les scénarios
// n'attendent que 10 à 150 ms après une écriture. La cale retient donc les minuteurs de la page (setTimeout) tant
// que le serveur n'a pas fini : une requête fetch de la page est en vol (jusqu'à la lecture de son corps), ou un
// flux est ouvert et l'instantané de la
// dernière écriture diffusée (son « rev ») n'y est pas encore arrivé. Les minuteurs retenus partent ensuite dans
// l'ordre de leurs échéances. Plafond : 5 s de retenue par minuteur (aucun blocage possible). Un instantané n'est
// attendu que si un flux est ouvert ou en connexion, et seulement après une écriture diffusée (ou au départ, dans
// les modes où le flux répond tout de suite) : une écriture qui échoue n'en attend aucun, et rien n'est attendu en
// silent (aucune écriture), revoked ni nodb (flux fermés).
(() => {
	"use strict";
	const C = window.__WDD_CALE || {};
	const MODE = C.mode || "normal";
	const T = window.__T = { mode: MODE, errors: [], log: [] };
	// Diagnostic lu par le pilote (pas par les scénarios) : minuteurs retenus, et partis au plafond (attente vaine).
	const diag = T.cale = { retenus: 0, plafonds: 0 };
	addEventListener("error", e => T.errors.push("onerror: " + e.message + " @" + (e.lineno || "")));
	addEventListener("unhandledrejection", e => T.errors.push("unhandled: " + ((e.reason && (e.reason.code || e.reason.message)) || e.reason)));
	const inerte = () => { };
	// Page ouverte comme fichier (mode offline) : pas de serveur, rien à traduire.
	if (location.protocol === "file:" || !C.projet) {
		Object.assign(T, { docs: new Map(), version: new Map(), put: inerte, writeServer: inerte, emit: inerte });
		return;
	}
	const projet = String(C.projet);

	// --- Appels synchrones à l'API de test (même origine ; X-WDD: 1, exigé sur toute écriture de /__test/) ---------
	function xhr(methode, chemin, corps) {
		const x = new XMLHttpRequest();
		x.open(methode, chemin, false);
		if (methode !== "GET") { x.setRequestHeader("Content-Type", "application/json"); x.setRequestHeader("X-WDD", "1"); }
		x.send(corps === undefined ? null : JSON.stringify(corps));
		let j = null;
		try { j = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) { j = null; }
		if (x.status < 200 || x.status >= 300) {
			const m = `cale : ${methode} ${chemin} -> ${x.status} ${String(x.responseText || "").slice(0, 200)}`;
			T.errors.push(m);
			throw new Error(m);
		}
		return j;
	}
	const lire = () => xhr("GET", "/__test/retours?projet=" + encodeURIComponent(projet));
	const carte = champ => new Map(((lire() || {}).docs || []).map(d => [String(d.id), d[champ]]));

	// --- Attente des écritures --------------------------------------------------------------------------------
	const stNatif = window.setTimeout.bind(window), ctNatif = window.clearTimeout.bind(window);
	const PLAFOND_MS = 5000;
	let enVol = 0, attendu = null;
	const recus = new Set(), sources = new Set();
	const fluxOuvert = () => [...sources].some(s => s.readyState !== 2);
	const occupe = () => enVol > 0 || (attendu !== null && fluxOuvert() && !recus.has(attendu));
	const attendre = rev => { if (rev) attendu = String(rev); };

	const ESNatif = window.EventSource;
	if (typeof ESNatif === "function") {
		window.EventSource = class extends ESNatif {
			constructor(url, options) {
				super(url, options);
				sources.add(this);
				this.addEventListener("instantane", ev => { try { const c = JSON.parse(ev.data); if (c && c.rev) recus.add(String(c.rev)); } catch (e) { } });
			}
		};
	}

	// Requêtes de la page : comptées tant qu'elles sont en vol ; les écritures réussies attendent leur instantané.
	const fetchNatif = window.fetch.bind(window);
	const API = /\/api\/p\/[^/]+\/retours(?:\/([^/?#]+))?(?:[?#]|$)/;
	window.fetch = function (entree, init) {
		const url = typeof entree === "string" ? entree : String((entree && entree.url) || entree);
		const methode = String((init && init.method) || (entree && entree.method) || "GET").toUpperCase();
		const m = url.match(API);
		if (m && methode !== "GET") {
			let corps = null;
			try { corps = init && typeof init.body === "string" ? JSON.parse(init.body) : null; } catch (e) { corps = null; }
			const id = m[1] ? decodeURIComponent(m[1]) : null;
			if (methode === "POST" && !id) T.log.push(["add", corps]);
			else if (methode === "PATCH") T.log.push(["update", id, corps && corps.champs]);
			else if (methode === "DELETE") T.log.push(["delete", id]);
		}
		enVol++;
		let fini = false;
		const fin = () => { if (!fini) { fini = true; enVol--; } };
		let p;
		try { p = fetchNatif(entree, init); } catch (e) { fin(); throw e; }
		return p.then(r => {
			// Écriture réussie : le serveur a commité puis diffusé ; son rev courant est celui de cet instantané.
			if (r.ok && m && methode !== "GET") { try { attendre((lire() || {}).rev); } catch (e) { } }
			// La requête reste « en vol » jusqu'à la lecture de son corps (r.json() de l'adaptateur) : c'est seulement
			// ensuite que le module reprend la main (en microtâches) et affiche le résultat. Sans corps (204), ou si
			// personne ne le lit, elle se termine tout de suite ou au bout de 5 s.
			if (r.status === 204 || r.status === 205 || methode === "HEAD") { fin(); return r; }
			stNatif(fin, PLAFOND_MS);
			const LECTURES = ["json", "text", "arrayBuffer", "blob", "formData", "bytes"];
			return new Proxy(r, {
				get(cible, cle) {
					const v = Reflect.get(cible, cle, cible);
					if (typeof v !== "function") return v;
					if (LECTURES.includes(cle)) return (...a) => { const q = v.apply(cible, a); q.then(fin, fin); return q; };
					return v.bind(cible);
				},
			});
		}, e => { fin(); throw e; });
	};

	// Minuteurs : retenus pendant une écriture, puis libérés dans l'ordre de leurs échéances.
	const vivants = new Map();   // id rendu à la page -> minuteur natif en cours (ou null s'il est dans la file)
	const retenus = [];          // { id, echeance, butoir, rappel }, triés par échéance
	let veilleur = 0;
	function veiller() {
		veilleur = 0;
		while (retenus.length && (!occupe() || Date.now() >= retenus[0].butoir)) {
			const t = retenus.shift();
			if (occupe()) diag.plafonds++;
			vivants.delete(t.id);
			// Une exception du rappel ne doit pas bloquer les suivants : relevée à part (onerror -> T.errors).
			try { t.rappel(); } catch (e) { stNatif(() => { throw e; }, 0); }
		}
		if (retenus.length) veilleur = stNatif(veiller, 5);
	}
	window.setTimeout = function (fn, ms, ...args) {
		if (typeof fn !== "function") return stNatif(fn, ms, ...args);
		const echeance = Date.now() + (Number(ms) || 0);
		let id;
		const rappel = () => fn.apply(window, args);
		const tirer = () => {
			if (!occupe() && !retenus.length) { vivants.delete(id); rappel(); return; }
			const t = { id, echeance, butoir: Date.now() + PLAFOND_MS, rappel };
			diag.retenus++;
			let i = retenus.length;
			while (i > 0 && retenus[i - 1].echeance > echeance) i--;
			retenus.splice(i, 0, t);
			vivants.set(id, null);
			if (!veilleur) veilleur = stNatif(veiller, 5);
		};
		id = stNatif(tirer, ms);
		vivants.set(id, id);
		return id;
	};
	window.clearTimeout = function (id) {
		if (vivants.has(id)) {
			const h = vivants.get(id);
			if (h !== null) ctNatif(h);
			else { const i = retenus.findIndex(t => t.id === id); if (i >= 0) retenus.splice(i, 1); }
			vivants.delete(id);
			return;
		}
		ctNatif(id);
	};

	// --- T : la base vue par les scénarios ---------------------------------------------------------------------
	T.put = (id, donnees) => { attendre(xhr("POST", "/__test/mettre", { projet, id, donnees }).rev); };
	T.writeServer = (id, champs) => { attendre(xhr("POST", "/__test/ecrire", { projet, id, champs }).rev); };
	T.emit = () => { attendre(xhr("POST", "/__test/diffuser", { projet }).rev); };
	const vue = champ => ({
		get: id => carte(champ).get(id),
		has: id => carte(champ).has(id),
		entries: () => carte(champ).entries(),
		keys: () => carte(champ).keys(),
		values: () => carte(champ).values(),
		forEach: (f, ceci) => carte(champ).forEach(f, ceci),
		get size() { return carte(champ).size; },
		[Symbol.iterator]: () => carte(champ).entries(),
	});
	T.docs = Object.assign(vue("donnees"), {
		set(id, donnees) { T.put(id, donnees); return T.docs; },
		// Comme Map.delete du banc : sans instantané (le serveur commite, la page n'en sait rien jusqu'au prochain).
		delete(id) {
			if (!carte("donnees").has(id)) return false;
			xhr("POST", "/__test/supprimer", { projet, id, diffuser: false });
			return true;
		},
	});
	T.version = vue("version");
	// Modes où le flux répond tout de suite : le premier instantané est attendu comme une écriture.
	if (C.attendreInstantane) { try { attendre((lire() || {}).rev); } catch (e) { } }
})();
