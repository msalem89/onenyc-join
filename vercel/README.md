# OneNYC intake API (Vercel serverless)

The public edge of the OneNYC Impact Partners signup pipeline, living inside the
onenyc-org-site repo (previously its own checkout at
~/Workspace/onenyc/code/onenyc-intake-vercel, Vercel project
`onenyc-intake-vercel` → intake.onenyc.org).

## Layout

- `api/ping.js` — health probe (`/healthz`), also answers `/health` and `/api/healthz` via rewrites
- `api/signup.js` — the signup receiver: validates, dedupes, writes `signups/PARTNER-*.json`
  + `_manifest.json` to Vercel Blob; reserves `<company>@onenyc.org` org mailboxes
- `api/status.js` — application status by confirmation code + email (reads Blob + SharePoint)
- `api/upload.js` — compliance document upload to the SharePoint intake library
- `vercel.json` — rewrites (`/signup`, `/healthz`) and global CORS headers
- `package.json` — runtime deps (`@vercel/blob`)

## Deploy

```bash
cd vercel
npx vercel login            # scope: onenyc (team_ZJ0bTWDGlOcgZx0aejsjQx2a)
npx vercel link             # link to existing project onenyc-intake-vercel
npx vercel --prod           # deploy
```

Env vars are managed in the Vercel dashboard (see `.env.example` for the list).
Blob storage is auto-provisioned when the project links a Blob store; the
BLOB_READ_WRITE_TOKEN is injected by Vercel at runtime.

## Consumers

- join.onenyc.org pages POST here (CORS-allowed origins in each handler)
- The Mac-side pull: ~/NAFS ip_pull_vercel.sh (launchd, 300s) mirrors signups
  from Blob into the local pipeline → SharePoint.

## Contract compatibility

The JSON contract matches signup.php and the FastAPI intake_server.py
(keys: status, confirmation_code, partner_id, timestamp, passport_status,
org_email*, message). Keep the three in sync when changing any one of them.
