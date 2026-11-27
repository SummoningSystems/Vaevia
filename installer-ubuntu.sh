#!/usr/bin/env bash
# Installe le serveur d'équipe Vaevia sur Ubuntu (22.04 ou plus), avec Docker Compose, depuis la racine de ce dépôt.
# Mode d'emploi : docs/acces-distant.md (HTTPS) et serveur/README.md (« Docker Compose »).
#
#   ./installer-ubuntu.sh                          installe ou met en conformité (questions si besoin)
#   ./installer-ubuntu.sh --oui                    sans question : réponses par défaut
#   ./installer-ubuntu.sh --mettre-a-jour          git pull, puis reconstruit et relance
#   ./installer-ubuntu.sh --etat | --arreter | --reconnecter | --aide
#
# Modes (--mode) :
#   http      (défaut) l'équipe ouvre http://<IP de ce serveur>:8080, rien à installer sur les postes. Tout passe en
#             clair sur le réseau, et le Wiki partage l'adresse de l'administration : réseau de confiance seulement.
#   interne   HTTPS avec l'autorité interne de Caddy : deux noms (DNS interne ou fichier hosts), un certificat racine
#             à installer sur chaque poste.
#   internet  HTTPS avec Let's Encrypt : deux vrais noms de domaine, ports 80 et 443 joignables depuis Internet.
# Les développeurs n'installent rien à la main : leur agent prend la CLI sur le serveur (<adresse>/outil).
# Relancé, il ne refait que ce qui manque : les données restent dans les volumes Docker.
# Il faut Internet pendant l'installation (paquets apt, images Docker node et caddy) ; ensuite, plus rien ne sort.
# Réseau sans Internet : docs/hors-ligne.md.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"
PROJET=vaevia

MODE=""; DOMAINE=""; DOMAINE_PAGES=""; PORT=""; OUI=0; ACTION=installer; SANS_PAQUETS=0
aide() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; cat <<'EOF'

Options :
  --mode http|interne|internet     (défaut : http, ou celui de l'installation déjà faite)
  --domaine <nom>                  HTTPS : nom de l'administration (défaut : vaevia.lan)
  --domaine-pages <nom>            HTTPS : nom des Wikis, autre que --domaine (défaut : vaevia-pages.lan)
  --port <n>                       port du serveur (défaut : 8080 ; ouvert au réseau en mode http, local derrière Caddy)
  --oui                            aucune question
  --sans-paquets                   ne pas installer Docker ni Git avec apt (déjà installés autrement)
Codes de sortie : 0 succès, 1 échec, 2 usage.
EOF
}
usage() { echo "installer-ubuntu.sh : $*" >&2; echo "voir : ./installer-ubuntu.sh --aide" >&2; exit 2; }
while [ $# -gt 0 ]; do
	case "$1" in
		--mode) [ $# -ge 2 ] || usage "--mode demande une valeur"; MODE="$2"; shift 2 ;;
		--domaine) [ $# -ge 2 ] || usage "--domaine demande une valeur"; DOMAINE="$2"; shift 2 ;;
		--domaine-pages) [ $# -ge 2 ] || usage "--domaine-pages demande une valeur"; DOMAINE_PAGES="$2"; shift 2 ;;
		--port) [ $# -ge 2 ] || usage "--port demande une valeur"; PORT="$2"; shift 2 ;;
		--oui) OUI=1; shift ;;
		--sans-paquets) SANS_PAQUETS=1; shift ;;
		--mettre-a-jour) ACTION=maj; shift ;;
		--etat) ACTION=etat; shift ;;
		--arreter) ACTION=arreter; shift ;;
		--reconnecter) ACTION=reconnecter; shift ;;
		-h|--aide|--help) aide; exit 0 ;;
		*) usage "option inconnue : $1" ;;
	esac
done
if [ -n "$PORT" ]; then
	[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || usage "--port : un nombre de 1 à 65535"
fi
case "$MODE" in ""|interne|internet|http) ;; *) usage "--mode : interne, internet ou http (reçu « $MODE »)" ;; esac
NOM_OK='^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$'

etape() { printf '\n== %s\n' "$*"; }
info() { printf '   %s\n' "$*"; }
echec() { printf '\nÉCHEC : %s\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# --- .env : lire et poser une clé sans toucher au reste du fichier ---
lire_env() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -1 || true; }
poser_env() {
	local cle="$1" val="$2"
	if grep -q "^$cle=" .env; then
		local tmp; tmp="$(mktemp)"
		awk -v c="$cle" -v v="$val" 'BEGIN { FS = OFS = "=" } $1 == c { print c "=" v; next } { print }' .env > "$tmp"
		cat "$tmp" > .env; rm -f "$tmp"
	else
		printf '%s=%s\n' "$cle" "$val" >> .env
	fi
}

# --- Docker : « docker » si l'utilisateur y a droit, sinon « sudo docker » (groupe docker pas encore actif) ---
DOCKER=(docker)
choisir_docker() {
	if docker info >/dev/null 2>&1; then DOCKER=(docker)
	elif [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then DOCKER=($SUDO docker)
	else echec "Docker ne répond pas (sudo systemctl start docker ; journal : sudo journalctl -u docker)"; fi
}
dc() { "${DOCKER[@]}" compose "$@"; }

paquets() {
	etape "Paquets : Docker, Compose, Git"
	local manque=()
	command -v git >/dev/null 2>&1 || manque+=(git)
	command -v docker >/dev/null 2>&1 || manque+=(docker.io)
	if ! docker compose version >/dev/null 2>&1 && ! $SUDO docker compose version >/dev/null 2>&1; then manque+=(docker-compose-v2); fi
	if [ ${#manque[@]} -eq 0 ]; then info "déjà là : $(docker --version 2>/dev/null || $SUDO docker --version)"; return; fi
	[ "$SANS_PAQUETS" -eq 0 ] || echec "il manque : ${manque[*]} (--sans-paquets : à installer soi-même)"
	command -v apt-get >/dev/null 2>&1 || echec "apt-get introuvable : ce script vise Ubuntu ; ailleurs, installer ${manque[*]} puis relancer avec --sans-paquets"
	info "installation : ${manque[*]}"
	local journal; journal="$(mktemp -t vaevia-apt.XXXXXX)"
	info "(détail dans $journal)"
	{ $SUDO apt-get update && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "${manque[@]}"; } > "$journal" 2>&1 \
		|| echec "apt n'a pas pu installer ${manque[*]} (journal : $journal). Sur une Ubuntu ancienne, suivre https://docs.docker.com/engine/install/ubuntu/ puis relancer"
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		$SUDO systemctl enable --now docker >/dev/null 2>&1 || true   # redémarre avec la machine (et le serveur avec lui)
	fi
	if [ -n "$SUDO" ] && ! id -nG | grep -qw docker; then
		$SUDO usermod -aG docker "$(id -un)" && info "$(id -un) ajouté au groupe docker (actif à la prochaine connexion ; d'ici là, le script passe par sudo)"
	fi
}

demander() {   # demander <question> <défaut> : la réponse, ou le défaut avec --oui ou sans terminal
	local r=""
	if [ "$OUI" -eq 0 ] && [ -t 0 ]; then read -r -p "   $1 [$2] : " r || true; fi
	printf '%s' "${r:-$2}"
}

reglages() {
	etape "Réglages (.env)"
	if [ ! -f .env ]; then cp .env.exemple .env; info ".env créé depuis .env.exemple"; else info ".env existant gardé (seules les clés ci-dessous changent)"; fi
	local ancien_mode; ancien_mode="$(lire_env VAEVIA_MODE)"
	# Port : --port, sinon celui de l'installation déjà faite (WDD_PORT_PUBLIE, « 127.0.0.1:8080 » ou « 8080 »), sinon 8080.
	local ancien_port; ancien_port="$(lire_env WDD_PORT_PUBLIE)"; ancien_port="${ancien_port##*:}"
	[[ "$ancien_port" =~ ^[0-9]+$ ]] || ancien_port=""
	PORT="${PORT:-${ancien_port:-8080}}"
	MODE="${MODE:-${ancien_mode:-http}}"
	case "$MODE" in interne|internet|http) ;; *) usage "--mode : interne, internet ou http (reçu « $MODE »)" ;; esac
	poser_env COMPOSE_PROJECT_NAME "$PROJET"
	poser_env VAEVIA_MODE "$MODE"
	if [ "$MODE" = http ]; then
		local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; ip="${ip:-127.0.0.1}"
		poser_env COMPOSE_FILE docker-compose.yml
		poser_env WDD_PORT_PUBLIE "$PORT"
		# Adresse déjà réglée (à la main, par ex. un nom du DNS interne) et du même port : gardée.
		local url; url="$(lire_env WDD_URL)"
		[[ "$url" =~ ^http://[A-Za-z0-9.-]+:$PORT$ ]] || url="http://$ip:$PORT"
		poser_env WDD_URL "$url"
		poser_env WDD_URL_PAGES ""; poser_env WDD_HTTPS ""; poser_env WDD_DOMAINE ""; poser_env WDD_DOMAINE_PAGES ""
		info "mode http : $url, en clair sur le réseau (liens d'invitation et cookies lisibles)."
		info "Docker ouvre lui-même ce port, avant ufw : le pare-feu d'Ubuntu ne le protège pas."
		return
	fi
	local d dp
	d="${DOMAINE:-$(lire_env WDD_DOMAINE)}"; dp="${DOMAINE_PAGES:-$(lire_env WDD_DOMAINE_PAGES)}"
	[ -n "$d" ] || d="$(demander "Nom de l'administration" vaevia.lan)"
	[ -n "$dp" ] || dp="$(demander "Nom des Wikis (autre que le premier)" vaevia-pages.lan)"
	[[ "$d" =~ $NOM_OK ]] || usage "nom de l'administration invalide : « $d » (par ex. vaevia.lan)"
	[[ "$dp" =~ $NOM_OK ]] || usage "nom des Wikis invalide : « $dp » (par ex. vaevia-pages.lan)"
	[ "${d,,}" != "${dp,,}" ] || usage "les deux noms doivent être différents (isolement des Wikis : docs/acces-distant.md)"
	DOMAINE="$d"; DOMAINE_PAGES="$dp"
	poser_env COMPOSE_FILE "docker-compose.yml:docker-compose.https.yml"
	poser_env WDD_DOMAINE "$d"
	poser_env WDD_DOMAINE_PAGES "$dp"
	poser_env WDD_CADDYFILE "$([ "$MODE" = interne ] && echo Caddyfile.interne || echo Caddyfile)"
	# Le serveur reste derrière Caddy : joignable par Caddy et par cette machine seulement.
	poser_env WDD_PORT_PUBLIE "127.0.0.1:$PORT"
	# Posés par docker-compose.https.yml à partir des deux noms : vides ici.
	poser_env WDD_URL ""; poser_env WDD_URL_PAGES ""; poser_env WDD_HTTPS ""
	info "administration : https://$d   Wikis : https://$dp   ($MODE)"
	case "${dp,,}" in *".${d,,}") info "attention : $dp est un sous-domaine de $d ; un autre domaine vaut mieux (serveur/README.md, « Isolement des pages »)." ;; esac
}

attendre_sante() {
	etape "Démarrage (le premier lancement construit l'image : quelques minutes)"
	dc up -d --build --remove-orphans
	local id etat="" i
	id="$(dc ps -q wdd)"; [ -n "$id" ] || echec "conteneur du serveur absent (journal : docker compose logs wdd)"
	for i in $(seq 1 60); do
		etat="$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || true)"
		[ "$etat" = healthy ] && break
		[ "$etat" = unhealthy ] && break
		sleep 3
	done
	[ "$etat" = healthy ] || echec "serveur pas prêt (état : ${etat:-inconnu}) ; journal : docker compose logs wdd"
	info "serveur prêt (healthy)"
}

racine_caddy() {
	[ "$(lire_env VAEVIA_MODE)" = interne ] || return 0
	local i
	for i in $(seq 1 20); do
		if dc exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > racine-caddy.crt.tmp 2>/dev/null && [ -s racine-caddy.crt.tmp ]; then
			mv racine-caddy.crt.tmp racine-caddy.crt; return 0
		fi
		sleep 2
	done
	rm -f racine-caddy.crt.tmp
	echec "certificat racine de Caddy introuvable (journal : docker compose logs caddy)"
}

lien_admin() {
	local l
	l="$(dc exec -T wdd cat /donnees/lien-admin.txt 2>/dev/null || true)"
	if [ -n "$l" ]; then
		echo; echo "   Lien du compte admin (à ouvrir soi-même, à ne transmettre à personne ; il ne sert qu'une fois) :"
		echo "   $l"
	else
		info "compte admin déjà créé (lien perdu : ./installer-ubuntu.sh --reconnecter)"
	fi
}

resume() {
	local mode d dp ip url
	mode="$(lire_env VAEVIA_MODE)"; d="$(lire_env WDD_DOMAINE)"; dp="$(lire_env WDD_DOMAINE_PAGES)"
	ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; ip="${ip:-<IP de ce serveur>}"
	if [ "$mode" = http ]; then url="$(lire_env WDD_URL)"; else url="https://$d"; fi
	etape "Installé"
	lien_admin
	echo
	echo "   L'équipe ouvre : $url"
	if [ "$mode" = http ]; then
		cat <<EOF
     Rien à installer sur les postes. Toujours cette adresse exacte (ni le nom de la machine, ni une autre IP) : le
     serveur refuse les écritures venues d'une autre origine. Tout passe en clair : réseau de confiance seulement.
     Cette adresse est inscrite dans .env : il faut à ce serveur une IP fixe (ou une réservation DHCP).
EOF
	else
		cat <<EOF
     Sur chaque poste, les deux noms doivent mener à ce serveur ($ip) : DNS interne, ou à défaut une ligne dans le
     fichier hosts (Windows : C:\\Windows\\System32\\drivers\\etc\\hosts, en administrateur ; Linux, macOS : /etc/hosts) :
        $ip  $d $dp
EOF
		if [ "$mode" = interne ]; then
			cat <<EOF
     Et faire confiance à l'autorité interne : copier $RACINE/racine-caddy.crt sur le poste (il n'est pas secret), puis
      - navigateurs (Windows) : certutil -user -addstore Root racine-caddy.crt   (Firefox : ses propres réglages)
      - CLI outil et agents   : setx NODE_EXTRA_CA_CERTS C:\\Outils\\racine-caddy.crt   puis rouvrir le terminal
                                (Linux, macOS : export NODE_EXTRA_CA_CERTS=~/racine-caddy.crt dans le profil du shell)
EOF
		fi
	fi
	cat <<EOF

   Développeurs : créer le projet dans l'interface ; son écran donne la phrase à dire à l'agent, par exemple :
     Branche ce dépôt sur le serveur de retours $url (projet <P>) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : $url/outil).
   L'agent installe la CLI lui-même depuis $url/outil : il faut seulement Node 24 ou plus et Git sur le poste.

   Ensuite : Administration → Sauvegarde, à activer. Docker ouvre lui-même les ports du serveur, avant ufw.
   Commandes : ./installer-ubuntu.sh --etat | --mettre-a-jour | --arreter | --reconnecter
EOF
}

case "$ACTION" in
	installer)
		echo "Vaevia : installation du serveur d'équipe ($RACINE)"
		[ -f docker-compose.yml ] && [ -f .env.exemple ] || echec "à lancer depuis le dépôt Vaevia (docker-compose.yml introuvable)"
		paquets; choisir_docker; reglages; attendre_sante; racine_caddy; resume ;;
	maj)
		choisir_docker
		[ -f .env ] || echec "pas encore installé : ./installer-ubuntu.sh"
		etape "Mise à jour du dépôt"
		git pull --ff-only || echec "git pull a échoué (modifications locales ? git status)"
		attendre_sante; racine_caddy; info "à jour : $(cat VERSION 2>/dev/null || echo '?')" ;;
	etat)
		choisir_docker; dc ps ;;
	arreter)
		choisir_docker; dc stop; info "arrêté (les données restent ; relancer : ./installer-ubuntu.sh)" ;;
	reconnecter)
		choisir_docker
		if l="$(dc exec -T wdd node serveur/src/lien.ts --donnees /donnees reconnexion --admin 2>/dev/null)" && [ -n "$l" ]; then
			echo "Lien de reconnexion de l'admin (7 jours, une fois ; à ne transmettre à personne) :"; echo "$l"
		elif l="$(dc exec -T wdd cat /donnees/lien-admin.txt 2>/dev/null)" && [ -n "$l" ]; then
			# Aucun admin encore : le lien de création du premier démarrage n'a pas servi.
			echo "Compte admin pas encore créé ; lien de création (une fois, à ne transmettre à personne) :"; echo "$l"
		else
			echec "aucun lien (serveur arrêté ? ./installer-ubuntu.sh --etat ; journal : docker compose logs wdd)"
		fi ;;
esac
