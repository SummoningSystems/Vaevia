// Flux SSE par projet : événement « instantane » (même corps que GET /retours) à la connexion puis après chaque
// commit ; commentaire « : ping » toutes les 25 s pour garder la connexion ouverte à travers les proxys.
// Un flux peut rester ouvert des heures : l'accès de son client (session, jeton d'agent) est revérifié à chaque ping
// et avant chaque diffusion, et le flux coupé dès qu'il ne vaut plus (jeton révoqué, session expirée, rôle retiré).
import type { ServerResponse } from "node:http";

// Étape 3 : un flux de l'hôte principal reçoit aussi l'événement « tickets » (liste complète des tickets, à la connexion
// et après chaque commit qui en touche un) ; un flux de l'hôte des pages ne le reçoit jamais (tickets: false).
// filtre (étape 3.9, E2) : corps propre à ce client (un testeur ne reçoit que ses propres retours).
type Client = { res: ServerResponse; projet: string; valide?: () => boolean; tickets: boolean; filtre?: (corps: unknown) => unknown };

export class Flux {
	clients = new Set<Client>();
	// Étape 3.7 (I1) : les notifications observent chaque diffusion (type, projet, corps) ; jamais d'effet sur le flux.
	observateur: ((type: string, projet: string, corps: unknown) => void) | null = null;
	observer(type: string, projet: string, corps: unknown): void { try { this.observateur?.(type, projet, corps); } catch { } }
	minuteur: NodeJS.Timeout;
	constructor(pingMs: number) {
		this.minuteur = setInterval(() => { for (const c of [...this.clients]) if (this.encoreValide(c)) this.ecrire(c, ": ping\n\n"); }, pingMs);
		this.minuteur.unref();
	}

	// Ouvre le flux (en-têtes envoyés tout de suite) et livre le premier instantané si fourni. « valide » dit si le
	// client a toujours accès au projet.
	ouvrir(res: ServerResponse, projet: string, corps?: unknown, valide?: () => boolean, tickets?: unknown, filtre?: (corps: unknown) => unknown): Client {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-store",
			"X-Accel-Buffering": "no",
			"Connection": "keep-alive",
		});
		res.write("retry: 2000\n\n");
		const c: Client = { res, projet, valide, tickets: tickets !== undefined, filtre };
		this.clients.add(c);
		res.on("close", () => this.clients.delete(c));
		if (corps !== undefined) this.envoyer(c, corps);
		if (tickets !== undefined) this.ecrire(c, `event: tickets\ndata: ${JSON.stringify(tickets)}\n\n`);
		return c;
	}

	envoyer(c: Client, corps: unknown): void { this.ecrire(c, `event: instantane\ndata: ${JSON.stringify(c.filtre ? c.filtre(corps) : corps)}\n\n`); }

	diffuser(projet: string, corps: unknown): void {
		this.observer("instantane", projet, corps);
		for (const c of [...this.clients]) if (c.projet === projet && this.encoreValide(c)) this.envoyer(c, corps);
	}

	// Liste complète des tickets, aux seuls flux qui l'écoutent (hôte principal).
	diffuserTickets(projet: string, corps: unknown): void {
		this.observer("tickets", projet, corps);
		const s = `event: tickets\ndata: ${JSON.stringify(corps)}\n\n`;
		for (const c of [...this.clients]) if (c.projet === projet && c.tickets && this.encoreValide(c)) this.ecrire(c, s);
	}

	// Étape 3.5 (§ 5.2) : changement d'état d'une demande de traitement ({ id, etat }), aux seuls flux de l'hôte
	// principal (ceux qui reçoivent « tickets ») ; la page relit alors les demandes. Jamais sur l'hôte des pages.
	diffuserDemandes(projet: string, corps: unknown): void {
		this.observer("demandes", projet, corps);
		const s = `event: demandes\ndata: ${JSON.stringify(corps)}\n\n`;
		for (const c of [...this.clients]) if (c.projet === projet && c.tickets && this.encoreValide(c)) this.ecrire(c, s);
	}

	// Coupe tout de suite les flux dont le client n'a plus accès (après la révocation d'un jeton, par exemple).
	reverifier(): void { for (const c of [...this.clients]) this.encoreValide(c); }

	// Coupe les flux d'un projet (mode « revoked » de l'API de test), ou tous.
	couper(projet?: string): void {
		for (const c of [...this.clients]) if (!projet || c.projet === projet) { this.clients.delete(c); c.res.destroy(); }
	}

	fermer(): void { clearInterval(this.minuteur); this.couper(); }

	// Vrai si le client a toujours accès ; sinon son flux est coupé.
	encoreValide(c: Client): boolean {
		let ok = true;
		try { ok = !c.valide || c.valide(); } catch { ok = false; }
		if (!ok) { this.clients.delete(c); c.res.destroy(); }
		return ok;
	}

	ecrire(c: Client, s: string): void {
		try { c.res.write(s); } catch { this.clients.delete(c); }
	}
}
