// Clone en lecture seule du dépôt de design (étape 3.9, A6 ; docs/etape3-9-sections-1-a-6.md, lot 5).
//   git clone http://<serveur>/git/<projet>.git      (mot de passe : un jeton « clone » du projet ; utilisateur : libre)
// Protocole Git « smart HTTP » par git http-backend (déjà livré avec Git), en lecture seule : seules les deux routes de
// git-upload-pack (clone, fetch) sont servies ; git-receive-pack (push) n'a aucune route, et le serveur reste le seul
// écrivain du dépôt. Authentification : un jeton de rôle « clone » du projet, en mot de passe HTTP (Basic) ou en Bearer ;
// sans lui, 401 avec WWW-Authenticate pour que Git le demande. Hôte principal seulement. Le dépôt contient les ids des
// auteurs de retours (pas leurs e-mails) : un jeton « clone » se donne comme un accès en lecture au projet.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Base } from "./base.ts";
import type { Depot } from "./depot.ts";

const ROUTE = /^\/git\/([a-z0-9-]{1,40})\.git\/(info\/refs|git-upload-pack)$/;
const MAX_CORPS_GIT = 64 * 1024 * 1024;

function jetonDe(req: IncomingMessage): string {
	const a = String(req.headers.authorization || "");
	const b = /^Bearer\s+(\S+)$/i.exec(a);
	if (b) return b[1];
	const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(a);
	if (!m) return "";
	const t = Buffer.from(m[1], "base64").toString("utf8");
	return t.slice(t.indexOf(":") + 1);
}
const refuser = (res: ServerResponse, statut: number, message: string) => {
	res.writeHead(statut, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(statut === 401 ? { "WWW-Authenticate": 'Basic realm="depot de design (jeton clone)", charset="UTF-8"' } : {}) });
	res.end(message + "\n");
};

// Rend vrai si la requête était une route Git (traitée), faux sinon.
export async function servirGit(req: IncomingMessage, res: ServerResponse, chemin: string, query: string, base: Base, depots: Map<string, Depot>, journal: (m: string) => void): Promise<boolean> {
	if (!chemin.startsWith("/git/")) return false;
	const m = ROUTE.exec(chemin);
	const methode = req.method || "GET";
	if (!m) { req.resume(); refuser(res, 404, "introuvable (git clone <serveur>/git/<projet>.git ; lecture seule, pas de push)"); return true; }
	const [, projet, quoi] = m;
	if (quoi === "info/refs" ? methode !== "GET" : methode !== "POST") { req.resume(); refuser(res, 405, "méthode non permise"); return true; }
	if (quoi === "info/refs" && !/^service=git-upload-pack$/.test(query)) { req.resume(); refuser(res, 403, "lecture seule : seul git-upload-pack (clone, fetch) est servi"); return true; }
	const j = base.jeton(jetonDe(req) || "-");
	if (!j || j.role !== "clone" || j.projet !== projet) { req.resume(); refuser(res, 401, "jeton « clone » du projet requis (mot de passe HTTP)"); return true; }
	const depot = depots.get(projet);
	if (!depot) { req.resume(); refuser(res, 404, "projet introuvable"); return true; }
	const env: NodeJS.ProcessEnv = { ...depot.envGit, GIT_PROJECT_ROOT: depot.dossier, PATH_INFO: "/.git/" + quoi, GIT_HTTP_EXPORT_ALL: "1",
		REQUEST_METHOD: methode, QUERY_STRING: query, CONTENT_TYPE: String(req.headers["content-type"] || ""), REMOTE_USER: "clone:" + j.id,
		GIT_HTTP_MAX_REQUEST_BUFFER: String(MAX_CORPS_GIT), ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}) };
	await new Promise<void>(fin => {
		const p = spawn("git", ["-c", "http.receivepack=false", "-c", "uploadpack.allowFilter=true", "http-backend"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let entetes = Buffer.alloc(0), envoye = false, recu = 0, erreurs = "";
		p.stderr.on("data", b => { erreurs = (erreurs + b).slice(-2000); });
		p.stdout.on("data", (b: Buffer) => {
			if (envoye) { res.write(b); return; }
			entetes = Buffer.concat([entetes, b]);
			const i = entetes.indexOf("\r\n\r\n");
			if (i < 0) return;
			const h: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
			let statut = 200;
			for (const l of entetes.subarray(0, i).toString("latin1").split("\r\n")) {
				const k = l.indexOf(":"); if (k < 0) continue;
				const n = l.slice(0, k).trim(), v = l.slice(k + 1).trim();
				if (/^status$/i.test(n)) statut = Number(v.split(" ")[0]) || 200; else if (!/^(set-cookie|cache-control|expires|pragma)$/i.test(n)) h[n] = v;
			}
			res.writeHead(statut, h);
			envoye = true;
			const reste = entetes.subarray(i + 4); if (reste.length) res.write(reste);
		});
		p.on("error", e => { journal(`git http-backend : ${e.message}`); if (!envoye) refuser(res, 503, "git indisponible sur le serveur"); else res.end(); fin(); });
		p.on("close", code => { if (!envoye) refuser(res, 500, "réponse de git vide"); else res.end(); if (code) journal(`git http-backend (${projet}) : code ${code} ${erreurs.replace(/\s+/g, " ").slice(0, 300)}`); fin(); });
		req.on("data", (b: Buffer) => { recu += b.length; if (recu > MAX_CORPS_GIT) { req.destroy(); p.kill(); return; } p.stdin.write(b); });
		req.on("end", () => p.stdin.end());
		req.on("error", () => p.kill());
	});
	journal(`git ${quoi === "info/refs" ? "info/refs" : "upload-pack"} : ${projet} par le jeton ${j.nom}`);
	return true;
}
