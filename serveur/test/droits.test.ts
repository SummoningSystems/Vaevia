// Droits sur les retours (docs/etape1-serveur.md § 3.1), cas par cas : d'abord les fonctions pures, puis les mêmes
// règles à travers l'API (lecteur, contributeur, mainteneur, admin, agent).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { droitCreer, droitModifier, droitSupprimer, validerCreation, validerChamps } from "../src/retours.ts";
import type { Acteur } from "../src/retours.ts";
import type { Role } from "../src/base.ts";
import { appel, dossierTemp, nettoyer, serveurTest, projet, session, docRetour } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";

const qui = (role: Role, id = "moi"): Acteur => ({ id, nom: id, role, email: id + "@wdd.invalid", agent: role === "agent" });
const sien = { text: "Mon retour.", by: "moi", status: "question" };
const autre = { text: "Retour d'un collègue.", by: "collegue", status: "fait" };
const ok = (r: string | null) => assert.equal(r, null);
const non = (r: string | null) => assert.equal(typeof r, "string");

describe("droits : fonctions pures (§ 3.1)", () => {
	test("lecteur : lit seulement", () => {
		non(droitCreer(qui("lecteur")));
		non(droitModifier(qui("lecteur"), sien, { text: "Mon retour. ajout" }));
		non(droitSupprimer(qui("lecteur"), sien));
	});
	test("contributeur : crée", () => ok(droitCreer(qui("contributeur"))));
	test("contributeur, son retour : text, proposal, cat, statut remis à nouveau, updated ; supprime", () => {
		const a = qui("contributeur");
		ok(droitModifier(a, sien, { text: "Tout autre texte" }));
		ok(droitModifier(a, sien, { proposal: "6", cat: "bug", updated: "2026-11-23T10:00:00Z" }));
		ok(droitModifier(a, sien, { text: "Mon retour.\n\n— Réponse du 23/11 : oui", status: "nouveau", updated: "2026-11-23T10:00:00Z" }));
		non(droitModifier(a, sien, { status: "fait" }));
		non(droitModifier(a, sien, { reply: "je me réponds" }));
		non(droitModifier(a, sien, { kind: "regle" }));
		non(droitModifier(a, sien, { by: "autre" }));
		ok(droitSupprimer(a, sien));
	});
	test("contributeur, retour d'un autre : seulement un ajout à la fin de text, statut nouveau ; pas de suppression", () => {
		const a = qui("contributeur");
		ok(droitModifier(a, autre, { text: autre.text + "\n\n— Précision du 23/11 : merci", status: "nouveau", updated: "2026-11-23T10:00:00Z" }));
		non(droitModifier(a, autre, { text: "Texte remplacé", status: "nouveau" }));
		non(droitModifier(a, autre, { text: autre.text, status: "nouveau" }), "rien d'ajouté");
		non(droitModifier(a, autre, { text: autre.text + " ajout" }), "sans statut nouveau");
		non(droitModifier(a, autre, { text: autre.text + " ajout", status: "pris" }));
		non(droitModifier(a, autre, { text: autre.text + " ajout", status: "nouveau", cat: "bug" }));
		non(droitModifier(a, autre, { proposal: "x" }));
		non(droitModifier(a, autre, { status: "nouveau" }));
		non(droitSupprimer(a, autre));
	});
	for (const role of ["mainteneur", "admin"] as Role[]) {
		test(`${role} : comme un contributeur, plus supprimer tout retour`, () => {
			const a = qui(role);
			ok(droitCreer(a));
			ok(droitModifier(a, sien, { cat: "bug" }));
			ok(droitModifier(a, autre, { text: autre.text + " ajout", status: "nouveau" }));
			non(droitModifier(a, autre, { cat: "bug" }));
			non(droitModifier(a, autre, { reply: "réponse" }));
			ok(droitSupprimer(a, sien));
			ok(droitSupprimer(a, autre));
		});
	}
	test("agent : lit ; status, reply, replied, updated seulement ; ni création ni suppression", () => {
		const a = qui("agent", "agent:x");
		non(droitCreer(a));
		ok(droitModifier(a, autre, { status: "fait", reply: "Fait.", replied: "2026-11-23T10:00:00Z", updated: "2026-11-23T10:00:00Z" }));
		non(droitModifier(a, autre, { text: autre.text + " ajout" }));
		non(droitModifier(a, autre, { cat: "bug" }));
		non(droitSupprimer(a, autre));
	});
	test("validation : champs inconnus, dates, longueurs, création", () => {
		assert.throws(() => validerChamps({ couleur: "rouge" }), /champ inconnu/);
		assert.throws(() => validerChamps({ id: "x" }), /champ inconnu/);
		assert.throws(() => validerChamps({ version: 3 }), /champ inconnu/);
		assert.throws(() => validerChamps({}), /au moins/);
		assert.throws(() => validerChamps({ updated: "hier" }), /ISO/);
		assert.throws(() => validerChamps({ status: "perdu" }), /status/);
		assert.throws(() => validerChamps({ text: 3 }), /texte/);
		assert.throws(() => validerChamps({ text: "x".repeat(20001) }), /20000/);
		validerChamps({ text: "x".repeat(20000), replied: "" });
		const a = qui("contributeur");
		assert.equal(validerCreation(docRetour({ by: "usurpe" }), a).by, "moi", "by réécrit depuis la session");
		assert.equal(validerCreation((({ by, ...r }) => r)(docRetour()), a).by, "moi", "by facultatif");
		assert.throws(() => validerCreation(docRetour({ created: "2026-13-45" }), a), /ISO/);
		assert.throws(() => validerCreation(docRetour({ status: "fait" }), a), /nouveau/);
		assert.throws(() => validerCreation(docRetour({ reply: "déjà" }), a), /vides/);
		assert.throws(() => validerCreation(docRetour({ id: "abc" }), a), /champ inconnu/);
		assert.throws(() => validerCreation((({ codex, ...r }) => r)(docRetour()), a), /manquant/);
		assert.throws(() => validerCreation(docRetour({ proposal: "p".repeat(20001) }), a), /20000/);
	});
});

describe("droits : à travers l'API", () => {
	let s: Serveur, donnees: string, u: string;
	const c: Record<string, string> = {};
	let bearer = "";
	before(async () => {
		donnees = dossierTemp("droits");
		s = await serveurTest(donnees);
		u = s.url;
		await projet(u, "jardin");
		await projet(u, "autre");
		for (const [id, role] of [["lect", "lecteur"], ["moi", "contributeur"], ["collegue", "contributeur"], ["chef", "mainteneur"], ["adm", "admin"]])
			c[id] = await session(u, "jardin", id, role);
		const j = await appel(u, "/api/admin/jetons", { cookie: c.adm, corps: { projet: "jardin", nom: "Claude" } });
		assert.equal(j.status, 201);
		bearer = j.corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); });

	const creer = async (cookie: string, extra = {}) => appel(u, "/api/p/jardin/retours", { cookie, corps: docRetour(extra) });
	const patch = (o: { cookie?: string; bearer?: string }, id: string, version: number, champs: Record<string, unknown>) =>
		appel(u, `/api/p/jardin/retours/${id}`, { ...o, methode: "PATCH", corps: { champs, version } });
	const suppr = (o: { cookie?: string; bearer?: string }, id: string, version: number) => appel(u, `/api/p/jardin/retours/${id}?version=${version}`, { ...o, methode: "DELETE" });

	test("session : rôle, propriétaire, écriture", async () => {
		const attendu: Record<string, [string, boolean, boolean]> = { lect: ["lecteur", false, false], moi: ["contributeur", false, true], chef: ["mainteneur", true, true], adm: ["admin", true, true] };
		for (const [id, [role, proprietaire, ecriture]] of Object.entries(attendu)) {
			const r = await appel(u, "/api/p/jardin/session", { cookie: c[id] });
			assert.deepEqual(r.corps, { id, nom: id, role, proprietaire, ecriture });
		}
		const a = await appel(u, "/api/p/jardin/session", { bearer });
		assert.equal(a.corps.role, "agent"); assert.equal(a.corps.ecriture, false);
		assert.equal((await appel(u, "/api/p/jardin/session")).status, 401);
		assert.equal((await appel(u, "/api/p/autre/session", { cookie: c.moi })).corps.code, "permission_denied");
		assert.equal((await appel(u, "/api/p/autre/session", { bearer })).status, 403, "jeton limité à son projet");
	});

	test("lecteur : lit, n'écrit pas", async () => {
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: c.lect })).status, 200);
		const r = await creer(c.lect);
		assert.equal(r.status, 403); assert.equal(r.corps.code, "permission_denied");
	});

	test("contributeur : crée (by réécrit), modifie et supprime le sien", async () => {
		const r = await creer(c.moi, { by: "usurpe" });
		assert.equal(r.status, 201); assert.equal(r.corps.version, 1); assert.match(r.corps.id, /^[A-Za-z0-9]{20}$/);
		const l = await appel(u, "/api/p/jardin/retours", { cookie: c.moi });
		assert.equal(l.corps.docs.find((d: any) => d.id === r.corps.id).donnees.by, "moi");
		let p = await patch({ cookie: c.moi }, r.corps.id, 1, { text: "Autre texte", proposal: "6", cat: "bug" });
		assert.equal(p.status, 200); assert.equal(p.corps.version, 2);
		p = await patch({ cookie: c.moi }, r.corps.id, 2, { status: "fait" });
		assert.equal(p.status, 403);
		const d = await suppr({ cookie: c.moi }, r.corps.id, 2);
		assert.equal(d.status, 204);
	});

	test("contributeur sur le retour d'un autre : ajout seulement, pas de suppression", async () => {
		const r = await creer(c.collegue, { text: "Base." });
		const id = r.corps.id;
		assert.equal((await patch({ cookie: c.moi }, id, 1, { text: "Remplacé", status: "nouveau" })).status, 403);
		assert.equal((await patch({ cookie: c.moi }, id, 1, { cat: "bug" })).status, 403);
		const p = await patch({ cookie: c.moi }, id, 1, { text: "Base.\n\n— Précision du 23/11 : merci", status: "nouveau", updated: new Date().toISOString() });
		assert.equal(p.status, 200);
		const d = await suppr({ cookie: c.moi }, id, 2);
		assert.equal(d.status, 403); assert.equal(d.corps.code, "permission_denied");
	});

	test("mainteneur et admin : suppriment le retour d'un autre, ne réécrivent pas son texte", async () => {
		for (const qui of ["chef", "adm"]) {
			const r = await creer(c.collegue);
			assert.equal((await patch({ cookie: c[qui] }, r.corps.id, 1, { text: "Remplacé", status: "nouveau" })).status, 403);
			assert.equal((await suppr({ cookie: c[qui] }, r.corps.id, 1)).status, 204);
		}
	});

	test("agent : lit (filtre de statut), répond, ne crée ni ne supprime ni ne touche au texte", async () => {
		const r = await creer(c.moi);
		const id = r.corps.id;
		const l = await appel(u, "/api/p/jardin/retours?status=nouveau,pris", { bearer });
		assert.equal(l.status, 200);
		assert.ok(l.corps.docs.every((d: any) => ["nouveau", "pris"].includes(d.donnees.status)));
		assert.ok(l.corps.docs.some((d: any) => d.id === id));
		assert.match(l.corps.rev, /^[0-9a-f]{40}$/);
		assert.equal((await appel(u, "/api/p/jardin/retours", { bearer, corps: docRetour() })).status, 403);
		assert.equal((await patch({ bearer }, id, 1, { text: "réécrit" })).status, 403);
		const p = await patch({ bearer }, id, 1, { status: "question", reply: "Partout ?", replied: new Date().toISOString(), updated: new Date().toISOString() });
		assert.equal(p.status, 200);
		assert.equal((await suppr({ bearer }, id, 2)).status, 403);
		const f = await appel(u, "/api/p/jardin/retours?status=fait", { bearer });
		assert.ok(!f.corps.docs.some((d: any) => d.id === id));
	});

	test("champs inconnus refusés (400 invalid_document)", async () => {
		const r = await creer(c.moi, { couleur: "rouge" });
		assert.equal(r.status, 400); assert.equal(r.corps.code, "invalid_document");
		const ok = await creer(c.moi);
		const p = await patch({ cookie: c.moi }, ok.corps.id, 1, { couleur: "rouge" });
		assert.equal(p.status, 400);
		const p2 = await appel(u, `/api/p/jardin/retours/${ok.corps.id}`, { cookie: c.moi, methode: "PATCH", corps: { champs: { text: "x" }, version: 1, en_plus: 1 } });
		assert.equal(p2.status, 400);
	});
});
