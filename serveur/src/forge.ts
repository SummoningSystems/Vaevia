// Webhook entrant de la forge (étape 3.9, I3 ; docs/etape3-9-sections-1-a-6.md, lot 5). La forge du code (GitHub, Gitea
// ou Forgejo, GitLab) envoie ses « push » à POST /api/forge/<projet> ; un « T-12 » dans le message d'un commit attache ce
// commit au ticket T-12 (même écriture que « outil tickets commit »). Rien n'est jamais fermé ni passé en revue : la
// fermeture reste un geste humain, et « fixes T-12 » ne fait rien de plus qu'« T-12 ». Le message est une donnée.
// Authentification : un secret par projet, tiré par le serveur, montré une fois à sa création. GitHub : en-tête
// X-Hub-Signature-256 (HMAC-SHA256 du corps) ; Gitea, Forgejo : X-Gitea-Signature, X-Forgejo-Signature (même HMAC, hex) ;
// GitLab : X-Gitlab-Token (le secret lui-même). Comparaisons à temps constant. Table « forges » de outil.sqlite (hors de
// Git : un secret n'entre jamais dans le dépôt de design).
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Base } from "./base.ts";
import type { Depot } from "./depot.ts";
import type { Acteur } from "./retours.ts";
import { ErreurApi, invalide, absent, refuse } from "./retours.ts";
import { ajouterCommits } from "./tickets.ts";
import type { ContexteTickets } from "./tickets.ts";
import { ligne } from "./depot.ts";

export const MAX_CORPS_FORGE = 2 * 1024 * 1024;
const MAX_TICKETS_PAR_ENVOI = 50;
// L'auteur des écritures faites pour la forge : un mainteneur sans compte (le dépôt dit « Forge »).
export const ACTEUR_FORGE: Acteur = { id: "forge", nom: "Forge", role: "mainteneur", email: "forge@outil.invalid", agent: false };

export function etatForge(base: Base, projet: string): { actif: boolean; cree?: string; dernier?: string | null; dernier_resultat?: string } {
	const r = base.db.prepare("SELECT cree, dernier, dernier_resultat FROM forges WHERE projet = ?").get(projet) as { cree: string; dernier: string | null; dernier_resultat: string } | undefined;
	return r ? { actif: true, cree: r.cree, dernier: r.dernier, dernier_resultat: r.dernier_resultat } : { actif: false };
}
// Nouveau secret (création ou remplacement) : rendu une seule fois.
export function nouveauSecretForge(base: Base, projet: string): string {
	const secret = crypto.randomBytes(24).toString("base64url");
	base.db.prepare("INSERT INTO forges (projet, secret, cree) VALUES (?, ?, ?) ON CONFLICT (projet) DO UPDATE SET secret = excluded.secret, cree = excluded.cree, dernier = NULL, dernier_resultat = ''")
		.run(projet, secret, new Date().toISOString());
	return secret;
}
export const retirerForge = (base: Base, projet: string): boolean => Number(base.db.prepare("DELETE FROM forges WHERE projet = ?").run(projet).changes) > 0;

const egal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export function signatureValide(secret: string, corps: Buffer, entetes: IncomingMessage["headers"]): boolean {
	const hmac = crypto.createHmac("sha256", secret).update(corps).digest("hex");
	const gh = String(entetes["x-hub-signature-256"] || "");
	if (gh && egal(gh, "sha256=" + hmac)) return true;
	for (const h of ["x-gitea-signature", "x-forgejo-signature"]) { const v = String(entetes[h] || ""); if (v && egal(v.toLowerCase(), hmac)) return true; }
	const gl = String(entetes["x-gitlab-token"] || "");
	return !!gl && egal(gl, secret);
}

// Commits d'un « push » des trois forges : id, première ligne du message, nom du dépôt.
export function commitsDuPush(o: any): { hash: string; message: string; depot: string }[] {
	if (!o || typeof o !== "object" || !Array.isArray(o.commits)) return [];
	const brut = String(o.repository?.name || o.project?.path || o.project?.name || "code");
	const depot = brut.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "code";
	return o.commits.filter((c: any) => c && typeof c.id === "string" && /^[0-9a-f]{7,40}$/i.test(c.id))
		.map((c: any) => ({ hash: c.id.toLowerCase(), depot, message: ligne(String(c.message || "").split(/\r?\n/)[0], 200) }));
}
export const ticketsCites = (message: string): string[] => [...new Set([...message.matchAll(/\bT-([1-9]\d{0,8})\b/g)].map(m => "T-" + m[1]))];

// Reçoit un envoi : vérifie la signature, attache les commits aux tickets cités qui existent. Rend { tickets: { T-n: ajoutés } }.
export async function recevoirForge(base: Base, depot: Depot, projet: string, corps: Buffer, entetes: IncomingMessage["headers"], ctxTickets: (a: Acteur) => ContexteTickets, journal: (m: string) => void): Promise<{ statut: number; corps: Record<string, unknown> }> {
	const r = base.db.prepare("SELECT secret FROM forges WHERE projet = ?").get(projet) as { secret: string } | undefined;
	if (!r || !signatureValide(r.secret, corps, entetes)) return { statut: 401, corps: { code: "revoked", message: "signature absente ou invalide (secret du webhook de la forge)" } };
	const evenement = String(entetes["x-github-event"] || entetes["x-gitea-event"] || entetes["x-forgejo-event"] || entetes["x-gitlab-event"] || "");
	if (/^ping$/i.test(evenement)) return { statut: 200, corps: { pong: true } };
	let o: unknown;
	try { o = JSON.parse(corps.toString("utf8")); } catch { throw invalide("corps : JSON attendu"); }
	const commits = commitsDuPush(o);
	const parTicket = new Map<string, { hash: string; message: string; depot: string }[]>();
	for (const c of commits) for (const t of ticketsCites(c.message)) if (depot.tickets.has(t)) parTicket.set(t, [...(parTicket.get(t) || []), c]);
	const res: Record<string, number> = {};
	for (const [t, l] of [...parTicket].slice(0, MAX_TICKETS_PAR_ENVOI)) {
		for (let essai = 0; essai < 2; essai++) {
			const e = depot.tickets.get(t);
			if (!e || !("donnees" in e)) break;
			try { const x = await ajouterCommits(ctxTickets(ACTEUR_FORGE), t, { version: e.version, commits: l.slice(0, 50) }); res[t] = x.ajoutes; break; }
			catch (err) { if (!(err instanceof ErreurApi && err.statut === 409) || essai) { res[t] = -1; journal(`forge ${projet} : ${t} non mis à jour (${(err as Error).message})`); break; } }
		}
	}
	const resume = commits.length ? `${commits.length} commit(s), tickets : ${Object.entries(res).map(([t, n]) => `${t} ${n < 0 ? "échec" : "+" + n}`).join(", ") || "aucun cité"}` : `événement ${evenement || "?"} sans commit`;
	base.db.prepare("UPDATE forges SET dernier = ?, dernier_resultat = ? WHERE projet = ?").run(new Date().toISOString(), resume.slice(0, 300), projet);
	if (Object.keys(res).length) base.journaliser({ qui: ACTEUR_FORGE.id, action: "commits de la forge", projet, cible: Object.keys(res).join(" "), detail: res });
	return { statut: 200, corps: { tickets: res } };
}

// Réglage (mainteneur, en session) : GET l'état ; POST crée ou remplace le secret (montré une fois) ; DELETE retire.
export function routeConfigForge(base: Base, a: Acteur, projet: string, m: string, urlPublique: string): { statut: number; corps?: unknown } {
	if (a.agent) throw refuse("réservé aux sessions (mainteneur)");
	if (a.role !== "mainteneur" && a.role !== "admin") throw refuse("seul un mainteneur règle le webhook de la forge");
	const url = `${urlPublique}/api/forge/${projet}`;
	if (m === "GET") return { statut: 200, corps: { ...etatForge(base, projet), url } };
	if (m === "POST") { const secret = nouveauSecretForge(base, projet); base.journaliser({ qui: a.id, action: "webhook de la forge (secret)", projet, cible: projet }); return { statut: 201, corps: { url, secret, ...etatForge(base, projet) } }; }
	if (m === "DELETE") { if (!retirerForge(base, projet)) throw absent("aucun webhook de la forge"); base.journaliser({ qui: a.id, action: "webhook de la forge retiré", projet, cible: projet }); return { statut: 204 }; }
	throw absent("route inconnue");
}
export type { ServerResponse };
