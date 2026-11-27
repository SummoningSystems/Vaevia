// Bandeau commun du Wiki (docs/etape3-6-wiki-ui.md § A.2) : quand le serveur sert le Wiki d'un projet (page construite
// ou « pas encore publié »), il insère en tête de <body> un bandeau qui reprend celui de la méta-interface : marque,
// nom du projet, onglets Wiki · Retours · Kanban · Membres, nom de la personne.
// - Rendu par le serveur, dans la page servie : pas de cadre (iframe), aucune route nouvelle sur l'hôte des pages.
// - Les onglets autres que Wiki sont des liens vers la méta-interface de l'hôte principal, toujours vers une route du
//   fragment (/#/…) : arrivé d'un autre site (hôte des pages), le document « / » part sans wdd_session (SameSite=Strict),
//   mais c'est un fichier statique, et les requêtes de l'interface qui suivent portent le cookie. Avec WDD_URL_PAGES,
//   adresse absolue (WDD_URL) ; sans, relative (« / »), car tout Host est accepté et WDD_URL peut nommer un autre hôte
//   que celui de la session.
// - Tout est échappé ; aucun script (la CSP de la page n'autorise un <script> en ligne que par empreinte) ; un <style>
//   en ligne (style-src 'unsafe-inline' dans la CSP des pages), classes préfixées wdd-b pour ne rencontrer ni les règles
//   du gabarit ni les sélecteurs des scénarios (#fb-…, .fb-btn, [data-goto]…). Dans le flux normal (ni fixe ni collant) :
//   le tiroir des retours, les ancres et le retour en haut du gabarit restent tels quels.
import type { Role, RoleJeton } from "./base.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export type InfoBandeau = {
	projet: string;          // id du projet (ID_PROJET)
	titre: string;           // titre du projet
	nom: string;             // nom de la personne (ou de l'agent)
	role: Role | RoleJeton;  // rôle sur le projet
	agent: boolean;          // jeton Bearer (un seul hôte) : pas d'onglet Membres ni d'Administration
	testeur?: boolean;       // étape 3.9, E2 : testeur externe : le Wiki seul (ni Retours, ni Kanban, ni compteurs)
	base: string;            // origine de l'hôte principal (WDD_URL avec WDD_URL_PAGES), sinon ""
	// Compteurs des onglets, comme dans la méta-interface (serveur/ui/ui.js, compterNavProjet) : retours à traiter (en
	// attente + questions, ce que compte aussi le bouton flottant du Wiki), dont questions, et tickets à faire. Lus au
	// moment de servir la page ; ensuite, le module retours du Wiki (site/retours/retours.js, fbRefreshFab) tient celui
	// des retours à jour en direct (celui des tickets reste celui du chargement). Absents ou nuls : pas de pastille.
	retours?: number;
	questions?: number;
	aFaire?: number;
};

// Couleurs et mesures de la méta-interface (serveur/ui/ui.css, direction « Studio », étape 3.10), sous des noms propres
// au bandeau (--wb-…) pour ne pas toucher aux jetons du gabarit (--bg, --text…). Même dessin que la barre .entete : une
// barre d'encre d'une ligne de 44 px dès 48 rem (marque, Administration, projet et onglets, nom à droite), deux lignes en
// dessous (le projet et ses onglets dessous, sur l'encre aussi) ; gouttière 16 px (24 px dès 64 rem) qui suit le bord du
// contenu au-delà de 1280 px (.wrap du gabarit, main de la méta-interface) ; onglet courant souligné de 3 px (indigo
// clair) ; focus orange de 3 px (lisible sur l'encre). L'ordre du DOM ne change pas (order). Titres en Bahnschrift.
// Thème : celui du gabarit (prefers-color-scheme, ou data-theme posé sur <html>), pour que bandeau et page ne divergent
// jamais : encre #1c1f3a en clair, #0b0d1c en sombre. Ni url(), ni @import, ni attribut style : la marque est un SVG en ligne.
const CLAIR = "--wb-barre:#1c1f3a;--wb-texte:#eef0fb;--wb-doux:#b4b8d6;--wb-bord:#3a4070;--wb-survol:#2b2f55;--wb-pastille:#363c68;--wb-actif:#a197ff;--wb-focus:#ff9d4d;--wb-alerte:#ffc46b;--wb-marque:#7b6cf6;";
const SOMBRE = "--wb-barre:#0b0d1c;--wb-texte:#eef0fb;--wb-doux:#a9add0;--wb-bord:#2a2f52;--wb-survol:#1d2140;--wb-pastille:#2a2f52;--wb-actif:#a197ff;--wb-focus:#ff9d4d;--wb-alerte:#ffc46b;--wb-marque:#7b6cf6;";
const POLICE = `"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif`;
const POLICE_TITRES = `Bahnschrift,"DIN Alternate","Barlow Semi Condensed","Roboto Condensed","Segoe UI",system-ui,sans-serif`;
const SEPARATEUR = `content:"";width:1px;height:20px;background:var(--wb-bord);flex:none`;
export const STYLE_BANDEAU = [
	`.wdd-bandeau{${CLAIR}--wb-gouttiere:16px;display:block;margin:0;padding:0 max(var(--wb-gouttiere),env(safe-area-inset-right,0px),calc((100% - 1280px) / 2 + var(--wb-gouttiere))) 0 max(var(--wb-gouttiere),env(safe-area-inset-left,0px),calc((100% - 1280px) / 2 + var(--wb-gouttiere)));background:var(--wb-barre);color:var(--wb-texte);border-bottom:1px solid var(--wb-bord);font:14px/1.45 ${POLICE};overflow-wrap:anywhere;box-sizing:border-box;text-align:left}`,
	`@media (min-width:64rem){.wdd-bandeau{--wb-gouttiere:24px}}`,
	`@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .wdd-bandeau{${SOMBRE}}}`,
	`:root[data-theme="dark"] .wdd-bandeau{${SOMBRE}}`,
	// Étape 3.9, L3 : avis « Ancienne version » sous le bandeau d'un build ancien (l'ambre de « En attente »).
	`.wdd-ancienne{margin:0;padding:8px max(16px,calc((100% - 1280px) / 2 + 16px));background:#fdeccc;color:#5c3300;border-bottom:1px solid #e9c27a;font:14px/1.45 ${POLICE}}`,
	`.wdd-ancienne a{color:inherit;font-weight:600}`,
	`@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .wdd-ancienne{background:#3d2c10;color:#ffd9a0;border-color:#6b4d1c}}`,
	`:root[data-theme="dark"] .wdd-ancienne{background:#3d2c10;color:#ffd9a0;border-color:#6b4d1c}`,
	`@media print{.wdd-ancienne{display:none}}`,
	`.wdd-bandeau *{box-sizing:border-box}`,
	`.wdd-bandeau .wdd-b-ligne{display:flex;flex-wrap:wrap;align-items:center;gap:0 4px;min-height:44px;min-width:0}`,
	`.wdd-bandeau .wdd-b-projet{align-items:stretch;min-height:40px;border-top:1px solid var(--wb-bord)}`,
	`.wdd-bandeau a{color:var(--wb-doux);text-decoration:none;font-weight:500;overflow-wrap:normal}`,
	`.wdd-bandeau a:focus-visible{outline:3px solid var(--wb-focus);outline-offset:2px;border-radius:2px}`,
	`.wdd-bandeau .wdd-b-marque{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-right:4px;padding:0 6px 0 0;font:600 15px/1.2 ${POLICE_TITRES};color:var(--wb-texte)}`,
	`.wdd-bandeau .wdd-b-marque:hover .wdd-b-marque-texte{text-decoration:underline;text-underline-offset:3px}`,
	`.wdd-bandeau svg{width:22px;height:22px;flex:none;display:block}`,
	`.wdd-bandeau .wdd-b-m-fond{fill:var(--wb-marque)}`,
	`.wdd-bandeau .wdd-b-m-trait{fill:#ffffff}`,
	`.wdd-bandeau .wdd-b-m-2{fill:#ffd27a}`,
	`.wdd-bandeau .wdd-b-m-3{fill:#8ff0c4}`,
	`.wdd-bandeau ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;min-width:0}`,
	`.wdd-bandeau li{margin:0;padding:0;display:flex}`,
	`.wdd-bandeau p{margin:0}`,
	`.wdd-bandeau .wdd-b-admin a{display:inline-flex;align-items:center;min-height:30px;padding:0 8px;border-radius:6px}`,
	`.wdd-bandeau .wdd-b-admin a:hover{color:var(--wb-texte);background:var(--wb-survol)}`,
	`.wdd-bandeau .wdd-b-qui{flex:1 1 0;min-width:6rem;padding-left:12px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--wb-doux);font-size:.93rem}`,
	`.wdd-bandeau .wdd-b-nom{font-weight:600;color:var(--wb-texte);min-width:0}`,
	`.wdd-bandeau .wdd-b-titre{display:inline-flex;align-items:center;gap:12px;font:600 15px/1.2 ${POLICE_TITRES};color:var(--wb-texte);margin-right:4px;min-height:40px}`,
	`.wdd-bandeau .wdd-b-titre::after{${SEPARATEUR}}`,
	`.wdd-bandeau .wdd-b-onglets a{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 9px}`,
	// Compteur d'un onglet : même pastille pleine que .onglet-compte de la méta-interface (ambre pour les retours à traiter).
	`.wdd-bandeau .wdd-b-compte{display:inline-flex;align-items:center;justify-content:center;min-width:1.35rem;padding:0 .35rem;border-radius:999px;font:700 .8rem/1.35rem ${POLICE_TITRES};background:var(--wb-pastille);color:var(--wb-texte)}`,
	`.wdd-bandeau .wdd-b-compte.nouveaux{background:var(--wb-alerte);color:var(--wb-barre)}`,
	`.wdd-bandeau .wdd-b-onglets a:hover{color:var(--wb-texte);box-shadow:inset 0 -3px 0 var(--wb-bord)}`,
	`.wdd-bandeau .wdd-b-onglets a:focus-visible{outline-offset:-3px}`,
	`.wdd-bandeau a[aria-current="page"]{color:var(--wb-texte);font-weight:600;box-shadow:inset 0 -3px 0 var(--wb-actif)}`,
	`@media (min-width:48rem){.wdd-bandeau{display:flex;flex-wrap:wrap;align-items:center;column-gap:4px;min-height:44px}.wdd-bandeau .wdd-b-ligne{display:contents}.wdd-bandeau .wdd-b-ligne>ul{order:1}.wdd-bandeau .wdd-b-titre{order:2;min-height:44px}.wdd-bandeau .wdd-b-titre::before{${SEPARATEUR}}.wdd-bandeau .wdd-b-projet>ul{order:3;align-self:stretch}.wdd-bandeau .wdd-b-onglets a{min-height:44px}.wdd-bandeau .wdd-b-qui{order:4}}`,
	// Téléphone, comme .nav-projet (ui.css) : projet et onglets sur une même ligne quand le nom tient en entier à côté ;
	// sinon les onglets passent ensemble à la ligne suivante (jamais un onglet seul). Pas de séparateur (il resterait seul).
	`@media (max-width:40rem){.wdd-bandeau .wdd-b-projet{column-gap:8px}.wdd-bandeau .wdd-b-titre{display:block;flex:0 1 auto;min-width:0;line-height:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:0}.wdd-bandeau .wdd-b-titre::after{content:none}.wdd-bandeau .wdd-b-onglets{flex:0 1 auto;flex-wrap:wrap}.wdd-bandeau .wdd-b-onglets a{padding:0 6px;gap:4px}.wdd-bandeau .wdd-b-compte{min-width:1.1rem;padding:0 4px}}`,
	`@media (max-width:23rem){.wdd-bandeau .wdd-b-onglets a{padding:0 5px}}`,
	`.wdd-bandeau .wdd-b-invisible{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`,
	`@media print{.wdd-bandeau{display:none}}`,
].join("\n");

// Phrase de branchement (étape 3.5, § 8.4, D1), mot pour mot celle de serveur/ui/js/branchement.js : posée sur la page
// « Wiki pas encore publié » (http.ts). Texte brut, à échapper par l'appelant.
export const phraseBranchement = (url: string, projet: string) =>
	`Branche ce dépôt sur le serveur de retours ${url} (projet ${projet}) avec la CLI outil : lance outil methode et suis le § 0.`;

// Icône de la marque (le dessin de serveur/ui/icone.svg, sur un carré indigo clair lisible sur l'encre, comme la marque de
// la méta-interface), en ligne : l'hôte des pages ne sert pas /icone.svg.
const ICONE = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect class="wdd-b-m-fond" width="20" height="20" rx="5"/><rect class="wdd-b-m-trait" x="4" y="5" width="3.2" height="10" rx="1"/><rect class="wdd-b-m-trait wdd-b-m-2" x="8.4" y="5" width="3.2" height="7" rx="1"/><rect class="wdd-b-m-trait wdd-b-m-3" x="12.8" y="5" width="3.2" height="4.5" rx="1"/></svg>`;

const estMainteneur = (i: InfoBandeau) => !i.agent && (i.role === "mainteneur" || i.role === "admin");

// Le bandeau (style compris), à poser juste après <body>.
export function bandeau(i: InfoBandeau): string {
	const vers = (route: string) => esc(`${i.base}/#/${route}`);
	const p = encodeURIComponent(i.projet);
	const onglet = (nom: string, href: string, texte: string, actif = false, compte = "") =>
		`<li><a href="${href}" data-onglet="${nom}"${actif ? ` aria-current="page"` : ""}>${texte}${compte}</a></li>`;
	// Pastille : le nombre est visible, le texte complet est pour les lecteurs d'écran (sans le mot « Retours », qui ne
	// nomme que l'onglet).
	const pastille = (n: number | undefined, classe: string, texte: string) => n && Number.isFinite(n) && n > 0
		? `<span class="wdd-b-compte ${classe}"><span aria-hidden="true">${Math.floor(n)}</span><span class="wdd-b-invisible"> (${esc(texte)})</span></span>` : "";
	const nr = i.retours || 0, nq = i.questions || 0, nt = i.aFaire || 0;
	return `<style>\n${STYLE_BANDEAU}\n</style>` +
		`<nav class="wdd-bandeau" id="wdd-bandeau" aria-label="Outil et projet">` +
		`<div class="wdd-b-ligne">` +
		// Marque neutre (étape 3.6, lot B) : icône et « Accueil », qui est aussi le lien vers l'accueil (data-onglet).
		`<a href="${vers("")}" data-onglet="accueil" class="wdd-b-marque">${ICONE}<span class="wdd-b-marque-texte">Accueil</span></a>` +
		(i.role === "admin" && !i.agent ? `<ul class="wdd-b-admin"><li><a href="${vers("admin")}" data-onglet="admin">Administration</a></li></ul>` : "") +
		`<p class="wdd-b-qui" title="${esc(i.nom)}"><span class="wdd-b-invisible">Connecté : </span><span class="wdd-b-nom">${esc(i.nom)}</span></p>` +
		`</div>` +
		`<div class="wdd-b-ligne wdd-b-projet">` +
		`<strong class="wdd-b-titre">${esc(i.titre)}</strong>` +
		`<ul class="wdd-b-onglets">` +
		onglet("wiki", esc(`/p/${p}/`), "Wiki", true) +
		(i.testeur ? "" : onglet("retours", vers(`p/${p}/retours`), "Retours", false, pastille(nr, "nouveaux", `${nr} à traiter${nq ? `, dont ${nq} question${nq > 1 ? "s" : ""}` : ""}`)) +
		onglet("kanban", vers(`p/${p}/kanban`), "Kanban", false, pastille(nt, "a-faire", `${nt} à faire`))) +
		(estMainteneur(i) ? onglet("membres", vers(`p/${p}/membres`), "Membres") : "") +
		`</ul></div></nav>`;
}
