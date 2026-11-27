// Notifications sortantes par webhook (étape 3.7, I1 ; docs/etape3-7-dix-premieres.md). Rien ne sort par défaut : un
// mainteneur (session) règle, pour son projet, une adresse (Discord, Slack, Teams ou JSON brut signé HMAC), le contenu
// (« titre » : nombres et lien seulement, par défaut ; « complet » : noms et extraits), les événements et le rythme
// (« chaque » : regroupés sur quelques secondes ; « quotidien » : un résumé par jour).
// - Réglages dans la base SQLite (table notifications), jamais dans le dépôt Git de design : une adresse de webhook
//   porte un secret. Elle n'est jamais renvoyée en entier (seulement son hôte).
// - Événements observés sur le flux (Flux.observateur) : nouveaux retours, questions de l'agent, tickets en revue,
//   traitements terminés ou échoués ; plus les builds publiés (appel direct). Jamais dans le chemin d'une écriture :
//   l'observation ne fait qu'empiler, l'envoi part plus tard (file à part, 3 essais), son échec n'arrête rien.
// - Adresses : https seulement ; jamais une adresse interne (bouclage, privée, lien local…), contrôlée par le nom et
//   après résolution DNS. WDD_NOTIF_LOCALES=1 permet http et les adresses internes (réseau isolé : messagerie interne).
// - Les événements en attente sont gardés en mémoire : un redémarrage perd ceux qui n'étaient pas encore partis.
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Base } from "./base.ts";
import type { Depot } from "./depot.ts";
import { estIllisible } from "./depot.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, refuse, absent } from "./retours.ts";
import type { Identite } from "./auth.ts";

export const EVENEMENTS = ["retour", "question", "revue", "traitement", "build"] as const;
export const FORMATS = ["discord", "slack", "teams", "json"] as const;
const LIBELLE_EVENEMENT: Record<string, string> = { retour: "nouveaux retours", question: "questions de l'agent", revue: "tickets en revue", traitement: "traitements finis", build: "builds publiés" };
type Evenement = { type: string; quand: string; nom?: string; texte?: string; id?: string; etat?: string; build?: number };
export type Reglage = { projet: string; url: string; format: string; contenu: string; evenements: string[]; rythme: string; actif: boolean; secret: string; dernier: { quand: string; ok: boolean; message: string } | null; dernier_resume: string };
export type OptionsNotif = { locales: boolean; regroupementMs: number; essaiMs: number[]; delaiMs: number };

// --- Adresses -----------------------------------------------------------------------------------------------------
// Adresse interne : bouclage, privée (RFC 1918, ULA), lien local, CGNAT, non spécifiée, multidiffusion, documentation.
export function adresseInterne(ip: string): boolean {
	const v = net.isIP(ip);
	if (v === 4) {
		const [a, b] = ip.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
	}
	if (v === 6) {
		// Forme développée en 8 groupes de 16 bits (une IPv4 en fin, « ::ffff:1.2.3.4 », compte pour 2 groupes).
		let x = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
		const v4 = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
		if (v4) { const o = v4[1].split(".").map(Number); x = x.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16); }
		const [tete, queue] = x.includes("::") ? x.split("::") : [x, null];
		const a = tete ? tete.split(":") : [], b = queue ? queue.split(":") : [];
		const g = (queue === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b]).map(h => parseInt(h || "0", 16));
		if (g.length !== 8 || g.some(n => Number.isNaN(n))) return true;
		const ipv4 = (h: number, l: number) => `${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`;
		if (g.slice(0, 7).every(n => n === 0) && g[7] <= 1) return true;                                   // :: et ::1
		if (g.slice(0, 5).every(n => n === 0) && (g[5] === 0xffff || g[5] === 0)) return adresseInterne(ipv4(g[6], g[7])); // ::ffff:a.b.c.d, ::a.b.c.d
		if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(n => n === 0)) return adresseInterne(ipv4(g[6], g[7])); // NAT64 64:ff9b::/96
		return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00 || g[0] === 0x2001 && g[1] === 0x0db8; // ULA, lien local, multidiffusion, documentation
	}
	return true;
}
// Contrôle de forme (à l'enregistrement) : https (http seulement avec WDD_NOTIF_LOCALES), pas d'identifiants, pas de nom
// interne évident ni d'adresse IP interne.
export function validerUrl(url: unknown, locales: boolean): string {
	if (typeof url !== "string" || !url || url.length > 2000 || /[\s\u0000-\u001f]/.test(url)) throw invalide("url : adresse du webhook attendue (2000 caractères au plus)");
	let u: URL;
	try { u = new URL(url); } catch { throw invalide("url : adresse invalide"); }
	if (u.protocol !== "https:" && !(locales && u.protocol === "http:")) throw invalide("url : https:// seulement (http et adresses internes : WDD_NOTIF_LOCALES=1 sur le serveur)");
	if (u.username || u.password) throw invalide("url : pas d'identifiants dans l'adresse");
	const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!locales && (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || !h.includes(".") && !net.isIP(h) || (net.isIP(h) && adresseInterne(h))))
		throw invalide("url : adresse interne refusée (WDD_NOTIF_LOCALES=1 sur le serveur pour l'autoriser)");
	return u.toString();
}
async function verifierResolution(url: string, locales: boolean): Promise<void> {
	if (locales) return;
	const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
	const ips = net.isIP(h) ? [h] : (await dns.promises.lookup(h, { all: true })).map(x => x.address);
	if (!ips.length || ips.some(adresseInterne)) throw new Error(`${h} mène à une adresse interne : envoi refusé`);
}

// --- Messages -----------------------------------------------------------------------------------------------------
const court = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
export function composer(titreProjet: string, lien: string, evts: Evenement[], contenu: string): string {
	const par = new Map<string, Evenement[]>();
	for (const e of evts) { if (!par.has(e.type)) par.set(e.type, []); par.get(e.type)!.push(e); }
	const n = (t: string) => (par.get(t) || []).length;
	const morceaux: string[] = [];
	if (n("retour")) morceaux.push(`${n("retour")} nouveau${n("retour") > 1 ? "x" : ""} retour${n("retour") > 1 ? "s" : ""}`);
	if (n("question")) morceaux.push(`${n("question")} question${n("question") > 1 ? "s" : ""} de l'agent`);
	if (n("revue")) morceaux.push(`${n("revue")} ticket${n("revue") > 1 ? "s" : ""} en revue`);
	for (const e of par.get("traitement") || []) morceaux.push(e.etat === "terminee" ? "traitement des retours terminé" : "traitement des retours échoué");
	for (const e of par.get("build") || []) morceaux.push(`Wiki publié (build n° ${e.build})`);
	let t = `${titreProjet} : ${morceaux.join(", ")}.\n${lien}`;
	if (contenu === "complet") {
		const lignes: string[] = [];
		for (const e of par.get("retour") || []) lignes.push(`• Retour sur ${court(e.nom, 60)} : ${court(e.texte, 200)}`);
		for (const e of par.get("question") || []) lignes.push(`• Question sur ${court(e.nom, 60)} : ${court(e.texte, 200)}`);
		for (const e of par.get("revue") || []) lignes.push(`• ${e.id} en revue : ${court(e.nom, 100)}`);
		if (lignes.length) t += "\n" + lignes.slice(0, 20).join("\n") + (lignes.length > 20 ? `\n… et ${lignes.length - 20} autres` : "");
	}
	return t.slice(0, 1900);
}
function corpsPour(format: string, texte: string, projet: string, evts: Evenement[], lien: string): string {
	if (format === "discord") return JSON.stringify({ content: texte, allowed_mentions: { parse: [] } });
	// Slack et Teams lisent < > & comme du balisage (<!channel>, <@U…>, HTML) : échappés, le texte reste du texte.
	if (format === "slack" || format === "teams") return JSON.stringify({ text: texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") });
	return JSON.stringify({ projet, lien, texte, evenements: evts.map(e => ({ type: e.type, quand: e.quand, ...(e.id ? { id: e.id } : {}), ...(e.etat ? { etat: e.etat } : {}), ...(e.build ? { build: e.build } : {}) })) });
}

// --- Notifieur ------------------------------------------------------------------------------------------------------
export class Notifieur {
	base: Base; depots: Map<string, Depot>; o: OptionsNotif; journal: (m: string) => void; lienDe: (projet: string) => string;
	etats = new Map<string, { retours: Map<string, string>; tickets: Map<string, string> }>();
	attente = new Map<string, Evenement[]>();
	minuteurs = new Map<string, NodeJS.Timeout>();
	resume: NodeJS.Timeout;
	envois = new Set<Promise<unknown>>();
	constructor(base: Base, depots: Map<string, Depot>, o: OptionsNotif, journal: (m: string) => void, lienDe: (projet: string) => string) {
		this.base = base; this.depots = depots; this.o = o; this.journal = journal; this.lienDe = lienDe;
		base.db.exec(`CREATE TABLE IF NOT EXISTS notifications (projet TEXT PRIMARY KEY, url TEXT NOT NULL, format TEXT NOT NULL, contenu TEXT NOT NULL,
			evenements TEXT NOT NULL, rythme TEXT NOT NULL, actif INTEGER NOT NULL, secret TEXT NOT NULL, modifie TEXT NOT NULL, dernier TEXT, dernier_resume TEXT NOT NULL DEFAULT '')`);
		// État de départ de chaque projet chargé : seuls les changements à venir sont notifiés.
		for (const [p, d] of depots) this.etats.set(p, this.etatDe(d));
		// Résumés quotidiens : vérifiés toutes les 10 min (et à la demande des tests, envoyerResumes()).
		this.resume = setInterval(() => { this.envoyerResumes(false); }, 10 * 60 * 1000); this.resume.unref();
	}
	etatDe(d: Depot) {
		return {
			retours: new Map([...d.index].map(([id, x]) => [id, String(x.donnees.status)])),
			tickets: new Map([...d.tickets].filter(([, t]) => !estIllisible(t)).map(([id, t]) => [id, String((t as { donnees: { statut: string } }).donnees.statut)])),
		};
	}
	reglage(projet: string): Reglage | null {
		const r = this.base.db.prepare("SELECT * FROM notifications WHERE projet = ?").get(projet) as Record<string, unknown> | undefined;
		if (!r) return null;
		return { projet, url: String(r.url), format: String(r.format), contenu: String(r.contenu), evenements: JSON.parse(String(r.evenements)), rythme: String(r.rythme), actif: r.actif === 1, secret: String(r.secret),
			dernier: r.dernier ? JSON.parse(String(r.dernier)) : null, dernier_resume: String(r.dernier_resume || "") };
	}
	// Observation du flux (Flux.observateur) ; jamais d'exception vers l'appelant.
	observer(type: string, projet: string, corps: unknown): void {
		try {
			let etat = this.etats.get(projet);
			if (!etat) this.etats.set(projet, etat = { retours: new Map(), tickets: new Map() });
			const quand = new Date().toISOString();
			const evts: Evenement[] = [];
			const docs = (corps as { docs?: { id: string; donnees?: Record<string, unknown>; illisible?: boolean }[] })?.docs;
			if (type === "instantane" && Array.isArray(docs)) {
				const vus = new Map<string, string>();
				for (const d of docs) {
					const s = String(d.donnees?.status ?? ""), avant = etat.retours.get(d.id);
					vus.set(d.id, s);
					if (avant === undefined && s === "nouveau") evts.push({ type: "retour", quand, nom: String(d.donnees?.name || d.donnees?.ref || ""), texte: String(d.donnees?.text || "") });
					else if (s === "question" && avant !== "question") evts.push({ type: "question", quand, nom: String(d.donnees?.name || d.donnees?.ref || ""), texte: String(d.donnees?.reply || "") });
				}
				etat.retours = vus;
			} else if (type === "tickets" && Array.isArray(docs)) {
				const vus = new Map<string, string>();
				for (const d of docs) {
					if (d.illisible) continue;
					const s = String(d.donnees?.statut ?? ""), avant = etat.tickets.get(d.id);
					vus.set(d.id, s);
					if (s === "en-revue" && avant !== "en-revue") evts.push({ type: "revue", quand, id: d.id, nom: String(d.donnees?.titre || "") });
				}
				etat.tickets = vus;
			} else if (type === "demandes") {
				const c = corps as { id?: string; etat?: string };
				if (c && (c.etat === "terminee" || c.etat === "echouee")) evts.push({ type: "traitement", quand, id: String(c.id || ""), etat: c.etat });
			}
			if (evts.length) this.ajouter(projet, evts);
		} catch (e) { this.journal(`notifications : observation ignorée (${(e as Error).message})`); }
	}
	build(projet: string, n: number): void { this.ajouter(projet, [{ type: "build", quand: new Date().toISOString(), build: n }]); }
	ajouter(projet: string, evts: Evenement[]): void {
		const r = this.reglage(projet);
		if (!r || !r.actif) return;
		const gardes = evts.filter(e => r.evenements.includes(e.type));
		if (!gardes.length) return;
		const l = this.attente.get(projet) || [];
		l.push(...gardes);
		this.attente.set(projet, l.slice(-500));
		if (r.rythme === "chaque" && !this.minuteurs.has(projet)) {
			const t = setTimeout(() => { this.minuteurs.delete(projet); this.vider(projet); }, this.o.regroupementMs);
			t.unref(); this.minuteurs.set(projet, t);
		}
	}
	// Résumés quotidiens : un par projet en « quotidien » dont le dernier a plus de 24 h (ou tous, forcer).
	envoyerResumes(forcer: boolean): void {
		for (const [projet, l] of this.attente) {
			const r = this.reglage(projet);
			if (!r || r.rythme !== "quotidien" || !l.length) continue;
			if (!forcer && r.dernier_resume && Date.now() - Date.parse(r.dernier_resume) < 24 * 3600 * 1000) continue;
			this.base.db.prepare("UPDATE notifications SET dernier_resume = ? WHERE projet = ?").run(new Date().toISOString(), projet);
			this.vider(projet);
		}
	}
	vider(projet: string): void {
		const evts = this.attente.get(projet) || [];
		this.attente.delete(projet);
		const r = this.reglage(projet);
		if (!r || !r.actif || !evts.length) return;
		const titre = this.base.projet(projet)?.titre || projet;
		const lien = this.lienDe(projet);
		const p = this.envoyer(r, composer(titre, lien, evts, r.contenu), evts, lien).catch(() => { });
		this.envois.add(p); p.finally(() => this.envois.delete(p));
	}
	async envoyer(r: Reglage, texte: string, evts: Evenement[], lien: string): Promise<{ ok: boolean; message: string }> {
		const corps = corpsPour(r.format, texte, r.projet, evts, lien);
		const signature = "sha256=" + crypto.createHmac("sha256", r.secret).update(corps).digest("hex");
		let message = "";
		for (let i = 0; i <= this.o.essaiMs.length; i++) {
			if (i) await new Promise(res => setTimeout(res, this.o.essaiMs[i - 1]));
			try {
				await verifierResolution(r.url, this.o.locales);
				const rep = await fetch(r.url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.o.delaiMs),
					headers: { "Content-Type": "application/json", "User-Agent": "Vaevia-notifications", "X-WDD-Signature": signature, "X-WDD-Evenement": [...new Set(evts.map(e => e.type))].join(",") }, body: corps });
				if (rep.ok) { message = `HTTP ${rep.status}`; this.noter(r.projet, true, message); return { ok: true, message }; }
				message = `HTTP ${rep.status}`;
				if (rep.status >= 400 && rep.status < 500 && rep.status !== 429) break; // refus définitif : pas de nouvel essai
			} catch (e) { message = court((e as Error).message, 200); if (/adresse interne/.test(message)) break; }
		}
		this.noter(r.projet, false, message);
		this.journal(`notifications du projet ${r.projet} : envoi échoué (${message})`);
		return { ok: false, message };
	}
	noter(projet: string, ok: boolean, message: string): void {
		try { this.base.db.prepare("UPDATE notifications SET dernier = ? WHERE projet = ?").run(JSON.stringify({ quand: new Date().toISOString(), ok, message }), projet); } catch { }
	}
	async fermer(): Promise<void> {
		clearInterval(this.resume);
		for (const t of this.minuteurs.values()) clearTimeout(t);
		this.minuteurs.clear();
		await Promise.race([Promise.all([...this.envois]), new Promise(r => setTimeout(r, 2000))]);
	}
}

// --- Routes : /api/p/<projet>/notifications (mainteneur ou admin, en session) --------------------------------------
type Ctx = { base: Base; notifieur: Notifieur; config: { notifLocales: boolean } };
export function etatPublic(r: Reglage | null) {
	if (!r) return { configure: false };
	let hote = "", origine = ""; try { const u = new URL(r.url); hote = u.host; origine = u.origin; } catch { hote = ""; }
	return { configure: true, actif: r.actif, hote, origine, format: r.format, contenu: r.contenu, evenements: r.evenements, rythme: r.rythme, dernier: r.dernier };
}
export async function routeNotifications(ctx: Ctx, req: IncomingMessage, res: ServerResponse, projet: string, id: Identite, a: Acteur, seg: string[], m: string,
	outils: { json: (res: ServerResponse, s: number, c: unknown) => void; lireJson: (req: IncomingMessage) => Promise<unknown>; corpsVide: (req: IncomingMessage) => Promise<void>; trace: (action: string, detail?: unknown) => void }): Promise<boolean> {
	if (seg[0] !== "notifications") return false;
	if (id.type !== "compte") throw refuse("réservé aux sessions de la méta-interface (un jeton ne règle pas les notifications)");
	if (a.role !== "mainteneur" && a.role !== "admin") throw refuse("réservé aux mainteneurs du projet et aux admins");
	const n = ctx.notifieur;
	if (seg.length === 1 && m === "GET") { outils.json(res, 200, etatPublic(n.reglage(projet))); return true; }
	if (seg.length === 1 && m === "PUT") {
		const c = await outils.lireJson(req) as Record<string, unknown>;
		if (!c || typeof c !== "object" || Array.isArray(c)) throw invalide("objet attendu");
		for (const k of Object.keys(c)) if (!["url", "format", "contenu", "evenements", "rythme", "actif", "nouveau_secret"].includes(k)) throw invalide(`clé inconnue : ${k}`);
		const avant = n.reglage(projet);
		const url = c.url === undefined || c.url === "" ? (avant ? avant.url : (() => { throw invalide("url : adresse du webhook attendue"); })()) : validerUrl(c.url, ctx.config.notifLocales);
		const format = c.format ?? avant?.format ?? "json";
		if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) throw invalide(`format : ${FORMATS.join(", ")}`);
		const contenu = c.contenu ?? avant?.contenu ?? "titre";
		if (contenu !== "titre" && contenu !== "complet") throw invalide("contenu : titre ou complet");
		const evenements = c.evenements ?? avant?.evenements ?? [...EVENEMENTS];
		if (!Array.isArray(evenements) || !evenements.length || !evenements.every(e => typeof e === "string" && (EVENEMENTS as readonly string[]).includes(e))) throw invalide(`evenements : liste non vide parmi ${EVENEMENTS.join(", ")}`);
		const rythme = c.rythme ?? avant?.rythme ?? "chaque";
		if (rythme !== "chaque" && rythme !== "quotidien") throw invalide("rythme : chaque ou quotidien");
		const actif = c.actif ?? avant?.actif ?? true;
		if (typeof actif !== "boolean") throw invalide("actif : booléen");
		const nouveau = !avant || c.nouveau_secret === true;
		const secret = nouveau ? crypto.randomBytes(32).toString("base64url") : avant!.secret;
		ctx.base.db.prepare(`INSERT INTO notifications (projet, url, format, contenu, evenements, rythme, actif, secret, modifie) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (projet) DO UPDATE SET url = excluded.url, format = excluded.format, contenu = excluded.contenu, evenements = excluded.evenements, rythme = excluded.rythme, actif = excluded.actif, secret = excluded.secret, modifie = excluded.modifie`)
			.run(projet, url, format, contenu, JSON.stringify([...new Set(evenements as string[])]), rythme, actif ? 1 : 0, secret, new Date().toISOString());
		outils.trace("notifications réglées", { hote: new URL(url).host, format, contenu, evenements, rythme, actif, ...(nouveau ? { secret: "nouveau" } : {}) });
		// Le secret de signature (X-WDD-Signature) n'est montré qu'à sa création.
		outils.json(res, 200, { ...etatPublic(n.reglage(projet)), ...(nouveau ? { secret } : {}) });
		return true;
	}
	if (seg.length === 1 && m === "DELETE") {
		if (!n.reglage(projet)) throw absent("aucune notification réglée");
		ctx.base.db.prepare("DELETE FROM notifications WHERE projet = ?").run(projet);
		n.attente.delete(projet);
		outils.trace("notifications retirées");
		outils.json(res, 204, null);
		return true;
	}
	if (seg.length === 2 && seg[1] === "essai" && m === "POST") {
		await outils.corpsVide(req);
		const r = n.reglage(projet);
		if (!r) throw absent("aucune notification réglée");
		const titre = ctx.base.projet(projet)?.titre || projet;
		const lien = n.lienDe(projet);
		const resultat = await n.envoyer({ ...r, actif: true }, `${titre} : essai de notification.\n${lien}`, [], lien);
		outils.json(res, 200, resultat);
		return true;
	}
	throw absent("route inconnue");
}
export { ErreurApi };
