#!/usr/bin/env bash
# Upload the OneNYC Partners static bundle to GoDaddy hosting.
#
# Two transports, because GoDaddy plans differ:
#   ssh  — Web Hosting Deluxe/Ultimate or VPS with SSH enabled. Fast, resumable, no size limit.
#   ftp  — any cPanel plan. FTPS, passive, one file at a time.
#
# Credentials come from the environment; nothing is stored in this repo.
#   GODADDY_HOST=join.onenyc.org
#   GODADDY_USER=<cPanel user or SSH user>
#   GODADDY_PASS=<password>            # ftp only
#   GODADDY_PATH=public_html           # document root (cPanel default)
#
# Usage:  ./deploy-godaddy.sh ssh|ftp [--dry-run]
set -euo pipefail

MODE="${1:-}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/public/"
: "${GODADDY_HOST:?set GODADDY_HOST}"
: "${GODADDY_USER:?set GODADDY_USER}"
: "${GODADDY_PATH:=public_html}"

[ -d "$SRC" ] || { echo "missing $SRC"; exit 1; }
echo "→ $MODE  $SRC  →  $GODADDY_USER@$GODADDY_HOST:$GODADDY_PATH"

case "$MODE" in
  ssh)
    RSYNC=(rsync -avz --delete --human-readable
           --exclude '.DS_Store' --exclude '*.bak*'
           --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r)
    [ "$DRY" = "--dry-run" ] && RSYNC+=(--dry-run)
    "${RSYNC[@]}" "$SRC" "$GODADDY_USER@$GODADDY_HOST:$GODADDY_PATH/"
    ;;
  ftp)
    : "${GODADDY_PASS:?set GODADDY_PASS for ftp}"
    find "$SRC" -type f ! -name '.DS_Store' ! -name '*.bak*' -print0 |
    while IFS= read -r -d '' f; do
      rel="${f#$SRC}"
      url="ftp://$GODADDY_HOST/$GODADDY_PATH/$rel"
      if [ "$DRY" = "--dry-run" ]; then
        echo "would upload $rel"
      else
        mkdir -p "$(dirname "$f")"
        curl -sS --ftp-create-dirs --ssl-reqd --user "$GODADDY_USER:$GODADDY_PASS" \
             -T "$f" "$url" || { echo "FAILED: $rel"; exit 1; }
        echo "uploaded $rel"
      fi
    done
    ;;
  *)
    echo "usage: $0 ssh|ftp [--dry-run]"; exit 2;;
esac

echo "✓ done — verify: curl -sS -o /dev/null -w '%{http_code}\\n' https://join.onenyc.org/"
echo "  health:  curl -sS https://join.onenyc.org/api/healthz"
echo "  signup:  curl -sS -X POST https://join.onenyc.org/api/signup -H 'Content-Type: application/json' \\"
echo "             -d '{\"org\":\"TEST verify\",\"signer_name\":\"T\",\"signer_email\":\"t@example.invalid\",\"legal_advisory_ack\":true}'"
