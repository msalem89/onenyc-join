# Software the OneNYC stack needs

Answers "do we need anything else installed?" per hosting shape. Nothing here is speculative — the
left column is what the code in this repo actually imports or shells out to.

## cPanel hosting (path A — the package in this folder)

| component | status on GoDaddy cPanel | note |
|---|---|---|
| Apache + `mod_rewrite` | included | clean `/api/signup` URLs |
| `mod_headers` | included | security headers |
| PHP 8.1+ | included, selectable in MultiPHP Manager | `signup.php` needs ≥7.4; pick 8.1+ |
| AutoSSL | included, free | Let's Encrypt-class cert, auto-renew |
| MySQL | **not needed** | sign-ups are one JSON file per partner + a JSONL ledger |
| Node / Python / Composer / Docker | **not needed** | the static page is a single HTML file |

Nothing to install. That is the whole point of the PHP twin.

## VPS (path B — only if OCR + PASSPort automation run on GoDaddy)

| component | why | install |
|---|---|---|
| nginx (or Apache) | TLS + static + reverse proxy | `apt install nginx` |
| PHP-FPM 8.1+ | only if you keep `signup.php` here too | `apt install php8.1-fpm` |
| Python 3.12 + venv | `intake_server.py` (FastAPI) | `apt install python3.12 python3.12-venv` |
| fastapi, uvicorn, python-multipart | API + uploads | `pip install -r requirements` |
| tesseract-ocr + `eng.traineddata` | `nafs_ocr.py` shells out to it; a 16 MB build is vendored at `../vendor/tesseract` | `apt install tesseract-ocr` |
| certbot | TLS renewal | `apt install certbot python3-certbot-nginx` |
| ufw | firewall: 22/80/443 only | included |
| systemd unit | keep the API alive | see `intake-vps.md` |

Not needed on either path: Node runtime, Docker, Redis, a database server.

## Local development

| component | why |
|---|---|
| Python 3.12 venv at `~/NAFS/.venv` | run the real API locally (`NAFS_INTAKE_PORT=8897`) |
| Node 24 | used once to syntax-check the PHP with `php-parser`; not a runtime dependency |
| PHP CLI | **absent on this Mac** — `php -l` is the one check that must run on the server (cPanel → Terminal) |

## What was verified here, and what was not

- ✅ PHP parses clean (real PHP grammar, `php-parser`), both `signup.php` and `healthz.php`.
- ✅ The JSON contract matches the live Python API byte for byte (same keys, same codes):
  Python `POST /signup` returned `status/confirmation_code/partner_id/timestamp/passport_status/
  passport_packet_id/passport_job_id/message`, and the PHP writes exactly those keys.
- ✅ Minimal sign-up (no EIN) is accepted and returns `passport_status: data_pending`; a malformed
  EIN still 400s. Verified against the running Python API after the same rule was applied there.
- ❌ Not executed: PHP runtime behaviour (no interpreter on this machine) and anything requiring the
  GoDaddy account (upload, DNS, AutoSSL). Run `php -l signup.php` and the three `curl` checks in
  `README.md` immediately after upload.
