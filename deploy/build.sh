#!/usr/bin/env bash
# Regenerate public/ from the repo source. Idempotent: safe to run before every upload.
#
# The only source change applied is the same-origin API override, so the deployed page posts to
# /api/signup (this host's PHP endpoint) instead of https://intake.onenyc.org. Keeping it here
# means public/ is a build artifact and the repo's index.html stays exactly what GitHub Pages serves.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/deploy/public"

mkdir -p "$DEST"
cp "$ROOT/index.html" "$DEST/index.html"
cp "$ROOT/onenyc_logo.png" "$DEST/onenyc_logo.png"
for page in join.html terms.html privacy.html; do
  [ -f "$ROOT/$page" ] && cp "$ROOT/$page" "$DEST/$page"
done

python3 - "$DEST/index.html" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
snippet = ("  <script>window.NAFS_OCR_INTAKE_URL = '/api';</script>")
if snippet in s:
    print("override already present")
else:
    assert "<head>" in s
    s = s.replace("<head>", "<head>\n" + snippet, 1)
    p.write_text(s)
    print("override injected")
PY

echo "→ bundle: $(du -sh "$DEST" | cut -f1) in $DEST"
ls -1 "$DEST"
