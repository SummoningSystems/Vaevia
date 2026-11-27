// Markdown d'une description de ticket, rendu SANS HTML : le texte n'est jamais interprété comme du HTML. On construit
// des nœuds DOM (createElement, nœuds texte). Reconnu : titres (#), listes (-, *, +, 1.), blocs de code (```),
// citations (>), code en ligne (`x`), gras (**x**), italique (*x*), liens [texte](url) et adresses nues, en http(s)
// seulement. Tout le reste reste du texte tel quel (un lien javascript: s'affiche comme du texte).
// Le document est passé en paramètre : le module se teste aussi hors navigateur.

const LIEN_SUR = /^https?:\/\//i;
export function urlLien(brut) {
	if (!LIEN_SUR.test(brut)) return null;
	try {
		const u = new URL(brut);
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
	} catch { return null; }
}

// Éléments en ligne d'un texte. matchAll travaille sur une copie de l'expression : l'appel récursif (gras, italique)
// ne touche pas la position de la boucle du dessus (une expression /g partagée bouclait sans fin sur « **x** »).
const EN_LIGNE = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|(https?:\/\/[^\s<>()[\]]+)/g;
export function enLigne(doc, parent, texte) {
	let i = 0;
	for (const m of texte.matchAll(EN_LIGNE)) {
		if (m.index > i) parent.append(doc.createTextNode(texte.slice(i, m.index)));
		i = m.index + m[0].length;
		if (m[1] !== undefined) {
			const c = doc.createElement("code"); c.textContent = m[1]; parent.append(c);
		} else if (m[2] !== undefined) {
			const u = urlLien(m[3]);
			if (u) parent.append(lien(doc, u, m[2]));
			else parent.append(doc.createTextNode(m[0]));
		} else if (m[4] !== undefined) {
			const b = doc.createElement("strong"); enLigne(doc, b, m[4]); parent.append(b);
		} else if (m[5] !== undefined) {
			const e = doc.createElement("em"); enLigne(doc, e, m[5]); parent.append(e);
		} else if (m[6] !== undefined) {
			// Ponctuation finale laissée hors du lien (« voir https://x.fr. »).
			let brut = m[6], reste = "";
			const f = brut.match(/[.,;:!?'"»]+$/);
			if (f) { reste = f[0]; brut = brut.slice(0, -reste.length); }
			const u = urlLien(brut);
			parent.append(u ? lien(doc, u, brut) : doc.createTextNode(brut));
			if (reste) parent.append(doc.createTextNode(reste));
		}
	}
	if (i < texte.length) parent.append(doc.createTextNode(texte.slice(i)));
}

function lien(doc, href, texte) {
	const a = doc.createElement("a");
	a.setAttribute("href", href);
	a.setAttribute("rel", "noopener noreferrer nofollow");
	a.setAttribute("target", "_blank");
	a.textContent = texte;
	return a;
}

// Rend le Markdown dans un fragment. « niveau » : balise du titre « # » (3 = h3), pour garder le plan de la page.
export function rendreMarkdown(doc, source, niveau = 3) {
	const frag = doc.createDocumentFragment();
	const lignes = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
	let para = null, liste = null, citation = null;
	const fermer = () => { para = null; liste = null; citation = null; };
	for (let n = 0; n < lignes.length; n++) {
		const l = lignes[n];
		const fence = l.match(/^\s{0,3}(```|~~~)/);
		if (fence) {
			fermer();
			const code = [];
			for (n++; n < lignes.length && !lignes[n].trimStart().startsWith(fence[1]); n++) code.push(lignes[n]);
			const pre = doc.createElement("pre"), c = doc.createElement("code");
			c.textContent = code.join("\n");
			pre.append(c); frag.append(pre);
			continue;
		}
		if (!l.trim()) { fermer(); continue; }
		const t = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (t) {
			fermer();
			const el = doc.createElement("h" + Math.min(6, niveau + t[1].length - 1));
			enLigne(doc, el, t[2]); frag.append(el);
			continue;
		}
		const ul = l.match(/^\s*[-*+]\s+(.*)$/), ol = l.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
		if (ul || ol) {
			const type = ul ? "ul" : "ol";
			if (!liste || liste.localName !== type) {
				para = null; citation = null;
				liste = doc.createElement(type);
				if (ol && ol[1] !== "1") liste.setAttribute("start", String(Number(ol[1])));
				frag.append(liste);
			}
			const li = doc.createElement("li");
			enLigne(doc, li, ul ? ul[1] : ol[2]);
			liste.append(li);
			continue;
		}
		const q = l.match(/^\s{0,3}>\s?(.*)$/);
		if (q) {
			para = null; liste = null;
			if (!citation) { citation = doc.createElement("blockquote"); frag.append(citation); }
			else citation.append(doc.createElement("br"));
			enLigne(doc, citation, q[1]);
			continue;
		}
		// Suite d'un élément de liste (ligne indentée) : ajoutée à cet élément.
		if (liste && /^\s+\S/.test(l)) { liste.lastChild.append(doc.createTextNode(" ")); enLigne(doc, liste.lastChild, l.trim()); continue; }
		liste = null; citation = null;
		if (!para) { para = doc.createElement("p"); frag.append(para); }
		else para.append(doc.createElement("br"));
		enLigne(doc, para, l);
	}
	return frag;
}
