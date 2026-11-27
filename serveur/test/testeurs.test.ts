// Étape 3.9, lot 6, E2 : testeurs externes. Invitation limitée à des onglets et à une durée ; le testeur ne voit que
// ces onglets (page construite pour lui par le serveur) et ses propres retours ; tout le reste de l'API lui est refusé.
// Preuve par canari : une chaîne témoin posée dans un onglet caché, une note, un ticket et le retour d'un autre, puis
// cherchée dans tout ce qu'un testeur peut obtenir, flux compris (événement reçu après coup).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, appelHote, docRetour, dossierTemp, nettoyer, serveurTest, projet, session, ecouter, pause, portLibre } from "./aide.ts";
import { PLAFOND_APP } from "../src/http.ts";
import { peutLancer } from "../src/demandes.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import type { Serveur } from "../src/principal.ts";

const CANARI = "CANARI-7f3a";
const exemple = () => {
	const d = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"), "utf8"));
	const regles = d.tabs.find((t: { id: string }) => t.id === "regles");
	regles.sections[0].items[0].text = `${CANARI}-onglet : règle cachée`;
	return d;
};

describe("E2 : testeurs externes", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string, zoe = "", zoeId = "";
	before(async () => {
		donnees = dossierTemp("testeurs");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		const n = await appel(u, "/api/p/jardin/notes/notes_2026-11-20.json", { methode: "PUT", cookie: maud, corps: { title: "Notes", date: "2026-11-20", milestones: { J1: "Premier" },
			changes: [{ id: "J1-a", milestone: "J1", subject: `${CANARI}-note`, before: "avant", after: "après" }], validations: [{ id: "J1-v", milestone: "J1", text: `${CANARI}-valider ?` }] } });
		assert.ok(n.status === 201 || n.status === 200, n.texte);
		const b = await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(exemple()), entetes: { "Content-Type": "application/json" } });
		assert.equal(b.status, 201, b.texte);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: `${CANARI}-retour de Camille` }) })).status, 201);
		assert.equal((await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `${CANARI}-ticket`, description: "x" } })).status, 201);
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("invitation : onglets du dernier build (au moins un) et durée de 1 à 90 jours ; refusée à un contributeur", async () => {
		const m = await appel(u, "/api/p/jardin/membres", { cookie: maud });
		assert.deepEqual(m.corps.onglets_wiki.map((o: { id: string }) => o.id), ["plantes", "ecrans", "regles"]);
		for (const c of [{ role: "testeur" }, { role: "testeur", onglets: [] }, { role: "testeur", onglets: ["inconnu"] }, { role: "testeur", onglets: ["plantes"], jours: 0 },
			{ role: "testeur", onglets: ["plantes"], jours: 91 }, { role: "contributeur", onglets: ["plantes"] }])
			assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: c })).status, 400, JSON.stringify(c));
		assert.equal((await appel(u, "/api/p/jardin/invitations", { cookie: camille, corps: { role: "testeur", onglets: ["plantes"] } })).status, 403);
		const inv = await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "testeur", onglets: ["plantes"], jours: 7 } });
		assert.equal(inv.status, 201, inv.texte); assert.deepEqual(inv.corps.onglets, ["plantes"]); assert.equal(inv.corps.jours, 7);
		const acc = await appel(u, inv.corps.lien, { corps: { nom: "Zoé" } });
		assert.equal(acc.status, 303); assert.equal(acc.entetes.get("location"), "/p/jardin/");
		zoe = (acc.entetes.get("set-cookie") || "").split(";")[0];
		const moi = await appel(u, "/api/moi", { cookie: zoe });
		zoeId = moi.corps.compte.id;
		const p = moi.corps.projets.find((x: { id: string }) => x.id === "jardin");
		assert.equal(p.role, "testeur"); assert.deepEqual(p.testeur.onglets, ["plantes"]);
		const fin = Date.parse(p.testeur.fin) - Date.now();
		assert.ok(fin > 6.9 * 86400000 && fin <= 7 * 86400000, "fin comptée à partir de l'acceptation");
		const mm = (await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps.membres.find((x: { compte: string }) => x.compte === zoeId);
		assert.equal(mm.role, "testeur"); assert.deepEqual(mm.testeur.onglets, ["plantes"]); assert.equal(mm.testeur.fini, false);
	});

	test("page : ses onglets seulement, sans liens vers un onglet caché, sans notes ; ni versions, ni autre build", async () => {
		const r = await appel(u, "/p/jardin/", { cookie: zoe });
		assert.equal(r.status, 200);
		assert.ok(r.texte.includes("Tomate"), "onglet permis");
		assert.ok(!r.texte.includes(CANARI), "rien de l'onglet caché ni des notes");
		assert.ok(!/regles--|ecrans--|data-tab="(regles|ecrans)"/.test(r.texte), "aucune ancre vers un onglet caché");
		assert.ok(!r.texte.includes("Règle d'arrosage"), "le libellé d'un lien vers un onglet caché est retiré");
		assert.ok(r.texte.includes("Associée au basilic"), "un lien vers un onglet permis reste");
		assert.ok(!/"regle"\s*:\s*"Règle"|"ecran"\s*:\s*"Écran"/.test(r.texte), "ni les sortes des onglets cachés");
		assert.ok(!/data-onglet="(retours|kanban)">/.test(r.texte), "bandeau : ni Retours, ni Kanban");
		assert.ok(r.texte.includes('<meta name="wdd-sans-versions" content="1">'), "pas de lien « Versions »");
		assert.ok(!r.texte.includes("Écrans de l'appli") && !r.texte.includes("Règles de calcul"), "ni les onglets cachés");
		const garde = fs.readdirSync(path.join(donnees, "projets", "jardin", "builds", "1")).filter(f => f.startsWith("audience-"));
		assert.equal(garde.length, 1, "page gardée avec le build : " + garde.join(", "));
		assert.equal((await appel(u, "/p/jardin/", { cookie: zoe })).texte, r.texte, "seconde lecture : la page gardée");
		for (const c of ["/p/jardin/b/", "/p/jardin/b/1/"]) assert.equal((await appel(u, c, { cookie: zoe })).status, 403, c);
		const maudPage = await appel(u, "/p/jardin/", { cookie: maud });
		assert.ok(maudPage.texte.includes(CANARI), "le mainteneur, lui, voit tout");
	});

	test("API : liste blanche ; ses propres retours seulement ; jamais « pour », « Moi aussi », ni le retour d'un autre", async () => {
		const ses = await appel(u, "/api/p/jardin/session", { cookie: zoe });
		assert.equal(ses.corps.role, "testeur"); assert.equal(ses.corps.testeur, true); assert.equal(ses.corps.ecriture, true);
		assert.deepEqual((await appel(u, "/api/p/jardin/retours", { cookie: zoe })).corps.docs, []);
		const c = await appel(u, "/api/p/jardin/retours", { cookie: zoe, corps: docRetour({ text: "La tomate pousse trop vite" }) });
		assert.equal(c.status, 201, c.texte);
		const l = (await appel(u, "/api/p/jardin/retours", { cookie: zoe })).corps.docs;
		assert.deepEqual(l.map((d: { id: string }) => d.id), [c.corps.id]);
		assert.equal(l[0].donnees.externe, "testeur", "marqué par le serveur");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ externe: "testeur" }) })).status, 400, "jamais posé par un client");
		assert.equal((await appel(u, `/api/p/jardin/retours/${c.corps.id}`, { cookie: zoe, methode: "PATCH", corps: { version: 1, champs: { externe: "" } } })).status, 403, "ni retiré par son auteur");
		const noms = (await appel(u, "/api/p/jardin/noms", { cookie: maud })).corps.noms;
		assert.equal(noms[zoeId], "Zoé (testeur externe)");
		assert.equal((await appel(u, `/api/p/jardin/retours/${c.corps.id}`, { cookie: zoe, methode: "PATCH", corps: { version: 1, champs: { text: "Pousse trop vite" } } })).status, 200);
		assert.equal((await appel(u, `/api/p/jardin/retours/${c.corps.id}`, { cookie: zoe, methode: "PATCH", corps: { version: 2, champs: { pour: "maud" } } })).status, 403);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: zoe, corps: docRetour({ pour: "maud" }) })).status, 403);
		const autre = (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((d: { donnees: { by: string } }) => d.donnees.by === "camille");
		assert.equal((await appel(u, `/api/p/jardin/retours/${autre.id}`, { cookie: zoe, methode: "PATCH", corps: { version: autre.version, champs: { text: autre.donnees.text + " et moi", status: "nouveau" } } })).status, 403);
		assert.equal((await appel(u, `/api/p/jardin/retours/${autre.id}?version=${autre.version}`, { cookie: zoe, methode: "DELETE" })).status, 403);
		for (const [mt, ch, corps] of [["GET", "tickets"], ["GET", "tickets-fiches"], ["GET", "noms"], ["GET", "approbations"], ["GET", "builds"], ["GET", "builds?tous=1"],
			["GET", "builds/1/page"], ["GET", "reglages"], ["GET", "membres"], ["GET", "notes"], ["GET", "notes/notes_2026-11-20.json"], ["GET", "export/retours.csv"],
			["GET", "export/tickets.json"], ["GET", "demandes"], ["GET", "journal"], ["POST", `retours/${autre.id}/aussi`, { version: autre.version }],
			["POST", "tickets", { titre: "x" }], ["POST", "demandes", {}], ["PUT", "notes/notes_2026-11-21.json", {}], ["POST", "invitations", { role: "testeur", onglets: ["plantes"] }],
			["POST", "jetons", { nom: "x" }], ["POST", "retours/batch", {}]] as [string, string, unknown?][]) {
			const r = await appel(u, `/api/p/jardin/${ch}`, { cookie: zoe, methode: mt, ...(corps !== undefined ? { corps } : {}) });
			assert.equal(r.status, 403, `${mt} ${ch} : ${r.status}`);
			assert.ok(!r.texte.includes(CANARI), `${mt} ${ch}`);
		}
	});

	test("canari : rien des autres dans /api/moi, la liste, ni le flux (même après coup) ; pas d'événement tickets", async () => {
		const moi = await appel(u, "/api/moi", { cookie: zoe });
		assert.ok(!moi.texte.includes(CANARI), moi.texte.slice(0, 300));
		const p = moi.corps.projets.find((x: { id: string }) => x.id === "jardin");
		assert.equal(p.retours, 1); assert.equal(p.tickets, 0); assert.equal(p.a_moi.total.a_valider, 0);
		const f = await ecouter(s.port, "/api/p/jardin/flux", zoe);
		await f.attendre(1);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: `${CANARI}-flux @Zoé` }) })).status, 201);
		await f.attendre(2);
		await appel(u, "/api/p/jardin/tickets", { cookie: maud, corps: { titre: `${CANARI}-ticket-2`, description: "y" } });
		await pause(300);
		f.fermer();
		assert.ok(!JSON.stringify(f.evenements).includes(CANARI));
		assert.ok(f.evenements.every((e: { docs: { donnees: { by: string } }[] }) => e.docs.every(d => d.donnees.by === zoeId)));
		assert.equal(f.tickets.length, 0);
		const moi2 = await appel(u, "/api/moi", { cookie: zoe });
		assert.ok(!moi2.texte.includes(CANARI), "une mention ne remonte pas chez un testeur");
	});

	test("fusion : le testeur ne relit ni « aussi » ni le nom ou l'id de l'autre retour ; sa série ne lance jamais de traitement ; plafond", async () => {
		const sienId = (await appel(u, "/api/p/jardin/retours", { cookie: zoe })).corps.docs[0].id;
		const c2 = (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: `${CANARI}-doublon`, kind: "regle", ref: "frost.alert", name: "Alerte gel", tab: "regles", anchor: "regles--frost-alert" }) })).corps.id;
		const ver = async (id: string) => (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((d: { id: string }) => d.id === id).version;
		// Doublon de Camille fusionné dans le retour du testeur : « aussi » reçoit Camille.
		assert.equal((await appel(u, `/api/p/jardin/retours/${sienId}/fusionner`, { cookie: maud, corps: { version: await ver(sienId), doublons: [{ id: c2, version: await ver(c2) }] } })).status, 200);
		let vu = await appel(u, "/api/p/jardin/retours", { cookie: zoe });
		assert.equal(vu.corps.docs[0].donnees.aussi, undefined); assert.ok(!vu.texte.includes("camille") && !vu.texte.includes(CANARI));
		// Son retour fusionné dans celui (caché) d'une autre : la réponse ne nomme pas l'autre fiche.
		const c3 = (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: "principal", kind: "regle", ref: "rotation.years", name: `${CANARI}-Rotation`, tab: "regles", anchor: "regles--rotation-years" }) })).corps.id;
		assert.equal((await appel(u, `/api/p/jardin/retours/${c3}/fusionner`, { cookie: maud, corps: { version: 1, doublons: [{ id: sienId, version: await ver(sienId) }] } })).status, 200);
		vu = await appel(u, "/api/p/jardin/retours", { cookie: zoe });
		const d = vu.corps.docs.find((x: { id: string }) => x.id === sienId).donnees;
		assert.equal(d.status, "fait"); assert.equal(d.fusionne_dans, undefined); assert.match(d.reply, /^Fusionné avec un autre retour/);
		assert.ok(!vu.texte.includes(CANARI) && !vu.texte.includes(c3));
		// Série avec « traitement_serie » et un veilleur connecté : envoyée, aucun traitement lancé.
		assert.equal((await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { traitement_serie: true } })).status, 200);
		const ag = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Veilleur" } })).corps.jeton;
		const v = appel(u, "/api/p/jardin/veille", { bearer: ag, corps: { poste: "PC-code" } });
		await pause(150);
		const se = await appel(u, "/api/p/jardin/retours/serie", { cookie: zoe, corps: { retours: [docRetour({ text: "série 1" }), docRetour({ text: "série 2" })] } });
		assert.equal(se.status, 201, se.texte); assert.equal(se.corps.demande, null);
		for (const t of ["personne", "mainteneur", "contributeur"] as const) { assert.equal(peutLancer("testeur", t), false); assert.equal(peutLancer("retour", t), false); }
		await appel(u, "/api/p/jardin/reglages", { cookie: maud, methode: "PUT", corps: { traitement_serie: false } });
		void v;
		// Plafond du jour, par personne, aussi dans le Wiki.
		const avant = PLAFOND_APP.retours;
		PLAFOND_APP.retours = 0;
		try {
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: zoe, corps: docRetour({ text: "de trop" }) })).status, 429);
			assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: "un membre" }) })).status, 201, "pas pour un membre");
		} finally { PLAFOND_APP.retours = avant; }
	});

	test("jetons et appairage : jamais pour un testeur", async () => {
		const adm = await session(u, "jardin", "adm", "admin");
		const j = await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom: "x", pour: zoeId } });
		assert.equal(j.status, 400, j.texte);
		// Un jeton créé à son nom par la base ne vaudrait rien (Base.valeurJeton).
		const brut = s.ctx.base.creerJeton("jardin", "y", "agent", zoeId);
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer: brut.jeton })).status, 401);
	});

	test("prolonger, changer d'onglets ; à la fin de l'accès : page, API et flux coupés", async () => {
		const p = await appel(u, `/api/p/jardin/membres/${zoeId}`, { cookie: maud, methode: "PUT", corps: { onglets: ["plantes", "ecrans"], jours: 3 } });
		assert.equal(p.status, 200, p.texte);
		const page = await appel(u, "/p/jardin/", { cookie: zoe });
		assert.ok(page.texte.includes("Écrans de l'appli") && !page.texte.includes("Règles de calcul"), "nouvel onglet visible, pas le troisième");
		assert.ok(!page.texte.includes(CANARI));
		assert.equal((await appel(u, `/api/p/jardin/membres/${zoeId}`, { cookie: maud, methode: "PUT", corps: { onglets: ["regles"], role: "lecteur" } })).status, 400);
		const f = await ecouter(s.port, "/api/p/jardin/flux", zoe);
		await f.attendre(1);
		s.ctx.base.modifierRestriction(zoeId, "jardin", { onglets: ["plantes"], fin: new Date(Date.now() - 1000).toISOString() });
		s.ctx.flux.reverifier();
		await f.ferme;
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: zoe })).status, 403);
		assert.equal((await appel(u, "/p/jardin/", { cookie: zoe })).status, 403);
		assert.ok(!(await appel(u, "/api/moi", { cookie: zoe })).corps.projets.some((x: { id: string }) => x.id === "jardin"));
		const mm = (await appel(u, "/api/p/jardin/membres", { cookie: maud })).corps.membres.find((x: { compte: string }) => x.compte === zoeId);
		assert.equal(mm.testeur.fini, true);
		// Un mainteneur le rétablit ; puis il le passe contributeur : la restriction disparaît.
		assert.equal((await appel(u, `/api/p/jardin/membres/${zoeId}`, { cookie: maud, methode: "PUT", corps: { onglets: ["plantes"], jours: 1 } })).status, 200);
		assert.equal((await appel(u, "/api/p/jardin/session", { cookie: zoe })).status, 200);
		assert.equal((await appel(u, `/api/p/jardin/membres/${zoeId}`, { cookie: maud, methode: "PUT", corps: { role: "contributeur" } })).status, 200);
		assert.equal(s.ctx.base.restriction(zoeId, "jardin"), null);
		assert.ok((await appel(u, "/p/jardin/", { cookie: zoe })).texte.includes(CANARI), "contributeur : tout le Wiki");
	});
});

describe("E2 : testeur externe avec deux hôtes (WDD_URL_PAGES)", () => {
	let s: Serveur, donnees: string, port: number, H: string, P: string, u: string, maud: string, camille: string, zoe = "";
	before(async () => {
		donnees = dossierTemp("testeurs-hotes");
		port = await portLibre();
		H = `127.0.0.1:${port}`; P = `localhost:${port}`; u = `http://${H}`;
		s = await serveurTest(donnees, { port, url: u, urlPages: `http://${P}` });
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		assert.equal((await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(exemple()), entetes: { "Content-Type": "application/json" } })).status, 201);
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: `${CANARI}-retour` }) });
		const inv = await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "testeur", onglets: ["plantes"], jours: 7 } });
		zoe = ((await appel(u, inv.corps.lien, { corps: { nom: "Zoé" } })).entetes.get("set-cookie") || "").split(";")[0];
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	test("entrée, page réduite, API et flux filtrés sur l'hôte des pages", async () => {
		const r1 = await appelHote(port, H, "/p/jardin/", { cookie: zoe });
		assert.equal(r1.status, 303);
		const loc = new URL(String(r1.entetes.location));
		const r2 = await appelHote(port, P, loc.pathname + loc.search);
		assert.equal(r2.status, 303);
		const c = r2.setCookie.find(x => x.includes("Path=/api/p/jardin/"))!.split(";")[0];
		const page = await appelHote(port, P, "/p/jardin/", { cookie: c });
		assert.equal(page.status, 200);
		assert.ok(page.texte.includes("Tomate") && !page.texte.includes(CANARI) && !page.texte.includes("Règles de calcul"));
		assert.ok(page.texte.includes('<meta name="wdd-sans-versions" content="1">'));
		assert.equal((await appelHote(port, P, "/p/jardin/b/", { cookie: c })).status, 403);
		const ses = await appelHote(port, P, "/api/p/jardin/session", { cookie: c });
		assert.equal(ses.corps.role, "testeur");
		assert.equal((await appelHote(port, P, "/api/p/jardin/noms", { cookie: c })).status, 403);
		const l = await appelHote(port, P, "/api/p/jardin/retours", { cookie: c });
		assert.deepEqual(l.corps.docs, []);
		const f = await ecouter(port, "/api/p/jardin/flux", c, P);
		await f.attendre(1);
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: `${CANARI}-flux` }) });
		await f.attendre(2);
		f.fermer();
		assert.ok(!JSON.stringify(f.evenements).includes(CANARI));
	});
});
