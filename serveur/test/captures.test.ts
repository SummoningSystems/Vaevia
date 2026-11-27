// Étape 3.7, R2 (docs/etape3-7-dix-premieres.md) : captures jointes aux retours. PNG ou WebP seulement (signature),
// 2 Mio et 4096 px au plus, stockées hors Git sous leur empreinte, servies sans jamais être du HTML ; citées par le champ
// facultatif « captures » d'un nouveau retour (3 au plus, chacune présente) ; jamais modifiables ensuite ; sauvegardées.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { appel, appelHote, docRetour, dossierTemp, nettoyer, serveurTest, projet, session, portLibre, depotDe, git } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { lireImage } from "../src/captures.ts";

// PNG valide de l×h pixels (RVB), construit à la main (IHDR, IDAT, IEND et leurs CRC).
function png(l: number, h: number, graine = 0): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const morceau = (type: string, data: Buffer) => { const t = Buffer.from(type, "latin1"); const lg = Buffer.alloc(4); lg.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([lg, t, data, c]); };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(l, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	const lignes = Buffer.alloc((l * 3 + 1) * h, graine);
	for (let y = 0; y < h; y++) lignes[y * (l * 3 + 1)] = 0;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), morceau("IHDR", ihdr), morceau("IDAT", zlib.deflateSync(lignes)), morceau("IEND", Buffer.alloc(0))]);
}
// En-tête WebP VP8X (le serveur ne lit que l'en-tête).
function webpX(l: number, h: number): Buffer {
	const b = Buffer.alloc(40); b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
	b.writeUIntLE(l - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
}

describe("lireImage", () => {
	test("PNG et WebP (VP8X) : type et dimensions ; le reste : null", () => {
		assert.deepEqual(lireImage(png(3, 2)), { type: "png", largeur: 3, hauteur: 2 });
		assert.deepEqual(lireImage(webpX(800, 600)), { type: "webp", largeur: 800, hauteur: 600 });
		for (const t of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "GIF89a......", "<html><script>alert(1)</script>", ""]) assert.equal(lireImage(Buffer.from(t)), null, t);
	});
});

describe("captures d'un projet", () => {
	let s: Serveur, donnees: string, u: string, maud: string, camille: string, lea: string, agent: string;
	const envoyer = (corps: Buffer, cookie = camille, type = "image/png") => appel(u, "/api/p/jardin/captures", { cookie, brut: corps, entetes: { "Content-Type": type } });
	before(async () => {
		donnees = dossierTemp("captures");
		s = await serveurTest(donnees, { sauvegarde: donnees + "-sauv" }); u = s.url;
		await projet(u, "jardin");
		maud = await session(u, "jardin", "maud", "mainteneur", "Maud");
		camille = await session(u, "jardin", "camille", "contributeur", "Camille");
		lea = await session(u, "jardin", "lea", "lecteur", "Léa");
		agent = (await appel(u, "/api/p/jardin/jetons", { cookie: maud, corps: { nom: "Agent", role: "agent" } })).corps.jeton;
	});
	after(async () => { await s.arreter(); nettoyer(donnees); nettoyer(donnees + "-sauv"); });

	let id = "";
	test("envoi : id = empreinte + extension, fichier hors du dépôt Git, même image gardée une fois", async () => {
		const img = png(4, 3);
		const r = await envoyer(img);
		assert.equal(r.status, 201, r.texte);
		id = r.corps.id;
		assert.equal(id, crypto.createHash("sha256").update(img).digest("hex") + ".png");
		assert.deepEqual({ l: r.corps.largeur, h: r.corps.hauteur, o: r.corps.octets }, { l: 4, h: 3, o: img.length });
		assert.ok(fs.existsSync(path.join(donnees, "projets", "jardin", "captures", id)));
		assert.equal(git(depotDe(donnees, "jardin"), "status", "--porcelain").trim(), "", "rien dans le dépôt de design");
		assert.equal((await envoyer(img)).corps.id, id);
		assert.equal(fs.readdirSync(path.join(donnees, "projets", "jardin", "captures")).length, 1);
	});

	test("refus : SVG, HTML, GIF (400), trop grand (413), dimensions trop grandes (400) ; lecteur (403) ; agent (403)", async () => {
		assert.equal((await envoyer(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), camille, "image/svg+xml")).status, 400);
		assert.equal((await envoyer(Buffer.from("<html><script>alert(1)</script></html>"), camille, "image/png")).status, 400, "le type annoncé ne compte pas");
		assert.equal((await envoyer(Buffer.from("GIF89a\x01\x00\x01\x00"), camille, "image/gif")).status, 400);
		assert.equal((await envoyer(Buffer.concat([png(2, 2), Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
		assert.equal((await envoyer(webpX(5000, 100), camille, "image/webp")).status, 400);
		assert.equal((await envoyer(png(2, 2), lea)).status, 403);
		assert.equal((await appel(u, "/api/p/jardin/captures", { bearer: agent, brut: png(2, 2), entetes: { "Content-Type": "image/png" } })).status, 403);
	});

	test("lecture : membres et agent ; type fixé, nosniff, CSP fermée, bac à sable ; id invalide ou absent : 404", async () => {
		for (const o of [{ cookie: lea }, { bearer: agent }]) {
			const r = await fetch(`${u}/api/p/jardin/captures/${id}`, { headers: o.cookie ? { Cookie: o.cookie } : { Authorization: "Bearer " + o.bearer } });
			assert.equal(r.status, 200);
			assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
			assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
			assert.equal(Buffer.from(await r.arrayBuffer()).length, png(4, 3).length);
		}
		assert.equal((await appel(u, "/api/p/jardin/captures/../../outil.sqlite", { cookie: lea })).status, 404);
		assert.equal((await appel(u, `/api/p/jardin/captures/${"0".repeat(64)}.png`, { cookie: lea })).status, 404);
		assert.equal((await appel(u, `/api/p/jardin/captures/${id}`)).status, 401);
	});

	test("retour avec captures : citées si présentes (3 au plus) ; jamais modifiables ensuite ; affichées par l'API", async () => {
		const r = await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ captures: id }) });
		assert.equal(r.status, 201, r.texte);
		const d = (await appel(u, "/api/p/jardin/retours", { cookie: maud })).corps.docs.find((x: any) => x.id === r.corps.id);
		assert.equal(d.donnees.captures, id);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ captures: "0".repeat(64) + ".png" }) })).status, 400, "capture inconnue");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ captures: [id, id, id, id].join(" ") }) })).status, 400, "4 captures");
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour({ captures: "../x.png" }) })).status, 400);
		assert.equal((await appel(u, "/api/p/jardin/retours", { cookie: camille, corps: docRetour() })).status, 201, "sans captures : comme avant");
		const p = await appel(u, `/api/p/jardin/retours/${r.corps.id}`, { cookie: camille, methode: "PATCH", corps: { version: 1, champs: { captures: "" } } });
		assert.equal(p.status, 403, "l'auteur ne change pas les captures");
		const serie = await appel(u, "/api/p/jardin/retours/serie", { cookie: camille, corps: { retours: [docRetour({ captures: id }), docRetour({ captures: "f".repeat(64) + ".webp" })] } });
		assert.equal(serie.status, 400); assert.equal(serie.corps.index, 1);
	});

	test("hôte des pages : envoi et lecture permis", async () => {
		const port = await portLibre();
		const d2 = dossierTemp("captures-pages");
		const s2 = await serveurTest(d2, { port, url: `http://127.0.0.1:${port}`, urlPages: `http://localhost:${port}` });
		try {
			await projet(s2.url, "jardin");
			const c = await session(s2.url, "jardin", "camille", "contributeur", "Camille");
			const r1 = await appelHote(port, `127.0.0.1:${port}`, "/p/jardin/", { cookie: c });
			const loc = new URL(String(r1.entetes.location));
			const r2 = await appelHote(port, `localhost:${port}`, loc.pathname + loc.search);
			const cp = r2.setCookie.find(x => x.includes("Path=/api/p/jardin/"))!.split(";")[0];
			const e = await appelHote(port, `localhost:${port}`, "/api/p/jardin/captures", { cookie: cp, origin: `http://localhost:${port}`, brut: png(2, 2), entetes: { "Content-Type": "image/png" } });
			assert.equal(e.status, 201, e.texte);
			const g = await appelHote(port, `localhost:${port}`, `/api/p/jardin/captures/${e.corps.id}`, { cookie: cp });
			assert.equal(g.status, 200);
		} finally { await s2.arreter(); nettoyer(d2); }
	});

	test("sauvegarde : les captures sont dans la sauvegarde", async () => {
		const adm = await session(u, "jardin", "adm", "admin", "Adèle");
		const r = await appel(u, "/api/admin/sauvegarde", { cookie: adm, corps: {} });
		assert.equal(r.status, 201, r.texte);
		const m = JSON.parse(fs.readFileSync(path.join(donnees + "-sauv", r.corps.sauvegarde.nom, "manifeste.json"), "utf8"));
		assert.ok(m.fichiers[`projets/jardin/captures/${id}`], "capture sauvegardée");
	});
});
