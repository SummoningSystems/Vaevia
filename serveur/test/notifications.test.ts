// Étape 3.7, I1 (docs/etape3-7-dix-premieres.md) : notifications par webhook. Rien ne part sans réglage ; un mainteneur
// règle adresse, format, contenu, événements, rythme ; envoi regroupé, hors du chemin des écritures, signé HMAC ;
// adresses internes refusées sans WDD_NOTIF_LOCALES. Récepteur : un serveur HTTP local (notifLocales: true).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { appel, docRetour, dossierTemp, nettoyer, serveurTest, projet, session, pause } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { RACINE_OUTIL } from "../src/config.ts";
import { adresseInterne, validerUrl, composer } from "../src/notifications.ts";

type Recu = { corps: any; brut: string; entetes: http.IncomingHttpHeaders };
function recepteur(): Promise<{ url: string; recus: Recu[]; statut: { code: number; delai: number }; fermer: () => Promise<void> }> {
	const recus: Recu[] = [], statut = { code: 204, delai: 0 };
	const s = http.createServer((req, res) => {
		let t = ""; req.setEncoding("utf8"); req.on("data", c => t += c);
		req.on("end", () => { recus.push({ brut: t, corps: JSON.parse(t), entetes: req.headers }); setTimeout(() => { res.writeHead(statut.code); res.end(); }, statut.delai); });
	});
	return new Promise(ok => s.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(s.address() as any).port}/crochet`, recus, statut, fermer: () => new Promise(r => { s.closeAllConnections(); s.close(() => r()); }) })));
}
const attendre = async (f: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !f(); t += 25) await pause(25); return f(); };

describe("adresses et messages", () => {
	test("adresses internes reconnues", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) assert.equal(adresseInterne(ip), true, ip);
		for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::7f00:1", "64:ff9b::a00:1", "fd12::1"]) assert.equal(adresseInterne(ip), true, ip + " (IPv4 encodée, ULA)");
		for (const ip of ["8.8.8.8", "172.32.0.1", "2001:4860::8888", "::ffff:808:808"]) assert.equal(adresseInterne(ip), false, ip);
	});
	test("validerUrl : https seulement, ni identifiants, ni nom ou IP internes (sauf WDD_NOTIF_LOCALES)", () => {
		assert.equal(validerUrl("https://hooks.slack.com/services/x", false), "https://hooks.slack.com/services/x");
		for (const u of ["https://[::ffff:127.0.0.1]/x", "https://[::ffff:a00:1]/x", "http://hooks.slack.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://serveur.local/x", "https://intranet/x", "https://a:b@hooks.slack.com/x", "ftp://x.fr/", "https://[::1]/x", "https://169.254.169.254/x"])
			assert.throws(() => validerUrl(u, false), /url :/, u);
		assert.equal(validerUrl("http://127.0.0.1:9/x", true), "http://127.0.0.1:9/x");
	});
	test("composer : « titre » sans aucun texte de retour ; « complet » avec noms et extraits", () => {
		const evts = [{ type: "retour", quand: "", nom: "Tomate", texte: "secret de fabrication" }, { type: "retour", quand: "", nom: "Basilic", texte: "x" }, { type: "question", quand: "", nom: "Persil", texte: "Plat ou frisé ?" }, { type: "build", quand: "", build: 4 }];
		const t = composer("Jardin", "https://r.fr/p/jardin/", evts, "titre");
		assert.equal(t, "Jardin : 2 nouveaux retours, 1 question de l'agent, Wiki publié (build n° 4).\nhttps://r.fr/p/jardin/");
		const c = composer("Jardin", "https://r.fr/p/jardin/", evts, "complet");
		assert.match(c, /• Retour sur Tomate : secret de fabrication/); assert.match(c, /• Question sur Persil : Plat ou frisé \?/);
	});
});

describe("notifications d'un projet", () => {
	let s: Serveur, donnees: string, u: string, maud: string, camille: string, agent: string, rec: Awaited<ReturnType<typeof recepteur>>;
	const regler = (corps: unknown, cookie = maud) => appel(u, "/api/p/jardin/notifications", { cookie, methode: "PUT", corps });
	before(async () => {
		donnees = dossierTemp("notifications");
		rec = await recepteur();
		s = await serveurTest(donnees, { notifLocales: true, notifRegroupementMs: 150, notifEssaiMs: [50, 50], notifDelaiMs: 2000 });
		u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); await rec.fermer(); nettoyer(donnees); });

	test("sans réglage : rien ne part", async () => {
		assert.deepEqual((await appel(u, "/api/p/jardin/notifications", { cookie: maud })).corps, { configure: false });
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() })).status, 201);
		await pause(400);
		assert.equal(rec.recus.length, 0);
	});

	let secret = "";
	test("réglage : mainteneur en session seulement ; secret montré une fois ; ni adresse ni secret relus", async () => {
		assert.equal((await regler({ url: rec.url }, camille)).status, 403);
		assert.equal((await appel(u, "/api/p/jardin/notifications", { bearer: agent, methode: "PUT", corps: { url: rec.url } })).status, 403);
		assert.equal((await regler({ url: rec.url, format: "xml" })).status, 400);
		assert.equal((await regler({ url: rec.url, evenements: [] })).status, 400);
		const r = await regler({ url: rec.url, format: "json", contenu: "titre", evenements: ["retour", "question", "revue", "traitement", "build"], rythme: "chaque" });
		assert.equal(r.status, 200, r.texte);
		assert.match(r.corps.secret, /^[A-Za-z0-9_-]{40,}$/); secret = r.corps.secret;
		const g = await appel(u, "/api/p/jardin/notifications", { cookie: maud });
		assert.equal(g.corps.hote, new URL(rec.url).host); assert.equal(g.corps.secret, undefined);
		assert.ok(!g.texte.includes("/crochet") && !g.texte.includes(secret), "ni chemin de l'adresse ni secret");
		const r2 = await regler({ contenu: "titre" });
		assert.equal(r2.status, 200); assert.equal(r2.corps.secret, undefined, "pas de nouveau secret sans le demander");
		const j = await appel(u, "/api/admin/journal", { cookie: await session(u, "jardin", "adm", "admin") });
		assert.ok(JSON.stringify(j.corps).includes("notifications réglées") && !JSON.stringify(j.corps).includes("/crochet"), "journal sans l'adresse");
	});

	test("une série de 3 retours : un seul envoi, regroupé, signé ; « titre » sans texte des retours", async () => {
		rec.recus.length = 0;
		const r = await appel(u, "/api/p/jardin/retours/serie", { cookie: camille, corps: { retours: [docRetour({ text: "confidentiel A" }), docRetour({ text: "B" }), docRetour({ text: "C" })] } });
		assert.equal(r.status, 201);
		assert.ok(await attendre(() => rec.recus.length >= 1));
		await pause(300);
		assert.equal(rec.recus.length, 1);
		const m = rec.recus[0];
		assert.equal(m.entetes["x-wdd-signature"], "sha256=" + crypto.createHmac("sha256", secret).update(m.brut).digest("hex"));
		assert.equal(m.entetes["x-wdd-evenement"], "retour");
		assert.equal(m.corps.projet, "jardin"); assert.equal(m.corps.evenements.length, 3);
		assert.match(m.corps.texte, /^Projet jardin : 3 nouveaux retours\.\nhttp:\/\/127\.0\.0\.1:\d+\/p\/jardin\/$/);
		assert.ok(!m.brut.includes("confidentiel"), "aucun texte de retour en mode titre");
	});

	test("question de l'agent, ticket en revue, build : notifiés ; « complet » donne les extraits ; format discord", async () => {
		assert.equal((await regler({ contenu: "complet", format: "discord" })).status, 200);
		rec.recus.length = 0;
		const c = (await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ ref: "basilic", name: "Basilic" }) })).corps;
		await attendre(() => rec.recus.length >= 1); rec.recus.length = 0;
		await appel(u, `/api/p/jardin/retours/${c.id}`, { bearer: agent, methode: "PATCH", corps: { version: c.version, champs: { status: "question", reply: "Grand vert ou pourpre ?", replied: new Date().toISOString() } } });
		const t = (await appel(u, "/api/p/jardin/tickets", { cookie: camille, corps: { titre: "Arrosage" } })).corps;
		await appel(u, `/api/p/jardin/tickets/${t.id}/prendre`, { cookie: camille, corps: { version: 1 } });
		await appel(u, `/api/p/jardin/tickets/${t.id}`, { cookie: camille, methode: "PATCH", corps: { version: 2, champs: { statut: "en-revue" } } });
		await appel(u, "/api/p/jardin/builds", { bearer: agent, brut: fs.readFileSync(path.join(RACINE_OUTIL, "site", "examples", "data.json")), entetes: { "Content-Type": "application/json" } });
		assert.ok(await attendre(() => rec.recus.some(x => /build n° 1/.test(x.corps.content))));
		const tout = rec.recus.map(x => x.corps.content).join("\n");
		assert.match(tout, /1 question de l'agent/); assert.match(tout, /• Question sur Basilic : Grand vert ou pourpre \?/);
		assert.match(tout, /1 ticket en revue/); assert.match(tout, new RegExp(`• ${t.id} en revue : Arrosage`));
		assert.deepEqual(rec.recus[0].corps.allowed_mentions, { parse: [] }, "discord : aucune mention (@everyone) déclenchée");
	});

	test("échec du destinataire : 3 essais (500), puis l'échec est noté ; 404 : pas de nouvel essai", async () => {
		await regler({ format: "json", contenu: "titre" });
		rec.recus.length = 0; rec.statut.code = 500;
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
		assert.ok(await attendre(() => rec.recus.length >= 3));
		await pause(200);
		assert.equal(rec.recus.length, 3);
		let g = await appel(u, "/api/p/jardin/notifications", { cookie: maud });
		assert.equal(g.corps.dernier.ok, false); assert.equal(g.corps.dernier.message, "HTTP 500");
		rec.recus.length = 0; rec.statut.code = 404;
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
		assert.ok(await attendre(() => rec.recus.length >= 1)); await pause(300);
		assert.equal(rec.recus.length, 1);
		rec.statut.code = 204;
		const e = await appel(u, "/api/p/jardin/notifications/essai", { cookie: maud, corps: {} });
		assert.deepEqual(e.corps, { ok: true, message: "HTTP 204" });
		g = await appel(u, "/api/p/jardin/notifications", { cookie: maud });
		assert.equal(g.corps.dernier.ok, true);
	});

	test("un destinataire lent ne ralentit pas les écritures", async () => {
		rec.statut.delai = 1500;
		const t0 = Date.now();
		for (let i = 0; i < 3; i++) assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() })).status, 201);
		assert.ok(Date.now() - t0 < 1000, "écritures rapides : " + (Date.now() - t0) + " ms");
		await pause(1900); rec.statut.delai = 0;
	});

	test("résumé quotidien : rien avant l'échéance, puis un seul envoi regroupé", async () => {
		await regler({ rythme: "quotidien" });
		await pause(300); rec.recus.length = 0;
		for (let i = 0; i < 2; i++) await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
		await pause(400);
		assert.equal(rec.recus.length, 0);
		s.ctx.notifieur.envoyerResumes(false);
		assert.ok(await attendre(() => rec.recus.length >= 1));
		assert.match(rec.recus[0].corps.texte, /2 nouveaux retours/);
		rec.recus.length = 0;
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
		s.ctx.notifieur.envoyerResumes(false);
		await pause(300);
		assert.equal(rec.recus.length, 0, "moins de 24 h depuis le dernier résumé");
	});

	test("Slack (et Teams) : < > & échappés, une mention <!channel> écrite dans un retour reste du texte", async () => {
		await regler({ format: "slack", contenu: "complet", rythme: "chaque" });
		rec.recus.length = 0;
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ text: "<!channel> urgent & <b>gras</b>" }) });
		assert.ok(await attendre(() => rec.recus.length >= 1));
		const t = rec.recus[0].corps.text;
		assert.ok(!t.includes("<!channel>") && !t.includes("<b>"), t);
		assert.ok(t.includes("&lt;!channel&gt; urgent &amp; &lt;b&gt;gras&lt;/b&gt;"), t);
	});

	test("désactivé, puis retiré : plus rien ne part", async () => {
		await regler({ rythme: "chaque", actif: false });
		rec.recus.length = 0;
		await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() });
		await pause(400);
		assert.equal(rec.recus.length, 0);
		assert.equal((await appel(u, "/api/p/jardin/notifications", { cookie: maud, methode: "DELETE" })).status, 204);
		assert.deepEqual((await appel(u, "/api/p/jardin/notifications", { cookie: maud })).corps, { configure: false });
	});
});

describe("sans WDD_NOTIF_LOCALES", () => {
	let s: Serveur, donnees: string;
	before(async () => { donnees = dossierTemp("notif-ext"); s = await serveurTest(donnees); await projet(s.url, "jardin"); });
	after(async () => { await s.arreter(); nettoyer(donnees); });
	test("adresse locale refusée à l'enregistrement", async () => {
		const maud = await session(s.url, "jardin", "maud", "mainteneur", "Maud");
		const r = await appel(s.url, "/api/p/jardin/notifications", { cookie: maud, methode: "PUT", corps: { url: "http://127.0.0.1:9/x" } });
		assert.equal(r.status, 400); assert.match(r.texte, /https:\/\/ seulement|adresse interne/);
	});
});
