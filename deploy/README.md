# Hosting OneNYC Partners on GoDaddy

**Status:** package built and verified locally. Nothing uploaded, no DNS touched — the brief's gate
("no publish/push/deploy, no DNS or mail settings without owner approval") still stands.

## What is live today (checked 2026-11-01)

| host | resolves to | serves |
|---|---|---|
| `join.onenyc.org` | `msalem89.github.io` + 4 GitHub Pages IPs | the site (GitHub Pages, CNAME in repo) |
| `onenyc.org`, `onenyc.com` | `76.76.21.21` (Vercel) | apex, Vercel |
| `www.onenyc.org` | `cname.vercel-dns.com` | Vercel |
| `intake.onenyc.org` | **no record** | nothing — the API the form calls was never deployed |

So "hosting on GoDaddy" today means DNS only. The site itself sits on GitHub Pages, which cannot
serve the `POST /signup` the page already calls.

## Two workable shapes

### A. GoDaddy Web Hosting (cPanel) — recommended, and what this package targets
Static files in `public_html` plus a PHP endpoint. **No Python, no Node, no database needed.**
The page keeps working end to end: `window.NAFS_OCR_INTAKE_URL = '/api'` (injected in the deployed
copy) sends the form to `https://join.onenyc.org/api/signup`.

- Needed software: **PHP 8.1+** (already part of every GoDaddy cPanel plan — select it in
  *MultiPHP Manager*) and free **AutoSSL**. Nothing to install.
- Document upload/OCR (`/api/ocr`) is **not** available here — the page already degrades to its
  manual-entry path when OCR is unreachable. Sign-ups still record correctly.
- Cost: $0 beyond the hosting you already own.

### B. GoDaddy VPS — only if OCR + PASSPort automation must run on GoDaddy
Static site behind nginx + PHP-FPM, plus the Python intake in a venv with tesseract.
That is a real server to administer (see `STACK.md` §VPS and `intake-vps.md`).

**Recommendation:** ship A now, keep `intake.onenyc.org` on a small VM later if OCR is wanted.
The PHP endpoint and the Python endpoint speak the same JSON, so the front end never changes.

## DNS records

### A. Moving `join` to cPanel (cutover from GitHub Pages)
| type | name | value | ttl |
|---|---|---|---|
| A | `join` | the cPanel server's IPv4 (cPanel → *Server Information* → *Shared IP Address*) | 600 |
| CNAME | `www.join` | `join.onenyc.org` | 600 |
| TXT | `_autodiscover` etc. | **leave alone** — mail lives on `onenyc.com`, do not touch MX/SPF/DKIM | — |

Cutover order: lower TTL to 600 → upload files → verify over the temporary hostname or `/etc/hosts`
→ switch the A record → keep the GitHub Pages CNAME in place for 48h as rollback.

### B. Keeping GitHub Pages (no migration, still "hosted via GoDaddy's DNS")
Leave `join` as is. The sign-up endpoint then has to live somewhere: `intake` → A record to the VM
running the Python API, and remove the `/api` override from the deployed page.

### Either way
| type | name | value | why |
|---|---|---|---|
| A | `intake` | VM IPv4 (only if using the Python API) | the page's `/ocr`+`/signup` calls |
| AAAA | `join` | the same server's IPv6 if it has one | avoids an A-only gap |

Never point `onenyc.org`/`onenyc.com` at the cPanel box: they serve Vercel today, and mail is on the
Microsoft tenant.

## cPanel steps (path A)

1. **MultiPHP Manager** → set `join.onenyc.org` to PHP 8.1 or newer.
2. **File Manager** → into `public_html` (or the subdomain's document root) → upload the contents of
   `deploy/public/` (**not** the `public` folder itself). `.htaccess` must land too — enable
   *Show Hidden Files*.
3. Create the private store **outside** the web root:
   `mkdir -p ~/private/onenyc/data && chmod 700 ~/private/onenyc/data`
4. Copy `deploy/private/config.example.php` to `~/private/onenyc/config.php`, set `data_dir` to the
   absolute path from step 3, `chmod 600`.
5. **SSL/TLS Status** → run AutoSSL for `join.onenyc.org` (and `www.join` if you add it).
6. Verify (see below), then point DNS at the server.

## Verify after upload

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://join.onenyc.org/            # 200
curl -sS https://join.onenyc.org/api/healthz                                   # {"status":"ok",...}
curl -sS -X POST https://join.onenyc.org/api/signup \
  -H 'Content-Type: application/json' \
  -d '{"org":"TEST verify","signer_name":"T","signer_email":"t@example.invalid","legal_advisory_ack":true}'
# -> status success, passport_status data_pending, confirmation_code ONENYC-2026-XXXXXX
```

Then confirm the record exists on disk: `~/private/onenyc/data/signups.jsonl` and one
`PARTNER-*.json`. Delete the TEST row afterwards, or keep it archived — do not leave it in the meter.

## Upload

```bash
export GODADDY_HOST=join.onenyc.org GODADDY_USER=<cpanel user> GODADDY_PATH=public_html
./deploy-godaddy.sh ssh --dry-run      # or: ftp   (needs GODADDY_PASS)
```

## Rollback

Re-point the `join` A record at GitHub Pages (`185.199.108.153` … `.111.153`) and restore the CNAME
file — the Pages deployment is untouched by this package.

## What the GoDaddy account actually holds (checked 2026-11-02)

Evidence gathered without touching the account:

| product | evidence | verdict |
|---|---|---|
| Domain registration | WHOIS: `Registrar: GoDaddy.com, LLC`, onenyc.org registered 2015-04-22, expires 2028-04-22 | **owned** |
| DNS | `ns67/ns68.domaincontrol.com` (onenyc.org), `ns35/ns36.domaincontrol.com` (onenyc.com), `_domainconnect.gd.domaincontrol.com` | **owned** |
| Microsoft 365 via GoDaddy | SPF `include:secureserver.net`, `autodiscover → outlook.com` | **owned** |
| Advanced Email Security / Encryption | MX `mx1-3-usg2.ppe-hosted.com` (Proofpoint), digests from `cloud-protect.net` | **owned** |
| Web Hosting (cPanel) | no `cpanel.` / `webmail.` / `ftp.` / `mail.` host records; apex and www point at Vercel, join at GitHub Pages; no GoDaddy hosting IPs anywhere | **not present** |
| Website Builder | no `editmysite`/builder records | **not present** |
| VPS | no host records, no records of one in NAFS | **not present** |

So the site is *not* on GoDaddy hosting today, and there is no plan to deploy onto yet. Two honest
options: buy the cheapest **Web Hosting (cPanel)** plan (this package deploys unchanged, ~$5–8/mo), or
keep Pages/Vercel — which is free and already live — and put the Python intake on a small VM only if
OCR is wanted. Nothing in this package forces the purchase.

## Open items for the owner

- Buy a GoDaddy **Web Hosting (cPanel)** plan, or confirm we stay on Pages + GoDaddy DNS.
- Whether OCR/PASSPort has to run on GoDaddy or may stay on a separate VM.
- Terms of Service + Privacy Notice are still drafts (per the brief) and are **not** in this bundle;
  the sign-up checkbox references them, so they must ship before public launch.

## Files in this package

| path | role |
|---|---|
| `build.sh` | regenerates `public/` from the repo source and injects the same-origin `/api` override |
| `public/` | the upload set (index.html, logo, `.htaccess`, robots, sitemap, 404, `api/`) |
| `public/api/signup.php` | `POST /signup` — same JSON contract as the Python API |
| `public/api/healthz.php` | `GET /healthz` — used by the page's OCR preflight |
| `private/config.example.php` | copy to `~/private/onenyc/config.php`, set `data_dir` |
| `deploy-godaddy.sh` | upload over SSH/rsync or FTPS |
| `STACK.md` | what software is needed on each path (answer: nothing new for cPanel) |
| `intake-vps.md` | systemd + nginx + tesseract recipe, only if OCR runs server-side |

`public/` is a build artifact: run `./build.sh` before every upload so it never drifts from the
repo. The only difference from the repo's `index.html` is the one-line API override.

## Consent (added 2026-11-01)

The sign-up now requires **two** acknowledgements, matching the brief:

1. the legal-advisory acknowledgement (OneNYC drafts and advises; you submit under your own account);
2. `I agree to the Terms of Service and Privacy Notice`, linked to `/terms.html` and `/privacy.html`.

The page sends `tos_accepted`, `terms_version` (`v1-draft-2026-11-01`) and `tos_accepted_at`; both the
PHP and Python endpoints reject a sign-up without consent and store the version + timestamp in
`compliance`. `terms.html` and `privacy.html` ship in this bundle with a visible
**DRAFT — needs owner and legal review** banner; replace the text (and bump `terms_version`) before
public launch so the recorded consent points at the right version.
