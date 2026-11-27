// Appels à l'API du serveur (même origine). Toute écriture envoie X-WDD: 1 (anti-CSRF) et un corps JSON.
// Une erreur rend une ErreurApi avec le statut HTTP, le code et le message du serveur (CONTRAT.md § 6).

export class ErreurApi extends Error {
	constructor(statut, corps) {
		super((corps && typeof corps.message === "string" && corps.message) || messageParDefaut(statut));
		this.statut = statut;
		this.code = (corps && corps.code) || "";
		this.corps = corps || {};
	}
}

function messageParDefaut(statut) {
	if (statut === 0) return "Serveur injoignable. Vérifie ta connexion.";
	if (statut === 401) return "Session expirée : demande un lien de reconnexion à un mainteneur du projet.";
	if (statut === 403) return "Action refusée.";
	if (statut === 404) return "Introuvable.";
	if (statut === 409) return "Quelqu'un a modifié ce ticket entre-temps.";
	return "Erreur du serveur (" + statut + ").";
}

export async function api(methode, chemin, corps) {
	const entetes = {};
	if (methode !== "GET") entetes["X-WDD"] = "1";
	if (corps !== undefined) entetes["Content-Type"] = "application/json";
	let r;
	try {
		r = await fetch(chemin, { method: methode, headers: entetes, credentials: "same-origin", cache: "no-store", body: corps === undefined ? undefined : JSON.stringify(corps) });
	} catch {
		throw new ErreurApi(0, null);
	}
	if (r.status === 204) return null;
	const texte = await r.text();
	let json = null;
	if (texte) { try { json = JSON.parse(texte); } catch { json = null; } }
	if (!r.ok) throw new ErreurApi(r.status, json);
	return json;
}

export const lire = chemin => api("GET", chemin);
export const ecrire = (methode, chemin, corps) => api(methode, chemin, corps);
// Segment d'URL sûr (id de projet, de ticket, de compte…).
export const seg = s => encodeURIComponent(String(s));
