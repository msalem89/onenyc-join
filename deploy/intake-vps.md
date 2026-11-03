# Running the intake API on a VM (`intake.onenyc.org`)

Only needed if document OCR and PASSPort packet staging must run server-side. The static site does
not depend on it once `/api` (PHP) handles sign-ups.

## Layout

```
/opt/onenyc/intake/          # this repo's tools/ocr + tools/ copied in (or a git clone)
/var/lib/onenyc/state/       # NAFS_ROOT stand-in: partner_signups/, passport_automation/
/etc/onenyc/intake.env       # NAFS_ROOT, NAFS_INTAKE_HOST=127.0.0.1, NAFS_INTAKE_PORT=8891, token
```

`intake_server.py` reads `NAFS_ROOT`, `NAFS_INTAKE_HOST`, `NAFS_INTAKE_PORT`,
`NAFS_INTAKE_MAX_BYTES`, and loads `nafs_ocr` (tesseract) plus `passport_automation` from
`tools/ocr` — keep that directory shape.

## systemd

```ini
# /etc/systemd/system/onenyc-intake.service
[Unit]
Description=OneNYC intake API
After=network-online.target

[Service]
User=onenyc
WorkingDirectory=/opt/onenyc/intake
EnvironmentFile=/etc/onenyc/intake.env
ExecStart=/opt/onenyc/intake/.venv/bin/python tools/ocr/intake_server.py
Restart=always
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/onenyc

[Install]
WantedBy=multi-user.target
```

## nginx + TLS

```nginx
server {
  listen 443 ssl http2;
  server_name intake.onenyc.org;
  client_max_body_size 13m;          # API caps uploads at 12 MB

  location / {
    proxy_pass http://127.0.0.1:8891;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

`certbot --nginx -d intake.onenyc.org`, then add the `intake` A record in GoDaddy DNS.

## Checks

```bash
curl -sS https://intake.onenyc.org/healthz
curl -sS -X POST https://intake.onenyc.org/signup -H 'Content-Type: application/json' \
  -d '{"org":"TEST vps","signer_name":"T","signer_email":"t@example.invalid","legal_advisory_ack":true}'
```

If this VM exists, the page does **not** need the `/api` override — remove it from the deployed
`index.html` so the form talks to `https://intake.onenyc.org` again.
