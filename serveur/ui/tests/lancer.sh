#!/bin/sh
# Scénario Edge de la méta-interface (docs/etape3-meta-interface.md § 6, critère 3), puis le Wiki (étape 3.7, wiki.mjs).
#   sh serveur/ui/tests/lancer.sh <dossier de sortie hors dépôt>
# Démarre un serveur de test (WDD_TEST=1, port libre, WDD_URL sur 127.0.0.1 et WDD_URL_PAGES sur localhost, données
# dans <sortie>/donnees), prépare les données par /__test/preparer, pilote Edge (ou Chrome) sans fenêtre par le
# protocole DevTools, affiche PASS / FAIL par vérification et un BILAN. Captures d'écran dans <sortie>.
# Serveurs et navigateur sont arrêtés à la fin. Code 1 si un FAIL. Demande Node 24 et Git.
set -e
TESTS=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage : sh serveur/ui/tests/lancer.sh <dossier de sortie>}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
for B in "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
	"$(command -v chromium 2>/dev/null)" "$(command -v google-chrome 2>/dev/null)" "$(command -v microsoft-edge 2>/dev/null)"; do
	[ -n "$B" ] && [ -x "$B" ] && break
done
[ -x "$B" ] || { echo "Edge ou Chrome introuvable"; exit 2; }
# Méta-interface, puis Wiki de l'étape 3.7 (wiki.mjs) : les deux tournent, le code est 1 si l'un échoue.
code=0
node "$TESTS/scenario.js" "$OUT" "$B" || code=1
node "$TESTS/wiki.mjs" "$OUT" "$B" || code=1
exit $code
