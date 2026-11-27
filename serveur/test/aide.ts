// Aides des tests : serveur dans un dossier de données temporaire, requêtes HTTP, lecture du flux SSE, Git.
// Dossier temporaire : WDD_TESTS_TMP s'il est donné (chemin long, hors dépôt), sinon le dossier temporaire du système.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { demarrer } from "../src/principal.ts";
import type { Serveur } from "../src/principal.ts";
import type { Config } from "../src/config.ts";

export function dossierTemp(nom: string): string {
	const racine = process.env.WDD_TESTS_TMP || os.tmpdir();
	fs.mkdirSync(racine, { recursive: true });
	return fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(racine), `wdd-${nom}-`)));
}
export function nettoyer(dossier: string): void {
	if (!process.env.WDD_GARDER) fs.rmSync(dossier, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function serveurTest(donnees: string, surcharge: Partial<Config> = {}): Promise<Serveur> {
	return demarrer({ donnees, port: 0, hote: "127.0.0.1", test: true, silencieux: true, pingMs: 200, ...surcharge }, {});
}

export type Reponse = { status: number; corps: any; texte: string; entetes: Headers };
export type Options = { methode?: string; corps?: unknown; brut?: string | Buffer; cookie?: string; bearer?: string; xwdd?: boolean; origin?: string; entetes?: Record<string, string> };

// Requête HTTP. Avec un cookie, ou vers l'API de test, X-WDD: 1 est envoyé par défaut (xwdd: false pour l'omettre).
export async function appel(base: string, chemin: string, o: Options = {}): Promise<Reponse> {
	const h: Record<string, string> = { ...(o.entetes || {}) };
	if (o.corps !== undefined) h["Content-Type"] = "application/json";
	if (o.cookie) h.Cookie = o.cookie;
	if (o.bearer) h.Authorization = "Bearer " + o.bearer;
	if ((o.cookie || chemin.startsWith("/__test/")) && o.xwdd !== false) h["X-WDD"] = "1";
	if (o.origin) h.Origin = o.origin;
	const r = await fetch(base + chemin, { method: o.methode || (o.corps !== undefined || o.brut !== undefined ? "POST" : "GET"), headers: h, redirect: "manual",
		body: o.brut !== undefined ? o.brut : o.corps !== undefined ? JSON.stringify(o.corps) : undefined });
	const texte = await r.text();
	let corps: any = null;
	try { corps = texte ? JSON.parse(texte) : null; } catch { corps = null; }
	return { status: r.status, corps, texte, entetes: r.headers };
}

// Requête brute (chemin non normalisé : « .. », « %2F » passent tels quels).
export function appelBrut(port: number, methode: string, chemin: string, entetes: Record<string, string> = {}, corps = ""): Promise<{ status: number; texte: string }> {
	return new Promise((ok, ko) => {
		const r = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: { ...entetes, "Content-Length": Buffer.byteLength(corps) } }, res => {
			let t = ""; res.setEncoding("utf8"); res.on("data", c => t += c); res.on("end", () => ok({ status: res.statusCode || 0, texte: t }));
		});
		r.on("error", ko); r.end(corps);
	});
}

// Session de test : compte d'id choisi, rôle sur le projet ; rend l'en-tête Cookie.
export async function session(base: string, projet: string, compte: string, role: string, nom?: string): Promise<string> {
	const r = await appel(base, "/__test/session", { corps: { projet, compte, role, nom: nom || compte } });
	if (r.status !== 200) throw new Error("session de test : " + r.texte);
	return "wdd_session=" + r.corps.session;
}
export async function projet(base: string, id: string): Promise<void> {
	const r = await appel(base, "/__test/projet", { corps: { id, titre: "Projet " + id } });
	if (r.status !== 201 && r.status !== 200) throw new Error("projet de test : " + r.texte);
}

export const ISO = () => new Date().toISOString();
export function docRetour(extra: Record<string, unknown> = {}): Record<string, unknown> {
	const t = ISO();
	return { kind: "plante", ref: "tomate", name: "Tomate", tab: "plantes", anchor: "plantes--tomate", cat: "idee", text: "Trop d'eau.", proposal: "",
		status: "nouveau", reply: "", replied: "", created: t, updated: t, by: "", codex: "2026-11-15T09:30:00Z", ...extra };
}

export function git(depot: string, ...args: string[]): string {
	return execFileSync("git", ["-C", depot, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}
export const depotDe = (donnees: string, projet: string) => path.join(donnees, "projets", projet, "depot");
export const nbCommits = (depot: string) => Number(git(depot, "rev-list", "--count", "HEAD").trim());

// Flux SSE : collecte les événements « instantane » et les commentaires. Identité : cookie, ou { bearer } (agent).
// Étape 3 : aussi les événements « tickets » (dans e.tickets, attendus avec e.attendreTickets) ; « hote » : en-tête Host.
// Étape 3.5 : aussi les événements « demandes » (dans e.demandes, attendus avec e.attendreDemandes).
export type Ecoute = { evenements: any[]; tickets: any[]; demandes: any[]; attendreDemandes: (n: number, ms?: number) => Promise<void>; pings: number; status: number; fermer: () => void; attendre: (n: number, ms?: number) => Promise<void>; attendreTickets: (n: number, ms?: number) => Promise<void>; ferme: Promise<void> };
export function ecouter(port: number, chemin: string, qui: string | { bearer: string }, hote?: string): Promise<Ecoute> {
	const auth: Record<string, string> = typeof qui === "string" ? { Cookie: qui } : { Authorization: "Bearer " + qui.bearer };
	if (hote) auth.Host = hote;
	return new Promise((ok, ko) => {
		const req = http.get({ host: "127.0.0.1", port, path: chemin, headers: { ...auth, Accept: "text/event-stream" } }, res => {
			const e: Ecoute = { evenements: [], tickets: [], demandes: [], attendreDemandes: null as any, pings: 0, status: res.statusCode || 0, fermer: () => req.destroy(), attendre: null as any, attendreTickets: null as any, ferme: null as any };
			let tampon = "";
			const attentes: (() => void)[] = [];
			e.ferme = new Promise(r => { res.on("close", () => r()); res.on("error", () => r()); });
			res.setEncoding("utf8");
			res.on("data", (c: string) => {
				tampon += c;
				let i;
				while ((i = tampon.indexOf("\n\n")) >= 0) {
					const bloc = tampon.slice(0, i); tampon = tampon.slice(i + 2);
					if (bloc.startsWith(": ping")) e.pings++;
					const m = bloc.match(/^event: instantane\ndata: (.*)$/m);
					if (m) e.evenements.push(JSON.parse(m[1]));
					const t = bloc.match(/^event: tickets\ndata: (.*)$/m);
					if (t) e.tickets.push(JSON.parse(t[1]));
					const d = bloc.match(/^event: demandes\ndata: (.*)$/m);
					if (d) e.demandes.push(JSON.parse(d[1]));
					attentes.splice(0).forEach(f => f());
				}
			});
			e.attendre = (n, ms = 5000) => new Promise((r, k) => {
				const t = setTimeout(() => k(new Error(`flux : ${e.evenements.length} événements reçus, ${n} attendus`)), ms);
				const verifier = () => { if (e.evenements.length >= n) { clearTimeout(t); r(); } else attentes.push(verifier); };
				verifier();
			});
			e.attendreTickets = (n, ms = 5000) => new Promise((r, k) => {
				const t = setTimeout(() => k(new Error(`flux : ${e.tickets.length} événements tickets reçus, ${n} attendus`)), ms);
				const verifier = () => { if (e.tickets.length >= n) { clearTimeout(t); r(); } else attentes.push(verifier); };
				verifier();
			});
			e.attendreDemandes = (n, ms = 5000) => new Promise((r, k) => {
				const t = setTimeout(() => k(new Error(`flux : ${e.demandes.length} événements demandes reçus, ${n} attendus`)), ms);
				const verifier = () => { if (e.demandes.length >= n) { clearTimeout(t); r(); } else attentes.push(verifier); };
				verifier();
			});
			ok(e);
		});
		req.on("error", ko);
	});
}
export const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- Étape 3 : deux hôtes (isolement des pages, § 2) --------------------------------------------------------------
// Port libre (WDD_URL et WDD_URL_PAGES doivent contenir le port avant le démarrage).
export function portLibre(): Promise<number> {
	return new Promise((ok, ko) => {
		const s = http.createServer();
		s.once("error", ko);
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
	});
}
// Requête vers 127.0.0.1 avec un en-tête Host choisi (« localhost:<port> » pour l'hôte des pages) ; cookies posés
// rendus dans « cookies » (nom=valeur, avec leur Path dans « setCookie »).
export type ReponseHote = { status: number; corps: any; texte: string; entetes: http.IncomingHttpHeaders; setCookie: string[] };
export function appelHote(port: number, hote: string, chemin: string, o: Options = {}): Promise<ReponseHote> {
	const h: Record<string, string> = { Host: hote, ...(o.entetes || {}) };
	// Un corps binaire (Buffer) part tel quel (captures, étape 3.7).
	const corps: string | Buffer = o.brut !== undefined ? (Buffer.isBuffer(o.brut) ? o.brut : String(o.brut)) : o.corps !== undefined ? JSON.stringify(o.corps) : "";
	if (o.corps !== undefined) h["Content-Type"] = "application/json";
	if (o.cookie) h.Cookie = o.cookie;
	if (o.bearer) h.Authorization = "Bearer " + o.bearer;
	if (o.cookie && o.xwdd !== false) h["X-WDD"] = "1";
	if (o.origin) h.Origin = o.origin;
	h["Content-Length"] = String(Buffer.byteLength(corps));
	const methode = o.methode || (o.corps !== undefined || o.brut !== undefined ? "POST" : "GET");
	return new Promise((ok, ko) => {
		const r = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: h }, res => {
			let t = ""; res.setEncoding("utf8"); res.on("data", c => t += c);
			res.on("end", () => {
				let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { j = null; }
				ok({ status: res.statusCode || 0, corps: j, texte: t, entetes: res.headers, setCookie: ([] as string[]).concat(res.headers["set-cookie"] || []) });
			});
		});
		r.on("error", ko); r.end(corps);
	});
}
