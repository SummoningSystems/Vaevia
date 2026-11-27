// Paquet hors ligne (étape 3.9, A7 ; docs/hors-ligne.md) : tout ce qu'il faut pour installer l'outil sur un poste ou
// un serveur sans Internet, en une archive.
//   node outils/paquet-hors-ligne.mjs --out <dossier> [--sans-node]
// Contenu : les fichiers suivis par Git du dépôt de l'outil (git ls-files), sans les tests, sans heritage/ et sans les
// documents internes (seuls README, docs/hors-ligne.md, docs/acces-distant.md et docs/ci/ restent) ; le Node qui lance ce
// script, en node/ (l'installeur et outil.cmd le prennent avant celui du PATH), sauf --sans-node ; MANIFESTE.txt
// (version, date, empreinte SHA-256 de chaque fichier). Archive : <out>/outil-hors-ligne-<version>.zip (tar du système,
// présent sous Windows 10 et plus, Linux, macOS). Aucun appel réseau.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const RACINE = path.resolve(import.meta.dirname, "..");
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg("--out"), sansNode = process.argv.includes("--sans-node");
if (!out) { console.error("usage : node outils/paquet-hors-ligne.mjs --out <dossier> [--sans-node]"); process.exit(2); }
const sortie = path.resolve(out);
if (sortie === RACINE || sortie.startsWith(RACINE + path.sep)) { console.error("--out : hors du dépôt de l'outil"); process.exit(2); }
const version = fs.readFileSync(path.join(RACINE, "VERSION"), "utf8").trim();

// Ce qui part : les fichiers suivis par Git, moins les tests, la référence et les documents de travail internes.
const EXCLUS = [/^heritage\//, /(^|\/)test\//, /(^|\/)tests\//, /^docs\/(?!hors-ligne\.md$|acces-distant\.md$|ci\/)/, /^\.github\//];
const fichiers = execFileSync("git", ["-C", RACINE, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
	.filter(f => !EXCLUS.some(r => r.test(f)) && fs.existsSync(path.join(RACINE, f)));
const nom = `outil-hors-ligne-${version}`;
fs.mkdirSync(sortie, { recursive: true });
const travail = fs.mkdtempSync(path.join(sortie, ".paquet-"));
const dest = path.join(travail, nom);
for (const f of fichiers) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(path.join(RACINE, f), path.join(dest, f)); }
let node = "";
if (!sansNode) {
	const exe = process.platform === "win32" ? "node.exe" : "node";
	fs.mkdirSync(path.join(dest, "node"), { recursive: true });
	fs.copyFileSync(process.execPath, path.join(dest, "node", exe));
	if (process.platform !== "win32") fs.chmodSync(path.join(dest, "node", exe), 0o755);
	node = `${process.version} (${process.platform}-${process.arch})`;
}
// Manifeste : de quoi vérifier, sur le réseau isolé, que l'archive est complète et intacte.
const tous = [];
const parcourir = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) parcourir(p); else tous.push(p); } };
parcourir(dest);
const lignes = tous.map(p => path.relative(dest, p).replace(/\\/g, "/")).sort().map(r => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dest, r))).digest("hex")}  ${r}`);
fs.writeFileSync(path.join(dest, "MANIFESTE.txt"), [`outil ${version}, paquet hors ligne du ${new Date().toISOString()}`, node ? `Node livré : ${node}` : "Node : non livré (--sans-node) ; Node 24 doit être installé sur le poste", `${lignes.length} fichiers ; vérifier : sha256sum -c (ou Get-FileHash) sur les lignes ci-dessous`, "", ...lignes, ""].join("\n"));
const archive = path.join(sortie, `${nom}.zip`);
fs.rmSync(archive, { force: true });
// Windows : le tar du système (bsdtar, sait faire un .zip), jamais un tar GNU d'un autre outil trouvé avant dans le PATH.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
try { execFileSync(TAR, ["-a", "-c", "-f", archive, "-C", travail, nom], { stdio: "inherit" }); }
finally { fs.rmSync(travail, { recursive: true, force: true }); }
console.log(`paquet OK : ${archive} (${Math.round(fs.statSync(archive).size / 1048576 * 10) / 10} Mio, ${lignes.length} fichiers${node ? ", Node " + node : ", sans Node"})`);
