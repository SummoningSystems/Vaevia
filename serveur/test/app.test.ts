// Étape 3.9, lot 6, I2 : retours depuis une application (docs/retours-depuis-une-application.md). Le protocole est
// parlé ici en fetch nu, sans adaptateur : il ne dépend d'aucun moteur. Jeton « retour » : créer des retours et envoyer
// des captures, au nom de son propriétaire, rien d'autre ; appairage depuis l'application ; plafond par personne.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, pause } from "./aide.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import { PLAFOND_APP } from "../src/http.ts";
import type { Serveur } from "../src/principal.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
const INTERVALLE = 100;

describe("I2 : retours depuis une application", () => {
	let s: Serveur, u: string, donnees: string, maud: string, camille: string, lea: string, jeton = "";
	before(async () => {
		donnees = dossierTemp("app");
		s = await serveurTest(donnees, { intervalleAppairageMs: INTERVALLE });
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		const d = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json"), "utf8"));
		d.tabs[0].sections[0].items.find((i: { id: string }) => i.id === "tomate").anciennes_refs = ["tomate-ronde"];
		assert.equal((await appel(u, "/api/p/jardin/builds", { cookie: maud, brut: JSON.stringify(d), entetes: { "Content-Type": "application/json" } })).status, 201);
		const j = await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Build de test", role: "retour" } });
		assert.equal(j.status, 201, j.texte); jeton = j.corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });
	const app = (corps: unknown, bearer = jeton) => appel(u, "/api/p/jardin/retours/app", { bearer, corps });
	const doc = async (id: string) => (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((d: { id: string }) => d.id === id);

	test("cible « sorte:ref » : le serveur complète nom, onglet, ancre, date des données ; ancienne ref suivie ; inconnue ou absente : sans fiche", async () => {
		const r = await app({ text: "Le compteur saute", cible: "plante:tomate", cat: "bug", contexte: "Potager 0.3 · Windows · 1920×1080" });
		assert.equal(r.status, 201, r.texte);
		assert.deepEqual(r.corps.fiche, { trouvee: true, kind: "plante", ref: "tomate", name: "Tomate", anchor: "plantes--tomate" });
		const d = (await doc(r.corps.id)).donnees;
		assert.equal(d.by, "maud", "au nom du propriétaire du jeton");
		assert.equal(d.tab, "plantes"); assert.equal(d.codex, "2026-11-15T09:30:00Z"); assert.equal(d.status, "nouveau");
		assert.equal(d.text, "Le compteur saute\n\nContexte : Potager 0.3 · Windows · 1920×1080");
		assert.equal(d.externe, undefined);
		assert.equal((await app({ text: "x", cible: "plante:tomate-ronde" })).corps.fiche.ref, "tomate", "ancienne ref");
		const inc = await app({ text: "x", cible: "ecran:options-audio" });
		assert.equal(inc.status, 201); assert.equal(inc.corps.fiche.trouvee, false); assert.equal((await doc(inc.corps.id)).donnees.anchor, "");
		const sans = await app({ text: "Plante au lancement" });
		assert.equal(sans.status, 201); assert.deepEqual([sans.corps.fiche.kind, sans.corps.fiche.ref, sans.corps.fiche.trouvee], ["general", "application", false]);
	});

	test("capture jointe ; validation du corps", async () => {
		const c = await appel(u, "/api/p/jardin/captures", { bearer: jeton, brut: PNG, entetes: { "Content-Type": "image/png" } });
		assert.equal(c.status, 201, c.texte);
		const r = await app({ text: "Voir la capture", cible: "ecran:route:/", captures: [c.corps.id] });
		assert.equal(r.status, 201, r.texte);
		assert.equal((await doc(r.corps.id)).donnees.captures, c.corps.id);
		for (const x of [{}, { text: "  " }, { text: "x", cat: "grave" }, { text: "x", cible: "Plante:tomate" }, { text: "x", cible: "plante:" }, { text: "x", contexte: "a\nb" },
			{ text: "x", captures: ["../x.png"] }, { text: "x", captures: ["0".repeat(64) + ".png"] }, { text: "x", by: "camille" }, { text: "x", externe: "testeur" }])
			assert.equal((await app(x)).status, 400, JSON.stringify(x));
	});

	test("jeton « retour » : rien d'autre (ni lire, ni modifier, ni l'API classique) ; les autres auteurs peuvent aussi s'en servir", async () => {
		assert.equal((await appel(u, "/api/p/jardin/session", { bearer: jeton })).status, 200);
		const id = (await app({ text: "à moi" })).corps.id;
		for (const [m, c, corps] of [["GET", "retours"], ["GET", "flux"], ["GET", "noms"], ["GET", "tickets"], ["POST", "retours", { text: "x" }], ["POST", "retours/serie", { retours: [] }],
			["PATCH", `retours/${id}`, { version: 1, champs: { text: "y" } }], ["DELETE", `retours/${id}?version=1`], ["GET", "builds"], ["PUT", "notes/notes_2026-11-21.json", {}]] as [string, string, unknown?][])
			assert.equal((await appel(u, `/api/p/jardin/${c}`, { bearer: jeton, methode: m, ...(corps !== undefined ? { corps } : {}) })).status, 403, `${m} ${c}`);
		assert.equal((await appel(u, "/p/jardin/", { bearer: jeton })).status, 403, "ni la page");
		assert.equal((await appel(u, "/p/jardin/b/", { bearer: jeton })).status, 403, "ni les versions");
		assert.equal((await appel(u, "/api/p/jardin/retours/app", { cookie: camille, corps: { text: "depuis un outil maison", cible: "plante:basilic" } })).status, 201, "un contributeur, en session");
		assert.equal((await appel(u, "/api/p/jardin/retours/app", { cookie: lea, corps: { text: "x" } })).status, 403, "pas un lecteur");
	});

	test("plafond par personne et par jour : un nouveau jeton ne le remet pas à zéro", async () => {
		const avant = PLAFOND_APP.retours;
		const adm = await session(u, "jardin", "adm", "admin");
		await session(u, "jardin", "nina", "contributeur", "Nina");
		const pour = async (qui: string, nom: string) => (await appel(u, "/api/admin/jetons", { cookie: adm, corps: { projet: "jardin", nom, role: "retour", pour: qui } })).corps.jeton;
		const j = await pour("camille", "Plafond"), j2 = await pour("camille", "Plafond 2"), j3 = await pour("nina", "Plafond 3");
		PLAFOND_APP.retours = 2;
		try {
			assert.equal((await app({ text: "1" }, j)).status, 201);
			assert.equal((await app({ text: "2" }, j)).status, 201);
			const r = await app({ text: "3" }, j);
			assert.equal(r.status, 429); assert.match(r.texte, /plafond du jour/);
			assert.equal((await app({ text: "nouveau jeton" }, j2)).status, 429, "même personne, nouveau jeton");
			assert.equal((await app({ text: "autre personne" }, j3)).status, 201, "par personne");
		} finally { PLAFOND_APP.retours = avant; }
	});

	test("appairage depuis l'application : un testeur externe l'autorise ; rôle jamais élargi ; retours marqués externes ; fin avec lui", async () => {
		const inv = await appel(u, "/api/p/jardin/invitations", { cookie: maud, corps: { role: "testeur", onglets: ["plantes"], jours: 7 } });
		const acc = await appel(u, inv.corps.lien, { corps: { nom: "Zoé" } });
		const zoe = (acc.entetes.get("set-cookie") || "").split(";")[0];
		const zoeId = (await appel(u, "/api/moi", { cookie: zoe })).corps.compte.id;
		const dem = await appel(u, "/api/appairage", { corps: { poste: "Potager · Windows", projet: "jardin", role: "retour" } });
		assert.equal(dem.status, 201, dem.texte);
		const code = dem.corps.code;
		const vu = await appel(u, `/api/appairage/${code}`, { cookie: zoe });
		assert.equal(vu.corps.role, "retour"); assert.deepEqual(vu.corps.projets.map((p: { id: string; role_max: string }) => [p.id, p.role_max]), [["jardin", "retour"]]);
		assert.deepEqual((await appel(u, `/api/appairage/${code}`, { cookie: lea })).corps.projets, [], "un lecteur ne l'autorise pas");
		assert.equal((await appel(u, `/api/appairage/${code}/autoriser`, { cookie: zoe, corps: { projet: "jardin", role: "agent" } })).status, 403, "jamais élargi");
		assert.equal((await appel(u, `/api/appairage/${code}/autoriser`, { cookie: zoe, corps: { projet: "jardin", role: "retour" } })).status, 204);
		await pause(INTERVALLE + 20);
		const l = await appel(u, "/api/appairage/jeton", { corps: { code_appareil: dem.corps.code_appareil } });
		assert.equal(l.status, 200, l.texte);
		assert.equal(l.corps.role, "retour"); assert.equal(l.corps.nom, "Application · Potager · Windows"); assert.equal(l.corps.pour.id, zoeId);
		const fin = Date.parse((await appel(u, "/api/moi", { cookie: zoe })).corps.projets[0].testeur.fin);
		assert.ok(Date.parse(l.corps.expire) <= fin, "expire au plus tard avec l'accès du testeur");
		const r = await app({ text: "Le bouton Semer est caché", cible: "plante:tomate" }, l.corps.jeton);
		assert.equal(r.status, 201, r.texte);
		const d = (await doc(r.corps.id)).donnees;
		assert.equal(d.by, zoeId); assert.equal(d.externe, "testeur");
		assert.deepEqual((await appel(u, "/api/p/jardin/retours", { cookie: zoe })).corps.docs.map((x: { id: string }) => x.id), [r.corps.id], "il le retrouve dans le Wiki");
		// Une cible dans un onglet que le testeur ne voit pas : sans fiche, ni nom ni ancre de la fiche cachée en retour.
		const cachee = await app({ text: "x", cible: "regle:watering.base_interval" }, l.corps.jeton);
		assert.equal(cachee.status, 201, cachee.texte);
		assert.equal(cachee.status, 201); assert.equal(cachee.corps.fiche.trouvee, false);
		assert.ok(!cachee.texte.includes("Intervalle") && !cachee.texte.includes("regles--"), cachee.texte);
		const dc = (await doc(cachee.corps.id)).donnees;
		assert.equal(dc.name, "watering.base_interval"); assert.equal(dc.tab, ""); assert.equal(dc.anchor, "");
		const parSession = await appel(u, "/api/p/jardin/retours/app", { cookie: zoe, corps: { text: "y", cible: "regle:frost.alert" } });
		assert.equal(parSession.status, 403, "en session, un testeur passe par le Wiki (liste blanche)"); assert.ok(!parSession.texte.includes("Alerte gel"));
		assert.equal((await app({ text: "z", cible: "plante:basilic" }, l.corps.jeton)).corps.fiche.trouvee, true, "dans ses onglets : trouvée");
		// Une demande d'agent ne s'autorise pas en « retour ».
		const dem2 = await appel(u, "/api/appairage", { corps: { poste: "Poste", projet: "jardin" } });
		assert.equal((await appel(u, `/api/appairage/${dem2.corps.code}/autoriser`, { cookie: maud, corps: { projet: "jardin", role: "retour" } })).status, 403);
		// Fin de l'accès du testeur : son jeton ne vaut plus.
		s.ctx.base.modifierRestriction(zoeId, "jardin", { onglets: ["plantes"], fin: new Date(Date.now() - 1000).toISOString() });
		assert.equal((await app({ text: "après la fin" }, l.corps.jeton)).status, 401);
	});
});
