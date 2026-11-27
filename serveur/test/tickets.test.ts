// Tickets (docs/etape3-meta-interface.md § 1, § 2.1, § 3.1) : format du fichier (aller-retour, clés inconnues, fichier
// illisible), numérotation (100 créations concurrentes, numéro jamais réutilisé), cycle et droits (§ 1.3 cas par cas,
// fonctions pures puis API, dont « l'agent ne ferme jamais »), prise concurrente, fermeture tout ou rien, événement
// « tickets » du flux, agent « pour X », dépôt (commit limité, restauration, relecture au démarrage), historique.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits, ecouter } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import type { Acteur } from "../src/retours.ts";
import type { Role } from "../src/base.ts";
import type { Ticket } from "../src/ticket-fichier.ts";
import { analyser, serialiser, ErreurTicket } from "../src/ticket-fichier.ts";
import { transition, droitChampsTicket, droitCommits, droitCreerTicket, droitSupprimerTicket, actionPourStatut, reponseParDefaut } from "../src/tickets.ts";

const T0 = "2026-11-23T16:40:00.000Z";
const ticket = (o: Partial<Ticket> = {}): Ticket => ({
	id: "T-12", titre: "Créneaux du forum : ouverture à 7 h 30", statut: "a-faire", discipline: "", pris_par: null, retours: [], pages: [], criteres: [],
	commits: [], auteur: { type: "compte", id: "auteur", nom: "Auteur" }, cree: T0, modifie: T0, description: "", ...o,
});

describe("tickets : format du fichier (§ 1.1)", () => {
	const complet = ticket({
		statut: "pris", discipline: "programmation", pris_par: { type: "agent", id: "J1", nom: "Agent", pour: { id: "benoit", nom: "Benoît" } },
		retours: ["CIynw2EXnAWxKmMJVhy6", "lW3cfYSIYvcKvpZmE79x"], pages: ["salle:forum"], criteres: [{ texte: "une demande à 7 h 45 est acceptée", fait: false }],
		commits: [{ hash: "411d036", depot: "code", message: "T-12 : ouverture 07:30" }],
		description: "# Titre\n\nUne ligne seule :\n---\nfin --- et `---`\n\n",
	});
	test("aller-retour exact, clés dans l'ordre, valeurs JSON sur une ligne (YAML valide)", () => {
		const texte = serialiser({ version: 3, donnees: complet });
		const lignes = texte.split("\n");
		assert.equal(lignes[0], "---");
		assert.deepEqual(lignes.slice(1, 14).map(l => l.split(":")[0]), ["id", "version", "titre", "statut", "discipline", "pris_par", "retours", "pages", "criteres", "commits", "auteur", "cree", "modifie"]);
		assert.equal(lignes[1], 'id: "T-12"'); assert.equal(lignes[2], "version: 3");
		assert.equal(lignes[14], "---");
		const relu = analyser(texte, "T-12");
		assert.deepEqual(relu, { version: 3, donnees: complet }, "une ligne « --- » dans la description ne ferme rien");
		// Clone sous Windows (CRLF) : relu pareil.
		assert.deepEqual(analyser(texte.replace(/\n/g, "\r\n"), "T-12"), relu);
		// Avec un BOM en tête (éditeur sous Windows) : relu pareil.
		assert.deepEqual(analyser(String.fromCharCode(0xfeff) + texte, "T-12"), relu);
		assert.deepEqual(analyser(serialiser({ version: 1, donnees: ticket() }), "T-12").donnees.description, "");
	});
	test("U+2028, U+2029, U+0085 dans une valeur : écrits échappés, une ligne par clé ; un fichier qui les contient bruts se relit", () => {
		const [ls, ps, nel] = [0x2028, 0x2029, 0x85].map(c => String.fromCharCode(c));
		const t = ticket({ titre: `a${ls}b`, criteres: [{ texte: `c${ps}d`, fait: false }], commits: [{ hash: "411d036", depot: "code", message: `e${nel}f` }] });
		const texte = serialiser({ version: 2, donnees: t });
		const entete = texte.split("\n---\n")[0];
		assert.ok(![ls, ps, nel].some(c => entete.includes(c)), "aucun de ces caractères brut dans l'en-tête");
		assert.equal(entete.split("\n").length, 14, "une ligne par clé, plus « --- »");
		for (const l of entete.split("\n").slice(1)) assert.match(l, /^[a-z_]+: [^\n]*$/);
		assert.deepEqual(analyser(texte, "T-12"), { version: 2, donnees: t });
		// Fichier écrit avant l'échappement (ou à la main) : les caractères bruts se relisent.
		const brut = texte.replace(/\\u2028/g, ls).replace(/\\u2029/g, ps).replace(/\\u0085/g, nel);
		assert.ok(brut.includes(ls) && brut.includes(ps) && brut.includes(nel));
		assert.deepEqual(analyser(brut, "T-12"), { version: 2, donnees: t });
	});
	test("lecture stricte : clé inconnue, manquante ou en double, JSON invalide, valeurs hors règles, id différent du fichier", () => {
		const bon = serialiser({ version: 1, donnees: ticket() });
		const casse = (f: (s: string) => string, re: RegExp) => assert.throws(() => analyser(f(bon), "T-12"), (e: Error) => e instanceof ErreurTicket && re.test(e.message));
		casse(s => s.replace('statut: "a-faire"', 'statut: "a-faire"\npriorite: 1'), /clé inconnue : priorite/);
		casse(s => s.replace(/^discipline: .*\n/m, ""), /clé manquante : discipline/);
		casse(s => s.replace(/^(titre: .*)$/m, "$1\n$1"), /en double/);
		casse(s => s.replace('titre: "Créneaux', "titre: Créneaux"), /JSON/);
		casse(s => s.replace('statut: "a-faire"', 'statut: "termine"'), /statut inconnu/);
		casse(s => s.replace('statut: "a-faire"', 'statut: "pris"'), /preneur/);
		casse(s => s.replace("version: 1", "version: 0"), /version/);
		casse(s => s.replace("pages: []", 'pages: ["sans-deux-points"]'), /pages/);
		casse(s => s.replace("commits: []", 'commits: [{"hash":"XYZ","depot":"code","message":""}]'), /hash/);
		casse(s => s.slice(4), /en-tête absent/);
		casse(s => s.replace(/\n---\n/, "\n"), /non fermé/);
		assert.throws(() => analyser(bon, "T-13"), /différent du nom du fichier/);
	});
});

describe("tickets : droits et cycle (§ 1.2, § 1.3), fonctions pures", () => {
	const qui = (role: Role, id: string, jeton = false): Acteur => jeton || role === "agent"
		? { id: "agent:" + id, nom: id, role, email: `agent-${id}@wdd.invalid`, agent: true, jeton: id }
		: { id, nom: id, role, email: `${id}@wdd.invalid`, agent: false };
	const lecteur = qui("lecteur", "lea"), auteur = qui("contributeur", "auteur"), preneur = qui("contributeur", "paul"), autre = qui("contributeur", "zoe");
	const mainteneur = qui("mainteneur", "maud"), admin = qui("admin", "adm"), agent = qui("agent", "J1"), agent2 = qui("agent", "J2"), jetonMainteneur = qui("mainteneur", "JM", true);
	const pris = (par: Acteur, statut: "pris" | "en-revue" = "pris") => ticket({ statut, pris_par: par.agent ? { type: "agent", id: par.jeton!, nom: par.nom } : { type: "compte", id: par.id, nom: par.nom } });
	const ok = (r: string | null) => assert.equal(r, null);
	const non = (r: string | null) => assert.equal(typeof r, "string");
	const vaut = (a: Acteur, t: Ticket, act: Parameters<typeof transition>[2], attendu: string | number, forcer = false) => {
		const i = transition(a, t, act, forcer);
		if (typeof attendu === "number") { assert.equal(i.ok, false, `${a.id} ${act} : refus attendu`); assert.equal((i as any).statut, attendu, `${a.id} ${act} : ${(i as any).raison}`); }
		else { assert.equal(i.ok, true, `${a.id} ${act} : ${(i as any).raison}`); assert.equal((i as any).statut, attendu); }
		return i;
	};

	test("lecteur : lit seulement", () => {
		non(droitCreerTicket(lecteur)); non(droitChampsTicket(lecteur, ticket(), ["titre"], false)); non(droitCommits(lecteur, ticket()));
		vaut(lecteur, ticket(), "prendre", 403); non(droitSupprimerTicket(lecteur));
	});
	test("contributeur auteur : crée, modifie SES tickets, prend ; ne ferme, ne rouvre, ne supprime pas", () => {
		ok(droitCreerTicket(auteur));
		ok(droitChampsTicket(auteur, ticket(), ["titre", "description", "discipline", "retours", "pages", "criteres"], false));
		ok(droitChampsTicket(auteur, pris(preneur), ["titre"], false), "son ticket, même tenu par un autre");
		non(droitCommits(auteur, pris(preneur)));
		vaut(auteur, pris(preneur), "revue", 403);
		vaut(auteur, ticket(), "prendre", "pris");
		vaut(auteur, pris(preneur, "en-revue"), "fermer", 403);
		vaut(auteur, ticket({ statut: "fait" }), "rouvrir", 403);
		non(droitSupprimerTicket(auteur));
		non(droitChampsTicket(auteur, ticket({ statut: "fait" }), ["titre"], false), "ticket fait : seul un mainteneur");
	});
	test("contributeur preneur (pas l'auteur) : rend, passe en revue, renvoie, ajoute des commits, coche les critères seulement", () => {
		const t = pris(preneur);
		non(droitChampsTicket(preneur, t, ["titre"], false));
		ok(droitChampsTicket(preneur, t, ["criteres"], true));
		non(droitChampsTicket(preneur, t, ["criteres"], false), "changer le texte d'un critère : non");
		ok(droitCommits(preneur, t));
		vaut(preneur, t, "revue", "en-revue");
		vaut(preneur, pris(preneur, "en-revue"), "renvoyer", "pris");
		vaut(preneur, t, "rendre", "a-faire");
		assert.equal((transition(preneur, t, "rendre") as any).pris_par, null);
		assert.equal((transition(preneur, t, "prendre") as any).inchange, true, "le reprendre : sans effet");
		vaut(preneur, pris(preneur, "en-revue"), "fermer", 403);
	});
	test("contributeur autre : ni champs, ni commits, ni rendre ; prendre un ticket tenu → 409, forcer → 403", () => {
		const t = pris(preneur);
		non(droitChampsTicket(autre, t, ["titre"], false)); non(droitChampsTicket(autre, t, ["criteres"], true)); non(droitCommits(autre, t));
		vaut(autre, t, "rendre", 403); vaut(autre, t, "revue", 403);
		vaut(autre, t, "prendre", 409); vaut(autre, t, "prendre", 403, true);
	});
	test("mainteneur et admin : tout, dont prendre de force, fermer, rouvrir, supprimer, modifier un ticket fait", () => {
		for (const m of [mainteneur, admin]) {
			const t = pris(preneur, "en-revue");
			ok(droitChampsTicket(m, t, ["titre"], false)); ok(droitCommits(m, t)); ok(droitSupprimerTicket(m));
			vaut(m, t, "prendre", 409);
			const f = vaut(m, t, "prendre", "pris", true); assert.equal((f as any).forcee, true);
			vaut(m, t, "rendre", "a-faire"); vaut(m, t, "renvoyer", "pris");
			vaut(m, t, "fermer", "fait"); vaut(m, pris(preneur), "fermer", "fait");
			vaut(m, ticket(), "fermer", 400, false);
			vaut(m, ticket({ statut: "fait" }), "rouvrir", "a-faire");
			ok(droitChampsTicket(m, ticket({ statut: "fait" }), ["titre"], false));
		}
	});
	test("agent : crée, prend, rend, revue, commits et critères sur ce qu'il tient ; JAMAIS fermer, supprimer, ni le ticket d'un autre", () => {
		ok(droitCreerTicket(agent));
		const t = pris(agent);
		ok(droitCommits(agent, t)); ok(droitChampsTicket(agent, t, ["criteres"], true));
		vaut(agent, t, "revue", "en-revue"); vaut(agent, t, "rendre", "a-faire");
		vaut(agent, pris(agent, "en-revue"), "fermer", 403);
		vaut(agent, t, "fermer", 403);
		non(droitSupprimerTicket(agent));
		vaut(agent, ticket({ statut: "fait" }), "rouvrir", 403);
		// Le ticket d'un autre.
		const autreT = pris(preneur);
		non(droitChampsTicket(agent, autreT, ["titre"], false)); non(droitChampsTicket(agent, autreT, ["criteres"], true)); non(droitCommits(agent, autreT));
		vaut(agent, autreT, "prendre", 409); vaut(agent, autreT, "prendre", 403, true); vaut(agent, autreT, "rendre", 403);
		// Un autre jeton n'est pas le preneur.
		non(droitCommits(agent2, t)); vaut(agent2, t, "revue", 403);
		// Son propre ticket (créé par lui) : il le modifie.
		ok(droitChampsTicket(agent, ticket({ auteur: { type: "agent", id: "J1", nom: "J1" } }), ["titre"], false));
	});
	test("jeton mainteneur : comme un mainteneur, sauf fermer (geste humain)", () => {
		const t = pris(preneur, "en-revue");
		vaut(jetonMainteneur, t, "fermer", 403);
		vaut(jetonMainteneur, t, "prendre", "pris", true);
		vaut(jetonMainteneur, ticket({ statut: "fait" }), "rouvrir", "a-faire");
		ok(droitSupprimerTicket(jetonMainteneur)); ok(droitChampsTicket(jetonMainteneur, t, ["titre"], false));
	});
	test("PATCH statut : la même transition que les routes, jamais vers ni depuis « fait »", () => {
		assert.equal(actionPourStatut("a-faire", "pris"), "prendre");
		assert.equal(actionPourStatut("pris", "en-revue"), "revue");
		assert.equal(actionPourStatut("en-revue", "pris"), "renvoyer");
		assert.equal(actionPourStatut("pris", "a-faire"), "rendre");
		assert.equal(actionPourStatut("en-revue", "a-faire"), "rendre");
		assert.equal(actionPourStatut("pris", "pris"), null);
		assert.match(String(actionPourStatut("en-revue", "fait")), /fermer/);
		assert.match(String(actionPourStatut("fait", "a-faire")), /rouvrir/);
		assert.match(String(actionPourStatut("a-faire", "en-revue")), /pris/);
	});
	test("réponse de fermeture par défaut", () => {
		assert.equal(reponseParDefaut(ticket()), "Réglé par T-12.");
		assert.equal(reponseParDefaut(ticket({ commits: [{ hash: "411d036abcdef", depot: "code", message: "" }, { hash: "9fe02ab", depot: "web", message: "" }] })), "Réglé par T-12 (commits 411d036, 9fe02ab).");
	});
});

describe("tickets : API (§ 3.1)", () => {
	let s: Serveur, donnees: string, u: string, depot: string;
	let maud: string, camille: string, paul: string, lea: string, agent: string, agent2: string, jetonM: string;
	before(async () => {
		donnees = dossierTemp("tickets");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		paul = await session(u, "jardin", "paul", "contributeur", "Paul");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		const jeton = async (nom: string, role = "agent") => {
			const r = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom, role } });
			assert.equal(r.status, 201, r.texte);
			return r.corps.jeton as string;
		};
		agent = await jeton("Agent"); agent2 = await jeton("Autre agent"); jetonM = await jeton("Jeton mainteneur", "mainteneur");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const creerRetour = async (extra = {}) => (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour(extra) })).corps.id as string;
	const creerTicket = async (qui: { cookie?: string; bearer?: string }, corps: Record<string, unknown>) => {
		const r = await appel(u, "/api/p/jardin/tickets", { ...qui, corps });
		assert.equal(r.status, 201, r.texte);
		return r.corps.id as string;
	};
	const lire = async (id: string) => (await appel(u, `/api/p/jardin/tickets/${id}`, { cookie: maud })).corps;
	const post = (id: string, action: string, qui: { cookie?: string; bearer?: string }, corps: unknown) => appel(u, `/api/p/jardin/tickets/${id}/${action}`, { ...qui, corps });
	const patch = (id: string, qui: { cookie?: string; bearer?: string }, version: number, champs: unknown) => appel(u, `/api/p/jardin/tickets/${id}`, { ...qui, methode: "PATCH", corps: { version, champs } });

	test("création : 201 { id, version } ; validation ; champs posés par le serveur refusés ; retours inconnus refusés ; lecteur 403", async () => {
		const r1 = await creerRetour();
		const r = await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "  Arrosage  ", retours: [r1], pages: ["plante:tomate"], criteres: ["moins d'eau", { texte: "vérifié", fait: true }], description: "x\r\ny" } });
		assert.equal(r.status, 201, r.texte); assert.match(r.corps.id, /^T-\d+$/); assert.equal(r.corps.version, 1);
		const t = await lire(r.corps.id);
		assert.equal(t.donnees.titre, "Arrosage"); assert.equal(t.donnees.statut, "a-faire"); assert.equal(t.donnees.pris_par, null);
		assert.deepEqual(t.donnees.auteur, { type: "compte", id: "camille", nom: "Camille" });
		assert.deepEqual(t.donnees.criteres, [{ texte: "moins d'eau", fait: false }, { texte: "vérifié", fait: true }]);
		assert.equal(t.donnees.description, "x\ny");
		for (const corps of [{}, { titre: "" }, { titre: "a\nb" }, { titre: "x".repeat(201) }, { titre: "x", statut: "pris" }, { titre: "x", auteur: {} }, { titre: "x", pris_par: null },
			{ titre: "x", version: 3 }, { titre: "x", pages: ["pas de sorte"] }, { titre: "x", retours: Array(51).fill("a") }, { titre: "x", criteres: Array(31).fill("c") },
			{ titre: "x", discipline: "inconnue" }, { titre: "x", description: "d".repeat(20001) }, { titre: "x", retours: [r1, r1] },
			// Limites du § 1.1 : pages (50), critère (500 caractères, une ligne) ; description en Unicode bien formé.
			{ titre: "x", pages: Array.from({ length: 51 }, (_, i) => `p:${i}`) }, { titre: "x", criteres: ["c".repeat(501)] }, { titre: "x", criteres: ["a\nb"] },
			{ titre: "x", description: "a" + String.fromCharCode(0xd800) + "b" }])
			assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps })).status, 400, JSON.stringify(corps).slice(0, 80));
		const demi = await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "x", description: "a" + String.fromCharCode(0xd800) + "b" } });
		assert.equal(demi.status, 400); assert.match(demi.corps.message, /mal formé/, "refusé par la validation, avant la relecture du fichier");
		const inconnu = await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "x", retours: ["Inconnu123"] } });
		assert.equal(inconnu.status, 400); assert.deepEqual(inconnu.corps.retours, ["Inconnu123"]);
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: lea, corps: { titre: "x" } })).status, 403);
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: lea })).status, 200, "le lecteur lit");
		assert.equal((await appel(u, "/api/p/jardin/tickets/T-999", { cookie: lea })).status, 404);
		assert.equal((await appel(u, "/api/p/jardin/tickets/t-1", { cookie: lea })).status, 404, "id strict (t-1 viserait T-1 sous Windows)");
		assert.equal((await appel(u, "/api/p/jardin/tickets/..%2Fretours", { cookie: lea })).status, 404);
	});

	test("cycle par l'API, agent « pour Maud » : prendre, commits, critères, revue ; l'agent ne ferme jamais ; la mainteneuse ferme", async () => {
		const r1 = await creerRetour(), r2 = await creerRetour({ ref: "basilic" });
		const id = await creerTicket({ bearer: agent }, { titre: "Créneaux", retours: [r1, r2], pages: ["salle:forum"], criteres: ["7 h 45 acceptée", "7 h 15 refusée"] });
		let t = await lire(id);
		assert.deepEqual(t.donnees.auteur, { type: "agent", id: t.donnees.auteur.id, nom: "Agent", pour: { id: "maud", nom: "Maud" } });
		assert.match(git(depot, "log", "-1", "--format=%an <%ae>"), /^Agent \(pour Maud\) <agent-[A-Za-z0-9]+@wdd\.invalid>/);
		assert.equal((await post(id, "prendre", { bearer: agent }, { version: 1 })).status, 200);
		t = await lire(id);
		assert.equal(t.donnees.statut, "pris"); assert.deepEqual(t.donnees.pris_par.pour, { id: "maud", nom: "Maud" }); assert.equal(t.donnees.pris_par.type, "agent");
		// Un autre ne prend pas un ticket tenu : 409 avec le ticket à jour, même avec la bonne version.
		const pris = await post(id, "prendre", { cookie: paul }, { version: 2 });
		assert.equal(pris.status, 409); assert.equal(pris.corps.code, "conflict"); assert.equal(pris.corps.document.version, 2); assert.equal(pris.corps.document.donnees.statut, "pris");
		assert.equal((await post(id, "prendre", { cookie: paul }, { version: 2, forcer: true })).status, 403, "forcer : mainteneur seulement");
		assert.equal((await post(id, "prendre", { bearer: agent2 }, { version: 2 })).status, 409);
		// Commits : doublons ignorés (même dépôt, préfixe), hash en minuscules, dépôt par défaut « code ».
		const c = await post(id, "commits", { bearer: agent }, { version: 2, commits: [{ hash: "411D036ABC", message: "T-1 : ouverture" }, { hash: "411d036" }, { hash: "9fe02ab", depot: "web" }] });
		assert.equal(c.status, 200, c.texte); assert.equal(c.corps.ajoutes, 2); assert.equal(c.corps.version, 3);
		const avant = nbCommits(depot);
		const d = await post(id, "commits", { bearer: agent }, { version: 3, commits: [{ hash: "411d036abc" }] });
		assert.equal(d.status, 200); assert.equal(d.corps.inchange, true); assert.equal(nbCommits(depot), avant, "rien de nouveau : pas de commit");
		assert.equal((await post(id, "commits", { bearer: agent2 }, { version: 3, commits: [{ hash: "abcdef1" }] })).status, 403);
		assert.equal((await post(id, "commits", { bearer: agent }, { version: 3, commits: [{ hash: "xyz" }] })).status, 400);
		assert.equal((await post(id, "commits", { bearer: agent }, { version: 3, commits: [{ hash: "abcdef1", message: "deux\nlignes" }] })).status, 400);
		// Limites du § 1.1 : message (200 caractères), dépôt ([a-z0-9_-]{1,40}), 100 commits par ticket (2 déjà là).
		for (const commits of [[{ hash: "abcdef1", message: "m".repeat(201) }], [{ hash: "abcdef1", depot: "Web" }], [{ hash: "abcdef1", depot: "d".repeat(41) }],
			[{ hash: "abcdef1", depot: "" }], Array.from({ length: 99 }, (_, i) => ({ hash: (0x1000000 + i).toString(16) }))])
			assert.equal((await post(id, "commits", { bearer: agent }, { version: 3, commits })).status, 400, JSON.stringify(commits).slice(0, 80));
		// Aux limites (autre ticket) : 100 commits, message de 200 caractères, dépôt de 40 : acceptés ; un de plus : 400.
		const id2 = await creerTicket({ bearer: agent }, { titre: "Limites des commits" });
		assert.equal((await post(id2, "prendre", { bearer: agent }, { version: 1 })).status, 200);
		const cent = Array.from({ length: 100 }, (_, i) => ({ hash: (0x1000000 + i).toString(16), message: "m".repeat(200), depot: "d".repeat(40) }));
		const l = await post(id2, "commits", { bearer: agent }, { version: 2, commits: cent });
		assert.equal(l.status, 200, l.texte); assert.equal(l.corps.ajoutes, 100);
		assert.equal((await post(id2, "commits", { bearer: agent }, { version: 3, commits: [{ hash: "abcdef1" }] })).status, 400, "101e commit");
		t = await lire(id);
		assert.deepEqual(t.donnees.commits, [{ hash: "411d036abc", depot: "code", message: "T-1 : ouverture" }, { hash: "9fe02ab", depot: "web", message: "" }]);
		// Critères : un autre agent ne coche pas (le preneur qui n'est pas l'auteur : test suivant).
		assert.equal((await patch(id, { bearer: agent2 }, 3, { criteres: [{ texte: "7 h 45 acceptée", fait: true }, { texte: "7 h 15 refusée", fait: false }] })).status, 403);
		assert.equal((await patch(id, { bearer: agent }, 3, { titre: "Créneaux du forum" })).status, 200, "son propre ticket (créé par lui) : l'agent le modifie");
		const ck = await patch(id, { bearer: agent }, 4, { criteres: [{ texte: "7 h 45 acceptée", fait: true }, { texte: "7 h 15 refusée", fait: false }], statut: "en-revue" });
		assert.equal(ck.status, 200, ck.texte);
		t = await lire(id);
		assert.equal(t.donnees.statut, "en-revue"); assert.equal(t.donnees.criteres[0].fait, true);
		// Fermer : jamais un agent, ni un jeton mainteneur, ni un contributeur.
		const fermer = { version: 5, retours: [{ id: r1, version: 1 }, { id: r2, version: 1 }] };
		for (const qui of [{ bearer: agent }, { bearer: jetonM }, { cookie: camille }, { cookie: lea }]) {
			const r = await post(id, "fermer", qui, fermer);
			assert.equal(r.status, 403, JSON.stringify(qui).slice(0, 20) + " " + r.texte);
		}
		const n0 = nbCommits(depot);
		const f = await post(id, "fermer", { cookie: maud }, fermer);
		assert.equal(f.status, 200, f.texte); assert.deepEqual(f.corps.retours, [{ id: r1, version: 2 }, { id: r2, version: 2 }]);
		assert.equal(nbCommits(depot), n0 + 1, "un seul commit");
		assert.deepEqual(git(depot, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [`retours/${r1}.json`, `retours/${r2}.json`, `tickets/${id}.md`].sort());
		assert.match(git(depot, "log", "-1", "--format=%an|%s"), new RegExp(`^Maud\\|ticket ${id} : fermé \\(2 retours\\)`));
		const retours = (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs;
		for (const rid of [r1, r2]) {
			const x = retours.find((y: any) => y.id === rid);
			assert.equal(x.donnees.status, "fait"); assert.equal(x.donnees.reply, "Réglé par " + id + " (commits 411d036, 9fe02ab).");
			assert.equal(x.donnees.replied, x.donnees.updated); assert.ok(Date.now() - Date.parse(x.donnees.replied) < 60000);
		}
		t = await lire(id);
		assert.equal(t.donnees.statut, "fait");
		// Rouvrir : mainteneur (jeton mainteneur compris), pas l'agent ; journalisé.
		assert.equal((await post(id, "rouvrir", { bearer: agent }, { version: 6 })).status, 403);
		assert.equal((await post(id, "rouvrir", { bearer: jetonM }, { version: 6 })).status, 200);
		t = await lire(id);
		assert.equal(t.donnees.statut, "a-faire"); assert.equal(t.donnees.pris_par, null);
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "ticket rouvert" && e.cible === id));
	});

	test("preneur qui n'est pas l'auteur (agent) : coche les critères, ne réécrit ni leur texte ni le titre", async () => {
		const id = await creerTicket({ cookie: camille }, { titre: "Critères", criteres: ["a", "b"] });
		assert.equal((await post(id, "prendre", { bearer: agent }, { version: 1 })).status, 200);
		assert.equal((await patch(id, { bearer: agent }, 2, { criteres: [{ texte: "a", fait: true }, { texte: "autre", fait: false }] })).status, 403);
		assert.equal((await patch(id, { bearer: agent }, 2, { criteres: [{ texte: "a", fait: true }] })).status, 403, "ni retirer un critère");
		assert.equal((await patch(id, { bearer: agent }, 2, { titre: "titre de l'agent" })).status, 403);
		assert.equal((await patch(id, { bearer: agent }, 2, { criteres: [{ texte: "a", fait: true }, { texte: "b", fait: false }] })).status, 200);
		assert.deepEqual((await lire(id)).donnees.criteres, [{ texte: "a", fait: true }, { texte: "b", fait: false }]);
	});

	test("PATCH statut : prise sans force, rendre, renvoyer ; vers « fait » ou depuis « fait » refusé ; 409 sur version périmée", async () => {
		const id = await creerTicket({ cookie: camille }, { titre: "Statuts" });
		assert.equal((await patch(id, { cookie: paul }, 1, { statut: "en-revue" })).status, 400, "à faire → en revue : prendre d'abord");
		assert.equal((await patch(id, { cookie: paul }, 1, { statut: "pris" })).status, 200);
		let t = await lire(id); assert.equal(t.donnees.pris_par.id, "paul");
		// PATCH statut « pris » par un autre sur un ticket tenu : jamais une prise de force ; statut inchangé : aucune
		// écriture (ni commit ni nouvelle version), quel que soit l'appelant.
		const n0 = nbCommits(depot);
		const p = await patch(id, { cookie: maud }, 2, { statut: "pris" });
		assert.equal(p.status, 200); assert.equal(p.corps.inchange, true); assert.equal(p.corps.version, 2);
		assert.equal((await patch(id, { bearer: agent }, 2, { statut: "pris" })).corps.inchange, true, "agent non preneur : rien d'écrit");
		assert.equal((await patch(id, { cookie: lea }, 2, { statut: "pris" })).status, 403, "lecteur : refusé d'entrée");
		assert.equal((await patch(id, { cookie: lea }, 2, { titre: "lecteur" })).status, 403);
		assert.equal((await patch(id, { bearer: agent }, 2, { statut: "en-revue" })).status, 403, "agent non preneur : pas de revue");
		assert.equal((await patch(id, { bearer: agent }, 2, { statut: "a-faire" })).status, 403, "agent non preneur : ne rend pas");
		assert.equal(nbCommits(depot), n0);
		t = await lire(id); assert.equal(t.donnees.pris_par.id, "paul"); assert.equal(t.version, 2);
		assert.equal((await patch(id, { cookie: paul }, 2, { statut: "fait" })).status, 400);
		assert.equal((await patch(id, { cookie: camille }, 2, { statut: "en-revue" })).status, 403, "l'auteur qui ne le tient pas");
		assert.equal((await patch(id, { cookie: paul }, 1, { statut: "en-revue" })).status, 409, "version périmée");
		assert.equal((await patch(id, { cookie: paul }, 2, { statut: "en-revue" })).status, 200);
		assert.equal((await patch(id, { cookie: paul }, 3, { statut: "pris" })).status, 200, "renvoyer");
		assert.equal((await post(id, "rendre", { cookie: camille }, { version: 4 })).status, 403);
		assert.equal((await post(id, "rendre", { cookie: paul }, { version: 4 })).status, 200);
		t = await lire(id); assert.equal(t.donnees.statut, "a-faire"); assert.equal(t.donnees.pris_par, null);
		assert.equal((await patch(id, { cookie: camille }, 5, { statut: "inconnu" })).status, 400);
		assert.equal((await patch(id, { cookie: camille }, 5, { cree: T0 })).status, 400, "champ posé par le serveur");
		assert.equal((await patch(id, { cookie: camille }, 5, {})).status, 400);
		// Prise forcée (mainteneur) : journalisée.
		assert.equal((await patch(id, { cookie: paul }, 5, { statut: "pris" })).status, 200);
		const f = await post(id, "prendre", { cookie: maud }, { version: 6, forcer: true });
		assert.equal(f.status, 200, f.texte);
		t = await lire(id); assert.equal(t.donnees.pris_par.id, "maud");
		const j = s.ctx.base.lireJournal().find(e => e.action === "prise forcée" && e.cible === id);
		assert.ok(j); assert.equal(j!.qui, "maud"); assert.match(j!.detail, /paul/);
		// Fait → PATCH refusé ; fermer depuis « à faire » refusé.
		assert.equal((await post(id, "fermer", { cookie: maud }, { version: 7, retours: [] })).status, 200);
		assert.equal((await patch(id, { cookie: maud }, 8, { statut: "a-faire" })).status, 400);
		assert.equal((await patch(id, { cookie: camille }, 8, { titre: "modifié" })).status, 403, "ticket fait : l'auteur ne le modifie plus");
		assert.equal((await post(id, "prendre", { cookie: paul }, { version: 8 })).status, 400);
	});

	test("prise concurrente : deux prises simultanées, une seule gagne", async () => {
		const id = await creerTicket({ cookie: camille }, { titre: "Course" });
		const [a, b] = await Promise.all([post(id, "prendre", { bearer: agent }, { version: 1 }), post(id, "prendre", { cookie: paul }, { version: 1 })]);
		assert.deepEqual([a.status, b.status].sort(), [200, 409]);
		const t = await lire(id);
		assert.equal(t.version, 2);
		assert.equal(t.donnees.pris_par.type, a.status === 200 ? "agent" : "compte");
	});

	test("fermeture tout ou rien : un retour à version périmée → ni ticket ni retour écrits, aucun commit", async () => {
		const r1 = await creerRetour(), r2 = await creerRetour({ ref: "persil" });
		const id = await creerTicket({ cookie: camille }, { titre: "Tout ou rien", retours: [r1, r2] });
		assert.equal((await post(id, "prendre", { cookie: paul }, { version: 1 })).status, 200);
		// r2 change entre-temps (l'auteur précise son retour).
		const ajout = await appel(u, `/api/p/jardin/retours/${r2}`, { cookie: camille, methode: "PATCH", corps: { version: 1, champs: { text: "Trop d'eau. Et de soleil." } } });
		assert.equal(ajout.status, 200, ajout.texte);
		const n0 = nbCommits(depot), avantTicket = await lire(id), avantRetours = (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps;
		const f = await post(id, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r1, version: 1 }, { id: r2, version: 1 }], reponse: "Fait." });
		assert.equal(f.status, 409); assert.equal(f.corps.index, 1); assert.equal(f.corps.id, r2); assert.equal(f.corps.document.version, 2);
		assert.equal(nbCommits(depot), n0);
		assert.deepEqual(await lire(id), avantTicket);
		assert.deepEqual((await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps, avantRetours);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		// Retour non lié, inconnu, en double : refusés aussi, sans commit.
		const r3 = await creerRetour({ ref: "menthe" });
		const n1 = nbCommits(depot);
		assert.equal((await post(id, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r3, version: 1 }] })).status, 400);
		assert.equal((await post(id, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r1, version: 1 }, { id: r1, version: 1 }] })).status, 400);
		assert.equal((await post(id, "fermer", { cookie: maud }, { version: 1, retours: [] })).status, 409, "ticket à version périmée");
		assert.equal(nbCommits(depot), n1);
		// Réponse donnée : reprise telle quelle.
		const ok = await post(id, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r1, version: 1 }, { id: r2, version: 2 }], reponse: "Arrosage réduit (T-…)." });
		assert.equal(ok.status, 200, ok.texte);
		const docs = (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs;
		assert.equal(docs.find((x: any) => x.id === r2).donnees.reply, "Arrosage réduit (T-…).");
	});

	test("fermeture et échec de Git : rien d'écrit, arbre restauré, état en mémoire intact", async () => {
		const r1 = await creerRetour();
		const id = await creerTicket({ cookie: camille }, { titre: "Crochet", retours: [r1] });
		assert.equal((await post(id, "prendre", { cookie: paul }, { version: 1 })).status, 200);
		const crochet = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(crochet, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const n0 = nbCommits(depot);
		try {
			const f = await post(id, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r1, version: 1 }] });
			assert.equal(f.status, 503); assert.equal(f.corps.code, "unavailable");
			const c = await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "pendant l'échec" } });
			assert.equal(c.status, 503);
		} finally { fs.rmSync(crochet, { force: true }); }
		assert.equal(nbCommits(depot), n0);
		assert.equal(git(depot, "status", "--porcelain").trim(), "", "fichiers restaurés (retours/ et tickets/)");
		const t = await lire(id); assert.equal(t.donnees.statut, "pris"); assert.equal(t.version, 2);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((x: any) => x.id === r1).donnees.status, "nouveau");
		// Le numéro n'a pas été attribué : la création suivante le reprend.
		const dernier = s.ctx.depots.get("jardin")!.dernier;
		assert.equal(await creerTicket({ cookie: camille }, { titre: "après l'échec" }), `T-${dernier + 1}`);
	});

	test("retours liés revérifiés seulement quand le champ est écrit ; auteur modifie ses champs ; discipline du projet", async () => {
		const r1 = await creerRetour();
		const id = await creerTicket({ cookie: camille }, { titre: "Liens", retours: [r1] });
		assert.equal((await appel(u, `/api/p/jardin/retours/${r1}?version=1`, { cookie: camille, methode: "DELETE" })).status, 204);
		const p = await patch(id, { cookie: camille }, 1, { titre: "Liens (retour supprimé)", description: "## Note", pages: ["plante:tomate"] });
		assert.equal(p.status, 200, p.texte);
		assert.equal((await patch(id, { cookie: camille }, 2, { retours: [r1, "Absent1"] })).status, 400);
		assert.equal((await patch(id, { cookie: camille }, 2, { retours: [r1] })).status, 200, "un retour déjà lié, supprimé depuis, peut rester");
		assert.equal((await patch(id, { cookie: camille }, 3, { discipline: "ihm" })).status, 400, "discipline absente des réglages");
		assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { disciplines: [{ nom: "ihm", libelle: "IHM" }] } })).status, 200);
		assert.equal((await patch(id, { cookie: camille }, 3, { discipline: "ihm" })).status, 200);
		assert.equal((await patch(id, { cookie: paul }, 4, { titre: "pas à moi" })).status, 403);
		assert.equal((await patch(id, { cookie: lea }, 4, { titre: "lecteur" })).status, 403);
	});

	test("liste filtrée : statut, discipline, pris_par=moi", async () => {
		const a = await creerTicket({ cookie: camille }, { titre: "Filtre A", discipline: "ihm" });
		await creerTicket({ cookie: camille }, { titre: "Filtre B" });
		assert.equal((await post(a, "prendre", { cookie: paul }, { version: 1 })).status, 200);
		const ids = async (q: string, qui = paul) => (await appel(u, "/api/p/jardin/tickets" + q, { cookie: qui })).corps.docs.map((d: any) => d.id);
		assert.ok((await ids("?statut=pris")).includes(a));
		assert.ok(!(await ids("?statut=a-faire")).includes(a));
		assert.ok((await ids("?statut=a-faire,pris")).includes(a));
		assert.ok((await ids("?discipline=ihm")).includes(a));
		assert.ok((await ids("?pris_par=moi")).includes(a));
		assert.ok(!(await ids("?pris_par=moi", camille)).includes(a));
		assert.equal((await appel(u, "/api/p/jardin/tickets?statut=bidon", { cookie: paul })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/tickets?pris_par=paul", { cookie: paul })).status, 400);
		const l = (await appel(u, "/api/p/jardin/tickets", { bearer: agent })).corps;
		assert.match(l.rev, /^[0-9a-f]{40}$/); assert.ok(l.docs.every((d: any) => d.version >= 1 && d.donnees.id === d.id));
	});

	test("suppression : mainteneur seulement, version exigée, numéro jamais réutilisé, journal", async () => {
		const id = await creerTicket({ cookie: camille }, { titre: "À supprimer" });
		const n = Number(id.slice(2));
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}?version=1`, { cookie: camille, methode: "DELETE" })).status, 403);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}?version=1`, { bearer: agent, methode: "DELETE" })).status, 403);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}`, { cookie: maud, methode: "DELETE" })).status, 400);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}?version=2`, { cookie: maud, methode: "DELETE" })).status, 409);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}?version=1`, { cookie: maud, methode: "DELETE" })).status, 204);
		assert.equal((await lire(id)).code, "not_found");
		assert.ok(!fs.existsSync(path.join(depot, "tickets", id + ".md")));
		assert.equal(fs.readFileSync(path.join(depot, "tickets", ".dernier"), "utf8"), `${n}\n`);
		assert.equal(await creerTicket({ cookie: camille }, { titre: "Suivant" }), `T-${n + 1}`, "le numéro supprimé reste réservé");
		assert.ok(s.ctx.base.lireJournal().some(e => e.action === "ticket supprimé" && e.cible === id && e.qui === "maud"));
	});

	test("historique d'un ticket : commits Git du fichier (git log --follow), auteur, date, sujet", async () => {
		const id = await creerTicket({ bearer: agent }, { titre: "Historique" });
		assert.equal((await post(id, "prendre", { bearer: agent }, { version: 1 })).status, 200);
		const h = await appel(u, `/api/p/jardin/tickets/${id}/historique`, { cookie: lea });
		assert.equal(h.status, 200, h.texte);
		assert.equal(h.corps.historique.length, 2);
		assert.deepEqual(h.corps.historique.map((x: any) => x.sujet), [`ticket ${id} : pris (Historique)`, `ticket ${id} : création (Historique)`]);
		assert.equal(h.corps.historique[0].auteur, "Agent (pour Maud)");
		assert.match(h.corps.historique[0].hash, /^[0-9a-f]{40}$/); assert.ok(!Number.isNaN(Date.parse(h.corps.historique[0].date)));
		assert.equal((await appel(u, `/api/p/jardin/tickets/T-99999/historique`, { cookie: lea })).status, 404);
	});

	test("historique : cocher ou décocher un critère le dit dans le sujet du commit (pas « modification »)", async () => {
		const id = await creerTicket({ bearer: agent }, { titre: "Cases", criteres: ["un", "deux", "trois"] });
		assert.equal((await post(id, "prendre", { bearer: agent }, { version: 1 })).status, 200);
		const patch = (version: number, champs: unknown) => appel(u, `/api/p/jardin/tickets/${id}`, { methode: "PATCH", bearer: agent, corps: { version, champs } });
		const cases = (f: boolean[]) => ["un", "deux", "trois"].map((texte, i) => ({ texte, fait: f[i] }));
		assert.equal((await patch(2, { criteres: cases([false, true, false]) })).status, 200);
		assert.equal((await patch(3, { criteres: cases([true, false, true]) })).status, 200);
		assert.equal((await patch(4, { titre: "Cases (titre)" })).status, 200);
		const h = await appel(u, `/api/p/jardin/tickets/${id}/historique`, { cookie: lea });
		assert.deepEqual(h.corps.historique.slice(0, 3).map((x: any) => x.sujet), [
			`ticket ${id} : modification (Cases (titre))`,
			`ticket ${id} : critères 1, 3 cochés, critère 2 décoché (Cases)`,
			`ticket ${id} : critère 2 coché (Cases)`,
		]);
	});

	test("flux : événement « tickets » à la connexion et après chaque commit qui touche un ticket ; « instantane » inchangé", async () => {
		const e = await ecouter(s.port, "/api/p/jardin/flux", camille);
		try {
			await e.attendre(1); await e.attendreTickets(1);
			assert.deepEqual(e.tickets[0], (await appel(u, "/api/p/jardin/tickets", { cookie: camille })).corps, "même corps que GET /tickets");
			const id = await creerTicket({ cookie: camille }, { titre: "Flux" });
			await e.attendreTickets(2);
			assert.ok(e.tickets[1].docs.some((d: any) => d.id === id));
			assert.equal(e.evenements.length, 1, "une écriture de ticket seule ne rediffuse pas les retours");
			await creerRetour();
			await e.attendre(2);
			assert.equal(e.tickets.length, 2, "une écriture de retour seule ne rediffuse pas les tickets");
			// Fermer : les deux.
			const r = await creerRetour();
			await e.attendre(3);
			const id2 = await creerTicket({ cookie: camille }, { titre: "Flux 2", retours: [r] });
			await post(id2, "prendre", { cookie: paul }, { version: 1 });
			await e.attendreTickets(4);
			await post(id2, "fermer", { cookie: maud }, { version: 2, retours: [{ id: r, version: 1 }] });
			await e.attendre(4); await e.attendreTickets(5);
			assert.equal(e.evenements[3].docs.find((d: any) => d.id === r).donnees.status, "fait");
		} finally { e.fermer(); }
		// Agent (Bearer) : reçoit aussi les tickets.
		const ea = await ecouter(s.port, "/api/p/jardin/flux", { bearer: agent });
		try { await ea.attendreTickets(1); } finally { ea.fermer(); }
	});
});

describe("tickets : numérotation, relecture au démarrage, fichier illisible", () => {
	let s: Serveur, donnees: string, u: string, depot: string, maud: string;
	before(async () => {
		donnees = dossierTemp("numeros");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("100 créations concurrentes : T-1 à T-100, sans trou ni doublon, 100 commits", { timeout: 120000 }, async () => {
		const n0 = nbCommits(depot);
		const r = await Promise.all(Array.from({ length: 100 }, (_, i) => appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `Ticket ${i}` } })));
		assert.ok(r.every(x => x.status === 201), r.find(x => x.status !== 201)?.texte);
		const ids = r.map(x => x.corps.id).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
		assert.deepEqual(ids, Array.from({ length: 100 }, (_, i) => `T-${i + 1}`));
		assert.equal(nbCommits(depot), n0 + 100);
		assert.equal(fs.readFileSync(path.join(depot, "tickets", ".dernier"), "utf8"), "100\n");
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
	});

	test("numéro non réutilisé après suppression, même après redémarrage ; fichier illisible listé, écritures refusées, serveur démarré", async () => {
		const l = (await appel(u, "/api/p/jardin/tickets/T-100", { cookie: maud })).corps;
		assert.equal((await appel(u, `/api/p/jardin/tickets/T-100?version=${l.version}`, { cookie: maud, methode: "DELETE" })).status, 204);
		const t99 = (await appel(u, "/api/p/jardin/tickets/T-99", { cookie: maud })).corps;
		await s.arreter();
		// Correction « à la main » (serveur arrêté, par un commit) qui casse T-50 ; un reste non commité dans tickets/.
		fs.writeFileSync(path.join(depot, "tickets", "T-50.md"), "---\nid: \"T-50\"\npriorite: 1\n---\n");
		git(depot, "add", "--", "tickets/T-50.md");
		git(depot, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "à la main", "--", "tickets/T-50.md");
		fs.writeFileSync(path.join(depot, "tickets", "T-200.md"), "reste d'une écriture interrompue");
		fs.writeFileSync(path.join(depot, "tickets", "T-99.md"), "modifié sans commit");
		s = await serveurTest(donnees); u = s.url;
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		assert.ok(!fs.existsSync(path.join(depot, "tickets", "T-200.md")), "fichier non commité effacé au démarrage");
		assert.deepEqual((await appel(u, "/api/p/jardin/tickets/T-99", { cookie: maud })).corps, t99, "fichier modifié remis au dernier commit");
		const liste = (await appel(u, "/api/p/jardin/tickets", { cookie: maud })).corps.docs;
		assert.equal(liste.length, 99);
		const ill = liste.find((d: any) => d.id === "T-50");
		assert.equal(ill.illisible, true); assert.match(ill.erreur, /clé inconnue : priorite/);
		assert.equal((await appel(u, "/api/p/jardin/tickets?statut=a-faire", { cookie: maud })).corps.docs.some((d: any) => d.id === "T-50"), false, "pas listé quand un filtre est posé");
		const g = await appel(u, "/api/p/jardin/tickets/T-50", { cookie: maud });
		assert.deepEqual(g.corps, { id: "T-50", illisible: true, erreur: ill.erreur });
		for (const [methode, chemin, corps] of [["PATCH", "/api/p/jardin/tickets/T-50", { version: 1, champs: { titre: "x" } }], ["POST", "/api/p/jardin/tickets/T-50/prendre", { version: 1 }],
			["DELETE", "/api/p/jardin/tickets/T-50?version=1", undefined]] as const) {
			const r = await appel(u, chemin, { cookie: maud, methode, corps });
			assert.equal(r.status, 422, `${methode} ${chemin} : ${r.texte}`); assert.equal(r.corps.illisible, true);
		}
		const nouveau = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Après redémarrage" } });
		assert.equal(nouveau.corps.id, "T-101", "T-100 supprimé reste réservé (tickets/.dernier)");
	});

	test("dépôt créé avant l'étape 3 (sans tickets/) : créé à la première écriture, sans commit à part", async () => {
		await projet(u, "ancien");
		const d = depotDe(donnees, "ancien");
		assert.ok(!fs.existsSync(path.join(d, "tickets")));
		const n0 = nbCommits(d);
		const m2 = await session(u, "ancien", "maud", "mainteneur", "Maud");
		assert.equal((await appel(u, "/api/p/ancien/tickets", { cookie: m2, corps: { titre: "Premier" } })).corps.id, "T-1");
		assert.equal(nbCommits(d), n0 + 1);
		assert.deepEqual(git(d, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["tickets/.dernier", "tickets/T-1.md"]);
	});
});

describe("dépôt (§ 2.1) : tickets/, tickets/.dernier et site.json sous verrou, restauration, commit limité", () => {
	let s: Serveur, donnees: string, u: string, depot: string, maud: string;
	before(async () => {
		donnees = dossierTemp("depot-tickets");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("verrou entre add et commit d'un ticket, tenu pendant la restauration : dépôt « sale », puis restauré ; l'écriture suivante ne commite que ses chemins", async () => {
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Premier" } })).corps.id, "T-1");
		const d = s.ctx.depots.get("jardin")!;
		const verrou = path.join(depot, ".git", "index.lock");
		const original = d.git.bind(d);
		let piege = true;
		d.relances = 1; d.pauseRelanceMs = 20;
		d.git = async (args, auteur) => {
			const r = await original(args, auteur);
			if (piege && args[0] === "add") { piege = false; fs.writeFileSync(verrou, ""); }
			return r;
		};
		try {
			const r = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Refusé" } });
			assert.equal(r.status, 503);
			assert.equal(d.sale, true);
			assert.match(git(depot, "diff", "--cached", "--name-only"), /tickets\/T-2\.md/, "le reste indexé existe");
			assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { url_commit: "https://x/{hash}" } })).status, 503);
		} finally { fs.rmSync(verrou, { force: true }); d.git = original; d.relances = 5; d.pauseRelanceMs = 150; }
		const ok = await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { url_commit: "https://x/{hash}" } });
		assert.equal(ok.status, 200, ok.texte);
		assert.equal(d.sale, false);
		assert.equal(git(depot, "show", "--name-only", "--format=", "HEAD").trim(), "site.json", "le ticket refusé n'entre pas dans ce commit");
		assert.ok(!fs.existsSync(path.join(depot, "tickets", "T-2.md")));
		assert.equal(fs.readFileSync(path.join(depot, "tickets", ".dernier"), "utf8"), "1\n");
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Deuxième" } })).corps.id, "T-2", "numéro jamais attribué : repris");
	});

	test("échec de Git sur les réglages : site.json remis au dernier commit, réglages en mémoire intacts", async () => {
		const avant = fs.readFileSync(path.join(depot, "site.json"), "utf8");
		const crochet = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(crochet, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		try {
			assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { disciplines: [{ nom: "ihm", libelle: "IHM" }] } })).status, 503);
		} finally { fs.rmSync(crochet, { force: true }); }
		assert.equal(fs.readFileSync(path.join(depot, "site.json"), "utf8"), avant);
		assert.deepEqual((await appel(u, "/api/p/jardin/reglages", { cookie: maud })).corps.disciplines, []);
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
	});
});

describe("dépôt (§ 2.1) : commit limité, relecture au démarrage, numérotation sans .dernier, échec après commit", () => {
	let s: Serveur, donnees: string, u: string, depot: string, maud: string;
	const commitMain = (...args: string[]) => git(depot, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "à la main", ...args);
	const redemarrer = async () => {
		s = await serveurTest(donnees); u = s.url;
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	};
	before(async () => {
		donnees = dossierTemp("depot-relu");
		s = await serveurTest(donnees); u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("commit limité à ses chemins : un fichier indexé de l'extérieur n'entre ni dans une création ni dans une fermeture", async () => {
		fs.writeFileSync(path.join(depot, "notes", "externe.json"), "{}\n");
		git(depot, "add", "--", "notes/externe.json");
		try {
			const c = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Limité" } });
			assert.equal(c.status, 201, c.texte);
			assert.deepEqual(git(depot, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), ["tickets/.dernier", `tickets/${c.corps.id}.md`]);
			const r = (await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour() })).corps.id;
			const t = (await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "À fermer", retours: [r] } })).corps.id;
			assert.equal((await appel(u, `/api/p/jardin/tickets/${t}/prendre`, { cookie: maud, corps: { version: 1 } })).status, 200);
			const f = await appel(u, `/api/p/jardin/tickets/${t}/fermer`, { cookie: maud, corps: { version: 2, retours: [{ id: r, version: 1 }] } });
			assert.equal(f.status, 200, f.texte);
			assert.deepEqual(git(depot, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [`retours/${r}.json`, `tickets/${t}.md`]);
			assert.match(git(depot, "diff", "--cached", "--name-only"), /notes\/externe\.json/, "toujours indexé, jamais commité");
		} finally {
			git(depot, "reset", "-q", "--", "notes/externe.json");
			fs.rmSync(path.join(depot, "notes", "externe.json"), { force: true });
		}
	});

	test("Git échoue après un commit réussi (rev-parse) : 200, mémoire à jour, événement « tickets » diffusé", async () => {
		const r = (await appel(u, "/api/p/jardin/retours", { cookie: maud, corps: docRetour() })).corps.id;
		const t = (await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Fermé malgré tout", retours: [r] } })).corps.id;
		assert.equal((await appel(u, `/api/p/jardin/tickets/${t}/prendre`, { cookie: maud, corps: { version: 1 } })).status, 200);
		const e = await ecouter(s.port, "/api/p/jardin/flux", maud);
		await e.attendreTickets(1);
		const d = s.ctx.depots.get("jardin")!;
		const original = d.gitUneFois.bind(d);
		let apresCommit = false, fait = false;
		d.gitUneFois = (args, auteur) => {
			if (args[0] === "commit") apresCommit = true;
			if (args[0] === "rev-parse" && apresCommit && !fait) { fait = true; return Promise.reject(new Error("rev-parse simulé")); }
			return original(args, auteur);
		};
		const n0 = nbCommits(depot);
		let f;
		try { f = await appel(u, `/api/p/jardin/tickets/${t}/fermer`, { cookie: maud, corps: { version: 2, retours: [{ id: r, version: 1 }] } }); }
		finally { d.gitUneFois = original; }
		assert.ok(fait, "l'échec simulé a eu lieu");
		assert.equal(f.status, 200, f.texte);
		assert.equal(nbCommits(depot), n0 + 1);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${t}`, { cookie: maud })).corps.donnees.statut, "fait");
		await e.attendreTickets(2);
		assert.equal(e.tickets.at(-1).docs.find((x: any) => x.id === t).donnees.statut, "fait");
		e.fermer();
		// Mais un commit qui échoue reste un échec, même si le rev en mémoire était en retard sur HEAD (notes, commit extérieur).
		d.rev = "0".repeat(40);
		const crochet = path.join(depot, ".git", "hooks", "pre-commit");
		fs.writeFileSync(crochet, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const n1 = nbCommits(depot), avant = d.tickets.size;
		try {
			const r2 = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: "Jamais écrit" } });
			assert.equal(r2.status, 503, r2.texte);
		} finally { fs.rmSync(crochet, { force: true }); }
		assert.equal(nbCommits(depot), n1); assert.equal(d.tickets.size, avant);
		assert.equal(d.rev, git(depot, "rev-parse", "HEAD").trim(), "rev relu depuis HEAD");
	});

	test("U+2028 dans un titre : fichier échappé, ticket lisible et modifiable après redémarrage", async () => {
		const ls = String.fromCharCode(0x2028);
		const c = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `a${ls}b`, criteres: [`c${String.fromCharCode(0x2029)}d`] } });
		assert.equal(c.status, 201, c.texte);
		const fichier = fs.readFileSync(path.join(depot, "tickets", `${c.corps.id}.md`), "utf8");
		assert.ok(!fichier.includes(ls) && fichier.includes("a\\u2028b"));
		await s.arreter(); await redemarrer();
		const g = (await appel(u, `/api/p/jardin/tickets/${c.corps.id}`, { cookie: maud })).corps;
		assert.equal(g.illisible, undefined, JSON.stringify(g)); assert.equal(g.donnees.titre, `a${ls}b`);
		assert.equal((await appel(u, `/api/p/jardin/tickets/${c.corps.id}`, { cookie: maud, methode: "PATCH", corps: { version: 1, champs: { titre: "c" } } })).status, 200);
	});

	test("démarrage avec tickets/ sale : seuls retours/, tickets/ et site.json sont remis ; une note suivie modifiée à la main reste", async () => {
		fs.writeFileSync(path.join(depot, "notes", "a-moi.md"), "v1\n");
		git(depot, "add", "--", "notes/a-moi.md"); commitMain("--", "notes/a-moi.md");
		await s.arreter();
		fs.writeFileSync(path.join(depot, "notes", "a-moi.md"), "v2 en cours\n");
		fs.writeFileSync(path.join(depot, "tickets", "T-900.md"), "reste");
		fs.writeFileSync(path.join(depot, "site.json"), "{ abîmé");
		await redemarrer();
		assert.ok(!fs.existsSync(path.join(depot, "tickets", "T-900.md")));
		assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(depot, "site.json"), "utf8")), "site.json remis");
		assert.equal(fs.readFileSync(path.join(depot, "notes", "a-moi.md"), "utf8"), "v2 en cours\n", "la note n'est pas effacée");
		fs.writeFileSync(path.join(depot, "notes", "a-moi.md"), "v1\n");
		assert.equal(git(depot, "status", "--porcelain").trim(), "");
	});

	test(".dernier absent, illisible ou hors limites : numérotation reprise de l'historique, numéro supprimé jamais réutilisé", async () => {
		for (const [cas, f] of [["absent", () => git(depot, "rm", "-q", "--", "tickets/.dernier")], ["abc", () => "abc\n"], ["1e20", () => "1e20\n"], ["vide", () => ""]] as [string, () => string | void][]) {
			const c = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `Plus haut (${cas})` } });
			const n = Number(c.corps.id.slice(2));
			assert.equal((await appel(u, `/api/p/jardin/tickets/${c.corps.id}?version=1`, { cookie: maud, methode: "DELETE" })).status, 204);
			await s.arreter();
			const contenu = f();
			if (typeof contenu === "string") { fs.writeFileSync(path.join(depot, "tickets", ".dernier"), contenu); git(depot, "add", "--", "tickets/.dernier"); }
			commitMain("--", "tickets/.dernier");
			await redemarrer();
			const suivant = await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `Suivant (${cas})` } });
			assert.equal(suivant.status, 201, `${cas} : ${suivant.texte}`);
			assert.equal(suivant.corps.id, `T-${n + 1}`, `${cas} : T-${n} supprimé n'est pas réutilisé`);
		}
	});
});
