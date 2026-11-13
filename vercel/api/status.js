// Per-application document status, so the upload page can move a row from
// "Pending Review" to "Verified ✓" only when the Mac worker has actually read it.
//
// GET /api/status?code=ONENYC-2026-XXXXX
// -> { ok, code, store, documents: { docId: { state, chars, engine, at, error } } }
//
// States: pending_review (uploaded, not read yet) | verified (read, text is real)
//         | needs_attention (uploaded but the reader could not make sense of it)

const ALLOW = ['https://join.onenyc.org', 'https://onenyc.org', 'https://www.onenyc.org'];
const TENANT = process.env.MSGRAPH_ONENYC_TENANT_ID || process.env.MSGRAPH_TENANT_ID_ONENYC;
const CLIENT = process.env.MSGRAPH_ONENYC_CLIENT_ID || process.env.MSGRAPH_CLIENT_ID_ONENYC;
const SECRET = process.env.MSGRAPH_ONENYC_CLIENT_SECRET || process.env.MSGRAPH_ONENYC_SECRET;
const SITE = process.env.SHAREPOINT_SITE || 'netorg19167036.sharepoint.com:/sites/onenycworkinggroup';
const FOLDER = process.env.SHAREPOINT_UPLOAD_FOLDER || 'Intake';
const CODE_RE = /^ONENYC-\d{4}-[A-Z0-9]{4,10}$/;

function cors(origin) {
  const allow = ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

let cache = { token: null, exp: 0 };
async function token() {
  if (cache.token && Date.now() < cache.exp - 60_000) return cache.token;
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  const j = await res.json();
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cache.token;
}

async function graph(tok, path) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (res.status === 404) return { ok: false, status: 404, body: null };
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function readJson(tok, driveId, path) {
  const r = await graph(tok, `/drives/${driveId}/root:/${encodeURI(path)}:/content`);
  return r.ok ? r.body : null;
}

async function findRecord(tok, code) {
  const blob = await import('@vercel/blob');
  const { get } = blob;
  const read = async (p) => {
    try {
      const r = await get(p, { access: 'private' });
      if (!r || r.statusCode !== 200) return null;
      return JSON.parse(await new Response(r.stream).text());
    } catch { return null; }
  };
  const manifest = await read('signups/_manifest.json');
  for (const entry of (manifest?.signups || [])) {
    const rec = await read(`signups/${entry.pid}.json`);
    if (rec && String(rec.confirmation_code || '').toUpperCase() === code) return rec;
  }
  return null;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  for (const [k, v] of Object.entries(cors(origin))) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, detail: 'GET only' });

  const code = String(req.query?.code || '').toUpperCase().trim();
  const emailIn = String(req.query?.email || '').trim().toLowerCase();
  if (!CODE_RE.test(code)) return res.status(422).json({ ok: false, detail: 'a valid application code is required' });

  try {
    const tok = await token();
    const rec = await findRecord(tok, code).catch(() => null);
    const email = String(rec?.signer?.email || '').trim().toLowerCase();
    // Same rule as upload: the code plus the signer's address, or nothing.
    if (!rec || !email || !emailIn || email !== emailIn) {
      return res.status(403).json({ ok: false, detail: 'this application could not be verified' });
    }

    // Uploads land either in the signer's OneDrive or in the site library; look in
    // the same order the upload endpoint used.
    let driveId = null;
    let folder = null;
    let store = null;

    if (email) {
      const flt = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`);
      const found = await graph(tok, `/users?$select=id&$filter=${flt}`);
      if (found.ok && found.body?.value?.length) {
        const dr = await graph(tok, `/users/${found.body.value[0].id}/drive`);
        if (dr.ok) {
          const probe = await graph(tok, `/drives/${dr.body.id}/root:/${encodeURI(`OneNYC Intake/${code}`)}`);
          if (probe.ok) { driveId = dr.body.id; folder = `OneNYC Intake/${code}`; store = 'partner-onedrive'; }
        }
      }
    }
    if (!driveId) {
      const site = await graph(tok, `/sites/${SITE}`);
      const dr = await graph(tok, `/sites/${site.body.id}/drive`);
      const probe = await graph(tok, `/drives/${dr.body.id}/root:/${encodeURI(`${FOLDER}/${code}`)}`);
      if (!probe.ok) {
        return res.status(200).json({ ok: true, code, store: null, documents: {} });
      }
      driveId = dr.body.id; folder = `${FOLDER}/${code}`; store = 'site-library';
    }

    const status = await readJson(tok, driveId, `${folder}/_status.json`);
    const received = await readJson(tok, driveId, `${folder}/_received.json`);

    const documents = {};
    for (const docId of Object.keys(received || {})) {
      const s = status?.[docId];
      const meta = received[docId] || {};
      documents[docId] = s
        ? { state: s.state, chars: s.chars, engine: s.engine, at: s.at, error: s.error,
            name: meta.name || null, size: meta.size || null }
        : { state: 'pending_review', at: meta.at || null, name: meta.name || null, size: meta.size || null };
    }

    return res.status(200).json({ ok: true, code, store, path: folder, documents });
  } catch (err) {
    console.error('status failed', err?.message || err);
    return res.status(502).json({ ok: false, detail: 'status is unavailable' });
  }
}
