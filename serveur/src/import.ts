// Import depuis un artefact claude.ai (étape 2, § 2.3) : POST /api/p/<projet>/import { retours: [{ id, donnees }] }
// (mainteneur, admin, jeton mainteneur). 500 retours au plus par appel, un seul commit
// « import depuis claude.ai : n retours » (aucun commit si rien n'est importé).
// - Chaque entrée est validée seule : une entrée refusée (avec sa raison) n'empêche pas les autres.
// - Document : les 15 champs du contrat (CONTRAT.md § 9), « by » facultatif ; gardés tels quels après validation, sauf
//   « by », qui devient « import:<by d'origine> » (aucun compte n'existe pour lui), et la version, qui repart à 1.
// - Id : l'id d'origine s'il est valide ([A-Za-z0-9]{1,40}, hors noms réservés de Windows : CON, aux, nul…) et libre (à la casse près, dans le dépôt et dans l'appel) ;
//   sinon un id DÉRIVÉ de l'id d'origine et de « created » (empreinte, 20 caractères) ; sinon (collision du dérivé,
//   improbable) un id aléatoire. La correspondance est renvoyée.
// - Ré-import sans doublon : si l'id retenu (d'origine, puis dérivé) existe déjà avec le même « created », l'entrée est
//   ignorée (comptée). Comme l'id dérivé ne dépend que de l'entrée, un retour renommé au premier import est reconnu
//   au suivant.
import crypto from "node:crypto";
import type { Depot, Doc, Donnees, Ecriture } from "./depot.ts";
import { ID_RETOUR } from "./depot.ts";
import { idAleatoire } from "./base.ts";
import type { Acteur, Diffuseur } from "./retours.ts";
import { CHAMPS, MAX_COURT, ErreurApi, invalide, refuse, validerChamp, indisponible, auteurDe } from "./retours.ts";

export const MAX_IMPORT = 500;

const estObjet = (v: unknown): v is Donnees => !!v && typeof v === "object" && !Array.isArray(v);

// Document importé : champs connus, tous des textes valides (mêmes règles qu'une écriture), les 15 présents sauf « by ».
// Contrairement à une création, le statut, la réponse et sa date sont gardés.
export function validerImporte(d: unknown): Donnees {
	if (!estObjet(d)) throw invalide("donnees : objet attendu");
	for (const [k, v] of Object.entries(d)) validerChamp(k, v);
	const manquants = CHAMPS.filter(k => k !== "by" && d[k] === undefined);
	if (manquants.length) throw invalide(`champs manquants : ${manquants.join(", ")}`);
	if (!d.kind || !d.ref) throw invalide("kind et ref ne peuvent pas être vides");
	// « import: » + by d'origine : tronqué pour rester dans la limite d'un champ court (sinon document hors contrat).
	return { ...d, by: ("import:" + String(d.by ?? "")).slice(0, MAX_COURT) };
}

// Id d'origine gardable : forme du serveur, et pas un nom de périphérique réservé de Windows (CON, aux, nul, COM1…),
// dont le fichier retours/<id>.json ne peut pas être écrit (Git échoue, tout l'appel tomberait en 503).
const RESERVE_WINDOWS_I = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const idGardable = (id: string): boolean => ID_RETOUR.test(id) && !RESERVE_WINDOWS_I.test(id);

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Id dérivé d'une entrée : stable d'un import à l'autre, [A-Za-z0-9]{20}.
export function idDerive(origine: string, created: string): string {
	const h = crypto.createHash("sha256").update(`import\u0000${origine}\u0000${created}`, "utf8").digest();
	let s = "";
	for (let i = 0; i < 20; i++) s += ALNUM[h[i] % 62];
	return s;
}

export type BilanImport = {
	importes: { origine: string; id: string }[];
	ignores: string[];
	refuses: { index: number; origine: unknown; raison: string }[];
	rev: string;
};

export function importer(depot: Depot, a: Acteur, corps: unknown, diffuser: Diffuseur): Promise<BilanImport> {
	if (a.role !== "mainteneur" && a.role !== "admin") return Promise.reject(refuse("seuls un mainteneur ou un admin importent des retours"));
	if (!estObjet(corps)) return Promise.reject(invalide("objet { retours } attendu"));
	for (const k of Object.keys(corps)) if (k !== "retours") return Promise.reject(invalide(`clé inconnue : ${k}`));
	const liste = corps.retours;
	if (!Array.isArray(liste) || !liste.length) return Promise.reject(invalide("retours : liste non vide attendue"));
	if (liste.length > MAX_IMPORT) return Promise.reject(invalide(`retours : ${MAX_IMPORT} au plus par appel (reçu ${liste.length})`));
	return depot.file.executer(async () => {
		const bilan: BilanImport = { importes: [], ignores: [], refuses: [], rev: depot.rev };
		const lot = new Map<string, Doc>();
		// Document de cet id, dans le dépôt ou déjà retenu dans cet appel ; « homonyme » : même id à la casse près.
		const doc = (id: string) => depot.index.get(id) ?? lot.get(id);
		const homonyme = (id: string) => {
			const bas = id.toLowerCase();
			return !!depot.homonyme(id) || [...lot.keys()].some(k => k !== id && k.toLowerCase() === bas);
		};
		liste.forEach((x: unknown, index: number) => {
			const origine = estObjet(x) ? x.id : undefined;
			try {
				if (!estObjet(x)) throw invalide("entrée : objet { id, donnees } attendu");
				for (const k of Object.keys(x)) if (k !== "id" && k !== "donnees") throw invalide(`entrée : clé inconnue ${k}`);
				if (typeof x.id !== "string" || !x.id || x.id.length > 200) throw invalide("id d'origine : texte de 1 à 200 caractères attendu");
				const donnees = validerImporte(x.donnees);
				const created = String(donnees.created);
				const candidats = idGardable(x.id) ? [x.id, idDerive(x.id, created)] : [idDerive(x.id, created)];
				let id = "";
				for (const c of candidats) {
					const d = doc(c);
					if (d && d.donnees.created === created) { bilan.ignores.push(x.id); return; }
					if (!d && !homonyme(c)) { id = c; break; }
				}
				while (!id) { const c = idAleatoire(20); if (!doc(c) && !homonyme(c)) id = c; }
				lot.set(id, { version: 1, donnees });
				bilan.importes.push({ origine: x.id, id });
			} catch (e) {
				if (!(e instanceof ErreurApi)) throw e;
				bilan.refuses.push({ index, origine, raison: e.message });
			}
		});
		if (!lot.size) return bilan;
		const ecritures: Ecriture[] = [...lot.entries()].map(([id, d]) => ({ id, doc: d }));
		bilan.rev = await depot.appliquer(ecritures, auteurDe(a), `import depuis claude.ai : ${ecritures.length} retours`).catch(indisponible);
		diffuser(depot);
		return bilan;
	});
}
