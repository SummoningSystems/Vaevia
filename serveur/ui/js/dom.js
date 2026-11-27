// Construction du DOM sans HTML : chaque texte passe par un nœud texte (jamais innerHTML de données).
// h("p", { class: "x", on: { click: f } }, "texte", enfant…)

export function h(balise, attrs, ...enfants) {
	const el = document.createElement(balise);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "on") { for (const [ev, f] of Object.entries(v)) el.addEventListener(ev, f); continue; }
			if (k === "class") { el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v; continue; }
			if (k === "dataset") { for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv); continue; }
			if (k === "value") { el.value = v; continue; }
			if (k === "checked" || k === "selected" || k === "disabled" || k === "hidden" || k === "required" || k === "readOnly" || k === "multiple") { el[k] = !!v; continue; }
			if (k === "style") throw new Error("pas d'attribut style (CSP)");
			if (k === "href" || k === "src") { el.setAttribute(k, String(v)); continue; }
			el.setAttribute(k, v === true ? "" : String(v));
		}
	}
	ajouter(el, enfants);
	return el;
}

export function ajouter(el, enfants) {
	for (const e of enfants.flat(Infinity)) {
		if (e === undefined || e === null || e === false) continue;
		el.append(e instanceof Node ? e : document.createTextNode(String(e)));
	}
	return el;
}

export function vider(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export function remplacer(el, ...enfants) { vider(el); return ajouter(el, enfants); }

// Lien externe vérifié : http(s) seulement, sinon null.
export function urlSure(brut) {
	if (typeof brut !== "string" || !/^https?:\/\//i.test(brut)) return null;
	try {
		const u = new URL(brut);
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
	} catch { return null; }
}

// Champ de formulaire avec son libellé.
let compteur = 0;
export function champ(libelle, controle, aide) {
	const id = controle.id || (controle.id = "c" + (++compteur));
	const enfants = [h("label", { for: id }, libelle), controle];
	if (aide) { const ida = id + "-aide"; controle.setAttribute("aria-describedby", ida); enfants.push(h("p", { class: "aide", id: ida }, aide)); }
	return h("div", { class: "champ" }, enfants);
}

export function options(liste, choisie) {
	return liste.map(([v, l]) => h("option", { value: v, selected: v === choisie }, l));
}

// Date lisible en français.
const FMT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
export function date(iso) {
	if (!iso) return "";
	const t = Date.parse(iso);
	return Number.isNaN(t) ? String(iso) : FMT.format(new Date(t));
}

// Texte sur une ligne, coupé à n caractères (points de code).
export function court(s, n) {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	const c = Array.from(t);
	return c.length > n ? c.slice(0, n - 1).join("") + "…" : t;
}

export async function copier(texte) {
	try { await navigator.clipboard.writeText(texte); return true; } catch { return false; }
}
