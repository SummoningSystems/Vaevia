// Rendu Markdown de la méta-interface (serveur/ui/js/markdown.js), hors navigateur, avec un faux document minimal.
// Le faux document compte les nœuds créés et s'arrête au-delà d'une limite : un rendu qui boucle échoue au lieu de
// bloquer le test (défaut trouvé à la relecture : « **gras** » ou « *italique* » figeait l'onglet).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rendreMarkdown } from "../ui/js/markdown.js";

const LIMITE = 5000;
class Noeud {
	localName: string; enfants: Noeud[] = []; attrs: Record<string, string> = {}; texte: string;
	constructor(nom: string, texte = "") { this.localName = nom; this.texte = texte; }
	append(...ns: Noeud[]) { for (const n of ns) { if (this.enfants.length > LIMITE) throw new Error("boucle : plus de " + LIMITE + " enfants"); this.enfants.push(n); } }
	setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
	getAttribute(k: string) { return this.attrs[k] ?? null; }
	get lastChild() { return this.enfants[this.enfants.length - 1] ?? null; }
	set textContent(t: string) { this.enfants = [new Noeud("#text", t)]; }
	get textContent(): string { return this.localName === "#text" ? this.texte : this.enfants.map(e => e.textContent).join(""); }
}
function fauxDocument() {
	let n = 0;
	const compter = () => { if (++n > LIMITE) throw new Error("boucle : plus de " + LIMITE + " nœuds créés"); };
	return {
		createElement: (b: string) => { compter(); return new Noeud(b); },
		createTextNode: (t: string) => { compter(); return new Noeud("#text", String(t)); },
		createDocumentFragment: () => new Noeud("#fragment"),
	};
}
// HTML lisible du rendu (pour comparer) : texte échappé, attributs href seulement.
function html(n: Noeud): string {
	if (n.localName === "#text") return n.texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const dedans = n.enfants.map(html).join("");
	if (n.localName === "#fragment") return dedans;
	const href = n.attrs.href !== undefined ? ` href="${n.attrs.href}"` : "";
	return `<${n.localName}${href}>${dedans}</${n.localName}>`;
}
const rendre = (s: string) => html(rendreMarkdown(fauxDocument(), s) as unknown as Noeud);

describe("Markdown de la méta-interface (rendu sans HTML)", () => {
	test("gras et italique : rendus une seule fois, sans boucle", () => {
		assert.equal(rendre("a **gras** b"), "<p>a <strong>gras</strong> b</p>");
		assert.equal(rendre("un *mot* ici"), "<p>un <em>mot</em> ici</p>");
		assert.equal(rendre("C'est **urgent** et *vite*."), "<p>C'est <strong>urgent</strong> et <em>vite</em>.</p>");
	});
	test("éléments imbriqués : lien dans du gras, gras dans un titre, une liste, une citation", () => {
		assert.equal(rendre("**[lien](https://x.fr/) gras**"), '<p><strong><a href="https://x.fr/">lien</a> gras</strong></p>');
		assert.equal(rendre("# Un **titre**"), "<h3>Un <strong>titre</strong></h3>");
		assert.equal(rendre("- *a*\n- **b** `c`"), "<ul><li><em>a</em></li><li><strong>b</strong> <code>c</code></li></ul>");
		assert.equal(rendre("> cité **fort**"), "<blockquote>cité <strong>fort</strong></blockquote>");
	});
	test("liens : http(s) seulement, adresse nue sans la ponctuation finale", () => {
		assert.equal(rendre("[clic](javascript:alert(1))"), "<p>[clic](javascript:alert(1))</p>");
		assert.equal(rendre("voir https://x.fr/a."), '<p>voir <a href="https://x.fr/a">https://x.fr/a</a>.</p>');
		assert.equal(rendre("[d](data:text/html,x) [v](vbscript:x)"), "<p>[d](data:text/html,x) [v](vbscript:x)</p>");
	});
	test("le HTML reste du texte, y compris dans un bloc de code", () => {
		assert.equal(rendre("a <img src=x onerror=y> b"), "<p>a &lt;img src=x onerror=y&gt; b</p>");
		assert.equal(rendre("```\n<script>x</script>\n```"), "<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>");
	});
	test("description longue avec beaucoup de gras : coût linéaire", () => {
		const ligne = "**a** *b* `c` [d](https://e.fr/) ";
		const r = rendre(Array(200).fill(ligne).join(""));
		assert.equal((r.match(/<strong>/g) || []).length, 200);
		assert.equal((r.match(/<em>/g) || []).length, 200);
	});
});
