// Tests des commandes « outil tickets » (docs/etape3-meta-interface.md § 5.1) : un vrai serveur de test, la CLI en
// sous-processus (APPDATA, HOME dans le dossier temporaire, jeton par OUTIL_JETON), un vrai dépôt Git « du code »
// pour « tickets commit ». Pas de commande fermer ; 409 → 3 ; 403 → 4 ; hash absent du dépôt local refusé.
// Lancement : WDD_TESTS_TMP=<dossier hors dépôt> node --test "cli/test/*.test.ts"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour, git, depotDe, nbCommits } from "../../serveur/test/aide.ts";
import type { Serveur } from "../../serveur/src/principal.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const OUTIL = path.join(RACINE, "cli", "outil.ts");
const COMMANDES_TICKETS = ["tickets liste", "tickets voir", "tickets creer", "tickets prendre", "tickets rendre", "tickets revue", "tickets commit", "tickets critere"];

type Resultat = { code: number; stdout: string; stderr: string; json: any };

describe("CLI outil : tickets", () => {
	let s: Serveur, tmp: string, donnees: string, u: string, depot: string, maison: string, code: string;
	let alex: string, camille: string, agent: string;
	let env: Record<string, string>;

	before(async () => {
		tmp = dossierTemp("cli-tickets");
		donnees = path.join(tmp, "donnees");
		maison = path.join(tmp, "maison");
		code = path.join(tmp, "code");
		for (const d of [maison, code]) fs.mkdirSync(d, { recursive: true });
		env = {
			PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", TEMP: tmp, TMP: tmp,
			APPDATA: path.join(maison, "AppData", "Roaming"), HOME: maison, USERPROFILE: maison, XDG_CONFIG_HOME: path.join(maison, ".config"),
			GIT_CONFIG_NOSYSTEM: "1",
		};
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		depot = depotDe(donnees, "jardin");
		alex = await session(u, "jardin", "alex", "admin", "Alex");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		// Jeton de l'API admin : propriétaire = l'admin qui le crée (écart serveur 4).
		agent = (await appel(u, "/api/admin/jetons", { cookie: alex, corps: { projet: "jardin", nom: "Agent" } })).corps.jeton;
		assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: alex, methode: "PUT", corps: { disciplines: [{ nom: "programmation", libelle: "Programmation" }] } })).status, 200);
		fs.writeFileSync(path.join(code, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }));
		// Dépôt Git « du code », avec un commit qui cite le ticket.
		git(code, "init", "-q", "-b", "main");
		git(code, "config", "user.name", "Sam"); git(code, "config", "user.email", "sam@exemple.invalid");
		git(code, "config", "commit.gpgsign", "false");
	});
	after(async () => { await s.arreter(); nettoyer(tmp); });

	function outil(args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): Promise<Resultat> {
		return new Promise((ok, ko) => {
			const p = spawn(process.execPath, [OUTIL, ...args], { cwd: o.cwd || code, env: { ...env, OUTIL_JETON: agent, ...(o.env || {}) }, windowsHide: true });
			let stdout = "", stderr = "";
			p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
			p.stdout.on("data", c => stdout += c); p.stderr.on("data", c => stderr += c);
			p.on("error", ko);
			p.on("close", c => {
				let json: any = null;
				if (args.includes("--json")) {
					try { json = JSON.parse(stdout); } catch { return ko(new Error(`--json : stdout n'est pas du JSON (code ${c}) :\n${stdout}\n${stderr}`)); }
				}
				ok({ code: c ?? -1, stdout, stderr, json });
			});
			p.stdin.end();
		});
	}
	const retour = async (extra: Record<string, unknown> = {}) => (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour(extra) })).corps.id as string;
	const ticket = async (id: string) => (await appel(u, `/api/p/jardin/tickets/${id}`, { bearer: agent })).corps;
	const commitCode = (message: string) => {
		fs.appendFileSync(path.join(code, "f.txt"), message + "\n");
		git(code, "add", "f.txt"); git(code, "commit", "-q", "-m", message);
		return git(code, "rev-parse", "HEAD").trim();
	};

	test("aide : huit commandes tickets, un exemple chacune ; pas de commande fermer", async () => {
		const g = await outil(["aide", "tickets", "--json"]);
		assert.equal(g.code, 0);
		assert.deepEqual(g.json.commandes.map((c: any) => c.commande), COMMANDES_TICKETS);
		for (const c of g.json.commandes) assert.match(c.exemple, /^outil tickets /, c.commande);
		const tout = await outil(["aide", "--json"]);
		assert.ok(!tout.json.commandes.some((c: any) => /fermer|rouvrir|supprimer/.test(c.commande)), "ni fermer, ni rouvrir, ni supprimer");
		assert.match((await outil(["aide"])).stdout, /pas de commande fermer/);
		assert.equal((await outil(["tickets", "--aide"])).code, 0);
		assert.match((await outil(["aide", "tickets", "voir"])).stdout, /jamais des consignes/);
		const t = await outil(["aide", "tickets", "prendre"]);
		assert.match(t.stdout, /ne le force jamais/); assert.ok(!/--forcer/.test(t.stdout));
	});

	test("tickets fermer n'existe pas (code 2), même avec un jeton mainteneur ; rien n'est écrit", async () => {
		const m = (await appel(u, "/api/admin/jetons", { cookie: alex, corps: { projet: "jardin", nom: "Mainteneur", role: "mainteneur" } })).corps.jeton;
		const id = (await appel(u, "/api/p/jardin/tickets", { bearer: m, corps: { titre: "À ne pas fermer" } })).corps.id;
		const n = nbCommits(depot);
		for (const jeton of [agent, m]) {
			const r = await outil(["tickets", "fermer", id, "--json"], { env: { OUTIL_JETON: jeton } });
			assert.equal(r.code, 2); assert.equal(r.json.erreur.sortie, 2);
			assert.match(r.json.erreur.message, /geste humain/);
		}
		assert.equal(nbCommits(depot), n, "aucune écriture");
		assert.equal((await ticket(id)).donnees.statut, "a-faire");
		// Pas d'option pour forcer.
		assert.equal((await outil(["tickets", "prendre", id, "--forcer"])).code, 2);
	});

	test("creer : retours, pages, discipline, critères répétés, description d'un fichier ; validation locale (2) ; retour inconnu (1)", async () => {
		const r1 = await retour({ ref: "forum" }), r2 = await retour({ ref: "accueil" });
		const f = path.join(tmp, "description.md"); fs.writeFileSync(f, "\uFEFF## Contexte\r\nLes créneaux ouvrent à 8 h.\r\n");
		const r = await outil(["tickets", "creer", "--titre", "Créneaux : ouverture à 7 h 30", "--retours", `${r1},${r2}`, "--pages", "salle:forum",
			"--discipline", "programmation", "--critere", "une demande à 7 h 45 est acceptée", "--critere", "une demande à 7 h 15 est refusée", "--texte-fichier", f, "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.json.id, /^T-\d+$/); assert.equal(r.json.version, 1); assert.match(r.json.rev, /^[0-9a-f]{40}$/);
		const t = (await ticket(r.json.id)).donnees;
		assert.deepEqual(t.retours, [r1, r2]); assert.deepEqual(t.pages, ["salle:forum"]); assert.equal(t.discipline, "programmation");
		assert.deepEqual(t.criteres, [{ texte: "une demande à 7 h 45 est acceptée", fait: false }, { texte: "une demande à 7 h 15 est refusée", fait: false }]);
		assert.equal(t.description, "## Contexte\nLes créneaux ouvrent à 8 h.");
		assert.equal(t.statut, "a-faire"); assert.equal(t.auteur.type, "agent"); assert.deepEqual(t.auteur.pour, { id: "alex", nom: "Alex" });
		assert.equal(git(depot, "log", "-1", "--format=%an").trim(), "Agent (pour Alex)");
		// Sans retour ni page : créé, avec un avertissement.
		const seul = await outil(["tickets", "creer", "--titre", "Seul", "--texte", "Court."]);
		assert.equal(seul.code, 0, seul.stderr); assert.match(seul.stderr, /sans retour ni page/); assert.match(seul.stdout, /outil tickets prendre T-\d+/);
		const n = nbCommits(depot);
		for (const args of [["--texte", "x"], ["--titre", ""], ["--titre", "a\nb"], ["--titre", "x", "--retours", "a,a"], ["--titre", "x", "--retours", "../x"],
			["--titre", "x", "--pages", "sans-deux-points"], ["--titre", "x", "--discipline", "Prog"], ["--titre", "x", "--texte", "a", "--texte-fichier", f], ["--titre", "x", "--critere", ""]]) {
			const k = await outil(["tickets", "creer", ...args, "--json"]);
			assert.equal(k.code, 2, args.join(" ") + " : " + k.stderr);
		}
		const inconnu = await outil(["tickets", "creer", "--titre", "x", "--retours", "Inconnu123", "--json"]);
		assert.equal(inconnu.code, 1); assert.equal(inconnu.json.erreur.statut, 400);
		const disc = await outil(["tickets", "creer", "--titre", "x", "--discipline", "ihm", "--json"]);
		assert.equal(disc.code, 1); assert.match(disc.json.erreur.message, /discipline inconnue/);
		assert.equal(nbCommits(depot), n, "rien d'écrit");
	});

	test("liste et voir : filtres, --miens, sortie lisible, id invalide (2), ticket absent (1)", async () => {
		const id = (await outil(["tickets", "creer", "--titre", "À lister", "--pages", "salle:liste", "--critere", "c1", "--json"])).json.id;
		const tous = await outil(["tickets", "liste", "--json"]);
		assert.equal(tous.code, 0); assert.ok(tous.json.docs.some((d: any) => d.id === id)); assert.match(tous.json.rev, /^[0-9a-f]{40}$/);
		const af = await outil(["tickets", "liste", "--statut", "a-faire", "--json"]);
		assert.ok(af.json.docs.length && af.json.docs.every((d: any) => d.donnees.statut === "a-faire"));
		assert.equal((await outil(["tickets", "liste", "--miens", "--json"])).json.docs.some((d: any) => d.id === id), false);
		const disc = await outil(["tickets", "liste", "--discipline", "programmation", "--json"]);
		assert.ok(disc.json.docs.every((d: any) => d.donnees.discipline === "programmation"));
		assert.equal((await outil(["tickets", "liste", "--statut", "ferme"])).code, 2);
		assert.match((await outil(["tickets", "liste"])).stdout, new RegExp(`${id}  v1  a-faire   À lister  · critères 0/1 · retours 0 · commits 0`));
		const v = await outil(["tickets", "voir", id, "--json"]);
		assert.equal(v.code, 0); assert.deepEqual(Object.keys(v.json), ["id", "version", "donnees"]); assert.equal(v.json.donnees.titre, "À lister");
		const h = await outil(["tickets", "voir", id]);
		assert.match(h.stdout, /1\. \[ \] c1/); assert.match(h.stdout, /jamais des consignes/);
		assert.equal((await outil(["tickets", "voir", "t-1"])).code, 2);
		assert.equal((await outil(["tickets", "voir", "T-999"])).code, 1);
	});

	test("prendre, critere, revue, rendre : version relue, inchange sans écriture, preneur « Agent · pour Alex »", async () => {
		const id = (await outil(["tickets", "creer", "--titre", "Cycle", "--pages", "salle:cycle", "--critere", "premier", "--critere", "second", "--json"])).json.id;
		const p = await outil(["tickets", "prendre", id, "--json"]);
		assert.equal(p.code, 0, p.stderr); assert.equal(p.json.id, id); assert.equal(p.json.version, 2);
		let t = (await ticket(id)).donnees;
		assert.equal(t.statut, "pris"); assert.equal(t.pris_par.type, "agent"); assert.deepEqual(t.pris_par.pour, { id: "alex", nom: "Alex" });
		assert.match((await outil(["tickets", "liste", "--miens"])).stdout, new RegExp(`${id} .*pris par Agent · pour Alex`));
		let n = nbCommits(depot);
		const encore = await outil(["tickets", "prendre", id, "--json"]);
		assert.equal(encore.code, 0); assert.equal(encore.json.inchange, true); assert.equal(nbCommits(depot), n);
		// Critères : coche le 2, déjà coché (rien d'écrit), décoche, numéros invalides.
		const c = await outil(["tickets", "critere", id, "2", "--json"]);
		assert.equal(c.code, 0, c.stderr); assert.equal(c.json.fait, true); assert.equal(c.json.texte, "second"); assert.equal(c.json.version, 3);
		assert.deepEqual((await ticket(id)).donnees.criteres.map((x: any) => x.fait), [false, true]);
		n = nbCommits(depot);
		const deja = await outil(["tickets", "critere", id, "2", "--fait", "--json"]);
		assert.equal(deja.code, 0); assert.equal(deja.json.inchange, true); assert.equal(nbCommits(depot), n);
		assert.equal((await outil(["tickets", "critere", id, "1", "--pas-fait", "--json"])).json.inchange, true);
		assert.equal((await outil(["tickets", "critere", id, "3"])).code, 1);
		for (const args of [["0"], ["un"], ["1", "--fait", "--pas-fait"]]) assert.equal((await outil(["tickets", "critere", id, ...args])).code, 2, args.join(" "));
		// Revue : critère 1 non coché signalé.
		const r = await outil(["tickets", "revue", id, "--json"]);
		assert.equal(r.code, 0, r.stderr); assert.equal(r.json.statut, "en-revue"); assert.match(r.stderr, /non coché\(s\) : 1/);
		assert.equal((await ticket(id)).donnees.statut, "en-revue");
		assert.equal((await outil(["tickets", "revue", id, "--json"])).json.inchange, true);
		// Rendre : à faire, sans preneur.
		const rd = await outil(["tickets", "rendre", id, "--json"]);
		assert.equal(rd.code, 0, rd.stderr);
		t = (await ticket(id)).donnees;
		assert.equal(t.statut, "a-faire"); assert.equal(t.pris_par, null);
		assert.equal((await outil(["tickets", "rendre", id, "--json"])).json.inchange, true);
		// Revue d'un ticket à faire : refusée par le serveur (400 → 1).
		assert.equal((await outil(["tickets", "revue", id])).code, 1);
		// Commits sur un ticket à faire : 403 → 4, avec « le prendre d'abord » (pas « il n'est pas à toi »).
		const sha = commitCode(`${id} : avant de prendre`);
		const k = await outil(["tickets", "commit", id, sha, "--json"]);
		assert.equal(k.code, 4); assert.match(k.json.erreur.message, /le prendre d'abord, outil tickets prendre T-\d+/);
		assert.ok(!/pas à toi/.test(k.json.erreur.message));
	});

	test("ticket tenu par un autre : prendre → 409 → 3 avec le ticket à jour, rien d'écrit ; écrire dessus → 403 → 4", async () => {
		const id = (await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "Celui de Camille", criteres: ["c"] } })).corps.id;
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}/prendre`, { cookie: camille, corps: { version: 1 } })).status, 200);
		const n = nbCommits(depot);
		const r = await outil(["tickets", "prendre", id, "--json"]);
		assert.equal(r.code, 3, r.stderr);
		assert.equal(r.json.erreur.statut, 409); assert.equal(r.json.erreur.code, "conflict");
		assert.equal(r.json.erreur.document.id, id); assert.equal(r.json.erreur.document.version, 2);
		assert.equal(r.json.erreur.document.donnees.pris_par.nom, "Camille");
		assert.match(r.json.erreur.message, /tenu par Camille/); assert.match(r.json.erreur.message, /Ne force jamais/);
		assert.equal(nbCommits(depot), n, "rien d'écrit");
		const h = await outil(["tickets", "prendre", id]);
		assert.equal(h.code, 3); assert.match(h.stderr, /il n'est pas à toi/);
		for (const args of [["critere", id, "1"], ["revue", id], ["rendre", id]]) {
			const k = await outil(["tickets", ...args, "--json"]);
			assert.equal(k.code, 4, args.join(" ") + " : " + k.stderr); assert.equal(k.json.erreur.statut, 403);
		}
		const sha = commitCode(`${id} : pas à moi`);
		const c = await outil(["tickets", "commit", id, sha, "--json"]);
		assert.equal(c.code, 4); assert.equal(c.json.erreur.statut, 403);
		assert.equal(nbCommits(depot), n);
		assert.equal((await ticket(id)).donnees.pris_par.nom, "Camille");
	});

	test("commit : révisions résolues dans le dépôt du dossier courant (hash complet, sujet) ; hash absent, hors dépôt, rev invalide refusés", async () => {
		const id = (await outil(["tickets", "creer", "--titre", "Commits", "--pages", "salle:commits", "--json"])).json.id;
		assert.equal((await outil(["tickets", "prendre", id])).code, 0);
		const premier = commitCode(`${id} : ouverture 07:30`);
		const second = commitCode(`${id} : test du créneau`);
		const r = await outil(["tickets", "commit", id, "HEAD~1", "HEAD", "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.ajoutes, 2); assert.equal(r.json.inchange, false); assert.equal(r.json.reessai, false);
		assert.deepEqual(r.json.commits.map((c: any) => c.hash), [premier, second]);
		assert.ok(!/attention/.test(r.stderr));
		const t = (await ticket(id)).donnees;
		assert.deepEqual(t.commits, [{ hash: premier, depot: "code", message: `${id} : ouverture 07:30` }, { hash: second, depot: "code", message: `${id} : test du créneau` }]);
		// Déjà attachés (même par un préfixe) : rien d'écrit.
		const n = nbCommits(depot);
		const encore = await outil(["tickets", "commit", id, premier.slice(0, 10), "--json"]);
		assert.equal(encore.code, 0); assert.equal(encore.json.inchange, true); assert.equal(encore.json.ajoutes, 0); assert.equal(nbCommits(depot), n);
		// Hash absent du dépôt local : refusé avant tout envoi (complet ou court), sortie 1.
		for (const absent of ["0123456789abcdef0123456789abcdef01234567", "deadbee"]) {
			const k = await outil(["tickets", "commit", id, absent, "--json"]);
			assert.equal(k.code, 1, absent); assert.match(k.json.erreur.message, /commit introuvable dans le dépôt Git/); assert.equal(k.json.erreur.rev, absent);
		}
		// Un commit présent et un absent : rien n'est envoyé.
		assert.equal((await outil(["tickets", "commit", id, "HEAD", "0123456789abcdef0123456789abcdef01234567"])).code, 1);
		assert.equal(nbCommits(depot), n, "rien d'écrit");
		// Hors d'un dépôt Git : refusé.
		const horsDepot = path.join(tmp, "hors-depot"); fs.mkdirSync(horsDepot);
		fs.writeFileSync(path.join(horsDepot, ".outil.json"), JSON.stringify({ serveur: u, projet: "jardin" }));
		const hd = await outil(["tickets", "commit", id, "HEAD", "--json"], { cwd: horsDepot, env: { GIT_CEILING_DIRECTORIES: tmp } });
		assert.equal(hd.code, 1); assert.match(hd.json.erreur.message, /pas dans une copie de travail Git/);
		// Révision qui ressemble à une option, --depot invalide, sans révision : usage.
		for (const args of [["--", "-x"], ["HEAD", "--depot", "Code!"], []]) assert.equal((await outil(["tickets", "commit", id, ...args])).code, 2, args.join(" "));
		// Message sans l'id du ticket : attaché, avec un avertissement ; --depot.
		const autre = commitCode("correction sans id");
		const w = await outil(["tickets", "commit", id, autre, "--depot", "appli", "--json"]);
		assert.equal(w.code, 0, w.stderr); assert.match(w.stderr, /ne commence pas par « T-\d+ »/);
		assert.deepEqual((await ticket(id)).donnees.commits.at(-1), { hash: autre, depot: "appli", message: "correction sans id" });
	});

	// Serveur factice : GET du ticket, puis des réponses de POST …/commits choisies par le test.
	async function faux(ticketLu: any, reponses: { status: number; corps: unknown }[]) {
		const recus: any[] = [];
		const srv = http.createServer((q, r) => {
			let b = ""; q.setEncoding("utf8"); q.on("data", c => b += c);
			q.on("end", () => {
				const envoyer = (st: number, o: unknown) => { r.writeHead(st, { "Content-Type": "application/json" }); r.end(JSON.stringify(o)); };
				if (q.method === "GET") return envoyer(200, ticketLu);
				recus.push(JSON.parse(b));
				const x = reponses.shift() || { status: 500, corps: { code: "internal", message: "inattendu" } };
				envoyer(x.status, x.corps);
			});
		});
		await new Promise<void>(ok => srv.listen(0, "127.0.0.1", ok));
		const dossier = fs.mkdtempSync(path.join(code, "faux-"));
		fs.writeFileSync(path.join(dossier, ".outil.json"), JSON.stringify({ serveur: `http://127.0.0.1:${(srv.address() as any).port}`, projet: "jardin" }));
		return { recus, dossier, fermer: () => new Promise(ok => srv.close(ok)) };
	}

	test("commit : un seul nouvel essai si seuls les commits ont changé ; sinon 409 → 3 sans nouvel essai", async () => {
		const sha = commitCode("T-7 : essai");
		const base = { id: "T-7", titre: "Essai", statut: "pris", discipline: "", pris_par: { type: "agent", id: "j1", nom: "Agent" }, retours: [], pages: [], criteres: [],
			commits: [], auteur: { type: "agent", id: "j1", nom: "Agent" }, cree: "2026-11-23T10:00:00.000Z", modifie: "2026-11-23T10:00:00.000Z", description: "" };
		const lu = { id: "T-7", version: 4, donnees: base };
		const autreCommit = { ...base, commits: [{ hash: "a".repeat(40), depot: "code", message: "T-7 : autre" }], modifie: "2026-11-23T10:05:00.000Z" };
		const conflit = (donnees: unknown) => ({ status: 409, corps: { code: "conflict", message: "version périmée", document: { id: "T-7", version: 5, donnees } } });
		// Seuls les commits ont changé : nouvel essai avec la version 5.
		let f = await faux(lu, [conflit(autreCommit), { status: 200, corps: { version: 6, rev: "b".repeat(40), ajoutes: 1 } }]);
		try {
			const r = await outil(["tickets", "commit", "T-7", "HEAD", "--json"], { cwd: f.dossier });
			assert.equal(r.code, 0, r.stderr); assert.equal(r.json.reessai, true); assert.equal(r.json.version, 6);
			assert.deepEqual(f.recus.map(x => x.version), [4, 5]);
			assert.deepEqual(f.recus[0].commits, [{ hash: sha, depot: "code", message: "T-7 : essai" }]);
			assert.match(r.stderr, /nouvel essai/);
		} finally { await f.fermer(); }
		// Deux conflits de suite : un seul nouvel essai, puis 3.
		f = await faux(lu, [conflit(autreCommit), conflit(autreCommit)]);
		try {
			const r = await outil(["tickets", "commit", "T-7", "HEAD", "--json"], { cwd: f.dossier });
			assert.equal(r.code, 3); assert.equal(f.recus.length, 2);
		} finally { await f.fermer(); }
		// Le statut a changé (rendu, pris par un autre) : pas de nouvel essai, 3.
		f = await faux(lu, [conflit({ ...autreCommit, statut: "a-faire", pris_par: null })]);
		try {
			const r = await outil(["tickets", "commit", "T-7", "HEAD", "--json"], { cwd: f.dossier });
			assert.equal(r.code, 3); assert.equal(f.recus.length, 1);
			assert.match(r.json.erreur.message, /a changé entre la lecture et l'écriture/);
		} finally { await f.fermer(); }
	});

	test("commit : sujet de plus de 200 caractères coupé (« … ») ; révision en double attachée une fois ; 51 révisions → 2", async () => {
		const id = (await outil(["tickets", "creer", "--titre", "Limites", "--pages", "salle:limites", "--json"])).json.id;
		assert.equal((await outil(["tickets", "prendre", id])).code, 0);
		const long = commitCode(`${id} : ` + "x".repeat(250));
		const r = await outil(["tickets", "commit", id, "HEAD", "HEAD", long, "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.json.commits.length, 1, "HEAD, HEAD et son hash : un seul commit"); assert.equal(r.json.ajoutes, 1);
		const m = (await ticket(id)).donnees.commits[0].message;
		assert.equal([...m].length, 200); assert.ok(m.endsWith("…")); assert.ok(m.startsWith(`${id} : xxx`));
		const n = nbCommits(depot);
		const trop = await outil(["tickets", "commit", id, ...Array(51).fill("HEAD"), "--json"]);
		assert.equal(trop.code, 2, "51 révisions : usage"); assert.equal(nbCommits(depot), n);
		assert.equal((await outil(["tickets", "commit", id, ...Array(50).fill("HEAD"), "--json"])).code, 0, "50 révisions : permis");
	});

	test("ticket illisible : voir, prendre, critere, revue, commit sortent en 1 avec illisible: true, sans aucune écriture", async () => {
		const f = await faux({ id: "T-9", illisible: true, erreur: "clé inconnue : x" }, []);
		try {
			for (const args of [["voir", "T-9"], ["prendre", "T-9"], ["rendre", "T-9"], ["critere", "T-9", "1"], ["revue", "T-9"], ["commit", "T-9", "HEAD"]]) {
				const r = await outil(["tickets", ...args, "--json"], { cwd: f.dossier });
				assert.equal(r.code, 1, args.join(" ") + " : " + r.stderr);
				assert.equal(r.json.erreur.illisible, true, args.join(" ")); assert.match(r.json.erreur.message, /illisible/);
			}
			assert.equal(f.recus.length, 0, "aucune écriture envoyée");
		} finally { await f.fermer(); }
	});

	test("revue et critere sur le ticket d'un autre : 4 « pas à toi », même quand rien ne changerait (sans avertissement)", async () => {
		const autre = (await appel(u, "/api/admin/jetons", { cookie: alex, corps: { projet: "jardin", nom: "Agent de Camille", pour: "camille" } })).corps.jeton;
		const id = (await outil(["tickets", "creer", "--titre", "En revue", "--pages", "salle:revue", "--critere", "un", "--critere", "deux", "--json"])).json.id;
		assert.equal((await outil(["tickets", "prendre", id])).code, 0);
		assert.equal((await outil(["tickets", "critere", id, "1"])).code, 0);
		assert.equal((await outil(["tickets", "revue", id])).code, 0);
		const n = nbCommits(depot);
		const r = await outil(["tickets", "revue", id, "--json"], { env: { OUTIL_JETON: autre } });
		assert.equal(r.code, 4, r.stderr); assert.match(r.json.erreur.message, /tenu par Agent · pour Alex \(en-revue\) : il n'est pas à toi/);
		assert.ok(!/non coché/.test(r.stderr), "pas d'avertissement sur les critères");
		const c = await outil(["tickets", "critere", id, "1", "--json"], { env: { OUTIL_JETON: autre } });
		assert.equal(c.code, 4, c.stderr); assert.match(c.json.erreur.message, /il n'est pas à toi/);
		assert.equal(nbCommits(depot), n, "rien d'écrit");
		// Le preneur lui-même : « déjà en revue », code 0, sans avertissement répété.
		const moi = await outil(["tickets", "revue", id, "--json"]);
		assert.equal(moi.code, 0); assert.equal(moi.json.inchange, true); assert.ok(!/non coché/.test(moi.stderr));
		// Personne ne tient le ticket (à faire, d'un autre auteur) : pas de « pas à toi », rien d'écrit.
		const libre = (await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "Libre", criteres: ["c"] } })).corps.id;
		const l = await outil(["tickets", "critere", libre, "1", "--pas-fait", "--json"], { env: { OUTIL_JETON: autre } });
		assert.equal(l.code, 0, l.stderr); assert.equal(l.json.inchange, true);
		// Son propre ticket, fermé par un humain : pas de « pas à toi » non plus.
		const v = (await ticket(id)).version;
		assert.equal((await appel(u, `/api/p/jardin/tickets/${id}/fermer`, { cookie: alex, corps: { version: v, retours: [] } })).status, 200);
		const f = await outil(["tickets", "critere", id, "1", "--json"]);
		assert.equal(f.code, 0, f.stderr); assert.equal(f.json.inchange, true); assert.ok(!/pas à toi/.test(f.stderr));
		assert.equal(nbCommits(depot), n + 2, "seules la création et la fermeture ont écrit");
	});

	test("aide tickets fermer : code 2 et le même message que « tickets fermer »", async () => {
		for (const args of [["aide", "tickets", "fermer"], ["aide", "tickets", "fermer", "--json"], ["tickets", "fermer", "--aide"]]) {
			const r = await outil(args);
			assert.equal(r.code, 2, args.join(" ")); assert.match(r.stderr, /geste humain/);
		}
	});

	test("statut : disciplines du projet (valeurs de --discipline)", async () => {
		const r = await outil(["statut", "--json"]);
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(r.json.disciplines, [{ nom: "programmation", libelle: "Programmation" }]);
		assert.match((await outil(["statut"])).stdout, /disciplines : programmation \(Programmation\)/);
	});
});
