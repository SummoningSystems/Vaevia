#!/bin/sh
# Rejoue les scénarios du système de retours (site/tests/scenarios.js, inchangé) contre le serveur de l'étape 1, avec
# l'adaptateur http : serveur de test (WDD_TEST=1, port libre, données dans <sortie>/donnees), build de l'exemple
# par l'API (build.js --stockage=http), Edge (ou Chrome) sans fenêtre piloté par le protocole DevTools.
#   sh site/tests/lancer-http.sh <dossier de sortie hors dépôt> [mode ...]
# Modes : normal readonly denywrite quota unavailable revoked snapretry silent offline nodb (tous par défaut) ;
# nouser est sans objet en HTTP (voir README-http.md). Affiche PASS / FAIL / INFO par mode ; code 1 si un FAIL.
# Demande Node 24 et Git. Serveur et navigateur sont arrêtés à la fin.
set -e
TESTS=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage : sh site/tests/lancer-http.sh <dossier de sortie> [mode ...]}; shift
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
for B in "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
	"$(command -v chromium 2>/dev/null)" "$(command -v google-chrome 2>/dev/null)" "$(command -v microsoft-edge 2>/dev/null)"; do
	[ -n "$B" ] && [ -x "$B" ] && break
done
[ -x "$B" ] || { echo "Edge ou Chrome introuvable"; exit 2; }
exec node "$TESTS/lancer-http.js" "$OUT" "$B" "$@"
