// Méta-interface (docs/etape3-meta-interface.md § 4) : fichiers statiques de serveur/ui/ (WDD_UI), servis sous « / » sur
// l'hôte principal seulement. index.html pour « / » ; les autres fichiers par leur chemin (/app.js, /css/x.css…).
// - Liste blanche d'extensions (types MIME fixés) ; tout autre fichier → 404.
// - Pas de traversée : chaque segment est un nom simple ([A-Za-z0-9_-] puis [A-Za-z0-9._-], ni « . » en tête ni
//   barre), le chemin réel doit rester dans le dossier de l'interface (liens symboliques compris) ; le dossier tests/
//   n'est jamais servi.
// - CSP stricte : script-src 'self', aucun script en ligne, aucune ressource externe ; styles depuis 'self' seulement
//   (pas d'attribut style= dans le HTML ; element.style en JS reste permis).
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";

export const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};
export const CSP_UI = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,100}$/;

// Chemin réel d'un fichier servable, ou null.
export function fichierUi(config: Config, segments: string[]): string | null {
	if (!segments.length || segments.length > 6) return null;
	if (!segments.every(s => SEGMENT.test(s))) return null;
	// Sans casse : sous Windows et macOS, /Tests/… ouvrirait le même dossier.
	if (segments[0].toLowerCase() === "tests") return null;
	const ext = path.extname(segments[segments.length - 1]).toLowerCase();
	if (!TYPES[ext]) return null;
	let racine: string;
	try { racine = fs.realpathSync.native(config.ui); } catch { return null; }
	const p = path.join(racine, ...segments);
	let reel: string;
	try { reel = fs.realpathSync.native(p); } catch { return null; }
	const rel = path.relative(racine, reel);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	// Le chemin réel aussi (un lien symbolique vers tests/, une autre casse).
	if (rel.split(path.sep)[0].toLowerCase() === "tests") return null;
	try { if (!fs.statSync(reel).isFile()) return null; } catch { return null; }
	return reel;
}

export const uiPresente = (config: Config, nom = "index.html"): boolean => fichierUi(config, [nom]) !== null;

function envoyer(res: ServerResponse, fichier: string): void {
	const corps = fs.readFileSync(fichier);
	res.writeHead(200, {
		"Content-Type": TYPES[path.extname(fichier).toLowerCase()],
		"Content-Length": corps.length,
		"Content-Security-Policy": CSP_UI,
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Referrer-Policy": "same-origin",
		// private : jamais gardé par un cache partagé, la réponse peut porter le cookie de session prolongé (http.ts).
		"Cache-Control": "private, no-cache",
	});
	res.end(corps);
}

// « / » : index.html de l'interface ; rend faux si l'interface est absente (la page d'accueil de l'étape 1 répond).
export function servirIndex(config: Config, res: ServerResponse): boolean {
	const f = fichierUi(config, ["index.html"]);
	if (!f) return false;
	envoyer(res, f);
	return true;
}

// Un fichier de l'interface ; rend faux s'il n'est pas servable (404 par l'appelant).
export function servirStatique(config: Config, res: ServerResponse, segments: string[]): boolean {
	const f = fichierUi(config, segments);
	if (!f) return false;
	envoyer(res, f);
	return true;
}
