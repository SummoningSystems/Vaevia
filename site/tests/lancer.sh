#!/bin/sh
# Rejoue les scénarios du système de retours (module site/retours + adaptateur artifact) sur l'exemple, dans Edge
# (ou Chrome) sans fenêtre. La page est construite par site/build.js, le faux window.claude posé par site/banc_essai.js.
#   sh tests/lancer.sh <dossier de sortie hors dépôt> [gabarit.html] [mode ...]
# Git Bash sous Windows, ou un shell macOS / Linux. Affiche PASS / FAIL / INFO par mode ; code 1 si un FAIL.
# Les pages t_*.html simulent la base : ne jamais les publier.
set -e
SITE=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage : sh tests/lancer.sh <dossier de sortie> [gabarit.html] [mode ...]}; shift
TPL=""; case "$1" in *.html) TPL="--template $1"; shift;; esac
MODES=${*:-normal readonly denywrite quota unavailable revoked snapretry silent offline nodb nouser}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
for B in "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
	"$(command -v chromium 2>/dev/null)" "$(command -v google-chrome 2>/dev/null)" "$(command -v microsoft-edge 2>/dev/null)"; do
	[ -n "$B" ] && [ -x "$B" ] && break
done
[ -x "$B" ] || { echo "Edge ou Chrome introuvable"; exit 2; }
node "$SITE/build.js" "$SITE/examples/data.json" "$OUT/site.html" "$SITE/examples/notes_exemple.json" --stockage=artifact $TPL
node "$SITE/banc_essai.js" "$OUT/site.html" "$OUT" --scenarios "$SITE/tests/scenarios.js" >/dev/null
URL="file://$(cd "$OUT" && pwd -W 2>/dev/null || pwd)"; case "$URL" in file://[A-Za-z]:*) URL="file:///${URL#file://}";; esac
fail=0
for m in $MODES; do
	bud=8000; [ "$m" = silent ] && bud=16000
	"$B" --headless=new --disable-gpu --no-first-run --user-data-dir="$OUT/edge_$m" --virtual-time-budget=$bud \
		--window-size=1280,900 --dump-dom "$URL/t_$m.html" > "$OUT/dom_$m.html" 2>/dev/null || true
	node -e "const h=require('fs').readFileSync(process.argv[1],'utf8');const m=h.match(/<pre id=\"__results\">([\s\S]*?)<\/pre>/);const t=m?m[1].replace(/&quot;/g,'\"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'):'FAIL pas de résultats ('+h.length+' octets)';console.log(t);process.exit(/^FAIL/m.test(t)||!/^END/m.test(t)?1:0)" "$OUT/dom_$m.html" || fail=1
done
[ $fail = 0 ] && echo "TOUT PASSE" || { echo "DES ÉCHECS"; exit 1; }
