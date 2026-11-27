// Vérification « aucun appel sortant » (étape 3.9, A7 ; docs/hors-ligne.md) : relève, dans le code livré (serveur, page
// du Wiki, méta-interface, CLI), chaque adresse http(s) écrite en dur et chaque endroit qui ouvre une connexion, et
// échoue sur une adresse externe inconnue. Lecture seule, aucun réseau.
//   node outils/verifier-hors-ligne.mjs [--json]
// Les connexions permises, toutes à une adresse donnée par l'humain, jamais par défaut :
//   - la CLI vers le serveur de .outil.json ; l'agent vers son propre fournisseur (hors de l'outil, à choisir avec la
//     sécurité du programme) ;
//   - les notifications par webhook (serveur/src/notifications.ts) : rien ne part tant qu'un mainteneur n'en règle pas,
//     et une adresse interne est refusée sans WDD_NOTIF_LOCALES=1 ;
//   - la santé du serveur sur 127.0.0.1 (verrou.ts), l'installeur vers localhost ;
//   - winget, proposé par l'installeur seulement si Node manque (le paquet hors ligne livre Node).
// La page du Wiki et la méta-interface ont une CSP « default-src 'self' » : aucune ressource externe ne s'y charge, même
// écrite par un exporteur (vérifié par les recettes : « aucune violation de CSP »).
import fs from "node:fs";
import path from "node:path";

// --racine <dossier> : un autre arbre à relire (tests) ; par défaut, le dépôt de l'outil.
const iR = process.argv.indexOf("--racine");
const RACINE = iR > 0 ? path.resolve(process.argv[iR + 1]) : path.resolve(import.meta.dirname, "..");
const DOSSIERS = ["serveur/src", "serveur/ui", "site/gabarit", "site/retours", "site/build.js", "site/changements.js", "site/valider-notes.js", "cli", "outils/installer.ps1", "installer.cmd"];
const EXCLUS = /(^|[\\/])(test|tests)([\\/]|$)/;
// Hôtes qu'un fichier peut citer sans qu'aucun appel n'en parte : bouclage, exemples, espaces de noms XML, documentation
// affichée (liens montrés à l'humain, jamais chargés).
const PERMIS = [/^localhost$/, /^127\.0\.0\.1$/, /^\[::1\]$/, /\.invalid$/, /^(www\.)?exemple\.[a-z]+$/, /\.exemple(\.[a-z]+)?$/, /^example\.(com|org)$/, /^git\.exemple$/, /^www\.w3\.org$/,
	/^(hooks\.slack\.com|discord\.com|discordapp\.com|[a-z0-9-]+\.webhook\.office\.com)$/, /^0\.0\.0\.0$/, /^github\.com$/, /^json-schema\.org$/, /^letsencrypt\.org$/, /^claude\.ai$/,
	// Liens montrés par l'installeur quand Node ou Git manquent (à ouvrir par l'humain), jamais téléchargés par l'outil ;
	// exemple de lien dans un commentaire de markdown.js.
	/^nodejs\.org$/, /^git-scm\.com$/, /^x\.fr$/];
const fichiers = [];
const parcourir = p => {
	const a = path.join(RACINE, p);
	if (!fs.existsSync(a) || EXCLUS.test(p)) return;
	if (fs.statSync(a).isDirectory()) { for (const e of fs.readdirSync(a)) parcourir(path.join(p, e)); return; }
	if (/\.(ts|mjs|js|html|css|ps1|cmd)$/.test(p)) fichiers.push(p.replace(/\\/g, "/"));
};
DOSSIERS.forEach(parcourir);
const inconnus = [], connexions = [];
for (const f of fichiers) {
	const lignes = fs.readFileSync(path.join(RACINE, f), "utf8").split(/\r?\n/);
	lignes.forEach((l, i) => {
		for (const m of l.matchAll(/https?:\/\/([A-Za-z0-9.\-\[\]:]+)/g)) {
			const hote = m[1].replace(/:\d*$/, "").replace(/\.+$/, "").toLowerCase();
			if (!hote || /[{}$]/.test(m[0]) || PERMIS.some(r => r.test(hote))) continue;
			inconnus.push(`${f}:${i + 1} : ${hote}`);
		}
		if (/\bfetch\(|https?\.request\(|new WebSocket\(|new EventSource\(|net\.connect\(/.test(l) && !/^\s*\/\//.test(l)) connexions.push(`${f}:${i + 1}`);
	});
}
const r = { fichiers: fichiers.length, connexions: connexions.length, inconnus };
if (process.argv.includes("--json")) console.log(JSON.stringify({ ...r, lieux: connexions }));
else {
	console.log(`${fichiers.length} fichiers relus ; ${connexions.length} endroits ouvrent une connexion (vers une adresse donnée par l'humain, ou la page vers son propre serveur)`);
	console.log(inconnus.length ? `ÉCHEC : adresse(s) externe(s) écrite(s) en dur :\n  ${inconnus.join("\n  ")}` : "OK : aucune adresse externe écrite en dur dans le code livré");
}
process.exit(inconnus.length ? 1 : 0);
