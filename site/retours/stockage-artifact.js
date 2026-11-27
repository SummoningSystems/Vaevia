// Adaptateur de stockage « artifact » : les retours dans la base d'un Artifact claude.ai (capacités db et user,
// contrat window.claude 0.2.96). C'est le seul fichier du site qui parle à window.claude.
//
// Reproduit le branchement historique du gabarit site-retours, à un écart près, voulu : si db.collection("retours")
// lève, l'ancien gabarit restait sans boutons ni note (sa promesse de démarrage était rejetée) ; ici le rejet de
// connecter() fait passer le module en « nodb » (boutons visibles, note « Retours indisponibles pour ce lecteur »).
// - use("db") est asynchrone et peut renvoyer null (lecteur déconnecté, capacité non accordée) ; sans window.claude,
//   la page est ouverte comme fichier ;
// - use("user") n'est demandé que si la base existe ; id(), isOwner() et can("data.write") sont lus dans cet ordre,
//   et une erreur arrête la lecture en gardant ce qui a déjà été lu ;
// - collection « retours » : add, doc(id).update, doc(id).delete, onSnapshot (metadata.fromCache : copie en cache,
//   puis réponse de la base) ;
// - les erreurs passent telles quelles, avec leur code (invalid_argument, transform_error, quota_exceeded,
//   unavailable, revoked…) : voir CONTRAT.md. Seule exception : permission_denied, not_found et conflict sont réservés
//   aux adaptateurs qui les emploient sans ambiguïté (CONTRAT.md § 6). Si la base claude.ai en émettait un sur une
//   écriture, il est renommé artifact_<code> et retombe, comme dans l'ancien gabarit, sur le message générique.
// La base d'un Artifact n'expose pas de version par document à la page : aucune version n'est fournie, et l'option
// { version } des écritures est ignorée (l'agent, lui, écrit avec if_version par ArtifactData).
"use strict";
window.RetoursStockage = (() => {
	"use strict";
	// Codes que le module lit comme « refus de droits », « retour absent » ou « version périmée » : ils ne doivent pas
	// changer la réaction de la page à une erreur de la base claude.ai (voir l'en-tête).
	const RESERVES = ["permission_denied", "not_found", "conflict"];
	function relancer(e) {
		if (e && RESERVES.includes(e.code)) throw Object.assign(new Error(e.message || e.code), { code: "artifact_" + e.code });
		throw e;
	}
	async function connecter() {
		let db = null, user = null;
		try { db = await window.claude?.use?.("db"); } catch (e) { db = null; }
		if (!db) return { horsLigne: window.claude ? "nodb" : "file" };
		const identite = { id: null, proprietaire: false, ecriture: null };
		try {
			user = await window.claude.use("user");
			if (user) {
				identite.id = (await user.id()) || null;
				identite.proprietaire = user.isOwner ? (await user.isOwner()) === true : false;
				if (user.can) { const c = await user.can("data.write"); identite.ecriture = c === true ? true : c === false ? false : null; }
			}
		} catch (e) { }
		const col = db.collection("retours");
		const retours = Object.freeze({
			async ajouter(donnees) { try { const ref = await col.add(donnees); return { id: ref && ref.id }; } catch (e) { relancer(e); } },
			async modifier(id, champs) { try { await col.doc(id).update(champs); } catch (e) { relancer(e); } },
			async supprimer(id) { try { await col.doc(id).delete(); } catch (e) { relancer(e); } },
			ecouter(suivant, erreur) {
				return col.onSnapshot(snap => suivant({
					// Sans metadata, c'est une réponse de la base (comme avant l'extraction).
					depuisCache: !!(snap.metadata && snap.metadata.fromCache),
					docs: snap.docs.map(d => ({ id: d.id, donnees: d.data() })),
				}), e => erreur(e));
			},
		});
		return { identite, retours };
	}
	return Object.freeze({ nom: "artifact", connecter });
})();
