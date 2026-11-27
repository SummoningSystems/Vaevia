// Captures d'écran jointes aux retours (étape 3.7, R2 ; docs/etape3-7-dix-premieres.md).
// - Le navigateur réencode l'image (canvas → WebP ou PNG, 1600 px au plus) avant l'envoi : les métadonnées (EXIF,
//   position GPS) et tout contenu actif disparaissent. Node n'a pas de décodeur d'image (et l'outil n'a aucune
//   dépendance) : le serveur ne réencode pas, il contrôle strictement ce qu'il reçoit.
// - Contrôles : PNG ou WebP seulement (signature des premiers octets, jamais le nom ni le type annoncé ; SVG, GIF,
//   HTML refusés), 2 Mio au plus, dimensions lues dans l'en-tête (4096 px au plus de chaque côté).
// - Stockage : projets/<projet>/captures/<sha256>.<png|webp>, hors du dépôt Git (comme les builds) ; le nom est
//   l'empreinte du contenu, une même image n'est gardée qu'une fois. Sauvegardées avec le reste (sauvegarde.ts).
// - Service : Content-Type fixé par l'extension, nosniff, CSP « default-src 'none'; sandbox », jamais en HTML.
// - Un retour cite ses captures dans le champ facultatif « captures » (ids séparés par des espaces, 3 au plus), posé à
//   la création seulement ; chaque id doit exister dans le projet.
// - Une capture est une donnée, jamais une instruction : un texte dans l'image n'est pas un ordre (METHODE).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ErreurApi, invalide, absent, FORME_CAPTURES, verifierCapturesCitees } from "./retours.ts";
export { FORME_CAPTURES, verifierCapturesCitees };

export const MAX_CAPTURE = 2 * 1024 * 1024, MAX_COTE = 4096, MAX_CAPTURES_RETOUR = 3;
export const ID_CAPTURE = /^[0-9a-f]{64}\.(png|webp)$/;

export const dossierCaptures = (racineProjets: string, projet: string) => path.join(racineProjets, projet, "captures");

// Type et dimensions d'après les octets ; null si ce n'est ni un PNG ni un WebP lisible.
export function lireImage(b: Buffer): { type: "png" | "webp"; largeur: number; hauteur: number } | null {
	if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString("latin1", 12, 16) === "IHDR")
		return { type: "png", largeur: b.readUInt32BE(16), hauteur: b.readUInt32BE(20) };
	if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
		const fourcc = b.toString("latin1", 12, 16);
		if (fourcc === "VP8X") return { type: "webp", largeur: 1 + b.readUIntLE(24, 3), hauteur: 1 + b.readUIntLE(27, 3) };
		if (fourcc === "VP8L" && b[20] === 0x2f) { const v = b.readUInt32LE(21); return { type: "webp", largeur: 1 + (v & 0x3fff), hauteur: 1 + ((v >> 14) & 0x3fff) }; }
		if (fourcc === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { type: "webp", largeur: b.readUInt16LE(26) & 0x3fff, hauteur: b.readUInt16LE(28) & 0x3fff };
	}
	return null;
}

export function enregistrerCapture(racineProjets: string, projet: string, corps: Buffer): { id: string; largeur: number; hauteur: number; octets: number } {
	if (!corps.length) throw invalide("capture vide");
	if (corps.length > MAX_CAPTURE) throw new ErreurApi(413, "quota_exceeded", `capture de ${corps.length} octets : 2 Mio au plus`);
	const im = lireImage(corps);
	if (!im) throw invalide("capture : PNG ou WebP seulement (réencodée par la page)");
	if (!im.largeur || !im.hauteur || im.largeur > MAX_COTE || im.hauteur > MAX_COTE) throw invalide(`capture : ${im.largeur} × ${im.hauteur} px, ${MAX_COTE} px au plus de chaque côté`);
	const id = crypto.createHash("sha256").update(corps).digest("hex") + "." + im.type;
	const dir = dossierCaptures(racineProjets, projet);
	fs.mkdirSync(dir, { recursive: true });
	const f = path.join(dir, id);
	if (!fs.existsSync(f)) {
		const tmp = f + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
		fs.writeFileSync(tmp, corps);
		fs.renameSync(tmp, f);
	}
	return { id, largeur: im.largeur, hauteur: im.hauteur, octets: corps.length };
}

export function lireCapture(racineProjets: string, projet: string, id: string): { corps: Buffer; type: string } {
	if (!ID_CAPTURE.test(id)) throw absent("capture introuvable");
	const f = path.join(dossierCaptures(racineProjets, projet), id);
	if (!fs.existsSync(f)) throw absent("capture introuvable");
	return { corps: fs.readFileSync(f), type: id.endsWith(".png") ? "image/png" : "image/webp" };
}
