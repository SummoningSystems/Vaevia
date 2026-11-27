// Verrou du dossier des données (serveur/src/verrou.ts) : un seul serveur par WDD_DONNEES. Un second serveur, d'un autre
// processus ou du même, est refusé ; un verrou périmé (PID mort, PID de ce processus comme sous Docker, PID vivant qui
// ne répond plus) est repris ; le verrou est rendu à l'arrêt et quand le démarrage échoue.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { dossierTemp, nettoyer, serveurTest, appel } from "./aide.ts";
import type { Serveur } from "../src/principal.ts";
import { cheminVerrou } from "../src/verrou.ts";

const PRINCIPAL = path.resolve(import.meta.dirname, "..", "src", "principal.ts");
const lireVerrou = (d: string) => JSON.parse(fs.readFileSync(cheminVerrou(d), "utf8"));
const ecrireVerrou = (d: string, o: Record<string, unknown>) => fs.writeFileSync(cheminVerrou(d), JSON.stringify({ port: 1, hote: "127.0.0.1", debut: new Date().toISOString(), ecoute: true, jeton: "ancien", ...o }) + "\n");

// node principal.ts dans un autre processus (asynchrone : le serveur de ce processus doit pouvoir répondre à /api/sante).
function serveurExterne(donnees: string): Promise<{ code: number; sortie: string }> {
	return new Promise((ok, ko) => {
		const p = spawn(process.execPath, [PRINCIPAL], { env: { PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "", WDD_DONNEES: donnees, WDD_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let sortie = "";
		p.stdout.on("data", c => sortie += c); p.stderr.on("data", c => sortie += c);
		const minuterie = setTimeout(() => { p.kill(); ko(new Error("serveur externe : plus de 20 s\n" + sortie)); }, 20000);
		p.on("close", c => { clearTimeout(minuterie); ok({ code: c ?? -1, sortie }); });
	});
}
// Un processus vivant qui n'est pas un serveur (PID « repris »), et le PID d'un processus terminé.
function dormeur() { return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true }); }
async function pidMort(): Promise<number> {
	const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
	await new Promise(r => p.on("close", r));
	return p.pid!;
}

describe("verrou du dossier des données (serveur.verrou)", () => {
	let base: string;
	const ouverts: Serveur[] = [];
	const dossier = (nom: string) => { const d = path.join(base, nom); fs.mkdirSync(d); return fs.realpathSync.native(d); };
	const demarrer = async (d: string) => { const s = await serveurTest(d, { test: false }); ouverts.push(s); return s; };
	before(() => { base = dossierTemp("verrou"); });
	after(async () => { for (const s of ouverts) await s.arreter(); nettoyer(base); });

	test("pris au démarrage (PID, port réel, ecoute) ; un second serveur d'un autre processus est refusé, le premier continue", async () => {
		const d = dossier("a");
		const s = await demarrer(d);
		const v = lireVerrou(d);
		assert.equal(v.pid, process.pid); assert.equal(v.port, s.port); assert.equal(v.ecoute, true);
		const r = await serveurExterne(d);
		assert.equal(r.code, 1, r.sortie);
		assert.match(r.sortie, /démarrage impossible : un autre serveur utilise déjà ce dossier de données/);
		assert.ok(r.sortie.includes(`PID ${process.pid}, port ${s.port}`), r.sortie);
		assert.deepEqual(lireVerrou(d), v, "le verrou du premier est intact");
		assert.equal((await appel(s.url, "/api/sante")).status, 200);
	});

	test("un second serveur du même processus est refusé ; rendu à l'arrêt, puis repris", async () => {
		const d = dossier("b");
		const s = await demarrer(d);
		await assert.rejects(serveurTest(d, { test: false }), /ce processus sert déjà le dossier des données/);
		await s.arreter();
		assert.ok(!fs.existsSync(cheminVerrou(d)), "rendu à l'arrêt");
		const s2 = await demarrer(d);
		assert.equal(lireVerrou(d).port, s2.port);
	});

	test("périmé : PID mort, PID de ce processus (Docker, PID 1), PID vivant qui ne répond plus : repris", async () => {
		const d = dossier("c");
		for (const pid of [await pidMort(), process.pid]) {
			ecrireVerrou(d, { pid });
			const s = await demarrer(d);
			const v = lireVerrou(d);
			assert.equal(v.pid, process.pid); assert.notEqual(v.jeton, "ancien"); assert.equal(v.port, s.port);
			await s.arreter();
		}
		const z = dormeur();
		try {
			ecrireVerrou(d, { pid: z.pid, port: 1, ecoute: true });
			const s = await demarrer(d);
			assert.notEqual(lireVerrou(d).jeton, "ancien");
			await s.arreter();
		} finally { z.kill(); }
	});

	test("PID vivant encore en train de démarrer (ecoute: false, moins de 2 min) : refusé ; plus ancien : repris", async () => {
		const d = dossier("d");
		const z = dormeur();
		try {
			ecrireVerrou(d, { pid: z.pid, ecoute: false });
			await assert.rejects(serveurTest(d, { test: false }), /un autre serveur utilise déjà ce dossier de données .*\(en cours de démarrage\)/);
			assert.equal(lireVerrou(d).jeton, "ancien", "verrou laissé tel quel");
			ecrireVerrou(d, { pid: z.pid, ecoute: false, debut: new Date(Date.now() - 3 * 60000).toISOString() });
			const s = await demarrer(d);
			assert.notEqual(lireVerrou(d).jeton, "ancien");
			await s.arreter();
		} finally { z.kill(); }
	});

	test("illisible : repris ; démarrage en échec (base abîmée) : verrou rendu", async () => {
		const d = dossier("e");
		fs.writeFileSync(cheminVerrou(d), "{ abîmé");
		const s = await demarrer(d);
		assert.equal(lireVerrou(d).pid, process.pid);
		await s.arreter();
		const f = dossier("f");
		fs.writeFileSync(path.join(f, "outil.sqlite"), "pas une base\n");
		// Dans un autre processus (la base abîmée y reste ouverte jusqu'à la sortie).
		const r = await serveurExterne(f);
		assert.equal(r.code, 1, r.sortie); assert.match(r.sortie, /démarrage impossible/);
		assert.ok(!fs.existsSync(cheminVerrou(f)), "verrou rendu après l'échec");
	});
});
